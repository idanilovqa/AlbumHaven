'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
let createAlbumTopImageRenderer, projectAlbumTopImage;
test.before(async () => {
  const base = path.join(ROOT, 'music_app/static/js/album-tops');
  ({createAlbumTopImageRenderer} = await import(pathToFileURL(path.join(base, 'image-export-renderer.mjs')).href));
  ({projectAlbumTopImage} = await import(pathToFileURL(path.join(base, 'image-export-layout.mjs')).href));
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const png = () => new Blob(['synthetic unit-port output'], {type: 'image/png'});
function model(sourceKey) {
  const result = projectAlbumTopImage({binding: {scopeKey: 'actor/library/context', topRef: 'top', revision: '1', sourceKey},
    complete: true, total: 2, title: 'Top', description: '', attribution: 'Credit',
    items: [0, 1].map(i => ({item_ref: `member-${i}`, album_ref: `album-${i}`, title: `Album ${i}`, artist: '', year: null}))});
  assert.equal(result.status, 'ready'); return result.model;
}
function fixture(throwLater, ports = {}) {
  const h = {frames: new Map(), handles: [], inputs: [], surfaces: [], states: [], events: [], closed: false, reopen: 0};
  let token = 0, retiring = false, releaseOrdinal = 0;
  const metrics = text => ({width: text.length * 8, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 8,
    actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2});
  h.renderer = createAlbumTopImageRenderer({
    isCurrent() {return ports.isCurrent ? ports.isCurrent(h) : true;},
    onState(s) {h.states.push(s); if (ports.onState) ports.onState(h, s);},
    scheduleFrame(cb) {h.frames.set(++token, cb); return token;}, cancelFrame(t) {h.frames.delete(t);},
    createSurface() {
      const context = {measureText: metrics};
      for (const op of ['setTransform', 'clearRect', 'fillRect', 'save', 'restore', 'beginPath', 'rect', 'roundRect', 'clip', 'fill', 'drawImage', 'fillText']) context[op] = () => {};
      const s = {context, releases: 0, resize() {}, release() {s.releases++;}};
      h.surfaces.push(s); return s;
    },
    prepareResource() {
      const p = {blob: png(), width: 16, height: 16, releases: 0, release() {p.releases++;}};
      h.inputs.push(p); return Promise.resolve(p);
    },
    decodeResource(p) {
      const handle = {image: {}, width: p.width, height: p.height, releases: 0, release() {
        handle.releases++; assert.equal(handle.releases, 1, 'each returned handle released once');
        if (!retiring) return;
        const ordinal = ++releaseOrdinal; h.events.push(`release-${ordinal}`);
        if (ordinal === 1) {
          h.barrier = h.renderer.dispose(); assert.equal(h.barrier, h.renderer.dispose());
          h.barrier.then(() => {h.closed = true; h.reopen++; h.events.push('closed');});
        }
        // If dispose resolves reentrantly in the first release, its continuation
        // runs before later release-return markers. Correct closure runs after all.
        queueMicrotask(() => h.events.push(`returned-${ordinal}`));
        if (throwLater && ordinal === 2) throw Error('private unknown release');
      }};
      h.handles.push(handle); return Promise.resolve(handle);
    },
    encodePng() {return ports.encodePng ? ports.encodePng(h) : Promise.resolve(png());}
  });
  h.flush = async () => {for (let i = 0; i < 6; i++) {const callbacks = [...h.frames.values()]; h.frames.clear(); for (const cb of callbacks) cb(); await tick();}};
  h.retire = () => {retiring = true; h.renderer.replace(model('capture-b'), {fontGeneration: 'font-1'});};
  return h;
}
for (const throwLater of [false, true]) test(`reentrant dispose during cache retirement ${throwLater ? 'quarantines later unknown release' : 'waits for every release return'}`, async () => {
  const h = fixture(throwLater);
  h.renderer.replace(model('capture-a'), {fontGeneration: 'font-1'}); await h.flush();
  assert.equal(h.renderer.read().status, 'ready'); assert.equal(h.handles.length, 3);
  assert.ok(h.handles.every(x => x.releases === 0), 'all old cache handles retained before retirement');
  assert.ok(h.inputs.every(x => x.releases === 1)); assert.equal(h.surfaces[0].releases, 1);
  h.retire(); assert.ok(h.barrier instanceof Promise, 'first release reentered dispose');
  assert.equal(h.renderer.read().status, 'disposed'); assert.equal(h.renderer.dispose(), h.barrier);
  await h.flush();
  assert.deepEqual(h.handles.map(x => x.releases), [1, 1, 1], 'later failure never skips another handle');
  assert.equal(h.inputs.length, 3); assert.equal(h.surfaces.length, 1, 'retired replacement never gets a new owner/surface');
  assert.equal(h.renderer.currentBlob(h.renderer.read().generation), null);
  if (throwLater) {
    assert.equal(h.closed, false, 'unknown release keeps the original reentrant barrier permanently pending');
    assert.equal(h.reopen, 0); assert.equal(h.events.includes('closed'), false);
    await tick(); assert.equal(h.closed, false);
  } else {
    assert.equal(h.closed, true); assert.equal(h.reopen, 1);
    const closeIndex = h.events.indexOf('closed');
    for (const ordinal of [1, 2, 3]) assert.ok(h.events.indexOf(`returned-${ordinal}`) < closeIndex,
      `dispose continuation cannot precede release ${ordinal} returning`);
  }
  assert.equal(JSON.stringify(h.states).includes('private unknown release'), false);
});


test('Blob metadata reentry cannot publish an obsolete Blob under a replacement generation', async () => {
  let reads = 0, armed = false, reentered = false, latest = null, encodeCount = 0, h;
  const ready = [], replacement = png();
  class ReentrantBlob extends Blob {
    get size() {
      reads++;
      if (armed && !reentered) {
        reentered = true;
        latest = h.renderer.replace(model('capture-b'), {fontGeneration: 'font-1'});
      }
      return super.size;
    }
  }
  const candidate = new ReentrantBlob(['synthetic candidate'], {type: 'image/png'});
  h = fixture(false, {
    isCurrent() {
      // This is a real synchronous user callback. Arm only after candidate
      // admission inspected size, without requiring any fixed metadata-read count.
      if (reads > 0) armed = true;
      return true;
    },
    encodePng() {return Promise.resolve(++encodeCount === 1 ? candidate : replacement);},
    onState(h, s) {
      // Inspect every ready publication so a transient bad state cannot be hidden
      // by a later successful replacement render.
      if (s.status === 'ready') ready.push({generation: s.generation, binding: s.binding,
        blob: h.renderer.currentBlob(s.generation)});
    }
  });
  const initial = h.renderer.replace(model('capture-a'), {fontGeneration: 'font-1'});
  await h.flush(); assert.ok(reads > 0, 'candidate metadata was admitted');
  assert.equal(h.renderer.read().status, 'ready');
  assert.ok(ready.length > 0);
  for (const publication of ready) {
    if (publication.blob === candidate) {
      assert.equal(publication.generation, initial, 'old Blob may only belong to its original generation');
      assert.equal(publication.binding.sourceKey, 'capture-a');
    }
    if (publication.generation === latest) assert.equal(publication.blob, replacement,
      'replacement generation must never temporarily expose the old candidate');
  }
  if (reentered) {
    assert.ok(latest > initial); assert.equal(encodeCount, 2);
    assert.equal(h.renderer.read().generation, latest);
    assert.equal(h.renderer.currentBlob(latest), replacement);
    assert.equal(h.renderer.currentBlob(initial), null);
  } else {
    // A single metadata snapshot before the final currentness check is safe:
    // there is no later getter call to trigger the injected replacement.
    assert.equal(encodeCount, 1); assert.equal(h.renderer.read().generation, initial);
    assert.equal(h.renderer.currentBlob(initial), candidate);
  }
  let disposed = false; h.renderer.dispose().then(() => {disposed = true;}); await tick();
  assert.equal(disposed, true); assert.ok(h.handles.every(x => x.releases === 1));
});
