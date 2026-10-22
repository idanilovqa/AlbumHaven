'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {fixture, artistView, group, album, ARTIST, plain, drain, ROOT} = require('./artist-host-fixtures/actual-artist-runtime.cjs');
const STAMP = 'a'.repeat(64);
const descriptor = patch => ({version: 1, root_artist_id: '9223372036854775807', scope_mode: 'artist', ...patch});
const recipe = patch => ({...descriptor(), source: 'artist_loved', auto_update: true, playback_order: 'regular', ...patch});
const launch = (artist = ARTIST, mode = 'artist', root = '9223372036854775807') => ({context_ref: STAMP,
  artist_ref: artist, descriptor: descriptor({scope_mode: mode, root_artist_id: root})});
const saved = patch => recipe({last_evaluated_at: '2026-10-18T00:00:00Z', root_state: 'present', refresh_status: 'current', ...patch});
let normalizeArtistLovedDescriptor, normalizeArtistLovedRecipe, normalizeArtistLovedLaunch, normalizeSavedArtistLovedRecipe;
test.before(async () => {({normalizeArtistLovedDescriptor, normalizeArtistLovedRecipe, normalizeArtistLovedLaunch,
  normalizeSavedArtistLovedRecipe} = await import('../../../music_app/static/js/playlists/artist-loved-recipe.mjs'));});

test('Loved descriptor preserves exact bigint boundary and returns a fresh frozen strict value', () => {
  for (const root_artist_id of ['1', '9007199254740993', '9223372036854775807']) for (const scope_mode of ['artist', 'family']) {
    const input = descriptor({root_artist_id, scope_mode}), result = normalizeArtistLovedDescriptor(input);
    assert.deepEqual(result, input); assert.notEqual(result, input); assert.equal(Object.isFrozen(result), true);
  }
  for (const root_artist_id of [0, 1, 9007199254740992, null, '', '0', '-1', '+1', '01', '1.0', '1e2', ' 1', '1 ',
    '１', '١', '9223372036854775808', '10000000000000000000']) assert.equal(normalizeArtistLovedDescriptor(descriptor({root_artist_id})), null);
  for (const value of [null, [], {}, Object.create(descriptor()), descriptor({version: '1'}), descriptor({version: 2}),
    descriptor({scope_mode: 'all'}), descriptor({scope_mode: 'Artist'}), descriptor({extra: true})]) assert.equal(normalizeArtistLovedDescriptor(value), null);
});
test('Loved recipe never accepts Popular metadata, browser filters or saved-only status through its capture normalizer', () => {
  for (const playback_order of ['regular', 'shuffle', 'unplayed_first']) {
    const result = normalizeArtistLovedRecipe(recipe({playback_order})); assert.equal(Object.isFrozen(result), true);
    assert.equal(result.auto_update, true); assert.equal(result.playback_order, playback_order);
  }
  for (const value of [descriptor(), saved(), recipe({source: 'artist_selection'}), recipe({auto_update: false}),
    recipe({auto_update: 1}), recipe({playback_order: undefined}), recipe({provider: 'lastfm'}),
    recipe({metric: 'overall_scrobbles'}), recipe({categories: ['hoard']}), recipe({songs_per_group: 3})])
    assert.equal(normalizeArtistLovedRecipe(value), null);
});
test('Loved launch requires exact private context, anchor and descriptor with deep frozen identity', () => {
  const value = normalizeArtistLovedLaunch(launch()); assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.descriptor), true); assert.deepEqual(value, launch());
  for (const patch of [{context_ref: 'a'.repeat(63)}, {context_ref: 'A'.repeat(64)}, {context_ref: null},
    {artist_ref: ''}, {artist_ref: ' '}, {artist_ref: 'Artist\nOther'}, {descriptor: descriptor({root_artist_id: '01'})},
    {actor_id: 7}]) assert.equal(normalizeArtistLovedLaunch({...launch(), ...patch}), null);
});
test('saved Loved statuses validate separately, retain missing root provenance and never imply freshness', () => {
  for (const refresh_status of ['current', 'last_computed', 'owner_refresh_required', 'unavailable', 'too_large'])
    for (const root_state of ['present', 'root_missing']) {
      const result = normalizeSavedArtistLovedRecipe(saved({refresh_status, root_state}));
      assert.equal(Object.isFrozen(result), true); assert.equal(result.refresh_status, refresh_status);
      assert.equal(result.root_state, root_state); assert.equal(result.root_artist_id, '9223372036854775807');
    }
  for (const value of [recipe(), saved({refresh_status: 'fresh'}), saved({root_state: 'deleted'}),
    saved({last_evaluated_at: null}), saved({last_evaluated_at: 'yesterday'}), saved({extra: true})])
    assert.equal(normalizeSavedArtistLovedRecipe(value), null);
});

function admittedView({mode = 'info', family = false, ...patch} = {}) {
  const primary = group(ARTIST, [album(1)], {artist_loved_launch: launch()});
  const related = group('Family Artist', [album(2, {artist: 'Family Artist'})], {artist_loved_launch: launch('Family Artist', 'artist', '8')});
  return artistView({context_ref: STAMP, artist_loved_context_ref: STAMP,
    artist_groups: family ? [primary, related] : [primary], primary_artist_groups: [primary],
    family_artist_groups: family ? [related] : [], related_artists: family ? ['Family Artist'] : [],
    artist_page: {artist_ref: ARTIST, active_page_mode: mode, page_modes: ['gallery', 'info'], default_page_mode: 'gallery',
      artist_loved_launches: {artist: launch(), family: launch(ARTIST, 'family')}}, ...patch});
}
async function admitted(t, options = {}) {
  const h = fixture(t); await h.entry(); await h.admit(admittedView(options)); h.frame(); return h;
}
const action = h => h.header.querySelector('[data-gallery-bar-action="loved-tracks"]');
const captureInput = h => h.context.captureGalleryArtistLovedInput();

