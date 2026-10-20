'use strict';
// Additive blocker-3 regressions, authored as text only. This file has not been
// imported, parsed, or executed in its authoring packet. Run only in a separately
// authorized complete candidate closure with ALBUM_TOP_TEST_ROOT.
// Native transport, bridge, access, coordinator, renderer and dialog owners come
// from that closure unchanged. Only browser/network primitives and DTOs are fake;
// the integrated fixture forwards native calls across its VM/host Promise seam.
// Synthetic scheduling/header witnesses are not browser, decoder, pixel or heap
// evidence. No copied response-admission or source-authority policy lives here.
// Failed cancellation follows correction-contract R1 section C: physical release
// stays unconfirmed even after its rejection/throw has been consumed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
const N = require(path.join(ROOT, 'tests/js/runtime/search-native-fixtures/actual-runtime.cjs'));
const F = require(path.join(ROOT, 'tests/js/runtime/album-tops-membership-fixtures/top-builder-fixtures.cjs'));
const C = require(path.join(ROOT, 'tests/js/album-top-image-coordinator-fixture.cjs'));
const NativeBlob = globalThis.Blob;
const COVER = '/library/album-artwork/inventory-album:9:11';
const BRAND = '/static/images/album-haven-cloud-vinyl.png';
const MAX_BYTES = 20971520;
const SECRET = 'PRIVATE_RESPONSE_CANCELLATION_DETAIL';
const code = error => typeof error === 'string' ? error : error?.code;
const bounded = error => error?.name === 'AbortError'
  || ['resource_unavailable', 'source_retired', 'forbidden', 'stale_context'].includes(code(error));
