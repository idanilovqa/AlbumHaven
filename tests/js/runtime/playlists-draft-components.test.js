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
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/draft.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']});
const loaded = new Module(__filename + '.draft', module);
loaded.filename = __filename + '.draft'; loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {MissingPlaylistDraftPage, missingPlaylistDraftTableHtml, missingPlaylistDraftReorderSnapshot} = loaded.exports;
const native = createNativeHomeRuntime();
for (const file of ['compact-data-table.js', 'gallery-main-components.js', 'album-track-table.js', 'album-details-components.js', 'in-page-tabs.js', 'trigger-anchor.js', 'library-settings.js']) {
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), native.context);
}
const search = installNativeSearch(native);
const runtime = {escapeHtml: native.context.escapeHtml, buttonHtml: native.context.ButtonComponent.renderButton,
  openChoice: native.context.openUtilityChoiceDropdown,
  actionHtml: native.context.ButtonComponent.renderActionButton, alertHtml: native.context.buildOnPageAlertHtml,
  galleryBarHtml: native.context.buildGalleryBarHtml, tableHtml: native.context.buildCompactDataTable,
  artboxHtml: native.context.buildAlbumArtboxHtml, detailHeaderHtml: native.context.buildAlbumDetailsHeaderHtml,
  tabsHtml: native.context.buildInPageTabsHtml, mountTabs: native.context.mountInPageTabs, searchHtml: search.render,
  albumTrackRow: (row, index) => native.context.buildAlbumTrackTableRow({...row, duration: row.duration_display}, index, {readOnly: true}),
  downloadText() {},
};
let creation, draft;
test.before(async () => {
  creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  draft = await import('../../../music_app/static/js/playlists/draft.mjs');
});
const context = () => ({scopeKey: 'draft-components:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
  source: {kind: 'playlist', ref: 'draft-components:source', revision: 'original-revision',
    allowed_actions: {can_read: true, can_use_for_playlist: true}}});
const entry = (entry_ref, patch = {}) => ({entry_ref, canonical_track_ref: null, title: `Original ${entry_ref}`, artist: 'Artist',
  album_title: 'Album', duration_seconds: null, availability: 'unresolved', metadata_state: 'unknown',
  allowed_actions: {can_read: true, can_select: true},
  parent_album: {state: 'known', album_ref: 'exact-parent', title: 'Album',
    allowed_actions: {can_read: true, can_create_album_top: true, can_view_details: true}}, ...patch});
function session({entries = [entry('a'), entry('b', {availability: 'missing'})], writer, reader, token = 'local-page'} = {}) {
  const subject = context();
  const sourceResource = creation.normalizeCreationResult({status: 'ready', data: {...subject,
    allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true, entries, retained_parent_albums: []}}, subject);
  const prepared = creation.prepareMissingDraft({...subject, sourceResource, title: 'Missing originals', description: 'Typed description',
    selectedKeys: sourceResource.data.entries.filter(row => row.source_readable && row.availability !== 'local').map(row => row.row_key),
    mutation: {status: 'idle'}}, {draftToken: token});
  return draft.createMissingPlaylistDraftController({prepared, providers: {...(writer ? {createPlaylistFromSelection: writer} : {}), ...(reader ? {readPlaylistCreationSource: reader} : {})}});
}
const acknowledged = request => ({status: 'ready', data: {scopeKey: request.scopeKey, request_key: request.request_key,
  playlist_id: 'persisted-playlist', revision: 'persisted-revision'}});
const hostFor = html => {const host = native.document.createElement('div'); host.innerHTML = html; return host;};
const render = (controller, extra = {}) => renderToStaticMarkup(React.createElement(MissingPlaylistDraftPage,
  {runtime, controller, state: controller.getSnapshot(), onClose() {}, ...extra}));
const action = (host, name) => host.querySelector(`[data-playlists-draft-action="${name}"]`);
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const component = (tree, name) => elements(tree).find(element => element.type?.name === name);
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};

// Bounded hook lifetime probe: drives the real page handlers and effects without
// claiming React reconciliation, native history or browser acceptance coverage.
function pageLifecycle(name = 'MissingPlaylistDraftPage', host = null) {
  const slots = []; let cursor = 0, pending = [], disposed = false, lateUpdates = 0;
  let initialized = false;
  const changed = (old, deps) => !old || !deps || !old.deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const hooks = {...React, useId: () => 'draft-lifetime',
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useMemo(factory, deps) {const index = cursor++; if (changed(slots[index], deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useState(value) {const index = cursor++; slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slots[index].value, next => {if (disposed) lateUpdates++; slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];},
    useLayoutEffect(effect, deps) {const index = cursor++, old = slots[index];
      if (changed(old, deps)) pending.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: effect()};});},
  };
  const fixture = {exports: {}};
  vm.runInNewContext(built.outputFiles[0].text, {module: fixture, exports: fixture.exports,
    require: name => name === 'react' ? hooks : require(name), AbortController, TextEncoder, console});
  return {render(controller, extra = {}) {cursor = 0; pending = [];
    const state = controller.getSnapshot();
    const tree = fixture.exports[name]({runtime, controller, state, id: 'draft-adapter',
      projection: draft.projectMissingPlaylistDraft(state), disabled: false, onReview() {}, onClose() {}, ...extra});
    if (host) {
      const node = elements(tree).find(element => element.props.className?.includes('playlists-draft__tracks'));
      node.props.ref.current = host;
      if (!initialized) host.innerHTML = node.props.dangerouslySetInnerHTML.__html;
      initialized = true;
    }
    for (const effect of pending) effect(); return tree;},
    dispose() {disposed = true; for (const slot of slots) slot?.cleanup?.();}, lateUpdates: () => lateUpdates,
  };
}
const header = tree => component(tree, 'MissingPlaylistDraftHeader');
const trackHost = tree => elements(tree).find(element => element.props.className?.includes('playlists-draft__tracks'));
const rowKeys = host => host.querySelectorAll('[data-playlist-row-key]').map(row => row.dataset.playlistRowKey);

