'use strict';
// R3 additive, synthetic source-owner acceptance tests. Authored as text only.
// Run only in a separately authorized candidate closure with ALBUM_TOP_TEST_ROOT.
// The native fixture loads complete candidate runtime owners from its manifest.
// The binary fixture evaluates the complete candidate transport file, not a
// copied implementation. Only browser/network primitives and wire DTOs are fake.
// These assertions are not browser, decoder, raster, delivery or heap evidence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
const native = require(path.join(ROOT, 'tests/js/runtime/album-preferences-native-fixture.cjs'));
const {fixture, album, preference, detail, envelope, plain, drain, deferred, A, B} = native;
const REF = 'inventory-album:9:11';
const MAX_PNG = 20971520;
const MAX_ERROR = 65536;
const outcome = promise => Promise.resolve(promise).then(value => ({value}), error => ({error}));
// R3 fixes bounded categories, not an Error-versus-string representation.
const errorCode = error => typeof error === 'string' ? error : error?.code;
const isOwnUnavailable = error => errorCode(error) === 'own_ratings_unavailable';
const isRetired = error => error?.name === 'AbortError'
  || ['source_retired', 'own_ratings_unavailable'].includes(errorCode(error));
const own = (rating = 4, revision = 1, patch = {}) => preference({rating, preference_revision: revision, ...patch});
const unavailable = () => preference({album_ref: null, rating: null, is_favorite: null,
  favorite_override: null, favorite_source: null, taste_state: 'unavailable', preference_revision: null,
  can_edit: false, allowed_actions: {can_manage_album_preferences: false}});
const frozenKeys = (value, keys) => {
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
};

function beginRead(h, dto, {observed = true, options = {}, onAdmitted, onChange} = {}) {
  const record = {dto, lease: null, admissions: 0, changes: 0, settled: false};
  const before = h.requests.length;
  const observation = {
    inventoryAlbumRef: REF,
    onAdmitted(lease) {
      record.admissions++;
      record.lease = lease;
      assert.equal(record.settled, false, 'guard is delivered before the native read Promise settles');
      onAdmitted?.(lease, record);
    },
    onChange() {record.changes++; onChange?.(record);},
  };
  record.promise = h.c.fetchTrackModalAlbumDetails(dto.key,
    {...(observed ? {ownPreferenceObservation: observation} : {}), ...options});
  assert.equal(typeof record.promise?.then, 'function', 'the existing read returns an actual asynchronous result');
  record.result = outcome(record.promise).then(result => {record.settled = true; return result;});
  record.request = h.requests.slice(before).find(request => request.url.startsWith('/album-details?'));
  record.respond = (payload = detail(dto), status = 200) => {
    if (record.request && !record.request.settled) record.request.resolve(payload, status);
  };
  return record;
}

async function admitted(h, dto = album({album_preference: own()}), options = {}) {
  const read = beginRead(h, dto, options);
  read.respond();
  const result = await read.result;
  assert.equal(result.error, undefined, result.error?.stack);
  assert.equal(result.value, dto, 'successful fresh read returns the exact original album DTO');
  assert.equal(read.admissions, 1);
  frozenKeys(read.lease, ['read', 'release']);
  const snapshot = read.lease.read();
  frozenKeys(snapshot, ['albumRef', 'rating', 'preferenceRevision', 'tasteState']);
  assert.deepEqual(plain(snapshot), {albumRef: REF, rating: dto.album_preference.rating,
    preferenceRevision: dto.album_preference.preference_revision, tasteState: 'available'});
  return read;
}

async function ordinaryRead(h, dto) {
  const read = beginRead(h, dto, {observed: false});
  read.respond();
  const result = await read.result;
  assert.equal(result.error, undefined, result.error?.stack);
  assert.equal(result.value, dto);
  return dto;
}

test('R3 uses complete native owners and atomically supplies an exact frozen primitive-only lease', async t => {
  const h = fixture(t);
  for (const name of ['response-state-helpers.js', 'track-modal-lightbox-helpers.js',
    'tag-editor-and-optimistic-updates.js', 'private-ui-transport.js'])
    assert.ok(h.loaded.some(file => file.endsWith('/' + name)), name);
  assert.equal(typeof h.c.observeRuntimeAlbumPreferenceChanges, 'function');
  const dto = album({album_preference: own(null, 0)}), scope = h.c.captureRuntimeAlbumPreferenceScope();
  assert.equal(h.c.runtimeAlbumPreferenceForAlbum(dto, scope), null, 'unread DTO is not a genuine receipt');
  const realAdmission = h.c.admitRuntimeAlbumPreferenceRead;
  let inAdmission = false, seamCalls = 0;
  h.c.admitRuntimeAlbumPreferenceRead = function(payload, captured, request) {
    seamCalls++;
    assert.equal(payload, dto);
    assert.deepEqual(Object.keys(request).sort(), ['inventoryAlbumRef', 'isCurrent', 'onAdmitted', 'onChange']);
    assert.equal(request.inventoryAlbumRef, REF);
    assert.equal(request.isCurrent(), true);
    assert.equal(h.c.runtimeAlbumPreferenceScopeIsCurrent(captured), true);
    inAdmission = true;
    try {return realAdmission.call(this, payload, captured, request);} finally {inAdmission = false;}
  };
  t.after(() => {h.c.admitRuntimeAlbumPreferenceRead = realAdmission;});
  const read = await admitted(h, dto, {onAdmitted(lease) {
    assert.equal(inAdmission, true, 'onAdmitted occurs inside the real synchronous admission owner');
    assert.ok(h.c.runtimeAlbumPreferenceForAlbum(dto, scope), 'receipt exists before callback');
    assert.equal(lease.read().rating, null, 'proven unrated is available, not missing');
  }});
  assert.equal(seamCalls, 1);
  assert.equal(read.request.url, '/album-details?album_key=local-album-11');
  assert.equal(read.request.options.priority, 'high');
  assert.equal(new Headers(read.request.options.headers).get('Accept'), 'application/json');
  const saved = read.lease.read();
  read.lease.release(); read.lease.release();
  assert.equal(read.lease.read(), null);
  assert.deepEqual(plain(saved), {albumRef: REF, rating: null, preferenceRevision: 0, tasteState: 'available'});
});

