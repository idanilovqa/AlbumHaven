const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXPECTED = Object.freeze({
  nodeMajor: 22,
  python: '3.11',
  componentChrome: '151.0.7922.138',
  windowsChrome: '151.0.7922.138',
  postgresMajor: 17,
  imageioFfmpeg: '0.6.0',
  ffmpeg: '7.1-essentials_build-www.gyan.dev',
});

function run(executable, args, options = {}) {
  return String((options.execFileSyncFn || execFileSync)(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: options.env || process.env,
  })).trim();
}

function assertVersion(label, actual, expected) {
  if (actual !== expected) throw new Error(`${label} version mismatch: expected ${expected}, got ${actual}`);
}

function collectVersions(profile, options = {}) {
  const env = options.env || process.env;
  const expectedPostgresMajor = options.expectedPostgresMajor ?? EXPECTED.postgresMajor;
  if (![17, 18].includes(expectedPostgresMajor)) {
    throw new Error(`unsupported PostgreSQL major: ${expectedPostgresMajor}`);
  }
  const chromePath = String(env.PLAYWRIGHT_CHROME_EXECUTABLE || '').trim();
  if (!chromePath || !fs.statSync(chromePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('PLAYWRIGHT_CHROME_EXECUTABLE must identify the pinned Chrome executable');
  }
  const nodeVersion = run(process.execPath, ['--version'], options).replace(/^v/, '');
  if (Number(nodeVersion.split('.')[0]) !== EXPECTED.nodeMajor) {
    throw new Error(`Node.js major mismatch: expected ${EXPECTED.nodeMajor}, got ${nodeVersion}`);
  }
  const chromeVersion = process.platform === 'win32'
    ? run('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${chromePath.replaceAll("'", "''")}').VersionInfo.ProductVersion`], options)
    : run(chromePath, ['--version'], options).replace(/^Google Chrome(?: for Testing)?\s+/i, '');
  assertVersion('Chrome', chromeVersion, profile === 'component' ? EXPECTED.componentChrome : EXPECTED.windowsChrome);

  const manifest = { schemaVersion: 1, profile, node: nodeVersion, chrome: chromeVersion, chromePath };
  if (profile === 'component') return manifest;
  if (profile !== 'windows') throw new Error(`unsupported foundation manifest profile: ${profile}`);

  const python = String(env.PLAYWRIGHT_PYTHON || env.pythonLocation && path.join(env.pythonLocation, 'python.exe') || 'python');
  const pythonVersion = run(python, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], options);
  assertVersion('Python', pythonVersion, EXPECTED.python);
  const psql = path.join(String(env.PGBIN || ''), process.platform === 'win32' ? 'psql.exe' : 'psql');
  const postgresVersion = run(psql, ['--version'], options);
  const postgresMatch = /PostgreSQL\)\s+(\d+)/i.exec(postgresVersion);
  if (Number(postgresMatch?.[1]) !== expectedPostgresMajor) {
    throw new Error(`PostgreSQL client major mismatch: expected ${expectedPostgresMajor}, got ${postgresVersion}`);
  }
  const databaseUrl = String(env.DATABASE_APP_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_APP_URL is required for PostgreSQL server verification');
  const serverVersion = run(psql, ['-w', '-At', '-d', databaseUrl, '-c', 'show server_version_num'], options);
  if (Math.floor(Number(serverVersion) / 10000) !== expectedPostgresMajor) {
    throw new Error(`PostgreSQL server major mismatch: expected ${expectedPostgresMajor}, got ${serverVersion}`);
  }
  const ffmpeg = JSON.parse(run(python, ['-c', [
    'import imageio_ffmpeg, json, pathlib',
    'print(json.dumps({"package": imageio_ffmpeg.__version__, "version": imageio_ffmpeg.get_ffmpeg_version(), "executable": imageio_ffmpeg.get_ffmpeg_exe(), "root": str(pathlib.Path(imageio_ffmpeg.__file__).resolve().parent)}))',
  ].join('; ')], options));
  const workflowFfmpegContract = String(
    env.ALBUM_HAVEN_EXPECTED_FFMPEG_VERSION || EXPECTED.ffmpeg,
  ).trim();
  assertVersion('workflow FFmpeg contract', workflowFfmpegContract, EXPECTED.ffmpeg);
  assertVersion('imageio-ffmpeg', ffmpeg.package, EXPECTED.imageioFfmpeg);
  assertVersion('bundled FFmpeg', ffmpeg.version, workflowFfmpegContract);
  const relativeFfmpegPath = path.relative(path.resolve(ffmpeg.root), path.resolve(ffmpeg.executable));
  if (!relativeFfmpegPath || relativeFfmpegPath.startsWith('..') || path.isAbsolute(relativeFfmpegPath)) {
    throw new Error('FFmpeg executable must be owned by the imageio_ffmpeg package');
  }
  return {
    ...manifest,
    python: pythonVersion,
    postgresClient: postgresVersion,
    postgresServerVersionNumber: Number(serverVersion),
    imageioFfmpeg: ffmpeg.package,
    ffmpeg: ffmpeg.version,
    ffmpegExecutable: ffmpeg.executable,
  };
}

module.exports = { EXPECTED, collectVersions };

if (require.main === module) {
  try {
    const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));
    const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
    const postgresMajorArg = process.argv.find((arg) => arg.startsWith('--postgres-major='));
    if (!profileArg || !outputArg) throw new Error('--profile and --output are required');
    const outputPath = path.resolve(outputArg.slice('--output='.length));
    const expectedPostgresMajor = postgresMajorArg
      ? Number(postgresMajorArg.slice('--postgres-major='.length))
      : EXPECTED.postgresMajor;
    const manifest = collectVersions(profileArg.slice('--profile='.length), { expectedPostgresMajor });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    process.stdout.write(`${outputPath}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
