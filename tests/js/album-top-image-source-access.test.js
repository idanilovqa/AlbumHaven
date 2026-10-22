'use strict';
// Frozen before implementation. These tests exercise the candidate's actual
// manifest-loaded native bridge and fresh read owners, never a copied capture,
// receipt, watcher, source adapter or transport policy implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
const N = require(path.join(ROOT, 'tests/js/runtime/search-native-fixtures/actual-runtime.cjs'));
const F = require(path.join(ROOT, 'tests/js/runtime/album-tops-membership-fixtures/top-builder-fixtures.cjs'));
const P = require(path.join(ROOT, 'tests/js/runtime/album-preferences-native-fixture.cjs'));
const plain = N.plain, settle = N.drain, outcome = N.outcome;
const ACCESS_KEYS = ['capture', 'isCurrent', 'readOwnRatings', 'watchOwnRatings', 'releaseOwnRatings', 'sameOwnRatings', 'prepareCover', 'prepareBrand', 'dispose'];
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const errorCode = error => typeof error === 'string' ? error : error?.code;
const bounded = (...expected) => error => expected.includes(errorCode(error));
const item = (n = 11, patch = {}) => ({item_ref: F.id(100 + n), album_ref: F.id(n), title: `Album ${n}`, artist: `Artist ${n}`, year: 2001,
  position: n - 10, original_position: n * 2, native_album: {inventory_album_ref: `inventory-album:9:${n}`,
    artwork_url: `/library/album-artwork/inventory-album:9:${n}`, allowed_actions: {can_view_details: true}}, ...patch});