test('absent observation preserves fresh caller return identity, default admission and exclusion options', async t => {
  for (const options of [{}, {speculative: true}, {readOnlySubject: true}, {admitPreferences: false}])
    await t.test(JSON.stringify(options), async t => {
      const h = fixture(t), dto = album({album_preference: own()});
      const before = plain(dto), read = beginRead(h, dto, {observed: false, options});
      read.respond();
      const result = await read.result;
      assert.equal(result.error, undefined, result.error?.stack);
      assert.equal(result.value, dto);
      assert.deepEqual(plain(dto), before, 'no observation fields are inserted into the DTO');
      assert.equal(read.admissions, 0);
      assert.equal(read.request.options.priority, options.speculative ? 'low' : 'high');
      assert.equal(Boolean(h.c.runtimeAlbumPreferenceForAlbum(dto)),
        options.readOnlySubject !== true && options.admitPreferences !== false);
    });
});

test('observed option rejects noncanonical identity, extra keys and invalid functions without admitting a guard', async t => {
  const invalid = [null, {}, {inventoryAlbumRef: REF},
    {inventoryAlbumRef: 'inventory-album:10:11', onAdmitted() {}, onChange() {}},
    {inventoryAlbumRef: 'inventory-album:09:11', onAdmitted() {}, onChange() {}},
    {inventoryAlbumRef: REF + '?x=1', onAdmitted() {}, onChange() {}},
    {inventoryAlbumRef: REF, onAdmitted: null, onChange() {}},
    {inventoryAlbumRef: REF, onAdmitted() {}, onChange: true},
    {inventoryAlbumRef: REF, async onAdmitted() {}, onChange() {}},
    {inventoryAlbumRef: REF, onAdmitted() {}, async onChange() {}},
    {inventoryAlbumRef: REF, onAdmitted() {}, onChange() {}, isCurrent: () => true},
  ];
  for (const option of invalid) await t.test(String(invalid.indexOf(option)), async t => {
    const h = fixture(t), read = beginRead(h, album(), {options: {ownPreferenceObservation: option}});
    read.respond();
    const result = await read.result;
    assert.ok(isOwnUnavailable(result.error), result.error?.stack);
    assert.equal(read.lease, null);
  });
  for (const option of [{readOnlySubject: true}, {admitPreferences: false}])
    await t.test(JSON.stringify(option), async t => {
      const h = fixture(t), read = beginRead(h, album(), {options: option});
      read.respond();
      assert.ok(isOwnUnavailable((await read.result).error));
      assert.equal(read.admissions, 0);
    });
});

test('observed reads fail closed on unavailable, unreadable, foreign, incomplete or duplicate native identity', async t => {
  const cases = [
    ['unavailable', () => album({album_preference: unavailable()})],
    ['read-only subject', () => album({read_only_subject: 'peer-ref'})],
    ['unreadable source', () => album({source_readable: false})],
    ['read forbidden', () => album({allowed_actions: {can_read: false}})],
    ['foreign preference', () => album({album_preference: own(4, 1, {context_ref: B})})],
    ['foreign library', () => album({library_id: 10})],
    ['mismatched album', () => album({album_id: 12})],
    ['missing preference', () => album({album_preference: undefined})],
    ['incomplete preference', () => album({album_preference: {rating: 4}})],
    ['duplicate canonical identity', () => album({duplicate_sources: [album()]})],
  ];
  for (const [name, make] of cases) await t.test(name, async t => {
    const h = fixture(t), read = beginRead(h, make());
    read.respond();
    const result = await read.result;
    assert.ok(isOwnUnavailable(result.error), result.error?.stack);
    assert.equal(read.admissions, 0);
    assert.equal(read.lease, null);
  });
  await t.test('missing current scope', async t => {
    const h = fixture(t); h.shell.dataset.nativeAccountId = '';
    const read = beginRead(h, album()); read.respond();
    assert.ok(isOwnUnavailable((await read.result).error));
    assert.equal(read.admissions, 0);
  });
});

test('fresh equal observations remain live; changed rating, revision or availability on another DTO retire once', async t => {
  for (const [name, next] of [['rating', own(5, 1)], ['revision', own(4, 2)], ['availability', unavailable()]])
    await t.test(name, async t => {
      const h = fixture(t), read = await admitted(h);
      await ordinaryRead(h, album({album_preference: own()}));
      assert.equal(read.changes, 0); assert.ok(read.lease.read());
      await ordinaryRead(h, album({album_id: 12, key: 'local-album-12', album_preference: own(9, 4, {album_ref: 'inventory-album:9:12'})}));
      assert.equal(read.changes, 0, 'another inventory album is not this observation');
      const other = album({album_preference: next});
      assert.notEqual(other, read.dto);
      await ordinaryRead(h, other);
      assert.equal(read.changes, 1);
      assert.equal(read.lease.read(), null);
      await ordinaryRead(h, album({album_preference: own()}));
      assert.equal(read.changes, 1, 'equal-value return cannot revive a retired subscription');
      assert.equal(read.lease.read(), null);
    });
});

test('bootstrap/subject copies and forged DTO signatures cannot stand in for native own-read authority', async t => {
  const h = fixture(t), read = await admitted(h), scope = h.c.captureRuntimeAlbumPreferenceScope();
  const copied = plain(read.dto);
  assert.equal(h.c.runtimeAlbumPreferenceForAlbum(copied, scope), null);
  h.c.compactRuntimeAlbumPayload(album({album_preference: own(8, 9)}));
  await ordinaryRead(h, album({read_only_subject: 'peer-ref', album_preference: own(8, 9)}));
  assert.equal(read.changes, 0); assert.ok(read.lease.read());
  read.dto.album_preference.rating = 8;
  assert.equal(h.c.runtimeAlbumPreferenceForAlbum(read.dto, scope), null, 'receipt signature binds the exact returned DTO');
  assert.equal(read.lease.read().rating, 4, 'the private baseline is a captured primitive, not a live DTO property');
  read.lease.release();
  await ordinaryRead(h, album({album_preference: own(6, 3)}));
  assert.equal(read.changes, 0, 'released observations do not receive later native reads');
});

