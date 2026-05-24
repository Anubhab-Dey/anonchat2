#ifdef _WIN32
#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <bcrypt.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/random.h>
#endif
#include <openssl/evp.h>
#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/obj_mac.h>
#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#endif

#include <libwebsockets.h>
#include <sqlite3.h>

#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef ANONCHAT_WEB_DIR
#define ANONCHAT_WEB_DIR "./web"
#endif

#define DEFAULT_LISTEN_PORT 8080
#define WS_PATH "/ws"

#define MAX_CLIENTS 128
#define USERNAME_MAX 32
#define ROOM_MAX 64
#define DEVICE_LABEL_MAX 64
#define ID_MAX 96
#define TOKEN_MAX 96
#define PASSWORD_FIELD_MAX 512
#define PUBLIC_KEY_MAX 2048
#define MAX_FRAME_BYTES 262144
#define OUTBOX_SIZE 16
#define CALL_SLOTS 128
#define SESSION_NONCE_TTL_SECONDS 300

#define PEER_ID_BYTES 8
#define PEER_ID_TEXT_BYTES ((PEER_ID_BYTES * 2) + 1)

#define PASSWORD_SALT_BYTES 16
#define PASSWORD_HASH_BYTES 32
#define PASSWORD_PBKDF2_ITERATIONS 210000

struct pending_message {
    size_t len;
    char text[MAX_FRAME_BYTES];
};

struct session_state {
    struct lws *wsi;
    int connected;
    int authenticated;
    int hello_seen;
    int closing;
    char peer_id[PEER_ID_TEXT_BYTES];
    char username[USERNAME_MAX + 1];
    char room[ROOM_MAX + 1];
    char public_key[PUBLIC_KEY_MAX + 1];
    char pending_device_public_key[PUBLIC_KEY_MAX + 1];
    char pending_device_label[DEVICE_LABEL_MAX + 1];
    char device_id[ID_MAX + 1];
    char session_id[ID_MAX + 1];
    int64_t session_expires_at;
    size_t out_head;
    size_t out_count;
    struct pending_message outbox[OUTBOX_SIZE];
};

struct call_route {
    int active;
    char call_id[ID_MAX + 1];
    char call_kind[16];
    char caller_username[USERNAME_MAX + 1];
    char target[ROOM_MAX + 1];
};

static volatile sig_atomic_t interrupted = 0;
static struct session_state *clients[MAX_CLIENTS];
static struct call_route calls[CALL_SLOTS];
static sqlite3 *account_db = NULL;

static char *next_field(char **cursor);
static int is_active_session(struct session_state *state);

static size_t bounded_strlen(const char *text, size_t max) {
    size_t len = 0;

    if (text == NULL) {
        return 0;
    }

    while (len < max && text[len] != '\0') {
        ++len;
    }

    return len;
}

static int64_t now_unix(void) {
    return (int64_t)time(NULL);
}

static int parse_i64(const char *text, int64_t *out_value) {
    if (text == NULL || out_value == NULL || text[0] == '\0') {
        return 0;
    }

    char *end = NULL;
    long long value = strtoll(text, &end, 10);

    if (end == text || *end != '\0' || value < 0) {
        return 0;
    }

    *out_value = (int64_t)value;
    return 1;
}

static void handle_signal(int signal_number) {
    (void)signal_number;
    interrupted = 1;
}

static void secure_clear(void *buffer, size_t len) {
    if (buffer == NULL || len == 0) {
        return;
    }

    volatile unsigned char *p = (volatile unsigned char *)buffer;

    while (len > 0) {
        *p++ = 0;
        --len;
    }
}

static const char *database_path_from_env(void) {
    const char *path = getenv("ANONCHAT_DB_PATH");

    if (path != NULL && path[0] != '\0') {
        return path;
    }

    return "anonchat.sqlite3";
}

static int db_exec(const char *sql) {
    char *error = NULL;
    int result = sqlite3_exec(account_db, sql, NULL, NULL, &error);

    if (result != SQLITE_OK) {
        if (error != NULL) {
            sqlite3_free(error);
        }

        return 0;
    }

    return 1;
}

static int db_open(void) {
    const char *path = database_path_from_env();

    int result = sqlite3_open_v2(
        path,
        &account_db,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
        NULL
    );

    if (result != SQLITE_OK) {
        return 0;
    }

    sqlite3_busy_timeout(account_db, 5000);

    if (!db_exec("PRAGMA foreign_keys = ON;") ||
        !db_exec("PRAGMA secure_delete = ON;") ||
        !db_exec("PRAGMA temp_store = MEMORY;") ||
        !db_exec(
            "CREATE TABLE IF NOT EXISTS users ("
            "    username TEXT PRIMARY KEY,"
            "    salt BLOB NOT NULL CHECK (length(salt) = 16),"
            "    verifier BLOB NOT NULL CHECK (length(verifier) = 32),"
            "    created_at INTEGER NOT NULL DEFAULT (unixepoch()),"
            "    CHECK (length(username) BETWEEN 3 AND 32)"
            ");"
        ) ||
        !db_exec(
            "CREATE TABLE IF NOT EXISTS devices ("
            "    device_id TEXT PRIMARY KEY,"
            "    username TEXT NOT NULL,"
            "    device_public_key TEXT NOT NULL,"
            "    device_label TEXT NOT NULL,"
            "    created_at INTEGER NOT NULL,"
            "    last_seen_at INTEGER NOT NULL,"
            "    replaced_at INTEGER NULL,"
            "    revoked_at INTEGER NULL,"
            "    FOREIGN KEY(username) REFERENCES users(username)"
            ");"
        ) ||
        !db_exec(
            "CREATE TABLE IF NOT EXISTS sessions ("
            "    session_id TEXT PRIMARY KEY,"
            "    username TEXT NOT NULL,"
            "    device_id TEXT NOT NULL,"
            "    token_hash BLOB NOT NULL CHECK (length(token_hash) = 32),"
            "    created_at INTEGER NOT NULL,"
            "    expires_at INTEGER NOT NULL,"
            "    refreshed_at INTEGER NULL,"
            "    revoked_at INTEGER NULL,"
            "    replaced_by_device_id TEXT NULL,"
            "    FOREIGN KEY(username) REFERENCES users(username),"
            "    FOREIGN KEY(device_id) REFERENCES devices(device_id)"
            ");"
        ) ||
        !db_exec(
            "CREATE TABLE IF NOT EXISTS encrypted_backups ("
            "    username TEXT PRIMARY KEY,"
            "    backup_version INTEGER NOT NULL,"
            "    backup_ciphertext TEXT NOT NULL,"
            "    backup_updated_at INTEGER NOT NULL,"
            "    backup_client_created_at INTEGER NULL,"
            "    backup_client_device_id TEXT NOT NULL,"
            "    FOREIGN KEY(username) REFERENCES users(username)"
            ");"
        ) ||
        !db_exec(
            "CREATE TABLE IF NOT EXISTS session_events ("
            "    event_id TEXT PRIMARY KEY,"
            "    username TEXT NOT NULL,"
            "    device_id TEXT NULL,"
            "    session_id TEXT NULL,"
            "    event_type TEXT NOT NULL,"
            "    created_at INTEGER NOT NULL,"
            "    detail TEXT NULL"
            ");"
        ) ||
        !db_exec(
            "CREATE TABLE IF NOT EXISTS session_nonces ("
            "    nonce TEXT PRIMARY KEY,"
            "    session_id TEXT NOT NULL,"
            "    device_id TEXT NOT NULL,"
            "    created_at INTEGER NOT NULL,"
            "    expires_at INTEGER NOT NULL,"
            "    used_at INTEGER NULL,"
            "    FOREIGN KEY(session_id) REFERENCES sessions(session_id),"
            "    FOREIGN KEY(device_id) REFERENCES devices(device_id)"
            ");"
        ) ||
        !db_exec(
            "CREATE TABLE IF NOT EXISTS call_events ("
            "    event_id TEXT PRIMARY KEY,"
            "    call_id TEXT NOT NULL,"
            "    username TEXT NOT NULL,"
            "    device_id TEXT NULL,"
            "    event_type TEXT NOT NULL,"
            "    selected_transport TEXT NULL,"
            "    created_at INTEGER NOT NULL,"
            "    detail TEXT NULL"
            ");"
        ) ||
        !db_exec(
            "CREATE TABLE IF NOT EXISTS push_subscriptions ("
            "    subscription_id TEXT PRIMARY KEY,"
            "    username TEXT NOT NULL,"
            "    device_id TEXT NOT NULL,"
            "    endpoint_hash BLOB NOT NULL CHECK (length(endpoint_hash) = 32),"
            "    subscription_ciphertext TEXT NOT NULL,"
            "    created_at INTEGER NOT NULL,"
            "    updated_at INTEGER NOT NULL,"
            "    revoked_at INTEGER NULL,"
            "    FOREIGN KEY(username) REFERENCES users(username),"
            "    FOREIGN KEY(device_id) REFERENCES devices(device_id)"
            ");"
        ) ||
        !db_exec("CREATE INDEX IF NOT EXISTS idx_devices_username ON devices(username);") ||
        !db_exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_username_key ON devices(username, device_public_key);") ||
        !db_exec("CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(username, revoked_at, expires_at);") ||
        !db_exec("CREATE INDEX IF NOT EXISTS idx_session_nonces_session ON session_nonces(session_id, expires_at, used_at);") ||
        !db_exec("CREATE INDEX IF NOT EXISTS idx_push_username_device ON push_subscriptions(username, device_id, revoked_at);")) {
        sqlite3_close(account_db);
        account_db = NULL;
        return 0;
    }

    return 1;
}

static void db_close(void) {
    if (account_db == NULL) {
        return;
    }

    sqlite3_close(account_db);
    account_db = NULL;
}

static int fill_random_bytes(unsigned char *buffer, size_t len) {
    if (buffer == NULL || len == 0) {
        return 0;
    }

#ifdef _WIN32
    NTSTATUS status = BCryptGenRandom(
        NULL,
        buffer,
        (ULONG)len,
        BCRYPT_USE_SYSTEM_PREFERRED_RNG
    );

    return status == 0;
#else
    size_t filled = 0;

    while (filled < len) {
#if defined(__linux__)
        ssize_t got = getrandom(buffer + filled, len - filled, 0);

        if (got < 0 && errno == EINTR) {
            continue;
        }

        if (got > 0) {
            filled += (size_t)got;
            continue;
        }
#endif

        int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);

        if (fd < 0) {
            return 0;
        }

        while (filled < len) {
            ssize_t got = read(fd, buffer + filled, len - filled);

            if (got < 0 && errno == EINTR) {
                continue;
            }

            if (got <= 0) {
                close(fd);
                return 0;
            }

            filled += (size_t)got;
        }

        close(fd);
    }

    return 1;
