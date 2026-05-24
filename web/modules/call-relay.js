import { state } from "./state.js";
import { sendWire } from "./wire.js";
import { encryptJson, decryptJson, derivePbkdf2Key } from "./crypto-box.js";
import { deriveDirectKey } from "./direct.js";

export async function sendCallInvite(callSession) {
  const payload = await encryptCallEventPayload(callSession, {
    type: "call_invite",
    call_id: callSession.call_id,
    call_kind: callSession.call_kind,
    caller_username: state.username,
    target: callSession.target || callSession.callee_username || callSession.room || "",
    room: callSession.call_kind === "room" ? callSession.room || callSession.target || null : null,
    callee_username: callSession.call_kind === "direct" ?
      callSession.callee_username || callSession.target || null :
      null,
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

export async function decryptCallInvitePayload(callId, fromUsername, encryptedPayload, senderPeer = null) {
  const roomResult = await tryDecryptCurrentRoomInvite(callId, encryptedPayload);

  if (roomResult) {
    return roomResult;
  }

  const directPeer = senderPeer && senderPeer.publicWire ?
    senderPeer :
    state.directPeers.get((fromUsername || "").toLowerCase()) || null;

  if (!directPeer || !directPeer.publicWire) {
    throw new Error("call invite direct key unavailable");
  }

  const key = await deriveDirectKey(directPeer.publicWire);
  const payload = await decryptJson(key, encryptedPayload);
  validateCallInvitePayload(payload, callId, "direct");
  return { payload, directPeer };
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

async function tryDecryptCurrentRoomInvite(callId, encryptedPayload) {
  if (!state.roomKeys || !state.roomKeys.signal) {
    return null;
  }

  try {
    const payload = await decryptJson(state.roomKeys.signal, encryptedPayload);
    validateCallInvitePayload(payload, callId, "room");
    return { payload, directPeer: null };
  } catch {
    return null;
  }
}

function validateCallInvitePayload(payload, callId, expectedKind) {
  if (!payload ||
      payload.type !== "call_invite" ||
      payload.call_id !== callId ||
      (payload.call_kind !== "direct" && payload.call_kind !== "room") ||
      (expectedKind && payload.call_kind !== expectedKind) ||
      typeof payload.caller_username !== "string" ||
      typeof payload.target !== "string" ||
      typeof payload.at !== "number") {
    throw new Error("invalid call invite payload");
  }

  if (payload.call_kind === "direct" &&
      payload.callee_username !== null &&
      typeof payload.callee_username !== "string") {
    throw new Error("invalid direct call invite payload");
  }

  if (payload.call_kind === "room" &&
      payload.room !== null &&
      typeof payload.room !== "string") {
    throw new Error("invalid room call invite payload");
  }
}
