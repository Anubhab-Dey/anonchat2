import { state } from "./state.js";
import { els, setPill } from "./dom.js";
import { dbGet, dbPut } from "./local-db.js";
import { showToast } from "./toast.js";

export function isStandalonePwa() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

export async function loadNotificationSetting() {
  const saved = await dbGet("settings", "notifications");
  state.notificationsEnabled = Boolean(saved && saved.enabled && "Notification" in window && Notification.permission === "granted");
  updateNotificationButton();
}

export function updateNotificationButton() {
  if (!els.notificationBtn) {
    return;
  }

  if (!("Notification" in window)) {
    els.notificationBtn.textContent = "No notify";
    els.notificationBtn.disabled = true;
    return;
  }

  if (!isStandalonePwa()) {
    els.notificationBtn.textContent = "Install PWA";
    els.notificationBtn.disabled = false;
    return;
  }

  els.notificationBtn.disabled = false;
  els.notificationBtn.textContent = state.notificationsEnabled ? "Notify on" : "Notify";
}

export async function toggleNotifications() {
  if (!("Notification" in window)) {
    showToast("Notifications unavailable", "warning");
    return;
  }

  if (!isStandalonePwa()) {
    showToast("Install the PWA before enabling Android notifications", "warning");
    return;
  }

  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      state.notificationsEnabled = false;
      await dbPut("settings", { key: "notifications", enabled: false });
      updateNotificationButton();
      showToast("Notifications blocked", "warning");
      return;
    }
  }

  state.notificationsEnabled = !state.notificationsEnabled;
  await dbPut("settings", { key: "notifications", enabled: state.notificationsEnabled });
  updateNotificationButton();
  showToast(state.notificationsEnabled ? "Notifications enabled" : "Notifications disabled", "success");
}

export async function notifyIfSubscribed(title, body, tag) {
  if (!state.notificationsEnabled ||
      !isStandalonePwa() ||
      !("Notification" in window) ||
      Notification.permission !== "granted" ||
      document.visibilityState === "visible") {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, {
      body,
      tag,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: "/" },
    });
  } catch {
    showToast("Notifications unavailable", "warning");
  }
}

export async function requestStoragePersistence() {
  if (!navigator.storage || !navigator.storage.persist) {
    setPill(els.storageState, "local");
    return;
  }

  try {
    const persisted = await navigator.storage.persisted();
    const granted = persisted || await navigator.storage.persist();
    setPill(els.storageState, granted ? "persistent" : "local", granted ? "good" : "warn");
  } catch {
    setPill(els.storageState, "local");
  }
}
