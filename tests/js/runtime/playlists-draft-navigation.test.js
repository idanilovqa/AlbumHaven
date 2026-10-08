const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const root = path.resolve(__dirname, '../../../music_app/static/js');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const settle = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};

function harness() {
  const native = createNativeHomeRuntime(), {context, document} = native;
  const add = (id, attribute) => {
    const node = document.createElement('div'); if (id) node.id = id;
    if (attribute) node.setAttribute(attribute, ''); document.body.appendChild(node); return node;
  };
  const shell = add('app-shell'); shell.dataset.nativeAccountId = 'account:one'; shell.dataset.nativeLibraryId = 'library:one';
  add('playlists-root'); add('shell-main-surface'); add('mobile-home');
  const settings = add(null, 'data-settings-host'); settings.hidden = true;
  add(null, 'data-settings-outlet'); add(null, 'data-settings-nav');
  const location = new URL('https://albumhaven.test/?surface=playlists&playlist_id=source');
  const entries = [{url: location.href, state: {albumHavenNavigationPosition: 0}}], listeners = [];
  let index = 0;
  const calls = {fetch: [], gallery: 0, discard: 0, confirm: 0};
  const dispatch = () => {
    const event = {state: entries[index].state, stopped: false, stopImmediatePropagation() {this.stopped = true;}};
    for (const capture of [true, false]) for (const listener of listeners.filter(value => value.name === 'popstate' && value.capture === capture)) {
      if (!event.stopped) listener.callback(event);
    }
    if (!event.stopped) context.handleGalleryBootstrapPopState();
  };
  const history = {
    get state() {return entries[index].state;},
    pushState(value, title, url) {location.href = new URL(url, location).href; entries.splice(++index, Infinity, {url: location.href, state: structuredClone(value)});},
    replaceState(value, title, url) {location.href = new URL(url || location.href, location).href; entries[index] = {url: location.href, state: structuredClone(value)};},
    go(delta) {queueMicrotask(() => {if (index + delta < 0 || index + delta >= entries.length) return; index += delta; location.href = entries[index].url; dispatch();});},
  };
  const view = {surface: {active: 'playlists'}, playlist_sidebar: {active_playlist_id: 'source', items: []},
    playlist_detail: {playlist_id: 'source', title: 'Real source', track_rows: []}};
  Object.assign(context, {URL, URLSearchParams, AbortController, location, history, innerWidth: 1200,
    state: {view, ui: {}}, AlbumHavenHomeRuntime: {}, DOMParser: class {},
    addEventListener: (name, callback, capture = false) => listeners.push({name, callback, capture: capture === true}),
    removeEventListener() {}, dispatchEvent() {},
    fetch: (...args) => {calls.fetch.push(args); return Promise.reject(new Error('No transport expected'));},
    buildUrl: value => value.url || '/?artist=Retained',
    NavigationTree: {setSelection() {}},
  });
  for (const file of ['settings-navigation.js', 'runtime/mobile-navigation.js', 'runtime/browser-navigation-helpers.js',
    'runtime/gallery-refresh-and-status.js', 'runtime/bootstrap-gallery-event-handlers.js', 'runtime/track-actions.js', 'runtime/playlists-react-bridge.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {filename: file});
  }
  const nativePop = context.handleGalleryBootstrapPopState;
  context.handleMobilePagePopState = () => false;
  context.handleGalleryBootstrapPopState = () => {
    calls.gallery++;
    if (context.AlbumHavenPlaylistRuntime.restoreDraftFromHistory()) return;
  };
  const runtime = context.AlbumHavenPlaylistRuntime, navigation = context.AlbumHavenSettingsNavigation.instance;
  let current = true, decision = true;
  const open = () => runtime.openDraft({token: 'draft:one', scopeKey: runtime.snapshot().scopeKey,
    isCurrent: () => current, confirmLeave: () => {calls.confirm++; return decision;}, onDiscard: () => {calls.discard++; current = false;}});
  return {...native, runtime, navigation, shell, settings, location, history, entries, view, calls, open, nativePop,
    decision(value) {decision = value;}, invalidate() {current = false;}, index: () => index};
}

test('draft entry is native opaque UI ownership only and never writes or alters the source DTO', () => {
  const h = harness(), original = h.context.state.view;
  assert.equal(h.open(), true);
  assert.deepEqual(Object.keys(h.history.state).sort(), ['albumHavenNavigationPosition', 'playlistDraft']);
  assert.deepEqual(plain(h.history.state.playlistDraft), {token: 'draft:one', scopeKey: h.runtime.snapshot().scopeKey});
  assert.equal(h.location.search, '?surface=playlists');
  assert.equal(h.runtime.snapshot().draftToken, 'draft:one');
  assert.equal(h.runtime.snapshot().playlistId, null);
  assert.strictEqual(h.context.state.view, original);
  assert.doesNotMatch(JSON.stringify(h.history.state), /playlist_id|entries|source|title|description/);
  assert.equal(h.open(), false);
  assert.equal(h.calls.fetch.length, 0);
});

test('native modal and direct gallery requests ask Discard before touching their destination', async () => {
  const h = harness(); h.open(); h.decision(false);
  let opened = 0;
  assert.equal(await h.context.deferAppFormPageReplacement(() => {opened++;}), false);
  assert.equal(await h.context.fetchAndRender('/view-data?surface=home', true), false);
  assert.equal(opened, 0); assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.discard, 0);
  assert.equal(h.runtime.snapshot().draftToken, 'draft:one');
  h.decision(true);
  await h.context.deferAppFormPageReplacement(() => {opened++;});
  assert.equal(opened, 1); assert.equal(h.calls.discard, 1);
});

