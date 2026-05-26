import { state, accountSettingKey, cleanUsername, currentAccountKey, directConversationId } from "./state.js";
import { els } from "./dom.js";
import { base64UrlToText, textToBase64Url, encryptJson, decryptJson } from "./crypto-box.js";
import { dbGet, dbPut } from "./local-db.js";
import { sendWire } from "./wire.js";
import { showToast } from "./toast.js";
import { upsertConversation, openConversation, persistMessage, updateMessageStatus } from "./conversations.js";
import { notifyIfSubscribed } from "./notifications.js";
import { ensureServerSessionReady } from "./device-session.js";

export async function setupDirectIdentity() {
  await ensureDirectIdentity();
  sendWire(`KEY|${state.identity.publicWire}`);
}

export async function ensureDirectIdentity() {
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
  const id = username.toLowerCase();
  let messageId = null;

  if (id && state.pendingAcks.dm.has(id)) {
    const pending = state.pendingAcks.dm.get(id) || [];
    messageId = pending.shift() || null;
    state.pendingAcks.dm.set(id, pending);
  }

  if (!messageId) {
    for (const pending of state.pendingAcks.dm.values()) {
      messageId = pending.shift() || null;

      if (messageId) {
        break;
      }
    }
  }

  if (messageId) {
    await updateMessageStatus(messageId, { status: "failed" });
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
  const pending = state.pendingAcks.dm.get(peer.username.toLowerCase()) || [];
  pending.push(id);
  state.pendingAcks.dm.set(peer.username.toLowerCase(), pending);
  sendWire(`DM|${peer.username}|${payload}`);
  await updateMessageStatus(id, { client_sent_at: Date.now() });
  if (state.serverSessionReady) {
    requestDirectPeer(peer.username, { fresh: true }).catch(() => {});
  }
  await upsertConversation({ ...conversation, preview: text, updatedAt: created }, { silent: true });
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
