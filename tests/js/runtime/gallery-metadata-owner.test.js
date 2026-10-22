'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {fixture, firstCallback, assertMotion} = require('./gallery-presentation-owner-fixture.cjs');

test('resource metadata owns only its root and coalesces repeat update, resize, and font work', t => {
  const f = fixture(t), left = f.host(), right = f.host();
  const a = f.card(left.viewport), b = f.card(right.viewport, {textWidth: 250});
  const owner = f.metadata(left.viewport), observer = f.observers[0];
  owner.update(); owner.update(left.viewport); observer.callback(); f.fontReady[0]();
  assert.equal(f.frames.size, 1);
  assert.deepEqual([...observer.targets], [a.row, a.text]);
  f.flushFrames();
  assertMotion(a.row, 100, 4200);
  assert.equal(b.row.classList.contains('is-card-text-overflowing'), false);
  assert.equal(b.row.style['--card-text-distance'], undefined);
  assert.throws(() => owner.update(right.viewport), /cannot change its resource root/);
  assert.equal(f.idReads.length, 0);
});

test('scoped metadata stops on desktop and reduced motion then resumes from current dimensions', t => {
  const f = fixture(t, {mobile: false}), h = f.host(), a = f.card(h.viewport);
  const owner = f.metadata(h.viewport);
  f.flushFrames(); assertMotion(a.row, 0, 0);
  f.setMobile(true); owner.update(); f.flushFrames(); assertMotion(a.row, 100, 4200);
  f.setReduced(true); f.flushFrames(); assertMotion(a.row, 0, 0);
  a.text.scrollWidth = 101;
  f.setReduced(false); f.flushFrames(); assertMotion(a.row, 0, 0);
  a.text.scrollWidth = 320;
  f.observers[0].callback(); f.flushFrames(); assertMotion(a.row, 220, 7080);
});

test('metadata replacement observes the new text and releases the replaced text', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  const owner = f.metadata(h.viewport), observer = f.observers[0];
  f.flushFrames(); assertMotion(a.row, 100, 4200);
  const replacement = f.document.createElement();
  replacement.setAttribute('data-gallery-metadata-text', ''); replacement.scrollWidth = 130;
  a.text.remove(); a.row.append(replacement);
  owner.update(); f.flushFrames();
  assert.equal(observer.targets.has(a.text), false);
  assert.equal(observer.targets.has(replacement), true);
  assertMotion(a.row, 30, 3200);
});

test('removing metadata from a retained row retires its old measurements and animation', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  const owner = f.metadata(h.viewport), observer = f.observers[0];
  f.flushFrames();
  a.text.remove(); owner.update(); f.flushFrames();
  assert.equal(observer.targets.has(a.text), false, 'detached text must not remain observed');
  assert.equal(observer.targets.has(a.row), false, 'a row without metadata no longer belongs to the owner');
  assert.equal(a.row.classList.contains('is-card-text-overflowing'), false);
  const writes = a.row.mutations.length;
  observer.callback(); f.flushFrames();
  assert.equal(a.row.mutations.length, writes, 'retired text cannot keep repainting a connected row');
});

test('removing the metadata marker retires a still-connected text node', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  const owner = f.metadata(h.viewport);
  f.flushFrames();
  a.text.removeAttribute('data-gallery-metadata-text'); owner.update(); f.flushFrames();
  assert.equal(a.text.isConnected, true);
  assert.equal(f.observers[0].targets.size, 0);
  assert.equal(a.row.classList.contains('is-card-text-overflowing'), false);
});

test('moving a row to another resource releases it without the first owner repainting it', t => {
  const f = fixture(t), left = f.host(), right = f.host(), a = f.card(left.viewport);
  const old = f.metadata(left.viewport);
  f.flushFrames();
  right.viewport.append(a.card);
  a.text.scrollWidth = 140;
  f.metadata(right.viewport); f.flushFrames(); assertMotion(a.row, 40, 3200);
  const writes = a.row.mutations.length;
  old.update(); f.flushFrames();
  assert.equal(f.observers[0].targets.size, 0);
  assert.equal(a.row.mutations.length, writes, 'out-of-root rows are not mutated by their old owner');
  old.dispose(); assertMotion(a.row, 40, 3200);
});

test('direct disposal cannot clear animation from a row already owned by another root', t => {
  const f = fixture(t), left = f.host(), right = f.host(), a = f.card(left.viewport);
  const old = f.metadata(left.viewport);
  f.flushFrames();
  right.viewport.append(a.card); a.text.scrollWidth = 180;
  f.metadata(right.viewport); f.flushFrames();
  const writes = a.row.mutations.length;
  old.dispose();
  assert.equal(a.row.mutations.length, writes);
  assertMotion(a.row, 80, 3720);
});

