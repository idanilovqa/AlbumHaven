#!/usr/bin/env node
'use strict';

// Fail-closed validator for tests/ci/bounded-interactions.json.
//
// Every discovered frontend/backend entrypoint must be registered exactly once.
// An entry proves boundedness either statically (no hazard reachable from any
// of its hot-path entrypoints) or with a deterministic runtime contract, which is rerun
// for a change to its owners or to any file hosting one of its hazards. Rejected
// hazards (direct broad work in a high-frequency handler, a dedicated surface
// routed through a generic endpoint, direct filesystem enumeration in a route,
// a route reaching a registered library-scale operation, blocking I/O on the
// ASGI event loop, a database connection opened per loop item in a route, or
// per-item I/O over the whole library state outside background-batch work)
// fail regardless of ordinary registration. The two source-bound cover records
// can become eligible for native proof; only the final trusted pipeline verdict
// can satisfy them. Raw rejects remain visible throughout.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const acorn = require('acorn');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { analyzeJavaScriptRepository, normalizeEndpoint } = require('./bounded-interaction-discovery.cjs');
const { syncRegistry } = require('./bounded-interaction-registry-sync.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = 'tests/ci/bounded-interactions.json';
const WORK_CLASSES = ['constant', 'delta', 'page', 'selected-set', 'affected-set', 'background-batch'];
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'allowedWorkClasses', 'libraryScaleOperations', 'libraryStateCollections', 'interactions', 'scopedCoverProofs']);
const INTERACTION_KEYS = new Set([
  'id', 'action', 'entrypoints', 'owners', 'rules', 'workClass', 'proof', 'requestOwnership',
  'cardinalities', 'budgets', 'growth', 'command', 'testIdentity', 'measures', 'performanceTargets', 'rollback',
]);
const REQUIRED_KEYS = ['id', 'action', 'entrypoints', 'owners', 'rules', 'workClass', 'proof'];
const CONTRACT_KEYS = ['cardinalities', 'budgets', 'growth', 'command', 'testIdentity', 'rollback'];
const EXEMPTION_WORDS = ['allowlist', 'baseline', 'waiver', 'grandfathered', 'skip', 'disabled', 'exempt'];
const RULE_PATTERN = /^BI-(0[1-9]|1[0-4])$/;

function normalizePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

// `/*`, `/*/*`, or `*`: a pattern with no literal segment owns every endpoint.
function isBareWildcard(pattern) {
  const segments = String(pattern).split('/').filter(Boolean);
  return segments.length > 0 && segments.every(segment => /^\*+$/.test(segment));
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
    pythonSemanticsFingerprint: py.pythonSemanticsFingerprint,
    pythonContractFingerprints: py.pythonContractFingerprints,
    connectionGraphs: py.connectionGraphs,
    coverConnectionContracts: py.coverConnectionContracts,
    entrypoints: [...js.entrypoints, ...py.entrypoints],
    hazards: [...js.hazards, ...py.hazards],
  };
}

