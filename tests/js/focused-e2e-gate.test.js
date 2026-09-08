const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const validatorPath = path.join(root, 'scripts', 'ci', 'validate-focused-e2e-gate.cjs');
const workflowPath = path.join(root, '.github', 'workflows', 'pr-gates.yml');

test('focused gate validator accepts only successful selected job families', () => {
  assert.equal(fs.existsSync(validatorPath), true, 'focused E2E gate validator must exist');
  const { validateFocusedE2eGate } = require(validatorPath);
  assert.deepEqual(validateFocusedE2eGate({
    selectedFamilies: ['e2e_functional'],
    jobResults: {
      review_scope: 'success',
      pr_agent_review: 'skipped',
      codex_review: 'skipped',
      ai_code_review: 'skipped',
      test_js: 'skipped',
      test_components: 'skipped',
      test_node_windows: 'skipped',
      test_python: 'skipped',
      e2e_production_parity: 'skipped',
      e2e_functional: 'success',
      e2e_phase7_auth: 'skipped',
      e2e_phase7_admin: 'skipped',
      e2e_performance_ci: 'skipped',
    },
  }), {
    authoritative: false,
    conclusion: 'success',
    errors: [],
  });
});

test('focused gate fails closed for absent targets, failed targets, and unselected jobs that ran', () => {
  const { validateFocusedE2eGate } = require(validatorPath);
  assert.equal(validateFocusedE2eGate({ selectedFamilies: [], jobResults: {} }).conclusion, 'failure');
  const valid = {
    selectedFamilies: ['e2e_functional'],
    jobResults: {
      review_scope: 'success',
      pr_agent_review: 'skipped',
      codex_review: 'skipped',
      ai_code_review: 'skipped',
      test_js: 'skipped',
      test_components: 'skipped',
      test_node_windows: 'skipped',
      test_python: 'skipped',
      e2e_production_parity: 'skipped',
      e2e_functional: 'success',
      e2e_phase7_auth: 'skipped',
      e2e_phase7_admin: 'skipped',
      e2e_performance_ci: 'skipped',
    },
  };
  assert.equal(validateFocusedE2eGate({
    ...valid,
    jobResults: { ...valid.jobResults, e2e_functional: 'failure' },
  }).conclusion, 'failure');
  assert.equal(validateFocusedE2eGate({
    ...valid,
    jobResults: { ...valid.jobResults, e2e_phase7_auth: 'success' },
  }).conclusion, 'failure');
  assert.equal(validateFocusedE2eGate({
    ...valid,
    jobResults: { ...valid.jobResults, codex_review: 'success' },
  }).conclusion, 'failure');
  assert.equal(validateFocusedE2eGate({
    ...valid,
    jobResults: { ...valid.jobResults, test_python: 'success' },
  }).conclusion, 'failure');
});

test('workflow keeps focused verification non-authoritative and leaves promotion to an authenticated operator', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /focused_e2e_gate:\s*\r?\n\s+name: Focused E2E Verification/);
  const focusedGate = workflow.slice(
    workflow.indexOf('  focused_e2e_gate:'),
    workflow.indexOf('  cloud_verification_gate:'),
  );
  assert.match(focusedGate, /validate-focused-e2e-gate\.cjs/);
  assert.match(focusedGate, /authenticated release operator/);
  assert.doesNotMatch(focusedGate, /issues:\s+write/);
  assert.doesNotMatch(focusedGate, /pull-requests:\s+write/);
  assert.doesNotMatch(focusedGate, /setLabels|pulls\.update|createWorkflowDispatch/);
  assert.doesNotMatch(focusedGate, /album-haven-reviewed-head/);

  const fullGate = workflow.slice(workflow.indexOf('  cloud_verification_gate:'));
  assert.match(fullGate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(fullGate, /PIPELINE_MODE: \$\{\{ needs\.review_scope\.outputs\.pipeline_mode \}\}/);
  assert.match(fullGate, /album-haven-reviewed-head/);
});
