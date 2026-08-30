const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const schedulerPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'gallery-cover-load-scheduler.js');
const schedulerSource = fs.readFileSync(schedulerPath, 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate) {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

function createScheduler(cache, options = {}) {
  const committed = [];
  const context = {
    AbortController,
    Map,
    Object,
    Promise,
    galleryCoverPreviewCache: cache,
    beginGalleryCoverImageRequest(image, productionUrl) { return { image, productionUrl, requestToken: Symbol() }; },
    commitGalleryCoverImageRequest(request, result) {
      committed.push([request.image.id, result.productionUrl]);
      return true;
    },
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(schedulerSource, context, { filename: schedulerPath });
  const Scheduler = vm.runInContext('GalleryCoverLoadScheduler', context);
  return { scheduler: new Scheduler({ cache, ...options }), committed };
}

function normalizer(value) { return String(value); }

function createTrackedImage(id) {
  const attributes = new Map([['data-gallery-cover-loading', '1']]);
  return {
    id,
    attributes,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) || null; },
  };
}

function createPreemptibleScheduler(cache, options = {}) {
  const { onCommit = null, ...schedulerOptions } = options;
  const committed = [];
  const restored = [];
  const tokens = new WeakMap();
  const context = {
    AbortController,
    Map,
    Object,
    Promise,
    galleryCoverPreviewCache: cache,
    beginGalleryCoverImageRequest(image, productionUrl) {
      const requestToken = Number(tokens.get(image) || 0) + 1;
      tokens.set(image, requestToken);
      image.setAttribute('data-production-cover-src', productionUrl);
      return { image, productionUrl, requestToken };
    },
    commitGalleryCoverImageRequest(request, result) {
      if (tokens.get(request.image) !== request.requestToken) return false;
      request.image.setAttribute('data-production-cover-src', result.productionUrl);
      request.image.src = result.displayUrl;
      committed.push([request.image.id, result.productionUrl, request.requestToken]);
      onCommit?.(request, result);
      return true;
    },
    restoreGalleryCoverImageRequest(request) {
      if (tokens.get(request.image) !== request.requestToken) return null;
      tokens.set(request.image, request.requestToken + 1);
      request.image.setAttribute('data-gallery-cover-src', request.productionUrl);
      request.image.removeAttribute('data-gallery-cover-loading');
      restored.push([request.image.id, request.requestToken]);
      return request.image;
    },
    globalThis: null,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(schedulerSource, context, { filename: schedulerPath });
  const Scheduler = vm.runInContext('GalleryCoverLoadScheduler', context);
  return {
    scheduler: new Scheduler({ cache, ...schedulerOptions }),
    committed,
    restored,
    tokenFor(image) { return Number(tokens.get(image) || 0); },
  };
}

test('production default starts two visible covers and waits for a settlement before the third', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const starts = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      const index = starts.length;
      starts.push(url);
      await gates[index].promise;
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler } = createScheduler(cache);
  const pending = ['a', 'b', 'c'].map((url) => (
    scheduler.enqueue(url, { priority: 'visible', image: { id: url } })
  ));

  try {
    await Promise.resolve();
    assert.deepEqual(starts, ['a', 'b']);

    gates[0].resolve();
    await waitUntil(() => starts.length === 3);
    assert.deepEqual(starts, ['a', 'b', 'c']);
  } finally {
    gates.forEach((gate) => gate.resolve());
    await Promise.all(pending);
  }
});

test('visible cover work starts concurrently up to the configured global limit', async () => {
  const gates = [deferred(), deferred(), deferred()];
  const starts = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { const index = starts.length; starts.push(url); await gates[index].promise; return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 3, maxBackgroundConcurrency: 1 });
  const pending = ['a', 'b', 'c'].map((url) => scheduler.enqueue(url, { priority: 'visible', image: { id: url } }));
  await Promise.resolve();
  assert.deepEqual(starts, ['a', 'b', 'c']);
  gates.forEach((gate) => gate.resolve());
  await Promise.all(pending);
});

test('scheduler passes production priority intent to cache network owners', async () => {
  const priorities = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url, options) {
      priorities.push([url, options.priority]);
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url, options) {
      priorities.push([url, options.priority]);
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 2, maxBackgroundConcurrency: 1 });

  await Promise.all([
    scheduler.enqueue('visible', { priority: 'visible', image: { id: 'visible' } }),
    scheduler.enqueue('family', { priority: 'background' }),
  ]);

  assert.deepEqual(priorities, [['visible', 'foreground'], ['family', 'background']]);
});

test('visible then near work runs before queued background work', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const starts = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { const index = starts.length; starts.push(url); await gates[index].promise; return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) { const index = starts.length; starts.push(url); await gates[index].promise; return { cached: true, productionUrl: url }; },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 1, maxBackgroundConcurrency: 1 });
  const first = scheduler.enqueue('blocker', { priority: 'visible', image: { id: 'blocker' } });
  const background = scheduler.enqueue('background', { priority: 'background' });
  const near = scheduler.enqueue('near', { priority: 'near', image: { id: 'near' } });
  const visible = scheduler.enqueue('visible', { priority: 'visible', image: { id: 'visible' } });
  gates[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts.slice(0, 2), ['blocker', 'visible']);
  gates[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts[2], 'near');
  gates[2].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts[3], 'background');
  gates[3].resolve();
  await Promise.all([first, background, near, visible]);
});

