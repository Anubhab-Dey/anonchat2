import { state } from "./state.js";
import { setText } from "./dom.js";
import { els } from "./dom.js";

const handlers = new Map();
const MAX_WIRE_QUEUE = 500;

export function wsUrl() {
  if (location.protocol === "http:" || location.protocol === "https:") {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }

  return "ws://127.0.0.1:8080/ws";
}

export function onWire(type, handler) {
  const list = handlers.get(type) || [];
  list.push(handler);
  handlers.set(type, list);
}

export function setStatus(text, tone = "") {
  setText(els.status, text);
  if (els.status) {
    els.status.className = tone;
  }
  setText(els.topbarStatus, text);
  if (els.topbarStatus) {
    els.topbarStatus.className = `pill ${tone}`.trim();
  }
}

export function connect() {
  if (!state.reconnectEnabled) {
    return;
  }

  if (state.ws &&
      (state.ws.readyState === WebSocket.OPEN ||
       state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearTimeout(state.reconnectTimer);
  state.ws = new WebSocket(wsUrl(), "anonchat");
  setStatus("Connecting", "warn");

  state.ws.onopen = async () => {
    state.reconnectAttempts = 0;
    setStatus(state.session.sessionId && !state.serverSessionReady ? "Connecting" : "Online", state.serverSessionReady ? "good" : "warn");
    await notifyHandlers("OPEN", []);
    if (!state.session.sessionId) {
      flushWireQueue();
    }

    if (!state.session.sessionId || state.serverSessionReady) {
      setStatus("Online", "good");
    }
  };

  state.ws.onclose = () => {
    state.serverSessionReady = false;
    setStatus("Offline", "bad");
    notifyHandlers("CLOSE", []);
    scheduleReconnect();
  };

  state.ws.onerror = () => {
    setStatus("Connection issue", "bad");
  };

  state.ws.onmessage = (event) => handleWireMessage(event.data);
}

export function stopReconnect() {
  state.reconnectEnabled = false;
  clearTimeout(state.reconnectTimer);

  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
    state.ws.close();
  }
}

export function sendWire(text) {
  if (shouldHoldForSession(text)) {
    enqueueWire(text);
    connect();
    return true;
  }

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(text);
    return true;
  }

  enqueueWire(text);
  connect();
  return true;
}

export function flushWireQueue() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const remaining = [];

  while (state.wireQueue.length > 0) {
    const next = state.wireQueue.shift();

    if (shouldHoldForSession(next)) {
      remaining.push(next);
      continue;
    }

    state.ws.send(next);
  }

  state.wireQueue.unshift(...remaining);
}

export function waitForWire(predicate, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject };
    state.wireWaiters.push(waiter);

    setTimeout(() => {
      state.wireWaiters = state.wireWaiters.filter((item) => item !== waiter);
      reject(new Error("wire timeout"));
    }, timeout);
  });
}

export async function sendAndWait(text, predicate, timeout = 7000) {
  const wait = waitForWire(predicate, timeout);
  sendWire(text);
  return wait;
}

function scheduleReconnect() {
  if (!state.reconnectEnabled) {
    return;
  }

  clearTimeout(state.reconnectTimer);
  const delay = Math.min(12000, 1000 + state.reconnectAttempts * 1500);
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(connect, delay);
}

export function handleWireMessage(text) {
  const parts = text.split("|");

  for (const waiter of [...state.wireWaiters]) {
    if (waiter.predicate(parts, text)) {
      state.wireWaiters = state.wireWaiters.filter((item) => item !== waiter);
      waiter.resolve({ parts, text });
    }
  }

  notifyHandlers(parts[0], parts, text);
}

async function notifyHandlers(type, parts, raw = "") {
  const list = handlers.get(type) || [];

  for (const handler of list) {
    await Promise.resolve(handler(parts, raw)).catch(() => {});
  }
}

function enqueueWire(text) {
  if (!text) {
    return;
  }

  if (state.wireQueue.includes(text)) {
    return;
  }

  state.wireQueue.push(text);

  while (state.wireQueue.length > MAX_WIRE_QUEUE) {
    state.wireQueue.shift();
  }
}

function shouldHoldForSession(text) {
  const command = String(text || "").split("|", 1)[0];

  if (!AUTHENTICATED_COMMANDS.has(command)) {
    return false;
  }

  return Boolean(
    state.session.sessionId &&
    state.session.sessionToken &&
    !state.serverSessionReady
  );
}

const AUTHENTICATED_COMMANDS = new Set([
  "JOIN",
  "LEAVE",
  "CHAT",
  "SIGNAL",
  "KEY",
  "WHO",
  "DM",
  "DM_RECEIVED",
  "DSIGNAL",
  "BACKUP_GET",
  "BACKUP_PUT",
  "CALL_INVITE",
  "CALL_ACCEPT",
  "CALL_DECLINE",
  "CALL_END",
  "CALL_RELAY",
]);
