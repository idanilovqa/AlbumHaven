'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {id, SCOPE, recipe, mixMetadata, row, capture, receipt, deferred} = require('./library-mix-fixtures.cjs');
let createLibraryMixController, normalizeMixRecipe, orderUnplayedMixRows, normalizePlaylistPayload;
test.before(async () => {
  ({createLibraryMixController, normalizeMixRecipe, orderUnplayedMixRows} = await import('../../../music_app/static/js/playlists/library-mix.mjs'));
  ({normalizePlaylistPayload} = await import('../../../music_app/static/js/playlists/model.mjs'));
});
function fixture(overrides = {}) {
  let current = true, pending = false;
  const calls = {prepare: [], save: [], retry: []};
  const providers = {
    beginLibraryMix: async options => {calls.prepare.push(options); return capture({library_mix: mixMetadata(options.recipe)});},
    createPlaylistFromSelection: async options => {calls.save.push(options); return receipt(options.request_key);},
    hasPendingPlaylistOperation: () => pending,
    retryPlaylistOperation: async options => {calls.retry.push(options); pending = false; return receipt();},
    ...overrides,
  };
  const controller = createLibraryMixController({providers, scopeKey: SCOPE, isCurrent: () => current, requestKey: () => id(90)});
  return {controller, calls, providers, retire: () => {current = false;}, pending: value => {pending = value;}};
}

test('Library Mix accepts only complete bounded recipes and defaults only the optional playback order', () => {
  for (const selection_basis of ['per_artist', 'per_album']) for (const playback_order of ['regular', 'shuffle', 'unplayed_first']) {
    const value = recipe({selection_basis, playback_order, songs_per_group: 5000, auto_update: true});
    assert.deepEqual(normalizeMixRecipe(value), value); assert.equal(Object.isFrozen(normalizeMixRecipe(value)), true);
  }
  const missingOrder = recipe(); delete missingOrder.playback_order;
  assert.equal(normalizeMixRecipe(missingOrder).playback_order, 'regular');
  for (const bad of [null, [], {}, recipe({selection_basis: 'visible_albums'}), recipe({songs_per_group: 0}),
    recipe({songs_per_group: 5001}), recipe({songs_per_group: 2.5}), recipe({songs_per_group: '3'}),
    recipe({auto_update: 1}), recipe({playback_order: 'repeat_one'})]) assert.equal(normalizeMixRecipe(bad), null);
});

test('captured preview remains ephemeral, immutable and ranked independently from personal listening', async () => {
  const h = fixture(), c = h.controller;
  assert.equal(await c.prepare(recipe()), true);
  assert.equal(h.calls.save.length, 0);
  const state = c.getSnapshot(), source = c.source(), rows = state.resource.data.detail.track_rows;
  assert.equal(state.resource.status, 'ready'); assert.equal(state.dirty, true);
  assert.deepEqual(rows.map(row => row.title), ['Track 1', 'Track 2', 'Track 3']);
  assert.deepEqual(rows.map(row => row.play_count), [7, 0, null]);
  assert.deepEqual(rows.map(row => row.popularity_count), [999, 998, 997]);
  assert.deepEqual(source.entry_refs, [id(11), id(12), id(13)]);
  assert.equal(Object.isFrozen(source), true); assert.equal(Object.isFrozen(source.detail.track_rows[0]), true);
  assert.equal(state.coverage.excluded_count, 2);
  assert.equal(c.reorder([id(13), id(12), id(11)]), false);
  for (const grant of ['can_edit', 'can_reorder', 'can_add', 'can_share']) assert.equal(source.detail.allowed_actions[grant], false);
});

