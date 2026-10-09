const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');
const React = require('react');
const {buildSync} = require('esbuild');

const source = path.resolve(__dirname, '../../../music_app/static/js/playlists/creation-session.jsx');
const built = buildSync({entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-dom']}).outputFiles[0].text;
const selectionBuilt = buildSync({entryPoints: [path.resolve(__dirname, '../../../music_app/static/js/playlists/selection-actions.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
let model;
test.before(async () => {model = await import('../../../music_app/static/js/playlists/model.mjs');});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const elements = node => React.isValidElement(node)
  ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const descriptor = (revision = 'source-r1') => ({kind: 'library', ref: 'catalog:session-test', revision,
  allowed_actions: {can_read: true, can_use_for_playlist: true}});
const directory = ({revision = 'source-r1', created = false} = {}) => ({playlist_sidebar: {items: []},
  playlist_index: {playlists: created ? [{playlist_id: 'created:session-test', title: 'Authoritative created playlist',
    allowed_actions: {can_open: true}}] : []},
  playlist_actions: {can_create: true}, playlist_creation_source: descriptor(revision)});
const missingPlaylistId = 'source:session-test';
const missingDirectory = ({revision = 'source-r1', sourceRef = missingPlaylistId, canCreate = true, canUse = true} = {}) => ({
  playlist_sidebar: {items: [{playlist_id: missingPlaylistId, title: 'Source playlist', allowed_actions: {can_open: true}}]},
  playlist_actions: {can_create: canCreate},
  playlist_detail: {playlist_id: missingPlaylistId, title: 'Source playlist', revision, track_rows: [], items_complete: true,
    allowed_actions: {can_open: true, can_create_album_top: true},
    missing_playlist_creation_source: {kind: 'playlist', ref: sourceRef, revision,
      allowed_actions: {can_read: true, can_use_for_playlist: canUse}}},
});
const sourceResult = request => ({status: 'ready', data: {scopeKey: request.scopeKey, mode: request.mode,
  source: request.source, allowed_actions: {can_read: true, can_use_for_playlist: true}, entries_complete: true,
  entries: [{entry_ref: 'occurrence:private', canonical_track_ref: null, title: 'Private source title', artist: 'Private source artist',
    metadata_state: 'unknown', availability: 'missing', allowed_actions: {can_read: true, can_select: true},
    parent_album: {state: 'known', album_ref: 'album:private', title: 'Private album', allowed_actions: {can_view_details: true}}}],
  retained_parent_albums: []}});
const acknowledgement = request => ({status: 'ready', data: {scopeKey: request.scopeKey, request_key: request.request_key,
  playlist_id: 'created:session-test', revision: 'created-r1'}});

// A bounded hook driver invokes the actual session, NativeDialog, and
// CreationForm functions with separate hook lifetimes. Tests explicitly commit
// updates and control only provider promises and native owner completion. This
// is not React reconciliation, a DOM/browser test, or native navigation proof.
function hookDriver(bundle = built) {
  const fibers = new Map(); let current = null, lateUpdates = 0;
  const changed = (old, deps) => !old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  function effect(callback, deps) {
    const fiber = current, index = fiber.cursor++, old = fiber.slots[index];
    if (changed(old, deps)) fiber.pending.push(() => {
      old?.cleanup?.(); fiber.slots[index] = {deps, setup: callback, cleanup: callback()};
    });
  }
  const hooks = {...React,
    useId() {const fiber = current, index = fiber.cursor++; return `${fiber.name}-${index}`;},
    useRef(value) {const fiber = current, index = fiber.cursor++; return fiber.slots[index] ||= {current: value};},
    useMemo(factory, deps) {
      const fiber = current, index = fiber.cursor++;
      if (changed(fiber.slots[index], deps)) fiber.slots[index] = {deps, value: factory()};
      return fiber.slots[index].value;
    },
    useState(initial) {
      const fiber = current, index = fiber.cursor++;
      const slot = fiber.slots[index] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slot.value, value => {
        if (fiber.disposed) {lateUpdates++; return;}
        slot.value = typeof value === 'function' ? value(slot.value) : value;
      }];
    },
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore(subscribe, getSnapshot) {
      effect(() => subscribe(() => {}), [subscribe, getSnapshot]);
      return getSnapshot();
    },
  };
  const loaded = {exports: {}};
  vm.runInNewContext(bundle, {module: loaded, exports: loaded.exports, console, AbortController, TextEncoder, URL, crypto: {randomUUID},
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react-dom') return {createPortal: (children, host) => ({children, host})};
      // Shared selection imports the native mount entry, but these fixtures
      // exercise the real session/editor hook tree without mounting a DOM root.
      if (name === 'react-dom/client') return {createRoot() {assert.fail('Unexpected native playtable mount in the session hook harness.');}};
      assert.fail(`Unexpected session dependency: ${name}`);
    }});
  return {
    Session: loaded.exports.PlaylistCreationSession,
    ActionSession: loaded.exports.PlaylistActionSession,
    replayEffects(name) {
      const fiber = fibers.get(name);
      for (const slot of fiber.slots) if (slot?.setup) slot.cleanup?.();
      for (const slot of fiber.slots) if (slot?.setup) slot.cleanup = slot.setup();
    },
    render(name, Component, props) {
      const fiber = fibers.get(name) || {name, slots: [], disposed: false}; fibers.set(name, fiber);
      assert.equal(fiber.disposed, false, 'a disposed component must not be rendered again');
      fiber.cursor = 0; fiber.pending = []; current = fiber;
      let tree;
      try {tree = Component(props);} finally {current = null;}
      for (const callback of fiber.pending) callback();
      return tree;
    },
    dispose() {
      for (const name of ['form', 'seeded', 'session', 'dialog']) {
        const fiber = fibers.get(name);
        if (!fiber || fiber.disposed) continue;
        fiber.disposed = true;
        for (const slot of fiber.slots) slot?.cleanup?.();
      }
    },
    lateUpdates: () => lateUpdates,
  };
}

function sessionFixture({mode = 'ordinary', playlists, readSource, write, refresh, onClose, onPrepareDraft, confirm} = {}) {
  const driver = hookDriver(), reads = [], writes = [], refreshes = [], owners = [], navigations = [], drafts = [], notices = [];
  const refreshEntered = deferred(), closeEntered = deferred(), closing = deferred();
  if (!playlists) {
    playlists = model.createPlaylistController({readPlaylists: request => {
      refreshes.push(request); refreshEntered.resolve();
      return refresh ? refresh(request) : mode === 'missing' ? missingDirectory() : directory({created: true});
    }});
    playlists.setScope('account:session-test');
    playlists.accept(mode === 'missing' ? missingDirectory() : directory(), mode === 'missing' ? missingPlaylistId : null);
  }
  const providers = {
    readPlaylistCreationSource: request => {reads.push(request); return readSource ? readSource(request) : sourceResult(request);},
    createPlaylistFromSelection: request => {writes.push(request); return write ? write(request) : acknowledgement(request);},
  };
  const runtime = {alertHtml: config => config.message, confirm,
    openForm(config) {
      const owner = {config, host: {}, attempts: [], close(_value, options) {
        this.attempts.push(options); closeEntered.resolve(); return closing.promise;
      }};
      owners.push(owner); config.onMount(owner.host); return owner;
    },
  };
  let dialog, form, formProps, disposed = false;
  const fixture = {
    playlists, reads, writes, refreshes, owners, navigations, drafts, notices, refreshEntered, closeEntered, closing,
    render() {
      assert.equal(disposed, false);
      dialog = driver.render('session', driver.Session, {runtime, controller: playlists, state: playlists.getSnapshot(),
        mode, providers, onClose, onNavigate: id => navigations.push(id), onNotice: text => notices.push(text),
        onPrepareDraft: packet => {drafts.push(packet); return onPrepareDraft ? onPrepareDraft(packet) : true;}});
      let portal = driver.render('dialog', dialog.type, dialog.props);
      if (!portal) portal = driver.render('dialog', dialog.type, dialog.props);
      assert.ok(portal?.children, 'the native owner supplies a creation form host');
      formProps = portal.children.props;
      form = driver.render('form', portal.children.type, formProps);
      return form;
    },
    get controller() {return formProps.controller;},
    get state() {return formProps.state;},
    get form() {return form;},
    beforeDismiss: () => dialog.props.beforeDismiss(),
    submit: () => form.props.onSubmit({preventDefault() {}}),
    dispose() {if (!disposed) {disposed = true; driver.dispose();}},
    lateUpdates: driver.lateUpdates,
  };
  fixture.render(); return fixture;
}
function fill(fixture) {
  const controller = fixture.controller, row = controller.getSnapshot().sourceResource.data.entries[0];
  assert.equal(controller.edit({title: 'Keep my title', description: 'Keep my description'}), true);
  if (!controller.getSnapshot().selectedKeys.includes(row.row_key)) assert.equal(controller.toggle(row.row_key), true);
  assert.equal(controller.setQuery('Private source'), true);
  assert.equal(controller.review(row.row_key), true);
  fixture.render();
}
function assertRetired(controller) {
  const state = controller.getSnapshot();
  assert.equal(state.scopeKey, null); assert.equal(state.source, null); assert.equal(state.sourceResource.data, null);
  assert.equal(state.title, ''); assert.equal(state.description, ''); assert.equal(state.query, '');
  assert.equal(state.selectedKeys.length, 0); assert.equal(state.reviewKey, null);
}
const retirements = [
  ['provider replacement', playlists => playlists.configure({readPlaylists: () => directory()})],
  ['scope round trip', playlists => {playlists.setScope('account:other'); playlists.setScope('account:session-test');}],
  ['suspension', playlists => playlists.suspend()],
];

for (const [label, retire] of retirements) {
  test(`${label} immediately retires a pending source read even if the original context returns before rendering`, async () => {
    const read = deferred(), fixture = sessionFixture({readSource: () => read.promise}), creation = fixture.controller;
    const oldVersion = fixture.playlists.getLifecycleVersion();
    assert.equal(fixture.reads.length, 1); assert.equal(fixture.reads[0].signal.aborted, false);
    retire(fixture.playlists); fixture.playlists.accept(directory());
    assert.ok(fixture.playlists.getLifecycleVersion() > oldVersion);
    assert.equal(fixture.reads[0].signal.aborted, true); assertRetired(creation);
    read.resolve(sourceResult(fixture.reads[0])); await settle();
    fixture.render(); assertRetired(creation);
    assert.equal(fixture.state.sourceResource.data, null);
    assert.equal(await creation.load(), false); assert.equal(fixture.reads.length, 1);
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.refreshes.length, 0);
    fixture.dispose(); fixture.playlists.dispose();
  });

  test(`${label} aborts an in-flight write before rendering and ignores its late acknowledgement`, async () => {
    const write = deferred(), fixture = sessionFixture({write: () => write.promise});
    await settle(); fill(fixture);
    const creation = fixture.controller, pending = fixture.submit();
    assert.equal(fixture.writes.length, 1); assert.equal(await fixture.beforeDismiss(), false);
    retire(fixture.playlists); fixture.playlists.accept(directory());
    assert.equal(fixture.writes[0].signal.aborted, true); assertRetired(creation);
    write.resolve(acknowledgement(fixture.writes[0])); await pending;
    fixture.render(); await fixture.submit();
    assert.equal(fixture.writes.length, 1); assert.equal(fixture.refreshes.length, 0);
    assert.equal(fixture.owners[0].attempts.length, 0);
    assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.notices, []);
    assertRetired(creation); fixture.dispose(); fixture.playlists.dispose();
  });
}

test('revision-only invalidation preserves metadata and requires explicit source reload and a new selection', async () => {
  const fixture = sessionFixture(); await settle(); fill(fixture);
  fixture.playlists.accept(directory({revision: 'source-r2'}));
  const conflict = fixture.controller.getSnapshot();
  assert.equal(conflict.sourceResource.status, 'conflict'); assert.equal(conflict.sourceResource.data, null);
  assert.equal(conflict.title, 'Keep my title'); assert.equal(conflict.description, 'Keep my description');
  assert.equal(conflict.dirty, true); assert.equal(conflict.selectedKeys.length, 0); assert.equal(conflict.reviewKey, null);
  assert.equal(conflict.query, ''); assert.equal(fixture.reads.length, 1, 'a revision change does not silently reload');
  fixture.render(); await fixture.submit(); assert.equal(fixture.writes.length, 0);
  const status = elements(fixture.form).find(element => element.props.value === conflict.sourceResource && element.props.reload);
  assert.ok(status, 'the conflict offers the form reload action');
  await status.props.reload(); fixture.render();
  assert.equal(fixture.reads.length, 2); assert.equal(fixture.reads[1].source.revision, 'source-r2');
  assert.equal(fixture.state.sourceResource.status, 'ready'); assert.equal(fixture.state.selectedKeys.length, 0);
  assert.equal(fixture.state.title, 'Keep my title'); assert.equal(fixture.state.description, 'Keep my description');
  fixture.dispose(); fixture.playlists.dispose();
});

for (const [revision, expected] of [['source-r1', 'refresh_required'], ['source-r2', 'conflict']]) {
  test(`parent refresh to ${revision} pauses source authority, preserves metadata, and requires explicit reload`, async () => {
    const refresh = deferred(), fixture = sessionFixture({refresh: () => refresh.promise});
    await settle(); fill(fixture);
    const controller = fixture.controller, pending = fixture.playlists.load();
    const paused = controller.getSnapshot();
    assert.equal(paused.sourceResource.status, 'loading'); assert.equal(paused.sourceResource.data, null);
    assert.equal(paused.title, 'Keep my title'); assert.equal(paused.description, 'Keep my description');
    assert.equal(paused.source.ref, 'catalog:session-test'); assert.equal(paused.selectedKeys.length, 0);
    assert.equal(paused.reviewKey, null); assert.equal(await controller.submit(), false);
    assert.equal(fixture.reads.length, 1); assert.equal(fixture.writes.length, 0);
    refresh.resolve(directory({revision})); assert.equal(await pending, true);
    const refreshed = controller.getSnapshot();
    assert.equal(refreshed.sourceResource.status, expected); assert.equal(refreshed.sourceResource.data, null);
    assert.equal(refreshed.title, 'Keep my title'); assert.equal(refreshed.description, 'Keep my description');
    assert.equal(fixture.reads.length, 1, 'parent refresh must not silently reselect or reload private source rows');
    fixture.render(); assert.equal(fixture.controller, controller, 'the form keeps a stable controller adapter');
    const status = elements(fixture.form).find(element => element.props.value === refreshed.sourceResource && element.props.reload);
    assert.ok(status, 'fresh authority requires an explicit Reload tracks action');
    await status.props.reload(); fixture.render();
    assert.equal(fixture.reads.length, 2); assert.equal(fixture.refreshes.length, 1);
    assert.equal(fixture.reads[1].source.revision, revision); assert.equal(fixture.state.sourceResource.status, 'ready');
    assert.equal(fixture.state.selectedKeys.length, 0); assert.equal(fixture.state.title, 'Keep my title');
    fixture.dispose(); fixture.playlists.dispose();
  });
}

test('Reload tracks after a parent read error waits for renewed authority before reading source rows', async () => {
  const failedRefresh = deferred(), retryRefresh = deferred(); let refreshCount = 0;
  const fixture = sessionFixture({refresh: () => (++refreshCount === 1 ? failedRefresh : retryRefresh).promise});
  await settle(); fill(fixture);
  const pending = fixture.playlists.load(); failedRefresh.reject(new Error('Directory read failed'));
  assert.equal(await pending, false);
  const failed = fixture.controller.getSnapshot();
  assert.equal(failed.sourceResource.status, 'error'); assert.equal(failed.sourceResource.data, null);
  assert.equal(failed.title, 'Keep my title'); assert.equal(failed.description, 'Keep my description');
  fixture.render();
  const status = elements(fixture.form).find(element => element.props.value === failed.sourceResource && element.props.reload);
  assert.ok(status);
  const retry = status.props.reload();
  assert.equal(fixture.refreshes.length, 2); assert.equal(fixture.reads.length, 1, 'source is not readable until parent authority returns');
  assert.equal(fixture.controller.getSnapshot().sourceResource.status, 'loading');
  retryRefresh.resolve(directory({revision: 'source-r2'})); assert.equal(await retry, true); fixture.render();
  assert.equal(fixture.reads.length, 2); assert.equal(fixture.reads[1].source.revision, 'source-r2');
  assert.equal(fixture.state.sourceResource.status, 'ready'); assert.equal(fixture.state.selectedKeys.length, 0);
  assert.equal(fixture.state.title, 'Keep my title'); assert.equal(fixture.state.description, 'Keep my description');
  assert.equal(fixture.writes.length, 0); fixture.dispose(); fixture.playlists.dispose();
});

test('acknowledgement retires private source data, awaits authoritative refresh and native close, then navigates after form cleanup', async () => {
  const refresh = deferred(); let fixture;
  fixture = sessionFixture({refresh: () => refresh.promise, onClose: () => fixture.dispose()});
  await settle(); fill(fixture);
  const creation = fixture.controller, pending = fixture.submit(); await fixture.refreshEntered.promise;
  assertRetired(creation); fixture.render();
  assert.equal(fixture.state.mutation.status, 'ready'); assert.equal(fixture.state.mutation.data.playlist_id, 'created:session-test');
  assert.equal(fixture.state.source, null); assert.equal(fixture.state.sourceResource.data, null);
  assert.equal(fixture.state.selectedKeys.length, 0); assert.equal(fixture.state.reviewKey, null); assert.equal(fixture.state.query, '');
  assert.equal(fixture.form.props['aria-busy'], true); assert.equal(await fixture.beforeDismiss(), false);
  assert.equal(fixture.owners[0].attempts.length, 0); assert.deepEqual(fixture.navigations, []);
  await fixture.submit(); assert.equal(fixture.writes.length, 1);
  refresh.resolve(directory({created: true})); await fixture.closeEntered.promise;
  const owner = fixture.owners[0];
  assert.deepEqual(plain(owner.attempts[0]), {force: true, restoreFocus: false, reason: 'cancel'});
  assert.deepEqual(fixture.navigations, [], 'navigation waits for the native owner to complete');
  owner.config.onClose(owner.host, owner.attempts[0]);
  fixture.closing.resolve(true); await pending;
  assert.deepEqual(fixture.navigations, ['created:session-test']); assert.deepEqual(fixture.notices, []);
  assert.deepEqual(fixture.drafts, [], 'ordinary Create keeps its acknowledged persistence path');
  assert.equal(fixture.writes.length, 1); assert.equal(fixture.refreshes.length, 1);
  assert.equal(fixture.lateUpdates(), 0, 'native close may unmount the form before its promise completes');
  fixture.playlists.dispose();
});

test('refresh failure keeps a truthful confirmed-create state and cannot issue another write', async () => {
  const refresh = deferred(), fixture = sessionFixture({refresh: () => refresh.promise});
  await settle(); fill(fixture);
  const creation = fixture.controller, pending = fixture.submit(); await fixture.refreshEntered.promise;
  assertRetired(creation); refresh.reject(new Error('Private refresh transport detail')); await pending;
  fixture.render();
  assert.equal(fixture.state.mutation.status, 'ready'); assert.ok(fixture.state.mutation.request_key);
  assert.equal(fixture.state.sourceResource.data, null); assert.equal(fixture.state.title, 'Keep my title');
  assert.equal(fixture.form.props['aria-busy'], false);
  const status = elements(fixture.form).find(element => element.props.mutation === fixture.state.mutation);
  assert.ok(status); assert.equal(status.type(status.props).props.html, 'Playlist created, but the playlist list could not be refreshed.');
  const create = elements(fixture.form).find(element => element.props.type === 'submit');
  assert.equal(create.props.disabled, true);
  await fixture.submit(); assert.equal(await creation.submit(), false);
  assert.equal(fixture.writes.length, 1); assert.equal(fixture.refreshes.length, 1);
  assert.equal(fixture.owners[0].attempts.length, 0); assert.deepEqual(fixture.navigations, []);
  assert.equal(await fixture.beforeDismiss(), true);
  fixture.dispose(); fixture.playlists.dispose();
});

for (const [label, retire] of retirements) test(`${label} during refresh cannot revive an acknowledged session after the context returns`, async () => {
  const refresh = deferred(), fixture = sessionFixture({refresh: () => refresh.promise});
  await settle(); fill(fixture);
  const pending = fixture.submit(); await fixture.refreshEntered.promise;
  retire(fixture.playlists); fixture.playlists.accept(directory({created: true}));
  assert.equal(fixture.refreshes[0].signal.aborted, true);
  refresh.resolve(directory({created: true})); await pending; fixture.render();
  assertRetired(fixture.controller); assert.equal(fixture.state.mutation.status, 'idle');
  assert.equal(fixture.owners[0].attempts.length, 0); assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.notices, []);
  assert.equal(fixture.writes.length, 1); fixture.dispose(); fixture.playlists.dispose();
});

for (const [label, retire] of retirements) test(`${label} during native return prevents stale navigation after the same context returns`, async () => {
  const fixture = sessionFixture(); await settle(); fill(fixture);
  const pending = fixture.submit(); await fixture.closeEntered.promise;
  assert.equal(fixture.owners[0].attempts.length, 1); assert.deepEqual(fixture.navigations, []);
  retire(fixture.playlists); fixture.playlists.accept(directory({created: true}));
  fixture.closing.resolve(true); await pending;
  assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.notices, []);
  assert.equal(fixture.owners[0].attempts.length, 1, 'a retired session cannot close another native owner');
  fixture.dispose(); fixture.playlists.dispose();
});

