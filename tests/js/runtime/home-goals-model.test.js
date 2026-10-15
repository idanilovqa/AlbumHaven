const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

// Authentic native modules: no source rewriting, VM extraction, or mirrored model.
const moduleURL = name => pathToFileURL(path.resolve(__dirname,
  '../../../music_app/static/js/home-friends', name)).href;
const modules = async () => ({
  ...await import(moduleURL('goals-provider.mjs')),
  ...await import(moduleURL('goals-model.mjs')),
});
const GOAL = '10000000-0000-4000-8000-000000000001';
const ALBUM = '20000000-0000-4000-8000-000000000002';
const KEY = '70000000-0000-4000-8000-000000000007';
const NEXT_KEY = '80000000-0000-4000-8000-000000000008';
const NEW_CYCLE = '90000000-0000-4000-8000-000000000009';
const PERIODS = ['week', 'month', 'six-months', 'year'];
const CYCLES = Object.fromEntries(PERIODS.map((period, index) =>
  [period, `${index + 3}0000000-0000-4000-8000-000000000003`]));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const error = (status, rejected = false) => Object.assign(new Error('private diagnostic'),
  {status, responseRejected: rejected});
function dto({empty = false, writable = true, revision = empty ? '1' : '7'} = {}) {
  return {
    goal_ref: empty ? null : GOAL, revision,
    albums: empty ? [] : [{catalog_ref: ALBUM, title: 'Album', artist_display: 'Artist',
      first_release_date: '2026-01-01', primary_type: 'Album'}],
    allowed_actions: {can_read: true, can_add: writable, can_reset: writable},
    periods: Object.fromEntries(PERIODS.map(period => [period, {
      top_ref: empty ? null : GOAL, period,
      cycle: empty ? null : {cycle_id: CYCLES[period], started_at: '2026-10-14T00:00:00+00:00',
        start_date: '2026-10-14', due_date: '2026-10-21', timezone_name: 'UTC'},
      album_refs: empty ? [] : [ALBUM], total: empty ? 0 : 1, completed: empty ? 0 : 1,
      manual_completed_at: empty ? {} : {[ALBUM]: '2026-10-14T01:00:00+00:00'},
    }]))};
}
function refreshed(period = 'week') {
  const value = dto({revision: '8'});
  value.periods[period].cycle.cycle_id = NEW_CYCLE;
  value.periods[period].completed = 0;
  value.periods[period].manual_completed_at[ALBUM] = null;
  return value;
}
function receipt({period = 'week', empty = false, ...overrides} = {}) {
  return {ok: true, action: 'reset', request_key: KEY, changed: !empty,
    reason: empty ? 'empty_period' : '', goal_ref: empty ? null : GOAL,
    revision: empty ? '1' : '8', period, cycle_id: empty ? null : NEW_CYCLE, ...overrides};
}
async function harness(script, options = {}) {
  const {createGoalsProvider, createGoalsController} = await modules();
  let context = {account: 'first'}, keyCalls = 0;
  const subscribers = new Set(), calls = [];
  const transport = {
    context: () => context,
    subscribe(listener) {subscribers.add(listener); return () => subscribers.delete(listener);},
    async request(route, requestOptions) {
      calls.push({route, ...requestOptions});
      assert.ok(script.length, `Unexpected request: ${route}`);
      const step = script.shift();
      const result = await (typeof step === 'function' ? step(requestOptions, route) : step);
      if (result instanceof Error) throw result;
      return {context_ref: requestOptions.expected, status: 'ready', data: result};
    },
  };
  const provider = createGoalsProvider(transport);
  const controller = createGoalsController({provider, timezone: 'UTC',
    requestKey: () => {keyCalls++; return keyCalls === 1 ? KEY : NEXT_KEY;}, ...options});
  return {controller, provider, calls, script, keyCalls: () => keyCalls,
    changeAuthority() {context = {account: 'replacement'}; for (const listener of [...subscribers]) listener();},
    dispose() {controller.dispose(); provider.dispose();}};
}

