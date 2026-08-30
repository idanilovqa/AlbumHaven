const PERFORMANCE_THRESHOLD_STATUS = Object.freeze({
  TARGET_MET: 'target-met',
  GRACE_USED: 'grace-used',
  HARD_FAIL: 'hard-fail',
  UNCALIBRATED: 'uncalibrated',
});

const ALL_ARTISTS_RETURN_MEMORY_POLICY = 'all-artists-return-memory-sample-window';

function finiteNonNegativeNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function hardFail(evidenceConsistent = false) {
  return {
    performanceStatus: PERFORMANCE_THRESHOLD_STATUS.HARD_FAIL,
    thresholdPassed: false,
    policyPassed: false,
    evidenceConsistent,
    passed: false,
  };
}

function classifyPerformanceThreshold(contract = {}) {
  const actual = finiteNonNegativeNumber(contract.actual);
  const units = String(contract.units || '');
  if (units !== 'ms' && units !== 'bytes') {
    return hardFail(false);
  }
  const isUncalibrated = contract.calibrationState === 'uncalibrated'
    && contract.targetMaximum === null
    && contract.graceMs === null
    && contract.hardCeiling === null;

  if (isUncalibrated) {
    if (actual === null) {
      return hardFail(false);
    }
    const passed = contract.blocking === false && contract.processPassed === true;
    const evidenceConsistent = (contract.reportedStatus === undefined
      || contract.reportedStatus === PERFORMANCE_THRESHOLD_STATUS.UNCALIBRATED)
      && (contract.reportedPassed === undefined || contract.reportedPassed === passed);
    if (!evidenceConsistent) {
      return hardFail(false);
    }
    return {
      performanceStatus: PERFORMANCE_THRESHOLD_STATUS.UNCALIBRATED,
      thresholdPassed: null,
      policyPassed: contract.blocking === false,
      evidenceConsistent: true,
      passed,
    };
  }

  if (actual === null) {
    return hardFail(false);
  }

  const hardCeiling = finiteNonNegativeNumber(contract.hardCeiling);
  const targetMaximum = finiteNonNegativeNumber(contract.targetMaximum);
  const targetWasDeclared = contract.targetMaximum !== null
    && contract.targetMaximum !== undefined
    && !(typeof contract.targetMaximum === 'string' && contract.targetMaximum.trim() === '');
  const graceWasDeclared = contract.graceMs !== null
    && contract.graceMs !== undefined
    && !(typeof contract.graceMs === 'string' && contract.graceMs.trim() === '');
  const graceMs = finiteNonNegativeNumber(contract.graceMs);
  if (hardCeiling === null
    || (units === 'ms' && targetMaximum === null)
    || (targetWasDeclared && (targetMaximum === null || targetMaximum > hardCeiling))
    || (units === 'ms' && graceWasDeclared && (
      graceMs === null
      || graceMs < 200
      || graceMs > 400
      || targetMaximum + graceMs !== hardCeiling
    ))) {
    return hardFail(false);
  }

  const performanceStatus = actual > hardCeiling
    ? PERFORMANCE_THRESHOLD_STATUS.HARD_FAIL
    : units === 'ms' && actual > targetMaximum
      ? PERFORMANCE_THRESHOLD_STATUS.GRACE_USED
      : PERFORMANCE_THRESHOLD_STATUS.TARGET_MET;
  const thresholdPassed = performanceStatus !== PERFORMANCE_THRESHOLD_STATUS.HARD_FAIL;

  let policyPassed = thresholdPassed;
  if (contract.classificationPolicy !== undefined && contract.classificationPolicy !== null) {
    if (contract.classificationPolicy !== ALL_ARTISTS_RETURN_MEMORY_POLICY || units === 'ms') {
      return hardFail(false);
    }
    const { sampleCount, overThresholdCount, failingSampleCount } = contract;
    if (!Number.isInteger(sampleCount)
      || sampleCount <= 0
      || !Number.isInteger(overThresholdCount)
      || overThresholdCount < 0
      || overThresholdCount > sampleCount
      || failingSampleCount !== 2) {
      return hardFail(false);
    }
    policyPassed = overThresholdCount < failingSampleCount;
  }

  const passed = policyPassed && contract.processPassed !== false;
  const reportedStatusConsistent = contract.reportedStatus === undefined
    || contract.reportedStatus === performanceStatus;
  const reportedPassedConsistent = contract.reportedPassed === undefined
    || contract.reportedPassed === passed;
  const evidenceConsistent = reportedStatusConsistent && reportedPassedConsistent;
  if (!evidenceConsistent) {
    return hardFail(false);
  }

  return {
    performanceStatus,
    thresholdPassed,
    policyPassed,
    evidenceConsistent,
    passed,
  };
}

module.exports = {
  PERFORMANCE_THRESHOLD_STATUS,
  classifyPerformanceThreshold,
};
