const enc = new TextEncoder();
const dec = new TextDecoder();

const els = {
  status: document.getElementById("status"),
  identityState: document.getElementById("identityState"),
  connectBtn: document.getElementById("connectBtn"),
  signupBtn: document.getElementById("signupBtn"),
  loginBtn: document.getElementById("loginBtn"),
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
  username: document.getElementById("username"),
  password: document.getElementById("password"),
  directUsername: document.getElementById("directUsername"),
  room: document.getElementById("room"),
  roomKey: document.getElementById("roomKey"),
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
  localVideo: document.getElementById("localVideo"),
  remoteVideos: document.getElementById("remoteVideos"),
};

const appConfig = window.ANONCHAT_CONFIG || { iceServers: [] };

const state = {
  ws: null,
  authenticated: false,
  peerId: "",
  username: "",
  room: "",
  roomKey: null,
  roomKeys: null,
  pendingRoomSecret: "",
  activeConversationId: "",
  conversations: new Map(),
  db: null,
  identity: null,
  directPeers: new Map(),
  directPeerIds: new Map(),
  directWaiters: new Map(),
  notificationsEnabled: false,
  peers: new Map(),
  pcs: new Map(),
  channels: new Map(),
  localStream: null,
  incomingFiles: new Map(),
  wireQueue: [],
  reconnectTimer: null,
  reconnectAttempts: 0,
};

const LOCAL_DB_NAME = "anonchat-local-v1";
const LOCAL_DB_VERSION = 1;

function cleanUsername(text) {
  return text.trim().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32);
}

function roomConversationId(room) {
  return `room:${room}`;
}

function directConversationId(username) {
  return `dm:${cleanUsername(username).toLowerCase()}`;
}

function openLocalDb() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("conversations")) {
        db.createObjectStore("conversations", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("byConversation", "conversationId");
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function dbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbStore(name, mode = "readonly") {
  if (!state.db) {
    return null;
  }

  return state.db.transaction(name, mode).objectStore(name);
}

async function dbPut(name, value) {
  const store = dbStore(name, "readwrite");

  if (!store) {
    return;
  }

  await dbRequest(store.put(value));
}

async function dbGet(name, key) {
  const store = dbStore(name);
  return store ? dbRequest(store.get(key)) : null;
}

async function dbGetAll(name) {
  const store = dbStore(name);
  return store ? dbRequest(store.getAll()) : [];
}

async function dbGetConversationMessages(conversationId) {
  const store = dbStore("messages");

  if (!store) {
    return [];
  }

  const index = store.index("byConversation");
  const messages = await dbRequest(index.getAll(IDBKeyRange.only(conversationId)));
  return messages.sort((a, b) => a.at - b.at);
}

async function requestStoragePersistence() {
  if (!navigator.storage || !navigator.storage.persist) {
    setStorageState("local");
    return;
  }

  try {
    const persisted = await navigator.storage.persisted();
    const granted = persisted || await navigator.storage.persist();
    setStorageState(granted ? "persistent" : "local", granted ? "good" : "warn");
  } catch {
    setStorageState("local");
  }
}

function isStandalonePwa() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

async function loadNotificationSetting() {
  const saved = await dbGet("settings", "notifications");
  state.notificationsEnabled = Boolean(saved && saved.enabled && "Notification" in window && Notification.permission === "granted");
  updateNotificationButton();
}

function updateNotificationButton() {
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

async function toggleNotifications() {
  if (!("Notification" in window)) {
    addSystemMessage("notifications are not available here");
    return;
  }

  if (!isStandalonePwa()) {
    addSystemMessage("install the PWA before enabling Android notifications");
    return;
  }

  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      state.notificationsEnabled = false;
      await dbPut("settings", { key: "notifications", enabled: false });
      updateNotificationButton();
      addSystemMessage("notifications were not allowed");
      return;
    }
  }

  state.notificationsEnabled = !state.notificationsEnabled;
  await dbPut("settings", { key: "notifications", enabled: state.notificationsEnabled });
  updateNotificationButton();
  addSystemMessage(state.notificationsEnabled ? "PWA notifications enabled" : "PWA notifications disabled");
}

async function notifyIfSubscribed(title, body, tag) {
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
    // Notification failure should not disturb chat or calls.
  }
}

function setStorageState(text, tone = "") {
  if (!els.storageState) {
    return;
  }

  els.storageState.textContent = text;
  els.storageState.className = `pill ${tone}`.trim();
}