test('Settings navigation asks Discard and does not start its fetch when declined', async () => {
  const h = harness(); h.open(); h.decision(false);
  assert.equal(await h.navigation.navigate('/account'), false);
  assert.equal(h.calls.fetch.length, 0); assert.equal(h.calls.discard, 0);
  assert.equal(h.settings.hidden, true); assert.equal(h.runtime.snapshot().draftToken, 'draft:one');
});

test('Back cancellation restores the exact native draft entry, then Discard prevents Forward resurrection', async () => {
  const h = harness(); h.open(); h.decision(false);
  h.history.go(-1); await settle();
  assert.equal(h.index(), 1); assert.equal(h.runtime.snapshot().draftToken, 'draft:one');
  assert.equal(h.calls.discard, 0);
  h.decision(true); h.history.go(-1); await settle();
  assert.equal(h.index(), 0); assert.equal(h.calls.discard, 1);
  h.history.go(1); await settle();
  assert.equal(h.history.state.playlistDraft, undefined);
  assert.equal(h.runtime.snapshot().draftToken, null); assert.equal(h.calls.discard, 1);
});

test('retained native Album/Artist/Top navigation preserves the owner through Back and Forward', async () => {
  const h = harness(); h.open();
  const draftEntry = plain(h.history.state);
  h.runtime.retainDraft('draft:one', () => {
    assert.equal(h.context.deferAppFormPageReplacement(() => {throw new Error('Retained child was replayed');}), false);
    assert.equal(h.context.pushBrowserViewState({url: '/?artist=Retained', privateSource: 'must not enter history'}), undefined,
      'retained navigation preserves the native successful void return');
  });
  h.context.state.view = {surface: {active: 'albums'}};
  assert.equal(h.runtime.sync().visible, false);
  assert.deepEqual(plain(h.history.state.playlistDraft), draftEntry.playlistDraft);
  assert.doesNotMatch(JSON.stringify(h.history.state), /privateSource/);
  h.history.go(-1); await settle();
  assert.equal(h.runtime.snapshot().draftToken, 'draft:one'); assert.equal(h.runtime.snapshot().visible, true);
  h.nativePop(); // The actual gallery pop owner must not fetch over the live page.
  h.history.go(1); await settle();
  assert.equal(h.runtime.snapshot().retainedDraftToken, 'draft:one');
  assert.equal(h.calls.confirm, 0); assert.equal(h.calls.discard, 0); assert.equal(h.calls.fetch.length, 0);
});

