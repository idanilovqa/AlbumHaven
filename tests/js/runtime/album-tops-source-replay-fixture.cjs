'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const ROOT = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
const read = file => fs.readFileSync(path.join(ROOT, 'music_app/static/js', file), 'utf8');
const load = file => import(pathToFileURL(path.join(ROOT, 'music_app/static/js', file)).href);
const script = (context, file) => vm.runInContext(read(`runtime/${file}`), context, {filename: file});
const plain = value => JSON.parse(JSON.stringify(value));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOP = id(1), OTHER = id(2), ALBUM = id(11), ITEM = id(21), KEY = 'Artist/Original edition', SCOPE = 'top-replay:account:session:library';
const row = patch => ({item_ref: ITEM, album_ref: ALBUM, title: 'Album', artist: 'Artist', position: 1,
  native_album: {inventory_album_ref: 'inventory-album:2:11', allowed_actions: {can_view_details: true}}, ...patch});
const detail = patch => ({top_ref: TOP, revision: '7', title: 'Saved Top', description: '', visibility: 'private',
  allowed_actions: {'library.browse.read': true, can_read: true}, items: [row()], ...patch});
const origin = () => ({source: 'album_top', top_ref: TOP, item_ref: ITEM, revision: '7'});
const target = () => ({kind: 'album', ref: ALBUM, origin: origin(), allowed_actions: {can_view_details: true},
  native_actions: {album_ref: KEY, allowed_actions: {can_open_album: true, can_play_album: false}}});
const reply = (payload, key = KEY) => ({...payload, native_target: {album_ref: key,
  allowed_actions: {can_view_details: true, can_play_album: false}}});
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const atBoundary = (entered, operation) => Promise.race([entered.promise, Promise.resolve(operation).then(() => {
  throw new Error('Expected pending native/provider boundary was not reached');
})]);

// The actual resource-selection and source-page registry own admission, retained
// receipts, replay hydration, restrictions, eviction and race fences. Only the
// remote Album response and missing DOM overlay are boundary doubles. This
// fixture does not replace their validators, manufacture source owner callbacks,
// or reproduce the registry in another Map.
function installNative(context, {hydrate, present} = {}) {
  const hydrations = [], presentations = [], boundaryErrors = [];
  context.state ||= {}; context.state.ui ||= {}; context.state.ui.pendingTrackModalLoadToken ||= 0;
  context.getAlbumRequestKey = album => album.key;
  script(context, 'resource-selection.js');
  script(context, 'track-modal-lightbox-helpers.js');
  const openTrackModal = context.openTrackModal;
  context.getTrackModalElements = () => ({overlay: null});
  const check = callback => {try {return callback();} catch (error) {boundaryErrors.push(error); throw error;}};
  context.fetchTrackModalAlbumDetails = async (key, options) => {
    const call = {key, options}; hydrations.push(call);
    check(() => {assert.equal(key, KEY); assert.equal(options.isCurrent(), true); assert.equal(options.signal?.aborted, false);});
    return hydrate ? hydrate(call, hydrations.length) : {key, name: 'Album', album_artist: 'Artist', tracks: []};
  };
  context.openTrackModal = (album, options) => {
    // Real opener admits and retains the source before its established absent-
    // overlay boundary. No Album rendering or visual acceptance is claimed.
    const result = openTrackModal(album, options);
    const restrictions = context.getTrackModalPresentationRestrictions();
    const owner = context.getTrackModalSourcePageOwner();
    check(() => {assert.ok(owner); assert.equal(owner.isCurrent(), true); assert.equal(restrictions.can_play_album, false);});
    const record = {album, options, owner, restrictions}; presentations.push(record);
    const presented = present?.(record, presentations.length);
    return presented === undefined ? result : presented;
  };
  return {hydrations, presentations, boundaryErrors, check,
    descriptor(index = presentations.length - 1) {const {album, owner} = presentations[index]; return {kind: 'album', albumKey: album.key, sourcePageToken: owner.token};},
    restore(descriptor = this.descriptor(), options = {}) {
      return context.restoreTrackModalSourcePage(descriptor, {signal: new AbortController().signal, isCurrent: () => true, ...options});
    },
  };
}

