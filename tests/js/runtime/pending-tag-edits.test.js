const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const modulePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'pending-tag-edits.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const SAVE_ID = '8b1f6a52-3c4d-4e5f-9a0b-1c2d3e4f5a6b';
const STATUS_URL = '/utilities/edit-tags/requests/status';

// One retry pass asks about every waiting save in one request (6.5, 11-22); this is its answer for one save.
function known(found, status, id = SAVE_ID) {
  return { status: 200, body: { ok: true, requests: { [id]: { found, status } }, invalid: [] } };
}

// Owner (2026-11-17): a save without a server answer is never rolled back or lost; it waits in the Edit Queue.
function loadPendingTagEdits({ answers, stored = null }) {
  const storage = new Map(stored ? [['albumHaven.pendingTagEdits', JSON.stringify(stored)]] : []);
  const timers = [];
  const requests = [];
  const calls = { refreshes: 0, toasts: [], events: [] };
  const context = {
    console,
    JSON,
    Promise,
    Date,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    window: { dispatchEvent: (event) => calls.events.push(event.detail.entries) },
    getLocalStorageItem: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
    setLocalStorageItem: (key, value) => storage.set(key, value),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    showToast: (message, variant) => calls.toasts.push([message, variant]),
    refreshCurrentViewAfterBackgroundCompletion: async () => { calls.refreshes += 1; },
    fetch: async (url, options = {}) => {
      requests.push([options.method || 'GET', String(url), options.body ? JSON.parse(options.body) : null]);
      const answer = typeof answers === 'function' ? answers(JSON.parse(options.body)) : answers.shift();
      if (answer instanceof Error) throw answer;
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    },
  };
  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: modulePath });
  const runNext = async () => {
    const timer = timers.shift();
    assert.ok(timer, 'a check is scheduled');
    await timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
    return timer.ms;
  };
  return { api: context.window.AlbumHavenPendingTagEdits, storage, timers, requests, calls, runNext };
}

const payload = { confirmed: true, client_request_id: SAVE_ID, album: { name: 'Album' }, updates: { 'a.mp3': { year: '2006' } } };

test('a save the server never received is sent again under the same id and leaves the queue once saved', async () => {
  const { api, storage, requests, calls, runNext } = loadPendingTagEdits({
    answers: [
      known(false, null),
      { status: 200, body: { ok: true, save_task_id: 't1', save_task_status: 'completed' } },
    ],
  });
  api.add({ id: SAVE_ID, payload, album: { key: 'a::b', name: 'Album' }, trackCount: 5 });
  assert.equal(api.list()[0].state, 'waiting');
  assert.equal(api.list()[0].payload, undefined, 'listeners never see the raw payload');
  await runNext();
  assert.deepEqual(requests.map(([method, url]) => [method, url]), [
    ['POST', STATUS_URL],
    ['POST', '/utilities/edit-tags'],
  ]);
  assert.deepEqual(requests[0][2], { ids: [SAVE_ID] });
  assert.equal(requests[1][2].client_request_id, SAVE_ID, 'the resend carries the same id');
  assert.equal(api.list().length, 0);
  assert.equal(JSON.parse(storage.get('albumHaven.pendingTagEdits')).length, 0);
  assert.equal(calls.refreshes, 1, 'the view shows what the library now holds');
});

test('a save the server reports as rolled back stays in the queue as failed and is not resent', async () => {
  const { api, requests, calls, runNext, timers } = loadPendingTagEdits({
    answers: [known(true, 'rolled_back')],
  });
  api.add({ id: SAVE_ID, payload, album: { name: 'Album' } });
  await runNext();
  assert.equal(requests.length, 1);
  assert.equal(api.list()[0].state, 'failed');
  assert.equal(calls.toasts.length, 1);
  assert.equal(timers.length, 0, 'a failed save waits for Retry or Discard');
});

test('a save still running or already received keeps waiting; no answer keeps it and backs off', async () => {
  const { api, requests, runNext } = loadPendingTagEdits({
    answers: [
      known(true, 'files_verified'),
      new Error('network down'),
      known(false, null),
      { status: 409, body: { ok: false, code: 'duplicate_request', intent_status: 'prepared' } },
    ],
  });
  api.add({ id: SAVE_ID, payload });
  assert.equal(await runNext(), 2000);
  assert.equal(api.list()[0].state, 'waiting');
  assert.equal(await runNext(), 2000);
  const backoff = await runNext();
  assert.equal(backoff, 4000, 'an unreachable server is asked less often');
  assert.equal(api.list().length, 1, 'nothing is dropped while the server is unreachable');
  await runNext();
  assert.equal(api.list()[0].state, 'waiting', 'a duplicate means the first copy is being saved');
  assert.equal(requests.filter(([, url]) => url === '/utilities/edit-tags').length, 1);
});