function deepFrozen(value) {
  assert.equal(Object.isFrozen(value), true);
  for (const member of Object.values(value)) if (member && typeof member === 'object') deepFrozen(member);
}
function fixture(t, {rows = [item()], onRetired = null, resolve = null} = {}) {
  const h = N.fixture(t), c = h.context;
  const host = h.document.createElement('section'); host.id = 'album-tops-root'; h.main.append(host);
  h.state.view = {...N.ordinary(), surface: {active: 'album_tops'}, surface_request: 'album_tops', top_ref: F.TOP};
  h.state.ui.pendingViewTransition = false;
  const runtime = c.AlbumHavenAlbumTopsRuntime; assert.ok(runtime, 'actual manifest-loaded AlbumTopsRuntime');
  runtime.sync(); const native = runtime.snapshot(); assert.equal(native.visible, true); assert.equal(native.authenticated, true);
  const detail = F.detail({items: rows, edit_draft: undefined});
  let value = {...F.state({editing: true, data: detail}), scopeKey: native.scopeKey};
  const listeners = new Set(), retirements = [], resolutions = [];
  const controller = {getSnapshot: () => value, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}};
  const providers = {resolveNativeAlbum(source, options) {
    resolutions.push({source, options});
    if (resolve) return resolve(source, options);
    return Promise.resolve({...source, native_target: {album_ref: `local-album-${source.inventory_album_ref.split(':').at(-1)}`,
      allowed_actions: {can_view_details: true, can_play_album: false}}});
  }};
  const bridge = runtime.imageExport; assert.ok(bridge, 'actual image-export bridge exists'); keys(bridge, ['coordinator', 'createAccess']); assert.equal(Object.isFrozen(bridge), true);
  const access = bridge.createAccess({controller, providers, attribution: 'Approved attribution', onRetired(capture, reason) {
    assert.equal(access.isCurrent(capture), false, 'retirement committed before notification');
    retirements.push({capture, reason}); onRetired?.(capture, reason);
  }});
  t.after(() => access.dispose());
  const replace = patch => {value = {...value, ...patch}; for (const callback of [...listeners]) callback();};
  return {...h, c, runtime, bridge, access, controller, providers, detail, rows, retirements, resolutions, listeners, replace,
    snapshot: () => value, capture: (sourceKey = 'image-capture-1') => access.capture({sourceKey})};
}
async function answerRatings(h, work, values = h.rows.map(() => null)) {
  for (let i = 0; i < h.rows.length; i++) {
    await settle(); const requests = h.requests.filter(r => r.url.startsWith('/album-details?'));
    assert.equal(requests.length, i + 1, 'fresh reads are strictly sequential');
    const request = requests[i]; assert.equal(request.settled, false);
    const id = Number(h.rows[i].native_album.inventory_album_ref.split(':').at(-1));
    request.resolve(P.detail(P.album({key: `local-album-${id}`, album_id: id,
      album_preference: P.preference({album_ref: `inventory-album:9:${id}`, rating: values[i], preference_revision: values[i] === null ? 0 : 2})})));
  }
  return await work;
}
function resource(capture, row, patch = {}) {
  return Object.freeze({binding: capture.source.binding, kind: row ? 'cover' : 'brand', itemRef: row?.item_ref ?? null,
    albumRef: row?.album_ref ?? null, maxEncodedBytes: 20971520, maxWidth: 2048, maxHeight: 2048,
    signal: new AbortController().signal, ...patch});
}
// IHDR/header witness only. Decoder validity and raster pixels are not claimed.
function header(width = 1, height = 1) {
  const bytes = Uint8Array.from([137,80,78,71,13,10,26,10, 0,0,0,13, 73,72,68,82,
    0,0,0,0, 0,0,0,0, 8,6,0,0,0, 0,0,0,0]);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height);
  let crc = 0xffffffff; for (const byte of bytes.subarray(12, 29)) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
  view.setUint32(29, (crc ^ 0xffffffff) >>> 0); return bytes;
}
function binaryPlatform(h, {bytes = header(), status = 200, mime = 'image/png', redirected = false, hold = null, missingBody = false} = {}) {
  const calls = [], reads = [], cancels = [], releases = []; let serial = 0;
  const fetch = async (url, options = {}) => {
    calls.push({url: String(url), options}); let emitted = false;
    return {status, ok: status === 200, redirected, headers: new Headers({'Content-Type': mime}),
      blob() {assert.fail('unbounded response.blob is forbidden');},
      body: missingBody ? null : {getReader() {return {async read() {
        reads.push(++serial); if (hold) return await hold.promise;
        if (emitted) return {done: true}; emitted = true; return {done: false, value: bytes};
      }, cancel(reason) {cancels.push(reason); return Promise.resolve();}, releaseLock() {releases.push(true);}};}}};
  };
  h.c.fetch = fetch; h.c.Headers = Headers; h.c.Blob = Blob; h.c.Uint8Array = Uint8Array; h.c.DataView = DataView;
  h.c.TextDecoder = TextDecoder; h.c.TextEncoder = TextEncoder;
  // ES modules use host globals; classic owners use the VM window. Only browser
  // primitives are replaced, never any feature/native policy function.
  const old = Object.getOwnPropertyDescriptor(globalThis, 'fetch'); Object.defineProperty(globalThis, 'fetch', {configurable: true, writable: true, value: fetch});
  h.restoreBinary = () => {if (old) Object.defineProperty(globalThis, 'fetch', old); else delete globalThis.fetch;};
  return {calls, reads, cancels, releases};
}

test('native bridge has one frozen exact access API and capture exposes only the full ordered display projection', t => {
  const rows = Array.from({length: 37}, (_, i) => item(i + 11)), h = fixture(t, {rows});
  for (const row of rows) for (const key of ['rating', 'album_preference', 'tracks', 'path', 'is_favorite', 'progress']) {
    Object.defineProperty(row, key, {enumerable: true, get() {assert.fail(`private ${key} inspected while opt-out`);}});
  }
  keys(h.access, ACCESS_KEYS);
  const capture = h.capture(); assert.ok(capture); keys(capture, ['source']); assert.equal(Object.isFrozen(capture), true);
  keys(capture.source, ['binding', 'complete', 'total', 'title', 'description', 'attribution', 'items']);
  keys(capture.source.binding, ['scopeKey', 'topRef', 'revision', 'sourceKey']);
  assert.deepEqual(plain(capture.source.binding), {scopeKey: h.runtime.snapshot().scopeKey, topRef: F.TOP, revision: '7', sourceKey: 'image-capture-1'});
  assert.equal(capture.source.complete, true); assert.equal(capture.source.total, 37); assert.equal(capture.source.attribution, 'Approved attribution');
  assert.deepEqual(plain(capture.source.items), rows.map(({item_ref, album_ref, title, artist, year}) => ({item_ref, album_ref, title, artist, year})));
  assert.equal(h.access.isCurrent(capture), true); assert.equal(h.resolutions.length, 0); assert.equal(h.requests.length, 0, 'capture/default opt-out does zero IO');
  assert.equal(h.access.isCurrent({...capture}), false); assert.equal(h.access.isCurrent(Object.freeze({source: capture.source})), false);
});

