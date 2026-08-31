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
  'pr_agent_review', 'codex_review',
];

function validInput(mode = 'trusted') {
  const trusted = mode === 'trusted';
  return {
    mode,
    jobResults: Object.fromEntries(REQUIRED_JOBS.map((job) => [job, trusted ? 'success' : (
      ['test_js', 'test_components', 'e2e_production_parity'].includes(job) ? 'success' : 'skipped'
    )])),
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

test('trusted gate accepts all direct required job conclusions', () => {
  assert.equal(fs.existsSync(validatorPath), true, 'cloud gate validator must exist');
  const { validateCloudVerificationGate } = require(validatorPath);
  assert.deepEqual(validateCloudVerificationGate(validInput()), {
    authoritative: true,
    conclusion: 'success',
    errors: [],
  });
});

test('trusted gate fails closed for missing and non-success required job results', () => {
  const { validateCloudVerificationGate } = require(validatorPath);
  for (const job of REQUIRED_JOBS) {
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
