'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {read} = require('./search-native-fixtures/actual-runtime.cjs');
const {fixture, artistView, group, album, ARTIST, drain} = require('./artist-host-fixtures/actual-artist-runtime.cjs');

// Compose over the immutable native stage plus the five reviewed source fixes.
// All admission, presentation, mount, subscription and readiness implementations
// remain production implementations. Observers below forward their real calls;
// their recorded facts are asserted outside the bridge's swallowed callbacks.
const STAMP = 'a'.repeat(64);
const launch = () => ({context_ref: STAMP, artist_ref: ARTIST,
  descriptor: {version: 1, root_artist_id: '9223372036854775807', scope_mode: 'artist'}});
function payload() {
  const primary = group(ARTIST, [album(1)], {artist_loved_launch: launch()});
  return artistView({context_ref: STAMP, artist_loved_context_ref: STAMP,
    artist_groups: [primary], primary_artist_groups: [primary],
    artist_page: {artist_ref: ARTIST, active_page_mode: 'info', page_modes: ['gallery', 'info'],
      default_page_mode: 'gallery', artist_loved_launches: {artist: launch(), family: null}}});
}
const slot = h => h.header.querySelector('[data-artist-page-action-slot="loved"]');
const control = h => slot(h).querySelector('[data-gallery-bar-action="loved-tracks"]');
const host = h => h.document.getElementById('artist-page-root');
// Explicit repeated-ready delivery tests idempotence only. Positive settlement
// tests never invoke this helper: their notification comes from the real read.
const ready = h => h.context.dispatchEvent(new h.context.Event('albumhaven:artist-page-runtime-ready'));
function empty(h, originalSlot) {
  assert.equal(slot(h), originalSlot); assert.equal(control(h), null);
  assert.equal(originalSlot.children.length, 0); assert.equal(originalSlot.hidden, true);
}
function available(h, originalSlot) {
  assert.equal(slot(h), originalSlot); assert.ok(control(h));
  assert.equal(control(h).disabled, false); assert.equal(originalSlot.hidden, false);
  assert.equal(h.header.querySelectorAll('[data-gallery-bar-action="loved-tracks"]').length, 1);
}
function start(h, value = payload(), push = true) {
  const index = h.requests.length;
  const work = h.read(h.context.buildApiUrl(value), {}, push);
  assert.equal(h.requests.length, index + 1);
  return {index, work, value};
}
async function finish(h, pending, value = pending.value, status) {
  h.reply(pending.index, value, status);
  const outcome = await pending.work; await drain(); return outcome;
}
function replaceHost(h) {
  const old = host(h), next = h.document.createElement('section');
  old.removeAttribute('id'); next.id = 'artist-page-root'; next.hidden = true;
  h.scroll.insertBefore(next, old); return {old, next};
}
function replaceRuntime(h) {
  const old = h.runtime();
  const realm = vm.createContext({...h.context, window: h.context, state: h.state,
    virtualGrid: h.grid, mobilePageState: h.mobileState(), Set: vm.runInContext('Set', h.context)});
  vm.runInContext(read('music_app/static/js/runtime/artist-page-bridge.js'), realm,
    {filename: 'music_app/static/js/runtime/artist-page-bridge.js'});
  return {old, next: h.runtime()};
}
function observe(h) {
  const records = [], refreshes = [], events = [];
  let afterSubscribe = null, afterStop = null, duringRefresh = null, registeringHost = null;
  // This is the isolated VM realm's intrinsic, never the Node/ESM host Set.
  const setPrototype = vm.runInContext('Set.prototype', h.context);
  assert.notEqual(setPrototype, Set.prototype);
  const add = setPrototype.add, remove = setPrototype.delete;
  const elementPrototype = h.context.Element.prototype, listen = elementPrototype.addEventListener;
  const listenDescriptor = Object.getOwnPropertyDescriptor(elementPrototype, 'addEventListener');
  const sets = new Map();
  elementPrototype.addEventListener = function(type, callback, ...args) {
    const result = listen.call(this, type, callback, ...args);
    // Production mountArtistPage registers its host click immediately before
    // subscribing its named update callback. No other mount is selected.
    if (this === host(h) && type === 'click' && callback.name === 'click') registeringHost = this;
    return result;
  };
  setPrototype.add = function(value) {
    let owned = sets.get(this);
    if (!owned && registeringHost && typeof value === 'function' && value.name === 'update') {
      owned = {runtime: h.runtime(), callbacks: new Map()}; sets.set(this, owned);
    }
    const result = add.call(this, value); // Exact real value and return preserved.
    if (owned && typeof value === 'function' && !owned.callbacks.has(value)) {
      const record = {runtime: owned.runtime, host: registeringHost || host(h), callback: value, stops: 0,
        deliver: (...args) => value(...args)};
      owned.callbacks.set(value, record); records.push(record); registeringHost = null;
      afterSubscribe?.(record);
    }
    return result;
  };
  setPrototype.delete = function(value) {
    const result = remove.call(this, value); // Forward real removal, even after clear().
    const record = sets.get(this)?.callbacks.get(value);
    if (record) {record.stops++; events.push({kind: 'stop', record}); afterStop?.(record);}
    return result;
  };
  const originalRefresh = h.context.updateGalleryArtistLovedControl;
  h.context.updateGalleryArtistLovedControl = function(...args) {
    // Record the actual synchronous caller; do not invoke snapshot (which can
    // itself reconcile) or replace a callback just to classify notifications.
    const fromLoved = new Error().stack.includes('refreshLoved');
    const currentHost = host(h), runtime = h.runtime();
    const result = originalRefresh.apply(this, args);
    const row = {fromLoved, host: currentHost, runtime, button: control(h),
      pending: Boolean(h.state.ui.pendingViewTransition), busy: h.state.busy};
    refreshes.push(row); duringRefresh?.(row); return result;
  };
  return {records, refreshes, events,
    loved: () => records.filter(row => row.callback.name === 'refreshLoved'),
    onSubscribe: callback => {afterSubscribe = callback;},
    onStop: callback => {afterStop = callback;},
    onRefresh: callback => {duringRefresh = callback;},
    restore: () => {
      h.context.updateGalleryArtistLovedControl = originalRefresh;
      setPrototype.add = add; setPrototype.delete = remove;
      if (listenDescriptor) Object.defineProperty(elementPrototype, 'addEventListener', listenDescriptor);
      else delete elementPrototype.addEventListener;
    }};
}
async function mounted(t, options) {
  const h = fixture(t, options), observed = observe(h);
  try {await h.entry(); await h.admit(payload()); return {h, observed};}
  catch (error) {observed.restore(); throw error;}
}

