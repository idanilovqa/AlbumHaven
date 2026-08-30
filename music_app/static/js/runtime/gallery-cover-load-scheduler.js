const GALLERY_COVER_LOAD_CONCURRENCY = 2;
const GALLERY_COVER_BACKGROUND_CONCURRENCY = 2;
const GALLERY_COVER_PRIORITY_ORDER = Object.freeze({ visible: 0, near: 1, background: 2 });

class GalleryCoverLoadScheduler {
  constructor(options = {}) {
    this.cache = options.cache || galleryCoverPreviewCache;
    this.maxConcurrency = Math.max(1, Number(options.maxConcurrency || GALLERY_COVER_LOAD_CONCURRENCY));
    this.maxBackgroundConcurrency = Math.max(1, Math.min(
      this.maxConcurrency,
      Number(options.maxBackgroundConcurrency || GALLERY_COVER_BACKGROUND_CONCURRENCY),
    ));
    this.queues = { visible: [], near: [], background: [] };
    this.tasks = new Map();
    this.activeCount = 0;
    this.activeBackgroundCount = 0;
    this.generation = 0;
    this.familyPrefetchGeneration = 0;
    this.activeFamilyPrefetchGeneration = 0;
    this.completedFamilyPrefetchGeneration = 0;
    this.familyPrefetchPending = false;
    this.familyPrefetchPromise = null;
    this.familyPrefetchPromiseGeneration = 0;
    this.familyPrefetchReconciliationSequence = 0;
    this.familyPrefetchUrlKey = '';
    this.familyPrefetchTaskGeneration = -1;
    this.suspended = false;
    this.idleWaiters = [];
    this.foregroundIdleWaiters = [];
    this.diagnostics = {
      maxConcurrency: this.maxConcurrency,
      maxBackgroundConcurrency: this.maxBackgroundConcurrency,
      active: 0,
      activeBackground: 0,
      queuedVisible: 0,
      queuedNear: 0,
      queuedBackground: 0,
      activeForeground: 0,
      queuedForeground: 0,
      foregroundIdle: true,
      generation: 0,
      familyPrefetchGeneration: 0,
      activeFamilyPrefetchGeneration: 0,
      completedFamilyPrefetchGeneration: 0,
      familyPrefetchPending: false,
      suspended: false,
    };
  }

  updateDiagnostics() {
    this.diagnostics.active = this.activeCount + (this.familyPrefetchPending ? 1 : 0);
    this.diagnostics.activeBackground = this.activeBackgroundCount;
    this.diagnostics.queuedVisible = this.queues.visible.length;
    this.diagnostics.queuedNear = this.queues.near.length;
    this.diagnostics.queuedBackground = this.queues.background.length;
    this.diagnostics.activeForeground = this.activeForegroundCount();
    this.diagnostics.queuedForeground = this.queues.visible.length + this.queues.near.length;
    this.diagnostics.foregroundIdle = this.isForegroundIdle();
    this.diagnostics.generation = this.generation;
    this.diagnostics.familyPrefetchGeneration = this.familyPrefetchGeneration;
    this.diagnostics.activeFamilyPrefetchGeneration = this.activeFamilyPrefetchGeneration;
    this.diagnostics.completedFamilyPrefetchGeneration = this.completedFamilyPrefetchGeneration;
    this.diagnostics.familyPrefetchPending = this.familyPrefetchPending;
    this.diagnostics.suspended = this.suspended;
  }

  startGeneration() {
    this.generation += 1;
    Object.entries(this.queues).forEach(([priority, queue]) => {
      const retained = [];
      queue.splice(0).forEach((task) => {
        if (task.consumerOwned) {
          task.pendingGenerationValidation = this.generation;
          retained.push(task);
          return;
        }
        if (this.familyPrefetchPending && task.priority === 'background') {
          retained.push(task);
          return;
        }
        task.cancelled = true;
        this.tasks.delete(task.productionUrl);
        task.resolve({ cancelled: true, productionUrl: task.productionUrl });
      });
      this.queues[priority].push(...retained);
    });
    this.tasks.forEach((task) => {
      if (task.consumerOwned && task.generation !== this.generation) {
        task.pendingGenerationValidation = this.generation;
      }
      if (
        !this.familyPrefetchPending
        && !task.consumerOwned
        && task.priority === 'background'
        && task.generation !== this.generation
      ) {
        task.cancelled = true;
        task.abortController?.abort();
      }
    });
    this.updateDiagnostics();
    this.settleIdleWaiters();
    this.settleForegroundIdleWaiters();
    return this.generation;
  }

