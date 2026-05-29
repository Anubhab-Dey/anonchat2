export const PROTOCOL_VERSION = 1;

export type Participant = {
  participant_id: string;
  display_name: string;
  status: "online" | "away" | "busy";
};

export type RealtimeEvent<T = unknown> = {
  type: string;
  protocol_version: number;
  request_id?: string;
  client_msg_id?: string;
  room_id?: string;
  timestamp?: string;
  payload?: T;
};

export function event<T>(type: string, payload?: T, options: Partial<RealtimeEvent> = {}): RealtimeEvent<T> {
  return {
    type,
    protocol_version: PROTOCOL_VERSION,
    request_id: options.request_id || crypto.randomUUID(),
    client_msg_id: options.client_msg_id,
    room_id: options.room_id,
    payload
  };
}
