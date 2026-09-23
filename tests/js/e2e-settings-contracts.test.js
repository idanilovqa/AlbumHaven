const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadActions(file, name, expect) {
  const context = { expect };
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/actions', file), 'utf8')
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '').replace(/^export /gm, '');
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
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source + `;globalThis.Pom = ${name};`, context);
  return context.Pom;
}

test('Log History filter locates the shared Date range form and its explicit date fields', () => {
  function locator(description) {
    return {
      description,
      locator: selector => locator(`${description} ${selector}`),
      getByRole: (role, options) => locator(`${description} ${role}:${options.name}`),
      getByLabel: label => locator(`${description} label:${label}`),
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

test('library root values use locator primitives supported by the pinned Playwright version', async () => {
  const Pom = loadPom('settingsIntegrations.js', 'SettingsIntegrations', {
    BasePage: class {},
  });
  const values = ['C:\\Music', 'D:\\Archive'];
  const ui = Object.create(Pom.prototype);
  ui.roots = () => ({
    count: async () => values.length,
    nth: index => ({ inputValue: async () => values[index] }),
  });
  assert.deepEqual(Array.from(await ui.rootValues('Main Library')), values);
});

test('move policy helper restores an originally disabled policy', async () => {
  const calls = [];
  const toggle = {
    async getAttribute(name) {
      assert.equal(name, 'aria-checked');
      return 'true';
    },
    async click() { calls.push('click'); },
  };
  const Pom = loadPom('settingsIntegrations.js', 'SettingsIntegrations', {
    BasePage: class {},
    expect(actual) {
      assert.equal(actual, toggle);
      return {
        async toHaveAttribute(name, value) {
          assert.equal(name, 'aria-checked');
          assert.equal(value, 'false');
          calls.push('checked-false');
        },
      };
    },
  });
  const ui = Object.create(Pom.prototype);
  ui.detail = {
    getByRole(role, options) {
      assert.equal(role, 'switch');
      assert.equal(options.name, 'Auto Move rated albums to Main library');
      return toggle;
    },
  };
  ui.policyMenu = () => ({ count: async () => 0 });
  await ui.setMovePolicyEnabled('Library destination', false);
  assert.deepEqual(calls, ['click', 'checked-false']);
});

test('integrations cleanup clears a temporary destination before removing its root', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/specs/settingsIntegrations.functional.spec.js'), 'utf8');
  const chooseTemporary = source.indexOf("await ui.choosePolicy(label, rootValues.at(-1));");
  const disablePolicy = source.indexOf("await ui.setMovePolicyEnabled(label, Boolean(original));", chooseTemporary);
  const removeRoots = source.indexOf("for (const [title, category] of categories)", disablePolicy);
  assert.ok(chooseTemporary >= 0, 'cleanup must target the temporary root when the saved policy was empty');
  assert.ok(disablePolicy > chooseTemporary, 'cleanup must restore the switch after targeting the temporary root');
  assert.ok(removeRoots > disablePolicy, 'cleanup must remove the targeted temporary root to clear the persisted policy');
});


test('Problems readers include both album and file reasons while excluding proposal-only labels', () => {
  const selectors = [];
  function locator() {
    return new Proxy({}, { get(_target, name) {
      return (...args) => { if (name === 'locator') selectors.push(args[0]); return locator(); };
    } });
  }
  const Pom = loadPom('utilityProblematicFilesTab.js', 'UtilityProblematicFilesTab', {
    BasePage: class {}, UtilityMainBody: class {}, UtilitySearchSection: class {}, UtilitySidebarSection: class {},
  });
  const page = locator();
  new Pom(page);
  const reasonSelector = selectors.find(selector => selector.includes('.alert-label[data-problem-exclusion-reason]'));
  assert.ok(reasonSelector, 'album and file pills share the reason attribute, not exclusion scope');
  assert.ok(reasonSelector.includes('.utility-album-problem-content .alert-label'), 'missing-album reason remains visible');
  assert.ok(!reasonSelector.includes('data-problem-suggestion-id'), 'a repair proposal is not a detected problem');
});

test('active Problems row exposes independent title and artist/year metadata', async () => {
  const Actions = loadActions('utilityProblematicFilesActions.js', 'UtilityProblematicFilesActions', () => ({}));
  const activeItem = { getAttribute: async () => 'album-1' };
  const actions = new Actions({
    activeListItem: activeItem,
    titleForListItem: item => { assert.equal(item, activeItem); return { textContent: async () => '  Album  ' }; },
    metaForListItem: item => { assert.equal(item, activeItem); return { textContent: async () => '  Artist · 2009  ' }; },
  });
  const result = await actions.readActiveListItem();
  assert.equal(result.key, 'album-1');
  assert.equal(result.title, 'Album');
  assert.equal(result.meta, 'Artist · 2009');
});

for (const entry of [
  ['trackModalActions.js', 'TrackModalActions', 'trackModal', 'pressSpaceOnFocusedCloseControl', 'closeButton', 'waitForLoadedSummary', 'waitForClosed'],
  ['settingsModalAppBarActions.js', 'SettingsModalAppBarActions', 'settingsModalAppBar', 'pressSpaceOnFocusedSettingsClose', 'closeButton', 'waitForOpen', 'waitForClosed'],
]) {
  test(`${entry[3]} verifies native close before inspecting playback`, async () => {
    const [file, name, field, method, controlName, open, closed] = entry;
    const calls = [];
    const control = { focus: async () => calls.push('focus'), press: async key => { assert.equal(key, 'Space'); calls.push('space'); } };
    const Actions = loadActions(file, name, actual => ({ async toBeFocused() { assert.equal(actual, control); calls.push('focused'); } }));
    const owner = Object.create(Actions.prototype);
    owner[field] = { [controlName]: control };
    owner[open] = async () => calls.push('open');
    owner[closed] = async () => calls.push('closed');
    await owner[method]({ afterSpace: async () => calls.push('playback') });
    assert.deepEqual(calls, ['open', 'focus', 'focused', 'space', 'closed', 'playback']);
  });
}

test('native lightbox Space closes the cover before playback is checked', async () => {
  const calls = [];
  const lightbox = {};
  const button = { focus: async () => calls.push('focus'), press: async key => { assert.equal(key, 'Space'); calls.push('space'); } };
  const Actions = loadActions('trackModalActions.js', 'TrackModalActions', actual => ({
    async toBeVisible() { assert.equal(actual, lightbox); calls.push('visible'); },
    async toBeFocused() { assert.equal(actual, button); calls.push('focused'); },
    async toBeHidden() { assert.equal(actual, lightbox); calls.push('hidden'); },
  }));
  const owner = Object.create(Actions.prototype);
  owner.trackModal = { lightbox, lightboxCloseButton: button };
  await owner.pressSpaceOnFocusedLightboxClose({ afterSpace: async () => calls.push('playback') });
  assert.deepEqual(calls, ['visible', 'focus', 'focused', 'space', 'hidden', 'playback']);
});

for (const [method, setup, name, expectedOpen] of [
  ['pressSpaceOnFocusedDrawerOpener', 'closeDrawer', 'drawerButton', true],
  ['pressSpaceOnFocusedDrawerClose', 'openDrawer', 'drawerCloseButton', false],
]) {
  test(`${method} checks the changed drawer state produced by native activation`, async () => {
    const calls = [];
    const button = { focus: async () => calls.push('focus'), press: async key => { assert.equal(key, 'Space'); calls.push('space'); } };
    const Actions = loadActions('coverLookupActions.js', 'CoverLookupActions', actual => ({
      async toBeFocused() { assert.equal(actual, button); calls.push('focused'); },
    }));
    const owner = Object.create(Actions.prototype);
    owner[setup] = async () => calls.push('setup');
    owner.coverLookup = { [name]: button, async waitForDrawerState(open) { assert.equal(open, expectedOpen); calls.push('state'); } };
    await owner[method]({ afterSpace: async () => calls.push('playback') });
    assert.deepEqual(calls, ['setup', 'focus', 'focused', 'space', 'state', 'playback', ...(expectedOpen ? ['focused'] : [])]);
  });
}

test('native Settings Space navigates the visible account menu rather than toggling background playback', async () => {
  const calls = [];
  const button = { focus: async () => calls.push('focus'), press: async key => { assert.equal(key, 'Space'); calls.push('gear-space'); } };
  const item = { press: async key => { assert.equal(key, 'Space'); calls.push('item-space'); } };
  const menu = {};
  const Actions = loadActions('settingsModalAppBarActions.js', 'SettingsModalAppBarActions', actual => ({
    async toBeFocused() { calls.push(actual === button ? 'gear-focused' : 'item-focused'); assert.ok(actual === button || actual === item); },
    async toBeVisible() { assert.equal(actual, menu); calls.push('menu-visible'); },
    async toBeHidden() { assert.equal(actual, menu); calls.push('menu-hidden'); },
  }));
  const owner = Object.create(Actions.prototype);
  owner.settingsModalAppBar = { settingsButton: button, settingsMenuItem: item, accountMenu: menu };
  owner.waitForClosed = async () => calls.push('closed');
  owner.waitForOpen = async () => calls.push('open');
  await owner.pressSpaceOnFocusedSettingsOpener({ afterSpace: async () => calls.push('playback') });
  assert.deepEqual(calls, ['closed', 'focus', 'gear-focused', 'gear-space', 'menu-visible', 'item-focused', 'item-space', 'open', 'menu-hidden', 'playback']);
});

test('playback Space focuses the actual range control rather than inheriting a native button target', async () => {
  const calls = [];
  const timeline = { focus: async () => calls.push('focus'), press: async key => { assert.equal(key, 'Space'); calls.push('space'); } };
  const Actions = loadActions('globalPlayerActions.js', 'GlobalPlayerActions', actual => ({
    async toBeFocused() { assert.equal(actual, timeline); calls.push('focused'); },
  }));
  const owner = new Actions({ timeline });
  const expected = { paused: false };
  owner.waitForPlaybackState = async value => { assert.equal(value, expected); calls.push('playback'); };
  owner.readCurrentPlaybackSummary = async () => expected;
  assert.equal(await owner.togglePlaybackWithSpace(expected), expected);
  assert.deepEqual(calls, ['focus', 'focused', 'space', 'playback']);
});
