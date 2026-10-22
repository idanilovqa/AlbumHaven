const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
// Normal native imports of the delivered provider and controller. No source rewriting.
const load = name => import(pathToFileURL(path.resolve(__dirname,
  '../../../music_app/static/js/home-friends', name)).href);
const GOAL = '10000000-0000-4000-8000-000000000001';
const ALBUM = '20000000-0000-4000-8000-000000000002';
const OTHER = '30000000-0000-4000-8000-000000000003';
const KEY = '70000000-0000-4000-8000-000000000007';
const NEXT_KEY = '80000000-0000-4000-8000-000000000008';
const PERIODS = ['week', 'month', 'six-months', 'year'];
const CYCLES = Object.fromEntries(PERIODS.map((period, index) =>
  [period, `${index + 3}0000000-0000-4000-8000-000000000003`]));
const MARK = '2026-10-14T01:00:00+00:00';
const copy = value => JSON.parse(JSON.stringify(value));
const lifetimes = new WeakMap();
function lifetime(t) {
  if (lifetimes.has(t)) return lifetimes.get(t);
  const state = {cleanups: [], gates: []}; lifetimes.set(t, state);
  t.after(async () => {
    let failure;
    for (const cleanup of state.cleanups.reverse()) {
      try {cleanup();} catch (error) {failure ||= error;}
    }
    for (const gate of state.gates) gate.resolve(undefined);
    await Promise.allSettled(state.gates.map(gate => gate.promise));
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    if (failure) throw failure;
  });
  return state;
}
const deferred = t => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  const gate = {promise, resolve, reject}; lifetime(t).gates.push(gate); return gate;
};
const error = (status, rejected = false) => Object.assign(new Error('private diagnostic'),
  {status, responseRejected: rejected});
function dto({marked = false, revision = '7', writable = true} = {}) {
  return {goal_ref: GOAL, revision,
    albums: [{catalog_ref: ALBUM, title: 'Album', artist_display: 'Artist', first_release_date: null, primary_type: null}],
    allowed_actions: {can_read: true, can_add: writable, can_reset: writable, can_complete: writable, can_remove: writable},
    periods: Object.fromEntries(PERIODS.map(period => [period, {
      top_ref: GOAL, period, cycle: {cycle_id: CYCLES[period], started_at: '2026-10-14T00:00:00+00:00',
        start_date: '2026-10-14', due_date: '2026-10-21', timezone_name: 'UTC'},
      album_refs: [ALBUM], total: 1, completed: marked ? 1 : 0,
      manual_completed_at: {[ALBUM]: marked ? MARK : null},
    }]))};
}
function after(action, {period = 'week', before = dto(), completed = true, revision = '8'} = {}) {
  const value = copy(before); value.revision = revision;
  if (action === 'remove') {
    value.periods[period].album_refs = []; value.periods[period].total = 0;
    value.periods[period].completed = 0; value.periods[period].manual_completed_at = {};
    if (PERIODS.every(name => !value.periods[name].album_refs.includes(ALBUM))) value.albums = [];
  } else {
    for (const name of completed ? PERIODS : [period]) {
      if (!value.periods[name].album_refs.includes(ALBUM)) continue;
      value.periods[name].manual_completed_at[ALBUM] = completed ? MARK : null;
      value.periods[name].completed = completed ? 1 : 0;
    }
  }
  return value;
}
function receipt(action, overrides = {}) {
  return {ok: true, action, request_key: KEY, changed: true, reason: '', goal_ref: GOAL,
    revision: '8', period: 'week', cycle_id: CYCLES.week, catalog_ref: ALBUM, ...overrides};
}
function captured(controller) {
  const state = controller.getSnapshot();
  return Object.freeze({data: state.data, period: state.period, revision: state.data.revision,
    cycle_id: state.data.periods[state.period].cycle?.cycle_id ?? null});
}
function act(controller, action, expected = captured(controller), completed = true) {
  return action === 'completion' ? controller.setCompletion(ALBUM, completed, expected)
    : controller.remove(ALBUM, expected);
}
async function harness(t, script, options = {}) {
  let provider, controller;
  const dispose = () => {try {controller?.dispose();} finally {provider?.dispose();}};
  lifetime(t).cleanups.push(dispose);
  const {createGoalsProvider} = await load('goals-provider.mjs');
  const {createGoalsController} = await load('goals-model.mjs');
  let context = 'a'.repeat(64), keyCalls = 0;
  const subscribers = new Set(), calls = [];
  const transport = {
    context: () => context,
    subscribe(listener) {subscribers.add(listener); return () => subscribers.delete(listener);},
    async request(route, requestOptions) {
      calls.push({route, ...requestOptions});
      assert.ok(script.length, `Unexpected request: ${route}`);
      const step = script.shift(), value = await (typeof step === 'function' ? step(requestOptions, route) : step);
      if (value instanceof Error) throw value;
      return {context_ref: requestOptions.expected, status: 'ready', data: value};
    },
  };
  provider = createGoalsProvider(transport);
  controller = createGoalsController({provider, timezone: 'UTC',
    requestKey: () => {keyCalls++; return keyCalls === 1 ? KEY : NEXT_KEY;}, ...options});
  return {controller, provider, calls, keyCalls: () => keyCalls,
    changeAuthority() {context = 'b'.repeat(64); for (const listener of [...subscribers]) listener();},
    dispose};
}

