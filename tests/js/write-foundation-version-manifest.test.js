const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EXPECTED,
  collectVersions,
} = require('../../scripts/ci/write-foundation-version-manifest.cjs');

function createToolPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-foundation-'));
  const chromePath = path.join(root, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  const ffmpegRoot = path.join(root, 'imageio_ffmpeg');
  const ffmpegPath = path.join(ffmpegRoot, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  fs.mkdirSync(ffmpegRoot);
  fs.writeFileSync(chromePath, 'pinned chrome');
  fs.writeFileSync(ffmpegPath, 'bundled ffmpeg');
  return { root, chromePath, ffmpegRoot, ffmpegPath };
}

function fakeExecutor(tools) {
  return (executable, args) => {
    if (executable === process.execPath) return 'v22.20.0\n';
    if (executable === 'powershell' || executable === tools.chromePath) {
      const chromeVersion = tools.chromeVersion || EXPECTED.windowsChrome;
      return executable === 'powershell'
        ? `${chromeVersion}\n`
        : `Google Chrome for Testing ${chromeVersion}\n`;
    }
    const postgresMajor = tools.postgresMajor || 17;
    if (args.includes('--version')) return `psql (PostgreSQL) ${postgresMajor}.7\n`;
    if (args.includes('show server_version_num')) return `${postgresMajor}0007\n`;
    const script = args.at(-1);
    if (script.includes('sys.version_info')) return '3.11\n';
    if (script.includes('imageio_ffmpeg')) {
      return `${JSON.stringify({
        package: EXPECTED.imageioFfmpeg,
        version: EXPECTED.ffmpeg,
        executable: tools.ffmpegPath,
        root: tools.ffmpegRoot,
      })}\n`;
    }
    throw new Error(`unexpected version probe: ${executable} ${args.join(' ')}`);
  };
}

test('component manifest records and enforces the pinned Node and Chrome versions', (t) => {
  const tools = createToolPaths();
  t.after(() => fs.rmSync(tools.root, { recursive: true, force: true }));

  const manifest = collectVersions('component', {
    env: { PLAYWRIGHT_CHROME_EXECUTABLE: tools.chromePath },
    execFileSyncFn: fakeExecutor({ ...tools, chromeVersion: EXPECTED.componentChrome }),
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.profile, 'component');
  assert.equal(manifest.node, '22.20.0');
  assert.equal(manifest.chrome, EXPECTED.componentChrome);
  assert.equal(manifest.chromePath, tools.chromePath);
  assert.equal('python' in manifest, false);
});

test('Windows manifest verifies the complete pinned CI toolchain and FFmpeg provenance', (t) => {
  const tools = createToolPaths();
  t.after(() => fs.rmSync(tools.root, { recursive: true, force: true }));

  const manifest = collectVersions('windows', {
    env: {
      PLAYWRIGHT_CHROME_EXECUTABLE: tools.chromePath,
      PLAYWRIGHT_PYTHON: 'python-for-tests',
      PGBIN: path.join(tools.root, 'postgres-bin'),
      DATABASE_APP_URL: 'postgresql://ci.invalid/app',
    },
    execFileSyncFn: fakeExecutor(tools),
  });

  assert.equal(manifest.chrome, EXPECTED.windowsChrome);
  assert.equal(manifest.python, EXPECTED.python);
  assert.match(manifest.postgresClient, /^psql \(PostgreSQL\) 17\./);
  assert.equal(manifest.postgresServerVersionNumber, 170007);
  assert.equal(manifest.imageioFfmpeg, EXPECTED.imageioFfmpeg);
  assert.equal(manifest.ffmpeg, EXPECTED.ffmpeg);
  assert.equal(manifest.ffmpegExecutable, tools.ffmpegPath);
});

test('Windows manifest validates the caller-selected local PostgreSQL major', (t) => {
  const tools = createToolPaths();
  t.after(() => fs.rmSync(tools.root, { recursive: true, force: true }));

  const manifest = collectVersions('windows', {
    expectedPostgresMajor: 18,
    env: {
      PLAYWRIGHT_CHROME_EXECUTABLE: tools.chromePath,
      PLAYWRIGHT_PYTHON: 'python-for-tests',
      PGBIN: path.join(tools.root, 'postgres-bin'),
      DATABASE_APP_URL: 'postgresql://local.invalid/app',
    },
    execFileSyncFn: fakeExecutor({ ...tools, postgresMajor: 18 }),
  });

  assert.match(manifest.postgresClient, /^psql \(PostgreSQL\) 18\./);
  assert.equal(manifest.postgresServerVersionNumber, 180007);
});

test('Windows manifest rejects a Chrome build outside the exact provisioned contract', (t) => {
  const tools = createToolPaths();
  t.after(() => fs.rmSync(tools.root, { recursive: true, force: true }));

  assert.throws(
    () => collectVersions('windows', {
      env: {
        PLAYWRIGHT_CHROME_EXECUTABLE: tools.chromePath,
        PLAYWRIGHT_PYTHON: 'python-for-tests',
        PGBIN: path.join(tools.root, 'postgres-bin'),
        DATABASE_APP_URL: 'postgresql://ci.invalid/app',
      },
      execFileSyncFn: fakeExecutor({ ...tools, chromeVersion: '151.0.7922.174' }),
    }),
    /Chrome version mismatch/,
  );
});

test('Windows manifest rejects an FFmpeg executable outside the imageio_ffmpeg package', (t) => {
  const tools = createToolPaths();
  t.after(() => fs.rmSync(tools.root, { recursive: true, force: true }));
  const externalFfmpeg = path.join(tools.root, process.platform === 'win32' ? 'external-ffmpeg.exe' : 'external-ffmpeg');
  fs.writeFileSync(externalFfmpeg, 'external ffmpeg');
  const executor = fakeExecutor({ ...tools, ffmpegPath: externalFfmpeg });

  assert.throws(
    () => collectVersions('windows', {
      env: {
        PLAYWRIGHT_CHROME_EXECUTABLE: tools.chromePath,
        PLAYWRIGHT_PYTHON: 'python-for-tests',
        PGBIN: path.join(tools.root, 'postgres-bin'),
        DATABASE_APP_URL: 'postgresql://ci.invalid/app',
      },
      execFileSyncFn: executor,
    }),
    /FFmpeg executable must be owned by the imageio_ffmpeg package/,
  );
});

test('Windows manifest rejects workflow FFmpeg contract drift', (t) => {
  const tools = createToolPaths();
  t.after(() => fs.rmSync(tools.root, { recursive: true, force: true }));

  assert.throws(
    () => collectVersions('windows', {
      env: {
        PLAYWRIGHT_CHROME_EXECUTABLE: tools.chromePath,
        PLAYWRIGHT_PYTHON: 'python-for-tests',
        PGBIN: path.join(tools.root, 'postgres-bin'),
        DATABASE_APP_URL: 'postgresql://ci.invalid/app',
        ALBUM_HAVEN_EXPECTED_FFMPEG_VERSION: '7.2-unapproved',
      },
      execFileSyncFn: fakeExecutor(tools),
    }),
    /workflow FFmpeg contract version mismatch/,
  );
});
