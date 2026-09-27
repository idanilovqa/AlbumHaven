const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { install } = require('../../../music_app/static/js/capability-ui.js');
const root = path.resolve(__dirname, '../../..');

function contextFor(availableTabs) {
  const events = new Map();
  const tabs = ['problematic-files', 'rules', 'loops', 'log-history', 'integrations', 'appearance']
    .map(key => ({ hidden: false, getAttribute: () => key }));
  const document = {
    readyState: 'loading', addEventListener: (name, fn) => events.set(name, fn),
    getElementById: id => id === 'capability-bootstrap' ? { textContent: JSON.stringify({
      allowed_actions: { 'account.self.appearance.read': true }, available_tabs: availableTabs,
      denied_tabs: tabs.map(tab => tab.getAttribute()).filter(key => !availableTabs.includes(key)),
      denied_selectors: [],
    }) } : null,
    querySelectorAll: () => tabs,
    querySelector: () => null,
    body: { classList: { add() {} } },
  };
  const policy = install(document);
  const calls = [];
  const overlay = { hidden: true };
  const context = vm.createContext({
    window: { AlbumHavenCapabilities: policy }, document,
    state: { utility: { activeTab: 'problematic-files' }, ui: {} },
    getUtilityModalElements: () => ({ overlay }),
    renderUtilityModalContent: () => calls.push('render:' + context.state.utility.activeTab),
    clearUtilityLoopSpaceOwner() {}, groupUtilityLoops: () => [],
    clearBrowserTimeout() {},
  });
  for (const file of ['utility-loop-playback.js', 'utility-loaders-and-cover-lookup.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js/runtime', file), 'utf8'), context);
  }
  context.loadProblematicFiles = () => calls.push('load:problematic-files');
  context.loadUtilityLoops = () => calls.push('load:loops');
  return { context, calls, overlay, policy, tabs, ready: () => events.get('DOMContentLoaded')?.() };
}

test('opening settings as a browse-only or listener account renders Appearance without a denied fetch', () => {
  const f = contextFor(['appearance']);
  f.context.openUtilityModal();
  assert.equal(f.context.state.utility.activeTab, 'appearance');
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.calls.includes('load:problematic-files'), false);
  assert.equal(f.calls.every(value => value === 'render:appearance'), true);
});

test('a musician starts on Loops and an owner retains the original Problems flow', () => {
  const musician = contextFor(['loops', 'appearance']);
  musician.context.openUtilityModal();
  assert.equal(musician.context.state.utility.activeTab, 'loops');
  assert.equal(musician.calls.includes('load:loops'), true);
  const owner = contextFor(['problematic-files', 'appearance']);
  owner.context.openUtilityModal();
  assert.equal(owner.context.state.utility.activeTab, 'problematic-files');
  assert.equal(owner.calls.includes('load:problematic-files'), true);
});

test('denied programmatic tab activation and loading never submit a forbidden request', () => {
  const f = contextFor(['appearance']);
  f.context.state.utility.activeTab = 'appearance';
  f.context.setUtilityActiveTab('problematic-files');
  assert.equal(f.context.state.utility.activeTab, 'appearance');
  f.context.state.utility.activeTab = 'problematic-files';
  f.context.loadActiveUtilityTab();
  assert.equal(f.calls.includes('load:problematic-files'), false);
});

test('denied tabs are natively hidden so arrow-key navigation cannot focus them', () => {
  const f = contextFor(['loops', 'appearance']);
  f.ready();
  assert.deepEqual(f.tabs.filter(tab => !tab.hidden).map(tab => tab.getAttribute()), ['loops', 'appearance']);
});

test('unknown tabs are not treated as permission and the last allowed tab is preserved', () => {
  const f = contextFor(['loops', 'appearance']);
  assert.equal(f.policy.resolveUtilityTab('appearance'), 'appearance');
  assert.equal(f.policy.resolveUtilityTab('problematic-files'), 'loops');
  assert.equal(f.policy.allowsUtilityTab('new-unreviewed-feature'), false);
});
