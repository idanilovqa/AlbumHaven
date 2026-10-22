'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {fixture, emit, firstCallback, assertGlow} = require('./gallery-presentation-owner-fixture.cjs');

test('same viewport with a different glow retires the old visible node', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  const old = f.focus(h);
  emit(a.cover, 'pointerover'); f.flushFrames(); assertGlow(h.glow, 70, 70);
  const glow = f.document.createElement(); h.viewport.append(glow);
  f.focus({...h, glow});
  assert.equal(h.glow.hidden, true);
  assert.equal(h.glow.classList.contains('is-visible'), false);
  emit(a.cover, 'focusin'); f.flushFrames(); assertGlow(glow, 70, 70);
  const writes = glow.mutations.length;
  old.dispose();
  assert.equal(glow.mutations.length, writes);
  assert.equal(h.viewport.listenerCount('pointerover'), 1);
});

test('moving a glow to another viewport transfers its lease before stale cleanup', t => {
  const f = fixture(t), left = f.host(), right = f.host();
  const a = f.card(left.viewport), b = f.card(right.viewport, {left: 300});
  const old = f.focus(left), oldResize = f.observers[0].callback;
  emit(a.cover, 'pointerover');
  const staleFrame = firstCallback(f.frames);
  f.flushFrames(); emit(a.cover, 'pointerout', null);
  const staleHide = firstCallback(f.timers);
  right.viewport.append(left.glow);
  f.focus({...right, glow: left.glow});
  emit(b.cover, 'focusin'); f.flushFrames(); assertGlow(left.glow, 350, 70);
  const writes = left.glow.mutations.length;
  old.dispose(); staleFrame(); staleHide(); oldResize();
  assert.equal(left.glow.mutations.length, writes);
  assert.equal(left.viewport.listenerCount('pointerover'), 0);
  assert.equal(right.viewport.listenerCount('pointerover'), 1);
  assert.equal(f.observers[0].disconnected, true);
});

test('resource pointer events coalesce to the latest local card using shared cover metrics', t => {
  const f = fixture(t), h = f.host();
  const a = f.card(h.viewport), b = f.card(h.viewport, {left: 160, top: 90, width: 120, height: 100});
  f.focus(h);
  assert.equal(h.glow.hidden, true);
  emit(a.cover, 'pointerover'); emit(a.cover, 'pointerover'); emit(b.cover, 'pointerover');
  assert.equal(f.frames.size, 1);
  f.flushFrames();
  assertGlow(h.glow, 220, 140);
  assert.equal(f.idReads.length, 0);
  assert.equal(f.frames.size, 0);
  const writes = h.glow.mutations.length;
  emit(b.cover, 'pointerover'); emit(b.text, 'pointerover');
  assert.equal(f.frames.size, 0, 'repeated hover within the focused card is idle');
  assert.equal(h.glow.mutations.length, writes);
});

test('focus transitions preserve the glow inside a card and cancel an interrupted hide on reentry', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport), b = f.card(h.viewport, {left: 200});
  f.focus(h);
  emit(a.cover, 'focusin'); f.flushFrames(); assertGlow(h.glow, 70, 70);
  emit(a.cover, 'focusout', a.text); f.flushFrames();
  assertGlow(h.glow, 70, 70);
  assert.equal(f.timers.size, 0);
  emit(a.text, 'focusout', null);
  assert.equal(h.glow.classList.contains('is-visible'), false);
  assert.equal(h.glow.hidden, false, 'fade completes only after its timer');
  assert.equal(f.timers.values().next().value.delay, 260);
  emit(b.cover, 'focusin');
  assert.equal(f.timers.size, 0);
  f.flushFrames(); assertGlow(h.glow, 250, 70);
  emit(b.cover, 'focusout', null); f.flushTimers();
  assert.equal(h.glow.hidden, true);
});

test('pointer transitions to another local card keep the glow, while leaving the host fades it', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport), b = f.card(h.viewport, {top: 200});
  f.focus(h);
  emit(a.cover, 'pointerover'); f.flushFrames();
  emit(a.cover, 'pointerout', b.cover); f.flushFrames(); assertGlow(h.glow, 70, 240);
  assert.equal(f.timers.size, 0);
  emit(b.cover, 'pointerout', f.body);
  assert.equal(h.glow.classList.contains('is-visible'), false);
  f.flushTimers(); assert.equal(h.glow.hidden, true);
});

test('scroll, window resize, and ResizeObserver refresh only local active-card geometry', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  f.focus(h);
  emit(a.cover, 'pointerover'); f.flushFrames();
  a.card.offsetLeft = 100; a.card.offsetTop = 160; a.cover.offsetWidth = 160;
  emit(h.scroll, 'scroll'); emit(f.window, 'resize'); f.observers[0].callback();
  assert.equal(f.frames.size, 1);
  f.flushFrames(); assertGlow(h.glow, 180, 200);
  assert.deepEqual([...f.observers[0].targets], [h.viewport]);
  a.cover.remove();
  a.card.offsetWidth = 240; a.card.offsetHeight = 120;
  emit(f.window, 'resize'); f.flushFrames(); assertGlow(h.glow, 220, 220);
});

