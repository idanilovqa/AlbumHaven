'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, id, ALBUM, ACTIONS: EXISTING_ACTIONS, labels, fixture, measure, navigation, drain, nextTask, nativeEnvironment} = require('./album-tops-native-fixtures/shared-header-driver.cjs');

// Add is independently authorized and precedes the retained management actions.
const ACTIONS = ['Add albums', ...EXISTING_ACTIONS];
const SAMPLE_ACTION = 'Create sample playlist';
const EMPTY_READ_ACTIONS = ['Filter', SAMPLE_ACTION];
const POPULATED_READ_ACTIONS = ['Filter', 'Rows', 'Cards', 'No info', SAMPLE_ACTION];

test('directory delegates its one Create action to the shared Tools capsule', async t => {
  const h = await fixture(t, {selected: false}), header = h.header();
  assert.deepEqual(labels(header.querySelector('.home-header__primary-actions')), ['Create Album Top']);
  for (const slot of ['leading', 'outside', 'final-action']) assert.deepEqual(labels(header.querySelector(`.home-header__${slot}`)), []);
  assert.equal(header.getAttribute('aria-label'), 'Album Tops header'); assert.equal(header.getAttribute('tabindex'), '-1');
  assert.ok(h.button(header.querySelector('[data-header-action-capsule]'), 'Create Album Top'));
  assert.equal(header.querySelectorAll('[data-header-tools]').length, 1);
});

test('detail delegates current ordered actions once and Back remains leading', async t => {
  const h = await fixture(t), header = h.header(), capsule = header.querySelector('[data-header-action-capsule]');
  assert.deepEqual(labels(header.querySelector('.home-header__leading')), ['Back']);
  assert.deepEqual(labels(header.querySelector('.home-header__primary-actions')), [...EMPTY_READ_ACTIONS, ...ACTIONS]);
  for (const slot of ['outside', 'final-action']) assert.deepEqual(labels(header.querySelector(`.home-header__${slot}`)), []);
  assert.deepEqual(labels(h.host), ['Back', ...EMPTY_READ_ACTIONS, ...ACTIONS]);
  assert.equal(h.button(capsule, 'Filter').disabled, true, 'true-empty Top retains a disabled Filter');
  for (const label of ACTIONS) {assert.equal(h.host.querySelectorAll('button').filter(node => node.getAttribute('aria-label') === label).length, 1); assert.ok(h.button(capsule, label));}
  const sample = h.button(capsule, SAMPLE_ACTION);
  assert.equal(sample.textContent.trim(), '', 'sample action content is icon-only');
  assert.ok(sample.querySelector('svg')); assert.equal(sample.getAttribute('aria-label'), SAMPLE_ACTION);
  assert.equal(sample.disabled, true, 'absent current sample authority cannot enable the action');
  assert.equal(capsule.querySelector('[aria-label="Back"]'), null); assert.match(h.host.innerHTML, /Top &lt;safe&gt;/);
});

test('shared capsule retains strict current action projections and busy state', async t => {
  for (const grants of [{can_edit: false, can_view_sharing: false, can_copy: false, can_delete: false}, {can_edit: 'true', can_view_sharing: 1, can_copy: 'true', can_delete: 1}]) {
    const h = await fixture(t, {grants}); assert.deepEqual(labels(h.header().querySelector('.home-header__primary-actions')), [...EMPTY_READ_ACTIONS, 'Add albums']);
  }
  for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'idle', refreshing: true}]) {
    const h = await fixture(t); h.replace({...h.state(), mutation});
    const actions = h.header().querySelector('.home-header__primary-actions').querySelectorAll('button');
    assert.deepEqual(labels(h.header().querySelector('.home-header__primary-actions')), [...EMPTY_READ_ACTIONS, ...ACTIONS]);
    assert.equal(actions.length, ACTIONS.length + 4, 'Filter, sample, hidden Reset and hidden Update listening join unchanged management controls');
    for (const action of actions) assert.equal(action.disabled, true);
    assert.ok(h.header().querySelector('[aria-label="Reset filters"]').closest('[hidden]'));
    const updateListening = actions.find(node => node.textContent.trim() === 'Update listening');
    assert.ok(updateListening); assert.ok(updateListening.closest('[hidden]'));
  }
  const h = await fixture(t); h.replace({...h.state(), detail: {status: 'denied', data: null}});
  assert.deepEqual(labels(h.header().querySelector('.home-header__primary-actions')), []);
});

