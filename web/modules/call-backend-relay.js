import { state, backendRelayFallbackEnabled } from "./state.js";
import { els } from "./dom.js";
import { bytesToBase64Url, base64UrlToBytes, encryptJson, decryptJson, derivePbkdf2Key } from "./crypto-box.js";
import { deriveDirectKey } from "./direct.js";
import { sendWire } from "./wire.js";
import { showToast } from "./toast.js";
import { setCallStatus } from "./ui.js";

const MEDIA_CHUNK_MS = 250;
const MAX_MEDIA_CHUNK_BYTES = 128 * 1024;
const MAX_PLAYBACK_QUEUE = 64;
const MAX_BUFFER_SECONDS = 45;
const AUDIO_BITRATE = 32000;
const VIDEO_BITRATE = 360000;
const relaySessions = new Map();

export async function startBackendMediaRelay(callSession, options = {}) {
  if (!backendRelayFallbackEnabled() ||
      !callSession ||
      (callSession.call_kind !== "direct" && callSession.call_kind !== "room")) {
    return false;
  }

  if (callSession.selected_transport &&
      callSession.selected_transport !== "backend_relay") {
    return false;
  }

  const tracks = liveMediaTracks();

  if (tracks.audio.length === 0) {
    setCallStatus("Media unavailable", "bad");
    showToast("Microphone unavailable", "error");
    return false;
  }

  if (!window.MediaRecorder) {
    setCallStatus("Could not connect", "bad");
    showToast("Call could not connect", "warning");
    return false;
  }

  const relay = await ensureRelaySession(callSession, { role: "local" });

  if (!relay) {
    setCallStatus("Could not connect", "bad");
    showToast("Call could not connect", "warning");
    return false;
  }

  relay.mediaMode = tracks.video.length > 0 ? "audio_video" : "audio_only";
  callSession.media_mode = relay.mediaMode;
  markBackendRelayConnected(callSession, { ...options, mediaMode: relay.mediaMode });

  if (relay.recorder && relay.recorder.state === "recording") {
    return true;
  }

  const relayStream = new MediaStream([...tracks.audio, ...tracks.video]);
  const mimeType = chooseMediaMimeType(relay.mediaMode);
  const recorder = createMediaRecorder(relayStream, relay.mediaMode, mimeType);

  if (!recorder) {
    setCallStatus("Could not connect", "bad");
    showToast("Call could not connect", "warning");
    return false;
  }

  relay.recorder = recorder;
  relay.mimeType = recorder.mimeType || mimeType || defaultMimeType(relay.mediaMode);
  relay.stopped = false;

  recorder.ondataavailable = (event) => {
    if (relay.stopped || !event.data || event.data.size === 0) {
      return;
    }

    sendMediaChunk(relay, event.data).catch(() => {
      warnConnectionUnstable(relay);
    });
  };

  recorder.onerror = () => {
    warnConnectionUnstable(relay);
  };

  recorder.start(MEDIA_CHUNK_MS);
  return true;
}

export const startBackendAudioRelay = startBackendMediaRelay;

export async function handleBackendRelayFrame(parts) {
  const callId = parts[1] || "";
  const fromUsername = parts[2] || "";
  const sequence = parts[3] || "";
  const encryptedFrame = parts[4] || "";
  const callSession = state.calls.sessions.get(callId);

  if (!callSession ||
      (callSession.call_kind !== "direct" && callSession.call_kind !== "room") ||
      callSession.call_state === "ringing" ||
      callSession.call_state === "calling" ||
      callSession.call_state === "ended" ||
      callSession.call_state === "failed") {
    return;
  }

  if (callSession.selected_transport &&
      callSession.selected_transport !== "backend_relay") {
    return;
  }

  const relay = await ensureRelaySession(callSession, { role: "playback", fromUsername });

  if (!relay) {
    if (!callSession._backendRelayMissingKeyWarned) {
      callSession._backendRelayMissingKeyWarned = true;
      showToast("Call could not connect", "warning");
    }
    return;
  }

  const payload = await decryptJson(relay.key, encryptedFrame);

  if (!validMediaPayload(payload, callId, sequence)) {
    return;
  }

  if (!isExpectedSender(callSession, fromUsername)) {
    return;
  }

  markBackendRelayConnected(callSession, { silent: true, mediaMode: payload.media_mode });

  if (!hasLocalRecorder(callSession.call_id) && callSession.accepted_at) {
    startBackendMediaRelay(callSession, { silent: true }).catch(() => {});
  }

  enqueuePlayback(relay, base64UrlToBytes(payload.bytes), payload.mimeType || defaultMimeType(payload.media_mode), payload.media_mode);
}

