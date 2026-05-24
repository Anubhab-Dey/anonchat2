import { state, clearSessionOnly } from "./state.js";
import { dbGet, dbPut, deleteLocalData } from "./local-db.js";
import { enc, textToBase64Url, bytesToBase64Url, base64UrlToText } from "./crypto-box.js";
import { sendAndWait, sendWire, stopReconnect, waitForWire } from "./wire.js";
import { showToast } from "./toast.js";
import { showBlockingScreen, hideBlockingScreen, setIdentity } from "./ui.js";

export async function ensureDeviceIdentity() {
  let saved = await dbGet("settings", "device_identity");

  if (!saved || saved.kind !== "session-signing-v1") {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    saved = {
      key: "device_identity",
      kind: "session-signing-v1",
      publicJwk: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
      privateJwk: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
      label: deviceLabel(),
    };
    await dbPut("settings", saved);
  }

  const publicKey = await crypto.subtle.importKey("jwk", saved.publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  const privateKey = await crypto.subtle.importKey("jwk", saved.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  state.deviceIdentity = {
    keyPair: { publicKey, privateKey },
    publicWire: textToBase64Url(JSON.stringify(saved.publicJwk)),
    label: saved.label || deviceLabel(),
  };
  return state.deviceIdentity;
}

export async function sendHello() {
  const identity = await ensureDeviceIdentity();
  await sendAndWait(
    `HELLO|${identity.publicWire}|${identity.label}`,
    (parts) => parts[0] === "OK" && parts[1] === "hello"
  );
}

export async function storeSessionFromAuth(parts) {
  state.authenticated = true;
  state.peerId = parts[2];
  state.username = parts[3];
  state.session.deviceId = parts[4];
  state.session.sessionId = parts[5];
  state.session.sessionToken = parts[6];
  state.session.expiresAt = Number(parts[7] || 0);
  state.session.backupVersion = Number(parts[8] || 0);
  localStorage.setItem("anonchat.username", state.username);
  await dbPut("settings", {
    key: "session",
    username: state.username,
    deviceId: state.session.deviceId,
    sessionId: state.session.sessionId,
    sessionToken: state.session.sessionToken,
    expiresAt: state.session.expiresAt,
    backupVersion: state.session.backupVersion,
  });
  hideBlockingScreen();
  setIdentity(state.username, "good");
  scheduleSessionRefresh();
}

export async function loadSavedSession() {
  const saved = await dbGet("settings", "session");

  if (!saved || !saved.sessionId || !saved.sessionToken) {
    return null;
  }

  state.username = saved.username || "";
  state.session.deviceId = saved.deviceId || "";
  state.session.sessionId = saved.sessionId || "";
  state.session.sessionToken = saved.sessionToken || "";
  state.session.expiresAt = saved.expiresAt || 0;
  state.session.backupVersion = saved.backupVersion || 0;
  return saved;
}

export function scheduleSessionRefresh() {
  clearTimeout(state.refreshTimer);

  if (!state.session.sessionId || !state.session.sessionToken) {
    return;
  }

  const msUntilRefresh = Math.max(5000, (state.session.expiresAt * 1000) - Date.now() - (30 * 60 * 1000));
  state.refreshTimer = setTimeout(refreshSession, msUntilRefresh);
}

export async function refreshSession() {
  if (!state.session.sessionId || !state.session.sessionToken) {
    return false;
  }

  try {
    await sendHello();
    sendWire(`SESSION_CHALLENGE|${state.session.sessionId}`);
    const nonceReply = await waitForWire(
      (candidate) =>
        (candidate[0] === "SESSION_NONCE" && candidate[1] === state.session.sessionId) ||
        (candidate[0] === "ERR" && candidate[1] === "session_challenge"),
      8000
    );

    if (nonceReply.parts[0] !== "SESSION_NONCE") {
      throw new Error("challenge rejected");
    }

    const nonce = nonceReply.parts[2];
    const nonceSignature = await signSessionNonce(state.session.sessionId, nonce);
    const wait = waitForWire(
      (candidate) =>
        (candidate[0] === "OK" && candidate[1] === "session_refresh") ||
        (candidate[0] === "ERR" && candidate[1] === "session_refresh"),
      8000
    );
    sendWire(`SESSION_REFRESH|${state.session.sessionId}|${state.session.sessionToken}|${nonce}|${nonceSignature}`);
    const { parts } = await wait;

    if (parts[0] !== "OK") {
      throw new Error("refresh rejected");
    }

    state.authenticated = true;
    state.session.sessionId = parts[2];
    state.session.sessionToken = parts[3];
    state.session.expiresAt = Number(parts[4] || 0);
    await dbPut("settings", {
      key: "session",
      username: state.username,
      deviceId: state.session.deviceId,
      sessionId: state.session.sessionId,
      sessionToken: state.session.sessionToken,
      expiresAt: state.session.expiresAt,
      backupVersion: state.session.backupVersion,
    });
    showToast("Session refreshed", "success");
    scheduleSessionRefresh();
    return true;
  } catch {
    clearSessionOnly();
    setIdentity("Sign in needed", "warn");
    showToast("Please sign in again", "warning");
    return false;
  }
}

async function signSessionNonce(sessionId, nonce) {
  const identity = await ensureDeviceIdentity();
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identity.keyPair.privateKey,
    enc.encode(`${sessionId}|${nonce}`)
  ));
  return bytesToBase64Url(signature);
}

export async function handleSessionReplaced(newDeviceId) {
  stopReconnect();
  clearTimeout(state.refreshTimer);
  state.session.sessionId = "";
  state.session.sessionToken = "";
  await dbPut("settings", {
    key: "session",
    username: state.username,
    deviceId: state.session.deviceId,
    sessionId: "",
    sessionToken: "",
    expiresAt: 0,
    backupVersion: state.session.backupVersion,
    replacedBy: newDeviceId,
  });
  clearSessionOnly();
  showToast("Account is active on another device", "warning");
  showBlockingScreen("Use this device?", "Your chats are still saved here. Sign in to make this the active device, or clear only this device.");
}

export async function clearThisDevice() {
  await deleteLocalData();
  location.reload();
}

export function signInAgain() {
  hideBlockingScreen();
  state.reconnectEnabled = true;
}

export function deviceLabel() {
  const ua = navigator.userAgent || "";
  const standalone = window.matchMedia("(display-mode: standalone)").matches;

  if (/Android/i.test(ua) && standalone) return "Android PWA";
  if (/Android/i.test(ua)) return "Chrome on Android";
  if (/iPhone|iPad/i.test(ua) && /Safari/i.test(ua)) return "Safari on iPhone";
  if (/Firefox/i.test(ua)) return "Firefox on Desktop";
  if (/Windows/i.test(ua)) return "Chrome on Windows";
  if (/Linux/i.test(ua)) return "Browser on Linux";
  return "Browser device";
}

export function publicJwkFromWire(publicWire) {
  return JSON.parse(base64UrlToText(publicWire));
}
