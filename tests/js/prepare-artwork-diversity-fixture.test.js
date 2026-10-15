const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');

const execFileAsync = promisify(execFile);
const helperPath = path.resolve(
  __dirname,
  '..',
  '..',
  'scripts',
  'ci',
  'prepare-artwork-diversity-fixture.ps1',
);
const powerShell = process.platform === 'win32'
  ? path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  : 'pwsh';
const python = process.env.ALBUM_HAVEN_TEST_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');
const expectedRelease = 'fixtures-v1.0.25-test';
const variantCount = 512;
const sourceMaxEdge = 960;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function writeStubGenerator(checkout) {
  const generators = path.join(checkout, 'generators');
  fs.mkdirSync(generators, { recursive: true });
  fs.writeFileSync(path.join(generators, '__init__.py'), '', 'utf8');
  fs.writeFileSync(path.join(generators, 'artwork_diversity.py'), String.raw`
import argparse
import hashlib
import json
import os
import pathlib
import zipfile

PROFILE = "synthetic-large-library"

def sha256_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def sha256_tree(root):
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8") + b"\0")
        digest.update(bytes.fromhex(sha256_file(path)))
    return digest.hexdigest()

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=pathlib.Path, required=True)
parser.add_argument("--destination", type=pathlib.Path, required=True)
parser.add_argument("--variant-count", type=int, required=True)
parser.add_argument("--source-max-edge", type=int, required=True)
args = parser.parse_args()

if args.variant_count != 512 or args.source_max_edge != 960:
    raise SystemExit("unexpected generator contract")
if args.destination.exists():
    raise SystemExit("destination must not exist before generator invocation")

mode = os.environ.get("ARTWORK_DIVERSITY_STUB_MODE", "success")
args.destination.mkdir(parents=True)
seed_relative = pathlib.Path("database/synthetic-large-library.ndjson.zst")
seed_path = args.destination / seed_relative
seed_path.parent.mkdir(parents=True)
seed_path.write_bytes(b"deterministic seed\n")

variants = []
for index in range(args.variant_count):
    relative = pathlib.Path(f"media/covers/diagnostic/variant-{index:04d}.jpg")
    target = args.destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(f"variant-{index}".encode("ascii"))
    pixel_key = 0 if mode == "duplicate-pixels" else index
    projection_key = 0 if mode == "duplicate-projections" else index
    variants.append({
        "path": relative.as_posix(),
        "dimensions": [960, 640],
        "format": "JPEG",
        "bytes": target.stat().st_size,
        "reference": "media/covers/reference.jpg",
        "referenceBytes": 1,
        "pixelSha256": hashlib.sha256(f"pixel-{pixel_key}".encode()).hexdigest(),
        "thumbnail480PixelSha256": hashlib.sha256(f"projection-{projection_key}".encode()).hexdigest(),
    })

logical_hash = sha256_tree(args.destination)
archive_name = "synthetic-large-library.zip"
archive_path = args.destination.parent / archive_name
with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for source in sorted(item for item in args.destination.rglob("*") if item.is_file()):
        archive.write(source, source.relative_to(args.destination).as_posix())

archive_hash = sha256_file(archive_path)
release = "fixtures-v1.0.25-test-distinct-artwork-diagnostic"
if mode == "wrong-release":
    release = "fixtures-v1.0.25-test"
manifest = {
    "manifestVersion": 1,
    "release": release,
    "generatorCommit": "base-generator-identity",
    "profiles": {
        PROFILE: {
            "archive": archive_name,
            "sha256": archive_hash,
            "databaseSeed": seed_relative.as_posix(),
            "logicalSha256": "0" * 64 if mode == "corrupt-tree" else logical_hash,
            "mediaRoot": "media",
            "counts": {"covers": 512},
            "namedScenarioAssertions": {
                "artworkDiversity": {
                    "uniquePixelCount": args.variant_count,
                    "sourceMaxEdge": args.source_max_edge,
                    "thumbnailProjection": "decoded RGB resized within 480px using LANCZOS; not production route bytes",
                    "variants": variants,
                }
            },
        }
    },
}
(args.destination / "manifest.json").write_text(
    json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)

if mode == "corrupt-seed":
    with seed_path.open("ab") as handle:
        handle.write(b"corruption")
elif mode == "corrupt-archive":
    with archive_path.open("ab") as handle:
        handle.write(b"corruption")
`, 'utf8');
}

