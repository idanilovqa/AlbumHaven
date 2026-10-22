'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {shared, top, physical, loose, row, album, T, F} = require('./sample-origin-action-fixtures.cjs');
function noTopWrites(h, admittedBefore = 0) {
  assert.equal(h.svc.count('execute'), 0); assert.equal(h.svc.count('admitAlbum'), admittedBefore); h.noAcquisition();
}
function capturedSetup(h, lease) {
  assert.ok(lease); assert.equal(lease.isCurrent(), true); h.setup();
  assert.equal(h.named('Generate', h.host).disabled, true, 'omitted choices are not inferred');
  assert.equal(Object.isFrozen(lease), true);
}
test('saved Top real header action reaches existing facade and Sample setup with actual ref/revision', async t => {
  const h = await top(t, {detail: {revision: '9223372036854775807', type: 'source_imported', source_locked: true,
    allowed_actions: {'library.browse.read': true, can_read: true, can_edit: false, can_play: false}}});
  h.click(h.named('Create sample playlist', h.topHost)); await h.settle();
  assert.equal(h.calls.source.length, 1); const lease = h.calls.source[0]; capturedSetup(h, lease);
  assert.notEqual(lease.scopeKey, h.calls.runtime[0].scopeKey, 'source and destination own distinct opaque scopes');
  assert.deepEqual(lease.origin, {kind: 'album_top', top_ref: T.TOP, revision: '9223372036854775807'});
  noTopWrites(h); await h.generate();
  assert.equal(h.calls.capture.length, 1); assert.deepEqual(h.calls.capture[0].origin, lease.origin);
  assert.equal(h.svc.count('execute'), 0); assert.equal(h.svc.count('admitAlbum'), 0); assert.equal(h.calls.save.length, 0);
});
test('real detached create draft carries safe picker selection, survives setup and Back, and does not submit', async t => {
  const picker = {local_album_id: 11, album_ref: null, inventory_album_ref: 'inventory-album:5:11', title: 'Picked album', artist: 'Artist A', year: 2001};
  const h = await top(t, {selected: null, providers: {searchAlbums: async () => ({albums: [picker], next_cursor: null})}});
  // The initiating create action, native form and picker are the production owners.
  h.click(h.named('Create Album Top', h.topHost)); await h.settle();
  const form = h.document.querySelector('form[aria-label="Create Album Top"]'); assert.ok(form);
  const title = form.querySelector('[aria-label="Album Top name"]'); h.input(title, 'Volatile title, never saved');
  h.click(h.named('Find albums', form)); await h.settle();
  const search = form.querySelector('input[type="search"]'); h.input(search, 'Picked'); await h.settle();
  h.click(form.querySelector('[data-gallery-card-intent="select"]')); await h.settle();
  assert.equal(h.svc.count('admitAlbum'), 1); assert.equal(h.svc.calls.find(call => call.method === 'admitAlbum').args[0], 11);
  const button = h.named('Create sample playlist', form); assert.equal(button.type, 'button');
  h.click(button); await h.settle(); assert.equal(h.calls.source.length, 1);
  const lease = h.calls.source[0]; capturedSetup(h, lease); noTopWrites(h, 1);
  assert.deepEqual(lease.origin, {kind: 'album_set', selections: [{kind: 'local', inventory_album_ref: picker.inventory_album_ref}]});
  assert.equal(form.isConnected, true, 'same real app-form owner remains retained, not reconstructed');
  h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(h.document.querySelector('form[aria-label="Create Album Top"]'), form);
  assert.equal(form.querySelector('[aria-label="Album Top name"]'), title); assert.equal(title.value, 'Volatile title, never saved');
  assert.equal(h.svc.count('execute'), 0); assert.equal(h.svc.count('admitAlbum'), 1); assert.equal(h.calls.save.length, 0);
  h.click(h.named('Create sample playlist', form)); await h.settle();
  assert.equal(h.calls.source.length, 2); assert.deepEqual(h.calls.source[1].origin, lease.origin);
});
for (const [name, options, expected] of [
  ['physical main header', {}, F.refs],
  ['explicit duplicate header', {value: album({duplicate_sources: [{folder_path: '/test-only/a', tracks: [row(F.refs[0])]},
    {folder_path: '/test-only/b', tracks: [row(F.refs[1]), row(F.refs[2])]}]})}, F.refs.slice(1)],
]) test(`${name} actual delegated control reaches real Sample mount, without source-action fallthrough`, async t => {
  const h = await shared(t), m = physical(h, options), button = m.button(name.startsWith('explicit') ? 1 : undefined);
  assert.ok(button, 'real renderer must emit the initiating Sample control');
  const event = new h.c.MouseEvent('click', {bubbles: true, cancelable: true}); button.dispatchEvent(event); await h.settle();
  assert.equal(event.defaultPrevented, true, 'handled event cannot fall through to close/folder');
  assert.equal(m.c.getCurrentTrackModalAlbum().key, 'alpha'); assert.equal(m.c.fetchCalls.length, 0);
  assert.equal(m.c.showToastCalls.length, 0); assert.equal(m.captured.length, 1);
  const {input, lease} = m.captured[0]; capturedSetup(h, lease); assert.equal(input.libraryRef, '5');
  if (name.startsWith('explicit')) assert.equal(input.duplicateButton, button, 'actual rendered duplicate button, not a manufactured index');
  else assert.equal(input.duplicateButton == null, true);
  assert.deepEqual(F.plain(lease.origin), {kind: 'album_details', track_refs: expected});
  await h.generate(); assert.equal(h.calls.capture.length, 1); assert.deepEqual(F.plain(h.calls.capture[0].origin), F.plain(lease.origin));
  assert.equal(h.calls.save.length, 0);
});
test('real loose header action samples current canonical artist/family/category scope, not grouped display order', async t => {
  const h = await shared(t), m = await loose(h), canonical = Array.from(m.c.getVisibleNonAlbumTracks(), item => item.inventory_track_ref);
  assert.deepEqual(canonical, F.refs);
  assert.notDeepEqual(Array.from(m.prepared.get('loose-tracks').privateRows, item => item.inventory_track_ref), canonical);
  h.click(m.button()); await h.settle(); assert.equal(m.captured.length, 1);
  const lease = m.captured[0].lease; capturedSetup(h, lease);
  assert.deepEqual(F.plain(lease.origin), {kind: 'album_details', track_refs: canonical});
  await h.generate(); assert.equal(h.calls.capture.length, 1); assert.deepEqual(F.plain(h.calls.capture[0].origin), F.plain(lease.origin));
  assert.equal(h.calls.save.length, 0);
});
for (const reason of ['empty', 'stale', 'restricted']) test(`real saved Top ${reason} cannot dispatch into shared Sample`, async t => {
  const h = await top(t), button = h.named('Create sample playlist', h.topHost); assert.ok(button);
  // Mutate the actual current owner after paint. The real callback must recheck,
  // even though this captured DOM button has not received a fresh enabled state.
  if (reason === 'empty') h.controller.getSnapshot().detail.data.items.splice(0);
  else if (reason === 'restricted') h.controller.getSnapshot().detail.data.allowed_actions['library.browse.read'] = false;
  else {
    const sourceScope = h.actual.snapshot().scopeKey;
    h.shell.dataset.nativeAccountId = 'replacement-account'; h.actual.sync();
    assert.notEqual(h.actual.snapshot().scopeKey, sourceScope, 'actual Top authority changed after paint');
  }
  button.dispatchEvent(new h.c.MouseEvent('click', {bubbles: true, cancelable: true})); await h.settle();
  assert.equal(h.calls.source.length, 0); assert.equal(h.calls.runtime.length, 0); noTopWrites(h);
});
for (const reason of ['empty', 'restricted', 'missing scoped ref', 'retired source page']) test(`physical ${reason} control cannot dispatch into shared Sample`, async t => {
  const h = await shared(t); let current = true;
  const m = physical(h, {options: {sourcePageOwner: {isCurrent: () => current, revalidate: async () => null}}});
  const button = m.button(); assert.ok(button);
  if (reason === 'empty') m.c.getCurrentTrackModalAlbum().tracks.splice(0);
  else if (reason === 'missing scoped ref') delete m.c.getCurrentTrackModalAlbum().tracks[0].inventory_track_ref;
  else if (reason === 'retired source page') current = false;
  else m.c.openTrackModal(m.c.getCurrentTrackModalAlbum(), {presentationRestrictions: {can_open_album_page: false, can_play_album: true},
    releaseSet: {releases: [m.c.getCurrentTrackModalAlbum()], selectedIndex: 0}});
  // For restrictions the actual current renderer's control is used if retained;
  // a product may omit it entirely. The pre-paint stale control is still inert.
  const target = reason === 'restricted' ? m.button() || button : button;
  target.dispatchEvent(new h.c.MouseEvent('click', {bubbles: true, cancelable: true})); await h.settle();
  assert.equal(h.calls.runtime.length, 0); h.noAcquisition();
});
test('retired loose header callback cannot revive an old sourceView into Sample', async t => {
  const h = await shared(t), m = await loose(h), button = m.button(); assert.ok(button);
  m.c.closeNonAlbumModal(); button.dispatchEvent(new h.c.MouseEvent('click', {bubbles: true, cancelable: true})); await h.settle();
  assert.equal(h.calls.runtime.length, 0); h.noAcquisition();
});
