const test = require('node:test');
const assert = require('node:assert/strict');
const { createMetadataLifetimeRuntime } = require('./gallery-metadata-lifetime-harness.cjs');

function liveHandle(handle) {
  assert.equal(typeof handle?.update, 'function', 'sync returns the live update/dispose controller');
  assert.equal(typeof handle?.dispose, 'function', 'the returned controller owns retirement');
}

function activeMotion(h, card, observer = h.observers.at(-1)) {
  assert.equal(observer.nodes.size, 2, 'the owner observes both the metadata row and its text');
  assert.equal(observer.nodes.has(card.row) && observer.nodes.has(card.text), true);
  assert.equal(card.row.classList.contains('is-card-text-overflowing'), true);
  assert.equal(card.row.style.getPropertyValue('--card-text-distance'), '180px');
  assert.equal(card.row.style.getPropertyValue('--card-text-duration'), '6120ms');
  assert.equal(h.media.listeners.get('change').size, 1);
}

function retainedCallbacks(h) {
  return {
    observer: h.observers.at(-1),
    media: [...h.media.listeners.get('change')][0],
    frame: [...h.frameHistory.values()].at(-1),
    font: h.fontCallbacks.at(-1),
  };
}

function deliverRetired(callbacks) {
  callbacks.observer.deliver();
  callbacks.media({ matches: false });
  callbacks.frame(0);
  callbacks.font();
}

test('M01 live Gallery metadata motion returns one stable controller after overflow and reduced-motion controls', () => {
  const h = createMetadataLifetimeRuntime(), card = h.card();
  const first = h.context.syncGalleryCardMetadataMotion(card.root);
  h.flushFrame();
  activeMotion(h, card);
  h.reduce(true); h.flushFrame();
  assert.equal(card.row.classList.contains('is-card-text-overflowing'), false);
  assert.equal(card.row.style.getPropertyValue('--card-text-distance'), '0px');
  assert.equal(card.row.style.getPropertyValue('--card-text-duration'), '0ms');
  liveHandle(first); // Published baseline: undefined, after the active controls.
  assert.equal(h.context.syncGalleryCardMetadataMotion(card.root) === first, true, 'same root retains exact live controller');
  assert.equal(h.context.syncGalleryCardMetadataMotion(null) === first, true, 'unusable root retains exact live controller');
  assert.equal(h.observers.length, 1);
  assert.equal(h.snapshot().observes, 2, 'same text is not observed twice');
});

test('M02 narrow to desktop to narrow retires metadata resources and creates one distinct controller', () => {
  const h = createMetadataLifetimeRuntime(), card = h.card();
  const first = h.context.syncGalleryCardMetadataMotion(card.root);
  h.flushFrame(); activeMotion(h, card);
  h.observers[0].deliver();
  assert.equal(h.frames.size, 1, 'retirement has a real pending frame to cancel');
  h.setWidth(1200);
  const desktop = h.context.syncGalleryCardMetadataMotion(card.root);
  assert.equal(h.observers[0].nodes.size, 0);
  assert.equal(h.media.listeners.get('change').size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.snapshot().frameCancels, 1);
  assert.equal(card.row.classList.contains('is-card-text-overflowing'), false);
  assert.equal(desktop === null, true, 'desktop returns null after retirement');
  h.setWidth(600);
  const second = h.context.syncGalleryCardMetadataMotion(card.root);
  liveHandle(second);
  assert.equal(second === first, false, 'the retired controller is never reused');
  assert.equal(h.observers.length, 2);
  h.flushFrame(); activeMotion(h, card);
});

test('M03 disposed metadata controller rejects update and retained observer, media, RAF and font work on connected hidden rows', async () => {
  const h = createMetadataLifetimeRuntime(), card = h.card();
  const owner = h.context.syncGalleryCardMetadataMotion(card.root);
  h.flushFrame(); activeMotion(h, card);
  liveHandle(owner);
  h.observers[0].deliver();
  const callbacks = retainedCallbacks(h);
  card.root.hidden = true;
  assert.equal(card.row.isConnected, true, 'disposal cannot rely on a disconnected row');
  owner.dispose();
  assert.equal(callbacks.observer.nodes.size, 0);
  assert.equal(h.media.listeners.get('change').size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.snapshot().frameCancels, 1);
  assert.equal(card.row.classList.contains('is-card-text-overflowing'), false);
  const retired = h.snapshot();
  owner.update(card.root);
  deliverRetired(callbacks);
  await h.resolveFonts();
  h.flushFrame();
  owner.dispose();
  assert.deepEqual(h.snapshot(), retired, 'retired work performs no reads, writes, observations, scheduling or repeat cleanup');
  assert.equal(callbacks.observer.nodes.size, 0, 'disposed update cannot reacquire rows');
});

