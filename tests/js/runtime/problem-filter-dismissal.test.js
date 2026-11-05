const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create: createDismissal } = require('../../../music_app/static/js/surface-dismissal.js');

function element() {
  const classes = new Set();
  return {
    hidden: false, dataset: {}, attributes: {},
    classList: {
      contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
    },
    style: { setProperty() {}, removeProperty() {} },
    getBoundingClientRect: () => ({ top: 0, bottom: 30, left: 0, right: 100, width: 100 }),
    setAttribute(name, value) { this.attributes[name] = value; },
    contains: () => false,
  };
}

test('outside dismissal clears the problem-filter owner state so the next toggle opens it', () => {
  const state = { utility: {
    problematicFiles: [{ problem_reasons: ['Missing year'] }],
    selectedProblemFilters: [], problemDropdownOpen: true,
  } };
  const context = vm.createContext({ state, window: {}, escapeHtml: value => value });
  const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
  for (const file of ['trigger-anchor.js', 'utility-list-builders.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtime, file), 'utf8'), context);
  }
  const els = { problemFilterButton: element(), problemFilterMenu: element() };
  for (let opening = 0; opening < 2; opening++) {
    context.renderProblemFilterControls(els);
    assert.equal(els.problemFilterMenu.hidden, false);
    assert.equal(els.problemFilterButton.attributes['aria-expanded'], 'true');
    assert.match(els.problemFilterMenu.innerHTML, /Missing year/);
    context.getDismissibleForegroundSurface().dismiss();
    assert.equal(state.utility.problemDropdownOpen, false);
    assert.equal(els.problemFilterMenu.hidden, true);
    assert.equal(els.problemFilterButton.attributes['aria-expanded'], 'false');
    assert.equal(context.getDismissibleForegroundSurface(), null);
    state.utility.problemDropdownOpen = !state.utility.problemDropdownOpen;
  }
});

test('an actual modal backdrop closes the filter owner and its state without closing the parent', () => {
  const els = { problemFilterButton: element(), problemFilterMenu: element() };
  let parentCloses = 0;
  const modal = { contains: target => target === els.problemFilterMenu || target === els.problemFilterButton };
  const state = { utility: {
    problematicFiles: [{ problem_reasons: ['Missing year'] }],
    selectedProblemFilters: [], problemDropdownOpen: true,
  } };
  const context = vm.createContext({ state, window: {}, escapeHtml: value => value,
    getTopmostOpenModal: () => modal, dismissForegroundModal: () => { parentCloses++; } });
  const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
  for (const file of ['trigger-anchor.js', 'utility-list-builders.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtime, file), 'utf8'), context);
  }
  const dismissal = createDismissal(() => context.getDismissibleForegroundSurface());
  context.renderProblemFilterControls(els);
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    let stopped = false;
    dismissal[type]({ target: modal, pointerId: 1, button: 0, detail: 1, clientX: 5, clientY: 5,
      preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    assert.equal(stopped, true);
  }
  assert.equal(parentCloses, 0);
  assert.equal(state.utility.problemDropdownOpen, false);
  assert.equal(els.problemFilterMenu.hidden, true);
  state.utility.problemDropdownOpen = !state.utility.problemDropdownOpen;
  context.renderProblemFilterControls(els);
  assert.equal(els.problemFilterMenu.hidden, false);
  assert.equal(els.problemFilterButton.attributes['aria-expanded'], 'true');
});

for (const mobile of [true, false]) {
  test(`${mobile ? 'mobile' : 'desktop'}: an outside tap on a gallery album while a side panel is open ${mobile ? 'only closes the panel' : 'keeps its existing behavior'}`, () => {
    const context = vm.createContext({ window: {}, usesMobilePageLayout: () => mobile });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/trigger-anchor.js'), 'utf8'), context);
    const panel = element();
    panel.contains = target => target === panel;
    panel.matches = selector => selector.includes('.shell-navigation-rail');
    let closes = 0;
    context.activateTriggerSurface(panel, () => { closes += 1; panel.hidden = true; });
    const dismissal = createDismissal(() => context.getDismissibleForegroundSurface());
    const albumCard = { className: 'album-card', closest: selector => (selector === '#albums-scroll' ? {} : null) };
    const reachedAlbum = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      let stopped = false;
      dismissal[type]({ target: albumCard, pointerId: 1, isPrimary: true, button: 0, detail: 1, clientX: 5, clientY: 5,
        preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
      if (!stopped) reachedAlbum.push(type);
    }
    if (mobile) {
      assert.deepEqual(reachedAlbum, [], 'no part of the dismissing tap may select or frame the album');
      assert.equal(closes, 1);
    } else {
      assert.deepEqual(reachedAlbum, ['pointerdown', 'pointerup', 'click']);
    }
  });
}

test('mobile: an always-visible surface such as the view switcher never swallows gallery swipes', () => {
  const context = vm.createContext({ window: {}, usesMobilePageLayout: () => true });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/trigger-anchor.js'), 'utf8'), context);
  const viewCluster = element();
  viewCluster.contains = target => target === viewCluster;
  viewCluster.matches = () => false;
  context.activateTriggerSurface(viewCluster, () => {});
  const dismissal = createDismissal(() => context.getDismissibleForegroundSurface());
  const albumCard = { closest: selector => (selector === '#albums-scroll' ? {} : null) };
  for (const type of ['pointerdown', 'pointerup', 'click']) {
    let stopped = false;
    dismissal[type]({ target: albumCard, pointerId: 1, isPrimary: true, button: 0, detail: 1, clientX: 5, clientY: 5,
      preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    assert.equal(stopped, false, type);
  }
});
