const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, '.github/workflows/pr-gates.yml'), 'utf8');
function job(name) { return source.split(`\n  ${name}:`)[1].split(/\n  [a-z_]+:/)[0]; }

test('complete Codex coverage is planned before any paid batch, with bounded independent jobs', () => {
  const plan = job('codex_review_plan');
  const batches = job('codex_review_batches');
  assert.match(plan, /plan-codex-review\.cjs --output-dir \.tmp\/codex-review/);
  assert.match(plan, /name: private-review-usage-units-/);
  assert.match(plan, /path: \.tmp\/codex-review\/usage-units\.json/);
  assert.match(plan, /matrix_json: \$\{\{ steps\.plan\.outputs\.matrix_json \}\}/);
  assert.match(plan, /assert\.equal\(normalize\(fs\.readFileSync\(outputPath, 'utf8'\)\), normalize\(buildRuntimeBundle\(\)\)/);
  assert.doesNotMatch(plan, /openai-api-key:|uses: openai\/codex-action/);
  assert.match(batches, /needs\.codex_review_plan\.result == 'success'/);
  assert.match(batches, /fail-fast: false/);
  assert.match(batches, /max-parallel: 4/);
  assert.match(batches, /fromJSON\(needs\.codex_review_plan\.outputs\.matrix_json/);
  assert.match(batches, /codex-args: \$\{\{ matrix\.codex_args \}\}/);
  assert.match(batches, /prompt-file: \.tmp\/codex-review\/\$\{\{ matrix\.id \}\}\.prompt\.md/);
  assert.match(batches, /output-schema-file: \.tmp\/codex-review\/\$\{\{ matrix\.id \}\}\.schema\.json/);
  assert.match(batches, /validate-codex-review-batches\.cjs batch/);
  assert.match(batches, /name: codex-review-result-.*matrix\.id/);
});

test('integration requires complete artifacts and enforces combined findings before tests', () => {
  const integration = job('codex_review');
  assert.match(integration, /^      - codex_review_plan$/m);
  assert.match(integration, /^      - codex_review_batches$/m);
  assert.match(integration, /needs\.codex_review_batches\.result == 'success'/);
  const prepare = integration.indexOf('validate-codex-review-batches.cjs prepare');
  assert.ok(prepare >= 0 && prepare < integration.indexOf('id: run_codex'));
  assert.match(integration, /preflight --plan-dir \.tmp\/codex-review --unit integration --manifest-digest/);
  assert.match(integration, /pattern: codex-review-result-/);
  assert.match(integration, /merge-multiple: true/);
  assert.match(integration, /batch --plan-dir \.tmp\/codex-review --unit integration --input \.tmp\/codex-integration\/result\.json/);
  assert.match(integration, /name: codex-review-result-.*\}\}-integration/);
  assert.match(integration, /path: \.tmp\/codex-integration\/integration\.json/);
  assert.match(integration, /validate-codex-review-batches\.cjs final/);
  assert.match(integration, /--integration \.tmp\/codex-integration\/result\.json/);
  const prerequisites = job('review_prerequisites');
  assert.match(prerequisites, /CODEX_RESULT: \$\{\{ needs\.codex_review\.result \}\}/);
  assert.match(prerequisites, /--review-prerequisites/);
});

test('every Codex unit uses the immutable event merge, pinned tooling and a separate restricted home', () => {
  for (const name of ['codex_review_plan', 'codex_review_batches', 'codex_review']) {
    const section = job(name);
    assert.match(section, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(section, /persist-credentials: false/);
    assert.match(section, /!github\.event\.pull_request\.draft/);
    assert.match(section, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
    if (name === 'codex_review_plan') continue;
    assert.match(section, /ref: 86365089eb2b84e0a8fb0717b304f8bdcb13b20e/);
    assert.match(section, /uses: \.\/\.tmp\/codex-action/);
    assert.match(section, /codex-version: "0\.153\.4"/);
    assert.match(section, /permission-profile: ":read-only"/);
    assert.match(section, /safety-strategy: drop-sudo/);
    assert.match(section, /REVIEW_USAGE_UNIT_ID:/);
    assert.match(section, /REVIEW_USAGE_MANIFEST_DIGEST: \$\{\{ needs\.codex_review_plan\.outputs\.manifest_digest \}\}/);
    assert.match(section, name === 'codex_review_batches' ? /codex-home: .*matrix\.id/ : /codex-home: .*\}\}-integration/);
    assert.doesNotMatch(section, /--ephemeral|--dangerously|workflow_dispatch/);
  }
});
test('private usage uploads select encrypted files only, including the hidden staging directory', () => {
  for (const [name, reviewer] of [['codex_review_batches', 'codex'], ['codex_review', 'codex'], ['pr_agent_review', 'pr-agent']]) {
    const section = job(name);
    const uploads = section.split(/\n      - name:/).filter(step => step.includes('uses: actions/upload-artifact@v4')
      && step.includes(`name: private-review-usage-${reviewer}-`));
    assert.equal(uploads.length, 1);
    const step = uploads[0];
    assert.match(step, new RegExp(`name: private-review-usage-${reviewer}-`));
    assert.match(step, new RegExp(`path: \\.tmp/private-review-usage/${reviewer}\\.enc\\.json\\s`));
    assert.match(step, /include-hidden-files: true/);
    assert.doesNotMatch(step, /path:.*\*/);
  }
});