test('source-change fallback notice cannot escape a replaced lifecycle while native close is pending', async () => {
  const fixture = sessionFixture({refresh: () => directory({revision: 'source-r2', created: true})});
  await settle(); fill(fixture);
  const pending = fixture.submit(); await fixture.closeEntered.promise;
  fixture.playlists.configure({readPlaylists: () => directory({revision: 'source-r2', created: true})});
  fixture.playlists.accept(directory({revision: 'source-r2', created: true}));
  fixture.closing.resolve(true); await pending;
  assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.notices, [], 'old completion must not notify a replacement lifecycle');
  fixture.dispose(); fixture.playlists.dispose();
});

test('late cleanup and source completion from an old session cannot clear or unsubscribe its replacement', async () => {
  const oldRead = deferred(), old = sessionFixture({readSource: () => oldRead.promise});
  old.playlists.configure({readPlaylists: () => directory()}); old.playlists.accept(directory());
  const replacement = sessionFixture({playlists: old.playlists}); await settle(); fill(replacement);
  const current = replacement.controller, snapshot = current.getSnapshot(), signal = replacement.reads[0].signal;
  old.dispose(); oldRead.resolve(sourceResult(old.reads[0])); await settle();
  assert.equal(current.getSnapshot(), snapshot); assert.equal(signal.aborted, false);
  assert.equal(replacement.owners[0].attempts.length, 0); assert.equal(old.reads[0].signal.aborted, true);
  assertRetired(old.controller);
  old.playlists.accept(directory({revision: 'source-r2'}));
  assert.equal(current.getSnapshot().sourceResource.status, 'conflict', 'replacement remains subscribed to the live playlist owner');
  assert.equal(current.getSnapshot().title, 'Keep my title');
  replacement.dispose(); old.playlists.dispose();
});

