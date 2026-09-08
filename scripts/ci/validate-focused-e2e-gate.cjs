const fs = require('node:fs');
const path = require('node:path');

const FOCUSED_JOB_FAMILIES = [
  'e2e_functional',
  'e2e_phase7_auth',
  'e2e_phase7_admin',
  'e2e_performance_ci',
];
const REQUIRED_SCOPE_JOB = 'review_scope';
const FOCUSED_SKIPPED_JOBS = [
  'pr_agent_review',
  'codex_review',
  'ai_code_review',
  'test_js',
  'test_components',
  'test_node_windows',
  'test_python',
  'e2e_production_parity',
];

function validateFocusedE2eGate(input) {
  const errors = [];
  const selectedFamilies = Array.isArray(input?.selectedFamilies)
    ? [...new Set(input.selectedFamilies.map(String))]
    : [];
  const selected = new Set(selectedFamilies);
  if (input?.jobResults?.[REQUIRED_SCOPE_JOB] !== 'success') {
    errors.push(`${REQUIRED_SCOPE_JOB} must be success`);
  }
  if (input?.jobResults?.review_prerequisites !== 'success') errors.push('review_prerequisites must be success');
  for (const job of FOCUSED_SKIPPED_JOBS) {
    if (input?.jobResults?.[job] !== 'skipped') errors.push(`focused job ${job} must be skipped`);
  }
  if (!selectedFamilies.length) errors.push('focused E2E mode requires at least one selected job family');
  for (const family of selectedFamilies) {
    if (!FOCUSED_JOB_FAMILIES.includes(family)) errors.push(`unknown focused E2E job family: ${family}`);
  }
  for (const family of FOCUSED_JOB_FAMILIES) {
    const expected = selected.has(family) ? 'success' : 'skipped';
    if (input?.jobResults?.[family] !== expected) {
      errors.push(`focused job ${family} must be ${expected}`);
    }
  }
  return {
    authoritative: false,
    conclusion: errors.length ? 'failure' : 'success',
    errors,
  };
}

function cli() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Usage: validate-focused-e2e-gate.cjs <input.json>');
  const input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const result = validateFocusedE2eGate(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
}

if (require.main === module) cli();

module.exports = {
  FOCUSED_JOB_FAMILIES,
  FOCUSED_SKIPPED_JOBS,
  REQUIRED_SCOPE_JOB,
  validateFocusedE2eGate,
};