#endif
}

static void encode_hex(
    const unsigned char *bytes,
    size_t byte_count,
    char *out_text
) {
    static const char alphabet[] = "0123456789abcdef";

    for (size_t i = 0; i < byte_count; ++i) {
        out_text[i * 2] = alphabet[(bytes[i] >> 4) & 0x0f];
        out_text[(i * 2) + 1] = alphabet[bytes[i] & 0x0f];
    }

    out_text[byte_count * 2] = '\0';
}

static int generate_peer_id(char out_peer_id[PEER_ID_TEXT_BYTES]) {
    unsigned char bytes[PEER_ID_BYTES];

    if (!fill_random_bytes(bytes, sizeof(bytes))) {
        return 0;
    }

    encode_hex(bytes, sizeof(bytes), out_peer_id);
    secure_clear(bytes, sizeof(bytes));
    return 1;
}

static int generate_random_id(const char *prefix, char *out_text, size_t out_size) {
    unsigned char bytes[24];
    char encoded[(sizeof(bytes) * 2) + 1];
    size_t prefix_len = bounded_strlen(prefix, 24);

    if (prefix == NULL ||
        out_text == NULL ||
        prefix_len == 0 ||
        prefix_len + (sizeof(bytes) * 2) >= out_size ||
        !fill_random_bytes(bytes, sizeof(bytes))) {
        secure_clear(bytes, sizeof(bytes));
        return 0;
    }

    encode_hex(bytes, sizeof(bytes), encoded);
    int written = snprintf(out_text, out_size, "%s%s", prefix, encoded);
    secure_clear(bytes, sizeof(bytes));
    secure_clear(encoded, sizeof(encoded));
    return written > 0 && (size_t)written < out_size;
}

static int sha256_bytes(
    const unsigned char *input,
    size_t input_len,
    unsigned char out_hash[32]
) {
    if (input == NULL || out_hash == NULL) {
        return 0;
    }

    memset(out_hash, 0, 32);

#ifdef _WIN32
    BCRYPT_ALG_HANDLE algorithm = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    NTSTATUS status = BCryptOpenAlgorithmProvider(
        &algorithm,
        BCRYPT_SHA256_ALGORITHM,
        NULL,
        0
    );

    if (status != 0) {
        return 0;
    }

    status = BCryptCreateHash(algorithm, &hash, NULL, 0, NULL, 0, 0);

    if (status == 0) {
        status = BCryptHashData(hash, (PUCHAR)input, (ULONG)input_len, 0);
    }

    if (status == 0) {
        status = BCryptFinishHash(hash, out_hash, 32, 0);
    }

    if (hash != NULL) {
        BCryptDestroyHash(hash);
    }

    BCryptCloseAlgorithmProvider(algorithm, 0);

    if (status != 0) {
        memset(out_hash, 0, 32);
        return 0;
    }

    return 1;
#else
    unsigned int out_len = 0;

    if (EVP_Digest(input, input_len, out_hash, &out_len, EVP_sha256(), NULL) != 1 ||
        out_len != 32) {
        memset(out_hash, 0, 32);
        return 0;
    }

    return 1;
#endif
}

static int hash_session_token(
    const char *token,
    unsigned char out_hash[32]
) {
    if (token == NULL) {
        return 0;
    }

    return sha256_bytes(
        (const unsigned char *)token,
        bounded_strlen(token, TOKEN_MAX + 1),
        out_hash
    );
}

static int constant_time_equal(
    const unsigned char *a,
    const unsigned char *b,
    size_t len
) {
    unsigned char diff = 0;

    for (size_t i = 0; i < len; ++i) {
        diff |= (unsigned char)(a[i] ^ b[i]);
    }

    return diff == 0;
}

static int base64url_value(unsigned char c) {
    if (c >= 'A' && c <= 'Z') {
        return c - 'A';
    }

    if (c >= 'a' && c <= 'z') {
        return c - 'a' + 26;
    }

    if (c >= '0' && c <= '9') {
        return c - '0' + 52;
    }

    if (c == '-' || c == '+') {
        return 62;
    }

    if (c == '_' || c == '/') {
        return 63;
    }

    return -1;
}

static int base64url_decode(
    const char *text,
    unsigned char *out,
    size_t out_cap,
    size_t *out_len
) {
    if (text == NULL || out == NULL || out_len == NULL) {
        return 0;
    }

    unsigned int accumulator = 0;
    int bits = 0;
    size_t written = 0;

    for (const unsigned char *p = (const unsigned char *)text; *p != '\0'; ++p) {
        if (*p == '=') {
            break;
        }

        int value = base64url_value(*p);

        if (value < 0) {
            return 0;
        }

        accumulator = (accumulator << 6) | (unsigned int)value;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;

            if (written >= out_cap) {
                return 0;
            }

            out[written++] = (unsigned char)((accumulator >> bits) & 0xff);
        }
    }

    *out_len = written;
    return 1;
}

static int json_string_field(
    const char *json,
    const char *field,
    char *out,
    size_t out_size
) {
    if (json == NULL || field == NULL || out == NULL || out_size == 0) {
        return 0;
    }

    char needle[32];
    int needle_len = snprintf(needle, sizeof(needle), "\"%s\"", field);

    if (needle_len <= 0 || (size_t)needle_len >= sizeof(needle)) {
        return 0;
    }

    const char *p = strstr(json, needle);

    if (p == NULL) {
        return 0;
    }

    p += needle_len;

    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        ++p;
    }

    if (*p != ':') {
        return 0;
    }

    ++p;

    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') {
        ++p;
    }

    if (*p != '"') {
        return 0;
    }

    ++p;
    size_t copied = 0;

    while (*p != '\0' && *p != '"') {
        if (*p == '\\' || copied + 1 >= out_size) {
            return 0;
        }

        out[copied++] = *p++;
    }

    if (*p != '"') {
        return 0;
    }

    out[copied] = '\0';
    return copied > 0;
}

static int decode_device_public_key(
    const char *device_public_key,
    unsigned char out_x[32],
    unsigned char out_y[32]
) {
    unsigned char json_bytes[PUBLIC_KEY_MAX + 1];
    size_t json_len = 0;
    char x_text[96];
    char y_text[96];
    size_t x_len = 0;
    size_t y_len = 0;
    int ok = 0;

    memset(json_bytes, 0, sizeof(json_bytes));
    memset(x_text, 0, sizeof(x_text));
    memset(y_text, 0, sizeof(y_text));
    memset(out_x, 0, 32);
    memset(out_y, 0, 32);

    if (!base64url_decode(device_public_key, json_bytes, sizeof(json_bytes) - 1, &json_len)) {
        goto cleanup;
    }

    json_bytes[json_len] = '\0';

    if (!json_string_field((const char *)json_bytes, "x", x_text, sizeof(x_text)) ||
        !json_string_field((const char *)json_bytes, "y", y_text, sizeof(y_text)) ||
        !base64url_decode(x_text, out_x, 32, &x_len) ||
        !base64url_decode(y_text, out_y, 32, &y_len) ||
        x_len != 32 ||
        y_len != 32) {
        goto cleanup;
    }

    ok = 1;

cleanup:
    secure_clear(json_bytes, sizeof(json_bytes));
    secure_clear(x_text, sizeof(x_text));
    secure_clear(y_text, sizeof(y_text));
    return ok;
}

static int der_signature_to_raw(
    const unsigned char *signature,
    size_t signature_len,
    unsigned char out_raw[64]
) {
    if (signature == NULL || out_raw == NULL || signature_len < 8 || signature[0] != 0x30) {
        return 0;
    }

    size_t pos = 2;

    if (signature[1] & 0x80) {
        size_t length_bytes = signature[1] & 0x7f;

        if (length_bytes == 0 || length_bytes > 2 || 2 + length_bytes >= signature_len) {
            return 0;
        }

        pos = 2 + length_bytes;
    }

    if (pos >= signature_len || signature[pos++] != 0x02 || pos >= signature_len) {
        return 0;
    }

    size_t r_len = signature[pos++];

    if (r_len == 0 || pos + r_len >= signature_len) {
        return 0;
    }

    const unsigned char *r = signature + pos;
    pos += r_len;

    if (pos >= signature_len || signature[pos++] != 0x02 || pos >= signature_len) {
        return 0;
    }

    size_t s_len = signature[pos++];

    if (s_len == 0 || pos + s_len > signature_len) {
        return 0;
    }

    const unsigned char *s = signature + pos;

    while (r_len > 32 && *r == 0) {
        ++r;
        --r_len;
    }

    while (s_len > 32 && *s == 0) {
        ++s;
        --s_len;
    }

    if (r_len > 32 || s_len > 32) {
        return 0;
    }

    memset(out_raw, 0, 64);
    memcpy(out_raw + (32 - r_len), r, r_len);
    memcpy(out_raw + 32 + (32 - s_len), s, s_len);
    return 1;
}

static int normalize_ecdsa_signature(
    const char *signature_text,
    unsigned char out_raw[64]
) {
    unsigned char signature[160];
    size_t signature_len = 0;
    int ok = 0;

    memset(signature, 0, sizeof(signature));
    memset(out_raw, 0, 64);

    if (!base64url_decode(signature_text, signature, sizeof(signature), &signature_len)) {
        goto cleanup;
    }

    if (signature_len == 64) {
        memcpy(out_raw, signature, 64);
        ok = 1;
    } else if (der_signature_to_raw(signature, signature_len, out_raw)) {
        ok = 1;
    }

cleanup:
    secure_clear(signature, sizeof(signature));
    return ok;
}

