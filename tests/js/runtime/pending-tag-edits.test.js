const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const modulePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'pending-tag-edits.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const SAVE_ID = '8b1f6a52-3c4d-4e5f-9a0b-1c2d3e4f5a6b';

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
      const answer = answers.shift();
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
      { status: 200, body: { ok: true, found: false, status: null } },
      { status: 200, body: { ok: true, save_task_id: 't1', save_task_status: 'completed' } },
    ],
  });
  api.add({ id: SAVE_ID, payload, album: { key: 'a::b', name: 'Album' }, trackCount: 5 });
  assert.equal(api.list()[0].state, 'waiting');
  assert.equal(api.list()[0].payload, undefined, 'listeners never see the raw payload');
  await runNext();
  assert.deepEqual(requests.map(([method, url]) => [method, url]), [
    ['GET', `/utilities/edit-tags/requests/${SAVE_ID}`],
    ['POST', '/utilities/edit-tags'],
  ]);
  assert.equal(requests[1][2].client_request_id, SAVE_ID, 'the resend carries the same id');
  assert.equal(api.list().length, 0);
  assert.equal(JSON.parse(storage.get('albumHaven.pendingTagEdits')).length, 0);
  assert.equal(calls.refreshes, 1, 'the view shows what the library now holds');
});

test('a save the server reports as rolled back stays in the queue as failed and is not resent', async () => {
  const { api, requests, calls, runNext, timers } = loadPendingTagEdits({
    answers: [{ status: 200, body: { ok: true, found: true, status: 'rolled_back' } }],
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
      { status: 200, body: { ok: true, found: true, status: 'files_verified' } },
      new Error('network down'),
      { status: 200, body: { ok: true, found: false, status: null } },
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
  assert.equal(requests.filter(([method]) => method === 'POST').length, 1);
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
