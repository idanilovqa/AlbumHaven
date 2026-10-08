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
const {installNativeSearch} = require('./native-search-harness.cjs');

const repo = path.resolve(__dirname, '../../..'), source = path.join(repo, 'music_app/static/js/playlists');
const model = import(pathToFileURL(path.join(source, 'creation.mjs')));
const built = buildSync({entryPoints: [path.join(source, 'creation.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']});
const loaded = new Module(__filename + '.creation', module);
loaded.filename = __filename + '.creation'; loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {CreationForm, creationResultsHtml, creationReviewRow} = loaded.exports;
const native = createNativeHomeRuntime();
for (const file of ['compact-data-table.js', 'album-track-table.js', 'album-details-components.js', 'in-page-tabs.js']) {
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), native.context);
}
const searches = [];
const search = installNativeSearch(native);
const runtime = {
  escapeHtml: native.context.escapeHtml, buttonHtml: native.context.ButtonComponent.renderButton,
  actionHtml: native.context.ButtonComponent.renderActionButton, alertHtml: native.context.buildOnPageAlertHtml,
  tableHtml: native.context.buildCompactDataTable, artboxHtml: native.context.buildAlbumArtboxHtml,
  detailHeaderHtml: native.context.buildAlbumDetailsHeaderHtml, tabsHtml: native.context.buildInPageTabsHtml,
  mountTabs: native.context.mountInPageTabs,
  albumTrackRow: (row, index) => native.context.buildAlbumTrackTableRow({...row, duration: row.duration_display}, index, {readOnly: true}),
  searchHtml(config) {searches.push(config); return search.render(config);},
};
const hostFor = html => {const host = native.document.createElement('div'); host.innerHTML = html; return host;};
const render = (controller, extra = {}) => renderToStaticMarkup(React.createElement(CreationForm,
  {runtime, controller, state: controller.getSnapshot(), ...extra}));
const button = (host, label) => [...host.querySelectorAll('button')].find(node => node.textContent === label);

// Bounded adapter lifetime probe, following home-friends-components.test.js.
// This drives the real handlers/effects, not React reconciliation or browser UI.
function lifecycle(name, host = null) {
  const slots = []; let cursor = 0, pending = [], initialized = false, disposed = false, lateUpdates = 0;
  const changed = (old, deps) => !old || !deps || !old.deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const hooks = {...React,
    useId: () => `adapter-${name}`,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useMemo(factory, deps) {const index = cursor++; if (changed(slots[index], deps)) slots[index] = {deps, value: factory()}; return slots[index].value;},
    useState(value) {
      const index = cursor++; slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slots[index].value, next => {if (disposed) lateUpdates++; slots[index].value = next;}];
    },
    useLayoutEffect(effect, deps) {
      const index = cursor++, old = slots[index];
      if (changed(old, deps)) pending.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: effect()};});
    },
  };
  const fixture = {exports: {}};
  vm.runInNewContext(built.outputFiles[0].text, {module: fixture, exports: fixture.exports,
    require: name => name === 'react' ? hooks : require(name), AbortController, console});
  return {
    render(props) {
      cursor = 0; pending = [];
      const tree = fixture.exports[name](props);
      if (host) {
        const node = elements(tree).find(element => element.props.dangerouslySetInnerHTML && element.props.ref);
        node.props.ref.current = host;
        if (!initialized) host.innerHTML = node.props.dangerouslySetInnerHTML.__html;
      }
      initialized = true; for (const effect of pending) effect(); return tree;
    },
    dispose() {disposed = true; for (const slot of slots) slot?.cleanup?.();},
    lateUpdates: () => lateUpdates,
  };
}
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};

// Synthetic source-only fixtures never enter a production provider or default.
const parent = (patch = {}) => ({state: 'known', album_ref: 'album-one', title: 'Source album', artist: 'Artist',
  year: 2004, availability: 'local', completeness: 'unknown', allowed_actions: {can_view_details: true}, ...patch});
const entry = (entry_ref, patch = {}) => ({entry_ref, canonical_track_ref: null, title: `Original ${entry_ref}`, artist: 'Artist',
  album_title: 'Source album', track_number: null, disc_number: null, duration_seconds: null, artwork_url: null,
  metadata_state: 'unknown', availability: 'unresolved', allowed_actions: {can_read: true, can_select: true},
  parent_album: parent(), ...patch});
