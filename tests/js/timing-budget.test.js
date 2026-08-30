const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function listSpecFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listSpecFiles(entryPath);
    }
    return entry.name.endsWith('.spec.js') ? [entryPath] : [];
  });
}

test('timing budgets use 200 ms grace below one second and 400 ms at or above one second', async () => {
  const {
    defaultPerformanceGraceMs,
    defineTimingBudget,
  } = await import('../../tests/e2e/helpers/timingBudget.js');

  assert.equal(defaultPerformanceGraceMs(999), 200);
  assert.equal(defaultPerformanceGraceMs(1000), 400);
  assert.deepEqual({ ...defineTimingBudget({ targetMaximum: 350 }) }, {
    targetMaximum: 350,
    graceMs: 200,
    hardCeiling: 550,
  });
  assert.deepEqual({ ...defineTimingBudget({ targetMaximum: 1000 }) }, {
    targetMaximum: 1000,
    graceMs: 400,
    hardCeiling: 1400,
  });
});

test('timing budgets preserve explicit owner-approved grace within 200-400 ms', async () => {
  const { defineTimingBudget } = await import('../../tests/e2e/helpers/timingBudget.js');

  assert.deepEqual({ ...defineTimingBudget({ targetMaximum: 1000, graceMs: 200 }) }, {
    targetMaximum: 1000,
    graceMs: 200,
    hardCeiling: 1200,
  });
  assert.throws(() => defineTimingBudget({ targetMaximum: 1000, graceMs: 199 }), /between 200 and 400 ms/);
  assert.throws(() => defineTimingBudget({ targetMaximum: 1000, graceMs: 401 }), /between 200 and 400 ms/);
});

test('timing results distinguish target met, grace used, and hard fail at exact boundaries', async () => {
  const {
    evaluateTimingBudget,
    formatTimingBudgetOutcome,
  } = await import('../../tests/e2e/helpers/timingBudget.js');
  const contract = {
    metricId: 'example.readyMs',
    contractName: 'ci',
    targetMaximum: 350,
    graceMs: 200,
  };

  const targetMet = evaluateTimingBudget(350, contract);
  const graceUsed = evaluateTimingBudget(550, contract);
  const hardFail = evaluateTimingBudget(550.01, contract);

  assert.equal(targetMet.status, 'target-met');
  assert.equal(targetMet.passed, true);
  assert.equal(targetMet.metricId, 'example.readyMs');
  assert.equal(targetMet.contractName, 'ci');
  assert.equal(graceUsed.status, 'grace-used');
  assert.equal(graceUsed.passed, true);
  assert.equal(hardFail.status, 'hard-fail');
  assert.equal(hardFail.passed, false);
  assert.match(formatTimingBudgetOutcome('All Artists selection', graceUsed), /^GRACE USED:/);
  assert.match(formatTimingBudgetOutcome('All Artists selection', hardFail), /^HARD FAIL:/);
});

test('timing results fail closed for invalid observations and contracts', async () => {
  const {
    defineTimingBudget,
    evaluateTimingBudget,
  } = await import('../../tests/e2e/helpers/timingBudget.js');

  for (const actual of [-0.01, undefined, null, '', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(evaluateTimingBudget(actual, { targetMaximum: 350 }).status, 'hard-fail');
  }
  assert.throws(() => defineTimingBudget({ targetMaximum: -1 }), /finite non-negative/);
  assert.throws(() => defineTimingBudget({ targetMaximum: Number.NaN }), /finite non-negative/);
});

test('Playwright specs do not bypass the shared helper with direct millisecond upper-bound assertions', () => {
  const specsRoot = path.resolve(__dirname, '..', 'e2e');
  const forbidden = [];
  for (const specPath of listSpecFiles(specsRoot)) {
    const source = fs.readFileSync(specPath, 'utf8');
    const matches = source.matchAll(
      /expect\([\s\S]{0,160}?(?:elapsed|duration|timing|ready|[A-Za-z_$][\w$]*Ms)\b[\s\S]{0,160}?\)\.toBeLessThan(?:OrEqual)?\(/g,
    );
    for (const match of matches) {
      forbidden.push(`${path.relative(specsRoot, specPath)}: ${match[0].replace(/\s+/g, ' ')}`);
    }
  }
  assert.deepEqual(forbidden, []);
});
