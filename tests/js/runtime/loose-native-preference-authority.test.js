// Genuine browse read -> existing exact-object owner -> actual Loose renderer ->
// NativePlaytables adapter -> shared Love controller. Synthetic transport only.
// No browser, production authentication, server or persistence claim.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {createLooseAuthorityFixture, looseRow, browsePayload, overlay, outcome, repositoryRoot} = require('./shared-request-unit-fixture.cjs').looseAuthority();
const copy = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
let preferences, selection;
nodeTest.before(async () => {
  preferences = await import(pathToFileURL(path.join(repositoryRoot, 'music_app/static/js/home-friends/track-preference.mjs')).href);
  selection = await import(pathToFileURL(path.join(repositoryRoot, 'music_app/static/js/playtables/selection.mjs')).href);
});

function fixture() {
  const f = createLooseAuthorityFixture(), mounts = [], played = [], queued = [], resolvedPrivateRows = [];
  const modal = {isConnected: true, hidden: false}, host = {querySelectorAll: () => []};
  f.nodes.set('non-album-modal', modal);
  Object.assign(f.context, {
    formatTrackDuration: seconds => `${seconds}s`, formatAlbumDuration: seconds => `${seconds}s`,
    getPlayerPlaybackSnapshot: () => ({paused: true, ended: false}), getProblematicAlbumForTrackPath: () => null,
    activateSharedTrackButton: (...args) => played.push(args),
    captureNativeLooseQueueSources: (source, rows) => {queued.push({source, rows}); return [];},
    openUtilityChoiceDropdown() {},
  });
  f.context.window.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'loose-own-ui-scope'})};
  f.context.window.AlbumHavenPlaytableUI = {mount(target, options) {
    const mount = {host: target, options, disposed: 0, updates: [],
      dispose() {this.disposed++;}, update(next) {if (next) {this.options = {...this.options, ...next}; this.updates.push(next);}}};
    mounts.push(mount); return mount;
  }};
  vm.runInContext(fs.readFileSync(path.join(repositoryRoot, 'music_app/static/js/button-component.js'), 'utf8'), f.context,
    {filename: 'button-component.js'});
  f.context.ButtonComponent = f.context.window.ButtonComponent;
  for (const file of ['markup-format-helpers.js', 'compact-data-table.js', 'album-track-table.js',
    'playtable-source.js', 'modal-and-overlay-helpers.js']) f.loadRuntime(file);
  const native = vm.runInContext('NativePlaytables', f.context);
  const genuineSource = f.context.getTrackModalPreferenceSource;
  f.context.getTrackModalPreferenceSource = row => {resolvedPrivateRows.push(row); return genuineSource(row);};
  function render(items = f.state.view.non_album_tracks, target = host) {
    const before = f.batches.length, html = f.context.buildNonAlbumTrackSectionsMarkup(items);
    assert.equal(native.mount('loose-tracks', target), true);
    assert.equal(f.batches.length, before, 'normalization, rendering and mounting consume receipts; none admits reads');
    const mount = mounts.at(-1);
    return {html, options: mount.options, mount};
  }
  function controller(options) {
    const adapter = options.trackPreferences;
    assert.ok(adapter, 'accepted own Loose response must reach the existing native preference adapter');
    const runtime = {...options.runtime, ...adapter.runtime};
    const view = {runtime, rows: adapter.rows, context: adapter.context, source: options.sourceAdapter,
      isCurrent: () => Boolean(options.sourceAdapter.snapshot())};
    const errors = [], changes = [];
    const control = preferences.createTrackPreferenceController({getView: () => view,
      onError: value => errors.push(value), onChange: () => changes.push(true)});
    const unsubscribe = runtime.subscribeTrackPreferences(() => control.sync());
    return {control, runtime, rows: adapter.rows, context: adapter.context, errors, changes, view,
      dispose() {unsubscribe(); control.cancel();}};
  }
  function acknowledge(index, tier = 'loved') {
    const request = f.requests[index], body = JSON.parse(request.options.body);
    f.respond(index, {ok: true, actor_id: '7', library_id: 9, track_ref: body.track_ref,
      track_preference: overlay(tier)});
  }
  return {...f, native, mounts, modal, host, played, queued, resolvedPrivateRows, render, controller, acknowledge};
}
function known(mount) {
  const result = mount.options.trackPreferences;
  assert.ok(result, 'Loose must share the native Album preference bridge after genuine admission');
  return result;
}
function value(adapter, index = 0) {return adapter.runtime.trackPreference(adapter.rows[index], adapter.context);}
async function denyCurrent(f, status = 403) {
  const index = f.requests.length, pending = f.read();
  f.respond(index, {ok: false, error: 'Synthetic source denial'}, status); await pending;
}
async function albumChurn(f, prefix, start = 500) {
  const limit = vm.runInContext('TRACK_MODAL_HYDRATED_ALBUM_DETAILS_LIMIT', f.context);
  for (let offset = 0; offset <= limit; offset++) {
    const key = `${prefix}-${offset}`, row = looseRow(start + offset);
    const index = f.requests.length, pending = f.context.fetchTrackModalAlbumDetails(key);
    f.respond(index, {ok: true, album: {key, tracks: [row]}}); await pending;
  }
}

