// Additive authority regressions against the real native preference owner.
// Uses the existing native DOM harness; no HTTP server, database or browser proof.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {createNativeHomeRuntime, readRepo} = require('./native-home-harness.cjs');

function fixture() {
  const h = createNativeHomeRuntime();
  const shell = h.document.createElement('div'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {nativeAccountId: '41', nativeLibraryId: '73'});
  h.document.body.appendChild(shell);
  let generation = 1;
  h.context.PrivateUITransport = {generation: () => generation};
  vm.runInContext(readRepo('music_app/static/js/runtime/track-actions.js'), h.context,
    {filename: 'music_app/static/js/runtime/track-actions.js'});
  const runtime = h.owner('TrackActionsRuntime');
  return {runtime, shell, replaceTransport: () => {generation++;}};
}
const source = (id, tier = 'off', editable = true) => ({
  track_ref: `track:key-${id}`, canonical_track_ref: `track:key-${id}`,
  inventory_track_ref: `inventory-track:73:${id}`, source_readable: true,
  allowed_actions: {can_read: true}, track_preference: {rating: null, love_tier: tier,
    allowed_actions: {can_set_love_tier: editable}},
});

// The nested response begins after the older batch was dispatched. Its denial
// must not be reclassified as an epoch change owned by that older batch.
test('A reentrant newer denial cannot be undone by an older response sibling', () => {
  const {runtime} = fixture();
  const batch = runtime.readBatch(runtime.readEpoch());
  let calls = 0, denialAccepted = null;
  const unsubscribe = runtime.subscribePreferences(() => {
    unsubscribe(); calls++;
    denialAccepted = runtime.acceptRead(source(902, 'loved', false), runtime.readEpoch());
  });
  batch.accept(source(901));
  assert.equal(calls, 1);
  assert.equal(denialAccepted, true, 'new current read establishes the read-only fact');
  const accepted = batch.accept(source(902, 'obsessed', true));
  const preference = runtime.preference(source(902));
  assert.equal(preference.allowed_actions.can_set_love_tier, false,
    'an older sibling must not restore authority revoked synchronously by a newer read');
  assert.equal(preference.love_tier, 'loved', 'newer known read-only taste remains authoritative');
  assert.equal(accepted, false, 'the old batch may not adopt the unrelated notification epoch');
});

for (const replacement of ['actor', 'transport']) {
  test(`A reentrant ${replacement} replacement cannot admit old response siblings into the new scope`, () => {
    const f = fixture(), {runtime} = f;
    const dispatchScope = runtime.scope().token;
    const batch = runtime.readBatch(runtime.readEpoch());
    let calls = 0;
    const unsubscribe = runtime.subscribePreferences(() => {
      unsubscribe(); calls++;
      if (replacement === 'actor') f.shell.dataset.nativeAccountId = '42';
      else f.replaceTransport();
      runtime.scope();
    });
    batch.accept(source(901));
    assert.equal(calls, 1);
    assert.notEqual(runtime.scope().token, dispatchScope);
    const accepted = batch.accept(source(902, 'obsessed', true));
    assert.equal(accepted, false, 'the dispatch scope owns every sibling, even after a synchronous notification');
    assert.equal(runtime.preference(source(902, 'off')).love_tier, 'off',
      'the replacement scope must not retain a confirmed preference from the old response');
    const fresh = runtime.readBatch(runtime.readEpoch());
    assert.equal(fresh.accept(source(902, 'loved', true)), true);
    assert.equal(runtime.preference(source(902)).love_tier, 'loved', 'a genuine new-scope response still works');
  });
}

for (const grants of [[false, true, false], [true, false, true], [false, false, false]]) {
  test(`A batch still owns its own mixed sibling denials (${grants.join(',')})`, () => {
    const {runtime} = fixture(), batch = runtime.readBatch(runtime.readEpoch());
    const rows = grants.map((editable, index) => source(910 + index, ['loved', 'obsessed', 'off'][index], editable));
    for (const row of rows) assert.equal(batch.accept(row), true);
    const values = rows.map(row => runtime.preference(row));
    assert.deepEqual(values.map(value => value.love_tier), ['loved', 'obsessed', 'off']);
    assert.deepEqual(values.map(value => value.allowed_actions.can_set_love_tier), grants);
  });
}
for (const grants of [[false, true], [true, false]]) {
  test(`A same-response duplicate denial remains dominant (${grants.join(',')})`, () => {
    const {runtime} = fixture(), batch = runtime.readBatch(runtime.readEpoch());
    const rows = grants.map((editable, index) => ({...source(920, 'loved', editable),
      track_ref: index ? '/synthetic/920.flac' : 'track:key-920'}));
    for (const row of rows) assert.equal(batch.accept(row), true);
    const values = rows.map(row => runtime.preference(row));
    assert.equal(values[0].identity, values[1].identity);
    assert.deepEqual(values.map(value => value.allowed_actions.can_set_love_tier), [false, false]);
  });
}