function tracked(promise) {
  const result = {settled: false};
  result.promise = Promise.resolve(promise).then(value => {
    result.settled = true; result.value = value; return result;
  }, error => {result.settled = true; result.error = error; return result;});
  return result;
}
function member() {
  return {item_ref: F.id(111), album_ref: F.id(11), title: 'Synthetic album', artist: 'Synthetic artist', year: 2001,
    native_album: {inventory_album_ref: 'inventory-album:9:11', artwork_url: COVER,
      allowed_actions: {can_view_details: true}}};
}
function sourcePorts(base) {
  const c = base.context || base.c, runtime = c.AlbumHavenAlbumTopsRuntime;
  assert.ok(runtime?.imageExport, 'complete manifest supplies the actual native image bridge');
  const detail = F.detail({items: [member()], edit_draft: undefined});
  const state = F.controllerFixture({...F.state({editing: true, data: detail}), scopeKey: runtime.snapshot().scopeKey});
  const sourceSubscriptions = {started: 0}, subscribe = state.controller.subscribe;
  state.controller.subscribe = callback => {sourceSubscriptions.started++; return subscribe(callback);};
  const providers = {resolveNativeAlbum() {assert.fail('default-off image resources must not resolve own-rating sources');}};
  const retirements = [];
  const access = runtime.imageExport.createAccess({controller: state.controller, providers, attribution: 'Synthetic curator',
    onRetired(capture, reason) {retirements.push({capture, reason});}});
  const capture = access.capture({sourceKey: 'response-ownership-1'});
  assert.ok(capture, 'real native owner admits the exact complete source');
  const transport = c.AlbumHavenPrivateUITransport;
  const expected = transport.context(), expectedGeneration = transport.generation();
  return {c, runtime, access, capture, transport, expected, expectedGeneration, detail, state, providers, retirements, sourceSubscriptions,
    retireSource() {state.replace({...state.controller.getSnapshot(), detail: {status: 'ready', data: {...detail}}});},
    transportRead(options = {}) {return transport.requestAlbumTopImagePng({inventoryAlbumRef: 'inventory-album:9:11',
      expected, expectedGeneration, isCurrent: () => true, maxEncodedBytes: MAX_BYTES, ...options});},
    resource(kind, signal = new AbortController().signal) {
      return Object.freeze({binding: capture.source.binding, kind, itemRef: kind === 'cover' ? detail.items[0].item_ref : null,
        albumRef: kind === 'cover' ? detail.items[0].album_ref : null, maxEncodedBytes: MAX_BYTES,
        maxWidth: 2048, maxHeight: 2048, signal});
    },
  };
}
function installNetwork(c) {
  const calls = [], blobs = [], original = new Map();
  let responder = () => {assert.fail('test did not supply a network response');};
  class AccountedBlob extends NativeBlob {
    constructor(parts, options) {super(parts, options); blobs.push(this);}
  }
  const replacements = {Headers, Blob: AccountedBlob, Uint8Array, ArrayBuffer, DataView, TextEncoder, TextDecoder,
    fetch(url, options = {}) {const call = {url: String(url), options}; calls.push(call); return responder(call);}};
  for (const [key, value] of Object.entries(replacements)) {
    original.set(key, Object.getOwnPropertyDescriptor(c, key));
    Object.defineProperty(c, key, {configurable: true, writable: true, value});
  }
  return {calls, blobs, respond(fn) {responder = fn;}, restore() {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(c, key, descriptor); else delete c[key];
    }
  }};
}
function fixture(t) {
  const cleanups = [];
  let host = null, h = null, network = null;
  t.after(async () => {
    try {h?.access.dispose();}
    finally {network?.restore(); host?.remove(); for (const cleanup of cleanups) await cleanup();}
  });
  const base = N.fixture({after(fn) {cleanups.push(fn);}}, {url: 'https://albumhaven.test/?surface=album_tops'});
  host = base.document.createElement('section'); host.id = 'album-tops-root'; base.main.append(host);
  base.state.view = {...N.ordinary(), surface: {active: 'album_tops'}, surface_request: 'album_tops', top_ref: F.TOP};
  base.state.ui.pendingViewTransition = false;
  base.c.AlbumHavenAlbumTopsRuntime.sync();
  h = sourcePorts(base); network = installNetwork(h.c);
  for (const name of ['private-ui-transport.js', 'album-tops-react-bridge.js', 'response-state-helpers.js'])
    assert.ok(base.loaded.some(file => file.endsWith('/' + name)), `actual owner loaded: ${name}`);
  return {...base, ...h, network};
}
// The response exposes both platform cancellation styles when requested. The
// tests permit direct unlocked body.cancel or getReader/cancel/releaseLock; the
// reader-only variant separately proves the acquired-lock cleanup obligation.
function response({status = 200, mime = 'image/png', redirected = false, poisonHeaders = false,
  directCancel = false, cancelMode = 'deferred', bytes = C.pngBytes(31, 17)} = {}) {
  const gate = N.deferred();
  const stats = {headers: 0, body: 0, gets: 0, reads: 0, cancels: 0, releases: 0,
    locked: false, cancelSettled: false, unbounded: 0, events: []};
  const finish = () => {stats.cancelSettled = true; stats.events.push('cancel:settled');};
  function cancel() {
    stats.cancels++; stats.events.push('cancel:start');
    if (cancelMode === 'throw') {finish(); throw new Error(SECRET);}
    return gate.promise.then(() => {
      finish(); if (cancelMode === 'reject') throw new Error(SECRET);
    }, error => {finish(); throw error;});
  }
  let emitted = false;
  const reader = {
    read() {stats.reads++; stats.events.push('read');
      if (emitted) return Promise.resolve({done: true});
      emitted = true; return Promise.resolve({done: false, value: bytes});},
    cancel,
    releaseLock() {assert.equal(stats.locked, true, 'release only an owned lock');
      stats.releases++; stats.locked = false; stats.events.push('release');},
  };
  const body = {getReader() {assert.equal(stats.locked, false, 'one lock at a time'); stats.gets++; stats.locked = true; return reader;}};
  if (directCancel) body.cancel = () => {assert.equal(stats.locked, false, 'unlocked stream cancellation only'); return cancel();};
  const value = {status, ok: status >= 200 && status < 300, redirected,
    get headers() {stats.headers++; if (poisonHeaders) throw new Error('STALE_HEADER_MUST_NOT_BE_READ');
      return new Headers({'Content-Type': mime});},
    get body() {stats.body++; return body;},
  };
  for (const name of ['json', 'text', 'blob', 'arrayBuffer']) value[name] = () => {
    stats.unbounded++; assert.fail(`unbounded response.${name} is forbidden`);
  };
  return {value, stats, gate};
}
function assertCancellationAttempts(stream, {readerOnly = true} = {}) {
  const s = stream.stats;
  assert.equal(s.cancels, 1, 'one cancellation attempt for the owned rejected response');
  assert.equal(s.cancelSettled, true, 'cancellation outcome has settled');
  assert.equal(s.reads, 0, 'pre-stream rejection must not consume response bytes');
  assert.equal(s.unbounded, 0);
  if (readerOnly) assert.equal(s.gets, 1, 'reader fallback acquires exactly one lock');
  assert.ok(s.gets === 0 || s.gets === 1);
  assert.equal(s.releases, s.gets, 'each acquired lock is released exactly once');
  assert.equal(s.locked, false);
  if (s.gets) assert.ok(s.events.indexOf('cancel:settled') < s.events.indexOf('release'), 'release follows settled cancellation');
}
function assertRejected(work, stream) {
  assert.equal(work.value, undefined);
  assert.ok(bounded(work.error), `bounded failure, got ${code(work.error) || work.error?.name}`);
  assert.equal(String(work.error?.message || work.error).includes(SECRET), false, 'cleanup exception is not exposed');
  assert.equal(String(work.error?.message || work.error).includes('STALE_HEADER'), false);
  assert.equal(stream.stats.unbounded, 0);
}
function assertUnconfirmedPort(work, stream) {
  // The exact API does not mandate how an unknown physical release is retained.
  // A port may remain pending or reject boundedly into an owning quarantine.
  // Only the real coordinator tests below can prove no new lane is granted.
  assert.equal(work.value, undefined, 'failed cancellation cannot produce a resource');
  if (work.settled) assertRejected(work, stream);
}