function wsUrl() {
  if (location.protocol === "http:" || location.protocol === "https:") {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  return "ws://127.0.0.1:8080/ws";
}

function setStatus(text, tone = "") {
  els.status.textContent = text;
  els.status.className = tone;
}

function setIdentity(text, tone = "") {
  els.identityState.textContent = text;
  els.identityState.className = `pill ${tone}`.trim();
}

function setCallStatus(text, tone = "") {
  els.callStatus.textContent = text;
  els.callStatus.className = `pill ${tone}`.trim();
}

function addMessage(text, className = "", meta = "") {
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

function addSystemMessage(text) {
  addMessage(text, "system");
}

function activeConversation() {
  return state.conversations.get(state.activeConversationId) || null;
}

async function loadConversations() {
  const conversations = await dbGetAll("conversations");
  state.conversations.clear();

  for (const conversation of conversations) {
    state.conversations.set(conversation.id, conversation);
  }

  renderConversations();
}

async function upsertConversation(next) {
  const current = state.conversations.get(next.id) || {};
  const conversation = {
    ...current,
    ...next,
    updatedAt: next.updatedAt || current.updatedAt || Date.now(),
  };

  state.conversations.set(conversation.id, conversation);
  await dbPut("conversations", conversation);
  renderConversations();
  return conversation;
}

async function persistMessage(conversationId, message) {
  const conversation = state.conversations.get(conversationId);

  if (!conversation) {
    return;
  }

  const at = message.at || Date.now();
  const record = {
    id: message.id || crypto.randomUUID(),
    conversationId,
    at,
    direction: message.direction,
    sender: message.sender,
    text: message.text,
  };

  await dbPut("messages", record);
  conversation.preview = message.text;
  conversation.updatedAt = at;
  await upsertConversation(conversation);
}

function renderConversations() {
  els.conversations.textContent = "";
  const conversations = [...state.conversations.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  for (const conversation of conversations) {
    const item = document.createElement("div");
    item.className = `conversation-item ${conversation.id === state.activeConversationId ? "active" : ""}`.trim();

    const main = document.createElement("button");
    main.type = "button";
    main.className = "conversation-main";
    main.onclick = () => openConversation(conversation.id);

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.title || conversation.room || conversation.username || conversation.id;

    const preview = document.createElement("span");
    preview.className = "conversation-preview";
    preview.textContent = conversation.preview || (conversation.kind === "dm" ? "direct message" : "room");

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "conversation-edit quiet-button";
    edit.title = "Rename";
    edit.textContent = "Edit";
    edit.onclick = () => renameConversation(conversation.id);

    main.appendChild(title);
    main.appendChild(preview);
    item.appendChild(main);
    item.appendChild(edit);
    els.conversations.appendChild(item);
  }

  if (conversations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "conversation-item";
    empty.innerHTML = "<span class=\"conversation-preview\">No saved conversations yet</span>";
    els.conversations.appendChild(empty);
  }
}

async function renameConversation(conversationId) {
  const conversation = state.conversations.get(conversationId);

  if (!conversation) {
    return;
  }

  const title = prompt("Conversation name", conversation.title || conversation.room || conversation.username || "");

  if (!title || !title.trim()) {
    return;
  }

  await upsertConversation({ ...conversation, title: title.trim(), updatedAt: Date.now() });

  if (state.activeConversationId === conversationId) {
    setActiveConversationHeader(state.conversations.get(conversationId));
  }
}

function setActiveConversationHeader(conversation) {
  if (!conversation) {
    els.conversationKind.textContent = "Current room";
    els.roomTitle.textContent = "No room joined";
    return;
  }

  els.conversationKind.textContent = conversation.kind === "dm" ? "Direct message" : "Room";
  els.roomTitle.textContent = conversation.title || conversation.room || conversation.username || conversation.id;
}

async function openConversation(conversationId, options = {}) {
  const conversation = state.conversations.get(conversationId) || await dbGet("conversations", conversationId);

  if (!conversation) {
    return;
  }

  state.conversations.set(conversation.id, conversation);
  state.activeConversationId = conversation.id;
  setActiveConversationHeader(conversation);
  renderConversations();
  await renderConversationHistory(conversation.id);

  if (conversation.kind === "room") {
    els.room.value = conversation.room;
    els.roomKey.value = conversation.roomKey || "";
    updateInvite();

    if (options.join && state.authenticated && conversation.roomKey) {
      await joinRoom();
    }
  }

  if (conversation.kind === "dm") {
    els.directUsername.value = conversation.username;
  }
}

async function renderConversationHistory(conversationId) {
  els.messages.textContent = "";
  const messages = await dbGetConversationMessages(conversationId);

  for (const message of messages) {
    addMessage(
      message.text,
      message.direction === "out" ? "local" : "",
      message.sender || ""
    );
  }
}

function hasRoomCrypto() {
  return Boolean(window.crypto && crypto.getRandomValues && crypto.subtle);
}

function explainCryptoProblem() {
  if (!hasRoomCrypto()) {
    addSystemMessage("room keys need HTTPS or localhost; this browser blocks WebCrypto on insecure LAN HTTP");
    return true;
  }

  return false;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;

  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return btoa(binary);
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return base64ToBytes(padded);
}

function textToBase64(text) {
  return bytesToBase64(enc.encode(text));
}

function base64ToText(text) {
  return dec.decode(base64ToBytes(text));
}

function textToBase64Url(text) {
  return bytesToBase64Url(enc.encode(text));
}

function base64UrlToText(text) {
  return dec.decode(base64UrlToBytes(text));
}

function randomKey(byteCount = 24) {
  if (!window.crypto || !crypto.getRandomValues) {
    addSystemMessage("secure random generation is unavailable in this browser context");
    return "";
  }

  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteCount)));
}

function cleanRoomName(text) {
  return text.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64);
}

function roomInviteUrl() {
  const room = cleanRoomName(els.room.value || "lobby");
  const key = els.roomKey.value;
  const params = new URLSearchParams();
  params.set("room", room);

  if (key) {
    params.set("key", key);
  }

  return `${location.origin}${location.pathname}#${params.toString()}`;
}

function updateInvite() {
  els.inviteLink.value = roomInviteUrl();
}

function loadInitialInputs() {
  const params = new URLSearchParams(location.hash.slice(1));
  const invitedRoom = params.get("room");
  const invitedKey = params.get("key");
  const savedUsername = localStorage.getItem("anonchat.username");
  const savedRoom = localStorage.getItem("anonchat.room");

  if (savedUsername) {
    els.username.value = savedUsername;
  }

  if (invitedRoom) {
    els.room.value = cleanRoomName(invitedRoom);
  } else if (savedRoom) {
    els.room.value = savedRoom;
  }

  if (invitedKey) {
    els.roomKey.value = invitedKey;
  }

  updateInvite();
}

