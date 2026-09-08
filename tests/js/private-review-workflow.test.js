const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, '.github/workflows/pr-gates.yml'), 'utf8');
function job(name) { return source.split(`\n  ${name}:`)[1].split(/\n  [a-z_]+:/)[0]; }
test('private usage uploads select encrypted files only, including the hidden staging directory', () => {
  for (const [name, reviewer] of [['codex_review', 'codex'], ['pr_agent_review', 'pr-agent']]) {
    const section = job(name);
    const step = section.split('uses: actions/upload-artifact@v4')[1].split(/\n      - name:/)[0];
    assert.match(step, new RegExp(`name: private-review-usage-${reviewer}-`));
    assert.match(step, new RegExp(`path: \\.tmp/private-review-usage/${reviewer}\\.enc\\.json\\s`));
    assert.match(step, /include-hidden-files: true/);
    assert.doesNotMatch(step, /path:.*\*/);
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
