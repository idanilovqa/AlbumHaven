'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./recent-scrobble-delivery-fixture.cjs');
const {load, fixture, plain, deferred} = require('./home-friends-native-app-fixture.cjs');
const dto = (state = 'accepted', next_step = 'none') => ({state, next_step, show_status: true});
const row = (id, patch = {}) => ({id, kind: 'listen', title: 'Repeated song', artist: 'Artist',
  last_listened_at: '2026-10-08T00:00:00Z', source_readable: true, listen_count: 1,
  availability: 'local', scrobble_delivery: dto(), ...patch});
const payload = (rows, next_cursor = null) => ({rows, next_cursor, total_listens: 700});
async function wired(t, read) {
  const h = setup(), ui = fixture(t), {createHomeFriendsController} = await load('model.mjs');
  const provider = h.bridge.configureActivityProvider({readActivity: read});
  const controller = createHomeFriendsController({providers: {readActivity: provider}});
  controller.setScope(h.bridge.snapshot().scopeKey); t.after(() => controller.dispose());
  const {activityTrackRow} = await load('activity-tracks.mjs');
  function render() {
    const snapshot = controller.getSnapshot();
    const context = {scopeKey: snapshot.scopeKey, ...snapshot.activityNavigation.query};
    const rows = snapshot.activity.data?.rows || [];
    return rows.map((item, index) => {
      const native = activityTrackRow(ui.runtime, item, index, context, {});
      const host = ui.document.createElement('div'); host.innerHTML = native.cells.title.content;
      return {native, host, status: host.querySelector('[data-recent-scrobble-delivery]')};
    });
  }
  return {h, ui, controller, render};
}
test('real bridge to model to native row retains closed own DTO and occurrence order without private data', async t => {
  const input = [row('event:z'), row('event:a', {scrobble_delivery: dto('delivery_unconfirmed', 'check_delivery')})];
  input[0].raw_error = 'PRIVATE ERROR'; input[0].session_key = 'PRIVATE SESSION';
  const w = await wired(t, () => payload(input)); await w.controller.loadActivity({kind: 'listens', period: 'week'});
  const state = w.controller.getSnapshot().activity; assert.equal(state.status, 'ready');
  assert.deepEqual(state.data.rows.map(x => x.id), ['event:z', 'event:a']);
  assert.deepEqual(state.data.rows.map(x => x.last_listened_at), input.map(x => x.last_listened_at));
  assert.equal(state.data.total_listens, 700);
  assert.deepEqual(plain(state.data.rows.map(x => x.scrobble_delivery)), input.map(x => x.scrobble_delivery));
  assert.ok(state.data.rows.every(x => Object.isFrozen(x.scrobble_delivery)));
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE|session_key|raw_error/);
  assert.deepEqual(w.render().map(x => x.status.getAttribute('data-recent-scrobble-delivery')), ['accepted', 'delivery_unconfirmed']);
  assert.deepEqual(w.h.calls.reads, [], 'no HTTP or sender is invoked by status projection');
});
test('bridge strips social/grouped/unreadable DTOs and malformed scalar envelopes', async () => {
  for (const [account_ref, kind, item] of [
    ['friend:1', 'listens', row('one')], [null, 'tracks', row('one')], [null, 'albums', row('one')],
    [null, 'listens', row('one', {kind: 'track'})], [null, 'listens', row('one', {source_readable: false})],
    [null, 'listens', row('one', {allowed_actions: {can_read: false}})],
    ...[{}, [], null, {...dto(), show_status: 1}, {...dto(), state: 'constructor'},
      {...dto(), next_step: 'send'}, {...dto(), private_reason: 'PRIVATE'}]
      .map(value => [null, 'listens', row('one', {scrobble_delivery: value})]),
  ]) {
    const h = setup(), read = h.bridge.configureActivityProvider({readActivity: () => payload([item])});
    const result = await read({scopeKey: h.bridge.snapshot().scopeKey, account_ref, kind, period: 'week'});
    assert.equal(Object.hasOwn(result.rows[0], 'scrobble_delivery'), false);
    assert.equal(result.rows[0].id, 'one');
  }
});
test('semantic contradictions admitted by scalar bridge are removed by model without dropping occurrences', async t => {
  const w = await wired(t, () => payload([
    row('accepted-retry', {scrobble_delivery: dto('accepted', 'retry_check')}),
    row('hidden-action', {scrobble_delivery: {...dto('not_sent', 'retry_check'), show_status: false}}),
    row('hidden-disconnected', {scrobble_delivery: {...dto('unknown'), show_status: false}}),
  ]));
  await w.controller.loadActivity({kind: 'listens'});
  const rows = w.controller.getSnapshot().activity.data.rows;
  assert.equal(rows.length, 3); assert.equal(Object.hasOwn(rows[0], 'scrobble_delivery'), false);
  assert.equal(Object.hasOwn(rows[1], 'scrobble_delivery'), false);
  assert.equal(rows[2].scrobble_delivery.show_status, false);
  assert.ok(w.render().every(x => x.status === null));
});
test('numbered page navigation preserves DTO context through real bridge/model and row rendering', async t => {
  const calls = [];
  const w = await wired(t, query => {
    calls.push(query); const page = query.pagination?.page || 1;
    const rows = page === 1 ? Array.from({length: 100}, (_, i) => row('event:' + i))
      : [row('event:100', {scrobble_delivery: dto('not_sent', 'retry_check')})];
    return {...payload(rows), pagination: {mode: 'numbered', page, page_size: 100, total_rows: 101}};
  });
  await w.controller.loadActivity({kind: 'listens', period: 'month'});
  assert.equal(w.render().filter(x => x.status).length, 100);
  await w.controller.loadActivityPage(2);
  assert.equal(w.controller.getSnapshot().activityNavigation.page, 2);
  assert.equal(w.controller.getSnapshot().activity.data.rows[0].id, 'event:100');
  assert.equal(w.render()[0].status.getAttribute('data-recent-scrobble-delivery'), 'not_sent');
  assert.deepEqual(plain(calls[1].pagination), {mode: 'numbered', page: 2, page_size: 100});
  assert.equal(calls[1].account_ref, null); assert.equal(calls[1].kind, 'listens');
});
test('progressive page accumulation preserves separate same-track occurrences and strips revoked facts', async t => {
  let request = 0;
  const w = await wired(t, () => ++request === 1
    ? payload([row('event:one')], 'cursor:next')
    : payload([row('event:one', {source_readable: false}), row('event:two', {scrobble_delivery: dto('unknown')})]));
  await w.controller.loadActivity({kind: 'listens'}); await w.controller.loadMoreActivity();
  const rows = w.controller.getSnapshot().activity.data.rows;
  assert.deepEqual(rows.map(x => x.id), ['event:one', 'event:two']);
  assert.equal(rows[0].source_readable, false); assert.equal(Object.hasOwn(rows[0], 'scrobble_delivery'), false);
  assert.equal(rows[0].last_listened_at, null);
  assert.deepEqual(w.render().map(x => x.status?.getAttribute('data-recent-scrobble-delivery') || null), [null, 'unknown']);
});
test('malformed append metadata cannot retain status from a specifically revoked occurrence', async t => {
  let request = 0;
  const w = await wired(t, () => ++request === 1 ? payload([row('one')], 'cursor:next')
    : {...payload([row('one', {source_readable: false})], 'cursor:next'), pagination: {mode: 'broken'}});
  await w.controller.loadActivity({kind: 'listens'}); await w.controller.loadMoreActivity();
  const state = w.controller.getSnapshot();
  assert.equal(state.activityNavigation.status, 'error');
  assert.equal(state.activity.data.rows[0].source_readable, false);
  assert.equal(Object.hasOwn(state.activity.data.rows[0], 'scrobble_delivery'), false);
  assert.equal(w.render()[0].status, null);
});
test('denial and a newer grouped query retire status and late own-page results', async t => {
  const late = deferred(); let request = 0;
  const w = await wired(t, query => {
    request++;
    if (request === 1) return payload([row('own')], 'cursor:next');
    if (request === 2) return late.promise;
    return payload([row('grouped', {kind: 'track'})]);
  });
  await w.controller.loadActivity({kind: 'listens'});
  const pending = w.controller.loadMoreActivity();
  await w.controller.loadActivity({kind: 'tracks'});
  late.resolve(payload([row('late')])); await pending;
  assert.deepEqual(w.controller.getSnapshot().activity.data.rows.map(x => x.id), ['grouped']);
  assert.equal(Object.hasOwn(w.controller.getSnapshot().activity.data.rows[0], 'scrobble_delivery'), false);
  assert.equal(w.render()[0].status, null);
  w.controller.configure({readActivity: async () => ({status: 'denied'})});
  await w.controller.loadActivity({kind: 'listens'});
  assert.deepEqual(w.controller.getSnapshot().activity, {status: 'denied', data: null});
  assert.equal(w.render().length, 0);
});

