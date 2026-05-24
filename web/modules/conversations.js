import { state, activeConversation, roomConversationId, directConversationId } from "./state.js";
import { els, addMessageNode, clearMessages } from "./dom.js";
import { dbGet, dbGetAll, dbPut, dbGetConversationMessages } from "./local-db.js";
import { markBackupDirty } from "./backup.js";

export async function loadConversations() {
  const conversations = await dbGetAll("conversations");
  state.conversations.clear();

  for (const conversation of conversations) {
    state.conversations.set(conversation.id, conversation);
  }

  renderConversations();
}

export async function upsertConversation(next, options = {}) {
  const current = state.conversations.get(next.id) || {};
  const conversation = {
    ...current,
    ...next,
    updatedAt: next.updatedAt || current.updatedAt || Date.now(),
  };
  state.conversations.set(conversation.id, conversation);
  await dbPut("conversations", conversation);
  renderConversations();

  if (!options.silent) {
    markBackupDirty();
  }

  return conversation;
}

export async function persistMessage(conversationId, message, options = {}) {
  const now = Date.now();
  const record = {
    id: message.id || crypto.randomUUID(),
    conversationId,
    direction: message.direction,
    sender: message.sender || "",
    text: message.text || "",
    client_created_at: message.client_created_at ?? message.at ?? now,
    client_sent_at: message.client_sent_at ?? null,
    server_sent_at: message.server_sent_at ?? null,
    delivered_at: message.delivered_at ?? null,
    read_at: message.read_at ?? null,
    status: message.status || "received",
    file: message.file || null,
  };
  await dbPut("messages", record);

  const conversation = state.conversations.get(conversationId);

  if (conversation) {
    conversation.preview = record.file ? `File: ${record.file.name}` : record.text;
    conversation.updatedAt = record.client_created_at || now;
    await dbPut("conversations", conversation);
  }

  if (!options.silent) {
    markBackupDirty();
  }

  if (!options.noRender && state.activeConversationId === conversationId) {
    addMessageNode(
      record.file ? `File ready: ${record.file.name}` : record.text,
      record.direction === "out" ? "local" : "",
      messageMeta(record)
    );
  }

  renderConversations();
  return record;
}

export async function updateMessageStatus(messageId, patch) {
  const messages = await dbGetAll("messages");
  const message = messages.find((item) => item.id === messageId);

  if (!message) {
    return;
  }

  await dbPut("messages", { ...message, ...patch });
  markBackupDirty();

  if (state.activeConversationId === message.conversationId) {
    await renderConversationHistory(message.conversationId);
  }
}

export function renderConversations() {
  els.conversations.textContent = "";
  const conversations = [...state.conversations.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  for (const conversation of conversations) {
    const item = document.createElement("div");
    item.className = `conversation-item ${conversation.id === state.activeConversationId ? "active" : ""}`.trim();

    const main = document.createElement("button");
    main.type = "button";
    main.className = "conversation-main";
    main.onclick = () => openConversation(conversation.id, { join: conversation.kind === "room" });

    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.title || conversation.room || conversation.username || conversation.id;

    const preview = document.createElement("span");
    preview.className = "conversation-preview";
    preview.textContent = conversation.preview || (conversation.kind === "dm" ? "direct message" : "room");

    const actions = document.createElement("div");
    actions.className = "conversation-actions";

    const call = document.createElement("button");
    call.type = "button";
    call.className = "conversation-action quiet-button";
    call.textContent = conversation.kind === "dm" ? "Call" : "Join";
    call.onclick = () => {
      window.dispatchEvent(new CustomEvent("anonchat:conversation-call", { detail: { conversation } }));
    };

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "conversation-action quiet-button";
    edit.title = "Rename";
    edit.textContent = "Rename";
    edit.onclick = () => renameConversation(conversation.id);

    main.appendChild(title);
    main.appendChild(preview);
    item.appendChild(main);
    actions.appendChild(call);
    actions.appendChild(edit);
    item.appendChild(actions);
    els.conversations.appendChild(item);
  }

  if (conversations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "conversation-item";
    empty.innerHTML = "<span class=\"conversation-preview\">No chats yet</span>";
    els.conversations.appendChild(empty);
  }
}

export async function renameConversation(conversationId) {
  const conversation = state.conversations.get(conversationId);

  if (!conversation) {
    return;
  }

  const title = prompt("Conversation name", conversation.title || conversation.room || conversation.username || "");

  if (!title || !title.trim()) {
    return;
  }

  await upsertConversation({ ...conversation, title: title.trim(), updatedAt: Date.now() });

  if (state.activeConversationId === conversationId) {
    setActiveConversationHeader(state.conversations.get(conversationId));
  }
}

export async function openConversation(conversationId, options = {}) {
  const conversation = state.conversations.get(conversationId) || await dbGet("conversations", conversationId);

  if (!conversation) {
    return;
  }

  state.conversations.set(conversation.id, conversation);
  state.activeConversationId = conversation.id;
  setActiveConversationHeader(conversation);
  renderConversations();
  await renderConversationHistory(conversation.id);

  if (conversation.kind === "room") {
    els.room.value = conversation.room || "";
    els.roomKey.value = conversation.roomKey || "";
    window.dispatchEvent(new CustomEvent("anonchat:room-opened", { detail: { conversation, join: options.join } }));
  }

  if (conversation.kind === "dm") {
    els.directUsername.value = conversation.username || "";
  }
}

export async function renderConversationHistory(conversationId) {
  clearMessages();
  const messages = await dbGetConversationMessages(conversationId);

  for (const message of messages) {
    addMessageNode(
      message.file ? `File ready: ${message.file.name}` : message.text,
      message.direction === "out" ? "local" : "",
      messageMeta(message)
    );
  }
}

export function setActiveConversationHeader(conversation) {
  if (!conversation) {
    els.conversationKind.textContent = "Chat";
    els.roomTitle.textContent = "Pick a chat";
    return;
  }

  els.conversationKind.textContent = conversation.kind === "dm" ? "Direct message" : "Room";
  els.roomTitle.textContent = conversation.title || conversation.room || conversation.username || conversation.id;
}

export function currentConversation() {
  return activeConversation();
}

export function roomId(room) {
  return roomConversationId(room);
}

export function dmId(username) {
  return directConversationId(username);
}

function messageMeta(message) {
  const parts = [];

  if (message.sender) {
    parts.push(message.sender);
  }

  if (message.status) {
    parts.push(message.status);
  }

  return parts.join(" - ");
}
