'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {shared, T, F} = require('./sample-origin-action-fixtures.cjs');
const {retainedPresentation} = require('./sample-origin-presentation-fixtures.cjs');
async function source(t, h, returnToOrigin) {
  const svc = T.service(); svc.data.detail = T.detail({items: [{item_ref: F.id(510), album_ref: T.ALBUM}]});
  const controller = await T.preparedController(svc); t.after(() => controller.dispose());
  const {captureAlbumTopSampleOrigin} = await T.load('playlists/sample-playlist-origins.mjs');
  let lease;
  const presentation = retainedPresentation(t, h, () => lease?.isCurrent() === true, 'direct-facade-top-source');
  lease = captureAlbumTopSampleOrigin({controller, libraryRef: '5',
    isCurrent: () => controller.getSnapshot().scopeKey === T.SCOPE,
    returnToOrigin: async returnToParent => {const returned = await returnToOrigin(returnToParent);
      if (returned === true) presentation.restore(); return returned;}}); assert.ok(lease);
  assert.notEqual(lease.scopeKey, h.runtime.snapshot().scopeKey);
  return {controller, svc, lease, originNavigation: presentation.navigation};
}
for (const fence of ['original source', 'destination scope', 'destination runtime', 'provider generation', 'mount owner'])
  test(`real facade ${fence} fence independently retires pending Sample and cannot revive after restoration`, async t => {
    const waiting = F.deferred(), entered = F.deferred(); let submitted, backCalls = 0;
    const h = await shared(t, {captureSamplePlaylist: async input => {submitted = input; entered.resolve(); return waiting.promise;}});
    const s = await source(t, h, async () => {backCalls++; return true;});
    const destinationScope = h.runtime.snapshot().scopeKey;
    assert.equal(h.facade.openSamplePlaylist({originOwner: s.lease, options: F.options(), originNavigation: s.originNavigation}), true); await h.settle();
    assert.equal(h.calls.runtime.length, 1); assert.equal(h.calls.runtime[0].scopeKey, destinationScope);
    assert.equal(h.calls.runtime[0].isCurrent(), true); assert.equal(s.lease.isCurrent(), true);
    const back = h.named('Back', h.host); h.click(h.named('Generate', h.host));
    await Promise.race([entered.promise, h.settle().then(() => {assert.ok(submitted, 'capture boundary reached');})]);
    assert.deepEqual(submitted.origin, s.lease.origin); let restore;
    if (fence === 'original source') {
      s.controller.setScope('other-top-owner'); restore = () => s.controller.setScope(T.SCOPE);
      assert.equal(h.runtime.snapshot().scopeKey, destinationScope);
    } else if (fence === 'destination scope') {
      h.shell.dataset.nativeLibraryId = '6'; h.runtime.sync();
      restore = () => {h.shell.dataset.nativeLibraryId = '5'; h.runtime.sync();};
    } else if (fence === 'destination runtime') {
      h.c.AlbumHavenPlaylistRuntime = {...h.runtime};
      assert.equal(h.c.AlbumHavenPlaylistRuntime.snapshot().scopeKey, destinationScope);
      restore = () => {h.c.AlbumHavenPlaylistRuntime = h.runtime;};
    } else if (fence === 'provider generation') {
      h.facade.configureProviders({...h.providers}); restore = () => h.facade.configureProviders(h.providers);
      assert.equal(h.runtime.snapshot().scopeKey, destinationScope);
    } else {
      const replacement = h.document.createElement('section'); replacement.id = 'playlists-root';
      h.host.replaceWith(replacement); restore = () => replacement.replaceWith(h.host);
      assert.equal(h.runtime.snapshot().scopeKey, destinationScope);
    }
    if (fence !== 'original source') assert.equal(s.lease.isCurrent(), true, 'destination fence is independent of original Top lease');
    assert.equal(h.calls.runtime[0].isCurrent(), false); assert.equal(h.calls.draft[0].isCurrent(), false);
    restore(); assert.equal(h.calls.runtime[0].isCurrent(), false, 'observed retirement latches');
    waiting.resolve(F.v2Capture(submitted)); await h.settle();
    back.dispatchEvent(new h.c.MouseEvent('click', {bubbles: true, cancelable: true})); await h.settle();
    assert.equal(backCalls, 0); assert.equal(h.host.querySelector('#playlist-tracks[role="table"]'), null); assert.equal(h.calls.save.length, 0);
    assert.equal(s.svc.count('execute'), 0); assert.equal(s.svc.count('admitAlbum'), 0);
  });
test('real facade Back delegates to exact original capture owner once and may vacate destination successfully', async t => {
  const h = await shared(t); let returned = null, count = 0;
  const s = await source(t, h, async () => {
    count++; returned = s.controller.getSnapshot();
    // A legitimate original return may retire the destination. No second
    // navigation or post-success destination-current requirement is permitted.
    h.runtime.releaseDraft(h.calls.draft[0].token); return true;
  });
  const original = s.controller.getSnapshot(), origin = s.lease.origin;
  assert.equal(h.facade.openSamplePlaylist({originOwner: s.lease, originNavigation: s.originNavigation}), true); await h.settle(); h.setup();
  assert.equal(s.lease.origin, origin); assert.equal(s.lease.scopeKey, T.SCOPE);
  h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(count, 1); assert.equal(returned, original); h.noAcquisition();
  assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  assert.equal(s.svc.count('execute'), 0); assert.equal(s.svc.count('admitAlbum'), 0);
});
test('existing facade rejects retired source before creating any shared runtime or retained page', async t => {
  const h = await shared(t), s = await source(t, h, async () => assert.fail('retired source must not navigate'));
  s.controller.setScope('different-source');
  assert.equal(h.facade.openSamplePlaylist({originOwner: s.lease, originNavigation: s.originNavigation}), false);
  assert.equal(h.calls.runtime.length, 0); assert.equal(h.calls.draft.length, 0); h.noAcquisition();
});