// Tests are authored for the repository runner; this delivery does not execute them.
test('read publishes immutable canonical data and selection remains read-only', async () => {
  const h = await harness([dto()]);
  assert.deepEqual(h.controller.getSnapshot(), {status: 'idle', data: null, period: 'week', mutation: 'idle', error: null});
  const states = [];
  const unsubscribe = h.controller.subscribe(state => states.push(state));
  await h.controller.load();
  const data = h.controller.getSnapshot().data;
  assert.equal(h.controller.getSnapshot().status, 'ready');
  assert.ok(Object.isFrozen(h.controller.getSnapshot()));
  assert.ok(Object.isFrozen(data.periods.week.album_refs));
  h.controller.selectPeriod('six-months');
  h.controller.selectPeriod('not-a-period');
  assert.equal(h.controller.getSnapshot().period, 'six-months');
  assert.equal(h.controller.getSnapshot().data, data);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(states.map(state => state.status), ['loading', 'ready', 'ready']);
  unsubscribe(); h.dispose();
});

test('retained Reset sends exact revision, period, timezone, cycle and key then refreshes', async () => {
  const h = await harness([dto(), receipt({period: 'month'}), refreshed('month')], {timezone: 'Pacific/Auckland'});
  await h.controller.load();
  h.controller.selectPeriod('month');
  const originalWeek = h.controller.getSnapshot().data.periods.week;
  await h.controller.reset({period: 'month', revision: '7', cycle_id: CYCLES.month});
  assert.deepEqual(h.calls.map(call => call.route), ['/account/goals', '/account/goals/reset', '/account/goals']);
  assert.equal(h.calls[1].method, 'POST');
  assert.deepEqual(h.calls[1].body, {revision: '7', period: 'month', timezone_name: 'Pacific/Auckland',
    expected_cycle_id: CYCLES.month, request_key: KEY});
  assert.ok(Object.isFrozen(h.calls[1].body));
  assert.deepEqual(h.controller.getSnapshot().data.periods.week, originalWeek);
  assert.deepEqual(h.controller.getSnapshot().data.periods.month.album_refs, [ALBUM]);
  assert.equal(h.controller.getSnapshot().data.periods.month.cycle.cycle_id, NEW_CYCLE);
  assert.equal(h.controller.getSnapshot().mutation, 'idle');
  assert.equal(h.keyCalls(), 1); h.dispose();
});

test('empty Reset accepts only unchanged receipt and never synthesizes a cycle or album', async () => {
  const h = await harness([dto({empty: true}), receipt({empty: true}), dto({empty: true})]);
  await h.controller.load(); await h.controller.reset();
  assert.equal(h.calls[1].body.expected_cycle_id, null);
  assert.equal(h.controller.getSnapshot().data.goal_ref, null);
  assert.equal(h.controller.getSnapshot().data.periods.week.cycle, null);
  assert.equal(h.controller.getSnapshot().data.revision, '1');
  assert.deepEqual(h.controller.getSnapshot().data.albums, []); h.dispose();
});

test('read-only capability and stale confirmation guard cannot issue Reset', async () => {
  const h = await harness([dto({writable: false}), dto()]);
  await h.controller.load(); await h.controller.reset();
  assert.equal(h.keyCalls(), 0);
  await h.controller.load();
  const expected = {period: 'week', revision: '7', cycle_id: CYCLES.week};
  h.controller.selectPeriod('year');
  await h.controller.reset(expected);
  assert.equal(h.calls.length, 2); assert.equal(h.keyCalls(), 0); h.dispose();
});

test('duplicate Reset and Retry while submitting cannot create another request', async () => {
  const gate = deferred(), h = await harness([dto(), () => gate.promise, refreshed()]);
  await h.controller.load();
  const first = h.controller.reset();
  await h.controller.reset(); await h.controller.retry(); await h.controller.load();
  assert.equal(h.calls.length, 2); assert.equal(h.keyCalls(), 1);
  gate.resolve(receipt()); await first;
  assert.equal(h.calls.length, 3); h.dispose();
});

