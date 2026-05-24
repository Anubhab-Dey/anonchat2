import { state, activeConversation } from "./modules/state.js";
import { els } from "./modules/dom.js";
import { openLocalDb, dbGet } from "./modules/local-db.js";
import { connect, onWire, setStatus } from "./modules/wire.js";
import { signup, login } from "./modules/auth.js";
import {
  loadSavedSession,
  refreshSession,
  handleSessionReplaced,
  clearThisDevice,
  signInAgain,
} from "./modules/device-session.js";
import { uploadBackupIfDirty } from "./modules/backup.js";
import {
  loadConversations,
  openConversation,
  currentConversation,
} from "./modules/conversations.js";
import {
  loadInitialRoomInputs,
  updateInvite,
  createNewRoom,
  joinRoom,
  copyInvite,
  sendRoomChat,
  handleRoomJoined,
  handleChatAck,
  handleRoomChat,
  openRoomFromConversation,
} from "./modules/rooms.js";
import {
  setupDirectIdentity,
  startDirectConversation,
  sendDirectChat,
  handleDirectAck,
  handleDirectMessage,
  rememberDirectPeer,
} from "./modules/direct.js";
import {
  initializeCalls,
  startActiveCall,
  startDirectCall,
  endCallSession,
  handleCallEvent,
} from "./modules/calls.js";
import {
  addPeer,
  removePeer,
  renderPeers,
  resetPeerConnections,
  handleSignal,
  handleDirectSignal,
} from "./modules/call-p2p.js";
import { sendSelectedFile, updateSelectedFile } from "./modules/files.js";
import {
  loadNotificationSetting,
  requestStoragePersistence,
  toggleNotifications,
} from "./modules/notifications.js";
import {
  addSystemMessage,
  checkAppEnvironment,
  resizeComposer,
  setIdentity,
  showBlockingScreen,
} from "./modules/ui.js";
import { showToast } from "./modules/toast.js";

let openingRefresh = false;

function bindEvents() {
  els.connectBtn.onclick = connect;
  els.signupBtn.onclick = () => signup().catch(() => showToast("Sign up failed", "error"));
  els.loginBtn.onclick = () => login().catch(() => showToast("Sign in failed", "error"));
  els.startDmBtn.onclick = () => startDirectConversation().catch(() => showToast("Direct message setup failed", "error"));
  els.directCallBtn.onclick = () => startDirectCall().catch(() => showToast("Direct call setup failed", "error"));
  els.notificationBtn.onclick = () => toggleNotifications().catch(() => showToast("Notifications unavailable", "warning"));
  els.newRoomBtn.onclick = createNewRoom;
  els.joinBtn.onclick = () => joinRoom().catch(() => showToast("Could not enter room", "error"));
  els.copyInviteBtn.onclick = () => copyInvite().catch(() => showToast("Could not copy invite", "warning"));
  els.startCallBtn.onclick = () => startActiveCall().catch(() => showToast("Call setup failed", "error"));
  els.stopCallBtn.onclick = () => endCallSession();
  els.attachBtn.onclick = () => els.fileInput.click();
  els.fileInput.onchange = updateSelectedFile;
  els.sendFileBtn.onclick = () => sendSelectedFile().catch(() => showToast("File send failed", "error"));
  els.clearDeviceBtn.onclick = () => clearThisDevice().catch(() => showToast("Could not clear this device", "error"));
  els.signInAgainBtn.onclick = () => {
    signInAgain();
    setIdentity("signed out", "warn");
    connect();
  };

  els.directUsername.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      startDirectConversation().catch(() => showToast("Direct message setup failed", "error"));
    }
  });
  els.messageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendComposerMessage().catch(() => showToast("Message failed", "error"));
  });
  els.messageInput.addEventListener("input", resizeComposer);
  els.messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.messageForm.requestSubmit();
    }
  });
  els.room.addEventListener("input", updateInvite);
  els.roomKey.addEventListener("input", updateInvite);
  window.addEventListener("hashchange", () => {
    loadInitialRoomInputs();
    showToast("Invite loaded", "info");
  });
  window.addEventListener("anonchat:room-opened", (event) => {
    openRoomFromConversation(event).catch(() => showToast("Room could not reopen", "error"));
  });
  window.addEventListener("anonchat:backup-imported", () => {
    loadConversations().catch(() => {});
  });
}

