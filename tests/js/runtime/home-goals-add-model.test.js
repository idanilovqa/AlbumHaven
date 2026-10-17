const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = name => import(pathToFileURL(path.resolve(__dirname,
  '../../../music_app/static/js/home-friends', name)).href);
const GOAL = '10000000-0000-4000-8000-000000000001';
const ALBUM = '20000000-0000-4000-8000-000000000002';
const GROUP = '30000000-0000-4000-8000-000000000003';
const EVIDENCE = '40000000-0000-4000-8000-000000000004';
const CYCLE = '50000000-0000-4000-8000-000000000005';
const KEY = '70000000-0000-4000-8000-000000000007';
const NEXT_KEY = '80000000-0000-4000-8000-000000000008';
const VERSION = 'b'.repeat(64), PERIODS = ['week', 'month', 'six-months', 'year'];
const preview = title => ({title, artist_display: 'Artist', first_release_date: '2026-10', primary_type: 'Album'});
const evidenceDTO = overrides => ({evidence_ref: EVIDENCE, evidence_version: VERSION,
  expires_at: '2099-10-15T16:00:00+00:00', album: preview('Verified exact album'), ...overrides});
const candidate = overrides => ({provider: 'musicbrainz', entity_kind: 'release-group', release_group_id: GROUP,
  ...preview('Search preview'), ...overrides});
const searchDTO = () => ({limit: 10, candidates: [candidate()]});
const clone = value => JSON.parse(JSON.stringify(value));
const failure = (status, code, responseRejected = true) => Object.assign(new Error('private diagnostic'), {status, code, responseRejected});
function dto({empty = false, revision = empty ? '1' : '2', canAdd = true} = {}) {
  return {goal_ref: empty ? null : GOAL, revision,
    allowed_actions: {can_read: true, can_add: canAdd, can_reset: true, can_complete: true, can_remove: true},
    albums: empty ? [] : [{catalog_ref: ALBUM, ...preview('Stored album')}],
    periods: Object.fromEntries(PERIODS.map(period => [period, {period, top_ref: empty ? null : GOAL,
      cycle: empty ? null : {cycle_id: period === 'week' ? CYCLE : `${PERIODS.indexOf(period) + 1}0000000-1111-4111-8111-000000000001`,
        started_at: '2026-10-14T00:00:00+00:00', start_date: '2026-10-14', due_date: '2026-10-21', timezone_name: 'UTC'},
      album_refs: empty ? [] : [ALBUM], manual_completed_at: empty ? {} : {[ALBUM]: null}, total: empty ? 0 : 1, completed: 0}]))};
}
const receipt = overrides => ({ok: true, action: 'add', request_key: KEY, changed: true, reason: '',
  goal_ref: GOAL, revision: '2', period: 'week', cycle_id: CYCLE, catalog_ref: ALBUM, ...overrides});
const capture = controller => {const {data, period} = controller.getSnapshot(); return Object.freeze({data, period, revision: data.revision});};
const lifetimes = new WeakMap();
function lifetime(t) {
  if (lifetimes.has(t)) return lifetimes.get(t);
  const state = {cleanups: [], gates: [], tasks: []}; lifetimes.set(t, state);
  t.after(async () => {
    let error;
    for (const cleanup of state.cleanups.reverse()) {try {cleanup();} catch (value) {error ||= value;}}
    for (const gate of state.gates) gate.resolve(undefined);
    await Promise.allSettled([...state.gates.map(gate => gate.promise), ...state.tasks]);
    for (let index = 0; index < 8; index++) await Promise.resolve();
    if (error) throw error;
  });
  return state;
}
function deferred(t) {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  const gate = {promise, resolve, reject}; lifetime(t).gates.push(gate); return gate;
}
function ownTask(t, promise) {lifetime(t).tasks.push(promise); promise.catch(() => {}); return promise;}
async function harness(t, script) {
  let provider, controller;
  const dispose = () => {try {controller?.dispose();} finally {provider?.dispose();}};
  lifetime(t).cleanups.push(dispose);
  const {createGoalsProvider} = await load('goals-provider.mjs');
  const {createGoalsController} = await load('goals-model.mjs');
  let context = 'a'.repeat(64), keys = 0;
  const listeners = new Set(), calls = [];
  provider = createGoalsProvider({context: () => context,
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    async request(route, options) {
      calls.push({route, ...options}); assert.ok(script.length, `Unexpected request: ${route}`);
      const next = script.shift(), value = await (typeof next === 'function' ? next(options) : next);
      if (value instanceof Error) throw value;
      return {status: 'ready', context_ref: options.expected, data: value};
    }});
  controller = createGoalsController({provider, timezone: 'UTC', requestKey: () => ++keys === 1 ? KEY : NEXT_KEY});
  return {provider, controller, calls, dispose, keyCalls: () => keys,
    invalidate() {context = 'c'.repeat(64); for (const listener of [...listeners]) listener();},
    evidence: options => provider.evidence({release_group_id: GROUP}, options)};
}

