const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {installNativeSearch} = require('./native-search-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/app.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']});
const loaded = new Module(path.join(repo, 'playlists-component-fixture.cjs'), module);
loaded.filename = path.join(repo, 'playlists-component-fixture.cjs'); loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {PlaylistHeader, PlaylistFilters, PlaylistDirectory, SharingFields, MutationStatus, playlistTableHtml, resolvePlaylistSelection, playlistIntegrationCurrent, playlistReorderSnapshot,
  paintPlaylistCurrent, restorePlaylistSelectionFocus, confirmPlaylistDiscard, playlistSharingRenderCurrent} = loaded.exports;
const native = createNativeHomeRuntime();
for (const filename of ['compact-data-table.js', 'gallery-main-components.js', 'album-track-table.js', 'trigger-anchor.js', 'library-settings.js']) {
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', filename), 'utf8'), native.context);
}
const template = native.document.createElement('script'); template.setAttribute('id', 'navigation-tree-item-template');
template.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8'); native.document.body.appendChild(template);
vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/navigation-tree.js'), 'utf8'), native.context);
const search = installNativeSearch(native);
const runtime = {searchHtml: search.render, buttonHtml: value => native.context.ButtonComponent.renderButton(value), actionHtml: value => native.context.ButtonComponent.renderActionButton(value),
  openChoice: native.context.openUtilityChoiceDropdown,
  alertHtml: value => native.context.buildOnPageAlertHtml(value), galleryBarHtml: value => native.context.buildGalleryBarHtml(value),
  tableHtml: value => native.context.buildCompactDataTable(value), navigationItemHtml: value => native.context.window.NavigationTree.renderItem(value),
  artboxHtml: value => native.context.buildAlbumArtboxHtml(value),
  albumTrackRow: (row, index) => native.context.buildAlbumTrackTableRow({...row, duration: row.duration_display}, index, {readOnly: true}),
  escapeHtml: native.context.escapeHtml};
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, {runtime, ...props}));

