const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..', '..');
const fixtureDataUrl = pathToFileURL(path.join(
  repoRoot,
  'tests',
  'e2e',
  'helpers',
  'coverLookupFixtureData.js',
)).href;

test('provider artwork resolves the released contract identity by exact bytes, not legacy asset ID', async (t) => {
  const { resolveProviderFixtureCover, findFixtureCoverBySubtitle } = await import(fixtureDataUrl);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'media'));
  fs.mkdirSync(path.join(root, 'loopback'));
  const bytes = Buffer.from('fixture-owned image bytes');
  fs.writeFileSync(path.join(root, 'media', 'cover.jpg'), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const approved = { assetId: 'approved-cover-01', sha256 };
  const contractPath = path.join(root, 'loopback', 'cover-responses.json');
  const spec = {
    cover_id: 'release-cover-01', artist: 'Released Artist', album: 'Released Album',
    year: 2009, width: 7500, height: 7500, staged_path: 'media/cover.jpg',
  };
  const environment = {
    ALBUM_HAVEN_FIXTURE_PROFILE: 'functional-core',
    ALBUM_HAVEN_FIXTURE_ROOT: root,
    ALBUM_HAVEN_MEDIA_ROOT: path.join(root, 'media'),
  };
  const writeContract = (covers, schemaVersion = 1) => fs.writeFileSync(
    contractPath, JSON.stringify({ schemaVersion, covers }),
  );
  writeContract([spec]);
  assert.deepEqual(resolveProviderFixtureCover(approved, environment), {
    ...spec, assetId: 'release-cover-01', sha256,
  });
  assert.equal(resolveProviderFixtureCover(approved, {}), approved);
  assert.equal(findFixtureCoverBySubtitle('Synthetic Cover Artist - Canonical Cover Fixture - 2026', {})
    .assetId, 'approved-cover-01');
  assert.throws(() => resolveProviderFixtureCover({ ...approved, sha256: '' }, environment), /exact SHA-256/);
  assert.throws(() => resolveProviderFixtureCover({ ...approved, sha256: '0'.repeat(64) }, environment),
    /exactly one released provider asset/);
  writeContract([spec, { ...spec, cover_id: 'duplicate' }]);
  assert.throws(() => resolveProviderFixtureCover(approved, environment), /exactly one released provider asset/);
  for (const staged_path of ['../outside.jpg', '/outside.jpg', 'C:\\outside.jpg']) {
    writeContract([{ ...spec, staged_path }]);
    assert.throws(() => resolveProviderFixtureCover(approved, environment), /unsafe artwork path/);
  }
  writeContract([spec], 2);
  assert.throws(() => resolveProviderFixtureCover(approved, environment), /schema version 1/);
  writeContract([{ ...spec, width: 0 }]);
  assert.throws(() => resolveProviderFixtureCover(approved, environment), /invalid artwork descriptor/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-contract-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'cover.jpg'), bytes);
  fs.symlinkSync(outside, path.join(root, 'linked-outside'), 'junction');
  writeContract([{ ...spec, staged_path: 'linked-outside/cover.jpg' }]);
  assert.throws(() => resolveProviderFixtureCover(approved, environment), /unsafe artwork path/);
});

test('cover lookup scenarios own distinct mutable album identities', async () => {
  const { COVER_LOOKUP_TEST_TARGETS } = await import(fixtureDataUrl);
  const mutableTargets = [
    COVER_LOOKUP_TEST_TARGETS.cancelClear,
    COVER_LOOKUP_TEST_TARGETS.notificationActioned,
    COVER_LOOKUP_TEST_TARGETS.notificationFailed,
    COVER_LOOKUP_TEST_TARGETS.notificationActive,
    COVER_LOOKUP_TEST_TARGETS.notificationNoResult,
    COVER_LOOKUP_TEST_TARGETS.partialSave,
    COVER_LOOKUP_TEST_TARGETS.canonicalPersistence,
  ];
  const identities = mutableTargets.map(
    ({ artist, album, year }) => `${artist}\u0000${album}\u0000${year}`,
  );

  assert.equal(new Set(identities).size, identities.length);
});

test('FTC-COVERS-013 reaches the held provider without a sufficient manual result', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests', 'e2e', 'specs', 'coverLookup.spec.js'),
    'utf8',
  );
  const scenario = source.split("test('FTC-COVERS-013", 2)[1]
    .split("test('FTC-COVERS-011", 1)[0];
  const startStep = scenario.split(
    "stepLogger.substep('Start the lookup and observe the first partial candidate before completion'",
    2,
  )[1].split("stepLogger.substep('Prove the task remains active", 1)[0];

  assert.doesNotMatch(startStep, /enterManualUrls/);
  assert.match(startStep, /startSearch\(\)/);
  assert.match(startStep, /waitForLaterProviderFixtureBlocked\(\)/);
  assert.match(startStep, /waitForPartialRemoteCandidates\(\)/);
  assert.match(scenario, /subsectionTitles\)\.not\.toContain\('MANUAL LINKS'\)/);
  assert.match(
    scenario,
    /subsectionTitles\)\.not\.toContain\('MANUAL LINKS - OTHER REMOTE ART'\)/,
  );
  assert.match(scenario, /subsectionTitles\)\.toEqual\(expect\.arrayContaining\(\[\s*'From services'/);
});