test('acknowledged Reset with failed refresh retries only the read', async () => {
  const h = await harness([dto(), receipt(), error(503), refreshed()]);
  await h.controller.load(); await h.controller.reset();
  assert.equal(h.controller.getSnapshot().status, 'unavailable');
  assert.equal(h.controller.getSnapshot().data, null);
  assert.equal(h.controller.getSnapshot().error.kind, 'acknowledged-refresh');
  await h.controller.reset(); await h.controller.load();
  assert.equal(h.calls.length, 3);
  await h.controller.retry();
  assert.equal(h.controller.getSnapshot().status, 'ready');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.calls.some(call => call.route.includes('/operations/')), false);
  assert.equal(h.keyCalls(), 1); h.dispose();
});

test('uncertain Reset recovers committed receipt before refreshing without another write', async () => {
  const h = await harness([dto(), error(503), {status: 'committed', receipt: receipt()}, refreshed()]);
  await h.controller.load(); await h.controller.reset();
  assert.equal(h.controller.getSnapshot().mutation, 'uncertain');
  assert.equal(h.controller.getSnapshot().error.kind, 'uncertain');
  assert.ok(Object.isFrozen(h.controller.getSnapshot().error));
  await h.controller.reset(); await h.controller.load();
  assert.equal(h.calls.length, 2);
  await h.controller.retry();
  assert.equal(h.calls[2].route, `/account/goals/operations/${KEY}`);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.controller.getSnapshot().data.revision, '8'); h.dispose();
});

test('unknown receipt retries only the identical frozen command and key', async () => {
  const h = await harness([dto(), error(503), {status: 'unknown'}, receipt(), refreshed()]);
  await h.controller.load(); await h.controller.reset();
  const command = h.calls[1].body;
  h.controller.selectPeriod('year');
  await h.controller.retry();
  assert.equal(h.calls[2].route, `/account/goals/operations/${KEY}`);
  assert.equal(h.calls[3].body, command);
  assert.equal(h.calls[3].body.period, 'week');
  assert.equal(h.keyCalls(), 1);
  assert.equal(h.controller.getSnapshot().period, 'week'); h.dispose();
});

test('recovery failures preserve the exact pending intent and do not automatically retry', async () => {
  const h = await harness([dto(), error(503), error(503), {status: 'unknown'}, error(503)]);
  await h.controller.load(); await h.controller.reset();
  await h.controller.retry();
  assert.equal(h.calls.length, 3);
  assert.equal(h.controller.getSnapshot().mutation, 'uncertain');
  await h.controller.retry();
  assert.equal(h.calls.length, 5);
  assert.equal(h.calls[1].body, h.calls[4].body);
  assert.equal(h.controller.getSnapshot().mutation, 'uncertain');
  assert.equal(h.keyCalls(), 1); h.dispose();
});

test('definitive conflict clears intent and requires a successful new read before another key', async () => {
  const next = refreshed();
  const h = await harness([dto(), error(409, true), next, error(409, true)]);
  await h.controller.load(); await h.controller.reset();
  assert.equal(h.controller.getSnapshot().mutation, 'conflict');
  assert.equal(h.controller.getSnapshot().data, null);
  assert.equal(h.controller.getSnapshot().error.kind, 'conflict');
  await h.controller.reset();
  assert.equal(h.keyCalls(), 1);
  await h.controller.retry();
  assert.equal(h.calls[2].route, '/account/goals');
  await h.controller.reset();
  assert.equal(h.calls[3].body.request_key, NEXT_KEY);
  assert.equal(h.calls[3].body.revision, '8');
  assert.equal(h.calls[3].body.expected_cycle_id, NEW_CYCLE); h.dispose();
});

