const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const Module = require('node:module');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const root = path.resolve(__dirname, '../../..');
const sourceRoot = path.join(root, 'music_app/static/js/home-friends');
const model = import(pathToFileURL(path.join(sourceRoot, 'detail-projection.mjs')));
const built = buildSync({entryPoints: [path.join(sourceRoot, 'detail-projection.jsx')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react']});
const compiled = new Module(__filename + '.details', module);
compiled.filename = __filename + '.details'; compiled.paths = module.paths;
compiled._compile(built.outputFiles[0].text, compiled.filename);
const {DetailProjectionPanel, detailDuration} = compiled.exports;
const env = createNativeHomeRuntime();
for (const file of ['compact-data-table.js', 'album-details-components.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js/runtime', file), 'utf8'), env.context);
}
const runtime = {escapeHtml: env.context.escapeHtml, buttonHtml: env.context.ButtonComponent.renderButton,
  actionHtml: env.context.ButtonComponent.renderActionButton, alertHtml: env.context.buildOnPageAlertHtml,
  tableHtml: env.context.buildCompactDataTable, artboxHtml: env.context.buildAlbumArtboxHtml,
  detailHeaderHtml: env.context.buildAlbumDetailsHeaderHtml, artistInfoHtml: env.context.buildArtistInfoOverlayHtml,
  galleryCardHtml: env.context.buildGalleryCardHtml};

// Fixtures exist only in this test module. Production has no default provider.
const selection = (kind = 'album', ref = 'album:one', allowed_actions = {can_view_details: true}) => ({kind, ref, allowed_actions});
const album = (ref = 'album:one', overrides = {}) => ({kind: 'album', ref, title: 'Album <one>', artist: 'Artist',
  metadata_state: 'current', year: '2026', release_type: 'EP', summary: 'Provider supplied information.', artwork_url: '/art/cover-one',
  track_count: 2, duration_seconds: 121,
  tracks: [{id: 'row:one', title: '<Track>', artist: 'Guest', track_number: 1, disc_number: 1, duration_seconds: 121}], ...overrides});
const artist = (overrides = {}) => ({kind: 'artist', ref: 'artist:one', title: 'Artist', metadata_state: 'last_known',
  summary: 'Known biography.', release_count: null,
  discography: [{id: 'release:one', title: '<Release>', year: '', release_type: '', metadata_state: 'last_known', artwork_url: '/art/release-one'}], ...overrides});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function controller(readDetail, target = selection()) {
  const {createDetailProjectionController} = await model;
  const value = createDetailProjectionController({readDetail}); value.setScope('account/library'); value.select(target); return value;
}
async function render(data, target = selection()) {
  const {normalizeDetailResult} = await model;
  return renderToStaticMarkup(React.createElement(DetailProjectionPanel, {runtime, selection: target, value: normalizeDetailResult(data, target)}));
}

test('detail source grants are exact, own booleans and independent from history or native actions', async () => {
  let calls = 0;
  for (const allowed_actions of [{}, {can_view_activity: true}, {can_compare: true}, {can_open_album: true},
    {can_view_details: 'true'}, {can_view_details: 1}, Object.create({can_view_details: true})]) {
    const c = await controller(() => {calls++; return album();}, selection('album', 'album:one', allowed_actions));
    assert.equal((await c.load()).status, 'denied'); assert.equal(c.getSnapshot().detail.data, null);
  }
  assert.equal(calls, 0);
});
test('missing provider, scope or valid selection never invents details', async () => {
  const {createDetailProjectionController} = await model;
  const c = await controller(); assert.equal((await c.load()).status, 'unavailable');
  let calls = 0; const unscoped = createDetailProjectionController({readDetail: () => {calls++; return album();}});
  unscoped.select(selection()); assert.equal((await unscoped.load()).status, 'unavailable');
  unscoped.setScope('scope');
  for (const value of [null, {}, selection('track'), selection('album', ''), selection('album', 'a\n')]) {
    assert.equal(unscoped.select(value), false); assert.equal((await unscoped.load()).status, 'unavailable');
  }
  assert.equal(calls, 0);
});
test('authorized detail reads pass only scope kind ref and abort signal', async () => {
  let args;
  const c = await controller(value => {args = value; return album();});
  assert.equal((await c.load()).status, 'ready');
  assert.deepEqual(Object.keys(args).sort(), ['kind', 'ref', 'scopeKey', 'signal']);
  assert.equal(args.scopeKey, 'account/library'); assert.equal(args.ref, 'album:one'); assert.equal(args.kind, 'album');
  assert.ok(args.signal instanceof AbortSignal);
});
test('whitelist excludes raw native media, identity overrides and unapproved fields', async () => {
  const {normalizeDetailResult} = await model;
  const data = normalizeDetailResult(album('album:one', {path: '/private/album', cover_path: '/private/cover',
    account_ref: 'other', allowed_actions: {can_play_album: true}, secret: 'not retained',
    tracks: [{id: 'display-row', title: 'Visible', path: '/private/track', src: '/track?path=secret',
      track_ref: '/private/track', playback_state: {is_playing: true}, can_edit_preferences: true}]}), selection()).data;
  assert.equal(data.path, undefined); assert.equal(data.cover_path, undefined); assert.equal(data.account_ref, undefined);
  assert.equal(data.allowed_actions, undefined); assert.equal(data.secret, undefined);
  assert.deepEqual(Object.keys(data.tracks[0]).sort(), ['artist', 'disc_number', 'duration_seconds', 'id', 'title', 'track_number']);
  assert.doesNotMatch(JSON.stringify(data), /private|track_ref|playback_state|can_edit_preferences|secret/);
  assert.ok(Object.isFrozen(data)); assert.ok(Object.isFrozen(data.tracks)); assert.ok(Object.isFrozen(data.tracks[0]));
});
test('known zero, missing numeric data and freshness remain different', async () => {
  const {normalizeDetailResult} = await model;
  const data = normalizeDetailResult(album('album:one', {track_count: 0, duration_seconds: '0', metadata_state: 'stale',
    tracks: [{id: 'one', title: '', duration_seconds: 0, track_number: null, disc_number: -1}]}), selection()).data;
  assert.equal(data.track_count, 0); assert.equal(data.duration_seconds, null); assert.equal(data.metadata_state, 'unknown');
  assert.equal(data.tracks[0].duration_seconds, 0); assert.equal(data.tracks[0].track_number, null); assert.equal(data.tracks[0].disc_number, null);
  assert.equal(detailDuration(0), '0:00'); assert.equal(detailDuration(121), '2:01');
  for (const value of [null, undefined, '0', false, -1, Infinity, NaN]) assert.equal(detailDuration(value), 'Unknown');
});
test('unsafe artwork is discarded rather than converted to media or a default image', async () => {
  const {normalizeDetailResult} = await model;
  for (const artwork_url of ['https://other.test/art', '//other.test/a', 'data:image/png;base64,abc', 'file:///a', '/\\other/a', '/a b', 'javascript:alert(1)', null]) {
    assert.equal(normalizeDetailResult(album('album:one', {artwork_url}), selection()).data.artwork_url, null);
  }
});
test('read permission does not synthesize optional native action references', async () => {
  const {normalizeDetailResult} = await model;
  assert.equal(normalizeDetailResult(album(), selection()).data.native_actions, null);
  const native_actions = {album_ref: 'native:one', allowed_actions: {can_open_album: true, can_play_album: 'true', can_edit: true}};
  const data = normalizeDetailResult(album('album:one', {native_actions}), selection()).data;
  assert.deepEqual(data.native_actions, {album_ref: 'native:one', allowed_actions: {can_open_album: true, can_play_album: false}});
  const inherited = {album_ref: 'native:one', allowed_actions: Object.create({can_open_album: true, can_play_album: true})};
  assert.equal(normalizeDetailResult(album('album:one', {native_actions: inherited}), selection()).data.native_actions.allowed_actions.can_open_album, false);
});
test('empty collections, unknown collections and empty resource are distinct', async () => {
  const {normalizeDetailResult} = await model;
  assert.deepEqual(normalizeDetailResult({status: 'empty', data: null}, selection()), {status: 'empty', data: null});
  assert.deepEqual(normalizeDetailResult(album('album:one', {tracks: []}), selection()).data.tracks, []);
  assert.equal(normalizeDetailResult(album('album:one', {tracks: undefined}), selection()).data.tracks, null);
  assert.throws(() => normalizeDetailResult({status: 'empty', data: album()}, selection()), TypeError);
});
test('malformed, duplicate and mismatched response identities fail closed', async () => {
  const {normalizeDetailResult} = await model;
  assert.throws(() => normalizeDetailResult({kind: 'track', ref: 'one'}, {kind: 'track', ref: 'one'}), TypeError);
  for (const data of [null, {}, album('album:other'), artist(), album('album:one', {tracks: {}}),
    album('album:one', {tracks: [{id: 'same'}, {id: 'same'}]}), album('album:one', {tracks: [null]}),
    {status: 'unknown', data: album()}, {status: 'ready', data: []}]) {
    const c = await controller(() => data); assert.equal((await c.load()).status, 'error'); assert.equal(c.getSnapshot().detail.data, null);
  }
  const c = await controller(() => artist({discography: [{id: 'same'}, {id: 'same'}]}), selection('artist', 'artist:one'));
  assert.equal((await c.load()).status, 'error');
});
test('denied and unavailable response data is erased; service errors are never retained', async () => {
  for (const status of ['denied', 'unavailable']) {
    const c = await controller(() => ({status, data: album()})); assert.deepEqual(await c.load(), {status, data: null});
  }
  for (const [error, status] of [[Object.assign(new Error('private service data'), {status: 403}), 'denied'],
    [Object.assign(new Error('private service data'), {status: 401}), 'denied'], [new Error('private service data'), 'error'],
    [Object.assign(new Error('private service data'), {name: 'AbortError'}), 'unavailable']]) {
    const c = await controller(() => {throw error;}); assert.deepEqual(await c.load(), {status, data: null});
    assert.doesNotMatch(JSON.stringify(c.getSnapshot()), /private service data/);
  }
});
test('new selection aborts previous read and ignores late resolution and rejection', async () => {
  for (const rejected of [false, true]) {
    const first = deferred(); let signal;
    const c = await controller(args => args.ref === 'album:one' ? (signal = args.signal, first.promise) : album('album:two'));
    const pending = c.load(); c.select(selection('album', 'album:two')); assert.equal(signal.aborted, true);
    await c.load(); rejected ? first.reject(new Error('late')) : first.resolve(album()); await pending;
    assert.equal(c.getSnapshot().detail.data.ref, 'album:two');
  }
});
test('scope reset aborts and erases metadata before another account can select', async () => {
  const pending = deferred(); let signal;
  const c = await controller(args => (signal = args.signal, pending.promise));
  const reading = c.load(); c.setScope('another/account'); assert.equal(signal.aborted, true);
  assert.equal(c.getSnapshot().selection, null); assert.equal(c.getSnapshot().detail.data, null);
  pending.resolve(album()); await reading; assert.equal(c.getSnapshot().detail.status, 'unavailable');
});
test('refresh clears previous metadata and supersedes a pending same-resource read', async () => {
  const pending = deferred(); let reads = 0, signal;
  const c = await controller(args => ++reads === 2 ? (signal = args.signal, pending.promise) : album());
  await c.load(); const second = c.load(); assert.deepEqual(c.getSnapshot().detail, {status: 'loading', data: null});
  await c.load(); assert.equal(signal.aborted, true); pending.resolve(album('album:one', {title: 'stale'})); await second;
  assert.equal(c.getSnapshot().detail.data.title, 'Album <one>');
});
test('grant revocation immediately clears ready data and cancels pending read', async () => {
  const pending = deferred(); let signal, reads = 0;
  const c = await controller(args => ++reads === 1 ? album() : (signal = args.signal, pending.promise));
  await c.load(); c.select(selection('album', 'album:one', {can_view_details: false}));
  assert.deepEqual(c.getSnapshot().detail, {status: 'denied', data: null});
  c.select(selection()); const reading = c.load(); c.select(selection('album', 'album:one', {can_view_details: false}));
  assert.equal(signal.aborted, true); assert.deepEqual(c.getSnapshot().detail, {status: 'denied', data: null});
  pending.resolve(album()); await reading; await c.load(); assert.equal(reads, 2); assert.equal(c.getSnapshot().detail.data, null);
});
test('provider replacement clears grants and late responses; unchanged provider is stable', async () => {
  const pending = deferred(); let signal;
  const readDetail = args => (signal = args.signal, pending.promise), c = await controller(readDetail);
  const before = c.getSnapshot(); c.configure({readDetail}); assert.equal(c.getSnapshot(), before);
  const reading = c.load(); c.configure({readDetail: () => album()});
  assert.equal(signal.aborted, true); assert.equal(c.getSnapshot().selection, null);
  pending.resolve(album()); await reading; assert.equal(c.getSnapshot().detail.data, null);
});
test('close and dispose abort reads; disposed subscriptions and reads are inert', async () => {
  const pending = deferred(); let signal;
  const c = await controller(args => (signal = args.signal, pending.promise));
  const reading = c.load(); c.clear(); assert.equal(signal.aborted, true); assert.equal(c.getSnapshot().selection, null);
  pending.resolve(album()); await reading; assert.equal(c.getSnapshot().detail.data, null);
  c.select(selection()); const resumed = c.load();
  let calls = 0; c.subscribe(() => calls++); c.dispose(); assert.equal(signal.aborted, true); await resumed; c.subscribe(() => calls++);
  c.setScope('next'); c.select(selection()); await c.load(); c.configure({readDetail: () => album()});
  assert.equal(calls, 0); assert.deepEqual(c.getSnapshot(), {scopeKey: null, selection: null, detail: {status: 'unavailable', data: null}});
});
test('native album presentation escapes titles and composes read-only native rows', async () => {
  const html = await render(album('album:one', {native_actions: {album_ref: 'native:one', allowed_actions: {can_open_album: true, can_play_album: true}}}));
  assert.match(html, /album-details-header/); assert.match(html, /album-artbox/); assert.match(html, /compact-data-table/);
  assert.match(html, /Album &lt;one&gt;/); assert.match(html, /&lt;Track&gt;/); assert.match(html, /2:01/); assert.match(html, /Current metadata/);
  assert.match(html, /Disc/); assert.match(html, /Guest/);
  assert.doesNotMatch(html, /data-src=|data-track-path=|play-track-button|data-open-tracklist|data-album-key|data-track-row-path|data-track-duration-path|album-track-table__title|native:one|\/track\?/);
});
test('artist information and discography preserve last-known metadata and unknown totals', async () => {
  const html = await render(artist(), selection('artist', 'artist:one'));
  assert.match(html, /Artist information/); assert.match(html, /Last-known metadata/); assert.match(html, /Known biography/);
  assert.match(html, /Artist discography/); assert.match(html, /&lt;Release&gt;/); assert.match(html, /Unknown/);
  assert.doesNotMatch(html, /data-open-tracklist|data-gallery-card-intent|play-track-button|native:one/);
});
test('unknown metadata and counts never become fabricated type year track count or artwork', async () => {
  const html = await render(album('album:one', {title: '', artist: '', year: '', release_type: '', summary: '',
    track_count: null, duration_seconds: null, metadata_state: 'unknown', artwork_url: null, tracks: null}));
  assert.match(html, /Metadata freshness unknown/); assert.match(html, /Track information is unknown/); assert.match(html, /No information was supplied/);
  assert.match(html, /album-artbox--empty/); assert.doesNotMatch(html, /<img|>ALBUM<|>0:00<|>2026</);
  const empty = await render(album('album:one', {tracks: []})); assert.match(empty, /No tracks were returned/);
  const emptyArtist = await render(artist({discography: []}), selection('artist', 'artist:one')); assert.match(emptyArtist, /No releases were returned/);
  const unknownArtist = await render(artist({discography: null}), selection('artist', 'artist:one')); assert.match(unknownArtist, /Discography information is unknown/);
});
test('panel never renders stale data on denied loading error unavailable empty or mismatched selection', async () => {
  const {normalizeDetailResult} = await model;
  const data = normalizeDetailResult(album(), selection()).data;
  for (const status of ['denied', 'loading', 'error', 'unavailable', 'empty']) {
    const html = renderToStaticMarkup(React.createElement(DetailProjectionPanel, {runtime, selection: selection(), value: {status, data}, onRetry() {}}));
    assert.doesNotMatch(html, /Album &lt;one&gt;|compact-data-table|Provider supplied/);
    assert.equal(html.includes('Retry details'), status === 'error');
  }
  for (const target of [selection('album', 'other'), selection('album', 'album:one', {can_view_details: false}),
    selection('album', 'album:one', Object.create({can_view_details: true})), null]) {
    const html = renderToStaticMarkup(React.createElement(DetailProjectionPanel, {runtime, selection: target, value: {status: 'ready', data}}));
    assert.doesNotMatch(html, /Album &lt;one&gt;|compact-data-table|Provider supplied/);
  }
});
test('source boundary has no transport persistence preview imports or native playback activation', () => {
  const source = ['detail-projection.mjs', 'detail-projection.jsx'].map(file => fs.readFileSync(path.join(sourceRoot, file), 'utf8')).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|sessionStorage|mock-source|GALLERY_TRIAL|buildAlbumTrackTableHtml|albumIntent\s*\(|openTrackModal\s*\(|playTrackFromPayload\s*\(/);
});

test('origin-bound reads require the exact subject kind period and supplied snapshot', async () => {
  const origin = {source: 'activity', account_ref: 'friend:one', kind: 'artists', period: 'month', snapshot_ref: 'snapshot:one'};
  const target = {...selection('artist', 'artist:one'), origin};
  let requested;
  const c = await controller(args => {requested = args; return artist({origin});}, target);
  assert.equal((await c.load()).status, 'ready'); assert.deepEqual(requested.origin, origin);
  const {normalizeDetailResult, detailOrigin} = await model;
  for (const different of [undefined, {...origin, account_ref: 'friend:two'}, {...origin, kind: 'albums'},
    {...origin, period: 'week'}, {...origin, snapshot_ref: 'snapshot:two'}]) {
    assert.throws(() => normalizeDetailResult(artist({origin: different}), target), TypeError);
  }
  assert.deepEqual(detailOrigin({source: 'playlist', playlist_ref: 'playlist:one'}),
    {source: 'playlist', account_ref: null, playlist_ref: 'playlist:one'});
  assert.equal(detailOrigin({source: 'recent', account_ref: 'friend:one', kind: 'albums', period: 'week'}), null);
});
test('changing origin for the same resource aborts and erases prior subject information', async () => {
  const first = deferred(), origin = {source: 'activity', account_ref: 'friend:one', kind: 'artists', period: 'month'};
  let signal;
  const c = await controller(args => {signal = args.signal; return first.promise;}, {...selection('artist', 'artist:one'), origin});
  const reading = c.load(); c.select({...selection('artist', 'artist:one'), origin: {...origin, account_ref: 'friend:two'}});
  assert.equal(signal.aborted, true); assert.equal(c.getSnapshot().detail.data, null);
  first.resolve(artist({origin})); await reading; assert.equal(c.getSnapshot().detail.data, null);
});
test('listened albums are independent from discography and preserve unknown versus known empty', async () => {
  const {normalizeDetailResult} = await model, target = selection('artist', 'artist:one');
  assert.equal(normalizeDetailResult(artist(), target).data.listened_albums, null);
  assert.deepEqual(normalizeDetailResult(artist({listened_albums: []}), target).data.listened_albums, []);
  const origin = {source: 'activity', account_ref: 'friend:one', kind: 'artists', period: 'week'};
  const supplied = [{id: 'heard:one', title: 'Only this album', detail_target: selection(), path: '/private/source',
    artwork_url: 'file:///private/cover', native_actions: {album_ref: 'local:one', allowed_actions: {can_open_album: true}}}];
  const data = normalizeDetailResult(artist({origin, listened_albums: supplied}), {...target, origin}).data;
  assert.equal(data.listened_albums.length, 1); assert.deepEqual(data.listened_albums[0].detail_target.origin, origin);
  assert.equal(data.listened_albums[0].artwork_url, null); assert.doesNotMatch(JSON.stringify(data), /private/);
  for (const listened_albums of [[{id: 'same'}, {id: 'same'}], [{id: 'one', detail_target: selection('artist', 'not-an-album')}],
    [{id: 'one', detail_target: {...selection(), origin: {...origin, period: 'year'}}}]]) {
    assert.throws(() => normalizeDetailResult(artist({origin, listened_albums}), {...target, origin}), TypeError);
  }
  assert.match(await render(artist({listened_albums: []}), target), /No albums listened to in this period/);
  assert.match(await render(artist(), target), /Listened albums were not supplied/);
});
test('an origin change cannot render a ready projection from another account', async () => {
  const {normalizeDetailResult} = await model;
  const origin = {source: 'activity', account_ref: 'friend:one', kind: 'artists', period: 'week'};
  const target = {...selection('artist', 'artist:one'), origin};
  const value = normalizeDetailResult(artist({origin}), target);
  const html = renderToStaticMarkup(React.createElement(DetailProjectionPanel, {runtime, value,
    selection: {...target, origin: {...origin, account_ref: 'friend:two'}}}));
  assert.doesNotMatch(html, /Known biography|Release|Artist discography/);
});

test('embedded ArtistInfo retains the native owner without overlay or invented actions', () => {
  const html = runtime.artistInfoHtml({presentation: 'embedded', artist: '<Artist>', summary: '<Biography>',
    imageUrl: '/art/supplied', metadata: 'Last-known metadata'});
  assert.match(html, /artist-info-overlay--embedded/); assert.match(html, /role="region"/);
  assert.match(html, /album-artbox/); assert.match(html, /&lt;Artist&gt;|&lt;Biography&gt;/);
  assert.doesNotMatch(html, /role="dialog"| hidden|Read more|data-artist-info-read-more|Wikipedia/);
  const empty = runtime.artistInfoHtml({presentation: 'embedded', artist: 'Artist'});
  assert.doesNotMatch(empty, /<img|♪/); assert.match(empty, /No information was supplied/);
  assert.match(runtime.artistInfoHtml({artist: 'Existing overlay'}), /role="dialog"[^>]* hidden/);
});
test('supplied listened gallery renders no fabricated zero tracks or native media action', async () => {
  const html = await render(artist({listened_albums: [{id: 'heard:one', title: 'Heard', year: '', artwork_url: null,
    detail_target: selection()}]}), selection('artist', 'artist:one'));
  assert.match(html, /album-card/); assert.match(html, /Heard/);
  assert.doesNotMatch(html, /0 tracks|data-open-tracklist|data-album-key/);
});

test('canonical target normalization is idempotent when optional native metadata is malformed', async () => {
  const {detailSelection, detailSelectionKey} = await model;
  for (const native_actions of [null, {}, {album_ref: ''}, {artist_ref: 'wrong-kind'}]) {
    const target = {...selection(), native_actions};
    const once = detailSelection(target), twice = detailSelection(once);
    assert.deepEqual(once, twice); assert.equal(detailSelectionKey(target), detailSelectionKey(once));
  }
});