test('background cover work waits for complete foreground idle and resumes immediately afterward', async () => {
  const foregroundGate = deferred();
  const backgroundGates = [deferred(), deferred()];
  const events = [];
  let activeForeground = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      activeForeground += 1;
      events.push(`foreground:${url}:start`);
      await foregroundGate.promise;
      events.push(`foreground:${url}:end`);
      activeForeground -= 1;
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url) {
      assert.equal(activeForeground, 0, 'background work must never overlap foreground cover work');
      const index = events.filter((event) => event.startsWith('background:')).length;
      events.push(`background:${url}:start`);
      await backgroundGates[index].promise;
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 6, maxBackgroundConcurrency: 2 });

  const foreground = scheduler.enqueue('visible', { priority: 'visible', image: { id: 'visible' } });
  const backgrounds = [
    scheduler.enqueue('family-a', { priority: 'background' }),
    scheduler.enqueue('family-b', { priority: 'background' }),
  ];
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, ['foreground:visible:start']);
  assert.equal(scheduler.foregroundState().idle, false);
  foregroundGate.resolve();
  await foreground;
  await waitUntil(() => events.filter((event) => event.startsWith('background:')).length === 2);
  assert.deepEqual(events.slice(1), [
    'foreground:visible:end',
    'background:family-a:start',
    'background:family-b:start',
  ]);

  backgroundGates.forEach((gate) => gate.resolve());
  await Promise.all(backgrounds);
});

test('new foreground work preempts active background ownership and stays ahead of queued background work', async () => {
  const foregroundGate = deferred();
  const backgroundRetryGates = [deferred(), deferred()];
  const attempts = new Map();
  const events = [];
  let foregroundActive = false;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      foregroundActive = true;
      events.push(`foreground:${url}:start`);
      await foregroundGate.promise;
      events.push(`foreground:${url}:end`);
      foregroundActive = false;
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url, options) {
      const attempt = Number(attempts.get(url) || 0) + 1;
      attempts.set(url, attempt);
      events.push(`background:${url}:${attempt}:start`);
      assert.equal(foregroundActive, false);
      if (url === 'family-a' && attempt === 1) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            events.push(`background:${url}:${attempt}:abort`);
            const error = new Error('foreground preemption');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      await backgroundRetryGates[url === 'family-a' ? 0 : 1].promise;
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 2, maxBackgroundConcurrency: 1 });
  const firstBackground = scheduler.enqueue('family-a', { priority: 'background' });
  const queuedBackground = scheduler.enqueue('family-b', { priority: 'background' });
  await waitUntil(() => events.includes('background:family-a:1:start'));

  const foreground = scheduler.enqueue('visible', { priority: 'visible', image: { id: 'visible' } });
  await waitUntil(() => events.includes('foreground:visible:start'));
  assert.deepEqual(events, [
    'background:family-a:1:start',
    'background:family-a:1:abort',
    'foreground:visible:start',
  ]);

  foregroundGate.resolve();
  await foreground;
  await waitUntil(() => attempts.get('family-b') === 1);
  assert.equal(events.indexOf('foreground:visible:end') < events.indexOf('background:family-b:1:start'), true);
  backgroundRetryGates[1].resolve();
  await waitUntil(() => attempts.get('family-a') === 2);
  assert.equal(events.indexOf('foreground:visible:end') < events.indexOf('background:family-a:2:start'), true);
  backgroundRetryGates[0].resolve();
  await Promise.all([firstBackground, queuedBackground]);
});

test('foreground arrival records every active background preemption immediately before abort exactly once', async () => {
  const attempts = new Map();
  const events = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    recordInFlightPreemption(url, reason) {
      events.push(`record:${url}:${reason}`);
    },
    async resolve(url) {
      events.push(`foreground:${url}:start`);
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url, options) {
      const attempt = Number(attempts.get(url) || 0) + 1;
      attempts.set(url, attempt);
      events.push(`background:${url}:${attempt}:start`);
      if (attempt > 1 || url === 'family-c') return { cached: true, productionUrl: url };
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          events.push(`abort:${url}`);
          const error = new Error('foreground preemption');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  };
  const { scheduler } = createScheduler(cache, {
    maxConcurrency: 3,
    maxBackgroundConcurrency: 2,
  });
  const backgrounds = [
    scheduler.enqueue('family-a', { priority: 'background' }),
    scheduler.enqueue('family-b', { priority: 'background' }),
    scheduler.enqueue('family-c', { priority: 'background' }),
  ];
  await waitUntil(() => (
    events.includes('background:family-a:1:start')
    && events.includes('background:family-b:1:start')
  ));

  const foreground = scheduler.enqueue('visible', {
    priority: 'visible',
    image: { id: 'visible' },
  });
  await foreground;
  await Promise.all(backgrounds);

  const preemptionEvents = events.filter((event) => (
    event.startsWith('record:') || event.startsWith('abort:')
  ));
  assert.deepEqual(preemptionEvents, [
    'record:family-a:foreground-promotion',
    'abort:family-a',
    'record:family-b:foreground-promotion',
    'abort:family-b',
  ]);
  assert.equal(
    events.some((event) => event === 'record:family-c:foreground-promotion'),
    false,
    'queued background work must not receive an in-flight preemption record',
  );
  assert.equal(
    events.some((event) => event === 'record:visible:foreground-promotion'),
    false,
    'foreground work must not receive a background preemption record',
  );
});

test('generation change cancels queued obsolete family background work', async () => {
  const gate = deferred();
  const starts = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { starts.push(url); await gate.promise; return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) { starts.push(url); return { cached: true, productionUrl: url }; },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 1, maxBackgroundConcurrency: 1 });
  const blocker = scheduler.enqueue('blocker', { priority: 'visible', image: { id: 'blocker' } });
  const obsolete = scheduler.enqueue('old-family', { priority: 'background' });
  scheduler.startGeneration();
  assert.equal((await obsolete).cancelled, true);
  gate.resolve();
  await blocker;
  assert.deepEqual(starts, ['blocker']);
});