test('FTC-COVERS-007 settles its held provider before clearing the active task', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests', 'e2e', 'specs', 'coverLookup.spec.js'),
    'utf8',
  );
  const scenario = source.split(
    "test('FTC-COVERS-007 notification states and bulk clear preserve active work'",
    2,
  )[1]
    .split("test('FTC-COVERS-013", 1)[0];

  assert.match(
    scenario,
    /waitForTaskActive\(activeTaskTitle\)[\s\S]*waitForLaterProviderFixtureBlocked\(\)/,
  );
  assert.match(
    scenario,
    /cancelTask\(activeTaskTitle\)[\s\S]*releaseLaterProviderFixture\(\)[\s\S]*waitForLaterProviderCancellationEvidence\(\)[\s\S]*clearTaskAndExpectImmediateRemoval/,
  );
});

test('functional Playwright scenarios have no success dependencies', () => {
  const config = fs.readFileSync(path.join(repoRoot, 'playwright.config.js'), 'utf8');
  const coverRescanConfig = fs.readFileSync(
    path.join(repoRoot, 'playwright.cover-rescan.config.js'),
    'utf8',
  );
  const functionalIgnoreSource = config.match(
    /name: 'functional'[\s\S]*?testIgnore:\s*\/((?:\\.|[^/\r\n])+)\//,
  )?.[1];

  assert.match(config, /name: 'functional'/);
  assert.doesNotMatch(config, /\bdependencies\s*:/);
  assert.match(
    config,
    /const isolatedFunctionalTitles = \/FTC-COVERS-011\|FTC-NON-ALBUM-013 keeps a strongly inferred blank-Album track in Other and Album Details\//,
  );
  assert.match(config, /grepInvert: isolatedFunctionalTitles/);
  assert.ok(functionalIgnoreSource, 'functional project defines testIgnore');
  const functionalIgnore = new RegExp(functionalIgnoreSource);
  assert.equal(functionalIgnore.test('lastfmAutoTimezone.spec.js'), true);
  assert.equal(functionalIgnore.test('playerReloadAutoplayAllowed.spec.js'), true);
  assert.match(coverRescanConfig, /name: 'cover-rescan'/);
  assert.match(coverRescanConfig, /grep: \/FTC-COVERS-011\//);
  assert.doesNotMatch(coverRescanConfig, /\bdependencies\s*:/);
});

test('notification text selection drags across measured text lines instead of the element midpoint', () => {
  const actions = fs.readFileSync(path.join(
    repoRoot,
    'tests',
    'e2e',
    'actions',
    'coverLookupActions.js',
  ), 'utf8');
  const method = actions
    .split('async dragSelectTaskTitleWithoutOpeningModal', 2)[1]
    .split('async readTaskElapsed', 1)[0];

  assert.match(method, /document\.createRange\(\)/);
  assert.match(method, /firstCharacterRange\.getBoundingClientRect\(\)/);
  assert.match(method, /candidateRange\.getBoundingClientRect\(\)/);
  assert.doesNotMatch(method, /selectNodeContents\(element\)/);
  assert.match(method, /textRects\[0\][\s\S]*textRects\[textRects\.length - 1\]/);
  assert.doesNotMatch(method, /box\.y \+ \(box\.height \/ 2\)/);
});

test('notification text selection ends inside the final text glyph instead of the block boundary', () => {
  const actions = fs.readFileSync(path.join(
    repoRoot,
    'tests',
    'e2e',
    'actions',
    'coverLookupActions.js',
  ), 'utf8');
  const method = actions
    .split('async dragSelectTaskTitleWithoutOpeningModal', 2)[1]
    .split('async readTaskElapsed', 1)[0];

  assert.match(method, /NodeFilter\.SHOW_TEXT/);
  assert.match(method, /candidateRange\.setStart\(textNode, candidateTextEnd - 1\)/);
  assert.match(method, /candidateRange\.setEnd\(textNode, candidateTextEnd\)/);
  assert.match(method, /endRect\.left \+ \(endRect\.right - endRect\.left\) \* 0\.75/);
  assert.doesNotMatch(method, /endRect\.right - 2/);
});
