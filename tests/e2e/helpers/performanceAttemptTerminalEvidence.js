import performanceTimesContract from '../../../scripts/performance-times-contract.cjs';

const {
  listRequiredPerformanceTimingMetricIds,
  resolveTimingBudget,
} = performanceTimesContract;
const VALID_CONTRACTS = new Set(['local', 'ci']);
const REQUIRED_TIMING_METRIC_IDS = new Set(listRequiredPerformanceTimingMetricIds());

function malformedEvidence(selectedContract, failureCategory, reporterFinalized = false) {
  return {
    selectedContract,
    reporterFinalized,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    results: [],
    failureCategory,
    eligibleForRecovery: false,
  };
}

function normalizeTimingResult(result, selectedContract) {
  if (result?.units !== 'ms') {
    const actual = Number(result?.actual);
    const hardCeiling = Number(result?.hardCeiling ?? result?.allowedMaximum);
    if (!Number.isFinite(actual) || !Number.isFinite(hardCeiling)) return null;
    return { ...result, actual, hardCeiling };
  }
  const targetMaximum = Number(result?.targetMaximum);
  const graceMs = Number(result?.graceMs);
  const hardCeiling = Number(result?.hardCeiling);
  const actual = Number(result?.actual);
  const metricId = String(result?.metricId || '').trim();
  if (!REQUIRED_TIMING_METRIC_IDS.has(metricId)) return null;
  const expectedBudget = resolveTimingBudget(metricId, selectedContract);
  if (
    result?.contractName !== selectedContract
    || ![targetMaximum, graceMs, hardCeiling, actual].every(Number.isFinite)
    || targetMaximum < 0
    || graceMs < 0
    || hardCeiling !== targetMaximum + graceMs
    || targetMaximum !== expectedBudget.targetMaximum
    || graceMs !== expectedBudget.graceMs
    || hardCeiling !== expectedBudget.hardCeiling
  ) return null;
  const performanceStatus = actual <= targetMaximum
    ? 'target-met'
    : (actual <= hardCeiling ? 'grace-used' : 'hard-fail');
  return { ...result, targetMaximum, graceMs, hardCeiling, actual, performanceStatus, passed: performanceStatus !== 'hard-fail' };
}

export function buildPerformanceAttemptTerminalEvidence(input = {}) {
  if (input.functionalChecksComplete !== true || input.nonTimingChecksComplete !== true) return null;
  const selectedContract = String(input.selectedContract || '');
  if (!VALID_CONTRACTS.has(selectedContract)) {
    return malformedEvidence(selectedContract, 'contract-mismatch', input.reporterFinalized === true);
  }
  const results = Array.isArray(input.results)
    ? input.results.map((result) => normalizeTimingResult(result, selectedContract))
    : [];
  if (results.some((result) => !result)) {
    return malformedEvidence(selectedContract, 'malformed-metrics', input.reporterFinalized === true);
  }
  const rawExpectedMetricIds = Array.isArray(input.expectedMetricIds) ? input.expectedMetricIds : [];
  const expectedMetricIds = [...new Set(rawExpectedMetricIds)];
  const timingResults = results.filter((result) => result.units === 'ms');
  const actualMetricIds = new Set(timingResults.map((result) => result.metricId));
  if (
    (expectedMetricIds.length === 0 && timingResults.length > 0)
    || expectedMetricIds.length !== rawExpectedMetricIds.length
    || expectedMetricIds.length !== actualMetricIds.size
    || actualMetricIds.size !== timingResults.length
    || expectedMetricIds.some((metricId) => !actualMetricIds.has(metricId))
  ) {
    return malformedEvidence(selectedContract, 'missing-or-duplicate-metrics', input.reporterFinalized === true);
  }
  const forbiddenFailure = input.failureCategory && input.failureCategory !== 'timing-hard-ceiling';
  const hasHardFailure = results.some((result) => result.performanceStatus === 'hard-fail');
  const hasNonTimingFailure = results.some((result) => result.units !== 'ms' && result.passed !== true);
  const failureCategory = forbiddenFailure
    ? input.failureCategory
    : (hasNonTimingFailure ? 'non-timing-contract' : (hasHardFailure ? 'timing-hard-ceiling' : null));
  return {
    selectedContract,
    reporterFinalized: input.reporterFinalized === true,
    functionalChecksComplete: true,
    nonTimingChecksComplete: true,
    results,
    failureCategory,
    eligibleForRecovery: selectedContract === 'ci'
      && input.reporterFinalized === true
      && hasHardFailure
      && !hasNonTimingFailure
      && !forbiddenFailure,
  };
}
