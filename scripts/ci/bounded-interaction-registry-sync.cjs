'use strict';

// Keeps tests/ci/bounded-interactions.json aligned with discovery without
// discarding reviewed entries: newly discovered entrypoints join their owner's
// entry (or a new static entry), stale entrypoints are removed, and nothing an
// author wrote (proof, budgets, contracts, endpoint ownership) is rewritten.
// New entries are proposals; the validator still decides whether they hold.

const { HIGH_FREQUENCY_EVENTS, normalizeEndpoint } = require('./bounded-interaction-discovery.cjs');

const WORK_CLASS_ORDER = ['constant', 'delta', 'page', 'selected-set', 'affected-set', 'background-batch'];
const KIND_LABELS = { event: 'listeners', timer: 'timers', request: 'requests', observer: 'observers', worker: 'workers' };

function groupId(item) {
  const prefix = item.language === 'javascript' ? 'js' : 'py';
  return `${prefix}:${item.path.replace(/^music_app\/(static\/js\/)?/, '')}#${item.owner}`;
}

function workClassFor(item) {
  if (item.language === 'javascript') {
    return item.kind === 'event' && HIGH_FREQUENCY_EVENTS.has(item.trigger) ? 'delta' : 'constant';
  }
  if (item.kind === 'route') return item.trigger.startsWith('GET ') ? 'page' : 'affected-set';
  if (['watcher', 'reconciler'].includes(item.kind)) return 'affected-set';
  return 'background-batch';
}

function rulesFor(item) {
  if (item.language === 'javascript') {
    if (item.kind === 'event') return HIGH_FREQUENCY_EVENTS.has(item.trigger) ? ['BI-01'] : ['BI-03'];
    if (item.kind === 'timer') return item.trigger === 'setInterval' ? ['BI-12'] : ['BI-03'];
    if (item.kind === 'request') return ['BI-03', 'BI-13'];
    return ['BI-09'];
  }
  if (item.kind === 'route') return item.trigger.startsWith('GET ') ? ['BI-04', 'BI-13'] : ['BI-04', 'BI-14'];
  if (['watcher', 'reconciler'].includes(item.kind)) return ['BI-07', 'BI-14'];
  return ['BI-07', 'BI-08'];
}

function actionFor(items) {
  if (items[0].language === 'python') {
    const routes = items.filter(item => item.kind === 'route').map(item => item.trigger);
    return routes.length ? `Serve ${routes.join(', ')}` : `Run ${items[0].kind} ${items[0].owner}`;
  }
  const byKind = new Map();
  for (const item of items) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, new Set());
    byKind.get(item.kind).add(item.trigger);
  }
  const parts = [...byKind].map(([kind, triggers]) => `${[...triggers].join('/')} ${KIND_LABELS[kind] || kind}`);
  return `${parts.join(', ')} installed by ${items[0].owner}`;
}

function proposeEntry(id, items) {
  const entry = {
    id,
    action: actionFor(items),
    entrypoints: items.map(item => item.key).sort(),
    owners: [...new Set(items.map(item => item.path))].sort(),
    rules: [...new Set(items.flatMap(rulesFor))].sort(),
    workClass: items.map(workClassFor).sort((a, b) => WORK_CLASS_ORDER.indexOf(b) - WORK_CLASS_ORDER.indexOf(a))[0],
    proof: 'static',
  };
  const literals = items.flatMap(item => item.targets || []).filter(target => target.target);
  if (literals.length) {
    entry.requestOwnership = {
      allowed: [...new Set(literals.map(target => normalizeEndpoint(target.target)))].sort(),
      forbidden: [],
    };
  }
  return entry;
}

// Returns the synchronized registry plus a summary of what changed.
function syncRegistry(registry, entrypoints) {
  const discovered = new Set(entrypoints.map(item => item.key));
  const registered = new Set();
  const removed = [];
  const interactions = [];
  for (const entry of registry.interactions || []) {
    const kept = entry.entrypoints.filter(key => discovered.has(key));
    removed.push(...entry.entrypoints.filter(key => !discovered.has(key)));
    if (!kept.length) continue;
    kept.forEach(key => registered.add(key));
    interactions.push({ ...entry, entrypoints: kept });
  }
  const byId = new Map(interactions.map(entry => [entry.id, entry]));
  const pending = new Map();
  for (const item of entrypoints.filter(candidate => !registered.has(candidate.key))) {
    const id = groupId(item);
    if (!pending.has(id)) pending.set(id, []);
    pending.get(id).push(item);
  }
  const added = [];
  for (const [id, items] of pending) {
    const existing = byId.get(id);
    added.push(...items.map(item => item.key));
    if (!existing) {
      const entry = proposeEntry(id, items);
      interactions.push(entry);
      byId.set(id, entry);
      continue;
    }
    // Joining an existing entry never widens its reviewed endpoint ownership:
    // a new request target must still be accepted by the author.
    existing.entrypoints = [...existing.entrypoints, ...items.map(item => item.key)].sort();
    existing.owners = [...new Set([...existing.owners, ...items.map(item => item.path)])].sort();
    existing.rules = [...new Set([...existing.rules, ...items.flatMap(rulesFor)])].sort();
  }
  interactions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { registry: { ...registry, interactions }, added: added.sort(), removed: removed.sort() };
}

module.exports = { proposeEntry, syncRegistry };
