import { writable } from "svelte/store";
import { event, type Participant, type RealtimeEvent } from "$lib/realtime/protocol";
import type { RealtimeSocket } from "$lib/realtime/socket";
import { decryptJSON, encryptJSON, randomID } from "$lib/chat/crypto";
import { getCallStream } from "$lib/media/devices";

type CallSignalPayload = {
  call_id: string;
  from: Participant;
  target_participant_id?: string;
  signal: string;
};

export type RemoteStream = {
  participant_id: string;
  display_name: string;
  stream: MediaStream;
};

export const callStore = writable({
  active: false,
  incoming: null as null | { call_id: string; from: Participant; kind: "audio" | "video" },
  call_id: "",
  status: "No call",
  minimized: false,
  localStream: null as MediaStream | null,
  remoteStreams: [] as RemoteStream[],
  muted: false,
  cameraOff: false
});

export class CallController {
  private socket: RealtimeSocket;
  private signalKey: CryptoKey | null = null;
  private self: Participant | null = null;
  private roomID = "";
  private pcs = new Map<string, RTCPeerConnection>();
  private localStream: MediaStream | null = null;
  private activeCallID = "";

  constructor(socket: RealtimeSocket) {
    this.socket = socket;
  }

  configure(roomID: string, self: Participant, signalKey: CryptoKey) {
    this.roomID = roomID;
    this.self = self;
    this.signalKey = signalKey;
  }

  async start(kind: "audio" | "video", participants: Participant[]) {
    if (!this.signalKey || !this.self) {
      throw new Error("call not ready");
    }
    this.activeCallID = randomID("call");
    await this.ensureMedia(kind);
    callStore.update((state) => ({
      ...state,
      active: true,
      incoming: null,
      call_id: this.activeCallID,
      status: "Calling...",
      localStream: this.localStream
    }));
    this.socket.send(event("call_start", {
      call_id: this.activeCallID,
      kind
    }, { room_id: this.roomID }));

    for (const participant of participants.filter((item) => item.participant_id !== this.self?.participant_id)) {
      await this.callParticipant(participant);
    }
  }

  receiveIncoming(payload: { call_id: string; kind: "audio" | "video"; from: Participant }) {
    if (this.activeCallID === payload.call_id) {
      return;
    }
    callStore.update((state) => ({
      ...state,
      incoming: payload,
      status: `${payload.from.display_name} is calling`
    }));
  }

  async accept() {
    const current = getStoreSnapshot();
    if (!current.incoming || !this.signalKey) {
      return;
    }
    this.activeCallID = current.incoming.call_id;
    await this.ensureMedia(current.incoming.kind);
    this.socket.send(event("call_accept", { call_id: this.activeCallID }, { room_id: this.roomID }));
    callStore.update((state) => ({
      ...state,
      active: true,
      incoming: null,
      call_id: this.activeCallID,
      status: "Connecting...",
      localStream: this.localStream
    }));
  }

  reject() {
    const current = getStoreSnapshot();
    if (current.incoming) {
      this.socket.send(event("call_reject", { call_id: current.incoming.call_id }, { room_id: this.roomID }));
    }
    callStore.update((state) => ({ ...state, incoming: null, status: "No call" }));
  }

  end(notify = true) {
    if (notify && this.activeCallID) {
      this.socket.send(event("call_end", { call_id: this.activeCallID }, { room_id: this.roomID }));
    }
    for (const pc of this.pcs.values()) {
      pc.close();
    }
    this.pcs.clear();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.activeCallID = "";
    callStore.set({
      active: false,
      incoming: null,
      call_id: "",
      status: "No call",
      minimized: false,
      localStream: null,
      remoteStreams: [],
      muted: false,
      cameraOff: false
    });
  }

  async handleState(payload: { call_id: string; state: string; from?: Participant }) {
    if (!payload.call_id || payload.call_id !== this.activeCallID) {
      return;
    }
    if (payload.state === "accepted" && payload.from && payload.from.participant_id !== this.self?.participant_id) {
      await this.callParticipant(payload.from);
      callStore.update((state) => ({ ...state, status: "Connected" }));
    }
    if (payload.state === "ended" || payload.state === "rejected") {
      this.end(false);
    }
  }

