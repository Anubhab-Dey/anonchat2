import { state, cleanUsername, directConversationId } from "./state.js";
import { els } from "./dom.js";
import { base64UrlToText, textToBase64Url, encryptJson, decryptJson } from "./crypto-box.js";
import { dbGet, dbPut } from "./local-db.js";
import { sendWire } from "./wire.js";
import { showToast } from "./toast.js";
import { upsertConversation, openConversation, persistMessage, updateMessageStatus } from "./conversations.js";
import { notifyIfSubscribed } from "./notifications.js";

export async function setupDirectIdentity() {
  await ensureDirectIdentity();
  sendWire(`KEY|${state.identity.publicWire}`);
}

export async function ensureDirectIdentity() {
  let saved = await dbGet("settings", "direct_identity");

  if (!saved) {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );
    saved = {
      key: "direct_identity",
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

  if (!clean || !publicWire) {
    return;
  }

  const id = clean.toLowerCase();
  const existing = state.directPeers.get(id);

  if (existing && existing.publicWire !== publicWire) {
    showToast(`${clean}'s device key changed`, "warning");
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

export async function requestDirectPeer(username, options = {}) {
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

  if (!username || username.toLowerCase() === state.username.toLowerCase()) {
    showToast("Choose another username", "warning");
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
  const peer = await requestDirectPeer(username, { fresh: true });
  const key = await deriveDirectKey(peer.publicWire);
  const id = crypto.randomUUID();
  const created = Date.now();
  await persistMessage(directConversationId(peer.username), {
    id,
    direction: "out",
    sender: state.username,
    text,
    client_created_at: created,
    status: "pending",
  });
  const payload = await encryptJson(key, { id, sender: state.username, text, client_created_at: created });
  const pending = state.pendingAcks.dm.get(peer.username.toLowerCase()) || [];
  pending.push(id);
  state.pendingAcks.dm.set(peer.username.toLowerCase(), pending);
  sendWire(`DM|${peer.username}|${payload}`);
  await updateMessageStatus(id, { client_sent_at: Date.now() });
}

export async function handleDirectAck(targetUsername, serverSentAt) {
  const key = targetUsername.toLowerCase();
  const pending = state.pendingAcks.dm.get(key) || [];
  const id = pending.shift();
  state.pendingAcks.dm.set(key, pending);

  if (!id) {
    return;
  }

  await updateMessageStatus(id, {
    status: "sent",
    server_sent_at: Number(serverSentAt || 0) || null,
  });
}

export async function handleDirectMessage(username, peerId, publicWire, payload) {
  rememberDirectPeer(username, peerId, publicWire);
  const key = await deriveDirectKey(publicWire);
  const message = await decryptJson(key, payload);
  const conversation = await upsertConversation({
    id: directConversationId(username),
    kind: "dm",
    title: username,
    username,
    peerPublicKey: publicWire,
    updatedAt: message.client_created_at || Date.now(),
  });
  await persistMessage(conversation.id, {
    id: message.id || crypto.randomUUID(),
    direction: "in",
    sender: username,
    text: message.text,
    client_created_at: message.client_created_at || null,
    status: "received",
  });
  await notifyIfSubscribed(`Message from ${username}`, message.text, conversation.id);
}

export async function encryptDirectSignal(username, publicWire, value) {
  const key = await deriveDirectKey(publicWire);
  return encryptJson(key, value);
}

export async function decryptDirectSignal(publicWire, payload) {
  const key = await deriveDirectKey(publicWire);
  return decryptJson(key, payload);
}
