const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

function validateSelection({ repository, runId, attempt }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')
      || !/^[1-9][0-9]*$/.test(String(runId || ''))
      || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid-run-selection');
}

function verifyContext(report, expected) {
  for (const key of ['runId', 'runAttempt', 'headSha', 'reviewer', 'repository']) {
    if (report.context?.[key] !== expected[key]) throw new Error('artifact-context-mismatch');
  }
}

function github(args) {
  const result = cp.spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('github-read-failed');
  return result.stdout;
}

function downloadUsage({ repository, runId, attempt, headSha, staging, privateKey }, githubRead = github) {
  const { openReport, sealReport } = require('./ci/private-review-usage.cjs');
  const publicKey = require('node:crypto').createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  for (const reviewer of ['codex', 'pr-agent']) {
    const directory = path.join(staging, reviewer);
    fs.mkdirSync(directory, { mode: 0o700 });
    const artifact = 'private-review-usage-' + reviewer + '-' + runId + '-' + attempt;
    let downloaded = true;
    try { githubRead(['run', 'download', runId, '--repo', repository, '--name', artifact, '--dir', directory]); }
    catch { downloaded = false; }
    const context = { runId, runAttempt: attempt, headSha, reviewer, repository };
    const files = fs.readdirSync(directory);
    if (downloaded && files.length === 1 && files[0].endsWith('.enc.json')) {
      const filename = path.join(directory, files[0]);
      if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error('ambiguous-review-artifact');
      const report = openReport(JSON.parse(fs.readFileSync(filename, 'utf8')), privateKey);
      verifyContext(report, context);
    } else if (files.length > 0) {
      throw new Error('ambiguous-review-artifact');
    } else {
      const unavailable = { schemaVersion: 1, context, telemetryStatus: 'unavailable', records: [] };
      fs.writeFileSync(path.join(directory, 'unavailable.enc.json'), JSON.stringify(sealReport(unavailable, publicKey)), { mode: 0o600 });
    }
  }
}

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
  const runId = args['--run'];
  const repository = args['--repo'] || 'idanilovqa/AlbumHaven';
  validateSelection({ repository, runId, attempt: Number(args['--attempt'] || 1) });
  const run = JSON.parse(github(['api', 'repos/' + repository + '/actions/runs/' + runId]));
  const attempt = Number(args['--attempt'] || run.run_attempt);
  validateSelection({ repository, runId, attempt });
  if (attempt > run.run_attempt || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error('invalid-run-metadata');
  const localBase = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  const ownerDirectory = path.join(localBase, 'Album Haven', 'Review Usage');
  const privateKeyPath = args['--private-key'] || process.env.ALBUM_HAVEN_REVIEW_USAGE_PRIVATE_KEY
    || path.join(ownerDirectory, 'private-key.pem');
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  fs.mkdirSync(ownerDirectory, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(ownerDirectory, 'download-' + runId + '-' + attempt + '-'));
  downloadUsage({ repository, runId, attempt, headSha: run.head_sha, staging, privateKey });
  const prefix = args['--output-prefix'] || path.join(ownerDirectory, 'run-' + runId + '-attempt-' + attempt);
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'ci/private-review-usage.cjs'),
    'report', '--input-dir', staging, '--private-key', privateKeyPath, '--output-prefix', prefix],
  { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('private-report-failed');
  process.stdout.write(prefix + '.private.md\n' + prefix + '.private.json\n');
}

if (require.main === module) {
  try { main(); } catch (error) {
    const known = new Set(['invalid-run-selection', 'invalid-run-metadata', 'artifact-context-mismatch',
      'github-read-failed', 'ambiguous-review-artifact', 'private-report-failed']);
    process.stderr.write((known.has(error.message) ? error.message : 'private-report-unavailable-check-key-and-artifacts') + '\n');
    process.exitCode = 1;
  }
}
module.exports = { validateSelection, verifyContext, downloadUsage };