test('runtime coordinator survives owner callers and closing barriers without evaluating replacement factories', t => {
  const h = fixture(t), barrier = N.deferred(); let factories = 0, disposed = 0;
  const owner = Object.freeze({open() {}, read: () => Object.freeze({phase: 'closing'}), dispose() {disposed++; return barrier.promise;}});
  assert.equal(h.bridge.coordinator(() => {factories++; return owner;}), owner);
  assert.equal(h.bridge.coordinator(() => {assert.fail('replacement factory ran');}), owner);
  owner.dispose(); h.access.dispose();
  const other = h.bridge.createAccess({controller: h.controller, providers: h.providers, attribution: 'Approved attribution', onRetired() {}});
  assert.equal(h.bridge.coordinator(() => {assert.fail('view remount replaced coordinator');}), owner);
  assert.equal(factories, 1); assert.equal(disposed, 1); other.dispose(); barrier.resolve();
});

test('failed coordinator factory is not recursively retried or replaced', t => {
  const h = fixture(t); let attempts = 0;
  try {h.bridge.coordinator(() => {attempts++; throw new Error('private factory detail');});} catch (error) {assert.ok(bounded('unavailable')(error));}
  try {h.bridge.coordinator(() => {attempts++; throw new Error('must not run');});} catch (error) {assert.ok(bounded('unavailable')(error));}
  assert.equal(attempts, 1);
});

for (const missing of ['controller', 'providers', 'attribution', 'onRetired']) test(`malformed createAccess rejects ${missing} before subscription`, t => {
  const h = fixture(t), count = h.listeners.size;
  const args = {controller: h.controller, providers: h.providers, attribution: 'Approved attribution', onRetired() {}}; delete args[missing];
  assert.throws(() => h.bridge.createAccess(args), bounded('unavailable')); assert.equal(h.listeners.size, count);
});

const sourceChanges = {
  actor: h => h.change('actor'), library: h => h.change('library'), context: h => h.change('context'),
  generation: h => h.c.AlbumHavenPrivateUITransport.invalidate(),
  transportIdentity: h => {h.c.AlbumHavenPrivateUITransport = Object.freeze({context: () => N.A, generation: () => 0}); h.runtime.sync();},
  hidden: h => {h.shell.hidden = true; h.runtime.sync();},
  view: h => {h.state.view = {...h.state.view}; h.runtime.sync();},
  viewRequest: h => {h.state.ui.activeViewRequestId++; h.runtime.sync();},
  selectedTop: h => h.replace({selectedTopRef: F.OTHER}),
  detailIdentity: h => h.replace({detail: {...h.snapshot().detail, data: {...h.detail}}}),
  detailRevision: h => {h.detail.revision = '8'; h.replace({});},
  memberIdentity: h => {h.detail.items[0] = {...h.detail.items[0]}; h.replace({});},
  memberMapping: h => {h.rows[0].native_album = {...h.rows[0].native_album, inventory_album_ref: 'inventory-album:9:99'}; h.replace({});},
  permission: h => {h.detail.allowed_actions.can_read = false; h.replace({});},
  detailRefresh: h => h.replace({detail: {...h.snapshot().detail, refreshing: true}}),
  mutation: h => h.replace({mutation: {status: 'loading'}}),
  mutationUncertain: h => h.replace({mutation: {status: 'uncertain'}}),
  mutationRefresh: h => h.replace({mutation: {status: 'ready', refreshing: true}}),
  denied: h => h.replace({directory: {status: 'denied', data: null}}),
  unavailable: h => h.replace({detail: {status: 'unavailable', data: null}}),
  dispose: h => h.access.dispose(),
};
for (const [name, change] of Object.entries(sourceChanges)) test(`capture irrevocably retires on actual ${name} change`, async t => {
  const h = fixture(t), capture = h.capture(); assert.ok(capture); change(h); await settle();
  assert.equal(h.access.isCurrent(capture), false); assert.equal(h.access.isCurrent(capture), false);
  assert.ok(h.retirements.length <= 1); assert.ok(h.retirements.every(x => x.capture === capture && x.reason === 'source_retired'));
  assert.equal(h.resolutions.length, 0); assert.equal(h.requests.length, 0);
});

