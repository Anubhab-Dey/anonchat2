import {
  state,
  activeConversation,
  backendRelayFallbackEnabled,
  callsUseBackendRelayOnly,
  cleanUsername,
  hasTurnRelayConfigured,
  relayFallbackEnabled,
} from "./state.js";
import { els } from "./dom.js";
import { showToast } from "./toast.js";
import { addSystemMessage, hideIncomingCall, setCallStatus, showIncomingCall } from "./ui.js";
import { rememberDirectPeer, requestDirectPeer } from "./direct.js";
import { upsertConversation, openConversation } from "./conversations.js";
import { directConversationId } from "./state.js";
import {
  prepareCallMedia,
  ensurePeerConnection,
  createRelayPeerConnection,
  addLocalTracksTo,
  negotiate,
  resumePendingRemoteOffer,
  stopP2PMedia,
  closePeer,
  setPeerCallHandler,
} from "./call-p2p.js";
import {
  decryptCallInvitePayload,
  sendCallInvite,
  sendCallEnd,
  sendCallAccept,
  sendCallDecline,
} from "./call-relay.js";
import { startBackendMediaRelay, stopBackendAudioRelay } from "./call-backend-relay.js";
import { ensureServerSessionReady } from "./device-session.js";

const P2P_TIMEOUT_MS = 10000;

export function initializeCalls() {
  setPeerCallHandler((peerId) => startRoomCall(peerId).catch(() => {
    setCallStatus("Could not connect", "bad");
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
    backend_relay_started_at: null,
    backend_relay_connected_at: null,
    accepted_at: null,
    ended_at: null,
    fallbackTimer: null,
    backend_relay_waiting_for_accept: false,
    peerIds: Array.isArray(options.peerIds) ? options.peerIds : [],
    incoming: Boolean(options.incoming),
    media_mode: options.media_mode || null,
  };
  state.calls.sessions.set(session.call_id, session);
  state.calls.active = session;
  return session;
}

export async function startActiveCall() {
  if (!state.authenticated) {
    showToast("Sign in first", "warning");
    return;
  }

  if (!(await ensureServerSessionReady())) {
    return;
  }

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
    showToast("Enter a username", "warning");
    return;
  }

  if (clean.toLowerCase() === state.username.toLowerCase()) {
    showToast("Use someone else's username", "warning");
    return;
  }

  if (!(await ensureServerSessionReady())) {
    return;
  }

  const media = await prepareCallMedia();

  if (!media.ok) {
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
    media_mode: media.mediaMode,
  });

  if (callsUseBackendRelayOnly()) {
    await startServerRelayCall(session);
    return;
  }

  await startP2PAttempt(session, null, { mediaPrepared: true });
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
  const serverRelayOnly = callsUseBackendRelayOnly();

  if (!state.room) {
    showToast("Enter a room first", "warning");
    return;
  }

  if (peerIds.length === 0 && !serverRelayOnly) {
    showToast("No one else is here yet", "warning");
    return;
  }

  if (!(await ensureServerSessionReady())) {
    return;
  }

  const media = await prepareCallMedia();

  if (!media.ok) {
    return;
  }

  const session = createCallSession({
    call_kind: "room",
    room: state.room,
    target: state.room,
    roomSecret: state.pendingRoomSecret || els.roomKey.value,
    peerId: targetPeerId,
    media_mode: media.mediaMode,
  });

  if (serverRelayOnly) {
    await startServerRelayCall(session);
    return;
  }

  await startP2PAttempt(session, peerIds, { mediaPrepared: true });
}

async function startServerRelayCall(callSession, options = {}) {
  const shouldSendInvite = options.sendInvite !== false;
  callSession.call_state = callSession.accepted_at ? "connecting_backend_relay" : "calling";
  callSession.backend_relay_waiting_for_accept = !callSession.accepted_at;
  setCallStatus(callSession.accepted_at ? "Connecting call..." : "Calling...", "warn");

  if (shouldSendInvite) {
    await sendCallInvite(callSession).catch(() => {});
  }

  if (callSession.accepted_at) {
    await startBackendRelayFallback(callSession);
  }
}

