const test = require('node:test');
const assert = require('node:assert/strict');
const {createNotificationDrawerHarness} = require('./runtime/notification-drawer-harness.cjs');
let createEditRequestNotifications, createPlaylistEditNotifications;
test.before(async () => {
  ({createEditRequestNotifications} = await import('../../music_app/static/js/home-friends/edit-request-notifications.mjs'));
  ({createPlaylistEditNotifications} = await import('../../music_app/static/js/playlists/edit-request-notifications.mjs'));
});
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), REQUEST = id(2), SCOPE = 'requests:actor:library';
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const settle = () => new Promise(resolve => setImmediate(resolve));
const row = patch => ({request_ref: REQUEST, top_ref: TOP, title: 'Top request', account_ref: id(3),
  display_name: 'Top Reader', username_display: 'reader', created_at: '2026-10-09T00:00:00Z', ...patch});
const page = (requests = [row()], next_cursor = null) => ({requests, next_cursor});
function fixture(t, {read = () => page(), onOpen, onDenied, shell: patch = {}} = {}) {
  const native = createNotificationDrawerHarness(), subscriptions = new Set(), opened = [], reads = [];
  let shell = {scopeKey: SCOPE, authenticated: true, inLibrary: true, active: false, visible: false,
    sidebarMode: 'albums', surface: 'home', ...patch};
  const runtime = {snapshot: () => shell, subscribe(callback) {subscriptions.add(callback); return () => subscriptions.delete(callback);}};
  const providers = {readEditRequests(options) {reads.push(options); return read(options);}, execute() {assert.fail('Notification activation cannot grant access');}};
  const producer = createEditRequestNotifications({runtime, notifications: native.context.AlbumHavenNotifications, providers,
    sourceName: 'album-top-edit-requests', label: 'Album Top edit requests', typeLabel: 'Album Top', resourceKey: 'top_ref', onDenied,
    onOpen(record, isCurrent) {opened.push({record, isCurrent}); return onOpen?.(record, isCurrent);}});
  t.after(() => producer.dispose());
  return {native, runtime, providers, producer, subscriptions, opened, reads,
    change(value) {shell = {...shell, ...value}; for (const callback of subscriptions) callback();},
    opener() {return native.bodyElement.querySelector('[data-open-request-notification]');}};
}

for (const surface of ['home', 'playlists']) test(`Top Notifications remain registered while ${surface} is visible`, async t => {
  const h = fixture(t, {shell: {surface, active: false, visible: false}}); await settle();
  assert.equal(h.reads.length, 1);
  assert.match(h.native.bodyElement.textContent, /Top request/);
  assert.match(h.native.bodyElement.textContent, /Album Top/);
  assert.equal(h.native.badgeElement.textContent, '1');
  h.native.click(h.opener()); await settle();
  assert.equal(h.opened.length, 1); assert.equal(h.opened[0].record.top_ref, TOP);
  assert.equal(h.opened[0].isCurrent(), true);
});

test('Top and Playlist requests with identical UUIDs stay distinct in the existing native registry', async t => {
  const h = fixture(t); await settle();
  const playlistOpened = [];
  const playlist = createPlaylistEditNotifications({runtime: h.runtime, notifications: h.native.context.AlbumHavenNotifications,
    providers: {readEditRequests: () => ({requests: [{...row(), title: 'Playlist request', playlist_id: TOP}], next_cursor: null})},
    onOpen(record, isCurrent) {playlistOpened.push({record, isCurrent});}});
  t.after(() => playlist.dispose()); await settle();
  const rows = [...h.native.bodyElement.children];
  assert.equal(rows.length, 2); assert.equal(new Set(rows.map(item => item.dataset.notificationKey)).size, 2);
  assert.deepEqual(rows.map(item => JSON.parse(item.dataset.notificationKey)[0]).sort(), ['album-top-edit-requests', 'playlist-edit-requests']);
  for (const node of rows) h.native.click(node.querySelector('[data-open-request-notification]'));
  await settle();
  assert.equal(h.opened.length, 1); assert.equal(playlistOpened.length, 1);
  assert.equal(h.opened[0].record.top_ref, TOP); assert.equal(playlistOpened[0].record.playlist_id, TOP);
  h.producer.dispose();
  assert.equal(h.native.bodyElement.children.length, 1);
  assert.match(h.native.bodyElement.textContent, /Playlist request/);
});

test('all request pages are read and a click is single-flight without approving a request', async t => {
  const opening = deferred();
  const h = fixture(t, {read: ({cursor}) => cursor ? page([row({request_ref: id(4), top_ref: id(5), title: 'Second Top'})]) : page(undefined, 'next'),
    onOpen: () => opening.promise});
  await settle();
  assert.deepEqual(h.reads.map(value => value.cursor), [null, 'next']);
  const target = [...h.native.bodyElement.children].find(node => /Second Top/.test(node.textContent));
  const opener = target.querySelector('[data-open-request-notification]');
  h.native.click(opener); h.native.click(opener); await settle();
  assert.equal(h.opened.length, 1); assert.equal(h.opened[0].record.top_ref, id(5));
  assert.equal(h.native.bodyElement.children.length, 2, 'opening is not a durable owner decision');
  opening.resolve(true); await settle();
  assert.equal(h.native.bodyElement.children.length, 2);
});

