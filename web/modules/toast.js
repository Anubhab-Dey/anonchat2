import { els } from "./dom.js";

const lastToasts = new Map();
const DEDUPE_MS = 6000;

export function showToast(message, tone = "info") {
  if (!els.toastLayer) {
    return;
  }

  const key = `${tone}:${message}`;
  const now = Date.now();
  const lastShownAt = lastToasts.get(key) || 0;

  if (now - lastShownAt < DEDUPE_MS) {
    return;
  }

  lastToasts.set(key, now);
  const item = document.createElement("div");
  item.className = `toast ${tone}`.trim();
  item.textContent = message;
  els.toastLayer.appendChild(item);

  setTimeout(() => {
    item.classList.add("leaving");
    setTimeout(() => item.remove(), 220);
  }, 4200);
}
