import { writable } from "svelte/store";
import type { RealtimeEvent } from "$lib/realtime/protocol";

type Handler = (event: RealtimeEvent) => void | Promise<void>;

export const realtimeState = writable({
  connected: false,
  connecting: false,
  text: "Offline",
  tone: "bad" as "good" | "warn" | "bad"
});

export class RealtimeSocket {
  private socket: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private queue: RealtimeEvent[] = [];
  private attempts = 0;
  private reconnectTimer = 0;
  private shouldReconnect = true;

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    window.clearTimeout(this.reconnectTimer);
    realtimeState.set({ connected: false, connecting: true, text: "Connecting...", tone: "warn" });
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(`${proto}//${location.host}/ws`, "anonchat2.v1");

    this.socket.onopen = () => {
      this.attempts = 0;
      realtimeState.set({ connected: true, connecting: false, text: "Online", tone: "good" });
      this.send({ type: "hello", protocol_version: 1 });
      this.flush();
    };
    this.socket.onmessage = (message) => this.receive(message.data);
    this.socket.onerror = () => {
      realtimeState.set({ connected: false, connecting: false, text: "Connection issue", tone: "bad" });
    };
    this.socket.onclose = () => {
      realtimeState.set({ connected: false, connecting: false, text: "Reconnecting...", tone: "warn" });
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    };
  }

  disconnect() {
    this.shouldReconnect = false;
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "leaving");
    this.socket = null;
  }

  on(type: string, handler: Handler) {
    const set = this.handlers.get(type) || new Set<Handler>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  send(message: RealtimeEvent) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    this.queue.push(message);
    while (this.queue.length > 200) {
      this.queue.shift();
    }
    this.connect();
  }

  private flush() {
    const pending = [...this.queue];
    this.queue = [];
    for (const message of pending) {
      this.send(message);
    }
  }

  private receive(raw: string) {
    let message: RealtimeEvent;
    try {
      message = JSON.parse(raw);
    } catch {
      this.emit({ type: "malformed", protocol_version: 1 });
      return;
    }
    this.emit(message);
  }

  private emit(message: RealtimeEvent) {
    for (const handler of this.handlers.get(message.type) || []) {
      Promise.resolve(handler(message)).catch(() => {});
    }
    for (const handler of this.handlers.get("*") || []) {
      Promise.resolve(handler(message)).catch(() => {});
    }
  }

  private scheduleReconnect() {
    const delay = Math.min(12000, 800 + this.attempts * 1400);
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
}