test('Add projection is independent, exact and own while existing header actions remain ordered', async t => {
  for (const can_add of [false, undefined, 'true', 1]) {
    const h = await fixture(t, {grants: {can_add}});
    assert.deepEqual(labels(h.header().querySelector('.home-header__primary-actions')), [...EMPTY_READ_ACTIONS, ...EXISTING_ACTIONS]);
    assert.equal(h.header().querySelector('[aria-label="Add albums"]'), null);
  }
  const h = await fixture(t), previous = h.state(), allowed_actions = {...previous.detail.data.allowed_actions};
  delete allowed_actions.can_add; Object.setPrototypeOf(allowed_actions, {can_add: true});
  h.replace({...previous, detail: {...previous.detail, data: {...previous.detail.data, allowed_actions}}});
  assert.deepEqual(labels(h.header().querySelector('.home-header__primary-actions')), [...EMPTY_READ_ACTIONS, ...EXISTING_ACTIONS]);
  const denied = await fixture(t, {grants: {can_add: false, can_edit: false, can_view_sharing: false, can_copy: false, can_delete: false}});
  assert.deepEqual(labels(denied.header().querySelector('.home-header__primary-actions')), EMPTY_READ_ACTIONS);
  assert.equal(denied.button(denied.header(), 'Filter').disabled, true);
});

test('retired capsule handlers cannot act on another detail object or revoked grants', async t => {
  for (const kind of ['replacement', 'revoked']) for (const label of ACTIONS) {
    const h = await fixture(t), button = h.button(h.header(), label), old = h.state();
    const data = {...old.detail.data, ...(kind === 'revoked' ? {allowed_actions: {'library.browse.read': true}} : {})};
    h.replace({...old, detail: {...old.detail, data}}, false); h.click(button); await drain();
    assert.deepEqual(h.calls.mutations, []); assert.deepEqual(h.calls.confirms, []); assert.equal(h.opens.length, 0);
    h.render(); assert.equal(h.host.querySelector('form'), null); assert.equal(h.content().querySelector('form'), null); assert.equal(h.modal().hidden, true);
  }
});

test('Delete keeps the confirmation-time snapshot guard after shared delegation', async t => {
  const h = await fixture(t); h.click(h.button(h.header(), 'Delete Album Top'));
  assert.equal(h.calls.confirms.length, 1); assert.equal(h.document.getElementById('app-confirm-modal').hidden, false);
  h.replace({...h.state(), mutation: {status: 'idle'}}, false);
  h.click(h.document.getElementById('app-confirm-accept')); await drain(); assert.deepEqual(h.calls.mutations, []);
});