const COVER_ENTRYPOINTS = [
  'py:music_app/routes/api_wave_d_asgi_routes.py#utilities_fetch_cover:route:POST /utilities/fetch-cover',
  'py:music_app/routes/api_wave_d_asgi_routes.py#utilities_fetch_covers_unsuccessful:route:POST /utilities/fetch-covers-unsuccessful',
];
const COVER_PROOF_KEYS = ['schemaVersion', 'id', 'entrypoint', 'rule', 'loopOwner', 'coverage', 'analyzerFingerprint', 'contractFingerprint', 'families'];
const SCAN_OWNER = 'py:music_app/services/scan_cache_persistence.py#';
const EXECUTION_OWNER = 'py:music_app/services/cover_refresh_execution.py#';
const POOL_OWNER = 'py:music_app/services/postgres_connections.py#';
const COVER_FAMILIES = [
  { id: 'cover-mutation-shared-transaction', operation: 'database-connect-per-item:psycopg.connect@music_app/services/cover_mutations_postgres.py',
    sinkOwner: 'py:music_app/services/cover_mutations_postgres.py#_default_connect',
    context: { connector: 'scan_cache_transaction', databaseScope: 'matching-config-url', workerContext: 'copy_context', lifetime: 'claimed-cover-run' },
    roles: { 'cache-injection': 'py:music_app/services/cache.py#execute_cover_mutation_for_config',
      'recovery-injection': `${EXECUTION_OWNER}_recover_existing_cover_selection`, 'automatic-injection': `${EXECUTION_OWNER}_build_automatic_cover_write_guard`,
      'matching-dsn': `${SCAN_OWNER}scan_cache_transaction`, 'run-scope': `${EXECUTION_OWNER}run_cover_jobs`,
      'copied-worker-context': `${EXECUTION_OWNER}_run_cover_jobs`, 'scope-cleanup': `${SCAN_OWNER}shared_scan_cache_connection` } },
  { id: 'shared-adapter-lazy-initializer', operation: 'database-connect-per-item:psycopg.connect@music_app/services/scan_cache_persistence.py',
    sinkOwner: `${SCAN_OWNER}_connect`, context: { binding: 'sealed-shared-connection-v1', databaseScope: 'matching-config-url', initializer: 'guarded-lazy', lifetime: 'claimed-cover-run' },
    roles: { 'sealed-constructor': `${SCAN_OWNER}shared_scan_cache_connection`, 'field-assignment': `${SCAN_OWNER}_SharedConnection.__init__`,
      'lazy-guard': `${SCAN_OWNER}_SharedConnection.transaction`, initializer: `${SCAN_OWNER}_SharedConnection.transaction`,
      'transaction-lock': `${SCAN_OWNER}_SharedConnection.transaction`, 'scope-cleanup': `${SCAN_OWNER}shared_scan_cache_connection` } },
  { id: 'cover-advisory-lock-pool-initializer', operation: 'database-connect-per-item:psycopg_pool.ConnectionPool@music_app/services/postgres_connections.py',
    sinkOwner: `${POOL_OWNER}cover_lock_connection`, context: { cacheKey: ['dedicated', 'database_url', 'cover-lock'], initializer: 'cache-miss-under-lock',
      lifetime: 'process-cache-until-close_pools', channels: 'existing-active-cover-worker-bound' },
    roles: Object.fromEntries(['cache-key', 'cache-lookup', 'cache-guard', 'initializer', 'cache-store', 'cache-lock', 'pool-cleanup']
      .map(role => [role, `${POOL_OWNER}${role === 'pool-cleanup' ? 'close_pools' : 'cover_lock_connection'}`])) },
];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'null').digest('hex');
const isFingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const structuralOperation = value => String(value).replace(/:\d+$/, '');