export async function startP2PAttempt(callSession, roomPeerIds = null, options = {}) {
  const shouldSendInvite = options.sendInvite !== false;
  const media = options.mediaPrepared && state.localStream ?
    { ok: true, mediaMode: callSession.media_mode || "audio_video" } :
    await prepareCallMedia();

  if (!media.ok) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    return;
  }

  callSession.media_mode = media.mediaMode;

  callSession.call_state = "connecting_p2p";
  callSession.p2p_started_at = Date.now();
  callSession.peerIds = callSession.call_kind === "direct" ?
    [callSession.peerId].filter(Boolean) :
    [...(roomPeerIds || [...state.peers.keys()])];
  setCallStatus(callSession.call_kind === "direct" && !callSession.accepted_at ? "Calling..." : "Connecting...", "warn");
  scheduleP2PFallback(callSession);

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

function scheduleP2PFallback(callSession, delay = P2P_TIMEOUT_MS) {
  clearTimeout(callSession.fallbackTimer);

  if (!shouldStartP2PFallbackTimer(callSession)) {
    return;
  }

  callSession.fallbackTimer = setTimeout(() => {
    if (!callSession.selected_transport && callSession.call_state === "connecting_p2p") {
      startRelayFallback(callSession).catch(() => {
        callSession.call_state = "failed";
        callSession.ended_at = Date.now();
        setCallStatus("Could not connect", "bad");
      });
    }
  }, delay);
}

function shouldStartP2PFallbackTimer(callSession) {
  if (!callSession ||
      callSession.selected_transport ||
      callSession.call_state === "ended" ||
      callSession.call_state === "failed") {
    return false;
  }

  return callSession.call_kind !== "direct" || Boolean(callSession.accepted_at);
}

export async function startRelayFallback(callSession) {
  if (!callSession ||
      callSession.selected_transport ||
      callSession.backend_relay_started_at ||
      callSession.call_state === "ended" ||
      callSession.call_state === "failed") {
    return;
  }

  clearTimeout(callSession.fallbackTimer);

  if (!relayFallbackEnabled()) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    setCallStatus("Could not connect", "bad");
    showToast("Could not connect", "warning");
    return;
  }

  if (!hasTurnRelayConfigured()) {
    await startBackendRelayFallback(callSession);
    return;
  }

  if (callSession.relay_started_at) {
    return;
  }

  const media = await prepareCallMedia();

  if (!media.ok) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    return;
  }

  callSession.media_mode = media.mediaMode;

  callSession.call_state = "connecting_relay";
  callSession.relay_started_at = Date.now();
  setCallStatus("Connecting securely...", "warn");
  showToast("Still connecting call...", "info");

  if (callSession.call_kind === "direct") {
    if (!callSession.peerId || !callSession.peerPublicWire) {
      callSession.call_state = "failed";
      callSession.ended_at = Date.now();
      setCallStatus("Could not connect", "bad");
      return;
    }

    const pc = createRelayPeerConnection(callSession.peerId, {
      kind: "direct",
      username: callSession.callee_username || callSession.caller_username || callSession.target,
      publicWire: callSession.peerPublicWire,
    });
    addLocalTracksTo(pc);
    await negotiate(callSession.peerId);
    return;
  }

  const peerIds = callSession.peerIds.length > 0 ? callSession.peerIds : [...state.peers.keys()];

  if (peerIds.length === 0) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    setCallStatus("Could not connect", "bad");
    return;
  }

  callSession.peerIds = peerIds;

  for (const peerId of peerIds) {
    const pc = createRelayPeerConnection(peerId, { kind: "room" });
    addLocalTracksTo(pc);
    await negotiate(peerId);
  }
}

async function startBackendRelayFallback(callSession) {
  if (!callSession ||
      callSession.selected_transport ||
      callSession.call_state === "ended" ||
      callSession.call_state === "failed") {
    return;
  }

  if (!backendRelayFallbackEnabled()) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    setCallStatus("Could not connect", "bad");
    showToast("Call could not connect", "warning");
    return;
  }

  if (callSession.call_kind !== "direct" && callSession.call_kind !== "room") {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    setCallStatus("Could not connect", "bad");
    showToast("Call could not connect", "warning");
    return;
  }

  if (!callSession.accepted_at) {
    callSession.backend_relay_waiting_for_accept = true;
    setCallStatus("Waiting for answer...", "warn");
    return;
  }

  if (callSession.call_kind === "direct" && (!callSession.peerId || !callSession.peerPublicWire)) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    setCallStatus("Could not connect", "bad");
    return;
  }

  callSession.call_state = "connecting_backend_relay";
  callSession.backend_relay_started_at = Date.now();
  callSession.media_mode = currentLocalMediaMode();
  setCallStatus(callSession.media_mode === "audio_video" ? "Connecting video call..." : "Connecting audio call...", "warn");

  if (callSession.call_kind === "direct") {
    closePeer(callSession.peerId);
  } else {
    for (const peerId of callSession.peerIds || []) {
      closePeer(peerId);
    }
  }

  if (!(await startBackendMediaRelay(callSession))) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    setCallStatus("Could not connect", "bad");
  }
}