function trackLifecycle({gestures = false} = {}) {
  const env = createNativeHomeRuntime(), {document} = env;
  const host = document.createElement('div'); document.body.appendChild(host);
  const win = document.createElement('window'), frames = new Map(); let serial = 0;
  document.defaultView = win; document.scrollingElement = document.documentElement;
  Object.assign(document.documentElement, {scrollHeight: 600, clientHeight: 600});
  Object.assign(win, {innerHeight: 600, innerWidth: 800, getComputedStyle: () => ({overflowY: 'visible'}),
    requestAnimationFrame(callback) {const id = ++serial; frames.set(id, callback); return id;},
    cancelAnimationFrame(id) {frames.delete(id);}});
  host.constructor.prototype.focus = function () {if (this.isConnected && !this.disabled) document.activeElement = this;};
  if (gestures) {
    host.constructor.prototype.cloneNode = function (deep) {
      const clone = document.createElement(this.tagName);
      for (const {name, value} of this.attributes) clone.setAttribute(name, value);
      if (deep) for (const child of this.childNodes) clone.appendChild(child.nodeType === 3 ? document.createTextNode(child.textContent) : child.cloneNode(true));
      return clone;
    };
    host.constructor.prototype.getBoundingClientRect = function () {
      const index = host.querySelectorAll('[data-playlist-row-key]').indexOf(this), top = index < 0 ? 100 : 100 + index * 40;
      return {left: 20, right: 720, top, bottom: top + 40, width: 700, height: 40};
    };
  }
  const fixture = pageLifecycle('MissingPlaylistDraftTracks', host);
  return {...fixture, env, host, frames,
    emit(target, type, values = {}) {
      const event = Object.assign(new env.context.Event(type), {pointerId: 7, button: 0, isPrimary: true, clientX: 40, clientY: 120}, values);
      target.dispatchEvent(event); return event;
    },
    frame() {const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(16);},
    dispose() {
      fixture.dispose();
      assert.equal(frames.size, 0); assert.equal(host.listeners.length, 0);
      assert.equal(document.listeners.length, 0); assert.equal(win.listeners.length, 0);
      assert.deepEqual(env.forbiddenCalls, []); host.remove();
    },
  };
}

const metricEntries = () => [entry('unknown'), entry('high', {love_tier: 'obsessed', play_count: 9, popularity_count: 100, duration_seconds: 600, track_rating: 5}),
  entry('tie-first', {love_tier: 'loved', play_count: 3, popularity_count: 20, duration_seconds: 120, track_rating: 2}),
  entry('zero', {love_tier: 'off', play_count: 0, popularity_count: 0, duration_seconds: 0, track_rating: 1}),
  entry('tie-second', {love_tier: 'loved', play_count: 3, popularity_count: 20, duration_seconds: 120, track_rating: 4})];

test('draft metrics render supplied read-only facts and keep unavailable values honest', () => {
  const controller = session({entries: metricEntries()}), state = controller.getSnapshot();
  const html = missingPlaylistDraftTableHtml(runtime, {id: 'draft-metrics', state, projection: draft.projectMissingPlaylistDraft(state)}), host = hostFor(html);
  assert.deepEqual(host.querySelectorAll('[data-cdt-sort]').map(button => button.dataset.cdtSort),
    ['love_tier', 'play_count', 'popularity_count', 'duration']);
  const table = host.querySelector('.compact-data-table'), style = table.getAttribute('style');
  assert.equal(table.getAttribute('data-cdt-narrow'), 'true');
  const fullColumns = style.match(/--cdt-columns: ([^;]+)/)[1], narrowColumns = style.match(/--cdt-narrow-columns: ([^;]+)/)[1];
  assert.match(fullColumns, / 60px 112px 72px 100px 72px 40px$/);
  assert.equal(narrowColumns, fullColumns.replace(' 112px ', ' '), 'the shared narrow grid removes only Rating');
  const ratingCells = host.querySelectorAll('[data-cdt-column="track_rating"]');
  assert.equal(ratingCells.length, state.entries.length + 1);
  assert.ok(ratingCells.every(cell => cell.hasAttribute('data-cdt-hide-narrow')));
  for (const key of ['love_tier', 'play_count', 'popularity_count', 'duration']) {
    const cells = host.querySelectorAll(`[data-cdt-column="${key}"]`);
    assert.equal(cells.length, state.entries.length + 1);
    assert.ok(cells.every(cell => !cell.hasAttribute('data-cdt-hide-narrow')));
  }
  const known = host.querySelector('[data-playlist-row-key="entry:high"]');
  assert.equal(known.querySelector('[data-love-tier]').getAttribute('aria-label'), 'Obsessed');
  assert.equal(known.querySelector('[data-cdt-column="track_rating"] [role="img"]').getAttribute('aria-label'), 'Track rating: 5 out of 5');
  assert.equal(known.querySelector('[data-cdt-column="play_count"]').textContent, '9');
  assert.equal(known.querySelector('[data-cdt-column="popularity_count"]').textContent, '100');
  assert.equal(known.querySelector('[data-cdt-column="duration"]').textContent, '10:00');
  const unknown = host.querySelector('[data-playlist-row-key="entry:unknown"]');
  for (const key of ['love_tier', 'track_rating', 'play_count', 'popularity_count', 'duration']) {
    const cell = unknown.querySelector(`[data-cdt-column="${key}"]`);
    assert.equal(cell.textContent, '–'); assert.equal(cell.querySelector('button,input,select'), null);
    assert.equal(known.querySelector(`[data-cdt-column="${key}"]`).querySelector('button,input,select'), null);
  }
  const zero = host.querySelector('[data-playlist-row-key="entry:zero"]');
  assert.equal(zero.querySelector('[data-cdt-column="play_count"]').textContent, '0');
  assert.equal(zero.querySelector('[data-cdt-column="duration"]').textContent, '0:00');
  assert.doesNotMatch(html, /data-track-path=|data-src=|data-play-track=|data-rating-edit=|data-love-edit=/);
  controller.dispose();
});

