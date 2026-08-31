const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_JOBS = [
  'test_js', 'test_components', 'test_node_windows', 'test_python', 'e2e_production_parity',
  'e2e_phase7_auth', 'e2e_phase7_admin', 'e2e_functional', 'e2e_performance_ci',
  'pr_agent_review', 'codex_review',
];
const PORTABLE_FORK_JOBS = new Set(['test_js', 'test_components', 'e2e_production_parity']);

function validateFork(input) {
  const errors = [];
  for (const job of REQUIRED_JOBS) {
    const expected = PORTABLE_FORK_JOBS.has(job) ? 'success' : 'skipped';
    if (input.jobResults?.[job] !== expected) errors.push(`fork job ${job} must be ${expected}`);
  }
  return {
    authoritative: false,
    conclusion: errors.length ? 'failure' : 'non-authoritative',
    errors,
  };
}

function validateTrusted(input) {
  const errors = [];
  for (const job of REQUIRED_JOBS) {
    if (input.jobResults?.[job] !== 'success') errors.push(`required job ${job} did not succeed`);
  }
  return {
    authoritative: true,
    conclusion: errors.length ? 'failure' : 'success',
    errors,
  };
}

function validateCloudVerificationGate(input) {
  if (!input || !['trusted', 'fork'].includes(input.mode)) {
    return { authoritative: false, conclusion: 'failure', errors: ['invalid gate mode'] };
  }
  return input.mode === 'fork' ? validateFork(input) : validateTrusted(input);
}

function cli() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Usage: validate-cloud-verification-gate.cjs <input.json>');
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const result = validateCloudVerificationGate(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
}

if (require.main === module) cli();

module.exports = { REQUIRED_JOBS, validateCloudVerificationGate };