test('only known personal zero advances in unplayed-first and neither source order nor unknown data is changed', () => {
  const rows = [{key: 'played', play_count: 12}, {key: 'unknown', play_count: null}, {key: 'zero', play_count: 0},
    {key: 'absent'}, {key: 'zero-two', play_count: 0}];
  assert.deepEqual(orderUnplayedMixRows(rows).map(x => x.key), ['zero', 'zero-two', 'played', 'unknown', 'absent']);
  assert.deepEqual(rows.map(x => x.key), ['played', 'unknown', 'zero', 'absent', 'zero-two']);
  assert.equal(rows[1].play_count, null); assert.equal(Object.hasOwn(rows[3], 'play_count'), false);
});

test('malformed or mismatched capture cannot create a preview or a save command', async () => {
  const patches = [
    {scopeKey: 'other'}, {source_protocol: 'library_selection_v1'}, {mode: 'missing'},
    {source: {kind: 'playlist', ref: id(1), revision: id(2)}}, {source: {kind: 'library', ref: 'bad', revision: id(2)}},
    {source: {kind: 'library', ref: id(1), revision: '1'}}, {entries_complete: false},
    {allowed_actions: {can_read: true}}, {allowed_actions: Object.create({can_read: true, can_use_for_playlist: true})},
    {library_mix: mixMetadata({selection_basis: 'per_album'})}, {library_mix: {...mixMetadata(), metric: 'personal_scrobbles'}},
    {entries: [row(1), row(1)]}, {entries: [row(1, {entry_ref: 'bad'})]},
    {entries: [row(1, {allowed_actions: {can_read: true, can_select: 'true'}})]},
    {entries: Array.from({length: 5001}, (_, i) => row(i))},
    {coverage: {selected_count: 2, excluded_count: 0}},
  ];
  for (const patch of patches) {
    const h = fixture({beginLibraryMix: async () => capture(patch)});
    assert.equal(await h.controller.prepare(recipe()), false);
    assert.equal(h.controller.getSnapshot().resource.status, 'error'); assert.equal(h.controller.source(), null);
    assert.equal(h.controller.canSave(), false); assert.equal(await h.controller.save(), false); assert.equal(h.calls.save.length, 0);
  }
});

test('empty resolved source is an honest zero-result preview with exclusions and refresh status', async () => {
  for (const status of ['queued', 'running', 'blocked', 'complete', 'invalid']) {
    const h = fixture({beginLibraryMix: async () => capture({entries: [], coverage: {selected_count: 0, excluded_count: 3}, popularity_refresh_status: status})});
    assert.equal(await h.controller.prepare(recipe()), true);
    assert.equal(h.controller.source().detail.track_rows.length, 0);
    assert.equal(h.controller.getSnapshot().popularityRefreshStatus, status === 'invalid' ? 'idle' : status);
  }
});

test('save captures exact source membership, title and chosen default once; generated membership never moves', async () => {
  const h = fixture(), c = h.controller; await c.prepare(recipe({auto_update: true}));
  assert.equal(c.edit({title: '  My mix  ', description: 'A description'}), true);
  assert.equal(c.setOrder('unplayed_first'), true);
  const result = await c.save(), options = h.calls.save[0];
  assert.equal(result.playlist_id, id(80)); assert.equal(c.getSnapshot().dirty, false);
  assert.deepEqual({...options, signal: null}, {scopeKey: SCOPE, source_protocol: 'library_mix_selection_v1', mode: 'ordinary',
    source: {kind: 'library', ref: id(1), revision: id(2)}, title: 'My mix', description: 'A description',
    entry_refs: [id(11), id(12), id(13)], mix_playback_order: 'unplayed_first', request_key: id(90), signal: null});
  assert.equal(c.source().recipe.auto_update, true); assert.equal(c.source().recipe.playback_order, 'regular');
  assert.equal(c.setOrder('shuffle'), false); assert.equal(c.edit({title: 'Changed'}), false);
  assert.equal(await c.save(), false); assert.equal(h.calls.save.length, 1);
});