  requestHasConnectedConsumer(request) {
    const image = request?.image;
    if (!image) return false;
    return typeof image.isConnected !== 'boolean' || image.isConnected;
  }

  cancelTask(task) {
    if (!task || task.cancelled) return;
    task.cancelled = true;
    [task.imageRequests, task.drainingImageRequests].forEach((requests) => {
      requests.splice(0).forEach((request) => {
        if (typeof restoreGalleryCoverImageRequest === 'function') {
          restoreGalleryCoverImageRequest(request);
        }
      });
    });
    task.consumerOwned = false;
    if (task.started) {
      task.abortController?.abort();
      return;
    }
    Object.values(this.queues).forEach((queue) => {
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
    });
    if (this.tasks.get(task.productionUrl) === task) this.tasks.delete(task.productionUrl);
    const result = { cancelled: true, productionUrl: task.productionUrl };
    task.resolve(result);
    task.resolveDurability?.(result);
  }

  pruneObsoleteConsumerTasks(generation = this.generation) {
    const currentGeneration = Number(generation || this.generation);
    this.tasks.forEach((task) => {
      if (
        task.cancelled
        || !task.consumerOwned
        || task.generation === currentGeneration
        || task.pendingGenerationValidation !== currentGeneration
      ) return;
      [task.imageRequests, task.drainingImageRequests].forEach((requests) => {
        const connected = requests.filter((request) => this.requestHasConnectedConsumer(request));
        requests
          .filter((request) => !this.requestHasConnectedConsumer(request))
          .forEach((request) => {
            if (typeof restoreGalleryCoverImageRequest === 'function') {
              restoreGalleryCoverImageRequest(request);
            }
          });
        requests.splice(0, requests.length, ...connected);
      });
      task.suspendedImages = task.suspendedImages.filter((image) => (
        typeof image?.isConnected !== 'boolean' || image.isConnected
      ));
      if (task.imageRequests.length || task.drainingImageRequests.length || task.suspendedImages.length) {
        task.generation = currentGeneration;
        task.pendingGenerationValidation = 0;
        return;
      }
      if (task.started) {
        this.cache.recordInFlightPreemption?.(
          task.productionUrl,
          'render-generation-preemption',
        );
      }
      this.cancelTask(task);
    });
    this.updateDiagnostics();
    this.pump();
    this.settleIdleWaiters();
    this.settleForegroundIdleWaiters();
  }

  beginFamilyPrefetchReconciliation() {
    this.familyPrefetchGeneration += 1;
    this.activeFamilyPrefetchGeneration = this.familyPrefetchGeneration;
    this.familyPrefetchPending = true;
    this.updateDiagnostics();
    return this.familyPrefetchGeneration;
  }

  ensureFamilyPrefetchReconciliation() {
    return this.familyPrefetchPending
      ? this.activeFamilyPrefetchGeneration
      : this.beginFamilyPrefetchReconciliation();
  }

  cancelFamilyPrefetchReconciliation(familyPrefetchGeneration) {
    if (Number(familyPrefetchGeneration || 0) !== this.activeFamilyPrefetchGeneration) return false;
    this.activeFamilyPrefetchGeneration = 0;
    this.familyPrefetchReconciliationSequence += 1;
    this.familyPrefetchPending = false;
    this.updateDiagnostics();
    this.settleIdleWaiters();
    return true;
  }

