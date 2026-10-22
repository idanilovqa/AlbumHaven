'use strict';
// Test-only composition. The unchanged actual-runtime fixture loads all product
// owners from candidate ROOT. No copied native/form/navigation implementation.
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {ROOT, fixture: actualRuntime, deferred, drain} = require('./search-native-fixtures/actual-runtime.cjs');
const {installCommentPlatform} = require('./sample-browser-platform.cjs');

function observe(promise) {
  const result = {state: 'pending', settlements: 0};
  Promise.resolve(promise).then(value => {
    result.state = 'resolved'; result.value = value; result.settlements++;
  }, error => {result.state = 'rejected'; result.error = error; result.settlements++;});
  return result;
}

async function fixture(t) {
  const underlyingCleanup = [], cleanups = [], dialogs = [], held = [];
  let h;
  t.after(async () => {
    try {
      for (const gate of held) gate.resolve();
      for (const dialog of dialogs) dialog.dispose();
      await drain();
    } finally {
      for (const cleanup of cleanups.reverse()) cleanup();
      for (const cleanup of underlyingCleanup) await cleanup();
    }
  });
  h = actualRuntime({after(cleanup) {underlyingCleanup.push(cleanup);}}, {
    url: 'https://albumhaven.test/?surface=album_tops',
    beforeRuntimePlatform({c, document}) {installCommentPlatform(c, document);},
  });
  const runtime = h.owner('AlbumTopsRuntime');
  assert.equal(runtime, h.c.AlbumHavenAlbumTopsRuntime, 'use actual candidate Top runtime');
  const host = h.document.createElement('section');
  host.id = 'album-tops-root'; h.main.append(host);
  h.state.view = {surface: {active: 'album_tops'}};
  h.state.ui.pendingViewTransition = false;
  assert.equal(runtime.sync().visible, true);

  // Browser DOM/input only. Actual presentMobileAppFormPage, page descriptor,
  // retirement, history writes and cleanup all remain the candidate owners.
  h.c.innerWidth = 390;
  for (const [tag, id] of [
    ['header', 'mobile-page-header'], ['div', 'mobile-page-outlet'],
    ['button', 'mobile-back-button'], ['button', 'mobile-library-button'],
    ['h2', 'mobile-page-title'], ['p', 'mobile-page-summary'],
    ['div', 'mobile-settings-actions'], ['button', 'mobile-settings-button'],
  ]) {
    const node = h.document.createElement(tag); node.id = id; h.main.append(node);
  }
  h.history.replaceState({albumHavenNavigationPosition: 0}, '', h.location.href);
  const historyTraversals = [], originalGo = h.history.go;
  h.history.go = function (...args) {
    historyTraversals.push(args);
    return originalGo.apply(this, args);
  };
  cleanups.push(() => {h.history.go = originalGo;});

  // Transparent recording boundary: same options, availability predicate,
  // return value and actual frozen native handle. Never fabricate a handle.
  const acquired = [], originalOpen = h.c.openReactFormDialog;
  assert.equal(typeof originalOpen, 'function');
  h.c.openReactFormDialog = function (...args) {
    try {
      const native = originalOpen.apply(this, args);
      acquired.push({args, native});
      return native;
    } catch (error) {
      acquired.push({args, error}); // Record the first opening exception, then preserve it.
      throw error;
    }
  };
  cleanups.push(() => {h.c.openReactFormDialog = originalOpen;});

  const retirements = [], originalRetire = h.c.retireMobileAppFormPage;
  let nextHold = null;
  assert.equal(typeof originalRetire, 'function');
  h.c.retireMobileAppFormPage = function (...args) {
    const gate = nextHold; nextHold = null;
    // Run every genuine retirement effect FIRST. Only its completion is gated.
    // A hidden modal, removed descriptor or wrapper dispose is not settlement.
    const result = originalRetire.apply(this, args);
    retirements.push({args, result, gate});
    return gate ? Promise.resolve(result).then(value => gate.promise.then(() => value)) : result;
  };
  cleanups.push(() => {h.c.retireMobileAppFormPage = originalRetire;});
  const hold = () => {
    assert.equal(nextHold, null);
    nextHold = deferred(); held.push(nextHold); return nextHold;
  };
  const {openNativeDialog} = await import(pathToFileURL(path.join(ROOT,
    'music_app/static/js/home-friends/native-dialog.mjs')).href);
  const page = () => h.c.getActiveAppFormPage();
  const modal = () => h.document.getElementById('app-form-modal');
  const content = () => h.document.getElementById('app-form-content');
  const open = ({initial = {}, callbacks = {}} = {}) => {
    const trace = [], physical = [], logical = [], errors = [];
    let mounts = 0, childDisposals = 0, input;
    const index = acquired.length;
    const dialog = openNativeDialog(runtime, {
      title: 'Sample retained native observer', pageId: 'sample-native-observer', ...initial,
    }, {
      mount(node, close) {
        mounts++;
        input = h.document.createElement('input'); input.value = 'Retained native value';
        node.append(input);
        const child = callbacks.mount?.(node, close);
        return {dispose() {childDisposals++; trace.push('child-disposed'); child?.dispose?.();}};
      },
      onError(error, close) {errors.push(error); trace.push('error'); callbacks.onError?.(error, close);},
      onClose(value) {logical.push(value); trace.push('logical'); callbacks.onClose?.(value);},
      onNativeSettlement(value) {
        physical.push(value); trace.push('physical'); callbacks.onNativeSettlement?.(value);
      },
    });
    dialogs.push(dialog);
    assert.deepEqual(Object.keys(dialog).sort(), ['close', 'closed', 'dispose', 'element', 'failed', 'update'],
      'optional observer and native suspension do not expand the consumer wrapper API');
    const native = acquired[index]?.native;
    const owner = native ? page() : null;
    const originalPromise = native?.promise;
    const promise = native ? observe(originalPromise) : null;
    if (native) {
      assert.equal(Object.isFrozen(native), true);
      assert.equal(owner.promise, originalPromise, 'recorded handle retains the actual original form promise');
      const descriptor = h.owner('mobilePageState').pages.find(row => row.formToken === owner.token);
      assert.ok(descriptor, 'actual mobile presentation admitted the real form descriptor');
    }
    return {dialog, native, owner, originalPromise, promise, trace, physical, logical, errors,
      acquisitionError: acquired[index]?.error,
      get input() {return input;}, get mounts() {return mounts;}, get childDisposals() {return childDisposals;}};
  };
  return {...h, runtime, page, modal, content, open, hold, retirements, historyTraversals};
}