test('rapid generation change removes disconnected old consumers and releases foreground slots', async () => {
  const starts = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    resolve(url, options = {}) {
      starts.push(url);
      if (url === 'new-visible') {
        return Promise.resolve({ displayUrl: 'blob:new-visible', productionUrl: url });
      }
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler } = createPreemptibleScheduler(cache, {
    maxConcurrency: 2,
    maxBackgroundConcurrency: 1,
  });
  const oldImages = ['old-a', 'old-b', 'old-c'].map(createTrackedImage);
  const oldPromises = oldImages.map((image) => scheduler.enqueue(image.id, {
    image,
    priority: 'visible',
  }));
  await waitUntil(() => starts.length === 2);

  const generation = scheduler.startGeneration();
  oldImages.forEach((image) => { image.isConnected = false; });
  scheduler.pruneObsoleteConsumerTasks(generation);
  const newImage = createTrackedImage('new-visible');
  newImage.isConnected = true;
  const current = scheduler.enqueue('new-visible', {
    generation,
    image: newImage,
    priority: 'visible',
  });

  await waitUntil(() => starts.includes('new-visible'));
  assert.deepEqual(starts, ['old-a', 'old-b', 'new-visible']);
  assert.equal((await current).cancelled, false);
  const oldResults = await Promise.all(oldPromises);
  assert.equal(oldResults.every((result) => result.cancelled), true);
  assert.equal(scheduler.activeCount, 0);
});

test('generation pruning authenticates a started disconnected cover before aborting it', async () => {
  const events = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    recordInFlightPreemption(url, reason) {
      events.push(`record:${url}:${reason}`);
    },
    resolve(url, options = {}) {
      events.push(`start:${url}`);
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          events.push(`abort:${url}`);
          const error = new Error('render generation changed');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler } = createPreemptibleScheduler(cache, {
    maxConcurrency: 1,
    maxBackgroundConcurrency: 1,
  });
  const obsoleteImage = createTrackedImage('obsolete-cover');
  obsoleteImage.isConnected = true;
  const obsolete = scheduler.enqueue('obsolete-cover', {
    image: obsoleteImage,
    priority: 'visible',
  });
  await waitUntil(() => events.includes('start:obsolete-cover'));

  const generation = scheduler.startGeneration();
  obsoleteImage.isConnected = false;
  scheduler.pruneObsoleteConsumerTasks(generation);

  assert.equal((await obsolete).cancelled, true);
  assert.deepEqual(events, [
    'start:obsolete-cover',
    'record:obsolete-cover:render-generation-preemption',
    'abort:obsolete-cover',
  ]);
});

test('generation validation retains a connected current-card task for same-URL dedupe', async () => {
  const gate = deferred();
  let fetchCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      fetchCount += 1;
      await gate.promise;
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler } = createPreemptibleScheduler(cache, {
    maxConcurrency: 1,
    maxBackgroundConcurrency: 1,
  });
  const retainedImage = createTrackedImage('retained');
  retainedImage.isConnected = true;
  const first = scheduler.enqueue('same-url', { image: retainedImage, priority: 'visible' });
  await waitUntil(() => fetchCount === 1);

  const generation = scheduler.startGeneration();
  scheduler.pruneObsoleteConsumerTasks(generation);
  const attachedImage = createTrackedImage('attached');
  attachedImage.isConnected = true;
  const second = scheduler.enqueue('same-url', {
    generation,
    image: attachedImage,
    priority: 'visible',
  });

  assert.equal(first, second);
  assert.equal(fetchCount, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(fetchCount, 1);
});

test('family prefetch reconciliation stays semantically active before its URL set is scheduled', async () => {
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler } = createScheduler(cache);

  const familyGeneration = scheduler.beginFamilyPrefetchReconciliation();
  assert.equal(
    scheduler.ensureFamilyPrefetchReconciliation(),
    familyGeneration,
    'a render joining an in-flight view reconciliation must retain its lifecycle generation',
  );
  let generationIdleSettled = false;
  const generationIdle = scheduler.whenGenerationIdle().finally(() => { generationIdleSettled = true; });
  await Promise.resolve();
  const taskGeneration = scheduler.startGeneration();
  await Promise.resolve();

  assert.equal(scheduler.diagnostics.familyPrefetchPending, true);
  assert.equal(scheduler.diagnostics.familyPrefetchGeneration, familyGeneration);
  assert.equal(scheduler.diagnostics.completedFamilyPrefetchGeneration, 0);
  assert.equal(scheduler.diagnostics.active, 1, 'semantic activity must cover the payload-reconciliation gap');
  assert.equal(generationIdleSettled, false);

  await scheduler.reconcileFamilyPrefetch([], {
    familyPrefetchGeneration: familyGeneration,
    generation: taskGeneration,
  });
  await generationIdle;

  assert.equal(scheduler.diagnostics.familyPrefetchPending, false);
  assert.equal(scheduler.diagnostics.completedFamilyPrefetchGeneration, familyGeneration);
  assert.equal(scheduler.diagnostics.active, 0);
  assert.equal(generationIdleSettled, true);
});

