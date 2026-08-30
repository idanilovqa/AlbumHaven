const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'gallery-cover-preview-cache.js');
const helperSource = fs.readFileSync(helperPath, 'utf8');

function createContext() {
  const warnings = [];
  class FakeImageElement {
    constructor() { this.attributes = {}; this.src = ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || ''; }
  }
  class FakeCacheableResponse {
    constructor(blob, init = {}) {
      this.ok = Number(init.status || 200) >= 200 && Number(init.status || 200) < 300;
      this.status = Number(init.status || 200);
      this.statusText = String(init.statusText || '');
      const headerValues = init.headers || {};
      this.headers = {
        get(name) {
          const expectedName = String(name || '').toLowerCase();
          const entry = Object.entries(headerValues).find(([key]) => key.toLowerCase() === expectedName);
          return entry ? String(entry[1]) : null;
        },
      };
      this.bodyBlob = blob;
    }

    async blob() {
      return this.bodyBlob;
    }
  }
  const context = {
    AbortController,
    Date,
    Map,
    Response: FakeCacheableResponse,
    setTimeout,
    URL,
    HTMLImageElement: FakeImageElement,
    markAlbumDisplayCoverImagePending(image) {
      image.setAttribute('data-cover-visual-state', 'pending');
      image.setAttribute('aria-hidden', 'true');
      return true;
    },
    console: { warn(...args) { warnings.push(args); } },
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.GalleryCoverPreviewCache = vm.runInContext('GalleryCoverPreviewCache', context);
  context.beginGalleryCoverImageRequest = vm.runInContext('beginGalleryCoverImageRequest', context);
  context.commitGalleryCoverImageRequest = vm.runInContext('commitGalleryCoverImageRequest', context);
  context.loadGalleryCoverPreviewImage = vm.runInContext('loadGalleryCoverPreviewImage', context);
  context.galleryCoverPreviewCache = vm.runInContext('galleryCoverPreviewCache', context);
  return { context, warnings };
}

function createResponse(id) {
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'image/png' : null; } },
    clone() { return createResponse(id); },
    async blob() { return { id, size: 64, type: 'image/png' }; },
  };
}

test('shared image loader rejects a resolved preview when modal ownership became stale', async () => {
  const { context } = createContext();
  const image = new context.HTMLImageElement();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=stale-modal&size=480&v=fixture';
  let resolvePreview;
  let isCurrent = true;
  context.galleryCoverPreviewCache.resolve = () => new Promise((resolve) => {
    resolvePreview = resolve;
  });

  const loadPromise = context.loadGalleryCoverPreviewImage(image, productionUrl, {
    isCurrent: () => isCurrent,
  });
  isCurrent = false;
  resolvePreview({ displayUrl: 'blob:stale-modal-preview', cached: true });

  assert.equal(await loadPromise, null);
  assert.equal(image.getAttribute('src'), '');
  assert.equal(
    image.getAttribute('data-production-cover-src'),
    productionUrl,
    'the request identity may remain diagnostic, but no display URL may be committed',
  );
});

test('remote cover proxy is the only additional same-origin preview cache route', async () => {
  const { context } = createContext();
  const stored = new Map();
  let fetchCount = 0;
  const previewCache = new context.GalleryCoverPreviewCache({
    locationOrigin: 'http://127.0.0.1:4173',
    cacheStorage: {
      async keys() { return []; },
      async delete() { return true; },
      async open() {
        return {
          async match(key) { return stored.get(String(key)) || null; },
          async put(key, response) { stored.set(String(key), response); },
          async delete(key) { return stored.delete(String(key)); },
          async keys() { return [...stored.keys()]; },
        };
      },
    },
    fetchImpl: async () => {
      fetchCount += 1;
      return createResponse('remote-proxy');
    },
  });
  const proxyUrl = '/utilities/cover-lookup/remote-image?url=https%3A%2F%2Fimages.example%2Fcover.jpg';
  const normalizedProxyUrl = 'http://127.0.0.1:4173/utilities/cover-lookup/remote-image?url=https%3A%2F%2Fimages.example%2Fcover.jpg';

  assert.equal(previewCache.normalizeProductionUrl(proxyUrl), normalizedProxyUrl);
  assert.equal((await previewCache.prefetch(proxyUrl)).cached, true);
  assert.equal((await previewCache.prefetch(proxyUrl)).cached, true);
  assert.equal(fetchCount, 1, 'the remote-only proxy response must be reused from Cache Storage');
  assert.equal(
    previewCache.normalizeProductionUrl('http://127.0.0.1:4173/album-details?album_key=x'),
    '',
  );
  assert.equal(
    previewCache.normalizeProductionUrl('https://images.example/utilities/cover-lookup/remote-image?url=x'),
    '',
  );
  assert.equal(
    previewCache.normalizeProductionUrl('https://images.example/cover?path=x'),
    '',
  );
});

