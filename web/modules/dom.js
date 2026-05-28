export const els = {
  menuBtn: document.getElementById("menuBtn"),
  closeMenuBtn: document.getElementById("closeMenuBtn"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  navigationDrawer: document.getElementById("navigationDrawer"),
  topbarStatus: document.getElementById("topbarStatus"),
  status: document.getElementById("status"),
  identityState: document.getElementById("identityState"),
  connectBtn: document.getElementById("connectBtn"),
  signupBtn: document.getElementById("signupBtn"),
  loginBtn: document.getElementById("loginBtn"),
  quickChatBtn: document.getElementById("quickChatBtn"),
  quickRoomBtn: document.getElementById("quickRoomBtn"),
  newRoomBtn: document.getElementById("newRoomBtn"),
  joinBtn: document.getElementById("joinBtn"),
  copyInviteBtn: document.getElementById("copyInviteBtn"),
  startCallBtn: document.getElementById("startCallBtn"),
  stopCallBtn: document.getElementById("stopCallBtn"),
  attachBtn: document.getElementById("attachBtn"),
  sendFileBtn: document.getElementById("sendFileBtn"),
  startDmBtn: document.getElementById("startDmBtn"),
  directCallBtn: document.getElementById("directCallBtn"),
  notificationBtn: document.getElementById("notificationBtn"),
  installBtn: document.getElementById("installBtn"),
  signOutBtn: document.getElementById("signOutBtn"),
  clearDeviceMenuBtn: document.getElementById("clearDeviceMenuBtn"),
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  directUsername: document.getElementById("directUsername"),
  room: document.getElementById("room"),
  roomKey: document.getElementById("roomKey"),
  roomAdvanced: document.getElementById("roomAdvanced"),
  inviteLink: document.getElementById("inviteLink"),
  peerCount: document.getElementById("peerCount"),
  storageState: document.getElementById("storageState"),
  conversations: document.getElementById("conversations"),
  conversationKind: document.getElementById("conversationKind"),
  roomTitle: document.getElementById("roomTitle"),
  messageForm: document.getElementById("messageForm"),
  messageInput: document.getElementById("messageInput"),
  messages: document.getElementById("messages"),
  peers: document.getElementById("peers"),
  fileInput: document.getElementById("fileInput"),
  selectedFile: document.getElementById("selectedFile"),
  files: document.getElementById("files"),
  callStatus: document.getElementById("callStatus"),
  micMuteBtn: document.getElementById("micMuteBtn"),
  cameraToggleBtn: document.getElementById("cameraToggleBtn"),
  pipCallBtn: document.getElementById("pipCallBtn"),
  localVideo: document.getElementById("localVideo"),
  remoteVideos: document.getElementById("remoteVideos"),
  toastLayer: document.getElementById("toastLayer"),
  blockingScreen: document.getElementById("blockingScreen"),
  blockingTitle: document.getElementById("blockingTitle"),
  blockingText: document.getElementById("blockingText"),
  clearDeviceBtn: document.getElementById("clearDeviceBtn"),
  signInAgainBtn: document.getElementById("signInAgainBtn"),
  incomingCallScreen: document.getElementById("incomingCallScreen"),
  incomingCallTitle: document.getElementById("incomingCallTitle"),
  incomingCallText: document.getElementById("incomingCallText"),
  acceptCallBtn: document.getElementById("acceptCallBtn"),
  declineCallBtn: document.getElementById("declineCallBtn"),
  banner: document.getElementById("appBanner"),
};

export function setPill(el, text, tone = "") {
  if (!el) {
    return;
  }

  el.textContent = text;
  el.className = `pill ${tone}`.trim();
}

export function setText(el, text) {
  if (el) {
    el.textContent = text;
  }
}

export function addMessageNode(text, className = "", meta = "") {
  const item = document.createElement("div");
  item.className = `message ${className}`.trim();

  if (meta) {
    const metaEl = document.createElement("span");
    metaEl.className = "message-meta";
    metaEl.textContent = meta;
    item.appendChild(metaEl);
  }

  item.append(document.createTextNode(text));
  els.messages.appendChild(item);
  els.messages.scrollTop = els.messages.scrollHeight;
}

export function clearMessages() {
  els.messages.textContent = "";
}
