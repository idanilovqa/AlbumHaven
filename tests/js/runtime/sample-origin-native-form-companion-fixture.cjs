'use strict';
// Candidate-tree real native helper + real mobile/Settings callers. The imported
// fixture supplies DOM/events/history/timers/network boundaries, not form owners.
const assert = require('node:assert/strict');
const R = require('./search-native-fixtures/actual-runtime.cjs');
function observe(promise) {
  const state = {status: 'pending', settlements: 0};
  Promise.resolve(promise).then(value => {state.status = 'resolved'; state.value = value; state.settlements++;},
    error => {state.status = 'rejected'; state.error = error; state.settlements++;});
  return state;
}
function fixture(t) {
  const h = R.fixture(t), handles = [], events = [];
  assert.ok(h.loaded.includes('music_app/static/js/runtime/browser-dialog-helpers.js'));
  const get = key => h.document.getElementById(`app-form-${key}`);
  const active = () => h.owner('activeAppFormDialog');
  const foreground = () => h.owner('getActiveAppFormPage')();
  const mobileForeground = () => h.owner('currentMobileFormOwner')();
  const opener = h.document.createElement('button'); opener.textContent = 'Original opener'; h.document.body.append(opener);
  const child = h.document.createElement('button'); child.textContent = 'Foreground Sample control'; h.document.body.append(child);
  function open(options = {}) {
    opener.focus(); let host, input, last;
    const beforeDismiss = options.beforeDismiss || (() => false), onClose = options.onClose;
    const handle = h.owner('openReactFormDialog')({title: 'Exact original form', pageId: 'native-companion-source',
      showCloseButton: true, returnFocus: () => opener, ...options,
      beforeDismiss(reason) {events.push(['beforeDismiss', reason]); return beforeDismiss(reason);},
      onMount(node, close) {
        host = node; input = h.document.createElement('input'); input.setAttribute('aria-label', 'Unsaved original title');
        input.value = 'Unsaved title including \u2713'; last = h.document.createElement('button'); last.textContent = 'Last original control';
        host.append(input, last); options.onMount?.(host, close);
      },
      onClose(node, outcome) {events.push(['close', node, outcome]); onClose?.(node, outcome);},
    });
    handles.push(handle);
    const owner = active(), promise = observe(handle.promise), nodes = {modal: get('modal'), title: get('title'), content: get('content'), host, input, last};
    assert.equal(owner?.promise, handle.promise); assert.equal(foreground(), owner); assert.equal(mobileForeground(), owner);
    return {handle, owner, promise, nodes};
  }
  const flags = node => ({hidden: node.hidden, inert: node.inert, ariaHidden: node.getAttribute('aria-hidden'), display: node.style.display});
  const concealed = node => node.hidden === true || node.style.display === 'none' || node.getAttribute('aria-hidden') === 'true';
  const noEffects = () => {assert.equal(h.requests.length, 0); assert.equal(h.invocations.length, 0); assert.equal(h.redirects.length, 0);};
  t.after(async () => {for (const handle of handles) await handle.close(null, {force: true, restoreFocus: false, returnToParent: false, updateHistory: false});
    h.c.AlbumHavenSettingsNavigation.instance?.destroy(); opener.remove(); child.remove(); await R.drain();});
  return {...h, events, open, get, active, foreground, mobileForeground, opener, child, flags, concealed, noEffects,
    forceClose: handle => handle.close(null, {force: true, restoreFocus: false, returnToParent: false, updateHistory: false})};
}
module.exports = {fixture, observe, deferred: R.deferred, drain: R.drain};