async function session({mode = 'ordinary', entries = [], sourceStatus = 'ready', dataPatch = {}, writer} = {}) {
  const {createPlaylistCreationController} = await model;
  const context = {scopeKey: 'test-scope', mode, canCreate: true,
    source: {kind: mode === 'ordinary' ? 'library' : 'playlist', ref: 'test-source', revision: 'source-revision',
      allowed_actions: {can_read: true, can_use_for_playlist: true}}};
  const controller = createPlaylistCreationController({providers: {
    readPlaylistCreationSource: async () => ({status: sourceStatus, data: {
      scopeKey: context.scopeKey, mode, source: {kind: context.source.kind, ref: context.source.ref, revision: context.source.revision},
      allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true, entries,
      retained_parent_albums: [], ...dataPatch}}),
    createPlaylistFromSelection: writer || (async request => ({status: 'ready', data: {scopeKey: request.scopeKey,
      request_key: request.request_key, playlist_id: 'created-playlist', revision: 'created-revision'}})),
  }});
  controller.setContext(context); await controller.load(); return controller;
}

test('ordinary creation delegates native search, tabs, form controls and supports a complete empty source', async () => {
  const controller = await session(); controller.edit({title: 'My <playlist>', description: 'A description'});
  const html = render(controller), host = hostFor(html), search = searches.at(-1);
  assert.match(html, /My &lt;playlist&gt;/); assert.match(html, /search-field-control/);
  // This bounded HTML fixture preserves SSR attribute case; browser HTML
  // getAttribute treats maxLength and maxlength identically.
  const maximumLength = node => [...node.attributes].find(attribute => attribute.name.toLowerCase() === 'maxlength')?.value;
  assert.equal(maximumLength(host.querySelector('[aria-label="Playlist name"]')), '100');
  assert.equal(maximumLength(host.querySelector('[aria-label="Playlist description"]')), '1000');
  assert.equal(button(host, 'Create playlist').disabled, false);
  assert.equal(host.querySelector('[data-in-page-tab="selected"]').textContent, 'Selected (0)');
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').disabled, true);
  assert.match(html, /No tracks are available in this source/);
  assert.equal(search.label, 'Search tracks, albums or artists'); assert.equal(search.disabled, false);
  assert.notEqual(search.id, 'search-input'); assert.match(search.id, /^playlist-creation-/);
  controller.dispose();
});

test('ordinary creation keeps unresolved originals selectable and labels confirmed missing album members', async () => {
  const controller = await session({entries: [entry('local', {title: 'Local song', availability: 'local'}),
    entry('missing', {availability: 'missing'}), entry('unknown', {title: 'Unresolved <original>'}),
  ], dataPatch: {retained_parent_albums: [parent({album_ref: 'retained-only', title: 'Retained parent only',
    allowed_actions: {can_read: true}})]}});
  controller.edit({title: 'Chosen originals'}); controller.toggle('entry:missing'); controller.toggle('entry:unknown');
  const html = render(controller), host = hostFor(html), inputs = [...host.querySelectorAll('[data-creation-pick]')];
  assert.equal(inputs.length, 3); assert.equal(inputs.filter(input => input.hasAttribute('checked')).length, 2);
  assert.match(html, /Local song/); assert.match(html, /Unresolved &lt;original&gt;/);
  assert.match(html, /Availability unresolved/); assert.match(html, /Incomplete/);
  assert.match(html, /Selected \(2\)/); assert.equal(button(host, 'Create playlist').disabled, false);
  assert.equal(host.querySelector('[data-creation-row-key="entry:missing"]').classList.contains('album-track-table__row--missing'), true);
  assert.equal(host.querySelector('[data-creation-row-key="entry:unknown"]').classList.contains('album-track-table__row--missing'), false);
  assert.doesNotMatch(html, /Retained parent only|retained-only|0:00|data-src=|data-track-path=|play-track-button/);
  for (const cell of host.querySelectorAll('[role="cell"][data-cdt-column="number"]')) assert.equal(cell.textContent, '—');
  controller.dispose();
});

