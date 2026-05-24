import { state } from "./state.js";

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

export async function dbGetConversationMessages(conversationId) {
  const store = dbStore("messages");

  if (!store) {
    return [];
  }

  const index = store.index("byConversation");
  const messages = await dbRequest(index.getAll(IDBKeyRange.only(conversationId)));
  return messages.sort((a, b) => (a.client_created_at || a.at || 0) - (b.client_created_at || b.at || 0));
}

export async function exportBackupData(username) {
  const settings = (await dbGetAll("settings")).filter((item) =>
    item.key &&
    (item.key.startsWith("peer:") ||
     item.key === "notifications" ||
     item.key === `identity:${username.toLowerCase()}`)
  ).map((item) => {
    const clone = { ...item };
    delete clone.privateJwk;
    delete clone.sessionToken;
    return clone;
  });

  return {
    schema: 1,
    username,
    client_created_at: Date.now(),
    conversations: await dbGetAll("conversations"),
    messages: await dbGetAll("messages"),
    settings,
  };
}

export async function importBackupData(bundle) {
  if (!bundle || bundle.schema !== 1) {
    throw new Error("unsupported backup");
  }

  for (const conversation of bundle.conversations || []) {
    await dbPut("conversations", conversation);
  }

  for (const message of bundle.messages || []) {
    await dbPut("messages", message);
  }

  for (const setting of bundle.settings || []) {
    await dbPut("settings", setting);
  }
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
