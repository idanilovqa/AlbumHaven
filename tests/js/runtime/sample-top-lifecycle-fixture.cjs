'use strict';
// Observation only. Actual runtime, source controller, native form and Settings
// owners are supplied by the unchanged independently composed integration fixture.
const assert = require('node:assert/strict');
const {topOwner, platform, A} = require('./sample-origin-integration-fixture.cjs');
const {observe} = require('./sample-origin-native-form-companion-fixture.cjs');
function watchHidden(t, node) {
  const own = Object.getOwnPropertyDescriptor(node, 'hidden'); let proto = node, descriptor;
  while (proto && !descriptor) {descriptor = Object.getOwnPropertyDescriptor(proto, 'hidden'); proto = Object.getPrototypeOf(proto);}
  assert.equal(typeof descriptor?.get, 'function'); assert.equal(typeof descriptor?.set, 'function');
  const writes = [];
  Object.defineProperty(node, 'hidden', {configurable: true, get() {return descriptor.get.call(this);},
    set(value) {descriptor.set.call(this, value); writes.push({value, hidden: descriptor.get.call(this)});}});
  t.after(() => {if (own) Object.defineProperty(node, 'hidden', own); else delete node.hidden;});
  return {writes, clear() {writes.length = 0;}, concealed() {assert.ok(writes.every(value => value.hidden === true), 'no transient old Top reveal, including reentrant physical cleanup');}};
}
function observeScope(t, h) {
  const counts = {top: 0, transport: 0, settings: 0};
  t.after(h.actual.subscribe(() => {counts.top++;}));
  t.after(h.owner('PrivateUITransport').subscribe(() => {counts.transport++;}));
  const query = h.nav.isCollectionDraftDeparturePending;
  assert.equal(typeof query, 'function');
  h.nav.isCollectionDraftDeparturePending = function (...args) {counts.settings++; return query.apply(this, args);};
  t.after(() => {h.nav.isCollectionDraftDeparturePending = query;});
  const hidden = watchHidden(t, h.topHost);
  return {counts, hidden, reset() {counts.top = 0; counts.transport = 0; counts.settings = 0; hidden.clear();},
    quiet() {assert.deepEqual(counts, {top: 0, transport: 0, settings: 0}); assert.deepEqual(hidden.writes, []);}};
}
function tapPresentation(t, h) {
  const open = h.runtime.openDraft, captured = [];
  h.runtime.openDraft = function (input) {
    const actual = input.presentation; assert.equal(typeof actual?.suspend, 'function');
    return open.call(this, {...input, presentation: {suspend(...args) {
      const handle = actual.suspend.apply(actual, args); captured.push({actual, handle, guard: input.isCurrent, token: input.token}); return handle;
    }}});
  };
  t.after(() => {h.runtime.openDraft = open;}); return captured;
}
const flags = root => ({hidden: root.hidden, inert: root.inert, aria: root.getAttribute('aria-hidden')});
function spent(h, old, root, current = null) {
  const before = flags(root), nodes = [...root.childNodes], focus = h.document.activeElement, history = [...h.history.traversals], drafts = h.calls.draft.length;
  assert.equal(old.handle.restore(), false); old.handle.retire(); old.handle.retire(); assert.ok(!old.actual.suspend());
  assert.deepEqual(flags(root), before); assert.deepEqual([...root.childNodes], nodes); assert.equal(h.document.activeElement, focus);
  assert.deepEqual(h.history.traversals, history); assert.equal(h.calls.draft.length, drafts);
  if (current) assert.equal(current.guard(), true);
}
async function detached(t, callback = () => {}) {
  const picker = {local_album_id: 11, album_ref: null, inventory_album_ref: 'inventory-album:5:11', title: 'Picked album', artist: 'Artist A', year: 2001};
  const h = await topOwner(t, {mode: 'detached', deferDetachedOpen: true, providers: {searchAlbums: async () => ({albums: [picker], next_cursor: null})}});
  assert.equal(h.owner('activeAppFormDialog'), null);
  const show = h.c.showAppFormDialog, trace = [], closes = [], closeStack = [];
  let armed = false, originalControls = null, nativePromise = null, closeOrder = 0;
  h.c.showAppFormDialog = function (options) {
    // Preserve the real shared helper and every original callback. Its actual
    // controls are observed, not replaced with a form/settlement implementation.
    return show.call(this, {...options,
      onMount(content, controls) {
        options.onMount?.(content, controls);
        if (originalControls) return;
        originalControls = controls; const close = controls.close, owner = h.owner('activeAppFormDialog');
        assert.ok(owner);
        const observation = () => {
          const modal = h.document.getElementById('app-form-modal');
          return {active: owner.isActive(), owner: h.owner('activeAppFormDialog'), trace: [...trace],
            promise: nativePromise && {...nativePromise}, history: JSON.stringify(h.c.history.state), href: h.c.location.href,
            traversals: [...h.history.traversals], focus: h.document.activeElement, sourceView: h.state.view,
            root: h.document.getElementById('album-tops-root'), rootFlags: flags(h.topHost), modalFlags: flags(modal),
            rootNodes: [...h.topHost.childNodes], modalNodes: [...modal.childNodes], events: [...h.events]};
        };
        controls.close = function (...args) {
          // Count every invocation before the real guard, including refused
          // reentrant requests. Neither results nor exceptions are substituted.
          const attempt = {args, depth: closeStack.length, parent: closeStack.at(-1) || null,
            entered: ++closeOrder, before: observation()};
          closes.push(attempt); closeStack.push(attempt);
          try {attempt.result = close.apply(this, args); attempt.outcome = 'returned'; return attempt.result;}
          catch (error) {attempt.error = error; attempt.outcome = 'threw'; throw error;}
          finally {attempt.after = observation(); attempt.exited = ++closeOrder; closeStack.pop();}
        };
      },
      onClose(...args) {if (armed) {trace.push('onClose:before'); callback('onClose:before', h);}
        try {return options.onClose?.(...args);} finally {if (armed) {trace.push('onClose:after'); callback('onClose:after', h);}}},
      onAfterClose(...args) {if (armed) {trace.push('onAfterClose:before'); callback('onAfterClose:before', h);}
        try {return options.onAfterClose?.(...args);} finally {if (armed) {trace.push('onAfterClose:after'); callback('onAfterClose:after', h);}}},
    });
  };
  t.after(() => {h.c.showAppFormDialog = show;});
  const opener = h.named('Create Album Top', h.topHost);
  h.click(opener); await h.settle();
  const form = h.document.querySelector('form[aria-label="Create Album Top"]'); assert.ok(form); assert.ok(originalControls);
  const title = form.querySelector('[aria-label="Album Top name"]'); h.input(title, 'Retained unsaved Top');
  h.click(h.named('Find albums', form)); await h.settle(); h.input(form.querySelector('input[type="search"]'), 'Picked'); await h.settle();
  h.click(form.querySelector('[data-gallery-card-intent="select"]')); await h.settle();
  const nativeOwner = h.owner('activeAppFormDialog'); assert.ok(nativeOwner);
  nativePromise = observe(nativeOwner.promise);
  return {...h, form, title, opener, nativeOwner, nativePromise, trace, closes,
    sourceButton: () => h.named('Create sample playlist', form), arm() {armed = true;},
    physicalClosed({scopeLostReentry = false, expectedError = null} = {}) {
      assert.equal(nativeOwner.isActive(), false); assert.notEqual(h.owner('activeAppFormDialog'), nativeOwner);
      assert.equal(h.document.getElementById('app-form-modal').hidden, true);
      assert.equal(this.nativePromise.status, 'resolved'); assert.equal(this.nativePromise.settlements, 1);
      const completion = ['onClose:before', 'onClose:after', 'onAfterClose:before', 'onAfterClose:after'];
      assert.deepEqual(trace, completion, 'one actual onClose and one actual onAfterClose');
      assert.equal(closeStack.length, 0);
      assert.equal(closes.length, scopeLostReentry ? 2 : 1);
      assert.deepEqual(closes.map(attempt => attempt.before.active), scopeLostReentry ? [true, false] : [true]);
      for (const attempt of closes) {
        assert.equal(attempt.args.length, 2); assert.equal(attempt.args[0], null);
        assert.deepEqual({...attempt.args[1]}, {force: true, restoreFocus: false, returnToParent: false});
        assert.equal(attempt.after.active, false);
      }
      const outer = closes[0];
      assert.equal(outer.depth, 0); assert.equal(outer.parent, null); assert.equal(outer.before.owner, nativeOwner);
      assert.ok(outer.entered < outer.exited);
      assert.deepEqual(outer.before.trace, []); assert.deepEqual(outer.after.trace, completion);
      assert.notEqual(outer.after.owner, nativeOwner);
      assert.equal(outer.outcome, expectedError ? 'threw' : 'returned');
      if (expectedError) assert.equal(outer.error, expectedError);
      else assert.equal(Object.hasOwn(outer, 'error'), false);
      // A changed actor can make the physically completing outer call return
      // false. Completion is proven above, never inferred from truthy result.
      if (scopeLostReentry) {
        const refused = closes[1];
        assert.equal(refused.depth, 1); assert.equal(refused.parent, outer);
        assert.ok(outer.entered < refused.entered && refused.entered < refused.exited && refused.exited < outer.exited);
        assert.equal(refused.before.owner, nativeOwner); assert.equal(refused.after.owner, nativeOwner);
        assert.equal(refused.outcome, 'returned'); assert.equal(refused.result, false, 'synchronous native finishing refusal');
        assert.equal(Object.hasOwn(refused, 'error'), false);
        assert.deepEqual(refused.before.trace, ['onClose:before']);
        assert.equal(refused.before.promise.status, 'pending'); assert.equal(refused.before.promise.settlements, 0);
        assert.deepEqual(refused.after, refused.before, 'refused attempt has no callback, settlement, owner, focus, history or DOM effect');
      }
    }};
}
async function freshSaved(h, root = h.topHost, mount = null) {
  h.svc.data.detail = {...h.svc.data.detail, top_ref: A.T.OTHER, title: 'Lawful fresh Top', revision: '8'};
  h.state.view = {...h.sourceView, top_ref: A.T.OTHER};
  h.nav.writeLibraryHistory(`/?surface=album_tops&top_ref=${A.T.OTHER}`, {...h.c.history.state}, {mode: 'replace'});
  h.actual.sync(); h.runtime.sync();
  if (mount) mount(root);
  await h.settle(); assert.equal(root.hidden, false); assert.equal(h.inactive(root), false);
  assert.match(root.textContent, /Lawful fresh Top/); return h.named('Create sample playlist', root);
}
async function freshChild(h, captures, old, root, control) {
  spent(h, old, root); assert.ok(control); assert.equal(control.disabled, false);
  h.click(control); await h.settle(); assert.equal(captures.length, 2);
  const current = captures.at(-1); assert.equal(current.guard(), true); assert.equal(root.hidden, true);
  spent(h, old, root, current); h.click(h.named('Back', h.host)); await h.settle();
  assert.equal(root.hidden, false); assert.equal(h.inactive(root), false); assert.deepEqual(h.history.traversals, [-1]); spent(h, old, root);
}
module.exports = {topOwner, platform, A, observe, watchHidden, observeScope, tapPresentation, flags, spent, detached, freshSaved, freshChild};
