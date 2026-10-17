const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('./playlist-native-review-fixture.cjs');
const {createSourceFactory} = require('./playtable-source-fixture.cjs');
const tracks = () => import('../../../music_app/static/js/playlists/native-track-table.mjs');
function tableFixture() {
  const h = fixture(), subscriptions = new Set(), notices = [], displayed = [];
  const rows = [
    {row_key: 'a', playlist_item_id: 'a', source_readable: true, availability: 'local', title: 'A', duration_seconds: 90},
    {row_key: 'b', playlist_item_id: 'b', source_readable: true, availability: 'local', title: 'B', duration_seconds: 20}
  ];
  let detail = {playlist_id: 'p', title: 'P', track_rows: rows, items_complete: true,
    author_order: true, allowed_actions: {can_play: true}};
  let state = {scopeKey: 's', selectedPlaylistId: 'p', resource: {status: 'ready', data: {detail}},
    mutation: {status: 'idle'}, drafts: {}, filters: {}};
  const controller = {getSnapshot: () => state, reorder() {}};
  h.runtime.subscribeTrackPreferences = fn => {subscriptions.add(fn); return () => subscriptions.delete(fn);};
  h.runtime.canTrackIntent = () => true;
  h.runtime.trackIntent = () => {};
  return {...h, rows, subscriptions, notices, displayed,
    props: () => ({rows, detail, state, controller, onSelect() {}, onError: message => notices.push(message),
      onDisplayedRowsChange: value => displayed.push(value)}),
    replaceSnapshot() {state = {...state};},
    replaceDetail() {detail = {...detail, title: 'Replacement'}; state = {...state, resource: {status: 'ready', data: {detail}}};}
  };
}
function click(h, target) {
  const event = new h.context.Event('click'); event.detail = 1; target.dispatchEvent(event);
}
for (const phase of ['table-render', 'selection-control', 'columns-control']) {
  test(`track table unwinds preference/reorder resources after ${phase} constructor failure`, async () => {
    const {mountPlaylistTracks} = await tracks(), h = tableFixture(), baseline = h.listeners().length;
    const renderer = phase === 'columns-control' ? 'actionHtml' : 'buttonHtml';
    const original = h.runtime[renderer], observers = new Set();
    let injected = 0;
    const observer = class {observe() {observers.add(this);} disconnect() {observers.delete(this);}};
    h.context.ResizeObserver = observer; h.context.MutationObserver = observer;
    if (phase === 'table-render') h.runtime.tableHtml = () => {throw new Error('initial table renderer');};
    else h.runtime[renderer] = value => {
      if (value.label === (phase === 'columns-control' ? 'Track columns' : 'Create new playlist')) {
        injected++;
        throw new Error('later selection renderer');
      }
      return original(value);
    };
    assert.throws(() => mountPlaylistTracks(h.host, h.runtime, h.props()), /renderer/);
    if (phase !== 'table-render') assert.equal(injected, 1, 'the intended native control renderer was reached exactly once');
    assert.equal(h.subscriptions.size, 0);
    assert.equal(h.listeners().length, baseline);
    assert.equal(h.host.childNodes.length, 0);
    assert.equal(h.displayed.length, 0);
    assert.equal(observers.size, 0);
  });
}
test('source bridge retires actual native source when initial updateRows subscriber throws', async () => {
  const {createPlaytableSource} = await import('../../../music_app/static/js/playtables/native-selection.mjs');
  const created = [], factory = createSourceFactory(created), row = {row_key: 'a', source_readable: true};
  let releases = 0;
  const runtime = {createPlaytableSource(options) {
    const native = factory({...options, revision: {initial: true}});
    let stop;
    stop = native.subscribe(() => {stop(); throw new Error('native publication failure');});
    return {...native, dispose() {releases++; native.dispose();}};
  }};
  assert.throws(() => createPlaytableSource({runtime, sourceRows: [row], rows: [row],
    context: {scopeKey: 's'}, instance: {}, revision: {}, isCurrent: () => true,
    rowFacts: value => value}), /native publication failure/);
  assert.equal(releases, 1);
  assert.equal(created[0].snapshot(), null);
});
for (const change of ['intent', 'capability', 'dispose', 'snapshot', 'throw']) {
  test(`play activation rechecks captured authority after capability ${change}`, async () => {
    const {mountPlaylistTracks} = await tracks(), h = tableFixture();
    let armed = false, calls = 0, replacementCalls = 0, owner;
    h.runtime.trackIntent = () => {calls++;};
    h.runtime.canTrackIntent = () => {
      if (!armed) return true;
      armed = false;
      if (change === 'intent') h.runtime.trackIntent = () => {replacementCalls++;};
      if (change === 'capability') h.runtime.canTrackIntent = () => true;
      if (change === 'dispose') owner.dispose();
      if (change === 'snapshot') {h.replaceSnapshot(); owner.update(h.props());}
      if (change === 'throw') throw new Error('capability unavailable');
      return true;
    };
    owner = mountPlaylistTracks(h.host, h.runtime, h.props());
    const button = h.host.querySelector('[data-playlists-play]');
    assert.ok(button && !button.disabled);
    armed = true;
    assert.doesNotThrow(() => click(h, button));
    assert.equal(calls, 0); assert.equal(replacementCalls, 0);
    assert.equal(h.notices.length, change === 'throw' ? 1 : 0);
    owner.dispose();
  });
}
test('play dispatch is synchronous and late rejection from replaced authority is ignored', async () => {
  const {mountPlaylistTracks} = await tracks(), h = tableFixture();
  let reject, calls = 0;
  h.runtime.trackIntent = () => {calls++; return new Promise((_, no) => {reject = no;});};
  const owner = mountPlaylistTracks(h.host, h.runtime, h.props());
  click(h, h.host.querySelector('[data-playlists-play]'));
  assert.equal(calls, 1);
  h.runtime.trackIntent = () => assert.fail('new authority must not receive old activation');
  reject(new Error('old activation failed'));
  await h.settle();
  assert.deepEqual(h.notices, []);
  owner.dispose();
});
for (const action of ['dispose', 'replace']) {
  test(`actual native source publication ${action} stops the retired table pass`, async () => {
    const {mountPlaylistTracks} = await tracks(), h = tableFixture(), created = [];
    h.runtime.createPlaytableSource = createSourceFactory(created);
    const baseline = h.listeners().length;
    const owner = mountPlaylistTracks(h.host, h.runtime, h.props());
    h.displayed.length = 0;
    let once = true, newest;
    const stop = created[0].subscribe(() => {
      if (!once) return;
      once = false;
      if (action === 'dispose') owner.dispose();
      else {h.replaceSnapshot(); newest = h.props().state; owner.update(h.props());}
    });
    h.replaceSnapshot(); owner.update(h.props());
    if (action === 'dispose') {
      assert.equal(h.displayed.filter(Boolean).length, 0);
      assert.equal(h.host.childNodes.length, 0);
      assert.equal(h.subscriptions.size, 0);
      assert.equal(h.listeners().length, baseline);
    } else {
      assert.equal(h.displayed.filter(Boolean).length, 1, 'only the replacement pass publishes rows');
      assert.equal(created[0].snapshot().revision, newest);
      owner.dispose();
    }
    stop();
  });
}
test('actual row focus restoration disposal prevents stale displayed-row publication', async () => {
  const {mountPlaylistTracks} = await tracks(), h = tableFixture();
  const focus = h.context.Element.prototype.focus;
  h.context.Element.prototype.focus = function () {focus.call(this); this.dispatchEvent(new h.context.Event('focusin'));};
  const owner = mountPlaylistTracks(h.host, h.runtime, h.props());
  h.host.querySelector('[data-playlists-select]').focus();
  let once = true;
  const retire = () => {if (once) {once = false; owner.dispose();}};
  h.document.addEventListener('focusin', retire);
  h.displayed.length = 0;
  h.replaceDetail(); owner.update(h.props());
  assert.equal(once, false);
  assert.equal(h.displayed.filter(Boolean).length, 0);
  assert.equal(h.host.childNodes.length, 0);
  assert.equal(h.subscriptions.size, 0);
  h.document.removeEventListener('focusin', retire);
});
test('table disposal releases remaining ownership and preserves first unsubscribe error', async () => {
  const {mountPlaylistTracks} = await tracks(), h = tableFixture(), baseline = h.listeners().length;
  const failure = new Error('preference unsubscribe failed');
  h.runtime.subscribeTrackPreferences = fn => {h.subscriptions.add(fn); return () => {
    h.subscriptions.delete(fn); throw failure;
  };};
  const owner = mountPlaylistTracks(h.host, h.runtime, h.props());
  assert.throws(() => owner.dispose(), error => error === failure);
  assert.equal(h.host.childNodes.length, 0);
  assert.equal(h.listeners().length, baseline);
  assert.equal(h.subscriptions.size, 0);
  assert.equal(h.displayed.at(-1), null);
  assert.doesNotThrow(() => owner.dispose());
});
test('playtable disposal contains source-unsubscribe error until all native listeners and controls retire', async () => {
  const {mountPlaytableSelection} = await import('../../../music_app/static/js/playtables/native-selection.mjs');
  const h = fixture(), baseline = h.listeners().length, failure = new Error('source unsubscribe failed');
  const instance = {}, sourceAdapter = {snapshot: () => ({scopeKey: 's', instance, rows: []}),
    subscribe: () => () => {throw failure;}};
  const owner = mountPlaytableSelection(h.host, {runtime: h.runtime, sourceAdapter, tableKey: 'fault-table'});
  assert.throws(() => owner.dispose(), error => error === failure);
  assert.equal(h.listeners().length, baseline);
  assert.doesNotThrow(() => owner.dispose());
});
