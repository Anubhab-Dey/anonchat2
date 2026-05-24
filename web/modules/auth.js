import { state, cleanUsername } from "./state.js";
import { els } from "./dom.js";
import { bytesToBase64Url, deriveBits, textToBase64 } from "./crypto-box.js";
import { sendHello, storeSessionFromAuth } from "./device-session.js";
import { sendWire, waitForWire } from "./wire.js";
import { showToast } from "./toast.js";
import { afterAuthBackupRestore } from "./backup.js";
import { setupDirectIdentity } from "./direct.js";

export async function signup() {
  const username = cleanUsername(els.username.value);
  const password = els.password.value;

  if (!username || !password) {
    showToast("Username and password required", "warning");
    return;
  }

  if (password.length < 12) {
    showToast("Use at least 12 characters", "warning");
    return;
  }

  await authenticate("SIGNUP", username, password);
}

export async function login() {
  const username = cleanUsername(els.username.value);
  const password = els.password.value;

  if (!username || !password) {
    showToast("Username and password required", "warning");
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
    showToast("Sign in failed", "error");
    return;
  }

  await storeSessionFromAuth(parts);
  await setupDirectIdentity();
  await afterAuthBackupRestore();
  showToast("Signed in", "success");
}

export function logoutLocalOnly() {
  state.authenticated = false;
  state.session.sessionId = "";
  state.session.sessionToken = "";
  showToast("Signed out locally", "info");
}

async function deriveAuthField(username, password) {
  if (!window.crypto || !crypto.subtle) {
    return textToBase64(password);
  }

  const proof = await deriveBits(password, `anonchat-account:${username.toLowerCase()}`);
  return `v2.${bytesToBase64Url(proof)}`;
}
