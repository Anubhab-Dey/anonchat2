import { state, activeConversation, cleanUsername } from "./state.js";
import { els } from "./dom.js";
import { showToast } from "./toast.js";
import { addSystemMessage, setCallStatus } from "./ui.js";
import { requestDirectPeer } from "./direct.js";
import { upsertConversation, openConversation } from "./conversations.js";
import { directConversationId } from "./state.js";
import {
  ensureLocalMedia,
  ensurePeerConnection,
  addLocalTracksTo,
  negotiate,
  stopP2PMedia,
  peerLabel,
  setPeerCallHandler,
} from "./call-p2p.js";
import { markTurnFallback, sendCallInvite, sendCallEnd } from "./call-relay.js";

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

export async function startP2PAttempt(callSession, roomPeerIds = null) {
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

  await sendCallInvite(callSession).catch(() => {});

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

export function endCallSession(callSession = state.calls.active) {
  if (!callSession) {
    stopP2PMedia();
    setCallStatus("idle");
    return;
  }

  clearTimeout(callSession.fallbackTimer);
  callSession.call_state = "ended";
  callSession.ended_at = Date.now();
  sendCallEnd(callSession).catch(() => {});
  stopP2PMedia();
  state.calls.active = null;
  setCallStatus("idle");
  addSystemMessage("call ended");
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
