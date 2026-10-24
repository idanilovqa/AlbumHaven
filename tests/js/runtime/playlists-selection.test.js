const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
const source = path.join(repo, 'music_app/static/js/playlists');
const model = import(pathToFileURL(path.join(source, 'selection.mjs')));
const built = buildSync({entryPoints: [path.join(source, 'selection.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react']});
const loaded = new Module(__filename + '.selection', module);
loaded.filename = __filename + '.selection'; loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {PlaylistSelectionPanel, PlaylistTrackSummary, PlaylistAlbumDetails} = loaded.exports;
const native = createNativeHomeRuntime();
for (const file of ['compact-data-table.js', 'album-details-components.js', 'in-page-tabs.js']) {
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), native.context);
}
const runtime = {escapeHtml: native.context.escapeHtml, buttonHtml: native.context.ButtonComponent.renderButton,
  actionHtml: native.context.ButtonComponent.renderActionButton, alertHtml: native.context.buildOnPageAlertHtml,
  tableHtml: native.context.buildCompactDataTable, artboxHtml: native.context.buildAlbumArtboxHtml,
  detailHeaderHtml: native.context.buildAlbumDetailsHeaderHtml, tabsHtml: native.context.buildInPageTabsHtml,
  mountTabs: native.context.mountInPageTabs};
const render = (Component, props = {}) => renderToStaticMarkup(React.createElement(Component, {runtime, ...props}));

// Authorized row projections live only in tests, never in production defaults.
const row = (overrides = {}) => ({row_key: 'item:one', source_readable: true, playlist_item_id: 'one',
  title: 'Track <one>', artist: 'Artist', secondary_artist: 'Guest', album_title: 'Album', album_ref: 'album:one',
  duration_seconds: 121, duration_display: '2:01', track_number: 1, disc_number: 2,
  source_label: 'Library', source_kind: 'local', artwork_url: '/art/one', metadata_state: 'last_known',
  availability: 'local', allowed_actions: {can_view_details: true}, ...overrides});