test('Frozen response rows survive real normalization, compaction and private Loose mapping by exact identity', async () => {
  const f = fixture(), rows = [looseRow(101, {exception_type: 'Interview'}),
    looseRow(102, {exception_type: 'Non-album rarity'})], payload = freeze(browsePayload(rows));
  const before = JSON.stringify(payload);
  await f.load(payload);
  const sink = f.context.applyViewPayload;
  f.loadRuntime('response-state-helpers.js'); f.context.applyViewPayload = sink;
  const normalized = f.context.compactRuntimeViewPayload(f.context.normalizeViewPayload(payload));
  rows.forEach((row, index) => assert.equal(normalized.non_album_tracks[index], row,
    'DTO compaction must preserve exact receipt-bearing rows, not transfer receipts to clones'));
  f.state.view = normalized;
  const adapter = known(f.render()), expected = [rows[1], rows[0]];
  f.resolvedPrivateRows.length = 0;
  for (let index = 0; index < expected.length; index++) {
    assert.equal(value(adapter, index).love_tier, 'off');
    assert.equal(f.resolvedPrivateRows.at(-1), expected[index], 'section sorting maps to the exact admitted private row');
  }
  assert.equal(JSON.stringify(payload), before);
  assert.ok(rows.every(Object.isFrozen));
  assert.equal(Object.hasOwn(rows[0], 'track_ref'), false, 'path fallback stays inside the receipt owner');
  const publicData = JSON.stringify({rows: adapter.rows, context: adapter.context,
    values: adapter.rows.map((_, index) => value(adapter, index))});
  assert.doesNotMatch(publicData, /\/synthetic\/|inventory-track:|canonical_track_ref|track_ref|nativeAccountId/);
});

test('Unadmitted bootstrap and copied grants remain unknown through normalization and open', async () => {
  const f = fixture(), payload = freeze(browsePayload([looseRow(111)]));
  f.state.view = payload;
  const unadmitted = f.render();
  assert.match(unadmitted.html, /aria-label="Love unavailable"/);
  assert.doesNotMatch(unadmitted.html, /data-track-love="1"|love-off/);
  assert.equal(f.source(payload.non_album_tracks[0]), null);
  assert.equal(f.batches.length, 0); assert.equal(f.requests.length, 0);
  await f.load(browsePayload([looseRow(111)]));
  const admitted = known(f.render()); assert.equal(value(admitted).love_tier, 'off');
  for (const clone of [copy(f.state.view.non_album_tracks[0]), {...f.state.view.non_album_tracks[0], title: 'Optimistic title'}]) {
    f.state.view = browsePayload([clone]);
    const mounted = f.render(), adapter = known(mounted);
    assert.equal(value(adapter), null, 'JSON or optimistic edit clone has no exact own read receipt');
    await assert.rejects(adapter.runtime.setTrackLove({row: adapter.rows[0], context: adapter.context, love_tier: 'loved'}));
  }
  assert.equal(f.requests.length, 1, 'restoring copies never fetches or dispatches preference commands');
});

for (const [tier, writable] of [['off', true], ['loved', true], ['obsessed', false]]) {
  test(`Known Loose ${tier}, writable=${writable}, uses shared Love paint and behavior`, async () => {
    const f = fixture(); await f.load(freeze(browsePayload([looseRow(121, {track_preference: overlay(tier, writable)})])));
    const mounted = f.render(), ui = f.controller(mounted.options), row = ui.rows[0], state = ui.control.get(row);
    assert.equal(state.preference.love_tier, tier); assert.equal(state.editable, writable);
    const html = preferences.trackLoveHtml(ui.runtime, row, state);
    assert.doesNotMatch(html, /Love unavailable/);
    assert.match(html, new RegExp(`data-love-tier="${tier}"`));
    if (writable) assert.match(html, /<button/);
    else {
      assert.doesNotMatch(html, /<button|data-track-love="1"/);
      assert.match(html, /role="img" aria-label="Obsessed"/);
      assert.equal(await ui.control.cycle(row), false);
      assert.equal(f.requests.length, 1);
    }
    ui.dispose();
  });
}