test('standalone Artist header uses the exact mounted session and original shared slot and scroll owner', async t => {
  const h = await admitted(t), snapshot = h.runtime().snapshot(), ids = h.identities(), input = captureInput(h);
  assert.ok(input); assert.deepEqual(plain(input.descriptor), descriptor());
  assert.equal(input.launchContext.sessionId, snapshot.sessionId); assert.equal(input.launchContext.viewRevision, h.state.ui.viewStateRevision);
  assert.equal(input.launchContext.entryUrl, h.location.href); assert.equal(input.launchContext.isCurrent(), true);
  assert.equal(h.context.AlbumHavenPlaylistUI.canOpenArtistLoved(input), true);
  assert.equal(h.document.querySelectorAll('[data-artist-page-action-slot="loved"]').length, 1);
  assert.equal(h.identities().slot, ids.slot); assert.equal(h.document.querySelectorAll('#albums-scroll').length, 1);
  assert.equal(h.document.querySelectorAll('#albums-viewport').length, 1); assert.equal(h.grid, ids.grid);
  assert.equal(action(h).getAttribute('aria-label'), 'Play loved and obsessed tracks'); assert.equal(action(h).disabled, false);
});
test('gallery family and single summaries select their page descriptor independently of category, type and subset display filters', async t => {
  const h = await admitted(t, {mode: 'gallery', family: true});
  assert.equal(h.context.galleryArtistLovedHeaderContext().kind, 'family');
  assert.equal(captureInput(h).descriptor.scope_mode, 'family');
  const root = captureInput(h).descriptor.root_artist_id;
  h.state.gallery.mainState.sources = {main_library: false, hoard: true, new_arrivals: false};
  h.state.gallery.mainState.albumTypes = ['compilation']; h.state.gallery.mainState.familyArtists = ['Family Artist'];
  h.state.gallery.mainState.familySelectionExplicit = true; h.context.updateGalleryMainControls();
  assert.equal(captureInput(h).descriptor.scope_mode, 'family'); assert.equal(captureInput(h).descriptor.root_artist_id, root);
  assert.match(action(h).title, /family/i);
  await h.admit(admittedView({mode: 'gallery', family: false})); h.frame();
  assert.equal(h.context.galleryArtistLovedHeaderContext().kind, 'single-artist');
  assert.equal(captureInput(h).descriptor.scope_mode, 'artist');
});
test('scrolled root gallery binds the real selected source section rather than selected page or first album', async t => {
  const h = await admitted(t, {mode: 'gallery', family: true, selected_artist: '', artist_page: null,
    primary_artist_groups: [], family_artist_groups: [], related_artists: []});
  assert.equal(captureInput(h), null, 'root summary has no artist launch');
  const sections = h.context.getGalleryMainContextSections(); assert.equal(sections.length, 2);
  // Supply only browser layout facts: label rectangles move with the scroll
  // owner. The production section resolver and header-context owner stay real.
  function layoutLabels() {
    const viewportTop = h.nodes.viewport.getBoundingClientRect().top;
    const contentOrigin = viewportTop - h.scroll.getBoundingClientRect().top + h.scroll.scrollTop;
    for (const node of h.document.querySelectorAll('[data-scroll-artist]')) {
      const section = sections.find(row => row.artist === node.dataset.scrollArtist);
      const label = node.querySelector('.artist-name');
      if (!section || !label) continue;
      const height = h.grid.sectionHeaderHeight, contentTop = contentOrigin + section.top;
      label.getBoundingClientRect = () => {
        const top = h.scroll.getBoundingClientRect().top + contentTop - h.scroll.scrollTop;
        return {x: 0, y: top, top, bottom: top + height, left: 0, right: 200, width: 200, height};
      };
    }
  }
  layoutLabels();
  const selected = h.context.getGalleryMainContextSections()[1];
  assert.ok(selected.labelBottom > 12, 'selected label is below the root summary threshold');
  h.scrollTo(selected.labelBottom + 1); layoutLabels(); h.context.updateGalleryMainControls();
  assert.equal(h.context.getGalleryMainContextSections()[1].labelBottom, selected.labelBottom,
    'scroll-relative label rect preserves its content-coordinate bottom');
  const context = h.context.galleryArtistLovedHeaderContext(), input = captureInput(h);
  assert.equal(context.kind, 'artist'); assert.equal(context.sourceSection.group, selected.group);
  assert.equal(input.launchContext.sourceGroup, selected.group);
  assert.equal(input.descriptor.root_artist_id, '8'); assert.equal(input.descriptor.scope_mode, 'artist');
});
test('synthetic merged or split display identities cannot borrow a real group admission', async t => {
  const h = await admitted(t, {mode: 'gallery', family: true, selected_artist: '', artist_page: null,
    primary_artist_groups: [], family_artist_groups: [], related_artists: []});
  const sections = h.context.getGalleryMainContextSections(), section = sections[0], original = section.group;
  for (const patch of [{artist: `${ARTIST} / Another`}, {display_artist_key: `${ARTIST}:split`}]) {
    const synthetic = {...original, ...patch};
    assert.equal(h.context.captureGalleryArtistLovedInput({kind: 'artist', artist: synthetic.artist,
      sourceSection: {...section, group: synthetic}}), null);
  }
  assert.equal(h.context.captureGalleryArtistLovedInput({kind: 'gallery'}), null);
});
test('same Artist hydration without fresh launch explicitly clears every page and group authority', async t => {
  const h = await admitted(t), old = captureInput(h), slot = h.identities().slot, next = artistView({context_ref: STAMP});
  await h.admit(next, {push: false}); h.frame();
  assert.equal(old.launchContext.isCurrent(), false); assert.equal(captureInput(h), null);
  assert.equal(h.state.view.artist_loved_context_ref, null);
  assert.equal(h.state.view.artist_page.artist_loved_launches.artist, null);
  assert.equal(h.state.view.artist_page.artist_loved_launches.family, null);
  assert.ok(h.state.view.artist_groups.every(row => row.artist_loved_launch === null));
  assert.equal(h.identities().slot, slot, 'the original Artist slot remains stable');
  assert.equal(slot.children.length, 0, 'removed Loved authority leaves an empty slot');
  assert.equal(action(h), null, 'no Loved control is rendered without authority');
  const before = h.requests.length, current = h.state.player.current, queue = h.state.player.playbackQueue;
  assert.equal(h.context.AlbumHavenPlaylistUI.canOpenArtistLoved(old), false);
  assert.equal(h.context.AlbumHavenPlaylistUI.openArtistLoved(old), false, 'old launch cannot activate');
  assert.equal(h.requests.length, before); assert.equal(h.state.player.current, current);
  assert.equal(h.state.player.playbackQueue, queue);
});
test('partial/sidebar replacement cannot inherit cached page or group launch, while pure scale patch can preserve current receipt', async t => {
  const h = await admitted(t), c = h.context, before = h.state.view;
  const local = c.normalizeViewPayload({gallery_scale_percent: 120}, before);
  assert.ok(local.artist_page.artist_loved_launches.artist);
  assert.equal(c.artistLovedLaunchIsCurrent(local.artist_page.artist_loved_launches.artist), true);
  for (const patch of [{payload_tier: 'sidebar', artists_sidebar: []}, {selected_artist: ARTIST},
    {surface: {active: 'playlists'}}, {surface: {active: 'home'}}, {selected_artist: '', artist_page: null}]) {
    const value = c.normalizeViewPayload(patch, before);
    assert.equal(value.artist_loved_context_ref, null);
    if (value.artist_page) assert.equal(value.artist_page.artist_loved_launches.artist, null);
    assert.ok((value.artist_groups || []).every(row => row.artist_loved_launch === null));
  }
});
test('transport and actor/library round trips permanently retire admitted leases and cached launch objects', async t => {
  const h = await admitted(t), c = h.context;
  for (const kind of ['actor', 'library', 'context']) {
    const input = captureInput(h), oldView = h.state.view, oldLaunch = oldView.artist_page.artist_loved_launches.artist;
    assert.ok(input); const key = kind === 'actor' ? 'nativeAccountId' : kind === 'library' ? 'nativeLibraryId' : 'privateUiContext';
    const original = h.shell.dataset[key]; h.change(kind); assert.equal(input.launchContext.isCurrent(), false);
    h.change(kind, original); assert.equal(input.launchContext.isCurrent(), false);
    assert.equal(c.artistLovedLaunchIsCurrent(oldLaunch), false);
    const reused = c.normalizeViewPayload(oldView, oldView);
    assert.equal(reused.artist_page.artist_loved_launches.artist, null);
    await h.admit(admittedView(), {push: false}); h.frame();
  }
});
test('old same-name cached groups cannot be revived by a missing or mismatched response stamp', async t => {
  const h = await admitted(t), c = h.context, before = h.state.view;
  for (const stamp of [undefined, null, 'b'.repeat(64), 'invalid']) {
    const value = c.normalizeViewPayload({...before, artist_loved_context_ref: stamp,
      related_filter_base_primary_groups: before.primary_artist_groups}, before);
    assert.equal(value.artist_groups[0].artist_loved_launch, null);
    assert.equal(value.related_filter_base_primary_groups[0].artist_loved_launch, null);
  }
});
test('same-entry Artist refresh keeps host session but old Loved lease retires; pushed same Artist receives a new session', async t => {
  const h = await admitted(t), initial = h.runtime().snapshot(), input = captureInput(h);
  await h.admit(admittedView(), {push: false}); h.frame();
  assert.equal(h.runtime().snapshot().sessionId, initial.sessionId); assert.equal(input.launchContext.isCurrent(), false);
  assert.equal(captureInput(h).launchContext.isCurrent(), true);
  const refreshed = captureInput(h); await h.admit(admittedView(), {push: true}); h.frame();
  assert.notEqual(h.runtime().snapshot().sessionId, initial.sessionId); assert.equal(refreshed.launchContext.isCurrent(), false);
  assert.equal(captureInput(h).launchContext.sessionId, h.runtime().snapshot().sessionId);
});
test('shared merge owner replaces every touched launch and retains untouched only under the same valid stamp', async t => {
  const h = await admitted(t), merge = h.context.mergeRootGalleryPageGroups;
  const a = group('A', [album(1)], {artist_loved_launch: launch('A', 'artist', '1')});
  const b = group('B', [album(2)], {artist_loved_launch: launch('B', 'artist', '2')});
  const result = merge([a, b], [group('A', [album(3)])], STAMP, STAMP);
  assert.equal(result[0].artist_loved_launch, null); assert.equal(result[1].artist_loved_launch, b.artist_loved_launch);
  assert.deepEqual(Array.from(result[0].albums, row => row.key), [album(1).key, album(3).key]);
  assert.equal(a.artist_loved_launch.descriptor.root_artist_id, '1'); assert.equal(a.albums.length, 1);
  for (const stamp of [null, 'b'.repeat(64)]) {
    const next = merge([a, b], [group('A', [], {artist_loved_launch: launch('A', 'artist', '3')})], STAMP, stamp);
    assert.equal(next[1].artist_loved_launch, null); assert.equal(next[0].artist_loved_launch.descriptor.root_artist_id, '3');
  }
});
function rootView(patch = {}) {
  const a = group('A', [album(1, {artist: 'A'})], {artist_loved_launch: launch('A', 'artist', '1')});
  const b = group('B', [album(2, {artist: 'B'})], {artist_loved_launch: launch('B', 'artist', '2')});
  return admittedView({mode: 'gallery', selected_artist: '', artist_page: null, artist_groups: [a, b],
    primary_artist_groups: [], family_artist_groups: [], related_artists: [],
    gallery_page: {revision: 'root-r1', has_more: true, next_cursor: 'cursor-1'}, ...patch});
}
async function beginPage(h) {
  h.scroll.scrollHeight = h.scroll.clientHeight; h.scroll.scrollTop = 0;
  const index = h.requests.length, promise = h.context.loadNextRootGalleryPage(); await drain();
  assert.equal(h.requests.length, index + 1); return {index, promise};
}
test('actual root continuation clears touched group and keeps untouched only with current response admission', async t => {
  const h = fixture(t); await h.entry(); await h.admit(rootView());
  const pending = await beginPage(h);
  h.reply(pending.index, rootView({artist_groups: [group('A', [album(3, {artist: 'A'})])],
    gallery_page: {revision: 'root-r1', has_more: false, next_cursor: null}}));
  assert.equal(await pending.promise, true);
  const rows = h.state.view.artist_groups;
  assert.equal(rows.find(row => row.artist === 'A').artist_loved_launch, null);
  assert.equal(rows.find(row => row.artist === 'B').artist_loved_launch.descriptor.root_artist_id, '2');
});
test('actual root continuation without stamp clears all prior authority and stale request cannot apply', async t => {
  const h = fixture(t); await h.entry(); await h.admit(rootView());
  let pending = await beginPage(h);
  h.reply(pending.index, rootView({artist_loved_context_ref: null, artist_groups: [group('A', [album(3)])],
    gallery_page: {revision: 'root-r1', has_more: false, next_cursor: null}}));
  assert.equal(await pending.promise, true); assert.ok(h.state.view.artist_groups.every(row => row.artist_loved_launch === null));
  await h.admit(rootView()); pending = await beginPage(h);
  h.context.cancelRootGalleryPageRequest(); const view = h.state.view;
  h.reply(pending.index, rootView({artist_groups: [group('Intruder')], gallery_page: {revision: 'root-r1', has_more: false}}));
  assert.equal(await pending.promise, false); assert.equal(h.state.view, view);
});
test('root cursor restart discards old launch objects and admits only replacement page', async t => {
  const h = fixture(t); await h.entry(); await h.admit(rootView()); const pending = await beginPage(h);
  h.reply(pending.index, {restart_required: true}, 409); await drain();
  assert.equal(h.requests.length, pending.index + 2);
  h.reply(pending.index + 1, rootView({artist_groups: [group('C', [album(3)], {artist_loved_launch: launch('C', 'artist', '3')})],
    gallery_page: {revision: 'root-r2', has_more: false, next_cursor: null}}));
  assert.equal(await pending.promise, true);
  assert.deepEqual(Array.from(h.state.view.artist_groups, row => row.artist), ['C']);
  assert.equal(h.state.view.artist_groups[0].artist_loved_launch.descriptor.root_artist_id, '3');
});
test('shared love-play icon has identical JS and Jinja geometry and exactly one stable Gallery action slot', async t => {
  const h = await admitted(t), js = h.context.ButtonComponent.renderIconSvg('love-play'), template = fs.readFileSync(path.join(ROOT, 'music_app/templates/partials/button.html'), 'utf8');
  const block = template.match(/'love-play':\s*'([^']+)'/);
  assert.ok(block, 'shared Jinja macro owns love-play');
  const geometry = value => [...value.matchAll(/<(?:path|polygon)\b[^>]*(?:d|points)="([^"]+)"/g)].map(match => match[1]);
  assert.ok(geometry(js).length); assert.deepEqual(geometry(js), geometry(block[1]));
  assert.equal(h.header.querySelectorAll('[data-artist-page-action-slot="loved"]').length, 1);
  assert.equal(h.header.querySelectorAll('[data-gallery-bar-action="loved-tracks"]').length, 1);
});