test('blank/oversized metadata and invalid modes do not leak through save guards', async () => {
  const h = fixture(), c = h.controller; await c.prepare(recipe());
  assert.equal(c.edit({title: 'x'.repeat(101), description: 'x'.repeat(1001)}), false);
  assert.equal(c.setOrder('repeat_all'), false); c.edit({title: '   '});
  assert.equal(c.canSave(), false); assert.equal(await c.save(), false); assert.equal(h.calls.save.length, 0);
});

test('in-flight capture cannot double-submit or survive disposal, scope retirement or synchronous subscriber retirement', async () => {
  for (const invalidate of [h => h.controller.dispose(), h => h.retire()]) {
    const wait = deferred(), h = fixture({beginLibraryMix: () => wait.promise});
    const reading = h.controller.prepare(recipe()); assert.equal(await h.controller.prepare(recipe()), false);
    invalidate(h); wait.resolve(capture()); assert.equal(await reading, false); assert.equal(h.controller.source(), null);
  }
  const h = fixture(); h.controller.subscribe(() => h.controller.dispose());
  assert.equal(await h.controller.prepare(recipe()), false); assert.equal(h.calls.prepare.length, 0);
});

test('save failures remain unsaved; pending original command freezes edits and retry observes original receipt', async () => {
  const h = fixture({createPlaylistFromSelection: async () => {h.pending(true); throw new Error('Lost response');}}), c = h.controller;
  await c.prepare(recipe()); assert.equal(await c.save(), false); assert.equal(c.getSnapshot().mutation.status, 'error');
  assert.equal(c.getSnapshot().dirty, true); assert.equal(c.pendingSave(), true);
  assert.equal(c.edit({title: 'Wrong retry'}), false); assert.equal(c.setOrder('shuffle'), false); assert.equal(await c.save(), false);
  assert.equal((await c.retrySave()).playlist_id, id(80)); assert.equal(h.calls.retry.length, 1);
  assert.deepEqual(h.calls.retry[0], {scopeKey: SCOPE, action: 'create'}); assert.equal(c.getSnapshot().dirty, false);
});

test('save acknowledgements require exact scope/key and opaque saved identity; stale replies never publish success', async () => {
  for (const patch of [{scopeKey: 'other'}, {request_key: id(91)}, {playlist_id: 'bad'}]) {
    const h = fixture({createPlaylistFromSelection: async () => receipt(id(90), patch)});
    await h.controller.prepare(recipe()); assert.equal(await h.controller.save(), false);
    assert.equal(h.controller.getSnapshot().mutation.status, 'error'); assert.equal(h.controller.getSnapshot().dirty, true);
  }
  const wait = deferred(), h = fixture({createPlaylistFromSelection: () => wait.promise});
  await h.controller.prepare(recipe()); const saving = h.controller.save();
  assert.equal(h.controller.edit({title: 'Late'}), false); assert.equal(await h.controller.save(), false);
  h.retire(); wait.resolve(receipt()); assert.equal(await saving, false);
  assert.notEqual(h.controller.getSnapshot().mutation.status, 'ready');
});

test('saved model preserves verified recipe/default, refresh state, exact grants and ordinary compatibility', () => {
  const payload = {playlist_sidebar: {items: []}, playlist_detail: {playlist_id: id(80), playlist_kind: 'library_mix',
    revision: '1', items_complete: true, active_sort: {key: 'playlist_position', direction: 'asc'},
    library_mix: {...mixMetadata({auto_update: true, playback_order: 'shuffle'}), refresh_status: 'owner_refresh_required',
      coverage: {selected_count: 1, excluded_count: 4}}, popularity_refresh_status: 'queued',
    allowed_actions: {can_open: true, can_play: true, can_edit: true, can_add: false, can_reorder: false},
    track_rows: [{...row(1), playlist_item_id: id(11), play_count: null}]}};
  const detail = normalizePlaylistPayload(payload).detail;
  assert.equal(detail.library_mix.playback_order, 'shuffle'); assert.equal(detail.library_mix.auto_update, true);
  assert.equal(detail.library_mix.refresh_status, 'owner_refresh_required'); assert.equal(detail.library_mix.popularity_refresh_status, 'queued');
  assert.equal(detail.allowed_actions.can_add, false); assert.equal(detail.allowed_actions.can_reorder, false);
  assert.equal(detail.allowed_actions.can_edit, true); assert.equal(detail.track_rows[0].play_count, null);
  for (const patch of [{playlist_kind: 'ordinary'}, {library_mix: {...payload.playlist_detail.library_mix, provider: 'other'}},
    {library_mix: {...payload.playlist_detail.library_mix, version: 2}}]) {
    const normal = normalizePlaylistPayload({...payload, playlist_detail: {...payload.playlist_detail, ...patch}}).detail;
    assert.equal(Object.hasOwn(normal, 'library_mix'), false); assert.equal(normal.title, detail.title);
    assert.deepEqual(normal.track_rows, detail.track_rows); assert.deepEqual(normal.allowed_actions, detail.allowed_actions);
  }
});