test('a genuine second native read in the resolution microtask gap retires the already installed first guard', async t => {
  const h = fixture(t), laterDTO = album({album_preference: own(8, 2)}), events = [];
  const realAdmission = h.c.admitRuntimeAlbumPreferenceRead;
  let laterAdmissions = 0;
  h.c.admitRuntimeAlbumPreferenceRead = function(payload, ...args) {
    const result = realAdmission.call(this, payload, ...args);
    if (payload === laterDTO) {
      laterAdmissions++;
      assert.ok(h.c.runtimeAlbumPreferenceForAlbum(payload), 'witness the actual completed later admission');
      events.push('later-admitted');
    }
    return result;
  };
  t.after(() => {h.c.admitRuntimeAlbumPreferenceRead = realAdmission;});
  const later = beginRead(h, laterDTO, {observed: false});
  const heldJson = later.request.holdJson();
  // holdJson's response.json reads this exact deferred object's promise. Replace
  // only that network primitive before it is consumed, not the native fetch or
  // admission owner. The body Promise must belong to the awaiting owner's VM:
  // a host Promise introduces extra cross-realm assimilation jobs.
  Object.assign(heldJson, vm.runInContext(`(() => {
    let resolve, reject;
    const promise = new Promise((a, b) => {resolve = a; reject = b;});
    return {promise, resolve, reject};
  })()`, h.c));
  assert.equal(heldJson.promise.constructor, vm.runInContext('Promise', h.c));
  assert.notEqual(heldJson.promise.constructor, Promise, 'fixture must not silently use the host realm');
  await later.request.jsonStarted;
  assert.equal(laterAdmissions, 0); assert.equal(later.settled, false);
  const first = beginRead(h, album({album_preference: own()}), {onAdmitted(lease) {
    assert.ok(lease.read()); events.push('first-admitted');
    // This same-realm body completion queues the real second fetch owner's
    // continuation before consumers of the about-to-resolve first Promise.
    heldJson.resolve(detail(laterDTO));
  }, onChange() {events.push('first-retired');}});
  const projectionBoundary = first.promise.then(dto => {
    events.push('consumer-continuation');
    assert.equal(dto, first.dto);
    assert.equal(first.admissions, 1, 'the first guard was installed before its consumer await');
    assert.equal(laterAdmissions, 1, 'actual later admission precedes the consumer freshness assertion');
    assert.equal(first.lease.read(), null, 'no post-await subscription gap exists');
    assert.ok(h.c.runtimeAlbumPreferenceForAlbum(dto), 'old genuine DTO receipt alone cannot detect another object');
  });
  first.respond();
  assert.equal((await first.result).error, undefined);
  assert.equal((await later.result).error, undefined);
  await projectionBoundary;
  assert.deepEqual(events, ['first-admitted', 'first-retired', 'later-admitted', 'consumer-continuation']);
  assert.equal(laterAdmissions, 1); assert.equal(first.changes, 1);
});

test('old watcher callback cannot revive itself or leave a newly changed observation admitted', async t => {
  const h = fixture(t), scope = h.c.captureRuntimeAlbumPreferenceScope();
  let old;
  old = await admitted(h, album({album_preference: own()}), {onChange() {
    assert.equal(old.lease.read(), null, 'retirement commits before old observer reentry');
    // Invoke the actual synchronous mutation-cache owner to place deterministic
    // callback reentry. Full acknowledged POST dispatch is separately covered.
    h.c.refreshOwnAlbumPreferenceCaches(old.dto, own(9, 3), scope, () => true);
    old.lease.release(); old.lease.release();
  }});
  const next = beginRead(h, album({album_preference: own(6, 2)}));
  next.respond();
  const result = await next.result;
  assert.ok(isOwnUnavailable(result.error), result.error?.stack);
  assert.equal(next.admissions, 0, 'new guard is installed before old callbacks and rejected after reentry');
  assert.equal(old.changes, 1);
  assert.equal(old.lease.read(), null);
});

test('all changed watchers retire before notification and one throwing observer cannot skip others', async t => {
  const h = fixture(t); let first, second, sawSecondRetired = false;
  first = await admitted(h, album({album_preference: own()}), {onChange() {
    assert.equal(first.lease.read(), null);
    sawSecondRetired = second.lease.read() === null;
    throw new Error('synthetic subscriber failure');
  }});
  second = await admitted(h);
  await ordinaryRead(h, album({album_preference: own(7, 2)}));
  assert.equal(sawSecondRetired, true);
  assert.equal(first.changes, 1); assert.equal(second.changes, 1);
  assert.equal(first.lease.read(), null); assert.equal(second.lease.read(), null);
});

test('onAdmitted throw, release, abort, supersession, scope retirement and DTO mutation clean provisional guards', async t => {
  for (const mode of ['throw', 'release', 'abort', 'supersede', 'scope', 'signature'])
    await t.test(mode, async t => {
      const h = fixture(t), controller = new AbortController(); let current = true, delivered;
      const dto = album({album_preference: own()});
      const read = beginRead(h, dto, {options: {signal: controller.signal, isCurrent: () => current},
        onAdmitted(lease) {
          delivered = lease;
          if (mode === 'throw') throw new Error('callback detail must not become UI');
          if (mode === 'release') lease.release();
          if (mode === 'abort') controller.abort();
          if (mode === 'supersede') current = false;
          if (mode === 'scope') h.change('actor', '8');
          if (mode === 'signature') dto.album_preference.preference_revision = 99;
        }});
      read.respond();
      const result = await read.result;
      assert.ok(isRetired(result.error), result.error?.stack);
      assert.equal(read.admissions, 1); assert.ok(delivered);
      assert.equal(delivered.read(), null, 'failed return releases the provisional lease');
      delivered.release(); delivered.release();
      const priorChanges = read.changes;
      if (mode !== 'scope') await ordinaryRead(h, album({album_preference: own(10, 100)}));
      assert.equal(read.changes, priorChanges, 'released provisional subscription is not left in the live registry');
    });
});

test('final fetch-owner check after successful admission releases its provisional lease', async t => {
  const h = fixture(t); let delivered, ownerReturned = false;
  const realAdmission = h.c.admitRuntimeAlbumPreferenceRead;
  h.c.admitRuntimeAlbumPreferenceRead = function(...args) {
    const result = realAdmission.apply(this, args);
    ownerReturned = true;
    return result;
  };
  t.after(() => {h.c.admitRuntimeAlbumPreferenceRead = realAdmission;});
  const read = beginRead(h, album({album_preference: own()}), {
    options: {isCurrent: () => !ownerReturned}, onAdmitted(lease) {delivered = lease;}});
  read.respond();
  assert.ok(isRetired((await read.result).error));
  assert.ok(delivered); assert.equal(delivered.read(), null);
});