function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-artwork-prepare-'));
  const baseFixtureRoot = path.join(root, 'base-fixture');
  const generatorCheckout = path.join(root, 'album-haven-test-data');
  fs.mkdirSync(baseFixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(baseFixtureRoot, 'manifest.json'), `${JSON.stringify({
    manifestVersion: 1,
    release: expectedRelease,
    profiles: {
      'synthetic-large-library': {
        archive: 'synthetic-large-library.zip',
      },
    },
  })}\n`, 'utf8');
  fs.mkdirSync(generatorCheckout, { recursive: true });
  writeStubGenerator(generatorCheckout);
  runGit(generatorCheckout, ['init', '--quiet']);
  runGit(generatorCheckout, ['-c', 'core.autocrlf=false', 'add', '--', 'generators']);
  runGit(generatorCheckout, [
    '-c',
    'user.name=Album Haven Tests',
    '-c',
    'user.email=tests@album-haven.invalid',
    'commit',
    '--quiet',
    '-m',
    'test generator',
  ]);
  return {
    root,
    baseFixtureRoot,
    baseManifestSha256: sha256File(path.join(baseFixtureRoot, 'manifest.json')),
    generatorCheckout,
    generatorCommit: runGit(generatorCheckout, ['rev-parse', 'HEAD']),
  };
}

async function runPrepare(harness, options = {}) {
  const scenarioRoot = fs.mkdtempSync(path.join(harness.root, 'scenario-'));
  const destination = options.destination || path.join(scenarioRoot, 'derived-fixture');
  const provenancePath = options.provenancePath
    || (options.provenanceInDestination
      ? path.join(destination, 'artwork-diversity-provenance.json')
      : path.join(scenarioRoot, 'artwork-diversity-provenance.json'));
  if (options.prepopulateDestination) {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'owner-data.txt'), 'must remain', 'utf8');
  }
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    helperPath,
    '-BaseFixtureRoot',
    harness.baseFixtureRoot,
    '-GeneratorCheckout',
    harness.generatorCheckout,
    '-Destination',
    destination,
    '-ProvenancePath',
    provenancePath,
    '-ExpectedRelease',
    expectedRelease,
    '-BaseManifestSha256',
    options.baseManifestSha256 || harness.baseManifestSha256,
    '-GeneratorCommit',
    options.generatorCommit || harness.generatorCommit,
    '-VariantCount',
    String(variantCount),
    '-SourceMaxEdge',
    String(sourceMaxEdge),
    '-PythonPath',
    python,
  ];
  try {
    const result = await execFileAsync(powerShell, args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        ARTWORK_DIVERSITY_STUB_MODE: options.mode || 'success',
      },
      timeout: 60000,
      windowsHide: true,
    });
    return { ...result, destination, provenancePath };
  } catch (error) {
    error.destination = destination;
    error.provenancePath = provenancePath;
    throw error;
  }
}

async function expectPrepareFailure(harness, options, pattern) {
  let failure;
  try {
    await runPrepare(harness, options);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'fixture preparation should fail');
  assert.match(`${failure.stdout || ''}\n${failure.stderr || ''}`, pattern);
  assert.equal(
    fs.existsSync(failure.provenancePath),
    false,
    'failed preparation must not publish provenance',
  );
  return failure;
}

test('artwork-diversity preparation rejects trust and integrity failures without provenance', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const wrongHead = await expectPrepareFailure(
    harness,
    { generatorCommit: '0'.repeat(40) },
    /generator checkout HEAD/i,
  );
  assert.equal(fs.existsSync(wrongHead.destination), false, 'wrong HEAD must fail before generation');
  await expectPrepareFailure(
    harness,
    { destination: harness.baseFixtureRoot },
    /unsafe destination/i,
  );
  await expectPrepareFailure(
    harness,
    { destination: path.join(harness.generatorCheckout, 'derived-fixture') },
    /unsafe destination/i,
  );
  await expectPrepareFailure(
    harness,
    { provenancePath: path.join(harness.baseFixtureRoot, 'provenance.json') },
    /unsafe provenance/i,
  );
  await expectPrepareFailure(
    harness,
    { provenancePath: path.join(harness.generatorCheckout, 'provenance.json') },
    /unsafe provenance/i,
  );
  await expectPrepareFailure(
    harness,
    { provenanceInDestination: true },
    /unsafe provenance/i,
  );
  const nonEmpty = await expectPrepareFailure(
    harness,
    { prepopulateDestination: true },
    /empty/i,
  );
  assert.equal(
    fs.readFileSync(path.join(nonEmpty.destination, 'owner-data.txt'), 'utf8'),
    'must remain',
    'unsafe cleanup must not touch a non-empty destination',
  );
  const wrongBase = await expectPrepareFailure(
    harness,
    { baseManifestSha256: 'f'.repeat(64) },
    /base manifest SHA-256/i,
  );
  assert.equal(fs.existsSync(wrongBase.destination), false, 'wrong base hash must fail before generation');
  await expectPrepareFailure(
    harness,
    { mode: 'wrong-release' },
    /derived release/i,
  );
  await expectPrepareFailure(
    harness,
    { mode: 'duplicate-pixels' },
    /distinct decoded/i,
  );
  await expectPrepareFailure(
    harness,
    { mode: 'duplicate-projections' },
    /480-pixel/i,
  );
  await expectPrepareFailure(
    harness,
    { mode: 'corrupt-seed' },
    /database seed/i,
  );
  await expectPrepareFailure(
    harness,
    { mode: 'corrupt-archive' },
    /archive/i,
  );
  await expectPrepareFailure(
    harness,
    { mode: 'corrupt-tree' },
    /logical tree/i,
  );
});