test('unchanged family URL work survives generation reconciliation and completes only after durability settles', async () => {
  const gate = deferred();
  const starts = [];
  let abortCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url, options) {
      starts.push(url);
      options.signal.addEventListener('abort', () => { abortCount += 1; }, { once: true });
      await gate.promise;
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 1, maxBackgroundConcurrency: 1 });
  const firstFamilyGeneration = scheduler.beginFamilyPrefetchReconciliation();
  const firstTaskGeneration = scheduler.startGeneration();
  const firstReconciliation = scheduler.reconcileFamilyPrefetch(['same-family-cover'], {
    familyPrefetchGeneration: firstFamilyGeneration,
    generation: firstTaskGeneration,
  });
  await waitUntil(() => starts.length === 1);

  const nextFamilyGeneration = scheduler.beginFamilyPrefetchReconciliation();
  const nextTaskGeneration = scheduler.startGeneration();
  const nextReconciliation = scheduler.reconcileFamilyPrefetch(['same-family-cover'], {
    familyPrefetchGeneration: nextFamilyGeneration,
    generation: nextTaskGeneration,
  });

  assert.deepEqual(starts, ['same-family-cover'], 'the unchanged production URL must keep one fetch owner');
  assert.equal(abortCount, 0, 'generation reconciliation must not abort unchanged family work');
  assert.equal(scheduler.diagnostics.familyPrefetchPending, true);
  assert.equal(scheduler.diagnostics.completedFamilyPrefetchGeneration, 0);
  gate.resolve();

  const [firstResult, nextResult] = await Promise.all([firstReconciliation, nextReconciliation]);
  assert.equal(firstResult.cancelled, true);
  assert.equal(nextResult.cancelled, false);
  assert.equal(scheduler.diagnostics.familyPrefetchPending, false);
  assert.equal(scheduler.diagnostics.completedFamilyPrefetchGeneration, nextFamilyGeneration);
  assert.equal(abortCount, 0);
});

test('cancelled family reconciliation cannot later publish a completed generation', async () => {
  const gate = deferred();
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) {
      await gate.promise;
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache);
  const familyGeneration = scheduler.beginFamilyPrefetchReconciliation();
  const reconciliation = scheduler.reconcileFamilyPrefetch(['cancelled-cover'], {
    familyPrefetchGeneration: familyGeneration,
  });
  await Promise.resolve();

  assert.equal(scheduler.cancelFamilyPrefetchReconciliation(familyGeneration), true);
  gate.resolve();
  const result = await reconciliation;

  assert.equal(result.cancelled, true);
  assert.equal(scheduler.diagnostics.familyPrefetchPending, false);
  assert.equal(scheduler.diagnostics.activeFamilyPrefetchGeneration, 0);
  assert.equal(scheduler.diagnostics.completedFamilyPrefetchGeneration, 0);
});

test('only the latest URL-set reconciliation can complete a shared family lifecycle', async () => {
  const aGate = deferred();
  const cGate = deferred();
  const starts = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) {
      starts.push(url);
      if (url === 'a') await aGate.promise;
      if (url === 'c') await cGate.promise;
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 2, maxBackgroundConcurrency: 2 });
  const familyGeneration = scheduler.beginFamilyPrefetchReconciliation();
  const firstTaskGeneration = scheduler.startGeneration();
  const first = scheduler.reconcileFamilyPrefetch(['a', 'b'], {
    familyPrefetchGeneration: familyGeneration,
    generation: firstTaskGeneration,
  });
  await waitUntil(() => starts.includes('a') && starts.includes('b'));

  assert.equal(scheduler.ensureFamilyPrefetchReconciliation(), familyGeneration);
  const secondTaskGeneration = scheduler.startGeneration();
  const second = scheduler.reconcileFamilyPrefetch(['a', 'c'], {
    familyPrefetchGeneration: familyGeneration,
    generation: secondTaskGeneration,
  });
  await waitUntil(() => starts.includes('c'));

  aGate.resolve();
  const firstResult = await first;
  assert.equal(firstResult.cancelled, true);
  assert.equal(scheduler.diagnostics.familyPrefetchPending, true);
  assert.equal(scheduler.diagnostics.completedFamilyPrefetchGeneration, 0);

  cGate.resolve();
  const secondResult = await second;
  assert.equal(secondResult.cancelled, false);
  assert.equal(scheduler.diagnostics.familyPrefetchPending, false);
  assert.equal(scheduler.diagnostics.completedFamilyPrefetchGeneration, familyGeneration);
});

test('exact-key requests dedupe and commit one result to every visible consumer', async () => {
  let resolveCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { resolveCount += 1; return { displayUrl: 'blob:same', productionUrl: url }; },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler, committed } = createScheduler(cache, { maxConcurrency: 2 });
  await Promise.all([
    scheduler.enqueue('same', { priority: 'visible', image: { id: 'first' } }),
    scheduler.enqueue('same', { priority: 'visible', image: { id: 'second' } }),
  ]);
  assert.equal(resolveCount, 1);
  assert.deepEqual(committed, [['first', 'same'], ['second', 'same']]);
});

test('live same-URL work accepts a fresh retained-image token and ignores the stale attachment', async () => {
  const resolveGate = deferred();
  let resolveCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      resolveCount += 1;
      await resolveGate.promise;
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler, committed, tokenFor } = createPreemptibleScheduler(cache, { maxConcurrency: 2 });
  const retainedImage = createTrackedImage('retained');

  const staleAttachment = scheduler.enqueue('same', {
    priority: 'visible',
    image: retainedImage,
    generation: 1,
  });
  await Promise.resolve();
  const freshAttachment = scheduler.enqueue('same', {
    priority: 'visible',
    image: retainedImage,
    generation: 2,
  });

  assert.equal(staleAttachment, freshAttachment, 'same-URL work must retain one cache-fetch owner');
  assert.equal(tokenFor(retainedImage), 2);
  resolveGate.resolve();
  await freshAttachment;

  assert.equal(resolveCount, 1);
  assert.deepEqual(committed, [['retained', 'same', 2]]);
  assert.equal(retainedImage.src, 'blob:same');
});