test('model independently strips provider DTOs for a selected friend and for grouped own queries', async t => {
  const {createHomeFriendsController} = await load('model.mjs');
  const c = createHomeFriendsController({providers: {
    readFriends: async () => ({friends: [{account_ref: 'friend:1', relationship: 'accepted',
      allowed_actions: {can_view_activity: true}}], requests: [], profile: null}),
    readActivity: async () => payload([row('same-occurrence')]),
  }});
  t.after(() => c.dispose());
  await c.loadActivity({kind: 'listens'});
  assert.equal(c.getSnapshot().activity.data.rows[0].scrobble_delivery.state, 'accepted');
  for (const kind of ['albums', 'tracks', 'artists']) {
    await c.loadActivity({kind});
    assert.equal(Object.hasOwn(c.getSnapshot().activity.data.rows[0], 'scrobble_delivery'), false);
  }
  await c.loadFriends(); assert.equal(c.selectFriend('friend:1'), true);
  await c.loadActivity({kind: 'listens'});
  assert.equal(c.getSnapshot().activity.status, 'ready');
  assert.equal(Object.hasOwn(c.getSnapshot().activity.data.rows[0], 'scrobble_delivery'), false);
  assert.equal(c.getSnapshot().activity.data.rows[0].id, 'same-occurrence');
});
test('model malformed DTO removal preserves readable row metadata instead of inventing status', async t => {
  const {createHomeFriendsController} = await load('model.mjs');
  const malformed = [{}, [], null, 'accepted', Object.create(dto()), {...dto(), show_status: 'true'},
    {...dto(), state: 'constructor'}, {...dto(), next_step: 'send'},
    {...dto(), detail: 'PRIVATE'}, dto('unknown', 'retry_check')];
  const c = createHomeFriendsController({providers: {readActivity: async () =>
    payload(malformed.map((scrobble_delivery, i) => row('event:' + i, {scrobble_delivery})))}});
  t.after(() => c.dispose()); await c.loadActivity({kind: 'listens'});
  const result = c.getSnapshot().activity;
  assert.equal(result.status, 'ready'); assert.equal(result.data.rows.length, malformed.length);
  for (const item of result.data.rows) {
    assert.equal(Object.hasOwn(item, 'scrobble_delivery'), false);
    assert.equal(item.title, 'Repeated song'); assert.equal(item.listen_count, 1);
    assert.equal(item.last_listened_at, '2026-10-08T00:00:00Z');
  }
});