test('unknown recovery followed by a definitive rejection also retires its intent', async () => {
  const h = await harness([dto(), error(503), {status: 'unknown'}, error(409, true), dto()]);
  await h.controller.load(); await h.controller.reset(); await h.controller.retry();
  assert.equal(h.controller.getSnapshot().mutation, 'conflict');
  await h.controller.retry();
  assert.equal(h.calls[4].route, '/account/goals');
  assert.equal(h.keyCalls(), 1); h.dispose();
});

test('canonical receipt mismatches remain uncertain and never trigger speculative refresh', async () => {
  const mutations = [
    {action: 'add'}, {request_key: NEXT_KEY}, {period: 'month'}, {goal_ref: ALBUM},
    {revision: '08'}, {revision: '7'}, {revision: '9223372036854775808'},
    {cycle_id: CYCLES.week}, {cycle_id: '00000000-0000-0000-0000-000000000000'},
    {reason: 'reset'}, {changed: false}, {unexpected: true},
  ];
  for (const patch of mutations) {
    const h = await harness([dto(), receipt(patch)]);
    await h.controller.load(); await h.controller.reset();
    assert.equal(h.controller.getSnapshot().mutation, 'uncertain', JSON.stringify(patch));
    assert.equal(h.calls.length, 2); h.dispose();
  }
});

test('malformed committed or unknown recovery envelope cannot authorize another write', async () => {
  for (const response of [{status: 'committed', receipt: receipt({request_key: NEXT_KEY})},
    {status: 'unknown', receipt: receipt()}, {status: 'unknown', extra: true}, {status: 'pending'}]) {
    const h = await harness([dto(), error(503), response]);
    await h.controller.load(); await h.controller.reset(); await h.controller.retry();
    assert.equal(h.controller.getSnapshot().mutation, 'uncertain');
    assert.equal(h.calls.length, 3);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1); h.dispose();
  }
});

test('denial clears both visible account data and pending Reset recovery', async () => {
  for (const deniedStatus of [401, 403]) {
    const h = await harness([dto(), error(503), error(deniedStatus), dto({writable: false})]);
    await h.controller.load(); await h.controller.reset(); await h.controller.retry();
    assert.equal(h.controller.getSnapshot().status, 'denied');
    assert.equal(h.controller.getSnapshot().data, null);
    assert.equal(h.controller.getSnapshot().mutation, 'idle');
    assert.equal(h.controller.getSnapshot().error.kind, 'denied');
    await h.controller.retry();
    assert.equal(h.calls[3].route, '/account/goals'); h.dispose();
  }
});

test('read denial and Reset denial both fail closed', async () => {
  const first = await harness([error(403)]);
  await first.controller.load();
  assert.equal(first.controller.getSnapshot().status, 'denied'); first.dispose();
  const second = await harness([dto(), error(401, true)]);
  await second.controller.load(); await second.controller.reset();
  assert.equal(second.controller.getSnapshot().status, 'denied');
  assert.equal(second.controller.getSnapshot().data, null); second.dispose();
});

test('newer load wins and superseded requests carry aborted signals', async () => {
  const gate = deferred(), h = await harness([() => gate.promise, refreshed()]);
  const old = h.controller.load();
  await h.controller.load();
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.calls[0].isCurrent(), false);
  gate.resolve(dto()); await old;
  assert.equal(h.controller.getSnapshot().data.revision, '8'); h.dispose();
});

test('authority replacement clears immediately and stale write cannot refresh replacement owner', async () => {
  const gate = deferred(), h = await harness([dto(), () => gate.promise, dto({empty: true})]);
  await h.controller.load();
  const write = h.controller.reset();
  h.changeAuthority();
  assert.equal(h.controller.getSnapshot().data, null);
  assert.equal(h.controller.getSnapshot().status, 'unavailable');
  assert.equal(h.controller.getSnapshot().error.kind, 'context');
  assert.equal(h.calls[1].signal.aborted, true);
  await h.controller.load();
  gate.resolve(receipt()); await write;
  assert.equal(h.calls.length, 3);
  assert.equal(h.controller.getSnapshot().data.goal_ref, null); h.dispose();
});