// Additive normal-discovery tests. Existing Reset/manual model tests remain unchanged.
test('search query validation counts original Unicode code points and preserves literal text', async () => {
  const {normalizeGoalSearchQuery: query} = await load('goals-provider.mjs');
  assert.deepEqual(query({title: '  A+B: (album)  ', artist: '  Singer  '}), {title: 'A+B: (album)', artist: 'Singer'});
  assert.equal(query({title: '🎵'.repeat(100), artist: ''}).title.length, 200);
  assert.ok(Object.isFrozen(query({title: 'Album', artist: ''})));
  for (const input of [{title: ' '.repeat(100) + 'A', artist: ''}, {title: '🎵'.repeat(101), artist: ''},
    {title: ' ', artist: ''}, {title: 'x\n', artist: ''}, {title: 'x', artist: '\u007f'},
    {title: '\ud800', artist: ''}, {title: 'x', artist: '\udfff'}, {title: 'x'},
    {title: 'x', artist: '', provider: 'x'}, {title: 1, artist: ''}]) assert.throws(() => query(input));
});

test('search accepts bounded detached candidates and exact no-match without manufacturing evidence', async t => {
  const input = searchDTO(), h = await harness(t, [input, {limit: 10, candidates: []}]);
  const result = await h.provider.search({title: ' Album ', artist: ' Artist '});
  assert.deepEqual(h.calls[0].body, {title: 'Album', artist: 'Artist'});
  assert.equal(h.calls[0].route, '/account/goals/remote-search'); assert.equal(h.calls[0].method, 'POST');
  assert.equal(result.candidates[0].title, 'Search preview'); assert.ok(Object.isFrozen(result.candidates[0]));
  input.candidates[0].title = 'changed'; assert.equal(result.candidates[0].title, 'Search preview');
  assert.equal(h.provider.isEvidenceCurrent(result.candidates[0]), false);
  assert.deepEqual(await h.provider.search({title: 'Missing', artist: ''}), {limit: 10, candidates: []});
});

test('malformed search identity, display, shape and count fail instead of becoming no-match', async () => {
  const {normalizeGoalSearch} = await load('goals-provider.mjs');
  const badRows = [{provider: 'other'}, {entity_kind: 'release'}, {release_group_id: '00000000-0000-0000-0000-000000000000'},
    {title: 'x'.repeat(1001)}, {title: ' '}, {artist_display: '\ud800'}, {title: 'x\n'},
    {first_release_date: '0000'}, {first_release_date: '2026-02-30'}, {first_release_date: '2026-13'},
    {primary_type: 'Playlist'}, {evidence_ref: EVIDENCE}];
  for (const row of badRows) assert.throws(() => normalizeGoalSearch({limit: 10, candidates: [candidate(row)]}));
  for (const input of [{limit: 9, candidates: []}, {limit: 10, candidates: Array(11).fill(candidate())},
    {limit: 10, candidates: [candidate(), candidate()]}, {limit: 10, candidates: [], next: null}]) assert.throws(() => normalizeGoalSearch(input));
  for (const first_release_date of [null, '2026', '2026-02', '2024-02-29']) {
    assert.equal(normalizeGoalSearch({limit: 10, candidates: [candidate({first_release_date})]}).candidates[0].first_release_date, first_release_date);
  }
});

