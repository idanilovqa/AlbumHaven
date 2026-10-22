'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('../native-home-harness.cjs');
const {nativeEnvironment, drain} = require('./actual-native-runtime.cjs');

// Add the whole canonical native menu and anchoring owners to the existing real
// native form/controller fixture. Only platform registration accounting changes.
function actualChoiceEnvironment(options = {}) {
  const env = nativeEnvironment(options), {context, document} = env;
  const permanent = [], originalWindowAdd = context.addEventListener, originalDocumentAdd = document.addEventListener;
  context.addEventListener = function (type, callback, capture = false) {
    permanent.push({target: context, type, callback, capture});
    return originalWindowAdd.call(this, type, callback, capture);
  };
  document.addEventListener = function (type, callback, options = false) {
    permanent.push({target: document, type, callback, capture: options});
    return originalDocumentAdd.call(this, type, callback, options);
  };
  try {
    for (const file of ['trigger-anchor.js', 'library-settings.js']) {
      vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`), context, {filename: file});
    }
  } finally {
    context.addEventListener = originalWindowAdd;
    document.addEventListener = originalDocumentAdd;
  }
  const actualChoice = env.owner('openUtilityChoiceDropdown');
  assert.equal(typeof actualChoice, 'function', 'canonical native Choice owner is loaded');
  env.runtime.openChoice = (trigger, options) => actualChoice(trigger, options);
  let cleaned = false;
  function cleanupChoiceGlobals() {
    if (cleaned) return; cleaned = true;
    // These are fixture-lifetime global registrations installed by the full
    // canonical anchoring script, not per-dialog/menu listeners under test.
    for (const {target, type, callback, capture} of permanent) target.removeEventListener(type, callback, capture);
  }
  return {...env, cleanupChoiceGlobals,
    assertClean() {cleanupChoiceGlobals(); env.assertClean();},
  };
}
// Give node:test a turn to surface any unhandled rejection from a page callback;
// no unhandledRejection listener is installed and no failure is swallowed.
async function settle() {await drain(); await new Promise(resolve => setImmediate(resolve)); await drain();}
module.exports = {actualChoiceEnvironment, settle};
