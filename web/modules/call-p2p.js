import { appConfig, state, cleanUsername, getIceServers } from "./state.js";
import { els } from "./dom.js";
import { encryptJson, decryptJson } from "./crypto-box.js";
import { sendWire } from "./wire.js";
import { rememberDirectPeer, deriveDirectKey } from "./direct.js";
import { notifyIfSubscribed } from "./notifications.js";
import { setupDataChannel } from "./files.js";
import { showToast } from "./toast.js";
import { addSystemMessage, setCallStatus } from "./ui.js";

let peerCallHandler = null;

export function setPeerCallHandler(handler) {
  peerCallHandler = handler;
}

export function rtcConfig(options = {}) {
  const config = {
    iceServers: getIceServers(),
    iceCandidatePoolSize: Number(appConfig.iceCandidatePoolSize || 0),
  };

  if (options.relayOnly) {
    config.iceTransportPolicy = "relay";
  } else if (appConfig.iceTransportPolicy) {
    config.iceTransportPolicy = appConfig.iceTransportPolicy;
  }

  return config;
}

export function ensurePeerConnection(peerId, options = {}) {
  const existing = state.pcs.get(peerId);

  if (existing && !options.forceNew && !(options.relayOnly && !existing._relayOnly)) {
    updatePeerConnectionMode(existing, options);
    return existing;
  }

  if (existing) {
    closePeer(peerId);
  }

  return createPeerConnection(peerId, options);
}

export function createRelayPeerConnection(peerId, options = {}) {
  return ensurePeerConnection(peerId, { ...options, relayOnly: true, forceNew: true });
}

function createPeerConnection(peerId, options = {}) {
  const pc = new RTCPeerConnection(rtcConfig(options));
  pc._makingOffer = false;
  pc._ignoreOffer = false;
  pc._isSettingRemoteAnswerPending = false;
  pc._pendingCandidates = [];
  pc._pendingRemoteOffer = null;
  updatePeerConnectionMode(pc, options);

  pc.onnegotiationneeded = async () => {
    try {
      await negotiate(peerId);
    } catch {
      addSystemMessage("call could not start");
      setCallStatus("Could not connect", "bad");
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendRtcSignal(peerId, { type: "candidate", candidate: event.candidate }).catch(() => {
        addSystemMessage("call could not connect");
      });
    }
  };

  pc.onconnectionstatechange = () => {
    handlePeerConnectionState(peerId, pc.connectionState);
    renderPeers();
  };
  pc.oniceconnectionstatechange = () => {
    handlePeerConnectionState(peerId, pc.iceConnectionState);
    renderPeers();
  };
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

  pc._relayOnly = options.relayOnly === true || pc._relayOnly === true;
}

