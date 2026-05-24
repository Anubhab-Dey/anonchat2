import { state, roomConversationId } from "./state.js";
import { els } from "./dom.js";
import { bytesToBase64Url, base64UrlToBytes, encryptJson, decryptJson, sha256Hex } from "./crypto-box.js";
import { showToast } from "./toast.js";
import { addSystemMessage } from "./ui.js";
import { ensurePeerConnection, negotiate, peerLabel, renderPeers } from "./call-p2p.js";
import { persistMessage } from "./conversations.js";

const CHUNK_SIZE = 12000;

export function setupDataChannel(peerId, channel) {
  channel.bufferedAmountLowThreshold = 512 * 1024;
  channel.onopen = () => {
    addSystemMessage(`file channel open with ${peerLabel(peerId)}`);
    renderPeers();
  };
  channel.onclose = () => renderPeers();
  channel.onmessage = (event) => handleDataMessage(peerId, event.data).catch(() => {
    addSystemMessage("could not decrypt a file transfer message");
  });
  state.channels.set(peerId, channel);
}

export async function ensureFileChannels() {
  for (const peerId of state.peers.keys()) {
    const pc = ensurePeerConnection(peerId);

    if (!state.channels.has(peerId)) {
      setupDataChannel(peerId, pc.createDataChannel("files"));
    }

    await negotiate(peerId);
  }
}

export function updateSelectedFile() {
  const file = els.fileInput.files[0];
  els.selectedFile.textContent = file ? `${file.name} (${file.size} bytes)` : "No file selected";
}

export async function sendSelectedFile() {
  const file = els.fileInput.files[0];

  if (!file) {
    showToast("Choose a file first", "warning");
    return;
  }

  if (state.peers.size === 0) {
    showToast("No peers for file transfer", "warning");
    return;
  }

  if (!state.roomKeys || !state.roomKeys.file) {
    showToast("Enter a room before sending files", "warning");
    return;
  }

  await ensureFileChannels();
  const channels = [...state.channels.values()].filter((channel) => channel.readyState === "open");

  if (channels.length === 0) {
    showToast("File channel is not open yet", "warning");
    return;
  }

  const id = crypto.randomUUID();
  const hash = await sha256File(file);
  const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  addSystemMessage(`sending ${file.name}`);

  await persistFileMessage({
    id,
    direction: "out",
    sender: state.username,
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    hash,
    verification: "verified",
  });

  for (const channel of channels) {
    await sendEncryptedFileFrame(channel, {
      kind: "file-meta",
      id,
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      hash,
      total,
    });

    for (let index = 0; index < total; index++) {
      await waitForChannel(channel);
      const start = index * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
      await sendEncryptedFileFrame(channel, {
        kind: "file-chunk",
        id,
        index,
        data: bytesToBase64Url(chunk),
      });
    }
  }

  showToast("File sent", "success");
}

async function sendEncryptedFileFrame(channel, frame) {
  const box = await encryptJson(state.roomKeys.file, frame);
  channel.send(JSON.stringify({ kind: "file-box", box }));
}

async function handleDataMessage(peerId, raw) {
  if (typeof raw !== "string") {
    return;
  }

  let msg = JSON.parse(raw);

  if (msg.kind !== "file-box") {
    addSystemMessage("ignored unencrypted file transfer message");
    return;
  }

  if (!state.roomKeys || !state.roomKeys.file) {
    addSystemMessage("encrypted file message ignored before room key was set");
    return;
  }

  msg = await decryptJson(state.roomKeys.file, msg.box);

  if (msg.kind === "file-meta") {
    state.incomingFiles.set(msg.id, {
      peerId,
      name: msg.name,
      type: msg.type || "application/octet-stream",
      size: Number(msg.size || 0),
      hash: msg.hash,
      total: Number(msg.total || 0),
      chunks: new Array(Number(msg.total || 0)),
      received: 0,
    });
    addSystemMessage(`file offer received: ${msg.name}`);
    showToast("File ready to download after verification", "info");
    return;
  }

  if (msg.kind !== "file-chunk") {
    return;
  }

  const transfer = state.incomingFiles.get(msg.id);

  if (!transfer || transfer.chunks[msg.index]) {
    return;
  }

  transfer.chunks[msg.index] = base64UrlToBytes(msg.data);
  transfer.received++;

  if (transfer.received !== transfer.total) {
    return;
  }

  const blob = new Blob(transfer.chunks, { type: transfer.type });
  const hash = await sha256Blob(blob);

  if (hash !== transfer.hash || blob.size !== transfer.size) {
    addSystemMessage(`file check failed: ${transfer.name}`);
    state.incomingFiles.delete(msg.id);
    return;
  }

  const metadata = {
    id: msg.id,
    direction: "in",
    sender: peerLabel(transfer.peerId),
    name: transfer.name,
    size: blob.size,
    type: transfer.type,
    hash,
    verification: "verified",
  };
  renderFileCard(metadata, blob);
  await persistFileMessage(metadata);
  state.incomingFiles.delete(msg.id);
  showToast("File verified", "success");
  showToast("File ready to download", "info");
}

function renderFileCard(metadata, blob) {
  const card = document.createElement("div");
  card.className = "file-card";

  const name = document.createElement("strong");
  name.textContent = metadata.name;

  const meta = document.createElement("span");
  meta.textContent = `${metadata.size} bytes from ${metadata.sender} - ${metadata.verification}`;

  const actions = document.createElement("div");
  actions.className = "file-actions";

  const download = document.createElement("button");
  download.type = "button";
  download.textContent = "Download";
  download.onclick = () => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = metadata.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const reject = document.createElement("button");
  reject.type = "button";
  reject.textContent = "Delete";
  reject.onclick = () => card.remove();

  actions.appendChild(download);
  actions.appendChild(reject);
  card.appendChild(name);
  card.appendChild(meta);
  card.appendChild(actions);
  els.files.prepend(card);
}

async function persistFileMessage(metadata) {
  if (!state.room) {
    return;
  }

  await persistMessage(roomConversationId(state.room), {
    id: metadata.id,
    direction: metadata.direction,
    sender: metadata.sender,
    text: `File: ${metadata.name}`,
    client_created_at: Date.now(),
    status: metadata.direction === "out" ? "sent" : "received",
    file: {
      id: metadata.id,
      name: metadata.name,
      size: metadata.size,
      type: metadata.type,
      hash: metadata.hash,
      sender: metadata.sender,
      verification: metadata.verification,
    },
  });
}

async function sha256File(file) {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Blob(blob) {
  return sha256Hex(new Uint8Array(await blob.arrayBuffer()));
}

function waitForChannel(channel) {
  if (channel.readyState === "open" && channel.bufferedAmount < channel.bufferedAmountLowThreshold) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener("open", done);
      channel.removeEventListener("bufferedamountlow", done);
      resolve();
    };

    channel.addEventListener("open", done);
    channel.addEventListener("bufferedamountlow", done);
  });
}