// Loved uses the existing controller owner, with no Popular preparation endpoint.
const lovedDescriptor = patch => ({version: 1, root_artist_id: '9223372036854775807', scope_mode: 'family', ...patch});
const lovedRecipe = patch => ({...lovedDescriptor(), source: 'artist_loved', auto_update: true, playback_order: 'regular', ...patch});
function lovedCapture(patch = {}) {
  const value = capture({source_protocol: 'artist_loved_selection_v1', artist_loved: lovedRecipe(), ...patch});
  delete value.data.library_mix; delete value.data.coverage; delete value.data.popularity_refresh_status;
  return value;
}
function lovedController(overrides = {}, descriptor = lovedDescriptor()) {
  let current = true, pending = false;
  const calls = {capture: [], save: [], retry: []};
  const providers = {
    beginArtistLoved: async options => {calls.capture.push(options); return lovedCapture();},
    beginLibraryMix: () => assert.fail('Loved must not capture Popular'),
    beginArtistMix: () => assert.fail('Loved must not capture Artist Popular'),
    regenerateArtistMix: () => assert.fail('Loved must not regenerate Popular'),
    createPlaylistFromSelection: async options => {calls.save.push(options); return receipt(options.request_key, {creation_outcome: 'created'});},
    hasPendingPlaylistOperation: () => pending,
    retryPlaylistOperation: async options => {calls.retry.push(options); return receipt(id(90), {creation_outcome: 'existing'});},
    ...overrides,
  };
  const controller = createLibraryMixController({providers, scopeKey: SCOPE, artistLovedDescriptor: descriptor,
    isCurrent: () => current, requestKey: () => id(90)});
  return {controller, providers, calls, retire() {current = false;}, pending(value) {pending = value;}};
}
test('Loved controller captures once with exact bigint descriptor and no Popular recipe inputs', async () => {
  const h = lovedController(), c = h.controller;
  assert.equal(await c.prepare(), true);
  assert.deepEqual(h.calls.capture[0].descriptor, lovedDescriptor());
  assert.deepEqual(Object.keys(h.calls.capture[0]).sort(), ['descriptor', 'scopeKey', 'signal']);
  assert.equal(Object.isFrozen(h.calls.capture[0].descriptor), true);
  assert.equal(c.source().source_protocol, 'artist_loved_selection_v1');
  assert.deepEqual(c.source().artistLovedDescriptor, lovedDescriptor());
  assert.deepEqual(c.getSnapshot().artistLovedDescriptor, lovedDescriptor());
  assert.deepEqual(c.source().recipe, lovedRecipe());
  assert.equal(await c.prepare(recipe({songs_per_group: 1})), false);
  assert.equal(h.calls.capture.length, 1);
  assert.equal(c.setOrder('shuffle'), true); assert.equal(h.calls.capture.length, 1);
  assert.deepEqual(c.source().entry_refs, [id(11), id(12), id(13)]);
  assert.equal(c.source().recipe.playback_order, 'regular');
});
test('Loved controller rejects malformed or simultaneously supplied Popular scope', () => {
  for (const descriptor of [undefined, {}, lovedDescriptor({root_artist_id: 1}), lovedDescriptor({scope_mode: 'all'})]) {
    if (descriptor === undefined) continue;
    assert.throws(() => lovedController({}, descriptor), TypeError);
  }
  assert.throws(() => createLibraryMixController({providers: {}, scopeKey: SCOPE, isCurrent: () => true,
    artistLovedDescriptor: lovedDescriptor(), artistScope: {}}), TypeError);
});
test('Loved controller rejects wrong recipes, source tuples, grants and incomplete membership without empty success', async () => {
  for (const patch of [{artist_loved: lovedRecipe({root_artist_id: '2'})}, {artist_loved: lovedRecipe({scope_mode: 'artist'})},
    {artist_loved: lovedRecipe({auto_update: false})}, {artist_loved: lovedRecipe({playback_order: 'shuffle'})},
    {artist_loved: lovedRecipe({provider: 'lastfm'})}, {source_protocol: 'artist_popular_selection_v1'},
    {scopeKey: 'other'}, {mode: 'missing'}, {source: {kind: 'playlist', ref: id(1), revision: id(2)}},
    {entries_complete: false}, {entries: [row(1), row(1)]}, {entries: [row(1, {entry_ref: 'bad'})]},
    {allowed_actions: {can_read: true, can_use_for_playlist: 'true'}}, {entries: [row(1, {allowed_actions: {can_read: true}})]}]) {
    const h = lovedController({beginArtistLoved: async () => lovedCapture(patch)});
    assert.equal(await h.controller.prepare(), false);
    assert.equal(h.controller.source(), null); assert.equal(h.controller.canSave(), false);
    assert.equal(h.controller.getSnapshot().resource.status, 'error');
    assert.equal(await h.controller.save(), false); assert.equal(h.calls.save.length, 0);
  }
});
test('Loved empty captured membership can save with a complete ordinary command and retain created or existing ID', async () => {
  for (const outcome of ['created', 'existing']) {
    const h = lovedController({beginArtistLoved: async () => lovedCapture({entries: []}),
      createPlaylistFromSelection: async options => {h.calls.save.push(options); return receipt(options.request_key, {creation_outcome: outcome});}});
    const c = h.controller; assert.equal(await c.prepare(), true);
    assert.deepEqual(c.source().entry_refs, []); assert.equal(c.canSave(), true);
    c.edit({title: '  Empty loved family  ', description: 'Keep the recipe'}); c.setOrder('unplayed_first');
    const saved = await c.save(); assert.equal(saved.playlist_id, id(80)); assert.equal(saved.creation_outcome, outcome);
    assert.deepEqual({...h.calls.save[0], signal: null}, {scopeKey: SCOPE, source_protocol: 'artist_loved_selection_v1',
      mode: 'ordinary', source: {kind: 'library', ref: id(1), revision: id(2)}, title: 'Empty loved family',
      description: 'Keep the recipe', entry_refs: [], mix_playback_order: 'unplayed_first', request_key: id(90), signal: null});
    assert.equal(await c.save(), false); assert.equal(await c.prepare(), false); assert.equal(h.calls.save.length, 1);
  }
});
test('Loved uncertain command reconciles the original operation and refuses capture or resave', async () => {
  const h = lovedController({createPlaylistFromSelection: async options => {h.calls.save.push(options); h.pending(true); throw new Error('lost');}});
  const c = h.controller; await c.prepare(); assert.equal(await c.save(), false);
  assert.equal(c.pendingSave(), true); assert.equal(await c.prepare(), false); assert.equal(await c.save(), false);
  assert.equal(c.edit({title: 'New command'}), false);
  const saved = await c.retrySave(); assert.equal(saved.creation_outcome, 'existing'); assert.equal(saved.playlist_id, id(80));
  assert.deepEqual(h.calls.retry, [{scopeKey: SCOPE, action: 'create', request_key: id(90)}]); assert.equal(h.calls.save.length, 1);
});
test('Loved capture and save never publish after disposal, scope retirement or synchronous notification retirement', async () => {
  for (const invalidate of [h => h.retire(), h => h.controller.dispose()]) {
    const wait = deferred(), h = lovedController({beginArtistLoved: () => wait.promise});
    const pending = h.controller.prepare(); invalidate(h); wait.resolve(lovedCapture());
    assert.equal(await pending, false); assert.equal(h.controller.source(), null);
    const savedWait = deferred(), s = lovedController({createPlaylistFromSelection: () => savedWait.promise});
    await s.controller.prepare(); const saving = s.controller.save(); invalidate(s);
    savedWait.resolve(receipt(id(90), {creation_outcome: 'existing'})); assert.equal(await saving, false);
  }
  const h = lovedController(); h.controller.subscribe(() => h.controller.dispose());
  assert.equal(await h.controller.prepare(), false); assert.equal(h.calls.capture.length, 0);
});
test('Loved initial and reconciled receipts require exact created or existing discriminator', async () => {
  for (const creation_outcome of [undefined, null, '', 'saved', true]) {
    const h = lovedController({createPlaylistFromSelection: async () => receipt(id(90), {creation_outcome}),
      retryPlaylistOperation: async () => receipt(id(90), {creation_outcome})});
    await h.controller.prepare(); assert.equal(await h.controller.save(), false);
    assert.equal(h.controller.canSave(), false); assert.equal(await h.controller.save(), false);
    h.pending(true); assert.equal(await h.controller.retrySave(), false);
    assert.equal(h.controller.getSnapshot().dirty, true);
  }
});
test('saved Loved model retains typed status and locks membership without changing ordinary metadata grants', () => {
  for (const refresh_status of ['current', 'unavailable', 'too_large', 'last_computed', 'owner_refresh_required']) {
    const artist_loved = lovedRecipe({last_evaluated_at: '2026-10-18T00:00:00Z', root_state: 'present', refresh_status});
    const input = {playlist_sidebar: {items: []}, playlist_detail: {playlist_id: id(80), revision: '1',
      playlist_kind: 'artist_loved', artist_loved, track_rows: [], items_complete: true,
      allowed_actions: {can_open: true, can_edit: true, can_share: true, can_add: false, can_reorder: false}}};
    const detail = normalizePlaylistPayload(input).detail;
    assert.equal(detail.playlist_kind, 'artist_loved'); assert.deepEqual(detail.artist_loved, artist_loved);
    assert.equal(Object.hasOwn(detail, 'library_mix'), false);
    assert.equal(detail.allowed_actions.can_edit, true); assert.equal(detail.allowed_actions.can_share, true);
    assert.equal(detail.allowed_actions.can_add, false); assert.equal(detail.allowed_actions.can_reorder, false);
    for (const patch of [{artist_loved: {...artist_loved, root_artist_id: '01'}}, {library_mix: mixMetadata()},
      {playlist_kind: 'ordinary'}, {artist_loved: {...artist_loved, refresh_status: 'fresh'}}]) {
      assert.throws(() => normalizePlaylistPayload({...input, playlist_detail: {...input.playlist_detail, ...patch}}), TypeError);
    }
  }
});

test('Loved uncertain receipt cannot reconcile a different request key even from a custom provider', async () => {
  const h = lovedController({createPlaylistFromSelection: async () => receipt(id(90), {creation_outcome: 'unknown'}),
    retryPlaylistOperation: async () => receipt(id(91), {creation_outcome: 'existing'})});
  await h.controller.prepare(); assert.equal(await h.controller.save(), false);
  assert.equal(h.controller.pendingSave(), true); assert.equal(await h.controller.retrySave(), false);
  assert.equal(h.controller.pendingSave(), true); assert.equal(h.controller.canSave(), false);
  assert.equal(h.controller.getSnapshot().dirty, true);
});