static int verify_ecdsa_p256_signature(
    const unsigned char public_x[32],
    const unsigned char public_y[32],
    const unsigned char digest[32],
    const unsigned char signature_raw[64]
) {
#ifdef _WIN32
    BCRYPT_ALG_HANDLE algorithm = NULL;
    BCRYPT_KEY_HANDLE key = NULL;
    unsigned char blob[sizeof(BCRYPT_ECCKEY_BLOB) + 64];
    BCRYPT_ECCKEY_BLOB *header = (BCRYPT_ECCKEY_BLOB *)blob;
    int ok = 0;

    memset(blob, 0, sizeof(blob));
    header->dwMagic = BCRYPT_ECDSA_PUBLIC_P256_MAGIC;
    header->cbKey = 32;
    memcpy(blob + sizeof(BCRYPT_ECCKEY_BLOB), public_x, 32);
    memcpy(blob + sizeof(BCRYPT_ECCKEY_BLOB) + 32, public_y, 32);

    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_ECDSA_P256_ALGORITHM, NULL, 0) == 0 &&
        BCryptImportKeyPair(
            algorithm,
            NULL,
            BCRYPT_ECCPUBLIC_BLOB,
            &key,
            blob,
            (ULONG)sizeof(blob),
            0
        ) == 0 &&
        BCryptVerifySignature(
            key,
            NULL,
            (PUCHAR)digest,
            32,
            (PUCHAR)signature_raw,
            64,
            0
        ) == 0) {
        ok = 1;
    }

    if (key != NULL) {
        BCryptDestroyKey(key);
    }

    if (algorithm != NULL) {
        BCryptCloseAlgorithmProvider(algorithm, 0);
    }

    secure_clear(blob, sizeof(blob));
    return ok;
#else
    EC_KEY *key = EC_KEY_new_by_curve_name(NID_X9_62_prime256v1);
    BIGNUM *x = NULL;
    BIGNUM *y = NULL;
    ECDSA_SIG *signature = NULL;
    BIGNUM *r = NULL;
    BIGNUM *s = NULL;
    int ok = 0;

    if (key == NULL) {
        goto cleanup;
    }

    x = BN_bin2bn(public_x, 32, NULL);
    y = BN_bin2bn(public_y, 32, NULL);
    r = BN_bin2bn(signature_raw, 32, NULL);
    s = BN_bin2bn(signature_raw + 32, 32, NULL);
    signature = ECDSA_SIG_new();

    if (x == NULL ||
        y == NULL ||
        r == NULL ||
        s == NULL ||
        signature == NULL ||
        EC_KEY_set_public_key_affine_coordinates(key, x, y) != 1 ||
        ECDSA_SIG_set0(signature, r, s) != 1) {
        goto cleanup;
    }

    r = NULL;
    s = NULL;
    ok = ECDSA_do_verify(digest, 32, signature, key) == 1;

cleanup:
    if (signature != NULL) {
        ECDSA_SIG_free(signature);
    }

    if (r != NULL) {
        BN_clear_free(r);
    }

    if (s != NULL) {
        BN_clear_free(s);
    }

    if (x != NULL) {
        BN_clear_free(x);
    }

    if (y != NULL) {
        BN_clear_free(y);
    }

    if (key != NULL) {
        EC_KEY_free(key);
    }

    return ok;
#endif
}

static int hash_password_field(
    const char *password_field,
    const unsigned char salt[PASSWORD_SALT_BYTES],
    unsigned char out_hash[PASSWORD_HASH_BYTES]
) {
    if (password_field == NULL || salt == NULL || out_hash == NULL) {
        return 0;
    }

    memset(out_hash, 0, PASSWORD_HASH_BYTES);

#ifdef _WIN32
    BCRYPT_ALG_HANDLE algorithm = NULL;
    NTSTATUS status = BCryptOpenAlgorithmProvider(
        &algorithm,
        BCRYPT_SHA256_ALGORITHM,
        NULL,
        BCRYPT_ALG_HANDLE_HMAC_FLAG
    );

    if (status != 0) {
        return 0;
    }

    size_t password_len = bounded_strlen(password_field, PASSWORD_FIELD_MAX + 1);

    status = BCryptDeriveKeyPBKDF2(
        algorithm,
        (PUCHAR)(const unsigned char *)password_field,
        (ULONG)password_len,
        (PUCHAR)salt,
        PASSWORD_SALT_BYTES,
        PASSWORD_PBKDF2_ITERATIONS,
        out_hash,
        PASSWORD_HASH_BYTES,
        0
    );

    BCryptCloseAlgorithmProvider(algorithm, 0);

    if (status != 0) {
        memset(out_hash, 0, PASSWORD_HASH_BYTES);
        return 0;
    }

    return 1;
#else
    size_t password_len = bounded_strlen(password_field, PASSWORD_FIELD_MAX + 1);

    if (password_len > PASSWORD_FIELD_MAX) {
        return 0;
    }

    int ok = PKCS5_PBKDF2_HMAC(
        password_field,
        (int)password_len,
        salt,
        PASSWORD_SALT_BYTES,
        PASSWORD_PBKDF2_ITERATIONS,
        EVP_sha256(),
        PASSWORD_HASH_BYTES,
        out_hash
    );

    if (ok != 1) {
        memset(out_hash, 0, PASSWORD_HASH_BYTES);
        return 0;
    }

    return 1;
#endif
}

static int text_has_len_between(const char *text, size_t min, size_t max) {
    if (text == NULL) {
        return 0;
    }

    size_t len = bounded_strlen(text, max + 1);
    return len >= min && len <= max;
}

static int valid_username(const char *username) {
    if (!text_has_len_between(username, 3, USERNAME_MAX)) {
        return 0;
    }

    for (const char *p = username; *p != '\0'; ++p) {
        char c = *p;
        int ok =
            (c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c == '_' ||
            c == '-' ||
            c == '.';

        if (!ok) {
            return 0;
        }
    }

    return 1;
}

static int valid_room_name(const char *room) {
    if (!text_has_len_between(room, 3, ROOM_MAX)) {
        return 0;
    }

    for (const char *p = room; *p != '\0'; ++p) {
        char c = *p;
        int ok =
            (c >= 'a' && c <= 'z') ||
            (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') ||
            c == '_' ||
            c == '-' ||
            c == '.';

        if (!ok) {
            return 0;
        }
    }

    return 1;
}

static int valid_password_field(const char *password_field) {
    if (!text_has_len_between(password_field, 12, PASSWORD_FIELD_MAX)) {
        return 0;
    }

    for (const unsigned char *p = (const unsigned char *)password_field; *p != '\0'; ++p) {
        if (*p < 33 || *p > 126 || *p == '|') {
            return 0;
        }
    }

    return 1;
}

static int valid_payload_field(const char *payload) {
    if (!text_has_len_between(payload, 1, MAX_FRAME_BYTES - 128)) {
        return 0;
    }

    for (const unsigned char *p = (const unsigned char *)payload; *p != '\0'; ++p) {
        int ok =
            (*p >= 'a' && *p <= 'z') ||
            (*p >= 'A' && *p <= 'Z') ||
            (*p >= '0' && *p <= '9') ||
            *p == '+' ||
            *p == '/' ||
            *p == '=' ||
            *p == '-' ||
            *p == '_';

        if (!ok) {
            return 0;
        }
    }

    return 1;
}

static int valid_public_key_field(const char *public_key) {
    if (!text_has_len_between(public_key, 40, PUBLIC_KEY_MAX)) {
        return 0;
    }

    return valid_payload_field(public_key);
}

static int valid_id_field(const char *id) {
    if (!text_has_len_between(id, 8, ID_MAX)) {
        return 0;
    }

    for (const unsigned char *p = (const unsigned char *)id; *p != '\0'; ++p) {
        int ok =
            (*p >= 'a' && *p <= 'z') ||
            (*p >= 'A' && *p <= 'Z') ||
            (*p >= '0' && *p <= '9') ||
            *p == '_' ||
            *p == '-';

        if (!ok) {
            return 0;
        }
    }

    return 1;
}

static int valid_token_field(const char *token) {
    return text_has_len_between(token, 16, TOKEN_MAX) && valid_id_field(token);
}

static int valid_device_label(const char *label) {
    if (!text_has_len_between(label, 1, DEVICE_LABEL_MAX)) {
        return 0;
    }

    for (const unsigned char *p = (const unsigned char *)label; *p != '\0'; ++p) {
        if (*p < 32 || *p > 126 || *p == '|') {
            return 0;
        }
    }

    return 1;
}

static int add_client(struct session_state *state) {
    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        if (clients[i] == NULL) {
            clients[i] = state;
            return 1;
        }
    }

    return 0;
}

static void remove_client(struct session_state *state) {
    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        if (clients[i] == state) {
            clients[i] = NULL;
            return;
        }
    }
}

static struct session_state *find_client_by_peer_id(const char *peer_id) {
    if (peer_id == NULL) {
        return NULL;
    }

    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        struct session_state *client = clients[i];

        if (client != NULL &&
            client->connected &&
            client->authenticated &&
            is_active_session(client) &&
            strcmp(client->peer_id, peer_id) == 0) {
            return client;
        }
    }

    return NULL;
}

static struct session_state *find_client_by_username(const char *username) {
    if (username == NULL) {
        return NULL;
    }

    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        struct session_state *client = clients[i];

        if (client != NULL &&
            client->connected &&
            client->authenticated &&
            is_active_session(client) &&
            strcmp(client->username, username) == 0) {
            return client;
        }
    }

    return NULL;
}