test('native acknowledged mutation invalidates another object before presentation propagation, even if it throws', async t => {
  for (const throws of [false, true]) await t.test(`presentation throws=${throws}`, async t => {
    const h = fixture(t); await h.open(album({album_preference: own()}));
    const read = await admitted(h);
    assert.notEqual(read.dto, h.c.getCurrentTrackModalAlbum());
    const realInvalidate = h.c.invalidateHydratedTrackModalAlbumDetails;
    let propagation = 0;
    h.c.invalidateHydratedTrackModalAlbumDetails = function(...args) {
      propagation++;
      assert.equal(read.lease.read(), null, 'taste guard retires before reentrant presentation work');
      assert.equal(read.changes, 1);
      if (throws) throw new Error('synthetic presentation failure');
      return realInvalidate.apply(this, args);
    };
    t.after(() => {h.c.invalidateHydratedTrackModalAlbumDetails = realInvalidate;});
    const request = await h.activate('rating', 8);
    assert.deepEqual(JSON.parse(request.options.body), {album_ref: REF, expected_revision: 1, patch: {rating: 8}});
    request.resolve(envelope(own(8, 2))); await drain();
    assert.ok(propagation >= 1);
    assert.equal(read.changes, 1); assert.equal(read.lease.read(), null);
    assert.equal(h.posts().length, 1, 'cache failure never replays the accepted command');
  });
});

test('malformed or mismatched POST acknowledgments do not publish an invented taste observation', async t => {
  for (const patch of [{rating: 7}, {preference_revision: 0}, {context_ref: B}, {extra: 'untrusted'}])
    await t.test(JSON.stringify(patch), async t => {
      const h = fixture(t); await h.open(album({album_preference: own()}));
      const read = await admitted(h), request = await h.activate('rating', 8);
      request.resolve(envelope(own(8, 2, patch))); await drain();
      assert.equal(read.changes, 0);
      assert.ok(read.lease.read(), 'invalid mutation response awaits fresh native reconciliation');
      const reconcile = h.pending(r => r.url.startsWith('/album-details?')).at(-1);
      assert.ok(reconcile);
      reconcile.resolve(detail(album({album_preference: own(8, 2)}))); await drain();
      assert.equal(read.changes, 1, 'actual successful fresh reconciliation supplies the later observation');
    });
});

test('transport and shell scope retirement notify once, unsubscribe, and cannot revive after equal-value return', async t => {
  for (const mode of ['actor', 'library', 'context', 'transport', 'transport-dispose'])
    await t.test(mode, async t => {
      const h = fixture(t), read = await admitted(h);
      if (mode === 'transport') h.c.AlbumHavenPrivateUITransport.invalidate();
      else if (mode === 'transport-dispose') h.c.AlbumHavenPrivateUITransport.dispose();
      else h.change(mode);
      await drain();
      assert.equal(read.changes, 1, 'lifetime notification retires without waiting for lease.read polling');
      assert.equal(read.lease.read(), null);
      if (mode === 'actor') h.change('actor', '7');
      if (mode === 'library') h.change('library', '9');
      if (mode === 'context') h.change('context', A);
      await drain();
      assert.equal(read.lease.read(), null); assert.equal(read.changes, 1);
      read.lease.release(); read.lease.release();
    });
});

// Complete private transport source in an isolated browser-primitive VM.
// No decoder is installed and no network leaves this test process.
function transportFixture() {
  const shell = {dataset: {privateUiContext: A, nativeAccountId: '7', nativeLibraryId: '9'}};
  const calls = [], blobs = [], events = [], window = {};
  let respond = () => {throw new Error('test did not provide a response');};
  class AccountedBlob extends Blob {
    constructor(parts, options) {
      super(parts, options);
      blobs.push({blob: this, parts: parts.map(part => part.byteLength ?? part.size ?? String(part).length)});
    }
  }
  const context = {window, document: {getElementById: () => shell}, URL, URLSearchParams,
    Headers, TextEncoder, TextDecoder, Blob: AccountedBlob, Uint8Array, ArrayBuffer, DataView,
    AbortController, DOMException, queueMicrotask, setTimeout, clearTimeout,
    fetch(url, options) {calls.push({url, options}); return respond(url, options);}};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'music_app/static/js/runtime/private-ui-transport.js'), 'utf8'),
    context, {filename: 'music_app/static/js/runtime/private-ui-transport.js'});
  const api = window.AlbumHavenPrivateUITransport;
  assert.equal(typeof api.requestAlbumTopImagePng, 'function', 'candidate supplies the real private binary port');
  return {api, shell, calls, blobs, events, setResponse: fn => {respond = fn;},
    setContext(value) {shell.dataset.privateUiContext = value; return api.generation();}};
}

const binary = (h, options = {}) => h.api.requestAlbumTopImagePng({inventoryAlbumRef: REF,
  expected: A, expectedGeneration: 0, isCurrent: () => true, maxEncodedBytes: MAX_PNG, ...options});
const encoded = value => new TextEncoder().encode(value);
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);}
  return (crc ^ 0xffffffff) >>> 0;
};
function pngHeader(width = 1, height = 1, fields = {}) {
  // A header admission fixture, not a claim that these bytes encode pixels.
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height);
  bytes.set([fields.depth ?? 8, fields.color ?? 6, fields.compression ?? 0,
    fields.filter ?? 0, fields.interlace ?? 0], 24);
  view.setUint32(29, crc32(bytes.subarray(12, 29)));
  return bytes;
}
function streamingResponse({status = 200, mime = 'image/png', chunks = [pngHeader()],
  contentLength, redirected = false, holdReadAt = -1, readGate, cancelGate,
  readFailure, cancelFailure} = {}) {
  const stats = {reads: 0, activeReads: 0, maxActiveReads: 0, cancels: 0, releases: 0,
    cancelledSettled: false, events: [], bodyAccesses: 0, unbounded: 0};
  const reader = {
    async read() {
      const index = stats.reads++;
      stats.activeReads++; stats.maxActiveReads = Math.max(stats.maxActiveReads, stats.activeReads);
      stats.events.push('read:' + index);
      try {
        if (index === holdReadAt) return await readGate.promise;
        if (readFailure && index === 1) throw readFailure;
        return index < chunks.length ? {done: false, value: chunks[index]} : {done: true};
      } finally {stats.activeReads--;}
    },
    async cancel() {
      stats.cancels++; stats.events.push('cancel:start');
      try {if (cancelGate) await cancelGate.promise; if (cancelFailure) throw cancelFailure;}
      finally {stats.cancelledSettled = true; stats.events.push('cancel:settled');}
    },
    releaseLock() {stats.releases++; stats.events.push('release');},
  };
  const response = {status, ok: status >= 200 && status < 300, redirected,
    headers: new Headers({...(mime === null ? {} : {'Content-Type': mime}),
      ...(contentLength === undefined ? {} : {'Content-Length': String(contentLength)})}),
    get body() {stats.bodyAccesses++; return {getReader: () => reader};},
    json() {stats.unbounded++; throw new Error('unbounded json() is forbidden for the binary port');},
    text() {stats.unbounded++; throw new Error('unbounded text() is forbidden for the binary port');},
    blob() {stats.unbounded++; throw new Error('unbounded blob() is forbidden for the binary port');},
    arrayBuffer() {stats.unbounded++; throw new Error('unbounded arrayBuffer() is forbidden for the binary port');},
  };
  return {response, stats, reader};
}
const boundedFailure = error => ['resource_unavailable', 'invalid_png', 'resource_budget',
  'source_retired', 'forbidden', 'stale_context', 'unavailable'].includes(errorCode(error)) || error?.name === 'AbortError';