export async function negotiate(peerId) {
  const pc = ensurePeerConnection(peerId);

  if (pc._makingOffer || pc.signalingState !== "stable") {
    return;
  }

  try {
    pc._makingOffer = true;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendRtcSignal(peerId, {
      description: pc.localDescription,
      relayOnly: pc._relayOnly === true,
    });
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

export async function handleSignal(peerId, payload) {
  if (!state.roomKeys || !state.roomKeys.signal) {
    addSystemMessage("encrypted call setup ignored before room key was set");
    return;
  }

  const pc = ensurePeerConnection(peerId);
  const signal = await decryptJson(state.roomKeys.signal, payload);
  await handleRtcSignal(peerId, pc, signal);
}

export async function handleDirectSignal(username, peerId, publicWire, payload) {
  rememberDirectPeer(username, peerId, publicWire);
  const pc = ensurePeerConnection(peerId, { kind: "direct", username, publicWire });
  const key = await deriveDirectKey(publicWire);
  const signal = await decryptJson(key, payload);
  await handleRtcSignal(peerId, pc, signal);
}

async function handleRtcSignal(peerId, pc, signal) {
  const description = signal.description || (signal.sdp ? { type: signal.type, sdp: signal.sdp } : null);

  if (description) {
    if (description.type === "offer" && signal.relayOnly && !pc._relayOnly) {
      pc = createRelayPeerConnection(peerId, {
        kind: pc._signalKind,
        username: pc._directUsername,
        publicWire: pc._directPublicWire,
      });
    }

    const readyForOffer =
      !pc._makingOffer &&
      (pc.signalingState === "stable" || pc._isSettingRemoteAnswerPending);
    const offerCollision = description.type === "offer" && !readyForOffer;
    const polite = state.peerId > peerId;

    pc._ignoreOffer = !polite && offerCollision;

    if (pc._ignoreOffer) {
      return;
    }

    if (description.type === "offer" && shouldHoldIncomingOffer(peerId)) {
      pc._pendingRemoteOffer = signal;
      addSystemMessage(`incoming call from ${peerLabel(peerId)}`);
      setCallStatus(`Incoming from ${peerLabel(peerId)}`, "warn");
      await notifyIfSubscribed("Incoming call", peerLabel(peerId), `call:${peerId}`);
      return;
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

export async function resumePendingRemoteOffer(peerId) {
  const pc = state.pcs.get(peerId);

  if (!pc || !pc._pendingRemoteOffer || !state.localStream) {
    return false;
  }

  const signal = pc._pendingRemoteOffer;
  pc._pendingRemoteOffer = null;
  await handleRtcSignal(peerId, pc, signal);
  return true;
}

export function peerLabel(peerId) {
  const peer = state.peers.get(peerId);
  return peer ? peer.username : state.directPeerIds.get(peerId) || peerId;
}

export function addLocalTracksTo(pc) {
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

export async function prepareCallMedia() {
  if (hasUsableAudio(state.localStream)) {
    attachLocalPreview(state.localStream);
    return {
      ok: true,
      stream: state.localStream,
      mediaMode: hasUsableVideo(state.localStream) ? "audio_video" : "audio_only",
      reason: null,
    };
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    addSystemMessage("microphone needs HTTPS or localhost");
    setCallStatus("Media unavailable", "bad");
    showToast("Microphone unavailable", "error");
    return { ok: false, stream: null, mediaMode: null, reason: "media_devices_unavailable" };
  }

  setCallStatus("Allow microphone and camera", "warn");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    state.localStream = stream;
    attachLocalPreview(stream);
    setCallStatus("Connecting securely...", "warn");
    return { ok: true, stream, mediaMode: "audio_video", reason: null };
  } catch (error) {
    if (!shouldRetryAudioOnly(error)) {
      return failCallMedia(error);
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.localStream = stream;
    attachLocalPreview(stream);
    showToast("Audio-only call", "info");
    setCallStatus("Audio-only call", "warn");
    return { ok: true, stream, mediaMode: "audio_only", reason: null };
  } catch (error) {
    return failCallMedia(error);
  }
}

function shouldHoldIncomingOffer(peerId) {
  const activeCall = state.calls.active;

  if (!state.localStream) {
    return true;
  }

  return Boolean(
    activeCall &&
    activeCall.incoming &&
    activeCall.call_state === "ringing" &&
    (!activeCall.peerId || activeCall.peerId === peerId)
  );
}

export async function ensureLocalMedia() {
  return (await prepareCallMedia()).ok;
}

function attachLocalPreview(stream) {
  if (!els.localVideo) {
    return;
  }

  els.localVideo.srcObject = hasUsableVideo(stream) ? stream : null;
}

function hasUsableAudio(stream) {
  return Boolean(stream && stream.getAudioTracks().some((track) => track.readyState === "live"));
}

function hasUsableVideo(stream) {
  return Boolean(stream && stream.getVideoTracks().some((track) => track.readyState === "live"));
}

function shouldRetryAudioOnly(error) {
  const name = error && error.name;
  return name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError" ||
    name === "NotReadableError" ||
    name === "TrackStartError";
}

function failCallMedia(error) {
  const name = error && error.name;

  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    addSystemMessage("microphone permission is blocked");
    showToast("Call permission denied", "error");
    setCallStatus("Media blocked", "bad");
    return { ok: false, stream: null, mediaMode: null, reason: "permission_denied" };
  }

  addSystemMessage("microphone unavailable");
  showToast("Microphone unavailable", "error");
  setCallStatus("Media unavailable", "bad");
  return { ok: false, stream: null, mediaMode: null, reason: "microphone_unavailable" };
}

export function closePeer(peerId) {
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

export function resetPeerConnections() {
  for (const peerId of [...state.pcs.keys()]) {
    closePeer(peerId);
  }

  els.remoteVideos.textContent = "";
}

export function stopP2PMedia() {
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      track.stop();
    }
  }

  state.localStream = null;
  els.localVideo.srcObject = null;
  els.remoteVideos.textContent = "";
  resetPeerConnections();
}

export function addPeer(peerId, username) {
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

export function removePeer(peerId) {
  const peer = state.peers.get(peerId);

  if (peer) {
    addSystemMessage(`${peer.username} left`);
  }

  state.peers.delete(peerId);
  closePeer(peerId);
  renderPeers();
}

export function renderPeers() {
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
    callButton.onclick = () => {
      if (peerCallHandler) {
        peerCallHandler(peerId);
      }
    };

    const meta = document.createElement("span");
    const pc = state.pcs.get(peerId);
    const channel = state.channels.get(peerId);
    const rtc = pc ? pc.connectionState : "new";
    const data = channel ? channel.readyState : "closed";
    meta.textContent = rtc === "connected" || data === "open" ? "Ready" : "Waiting";

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

function handlePeerConnectionState(peerId, value) {
  if (value === "connected" || value === "completed") {
    detectSelectedTransport(state.pcs.get(peerId)).then((transport) => {
      window.dispatchEvent(new CustomEvent("anonchat:p2p-state", { detail: { peerId, state: value, transport } }));
      if (transport === "server_relay") {
        setCallStatus("Connected", "good");
        showToast("Connected through relay", "success");
      } else if (transport === "p2p") {
        setCallStatus("Connected", "good");
        showToast("Connected directly", "success");
      } else if (state.pcs.get(peerId)?._relayOnly) {
        setCallStatus("Confirming relay...", "warn");
      } else {
        setCallStatus("Connected", "good");
      }
    });
  } else if (value === "failed") {
    window.dispatchEvent(new CustomEvent("anonchat:p2p-state", { detail: { peerId, state: value } }));
    setCallStatus("Reconnecting...", "warn");
  } else if (value === "disconnected") {
    window.dispatchEvent(new CustomEvent("anonchat:p2p-state", { detail: { peerId, state: value } }));
    setCallStatus("Reconnecting...", "warn");
  } else if (value === "closed") {
    window.dispatchEvent(new CustomEvent("anonchat:p2p-state", { detail: { peerId, state: value } }));
    setCallStatus("idle");
  } else {
    window.dispatchEvent(new CustomEvent("anonchat:p2p-state", { detail: { peerId, state: value } }));
  }
}

async function detectSelectedTransport(pc) {
  if (!pc || !pc.getStats) {
    return null;
  }

  try {
    const stats = await pc.getStats();
    let pair = null;

    stats.forEach((entry) => {
      if (entry.type === "candidate-pair" && (entry.selected || entry.nominated)) {
        pair = entry;
      }
    });

    if (!pair) {
      return null;
    }

    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    return (local && local.candidateType === "relay") ||
      (remote && remote.candidateType === "relay") ? "server_relay" : "p2p";
  } catch {
    return null;
  }
}