test('same-value actor and source return cannot revive retired captures or fire duplicate notification', async t => {
  const h = fixture(t), capture = h.capture(), original = h.snapshot();
  h.replace({detail: {...original.detail, data: {...h.detail}}}); assert.equal(h.access.isCurrent(capture), false);
  h.replace(original); assert.equal(h.access.isCurrent(capture), false); assert.equal(h.retirements.length, 1);
  const next = h.capture('image-capture-2'); assert.ok(next); assert.notEqual(next, capture); assert.equal(h.access.isCurrent(next), true);
  const actor = h.shell.dataset.nativeAccountId; h.change('actor'); await settle(); h.change('actor', actor); await settle();
  assert.equal(h.access.isCurrent(next), false); assert.equal(h.retirements.filter(row => row.capture === next).length, 1);
});

test('retirement observer throw cannot revive another capture or skip subscription cleanup', t => {
  const h = fixture(t, {onRetired() {throw new Error('observer');}}), a = h.capture('capture-a'), b = h.capture('capture-b');
  try {h.replace({detail: {status: 'denied', data: null}});} catch (error) {assert.fail(`observer escaped source retirement: ${error}`);}
  assert.equal(h.access.isCurrent(a), false); assert.equal(h.access.isCurrent(b), false);
  h.access.dispose(); h.access.dispose(); assert.equal(h.listeners.size, 0);
});

for (const shape of ['over-limit', 'sparse', 'duplicate-member', 'foreign-inventory', 'foreign-artwork', 'incomplete']) test(`capture refuses ${shape} without resource IO`, t => {
  let rows = [item()];
  if (shape === 'over-limit') rows = Array.from({length: 5001}, (_, i) => item(i + 11));
  if (shape === 'sparse') rows = new Array(1);
  if (shape === 'duplicate-member') rows.push({...rows[0]});
  if (shape === 'foreign-inventory') rows[0].native_album.inventory_album_ref = 'inventory-album:99:11';
  if (shape === 'foreign-artwork') rows[0].native_album.artwork_url = 'https://foreign.test/cover';
  const h = fixture(t, {rows}); if (shape === 'incomplete') h.detail.next_cursor = 'more-members';
  assert.equal(h.capture(), null); assert.equal(h.requests.length, 0); assert.equal(h.resolutions.length, 0);
});