test('binary port derives the exact inventory PNG route and enforces request and prepared shapes', async () => {
  const h = transportFixture(), controller = new AbortController(), bytes = pngHeader(2048, 1);
  const stream = streamingResponse({mime: 'IMAGE/PNG; charset=binary', contentLength: 1,
    chunks: [bytes.subarray(0, 1), bytes.subarray(1, 8), bytes.subarray(8, 17), bytes.subarray(17)]});
  h.setResponse(async () => stream.response);
  const prepared = await binary(h, {signal: controller.signal});
  assert.deepEqual(Object.keys(prepared).sort(), ['blob', 'height', 'release', 'width']);
  assert.ok(prepared.blob instanceof Blob);
  assert.equal(prepared.blob.type, 'image/png'); assert.equal(prepared.blob.size, 33);
  assert.equal(prepared.width, 2048); assert.equal(prepared.height, 1);
  assert.equal(h.calls.length, 1); assert.equal(h.blobs.length, 1);
  const {url, options} = h.calls[0], headers = new Headers(options.headers);
  assert.equal(url, '/library/album-artwork/' + REF);
  assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.signal, controller.signal);
  assert.equal(headers.get('Accept'), 'image/png');
  assert.equal(headers.get('X-AlbumHaven-Context'), A);
  assert.equal(headers.get('Content-Type'), null); assert.equal(options.body, undefined);
  assert.equal(stream.stats.maxActiveReads, 1); assert.equal(stream.stats.unbounded, 0);
  assert.equal(stream.stats.releases, 1);
  prepared.release(); prepared.release();
  assert.equal(h.blobs.length, 1, 'release does not rebuild/re-encode the accepted Blob');
});

test('binary route cannot be widened through malformed inventory or wrong exact encoded budget', async () => {
  for (const inventoryAlbumRef of ['', 'inventory-album:0:11', 'inventory-album:09:11',
    'inventory-album:9:0', 'inventory-album:9:011', REF + '?x=1', REF + '#x', REF + '/cover',
    REF + '\n', REF + '\\x', '../' + REF, '/library/album-artwork/' + REF,
    'https://example.test/' + REF, 'inventory-album%3A9%3A11', null]) {
    const h = transportFixture();
    await assert.rejects(binary(h, {inventoryAlbumRef}));
    assert.equal(h.calls.length, 0, String(inventoryAlbumRef));
  }
  for (const maxEncodedBytes of [undefined, null, MAX_PNG - 1, MAX_PNG + 1, Infinity, '20971520']) {
    const h = transportFixture();
    await assert.rejects(binary(h, {maxEncodedBytes}));
    assert.equal(h.calls.length, 0);
  }
});

test('extra caller path/url/method data never grants another route or non-GET request', async () => {
  const h = transportFixture(), stream = streamingResponse();
  h.setResponse(async () => stream.response);
  const result = await outcome(binary(h, {path: '/cover', url: 'https://evil.invalid/x', method: 'POST'}));
  if (result.error) assert.equal(h.calls.length, 0, 'strict argument rejection occurs before dispatch');
  else {
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, '/library/album-artwork/' + REF);
    assert.equal(h.calls[0].options.method, 'GET'); result.value.release();
  }
});

test('consumed current-generation 401/403 retires despite stale/aborted caller before touching body', async () => {
  for (const status of [401, 403]) for (const mode of ['superseded', 'aborted', 'both']) {
    const h = transportFixture(), gate = deferred(), controller = new AbortController();
    let current = true, notices = 0, callerAfterReply = 0, replied = false;
    h.api.subscribe(() => {assert.equal(h.api.generation(), 1); throw new Error('observer failure');});
    h.api.subscribe(() => {notices++; assert.throws(() => h.api.context(), e => e.code === 'stale_context');});
    h.setResponse(() => gate.promise);
    const work = outcome(binary(h, {signal: controller.signal,
      isCurrent() {if (replied) callerAfterReply++; return current;}}));
    if (mode !== 'aborted') current = false;
    if (mode !== 'superseded') controller.abort();
    replied = true;
    gate.resolve({status,
      get body() {throw new Error('denial must not inspect image body');},
      get headers() {throw new Error('denial must precede image header admission');},
      json() {throw new Error('HTML denial is not JSON');}});
    const {error} = await work;
    assert.equal(errorCode(error), 'forbidden');
    if (error && typeof error === 'object' && 'status' in error) assert.equal(error.status, status);
    assert.equal(error?.name === 'AbortError', false);
    assert.equal(callerAfterReply, 0, 'individual caller check cannot hide a consumed denial');
    assert.equal(notices, 1); assert.equal(h.api.generation(), 1); assert.equal(h.blobs.length, 0);
  }
});

test('late denial of an older transport generation never retires newer or equal-valued successor context', async () => {
  for (const status of [401, 403]) for (const returnToA of [false, true]) {
    const h = transportFixture(), gate = deferred(); h.setResponse(() => gate.promise);
    const work = outcome(binary(h));
    h.setContext(B); if (returnToA) h.setContext(A);
    const generation = h.api.generation(); let deniedNotices = 0;
    h.api.subscribe(() => deniedNotices++);
    gate.resolve({status, get body() {throw new Error('old generation has no body authority');}});
    const result = await work;
    assert.ok(result.error); assert.equal(result.value, undefined);
    assert.equal(h.api.generation(), generation); assert.equal(deniedNotices, 0);
    assert.equal(h.api.context(), returnToA ? A : B);
  }
});

