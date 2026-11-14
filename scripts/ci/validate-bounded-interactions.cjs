#!/usr/bin/env node
'use strict';

// Fail-closed validator for tests/ci/bounded-interactions.json.
//
// Every discovered frontend/backend entrypoint must be registered exactly once.
// An entry proves boundedness either statically (no hazard reachable from any
// of its entrypoints) or with a deterministic runtime contract. Rejected
// hazards (direct broad work in a high-frequency handler, a dedicated surface
// routed through a generic endpoint, direct filesystem enumeration in a route,
// or a route reaching a registered library-scale operation) fail regardless of
// registration. There is no exemption mechanism.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { analyzeJavaScriptRepository, normalizeEndpoint } = require('./bounded-interaction-discovery.cjs');
const { syncRegistry } = require('./bounded-interaction-registry-sync.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = 'tests/ci/bounded-interactions.json';
const WORK_CLASSES = ['constant', 'delta', 'page', 'selected-set', 'affected-set', 'background-batch'];
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'allowedWorkClasses', 'libraryScaleOperations', 'interactions']);
const INTERACTION_KEYS = new Set([
  'id', 'action', 'entrypoints', 'owners', 'rules', 'workClass', 'proof', 'requestOwnership',
  'cardinalities', 'budgets', 'growth', 'command', 'testIdentity', 'performanceTargets', 'rollback',
]);
const REQUIRED_KEYS = ['id', 'action', 'entrypoints', 'owners', 'rules', 'workClass', 'proof'];
const CONTRACT_KEYS = ['cardinalities', 'budgets', 'growth', 'command', 'testIdentity', 'rollback'];
const EXEMPTION_WORDS = ['allowlist', 'baseline', 'waiver', 'grandfathered', 'skip', 'disabled', 'exempt'];
const RULE_PATTERN = /^BI-(0[1-9]|1[0-4])$/;

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function endpointMatches(endpoint, pattern) {
  const escaped = normalizeEndpoint(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]+');
  return new RegExp(`^${escaped}$`).test(normalizeEndpoint(endpoint));
}

function loadRegistry(root = REPO_ROOT, registryPath = REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(path.join(root, registryPath), 'utf8'));
}