for (const target of ['private-cover', 'fixed-symbol']) {
  for (const rejection of ['mime', 'redirect', 'caller-retired', 'aborted', 'stale-generation']) {
    for (const cancelMode of ['deferred', 'reject', 'throw']) {
      test(`${target}: ${rejection} owns reader cancellation (${cancelMode}) before settling`, async t => {
        const h = fixture(t), delivery = N.deferred(), abort = new AbortController();
        let current = true;
        const stale = !['mime', 'redirect'].includes(rejection);
        const stream = response({mime: rejection === 'mime' ? 'text/html' : 'image/png',
          redirected: rejection === 'redirect', poisonHeaders: stale, cancelMode});
        h.network.respond(() => delivery.promise);
        const work = tracked(target === 'private-cover' ? h.transportRead({signal: abort.signal, isCurrent: () => current})
          : h.access.prepareBrand(h.capture, h.resource('brand', abort.signal)));
        assert.equal(h.network.calls.length, 1);
        assert.equal(h.network.calls[0].url, target === 'private-cover' ? COVER : BRAND);
        assert.equal(h.network.calls[0].options.redirect, 'error');
        if (rejection === 'caller-retired') {
          current = false; if (target === 'fixed-symbol') h.retireSource();
        }
        if (rejection === 'aborted') abort.abort();
        if (rejection === 'stale-generation') {h.change('context', N.B); h.change('context', N.A);}
        const generation = h.transport.generation();
        try {
          delivery.resolve(stream.value); await C.settle();
          assert.equal(stream.stats.cancels, 1, 'headers-only fetch still owns a live response body');
          assert.equal(stream.stats.reads, 0);
          if (stale) assert.equal(stream.stats.headers, 0, 'stale success permits disposal, not MIME inspection');
          if (cancelMode !== 'throw') {
            assert.equal(work.settled, false, 'abort/rejection is not cancellation settlement');
            assert.equal(stream.stats.releases, 0, 'pending cancellation retains its acquired lock');
            stream.gate.resolve();
          }
          if (cancelMode === 'deferred') {await work.promise; assertRejected(work, stream);}
          else {await C.settle(); assertUnconfirmedPort(work, stream);}
          assertCancellationAttempts(stream);
          assert.equal(h.network.blobs.length, 0);
          assert.equal(h.network.calls.length, 1, 'no retry or alternate artwork route');
          assert.equal(h.transport.generation(), generation, 'successful response rejection creates no denial authority');
        } finally {stream.gate.resolve(); delivery.resolve(stream.value); await C.settle();}
      });
    }
  }
}