test('draft metric header cycles preserve row-key selection, authored order, TXT and Save payloads', async t => {
  const requests = [], controller = session({entries: metricEntries(), writer: request => {requests.push(request); return acknowledged(request);}});
  const fixture = trackLifecycle(); t.after(() => {fixture.dispose(); controller.dispose();});
  controller.select('entry:tie-first');
  const authored = controller.getSnapshot(), keys = authored.entries.map(row => row.row_key), exported = controller.exportText();
  let tree = fixture.render(controller);
  for (const key of ['love_tier', 'play_count', 'popularity_count', 'duration']) {
    for (const [direction, expected] of [
      ['ascending', ['entry:zero', 'entry:tie-first', 'entry:tie-second', 'entry:high', 'entry:unknown']],
      ['descending', ['entry:high', 'entry:tie-first', 'entry:tie-second', 'entry:zero', 'entry:unknown']],
      ['none', keys],
    ]) {
      const button = fixture.host.querySelector(`[data-cdt-sort="${key}"]`); button.focus();
      trackHost(tree).props.onClick(fixture.env.event('click', button.querySelector('.compact-data-table__sort-label')));
      tree = fixture.render(controller);
      assert.deepEqual(rowKeys(fixture.host), expected);
      assert.equal(fixture.host.querySelector(`[role="columnheader"][data-cdt-column="${key}"]`).getAttribute('aria-sort'), direction);
      assert.equal(fixture.env.document.activeElement, fixture.host.querySelector(`[data-cdt-sort="${key}"]`));
      assert.equal(fixture.host.querySelector('[data-draft-pick="entry:tie-first"]').hasAttribute('checked'), true);
      assert.equal(fixture.host.querySelectorAll('[data-draft-pick]').filter(input => input.hasAttribute('checked')).length, 1);
      assert.equal(controller.getSnapshot(), authored, 'view sorting cannot publish an authored draft mutation');
      assert.equal(controller.exportText(), exported);
      const handles = fixture.host.querySelectorAll('[data-playlists-drag]');
      assert.ok(handles.every(button => button.disabled === (direction !== 'none')));
      if (direction !== 'none') assert.ok(fixture.host.querySelectorAll('[data-draft-move]').every(button => button.disabled));
    }
  }
  trackHost(tree).props.onClick(fixture.env.event('click', fixture.host.querySelector('[data-cdt-sort="play_count"]')));
  tree = fixture.render(controller);
  trackHost(tree).props.onChange({target: fixture.host.querySelector('[data-draft-pick="entry:high"]')});
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:tie-first', 'entry:high']);
  assert.deepEqual(controller.getSnapshot().entries.map(row => row.row_key), keys);
  assert.equal(controller.exportText(), exported);
  const result = await controller.save();
  assert.equal(result.playlist_id, 'persisted-playlist'); assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].entry_refs, ['unknown', 'high', 'tie-first', 'zero', 'tie-second']);
});

test('sorting synchronously cancels native drag and blocks manual and keyboard reorder before React commit', t => {
  const controller = session({entries: metricEntries()}), fixture = trackLifecycle({gestures: true});
  t.after(() => {fixture.dispose(); controller.dispose();});
  let tree = fixture.render(controller);
  const before = controller.getSnapshot(), first = fixture.host.querySelector('[data-playlists-drag]');
  const manual = fixture.host.querySelector('[data-playlist-row-key="entry:unknown"] [data-draft-move="down"]');
  fixture.emit(first, 'pointerdown'); fixture.emit(fixture.env.document, 'pointermove', {clientY: 200}); fixture.frame();
  assert.equal(fixture.host.classList.contains('is-reordering'), true);
  assert.notDeepEqual(rowKeys(fixture.host), before.entries.map(row => row.row_key));
  const heading = fixture.host.querySelector('[data-cdt-sort="play_count"]'); heading.focus();
  trackHost(tree).props.onClick(fixture.env.event('click', heading));
  assert.equal(fixture.host.classList.contains('is-reordering'), false);
  assert.equal(fixture.host.querySelector('.playlists__reorder-ghost'), null);
  assert.equal(fixture.env.document.listeners.length, 0); assert.equal(fixture.frames.size, 0);
  assert.deepEqual(rowKeys(fixture.host), before.entries.map(row => row.row_key));
  assert.equal(manual.disabled, false, 'the pre-commit native button still carries its previous visual state');
  trackHost(tree).props.onClick(fixture.env.event('click', manual));
  fixture.emit(first, 'keydown', {key: 'End'});
  fixture.emit(first, 'pointerdown'); fixture.emit(fixture.env.document, 'pointerup', {clientY: 240});
  assert.equal(fixture.env.document.listeners.length, 0); assert.equal(controller.getSnapshot(), before);
  tree = fixture.render(controller);
  assert.ok(fixture.host.querySelectorAll('[data-draft-move],[data-playlists-drag]').every(button => button.disabled));
  for (let index = 0; index < 2; index++) {
    trackHost(tree).props.onClick(fixture.env.event('click', fixture.host.querySelector('[data-cdt-sort="play_count"]')));
    tree = fixture.render(controller);
  }
  assert.deepEqual(rowKeys(fixture.host), before.entries.map(row => row.row_key));
  const restored = fixture.host.querySelector('[data-playlist-row-key="entry:unknown"] [data-playlists-drag]');
  assert.equal(restored.disabled, false);
  fixture.emit(restored, 'keydown', {key: 'End'});
  assert.deepEqual(controller.getSnapshot().entries.map(row => row.row_key),
    ['entry:high', 'entry:tie-first', 'entry:zero', 'entry:tie-second', 'entry:unknown']);
});

