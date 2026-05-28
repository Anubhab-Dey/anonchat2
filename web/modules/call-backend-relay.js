import { state, backendRelayFallbackEnabled } from "./state.js";
import { bytesToBase64Url, base64UrlToBytes, encryptJson, decryptJson } from "./crypto-box.js";
import { deriveDirectKey } from "./direct.js";
import { sendWire } from "./wire.js";
import { showToast } from "./toast.js";
import { setCallStatus } from "./ui.js";

const AUDIO_CHUNK_MS = 500;
const MAX_AUDIO_CHUNK_BYTES = 128 * 1024;
const MAX_PLAYBACK_QUEUE = 48;
const MAX_BUFFER_SECONDS = 45;
const relaySessions = new Map();

export async function startBackendAudioRelay(callSession, options = {}) {
  if (!backendRelayFallbackEnabled() || !callSession || callSession.call_kind !== "direct") {
    return false;
  }

  if (callSession.selected_transport &&
      callSession.selected_transport !== "backend_relay") {
    return false;
  }

  const audioTracks = liveAudioTracks();

  if (audioTracks.length === 0) {
    setCallStatus("Media unavailable", "bad");
    showToast("Microphone unavailable", "error");
    return false;
  }

  if (!window.MediaRecorder) {
    setCallStatus("Could not connect", "bad");
    showToast("Call could not connect", "warning");
    return false;
  }

  const relay = await ensureRelaySession(callSession);

  if (!relay) {
    setCallStatus("Could not connect", "bad");
    showToast("Call could not connect", "warning");
    return false;
  }

  markBackendRelayConnected(callSession, options);

  if (relay.recorder && relay.recorder.state === "recording") {
    return true;
  }

  const audioStream = new MediaStream(audioTracks);
  const mimeType = chooseAudioMimeType();
  const recorderOptions = mimeType ? { mimeType } : undefined;
  const recorder = new MediaRecorder(audioStream, recorderOptions);

  relay.recorder = recorder;
  relay.mimeType = recorder.mimeType || mimeType || "audio/webm";
  relay.stopped = false;

  recorder.ondataavailable = (event) => {
    if (relay.stopped || !event.data || event.data.size === 0) {
      return;
    }

    sendAudioChunk(relay, event.data).catch(() => {
      if (!relay.sendWarned) {
        relay.sendWarned = true;
        showToast("Connection unstable", "warning");
      }
    });
  };

  recorder.onerror = () => {
    if (!relay.sendWarned) {
      relay.sendWarned = true;
      showToast("Connection unstable", "warning");
    }
  };

  recorder.start(AUDIO_CHUNK_MS);
  return true;
}

export async function handleBackendRelayFrame(parts) {
  const callId = parts[1] || "";
  const fromUsername = parts[2] || "";
  const sequence = parts[3] || "";
  const encryptedFrame = parts[4] || "";
  const callSession = state.calls.sessions.get(callId);

  if (!callSession ||
      callSession.call_kind !== "direct" ||
      callSession.call_state === "ringing" ||
      callSession.call_state === "ended" ||
      callSession.call_state === "failed") {
    return;
  }

  if (callSession.selected_transport &&
      callSession.selected_transport !== "backend_relay") {
    return;
  }

  const relay = await ensureRelaySession(callSession);

  if (!relay) {
    if (!callSession._backendRelayMissingKeyWarned) {
      callSession._backendRelayMissingKeyWarned = true;
      showToast("Call could not connect", "warning");
    }
    return;
  }

  const payload = await decryptJson(relay.key, encryptedFrame);

  if (!validAudioPayload(payload, callId, sequence)) {
    return;
  }

  if (fromUsername && fromUsername !== callSession.caller_username && fromUsername !== callSession.target) {
    return;
  }

  markBackendRelayConnected(callSession, { silent: true });

  if (!relay.recorder && callSession.accepted_at) {
    startBackendAudioRelay(callSession, { silent: true }).catch(() => {});
  }

  enqueuePlayback(relay, base64UrlToBytes(payload.bytes), payload.mimeType || "audio/webm");
}

