const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const classifierPath = path.resolve(__dirname, '..', '..', 'scripts', 'ci', 'classify-pr-review-scope.cjs');
const {
  classifyPipelineLabels,
  classifyReviewScope,
  isUsableBaseline,
  isDocumentationPath,
  parseFocusedE2eRequest,
  parseNumstat,
  selectReviewDiffBase,
} = require(classifierPath);

test('forced full review classifies the complete PR delta', () => {
  assert.equal(selectReviewDiffBase({ action: 'synchronize', baseSha: 'base', lastReviewedSha: 'reviewed', forceFullReview: true }), 'base');
  assert.equal(selectReviewDiffBase({ action: 'synchronize', baseSha: 'base', lastReviewedSha: 'reviewed' }), 'reviewed');
});

test('focused E2E request parses exact cases and supported product areas', () => {
  const body = [
    'Repair notes.',
    '<!-- album-haven-focused-e2e:{"exactCases":["FTC-UTIL-PROBLEMS-007"],"areas":["problematic-files"]} -->',
  ].join('\n');
  assert.deepEqual(parseFocusedE2eRequest(body), {
    exactCases: ['FTC-UTIL-PROBLEMS-007'],
    areas: ['problematic-files'],
    performanceTargets: [],
    promotion: null,
  });
  assert.deepEqual(parseFocusedE2eRequest(
    '<!-- album-haven-focused-e2e:{"exactCases":["FTC-X"],"areas":["playback"],"promotion":{"stage":"related","headSha":"1111111111111111111111111111111111111111"}} -->',
  ).promotion, {
    stage: 'related',
    headSha: '1111111111111111111111111111111111111111',
  });
  assert.throws(
    () => parseFocusedE2eRequest('<!-- album-haven-focused-e2e:{"exactCases":[],"areas":["unknown"]} -->'),
    /unsupported focused E2E area/i,
  );
  assert.throws(
    () => parseFocusedE2eRequest(`${body}\n${body}`),
    /exactly one marker/i,
  );
  const oversized = `<!-- album-haven-focused-e2e:{"exactCases":["FTC-X"],"areas":["${'x'.repeat(4097)}"]} -->`;
  assert.throws(() => parseFocusedE2eRequest(oversized), /exceeds 4096/i);
  assert.throws(
    () => parseFocusedE2eRequest('<!-- album-haven-focused-e2e:{"exactCases":["FTC-X"],"areas":["playback"],"promotion":{"stage":"related","headSha":"stale"}} -->'),
    /promotion head/i,
  );
});

test('focused E2E request accepts exact performance targets and rejects unknown targets', () => {
  assert.deepEqual(parseFocusedE2eRequest(
    '<!-- album-haven-focused-e2e:{"performanceTargets":["scan-cached"]} -->',
  ), {
    exactCases: [],
    areas: [],
    performanceTargets: ['scan-cached'],
    promotion: null,
  });
  assert.throws(
    () => parseFocusedE2eRequest(
      '<!-- album-haven-focused-e2e:{"performanceTargets":["scan-unknown"]} -->',
    ),
    /unsupported focused performance target/i,
  );
});

test('successful baseline must exist and be an ancestor of the current head', () => {
  const calls = [];
  assert.equal(isUsableBaseline('reviewed', 'head', (...args) => calls.push(args)), true);
  assert.deepEqual(calls.map(([, args]) => args), [
    ['cat-file', '-e', 'reviewed^{commit}'],
    ['merge-base', '--is-ancestor', 'reviewed', 'head'],
  ]);

  assert.equal(isUsableBaseline('divergent', 'head', (_git, args) => {
    if (args[0] === 'merge-base') throw new Error('not an ancestor');
  }), false);
});

test('documentation paths exclude docs and root Markdown but keep functional Markdown', () => {
  assert.equal(isDocumentationPath('docs/guide/setup.md'), true);
  assert.equal(isDocumentationPath('README.md'), true);
  assert.equal(isDocumentationPath('CHANGELOG.MD'), true);
  assert.equal(isDocumentationPath('.github/codex/prompts/review.md'), false);
  assert.equal(isDocumentationPath('music_app/routes/api.py'), false);
});

test('numstat parsing identifies line counts and binary files', () => {
  assert.deepEqual(parseNumstat('10\t4\tmusic_app/a.py\n-\t-\tmusic_app/logo.png\n'), [
    { additions: 10, deletions: 4, binary: false, path: 'music_app/a.py' },
    { additions: 0, deletions: 0, binary: true, path: 'music_app/logo.png' },
  ]);
});

