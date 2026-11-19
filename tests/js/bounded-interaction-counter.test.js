const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertPlateau,
  assertRequestOwnership,
  countedCollection,
  createInteractionCounter,
  measureScalePair,
} = require('./helpers/bounded-interaction-counter');

// Self-test contracts are measured against a registry that declares exactly them.
function selfRegisteredPair(contract) {
  const { id, small, large, budgets, growth } = contract;
  const registry = { interactions: [{ id, cardinalities: { small, production: large }, budgets, growth }] };
  return measureScalePair({ ...contract, registry });
}

test('scale pair enforces absolute and growth budgets', async () => {
  await assert.rejects(() => selfRegisteredPair({
    id: 'example',
    small: 20,
    large: 1000,
    run: async size => ({ itemsVisited: size }),
    budgets: { itemsVisited: 3 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
  }), /example: itemsVisited=1000 at cardinality 1000 exceeds budget 3[\s\S]*grew from 20 at 20 to 1000 at 1000/);
});

test('scale pair fails closed when a budgeted metric is not measured', async () => {
  await assert.rejects(() => selfRegisteredPair({
    id: 'unmeasured', small: 1, large: 2, run: async () => ({}), budgets: { requests: 1 },
  }), /requests was not measured/);
});

test('plateau ignores warm-up and rejects retained growth', () => {
  assert.throws(() => assertPlateau([2, 4, 6, 8, 10], {
    warmupSamples: 2, maxIncreaseAfterWarmup: 0,
  }), /retained growth of 4 after warm-up/);
  assert.equal(assertPlateau([2, 4, 6, 6, 6], { warmupSamples: 2 }), 0);
});

test('counter rejects unknown fields and counts collection reads', () => {
  const counter = createInteractionCounter();
  assert.throws(() => counter.count('nodes'), /unknown interaction counter nodes/);
  countedCollection([1, 2, 3], counter).forEach(() => {});
  assert.equal(counter.snapshot().itemsVisited, 3);
});

// Each historical mechanism below is reconstructed as a "before" implementation
// that the harness must reject and an "after" implementation it must accept.

function fakeRows(count, counter) {
  const rows = Array.from({ length: count }, (_, index) => ({
    path: `track-${index}`,
    selected: false,
    setSelected(value) {
      if (this.selected === value) return;
      this.selected = value;
      counter.count('domMutations');
    },
  }));
  return countedCollection(rows, counter);
}

const DragSelectionBefore = class {
  constructor(rows, counter) {
    this.rows = rows;
    this.counter = counter;
    this.selected = new Set();
  }
  move(fromIndex, toIndex) {
    this.selected = new Set();
    this.rows.forEach((row, index) => {
      if (index >= fromIndex && index <= toIndex) this.selected.add(row.path);
    });
    this.rows.forEach(row => row.setSelected(this.selected.has(row.path)));
    this.counter.count('outputEmissions');
  }
};

const DragSelectionAfter = class {
  constructor(rows, counter) {
    this.rows = rows;
    this.counter = counter;
    this.rangeEnd = null;
  }
  move(fromIndex, toIndex) {
    const previous = this.rangeEnd ?? fromIndex;
    const [low, high] = [Math.min(previous, toIndex), Math.max(previous, toIndex)];
    for (let index = low; index <= high; index += 1) this.rows[index].setSelected(index <= toIndex && index >= fromIndex);
    this.rangeEnd = toIndex;
  }
};

async function adjacentDrag(Controller, rowCount) {
  const counter = createInteractionCounter();
  const controller = new Controller(fakeRows(rowCount, counter), counter);
  controller.move(0, 1);
  return counter.measure(() => controller.move(0, 2));
}

const DRAG_CONTRACT = {
  id: 'BI-H01-loose-track-drag',
  small: 20,
  large: 1000,
  budgets: { itemsVisited: 3, domQueries: 0, domMutations: 2, outputEmissions: 0 },
  growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
};

test('BI-H01 rejects a drag move that rescans every row and accepts the delta repair', async () => {
  await assert.rejects(
    () => selfRegisteredPair({ ...DRAG_CONTRACT, run: rows => adjacentDrag(DragSelectionBefore, rows) }),
    /itemsVisited=2000 at cardinality 1000 exceeds budget 3/,
  );
  const { large } = await selfRegisteredPair({ ...DRAG_CONTRACT, run: rows => adjacentDrag(DragSelectionAfter, rows) });
  assert.deepEqual([large.itemsVisited, large.domMutations, large.outputEmissions], [2, 1, 0]);
});

function renderNavigation(rows, counter, windowSize) {
  const visible = windowSize === undefined ? rows : rows.slice(0, windowSize);
  for (const row of visible) {
    counter.count('nodesCreated');
    if (row.artwork) counter.count('nodesCreated');
  }
  counter.count('renderCommits');
  return counter.snapshot();
}

test('BI-H03 rejects eager Problematic Files navigation rendering and accepts a window', async () => {
  const rows = count => Array.from({ length: count }, (_, index) => ({ key: index, artwork: true }));
  const contract = {
    id: 'BI-H03-problematic-files-window', small: 50, large: 706,
    budgets: { nodesCreated: 120, renderCommits: 1 },
    growth: { metric: 'nodesCreated', largeMinusSmallMax: 20 },
  };
  await assert.rejects(
    () => selfRegisteredPair({ ...contract, run: async count => renderNavigation(rows(count), createInteractionCounter()) }),
    /nodesCreated=1412 at cardinality 706 exceeds budget 120/,
  );
  await selfRegisteredPair({ ...contract, run: async count => renderNavigation(rows(count), createInteractionCounter(), 60) });
});

function pollStatus({ unchangedPolls, compareRevision }) {
  const counter = createInteractionCounter();
  let shownRevision = 0;
  for (let poll = 0; poll < unchangedPolls; poll += 1) {
    counter.count('requests');
    const status = { revision: 7, loader: 'idle' };
    if (compareRevision && status.revision === shownRevision) continue;
    shownRevision = status.revision;
    counter.count('domMutations');
    counter.count('renderCommits');
  }
  return counter.snapshot();
}

test('BI-H13 rejects presentation work on unchanged polls and accepts revision comparison', async () => {
  const contract = {
    id: 'BI-H13-unchanged-status-poll', small: 1, large: 100,
    budgets: { renderCommits: 1, domMutations: 1 },
    growth: { metric: 'renderCommits', largeMinusSmallMax: 0 },
  };
  await assert.rejects(
    () => selfRegisteredPair({ ...contract, run: async polls => pollStatus({ unchangedPolls: polls, compareRevision: false }) }),
    /renderCommits=100 at cardinality 100 exceeds budget 1/,
  );
  await selfRegisteredPair({ ...contract, run: async polls => pollStatus({ unchangedPolls: polls, compareRevision: true }) });
});

function navigateGallery(cycles, evictDetached) {
  const cache = new Map();
  const retained = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const card = { id: cycle % 12, ancestors: [{ detached: true, cycle }] };
    if (evictDetached) cache.set(card.id, card);
    else cache.set(`${card.id}:${cycle}`, card);
    retained.push(cache.size);
  }
  return retained;
}

