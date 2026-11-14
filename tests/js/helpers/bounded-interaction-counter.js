'use strict';

const { endpointMatches, normalizeEndpoint } = require('../../../scripts/ci/validate-bounded-interactions.cjs');

// Deterministic operation counters for bounded-interaction contracts. Tests
// pass instrumented collaborators into the code under test; nothing here
// patches browser globals.

const COUNTER_FIELDS = Object.freeze([
  'itemsVisited', 'domQueries', 'nodesCreated', 'domMutations', 'nodesRetained',
  'renderCommits', 'markupBytes', 'requests', 'responseRows', 'responseBytes',
  'outputEmissions', 'listeners', 'timers', 'animationFrames', 'observers',
  'workers', 'subscriptions', 'staleCompletions',
]);

function createInteractionCounter() {
  const counts = Object.fromEntries(COUNTER_FIELDS.map(field => [field, 0]));
  return {
    count(field, amount = 1) {
      if (!Object.hasOwn(counts, field)) throw new Error(`unknown interaction counter ${field}`);
      counts[field] += amount;
    },
    snapshot() {
      return { ...counts };
    },
    // Counts only the work performed by `action` (after any warm-up).
    async measure(action) {
      const before = { ...counts };
      await action();
      return Object.fromEntries(COUNTER_FIELDS.map(field => [field, counts[field] - before[field]]));
    },
  };
}

// Counts every element read (index access and iteration) of an array, so the
// real traversal performed by code under test is measured, not assumed.
function countedCollection(items, counter, field = 'itemsVisited') {
  return new Proxy(items, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property) && Number(property) < target.length) counter.count(field);
      return Reflect.get(target, property, receiver);
    },
  });
}

function formatViolation(id, metric, cardinality, value, budget) {
  return `${id}: ${metric}=${value} at cardinality ${cardinality} exceeds budget ${budget}`;
}

// Runs one interaction at a small and a production cardinality, then enforces
// both the absolute budgets and the allowed growth between the two runs.
async function measureScalePair({ id = 'interaction', small, large, run, budgets, growth }) {
  if (!(Number.isInteger(small) && Number.isInteger(large) && large > small && small > 0)) {
    throw new Error(`${id}: scale pair needs integer cardinalities with large > small > 0`);
  }
  const results = { small: await run(small), large: await run(large) };
  const violations = [];
  for (const [metric, budget] of Object.entries(budgets || {})) {
    for (const [label, cardinality] of [['small', small], ['large', large]]) {
      const value = results[label]?.[metric];
      if (typeof value !== 'number') violations.push(`${id}: ${metric} was not measured at cardinality ${cardinality}`);
      else if (value > budget) violations.push(formatViolation(id, metric, cardinality, value, budget));
    }
  }
  if (growth) {
    const smallValue = results.small?.[growth.metric];
    const largeValue = results.large?.[growth.metric];
    if (typeof smallValue !== 'number' || typeof largeValue !== 'number') {
      violations.push(`${id}: growth metric ${growth.metric} was not measured`);
    } else if (largeValue - smallValue > growth.largeMinusSmallMax) {
      violations.push(
        `${id}: ${growth.metric} grew from ${smallValue} at ${small} to ${largeValue} at ${large}; `
        + `allowed growth ${growth.largeMinusSmallMax}`,
      );
    }
  }
  if (violations.length) throw new Error(violations.join('\n'));
  return results;
}

// Retained resources must stop growing once warm-up is over.
function assertPlateau(samples, { warmupSamples = 0, maxIncreaseAfterWarmup = 0, label = 'retained resources' } = {}) {
  if (!Array.isArray(samples) || samples.length <= warmupSamples + 1) {
    throw new Error(`${label}: plateau needs more samples than the ${warmupSamples}-sample warm-up`);
  }
  const settled = samples.slice(warmupSamples);
  const increase = Math.max(...settled) - settled[0];
  if (increase > maxIncreaseAfterWarmup) {
    throw new Error(
      `${label}: retained growth of ${increase} after warm-up (samples ${settled.join(', ')}); `
      + `allowed ${maxIncreaseAfterWarmup}`,
    );
  }
  return increase;
}

// Every captured request must hit a declared endpoint owner and never a
// forbidden generic endpoint (for example Home through /view-data).
function assertRequestOwnership(urls, { allowed, forbidden = [] }, label = 'requests') {
  const violations = urls.filter(url => (
    !allowed.some(pattern => endpointMatches(url, pattern))
    || forbidden.some(pattern => endpointMatches(url, pattern))
  ));
  if (violations.length) {
    throw new Error(`${label}: ${violations.map(normalizeEndpoint).join(', ')} outside owned endpoints ${allowed.join(', ')}`);
  }
}

module.exports = {
  COUNTER_FIELDS,
  assertPlateau,
  assertRequestOwnership,
  countedCollection,
  createInteractionCounter,
  measureScalePair,
};
