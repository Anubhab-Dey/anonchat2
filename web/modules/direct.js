import { state, accountSettingKey, cleanUsername, currentAccountKey, directConversationId } from "./state.js";
import { els } from "./dom.js";
import { base64UrlToText, textToBase64Url, encryptJson, decryptJson } from "./crypto-box.js";
import {
  dbDeleteDirectOutbox,
  dbGet,
  dbGetAccountMessage,
  dbGetDirectOutbox,
  dbPut,
  dbPutDirectOutbox,
} from "./local-db.js";
import { sendWire } from "./wire.js";
import { showToast } from "./toast.js";
import { upsertConversation, openConversation, persistMessage, updateMessageStatus } from "./conversations.js";
import { notifyIfSubscribed } from "./notifications.js";
import { ensureServerSessionReady } from "./device-session.js";

const DIRECT_RETRY_BASE_MS = 8000;
const DIRECT_RETRY_MAX_MS = 5 * 60 * 1000;
let directRetryTimer = null;

export async function setupDirectIdentity() {
  await ensureDirectIdentity();
  sendWire(`KEY|${state.identity.publicWire}`);
}

export async function ensureDirectIdentity() {
  if (state.identity &&
      state.identity.keyPair &&
      state.identity.publicWire) {
    return state.identity;
  }

  const key = accountSettingKey("direct_identity");

  if (!key) {
    throw new Error("account required for direct identity");
  }

  let saved = await dbGet("settings", key);

  if (!saved) {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );
    saved = {
      key,
      account_key: currentAccountKey(),
      kind: "direct-ecdh-v1",
      publicJwk: await crypto.subtle.exportKey("jwk", keyPair.publicKey),
      privateJwk: await crypto.subtle.exportKey("jwk", keyPair.privateKey),
    };
    await dbPut("settings", saved);
  }

  const publicKey = await crypto.subtle.importKey("jwk", saved.publicJwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const privateKey = await crypto.subtle.importKey("jwk", saved.privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  state.identity = {
    keyPair: { publicKey, privateKey },
    publicWire: textToBase64Url(JSON.stringify(saved.publicJwk)),
  };
  return state.identity;
}

export function rememberDirectPeer(username, peerId, publicWire) {
  const clean = cleanUsername(username);
  const accountKey = currentAccountKey();

  if (!accountKey || !clean || !publicWire) {
    return;
  }

  const id = clean.toLowerCase();
  const existing = state.directPeers.get(id);

  if (existing && existing.publicWire !== publicWire) {
    showToast(`${clean}'s device key changed`, "warning");
  }

  const peer = { username: clean, peerId, publicWire, account_key: accountKey, updatedAt: Date.now() };
  state.directPeers.set(id, peer);
  state.directPeerIds.set(peerId, clean);
  dbPut("settings", { key: accountSettingKey(`peer:${id}`, accountKey), ...peer }).catch(() => {});

  const waiters = state.directWaiters.get(id) || [];
  state.directWaiters.delete(id);

  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve(peer);
  }
}

export async function getCachedDirectPeer(username) {
  const clean = cleanUsername(username);
  const accountKey = currentAccountKey();

  if (!clean || !accountKey) {
    return null;
  }

  const id = clean.toLowerCase();
  const cached = state.directPeers.get(id);

  if (cached && cached.publicWire && cached.account_key === accountKey) {
    return cached;
  }

  const saved = await dbGet("settings", accountSettingKey(`peer:${id}`, accountKey));

  if (!saved || !saved.publicWire || saved.account_key !== accountKey) {
    return null;
  }

  state.directPeers.set(id, saved);

  if (saved.peerId) {
    state.directPeerIds.set(saved.peerId, saved.username || clean);
  }

  return saved;
}

export async function requestDirectPeer(username, options = {}) {
  const clean = cleanUsername(username);
  const id = clean.toLowerCase();
  const fresh = options.fresh === true;
  const userVisible = options.userVisible === true;

  if (!clean || !state.authenticated) {
    throw new Error("direct peer unavailable");
  }

  if (!state.serverSessionReady && !(await ensureServerSessionReady())) {
    throw new Error("direct peer unavailable");
  }

  const cached = await getCachedDirectPeer(clean);

  if (cached && !fresh) {
    sendWire(`WHO|${clean}`);
    return cached;
  }

  sendWire(`WHO|${clean}`);
  return new Promise((resolve, reject) => {
    const waiters = state.directWaiters.get(id) || [];
    const waiter = { resolve, reject, userVisible, username: clean, timer: null };
    waiters.push(waiter);
    state.directWaiters.set(id, waiters);

    waiter.timer = setTimeout(() => {
      const current = state.directWaiters.get(id) || [];
      state.directWaiters.set(id, current.filter((item) => item !== waiter));
      if (userVisible) {
        reject(new Error("direct user unavailable"));
      } else {
        resolve(null);
      }
    }, 5000);
  });
}

