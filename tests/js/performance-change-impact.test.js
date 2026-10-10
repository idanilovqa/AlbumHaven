const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const contract = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'tests', 'ci', 'performance-change-impact.json'),
  'utf8',
));
const targetContract = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'tests', 'ci', 'performance-targets.json'),
  'utf8',
));
const {
  applyPerformanceChangeImpact,
  resolveRequiredPerformanceTargets,
  validatePerformanceChangeImpact,
} = require('../../scripts/ci/performance-change-impact.cjs');

const knownTargets = targetContract.targets.map(({ name }) => name);

test('PR classifier applies changed-path performance ownership before selecting shards', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'ci', 'classify-pr-review-scope.cjs'),
    'utf8',
  );
  assert.match(source, /applyPerformanceChangeImpact\(pipeline, changedPaths/);
  assert.ok(
    source.indexOf('applyPerformanceChangeImpact(pipeline, changedPaths')
      < source.indexOf('const performanceShards ='),
    'changed-path performance targets must be applied before shard selection',
  );
});

test('sensitive browse, sidebar, modal, status, and mobile changes select their focused targets', () => {
  const cases = [
    ['music_app/services/library_browse_postgres.py', ['all-artists', 'selected-artist', 'root-album-browse', 'app-open-all-artists']],
    ['music_app/static/js/runtime/virtual-artist-grid.js', ['all-artists', 'selected-artist', 'app-open-all-artists']],
    ['music_app/static/js/runtime/bootstrap-init.js', ['all-artists', 'selected-artist', 'root-album-browse', 'app-open-all-artists']],
    ['music_app/static/js/runtime/track-modal-lightbox-helpers.js', ['selected-artist', 'all-artists', 'gapless-playback']],
    ['music_app/static/js/runtime/status-ui-helpers.js', ['idle-memory', 'selected-artist']],
    ['music_app/static/css/mobile-layout.css', ['selected-artist', 'all-artists']],
    ['music_app/static/js/runtime/discovery-center-navigation.js', ['search-browse', 'all-artists', 'app-open-all-artists']],
  ];
  for (const [changedPath, expectedTargets] of cases) {
    assert.deepEqual(resolveRequiredPerformanceTargets(contract, [changedPath]), expectedTargets, changedPath);
  }
});

test('multiple sensitive changes deduplicate required targets in reviewed contract order', () => {
  assert.deepEqual(resolveRequiredPerformanceTargets(contract, [
    'music_app/static/js/runtime/status-ui-helpers.js',
    'music_app/static/js/runtime/notification-ui-helpers.js',
    'music_app/static/js/runtime/tag-editor-and-optimistic-updates.js',
  ]), ['idle-memory', 'selected-artist']);
});

test('focused CI automatically includes required performance targets and shards', () => {
  const result = applyPerformanceChangeImpact({
    pipelineMode: 'focused-e2e',
    focusedPerformanceTargets: ['scan-cached'],
    focusedPerformanceShards: ['scan-library'],
  }, ['music_app/static/js/runtime/virtual-artist-grid.js'], contract);
  assert.deepEqual(result.focusedPerformanceTargets, [
    'scan-cached', 'all-artists', 'selected-artist', 'app-open-all-artists',
  ]);
  assert.deepEqual(result.focusedPerformanceShards, ['synthetic-large-library', 'scan-library']);
});

test('full CI keeps its complete target selection unchanged', () => {
  const pipeline = {
    pipelineMode: 'full',
    focusedPerformanceTargets: [],
    focusedPerformanceShards: [],
  };
  assert.deepEqual(
    applyPerformanceChangeImpact(pipeline, ['music_app/static/js/runtime/status-ui-helpers.js'], contract),
    pipeline,
  );
});

test('change-impact contract rejects unknown targets, invalid patterns, and uncovered sensitive paths', () => {
  assert.deepEqual(validatePerformanceChangeImpact(contract, knownTargets), []);
  assert.match(validatePerformanceChangeImpact({
    ...contract,
    rules: [{ paths: ['music_app/**'], targets: ['missing-target'] }],
  }, knownTargets).join('\n'), /unknown performance target missing-target/);
  assert.match(validatePerformanceChangeImpact({
    ...contract,
    rules: [{ paths: ['../outside/**'], targets: ['selected-artist'] }],
  }, knownTargets).join('\n'), /invalid repository path pattern/);
  assert.match(validatePerformanceChangeImpact({
    ...contract,
    requiredPaths: [...contract.requiredPaths, 'music_app/static/js/runtime/unowned-sensitive.js'],
  }, knownTargets).join('\n'), /has no performance target mapping/);
});
