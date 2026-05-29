import { writable } from "svelte/store";
import { api } from "$lib/api/client";

export type AnonymousSession = {
  participant_id: string;
  display_name: string;
  expires_at: string;
};

type SessionState = {
  ready: boolean;
  connecting: boolean;
  session: AnonymousSession | null;
  message: string;
};

export const sessionStore = writable<SessionState>({
  ready: false,
  connecting: false,
  session: null,
  message: "Start when you are ready."
});

export async function startAnonymousSession(displayName: string) {
  sessionStore.update((state) => ({ ...state, connecting: true, message: "Starting private session..." }));
  const response = await api<{ ok: true; session: AnonymousSession }>("/api/session/anonymous", {
    method: "POST",
    body: JSON.stringify({ display_name: displayName })
  });
  sessionStore.set({
    ready: true,
    connecting: false,
    session: response.session,
    message: "Ready"
  });
  return response.session;
}

export async function loadCurrentSession() {
  try {
    const response = await api<{ ok: true; session: AnonymousSession }>("/api/session/me");
    sessionStore.set({
      ready: true,
      connecting: false,
      session: response.session,
      message: "Ready"
    });
    return response.session;
  } catch {
    sessionStore.set({
      ready: false,
      connecting: false,
      session: null,
      message: "Start when you are ready."
    });
    return null;
  }
}