async function analyzePython(root, registry, overrides) {
  const args = ['scripts/ci/bounded_interaction_discovery.py', '--root', root, '--analysis'];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-interactions-'));
  try {
    const registryFile = path.join(scratch, 'registry.json');
    fs.writeFileSync(registryFile, JSON.stringify(registry));
    args.push('--registry', registryFile);
    if (overrides && Object.keys(overrides).length) {
      const overridesFile = path.join(scratch, 'overrides.json');
      fs.writeFileSync(overridesFile, JSON.stringify(overrides));
      args.push('--overrides', overridesFile);
    }
    const child = spawn(process.env.PYTHON || 'python', args, { cwd: REPO_ROOT, windowsHide: true });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const [status, signal] = await once(child, 'close');
    if (status !== 0) throw new Error(`python discovery failed (${signal || status}): ${Buffer.concat(stderr)}`);
    return JSON.parse(Buffer.concat(stdout).toString('utf8'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Discovery for both languages. Python runs in a child process while the
// JavaScript inventory is built. Replacement sources keyed by repository path
// let the guard's seeded-defect suite inject defects without touching files.
async function discoverRepository({ root = REPO_ROOT, registry, jsOverrides = {}, pyOverrides = {} } = {}) {
  const python = analyzePython(root, registry, pyOverrides);
  const js = analyzeJavaScriptRepository(root, jsOverrides);
  const py = await python;
  return {
    entrypoints: [...js.entrypoints, ...py.entrypoints],
    hazards: [...js.hazards, ...py.hazards],
  };
}

function findExemptionKeys(value, trail = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findExemptionKeys(item, `${trail}[${index}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (EXEMPTION_WORDS.some(word => key.toLowerCase().includes(word))) found.push(`${trail}.${key}`);
      findExemptionKeys(child, `${trail}.${key}`, found);
    }
  }
  return found;
}

function commandTestFiles(command) {
  return String(command || '').split(/\s+/)
    .map(token => normalizePath(token.split('::')[0]))
    .filter(token => /^tests\/.+\.(js|cjs|py)$/.test(token));
}

function validateSchema(registry, { fileExists, readFile }) {
  const errors = [];
  if (registry?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  for (const key of Object.keys(registry || {})) if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown top-level key ${key}`);
  if (JSON.stringify(registry?.allowedWorkClasses) !== JSON.stringify(WORK_CLASSES)) {
    errors.push(`allowedWorkClasses must be exactly ${WORK_CLASSES.join(', ')}`);
  }
  for (const trail of findExemptionKeys(registry)) errors.push(`exemption field is not allowed: ${trail}`);
  for (const [index, operation] of (registry?.libraryScaleOperations || []).entries()) {
    const match = /^py:([^#]+)#(.+)$/.exec(String(operation?.operation || ''));
    if (!match) errors.push(`libraryScaleOperations[${index}] must name py:<path>#<function>`);
    else if (!fileExists(match[1])) errors.push(`libraryScaleOperations[${index}] source ${match[1]} does not exist`);
    if (!String(operation?.reason || '').trim()) errors.push(`libraryScaleOperations[${index}] must give a reason`);
  }
  const ids = new Set();
  for (const [index, entry] of (registry?.interactions || []).entries()) {
    const label = entry?.id || `interactions[${index}]`;
    for (const key of Object.keys(entry || {})) if (!INTERACTION_KEYS.has(key)) errors.push(`${label}: unknown key ${key}`);
    for (const key of REQUIRED_KEYS) if (entry?.[key] === undefined) errors.push(`${label}: missing ${key}`);
    if (ids.has(entry?.id)) errors.push(`${label}: duplicate id`);
    ids.add(entry?.id);
    if (!WORK_CLASSES.includes(entry?.workClass)) errors.push(`${label}: unsupported work class ${entry?.workClass}`);
    if (!Array.isArray(entry?.rules) || !entry.rules.length || entry.rules.some(rule => !RULE_PATTERN.test(rule))) {
      errors.push(`${label}: rules must be a nonempty list of BI-01..BI-14`);
    }
    if (!Array.isArray(entry?.entrypoints) || !entry.entrypoints.length) errors.push(`${label}: entrypoints must be nonempty`);
    if (!Array.isArray(entry?.owners) || !entry.owners.length) errors.push(`${label}: owners must be nonempty`);
    for (const owner of entry?.owners || []) {
      if (normalizePath(owner) !== owner) errors.push(`${label}: owner ${owner} must be a normalized repository path`);
      else if (!fileExists(owner)) errors.push(`${label}: owner ${owner} does not exist`);
    }
    for (const key of entry?.entrypoints || []) {
      const ownerPath = /^(?:js|py):([^#]+)#/.exec(key)?.[1];
      if (ownerPath && !(entry.owners || []).includes(ownerPath)) errors.push(`${label}: entrypoint ${key} is outside its owners`);
    }
    const ownership = entry?.requestOwnership;
    if (ownership !== undefined) {
      if (!Array.isArray(ownership.allowed) || !Array.isArray(ownership.forbidden)) {
        errors.push(`${label}: requestOwnership needs allowed and forbidden lists`);
      } else {
        for (const endpoint of [...ownership.allowed, ...ownership.forbidden]) {
          if (!String(endpoint).startsWith('/') || String(endpoint).includes('?')) errors.push(`${label}: endpoint ${endpoint} must be a path without query`);
        }
      }
    }
    if (entry?.proof === 'static') {
      for (const key of CONTRACT_KEYS) {
        if (key !== 'rollback' && entry[key] !== undefined) errors.push(`${label}: static proof must not declare ${key}`);
      }
    } else if (entry?.proof === 'contract') {
      for (const key of CONTRACT_KEYS) if (entry[key] === undefined) errors.push(`${label}: contract proof needs ${key}`);
      const { small, production } = entry.cardinalities || {};
      if (!(Number.isInteger(small) && small > 0 && Number.isInteger(production) && production > small)) {
        errors.push(`${label}: cardinalities need positive integers with production > small`);
      }
      const budgets = entry.budgets || {};
      if (!Object.keys(budgets).length) errors.push(`${label}: budgets must be nonempty`);
      for (const [metric, value] of Object.entries(budgets)) {
        if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) errors.push(`${label}: budget ${metric} must be a nonnegative number`);
      }
      if (!Object.hasOwn(budgets, entry.growth?.metric)) errors.push(`${label}: growth metric must be a budgeted metric`);
      if (!(Number.isFinite(entry.growth?.largeMinusSmallMax) && entry.growth.largeMinusSmallMax >= 0)) {
        errors.push(`${label}: growth.largeMinusSmallMax must be a nonnegative number`);
      }
      const testFiles = commandTestFiles(entry.command);
      if (!testFiles.length) errors.push(`${label}: command must name a test file`);
      const missing = testFiles.filter(file => !fileExists(file));
      for (const file of missing) errors.push(`${label}: command test file ${file} does not exist`);
      if (!missing.length && testFiles.length && !testFiles.some(file => readFile(file).includes(entry.testIdentity))) {
        errors.push(`${label}: test identity "${entry.testIdentity}" is not defined in ${testFiles.join(', ')}`);
      }
    } else {
      errors.push(`${label}: proof must be "static" or "contract"`);
    }
  }
  return errors;
}

function validateInventory(registry, discovery) {
  const errors = [];
  const discovered = new Map(discovery.entrypoints.map(item => [item.key, item]));
  const registeredBy = new Map();
  for (const entry of registry.interactions || []) {
    for (const key of entry.entrypoints || []) {
      if (registeredBy.has(key)) errors.push(`entrypoint ${key} is registered by both ${registeredBy.get(key).id} and ${entry.id}`);
      else registeredBy.set(key, entry);
      if (!discovered.has(key)) errors.push(`${entry.id}: stale entrypoint ${key} is no longer discovered`);
    }
  }
  for (const key of discovered.keys()) {
    if (!registeredBy.has(key)) errors.push(`unregistered entrypoint ${key}`);
  }
  for (const hazard of discovery.hazards.filter(item => item.reject)) {
    const via = hazard.via?.length ? ` via ${hazard.via.join(' > ')}` : '';
    errors.push(`rejected ${hazard.rule} ${hazard.operation} at ${hazard.path}:${hazard.line} from ${hazard.entrypoint}${via}`);
  }
  const hazardsByEntrypoint = new Map();
  for (const hazard of discovery.hazards.filter(item => !item.reject)) {
    if (!hazardsByEntrypoint.has(hazard.entrypoint)) hazardsByEntrypoint.set(hazard.entrypoint, []);
    hazardsByEntrypoint.get(hazard.entrypoint).push(hazard);
  }
  for (const entry of registry.interactions || []) {
    const hazards = (entry.entrypoints || []).flatMap(key => hazardsByEntrypoint.get(key) || []);
    if (entry.proof === 'static' && hazards.length) {
      const sample = hazards.slice(0, 3).map(hazard => `${hazard.operation} at ${hazard.path}:${hazard.line}`).join('; ');
      errors.push(`${entry.id}: ${hazards.length} reachable hazard(s) need a runtime contract (${sample})`);
    }
    if (entry.proof === 'contract') {
      for (const file of new Set(hazards.map(hazard => hazard.path))) {
        if (!entry.owners.includes(file)) errors.push(`${entry.id}: hazard owner ${file} must be listed in owners`);
      }
    }
    for (const key of entry.entrypoints || []) {
      const found = discovered.get(key);
      if (found?.kind !== 'request') continue;
      for (const { target, line } of found.targets) {
        if (target == null) {
          if (entry.proof !== 'contract') errors.push(`${entry.id}: dynamic request target at ${found.path}:${line} needs a request-capture contract`);
          continue;
        }
        const ownership = entry.requestOwnership;
        if (!ownership?.allowed?.length) {
          errors.push(`${entry.id}: request ${key} needs requestOwnership.allowed`);
        } else if (!ownership.allowed.some(pattern => endpointMatches(target, pattern))) {
          errors.push(`${entry.id}: request target ${normalizeEndpoint(target)} is not an allowed endpoint`);
        } else if (ownership.forbidden.some(pattern => endpointMatches(target, pattern))) {
          errors.push(`${entry.id}: request target ${normalizeEndpoint(target)} is forbidden`);
        }
      }
    }
  }
  return errors;
}

async function validateRepository({ root = REPO_ROOT, registry = loadRegistry(root), jsOverrides, pyOverrides } = {}) {
  const fileExists = file => fs.existsSync(path.join(root, file));
  const readFile = file => fs.readFileSync(path.join(root, file), 'utf8');
  const schemaErrors = validateSchema(registry, { fileExists, readFile });
  if (schemaErrors.length) return { errors: schemaErrors, discovery: null };
  const discovery = await discoverRepository({ root, registry, jsOverrides, pyOverrides });
  return { errors: validateInventory(registry, discovery), discovery };
}

function interactionsForPaths(registry, changedPaths) {
  const changed = new Set((changedPaths || []).map(normalizePath));
  return (registry.interactions || [])
    .filter(entry => entry.proof === 'contract' && entry.owners.some(owner => changed.has(owner)))
    .map(entry => entry.id);
}

async function main(argv = process.argv.slice(2)) {
  const registry = loadRegistry();
  if (argv.includes('--sync')) {
    const discovery = await discoverRepository({ registry });
    const synced = syncRegistry(registry, discovery.entrypoints);
    fs.writeFileSync(path.join(REPO_ROOT, REGISTRY_PATH), `${JSON.stringify(synced.registry, null, 2)}\n`);
    for (const key of synced.added) process.stdout.write(`registered ${key}\n`);
    for (const key of synced.removed) process.stdout.write(`removed stale ${key}\n`);
    process.stdout.write('review the registered entries, then validate without --sync\n');
    return 0;
  }
  if (argv.includes('--changed-paths')) {
    const file = argv[argv.indexOf('--changed-paths') + 1];
    const changed = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    process.stdout.write(`${interactionsForPaths(registry, changed).join('\n')}\n`);
    return 0;
  }
  const { errors, discovery } = await validateRepository({ registry });
  if (argv.includes('--list') && discovery) {
    for (const item of discovery.entrypoints) process.stdout.write(`${JSON.stringify(item)}\n`);
  }
  for (const error of [...errors].sort()) process.stderr.write(`${error}\n`);
  if (errors.length) {
    process.stderr.write(`bounded interaction validation failed with ${errors.length} error(s)\n`);
    return 1;
  }
  process.stdout.write(`bounded interaction registry valid: ${discovery.entrypoints.length} entrypoints, ${registry.interactions.length} interactions\n`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  WORK_CLASSES,
  discoverRepository,
  endpointMatches,
  interactionsForPaths,
  loadRegistry,
  normalizeEndpoint,
  validateInventory,
  validateRepository,
  validateSchema,
};
