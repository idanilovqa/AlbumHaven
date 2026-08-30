import { expect } from '@playwright/test';

const POSTGRES_LIBRARY_BROWSE_SOURCE_FIELDS = [
  'view_data_source',
  'persistence_source',
  'source',
  'telemetry_source',
];

const POSTGRES_LIBRARY_BROWSE_FALLBACK_MARKER_FIELDS = [
  'json_cache_authoritative',
  'file_fixture',
  'cache_source',
];

export async function collectJsonResponsesDuringAction(page, matchesResponse, action) {
  const responseJsonPromises = [];
  const collectResponse = (response) => {
    if (matchesResponse(response)) {
      responseJsonPromises.push(response.json());
    }
  };

  page.on('response', collectResponse);
  try {
    await action();
  } finally {
    page.off('response', collectResponse);
  }
  return Promise.all(responseJsonPromises);
}

export function isRootAlbumsViewDataResponse(response) {
  const url = new URL(response.url());
  return url.pathname === '/view-data'
    && url.searchParams.get('surface') === 'albums'
    && !url.searchParams.has('artist')
    && !url.searchParams.has('q')
    && !url.searchParams.has('payload_tier');
}

export function expectPostgresLibraryBrowseTelemetry(payload, expectedPayloadTier = null) {
  expect(payload.persistence_backend).toBe('postgres');
  expect(payload.persistence_seam).toBe('library_browse');
  expect(payload.view_data_source).toBe('postgres_library_browse');
  if (expectedPayloadTier !== null) {
    expect(payload.payload_tier).toBe(expectedPayloadTier);
  }

  expect(payload.persistence_backend).not.toBe('file');
  const sourceValues = POSTGRES_LIBRARY_BROWSE_SOURCE_FIELDS.map((field) => (
    String(payload[field] || '')
  ));
  expect(sourceValues.join(' ')).not.toMatch(/json|file|fixture|cache/i);
  for (const field of POSTGRES_LIBRARY_BROWSE_FALLBACK_MARKER_FIELDS) {
    expect(payload[field], `Expected ${field} to be absent on Postgres authoritative payloads.`).toBeUndefined();
  }
}

export function expectAtLeastOnePostgresLibraryBrowseTelemetryPayload(payloads, expectedPayloadTier = null) {
  expect(Array.isArray(payloads)).toBe(true);
  expect(payloads.length, 'Expected at least one matching root view-data response during app-open startup.').toBeGreaterThan(0);
  const authoritativePayload = payloads.find((payload) => (
    payload?.persistence_backend === 'postgres'
    && payload?.persistence_seam === 'library_browse'
    && payload?.view_data_source === 'postgres_library_browse'
  ));
  expect(
    authoritativePayload,
    'Expected at least one authoritative Postgres library-browse telemetry payload.',
  ).toBeTruthy();
  expectPostgresLibraryBrowseTelemetry(authoritativePayload, expectedPayloadTier);
  return authoritativePayload;
}

async function collectGarbage(cdpSession) {
  if (!cdpSession) return;
  await cdpSession.send('HeapProfiler.enable');
  await cdpSession.send('HeapProfiler.collectGarbage');
}

async function readMeasureMemory(page) {
  // parity-check: allow-read-only-measurement-evaluate -- browser memory measurement only
  return page.evaluate(async () => {
    if (typeof performance.measureUserAgentSpecificMemory !== 'function') {
      return null;
    }
    try {
      const result = await performance.measureUserAgentSpecificMemory();
      return {
        source: 'measureUserAgentSpecificMemory',
        bytes: Number(result?.bytes || 0),
      };
    } catch (error) {
      return {
        source: 'measureUserAgentSpecificMemory_error',
        bytes: 0,
        error: String(error && error.message ? error.message : error),
      };
    }
  });
}

async function readFallbackMemory(page, cdpSession) {
  if (cdpSession) {
    const metricsPayload = await cdpSession.send('Performance.getMetrics');
    const metricMap = new Map((metricsPayload.metrics || []).map((entry) => [entry.name, entry.value]));
    const heapBytes = Number(metricMap.get('JSHeapUsedSize') || 0);
    if (heapBytes > 0) {
      return {
        source: 'Performance.getMetrics:JSHeapUsedSize',
        bytes: heapBytes,
      };
    }
    const heapUsage = await cdpSession.send('Runtime.getHeapUsage');
    if (Number(heapUsage?.usedSize || 0) > 0) {
      return {
        source: 'Runtime.getHeapUsage',
        bytes: Number(heapUsage.usedSize || 0),
      };
    }
  }
  // parity-check: allow-read-only-measurement-evaluate -- browser heap metric read only
  return page.evaluate(() => ({
    source: 'performance.memory.usedJSHeapSize',
    bytes: Number(performance?.memory?.usedJSHeapSize || 0),
  }));
}

function isChromiumBrowser(page) {
  const browser = page.context().browser();
  if (!browser || typeof browser.browserType !== 'function') {
    return false;
  }
  const browserType = browser.browserType();
  return typeof browserType?.name === 'function' && browserType.name() === 'chromium';
}

export async function sampleIdleMemory(page, options = {}) {
  const sampleCount = Number(options.sampleCount || 1);
  const delayMs = Number(options.delayMs || 0);
  const cdpSession = isChromiumBrowser(page)
    ? await page.context().newCDPSession(page)
    : null;
  const samples = [];

  for (let index = 0; index < sampleCount; index += 1) {
    if (index > 0 && delayMs > 0) {
      await page.waitForTimeout(delayMs);
    }
    await collectGarbage(cdpSession);
    const measureMemory = await readMeasureMemory(page);
    const sample = measureMemory && measureMemory.bytes > 0
      ? measureMemory
      : await readFallbackMemory(page, cdpSession);
    samples.push({
      index,
      source: sample.source,
      bytes: Number(sample.bytes || 0),
      error: sample.error || null,
    });
  }

  return samples;
}

export async function sampleMemoryPoint(page) {
  const [sample] = await sampleIdleMemory(page, { sampleCount: 1 });
  return sample || {
    index: 0,
    source: 'unavailable',
    bytes: 0,
    error: null,
  };
}

export async function measureActionTime(action, readyCheck = null) {
  const startedAt = Date.now();
  await action();
  if (readyCheck) {
    await readyCheck();
  }
  return Date.now() - startedAt;
}

export async function samplePeakMemory(page, options = {}) {
  const idleSamples = await sampleIdleMemory(page, options);
  const peakBytes = Math.max(...idleSamples.map((sample) => Number(sample.bytes || 0)), 0);
  return {
    idleSamples,
    peakBytes,
    peakMb: peakBytes / (1024 * 1024),
  };
}

export function summarizePeakMemory(memorySummary) {
  const peakSample = [...(memorySummary?.idleSamples || [])]
    .sort((left, right) => Number(right.bytes || 0) - Number(left.bytes || 0))[0];
  return {
    bytes: Number(memorySummary?.peakBytes || 0),
    source: peakSample?.source || null,
    samples: memorySummary?.idleSamples || [],
  };
}

export function formatMegabytes(bytes) {
  return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)} MB`;
}
