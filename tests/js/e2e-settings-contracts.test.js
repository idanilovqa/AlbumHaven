const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadActions(file, name, expect) {
  const context = { expect };
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/actions', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class ', 'class ');
  vm.runInContext(source + `;globalThis.Actions = ${name};`, context);
  return context.Actions;
}

test('seekbar selection stages the checked input without waiting for a live-player mutation', async () => {
  let checked = false;
  const input = { async check() { checked = true; } };
  const Actions = loadActions('utilityAppearanceActions.js', 'UtilityAppearanceActions', actual => ({
    async toBeChecked() { assert.equal(actual, input); assert.equal(checked, true); },
  }));
  const actions = new Actions({
    seekbarModeInputs: { count: async () => 2 },
    seekbarModeInput(mode) { assert.equal(mode, 'waveform'); return input; },
    seekbarModeSelectorFor: () => '[data-appearance-seekbar-mode="waveform"]',
    async waitForPageCondition() { assert.fail('draft selection must not wait for the unsaved live state'); },
  });
  await actions.selectSeekbarMode('waveform');
  assert.equal(checked, true);
});

for (const dirty of [false, true]) {
  test(`explicit seekbar save respects the ${dirty ? 'dirty' : 'already saved'} editor and verifies the live presentation`, async () => {
    const calls = [];
    const player = {};
    const Actions = loadActions('utilityAppearanceActions.js', 'UtilityAppearanceActions', actual => ({
      async toHaveAttribute(name, value) { assert.equal(actual, player); calls.push(['live', name, value]); },
    }));
    const actions = new Actions({ globalPlayer: player, editorFooter: { primary: { root: { isEnabled: async () => dirty } } } });
    actions.selectSeekbarMode = async mode => calls.push(['select', mode]);
    actions.save = async () => calls.push(['save']);
    assert.equal(typeof actions.saveSeekbarMode, 'function');
    await actions.saveSeekbarMode('waveform');
    assert.deepEqual(calls, [['select', 'waveform'], ...(dirty ? [['save']] : []), ['live', 'data-player-seekbar-presentation', 'waveform']]);
  });
}

test('Log History summary recognizes the explicit empty snapshot in the shared console', async () => {
  const Actions = loadActions('utilityLogHistoryActions.js', 'UtilityLogHistoryActions', () => ({}));
  const empty = { count: async () => 1, textContent: async () => 'No events in this snapshot.' };
  const actions = new Actions({
    detailTitle: { count: async () => 1, textContent: async () => 'Log History' },
    listItems: { count: async () => 0 }, detailFiles: { count: async () => 0 },
    emptySnapshot: empty, mainBody: { emptyState: { count: async () => 0 } },
  });
  const result = await actions.readSummary();
  assert.equal(result.itemCount, 0);
  assert.equal(result.emptyState, 'No events in this snapshot.');
});

for (const target of ['create', 'cancel']) {
  test(`loop ${target} hover uses its shared semantic color token, not player text ink`, async () => {
    const calls = [];
    const action = { boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 }) };
    const root = { getAttribute: async () => 'creating' };
    const expected = target === 'create' ? 'rgb(52, 211, 153)' : 'rgb(255, 48, 48)';
    const Actions = loadActions('globalPlayerActions.js', 'GlobalPlayerActions', actual => ({
      async toHaveAttribute() { assert.equal(actual, root); },
      async toHaveCSS(name, color) { assert.equal(actual, action); assert.equal(name, 'color'); assert.equal(color, expected); },
    }));
    const actions = new Actions({
      playButton: action, loopAction: root, loopCreateButton: action, loopCancelButton: action,
      page: { mouse: { move: async () => {} } },
      async readLoopActionHoverColor(value) { calls.push(value); return expected; },
      async readThemedPlayerInkColor() { assert.fail('the live text ink is not the loop action accent'); },
    });
    actions.readLoopActionVisualState = async () => ({});
    await actions.hoverLoopAction(target);
    assert.deepEqual(calls, [target]);
  });
}

function loadPom(file, name, context = {}) {
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/poms', file), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class ', 'class ');
  vm.runInContext(source + `;globalThis.Pom = ${name};`, context);
  return context.Pom;
}

test('Log History filter locates the shared Date range form and its explicit date fields', () => {
  function locator(description) {
    return {
      description,
      locator: selector => locator(`${description} ${selector}`),
      getByRole: (role, options) => locator(`${description} ${role}:${options.name}`),
      getByText: text => locator(`${description} text:${text}`),
      first() { return this; },
    };
  }
  const Pom = loadPom('utilityLogHistoryTab.js', 'UtilityLogHistoryTab', {
    BasePage: class {}, UtilityMainBody: class {}, UtilitySidebarSection: class {},
  });
  const history = new Pom(locator('page'));
  assert.equal(history.periodDialog.description, 'page dialog:Date range');
  assert.equal(history.periodFrom.description, 'page dialog:Date range textbox:From date');
  assert.equal(history.periodTo.description, 'page dialog:Date range textbox:To date');
});

test('unavailable-root scenario acknowledges the visible watcher warning using its native Dismiss button', async () => {
  const calls = [];
  const warning = {};
  const dismiss = { click: async () => calls.push('click') };
  const Pom = loadPom('settingsIntegrations.js', 'SettingsIntegrations', {
    expect: actual => ({
      async toBeVisible() { assert.equal(actual, warning); calls.push('visible'); },
      async toBeHidden() { assert.equal(actual, warning); calls.push('hidden'); },
    }),
  });
  const ui = Object.create(Pom.prototype);
  ui.watcherWarning = warning;
  ui.dismissWatcherWarning = dismiss;
  assert.equal(typeof ui.acknowledgeUnavailableRootWarning, 'function');
  await ui.acknowledgeUnavailableRootWarning();
  assert.deepEqual(calls, ['visible', 'click', 'hidden']);
});