test('two resources keep independent glows, listeners, frames, and delayed hides', t => {
  const f = fixture(t), left = f.host(), right = f.host();
  const a = f.card(left.viewport), b = f.card(right.viewport, {left: 300});
  const first = f.focus(left); f.focus(right);
  emit(a.cover, 'pointerover'); emit(b.cover, 'focusin'); f.flushFrames();
  assertGlow(left.glow, 70, 70); assertGlow(right.glow, 350, 70);
  emit(a.cover, 'pointerout', null);
  const staleHide = firstCallback(f.timers);
  b.card.offsetTop = 90; emit(right.scroll, 'scroll');
  first.dispose(); first.dispose(); staleHide(); f.flushFrames();
  assert.equal(left.glow.hidden, true);
  assertGlow(right.glow, 350, 130);
  assert.equal(left.viewport.listenerCount('pointerover'), 0);
  assert.equal(right.viewport.listenerCount('pointerover'), 1);
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.observers[1].disconnected, false);
  assert.equal(f.window.listenerCount('resize'), 1);
});

test('same-viewport replacement rejects old frames, delayed hides, and retained event callbacks', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  const old = f.focus(h), enter = [...h.viewport.listeners.get('pointerover')][0];
  emit(a.cover, 'pointerover');
  const staleFrame = firstCallback(f.frames);
  f.flushFrames(); emit(a.cover, 'pointerout', null);
  const staleHide = firstCallback(f.timers), oldResize = f.observers[0].callback;
  const next = f.focus(h);
  emit(a.cover, 'focusin'); f.flushFrames(); assertGlow(h.glow, 70, 70);
  const writes = h.glow.mutations.length;
  old.dispose(); old.dispose(); staleFrame(); staleHide(); oldResize(); enter({target: a.cover});
  assert.equal(h.glow.mutations.length, writes);
  assert.equal(h.viewport.listenerCount('pointerover'), 1);
  assert.equal(h.viewport.listenerCount('focusout'), 1);
  assert.equal(h.scroll.listenerCount('scroll'), 1);
  assert.equal(f.window.listenerCount('resize'), 1);
  a.card.offsetTop = 200; next.refresh(); f.flushFrames(); assertGlow(h.glow, 70, 240);
});

test('a revoked glow lease retires an interrupted frame before any positioning is applied', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  let current = true;
  f.focus(h, {isCurrent: () => current});
  emit(a.cover, 'pointerover'); const staleFrame = firstCallback(f.frames);
  current = false; f.flushFrames();
  assert.equal(h.glow.hidden, true);
  assert.equal(h.glow.style.left, undefined);
  assert.equal(h.viewport.listenerCount('pointerover'), 0);
  assert.equal(h.scroll.listenerCount('scroll'), 0);
  assert.equal(f.window.listenerCount('resize'), 0);
  assert.equal(f.observers[0].disconnected, true);
  const writes = h.glow.mutations.length;
  staleFrame(); f.observers[0].callback();
  assert.equal(h.glow.mutations.length, writes);
  assert.equal(f.frames.size, 0);
});

test('a revoked delayed hide disposes the owner and cannot touch a later successor', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  let current = true;
  f.focus(h, {isCurrent: () => current});
  emit(a.cover, 'pointerover'); f.flushFrames(); emit(a.cover, 'pointerout', null);
  const staleHide = firstCallback(f.timers);
  current = false; f.flushTimers();
  assert.equal(h.glow.hidden, true);
  assert.equal(h.viewport.listenerCount('focusin'), 0);
  f.focus(h); emit(a.cover, 'focusin'); f.flushFrames();
  const writes = h.glow.mutations.length;
  staleHide();
  assert.equal(h.glow.mutations.length, writes);
  assertGlow(h.glow, 70, 70);
});

test('glow rechecks lease ownership after measuring the cover', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  let current = true;
  f.focus(h, {isCurrent: () => current});
  Object.defineProperty(a.cover, 'offsetWidth', {get() { current = false; return 100; }});
  emit(a.cover, 'focusin'); f.flushFrames();
  assert.equal(h.glow.style.left, undefined);
  assert.equal(h.glow.hidden, true);
  assert.equal(f.observers[0].disconnected, true);
});

test('removed or moved cards cannot be positioned by an old viewport callback', t => {
  const f = fixture(t), left = f.host(), right = f.host(), a = f.card(left.viewport);
  f.focus(left); f.focus(right);
  emit(a.cover, 'pointerover');
  right.viewport.append(a.card); a.card.offsetParent = right.viewport;
  emit(a.cover, 'focusin'); f.flushFrames(); f.flushTimers();
  assert.equal(left.glow.hidden, true);
  assert.equal(left.glow.style.left, undefined);
  assertGlow(right.glow, 70, 70);
  a.card.remove(); emit(right.scroll, 'scroll'); f.flushFrames(); f.flushTimers();
  assert.equal(right.glow.hidden, true);
});