// Root-approved platform-only expansion inside this suite: instantiate the
// actual served empty Playlist mount. All response admission/navigation owners
// remain the connected fixture's whole production implementations.
async function withPlaylistRoot(t, {observeRuntimeReads = false} = {}) {
  const h = fixture(t), template = fs.readFileSync(path.join(ROOT, 'music_app/templates/index.html'), 'utf8');
  const markup = template.match(/<section\b[^>]*\bid="playlists-root"[^>]*><\/section>/)?.[0];
  assert.ok(markup, 'served empty Playlist root exists');
  h.main.insertAdjacentHTML('beforeend', markup);
  const playlistRoot = h.document.getElementById('playlists-root'); assert.ok(playlistRoot);
  const traffic = observeRuntimeReads ? observeReplacementReads(h) : null;
  const handler = event => h.context.handleGalleryMainClick(event);
  const retirePlaylist = () => {
    h.header.removeEventListener('click', handler);
    try {retireRuntimeMount(h.context);} finally {traffic?.restore();}
  };
  try {
    await h.entry(); h.header.addEventListener('click', handler);
    return {...h, playlistRoot, retirePlaylist, traffic};
  } catch (error) {retirePlaylist(); throw error;}
}
function namedButton(h, label) {
  const found = [...h.playlistRoot.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent.trim()) === label);
  assert.ok(found, `actual native ${label} button`); return found;
}
test('actual Artist header transfers directly and retained saved navigation retries the acknowledged ID after HTTP admission failure', async t => {
  const {id, capture, receipt} = require('./library-mix-fixtures.cjs');
  const h = await withPlaylistRoot(t), writes = [], captures = [];
  try {
  h.context.AlbumHavenPlaylistUI.configureProviders({
    beginArtistLoved: async options => {
      captures.push(options); const value = capture({scopeKey: options.scopeKey, source_protocol: 'artist_loved_selection_v1', entries: [],
        artist_loved: recipe(options.descriptor)}); delete value.data.library_mix; delete value.data.coverage; return value;
    },
    createPlaylistFromSelection: async options => {writes.push(options); return receipt(options.request_key,
      {scopeKey: options.scopeKey, creation_outcome: 'existing'});},
  });
  await h.admit(admittedView()); h.frame(); const artistSession = h.runtime().snapshot().sessionId;
  h.click(action(h)); await drain(); h.frame();
  assert.equal(captures.length, 1); assert.deepEqual(plain(captures[0].descriptor), descriptor());
  assert.ok(h.playlistRoot.querySelector('main[aria-label="Temporary Library Mix"]'));
  assert.equal(h.document.querySelector('[aria-label="Songs per group"]'), null);
  assert.equal(h.runtime().snapshot().actionable, false, 'covered Artist no longer owns draft currentness');
  assert.equal(namedButton(h, 'Save as playlist').disabled, false);
  const before = h.requests.length, token = h.context.AlbumHavenPlaylistRuntime.snapshot().draftToken;
  h.click(namedButton(h, 'Save as playlist')); await drain();
  assert.equal(writes.length, 1); assert.equal(h.requests.length, before + 1);
  h.reply(before, {error: 'unavailable'}, 503); await drain(); h.frame();
  assert.equal(h.context.AlbumHavenPlaylistRuntime.snapshot().retainedDraftToken, token);
  assert.match(h.playlistRoot.textContent, /You already saved this playlist\./);
  h.click(namedButton(h, 'Open saved playlist')); await drain(); assert.equal(h.requests.length, before + 2);
  const detail = {playlist_id: id(80), title: 'Previously saved title', description: 'Original metadata', revision: '1',
    playlist_kind: 'artist_loved', artist_loved: saved(), items_complete: true, track_rows: [],
    allowed_actions: {can_open: true, can_play: true, can_edit: true, can_add: false, can_reorder: false}};
  h.reply(before + 1, {context_ref: STAMP, surface: {active: 'playlists'}, playlist_detail: detail,
    playlist_sidebar: {active_playlist_id: id(80), items: [{playlist_id: id(80), title: detail.title, allowed_actions: {can_open: true}}]}});
  await drain(); h.frame();
  const snapshot = h.context.AlbumHavenPlaylistRuntime.snapshot();
  assert.equal(snapshot.playlistId, id(80)); assert.equal(snapshot.retainedDraftToken, null);
  assert.equal(h.state.view.playlist_detail.title, 'Previously saved title');
  assert.equal(writes.length, 1); assert.equal(captures.length, 1);
  assert.notEqual(h.runtime().snapshot().sessionId, artistSession);
  } finally {h.retirePlaylist();}
});
test('actual header activation rereads its lease and cannot capture from detached or stale enabled control', async t => {
  const h = await withPlaylistRoot(t), captures = [];
  try {
  h.context.AlbumHavenPlaylistUI.configureProviders({beginArtistLoved: options => {captures.push(options); throw new Error('must not capture');}});
  await h.admit(admittedView()); h.frame(); const button = action(h); assert.equal(button.disabled, false);
  await h.admit(artistView(), {push: false}); h.frame();
  h.click(button); await drain(); assert.equal(captures.length, 0);
  await h.admit(admittedView()); h.frame(); const detached = action(h); h.header.remove();
  h.click(detached); await drain(); assert.equal(captures.length, 0);
  } finally {h.retirePlaylist();}
});

