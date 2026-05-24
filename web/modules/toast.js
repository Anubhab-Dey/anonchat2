import { els } from "./dom.js";

export function showToast(message, tone = "info") {
  if (!els.toastLayer) {
    return;
  }

  const item = document.createElement("div");
  item.className = `toast ${tone}`.trim();
  item.textContent = message;
  els.toastLayer.appendChild(item);

  setTimeout(() => {
    item.classList.add("leaving");
    setTimeout(() => item.remove(), 220);
  }, 4200);
}