function sendWire(text) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(text);
    return true;
  }

  state.wireQueue.push(text);
  connect();
  return true;
}

function flushWireQueue() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  while (state.wireQueue.length > 0) {
    state.ws.send(state.wireQueue.shift());
  }
}

function connect() {
  if (state.ws &&
      (state.ws.readyState === WebSocket.OPEN ||
       state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearTimeout(state.reconnectTimer);
  state.ws = new WebSocket(wsUrl(), "anonchat");
  setStatus("connecting", "warn");

  state.ws.onopen = () => {
    state.reconnectAttempts = 0;
    setStatus("online", "good");
    flushWireQueue();
  };

  state.ws.onclose = () => {
    setStatus("offline", "bad");
    state.authenticated = false;
    setIdentity("signed out", "warn");
    scheduleReconnect();
  };

  state.ws.onerror = () => {
    setStatus("connection issue", "bad");
  };

  state.ws.onmessage = (event) => handleServerMessage(event.data);
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(12000, 1000 + state.reconnectAttempts * 1500);
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(connect, delay);
}

function handleServerMessage(text) {
  const parts = text.split("|");
  const type = parts[0];

  if (type === "OK" && parts[1] === "auth") {
    state.authenticated = true;
    state.peerId = parts[2];
    state.username = parts[3];
    localStorage.setItem("anonchat.username", state.username);
    setIdentity(state.username, "good");
    addSystemMessage(`signed in as ${state.username}`);
    afterAuthenticated().catch(() => addSystemMessage("local profile setup failed"));
    renderPeers();
    return;
  }

  if (type === "OK" && parts[1] === "join") {
    state.room = parts[2];
    state.peerId = parts[3];
    state.peers.clear();
    resetPeerConnections();
    localStorage.setItem("anonchat.room", state.room);
    addSystemMessage(`entered ${state.room}`);
    saveJoinedRoomConversation().catch(() => addSystemMessage("could not save room locally"));
    renderPeers();
    updateInvite();
    return;
  }

  if (type === "OK" && parts[1] === "leave") {
    addSystemMessage(`left ${parts[2]}`);
    return;
  }

  if (type === "OK" && parts[1] === "chat") {
    return;
  }

  if (type === "OK" && parts[1] === "key") {
    return;
  }

  if (type === "OK" && parts[1] === "dm") {
    return;
  }

  if (type === "OK" && parts[1] === "dsignal") {
    return;
  }

  if (type === "ERR") {
    addSystemMessage(`server rejected ${parts[1] || "request"}`);
    return;
  }

  if (type === "PEER") {
    addPeer(parts[1], parts[2] || "peer");
    return;
  }

  if (type === "LEFT") {
    removePeer(parts[1]);
    return;
  }

  if (type === "CHAT") {
    handleChat(parts[1], parts[2]);
    return;
  }

  if (type === "USER") {
    rememberDirectPeer(parts[1], parts[2], parts[3]);
    return;
  }

  if (type === "DM") {
    handleDirectMessage(parts[1], parts[2], parts[3], parts[4]).catch(() => {
      addSystemMessage("could not decrypt direct message");
    });
    return;
  }

  if (type === "DSIGNAL") {
    handleDirectSignal(parts[1], parts[2], parts[3], parts[4]).catch(() => {
      addSystemMessage("direct call negotiation failed");
      setCallStatus("call issue", "bad");
    });
    return;
  }

  if (type === "SIGNAL") {
    handleSignal(parts[1], parts[2]).catch(() => {
      addSystemMessage("call negotiation failed");
      setCallStatus("call issue", "bad");
    });
  }
}

async function signup() {
  connect();
  const username = els.username.value.trim();
  const password = els.password.value;

  if (!username || !password) {
    addSystemMessage("username and password required");
    return;
  }

  if (password.length < 12) {
    addSystemMessage("use at least 12 characters for new passwords");
    return;
  }

  const authField = await deriveAuthField(username, password);
  sendWire(`SIGNUP|${username}|${authField}`);
}

async function login() {
  connect();
  const username = els.username.value.trim();
  const password = els.password.value;

  if (!username || !password) {
    addSystemMessage("username and password required");
    return;
  }

  const authField = await deriveAuthField(username, password);
  sendWire(`LOGIN|${username}|${authField}`);
}

async function deriveAuthField(username, password) {
  if (!hasRoomCrypto()) {
    addSystemMessage("password proof needs HTTPS or localhost; falling back to legacy login format");
    return textToBase64(password);
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const proof = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(`anonchat-account:${username.toLowerCase()}`),
      iterations: 250000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  return `v2.${bytesToBase64Url(new Uint8Array(proof))}`;
}

async function afterAuthenticated() {
  await loadConversations();
  await setupDirectIdentity();
}

async function setupDirectIdentity() {
  if (!hasRoomCrypto() || !state.username) {
    return;
  }

  const key = `identity:${state.username.toLowerCase()}`;
  let saved = await dbGet("settings", key);

  if (!saved) {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );
    saved = {
      key,
      publicJwk: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
      privateJwk: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
    };
    await dbPut("settings", saved);
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    saved.publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    saved.privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"]
  );

  state.identity = {
    keyPair: { publicKey, privateKey },
    publicWire: textToBase64Url(JSON.stringify(saved.publicJwk)),
  };
  sendWire(`KEY|${state.identity.publicWire}`);
}

function rememberDirectPeer(username, peerId, publicWire) {
  const clean = cleanUsername(username);

  if (!clean || !publicWire) {
    return;
  }

  const id = clean.toLowerCase();
  const existing = state.directPeers.get(id);

  if (existing && existing.publicWire !== publicWire) {
    addSystemMessage(`${clean}'s device key changed`);
  }

  const peer = { username: clean, peerId, publicWire, updatedAt: Date.now() };
  state.directPeers.set(id, peer);
  state.directPeerIds.set(peerId, clean);
  dbPut("settings", { key: `peer:${id}`, ...peer }).catch(() => {});

  const waiters = state.directWaiters.get(id) || [];
  state.directWaiters.delete(id);

  for (const waiter of waiters) {
    waiter.resolve(peer);
  }
}

async function requestDirectPeer(username, options = {}) {
  const clean = cleanUsername(username);
  const id = clean.toLowerCase();
  const fresh = options.fresh === true;

  if (!clean || !state.authenticated) {
    throw new Error("direct peer unavailable");
  }

  const cached = state.directPeers.get(id);

  if (cached && !fresh) {
    sendWire(`WHO|${clean}`);
    return cached;
  }

  const saved = await dbGet("settings", `peer:${id}`);

  if (saved && saved.publicWire && !fresh) {
    state.directPeers.set(id, saved);
    sendWire(`WHO|${clean}`);
    return saved;
  }

  sendWire(`WHO|${clean}`);

  return new Promise((resolve, reject) => {
    const waiters = state.directWaiters.get(id) || [];
    const waiter = { resolve, reject };
    waiters.push(waiter);
    state.directWaiters.set(id, waiters);

    setTimeout(() => {
      const current = state.directWaiters.get(id) || [];
      state.directWaiters.set(id, current.filter((item) => item !== waiter));
      reject(new Error("user is not online or has no key yet"));
    }, 5000);
  });
}

async function deriveDirectKey(publicWire) {
  if (!state.identity || !state.identity.keyPair) {
    await setupDirectIdentity();
  }

  const publicJwk = JSON.parse(base64UrlToText(publicWire));
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  return crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    state.identity.keyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function deriveScopedRoomKey(room, secret, scope) {
  if (!hasRoomCrypto()) {
    throw new Error("WebCrypto unavailable");
  }

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(`anonchat:${room}:${scope}`),
      iterations: 250000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function deriveRoomKeys(room, secret) {
  const [chat, signal, file] = await Promise.all([
    deriveScopedRoomKey(room, secret, "chat-v2"),
    deriveScopedRoomKey(room, secret, "signal-v2"),
    deriveScopedRoomKey(room, secret, "file-v2"),
  ]);

  return { chat, signal, file };
}

async function joinRoom() {
  if (!state.authenticated) {
    addSystemMessage("sign in first");
    setIdentity("sign in first", "bad");
    return;
  }

  const room = cleanRoomName(els.room.value);
  const secret = els.roomKey.value;

  if (!room || !secret) {
    addSystemMessage("room name and key required");
    return;
  }

  els.room.value = room;
  try {
    state.roomKeys = await deriveRoomKeys(room, secret);
    state.roomKey = state.roomKeys.chat;
    state.pendingRoomSecret = secret;
  } catch {
    explainCryptoProblem();
    return;
  }

  sendWire(`JOIN|${room}`);
}

async function saveJoinedRoomConversation() {
  const secret = state.pendingRoomSecret || els.roomKey.value;
  const conversation = await upsertConversation({
    id: roomConversationId(state.room),
    kind: "room",
    title: state.room,
    room: state.room,
    roomKey: secret,
    preview: "room joined",
    updatedAt: Date.now(),
  });

  state.activeConversationId = conversation.id;
  setActiveConversationHeader(conversation);
  await renderConversationHistory(conversation.id);
}

function createNewRoom() {
  if (!window.crypto || !crypto.getRandomValues) {
    addSystemMessage("cannot create room key in this browser context");
    return;
  }

  const suffix = randomKey(6).toLowerCase();

  if (!suffix) {
    return;
  }

  els.room.value = `room-${suffix}`;
  els.roomKey.value = randomKey(24);
  updateInvite();
  addSystemMessage("new room ready; sign in, then enter room");
}

async function copyInvite() {
  updateInvite();

  try {
    await navigator.clipboard.writeText(els.inviteLink.value);
    addSystemMessage("invite copied");
  } catch {
    els.inviteLink.focus();
    els.inviteLink.select();
    document.execCommand("copy");
    addSystemMessage("invite selected");
  }
}

async function encryptMessage(text) {
  return encryptJson(state.roomKeys.chat, { sender: state.username, text });
}

async function decryptMessage(payload) {
  return decryptJson(state.roomKeys.chat, payload);
}

async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));

  return textToBase64Url(JSON.stringify({
    v: 1,
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(cipher),
  }));
}

async function decryptJson(key, payload) {
  const box = JSON.parse(base64UrlToText(payload));
  const iv = base64UrlToBytes(box.iv);
  const cipher = base64UrlToBytes(box.ct);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(dec.decode(plain));
}

async function sendChat(event) {
  event.preventDefault();
  const text = els.messageInput.value.trim();

  if (!text) {
    return;
  }

  const conversation = activeConversation();

  if (conversation && conversation.kind === "dm") {
    try {
      await sendDirectChat(conversation.username, text);
    } catch {
      addSystemMessage("direct message could not be delivered");
    }
    return;
  }

  if (!state.room || !state.roomKey) {
    addSystemMessage("enter a room first");
    return;
  }

  const payload = await encryptMessage(text);
  sendWire(`CHAT|${state.room}|${payload}`);
  addMessage(text, "local", state.username);
  await persistMessage(roomConversationId(state.room), {
    direction: "out",
    sender: state.username,
    text,
  });
  els.messageInput.value = "";
  resizeComposer();
}

async function handleChat(peerId, payload) {
  if (!state.roomKey) {
    addSystemMessage("encrypted message ignored before room key was set");
    return;
  }

  try {
    const message = await decryptMessage(payload);
    const peer = state.peers.get(peerId);
    const sender = peer ? peer.username : peerId;

    if (!state.conversations.has(roomConversationId(state.room))) {
      await saveJoinedRoomConversation();
    }

    if (state.activeConversationId === roomConversationId(state.room)) {
      addMessage(message.text, "", sender);
    }

    await notifyIfSubscribed(`${sender} in ${state.room}`, message.text, roomConversationId(state.room));

    await persistMessage(roomConversationId(state.room), {
      direction: "in",
      sender,
      text: message.text,
    });
  } catch {
    addSystemMessage("could not decrypt a message");
  }
}

async function startDirectConversation() {
  if (!state.authenticated) {
    addSystemMessage("sign in first");
    return;
  }

  const username = cleanUsername(els.directUsername.value);

  if (!username) {
    addSystemMessage("username required");
    return;
  }

  if (username.toLowerCase() === state.username.toLowerCase()) {
    addSystemMessage("choose another username");
    return;
  }

  const peer = await requestDirectPeer(username).catch(() => null);
  const conversation = await upsertConversation({
    id: directConversationId(username),
    kind: "dm",
    title: username,
    username,
    peerPublicKey: peer ? peer.publicWire : "",
    preview: peer ? "direct ready" : "waiting for user",
    updatedAt: Date.now(),
  });

  await openConversation(conversation.id);
}

async function startDirectCall(username = "") {
  if (!state.authenticated) {
    addSystemMessage("sign in first");
    return;
  }

  const clean = cleanUsername(username || els.directUsername.value || (activeConversation() || {}).username || "");

  if (!clean) {
    addSystemMessage("username required");
    return;
  }

  if (clean.toLowerCase() === state.username.toLowerCase()) {
    addSystemMessage("choose another username");
    return;
  }

  const peer = await requestDirectPeer(clean, { fresh: true });
  const conversation = await upsertConversation({
    id: directConversationId(peer.username),
    kind: "dm",
    title: peer.username,
    username: peer.username,
    peerPublicKey: peer.publicWire,
    preview: "direct call",
    updatedAt: Date.now(),
  });
  await openConversation(conversation.id);

  const ok = await ensureLocalMedia();

  if (!ok) {
    return;
  }

  const pc = ensurePeerConnection(peer.peerId, {
    kind: "direct",
    username: peer.username,
    publicWire: peer.publicWire,
  });
  addLocalTracksTo(pc);
  setCallStatus(`calling ${peer.username}`, "warn");
  await negotiate(peer.peerId);
}

async function sendDirectChat(username, text) {
  if (!state.identity) {
    await setupDirectIdentity();
  }

  const peer = await requestDirectPeer(username, { fresh: true });
  const key = await deriveDirectKey(peer.publicWire);
  const payload = await encryptJson(key, {
    sender: state.username,
    text,
    at: Date.now(),
  });
  sendWire(`DM|${peer.username}|${payload}`);

  const conversation = await upsertConversation({
    id: directConversationId(peer.username),
    kind: "dm",
    title: peer.username,
    username: peer.username,
    peerPublicKey: peer.publicWire,
    updatedAt: Date.now(),
  });
  state.activeConversationId = conversation.id;
  addMessage(text, "local", state.username);
  await persistMessage(conversation.id, {
    direction: "out",
    sender: state.username,
    text,
  });
  els.messageInput.value = "";
  resizeComposer();
}

async function handleDirectMessage(username, peerId, publicWire, payload) {
  rememberDirectPeer(username, peerId, publicWire);
  const key = await deriveDirectKey(publicWire);
  const message = await decryptJson(key, payload);
  const conversation = await upsertConversation({
    id: directConversationId(username),
    kind: "dm",
    title: username,
    username,
    peerPublicKey: publicWire,
    updatedAt: message.at || Date.now(),
  });

  if (state.activeConversationId === conversation.id) {
    addMessage(message.text, "", username);
  }

  await notifyIfSubscribed(`Message from ${username}`, message.text, conversation.id);

  await persistMessage(conversation.id, {
    direction: "in",
    sender: username,
    text: message.text,
    at: message.at,
  });
}

function addPeer(peerId, username) {
  if (!peerId || peerId === state.peerId) {
    return;
  }

  if (!state.peers.has(peerId)) {
    state.peers.set(peerId, { username });
    ensurePeerConnection(peerId);
    addSystemMessage(`${username} joined`);
  }

  renderPeers();
}

function removePeer(peerId) {
  const peer = state.peers.get(peerId);

  if (peer) {
    addSystemMessage(`${peer.username} left`);
  }

  state.peers.delete(peerId);
  closePeer(peerId);
  renderPeers();
}

function renderPeers() {
  els.peers.textContent = "";
  els.peerCount.textContent = `${state.peers.size} online`;

  for (const [peerId, peer] of state.peers) {
    const item = document.createElement("div");
    item.className = "peer";

    const top = document.createElement("div");
    top.className = "peer-top";

    const name = document.createElement("strong");
    name.textContent = peer.username;

    const callButton = document.createElement("button");
    callButton.type = "button";
    callButton.textContent = "Call";
    callButton.onclick = () => startCall(peerId);

    const meta = document.createElement("span");
    const pc = state.pcs.get(peerId);
    const channel = state.channels.get(peerId);
    const rtc = pc ? pc.connectionState : "new";
    const data = channel ? channel.readyState : "closed";
    meta.textContent = `${peerId} | media ${rtc} | file ${data}`;

    top.appendChild(name);
    top.appendChild(callButton);
    item.appendChild(top);
    item.appendChild(meta);
    els.peers.appendChild(item);
  }

  if (state.peers.size === 0) {
    const empty = document.createElement("div");
    empty.className = "peer";
    empty.innerHTML = "<strong>No one else here</strong><span>Share the room invite.</span>";
    els.peers.appendChild(empty);
  }
}

function rtcConfig() {
  return { iceServers: appConfig.iceServers || [] };
}

function ensurePeerConnection(peerId, options = {}) {
  if (state.pcs.has(peerId)) {
    const existing = state.pcs.get(peerId);
    updatePeerConnectionMode(existing, options);
    return existing;
  }

  const pc = new RTCPeerConnection(rtcConfig());
  pc._makingOffer = false;
  pc._ignoreOffer = false;
  pc._isSettingRemoteAnswerPending = false;
  pc._pendingCandidates = [];
  updatePeerConnectionMode(pc, options);

  pc.onnegotiationneeded = async () => {
    try {
      await negotiate(peerId);
    } catch {
      addSystemMessage("could not encrypt call setup");
      setCallStatus("call issue", "bad");
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendRtcSignal(peerId, { type: "candidate", candidate: event.candidate }).catch(() => {
        addSystemMessage("could not encrypt call candidate");
      });
    }
  };

  pc.onconnectionstatechange = () => {
    setCallStatus(`${peerLabel(peerId)}: ${pc.connectionState}`, pc.connectionState === "connected" ? "good" : "");
    renderPeers();
  };

  pc.oniceconnectionstatechange = () => renderPeers();
  pc.ontrack = (event) => attachRemoteStream(peerId, event.streams[0]);
  pc.ondatachannel = (event) => setupDataChannel(peerId, event.channel);

  state.pcs.set(peerId, pc);
  addLocalTracksTo(pc);

  if (pc._signalKind === "room" && state.peerId && state.peerId < peerId && !state.channels.has(peerId)) {
    setupDataChannel(peerId, pc.createDataChannel("files"));
  }

  return pc;
}

function updatePeerConnectionMode(pc, options = {}) {
  if (!pc) {
    return;
  }

  if (options.kind) {
    pc._signalKind = options.kind;
  } else if (!pc._signalKind) {
    pc._signalKind = "room";
  }

  if (options.username) {
    pc._directUsername = cleanUsername(options.username);
  }

  if (options.publicWire) {
    pc._directPublicWire = options.publicWire;
  }
}

async function negotiate(peerId) {
  const pc = ensurePeerConnection(peerId);

  if (pc._makingOffer || pc.signalingState !== "stable") {
    return;
  }

  try {
    pc._makingOffer = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendRtcSignal(peerId, { description: pc.localDescription });
  } finally {
    pc._makingOffer = false;
  }
}

async function sendRtcSignal(peerId, value) {
  const pc = state.pcs.get(peerId);

  if (pc && pc._signalKind === "direct") {
    await sendDirectSignal(pc._directUsername, pc._directPublicWire, value);
    return;
  }

  await sendSignal(peerId, value);
}

async function sendSignal(peerId, value) {
  if (!state.roomKeys || !state.roomKeys.signal) {
    addSystemMessage("enter a room before call setup");
    return;
  }

  const payload = await encryptJson(state.roomKeys.signal, value);
  sendWire(`SIGNAL|${peerId}|${payload}`);
}

async function sendDirectSignal(username, publicWire, value) {
  if (!username || !publicWire) {
    addSystemMessage("direct call recipient key missing");
    return;
  }

  const key = await deriveDirectKey(publicWire);
  const payload = await encryptJson(key, value);
  sendWire(`DSIGNAL|${username}|${payload}`);
}

async function handleSignal(peerId, payload) {
  if (!state.roomKeys || !state.roomKeys.signal) {
    addSystemMessage("encrypted call setup ignored before room key was set");
    return;
  }

  const pc = ensurePeerConnection(peerId);
  const signal = await decryptJson(state.roomKeys.signal, payload);
  await handleRtcSignal(peerId, pc, signal);
}

async function handleDirectSignal(username, peerId, publicWire, payload) {
  rememberDirectPeer(username, peerId, publicWire);
  const pc = ensurePeerConnection(peerId, { kind: "direct", username, publicWire });
  const key = await deriveDirectKey(publicWire);
  const signal = await decryptJson(key, payload);
  await handleRtcSignal(peerId, pc, signal);
}

async function handleRtcSignal(peerId, pc, signal) {
  const description = signal.description || (signal.sdp ? { type: signal.type, sdp: signal.sdp } : null);

  if (description) {
    const readyForOffer =
      !pc._makingOffer &&
      (pc.signalingState === "stable" || pc._isSettingRemoteAnswerPending);
    const offerCollision = description.type === "offer" && !readyForOffer;
    const polite = state.peerId > peerId;

    pc._ignoreOffer = !polite && offerCollision;

    if (pc._ignoreOffer) {
      return;
    }

    if (description.type === "offer" && !state.localStream) {
      addSystemMessage(`incoming call from ${peerLabel(peerId)}`);
      setCallStatus(`incoming from ${peerLabel(peerId)}`, "warn");
      await notifyIfSubscribed("Incoming call", peerLabel(peerId), `call:${peerId}`);
    }

    pc._isSettingRemoteAnswerPending = description.type === "answer";
    await pc.setRemoteDescription(description);
    pc._isSettingRemoteAnswerPending = false;

    while (pc._pendingCandidates.length > 0) {
      await pc.addIceCandidate(pc._pendingCandidates.shift());
    }

    if (description.type === "offer") {
      addLocalTracksTo(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendRtcSignal(peerId, { description: pc.localDescription });
    }

    return;
  }

  if (signal.type === "candidate" && signal.candidate) {
    if (pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(signal.candidate);
      } catch (error) {
        if (!pc._ignoreOffer) {
          throw error;
        }
      }
    } else {
      pc._pendingCandidates.push(signal.candidate);
    }
  }
}

function peerLabel(peerId) {
  const peer = state.peers.get(peerId);
  return peer ? peer.username : state.directPeerIds.get(peerId) || peerId;
}

function addLocalTracksTo(pc) {
  if (!state.localStream) {
    return;
  }

  const existing = new Set(pc.getSenders().map((sender) => sender.track));

  for (const track of state.localStream.getTracks()) {
    if (!existing.has(track)) {
      pc.addTrack(track, state.localStream);
    }
  }
}

function attachRemoteStream(peerId, stream) {
  let video = document.querySelector(`[data-remote="${peerId}"]`);

  if (!video) {
    video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.dataset.remote = peerId;
    els.remoteVideos.appendChild(video);
  }

  video.srcObject = stream;
}

async function ensureLocalMedia() {
  if (state.localStream) {
    return true;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    addSystemMessage("camera and microphone prompts require HTTPS or localhost");
    setCallStatus("media unavailable", "bad");
    return false;
  }

  addSystemMessage("asking for camera and microphone permission");

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    els.localVideo.srcObject = state.localStream;
    return true;
  } catch (error) {
    if (error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError")) {
      addSystemMessage("camera or microphone is blocked; allow it in browser site settings");
    } else if (error && error.name === "NotFoundError") {
      addSystemMessage("no camera or microphone was found");
    } else {
      addSystemMessage("camera or microphone could not be opened");
    }

    setCallStatus("media blocked", "bad");
    return false;
  }
}

