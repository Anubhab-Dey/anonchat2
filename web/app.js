import { state, activeConversation, accountKeyForUsername, accountSettingKey, clearSessionOnly } from "./modules/state.js";
import { els } from "./modules/dom.js";
import { openLocalDb, dbGet } from "./modules/local-db.js";
import { connect, flushWireQueue, onWire, setStatus } from "./modules/wire.js";
import { signup, login, logoutLocalOnly } from "./modules/auth.js";
import {
  loadSavedSession,
  refreshSession,
  initializeSessionCoordination,
  ensureServerSessionReady,
  handleSessionRejected,
  handleSessionReplaced,
  clearThisDevice,
  signInAgain,
} from "./modules/device-session.js";
import { uploadBackupIfDirty } from "./modules/backup.js";
import {
  loadConversations,
  openConversation,
  currentConversation,
  resetConversationUi,
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
  handleDirectReceipt,
  handleDirectMessage,
  handleDirectDeliveryFailed,
  handleDirectUserRejected,
  rememberDirectPeer,
  retryPendingDirectOutbox,
} from "./modules/direct.js";
import {
  initializeCalls,
  startActiveCall,
  startDirectCall,
  endCallSession,
  handleCallEvent,
  minimizeCall,
  toggleCamera,
  toggleMicrophone,
} from "./modules/calls.js";
import { handleBackendRelayFrame, handleBackendRelayRejected } from "./modules/call-backend-relay.js";
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
  openNavigation,
  closeNavigation,
} from "./modules/ui.js";
import { showToast } from "./modules/toast.js";

let openingRefresh = false;
let deferredInstallPrompt = null;