for (const target of ['private-cover', 'fixed-symbol']) {
  for (const stale of [false, true]) test(`${target}: unlocked-body cancellation is also awaited${stale ? ' after source retirement' : ''}`, async t => {
    const h = fixture(t), delivery = N.deferred();
    const stream = response({mime: 'image/jpeg', poisonHeaders: stale, directCancel: true});
    h.network.respond(() => delivery.promise);
    let current = true;
    const work = tracked(target === 'private-cover' ? h.transportRead({isCurrent: () => current})
      : h.access.prepareBrand(h.capture, h.resource('brand')));
    if (stale) {current = false; h.retireSource();}
    try {
      delivery.resolve(stream.value); await C.settle();
      assert.equal(stream.stats.cancels, 1); assert.equal(work.settled, false);
      assert.equal(stream.stats.releases, 0); assert.equal(stream.stats.reads, 0);
      if (stale) assert.equal(stream.stats.headers, 0);
      stream.gate.resolve(); await work.promise;
      assertRejected(work, stream); assertCancellationAttempts(stream, {readerOnly: false});
      assert.equal(h.network.blobs.length, 0);
    } finally {stream.gate.resolve(); delivery.resolve(stream.value); await C.settle();}
  });
}

for (const cancelMode of ['deferred', 'reject', 'throw']) {
  test(`stale-generation HTTP 500 disposes pre-stream body without successor authority (${cancelMode})`, async t => {
    const h = fixture(t), delivery = N.deferred();
    const stream = response({status: 500, mime: 'text/html', poisonHeaders: true, cancelMode});
    h.network.respond(() => delivery.promise);
    const work = tracked(h.transportRead());
    h.change('context', N.B); h.change('context', N.A);
    const generation = h.transport.generation(); let notices = 0;
    const unsubscribe = h.transport.subscribe(() => notices++);
    try {
      delivery.resolve(stream.value); await C.settle();
      assert.equal(stream.stats.cancels, 1, 'an ordinary old-generation error response still owns its unread body');
      assert.equal(stream.stats.headers, 0, 'old generation cannot inspect error MIME');
      assert.equal(stream.stats.reads, 0, 'old generation cannot parse error bytes');
      if (cancelMode !== 'throw') {
        assert.equal(work.settled, false, 'error response cancellation is awaited');
        assert.equal(stream.stats.releases, 0); stream.gate.resolve();
      }
      if (cancelMode === 'deferred') {await work.promise; assertRejected(work, stream);}
      else {await C.settle(); assertUnconfirmedPort(work, stream);}
      assertCancellationAttempts(stream);
      assert.equal(h.transport.generation(), generation); assert.equal(h.transport.context(), N.A);
      assert.equal(notices, 0, 'stale ordinary response cannot retire the successor generation');
      assert.equal(h.network.blobs.length, 0); assert.equal(h.network.calls.length, 1);
    } finally {unsubscribe(); stream.gate.resolve(); delivery.resolve(stream.value); await C.settle();}
  });
}