test('gallery preview cache fetches each production URL once and restores evicted blobs from Cache Storage', async () => {
  const { context } = createContext();
  const stored = new Map();
  const deletedCaches = [];
  const revoked = [];
  let fetchCount = 0;
  let objectUrlCount = 0;
  const cache = {
    async match(key) { return stored.get(String(key)) || null; },
    async put(key, response) { stored.set(String(key), response); },
    async delete(key) { return stored.delete(String(key)); },
  };
  const cacheStorage = {
    async keys() { return ['album-haven-gallery-previews-old', 'unrelated-cache']; },
    async delete(name) { deletedCaches.push(name); return true; },
    async open(name) {
      assert.equal(name, 'album-haven-gallery-previews-v1');
      return cache;
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage,
    fetchImpl: async (url) => {
      fetchCount += 1;
      return createResponse(String(url));
    },
    urlApi: {
      createObjectURL() {
        objectUrlCount += 1;
        return `blob:preview-${objectUrlCount}`;
      },
      revokeObjectURL(url) { revoked.push(url); },
    },
    locationOrigin: 'http://127.0.0.1:4173',
    maxActiveObjectUrls: 2,
  });
  const urls = [1, 2, 3].map((index) => `http://127.0.0.1:4173/cover?path=cover-${index}&size=480&v=initial`);

  const first = await previewCache.resolve(urls[0]);
  await previewCache.resolve(urls[1]);
  await previewCache.resolve(urls[2]);
  assert.equal(previewCache.hasActive(urls[0]), false, 'the oldest object URL should be inactive after LRU eviction');
  const restored = await previewCache.resolve(urls[0]);

  assert.equal(first.displayUrl, 'blob:preview-1');
  assert.equal(restored.displayUrl, 'blob:preview-4');
  assert.equal(previewCache.hasActive(urls[0]), true, 'Cache Storage restoration should reactivate the production URL');
  assert.equal(fetchCount, 3, 'the evicted preview must come from Cache Storage, not a second production request');
  assert.deepEqual(deletedCaches, ['album-haven-gallery-previews-old']);
  assert.deepEqual(revoked, ['blob:preview-1', 'blob:preview-2']);
  assert.equal(previewCache.activeObjectUrls.size, 2);

  previewCache.destroy();
  assert.deepEqual(revoked, ['blob:preview-1', 'blob:preview-2', 'blob:preview-3', 'blob:preview-4']);
});

test('gallery preview cache reports unavailable storage and falls back to the production URL', async () => {
  const { context, warnings } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=fallback&size=480&v=initial';
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: null,
    fetchImpl: async () => createResponse('fallback'),
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const result = await previewCache.resolve(productionUrl);

  assert.equal(result.displayUrl, productionUrl);
  assert.equal(result.cached, false);
  assert.equal(previewCache.diagnostics.fallbackCount, 1);
  assert.match(previewCache.diagnostics.lastFallback.message, /Cache Storage is unavailable/);
  assert.equal(warnings.length, 1);
});

test('foreground reads the network body once and exposes its object URL before deferred persistence', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=critical&size=480&v=initial';
  const events = [];
  let bodyReads = 0;
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'image/png' : null; } },
    clone() { throw new Error('foreground cover responses must not tee their body'); },
    async blob() {
      bodyReads += 1;
      events.push('body');
      return { id: 'critical', size: 64, type: 'image/png' };
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() { events.push('put'); },
        };
      },
    },
    fetchImpl: async () => response,
    urlApi: {
      createObjectURL() { events.push('object-url'); return 'blob:critical'; },
    },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const resolved = await previewCache.resolve(productionUrl);
  assert.equal(resolved.displayUrl, 'blob:critical');
  assert.equal(bodyReads, 1);
  assert.deepEqual(events, ['body', 'object-url']);
  await Promise.all([...previewCache.writeChains.values()]);
  assert.deepEqual(events, ['body', 'object-url', 'put']);
});

test('gallery preview cache assigns a request ID header only to an actual same-origin network fetch', async () => {
  const { context } = createContext();
  const cachedUrl = 'http://127.0.0.1:4173/cover?path=cached&size=480&v=initial';
  const networkUrl = 'http://127.0.0.1:4173/cover?path=network&size=480&v=initial';
  const fetchCalls = [];
  const cache = {
    async keys() { return []; },
    async match(key) { return String(key) === cachedUrl ? createResponse('cached') : null; },
    async put() {},
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return createResponse('network');
    },
    urlApi: { createObjectURL(blob) { return `blob:${blob.id}`; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  await previewCache.resolve(cachedUrl);
  assert.equal(previewCache.requestSequence, 0, 'a Cache Storage hit must not allocate a network request ID');
  await previewCache.resolve(networkUrl);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, networkUrl);
  const requestId = fetchCalls[0].options.headers['X-Album-Haven-Cover-Request-Id'];
  assert.match(requestId, /^gallery-cover-[a-z0-9-]+-1$/);
  assert.equal(fetchCalls[0].options.headers['X-Album-Haven-Cover-Priority'], 'foreground');
  assert.equal(fetchCalls[0].options.credentials, 'same-origin');
});

test('gallery preview cache marks family prefetch as background server work', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=family&size=480&v=initial';
  const fetchCalls = [];
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() {},
        };
      },
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      return createResponse('family');
    },
    urlApi: { createObjectURL() { return 'blob:family'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const result = await previewCache.prefetch(productionUrl);

  assert.equal(result.cached, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].options.headers['X-Album-Haven-Cover-Priority'], 'background');
});

test('foreground consumer promotes a same-key prefetch before its network request starts', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=promoted&size=480&v=initial';
  let releaseCacheOpen;
  const cacheOpenGate = new Promise((resolve) => { releaseCacheOpen = resolve; });
  const fetchPriorities = [];
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        await cacheOpenGate;
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() {},
        };
      },
    },
    fetchImpl: async (_url, options) => {
      fetchPriorities.push(options.headers['X-Album-Haven-Cover-Priority']);
      return createResponse('promoted');
    },
    urlApi: { createObjectURL() { return 'blob:promoted'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const background = previewCache.prefetch(productionUrl);
  await Promise.resolve();
  const foreground = previewCache.resolve(productionUrl);
  releaseCacheOpen();
  const [backgroundResult, foregroundResult] = await Promise.all([background, foreground]);

  assert.equal(backgroundResult.cached, true);
  assert.equal(foregroundResult.displayUrl, 'blob:promoted');
  assert.deepEqual(fetchPriorities, ['foreground']);
});

