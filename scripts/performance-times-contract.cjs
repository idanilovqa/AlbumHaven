const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONTRACT_PATH = path.join(__dirname, '..', 'tests', 'ci', 'performance-times.json');
const CONTRACT_NAMES = new Set(['local', 'ci']);
const MIN_GRACE_MS = 200;
const MAX_GRACE_MS = 400;
const METRIC_ID_ALIASES = Object.freeze({
  'artist-family.treeCosmicSelectionMs': 'artist-family-local-managed-chrome.treeCosmicSelectionMs',
});

function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return number;
}

function validateTriplet(metricId, contractName, value) {
  if (!value || typeof value !== 'object') {
    throw new Error(`${metricId}.${contractName} timing contract is missing.`);
  }
  const targetMs = finiteNonNegative(value.targetMs, `${metricId}.${contractName}.targetMs`);
  const graceMs = finiteNonNegative(value.graceMs, `${metricId}.${contractName}.graceMs`);
  const hardCeilingMs = finiteNonNegative(
    value.hardCeilingMs,
    `${metricId}.${contractName}.hardCeilingMs`,
  );
  if (graceMs < MIN_GRACE_MS || graceMs > MAX_GRACE_MS) {
    throw new Error(`${metricId}.${contractName} grace must be between 200 and 400 ms.`);
  }
  if (targetMs + graceMs !== hardCeilingMs) {
    throw new Error(`${metricId}.${contractName} hard ceiling must equal target plus grace.`);
  }
  return Object.freeze({ targetMs, graceMs, hardCeilingMs });
}

function loadPerformanceTimesContract(options = {}) {
  const contractPath = options.contractPath || DEFAULT_CONTRACT_PATH;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load performance timing contract: ${error?.message || error}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Performance timing contract must be an object keyed by metric ID.');
  }
  const validated = {};
  for (const [metricId, entry] of Object.entries(payload)) {
    if (!metricId.trim()) throw new Error('Performance timing metric ID must not be empty.');
    validated[metricId] = Object.freeze({
      local: validateTriplet(metricId, 'local', entry?.local),
      ci: validateTriplet(metricId, 'ci', entry?.ci),
    });
  }
  return Object.freeze(validated);
}

function resolvePerformanceContractName(options = {}) {
  const requestedContract = String(options.requestedContract || 'local').trim().toLowerCase();
  if (!CONTRACT_NAMES.has(requestedContract)) {
    throw new Error(`Unknown performance timing contract "${requestedContract}"; use local or ci.`);
  }
  if (requestedContract === 'ci' && options.trustedCi !== true) {
    throw new Error('The CI performance timing contract requires the trusted CI runner boundary.');
  }
  return requestedContract;
}

function resolveTimingBudget(metricId, contractName = 'local', contract = null) {
  const normalizedMetricId = String(metricId || '').trim();
  const normalizedContractName = String(contractName || '').trim().toLowerCase();
  if (!CONTRACT_NAMES.has(normalizedContractName)) {
    throw new Error(`Unknown performance timing contract "${normalizedContractName}"; use local or ci.`);
  }
  const authority = contract || loadPerformanceTimesContract();
  const entry = authority[normalizedMetricId] || authority[METRIC_ID_ALIASES[normalizedMetricId]];
  if (!entry) throw new Error(`Missing performance timing metric contract: ${normalizedMetricId}.`);
  const selected = entry[normalizedContractName];
  return {
    contractName: normalizedContractName,
    metricId: normalizedMetricId,
    targetMaximum: selected.targetMs,
    graceMs: selected.graceMs,
    hardCeiling: selected.hardCeilingMs,
  };
}

function listRequiredPerformanceTimingMetricIds(contract = null) {
  return Object.freeze(Object.keys(contract || loadPerformanceTimesContract()));
}

module.exports = {
  listRequiredPerformanceTimingMetricIds,
  loadPerformanceTimesContract,
  resolvePerformanceContractName,
  resolveTimingBudget,
};