test('BI-H12 rejects card caches that retain detached cards and accepts bounded eviction', () => {
  assert.throws(() => assertPlateau(navigateGallery(100, false), { warmupSamples: 10, label: 'BI-H12 gallery cards' }), /retained growth of 89/);
  assert.equal(assertPlateau(navigateGallery(100, true), { warmupSamples: 12, label: 'BI-H12 gallery cards' }), 0);
});

// Selected-artist loading: the scoped request already carries loose tracks; the
// historical defect repeated a broader request during post-render hydration.
function openSelectedArtist({ repeatBroaderHydration }) {
  const counter = createInteractionCounter();
  counter.count('requests');
  if (repeatBroaderHydration) counter.count('requests');
  return counter.snapshot();
}

test('BI-H07 rejects a repeated broader selected-artist hydration request', async () => {
  const contract = { id: 'BI-H07-selected-artist', small: 20, large: 14000, budgets: { requests: 1 } };
  await assert.rejects(
    () => selfRegisteredPair({ ...contract, run: async () => openSelectedArtist({ repeatBroaderHydration: true }) }),
    /requests=2 at cardinality 20 exceeds budget 1/,
  );
  await selfRegisteredPair({ ...contract, run: async () => openSelectedArtist({ repeatBroaderHydration: false }) });
});

test('BI-H17 request capture rejects Home routed through generic view-data', () => {
  const homeOwnership = { allowed: ['/home-data'], forbidden: ['/view-data'] };
  assert.throws(
    () => assertRequestOwnership(['/view-data?surface=home'], homeOwnership, 'BI-H17 Home'),
    /BI-H17 Home: \/view-data outside owned endpoints \/home-data/,
  );
  assertRequestOwnership(['/home-data?omit_sidebar=1'], homeOwnership, 'BI-H17 Home');
});

// Custom Collections navigation: the tree summary depended on the full Loose
// Tracks payload instead of a compact per-collection summary.
function openCollectionsNavigation(trackCount, { compactSummary }) {
  const counter = createInteractionCounter();
  const collections = Array.from({ length: 100 }, (_, index) => ({ name: `Collection ${index}`, count: 3 }));
  const tracks = Array.from({ length: trackCount }, (_, index) => ({ path: `track-${index}.flac`, collection: `Collection ${index % 100}` }));
  const payload = compactSummary ? { collections } : { tracks };
  counter.count('requests');
  counter.count('responseRows', compactSummary ? collections.length : tracks.length);
  counter.count('responseBytes', JSON.stringify(payload).length);
  return counter.snapshot();
}