for (const status of [401, 403]) {
  for (const staleGeneration of [false, true]) test(`consumed ${status} preserves denial ordering${staleGeneration ? ' without successor authority' : ''}`, async t => {
    const h = fixture(t), delivery = N.deferred(), abort = new AbortController();
    let delivered = false, current = true, callerAfterReply = 0, forbiddenReads = 0, notices = 0;
    h.network.respond(() => delivery.promise);
    const work = tracked(h.transportRead({signal: abort.signal, isCurrent() {
      if (delivered) callerAfterReply++; return current;
    }}));
    current = false; abort.abort();
    if (staleGeneration) {h.change('context', N.B); h.change('context', N.A);}
    const before = h.transport.generation();
    const unsubscribe = h.transport.subscribe(() => {notices++; assert.equal(h.transport.generation(), before + 1);});
    const denial = {status, get headers() {forbiddenReads++; throw new Error('denial headers are forbidden');},
      get body() {forbiddenReads++; throw new Error('denial body is forbidden');}};
    for (const name of ['json', 'text', 'blob', 'arrayBuffer']) denial[name] = () => {
      forbiddenReads++; assert.fail('denial body parsing is forbidden');
    };
    delivered = true; delivery.resolve(denial); await work.promise;
    assert.ok(bounded(work.error)); assert.equal(work.value, undefined);
    assert.equal(forbiddenReads, 0, 'response cleanup must not inspect a consumed denial');
    assert.equal(callerAfterReply, 0, 'individual caller cannot hide generation-owned denial');
    assert.equal(notices, staleGeneration ? 0 : 1);
    assert.equal(h.transport.generation(), before + (staleGeneration ? 0 : 1));
    if (staleGeneration) assert.equal(h.transport.context(), N.A, 'equal-valued successor stays usable');
    else assert.equal(code(work.error), 'forbidden');
    assert.equal(h.network.blobs.length, 0); unsubscribe();
  });
}

async function coordinatorFixture(t) {
  // Reuse accepted browser/font/canvas/native-dialog fixtures without changing
  // them. Their synthetic coordinator/access is never opened. This separate
  // coordinator is retained by the actual runtime and uses its actual bridge.
  const cleanups = [], handles = [], bitmaps = [], closed = [], nativeAccesses = [], nativePreparations = [];
  let ports = null, network = null, owner = null, savedBitmap, savedContextBitmap, bitmapInstalled = false;
  t.after(async () => {
    try {for (const handle of handles) handle.close(); owner?.dispose(); ports?.access.dispose(); await C.settle();}
    finally {
      if (bitmapInstalled) {
        if (savedBitmap) Object.defineProperty(globalThis, 'createImageBitmap', savedBitmap); else delete globalThis.createImageBitmap;
        if (savedContextBitmap) Object.defineProperty(ports.c, 'createImageBitmap', savedContextBitmap); else delete ports.c.createImageBitmap;
      }
      network?.restore(); for (const cleanup of cleanups) await cleanup();
    }
  });
  const h = await C.fixture({after(fn) {cleanups.push(fn);}}, {count: 1});
  ports = sourcePorts(h); network = installNetwork(ports.c);
  const {createAlbumTopImageCoordinator} = await C.load('image-export-coordinator.mjs');
  // Real native async functions live in the fixture's VM realm; the imported
  // renderer correctly requires its own native Promise at each async port.
  // Forward every call with its original native receiver and unchanged args.
  // Only preparation return values cross the realm via Promise.resolve of the
  // exact operation. No catch, replacement result, admission or cleanup policy.
  const nativeBridge = ports.runtime.imageExport;
  const bridge = Object.freeze({createAccess(...args) {
    const access = Reflect.apply(nativeBridge.createAccess, nativeBridge, args);
    nativeAccesses.push(access);
    return Object.freeze(Object.fromEntries(Object.entries(access).map(([name, operation]) => [name, (...args) => {
      if (name !== 'prepareCover' && name !== 'prepareBrand') return Reflect.apply(operation, access, args);
      const row = {name, receiver: access, args}; nativePreparations.push(row);
      row.operation = Reflect.apply(operation, access, args);
      row.promise = Promise.resolve(row.operation);
      return row.promise;
    }])));
  }});
  owner = nativeBridge.coordinator(() => createAlbumTopImageCoordinator({runtime: ports.runtime, bridge}));
  assert.equal(ports.runtime.imageExport.coordinator(() => assert.fail('runtime replaced its real coordinator')), owner);
  savedBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  savedContextBitmap = Object.getOwnPropertyDescriptor(ports.c, 'createImageBitmap');
  // The only successful resource before a deliberately rejected symbol is the
  // synthetic 31x17 cover header. A known-dimension browser double avoids any
  // replacement of transport/preparation policy and performs no real decoding.
  const decode = async blob => {
    assert.ok(blob instanceof NativeBlob); assert.equal(blob.type, 'image/png');
    const record = {blob, closes: 0}; bitmaps.push(record);
    return {width: 31, height: 17, close() {record.closes++;}};
  };
  bitmapInstalled = true;
  Object.defineProperty(globalThis, 'createImageBitmap', {configurable: true, writable: true, value: decode});
  Object.defineProperty(ports.c, 'createImageBitmap', {configurable: true, writable: true, value: decode});
  return {...h, ...ports, network, owner, bitmapRecords: bitmaps, closeNotices: closed, nativeAccesses, nativePreparations,
    openReal() {const handle = owner.open({controller: ports.state.controller, providers: ports.providers,
      attribution: 'Synthetic curator', returnFocus: () => h.host.focus(), fallbackHost: h.host,
      onClose() {closed.push(true);}}); handles.push(handle); return handle;},
  };
}