test('actor and library ABA abort feeds, retire old callbacks and ignore late replies', async t => {
  const pending = [];
  const h = fixture(t, {read: options => {const request = deferred(); pending.push({...request, options}); return request.promise;}});
  h.change({scopeKey: 'requests:other-actor:library'});
  h.change({scopeKey: 'requests:actor:other-library'});
  h.change({scopeKey: SCOPE});
  assert.deepEqual(pending.map(item => item.options.signal.aborted), [true, true, true, false]);
  pending[3].resolve(page([row({title: 'Current Top'})])); await settle();
  for (const request of pending.slice(0, 3)) request.resolve(page([row({title: 'Retired Top'})]));
  await settle();
  assert.match(h.native.bodyElement.textContent, /Current Top/);
  assert.doesNotMatch(h.native.bodyElement.textContent, /Retired Top/);
  const retained = h.opener();
  h.change({authenticated: false});
  h.native.click(retained); await settle();
  assert.equal(h.opened.length, 0); assert.equal(h.native.badgeElement.hidden, true);
  h.producer.dispose(); assert.equal(h.subscriptions.size, 0);
});

test('removed request and provider replacement revoke the deferred exact-Top navigation guard', async t => {
  let next = page();
  const h = fixture(t, {read: () => next}); await settle();
  h.native.click(h.opener()); await settle();
  const first = h.opened[0]; assert.equal(first.isCurrent(), true);
  next = page([row({top_ref: id(9)})]); await h.producer.refresh();
  assert.equal(first.isCurrent(), false, 'same request ID cannot retarget a delayed Top navigation');
  h.native.click(h.opener()); await settle();
  const second = h.opened[1]; assert.equal(second.isCurrent(), true);
  h.producer.configure({readEditRequests: () => page([])}); await settle();
  assert.equal(second.isCurrent(), false); assert.equal(h.native.badgeElement.hidden, true);
});

test('request-feed denial, repeated cursors and unmount leave no actionable private rows', async t => {
  for (const mode of ['denied', 'cursor-loop', 'dispose']) {
    const pending = deferred();
    let fail = false;
    const h = fixture(t, {read: () => {
      if (!fail) return page();
      if (mode === 'denied') throw Object.assign(new Error('Revoked'), {status: 403});
      if (mode === 'cursor-loop') return page(undefined, 'repeat');
      return pending.promise;
    }});
    await settle(); const retained = h.opener(); fail = true;
    const refreshing = h.producer.refresh();
    if (mode === 'dispose') {h.producer.dispose(); pending.resolve(page([row({title: 'Late private Top'})]));}
    await refreshing;
    h.native.click(retained); await settle();
    assert.equal(h.opened.length, 0); assert.equal(h.native.badgeElement.hidden, true);
    assert.equal(h.opener(), null); assert.doesNotMatch(h.native.bodyElement.textContent, /Late private Top/);
  }
});

test('Playlist notification compatibility wrapper preserves its existing authenticated-scope lifetime', async t => {
  const h = fixture(t, {read: () => page([])}); await settle();
  let reads = 0;
  const playlist = createPlaylistEditNotifications({runtime: h.runtime, notifications: h.native.context.AlbumHavenNotifications,
    providers: {readEditRequests() {reads++; return {requests: [{...row(), playlist_id: TOP, title: 'Existing Playlist request'}], next_cursor: null};}},
    onOpen() {}});
  t.after(() => playlist.dispose()); await settle();
  const opener = h.opener(); assert.ok(opener);
  h.change({inLibrary: false, visible: false}); await settle();
  assert.equal(h.opener(), opener); assert.equal(reads, 1);
  h.change({authenticated: false});
  assert.equal(h.opener(), null);
});


for (const status of [401, 403]) test(`synchronous startup ${status} denial reaches the authority owner exactly once after native source registration`, async t => {
  const failure = Object.assign(new Error('Private feed denied at startup'), {status}), denials = [];
  const h = fixture(t, {read() {throw failure;}, onDenied(scopeKey, error) {denials.push({scopeKey, error});}});
  await settle();
  assert.equal(h.reads.length, 1, 'already-open drawer registration and startup must coalesce into one read');
  assert.equal(denials.length, 1, 'a synchronous denial must reach the controller instead of failing before the source exists');
  assert.equal(denials[0].scopeKey, SCOPE); assert.equal(denials[0].error, failure);
  assert.equal(h.opener(), null); assert.equal(h.native.badgeElement.hidden, true);
  assert.match(h.native.bodyElement.textContent, /do not have access/);
  assert.equal(h.subscriptions.size, 1);
});