export function stopBackendAudioRelay(callSession = null) {
  if (callSession) {
    for (const [key, relay] of [...relaySessions.entries()]) {
      if (!relay || relay.callId !== callSession.call_id) {
        continue;
      }

      stopRelaySession(relay);
      relaySessions.delete(key);
    }

    return;
  }

  for (const relay of relaySessions.values()) {
    stopRelaySession(relay);
  }

  relaySessions.clear();
}

export function handleBackendRelayRejected(parts) {
  const callId = parts[2] || "";
  const callSession = state.calls.sessions.get(callId);

  if (!callSession) {
    return;
  }

  stopBackendAudioRelay(callSession);
  callSession.call_state = "failed";
  callSession.ended_at = Date.now();
  setCallStatus("Could not connect", "bad");

  if (!callSession._backendRelayFailedToastShown) {
    callSession._backendRelayFailedToastShown = true;
    showToast("Call could not connect", "warning");
  }
}

async function ensureRelaySession(callSession, options = {}) {
  const key = await relayCryptoKey(callSession);

  if (!key) {
    return null;
  }

  const relayId = relaySessionId(callSession.call_id, options);
  let relay = relaySessions.get(relayId);

  if (!relay) {
    relay = {
      callSession,
      callId: callSession.call_id,
      relayId,
      fromUsername: options.fromUsername || "",
      key,
      sequence: 0,
      recorder: null,
      mimeType: defaultMimeType(callSession.media_mode || "audio_only"),
      mediaMode: callSession.media_mode || "audio_only",
      stopped: false,
      sendWarned: false,
      playWarned: false,
      appendQueue: [],
      blobQueue: [],
      mediaSource: null,
      sourceBuffer: null,
      playbackElement: null,
      playbackElementOwned: false,
      objectUrl: "",
      playbackMode: "",
      sourceMimeType: "",
      mseFailed: false,
      resumeArmed: false,
      currentBlobUrl: "",
      currentBlobElement: null,
    };
    relaySessions.set(relayId, relay);
  }

  if (!relay.key) {
    relay.key = key;
  }

  return relay;
}

async function relayCryptoKey(callSession) {
  if (callSession.call_kind === "direct") {
    return callSession.peerPublicWire ? deriveDirectKey(callSession.peerPublicWire) : null;
  }

  if (callSession.call_kind !== "room") {
    return null;
  }

  if (state.roomKeys && state.roomKeys.signal) {
    return state.roomKeys.signal;
  }

  const room = callSession.room || callSession.target || state.room || "";
  const secret = callSession.roomSecret || state.pendingRoomSecret || "";

  if (!room || !secret) {
    return null;
  }

  return derivePbkdf2Key(secret, `anonchat:${room}:signal-v2`);
}

function relaySessionId(callId, options = {}) {
  if (options.role === "playback") {
    return `${callId}:from:${String(options.fromUsername || "unknown").toLowerCase()}`;
  }

  return `${callId}:local`;
}

function hasLocalRecorder(callId) {
  const relay = relaySessions.get(relaySessionId(callId, { role: "local" }));
  return Boolean(relay && relay.recorder && relay.recorder.state === "recording");
}

async function sendMediaChunk(relay, blob) {
  if (!state.serverSessionReady ||
      !state.ws ||
      state.ws.readyState !== WebSocket.OPEN) {
    warnConnectionUnstable(relay);
    return;
  }

  if (blob.size > MAX_MEDIA_CHUNK_BYTES) {
    warnConnectionUnstable(relay);
    return;
  }

  const sequence = ++relay.sequence;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const payload = await encryptJson(relay.key, {
    type: "media_chunk",
    call_id: relay.callId,
    sequence,
    media_mode: relay.mediaMode,
    mimeType: relay.mimeType,
    sent_at: Date.now(),
    bytes: bytesToBase64Url(bytes),
  });

  sendWire(`CALL_RELAY|${relay.callId}|${sequence}|${payload}`);
}

