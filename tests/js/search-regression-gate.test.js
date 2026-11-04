const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');

test('search gate binds all performance targets to the shard string parameter', {
  skip: process.platform !== 'win32',
}, () => {
  const runner = fs.readFileSync(path.join(repositoryRoot, 'scripts/run-search-regressions.ps1'), 'utf8');
  const argument = runner.match(/-Targets\s+([^\r\n`]+)/u)?.[1];
  assert.ok(argument, 'performance target argument must exist');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `function Bind-Targets { [CmdletBinding()] param([string]$Targets) $Targets }; Bind-Targets -Targets ${argument}`,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'artist-family,search-all-artists,search-browse');
});

test('search regression gate keeps the complete required suite in one command', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const runner = fs.readFileSync(
    path.join(repositoryRoot, 'scripts', 'run-search-regressions.ps1'),
    'utf8',
  );

  assert.equal(
    packageJson.scripts['test:search-regressions'],
    'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-search-regressions.ps1',
  );
  assert.match(runner, /test_duplicate_source_attachment_defers_global_index_cache_miss/u);
  assert.match(runner, /or duplicate_absence/u);
  assert.match(runner, /test_gallery_album_capability_projection\.py/u);
  assert.match(runner, /or gallery_summary_projects_request_edit_permission/u);
  assert.match(runner, /search or selected_artist/u);
  assert.match(runner, /test_api_read_asgi_routes\.py/u);
  assert.match(runner, /test_multi_root_duplicates\.py/u);
  assert.match(runner, /test_web_asgi_routes\.py/u);
  assert.match(runner, /gallery-search-clear-continuity\.test\.js/u);
  assert.match(runner, /search-toolbar-query-state\.test\.js/u);
  assert.match(runner, /search-toolbar-anchor-geometry\.test\.js/u);
  assert.match(runner, /search-input-clear\.test\.js/u);
  assert.match(runner, /gallery-tree-selection-performance\.test\.js/u);
  assert.match(runner, /root-gallery-pagination\.test\.js/u);
  assert.match(runner, /gallery-refresh-and-status\.test\.js/u);
  assert.match(runner, /sidebar-selection-visibility\.test\.js/u);
  assert.match(runner, /sidebar-virtualization\.test\.js/u);
  assert.match(runner, /view-state-helpers\.test\.js/u);
  assert.match(runner, /bootstrap-gallery-event-handlers\.test\.js/u);
  assert.match(runner, /synthetic-performance-benchmark\.test\.js/u);
  assert.match(runner, /performance-change-impact\.test\.js/u);
  assert.match(runner, /searchInput\.spec\.js/u);
  assert.match(runner, /-Shard gallery-search-visual/u);
  assert.match(
    runner,
    /\$fixtureDistributionRoot\s*=\s*Split-Path -Parent \(Split-Path -Parent \(\[IO\.Path\]::GetFullPath\(\$FixtureRoot\)\)\)/u,
  );
  assert.match(runner, /-FixtureDistribution\s+\$fixtureDistributionRoot/u);
  assert.match(runner, /artist-family,search-all-artists,search-browse/u);
});

test('agent instructions require the complete search gate for relevant changes', () => {
  const guidance = fs.readFileSync(path.join(repositoryRoot, 'AGENTS.md'), 'utf8');

  assert.match(guidance, /npm run test:search-regressions/u);
  assert.match(guidance, /search\s+algorithms/u);
  assert.match(guidance, /cache\s+invalidation/u);
  assert.match(guidance, /gallery.*rebuild/isu);
  assert.match(guidance, /artist-tree/iu);
  assert.match(guidance, /watcher\s+reconciliation/iu);
  assert.match(guidance, /pagination/iu);
  assert.match(guidance, /search-related\s+rendering/iu);
});


test('calibrated search gate keeps functional release selection independent', () => {
  const runner = fs.readFileSync(path.join(repositoryRoot, 'scripts/run-search-regressions.ps1'), 'utf8');
  assert.match(runner, /\[string\]\$FunctionalFixtureDistribution/u);
  assert.match(runner, /if \(-not \[string\]::IsNullOrWhiteSpace\(\$FunctionalFixtureDistribution\)\) \{\s*\$fixtureDistributionRoot = \[IO\.Path\]::GetFullPath\(\$FunctionalFixtureDistribution\)/u);
  assert.match(runner, /-FixtureDistribution\s+\$fixtureDistributionRoot/u);
  assert.match(runner, /\$env:ALBUM_HAVEN_FIXTURE_ROOT = \$FixtureRoot/u);
  assert.match(runner, /\$env:ALBUM_HAVEN_SYNTHETIC_SCALE_PRESET = \$SyntheticScalePreset/u);
});