test('glow disposal cancels pending work and removes every installed listener once', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport), owner = f.focus(h);
  emit(a.cover, 'pointerover'); const staleFrame = firstCallback(f.frames);
  f.flushFrames(); emit(a.cover, 'pointerout', null); const staleHide = firstCallback(f.timers);
  owner.dispose(); owner.dispose();
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  for (const name of ['pointerover', 'pointerout', 'focusin', 'focusout']) assert.equal(h.viewport.listenerCount(name), 0);
  assert.equal(h.scroll.listenerCount('scroll'), 0); assert.equal(f.window.listenerCount('resize'), 0);
  const writes = h.glow.mutations.length;
  staleFrame(); staleHide(); owner.refresh(); emit(a.cover, 'pointerover');
  assert.equal(h.glow.mutations.length, writes);
  assert.equal(f.frames.size, 0);
});

test('disposing a glow before first paint cancels its frame and prevents a late paint', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport), owner = f.focus(h);
  emit(a.cover, 'pointerover'); const staleFrame = firstCallback(f.frames);
  owner.dispose();
  assert.equal(f.frames.size, 0);
  const writes = h.glow.mutations.length;
  staleFrame();
  assert.equal(h.glow.mutations.length, writes);
  assert.equal(h.glow.hidden, true);
  assert.equal(h.glow.style.left, undefined);
});

test('glow remains usable without ResizeObserver through window and scroll refreshes', t => {
  const f = fixture(t, {resizeObserver: false}), h = f.host(), a = f.card(h.viewport);
  f.focus(h); emit(a.cover, 'focusin'); f.flushFrames(); assertGlow(h.glow, 70, 70);
  a.card.offsetLeft = 60; emit(f.window, 'resize'); f.flushFrames(); assertGlow(h.glow, 110, 70);
  a.card.offsetTop = 60; emit(h.scroll, 'scroll'); f.flushFrames(); assertGlow(h.glow, 110, 100);
});

test('glow rejects incoherent hosts and installs no listeners for an already-revoked lease', t => {
  const f = fixture(t), h = f.host(), other = f.host();
  assert.throws(() => f.focus({...h, glow: other.glow}), /scoped native Gallery glow host/);
  assert.throws(() => f.focus({...h, scroll: other.scroll}), /scoped native Gallery glow host/);
  assert.throws(() => f.focus(h, {isCurrent: null}), /scoped native Gallery glow host/);
  f.focus(h, {isCurrent: () => false});
  assert.equal(h.viewport.listenerCount('pointerover'), 0);
  assert.equal(h.scroll.listenerCount('scroll'), 0);
  assert.equal(f.window.listenerCount('resize'), 0);
  assert.equal(f.frames.size, 0);
});

test('Artist wrappers retain their default elements, state, force-refresh, and delayed hide', t => {
  const f = fixture(t, {artist: true}), artist = f.host(), resource = f.host();
  const a = f.card(artist.viewport), b = f.card(resource.viewport, {left: 300});
  f.ids.set('gallery-focus-glow', artist.glow);
  f.ids.set('albums-viewport', artist.viewport);
  f.ids.set('albums-scroll', artist.scroll);
  f.context.scheduleGalleryFocusGlow(a.card); f.flushFrames();
  assertGlow(artist.glow, 70, 70);
  assert.equal(f.gallery.focusedAlbumGlowCard, a.card);
  assert.equal(f.gallery.focusGlowKey, '70:70:100:80:600:400');
  assert.equal(f.gallery.focusGlowVisible, true);
  f.context.scheduleGalleryFocusGlow(a.card);
  assert.equal(f.frames.size, 0, 'the same Artist card keeps the existing no-op default');
  a.card.offsetLeft = 100;
  f.context.scheduleGalleryFocusGlow(a.card, {force: true}); f.flushFrames(); assertGlow(artist.glow, 150, 70);
  const before = {...f.gallery}, reads = f.idReads.length;
  const scoped = f.focus(resource); emit(b.cover, 'pointerover'); f.flushFrames(); assertGlow(resource.glow, 350, 70);
  assert.deepEqual(f.gallery, before);
  assert.equal(f.idReads.length, reads, 'the resource does not resolve Artist DOM IDs');
  scoped.dispose(); assertGlow(artist.glow, 150, 70);
  f.context.hideGalleryFocusGlow();
  assert.equal(artist.glow.classList.contains('is-visible'), false);
  assert.equal(f.gallery.focusedAlbumGlowCard, null);
  assert.equal(f.gallery.focusGlowKey, '');
  assert.equal(f.gallery.focusGlowVisible, false);
  assert.equal(f.timers.values().next().value.delay, 260);
  f.flushTimers(); assert.equal(artist.glow.hidden, true);
});