function markBackendRelayConnected(callSession, options = {}) {
  if (!callSession) {
    return;
  }

  const mediaMode = options.mediaMode || callSession.media_mode || "audio_only";

  if (callSession.selected_transport === "backend_relay") {
    if (mediaMode === "audio_video" && callSession.media_mode !== "audio_video") {
      callSession.media_mode = "audio_video";
      setCallStatus("Video call connected", "good");
    }
    return;
  }

  if (callSession.selected_transport) {
    return;
  }

  callSession.call_state = "connected_backend_relay";
  callSession.selected_transport = "backend_relay";
  callSession.backend_relay_connected_at = Date.now();
  callSession.media_mode = mediaMode;
  clearTimeout(callSession.fallbackTimer);
  setCallStatus(mediaMode === "audio_video" ? "Video call connected" : "Audio call connected", "good");

  if (!options.silent && !callSession._backendRelayToastShown) {
    callSession._backendRelayToastShown = true;
    showToast(mediaMode === "audio_video" ? "Video relay call" : "Audio-only relay call", "info");
  }
}

function enqueuePlayback(relay, bytes, mimeType, mediaMode) {
  relay.mediaMode = mediaMode || relay.mediaMode || "audio_only";

  if (!relay.mseFailed &&
      window.MediaSource &&
      MediaSource.isTypeSupported(mimeType) &&
      (!relay.sourceMimeType || relay.sourceMimeType === mimeType)) {
    enqueueMediaSourcePlayback(relay, bytes, mimeType);
    return;
  }

  enqueueBlobPlayback(relay, bytes, mimeType);
}

function enqueueMediaSourcePlayback(relay, bytes, mimeType) {
  if (!relay.mediaSource) {
    relay.playbackMode = "mse";
    relay.sourceMimeType = mimeType;
    relay.mediaSource = new MediaSource();
    const element = ensurePlaybackElement(relay);
    relay.objectUrl = URL.createObjectURL(relay.mediaSource);
    element.src = relay.objectUrl;
    relay.mediaSource.addEventListener("sourceopen", () => {
      try {
        relay.sourceBuffer = relay.mediaSource.addSourceBuffer(mimeType);
        relay.sourceBuffer.mode = "sequence";
        relay.sourceBuffer.addEventListener("updateend", () => {
          trimBufferedMedia(relay);
          appendNextMediaChunk(relay);
        });
        appendNextMediaChunk(relay);
      } catch {
        relay.mseFailed = true;
        cleanupMediaSource(relay);
        relay.appendQueue = [];
        enqueueBlobPlayback(relay, bytes, mimeType);
      }
    }, { once: true });
    requestMediaPlayback(relay);
  }

  relay.appendQueue.push(bytes);

  while (relay.appendQueue.length > MAX_PLAYBACK_QUEUE) {
    relay.appendQueue.shift();
  }

  appendNextMediaChunk(relay);
}

function appendNextMediaChunk(relay) {
  if (!relay.sourceBuffer ||
      relay.sourceBuffer.updating ||
      relay.appendQueue.length === 0) {
    return;
  }

  try {
    relay.sourceBuffer.appendBuffer(relay.appendQueue.shift());
    requestMediaPlayback(relay);
  } catch {
    relay.appendQueue.shift();
  }
}

function trimBufferedMedia(relay) {
  const buffer = relay.sourceBuffer;
  const element = relay.playbackElement;

  if (!buffer || !element || buffer.updating || element.currentTime < MAX_BUFFER_SECONDS) {
    return;
  }

  try {
    buffer.remove(0, Math.max(0, element.currentTime - 20));
  } catch {
    // Playback can continue without trimming; queued chunks are still bounded.
  }
}

function enqueueBlobPlayback(relay, bytes, mimeType) {
  relay.playbackMode = "blob";
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  relay.blobQueue.push(url);

  while (relay.blobQueue.length > MAX_PLAYBACK_QUEUE) {
    URL.revokeObjectURL(relay.blobQueue.shift());
  }

  playNextBlob(relay);
}

function playNextBlob(relay) {
  if (relay.currentBlobElement || relay.blobQueue.length === 0) {
    return;
  }

  const url = relay.blobQueue.shift();
  const element = ensurePlaybackElement(relay);
  relay.currentBlobElement = element;
  relay.currentBlobUrl = url;

  const cleanup = () => {
    URL.revokeObjectURL(url);
    relay.currentBlobElement = null;
    relay.currentBlobUrl = "";
    playNextBlob(relay);
  };

  element.onended = cleanup;
  element.onerror = cleanup;
  element.src = url;
  requestMediaPlayback(relay, element);
}

function requestMediaPlayback(relay, element = relay.playbackElement) {
  if (!element) {
    return;
  }

  element.play().catch(() => {
    if (!relay.playWarned) {
      relay.playWarned = true;
      showToast("Tap to resume call", "warning");
    }

    if (relay.resumeArmed) {
      return;
    }

    relay.resumeArmed = true;
    const resume = () => {
      relay.resumeArmed = false;
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      element.play().catch(() => {});
    };

    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
  });
}