test('authority replacement during receipt recovery retires the old pending command', async () => {
  const gate = deferred(), h = await harness([dto(), error(503), () => gate.promise, dto({empty: true})]);
  await h.controller.load(); await h.controller.reset();
  const recovery = h.controller.retry();
  h.changeAuthority();
  await h.controller.load();
  gate.resolve({status: 'unknown'}); await recovery;
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.controller.getSnapshot().data.goal_ref, null); h.dispose();
});

test('authority invalidation from a synchronous observer prevents dispatch of a stale write', async () => {
  const h = await harness([dto()]);
  await h.controller.load();
  h.controller.subscribe(state => {if (state.mutation === 'submitting') h.changeAuthority();});
  await h.controller.reset();
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().data, null); h.dispose();
});

test('dispose aborts requests, clears data, removes subscribers and prevents future work', async () => {
  const gate = deferred(), h = await harness([dto(), () => gate.promise]);
  await h.controller.load();
  let notifications = 0;
  h.controller.subscribe(() => notifications++);
  const write = h.controller.reset();
  const before = notifications;
  h.controller.dispose();
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(h.controller.getSnapshot().data, null);
  gate.resolve(receipt()); await write;
  await h.controller.load(); await h.controller.reset(); await h.controller.retry();
  h.controller.selectPeriod('year'); h.changeAuthority();
  assert.equal(h.calls.length, 2); assert.equal(notifications, before); h.provider.dispose();
});

test('invalid or reused request keys cannot escape as a write', async () => {
  for (const key of ['not-a-uuid', 'A0000000-0000-4000-8000-000000000007',
    '00000000-0000-0000-0000-000000000000']) {
    const h = await harness([dto()], {requestKey: () => key});
    await h.controller.load(); await h.controller.reset();
    assert.equal(h.calls.length, 1);
    assert.equal(h.controller.getSnapshot().error.kind, 'invalid-command'); h.dispose();
  }
  const h = await harness([dto(), receipt(), refreshed()], {requestKey: () => KEY});
  await h.controller.load(); await h.controller.reset(); await h.controller.reset();
  assert.equal(h.calls.length, 3);
  assert.equal(h.controller.getSnapshot().error.kind, 'invalid-command'); h.dispose();
});

test('a throwing subscriber cannot cause a saved Reset to be replayed', async () => {
  const h = await harness([dto(), receipt(), refreshed()]);
  h.controller.subscribe(() => {throw new Error('view failed');});
  await h.controller.load(); await h.controller.reset();
  assert.equal(h.controller.getSnapshot().status, 'ready');
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1); h.dispose();
});


test('an acknowledged Reset never accepts an older or mismatched-cycle refresh', async () => {
  for (const stale of [dto(), dto({revision: '8'})]) {
    const h = await harness([dto(), receipt(), stale, refreshed()]);
    await h.controller.load(); await h.controller.reset();
    assert.equal(h.controller.getSnapshot().status, 'unavailable');
    assert.equal(h.controller.getSnapshot().error.kind, 'acknowledged-refresh');
    assert.equal(h.controller.getSnapshot().data, null);
    await h.controller.retry();
    assert.equal(h.controller.getSnapshot().data.revision, '8');
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(h.calls.some(call => call.route.includes('/operations/')), false); h.dispose();
  }
});


test('HTTP server and timeout failures remain uncertain even with responseRejected marker', async () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    const h = await harness([dto(), error(status, true), {status: 'committed', receipt: receipt()}, refreshed()]);
    await h.controller.load(); await h.controller.reset();
    assert.equal(h.controller.getSnapshot().mutation, 'uncertain');
    await h.controller.retry();
    assert.equal(h.calls[2].route, `/account/goals/operations/${KEY}`);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1); h.dispose();
  }
});
