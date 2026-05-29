<script lang="ts">
  import { onMount, tick } from "svelte";
  import { loadCurrentSession, sessionStore, startAnonymousSession, type AnonymousSession } from "$lib/session/session";
  import { RealtimeSocket, realtimeState } from "$lib/realtime/socket";
  import { event, type Participant, type RealtimeEvent } from "$lib/realtime/protocol";
  import { addMessage, clearMessages, messagesStore, roomStore, type ChatMessage } from "$lib/chat/state";
  import { decryptJSON, deriveRoomKeys, encryptJSON, randomID } from "$lib/chat/crypto";
  import { CallController, callStore } from "$lib/call/controller";
  import { mediaStream } from "$lib/utils/media";
  import { listDevices, type DeviceLists } from "$lib/media/devices";

  let displayName = "Anonymous";
  let roomID = "lobby";
  let roomSecret = "";
  let messageText = "";
  let notice = "";
  let self: Participant | null = null;
  let chatKey: CryptoKey | null = null;
  let signalKey: CryptoKey | null = null;
  let socket: RealtimeSocket;
  let calls: CallController;
  let devices: DeviceLists = { microphones: [], cameras: [], speakers: [] };
  let selectedSpeaker = "";
  let mainRemote = "";
  let callX = 18;
  let callY = 18;
  let dragging = false;
  let dragStart = { x: 0, y: 0, left: 0, top: 0 };

  $: currentRoom = $roomStore;
  $: participants = currentRoom.participants;
  $: otherParticipants = participants.filter((item) => item.participant_id !== self?.participant_id);
  $: firstRemote = $callStore.remoteStreams.find((item) => item.participant_id === mainRemote) || $callStore.remoteStreams[0] || null;
  $: smallerRemotes = $callStore.remoteStreams.filter((item) => item.participant_id !== firstRemote?.participant_id);

  onMount(async () => {
    socket = new RealtimeSocket();
    calls = new CallController(socket);
    bindRealtime();
    const existing = await loadCurrentSession();
    if (existing) {
      afterSession(existing);
      socket.connect();
    }
    devices = await listDevices().catch(() => devices);
  });

  function bindRealtime() {
    socket.on("hello_ok", (message) => {
      const participant = (message.payload as { participant?: Participant })?.participant;
      if (participant) {
        self = participant;
      }
      rejoinAfterReconnect();
    });
    socket.on("resume_ok", (message) => {
      const participant = (message.payload as { participant?: Participant })?.participant;
      if (participant) {
        self = participant;
      }
      rejoinAfterReconnect();
    });
    socket.on("room_state", (message) => {
      const payload = message.payload as { room_id?: string; participants?: Participant[] } | undefined;
      roomStore.set({
        joined: Boolean(payload?.room_id),
        room_id: payload?.room_id || roomID,
        participants: payload?.participants || []
      });
      if (payload?.room_id && self && signalKey) {
        calls.configure(payload.room_id, self, signalKey);
      }
    });
    socket.on("participant_joined", (message) => {
      const participant = (message.payload as { participant?: Participant })?.participant;
      if (!participant) return;
      roomStore.update((room) => ({
        ...room,
        participants: room.participants.some((item) => item.participant_id === participant.participant_id)
          ? room.participants
          : [...room.participants, participant]
      }));
      if (participant.participant_id !== self?.participant_id) {
        systemMessage(`${participant.display_name} joined`);
      }
    });
    socket.on("participant_left", (message) => {
      const participantID = (message.payload as { participant_id?: string })?.participant_id || "";
      roomStore.update((room) => ({
        ...room,
        participants: room.participants.filter((item) => item.participant_id !== participantID)
      }));
      systemMessage("The other person left.");
    });
    socket.on("message_created", handleMessageCreated);
    socket.on("call_incoming", (message) => {
      const payload = message.payload as { call_id: string; kind: "audio" | "video"; from: Participant };
      if (payload?.from?.participant_id !== self?.participant_id) {
        calls.receiveIncoming(payload);
      }
    });
    socket.on("call_state", (message) => calls.handleState(message.payload as { call_id: string; state: string; from?: Participant }));
    socket.on("call_signal", (message) => calls.handleSignal(message as RealtimeEvent<any>));
    socket.on("error", (message) => {
      const payload = message.payload as { message?: string } | undefined;
      notice = payload?.message || "That did not work. Try again.";
    });
    socket.on("rate_limited", () => {
      notice = "Slow down for a moment.";
    });
  }

  async function startSession() {
    try {
      const session = await startAnonymousSession(displayName);
      afterSession(session);
      socket.connect();
      notice = "";
    } catch {
      notice = "Could not start. Try again.";
    }
  }

  function afterSession(session: AnonymousSession) {
    displayName = session.display_name;
    self = {
      participant_id: session.participant_id,
      display_name: session.display_name,
      status: "online"
    };
  }

  async function joinRoom() {
    if (!$sessionStore.session) {
      await startSession();
    }
    const cleanRoom = roomID.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 64);
    if (!cleanRoom || !roomSecret) {
      notice = "Enter a room name and room password.";
      return;
    }
    const keys = await deriveRoomKeys(cleanRoom, roomSecret);
    chatKey = keys.chat;
    signalKey = keys.signal;
    roomID = cleanRoom;
    clearMessages();
    socket.connect();
    socket.send(event("join_room", { room_id: cleanRoom }, { room_id: cleanRoom }));
    if (self && signalKey) {
      calls.configure(cleanRoom, self, signalKey);
    }
    notice = "";
  }

  function rejoinAfterReconnect() {
    if (!currentRoom.joined || !currentRoom.room_id || !signalKey || !chatKey) {
      return;
    }
    socket.send(event("join_room", { room_id: currentRoom.room_id }, { room_id: currentRoom.room_id }));
  }

  function leaveRoom() {
    socket.send(event("leave_room", {}, { room_id: currentRoom.room_id }));
    roomStore.set({ joined: false, room_id: "", participants: [] });
    clearMessages();
  }

  async function sendMessage() {
    const text = messageText.trim();
    if (!text || !chatKey || !currentRoom.joined || !self) {
      return;
    }
    const clientID = randomID("client");
    const local: ChatMessage = {
      id: clientID,
      client_id: clientID,
      sender: self.display_name,
      self: true,
      text,
      at: Date.now(),
      status: "sending"
    };
    addMessage(local);
    messageText = "";
    const ciphertext = await encryptJSON(chatKey, {
      id: clientID,
      text,
      sender: self.display_name,
      at: Date.now()
    });
    socket.send(event("send_message", { ciphertext, algorithm: "AES-GCM/PBKDF2-SHA256" }, {
      room_id: currentRoom.room_id,
      client_msg_id: clientID
    }));
  }

  async function handleMessageCreated(message: RealtimeEvent) {
    if (!chatKey) return;
    const payload = message.payload as {
      message_id: string;
      client_msg_id?: string;
      sender: Participant;
      ciphertext: string;
    };
    if (!payload?.ciphertext) return;
    try {
      const plain = await decryptJSON<{ id?: string; text: string; sender?: string; at?: number }>(chatKey, payload.ciphertext);
      addMessage({
        id: payload.message_id || plain.id || crypto.randomUUID(),
        client_id: payload.client_msg_id || plain.id,
        sender: payload.sender.display_name || plain.sender || "Anonymous",
        self: payload.sender.participant_id === self?.participant_id,
        text: plain.text,
        at: plain.at || Date.now(),
        status: payload.sender.participant_id === self?.participant_id ? "sent" : "received"
      });
      await tick();
      document.querySelector(".messages")?.scrollTo({ top: 999999, behavior: "smooth" });
    } catch {
      systemMessage("Could not read an encrypted message.");
    }
  }

  function systemMessage(text: string) {
    addMessage({
      id: crypto.randomUUID(),
      sender: "AnonChat",
      self: false,
      text,
      at: Date.now(),
      status: "received"
    });
  }

  async function startCall(kind: "audio" | "video") {
    try {
      await calls.start(kind, participants);
      devices = await listDevices().catch(() => devices);
    } catch {
      notice = "Camera or microphone could not start.";
    }
  }

  async function acceptCall() {
    try {
      await calls.accept();
      devices = await listDevices().catch(() => devices);
    } catch {
      notice = "Camera or microphone could not start.";
    }
  }

  async function setSpeaker(event: Event) {
    selectedSpeaker = (event.target as HTMLSelectElement).value;
    const videos = [...document.querySelectorAll("video.remote-video")] as HTMLMediaElement[];
    for (const video of videos) {
      await video.setSinkId?.(selectedSpeaker).catch(() => {
        notice = "This browser controls audio output.";
      });
    }
  }

  function beginDrag(event: PointerEvent) {
    dragging = true;
    dragStart = { x: event.clientX, y: event.clientY, left: callX, top: callY };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent) {
    if (!dragging) return;
    callX = Math.max(8, Math.min(window.innerWidth - 220, dragStart.left + event.clientX - dragStart.x));
    callY = Math.max(8, Math.min(window.innerHeight - 150, dragStart.top + event.clientY - dragStart.y));
  }

  function endDrag() {
    dragging = false;
  }