static int create_user(const char *username, const char *password_field) {
    if (account_db == NULL ||
        !valid_username(username) ||
        !valid_password_field(password_field)) {
        return 0;
    }

    unsigned char salt[PASSWORD_SALT_BYTES];
    unsigned char verifier[PASSWORD_HASH_BYTES];

    if (!fill_random_bytes(salt, sizeof(salt))) {
        secure_clear(salt, sizeof(salt));
        secure_clear(verifier, sizeof(verifier));
        return 0;
    }

    if (!hash_password_field(password_field, salt, verifier)) {
        secure_clear(salt, sizeof(salt));
        secure_clear(verifier, sizeof(verifier));
        return 0;
    }

    sqlite3_stmt *statement = NULL;
    int ok = 0;

    if (sqlite3_prepare_v2(
            account_db,
            "INSERT INTO users (username, salt, verifier) VALUES (?1, ?2, ?3);",
            -1,
            &statement,
            NULL
        ) == SQLITE_OK &&
        sqlite3_bind_text(statement, 1, username, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_bind_blob(statement, 2, salt, PASSWORD_SALT_BYTES, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_bind_blob(statement, 3, verifier, PASSWORD_HASH_BYTES, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_step(statement) == SQLITE_DONE) {
        ok = 1;
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    secure_clear(salt, sizeof(salt));
    secure_clear(verifier, sizeof(verifier));
    return ok;
}

static int verify_user(const char *username, const char *password_field) {
    if (account_db == NULL ||
        !valid_username(username) ||
        !valid_password_field(password_field)) {
        return 0;
    }

    sqlite3_stmt *statement = NULL;
    unsigned char salt[PASSWORD_SALT_BYTES];
    unsigned char verifier[PASSWORD_HASH_BYTES];
    int ok = 0;

    memset(salt, 0, sizeof(salt));
    memset(verifier, 0, sizeof(verifier));

    if (sqlite3_prepare_v2(
            account_db,
            "SELECT salt, verifier FROM users WHERE username = ?1;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_text(statement, 1, username, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_ROW) {
        goto cleanup;
    }

    const void *stored_salt = sqlite3_column_blob(statement, 0);
    const void *stored_verifier = sqlite3_column_blob(statement, 1);
    int salt_len = sqlite3_column_bytes(statement, 0);
    int verifier_len = sqlite3_column_bytes(statement, 1);

    if (stored_salt == NULL ||
        stored_verifier == NULL ||
        salt_len != PASSWORD_SALT_BYTES ||
        verifier_len != PASSWORD_HASH_BYTES) {
        goto cleanup;
    }

    memcpy(salt, stored_salt, sizeof(salt));
    memcpy(verifier, stored_verifier, sizeof(verifier));

    unsigned char candidate[PASSWORD_HASH_BYTES];
    ok = hash_password_field(password_field, salt, candidate) &&
         constant_time_equal(candidate, verifier, PASSWORD_HASH_BYTES);

    secure_clear(candidate, sizeof(candidate));

cleanup:
    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    secure_clear(salt, sizeof(salt));
    secure_clear(verifier, sizeof(verifier));
    return ok;
}

static int enqueue_text(struct session_state *state, const char *text) {
    if (state == NULL || text == NULL || state->closing) {
        return 0;
    }

    size_t len = bounded_strlen(text, MAX_FRAME_BYTES);

    if (len == 0 || len >= MAX_FRAME_BYTES) {
        state->closing = 1;
        lws_callback_on_writable(state->wsi);
        return 0;
    }

    if (state->out_count >= OUTBOX_SIZE) {
        state->closing = 1;
        lws_callback_on_writable(state->wsi);
        return 0;
    }

    size_t slot = (state->out_head + state->out_count) % OUTBOX_SIZE;
    memcpy(state->outbox[slot].text, text, len + 1);
    state->outbox[slot].len = len;
    state->out_count++;

    lws_callback_on_writable(state->wsi);
    return 1;
}

static int send_textf(struct session_state *state, const char *format, ...) {
    char buffer[MAX_FRAME_BYTES];

    va_list args;
    va_start(args, format);
    int written = vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);

    if (written <= 0 || written >= (int)sizeof(buffer)) {
        if (state != NULL) {
            state->closing = 1;
            lws_callback_on_writable(state->wsi);
        }

        secure_clear(buffer, sizeof(buffer));
        return 0;
    }

    int ok = enqueue_text(state, buffer);
    secure_clear(buffer, sizeof(buffer));
    return ok;
}

static int insert_session_event(
    const char *username,
    const char *device_id,
    const char *session_id,
    const char *event_type,
    const char *detail
) {
    char event_id[ID_MAX + 1];

    if (!generate_random_id("evt_", event_id, sizeof(event_id))) {
        return 0;
    }

    sqlite3_stmt *statement = NULL;
    int ok = sqlite3_prepare_v2(
        account_db,
        "INSERT INTO session_events "
        "(event_id, username, device_id, session_id, event_type, created_at, detail) "
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7);",
        -1,
        &statement,
        NULL
    ) == SQLITE_OK;

    if (ok) {
        ok =
            sqlite3_bind_text(statement, 1, event_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 2, username, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 3, device_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 4, session_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 5, event_type, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_int64(statement, 6, now_unix()) == SQLITE_OK;

        if (ok && detail != NULL) {
            ok = sqlite3_bind_text(statement, 7, detail, -1, SQLITE_TRANSIENT) == SQLITE_OK;
        } else if (ok) {
            ok = sqlite3_bind_null(statement, 7) == SQLITE_OK;
        }
    }

    if (ok) {
        ok = sqlite3_step(statement) == SQLITE_DONE;
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    secure_clear(event_id, sizeof(event_id));
    return ok;
}

static int insert_call_event(
    const char *call_id,
    const char *username,
    const char *device_id,
    const char *event_type,
    const char *selected_transport,
    const char *detail
) {
    char event_id[ID_MAX + 1];

    if (!generate_random_id("evt_", event_id, sizeof(event_id))) {
        return 0;
    }

    sqlite3_stmt *statement = NULL;
    int ok = sqlite3_prepare_v2(
        account_db,
        "INSERT INTO call_events "
        "(event_id, call_id, username, device_id, event_type, selected_transport, created_at, detail) "
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);",
        -1,
        &statement,
        NULL
    ) == SQLITE_OK;

    if (ok) {
        ok =
            sqlite3_bind_text(statement, 1, event_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 2, call_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 3, username, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 4, device_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 5, event_type, -1, SQLITE_TRANSIENT) == SQLITE_OK;

        if (ok && selected_transport != NULL) {
            ok = sqlite3_bind_text(statement, 6, selected_transport, -1, SQLITE_TRANSIENT) == SQLITE_OK;
        } else if (ok) {
            ok = sqlite3_bind_null(statement, 6) == SQLITE_OK;
        }

        if (ok) {
            ok = sqlite3_bind_int64(statement, 7, now_unix()) == SQLITE_OK;
        }

        if (ok && detail != NULL) {
            ok = sqlite3_bind_text(statement, 8, detail, -1, SQLITE_TRANSIENT) == SQLITE_OK;
        } else if (ok) {
            ok = sqlite3_bind_null(statement, 8) == SQLITE_OK;
        }
    }

    if (ok) {
        ok = sqlite3_step(statement) == SQLITE_DONE;
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    secure_clear(event_id, sizeof(event_id));
    return ok;
}

static int get_backup_version(const char *username) {
    sqlite3_stmt *statement = NULL;
    int version = 0;

    if (sqlite3_prepare_v2(
            account_db,
            "SELECT backup_version FROM encrypted_backups WHERE username = ?1;",
            -1,
            &statement,
            NULL
        ) == SQLITE_OK &&
        sqlite3_bind_text(statement, 1, username, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_step(statement) == SQLITE_ROW) {
        version = sqlite3_column_int(statement, 0);
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    return version;
}

static int load_existing_device_id(
    const char *username,
    const char *device_public_key,
    char out_device_id[ID_MAX + 1]
) {
    sqlite3_stmt *statement = NULL;
    int ok = 0;

    if (sqlite3_prepare_v2(
            account_db,
            "SELECT device_id FROM devices WHERE username = ?1 AND device_public_key = ?2 LIMIT 1;",
            -1,
            &statement,
            NULL
        ) == SQLITE_OK &&
        sqlite3_bind_text(statement, 1, username, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_bind_text(statement, 2, device_public_key, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_step(statement) == SQLITE_ROW) {
        const unsigned char *value = sqlite3_column_text(statement, 0);

        if (value != NULL && valid_id_field((const char *)value)) {
            memcpy(out_device_id, value, bounded_strlen((const char *)value, ID_MAX) + 1);
            ok = 1;
        }
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    return ok;
}

static int create_or_update_device(
    const char *username,
    const char *device_public_key,
    const char *device_label,
    int64_t now,
    char out_device_id[ID_MAX + 1]
) {
    if (!load_existing_device_id(username, device_public_key, out_device_id) &&
        !generate_random_id("dev_", out_device_id, ID_MAX + 1)) {
        return 0;
    }

    sqlite3_stmt *statement = NULL;
    int ok = sqlite3_prepare_v2(
        account_db,
        "INSERT INTO devices "
        "(device_id, username, device_public_key, device_label, created_at, last_seen_at, replaced_at, revoked_at) "
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL) "
        "ON CONFLICT(device_id) DO UPDATE SET "
        "device_label = excluded.device_label, "
        "last_seen_at = excluded.last_seen_at, "
        "replaced_at = NULL, "
        "revoked_at = NULL;",
        -1,
        &statement,
        NULL
    ) == SQLITE_OK;

    if (ok) {
        ok =
            sqlite3_bind_text(statement, 1, out_device_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 2, username, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 3, device_public_key, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_text(statement, 4, device_label, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_int64(statement, 5, now) == SQLITE_OK &&
            sqlite3_bind_int64(statement, 6, now) == SQLITE_OK &&
            sqlite3_step(statement) == SQLITE_DONE;
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    return ok;
}

static void notify_replaced_sessions(
    struct session_state *current,
    const char *username,
    const char *new_device_id
) {
    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        struct session_state *client = clients[i];

        if (client == NULL ||
            client == current ||
            !client->connected ||
            !client->authenticated ||
            strcmp(client->username, username) != 0) {
            continue;
        }

        (void)send_textf(client, "SESSION_REPLACED|%s", new_device_id);
        client->closing = 1;
        lws_callback_on_writable(client->wsi);
    }
}

static int issue_account_session(
    struct session_state *state,
    const char *username
) {
    if (state == NULL ||
        !state->hello_seen ||
        !valid_public_key_field(state->pending_device_public_key) ||
        !valid_device_label(state->pending_device_label)) {
        return 0;
    }

    char device_id[ID_MAX + 1];
    char session_id[ID_MAX + 1];
    char session_token[TOKEN_MAX + 1];
    unsigned char token_hash[32];
    int64_t now = now_unix();
    int64_t expires_at = now + 86400;
    int ok = 0;

    memset(device_id, 0, sizeof(device_id));
    memset(session_id, 0, sizeof(session_id));
    memset(session_token, 0, sizeof(session_token));
    memset(token_hash, 0, sizeof(token_hash));

    if (!generate_random_id("sess_", session_id, sizeof(session_id)) ||
        !generate_random_id("tok_", session_token, sizeof(session_token)) ||
        !hash_session_token(session_token, token_hash) ||
        !db_exec("BEGIN IMMEDIATE TRANSACTION;")) {
        goto cleanup;
    }

    if (!create_or_update_device(
            username,
            state->pending_device_public_key,
            state->pending_device_label,
            now,
            device_id
        )) {
        goto rollback;
    }

    sqlite3_stmt *statement = NULL;

    if (sqlite3_prepare_v2(
            account_db,
            "UPDATE sessions SET revoked_at = ?1, replaced_by_device_id = ?2 "
            "WHERE username = ?3 AND revoked_at IS NULL;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 1, now) != SQLITE_OK ||
        sqlite3_bind_text(statement, 2, device_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 3, username, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_DONE) {
        if (statement != NULL) {
            sqlite3_finalize(statement);
        }

        goto rollback;
    }

    sqlite3_finalize(statement);
    statement = NULL;

    if (sqlite3_prepare_v2(
            account_db,
            "UPDATE devices SET replaced_at = ?1 "
            "WHERE username = ?2 AND device_id != ?3 AND replaced_at IS NULL AND revoked_at IS NULL;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 1, now) != SQLITE_OK ||
        sqlite3_bind_text(statement, 2, username, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 3, device_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_DONE) {
        if (statement != NULL) {
            sqlite3_finalize(statement);
        }

        goto rollback;
    }

    sqlite3_finalize(statement);
    statement = NULL;

    if (sqlite3_prepare_v2(
            account_db,
            "INSERT INTO sessions "
            "(session_id, username, device_id, token_hash, created_at, expires_at, refreshed_at, revoked_at, replaced_by_device_id) "
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL);",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_text(statement, 1, session_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 2, username, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 3, device_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_blob(statement, 4, token_hash, 32, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 5, now) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 6, expires_at) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_DONE) {
        if (statement != NULL) {
            sqlite3_finalize(statement);
        }

        goto rollback;
    }

    sqlite3_finalize(statement);
    statement = NULL;

    if (!insert_session_event(username, device_id, session_id, "session_created", NULL)) {
        goto rollback;
    }

    if (!db_exec("COMMIT;")) {
        goto cleanup;
    }

    state->authenticated = 1;
    state->room[0] = '\0';
    state->public_key[0] = '\0';
    memcpy(state->username, username, bounded_strlen(username, USERNAME_MAX) + 1);
    memcpy(state->device_id, device_id, bounded_strlen(device_id, ID_MAX) + 1);
    memcpy(state->session_id, session_id, bounded_strlen(session_id, ID_MAX) + 1);
    state->session_expires_at = expires_at;
    notify_replaced_sessions(state, username, device_id);
    (void)send_textf(
        state,
        "OK|auth|%s|%s|%s|%s|%s|%lld|%d|%lld",
        state->peer_id,
        state->username,
        state->device_id,
        state->session_id,
        session_token,
        (long long)expires_at,
        get_backup_version(username),
        (long long)now
    );
    ok = 1;
    goto cleanup;

rollback:
    (void)db_exec("ROLLBACK;");
cleanup:
    secure_clear(device_id, sizeof(device_id));
    secure_clear(session_id, sizeof(session_id));
    secure_clear(session_token, sizeof(session_token));
    secure_clear(token_hash, sizeof(token_hash));
    return ok;
}

static int is_active_session(struct session_state *state) {
    if (state == NULL ||
        !state->authenticated ||
        !valid_username(state->username) ||
        !valid_id_field(state->device_id) ||
        !valid_id_field(state->session_id)) {
        return 0;
    }

    sqlite3_stmt *statement = NULL;
    int ok = 0;
    int64_t expires_at = 0;

    if (sqlite3_prepare_v2(
            account_db,
            "SELECT expires_at FROM sessions "
            "WHERE username = ?1 AND device_id = ?2 AND session_id = ?3 "
            "AND revoked_at IS NULL AND expires_at > ?4;",
            -1,
            &statement,
            NULL
        ) == SQLITE_OK &&
        sqlite3_bind_text(statement, 1, state->username, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_bind_text(statement, 2, state->device_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_bind_text(statement, 3, state->session_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
        sqlite3_bind_int64(statement, 4, now_unix()) == SQLITE_OK &&
        sqlite3_step(statement) == SQLITE_ROW) {
        expires_at = sqlite3_column_int64(statement, 0);
        ok = 1;
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    if (ok) {
        state->session_expires_at = expires_at;
    }

    return ok;
}

static int require_active_session(struct session_state *state) {
    if (is_active_session(state)) {
        return 1;
    }

    (void)send_textf(state, "ERR|session");

    if (state != NULL) {
        state->closing = 1;
        lws_callback_on_writable(state->wsi);
    }

    return 0;
}

static int verify_device_signature(
    const char *device_public_key,
    const char *session_id,
    const char *nonce,
    const char *nonce_signature
) {
    unsigned char public_x[32];
    unsigned char public_y[32];
    unsigned char signature_raw[64];
    unsigned char digest[32];
    char signed_text[(ID_MAX * 2) + 4];
    int ok = 0;

    memset(public_x, 0, sizeof(public_x));
    memset(public_y, 0, sizeof(public_y));
    memset(signature_raw, 0, sizeof(signature_raw));
    memset(digest, 0, sizeof(digest));
    memset(signed_text, 0, sizeof(signed_text));

    int written = snprintf(signed_text, sizeof(signed_text), "%s|%s", session_id, nonce);

    if (device_public_key == NULL ||
        session_id == NULL ||
        nonce == NULL ||
        nonce_signature == NULL ||
        nonce[0] == '\0' ||
        nonce_signature[0] == '\0' ||
        written <= 0 ||
        (size_t)written >= sizeof(signed_text) ||
        !decode_device_public_key(device_public_key, public_x, public_y) ||
        !normalize_ecdsa_signature(nonce_signature, signature_raw) ||
        !sha256_bytes((const unsigned char *)signed_text, (size_t)written, digest)) {
        goto cleanup;
    }

    ok = verify_ecdsa_p256_signature(public_x, public_y, digest, signature_raw);

cleanup:
    secure_clear(public_x, sizeof(public_x));
    secure_clear(public_y, sizeof(public_y));
    secure_clear(signature_raw, sizeof(signature_raw));
    secure_clear(digest, sizeof(digest));
    secure_clear(signed_text, sizeof(signed_text));
    return ok;
}

static void handle_session_challenge(
    struct session_state *state,
    char *cursor
) {
    char *session_id = next_field(&cursor);
    char nonce[ID_MAX + 1];
    char db_device_id[ID_MAX + 1];
    int64_t now = now_unix();
    sqlite3_stmt *statement = NULL;
    int ok = 0;

    memset(nonce, 0, sizeof(nonce));
    memset(db_device_id, 0, sizeof(db_device_id));

    if (state == NULL ||
        !state->hello_seen ||
        session_id == NULL ||
        cursor != NULL ||
        !valid_id_field(session_id) ||
        !valid_public_key_field(state->pending_device_public_key) ||
        !generate_random_id("nonce_", nonce, sizeof(nonce))) {
        goto cleanup;
    }

    if (sqlite3_prepare_v2(
            account_db,
            "DELETE FROM session_nonces WHERE expires_at <= ?1 OR used_at IS NOT NULL;",
            -1,
            &statement,
            NULL
        ) == SQLITE_OK &&
        sqlite3_bind_int64(statement, 1, now) == SQLITE_OK) {
        (void)sqlite3_step(statement);
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
        statement = NULL;
    }

    if (sqlite3_prepare_v2(
            account_db,
            "SELECT s.device_id "
            "FROM sessions s JOIN devices d ON d.device_id = s.device_id "
            "WHERE s.session_id = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2 "
            "AND d.device_public_key = ?3;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_text(statement, 1, session_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 2, now) != SQLITE_OK ||
        sqlite3_bind_text(statement, 3, state->pending_device_public_key, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_ROW) {
        goto cleanup;
    }

    const unsigned char *device_id_text = sqlite3_column_text(statement, 0);

    if (device_id_text == NULL) {
        goto cleanup;
    }

    memcpy(db_device_id, device_id_text, bounded_strlen((const char *)device_id_text, ID_MAX) + 1);
    sqlite3_finalize(statement);
    statement = NULL;

    if (sqlite3_prepare_v2(
            account_db,
            "INSERT OR REPLACE INTO session_nonces "
            "(nonce, session_id, device_id, created_at, expires_at, used_at) "
            "VALUES (?1, ?2, ?3, ?4, ?5, NULL);",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_text(statement, 1, nonce, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 2, session_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 3, db_device_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 4, now) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 5, now + SESSION_NONCE_TTL_SECONDS) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_DONE) {
        goto cleanup;
    }

    (void)send_textf(
        state,
        "SESSION_NONCE|%s|%s|%lld",
        session_id,
        nonce,
        (long long)now
    );
    ok = 1;

cleanup:
    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    secure_clear(nonce, sizeof(nonce));
    secure_clear(db_device_id, sizeof(db_device_id));

    if (!ok) {
        (void)send_textf(state, "ERR|session_challenge");
    }
}

static void handle_session_refresh(
    struct session_state *state,
    char *cursor
) {
    char *session_id = next_field(&cursor);
    char *session_token = next_field(&cursor);
    char *nonce = next_field(&cursor);
    char *nonce_signature = next_field(&cursor);

    if (session_id == NULL ||
        session_token == NULL ||
        nonce == NULL ||
        nonce_signature == NULL ||
        cursor != NULL ||
        !valid_id_field(session_id) ||
        !valid_token_field(session_token) ||
        !valid_id_field(nonce) ||
        state == NULL ||
        !state->hello_seen) {
        (void)send_textf(state, "ERR|session_refresh");
        if (state != NULL) {
            state->closing = 1;
            lws_callback_on_writable(state->wsi);
        }
        return;
    }

    unsigned char candidate_hash[32];
    unsigned char stored_hash[32];
    char new_token[TOKEN_MAX + 1];
    char db_username[USERNAME_MAX + 1];
    char db_device_id[ID_MAX + 1];
    char db_public_key[PUBLIC_KEY_MAX + 1];
    int64_t now = now_unix();
    int64_t expires_at = now + 86400;
    sqlite3_stmt *statement = NULL;
    int ok = 0;

    memset(candidate_hash, 0, sizeof(candidate_hash));
    memset(stored_hash, 0, sizeof(stored_hash));
    memset(new_token, 0, sizeof(new_token));
    memset(db_username, 0, sizeof(db_username));
    memset(db_device_id, 0, sizeof(db_device_id));
    memset(db_public_key, 0, sizeof(db_public_key));

    if (!hash_session_token(session_token, candidate_hash) ||
        sqlite3_prepare_v2(
            account_db,
            "SELECT s.token_hash, s.username, s.device_id, d.device_public_key "
            "FROM sessions s JOIN devices d ON d.device_id = s.device_id "
            "WHERE s.session_id = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_text(statement, 1, session_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 2, now) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_ROW) {
        goto cleanup;
    }

    const void *hash_blob = sqlite3_column_blob(statement, 0);
    int hash_len = sqlite3_column_bytes(statement, 0);
    const unsigned char *username_text = sqlite3_column_text(statement, 1);
    const unsigned char *device_id_text = sqlite3_column_text(statement, 2);
    const unsigned char *public_key_text = sqlite3_column_text(statement, 3);

    if (hash_blob == NULL ||
        hash_len != 32 ||
        username_text == NULL ||
        device_id_text == NULL ||
        public_key_text == NULL) {
        goto cleanup;
    }

    memcpy(stored_hash, hash_blob, sizeof(stored_hash));
    memcpy(db_username, username_text, bounded_strlen((const char *)username_text, USERNAME_MAX) + 1);
    memcpy(db_device_id, device_id_text, bounded_strlen((const char *)device_id_text, ID_MAX) + 1);
    memcpy(db_public_key, public_key_text, bounded_strlen((const char *)public_key_text, PUBLIC_KEY_MAX) + 1);
    sqlite3_finalize(statement);
    statement = NULL;

    if ((state->authenticated && (
            strcmp(session_id, state->session_id) != 0 ||
            strcmp(db_username, state->username) != 0 ||
            strcmp(db_device_id, state->device_id) != 0)) ||
        strcmp(db_public_key, state->pending_device_public_key) != 0 ||
        !verify_device_signature(db_public_key, session_id, nonce, nonce_signature) ||
        !constant_time_equal(candidate_hash, stored_hash, 32) ||
        !generate_random_id("tok_", new_token, sizeof(new_token)) ||
        !hash_session_token(new_token, candidate_hash)) {
        goto cleanup;
    }

    if (sqlite3_prepare_v2(
            account_db,
            "SELECT nonce FROM session_nonces "
            "WHERE session_id = ?1 AND device_id = ?2 AND nonce = ?3 "
            "AND used_at IS NULL AND expires_at > ?4;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_text(statement, 1, session_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 2, db_device_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 3, nonce, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 4, now) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_ROW) {
        goto cleanup;
    }

    sqlite3_finalize(statement);
    statement = NULL;

    if (sqlite3_prepare_v2(
            account_db,
            "UPDATE sessions SET token_hash = ?1, expires_at = ?2, refreshed_at = ?3 "
            "WHERE session_id = ?4 AND username = ?5 AND device_id = ?6 AND revoked_at IS NULL;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_blob(statement, 1, candidate_hash, 32, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 2, expires_at) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 3, now) != SQLITE_OK ||
        sqlite3_bind_text(statement, 4, session_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 5, db_username, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 6, db_device_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_DONE) {
        goto cleanup;
    }

    sqlite3_finalize(statement);
    statement = NULL;

    if (sqlite3_prepare_v2(
            account_db,
            "UPDATE session_nonces SET used_at = ?1 "
            "WHERE session_id = ?2 AND device_id = ?3 AND nonce = ?4 AND used_at IS NULL;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_int64(statement, 1, now) != SQLITE_OK ||
        sqlite3_bind_text(statement, 2, session_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 3, db_device_id, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_bind_text(statement, 4, nonce, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_DONE ||
        sqlite3_changes(account_db) != 1) {
        goto cleanup;
    }

    sqlite3_finalize(statement);
    statement = NULL;

    if (sqlite3_prepare_v2(
            account_db,
            "UPDATE devices SET last_seen_at = ?1 WHERE device_id = ?2;",
            -1,
            &statement,
            NULL
        ) == SQLITE_OK &&
        sqlite3_bind_int64(statement, 1, now) == SQLITE_OK &&
        sqlite3_bind_text(statement, 2, db_device_id, -1, SQLITE_TRANSIENT) == SQLITE_OK) {
        (void)sqlite3_step(statement);
    }

    state->authenticated = 1;
    memcpy(state->username, db_username, bounded_strlen(db_username, USERNAME_MAX) + 1);
    memcpy(state->device_id, db_device_id, bounded_strlen(db_device_id, ID_MAX) + 1);
    memcpy(state->session_id, session_id, bounded_strlen(session_id, ID_MAX) + 1);
    state->session_expires_at = expires_at;
    (void)insert_session_event(state->username, state->device_id, state->session_id, "session_refreshed", NULL);
    (void)send_textf(
        state,
        "OK|session_refresh|%s|%s|%lld|%lld",
        state->session_id,
        new_token,
        (long long)expires_at,
        (long long)now
    );
    ok = 1;

cleanup:
    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    secure_clear(candidate_hash, sizeof(candidate_hash));
    secure_clear(stored_hash, sizeof(stored_hash));
    secure_clear(new_token, sizeof(new_token));
    secure_clear(db_username, sizeof(db_username));
    secure_clear(db_device_id, sizeof(db_device_id));
    secure_clear(db_public_key, sizeof(db_public_key));

    if (!ok) {
        (void)send_textf(state, "ERR|session_refresh");
        state->closing = 1;
        lws_callback_on_writable(state->wsi);
    }
}

static void handle_backup_get(struct session_state *state) {
    if (!require_active_session(state)) {
        return;
    }

    sqlite3_stmt *statement = NULL;

    if (sqlite3_prepare_v2(
            account_db,
            "SELECT backup_version, backup_updated_at, backup_ciphertext "
            "FROM encrypted_backups WHERE username = ?1;",
            -1,
            &statement,
            NULL
        ) != SQLITE_OK ||
        sqlite3_bind_text(statement, 1, state->username, -1, SQLITE_TRANSIENT) != SQLITE_OK ||
        sqlite3_step(statement) != SQLITE_ROW) {
        if (statement != NULL) {
            sqlite3_finalize(statement);
        }

        (void)send_textf(state, "ERR|backup_missing");
        return;
    }

    int version = sqlite3_column_int(statement, 0);
    int64_t updated_at = sqlite3_column_int64(statement, 1);
    const unsigned char *ciphertext = sqlite3_column_text(statement, 2);

    if (ciphertext != NULL) {
        (void)send_textf(
            state,
            "BACKUP|%d|%lld|%s",
            version,
            (long long)updated_at,
            ciphertext
        );
    } else {
        (void)send_textf(state, "ERR|backup_missing");
    }

    sqlite3_finalize(statement);
}

static void handle_backup_put(
    struct session_state *state,
    char *cursor
) {
    char *version_text = next_field(&cursor);
    char *client_created_text = next_field(&cursor);
    char *ciphertext = next_field(&cursor);
    int64_t version = 0;
    int64_t client_created_at = 0;

    if (!require_active_session(state) ||
        version_text == NULL ||
        client_created_text == NULL ||
        ciphertext == NULL ||
        cursor != NULL ||
        !parse_i64(version_text, &version) ||
        !parse_i64(client_created_text, &client_created_at) ||
        version <= 0 ||
        !valid_payload_field(ciphertext)) {
        (void)send_textf(state, "ERR|backup_put");
        return;
    }

    int current_version = get_backup_version(state->username);

    if (version <= current_version) {
        (void)send_textf(
            state,
            "OK|backup_put|%d|%lld",
            current_version,
            (long long)now_unix()
        );
        return;
    }

    sqlite3_stmt *statement = NULL;
    int64_t now = now_unix();
    int ok = sqlite3_prepare_v2(
        account_db,
        "INSERT INTO encrypted_backups "
        "(username, backup_version, backup_ciphertext, backup_updated_at, backup_client_created_at, backup_client_device_id) "
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6) "
        "ON CONFLICT(username) DO UPDATE SET "
        "backup_version = excluded.backup_version, "
        "backup_ciphertext = excluded.backup_ciphertext, "
        "backup_updated_at = excluded.backup_updated_at, "
        "backup_client_created_at = excluded.backup_client_created_at, "
        "backup_client_device_id = excluded.backup_client_device_id "
        "WHERE excluded.backup_version > encrypted_backups.backup_version;",
        -1,
        &statement,
        NULL
    ) == SQLITE_OK;

    if (ok) {
        ok =
            sqlite3_bind_text(statement, 1, state->username, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_int64(statement, 2, version) == SQLITE_OK &&
            sqlite3_bind_text(statement, 3, ciphertext, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_bind_int64(statement, 4, now) == SQLITE_OK &&
            sqlite3_bind_int64(statement, 5, client_created_at) == SQLITE_OK &&
            sqlite3_bind_text(statement, 6, state->device_id, -1, SQLITE_TRANSIENT) == SQLITE_OK &&
            sqlite3_step(statement) == SQLITE_DONE;
    }

    if (statement != NULL) {
        sqlite3_finalize(statement);
    }

    if (!ok) {
        (void)send_textf(state, "ERR|backup_put");
        return;
    }

    (void)send_textf(
        state,
        "OK|backup_put|%lld|%lld",
        (long long)version,
        (long long)now
    );
}

static void broadcast_room(
    const struct session_state *sender,
    const char *room,
    const char *text,
    int include_sender
) {
    if (room == NULL || room[0] == '\0' || text == NULL) {
        return;
    }

    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        struct session_state *client = clients[i];

        if (client == NULL ||
            !client->connected ||
            !client->authenticated ||
            !is_active_session(client) ||
            client->room[0] == '\0' ||
            strcmp(client->room, room) != 0) {
            continue;
        }

        if (!include_sender && client == sender) {
            continue;
        }

        (void)enqueue_text(client, text);
    }
}

static void leave_room(struct session_state *state) {
    if (state == NULL || state->room[0] == '\0') {
        return;
    }

    char old_room[ROOM_MAX + 1];
    memcpy(old_room, state->room, sizeof(old_room));

    send_textf(state, "OK|leave|%s", old_room);

    char notice[128];
    int written = snprintf(notice, sizeof(notice), "LEFT|%s", state->peer_id);

    if (written > 0 && written < (int)sizeof(notice)) {
        broadcast_room(state, old_room, notice, 0);
    }

    state->room[0] = '\0';
}

static void join_room(struct session_state *state, const char *room) {
    if (state == NULL || !require_active_session(state)) {
        return;
    }

    if (!valid_room_name(room)) {
        (void)send_textf(state, "ERR|join");
        return;
    }

    if (state->room[0] != '\0') {
        leave_room(state);
    }

    memcpy(state->room, room, strlen(room) + 1);
    (void)send_textf(state, "OK|join|%s|%s", state->room, state->peer_id);

    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        struct session_state *client = clients[i];

        if (client == NULL ||
            client == state ||
            !client->connected ||
            !client->authenticated ||
            !is_active_session(client) ||
            strcmp(client->room, state->room) != 0) {
            continue;
        }

        (void)send_textf(state, "PEER|%s|%s", client->peer_id, client->username);
        (void)send_textf(client, "PEER|%s|%s", state->peer_id, state->username);
    }
}

static char *next_field(char **cursor) {
    if (cursor == NULL || *cursor == NULL) {
        return NULL;
    }

    char *start = *cursor;
    char *separator = strchr(start, '|');

    if (separator == NULL) {
        *cursor = NULL;
        return start;
    }

    *separator = '\0';
    *cursor = separator + 1;
    return start;
}

static void authenticate_session(
    struct session_state *state,
    const char *username
) {
    if (!issue_account_session(state, username)) {
        (void)send_textf(state, "ERR|auth");
    }
}

static void handle_signup(
    struct session_state *state,
    char *cursor
) {
    char *username = next_field(&cursor);
    char *password_field = next_field(&cursor);

    if (!state->hello_seen ||
        username == NULL ||
        password_field == NULL ||
        cursor != NULL ||
        !create_user(username, password_field)) {
        (void)send_textf(state, "ERR|signup");
        return;
    }

    authenticate_session(state, username);
}

static void handle_hello(
    struct session_state *state,
    char *cursor
) {
    char *device_public_key = next_field(&cursor);
    char *device_label = next_field(&cursor);

    if (state == NULL ||
        device_public_key == NULL ||
        device_label == NULL ||
        cursor != NULL ||
        !valid_public_key_field(device_public_key) ||
        !valid_device_label(device_label)) {
        (void)send_textf(state, "ERR|hello");
        return;
    }

    memcpy(
        state->pending_device_public_key,
        device_public_key,
        bounded_strlen(device_public_key, PUBLIC_KEY_MAX) + 1
    );
    memcpy(
        state->pending_device_label,
        device_label,
        bounded_strlen(device_label, DEVICE_LABEL_MAX) + 1
    );
    state->hello_seen = 1;
    (void)send_textf(state, "OK|hello");
}

static void handle_login(
    struct session_state *state,
    char *cursor
) {
    char *username = next_field(&cursor);
    char *password_field = next_field(&cursor);

    if (!state->hello_seen ||
        username == NULL ||
        password_field == NULL ||
        cursor != NULL ||
        !verify_user(username, password_field)) {
        (void)send_textf(state, "ERR|login");
        return;
    }

    authenticate_session(state, username);
}

static void handle_chat(
    struct session_state *state,
    char *cursor
) {
    char *room = next_field(&cursor);
    char *payload = next_field(&cursor);

    if (!require_active_session(state)) {
        return;
    }

    if (state->room[0] == '\0' ||
        room == NULL ||
        payload == NULL ||
        cursor != NULL ||
        strcmp(room, state->room) != 0 ||
        !valid_payload_field(payload)) {
        (void)send_textf(state, "ERR|chat");
        return;
    }

    char frame[MAX_FRAME_BYTES];
    int written = snprintf(frame, sizeof(frame), "CHAT|%s|%s", state->peer_id, payload);

    if (written <= 0 || written >= (int)sizeof(frame)) {
        (void)send_textf(state, "ERR|chat");
        secure_clear(frame, sizeof(frame));
        return;
    }

    int64_t server_sent_at = now_unix();
    broadcast_room(state, state->room, frame, 0);
    (void)send_textf(state, "OK|chat|%lld", (long long)server_sent_at);
    secure_clear(frame, sizeof(frame));
}

static void handle_signal_frame(
    struct session_state *state,
    char *cursor
) {
    char *target_peer_id = next_field(&cursor);
    char *payload = next_field(&cursor);

    if (!require_active_session(state)) {
        return;
    }

    if (state->room[0] == '\0' ||
        target_peer_id == NULL ||
        payload == NULL ||
        cursor != NULL ||
        !valid_payload_field(payload)) {
        (void)send_textf(state, "ERR|signal");
        return;
    }

    struct session_state *target = find_client_by_peer_id(target_peer_id);

    if (target == NULL ||
        target->room[0] == '\0' ||
        strcmp(target->room, state->room) != 0) {
        (void)send_textf(state, "ERR|signal");
        return;
    }

    (void)send_textf(target, "SIGNAL|%s|%s", state->peer_id, payload);
}

static void handle_public_key(
    struct session_state *state,
    char *cursor
) {
    char *public_key = next_field(&cursor);

    if (!require_active_session(state)) {
        return;
    }

    if (public_key == NULL ||
        cursor != NULL ||
        !valid_public_key_field(public_key)) {
        (void)send_textf(state, "ERR|key");
        return;
    }

    memcpy(state->public_key, public_key, strlen(public_key) + 1);
    (void)send_textf(state, "OK|key");
}

static void handle_user_lookup(
    struct session_state *state,
    char *cursor
) {
    char *username = next_field(&cursor);

    if (!require_active_session(state)) {
        return;
    }

    if (username == NULL ||
        cursor != NULL ||
        !valid_username(username)) {
        (void)send_textf(state, "ERR|user");
        return;
    }

    struct session_state *target = find_client_by_username(username);

    if (target == NULL || target->public_key[0] == '\0') {
        (void)send_textf(state, "ERR|user");
        return;
    }

    (void)send_textf(
        state,
        "USER|%s|%s|%s",
        target->username,
        target->peer_id,
        target->public_key
    );
}

static void handle_direct_message(
    struct session_state *state,
    char *cursor
) {
    char *target_username = next_field(&cursor);
    char *payload = next_field(&cursor);

    if (!require_active_session(state)) {
        return;
    }

    if (state->public_key[0] == '\0' ||
        target_username == NULL ||
        payload == NULL ||
        cursor != NULL ||
        !valid_username(target_username) ||
        !valid_payload_field(payload)) {
        (void)send_textf(state, "ERR|dm");
        return;
    }

    struct session_state *target = find_client_by_username(target_username);

    if (target == NULL || target->public_key[0] == '\0') {
        (void)send_textf(state, "ERR|dm");
        return;
    }

    if (!send_textf(
            target,
            "DM|%s|%s|%s|%s",
            state->username,
            state->peer_id,
            state->public_key,
            payload
        )) {
        (void)send_textf(state, "ERR|dm");
        return;
    }

    (void)send_textf(state, "OK|dm|%s|%lld", target->username, (long long)now_unix());
}

static void handle_direct_signal(
    struct session_state *state,
    char *cursor
) {
    char *target_username = next_field(&cursor);
    char *payload = next_field(&cursor);

    if (!require_active_session(state)) {
        return;
    }

    if (state->public_key[0] == '\0' ||
        target_username == NULL ||
        payload == NULL ||
        cursor != NULL ||
        !valid_username(target_username) ||
        !valid_payload_field(payload)) {
        (void)send_textf(state, "ERR|dsignal");
        return;
    }

    struct session_state *target = find_client_by_username(target_username);

    if (target == NULL || target->public_key[0] == '\0') {
        (void)send_textf(state, "ERR|dsignal");
        return;
    }

    if (!send_textf(
            target,
            "DSIGNAL|%s|%s|%s|%s",
            state->username,
            state->peer_id,
            state->public_key,
            payload
        )) {
        (void)send_textf(state, "ERR|dsignal");
        return;
    }

    (void)send_textf(state, "OK|dsignal|%s", target->username);
}

static struct call_route *find_call_route(const char *call_id) {
    if (call_id == NULL) {
        return NULL;
    }

    for (size_t i = 0; i < CALL_SLOTS; ++i) {
        if (calls[i].active && strcmp(calls[i].call_id, call_id) == 0) {
            return &calls[i];
        }
    }

    return NULL;
}

static struct call_route *upsert_call_route(
    const char *call_id,
    const char *call_kind,
    const char *caller_username,
    const char *target
) {
    struct call_route *route = find_call_route(call_id);

    if (route == NULL) {
        for (size_t i = 0; i < CALL_SLOTS; ++i) {
            if (!calls[i].active) {
                route = &calls[i];
                memset(route, 0, sizeof(*route));
                route->active = 1;
                break;
            }
        }
    }

    if (route == NULL) {
        return NULL;
    }

    memcpy(route->call_id, call_id, bounded_strlen(call_id, ID_MAX) + 1);
    memcpy(route->call_kind, call_kind, bounded_strlen(call_kind, sizeof(route->call_kind) - 1) + 1);
    memcpy(route->caller_username, caller_username, bounded_strlen(caller_username, USERNAME_MAX) + 1);
    memcpy(route->target, target, bounded_strlen(target, ROOM_MAX) + 1);
    return route;
}

static int send_call_event_to_user(
    struct session_state *sender,
    const char *target_username,
    const char *event_type,
    const char *call_id,
    int64_t server_now,
    const char *payload
) {
    if (sender == NULL) {
        return 0;
    }

    struct session_state *target = find_client_by_username(target_username);

    if (target == NULL || !is_active_session(target)) {
        return 0;
    }

    return send_textf(
        target,
        "CALL_EVENT|%s|%s|%s|%lld|%s|%s|%s",
        event_type,
        call_id,
        sender->username,
        (long long)server_now,
        payload,
        sender->peer_id,
        sender->public_key
    );
}

static void send_call_event_to_room(
    struct session_state *sender,
    const char *room,
    const char *event_type,
    const char *call_id,
    int64_t server_now,
    const char *payload
) {
    for (size_t i = 0; i < MAX_CLIENTS; ++i) {
        struct session_state *client = clients[i];

        if (client == NULL ||
            client == sender ||
            !client->connected ||
            !client->authenticated ||
            !is_active_session(client) ||
            strcmp(client->room, room) != 0) {
            continue;
        }

        (void)send_textf(
            client,
            "CALL_EVENT|%s|%s|%s|%lld|%s|%s|%s",
            event_type,
            call_id,
            sender->username,
            (long long)server_now,
            payload,
            sender->peer_id,
            sender->public_key
        );
    }
}

static int route_call_event(
    struct session_state *state,
    struct call_route *route,
    const char *event_type,
    int64_t server_now,
    const char *payload
) {
    if (strcmp(route->call_kind, "direct") == 0) {
        const char *target =
            strcmp(state->username, route->caller_username) == 0 ?
            route->target :
            route->caller_username;
        return send_call_event_to_user(state, target, event_type, route->call_id, server_now, payload);
    }

    if (strcmp(route->call_kind, "room") == 0) {
        send_call_event_to_room(state, route->target, event_type, route->call_id, server_now, payload);
        return 1;
    }

    return 0;
}

static void handle_call_invite(
    struct session_state *state,
    char *cursor
) {
    char *call_id = next_field(&cursor);
    char *call_kind = next_field(&cursor);
    char *target = next_field(&cursor);
    char *payload = next_field(&cursor);

    if (!require_active_session(state)) {
        return;
    }

    if (call_id == NULL ||
        call_kind == NULL ||
        target == NULL ||
        payload == NULL ||
        cursor != NULL ||
        !valid_id_field(call_id) ||
        !valid_payload_field(payload) ||
        !((strcmp(call_kind, "direct") == 0 && valid_username(target)) ||
          (strcmp(call_kind, "room") == 0 && valid_room_name(target)))) {
        (void)send_textf(state, "ERR|call_invite");
        return;
    }

    if (strcmp(call_kind, "direct") == 0 && state->public_key[0] == '\0') {
        (void)send_textf(state, "ERR|call_invite");
        return;
    }

    struct call_route *route = upsert_call_route(call_id, call_kind, state->username, target);
    int64_t server_now = now_unix();

    if (route == NULL ||
        !route_call_event(state, route, "invite", server_now, payload)) {
        (void)send_textf(state, "ERR|call_invite");
        return;
    }

    (void)insert_call_event(call_id, state->username, state->device_id, "invite", NULL, call_kind);
    (void)send_textf(state, "OK|call_invite|%s|%lld", call_id, (long long)server_now);
}

static void handle_call_event_command(
    struct session_state *state,
    char *cursor,
    const char *command,
    const char *event_type
) {
    char *call_id = next_field(&cursor);
    char *payload = next_field(&cursor);

    if (!require_active_session(state)) {
        return;
    }

    if (call_id == NULL ||
        payload == NULL ||
        cursor != NULL ||
        !valid_id_field(call_id) ||
        !valid_payload_field(payload)) {
        (void)send_textf(state, "ERR|%s", command);
        return;
    }

    struct call_route *route = find_call_route(call_id);
    int64_t server_now = now_unix();

    if (route == NULL || !route_call_event(state, route, event_type, server_now, payload)) {
        (void)send_textf(state, "ERR|%s", command);
        return;
    }

    if (strcmp(event_type, "end") == 0 || strcmp(event_type, "decline") == 0) {
        route->active = 0;
    }

    (void)insert_call_event(call_id, state->username, state->device_id, event_type, NULL, NULL);
    (void)send_textf(state, "OK|%s|%s|%lld", command, call_id, (long long)server_now);
}

static void handle_client_text(struct session_state *state, char *text) {
    char *cursor = text;
    char *command = next_field(&cursor);

    if (command == NULL) {
        return;
    }

    if (strcmp(command, "HELLO") == 0) {
        handle_hello(state, cursor);
        return;
    }

    if (strcmp(command, "SIGNUP") == 0) {
        handle_signup(state, cursor);
        return;
    }

    if (strcmp(command, "LOGIN") == 0) {
        handle_login(state, cursor);
        return;
    }

    if (strcmp(command, "SESSION_REFRESH") == 0) {
        handle_session_refresh(state, cursor);
        return;
    }

    if (strcmp(command, "SESSION_CHALLENGE") == 0) {
        handle_session_challenge(state, cursor);
        return;
    }

    if (strcmp(command, "BACKUP_GET") == 0) {
        if (cursor != NULL) {
            (void)send_textf(state, "ERR|backup_get");
            return;
        }

        handle_backup_get(state);
        return;
    }

    if (strcmp(command, "BACKUP_PUT") == 0) {
        handle_backup_put(state, cursor);
        return;
    }

    if (strcmp(command, "JOIN") == 0) {
        char *room = next_field(&cursor);

        if (room == NULL || cursor != NULL) {
            (void)send_textf(state, "ERR|join");
            return;
        }

        join_room(state, room);
        return;
    }

    if (strcmp(command, "LEAVE") == 0) {
        if (!require_active_session(state)) {
            return;
        }

        if (cursor != NULL) {
            (void)send_textf(state, "ERR|leave");
            return;
        }

        leave_room(state);
        return;
    }

    if (strcmp(command, "CHAT") == 0) {
        handle_chat(state, cursor);
        return;
    }

    if (strcmp(command, "SIGNAL") == 0) {
        handle_signal_frame(state, cursor);
        return;
    }

    if (strcmp(command, "KEY") == 0) {
        handle_public_key(state, cursor);
        return;
    }

    if (strcmp(command, "WHO") == 0) {
        handle_user_lookup(state, cursor);
        return;
    }

    if (strcmp(command, "DM") == 0) {
        handle_direct_message(state, cursor);
        return;
    }

    if (strcmp(command, "DSIGNAL") == 0) {
        handle_direct_signal(state, cursor);
        return;
    }

    if (strcmp(command, "CALL_INVITE") == 0) {
        handle_call_invite(state, cursor);
        return;
    }

    if (strcmp(command, "CALL_ACCEPT") == 0) {
        handle_call_event_command(state, cursor, "call_accept", "accept");
        return;
    }

    if (strcmp(command, "CALL_DECLINE") == 0) {
        handle_call_event_command(state, cursor, "call_decline", "decline");
        return;
    }

    if (strcmp(command, "CALL_END") == 0) {
        handle_call_event_command(state, cursor, "call_end", "end");
        return;
    }

    if (strcmp(command, "PING") == 0) {
        (void)send_textf(state, "PONG");
        return;
    }

    (void)send_textf(state, "ERR|unknown");
}

static int is_allowed_path(struct lws *wsi) {
    char path[128];
    int copied = lws_hdr_copy(wsi, path, sizeof(path), WSI_TOKEN_GET_URI);

    if (copied <= 0) {
        return 0;
    }

    return strcmp(path, WS_PATH) == 0;
}

static int anonchat_callback(
    struct lws *wsi,
    enum lws_callback_reasons reason,
    void *user,
    void *in,
    size_t len
) {
    struct session_state *state = (struct session_state *)user;

    switch (reason) {
        case LWS_CALLBACK_FILTER_PROTOCOL_CONNECTION:
            return is_allowed_path(wsi) ? 0 : -1;

        case LWS_CALLBACK_ESTABLISHED:
            memset(state, 0, sizeof(*state));
            state->wsi = wsi;
            state->connected = 1;

            if (!generate_peer_id(state->peer_id)) {
                return -1;
            }

            if (!add_client(state)) {
                return -1;
            }

            return 0;

        case LWS_CALLBACK_RECEIVE: {
            if (lws_frame_is_binary(wsi) ||
                lws_remaining_packet_payload(wsi) != 0 ||
                !lws_is_final_fragment(wsi) ||
                len == 0 ||
                len >= MAX_FRAME_BYTES) {
                return -1;
            }

            char text[MAX_FRAME_BYTES];
            memcpy(text, in, len);
            text[len] = '\0';

            handle_client_text(state, text);
            secure_clear(text, sizeof(text));
            return 0;
        }

        case LWS_CALLBACK_SERVER_WRITEABLE: {
            if (state->closing && state->out_count == 0) {
                return -1;
            }

            if (state->out_count == 0) {
                return 0;
            }

            struct pending_message *message = &state->outbox[state->out_head];
            size_t message_len = message->len;
            unsigned char output[LWS_PRE + MAX_FRAME_BYTES];

            memcpy(&output[LWS_PRE], message->text, message_len);

            int written = lws_write(
                wsi,
                &output[LWS_PRE],
                (unsigned int)message_len,
                LWS_WRITE_TEXT
            );

            secure_clear(output, sizeof(output));
            secure_clear(message, sizeof(*message));

            if (written < 0 || (size_t)written != message_len) {
                return -1;
            }

            state->out_head = (state->out_head + 1) % OUTBOX_SIZE;
            state->out_count--;

            if (state->out_count > 0) {
                lws_callback_on_writable(wsi);
            } else if (state->closing) {
                return -1;
            }

            return 0;
        }

        case LWS_CALLBACK_CLOSED:
            if (state != NULL && state->connected) {
                leave_room(state);
                remove_client(state);
                secure_clear(state, sizeof(*state));
            }

            return 0;

        default:
            return 0;
    }
}

static const struct lws_protocols protocols[] = {
    {
        .name = "http",
        .callback = lws_callback_http_dummy,
        .per_session_data_size = 0,
        .rx_buffer_size = 0,
        .id = 0,
        .user = NULL,
        .tx_packet_size = 0
    },
    {
        .name = "anonchat",
        .callback = anonchat_callback,
        .per_session_data_size = sizeof(struct session_state),
        .rx_buffer_size = MAX_FRAME_BYTES,
        .id = 0,
        .user = NULL,
        .tx_packet_size = MAX_FRAME_BYTES
    },
    LWS_PROTOCOL_LIST_TERM
};

static const struct lws_http_mount mount = {
    .mount_next = NULL,
    .mountpoint = "/",
    .origin = ANONCHAT_WEB_DIR,
    .def = "index.html",
    .origin_protocol = LWSMPRO_FILE,
    .mountpoint_len = 1
};

static int listen_port_from_env(void) {
    const char *text = getenv("ANONCHAT_PORT");

    if (text == NULL || text[0] == '\0') {
        return DEFAULT_LISTEN_PORT;
    }

    long value = strtol(text, NULL, 10);

    if (value < 1 || value > 65535) {
        return DEFAULT_LISTEN_PORT;
    }

    return (int)value;
}

static const char *bind_interface_from_env(void) {
    const char *iface = getenv("ANONCHAT_BIND");

    if (iface != NULL && iface[0] != '\0') {
        return iface;
    }

    return NULL;
}

int main(void) {
    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);

    lws_set_log_level(0, NULL);

    if (!db_open()) {
        fprintf(stderr, "anonchat failed to open account database\n");
        return 1;
    }

    struct lws_context_creation_info info;
    memset(&info, 0, sizeof(info));

    int port = listen_port_from_env();

    info.port = port;
    info.iface = bind_interface_from_env();
    info.protocols = protocols;
    info.mounts = &mount;
    info.gid = -1;
    info.uid = -1;

    struct lws_context *context = lws_create_context(&info);

    if (context == NULL) {
        fprintf(stderr, "anonchat failed to start\n");
        db_close();
        return 1;
    }

    printf("anonchat listening at http://127.0.0.1:%d/\n", port);

    while (!interrupted) {
        lws_service(context, 100);
    }

    lws_context_destroy(context);
    secure_clear(clients, sizeof(clients));
    db_close();

    return 0;
}
