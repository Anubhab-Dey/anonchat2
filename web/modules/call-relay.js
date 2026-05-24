import { state, hasTurnRelayConfigured } from "./state.js";
import { sendWire } from "./wire.js";
import { encryptJson, derivePbkdf2Key } from "./crypto-box.js";
import { deriveDirectKey } from "./direct.js";
import { showToast } from "./toast.js";
import { setCallStatus } from "./ui.js";

export async function sendCallInvite(callSession) {
  const payload = await encryptCallEventPayload(callSession, {
    type: "call_invite",
    call_id: callSession.call_id,
    call_kind: callSession.call_kind,
    caller_username: state.username,
    at: Date.now(),
  });
  sendWire(`CALL_INVITE|${callSession.call_id}|${callSession.call_kind}|${callSession.target}|${payload}`);
}

export async function sendCallEnd(callSession) {
  if (!callSession) {
    return;
  }

  const payload = await encryptCallEventPayload(callSession, {
    type: "call_end",
    call_id: callSession.call_id,
    at: Date.now(),
  });
  sendWire(`CALL_END|${callSession.call_id}|${payload}`);
}

export async function sendCallAccept(callSession) {
  const payload = await encryptCallEventPayload(callSession, {
    type: "call_accept",
    call_id: callSession.call_id,
    at: Date.now(),
  });
  sendWire(`CALL_ACCEPT|${callSession.call_id}|${payload}`);
}

export async function sendCallDecline(callSession) {
  const payload = await encryptCallEventPayload(callSession, {
    type: "call_decline",
    call_id: callSession.call_id,
    at: Date.now(),
  });
  sendWire(`CALL_DECLINE|${callSession.call_id}|${payload}`);
}

export function markTurnFallback(callSession) {
  if (!callSession || callSession.selected_transport) {
    return;
  }

  if (!hasTurnRelayConfigured()) {
    callSession.call_state = "failed";
    callSession.ended_at = Date.now();
    setCallStatus("Could not connect", "bad");
    showToast("Relay unavailable", "warning");
    return;
  }

  callSession.call_state = "connecting_relay";
  callSession.relay_started_at = Date.now();
  setCallStatus("Connecting securely...", "warn");
  showToast("Trying relayed connection", "info");
}

async function eventKey(callSession) {
  if (callSession.call_kind === "direct" && callSession.peerPublicWire) {
    return deriveDirectKey(callSession.peerPublicWire);
  }

  return derivePbkdf2Key(callSession.roomSecret || "", `anonchat:${callSession.room || ""}:signal-v2`);
}

async function encryptCallEventPayload(callSession, value) {
  return encryptJson(await eventKey(callSession), value);
}
