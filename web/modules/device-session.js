import { state, accountKeyForUsername, clearAccountRuntimeState, clearSessionOnly } from "./state.js";
import { dbGet, dbPut, deleteLocalData } from "./local-db.js";
import { enc, textToBase64Url, bytesToBase64Url, base64UrlToText } from "./crypto-box.js";
import { sendAndWait, sendWire, stopReconnect, waitForWire } from "./wire.js";
import { showToast } from "./toast.js";
import { showBlockingScreen, hideBlockingScreen, setIdentity } from "./ui.js";

const SESSION_CHANNEL_NAME = "anonchat-session";
const REFRESH_LOCK_NAME = "anonchat-session-refresh";
const REFRESH_LOCK_KEY = "anonchat.session.refreshLock";
const SESSION_EVENT_KEY = "anonchat.session.event";
const REFRESH_LOCK_TTL_MS = 12000;
const REFRESH_RETRY_BASE_MS = 3000;
const tabId = globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

let sessionChannel = null;
let refreshInFlight = null;
let coordinationStarted = false;
let externalRefreshWaiters = [];

export function initializeSessionCoordination() {
  if (coordinationStarted) {
    return;
  }

  coordinationStarted = true;

  if ("BroadcastChannel" in window) {
    sessionChannel = new BroadcastChannel(SESSION_CHANNEL_NAME);
    sessionChannel.onmessage = (event) => {
      handleSessionMessage(event.data).catch(() => {});
    };
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== SESSION_EVENT_KEY || !event.newValue) {
      return;
    }

    try {
      handleSessionMessage(JSON.parse(event.newValue)).catch(() => {});
    } catch {
      // Ignore malformed same-origin storage events.
    }
  });
}

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
  const nextUsername = parts[3] || "";
  const previousAccount = accountKeyForUsername(state.username || "");
  const nextAccount = accountKeyForUsername(nextUsername);

  if (previousAccount && nextAccount && previousAccount !== nextAccount) {
    clearAccountRuntimeState();
    window.dispatchEvent(new Event("anonchat:account-cleared"));
  }

  state.authenticated = true;
  state.peerId = parts[2];
  state.username = nextUsername;
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
  resetRefreshFailures();
  broadcastSessionRefreshed();
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

  if (refreshInFlight) {
    return refreshInFlight;
  }

  const snapshot = sessionSnapshot();
  state.sessionRefresh.inProgress = true;
  refreshInFlight = withSessionRefreshLock(snapshot, async () => {
    if (await adoptStoredSessionIfChanged(snapshot)) {
      return true;
    }

    return performSessionRefresh(snapshot);
  }).finally(() => {
    state.sessionRefresh.inProgress = false;
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function performSessionRefresh(snapshot) {
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
      return handleRefreshRejection(nonceReply.parts[2] || "transient", snapshot);
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
      return handleRefreshRejection(parts[2] || "transient", snapshot);
    }

    await applySessionRefresh({
      username: state.username,
      deviceId: state.session.deviceId,
      sessionId: parts[2],
      sessionToken: parts[3],
      expiresAt: Number(parts[4] || 0),
    });
    showToast("Session refreshed", "success");
    return true;
  } catch {
    return handleTransientRefreshFailure();
  }
}

async function withSessionRefreshLock(snapshot, task) {
  if (navigator.locks && navigator.locks.request) {
    return navigator.locks.request(REFRESH_LOCK_NAME, async () => {
      if (await adoptStoredSessionIfChanged(snapshot)) {
        return true;
      }

      return task();
    });
  }

  if (!acquireLocalRefreshLock()) {
    if (await waitForExternalSessionRefresh(snapshot, 5000)) {
      return true;
    }

    if (await adoptStoredSessionIfChanged(snapshot)) {
      return true;
    }

    return handleTransientRefreshFailure();
  }

  try {
    return await task();
  } finally {
    releaseLocalRefreshLock();
  }
}

