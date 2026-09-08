const fs = require('node:fs');
const path = require('node:path');

function prepareUsageReport({ reviewer, inputPath, context, actionOutcome }, io = fs) {
  let records = [];
  let telemetryStatus = 'unavailable';
  if (reviewer === 'codex') {
    try {
      const input = JSON.parse(io.readFileSync(inputPath, 'utf8'));
      if (!Array.isArray(input.records)) throw new Error('invalid');
      records = input.records;
      telemetryStatus = input.coverage === 'observed' ? 'available'
        : input.coverage === 'partial' ? 'partial' : 'unavailable';
    } catch { telemetryStatus = 'unavailable'; }
  } else if (reviewer === 'pr-agent') {
    let malformed = false;
    let registered = false;
    try {
      const status = JSON.parse(io.readFileSync(inputPath + '.status.json', 'utf8'));
      registered = status.schemaVersion === 1 && status.state === 'registered';
    } catch { /* Missing collector status remains unavailable. */ }
    try {
      for (const line of io.readFileSync(inputPath, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { malformed = true; }
      }
    } catch { /* Missing usage cannot establish zero spend. */ }
    if (records.length) telemetryStatus = registered && !malformed ? 'available' : 'partial';
  } else {
    throw new Error('unsupported-reviewer');
  }
  if (records.some((record) => !record || record.status !== 'success' || !record.usage)
      || (actionOutcome && actionOutcome !== 'success')) {
    if (records.length) telemetryStatus = 'partial';
  }
  if (!records.length) telemetryStatus = 'unavailable';
  return { schemaVersion: 1, context: { ...context, reviewer }, telemetryStatus, records };
}

function cli() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
  for (const name of ['--reviewer', '--input', '--public-key', '--output']) {
    if (!args[name]) throw new Error('missing-argument');
  }
  const { sealReport } = require('./private-review-usage.cjs');
  const context = {
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    headSha: process.env.REVIEW_USAGE_HEAD_SHA,
    repository: process.env.GITHUB_REPOSITORY,
  };
  const prNumber = Number(process.env.REVIEW_USAGE_PR_NUMBER);
  if (Number.isSafeInteger(prNumber) && prNumber > 0) context.pullRequestNumber = prNumber;
  const report = prepareUsageReport({ reviewer: args['--reviewer'], inputPath: args['--input'],
    actionOutcome: process.env.REVIEW_USAGE_ACTION_OUTCOME, context });
  const envelope = sealReport(report, fs.readFileSync(args['--public-key'], 'utf8'));
  const output = path.resolve(args['--output']);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(envelope) + '\n', { mode: 0o600 });
}

if (require.main === module) {
  try { cli(); } catch { process.stderr.write('Private review usage capture unavailable.\n'); process.exitCode = 1; }
}
module.exports = { prepareUsageReport };
