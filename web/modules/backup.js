import { state, accountKeyForUsername, accountSettingKey, currentAccountKey } from "./state.js";
import { exportBackupData, importBackupData, dbGet, dbPut } from "./local-db.js";
import { deriveBits, bytesToBase64Url, base64UrlToBytes, encryptJson, decryptJson } from "./crypto-box.js";
import { sendWire, waitForWire } from "./wire.js";
import { showToast } from "./toast.js";

export async function afterAuthBackupRestore() {
  if (!state.authenticated) {
    return;
  }

  const key = await backupKey();

  if (!key) {
    showToast("Backup locked. Sign in again with password to sync.", "warning");
    return;
  }

  sendWire("BACKUP_GET");

  try {
    const { parts } = await waitForWire(
      (candidate) => candidate[0] === "BACKUP" || (candidate[0] === "ERR" && candidate[1] === "backup_missing"),
      8000
    );

    if (parts[0] === "ERR") {
      showToast("Ready", "success");
      return;
    }

    const version = Number(parts[1] || 0);
    const ciphertext = parts[3];
    const bundle = await decryptJson(key, ciphertext);
    await importBackupData(bundle);
    state.session.backupVersion = Math.max(state.session.backupVersion, version);
    await persistBackupSettings(false);
    showToast("Chats restored", "success");
    window.dispatchEvent(new Event("anonchat:backup-imported"));
  } catch {
    showToast("Chats on this device are ready", "warning");
  }
}

export function markBackupDirty() {
  state.backupDirty = true;

  if (!state.authenticated) {
    persistBackupSettings(true).catch(() => {});
    return;
  }

  clearTimeout(state.backupTimer);
  state.backupTimer = setTimeout(uploadBackupIfDirty, 2000);
}

export async function uploadBackupIfDirty() {
  if (!state.authenticated || !state.backupDirty || state.backupBusy) {
    return;
  }

  const key = await backupKey();

  if (!key) {
    state.backupDirty = true;
    state.backupLocked = true;
    await persistBackupSettings(true);
    showToast("Backup locked. Sign in again with password to sync.", "warning");
    return;
  }

  state.backupBusy = true;

  try {
    const bundle = await exportBackupData(state.username);
    const ciphertext = await encryptJson(key, bundle);
    const nextVersion = Math.max(1, Number(state.session.backupVersion || 0) + 1);
    sendWire(`BACKUP_PUT|${nextVersion}|${bundle.client_created_at}|${ciphertext}`);
    const { parts } = await waitForWire(
      (candidate) =>
        (candidate[0] === "OK" && candidate[1] === "backup_put") ||
        (candidate[0] === "ERR" && candidate[1] === "backup_put"),
      10000
    );

    if (parts[0] !== "OK") {
      throw new Error("backup rejected");
    }

    state.session.backupVersion = Number(parts[2] || nextVersion);
    state.backupDirty = false;
    await persistBackupSettings(false);
    showToast("Chats saved", "success");
  } catch {
    state.backupDirty = true;
    await persistBackupSettings(true);
  } finally {
    state.backupBusy = false;
  }
}

export async function deriveAndStoreBackupKey(username, password) {
  const accountKey = accountKeyForUsername(username);
  const bits = await deriveBits(password, `anonchat-backup:${accountKey}`);
  const key = await importBackupKey(bits);
  state.backupKey = key;
  state.backupLocked = false;
  await dbPut("settings", {
    key: accountSettingKey("backup_key", accountKey),
    account_key: accountKey,
    alg: "PBKDF2-SHA256-AESGCM-256",
    bits: bytesToBase64Url(bits),
    updatedAt: Date.now(),
  });
  return key;
}

async function backupKey() {
  if (state.backupKey) {
    return state.backupKey;
  }

  const saved = await loadStoredBackupKey();

  if (saved) {
    state.backupKey = saved;
    state.backupLocked = false;
    return saved;
  }

  state.backupLocked = true;
  return null;
}

async function loadStoredBackupKey() {
  const accountKey = currentAccountKey();

  if (!accountKey) {
    return null;
  }

  const saved = await dbGet("settings", accountSettingKey("backup_key", accountKey));

  if (!saved || saved.account_key !== accountKey || !saved.bits) {
    return null;
  }

  return importBackupKey(base64UrlToBytes(saved.bits));
}

async function importBackupKey(bits) {
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function persistBackupSettings(dirty) {
  const accountKey = currentAccountKey();

  if (!accountKey) {
    return;
  }

  await dbPut("settings", {
    key: accountSettingKey("backup", accountKey),
    account_key: accountKey,
    version: state.session.backupVersion,
    dirty,
  });
}