test('missing Create transfers its immutable draft exactly once after native close and form cleanup, without persistence or refresh', async () => {
  let fixture;
  fixture = sessionFixture({mode: 'missing', onClose: () => fixture.dispose()});
  await settle(); fill(fixture);
  const creation = fixture.controller, packet = creation.prepareDraft(), snapshot = creation.getSnapshot();
  const submit = fixture.submit, pending = submit(); await fixture.closeEntered.promise;
  assert.equal(fixture.reads[0].mode, 'missing'); assert.equal(fixture.reads[0].source.kind, 'playlist');
  assert.equal(fixture.writes.length, 0); assert.equal(fixture.refreshes.length, 0);
  assert.equal(creation.getSnapshot(), snapshot); assert.equal(snapshot.mutation.status, 'idle');
  assert.equal(snapshot.mutation.request_key, null); assert.deepEqual(fixture.drafts, []);
  assert.equal(await fixture.beforeDismiss(), false);
  assert.equal(fixture.render().props['aria-busy'], true);
  await submit(); assert.equal(fixture.owners[0].attempts.length, 1);
  const owner = fixture.owners[0];
  assert.deepEqual(plain(owner.attempts[0]), {force: true, restoreFocus: false, reason: 'cancel'});
  owner.config.onClose(owner.host, owner.attempts[0]);
  assertRetired(creation); assert.deepEqual(fixture.drafts, [], 'native teardown alone does not complete its awaited close');
  fixture.closing.resolve(true); await pending;
  assert.equal(fixture.drafts.length, 1); assert.equal(fixture.drafts[0], packet);
  assert.equal(packet.title, 'Keep my title'); assert.equal(packet.description, 'Keep my description');
  assert.equal(packet.source.revision, 'source-r1'); assert.equal(packet.canCreateAlbumTop, true);
  assert.deepEqual(plain(packet.entries.map(row => row.entry_ref)), ['occurrence:private']);
  for (const value of [packet, packet.source, packet.entries, packet.entries[0], packet.entries[0].parent_album]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(Reflect.set(packet.entries[0], 'title', 'Changed after teardown'), false);
  await submit(); assert.equal(fixture.drafts.length, 1);
  assert.equal(fixture.writes.length, 0); assert.equal(fixture.refreshes.length, 0);
  assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.notices, []);
  assert.equal(fixture.lateUpdates(), 0); fixture.playlists.dispose();
});