test('fresh opted-in projection uses exact native source then admitted own preference, never path/hydrated cache', async t => {
  const h = fixture(t, {rows: [item(11), item(12), item(13)]}), capture = h.capture();
  const result = await answerRatings(h, h.access.readOwnRatings(capture, {signal: new AbortController().signal}), [null, 1, 10]);
  deepFrozen(result); keys(result, ['binding', 'items']); assert.deepEqual(plain(result.binding), plain(capture.source.binding));
  assert.deepEqual(plain(result.items), h.rows.map((row, i) => ({item_ref: row.item_ref, rating: [null, 1, 10][i]})));
  assert.equal(h.resolutions.length, 3);
  for (let i = 0; i < h.resolutions.length; i++) {
    const {source, options} = h.resolutions[i], row = h.rows[i];
    assert.deepEqual(plain(source), {top_ref: F.TOP, revision: '7', item_ref: row.item_ref, album_ref: row.album_ref, inventory_album_ref: row.native_album.inventory_album_ref});
    keys(options, ['scopeKey', 'signal', 'isCurrent']); assert.equal(options.scopeKey, capture.source.binding.scopeKey); assert.equal(options.isCurrent(), true);
    const request = h.requests[i]; assert.equal(new URL(request.url, h.location).searchParams.get('album_key'), `local-album-${i + 11}`);
  }
  const unsubscribe = h.access.watchOwnRatings(capture, result, () => assert.fail('equal admitted baseline changed'));
  assert.equal(typeof unsubscribe, 'function'); unsubscribe(); unsubscribe(); h.access.releaseOwnRatings(result); h.access.releaseOwnRatings(result);
});

test('an earlier accumulated observation changes while a later member read waits: batch retires before projection', async t => {
  const h = fixture(t, {rows: [item(11), item(12)]}), capture = h.capture();
  const work = outcome(h.access.readOwnRatings(capture, {signal: new AbortController().signal})); await settle();
  h.requests[0].resolve(P.detail(P.album({album_preference: P.preference({rating: 3, preference_revision: 1})}))); await settle();
  assert.equal(h.requests.length, 2, 'second member now pending');
  const native = h.c.fetchTrackModalAlbumDetails('local-album-11'); await settle();
  h.requests[2].resolve(P.detail(P.album({album_preference: P.preference({rating: 7, preference_revision: 2})}))); await native;
  assert.equal(h.access.isCurrent(capture), false, 'native observation invalidates capture before batch can finish');
  h.requests[1].resolve(P.detail(P.album({key: 'local-album-12', album_id: 12, album_preference: P.preference({album_ref: 'inventory-album:9:12'})})));
  const result = await work; assert.ok(result.error); assert.equal(result.value, undefined); assert.equal(h.retirements.length, 1);
  assert.equal(h.retirements[0].reason, 'own_ratings_unavailable');
});

for (const failure of ['unavailable', 'foreign', 'missing', 'wrong-key', 'read-only', 'unreadable', 'mutated-receipt']) test(`whole own-rating batch rejects ${failure} instead of rendering omitted or unproven rating`, async t => {
  const h = fixture(t), capture = h.capture(), work = outcome(h.access.readOwnRatings(capture, {signal: new AbortController().signal})); await settle();
  const album = P.album({album_preference: P.preference({rating: 5})});
  if (failure === 'unavailable') album.album_preference = P.preference({album_ref: null, rating: null, is_favorite: null, favorite_override: null, favorite_source: null, taste_state: 'unavailable', preference_revision: null, can_edit: false, allowed_actions: {can_manage_album_preferences: false}});
  if (failure === 'foreign') album.album_preference.album_ref = 'inventory-album:99:11';
  if (failure === 'missing') delete album.album_preference;
  if (failure === 'wrong-key') album.key = 'other-album';
  if (failure === 'read-only') album.read_only_subject = true;
  if (failure === 'unreadable') album.allowed_actions.can_read = false;
  if (failure === 'mutated-receipt') {
    // The original fetch owner resolves first, then an earlier continuation
    // mutates its DTO before the bridge continuation may project it.
    const fetchOwner = h.c.fetchTrackModalAlbumDetails;
    // This case requires mutation at onAdmitted, not replacing fetch ownership.
    // Observe the genuine helper transparently and delegate every invocation.
    const admit = h.c.admitRuntimeAlbumPreferenceRead;
    h.c.admitRuntimeAlbumPreferenceRead = function(payload, scope, request) {
      const lease = admit.call(this, payload, scope, request); if (request) payload.album_preference.rating = 9; return lease;
    };
    t.after(() => {h.c.fetchTrackModalAlbumDetails = fetchOwner; h.c.admitRuntimeAlbumPreferenceRead = admit;});
  }
  h.requests[0].resolve(P.detail(album)); const result = await work; assert.ok(result.error); assert.equal(result.value, undefined);
  assert.ok(bounded('own_ratings_unavailable', 'source_retired')(result.error));
});