test('actual successful held-to-parent settlement refreshes the actionable Loved control without a manual repaint', async t => {
  const h = fixture(t), observed = observe(h), originalSlot = slot(h);
  try {
    await h.entry(); empty(h, originalSlot);
    const pending = start(h); empty(h, originalSlot);
    const checkpoint = observed.refreshes.length;
    const outcome = await finish(h, pending);
    assert.equal(outcome.error, undefined); assert.equal(outcome.value, true);
    // Inspect DOM before snapshot(): snapshot itself can reconcile presentation.
    available(h, originalSlot);
    const notifications = observed.refreshes.slice(checkpoint).filter(row => row.fromLoved);
    assert.ok(notifications.some(row => row.button && !row.pending), 'real bridge notification repainted the settled control');
    assert.equal(h.runtime().snapshot().actionable, true);
    assert.equal(h.context.AlbumHavenPlaylistUI.canOpenArtistLoved(h.context.captureGalleryArtistLovedInput()), true);
  } finally {observed.restore();}
});

test('pending and failed first admission never gain Loved authority from repeated readiness', async t => {
  const h = fixture(t); await h.entry(); const originalSlot = slot(h), pending = start(h);
  for (let n = 0; n < 3; n++) ready(h);
  empty(h, originalSlot); assert.equal(h.context.captureGalleryArtistLovedInput(), null);
  const outcome = await finish(h, pending, {error: 'unavailable'}, 503);
  assert.ok(outcome.error || outcome.value === false);
  ready(h); empty(h, originalSlot); assert.equal(h.context.captureGalleryArtistLovedInput(), null);
});

