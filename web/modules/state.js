export const appConfig = window.ANONCHAT_CONFIG || {
  iceServers: [],
  turnCredentialUrl: "/turn-credentials.json",
  relayFallbackEnabled: true,
  backendRelayFallbackEnabled: true,
  turnRequiredForFallback: true,
  callTransport: "p2p_first",
};

if (typeof appConfig.turnCredentialUrl === "undefined") {
  appConfig.turnCredentialUrl = "/turn-credentials.json";
}

let turnCredentialRefreshTimer = null;
let turnCredentialLoadPromise = null;
let turnCredentialsExpiresAt = 0;

export function getIceServers() {
  return Array.isArray(appConfig.iceServers) ? appConfig.iceServers : [];
}

export async function loadTurnCredentials(options = {}) {
  const force = options.force === true;
  const credentialUrl = appConfig.turnCredentialUrl;

  if (credentialUrl === false || credentialUrl === null) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!force && turnCredentialsExpiresAt && nowSeconds < turnCredentialsExpiresAt - 300) {
    return true;
  }

  if (turnCredentialLoadPromise) {
    return turnCredentialLoadPromise;
  }

  const url = typeof credentialUrl === "string" && credentialUrl ?
    credentialUrl :
    "/turn-credentials.json";

  turnCredentialLoadPromise = fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  })
    .then(async (response) => {
      if (!response.ok) {
        return false;
      }

      const payload = await response.json();

      if (!payload || !Array.isArray(payload.iceServers) || payload.iceServers.length === 0) {
        return false;
      }

      appConfig.iceServers = payload.iceServers;
      const ttlSeconds = Number(payload.ttlSeconds) || 0;
      turnCredentialsExpiresAt = Number(payload.expiresAt) || (ttlSeconds ? nowSeconds + ttlSeconds : 0);
      scheduleTurnCredentialRefresh(ttlSeconds);
      return true;
    })
    .catch(() => false)
    .finally(() => {
      turnCredentialLoadPromise = null;
    });

  return turnCredentialLoadPromise;
}

function scheduleTurnCredentialRefresh(ttlSeconds) {
  clearTimeout(turnCredentialRefreshTimer);

  if (!ttlSeconds || ttlSeconds <= 0) {
    return;
  }

  const refreshInMs = Math.max(60000, (ttlSeconds - 300) * 1000);
  turnCredentialRefreshTimer = setTimeout(() => {
    loadTurnCredentials({ force: true }).catch(() => {});
  }, refreshInMs);
}

export function hasTurnRelayConfigured() {
  return getIceServers().some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => typeof url === "string" && /^turns?:/i.test(url));
  });
}

export function relayFallbackEnabled() {
  return appConfig.relayFallbackEnabled !== false;
}

export function backendRelayFallbackEnabled() {
  return appConfig.backendRelayFallbackEnabled !== false;
}

export function callsUseBackendRelayOnly() {
  return appConfig.callTransport === "backend_relay";
}

export function turnRequiredForFallback() {
  return appConfig.turnRequiredForFallback !== false;
}

export const state = {
  ws: null,
  authenticated: false,
  serverSessionReady: false,
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
  deviceIdentity: null,
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
  sessionRefresh: {
    inProgress: false,
    failureCount: 0,
    confirmedInvalidCount: 0,
    lastRefreshStartedAt: 0,
    lastRefreshSucceededAt: 0,
    lastFailureAt: 0,
    lastRefreshFailedAt: 0,
    retryTimer: null,
  },
  backupTimer: null,
  backupBusy: false,
  backupDirty: false,
  backupLocked: false,
  backupKey: null,
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
  return scopedConversationId(`room:${cleanRoomName(room)}`);
}

export function directConversationId(username) {
  return scopedConversationId(`dm:${cleanUsername(username).toLowerCase()}`);
}

export function currentAccountKey() {
  return state.authenticated ? cleanUsername(state.username).toLowerCase() : "";
}

export function accountKeyForUsername(username) {
  return cleanUsername(username).toLowerCase();
}

export function accountSettingKey(name, accountKey = currentAccountKey()) {
  return accountKey ? `account:${accountKey}:${name}` : "";
}

export function scopedConversationId(id, accountKey = currentAccountKey()) {
  return accountKey ? `account:${accountKey}:${id}` : id;
}

export function unscopedConversationId(id) {
  const match = /^account:[^:]+:(.+)$/.exec(id || "");
  return match ? match[1] : id;
}

export function clearSessionOnly() {
  clearTimeout(state.refreshTimer);
  clearTimeout(state.sessionRefresh.retryTimer);
  state.authenticated = false;
  state.serverSessionReady = false;
  state.session.deviceId = "";
  state.session.sessionId = "";
  state.session.sessionToken = "";
  state.session.expiresAt = 0;
  state.username = "";
  state.sessionRefresh.inProgress = false;
  state.sessionRefresh.failureCount = 0;
  state.sessionRefresh.confirmedInvalidCount = 0;
  state.sessionRefresh.lastRefreshStartedAt = 0;
  state.sessionRefresh.lastRefreshSucceededAt = 0;
  state.sessionRefresh.lastFailureAt = 0;
  state.sessionRefresh.lastRefreshFailedAt = 0;
  state.sessionRefresh.retryTimer = null;
  clearAccountRuntimeState();
}

export function clearAccountRuntimeState() {
  state.peerId = "";
  state.room = "";
  state.roomKey = null;
  state.roomKeys = null;
  state.pendingRoomSecret = "";
  state.activeConversationId = "";
  state.conversations.clear();
  state.peers.clear();
  for (const pc of state.pcs.values()) {
    pc.close();
  }
  state.pcs.clear();
  state.channels.clear();
  state.incomingFiles.clear();
  state.identity = null;
  state.directPeers.clear();
  state.directPeerIds.clear();
  state.directWaiters.clear();
  state.pendingAcks.chat = [];
  state.pendingAcks.dm.clear();
  state.calls.active = null;
  state.calls.sessions.clear();
  clearTimeout(state.backupTimer);
  state.backupKey = null;
  state.backupDirty = false;
  state.backupBusy = false;
  state.backupLocked = false;

  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      track.stop();
    }
  }

  state.localStream = null;
}

export function activeConversation() {
  return state.conversations.get(state.activeConversationId) || null;
}