async function startActiveCall() {
  const conversation = activeConversation();

  if (conversation && conversation.kind === "dm") {
    await startDirectCall(conversation.username);
    return;
  }

  await startCall();
}

async function startCall(targetPeerId = null) {
  if (typeof targetPeerId !== "string") {
    targetPeerId = null;
  }

  const peerIds = targetPeerId ? [targetPeerId] : [...state.peers.keys()];

  if (peerIds.length === 0) {
    addSystemMessage("no peers to call");
    return;
  }

  const ok = await ensureLocalMedia();

  if (!ok) {
    return;
  }

  setCallStatus(targetPeerId ? `calling ${peerLabel(targetPeerId)}` : "calling room", "warn");

  for (const peerId of peerIds) {
    const pc = ensurePeerConnection(peerId);
    addLocalTracksTo(pc);
    await negotiate(peerId);
  }
}

function stopCall() {
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      track.stop();
    }
  }

  state.localStream = null;
  els.localVideo.srcObject = null;
  els.remoteVideos.textContent = "";
  setCallStatus("idle");

  for (const peerId of [...state.pcs.keys()]) {
    closePeer(peerId);
  }

  for (const peerId of state.peers.keys()) {
    ensurePeerConnection(peerId);
  }
}

function closePeer(peerId) {
  const pc = state.pcs.get(peerId);

  if (pc) {
    pc.close();
  }

  state.pcs.delete(peerId);
  state.channels.delete(peerId);

  const video = document.querySelector(`[data-remote="${peerId}"]`);

  if (video) {
    video.remove();
  }
}

