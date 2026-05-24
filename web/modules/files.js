import { state, roomConversationId } from "./state.js";
import { els } from "./dom.js";
import { bytesToBase64Url, base64UrlToBytes, encryptJson, decryptJson } from "./crypto-box.js";
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
  const hasher = new Sha256Incremental();

  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + CHUNK_SIZE)).arrayBuffer());
    hasher.update(chunk);
  }

  return hasher.digestHex();
}

async function sha256Blob(blob) {
  const hasher = new Sha256Incremental();

  for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
    const chunk = new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + CHUNK_SIZE)).arrayBuffer());
    hasher.update(chunk);
  }

  return hasher.digestHex();
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

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

class Sha256Incremental {
  constructor() {
    this.h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
    this.finished = false;
  }

  update(data) {
    if (this.finished) {
      throw new Error("sha256 already finalized");
    }

    let offset = 0;
    this.bytesHashed += data.length;

    while (offset < data.length) {
      const take = Math.min(data.length - offset, 64 - this.bufferLength);
      this.buffer.set(data.subarray(offset, offset + take), this.bufferLength);
      this.bufferLength += take;
      offset += take;

      if (this.bufferLength === 64) {
        this.compress(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  digestHex() {
    if (this.finished) {
      throw new Error("sha256 already finalized");
    }

    this.finished = true;
    const bitLengthHigh = Math.floor(this.bytesHashed / 0x20000000);
    const bitLengthLow = (this.bytesHashed << 3) >>> 0;
    this.buffer[this.bufferLength++] = 0x80;

    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength, 64);
      this.compress(this.buffer);
      this.bufferLength = 0;
    }

    this.buffer.fill(0, this.bufferLength, 56);
    writeUint32(this.buffer, 56, bitLengthHigh);
    writeUint32(this.buffer, 60, bitLengthLow);
    this.compress(this.buffer);

    return this.h.map((word) => word.toString(16).padStart(8, "0")).join("");
  }

  compress(chunk) {
    const w = new Uint32Array(64);

    for (let i = 0; i < 16; i++) {
      w[i] =
        (chunk[i * 4] << 24) |
        (chunk[i * 4 + 1] << 16) |
        (chunk[i * 4 + 2] << 8) |
        chunk[i * 4 + 3];
    }

    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.h;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }
}

function rotr(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

function writeUint32(buffer, offset, value) {
  buffer[offset] = (value >>> 24) & 0xff;
  buffer[offset + 1] = (value >>> 16) & 0xff;
  buffer[offset + 2] = (value >>> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}
