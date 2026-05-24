import { state } from "./state.js";
import { exportBackupData, importBackupData, dbPut } from "./local-db.js";
import { derivePbkdf2Key, encryptJson, decryptJson } from "./crypto-box.js";
import { sendWire, waitForWire } from "./wire.js";
import { showToast } from "./toast.js";

export async function afterAuthBackupRestore() {
  if (!state.authenticated || !state.lastPassword) {
    return;
  }

  sendWire("BACKUP_GET");

  try {
    const { parts } = await waitForWire(
      (candidate) => candidate[0] === "BACKUP" || (candidate[0] === "ERR" && candidate[1] === "backup_missing"),
      8000
    );

    if (parts[0] === "ERR") {
      showToast("Signed in", "success");
      return;
    }

    const version = Number(parts[1] || 0);
    const ciphertext = parts[3];
    const key = await backupKey();
    const bundle = await decryptJson(key, ciphertext);
    await importBackupData(bundle);
    state.session.backupVersion = Math.max(state.session.backupVersion, version);
    await persistBackupSettings(false);
    showToast("Chats restored", "success");
    window.dispatchEvent(new Event("anonchat:backup-imported"));
  } catch {
    showToast("Backup restore skipped", "warning");
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
  if (!state.authenticated || !state.backupDirty || state.backupBusy || !state.lastPassword) {
    return;
  }

  state.backupBusy = true;

  try {
    const bundle = await exportBackupData(state.username);
    const key = await backupKey();
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
    showToast("Backup saved", "success");
  } catch {
    state.backupDirty = true;
    await persistBackupSettings(true);
  } finally {
    state.backupBusy = false;
  }
}

async function backupKey() {
  return derivePbkdf2Key(state.lastPassword, `anonchat-backup:${state.username.toLowerCase()}`);
}

async function persistBackupSettings(dirty) {
  await dbPut("settings", {
    key: "backup",
    version: state.session.backupVersion,
    dirty,
  });
}