test('a refused native close keeps the missing selection in its form and never transfers or saves it', async () => {
  const fixture = sessionFixture({mode: 'missing'}); await settle(); fill(fixture);
  const snapshot = fixture.controller.getSnapshot(), pending = fixture.submit(); await fixture.closeEntered.promise;
  fixture.closing.resolve(false); await pending; fixture.render();
  assert.equal(fixture.controller.getSnapshot(), snapshot); assert.equal(fixture.form.props['aria-busy'], false);
  const status = elements(fixture.form).find(element => element.props.mutation);
  assert.match(status.type(status.props).props.html, /unsaved playlist could not be opened.*selection has not been saved/);
  assert.deepEqual(fixture.drafts, []); assert.equal(fixture.writes.length, 0); assert.equal(fixture.refreshes.length, 0);
  fixture.dispose(); fixture.playlists.dispose();
});

test('a missing source revision changed before Create preserves metadata and blocks transfer until explicit reload and selection', async () => {
  const fixture = sessionFixture({mode: 'missing'}); await settle(); fill(fixture);
  fixture.playlists.accept(missingDirectory({revision: 'source-r2'}), missingPlaylistId);
  fixture.render(); await fixture.submit();
  const state = fixture.controller.getSnapshot();
  assert.equal(state.sourceResource.status, 'conflict'); assert.equal(state.sourceResource.data, null);
  assert.equal(state.title, 'Keep my title'); assert.equal(state.description, 'Keep my description');
  assert.equal(state.selectedKeys.length, 0); assert.equal(fixture.controller.prepareDraft(), null);
  assert.equal(fixture.reads.length, 1); assert.equal(fixture.owners[0].attempts.length, 0);
  assert.deepEqual(fixture.drafts, []); assert.equal(fixture.writes.length, 0); assert.equal(fixture.refreshes.length, 0);
  const status = elements(fixture.form).find(element => element.props.value === state.sourceResource && element.props.reload);
  assert.ok(status); await status.props.reload(); fixture.render();
  assert.equal(fixture.reads.length, 2); assert.equal(fixture.reads[1].source.revision, 'source-r2');
  assert.equal(fixture.state.sourceResource.status, 'ready'); assert.equal(fixture.state.selectedKeys.length, 0);
  await fixture.submit(); assert.equal(fixture.owners[0].attempts.length, 0);
  assert.equal(fixture.controller.toggle(fixture.state.sourceResource.data.entries[0].row_key), true);
  assert.equal(fixture.controller.prepareDraft().source.revision, 'source-r2');
  assert.equal(fixture.controller.getSnapshot().title, 'Keep my title');
  fixture.dispose(); fixture.playlists.dispose();
});