test('replaced response cannot grant while its actual successor is still pending', async t => {
  const h = fixture(t); await h.entry(); const originalSlot = slot(h);
  const a = start(h), b = start(h, {...payload(), query: 'replacement'});
  const stale = await finish(h, a);
  assert.equal(stale.value, false); assert.equal(h.requests[b.index].settled, false);
  assert.equal(h.state.busy, true); empty(h, originalSlot);
  assert.equal(h.context.captureGalleryArtistLovedInput(), null);
  const current = await finish(h, b); assert.equal(current.error, undefined); assert.equal(current.value, true);
  available(h, originalSlot);
});

test('real rejected history commit cannot turn its provisional Artist response into a Loved action', async t => {
  const h = fixture(t); await h.entry(); const originalSlot = slot(h);
  const push = h.history.pushState, failure = new Error('native history failure');
  h.history.pushState = () => {throw failure;};
  try {
    const outcome = await finish(h, start(h));
    assert.ok(outcome.error || outcome.value === false);
    empty(h, originalSlot); assert.equal(h.context.captureGalleryArtistLovedInput(), null);
    ready(h); empty(h, originalSlot);
  } finally {h.history.pushState = push;}
});

test('repeated ready is idempotent for the exact live host and runtime subscriptions', async t => {
  const {h, observed} = await mounted(t);
  try {
    const originalSlot = slot(h), button = control(h), lease = h.grid._artistPageLease;
    assert.equal(observed.records.length, 2); assert.equal(observed.loved().length, 1);
    const callbacks = observed.records.slice();
    for (let n = 0; n < 8; n++) ready(h);
    assert.deepEqual(observed.records, callbacks); assert.ok(callbacks.every(row => row.stops === 0));
    assert.equal(control(h), button); available(h, originalSlot); assert.equal(h.grid._artistPageLease, lease);
    assert.equal(host(h).querySelectorAll('.artist-page__sections').length, 1);
  } finally {observed.restore();}
});

for (const kind of ['host', 'runtime']) {
  test(`${kind} replacement unsubscribes the old Loved owner before native mount disposal and ignores late callbacks`, async t => {
    const {h, observed} = await mounted(t);
    try {
      const originalSlot = slot(h), previous = observed.records.slice(), loved = observed.loved()[0];
      if (kind === 'host') {replaceHost(h); ready(h);}
      else {
        const replacement = replaceRuntime(h); assert.notEqual(replacement.next, replacement.old);
        // The actual bridge emits ready during construction; the original
        // observer records retirement of A and the genuine B subscriptions.
        await h.admit(payload());
      }
      await drain();
      assert.ok(previous.every(row => row.stops === 1));
      assert.equal(observed.events[0].record, loved, 'outer refresh unsubscribed before mounted native consumer');
      const checkpoint = observed.refreshes.length, button = control(h), currentHost = host(h), lease = h.grid._artistPageLease;
      for (const row of previous) row.deliver();
      assert.equal(observed.refreshes.length, checkpoint, 'retired callbacks did not invoke outer repaint');
      assert.equal(control(h), button); assert.equal(host(h), currentHost); assert.equal(h.grid._artistPageLease, lease);
      available(h, originalSlot); assert.equal(currentHost.contains(h.nodes.viewport), true);
    } finally {observed.restore();}
  });
}

