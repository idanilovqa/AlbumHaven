const GALLERY_COVER_PREVIEW_CACHE_PREFIX = 'album-haven-gallery-previews-';
const GALLERY_COVER_PREVIEW_CACHE_VERSION = 'v3';
const GALLERY_COVER_PREVIEW_CACHE_NAME = `${GALLERY_COVER_PREVIEW_CACHE_PREFIX}${GALLERY_COVER_PREVIEW_CACHE_VERSION}`;
const MAX_ACTIVE_GALLERY_COVER_OBJECT_URLS = 48;
const MAX_GALLERY_COVER_PREEMPTION_DIAGNOSTICS = 64;
const GALLERY_COVER_REQUEST_ID_HEADER = 'X-Album-Haven-Cover-Request-Id';
const GALLERY_COVER_PRIORITY_HEADER = 'X-Album-Haven-Cover-Priority';
// Stored covers carry no file path: the key is the opaque key the app-copy worker uses (the
// SHA-256 of the cover URL without its version), and the version it answers is the URL's `v`.
const GALLERY_COVER_VERSION_HEADER = 'X-Album-Haven-Cover-Version';
const GALLERY_COVER_KEY_PREFIX = '/__album-haven-cover/';
const MAX_REMEMBERED_COVER_KEYS = 4096;
const GALLERY_COVER_SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// SHA-256 of [text] as UTF-8, hex. Synchronous, for short cover URLs; the app-copy worker computes
// the same digest with crypto.subtle.
function galleryCoverSha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const length = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(length);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(length - 4, (bytes.length << 3) >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotate(words[i - 15], 7) ^ rotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotate(words[i - 2], 17) ^ rotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g))
        + GALLERY_COVER_SHA256_K[i] + words[i]) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => { hash[i] = (hash[i] + value) >>> 0; });
  }
  return Array.from(hash, word => word.toString(16).padStart(8, '0')).join('');
}

class GalleryCoverPreviewCache {
  constructor(options = {}) {
    this.cacheStorage = options.cacheStorage ?? globalThis.caches ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis) ?? null;
    this.urlApi = options.urlApi ?? globalThis.URL ?? null;
    this.locationOrigin = String(options.locationOrigin ?? globalThis.location?.origin ?? '').trim();
    this.cacheName = String(options.cacheName || GALLERY_COVER_PREVIEW_CACHE_NAME);
    this.maxActiveObjectUrls = Math.max(1, Number(options.maxActiveObjectUrls || MAX_ACTIVE_GALLERY_COVER_OBJECT_URLS));
    this.activeObjectUrls = new Map();
    this.imageObjectUrls = new WeakMap();
    this.objectUrlConsumerCounts = new Map();
    this.retiredObjectUrls = new Set();
    this.inFlight = new Map();
    this.writeChains = new Map();
    this.liveFetches = new Map();
    this.keyGenerations = new Map();
    this.latestRequestedProductionUrls = new Map();
    // Each production URL's stored key, hashed once.
    this.coverKeys = new Map();
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

  // [productionUrl]'s stored key: the same key as app-copy-worker.js coverKey (the SHA-256 of
  // the URL without its version; one per cover and size), computed synchronously and remembered,
  // so a cover load does no more asynchronous work than it did with path keys.
  storedCoverKey(productionUrl) {
    let key = this.coverKeys.get(productionUrl);
    if (!key) {
      const url = new URL(productionUrl);
      url.searchParams.delete('v');
      key = `${url.origin}${GALLERY_COVER_KEY_PREFIX}${galleryCoverSha256Hex(`${url.pathname}${url.search}`)}`;
      if (this.coverKeys.size >= MAX_REMEMBERED_COVER_KEYS) this.coverKeys.clear();
      this.coverKeys.set(productionUrl, key);
    }
    return key;
  }

  // The version a stored blob answers: the URL's `v`, the only part that differs between versions
  // under one key. It names a revision, never a file.
  coverVersionTag(productionUrl) {
    return new URL(productionUrl).searchParams.get('v') || '';
  }