test('a same-source revision change during close preserves the original draft packet for the destination owner conflict', async () => {
  let fixture, destinationRevision;
  fixture = sessionFixture({mode: 'missing', onClose: () => fixture.dispose(), onPrepareDraft: () => {
    destinationRevision = fixture.playlists.getSnapshot().resource.data.detail.missing_playlist_creation_source.revision;
    return true;
  }});
  await settle(); fill(fixture);
  const packet = fixture.controller.prepareDraft(), pending = fixture.submit(); await fixture.closeEntered.promise;
  fixture.playlists.accept(missingDirectory({revision: 'source-r2'}), missingPlaylistId);
  assert.equal(fixture.controller.getSnapshot().sourceResource.status, 'conflict');
  assert.deepEqual(fixture.drafts, []);
  const owner = fixture.owners[0]; owner.config.onClose(owner.host, owner.attempts[0]);
  fixture.closing.resolve(true); await pending;
  assert.equal(fixture.drafts.length, 1); assert.equal(fixture.drafts[0], packet);
  assert.equal(packet.source.revision, 'source-r1'); assert.equal(destinationRevision, 'source-r2');
  assert.equal(packet.title, 'Keep my title'); assert.equal(packet.description, 'Keep my description');
  assert.equal(packet.entries[0].title, 'Private source title'); assert.equal(Object.isFrozen(packet), true);
  assert.equal(fixture.writes.length, 0); assert.equal(fixture.refreshes.length, 0); assert.equal(fixture.reads.length, 1);
  assert.equal(fixture.lateUpdates(), 0); fixture.playlists.dispose();
});