// Additive cases only; existing home-goals-model.test.js remains byte-identical.
test('manual capability flags are explicit, strict and frozen', async t => {
  const {normalizeGoals} = await load('goals-provider.mjs');
  const input = dto(), normalized = normalizeGoals(input);
  assert.equal(normalized.allowed_actions.can_complete, true);
  assert.equal(normalized.allowed_actions.can_remove, true);
  assert.ok(Object.isFrozen(normalized.allowed_actions));
  input.allowed_actions.can_complete = false;
  assert.equal(normalized.allowed_actions.can_complete, true);
  for (const flag of ['can_complete', 'can_remove']) {
    for (const value of [undefined, false, 1, 'true']) {
      const candidate = dto(); candidate.allowed_actions[flag] = value;
      assert.equal(normalizeGoals(candidate).allowed_actions[flag], false);
    }
  }
});

test('completion sends exact selection command and uses authoritative propagated marks', async t => {
  const h = await harness(t, [dto(), receipt('completion'), after('completion')]);
  await h.controller.load(); const before = h.controller.getSnapshot().data;
  await act(h.controller, 'completion');
  assert.deepEqual(h.calls[1].body, {revision: '7', period: 'week', expected_cycle_id: CYCLES.week,
    request_key: KEY, catalog_ref: ALBUM, completed: true});
  assert.ok(Object.isFrozen(h.calls[1].body));
  assert.equal(h.calls[1].route, '/account/goals/completion');
  assert.equal(h.calls[1].method, 'POST');
  assert.equal('timezone_name' in h.calls[1].body, false);
  assert.equal(before.periods.week.manual_completed_at[ALBUM], null);
  for (const period of PERIODS) assert.equal(h.controller.getSnapshot().data.periods[period].manual_completed_at[ALBUM], MARK);
  assert.equal(h.controller.getSnapshot().data.revision, '8'); h.dispose();
});

test('clear affects selected completion only and preserves other read projections', async t => {
  const before = dto({marked: true});
  const h = await harness(t, [before, receipt('completion', {period: 'month', cycle_id: CYCLES.month}),
    after('completion', {before, period: 'month', completed: false})]);
  await h.controller.load(); const original = h.controller.getSnapshot().data;
  h.controller.selectPeriod('month');
  await act(h.controller, 'completion', captured(h.controller), false);
  assert.equal(h.calls[1].body.completed, false); assert.equal(h.calls[1].body.period, 'month');
  assert.equal(h.controller.getSnapshot().data.periods.month.manual_completed_at[ALBUM], null);
  for (const period of ['week', 'six-months', 'year']) {
    assert.deepEqual(h.controller.getSnapshot().data.periods[period], original.periods[period]);
  }
  h.dispose();
});

test('completion no-op receipt is accepted only when captured marks already match', async t => {
  for (const completed of [true, false]) {
    const before = dto({marked: completed});
    const h = await harness(t, [before, receipt('completion', {changed: false, reason: 'unchanged', revision: '7'}), before]);
    await h.controller.load(); await act(h.controller, 'completion', captured(h.controller), completed);
    assert.equal(h.controller.getSnapshot().status, 'ready');
    assert.equal(h.controller.getSnapshot().data.revision, '7');
    assert.equal(h.calls.length, 3); h.dispose();
  }
});

