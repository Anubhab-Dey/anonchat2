import { state } from "./state.js";
import { sendWire } from "./wire.js";
import { encryptJson, decryptJson, derivePbkdf2Key } from "./crypto-box.js";
import { deriveDirectKey } from "./direct.js";
import { showToast } from "./toast.js";
import { addSystemMessage, setCallStatus } from "./ui.js";

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

export function markTurnFallback(callSession) {
  if (!callSession || callSession.selected_transport) {
    return;
  }

  callSession.call_state = "connecting_relay";
  callSession.relay_started_at = Date.now();
  setCallStatus("Connecting securely...", "warn");
  showToast("Trying relayed connection", "info");
}

export async function handleCallEvent(parts) {
  const eventType = parts[1];
  const callId = parts[2];
  const fromUsername = parts[3];
  const payload = parts[5];
  const session = state.calls.sessions.get(callId);

  if (session && payload) {
    await decryptCallEventPayload(session, payload).catch(() => null);
  }

  if (eventType === "invite") {
    addSystemMessage(`incoming call from ${fromUsername}`);
    showToast(`Incoming call from ${fromUsername}`, "info");
    setCallStatus("Incoming call", "warn");
    return;
  }

  if (eventType === "end" || eventType === "decline") {
    if (session) {
      session.call_state = "ended";
      session.ended_at = Date.now();
    }
    setCallStatus("Call ended");
  }
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

async function decryptCallEventPayload(callSession, payload) {
  return decryptJson(await eventKey(callSession), payload);
}