</script>

<svelte:head>
  <title>AnonChat</title>
</svelte:head>

<main class="app-shell">
  <aside class="rail" aria-label="Start and rooms">
    <header class="brand">
      <div class="brand-mark">A</div>
      <div>
        <h1>AnonChat</h1>
        <p>Private rooms for chat and calls</p>
      </div>
      <span class:good={$realtimeState.tone === "good"} class:warn={$realtimeState.tone === "warn"} class:bad={$realtimeState.tone === "bad"} class="pill">
        {$realtimeState.text}
      </span>
    </header>

    <section class="panel stack">
      <div class="section-head">
        <h2>Start</h2>
        <span class="pill" class:good={$sessionStore.ready}>{$sessionStore.session ? $sessionStore.session.display_name : "Private"}</span>
      </div>
      <label>
        Name shown in rooms
        <input bind:value={displayName} maxlength="32" autocomplete="nickname" />
      </label>
      <button class="primary-button" type="button" on:click={startSession} disabled={$sessionStore.connecting}>
        Start
      </button>
    </section>

    <section class="panel stack">
      <div class="section-head">
        <h2>Join</h2>
        <span class="pill">{otherParticipants.length} here</span>
      </div>
      <label>
        Room
        <input bind:value={roomID} maxlength="64" autocomplete="off" />
      </label>
      <label>
        Room password
        <input bind:value={roomSecret} type="password" autocomplete="off" />
      </label>
      <div class="split-actions">
        <button class="primary-button" type="button" on:click={joinRoom}>Join</button>
        <button type="button" on:click={leaveRoom} disabled={!currentRoom.joined}>Leave</button>
      </div>
    </section>

    <section class="panel stack">
      <div class="section-head">
        <h2>People</h2>
        <span class="pill">{participants.length} online</span>
      </div>
      <div class="people-list">
        {#each participants as participant}
          <div class="person" class:self={participant.participant_id === self?.participant_id}>
            <strong>{participant.display_name}</strong>
            <span>{participant.participant_id === self?.participant_id ? "You" : participant.status}</span>
          </div>
        {:else}
          <div class="person empty">
            <strong>No one here yet</strong>
            <span>Join a room and share its name and password.</span>
          </div>
        {/each}
      </div>
    </section>
  </aside>

  <section class="conversation" aria-label="Chat">
    <header class="room-bar">
      <div>
        <p class="eyebrow">{currentRoom.joined ? "Room" : "Chat"}</p>
        <h2>{currentRoom.joined ? currentRoom.room_id : "Join a room"}</h2>
      </div>
      <div class="room-actions">
        <button type="button" on:click={() => startCall("audio")} disabled={!currentRoom.joined || otherParticipants.length === 0}>Audio</button>
        <button class="primary-button" type="button" on:click={() => startCall("video")} disabled={!currentRoom.joined || otherParticipants.length === 0}>Video</button>
      </div>
    </header>

    {#if notice}
      <div class="notice">{notice}</div>
    {/if}

    <div class="messages" aria-live="polite">
      {#each $messagesStore as message}
        <article class:local={message.self} class:system={message.sender === "AnonChat"} class="message">
          <span class="message-meta">{message.sender} · {message.status}</span>
          <p>{message.text}</p>
        </article>
      {:else}
        <div class="empty-chat">
          <strong>Nothing here yet</strong>
          <span>Messages are encrypted before they leave this browser.</span>
        </div>
      {/each}
    </div>

    <form class="composer" on:submit|preventDefault={sendMessage}>
      <textarea bind:value={messageText} rows="1" maxlength="4000" placeholder="Write a message" disabled={!currentRoom.joined}></textarea>
      <button class="primary-button" type="submit" disabled={!messageText.trim() || !currentRoom.joined}>Send</button>
    </form>
  </section>

  <aside class="activity" aria-label="Call">
    <section class="panel stack call-panel">
      <div class="section-head">
        <h2>Call</h2>
        <span class="pill" class:good={$callStore.active}>{$callStore.status}</span>
      </div>

      {#if $callStore.incoming}
        <div class="incoming">
          <strong>{$callStore.incoming.from.display_name} is calling</strong>
          <span>Answer when you are ready.</span>
          <div class="split-actions">
            <button type="button" on:click={() => calls.reject()}>Reject</button>
            <button class="primary-button" type="button" on:click={acceptCall}>Accept</button>
          </div>
        </div>
      {/if}

      <div class="call-stage" hidden={!$callStore.active || $callStore.minimized}>
        {#if firstRemote}
          <button class="main-video-button" type="button" on:click={() => (mainRemote = firstRemote.participant_id)} aria-label="Main call video">
            <video class="remote-video" use:mediaStream={firstRemote.stream} autoplay playsinline></video>
            <span>{firstRemote.display_name}</span>
          </button>
        {:else}
          <div class="video-placeholder">Video appears here</div>
        {/if}

        <div class="video-strip">
          {#if $callStore.localStream}
            <button class="thumb-video" type="button" aria-label="Your video">
              <video use:mediaStream={$callStore.localStream} autoplay muted playsinline></video>
              <span>You</span>
            </button>
          {/if}
          {#each smallerRemotes as remote}
            <button class="thumb-video" type="button" on:click={() => (mainRemote = remote.participant_id)} aria-label="Switch main video">
              <video use:mediaStream={remote.stream} autoplay playsinline></video>
              <span>{remote.display_name}</span>
            </button>
          {/each}
        </div>
      </div>

      <div class="call-controls" hidden={!$callStore.active}>
        <button type="button" on:click={() => calls.toggleMute()}>{$callStore.muted ? "Unmute" : "Mute"}</button>
        <button type="button" on:click={() => calls.toggleCamera()}>{$callStore.cameraOff ? "Camera on" : "Camera off"}</button>
        <button type="button" on:click={() => calls.minimize(true)}>Minimize</button>
        <button class="danger-button" type="button" on:click={() => calls.end()}>End</button>
      </div>

      <label class="speaker-select">
        Speaker
        <select bind:value={selectedSpeaker} on:change={setSpeaker} disabled={devices.speakers.length === 0}>
          <option value="">Browser default</option>
          {#each devices.speakers as speaker}
            <option value={speaker.deviceId}>{speaker.label || "Speaker"}</option>
          {/each}
        </select>
      </label>
    </section>
  </aside>
</main>

{#if $callStore.active && $callStore.minimized}
  <button
    class="mini-call"
    type="button"
    style={`left:${callX}px; top:${callY}px`}
    on:pointerdown={beginDrag}
    on:pointermove={moveDrag}
    on:pointerup={endDrag}
    on:click={() => !dragging && calls.minimize(false)}
  >
    <strong>{$callStore.status}</strong>
    <span>Tap to return</span>
  </button>
{/if}
