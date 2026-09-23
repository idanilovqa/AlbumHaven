const assert = require('node:assert/strict');
const test = require('node:test');
const { validateReviewVerdict } = require('../../scripts/ci/validate-codex-review-verdict.cjs');
test('review verdict accepts only an exact final pass marker', () => {
  assert.equal(validateReviewVerdict('## Findings\nNone.\n\nALBUM_HAVEN_REVIEW_VERDICT=pass\n'), true);
  assert.throws(() => validateReviewVerdict('ALBUM_HAVEN_REVIEW_VERDICT=block'), /actionable findings/);
  assert.throws(() => validateReviewVerdict('## Findings\nNone.'), /valid verdict/);
  assert.throws(() => validateReviewVerdict('ALBUM_HAVEN_REVIEW_VERDICT=pass\nextra'), /valid verdict/);
});
