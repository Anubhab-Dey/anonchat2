export const appConfig = window.ANONCHAT_CONFIG || { iceServers: [] };

export const state = {
  ws: null,
  authenticated: false,
  reconnectEnabled: true,
  peerId: "",
  username: "",
  lastPassword: "",
  room: "",
  roomKey: null,
  roomKeys: null,
  pendingRoomSecret: "",
  activeConversationId: "",
  conversations: new Map(),
  peers: new Map(),
  pcs: new Map(),
  channels: new Map(),
  localStream: null,
  incomingFiles: new Map(),
  db: null,
  identity: null,
  directPeers: new Map(),
  directPeerIds: new Map(),
  directWaiters: new Map(),
  notificationsEnabled: false,
  wireQueue: [],
  wireWaiters: [],
  reconnectTimer: null,
  reconnectAttempts: 0,
  refreshTimer: null,
  backupTimer: null,
  backupBusy: false,
  backupDirty: false,
  blockingReason: "",
  session: {
    deviceId: "",
    sessionId: "",
    sessionToken: "",
    expiresAt: 0,
    backupVersion: 0,
  },
  pendingAcks: {
    chat: [],
    dm: new Map(),
  },
  calls: {
    active: null,
    sessions: new Map(),
  },
};

export function cleanUsername(text) {
  return (text || "").trim().replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32);
}

export function cleanRoomName(text) {
  return (text || "").trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64);
}

export function roomConversationId(room) {
  return `room:${room}`;
}

export function directConversationId(username) {
  return `dm:${cleanUsername(username).toLowerCase()}`;
}

export function clearSessionOnly() {
  state.authenticated = false;
  state.session.deviceId = "";
  state.session.sessionId = "";
  state.session.sessionToken = "";
  state.session.expiresAt = 0;
  state.peerId = "";
  state.room = "";
  state.roomKey = null;
  state.roomKeys = null;
  state.peers.clear();
  state.pcs.clear();
  state.channels.clear();
}

export function activeConversation() {
  return state.conversations.get(state.activeConversationId) || null;
}
