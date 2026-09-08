const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const resolverPath = path.resolve(__dirname, '..', '..', 'scripts', 'ci', 'resolve-ci-shard.cjs');

test('functional shard resolver preserves the existing port and artifact mapping', () => {
  const { resolveFunctionalShard } = require(resolverPath);
  assert.deepEqual(resolveFunctionalShard('gallery-search-visual'), {
    shard: 'gallery-search-visual',
    displayName: 'Gallery, Search & Visual',
    portBase: 5200,
    outputDir: 'functional-output-gallery-search-visual',
    blobName: 'functional-blob-gallery-search-visual',
  });
  assert.equal(resolveFunctionalShard('playback-utilities').portBase, 5500);
  assert.throws(() => resolveFunctionalShard('unknown'), /Unknown functional shard/);
});

test('performance shard resolver preserves the existing fixture and target mapping', () => {
  const { resolvePerformanceShard } = require(resolverPath);
  assert.deepEqual(resolvePerformanceShard('playback-media'), {
    shard: 'playback-media',
    fixtureProfile: 'playback-media',
    fixtureDownloadProfile: 'synthetic-large-library',
    fixtureMode: 'generated-isolated',
    harness: 'managed-app',
    basePort: 4213,
    targets: ['playback-start', 'gapless-playback'],
  });
  assert.equal(resolvePerformanceShard('synthetic-large-library').targets.length, 10);
  assert.throws(() => resolvePerformanceShard('unknown'), /Unknown performance shard/);
});

test('CLI writes scalar and ten-slot target outputs for GitHub Actions', () => {
  const { runCli } = require(resolverPath);
  const writes = [];
  const result = runCli(['performance', 'utility-problematic-files'], (text) => writes.push(text));
  assert.equal(result.targets.length, 2);
  const output = writes.join('');
  assert.match(output, /fixture_profile=utility-problematic-files/);
  assert.match(output, /target1=utility-problematic-files/);
  assert.match(output, /target2=problematic-files-focused/);
  assert.match(output, /target3=none/);
  assert.match(output, /target10=none/);
});
