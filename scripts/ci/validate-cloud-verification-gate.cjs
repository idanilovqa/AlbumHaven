const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_JOBS = [
  'test_js', 'test_components', 'test_node_windows', 'test_python', 'e2e_production_parity',
  'e2e_phase7_auth', 'e2e_phase7_admin', 'e2e_functional', 'e2e_performance_ci',
  'review_scope', 'review_prerequisites', 'pr_agent_review', 'codex_review', 'ai_code_review',
];
const REVIEW_JOBS = new Set(['pr_agent_review', 'codex_review', 'ai_code_review']);
const PORTABLE_FORK_JOBS = new Set([
  'test_js', 'test_components', 'e2e_production_parity', 'review_scope', 'review_prerequisites',
]);
const REVIEW_EXPECTATIONS = {
  none: { pr_agent_review: 'skipped', codex_review: 'skipped', ai_code_review: 'skipped' },
  incremental: { pr_agent_review: 'success', codex_review: 'success', ai_code_review: 'skipped' },
  full: { pr_agent_review: 'success', codex_review: 'success', ai_code_review: 'success' },
};

function validateReviewPrerequisites(input) {
  const errors = [];
  if (input?.jobResults?.review_scope !== 'success') errors.push('review_scope must be success');
  if (!['trusted', 'fork'].includes(input?.mode)) errors.push('invalid review context');
  if (!['full', 'focused-e2e'].includes(input?.pipelineMode)) errors.push('invalid pipeline mode');
  if (!Object.hasOwn(REVIEW_EXPECTATIONS, input?.reviewMode)) errors.push('invalid review mode');
  if (typeof input?.isDraft !== 'boolean') errors.push('isDraft must be a boolean');
  if (input?.pipelineMode === 'focused-e2e' && input?.reviewMode !== 'none') {
    errors.push('focused E2E requires none review mode');
  }
  if (!errors.length) {
    const reviewsInapplicable = input.mode === 'fork' || input.isDraft || input.pipelineMode === 'focused-e2e';
    const expectations = REVIEW_EXPECTATIONS[reviewsInapplicable ? 'none' : input.reviewMode];
    for (const [job, expected] of Object.entries(expectations)) {
      if (input.jobResults?.[job] !== expected) errors.push(`review job ${job} must be ${expected}`);
    }
  }
  return { conclusion: errors.length ? 'failure' : 'success', errors };
}

function validateFork(input) {
  const errors = [];
  if (!Object.hasOwn(REVIEW_EXPECTATIONS, input.reviewMode)) {
    errors.push(`invalid review mode: ${String(input.reviewMode)}`);
  }
  for (const job of REQUIRED_JOBS) {
    const expected = PORTABLE_FORK_JOBS.has(job) ? 'success' : 'skipped';
    if (input.jobResults?.[job] !== expected) errors.push(`fork job ${job} must be ${expected}`);
  }
  return {
    authoritative: false,
    conclusion: errors.length ? 'failure' : 'non-authoritative',
    errors,
  };
}

function validateTrusted(input) {
  const errors = [];
  const reviewExpectations = Object.hasOwn(REVIEW_EXPECTATIONS, input.reviewMode)
    ? REVIEW_EXPECTATIONS[input.reviewMode] : undefined;
  if (input.isDraft === true) errors.push('draft pull requests cannot authorize full verification');
  if (!reviewExpectations) errors.push(`invalid review mode: ${String(input.reviewMode)}`);
  for (const job of REQUIRED_JOBS.filter((name) => !REVIEW_JOBS.has(name))) {
    if (input.jobResults?.[job] !== 'success') errors.push(`required job ${job} did not succeed`);
  }
  if (reviewExpectations) {
    for (const [job, expected] of Object.entries(reviewExpectations)) {
      if (input.jobResults?.[job] !== expected) {
        errors.push(`review job ${job} must be ${expected} in ${input.reviewMode} mode`);
      }
    }
  }
  return {
    authoritative: true,
    conclusion: errors.length ? 'failure' : 'success',
    errors,
  };
}

function validateCloudVerificationGate(input) {
  if (input?.pipelineMode !== 'full') {
    return {
      authoritative: input?.mode === 'trusted',
      conclusion: 'failure',
      errors: ['Cloud Verification Gate requires full pipeline mode'],
    };
  }
  if (!input || !['trusted', 'fork'].includes(input.mode)) {
    return { authoritative: false, conclusion: 'failure', errors: ['invalid gate mode'] };
  }
  return input.mode === 'fork' ? validateFork(input) : validateTrusted(input);
}

function cli() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Usage: validate-cloud-verification-gate.cjs <input.json>');
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const result = process.argv[3] === '--review-prerequisites'
    ? validateReviewPrerequisites(input) : validateCloudVerificationGate(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
}

if (require.main === module) cli();

module.exports = { REQUIRED_JOBS, REVIEW_EXPECTATIONS, validateReviewPrerequisites, validateCloudVerificationGate };