test('artwork-diversity preparation rejects modified tracked generator files', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  fs.appendFileSync(
    path.join(harness.generatorCheckout, 'generators', 'artwork_diversity.py'),
    '\n# local modification\n',
    'utf8',
  );

  const failure = await expectPrepareFailure(harness, {}, /generator checkout.*clean/i);
  assert.equal(fs.existsSync(failure.destination), false, 'dirty checkout must fail before generation');
});

test('artwork-diversity preparation rejects untracked generator files', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(harness.generatorCheckout, 'generators', 'untracked_generator_input.py'),
    'LOCAL_INPUT = True\n',
    'utf8',
  );

  const failure = await expectPrepareFailure(harness, {}, /generator checkout.*clean/i);
  assert.equal(fs.existsSync(failure.destination), false, 'dirty checkout must fail before generation');
});

test('artwork-diversity preparation rejects ignored executable generator files', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const excludesPath = path.join(harness.root, 'generator-excludes');
  fs.writeFileSync(excludesPath, 'sitecustomize.py\n', 'utf8');
  runGit(harness.generatorCheckout, ['config', 'core.excludesFile', excludesPath]);
  fs.writeFileSync(
    path.join(harness.generatorCheckout, 'sitecustomize.py'),
    'IGNORED_EXECUTABLE_INPUT = True\n',
    'utf8',
  );

  const failure = await expectPrepareFailure(harness, {}, /generator checkout.*clean/i);
  assert.equal(fs.existsSync(failure.destination), false, 'ignored input must fail before generation');
});

test('artwork-diversity preparation publishes validated provenance atomically', async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const result = await runPrepare(harness);
  assert.equal(fs.existsSync(result.destination), true);
  assert.equal(fs.existsSync(result.provenancePath), true);
  const provenance = JSON.parse(fs.readFileSync(result.provenancePath, 'utf8'));
  const manifestPath = path.join(result.destination, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const profile = manifest.profiles['synthetic-large-library'];
  const variants = profile.namedScenarioAssertions.artworkDiversity.variants;

  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.profile, 'synthetic-large-library');
  assert.equal(provenance.base.release, expectedRelease);
  assert.equal(provenance.base.manifestSha256, harness.baseManifestSha256);
  assert.equal(provenance.generator.commit, harness.generatorCommit);
  assert.equal(provenance.derivative.release, `${expectedRelease}-distinct-artwork-diagnostic`);
  assert.equal(provenance.derivative.manifestSha256, sha256File(manifestPath));
  assert.equal(provenance.derivative.logicalSha256, profile.logicalSha256);
  assert.equal(provenance.derivative.archive.sha256, profile.sha256);
  assert.equal(provenance.derivative.databaseSeed.path, profile.databaseSeed);
  assert.equal(provenance.diversity.variantCount, variantCount);
  assert.equal(provenance.diversity.sourceMaxEdge, sourceMaxEdge);
  assert.equal(provenance.diversity.distinctDecodedPixelHashes, variantCount);
  assert.equal(provenance.diversity.distinctThumbnail480PixelHashes, variantCount);
  assert.equal(variants.length, variantCount);
  assert.equal(new Set(variants.map((variant) => variant.pixelSha256)).size, variantCount);
  assert.equal(
    new Set(variants.map((variant) => variant.thumbnail480PixelSha256)).size,
    variantCount,
  );
  assert.equal(
    fs.readdirSync(path.dirname(result.provenancePath))
      .some((entry) => entry.includes('.tmp-')),
    false,
    'atomic provenance temporary file must not remain',
  );
});