function observeRealPreparation(h, target, call) {
  assert.equal(h.nativeAccesses.length, 1, 'one actual access owner was constructed for the first designer');
  assert.deepEqual(h.nativePreparations.map(row => row.name), target === 'private-cover'
    ? ['prepareCover'] : ['prepareCover', 'prepareBrand'], 'each actual preparation operation is called once in native order');
  const row = h.nativePreparations.at(-1);
  assert.equal(row.receiver, h.nativeAccesses[0], 'forwarding retains the actual native access receiver');
  assert.equal(row.args.length, 2, 'capture and resource request are forwarded without extra arguments');
  assert.equal(row.args[1].signal, call.options.signal, 'the exact renderer request reaches the actual native fetch');
  assert.deepEqual(row.args[1].binding, {...row.args[0].source.binding}, 'the unchanged renderer request carries the native capture binding');
  assert.equal(row.operation instanceof Promise, false, 'the real async preparation originates in the VM realm');
  assert.equal(row.promise instanceof Promise, true, 'only the return boundary adopts into the renderer host realm');
  assert.notEqual(row.promise, row.operation);
  return {native: tracked(row.operation), host: tracked(row.promise)};
}
function assertPreparationPending(work) {
  assert.equal(work.native.settled, false, 'actual native preparation still owns its unresolved cancellation');
  assert.equal(work.host.settled, false, 'realm adoption cannot settle ahead of the actual native operation');
}
function assertPreparationOutcome(work, stream) {
  assert.equal(work.host.settled, work.native.settled, 'realm adoption preserves the observed native outcome');
  assertUnconfirmedPort(work.native, stream); assertUnconfirmedPort(work.host, stream);
  if (work.native.settled) assert.equal(work.host.error, work.native.error, 'the exact native rejection passes through unchanged');
}