test('busy and denied draft headers expose disabled state and reject retained sorting handlers', t => {
  const controller = session({entries: metricEntries()}), fixture = trackLifecycle();
  t.after(() => {fixture.dispose(); controller.dispose();});
  const previous = fixture.render(controller), oldHeading = fixture.host.querySelector('[data-cdt-sort="play_count"]');
  let tree = fixture.render(controller, {disabled: true});
  const before = controller.getSnapshot();
  const busyPage = hostFor(render(controller, {busy: true}));
  assert.equal(busyPage.querySelectorAll('[data-cdt-sort]').length, 4);
  assert.ok(busyPage.querySelectorAll('[data-cdt-sort]').every(button => button.disabled && button.getAttribute('aria-disabled') === 'true'));
  for (const button of fixture.host.querySelectorAll('[data-cdt-sort]')) {
    assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.ok(button.classList.contains('ui-button'), 'disabled styling stays owned by the native Button');
    trackHost(tree).props.onClick(fixture.env.event('click', button));
  }
  trackHost(previous).props.onClick(fixture.env.event('click', oldHeading));
  tree = fixture.render(controller);
  assert.deepEqual(rowKeys(fixture.host), before.entries.map(row => row.row_key));
  assert.ok(fixture.host.querySelectorAll('[data-cdt-sort]').every(button => button.dataset.cdtSortDirection === 'default'));
  controller.setContext({...context(), canCreate: false});
  fixture.render(controller, {disabled: true});
  trackHost(tree).props.onClick(fixture.env.event('click', oldHeading));
  assert.equal(fixture.host.querySelectorAll('[data-playlist-row-key]').length, 0);
  assert.ok(fixture.host.querySelectorAll('[data-cdt-sort]').every(button => button.disabled));
  assert.doesNotMatch(fixture.host.innerHTML, /Original unknown|Original high|Original tie-first/);
});

test('unsaved page composes the native Playlist owners, editable metadata, compact Review and explicit unknown facts', () => {
  const controller = session({entries: [entry('a', {title: '<Unknown original>', private_path: '/private/music.flac'}),
    entry('b', {duration_seconds: 0, availability: 'missing', metadata_state: 'current'}), entry('local', {availability: 'local'})]});
  const html = render(controller), host = hostFor(html);
  assert.match(html, /gallery-bar__context|gallery-bar__actions/); assert.match(html, /compact-data-table/);
  assert.match(html, /album-track-table__title/); assert.match(html, /album-artbox--empty/);
  assert.match(html, /&lt;Unknown original&gt;/); assert.match(html, /Metadata freshness unknown/);
  assert.match(html, /Availability unknown/); assert.match(html, /Confirmed missing/); assert.match(html, /0:00/);
  assert.equal(host.querySelector('[aria-label="Playlist name"]').disabled, false);
  assert.equal(host.querySelector('[aria-label="Playlist description"]').disabled, false);
  assert.equal(action(host, 'save').disabled, true); assert.equal(action(host, 'export').disabled, false);
  assert.equal(action(host, 'top').disabled, true); assert.equal(action(host, 'close').disabled, false);
  assert.equal(host.querySelectorAll('[data-draft-review]').length, 2);
  assert.equal(host.querySelectorAll('[data-draft-remove]').length, 2);
  assert.ok([...host.querySelectorAll('.album-track-table__play')].every(button => button.disabled));
  assert.equal(host.querySelector('[data-playlist-row-key="entry:a"]').classList.contains('album-track-table__row--missing'), false);
  assert.equal(host.querySelector('[data-playlist-row-key="entry:b"]').classList.contains('album-track-table__row--missing'), true);
  assert.doesNotMatch(html, /private\/music|Original local|role="dialog"|<form|data-src=|data-track-path=|playlist_item_id|local-page/);
  controller.dispose();
});

test('real saved directory stays outside the local draft and the standard action order is stable', () => {
  const controller = session(), html = render(controller, {directory: React.createElement('aside', {'aria-label': 'Saved playlists'}, 'Existing playlist')});
  const host = hostFor(html);
  assert.equal(host.querySelector('.playlists').children.length, 2);
  assert.match(html, /Existing playlist/);
  const order = ['top', 'export', 'filters', 'save', 'close'].map(name => html.indexOf(`data-playlists-draft-action="${name}"`));
  assert.ok(order.every((value, index) => value >= 0 && (!index || value > order[index - 1])));
  assert.deepEqual([...host.querySelectorAll('[data-playlists-draft-action]')].map(button => button.getAttribute('aria-label')),
    ['Create Album Top', 'Export TXT', 'Filters', 'Save', 'Close playlist preview']);
  assert.ok([...host.querySelectorAll('[data-playlists-draft-action]')].every(button => button.classList.contains('action-button--bare') && button.querySelector('svg')));
  controller.dispose();
});

