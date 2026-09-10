import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const JOSEPH_COVER_FILENAME = 'Neal Morse - The Dreamer - Joseph, Pt. One.png';
const JOSEPH_PREVIEW_RESPONSE_HASH = '84b7ef18d9c825fcedfb872a40835b7d9667f497936b0ad2ba526ff096531568';
const JOSEPH_FULL_RESPONSE_HASH = '982c12c0697ed661a18f230290dc81a5a72a950cce2efb5ea8ee184f1693f491';
const JOSEPH_ZOOMED_DETAIL_HASH = '12efccbc8b10d830762730e24dfe35d8c9738abbbefb0027f8a55592cdd3059c';

export function observeExactCoverTraffic(page) {
  const requestCounts = new Map();
  const responseCounts = new Map();
  const responseEvidence = new Map();
  const requestFailures = new Map();
  const responseWaiters = new Map();
  const normalizeCoverUrl = (rawUrl) => {
    const value = String(rawUrl || '');
    if (!URL.canParse(value)) return '';
    const url = new URL(value);
    const currentPageUrl = page.url();
    if (!URL.canParse(currentPageUrl)) return '';
    return url.origin === new URL(currentPageUrl).origin && url.pathname === '/cover' ? url.href : '';
  };
  const isPinnedJosephCoverUrl = (rawUrl) => {
    if (!URL.canParse(String(rawUrl || ''))) return false;
    const url = new URL(String(rawUrl || ''));
    const coverPath = decodeURIComponent(url.searchParams.get('path') || '');
    const size = url.searchParams.get('size');
    return path.basename(coverPath) === JOSEPH_COVER_FILENAME
      && (size === null || size === '480');
  };
  const onRequest = (request) => {
    if (request.method() !== 'GET') return;
    const url = normalizeCoverUrl(request.url());
    if (!url) return;
    requestCounts.set(url, (requestCounts.get(url) || 0) + 1);
  };
  const onResponse = async (response) => {
    if (response.request().method() !== 'GET') return;
    const url = normalizeCoverUrl(response.url());
    if (!url) return;
    const evidence = {
      url,
      status: response.status(),
      bodyHash: '',
    };
    if (!responseEvidence.has(url)) responseEvidence.set(url, []);
    responseEvidence.get(url).push(evidence);
    if (response.ok()) {
      responseCounts.set(url, (responseCounts.get(url) || 0) + 1);
      if (isPinnedJosephCoverUrl(url)) {
        try {
          evidence.bodyHash = createHash('sha256').update(await response.body()).digest('hex');
        } catch {
          evidence.bodyHash = '';
        }
      }
    }
    for (const waiter of responseWaiters.get(url) || []) waiter();
  };
  const onRequestFailed = (request) => {
    if (request.method() !== 'GET') return;
    const url = normalizeCoverUrl(request.url());
    if (!url) return;
    if (!requestFailures.has(url)) requestFailures.set(url, []);
    requestFailures.get(url).push({
      url,
      errorText: request.failure()?.errorText || 'requestfailed',
    });
    for (const waiter of responseWaiters.get(url) || []) waiter();
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  return {
    requestCount(url) {
      return requestCounts.get(String(url || '')) || 0;
    },
    responseCount(url) {
      return responseCounts.get(String(url || '')) || 0;
    },
    totalRequestCount() {
      return [...requestCounts.values()].reduce((sum, count) => sum + count, 0);
    },
    async waitForResponse(url, options = {}) {
      const expectedUrl = String(url || '');
      const expectedStatus = Number(options.status || 200);
      const requireBodyHash = options.requireBodyHash !== false
        && expectedStatus >= 200
        && expectedStatus < 300
        && isPinnedJosephCoverUrl(expectedUrl);
      const readEvidence = () => {
        const failure = (requestFailures.get(expectedUrl) || [])[0];
        if (failure) {
          throw new Error(`Exact cover request failed: ${failure.errorText}`);
        }
        return (responseEvidence.get(expectedUrl) || []).find((entry) => (
          entry.status === expectedStatus && (!requireBodyHash || entry.bodyHash)
        )) || null;
      };
      const existing = readEvidence();
      if (existing) return { ...existing };
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for exact cover response: ${expectedUrl}`));
        }, options.timeout || 15000);
        const check = () => {
          try {
            const evidence = readEvidence();
            if (!evidence) return;
            cleanup();
            resolve({ ...evidence });
          } catch (error) {
            cleanup();
            reject(error);
          }
        };
        const cleanup = () => {
          clearTimeout(timeout);
          const waiters = responseWaiters.get(expectedUrl);
          waiters?.delete(check);
          if (waiters?.size === 0) responseWaiters.delete(expectedUrl);
        };
        if (!responseWaiters.has(expectedUrl)) responseWaiters.set(expectedUrl, new Set());
        responseWaiters.get(expectedUrl).add(check);
        check();
      });
    },
    stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
    },
  };
}

export async function readPagePerformanceNow(page) {
  // parity-check: allow-read-only-measurement-evaluate -- native monotonic submission boundary only
  return page.evaluate(() => performance.now());
}

export async function readDecodedImageCheckpoint(image, options = {}) {
  // parity-check: allow-read-only-measurement-evaluate -- await native load/decode and read dimensions, source, and offscreen pixels only
  const imageState = await image.evaluate(async (element, startedAtMs) => {
    if (!(element.complete && element.naturalWidth > 0)) {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          element.removeEventListener('load', onLoad);
          element.removeEventListener('error', onError);
        };
        const onLoad = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('Gallery cover failed before decode.')); };
        element.addEventListener('load', onLoad, { once: true });
        element.addEventListener('error', onError, { once: true });
      });
    }
    await element.decode();
    const sampledDecodedAtMs = performance.now();
    const capturedDecodedAtMs = Number(
      element.getAttribute('data-cover-decoded-at-ms'),
    );
    const hasTimingStart = Number(startedAtMs || 0) > 0;
    const hasValidCapturedBoundary = Number.isFinite(capturedDecodedAtMs)
      && capturedDecodedAtMs >= Number(startedAtMs);
    if (hasTimingStart && !hasValidCapturedBoundary) {
      throw new Error('Expected the gallery cover to expose its current native decode timestamp.');
    }
    const decodedAtMs = hasTimingStart ? capturedDecodedAtMs : sampledDecodedAtMs;
    return {
      src: element.currentSrc || element.src || '',
      productionSrc: element.getAttribute('data-production-cover-src') || '',
      complete: element.complete,
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      visualState: element.getAttribute('data-cover-visual-state') || '',
      ariaHidden: element.getAttribute('aria-hidden'),
      visibility: getComputedStyle(element).visibility,
      decodedAtMs,
      decodedElapsedMs: Number(startedAtMs || 0) > 0 ? decodedAtMs - Number(startedAtMs) : null,
      pixels: (() => {
      const canvas = new OffscreenCanvas(64, 64);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(element, 0, 0, 64, 64);
      return Array.from(context.getImageData(0, 0, 64, 64).data);
      })(),
    };
  }, Number(options.startedAtMs || 0));
  const bounds = await image.boundingBox();
  const screenshot = await image.screenshot({ animations: 'disabled' });
  const pixels = imageState.pixels;
  delete imageState.pixels;
  return {
    ...imageState,
    bounds,
    pixelHash: createHash('sha256').update(Buffer.from(pixels)).digest('hex'),
    screenshotHash: createHash('sha256').update(screenshot).digest('hex'),
  };
}

export function expectDecodedCheckpoint(expect, checkpoint) {
  expect(checkpoint.src).not.toEqual('');
  expect(checkpoint.complete).toBe(true);
  expect(checkpoint.naturalWidth).toBeGreaterThan(0);
  expect(checkpoint.naturalHeight).toBeGreaterThan(0);
  expect(checkpoint.bounds?.width || 0).toBeGreaterThan(0);
  expect(checkpoint.bounds?.height || 0).toBeGreaterThan(0);
}

export function expectAlbumCardCoverPresentationReady(expect, checkpoint) {
  expect(checkpoint.visualState).toBe('ready');
  expect(checkpoint.ariaHidden).toBeNull();
  expect(checkpoint.visibility).toBe('visible');
}

export function expectJosephFixtureCheckpoint(expect, checkpoint, options = {}) {
  expectDecodedCheckpoint(expect, checkpoint);
  expect(decodeURIComponent(checkpoint.productionSrc || checkpoint.src)).toContain(JOSEPH_COVER_FILENAME);
  expect(checkpoint.naturalWidth).toBe(options.fullscreen ? 1200 : 480);
  expect(checkpoint.naturalHeight).toBe(checkpoint.naturalWidth);
}

export function expectJosephCoverRouteResponse(expect, evidence, options = {}) {
  const routeUrl = new URL(evidence.url);
  expect(routeUrl.pathname).toBe('/cover');
  expect(decodeURIComponent(routeUrl.searchParams.get('path') || '')).toContain(JOSEPH_COVER_FILENAME);
  expect(routeUrl.searchParams.get('size')).toBe(options.fullscreen ? null : '480');
  expect(evidence.status).toBe(200);
  expect(evidence.bodyHash).toBe(
    options.fullscreen ? JOSEPH_FULL_RESPONSE_HASH : JOSEPH_PREVIEW_RESPONSE_HASH,
  );
}

export function temporarilyMakeJosephCoverUnavailable(
  fullCoverUrl,
  baseUrl = '',
  { mediaRoot = process.env.ALBUM_HAVEN_MEDIA_ROOT } = {},
) {
  const normalizedBaseUrl = String(baseUrl || '').trim();
  const coverUrl = normalizedBaseUrl
    ? new URL(String(fullCoverUrl || ''), normalizedBaseUrl)
    : new URL(String(fullCoverUrl || ''));
  const sourcePath = path.resolve(decodeURIComponent(coverUrl.searchParams.get('path') || ''));
  const resolvedMediaRoot = path.resolve(String(mediaRoot || ''));
  const relativeToMedia = path.relative(resolvedMediaRoot, sourcePath);
  const isOwnedFixturePath = String(mediaRoot || '').trim() !== ''
    && relativeToMedia !== ''
    && !relativeToMedia.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeToMedia);
  if (
    !isOwnedFixturePath
    || path.basename(sourcePath) !== JOSEPH_COVER_FILENAME
    || !fs.statSync(sourcePath).isFile()
  ) {
    throw new Error('Refusing to alter a cover path that is not the test-owned Joseph fixture.');
  }
  const unavailablePath = `${sourcePath}.temporarily-unavailable-${process.pid}`;
  fs.renameSync(sourcePath, unavailablePath);
  let restored = false;
  return {
    sourcePath,
    restore() {
      if (restored) return;
      fs.renameSync(unavailablePath, sourcePath);
      restored = true;
    },
  };
}

export async function expectZoomedJosephDetailScreenshot(expect, page, lightbox) {
  const bounds = await lightbox.boundingBox();
  expect(bounds).not.toBeNull();
  const detailSize = 320;
  const clip = {
    x: Math.round(bounds.x + ((bounds.width - detailSize) / 2)),
    y: Math.round(bounds.y + ((bounds.height - detailSize) / 2)),
    width: detailSize,
    height: detailSize,
  };
  const screenshot = await page.screenshot({
    animations: 'disabled',
    clip,
  });
  expect(createHash('sha256').update(screenshot).digest('hex'))
    .toBe(JOSEPH_ZOOMED_DETAIL_HASH);
}