test('M04 a retired metadata controller cannot reset or mutate a sequential replacement', () => {
  const h = createMetadataLifetimeRuntime(), cardA = h.card(), cardB = h.card();
  const ownerA = h.context.syncGalleryCardMetadataMotion(cardA.root);
  h.flushFrame(); activeMotion(h, cardA);
  liveHandle(ownerA);
  const callbacksA = retainedCallbacks(h);
  ownerA.dispose(); cardA.root.hidden = true;
  const ownerB = h.context.syncGalleryCardMetadataMotion(cardB.root);
  liveHandle(ownerB);
  assert.equal(ownerA === ownerB, false, 'retire A before creating distinct live B');
  h.flushFrame(); activeMotion(h, cardB);
  const current = h.snapshot();
  ownerA.dispose(); ownerA.update(cardA.root); deliverRetired(callbacksA);
  h.flushFrame();
  assert.deepEqual(h.snapshot(), current, 'A has no effects after B takes ownership');
  assert.equal(callbacksA.observer.nodes.size, 0);
  assert.equal(h.context.syncGalleryCardMetadataMotion(cardB.root) === ownerB, true, 'late A retirement cannot clear B identity');
  assert.equal(h.observers.length, 2);
  h.flushFrame(); activeMotion(h, cardB);
});

test('G01 real VirtualArtistGrid activation starts metadata motion and destroy retires its resources', async () => {
  const h = createMetadataLifetimeRuntime({ grid: true }), grid = h.currentGrid(), card = h.container;
  grid.activateGalleryCoverImages();
  h.flushFrame(); activeMotion(h, card);
  h.observers[0].deliver();
  const callbacks = retainedCallbacks(h);
  assert.equal(h.frames.size, 1);
  card.root.hidden = true;
  grid.destroy();
  assert.equal(card.row.isConnected, true);
  assert.equal(callbacks.observer.nodes.size, 0, 'real grid destroy must disconnect its metadata observer');
  assert.equal(h.media.listeners.get('change').size, 0);
  assert.equal(h.frames.size, 0);
  assert.equal(h.snapshot().frameCancels, 1);
  assert.equal(card.row.classList.contains('is-card-text-overflowing'), false);
  const retired = h.snapshot();
  deliverRetired(callbacks); await h.resolveFonts(); h.flushFrame();
  assert.deepEqual(h.snapshot(), retired, 'grid retirement also makes queued component work inert');
});

test('G02 retired grid activation and repeated destroy cannot claim or dispose a sequential new grid owner', () => {
  const h = createMetadataLifetimeRuntime({ grid: true }), gridA = h.currentGrid(), cardA = h.card();
  gridA.activateGalleryCoverImages(cardA.root);
  h.flushFrame(); activeMotion(h, cardA);
  const callbacksA = retainedCallbacks(h);
  gridA.destroy(); cardA.root.hidden = true;
  assert.equal(callbacksA.observer.nodes.size, 0, 'A must retire before constructing replacement B');
  const gridB = h.createGrid(), cardB = h.container;
  gridB.activateGalleryCoverImages();
  h.flushFrame(); activeMotion(h, cardB);
  assert.equal(h.observers.length, 2, 'B owns one fresh metadata observer');
  const current = h.snapshot();
  gridA.activateGalleryCoverImages(cardA.root);
  gridA.destroy(); deliverRetired(callbacksA); h.flushFrame();
  assert.deepEqual(h.snapshot(), current, 'retired A neither reclaims rows nor repeats resource teardown');
  assert.equal(callbacksA.observer.nodes.size, 0);
  activeMotion(h, cardB);
  h.observers[1].deliver(); h.flushFrame(); activeMotion(h, cardB);
  gridB.destroy();
  assert.equal(h.observers[1].nodes.size, 0, 'B retains its own working teardown');
  assert.equal(h.media.listeners.get('change').size, 0);
});
