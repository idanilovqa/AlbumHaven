// Ordinary-request unit composition only. The protected original fixtures keep
// their transport, paint and final-apply seams; this is not private Search,
// authentication, HTTP, browser or database acceptance evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {URL, URLSearchParams} = require('node:url');

function installRequestClassification(context, runtimeRoot) {
  assert.ok(context && typeof context === 'object', 'An existing unit context is required');
  const filename = path.join(runtimeRoot, 'view-state-helpers.js');
  // Evaluate the complete current owner, unchanged. Its declarations do not run
  // browser work. Keeping this realm separate preserves each fixture's deliberate
  // URL builders, parsing, history and paint endpoints. The URL classifier keeps
  // its real owner-defined expression classifier through its lexical closure.
  const owner = vm.createContext({URL, URLSearchParams});
  vm.runInContext(fs.readFileSync(filename, 'utf8'), owner, {filename});
  assert.equal(typeof owner.isPrivateSearchExpression, 'function');
  assert.equal(typeof owner.isPrivateSearchRequestUrl, 'function');
  if (context.URL === undefined) context.URL = URL;
  if (context.URLSearchParams === undefined) context.URLSearchParams = URLSearchParams;
  context.isPrivateSearchExpression = owner.isPrivateSearchExpression;
  context.isPrivateSearchRequestUrl = owner.isPrivateSearchRequestUrl;
  return context;
}

// These are exact, audited default sink bodies in the original Loose and Top
// fixtures. Recognizing the whole method prevents a future changed/custom sink
// from acquiring an invented success result. They both assign their input itself.
const knownDefaultSinks = Object.freeze({
  loose: 'applyViewPayload(payload, options) {applied.push({payload, options}); state.view = payload;}',
  top: 'applyViewPayload(payload, options) {applied.push({payload, options}); c.state.view = payload;}',
});
const composedSinks = new WeakSet();

function composeDefaultSink(fixture, kind) {
  const context = fixture.context, sink = context.applyViewPayload;
  if (composedSinks.has(sink)) return;
  assert.equal(typeof sink, 'function', 'The original fixture must provide its known default sink');
  assert.equal(Function.prototype.toString.call(sink), knownDefaultSinks[kind],
    'The original default apply sink changed; review its assigned identity before composing it');
  const composed = function applyViewPayload(payload, ...args) {
    // Capture the identity assigned by this exact sink. Never read state.view
    // after the call: a later explicit test wrapper may install a successor.
    const assignedView = payload;
    Reflect.apply(sink, this, [payload, ...args]);
    return assignedView;
  };
  composedSinks.add(composed);
  context.applyViewPayload = composed;
}

function lazyFixtureModule(loadOriginal, factoryName, runtimeRoot, sinkKind) {
  let composedModule;
  return function getComposedModule() {
    if (composedModule) return composedModule;
    const original = loadOriginal();
    const originalFactory = original[factoryName];
    assert.equal(typeof originalFactory, 'function');
    composedModule = {...original, [factoryName](...args) {
      // All four audited factories return before their first browse/read. Wrap
      // their returned default once, after any protected save/load/restore work.
      const fixture = Reflect.apply(originalFactory, this, args);
      installRequestClassification(fixture.context, runtimeRoot(original));
      composeDefaultSink(fixture, sinkKind);
      return fixture;
    }};
    return composedModule;
  };
}

const looseRuntimeRoot = () => require('./loose-authority-harness.cjs').runtimeRoot;
const looseAuthority = lazyFixtureModule(
  () => require('./loose-authority-harness.cjs'), 'createLooseAuthorityFixture',
  original => original.runtimeRoot, 'loose');
const looseHistory = lazyFixtureModule(
  () => require('./loose-history-privacy-harness.cjs'), 'createHistoryFixture',
  looseRuntimeRoot, 'loose');
const looseRevocation = lazyFixtureModule(
  () => require('./loose-revocation-regression-harness.cjs'), 'fixture',
  looseRuntimeRoot, 'loose');
const topRequest = lazyFixtureModule(
  () => require('./album-tops-membership-fixtures/actual-request-fixture.cjs'), 'fixture',
  original => path.join(original.F.ROOT, 'music_app/static/js/runtime'), 'top');

module.exports = {installRequestClassification, looseAuthority, looseHistory, looseRevocation, topRequest};
