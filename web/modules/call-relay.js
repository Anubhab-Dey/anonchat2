import { state } from "./state.js";
import { sendWire } from "./wire.js";
import { encryptJson, decryptJson, derivePbkdf2Key } from "./crypto-box.js";
import { deriveDirectKey } from "./direct.js";
import { showToast } from "./toast.js";
import { setCallStatus } from "./ui.js";

export async function startRelayFallback(callSession) {
  if (!callSession || callSession.selected_transport) {
    return;
  }

  callSession.call_state = "connecting_relay";
  callSession.selected_transport = "server_relay";
  callSession.relay_started_at = Date.now();
  setCallStatus("Connecting securely...", "warn");
  showToast("P2P failed, using secure relay", "warning");

  const payload = await encryptRelayPayload(callSession, {
    type: "relay_prepare",
    call_id: callSession.call_id,
    at: Date.now(),
  });

  sendWire(`CALL_INVITE|${callSession.call_id}|${callSession.call_kind}|${callSession.target}|${payload}`);

  // Media relay is intentionally not faked in this pass. The protocol and state
  // path are in place; encoded media frame production is the deferred step.
  callSession.call_state = "failed";
  callSession.ended_at = Date.now();
  setCallStatus("Call failed", "bad");
  showToast("Secure relay media is not enabled yet", "warning");
}

export async function handleCallEvent(parts) {
  const eventType = parts[1];
  const callId = parts[2];
  const fromUsername = parts[3];
  const payload = parts[5];
  const session = state.calls.sessions.get(callId);

  if (!session || !payload) {
    return;
  }

  await decryptRelayPayload(session, payload).catch(() => null);

  if (eventType === "end" || eventType === "decline") {
    session.call_state = "ended";
    session.ended_at = Date.now();
    setCallStatus("Call ended");
  } else if (eventType === "invite") {
    showToast(`Incoming call from ${fromUsername}`, "info");
  }
}

export async function handleRelayFrame(parts) {
  const callId = parts[1];
  const session = state.calls.sessions.get(callId);

  if (!session) {
    return;
  }

  // Opaque encrypted relay frames route through the server now. Browser encoded
  // media frame integration is deferred, so there is no media payload to play yet.
}

async function relayKey(callSession) {
  if (callSession.call_kind === "direct" && callSession.peerPublicWire) {
    return deriveDirectKey(callSession.peerPublicWire);
  }

  return derivePbkdf2Key(callSession.roomSecret || "", `anonchat:${callSession.room || ""}:relay-v1`);
}

async function encryptRelayPayload(callSession, value) {
  return encryptJson(await relayKey(callSession), value);
}

async function decryptRelayPayload(callSession, payload) {
  return decryptJson(await relayKey(callSession), payload);
}
