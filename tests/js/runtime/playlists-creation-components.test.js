const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture: nativeFixture} = require('./playlist-native-review-fixture.cjs');
const {installNativeSearch} = require('./native-search-harness.cjs');
const model = import('../../../music_app/static/js/playlists/creation.mjs');
let mountCreationForm, mountCreationResults, mountCreationSearch, creationResultsHtml, creationReviewRow;
test.before(async () => {
  ({mountCreationForm, mountCreationResults, creationResultsHtml, creationReviewRow} = await import('../../../music_app/static/js/playlists/native-creation-form.mjs'));
  ({mountCreationSearch} = await import('../../../music_app/static/js/playlists/native-creation.mjs'));
});
const native = nativeFixture();
const search = installNativeSearch(native);
const runtime = {...native.runtime, searchHtml: search.render,
  detailHeaderHtml: native.owner('buildAlbumDetailsHeaderHtml')};
const active = new Set();
test.afterEach(() => {for (const owner of active) owner.dispose(); active.clear();});
const hostFor = value => {
  if (value?.nodeType) return value;
  const host = native.document.createElement('div'); host.innerHTML = value; return host;
};
const markup = value => value?.nodeType ? value.innerHTML : value;
const button = (host, label) => [...host.querySelectorAll('button')].find(node => node.textContent === label);
const dispatch = (target, type, values = {}) => {
  const event = Object.assign(new target.ownerDocument.defaultView.Event(type), values);
  target.dispatchEvent(event); return event;
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const submit = host => {dispatch(host.querySelector('form'), 'submit'); return settle();};
const selectionStatus = host => host.querySelector('.album-track-table__selection-actions [role="status"]').textContent;
// Actual native owners, real DOM events, and explicit updates. No renderer emulation.
function lifecycle(name, target = null) {
  const host = target || native.document.createElement('div');
  if (!host.isConnected) native.document.body.append(host);
  let owner = null, disposed = false;
  const api = {
    host,
    render(props) {
      if (disposed) throw new Error('Cannot update a disposed fixture');
      if (owner) owner.update(props);
      else owner = ({CreationForm: mountCreationForm, CreationResults: mountCreationResults,
        CreationSearch: mountCreationSearch})[name](host, props.runtime, props);
      return host;
    },
    dispose() {if (disposed) return; disposed = true; owner?.dispose(); host.remove(); active.delete(api);},
  };
  active.add(api); return api;
}
const render = (controller, extra = {}) => lifecycle('CreationForm').render(
  {runtime, controller, state: controller.getSnapshot(), ...extra});
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
  const html = render(controller), host = hostFor(html), searchInput = host.querySelector('input[type="search"]');
  assert.equal(host.querySelector('[aria-label="Playlist name"]').value, 'My <playlist>'); assert.equal(host.querySelector('[aria-label="Playlist name"]').children.length, 0); assert.match(markup(html), /search-field-control/);
  // Observe native input properties rather than server-rendered attributes.
  const maximumLength = node => String(node.maxLength);
  assert.equal(maximumLength(host.querySelector('[aria-label="Playlist name"]')), '100');
  assert.equal(maximumLength(host.querySelector('[aria-label="Playlist description"]')), '1000');
  assert.equal(button(host, 'Create playlist').disabled, false);
  assert.equal(host.querySelector('[data-in-page-tab="selected"]').textContent, 'Selected (0)');
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').disabled, true);
  assert.match(host.textContent, /Search for tracks to add to this playlist/);
  controller.setQuery('absent');
  const noResults = render(controller);
  assert.match(noResults.textContent, /No matching tracks/);
  assert.equal(noResults.querySelectorAll('[data-creation-pick]').length, 0);
  assert.equal(searchInput.getAttribute('aria-label'), 'Search tracks, albums or artists'); assert.equal(searchInput.disabled, false);
  assert.notEqual(searchInput.id, 'search-input'); assert.match(searchInput.id, /^playlist-creation-/);
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
  assert.match(markup(html), /Unresolved &lt;original&gt;/); assert.match(markup(html), /Availability unresolved/); assert.match(markup(html), /Incomplete/);
  assert.match(markup(html), /Selected \(2\)/); assert.equal(button(host, 'Create playlist').disabled, false);
  assert.equal(host.querySelector('[data-creation-row-key="entry:missing"]').classList.contains('album-track-table__row--missing'), true);
  assert.equal(host.querySelector('[data-creation-row-key="entry:unknown"]').classList.contains('album-track-table__row--missing'), false);
  assert.doesNotMatch(markup(html), /Private local song|Retained parent only|retained-only|0:00|data-src=|data-track-path=|play-track-button/);
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
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').checked, true);
  controller.dispose();
});

