'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {load, id, ALBUM, ACTIONS, labels, fixture, measure, navigation, drain, nativeEnvironment} = require('./album-tops-native-fixtures/shared-header-driver.cjs');

test('directory delegates its one Create action to the shared Tools capsule', async t => {
  const h = await fixture(t, {selected: false}), header = h.header();
  assert.deepEqual(labels(header.querySelector('.home-header__primary-actions')), ['Create Album Top']);
  for (const slot of ['leading', 'outside', 'final-action']) assert.deepEqual(labels(header.querySelector(`.home-header__${slot}`)), []);
  assert.equal(header.getAttribute('aria-label'), 'Album Tops header'); assert.equal(header.getAttribute('tabindex'), '-1');
  assert.ok(h.button(header.querySelector('[data-header-action-capsule]'), 'Create Album Top'));
  assert.equal(header.querySelectorAll('[data-header-tools]').length, 1);
});

test('detail delegates original ordered actions once and Back remains leading', async t => {
  const h = await fixture(t), header = h.header(), capsule = header.querySelector('[data-header-action-capsule]');
  assert.deepEqual(labels(header.querySelector('.home-header__leading')), ['Back']);
  assert.deepEqual(labels(header.querySelector('.home-header__primary-actions')), ACTIONS);
  for (const slot of ['outside', 'final-action']) assert.deepEqual(labels(header.querySelector(`.home-header__${slot}`)), []);
  assert.deepEqual(labels(h.host), ['Back', ...ACTIONS]);
  for (const label of ACTIONS) {assert.equal(h.host.querySelectorAll('button').filter(node => node.getAttribute('aria-label') === label).length, 1); assert.ok(h.button(capsule, label));}
  assert.equal(capsule.querySelector('[aria-label="Back"]'), null); assert.match(h.host.innerHTML, /Top &lt;safe&gt;/);
});

test('shared capsule retains strict current action projections and busy state', async t => {
  for (const grants of [{can_edit: false, can_view_sharing: false, can_copy: false, can_delete: false}, {can_edit: 'true', can_view_sharing: 1, can_copy: 'true', can_delete: 1}]) {
    const h = await fixture(t, {grants}); assert.deepEqual(labels(h.header().querySelector('.home-header__primary-actions')), []);
  }
  for (const mutation of [{status: 'loading'}, {status: 'uncertain'}, {status: 'idle', refreshing: true}]) {
    const h = await fixture(t); h.replace({...h.state(), mutation});
    const actions = h.header().querySelector('.home-header__primary-actions').querySelectorAll('button');
    assert.equal(actions.length, 4); for (const action of actions) assert.equal(action.disabled, true);
  }
  const h = await fixture(t); h.replace({...h.state(), detail: {status: 'denied', data: null}});
  assert.deepEqual(labels(h.header().querySelector('.home-header__primary-actions')), []);
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
  assert.deepEqual(labels(header), ['Back', 'Save', 'Cancel']);
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
  for (const kind of ['Edit Album Top', 'Share']) for (const compact of [false, true]) {
    const h = await fixture(t); measure(h, 1000);
    const opener = h.button(h.header(), kind); opener.focus(); h.click(opener); await drain(); assert.equal(h.modal().hidden, false);
    if (compact) measure(h, 210);
    assert.equal(opener.isConnected, true); assert.equal(h.header().getAttribute('data-header-compact'), String(compact));
    h.click(h.document.getElementById('app-form-close')); await drain(); assert.equal(h.modal().hidden, true);
    assert.equal(h.document.activeElement, compact ? h.header().querySelector('[data-header-tools]') : opener);
  }
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
  const h = await fixture(t, {patch: {items: [{item_ref: id(21), album_ref: ALBUM, title: 'Album', artist: 'Artist', year: 2001}], top_viewer_overlay: {item_progress: {[ALBUM]: {progress_revision: '4', manual_completed_at: null}}}}});
  const header = h.header(), actions = ACTIONS.map(label => h.button(header, label)), title = header.querySelector('.gallery-bar__title').firstChild;
  const completion = h.host.querySelector('[data-gallery-card-intent="complete"]'); assert.ok(completion);
  for (const [width, compact] of [[1000, false], [210, true], [1000, false]]) {
    measure(h, width); assert.equal(header.getAttribute('data-header-compact'), String(compact));
    assert.deepEqual(labels(header.querySelector('.home-header__primary-actions')), ACTIONS);
    ACTIONS.forEach((label, index) => assert.equal(header.querySelector(`[aria-label="${label}"]`), actions[index]));
    h.replace({...h.state(), mutation: {status: 'idle'}});
    assert.equal(h.header(), header); assert.equal(header.querySelector('.gallery-bar__title').firstChild, title);
    assert.equal(h.host.querySelector('[data-gallery-card-intent="complete"]'), completion); assert.equal(completion.getAttribute('aria-pressed'), 'false');
  }
});
