const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(
  __dirname,
  '../../../music_app/static/js/runtime/search-input.js',
), 'utf8');
const utilitySource = fs.readFileSync(path.join(
  __dirname,
  '../../../music_app/static/js/runtime/utility-renderers-and-actions.js',
), 'utf8');

function load() {
  const listeners = {};
  const context = vm.createContext({
    document: {
      addEventListener(type, listener) { listeners[type] = listener; },
      querySelectorAll() { return []; },
    },
    Event: class Event {
      constructor(type, options = {}) { this.type = type; this.bubbles = options.bubbles; }
    },
  });
  vm.runInContext(source, context);
  return { context, listeners };
}

function field(value = '', options = {}) {
  const clear = { hidden: false };
  const control = { querySelector: selector => selector === '[data-search-clear]' ? clear : null };
  const input = {
    value,
    disabled: Boolean(options.disabled),
    readOnly: Boolean(options.readOnly),
    closest: selector => selector === '.search-field-control' ? control : null,
    matches: selector => selector === '.search-field input[type="search"]',
  };
  return { input, clear };
}

test('Clear is visible only for editable search content', () => {
  const { context } = load();
  for (const [value, options, expectedHidden] of [
    ['', {}, true],
    ['query', {}, false],
    ['query', { disabled: true }, true],
    ['query', { readOnly: true }, true],
  ]) {
    const { input, clear } = field(value, options);
    context.updateSearchClearAction(input);
    assert.equal(clear.hidden, expectedHidden, JSON.stringify({ value, options }));
  }
});

test('typing synchronizes Clear visibility through the shared delegated listener', () => {
  const { listeners } = load();
  const { input, clear } = field('rules');
  listeners.input({ target: input });
  assert.equal(clear.hidden, false);
  input.value = '';
  listeners.input({ target: input });
  assert.equal(clear.hidden, true);
});

test('tab rendering and typing synchronize Clear for every utility search owner', () => {
  const { context, listeners } = load();
  vm.runInContext(utilitySource, context);
  const { input, clear } = field();
  const tab = {
    getAttribute: () => context.state.utility.activeTab,
    setAttribute() {},
    classList: { toggle() {} },
  };
  const els = {
    search: input,
    tabs: [tab],
    overlay: { hidden: false, setAttribute() {} },
    detail: { classList: { remove() {} } },
    list: { dataset: {} },
    problemFilterButton: { setAttribute() {} },
  };
  context.getUtilityModalElements = () => els;
  context.syncUtilityTabAlignment = () => {};
  context.disposeMountedLoopActions = () => {};
  context.unmountAppearanceEditors = () => {};
  context.state = { utility: { activeTab: '' } };
  const renderers = {
    rules: 'renderUtilityRules',
    loops: 'renderUtilityLoops',
    integrations: 'renderUtilityIntegrations',
    appearance: 'renderUtilityAppearance',
    'log-history': 'renderUtilityLogHistory',
    'problematic-files': 'renderProblematicFiles',
  };

  for (const [activeTab, renderer] of Object.entries(renderers)) {
    context[renderer] = () => {
      input.value = activeTab === 'log-history' ? 'Today' : `${activeTab} restored`;
      input.disabled = false;
      input.readOnly = activeTab === 'log-history';
    };
    context.state.utility.activeTab = activeTab;
    context.renderUtilityModalContent();
    assert.equal(clear.hidden, activeTab === 'log-history', `${activeTab} restored state`);

    input.readOnly = false;
    input.value = `${activeTab} typed`;
    listeners.input({ target: input });
    assert.equal(clear.hidden, false, `${activeTab} typed state`);
  }
});