test('documentation-only synchronize range skips reviews after a successful baseline', () => {
  assert.deepEqual(classifyReviewScope({
    action: 'synchronize',
    baseSha: 'base',
    lastReviewedSha: 'reviewed',
    headSha: 'head',
    numstat: '12\t3\tdocs/review.md\n1\t1\tREADME.md\n',
  }), {
    mode: 'none',
    baseSha: 'reviewed',
    headSha: 'head',
    functionalChange: false,
    functionalLines: 0,
    hasBinaryFunctionalChange: false,
  });
});

test('a synchronize event without a successful review baseline reviews functional changes but skips documentation-only changes', () => {
  for (const [numstat, expectedMode] of [
    ['4\t1\tdocs/review.md\n', 'none'],
    ['1\t0\tmusic_app/change.py\n', 'full'],
  ]) {
    const result = classifyReviewScope({
      action: 'synchronize',
      baseSha: 'base',
      lastReviewedSha: '',
      headSha: 'head',
      numstat,
    });
    assert.equal(result.mode, expectedMode);
    assert.equal(result.baseSha, expectedMode === 'full' ? 'base' : 'base');
  }
});

for (const [lines, expectedMode] of [[249, 'incremental'], [250, 'full'], [251, 'full']]) {
  test(`${lines} functional lines select ${expectedMode} mode on synchronize`, () => {
    const result = classifyReviewScope({
      action: 'synchronize',
      baseSha: 'base',
      lastReviewedSha: 'reviewed',
      headSha: 'head',
      numstat: `${lines}\t0\tmusic_app/change.py\n4\t2\tdocs/note.md\n`,
    });
    assert.equal(result.mode, expectedMode);
    assert.equal(result.functionalLines, lines);
    assert.equal(result.baseSha, expectedMode === 'incremental' ? 'reviewed' : 'base');
  });
}

test('binary functional changes force a whole-PR review', () => {
  const result = classifyReviewScope({
    action: 'synchronize',
    baseSha: 'base',
    lastReviewedSha: 'reviewed',
    headSha: 'head',
    numstat: '-\t-\tmusic_app/static/icon.png\n',
  });
  assert.equal(result.mode, 'full');
  assert.equal(result.baseSha, 'base');
  assert.equal(result.hasBinaryFunctionalChange, true);
});

test('non-synchronize functional events review the whole PR', () => {
  for (const action of ['opened', 'reopened', 'ready_for_review']) {
    const result = classifyReviewScope({
      action,
      baseSha: 'base',
      lastReviewedSha: 'reviewed',
      headSha: 'head',
      numstat: '1\t0\tmusic_app/change.py\n',
    });
    assert.equal(result.mode, 'full');
    assert.equal(result.baseSha, 'base');
  }
});

test('mixed documentation and functional changes count only functional lines', () => {
  const result = classifyReviewScope({
    action: 'synchronize',
    baseSha: 'base',
    lastReviewedSha: 'reviewed',
    headSha: 'head',
    numstat: '100\t50\tdocs/large.md\n10\t5\t.github/codex/prompts/review.md\n',
  });
  assert.equal(result.mode, 'incremental');
  assert.equal(result.functionalLines, 15);
});

test('full-review label forces a whole-PR review only when functional changes exist', () => {
  assert.equal(classifyReviewScope({
    action: 'synchronize',
    baseSha: 'base',
    lastReviewedSha: 'reviewed',
    headSha: 'head',
    numstat: '1\t0\tmusic_app/change.py\n',
    forceFullReview: true,
  }).mode, 'full');
  assert.equal(classifyReviewScope({
    action: 'synchronize',
    baseSha: 'base',
    lastReviewedSha: 'reviewed',
    headSha: 'head',
    numstat: '1\t0\tdocs/release.md\n',
    forceFullReview: true,
  }).mode, 'none');
});

test('focused E2E labels select only named functional, Phase 7, and performance shards', () => {
  assert.deepEqual(classifyPipelineLabels([
    'ci:focused-e2e',
    'ci:e2e:gallery-search-visual',
    'ci:e2e:phase7-auth',
    'ci:e2e-performance:playback-media',
    'unrelated-label',
  ]), {
    pipelineMode: 'focused-e2e',
    focusedStage: 'exact',
    focusedExactCases: [],
    focusedAreas: [],
    focusedPerformanceTargets: [],
    forceFullReview: false,
    focusedFunctionalShards: ['gallery-search-visual'],
    focusedPhase7Targets: ['phase7-auth'],
    focusedPerformanceShards: ['playback-media'],
  });
});