test('foreground ownership drains a fresh same-image token attached after the first request snapshot', async () => {
  const resolveGate = deferred();
  let resolveCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      resolveCount += 1;
      await resolveGate.promise;
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const { scheduler, committed, tokenFor } = createPreemptibleScheduler(cache, { maxConcurrency: 2 });
  const retainedImage = createTrackedImage('late-retained');
  retainedImage.complete = false;
  retainedImage.naturalWidth = 0;
  Object.defineProperty(retainedImage, 'src', {
    configurable: true,
    get() { return this._src || ''; },
    set(value) {
      this._src = String(value);
      this.complete = true;
      this.naturalWidth = 480;
    },
  });

  const firstAttachment = scheduler.enqueue('same-late', {
    priority: 'visible',
    image: retainedImage,
    generation: 1,
  });
  let lateAttachment = null;
  resolveGate.promise.then(() => {
    lateAttachment = scheduler.enqueue('same-late', {
      priority: 'visible',
      image: retainedImage,
      generation: 2,
    });
  });

  resolveGate.resolve();
  await firstAttachment;
  await lateAttachment;

  assert.equal(resolveCount, 1, 'late attachment must stay on the mapped cache owner');
  assert.equal(tokenFor(retainedImage), 2);
  assert.deepEqual(committed, [['late-retained', 'same-late', 2]], 'the stale drained token must not commit');
  assert.equal(retainedImage.src, 'blob:same-late');
  assert.equal(retainedImage.complete, true);
  assert.equal(retainedImage.naturalWidth, 480);
  assert.equal(scheduler.tasks.size, 0);
  assert.equal(scheduler.activeCount, 0);
});

test('nested late attachment after the last foreground commit survives closed-owner deletion', async () => {
  let resolveCount = 0;
  let scheduler;
  let successorPromise = null;
  let scheduledSuccessor = false;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      resolveCount += 1;
      return { displayUrl: `blob:${url}:${resolveCount}`, productionUrl: url };
    },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
  };
  const retainedImage = createTrackedImage('nested-retained');
  const created = createPreemptibleScheduler(cache, {
    maxConcurrency: 2,
    onCommit() {
      if (scheduledSuccessor) return;
      scheduledSuccessor = true;
      Promise.resolve().then(() => Promise.resolve().then(() => {
        successorPromise = scheduler.enqueue('nested-same', {
          priority: 'visible',
          image: retainedImage,
          generation: 2,
        });
      }));
    },
  });
  scheduler = created.scheduler;

  const firstPromise = scheduler.enqueue('nested-same', {
    priority: 'visible',
    image: retainedImage,
    generation: 1,
  });
  await firstPromise;
  await waitUntil(() => successorPromise !== null);
  await successorPromise;

  assert.equal(
    resolveCount === 1 || resolveCount === 2,
    true,
    'nested attachment must drain on the live owner or receive a successor owner',
  );
  assert.equal(created.tokenFor(retainedImage), 2);
  assert.deepEqual(created.committed, [
    ['nested-retained', 'nested-same', 1],
    ['nested-retained', 'nested-same', 2],
  ]);
  assert.equal(scheduler.tasks.size, 0, 'the old identity guard must not strand or delete successor ownership');
});

test('background completion closes ownership before awaiting pre-closure consumers and preserves a successor', async () => {
  const prefetchStarted = deferred();
  const prefetchGate = deferred();
  const firstResolveGate = deferred();
  const successorResolveGate = deferred();
  let resolveCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async prefetch(url) {
      prefetchStarted.resolve();
      await prefetchGate.promise;
      return { cached: true, productionUrl: url };
    },
    async resolve(url) {
      resolveCount += 1;
      await (resolveCount === 1 ? firstResolveGate.promise : successorResolveGate.promise);
      return { displayUrl: `blob:${url}:${resolveCount}`, productionUrl: url };
    },
  };
  const { scheduler, committed, tokenFor } = createPreemptibleScheduler(cache, {
    maxConcurrency: 2,
    maxBackgroundConcurrency: 1,
  });
  const retainedImage = createTrackedImage('background-late');

  const backgroundPromise = scheduler.enqueue('background-same', { priority: 'background' });
  await prefetchStarted.promise;
  const firstConsumer = scheduler.enqueue('background-same', {
    priority: 'visible',
    image: retainedImage,
    generation: 1,
  });
  const oldTask = scheduler.tasks.get('background-same');
  prefetchGate.resolve();
  await waitUntil(() => oldTask.acceptingImageRequests === false);

  const successorPromise = scheduler.enqueue('background-same', {
    priority: 'visible',
    image: retainedImage,
    generation: 2,
  });
  const successorTask = scheduler.tasks.get('background-same');
  assert.notEqual(successorTask, oldTask);
  await waitUntil(() => resolveCount === 2);

  firstResolveGate.resolve();
  await Promise.all([backgroundPromise, firstConsumer]);
  assert.equal(
    scheduler.tasks.get('background-same'),
    successorTask,
    'finishing background owner must not delete the mapped successor',
  );

  successorResolveGate.resolve();
  await successorPromise;
  assert.equal(resolveCount, 2);
  assert.equal(tokenFor(retainedImage), 2);
  assert.deepEqual(committed, [['background-late', 'background-same', 2]]);
  assert.equal(scheduler.tasks.size, 0);
});