test('private Search actual response retires Loved page/group admission instead of borrowing ordinary cache', async t => {
  const {ready, mainUrl} = require('./search-native-fixtures/actual-runtime.cjs');
  const h = await admitted(t), input = captureInput(h), data = ready(), index = h.requests.length;
  const pending = h.read(mainUrl(data), {}, true); h.reply(index, data);
  const result = await pending; assert.equal(result.error, undefined); h.frame();
  assert.equal(h.state.view.private_search, true); assert.equal(h.state.view.artist_loved_context_ref, null);
  assert.equal(input.launchContext.isCurrent(), false); assert.equal(captureInput(h), null);
});
test('actual Back retires pending capture permanently and never resurrects it on the covered Artist entry', async t => {
  const {capture, deferred} = require('./library-mix-fixtures.cjs');
  const h = await withPlaylistRoot(t), wait = deferred(); let input;
  try {
  h.context.AlbumHavenPlaylistUI.configureProviders({beginArtistLoved: options => {input = options; return wait.promise;}});
  await h.admit(admittedView()); h.frame(); h.click(action(h)); await drain();
  assert.ok(input); assert.equal(input.signal.aborted, false);
  h.history.go(-1); await drain(); h.frame(); assert.equal(input.signal.aborted, true);
  const value = capture({scopeKey: input.scopeKey, source_protocol: 'artist_loved_selection_v1', artist_loved: recipe(), entries: []});
  delete value.data.library_mix; delete value.data.coverage; wait.resolve(value); await drain(); h.frame();
  assert.equal(h.context.AlbumHavenPlaylistRuntime.snapshot().retainedDraftToken, null);
  assert.equal(h.playlistRoot.querySelector('main[aria-label="Temporary Library Mix"]'), null);
  } finally {h.retirePlaylist();}
});
test('native provider replacement invalidates a captured real header lease without a network read', async t => {
  const h = await admitted(t), input = captureInput(h), requests = h.requests.length;
  h.context.AlbumHavenPlaylistUI.configureProviders({beginArtistLoved: async () => assert.fail('stale capture')});
  assert.equal(input.launchContext.isCurrent(), false);
  assert.equal(h.context.AlbumHavenPlaylistUI.canOpenArtistLoved(input), false);
  assert.equal(h.context.AlbumHavenPlaylistUI.openArtistLoved(input), false);
  assert.equal(h.requests.length, requests);
});