function scopedCoverProofErrors(registry) {
  const errors = [];
  if (registry.scopedCoverProofs === undefined) return errors;
  if (!Array.isArray(registry.scopedCoverProofs) || registry.scopedCoverProofs.length !== 2) return ['scopedCoverProofs must contain exactly the two reviewed cover entrypoints'];
  const seen = new Set();
  const ids = new Set();
  for (const record of registry.scopedCoverProofs) {
    const label = record?.id || 'scoped cover proof';
    if (typeof record?.id !== 'string' || !record.id.trim() || ids.has(record.id)) errors.push(`${label}: unique scoped cover proof id required`);
    ids.add(record?.id);
    if (!record || Object.keys(record).some(key => !COVER_PROOF_KEYS.includes(key)) || COVER_PROOF_KEYS.some(key => record[key] === undefined)) errors.push(`${label}: invalid scoped cover proof record`);
    if (record?.schemaVersion !== 3 || !COVER_ENTRYPOINTS.includes(record?.entrypoint) || seen.has(record?.entrypoint) || record?.rule !== 'BI-05' ||
        record?.loopOwner !== 'music_app/services/cover_refresh_execution.py#_run_cover_jobs') errors.push(`${label}: not an exact reviewed cover edge`);
    seen.add(record?.entrypoint);
    const families = record?.families;
    const coveredSinks = new Set();
    if (!Array.isArray(families) || families.length !== COVER_FAMILIES.length || new Set(families.map(family => family?.id)).size !== COVER_FAMILIES.length) {
      errors.push(`${label}: exactly three distinct reviewed cover families required`);
    } else for (const family of families) {
      const specification = COVER_FAMILIES.find(item => item.id === family?.id);
      if (!exactKeys(family, ['id', 'operation', 'sinkIds', 'contractId', 'contractFingerprint', 'context']) || !specification ||
          family.operation !== specification.operation || family.contractId !== `${specification.id}/v1` ||
          !isFingerprint(family.contractFingerprint) || digest(family.context) !== digest(specification.context) ||
          !Array.isArray(family.sinkIds) || !family.sinkIds.length || family.sinkIds.some(id => !isFingerprint(id))) {
        errors.push(`${label}: invalid exact cover family operation/context/contract`);
        continue;
      }
      for (const id of family.sinkIds) {
        if (coveredSinks.has(id)) errors.push(`${label}: cover family sink coverage overlaps`);
        coveredSinks.add(id);
      }
    }
    if (!isFingerprint(record?.analyzerFingerprint) || !isFingerprint(record?.contractFingerprint)) errors.push(`${label}: source-bound analyzer and contract fingerprints required`);
    const coverage = record?.coverage;
    if (!coverage || Object.keys(coverage).sort().join(',') !== 'edgeIds,graphFingerprint,nodeIds,root,sinkIds' ||
        !isFingerprint(coverage.graphFingerprint) || !isFingerprint(coverage.root) ||
        ['nodeIds', 'edgeIds', 'sinkIds'].some(key => !Array.isArray(coverage[key]) || !coverage[key].length ||
          coverage[key].some(id => !isFingerprint(id)) || new Set(coverage[key]).size !== coverage[key].length)) {
      errors.push(`${label}: complete duplicate-free semantic graph coverage required`);
    }
    if (Array.isArray(coverage?.sinkIds) && digest([...coveredSinks].sort()) !== digest([...coverage.sinkIds].sort())) errors.push(`${label}: cover families must partition every covered sink`);
  }
  return errors;
}

function scopedCoverFingerprints(registry, discovery, readFile = file => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')) {
  const semanticSource = file => JSON.parse(JSON.stringify(acorn.parse(readFile(file), { ecmaVersion: 'latest', sourceType: 'script' }),
    (key, value) => ['start', 'end', 'loc', 'raw'].includes(key) ? undefined : value));
  return {
    analyzerFingerprint: digest({ python: discovery.pythonSemanticsFingerprint, javascript: [
      semanticSource('scripts/ci/validate-bounded-interactions.cjs'), semanticSource('scripts/run-bounded-interactions.cjs'),
    ] }),
    contractFingerprint: digest({ registry: { ...registry, scopedCoverProofs: undefined }, pythonContracts: discovery.pythonContractFingerprints }),
  };
}

function connectionGraphFingerprint(graph) {
  const { fingerprint, ...semantic } = graph;
  const sorted = (items, key) => [...items].sort((left, right) => left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0);
  return digest({ ...semantic, nodes: sorted(graph.nodes, 'id'), edges: sorted(graph.edges, 'id'),
    sinks: sorted(graph.sinks, 'id'), sources: sorted(graph.sources, 'path') });
}