function bindProtocol() {
  onWire("OPEN", async () => {
    if (openingRefresh) {
      return;
    }

    if (!state.session.sessionId || !state.session.sessionToken) {
      return;
    }

    openingRefresh = true;
    try {
      const refreshed = await refreshSession();

      if (refreshed) {
        setIdentity(state.username, "good");
        await setupDirectIdentity();
        await uploadBackupIfDirty();
      }
    } finally {
      openingRefresh = false;
    }
  });

  onWire("CLOSE", () => {
    if (state.blockingReason) {
      return;
    }

    setStatus("offline", "bad");
  });

  onWire("OK", (parts) => {
    if (parts[1] === "join") {
      resetPeerConnections();
      handleRoomJoined(parts[2], parts[3]).then(renderPeers);
      return;
    }

    if (parts[1] === "chat") {
      handleChatAck(parts[2]);
      return;
    }

    if (parts[1] === "dm") {
      handleDirectAck(parts[2], parts[3]);
    }
  });

  onWire("ERR", (parts) => {
    const reason = parts[1] || "request";

    if (reason === "session") {
      showBlockingScreen("Sign in required", "This device no longer has an active session. Your local chats are still here.");
      return;
    }

    showToast(`Server rejected ${reason}`, "warning");
  });

  onWire("SESSION_REPLACED", (parts) => {
    handleSessionReplaced(parts[1]).catch(() => {});
  });
  onWire("PEER", (parts) => addPeer(parts[1], parts[2] || "peer"));
  onWire("LEFT", (parts) => removePeer(parts[1]));
  onWire("CHAT", (parts) => {
    handleRoomChat(parts[1], parts[2]).catch(() => showToast("Could not decrypt room message", "warning"));
  });
  onWire("USER", (parts) => rememberDirectPeer(parts[1], parts[2], parts[3]));
  onWire("DM", (parts) => {
    handleDirectMessage(parts[1], parts[2], parts[3], parts[4]).catch(() => {
      showToast("Could not decrypt direct message", "warning");
    });
  });
  onWire("SIGNAL", (parts) => {
    handleSignal(parts[1], parts[2]).catch(() => showToast("Call negotiation failed", "warning"));
  });
  onWire("DSIGNAL", (parts) => {
    handleDirectSignal(parts[1], parts[2], parts[3], parts[4]).catch(() => showToast("Direct call negotiation failed", "warning"));
  });
  onWire("CALL_EVENT", (parts) => {
    handleCallEvent(parts).catch(() => {});
  });
}

async function sendComposerMessage() {
  const text = els.messageInput.value.trim();

  if (!text) {
    return;
  }

  if (!state.authenticated) {
    showToast("Sign in first", "warning");
    return;
  }

  const conversation = currentConversation() || activeConversation();

  if (conversation && conversation.kind === "dm") {
    await sendDirectChat(conversation.username, text);
  } else {
    await sendRoomChat(text);
  }

  els.messageInput.value = "";
  resizeComposer();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") {
    return;
  }

  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

async function restoreLocalSessionSummary() {
  const saved = await loadSavedSession();

  if (!saved) {
    setIdentity("signed out", "warn");
    return;
  }

  els.username.value = saved.username || "";
  setIdentity(`${saved.username} saved`, "warn");
  const backup = await dbGet("settings", "backup");

  if (backup && backup.dirty) {
    state.backupDirty = true;
  }
}

async function boot() {
  await openLocalDb();
  await restoreLocalSessionSummary();
  await requestStoragePersistence();
  await loadNotificationSetting();
  await loadConversations();
  loadInitialRoomInputs();
  bindEvents();
  bindProtocol();
  initializeCalls();
  renderPeers();
  resizeComposer();
  checkAppEnvironment();
  registerServiceWorker();
  connect();
}

boot().catch(() => {
  showToast("App boot failed", "error");
});