test('invalid query never reaches transport and provider failures remain failures', async t => {
  const h = await harness(t, [failure(503, 'provider_timeout')]);
  await assert.rejects(h.provider.search({title: '', artist: ''})); assert.equal(h.calls.length, 0);
  await assert.rejects(h.provider.search({title: 'Album', artist: ''}), error => error.code === 'provider_timeout');
  assert.equal(h.calls.length, 1);
});

test('evidence validates exact preview and authority identity without inheriting search title', async t => {
  const raw = evidenceDTO(), h = await harness(t, [searchDTO(), raw]);
  const search = await h.provider.search({title: 'Album', artist: ''});
  const result = await h.provider.evidence({release_group_id: search.candidates[0].release_group_id});
  assert.equal(result.album.title, 'Verified exact album'); assert.notEqual(result.album.title, search.candidates[0].title);
  assert.equal(h.calls[1].route, '/account/goals/remote-evidence');
  assert.deepEqual(h.calls[1].body, {release_group_id: GROUP});
  assert.ok(Object.isFrozen(result.album)); raw.album.title = 'changed'; assert.equal(result.album.title, 'Verified exact album');
  assert.equal(h.provider.isEvidenceCurrent(result), true); assert.equal(h.provider.isEvidenceCurrent(clone(result)), false);
  h.invalidate(); assert.equal(h.provider.isEvidenceCurrent(result), false);
});

test('malformed evidence cannot become an Add authority object', async () => {
  const {normalizeGoalEvidence} = await load('goals-provider.mjs');
  for (const bad of [{evidence_ref: GROUP.toUpperCase().replace('3', 'A')}, {evidence_version: 'B'.repeat(64)},
    {expires_at: 'tomorrow'}, {expires_at: '2026-02-30T00:00:00Z'}, {expires_at: '2026-10-15T24:00:00Z'}, {catalog_ref: ALBUM},
    {album: {...preview('Title'), release_group_id: GROUP}}, {album: {...preview('Title'), primary_type: 'Compilation'}}]) {
    assert.throws(() => normalizeGoalEvidence(evidenceDTO(bad)));
  }
});

test('aborted or superseded admission requests cannot return or register late evidence', async t => {
  for (const mode of ['abort', 'selection', 'authority']) {
    const gate = deferred(t), h = await harness(t, [() => gate.promise]);
    const abort = new AbortController(); lifetime(t).cleanups.push(() => abort.abort()); let current = true;
    const pending = ownTask(t, h.evidence({signal: abort.signal, isCurrent: () => current}));
    if (mode === 'abort') abort.abort(); else if (mode === 'selection') current = false; else h.invalidate();
    gate.resolve(evidenceDTO()); await assert.rejects(pending, error => error.name === 'AbortError');
  }
});

test('first Add uses account evidence only and accepts server-created goal and catalog identity', async t => {
  const h = await harness(t, [dto({empty: true}), evidenceDTO(), receipt(), dto()]);
  await h.controller.load(); const expected = capture(h.controller), proof = await h.evidence();
  await h.controller.add(proof, expected);
  assert.deepEqual(h.calls[2].body, {revision: '1', period: 'week', timezone_name: 'UTC', request_key: KEY,
    evidence_ref: EVIDENCE, evidence_version: VERSION});
  assert.ok(Object.isFrozen(h.calls[2].body)); assert.equal(h.calls[2].route, '/account/goals/add');
  assert.equal(h.controller.getSnapshot().data.goal_ref, GOAL);
  assert.equal(h.controller.getSnapshot().data.albums[0].catalog_ref, ALBUM);
  assert.notEqual(ALBUM, GROUP); assert.equal(h.keyCalls(), 1);
});