test('inline draft header reuses shared header with exact field/action nodes and guarded Back', async t => {
  const h = await fixture(t, {editDraft: true}), nav = navigation(h);
  h.click(h.button(h.header(), 'Edit Album Top'));
  const header = h.header(), form = h.host.querySelector('form'), fields = form.querySelector('.album-top-builder__identity'), actions = form.querySelector('.playlists__actions');
  assert.ok(form); assert.equal(header.querySelector('.gallery-bar__title').firstChild, fields);
  assert.equal(actions.parentNode, header.querySelector('.home-header__primary-actions'));
  assert.deepEqual(labels(header), ['Back', 'Save', 'Cancel', SAMPLE_ACTION]);
  const input = fields.querySelector('[name="top-name"]'), save = h.button(actions, 'Save'), cancel = h.button(actions, 'Cancel');
  h.input(input, 'Draft'); h.render();
  assert.equal(h.header(), header); assert.equal(form.querySelector('.album-top-builder__identity'), fields); assert.equal(form.querySelector('.playlists__actions'), actions);
  assert.equal(h.button(actions, 'Save'), save); assert.equal(h.button(actions, 'Cancel'), cancel);
  h.click(h.button(header, 'Back')); await drain(); assert.deepEqual(h.calls.opens, []); assert.equal(nav.calls, 1); assert.equal(h.document.activeElement, input);
  h.replace({...h.state(), mutation: {status: 'loading'}}); assert.equal(h.button(header, 'Back').disabled, true);
  h.replace({...h.state(), mutation: {status: 'idle'}}); nav.allow = true; h.click(h.button(header, 'Back')); await drain();
  assert.deepEqual(h.calls.opens, [null]); assert.equal(nav.calls, 2); assert.equal(nav.callbacks, 1);
  assert.notEqual(h.document.activeElement, h.header().querySelector('[aria-label="Edit Album Top"]'), 'Back uses cancel({restoreFocus:false})');
});

// Real native measurement decides compactness before entry and after Cancel.
// Only hidden/disabled fixture inputs are supplied to canonical button renderers.
test('inline return selects visible Edit then shared Tools then focusable header', async t => {
  for (const [options, target] of [[{}, 'edit'], [{compact: true}, 'tools'], [{compact: true, toolsHidden: true}, 'host'], [{editDisabled: true, toolsHidden: true}, 'host']]) {
    const h = await fixture(t, {editDraft: true}), width = options.compact ? 210 : 1000;
    const original = measure(h, width);
    assert.equal(original.getAttribute('data-header-compact'), String(Boolean(options.compact)));
    if (options.compact) h.click(h.button(original, 'Tools'));
    h.click(h.button(original, 'Edit Album Top')); assert.ok(h.host.querySelector('form'));
    assert.equal(original.isConnected, false, 'inline owner retires the old normal header');
    const render = h.runtime.actionHtml;
    h.runtime.actionHtml = config => render(config.ariaLabel === 'Tools' && options.toolsHidden ? {...config, hidden: true}
      : config.ariaLabel === 'Edit Album Top' && options.editDisabled ? {...config, disabled: true} : config);
    // The shared platform's basic focus() checks connectivity/disabled only.
    // Add the browser restriction; never redirect focus to an expected node.
    const focus = h.context.Element.prototype.focus;
    h.context.Element.prototype.focus = function (...args) {
      if (this.closest('[hidden],[inert],[aria-hidden="true"]')) return;
      return focus.apply(this, args);
    };
    h.click(h.button(h.header(), 'Cancel')); await drain();
    const header = measure(h, width);
    assert.notEqual(header, original, 'normal header was actually recreated');
    assert.equal(header.getAttribute('data-header-compact'), String(Boolean(options.compact)));
    assert.equal(header.querySelector('.home-header__actions').hasAttribute('inert'), Boolean(options.compact));
    const edit = header.querySelector('[aria-label="Edit Album Top"]'), tools = header.querySelector('[data-header-tools]');
    assert.equal(tools.hidden, Boolean(options.toolsHidden)); assert.equal(edit.disabled, Boolean(options.editDisabled));
    const expected = target === 'host' ? header : target === 'edit' ? edit : tools;
    assert.equal(h.document.activeElement, expected, JSON.stringify(options));
    assert.equal(Boolean(expected.closest('[hidden],[inert],[aria-hidden="true"]')), false, 'return target is visible and not inert');
  }
});