async function handleRefreshRejection(reason, snapshot) {
  if (reason === "invalid") {
    if (await waitForExternalSessionRefresh(snapshot, 1500)) {
      return true;
    }

    if (await adoptStoredSessionIfChanged(snapshot)) {
      return true;
    }

    return confirmSessionInvalid("invalid");
  }

  if (reason === "expired" || reason === "revoked") {
    return confirmSessionInvalid(reason);
  }

  return handleTransientRefreshFailure();
}

async function handleTransientRefreshFailure() {
  const now = Date.now();
  state.sessionRefresh.failureCount++;
  state.sessionRefresh.lastFailureAt = now;
  setIdentity(state.username ? `${state.username} reconnecting` : "Reconnecting", "warn");

  if (state.sessionRefresh.failureCount === 1) {
    showToast("Reconnecting securely...", "info");
  }

  clearTimeout(state.sessionRefresh.retryTimer);
  const delay = Math.min(30000, REFRESH_RETRY_BASE_MS * state.sessionRefresh.failureCount);
  state.sessionRefresh.retryTimer = setTimeout(() => {
    refreshSession().catch(() => {});
  }, delay);
  return false;
}

export async function confirmSessionInvalid(reason = "invalid") {
  await dbPut("settings", {
    key: "session",
    username: state.username,
    deviceId: state.session.deviceId,
    sessionId: "",
    sessionToken: "",
    expiresAt: 0,
    backupVersion: state.session.backupVersion,
    invalidReason: reason,
  }).catch(() => {});
  clearSessionOnly();
  window.dispatchEvent(new Event("anonchat:account-cleared"));
  setIdentity("Sign in needed", "warn");
  showToast("Please sign in again", "warning");
  showBlockingScreen("Sign in needed", "Your chats are still saved here. Sign in to keep using this device.");
  return false;
}

export async function handleSessionRejected() {
  if (!state.session.sessionId || !state.session.sessionToken) {
    return confirmSessionInvalid("invalid");
  }

  const refreshed = await refreshSession();

  if (refreshed) {
    showToast("Reconnected securely", "success");
    return true;
  }

  if (state.session.sessionId && state.session.sessionToken) {
    showToast("Reconnecting securely...", "info");
    return false;
  }

  return false;
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

function sessionSnapshot() {
  return {
    username: state.username,
    deviceId: state.session.deviceId,
    sessionId: state.session.sessionId,
    sessionToken: state.session.sessionToken,
    expiresAt: state.session.expiresAt,
  };
}

async function applySessionRefresh(payload, options = {}) {
  if (!payload || !payload.sessionId || !payload.sessionToken) {
    return false;
  }

  if (options.fromPeer && !state.session.sessionId) {
    return false;
  }

  if (state.session.sessionId && payload.sessionId !== state.session.sessionId) {
    return false;
  }

  if (state.session.deviceId && payload.deviceId && payload.deviceId !== state.session.deviceId) {
    return false;
  }

  if (state.username && payload.username && payload.username !== state.username) {
    return false;
  }

  state.authenticated = true;
  state.username = payload.username || state.username;
  state.session.deviceId = payload.deviceId || state.session.deviceId;
  state.session.sessionId = payload.sessionId;
  state.session.sessionToken = payload.sessionToken;
  state.session.expiresAt = Number(payload.expiresAt || 0);

  await persistSessionSettings();
  resetRefreshFailures();
  hideBlockingScreen();
  setIdentity(state.username, "good");
  scheduleSessionRefresh();

  if (!options.fromPeer) {
    broadcastSessionRefreshed();
  }

  window.dispatchEvent(new Event("anonchat:session-refreshed"));
  return true;
}

async function persistSessionSettings() {
  await dbPut("settings", {
    key: "session",
    username: state.username,
    deviceId: state.session.deviceId,
    sessionId: state.session.sessionId,
    sessionToken: state.session.sessionToken,
    expiresAt: state.session.expiresAt,
    backupVersion: state.session.backupVersion,
  });
}

function resetRefreshFailures() {
  clearTimeout(state.sessionRefresh.retryTimer);
  state.sessionRefresh.inProgress = false;
  state.sessionRefresh.failureCount = 0;
  state.sessionRefresh.lastFailureAt = 0;
  state.sessionRefresh.retryTimer = null;
}

function broadcastSessionRefreshed() {
  const message = {
    type: "session_refreshed",
    source: tabId,
    username: state.username,
    deviceId: state.session.deviceId,
    sessionId: state.session.sessionId,
    sessionToken: state.session.sessionToken,
    expiresAt: state.session.expiresAt,
    at: Date.now(),
  };

  if (sessionChannel) {
    sessionChannel.postMessage(message);
  }

  try {
    localStorage.setItem(SESSION_EVENT_KEY, JSON.stringify(message));
    setTimeout(() => {
      if (localStorage.getItem(SESSION_EVENT_KEY)) {
        localStorage.removeItem(SESSION_EVENT_KEY);
      }
    }, 1000);
  } catch {
    // BroadcastChannel is preferred; storage is only a fallback.
  }
}

async function handleSessionMessage(message) {
  if (!message ||
      message.source === tabId ||
      message.type !== "session_refreshed") {
    return;
  }

  const applied = await applySessionRefresh(message, { fromPeer: true });

  if (applied) {
    resolveExternalRefreshWaiters(message);
  }
}

function waitForExternalSessionRefresh(snapshot, timeoutMs) {
  if (!snapshot || !snapshot.sessionId) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const waiter = {
      snapshot,
      resolve,
      timer: setTimeout(() => {
        externalRefreshWaiters = externalRefreshWaiters.filter((item) => item !== waiter);
        resolve(false);
      }, timeoutMs),
    };
    externalRefreshWaiters.push(waiter);
  });
}

