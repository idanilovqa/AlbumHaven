const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadActions(supplied) {
  const context = { ...supplied };
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/actions/utilityProblematicFilesActions.js'), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export class ', 'class ');
  vm.runInContext(source + ';globalThis.Actions = UtilityProblematicFilesActions;', context);
  return context.Actions;
}

test('mutation continuity captures the surviving artist/year metadata before the list changes', async () => {
  class Element {}
  const previous = new Element();
  previous.getAttribute = () => 'prior-album';
  previous.querySelector = selector => ({ textContent: selector === '.title' ? ' Prior album ' : ' Artist · 2026 ' });
  const selected = new Element();
  selected.getAttribute = () => 'selected-album';
  const items = [previous, selected];
  const list = new Element();
  list.scrollTop = 42;
  const Actions = loadActions({
    HTMLElement: Element,
    document: { querySelector: selector => selector === '.list' ? list : selected, querySelectorAll: () => items },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const actions = new Actions({
    activeListItem: { scrollIntoViewIfNeeded: async () => {} },
    sidebarListSelector: '.list', activeListItemSelector: '.selected', listItemSelector: '.item',
    listItemTitleSelector: '.title', listItemMetaSelector: '.meta',
    page: { async evaluateHandle(callback, selectors) {
      const snapshot = callback(selectors);
      return { evaluate: async read => read(snapshot), dispose: async () => {} };
    } },
  });
  const snapshot = await actions.prepareSelectedMutationContinuity();
  assert.equal(snapshot.previousKey, 'prior-album');
  assert.equal(snapshot.previousTitle, 'Prior album');
  assert.equal(snapshot.previousMeta, 'Artist · 2026');
  assert.equal(snapshot.scrollTop, 42);
});


function loadPlayerActions(expect) {
  const context = { expect };
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/actions/globalPlayerActions.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class ', 'class ');
  vm.runInContext(source + ';globalThis.Actions = GlobalPlayerActions;', context);
  return context.Actions;
}

for (const mode of ['regular', 'waveform']) {
  test(`expanded ${mode} geometry verifies waveform paint without treating a folded canvas as removed`, async () => {
    const waveformMode = mode === 'waveform';
    const player = {};
    const canvas = {};
    const calls = [];
    const height = waveformMode ? 100 : 76;
    const center = waveformMode ? 57 : 39;
    const timelineHeight = waveformMode ? 56 : 48;
    const bounds = (x, y, width, h) => ({ x, y, width, height: h });
    const checkpoint = {
      presentation: mode, paddingLeft: 28, player: bounds(0, 0, 1000, height),
      collapse: bounds(0, center-10, 20, 20), cover: bounds(28, center-24, 48, 48),
      play: bounds(90, center-24, 48, 48), timeline: bounds(156, center-timelineHeight/2, 800, timelineHeight),
      metadata: bounds(waveformMode ? 28 : 156, waveformMode ? 7 : 10, 500, 20),
      timestamp: bounds(900, waveformMode ? 8 : 11, 50, 20),
      waveform: bounds(156, center-(waveformMode ? 28 : 3.92), 800, waveformMode ? 56 : 7.84),
    };
    function expect(actual) {
      return {
        toBe: expected => assert.equal(actual, expected),
        toBeNull: () => assert.equal(actual, null),
        not: { toBeNull: () => assert.notEqual(actual, null) },
        toBeLessThanOrEqual: expected => assert.ok(actual <= expected, `${actual} > ${expected}`),
        async toHaveAttribute(name, value) { assert.equal(actual, player); assert.equal(value, mode); },
        async toHaveCSS(name, value) {
          if (actual === player) { assert.equal(name, 'height'); assert.equal(value, `${height}px`); }
          else { assert.equal(actual, canvas); calls.push([name, value]); }
        },
      };
    }
    expect.soft = expect;
    const Actions = loadPlayerActions(expect);
    await new Actions({ player, waveformCanvas: canvas, readExpandedGeometryCheckpoint: async () => checkpoint })
      .expectExpandedGeometry(mode);
    assert.deepEqual(calls, [['opacity', waveformMode ? '1' : '0'], ['pointer-events', 'none']]);
  });
}

test('saved-loop compact layout retains the action root while reporting approved card insets', async () => {
  const { UtilityLoopEntryCard } = await import('../e2e/poms/utilityLoopEntryCard.js');
  const pom = Object.create(UtilityLoopEntryCard.prototype);
  const box = { x: 10, y: 10, width: 40, height: 40 };
  const actionBox = { x: 60, y: 20, width: 34, height: 46 };
  const loc = bounds => ({ boundingBox: async () => bounds, count: async () => 1,
    textContent: async () => '- 0 pst +', isVisible: async () => true });
  const expectedPadding = { top: 16, right: 18, bottom: 24, left: 18, rowGap: 7, border: 1 };
  const entry = { boundingBox: async () => box, locator: () => loc(box),
    evaluate: async () => expectedPadding };
  for (const name of ['playButtonForEntry', 'loopActionForEntry', 'utilityMainForEntry', 'topRowForEntry',
    'pitchControlForEntry', 'timelineWrapForEntry', 'savedLoopTimeForEntry', 'repeatButtonForEntry',
    'speedControlForEntry', 'ordinaryTimelineForEntry']) pom[name] = () => loc(box);
  pom.loopActionForEntry = () => loc(actionBox);
  pom.loopScissorsButtonForEntry = () => { assert.fail('editing intentionally hides the Enter button'); };
  pom.detailHeader = loc(box);
  const result = await pom.readCompactLayoutSnapshot(entry);
  assert.deepEqual(result.scissorsBounds, actionBox);
  assert.deepEqual(result.cardInsets, expectedPadding);
});