test('dialog focus return rejects a connected opener hidden by compact layout', async t => {
  // Share retains the actual dialog contract; Edit is covered as inline below.
  for (const kind of ['Share']) for (const compact of [false, true]) {
    const h = await fixture(t); measure(h, 1000);
    const opener = h.button(h.header(), kind); opener.focus(); h.click(opener); await drain(); assert.equal(h.modal().hidden, false);
    if (compact) measure(h, 210);
    assert.equal(opener.isConnected, true); assert.equal(h.header().getAttribute('data-header-compact'), String(compact));
    h.click(h.document.getElementById('app-form-close')); await drain(); assert.equal(h.modal().hidden, true);
    assert.equal(h.document.activeElement, compact ? h.header().querySelector('[data-header-tools]') : opener);
  }
});

test('ordinary saved Top Edit uses actual inline navigation and returns focus after guarded discard', async t => {
  const h = await fixture(t, {inlineNavigation: true}); measure(h, 1000);
  const original = h.header(), opener = h.button(original, 'Edit Album Top');
  opener.focus(); h.click(opener); await drain();
  const form = h.host.querySelector('form.album-top-inline-edit'); assert.ok(form);
  assert.equal(original.isConnected, false); assert.equal(opener.isConnected, false);
  assert.equal(h.modal().hidden, true); assert.equal(h.opens.length, 0);
  assert.deepEqual(labels(h.header()), ['Back', 'Save', 'Cancel', SAMPLE_ACTION]);
  const input = form.querySelector('[name="top-name"]'); h.input(input, 'Unsaved title');
  h.click(h.button(form, 'Cancel')); await drain();
  assert.equal(h.document.getElementById('app-confirm-modal').hidden, false);
  assert.match(h.document.getElementById('app-confirm-modal').textContent, /Discard these unsaved Album Top changes/);
  h.click(h.document.getElementById('app-confirm-cancel')); await drain(); await nextTask();
  assert.equal(form.isConnected, true); assert.equal(input.value, 'Unsaved title');
  h.click(h.button(form, 'Cancel')); await drain();
  h.click(h.document.getElementById('app-confirm-accept')); await drain(); await nextTask();
  assert.equal(form.isConnected, false); assert.equal(h.host.querySelector('form.album-top-inline-edit'), null);
  const restored = measure(h, 1000), edit = h.button(restored, 'Edit Album Top');
  assert.notEqual(restored, original); assert.notEqual(edit, opener);
  assert.equal(h.document.activeElement, edit); assert.equal(Boolean(edit.closest('[hidden],[inert]')), false);
  assert.equal(h.backend.count('execute'), 0); assert.deepEqual(h.calls.mutations, []);
  assert.equal(h.runtime.deferDraftNavigation(() => assert.fail('Discarded editor retained a navigation guard')), false);
});

test('SharedHeader external object/callback refs compose with its internal root and clear on unmount', async () => {
  const {mountSharedHeader} = await load('home-friends/shared-header.mjs');
  for (const kind of ['object', 'callback', 'absent']) {
    const h = nativeEnvironment(), seen = [], object = {current: null}, headerRef = kind === 'object' ? object : kind === 'callback' ? node => seen.push(node) : undefined;
    const owner = mountSharedHeader(h.host, h.runtime, {id: 'bounded-ref-test', headerRef, tabIndex: -1, ariaLabel: 'Album Tops header'}), dom = owner.element;
    try {
      assert.equal(dom.tagName, 'HEADER'); assert.equal(dom.getAttribute('tabindex'), '-1'); assert.equal(dom.getAttribute('aria-label'), 'Album Tops header');
      assert.equal(h.host.firstChild, dom); if (kind === 'object') assert.equal(object.current, dom); if (kind === 'callback') assert.deepEqual(seen, [dom]);
      measure(h, 1000); assert.equal(owner.element, dom);
    } finally {owner.dispose();}
    assert.equal(dom.isConnected, false); if (kind === 'object') assert.equal(object.current, null); if (kind === 'callback') assert.deepEqual(seen, [dom, null]); h.assertClean();
  }
});