test('sameOwnRatings requires genuine unreleased results and private preference revision equality', async t => {
  const h = fixture(t), capture = h.capture(), a = await answerRatings(h, h.access.readOwnRatings(capture, {signal: new AbortController().signal}), [5]);
  const second = h.access.readOwnRatings(capture, {signal: new AbortController().signal}); await settle();
  h.requests[1].resolve(P.detail(P.album({album_preference: P.preference({rating: 5, preference_revision: 2})}))); const b = await second;
  assert.equal(h.access.sameOwnRatings(a, b), true); assert.equal(h.access.sameOwnRatings(a, {...b}), false);
  assert.equal(h.access.sameOwnRatings({...a}, b), false); assert.equal(h.access.sameOwnRatings(null, b), false);
  const poison = {}; Object.defineProperty(poison, 'items', {get() {assert.fail('foreign getters inspected');}});
  assert.equal(h.access.sameOwnRatings(a, poison), false);
  h.access.releaseOwnRatings(b); assert.equal(h.access.sameOwnRatings(a, b), false);
  let changes = 0; const unsubscribe = h.access.watchOwnRatings(capture, a, () => {changes++; assert.equal(h.access.isCurrent(capture), false);});
  const native = h.c.fetchTrackModalAlbumDetails('local-album-11'); await settle(); h.requests[2].resolve(P.detail(P.album({album_preference: P.preference({rating: 5, preference_revision: 3})}))); await native;
  assert.equal(changes, 1, 'same numeric rating with new proven revision still invalidates'); unsubscribe(); unsubscribe();
});

test('adoption retains admission-time guard without an unsubscribe/resubscribe gap; releasing watch is final', async t => {
  const h = fixture(t), capture = h.capture(), result = await answerRatings(h, h.access.readOwnRatings(capture, {signal: new AbortController().signal}), [4]);
  let changed = 0; const unsubscribe = h.access.watchOwnRatings(capture, result, () => {changed++;});
  const native = h.c.fetchTrackModalAlbumDetails('local-album-11'); await settle(); h.requests[1].resolve(P.detail(P.album({album_preference: P.preference({rating: 6, preference_revision: 3})}))); await native;
  assert.equal(changed, 1); assert.equal(h.access.sameOwnRatings(result, result), false);
  unsubscribe(); h.access.releaseOwnRatings(result); h.access.dispose(); h.access.releaseOwnRatings(result);
  assert.equal(h.listeners.size, 0);
});

for (const phase of ['resolve', 'read']) test(`disposing during ${phase} consumes stale outcome and does not project, notify or start later member`, async t => {
  const gate = N.deferred(), h = fixture(t, {rows: [item(11), item(12)], resolve: phase === 'resolve' ? () => gate.promise : null});
  const capture = h.capture(), work = outcome(h.access.readOwnRatings(capture, {signal: new AbortController().signal})); await settle(); h.access.dispose();
  if (phase === 'resolve') gate.resolve({top_ref: F.TOP, revision: '7', item_ref: h.rows[0].item_ref, album_ref: h.rows[0].album_ref,
    inventory_album_ref: 'inventory-album:9:11', native_target: {album_ref: 'local-album-11', allowed_actions: {can_view_details: true, can_play_album: false}}});
  else h.requests[0].resolve(P.detail(P.album()));
  const result = await work; assert.ok(result.error); assert.equal(result.value, undefined); assert.equal(h.resolutions.length, 1);
  assert.equal(h.requests.length, phase === 'read' ? 1 : 0); assert.equal(h.listeners.size, 0);
});