test('completion may change other memberships even when selected membership is already marked', async t => {
  const before = dto(); before.periods.week.completed = 1; before.periods.week.manual_completed_at[ALBUM] = MARK;
  const h = await harness(t, [before, receipt('completion'), after('completion', {before})]);
  await h.controller.load(); await act(h.controller, 'completion');
  assert.equal(h.controller.getSnapshot().data.periods.month.completed, 1);
  assert.equal(h.controller.getSnapshot().data.revision, '8'); h.dispose();
});

test('removal sends exact member command and retains other periods and catalog identity', async t => {
  const h = await harness(t, [dto({marked: true}), receipt('remove'), after('remove', {before: dto({marked: true})})]);
  await h.controller.load(); const old = h.controller.getSnapshot().data;
  await act(h.controller, 'remove');
  assert.equal(h.calls[1].route, '/account/goals/remove');
  assert.deepEqual(h.calls[1].body, {revision: '7', period: 'week', expected_cycle_id: CYCLES.week,
    request_key: KEY, catalog_ref: ALBUM});
  assert.deepEqual(h.controller.getSnapshot().data.periods.week.album_refs, []);
  assert.equal(h.controller.getSnapshot().data.periods.week.cycle.cycle_id, CYCLES.week);
  for (const period of PERIODS.slice(1)) assert.deepEqual(h.controller.getSnapshot().data.periods[period], old.periods[period]);
  assert.deepEqual(h.controller.getSnapshot().data.albums, old.albums); h.dispose();
});

test('last selected membership removal accepts empty authoritative catalog without synthetic cycle reset', async t => {
  const before = dto();
  for (const period of PERIODS.slice(1)) Object.assign(before.periods[period],
    {album_refs: [], total: 0, completed: 0, manual_completed_at: {}});
  const h = await harness(t, [before, receipt('remove'), after('remove', {before})]);
  await h.controller.load(); await act(h.controller, 'remove');
  assert.deepEqual(h.controller.getSnapshot().data.albums, []);
  assert.equal(h.controller.getSnapshot().data.goal_ref, GOAL);
  assert.equal(h.controller.getSnapshot().data.periods.week.cycle.cycle_id, CYCLES.week); h.dispose();
});

test('new row actions require exact data capture, membership, cycle and live capability', async t => {
  const h = await harness(t, [dto()]); await h.controller.load();
  const expected = captured(h.controller);
  for (const invalid of [undefined, {}, {...expected, data: copy(expected.data)}, {...expected, period: 'month'},
    {...expected, revision: '6'}, {...expected, cycle_id: CYCLES.month}]) {
    await h.controller.setCompletion(ALBUM, true, invalid); await h.controller.remove(ALBUM, invalid);
  }
  await h.controller.setCompletion(OTHER, true, expected); await h.controller.remove(OTHER, expected);
  for (const value of [1, 0, 'true', null, undefined]) await h.controller.setCompletion(ALBUM, value, expected);
  assert.equal(h.calls.length, 1); assert.equal(h.keyCalls(), 0); h.dispose();
  for (const action of ['completion', 'remove']) {
    const before = dto(); before.allowed_actions[action === 'completion' ? 'can_complete' : 'can_remove'] = false;
    const denied = await harness(t, [before]); await denied.controller.load(); await act(denied.controller, action);
    assert.equal(denied.calls.length, 1); assert.equal(denied.keyCalls(), 0); denied.dispose();
  }
});

test('old row capture fails after period selection, identical reread or authority replacement', async t => {
  const h = await harness(t, [dto(), dto(), dto()]); await h.controller.load();
  const expected = captured(h.controller);
  h.controller.selectPeriod('month'); await act(h.controller, 'remove', expected);
  h.controller.selectPeriod('week'); await h.controller.load(); await act(h.controller, 'completion', expected);
  h.changeAuthority(); await h.controller.load(); await act(h.controller, 'remove', expected);
  assert.equal(h.calls.length, 3); assert.equal(h.keyCalls(), 0); h.dispose();
});