const missingTransferRetirements = [
  ...retirements,
  ['navigation round trip', playlists => playlists.select(null, {load: false, fromNavigation: true})],
  ['source identity round trip', playlists => playlists.accept(missingDirectory({sourceRef: 'other:source'}), missingPlaylistId)],
  ['creation permission round trip', playlists => playlists.accept(missingDirectory({canCreate: false}), missingPlaylistId)],
  ['source permission round trip', playlists => playlists.accept(missingDirectory({canUse: false}), missingPlaylistId)],
  ['denial round trip', playlists => playlists.accept({status: 'denied'}, missingPlaylistId)],
];
for (const [label, retire] of missingTransferRetirements) {
  for (const afterCleanup of [false, true]) {
    test(`${label} ${afterCleanup ? 'after' : 'before'} form cleanup prevents late missing transfer when the original context returns`, async () => {
      let fixture;
      fixture = sessionFixture({mode: 'missing', onClose: () => fixture.dispose()}); await settle(); fill(fixture);
      const pending = fixture.submit(); await fixture.closeEntered.promise;
      const owner = fixture.owners[0];
      assert.equal(owner.attempts.length, 1); assert.deepEqual(fixture.drafts, []);
      if (afterCleanup) owner.config.onClose(owner.host, owner.attempts[0]);
      const closeAttempts = owner.attempts.length;
      retire(fixture.playlists); fixture.playlists.accept(missingDirectory(), missingPlaylistId);
      fixture.closing.resolve(true); await pending;
      assert.deepEqual(fixture.drafts, []); assert.equal(fixture.writes.length, 0); assert.equal(fixture.refreshes.length, 0);
      assert.deepEqual(fixture.navigations, []); assert.deepEqual(fixture.notices, []);
      assert.equal(owner.attempts.length, closeAttempts, 'a retired transfer cannot close a replacement owner');
      assert.equal(fixture.lateUpdates(), 0); fixture.dispose(); fixture.playlists.dispose();
    });
  }
}

