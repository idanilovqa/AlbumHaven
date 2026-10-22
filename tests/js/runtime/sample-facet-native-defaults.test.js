'use strict';
// Real Sample page and shared native choices, bounded DOM platform only.
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const F = require('./sample-native-fixtures.cjs');
async function page(t, suppliedOptions, overrides = {}) {
  const dom = await nativeMixFixture(t), controller = await F.controllerFixture(overrides);
  const {mountSamplePlaylistPage} = await import('../../../music_app/static/js/playlists/native-sample-playlist.mjs');
  const props = {controller: controller.controller, parent: F.parent(), onClose() {}, async onSaved() {},
    ...(suppliedOptions === undefined ? {} : {options: suppliedOptions})};
  const mounted = mountSamplePlaylistPage(dom.host, dom.runtime, props);
  t.after(() => {mounted.dispose(); controller.controller.dispose();});
  const quota = () => dom.host.querySelector('input[aria-label="Songs per group"]');
  const edit = async value => {quota().value = value; quota().dispatchEvent(new dom.c.Event('input')); await dom.settle();};
  return {...dom, ...controller, mounted, props, quota, edit};
}
test('genuinely new no-options setup initializes only quota 2 without any implicit action', async t => {
  const h = await page(t);
  assert.equal(h.quota().value, '2');
  assert.equal(h.named('Generate').disabled, true);
  assert.match(h.host.textContent, /Choose basis/);
  assert.match(h.host.textContent, /Choose method/);
  assert.match(h.host.textContent, /Unknown duration/);
  assert.doesNotMatch(h.host.textContent, /Unknown values|restrictions are not available yet/);
  assert.equal(h.keys(), 0); assert.equal(h.draws(), 0);
  assert.ok(Object.values(h.calls).every(calls => calls.length === 0));
});
for (const basis of ['per_album', 'per_artist']) {
  test(`${basis}: new setup keeps 2, basis changes never reset edited quota`, async t => {
    const h = await page(t);
    h.choose('Choose songs', basis); await h.settle();
    assert.equal(h.quota().value, '2');
    await h.edit('5001');
    h.choose('Choose songs', basis === 'per_album' ? 'per_artist' : 'per_album'); await h.settle();
    assert.equal(h.quota().value, '5001');
    h.mounted.update({...h.props}); await h.settle();
    assert.equal(h.quota().value, '5001');
    assert.equal(h.keys(), 0);
  });
}
for (const quota of [1, 2, 5001]) {
  test(`supplied explicit quota ${quota} is not mistaken for an absent setup`, async t => {
    const h = await page(t, F.options('most_listened', {songs_per_group: quota}));
    assert.equal(h.quota().value, String(quota));
    h.mounted.update({...h.props}); assert.equal(h.quota().value, String(quota));
  });
}
for (const invalid of ['', '0', '-1', '2.5']) {
  test(`edited invalid quota ${JSON.stringify(invalid)} never snaps to default 2`, async t => {
    const h = await page(t, F.options('most_listened')); await h.edit(invalid);
    assert.notEqual(h.quota().value, '2'); assert.equal(h.named('Generate').disabled, true);
    const node = h.quota(); h.mounted.update({...h.props}); await h.settle();
    assert.equal(h.quota(), node); assert.notEqual(h.quota().value, '2'); assert.equal(h.keys(), 0);
  });
}
test('a real option edit retires ready Save/Play/capture recovery without allocating another key', async t => {
  const h = await page(t, F.options('most_listened'));
  h.click(h.named('Generate')); await h.settle(); assert.ok(h.controller.source());
  const keys = h.keys(); await h.edit('3');
  assert.equal(h.controller.source(), null); assert.equal(h.controller.canSave(), false);
  assert.equal(h.named('Save as playlist').disabled, true); assert.equal(h.named('Play').disabled, true);
  await h.controller.retryCapture(); await h.controller.recoverCapture();
  assert.equal(h.keys(), keys); assert.equal(h.calls.capture.length, 1); assert.equal(h.calls.read.length, 0);
});
test('no-op quota input and same-owner rerender preserve a ready capture', async t => {
  const h = await page(t, F.options('most_listened'));
  h.click(h.named('Generate')); await h.settle(); const source = h.controller.source(), keys = h.keys();
  await h.edit('2'); h.mounted.update({...h.props}); await h.settle();
  assert.equal(h.controller.source(), source); assert.equal(h.keys(), keys);
});
test('provider-owned uncertain Save disables option edits and retains only original recovery', async t => {
  let pending = false, writes = 0;
  const h = await page(t, F.options('most_listened'), {
    hasPendingPlaylistOperation: () => pending,
    createPlaylistFromSelection: async () => {pending = true; writes++; throw Object.assign(new Error('Lost Save'), {status: 'unknown'});},
    recoverPlaylistCreation: async input => ({scopeKey: input.scopeKey, ok: true, action: 'create',
      playlist_id: F.id(80), revision: '1', request_key: F.id(91)})});
  h.click(h.named('Generate')); await h.settle();
  h.click(h.named('Save as playlist')); await h.settle();
  const source = h.controller.source(), keys = h.keys();
  assert.equal(h.quota().disabled, true);
  await h.edit('3');
  assert.equal(h.controller.source(), source); assert.equal(h.keys(), keys); assert.equal(writes, 1);
  await h.controller.recoverSave(); assert.equal(h.controller.getSnapshot().mutation.data.playlist_id, F.id(80));
});
test('actual saved-Top omitted-options launch initializes 2 without losing the existing origin lease', async t => {
  const {top} = require('./sample-origin-action-fixtures.cjs');
  const h = await top(t);
  h.click(h.named('Create sample playlist', h.topHost)); await h.settle();
  const quota = h.host.querySelector('input[aria-label="Songs per group"]');
  assert.ok(quota); assert.equal(quota.value, '2'); assert.equal(h.named('Generate', h.host).disabled, true);
  assert.equal(h.calls.source.length, 1); assert.equal(h.calls.source[0].isCurrent(), true);
  h.noAcquisition();
});