function suspension(form, {retire = false} = {}) {
  assert.ifError(form.acquisitionError);
  assert.ifError(form.errors[0]);
  assert.equal(form.errors.length, 0, 'native admission has no swallowed opening error');
  assert.ok(form.native, 'actual native handle must be acquired before suspension');
  assert.ok(form.owner, 'actual mobile form owner must be acquired before suspension');
  assert.equal(typeof form.native.suspendPresentation, 'function', 'actual candidate handle owns suspension');
  const lease = form.native.suspendPresentation();
  assert.ok(lease && typeof lease.restore === 'function' && typeof lease.retire === 'function');
  assert.equal(form.native.promise, form.originalPromise);
  assert.equal(form.owner.isActive(), true, 'suspension does not relinquish sole-form admission');
  if (retire) {lease.retire(); assert.equal(lease.restore(), false, 'retired presentation cannot restore');}
  return lease;
}

function settlement(value, status, current, restoreFocusRequested) {
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(Object.keys(value).sort(), ['current', 'restoreFocusRequested', 'status']);
  assert.equal(value.status, status); assert.equal(value.current, current);
  assert.equal(value.restoreFocusRequested, restoreFocusRequested);
}

// Bounded caller inputs to the EXISTING public native dismiss(reason, options)
// API. These are operation identity/currentness inputs, not a replacement form,
// Search controller, return classifier or synthetic native settlement owner.
function operation() {
  let current = true;
  const identity = Object.freeze({nonce: Object.freeze({}), sessionId: 'sample-observer-session',
    scope: 'sample-observer-scope', intentRevision: 1, isCurrent: () => current});
  return {identity, retire() {current = false;}, options(onDismissOutcome) {
    return {dismissalOperation: {identity, nonce: identity.nonce, sessionId: identity.sessionId},
      isCurrent: identity.isCurrent, onDismissOutcome,
      searchReplacement: {operation: identity, nonce: identity.nonce, scope: identity.scope,
        intentRevision: identity.intentRevision, isCurrent: identity.isCurrent},
      restoreFocus: false, returnToParent: false};
  }};
}

function dismissal(value, form, op, status, reason) {
  assert.deepEqual(Object.keys(value).sort(), ['formToken', 'nonce', 'operation', 'reason', 'status']);
  assert.equal(value.operation, op.identity); assert.equal(value.nonce, op.identity.nonce);
  assert.equal(value.formToken, form.owner.token);
  assert.equal(value.status, status); assert.equal(value.reason, reason);
}

module.exports = {fixture, deferred, observe, suspension, settlement, operation, dismissal};
