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
  'review_scope', 'review_prerequisites', 'pr_agent_review', 'codex_review',
];

const REVIEW_JOBS = ['pr_agent_review', 'codex_review'];

function validInput(mode = 'trusted', reviewMode = 'full') {
  const trusted = mode === 'trusted';
  const reviewExpectations = {
    none: ['skipped', 'skipped'],
    incremental: ['success', 'success'],
    full: ['success', 'success'],
  }[reviewMode];
  const jobResults = Object.fromEntries(REQUIRED_JOBS.map((job) => [job, trusted ? 'success' : (
    ['test_js', 'test_components', 'e2e_production_parity', 'review_scope', 'review_prerequisites'].includes(job) ? 'success' : 'skipped'
  )]));
  if (trusted) REVIEW_JOBS.forEach((job, index) => { jobResults[job] = reviewExpectations[index]; });
  return {
    mode,
    pipelineMode: 'full',
    reviewMode,
    jobResults,
  };
}

test('workflow defines the cancellable Cloud Verification Gate for pull-request runs', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /^on:\s*\r?\n\s+pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /^\s{2}(?:push|schedule|workflow_dispatch|pull_request_target):/m);
  assert.match(workflow, /cloud_verification_gate:\s*\r?\n\s+name: Cloud Verification Gate/);
  const gate = workflow.slice(workflow.indexOf('  cloud_verification_gate:'));
  assert.match(gate, /if: \$\{\{ !cancelled\(\) \}\}/);
  for (const job of REQUIRED_JOBS) assert.match(gate, new RegExp(`\\s+- ${job}\\r?$`, 'm'));
  assert.doesNotMatch(gate, /merge_cloud_reports|deploy_cloud_reports|cloud-test-report-/);
  assert.match(gate, /Non-authoritative fork conclusion/);
  assert.match(gate, /Non-authoritative fork conclusion:[\s\S]*maintainer must move or retrigger the pull request head in the trusted same-repository context[\s\S]*exit 1/);
  assert.match(gate, /validate-cloud-verification-gate\.cjs/);
});