test('an exact performance target selects its owning shard without expanding the target', () => {
  const request = parseFocusedE2eRequest(
    '<!-- album-haven-focused-e2e:{"performanceTargets":["scan-cached"]} -->',
  );
  const result = classifyPipelineLabels(['ci:focused-e2e'], request);
  assert.equal(result.focusedStage, 'exact');
  assert.deepEqual(result.focusedPerformanceTargets, ['scan-cached']);
  assert.deepEqual(result.focusedPerformanceShards, ['scan-library']);
});

test('a Phase 7 target accepts exact FTC cases without a functional area', () => {
  const request = parseFocusedE2eRequest(
    '<!-- album-haven-focused-e2e:{"exactCases":["FTC-PERMISSIONS-009"]} -->',
  );
  const result = classifyPipelineLabels(
    ['ci:focused-e2e', 'ci:e2e:phase7-admin'],
    request,
  );
  assert.equal(result.focusedStage, 'exact');
  assert.deepEqual(result.focusedExactCases, ['FTC-PERMISSIONS-009']);
  assert.deepEqual(result.focusedAreas, []);
  assert.deepEqual(result.focusedPhase7Targets, ['phase7-admin']);
});

test('focused E2E mode requires a supported target and rejects misspelled target labels', () => {
  assert.throws(
    () => classifyPipelineLabels(['ci:focused-e2e']),
    /at least one supported target label/,
  );
  assert.throws(
    () => classifyPipelineLabels(['ci:focused-e2e', 'ci:e2e:playbak-utilities']),
    /Unsupported focused E2E target label/,
  );
});

test('focused E2E promotion is bound to the current head and resets safely on a new head', () => {
  const request = {
    exactCases: ['FTC-UTIL-PROBLEMS-007'],
    areas: ['problematic-files'],
    promotion: {
      stage: 'related',
      headSha: '1111111111111111111111111111111111111111',
    },
  };
  const exact = classifyPipelineLabels(['ci:focused-e2e'], request);
  assert.equal(exact.focusedStage, 'exact');
  assert.deepEqual(exact.focusedExactCases, request.exactCases);
  const related = classifyPipelineLabels(
    ['ci:focused-e2e', 'ci:focused-related'],
    request,
    'labeled',
    request.promotion.headSha,
  );
  assert.equal(related.focusedStage, 'related');
  assert.deepEqual(related.focusedAreas, request.areas);

  const newHead = classifyPipelineLabels(
    ['ci:focused-e2e', 'ci:focused-related'],
    request,
    'synchronize',
    '2222222222222222222222222222222222222222',
  );
  assert.equal(newHead.focusedStage, 'exact');
  assert.deepEqual(newHead.focusedExactCases, request.exactCases);

  const fullRequest = {
    ...request,
    promotion: { stage: 'full', headSha: request.promotion.headSha },
  };
  assert.equal(classifyPipelineLabels(
    ['ci:full-review'], fullRequest, 'labeled', request.promotion.headSha,
  ).pipelineMode, 'focused-e2e');
  assert.equal(classifyPipelineLabels(
    ['ci:full-review'], fullRequest, 'synchronize', request.promotion.headSha,
  ).pipelineMode, 'full');
  const racedFull = classifyPipelineLabels(
    ['ci:full-review'], fullRequest, 'synchronize', '2222222222222222222222222222222222222222',
  );
  assert.equal(racedFull.pipelineMode, 'focused-e2e');
  assert.equal(racedFull.focusedStage, 'exact');
});

test('full mode is the default and accepts the explicit full-review label', () => {
  assert.deepEqual(classifyPipelineLabels([]), {
    pipelineMode: 'full',
    focusedStage: 'full',
    focusedExactCases: [],
    focusedAreas: [],
    focusedPerformanceTargets: [],
    forceFullReview: false,
    focusedFunctionalShards: [],
    focusedPhase7Targets: [],
    focusedPerformanceShards: [],
  });
  assert.equal(classifyPipelineLabels(['ci:full-review']).forceFullReview, true);
});