  async handleSignal(eventMessage: RealtimeEvent<CallSignalPayload>) {
    const payload = eventMessage.payload;
    if (!payload || !this.signalKey || payload.from.participant_id === this.self?.participant_id) {
      return;
    }
    const signal = await decryptJSON<RTCSessionDescriptionInit | RTCIceCandidateInit>(this.signalKey, payload.signal);
    const pc = this.peerConnection(payload.from);
    if ("type" in signal && (signal.type === "offer" || signal.type === "answer")) {
      await pc.setRemoteDescription(signal);
      if (signal.type === "offer") {
        if (!this.localStream) {
          await this.ensureMedia("video");
        }
        this.addLocalTracks(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.sendSignal(payload.from, answer);
      }
      return;
    }
    if ("candidate" in signal && signal.candidate) {
      await pc.addIceCandidate(signal).catch(() => {});
    }
  }

  toggleMute() {
    const audio = this.localStream?.getAudioTracks() || [];
    const nextEnabled = audio.some((track) => !track.enabled);
    audio.forEach((track) => {
      track.enabled = nextEnabled;
    });
    callStore.update((state) => ({ ...state, muted: !nextEnabled, status: nextEnabled ? "Connected" : "Muted" }));
  }

  toggleCamera() {
    const video = this.localStream?.getVideoTracks() || [];
    const nextEnabled = video.some((track) => !track.enabled);
    video.forEach((track) => {
      track.enabled = nextEnabled;
    });
    callStore.update((state) => ({ ...state, cameraOff: !nextEnabled, status: nextEnabled ? "Connected" : "Camera off" }));
  }

  minimize(value: boolean) {
    callStore.update((state) => ({ ...state, minimized: value }));
  }

  private async callParticipant(participant: Participant) {
    const pc = this.peerConnection(participant);
    this.addLocalTracks(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.sendSignal(participant, offer);
  }

  private peerConnection(participant: Participant) {
    const existing = this.pcs.get(participant.participant_id);
    if (existing) {
      return existing;
    }
    const pc = new RTCPeerConnection({ iceCandidatePoolSize: 2 });
    this.pcs.set(participant.participant_id, pc);
    pc.onicecandidate = (candidate) => {
      if (candidate.candidate) {
        this.sendSignal(participant, candidate.candidate.toJSON()).catch(() => {});
      }
    };
    pc.ontrack = (trackEvent) => {
      const stream = trackEvent.streams[0];
      callStore.update((state) => {
        const others = state.remoteStreams.filter((item) => item.participant_id !== participant.participant_id);
        return {
          ...state,
          status: "Connected",
          remoteStreams: [...others, {
            participant_id: participant.participant_id,
            display_name: participant.display_name,
            stream
          }]
        };
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        callStore.update((state) => ({ ...state, status: "Reconnecting..." }));
      }
    };
    return pc;
  }

  private async sendSignal(participant: Participant, signal: RTCSessionDescriptionInit | RTCIceCandidateInit) {
    if (!this.signalKey || !this.activeCallID) {
      return;
    }
    const encrypted = await encryptJSON(this.signalKey, signal);
    this.socket.send(event("call_signal", {
      call_id: this.activeCallID,
      target_participant_id: participant.participant_id,
      signal: encrypted
    }, { room_id: this.roomID }));
  }

  private async ensureMedia(kind: "audio" | "video") {
    if (this.localStream) {
      return this.localStream;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("media unavailable");
    }
    this.localStream = await getCallStream();
    if (kind === "audio") {
      this.localStream.getVideoTracks().forEach((track) => {
        track.enabled = false;
      });
    }
    return this.localStream;
  }

  private addLocalTracks(pc: RTCPeerConnection) {
    if (!this.localStream) {
      return;
    }
    const existing = new Set(pc.getSenders().map((sender) => sender.track));
    for (const track of this.localStream.getTracks()) {
      if (!existing.has(track)) {
        pc.addTrack(track, this.localStream);
      }
    }
  }
}

function getStoreSnapshot() {
  let snapshot: ReturnType<typeof defaultCallState> = defaultCallState();
  const unsubscribe = callStore.subscribe((state) => {
    snapshot = state;
  });
  unsubscribe();
  return snapshot;
}

function defaultCallState() {
  return {
    active: false,
    incoming: null as null | { call_id: string; from: Participant; kind: "audio" | "video" },
    call_id: "",
    status: "No call",
    minimized: false,
    localStream: null as MediaStream | null,
    remoteStreams: [] as RemoteStream[],
    muted: false,
    cameraOff: false
  };
}