test('draft Availability choice filters retained originals and rejects an old choice handler after a newer edit', async () => {
  const controller = session(), fixture = pageLifecycle();
  await header(fixture.render(controller)).props.onAction('filters');
  const tree = fixture.render(controller), choice = component(tree, 'NativeChoice');
  assert.equal(choice.props.label, 'Availability'); assert.equal(choice.props.disabled, false);
  assert.deepEqual(Array.from(choice.props.options, ([value]) => value), ['all', 'local', 'missing', 'unresolved']);
  choice.props.onChange('missing');
  assert.equal(controller.getSnapshot().filters.availability, 'missing');
  const updated = fixture.render(controller), host = hostFor(renderToStaticMarkup(updated));
  assert.equal(host.querySelector('button[aria-label="Availability: Confirmed missing"]').disabled, false);
  assert.equal(host.querySelectorAll('[data-playlist-row-key]').length, 1);
  assert.ok(host.querySelector('[data-playlist-row-key="entry:b"]'));
  choice.props.onChange('unresolved');
  assert.equal(controller.getSnapshot().filters.availability, 'missing');
  const locked = component(fixture.render(controller, {busy: true}), 'NativeChoice');
  assert.equal(locked.props.disabled, true);
  locked.props.onChange('all'); assert.equal(controller.getSnapshot().filters.availability, 'missing');
  fixture.dispose(); controller.dispose();
});

test('pre-Save TXT uses retained complete draft order even when filters hide unknown originals and no writer exists', async () => {
  const controller = session(), fixture = pageLifecycle(), downloads = [];
  controller.reorder(['entry:b', 'entry:a']); controller.setQuery('Original b');
  const tree = fixture.render(controller, {runtime: {...runtime, downloadText: value => downloads.push(value)}});
  await header(tree).props.onAction('export');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].text, 'Artist - Original b [Album]\nArtist - Original a [Album]');
  assert.equal(downloads[0].filename, 'playlist-missing.txt');
  assert.equal(controller.getSnapshot().mutation.status, 'idle');
  const host = hostFor(render(controller));
  assert.equal(host.querySelectorAll('[data-playlist-row-key]').length, 1);
  assert.ok([...host.querySelectorAll('[data-draft-move],[data-playlists-drag]')].every(button => button.disabled));
  assert.equal(action(host, 'save').disabled, true); assert.equal(action(host, 'export').disabled, false);
  fixture.dispose(); controller.dispose();
});

test('selection and reorder remain local and retained unknown rows have the same Remove controls', () => {
  const controller = session(); controller.select('entry:a');
  let host = hostFor(render(controller));
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').getAttribute('aria-checked'), 'mixed');
  assert.equal(host.querySelector('[data-draft-pick="entry:a"]').hasAttribute('checked'), true);
  const snapshot = missingPlaylistDraftReorderSnapshot(controller);
  assert.equal(snapshot.draftToken, 'local-page'); assert.equal(snapshot.playlistId, undefined);
  assert.ok(snapshot.rows.every(row => row.playlist_item_id === undefined));
  assert.equal(snapshot.canReorder, true); assert.equal(snapshot.unfiltered, true);
  controller.remove(); host = hostFor(render(controller));
  assert.equal(host.querySelector('[data-playlist-row-key="entry:a"]'), null);
  assert.equal(host.querySelector('[data-playlist-row-key="entry:b"] [data-draft-remove]').disabled, false);
  assert.equal(controller.getSnapshot().mutation.status, 'idle'); controller.dispose();
});

test('draft highlight gestures preserve retained tracks, checkbox selection and the separate review target', t => {
  const controller = session({entries: [entry('a'), entry('b'), entry('c')]}), fixture = trackLifecycle(), reviews = [];
  t.after(() => {fixture.dispose(); controller.dispose();});
  const extra = {onReview: key => reviews.push(key)};
  const row = key => fixture.host.querySelector(`[data-playlist-row-key="entry:${key}"]`);
  const highlighted = () => fixture.host.querySelectorAll('[data-playlist-row-key][aria-selected="true"]').map(node => node.dataset.playlistRowKey);
  const original = controller.getSnapshot(), text = controller.exportText();
  let tree = fixture.render(controller, extra); const first = row('a');
  fixture.emit(first, 'click'); tree = fixture.render(controller, {...extra, reviewKey: 'entry:a'});
  assert.equal(row('a'), first); assert.deepEqual(highlighted(), ['entry:a']); assert.deepEqual(reviews, ['entry:a']);
  fixture.emit(row('b'), 'click', {ctrlKey: true}); tree = fixture.render(controller, extra);
  assert.deepEqual(highlighted(), ['entry:a', 'entry:b']); assert.deepEqual(reviews, ['entry:a']);
  assert.equal(fixture.emit(row('a'), 'contextmenu').defaultPrevented, true); tree = fixture.render(controller, extra);
  assert.deepEqual(highlighted(), ['entry:a', 'entry:b']);
  assert.match(elements(tree).find(element => element.props.role === 'status' && typeof element.props.children === 'string'
    && element.props.children.includes('Add to playlist')).props.children, /unsaved source tracks/);
  fixture.emit(row('a'), 'click', {metaKey: true}); tree = fixture.render(controller, extra);
  assert.deepEqual(highlighted(), ['entry:b']);
  fixture.emit(row('c'), 'contextmenu'); tree = fixture.render(controller, extra); assert.deepEqual(highlighted(), ['entry:c']);
  fixture.emit(row('a'), 'keydown', {key: ' ', ctrlKey: true}); tree = fixture.render(controller, extra);
  assert.deepEqual(highlighted(), ['entry:a', 'entry:c']); assert.deepEqual(reviews, ['entry:a']);
  fixture.emit(row('a'), 'dblclick'); fixture.emit(row('a'), 'keydown', {key: 'Enter', ctrlKey: true});
  assert.equal(controller.getSnapshot(), original); assert.equal(controller.exportText(), text);
  assert.equal(elements(tree).find(element => element.props.available === false).props.snapshot.selectedCount, 2);
  const checkbox = row('b').querySelector('[data-draft-pick]');
  trackHost(tree).props.onChange(fixture.env.event('change', checkbox)); tree = fixture.render(controller, extra);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:b']); assert.deepEqual(highlighted(), ['entry:a', 'entry:c']);
  const review = row('b').querySelector('[data-draft-review]');
  trackHost(tree).props.onClick(fixture.env.event('click', review));
  assert.deepEqual(reviews, ['entry:a', 'entry:b']); assert.deepEqual(highlighted(), ['entry:a', 'entry:c']);
  assert.deepEqual(controller.getSnapshot().entries, original.entries); assert.equal(controller.getSnapshot().dirty, false);
  const html = render(controller), output = hostFor(html);
  assert.equal([...output.querySelectorAll('button')].find(button => button.textContent === 'Add to playlist').disabled, true);
  assert.doesNotMatch(html, /data-track-path=|data-src=|data-play-track=/);
});