test('foreground consumers promote already-dispatched same-key background HTTP work exactly once', async () => {
  const { context, warnings } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=post-dispatch-promoted&size=480&v=initial';
  const stored = new Map();
  const fetchCalls = [];
  let firstRequestStarted;
  const firstRequestGate = new Promise((resolve) => { firstRequestStarted = resolve; });
  let abortedBackgroundCount = 0;
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match(key) { return stored.get(String(key)) || null; },
          async put(key, response) { stored.set(String(key), response); },
          async delete(key) { return stored.delete(String(key)); },
        };
      },
    },
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url: String(url), options });
      if (fetchCalls.length === 1) {
        firstRequestStarted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            abortedBackgroundCount += 1;
            const error = new Error('background request promoted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return createResponse('post-dispatch-promoted');
    },
    urlApi: { createObjectURL() { return 'blob:post-dispatch-promoted'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const background = previewCache.prefetch(productionUrl);
  await firstRequestGate;
  const firstForeground = previewCache.resolve(productionUrl);
  const secondForeground = previewCache.resolve(productionUrl);
  const [backgroundResult, firstForegroundResult, secondForegroundResult] = await Promise.all([
    background,
    firstForeground,
    secondForeground,
  ]);

  assert.equal(backgroundResult.cached, true);
  assert.equal(firstForegroundResult.displayUrl, 'blob:post-dispatch-promoted');
  assert.equal(secondForegroundResult.displayUrl, 'blob:post-dispatch-promoted');
  assert.equal(abortedBackgroundCount, 1);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(
    fetchCalls.map((call) => call.options.headers['X-Album-Haven-Cover-Priority']),
    ['background', 'foreground'],
  );
  assert.equal(
    new Set(fetchCalls.map((call) => call.options.headers['X-Album-Haven-Cover-Request-Id'])).size,
    2,
  );
  assert.equal(previewCache.diagnostics.preemptionCount, 1);
  assert.equal(previewCache.diagnostics.preemptions.length, 1);
  assert.deepEqual({ ...previewCache.diagnostics.preemptions[0] }, {
    requestId: fetchCalls[0].options.headers['X-Album-Haven-Cover-Request-Id'],
    normalizedUrl: 'http://127.0.0.1:4173/cover',
    reason: 'foreground-promotion',
    sequence: 1,
  });
  assert.equal(previewCache.diagnostics.fallbackCount, 0);
  assert.equal(warnings.length, 0);
  assert.equal(previewCache.inFlight.size, 0);
});

test('recordInFlightPreemption records the exact live request once and is idempotent for duplicate calls', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=private%2Fdirect-record&size=480&v=secret';
  const controller = new AbortController();
  let requestId = '';
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() {},
        };
      },
    },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      requestId = options.headers['X-Album-Haven-Cover-Request-Id'];
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted after direct preemption record');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });
  const pending = previewCache.prefetch(productionUrl, { signal: controller.signal });
  await waitUntil(() => Boolean(requestId));

  const first = previewCache.recordInFlightPreemption(productionUrl, 'foreground-promotion');
  const duplicate = previewCache.recordInFlightPreemption(productionUrl, 'foreground-promotion');

  assert.deepEqual({ ...first }, {
    requestId,
    normalizedUrl: 'http://127.0.0.1:4173/cover',
    reason: 'foreground-promotion',
    sequence: 1,
  });
  assert.equal(duplicate, null);
  assert.equal(previewCache.diagnostics.preemptionCount, 1);
  assert.deepEqual(
    [...previewCache.diagnostics.preemptions].map((entry) => ({ ...entry })),
    [{ ...first }],
  );

  controller.abort();
  assert.equal((await pending).cancelled, true);
});

test('recordInFlightPreemption preserves the approved render-generation reason in diagnostics and event detail', () => {
  const { context } = createContext();
  const dispatched = [];
  context.CustomEvent = class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };
  context.dispatchEvent = (event) => { dispatched.push(event); };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: null,
    fetchImpl: async () => { throw new Error('network should not be used'); },
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });
  const productionUrl = 'http://127.0.0.1:4173/cover?path=private%2Frender-change&size=480&v=secret';
  const normalizedProductionUrl = previewCache.normalizeProductionUrl(productionUrl);
  const requestId = 'gallery-cover-render-generation-1';
  const liveFetch = {
    requestId,
    normalizedUrl: 'http://127.0.0.1:4173/cover',
    abortController: new AbortController(),
    preemptionDetail: null,
  };
  previewCache.liveFetches.set(requestId, liveFetch);
  previewCache.inFlight.set(normalizedProductionUrl, { liveRequestId: requestId });

  const detail = previewCache.recordInFlightPreemption(
    productionUrl,
    'render-generation-preemption',
  );

  assert.equal(detail.reason, 'render-generation-preemption');
  assert.equal(previewCache.diagnostics.lastPreemption.reason, 'render-generation-preemption');
  assert.equal(previewCache.diagnostics.preemptions[0].reason, 'render-generation-preemption');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'album-haven:gallery-cover-cache-preemption');
  assert.equal(dispatched[0].detail.reason, 'render-generation-preemption');
});

test('gallery preview cache records each intentional abort atomically with redacted bounded monotonic diagnostics', async () => {
  const { context } = createContext();
  const observedAtAbort = [];
  let previewCache;
  const cache = {
    async keys() { return []; },
    async match() { return null; },
    async put() {},
  };
  previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const requestId = options.headers['X-Album-Haven-Cover-Request-Id'];
        observedAtAbort.push({
          requestId,
          recorded: previewCache.diagnostics.preemptions.some((entry) => entry.requestId === requestId),
          reentrant: previewCache.abortInFlight('utility-modal-preemption'),
        });
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });
  const urls = Array.from({ length: 66 }, (_, index) => (
    `http://127.0.0.1:4173/cover?path=private%2Falbum-${index}&size=480&v=secret-${index}`
  ));
  const pending = urls.map((url) => previewCache.prefetch(url));
  await waitUntil(() => previewCache.liveFetches.size === urls.length);

  const preemptions = previewCache.abortInFlight('utility-modal-preemption');
  const results = await Promise.all(pending);

  assert.equal(preemptions.length, 66);
  assert.deepEqual(Array.from(preemptions, (entry) => entry.sequence), Array.from({ length: 66 }, (_, index) => index + 1));
  assert.equal(new Set(preemptions.map((entry) => entry.requestId)).size, 66);
  assert.ok(preemptions.every((entry) => entry.normalizedUrl === 'http://127.0.0.1:4173/cover'));
  assert.ok(preemptions.every((entry) => entry.reason === 'utility-modal-preemption'));
  assert.ok(preemptions.every((entry) => !entry.normalizedUrl.includes('private') && !entry.normalizedUrl.includes('secret')));
  assert.equal(previewCache.diagnostics.preemptions.length, 64);
  assert.deepEqual(
    Array.from(previewCache.diagnostics.preemptions, (entry) => entry.sequence),
    Array.from({ length: 64 }, (_, index) => index + 3),
  );
  assert.equal(previewCache.diagnostics.preemptionCount, 66);
  assert.equal(previewCache.diagnostics.preemptionSequence, 66);
  assert.ok(observedAtAbort.every((entry) => entry.recorded), 'each record must exist before its controller is aborted');
  assert.ok(observedAtAbort.every((entry) => entry.reentrant.length === 0), 're-entrant aborts must not duplicate records');
  assert.ok(results.every((result) => result.cancelled === true));
});

