export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function hasWebCrypto() {
  return Boolean(window.crypto && crypto.getRandomValues && crypto.subtle);
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

export function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return base64ToBytes(padded);
}

export function textToBase64(text) {
  return bytesToBase64(enc.encode(text));
}

export function textToBase64Url(text) {
  return bytesToBase64Url(enc.encode(text));
}

export function base64UrlToText(text) {
  return dec.decode(base64UrlToBytes(text));
}

export function randomBytes(byteCount = 24) {
  if (!window.crypto || !crypto.getRandomValues) {
    throw new Error("secure random unavailable");
  }

  return crypto.getRandomValues(new Uint8Array(byteCount));
}

export function randomKey(byteCount = 24) {
  return bytesToBase64Url(randomBytes(byteCount));
}

export async function derivePbkdf2Key(secret, saltText, usages = ["encrypt", "decrypt"]) {
  if (!hasWebCrypto()) {
    throw new Error("WebCrypto unavailable");
  }

  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode(saltText), iterations: 250000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

export async function deriveBits(secret, saltText, bitCount = 256) {
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(saltText), iterations: 250000, hash: "SHA-256" },
    keyMaterial,
    bitCount
  ));
}

export async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const plain = enc.encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  return textToBase64Url(JSON.stringify({ v: 1, iv: bytesToBase64Url(iv), ct: bytesToBase64Url(cipher) }));
}

export async function decryptJson(key, payload) {
  const box = JSON.parse(base64UrlToText(payload));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(box.iv) },
    key,
    base64UrlToBytes(box.ct)
  );
  return JSON.parse(dec.decode(plain));
}

export async function sha256Hex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