export function handleDirectUserRejected(parts) {
  const username = cleanUsername(parts[2] || "");

  if (!username) {
    clearAllUserVisibleDirectWaiters();
    return true;
  }

  const id = username.toLowerCase();
  const waiters = state.directWaiters.get(id) || [];

  if (waiters.length === 0) {
    return true;
  }

  state.directWaiters.delete(id);

  for (const waiter of waiters) {
    clearTimeout(waiter.timer);

    if (waiter.userVisible) {
      waiter.reject(new Error("direct user unavailable"));
    } else {
      waiter.resolve(null);
    }
  }

  return true;
}

export async function handleDirectDeliveryFailed(parts) {
  const username = cleanUsername(parts[2] || "");
  const messageId = parts[3] || "";

  if (messageId) {
    const existingMessage = await dbGetAccountMessage(messageId);

    if (existingMessage && existingMessage.status === "delivered") {
      return;
    }

    await deferDirectOutboxRetry(messageId, { status: "pending" });
    await updateMessageStatus(messageId, { status: "pending" });
  }

  showToast(username ? `${username} is offline` : "Message could not be delivered", "warning");
}

export async function deriveDirectKey(publicWire) {
  await ensureDirectIdentity();
  const publicJwk = JSON.parse(base64UrlToText(publicWire));
  const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    state.identity.keyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function startDirectConversation() {
  if (!state.authenticated) {
    showToast("Sign in first", "warning");
    return;
  }

  const username = cleanUsername(els.directUsername.value);

  if (!username) {
    showToast("Enter a username", "warning");
    return;
  }

  if (username.toLowerCase() === state.username.toLowerCase()) {
    showToast("Use someone else's username", "warning");
    return;
  }

  if (!(await ensureServerSessionReady())) {
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

export async function sendDirectChat(username, text) {
  if (!state.authenticated) {
    showToast("Sign in first", "warning");
    return;
  }

  if (!(await ensureServerSessionReady())) {
    return;
  }

  let peer = await getCachedDirectPeer(username);

  if (!peer) {
    try {
      peer = await requestDirectPeer(username, { fresh: true, userVisible: true });
    } catch {
      showToast("User is not online yet", "warning");
      return;
    }
  }

  if (!peer || !peer.publicWire) {
    showToast("Direct user unavailable", "warning");
    return;
  }

  const key = await deriveDirectKey(peer.publicWire);
  const id = crypto.randomUUID();
  const created = Date.now();
  const conversation = await upsertConversation({
    id: directConversationId(peer.username),
    kind: "dm",
    title: peer.username,
    username: peer.username,
    peerPublicKey: peer.publicWire,
    updatedAt: created,
  }, { silent: true });
  await persistMessage(directConversationId(peer.username), {
    id,
    direction: "out",
    sender: state.username,
    text,
    client_created_at: created,
    status: "pending",
  });
  const payload = await encryptJson(key, { id, sender: state.username, text, client_created_at: created });
  const outboxRecord = {
    id,
    conversationId: directConversationId(peer.username),
    target_username: peer.username,
    encrypted_payload: payload,
    status: "pending",
    client_created_at: created,
    client_sent_at: null,
    server_sent_at: null,
    delivered_at: null,
    retry_count: 0,
    next_retry_at: 0,
  };
  await dbPutDirectOutbox(outboxRecord);
  await sendDirectOutboxRecord(outboxRecord);
  if (state.serverSessionReady) {
    requestDirectPeer(peer.username, { fresh: true }).catch(() => {});
  }
  await upsertConversation({ ...conversation, preview: text, updatedAt: created }, { silent: true });
}

export async function handleDirectAck(targetUsername, messageId, serverSentAt) {
  if (!messageId) {
    return;
  }

  const record = await getOutboxRecord(messageId);
  const serverTime = Number(serverSentAt || 0) || null;
  const existingMessage = await dbGetAccountMessage(messageId);

  if (existingMessage && existingMessage.status === "delivered") {
    return;
  }

  if (record && record.status !== "delivered") {
    await dbPutDirectOutbox({
      ...record,
      target_username: cleanUsername(targetUsername || record.target_username),
      status: "routed",
      server_sent_at: serverTime,
      next_retry_at: Date.now() + nextDirectRetryDelay(record.retry_count || 0),
    });
    scheduleDirectOutboxRetry();
  }

  await updateMessageStatus(messageId, {
    status: "routed",
    server_sent_at: serverTime,
  });
}

export async function handleDirectReceipt(receiverUsername, messageId, serverReceivedAt) {
  if (!messageId) {
    return;
  }

  await dbDeleteDirectOutbox(messageId);
  await updateMessageStatus(messageId, {
    status: "delivered",
    delivered_at: Number(serverReceivedAt || 0) || Date.now(),
    delivered_by: cleanUsername(receiverUsername),
  });
}

export async function handleDirectMessage(username, peerId, publicWire, messageId, payload) {
  if (!messageId || !payload) {
    throw new Error("direct message missing id");
  }

  rememberDirectPeer(username, peerId, publicWire);
  const conversationId = directConversationId(username);
  const existing = await dbGetAccountMessage(messageId);

  if (existing) {
    sendWire(`DM_RECEIVED|${username}|${messageId}`);
    return;
  }

  const key = await deriveDirectKey(publicWire);
  const message = await decryptJson(key, payload);

  if (message.id && message.id !== messageId) {
    throw new Error("message id mismatch");
  }

  const conversation = await upsertConversation({
    id: conversationId,
    kind: "dm",
    title: username,
    username,
    peerPublicKey: publicWire,
    updatedAt: message.client_created_at || Date.now(),
  });
  await persistMessage(conversation.id, {
    id: messageId || message.id || crypto.randomUUID(),
    direction: "in",
    sender: username,
    text: message.text,
    client_created_at: message.client_created_at || null,
    status: "received",
  });
  sendWire(`DM_RECEIVED|${username}|${messageId}`);
  await notifyIfSubscribed(`Message from ${username}`, message.text, conversation.id);
}

export async function retryPendingDirectOutbox() {
  if (!state.authenticated || !state.serverSessionReady) {
    return;
  }

  const now = Date.now();
  const pending = (await dbGetDirectOutbox())
    .filter((record) =>
      record &&
      record.id &&
      record.encrypted_payload &&
      record.target_username &&
      record.status !== "delivered" &&
      Number(record.next_retry_at || 0) <= now
    )
    .sort((a, b) => (a.client_created_at || 0) - (b.client_created_at || 0));

  for (const record of pending.slice(0, 20)) {
    await sendDirectOutboxRecord(record);
  }
}

async function sendDirectOutboxRecord(record) {
  if (!record || !record.id || !record.target_username || !record.encrypted_payload) {
    return;
  }

  if (!(await ensureServerSessionReady())) {
    await deferDirectOutboxRetry(record.id);
    return;
  }

  const now = Date.now();
  const retryCount = Number(record.retry_count || 0) + 1;
  await dbPutDirectOutbox({
    ...record,
    status: record.status === "routed" ? "routed" : "pending",
    client_sent_at: now,
    retry_count: retryCount,
    next_retry_at: now + nextDirectRetryDelay(retryCount),
  });
  sendWire(`DM|${record.target_username}|${record.id}|${record.encrypted_payload}`);
  await updateMessageStatus(record.id, {
    client_sent_at: now,
    status: record.status === "routed" ? "routed" : "pending",
  });
  scheduleDirectOutboxRetry();
}

async function deferDirectOutboxRetry(messageId, patch = {}) {
  const record = await getOutboxRecord(messageId);

  if (!record) {
    return;
  }

  const retryCount = Number(record.retry_count || 0);
  await dbPutDirectOutbox({
    ...record,
    ...patch,
    retry_count: retryCount,
    next_retry_at: Date.now() + nextDirectRetryDelay(retryCount),
  });
  scheduleDirectOutboxRetry();
}

async function getOutboxRecord(messageId) {
  if (!messageId) {
    return null;
  }

  return (await dbGetDirectOutbox()).find((record) => record.id === messageId) || null;
}

function scheduleDirectOutboxRetry() {
  clearTimeout(directRetryTimer);

  if (!state.authenticated) {
    return;
  }

  directRetryTimer = setTimeout(() => {
    retryPendingDirectOutbox().catch(() => {});
  }, 10000);
}

function nextDirectRetryDelay(retryCount) {
  return Math.min(DIRECT_RETRY_MAX_MS, DIRECT_RETRY_BASE_MS * Math.max(1, retryCount || 1));
}

export async function encryptDirectSignal(username, publicWire, value) {
  const key = await deriveDirectKey(publicWire);
  return encryptJson(key, value);
}

export async function decryptDirectSignal(publicWire, payload) {
  const key = await deriveDirectKey(publicWire);
  return decryptJson(key, payload);
}

function clearAllUserVisibleDirectWaiters() {
  for (const [id, waiters] of state.directWaiters.entries()) {
    const remaining = [];

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);

      if (waiter.userVisible) {
        waiter.reject(new Error("direct user unavailable"));
      } else {
        remaining.push(waiter);
      }
    }

    if (remaining.length > 0) {
      state.directWaiters.set(id, remaining);
    } else {
      state.directWaiters.delete(id);
    }
  }
}