function selectedActionFixture({refreshFails = false, readDestinations, initialMode} = {}) {
  const driver = hookDriver(selectionBuilt), closing = deferred(), closeEntered = deferred(), owners = [], writes = [], addWrites = [], navigations = [], closed = [];
  const invalidations = new Set(), destinationReads = []; let current = true, dialog, form, formProps, picker;
  const source = {scopeKey: 'scope:selected-session', instance: {}, revision: 'view:r1',
    rows: [{rowKey: 'row:selected', readable: true, selectable: true}]};
  const sourceAdapter = {snapshot: () => source, subscribe: () => () => {}, resolveRows: () => ({
    rows: [{rowKey: 'row:selected', track_ref: '/private/selected.flac', entry_ref: 'occurrence:private'}], playlist_creation_source: descriptor()})};
  const lifetime = {signal: new AbortController().signal, isCurrent: () => current,
    subscribeInvalidation(listener) {invalidations.add(listener); return () => invalidations.delete(listener);}};
  const providers = {readPlaylistDestinations: async request => {
    destinationReads.push(request);
    if (readDestinations) return readDestinations(request);
    if (refreshFails && writes.length) throw new Error('Refresh failed');
    return {status: 'ready', data: {scopeKey: request.scopeKey, allowed_actions: {can_create: true}, playlist_creation_source: descriptor(),
      destinations: [{playlist_id: 'created:session-test', title: 'Created destination', allowed_actions: {can_add: true, can_open: true}}]}};
  }, addTracks: async request => {addWrites.push(request); return {ok: true};}, readPlaylistCreationSource: async request => sourceResult(request),
  createPlaylistFromSelection: async request => {writes.push(request); return acknowledgement(request);}};
  const runtime = {alertHtml: config => config.message, confirm: async () => true, openForm(config) {
    const owner = {config, host: {}, attempts: [], updatePresentation(value) {Object.assign(config, value); return true;}, close(_value, options) {this.attempts.push(options); closeEntered.resolve(); return closing.promise;}};
    owners.push(owner); config.onMount(owner.host); return owner;
  }};
  const fixture = {owners, writes, addWrites, navigations, closed, closing, closeEntered, destinationReads,
    replaySessionEffects() {driver.replayEffects('session'); fixture.render();},
    render() {
      dialog = driver.render('session', driver.ActionSession, {runtime, sourceAdapter, lifetime, providers, initialMode,
        packet: {scopeKey: source.scopeKey, row_keys: ['row:selected'], origin: {tableKey: 'table:selected', target: 'selection'}},
        onClose: value => closed.push(value), onNavigate: id => navigations.push(id)});
      let portal = driver.render('dialog', dialog.type, dialog.props);
      if (!portal) portal = driver.render('dialog', dialog.type, dialog.props);
      if (!portal) return;
      const seeded = elements(portal.children).find(element => element.props.action);
      if (!seeded) {picker = portal.children; return;}
      const creation = driver.render('seeded', seeded.type, seeded.props);
      formProps = creation.props; form = driver.render('form', creation.type, creation.props);
    },
    async openCreate() {fixture.render(); const button = elements(picker).find(element => element.props.children === 'Create new playlist');
      assert.ok(button); assert.equal(button.props.disabled, false); await button.props.onClick(); fixture.render();},
    get creation() {return formProps.controller;}, get state() {return formProps.state;}, get form() {return form;}, get picker() {return picker;},
    submit: () => form.props.onSubmit({preventDefault() {}}), beforeDismiss: () => dialog.props.beforeDismiss(),
    retire() {current = false; invalidations.forEach(listener => listener());}, dispose: () => driver.dispose(), lateUpdates: driver.lateUpdates,
  };
  fixture.render(); return fixture;
}

test('selected-track picker switches to real seeded CreationForm in one native form and awaits native return before navigation', async () => {
  const fixture = selectedActionFixture(); await settle(); await fixture.openCreate();
  assert.equal(fixture.owners.length, 1, 'Create retains one native form owner');
  assert.equal(fixture.owners[0].config.title, 'Create playlist');
  assert.equal(fixture.owners[0].config.pageId, 'create-playlist');
  assert.equal(fixture.state.tab, 'selected');
  assert.equal(fixture.writes.length, 0);
  assert.deepEqual(plain(fixture.state.selectedKeys), ['entry:occurrence:private']);
  assert.equal(fixture.creation.edit({title: 'Selection playlist'}), true);
  const pending = fixture.submit(); await fixture.closeEntered.promise; fixture.render();
  assert.equal(fixture.state.mutation.status, 'ready'); assert.equal(fixture.state.sourceResource.data, null);
  assert.equal(await fixture.beforeDismiss(), false); assert.deepEqual(fixture.navigations, []);
  const owner = fixture.owners[0]; owner.config.onClose(owner.host, owner.attempts[0]);
  assert.equal(fixture.closed.length, 0, 'native teardown retains the source receipt until return settles');
  fixture.closing.resolve(true); await pending;
  assert.deepEqual(fixture.navigations, ['created:session-test']); assert.equal(fixture.closed.length, 1);
  assert.equal(fixture.writes.length, 1); assert.deepEqual(plain(fixture.writes[0].entry_refs), ['occurrence:private']); fixture.dispose();
});

