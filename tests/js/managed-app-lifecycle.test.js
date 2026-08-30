const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');
const helperUrl = pathToFileURL(
  path.join(repoRoot, 'tests', 'e2e', 'helpers', 'managedAppLifecycle.js'),
).href;

async function loadManagedAppLifecycle() {
  return import(helperUrl);
}

function createValidEnvironment(root, controlDirectory) {
  return {
    PLAYWRIGHT_MANAGED_APP: '1',
    ALBUM_HAVEN_E2E_TEMP_ROOT: root,
    ALBUM_HAVEN_E2E_RESTART_CONTROL_DIR: controlDirectory,
    ALBUM_HAVEN_FAKE_E2E_DATABASE_URL:
      'postgresql://album_haven_app@localhost:5432/album_haven_fake_e2e',
  };
}

function createOwnedDirectories() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-managed-lifecycle-'));
  const controlDirectory = path.join(root, 'restart-control');
  fs.mkdirSync(controlDirectory);
  return { root, controlDirectory };
}

test('createManagedAppLifecycle rejects an unmanaged Playwright process', async () => {
  const { createManagedAppLifecycle } = await loadManagedAppLifecycle();
  const { root, controlDirectory } = createOwnedDirectories();

  try {
    const environment = createValidEnvironment(root, controlDirectory);
    delete environment.PLAYWRIGHT_MANAGED_APP;
    assert.throws(
      () => createManagedAppLifecycle({ environment }),
      /PLAYWRIGHT_MANAGED_APP=1/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createManagedAppLifecycle requires existing runner-owned control directories', async () => {
  const { createManagedAppLifecycle } = await loadManagedAppLifecycle();
  const { root, controlDirectory } = createOwnedDirectories();

  try {
    fs.rmSync(controlDirectory, { recursive: true, force: true });
    assert.throws(
      () => createManagedAppLifecycle({
        environment: createValidEnvironment(root, controlDirectory),
      }),
      /restart control directory.*exist/i,
    );

    const missingRoot = path.join(root, 'missing-root');
    assert.throws(
      () => createManagedAppLifecycle({
        environment: createValidEnvironment(
          missingRoot,
          path.join(missingRoot, 'restart-control'),
        ),
      }),
      /temp root.*exist/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createManagedAppLifecycle rejects a control directory outside its owned root', async () => {
  const { createManagedAppLifecycle } = await loadManagedAppLifecycle();
  const { root } = createOwnedDirectories();
  const outsideControl = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-restart-control-'));

  try {
    assert.throws(
      () => createManagedAppLifecycle({
        environment: createValidEnvironment(root, outsideControl),
      }),
      /control directory.*temp root/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideControl, { recursive: true, force: true });
  }
});

test('createManagedAppLifecycle accepts only an owned isolated E2E database identity', async () => {
  const { createManagedAppLifecycle } = await loadManagedAppLifecycle();
  const { root, controlDirectory } = createOwnedDirectories();

  try {
    const environment = createValidEnvironment(root, controlDirectory);
    environment.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL =
      'postgresql://album_haven_migrator@localhost:5432/album_haven';
    assert.throws(
      () => createManagedAppLifecycle({ environment }),
      /album_haven_fake_e2e.*album_haven_ci_<suffix>/,
    );

    environment.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL =
      'postgresql://album_haven_app_run_1@127.0.0.1:5432/album_haven_ci_run_1';
    assert.doesNotThrow(() => createManagedAppLifecycle({ environment }));

    for (const unsafeUrl of [
      'postgresql://album_haven_migrator@127.0.0.1:5432/album_haven_fake_e2e',
      'postgresql://album_haven_app_other@127.0.0.1:5432/album_haven_ci_run_1',
      'postgresql://album_haven_app_run_1@example.com:5432/album_haven_ci_run_1',
      'postgresql://album_haven_app_run_1@127.0.0.1:5432/album_haven_ci_run_1?host=example.com',
      'postgresql://album_haven_app_run_1:secret@127.0.0.1:5432/album_haven_ci_run_1',
    ]) {
      environment.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL = unsafeUrl;
      assert.throws(
        () => createManagedAppLifecycle({ environment }),
        /owned isolated E2E database identity|exact album_haven_ci_<suffix>/i,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart writes one atomic nonce request and resolves only its ready acknowledgment', async () => {
  const { createManagedAppLifecycle } = await loadManagedAppLifecycle();
  const { root, controlDirectory } = createOwnedDirectories();
  const nonce = 'cover-authority-restart-nonce';
  const requestPath = path.join(controlDirectory, 'restart-request.json');
  const ackPath = path.join(controlDirectory, 'restart-ack.json');
  let sleepCalls = 0;

  try {
    fs.writeFileSync(ackPath, JSON.stringify({ nonce: 'stale-nonce', status: 'ready' }));
    const lifecycle = createManagedAppLifecycle({
      environment: createValidEnvironment(root, controlDirectory),
      createNonce: () => nonce,
      pollIntervalMs: 1,
      timeoutMs: 100,
      async sleep() {
        sleepCalls += 1;
        assert.deepEqual(JSON.parse(fs.readFileSync(requestPath, 'utf8')), { nonce });
        assert.equal(
          fs.readdirSync(controlDirectory).some((entry) => entry.endsWith('.tmp')),
          false,
          'restart request publication must leave no partially published file',
        );
        fs.writeFileSync(
          ackPath,
          JSON.stringify({
            nonce: sleepCalls === 1 ? 'wrong-nonce' : nonce,
            status: 'ready',
          }),
        );
      },
    });

    const acknowledgment = await lifecycle.restart();

    assert.equal(sleepCalls, 2);
    assert.deepEqual(acknowledgment, { nonce, status: 'ready' });
    assert.deepEqual(JSON.parse(fs.readFileSync(requestPath, 'utf8')), { nonce });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart reports a clear timeout when no matching ready acknowledgment arrives', async () => {
  const { createManagedAppLifecycle } = await loadManagedAppLifecycle();
  const { root, controlDirectory } = createOwnedDirectories();
  const nonce = 'cover-authority-timeout-nonce';
  let currentTime = 0;

  try {
    const lifecycle = createManagedAppLifecycle({
      environment: createValidEnvironment(root, controlDirectory),
      createNonce: () => nonce,
      now: () => currentTime,
      pollIntervalMs: 5,
      timeoutMs: 10,
      async sleep(milliseconds) {
        currentTime += milliseconds;
      },
    });

    await assert.rejects(
      lifecycle.restart(),
      /timed out.*restart.*cover-authority-timeout-nonce/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restart promptly throws a matching failed acknowledgment instead of polling to timeout', async () => {
  const { createManagedAppLifecycle } = await loadManagedAppLifecycle();
  const { root, controlDirectory } = createOwnedDirectories();
  const nonce = 'cover-authority-failed-restart-nonce';
  const ackPath = path.join(controlDirectory, 'restart-ack.json');
  let currentTime = 0;
  let sleepCalls = 0;

  try {
    const lifecycle = createManagedAppLifecycle({
      environment: createValidEnvironment(root, controlDirectory),
      createNonce: () => nonce,
      now: () => currentTime,
      pollIntervalMs: 100,
      timeoutMs: 120_000,
      async sleep() {
        sleepCalls += 1;
        currentTime = 120_000;
        fs.writeFileSync(
          ackPath,
          JSON.stringify({
            nonce,
            status: 'failed',
            phase: 'start-replacement',
            error: 'replacement status readiness failed',
          }),
          'utf8',
        );
      },
    });

    await assert.rejects(
      lifecycle.restart(),
      /managed app restart.*failed.*start-replacement.*replacement status readiness failed/i,
    );
    assert.equal(sleepCalls, 1, 'matching failure acknowledgment must stop polling immediately');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