test('missing mode requires a selection and does not treat uncertain parent labels as an identified incomplete album', async () => {
  const controller = await session({mode: 'missing', entries: [entry('unknown-parent', {availability: 'missing',
    parent_album: parent({state: 'ambiguous', album_ref: null, title: 'Uncertain album'})})]});
  controller.edit({title: 'Choose originals'}); controller.selectVisible(false);
  const html = render(controller), host = hostFor(html);
  assert.match(markup(html), /Uncertain album/); assert.match(markup(html), /Confirmed missing/); assert.doesNotMatch(markup(html), /Incomplete/);
  assert.equal(button(host, 'Create playlist').disabled, true);
  controller.dispose();
});

test('unreadable and identity-free rows cannot enter selection or disclose source facts', async () => {
  const controller = await session({entries: [entry('hidden', {title: 'Restricted title', artwork_url: '/art/restricted', availability: 'missing',
    allowed_actions: {can_read: false, can_select: true}}), entry(null, {title: 'Display only'})]});
  controller.setQuery('Display only');
  const html = render(controller), host = hostFor(html);
  assert.doesNotMatch(markup(html), /Restricted title|art\/restricted/); assert.match(markup(html), /Display only/);
  const state = controller.getSnapshot(), {projectCreationState} = await model;
  const deniedMarkup = creationResultsHtml(runtime, {id: 'denied-projection',
    projection: {...projectCreationState(state), entries: state.sourceResource.data.entries},
    selectedKeys: [], disabled: false});
  assert.match(deniedMarkup, /Unavailable track/);
  assert.doesNotMatch(deniedMarkup, /Restricted title|art\/restricted/);
  assert.equal([...host.querySelectorAll('[data-creation-pick]')].every(input => input.disabled), true);
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').disabled, true);
  assert.equal(host.querySelectorAll('[data-creation-review]').length, 1);
  assert.equal(hostFor(deniedMarkup).querySelector('[data-creation-row-key="projection:0"]').classList.contains('album-track-table__row--missing'), false);
  controller.dispose();
});

test('native read-only cells preserve zero duration without inventing absent numbers, durations or playback', async () => {
  const controller = await session({entries: [entry('zero', {track_number: 7, disc_number: 2, duration_seconds: 0}), entry('unknown')]});
  controller.setQuery('Artist');
  const state = controller.getSnapshot(), {projectCreationState} = await model;
  const html = creationResultsHtml(runtime, {id: 'facts', projection: projectCreationState(state), selectedKeys: [], disabled: false});
  const host = hostFor(html);
  assert.deepEqual([...host.querySelectorAll('[role="cell"][data-cdt-column="number"]')].map(node => node.textContent), ['7', '—']);
  assert.deepEqual([...host.querySelectorAll('[role="cell"][data-cdt-column="duration"]')].map(node => node.textContent), ['0:00', '—']);
  assert.match(markup(html), /album-track-table__title/); assert.match(markup(html), /compact-data-table/); assert.match(markup(html), /album-artbox--empty/);
  assert.doesNotMatch(markup(html), /data-track-row-path|data-src|data-track-path|data-track-duration-path|play-track-button/);
  controller.dispose();
});