  reconcileFamilyPrefetch(productionUrls, options = {}) {
    const familyPrefetchGeneration = Number(
      options.familyPrefetchGeneration || this.activeFamilyPrefetchGeneration,
    ) || this.beginFamilyPrefetchReconciliation();
    if (familyPrefetchGeneration !== this.activeFamilyPrefetchGeneration) {
      return Promise.resolve({ cancelled: true, familyPrefetchGeneration });
    }
    const taskGeneration = Number(options.generation || this.generation);
    const normalizedUrls = new Set(
      [...(productionUrls || [])]
        .map((productionUrl) => this.cache.normalizeProductionUrl(productionUrl))
        .filter(Boolean),
    );
    const urlKey = [...normalizedUrls].sort().join('\n');
    if (
      this.familyPrefetchPromise
      && this.familyPrefetchPromiseGeneration === familyPrefetchGeneration
      && this.familyPrefetchTaskGeneration === taskGeneration
      && this.familyPrefetchUrlKey === urlKey
    ) {
      return this.familyPrefetchPromise;
    }
    this.familyPrefetchTaskGeneration = taskGeneration;
    this.familyPrefetchUrlKey = urlKey;
    this.familyPrefetchReconciliationSequence += 1;
    const reconciliationSequence = this.familyPrefetchReconciliationSequence;
    const pending = [...normalizedUrls].map((productionUrl) => this.enqueue(productionUrl, {
      generation: taskGeneration,
      priority: 'background',
    }));
    this.tasks.forEach((task) => {
      if (
        task.consumerOwned
        || task.priority !== 'background'
        || normalizedUrls.has(task.productionUrl)
      ) return;
      task.cancelled = true;
      if (!task.started) {
        const queue = this.queues.background;
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        if (this.tasks.get(task.productionUrl) === task) this.tasks.delete(task.productionUrl);
        task.resolve({ cancelled: true, productionUrl: task.productionUrl });
      } else {
        task.abortController?.abort();
      }
    });
    this.updateDiagnostics();
    this.pump();
    const reconciliationPromise = Promise.all(pending).then((results) => {
      if (
        familyPrefetchGeneration !== this.activeFamilyPrefetchGeneration
        || reconciliationSequence !== this.familyPrefetchReconciliationSequence
      ) {
        return { cancelled: true, familyPrefetchGeneration, results };
      }
      this.completedFamilyPrefetchGeneration = familyPrefetchGeneration;
      this.activeFamilyPrefetchGeneration = 0;
      this.familyPrefetchPending = false;
      this.updateDiagnostics();
      this.settleIdleWaiters();
      return { cancelled: false, familyPrefetchGeneration, results };
    });
    this.familyPrefetchPromise = reconciliationPromise;
    this.familyPrefetchPromiseGeneration = familyPrefetchGeneration;
    return reconciliationPromise;
  }

  normalizePriority(priority) {
    return Object.hasOwn(GALLERY_COVER_PRIORITY_ORDER, priority) ? priority : 'background';
  }

  promoteTask(task, priority) {
    if (GALLERY_COVER_PRIORITY_ORDER[priority] >= GALLERY_COVER_PRIORITY_ORDER[task.priority]) return;
    if (!task.started) {
      const queue = this.queues[task.priority];
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      this.queues[priority].push(task);
    }
    task.priority = priority;
  }

  promote(productionUrl, priority = 'visible') {
    const normalizedUrl = this.cache.normalizeProductionUrl(productionUrl);
    const task = normalizedUrl ? this.tasks.get(normalizedUrl) : null;
    if (!task || task.cancelled) return false;
    this.promoteTask(task, this.normalizePriority(priority));
    this.updateDiagnostics();
    this.pump();
    return true;
  }

  activeForegroundCount() {
    return [...this.tasks.values()].filter((task) => (
      task.started
      && !task.cancelled
      && task.priority !== 'background'
    )).length;
  }

  hasActiveBackgroundOnlyWork() {
    return [...this.tasks.values()].some((task) => (
      task.started
      && task.startedAsBackground
      && !task.cancelled
      && task.priority === 'background'
    ));
  }

  isForegroundIdle() {
    return (
      this.queues.visible.length === 0
      && this.queues.near.length === 0
      && this.activeForegroundCount() === 0
    );
  }

  foregroundState() {
    return Object.freeze({
      active: this.activeForegroundCount(),
      queued: this.queues.visible.length + this.queues.near.length,
      idle: this.isForegroundIdle(),
    });
  }