test('existing cycle may gain a direct assignment despite implied membership already existing', async t => {
  const h = await harness(t, [dto(), evidenceDTO(), receipt({revision: '3'}), dto({revision: '3'})]);
  await h.controller.load(); const proof = await h.evidence(); await h.controller.add(proof, capture(h.controller));
  assert.equal(h.controller.getSnapshot().data.revision, '3');
  assert.equal(h.controller.getSnapshot().data.periods.week.cycle.cycle_id, CYCLE);
});

test('duplicate already_added receipt is an authoritative no-op with unchanged revision', async t => {
  const h = await harness(t, [dto(), evidenceDTO(), receipt({changed: false, reason: 'already_added'}), dto()]);
  await h.controller.load(); const proof = await h.evidence(); await h.controller.add(proof, capture(h.controller));
  assert.equal(h.controller.getSnapshot().status, 'ready'); assert.equal(h.controller.getSnapshot().data.revision, '2');
  assert.equal(h.calls.length, 4);
});

test('Add requires provider-issued evidence, exact captured data/period/revision and can_add', async t => {
  const h = await harness(t, [dto(), evidenceDTO()]); await h.controller.load();
  const proof = await h.evidence(), expected = capture(h.controller);
  for (const bad of [evidenceDTO(), candidate(), clone(proof)]) await h.controller.add(bad, expected);
  for (const bad of [{...expected, data: clone(expected.data)}, {...expected, period: 'month'}, {...expected, revision: '1'}, undefined]) {
    await h.controller.add(proof, bad);
  }
  h.controller.selectPeriod('month'); await h.controller.add(proof, expected);
  assert.equal(h.keyCalls(), 0); assert.equal(h.calls.length, 2);
  const denied = await harness(t, [dto({canAdd: false}), evidenceDTO()]); await denied.controller.load();
  await denied.controller.add(await denied.evidence(), capture(denied.controller)); assert.equal(denied.keyCalls(), 0);
});

test('one evidence preview cannot create a second newly keyed intent after completion', async t => {
  const h = await harness(t, [dto({empty: true}), evidenceDTO(), receipt(), dto()]);
  await h.controller.load(); const proof = await h.evidence(); await h.controller.add(proof, capture(h.controller));
  await h.controller.add(proof, capture(h.controller)); assert.equal(h.keyCalls(), 1); assert.equal(h.calls.length, 4);
});

test('Add shares single pending owner with Reset, completion, removal and period selection', async t => {
  const gate = deferred(t), h = await harness(t, [dto(), evidenceDTO(), () => gate.promise, dto({revision: '3'})]);
  await h.controller.load(); const proof = await h.evidence(), expected = capture(h.controller);
  const pending = ownTask(t, h.controller.add(proof, expected));
  await h.controller.add(proof, expected); await h.controller.reset(); await h.controller.retry();
  const row = {...expected, cycle_id: CYCLE}; await h.controller.setCompletion(ALBUM, true, row); await h.controller.remove(ALBUM, row);
  h.controller.selectPeriod('month'); assert.equal(h.controller.getSnapshot().period, 'week');
  assert.equal(h.calls.length, 3); gate.resolve(receipt({revision: '3'})); await pending;
});

test('uncertain Add recovers receipt with the same key even after evidence expiry', async t => {
  const h = await harness(t, [dto({empty: true}), evidenceDTO({expires_at: '2020-01-01T00:00:00Z'}),
    failure(503, 'provider_timeout'), {status: 'committed', receipt: receipt()}, dto()]);
  await h.controller.load(); const proof = await h.evidence(); await h.controller.add(proof, capture(h.controller));
  assert.equal(h.controller.getSnapshot().mutation, 'uncertain'); await h.controller.retry();
  assert.equal(h.calls[3].route, `/account/goals/operations/${KEY}`);
  assert.equal(h.calls.filter(call => call.route === '/account/goals/add').length, 1);
  assert.equal(h.controller.getSnapshot().status, 'ready');
});

