'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {actionFixture, admit, ready, track, album, source, command, nativeReply, completeDetails,
  assertPrivateDataAbsent, outcome, A, plain} = require('./search-native-fixtures/native-actions.cjs');

test('native Play resolves exact own-love witness and hands only the fresh target to real TrackActions/player activation', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const button = h.host.querySelector('[data-search-track-play]'); assert.ok(button); assert.equal(button.disabled, false);
  h.click(button); assert.equal(h.requests.length, 2); assert.equal(h.activations.length, 0);
  assert.deepEqual(command(h, 1), {resource_ref: 'inventory-track:9:101', intent: 'play'});
  const request = h.requests[1], url = new URL(request.url, h.location);
  assert.equal(url.searchParams.get('q'), ':loved'); assert.equal(url.searchParams.get('artist'), 'Witness Artist');
  assert.equal(url.searchParams.get('search_presentation'), 'tracks');
  for (const key of ['search_cursor', 'search_sidebar_cursor', 'search_detail_album_ref']) assert.equal(url.searchParams.has(key), false);
  assert.equal(request.options.headers.get('X-AlbumHaven-Context'), A);
  assert.equal(request.options.headers.get('X-Album-Haven-CSRF'), 'synthetic-search-action-csrf', 'actual global CSRF fetch owner supplies the session header');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  h.reply(1, nativeReply(h, 1)); await h.flush();
  assert.equal(h.activations.length, 1); assert.equal(h.streams.length, 1);
  assert.equal(h.streams[0][0].path, '/library/eleven/track.flac');
  assert.equal(h.streams[0][0].inventory_track_ref, 'inventory-track:9:101');
  assert.equal(h.streams[0][0].title, 'Authorized title');
  assert.equal(h.audioAttempts.length, 1, 'real streaming start reached the unavailable browser audio device boundary');
  assert.equal(h.runtime().isCurrent(snapshot), true); assertPrivateDataAbsent(h);
});

test('every play activation performs fresh native authorization; prior local metadata is never a cached grant', async t => {
  const h = await actionFixture(t); const snapshot = await admit(h, ready({presentation: 'tracks'})), row = snapshot.result.tracks[0];
  const first = outcome(h.runtime().playTrack(snapshot, row)); h.reply(1, nativeReply(h, 1)); assert.equal((await first).value, true); await h.flush();
  const next = outcome(h.runtime().playTrack(snapshot, row)); assert.equal(h.requests.length, 3);
  h.reply(2, {error: 'forbidden'}, 403); assert.equal((await next).error.status, 403);
  assert.equal(h.activations.length, 1); assert.equal(h.runtime().canPlayTrack(snapshot, row), false);
  assert.equal(h.host.querySelector('[data-search-track-play]').disabled, true);
});

test('nullable native inventory metadata is safely adapted after a valid play response', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const work = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0])), reply = nativeReply(h, 1);
  reply.data.native_target.artist = null; h.reply(1, reply); assert.equal((await work).value, true);
  assert.equal(h.activations.length, 1); assert.equal(h.streams[0][0].artist, '');
});

for (const [name, mutate] of [
  ['listener envelope', value => {value.contract_version = 'listener-history-v1';}],
  ['borrowed Home origin', value => {value.data.origin = {source: 'activity'};}],
  ['wrong inventory identity', value => {value.data.native_target.inventory_track_ref = 'inventory-track:9:102';}],
  ['wrong requested resource', value => {value.data.resource_ref = 'inventory-track:9:102';}],
  ['wrong action', value => {value.data.intent = 'metadata';}],
  ['missing path', value => {delete value.data.native_target.path;}],
  ['mismatched track path', value => {value.data.native_target.track_ref = '/other/path';}],
  ['unbounded path', value => {value.data.native_target.path = 'x'.repeat(4097);}],
  ['extra native grant', value => {value.data.native_target.playback_state = {can_start_here: true};}],
  ['invalid duration', value => {value.data.native_target.duration_seconds = -1;}],
]) test(`native play rejects ${name} before command handoff`, async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const work = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0]));
  const reply = nativeReply(h, 1); mutate(reply); h.reply(1, reply);
  assert.equal((await work).error.status, 409); assert.equal(h.activations.length, 0); assert.equal(h.streams.length, 0);
  assertPrivateDataAbsent(h);
});

test('a Viewer keeps native keyboard multiselection and Album details while media is denied', async t => {
  const h = await actionFixture(t, {media: false}); const snapshot = await admit(h, ready({presentation: 'tracks'}));
  const rows = [...h.host.querySelectorAll('[data-cdt-row-key]')];
  assert.ok(rows.every(row => row.tabIndex === 0));
  h.dispatch(rows[0], 'keydown', {key: ' ', ctrlKey: true});
  h.dispatch(rows[1], 'keydown', {key: ' ', ctrlKey: true});
  assert.ok(rows.every(row => row.getAttribute('aria-selected') === 'true'));
  assert.equal(h.requests.length, 1, 'selection itself performs no native authority query');
  assert.equal(h.runtime().canPlayTrack(snapshot, snapshot.result.tracks[0]), false);
  assert.ok([...h.host.querySelectorAll('[data-search-track-play]')].every(button => button.disabled));
  h.click(h.host.querySelector('[data-search-track-details]'));
  await completeDetails(h, 1, {playAlbum: false});
  assert.equal(h.modal.hidden, false); assert.match(h.modal.textContent, /Full native Album/);
  assert.equal(h.opens.length, 1); assert.equal(h.opens[0][1].presentationRestrictions.can_play_album, false);
  assert.equal(h.activations.length, 0); assert.equal(h.runtime().isCurrent(snapshot), true);
});

