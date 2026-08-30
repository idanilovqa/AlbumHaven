import thresholdClassification from '../../../scripts/performance-threshold-classification.cjs';
import performanceTimesContract from '../../../scripts/performance-times-contract.cjs';

const {
  PERFORMANCE_THRESHOLD_STATUS,
  classifyPerformanceThreshold,
} = thresholdClassification;
const { resolvePerformanceContractName, resolveTimingBudget } = performanceTimesContract;

export const MIN_PERFORMANCE_GRACE_MS = 200;
export const MAX_PERFORMANCE_GRACE_MS = 400;

export const TIMING_BUDGET_STATUS = PERFORMANCE_THRESHOLD_STATUS;

export function selectedPerformanceContractName(env = process.env) {
  return resolvePerformanceContractName({
    requestedContract: env.PLAYWRIGHT_PERFORMANCE_CONTRACT || 'local',
    trustedCi: env.PLAYWRIGHT_PERFORMANCE_CONTRACT_TRUSTED === '1',
  });
}

export function performanceTimingBudget(metricId, env = process.env) {
  return resolveTimingBudget(metricId, selectedPerformanceContractName(env));
}

export function defaultPerformanceGraceMs(targetMaximum) {
  const target = Number(targetMaximum);
  if (!Number.isFinite(target) || target < 0) {
    throw new TypeError(`Timing target must be a finite non-negative number, received ${targetMaximum}.`);
  }
  return target < 1000 ? MIN_PERFORMANCE_GRACE_MS : MAX_PERFORMANCE_GRACE_MS;
}

export function defineTimingBudget({ targetMaximum, graceMs } = {}) {
  const target = Number(targetMaximum);
  const grace = graceMs === undefined
    ? defaultPerformanceGraceMs(target)
    : Number(graceMs);
  if (!Number.isFinite(target) || target < 0) {
    throw new TypeError(`Timing target must be a finite non-negative number, received ${targetMaximum}.`);
  }
  if (!Number.isFinite(grace)
    || grace < MIN_PERFORMANCE_GRACE_MS
    || grace > MAX_PERFORMANCE_GRACE_MS) {
    throw new RangeError(
      `Timing grace must be between ${MIN_PERFORMANCE_GRACE_MS} and ${MAX_PERFORMANCE_GRACE_MS} ms, received ${graceMs}.`,
    );
  }
  return Object.freeze({
    targetMaximum: target,
    graceMs: grace,
    hardCeiling: target + grace,
  });
}

export function evaluateTimingBudget(actualMs, contract) {
  const actualMissing = actualMs === null
    || actualMs === undefined
    || (typeof actualMs === 'string' && actualMs.trim() === '');
  const actual = actualMissing ? Number.NaN : Number(actualMs);
  const budget = defineTimingBudget(contract);
  const classification = classifyPerformanceThreshold({
    units: 'ms',
    actual,
    targetMaximum: budget.targetMaximum,
    graceMs: budget.graceMs,
    hardCeiling: budget.hardCeiling,
  });
  const status = classification.performanceStatus;
  return {
    actualMs: actual,
    metricId: contract?.metricId,
    contractName: contract?.contractName,
    ...budget,
    status,
    targetMet: status === TIMING_BUDGET_STATUS.TARGET_MET,
    graceUsed: status === TIMING_BUDGET_STATUS.GRACE_USED,
    passed: classification.passed,
  };
}

export function formatTimingBudgetOutcome(label, outcome) {
  const actualText = Number.isFinite(outcome.actualMs)
    ? `${Math.round(outcome.actualMs)} ms`
    : 'an invalid timing value';
  if (outcome.status === TIMING_BUDGET_STATUS.TARGET_MET) {
    return `TARGET MET: ${label} took ${actualText}, at or below the ${outcome.targetMaximum} ms target (hard ceiling ${outcome.hardCeiling} ms).`;
  }
  if (outcome.status === TIMING_BUDGET_STATUS.GRACE_USED) {
    return `GRACE USED: ${label} took ${actualText}, above the ${outcome.targetMaximum} ms target but within the ${outcome.hardCeiling} ms hard ceiling (${outcome.graceMs} ms grace).`;
  }
  return `HARD FAIL: ${label} took ${actualText}, above the ${outcome.targetMaximum} ms target plus ${outcome.graceMs} ms grace (${outcome.hardCeiling} ms hard ceiling).`;
}

export function expectTimingBudget(expect, actualMs, contract, label) {
  const outcome = evaluateTimingBudget(actualMs, contract);
  return expectTimingBudgetOutcome(expect, outcome, label);
}

export function expectTimingBudgetOutcome(expect, outcome, label) {
  expect(
    outcome.actualMs,
    formatTimingBudgetOutcome(label, outcome),
  ).toBeGreaterThanOrEqual(0);
  expect(
    outcome.actualMs,
    formatTimingBudgetOutcome(label, outcome),
  ).toBeLessThanOrEqual(outcome.hardCeiling);
  return outcome;
}
