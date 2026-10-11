const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..');

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
  assert.match(runner, /gallery-search-clear-continuity\.test\.js/u);
  assert.match(runner, /search-toolbar-query-state\.test\.js/u);
  assert.match(runner, /search-toolbar-anchor-geometry\.test\.js/u);
  assert.match(runner, /search-input-clear\.test\.js/u);
  assert.match(runner, /gallery-tree-selection-performance\.test\.js/u);
  assert.match(runner, /root-gallery-pagination\.test\.js/u);
  assert.match(runner, /synthetic-performance-benchmark\.test\.js/u);
  assert.match(runner, /performance-change-impact\.test\.js/u);
  assert.match(runner, /searchInput\.spec\.js/u);
  assert.match(runner, /-Shard gallery-search-visual/u);
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