for (const target of ['private-cover', 'fixed-symbol']) {
  for (const rejection of ['mime', 'redirect', 'late-after-close']) test(`real ${target} cancellation holds close/reopen across ${rejection}`, async t => {
    const h = await coordinatorFixture(t), delivery = N.deferred();
    const stream = response({mime: rejection === 'mime' ? 'text/html' : 'image/png',
      redirected: rejection === 'redirect', poisonHeaders: rejection === 'late-after-close'});
    let targetCall = null, released = false;
    const targetUrl = target === 'private-cover' ? COVER : BRAND;
    h.network.respond(call => {
      assert.ok([COVER, BRAND].includes(call.url), 'only exact native cover/fixed-symbol destinations');
      if (!released && call.url === targetUrl) {assert.equal(targetCall, null, 'one target preparation at a time'); targetCall = call; return delivery.promise;}
      if (!released && target === 'fixed-symbol' && call.url === COVER) {
        const success = response(); success.gate.resolve(); return Promise.resolve(success.value);
      }
      // A resumed successor reaches its own actual transport, then fails closed
      // without a preview. The test proves admission ordering, not raster output.
      const stop = response({mime: 'text/html'}); stop.gate.resolve(); return Promise.resolve(stop.value);
    });
    const first = h.openReal(), firstClosed = tracked(first.closed);
    let next = null;
    try {
      await h.pump(); assert.ok(targetCall, 'real renderer has reached the intended real preparation port');
      const preparation = observeRealPreparation(h, target, targetCall);
      assert.equal(h.accesses.length, 0, 'accepted fixture synthetic access has not been used');
      if (rejection !== 'late-after-close') {delivery.resolve(stream.value); await C.settle(); assert.equal(stream.stats.cancels, 1);}
      first.close(); next = h.openReal();
      if (rejection === 'late-after-close') {delivery.resolve(stream.value); await C.settle();}
      assert.equal(stream.stats.cancels, 1, 'late response is acquired even after source/access retirement');
      if (rejection === 'late-after-close') assert.equal(stream.stats.headers, 0, 'closing stale response is disposed without inspecting MIME');
      const before = {calls: h.network.calls.length, fonts: h.fontLoads.length, bitmaps: h.bitmapRecords.length,
        canvases: h.canvases.length, encodes: h.encodes.length, urls: h.urls.size, subscriptions: h.sourceSubscriptions.started,
        accesses: h.nativeAccesses.length, preparations: h.nativePreparations.length};
      await h.pump();
      assertPreparationPending(preparation);
      assert.equal(firstClosed.settled, false, 'actual body cancellation remains in the old designer barrier');
      assert.equal(h.owner.read().phase, 'waiting');
      assert.match(h.text(), /waiting.*clos/i);
      assert.equal(h.network.calls.length, before.calls, 'no successor network work');
      assert.equal(h.fontLoads.length, before.fonts, 'no successor font preparation');
      assert.equal(h.bitmapRecords.length, before.bitmaps, 'no successor bitmap decode');
      assert.equal(h.canvases.length, before.canvases, 'no successor surface');
      assert.equal(h.encodes.length, before.encodes); assert.equal(h.urls.size, before.urls);
      assert.equal(h.sourceSubscriptions.started, before.subscriptions, 'waiting shell starts no new source-access subscriptions');
      assert.equal(h.nativeAccesses.length, before.accesses, 'waiting shell cannot acquire another actual access owner');
      assert.equal(h.nativePreparations.length, before.preparations, 'waiting shell cannot invoke another real preparation');
      assert.equal(stream.stats.releases, 0); assert.equal(stream.stats.reads, 0);
      released = true; stream.gate.resolve(); await h.pump(); await firstClosed.promise;
      await preparation.native.promise; await preparation.host.promise;
      assertRejected(preparation.native, stream); assertPreparationOutcome(preparation, stream);
      assertCancellationAttempts(stream);
      assert.ok(h.network.calls.length > before.calls, 'successor begins only after the real cancellation settles');
      assert.equal(h.nativeAccesses.length, before.accesses + 1, 'one successor obtains its own actual access after closure');
      assert.equal(h.nativePreparations.length, before.preparations + 1, 'one actual successor cover operation starts after closure');
      assert.ok(h.fontLoads.length > before.fonts, 'new source starts its own preparation after the barrier');
      assert.equal(h.owner.read().phase, 'active');
      assert.equal(h.accesses.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.preview(), null);
      assert.ok(h.bitmapRecords.every(row => row.closes === 1), 'old successful prerequisite cover is released');
      next.close(); await h.pump(); await next.closed;
      await h.owner.dispose();
    } finally {
      released = true; delivery.resolve(stream.value); stream.gate.resolve();
      first.close(); next?.close(); await h.pump();
    }
  });
}

