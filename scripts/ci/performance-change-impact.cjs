const { PERFORMANCE_SHARDS } = require('./resolve-ci-shard.cjs');

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function patternRegex(pattern) {
  const escaped = normalizePath(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('**', '\0').replaceAll('*', '[^/]*').replaceAll('\0', '.*')}$`);
}

function matchesPattern(filePath, pattern) {
  return patternRegex(pattern).test(normalizePath(filePath));
}

function validatePerformanceChangeImpact(contract, knownTargets) {
  const errors = [];
  if (contract?.schemaVersion !== 1) errors.push('performance change-impact schemaVersion must be 1');
  const targets = new Set(knownTargets || []);
  const rules = Array.isArray(contract?.rules) ? contract.rules : [];
  const requiredPaths = Array.isArray(contract?.requiredPaths) ? contract.requiredPaths : [];
  if (!rules.length) errors.push('performance change-impact contract must define rules');
  for (const [index, rule] of rules.entries()) {
    if (!Array.isArray(rule?.paths) || !rule.paths.length) errors.push(`performance change-impact rule ${index} must define paths`);
    if (!Array.isArray(rule?.targets) || !rule.targets.length) errors.push(`performance change-impact rule ${index} must define targets`);
    for (const pattern of rule?.paths || []) {
      const normalized = normalizePath(pattern);
      if (!normalized || normalized.startsWith('/') || normalized.startsWith('../') || normalized.includes('/../')) {
        errors.push(`invalid repository path pattern: ${pattern}`);
      }
    }
    for (const target of rule?.targets || []) {
      if (!targets.has(target)) errors.push(`unknown performance target ${target}`);
    }
  }
  for (const requiredPath of requiredPaths) {
    if (!rules.some((rule) => (rule.paths || []).some((pattern) => matchesPattern(requiredPath, pattern)))) {
      errors.push(`sensitive path ${requiredPath} has no performance target mapping`);
    }
  }
  return errors;
}

function resolveRequiredPerformanceTargets(contract, changedPaths) {
  const selected = [];
  const seen = new Set();
  for (const rule of contract?.rules || []) {
    const matched = (changedPaths || []).some((filePath) => (
      (rule.paths || []).some((pattern) => matchesPattern(filePath, pattern))
    ));
    if (!matched) continue;
    for (const target of rule.targets || []) {
      if (!seen.has(target)) {
        seen.add(target);
        selected.push(target);
      }
    }
  }
  return selected;
}

function applyPerformanceChangeImpact(pipeline, changedPaths, contract) {
  if (pipeline.pipelineMode !== 'focused-e2e') return pipeline;
  const focusedPerformanceTargets = [...(pipeline.focusedPerformanceTargets || [])];
  for (const target of resolveRequiredPerformanceTargets(contract, changedPaths)) {
    if (!focusedPerformanceTargets.includes(target)) focusedPerformanceTargets.push(target);
  }
  const selected = new Set(focusedPerformanceTargets);
  const focusedPerformanceShards = Object.entries(PERFORMANCE_SHARDS)
    .filter(([, config]) => config.targets.some((target) => selected.has(target)))
    .map(([shard]) => shard);
  return { ...pipeline, focusedPerformanceTargets, focusedPerformanceShards };
}

module.exports = {
  applyPerformanceChangeImpact,
  matchesPattern,
  resolveRequiredPerformanceTargets,
  validatePerformanceChangeImpact,
};