function retireRuntimeMount(context) {
  // Use R2's actual cached-owner disposal path while native ESM globals exist.
  // No readiness event is fabricated and no fixture globals are reinstalled.
  context.AlbumHavenPlaylistRuntime = null;
  if (context.AlbumHavenPlaylistUI) assert.equal(context.AlbumHavenPlaylistUI.openLibraryMix(), false);
}
function replacePlaylistRuntime(context) {
  const previous = context.AlbumHavenPlaylistRuntime;
  const file = path.join(ROOT, 'music_app/static/js/runtime/playlists-react-bridge.js');
  const source = fs.readFileSync(file, 'utf8');
  // Entire pinned bridge, unchanged, gets a fresh lexical owner. All outer
  // transport/player/navigation state remains live in the original VM realm.
  vm.runInContext(`(function () {\n${source}\n}).call(this);`, context, {filename: file});
  const replacement = context.AlbumHavenPlaylistRuntime;
  assert.ok(replacement); assert.notEqual(replacement, previous);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
  return replacement;
}
const {id: replacementId, capture: replacementCapture, receipt: replacementReceipt, deferred: replacementDeferred} = require('./library-mix-fixtures.cjs');
function runtimeCapture(scopeKey, empty = true) {
  const value = replacementCapture({scopeKey, source_protocol: 'artist_loved_selection_v1', artist_loved: recipe(), ...(empty ? {entries: []} : {})});
  delete value.data.library_mix; delete value.data.coverage; return value;
}
const requestPath = (h, request) => new URL(request.url, h.location.href).pathname;
const notificationPath = '/playlists/edit-requests';
const queuePath = '/playlists/creation-source/artist-loved/native-queue';
// Observe the actual reader before native.mjs captures it. The global setter
// observes B's real bridge assignment before its real ready event; neither the
// runtime identity nor its transport/result is replaced by a test double.
function observeReplacementReads(h) {
  const c = h.context, property = Object.getOwnPropertyDescriptor(c, 'AlbumHavenPlaylistRuntime');
  const fetch = c.fetch, readers = new Map(), witnesses = new Map(), checkpoints = [];
  let runtime = c.AlbumHavenPlaylistRuntime, active = null;
  let phase = Object.freeze({label: 'before-mount', owner: null, requestCount: h.requests.length});
  function observe(owner) {
    if (!owner || readers.has(owner)) return;
    const read = owner.readPlaylists; assert.equal(typeof read, 'function'); readers.set(owner, read);
    owner.readPlaylists = function(options) {
      const previous = active, shell = owner.snapshot();
      const witness = {owner, currentOwner: c.AlbumHavenPlaylistRuntime, phase, shell,
        scopeKey: options.scopeKey, playlistId: options.playlist_id, signal: options.signal,
        context: c.AlbumHavenPrivateUITransport.context(),
        generation: c.AlbumHavenPrivateUITransport.generation(), outcome: 'pending', requests: []};
      active = witness;
      try {
        const promise = read.call(owner, options);
        promise.then(value => {witness.outcome = 'fulfilled'; witness.value = value;},
          error => {witness.outcome = 'rejected'; witness.error = error;});
        return promise;
      } finally {active = previous;}
    };
  }
  observe(runtime);
  Object.defineProperty(c, 'AlbumHavenPlaylistRuntime', {configurable: true, enumerable: property.enumerable,
    get: () => runtime, set: owner => {runtime = owner; observe(owner);}});
  c.fetch = function(...args) {
    const before = h.requests.length, result = fetch.apply(this, args);
    if (active) for (const request of h.requests.slice(before)) {
      const witness = {...active, invocation: active, requestIndex: h.requests.indexOf(request),
        liveAtDispatch: active.signal?.aborted === false};
      witnesses.set(request, witness); active.requests.push(request);
    }
    return result;
  };
  return {witnesses, checkpoints,
    checkpoint(label, owner = null) {
      phase = Object.freeze({label, owner, requestCount: h.requests.length}); checkpoints.push(phase); return phase;
    },
    restore() {
      c.fetch = fetch;
      for (const [owner, read] of readers) owner.readPlaylists = read;
      Object.defineProperty(c, 'AlbumHavenPlaylistRuntime', {...property, value: runtime});
    }};
}
function ordinaryDirectoryRead(h, request, witness) {
  const url = new URL(request.url, h.location.href);
  return Boolean(witness && request.url === '/view-data?surface=playlists'
    && url.origin === new URL(h.location.href).origin && request.options.method === 'GET'
    && request.options.body === undefined && request.options.signal === witness.signal && witness.liveAtDispatch
    && witness.owner === witness.currentOwner && witness.owner === witness.phase.owner
    && witness.requestIndex >= witness.phase.requestCount
    && ['A-open', 'B-open'].includes(witness.phase.label)
    && witness.shell.visible === true && witness.shell.payload === null
    && witness.shell.retainedDraftToken && witness.shell.draftToken === witness.shell.retainedDraftToken
    && witness.shell.playlistId === null && witness.playlistId === null
    && witness.scopeKey === witness.shell.scopeKey && witness.context === STAMP
    && request.options.headers['X-AlbumHaven-Context'] === witness.context);
}
function assertDirectoryReadGuards(h, request, witness) {
  assert.equal(ordinaryDirectoryRead(h, request, witness), true, 'actual current-owner ordinary read is admitted');
  for (const url of ['/view-data?surface=playlists&playlist_id=saved', '/view-data?surface=playlists&extra=1',
    '/view-data?surface=playlists&surface=playlists', '/view-data?surface=artist', 'https://other.invalid/view-data?surface=playlists'])
    assert.equal(ordinaryDirectoryRead(h, {...request, url}, witness), false, 'no broad URL allowance');
  assert.equal(ordinaryDirectoryRead(h, {...request, options: {...request.options, method: 'POST'}}, witness), false);
  assert.equal(ordinaryDirectoryRead(h, request, null), false, 'unwitnessed reads fail closed');
  assert.equal(ordinaryDirectoryRead(h, request, {...witness, currentOwner: {}}), false, 'retired caller rejected');
  assert.equal(ordinaryDirectoryRead(h, request, {...witness, liveAtDispatch: false}), false, 'aborted caller rejected');
  assert.equal(ordinaryDirectoryRead(h, request, {...witness, phase: {...witness.phase, label: 'after-retirement'}}), false);
  assert.equal(ordinaryDirectoryRead(h, request, {...witness, phase: {...witness.phase, owner: {}}}), false);
}
async function settleReplacement(h) {
  await drain();
  // Actual runtime mount starts its notification reader independently of draft
  // capture. Reply through the connected fetch protocol, with valid actor and
  // transport evidence; never suppress the read or invent runtime readiness.
  for (let index = 0; index < h.requests.length; index++) {
    const request = h.requests[index];
    if (request.settled) continue;
    if (h.traffic && requestPath(h, request) === '/view-data') {
      const witness = h.traffic.witnesses.get(request);
      assertDirectoryReadGuards(h, request, witness);
      const viewBeforeReply = h.state.view, entryBeforeReply = h.location.href;
      h.reply(index, {context_ref: STAMP, surface: {active: 'playlists'},
        playlist_sidebar: {active_playlist_id: null, items: []},
        playlist_index: {query: '', playlists: []}, playlist_actions: {can_create: false}});
      await drain();
      assert.equal(witness.invocation.outcome, 'fulfilled', 'real reader admits ordinary directory response');
      assert.deepEqual(plain(witness.invocation.value.playlist_index), {query: '', playlists: []});
      assert.equal(witness.invocation.value.playlist_sidebar.active_playlist_id, null);
      assert.equal(h.state.view, viewBeforeReply, 'ordinary directory result does not admit a destination view');
      assert.equal(h.location.href, entryBeforeReply, 'ordinary directory result does not navigate');
      assert.equal(h.context.AlbumHavenPrivateUITransport.context(), witness.context);
      assert.equal(h.context.AlbumHavenPrivateUITransport.generation(), witness.generation);
      continue;
    }
    if (requestPath(h, request) !== notificationPath) continue;
    assert.equal(request.options.method, 'GET');
    const url = new URL(request.url, h.location.href);
    assert.equal(url.searchParams.get('limit'), '50');
    h.reply(index, {context_ref: STAMP, actor_scope: {...require('./library-mix-fixtures.cjs').ACTOR},
      requests: [], next_cursor: null});
  }
  await drain(); h.frame();
}
function assertReplacementTraffic(h, queueReads = 0) {
  const requests = h.calls.requests;
  assert.equal(h.calls.starts.length, 0, 'retired runtime never starts native playback');
  assert.equal(h.calls.activations.length, 0, 'retired runtime never activates a track');
  assert.equal(requests.filter(row => requestPath(h, row) === '/playlists/creation-source/artist-loved').length, 0,
    'no stale capture endpoint request');
  assert.equal(requests.filter(row => requestPath(h, row) === queuePath).length, queueReads,
    'only the explicitly admitted queue read, never a stale queue retry');
  assert.equal(requests.filter(row => requestPath(h, row) === '/playlists' && row.options.method === 'POST').length, 0,
    'no stale Create endpoint request');
  const allowed = new Set([notificationPath, ...(queueReads ? [queuePath] : [])]);
  const ordinary = requests.filter(row => ordinaryDirectoryRead(h, row, h.traffic.witnesses.get(row)));
  const phases = h.traffic.checkpoints.filter(phase => phase.owner);
  assert.equal(phases.length, 1, 'one explicitly authorized current draft-open phase');
  assert.equal(ordinary.length, 1, 'the real ordinary shell reader ran exactly once');
  for (const phase of phases) assert.equal(ordinary.filter(row => h.traffic.witnesses.get(row).phase === phase).length, 1);
  for (const row of ordinary) {
    const witness = h.traffic.witnesses.get(row);
    assertDirectoryReadGuards(h, row, witness);
    const next = h.traffic.checkpoints[h.traffic.checkpoints.indexOf(witness.phase) + 1];
    if (next) assert.ok(witness.requestIndex < next.requestCount, 'request preceded the next phase checkpoint');
    assert.equal(witness.invocation.requests.length, 1, 'one real fetch per reader invocation');
    assert.equal(witness.invocation.outcome, 'fulfilled'); assert.equal(row.settled, true);
  }
  assert.deepEqual(requests.filter(row => !allowed.has(requestPath(h, row)) && !ordinary.includes(row)).map(row => row.url), [],
    'no stale saved-destination navigation or other network effect');
  for (const row of requests.filter(row => requestPath(h, row) === notificationPath)) {
    assert.equal(row.options.method, 'GET'); assert.equal(row.settled, true, 'startup notification read was answered');
  }
}
async function replacementFixture(t, providers, {forbidPlayback = true} = {}) {
  const h = await withPlaylistRoot(t, {observeRuntimeReads: true}), c = h.context;
  const calls = {starts: [], activations: []}, originals = new Map();
  const restorePlayback = () => {for (const [name, value] of originals) c[name] = value;};
  try {
    // Forbidden-call boundaries, not successful playback doubles. Real queue
    // admission and runtime retirement must reject before either can be reached.
    if (forbidPlayback) for (const [name, bucket] of [['playTrackFromPayload', 'starts'], ['activateSharedTrackButton', 'activations']]) {
      originals.set(name, c[name]);
      c[name] = (...args) => {calls[bucket].push(args); assert.fail(`retired runtime reached ${name}`);};
    }
    c.AlbumHavenPlaylistUI.configureProviders(providers);
    await h.admit(admittedView()); h.frame();
    const baseline = h.requests.length; h.traffic.checkpoint('before-open');
    Object.defineProperty(calls, 'requests', {get: () => h.requests.slice(baseline)});
    return {...h, c, host: h.playlistRoot, calls,
      settle: () => settleReplacement(h),
      named: label => [...h.playlistRoot.querySelectorAll('button')].find(node =>
        (node.getAttribute('aria-label') || node.textContent.trim()) === label),
      replacementInput: () => {const input = captureInput(h); assert.ok(input, 'real admitted Artist launch'); return input;},
      retire: () => {try {h.retirePlaylist();} finally {restorePlayback();}}};
  } catch (error) {try {h.retirePlaylist();} finally {restorePlayback();} throw error;}
}

