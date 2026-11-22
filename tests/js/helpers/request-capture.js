'use strict';

const path = require('node:path');
const {
  REQUEST_PASSES, assertRequestOwnership, createInteractionCounter, measureScalePair,
} = require('./bounded-interaction-counter');

const registry = require(path.join(__dirname, '..', '..', 'ci', 'bounded-interactions.json'));

// Request-capture contracts for bounded interactions whose request targets are
// computed at runtime. Tests run the real owner code with this recording fetch
// and check every captured URL against the registry entry's requestOwnership.

function requestUrl(input) {
  return typeof input === 'string' ? input : String(input?.url ?? input);
}

// `respond(url, options)` returns the response (or a promise of one) for each
// recorded request; `counter` counts one `requests` unit per call.
function createRequestCapture(respond) {
  const counter = createInteractionCounter();
  const requests = [];
  return {
    counter,
    requests,
    urls: () => requests.map(request => request.url),
    fetch(input, options = {}) {
      const url = requestUrl(input);
      counter.count('requests');
      requests.push({ url, options });
      return respond(url, options);
    },
  };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone: () => jsonResponse(body, { status }),
  };
}

function contractEntry(id) {
  const entry = registry.interactions.find(item => item.id === id);
  if (entry?.proof !== 'contract' || !entry.requestOwnership) {
    throw new Error(`${id} is not a registered request-capture contract`);
  }
  return entry;
}

// Asserts the captured URLs against the registered contract, so the test and
// the registry entry cannot drift apart.
function assertInteractionRequests(id, urls) {
  assertRequestOwnership(urls, contractEntry(id).requestOwnership, id);
}

// A captured request is a URL string (a GET) or `{ url, method }`.
const capturedUrl = request => (typeof request === 'string' ? request : request.url);
const isGet = request => typeof request === 'string' || !request.method || request.method.toUpperCase() === 'GET';

function getCounts(requests) {
  const counts = new Map();
  for (const url of requests.filter(isGet).map(capturedUrl)) counts.set(url, (counts.get(url) || 0) + 1);
  return counts;
}

// The repeated-request rule: performed again in the state the first pass left,
// an interaction may not send more requests than the first time, nor send an
// identical GET more than once unless the first pass sent it as often (a
// leaked listener or a lost in-flight guard shows up as such a duplicate).
function repeatedRequestViolations(id, first, second) {
  const violations = [];
  if (second.length > first.length) {
    violations.push(`${id}: the repeated interaction fanned out from ${first.length} to ${second.length} requests`);
  }
  const before = getCounts(first);
  for (const [url, count] of getCounts(second)) {
    if (count > 1 && count > (before.get(url) || 0)) {
      violations.push(`${id}: the repeated interaction sent GET ${url} ${count} times, the first pass ${before.get(url) || 0}`);
    }
  }
  return violations;
}

// Measures a request-capture contract at the registered small and production
// cardinalities and enforces the registered budgets and growth. At each
// cardinality `setup(cardinality)` builds the state once and the helper runs
// `act(context, pass)` twice in it: pass 1 is measured against the budgets,
// pass 2 must obey the repeated-request rule, and both must stay on the
// entry's owned endpoints. `act` returns `{ requests, metrics }`: the requests
// it sent and any other budgeted metrics; `requests` is measured as their count,
// and a counted `metrics.requests` must agree with it.
function measureInteractionContract(id, { setup, act }) {
  const { cardinalities, budgets, growth, requestOwnership } = contractEntry(id);
  const pass = async (context, number) => {
    const { requests, metrics = {} } = await act(context, number) || {};
    if (!Array.isArray(requests)) throw new Error(`${id}: pass ${number} did not return the requests it sent`);
    if (metrics.requests !== undefined && metrics.requests !== requests.length) {
      throw new Error(`${id}: pass ${number} counted ${metrics.requests} requests but returned ${requests.length}`);
    }
    assertRequestOwnership(requests.map(capturedUrl), requestOwnership, id);
    return { requests, metrics: { ...metrics, requests: requests.length } };
  };
  const run = async (cardinality) => {
    const context = await setup(cardinality);
    const first = await pass(context, 1);
    const second = await pass(context, 2);
    const violations = repeatedRequestViolations(id, first.requests, second.requests);
    if (violations.length) throw new Error(violations.join('\n'));
    return first.metrics;
  };
  return measureScalePair({
    id, small: cardinalities.small, large: cardinalities.production, run, budgets, growth, requestPasses: REQUEST_PASSES,
  });
}

module.exports = {
  assertInteractionRequests,
  createRequestCapture,
  jsonResponse,
  measureInteractionContract,
  repeatedRequestViolations,
};