for (const target of ['private-cover', 'fixed-symbol']) {
  for (const cancelMode of ['reject', 'throw']) {
    for (const rejection of ['mime', 'late-after-close']) {
      test(`real ${target} ${cancelMode} cancellation quarantines every later lane across ${rejection}`, async t => {
        const h = await coordinatorFixture(t), delivery = N.deferred();
        const stream = response({mime: rejection === 'mime' ? 'text/html' : 'image/png',
          poisonHeaders: rejection === 'late-after-close', cancelMode});
        const targetUrl = target === 'private-cover' ? COVER : BRAND;
        let targetCall = null;
        h.network.respond(call => {
          assert.ok([COVER, BRAND].includes(call.url));
          if (call.url === targetUrl && targetCall === null) {targetCall = call; return delivery.promise;}
          if (target === 'fixed-symbol' && call.url === COVER && targetCall === null) {
            const success = response(); success.gate.resolve(); return Promise.resolve(success.value);
          }
          // Record any unlawful later request rather than hide it in a swallowed
          // assertion inside product code. The counters below must remain fixed.
          const stop = response({mime: 'text/html'}); stop.gate.resolve(); return Promise.resolve(stop.value);
        });
        const first = h.openReal(), firstClosed = tracked(first.closed);
        let next = null, terminal = null;
        try {
          await h.pump(); assert.ok(targetCall);
          const preparation = observeRealPreparation(h, target, targetCall);
          const before = {calls: h.network.calls.length, fonts: h.fontLoads.length, bitmaps: h.bitmapRecords.length,
            canvases: h.canvases.length, encodes: h.encodes.length, urls: h.urls.size, subscriptions: h.sourceSubscriptions.started,
            accesses: h.nativeAccesses.length, preparations: h.nativePreparations.length};
          if (rejection === 'mime') {delivery.resolve(stream.value); await C.settle();}
          first.close(); next = h.openReal();
          if (rejection === 'late-after-close') {delivery.resolve(stream.value); await C.settle();}
          assert.equal(stream.stats.cancels, 1);
          if (cancelMode === 'reject') {
            assertPreparationPending(preparation);
            assert.equal(firstClosed.settled, false, 'pending cancellation already retains the old lane');
            assert.equal(stream.stats.releases, 0); stream.gate.resolve();
          }
          await h.pump();
          assertCancellationAttempts(stream);
          if (rejection === 'late-after-close') assert.equal(stream.stats.headers, 0);
          const noNewWork = () => {
            assertPreparationOutcome(preparation, stream);
            assert.equal(firstClosed.settled, false, 'rejected physical cleanup is never a confirmed designer closure');
            assert.equal(h.network.calls.length, before.calls, 'failed cleanup grants no later network work');
            assert.equal(h.fontLoads.length, before.fonts, 'failed cleanup grants no later font work');
            assert.equal(h.bitmapRecords.length, before.bitmaps, 'failed cleanup grants no later resource decode');
            assert.equal(h.canvases.length, before.canvases); assert.equal(h.encodes.length, before.encodes);
            assert.equal(h.urls.size, before.urls, 'failed cleanup grants no preview or delivery URL');
            assert.equal(h.sourceSubscriptions.started, before.subscriptions, 'failed cleanup grants no later source owner');
            assert.equal(h.nativeAccesses.length, before.accesses, 'quarantine cannot create a replacement actual access');
            assert.equal(h.nativePreparations.length, before.preparations, 'quarantine cannot retry or replace the actual preparation');
            assert.equal(h.downloads.length, 0); assert.equal(h.preview(), null); assert.equal(h.accesses.length, 0);
          };
          noNewWork();
          assert.ok(['waiting', 'unavailable', 'closing'].includes(h.owner.read().phase), 'only nonworking quarantine/waiting presentation is allowed');
          // Replacing the waiting shell must not construct a fresh owner or
          // escape a quarantine held outside the native designer's DOM.
          next.close(); next = h.openReal(); await h.pump(); noNewWork();
          terminal = tracked(h.owner.dispose()); await h.pump();
          assert.equal(terminal.settled, false, 'terminal owner cannot report unknown body release as complete');
          noNewWork();
          assert.equal(h.state.listeners.size, 1, 'all designer subscriptions were attempted despite unknown body cleanup; only the separate probe access remains');
          assert.equal(h.fonts.listeners.length, 0, 'font listener cleanup is not skipped by unknown body release');
        } finally {
          delivery.resolve(stream.value); stream.gate.resolve(); first.close(); next?.close();
          h.owner.dispose(); await h.pump();
          // A deliberately unconfirmed cleanup stays pending. Do not await or
          // resolve it in teardown, or reinterpret a timeout as successful release.
        }
      });
    }
  }
}