// R4 / N1: supplied invalid input is not a genuinely absent setup.
for (const missing of ['length', 'styles', 'countries']) {
  test(`supplied options missing ${missing} stay invalid before an explicit repair`, async t => {
    const supplied = F.options('most_listened', {songs_per_group: 7}); delete supplied[missing];
    const before = JSON.stringify(supplied), h = await page(t, supplied);
    for (const props of [h.props, {...h.props, suspended: true}, {...h.props, suspended: false}]) {
      h.mounted.update(props); await h.settle();
      assert.equal(h.quota().value, '7');
      assert.equal(h.named('Generate').disabled, true);
      assert.equal(h.named('Save as playlist').disabled, true); assert.equal(h.named('Play').disabled, true);
      assert.equal(h.controller.source(), null); assert.equal(h.keys(), 0); assert.equal(h.draws(), 0);
      assert.ok(Object.values(h.calls).every(calls => calls.length === 0));
    }
    assert.equal(h.state.player.current, null); assert.equal(h.state.player.playbackQueue.owner, 'prior');
    assert.equal(JSON.stringify(supplied), before); assert.equal(Object.hasOwn(supplied, missing), false);
  });
}
for (const supplied of [null, false, 7, 'invalid', []]) {
  test(`supplied ${JSON.stringify(supplied)} is invalid, not defaultable new options`, async t => {
    const h = await page(t, supplied);
    h.mounted.update({...h.props}); await h.settle();
    assert.notEqual(h.quota().value, '2'); assert.equal(h.named('Generate').disabled, true);
    assert.equal(h.named('Save as playlist').disabled, true);
    assert.equal(h.named('Play').disabled, true);
    assert.equal(h.state.player.current, null); assert.equal(h.state.player.playbackQueue.owner, 'prior');
    assert.equal(h.controller.source(), null); assert.equal(h.keys(), 0); assert.equal(h.draws(), 0);
    assert.ok(Object.values(h.calls).every(calls => calls.length === 0));
  });
}
