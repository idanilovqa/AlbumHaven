const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const workflowPath = path.join(root, '.github', 'workflows', 'pr-gates.yml');
const validatorPath = path.join(root, 'scripts', 'ci', 'validate-cloud-verification-gate.cjs');

const REQUIRED_JOBS = [
  'test_js', 'test_components', 'test_node_windows', 'test_python', 'e2e_production_parity',
  'e2e_phase7_auth', 'e2e_phase7_admin', 'e2e_functional', 'e2e_performance_ci',
  'review_scope', 'pr_agent_review', 'codex_review', 'ai_code_review',
];

const REVIEW_JOBS = ['pr_agent_review', 'codex_review', 'ai_code_review'];

function validInput(mode = 'trusted', reviewMode = 'full') {
  const trusted = mode === 'trusted';
  const reviewExpectations = {
    none: ['skipped', 'skipped', 'skipped'],
    incremental: ['success', 'success', 'skipped'],
    full: ['success', 'success', 'success'],
  }[reviewMode];
  const jobResults = Object.fromEntries(REQUIRED_JOBS.map((job) => [job, trusted ? 'success' : (
    ['test_js', 'test_components', 'e2e_production_parity', 'review_scope'].includes(job) ? 'success' : 'skipped'
  )]));
  if (trusted) REVIEW_JOBS.forEach((job, index) => { jobResults[job] = reviewExpectations[index]; });
  return {
    mode,
    reviewMode,
    jobResults,
  };
}

test('workflow defines the always-running Cloud Verification Gate and keeps pull_request-only execution', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /^on:\s*\r?\n\s+pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /cloud_verification_gate:\s*\r?\n\s+name: Cloud Verification Gate/);
  const gate = workflow.slice(workflow.indexOf('  cloud_verification_gate:'));
  assert.match(gate, /if: \$\{\{ always\(\) \}\}/);
  for (const job of REQUIRED_JOBS) assert.match(gate, new RegExp(`\\s+- ${job}\\r?$`, 'm'));
  assert.doesNotMatch(gate, /merge_cloud_reports|deploy_cloud_reports|cloud-test-report-/);
  assert.match(gate, /Non-authoritative fork conclusion/);
  assert.match(gate, /Non-authoritative fork conclusion:[\s\S]*maintainer must move or retrigger the pull request head in the trusted same-repository context[\s\S]*exit 1/);
  assert.match(gate, /validate-cloud-verification-gate\.cjs/);
});

test('workflow classifies review scope and gates all reviewers behind successful E2E', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /review_scope:\s*\r?\n\s+name: PR Review Scope/);
  assert.match(workflow, /node scripts\/ci\/classify-pr-review-scope\.cjs/);
  assert.match(workflow, /mode: \$\{\{ steps\.classify\.outputs\.mode \}\}/);
  assert.match(workflow, /PR_LAST_REVIEWED_SHA: \$\{\{ steps\.baseline\.outputs\.result \}\}/);
  assert.match(workflow, /album-haven-reviewed-head:/);
  assert.match(workflow, /listWorkflowRunsForRepo/);
  assert.match(workflow, /run\.conclusion === 'success'/);
  assert.match(workflow, /run\.pull_requests\?\.some\(\(pr\) => pr\.number === context\.payload\.pull_request\.number\)/);
  assert.match(workflow, /startedAt <= commentUpdatedAt/);
  assert.match(workflow, /commentUpdatedAt <= completedAt/);

  const prAgent = workflow.slice(workflow.indexOf('  pr_agent_review:'), workflow.indexOf('  codex_review:'));
  const codex = workflow.slice(workflow.indexOf('  codex_review:'), workflow.indexOf('  ai_code_review:'));
  const third = workflow.slice(workflow.indexOf('  ai_code_review:'), workflow.indexOf('  cloud_verification_gate:'));
  for (const block of [prAgent, codex, third]) {
    for (const job of ['e2e_phase7_auth', 'e2e_phase7_admin', 'e2e_functional', 'e2e_performance_ci']) {
      assert.match(block, new RegExp(`needs\\.${job}\\.result == 'success'`));
    }
    assert.match(block, /needs\.review_scope\.result == 'success'/);
  }
  assert.match(prAgent, /github_action_config\.handle_push_trigger: "\$\{\{ github\.event\.action == 'synchronize' \}\}"/);
  assert.match(prAgent, /\["\/review -i"\]/);
  assert.match(prAgent, /\["\/review"\]/);
  assert.match(codex, /BASE_SHA: \$\{\{ needs\.review_scope\.outputs\.base_sha \}\}/);
  assert.match(codex, /HEAD_SHA: \$\{\{ needs\.review_scope\.outputs\.head_sha \}\}/);
  assert.match(third, /needs\.review_scope\.outputs\.mode == 'full'/);
  assert.match(third, /zxcloli666\/AI-Code-Review@e4c07fe82e4c70a3cf152773423f608a88e9497d/);
  assert.match(third, /ENABLE_LINTERS: "false"/);
  assert.doesNotMatch(third, /outputs\.review_status/);

  const gate = workflow.slice(workflow.indexOf('  cloud_verification_gate:'));
  assert.match(gate, /REVIEW_MODE: \$\{\{ needs\.review_scope\.outputs\.mode \}\}/);
  assert.match(gate, /AI_CODE_REVIEW_RESULT: \$\{\{ needs\.ai_code_review\.result \}\}/);
  assert.match(gate, /reviewMode = \$env:REVIEW_MODE/);
  assert.match(gate, /Record successfully reviewed head/);
});