test('actual runtime-ready replacement retires pending A capture and restoring A cannot revive it', async t => {
  const wait = replacementDeferred(); let captured;
  const h = await replacementFixture(t, {beginArtistLoved: options => {captured = options; return wait.promise;}});
  try {
    const a = h.c.AlbumHavenPlaylistRuntime, input = h.replacementInput();
    h.traffic.checkpoint('A-open', a);
    assert.equal(h.c.AlbumHavenPlaylistUI.openArtistLoved(input), true); await h.settle();
    h.traffic.checkpoint('after-A-open');
    h.traffic.checkpoint('replacement');
    const b = replacePlaylistRuntime(h.c); await h.settle();
    h.traffic.checkpoint('after-B-mount');
    assert.notEqual(b, a); assert.equal(captured.signal.aborted, true);
    assert.equal(a.snapshot().retainedDraftToken, null); assert.equal(b.snapshot().retainedDraftToken, null);
    h.traffic.checkpoint('after-retirement');
    h.c.AlbumHavenPlaylistRuntime = a;
    wait.resolve(runtimeCapture(captured.scopeKey, false)); await h.settle();
    assert.equal(h.host.querySelector('main[aria-label="Temporary Library Mix"]'), null);
    assert.equal(h.calls.starts.length, 0); assertReplacementTraffic(h);
    assert.equal(a.snapshot().retainedDraftToken, null);
  } finally {h.retire(); wait.resolve(runtimeCapture(captured?.scopeKey));}
});
test('runtime-ready rebind gives a fresh B launch to B and never reuses cached A mount', async t => {
  const captures = [], h = await replacementFixture(t, {beginArtistLoved: async options => {captures.push(options); return runtimeCapture(options.scopeKey);}}, {forbidPlayback: false});
  try {
    const current = h.state.player.current, queue = h.state.player.playbackQueue;
    const a = h.c.AlbumHavenPlaylistRuntime;
    h.traffic.checkpoint('replacement');
    const b = replacePlaylistRuntime(h.c); await h.settle();
    h.traffic.checkpoint('after-B-mount');
    const input = h.replacementInput(); assert.equal(input.launchContext.runtime, b);
    h.traffic.checkpoint('B-open', b);
    assert.equal(h.c.AlbumHavenPlaylistUI.openArtistLoved(input), true); await h.settle();
    h.traffic.checkpoint('after-B-open');
    assert.equal(captures.length, 1); assert.ok(b.snapshot().retainedDraftToken);
    assert.equal(a.snapshot().retainedDraftToken, null);
    assert.ok(h.host.querySelector('main[aria-label="Temporary Library Mix"]'));
    assert.equal(h.state.player.current, current); assert.equal(h.state.player.playbackQueue, queue);
    assertReplacementTraffic(h);
  } finally {h.retire();}
});
test('actual runtime replacement while A queue read waits cannot publish native playback or restore the A draft', async t => {
  const h = await replacementFixture(t, {beginArtistLoved: async options => runtimeCapture(options.scopeKey, false)});
  try {
    const a = h.c.AlbumHavenPlaylistRuntime, queue = h.state.player.playbackQueue, current = h.state.player.current;
    h.traffic.checkpoint('A-open', a);
    assert.equal(h.c.AlbumHavenPlaylistUI.openArtistLoved(h.replacementInput()), true); await h.settle();
    h.traffic.checkpoint('after-A-open');
    assertReplacementTraffic(h, 1);
    const request = h.calls.requests.find(row => requestPath(h, row) === queuePath);
    assert.equal(request.url, '/playlists/creation-source/artist-loved/native-queue');
    const body = JSON.parse(request.options.body);
    h.traffic.checkpoint('replacement');
    replacePlaylistRuntime(h.c); await h.settle();
    h.traffic.checkpoint('after-B-mount');
    assert.equal(h.host.querySelector('main[aria-label="Temporary Library Mix"]'), null,
      'real ready event removed the old page before any A snapshot observation');
    assert.equal(a.snapshot().retainedDraftToken, null, 'A draft owner is retired before queue release');
    const transportGeneration = h.c.AlbumHavenPrivateUITransport.generation();
    h.traffic.checkpoint('after-retirement');
    h.c.AlbumHavenPlaylistRuntime = a;
    request.resolve({status: 'ready', context_ref: STAMP, data: {source_protocol: 'artist_loved_selection_v1',
      source: {kind: 'library', ref: body.source_ref, revision: body.source_revision},
      starting_item_ref: body.starting_entry_ref, unavailable_item_refs: [],
      tracks: body.entry_refs.map(ref => ({playlist_item_id: ref, native_target: {playlist_item_id: ref,
        track_ref: `/synthetic-only/${ref}.flac`, path: `/synthetic-only/${ref}.flac`, title: ref,
        artist: 'Artist', album_title: 'Album', duration_seconds: 30,
        inventory_track_ref: `inventory-track:5:${Number(ref.slice(-3))}`}}))}});
    await h.settle();
    assert.equal(h.c.AlbumHavenPrivateUITransport.context(), STAMP, 'valid reply did not invalidate transport context');
    assert.equal(h.c.AlbumHavenPrivateUITransport.generation(), transportGeneration);
    assert.equal(h.state.player.playbackQueue, queue); assert.equal(h.calls.starts.length, 0); assert.equal(h.calls.activations.length, 0);
    assert.equal(h.state.player.current, current);
    assert.equal(a.snapshot().retainedDraftToken, null); assertReplacementTraffic(h, 1);
  } finally {h.retire();}
});
test('actual runtime replacement while A Save waits cannot publish its receipt, navigate or issue a second Create', async t => {
  const wait = replacementDeferred(), writes = [];
  const h = await replacementFixture(t, {beginArtistLoved: async options => runtimeCapture(options.scopeKey),
    createPlaylistFromSelection: options => {writes.push(options); return wait.promise;}});
  try {
    const a = h.c.AlbumHavenPlaylistRuntime;
    h.traffic.checkpoint('A-open', a);
    assert.equal(h.c.AlbumHavenPlaylistUI.openArtistLoved(h.replacementInput()), true); await h.settle();
    h.traffic.checkpoint('after-A-open');
    h.click(h.named('Save as playlist')); await h.settle(); assert.equal(writes.length, 1);
    h.traffic.checkpoint('replacement');
    replacePlaylistRuntime(h.c); await h.settle();
    h.traffic.checkpoint('after-B-mount');
    assert.equal(writes[0].signal.aborted, true);
    h.traffic.checkpoint('after-retirement');
    h.c.AlbumHavenPlaylistRuntime = a;
    wait.resolve(replacementReceipt(writes[0].request_key, {scopeKey: writes[0].scopeKey, creation_outcome: 'existing'})); await h.settle();
    assert.equal(writes.length, 1); assertReplacementTraffic(h);
    assert.equal(h.named('Open saved playlist'), undefined); assert.equal(a.snapshot().retainedDraftToken, null);
  } finally {h.retire(); wait.resolve(null);}
});
test('runtime B observation without readiness permanently retires old A capture across an identity round trip', async t => {
  const wait = replacementDeferred(); let captured;
  const h = await replacementFixture(t, {beginArtistLoved: options => {captured = options; return wait.promise;}});
  try {
    // Obtain an actual B owner first. Returning A and launching through the
    // actual API makes a new A mount; no synthetic B runtime or event is used.
    h.traffic.checkpoint('replacement');
    const a = h.c.AlbumHavenPlaylistRuntime, b = replacePlaylistRuntime(h.c);
    h.c.AlbumHavenPlaylistRuntime = a;
    h.traffic.checkpoint('after-B-mount');
    const inputA = h.replacementInput();
    h.traffic.checkpoint('A-open', a);
    assert.equal(h.c.AlbumHavenPlaylistUI.openArtistLoved(inputA), true); await h.settle();
    h.traffic.checkpoint('after-A-open');
    h.c.AlbumHavenPlaylistRuntime = b;
    assert.equal(h.c.AlbumHavenPlaylistUI.canOpenArtistLoved(inputA), false);
    h.traffic.checkpoint('after-retirement');
    h.c.AlbumHavenPlaylistRuntime = a;
    wait.resolve(runtimeCapture(captured.scopeKey, false)); await h.settle();
    assert.equal(h.calls.starts.length, 0); assertReplacementTraffic(h);
    assert.equal(a.snapshot().draftToken, null);
    assert.equal(h.named('Save as playlist')?.disabled ?? true, true);
  } finally {h.retire(); wait.resolve(null);}
});
test('runtime replacement during actual saved destination read prevents stale admission and never retries Create', async t => {
  const h = await withPlaylistRoot(t), writes = [];
  try {
    h.context.AlbumHavenPlaylistUI.configureProviders({beginArtistLoved: async options => runtimeCapture(options.scopeKey),
      createPlaylistFromSelection: async options => {writes.push(options); return replacementReceipt(options.request_key,
        {scopeKey: options.scopeKey, creation_outcome: 'created'});}});
    await h.admit(admittedView()); h.frame(); h.click(action(h)); await drain(); h.frame();
    const a = h.context.AlbumHavenPlaylistRuntime, before = h.requests.length;
    h.click(namedButton(h, 'Save as playlist')); await drain(); assert.equal(writes.length, 1); assert.equal(h.requests.length, before + 1);
    const destination = h.requests[before];
    const view = h.state.view, b = replacePlaylistRuntime(h.context); await settleReplacement(h);
    assert.notEqual(b, a); assert.equal(h.requests[before].options.signal.aborted, true);
    h.context.AlbumHavenPlaylistRuntime = a;
    h.reply(before, {context_ref: STAMP, surface: {active: 'playlists'},
      playlist_sidebar: {active_playlist_id: replacementId(80), items: [{playlist_id: replacementId(80), title: 'Retired destination', allowed_actions: {can_open: true}}]},
      playlist_detail: {playlist_id: replacementId(80), title: 'Retired destination', revision: '1', playlist_kind: 'artist_loved',
        artist_loved: saved(), track_rows: [], allowed_actions: {can_open: true}}});
    await drain(); h.frame();
    assert.equal(h.state.view, view); assert.notEqual(a.snapshot().playlistId, replacementId(80));
    assert.equal(a.snapshot().retainedDraftToken, null); assert.equal(writes.length, 1);
    assert.deepEqual(h.requests.slice(before).filter(row => requestPath(h, row) !== notificationPath), [destination],
      'only the original destination read; no stale capture, queue, Create or navigation retry');
    assert.equal(h.playlistRoot.querySelector('main[aria-label="Temporary Library Mix"]'), null);
  } finally {h.retirePlaylist();}
});
