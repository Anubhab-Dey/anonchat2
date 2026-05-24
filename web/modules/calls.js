import { state, activeConversation, cleanUsername } from "./state.js";
import { els } from "./dom.js";
import { showToast } from "./toast.js";
import { addSystemMessage, hideIncomingCall, setCallStatus, showIncomingCall } from "./ui.js";
import { requestDirectPeer } from "./direct.js";
import { upsertConversation, openConversation } from "./conversations.js";
import { directConversationId } from "./state.js";
import {
  ensureLocalMedia,
  ensurePeerConnection,
  addLocalTracksTo,
  negotiate,
  stopP2PMedia,
  setPeerCallHandler,
} from "./call-p2p.js";
import { markTurnFallback, sendCallInvite, sendCallEnd, sendCallAccept, sendCallDecline } from "./call-relay.js";

const P2P_TIMEOUT_MS = 10000;

export function initializeCalls() {
  setPeerCallHandler((peerId) => startRoomCall(peerId).catch(() => {
    setCallStatus("Call failed", "bad");
  }));
  window.addEventListener("anonchat:p2p-state", (event) => {
    handleP2PState(event.detail.peerId, event.detail.state, event.detail.transport);
  });
}

export function createCallSession(options) {
  const session = {
    call_id: options.call_id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
    call_kind: options.call_kind,
    caller_username: options.caller_username || state.username,
    callee_username: options.callee_username || null,
    room: options.room || null,
    target: options.target || options.callee_username || options.room || "",
    roomSecret: options.roomSecret || "",
    peerId: options.peerId || null,
    peerPublicWire: options.peerPublicWire || "",
    call_state: "idle",
    selected_transport: null,
    p2p_started_at: null,
    p2p_connected_at: null,
    relay_started_at: null,
    relay_connected_at: null,
    ended_at: null,
    fallbackTimer: null,
    incoming: Boolean(options.incoming),
  };
  state.calls.sessions.set(session.call_id, session);
  state.calls.active = session;
  return session;
}

export async function startActiveCall() {
  const conversation = activeConversation();

  if (conversation && conversation.kind === "dm") {
    await startDirectCall(conversation.username);
    return;
  }

  await startRoomCall();
}

export async function startDirectCall(username = "") {
  if (!state.authenticated) {
    showToast("Sign in first", "warning");
    return;
  }

  const clean = cleanUsername(username || els.directUsername.value || (activeConversation() || {}).username || "");

  if (!clean) {
    showToast("Username required", "warning");
    return;
  }

  if (clean.toLowerCase() === state.username.toLowerCase()) {
    showToast("Choose another username", "warning");
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

  const session = createCallSession({
    call_kind: "direct",
    callee_username: peer.username,
    target: peer.username,
    peerId: peer.peerId,
    peerPublicWire: peer.publicWire,
  });
  await startP2PAttempt(session);
}

export async function startRoomCall(targetPeerId = null) {
  if (!state.authenticated) {
    showToast("Sign in first", "warning");
    return;
  }

  if (typeof targetPeerId !== "string") {
    targetPeerId = null;
  }

  const peerIds = targetPeerId ? [targetPeerId] : [...state.peers.keys()];

  if (peerIds.length === 0) {
    showToast("No peers to call", "warning");
    return;
  }

  const session = createCallSession({
    call_kind: "room",
    room: state.room,
    target: state.room,
    roomSecret: state.pendingRoomSecret || els.roomKey.value,
    peerId: targetPeerId,
  });
  await startP2PAttempt(session, peerIds);
}

export async function startP2PAttempt(callSession, roomPeerIds = null, options = {}) {
  const shouldSendInvite = options.sendInvite !== false;
  const ok = await ensureLocalMedia();

  if (!ok) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    return;
  }

  callSession.call_state = "connecting_p2p";
  callSession.p2p_started_at = Date.now();
  setCallStatus("Connecting securely...", "warn");

  clearTimeout(callSession.fallbackTimer);
  callSession.fallbackTimer = setTimeout(() => {
    if (!callSession.selected_transport && callSession.call_state === "connecting_p2p") {
      markTurnFallback(callSession);
    }
  }, P2P_TIMEOUT_MS);

  if (shouldSendInvite) {
    await sendCallInvite(callSession).catch(() => {});
  }

  if (callSession.call_kind === "direct") {
    const pc = ensurePeerConnection(callSession.peerId, {
      kind: "direct",
      username: callSession.callee_username,
      publicWire: callSession.peerPublicWire,
    });
    addLocalTracksTo(pc);
    await negotiate(callSession.peerId);
    return;
  }

  for (const peerId of roomPeerIds || [...state.peers.keys()]) {
    const pc = ensurePeerConnection(peerId);
    addLocalTracksTo(pc);
    await negotiate(peerId);
  }
}

