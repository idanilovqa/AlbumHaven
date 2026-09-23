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
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function createPage(responses) {
  const calls = [];
  const probePage = {
    async goto(pathname, options) {
      calls.push(['goto', pathname, options.timeout]);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    async close() {
      calls.push(['close']);
    },
  };
  return {
    calls,
    context() {
      return {
        async newPage() {
          calls.push(['new-page']);
          return probePage;
        },
      };
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
    ['new-page'],
    ['goto', '/status', 700],
    ['goto', '/view-data?surface=albums&payload_tier=sidebar', 700],
    ['wait', 250],
    ['goto', '/status', 700],
    ['goto', '/view-data?surface=albums&payload_tier=sidebar', 700],
    ['wait', 250],
    ['goto', '/status', 700],
    ['goto', '/view-data?surface=albums&payload_tier=sidebar', 700],
    ['close'],
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

for (const stalledRoute of ['status', 'sidebar']) {
  test(`production liveness deadline includes the ${stalledRoute} response body`, async () => {
    const { observeProductionAppLiveness } = await import(helperUrl);
    let releaseBody;
    const blockedResponse = {
      ok: () => true,
      async text() {
        await new Promise((resolve) => { releaseBody = resolve; });
        return JSON.stringify(stalledRoute === 'status' ? statusPayload() : sidebarPayload());
      },
    };
    const responses = [
      stalledRoute === 'status' ? blockedResponse : jsonResponse(statusPayload()),
      stalledRoute === 'sidebar' ? blockedResponse : jsonResponse(sidebarPayload()),
      jsonResponse(statusPayload()), jsonResponse(sidebarPayload()),
    ];
    const page = createPage(responses);
    const observation = observeProductionAppLiveness(page, {
      sampleCount: 2, intervalMs: 0, requestTimeoutMs: 20,
    });
    let watchdog;
    try {
      const outcome = await Promise.race([
        observation.then(() => ({ kind: 'passed' }), (error) => ({ kind: 'failed', error })),
        new Promise((resolve) => { watchdog = setTimeout(() => resolve({ kind: 'unbounded' }), 100); }),
      ]);
      assert.equal(outcome.kind, 'failed', 'a stalled body must fail within the request deadline');
      assert.match(outcome.error.message, /liveness.*(?:deadline|timed out|exceeded)/i);
      assert.deepEqual(page.calls.at(-1), ['close'], 'deadline failure must close its owned probe page');
    } finally {
      clearTimeout(watchdog);
      releaseBody?.();
      await observation.catch(() => {});
    }
  });
}
test('production liveness deadline rejects late body completion before timer dispatch', async () => {
  const { observeProductionAppLiveness } = await import(helperUrl);
  const originalNow = Date.now;
  let now = 0;
  const page = createPage([
    { ok: () => true, async text() { now = 25; return JSON.stringify(statusPayload()); } },
    jsonResponse(sidebarPayload()), jsonResponse(statusPayload()), jsonResponse(sidebarPayload()),
  ]);
  Date.now = () => now;
  try {
    await assert.rejects(observeProductionAppLiveness(page, {
      sampleCount: 2, intervalMs: 0, requestTimeoutMs: 20,
    }), /liveness.*deadline/i);
  } finally {
    Date.now = originalNow;
  }
});