test('unknown receipt retries only the exact frozen Add command and original key', async t => {
  const h = await harness(t, [dto({empty: true}), evidenceDTO(), failure(503, 'unknown'), {status: 'unknown'}, receipt(), dto()]);
  await h.controller.load(); await h.controller.add(await h.evidence(), capture(h.controller));
  const command = h.calls[2].body; await h.controller.retry();
  assert.equal(h.calls[4].route, '/account/goals/add'); assert.equal(h.calls[4].body, command); assert.equal(h.keyCalls(), 1);
});

test('acknowledged Add refresh failure retries reads only', async t => {
  const h = await harness(t, [dto({empty: true}), evidenceDTO(), receipt(), failure(503, 'unavailable'), dto()]);
  await h.controller.load(); await h.controller.add(await h.evidence(), capture(h.controller));
  assert.equal(h.controller.getSnapshot().error.kind, 'acknowledged-refresh'); await h.controller.retry();
  assert.equal(h.calls.filter(call => call.route === '/account/goals/add').length, 1);
  assert.equal(h.calls.some(call => call.route.includes('/operations/')), false);
});

test('weekly capacity and unavailable evidence give safe specific errors and require read plus new preview', async t => {
  for (const [code, pattern] of [['weekly_capacity', /weekly goal is full/], ['evidence_unavailable', /preview has expired/]]) {
    const h = await harness(t, [dto(), evidenceDTO(), failure(409, code), dto(), evidenceDTO(), failure(409, code)]);
    await h.controller.load(); const proof = await h.evidence(); await h.controller.add(proof, capture(h.controller));
    assert.equal(h.controller.getSnapshot().data, null); assert.match(h.controller.getSnapshot().error.message, pattern);
    await h.controller.retry(); await h.controller.add(proof, capture(h.controller)); assert.equal(h.keyCalls(), 1);
    await h.controller.add(await h.evidence(), capture(h.controller)); assert.equal(h.calls[5].body.request_key, NEXT_KEY);
  }
});

test('Add receipt rejects malformed catalog, action, key, goal, cycle, reason and revision', async t => {
  for (const patch of [{action: 'reset'}, {catalog_ref: null}, {request_key: NEXT_KEY}, {goal_ref: null},
    {cycle_id: null}, {revision: '01'}, {revision: '1'}, {reason: 'added'}, {evidence_ref: EVIDENCE},
    {changed: false, reason: 'already_added', revision: '1'}]) {
    const h = await harness(t, [dto({empty: true}), evidenceDTO(), receipt(patch)]);
    await h.controller.load(); await h.controller.add(await h.evidence(), capture(h.controller));
    assert.equal(h.controller.getSnapshot().mutation, 'uncertain', JSON.stringify(patch)); assert.equal(h.calls.length, 3);
  }
  const h = await harness(t, [dto(), evidenceDTO(), receipt({revision: '3', goal_ref: GROUP})]);
  await h.controller.load(); await h.controller.add(await h.evidence(), capture(h.controller));
  assert.equal(h.controller.getSnapshot().mutation, 'uncertain');
});

test('same-revision refresh must include receipt catalog membership and correct new goal', async t => {
  const invalid = dto({empty: true}); invalid.goal_ref = GOAL; invalid.revision = '2';
  for (const period of PERIODS) invalid.periods[period].top_ref = GOAL;
  const h = await harness(t, [dto({empty: true}), evidenceDTO(), receipt(), invalid, dto()]);
  await h.controller.load(); await h.controller.add(await h.evidence(), capture(h.controller));
  assert.equal(h.controller.getSnapshot().error.kind, 'acknowledged-refresh'); await h.controller.retry();
  assert.equal(h.controller.getSnapshot().status, 'ready'); assert.equal(h.calls.filter(call => call.route === '/account/goals/add').length, 1);
});