const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const validOwner = value => typeof value === 'string' && /^py:music_app\/[^#]+#.+$/.test(value) && !value.includes('..') && !value.includes('\\');
const validSite = value => exactKeys(value, ['owner', 'astPath']) && validOwner(value.owner) &&
  Array.isArray(value.astPath) && value.astPath.length > 0 && value.astPath.every(part =>
    typeof part === 'string' && /^[A-Za-z_]\w*$/.test(part) || Number.isInteger(part) && part >= 0);

function validConnectionGraph(graph) {
  if (!exactKeys(graph, ['schemaVersion', 'id', 'entrypoint', 'root', 'nodes', 'edges', 'sinks', 'sources', 'fingerprint']) ||
      graph.schemaVersion !== 1 || graph.id !== graph.entrypoint || !isFingerprint(graph.root) || !isFingerprint(graph.fingerprint) ||
      ['nodes', 'edges', 'sinks', 'sources'].some(key => !Array.isArray(graph[key]) || !graph[key].length)) return false;
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!exactKeys(node, ['id', 'owner', 'loop', 'scan', 'bound']) || !validOwner(node.owner) ||
        !(node.loop === null || validSite(node.loop)) ||
        !(node.scan === null || exactKeys(node.scan, ['collection', 'owner', 'astPath']) && typeof node.scan.collection === 'string' &&
          validSite({ owner: node.scan.owner, astPath: node.scan.astPath })) ||
        !(node.bound === null || Array.isArray(node.bound) && node.bound.every(name => typeof name === 'string') &&
          new Set(node.bound).size === node.bound.length && digest(node.bound) === digest([...node.bound].sort())) || nodes.has(node.id)) return false;
    const { id, ...state } = node;
    if (id !== digest(state)) return false;
    nodes.set(id, node);
  }
  if (!nodes.has(graph.root) || nodes.get(graph.root).owner !== graph.entrypoint.split(':route:')[0]) return false;
  const edges = new Set(), sinks = new Set(), adjacency = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (!exactKeys(edge, ['id', 'from', 'to', 'site']) || !nodes.has(edge.from) || !nodes.has(edge.to) ||
        !validSite(edge.site) || edge.site.owner !== nodes.get(edge.from).owner || edges.has(edge.id)) return false;
    const { id, ...state } = edge;
    if (id !== digest(state)) return false;
    edges.add(id);
    adjacency.get(edge.from).push(edge.to);
  }
  for (const sink of graph.sinks) {
    if (!exactKeys(sink, ['id', 'node', 'operation', 'site', 'loop']) || !nodes.has(sink.node) ||
        !validSite(sink.site) || !validSite(sink.loop) || sink.site.owner !== nodes.get(sink.node).owner ||
        typeof sink.operation !== 'string' || sinks.has(sink.id)) return false;
    const { id, ...state } = sink;
    if (id !== digest(state)) return false;
    sinks.add(id);
  }
  const sources = new Set();
  for (const source of graph.sources) {
    if (!exactKeys(source, ['path', 'astFingerprint']) || typeof source.path !== 'string' ||
        (!/^music_app\/.+\.py$/.test(source.path) && source.path !== 'scripts/run_jobs_worker.py') || source.path.includes('..') || source.path.includes('\\') ||
        !isFingerprint(source.astFingerprint) || sources.has(source.path)) return false;
    sources.add(source.path);
  }
  if (graph.nodes.some(node => !sources.has(node.owner.slice(3).split('#')[0]))) return false;
  const reached = new Set(), pending = [graph.root];
  while (pending.length) {
    const id = pending.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...adjacency.get(id));
  }
  return reached.size === nodes.size && graph.fingerprint === connectionGraphFingerprint(graph);
}