function resetPeerConnections() {
  for (const peerId of [...state.pcs.keys()]) {
    closePeer(peerId);
  }

  els.remoteVideos.textContent = "";
}

function setupDataChannel(peerId, channel) {
  channel.bufferedAmountLowThreshold = 512 * 1024;
  channel.onopen = () => {
    addSystemMessage(`file channel open with ${peerLabel(peerId)}`);
    renderPeers();
  };
  channel.onclose = () => renderPeers();
  channel.onmessage = (event) => handleDataMessage(peerId, event.data).catch(() => {
    addSystemMessage("could not decrypt a file transfer message");
  });
  state.channels.set(peerId, channel);
}

async function ensureFileChannels() {
  for (const peerId of state.peers.keys()) {
    const pc = ensurePeerConnection(peerId);

    if (!state.channels.has(peerId)) {
      setupDataChannel(peerId, pc.createDataChannel("files"));
    }

    await negotiate(peerId);
  }
}

async function sha256Hex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function waitForChannel(channel) {
  if (channel.readyState === "open" && channel.bufferedAmount < channel.bufferedAmountLowThreshold) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener("open", done);
      channel.removeEventListener("bufferedamountlow", done);
      resolve();
    };

    channel.addEventListener("open", done);
    channel.addEventListener("bufferedamountlow", done);
  });
}