test('background work drains fully with at most two concurrent cache-only tasks', async () => {
  const gates = Array.from({ length: 5 }, () => deferred());
  const starts = [];
  let active = 0;
  let peakActive = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) {
      const index = starts.length;
      starts.push(url);
      active += 1;
      peakActive = Math.max(peakActive, active);
      await gates[index].promise;
      active -= 1;
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 6, maxBackgroundConcurrency: 2 });
  const generation = scheduler.generation;
  const pending = ['a', 'b', 'c', 'd', 'e'].map((url) => scheduler.enqueue(url, { priority: 'background', generation }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['a', 'b']);
  for (let index = 0; index < gates.length; index += 1) {
    gates[index].resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(pending);
  await scheduler.whenGenerationIdle(generation);
  assert.equal(starts.length, 5);
  assert.equal(peakActive, 2);
});

test('queued same-key background work promotes atomically to foreground without duplicate work', async () => {
  const blockerGate = deferred();
  const calls = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { calls.push(`resolve:${url}`); if (url === 'blocker') await blockerGate.promise; return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) { calls.push(`prefetch:${url}`); return { cached: true, productionUrl: url }; },
  };
  const { scheduler, committed } = createScheduler(cache, { maxConcurrency: 1, maxBackgroundConcurrency: 1 });
  const blocker = scheduler.enqueue('blocker', { priority: 'visible', image: { id: 'blocker' } });
  const background = scheduler.enqueue('same', { priority: 'background' });
  const foreground = scheduler.enqueue('same', { priority: 'visible', image: { id: 'same' } });
  assert.equal(background, foreground);
  blockerGate.resolve();
  await Promise.all([blocker, foreground]);
  assert.deepEqual(calls, ['resolve:blocker', 'resolve:same']);
  assert.deepEqual(committed.at(-1), ['same', 'same']);
});

test('foreground attaches to an in-flight same-key prefetch and reuses it', async () => {
  const prefetchGate = deferred();
  let prefetchCount = 0;
  let resolveCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { resolveCount += 1; return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) { prefetchCount += 1; await prefetchGate.promise; return { cached: true, productionUrl: url }; },
  };
  const { scheduler, committed } = createScheduler(cache, { maxConcurrency: 2, maxBackgroundConcurrency: 1 });
  const background = scheduler.enqueue('same', { priority: 'background' });
  await Promise.resolve();
  const foreground = scheduler.enqueue('same', { priority: 'visible', image: { id: 'same' } });
  assert.equal(background, foreground);
  prefetchGate.resolve();
  await foreground;
  assert.equal(prefetchCount, 1);
  assert.equal(resolveCount, 1);
  assert.deepEqual(committed, [['same', 'same']]);
});

test('visible and near consumers attached to background work commit before the durable cache write finishes', async () => {
  const durablePutGate = deferred();
  const prefetchStarted = deferred();
  let networkFetchCount = 0;
  let resolveCount = 0;
  const sharedBlob = { id: 'shared-network-blob' };
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      resolveCount += 1;
      assert.equal(networkFetchCount, 1, 'foreground resolution must reuse the background network fetch');
      return { blob: sharedBlob, displayUrl: 'blob:shared-network-blob', productionUrl: url };
    },
    async prefetch(url) {
      networkFetchCount += 1;
      prefetchStarted.resolve();
      await durablePutGate.promise;
      return { blob: sharedBlob, cached: true, productionUrl: url };
    },
  };
  const { scheduler, committed } = createScheduler(cache, {
    maxConcurrency: 2,
    maxBackgroundConcurrency: 1,
  });
  const generation = scheduler.generation;
  let backgroundSettled = false;
  let idleSettled = false;
  const background = scheduler.enqueue('same', { priority: 'background', generation })
    .finally(() => { backgroundSettled = true; });
  await prefetchStarted.promise;
  const idle = scheduler.whenGenerationIdle(generation)
    .finally(() => { idleSettled = true; });

  try {
    const near = scheduler.enqueue('same', { priority: 'near', image: { id: 'near' } });
    const visible = scheduler.enqueue('same', { priority: 'visible', image: { id: 'visible' } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(committed, [['near', 'same'], ['visible', 'same']],
      'visible consumers must not wait for the durable Cache Storage write');
    assert.equal(resolveCount, 1, 'all attached image consumers must share one blob resolution');
    assert.equal(networkFetchCount, 1, 'attaching visible consumers must not issue another network request');
    assert.equal(backgroundSettled, false, 'background durability must remain pending while cache.put is gated');
    assert.equal(idleSettled, false, 'generation idle must include the outstanding durable cache write');

    durablePutGate.resolve();
    await Promise.all([near, visible, background, idle]);
    assert.equal(backgroundSettled, true);
    assert.equal(idleSettled, true);
    assert.equal(networkFetchCount, 1);
  } finally {
    durablePutGate.resolve();
  }
});

