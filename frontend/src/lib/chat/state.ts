import { writable } from "svelte/store";
import type { Participant } from "$lib/realtime/protocol";

export type ChatMessage = {
  id: string;
  client_id?: string;
  sender: string;
  self: boolean;
  text: string;
  at: number;
  status: "sending" | "sent" | "received" | "failed";
};

export const roomStore = writable({
  joined: false,
  room_id: "",
  participants: [] as Participant[]
});

export const messagesStore = writable<ChatMessage[]>([]);

export function addMessage(message: ChatMessage) {
  messagesStore.update((messages) => {
    if (messages.some((item) => item.id === message.id || (message.client_id && item.client_id === message.client_id))) {
      return messages.map((item) => item.client_id && item.client_id === message.client_id ? { ...message, self: item.self } : item);
    }
    return [...messages, message].slice(-300);
  });
}

export function clearMessages() {
  messagesStore.set([]);
}
