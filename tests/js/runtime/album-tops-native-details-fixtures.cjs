// Narrow consumer fixture. The real native projector owns selection/origin shape;
// this fake stops at its callback boundary and never hydrates or opens a dialog.
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
const CONTEXT = 'a'.repeat(64), SCOPE = JSON.stringify(['1', '2', CONTEXT, 4]);
const KEY = 'Artist/Album \u{1f3b5}', OTHER_KEY = 'Artist/Other album';
const plain = value => JSON.parse(JSON.stringify(value));
const abort = () => Object.assign(new Error('Retired fake native request'), {name: 'AbortError'});
const isAbort = error => error?.name === 'AbortError';
const atBoundary = (entered, operation) => Promise.race([entered.promise, Promise.resolve(operation).then(() => {
  throw new Error('Expected pending provider boundary was not reached');
})]);
const localRow = (patch = {}) => ({item_ref: F.IA, album_ref: F.A, title: 'Local album', artist: 'Artist',
  year: 2001, original_position: 4, position: 1, native_album: {inventory_album_ref: 'inventory-album:2:11',
    artwork_url: '/library/album-artwork/inventory-album:2:11', allowed_actions: {can_view_details: true}}, ...patch});
const remoteRow = () => ({item_ref: F.IB, album_ref: F.B, title: 'Remote album', artist: 'Remote artist', year: null,
  original_position: 9, position: 2, source_kind: 'remote_summary', provider: 'musicbrainz',
  entity_kind: 'release-group', release_group_id: F.id(104), first_release_date: '2000-02-29',
  primary_type: 'Album', metadata_coverage: 'album_summary_only', track_metadata_status: 'unavailable', track_count: null});
const source = row => ({top_ref: F.TOP, revision: '7', item_ref: row.item_ref, album_ref: row.album_ref,
  inventory_album_ref: row.native_album.inventory_album_ref});
const origin = row => ({source: 'album_top', top_ref: F.TOP, item_ref: row.item_ref, revision: '7'});
const reply = (row, key = KEY) => ({...source(row), native_target: {album_ref: key,
  allowed_actions: {can_view_details: true, can_play_album: false}}});

