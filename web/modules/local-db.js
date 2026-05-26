import {
  accountKeyForUsername,
  accountSettingKey,
  currentAccountKey,
  scopedConversationId,
  state,
  unscopedConversationId,
} from "./state.js";

const DB_NAME = "anonchat-local-v1";
const DB_VERSION = 2;

export function openLocalDb() {
  if (!("indexedDB" in window)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("conversations")) {
        db.createObjectStore("conversations", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("messages")) {
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("byConversation", "conversationId");
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
    };

    request.onsuccess = () => {
      state.db = request.result;
      resolve(request.result);
    };
    request.onerror = () => resolve(null);
  });
}

export function dbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function dbStore(name, mode = "readonly") {
  if (!state.db) {
    return null;
  }

  return state.db.transaction(name, mode).objectStore(name);
}

export async function dbPut(name, value) {
  const store = dbStore(name, "readwrite");

  if (!store) {
    return;
  }

  await dbRequest(store.put(value));
}

export async function dbDelete(name, key) {
  const store = dbStore(name, "readwrite");

  if (!store) {
    return;
  }

  await dbRequest(store.delete(key));
}

export async function dbGet(name, key) {
  const store = dbStore(name);
  return store ? dbRequest(store.get(key)) : null;
}

export async function dbGetAll(name) {
  const store = dbStore(name);
  return store ? dbRequest(store.getAll()) : [];
}

export async function dbGetAccountConversations(accountKey = currentAccountKey()) {
  if (!accountKey) {
    return [];
  }

  return (await dbGetAll("conversations")).filter((conversation) => conversation.account_key === accountKey);
}

export async function dbGetConversationMessages(conversationId) {
  const accountKey = currentAccountKey();

  if (!accountKey) {
    return [];
  }

  const store = dbStore("messages");

  if (!store) {
    return [];
  }

  const index = store.index("byConversation");
  const messages = (await dbRequest(index.getAll(IDBKeyRange.only(conversationId))))
    .filter((message) => message.account_key === accountKey);
  return messages.sort((a, b) => (a.client_created_at || a.at || 0) - (b.client_created_at || b.at || 0));
}

export async function exportBackupData(username) {
  const accountKey = accountKeyForUsername(username);
  const conversations = (await dbGetAll("conversations")).filter((item) => item.account_key === accountKey);
  const messages = (await dbGetAll("messages")).filter((item) => item.account_key === accountKey);
  const settings = (await dbGetAll("settings")).filter((item) =>
    item.key &&
    item.account_key === accountKey &&
    item.key.startsWith(`account:${accountKey}:peer:`)
  ).map((item) => {
    const clone = { ...item };
    delete clone.privateJwk;
    delete clone.sessionToken;
    return clone;
  });

  return {
    schema: 1,
    username,
    account_key: accountKey,
    client_created_at: Date.now(),
    conversations,
    messages,
    settings,
  };
}

export async function importBackupData(bundle) {
  if (!bundle || bundle.schema !== 1) {
    throw new Error("unsupported backup");
  }

  const accountKey = currentAccountKey();

  if (!accountKey) {
    throw new Error("account required");
  }

  const idMap = new Map();

  for (const conversation of bundle.conversations || []) {
    const record = accountConversationRecord(conversation, accountKey);
    idMap.set(conversation.id, record.id);
    idMap.set(unscopedConversationId(conversation.id), record.id);
    await dbPut("conversations", record);
  }

  for (const message of bundle.messages || []) {
    const conversationId = idMap.get(message.conversationId) ||
      scopedConversationId(unscopedConversationId(message.conversationId), accountKey);
    await dbPut("messages", {
      ...message,
      conversationId,
      account_key: accountKey,
    });
  }

  for (const setting of bundle.settings || []) {
    if (!setting || !setting.key) {
      continue;
    }

    const peerMatch = /peer:([^:]+)$/.exec(setting.key);

    if (!peerMatch) {
      continue;
    }

    await dbPut("settings", {
      ...setting,
      key: accountSettingKey(`peer:${peerMatch[1]}`, accountKey),
      account_key: accountKey,
    });
  }
}

export async function migrateUnscopedLocalData(accountKey) {
  if (!accountKey) {
    return;
  }

  const conversations = await dbGetAll("conversations");
  const unscopedConversations = conversations.filter((item) => !item.account_key);

  const idMap = new Map();

  for (const conversation of unscopedConversations) {
    const scoped = accountConversationRecord(conversation, accountKey);
    idMap.set(conversation.id, scoped.id);
    await dbPut("conversations", scoped);
  }

  const messages = (await dbGetAll("messages")).filter((item) => !item.account_key);

  for (const message of messages) {
    const conversationId = idMap.get(message.conversationId);

    if (!conversationId) {
      continue;
    }

    await dbPut("messages", {
      ...message,
      conversationId,
      account_key: accountKey,
    });
  }

  const settings = (await dbGetAll("settings")).filter((item) => item.key && item.key.startsWith("peer:"));

  for (const setting of settings) {
    await dbPut("settings", {
      ...setting,
      key: accountSettingKey(setting.key, accountKey),
      account_key: accountKey,
    });
  }
}

function accountConversationRecord(conversation, accountKey) {
  return {
    ...conversation,
    id: scopedConversationId(unscopedConversationId(conversation.id), accountKey),
    account_key: accountKey,
  };
}

export async function deleteLocalData() {
  if (state.db) {
    state.db.close();
    state.db = null;
  }

  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });

  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("anonchat.")) {
      localStorage.removeItem(key);
    }
  }
}