for (const presentation of ['albums', 'tracks']) test(`${presentation} opens the actual full native Album without borrowing Home or Playlist origin`, async t => {
  const h = await actionFixture(t); await admit(h, ready({presentation}));
  h.click(h.host.querySelector(presentation === 'albums' ? '[data-gallery-card-intent="open"]' : '[data-search-track-details]'));
  await completeDetails(h, 1);
  assert.equal(h.hydrations.length, 1); assert.equal(h.hydrations[0][1].readOnlySubject, false);
  assert.equal(h.modal.hidden, false); assert.match(h.document.getElementById('track-modal-title').textContent, /Full native Album/);
  assert.equal(h.state.modalReleases[0].key, 'native-album-eleven');
  assert.equal(h.opens[0][0].name, 'Full native Album');
  assert.equal(h.c.getTrackModalSourcePageOwner().isCurrent(), true);
  for (const request of h.requests.slice(1, 3)) assert.deepEqual(Object.keys(JSON.parse(request.options.body)).sort(), ['intent', 'resource_ref']);
  assertPrivateDataAbsent(h, ['native-album-eleven']);
});

for (const [name, mutate] of [
  ['wrong parent', value => {value.data.parent_album_ref = 'inventory-album:9:12';}],
  ['missing detail grant', value => {value.data.native_target.allowed_actions.can_view_details = false;}],
  ['nonboolean Album playback', value => {value.data.native_target.allowed_actions.can_play_album = 'yes';}],
  ['injected origin', value => {value.data.native_target.origin = {source: 'playlist'};}],
]) test(`track details rejects ${name} before native hydration`, async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const work = outcome(h.runtime().openAlbum(snapshot, snapshot.result.tracks[0]));
  const reply = nativeReply(h, 1); mutate(reply); h.reply(1, reply);
  assert.equal((await work).error.status, 409); assert.equal(h.hydrations.length, 0); assert.equal(h.opens.length, 0);
});

test('current can_select governs real source selection independently of readable details', async t => {
  const h = await actionFixture(t), payload = ready({presentation: 'tracks'});
  payload.tracks[0].allowed_actions.can_select = false;
  const snapshot = await admit(h, payload), lease = source(h, snapshot), rows = [...h.host.querySelectorAll('[data-cdt-row-key]')];
  assert.equal(rows[0].tabIndex, -1); assert.equal(rows[0].getAttribute('aria-disabled'), 'true');
  h.dispatch(rows[0], 'keydown', {key: ' ', ctrlKey: true}); assert.equal(rows[0].getAttribute('aria-selected'), null);
  assert.equal(lease.resolveRows([snapshot.result.tracks[0].rowKey]), null);
  const key = snapshot.result.tracks[1].rowKey;
  assert.deepEqual(plain(lease.resolveRows([key])), {rows: [{rowKey: key, track_ref: 'inventory-track:9:102'}], playlist_creation_source: null});
  assert.equal(lease.canQueue([key]), false); assert.equal(await lease.captureQueue([key]), null);
  assert.equal(h.runtime().canOpenAlbum(snapshot, snapshot.result.tracks[0]), true);
  lease.dispose();
});

test('actual native selection opens the existing Playlist destination picker and omits Queue actions', async t => {
  const h = await actionFixture(t, {entry: true}); await admit(h, ready({presentation: 'tracks'}));
  const row = h.host.querySelector('[data-cdt-row-key]'); h.dispatch(row, 'keydown', {key: ' ', ctrlKey: true});
  h.dispatch(row, 'contextmenu', {button: 2});
  const menu = h.document.querySelector('.settings-foobar-format-menu'); assert.ok(menu);
  assert.match(menu.textContent, /Add to playlist/); assert.doesNotMatch(menu.textContent, /queue/i);
  h.click([...menu.querySelectorAll('button')].find(node => node.textContent.trim() === 'Add to playlist'));
  await h.flush();
  assert.equal(h.requests.at(-1).url, '/playlists/destinations');
  h.reply(h.requests.length - 1, {status: 'empty', context_ref: A, data: {actor_scope: {account_id: 7, library_id: 9},
    destinations: [], allowed_actions: {can_create: false}}}); await h.flush();
  assert.ok(h.document.querySelector('[role="dialog"]'));
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0, 'opening a picker does not manufacture a source or write');
});

test('matching remains gallery-only after native actions are connected', async t => {
  const h = await actionFixture(t); await admit(h, ready());
  assert.equal(h.host.querySelectorAll('.album-card--search-match').length, 1);
  await admit(h, ready({presentation: 'tracks'}));
  assert.equal(h.host.querySelectorAll('.album-track-table__row--search-match,[data-track-search-match="true"]').length, 0);
  assert.equal(h.host.querySelectorAll('[data-search-track-play]').length, 2);
  assertPrivateDataAbsent(h, ['inventory-track:9:101', 'activity_', 'snapshot_ref']);
});
