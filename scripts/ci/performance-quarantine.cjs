'use strict';

// A quarantined performance case stays registered in tests/ci/performance-targets.json, so the
// registry counts never move, but it does not run. Its `quarantine` entry names the pull request
// that owes the fix; that pull request makes the case pass with its budgets unchanged and deletes
// the entry. Budgets are never raised to leave quarantine.
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'tests', 'ci', 'performance-targets.json');
const QUARANTINE_FIELDS = Object.freeze({
  reason: /\S/,
  owner: /^#\d+$/,
  failedRun: /^\d+$/,
  since: /^\d{4}-\d{2}-\d{2}$/,
});

function quarantineProblems(quarantine) {
  if (!quarantine || typeof quarantine !== 'object' || Array.isArray(quarantine)) {
    return ['quarantine must be an object'];
  }
  return Object.entries(QUARANTINE_FIELDS)
    .filter(([field, pattern]) => typeof quarantine[field] !== 'string' || !pattern.test(quarantine[field]))
    .map(([field]) => `quarantine.${field} is missing or malformed`);
}

function readPerformanceRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function listRegisteredCases(registry = readPerformanceRegistry()) {
  return (registry?.targets || []).flatMap((target) => (target.cases || []).map((entry) => Object.freeze({
    target: target.name,
    test: entry.test,
    case: entry.case,
    quarantine: entry.quarantine || null,
  })));
}

function listQuarantinedCases(registry = readPerformanceRegistry()) {
  return listRegisteredCases(registry).filter((entry) => entry.quarantine);
}

function describeQuarantine({ quarantine }) {
  return `Quarantined since ${quarantine.since} until ${quarantine.owner} makes it pass with unchanged budgets `
    + `(failed run ${quarantine.failedRun}): ${quarantine.reason}`;
}

module.exports = {
  QUARANTINE_FIELDS,
  describeQuarantine,
  listQuarantinedCases,
  listRegisteredCases,
  quarantineProblems,
};