test('a page load resumes saves that were waiting and keeps failed ones for the Edit Queue', async () => {
  const { api, timers } = loadPendingTagEdits({
    answers: [],
    stored: [
      { id: SAVE_ID, payload, album: { name: 'Album' }, state: 'waiting' },
      { id: '0b1f6a52-3c4d-4e5f-9a0b-1c2d3e4f5a6b', payload, album: { name: 'Other' }, state: 'failed' },
    ],
  });
  assert.equal(api.list().length, 2);
  assert.equal(timers.length, 1, 'waiting saves are checked again after load');
  api.discard('0b1f6a52-3c4d-4e5f-9a0b-1c2d3e4f5a6b');
  assert.deepEqual(api.list().map((entry) => entry.id), [SAVE_ID]);
});

test('bounded interaction: a retry pass sends one status request per 500 waiting saves, keeps one retry timer and refreshes the view once however many saves it settles', async () => {
  const { createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter');
  const retryPass = async (pendingSaves) => {
    const counter = createInteractionCounter();
    const live = new Set();
    let nextTimer = 0;
    // The timer's callback starts the pass without returning it; the pass ends with the view refresh.
    let passEnded;
    const ended = new Promise((resolve) => { passEnded = resolve; });
    const context = {
      console, JSON, Promise, Date,
      CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
      window: { dispatchEvent() {} },
      getLocalStorageItem: (_key, fallback) => fallback,
      setLocalStorageItem() {},
      setTimeout: (fn) => { nextTimer += 1; live.add(nextTimer); live[nextTimer] = fn; return nextTimer; },
      clearTimeout: (id) => { live.delete(id); },
      showToast() {},
      refreshCurrentViewAfterBackgroundCompletion: async () => { counter.count('renderCommits'); passEnded(); },
      // Every waiting save is confirmed by the server: each is settled in this one pass.
      fetch: async (_url, options = {}) => {
        counter.count('requests');
        const ids = JSON.parse(options.body || '{"ids":[]}').ids || [];
        const requests = Object.fromEntries(ids.map((id) => [id, { found: true, status: 'completed' }]));
        return { ok: true, status: 200, json: async () => ({ ok: true, requests, invalid: [] }) };
      },
    };
    vm.createContext(context);
    vm.runInContext(moduleSource, context, { filename: modulePath });
    const api = context.window.AlbumHavenPendingTagEdits;
    for (let index = 0; index < pendingSaves; index += 1) {
      api.add({ id: `save-${index}`, payload: { confirmed: true }, album: { name: `Album ${index}` }, trackCount: 1 });
    }
    assert.equal(live.size, 1, 'adding saves re-arms the one retry timer');
    const [armed] = live;
    const measured = await counter.measure(async () => {
      live.delete(armed);
      live[armed]();
      await ended;
      await new Promise((resolve) => setImmediate(resolve)); // the pass's last schedule() runs after the refresh starts
      counter.count('timers', live.size);
    });
    assert.deepEqual(api.list(), [], 'every confirmed save left the queue');
    return measured;
  };
  await measureScalePair({
    id: 'js:runtime/pending-tag-edits.js#schedule',
    // Above the route's 500-id cap: a pass asks in chunks of 500, so 1,200 saves take 3 requests.
    small: 1,
    large: 1200,
    run: retryPass,
    budgets: { requests: 3, timers: 1, renderCommits: 1 },
    growth: { metric: 'requests', largeMinusSmallMax: 2 },
  });
});

// Owner (2026-11-23): a save whose files are written is saved; while the library catches up ("finishing"),
// a reload or another tab still shows the new values. The pending edit stays in this storage, is never
// resent, and its values are laid over every display site until the save settles. No list UI here.
function loadWithOverlay({ answers = [], stored = null, scope = 'scope-a', now = Date.now() } = {}) {
  const storage = new Map(stored ? [['albumHaven.pendingTagEdits', JSON.stringify(stored)]] : []);
  const timers = [];
  const requests = [];
  const listeners = {};
  const calls = { refreshes: 0, overlays: [], nonAlbum: [], renders: 0, warnings: [] };
  const context = {
    console: { ...console, warn: (...args) => calls.warnings.push(args.join(' ')) },
    JSON,
    Promise,
    Date: class extends Date { static now() { return now; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    document: { querySelector: (selector) => (selector === 'meta[name="album-haven-edit-scope"]' ? { content: scope } : null) },
    window: {
      dispatchEvent() {},
      addEventListener: (type, listener) => { (listeners[type] ||= []).push(listener); },
    },
    getLocalStorageItem: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
    setLocalStorageItem: (key, value) => storage.set(key, value),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    showToast() {},
    refreshCurrentViewAfterBackgroundCompletion: async () => { calls.refreshes += 1; },
    buildOptimisticUpdatedAlbumsFromEdits: (album, updates) => [{ ...album, edited: updates }],
    applyUpdatedAlbumsToCurrentView: (albums, options) => { calls.overlays.push([albums, options]); return albums; },
    applyTagEditsToNonAlbumView: (album, updates) => calls.nonAlbum.push([album, updates]),
    renderView: () => { calls.renders += 1; },
    fetch: async (url, options = {}) => {
      requests.push([options.method || 'GET', String(url)]);
      const ids = JSON.parse(options.body || '{"ids":[]}').ids || [];
      const answer = answers.shift() || { status: 200, body: {
        ok: true, requests: Object.fromEntries(ids.map((id) => [id, { found: true, status: 'files_verified' }])), invalid: [],
      } };
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    },
  };
  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: modulePath });
  const runNext = async () => {
    const timer = timers.shift();
    assert.ok(timer, 'a check is scheduled');
    await timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
    return timer.ms;
  };
  const fireStorage = () => (listeners.storage || []).forEach((listener) => listener({ key: 'albumHaven.pendingTagEdits' }));
  return { api: context.window.AlbumHavenPendingTagEdits, storage, timers, requests, calls, runNext, fireStorage };
}

const finishingAlbum = { key: 'artist::album', name: 'Album', tracks: [{ path: 'a.mp3', title: 'Old' }] };
const finishingPayload = { confirmed: true, client_request_id: SAVE_ID, album: { name: 'Album' }, updates: { 'a.mp3': { title: 'New' } } };

test('a finishing save is only checked, never resent, and leaves storage once the library holds it', async () => {
  const { api, requests, calls, runNext } = loadWithOverlay({
    answers: [known(true, 'completed')],
  });
  api.addFinishing({ id: SAVE_ID, payload: finishingPayload, album: finishingAlbum });
  assert.equal(api.list()[0].state, 'finishing');
  await runNext();
  assert.deepEqual(requests, [['POST', STATUS_URL]], 'a finishing save is never resent');
  assert.equal(api.list().length, 0);
  assert.equal(calls.refreshes, 1, 'the view re-reads what the library now holds');
});

test('a finishing save the library has not caught up with is checked less and less often, up to a minute', async () => {
  const { api, runNext } = loadWithOverlay();
  api.addFinishing({ id: SAVE_ID, payload: finishingPayload, album: finishingAlbum });
  const delays = [];
  for (let pass = 0; pass < 7; pass += 1) delays.push(await runNext());
  assert.ok(delays.every((delay, index) => index === 0 || delay >= delays[index - 1]), `delays: ${delays}`);
  assert.equal(Math.max(...delays), 60000);
});

test('a pending save with no answer for 24 hours is dropped and logged, never checked forever', async () => {
  const day = 24 * 60 * 60 * 1000;
  const { api, requests, calls } = loadWithOverlay({
    now: 10 * day,
    stored: [{ id: SAVE_ID, payload: finishingPayload, state: 'finishing', scope: 'scope-a', created_at: 10 * day - day - 1 }],
  });
  assert.equal(api.list().length, 0, 'the expired entry was dropped');
  assert.equal(requests.length, 0);
  assert.ok(calls.warnings.some((line) => line.includes('Dropped')), 'the drop was logged');
});

test('a save another tab added is kept when this tab writes (T4)', () => {
  const { api, storage } = loadWithOverlay();
  storage.set('albumHaven.pendingTagEdits', JSON.stringify([
    { id: 'other-tab', payload: finishingPayload, state: 'finishing', scope: 'scope-a', created_at: Date.now() },
  ]));
  api.addFinishing({ id: SAVE_ID, payload: finishingPayload, album: finishingAlbum });
  const ids = JSON.parse(storage.get('albumHaven.pendingTagEdits')).map((entry) => entry.id).sort();
  assert.deepEqual(ids, ['other-tab', SAVE_ID].sort());
});

test('pending saves of another account or library are neither shown nor checked here (T3)', async () => {
  const { api, requests, calls, timers } = loadWithOverlay({
    scope: 'scope-b',
    stored: [{ id: SAVE_ID, payload: finishingPayload, display_album: finishingAlbum, state: 'finishing', scope: 'scope-a', created_at: Date.now() }],
  });
  api.overlayCurrentView();
  assert.equal(calls.overlays.length, 0, 'another scope was laid over this view');
  assert.equal(api.list().length, 0, 'another scope is listed here');
  assert.equal(timers.length, 0);
  assert.equal(requests.length, 0);
});

test('a finishing save is laid over the view after a load and when another tab adds it', () => {
  const { api, calls, storage, fireStorage } = loadWithOverlay();
  api.addFinishing({ id: SAVE_ID, payload: finishingPayload, album: finishingAlbum });
  api.overlayCurrentView();
  assert.equal(calls.overlays.length, 1);
  const [albums, options] = calls.overlays[0];
  assert.deepEqual(JSON.parse(JSON.stringify(options.tagEdits)), finishingPayload.updates);
  assert.equal(albums[0].key, 'artist::album');
  assert.equal(options.skipRender, true);

  // Another tab's save arrives through the storage event: laid over and rendered.
  storage.set('albumHaven.pendingTagEdits', JSON.stringify([
    ...JSON.parse(storage.get('albumHaven.pendingTagEdits')),
    { id: 'other-tab', payload: { updates: { 'b.mp3': { title: 'Other' } } }, display_album: { key: 'x::y', tracks: [] },
      state: 'finishing', scope: 'scope-a', created_at: Date.now() },
  ]));
  fireStorage();
  assert.equal(calls.overlays.length, 3, 'both open saves were laid over after the other tab wrote');
  assert.equal(calls.renders, 1);
});

test('the values of a finishing save replace the stored ones in fetched album details', () => {
  const { api } = loadWithOverlay();
  api.addFinishing({ id: SAVE_ID, payload: finishingPayload, album: finishingAlbum });
  const shown = api.overlayAlbumDetails({ key: 'artist::album', tracks: [{ path: 'a.mp3', title: 'Old' }, { path: 'c.mp3', title: 'C' }] });
  assert.deepEqual(shown.tracks.map((track) => track.title), ['New', 'C']);
});

test('a status answer that rejects a save id keeps that save waiting and settles the others', async () => {
  const OTHER_ID = '0b1f6a52-3c4d-4e5f-9a0b-1c2d3e4f5a6b';
  const { api, requests, runNext } = loadPendingTagEdits({
    answers: [{ status: 200, body: { ok: true, requests: { [OTHER_ID]: { found: true, status: 'completed' } }, invalid: [SAVE_ID] } }],
  });
  api.add({ id: SAVE_ID, payload, album: { name: 'Album' } });
  api.add({ id: OTHER_ID, payload: { ...payload, client_request_id: OTHER_ID }, album: { name: 'Other' } });
  await runNext();
  assert.deepEqual(requests, [['POST', STATUS_URL, { ids: [SAVE_ID, OTHER_ID] }]], 'one request, never a resend of a rejected id');
  assert.deepEqual(api.list().map((entry) => [entry.id, entry.state]), [[SAVE_ID, 'waiting']]);
});

test('more waiting saves than one status request may carry all settle in the same pass (6.5, 11-23)', async () => {
  const ids = Array.from({ length: 501 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  // Each status request is answered for exactly the ids it carried.
  const { api, requests, runNext } = loadPendingTagEdits({
    answers: (body) => ({ status: 200, body: {
      ok: true, requests: Object.fromEntries(body.ids.map((id) => [id, { found: true, status: 'completed' }])), invalid: [],
    } }),
  });
  ids.forEach((id) => api.add({ id, payload: { ...payload, client_request_id: id }, album: { name: id } }));
  await runNext();
  assert.deepEqual(requests.map(([method, url, body]) => [method, url, body.ids.length]), [
    ['POST', STATUS_URL, 500], ['POST', STATUS_URL, 1],
  ], 'one request per 500 ids, each within the route cap');
  assert.deepEqual(api.list(), [], 'the 501st save settled in the same pass');
});