function updateSelectedFile() {
  const file = els.fileInput.files[0];
  els.selectedFile.textContent = file ? `${file.name} (${file.size} bytes)` : "No file selected";
}

async function sendSelectedFile() {
  const file = els.fileInput.files[0];

  if (!file) {
    addSystemMessage("choose a file first");
    return;
  }

  if (state.peers.size === 0) {
    addSystemMessage("no peers for file transfer");
    return;
  }

  if (!state.roomKeys || !state.roomKeys.file) {
    addSystemMessage("enter a room before sending files");
    return;
  }

  await ensureFileChannels();
  const channels = [...state.channels.values()].filter((channel) => channel.readyState === "open");

  if (channels.length === 0) {
    addSystemMessage("file channels are not open yet");
    return;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const id = crypto.randomUUID();
  const chunkSize = 12000;
  const total = Math.ceil(bytes.length / chunkSize);
  addSystemMessage(`sending ${file.name}`);

  for (const channel of channels) {
    await sendEncryptedFileFrame(channel, {
      kind: "file-meta",
      id,
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      hash,
      total,
    });

    for (let index = 0; index < total; index++) {
      await waitForChannel(channel);
      const chunk = bytes.subarray(index * chunkSize, Math.min(bytes.length, (index + 1) * chunkSize));
      await sendEncryptedFileFrame(channel, {
        kind: "file-chunk",
        id,
        index,
        data: bytesToBase64Url(chunk),
      });
    }
  }

  addSystemMessage(`sent ${file.name}`);
}

async function sendEncryptedFileFrame(channel, frame) {
  const box = await encryptJson(state.roomKeys.file, frame);
  channel.send(JSON.stringify({ kind: "file-box", box }));
}

async function handleDataMessage(peerId, raw) {
  if (typeof raw !== "string") {
    return;
  }

  let msg = JSON.parse(raw);

  if (msg.kind !== "file-box") {
    addSystemMessage("ignored unencrypted file transfer message");
    return;
  }

  if (!state.roomKeys || !state.roomKeys.file) {
    addSystemMessage("encrypted file message ignored before room key was set");
    return;
  }

  msg = await decryptJson(state.roomKeys.file, msg.box);

  if (msg.kind === "file-meta") {
    state.incomingFiles.set(msg.id, {
      peerId,
      name: msg.name,
      type: msg.type,
      size: msg.size,
      hash: msg.hash,
      total: msg.total,
      chunks: new Array(msg.total),
      received: 0,
    });
    addSystemMessage(`receiving ${msg.name}`);
    return;
  }

  if (msg.kind !== "file-chunk") {
    return;
  }

  const transfer = state.incomingFiles.get(msg.id);

  if (!transfer || transfer.chunks[msg.index]) {
    return;
  }

  transfer.chunks[msg.index] = base64UrlToBytes(msg.data);
  transfer.received++;

  if (transfer.received !== transfer.total) {
    return;
  }

  const blob = new Blob(transfer.chunks, { type: transfer.type });
  const hash = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));

  if (hash !== transfer.hash || blob.size !== transfer.size) {
    addSystemMessage(`file check failed: ${transfer.name}`);
    state.incomingFiles.delete(msg.id);
    return;
  }

  const card = document.createElement("div");
  card.className = "file-card";

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = transfer.name;
  link.textContent = transfer.name;

  const meta = document.createElement("span");
  meta.textContent = `${blob.size} bytes from ${peerLabel(transfer.peerId)}`;

  card.appendChild(link);
  card.appendChild(meta);
  els.files.prepend(card);
  state.incomingFiles.delete(msg.id);
}

