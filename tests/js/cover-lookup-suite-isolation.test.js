const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    /const isolatedFunctionalTitles = \/FTC-COVERS-011\|FTC-NON-ALBUM-013 keeps a strongly inferred blank-Album track in Other and Album Details\$\//,
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
  assert.match(method, /range\.getClientRects\(\)/);
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
  assert.match(method, /lastTextNode/);
  assert.match(method, /lastCharacterRange\.setStart\(lastTextNode, lastTextEnd - 1\)/);
  assert.match(method, /lastCharacterRange\.setEnd\(lastTextNode, lastTextEnd\)/);
  assert.match(method, /endRect\.left \+ \(endRect\.right - endRect\.left\) \* 0\.75/);
  assert.doesNotMatch(method, /endRect\.right - 2/);
});