// This is structural eligibility only. Raw rejects remain in discovery, and
// the default validator still rejects eligible witnesses until native proof.
function coverFamilyProofErrors(record, graph, hazards, contracts) {
  const errors = [];
  if (!Array.isArray(record?.families) || record.families.length !== COVER_FAMILIES.length ||
      !Array.isArray(contracts) || contracts.length !== COVER_FAMILIES.length || !validConnectionGraph(graph)) return ['cover family source contracts or complete graph are missing'];
  const sourceHashes = new Map(graph.sources.map(source => [source.path, source.astFingerprint]));
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const sinks = new Map(graph.sinks.map(sink => [sink.id, sink]));
  const allCovered = new Set();
  const reachableWithout = excluded => {
    const adjacency = new Map(graph.nodes.map(node => [node.id, []]));
    for (const edge of graph.edges) if (!excluded.has(edge.id)) adjacency.get(edge.from).push(edge.to);
    const reached = new Set(), pending = [graph.root];
    while (pending.length) {
      const node = pending.pop();
      if (reached.has(node)) continue;
      reached.add(node);
      pending.push(...adjacency.get(node));
    }
    return reached;
  };
  for (const specification of COVER_FAMILIES) {
    const families = record.families.filter(family => family?.id === specification.id);
    if (families.length !== 1) { errors.push(`${specification.id}: exact family is missing or duplicated`); continue; }
    const family = families[0];
    const matches = contracts.filter(contract => contract?.id === `${specification.id}/v1`);
    if (matches.length !== 1) { errors.push(`${specification.id}: source guard contract is missing or duplicated`); continue; }
    const contract = matches[0];
    const { fingerprint, ...semantic } = contract;
    if (!exactKeys(family, ['id', 'operation', 'sinkIds', 'contractId', 'contractFingerprint', 'context']) ||
        !exactKeys(contract, ['schemaVersion', 'id', 'status', 'sources', 'anchors', 'fingerprint']) || contract.schemaVersion !== 1 ||
        contract.status !== 'matched' || fingerprint !== digest(semantic) || family.contractId !== contract.id || family.contractFingerprint !== fingerprint ||
        family.operation !== specification.operation || digest(family.context) !== digest(specification.context)) {
      errors.push(`${specification.id}: source guard or reviewed family identity does not match`);
      continue;
    }
    const sources = contract.sources;
    const anchors = contract.anchors;
    if (!Array.isArray(sources) || !sources.length || new Set(sources.map(source => source?.path)).size !== sources.length ||
        sources.some(source => !exactKeys(source, ['path', 'astFingerprint']) || !isFingerprint(source.astFingerprint) || sourceHashes.get(source.path) !== source.astFingerprint) ||
        !Array.isArray(anchors) || anchors.length !== Object.keys(specification.roles).length ||
        new Set(anchors.map(anchor => anchor?.role)).size !== anchors.length ||
        anchors.some(anchor => !exactKeys(anchor, ['role', 'site']) || !validSite(anchor.site) ||
          specification.roles[anchor.role] !== anchor.site.owner || !sources.some(source => source.path === anchor.site.owner.slice(3).split('#')[0]))) {
      errors.push(`${specification.id}: guard anchors/cleanup sources differ from the actual graph`);
      continue;
    }
    if (!Array.isArray(family.sinkIds) || !family.sinkIds.length || new Set(family.sinkIds).size !== family.sinkIds.length || family.sinkIds.some(id =>
      allCovered.has(id) || !sinks.has(id) || sinks.get(id).site.owner !== specification.sinkOwner ||
      `${sinks.get(id).operation}@${specification.sinkOwner.slice(3).split('#')[0]}` !== specification.operation)) {
      errors.push(`${specification.id}: sink is not an exact reviewed family operation/owner`);
      continue;
    }
    for (const id of family.sinkIds) allCovered.add(id);
    const initializer = anchors.find(anchor => anchor.role === 'initializer')?.site;
    if (specification.id === 'cover-advisory-lock-pool-initializer' && family.sinkIds.some(id => digest(sinks.get(id).site) !== digest(initializer))) {
      errors.push(`${specification.id}: sink bypasses the known cached initializer`);
    }
    if (specification.id === 'shared-adapter-lazy-initializer') {
      const edges = graph.edges.filter(edge => digest(edge.site) === digest(initializer) &&
        nodes.get(edge.from).owner === `${SCAN_OWNER}_SharedConnection.transaction` &&
        nodes.get(edge.to).owner === `${SCAN_OWNER}PostgresScanCacheAdapter._connect_to_database`);
      const reached = reachableWithout(new Set(edges.map(edge => edge.id)));
      if (!edges.length || family.sinkIds.some(id => reached.has(sinks.get(id).node))) errors.push(`${specification.id}: sink bypasses the sealed guarded initializer edge`);
    }
    if (specification.id === 'cover-mutation-shared-transaction') {
      const owners = new Set(anchors.filter(anchor => anchor.role.endsWith('-injection')).map(anchor => anchor.site.owner));
      const reached = reachableWithout(new Set(graph.edges.filter(edge => owners.has(nodes.get(edge.from).owner)).map(edge => edge.id)));
      if (family.sinkIds.some(id => reached.has(sinks.get(id).node))) errors.push(`${specification.id}: sink bypasses the known injected authority owner`);
    }
  }
  if (allCovered.size !== sinks.size || [...sinks.keys()].some(id => !allCovered.has(id)) ||
      hazards.some(hazard => !allCovered.has(hazard.sinkId) || !record.families.some(family =>
        family.sinkIds?.includes(hazard.sinkId) && structuralOperation(hazard.operation) === family.operation))) errors.push('cover families do not cover every exact raw rejecting sink');
  return errors;
}