test('SharedHeader preserves callback-ref cleanup and replacement lifetimes', async () => {
  const {mountSharedHeader} = await load('home-friends/shared-header.mjs'), h = nativeEnvironment(), events = [];
  const callback = node => {events.push(['attach', node]); return () => events.push(['cleanup', node]);};
  const owner = mountSharedHeader(h.host, h.runtime, {id: 'ref-replacement', headerRef: callback}), first = owner.element, replacement = {current: null};
  try {
    assert.deepEqual(events, [['attach', first]]); owner.update({id: 'ref-replacement', headerRef: replacement});
    assert.deepEqual(events, [['attach', first], ['cleanup', first]]); assert.equal(replacement.current, first); assert.equal(owner.element, first);
  } finally {owner.dispose(); owner.dispose();}
  assert.equal(replacement.current, null); assert.equal(first.isConnected, false); assert.deepEqual(events, [['attach', first], ['cleanup', first]], 'retired callback receives no duplicate null/cleanup'); h.assertClean();
});

test('responsive action order and progress nodes remain stable through compact and expanded updates', async t => {
  const h = await fixture(t, {patch: {items: [{item_ref: id(21), album_ref: ALBUM, title: 'Album', artist: 'Artist', year: 2001}], completion_summary: {completed: 0, total: 1}, top_viewer_overlay: {item_progress: {[ALBUM]: {progress_revision: '4', manual_completed_at: null}}}}});
  const header = h.header(), actions = ACTIONS.map(label => h.button(header, label)), title = header.querySelector('.gallery-bar__title').firstChild;
  const progress = header.querySelector('[role="progressbar"]'); assert.ok(progress);
  assert.equal(progress.getAttribute('aria-valuetext'), '0 of 1 albums completed');
  const completion = h.host.querySelector('[data-gallery-card-intent="complete"]'); assert.ok(completion);
  for (const [width, compact] of [[1000, false], [210, true], [1000, false]]) {
    measure(h, width); assert.equal(header.getAttribute('data-header-compact'), String(compact));
    assert.deepEqual(labels(header.querySelector('.home-header__primary-actions')), [...POPULATED_READ_ACTIONS, ...ACTIONS]);
    ACTIONS.forEach((label, index) => assert.equal(header.querySelector(`[aria-label="${label}"]`), actions[index]));
    h.replace({...h.state(), mutation: {status: 'idle'}});
    assert.equal(h.header(), header); assert.equal(header.querySelector('[role="progressbar"]'), progress);
    assert.equal(progress.getAttribute('aria-valuetext'), '0 of 1 albums completed'); assert.equal(header.querySelector('.gallery-bar__title').firstChild, title);
    assert.equal(h.host.querySelector('[data-gallery-card-intent="complete"]'), completion); assert.equal(completion.getAttribute('aria-pressed'), 'false');
  }
});

// Real Settings admission/discard order is retained. Wrapping its callback only
// supplies the adversarial duplicate or successor event, never grants departure.
test('actual inline Cancel decline preserves the editor and accepted focus return is one-shot', async t => {
  const h = await fixture(t, {inlineNavigation: true});
  let admittedCallback = null, admissions = 0;
  const defer = h.runtime.deferDraftNavigation;
  h.runtime.deferDraftNavigation = callback => defer(() => {
    admissions++; admittedCallback = callback; return callback();
  });
  h.click(h.button(h.header(), 'Edit Album Top')); await drain();
  const form = h.host.querySelector('form.album-top-inline-edit'), input = form.querySelector('[name="top-name"]');
  h.input(input, 'Keep this draft');
  h.click(h.button(form, 'Cancel')); await drain();
  h.click(h.document.getElementById('app-confirm-cancel')); await drain(); await nextTask();
  assert.equal(admissions, 0); assert.equal(admittedCallback, null);
  assert.equal(form.isConnected, true); assert.equal(input.value, 'Keep this draft');
  assert.equal(h.document.activeElement, input);
  h.click(h.button(form, 'Cancel')); await drain();
  h.click(h.document.getElementById('app-confirm-accept')); await drain(); await nextTask();
  assert.equal(admissions, 1); assert.equal(form.isConnected, false);
  const edit = h.button(h.header(), 'Edit Album Top'); assert.equal(h.document.activeElement, edit);
  const share = h.button(h.header(), 'Share'); share.focus();
  admittedCallback(); admittedCallback(); await drain();
  assert.equal(h.document.activeElement, share, 'duplicate admitted callback cannot reclaim later focus');
  assert.equal(h.backend.count('execute'), 0);
});