  preemptActiveBackgroundTasksForForeground() {
    this.tasks.forEach((task) => {
      if (
        !task.started
        || !task.startedAsBackground
        || task.cancelled
        || task.priority !== 'background'
        || task.foregroundPreemptRequested
      ) return;
      task.foregroundPreemptRequested = true;
      this.cache.recordInFlightPreemption?.(task.productionUrl, 'foreground-promotion');
      task.abortController?.abort();
    });
  }

  suspend(reason = 'utility-modal-preemption') {
    if (this.suspended) return Object.freeze([]);
    this.suspended = true;
    const preemptedEntries = this.cache.abortInFlight?.(reason) || Object.freeze([]);
    this.tasks.forEach((task) => {
      if (!task.started || task.cancelled) return;
      task.suspendRequested = true;
      const suspendedRequests = [
        ...task.drainingImageRequests.splice(0),
        ...task.imageRequests.splice(0),
      ];
      const suspendedImages = suspendedRequests
        .map((request) => (
          typeof restoreGalleryCoverImageRequest === 'function'
            ? restoreGalleryCoverImageRequest(request)
            : request.image
        ))
        .filter(Boolean);
      suspendedImages.forEach((image) => {
        if (!task.suspendedImages.includes(image)) task.suspendedImages.push(image);
      });
      task.abortController?.abort();
    });
    this.updateDiagnostics();
    return preemptedEntries;
  }

  resume() {
    if (!this.suspended) return;
    this.suspended = false;
    this.tasks.forEach((task) => this.restoreSuspendedImageRequests(task));
    this.updateDiagnostics();
    this.pump();
  }

  restoreSuspendedImageRequests(task) {
    const images = task.suspendedImages.splice(0);
    images.forEach((image) => {
      const request = beginGalleryCoverImageRequest(image, task.productionUrl);
      if (!request) return;
      image.setAttribute('data-gallery-cover-loading', '1');
      image.removeAttribute('data-gallery-cover-src');
      task.imageRequests.push(request);
    });
  }

  async drainForegroundImageRequests(task, result) {
    while (!task.cancelled) {
      const requests = task.imageRequests.splice(0);
      if (!requests.length) {
        await Promise.resolve();
        if (!task.imageRequests.length) {
          task.acceptingImageRequests = false;
          break;
        }
        continue;
      }
      task.drainingImageRequests = requests;
      await Promise.resolve();
      if (!task.cancelled && !task.suspendRequested) {
        requests.forEach((request) => commitGalleryCoverImageRequest(request, result));
      }
      task.drainingImageRequests = [];
    }
  }

  resolveAttachedImageRequests(task) {
    if (task.consumerResolutionPromise) return task.consumerResolutionPromise;
    task.consumerResolutionPromise = (async () => {
      do {
        const result = await this.cache.resolve(task.productionUrl, {
          signal: task.abortController?.signal || null,
          priority: 'foreground',
        });
        task.consumerResult = result;
        if (task.cancelled) break;
        await this.drainForegroundImageRequests(task, result);
      } while (task.imageRequests.length);
      return task.consumerResult;
    })().catch((error) => {
      task.consumerError = error;
      return null;
    }).finally(() => {
      task.consumerResolutionPromise = null;
    });
    return task.consumerResolutionPromise;
  }