test('all three mutation APIs share one pending owner and cannot overlap', async t => {
  for (const action of ['completion', 'remove']) {
    const gate = deferred(t), h = await harness(t, [dto(), () => gate.promise, after(action)]);
    await h.controller.load(); const expected = captured(h.controller), pending = act(h.controller, action, expected);
    await h.controller.setCompletion(ALBUM, true, expected); await h.controller.remove(ALBUM, expected);
    await h.controller.reset(); await h.controller.load(); await h.controller.retry();
    h.controller.selectPeriod('year');
    assert.equal(h.controller.getSnapshot().period, 'week');
    assert.equal(h.calls.length, 2); assert.equal(h.keyCalls(), 1);
    gate.resolve(receipt(action)); await pending; h.dispose();
  }
});

test('uncertain manual writes recover committed receipts without another write', async t => {
  for (const action of ['completion', 'remove']) {
    const h = await harness(t, [dto(), error(503, true), {status: 'committed', receipt: receipt(action)}, after(action)]);
    await h.controller.load(); await act(h.controller, action);
    assert.equal(h.controller.getSnapshot().mutation, 'uncertain');
    await h.controller.retry();
    assert.equal(h.calls[2].route, `/account/goals/operations/${KEY}`);
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(h.controller.getSnapshot().status, 'ready'); h.dispose();
  }
});

test('unknown recovery retries the original action and same exact immutable command', async t => {
  for (const action of ['completion', 'remove']) {
    const h = await harness(t, [dto(), error(503), {status: 'unknown'}, receipt(action), after(action)]);
    await h.controller.load(); await act(h.controller, action); const command = h.calls[1].body;
    await h.controller.retry();
    assert.equal(h.calls[3].route, `/account/goals/${action}`); assert.equal(h.calls[3].body, command);
    assert.ok(Object.isFrozen(command)); assert.equal(h.keyCalls(), 1); h.dispose();
  }
});

test('acknowledged manual write with failed refresh retries only reads', async t => {
  for (const action of ['completion', 'remove']) {
    const h = await harness(t, [dto(), receipt(action), error(503), error(503), after(action)]);
    await h.controller.load(); await act(h.controller, action);
    assert.equal(h.controller.getSnapshot().error.kind, 'acknowledged-refresh');
    await h.controller.retry(); await h.controller.retry();
    assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(h.calls.some(call => call.route.includes('/operations/')), false);
    assert.equal(h.controller.getSnapshot().status, 'ready'); h.dispose();
  }
});

test('manual conflict requires a fresh read and fresh captured intent before a new key', async t => {
  const h = await harness(t, [dto(), error(409, true), dto({revision: '8'}), error(409, true)]);
  await h.controller.load(); const expected = captured(h.controller);
  await act(h.controller, 'remove', expected);
  assert.equal(h.controller.getSnapshot().error.kind, 'conflict');
  assert.equal(h.controller.getSnapshot().data, null);
  await h.controller.retry(); await act(h.controller, 'remove', expected);
  assert.equal(h.keyCalls(), 1); await act(h.controller, 'remove');
  assert.equal(h.calls[3].body.request_key, NEXT_KEY); assert.equal(h.calls[3].body.revision, '8'); h.dispose();
});

test('manual receipts require exact action, catalog, period, unchanged cycle and canonical revision', async t => {
  for (const action of ['completion', 'remove']) {
    for (const patch of [{action: 'reset'}, {catalog_ref: OTHER}, {request_key: NEXT_KEY}, {period: 'month'},
      {goal_ref: OTHER}, {cycle_id: CYCLES.month}, {cycle_id: null}, {revision: '08'}, {revision: '7'},
      {revision: '9223372036854775808'}, {changed: false}, {reason: 'unchanged'}, {completed: true}]) {
      const h = await harness(t, [dto(), receipt(action, patch)]);
      await h.controller.load(); await act(h.controller, action);
      assert.equal(h.controller.getSnapshot().mutation, 'uncertain', `${action}: ${JSON.stringify(patch)}`);
      assert.equal(h.calls.length, 2); h.dispose();
    }
  }
});

test('contradictory no-op removal and completion receipts cannot acknowledge guarded member intent', async t => {
  for (const [action, reason] of [['remove', 'not_member'], ['completion', 'unchanged']]) {
    const h = await harness(t, [dto(), receipt(action, {changed: false, reason, revision: '7'})]);
    await h.controller.load(); await act(h.controller, action);
    assert.equal(h.controller.getSnapshot().mutation, 'uncertain'); assert.equal(h.calls.length, 2); h.dispose();
  }
});