async function fixture(t, {readTop, resolve, hydrate, present} = {}) {
  const [{createAlbumTopSourceReplay}, {createAlbumTopDetails}] = await Promise.all([
    load('album-tops/source-replay.mjs'), load('album-tops/details.mjs'),
  ]);
  const context = vm.createContext({window: {}, document: {getElementById: () => null}, AbortController});
  const native = installNative(context, {hydrate, present});
  let backend = detail(), shell = {authenticated: true, inLibrary: true, visible: true, active: true,
    scopeKey: SCOPE, topRef: TOP, viewVersion: 1, viewRequestId: 3};
  const reads = [], resolutions = [], nativeOwners = [], detailsOwners = [], errors = [];
  const providers = {
    async read(ref, options) {
      const call = {ref, options}; reads.push(call);
      native.check(() => {assert.equal(ref, TOP); assert.equal(options.scopeKey, SCOPE); assert.ok(options.signal instanceof AbortSignal);
        assert.deepEqual(Object.keys(options).sort(), ['scopeKey', 'signal']);});
      return readTop ? readTop(call, reads.length, backend) : structuredClone(backend);
    },
    async resolveNativeAlbum(payload, options) {
      const call = {payload, options}; resolutions.push(call);
      native.check(() => {assert.deepEqual(Object.keys(payload).sort(), ['album_ref', 'inventory_album_ref', 'item_ref', 'revision', 'top_ref']);
        assert.equal(options.scopeKey, SCOPE); assert.ok(options.signal instanceof AbortSignal);
        assert.deepEqual(Object.keys(options).sort(), ['isCurrent', 'scopeKey', 'signal']); assert.equal(options.isCurrent(), true);});
      return resolve ? resolve(call, resolutions.length) : reply(payload);
    },
  };
  const runtime = {snapshot: () => shell,
    projectResourceTarget: context.window.AlbumHavenResourceSelection.projectTarget,
    projectResourceOrigin: context.window.AlbumHavenResourceSelection.projectOrigin,
    createResourceSelection(hooks) {
      const owner = context.window.AlbumHavenResourceSelection.create(hooks); nativeOwners.push({owner, hooks}); return owner;
    },
  };
  const sourceReplay = createAlbumTopSourceReplay({runtime, providers});
  function mountUI(data = detail()) {
    const owner = Object.freeze({scopeKey: SCOPE, detail: data, providers});
    let state = {scopeKey: SCOPE, selectedTopRef: data.top_ref, directory: {status: 'ready'},
      detail: {status: 'ready', data}, mutation: {status: 'idle', refreshing: false}};
    const controller = {getSnapshot: () => state};
    const details = createAlbumTopDetails({runtime, providers, controller, sourceReplay, readOwner: () => owner,
      onError: error => errors.push(error)});
    detailsOwners.push(details);
    return {details, owner, data, controller, open: (member = data.items[0]) => details.open(member),
      setState(patch) {state = {...state, ...patch};}};
  }
  const ui = mountUI();
  t.after(() => {for (const owner of detailsOwners) owner.dispose(); sourceReplay.dispose();
    assert.deepEqual(native.boundaryErrors, [], 'No swallowed provider/native fixture assertion');});
  return {...native, context, runtime, providers, sourceReplay, reads, resolutions, nativeOwners, errors, ui, mountUI,
    setShell(patch) {shell = {...shell, ...patch};}, shell: () => shell,
    setBackend(value) {backend = value;}, backend: () => backend,
    counts(readCount, resolutionCount, hydrationCount, presentationCount) {
      assert.equal(reads.length, readCount, 'fresh Top reads'); assert.equal(resolutions.length, resolutionCount, 'native target resolutions');
      assert.equal(native.hydrations.length, hydrationCount, 'native Album hydrations'); assert.equal(native.presentations.length, presentationCount, 'native presentations');
    },
  };
}
module.exports = {ROOT, read, load, script, plain, id, TOP, OTHER, ALBUM, ITEM, KEY, SCOPE, row, detail, origin, target, reply, deferred, atBoundary, installNative, fixture};
