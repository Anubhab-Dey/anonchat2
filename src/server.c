#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <bcrypt.h>

#include <libwebsockets.h>
#include <sqlite3.h>

#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef ANONCHAT_WEB_DIR
#define ANONCHAT_WEB_DIR "./web"
#endif

#define DEFAULT_LISTEN_PORT 8080
#define WS_PATH "/ws"

#define MAX_CLIENTS 128
#define USERNAME_MAX 32
#define ROOM_MAX 64
#define PASSWORD_FIELD_MAX 512
#define PUBLIC_KEY_MAX 2048
#define MAX_FRAME_BYTES 32768
#define OUTBOX_SIZE 16

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
    int closing;
    char peer_id[PEER_ID_TEXT_BYTES];
    char username[USERNAME_MAX + 1];
    char room[ROOM_MAX + 1];
    char public_key[PUBLIC_KEY_MAX + 1];
    size_t out_head;
    size_t out_count;
    struct pending_message outbox[OUTBOX_SIZE];
};

static volatile sig_atomic_t interrupted = 0;
static struct session_state *clients[MAX_CLIENTS];
static sqlite3 *account_db = NULL;

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
        )) {
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

    NTSTATUS status = BCryptGenRandom(
        NULL,
        buffer,
        (ULONG)len,
        BCRYPT_USE_SYSTEM_PREFERRED_RNG
    );

    return status == 0;
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

static int hash_password_field(
    const char *password_field,
    const unsigned char salt[PASSWORD_SALT_BYTES],
    unsigned char out_hash[PASSWORD_HASH_BYTES]
) {
    if (password_field == NULL || salt == NULL || out_hash == NULL) {
        return 0;
    }

    memset(out_hash, 0, PASSWORD_HASH_BYTES);

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

    size_t password_len = strnlen(password_field, PASSWORD_FIELD_MAX + 1);

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
}

static int text_has_len_between(const char *text, size_t min, size_t max) {
    if (text == NULL) {
        return 0;
    }

    size_t len = strnlen(text, max + 1);
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

    size_t len = strnlen(text, MAX_FRAME_BYTES);

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
    if (state == NULL || !state->authenticated || !valid_room_name(room)) {
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
    state->authenticated = 1;
    state->room[0] = '\0';
    state->public_key[0] = '\0';
    memcpy(state->username, username, strlen(username) + 1);
    (void)send_textf(state, "OK|auth|%s|%s", state->peer_id, state->username);
}

static void handle_signup(
    struct session_state *state,
    char *cursor
) {
    char *username = next_field(&cursor);
    char *password_field = next_field(&cursor);

    if (username == NULL ||
        password_field == NULL ||
        cursor != NULL ||
        !create_user(username, password_field)) {
        (void)send_textf(state, "ERR|signup");
        return;
    }

    authenticate_session(state, username);
}

static void handle_login(
    struct session_state *state,
    char *cursor
) {
    char *username = next_field(&cursor);
    char *password_field = next_field(&cursor);

    if (username == NULL ||
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

    if (!state->authenticated ||
        state->room[0] == '\0' ||
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

    broadcast_room(state, state->room, frame, 0);
    (void)send_textf(state, "OK|chat");
    secure_clear(frame, sizeof(frame));
}

static void handle_signal_frame(
    struct session_state *state,
    char *cursor
) {
    char *target_peer_id = next_field(&cursor);
    char *payload = next_field(&cursor);

    if (!state->authenticated ||
        state->room[0] == '\0' ||
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

    if (!state->authenticated ||
        public_key == NULL ||
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

    if (!state->authenticated ||
        username == NULL ||
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

    if (!state->authenticated ||
        state->public_key[0] == '\0' ||
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

    (void)send_textf(state, "OK|dm|%s", target->username);
}

static void handle_direct_signal(
    struct session_state *state,
    char *cursor
) {
    char *target_username = next_field(&cursor);
    char *payload = next_field(&cursor);

    if (!state->authenticated ||
        state->public_key[0] == '\0' ||
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

static void handle_client_text(struct session_state *state, char *text) {
    char *cursor = text;
    char *command = next_field(&cursor);

    if (command == NULL) {
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
            if (state->closing) {
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