test('bounded structured stale_context retires even a superseded/aborted binary caller', async () => {
  for (const field of ['error_code', 'error']) {
    const h = transportFixture(), gate = deferred(), controller = new AbortController(); let live = true;
    const json = JSON.stringify({[field]: 'stale_context'});
    const bytes = encoded(json + ' '.repeat(MAX_ERROR - encoded(json).length));
    const stream = streamingResponse({status: 409, mime: 'application/json', chunks: [bytes.subarray(0, 17), bytes.subarray(17)]});
    let notices = 0; h.api.subscribe(() => {notices++; assert.equal(h.api.generation(), 1);});
    h.setResponse(() => gate.promise);
    const work = outcome(binary(h, {signal: controller.signal, isCurrent: () => live}));
    live = false; controller.abort(); gate.resolve(stream.response);
    const {error} = await work;
    assert.equal(errorCode(error), 'stale_context');
    if (error && typeof error === 'object' && 'status' in error) assert.equal(error.status, 409);
    assert.notEqual(error?.name, 'AbortError'); assert.equal(notices, 1);
    assert.equal(stream.stats.unbounded, 0); assert.equal(stream.stats.releases, 1);
    assert.equal(h.blobs.length, 0);
  }
});

test('error-body admission is bounded, fatal UTF-8 and JSON only, with no raw body disclosure', async () => {
  const secret = 'DO_NOT_DISPLAY_PRIVATE_HTML_OR_CONTEXT';
  const cases = [
    ['oversize', encoded(JSON.stringify({error: 'stale_context'}) + ' '.repeat(MAX_ERROR))],
    ['invalid UTF-8', new Uint8Array([0x7b, 0x22, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])],
    ['invalid JSON', encoded('{"error":"stale_context",')],
    ['HTML login', encoded('<html>' + secret + '</html>')],
  ];
  for (const [name, bytes] of cases) {
    const h = transportFixture(), gate = deferred(), stream = streamingResponse({status: 503,
      mime: 'text/html', chunks: [bytes], contentLength: 1}); let live = true;
    h.setResponse(() => gate.promise);
    const work = outcome(binary(h, {isCurrent: () => live}));
    live = false; gate.resolve(stream.response);
    const {error} = await work;
    assert.equal(errorCode(error), 'resource_unavailable', name);
    assert.equal(String(error?.message).includes(secret), false);
    assert.equal(h.api.generation(), 0, 'unproven body text is not stale-context authority');
    assert.equal(h.api.context(), A); assert.equal(h.blobs.length, 0);
    assert.equal(stream.stats.unbounded, 0); assert.equal(stream.stats.releases, 1);
    if (name === 'oversize') assert.equal(stream.stats.cancels, 1);
  }
});

test('late structured denial cannot retire a successor after a streamed error body await', async () => {
  const h = transportFixture(), readGate = deferred();
  const stream = streamingResponse({status: 409, mime: 'application/json', holdReadAt: 0, readGate});
  h.setResponse(async () => stream.response);
  const work = outcome(binary(h)); await drain();
  assert.equal(stream.stats.reads, 1);
  h.setContext(B); h.setContext(A); const generation = h.api.generation();
  readGate.resolve({done: false, value: encoded('{"error_code":"stale_context"}')});
  const {error} = await work;
  assert.ok(error); assert.equal(h.api.generation(), generation); assert.equal(h.api.context(), A);
  assert.equal(stream.stats.releases, 1); assert.equal(h.blobs.length, 0);
});

test('non-success statuses inspect bounded error JSON rather than trusting PNG MIME', async () => {
  for (const status of [201, 202, 204, 301, 302, 400, 404, 429, 500]) {
    const h = transportFixture(), stream = streamingResponse({status,
      mime: 'image/png', chunks: [encoded('{"error_code":"resource_unavailable"}')]});
    h.setResponse(async () => stream.response);
    const {error} = await outcome(binary(h));
    assert.equal(errorCode(error), 'resource_unavailable');
    assert.equal(h.blobs.length, 0); assert.equal(h.calls.length, 1);
    assert.equal(stream.stats.unbounded, 0); assert.equal(h.api.generation(), 0);
  }
});

test('structured error_code precedence cannot manufacture stale-context retirement from a fallback field', async () => {
  const h = transportFixture(), stream = streamingResponse({status: 503, mime: 'application/json',
    chunks: [encoded('{"error_code":"resource_unavailable","error":"stale_context"}')]});
  h.setResponse(async () => stream.response);
  const {error} = await outcome(binary(h));
  assert.equal(errorCode(error), 'resource_unavailable');
  assert.equal(h.api.generation(), 0); assert.equal(h.api.context(), A);
  assert.equal(stream.stats.releases, 1); assert.equal(stream.stats.unbounded, 0);
});

test('status 200 requires nonredirected PNG MIME and bounded streaming, not fallback body readers', async () => {
  for (const mime of [null, '', 'text/html', 'image/jpeg', 'application/octet-stream',
    'image/pngx', 'text/html; image/png', 'image/png, text/html']) {
    const h = transportFixture(), stream = streamingResponse({mime});
    h.setResponse(async () => stream.response);
    await assert.rejects(binary(h), boundedFailure);
    assert.equal(h.blobs.length, 0); assert.equal(stream.stats.unbounded, 0);
  }
  const redirected = transportFixture(), stream = streamingResponse({redirected: true});
  redirected.setResponse(async () => stream.response);
  await assert.rejects(binary(redirected), boundedFailure);
  assert.equal(redirected.blobs.length, 0);
  // Null has no acquired body to release, so bounded rejection is lawful.
  const missing = transportFixture(); let fallback = 0;
  missing.setResponse(async () => ({status: 200, ok: true, redirected: false,
    headers: new Headers({'Content-Type': 'image/png'}), body: null,
    blob() {fallback++; return new Blob([pngHeader()]);}, arrayBuffer() {fallback++; return pngHeader().buffer;}}));
  await assert.rejects(binary(missing), boundedFailure);
  assert.equal(fallback, 0); assert.equal(missing.blobs.length, 0);
});

