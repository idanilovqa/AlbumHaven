'use strict';

// Preloaded by the bounded-interaction gate (`node --require`) into every test
// process: remembers the name of the running test so a measured contract can
// record which test measured it. Tests run one at a time within a file.

const EVIDENCE_ENV = 'BOUNDED_INTERACTION_EVIDENCE';
let current = null;

function currentTestName() {
  return current;
}

if (process.env[EVIDENCE_ENV]) {
  const { beforeEach } = require('node:test');
  beforeEach((context) => { current = context.name; });
}

module.exports = { EVIDENCE_ENV, currentTestName };