test('Loose aliases share one pending command and acknowledgement without playback or selection changes', async () => {
  const f = fixture(), raw = looseRow(131), alias = looseRow(131, {track_ref: raw.canonical_track_ref,
    path: '/synthetic/loose-authority/alias-131.flac', exception_type: 'Interview'});
  await f.load(freeze(browsePayload([raw, alias])));
  const mounted = f.render(), ui = f.controller(mounted.options), [first, second] = ui.rows;
  const owner = selection.createPlaytableSelection({sourceAdapter: mounted.options.sourceAdapter, tableKey: 'loose-tracks'});
  owner.select(first.rowKey, {toggle: true}); const selected = copy(owner.getSnapshot());
  assert.equal(ui.control.get(first).preference.identity, ui.control.get(second).preference.identity);
  const pending = ui.control.cycle(first);
  assert.equal(ui.control.get(first).pending, true); assert.equal(ui.control.get(second).pending, true);
  assert.equal(await ui.control.cycle(second), false); await turn();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].url, '/track-preferences');
  assert.deepEqual(JSON.parse(f.requests[1].options.body), {track_ref: raw.canonical_track_ref, track_preference: {love_tier: 'loved'}});
  for (const row of ui.rows) {
    assert.equal(ui.control.get(row).preference.love_tier, 'off', 'pending never invents acknowledgement');
    const html = preferences.trackLoveHtml(ui.runtime, row, ui.control.get(row));
    assert.match(html, /disabled/); assert.match(html, /aria-busy="true"/);
  }
  f.acknowledge(1); assert.equal(await pending, true);
  assert.ok(ui.rows.every(row => ui.control.get(row).preference.love_tier === 'loved'));
  assert.ok(ui.rows.every(row => !ui.control.get(row).pending));
  assert.deepEqual(copy(owner.getSnapshot()), selected);
  assert.deepEqual(f.played, []); assert.deepEqual(f.queued, []); assert.deepEqual(ui.errors, []);
  owner.dispose(); ui.dispose();
});

test('Same-title Loose rows remain distinct canonical identities and mutation targets', async () => {
  const f = fixture(); await f.load(browsePayload([looseRow(141, {title: 'Shared title'}), looseRow(142, {title: 'Shared title'})]));
  const ui = f.controller(f.render().options), [first, second] = ui.rows;
  assert.notEqual(ui.control.get(first).preference.identity, ui.control.get(second).preference.identity);
  const pending = ui.control.cycle(first); await turn();
  assert.equal(ui.control.get(second).pending, false);
  assert.equal(JSON.parse(f.requests[1].options.body).track_ref, 'track:loose-authority-141');
  f.acknowledge(1); assert.equal(await pending, true);
  assert.equal(ui.control.get(second).preference.love_tier, 'off'); ui.dispose();
});

for (const denialFirst of [false, true]) {
  test(`Loose same-batch alias denial wins in either order (${denialFirst})`, async () => {
    const f = fixture(), grant = looseRow(151), denial = looseRow(151,
      {track_ref: grant.canonical_track_ref, track_preference: overlay('obsessed', false)});
    const rows = denialFirst ? [denial, grant] : [grant, denial];
    rows.push(looseRow(152, {track_preference: overlay('loved')}));
    await f.load(freeze(browsePayload(rows)));
    const adapter = known(f.render());
    assert.equal(value(adapter, 0).identity, value(adapter, 1).identity);
    for (const index of [0, 1]) {
      assert.equal(value(adapter, index).love_tier, 'obsessed');
      assert.equal(value(adapter, index).allowed_actions.can_set_love_tier, false);
      await assert.rejects(adapter.runtime.setTrackLove({row: adapter.rows[index], context: adapter.context, love_tier: 'loved'}));
    }
    assert.equal(value(adapter, 2).love_tier, 'loved');
    assert.equal(value(adapter, 2).allowed_actions.can_set_love_tier, true);
    assert.equal(f.batches.length, 1); assert.equal(f.requests.length, 1);
  });
}