test('background durability attached after foreground resolution keeps generation idle pending', async () => {
  const foregroundGate = deferred();
  const durablePutGate = deferred();
  let resolveCount = 0;
  let prefetchCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      resolveCount += 1;
      await foregroundGate.promise;
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url) {
      prefetchCount += 1;
      await durablePutGate.promise;
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler, committed } = createScheduler(cache, {
    maxConcurrency: 2,
    maxBackgroundConcurrency: 1,
  });
  const generation = scheduler.generation;
  let foregroundSettled = false;
  let backgroundSettled = false;
  let idleSettled = false;
  const foreground = scheduler.enqueue('same', {
    priority: 'visible',
    image: { id: 'visible' },
    generation,
  }).finally(() => { foregroundSettled = true; });
  const background = scheduler.enqueue('same', {
    priority: 'background',
    generation,
  }).finally(() => { backgroundSettled = true; });
  const idle = scheduler.whenGenerationIdle(generation).finally(() => { idleSettled = true; });

  try {
    foregroundGate.resolve();
    await foreground;
    assert.deepEqual(committed, [['visible', 'same']]);
    assert.equal(foregroundSettled, true, 'the visible cover must resolve before durable storage');
    assert.equal(backgroundSettled, false, 'the selected-family durability owner must remain pending');
    assert.equal(idleSettled, false, 'generation idle must include the later same-key prefetch');
    assert.equal(resolveCount, 1);
    assert.equal(prefetchCount, 1);

    durablePutGate.resolve();
    await Promise.all([background, idle]);
    assert.equal(backgroundSettled, true);
    assert.equal(idleSettled, true);
    assert.equal(resolveCount, 1, 'durability must reuse the foreground cache entry without another resolve');
  } finally {
    foregroundGate.resolve();
    durablePutGate.resolve();
  }
});

test('foreground-attached durability waits until every visible cover task is idle', async () => {
  const selectedGate = deferred();
  const blockerGate = deferred();
  const durabilityGate = deferred();
  const events = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      events.push(`resolve:${url}:start`);
      await (url === 'selected' ? selectedGate.promise : blockerGate.promise);
      events.push(`resolve:${url}:end`);
      return { displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url) {
      events.push(`prefetch:${url}:start`);
      await durabilityGate.promise;
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 2, maxBackgroundConcurrency: 2 });
  const selected = scheduler.enqueue('selected', {
    priority: 'visible',
    image: { id: 'selected' },
  });
  const durability = scheduler.enqueue('selected', { priority: 'background' });
  const blocker = scheduler.enqueue('blocker', {
    priority: 'visible',
    image: { id: 'blocker' },
  });

  selectedGate.resolve();
  await selected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.includes('prefetch:selected:start'), false);
  assert.equal(scheduler.isForegroundIdle(), false);

  blockerGate.resolve();
  await blocker;
  await waitUntil(() => events.includes('prefetch:selected:start'));
  assert.equal(scheduler.isForegroundIdle(), true);

  durabilityGate.resolve();
  await durability;
});

test('family generation switch preserves an in-flight task after a foreground consumer attaches', async () => {
  const prefetchGate = deferred();
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url, options) {
      assert.equal(options.signal.aborted, false);
      await prefetchGate.promise;
      assert.equal(options.signal.aborted, false);
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler, committed } = createScheduler(cache, { maxConcurrency: 2, maxBackgroundConcurrency: 1 });
  scheduler.enqueue('same', { priority: 'background' });
  await Promise.resolve();
  const foreground = scheduler.enqueue('same', { priority: 'visible', image: { id: 'same' } });
  scheduler.startGeneration();
  prefetchGate.resolve();
  const result = await foreground;
  assert.equal(result.cancelled, false);
  assert.deepEqual(committed, [['same', 'same']]);
});

test('family switch aborts active background-only work and releases the slot for the new generation', async () => {
  const starts = [];
  const aborted = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { return { displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url, options) {
      starts.push(url);
      if (url === 'old-family') {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted.push(url);
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }
      return { cached: true, productionUrl: url };
    },
  };
  const { scheduler } = createScheduler(cache, { maxConcurrency: 1, maxBackgroundConcurrency: 1 });
  const oldTask = scheduler.enqueue('old-family', { priority: 'background' });
  await new Promise((resolve) => setImmediate(resolve));
  const generation = scheduler.startGeneration();
  const newTask = scheduler.enqueue('new-family', { priority: 'background', generation });
  await Promise.all([oldTask, newTask]);

  assert.deepEqual(aborted, ['old-family']);
  assert.deepEqual(starts, ['old-family', 'new-family']);
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.activeBackgroundCount, 0);
});

test('non-cacheable remote cover URLs still commit through the normal image path', async () => {
  const cache = {
    normalizeProductionUrl() { return ''; },
    async resolve() { throw new Error('remote URLs must not enter the local cache'); },
    async prefetch() { throw new Error('remote URLs must not enter the local cache'); },
  };
  const { scheduler, committed } = createScheduler(cache);

  const result = await scheduler.enqueue('https://images.example/cover.jpg', {
    priority: 'visible',
    image: { id: 'remote' },
  });

  assert.equal(result.cached, false);
  assert.deepEqual(committed, [['remote', 'https://images.example/cover.jpg']]);
});