test('detached cards are unobserved and never measured by subsequent metadata frames', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  const owner = f.metadata(h.viewport);
  f.flushFrames(); a.card.remove();
  Object.defineProperty(a.text, 'scrollWidth', {get() { assert.fail('detached metadata must not be measured'); }});
  owner.update(); f.flushFrames();
  assert.equal(f.observers[0].targets.size, 0);
});

test('revoked metadata cancels interrupted frames and makes queued resize/font/media callbacks inert', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  let current = true, disposals = 0;
  const owner = f.metadata(h.viewport, {isCurrent: () => current, onDispose: () => { disposals += 1; }});
  const staleFrame = firstCallback(f.frames), observer = f.observers[0], font = f.fontReady[0];
  const media = [...f.media.listeners.get('change')][0];
  current = false;
  f.flushFrames();
  assert.equal(disposals, 1);
  assert.equal(observer.disconnected, true);
  assert.equal(f.media.listenerCount('change'), 0);
  const writes = a.row.mutations.length;
  staleFrame(); observer.callback(); font(); media(); owner.update(); owner.dispose();
  assert.equal(a.row.mutations.length, writes);
  assert.equal(f.frames.size, 0);
  assert.equal(disposals, 1);
});

test('a same-root metadata successor survives stale frames and repeated predecessor disposal', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  const old = f.metadata(h.viewport), staleFrame = firstCallback(f.frames), oldObserver = f.observers[0];
  f.flushFrames();
  const successor = f.metadata(h.viewport);
  f.flushFrames(); assertMotion(a.row, 100, 4200);
  const writes = a.row.mutations.length;
  old.dispose(); old.dispose(); staleFrame(); oldObserver.callback();
  assert.equal(a.row.mutations.length, writes);
  assert.equal(oldObserver.disconnected, true);
  assert.equal(f.media.listenerCount('change'), 1);
  a.text.scrollWidth = 150; successor.update(); f.flushFrames(); assertMotion(a.row, 50, 3200);
});

test('disposing one metadata resource preserves another resource and its pending frame', t => {
  const f = fixture(t), left = f.host(), right = f.host();
  const a = f.card(left.viewport), b = f.card(right.viewport, {textWidth: 180});
  const old = f.metadata(left.viewport); f.metadata(right.viewport);
  old.dispose(); f.flushFrames();
  assert.equal(a.row.classList.contains('is-card-text-overflowing'), false);
  assertMotion(b.row, 80, 3720);
  assert.equal(f.observers[1].disconnected, false);
  assert.equal(f.media.listenerCount('change'), 1);
});

test('metadata rechecks its lease after a measurement before mutating the row', t => {
  const f = fixture(t), h = f.host(), a = f.card(h.viewport);
  let current = true;
  Object.defineProperty(a.text, 'scrollWidth', {get() { current = false; return 300; }});
  f.metadata(h.viewport, {isCurrent: () => current}); f.flushFrames();
  assert.equal(a.row.style['--card-text-distance'], undefined);
  assert.equal(a.row.classList.contains('is-card-text-overflowing'), false);
  assert.equal(f.observers[0].disconnected, true);
});

test('metadata validates foreign roots and gracefully reports unavailable ResizeObserver', t => {
  const f = fixture(t), foreign = f.host().viewport;
  foreign.ownerDocument = {};
  assert.throws(() => f.metadata(foreign), /native Gallery metadata root/);
  const unavailable = fixture(t, {resizeObserver: false}), h = unavailable.host();
  unavailable.card(h.viewport);
  assert.equal(unavailable.metadata(h.viewport), null);
  assert.equal(unavailable.frames.size, 0);
});

test('Artist metadata keeps its shared mobile singleton without taking over scoped owners', t => {
  const f = fixture(t, {artist: true}), first = f.host(), second = f.host(), resource = f.host();
  const a = f.card(first.viewport), b = f.card(second.viewport), c = f.card(resource.viewport);
  const artist = f.own(f.context.syncGalleryCardMetadataMotion(first.viewport));
  assert.equal(f.context.syncGalleryCardMetadataMotion(second.viewport), artist);
  const scoped = f.metadata(resource.viewport);
  f.flushFrames();
  [a.row, b.row, c.row].forEach(row => assertMotion(row, 100, 4200));
  f.setMobile(false);
  assert.equal(f.context.syncGalleryCardMetadataMotion(first.viewport), null);
  assert.equal(a.row.classList.contains('is-card-text-overflowing'), false);
  assert.equal(b.row.classList.contains('is-card-text-overflowing'), false);
  assert.equal(f.observers[1].disconnected, false);
  f.setMobile(true); scoped.update(); f.flushFrames(); assertMotion(c.row, 100, 4200);
  const nextArtist = f.own(f.context.syncGalleryCardMetadataMotion(first.viewport));
  assert.notEqual(nextArtist, artist);
});