test('admission denial clears private state while ordinary search failures stay dialog-local', async t => {
  const h = await harness(t, [dto(), dto()]); await h.controller.load(); const original = h.controller.getSnapshot();
  h.controller.admissionFailed(failure(503, 'provider_timeout')); assert.equal(h.controller.getSnapshot(), original);
  h.controller.admissionFailed(failure(403, 'forbidden')); assert.equal(h.controller.getSnapshot().status, 'denied');
  assert.equal(h.controller.getSnapshot().data, null); await h.controller.retry();
  h.controller.admissionFailed(failure(401, 'unauthorized')); assert.equal(h.controller.getSnapshot().data, null);
});

test('authority replacement clears pending Add and late receipt cannot refresh the new owner', async t => {
  const gate = deferred(t), h = await harness(t, [dto({empty: true}), evidenceDTO(), () => gate.promise, dto({empty: true})]);
  await h.controller.load(); const proof = await h.evidence(); const pending = ownTask(t, h.controller.add(proof, capture(h.controller)));
  h.invalidate(); assert.equal(h.controller.getSnapshot().data, null); await h.controller.load();
  gate.resolve(receipt()); await pending; assert.equal(h.calls.length, 4);
  assert.equal(h.provider.isEvidenceCurrent(proof), false); assert.equal(h.controller.getSnapshot().data.goal_ref, null);
});

test('closing completed evidence request need not erase its preview, while provider disposal does', async t => {
  const h = await harness(t, [evidenceDTO()]), abort = new AbortController(); lifetime(t).cleanups.push(() => abort.abort());
  const proof = await h.evidence({signal: abort.signal}); abort.abort();
  assert.equal(h.provider.isEvidenceCurrent(proof), true); h.provider.dispose(); assert.equal(h.provider.isEvidenceCurrent(proof), false);
});


test('month Add creates only the selected and larger memberships from an empty goal', async t => {
  const next = dto(); next.periods.week = dto({empty: true}).periods.week; next.periods.week.top_ref = GOAL;
  const h = await harness(t, [dto({empty: true}), evidenceDTO(), receipt({period: 'month', cycle_id: next.periods.month.cycle.cycle_id}), next]);
  await h.controller.load(); h.controller.selectPeriod('month');
  await h.controller.add(await h.evidence(), capture(h.controller));
  assert.equal(h.calls[2].body.period, 'month');
  assert.equal(h.controller.getSnapshot().status, 'ready');
  assert.equal(h.controller.getSnapshot().data.periods.week.cycle, null);
  assert.deepEqual(h.controller.getSnapshot().data.periods.month.album_refs, [ALBUM]);
});

test('pending first Add cannot synthesize a goal, cycle, album or completion', async t => {
  const gate = deferred(t), h = await harness(t, [dto({empty: true}), evidenceDTO(), () => gate.promise, dto()]);
  await h.controller.load(); const proof = await h.evidence();
  const pending = ownTask(t, h.controller.add(proof, capture(h.controller)));
  assert.equal(h.controller.getSnapshot().mutation, 'submitting');
  assert.equal(h.controller.getSnapshot().data.goal_ref, null);
  assert.deepEqual(h.controller.getSnapshot().data.albums, []);
  assert.equal(h.controller.getSnapshot().data.periods.week.cycle, null);
  gate.resolve(receipt()); await pending;
});

test('same-period duplicate remains allowed at five weekly slots', async t => {
  const full = dto();
  for (let number = 1; number <= 4; number++) {
    const ref = `a0000000-0000-4000-8000-00000000000${number}`;
    full.albums.push({catalog_ref: ref, ...preview(`Existing ${number}`)});
    for (const period of PERIODS) {
      full.periods[period].album_refs.push(ref); full.periods[period].manual_completed_at[ref] = null;
      full.periods[period].total++;
    }
  }
  const h = await harness(t, [full, evidenceDTO(), receipt({changed: false, reason: 'already_added'}), full]);
  await h.controller.load(); await h.controller.add(await h.evidence(), capture(h.controller));
  assert.equal(h.controller.getSnapshot().status, 'ready'); assert.equal(h.controller.getSnapshot().data.periods.week.total, 5);
  assert.equal(h.calls.filter(call => call.route === '/account/goals/add').length, 1);
});