test('visible selection exposes mixed state against the filtered eligible set, while Selected keeps chosen order', async () => {
  const controller = await session({entries: [entry('a', {title: 'Find a'}), entry('b', {title: 'Find b'}), entry('c', {title: 'Elsewhere'})]});
  controller.edit({title: 'Selection'});
  const rows = controller.getSnapshot().sourceResource.data.entries;
  controller.toggle(rows[2].row_key); controller.toggle(rows[0].row_key); controller.setQuery('find');
  let host = hostFor(render(controller));
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').getAttribute('aria-checked'), 'mixed');
  assert.equal(host.querySelectorAll('[data-creation-pick]').length, 2);
  assert.equal(host.querySelector('[data-in-page-tab="selected"]').textContent, 'Selected (2)');
  controller.setTab('selected'); host = hostFor(render(controller));
  assert.deepEqual([...host.querySelectorAll('[data-creation-pick]')].map(input => input.dataset.creationPick), [rows[2].row_key, rows[0].row_key]);
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').hasAttribute('checked'), true);
  controller.dispose();
});

test('ordinary creation does not treat uncertain parent labels as an identified incomplete album', async () => {
  const controller = await session({entries: [entry('unknown-parent', {availability: 'missing',
    parent_album: parent({state: 'ambiguous', album_ref: null, title: 'Uncertain album'})})]});
  controller.edit({title: 'Choose originals'}); controller.selectVisible(false);
  const html = render(controller), host = hostFor(html);
  assert.match(html, /Uncertain album/); assert.match(html, /Confirmed missing/); assert.doesNotMatch(html, /Incomplete/);
  assert.equal(button(host, 'Create playlist').disabled, false);
  controller.dispose();
});

test('unreadable and identity-free rows cannot enter selection or disclose source facts', async () => {
  const controller = await session({entries: [entry('hidden', {title: 'Restricted title', artwork_url: '/art/restricted', availability: 'missing',
    allowed_actions: {can_read: false, can_select: true}}), entry(null, {title: 'Display only'})]});
  const html = render(controller), host = hostFor(html);
  assert.doesNotMatch(html, /Restricted title|art\/restricted/); assert.match(html, /Unavailable track|Display only/);
  assert.equal([...host.querySelectorAll('[data-creation-pick]')].every(input => input.disabled), true);
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').disabled, true);
  assert.equal(host.querySelectorAll('[data-creation-review]').length, 1);
  assert.equal(host.querySelector('[data-creation-row-key="projection:0"]').classList.contains('album-track-table__row--missing'), false);
  controller.dispose();
});

test('native read-only cells preserve zero duration without inventing absent numbers, durations or playback', async () => {
  const controller = await session({entries: [entry('zero', {track_number: 7, disc_number: 2, duration_seconds: 0}), entry('unknown')]});
  const state = controller.getSnapshot(), {projectCreationState} = await model;
  const html = creationResultsHtml(runtime, {id: 'facts', projection: projectCreationState(state), selectedKeys: [], disabled: false});
  const host = hostFor(html);
  assert.deepEqual([...host.querySelectorAll('[role="cell"][data-cdt-column="number"]')].map(node => node.textContent), ['7', '—']);
  assert.deepEqual([...host.querySelectorAll('[role="cell"][data-cdt-column="duration"]')].map(node => node.textContent), ['0:00', '—']);
  assert.match(html, /album-track-table__title/); assert.match(html, /compact-data-table/); assert.match(html, /album-artbox--empty/);
  assert.doesNotMatch(html, /data-track-row-path|data-src|data-track-path|data-track-duration-path|play-track-button/);
  controller.dispose();
});

test('unavailable, denied, error, conflict and incomplete sources never advertise All or enable Create', async () => {
  for (const [sourceStatus, dataPatch, expected] of [['unavailable', {}, /not available/], ['denied', {}, /permission/],
    ['error', {}, /could not be loaded/], ['ready', {source: {kind: 'library', ref: 'test-source', revision: 'changed'}}, /source changed/],
    ['ready', {entries_complete: false}, /source is incomplete/]]) {
    const controller = await session({sourceStatus, dataPatch, entries: [entry('private', {title: 'Stale data'})]});
    const html = render(controller), host = hostFor(html);
    assert.match(html, expected); assert.doesNotMatch(html, /Stale data|data-creation-pick|data-in-page-tab=/);
    assert.equal(button(host, 'Create playlist').disabled, true); assert.equal(searches.at(-1).disabled, true);
    controller.dispose();
  }
});