test('Current denial notifies mounted Loose consumers; close, cache restore and mobile rehost cannot revive it', async () => {
  const f = fixture(), payload = await f.load(browsePayload([looseRow(161)])), mounted = f.render(), adapter = known(mounted);
  let notifications = 0;
  const unsubscribe = adapter.runtime.subscribeTrackPreferences(() => {notifications++;});
  assert.equal(value(adapter).allowed_actions.can_set_love_tier, true);
  await denyCurrent(f);
  assert.ok(notifications > 0, 'source receipt revocation must reach mounted subscribers');
  assert.equal(value(adapter), null); assert.equal(f.source(payload.non_album_tracks[0]), null);
  f.native.retire('loose-tracks'); f.modal.hidden = true; f.modal.hidden = false;
  f.state.view = payload;
  const reopened = known(f.render()); assert.equal(value(reopened), null);
  const mobile = known(f.render(payload.non_album_tracks, {querySelectorAll: () => []}));
  assert.equal(value(mobile), null);
  assert.equal(f.requests.length, 2, 'open, restore and rehost are receipt consumers only');
  await assert.rejects(mobile.runtime.setTrackLove({row: mobile.rows[0], context: mobile.context, love_tier: 'loved'}));
  assert.equal(f.requests.length, 2); unsubscribe();
  const fresh = await f.load(browsePayload([looseRow(161, {track_preference: overlay('loved')})]));
  assert.equal(value(known(f.render())).love_tier, 'loved');
  assert.equal(f.source(payload.non_album_tracks[0]), null, 'new grant cannot revive an old revoked object');
  assert.ok(f.source(fresh.non_album_tracks[0]));
});

for (const change of ['actor', 'transport', 'inventory', 'mapping', 'row-facts', 'close']) {
  test(`Loose ${change} replacement rejects a late acknowledgement and stale public commands`, async () => {
    const f = fixture(), payload = await f.load(browsePayload([looseRow(171)])), mounted = f.render(), adapter = known(mounted);
    const row = adapter.rows[0], command = {row, context: adapter.context, love_tier: 'loved'};
    const pending = outcome(adapter.runtime.setTrackLove(command));
    assert.equal(f.requests.length, 2);
    if (change === 'actor') f.shell.dataset.nativeAccountId = '8';
    if (change === 'transport') f.changeSession();
    if (change === 'inventory') f.state.status.inventory_mutation_revision++;
    if (change === 'mapping') f.render();
    if (change === 'row-facts') payload.non_album_tracks[0].canonical_track_ref = 'track:changed';
    if (change === 'close') {f.modal.hidden = true; f.native.retire('loose-tracks');}
    f.acknowledge(1);
    assert.ok((await pending).error, 'retired mapping cannot publish its old transport acknowledgement');
    assert.equal(value(adapter), null);
    await assert.rejects(adapter.runtime.setTrackLove(command));
    assert.equal(f.requests.length, 2);
  });
}

test('Copied public row and foreign UI context cannot address the private Loose mapping', async () => {
  const f = fixture(); await f.load(browsePayload([looseRow(181)]));
  const adapter = known(f.render()), row = adapter.rows[0];
  assert.equal(adapter.runtime.trackPreference({...row}, adapter.context), null);
  assert.equal(adapter.runtime.trackPreference(row, {...adapter.context, scopeKey: 'foreign'}), null);
  await assert.rejects(adapter.runtime.setTrackLove({row: {...row}, context: adapter.context, love_tier: 'loved'}));
  await assert.rejects(adapter.runtime.setTrackLove({row, context: {scopeKey: 'foreign'}, love_tier: 'loved'}));
  assert.equal(f.requests.length, 1);
});

test('Cancelling Loose UI cannot release its dispatched alias lock; stale settlement requires a fresh read', async () => {
  const f = fixture(), initial = await f.load(browsePayload([looseRow(191)])), mounted = f.render(), adapter = known(mounted);
  const controller = new AbortController(), first = outcome(adapter.runtime.setTrackLove({row: adapter.rows[0],
    context: adapter.context, love_tier: 'loved', signal: controller.signal}));
  controller.abort();
  const replacement = await f.load(browsePayload([looseRow(191)])), next = known(f.render());
  await assert.rejects(next.runtime.setTrackLove({row: next.rows[0], context: next.context, love_tier: 'obsessed'}));
  assert.equal(f.requests.length, 3, 'UI cancellation and replacement do not unlock an unsettled write');
  f.acknowledge(1); assert.ok((await first).error);
  assert.equal(f.preference(initial.non_album_tracks[0]), null);
  assert.equal(f.preference(replacement.non_album_tracks[0]), null, 'read begun before settlement is stale');
  await assert.rejects(next.runtime.setTrackLove({row: next.rows[0], context: next.context, love_tier: 'loved'}));
  await f.load(browsePayload([looseRow(191, {track_preference: overlay('loved')})]));
  assert.equal(value(known(f.render())).love_tier, 'loved');
});