export function selectCallTransport(callSession, transport) {
  if (!callSession || callSession.selected_transport) {
    return;
  }

  callSession.selected_transport = transport;
  clearTimeout(callSession.fallbackTimer);

  if (transport === "p2p") {
    callSession.call_state = "connected_p2p";
    callSession.p2p_connected_at = Date.now();
    setCallStatus("Connected", "good");
    return;
  }

  callSession.call_state = "connected_relay";
  callSession.relay_connected_at = Date.now();
  setCallStatus("Connected", "good");
  showToast("Connected through relay", "success");
}

export function endCallSession(callSession = state.calls.active, options = {}) {
  if (!callSession) {
    stopP2PMedia();
    setCallStatus("idle");
    return;
  }

  const shouldNotify = options.notify !== false;
  clearTimeout(callSession.fallbackTimer);
  callSession.call_state = "ended";
  callSession.ended_at = Date.now();
  if (shouldNotify) {
    sendCallEnd(callSession).catch(() => {});
  }
  stopP2PMedia();
  state.calls.active = null;
  hideIncomingCall();
  setCallStatus("idle");
  addSystemMessage("call ended");
}

export async function handleCallEvent(parts) {
  const eventType = parts[1];
  const callId = parts[2];
  const fromUsername = parts[3];
  const session = state.calls.sessions.get(callId);

  if (eventType === "invite") {
    await handleIncomingInvite(callId, fromUsername);
    return;
  }

  if (eventType === "accept") {
    if (session) {
      session.call_state = "connecting_p2p";
      setCallStatus("Connecting securely...", "warn");
    }
    return;
  }

  if (eventType === "decline") {
    if (session) {
      session.call_state = "ended";
      session.ended_at = Date.now();
    }
    hideIncomingCall();
    setCallStatus("Call declined", "warn");
    return;
  }

  if (eventType === "end") {
    endCallSession(session || state.calls.active, { notify: false });
  }
}

async function handleIncomingInvite(callId, fromUsername) {
  let peer = null;

  try {
    peer = await requestDirectPeer(fromUsername, { fresh: true });
  } catch {
    peer = null;
  }

  const session = createCallSession({
    call_id: callId,
    call_kind: peer ? "direct" : "room",
    caller_username: fromUsername,
    callee_username: state.username,
    target: peer ? fromUsername : state.room,
    room: peer ? null : state.room,
    roomSecret: state.pendingRoomSecret || els.roomKey.value,
    peerId: peer ? peer.peerId : null,
    peerPublicWire: peer ? peer.publicWire : "",
    incoming: true,
  });
  session.call_state = "ringing";
  addSystemMessage(`incoming call from ${fromUsername}`);
  showToast(`Incoming call from ${fromUsername}`, "info");
  setCallStatus("Incoming call", "warn");
  showIncomingCall(
    session,
    () => acceptIncomingCall(session).catch(() => {
      setCallStatus("Call failed", "bad");
      showToast("Call failed", "error");
    }),
    () => declineIncomingCall(session).catch(() => {})
  );
}

async function acceptIncomingCall(callSession) {
  hideIncomingCall();
  callSession.call_state = "connecting_p2p";

  if (callSession.call_kind === "direct" && (!callSession.peerId || !callSession.peerPublicWire)) {
    const peer = await requestDirectPeer(callSession.caller_username, { fresh: true });
    callSession.peerId = peer.peerId;
    callSession.peerPublicWire = peer.publicWire;
    callSession.target = peer.username;
  }

  await sendCallAccept(callSession).catch(() => {});
  const peers = callSession.call_kind === "room" ? [...state.peers.keys()] : null;
  await startP2PAttempt(callSession, peers, { sendInvite: false });
}

async function declineIncomingCall(callSession) {
  hideIncomingCall();
  callSession.call_state = "ended";
  callSession.ended_at = Date.now();
  await sendCallDecline(callSession).catch(() => {});
  if (state.calls.active === callSession) {
    state.calls.active = null;
  }
  setCallStatus("Call declined", "warn");
}

function handleP2PState(peerId, value, transport = "p2p") {
  const callSession = state.calls.active;

  if (!callSession || callSession.selected_transport === "server_relay") {
    return;
  }

  if (value === "connected" || value === "completed") {
    selectCallTransport(callSession, transport === "server_relay" ? "server_relay" : "p2p");
    return;
  }

  if ((value === "failed" || value === "disconnected") && callSession.call_state === "connecting_p2p") {
    callSession.call_state = "reconnecting";
    setCallStatus("Reconnecting...", "warn");
    setTimeout(() => {
      if (!callSession.selected_transport) {
        markTurnFallback(callSession);
      }
    }, 1000);
  }
}

export function incomingCallLabel(parts) {
  return parts && parts[3] ? `Incoming call from ${parts[3]}` : "Incoming call";
}