test('selected track projection keeps display facts and strips media, account and mutation data', async () => {
  const {playlistTrackSummary} = await model;
  const result = playlistTrackSummary(row({path: '/private/file.flac', track_ref: 'secret-track', source_ref: 'secret-source',
    account_ref: 'secret-account', playback_state: {is_playing: true}, summary: 'unapproved biography'}));
  assert.equal(result.status, 'ready'); assert.equal(result.data.title, 'Track <one>');
  assert.equal(result.data.duration_seconds, 121); assert.equal(result.data.disc_number, 2);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|playback_state|biography|playlist_item_id|album_ref|allowed_actions/);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.data));
});
test('unreadable sources discard every display fact and cannot select an album', async () => {
  const {playlistTrackSummary, playlistAlbumSelection} = await model;
  for (const value of [row({source_readable: false}), row({source_readable: undefined}),
    row({source_readable: 'true'}), row({allowed_actions: {can_read: false, can_view_details: true}})]) {
    assert.deepEqual(playlistTrackSummary(value), {status: 'denied', data: null});
    assert.equal(playlistAlbumSelection(value), null);
    const html = render(PlaylistTrackSummary, {row: value});
    assert.doesNotMatch(html, /Track &lt;one&gt;|Guest|\/art\/one|Library/); assert.match(html, /access/);
  }
  assert.deepEqual(playlistTrackSummary(null), {status: 'unavailable', data: null});
});
test('album details require a canonical ref and an independent exact own grant', async () => {
  const {playlistAlbumSelection} = await model;
  for (const album_ref of [undefined, '', '\n', 'bad\nref', 'a'.repeat(513)]) {
    assert.equal(playlistAlbumSelection(row({album_ref, track_ref: 'album:from-track', album_title: 'album:from-title'})), null);
  }
  for (const allowed_actions of [{}, {can_open: true}, {can_open_album: true}, {can_play: true},
    {can_view_details: 1}, {can_view_details: 'true'}, Object.create({can_view_details: true})]) {
    assert.deepEqual(playlistAlbumSelection(row({allowed_actions})), {kind: 'album', ref: 'album:one', allowed_actions: {can_view_details: false}});
  }
  assert.deepEqual(playlistAlbumSelection(row()), {kind: 'album', ref: 'album:one', allowed_actions: {can_view_details: true}});
});
test('zero, absent data and unknown availability or freshness stay distinct', async () => {
  const {playlistTrackSummary} = await model;
  const value = playlistTrackSummary(row({duration_seconds: 0, track_number: 0, disc_number: null,
    availability: 'streamable', metadata_state: 'fresh'})).data;
  assert.equal(value.duration_seconds, 0); assert.equal(value.track_number, 0); assert.equal(value.disc_number, null);
  assert.equal(value.availability, 'unresolved'); assert.equal(value.metadata_state, 'unknown');
  for (const duration_seconds of [null, undefined, false, '0', -1, Infinity, NaN]) {
    assert.equal(playlistTrackSummary(row({duration_seconds})).data.duration_seconds, null);
  }
  for (const track_number of [-1, 1.5, '1', Infinity]) {
    assert.equal(playlistTrackSummary(row({track_number})).data.track_number, null);
  }
});
test('artwork uses only explicit safe server references and never path or album identity fallback', async () => {
  const {playlistTrackSummary} = await model;
  for (const artwork_url of [undefined, 'https://other.test/cover', '//other.test/a', 'file:///music',
    'data:image/png;base64,abc', '/\\other/cover', '/with space', 'javascript:alert(1)']) {
    const value = row({artwork_url, cover_path: '/private/cover.png'});
    assert.equal(playlistTrackSummary(value).data.artwork_url, null);
    const html = render(PlaylistTrackSummary, {row: value});
    assert.match(html, /album-artbox--empty/); assert.doesNotMatch(html, /<img|private\/cover/);
  }
});
test('track presentation reuses native artwork and header with escaped display-only facts', () => {
  const html = render(PlaylistTrackSummary, {row: row({source_label: '<source>'})});
  assert.match(html, /album-artbox/); assert.match(html, /album-details-header/);
  assert.match(html, /Track &lt;one&gt;/); assert.match(html, /Last-known metadata/);
  assert.match(html, /&lt;source&gt;/); assert.match(html, /Confirmed local/); assert.match(html, /2:01/);
  assert.doesNotMatch(html, /data-src=|data-track-path=|data-album-key=|play-track-button|album:one|item:one/);
});
test('unknown track metadata never becomes invented media, biography or source', () => {
  const html = render(PlaylistTrackSummary, {row: row({title: '', artist: '', secondary_artist: '', album_title: '',
    duration_seconds: null, duration_display: '', source_label: '', source_kind: '', track_number: null,
    disc_number: null, metadata_state: null, artwork_url: null, availability: null})});
  assert.match(html, /Unknown/); assert.match(html, /Metadata freshness unknown/); assert.match(html, /Unresolved/);
  assert.doesNotMatch(html, /<img|0:00|Biography|Confirmed local|Last-known metadata/);
  assert.match(render(PlaylistTrackSummary, {row: row({duration_seconds: 0})}), /0:00/);
  assert.match(render(PlaylistTrackSummary, {row: row({duration_seconds: null, duration_display: '3:45'})}), /3:45/);
});
test('album admission reports unavailable or denied without using native Home authority', () => {
  const withHomeReader = {...runtime, readAlbumProjection() {throw new Error('Home scope must not authorize playlist details');}};
  const html = render(PlaylistAlbumDetails, {runtime: withHomeReader, scopeKey: 'playlist-scope', row: row()});
  assert.match(html, /unavailable from this provider/); assert.doesNotMatch(html, /Track &lt;one&gt;|compact-data-table/);
  const denied = render(PlaylistAlbumDetails, {row: row({allowed_actions: {can_open_album: true}}), readDetail() {throw new Error('Denied');}});
  assert.match(denied, /access to these album details/);
  const unavailable = render(PlaylistAlbumDetails, {row: row({album_ref: null}), readDetail() {throw new Error('No identity');}});
  assert.match(unavailable, /unavailable/);
  const unreadable = render(PlaylistAlbumDetails, {row: row({source_readable: false}), readDetail() {throw new Error('Unreadable');}});
  assert.match(unreadable, /access/); assert.doesNotMatch(unreadable, /Track &lt;one&gt;|Album tracks/);
});
test('selection opens the track tab, keeps a native close control and links its panel label', () => {
  assert.equal(render(PlaylistSelectionPanel, {row: null}), '');
  const html = render(PlaylistSelectionPanel, {row: row(), scopeKey: 'one'});
  assert.match(html, /aria-label="Selected playlist item"/);
  const host = native.document.createElement('div'); host.innerHTML = html;
  assert.equal(host.querySelector('[data-in-page-tab="track"]').getAttribute('aria-selected'), 'true');
  assert.equal(host.querySelector('[data-in-page-tab="album"]').getAttribute('aria-selected'), 'false');
  assert.equal(host.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'), host.querySelector('[data-in-page-tab="track"]').id);
  assert.match(html, /Close selection/); assert.match(html, /action-button/);
});
test('selection source reuses the detail owner without transport, media, navigation or fixture ownership', () => {
  const text = ['selection.jsx', 'selection.mjs'].map(file => fs.readFileSync(path.join(source, file), 'utf8')).join('\n');
  assert.match(text, /ResourceDetail/); assert.match(text, /DetailProjectionPanel/);
  assert.doesNotMatch(text, /readAlbumProjection|\bfetch\s*\(|localStorage|sessionStorage|mock-source|fixture-data|trackIntent\s*\(|albumIntent\s*\(|window\.|history\./);
});

test('playlist uses supplied catalog targets and never derives an Artist from its label or account', async () => {
  const {playlistAlbumSelection, playlistArtistSelection} = await model;
  const origin = {source: 'playlist', account_ref: null, playlist_ref: 'playlist:one', snapshot_ref: 'revision:one'};
  const artist_target = {kind: 'artist', ref: 'catalog-artist:one', origin, allowed_actions: {can_view_details: true}};
  const album_target = {kind: 'album', ref: 'catalog-album:one', origin, allowed_actions: {can_view_details: true}};
  assert.equal(playlistArtistSelection(row({artist: 'catalog-artist:one', account_ref: 'catalog-artist:one'})), null);
  assert.deepEqual(playlistArtistSelection(row({artist_target})), artist_target);
  assert.deepEqual(playlistAlbumSelection(row({album_target})), album_target);
  assert.equal(playlistArtistSelection(row({artist_target, source_readable: false})), null);
  assert.equal(playlistAlbumSelection(row({album_target: artist_target})), null);
  assert.match(render(PlaylistSelectionPanel, {row: row({artist_target})}), /data-in-page-tab="artist"/);
  assert.doesNotMatch(render(PlaylistSelectionPanel, {row: row()}), /data-in-page-tab="artist"/);
});