test('BI-H02 rejects navigation summaries that scale with library tracks', async () => {
  const contract = {
    id: 'BI-H02-custom-collection-summary', small: 20, large: 160000,
    budgets: { requests: 1, responseRows: 100, responseBytes: 2000 + 160 * 100 },
    growth: { metric: 'responseBytes', largeMinusSmallMax: 0 },
  };
  await assert.rejects(
    () => selfRegisteredPair({ ...contract, run: async count => openCollectionsNavigation(count, { compactSummary: false }) }),
    /responseRows=160000 at cardinality 160000 exceeds budget 100/,
  );
  await selfRegisteredPair({ ...contract, run: async count => openCollectionsNavigation(count, { compactSummary: true }) });
});

const REGISTERED = {
  interactions: [{
    id: 'js:runtime/example.js#install',
    proof: 'contract',
    cardinalities: { small: 20, production: 1000 },
    budgets: { itemsVisited: 3 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
  }],
};
const registeredPair = overrides => measureScalePair({
  id: 'js:runtime/example.js#install',
  small: 20,
  large: 1000,
  run: async () => ({ itemsVisited: 2 }),
  budgets: { itemsVisited: 3 },
  growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
  registry: REGISTERED,
  ...overrides,
});

test('a scale pair under a registry id must measure exactly the registered contract', async () => {
  await registeredPair({});
  await assert.rejects(() => registeredPair({ large: 500 }), /large 500 differs from the registry's 1000/);
  await assert.rejects(() => registeredPair({ small: 10 }), /small 10 differs from the registry's 20/);
  await assert.rejects(() => registeredPair({ budgets: { itemsVisited: 30 } }), /budgets .* differs from the registry's/);
  await assert.rejects(() => registeredPair({ growth: { metric: 'itemsVisited', largeMinusSmallMax: 5 } }), /growth .* differs from the registry's/);
  await assert.rejects(() => registeredPair({ growth: undefined }), /growth undefined differs/);
});

test('a scale pair under an unregistered id is rejected', async () => {
  await assert.rejects(() => registeredPair({ id: 'example', large: 500, budgets: { itemsVisited: 30 } }), /example: measured id is not a registered interaction/);
  await assert.rejects(() => measureScalePair({
    id: 'js:runtime/helper.js#helper', small: 1, large: 2, run: async () => ({ requests: 0 }), budgets: { requests: 1 },
  }), /js:runtime\/helper\.js#helper: measured id is not a registered interaction/);
});

test('scale pairs are checked against the checked-in registry by default', async () => {
  const { loadRegistry } = require('../../scripts/ci/validate-bounded-interactions.cjs');
  const contract = loadRegistry().interactions.find(entry => entry.proof === 'contract');
  await assert.rejects(() => measureScalePair({
    id: contract.id,
    small: contract.cardinalities.small,
    large: contract.cardinalities.production + 1,
    run: async () => ({}),
    budgets: contract.budgets,
    growth: contract.growth,
  }), /large \d+ differs from the registry's \d+/);
});

test('under the gate a checked-in measurement records the test that measured it', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const { loadRegistry } = require('../../scripts/ci/validate-bounded-interactions.cjs');
  const contract = loadRegistry().interactions.find(entry => entry.proof === 'contract' && entry.id.startsWith('js:') && !entry.requestOwnership);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-evidence-'));
  try {
    const helpers = path.join(__dirname, 'helpers');
    const evidence = path.join(scratch, 'evidence.jsonl');
    const probe = path.join(scratch, 'probe.test.js');
    fs.writeFileSync(probe, `
      const test = require('node:test');
      const { measureScalePair } = require(${JSON.stringify(path.join(helpers, 'bounded-interaction-counter.js'))});
      const contract = ${JSON.stringify(contract)};
      const zero = Object.fromEntries(Object.keys(contract.budgets).map(metric => [metric, 0]));
      test('probe measures its contract', () => measureScalePair({
        id: contract.id, small: contract.cardinalities.small, large: contract.cardinalities.production,
        run: async () => zero, budgets: contract.budgets, growth: contract.growth,
      }));
      test('probe measures a self-registered contract', () => measureScalePair({
        id: 'self', small: 1, large: 2, run: async () => ({ requests: 0 }), budgets: { requests: 0 },
        registry: { interactions: [{ id: 'self', cardinalities: { small: 1, production: 2 }, budgets: { requests: 0 } }] },
      }));
    `);
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const result = spawnSync(process.execPath, [
      '--test', '--require', path.join(helpers, 'bounded-interaction-evidence.js'), probe,
    ], { env: { ...env, BOUNDED_INTERACTION_EVIDENCE: evidence }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = fs.readFileSync(evidence, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(lines, [{ id: contract.id, test: 'probe measures its contract' }]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