test('selected-track session reacquires its disposed controller after layout effect replay', async () => {
  const fixture = selectedActionFixture(); await settle();
  fixture.replaySessionEffects(); await settle(); await fixture.openCreate();
  assert.equal(fixture.destinationReads.length, 3, 'initial, replacement, and deliberate Create authority reads');
  assert.equal(fixture.owners.length, 1, 'controller effect replay does not open a second form');
  assert.deepEqual(plain(fixture.state.selectedKeys), ['entry:occurrence:private']);
  assert.equal(fixture.creation.edit({title: 'After effect replay'}), true);
  fixture.dispose();
});

test('a pending read-only destination lookup can be cancelled and a late response cannot reopen the native form', async () => {
  const pending = deferred(), fixture = selectedActionFixture({readDestinations: () => pending.promise});
  fixture.render();
  const cancel = elements(fixture.picker).find(element => element.props.children === 'Cancel');
  assert.ok(cancel); assert.equal(cancel.props.disabled, false); assert.equal(await fixture.beforeDismiss(), true);
  cancel.props.onClick(); const owner = fixture.owners[0];
  owner.config.onClose(owner.host, owner.attempts[0]); fixture.dispose(); fixture.closing.resolve(true);
  assert.equal(fixture.destinationReads[0].signal.aborted, true);
  pending.resolve({status: 'empty', data: {scopeKey: 'scope:selected-session', allowed_actions: {can_create: false}, destinations: []}});
  await settle(); assert.equal(fixture.owners.length, 1); assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.closed.length, 1); assert.equal(fixture.lateUpdates(), 0);
});

test('accepted native dismissal aborts a pre-Add read before its late response can dispatch in the teardown window', async () => {
  const pending = deferred(); let reads = 0;
  const result = request => ({status: 'ready', data: {scopeKey: request.scopeKey, allowed_actions: {can_create: false},
    destinations: [{playlist_id: 'created:session-test', allowed_actions: {can_add: true}}]}});
  const fixture = selectedActionFixture({readDestinations: request => ++reads === 1 ? result(request) : pending.promise});
  await settle(); fixture.render();
  elements(fixture.picker).find(element => element.props.label === 'Playlist').props.onChange('created:session-test');
  fixture.render(); elements(fixture.picker).find(element => element.type === 'form').props.onSubmit({preventDefault() {}});
  assert.equal(fixture.destinationReads.length, 2);
  const accepted = fixture.beforeDismiss();
  pending.resolve(result(fixture.destinationReads[1]));
  assert.equal(await accepted, true); await settle();
  assert.equal(fixture.destinationReads[1].signal.aborted, true); assert.equal(fixture.addWrites.length, 0);
  fixture.dispose();
});

test('selected-track Create completion keeps acknowledged success on refresh failure and blocks retired-source navigation', async () => {
  const failed = selectedActionFixture({refreshFails: true}); await settle(); await failed.openCreate();
  failed.creation.edit({title: 'Confirmed'}); await failed.submit(); failed.render();
  assert.equal(failed.state.mutation.status, 'ready'); assert.equal(failed.state.sourceResource.data, null);
  assert.equal(await failed.beforeDismiss(), true); await failed.submit(); assert.equal(failed.writes.length, 1);
  const status = elements(failed.form).find(element => element.props.mutation === failed.state.mutation);
  assert.match(status.type(status.props).props.html, /created.*could not be refreshed/); failed.dispose();
  const retired = selectedActionFixture(); await settle(); await retired.openCreate(); retired.creation.edit({title: 'Created'});
  const pending = retired.submit(); await retired.closeEntered.promise; retired.retire();
  const owner = retired.owners[0]; owner.config.onClose(owner.host, owner.attempts[0]); retired.closing.resolve(true); await pending;
  assert.deepEqual(retired.navigations, []); assert.equal(retired.closed.length, 1); assert.equal(retired.writes.length, 1); retired.dispose();
});


test('direct Create enters the standard builder with Selected prefilled and no chooser or write', async () => {
  const fixture = selectedActionFixture({initialMode: 'create'}); await settle(); await settle(); fixture.render();
  assert.equal(fixture.owners.length, 1); assert.equal(fixture.owners[0].config.title, 'Create playlist');
  assert.equal(fixture.owners[0].config.pageId, 'create-playlist'); assert.equal(fixture.state.tab, 'selected');
  assert.deepEqual(plain(fixture.state.selectedKeys), ['entry:occurrence:private']);
  assert.equal(fixture.writes.length, 0); assert.equal(fixture.addWrites.length, 0); fixture.dispose();
});

test('review v2: direct Create can recover a failed initial destination read in its retained dialog', async () => {
  let reads = 0;
  const fixture = selectedActionFixture({initialMode: 'create', readDestinations: async request => {
    if (++reads === 1) throw new Error('temporary read failure');
    return {status: 'ready', data: {scopeKey: request.scopeKey, allowed_actions: {can_create: true},
      playlist_creation_source: descriptor(), destinations: []}};
  }});
  await settle(); fixture.render();
  const retry = elements(fixture.picker).find(element => !element.props.disabled && /retry|reload/i.test(String(element.props.children)) && element.props.onClick);
  assert.ok(retry, 'a recoverable read error must expose an enabled retry');
  await retry.props.onClick(); await settle(); await settle(); fixture.render();
  assert.equal(fixture.state.tab, 'selected'); assert.equal(fixture.owners.length, 1);
  assert.equal(fixture.writes.length, 0); fixture.dispose();
});