test('trusted gate accepts the reviewer matrix for each review mode', () => {
  assert.equal(fs.existsSync(validatorPath), true, 'cloud gate validator must exist');
  const { validateCloudVerificationGate } = require(validatorPath);
  for (const reviewMode of ['none', 'incremental', 'full']) {
    assert.deepEqual(validateCloudVerificationGate(validInput('trusted', reviewMode)), {
      authoritative: true,
      conclusion: 'success',
      errors: [],
    });
  }
});

test('trusted gate fails closed for missing and non-success foundation or E2E results', () => {
  const { validateCloudVerificationGate } = require(validatorPath);
  for (const job of REQUIRED_JOBS.filter((name) => !REVIEW_JOBS.includes(name))) {
    for (const conclusion of [undefined, 'failure', 'cancelled', 'skipped']) {
      const input = validInput();
      input.jobResults[job] = conclusion;
      const result = validateCloudVerificationGate(input);
      assert.equal(result.authoritative, true);
      assert.equal(result.conclusion, 'failure');
      assert.ok(result.errors.length > 0);
    }
  }
});

test('trusted gate rejects reviewer results that do not match the selected mode', () => {
  const { validateCloudVerificationGate } = require(validatorPath);
  for (const reviewMode of ['none', 'incremental', 'full']) {
    for (const job of REVIEW_JOBS) {
      const input = validInput('trusted', reviewMode);
      input.jobResults[job] = input.jobResults[job] === 'success' ? 'skipped' : 'success';
      assert.equal(validateCloudVerificationGate(input).conclusion, 'failure');
    }
  }
  assert.equal(validateCloudVerificationGate({ ...validInput(), reviewMode: 'unknown' }).conclusion, 'failure');
  assert.equal(validateCloudVerificationGate({ ...validInput(), reviewMode: undefined }).conclusion, 'failure');
});

test('fork conclusion is non-authoritative, portable-only, and deterministic', () => {
  const { validateCloudVerificationGate } = require(validatorPath);
  assert.deepEqual(validateCloudVerificationGate(validInput('fork')), {
    authoritative: false,
    conclusion: 'non-authoritative',
    errors: [],
  });
  const portableFailure = validInput('fork');
  portableFailure.jobResults.test_js = 'failure';
  assert.equal(validateCloudVerificationGate(portableFailure).conclusion, 'failure');
  const secretJobRan = validInput('fork');
  secretJobRan.jobResults.test_python = 'success';
  assert.equal(validateCloudVerificationGate(secretJobRan).conclusion, 'failure');
});