for (const phase of ['mount', 'subscription']) {
  test(`reentrant ${phase} acquisition releases stale genuine subscriptions and preserves its successor`, async t => {
    const h = fixture(t), observed = observe(h), originalSlot = slot(h);
    let entered = false, successor = null;
    observed.onSubscribe(row => {
      const target = phase === 'mount' ? row.callback.name === 'update' : row.callback.name === 'refreshLoved';
      if (!entered && target) {
        entered = true; successor = replaceHost(h).next; ready(h);
      }
    });
    try {
      await h.entry(); observed.onSubscribe(null); await h.admit(payload());
      assert.equal(entered, true); assert.equal(host(h), successor);
      const obsolete = observed.records.filter(row => row.host !== successor);
      const current = observed.records.filter(row => row.host === successor);
      assert.ok(obsolete.length > 0); assert.ok(obsolete.every(row => row.stops === 1));
      assert.equal(current.length, 2); assert.ok(current.every(row => row.stops === 0));
      const checkpoint = observed.refreshes.length, button = control(h), lease = h.grid._artistPageLease;
      for (const row of obsolete) row.deliver();
      assert.equal(observed.refreshes.length, checkpoint); assert.equal(control(h), button);
      assert.equal(h.grid._artistPageLease, lease); available(h, originalSlot);
      assert.equal(successor.contains(h.nodes.viewport), true);
      assert.equal(successor.querySelectorAll('.artist-page__sections').length, 1);
    } finally {observed.onSubscribe(null); observed.restore();}
  });
}

test('synchronous refresh callback reentry is bounded and cannot repaint after a host successor wins', async t => {
  const {h, observed} = await mounted(t);
  try {
    const previous = observed.loved()[0], originalSlot = slot(h);
    let entered = false, nestedRefreshes = null, successor = null;
    observed.onRefresh(row => {
      if (entered || !row.fromLoved || row.host !== previous.host) return;
      entered = true;
      const checkpoint = observed.refreshes.length;
      previous.deliver(); // Same genuine callback while its refresh is running.
      nestedRefreshes = observed.refreshes.length - checkpoint;
      successor = replaceHost(h).next; ready(h);
    });
    previous.deliver(); observed.onRefresh(null);
    assert.equal(entered, true); assert.equal(nestedRefreshes, 0);
    assert.equal(previous.stops, 1); assert.equal(host(h), successor);
    const checkpoint = observed.refreshes.length, button = control(h);
    previous.deliver(); assert.equal(observed.refreshes.length, checkpoint); assert.equal(control(h), button);
    available(h, originalSlot); assert.equal(successor.contains(h.nodes.viewport), true);
    assert.equal(successor.querySelectorAll('.artist-page__sections').length, 1);
  } finally {observed.onRefresh(null); observed.restore();}
});

test('synchronous notification during the real subscription acquisition is safe and repeated ready cannot duplicate it', async t => {
  const {h, observed} = await mounted(t);
  try {
    const originalSlot = slot(h), before = observed.records.length;
    let delivered = 0;
    observed.onSubscribe(row => {
      if (row.callback.name !== 'refreshLoved') return;
      delivered++; row.deliver(); ready(h);
    });
    replaceHost(h); ready(h); observed.onSubscribe(null);
    assert.equal(delivered, 1); assert.equal(observed.records.length, before + 2);
    assert.ok(observed.records.slice(before).every(row => row.stops === 0));
    available(h, originalSlot); assert.equal(host(h).contains(h.nodes.viewport), true);
    assert.equal(host(h).querySelectorAll('.artist-page__sections').length, 1);
  } finally {observed.onSubscribe(null); observed.restore();}
});

test('successor acquired during old unsubscribe survives the outer predecessor disposal', async t => {
  const {h, observed} = await mounted(t);
  try {
    const originalSlot = slot(h), previous = observed.records.slice(), loved = observed.loved()[0];
    let successor = null;
    observed.onStop(row => {
      if (row !== loved || successor) return;
      successor = replaceHost(h).next; ready(h);
    });
    const obsolete = replaceHost(h).next; ready(h); observed.onStop(null);
    assert.ok(successor); assert.equal(host(h), successor);
    assert.ok(previous.every(row => row.stops === 1));
    assert.equal(obsolete.querySelector('.artist-page__sections'), null);
    assert.equal(successor.querySelectorAll('.artist-page__sections').length, 1);
    assert.equal(successor.contains(h.nodes.viewport), true); available(h, originalSlot);
    const checkpoint = observed.refreshes.length, button = control(h), lease = h.grid._artistPageLease;
    for (const row of previous) row.deliver();
    assert.equal(observed.refreshes.length, checkpoint); assert.equal(control(h), button);
    assert.equal(h.grid._artistPageLease, lease);
  } finally {observed.onStop(null); observed.restore();}
});