test('workflow holds every test family behind successful review prerequisites', () => {
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
  const codex = workflow.slice(workflow.indexOf('  codex_review:'), workflow.indexOf('  review_prerequisites:'));
  assert.doesNotMatch(workflow, /ai_code_review|AI_CODE_REVIEW|deep-review\.md/);
  assert.equal((workflow.match(/uses: openai\/codex-action@v1/g) || []).length, 1);
  for (const block of [prAgent, codex]) {
    assert.match(block, /needs\.review_scope\.result == 'success'/);
    assert.doesNotMatch(block, /needs\.(?:e2e_|review_prerequisites)/);
    assert.match(block, /if: \$\{\{ !cancelled\(\)/);
    assert.equal((block.match(/^      - (?:review_scope|pr_agent_review|codex_review)$/gm) || []).length, 1);
  }
  assert.match(prAgent, /github_action_config\.handle_push_trigger: "\$\{\{ github\.event\.action == 'synchronize' \}\}"/);
  assert.match(prAgent, /\["\/review -i"\]/);
  assert.match(prAgent, /\["\/review"\]/);
  assert.match(codex, /BASE_SHA: \$\{\{ needs\.review_scope\.outputs\.base_sha \}\}/);
  assert.match(codex, /HEAD_SHA: \$\{\{ needs\.review_scope\.outputs\.head_sha \}\}/);
  assert.match(codex, /validate-codex-review-verdict\.cjs codex-output\.md/);

  for (const jobName of [
    'test_js', 'test_components', 'test_node_windows', 'test_python', 'e2e_production_parity',
    'e2e_phase7_auth', 'e2e_phase7_admin', 'e2e_functional', 'e2e_performance_ci',
  ]) {
    const start = workflow.indexOf(`  ${jobName}:`);
    const nextJob = workflow.slice(start + 3).match(/^  [a-z0-9_]+:\s*$/m);
    const next = nextJob ? start + 3 + nextJob.index : -1;
    const block = workflow.slice(start, next < 0 ? workflow.length : next);
    assert.match(block, /pr_agent_review/);
    assert.match(block, /codex_review/);
    assert.match(block, /^      - review_prerequisites\r?$/m);
    assert.match(block, /if: \$\{\{ !cancelled\(\) && needs\.review_prerequisites\.result == 'success'/);
  }

  const gate = workflow.slice(workflow.indexOf('  cloud_verification_gate:'));
  assert.match(gate, /REVIEW_MODE: \$\{\{ needs\.review_scope\.outputs\.mode \}\}/);
  assert.match(gate, /reviewMode = \$env:REVIEW_MODE/);
  assert.match(gate, /Record successfully reviewed head/);
});

test('Phase 7 focused exact runs grep requested FTC cases and related runs expand to the suite', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  for (const jobName of ['e2e_phase7_auth', 'e2e_phase7_admin']) {
    const start = workflow.indexOf(`  ${jobName}:`);
    const nextJob = workflow.slice(start + 3).match(/^  [a-z0-9_]+:\s*$/m);
    const next = nextJob ? start + 3 + nextJob.index : workflow.length;
    const block = workflow.slice(start, next);
    assert.match(block, /FOCUSED_STAGE: \$\{\{ needs\.review_scope\.outputs\.focused_stage \}\}/);
    assert.match(block, /FOCUSED_EXACT_CASES_JSON: \$\{\{ needs\.review_scope\.outputs\.focused_exact_cases_json \}\}/);
    assert.match(block, /if \(\$env:FOCUSED_STAGE -eq "exact"\)/);
    assert.match(block, /\[regex\]::Escape/);
    assert.match(block, /--grep/);
  }
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

test('trusted full gate rejects focused pipeline mode', () => {
  const { validateCloudVerificationGate } = require(validatorPath);
  const input = validInput();
  input.pipelineMode = 'focused-e2e';
  assert.equal(validateCloudVerificationGate(input).conclusion, 'failure');
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


function prerequisiteInput({ mode = 'trusted', pipelineMode = 'full', reviewMode = 'full', isDraft = false } = {}) {
  const input = validInput(mode, reviewMode);
  Object.assign(input, { pipelineMode, isDraft });
  if (mode === 'fork' || isDraft || pipelineMode === 'focused-e2e') {
    for (const job of REVIEW_JOBS) input.jobResults[job] = 'skipped';
  }
  return input;
}

test('review prerequisites accept only the exact applicable reviewer matrix in every supported context', () => {
  const { validateReviewPrerequisites } = require(validatorPath);
  for (const mode of ['trusted', 'fork']) {
    for (const isDraft of [false, true]) {
      for (const reviewMode of ['none', 'incremental', 'full']) {
        const input = prerequisiteInput({ mode, isDraft, reviewMode });
        assert.equal(validateReviewPrerequisites(input).conclusion, 'success', JSON.stringify(input));
        for (const job of REVIEW_JOBS) {
          for (const result of [undefined, 'failure', 'cancelled', 'skipped', 'success']) {
            if (result === input.jobResults[job]) continue;
            const changed = { ...input, jobResults: { ...input.jobResults, [job]: result } };
            assert.equal(validateReviewPrerequisites(changed).conclusion, 'failure', JSON.stringify(changed));
          }
        }
      }
      const focused = prerequisiteInput({ mode, isDraft, reviewMode: 'none', pipelineMode: 'focused-e2e' });
      assert.equal(validateReviewPrerequisites(focused).conclusion, 'success');
      focused.jobResults.codex_review = 'success';
      assert.equal(validateReviewPrerequisites(focused).conclusion, 'failure');
    }
  }
});

test('review prerequisites reject unavailable scope and malformed applicability context', () => {
  const { validateReviewPrerequisites } = require(validatorPath);
  for (const result of [undefined, 'failure', 'cancelled', 'skipped']) {
    const input = prerequisiteInput();
    input.jobResults.review_scope = result;
    assert.equal(validateReviewPrerequisites(input).conclusion, 'failure');
  }
  for (const patch of [
    { mode: undefined }, { mode: 'other' }, { pipelineMode: undefined }, { pipelineMode: 'other' },
    { reviewMode: undefined }, { reviewMode: 'other' }, { reviewMode: 'constructor' },
    { isDraft: undefined }, { isDraft: 'false' },
    { pipelineMode: 'focused-e2e', reviewMode: 'full' },
  ]) assert.equal(validateReviewPrerequisites({ ...prerequisiteInput(), ...patch }).conclusion, 'failure');
});

test('workflow review prerequisite uses explicit PR context and final gates require its result', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const gate = workflow.slice(workflow.indexOf('  review_prerequisites:'), workflow.indexOf('  focused_e2e_gate:'));
  assert.match(gate, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(gate, /--review-prerequisites/);
  assert.match(gate, /github\.event\.pull_request\.draft/);
  assert.match(gate, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(gate, /secrets\.|issues: write|pull-requests: write/);
  for (const name of ['review_scope', ...REVIEW_JOBS]) assert.match(gate, new RegExp(`^      - ${name}\\r?$`, 'm'));
  for (const name of ['focused_e2e_gate', 'cloud_verification_gate']) {
    const start = workflow.indexOf(`  ${name}:`);
    const block = workflow.slice(start, name === 'focused_e2e_gate' ? workflow.indexOf('  cloud_verification_gate:') : undefined);
    assert.match(block, /^      - review_prerequisites\r?$/m);
    assert.match(block, /REVIEW_PREREQUISITES_RESULT: \$\{\{ needs\.review_prerequisites\.result \}\}/);
    assert.match(block, /review_prerequisites = \$env:REVIEW_PREREQUISITES_RESULT/);
  }
  assert.doesNotMatch(workflow, /^    if: .*always\(\)/m, 'job conditions must permit cancellation');
  assert.match(workflow, /^        if: .*always\(\)/m, 'step cleanup and artifact collection remain unconditional');
});

test('draft reviews remain inapplicable without authorizing the final cloud gate', () => {
  const { validateCloudVerificationGate } = require(validatorPath);
  assert.equal(validateCloudVerificationGate({ ...validInput('trusted', 'none'), isDraft: true }).conclusion, 'failure');
});