test('draft highlight follows displayed rows across sort and filter and clears on access retirement', t => {
  const controller = session({entries: [entry('a', {play_count: 9}), entry('b', {play_count: 1})]}), fixture = trackLifecycle();
  t.after(() => {fixture.dispose(); controller.dispose();});
  let tree = fixture.render(controller);
  const row = key => fixture.host.querySelector(`[data-playlist-row-key="entry:${key}"]`);
  fixture.emit(row('a'), 'click'); fixture.render(controller);
  fixture.emit(row('b'), 'click', {metaKey: true}); tree = fixture.render(controller);
  trackHost(tree).props.onClick(fixture.env.event('click', fixture.host.querySelector('[data-cdt-sort="play_count"]')));
  tree = fixture.render(controller);
  assert.deepEqual(rowKeys(fixture.host), ['entry:b', 'entry:a']);
  assert.equal(fixture.host.querySelectorAll('[data-playlist-row-key][aria-selected="true"]').length, 2);
  controller.setQuery('Original a'); fixture.render(controller); tree = fixture.render(controller);
  const selection = elements(tree).find(element => element.props.available === false).props.snapshot;
  assert.equal(selection.selectedCount, 1); assert.equal(selection.droppedCount, 1);
  controller.setContext({...context(), canCreate: false});
  assert.equal(fixture.host.querySelectorAll('[data-playlist-row-key][aria-selected="true"]').length, 0);
  assert.equal(fixture.emit(row('a'), 'contextmenu').defaultPrevented, false);
  assert.deepEqual(controller.getSnapshot().selectedKeys, []);
});

test('native row handlers remove and reorder local row keys, reject stale renders and detach after native return', () => {
  const env = createNativeHomeRuntime(), host = env.document.createElement('div'); env.document.body.appendChild(host);
  env.document.defaultView = env.document.createElement('window');
  const controller = session(), fixture = pageLifecycle('MissingPlaylistDraftTracks', host);
  const rows = tree => elements(tree).find(element => element.props.className?.includes('playlists-draft__tracks'));
  let tree = fixture.render(controller);
  const move = host.querySelector('[data-playlist-row-key="entry:a"] [data-draft-move="down"]');
  rows(tree).props.onClick(env.event('click', move));
  assert.deepEqual(controller.getSnapshot().entries.map(row => row.row_key), ['entry:b', 'entry:a']);
  const previous = tree; tree = fixture.render(controller);
  const remove = host.querySelector('[data-draft-remove="entry:b"]');
  rows(previous).props.onClick(env.event('click', remove)); assert.equal(controller.getSnapshot().entries.length, 2);
  rows(tree).props.onClick(env.event('click', remove)); assert.equal(controller.getSnapshot().entries.length, 1);
  tree = fixture.render(controller); const last = host.querySelector('[data-draft-remove="entry:a"]');
  fixture.dispose(); rows(tree).props.onClick(env.event('click', last));
  assert.equal(controller.getSnapshot().entries.length, 1); assert.equal(fixture.lateUpdates(), 0);
  assert.equal(host.listeners.length, 0); assert.equal(controller.getSnapshot().mutation.status, 'idle'); controller.dispose();
});

test('Top opens only with exact current authorized parents and a configured opener, without saving', async () => {
  let writes = 0; const opened = [], controller = session({writer: request => {writes++; return acknowledged(request);}}), fixture = pageLifecycle();
  assert.equal(action(hostFor(render(controller)), 'top').disabled, true);
  let tree = fixture.render(controller, {onTop: intent => opened.push(intent)});
  assert.equal(header(tree).props.actions.top, true);
  await header(tree).props.onAction('top');
  assert.deepEqual(opened, [{scopeKey: 'draft-components:actor', source: {kind: 'playlist', ref: 'draft-components:source', revision: 'original-revision'}, album_refs: ['exact-parent']}]);
  assert.equal(writes, 0); assert.equal(controller.getSnapshot().mutation.status, 'idle');
  controller.setContext({...context(), canCreateAlbumTop: false});
  tree = fixture.render(controller, {onTop: intent => opened.push(intent)});
  assert.equal(header(tree).props.actions.top, false); await header(tree).props.onAction('top'); assert.equal(opened.length, 1);
  fixture.dispose(); controller.dispose();
});

test('Close delegates native discard ownership with no local disposal, save or selection loss', async () => {
  let writes = 0; const closes = [], controller = session({writer: request => {writes++; return acknowledged(request);}}), fixture = pageLifecycle();
  controller.edit({title: 'Keep typed title'}); controller.reorder(['entry:b', 'entry:a']); controller.select('entry:a');
  const before = controller.getSnapshot(), tree = fixture.render(controller, {onClose: value => closes.push(value)});
  await header(tree).props.onAction('close');
  assert.equal(closes.length, 1); assert.equal(closes[0].reason, 'discard'); assert.equal(closes[0].restoreFocusRequested, true);
  assert.equal(controller.getSnapshot(), before); assert.equal(writes, 0);
  fixture.dispose(); controller.dispose();
});