function scopedCoverStatus(registry, discovery, fingerprints) {
  const records = Array.isArray(registry.scopedCoverProofs) ? registry.scopedCoverProofs : [];
  const states = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const hazards = discovery.hazards.filter(hazard => hazard.reject && hazard.entrypoint === record.entrypoint);
    const graphs = (Array.isArray(discovery.connectionGraphs) ? discovery.connectionGraphs : []).filter(graph => graph?.entrypoint === record.entrypoint);
    const graph = graphs[0];
    const sameIds = (actual, reviewed) => digest([...actual].sort()) === digest([...(reviewed || [])].sort());
    const matches = scopedCoverProofErrors(registry).length === 0 && record.analyzerFingerprint === fingerprints?.analyzerFingerprint &&
      record.contractFingerprint === fingerprints?.contractFingerprint && graphs.length === 1 && validConnectionGraph(graph) &&
      graph.fingerprint === record.coverage.graphFingerprint && graph.root === record.coverage.root &&
      sameIds(graph.nodes.map(node => node.id), record.coverage.nodeIds) &&
      sameIds(graph.edges.map(edge => edge.id), record.coverage.edgeIds) &&
      sameIds(graph.sinks.map(sink => sink.id), record.coverage.sinkIds) && hazards.length > 0 &&
      sameIds(new Set(hazards.map(hazard => hazard.sinkId)), graph.sinks.map(sink => sink.id)) &&
      graph.sinks.every(sink => sink.loop.owner === `py:${record.loopOwner}`) &&
      hazards.every(hazard => hazard.graphId === graph.id && hazard.rule === record.rule && `${hazard.path}#${hazard.function}` === record.loopOwner) &&
      coverFamilyProofErrors(record, graph, hazards, discovery.coverConnectionContracts).length === 0;
    states.push({ id: record.id, entrypoint: record.entrypoint, state: matches ? 'native-proof-pending' : 'rejected', hazards });
  }
  return states;
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

