const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const plain = value => JSON.parse(JSON.stringify(value));
function api() {
  const filename = path.join(runtime, 'utility-log-history-query.js');
  const context = vm.createContext({ Date, Intl, URL, URLSearchParams, console, AbortController });
  if (fs.existsSync(filename)) vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  assert.equal(typeof context.normalizeUtilityLogHistoryQuery, 'function', 'approved calendar query helper must exist');
  assert.equal(typeof context.createUtilityLogHistoryQueryController, 'function', 'approved snapshot controller must exist');
  return context;
}
const clock = { now: new Date('2026-09-09T18:00:00Z'), timeZone: 'America/Denver' };
const custom = (fromDate, toDate) => ({ preset: 'custom', fromDate, toDate });
function fixture(overrides = {}) {
  const calls = [], exports = [];
  const controller = api().createUtilityLogHistoryQueryController({
    contextKey: 'library:9', now: clock.now, timeZone: clock.timeZone,
    fetchPage: async request => { calls.push(plain(request)); return { items: [{ id: 'a' }], snapshot: 'snapshot-a', next_cursor: null, revision: '7' }; },
    exportQuery: async request => { exports.push(plain(request)); return { count: 1 }; },
    onChange() {}, ...overrides,
  });
  return { controller, calls, exports };
}
async function apply(controller, draft = { preset: 'today' }) { controller.beginDraft(draft); await controller.applyDraft(); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
for (const [preset, expected] of [['today', '2026-09-09T06:00:00.000Z'], ['7-days', '2026-09-03T06:00:00.000Z'], ['30-days', '2026-08-11T06:00:00.000Z']]) {
  test(`${preset} includes today and uses local calendar boundaries`, () => {
    const query = api().normalizeUtilityLogHistoryQuery({ preset }, clock);
    assert.equal(query.from_utc, expected);
    assert.equal(query.to_utc, '2026-09-10T06:00:00.000Z');
  });
}
for (const [date, start, end] of [
  ['2026-03-08', '2026-03-08T07:00:00.000Z', '2026-03-09T06:00:00.000Z'],
  ['2026-11-01', '2026-11-01T06:00:00.000Z', '2026-11-02T07:00:00.000Z'],
]) test(`custom ${date} includes the whole DST transition day`, () => {
  const query = api().normalizeUtilityLogHistoryQuery(custom(date, date), clock);
  assert.equal(query.from_utc, start); assert.equal(query.to_utc, end);
});
for (const [date, start, end] of [
  ['2026-09-05', '2026-09-05T04:00:00.000Z', '2026-09-06T04:00:00.000Z'],
  ['2026-09-06', '2026-09-06T04:00:00.000Z', '2026-09-07T03:00:00.000Z'],
]) test(`Santiago ${date} includes the whole date across skipped midnight`, () => {
  const query = api().normalizeUtilityLogHistoryQuery(custom(date, date), { ...clock, timeZone: 'America/Santiago' });
  assert.equal(query.from_utc, start);
  assert.equal(query.to_utc, end);
});

test('repeated Havana midnight starts at its first occurrence', () => {
  const query = api().normalizeUtilityLogHistoryQuery(custom('2026-11-01', '2026-11-01'), { ...clock, timeZone: 'America/Havana' });
  assert.equal(query.from_utc, '2026-11-01T04:00:00.000Z');
  assert.equal(query.to_utc, '2026-11-02T05:00:00.000Z');
});

test('calendar conversion uses the displayed timezone rather than the process timezone', () => {
  const query = api().normalizeUtilityLogHistoryQuery(custom('2026-09-09', '2026-09-09'), { ...clock, timeZone: 'Asia/Kathmandu' });
  assert.equal(query.from_utc, '2026-09-08T18:15:00.000Z');
  assert.equal(query.to_utc, '2026-09-09T18:15:00.000Z');
});
for (const draft of [custom('2026-02-30', '2026-03-01'), custom('2026-09-10', '2026-09-09'), custom('', '2026-09-09')]) {
  test(`invalid calendar input cannot change the committed query: ${JSON.stringify(draft)}`, async () => {
    const { controller, calls } = fixture(); await apply(controller);
    const before = plain(controller.getState()); controller.beginDraft(draft);
    await assert.rejects(async () => controller.applyDraft());
    assert.deepEqual(plain(controller.getState().query), before.query);
    assert.equal(controller.getState().snapshot, before.snapshot); assert.equal(calls.length, 1);
  });
}
test('canceling an export draft preserves the captured query and causes no download', async () => {
  const { controller, calls, exports } = fixture(); await apply(controller);
  const before = plain(controller.getState()); controller.beginDraft({ preset: '30-days' }); controller.cancelDraft();
  assert.deepEqual(plain(controller.getState().query), before.query);
  assert.equal(controller.getState().snapshot, before.snapshot); assert.equal(calls.length, 1); assert.equal(exports.length, 0);
});
test('one temporary query row retains its identity and clear restores ordinary event selection', async () => {
  const { controller } = fixture(); await controller.selectEvent('ordinary-event'); await apply(controller);
  const id = controller.getState().temporaryRowId; assert.ok(id);
  await apply(controller, { preset: '7-days' }); assert.equal(controller.getState().temporaryRowId, id);
  controller.clear(); assert.equal(controller.getState().temporaryRowId, null);
  assert.equal(controller.getState().selectedEventId, 'ordinary-event');
});
test('later pages retain query and snapshot and deduplicate public event IDs', async () => {
  const calls = []; const { controller } = fixture({ fetchPage: async request => {
    calls.push(plain(request)); return calls.length === 1
      ? { items: [{ id: 'a' }], snapshot: 'fixed', next_cursor: 'page2', revision: '1' }
      : { items: [{ id: 'a' }, { id: 'b' }], snapshot: 'fixed', next_cursor: null, revision: '1' };
  } });
  await apply(controller); await controller.loadMore();
  assert.deepEqual(calls[1].query, calls[0].query); assert.equal(calls[1].snapshot, 'fixed');
  assert.equal(calls[1].cursor, 'page2'); assert.equal(calls[1].page_size, 500);
  assert.deepEqual(plain(controller.getState().items).map(item => item.id), ['a', 'b']);
});
test('late response for replaced query cannot replace the visible snapshot', async () => {
  const first = deferred(); let count = 0;
  const { controller } = fixture({ fetchPage: async () => ++count === 1 ? first.promise : { items: [{ id: 'new' }], snapshot: 'new', next_cursor: null } });
  const pending = apply(controller); await apply(controller, { preset: '7-days' });
  first.resolve({ items: [{ id: 'old' }], snapshot: 'old', next_cursor: null }); await pending;
  assert.equal(controller.getState().snapshot, 'new'); assert.deepEqual(plain(controller.getState().items), [{ id: 'new' }]);
});
test('library change clears data and rejects a delayed prior-library response', async () => {
  const pendingPage = deferred(); const { controller } = fixture({ fetchPage: () => pendingPage.promise });
  const pending = apply(controller); controller.setContext('library:10');
  pendingPage.resolve({ items: [{ id: 'private-old-library' }], snapshot: 'old', next_cursor: null }); await pending;
  assert.deepEqual(plain(controller.getState().items), []); assert.equal(controller.getState().snapshot, null);
});
test('status revisions and returned mutation events mark captured query stale without inserting rows', async () => {
  const { controller, calls } = fixture(); await apply(controller);
  controller.markStale('8', { id: 'new-event', files: ['C:/private/music.flac'] });
  assert.equal(controller.getState().stale, true); assert.equal(controller.getState().snapshot, 'snapshot-a');
  assert.deepEqual(plain(controller.getState().items), [{ id: 'a' }]); assert.equal(calls.length, 1);
});
test('expired continuation keeps the snapshot and exposes refresh instead of silently restarting', async () => {
  let calls = 0; const { controller } = fixture({ fetchPage: async () => {
    if (++calls > 1) throw Object.assign(new Error('Snapshot expired'), { status: 410 });
    return { items: [{ id: 'a' }], snapshot: 'expired', next_cursor: 'next' };
  } });
  await apply(controller); await controller.loadMore().catch(() => {});
  assert.equal(calls, 2); assert.equal(controller.getState().snapshot, 'expired');
  assert.equal(controller.getState().refreshRequired, true);
});
test('individual detail captures event_ids query and exports exactly its displayed snapshot', async () => {
  const { controller, calls, exports } = fixture(); await controller.selectEvent('a'); await controller.exportCurrent();
  assert.deepEqual(calls[0].query.event_ids, ['a']);
  assert.deepEqual(exports[0], { query: calls[0].query, snapshot: 'snapshot-a' });
});
test('period export shares committed normalized filters and captured snapshot', async () => {
  const { controller, calls, exports } = fixture();
  await apply(controller, { preset: '7-days', sources: ['scan'], event_types: ['Tags edited'], text: 'AC/DC' });
  await controller.exportCurrent(); assert.deepEqual(exports[0], { query: calls[0].query, snapshot: 'snapshot-a' });
});
test('missing individual event cannot export another selected version', async () => {
  const { controller, exports } = fixture({ fetchPage: async () => ({ items: [], snapshot: 'empty', next_cursor: null }) });
  await controller.selectEvent('gone'); await assert.rejects(async () => controller.exportCurrent()); assert.equal(exports.length, 0);
});
test('operational load failure surfaces an error without browser-store fallback', async () => {
  const { controller } = fixture({ fetchPage: async () => { throw new Error('Server unavailable'); } });
  await apply(controller).catch(() => {}); const state = controller.getState();
  assert.deepEqual(plain(state.items), []); assert.equal(state.snapshot, null); assert.match(String(state.error), /unavailable/i);
});
test('live history loaders and mutation reconciliation never persist or read IndexedDB', () => {
  const loader = fs.readFileSync(path.join(runtime, 'utility-loaders-and-cover-lookup.js'), 'utf8');
  const builders = fs.readFileSync(path.join(runtime, 'utility-list-builders.js'), 'utf8');
  assert.doesNotMatch(loader, /(?:persistBrowserLogHistoryEntries|readBrowserLogHistoryEntries|requestBrowserLogHistoryPersistentStorage)\s*\(/);
  const insertion = builders.match(/async function prependUtilityLogHistoryEntry\([^]*?(?=\nfunction |\nasync function )/)?.[0] || '';
  assert.doesNotMatch(insertion, /persistBrowserLogHistoryEntries|normalizeBrowserLogHistoryEntry|\.slice\(0,\s*250\)/);
});
test('status errors cannot synthesize operational events containing private paths', () => {
  const source = fs.readFileSync(path.join(runtime, 'gallery-refresh-and-status.js'), 'utf8');
  assert.doesNotMatch(source, /prependUtilityLogHistoryEntry\s*\(\s*\{/);
  assert.doesNotMatch(source, /library-status-error:/);
});
test('library context invalidation discards a pending draft as well as old results', async () => {
  const { controller } = fixture(); await apply(controller);
  controller.beginDraft({ preset: '30-days', text: 'old-library-private' }); controller.setContext('library:10');
  assert.equal(controller.getState().draft, null);
  await assert.rejects(async () => controller.applyDraft());
});
test('explicit Refresh captures a new snapshot only after the user requests it', async () => {
  let calls = 0; const { controller } = fixture({ fetchPage: async () => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error('Snapshot expired'), { status: 410 });
    return { items: [{ id: `entry-${calls}` }], snapshot: `snapshot-${calls}`, next_cursor: calls === 1 ? 'next' : null };
  } });
  await apply(controller); await controller.loadMore().catch(() => {});
  assert.equal(calls, 2); assert.equal(controller.getState().refreshRequired, true);
  await controller.refresh(); assert.equal(calls, 3);
  assert.equal(controller.getState().snapshot, 'snapshot-3'); assert.equal(controller.getState().refreshRequired, false);
});

test('ordinary selection retains the temporary period and returning to it uses its captured snapshot', async () => {
  const { controller, calls } = fixture();
  await apply(controller); const period = plain(controller.getState());
  await controller.selectEvent('a');
  assert.equal(controller.getState().temporaryRowId, period.temporaryRowId);
  assert.equal(typeof controller.selectPeriod, 'function');
  const before = calls.length; controller.selectPeriod();
  assert.equal(calls.length, before);
  assert.deepEqual(plain(controller.getState().query), period.query);
  assert.equal(controller.getState().snapshot, period.snapshot);
  assert.equal(controller.getState().selectedEventId, '');
});

test('expired export exposes explicit refresh and does not silently export a new snapshot', async () => {
  const { controller } = fixture({ exportQuery: async () => { throw Object.assign(new Error('Snapshot expired'), { status: 410 }); } });
  await apply(controller); await assert.rejects(() => controller.exportCurrent());
  assert.equal(controller.getState().refreshRequired, true);
  assert.equal(controller.getState().snapshot, 'snapshot-a');
});

test('an export that completes after context invalidation cannot be delivered', async () => {
  const pendingExport = deferred();
  const { controller } = fixture({ exportQuery: () => pendingExport.promise });
  await apply(controller); const pending = controller.exportCurrent(); controller.setContext('new-library');
  pendingExport.resolve({ items: [{ id: 'old-library' }] });
  await assert.rejects(() => pending);
});