test('header exposes named native icon actions in approved order and preserves disabled reasons', () => {
  const html = render(PlaylistHeader, {detail: {title: '<safe>'}, draft: {title: 'Draft'}, busy: false,
    actions: {add: true, missing: false, top: false, export: true, save: true}, filtersOpen: true});
  assert.match(html, /gallery-bar__context/); assert.match(html, /action-button/);
  const positions = ['add', 'missing', 'top', 'export', 'share', 'filters', 'save', 'discard'].map(action => html.indexOf(`data-playlists-action="${action}"`));
  assert.equal(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])), true);
  assert.match(html, /aria-expanded="true"/); assert.match(html, /Discard unsaved changes/);
  const host = native.document.createElement('div'); host.innerHTML = html;
  assert.equal(host.querySelector('[data-playlists-action="top"]').disabled, true);
  assert.equal(host.querySelector('[data-playlists-action="add"]').disabled, false);
  const labels = ['Add tracks', 'Inspect missing tracks', 'Create Album Top', 'Export TXT', 'Share', 'Playlist settings', 'Filters', 'Save', 'Discard unsaved changes'];
  assert.deepEqual([...host.querySelectorAll('[data-playlists-action]')].map(button => button.getAttribute('aria-label')), labels);
  assert.ok([...host.querySelectorAll('[data-playlists-action]')].every(button => button.classList.contains('action-button--bare') && button.querySelector('svg')));
  assert.equal(host.querySelector('[data-playlists-action="export"]').disabled, false);
  assert.match(host.querySelector('[data-playlists-action="missing"]').getAttribute('title'), /not available for this source/);
});
test('track rows compose native table and album text with opaque action keys only', () => {
  const detail = {playlist_id: 'p', title: 'List', allowed_actions: {can_play: true}};
  const rows = [{row_key: 'item:a', playlist_item_id: 'a', title: '<Track>', secondary_artist: 'Guest', artist: 'Artist', album_title: 'Album',
    source_readable: true, duration_display: '2:00', availability: 'unresolved', path: '/private/music/file.flac', track_ref: '/private/music/file.flac'}];
  const html = playlistTableHtml(runtime, {rows, detail, selected: 'item:a'});
  assert.match(html, /compact-data-table/); assert.match(html, /album-track-table__title/);
  assert.match(html, /&lt;Track&gt;/); assert.match(html, /Needs review/);
  assert.match(html, /data-cdt-selection="multiple"/); assert.doesNotMatch(html, /aria-selected="true"/);
  assert.doesNotMatch(html, /private\/music|data-src=|class="play-track-button/);
  const host = native.document.createElement('div'); host.innerHTML = html;
  assert.equal(host.querySelector('[data-playlists-play]').disabled, true);
  const active = playlistTableHtml({...runtime, canTrackIntent: () => true, trackIntent() {}}, {rows, detail});
  host.innerHTML = active; assert.equal(host.querySelector('[data-playlists-play]').disabled, false);
  host.innerHTML = playlistTableHtml({...runtime, canTrackIntent: () => 'true', trackIntent() {}}, {rows, detail});
  assert.equal(host.querySelector('[data-playlists-play]').disabled, true);
});
test('reorder uses native buttons and preserves explicit edge restrictions', () => {
  const rows = ['a', 'b'].map(id => ({row_key: `item:${id}`, playlist_item_id: id, title: id, availability: 'local'}));
  const html = playlistTableHtml(runtime, {rows, detail: {title: 'List'}, reorderable: true});
  const host = native.document.createElement('div'); host.innerHTML = html;
  const first = host.querySelector('[data-playlist-row-key="item:a"]'), last = host.querySelector('[data-playlist-row-key="item:b"]');
  assert.equal(first.querySelector('[data-playlists-move="up"]').disabled, true);
  assert.equal(first.querySelector('[data-playlists-move="down"]').disabled, false);
  assert.equal(last.querySelector('[data-playlists-move="down"]').disabled, true);
});
test('directory and filters show server data and local presentation without fixtures', () => {
  const html = render(PlaylistDirectory, {state: {mutation: {status: 'idle'}, selectedPlaylistId: 'one', resource: {status: 'ready', data: {items: [
    {playlist_id: 'one', title: 'My <playlist>', item_count: 0, allowed_actions: {can_open: true}},
  ]}}}, canCreate: false});
  assert.match(html, /navigation-tree/); assert.match(html, /My &lt;playlist&gt;/); assert.match(html, /0 tracks/);
  const filters = render(PlaylistFilters, {filters: {query: '', availability: 'unresolved'}});
  const host = native.document.createElement('div'); host.innerHTML = filters;
  assert.equal(host.querySelector('button[aria-label="Availability: Needs review"]').getAttribute('aria-haspopup'), 'menu');
  assert.equal(host.querySelector('select'), null);
  assert.ok(host.querySelector('.search-field input[type="search"]'));
  assert.equal(host.querySelector('input[type="search"]').getAttribute('aria-label'), 'Find tracks');
  assert.equal(host.querySelector('input[type="search"]').getAttribute('placeholder'), 'Track, artist or album');
  assert.match(filters, /Unknown filter values remain visible/);
  assert.equal(host.querySelector('button[aria-label="Availability: Needs review"]').disabled, false);
  host.innerHTML = render(PlaylistFilters, {filters: {query: '', availability: 'missing'}, disabled: true});
  assert.equal(host.querySelector('button[aria-label="Availability: Confirmed missing"]').disabled, true);
});

test('persisted tracks inherit native missing paint only for confirmed missing rows', () => {
  const rows = ['missing', 'unresolved', 'local'].map(availability => rowFixture(availability, {availability}));
  const host = native.document.createElement('div');
  host.innerHTML = playlistTableHtml(runtime, {rows, detail: {title: 'Availability'}});
  for (const availability of ['missing', 'unresolved', 'local']) {
    const row = host.querySelector(`[data-playlist-row-key="item:${availability}"]`);
    assert.equal(row.classList.contains('album-track-table__row--missing'), availability === 'missing');
    assert.equal(row.querySelector('[data-playlists-play]').hasAttribute('hidden'), availability === 'missing');
  }
  assert.match(host.querySelector('[data-playlist-row-key="item:unresolved"]').textContent, /Needs review/);
});
test('sharing uses native choices and explicit editors, with public links unavailable and read-only users disabled', () => {
  const html = render(SharingFields, {value: {visibility: 'private', can_manage: true, people: [
    {account_ref: 'owner', display_name: '<Owner>', selected: true, role: 'editor', can_edit: false},
  ]}, busy: false});
  assert.match(html, /&lt;Owner&gt;/); assert.match(html, /Public links are unavailable/); assert.doesNotMatch(html, /Demo|fixture/);
  const host = native.document.createElement('div'); host.innerHTML = html;
  assert.equal(host.querySelector('select'), null);
  assert.equal(host.querySelector('button[aria-label="Playlist visibility: Private"]').getAttribute('aria-haspopup'), 'menu');
  assert.equal([...host.querySelectorAll('button')].find(button => button.textContent === 'Remove editor').disabled, true);
  const fields = SharingFields({runtime, value: {visibility: 'private', can_manage: true, people: []}});
  const choice = React.Children.toArray(fields.props.children).find(node => node.type?.name === 'NativeChoice');
  assert.deepEqual(choice.props.options, [['private', 'Private'], ['server_shared', 'Shared with this server'], ['link', 'Public link unavailable', true]]);
});
test('missing/error write states never report a saved draft', () => {
  assert.match(render(MutationStatus, {value: {status: 'unavailable'}}), /not available on this server/);
  assert.match(render(MutationStatus, {value: {status: 'error'}}), /not confirmed/);
  assert.match(render(MutationStatus, {value: {status: 'ready'}}), /server confirmed/);
});
test('production source has one explicit mount boundary and no mock transport or persistence', () => {
  const source = ['model.mjs', 'app.jsx', 'track-table.jsx', 'index.jsx'].map(file => fs.readFileSync(path.join(repo, 'music_app/static/js/playlists', file), 'utf8')).join('\n');
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|MockRealLayout|fixture-data|fetch\(/);
  const entry = fs.readFileSync(path.join(repo, 'music_app/static/js/playlists/index.jsx'), 'utf8');
  assert.match(entry, /export function mountPlaylists/); assert.doesNotMatch(entry, /window\.|addEventListener/);
  assert.match(source, /playlistText\(exportRows/); assert.doesNotMatch(source, /playlistText\(rows, \{missingOnly\}\)/);
});

const rowFixture = (id, extra = {}) => ({row_key: `item:${id}`, playlist_item_id: id, title: id, source_readable: true, availability: 'unresolved', ...extra});
const stateFixture = detail => ({scopeKey: 'scope', selectedPlaylistId: 'one', resource: {status: 'ready', data: {detail}}, drafts: {}, filters: {}, mutation: {status: 'idle'}});
test('selection reconciles stable IDs only and rejects stale anonymous, filtered, unreadable or foreign rows', () => {
  const a = rowFixture('a'), detail = {playlist_id: 'one', track_rows: [a]};
  const chosen = {scopeKey: 'scope', playlistId: 'one', itemId: 'a', rowKey: a.row_key, detail};
  const next = rowFixture('a', {title: 'Fresh'}), replacement = {...detail, track_rows: [next]};
  assert.equal(resolvePlaylistSelection(chosen, {scopeKey: 'scope', detail: replacement, rows: [next]}), next);
  assert.equal(resolvePlaylistSelection(chosen, {scopeKey: 'scope', detail, rows: []}), null);
  assert.equal(resolvePlaylistSelection(chosen, {scopeKey: 'other', detail, rows: [a]}), null);
  assert.equal(resolvePlaylistSelection(chosen, {scopeKey: 'scope', detail, rows: [{...a, source_readable: false}]}), null);
  const anonymous = {scopeKey: 'scope', playlistId: 'one', itemId: null, rowKey: 'projection:0', detail};
  const projection = rowFixture(null, {row_key: 'projection:0'});
  assert.equal(resolvePlaylistSelection(anonymous, {scopeKey: 'scope', detail, rows: [projection]}), projection);
  assert.equal(resolvePlaylistSelection(anonymous, {scopeKey: 'scope', detail: replacement, rows: [projection]}), null);
});
test('integration render guard uses exact detail identity, scope, status and current selected item', () => {
  const detail = {playlist_id: 'one'}, state = stateFixture(detail);
  const value = {scopeKey: 'scope', status: 'ready', detail, selectedItemId: 'a'};
  assert.equal(playlistIntegrationCurrent(value, state, 'a'), true);
  assert.equal(playlistIntegrationCurrent({...value, detail: {...detail}}, state, 'a'), false);
  assert.equal(playlistIntegrationCurrent(value, state, 'b'), false);
  assert.equal(playlistIntegrationCurrent(value, {...state, scopeKey: 'next'}, 'a'), false);
  assert.equal(playlistIntegrationCurrent(value, {...state, resource: {status: 'loading', data: null}}, 'a'), false);
});
test('current queue paint preserves every native table node and only changes aria-current', () => {
  const rows = [rowFixture('a'), rowFixture('b')], detail = {playlist_id: 'one', title: 'Tracks'};
  const host = native.document.createElement('div'); host.innerHTML = playlistTableHtml(runtime, {rows, detail});
  const nodes = [...host.querySelectorAll('[data-playlist-row-key]')], button = nodes[0].querySelector('[data-playlists-select]');
  paintPlaylistCurrent(host, rows, 'a'); assert.equal(nodes[0].getAttribute('aria-current'), 'true');
  paintPlaylistCurrent(host, rows, 'b'); assert.equal(nodes[0].hasAttribute('aria-current'), false);
  assert.equal(nodes[1].getAttribute('aria-current'), 'true');
  assert.equal(host.querySelector('[data-playlists-select]'), button);
  assert.deepEqual([...host.querySelectorAll('[data-playlist-row-key]')], nodes);
  paintPlaylistCurrent(host, rows, 'outside'); assert.equal(nodes[1].hasAttribute('aria-current'), false);
});
test('current reorder adapter snapshot sees canonical order, busy, scope and live rich filters', () => {
  const rows = [rowFixture('a'), rowFixture('b')];
  let state = stateFixture({playlist_id: 'one', track_rows: rows, items_complete: true, author_order: true,
    allowed_actions: {can_edit: true, can_reorder: true}});
  const controller = {getSnapshot: () => state};
  assert.equal(playlistReorderSnapshot(controller).defaultOrder, true);
  state = {...state, drafts: {one: {item_order: ['b', 'a']}}};
  assert.deepEqual(playlistReorderSnapshot(controller).rows.map(row => row.playlist_item_id), ['b', 'a']);
  state = {...state, filters: {one: {frequency: 'mid'}}}; assert.equal(playlistReorderSnapshot(controller).unfiltered, false);
  state = {...state, mutation: {status: 'loading'}}; assert.equal(playlistReorderSnapshot(controller).busy, true);
  state = {...state, scopeKey: 'next', resource: {status: 'loading', data: null}};
  assert.equal(playlistReorderSnapshot(controller).scopeKey, 'next'); assert.equal(playlistReorderSnapshot(controller).source, null);
});
test('share render subject survives only its own save gap and rejects same-ID replacement immediately', () => {
  const detail = {playlist_id: 'one', allowed_actions: {can_share: true}}, state = stateFixture(detail);
  assert.equal(playlistSharingRenderCurrent(detail, state), true);
  assert.equal(playlistSharingRenderCurrent(detail, {...state, mutation: {status: 'error'}}), true);
  const writing = {...state, resource: {status: 'loading', data: null}, mutation: {status: 'loading', action: 'saveSharing', playlist_id: 'one'}};
  assert.equal(playlistSharingRenderCurrent(detail, writing), true);
  assert.equal(playlistSharingRenderCurrent(detail, {...writing, resource: {status: 'ready', data: {detail: {...detail}}}}), false);
  assert.equal(playlistSharingRenderCurrent(detail, {...state, resource: {status: 'ready', data: {detail: {...detail}}}}), false);
});
test('native discard approval applies only to unchanged scope, playlist, detail and exact draft', async () => {
  for (const change of [state => state, state => ({...state, scopeKey: 'next'}), state => ({...state, selectedPlaylistId: 'two'}),
    state => ({...state, drafts: {one: {...state.drafts.one}}}), state => ({...state, resource: {status: 'ready', data: {detail: {...state.resource.data.detail}}}})]) {
    let state = {...stateFixture({playlist_id: 'one'}), drafts: {one: {title: 'Draft'}}}, accept, calls = 0;
    const initial = state, controller = {getSnapshot: () => state, discard: () => {calls++; return true;}};
    const pending = confirmPlaylistDiscard({confirm: () => new Promise(resolve => {accept = resolve;})}, controller);
    state = change(state); accept(true); const result = await pending;
    assert.equal(result, state === initial); assert.equal(calls, state === initial ? 1 : 0);
  }
  const state = {...stateFixture({playlist_id: 'one'}), drafts: {one: {}}};
  let calls = 0;
  const controller = {getSnapshot: () => state, discard: () => {calls++; return true;}};
  assert.equal(await confirmPlaylistDiscard({confirm: async () => false}, controller), false);
  assert.equal(await confirmPlaylistDiscard({}, controller), false); assert.equal(calls, 0);
});
test('selection return focus uses a current row control and never steals another live focus', () => {
  const host = native.document.createElement('div'); host.innerHTML = playlistTableHtml(runtime, {rows: [rowFixture('a')], detail: {title: 'List'}});
  native.document.body.appendChild(host); native.document.activeElement = native.document.body;
  const button = host.querySelector('[data-playlists-select]');
  // Bounded focus-return contract probe; this does not assert browser geometry.
  button.focus = () => {native.document.activeElement = button;};
  assert.equal(restorePlaylistSelectionFocus(host, 'item:a', native.document), true);
  assert.equal(native.document.activeElement, button);
  const external = native.document.createElement('button'); native.document.body.appendChild(external); native.document.activeElement = external;
  assert.equal(restorePlaylistSelectionFocus(host, 'item:a', native.document), false);
  assert.equal(native.document.activeElement, external); external.remove(); host.remove();
});
