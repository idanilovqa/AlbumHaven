const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/player-track-cache.js'), 'utf8');

function fakeCaches() {
  const entries = new Map();
  const cache = {
    async match(url) { return entries.has(url) ? new Response(entries.get(url)) : undefined; },
    async put(url, response) { entries.delete(url); entries.set(url, await response.arrayBuffer()); },
    async delete(url) { return entries.delete(typeof url === 'string' ? url : url.url); },
    async keys() { return [...entries.keys()].map(url => ({ url })); },
  };
  return { entries, caches: { open: async () => cache } };
}

function load({ quota = 1e12 } = {}) {
  const store = fakeCaches();
  const context = {
    caches: store.caches,
    crypto: globalThis.crypto,
    navigator: { storage: { estimate: async () => ({
      usage: [...store.entries.values()].reduce((total, buffer) => total + buffer.byteLength, 0), quota,
    }) } },
    Response, TextEncoder, TextDecoder, Uint8Array, DataView, JSON, Number, String, Promise,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, store };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const entry = (size, extra = {}) => ({
  codec: 'flac', sampleRate: 96_000, skipFrames: 0, totalFrames: 1_234, authoritativeTotalFrames: 1_234,
  table: { prefixBytes: 42, prerollFrames: 0, offsets: [42, 900, size], samples: [0, 600, 1_234] },
  bytes: Uint8Array.from({ length: size }, (_, index) => index % 251), ...extra,
});

test('a kept track comes back exactly, under a name that is a digest of its key', async () => {
  const { context, store } = load();
  const key = context.streamingTrackCacheKey({ path: 'C:/Music/a.flac', durationSeconds: 241 }, null);
  context.keepStreamingCachedTrack(key, entry(5_000));
  await settle();

  const loaded = await context.loadStreamingCachedTrack(key);
  assert.deepEqual([loaded.codec, loaded.sampleRate, loaded.totalFrames], ['flac', 96_000, 1_234]);
  assert.deepEqual([...loaded.bytes], [...entry(5_000).bytes]);
  assert.deepEqual(loaded.table.offsets, [42, 900, 5_000]);
  assert.ok([...store.entries.keys()].every(url => !url.includes('Music') && !url.includes('a.flac')));
  assert.equal(await context.loadStreamingCachedTrack(context.streamingTrackCacheKey({ path: 'C:/Music/a.flac', durationSeconds: 242 })), null,
    'a re-encoded file is a different track');
});

test('the oldest-used tracks go once the quota share is exceeded', async () => {
  const { context, store } = load({ quota: 30_000 });
  for (const name of ['a', 'b']) {
    context.keepStreamingCachedTrack(name, entry(10_000));
    await settle();
  }
  assert.ok(await context.loadStreamingCachedTrack('a'), 'a used track becomes the newest');
  await settle();
  context.keepStreamingCachedTrack('c', entry(10_000));
  await settle();

  assert.equal(store.entries.size, 2);
  assert.equal(await context.loadStreamingCachedTrack('b'), null);
  assert.ok(await context.loadStreamingCachedTrack('a'));
  assert.ok(await context.loadStreamingCachedTrack('c'));
});

test('without Cache Storage nothing is kept and nothing is found', async () => {
  const context = { Response, TextEncoder, TextDecoder };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.keepStreamingCachedTrack('a', entry(10));
  assert.equal(await context.loadStreamingCachedTrack('a'), null);
});