  enqueue(productionUrl, options = {}) {
    const requestedUrl = String(productionUrl || '').trim();
    const normalizedUrl = this.cache.normalizeProductionUrl(productionUrl);
    if (!normalizedUrl) {
      if (options.image && requestedUrl) {
        const request = beginGalleryCoverImageRequest(options.image, requestedUrl);
        commitGalleryCoverImageRequest(request, {
          displayUrl: requestedUrl,
          productionUrl: requestedUrl,
          cached: false,
        });
      }
      return Promise.resolve({ cancelled: false, cached: false, productionUrl: requestedUrl });
    }
    const priority = this.normalizePriority(options.priority);
    const generation = Number(options.generation || this.generation);
    const imageRequest = options.image ? beginGalleryCoverImageRequest(options.image, normalizedUrl) : null;
    let task = this.tasks.get(normalizedUrl);
    if (task && !task.cancelled && task.acceptingImageRequests !== false) {
      task.generation = generation;
      task.pendingGenerationValidation = 0;
      this.promoteTask(task, priority);
      if (imageRequest) {
        task.consumerOwned = true;
        task.imageRequests.push(imageRequest);
        if (!task.started && task.durabilityOnly) task.durabilityOnly = false;
        if (task.startedAsBackground) this.resolveAttachedImageRequests(task);
      } else if (priority === 'background' && task.consumerOwned) {
        task.durabilityRequested = true;
        if (!task.durabilityPromise) {
          task.durabilityPromise = new Promise((resolve) => { task.resolveDurability = resolve; });
        }
      }
      if (priority !== 'background') this.preemptActiveBackgroundTasksForForeground();
      this.updateDiagnostics();
      this.pump();
      return !imageRequest && priority === 'background' && task.consumerOwned
        ? task.durabilityPromise
        : task.promise;
    }
    let resolveTask;
    const promise = new Promise((resolve) => { resolveTask = resolve; });
    task = {
      productionUrl: normalizedUrl,
      priority,
      generation,
      imageRequests: imageRequest ? [imageRequest] : [],
      drainingImageRequests: [],
      consumerOwned: Boolean(imageRequest),
      started: false,
      startedAsBackground: false,
      cancelled: false,
      consumerResolutionPromise: null,
      consumerResult: null,
      consumerError: null,
      consumerSettled: false,
      durabilityRequested: false,
      durabilityPromise: null,
      resolveDurability: null,
      durabilityOnly: false,
      requeueForDurability: false,
      suspendedImages: [],
      suspendRequested: false,
      foregroundPreemptRequested: false,
      acceptingImageRequests: true,
      pendingGenerationValidation: 0,
      promise,
      resolve: resolveTask,
    };
    this.tasks.set(normalizedUrl, task);
    this.queues[priority].push(task);
    if (priority !== 'background') this.preemptActiveBackgroundTasksForForeground();
    this.updateDiagnostics();
    this.pump();
    return promise;
  }

  nextTask() {
    if (this.queues.visible.length || this.queues.near.length) {
      if (this.hasActiveBackgroundOnlyWork()) return null;
      if (this.queues.visible.length) return this.queues.visible.shift();
      return this.queues.near.shift();
    }
    if (!this.isForegroundIdle()) return null;
    if (this.activeBackgroundCount >= this.maxBackgroundConcurrency) return null;
    return this.queues.background.shift() || null;
  }

  pump() {
    if (this.suspended) {
      this.updateDiagnostics();
      return;
    }
    while (this.activeCount < this.maxConcurrency) {
      const task = this.nextTask();
      if (!task) break;
      if (task.cancelled || (task.generation !== this.generation && !task.consumerOwned)) {
        this.tasks.delete(task.productionUrl);
        task.resolve({ cancelled: true, productionUrl: task.productionUrl });
        continue;
      }
      this.runTask(task);
    }
    this.updateDiagnostics();
    this.settleIdleWaiters();
    this.settleForegroundIdleWaiters();
  }