test('unavailable, denied, error, conflict and incomplete sources never advertise All or enable Create', async () => {
  for (const [sourceStatus, dataPatch, expected] of [['unavailable', {}, /not available/], ['denied', {}, /permission/],
    ['error', {}, /could not be loaded/], ['ready', {source: {kind: 'library', ref: 'test-source', revision: 'changed'}}, /source changed/],
    ['ready', {entries_complete: false}, /source is incomplete/]]) {
    const controller = await session({sourceStatus, dataPatch, entries: [entry('private', {title: 'Stale data'})]});
    const html = render(controller), host = hostFor(html);
    assert.match(markup(html), expected); assert.doesNotMatch(markup(html), /Stale data|data-creation-pick/);
    assert.equal([...host.querySelectorAll('[data-in-page-tab]')].every(tab => Boolean(tab.closest('[hidden]'))), true);
    assert.equal(button(host, 'Create playlist').disabled, true); assert.equal(host.querySelector('input[type="search"]').disabled, true);
    controller.dispose();
  }
});

test('writes disable edits and dismissal, then confirmed creation remains terminal', async () => {
  let accept;
  const controller = await session({entries: [entry('one')], writer: request => new Promise(resolve => {accept = () => resolve({status: 'ready',
    data: {scopeKey: request.scopeKey, request_key: request.request_key, playlist_id: 'created-playlist', revision: 'created-revision'}});})});
  controller.edit({title: 'Create once'}); controller.setQuery('Artist');
  const pending = controller.submit(); await Promise.resolve();
  let host = hostFor(render(controller));
  assert.equal(host.querySelector('form').getAttribute('aria-busy'), 'true');
  assert.equal(host.querySelector('[aria-label="Playlist name"]').disabled, true);
  assert.equal(host.querySelector('fieldset').disabled, true);
  assert.equal(button(host, 'Create playlist').disabled, true); assert.equal(button(host, 'Discard').disabled, true);
  accept(); await pending; await settle(); const html = render(controller); host = hostFor(html);
  assert.match(markup(html), /Playlist created\./); assert.equal(button(host, 'Create playlist').disabled, true);
  assert.equal(button(host, 'Close').disabled, false); assert.equal(host.querySelector('[data-creation-pick]').disabled, true);
  controller.dispose();
});

test('Review uses the existing read-only panel and independently gated album identity without item or media references', async () => {
  const controller = await session({entries: [entry('review', {title: '<Original>', parent_album: parent({allowed_actions: {can_view_details: false}})})]});
  controller.setQuery('Original'); // All rows require an explicit query, including Review fixtures.
  const value = controller.getSnapshot().sourceResource.data.entries[0]; controller.review(value.row_key);
  const row = creationReviewRow(value, controller.getSnapshot().source), html = render(controller);
  assert.equal(row.album_ref, 'album-one'); assert.equal(row.allowed_actions.can_view_details, false);
  assert.equal(row.playlist_item_id, undefined); assert.equal(row.entry_ref, undefined); assert.equal(row.canonical_track_ref, undefined);
  assert.equal(row.source_kind, 'library');
  assert.match(markup(html), /Track information/); assert.match(markup(html), /Metadata freshness unknown/); assert.match(markup(html), /Availability unresolved/);
  assert.match(markup(html), /Close selection/); assert.match(markup(html), /data-in-page-tab="album"/);
  assert.doesNotMatch(markup(html), /Accept match|Candidate|data-src=|data-track-path=/);
  assert.equal(creationReviewRow({...value, source_readable: false}, controller.getSnapshot().source), null);
  assert.equal(creationReviewRow({...value, parent_album: {...value.parent_album, state: 'ambiguous'}}, controller.getSnapshot().source).album_ref, null);
  controller.dispose();
});

