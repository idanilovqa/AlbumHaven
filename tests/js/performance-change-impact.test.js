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
    ['music_app/services/runtime_asset_versions.py', ['app-open-all-artists', 'artist-tree-scroll-navigation', 'utility-problematic-files', 'problematic-files-focused']],
    ['music_app/services/library_browse_postgres.py', ['all-artists', 'selected-artist', 'root-album-browse', 'app-open-all-artists', 'artist-tree-scroll-navigation', 'artist-family', 'search-all-artists', 'search-browse', 'gallery-artwork-diversity', 'utility-problematic-files', 'problematic-files-focused']],
    ['music_app/static/js/runtime/virtual-artist-grid.js', ['all-artists', 'selected-artist', 'app-open-all-artists', 'artist-tree-scroll-navigation', 'gallery-artwork-diversity']],
    ['music_app/static/js/runtime/bootstrap-init.js', ['all-artists', 'selected-artist', 'root-album-browse', 'app-open-all-artists', 'artist-tree-scroll-navigation', 'artist-family', 'search-all-artists', 'search-browse', 'gallery-artwork-diversity']],
    ['music_app/static/js/runtime/track-modal-lightbox-helpers.js', ['selected-artist', 'all-artists', 'gapless-playback']],
    ['music_app/static/js/runtime/status-ui-helpers.js', ['idle-memory', 'selected-artist', 'artist-tree-scroll-navigation']],
    ['music_app/static/css/mobile-layout.css', ['selected-artist', 'all-artists', 'artist-tree-scroll-navigation']],
    ['music_app/static/js/runtime/discovery-center-navigation.js', ['search-browse', 'all-artists', 'app-open-all-artists', 'artist-tree-scroll-navigation']],
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
  ]), ['idle-memory', 'selected-artist', 'artist-tree-scroll-navigation']);
});

test('focused CI automatically includes required performance targets and shards', () => {
  const result = applyPerformanceChangeImpact({
    pipelineMode: 'focused-e2e',
    focusedPerformanceTargets: ['scan-cached'],
    focusedPerformanceShards: ['scan-library'],
  }, ['music_app/static/js/runtime/virtual-artist-grid.js'], contract);
  assert.deepEqual(result.focusedPerformanceTargets, [
    'scan-cached', 'all-artists', 'selected-artist', 'app-open-all-artists', 'artist-tree-scroll-navigation',
    'gallery-artwork-diversity',
  ]);
  assert.deepEqual(result.focusedPerformanceShards, [
    'synthetic-large-library', 'scan-library', 'gallery-artwork-diversity',
  ]);
});