  async runTask(task) {
    task.started = true;
    this.activeCount += 1;
    const startedAsBackground = task.priority === 'background';
    task.startedAsBackground = startedAsBackground;
    task.abortController = new AbortController();
    if (startedAsBackground) this.activeBackgroundCount += 1;
    this.updateDiagnostics();
    let result;
    try {
      if (task.durabilityOnly) {
        result = await this.cache.prefetch(task.productionUrl, {
          signal: task.abortController.signal,
          priority: 'background',
        });
        task.acceptingImageRequests = false;
        if (!task.cancelled && (task.imageRequests.length || task.consumerResolutionPromise)) {
          await this.resolveAttachedImageRequests(task);
        }
        if (task.consumerError) throw task.consumerError;
        task.resolveDurability?.({ ...result, cancelled: task.cancelled });
      } else if (task.imageRequests.length) {
        result = await this.cache.resolve(task.productionUrl, {
          signal: task.abortController.signal,
          priority: 'foreground',
        });
        await this.drainForegroundImageRequests(task, result);
        if (task.durabilityRequested && !task.cancelled) {
          task.resolve({ ...result, cancelled: false });
          task.consumerSettled = true;
          task.requeueForDurability = true;
        }
      } else {
        result = await this.cache.prefetch(task.productionUrl, {
          signal: task.abortController.signal,
          priority: 'background',
        });
        task.acceptingImageRequests = false;
        if (!task.cancelled && (task.imageRequests.length || task.consumerResolutionPromise)) {
          await this.resolveAttachedImageRequests(task);
        }
        if (task.consumerError) throw task.consumerError;
        if (task.consumerResult) result = task.consumerResult;
      }
      if ((!task.suspendRequested && !task.foregroundPreemptRequested) || task.cancelled) {
        if (!task.consumerSettled) task.resolve({ ...result, cancelled: task.cancelled });
        if (task.durabilityRequested && task.cancelled) {
          task.resolveDurability?.({ ...result, cancelled: true });
        }
      }
    } catch (error) {
      if ((!task.suspendRequested && !task.foregroundPreemptRequested) || task.cancelled) {
        const failure = { cached: false, cancelled: task.cancelled, error, productionUrl: task.productionUrl };
        if (!task.consumerSettled) task.resolve(failure);
        task.resolveDurability?.(failure);
      }
    } finally {
      this.activeCount -= 1;
      if (startedAsBackground) this.activeBackgroundCount -= 1;
      if (task.suspendRequested && !task.cancelled) {
        task.started = false;
        task.acceptingImageRequests = true;
        task.startedAsBackground = false;
        task.suspendRequested = false;
        task.abortController = null;
        task.consumerResolutionPromise = null;
        task.consumerResult = null;
        task.consumerError = null;
        task.consumerSettled = false;
        if (!this.queues[task.priority].includes(task)) this.queues[task.priority].push(task);
        if (!this.suspended) this.restoreSuspendedImageRequests(task);
      } else if (task.foregroundPreemptRequested && !task.cancelled) {
        task.started = false;
        task.acceptingImageRequests = true;
        task.startedAsBackground = false;
        task.foregroundPreemptRequested = false;
        task.abortController = null;
        task.consumerResolutionPromise = null;
        task.consumerResult = null;
        task.consumerError = null;
        task.consumerSettled = false;
        if (!this.queues[task.priority].includes(task)) this.queues[task.priority].push(task);
      } else if (task.requeueForDurability && !task.cancelled) {
        task.started = false;
        task.acceptingImageRequests = true;
        task.startedAsBackground = false;
        task.requeueForDurability = false;
        task.durabilityOnly = true;
        task.priority = 'background';
        task.abortController = null;
        if (!this.queues.background.includes(task)) this.queues.background.push(task);
      } else if (this.tasks.get(task.productionUrl) === task) {
        this.tasks.delete(task.productionUrl);
      }
      this.updateDiagnostics();
      this.pump();
    }
  }

  whenGenerationIdle(generation = this.generation) {
    if (this.isGenerationIdle(generation)) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push({ generation, resolve }));
  }

  whenForegroundIdle() {
    if (this.isForegroundIdle()) return Promise.resolve();
    return new Promise((resolve) => this.foregroundIdleWaiters.push(resolve));
  }

  isGenerationIdle(generation) {
    if (this.familyPrefetchPending) return false;
    return ![...this.tasks.values()].some((task) => task.generation === generation && !task.cancelled);
  }

  settleIdleWaiters() {
    this.idleWaiters = this.idleWaiters.filter((waiter) => {
      if (!this.isGenerationIdle(waiter.generation)) return true;
      waiter.resolve();
      return false;
    });
  }

  settleForegroundIdleWaiters() {
    if (!this.isForegroundIdle()) return;
    this.foregroundIdleWaiters.splice(0).forEach((resolve) => resolve());
  }
}

const galleryCoverLoadScheduler = new GalleryCoverLoadScheduler();
globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ = galleryCoverLoadScheduler.diagnostics;
