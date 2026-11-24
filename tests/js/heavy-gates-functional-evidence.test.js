const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const STEP = '      - name: Collect failed functional shard evidence\n';
const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/heavy-gates.yml'), 'utf8')
  .replace(/\r\n/g, '\n');

function collectionScript() {
  const start = workflow.indexOf(STEP);
  assert.notEqual(start, -1, 'heavy gates must collect the functional runner\'s failure evidence');
  const body = workflow.slice(start + STEP.length).split('\n      - ')[0];
  return body.split('run: |\n')[1].split('\n')
    .filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10))
    .join('\n');
}

test('heavy gates collect functional evidence after a failure and before uploading it', () => {
  const start = workflow.indexOf(STEP);
  assert.notEqual(start, -1, 'heavy gates must collect the functional runner\'s failure evidence');
  assert.ok(start < workflow.indexOf('      - name: Upload gate results'));
  assert.match(workflow.slice(start, start + 200), /if: \$\{\{ failure\(\) \}\}/);
});

test('the collection copies traces and blobs but no database state, credentials or fixture media', {
  skip: process.platform !== 'win32' && 'the gate runs on Windows',
}, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temp = path.join(root, 'temp');
  const workspace = path.join(root, 'workspace');
  const shard = 'album-haven-functional-local-0123456789ab-metadata_mutations';
  for (const file of ['output/case/trace.zip', 'blob/report.zip', 'postgres.env', 'postgres.state.json', 'fixture-work/shared/media.flac']) {
    const target = path.join(temp, shard, ...file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'synthetic');
  }
  fs.mkdirSync(workspace);

  const result = spawnSync('powershell', ['-NoProfile', '-Command', collectionScript()], {
    cwd: workspace, env: { ...process.env, TEMP: temp, TMP: temp }, encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const collected = path.join(workspace, 'test-results', 'regression-gates', 'functional-shards', shard);
  assert.deepEqual(fs.readdirSync(collected).sort(), ['blob', 'output']);
  assert.ok(fs.existsSync(path.join(collected, 'output', 'case', 'trace.zip')));
  assert.ok(fs.existsSync(path.join(collected, 'blob', 'report.zip')));
});
