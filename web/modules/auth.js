import { state, cleanUsername } from "./state.js";
import { els } from "./dom.js";
import { bytesToBase64Url, deriveBits, hasWebCrypto } from "./crypto-box.js";
import { sendHello, storeSessionFromAuth } from "./device-session.js";
import { sendWire, waitForWire } from "./wire.js";
import { showToast } from "./toast.js";
import { afterAuthBackupRestore, deriveAndStoreBackupKey } from "./backup.js";
import { setupDirectIdentity } from "./direct.js";
import { showBanner } from "./ui.js";

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

  await storeSessionFromAuth(parts);
  await deriveAndStoreBackupKey(username, password);
  await setupDirectIdentity();
  await afterAuthBackupRestore();
  showToast("Ready", "success");
}

export function logoutLocalOnly() {
  state.authenticated = false;
  state.session.sessionId = "";
  state.session.sessionToken = "";
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
