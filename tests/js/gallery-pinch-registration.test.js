const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PERFORMANCE_TARGETS } = require('../../scripts/run-performance-playwright.cjs');

const root = path.resolve(__dirname, '../..');
const target = PERFORMANCE_TARGETS['artist-tree-scroll-navigation'];

test('continuous mobile pinch uses the existing production-calibration navigation target without losing old scenarios', () => {
  assert.equal(target.kind, 'synthetic');
  assert.equal(target.fixtureProfile, 'synthetic-large-library');
  assert.equal(target.specPath, 'tests/e2e/syntheticLargeLibrary');
  assert.equal(target.measurementExpected, false, 'Functional pinch coverage does not invent a millisecond performance budget.');
  assert.equal(target.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE, 'postgres');
  assert.equal(target.env.ALBUM_HAVEN_SYNTHETIC_SCALE_PRESET, 'production-calibration');
  for (const id of ['032', '033', '034', '035', '037']) {
    assert.match(`FTC-GALLERY-NAV-${id} existing case`, new RegExp(target.grep));
  }
  assert.match('mobile continuous gallery pinch on the production-calibration library', new RegExp(target.grep));
  assert.match('mobile continuous gallery pinch on the production-calibration library', new RegExp(target.casePattern));
  for (const view of ['cards', 'covers']) {
    assert.ok(target.casePatterns.includes(`${view}: deep midpoint stays visible during pinch, paged continuation stays usable and returning to the top is complete`));
  }
});

test('both changed runtime owners select the registered pinch navigation gate', () => {
  const impact = JSON.parse(fs.readFileSync(path.join(root, 'tests/ci/performance-change-impact.json'), 'utf8'));
  for (const file of ['music_app/static/js/runtime/mobile-navigation.js', 'music_app/static/js/runtime/virtual-artist-grid.js']) {
    assert.ok(impact.requiredPaths.includes(file));
    assert.ok(impact.rules.some(rule => rule.paths.includes(file) && rule.targets.includes('artist-tree-scroll-navigation')));
  }
});

test('mobile pinch browser scenarios retain native input, mobile emulation, real fixtures and desktop-only isolation', () => {
  const large = fs.readFileSync(path.join(root, 'tests/e2e/syntheticLargeLibrary/mobileGalleryPinch.spec.js'), 'utf8');
  const helper = fs.readFileSync(path.join(root, 'tests/e2e/poms/mobileGalleryPinchPage.js'), 'utf8');
  assert.match(large, /hasTouch: true, isMobile: true/);
  assert.match(large, /layoutPreferenceIsolation\.capture\(\)/);
  assert.match(helper, /Input\.dispatchTouchEvent/);
  assert.match(helper, /touches: 1, trusted: true/);
  assert.doesNotMatch(helper, /dispatch\('touchEnd', points/);
  assert.doesNotMatch(helper, /new TouchEvent|dispatchEvent\(|\.route\(|\.fulfill\(/);
  const mobileConfig = fs.readFileSync(path.join(root, 'playwright.mobile-feedback.config.js'), 'utf8');
  assert.match(mobileConfig, /testDir: '\.\/tests\/e2e\/mobile-feedback'/);
  assert.doesNotMatch(mobileConfig, /testIgnore:[^\n]*galleryPinch/);
});