test('controlled native Search keeps its field and clears disabled semantics when the source becomes ready', () => {
  const env = nativeFixture(), search = installNativeSearch(env);
  const host = env.document.createElement('div'); env.document.body.appendChild(host);
  const fixture = lifecycle('CreationSearch', host), changes = [];
  const props = {runtime: {searchHtml: search.render}, id: 'creation-search-adapter', value: '', disabled: true,
    onChange: value => changes.push(value), maxLength: 200, label: 'Find tracks', placeholder: 'Track, artist or album'};
  fixture.render(props); const input = host.querySelector('input[type="search"]');
  assert.equal(input.disabled, true); assert.equal(input.getAttribute('aria-disabled'), 'true');
  assert.equal(input.maxLength, 200);
  assert.equal(input.getAttribute('placeholder'), 'Track, artist or album');
  const tree = fixture.render({...props, value: 'original', disabled: false});
  assert.equal(host.querySelector('input[type="search"]'), input); assert.equal(input.value, 'original');
  assert.equal(input.disabled, false); assert.equal(input.hasAttribute('aria-disabled'), false);
  assert.equal(host.querySelector('[data-search-clear]').hidden, false);
  assert.equal([...host.querySelectorAll('button')].every(button => !button.disabled && !button.hasAttribute('aria-disabled')), true);
  input.value = 'changed'; dispatch(input, 'input'); assert.deepEqual(changes, ['changed']);
  const enter = dispatch(input, 'keydown', {key: 'Enter'});
  assert.equal(enter.defaultPrevented, true); assert.equal(enter.stopped, true);
  fixture.render({...props, value: 'changed'}); assert.equal(input.disabled, true);
  assert.equal(host.querySelector('[data-search-clear]').hidden, true);
  fixture.dispose(); host.remove();
});

test('picker highlight, checkbox authoring and Review remain separate across source groups', async () => {
  const controller = await session({entries: [entry('first'), entry('second', {parent_album: parent({album_ref: 'other-album'})}),
    entry('third', {parent_album: parent({album_ref: 'last-album'})})]});
  controller.setQuery('Artist');
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
  
  let tree = fixture.render(props()); const first = target('first');
  emit('first', 'click'); tree = fixture.render(props());
  assert.deepEqual(selected(), ['entry:first']); assert.equal(target('first'), first);
  assert.equal(controller.getSnapshot().reviewKey, 'entry:first'); assert.equal(controller.getSnapshot().dirty, false);
  emit('second', 'click', {ctrlKey: true}); tree = fixture.render(props());
  assert.deepEqual(selected(), ['entry:first', 'entry:second']); assert.equal(controller.getSnapshot().reviewKey, 'entry:first');
  assert.equal(emit('second', 'contextmenu').defaultPrevented, true); tree = fixture.render(props());
  assert.deepEqual(selected(), ['entry:first', 'entry:second']);
  assert.match(selectionStatus(tree), /^2 rows selected/);
  assert.match([...tree.querySelectorAll('[role="status"]')].map(node => node.textContent).join('\n'), /creation form is open/);
  emit('first', 'click', {metaKey: true}); tree = fixture.render(props()); assert.deepEqual(selected(), ['entry:second']);
  emit('third', 'contextmenu'); tree = fixture.render(props()); assert.deepEqual(selected(), ['entry:third']);
  assert.equal(controller.getSnapshot().reviewKey, 'entry:first'); assert.deepEqual(controller.getSnapshot().selectedKeys, []);
  const checkbox = target('first').querySelector('[data-creation-pick]');
  dispatch(checkbox, 'click');
  dispatch(checkbox, 'change'); tree = fixture.render(props());
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:first']); assert.deepEqual(selected(), ['entry:third']);
  const review = target('second').querySelector('[data-creation-review]');
  dispatch(review, 'click'); tree = fixture.render(props());
  assert.equal(controller.getSnapshot().reviewKey, 'entry:second'); assert.deepEqual(selected(), ['entry:third']);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['entry:first']);
  fixture.dispose(); controller.dispose(); host.remove();
});

