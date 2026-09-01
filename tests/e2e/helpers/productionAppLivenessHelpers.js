const STATUS_PATH = '/status';
const SIDEBAR_VIEW_PATH = '/view-data?surface=albums&payload_tier=sidebar';

async function readJsonResponse(page, path, requestTimeoutMs) {
  const startedAt = Date.now();
  const response = await page.evaluate(async ({ requestPath, timeoutMs }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fetch(requestPath, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const text = await result.text();
      let payload = null;
      let parseError = '';
      try {
        payload = JSON.parse(text);
      } catch (error) {
        parseError = String(error?.message || error);
      }
      return { ok: result.ok, status: result.status, payload, parseError };
    } finally {
      clearTimeout(timer);
    }
  }, { requestPath: path, timeoutMs: requestTimeoutMs });
  if (!response.ok) {
    throw new Error(`Production liveness request ${path} returned HTTP ${response.status}.`);
  }
  if (response.parseError) {
    throw new Error(
      `Production liveness request ${path} did not return JSON: ${response.parseError}`,
    );
  }
  return {
    elapsedMs: Date.now() - startedAt,
    payload: response.payload,
  };
}

function assertStatusPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Production /status liveness response must be a JSON object.');
  }
  if (typeof payload.scan_in_progress !== 'boolean') {
    throw new Error('Production /status liveness response must expose boolean scan_in_progress.');
  }
}

function assertSidebarViewPayload(payload) {
  if (
    payload?.persistence_backend !== 'postgres'
    || payload?.persistence_seam !== 'library_browse'
    || payload?.view_data_source !== 'postgres_library_browse'
    || payload?.payload_tier !== 'sidebar'
  ) {
    throw new Error(
      'Production sidebar liveness response must use Postgres library_browse authority.',
    );
  }
}

export async function observeProductionAppLiveness(page, options = {}) {
  const sampleCount = Number(options.sampleCount || 5);
  const intervalMs = Number(options.intervalMs || 500);
  const requestTimeoutMs = Number(options.requestTimeoutMs || 2000);
  if (!Number.isInteger(sampleCount) || sampleCount < 2) {
    throw new Error('Production liveness observation requires at least two samples.');
  }
  const startedAt = Date.now();
  const samples = [];

  for (let index = 0; index < sampleCount; index += 1) {
    if (index > 0 && intervalMs > 0) {
      await page.waitForTimeout(intervalMs);
    }
    const status = await readJsonResponse(page, STATUS_PATH, requestTimeoutMs);
    assertStatusPayload(status.payload);
    const view = await readJsonResponse(page, SIDEBAR_VIEW_PATH, requestTimeoutMs);
    assertSidebarViewPayload(view.payload);
    samples.push({
      index,
      statusElapsedMs: status.elapsedMs,
      viewElapsedMs: view.elapsedMs,
      scanInProgress: status.payload.scan_in_progress,
      albumCount: Number(view.payload.album_count || 0),
      artistCount: Number(view.payload.artist_count || 0),
    });
  }

  return {
    observationWindowMs: Date.now() - startedAt,
    samples,
  };
}