function fixture(t, createDetails, native, {rows = [localRow()], resolve} = {}) {
  const detail = {top_ref: F.TOP, revision: '7', title: 'Curated Top', description: '', visibility: 'private',
    allowed_actions: {[F.BROWSE]: true, can_read: true}, items: rows, completion_summary: null};
  let state = {...F.state({editing: true, data: detail}), scopeKey: SCOPE};
  let shell = {authenticated: true, visible: true, scopeKey: SCOPE, topRef: F.TOP, viewVersion: 3, viewRequestId: 9};
  let owner, hooks, invalidations = 0, controllerHook = () => {}, snapshotHook = () => {}, afterPresentation = () => {};
  const calls = [], intents = [], presentations = [], errors = [], boundaryErrors = [], forbidden = [];
  const check = callback => {try {return callback();} catch (error) {boundaryErrors.push(error); throw error;}};
  const forbiddenCall = name => () => {forbidden.push(name); throw new Error('Unexpected direct ' + name);};
  const providers = {async resolveNativeAlbum(payload, options) {
    const row = rows.find(value => value.item_ref === payload.item_ref);
    const call = {payload, options, row}; calls.push(call);
    check(() => {
      assert.ok(row, 'Provider selects an actual member');
      assert.deepEqual(payload, source(row), 'Exact source payload; no hints or hydration key used as authority');
      assert.deepEqual(Object.keys(options).sort(), ['isCurrent', 'scopeKey', 'signal']);
      assert.equal(options.scopeKey, SCOPE); assert.ok(options.signal instanceof AbortSignal);
      assert.equal(typeof options.isCurrent, 'function'); assert.equal(options.isCurrent(), true);
      assert.equal(options.signal.aborted, false);
    });
    return resolve ? resolve(call, calls.length) : reply(row);
  }};
  owner = Object.freeze({scopeKey: SCOPE, detail, providers});
  const initialOwner = owner;
  const controller = {getSnapshot() {controllerHook(); return state;}};
  const runtime = {snapshot() {snapshotHook(); return shell;},
    playAlbum: forbiddenCall('playAlbum'), queueAlbum: forbiddenCall('queueAlbum'), openTrackModal: forbiddenCall('openTrackModal'),
    createResourceSelection(value) {
      check(() => {
        assert.equal(hooks, undefined, 'Exactly one native selection owner');
        assert.deepEqual(Object.keys(value).sort(), ['authorizeResource', 'revalidateResource', 'sourceResource']);
        for (const method of Object.values(value)) assert.equal(typeof method, 'function');
      });
      hooks = value;
      return {invalidateResourceSelections() {invalidations++;}, async resourceIntent(intent, raw, context) {
        const target = native.projectTarget(raw), request = {intent, raw, target, context}; intents.push(request);
        check(() => {
          assert.equal(intent, 'open'); assert.ok(target, 'Actual native projector accepts the consumer target');
          assert.deepEqual(plain(native.projectOrigin(context.origin)), origin(rows.find(row => row.album_ref === raw.ref)));
          assert.equal(context.scopeKey, SCOPE); assert.ok(context.signal instanceof AbortSignal);
          assert.deepEqual(Object.keys(context).sort(), ['origin', 'scopeKey', 'signal']);
          assert.equal(hooks.sourceResource(target, context), raw);
          assert.deepEqual(plain(target.native_actions.allowed_actions), {can_open_album: true, can_play_album: false});
        });
        if (context.signal.aborted || !hooks.sourceResource(target, context)) throw abort();
        // Mirrors hydrate(): authorization gets the original native signal.
        await hooks.authorizeResource(target, {...context, signal: context.signal}, intent);
        if (context.signal.aborted || !hooks.sourceResource(target, context)) throw abort();
        presentations.push(request);
        afterPresentation(request);
        // openTrackModal's undefined return is a valid native completion.
      }};
    }};
  const details = createDetails({runtime, controller, readOwner: () => owner, onError: error => errors.push(error)});
  t.after(() => {
    details.dispose();
    assert.deepEqual(forbidden, [], 'Consumer neither plays, queues, nor opens a native dialog directly');
    assert.equal(boundaryErrors.length, 0, boundaryErrors.map(error => error.message).join('; '));
  });
  return {details, runtime, controller, providers, initialOwner, detail, rows, calls, intents, presentations, errors,
    get hooks() {return hooks;}, get owner() {return owner;}, get invalidations() {return invalidations;},
    state: () => state, shell: () => shell,
    setState(value) {state = {...state, ...value};}, setShell(value) {shell = {...shell, ...value};},
    setOwner(value) {owner = value;}, replaceProvider() {owner = Object.freeze({...owner, providers: {...providers}});},
    onControllerRead(value) {controllerHook = value;}, onSnapshot(value) {snapshotHook = value;},
    onPresentation(value) {afterPresentation = value;},
    selection() {assert.equal(intents.length, 1); return intents[0];},
    authorize(signal) {
      const {target, context} = this.selection();
      return hooks.authorizeResource(target, {...context, signal: signal || context.signal}, 'open');
    },
    replay(signal) {
      const {target, context} = this.selection();
      // Mirrors replaySource(): old action signal is deliberately absent here.
      return hooks.revalidateResource(target, {...context, signal: undefined}, {signal});
    },
    counts(resolutions, selections, shown) {
      assert.equal(calls.length, resolutions, 'Exact provider call count');
      assert.equal(intents.length, selections, 'Exact native intent count');
      assert.equal(presentations.length, shown, 'Exact authorized presentation count');
    }};
}

module.exports = {F, SCOPE, KEY, OTHER_KEY, plain, isAbort, atBoundary, localRow, remoteRow, source, origin, reply, fixture};
