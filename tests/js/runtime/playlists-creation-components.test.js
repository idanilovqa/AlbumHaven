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
  const changed = (old, deps) => !old || deps.some((value, index) => !Object.is(value, old.deps[index]));
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
    require: name => name === 'react' ? hooks : require(name), console});
  return {
    render(props) {
      cursor = 0; pending = [];
      const tree = fixture.exports[name](props);
      if (host) {tree.props.ref.current = host; if (!initialized) host.innerHTML = tree.props.dangerouslySetInnerHTML.__html;}
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

test('missing creation keeps unknown originals selected, excludes confirmed local tracks and labels incomplete albums', async () => {
  const controller = await session({mode: 'missing', entries: [
    entry('local', {title: 'Private local song', availability: 'local'}),
    entry('missing', {availability: 'missing'}), entry('unknown', {title: 'Unresolved <original>'}),
  ], dataPatch: {retained_parent_albums: [parent({album_ref: 'retained-only', title: 'Retained parent only',
    allowed_actions: {can_read: true}})]}});
  controller.edit({title: 'Missing originals'});
  const html = render(controller, {onPrepareDraft: () => true}), host = hostFor(html), inputs = [...host.querySelectorAll('[data-creation-pick]')];
  assert.equal(inputs.length, 2); assert.equal(inputs.every(input => input.hasAttribute('checked')), true);
  assert.match(html, /Unresolved &lt;original&gt;/); assert.match(html, /Availability unresolved/); assert.match(html, /Incomplete/);
  assert.match(html, /Selected \(2\)/); assert.equal(button(host, 'Create playlist').disabled, false);
  assert.equal(host.querySelector('[data-creation-row-key="entry:missing"]').classList.contains('album-track-table__row--missing'), true);
  assert.equal(host.querySelector('[data-creation-row-key="entry:unknown"]').classList.contains('album-track-table__row--missing'), false);
  assert.doesNotMatch(html, /Private local song|Retained parent only|retained-only|0:00|data-src=|data-track-path=|play-track-button/);
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

test('missing mode requires a selection and does not treat uncertain parent labels as an identified incomplete album', async () => {
  const controller = await session({mode: 'missing', entries: [entry('unknown-parent', {availability: 'missing',
    parent_album: parent({state: 'ambiguous', album_ref: null, title: 'Uncertain album'})})]});
  controller.edit({title: 'Choose originals'}); controller.selectVisible(false);
  const html = render(controller), host = hostFor(html);
  assert.match(html, /Uncertain album/); assert.match(html, /Confirmed missing/); assert.doesNotMatch(html, /Incomplete/);
  assert.equal(button(host, 'Create playlist').disabled, true);
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

test('picker row, checkbox and Review actions remain separate', async () => {
  const controller = await session({entries: [entry('actions')]});
  const {projectCreationState} = await model;
  const host = native.document.createElement('div'); native.document.body.appendChild(host);
  const fixture = lifecycle('CreationResults', host), props = () => ({runtime, id: 'actions', controller,
    state: controller.getSnapshot(), projection: projectCreationState(controller.getSnapshot()), disabled: false});
  let tree = fixture.render(props()), row = host.querySelector('[data-creation-row-key]');
  tree.props.onClick(native.event('click', row.querySelector('.album-track-table__title')));
  assert.equal(controller.getSnapshot().selectedKeys.length, 1);
  tree = fixture.render(props());
  const checkbox = host.querySelector('[data-creation-pick]');
  tree.props.onClick(native.event('click', checkbox)); assert.equal(controller.getSnapshot().selectedKeys.length, 1);
  tree.props.onChange(native.event('change', checkbox)); assert.equal(controller.getSnapshot().selectedKeys.length, 0);
  tree = fixture.render(props());
  const review = host.querySelector('[data-creation-review]'); tree.props.onClick(native.event('click', review));
  assert.equal(controller.getSnapshot().reviewKey, controller.getSnapshot().sourceResource.data.entries[0].row_key);
  assert.equal(controller.getSnapshot().selectedKeys.length, 0);
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

test('missing Create requires a draft destination and never falls back to persistence', async () => {
  let writes = 0;
  const controller = await session({mode: 'missing', entries: [entry('missing')], writer: () => {writes++;}});
  controller.edit({title: 'Unsaved selection'});
  const fixture = lifecycle('CreationForm'), props = {runtime, controller, state: controller.getSnapshot()};
  const tree = fixture.render(props), create = elements(tree).find(element => element.props.type === 'submit');
  assert.equal(create.props.disabled, true);
  await tree.props.onSubmit({preventDefault() {}});
  assert.equal(writes, 0); assert.equal(controller.getSnapshot(), props.state);
  fixture.dispose(); controller.dispose();
});

test('missing Create hands off one frozen selection and stays busy until the draft destination accepts it', async () => {
  const transfer = deferred(), packets = []; let writes = 0;
  const controller = await session({mode: 'missing', entries: [entry('first'), entry('local', {availability: 'local'}), entry('second')],
    writer: () => {writes++;}});
  controller.edit({title: 'Unsaved originals', description: 'Keep these selections'});
  const original = controller.getSnapshot(), expected = controller.prepareDraft(), fixture = lifecycle('CreationForm');
  const props = () => ({runtime, controller, state: controller.getSnapshot(),
    onCreated: () => assert.fail('missing Create must not report persisted creation'),
    onPrepareDraft: packet => {packets.push(packet); return transfer.promise;}});
  const tree = fixture.render(props()), pending = tree.props.onSubmit({preventDefault() {}});
  await tree.props.onSubmit({preventDefault() {}});
  assert.equal(packets.length, 1); assert.equal(packets[0], expected);
  assert.equal(expected.title, 'Unsaved originals'); assert.equal(expected.description, 'Keep these selections');
  assert.deepEqual(expected.entries.map(row => row.entry_ref), ['first', 'second']);
  for (const value of [expected, expected.source, expected.entries, expected.entries[0], expected.entries[0].parent_album]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(Reflect.set(expected, 'title', 'Changed'), false);
  assert.equal(Reflect.set(expected.entries[0], 'title', 'Changed'), false);
  assert.equal(expected.playlist_id, undefined); assert.equal(expected.request_key, undefined);
  const busy = fixture.render(props()), status = elements(busy).find(element => element.props.mutation);
  assert.equal(busy.props['aria-busy'], true);
  assert.match(status.type(status.props).props.html, /Opening unsaved playlist/);
  assert.equal(elements(busy).filter(element => element.props.type === 'submit')[0].props.disabled, true);
  assert.equal(controller.getSnapshot(), original); assert.equal(writes, 0);
  fixture.dispose(); controller.dispose(); transfer.resolve(true); await pending;
  assert.equal(packets.length, 1); assert.equal(writes, 0); assert.equal(fixture.lateUpdates(), 0);
});

for (const [label, complete] of [['rejected', () => false], ['unconfirmed', () => ({accepted: true})],
  ['failed', async () => {throw new Error('Private transfer failure');}]]) {
  test(`a ${label} missing draft handoff preserves the selection and reports that nothing was saved`, async () => {
    let writes = 0;
    const controller = await session({mode: 'missing', entries: [entry('retained')], writer: () => {writes++;}});
    controller.edit({title: 'Keep this draft', description: 'Retain my edits'});
    const original = controller.getSnapshot(), fixture = lifecycle('CreationForm');
    const props = () => ({runtime, controller, state: controller.getSnapshot(), onPrepareDraft: complete});
    await fixture.render(props()).props.onSubmit({preventDefault() {}});
    const failed = fixture.render(props()), status = elements(failed).find(element => element.props.mutation);
    assert.equal(failed.props['aria-busy'], false); assert.equal(controller.getSnapshot(), original);
    assert.match(status.type(status.props).props.html, /unsaved playlist could not be opened.*selection has not been saved/);
    assert.doesNotMatch(status.type(status.props).props.html, /Playlist created|Check your playlists|Private transfer failure/);
    assert.equal(elements(failed).find(element => element.props.type === 'submit').props.disabled, false);
    assert.equal(writes, 0); fixture.dispose(); controller.dispose();
  });
}
