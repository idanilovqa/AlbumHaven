const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const helperUrl = pathToFileURL(path.resolve(
  __dirname,
  '..',
  'e2e',
  'helpers',
  'startupRelationProjectionReadiness.js',
)).href;

test('startup relation readiness survives Playwright worker replacement', async () => {
  const { readStartupRelationProjectionReadiness } = await import(helperUrl);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-startup-readiness-'));
  const controlDirectory = path.join(tempRoot, 'restart-control');
  fs.mkdirSync(controlDirectory);
  const environment = {
    ALBUM_HAVEN_E2E_TEMP_ROOT: tempRoot,
    ALBUM_HAVEN_E2E_RESTART_CONTROL_DIR: controlDirectory,
  };
  let fetchCalls = 0;

  try {
    const initial = await readStartupRelationProjectionReadiness({
      baseURL: 'http://127.0.0.1:4173',
      environment,
      async fetchFn() {
        fetchCalls += 1;
        return {
          ok: true,
          async json() {
            return {
              relation_projection: {
                ready: true,
                startup_rebuilt: true,
                rebuild_reason: 'missing_projection',
                duration_ms: 1715.48,
              },
            };
          },
        };
      },
    });

    const replacementWorker = await readStartupRelationProjectionReadiness({
      baseURL: 'http://127.0.0.1:4173',
      environment,
      async fetchFn() {
        throw new Error('replacement worker must not query changed app startup state');
      },
    });

    assert.deepEqual(initial, {
      ready: true,
      startupRebuilt: true,
      rebuildReason: 'missing_projection',
      durationMs: 1715.48,
    });
    assert.deepEqual(replacementWorker, initial);
    assert.equal(fetchCalls, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