for (const bad of ['item', 'album', 'binding', 'kind', 'cap', 'brand-member']) test(`cover/brand resource preparation rejects substituted ${bad} before fetch`, async t => {
  const h = fixture(t), capture = h.capture(), patch = {};
  if (bad === 'item') patch.itemRef = F.OTHER;
  if (bad === 'album') patch.albumRef = F.OTHER;
  if (bad === 'binding') patch.binding = {...capture.source.binding, sourceKey: 'foreign'};
  if (bad === 'kind') patch.kind = 'other';
  if (bad === 'cap') patch.maxEncodedBytes = 20971521;
  if (bad === 'brand-member') {patch.kind = 'brand'; patch.itemRef = h.rows[0].item_ref;}
  const request = resource(capture, h.rows[0], patch), work = bad === 'brand-member' ? h.access.prepareBrand(capture, request) : h.access.prepareCover(capture, request);
  assert.ok(work && typeof work.then === 'function'); await assert.rejects(work, bounded('resource_unavailable', 'source_retired', 'unavailable'));
  assert.equal(h.requests.length, 0);
});

test('actual cover preparation uses only captured inventory route, context, immutable PNG and exact dimensions', async t => {
  const h = fixture(t), capture = h.capture(), p = binaryPlatform(h, {bytes: header(32, 17)}); t.after(h.restoreBinary);
  const prepared = await h.access.prepareCover(capture, resource(capture, h.rows[0]));
  keys(prepared, ['blob', 'width', 'height', 'release']); assert.equal(prepared.blob.type, 'image/png'); assert.equal(prepared.width, 32); assert.equal(prepared.height, 17);
  assert.equal(p.calls.length, 1); const call = p.calls[0], url = new URL(call.url, h.location);
  assert.equal(url.origin, h.location.origin); assert.equal(url.pathname, '/library/album-artwork/inventory-album:9:11'); assert.equal(url.search, '');
  const headers = new Headers(call.options.headers); assert.equal(headers.get('Accept'), 'image/png'); assert.equal(headers.get('X-AlbumHaven-Context'), N.A);
  assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.redirect, 'error');
  prepared.release(); prepared.release(); assert.equal(p.releases.length, 1);
});

test('actual brand preparation has one exact fixed route, no private context header and no cover capability', async t => {
  const h = fixture(t), capture = h.capture(), p = binaryPlatform(h, {bytes: header(245, 230)}); t.after(h.restoreBinary);
  const prepared = await h.access.prepareBrand(capture, resource(capture, null));
  assert.equal(prepared.width, 245); assert.equal(prepared.height, 230); assert.equal(p.calls.length, 1);
  const call = p.calls[0], url = new URL(call.url, h.location); assert.equal(url.origin, h.location.origin);
  assert.equal(url.pathname, '/static/images/album-haven-cloud-vinyl.png'); assert.equal(url.search, '');
  assert.equal(new Headers(call.options.headers).get('X-AlbumHaven-Context'), null); assert.equal(new Headers(call.options.headers).get('Accept'), 'image/png');
  assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.redirect, 'error'); prepared.release();
});

for (const failure of ['missing-body', 'wrong-mime', 'redirect', 'bad-header', 'oversize-dimension', 'denial']) test(`brand ${failure} is explicit unavailability without revoking native transport`, async t => {
  const h = fixture(t), capture = h.capture(), generation = h.c.AlbumHavenPrivateUITransport.generation();
  const config = failure === 'missing-body' ? {missingBody: true} : failure === 'wrong-mime' ? {mime: 'text/html'} : failure === 'redirect' ? {redirected: true}
    : failure === 'bad-header' ? {bytes: new Uint8Array([1,2,3])} : failure === 'oversize-dimension' ? {bytes: header(2049, 1)} : {status: 403};
  const p = binaryPlatform(h, config); t.after(h.restoreBinary);
  await assert.rejects(h.access.prepareBrand(capture, resource(capture, null)), bounded('resource_unavailable', 'invalid_png', 'unavailable'));
  assert.equal(h.c.AlbumHavenPrivateUITransport.generation(), generation); assert.equal(h.c.AlbumHavenPrivateUITransport.context(), N.A);
  assert.equal(p.calls.length, 1, 'no logo retry or fallback route');
});