test('modal suspension aborts and requeues active priorities with restored markers and fresh tokens', async () => {
  const starts = [];
  const aborted = [];
  let abortInFlightCalls = 0;
  const attempts = new Map();
  const run = (kind, url, options) => {
    const attempt = Number(attempts.get(url) || 0) + 1;
    attempts.set(url, attempt);
    starts.push([kind, url, attempt]);
    if (url === 'background') {
      return Promise.resolve({ cached: true, displayUrl: `blob:${url}`, productionUrl: url });
    }
    if (attempt > 1) {
      return Promise.resolve({ cached: true, displayUrl: `blob:${url}`, productionUrl: url });
    }
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted.push(url);
        const error = new Error('modal preemption');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const cache = {
    normalizeProductionUrl: normalizer,
    resolve(url, options) { return run('resolve', url, options); },
    prefetch(url, options) { return run('prefetch', url, options); },
    abortInFlight() { abortInFlightCalls += 1; },
  };
  const { scheduler, committed, restored, tokenFor } = createPreemptibleScheduler(cache, {
    maxConcurrency: 3,
    maxBackgroundConcurrency: 1,
  });
  const visibleImage = createTrackedImage('visible');
  const nearImage = createTrackedImage('near');
  const generation = scheduler.generation;
  let idleSettled = false;
  const visible = scheduler.enqueue('visible', { priority: 'visible', image: visibleImage, generation });
  const near = scheduler.enqueue('near', { priority: 'near', image: nearImage, generation });
  const background = scheduler.enqueue('background', { priority: 'background', generation });
  const idle = scheduler.whenGenerationIdle(generation).finally(() => { idleSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  scheduler.suspend();
  scheduler.suspend();
  assert.equal(scheduler.suspended, true);
  assert.equal(abortInFlightCalls, 1, 'repeated open must not repeat cache cancellation');
  assert.deepEqual(aborted.sort(), ['near', 'visible']);
  assert.deepEqual(restored, [['visible', 1], ['near', 1]]);
  assert.equal(visibleImage.getAttribute('data-gallery-cover-src'), 'visible');
  assert.equal(nearImage.getAttribute('data-gallery-cover-src'), 'near');
  assert.equal(visibleImage.getAttribute('data-gallery-cover-loading'), null);
  assert.equal(nearImage.getAttribute('data-gallery-cover-loading'), null);
  assert.equal(tokenFor(visibleImage), 2, 'suspension invalidates the old visible request token');
  assert.equal(tokenFor(nearImage), 2, 'suspension invalidates the old near request token');
  assert.equal(idleSettled, false, 'requeued tasks must retain generation-idle ownership');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.tasks.size, 3);

  scheduler.resume();
  scheduler.resume();
  await Promise.all([visible, near, background, idle]);

  assert.deepEqual(starts.slice(2).map((entry) => entry.slice(0, 2)), [
    ['resolve', 'visible'],
    ['resolve', 'near'],
    ['prefetch', 'background'],
  ]);
  assert.equal(tokenFor(visibleImage), 3);
  assert.equal(tokenFor(nearImage), 3);
  assert.equal(visibleImage.getAttribute('data-gallery-cover-src'), null);
  assert.equal(nearImage.getAttribute('data-gallery-cover-src'), null);
  assert.deepEqual(committed.map((entry) => entry.slice(0, 2)), [
    ['visible', 'visible'],
    ['near', 'near'],
  ]);
  assert.equal(idleSettled, true);
  assert.equal(scheduler.tasks.size, 0);
  assert.equal(scheduler.activeCount, 0);
  assert.equal(scheduler.activeBackgroundCount, 0);
});

test('modal suspension records cache aborts before releasing active task controllers', async () => {
  const events = [];
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          events.push(`controller:${url}`);
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    async prefetch() { throw new Error('unexpected prefetch'); },
    abortInFlight(reason) {
      events.push(`cache:${reason}`);
      return Object.freeze([]);
    },
  };
  const { scheduler } = createPreemptibleScheduler(cache, { maxConcurrency: 1 });
  scheduler.enqueue('visible', { priority: 'visible', image: createTrackedImage('visible') });
  await new Promise((resolve) => setImmediate(resolve));

  scheduler.suspend('utility-modal-preemption');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    'cache:utility-modal-preemption',
    'controller:visible',
  ]);
});

test('suspended exact-key consumers resume through one task and settle safely across repeated cycles', async () => {
  let resolveCount = 0;
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) {
      resolveCount += 1;
      return { cached: true, displayUrl: `blob:${url}`, productionUrl: url };
    },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
    abortInFlight() {},
  };
  const { scheduler, committed } = createPreemptibleScheduler(cache, { maxConcurrency: 2 });
  const firstImage = createTrackedImage('first');
  const secondImage = createTrackedImage('second');

  scheduler.suspend();
  const first = scheduler.enqueue('same', { priority: 'near', image: firstImage });
  const second = scheduler.enqueue('same', { priority: 'visible', image: secondImage });
  assert.equal(first, second, 'exact-key requests must retain one scheduler task while suspended');
  assert.equal(resolveCount, 0);
  scheduler.resume();
  await Promise.all([first, second]);

  assert.equal(resolveCount, 1);
  assert.deepEqual(committed.map((entry) => entry.slice(0, 2)), [
    ['first', 'same'],
    ['second', 'same'],
  ]);
  scheduler.suspend();
  scheduler.resume();
  scheduler.suspend();
  scheduler.resume();
  await scheduler.whenGenerationIdle();
  assert.equal(scheduler.tasks.size, 0);
  assert.equal(scheduler.activeCount, 0);
});

test('late viewport discovery promotes queued near work without adding a consumer', () => {
  const cache = {
    normalizeProductionUrl: normalizer,
    async resolve(url) { return { cached: true, displayUrl: `blob:${url}`, productionUrl: url }; },
    async prefetch(url) { return { cached: true, productionUrl: url }; },
    abortInFlight() {},
  };
  const { scheduler } = createPreemptibleScheduler(cache, { maxConcurrency: 1 });
  const image = createTrackedImage('late-visible');
  scheduler.suspend();
  scheduler.enqueue('late-visible', { priority: 'near', image });

  assert.equal(scheduler.promote('late-visible', 'visible'), true);
  assert.equal(scheduler.tasks.get('late-visible').priority, 'visible');
  assert.deepEqual(Array.from(scheduler.queues.visible, (task) => task.productionUrl), ['late-visible']);
  assert.equal(scheduler.queues.near.length, 0);
  assert.equal(scheduler.tasks.get('late-visible').imageRequests.length, 1);
});
