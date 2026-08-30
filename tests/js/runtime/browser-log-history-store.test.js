const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'browser-log-history-store.js');
const helperSource = fs.existsSync(helperPath) ? fs.readFileSync(helperPath, 'utf8') : '';

function loadStoreHelpers(overrides = {}) {
  const context = {
    Blob,
    URL,
    console,
    crypto: { randomUUID: () => 'generated-entry-id' },
    indexedDB: null,
    navigator: {},
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

function requireHelper(context, name) {
  assert.equal(typeof context[name], 'function', `${name} must be defined by browser-log-history-store.js`);
  return context[name];
}

function createFakeIndexedDB() {
  const databases = new Map();
  const openCalls = [];
  const transactionNames = [];
  const scheduleRequest = (request, callback) => {
    queueMicrotask(() => {
      try {
        request.result = callback();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
    });
    return request;
  };
  function createDatabaseRecord() {
    const stores = new Map();
    const database = {
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        return {};
      },
      transaction(name) {
        transactionNames.push(name);
        if (!stores.has(name)) throw new Error(`Missing object store: ${name}`);
        const records = stores.get(name);
        let pending = 0;
        let completionScheduled = false;
        const transaction = {
          error: null,
          objectStore() {
            const request = (callback) => {
              pending += 1;
              const result = {};
              scheduleRequest(result, () => {
                const value = callback();
                pending -= 1;
                scheduleCompletion();
                return value;
              });
              return result;
            };
            return {
              getAll: () => request(() => Array.from(records.values(), (item) => structuredClone(item))),
              clear: () => request(() => records.clear()),
              put: (item) => request(() => {
                records.set(String(item.id), structuredClone(item));
                return item.id;
              }),
            };
          },
        };
        function scheduleCompletion() {
          if (completionScheduled) return;
          completionScheduled = true;
          setImmediate(() => {
            completionScheduled = false;
            if (pending === 0) transaction.oncomplete?.({ target: transaction });
          });
        }
        scheduleCompletion();
        return transaction;
      },
      close() {},
    };
    return { database };
  }
  return {
    openCalls,
    transactionNames,
    open(name, version) {
      openCalls.push({ name, version });
      const request = {};
      queueMicrotask(() => {
        let created = false;
        if (!databases.has(name)) {
          databases.set(name, createDatabaseRecord());
          created = true;
        }
        request.result = databases.get(name).database;
        if (created) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    },
  };
}

test('normalization adds stable browser identity and ingestion metadata without mutating input', () => {
  const context = loadStoreHelpers();
  const normalize = requireHelper(context, 'normalizeBrowserLogHistoryEntry');
  const input = { action: 'Downloaded cover', artist: 'Mono' };
  const before = structuredClone(input);
  const normalized = normalize(input, {
    now: () => '2026-07-24T18:19:20.000Z',
    randomUUID: () => 'entry-001',
  });
  assert.deepEqual(input, before);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
    action: 'Downloaded cover',
    artist: 'Mono',
    id: 'entry-001',
    timestamp: '2026-07-24T18:19:20.000Z',
    recorded_at: '2026-07-24T18:19:20.000Z',
    source: 'this_browser',
    source_label: 'This browser',
  });
});

test('normalization preserves stable server IDs and timestamps', () => {
  const context = loadStoreHelpers();
  const normalize = requireHelper(context, 'normalizeBrowserLogHistoryEntry');
  const normalized = normalize({
    id: 'server-event-9',
    timestamp: '2026-07-23T10:00:00.000Z',
    recorded_at: '2026-07-23T10:00:01.000Z',
    action: 'Tag edit completed',
  }, { now: () => '2026-07-24T18:19:20.000Z', randomUUID: () => 'must-not-be-used' });
  assert.equal(normalized.id, 'server-event-9');
  assert.equal(normalized.timestamp, '2026-07-23T10:00:00.000Z');
  assert.equal(normalized.recorded_at, '2026-07-23T10:00:01.000Z');
});

test('merge deduplicates by ID, orders deterministically newest first, and caps at 250', () => {
  const context = loadStoreHelpers();
  const merge = requireHelper(context, 'mergeBrowserLogHistoryCollections');
  const existing = [{
    id: 'duplicate', action: 'Old value', timestamp: '2026-07-20T00:00:00.000Z', recorded_at: '2026-07-20T00:00:00.000Z',
  }];
  const incoming = Array.from({ length: 252 }, (_, index) => ({
    id: index === 2 ? 'duplicate' : `entry-${String(index).padStart(3, '0')}`,
    action: index === 2 ? 'New value' : `Activity ${index}`,
    timestamp: new Date(Date.UTC(2026, 6, 24, 0, 0, index)).toISOString(),
    recorded_at: new Date(Date.UTC(2026, 6, 24, 0, 0, index)).toISOString(),
  }));
  const merged = merge(existing, incoming, {
    now: () => '2026-07-24T18:19:20.000Z', randomUUID: () => 'unused',
  });
  assert.equal(merged.length, 250);
  assert.equal(merged[0].id, 'entry-251');
  assert.equal(merged.at(-1).id, 'duplicate');
  assert.equal(merged.filter((item) => item.id === 'duplicate').length, 1);
  assert.equal(merged.find((item) => item.id === 'duplicate').action, 'New value');
});

test('persistent-storage request is best-effort when denied, missing, or rejected', async () => {
  const context = loadStoreHelpers();
  const requestPersistence = requireHelper(context, 'requestBrowserLogHistoryPersistentStorage');
  assert.equal(await requestPersistence({ persist: async () => true }), true);
  assert.equal(await requestPersistence({ persist: async () => false }), false);
  assert.equal(await requestPersistence(undefined), false);
  assert.equal(await requestPersistence({ persist: async () => { throw new Error('rejected'); } }), false);
});

test('IndexedDB entries survive store recreation with the same browser-owned database', async () => {
  const indexedDB = createFakeIndexedDB();
  const firstContext = loadStoreHelpers({ indexedDB });
  const firstStore = requireHelper(firstContext, 'createBrowserLogHistoryStore')({
    indexedDB, now: () => '2026-07-24T18:19:20.000Z', randomUUID: () => 'entry-reload',
  });
  await firstStore.merge([{ action: 'Survives reload' }]);
  const secondContext = loadStoreHelpers({ indexedDB });
  const secondStore = requireHelper(secondContext, 'createBrowserLogHistoryStore')({
    indexedDB, now: () => '2026-07-24T19:00:00.000Z', randomUUID: () => 'unused',
  });
  const result = await secondStore.read();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'entry-reload');
  assert.equal(result.items[0].action, 'Survives reload');
  assert.equal(result.status.persistent, true);
  assert.ok(indexedDB.openCalls.length >= 2);
  assert.ok(indexedDB.openCalls.every((call) => (
    call.name === 'album-haven-client-diagnostics' && call.version === 1
  )));
  assert.ok(indexedDB.transactionNames.every((name) => name === 'log-history'));
});

test('blocked IndexedDB retains a bounded session fallback and visibly reports reload loss', async () => {
  const context = loadStoreHelpers();
  const createStore = requireHelper(context, 'createBrowserLogHistoryStore');
  const blockedIndexedDB = { open() { throw new Error('IndexedDB is blocked'); } };
  let nextId = 0;
  const store = createStore({
    indexedDB: blockedIndexedDB,
    now: () => '2026-07-24T18:19:20.000Z',
    randomUUID: () => `fallback-${nextId++}`,
  });
  await store.merge(Array.from({ length: 260 }, (_, index) => ({
    action: `Fallback ${index}`,
    recorded_at: new Date(Date.UTC(2026, 6, 24, 0, 0, index)).toISOString(),
  })));
  const result = await store.read();
  assert.equal(result.items.length, 250);
  assert.equal(result.status.persistent, false);
  assert.equal(result.status.storage, 'session');
  assert.match(result.status.message, /not survive|lost.*reload|reload.*lost/i);
  const recreatedStore = createStore({
    indexedDB: blockedIndexedDB, now: () => '2026-07-24T19:00:00.000Z', randomUUID: () => 'unused',
  });
  assert.equal((await recreatedStore.read()).items.length, 0);
});

test('export document is versioned, bounded, timestamped, and identifies browser sources', () => {
  const context = loadStoreHelpers();
  const buildExport = requireHelper(context, 'buildBrowserLogHistoryExportDocument');
  const document = buildExport(Array.from({ length: 255 }, (_, index) => ({
    id: `entry-${index}`,
    action: `Activity ${index}`,
    timestamp: new Date(Date.UTC(2026, 6, 24, 0, 0, index)).toISOString(),
    recorded_at: new Date(Date.UTC(2026, 6, 24, 0, 0, index)).toISOString(),
    source: 'this_browser',
    source_label: 'This browser',
  })), { now: () => '2026-07-24T20:00:00.000Z' });
  assert.equal(document.schema, 'album-haven-log-history');
  assert.equal(document.version, 1);
  assert.equal(document.exported_at, '2026-07-24T20:00:00.000Z');
  const serialized = JSON.stringify(document);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed.sources, [{ id: 'this_browser', label: 'This browser' }]);
  assert.equal(parsed.items.length, 250);
  assert.equal(parsed.items[0].source_label, 'This browser');
});