function ensurePlaybackElement(relay) {
  if (relay.playbackElement) {
    return relay.playbackElement;
  }

  if (relay.mediaMode === "audio_video") {
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.dataset.backendRelay = relay.callId;
    video.className = "backend-relay-video";
    relay.playbackElement = video;
    relay.playbackElementOwned = true;
    els.remoteVideos.appendChild(video);
    return video;
  }

  relay.playbackElement = new Audio();
  relay.playbackElement.autoplay = true;
  relay.playbackElementOwned = false;
  return relay.playbackElement;
}

function stopRelaySession(relay) {
  relay.stopped = true;

  if (relay.recorder && relay.recorder.state !== "inactive") {
    try {
      relay.recorder.stop();
    } catch {
      // Recorder may already be stopped by the browser.
    }
  }

  cleanupMediaSource(relay);

  if (relay.currentBlobElement) {
    relay.currentBlobElement.pause();
  }

  if (relay.currentBlobUrl) {
    URL.revokeObjectURL(relay.currentBlobUrl);
  }

  for (const url of relay.blobQueue) {
    URL.revokeObjectURL(url);
  }

  relay.appendQueue = [];
  relay.blobQueue = [];
}

function cleanupMediaSource(relay) {
  if (relay.playbackElement) {
    relay.playbackElement.pause();
    relay.playbackElement.removeAttribute("src");
    relay.playbackElement.load();

    if (relay.playbackElementOwned && relay.playbackElement.parentNode) {
      relay.playbackElement.remove();
    }

    relay.playbackElement = null;
    relay.playbackElementOwned = false;
  }

  if (relay.objectUrl) {
    URL.revokeObjectURL(relay.objectUrl);
    relay.objectUrl = "";
  }

  relay.mediaSource = null;
  relay.sourceBuffer = null;
  relay.sourceMimeType = "";
}

function validMediaPayload(payload, callId, sequence) {
  const legacyAudio = payload && payload.type === "audio_chunk";
  const mediaMode = legacyAudio ? "audio_only" : payload && payload.media_mode;

  if (legacyAudio && payload) {
    payload.media_mode = "audio_only";
  }

  return payload &&
    (payload.type === "media_chunk" || legacyAudio) &&
    payload.call_id === callId &&
    String(payload.sequence) === String(sequence) &&
    (mediaMode === "audio_only" || mediaMode === "audio_video") &&
    typeof payload.mimeType === "string" &&
    typeof payload.bytes === "string";
}

function liveMediaTracks() {
  if (!state.localStream) {
    return { audio: [], video: [] };
  }

  return {
    audio: state.localStream.getAudioTracks().filter((track) => track.readyState === "live"),
    video: state.localStream.getVideoTracks().filter((track) => track.readyState === "live" && track.enabled !== false),
  };
}

function chooseMediaMimeType(mediaMode) {
  const candidates = mediaMode === "audio_video" ? [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm",
  ] : [
    "audio/webm;codecs=opus",
    "audio/webm",
  ];

  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) {
    return "";
  }

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function createMediaRecorder(stream, mediaMode, mimeType) {
  const options = {};

  if (mimeType) {
    options.mimeType = mimeType;
  }

  if (mediaMode === "audio_video") {
    options.audioBitsPerSecond = AUDIO_BITRATE;
    options.videoBitsPerSecond = VIDEO_BITRATE;
  } else {
    options.audioBitsPerSecond = AUDIO_BITRATE;
  }

  try {
    return new MediaRecorder(stream, options);
  } catch {
    // Some browsers reject bitrate hints even when the MIME type is supported.
  }

  if (mimeType) {
    try {
      return new MediaRecorder(stream, { mimeType });
    } catch {
      // Fall through to browser defaults.
    }
  }

  try {
    return new MediaRecorder(stream);
  } catch {
    return null;
  }
}

function defaultMimeType(mediaMode) {
  return mediaMode === "audio_video" ? "video/webm" : "audio/webm";
}

function isExpectedSender(callSession, fromUsername) {
  if (!fromUsername) {
    return true;
  }

  const clean = fromUsername.toLowerCase();
  return clean === String(callSession.caller_username || "").toLowerCase() ||
    clean === String(callSession.target || "").toLowerCase() ||
    clean === String(callSession.callee_username || "").toLowerCase();
}

function warnConnectionUnstable(relay) {
  if (!relay.sendWarned) {
    relay.sendWarned = true;
    showToast("Connection unstable", "warning");
  }
}