test('writes disable edits and dismissal, then confirmed creation remains terminal', async () => {
  let accept;
  const controller = await session({entries: [entry('one')], writer: request => new Promise(resolve => {accept = () => resolve({status: 'ready',
    data: {scopeKey: request.scopeKey, request_key: request.request_key, playlist_id: 'created-playlist', revision: 'created-revision'}});})});
  controller.edit({title: 'Create once'});
  const pending = controller.submit(); await Promise.resolve();
  let host = hostFor(render(controller));
  assert.equal(host.querySelector('form').getAttribute('aria-busy'), 'true');
  assert.equal(host.querySelector('[aria-label="Playlist name"]').disabled, true);
  assert.equal(host.querySelector('fieldset').disabled, true);
  assert.equal(button(host, 'Create playlist').disabled, true); assert.equal(button(host, 'Discard').disabled, true);
  accept(); await pending; const html = render(controller); host = hostFor(html);
  assert.match(html, /Playlist created\./); assert.equal(button(host, 'Create playlist').disabled, true);
  assert.equal(button(host, 'Close').disabled, false); assert.equal(host.querySelector('[data-creation-pick]').disabled, true);
  controller.dispose();
});

test('Review uses the existing read-only panel and independently gated album identity without item or media references', async () => {
  const controller = await session({entries: [entry('review', {title: '<Original>', parent_album: parent({allowed_actions: {can_view_details: false}})})]});
  const value = controller.getSnapshot().sourceResource.data.entries[0]; controller.review(value.row_key);
  const row = creationReviewRow(value, controller.getSnapshot().source), html = render(controller);
  assert.equal(row.album_ref, 'album-one'); assert.equal(row.allowed_actions.can_view_details, false);
  assert.equal(row.playlist_item_id, undefined); assert.equal(row.entry_ref, undefined); assert.equal(row.canonical_track_ref, undefined);
  assert.equal(row.source_kind, 'library');
  assert.match(html, /Track information/); assert.match(html, /Metadata freshness unknown/); assert.match(html, /Availability unresolved/);
  assert.match(html, /Close selection/); assert.match(html, /data-in-page-tab="album"/);
  assert.doesNotMatch(html, /Accept match|Candidate|data-src=|data-track-path=/);
  assert.equal(creationReviewRow({...value, source_readable: false}, controller.getSnapshot().source), null);
  assert.equal(creationReviewRow({...value, parent_album: {...value.parent_album, state: 'ambiguous'}}, controller.getSnapshot().source).album_ref, null);
  controller.dispose();
});

test('controlled native Search keeps its field and clears disabled semantics when the source becomes ready', () => {
  const env = createNativeHomeRuntime(), search = installNativeSearch(env);
  const host = env.document.createElement('div'); env.document.body.appendChild(host);
  const fixture = lifecycle('CreationSearch', host), changes = [];
  const props = {runtime: {searchHtml: search.render}, id: 'creation-search-adapter', value: '', disabled: true,
    onChange: value => changes.push(value)};
  fixture.render(props); const input = host.querySelector('input[type="search"]');
  assert.equal(input.disabled, true); assert.equal(input.getAttribute('aria-disabled'), 'true');
  const tree = fixture.render({...props, value: 'original', disabled: false});
  assert.equal(host.querySelector('input[type="search"]'), input); assert.equal(input.value, 'original');
  assert.equal(input.disabled, false); assert.equal(input.hasAttribute('aria-disabled'), false);
  assert.equal(host.querySelector('[data-search-clear]').hidden, false);
  assert.equal([...host.querySelectorAll('button')].every(button => !button.disabled && !button.hasAttribute('aria-disabled')), true);
  input.value = 'changed'; tree.props.onInput(env.event('input', input)); assert.deepEqual(changes, ['changed']);
  const enter = env.event('keydown', input); enter.key = 'Enter'; tree.props.onKeyDown(enter);
  assert.equal(enter.defaultPrevented, true); assert.equal(enter.stopped, true);
  fixture.render({...props, value: 'changed'}); assert.equal(input.disabled, true);
  assert.equal(host.querySelector('[data-search-clear]').hidden, true);
  fixture.dispose(); host.remove();
});

