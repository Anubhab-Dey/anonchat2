import { state } from "./state.js";
import { els, addMessageNode, setPill } from "./dom.js";

export function setIdentity(text, tone = "") {
  setPill(els.identityState, text, tone);
}

export function setCallStatus(text, tone = "") {
  setPill(els.callStatus, text, tone);
}

export function showBanner(text, tone = "warn") {
  if (!els.banner) {
    return;
  }

  els.banner.textContent = text;
  els.banner.className = `app-banner ${tone}`.trim();
  els.banner.hidden = false;
}

export function hideBanner() {
  if (els.banner) {
    els.banner.hidden = true;
  }
}

export function showBlockingScreen(title, text) {
  state.blockingReason = title || "blocked";

  if (!els.blockingScreen) {
    return;
  }

  els.blockingTitle.textContent = title || "Sign in required";
  els.blockingText.textContent = text || "";
  els.blockingScreen.hidden = false;
}

export function hideBlockingScreen() {
  state.blockingReason = "";

  if (els.blockingScreen) {
    els.blockingScreen.hidden = true;
  }
}

export function openNavigation() {
  document.body.classList.add("nav-open");
  if (els.menuBtn) {
    els.menuBtn.setAttribute("aria-expanded", "true");
  }
  if (els.drawerBackdrop) {
    els.drawerBackdrop.hidden = false;
  }
}

export function closeNavigation() {
  document.body.classList.remove("nav-open");
  if (els.menuBtn) {
    els.menuBtn.setAttribute("aria-expanded", "false");
  }
  if (els.drawerBackdrop) {
    els.drawerBackdrop.hidden = true;
  }
}

export function showIncomingCall(session, onAccept, onDecline) {
  if (!els.incomingCallScreen) {
    return;
  }

  els.incomingCallTitle.textContent = "Incoming call";
  els.incomingCallText.textContent = session.call_kind === "room" ?
    `${session.caller_username || "Someone"} is calling this room.` :
    `${session.caller_username || "Someone"} is calling you.`;
  els.acceptCallBtn.onclick = onAccept;
  els.declineCallBtn.onclick = onDecline;
  els.incomingCallScreen.hidden = false;
}

export function hideIncomingCall() {
  if (!els.incomingCallScreen) {
    return;
  }

  els.incomingCallScreen.hidden = true;
  els.acceptCallBtn.onclick = null;
  els.declineCallBtn.onclick = null;
}

export function addSystemMessage(text) {
  addMessageNode(text, "system");
}

export function setRoomHeader(kind, title) {
  if (els.conversationKind) {
    els.conversationKind.textContent = kind;
  }

  if (els.roomTitle) {
    els.roomTitle.textContent = title;
  }
}

export function resizeComposer() {
  if (!els.messageInput) {
    return;
  }

  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(148, els.messageInput.scrollHeight)}px`;
}

export function checkAppEnvironment() {
  if (!window.isSecureContext) {
    showBanner("Camera, microphone, notifications, and device keys need HTTPS or localhost.", "warn");
    return;
  }

  hideBanner();
}