test('Save rejects duplicate clicks and reports only the exact real acknowledgement to native navigation', async () => {
  const write = deferred(), requests = [], saved = [], controller = session({writer: request => {requests.push(request); return write.promise;}});
  const fixture = pageLifecycle(), tree = fixture.render(controller, {onSaved: value => saved.push(value)});
  const first = header(tree).props.onAction('save'), second = header(tree).props.onAction('save');
  assert.equal(requests.length, 1); assert.equal(saved.length, 0);
  const host = hostFor(render(controller));
  assert.equal(action(host, 'save').disabled, true); assert.equal(action(host, 'close').disabled, true);
  assert.equal(host.querySelector('[aria-label="Playlist name"]').disabled, true);
  write.resolve(acknowledged(requests[0])); await Promise.all([first, second]);
  assert.deepEqual(saved, [acknowledged(requests[0]).data]);
  assert.equal(saved[0].playlist_id, 'persisted-playlist'); assert.equal(requests[0].playlist_id, null);
  assert.equal(requests[0].draftToken, undefined); assert.deepEqual(requests[0].entry_refs, ['a', 'b']);
  const complete = fixture.render(controller); await header(complete).props.onAction('save'); assert.equal(requests.length, 1);
  fixture.dispose(); controller.dispose();
});

test('saved-but-not-opened completion is explicit and never retries the writer', async () => {
  let writes = 0; const controller = session({writer: request => {writes++; return acknowledged(request);}}), fixture = pageLifecycle();
  const tree = fixture.render(controller, {onSaved: () => false}); await header(tree).props.onAction('save');
  const complete = fixture.render(controller, {onSaved: () => false});
  const messages = elements(complete).filter(element => element.type?.name === 'NativeHtml').map(element => element.props.html).join('\n');
  assert.match(messages, /Playlist saved, but it could not be opened/);
  await header(complete).props.onAction('save'); assert.equal(writes, 1);
  fixture.dispose(); controller.dispose();
});

test('stale rendered commands cannot export, save, close or open Top after a newer edit', async () => {
  const calls = [], controller = session({writer: request => {calls.push('save'); return acknowledged(request);}}), fixture = pageLifecycle();
  const tree = fixture.render(controller, {runtime: {...runtime, downloadText: () => calls.push('export')},
    onTop: () => calls.push('top'), onClose: () => calls.push('close')});
  controller.edit({description: 'A newer render owns the next action'});
  for (const command of ['save', 'export', 'top', 'close']) await header(tree).props.onAction(command);
  assert.deepEqual(calls, []); fixture.dispose(); controller.dispose();
});

test('a new draft controller rejects old page handlers even when the old controller still has its unchanged snapshot', async () => {
  const calls = [], previous = session({writer: request => {calls.push('save'); return acknowledged(request);}});
  const current = session({token: 'new-local-page'}), fixture = pageLifecycle();
  const tree = fixture.render(previous, {runtime: {...runtime, downloadText: () => calls.push('export')},
    onTop: () => calls.push('top'), onClose: () => calls.push('close')});
  fixture.render(current);
  for (const command of ['save', 'export', 'top', 'close']) await header(tree).props.onAction(command);
  const name = elements(tree).find(element => element.props['aria-label'] === 'Playlist name');
  name.props.onChange({target: {value: 'Stale name'}});
  assert.deepEqual(calls, []); assert.equal(previous.getSnapshot().title, 'Missing originals');
  fixture.dispose(); previous.dispose(); current.dispose();
});

test('pending native Close blocks duplicate confirmations and cancellation keeps the full draft', async () => {
  const controller = session(), fixture = pageLifecycle(), confirmation = deferred(); let closes = 0;
  const before = controller.getSnapshot();
  const tree = fixture.render(controller, {onClose: () => {closes++; return confirmation.promise;}});
  const first = header(tree).props.onAction('close'), second = header(tree).props.onAction('close');
  const name = elements(tree).find(element => element.props['aria-label'] === 'Playlist name');
  name.props.onChange({target: {value: 'Attempt during confirmation'}});
  assert.equal(closes, 1); confirmation.resolve(false); await Promise.all([first, second]);
  assert.equal(controller.getSnapshot(), before);
  const ready = fixture.render(controller); assert.equal(header(ready).props.busy, false);
  fixture.dispose(); controller.dispose();
});

test('parent busy and replaced Top callbacks invalidate retained handlers without changing the source snapshot', async () => {
  const calls = [], controller = session({writer: request => {calls.push('save'); return acknowledged(request);}}), fixture = pageLifecycle();
  const top = () => calls.push('top'), close = () => calls.push('close');
  const tree = fixture.render(controller, {onTop: top, onClose: close});
  fixture.render(controller, {onTop: top, onClose: close, busy: true});
  await header(tree).props.onAction('save'); await header(tree).props.onAction('close');
  const name = elements(tree).find(element => element.props['aria-label'] === 'Playlist name');
  name.props.onChange({target: {value: 'Attempt during native navigation'}});
  assert.equal(controller.getSnapshot().title, 'Missing originals');
  fixture.render(controller, {onClose: close}); await header(tree).props.onAction('top');
  assert.deepEqual(calls, []); fixture.dispose(); controller.dispose();
});