test('attempted Codex units retain only separately encrypted context-bound diagnostics', () => {
  for (const name of ['codex_review_batches', 'codex_review']) {
    const section = job(name);
    const steps = section.split(/\n      - name:/);
    const action = steps.find(step => step.includes('id: run_codex'));
    const seal = steps.find(step => step.includes('private-codex-diagnostic.cjs seal'));
    const upload = steps.find(step => step.includes('name: private-review-diagnostic-codex-'));
    for (const step of [action, seal]) {
      assert.match(step, /REVIEW_USAGE_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
      assert.match(step, /REVIEW_USAGE_PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/);
      assert.match(step, /REVIEW_USAGE_MANIFEST_DIGEST: \$\{\{ needs\.codex_review_plan\.outputs\.manifest_digest \}\}/);
      assert.match(step, name === 'codex_review_batches' ? /REVIEW_USAGE_UNIT_ID: \$\{\{ matrix\.id \}\}/ : /REVIEW_USAGE_UNIT_ID: integration/);
    }
    for (const step of [seal, upload]) {
      assert.match(step, /always\(\) && steps\.run_codex\.outcome != '' && steps\.run_codex\.outcome != 'skipped'/);
      assert.match(step, /continue-on-error: true/);
    }
    assert.match(seal, /REVIEW_USAGE_ACTION_OUTCOME: \$\{\{ steps\.run_codex\.outcome \}\}/);
    assert.match(seal, /--runner-temp "\$RUNNER_TEMP" --public-key \.github\/review-usage-public-key\.pem --output \.tmp\/private-review-diagnostics\/codex\.enc\.json/);
    assert.match(upload, /path: \.tmp\/private-review-diagnostics\/codex\.enc\.json\s/);
    assert.match(upload, /retention-days: 7/);
    assert.match(upload, /include-hidden-files: true/);
    assert.doesNotMatch(upload, /path:.*(?:\*|RUNNER_TEMP|\.log)/);
    assert.ok(section.indexOf('private-codex-diagnostic.cjs seal') < section.indexOf('seal-review-usage.cjs'));
    assert.doesNotMatch(action, /continue-on-error:/);
  }
});

test('Codex uses the verified private-output action wrapper in every paid unit', () => {
  for (const name of ['codex_review_batches', 'codex_review']) {
    const section = job(name);
    assert.match(section, /repository: openai\/codex-action/);
    assert.match(section, /ref: 86365089eb2b84e0a8fb0717b304f8bdcb13b20e/);
    assert.match(section, /path: \.tmp\/codex-action/);
    const prepare = section.indexOf('prepare-private-codex-action.cjs --action-dir .tmp/codex-action');
    assert.ok(prepare > 0 && prepare < section.indexOf('id: run_codex'));
    assert.match(section, /uses: \.\/\.tmp\/codex-action/);
    assert.doesNotMatch(section, /uses: openai\/codex-action@/);
    assert.doesNotMatch(section, /path:.*(?:private.*\.log|codex-home|sessions)/);
  }
});
test('PR Agent callback is scoped to its action, with host-owned capture files and public costs disabled', () => {
  const section = job('pr_agent_review');
  assert.ok(section.indexOf('install -m 600 /dev/null .tmp/private-review-usage/pr-agent.jsonl.status.json') < section.indexOf('id: pr_agent'));
  assert.match(section, /PYTHONPATH: \/github\/workspace\/scripts\/ci\/review-usage-python:\/app/);
  assert.match(section, /config\.output_run_cost: "false"/);
  assert.match(section, /config\.output_run_details: "false"/);
  assert.match(section, /config\.log_level: "INFO"/);
  assert.doesNotMatch(job('codex_review'), /ALBUM_HAVEN_REVIEW_USAGE_FILE|PYTHONPATH:/);
});
test('Codex records use a fresh run-scoped home and no private or billing key is supplied to CI', () => {
  const section = job('codex_review');
  assert.match(section, /codex-home: \$\{\{ runner\.temp \}\}\/album-haven-codex-/);
  assert.doesNotMatch(source, /private-key\.pem|OPENAI_ADMIN_KEY|OPENAI_ADMIN_API_KEY/);
  assert.doesNotMatch(source, /VERY POWER|deep_codex_review/);
});
