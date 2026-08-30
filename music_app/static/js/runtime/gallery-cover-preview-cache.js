const GALLERY_COVER_PREVIEW_CACHE_PREFIX = 'album-haven-gallery-previews-';
const GALLERY_COVER_PREVIEW_CACHE_VERSION = 'v1';
const GALLERY_COVER_PREVIEW_CACHE_NAME = `${GALLERY_COVER_PREVIEW_CACHE_PREFIX}${GALLERY_COVER_PREVIEW_CACHE_VERSION}`;
const MAX_ACTIVE_GALLERY_COVER_OBJECT_URLS = 48;
const MAX_GALLERY_COVER_PREEMPTION_DIAGNOSTICS = 64;
const GALLERY_COVER_REQUEST_ID_HEADER = 'X-Album-Haven-Cover-Request-Id';
const GALLERY_COVER_PRIORITY_HEADER = 'X-Album-Haven-Cover-Priority';

class GalleryCoverPreviewCache {
  constructor(options = {}) {
    this.cacheStorage = options.cacheStorage ?? globalThis.caches ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;
    this.urlApi = options.urlApi ?? globalThis.URL ?? null;
    this.locationOrigin = String(options.locationOrigin ?? globalThis.location?.origin ?? '').trim();
    this.cacheName = String(options.cacheName || GALLERY_COVER_PREVIEW_CACHE_NAME);
    this.maxActiveObjectUrls = Math.max(1, Number(options.maxActiveObjectUrls || MAX_ACTIVE_GALLERY_COVER_OBJECT_URLS));
    this.activeObjectUrls = new Map();
    this.inFlight = new Map();
    this.writeChains = new Map();
    this.liveFetches = new Map();
    this.keyGenerations = new Map();
    this.latestRequestedProductionUrls = new Map();
    this.openPromise = null;
    this.generation = 0;
    this.requestSequence = 0;
    this.preemptionSequence = 0;
    this.preemptionTransactionActive = false;
    this.requestSessionId = this.createRequestSessionId();
    this.diagnostics = {
      cacheName: this.cacheName,
      fallbackCount: 0,
      writeFailureCount: 0,
      lastFallback: null,
      lastWriteFailure: null,
      activeCount: 0,
      activeProductionUrls: [],
      preemptionCount: 0,
      preemptionSequence: 0,
      lastPreemption: null,
      preemptions: Object.freeze([]),
    };
  }

  createRequestSessionId() {
    const randomId = globalThis.crypto?.randomUUID?.();
    const fallback = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return String(randomId || fallback).replace(/[^a-z0-9-]/gi, '').slice(0, 32);
  }

  nextRequestId() {
    if (this.requestSequence >= Number.MAX_SAFE_INTEGER) {
      this.requestSequence = 0;
      this.requestSessionId = this.createRequestSessionId();
    }
    this.requestSequence += 1;
    return `gallery-cover-${this.requestSessionId}-${this.requestSequence.toString(36)}`.slice(0, 64);
  }

  diagnosticNormalizedUrl(productionUrl) {
    try {
      const url = new URL(productionUrl);
      return `${url.origin}${url.pathname}`;
    } catch (_error) {
      return '/cover';
    }
  }

  normalizeProductionUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, this.locationOrigin || globalThis.location?.href || undefined);
      if (this.locationOrigin && url.origin !== this.locationOrigin) return '';
      const isGalleryCover = url.pathname === '/cover';
      const isRemoteCoverProxy = url.pathname === '/utilities/cover-lookup/remote-image';
      if (isRemoteCoverProxy && (!this.locationOrigin || url.origin !== this.locationOrigin)) return '';
      if (!isGalleryCover && !isRemoteCoverProxy) return '';
      return url.href;
    } catch (_error) {
      return '';
    }
  }

  keyGeneration(productionUrl) {
    return Number(this.keyGenerations.get(productionUrl) || 0);
  }

  snapshotGeneration(productionUrl) {
    return { global: this.generation, key: this.keyGeneration(productionUrl) };
  }

  generationMatches(productionUrl, snapshot) {
    return snapshot.global === this.generation && snapshot.key === this.keyGeneration(productionUrl);
  }

  throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Gallery cover request was cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  normalizeRequestPriority(value) {
    return String(value || '').trim().toLowerCase() === 'background' ? 'background' : 'foreground';
  }

  awaitWithAbort(promise, signal) {
    if (!signal) return promise;
    this.throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => {
        const error = new Error('Gallery cover request was cancelled.');
        error.name = 'AbortError';
        finish(reject, error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  async openCache() {
    if (!this.cacheStorage || typeof this.cacheStorage.open !== 'function') {
      throw new Error('Cache Storage is unavailable.');
    }
    if (!this.openPromise) {
      this.openPromise = (async () => {
        if (typeof this.cacheStorage.keys === 'function' && typeof this.cacheStorage.delete === 'function') {
          const names = await this.cacheStorage.keys();
          await Promise.all(names
            .filter((name) => String(name).startsWith(GALLERY_COVER_PREVIEW_CACHE_PREFIX) && name !== this.cacheName)
            .map((name) => this.cacheStorage.delete(name)));
        }
        return this.cacheStorage.open(this.cacheName);
      })();
    }
    return this.openPromise;
  }

  responseContentType(response) {
    return String(response?.headers?.get?.('content-type') || '').trim().toLowerCase();
  }

  async validatedBlob(response) {
    if (!response || response.ok !== true || Number(response.status || 0) < 200 || Number(response.status || 0) >= 300) {
      throw new Error(`Cover response failed with HTTP ${Number(response?.status || 0)}.`);
    }
    const contentType = this.responseContentType(response);
    if (!contentType.startsWith('image/')) {
      throw new Error(`Cover response has invalid content type "${contentType || 'missing'}".`);
    }
    const blob = await response.blob();
    const blobType = String(blob?.type || contentType || '').trim().toLowerCase();
    if (!blob || Number(blob.size || 0) <= 0 || !blobType.startsWith('image/')) {
      throw new Error('Cover response body is empty or is not an image.');
    }
    return blob;
  }

  createCacheableResponse(response, blob) {
    if (typeof globalThis.Response !== 'function') return null;
    const contentType = String(blob?.type || this.responseContentType(response) || '').trim();
    return new globalThis.Response(blob, {
      status: Number(response?.status || 200),
      statusText: String(response?.statusText || ''),
      headers: contentType ? { 'Content-Type': contentType } : undefined,
    });
  }

  deferCacheWrite(callback) {
    return new Promise((resolve, reject) => {
      const run = () => {
        Promise.resolve().then(callback).then(resolve, reject);
      };
      if (typeof globalThis.requestIdleCallback === 'function') {
        globalThis.requestIdleCallback(run, { timeout: 250 });
        return;
      }
      globalThis.setTimeout(run, 0);
    });
  }

  baseCacheKey(productionUrl) {
    const url = new URL(productionUrl);
    url.searchParams.delete('v');
    url.hash = '';
    return url.href;
  }

  rememberLatestRequestedProductionUrl(productionUrl) {
    this.latestRequestedProductionUrls.set(this.baseCacheKey(productionUrl), productionUrl);
  }

  isLatestRequestedProductionUrl(productionUrl) {
    return this.latestRequestedProductionUrls.get(this.baseCacheKey(productionUrl)) === productionUrl;
  }

  async purgeSupersededEntries(cache, productionUrl, shouldContinue = () => true) {
    const baseKey = this.baseCacheKey(productionUrl);
    if (typeof cache?.keys !== 'function') return;
    const requests = await cache.keys();
    if (!shouldContinue()) return;
    for (const request of requests) {
      if (!shouldContinue()) return;
      const cachedUrl = String(request?.url || request || '');
      if (
        cachedUrl !== productionUrl
        && this.normalizeProductionUrl(cachedUrl)
        && this.baseCacheKey(cachedUrl) === baseKey
      ) {
        await cache.delete(request);
        if (!shouldContinue()) return;
      }
    }
  }

  rememberObjectUrl(productionUrl, objectUrl) {
    const previous = this.activeObjectUrls.get(productionUrl);
    if (previous && previous !== objectUrl) this.urlApi?.revokeObjectURL?.(previous);
    this.activeObjectUrls.delete(productionUrl);
    this.activeObjectUrls.set(productionUrl, objectUrl);
    while (this.activeObjectUrls.size > this.maxActiveObjectUrls) {
      const oldest = this.activeObjectUrls.entries().next().value;
      if (!oldest) break;
      this.activeObjectUrls.delete(oldest[0]);
      this.urlApi?.revokeObjectURL?.(oldest[1]);
    }
    this.syncActiveDiagnostics();
  }

  syncActiveDiagnostics() {
    this.diagnostics.activeCount = this.activeObjectUrls.size;
    this.diagnostics.activeProductionUrls = [...this.activeObjectUrls.keys()];
  }

  hasActive(productionUrl) {
    const normalizedUrl = this.normalizeProductionUrl(productionUrl);
    return Boolean(normalizedUrl && this.activeObjectUrls.has(normalizedUrl));
  }

  recordDiagnostic(kind, productionUrl, error) {
    const detail = {
      kind,
      productionUrl,
      message: String(error?.message || error || 'Gallery cover preview cache failed.'),
      timestamp: new Date().toISOString(),
    };
    if (kind === 'write-failure') {
      this.diagnostics.writeFailureCount += 1;
      this.diagnostics.lastWriteFailure = detail;
    } else {
      this.diagnostics.fallbackCount += 1;
      this.diagnostics.lastFallback = detail;
    }
    console.warn(`Gallery cover preview cache ${kind}`, detail);
    if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent(`album-haven:gallery-cover-cache-${kind}`, { detail }));
    }
  }

  async persistNetworkResponse(cache, productionUrl, cacheCandidate, blob, snapshot, signal = null) {
    const baseKey = this.baseCacheKey(productionUrl);
    const previousWrite = this.writeChains.get(baseKey) || Promise.resolve();
    const write = previousWrite.catch(() => null).then(async () => {
      if (!this.generationMatches(productionUrl, snapshot) || signal?.aborted) {
        return { blob, source: 'network', stale: true, cancelled: Boolean(signal?.aborted) };
      }
      if (!this.isLatestRequestedProductionUrl(productionUrl)) {
        return { blob, source: 'network', stale: true, obsolete: true };
      }
      try {
        let wroteCacheEntry = false;
        const shouldContinue = () => (
          this.generationMatches(productionUrl, snapshot)
          && !signal?.aborted
          && this.isLatestRequestedProductionUrl(productionUrl)
        );
        await this.deferCacheWrite(async () => {
          if (!shouldContinue()) return;
          try {
            await this.purgeSupersededEntries(cache, productionUrl, shouldContinue);
          } catch (error) {
            this.recordDiagnostic('superseded-entry-purge-failure', productionUrl, error);
          }
          if (!shouldContinue()) return;
          await cache.put(productionUrl, cacheCandidate);
          wroteCacheEntry = true;
        });
        if (!shouldContinue()) {
          if (wroteCacheEntry || !this.isLatestRequestedProductionUrl(productionUrl)) {
            await cache.delete(productionUrl);
          }
          return {
            blob,
            source: 'network',
            stale: true,
            cancelled: Boolean(signal?.aborted),
            obsolete: !this.isLatestRequestedProductionUrl(productionUrl),
          };
        }
        return { blob, source: 'network' };
      } catch (error) {
        this.recordDiagnostic('write-failure', productionUrl, error);
        return { blob, source: 'network', writeFailed: true };
      }
    });
    const trackedWrite = write.finally(() => {
      if (this.writeChains.get(baseKey) === trackedWrite) {
        this.writeChains.delete(baseKey);
      }
    });
    this.writeChains.set(baseKey, trackedWrite);
    return trackedWrite;
  }

  async loadBlob(productionUrl, snapshot, signal = null, abortController = null, priorityOwner = null) {
    this.throwIfAborted(signal);
    const cache = await this.openCache();
    const cachedResponse = await cache.match(productionUrl);
    this.throwIfAborted(signal);
    if (cachedResponse) {
      try {
        const blob = await this.validatedBlob(cachedResponse);
        this.throwIfAborted(signal);
        return { blob, source: 'cache', stale: !this.generationMatches(productionUrl, snapshot) };
      } catch (error) {
        if (signal?.aborted) this.throwIfAborted(signal);
        if (error?.name === 'AbortError') throw error;
        try {
          await cache.delete(productionUrl);
        } catch (deleteError) {
          this.recordDiagnostic('invalid-cache-delete-failure', productionUrl, deleteError);
        }
        this.recordDiagnostic('invalid-cache-entry', productionUrl, error);
      }
    }
    if (typeof this.fetchImpl !== 'function') throw new Error('Cover fetch is unavailable.');
    let cacheCandidate;
    let blob;
    while (true) {
      const requestId = this.nextRequestId();
      const requestPriority = this.normalizeRequestPriority(priorityOwner?.priority);
      const attemptController = typeof globalThis.AbortController === 'function'
        ? new globalThis.AbortController()
        : null;
      const attemptSignal = attemptController?.signal || signal;
      const abortAttemptFromOwner = () => attemptController?.abort();
      if (signal && attemptController) {
        if (signal.aborted) attemptController.abort();
        else signal.addEventListener('abort', abortAttemptFromOwner, { once: true });
      }
      const liveFetch = {
        requestId,
        normalizedUrl: this.diagnosticNormalizedUrl(productionUrl),
        abortController: attemptController || abortController,
        promotionSafe: Boolean(attemptController),
      };
      this.liveFetches.set(requestId, liveFetch);
      if (priorityOwner) {
        priorityOwner.liveRequestId = requestId;
        priorityOwner.dispatchedPriority = requestPriority;
      }
      let promotionRetry = false;
      try {
        const response = await this.fetchImpl(productionUrl, {
          credentials: 'same-origin',
          signal: attemptSignal,
          headers: {
            [GALLERY_COVER_REQUEST_ID_HEADER]: requestId,
            [GALLERY_COVER_PRIORITY_HEADER]: requestPriority,
          },
        });
        this.throwIfAborted(signal);
        blob = await this.validatedBlob(response);
        cacheCandidate = this.createCacheableResponse(response, blob);
        this.throwIfAborted(signal);
      } catch (error) {
        promotionRetry = Boolean(
          error?.name === 'AbortError'
          && priorityOwner?.promotionRequestId === requestId
          && !signal?.aborted
        );
        if (!promotionRetry) throw error;
      } finally {
        signal?.removeEventListener?.('abort', abortAttemptFromOwner);
        if (this.liveFetches.get(requestId) === liveFetch) this.liveFetches.delete(requestId);
        if (priorityOwner?.liveRequestId === requestId) {
          priorityOwner.liveRequestId = null;
          priorityOwner.dispatchedPriority = null;
        }
        if (priorityOwner?.promotionRequestId === requestId) {
          priorityOwner.promotionRequestId = null;
        }
      }
      if (promotionRetry) continue;
      break;
    }
    if (!this.generationMatches(productionUrl, snapshot)) {
      return { blob, source: 'network', stale: true };
    }
    if (cacheCandidate) {
      const cacheWritePromise = this.persistNetworkResponse(
        cache,
        productionUrl,
        cacheCandidate,
        blob,
        snapshot,
        signal,
      );
      return { blob, source: 'network', cacheWritePromise };
    }
    return { blob, source: 'network' };
  }

  ensureBlob(productionUrl, options = {}) {
    const callerSignal = options.signal || null;
    const requestedPriority = this.normalizeRequestPriority(options.priority);
    this.rememberLatestRequestedProductionUrl(productionUrl);
    const snapshot = this.snapshotGeneration(productionUrl);
    const current = this.inFlight.get(productionUrl);
    if (
      current
      && !current.signal?.aborted
      && current.snapshot.global === snapshot.global
      && current.snapshot.key === snapshot.key
    ) {
      if (requestedPriority === 'foreground') {
        current.priority = 'foreground';
        this.promoteDispatchedFetch(current);
      }
      return current;
    }
    const abortController = typeof globalThis.AbortController === 'function'
      ? new globalThis.AbortController()
      : null;
    const signal = abortController?.signal || callerSignal;
    const abortFromCaller = () => abortController?.abort();
    if (callerSignal && abortController) {
      if (callerSignal.aborted) abortController.abort();
      else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
    }
    const entry = {
      snapshot,
      signal,
      abortController,
      callerSignal,
      abortFromCaller,
      priority: requestedPriority,
      liveRequestId: null,
      dispatchedPriority: null,
      promotionRequestId: null,
      blobPromise: null,
      completionPromise: null,
    };
    const releaseEntry = () => {
      entry.callerSignal?.removeEventListener?.('abort', entry.abortFromCaller);
      if (this.inFlight.get(productionUrl) === entry) this.inFlight.delete(productionUrl);
    };
    entry.blobPromise = this.loadBlob(productionUrl, snapshot, signal, abortController, entry).then(
      (result) => {
        entry.completionPromise = result.cacheWritePromise || Promise.resolve(result);
        entry.completionPromise.then(releaseEntry, releaseEntry);
        return result;
      },
      (error) => {
        releaseEntry();
        throw error;
      },
    );
    this.inFlight.set(productionUrl, entry);
    return entry;
  }

  normalizePreemptionReason(reason) {
    if (reason === 'utility-modal-preemption') return 'utility-modal-preemption';
    if (reason === 'foreground-promotion') return 'foreground-promotion';
    if (reason === 'render-generation-preemption') return 'render-generation-preemption';
    if (reason === 'cache-destroyed') return 'cache-destroyed';
    return 'intentional-preemption';
  }

  recordPreemption(entry, reason) {
    if (entry.preemptionDetail) return null;
    this.preemptionSequence += 1;
    const detail = Object.freeze({
      requestId: entry.requestId,
      normalizedUrl: entry.normalizedUrl,
      reason: this.normalizePreemptionReason(reason),
      sequence: this.preemptionSequence,
    });
    const retained = [...this.diagnostics.preemptions, detail]
      .slice(-MAX_GALLERY_COVER_PREEMPTION_DIAGNOSTICS);
    this.diagnostics.preemptionCount += 1;
    this.diagnostics.preemptionSequence = this.preemptionSequence;
    this.diagnostics.lastPreemption = detail;
    this.diagnostics.preemptions = Object.freeze(retained);
    entry.preemptionDetail = detail;
    return detail;
  }

  dispatchPreemption(detail) {
    if (!detail) return;
    if (typeof globalThis.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent('album-haven:gallery-cover-cache-preemption', { detail }));
    }
  }

  recordInFlightPreemption(productionUrl, reason = 'intentional-preemption') {
    const normalizedUrl = this.normalizeProductionUrl(productionUrl);
    const entry = this.inFlight.get(normalizedUrl);
    const liveFetch = entry?.liveRequestId
      ? this.liveFetches.get(entry.liveRequestId)
      : null;
    if (
      this.preemptionTransactionActive
      || !liveFetch
      || liveFetch.abortController?.signal?.aborted
    ) return null;
    this.preemptionTransactionActive = true;
    try {
      const detail = this.recordPreemption(liveFetch, reason);
      this.dispatchPreemption(detail);
      return detail;
    } finally {
      this.preemptionTransactionActive = false;
    }
  }

  promoteDispatchedFetch(entry) {
    if (
      this.preemptionTransactionActive
      || entry?.dispatchedPriority !== 'background'
      || !entry.liveRequestId
      || entry.promotionRequestId
    ) return false;
    const liveFetch = this.liveFetches.get(entry.liveRequestId);
    if (!liveFetch?.promotionSafe || liveFetch.abortController?.signal?.aborted) return false;
    entry.promotionRequestId = liveFetch.requestId;
    entry.dispatchedPriority = 'promoting';
    this.preemptionTransactionActive = true;
    try {
      const detail = this.recordPreemption(liveFetch, 'foreground-promotion');
      liveFetch.abortController.abort();
      this.dispatchPreemption(detail);
      return true;
    } finally {
      this.preemptionTransactionActive = false;
    }
  }

  abortInFlight(reason = 'intentional-preemption') {
    if (this.preemptionTransactionActive) return Object.freeze([]);
    const normalizedReason = this.normalizePreemptionReason(reason);
    const liveEntries = [];
    this.liveFetches.forEach((entry, requestId) => {
      if (!entry.abortController?.signal?.aborted) liveEntries.push(entry);
      if (this.liveFetches.get(requestId) === entry) this.liveFetches.delete(requestId);
    });
    this.preemptionTransactionActive = true;
    try {
      const details = [];
      liveEntries.forEach((entry) => {
        const detail = this.recordPreemption(entry, normalizedReason);
        if (detail) details.push(detail);
        entry.abortController?.abort();
      });
      this.inFlight.forEach((entry) => entry.abortController?.abort());
      details.forEach((detail) => this.dispatchPreemption(detail));
      return Object.freeze([...details]);
    } finally {
      this.preemptionTransactionActive = false;
    }
  }

  async prefetch(productionUrl, options = {}) {
    const normalizedUrl = this.normalizeProductionUrl(productionUrl);
    if (!normalizedUrl) return { productionUrl: String(productionUrl || ''), cached: false };
    const snapshot = this.snapshotGeneration(normalizedUrl);
    try {
      const entry = this.ensureBlob(normalizedUrl, { ...options, priority: 'background' });
      const blobResult = await this.awaitWithAbort(entry.blobPromise, options.signal || null);
      const result = await this.awaitWithAbort(
        blobResult.cacheWritePromise || entry.completionPromise || Promise.resolve(blobResult),
        options.signal || null,
      );
      return {
        productionUrl: normalizedUrl,
        cached: !result.stale && !result.writeFailed && this.generationMatches(normalizedUrl, snapshot),
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        return { productionUrl: normalizedUrl, cached: false, cancelled: true };
      }
      this.recordDiagnostic('fallback', normalizedUrl, error);
      return { productionUrl: normalizedUrl, cached: false };
    }
  }

  async resolve(productionUrl, options = {}) {
    const normalizedUrl = this.normalizeProductionUrl(productionUrl);
    if (!normalizedUrl) {
      return { displayUrl: String(productionUrl || ''), productionUrl: String(productionUrl || ''), cached: false };
    }
    const signal = options.signal || null;
    this.throwIfAborted(signal);
    const active = this.activeObjectUrls.get(normalizedUrl);
    if (active) {
      this.activeObjectUrls.delete(normalizedUrl);
      this.activeObjectUrls.set(normalizedUrl, active);
      this.syncActiveDiagnostics();
      return { displayUrl: active, productionUrl: normalizedUrl, cached: true };
    }
    const snapshot = this.snapshotGeneration(normalizedUrl);
    try {
      const result = await this.awaitWithAbort(
        this.ensureBlob(normalizedUrl, { signal, priority: 'foreground' }).blobPromise,
        signal,
      );
      this.throwIfAborted(signal);
      if (result.stale || !this.generationMatches(normalizedUrl, snapshot)) {
        return { displayUrl: normalizedUrl, productionUrl: normalizedUrl, cached: false };
      }
      if (typeof this.urlApi?.createObjectURL !== 'function') {
        throw new Error('Object URL browser API is unavailable.');
      }
      const concurrentlyActivated = this.activeObjectUrls.get(normalizedUrl);
      if (concurrentlyActivated) {
        this.activeObjectUrls.delete(normalizedUrl);
        this.activeObjectUrls.set(normalizedUrl, concurrentlyActivated);
        this.syncActiveDiagnostics();
        return { displayUrl: concurrentlyActivated, productionUrl: normalizedUrl, cached: true };
      }
      const objectUrl = this.urlApi.createObjectURL(result.blob);
      if (!this.generationMatches(normalizedUrl, snapshot)) {
        this.urlApi?.revokeObjectURL?.(objectUrl);
        return { displayUrl: normalizedUrl, productionUrl: normalizedUrl, cached: false };
      }
      this.rememberObjectUrl(normalizedUrl, objectUrl);
      return { displayUrl: objectUrl, productionUrl: normalizedUrl, cached: true };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      this.recordDiagnostic('fallback', normalizedUrl, error);
      return { displayUrl: normalizedUrl, productionUrl: normalizedUrl, cached: false };
    }
  }

  async invalidate(productionUrl) {
    const normalizedUrl = this.normalizeProductionUrl(productionUrl);
    if (!normalizedUrl) return false;
    this.keyGenerations.set(normalizedUrl, this.keyGeneration(normalizedUrl) + 1);
    const objectUrl = this.activeObjectUrls.get(normalizedUrl);
    if (objectUrl) {
      this.activeObjectUrls.delete(normalizedUrl);
      this.urlApi?.revokeObjectURL?.(objectUrl);
      this.syncActiveDiagnostics();
    }
    try {
      const cache = await this.openCache();
      return Boolean(await cache.delete(normalizedUrl));
    } catch (error) {
      this.recordDiagnostic('fallback', normalizedUrl, error);
      return false;
    }
  }

  destroy() {
    this.generation += 1;
    this.abortInFlight('cache-destroyed');
    this.activeObjectUrls.forEach((objectUrl) => this.urlApi?.revokeObjectURL?.(objectUrl));
    this.activeObjectUrls.clear();
    this.syncActiveDiagnostics();
    this.liveFetches.clear();
    this.inFlight.clear();
    this.latestRequestedProductionUrls.clear();
  }
}