test('picker highlight obeys source grants, prunes filtered rows and retires on source reload', async () => {
  const controller = await session({entries: [entry('keep', {title: 'Keep'}), entry('filter', {title: 'Filtered'}),
    entry('denied', {allowed_actions: {can_read: true, can_select: false}})]});
  controller.setQuery('Artist');
  const {projectCreationState} = await model, host = native.document.createElement('div'); native.document.body.appendChild(host);
  const fixture = lifecycle('CreationResults', host), props = () => ({runtime, id: 'access', controller,
    state: controller.getSnapshot(), projection: projectCreationState(controller.getSnapshot()), disabled: false});
  const emit = (key, patch = {}) => host.querySelector(`[data-creation-row-key="entry:${key}"]`)
    .dispatchEvent(Object.assign(new native.context.Event('click'), {button: 0}, patch));
  fixture.render(props()); emit('denied'); assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 0);
  emit('keep'); fixture.render(props()); emit('filter', {ctrlKey: true}); fixture.render(props());
  controller.setQuery('keep'); const tree = fixture.render(props());
  const actions = button(tree, 'Add to playlist');
  assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 1);
  // Native selection publishes its pruned DOM status without changing checkbox authoring.
  const refreshed = fixture.render(props());
  assert.match(selectionStatus(refreshed), /^1 row selected/);
  assert.match(selectionStatus(refreshed), /1 no longer visible or selectable/);
  assert.deepEqual(controller.getSnapshot().selectedKeys, []); assert.equal(actions.disabled, true);
  const pending = controller.load(); assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 0);
  await pending; await settle(); fixture.render(props()); assert.equal(host.querySelectorAll('[aria-selected="true"]').length, 0);
  controller.setQuery('keep'); // load() retires the prior query as well as selection.
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
  const tree = fixture.render(props()), submission = submit(tree);
  await submit(tree); assert.equal(writes, 1);
  write.resolve(); await enteredRefresh.promise;
  assert.equal(fixture.render(props()).querySelector('form').getAttribute('aria-busy'), 'true'); assert.equal(completions, 1);
  refresh.reject(new Error('refresh failed')); await submission; await settle();
  const finished = fixture.render(props()), status = finished;
  assert.equal(finished.querySelector('form').getAttribute('aria-busy'), 'false');
  assert.match(status.textContent, /Playlist created, but the playlist list could not be refreshed/);
  await submit(finished); assert.equal(writes, 1); assert.equal(completions, 1);
  fixture.dispose(); controller.dispose();
});

test('disposed form ignores a pending refresh rejection without late component updates', async () => {
  const refresh = deferred(), enteredRefresh = deferred(), controller = await session(); controller.edit({title: 'Disposed'});
  const fixture = lifecycle('CreationForm');
  const tree = fixture.render({runtime, controller, state: controller.getSnapshot(), onCreated: async () => {
    enteredRefresh.resolve(); await refresh.promise;
  }});
  const pending = submit(tree); await enteredRefresh.promise;
  const retiredForm = tree.querySelector('form');
  fixture.dispose(); controller.dispose();
  const beforeRetirement = retiredForm.outerHTML; // Teardown may clear children; late completion may not repaint.
  refresh.reject(new Error('late failure')); await pending; await settle();
  assert.equal(fixture.host.childNodes.length, 0);
  assert.equal(retiredForm.outerHTML, beforeRetirement);
});