test('throwing old unsubscribe still releases the native mount and permits a clean subsequent owner', async t => {
  const {h, observed} = await mounted(t);
  try {
    const previous = observed.records.slice(), loved = observed.loved()[0], failure = new Error('cleanup boundary');
    observed.onStop(row => {if (row === loved) throw failure;});
    const {next} = replaceHost(h);
    assert.throws(() => ready(h), error => error === failure);
    observed.onStop(null);
    assert.ok(previous.every(row => row.stops === 1), 'native dispose ran in finally despite unsubscribe error');
    ready(h); await h.admit(payload());
    assert.equal(host(h), next); assert.equal(next.contains(h.nodes.viewport), true);
    assert.equal(next.querySelectorAll('.artist-page__sections').length, 1);
    const checkpoint = observed.refreshes.length, button = control(h);
    for (const row of previous) row.deliver();
    assert.equal(observed.refreshes.length, checkpoint); assert.equal(control(h), button);
    assert.ok(previous.every(row => row.stops === 1), 'cleanup is not repeated');
  } finally {observed.onStop(null); observed.restore();}
});

test('initial Loved refresh failure cleans both subscriptions before a later legitimate ready mount', async t => {
  const h = fixture(t), observed = observe(h), failure = new Error('initial refresh boundary');
  let injected = false;
  observed.onRefresh(() => {if (!injected && observed.loved().length === 1) {injected = true; throw failure;}});
  try {
    await assert.rejects(h.entry(), error => error === failure);
    assert.equal(injected, true); assert.equal(observed.records.length, 2);
    const previous = observed.records.slice(); assert.ok(previous.every(row => row.stops === 1));
    observed.onRefresh(null); ready(h); await h.admit(payload());
    assert.equal(observed.records.length, 4);
    assert.equal(host(h).querySelectorAll('.artist-page__sections').length, 1);
    available(h, slot(h));
    const checkpoint = observed.refreshes.length;
    for (const row of previous) row.deliver();
    assert.equal(observed.refreshes.length, checkpoint);
  } finally {observed.onRefresh(null); observed.restore();}
});

for (const loss of ['scope', 'child', 'fresh-response-without-launch']) {
  test(`actual ${loss} authority loss removes the Loved control and preserves its permanent slot`, async t => {
    const {h, observed} = await mounted(t, {mobile: true});
    try {
      const originalSlot = slot(h), detached = control(h), input = h.context.captureGalleryArtistLovedInput();
      available(h, originalSlot); assert.ok(input);
      if (loss === 'scope') h.change('actor', '8');
      else if (loss === 'child') h.openForm();
      else await h.admit(artistView({context_ref: STAMP}), {push: false});
      await drain(); empty(h, originalSlot);
      assert.equal(input.launchContext.isCurrent(), false); assert.equal(detached.isConnected, false);
      assert.equal(h.context.captureGalleryArtistLovedInput(), null);
      const captures = [];
      h.context.AlbumHavenPlaylistUI.configureProviders({beginArtistLoved: options => {captures.push(options); throw new Error('stale activation');}});
      h.context.handleGalleryMainClick({target: detached, preventDefault() {}, stopPropagation() {}});
      await drain(); assert.equal(captures.length, 0);
      assert.equal(h.document.querySelectorAll('[data-artist-page-action-slot="loved"]').length, 1);
      assert.equal(h.document.querySelectorAll('#albums-scroll').length, 1);
      assert.equal(h.document.querySelectorAll('#albums-viewport').length, 1);
    } finally {observed.restore();}
  });
}
