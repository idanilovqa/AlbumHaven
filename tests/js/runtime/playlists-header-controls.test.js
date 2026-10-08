const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const repo = path.resolve(__dirname, '../../..');
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/app.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const component = (tree, name) => elements(tree).find(element => element.type?.name === name);
const missingExport = tree => elements(tree).find(element => element.props.children === 'Missing-only TXT');
const native = createNativeHomeRuntime();
const runtime = {actionHtml: native.context.ButtonComponent.renderActionButton, galleryBarHtml: native.context.buildGalleryBarHtml};
let createPlaylistController;
test.before(async () => ({createPlaylistController} = await import('../../../music_app/static/js/playlists/model.mjs')));

// Bounded hook lifetime driver for actual native header handlers and the real
// page's export boundary. This does not emulate React reconciliation or a browser.
function lifecycle(name = 'PlaylistsView', host = null) {
  const slots = []; let cursor = 0, effects = [], initialized = false;
  const changed = (previous, deps) => !previous || deps.some((value, index) => !Object.is(value, previous.deps[index]));
  const effect = (callback, deps) => {
    const index = cursor++, previous = slots[index];
    if (changed(previous, deps)) effects.push(() => {previous?.cleanup?.(); slots[index] = {deps, cleanup: callback()};});
  };
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useState(value) {const index = cursor++; slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slots[index].value, next => {slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];},
    useMemo(factory, deps) {const index = cursor++; if (changed(slots[index], deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useLayoutEffect: effect, useEffect: effect,
  };
  const fixture = {exports: {}};
  vm.runInNewContext(built, {module: fixture, exports: fixture.exports, console, document: native.document, AbortController,
    require: name => name === 'react' ? hooks : require(name)});
  return {render(props) {
    cursor = 0; effects = [];
    const tree = fixture.exports[name](props);
    if (host) {
      tree.props.ref.current = host;
      if (!initialized && tree.props.dangerouslySetInnerHTML) host.innerHTML = tree.props.dangerouslySetInnerHTML.__html;
      initialized = true;
    }
    for (const run of effects) run();
    return tree;
  }, dispose() {for (const slot of slots) slot?.cleanup?.();}};
}

function session({canExport = true, complete = true, authorOrder = true} = {}) {
  const controller = createPlaylistController();
  const track = (id, availability, extra = {}) => ({playlist_item_id: id, title: id, artist: 'Artist', album_title: 'Album', availability, ...extra});
  const payload = {playlist_sidebar: {items: [{playlist_id: 'one', title: 'Playlist', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'one', title: 'Playlist', description: '', revision: 'revision', items_complete: complete,
      active_sort: {key: authorOrder ? 'playlist_position' : 'title', direction: 'asc'},
      allowed_actions: {can_export: canExport, can_edit: true, can_reorder: true},
      track_rows: [track('missing', 'missing'), track('local', 'local'), track('unknown', 'unresolved'),
        track('hidden', 'missing', {title: 'Private title', source_readable: false})]}};
  controller.setScope('header-export:scope');
  assert.equal(controller.accept(payload, 'one'), true);
  assert.equal(controller.getSnapshot().resource.status, 'ready');
  return {controller, payload};
}
const pageProps = (controller, downloads) => ({runtime: {...runtime, downloadText: value => downloads.push(value)},
  controller, state: controller.getSnapshot(), onSelect() {}});

test('native header dispatches icon clicks once and rejects every action while busy', () => {
  const host = native.document.createElement('div'); native.document.body.appendChild(host);
  const fixture = lifecycle('PlaylistHeader', host), actions = [];
  const props = {runtime, detail: {title: 'Playlist', track_rows: [{availability: 'missing', source_readable: true}]}, draft: {title: 'Draft'}, busy: false, filtersOpen: false,
    actions: {add: true, missing: true, top: true, export: true, save: true}, onAction: action => actions.push(action)};
  let tree = fixture.render(props);
  for (const button of host.querySelectorAll('[data-playlists-action]')) tree.props.onClick(native.event('click', button.querySelector('svg')));
  assert.deepEqual(actions, ['add', 'missing', 'top', 'export', 'share', 'filters', 'save', 'discard']);
  tree = fixture.render({...props, busy: true});
  for (const button of host.querySelectorAll('[data-playlists-action]')) {
    assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-disabled'), 'true');
    tree.props.onClick(native.event('click', button.querySelector('svg')));
  }
  assert.equal(actions.length, 8);
  fixture.dispose(); host.remove();
});

test('header TXT and summary missing-only TXT preserve the full unsaved order independently of displayed filters', async () => {
  const {controller} = session(), fixture = lifecycle(), downloads = [];
  assert.equal(controller.reorder(['unknown', 'hidden', 'local', 'missing']), true);
  controller.filter({availability: 'missing'});
  const tree = fixture.render(pageProps(controller, downloads)), before = controller.getSnapshot();
  assert.deepEqual(Array.from(component(tree, 'PlaylistTracks').props.rows, row => row.playlist_item_id), ['missing']);
  assert.equal(component(tree, 'PlaylistHeader').props.actions.export, true);
  await component(tree, 'PlaylistHeader').props.onAction('export');
  missingExport(tree).props.onClick(); await Promise.resolve();
  assert.deepEqual(downloads.map(({filename, text}) => [filename, text]), [
    ['playlist.txt', 'Artist - unknown [Album]\nArtist - local [Album]\nArtist - missing [Album]'],
    ['playlist-missing.txt', 'Artist - missing [Album]'],
  ]);
  assert.equal(controller.getSnapshot(), before, 'export never saves or edits the draft');
  fixture.dispose(); controller.dispose();
});

test('TXT controls and handlers remain unavailable without exact export authority or a complete author order', async () => {
  for (const options of [{canExport: false}, {canExport: 'true'}, {complete: false}, {authorOrder: false}]) {
    const {controller} = session(options), fixture = lifecycle(), downloads = [];
    const tree = fixture.render(pageProps(controller, downloads)), header = component(tree, 'PlaylistHeader');
    assert.equal(header.props.actions.export, false); assert.equal(missingExport(tree).props.disabled, true);
    await header.props.onAction('export'); missingExport(tree).props.onClick(); await Promise.resolve();
    assert.deepEqual(downloads, []);
    fixture.dispose(); controller.dispose();
  }
});

test('old and already-queued TXT handlers reject scope, grant, provider and owner retirement', async () => {
  const retirements = [
    controller => controller.setScope('header-export:next'),
    (controller, payload) => controller.accept({...payload, playlist_detail: {...payload.playlist_detail, allowed_actions: {can_export: false}}}, 'one'),
    controller => controller.configure({readPlaylists() {}}),
    controller => controller.dispose(),
  ];
  for (const retire of retirements) for (const queued of [false, true]) {
    const {controller, payload} = session(), fixture = lifecycle(), downloads = [];
    const tree = fixture.render(pageProps(controller, downloads));
    const dispatch = () => {component(tree, 'PlaylistHeader').props.onAction('export'); missingExport(tree).props.onClick();};
    if (queued) dispatch();
    retire(controller, payload);
    if (!queued) dispatch();
    await Promise.resolve();
    assert.deepEqual(downloads, []);
    fixture.dispose(); controller.dispose();
  }
});

test('missing-only TXT is disabled and inert when only local, unknown or unreadable rows remain', async () => {
  const {controller, payload} = session(), fixture = lifecycle(), downloads = [];
  payload.playlist_detail.track_rows = payload.playlist_detail.track_rows.filter(row => row.playlist_item_id !== 'missing');
  controller.accept(payload, 'one');
  const tree = fixture.render(pageProps(controller, downloads));
  assert.equal(component(tree, 'PlaylistHeader').props.actions.export, true);
  assert.equal(missingExport(tree).props.disabled, true);
  missingExport(tree).props.onClick(); await Promise.resolve(); assert.deepEqual(downloads, []);
  await component(tree, 'PlaylistHeader').props.onAction('export');
  assert.equal(downloads.length, 1); assert.equal(downloads[0].text, 'Artist - local [Album]\nArtist - unknown [Album]');
  fixture.dispose(); controller.dispose();
});

test('Inspect opens the unsaved page directly once and never opens a creation form or writes', async () => {
  const {controller, payload} = session(), host = native.document.createElement('div'); native.document.body.appendChild(host);
  const source = {kind: 'playlist', ref: 'one', revision: 'revision', allowed_actions: {can_read: true, can_use_for_playlist: true}};
  payload.playlist_actions = {can_create: true}; payload.playlist_detail.missing_playlist_creation_source = source;
  controller.accept(payload, 'one');
  let release, reads = 0, writes = 0, forms = 0;
  const packets = [], fixture = lifecycle('PlaylistsView', host);
  const props = {...pageProps(controller, []), runtime: {...runtime, openForm: () => {forms++;}},
    integrationProviders: {readPlaylistCreationSource: request => {reads++; return new Promise(resolve => {
      release = () => resolve({status: 'ready', data: {scopeKey: request.scopeKey, mode: 'missing', source: request.source,
        allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true, retained_parent_albums: [],
        entries: [{entry_ref: 'source:unknown-identity', canonical_track_ref: null, title: 'Original', availability: 'missing',
          allowed_actions: {can_read: true, can_select: true}}]}});
    });}, createPlaylistFromSelection: () => {writes++;}}, onPrepareDraft: packet => {packets.push(packet); return true;}};
  const tree = fixture.render(props), action = component(tree, 'PlaylistHeader').props.onAction;
  assert.equal(component(tree, 'PlaylistHeader').props.actions.missing, true);
  const first = action('missing'); await action('missing');
  assert.equal(reads, 1); assert.equal(forms, 0); assert.equal(writes, 0); assert.deepEqual(packets, []);
  release(); await first;
  assert.equal(packets.length, 1); assert.equal(packets[0].title, 'Missing tracks · Playlist');
  assert.deepEqual(Array.from(packets[0].entries, row => row.entry_ref), ['source:unknown-identity']);
  assert.equal(packets[0].entries[0].canonical_track_ref, null);
  assert.equal(forms, 0); assert.equal(writes, 0); assert.equal(packets[0].playlist_id, undefined);
  fixture.dispose(); controller.dispose(); host.remove();
});