test('missing Create requires a draft destination and never falls back to persistence', async () => {
  let writes = 0;
  const controller = await session({mode: 'missing', entries: [entry('missing')], writer: () => {writes++;}});
  controller.edit({title: 'Unsaved selection'});
  const fixture = lifecycle('CreationForm'), props = {runtime, controller, state: controller.getSnapshot()};
  const tree = fixture.render(props), create = tree.querySelector('button[type="submit"]');
  assert.equal(create.disabled, true);
  await submit(tree);
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
  const tree = fixture.render(props()), pending = submit(tree);
  await submit(tree);
  assert.equal(packets.length, 1); assert.equal(packets[0], expected);
  assert.equal(expected.title, 'Unsaved originals'); assert.equal(expected.description, 'Keep these selections');
  assert.deepEqual(expected.entries.map(row => row.entry_ref), ['first', 'second']);
  for (const value of [expected, expected.source, expected.entries, expected.entries[0], expected.entries[0].parent_album]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(Reflect.set(expected, 'title', 'Changed'), false);
  assert.equal(Reflect.set(expected.entries[0], 'title', 'Changed'), false);
  assert.equal(expected.playlist_id, undefined); assert.equal(expected.request_key, undefined);
  const busy = fixture.render(props()), status = busy;
  assert.equal(busy.querySelector('form').getAttribute('aria-busy'), 'true');
  assert.match(status.textContent, /Opening unsaved playlist/);
  assert.equal(busy.querySelector('button[type="submit"]').disabled, true);
  assert.equal(controller.getSnapshot(), original); assert.equal(writes, 0);
  const retiredForm = fixture.host.querySelector('form');
  fixture.dispose(); controller.dispose();
  const retiredMarkup = retiredForm.outerHTML; // Capture after legitimate synchronous disposal cleanup.
  transfer.resolve(true); await pending; await settle();
  assert.equal(packets.length, 1); assert.equal(writes, 0); assert.equal(fixture.host.childNodes.length, 0);
  assert.equal(retiredForm.outerHTML, retiredMarkup);
});

for (const [label, complete] of [['rejected', () => false], ['unconfirmed', () => ({accepted: true})],
  ['failed', async () => {throw new Error('Private transfer failure');}]]) {
  test(`a ${label} missing draft handoff preserves the selection and reports that nothing was saved`, async () => {
    let writes = 0;
    const controller = await session({mode: 'missing', entries: [entry('retained')], writer: () => {writes++;}});
    controller.edit({title: 'Keep this draft', description: 'Retain my edits'});
    const original = controller.getSnapshot(), fixture = lifecycle('CreationForm');
    const props = () => ({runtime, controller, state: controller.getSnapshot(), onPrepareDraft: complete});
    await submit(fixture.render(props()));
    const failed = fixture.render(props()), status = failed;
    assert.equal(failed.querySelector('form').getAttribute('aria-busy'), 'false'); assert.equal(controller.getSnapshot(), original);
    assert.match(status.textContent, /unsaved playlist could not be opened.*selection has not been saved/);
    assert.doesNotMatch(status.textContent, /Playlist created|Check your playlists|Private transfer failure/);
    assert.equal(failed.querySelector('button[type="submit"]').disabled, false);
    assert.equal(writes, 0); fixture.dispose(); controller.dispose();
  });
}

test('queried ordinary builder renders one native table with per-row art across albums', async t => {
  const controller = await session({entries: [
    entry('first', {title: 'Needle first', artwork_url: '/art/first', parent_album: parent({album_ref: 'album:first'})}),
    entry('second', {title: 'Needle second', artwork_url: '/art/second', parent_album: parent({album_ref: 'album:second'})}),
  ]});
  t.after(() => controller.dispose());
  controller.setQuery('needle');
  const state = controller.getSnapshot(), {projectCreationState} = await model, tables = [];
  const html = creationResultsHtml({...runtime, tableHtml(config) {tables.push(config); return runtime.tableHtml(config);}},
    {id: 'flat-builder', projection: projectCreationState(state), selectedKeys: [], disabled: false});
  assert.equal(tables.length, 1);
  assert.equal(tables[0].selection, 'multiple');
  assert.deepEqual(tables[0].rows.map(row => row.key), ['entry:first', 'entry:second']);
  const host = hostFor(html);
  assert.equal(host.querySelectorAll('.album-track-table__disc-heading').length, 0);
  assert.equal(host.querySelectorAll('[data-creation-row-key]').length, 2);
  for (const identity of ['first', 'second']) {
    const track = host.querySelector(`[data-creation-row-key="entry:${identity}"]`);
    assert.equal(track.querySelector('img').getAttribute('src'), `/art/${identity}`);
    assert.equal(track.querySelector('[data-creation-pick]').disabled, false);
    assert.equal(track.getAttribute('tabindex'), '0');
  }
  assert.doesNotMatch(markup(html), /data-track-path=|data-src=|play-track-button/);
});

test('ordinary builder initial All prompts for a search rather than claiming the source is empty', async t => {
  const controller = await session({entries: [entry('unqueried', {title: 'Unqueried private title'})]});
  t.after(() => controller.dispose());
  controller.edit({title: 'Empty playlist is allowed'});
  const html = render(controller), host = hostFor(html);
  assert.equal(host.querySelectorAll('[data-creation-row-key]').length, 0);
  assert.equal(host.querySelector('[aria-label="Select visible tracks"]').disabled, true);
  assert.ok([...host.querySelectorAll('[role="status"]')].some(node => /search/i.test(node.textContent)));
  assert.doesNotMatch(markup(html), /Unqueried private title|No tracks are available in this source/);
  assert.equal(button(host, 'Create playlist').disabled, false);
});

test('flat queried builder preserves Ctrl, Cmd and Shift highlight without changing authored selection', async t => {
  const controller = await session({entries: ['a', 'b', 'c'].map(identity => entry(identity,
    {title: `Needle ${identity}`, parent_album: parent({album_ref: `album:${identity}`})}))});
  controller.setQuery('needle');
  const {projectCreationState} = await model, host = native.document.createElement('div');
  native.document.body.appendChild(host);
  const fixture = lifecycle('CreationResults', host);
  t.after(() => {fixture.dispose(); controller.dispose(); host.remove();});
  const props = () => ({runtime, id: 'flat-selection', controller, state: controller.getSnapshot(),
    projection: projectCreationState(controller.getSnapshot()), disabled: false});
  const click = (identity, modifiers = {}) => {
    host.querySelector(`[data-creation-row-key="entry:${identity}"]`).dispatchEvent(
      Object.assign(new native.context.Event('click'), {button: 0}, modifiers));
    fixture.render(props());
  };
  const highlighted = () => [...host.querySelectorAll('[aria-selected="true"][data-creation-row-key]')]
    .map(row => row.dataset.creationRowKey);
  fixture.render(props());
  click('a'); click('c', {ctrlKey: true});
  assert.deepEqual(highlighted(), ['entry:a', 'entry:c']);
  click('c', {metaKey: true});
  assert.deepEqual(highlighted(), ['entry:a']);
  click('a'); click('c', {shiftKey: true});
  assert.deepEqual(highlighted(), ['entry:a', 'entry:b', 'entry:c']);
  assert.deepEqual(controller.getSnapshot().selectedKeys, []);
});

test('ordinary builder Create uses native primary action styling with native disabled semantics', async t => {
  const controller = await session();
  t.after(() => controller.dispose());
  let host = hostFor(render(controller)), create = button(host, 'Create playlist');
  assert.equal(create.classList.contains('ui-button--primary'), true);
  assert.equal(create.disabled, true);
  assert.equal(create.getAttribute('aria-disabled'), 'true');
  controller.edit({title: 'Ready'});
  host = hostFor(render(controller)); create = button(host, 'Create playlist');
  assert.equal(create.classList.contains('ui-button--primary'), true);
  assert.equal(create.disabled, false);
  assert.equal(create.hasAttribute('aria-disabled'), false);
  assert.equal(button(host, 'Discard').classList.contains('ui-button--secondary'), true);
});

// Retained native SearchInput host and field identity protect caret ownership.
// Browser caret coverage remains a separate acceptance gate.
test('Tops builder integration retains stable shared Search HTML ownership across query and disabled repaints', t => {
  const env = nativeFixture(), search = installNativeSearch(env);
  const host = env.document.createElement('div'); env.document.body.appendChild(host);
  const fixture = lifecycle('CreationSearch', host), changes = [];
  t.after(() => {fixture.dispose(); host.remove();});
  const props = {runtime: {searchHtml: search.render}, id: 'tops-builder-search-integration',
    value: '', disabled: false, onChange: value => changes.push(value), maxLength: 200};
  const initial = fixture.render(props);
  const input = host.querySelector('input[type="search"]');
  for (const next of [{value: 'Pink', disabled: false}, {value: 'Pink', disabled: true},
    {value: 'Pink', disabled: false}, {value: '', disabled: false}]) {
    const tree = fixture.render({...props, ...next});
    assert.equal(tree, initial);
    assert.equal(host.querySelector('input[type="search"]'), input);
    assert.equal(input.value, next.value);
    assert.equal(input.disabled, next.disabled);
    assert.equal(host.querySelector('[data-search-clear]').hidden, !next.value || next.disabled);
  }
  input.value = 'Needle';
  fixture.render({...props, value: 'Needle'}); dispatch(input, 'input');
  assert.deepEqual(changes, ['Needle']);
});

test('Tops builder integration leaves Missing rows grouped while ordinary results become flat', async t => {
  const controller = await session({mode: 'missing', entries: [
    entry('missing-one', {availability: 'missing', parent_album: parent({album_ref: 'album:first'})}),
    entry('missing-two', {availability: 'unresolved', parent_album: parent({album_ref: 'album:second'})}),
    entry('local-excluded', {availability: 'local'}),
  ]});
  t.after(() => controller.dispose());
  const {projectCreationState} = await model, current = controller.getSnapshot(), tables = [];
  const html = creationResultsHtml({...runtime, tableHtml(config) {tables.push(config); return runtime.tableHtml(config);}},
    {id: 'tops-missing-integration', projection: projectCreationState(current), selectedKeys: current.selectedKeys, disabled: false});
  assert.equal(tables.length, 2);
  assert.equal(hostFor(html).querySelectorAll('.album-track-table__disc-heading').length, 2);
  assert.deepEqual(tables.flatMap(table => table.rows.map(row => row.key)), ['entry:missing-one', 'entry:missing-two']);
  assert.doesNotMatch(markup(html), /entry:local-excluded|data-track-path=|data-src=|play-track-button/);
});

// Append after the corrected native creation migration, preserving all its tests.
test('builder source correction retains highlighted row and focus on unchanged output', async () => {
  const controller = await session({mode: 'missing', entries: [entry('a'), entry('b')]});
  const fixture = lifecycle('CreationResults');
  const props = () => ({runtime, id: 'cache-regression', controller, state: controller.getSnapshot(),
    projection: null, disabled: false});
  const {projectCreationState} = await model;
  const paint = () => {const next = props(); next.projection = projectCreationState(next.state); fixture.render(next);};
  try {
    paint();
    const first = fixture.host.querySelector('[data-creation-row-key]');
    first.focus(); dispatch(first, 'click');
    assert.equal(first.getAttribute('aria-selected'), 'true');
    paint(); paint();
    assert.equal(fixture.host.querySelector('[data-creation-row-key]'), first);
    assert.equal(native.document.activeElement, first);
    assert.equal(first.getAttribute('aria-selected'), 'true');
    assert.ok([...fixture.host.querySelectorAll('[role="status"]')].some(node => /Add to playlist is unavailable/.test(node.textContent)));
  } finally {fixture.dispose(); controller.dispose();}
});

test('builder canonical cache does not commit a superseded creation render', async () => {
  const controller = await session({mode: 'missing', entries: [entry('a'), entry('b')]});
  const {projectCreationState} = await model;
  const fixture = lifecycle('CreationResults');
  let reenter = false, latest;
  const guardedRuntime = {...runtime, tableHtml(options) {
    const html = runtime.tableHtml(options);
    if (reenter) {reenter = false; fixture.render(latest);}
    return html;
  }};
  const state = controller.getSnapshot();
  const initial = {runtime: guardedRuntime, id: 'cache-reentry', controller, state,
    projection: projectCreationState(state), disabled: false};
  try {
    fixture.render(initial); latest = {...initial, disabled: true}; reenter = true;
    fixture.render(initial);
    const row = fixture.host.querySelector('[data-creation-row-key]');
    assert.equal(row.querySelector('[data-creation-pick]').disabled, true);
    fixture.render(latest);
    assert.equal(fixture.host.querySelector('[data-creation-row-key]'), row);
    assert.equal(row.querySelector('[data-creation-pick]').disabled, true);
  } finally {fixture.dispose(); controller.dispose();}
});