test('Unmounted Loose tokens share the existing bounded owner and cannot be recreated by retained DTOs', async () => {
  const f = fixture(), oldest = await f.load(browsePayload([looseRow(201)]));
  assert.ok(f.source(oldest.non_album_tracks[0]));
  await albumChurn(f, 'loose-unmounted');
  assert.equal(f.source(oldest.non_album_tracks[0]), null, 'unretained old source expires at the existing shared bound');
  f.state.view = oldest;
  assert.equal(value(known(f.render())), null, 'rendering an expired exact object cannot recreate its receipt');
});

test('Mounted Loose pins genuine receipts, same-source reprepare transfers once, and final retirement releases', async () => {
  const f = fixture(), active = await f.load(browsePayload([looseRow(211)])), initial = f.render();
  assert.equal(value(known(initial)).love_tier, 'off');
  await albumChurn(f, 'while-loose-mounted', 600);
  assert.ok(f.source(active.non_album_tracks[0]));
  const repeated = f.render();
  assert.equal(repeated.mount, initial.mount, 'same resource retains its mounted Choice owner');
  assert.equal(value(known(initial)), null, 'old public mapping is retired even when the mount survives');
  assert.ok(f.source(active.non_album_tracks[0]), 'retain replacement before releasing old ownership');
  await albumChurn(f, 'after-loose-reprepare', 700);
  assert.ok(f.source(active.non_album_tracks[0]));
  f.native.retire('loose-tracks'); f.native.retire('loose-tracks');
  await albumChurn(f, 'after-loose-retirement', 800);
  assert.equal(f.source(active.non_album_tracks[0]), null, 'reprepare must not leak a retained token');
});

test('Valid exact Loose receipts survive close and mobile rehost without fresh admission', async () => {
  const f = fixture(), payload = await f.load(freeze(browsePayload([looseRow(221)]))), first = f.render(), adapter = known(first);
  const batches = f.batches.length;
  f.native.retire('loose-tracks'); f.modal.hidden = true;
  assert.equal(value(adapter), null, 'closed adapter is retired even when exact receipt remains valid');
  f.modal.hidden = false;
  const reopened = known(f.render()); assert.equal(value(reopened).love_tier, 'off');
  const rehosted = known(f.render(payload.non_album_tracks, {querySelectorAll: () => []}));
  assert.equal(value(rehosted).love_tier, 'off'); assert.equal(value(reopened), null);
  assert.equal(f.batches.length, batches); assert.equal(f.requests.length, 1);
});

test('Album and Loose source denial namespaces stay distinct while sharing native track identities', async () => {
  const f = fixture(), loose = looseRow(231);
  await f.load(browsePayload([loose]));
  const adapter = known(f.render()), key = '/view-data?surface=albums', albumRow = looseRow(231);
  let index = f.requests.length, pending = f.context.fetchTrackModalAlbumDetails(key);
  f.respond(index, {ok: true, album: {key, tracks: [albumRow]}}); await pending;
  assert.equal(f.preference(albumRow).identity, value(adapter).identity);
  index = f.requests.length; pending = outcome(f.context.fetchTrackModalAlbumDetails(key));
  f.respond(index, {ok: false}, 403); await pending;
  assert.equal(f.source(albumRow), null); assert.ok(f.source(loose));
  assert.equal(value(adapter).love_tier, 'off', 'denied Album container cannot retire unrelated Loose provenance');
  const freshAlbumRow = looseRow(231);
  index = f.requests.length; pending = f.context.fetchTrackModalAlbumDetails(key);
  f.respond(index, {ok: true, album: {key, tracks: [freshAlbumRow]}}); await pending;
  await denyCurrent(f);
  assert.equal(f.source(loose), null); assert.ok(f.source(freshAlbumRow), 'Loose denial stays in its own source namespace');
});