function bindEvents() {
  els.menuBtn.onclick = openNavigation;
  els.closeMenuBtn.onclick = closeNavigation;
  els.drawerBackdrop.onclick = closeNavigation;
  els.connectBtn.onclick = connect;
  els.signupBtn.onclick = () => signup().catch(() => showToast("Sign up failed", "error"));
  els.loginBtn.onclick = () => login().catch(() => showToast("Sign in failed", "error"));
  els.quickChatBtn.onclick = () => {
    els.directUsername.focus();
    els.directUsername.select();
  };
  els.quickRoomBtn.onclick = () => {
    createNewRoom();
    els.room.focus();
  };
  els.startDmBtn.onclick = () => startDirectConversation().catch(() => showToast("Direct message setup failed", "error"));
  els.directCallBtn.onclick = () => startDirectCall().catch(() => showToast("Direct call setup failed", "error"));
  els.notificationBtn.onclick = () => toggleNotifications().catch(() => showToast("Notifications unavailable", "warning"));
  els.installBtn.onclick = installApp;
  els.signOutBtn.onclick = () => {
    logoutLocalOnly();
    closeNavigation();
  };
  els.clearDeviceMenuBtn.onclick = () => {
    if (confirm("Clear AnonChat data from this device?")) {
      clearThisDevice().catch(() => showToast("Could not clear this device", "error"));
    }
  };
  els.newRoomBtn.onclick = createNewRoom;
  els.joinBtn.onclick = () => joinRoom().catch(() => showToast("Could not enter room", "error"));
  els.copyInviteBtn.onclick = () => copyInvite().catch(() => showToast("Could not copy invite", "warning"));
  els.startCallBtn.onclick = () => startActiveCall().catch(() => showToast("Call setup failed", "error"));
  els.stopCallBtn.onclick = () => endCallSession();
  els.micMuteBtn.onclick = toggleMicrophone;
  els.cameraToggleBtn.onclick = toggleCamera;
  els.pipCallBtn.onclick = () => minimizeCall().catch(() => {});
  els.attachBtn.onclick = () => els.fileInput.click();
  els.fileInput.onchange = updateSelectedFile;
  els.sendFileBtn.onclick = () => sendSelectedFile().catch(() => showToast("File send failed", "error"));
  els.clearDeviceBtn.onclick = () => clearThisDevice().catch(() => showToast("Could not clear this device", "error"));
  els.signInAgainBtn.onclick = () => {
    signInAgain();
    setIdentity("Enter password", "warn");
    connect();
    els.password.focus();
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
  window.addEventListener("anonchat:conversation-call", (event) => {
    const conversation = event.detail.conversation;

    if (!conversation) {
      return;
    }

    if (conversation.kind === "dm") {
      startDirectCall(conversation.username).catch(() => showToast("Could not start call", "error"));
      return;
    }

    openConversation(conversation.id, { join: true })
      .catch(() => showToast("Could not join room", "error"));
  });
  window.addEventListener("anonchat:navigation-used", closeNavigation);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (els.installBtn) {
      els.installBtn.disabled = false;
    }
  });
  window.addEventListener("anonchat:backup-imported", () => {
    loadConversations().catch(() => {});
  });
  window.addEventListener("anonchat:session-refreshed", (event) => {
    if (!event.detail || event.detail.serverReady !== true) {
      return;
    }

    if (openingRefresh) {
      return;
    }

    setIdentity(state.username, "good");
    setupDirectIdentity()
      .then(flushWireQueue)
      .then(retryPendingDirectOutbox)
      .catch(() => {});
    loadConversations().catch(() => {});
    uploadBackupIfDirty().catch(() => {});
  });
  window.addEventListener("anonchat:account-cleared", () => {
    resetConversationUi();
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
        flushWireQueue();
        await loadConversations();
        await uploadBackupIfDirty();
        await retryPendingDirectOutbox();
      }
    } finally {
      openingRefresh = false;
    }
  });

  onWire("CLOSE", () => {
    if (state.blockingReason) {
      return;
    }

    setStatus("Offline", "bad");
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
      handleDirectAck(parts[2], parts[3], parts[4]);
    }
  });

  onWire("ERR", (parts) => {
    const reason = parts[1] || "request";

    if (reason === "session") {
      handleSessionRejected().catch(() => {
        clearSessionOnly();
        resetConversationUi();
        showBlockingScreen("Sign in needed", "Your chats are still saved here. Sign in to keep using this device.");
      });
      return;
    }

    if (reason === "user") {
      handleDirectUserRejected(parts);
      return;
    }

    if (reason === "dm") {
      handleDirectDeliveryFailed(parts).catch(() => {});
      return;
    }

    if (reason === "call_relay") {
      handleBackendRelayRejected(parts);
      return;
    }

    showToast("Request could not be completed", "warning");
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
    handleDirectMessage(parts[1], parts[2], parts[3], parts[4], parts[5]).catch(() => {
      showToast("Could not decrypt direct message", "warning");
    });
  });
  onWire("DM_RECEIPT", (parts) => {
    handleDirectReceipt(parts[1], parts[2], parts[3]).catch(() => {});
  });
  onWire("SIGNAL", (parts) => {
    handleSignal(parts[1], parts[2]).catch(() => showToast("Call could not connect", "warning"));
  });
  onWire("DSIGNAL", (parts) => {
    handleDirectSignal(parts[1], parts[2], parts[3], parts[4]).catch(() => showToast("Call could not connect", "warning"));
  });
  onWire("CALL_EVENT", (parts) => {
    handleCallEvent(parts).catch(() => {});
  });
  onWire("CALL_RELAY", (parts) => {
    handleBackendRelayFrame(parts).catch(() => {
      showToast("Connection unstable", "warning");
    });
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

  if (!(await ensureServerSessionReady())) {
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

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast("Use your browser menu to install AnonChat", "info");
    return;
  }

  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(() => {});
  deferredInstallPrompt = null;
}

async function restoreLocalSessionSummary() {
  const saved = await loadSavedSession();

  if (!saved) {
    setIdentity("Not signed in", "warn");
    return null;
  }

  els.username.value = saved.username || "";
  setIdentity(`${saved.username} saved`, "warn");
  const accountKey = accountKeyForUsername(saved.username || "");
  const backup = accountKey ? await dbGet("settings", accountSettingKey("backup", accountKey)) : null;

  if (backup && backup.dirty) {
    state.backupDirty = true;
  }

  return saved;
}

async function boot() {
  await openLocalDb();
  initializeSessionCoordination();
  await restoreLocalSessionSummary();
  loadInitialRoomInputs();
  bindEvents();
  bindProtocol();
  initializeCalls();
  renderPeers();
  resizeComposer();
  checkAppEnvironment();
  registerServiceWorker();
  connect();
  requestStoragePersistence().catch(() => {});
  loadNotificationSetting().catch(() => {});
  loadConversations().catch(() => {});
}

boot().catch(() => {
  showToast("App boot failed", "error");
});