test('a delayed leave confirmation cannot replay over a later native destination', async () => {
  const h = harness(), answer = deferred(); h.open(); h.decision(answer.promise);
  let destination = 0;
  const leaving = h.navigation.deferPlaylistDraftNavigation(() => {destination++;});
  await settle();
  h.navigation.pushLibraryHistory('/?artist=Newer', {});
  answer.resolve(true); await leaving;
  assert.equal(destination, 0); assert.equal(h.calls.discard, 0);
});

test('actor, library and provider invalidation erase ownership without waiting for Discard', async () => {
  for (const invalidate of [h => {h.shell.dataset.nativeAccountId = 'account:two';},
    h => {h.shell.dataset.nativeLibraryId = 'library:two';}, h => h.invalidate()]) {
    const h = harness(), answer = deferred(); h.open(); h.decision(answer.promise);
    let destination = 0;
    const leaving = h.navigation.deferPlaylistDraftNavigation(() => {destination++;});
    await settle(); invalidate(h); h.runtime.sync();
    assert.equal(h.calls.discard, 1); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
    answer.resolve(true); await leaving;
    assert.equal(destination, 0);
    h.history.go(-1); await settle(); h.history.go(1); await settle();
    assert.equal(h.runtime.snapshot().draftToken, null);
  }
});

test('Close uses the retained native parent and clears the draft once', async () => {
  const h = harness(); h.open();
  assert.equal(await h.runtime.closeDraft('draft:one'), true); await settle();
  assert.equal(h.index(), 0); assert.equal(h.calls.discard, 1);
  assert.equal(await h.runtime.closeDraft('draft:one'), false);
});

