const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'utilities',
  'problematic-tab.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function createElement(attributes = {}) {
  return {
    checked: Boolean(attributes.checked),
    classList: {
      contains() {
        return false;
      },
    },
    getAttribute(name) {
      return attributes[name] || '';
    },
  };
}

function createEvent(selectorMap = {}) {
  const calls = {
    prevented: false,
  };
  const event = {
    preventDefault() {
      calls.prevented = true;
    },
    target: {
      closest(selector) {
        return selectorMap[selector] || null;
      },
    },
  };
  return { event, calls };
}

function loadHelper(stateOverrides = {}) {
  const calls = {
    renders: 0,
    registeredTab: null,
  };
  const context = {
    state: {
      utility: {
        loaded: true,
        problemDropdownOpen: true,
        problematicFiles: [],
        selectedProblemFilters: [],
        selectedProblematicKey: '',
        showRepairedDisplay: false,
        repairSelections: {},
        separateReleaseSelections: {},
        collapsedSections: {},
        ...stateOverrides,
      },
    },
    fetchCoverForProblematicAlbum() {},
    getRepairRowKeysFromButton() {
      return [];
    },
    getSelectedProblematicAlbum() {
      return null;
    },
    loadProblematicFiles() {},
    openAlbumInExplorer() {},
    openRepairConfirmModal() {},
    openTagEditor() {},
    openAlbumOnDiscogs() {},
    registerUtilityTab(key, config) {
      calls.registeredTab = { key, config };
    },
    renderProblematicFiles() {},
    renderUtilityModalContent() {
      calls.renders += 1;
    },
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { calls, context };
}

test('applying a problem filter preserves the selected album when it still matches', () => {
  const { context, calls } = loadHelper({
    problematicFiles: [
      { key: 'album-1', problem_reasons: ['Poor art quality', 'Missing year'] },
      { key: 'album-2', problem_reasons: ['Missing cover art'] },
    ],
    selectedProblematicKey: 'album-1',
  });
  const { event, calls: eventCalls } = createEvent({
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Poor art quality',
    }),
  });

  const handled = context.handleProblematicUtilityClick(event);

  assert.equal(handled, true);
  assert.equal(eventCalls.prevented, true);
  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Poor art quality']);
  assert.equal(context.state.utility.deferProblematicAutoSelection, true);
  assert.equal(context.state.utility.selectedProblematicKey, 'album-1');
  assert.equal(context.state.utility.problemDropdownOpen, false);
  assert.equal(context.state.utility.showRepairedDisplay, true);
  assert.equal(calls.renders, 1);
});

test('applying a problem filter clears the selected album when it no longer matches', () => {
  const { context } = loadHelper({
    problematicFiles: [
      { key: 'album-1', problem_reasons: ['Missing cover art'] },
      { key: 'album-2', problem_reasons: ['Poor art quality'] },
    ],
    selectedProblematicKey: 'album-1',
  });
  const { event } = createEvent({
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Poor art quality',
    }),
  });

  context.handleProblematicUtilityClick(event);

  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Poor art quality']);
  assert.equal(context.state.utility.deferProblematicAutoSelection, true);
  assert.equal(context.state.utility.selectedProblematicKey, '');
  assert.equal(context.state.utility.problemDropdownOpen, false);
});

test('removing a problem filter preserves the selected album when it still matches the remaining filters', () => {
  const { context } = loadHelper({
    problematicFiles: [
      { key: 'album-1', problem_reasons: ['Poor art quality', 'Missing year'] },
      { key: 'album-2', problem_reasons: ['Missing year'] },
    ],
    selectedProblematicKey: 'album-1',
    selectedProblemFilters: ['Poor art quality', 'Missing year'],
  });
  const { event } = createEvent({
    '[data-remove-problem-filter]': createElement({
      'data-remove-problem-filter': 'Poor art quality',
    }),
  });

  context.handleProblematicUtilityClick(event);

  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Missing year']);
  assert.equal(context.state.utility.deferProblematicAutoSelection, true);
  assert.equal(context.state.utility.selectedProblematicKey, 'album-1');
  assert.equal(context.state.utility.problemDropdownOpen, false);
});

test('clicking a problematic album row clears the deferred auto-selection flag', () => {
  const { context } = loadHelper({
    deferProblematicAutoSelection: true,
  });
  const { event } = createEvent({
    '[data-problematic-album-key]': createElement({
      'data-problematic-album-key': 'album-7',
    }),
  });

  context.handleProblematicUtilityClick(event);

  assert.equal(context.state.utility.selectedProblematicKey, 'album-7');
  assert.equal(context.state.utility.deferProblematicAutoSelection, false);
});