test('nonnull bodies without a reader or cancellation retain unresolved ownership without fallback', async () => {
  for (const body of [{}, {getReader: null}]) {
    const h = transportFixture(), controller = new AbortController(), settlements = [];
    let fallback = 0, cancellationChecks = 0;
    Object.defineProperty(body, 'cancel', {get() {cancellationChecks++; return undefined;}});
    h.setResponse(async () => ({status: 200, ok: true, redirected: false,
      headers: new Headers({'Content-Type': 'image/png'}), body,
      json() {fallback++; throw new Error('SECRET_UNSAFE_JSON');},
      text() {fallback++; throw new Error('SECRET_UNSAFE_TEXT');},
      blob() {fallback++; return new Blob([pngHeader()]);}, arrayBuffer() {fallback++; return pngHeader().buffer;}}));
    // Consume either outcome, but never await an intentionally quarantined task.
    outcome(binary(h, {signal: controller.signal})).then(result => {settlements.push(result);});
    await drain();
    assert.equal(cancellationChecks, 1, 'the real owner reached its unavailable body-cleanup attempt');
    assert.deepEqual(settlements, [], 'unknown physical cleanup cannot publish success or a raw failure');
    assert.equal(fallback, 0); assert.equal(h.blobs.length, 0); assert.equal(h.calls.length, 1);
    controller.abort(); h.api.dispose(); await drain();
    assert.deepEqual(settlements, [], 'logical abort/disposal cannot settle the retained preparation barrier');
    assert.equal(cancellationChecks, 1); assert.equal(fallback, 0); assert.equal(h.blobs.length, 0);
    assert.equal(h.calls.length, 1, 'quarantine does not invent a retry or fallback fetch');
  }
});

test('nonnull missing-reader bodies reject boundedly only after successful body cancellation', async () => {
  for (const body of [{}, {getReader: null}]) {
    const h = transportFixture(), cancelGate = deferred(), settlements = [];
    let cancels = 0, fallback = 0, cancellationConfirmed = false;
    body.cancel = async () => {cancels++; await cancelGate.promise; cancellationConfirmed = true;};
    h.setResponse(async () => ({status: 200, ok: true, redirected: false,
      headers: new Headers({'Content-Type': 'image/png'}), body,
      blob() {fallback++; return new Blob([pngHeader()]);}, arrayBuffer() {fallback++; return pngHeader().buffer;}}));
    const work = outcome(binary(h)).then(result => {settlements.push(result); return result;});
    await drain();
    assert.equal(cancels, 1); assert.equal(cancellationConfirmed, false); assert.deepEqual(settlements, []);
    cancelGate.resolve();
    const {error} = await work;
    assert.equal(cancellationConfirmed, true); assert.ok(boundedFailure(error));
    assert.equal(cancels, 1); assert.equal(fallback, 0); assert.equal(h.blobs.length, 0);
    assert.equal(h.calls.length, 1);
  }
});

test('PNG admission rejects malformed signatures, incomplete IHDR, impossible dimensions and format fields', async () => {
  const signature = pngHeader(); signature[0] = 0;
  const wrongType = pngHeader(); wrongType[12] = 74;
  const wrongLength = pngHeader(); new DataView(wrongLength.buffer).setUint32(8, 12);
  const invalid = [signature, wrongType, wrongLength, pngHeader().subarray(0, 32),
    pngHeader(0, 1), pngHeader(1, 0), pngHeader(2049, 1), pngHeader(1, 2049),
    pngHeader(0xffffffff, 1), pngHeader(1, 1, {depth: 3}), pngHeader(1, 1, {color: 1}),
    pngHeader(1, 1, {color: 6, depth: 1}), pngHeader(1, 1, {color: 3, depth: 16}),
    pngHeader(1, 1, {compression: 1}), pngHeader(1, 1, {filter: 1}), pngHeader(1, 1, {interlace: 2})];
  for (const bytes of invalid) {
    const h = transportFixture(), stream = streamingResponse({chunks: [bytes]});
    h.setResponse(async () => stream.response);
    await assert.rejects(binary(h), boundedFailure);
    assert.equal(h.blobs.length, 0); assert.equal(stream.stats.releases, 1);
  }
});

test('PNG header admits legal edge dimensions and IHDR color/depth combinations without decoding', async () => {
  for (const [color, depths] of [[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]])
    for (const depth of depths) for (const interlace of [0, 1]) {
      const h = transportFixture(), stream = streamingResponse({chunks: [pngHeader(1, 2048, {color, depth, interlace})]});
      h.setResponse(async () => stream.response);
      const prepared = await binary(h);
      assert.equal(prepared.width, 1); assert.equal(prepared.height, 2048);
      prepared.release(); assert.equal(stream.stats.releases, 1);
    }
});

test('decoded HTTP byte count enforces the exact PNG cap independently of Content-Length', async () => {
  for (const extra of [0, 1]) {
    const h = transportFixture(), bytes = new Uint8Array(MAX_PNG + extra); bytes.set(pngHeader());
    const stream = streamingResponse({contentLength: 1, chunks: [bytes.subarray(0, 33), bytes.subarray(33)]});
    h.setResponse(async () => stream.response);
    const result = await outcome(binary(h));
    if (extra === 0) {
      assert.equal(result.error, undefined, result.error?.stack);
      assert.equal(result.value.blob.size, MAX_PNG); result.value.release();
      assert.equal(h.blobs.length, 1);
    } else {
      assert.ok(boundedFailure(result.error));
      assert.equal(h.blobs.length, 0, 'over-budget chunk never reaches Blob construction');
      assert.equal(stream.stats.cancels, 1);
    }
    assert.equal(stream.stats.releases, 1); assert.equal(stream.stats.unbounded, 0);
  }
  const h = transportFixture(), stream = streamingResponse({contentLength: MAX_PNG + 1});
  h.setResponse(async () => stream.response);
  await assert.rejects(binary(h), boundedFailure); assert.equal(h.blobs.length, 0);
});