test('gallery virtualization, card retention, and artwork loading owners require NAV-036', () => {
  for (const changedPath of [
    'music_app/static/js/runtime/gallery-main-components.js',
    'music_app/static/js/runtime/gallery-main-state.js',
    'music_app/static/js/runtime/gallery-main-interactions.js',
    'music_app/static/js/runtime/gallery-card-component.js',
    'music_app/static/js/runtime/gallery-cover-preview-cache.js',
    'music_app/static/js/runtime/gallery-cover-load-scheduler.js',
    'music_app/static/js/runtime/render-markup-helpers.js',
    'music_app/static/js/runtime/virtual-artist-grid.js',
    'tests/e2e/syntheticLargeLibrary/longSessionGalleryMemory.spec.js',
    'tests/e2e/poms/galleryPage.js',
    'tests/e2e/helpers/realAppBenchmarkHelpers.js',
  ]) {
    const targets = resolveRequiredPerformanceTargets(contract, [changedPath]);
    assert.ok(targets.includes('gallery-artwork-diversity'), changedPath);
  }
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

test('Problematic Files dependencies require both real-app performance targets', () => {
  const paths = [
    'music_app/services/library_browse_postgres.py',
    'music_app/services/problematic_albums.py',
    'music_app/services/album_local_membership.py',
    'music_app/routes/api_problematic_albums.py',
    'music_app/routes/api_read_asgi_routes.py',
    'music_app/services/scan_state.py',
    'music_app/services/edit_workflows.py',
    'music_app/static/js/runtime/utility-loaders-and-cover-lookup.js',
    'music_app/static/js/runtime/problematic-files-virtual-list.js',
    'music_app/static/js/runtime/problem-exclusion-mutations.js',
    'music_app/static/js/utilities/problematic-tab.js',
    'music_app/static/js/utilities/shell.js',
    'music_app/static/js/runtime/utility-list-builders.js',
    'music_app/static/js/runtime/utility-renderers-and-actions.js',
    'music_app/static/css/runtime/utilities.css',
    'tests/e2e/helpers/utilityPerformanceHelpers.js',
    'tests/e2e/helpers/problematicPayloadEvidence.js',
    'tests/e2e/utilityProblematicFiles/utilityProblematicFiles.spec.js',
  ];
  for (const changedPath of paths) {
    const result = applyPerformanceChangeImpact({
      pipelineMode: 'focused-e2e', focusedPerformanceTargets: [], focusedPerformanceShards: [],
    }, [changedPath], contract);
    for (const target of ['utility-problematic-files', 'problematic-files-focused']) {
      assert.ok(result.focusedPerformanceTargets.includes(target), `${changedPath} must select ${target}`);
    }
    assert.ok(result.focusedPerformanceShards.includes('utility-problematic-files'), changedPath);
  }
});

test('agent guidance requires all PF performance layers without weakening the budget', () => {
  const guidance = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
  const checks = fs.readFileSync(path.join(repoRoot, 'docs/problematic-files-regression-checks.md'), 'utf8');
  for (const target of ['utility-problematic-files', 'problematic-files-focused']) {
    assert.ok(guidance.includes(target));
    assert.ok(checks.includes(`--test ${target}`));
  }
  for (const required of ['test_problematic_physical_files_postgres.py', 'test_api_read_asgi_routes.py',
    'utility-problematic-load-diagnostics.test.js', 'problematicFilesVirtualFocus.spec.js',
    'functional-shards.json']) assert.ok(checks.includes(required), required);
  assert.match(guidance, /1000 ms.*200 ms/);
  assert.match(checks, /skipped test does not satisfy/);
});

test('backend publication and invalidation owners require family and search gates', () => {
  for (const owner of ['scan_cache_persistence.py', 'relation_projection_postgres.py', 'gallery_projection_postgres.py']) {
    const changedPath = `music_app/services/${owner}`;
    assert.ok(contract.requiredPaths.includes(changedPath), `${owner} must remain an explicit performance owner`);
    const targets = resolveRequiredPerformanceTargets(contract, [changedPath]);
    for (const target of ['artist-family', 'search-all-artists', 'search-browse']) {
      assert.ok(targets.includes(target), `${owner} must require ${target}`);
    }
  }
});

test('shared browse changes retain every search gate in focused CI', () => {
  for (const changedPath of [
    'music_app/services/library_browse_postgres.py',
    'music_app/routes/api_read_asgi_routes.py',
    'music_app/routes/web_asgi.py',
    'music_app/services/startup_bootstrap.py',
    'music_app/static/js/runtime/bootstrap-init.js',
    'music_app/static/js/runtime/response-state-helpers.js',
  ]) {
    const result = applyPerformanceChangeImpact({
      pipelineMode: 'focused-e2e',
      focusedPerformanceTargets: [],
      focusedPerformanceShards: [],
    }, [changedPath], contract);
    for (const target of ['artist-family', 'search-all-artists', 'search-browse']) {
      assert.ok(result.focusedPerformanceTargets.includes(target), `${changedPath} must require ${target}`);
    }
    assert.ok(result.focusedPerformanceShards.includes('synthetic-large-library'));
  }
});