function resolveExternalRefreshWaiters(message) {
  for (const waiter of [...externalRefreshWaiters]) {
    if (!sameSession(waiter.snapshot, message)) {
      continue;
    }

    clearTimeout(waiter.timer);
    externalRefreshWaiters = externalRefreshWaiters.filter((item) => item !== waiter);
    waiter.resolve(true);
  }
}

async function adoptStoredSessionIfChanged(snapshot) {
  const saved = await dbGet("settings", "session");

  if (!saved ||
      !sameSession(snapshot, saved) ||
      !saved.sessionToken ||
      (saved.sessionToken === snapshot.sessionToken &&
       Number(saved.expiresAt || 0) <= Number(snapshot.expiresAt || 0))) {
    return false;
  }

  return applySessionRefresh({
    username: saved.username,
    deviceId: saved.deviceId,
    sessionId: saved.sessionId,
    sessionToken: saved.sessionToken,
    expiresAt: saved.expiresAt,
  }, { fromPeer: true });
}

function sameSession(left, right) {
  return Boolean(
    left &&
    right &&
    left.sessionId &&
    right.sessionId === left.sessionId &&
    (!left.deviceId || !right.deviceId || right.deviceId === left.deviceId) &&
    (!left.username || !right.username || right.username === left.username)
  );
}

function acquireLocalRefreshLock() {
  const now = Date.now();

  try {
    const current = JSON.parse(localStorage.getItem(REFRESH_LOCK_KEY) || "null");

    if (current && current.owner !== tabId && Number(current.expiresAt || 0) > now) {
      return false;
    }

    localStorage.setItem(REFRESH_LOCK_KEY, JSON.stringify({
      owner: tabId,
      expiresAt: now + REFRESH_LOCK_TTL_MS,
    }));

    const saved = JSON.parse(localStorage.getItem(REFRESH_LOCK_KEY) || "null");
    return saved && saved.owner === tabId;
  } catch {
    return true;
  }
}

function releaseLocalRefreshLock() {
  try {
    const current = JSON.parse(localStorage.getItem(REFRESH_LOCK_KEY) || "null");

    if (current && current.owner === tabId) {
      localStorage.removeItem(REFRESH_LOCK_KEY);
    }
  } catch {
    // Lock release failure only affects refresh coordination; expiry clears it.
  }
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
  window.dispatchEvent(new Event("anonchat:account-cleared"));
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