const galleryCoverPreviewCache = new GalleryCoverPreviewCache();
globalThis.__ALBUM_HAVEN_GALLERY_COVER_CACHE__ = galleryCoverPreviewCache.diagnostics;
const galleryCoverImageRequestTokens = new WeakMap();

function beginGalleryCoverImageRequest(image, productionUrl) {
  if (!(image instanceof HTMLImageElement)) return null;
  if (typeof markAlbumDisplayCoverImagePending === 'function') {
    markAlbumDisplayCoverImagePending(image);
  }
  const requestToken = Number(galleryCoverImageRequestTokens.get(image) || 0) + 1;
  galleryCoverImageRequestTokens.set(image, requestToken);
  image.setAttribute('data-production-cover-src', productionUrl);
  return { image, productionUrl, requestToken };
}

function commitGalleryCoverImageRequest(request, result) {
  if (!request || galleryCoverImageRequestTokens.get(request.image) !== request.requestToken) return false;
  request.image.setAttribute('data-production-cover-src', result.productionUrl);
  request.image.src = result.displayUrl;
  return true;
}

function restoreGalleryCoverImageRequest(request) {
  if (!request || galleryCoverImageRequestTokens.get(request.image) !== request.requestToken) return null;
  galleryCoverImageRequestTokens.set(request.image, request.requestToken + 1);
  request.image.setAttribute('data-gallery-cover-src', request.productionUrl);
  request.image.removeAttribute('data-gallery-cover-loading');
  return request.image;
}

async function loadGalleryCoverPreviewImage(image, productionUrl, options = {}) {
  if (!(image instanceof HTMLImageElement)) return null;
  const requestedUrl = String(productionUrl || '').trim();
  if (!requestedUrl) return null;
  const request = beginGalleryCoverImageRequest(image, requestedUrl);
  const result = await galleryCoverPreviewCache.resolve(requestedUrl);
  if (typeof options.isCurrent === 'function' && !options.isCurrent()) return null;
  if (!commitGalleryCoverImageRequest(request, result)) return null;
  return result;
}