test('old admitted Cancel callback cannot steal focus from a reentrant newer inline editor', async t => {
  const h = await fixture(t, {inlineNavigation: true});
  let oldCallback = null, successor = null, successorInput = null;
  const defer = h.runtime.deferDraftNavigation;
  h.runtime.deferDraftNavigation = callback => defer(() => {
    oldCallback = callback;
    assert.equal(h.host.querySelector('form.album-top-inline-edit'), null, 'actual owner discarded before callback');
    h.click(h.button(h.header(), 'Edit Album Top'));
    successor = h.host.querySelector('form.album-top-inline-edit'); assert.ok(successor);
    successorInput = successor.querySelector('[name="top-name"]'); successorInput.focus();
    return callback();
  });
  h.click(h.button(h.header(), 'Edit Album Top')); await drain();
  const retired = h.host.querySelector('form.album-top-inline-edit');
  h.click(h.button(retired, 'Cancel')); await drain(); await nextTask();
  assert.equal(retired.isConnected, false); assert.equal(successor.isConnected, true);
  assert.equal(h.document.activeElement, successorInput);
  oldCallback(); await drain();
  assert.equal(h.document.activeElement, successorInput);
  assert.equal(h.host.querySelector('form.album-top-inline-edit'), successor);
  assert.equal(h.backend.count('execute'), 0);
});

test('admitted Cancel callback is inert when disposed before its first dispatch', async t => {
  const h = await fixture(t, {inlineNavigation: true});
  let retiredCallback = null, external = null;
  const defer = h.runtime.deferDraftNavigation;
  h.runtime.deferDraftNavigation = callback => defer(() => {
    retiredCallback = callback;
    assert.equal(h.host.querySelector('form.album-top-inline-edit'), null, 'actual discard completed first');
    h.view.dispose();
    external = h.document.createElement('button'); h.document.body.append(external); external.focus();
    return callback();
  });
  h.click(h.button(h.header(), 'Edit Album Top')); await drain();
  try {
    h.click(h.button(h.host.querySelector('form.album-top-inline-edit'), 'Cancel')); await drain(); await nextTask();
    assert.equal(typeof retiredCallback, 'function'); assert.ok(external);
    assert.equal(h.document.activeElement, external); assert.equal(h.host.querySelector('[data-shared-header]'), null);
    retiredCallback(); await drain();
    assert.equal(h.document.activeElement, external); assert.equal(h.host.querySelector('[data-shared-header]'), null);
  } finally {external?.remove();}
});

test('sample action accessible name is distinct from the actual visible editor title', async () => {
  const {actualChoiceEnvironment} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');
  const {controllerFixture, parent} = require('./sample-native-fixtures.cjs');
  const env = actualChoiceEnvironment(), sample = await controllerFixture();
  const {mountSamplePlaylistPage} = await load('playlists/native-sample-playlist.mjs');
  const editor = mountSamplePlaylistPage(env.host, env.runtime, {controller: sample.controller, parent: parent()});
  try {
    const page = env.host.querySelector('main[aria-label="Temporary Sample Playlist"]'); assert.ok(page);
    assert.equal(page.querySelector('h2').textContent, 'Sample Playlist');
    assert.notEqual(page.querySelector('h2').textContent, SAMPLE_ACTION);
    assert.equal(sample.calls.capture.length, 0); assert.equal(sample.calls.save.length, 0);
  } finally {editor.dispose(); sample.controller.dispose();}
  await nextTask(); env.assertClean();
});
