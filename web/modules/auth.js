import { state, accountKeyForUsername, cleanUsername, clearSessionOnly } from "./state.js";
import { els } from "./dom.js";
import { bytesToBase64Url, deriveBits, hasWebCrypto } from "./crypto-box.js";
import { sendHello, storeSessionFromAuth } from "./device-session.js";
import { sendWire, waitForWire } from "./wire.js";
import { showToast } from "./toast.js";
import { afterAuthBackupRestore, deriveAndStoreBackupKey } from "./backup.js";
import { setupDirectIdentity } from "./direct.js";
import { showBanner } from "./ui.js";
import { loadConversations, resetConversationUi } from "./conversations.js";
import { dbPut, migrateUnscopedLocalData } from "./local-db.js";

export async function signup() {
  const username = cleanUsername(els.username.value);
  const password = els.password.value;

  if (!username || !password) {
    showToast("Enter a username and password", "warning");
    return;
  }

  if (password.length < 12) {
    showToast("Use a longer password", "warning");
    return;
  }

  await authenticate("SIGNUP", username, password);
}

export async function login() {
  const username = cleanUsername(els.username.value);
  const password = els.password.value;

  if (!username || !password) {
    showToast("Enter your username and password", "warning");
    return;
  }

  await authenticate("LOGIN", username, password);
}

export async function authenticate(command, username, password) {
  state.lastPassword = password;
  await sendHello();
  const authField = await deriveAuthField(username, password);
  sendWire(`${command}|${username}|${authField}`);
  const { parts } = await waitForWire(
    (candidate) =>
      (candidate[0] === "OK" && candidate[1] === "auth") ||
      (candidate[0] === "ERR" && (candidate[1] === "login" || candidate[1] === "signup" || candidate[1] === "auth")),
    10000
  );

  if (parts[0] !== "OK") {
    showToast("Could not sign in", "error");
    return;
  }

  const previousLocalUsername = localStorage.getItem("anonchat.username") || "";
  await storeSessionFromAuth(parts);
  await deriveAndStoreBackupKey(username, password);
  if (accountKeyForUsername(previousLocalUsername) === accountKeyForUsername(username)) {
    await migrateUnscopedLocalData(accountKeyForUsername(username));
  }
  await setupDirectIdentity();
  await afterAuthBackupRestore();
  await loadConversations();
  showToast("Ready", "success");
}

export function logoutLocalOnly() {
  dbPut("settings", {
    key: "session",
    username: state.username,
    deviceId: state.session.deviceId,
    sessionId: "",
    sessionToken: "",
    expiresAt: 0,
    backupVersion: state.session.backupVersion,
  }).catch(() => {});
  clearSessionOnly();
  resetConversationUi();
  showToast("Signed out locally", "info");
}

async function deriveAuthField(username, password) {
  if (!hasWebCrypto()) {
    const message = "HTTPS or localhost is required for secure login/signup.";
    showToast(message, "error");
    showBanner(message, "warn");
    throw new Error("secure auth unavailable");
  }

  const proof = await deriveBits(password, `anonchat-account:${username.toLowerCase()}`);
  return `v2.${bytesToBase64Url(proof)}`;
}