test('oversize cancellation must settle before binary task settlement and reader lock release', async () => {
  const h = transportFixture(), cancelGate = deferred();
  const bytes = new Uint8Array(MAX_PNG + 1); bytes.set(pngHeader());
  const stream = streamingResponse({chunks: [bytes], cancelGate});
  h.setResponse(async () => stream.response);
  let finished = false;
  const work = outcome(binary(h)).then(result => {finished = true; return result;});
  await drain();
  assert.equal(stream.stats.cancels, 1); assert.equal(finished, false);
  assert.equal(stream.stats.releases, 0, 'pending cancellation is still owned');
  cancelGate.resolve();
  const result = await work;
  assert.ok(boundedFailure(result.error)); assert.equal(stream.stats.releases, 1);
  assert.ok(stream.stats.events.indexOf('cancel:settled') < stream.stats.events.indexOf('release'));
});

test('aborted outstanding reader cannot be treated as settled until read and cancellation settle', async () => {
  const h = transportFixture(), readGate = deferred(), cancelGate = deferred(), controller = new AbortController();
  const stream = streamingResponse({chunks: [pngHeader()], holdReadAt: 1, readGate, cancelGate});
  h.setResponse(async () => stream.response);
  let settled = false;
  const work = outcome(binary(h, {signal: controller.signal})).then(result => {settled = true; return result;});
  await drain(); assert.equal(stream.stats.activeReads, 1);
  controller.abort(); await drain(); assert.equal(settled, false);
  readGate.resolve({done: true}); await drain();
  assert.equal(stream.stats.cancels, 1); assert.equal(settled, false);
  assert.equal(stream.stats.releases, 0);
  cancelGate.resolve();
  const {error} = await work;
  assert.ok(boundedFailure(error)); assert.equal(stream.stats.releases, 1);
  assert.equal(h.blobs.length, 0); assert.equal(stream.stats.maxActiveReads, 1);
});

test('stream rejection with successful cancellation rejects boundedly and releases exactly once', async () => {
  const h = transportFixture(), stream = streamingResponse({chunks: [pngHeader()],
    readFailure: new Error('SECRET_NETWORK_FAILURE')});
  h.setResponse(async () => stream.response);
  const {error} = await outcome(binary(h));
  assert.ok(boundedFailure(error)); assert.equal(stream.stats.cancels, 1);
  assert.equal(stream.stats.releases, 1); assert.equal(h.blobs.length, 0);
  assert.equal(String(error?.message).includes('SECRET_'), false);
  assert.equal(stream.stats.unbounded, 0);
  assert.deepEqual(stream.stats.events, ['read:0', 'read:1', 'cancel:start', 'cancel:settled', 'release']);
});

test('stream and cancellation rejection consume failures but retain unresolved ownership after remaining cleanup', async () => {
  const h = transportFixture(), controller = new AbortController(), settlements = [];
  const stream = streamingResponse({chunks: [pngHeader()],
    readFailure: new Error('SECRET_NETWORK_FAILURE'), cancelFailure: new Error('SECRET_CANCEL_FAILURE')});
  h.setResponse(async () => stream.response);
  outcome(binary(h, {signal: controller.signal})).then(result => {settlements.push(result);});
  await drain();
  assert.equal(stream.stats.cancels, 1); assert.equal(stream.stats.releases, 1);
  assert.deepEqual(stream.stats.events, ['read:0', 'read:1', 'cancel:start', 'cancel:settled', 'release'],
    'the real owner consumed cancellation rejection and attempted remaining lock cleanup');
  assert.equal(stream.stats.activeReads, 0); assert.equal(stream.stats.unbounded, 0);
  assert.equal(h.blobs.length, 0); assert.equal(h.calls.length, 1);
  assert.deepEqual(settlements, [], 'neither raw failure nor claimed release may escape unresolved ownership');
  // cancel:settled records rejection completion, not successful physical cleanup.
  // Abort/dispose cannot reopen the owning consumer lane by settling this work.
  controller.abort(); h.api.dispose(); await drain();
  assert.deepEqual(settlements, [], 'the preparation barrier remains owned after logical retirement');
  assert.equal(stream.stats.cancels, 1); assert.equal(stream.stats.releases, 1);
  assert.equal(stream.stats.unbounded, 0); assert.equal(h.blobs.length, 0); assert.equal(h.calls.length, 1);
});

test('binary currentness is checked before dispatch, after successful fetch and after every stream await', async () => {
  const before = transportFixture();
  await assert.rejects(binary(before, {isCurrent: () => false}), boundedFailure);
  assert.equal(before.calls.length, 0);
  const after = transportFixture(), gate = deferred(); let live = true;
  after.setResponse(() => gate.promise);
  const first = outcome(binary(after, {isCurrent: () => live}));
  live = false;
  gate.resolve({status: 200, get headers() {throw new Error('stale successful response must not parse headers');}});
  assert.ok(boundedFailure((await first).error)); assert.equal(after.blobs.length, 0);
  const streamOwner = transportFixture(), readGate = deferred(); live = true;
  const stream = streamingResponse({holdReadAt: 0, readGate});
  streamOwner.setResponse(async () => stream.response);
  const second = outcome(binary(streamOwner, {isCurrent: () => live}));
  await drain(); live = false; readGate.resolve({done: false, value: pngHeader()});
  assert.ok(boundedFailure((await second).error));
  assert.equal(stream.stats.cancels, 1); assert.equal(stream.stats.releases, 1);
  assert.equal(streamOwner.blobs.length, 0);
});

test('ordinary JSON request and existing remote denial behavior remain separate from image transport', async () => {
  const h = transportFixture(); let ordinaryJson = 0;
  h.setResponse(async () => ({status: 403, ok: false, json: async () => {ordinaryJson++; return {error: 'legacy_denied'};}}));
  await assert.rejects(h.api.request('/ordinary-private-read', {expected: A}),
    e => e.status === 403 && e.code === 'legacy_denied');
  assert.equal(ordinaryJson, 1); assert.equal(h.api.generation(), 0);
  assert.equal(new Headers(h.calls[0].options.headers).get('Accept'), 'application/json');
  assert.equal(h.calls[0].options.redirect, undefined, 'ordinary legacy request options are unchanged');
  const gate = deferred(); let live = true;
  h.setResponse(() => gate.promise);
  const remote = outcome(h.api.requestAlbumTopRemote('/album-top-catalog/remote-acquisitions',
    {method: 'POST', body: {}, expected: A, expectedGeneration: 0, isCurrent: () => live}));
  live = false; gate.resolve({status: 403, json() {throw new Error('remote denial must not parse body');}});
  const {error} = await remote;
  assert.equal(error?.code, 'forbidden'); assert.equal(error?.status, 403);
  assert.equal(h.api.generation(), 1); assert.equal(h.blobs.length, 0);
});