test('picker highlight, checkbox authoring and Review remain separate across source groups', async () => {
  const controller = await session({entries: [entry('first'), entry('second', {parent_album: parent({album_ref: 'other-album'})}),
    entry('third', {parent_album: parent({album_ref: 'last-album'})})]});
  const {projectCreationState} = await model;
  const host = native.document.createElement('div'); native.document.body.appendChild(host);
  const fixture = lifecycle('CreationResults', host), props = () => ({runtime, id: 'actions', controller,
    state: controller.getSnapshot(), projection: projectCreationState(controller.getSnapshot()), disabled: false});
  const target = key => host.querySelector(`[data-creation-row-key="entry:${key}"]`);
  const emit = (key, type, patch = {}) => {
    const event = Object.assign(new native.context.Event(type), {button: 0}, patch);
    target(key).dispatchEvent(event); return event;
  };
  const selected = () => [...host.querySelectorAll('[aria-selected="true"][data-creation-row-key]')].map(row => row.dataset.creationRowKey);
  const resultHost = tree => elements(tree).find(element => element.props.className === 'album-track-table playlists-creation__results');
  let tree = fixture.render(props()); const first = target('first');
  emit('first', 'click'); tree = fixture.render(props());
  assert.deepEqual(selected(), ['entry:first']); assert.equal(target('first'), first);
  assert.equal(controller.getSnapshot().reviewKey, 'entry:first'); assert.equal(controller.getSnapshot().dirty, false);
  emit('second', 'click', {ctrlKey: true}); tree = fixture.render(props());
  assert.deepEqual(selected(), ['entry:first', 'entry:second']); assert.equal(controller.getSnapshot().reviewKey, 'entry:first');
  assert.equal(emit('second', 'contextmenu').defaultPrevented, true); tree = fixture.render(props());
  assert.deepEqual(selected(), ['entry:first', 'entry:second']);
  assert.equal(elements(tree).find(element => element.props.available === false).props.snapshot.selectedCount, 2);
  assert.match(elements(tree).find(element => element.props.role === 'status').props.children, /creation form is open/);
  emit('first', 'click', {metaKey: true}); tree = fixture.render(props()); assert.deepEqual(selected(), ['entry:second']);
  emit('third', 'contextmenu'); tree = fixture.render(props()); assert.deepEqual(selected(), ['entry:third']);
  assert.equal(controller.getSnapshot().reviewKey, 'entry:first'); assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  const checkbox = target('first').querySelector('[data-creation-pick]');
  resultHost(tree).props.onClick(native.event('click', checkbox));
  resultHost(tree).props.onChange(native.event('change', checkbox)); tree = fixture.render(props());
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:first']); assert.deepEqual(selected(), ['entry:third']);
  const review = target('second').querySelector('[data-creation-review]');
  resultHost(tree).props.onClick(native.event('click', review)); tree = fixture.render(props());
  assert.equal(controller.getSnapshot().reviewKey, 'entry:second'); assert.deepEqual(selected(), ['entry:third']);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:first']);
  fixture.dispose(); controller.dispose(); host.remove();
});

test('picker highlight obeys source grants, prunes filtered rows and retires on source reload', async () => {
  const controller = await session({entries: [entry('keep', {title: 'Keep'}), entry('filter', {title: 'Filtered'}),
    entry('denied', {allowed_actions: {can_read: true, can_select: false}})]});
  const {projectCreationState} = await model, host = native.document.createElement('div'); native.document.body.appendChild(host);
  const fixture = lifecycle('CreationResults', host), props = () => ({runtime, id: 'access', controller,
    state: controller.getSnapshot(), projection: projectCreationState(controller.getSnapshot()), disabled: false});
  const emit = (key, patch = {}) => host.querySelector(`[data-creation-row-key="entry:${key}"]`)
    .dispatchEvent(Object.assign(new native.context.Event('click'), {button: 0}, patch));
  fixture.render(props()); emit('denied'); assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 0);
  emit('keep'); fixture.render(props()); emit('filter', {ctrlKey: true}); fixture.render(props());
  controller.setQuery('keep'); const tree = fixture.render(props());
  const actions = elements(tree).find(element => element.props.available === false);
  assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 1);
  // The hook publishes the pruned snapshot during layout; the next render
  // exposes its live count without changing checkbox authoring.
  const refreshed = fixture.render(props());
  assert.equal(elements(refreshed).find(element => element.props.available === false).props.snapshot.selectedCount, 1);
  assert.equal(elements(refreshed).find(element => element.props.available === false).props.snapshot.droppedCount, 1);
  assert.deepEqual(controller.getSnapshot().selectedKeys, []); assert.equal(actions.props.available, false);
  const pending = controller.load(); assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 0);
  await pending; fixture.render(props()); assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 0);
  fixture.render({...props(), disabled: true}); emit('keep'); assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 0);
  const html = render(controller); assert.equal(hostFor(html).querySelectorAll('form').length, 1);
  assert.equal(button(hostFor(html), 'Add to playlist').disabled, true);
  fixture.dispose(); controller.dispose(); host.remove();
});

