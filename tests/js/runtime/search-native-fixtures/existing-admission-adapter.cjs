'use strict';
// Compatibility names only: every production owner comes from the connected
// actual-runtime composition. No classifier, apply sink or renderer is replaced.
const assert = require('node:assert/strict');
const {fixture: connectedFixture, outcome} = require('./actual-runtime.cjs');
// Preserve the existing ordinary DTO helper, without invoking its old fixture.
const {browsePayload} = require('../album-tops-membership-fixtures/actual-request-fixture.cjs');

function fixture(t) {
  const h = connectedFixture(t), c = h.context, events = [];
  // The existing tests access context.state. This exposes the actual lexical
  // state object; it does not install another state or replace its owner.
  Object.defineProperty(c, 'state', {configurable: true, get: () => h.state});
  const renderOwner = c.renderView;
  c.renderView = function (...args) {
    const result = renderOwner.apply(this, args);
    events.push('paint');
    return result;
  };
  const respond = (index, payload, status = 200) => {
    assert.ok(h.requests[index], `Actual fetch ${index} was not dispatched`);
    h.requests[index].resolve({ok: status >= 200 && status < 300, status, json: async () => payload});
  };
  return {...h, events, respond,
    read: (url, options = {}) => h.read(url, {skipPendingViewTransition: true, ...options}, false),
    // Report precisely what the actual apply owner received. Raw private rows,
    // cursors and envelope fields are never relabelled as native applied state.
    get applied() {return h.applications.map(({args, result}) => ({payload: args[0], options: args[1], result}));},
  };
}
module.exports = {fixture, browsePayload, outcome};
