const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { applyPipelineSkips } = require('../../scripts/ci/classify-pr-review-scope.cjs');
const { REQUIRED_JOBS, validateCloudVerificationGate } = require('../../scripts/ci/validate-cloud-verification-gate.cjs');

const scope = { mode: 'full', pipelineMode: 'full', functionalChange: true, functionalLines: 500 };
const trusted = { repository: 'owner/app', headRepository: 'owner/app' };

for (const [labels, skipReviews, skipTests] of [
  [[], false, false], [['skip_reviews'], true, false], [['skip_tests'], false, true],
  [['skip_reviews', 'skip_tests'], true, true], [['skip_review'], false, false],
]) test(`pipeline controls honor exact labels: ${labels.join(',') || 'none'}`, () => {
  assert.deepEqual(applyPipelineSkips(scope, { ...trusted, labels }), {
    ...scope, mode: skipReviews ? 'none' : 'full', skipReviews, skipTests,
  });
  assert.equal(scope.mode, 'full', 'classification must not mutate the original review scope');
});

test('fork or missing repository context cannot activate pipeline skips', () => {
  for (const context of [{}, { repository: 'owner/app', headRepository: 'fork/app' }]) {
    assert.deepEqual(applyPipelineSkips(scope, { ...context, labels: ['skip_reviews', 'skip_tests'] }), {
      ...scope, skipReviews: false, skipTests: false,
    });
  }
});

test('review waiver permits complete tests but skipped tests never authorize release', () => {
  const jobResults = Object.fromEntries(REQUIRED_JOBS.map(name => [name, 'success']));
  jobResults.pr_agent_review = jobResults.codex_review = 'skipped';
  const input = { mode: 'trusted', pipelineMode: 'full', reviewMode: 'none', isDraft: false, jobResults };
  assert.equal(validateCloudVerificationGate(input).conclusion, 'success');
  for (const name of REQUIRED_JOBS.filter(name => name.startsWith('test_') || name.startsWith('e2e_'))) {
    assert.equal(validateCloudVerificationGate({ ...input, jobResults: { ...jobResults, [name]: 'skipped' } }).conclusion, 'failure');
  }
});

test('workflow honors test skips without publishing a false reviewed baseline', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/pr-gates.yml'), 'utf8');
  for (const name of REQUIRED_JOBS.filter(name => name.startsWith('test_') || name.startsWith('e2e_'))) {
    const start = workflow.indexOf(`  ${name}:`);
    const next = workflow.slice(start + 3).search(/^  [a-z0-9_]+:\s*$/m);
    const block = workflow.slice(start, next < 0 ? undefined : start + 3 + next);
    assert.match(block, /needs\.review_scope\.outputs\.skip_tests != 'true'/, name);
  }
  assert.match(workflow, /skip_reviews: \$\{\{ steps\.classify\.outputs\.skip_reviews \}\}/);
  assert.match(workflow, /skip_tests: \$\{\{ steps\.classify\.outputs\.skip_tests \}\}/);
  const marker = workflow.slice(workflow.indexOf('      - name: Record successfully reviewed head'));
  assert.match(marker.split('uses:')[0], /needs\.review_scope\.outputs\.skip_reviews != 'true'/);
  assert.match(workflow, /name: pr1-review-waiver-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
});

test('CLI emits independent controls while retaining every full test family', () => {
  const filename = path.join(__dirname, '../../scripts/ci/classify-pr-review-scope.cjs');
  const localRequire = createRequire(filename);
  for (const labels of [['skip_reviews'], ['skip_tests'], ['skip_reviews', 'skip_tests']]) {
    let output = '';
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, __dirname: path.dirname(filename),
      require(name) {
        if (name === 'node:fs') return {
          readFileSync: () => JSON.stringify({ pull_request: { head: { repo: { full_name: 'owner/app' } } } }),
          appendFileSync: (_filename, value) => { output += value; },
        };
        if (name === 'node:child_process') return { execFileSync: (_command, args) => (
          args[0] === 'merge-base' ? 'a'.repeat(40) : '10\t2\tmusic_app/app.py\n'
        ) };
        return localRequire(name);
      },
      process: { stdout: { write() {} }, stderr: { write() {} } },
    }, { filename });
    module.exports.runCli({
      PR_EVENT_ACTION: 'synchronize', PR_BASE_SHA: 'a'.repeat(40), PR_HEAD_SHA: 'b'.repeat(40),
      PR_LABELS_JSON: JSON.stringify(labels), GITHUB_EVENT_PATH: 'event.json',
      GITHUB_REPOSITORY: 'owner/app', GITHUB_OUTPUT: 'output',
    });
    const values = Object.fromEntries(output.trim().split('\n').map(line => {
      const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
    }));
    assert.equal(values.mode, labels.includes('skip_reviews') ? 'none' : 'full');
    assert.equal(values.skip_reviews, String(labels.includes('skip_reviews')));
    assert.equal(values.skip_tests, String(labels.includes('skip_tests')));
    assert.equal(values.pipeline_mode, 'full');
    assert.equal(values.functional_change, 'true');
    assert.equal(JSON.parse(values.functional_shards_json).length, 4);
    assert.equal(JSON.parse(values.performance_shards_json).length, 4);
    assert.equal(values.run_phase7_auth, 'true');
    assert.equal(values.run_phase7_admin, 'true');
  }
});