test('form submission stays busy through refresh, rejects repeated submits and separates confirmed creation from refresh failure', async () => {
  const write = deferred(), refresh = deferred(), enteredRefresh = deferred(); let writes = 0, completions = 0;
  const controller = await session({writer: async request => {writes++; await write.promise; return {status: 'ready', data: {
    scopeKey: request.scopeKey, request_key: request.request_key, playlist_id: 'created-playlist', revision: 'created-revision'}};}});
  controller.edit({title: 'Create once'});
  const fixture = lifecycle('CreationForm'), props = () => ({runtime, controller, state: controller.getSnapshot(),
    onCreated: async result => {completions++; assert.equal(result.playlist_id, 'created-playlist'); enteredRefresh.resolve(); await refresh.promise;}});
  const tree = fixture.render(props()), submit = tree.props.onSubmit({preventDefault() {}});
  await tree.props.onSubmit({preventDefault() {}}); assert.equal(writes, 1);
  write.resolve(); await enteredRefresh.promise;
  assert.equal(fixture.render(props()).props['aria-busy'], true); assert.equal(completions, 1);
  refresh.reject(new Error('refresh failed')); await submit;
  const finished = fixture.render(props()), status = elements(finished).find(element => element.props.mutation);
  assert.equal(finished.props['aria-busy'], false);
  assert.match(status.type(status.props).props.html, /Playlist created, but the playlist list could not be refreshed/);
  await finished.props.onSubmit({preventDefault() {}}); assert.equal(writes, 1); assert.equal(completions, 1);
  fixture.dispose(); controller.dispose();
});

test('disposed form ignores a pending refresh rejection without late component updates', async () => {
  const refresh = deferred(), enteredRefresh = deferred(), controller = await session(); controller.edit({title: 'Disposed'});
  const fixture = lifecycle('CreationForm');
  const tree = fixture.render({runtime, controller, state: controller.getSnapshot(), onCreated: async () => {
    enteredRefresh.resolve(); await refresh.promise;
  }});
  const pending = tree.props.onSubmit({preventDefault() {}}); await enteredRefresh.promise;
  fixture.dispose(); controller.dispose(); refresh.reject(new Error('late failure')); await pending;
  assert.equal(fixture.lateUpdates(), 0);
});

test('ordinary Create persists the chosen unresolved occurrence without matching or dropping its identity', async () => {
  const writes = [], controller = await session({entries: [entry('unknown'), entry('other')], writer: async request => {
    writes.push(request); return {status: 'ready', data: {scopeKey: request.scopeKey, request_key: request.request_key,
      playlist_id: 'created-playlist', revision: 'created-revision'}};
  }});
  controller.edit({title: 'Unresolved original'}); controller.toggle('entry:unknown');
  const fixture = lifecycle('CreationForm'), created = [];
  const tree = fixture.render({runtime, controller, state: controller.getSnapshot(), onCreated: value => created.push(value)});
  await tree.props.onSubmit({preventDefault() {}});
  assert.equal(writes.length, 1); assert.equal(writes[0].mode, 'ordinary');
  assert.deepEqual(writes[0].entry_refs, ['unknown']); assert.equal(created.length, 1);
  assert.equal(created[0].playlist_id, 'created-playlist');
  fixture.dispose(); controller.dispose();
});