function resizeComposer() {
  els.messageInput.style.height = "auto";
  els.messageInput.style.height = `${Math.min(148, els.messageInput.scrollHeight)}px`;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") {
    return;
  }

  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

els.connectBtn.onclick = connect;
els.signupBtn.onclick = signup;
els.loginBtn.onclick = login;
els.startDmBtn.onclick = () => startDirectConversation().catch(() => addSystemMessage("direct message setup failed"));
els.directCallBtn.onclick = () => startDirectCall().catch(() => addSystemMessage("direct call setup failed"));
els.notificationBtn.onclick = () => toggleNotifications().catch(() => addSystemMessage("notification setup failed"));
els.directUsername.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    startDirectConversation().catch(() => addSystemMessage("direct message setup failed"));
  }
});
els.newRoomBtn.onclick = createNewRoom;
els.joinBtn.onclick = joinRoom;
els.copyInviteBtn.onclick = copyInvite;
els.startCallBtn.onclick = () => startActiveCall().catch(() => addSystemMessage("call setup failed"));
els.stopCallBtn.onclick = stopCall;
els.attachBtn.onclick = () => els.fileInput.click();
els.fileInput.onchange = updateSelectedFile;
els.sendFileBtn.onclick = sendSelectedFile;
els.messageForm.addEventListener("submit", sendChat);
els.messageInput.addEventListener("input", resizeComposer);
els.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.messageForm.requestSubmit();
  }
});
els.room.addEventListener("input", updateInvite);
els.roomKey.addEventListener("input", updateInvite);
window.addEventListener("hashchange", () => {
  loadInitialInputs();
  addSystemMessage("invite loaded");
});

async function boot() {
  state.db = await openLocalDb();
  await requestStoragePersistence();
  await loadNotificationSetting();
  await loadConversations();
  loadInitialInputs();
  connect();
  renderPeers();
  resizeComposer();
  registerServiceWorker();

  if (!hasRoomCrypto()) {
    explainCryptoProblem();
  }
}

boot().catch(() => {
  loadInitialInputs();
  connect();
  renderPeers();
  resizeComposer();
  registerServiceWorker();
});
