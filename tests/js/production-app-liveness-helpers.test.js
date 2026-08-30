const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const helperUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'helpers',
  'productionAppLivenessHelpers.js',
)).href;

function jsonResponse(payload, options = {}) {
  return {
    ok: () => options.ok !== false,
    status: () => Number(options.status || 200),
    json: async () => payload,
  };
}

function createPage(responses) {
  const calls = [];
  return {
    calls,
    request: {
      async get(requestPath, options) {
        calls.push(['get', requestPath, options]);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    },
    async waitForTimeout(intervalMs) {
      calls.push(['wait', intervalMs]);
    },
  };
}

function statusPayload(overrides = {}) {
  return {
    scan_in_progress: false,
    ...overrides,
  };
}

function sidebarPayload(overrides = {}) {
  return {
    persistence_backend: 'postgres',
    persistence_seam: 'library_browse',
    view_data_source: 'postgres_library_browse',
    payload_tier: 'sidebar',
    album_count: 12,
    artist_count: 4,
    ...overrides,
  };
}

test('production liveness observer repeatedly probes normal status and Postgres sidebar routes', async () => {
  const { observeProductionAppLiveness } = await import(helperUrl);
  const page = createPage([
    jsonResponse(statusPayload()),
    jsonResponse(sidebarPayload()),
    jsonResponse(statusPayload({ scan_in_progress: true })),
    jsonResponse(sidebarPayload()),
    jsonResponse(statusPayload()),
    jsonResponse(sidebarPayload()),
  ]);

  const result = await observeProductionAppLiveness(page, {
    sampleCount: 3,
    intervalMs: 250,
    requestTimeoutMs: 700,
  });

  assert.equal(result.samples.length, 3);
  assert.deepEqual(
    result.samples.map((sample) => sample.scanInProgress),
    [false, true, false],
  );
  assert.deepEqual(page.calls, [
    ['get', '/status', { timeout: 700 }],
    ['get', '/view-data?surface=albums&payload_tier=sidebar', { timeout: 700 }],
    ['wait', 250],
    ['get', '/status', { timeout: 700 }],
    ['get', '/view-data?surface=albums&payload_tier=sidebar', { timeout: 700 }],
    ['wait', 250],
    ['get', '/status', { timeout: 700 }],
    ['get', '/view-data?surface=albums&payload_tier=sidebar', { timeout: 700 }],
  ]);
});

test('production liveness observer fails loudly on an unresponsive request', async () => {
  const { observeProductionAppLiveness } = await import(helperUrl);
  const page = createPage([new Error('request timed out after 700ms')]);

  await assert.rejects(
    observeProductionAppLiveness(page, {
      sampleCount: 2,
      intervalMs: 0,
      requestTimeoutMs: 700,
    }),
    /request timed out after 700ms/,
  );
});

test('production liveness observer rejects a non-Postgres or reduced view path', async () => {
  const { observeProductionAppLiveness } = await import(helperUrl);
  const page = createPage([
    jsonResponse(statusPayload()),
    jsonResponse(sidebarPayload({ persistence_backend: 'file' })),
  ]);

  await assert.rejects(
    observeProductionAppLiveness(page, {
      sampleCount: 2,
      intervalMs: 0,
    }),
    /must use Postgres library_browse authority/,
  );
});