export function stopBackendAudioRelay(callSession = null) {
  if (callSession) {
    const relay = relaySessions.get(callSession.call_id);

    if (relay) {
      stopRelaySession(relay);
      relaySessions.delete(callSession.call_id);
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

async function ensureRelaySession(callSession) {
  if (!callSession.peerPublicWire) {
    return null;
  }

  let relay = relaySessions.get(callSession.call_id);

  if (!relay) {
    relay = {
      callSession,
      callId: callSession.call_id,
      key: null,
      sequence: 0,
      recorder: null,
      mimeType: "audio/webm",
      stopped: false,
      sendWarned: false,
      playWarned: false,
      appendQueue: [],
      blobQueue: [],
      mediaSource: null,
      sourceBuffer: null,
      audio: null,
      objectUrl: "",
      playbackMode: "",
      mseFailed: false,
      resumeArmed: false,
      currentBlobUrl: "",
      currentAudio: null,
    };
    relaySessions.set(callSession.call_id, relay);
  }

  if (!relay.key) {
    relay.key = await deriveDirectKey(callSession.peerPublicWire);
  }

  return relay;
}

async function sendAudioChunk(relay, blob) {
  if (!state.serverSessionReady ||
      !state.ws ||
      state.ws.readyState !== WebSocket.OPEN) {
    if (!relay.sendWarned) {
      relay.sendWarned = true;
      showToast("Connection unstable", "warning");
    }
    return;
  }

  if (blob.size > MAX_AUDIO_CHUNK_BYTES) {
    if (!relay.sendWarned) {
      relay.sendWarned = true;
      showToast("Connection unstable", "warning");
    }
    return;
  }

  const sequence = ++relay.sequence;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const payload = await encryptJson(relay.key, {
    type: "audio_chunk",
    call_id: relay.callId,
    sequence,
    media_mode: "audio_only",
    mimeType: relay.mimeType,
    sent_at: Date.now(),
    bytes: bytesToBase64Url(bytes),
  });

  sendWire(`CALL_RELAY|${relay.callId}|${sequence}|${payload}`);
}

function markBackendRelayConnected(callSession, options = {}) {
  if (!callSession || callSession.selected_transport === "backend_relay") {
    return;
  }

  callSession.call_state = "connected_backend_relay";
  callSession.selected_transport = "backend_relay";
  callSession.backend_relay_connected_at = Date.now();
  callSession.media_mode = "audio_only";
  clearTimeout(callSession.fallbackTimer);
  setCallStatus("Audio call connected", "good");

  if (!options.silent && !callSession._backendRelayToastShown) {
    callSession._backendRelayToastShown = true;
    showToast("Audio-only call", "info");
  }
}

function enqueuePlayback(relay, bytes, mimeType) {
  if (!relay.mseFailed && window.MediaSource && MediaSource.isTypeSupported(mimeType)) {
    enqueueMediaSourcePlayback(relay, bytes, mimeType);
    return;
  }

  enqueueBlobPlayback(relay, bytes, mimeType);
}

function enqueueMediaSourcePlayback(relay, bytes, mimeType) {
  if (!relay.mediaSource) {
    relay.playbackMode = "mse";
    relay.mediaSource = new MediaSource();
    relay.audio = new Audio();
    relay.audio.autoplay = true;
    relay.objectUrl = URL.createObjectURL(relay.mediaSource);
    relay.audio.src = relay.objectUrl;
    relay.mediaSource.addEventListener("sourceopen", () => {
      try {
        relay.sourceBuffer = relay.mediaSource.addSourceBuffer(mimeType);
        relay.sourceBuffer.mode = "sequence";
        relay.sourceBuffer.addEventListener("updateend", () => {
          trimBufferedAudio(relay);
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
    requestAudioPlayback(relay);
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
    requestAudioPlayback(relay);
  } catch {
    relay.appendQueue.shift();
  }
}

function trimBufferedAudio(relay) {
  const buffer = relay.sourceBuffer;
  const audio = relay.audio;

  if (!buffer || !audio || buffer.updating || audio.currentTime < MAX_BUFFER_SECONDS) {
    return;
  }

  try {
    buffer.remove(0, Math.max(0, audio.currentTime - 20));
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
  if (relay.currentAudio || relay.blobQueue.length === 0) {
    return;
  }

  const url = relay.blobQueue.shift();
  const audio = new Audio(url);
  relay.currentAudio = audio;
  relay.currentBlobUrl = url;

  const cleanup = () => {
    URL.revokeObjectURL(url);
    relay.currentAudio = null;
    relay.currentBlobUrl = "";
    playNextBlob(relay);
  };

  audio.onended = cleanup;
  audio.onerror = cleanup;
  requestAudioPlayback(relay, audio);
}

function requestAudioPlayback(relay, audio = relay.audio) {
  if (!audio) {
    return;
  }

  audio.play().catch(() => {
    if (!relay.playWarned) {
      relay.playWarned = true;
      showToast("Tap to resume audio", "warning");
    }

    if (relay.resumeArmed) {
      return;
    }

    relay.resumeArmed = true;
    const resume = () => {
      relay.resumeArmed = false;
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      audio.play().catch(() => {});
    };

    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
  });
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

  if (relay.currentAudio) {
    relay.currentAudio.pause();
  }

  if (relay.objectUrl) {
    URL.revokeObjectURL(relay.objectUrl);
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
  if (relay.audio) {
    relay.audio.pause();
    relay.audio.removeAttribute("src");
    relay.audio.load();
    relay.audio = null;
  }

  if (relay.objectUrl) {
    URL.revokeObjectURL(relay.objectUrl);
    relay.objectUrl = "";
  }

  relay.mediaSource = null;
  relay.sourceBuffer = null;
}

function validAudioPayload(payload, callId, sequence) {
  return payload &&
    payload.type === "audio_chunk" &&
    payload.call_id === callId &&
    String(payload.sequence) === String(sequence) &&
    payload.media_mode === "audio_only" &&
    typeof payload.mimeType === "string" &&
    typeof payload.bytes === "string";
}

function liveAudioTracks() {
  if (!state.localStream) {
    return [];
  }

  return state.localStream.getAudioTracks().filter((track) => track.readyState === "live");
}

function chooseAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
  ];

  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) {
    return "";
  }

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}