test('gallery preview cache revokes a blob that resolves after destroy instead of resurrecting active state', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=late&size=480&v=initial';
  const revoked = [];
  let releaseBlob;
  const blobReady = new Promise((resolve) => { releaseBlob = resolve; });
  const response = {
    ok: true,
    status: 200,
    headers: { get(name) { return String(name).toLowerCase() === 'content-type' ? 'image/png' : null; } },
    clone() { return createResponse('late'); },
    async blob() {
      await blobReady;
      return { id: 'late', size: 64, type: 'image/png' };
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async match() { return null; },
          async put() {},
        };
      },
    },
    fetchImpl: async () => response,
    urlApi: {
      createObjectURL() { return 'blob:late'; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const pending = previewCache.resolve(productionUrl);
  await new Promise((resolve) => setImmediate(resolve));
  previewCache.destroy();
  releaseBlob();
  await assert.rejects(pending, { name: 'AbortError' });

  assert.deepEqual(revoked, [], 'a stale completion must be rejected before object URL creation');
  assert.equal(previewCache.activeObjectUrls.size, 0);
});

test('destroy aborts a hung active attempt, cleans ownership, and permits one fresh same-key request', async () => {
  const { context, warnings } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=destroy-hung&size=480&v=epoch-1';
  const fetchCalls = [];
  let firstRequestStarted;
  const firstRequestGate = new Promise((resolve) => { firstRequestStarted = resolve; });
  let firstSignalAborted = false;
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() {},
          async delete() { return false; },
        };
      },
    },
    fetchImpl: async (_url, options) => {
      fetchCalls.push(options);
      if (fetchCalls.length === 1) {
        firstRequestStarted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            firstSignalAborted = true;
            const error = new Error('cache destroyed');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return createResponse('fresh-after-destroy');
    },
    urlApi: { createObjectURL() { return 'blob:fresh-after-destroy'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const firstOutcome = previewCache.resolve(productionUrl).then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error }),
  );
  await firstRequestGate;

  previewCache.destroy();

  const settled = await firstOutcome;
  assert.equal(settled.status, 'rejected');
  assert.equal(settled.error?.name, 'AbortError');
  assert.equal(firstSignalAborted, true);
  assert.equal(previewCache.liveFetches.size, 0);
  assert.equal(previewCache.inFlight.size, 0);
  assert.equal(previewCache.diagnostics.preemptionCount, 1);
  assert.equal(previewCache.diagnostics.preemptions[0].reason, 'cache-destroyed');
  assert.equal(previewCache.diagnostics.fallbackCount, 0);
  assert.equal(warnings.length, 0);

  const fresh = await previewCache.resolve(productionUrl);
  const reusedFresh = await previewCache.resolve(productionUrl);
  await waitUntil(() => previewCache.inFlight.size === 0);

  assert.equal(fresh.displayUrl, 'blob:fresh-after-destroy');
  assert.equal(reusedFresh.displayUrl, 'blob:fresh-after-destroy');
  assert.equal(fetchCalls.length, 2, 'destroyed ownership must not cause duplicate same-key retries');
  assert.equal(previewCache.liveFetches.size, 0);
  assert.equal(previewCache.inFlight.size, 0);
});