test('revocation clears readable facts and old save continuations cannot navigate the newer page', async () => {
  const write = deferred(), saved = [], controller = session({writer: () => write.promise}), fixture = pageLifecycle();
  const tree = fixture.render(controller, {onSaved: value => saved.push(value)}), pending = header(tree).props.onAction('save');
  controller.setContext({...context(), canCreate: false});
  fixture.render(controller, {onSaved: value => saved.push(value)});
  const html = render(controller); assert.doesNotMatch(html, /Original a|Original b|Typed description/); assert.match(html, /permission/);
  write.resolve({status: 'ready', data: {scopeKey: 'draft-components:actor', request_key: 'old', playlist_id: 'old', revision: 'old'}});
  await pending; assert.deepEqual(saved, []);
  fixture.dispose(); controller.dispose();
});

test('unmounted page ignores pending Save and TXT failures without late UI updates', async () => {
  for (const kind of ['save', 'export']) {
    const operation = deferred(), saved = [], controller = session({writer: () => operation.promise}), fixture = pageLifecycle();
    const tree = fixture.render(controller, {runtime: {...runtime, downloadText: () => operation.promise}, onSaved: value => saved.push(value)});
    const pending = header(tree).props.onAction(kind); fixture.dispose();
    operation.reject(new Error('late response')); await pending;
    assert.equal(fixture.lateUpdates(), 0); assert.deepEqual(saved, []); controller.dispose();
  }
});

test('Review is the normal read-only information panel; unknown original identity is never a matching or player key', () => {
  const controller = session(), fixture = pageLifecycle();
  let tree = fixture.render(controller);
  component(tree, 'MissingPlaylistDraftTracks').props.onReview('entry:a');
  tree = fixture.render(controller);
  const panel = component(tree, 'PlaylistSelectionPanel');
  assert.equal(panel.props.row.album_ref, 'exact-parent'); assert.equal(panel.props.row.playlist_item_id, undefined);
  assert.equal(panel.props.row.entry_ref, undefined); assert.equal(panel.props.row.canonical_track_ref, undefined);
  const markup = renderToStaticMarkup(tree); assert.match(markup, /Track information/); assert.match(markup, /Local matching unavailable/);
  assert.doesNotMatch(markup, /Accept selected local match|data-src=|data-track-path=/);
  controller.setQuery('Original b'); tree = fixture.render(controller);
  assert.equal(component(tree, 'PlaylistSelectionPanel'), undefined);
  fixture.dispose(); controller.dispose();
});

test('rendering a source row uses only safe display facts and source-free native markup', () => {
  const controller = session(), state = controller.getSnapshot(), passed = [];
  missingPlaylistDraftTableHtml({...runtime, albumTrackRow: (row, index) => {passed.push(row); return runtime.albumTrackRow(row, index);}},
    {id: 'draft-safe', state, projection: draft.projectMissingPlaylistDraft(state)});
  assert.ok(passed.length > 0);
  assert.ok(passed.every(row => Object.keys(row).sort().join(',') === 'availability,duration_display,secondary_artist,title'));
  const source = fs.readFileSync(path.join(repo, 'music_app/static/js/playlists/draft.jsx'), 'utf8');
  assert.doesNotMatch(source, /createPlaylistIntegrations|trackIntent\(|acceptMatch\(|createAlbumTop\(|localStorage|sessionStorage|indexedDB|fetch\(/);
  controller.dispose();
});


test('draft filter opening retires across real paused authority and refresh while its values remain', async () => {
  const response = () => ({status: 'ready', data: {...context(), entries_complete: true,
    allowed_actions: {can_read: true, can_use_for_playlist: true}, entries: [entry('a'), entry('b')], retained_parent_albums: []}});
  const controller = session({reader: async () => response()}), fixture = pageLifecycle();
  await header(fixture.render(controller)).props.onAction('filters');
  let tree = fixture.render(controller);
  assert.ok(component(tree, 'PlaylistFilterSurface'));
  controller.setQuery('Original'); controller.setFilters({love: 'loved'});
  assert.ok(component(fixture.render(controller), 'PlaylistFilterSurface'));
  const token = controller.getSnapshot().draftToken;
  controller.pauseSource('error');
  assert.equal(component(fixture.render(controller), 'PlaylistFilterSurface'), undefined);
  controller.setContext(context()); assert.equal(await controller.refresh(), true);
  assert.equal(controller.getSnapshot().draftToken, token);
  assert.equal(controller.getSnapshot().query, 'Original');
  assert.equal(controller.getSnapshot().filters.love, 'loved');
  assert.equal(component(fixture.render(controller), 'PlaylistFilterSurface'), undefined);
  await header(fixture.render(controller)).props.onAction('filters');
  tree = fixture.render(controller); assert.ok(component(tree, 'PlaylistFilterSurface'));
  const staleChoice = component(tree, 'NativeChoice');
  // Loading and ready both publish before the next React commit.
  assert.equal(await controller.refresh(), true);
  assert.equal(component(fixture.render(controller), 'PlaylistFilterSurface'), undefined);
  staleChoice.props.onChange('missing'); assert.equal(controller.getSnapshot().filters.availability, 'all');
  fixture.dispose(); controller.dispose();
});

test('a retired draft filter close cannot dismiss a new opening and unmount invalidates changes', async () => {
  const controller = session(), fixture = pageLifecycle();
  await header(fixture.render(controller)).props.onAction('filters');
  let tree = fixture.render(controller), oldClose = component(tree, 'PlaylistFilterSurface').props.onClose;
  oldClose(); fixture.render(controller);
  await header(fixture.render(controller)).props.onAction('filters');
  tree = fixture.render(controller); const key = component(tree, 'PlaylistFilterSurface').key;
  oldClose(); assert.equal(component(fixture.render(controller), 'PlaylistFilterSurface').key, key);
  const staleChoice = component(tree, 'NativeChoice'); fixture.dispose();
  staleChoice.props.onChange('missing'); assert.equal(controller.getSnapshot().filters.availability, 'all');
  controller.dispose();
});
