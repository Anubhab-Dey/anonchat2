import { state, cleanRoomName, currentAccountKey, roomConversationId } from "./state.js";
import { els } from "./dom.js";
import { randomKey, derivePbkdf2Key, encryptJson, decryptJson } from "./crypto-box.js";
import { sendWire } from "./wire.js";
import { showToast } from "./toast.js";
import { upsertConversation, persistMessage, updateMessageStatus, setActiveConversationHeader, renderConversationHistory } from "./conversations.js";
import { notifyIfSubscribed } from "./notifications.js";

export function roomInviteUrl() {
  const room = cleanRoomName(els.room.value || "lobby");
  const key = els.roomKey.value;
  const params = new URLSearchParams();
  params.set("room", room);

  if (key) {
    params.set("key", key);
  }

  return `${location.origin}${location.pathname}#${params.toString()}`;
}

export function updateInvite() {
  els.inviteLink.value = roomInviteUrl();
}

export function loadInitialRoomInputs() {
  const params = new URLSearchParams(location.hash.slice(1));
  const invitedRoom = params.get("room");
  const invitedKey = params.get("key");
  const savedRoom = localStorage.getItem(roomStorageKey());

  if (invitedRoom) {
    els.room.value = cleanRoomName(invitedRoom);
  } else if (savedRoom) {
    els.room.value = savedRoom;
  }

  if (invitedKey) {
    els.roomKey.value = invitedKey;
  }

  updateInvite();
}

export async function deriveRoomKeys(room, secret) {
  const [chat, signal, file] = await Promise.all([
    derivePbkdf2Key(secret, `anonchat:${room}:chat-v2`),
    derivePbkdf2Key(secret, `anonchat:${room}:signal-v2`),
    derivePbkdf2Key(secret, `anonchat:${room}:file-v2`),
  ]);
  return { chat, signal, file };
}

export async function joinRoom() {
  if (!state.authenticated) {
    showToast("Sign in first", "warning");
    return;
  }

  const room = cleanRoomName(els.room.value);
  const secret = els.roomKey.value;

  if (!room) {
    showToast("Enter a room name", "warning");
    return;
  }

  if (!secret) {
    if (els.roomAdvanced) {
      els.roomAdvanced.open = true;
    }

    els.roomKey.focus();
    showToast("Enter the room password", "warning");
    return;
  }

  els.room.value = room;
  state.roomKeys = await deriveRoomKeys(room, secret);
  state.roomKey = state.roomKeys.chat;
  state.pendingRoomSecret = secret;
  sendWire(`JOIN|${room}`);
}

export async function handleRoomJoined(room, peerId) {
  state.room = room;
  state.peerId = peerId;
  state.peers.clear();
  const storageKey = roomStorageKey();

  if (storageKey) {
    localStorage.setItem(storageKey, room);
  }
  const conversation = await upsertConversation({
    id: roomConversationId(room),
    kind: "room",
    title: room,
    room,
    roomKey: state.pendingRoomSecret || els.roomKey.value,
    preview: "room joined",
    updatedAt: Date.now(),
  });
  state.activeConversationId = conversation.id;
  setActiveConversationHeader(conversation);
  await renderConversationHistory(conversation.id);
  updateInvite();
  showToast(`Entered ${room}`, "success");
}

export function createNewRoom() {
  const suffix = randomKey(6).toLowerCase();
  els.room.value = `room-${suffix}`;
  els.roomKey.value = randomKey(24);
  updateInvite();
  showToast("Private room ready", "success");
}

export async function copyInvite() {
  updateInvite();

  try {
    if (navigator.share) {
      await navigator.share({
        title: "AnonChat invite",
        text: "Join my private room",
        url: els.inviteLink.value,
      });
      showToast("Invite shared", "success");
      return;
    }

    await navigator.clipboard.writeText(els.inviteLink.value);
    showToast("Invite copied", "success");
  } catch {
    els.inviteLink.focus();
    els.inviteLink.select();
    document.execCommand("copy");
    showToast("Invite selected", "info");
  }
}

export async function sendRoomChat(text) {
  if (!state.room || !state.roomKey) {
    showToast("Enter a room first", "warning");
    return;
  }

  const id = crypto.randomUUID();
  const created = Date.now();
  await persistMessage(roomConversationId(state.room), {
    id,
    direction: "out",
    sender: state.username,
    text,
    client_created_at: created,
    status: "pending",
  });
  const payload = await encryptJson(state.roomKeys.chat, {
    id,
    sender: state.username,
    text,
    client_created_at: created,
  });
  state.pendingAcks.chat.push(id);
  sendWire(`CHAT|${state.room}|${payload}`);
  await updateMessageStatus(id, { client_sent_at: Date.now() });
}

export async function handleChatAck(serverSentAt) {
  const id = state.pendingAcks.chat.shift();

  if (!id) {
    return;
  }

  await updateMessageStatus(id, {
    status: "sent",
    server_sent_at: Number(serverSentAt || 0) || null,
  });
}

export async function handleRoomChat(peerId, payload) {
  if (!state.roomKeys || !state.roomKeys.chat) {
    showToast("Encrypted room message ignored before room key", "warning");
    return;
  }

  const message = await decryptJson(state.roomKeys.chat, payload);
  const peer = state.peers.get(peerId);
  const sender = peer ? peer.username : peerId;

  await persistMessage(roomConversationId(state.room), {
    id: message.id || crypto.randomUUID(),
    direction: "in",
    sender,
    text: message.text,
    client_created_at: message.client_created_at || null,
    status: "received",
  });
  await notifyIfSubscribed(`${sender} in ${state.room}`, message.text, roomConversationId(state.room));
}

export async function openRoomFromConversation(event) {
  const { conversation, join } = event.detail;
  updateInvite();

  if (join && state.authenticated && conversation.roomKey) {
    await joinRoom();
  }
}

function roomStorageKey() {
  const accountKey = currentAccountKey();
  return accountKey ? `anonchat.room.${accountKey}` : "";
}
