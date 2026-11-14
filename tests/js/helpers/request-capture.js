'use strict';

const path = require('node:path');
const { assertRequestOwnership, createInteractionCounter, measureScalePair } = require('./bounded-interaction-counter');

const registry = require(path.join(__dirname, '..', '..', 'ci', 'bounded-interactions.json'));

// Request-capture contracts for bounded interactions whose request targets are
// computed at runtime. Tests run the real owner code with this recording fetch
// and check every captured URL against the registry entry's requestOwnership.

function requestUrl(input) {
  return typeof input === 'string' ? input : String(input?.url ?? input);
}

// `respond(url, options, index)` returns the response (or a promise of one) for
// each recorded request; `counter` counts one `requests` unit per call.
function createRequestCapture(respond, counter = createInteractionCounter()) {
  const requests = [];
  return {
    counter,
    requests,
    urls: () => requests.map(request => request.url),
    fetch(input, options = {}) {
      const url = requestUrl(input);
      counter.count('requests');
      requests.push({ url, options, input });
      return respond(url, options, requests.length - 1, input);
    },
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone: () => jsonResponse(body, { status, headers }),
  };
  return response;
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

// Runs `run(cardinality)` at the registered small and production cardinalities
// and enforces the registered budgets and growth.
function measureInteractionContract(id, run) {
  const { cardinalities, budgets, growth } = contractEntry(id);
  return measureScalePair({ id, small: cardinalities.small, large: cardinalities.production, run, budgets, growth });
}

module.exports = {
  assertInteractionRequests,
  createRequestCapture,
  jsonResponse,
  measureInteractionContract,
};