for (const sourceKey of ['', '\u0000', 'x'.repeat(4097), null, 1]) test(`capture rejects malformed opaque source key ${JSON.stringify(sourceKey).slice(0, 40)}`, t => {
  const h = fixture(t); assert.equal(h.capture(sourceKey), null); assert.equal(h.requests.length, 0);
});

test('copied captures and copied rating results cannot mint source or taste authority', async t => {
  const h = fixture(t), capture = h.capture();
  await assert.rejects(h.access.readOwnRatings({...capture}, {signal: new AbortController().signal}), bounded('source_retired', 'own_ratings_unavailable'));
  assert.equal(h.requests.length, 0); assert.equal(h.resolutions.length, 0);
  const ratings = await answerRatings(h, h.access.readOwnRatings(capture, {signal: new AbortController().signal}), [6]);
  assert.throws(() => h.access.watchOwnRatings(capture, {...ratings}, () => {}), bounded('own_ratings_unavailable'));
  const another = h.bridge.createAccess({controller: h.controller, providers: h.providers, attribution: 'Approved attribution', onRetired() {}});
  assert.equal(another.isCurrent(capture), false); assert.equal(another.sameOwnRatings(ratings, ratings), false);
  another.releaseOwnRatings(ratings); assert.equal(h.access.sameOwnRatings(ratings, ratings), true, 'foreign release cannot alter owning receipt');
  another.dispose(); h.access.releaseOwnRatings(ratings);
});

test('input URL fields cannot redirect a captured cover or fixed symbol request', async t => {
  const h = fixture(t), capture = h.capture(), p = binaryPlatform(h, {bytes: header(245, 230)}); t.after(h.restoreBinary);
  // Rejection or ignored extra fields are both safe. They can never become a
  // request destination, and neither response can expose a private URL field.
  for (const brand of [false, true]) {
    const request = resource(capture, brand ? null : h.rows[0], {url: 'https://foreign.test/private', path: '/cover?path=private'});
    const result = await outcome(brand ? h.access.prepareBrand(capture, request) : h.access.prepareCover(capture, request));
    if (result.value) {keys(result.value, ['blob', 'width', 'height', 'release']); result.value.release();}
    else assert.ok(bounded('resource_unavailable', 'unavailable')(result.error));
  }
  assert.ok(p.calls.every(call => ['/library/album-artwork/inventory-album:9:11', '/static/images/album-haven-cloud-vinyl.png'].includes(new URL(call.url, h.location).pathname)));
  assert.ok(p.calls.every(call => new URL(call.url, h.location).origin === h.location.origin));
});

test('complete 5000-member capture stays complete without promising that it fits raster capacity', t => {
  const h = fixture(t, {rows: Array.from({length: 5000}, (_, i) => item(i + 11))}), capture = h.capture();
  assert.ok(capture); assert.equal(capture.source.total, 5000); assert.equal(capture.source.items.length, 5000);
  assert.equal(capture.source.items[4999].item_ref, h.rows[4999].item_ref);
  assert.equal(h.requests.length, 0); assert.equal(h.resolutions.length, 0);
});

test('actual cover resource_unavailable survives native transport/access mapping as that bounded category', async t => {
  const h = fixture(t), capture = h.capture(), p = binaryPlatform(h, {status: 503, mime: 'application/json',
    bytes: new TextEncoder().encode(JSON.stringify({error_code: 'resource_unavailable', detail: 'PRIVATE_PATH /secret'}))});
  t.after(h.restoreBinary);
  await assert.rejects(h.access.prepareCover(capture, resource(capture, h.rows[0])), bounded('resource_unavailable'));
  assert.equal(p.calls.length, 1, 'resource failure is not retried');
  assert.equal(h.c.AlbumHavenPrivateUITransport.context(), N.A, 'resource unavailability is not authentication denial');
});