function currentLocalMediaMode() {
  const videoTracks = state.localStream ?
    state.localStream.getVideoTracks().filter((track) => track.readyState === "live" && track.enabled !== false) :
    [];

  return videoTracks.length > 0 ? "audio_video" : "audio_only";
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
}

export function endCallSession(callSession = state.calls.active, options = {}) {
  if (!callSession) {
    stopBackendAudioRelay();
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
  stopBackendAudioRelay(callSession);
  stopP2PMedia();
  state.calls.active = null;
  hideIncomingCall();
  setCallStatus("idle");
  addSystemMessage("call ended");
}

export function toggleMicrophone() {
  const tracks = state.localStream ? state.localStream.getAudioTracks() : [];

  if (tracks.length === 0) {
    showToast("Microphone unavailable", "warning");
    return;
  }

  const nextEnabled = tracks.some((track) => !track.enabled);

  for (const track of tracks) {
    track.enabled = nextEnabled;
  }

  if (els.micMuteBtn) {
    els.micMuteBtn.textContent = nextEnabled ? "Mute" : "Unmute";
    els.micMuteBtn.setAttribute("aria-pressed", String(!nextEnabled));
  }

  setCallStatus(nextEnabled ? "Connected" : "Muted", nextEnabled ? "good" : "warn");
}

export function toggleCamera() {
  const tracks = state.localStream ? state.localStream.getVideoTracks() : [];

  if (tracks.length === 0) {
    showToast("Camera unavailable", "warning");
    return;
  }

  const nextEnabled = tracks.some((track) => !track.enabled);

  for (const track of tracks) {
    track.enabled = nextEnabled;
  }

  if (els.cameraToggleBtn) {
    els.cameraToggleBtn.textContent = nextEnabled ? "Camera off" : "Camera on";
    els.cameraToggleBtn.setAttribute("aria-pressed", String(!nextEnabled));
  }

  setCallStatus(nextEnabled ? "Connected" : "Camera off", nextEnabled ? "good" : "warn");
}

export async function minimizeCall() {
  const video = document.querySelector("#remoteVideos video") || els.localVideo;

  if (!video || !document.pictureInPictureEnabled || !video.requestPictureInPicture) {
    showToast("Mini call is not available here", "info");
    return;
  }

  try {
    await video.requestPictureInPicture();
  } catch {
    showToast("Mini call is not available here", "info");
  }
}

export async function handleCallEvent(parts) {
  const eventType = parts[1];
  const callId = parts[2];
  const fromUsername = parts[3];
  const serverNow = Number(parts[4] || 0) || null;
  const encryptedPayload = parts[5];
  const fromPeerId = parts[6] || "";
  const fromPublicWire = parts[7] || "";
  const session = state.calls.sessions.get(callId);

  if (eventType === "invite") {
    let invite = null;

    try {
      invite = await decryptCallInvitePayload(callId, fromUsername, encryptedPayload, {
        username: fromUsername,
        peerId: fromPeerId,
        publicWire: fromPublicWire,
      });
    } catch {
      showToast("Could not read incoming call", "warning");
      return;
    }

    await handleIncomingInvite(invite.payload, fromUsername, serverNow, invite.directPeer);
    return;
  }

  if (eventType === "accept") {
    if (session) {
      session.accepted_at = Date.now();
      setCallStatus("Connecting...", "warn");

      if (callsUseBackendRelayOnly()) {
        session.backend_relay_waiting_for_accept = false;
        startBackendRelayFallback(session).catch(() => {
          session.call_state = "failed";
          session.ended_at = Date.now();
          setCallStatus("Could not connect", "bad");
        });
        return;
      }

      session.call_state = "connecting_p2p";
      scheduleP2PFallback(session);

      if (session.backend_relay_waiting_for_accept) {
        session.backend_relay_waiting_for_accept = false;
        startBackendRelayFallback(session).catch(() => {
          session.call_state = "failed";
          session.ended_at = Date.now();
          setCallStatus("Could not connect", "bad");
        });
      }
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

async function handleIncomingInvite(payload, fromUsername, serverNow, directPeer = null) {
  const callerUsername = payload.caller_username || fromUsername;
  const room = payload.room || payload.target || state.room;

  if (payload.call_kind === "direct" && directPeer && directPeer.peerId && directPeer.publicWire) {
    rememberDirectPeer(callerUsername, directPeer.peerId, directPeer.publicWire);
  }

  const session = createCallSession({
    call_id: payload.call_id,
    call_kind: payload.call_kind,
    caller_username: callerUsername,
    callee_username: state.username,
    target: payload.call_kind === "direct" ? callerUsername : room,
    room: payload.call_kind === "room" ? room : null,
    roomSecret: state.pendingRoomSecret || els.roomKey.value,
    peerId: directPeer ? directPeer.peerId : null,
    peerPublicWire: directPeer ? directPeer.publicWire : "",
    incoming: true,
  });
  session.server_now = serverNow;
  session.call_state = "ringing";
  addSystemMessage(`incoming call from ${callerUsername}`);
  showToast(`Incoming call from ${callerUsername}`, "info");
  setCallStatus("Incoming call", "warn");
  showIncomingCall(
    session,
    () => acceptIncomingCall(session).catch(() => {
      setCallStatus("Could not connect", "bad");
      showToast("Could not connect", "error");
    }),
    () => declineIncomingCall(session).catch(() => {})
  );
}

async function acceptIncomingCall(callSession) {
  if (!(await ensureServerSessionReady())) {
    return;
  }

  const media = await prepareCallMedia();

  if (!media.ok) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    return;
  }

  hideIncomingCall();
  callSession.media_mode = media.mediaMode;
  callSession.call_state = "connecting_p2p";
  callSession.accepted_at = Date.now();

  if (callSession.call_kind === "direct" && (!callSession.peerId || !callSession.peerPublicWire)) {
    const peer = await requestDirectPeer(callSession.caller_username, { fresh: true });
    callSession.peerId = peer.peerId;
    callSession.peerPublicWire = peer.publicWire;
    callSession.target = peer.username;
  }

  await sendCallAccept(callSession).catch(() => {});

  if (callsUseBackendRelayOnly()) {
    await startBackendRelayFallback(callSession);
    return;
  }

  const peers = callSession.call_kind === "room" ? [...state.peers.keys()] : null;
  const pendingPeers = callSession.call_kind === "room" ? peers : [callSession.peerId].filter(Boolean);
  let resumed = false;

  for (const peerId of pendingPeers) {
    resumed = await resumePendingRemoteOffer(peerId) || resumed;
  }

  if (resumed && callSession.call_kind === "direct") {
    scheduleP2PFallback(callSession);
    return;
  }

  await startP2PAttempt(callSession, peers, { sendInvite: false, mediaPrepared: true });
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

function handleP2PState(peerId, value, transport = null) {
  const callSession = state.calls.active;

  if (!callSession ||
      callSession.selected_transport === "server_relay" ||
      callSession.selected_transport === "backend_relay" ||
      callSession.call_state === "ended" ||
      callSession.call_state === "failed") {
    return;
  }

  if (value === "connected" || value === "completed") {
    if (callSession.relay_started_at && transport !== "server_relay") {
      return;
    }

    selectCallTransport(callSession, transport === "server_relay" ? "server_relay" : "p2p");
    return;
  }

  if ((value === "failed" || value === "disconnected") && callSession.call_state === "connecting_p2p") {
    if (!shouldStartP2PFallbackTimer(callSession)) {
      setCallStatus("Calling...", "warn");
      return;
    }

    callSession.call_state = "reconnecting";
    setCallStatus("Reconnecting...", "warn");
    setTimeout(() => {
      if (!callSession.selected_transport) {
        startRelayFallback(callSession).catch(() => {
          callSession.call_state = "failed";
          callSession.ended_at = Date.now();
          setCallStatus("Could not connect", "bad");
        });
      }
    }, 1000);
    return;
  }

  if ((value === "failed" || value === "disconnected") && callSession.call_state === "connecting_relay") {
    startBackendRelayFallback(callSession).catch(() => {
      callSession.call_state = "failed";
      callSession.ended_at = Date.now();
      setCallStatus("Could not connect", "bad");
    });
  }
}

export function incomingCallLabel(parts) {
  return parts && parts[3] ? `Incoming call from ${parts[3]}` : "Incoming call";
}
