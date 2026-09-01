const STATUS_PATH = '/status';
const SIDEBAR_VIEW_PATH = '/view-data?surface=albums&payload_tier=sidebar';

async function readJsonResponse(probePage, path, requestTimeoutMs) {
  const startedAt = Date.now();
  const response = await probePage.goto(path, {
    waitUntil: 'commit',
    timeout: requestTimeoutMs,
  });
  if (!response || !response.ok()) {
    const status = response ? response.status() : 0;
    throw new Error(`Production liveness request ${path} returned HTTP ${status}.`);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Production liveness request ${path} did not return JSON: ${String(error?.message || error)}`,
    );
  }
  return {
    elapsedMs: Date.now() - startedAt,
    payload,
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
  const probePage = await page.context().newPage();

  try {
    for (let index = 0; index < sampleCount; index += 1) {
      if (index > 0 && intervalMs > 0) {
        await page.waitForTimeout(intervalMs);
      }
      const status = await readJsonResponse(probePage, STATUS_PATH, requestTimeoutMs);
      assertStatusPayload(status.payload);
      const view = await readJsonResponse(probePage, SIDEBAR_VIEW_PATH, requestTimeoutMs);
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
  } finally {
    await probePage.close();
  }

  return {
    observationWindowMs: Date.now() - startedAt,
    samples,
  };
}