test('recovered receipt for a different action cannot authorize a resend or refresh', async t => {
  for (const action of ['completion', 'remove']) {
    const opposite = action === 'completion' ? 'remove' : 'completion';
    const h = await harness(t, [dto(), error(503), {status: 'committed', receipt: receipt(opposite)}]);
    await h.controller.load(); await act(h.controller, action); await h.controller.retry();
    assert.equal(h.controller.getSnapshot().mutation, 'uncertain'); assert.equal(h.calls.length, 3); h.dispose();
  }
});

test('same-revision refresh must reflect acknowledged manual result and retry never repeats write', async t => {
  for (const action of ['completion', 'remove']) {
    for (const stale of [dto(), dto({revision: '8'})]) {
      const h = await harness(t, [dto(), receipt(action), stale, after(action)]);
      await h.controller.load(); await act(h.controller, action);
      assert.equal(h.controller.getSnapshot().error.kind, 'acknowledged-refresh');
      assert.equal(h.controller.getSnapshot().data, null); await h.controller.retry();
      assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
      assert.equal(h.controller.getSnapshot().status, 'ready'); h.dispose();
    }
  }
});

test('a newer authorized revision may supersede an acknowledged manual result', async t => {
  for (const action of ['completion', 'remove']) {
    const h = await harness(t, [dto(), receipt(action), dto({revision: '9'})]);
    await h.controller.load(); await act(h.controller, action);
    assert.equal(h.controller.getSnapshot().status, 'ready');
    assert.equal(h.controller.getSnapshot().data.revision, '9'); h.dispose();
  }
});

test('authority replacement during manual write clears data and prevents stale refresh', async t => {
  for (const action of ['completion', 'remove']) {
    const gate = deferred(t), h = await harness(t, [dto(), () => gate.promise, dto({writable: false})]);
    await h.controller.load(); const write = act(h.controller, action); h.changeAuthority();
    assert.equal(h.controller.getSnapshot().data, null); assert.equal(h.calls[1].signal.aborted, true);
    await h.controller.load(); gate.resolve(receipt(action)); await write;
    assert.equal(h.calls.length, 3); assert.equal(h.controller.getSnapshot().data.allowed_actions.can_remove, false); h.dispose();
  }
});

test('denied receipt recovery retires manual intent and private data', async t => {
  for (const action of ['completion', 'remove']) {
    const h = await harness(t, [dto(), error(503), error(403, true), dto({writable: false})]);
    await h.controller.load(); await act(h.controller, action); await h.controller.retry();
    assert.equal(h.controller.getSnapshot().status, 'denied'); assert.equal(h.controller.getSnapshot().data, null);
    await h.controller.retry(); assert.equal(h.calls[3].route, '/account/goals'); h.dispose();
  }
});

test('disposal during manual recovery aborts and never dispatches an unknown receipt retry', async t => {
  const gate = deferred(t), h = await harness(t, [dto(), error(503), () => gate.promise]);
  await h.controller.load(); await act(h.controller, 'remove'); const recovery = h.controller.retry();
  h.controller.dispose(); gate.resolve({status: 'unknown'}); await recovery;
  assert.equal(h.calls[2].signal.aborted, true); assert.equal(h.calls.length, 3);
  assert.equal(h.controller.getSnapshot().data, null); h.provider.dispose();
});

test('reentrant key acquisition cannot dispatch a member command for a replacement owner', async t => {
  let invalidate;
  const h = await harness(t, [dto()], {requestKey: () => {invalidate(); return KEY;}});
  invalidate = () => h.changeAuthority(); await h.controller.load(); await act(h.controller, 'remove');
  assert.equal(h.calls.length, 1); assert.equal(h.controller.getSnapshot().data, null);
  assert.equal(h.controller.getSnapshot().error.kind, 'context'); h.dispose();
});


test('missing canonical receipt fields cannot acknowledge completion or removal', async t => {
  for (const action of ['completion', 'remove']) {
    for (const field of ['catalog_ref', 'action', 'changed', 'cycle_id', 'request_key']) {
      const malformed = receipt(action); delete malformed[field];
      const h = await harness(t, [dto(), malformed]);
      await h.controller.load(); await act(h.controller, action);
      assert.equal(h.controller.getSnapshot().mutation, 'uncertain');
      assert.equal(h.calls.length, 2); h.dispose();
    }
  }
});
