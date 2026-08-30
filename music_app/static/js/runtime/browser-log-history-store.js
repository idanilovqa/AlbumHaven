const BROWSER_LOG_HISTORY_DATABASE_NAME = 'album-haven-client-diagnostics';
const BROWSER_LOG_HISTORY_DATABASE_VERSION = 1;
const BROWSER_LOG_HISTORY_STORE_NAME = 'log-history';
const BROWSER_LOG_HISTORY_LIMIT = 250;

function getBrowserLogHistoryNow(options = {}) {
  const value = typeof options.now === 'function' ? options.now() : new Date().toISOString();
  return String(value || new Date().toISOString());
}

function getBrowserLogHistoryRandomUUID(options = {}) {
  if (typeof options.randomUUID === 'function') {
    return String(options.randomUUID());
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return String(crypto.randomUUID());
  }
  return `browser-log-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeBrowserLogHistoryEntry(entry, options = {}) {
  const input = entry && typeof entry === 'object' ? entry : {};
  const now = getBrowserLogHistoryNow(options);
  const timestamp = String(input.timestamp || input.recorded_at || now);
  const stableId = String(input.id || '').trim();
  return {
    ...input,
    id: stableId || getBrowserLogHistoryRandomUUID(options),
    timestamp,
    recorded_at: String(input.recorded_at || timestamp),
    source: 'this_browser',
    source_label: 'This browser',
  };
}

function compareBrowserLogHistoryEntries(left, right) {
  const recordedOrder = String(right?.recorded_at || '')
    .localeCompare(String(left?.recorded_at || ''));
  if (recordedOrder) return recordedOrder;
  const timeOrder = String(right?.timestamp || '')
    .localeCompare(String(left?.timestamp || ''));
  if (timeOrder) return timeOrder;
  return String(right?.id || '').localeCompare(String(left?.id || ''));
}

function mergeBrowserLogHistoryCollections(existingEntries, incomingEntries, options = {}) {
  const byId = new Map();
  const addEntries = (entries) => {
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const normalized = normalizeBrowserLogHistoryEntry(entry, options);
      byId.set(normalized.id, normalized);
    });
  };
  addEntries(existingEntries);
  addEntries(incomingEntries);
  return Array.from(byId.values())
    .sort(compareBrowserLogHistoryEntries)
    .slice(0, BROWSER_LOG_HISTORY_LIMIT);
}

async function requestBrowserLogHistoryPersistentStorage(storageManager = (
  typeof navigator !== 'undefined' ? navigator.storage : undefined
)) {
  if (!storageManager || typeof storageManager.persist !== 'function') return false;
  try {
    return Boolean(await storageManager.persist());
  } catch (_error) {
    return false;
  }
}

function createBrowserLogHistoryStore(options = {}) {
  const databaseFactory = options.indexedDB;
  const normalizationOptions = { now: options.now, randomUUID: options.randomUUID };
  let sessionItems = [];
  let indexedDbUnavailable = !databaseFactory || typeof databaseFactory.open !== 'function';
  const persistentStatus = {
    persistent: true,
    storage: 'indexeddb',
    message: 'Stored in this browser.',
  };
  const sessionStatus = {
    persistent: false,
    storage: 'session',
    message: 'History is available for this session and will be lost on reload.',
  };

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (indexedDbUnavailable) {
        reject(new Error('IndexedDB is unavailable.'));
        return;
      }
      let request;
      try {
        request = databaseFactory.open(
          BROWSER_LOG_HISTORY_DATABASE_NAME,
          BROWSER_LOG_HISTORY_DATABASE_VERSION,
        );
      } catch (error) {
        indexedDbUnavailable = true;
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(BROWSER_LOG_HISTORY_STORE_NAME)) {
          database.createObjectStore(BROWSER_LOG_HISTORY_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        indexedDbUnavailable = true;
        reject(request.error || new Error('Unable to open browser log history.'));
      };
      request.onblocked = () => {
        indexedDbUnavailable = true;
        reject(new Error('Browser log history is blocked.'));
      };
    });
  }

  async function merge(entries) {
    const incoming = Array.isArray(entries) ? entries : [];
    if (indexedDbUnavailable) {
      sessionItems = mergeBrowserLogHistoryCollections(sessionItems, incoming, normalizationOptions);
      return { items: sessionItems.slice(), status: { ...sessionStatus } };
    }
    let database;
    try {
      database = await openDatabase();
      const items = await new Promise((resolve, reject) => {
        let mergedItems = [];
        const transaction = database.transaction(BROWSER_LOG_HISTORY_STORE_NAME, 'readwrite');
        const objectStore = transaction.objectStore(BROWSER_LOG_HISTORY_STORE_NAME);
        const readRequest = objectStore.getAll();
        readRequest.onsuccess = () => {
          mergedItems = mergeBrowserLogHistoryCollections(
            readRequest.result,
            incoming,
            normalizationOptions,
          );
          objectStore.clear();
          mergedItems.forEach((item) => objectStore.put(item));
        };
        readRequest.onerror = () => reject(readRequest.error || new Error('Unable to read browser log history.'));
        transaction.oncomplete = () => resolve(mergedItems);
        transaction.onerror = () => reject(transaction.error || new Error('Unable to update browser log history.'));
        transaction.onabort = () => reject(transaction.error || new Error('Browser log history update was aborted.'));
      });
      database.close();
      sessionItems = items.slice();
      return { items, status: { ...persistentStatus } };
    } catch (_error) {
      database?.close?.();
      indexedDbUnavailable = true;
      sessionItems = mergeBrowserLogHistoryCollections(sessionItems, incoming, normalizationOptions);
      return { items: sessionItems.slice(), status: { ...sessionStatus } };
    }
  }

  async function read() {
    if (indexedDbUnavailable) {
      return { items: sessionItems.slice(), status: { ...sessionStatus } };
    }
    let database;
    try {
      database = await openDatabase();
      const items = await new Promise((resolve, reject) => {
        let storedItems = [];
        const transaction = database.transaction(BROWSER_LOG_HISTORY_STORE_NAME, 'readonly');
        const readRequest = transaction.objectStore(BROWSER_LOG_HISTORY_STORE_NAME).getAll();
        readRequest.onsuccess = () => {
          storedItems = mergeBrowserLogHistoryCollections([], readRequest.result, normalizationOptions);
        };
        readRequest.onerror = () => reject(readRequest.error || new Error('Unable to read browser log history.'));
        transaction.oncomplete = () => resolve(storedItems);
        transaction.onerror = () => reject(transaction.error || new Error('Unable to read browser log history.'));
        transaction.onabort = () => reject(transaction.error || new Error('Browser log history read was aborted.'));
      });
      database.close();
      sessionItems = items.slice();
      return { items, status: { ...persistentStatus } };
    } catch (_error) {
      database?.close?.();
      indexedDbUnavailable = true;
      return { items: sessionItems.slice(), status: { ...sessionStatus } };
    }
  }

  return { merge, read };
}

function buildBrowserLogHistoryExportDocument(entries, options = {}) {
  return {
    schema: 'album-haven-log-history',
    version: 1,
    exported_at: getBrowserLogHistoryNow(options),
    sources: [{ id: 'this_browser', label: 'This browser' }],
    items: mergeBrowserLogHistoryCollections([], entries, options),
  };
}

const browserLogHistoryStore = createBrowserLogHistoryStore({
  indexedDB: typeof indexedDB !== 'undefined' ? indexedDB : null,
  now: () => new Date().toISOString(),
  randomUUID: () => getBrowserLogHistoryRandomUUID(),
});

function persistBrowserLogHistoryEntries(entries) {
  return browserLogHistoryStore.merge(entries);
}

function readBrowserLogHistoryEntries() {
  return browserLogHistoryStore.read();
}

async function exportBrowserLogHistory() {
  const result = await readBrowserLogHistoryEntries();
  const exportDocument = buildBrowserLogHistoryExportDocument(result.items);
  const blob = new Blob([`${JSON.stringify(exportDocument, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const filenameTimestamp = exportDocument.exported_at
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  anchor.href = objectUrl;
  anchor.download = `album-haven-log-history-${filenameTimestamp}.json`;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
  return exportDocument;
}