const escapeRegExp = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const JS_TEST_DECLARATION = /(?<![\w.$])(?:test|it|require\(\s*['"]node:test['"]\s*\))\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;

// A test identity names one real test: `def <name>(` in Python, or the exact
// name of a `test(...)`/`it(...)` declaration in JavaScript, where each hole of
// a template-literal name (a test declared in a loop) matches one expansion. A
// substring of a longer name, a comment, or a string elsewhere does not count.
function declaresTest(source, file, name) {
  if (file.endsWith('.py')) return new RegExp(`^[ \\t]*(?:async[ \\t]+)?def[ \\t]+${escapeRegExp(name)}[ \\t]*\\(`, 'm').test(source);
  for (const [, single, double, template] of source.matchAll(JS_TEST_DECLARATION)) {
    if (template === undefined ? (single ?? double) === name : new RegExp(`^${
      template.split(/\$\{[^}]*\}/).map(escapeRegExp).join('.+')
    }$`).test(name)) return true;
  }
  return false;
}

function validateSchema(registry, { fileExists, readFile }) {
  const errors = scopedCoverProofErrors(registry);
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
  for (const [index, item] of (registry?.libraryStateCollections || []).entries()) {
    if (!/^\w+$/.test(String(item?.collection || ''))) errors.push(`libraryStateCollections[${index}] must name a library_state key`);
    if (!String(item?.reason || '').trim()) errors.push(`libraryStateCollections[${index}] must give a reason`);
  }
  const ids = new Set();
  const contractIds = new Set((registry?.interactions || []).filter(entry => entry?.proof === 'contract').map(entry => entry.id));
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
          if (isBareWildcard(endpoint)) errors.push(`${label}: endpoint ${endpoint} is a bare wildcard; name the real endpoints`);
        }
      }
    }
    if (entry?.proof === 'static') {
      for (const key of [...CONTRACT_KEYS, 'measures']) {
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
      // Only the JavaScript request-capture helper repeats an interaction under the repeated-request rule.
      if (ownership !== undefined && testFiles.some(file => !file.endsWith('.js'))) {
        errors.push(`${label}: a request-capture contract must be a JavaScript test (measureInteractionContract)`);
      }
      const missing = testFiles.filter(file => !fileExists(file));
      for (const file of missing) errors.push(`${label}: command test file ${file} does not exist`);
      if (!missing.length && testFiles.length && !testFiles.some(file => declaresTest(readFile(file), file, entry.testIdentity))) {
        errors.push(`${label}: test identity "${entry.testIdentity}" is not defined in ${testFiles.join(', ')}`);
      }
      if (entry.measures !== undefined && !(Array.isArray(entry.measures) && entry.measures.length)) {
        errors.push(`${label}: measures must be a nonempty list of registered contract ids`);
      }
      for (const id of Array.isArray(entry.measures) ? entry.measures : []) {
        if (!contractIds.has(id)) errors.push(`${label}: measures ${id}, which is not a registered contract`);
      }
    } else {
      errors.push(`${label}: proof must be "static" or "contract"`);
    }
  }
  return errors;
}

function rejection(hazard) {
  const via = hazard.via?.length ? ` via ${hazard.via.join(' > ')}` : '';
  const witness = hazard.witness ? ` (${hazard.witness})` : '';
  return `rejected ${hazard.rule} ${hazard.operation}${witness} at ${hazard.path}:${hazard.line} from ${hazard.entrypoint}${via}`;
}