test('gallery preview cache deletes an invalid cached response and refetches one valid image', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=invalid-cache&size=480&v=epoch-1';
  let fetchCount = 0;
  const deleted = [];
  const cache = {
    async keys() { return []; },
    async match() {
      return {
        ok: true,
        status: 200,
        headers: { get() { return 'text/html'; } },
        async blob() { return { size: 10, type: 'text/html' }; },
      };
    },
    async delete(key) { deleted.push(String(key)); return true; },
    async put() {},
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => { fetchCount += 1; return createResponse('valid'); },
    urlApi: { createObjectURL() { return 'blob:valid'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const result = await previewCache.resolve(productionUrl);

  assert.equal(result.displayUrl, 'blob:valid');
  assert.equal(fetchCount, 1);
  assert.deepEqual(deleted, [productionUrl]);
});

test('aborting a valid cached response during validation preserves it for the next resolve', async () => {
  const { context, warnings } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=cancelled-cache-read&size=480&v=epoch-1';
  const validationGate = deferredHost();
  const controller = new AbortController();
  const stored = new Map();
  let blobReads = 0;
  let fetchCount = 0;
  let deleteCount = 0;
  const cachedResponse = {
    ok: true,
    status: 200,
    headers: { get() { return 'image/png'; } },
    async blob() {
      blobReads += 1;
      if (blobReads === 1) await validationGate.promise;
      return { id: 'preserved-cache-entry', size: 64, type: 'image/png' };
    },
  };
  stored.set(productionUrl, cachedResponse);
  const cache = {
    async keys() { return []; },
    async match(key) { return stored.get(String(key)) || null; },
    async delete(key) {
      deleteCount += 1;
      return stored.delete(String(key));
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => { fetchCount += 1; return createResponse('unexpected-network'); },
    urlApi: { createObjectURL(blob) { return `blob:${blob.id}`; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const cancelledResolve = previewCache.resolve(productionUrl, { signal: controller.signal });
  await waitUntil(() => blobReads === 1);
  controller.abort();
  await assert.rejects(cancelledResolve, { name: 'AbortError' });
  validationGate.resolve();
  await waitUntil(() => previewCache.inFlight.size === 0);

  assert.equal(stored.get(productionUrl), cachedResponse, 'cancellation must not evict valid Cache Storage data');
  assert.equal(deleteCount, 0);
  assert.equal(warnings.length, 0, 'cancellation must not be diagnosed as an invalid cache entry');

  const reused = await previewCache.resolve(productionUrl);

  assert.equal(reused.displayUrl, 'blob:preserved-cache-entry');
  assert.equal(reused.cached, true);
  assert.equal(blobReads, 2);
  assert.equal(fetchCount, 0, 'the preserved cache entry must prevent a production refetch');
});

test('a cached body AbortError without a caller signal remains a cancellation, not invalid content', async () => {
  const { context, warnings } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=cache-body-abort&size=480&v=epoch-1';
  let blobReads = 0;
  let fetchCount = 0;
  let deleteCount = 0;
  const cachedResponse = {
    ok: true,
    status: 200,
    headers: { get() { return 'image/png'; } },
    async blob() {
      blobReads += 1;
      if (blobReads === 1) {
        const error = new Error('cached body read was cancelled');
        error.name = 'AbortError';
        throw error;
      }
      return { id: 'reusable-after-body-abort', size: 64, type: 'image/png' };
    },
  };
  const cache = {
    async keys() { return []; },
    async match() { return cachedResponse; },
    async delete() { deleteCount += 1; return true; },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => { fetchCount += 1; return createResponse('unexpected-network'); },
    urlApi: { createObjectURL(blob) { return `blob:${blob.id}`; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  await assert.rejects(previewCache.resolve(productionUrl), { name: 'AbortError' });

  assert.equal(deleteCount, 0);
  assert.equal(warnings.length, 0, 'a cancelled body read must not be diagnosed as invalid cache content');

  const reused = await previewCache.resolve(productionUrl);

  assert.equal(reused.displayUrl, 'blob:reusable-after-body-abort');
  assert.equal(reused.cached, true);
  assert.equal(blobReads, 2);
  assert.equal(fetchCount, 0, 'a cancelled cached body read must not force a production refetch');
});

test('cache write failure displays the fetched blob without issuing a second cover request', async () => {
  const { context, warnings } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=quota&size=480&v=epoch-1';
  const putGate = deferredHost();
  let fetchCount = 0;
  let putStarted = false;
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() {
            putStarted = true;
            await putGate.promise;
            throw new Error('Quota exceeded');
          },
        };
      },
    },
    fetchImpl: async () => { fetchCount += 1; return createResponse('quota'); },
    urlApi: { createObjectURL() { return 'blob:quota'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const foreground = previewCache.resolve(productionUrl);
  while (!putStarted) await new Promise((resolve) => setImmediate(resolve));
  const result = await foreground;

  assert.equal(result.displayUrl, 'blob:quota');
  assert.equal(fetchCount, 1);
  assert.equal(previewCache.diagnostics.writeFailureCount, 0, 'foreground display must not wait for cache.put rejection');
  const durableCompletion = previewCache.prefetch(productionUrl);
  putGate.resolve();
  const prefetchResult = await durableCompletion;

  assert.equal(prefetchResult.cached, false, 'failed Cache Storage writes must not report background completion as cached');
  assert.equal(previewCache.diagnostics.writeFailureCount, 1);
  assert.match(previewCache.diagnostics.lastWriteFailure.message, /Quota exceeded/);
  assert.equal(warnings.length, 1);
  assert.equal((await previewCache.resolve(productionUrl)).displayUrl, 'blob:quota');
  assert.equal(fetchCount, 1, 'an active foreground object URL must not issue a second request after cache.put rejection');
});

test('background prefetch waits for the durable Cache Storage write without allocating an object URL', async () => {
  const { context } = createContext();
  const putGate = deferredHost();
  let objectUrlCount = 0;
  let putStarted = false;
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() { putStarted = true; await putGate.promise; },
        };
      },
    },
    fetchImpl: async () => createResponse('background'),
    urlApi: { createObjectURL() { objectUrlCount += 1; return 'blob:background'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  let settled = false;
  const pending = previewCache.prefetch('http://127.0.0.1:4173/cover?path=background&size=480&v=epoch-1')
    .finally(() => { settled = true; });
  while (!putStarted) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'background completion must remain pending until cache.put completes');
  putGate.resolve();
  const result = await pending;

  assert.equal(result.cached, true);
  assert.equal(objectUrlCount, 0);
  assert.equal(previewCache.activeObjectUrls.size, 0);
});

test('same-image same-URL requests use tokens so an older completion cannot overwrite the newer request', () => {
  const { context } = createContext();
  const image = new context.HTMLImageElement();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=same&size=480&v=epoch-1';
  const older = context.beginGalleryCoverImageRequest(image, productionUrl);
  const newer = context.beginGalleryCoverImageRequest(image, productionUrl);

  assert.equal(image.getAttribute('data-cover-visual-state'), 'pending');
  assert.equal(image.getAttribute('aria-hidden'), 'true');

  assert.equal(context.commitGalleryCoverImageRequest(older, { displayUrl: 'blob:older', productionUrl }), false);
  assert.equal(context.commitGalleryCoverImageRequest(newer, { displayUrl: 'blob:newer', productionUrl }), true);
  assert.equal(image.src, 'blob:newer');
});

test('per-key invalidation during fetch prevents stale cache.put and object URL creation', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=refreshing&size=480&v=epoch-1';
  const gate = deferredHost();
  let putCount = 0;
  let objectUrlCount = 0;
  const cache = {
    async keys() { return []; },
    async match() { return null; },
    async put() { putCount += 1; },
    async delete() { return true; },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => {
      await gate.promise;
      return createResponse('refreshing');
    },
    urlApi: { createObjectURL() { objectUrlCount += 1; return 'blob:stale'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const pending = previewCache.resolve(productionUrl);
  await new Promise((resolve) => setImmediate(resolve));
  await previewCache.invalidate(productionUrl);
  gate.resolve();
  const result = await pending;

  assert.equal(result.displayUrl, productionUrl);
  assert.equal(putCount, 0);
  assert.equal(objectUrlCount, 0);
});

test('first use of a pinned epoch removes superseded Cache Storage entries for the same base cover URL', async () => {
  const { context } = createContext();
  const currentUrl = 'http://127.0.0.1:4173/cover?path=pinned&size=480&v=epoch-7';
  const staleUrl = 'http://127.0.0.1:4173/cover?path=pinned&size=480&v=epoch-6';
  const unrelatedUrl = 'http://127.0.0.1:4173/cover?path=other&size=480&v=epoch-6';
  const deleted = [];
  const cache = {
    async keys() { return [{ url: staleUrl }, { url: unrelatedUrl }]; },
    async match() { return null; },
    async delete(request) { deleted.push(String(request?.url || request)); return true; },
    async put() {},
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => createResponse('pinned'),
    urlApi: { createObjectURL() { return 'blob:pinned'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  await previewCache.resolve(currentUrl);
  await Promise.all([...previewCache.writeChains.values()]);

  assert.deepEqual(deleted, [staleUrl]);
});

test('concurrent cover epochs serialize purge and put ownership by their unversioned base key', async () => {
  const { context } = createContext();
  const firstUrl = 'http://127.0.0.1:4173/cover?path=shared-epoch&size=480&v=epoch-1';
  const secondUrl = 'http://127.0.0.1:4173/cover?path=shared-epoch&size=480&v=epoch-2';
  const firstPutGate = deferredHost();
  const stored = new Map();
  const events = [];
  const cache = {
    async keys() { return [...stored.keys()].map((url) => ({ url })); },
    async match(key) { return stored.get(String(key)) || null; },
    async put(key, response) {
      const normalizedKey = String(key);
      events.push(`put:${normalizedKey}:start`);
      if (normalizedKey === firstUrl) await firstPutGate.promise;
      stored.set(normalizedKey, response);
      events.push(`put:${normalizedKey}:stored`);
    },
    async delete(key) {
      const normalizedKey = String(key?.url || key);
      events.push(`delete:${normalizedKey}`);
      return stored.delete(normalizedKey);
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async (url) => createResponse(String(url).includes('epoch-1') ? 'v1' : 'v2'),
    urlApi: { createObjectURL(blob) { return `blob:${blob.id}`; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const firstPrefetch = previewCache.prefetch(firstUrl);
  await waitUntil(() => events.includes(`put:${firstUrl}:start`));
  const secondPrefetch = previewCache.prefetch(secondUrl);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    events.includes(`put:${secondUrl}:start`),
    false,
    'a new epoch for the same cover must wait for the current base-key write owner',
  );

  firstPutGate.resolve();
  const [firstResult, secondResult] = await Promise.all([firstPrefetch, secondPrefetch]);

  assert.equal(firstResult.cached, false, 'a superseded epoch must not report durable ownership');
  assert.equal(secondResult.cached, true);
  assert.deepEqual([...stored.keys()], [secondUrl]);
  assert.deepEqual(events, [
    `put:${firstUrl}:start`,
    `put:${firstUrl}:stored`,
    `delete:${firstUrl}`,
    `put:${secondUrl}:start`,
    `put:${secondUrl}:stored`,
  ]);
});

test('a delayed old epoch cannot overwrite a newer epoch whose response completes first', async () => {
  const { context } = createContext();
  const firstUrl = 'http://127.0.0.1:4173/cover?path=inverted-epoch&size=480&v=epoch-1';
  const secondUrl = 'http://127.0.0.1:4173/cover?path=inverted-epoch&size=480&v=epoch-2';
  const firstResponseGate = deferredHost();
  const firstRequestStarted = deferredHost();
  const stored = new Map();
  const events = [];
  let fetchCount = 0;
  const cache = {
    async keys() { return [...stored.keys()].map((url) => ({ url })); },
    async match(key) { return stored.get(String(key)) || null; },
    async put(key, response) {
      const normalizedKey = String(key);
      events.push(`put:${normalizedKey}`);
      stored.set(normalizedKey, response);
    },
    async delete(key) {
      const normalizedKey = String(key?.url || key);
      events.push(`delete:${normalizedKey}`);
      return stored.delete(normalizedKey);
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async (url) => {
      fetchCount += 1;
      if (String(url) === firstUrl) {
        firstRequestStarted.resolve();
        await firstResponseGate.promise;
        return createResponse('v1');
      }
      return createResponse('v2');
    },
    urlApi: { createObjectURL(blob) { return `blob:${blob.id}`; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const firstPrefetch = previewCache.prefetch(firstUrl);
  await firstRequestStarted.promise;
  const secondResult = await previewCache.prefetch(secondUrl);
  assert.equal(secondResult.cached, true);

  firstResponseGate.resolve();
  const firstResult = await firstPrefetch;
  const exactCurrent = await previewCache.resolve(secondUrl);

  assert.equal(firstResult.cached, false, 'the obsolete response must not claim durable cache ownership');
  assert.equal(exactCurrent.displayUrl, 'blob:v2');
  assert.equal(fetchCount, 2, 'the exact current epoch must resolve from its durable entry');
  assert.deepEqual(events, [`put:${secondUrl}`]);
  assert.deepEqual([...stored.keys()], [secondUrl]);
});

test('a later cover epoch purges the previously current sibling after earlier cleanup completed', async () => {
  const { context } = createContext();
  const firstUrl = 'http://127.0.0.1:4173/cover?path=later-epoch&size=480&v=epoch-1';
  const secondUrl = 'http://127.0.0.1:4173/cover?path=later-epoch&size=480&v=epoch-2';
  const thirdUrl = 'http://127.0.0.1:4173/cover?path=later-epoch&size=480&v=epoch-3';
  const stored = new Map([[firstUrl, createResponse('v1')]]);
  const deleted = [];
  const cache = {
    async keys() { return [...stored.keys()].map((url) => ({ url })); },
    async match(key) { return stored.get(String(key)) || null; },
    async put(key, response) { stored.set(String(key), response); },
    async delete(key) {
      const normalizedKey = String(key?.url || key);
      deleted.push(normalizedKey);
      return stored.delete(normalizedKey);
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async (url) => createResponse(String(url).includes('epoch-2') ? 'v2' : 'v3'),
    urlApi: { createObjectURL(blob) { return `blob:${blob.id}`; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const secondResult = await previewCache.prefetch(secondUrl);
  const thirdResult = await previewCache.prefetch(thirdUrl);

  assert.equal(secondResult.cached, true);
  assert.equal(thirdResult.cached, true);
  assert.deepEqual(deleted, [firstUrl, secondUrl]);
  assert.deepEqual([...stored.keys()], [thirdUrl]);
});

test('foreground resolves before cache.put, then invalidation revokes it and deletes the late write before refetch', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=late-put&size=480&v=epoch-1';
  const putGate = deferredHost();
  const stored = new Map();
  const lateDelete = deferredHost();
  const revoked = [];
  let fetchCount = 0;
  let gateFirstPut = true;
  let putStarted = false;
  const cache = {
    async keys() { return []; },
    async match(key) { return stored.get(String(key)) || null; },
    async put(key, response) {
      if (gateFirstPut) {
        gateFirstPut = false;
        putStarted = true;
        await putGate.promise;
      }
      stored.set(String(key), response);
    },
    async delete(key) {
      const deleted = stored.delete(String(key?.url || key));
      if (deleted) lateDelete.resolve();
      return deleted;
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => { fetchCount += 1; return createResponse(`fetch-${fetchCount}`); },
    urlApi: {
      createObjectURL() { return `blob:${fetchCount}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const foreground = previewCache.resolve(productionUrl);
  while (!putStarted) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await foreground).displayUrl, 'blob:1', 'foreground display must resolve while cache.put is pending');
  assert.equal(previewCache.hasActive(productionUrl), true);
  await previewCache.invalidate(productionUrl);
  assert.deepEqual(revoked, ['blob:1']);
  assert.equal(previewCache.hasActive(productionUrl), false);
  putGate.resolve();
  await lateDelete.promise;
  assert.equal(stored.has(productionUrl), false, 'the post-put generation check must delete the resurrected stale entry');

  assert.equal((await previewCache.resolve(productionUrl)).displayUrl, 'blob:2');
  assert.equal(fetchCount, 2, 'absence of the stale persistent entry must force a fresh production request');
});

test('aborted background prefetch does not populate Cache Storage', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=aborted&size=480&v=epoch-1';
  let putCount = 0;
  const controller = new AbortController();
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() { putCount += 1; },
        };
      },
    },
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const pending = previewCache.prefetch(productionUrl, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;

  assert.equal(result.cancelled, true);
  assert.equal(result.cached, false);
  assert.equal(putCount, 0);
});

test('modal-style abortInFlight prevents a late foreground blob from creating an object URL or cache write', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=modal-abort&size=480&v=epoch-1';
  const blobGate = deferredHost();
  let blobStarted = false;
  let putCount = 0;
  let objectUrlCount = 0;
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: {
      async keys() { return []; },
      async open() {
        return {
          async keys() { return []; },
          async match() { return null; },
          async put() { putCount += 1; },
        };
      },
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return 'image/png'; } },
      clone() { return createResponse('modal-abort-clone'); },
      async blob() {
        blobStarted = true;
        await blobGate.promise;
        return { id: 'modal-abort', size: 64, type: 'image/png' };
      },
    }),
    urlApi: {
      createObjectURL() { objectUrlCount += 1; return 'blob:must-not-commit'; },
    },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const pending = previewCache.resolve(productionUrl);
  while (!blobStarted) await new Promise((resolve) => setImmediate(resolve));
  previewCache.abortInFlight();
  blobGate.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(objectUrlCount, 0);
  assert.equal(putCount, 0);
  assert.equal(previewCache.hasActive(productionUrl), false);
  assert.equal(previewCache.inFlight.size, 0);
});

test('destroy during cache.put deletes the late persistent write', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=destroy-put&size=480&v=epoch-1';
  const putGate = deferredHost();
  const stored = new Map();
  const cache = {
    async keys() { return []; },
    async match(key) { return stored.get(String(key)) || null; },
    async put(key, response) { await putGate.promise; stored.set(String(key), response); },
    async delete(key) { return stored.delete(String(key?.url || key)); },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => createResponse('destroy-put'),
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const pending = previewCache.resolve(productionUrl);
  await new Promise((resolve) => setImmediate(resolve));
  previewCache.destroy();
  previewCache.destroy();
  previewCache.abortInFlight();
  putGate.resolve();
  await pending;
  await Promise.all([...previewCache.writeChains.values()]);

  assert.equal(stored.has(productionUrl), false);
  assert.equal(previewCache.activeObjectUrls.size, 0);
});

test('abort during cache.put releases the prefetch caller immediately and cleans the late write', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=abort-put&size=480&v=epoch-1';
  const putGate = deferredHost();
  const stored = new Map();
  const controller = new AbortController();
  let putStarted = false;
  const cache = {
    async keys() { return []; },
    async match() { return null; },
    async put(key, response) { putStarted = true; await putGate.promise; stored.set(String(key), response); },
    async delete(key) { return stored.delete(String(key?.url || key)); },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => createResponse('abort-put'),
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const pending = previewCache.prefetch(productionUrl, { signal: controller.signal });
  while (!putStarted) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await pending;
  assert.equal(result.cancelled, true, 'the scheduler-facing promise must release without waiting for Cache Storage');

  putGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stored.has(productionUrl), false, 'the late completed write must be removed after cancellation');
});

test('same-key cache writes wait for stale cleanup before the resumed durable write begins', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=same-key-owner&size=480&v=epoch-1';
  const oldPutGate = deferredHost();
  const newPutGate = deferredHost();
  const oldController = new AbortController();
  const stored = new Map();
  const events = [];
  let fetchCount = 0;
  const cache = {
    async keys() { return []; },
    async match(key) { return stored.get(String(key)) || null; },
    async put(key, response) {
      const { id } = await response.blob();
      events.push(`put:${id}:start`);
      await (id === 'old' ? oldPutGate.promise : newPutGate.promise);
      stored.set(String(key), response);
      events.push(`put:${id}:stored`);
    },
    async delete(key) {
      const normalizedKey = String(key?.url || key);
      const response = stored.get(normalizedKey);
      const id = response ? (await response.blob()).id : 'missing';
      events.push(`delete:${id}`);
      return stored.delete(normalizedKey);
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => {
      fetchCount += 1;
      return createResponse(fetchCount === 1 ? 'old' : 'new');
    },
    urlApi: { createObjectURL(blob) { return `blob:${blob.id}`; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const oldPrefetch = previewCache.prefetch(productionUrl, { signal: oldController.signal });
  await waitUntil(() => events.includes('put:old:start'));
  oldController.abort();
  const oldResult = await oldPrefetch;
  assert.equal(oldResult.productionUrl, productionUrl);
  assert.equal(oldResult.cached, false);
  assert.equal(
    oldResult.cancelled,
    true,
    'the suspended caller should release while its stale durable write is still pending',
  );

  const resumedPrefetch = previewCache.prefetch(productionUrl);
  await waitUntil(() => fetchCount === 2);
  assert.equal(
    events.includes('put:new:start'),
    false,
    'the resumed same-key write must not overtake the old write owner',
  );

  oldPutGate.resolve();
  await waitUntil(() => events.includes('put:new:start'));
  assert.deepEqual(
    events.slice(0, 4),
    ['put:old:start', 'put:old:stored', 'delete:old', 'put:new:start'],
    'stale cleanup must finish before the successor receives same-key write ownership',
  );

  newPutGate.resolve();
  const resumedResult = await resumedPrefetch;
  assert.equal(resumedResult.productionUrl, productionUrl);
  assert.equal(resumedResult.cached, true);
  const resolved = await previewCache.resolve(productionUrl);

  assert.equal(resolved.displayUrl, 'blob:new');
  assert.equal(fetchCount, 2, 'the successor must remain durable and satisfy the next resolve without another fetch');
  assert.equal((await stored.get(productionUrl).blob()).id, 'new');
});

test('different-key cache writes retain parallel ownership', async () => {
  const { context } = createContext();
  const firstUrl = 'http://127.0.0.1:4173/cover?path=parallel-a&size=480&v=epoch-1';
  const secondUrl = 'http://127.0.0.1:4173/cover?path=parallel-b&size=480&v=epoch-1';
  const gates = new Map([
    [firstUrl, deferredHost()],
    [secondUrl, deferredHost()],
  ]);
  const started = [];
  const cache = {
    async keys() { return []; },
    async match() { return null; },
    async put(key) {
      const normalizedKey = String(key);
      started.push(normalizedKey);
      await gates.get(normalizedKey).promise;
    },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async (url) => createResponse(String(url)),
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const firstPrefetch = previewCache.prefetch(firstUrl);
  const secondPrefetch = previewCache.prefetch(secondUrl);
  await waitUntil(() => started.length === 2);

  assert.deepEqual(new Set(started), new Set([firstUrl, secondUrl]));
  gates.get(firstUrl).resolve();
  gates.get(secondUrl).resolve();
  const [firstResult, secondResult] = await Promise.all([firstPrefetch, secondPrefetch]);
  assert.equal(firstResult.productionUrl, firstUrl);
  assert.equal(firstResult.cached, true);
  assert.equal(secondResult.productionUrl, secondUrl);
  assert.equal(secondResult.cached, true);
});

test('a same-key write cancelled before its ownership turn skips cache.put', async () => {
  const { context } = createContext();
  const productionUrl = 'http://127.0.0.1:4173/cover?path=cancelled-before-turn&size=480&v=epoch-1';
  const oldPutGate = deferredHost();
  const oldController = new AbortController();
  const queuedController = new AbortController();
  const stored = new Map();
  const putIds = [];
  let fetchCount = 0;
  const cache = {
    async keys() { return []; },
    async match() { return null; },
    async put(key, response) {
      const { id } = await response.blob();
      putIds.push(id);
      if (id === 'old') await oldPutGate.promise;
      stored.set(String(key), response);
    },
    async delete(key) { return stored.delete(String(key?.url || key)); },
  };
  const previewCache = new context.GalleryCoverPreviewCache({
    cacheStorage: { async keys() { return []; }, async open() { return cache; } },
    fetchImpl: async () => {
      fetchCount += 1;
      return createResponse(fetchCount === 1 ? 'old' : 'queued');
    },
    urlApi: { createObjectURL() { return 'blob:unused'; } },
    locationOrigin: 'http://127.0.0.1:4173',
  });

  const oldPrefetch = previewCache.prefetch(productionUrl, { signal: oldController.signal });
  await waitUntil(() => putIds.includes('old'));
  const baseKey = previewCache.baseCacheKey(productionUrl);
  const oldWrite = previewCache.writeChains.get(baseKey);
  oldController.abort();
  assert.equal((await oldPrefetch).cancelled, true);

  const queuedPrefetch = previewCache.prefetch(productionUrl, { signal: queuedController.signal });
  await waitUntil(() => (
    fetchCount === 2
    && previewCache.writeChains.get(baseKey) !== oldWrite
  ));
  queuedController.abort();
  assert.equal((await queuedPrefetch).cancelled, true);

  oldPutGate.resolve();
  await waitUntil(() => previewCache.writeChains.has(baseKey) === false);

  assert.deepEqual(putIds, ['old'], 'the cancelled queued owner must be rejected before cache.put');
  assert.equal(stored.has(productionUrl), false, 'the old cancelled owner must still clean its late write');
});

function deferredHost() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate) {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}
