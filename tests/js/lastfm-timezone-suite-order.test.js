const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('Last.fm timezone persistence has an independent fresh-app configuration', () => {
  const config = read('playwright.config.js');
  const lastfmConfig = read('playwright.lastfm-auto-timezone.config.js');
  const scenario = read('tests/e2e/specs/lastfmAutoTimezone.spec.js');
  const lastfmProductionPath = read('tests/e2e/specs/lastfmProductionPath.spec.js');
  const functionalIgnoreSource = config.match(
    /name: 'functional'[\s\S]*?testIgnore:\s*\/((?:\\.|[^/\r\n])+)\//,
  )?.[1];

  assert.ok(functionalIgnoreSource, 'functional project defines testIgnore');
  const functionalIgnore = new RegExp(functionalIgnoreSource);
  assert.equal(functionalIgnore.test('lastfmAutoTimezone.spec.js'), true);
  assert.equal(functionalIgnore.test('playerReloadAutoplayAllowed.spec.js'), true);
  assert.match(lastfmConfig, /name: 'lastfm-auto-timezone'/);
  assert.match(lastfmConfig, /testMatch: \/lastfmAutoTimezone\\\.spec\\\.js\$\//);
  assert.doesNotMatch(config, /\bdependencies\s*:/);
  assert.doesNotMatch(lastfmConfig, /\bdependencies\s*:/);
  assert.match(
    read('scripts/run-functional-playwright.cjs'),
    /playwright\.lastfm-auto-timezone\.config\.js[\s\S]*ALBUM_HAVEN_E2E_LASTFM_TIMEZONE_MODE: 'blank'/,
  );
  assert.match(scenario, /FTC-PLAYBACK-LASTFM-015/);
  assert.match(
    scenario,
    /readLastfmTimeZoneSaveRequests\(\)\)\.toEqual\(\[\{[\s\S]*saveTimezoneOnly: true[\s\S]*readLastfmTimeZoneSaveRequests\(\)\)\.toEqual\(\[\{/,
  );
  assert.doesNotMatch(lastfmProductionPath, /FTC-PLAYBACK-LASTFM-015/);
});
