const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const classifierPath = path.resolve(__dirname, '..', '..', 'scripts', 'ci', 'classify-pr-review-scope.cjs');
const {
  classifyReviewScope,
  isUsableBaseline,
  isDocumentationPath,
  parseNumstat,
} = require(classifierPath);

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

test('a synchronize event without a successful review baseline forces a whole-PR review', () => {
  for (const numstat of ['4\t1\tdocs/review.md\n', '1\t0\tmusic_app/change.py\n']) {
    const result = classifyReviewScope({
      action: 'synchronize',
      baseSha: 'base',
      lastReviewedSha: '',
      headSha: 'head',
      numstat,
    });
    assert.equal(result.mode, 'full');
    assert.equal(result.baseSha, 'base');
  }
});

for (const [lines, expectedMode] of [[249, 'incremental'], [250, 'incremental'], [251, 'full']]) {
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
