const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomID(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function deriveRoomKeys(roomID: string, passphrase: string) {
  const chat = await deriveKey(passphrase, `anonchat2:${roomID}:chat-v1`);
  const signal = await deriveKey(passphrase, `anonchat2:${roomID}:signal-v1`);
  return { chat, signal };
}

export async function encryptJSON(key: CryptoKey, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return `${base64url(iv)}.${base64url(cipher)}`;
}

export async function decryptJSON<T>(key: CryptoKey, value: string): Promise<T> {
  const [ivText, cipherText] = value.split(".");
  if (!ivText || !cipherText) {
    throw new Error("bad ciphertext");
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unbase64url(ivText) },
    key,
    unbase64url(cipherText)
  );
  return JSON.parse(dec.decode(plain)) as T;
}

async function deriveKey(passphrase: string, salt: string) {
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 250000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unbase64url(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