test('persisted navigation acquires its request ownership after the draft dismissal settles', async () => {
  const h = harness(); h.open();
  const target = {surface: {active: 'playlists'}, playlist_sidebar: {active_playlist_id: 'saved:one',
    items: [{playlist_id: 'saved:one', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'saved:one', title: 'Saved', track_rows: []}};
  h.context.fetchAndRender = async (url, push, options) => {
    assert.equal(h.calls.discard, 1, 'no native request starts until departure is confirmed');
    h.context.state.ui.activeViewRequestId = 17;
    await Promise.resolve();
    assert.equal(options.shouldApplyResponse(target), true);
    h.context.state.view = target;
    h.navigation.pushLibraryHistory('/?surface=playlists&playlist_id=saved%3Aone', {});
    return true;
  };
  await h.runtime.navigate({playlist_id: 'saved:one'});
  assert.equal(h.runtime.snapshot().playlistId, 'saved:one');
  assert.equal(h.runtime.snapshot().draftToken, null);
});

test('opening and restoring a draft invalidate older native view responses', () => {
  const h = harness(); let aborted = 0;
  h.context.state.ui.activeViewRequestController = {abort() {aborted++;}};
  h.context.state.ui.viewStateRevision = 4;
  h.open();
  assert.equal(aborted, 1); assert.equal(h.context.state.ui.viewStateRevision, 5);
  h.nativePop();
  assert.equal(aborted, 2); assert.equal(h.calls.fetch.length, 0);
});

// This mount driver executes the real mount/controllers and controls only hook
// commits and native/provider boundaries. It is not a browser/React DOM test.
let mountBundle;
function mountHarness(readPlaylists, providers, payload) {
  const React = require('react'), {buildSync} = require('esbuild'), {randomUUID} = require('node:crypto');
  mountBundle ||= buildSync({entryPoints: [path.join(root, 'playlists/index.jsx')], bundle: true, platform: 'node',
    format: 'cjs', write: false, external: ['react', 'react-dom', 'react-dom/client']}).outputFiles[0].text;
  let element, effects = [], owner = null;
  let shell = {visible: true, scopeKey: 'mount:actor', payload, playlistId: 'source:mount', entryKey: 1,
    draftToken: null, retainedDraftToken: null};
  const hooks = {...React,
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: callback => {effects.push(callback);},
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  const loaded = {exports: {}};
  vm.runInNewContext(mountBundle, {module: loaded, exports: loaded.exports, console, AbortController, URL, crypto: {randomUUID},
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react-dom') return {createPortal: children => children};
      if (name === 'react-dom/client') return {createRoot: () => ({render: value => {element = value;}, unmount() {element = null;}})};
      assert.fail(`Unexpected mount dependency: ${name}`);
    }});
  const calls = {navigate: 0, released: 0};
  const runtime = {snapshot: () => shell, subscribe: () => () => {}, readPlaylists,
    openDraft(value) {owner = value; shell = {...shell, playlistId: null, draftToken: value.token, retainedDraftToken: value.token}; return true;},
    releaseDraft(token) {
      if (!owner || owner.token !== token) return false;
      const current = owner; owner = null; calls.released++;
      shell = {...shell, payload: null, draftToken: null, retainedDraftToken: null}; current.onDiscard(); return true;
    },
    retainDraft(token, callback) {return owner?.token === token && owner.isCurrent() ? callback() : false;},
    navigate() {calls.navigate++; return false;},
  };
  const mount = loaded.exports.mountPlaylists({host: {}, runtime, providers});
  const render = () => {
    effects = []; const tree = element.type(element.props), pending = effects; effects = [];
    for (const effect of pending) effect();
    return tree;
  };
  return {mount, runtime, calls, render, renderDraft: tree => tree.type(tree.props)};
}

test('Save acknowledgement still revalidates refreshed source grants, identity and revision before preserving private draft facts', async () => {
  const creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  const subject = {scopeKey: 'mount:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
    source: {kind: 'playlist', ref: 'source:mount', revision: 'revision:one', allowed_actions: {can_read: true, can_use_for_playlist: true}}};
  const sourcePayload = source => ({playlist_actions: {can_create: true},
    playlist_sidebar: {items: [{playlist_id: 'source:mount', title: 'Source', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'source:mount', title: 'Source', revision: source.revision, track_rows: [], items_complete: true,
      allowed_actions: {can_open: true, can_create_album_top: true}, missing_playlist_creation_source: source}});
  for (const change of ['revoked', 'identity', 'revision']) {
    let writes = 0;
    const changed = {...subject.source, ...(change === 'identity' ? {ref: 'source:other'} : {}),
      ...(change === 'revision' ? {revision: 'revision:two'} : {}),
      ...(change === 'revoked' ? {allowed_actions: {can_read: false, can_use_for_playlist: false}} : {})};
    const providers = {
      readPlaylistCreationSource: request => ({status: 'ready', data: {...request, allowed_actions: {can_read: true, can_use_for_playlist: true},
        entries_complete: true, entries: [{entry_ref: 'occurrence:private', title: 'Private original', artist: 'Private artist',
          availability: 'missing', allowed_actions: {can_read: true, can_select: true}}], retained_parent_albums: []}}),
      createPlaylistFromSelection: request => {writes++; return {status: 'ready', data: {scopeKey: request.scopeKey,
        request_key: request.request_key, playlist_id: 'saved:missing-from-directory', revision: 'saved:one'}};},
    };
    const form = creation.createPlaylistCreationController({providers});
    form.setContext(subject); await form.load(); form.edit({title: 'Typed title', description: 'Typed description'});
    const packet = form.prepareDraft(); assert.ok(packet);
    const h = mountHarness(async () => sourcePayload(changed), providers, sourcePayload(subject.source));
    h.render(); const originalPage = h.render();
    assert.equal(originalPage.props.onPrepareDraft(packet), true);
    const draftPage = h.renderDraft(h.render()), controller = draftPage.props.controller;
    const ack = await controller.save(); assert.ok(ack); assert.equal(writes, 1);
    assert.equal(await draftPage.props.onSaved(ack), false);
    assert.equal(controller.exportText(), '', `${change} source facts must no longer be exportable`);
    assert.equal(controller.getSnapshot().entries.length, 0);
    assert.equal(h.calls.navigate, 0);
    if (change === 'revision') {
      assert.equal(controller.getSnapshot().sourceResource.status, 'conflict');
      assert.equal(controller.getSnapshot().title, 'Typed title');
    } else {
      assert.equal(h.calls.released, 1);
      assert.equal(controller.getSnapshot().title, '');
    }
    assert.equal(await controller.save(), false); assert.equal(writes, 1);
    form.dispose(); h.mount.dispose();
  }
});

test('async Top UI ownership aborts on retained-row and source changes even when the deduplicated albums are unchanged', async () => {
  const creation = await import('../../../music_app/static/js/playlists/creation.mjs');
  const subject = {scopeKey: 'mount:actor', mode: 'missing', canCreate: true, canCreateAlbumTop: true,
    source: {kind: 'playlist', ref: 'source:mount', revision: 'revision:one', allowed_actions: {can_read: true, can_use_for_playlist: true}}};
  const sourcePayload = {playlist_actions: {can_create: true},
    playlist_sidebar: {items: [{playlist_id: 'source:mount', title: 'Source', allowed_actions: {can_open: true}}]},
    playlist_detail: {playlist_id: 'source:mount', title: 'Source', revision: 'revision:one', track_rows: [], items_complete: true,
      allowed_actions: {can_open: true, can_create_album_top: true}, missing_playlist_creation_source: subject.source}};
  for (const change of ['remove', 'source', 'provider']) {
    const pending = deferred(); let options, received;
    const providers = {
      readPlaylistCreationSource: request => ({status: 'ready', data: {...request, allowed_actions: {can_read: true, can_use_for_playlist: true},
        entries_complete: true, retained_parent_albums: [], entries: ['one', 'two'].map(entry_ref => ({entry_ref, title: entry_ref,
          availability: 'missing', allowed_actions: {can_read: true, can_select: true},
          parent_album: {state: 'known', album_ref: 'album:same-parent', allowed_actions: {can_read: true, can_create_album_top: true}}}))}}),
      openAlbumTopDraft(intent, ui) {received = intent; options = ui; return pending.promise;},
    };
    const form = creation.createPlaylistCreationController({providers}); form.setContext(subject); await form.load(); form.edit({title: 'Draft'});
    const changedSource = {...sourcePayload, playlist_detail: {...sourcePayload.playlist_detail,
      allowed_actions: {can_open: true, can_create_album_top: false},
      missing_playlist_creation_source: {...subject.source, revision: 'revision:two'}}};
    const h = mountHarness(async () => changedSource, providers, sourcePayload);
    h.render(); assert.equal(h.render().props.onPrepareDraft(form.prepareDraft()), true);
    const page = h.renderDraft(h.render()), controller = page.props.controller;
    const opening = page.props.onTop(controller.topIntent());
    assert.equal(options.isCurrent(), true); assert.equal(options.signal.aborted, false);
    assert.doesNotMatch(JSON.stringify(received), /draftToken|playlist_id/);
    if (change === 'remove') {
      const albums = plain(controller.topIntent().album_refs);
      controller.remove('entry:one');
      assert.deepEqual(plain(controller.topIntent().album_refs), albums, 'retained occurrence changed while album refs did not');
    } else if (change === 'source') await h.mount.refresh();
    else h.mount.configureProviders({...providers, openAlbumTopDraft() {assert.fail('A replacement provider was invoked by the old child');}});
    assert.equal(options.signal.aborted, true);
    assert.equal(options.isCurrent(), false);
    let navigated = 0;
    assert.equal(options.retainNavigation(() => {navigated++;}), false);
    assert.equal(navigated, 0);
    pending.resolve(true); await opening;
    form.dispose(); h.mount.dispose();
  }
});
