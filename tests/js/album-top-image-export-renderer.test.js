'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const ROOT = path.resolve(process.env.ALBUM_TOP_TEST_ROOT || path.join(__dirname, '../..'));
let createAlbumTopImageRenderer, projectAlbumTopImage, layoutAlbumTopImage;
test.before(async () => {
  const base = path.join(ROOT, 'music_app/static/js/album-tops');
  ({createAlbumTopImageRenderer} = await import(pathToFileURL(path.join(base, 'image-export-renderer.mjs')).href));
  ({projectAlbumTopImage, layoutAlbumTopImage} = await import(pathToFileURL(path.join(base, 'image-export-layout.mjs')).href));
});
// Synthetic accounting Blob, not a PNG decoder/header test or physical allocation claim.
class SizedBlob extends Blob {
  constructor(size = 9, type = 'image/png') {super(['synthetic'], {type}); this.reportedSize = size;}
  get size() {return this.reportedSize;}
}
const png = (size = 9, type = 'image/png') => new SizedBlob(size, type);
const BINDING = {scopeKey: 'actor/library/context', topRef: 'top', revision: '1', sourceKey: 'capture-a'};
const BARE = {showTitle: false, showInfo: false, showArtist: false, showAlbum: false, showYear: false, showNumber: false};
function source(count = 1, binding = BINDING) {
  return {binding: {...binding}, complete: true, total: count, title: 'Title', description: 'Info', attribution: 'Credit',
    items: Array.from({length: count}, (_, i) => ({item_ref: `item-${i}`, album_ref: `album-${i}`,
      title: `Album ${i}`, artist: `Artist ${i}`, year: 2001}))};
}
function model(count = 1, options = {}, binding = BINDING) {
  const r = projectAlbumTopImage(source(count, binding), options); assert.equal(r.status, 'ready'); return r.model;
}
function defer() {let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function turns(count = 3) {for (let i = 0; i < count; i++) await tick();}
const metric = text => ({width: Array.from(text).length * 8, actualBoundingBoxLeft: 3,
  actualBoundingBoxRight: Array.from(text).length * 8 + 2, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2});
const layoutMetric = text => {const m = metric(text); return {advance: m.width, left: -m.actualBoundingBoxLeft,
  right: m.actualBoundingBoxRight, ascent: 10, descent: 2};};
function harness(overrides = {}) {
  const h = {events: [], states: [], frames: new Map(), frameHistory: [], surfaces: [], prepared: [], handles: [], requests: [], encodes: [], current: true};
  let nextFrame = 0;
  h.preparedValue = (width = 320, height = 160, blob = png()) => {
    const p = {blob, width, height, releases: 0, release() {p.releases++; h.events.push(['input-release', p]);}};
    h.prepared.push(p); return p;
  };
  h.handleValue = p => {
    const x = {image: Object.freeze({id: h.handles.length}), width: p.width, height: p.height, releases: 0,
      release() {x.releases++; h.events.push(['handle-release', x]);}};
    h.handles.push(x); return x;
  };
  h.surfaceValue = () => {
    const trace = [], stack = []; let depth = 0, currentPath = [], clips = [];
    const defaults = {font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', direction: 'inherit',
      globalAlpha: 1, filter: 'none', globalCompositeOperation: 'source-over', fillStyle: '#000000',
      shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0};
    const state = {...defaults};
    const context = new Proxy({}, {
      get(_, key) {return key in methods ? methods[key] : state[key];},
      set(_, key, value) {state[key] = value; trace.push({op: 'set', key, value}); return true;}
    });
    const record = (op, args) => trace.push({op, args, state: {...state}, depth, path: [...currentPath], clips: [...clips]});
    const methods = {measureText(text) {record('measureText', [text]); return metric(text);},
      save() {record('save', []); stack.push({state: {...state}, clips: [...clips]}); depth++;},
      restore() {assert.ok(depth > 0, 'balanced restore'); const old = stack.pop(); for (const key of Object.keys(state)) delete state[key]; Object.assign(state, old.state); clips = old.clips; depth--; record('restore', []);}};
    for (const name of ['setTransform', 'clearRect', 'fillRect', 'beginPath', 'rect', 'roundRect', 'clip', 'fill', 'drawImage', 'fillText'])
      methods[name] = (...args) => record(name, args);
    methods.beginPath = () => {currentPath = []; record('beginPath', []);};
    for (const op of ['rect', 'roundRect']) methods[op] = (...args) => {currentPath.push({op, args}); record(op, args);};
    methods.clip = (...args) => {clips.push([...currentPath]); record('clip', args);};
    const s = {context, trace, methods, width: 1, height: 1, releases: 0,
      resize(width, height) {
        s.width = width; s.height = height;
        for (const key of Object.keys(state)) delete state[key]; Object.assign(state, defaults);
        stack.length = 0; depth = 0; currentPath = []; clips = [];
        record('resize', [width, height]); h.events.push(['resize', s, width, height]);
      },
      release() {s.releases++; h.events.push(['surface-release', s]);}};
    h.surfaces.push(s); return s;
  };
  const defaults = {
    isCurrent() {return h.current;}, onState(s) {h.states.push(s);},
    scheduleFrame(cb) {const token = ++nextFrame; h.frames.set(token, cb); h.frameHistory.push(cb); return token;},
    cancelFrame(token) {h.frames.delete(token); h.events.push(['cancel', token]);},
    createSurface() {h.events.push(['surface']); return h.surfaceValue();},
    prepareResource(request) {h.requests.push(request); h.events.push(['prepare', request]); return Promise.resolve(h.preparedValue());},
    decodeResource(p, options) {h.events.push(['decode', p, options]); return Promise.resolve(h.handleValue(p));},
    encodePng(s, options) {const blob = png(); h.encodes.push({s, options, blob}); h.events.push(['encode', s]); return Promise.resolve(blob);}
  };
  h.deps = {...defaults}; for (const [key, fn] of Object.entries(overrides)) h.deps[key] = (...args) => fn(h, ...args);
  h.renderer = createAlbumTopImageRenderer(h.deps);
  h.frame = () => {const callbacks = [...h.frames.values()]; h.frames.clear(); for (const cb of callbacks) cb();};
  h.flush = async () => {for (let i = 0; i < 6; i++) {h.frame(); await tick();}};
  h.start = async (m = model(), fontGeneration = 'font-1') => {const g = h.renderer.replace(m, {fontGeneration}); await h.flush(); return g;};
  return h;
}
function keys(x, expected) {assert.deepEqual(Object.keys(x).sort(), [...expected].sort());}
function state(h, status, error) {
  const s = h.renderer.read(); keys(s, ['status', 'generation', 'binding', 'fontGeneration', 'hasPrevious', 'canDownload', 'output', 'error']);
  assert.equal(s.status, status); if (error !== undefined) assert.equal(s.error, error);
  else if (['idle', 'pending', 'ready'].includes(status)) assert.equal(s.error, null); assert.equal(Object.isFrozen(s), true);
  if (s.binding) {keys(s.binding, Object.keys(BINDING)); assert.equal(Object.isFrozen(s.binding), true);}
  assert.equal(s.canDownload, status === 'ready');
  if (status === 'ready') {keys(s.output, ['width', 'height', 'bytes']); assert.equal(Object.isFrozen(s.output), true);}
  else assert.equal(s.output, null);
  return s;
}
async function closed(h) {
  const p = h.renderer.dispose(); assert.equal(p, h.renderer.dispose());
  let done = false; p.then(() => {done = true;}); await turns(); assert.equal(done, true, 'confirmed cleanup closes without waiting forever');
  for (const p of h.prepared) assert.equal(p.releases, 1);
  for (const x of h.handles) assert.equal(x.releases, 1);
  for (const s of h.surfaces) assert.equal(s.releases, 1);
}

test('exact API, idle immutable snapshot, synchronous generation invalidation and accepted Blob identity', async () => {
  const h = harness(); keys(h.renderer, ['replace', 'read', 'currentBlob', 'dispose']);
  assert.deepEqual(state(h, 'idle'), {status: 'idle', generation: 0, binding: null, fontGeneration: null, hasPrevious: false, canDownload: false, output: null, error: null});
  const m = model(), g = h.renderer.replace(m, {fontGeneration: 'font-1'});
  assert.equal(g, 1); const pending = state(h, 'pending'); assert.notEqual(pending.binding, m.binding);
  assert.equal(h.surfaces.length, 0); assert.equal(h.renderer.currentBlob(g), null);
  await h.flush(); const ready = state(h, 'ready'), layout = layoutAlbumTopImage(m, layoutMetric).layout;
  assert.deepEqual(ready.output, {width: layout.width, height: layout.height, bytes: 9});
  assert.equal(h.renderer.currentBlob(g), h.encodes[0].blob); assert.equal(h.renderer.currentBlob(g + 1), null);
  assert.equal(h.renderer.read(), ready); assert.equal(pending.status, 'pending');
  await closed(h); const terminal = state(h, 'disposed'); assert.equal(h.renderer.replace(m, {fontGeneration: 'f'}), null);
  assert.equal(h.renderer.currentBlob(g), null); assert.equal(h.renderer.read(), terminal);
});
test('all required dependency functions are checked before any work', () => {
  const h = harness(); for (const key of Object.keys(h.deps)) for (const bad of [undefined, null, 1])
    assert.throws(() => createAlbumTopImageRenderer({...h.deps, [key]: bad}), TypeError);
  assert.equal(h.events.length, 0);
});
for (const bad of ['', 'x'.repeat(257), 'x\u0000', '\ud800', 1, null]) test(`invalid font generation ${String(bad).length}`, () => {
  const h = harness(); h.renderer.replace(model(), {fontGeneration: bad}); const s = state(h, 'error', 'invalid_input');
  assert.equal(s.binding, null); assert.equal(s.fontGeneration, null); assert.equal(s.hasPrevious, false); assert.equal(h.frames.size, 0);
});
test('malformed replacement synchronously retires previous source eligibility without touching malicious getters', async () => {
  const h = harness(), g = await h.start(); let reads = 0;
  const invalid = Object.freeze({get binding() {reads++; throw Error('private-secret');}});
  const next = h.renderer.replace(invalid, {fontGeneration: 'font-1'});
  assert.equal(next, g + 1); const s = state(h, 'error', 'invalid_input'); assert.equal(reads, 0);
  assert.equal(s.binding, null); assert.equal(s.hasPrevious, false); assert.equal(h.renderer.currentBlob(g), null);
  await h.flush(); assert.equal(h.encodes.length, 1); await closed(h);
});
for (const count of [1, 7, 20, 37]) test(`ordered complete ${count} membership, canonical requests and no private display leakage`, async () => {
  const input = source(count); let reads = 0;
  for (const x of [input, ...input.items]) for (const key of ['path', 'artwork_url', 'peerRating', 'rating', 'tracks', 'duration', 'progress', 'availability'])
    Object.defineProperty(x, key, {enumerable: true, get() {reads++; throw Error('private-secret');}});
  const own = new Proxy({}, {get() {reads++; throw Error('private-secret');}});
  const m = projectAlbumTopImage(input, {}, own).model, h = harness(); await h.start(m); state(h, 'ready');
  assert.equal(reads, 0); assert.equal(h.requests.length, count + 1);
  assert.deepEqual(h.requests.map(r => [r.kind, r.itemRef, r.albumRef]), [...m.items.map(x => ['cover', x.itemRef, x.albumRef]), ['brand', null, null]]);
  for (const r of h.requests) {
    keys(r, ['binding', 'kind', 'itemRef', 'albumRef', 'maxEncodedBytes', 'maxWidth', 'maxHeight', 'signal']);
    assert.equal(Object.isFrozen(r), true); assert.equal(Object.isFrozen(r.binding), true); assert.deepEqual(r.binding, m.binding);
    assert.equal(r.maxEncodedBytes, 20971520); assert.equal(r.maxWidth, 2048); assert.equal(r.maxHeight, 2048);
    assert.ok(r.signal instanceof AbortSignal);
  }
  assert.equal(h.surfaces[0].trace.filter(x => x.op === 'drawImage').length, count + 1);
  assert.equal(JSON.stringify(h.states).includes('private-secret'), false); await closed(h);
});
for (const [count, options, error] of [[0, {}, 'empty_source'], [5000, {columns: 10, ...BARE}, 'side_limit'], [440, {columns: 10, ...BARE}, 'pixel_limit']])
  test(`layout ${error} is atomic before resources/full-size allocation`, async () => {
    const h = harness(); await h.start(model(count, options)); state(h, 'error', error);
    assert.equal(h.requests.length, 0); assert.equal(h.encodes.length, 0); assert.equal(h.events.some(x => x[0] === 'resize'), false); await closed(h);
  });
for (const rounded of [false, true]) test(`paint contains nonsquare artwork, restores clips, uses ink anchors and inset frames (${rounded})`, async () => {
  const options = {roundedCorners: rounded, frameWidth: rounded ? 12 : 1, backgroundColor: '#abcdef', textColor: '#123456', frameColor: '#fedcba'};
  const m = model(7, options), h = harness(); await h.start(m); state(h, 'ready');
  const l = layoutAlbumTopImage(m, layoutMetric).layout, trace = h.surfaces[0].trace;
  assert.deepEqual(h.events.filter(e => e[0] === 'resize').map(e => e.slice(2)), [[l.width, l.height]]);
  const resizeIndex = trace.findIndex(x => x.op === 'resize');
  const resetTransform = trace.findIndex((x, i) => i > resizeIndex && x.op === 'setTransform');
  assert.ok(resetTransform > resizeIndex); assert.deepEqual(trace[resetTransform].args, [1, 0, 0, 1, 0, 0]);
  const clear = trace.findIndex(x => x.op === 'clearRect'), background = trace.findIndex(x => x.op === 'fillRect');
  assert.ok(clear > resetTransform && background > clear); assert.deepEqual(trace[background].args, [0, 0, l.width, l.height]);
  assert.equal(trace[background].state.fillStyle, options.backgroundColor);
  const draws = trace.filter(x => x.op === 'drawImage');
  for (const [i, draw] of draws.entries()) {
    const box = i < l.items.length ? l.items[i].cover : l.branding;
    assert.deepEqual(draw.args, [h.handles[i].image, box.x, box.y + box.height / 4, box.width, box.height / 2]);
    assert.equal(draw.state.globalAlpha, 1); assert.equal(draw.state.filter, 'none'); assert.equal(draw.state.globalCompositeOperation, 'source-over');
    assert.equal(draw.state.shadowBlur, 0); assert.equal(draw.state.shadowOffsetX, 0); assert.equal(draw.state.shadowOffsetY, 0);
    if (i < l.items.length) {
      assert.ok(draw.depth > 0);
      const expected = {op: rounded ? 'roundRect' : 'rect', args: [box.x, box.y, box.width, box.height, ...(rounded ? [box.radius] : [])]};
      assert.deepEqual(draw.clips, [[expected]], 'cover has exactly its own active clip');
      const drawIndex = trace.indexOf(draw), clipIndex = trace.findIndex((x, j) => j < drawIndex && x.op === 'clip'
        && JSON.stringify(x.path) === JSON.stringify([expected]));
      assert.ok(clipIndex > resizeIndex && clipIndex < drawIndex, 'exact cover path clipped before drawing');
    } else {assert.equal(draw.depth, 0); assert.deepEqual(draw.clips, []);}
  }
  const texts = trace.filter(x => x.op === 'fillText'); assert.equal(texts.length, l.texts.length);
  assert.deepEqual(texts.map(x => x.args), l.texts.map(x => [x.text, x.baselineX, x.baseline]));
  for (const [i, x] of texts.entries()) {assert.equal(x.depth, 0); assert.deepEqual(x.clips, []); assert.equal(x.state.textAlign, 'left'); assert.equal(x.state.textBaseline, 'alphabetic');
    assert.equal(x.state.direction, 'ltr'); assert.equal(x.state.fillStyle, options.textColor);
    assert.ok(x.state.font.includes(String(l.texts[i].fontWeight))); assert.ok(x.state.font.includes(String(l.texts[i].fontSize))); assert.ok(x.state.font.includes(l.fontFamily));}
  assert.equal(trace.filter(x => x.op === 'fill' && x.args[0] === 'evenodd').length, 7);
  for (const item of l.items) {
    const c = item.cover, inner = [c.x + c.frameWidth, c.y + c.frameWidth, c.width - 2 * c.frameWidth, c.height - 2 * c.frameWidth];
    assert.ok(trace.some(x => x.op === (rounded ? 'roundRect' : 'rect') && JSON.stringify(x.args.slice(0, 4)) === JSON.stringify(inner)));
    const framePath = [
      {op: rounded ? 'roundRect' : 'rect', args: [c.x, c.y, c.width, c.height, ...(rounded ? [c.radius] : [])]},
      {op: rounded ? 'roundRect' : 'rect', args: [...inner, ...(rounded ? [Math.max(0, c.radius - c.frameWidth)] : [])]}
    ];
    const frameIndex = trace.findIndex(x => x.op === 'fill' && x.args[0] === 'evenodd'
      && JSON.stringify(x.path) === JSON.stringify(framePath));
    assert.ok(frameIndex >= 0, 'inset frame fills exact outer-minus-inner geometry and radii');
    assert.equal(trace[frameIndex].depth, 0); assert.deepEqual(trace[frameIndex].clips, []);
    assert.equal(trace[frameIndex].state.fillStyle, options.frameColor); assert.equal(trace[frameIndex].state.globalAlpha, 1);
    const coverIndex = trace.findIndex(x => x.op === 'drawImage' && x.args[0] === h.handles[item.number - 1].image);
    assert.ok(frameIndex > coverIndex, 'frame overlays cover');
    const badge = item.numberBadge;
    const badgeIndex = trace.findIndex(x => x.op === 'fillRect' && x.args[0] === badge.x && x.args[1] === badge.y);
    const numberIndex = trace.findIndex(x => x.op === 'fillText' && x.args[0] === String(item.number));
    assert.ok(badgeIndex >= 0 && numberIndex >= 0, 'badge and number both exist');
    assert.ok(frameIndex < badgeIndex && badgeIndex < numberIndex);
    assert.deepEqual(trace[badgeIndex].args, [badge.x, badge.y, badge.width, badge.height]);
    assert.equal(trace[badgeIndex].state.fillStyle, badge.color); assert.equal(trace[badgeIndex].state.globalAlpha, 1);
  }
  assert.ok(l.branding.y >= Math.max(...l.items.map(x => x.y + x.height)) + 24);
  await closed(h);
});

test('burst coalesces to one frame, same-binding edits reuse every decoded resource', async () => {
  const h = harness(); const a = h.renderer.replace(model(), {fontGeneration: 'font-1'});
  const b = h.renderer.replace(model(1, {frameWidth: 2}), {fontGeneration: 'font-1'});
  const c = h.renderer.replace(model(1, {frameWidth: 3}), {fontGeneration: 'font-1'});
  assert.deepEqual([a, b, c], [1, 2, 3]); assert.equal(h.frames.size, 1); await h.flush();
  assert.equal(h.encodes.length, 1); assert.equal(state(h, 'ready').generation, c);
  const old = h.renderer.currentBlob(c), g = h.renderer.replace(model(1, {frameWidth: 4}), {fontGeneration: 'font-1'});
  assert.equal(state(h, 'pending').hasPrevious, true); assert.equal(h.renderer.currentBlob(c), null);
  await h.flush(); assert.equal(h.requests.length, 2); assert.equal(h.handles.length, 2);
  assert.equal(h.encodes.length, 2); assert.notEqual(h.renderer.currentBlob(g), old); assert.equal(state(h, 'ready').hasPrevious, false); await closed(h);
});
test('noninterruptible encoding serializes A then only newest C, including synchronous validation', async () => {
  const pending = defer(); let n = 0;
  const h = harness({encodePng(h, s, options) {h.encodes.push({s, options}); return ++n === 1 ? pending.promise : Promise.resolve(png());}});
  const a = h.renderer.replace(model(), {fontGeneration: 'font-1'}); await h.flush(); assert.equal(h.encodes.length, 1);
  h.renderer.replace(model(1, {frameWidth: 2}), {fontGeneration: 'font-1'});
  const c = h.renderer.replace(model(1, {frameWidth: 3}), {fontGeneration: 'font-1'}); await h.flush();
  assert.equal(h.surfaces.length, 1); assert.equal(h.encodes.length, 1); assert.equal(h.surfaces[0].releases, 0);
  pending.resolve(png()); await h.flush(); assert.equal(h.encodes.length, 2); assert.equal(h.surfaces[0].releases, 1);
  assert.equal(state(h, 'ready').generation, c); assert.equal(h.states.some(s => s.status === 'ready' && s.generation === a), false); await closed(h);
});
for (const phase of ['prepare', 'decode', 'encode']) test(`source replacement during ${phase} holds lane until settlement and release`, async () => {
  const pending = defer(); let held = true, late;
  const overrides = phase === 'prepare' ? {prepareResource(h, r) {h.requests.push(r); if (held) {held = false; late = h.preparedValue(); return pending.promise;} return Promise.resolve(h.preparedValue());}}
    : phase === 'decode' ? {decodeResource(h, p, options) {h.events.push(['decode', p, options]); const x = h.handleValue(p); if (held) {held = false; late = x; return pending.promise;} return Promise.resolve(x);}}
      : {encodePng(h, s, options) {h.encodes.push({s, options}); if (held) {held = false; late = png(); return pending.promise;} return Promise.resolve(png());}};
  const h = harness(overrides); h.renderer.replace(model(), {fontGeneration: 'font-1'}); await h.flush();
  const before = [h.surfaces.length, h.requests.length, h.handles.length, h.encodes.length];
  const nextBinding = {...BINDING, sourceKey: 'capture-b'};
  const latest = h.renderer.replace(model(1, {}, nextBinding), {fontGeneration: 'font-1'});
  assert.equal(state(h, 'pending').hasPrevious, false); await h.flush();
  assert.deepEqual([h.surfaces.length, h.requests.length, h.handles.length, h.encodes.length], before);
  assert.equal(h.requests[0].signal.aborted, true); assert.equal(h.surfaces[0].releases, 0);
  pending.resolve(late); await h.flush(); assert.equal(state(h, 'ready').generation, latest);
  assert.deepEqual(h.renderer.read().binding, nextBinding); assert.equal(h.surfaces[0].releases, 1);
  if (phase !== 'encode') assert.equal(late.releases, 1);
  const oldRelease = h.events.findIndex(e => e[0] === 'surface-release');
  const nextPrepare = h.events.findIndex(e => e[0] === 'prepare' && e[1].binding.sourceKey === 'capture-b');
  // prepare override records requests separately; other phases record this event.
  if (phase !== 'prepare') assert.ok(nextPrepare > oldRelease);
  await closed(h);
});
test('font-generation retirement drops previous eligibility and decoded cache', async () => {
  const h = harness(); const old = await h.start(); const g = h.renderer.replace(model(), {fontGeneration: 'font-2'});
  const s = state(h, 'pending'); assert.equal(s.hasPrevious, false); assert.equal(h.renderer.currentBlob(old), null);
  await h.flush(); assert.equal(state(h, 'ready').generation, g); assert.equal(h.requests.length, 4);
  assert.equal(h.handles[0].releases, 1); assert.equal(h.handles[1].releases, 1); await closed(h);
});
test('latest ordinary failure retains only same-binding previous preview and never gives its Blob back', async () => {
  let fail = false; const h = harness({encodePng(h, s, options) {const blob = png(); h.encodes.push({s, options, blob}); return fail ? Promise.reject(Error('private-secret')) : Promise.resolve(blob);}});
  const old = await h.start(); fail = true; const next = h.renderer.replace(model(1, {frameWidth: 2}), {fontGeneration: 'font-1'});
  assert.equal(state(h, 'pending').hasPrevious, true); await h.flush();
  const s = state(h, 'error', 'encode_failed'); assert.equal(s.hasPrevious, true);
  assert.equal(h.renderer.currentBlob(old), null); assert.equal(h.renderer.currentBlob(next), null);
  assert.equal(JSON.stringify(h.states).includes('private-secret'), false); await closed(h);
});
for (const throws of [false, true]) test(`currentness ${throws ? 'throw' : 'false'} retires ready Blob synchronously`, async () => {
  let bad = false; const h = harness({isCurrent() {if (bad && throws) throw Error('private-secret'); return !bad;}});
  const g = await h.start(); bad = true; assert.equal(h.renderer.currentBlob(g), null);
  const s = state(h, 'error', 'source_retired'); assert.equal(s.hasPrevious, false); await closed(h);
});
test('currentness checked after prepare and decode, not only before task', async () => {
  for (const phase of ['prepare', 'decode']) {
    const h = harness(phase === 'prepare' ? {prepareResource(h, r) {h.requests.push(r); h.current = false; return Promise.resolve(h.preparedValue());}}
      : {decodeResource(h, p) {const result = h.handleValue(p); h.current = false; return Promise.resolve(result);}});
    await h.start(); state(h, 'error', 'source_retired'); assert.equal(h.encodes.length, 0);
    if (phase === 'prepare') assert.equal(h.handles.length, 0); await closed(h);
  }
});
test('onState ready sees exact Blob then reentrant replacement cannot be overwritten by outer publication', async () => {
  let reentered = false, received, latest;
  const h = harness({onState(h, s) {h.states.push(s); if (s.status === 'ready' && !reentered) {
    reentered = true; received = h.renderer.currentBlob(s.generation); latest = h.renderer.replace(model(1, {frameWidth: 12}), {fontGeneration: 'font-1'});
    assert.equal(h.renderer.read().generation, latest); assert.equal(h.renderer.currentBlob(s.generation), null);
  }}});
  await h.start(); assert.equal(received, h.encodes[0].blob); assert.equal(state(h, 'ready').generation, latest); assert.equal(h.encodes.length, 2); await closed(h);
});
test('onState pending reentrant replacement starts only latest desired model', async () => {
  let once = false; const h = harness({onState(h, s) {h.states.push(s); if (s.status === 'pending' && !once) {
    once = true; h.renderer.replace(model(7), {fontGeneration: 'font-1'});
  }}});
  await h.start(); assert.equal(state(h, 'ready').generation, 2); assert.equal(h.requests.length, 8); assert.equal(h.encodes.length, 1); await closed(h);
});
test('onState dispose is terminal; throw is contained, terminal and never recursively notified', async () => {
  for (const action of ['dispose', 'throw']) {
    let count = 0; const h = harness({onState(h, s) {h.states.push(s); count++; if (s.status === 'pending') {
      if (action === 'throw') throw Error('private-secret'); h.renderer.dispose();
    }}});
    assert.doesNotThrow(() => h.renderer.replace(model(), {fontGeneration: 'font-1'})); await h.flush(); state(h, 'disposed');
    assert.equal(h.requests.length, 0); assert.equal(h.surfaces.length, 0); if (action === 'throw') assert.equal(count, 1); await closed(h);
  }
});
for (const fault of ['sync', 'duplicate', 'schedule-throw', 'cancel-throw']) test(`scheduler ${fault} cannot start/restart unsafe work`, async () => {
  const h = harness(fault === 'sync' ? {scheduleFrame(h, cb) {cb(); return 1;}}
    : fault === 'schedule-throw' ? {scheduleFrame() {throw Error('private-secret');}}
      : fault === 'cancel-throw' ? {cancelFrame() {throw Error('private-secret');}} : {});
  h.renderer.replace(model(), {fontGeneration: 'font-1'});
  if (fault === 'duplicate') {const cb = h.frameHistory[0]; h.frame(); cb();}
  if (fault === 'cancel-throw') h.renderer.dispose();
  await h.flush(); state(h, 'disposed'); assert.equal(h.renderer.currentBlob(1), null);
});
test('cancelled queued callback is harmless and dispose Promise is stable', async () => {
  const h = harness(); h.renderer.replace(model(), {fontGeneration: 'font-1'}); const cb = h.frameHistory[0];
  const p = h.renderer.dispose(); assert.equal(p, h.renderer.dispose()); cb(); await h.flush(); state(h, 'disposed');
  assert.equal(h.requests.length, 0); assert.equal(h.surfaces.length, 0); await closed(h);
});

for (const phase of ['prepare', 'decode', 'encode']) test(`Cancel during ${phase} aborts now but closure waits for late resource settlement`, async () => {
  const pending = defer(); let late, replacementOwners = 0;
  const h = harness(phase === 'prepare' ? {prepareResource(h, r) {h.requests.push(r); late = h.preparedValue(); return pending.promise;}}
    : phase === 'decode' ? {decodeResource(h, p) {late = h.handleValue(p); return pending.promise;}}
      : {encodePng(h, s, options) {h.encodes.push({s, options}); late = png(); return pending.promise;}});
  h.renderer.replace(model(), {fontGeneration: 'font-1'}); await h.flush();
  const p = h.renderer.dispose(); assert.equal(p, h.renderer.dispose()); state(h, 'disposed');
  // This is the caller's required close/reopen barrier, not a second product owner.
  p.then(() => {replacementOwners++;}); await turns(); assert.equal(replacementOwners, 0);
  assert.equal(h.requests[0].signal.aborted, true); assert.equal(h.surfaces[0].releases, 0);
  pending.resolve(late); await turns(); assert.equal(replacementOwners, 1);
  assert.equal(h.surfaces[0].releases, 1); assert.equal(h.states.some(s => s.status === 'ready'), false); await closed(h);
});
test('uncooperative callback cannot release the lane or resolve disposal', async () => {
  const pending = defer(), h = harness({encodePng(h, s, options) {h.encodes.push({s, options}); return pending.promise;}});
  await h.start(); let done = false; h.renderer.dispose().then(() => {done = true;}); await turns();
  assert.equal(done, false); assert.equal(h.surfaces[0].releases, 0); assert.equal(h.renderer.replace(model(), {fontGeneration: 'font-1'}), null);
  // Intentionally unfulfilled injected Promise has no timers or external resources.
});
for (const phase of ['prepare', 'decode', 'surface']) test(`throwing ${phase} release attempts other cleanup and quarantines closure permanently`, async () => {
  const h = harness(phase === 'prepare' ? {prepareResource(h, r) {h.requests.push(r); const p = h.preparedValue(); p.release = () => {p.releases++; throw Error('private-secret');}; return Promise.resolve(p);}}
    : phase === 'decode' ? {decodeResource(h, p) {const x = h.handleValue(p); x.release = () => {x.releases++; throw Error('private-secret');}; return Promise.resolve(x);}}
      : {createSurface(h) {const s = h.surfaceValue(); s.release = () => {s.releases++; throw Error('private-secret');}; return s;}});
  await h.start(); const barrier = h.renderer.dispose(); let done = false; barrier.then(() => {done = true;}); await turns();
  assert.equal(done, false); state(h, 'disposed'); assert.equal(h.renderer.replace(model(), {fontGeneration: 'font-1'}), null);
  for (const p of h.prepared) assert.equal(p.releases, 1); for (const x of h.handles) assert.equal(x.releases, 1); for (const s of h.surfaces) assert.equal(s.releases, 1);
  assert.equal(JSON.stringify(h.states).includes('private-secret'), false); await turns(); assert.equal(done, false);
});
for (const kind of ['image', 'surface']) test(`visible ${kind} without release is not reported freed`, async () => {
  const h = harness(kind === 'image' ? {decodeResource(h, p) {return Promise.resolve({image: {}, width: p.width, height: p.height});}}
    : {createSurface(h) {const s = h.surfaceValue(); delete s.release; return s;}});
  await h.start(); assert.equal(h.renderer.currentBlob(1), null);
  let done = false; h.renderer.dispose().then(() => {done = true;}); await turns(); assert.equal(done, false);
  if (kind === 'image') {assert.equal(h.prepared[0].releases, 1); assert.equal(h.surfaces[0].releases, 1);}
});
for (const [name, transform] of [
  ['zero width', p => {p.width = 0;}], ['oversize width', p => {p.width = 2049;}],
  ['fraction height', p => {p.height = 1.5;}], ['coerced height', p => {p.height = '160';}],
  ['unknown width', p => {delete p.width;}], ['unsafe dimensions', p => {p.width = Number.MAX_SAFE_INTEGER;}],
  ['empty bytes', p => {p.blob = png(0);}], ['wrong MIME', p => {p.blob = png(9, 'image/jpeg');}],
  ['not Blob', p => {p.blob = {size: 9, type: 'image/png'};}], ['one byte over', p => {p.blob = png(20971521);}]
]) test(`prepared ${name} rejected before decode with one input release`, async () => {
  const h = harness({prepareResource(h, r) {h.requests.push(r); const p = h.preparedValue(); transform(p); return Promise.resolve(p);}});
  await h.start(); state(h, 'error', 'invalid_resource'); assert.equal(h.handles.length, 0); assert.equal(h.encodes.length, 0); await closed(h);
});
test('exact encoded input cap is accepted and prepared ownership ends before next request', async () => {
  const h = harness({prepareResource(h, r) {
    for (const p of h.prepared) assert.equal(p.releases, 1, 'one prepared input maximum');
    h.requests.push(r); return Promise.resolve(h.preparedValue(2048, 2048, png(20971520)));
  }});
  await h.start(); state(h, 'ready'); assert.equal(h.requests.length, 2); await closed(h);
});
test('decoded dimensions must match admitted intrinsic PNG, never target cover size', async () => {
  const h = harness({decodeResource(h, p) {const x = h.handleValue(p); x.width = 256; return Promise.resolve(x);}});
  await h.start(); state(h, 'error', 'invalid_resource'); assert.equal(h.encodes.length, 0); await closed(h);
});
test('reservation uses retained intrinsic bytes: exact 128000000 succeeds, one extra pixel is refused before decode', async () => {
  for (const overflow of [false, true]) {
    const h = harness({prepareResource(h, r) {h.requests.push(r); return Promise.resolve(h.preparedValue(
      overflow && r.kind === 'brand' ? 1 : 2000, overflow && r.kind === 'brand' ? 1 : 2000));}});
    await h.start(model(overflow ? 8 : 7, BARE));
    if (overflow) {state(h, 'error', 'resource_budget'); assert.equal(h.handles.length, 8); assert.equal(h.encodes.length, 0);}
    else {state(h, 'ready'); assert.equal(h.handles.length, 8);}
    assert.equal(h.handles.reduce((sum, x) => sum + x.width * x.height * 4, 0), 128000000); await closed(h);
  }
});
for (const phase of ['prepare', 'decode']) for (const outcome of ['reject', 'throw', 'nonpromise', 'thenable'])
  test(`${phase} ${outcome} fails boundedly and never encodes`, async () => {
    const fail = () => {
      if (outcome === 'throw') throw Error('private-secret');
      if (outcome === 'reject') return Promise.reject(Error('private-secret'));
      if (outcome === 'thenable') return {then() {throw Error('private-secret');}};
      return null;
    };
    const h = harness({[phase === 'prepare' ? 'prepareResource' : 'decodeResource']: fail});
    await h.start(); state(h, 'error', ['nonpromise', 'thenable'].includes(outcome) ? 'invalid_resource' : 'resource_unavailable');
    assert.equal(h.encodes.length, 0); assert.equal(JSON.stringify(h.states).includes('private-secret'), false); await closed(h);
  });
for (const missing of ['cover', 'brand']) test(`unavailable ${missing} fails the entire output without placeholder`, async () => {
  const h = harness({prepareResource(h, r) {h.requests.push(r); return r.kind === missing ? Promise.reject(Error('missing')) : Promise.resolve(h.preparedValue());}});
  await h.start(); state(h, 'error', 'resource_unavailable'); assert.equal(h.encodes.length, 0);
  assert.equal(h.surfaces[0].trace.some(x => x.op === 'drawImage'), false); await closed(h);
});
for (const [name, value, error] of [['null', null, 'invalid_png'], ['empty', png(0), 'invalid_png'],
  ['wrong MIME', png(1, 'image/jpeg'), 'invalid_png'], ['nonblob', {size: 1, type: 'image/png'}, 'invalid_png'],
  ['over cap', png(67108865), 'output_budget']]) test(`encoder ${name} never publishes`, async () => {
    const h = harness({encodePng() {return Promise.resolve(value);}}); await h.start(); state(h, 'error', error);
    assert.equal(h.renderer.currentBlob(1), null); await closed(h);
  });
test('exact 64 MiB accepted output and replacement use exact identities without copying', async () => {
  const a = png(67108864), b = png(67108864); let count = 0;
  const h = harness({encodePng(h, s, options) {assert.equal(options.maxBytes, 67108864); return Promise.resolve(count++ ? b : a);}});
  const old = await h.start(); assert.equal(h.renderer.currentBlob(old), a); assert.equal(state(h, 'ready').output.bytes, 67108864);
  const next = h.renderer.replace(model(1, {frameWidth: 2}), {fontGeneration: 'font-1'}); assert.equal(h.renderer.currentBlob(old), null);
  await h.flush(); assert.equal(h.renderer.currentBlob(next), b); assert.equal(state(h, 'ready').hasPrevious, false); await closed(h);
});
test('oversized candidate preserves previous same-source preview but not Download eligibility', async () => {
  let first = true; const h = harness({encodePng() {const result = png(first ? 67108864 : 67108865); first = false; return Promise.resolve(result);}});
  const old = await h.start(); h.renderer.replace(model(1, {frameWidth: 2}), {fontGeneration: 'font-1'}); await h.flush();
  assert.equal(state(h, 'error', 'output_budget').hasPrevious, true); assert.equal(h.renderer.currentBlob(old), null); await closed(h);
});
for (const reject of [false, true]) test(`encoder ${reject ? 'rejection' : 'synchronous throw'} maps encode_failed`, async () => {
  const h = harness({encodePng() {if (reject) return Promise.reject(Error('private-secret')); throw Error('private-secret');}});
  await h.start(); state(h, 'error', 'encode_failed'); await closed(h);
});
test('stale rejected encoding cannot overwrite replacement state or publish old source', async () => {
  const pending = defer(); let first = true;
  const h = harness({encodePng() {if (first) {first = false; return pending.promise;} return Promise.resolve(png());}});
  await h.start(); const g = h.renderer.replace(model(1, {}, {...BINDING, sourceKey: 'new'}), {fontGeneration: 'font-1'});
  pending.reject(Error('private-secret')); await h.flush(); assert.equal(state(h, 'ready').generation, g);
  assert.equal(h.states.some(s => s.error === 'encode_failed'), false); await closed(h);
});
for (const fault of ['create', 'missing-roundRect', 'metrics', 'paint']) test(`surface ${fault} has explicit bounded failure`, async () => {
  const h = harness({createSurface(h) {
    if (fault === 'create') throw Error('private-secret'); const s = h.surfaceValue();
    if (fault === 'missing-roundRect') delete s.methods.roundRect;
    if (fault === 'metrics') s.methods.measureText = () => ({width: 8});
    if (fault === 'paint') s.methods.drawImage = () => {throw Error('private-secret');};
    return s;
  }});
  await h.start(model(1, {roundedCorners: true})); state(h, 'error', fault === 'metrics' ? 'invalid_metrics' : fault === 'paint' ? 'paint_failed' : 'surface_unavailable');
  assert.equal(h.encodes.length, 0); await closed(h);
});

test('malformed replacement during noninterruptible encode validates synchronously and cannot revive retired preview', async () => {
  const pending = defer(); let call = 0;
  const h = harness({encodePng() {return ++call === 2 ? pending.promise : Promise.resolve(png());}});
  const old = await h.start(); h.renderer.replace(model(1, {frameWidth: 2}), {fontGeneration: 'font-1'}); await h.flush();
  const generation = h.renderer.replace(Object.freeze({}), {fontGeneration: 'font-1'});
  assert.equal(state(h, 'error', 'invalid_input').generation, generation); assert.equal(h.renderer.read().hasPrevious, false);
  assert.equal(h.renderer.read().binding, null); assert.equal(h.renderer.currentBlob(old), null);
  const surfaces = h.surfaces.length; await h.flush(); assert.equal(h.surfaces.length, surfaces);
  pending.resolve(png()); await h.flush(); state(h, 'error', 'invalid_input'); assert.equal(call, 2); await closed(h);
});
test('same-source superseded decode is cached once but obsolete generation never paints', async () => {
  const pending = defer(); let first = true, late;
  const h = harness({decodeResource(h, p) {const x = h.handleValue(p); if (first) {first = false; late = x; return pending.promise;} return Promise.resolve(x);}});
  const old = h.renderer.replace(model(), {fontGeneration: 'font-1'}); await h.flush();
  const latest = h.renderer.replace(model(1, {frameWidth: 12}), {fontGeneration: 'font-1'}); await h.flush();
  assert.equal(h.handles.length, 1); assert.equal(h.encodes.length, 0); pending.resolve(late); await h.flush();
  assert.equal(state(h, 'ready').generation, latest); assert.equal(h.handles.length, 2); assert.equal(h.requests.length, 2);
  assert.equal(h.states.some(s => s.status === 'ready' && s.generation === old), false); await closed(h);
});
test('late malformed stale decoder result is released once without replacing the newest state', async () => {
  const pending = defer(); let first = true, late;
  const h = harness({decodeResource(h, p) {const x = h.handleValue(p); if (first) {first = false; late = x; x.width++; return pending.promise;} return Promise.resolve(x);}});
  await h.start(); const g = h.renderer.replace(model(1, {}, {...BINDING, sourceKey: 'new'}), {fontGeneration: 'font-1'});
  pending.resolve(late); await h.flush(); assert.equal(late.releases, 1); assert.equal(state(h, 'ready').generation, g); await closed(h);
});
test('source supersession AbortError is silent but current AbortError is resource_unavailable', async () => {
  for (const stale of [false, true]) {
    const pending = defer(); let first = true;
    const h = harness({prepareResource(h, r) {h.requests.push(r); if (first) {first = false; return pending.promise;} return Promise.resolve(h.preparedValue());}});
    await h.start(); let g;
    if (stale) g = h.renderer.replace(model(1, {}, {...BINDING, sourceKey: 'new'}), {fontGeneration: 'font-1'});
    const error = Error('private-secret'); error.name = 'AbortError'; pending.reject(error); await h.flush();
    if (stale) {assert.equal(state(h, 'ready').generation, g); assert.equal(h.states.some(s => s.error === 'resource_unavailable'), false);}
    else state(h, 'error', 'resource_unavailable'); await closed(h);
  }
});
test('currentness lost from inside encoder prevents candidate publication and releases the surface', async () => {
  const h = harness({encodePng(h) {h.current = false; return Promise.resolve(png());}});
  await h.start(); state(h, 'error', 'source_retired'); assert.equal(h.renderer.currentBlob(1), null); await closed(h);
});
test('surface callback reentry cannot continue captured generation into resource acquisition', async () => {
  let first = true; const h = harness({createSurface(h) {
    const s = h.surfaceValue(); if (first) {first = false; h.renderer.replace(model(1, {}, {...BINDING, sourceKey: 'new'}), {fontGeneration: 'font-1'});} return s;
  }});
  await h.start(); state(h, 'ready'); assert.ok(h.requests.length > 0);
  assert.ok(h.requests.every(r => r.binding.sourceKey === 'new')); await closed(h);
});
test('malformed prepared release cannot silently grant a new lane', async () => {
  const h = harness({prepareResource(h, r) {h.requests.push(r); const p = h.preparedValue(); p.release = () => {p.releases++; throw Error('unknown-release');}; return Promise.resolve(p);}});
  await h.start(); const count = h.surfaces.length;
  h.renderer.replace(model(1, {}, {...BINDING, sourceKey: 'new'}), {fontGeneration: 'font-1'}); await h.flush();
  assert.equal(h.surfaces.length, count); assert.equal(h.renderer.currentBlob(h.renderer.read().generation), null);
  let closed = false; h.renderer.dispose().then(() => {closed = true;}); await turns(); assert.equal(closed, false);
});

test('unreadable measured glyph propagates without fallback, compression or resource calls', async () => {
  const h = harness({createSurface(h) {const s = h.surfaceValue(); s.methods.measureText = text => ({...metric(text), width: 100000, actualBoundingBoxRight: 100000}); return s;}});
  await h.start(); state(h, 'error', 'unreadable_text'); assert.equal(h.requests.length, 0); assert.equal(h.encodes.length, 0); await closed(h);
});
test('strictly serial prepare/decode holds the 1x1 measurement surface until every asset settles', async () => {
  const decode = defer(); let first = true, late;
  const h = harness({decodeResource(h, p) {const x = h.handleValue(p); if (first) {first = false; late = x; return decode.promise;} return Promise.resolve(x);}});
  await h.start(model(7)); assert.equal(h.requests.length, 1); assert.equal(h.prepared.length, 1); assert.equal(h.handles.length, 1);
  assert.equal(h.prepared[0].releases, 0); assert.equal(h.surfaces[0].width, 1); assert.equal(h.surfaces[0].height, 1);
  decode.resolve(late); await h.flush(); state(h, 'ready'); assert.equal(h.requests.length, 8);
  assert.equal(h.events.filter(e => e[0] === 'resize').length, 1); await closed(h);
});