  createCacheableResponse(response, blob, versionTag) {
    if (typeof globalThis.Response !== 'function') return null;
    const contentType = String(blob?.type || this.responseContentType(response) || '').trim();
    return new globalThis.Response(blob, {
      status: Number(response?.status || 200),
      statusText: String(response?.statusText || ''),
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        [GALLERY_COVER_VERSION_HEADER]: versionTag,
      },
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

  rememberObjectUrl(productionUrl, objectUrl) {
    const previous = this.activeObjectUrls.get(productionUrl);
    if (previous && previous !== objectUrl) this.retireObjectUrl(previous);
    this.activeObjectUrls.delete(productionUrl);
    this.activeObjectUrls.set(productionUrl, objectUrl);
    while (this.activeObjectUrls.size > this.maxActiveObjectUrls) {
      const oldest = this.activeObjectUrls.entries().next().value;
      if (!oldest) break;
      this.activeObjectUrls.delete(oldest[0]);
      this.retireObjectUrl(oldest[1]);
    }
    this.syncActiveDiagnostics();
  }

  retireObjectUrl(objectUrl) {
    if (this.objectUrlConsumerCounts.has(objectUrl)) {
      this.retiredObjectUrls.add(objectUrl);
      return;
    }
    this.urlApi?.revokeObjectURL?.(objectUrl);
  }

  retainImageObjectUrl(image, objectUrl) {
    const previous = this.imageObjectUrls.get(image);
    if (previous === objectUrl) return;
    this.releaseImageObjectUrl(image);
    if (!String(objectUrl || '').startsWith('blob:')) return;
    this.imageObjectUrls.set(image, objectUrl);
    this.objectUrlConsumerCounts.set(objectUrl, Number(this.objectUrlConsumerCounts.get(objectUrl) || 0) + 1);
  }

  releaseImageObjectUrl(image) {
    const objectUrl = this.imageObjectUrls.get(image);
    if (!objectUrl) return;
    this.imageObjectUrls.delete(image);
    const remaining = Number(this.objectUrlConsumerCounts.get(objectUrl) || 0) - 1;
    if (remaining > 0) {
      this.objectUrlConsumerCounts.set(objectUrl, remaining);
      return;
    }
    this.objectUrlConsumerCounts.delete(objectUrl);
    if (!this.retiredObjectUrls.delete(objectUrl)) return;
    this.urlApi?.revokeObjectURL?.(objectUrl);
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
        const storedKey = this.storedCoverKey(productionUrl);
        await this.deferCacheWrite(async () => {
          if (!shouldContinue()) return;
          await cache.put(storedKey, cacheCandidate);
          wroteCacheEntry = true;
        });
        if (!shouldContinue()) {
          if (wroteCacheEntry || !this.isLatestRequestedProductionUrl(productionUrl)) {
            await cache.delete(storedKey);
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
    const cacheKey = this.storedCoverKey(productionUrl);
    const versionTag = this.coverVersionTag(productionUrl);
    const cachedResponse = await cache.match(cacheKey);
    this.throwIfAborted(signal);
    if (cachedResponse?.headers?.get?.(GALLERY_COVER_VERSION_HEADER) === versionTag) {
      try {
        const blob = await this.validatedBlob(cachedResponse);
        this.throwIfAborted(signal);
        return { blob, source: 'cache', stale: !this.generationMatches(productionUrl, snapshot) };
      } catch (error) {
        if (signal?.aborted) this.throwIfAborted(signal);
        if (error?.name === 'AbortError') throw error;
        try {
          await cache.delete(cacheKey);
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
        cacheCandidate = this.createCacheableResponse(response, blob, versionTag);
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
      this.retireObjectUrl(objectUrl);
      this.syncActiveDiagnostics();
    }
    try {
      const cache = await this.openCache();
      return Boolean(await cache.delete(this.storedCoverKey(normalizedUrl)));
    } catch (error) {
      this.recordDiagnostic('fallback', normalizedUrl, error);
      return false;
    }
  }

  destroy() {
    this.generation += 1;
    this.abortInFlight('cache-destroyed');
    new Set([...this.activeObjectUrls.values(), ...this.retiredObjectUrls])
      .forEach((objectUrl) => this.urlApi?.revokeObjectURL?.(objectUrl));
    this.activeObjectUrls.clear();
    this.imageObjectUrls = new WeakMap();
    this.objectUrlConsumerCounts.clear();
    this.retiredObjectUrls.clear();
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
  galleryCoverPreviewCache.retainImageObjectUrl(request.image, result.displayUrl);
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