function validateInventory(registry, discovery, { nativeProofPreflight = false, nativeProofSatisfied = false, fingerprints } = {}) {
  const errors = [];
  const statuses = fingerprints && scopedCoverProofErrors(registry).length === 0 ? scopedCoverStatus(registry, discovery, fingerprints) : [];
  const eligible = new Set(statuses.filter(status => status.state === 'native-proof-pending').flatMap(status => status.hazards));
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
    if (eligible.has(hazard) && (nativeProofPreflight || nativeProofSatisfied)) continue;
    if (hazard.operation === 'unresolved-trigger') {
      errors.push(`unresolved-trigger at ${hazard.path}:${hazard.line}: discovery cannot resolve this listener's event name; `
        + 'make it a literal, a const, a constant list, or an object literal\'s keys so the listener can be registered');
      continue;
    }
    errors.push(rejection(hazard));
  }
  // Per-item filesystem, media or database work inside a scan of the whole
  // library state is library-sized I/O. In background work (a save task's
  // finalize, a watcher, a reconciler) only background-batch entries, library-wide
  // maintenance proven by their own contract, may do it; an affected-set or
  // narrower entry must first bound the scan by what it affects. A route or
  // middleware reaching it needs a contract like any reachable hazard.
  for (const hazard of discovery.hazards.filter(item => item.scanIo && !item.reject)) {
    const entry = registeredBy.get(hazard.entrypoint);
    const kind = discovered.get(hazard.entrypoint)?.kind;
    if (entry && !['route', 'middleware'].includes(kind) && entry.workClass !== 'background-batch') {
      errors.push(`${rejection(hazard)} (work class ${entry.workClass} cannot do per-item I/O over the whole library state)`);
    }
  }
  // Only hot-path hazards demand a contract. JavaScript discovery marks
  // hazards of one-shot events, one-shot timeouts, and request owners
  // `hot: false`; a hazard without the mark (every Python route and
  // background entrypoint) is always counted.
  const hazardsByEntrypoint = new Map();
  for (const hazard of discovery.hazards.filter(item => !item.reject && item.hot !== false)) {
    if (!hazardsByEntrypoint.has(hazard.entrypoint)) hazardsByEntrypoint.set(hazard.entrypoint, []);
    hazardsByEntrypoint.get(hazard.entrypoint).push(hazard);
  }
  for (const entry of registry.interactions || []) {
    const hazards = (entry.entrypoints || []).flatMap(key => hazardsByEntrypoint.get(key) || []);
    if (entry.proof === 'static' && hazards.length) {
      const sample = hazards.slice(0, 3).map(hazard => `${hazard.operation} at ${hazard.path}:${hazard.line}`).join('; ');
      errors.push(`${entry.id}: ${hazards.length} reachable hazard(s) need a runtime contract (${sample})`);
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

async function validateRepository({ root = REPO_ROOT, registry = loadRegistry(root), jsOverrides, pyOverrides, nativeProofPreflight = false, nativeProofSatisfied = false } = {}) {
  const fileExists = file => fs.existsSync(path.join(root, file));
  const readFile = file => fs.readFileSync(path.join(root, file), 'utf8');
  const schemaErrors = validateSchema(registry, { fileExists, readFile });
  if (schemaErrors.length) return { errors: schemaErrors, discovery: null };
  const discovery = await discoverRepository({ root, registry, jsOverrides, pyOverrides });
  const fingerprints = registry.scopedCoverProofs?.length ? scopedCoverFingerprints(registry, discovery, readFile) : undefined;
  const proofStates = registry.scopedCoverProofs?.length ? scopedCoverStatus(registry, discovery, fingerprints) : [];
  return { errors: validateInventory(registry, discovery, { nativeProofPreflight, nativeProofSatisfied, fingerprints }), discovery, proofStates, fingerprints };
}

// Contracts to rerun for a change: an entry is selected when a changed path is
// one of its owners or hosts any hazard reachable from its entrypoints, so a
// helper change reruns every contract that reaches it without listing helpers.
function interactionsForPaths(registry, changedPaths, discovery = { hazards: [] }) {
  const changed = new Set((changedPaths || []).map(normalizePath));
  const reached = new Set(discovery.hazards.filter(hazard => changed.has(hazard.path)).map(hazard => hazard.entrypoint));
  return (registry.interactions || [])
    .filter(entry => entry.proof === 'contract' && (
      entry.owners.some(owner => changed.has(owner)) || entry.entrypoints.some(key => reached.has(key))
    ))
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
    const discovery = await discoverRepository({ registry });
    process.stdout.write(`${interactionsForPaths(registry, changed, discovery).join('\n')}\n`);
    return 0;
  }
  const { errors, discovery, proofStates } = await validateRepository({ registry, nativeProofPreflight: argv.includes('--native-proof-preflight') });
  for (const state of proofStates || []) process.stdout.write(`${state.id}: raw BI-05 retained; ${state.state}\n`);
  if (argv.includes('--list') && discovery) {
    for (const item of discovery.entrypoints) process.stdout.write(`${JSON.stringify(item)}\n`);
  }
  for (const error of [...errors].sort()) process.stderr.write(`${error}\n`);
  if (errors.length) {
    process.stderr.write(`bounded interaction validation failed with ${errors.length} error(s)\n`);
    return 1;
  }
  process.stdout.write(`bounded interaction registry ${proofStates?.some(state => state.state === 'native-proof-pending') ? 'structurally eligible, native proof pending' : 'valid'}: ${discovery.entrypoints.length} entrypoints, ${registry.interactions.length} interactions\n`);
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
  isBareWildcard,
  loadRegistry,
  normalizeEndpoint,
  validateInventory,
  validateRepository,
  validateSchema,
  scopedCoverStatus,
  scopedCoverFingerprints,
  scopedCoverProofErrors,
  connectionGraphFingerprint,
  coverFamilyProofErrors,
};
