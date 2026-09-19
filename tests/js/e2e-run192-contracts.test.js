const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadActions(filename, name, supplied = {}) {
  const context = { assert, ...supplied };
  vm.createContext(context);
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/actions', filename), 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replace('export class ', 'class ');
  vm.runInContext(source + `;globalThis.Actions = ${name};`, context);
  return { Actions: context.Actions, context };
}

for (const staleKeys of [['old'], ['other']]) {
  test(`Problems search readiness rejects a stale rendered tree (${staleKeys})`, async () => {
    let renderedKeys = staleKeys;
    const { Actions } = loadActions('utilityProblematicFilesActions.js', 'UtilityProblematicFilesActions', {
      state: { utility: { searchQuery: 'target' } },
      getFilteredProblematicAlbums: () => [{ key: 'target' }],
      document: { querySelectorAll: () => renderedKeys.map(key => ({ getAttribute: () => key })) },
    });
    const pom = {
      listItemSelector: '#utility-problematic-list [data-problematic-album-key]',
      async waitForPageCondition(predicate, _options, arg) {
        assert.equal(predicate(arg), false, 'query state updates before the debounced DOM commit');
        renderedKeys = ['target'];
        assert.equal(predicate(arg), true, 'the exact filtered result is now rendered');
      },
    };
    await new Actions(pom).waitForSearchResults('target');
  });
}

test('clearing Problems search waits for the complete restored tree', async () => {
  let renderedKeys = ['one'];
  const { Actions } = loadActions('utilityProblematicFilesActions.js', 'UtilityProblematicFilesActions', {
    state: { utility: { searchQuery: '' } },
    getFilteredProblematicAlbums: () => [{ key: 'one' }, { key: 'two' }],
    document: { querySelectorAll: () => renderedKeys.map(key => ({ getAttribute: () => key })) },
  });
  await new Actions({
    listItemSelector: '#utility-problematic-list [data-problematic-album-key]',
    searchSection: { searchInput: { fill: async () => {} } },
    async waitForPageCondition(predicate, _options, arg) {
      assert.equal(predicate(arg), false, 'cleared input is not a committed tree');
      renderedKeys = ['one', 'two'];
      assert.equal(predicate(arg), true);
    },
  }).clearSearch();
});

for (const method of ['revertRuleContaining', 'beginRevertRuleContaining']) {
  test(`${method} binds the rule key before the first matching row can change`, async () => {
    const response = { ok: () => true };
    const events = [];
    const stableRow = { waitFor: async () => events.push('exact-row-detached') };
    const matchingRow = {
      getAttribute: async name => { assert.equal(name, 'data-cdt-row-key'); return 'album-one::missing-cover'; },
      waitFor: async () => assert.fail('a text-filtered first row must not be observed after deletion'),
    };
    const { Actions } = loadActions('utilityRulesActions.js', 'UtilityRulesActions');
    const actions = new Actions({
      page: { waitForResponse: async () => response, waitForRequest: async () => ({}) },
      exclusionRowContaining: () => matchingRow,
      exclusionRowByKey: key => { assert.equal(key, 'album-one::missing-cover'); return stableRow; },
      revertButtonForRow: row => { assert.equal(row, stableRow); return { click: async () => events.push('open') }; },
      revertYes: { click: async () => events.push('confirm') },
    });
    const result = await actions[method]('Missing cover');
    if (result) await result.waitForAcknowledgement();
    assert.deepEqual(events, ['open', 'confirm', 'exact-row-detached']);
  });
}

for (const pending of [false, true]) {
  test(`tag Apply preserves its approved ${pending ? 'enabled' : 'disabled grey'} consumer treatment and native state`, async () => {
    const applyButton = {};
    const calls = [];
    const expectedStyles = pending
      ? { cursor: 'pointer', opacity: '1' }
      : { cursor: 'not-allowed', opacity: '0.55', 'background-color': 'rgb(55, 65, 81)',
        color: 'rgb(148, 163, 184)', 'border-top-color': 'rgb(75, 85, 99)' };
    const { Actions } = loadActions('tagEditorActions.js', 'TagEditorActions', {
      expect: element => ({
        async toBeDisabled() { assert.equal(element, applyButton); assert.equal(pending, false); calls.push('disabled'); },
        async toBeEnabled() { assert.equal(element, applyButton); assert.equal(pending, true); calls.push('enabled'); },
        async toHaveAttribute(name, value) {
          assert.equal(element, applyButton); assert.equal(value, 'primary');
          assert.ok(['data-ui-button-action', 'data-editor-footer-action'].includes(name));
        },
        async toHaveCSS(name, value) { assert.equal(element, applyButton); assert.equal(value, expectedStyles[name]); calls.push(name); },
      }),
    });
    await new Actions({ trackTitles: { allTextContents: async () => [] }, applyButton })
      .expectPendingChanges(pending ? ['changed.mp3'] : []);
    assert.deepEqual(calls, [pending ? 'enabled' : 'disabled', ...Object.keys(expectedStyles)]);
  });
}

test('Album Details keeps the legacy modal footer distinct from the shared table totals', async () => {
  const { TrackModal } = await import('../e2e/poms/trackModal.js');
  const locator = description => ({
    description, locator: selector => locator(`${description} ${selector}`),
    getByRole: role => locator(`${description} role:${role}`), nth: index => locator(`${description} nth:${index}`),
  });
  const modal = new TrackModal(locator('page'));
  assert.notEqual(modal.footer, modal.albumTrackTable.total);
  assert.equal(modal.footer.description, `page ${modal.footerSelector}`);
});

test('fresh-browser rename verification is scoped to the freshly opened album', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/specs/albumTagRename.spec.js'), 'utf8');
  const step = source.split("stepLogger.step('Reload and open a fresh browser")[1].split("stepLogger.step('")[0];
  assert.match(step, /await freshSession\.trackModalActions\.waitForTitle\(albumDetailsTitle\(RENAMED_ALBUM, RENAMED_YEAR\)\)/u);
});


test('failed rule confirmation can be dismissed through its native No action before a retry', async () => {
  const dialog = {};
  const calls = [];
  const { Actions } = loadActions('utilityRulesActions.js', 'UtilityRulesActions', {
    expect: actual => ({
      async toBeVisible() { assert.equal(actual, dialog); calls.push('visible'); },
      async toBeHidden() { assert.equal(actual, dialog); calls.push('hidden'); },
    }),
  });
  const actions = new Actions({
    revertConfirmation: dialog, revertNo: { click: async () => calls.push('cancel') },
  });
  await actions.cancelRevertConfirmation();
  assert.deepEqual(calls, ['visible', 'cancel', 'hidden']);
});


test('exact-track navigation establishes a supported off-screen scenario before loading the app', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../e2e/specs/problematicFileNavigation.spec.js'), 'utf8');
  const scenario = source.split("test('FTC-UTIL-PROBLEMS-011 opens the exact problematic track")[1].split("test('")[0];
  assert.match(scenario, /page\.setViewportSize\(\{ width: 1280, height: 720 \}\)[\s\S]*galleryActions\.goto/u);
  assert.match(scenario, /waitForTargetAlbumBelowSidebarViewport\(ALBUM, \{\s*minimumResultCount: 9/u);
  assert.match(scenario, /waitForActiveAlbumInSidebarViewport\(ALBUM\)/u);
});

test('restoring the saved recent player set leaves no dirty preference or pending color event', () => {
  const appearance = require('../../music_app/static/js/appearance-backgrounds.js');
  const style = {
    surface: { mode: 'gradient', angle: 137, start: '#123456', end: '#234567' },
    controls: { fill: '#51A1C4', border: '#2F91D1' },
    waveform: { fill: '#56789A', edge: '#6789AB' }, handles: { color: '#789ABC' },
  };
  const initial = {
    main_surface_color: null, panel_background_color: null, palette_id: 'paper', panel_index: 1,
    player_override: null, player_style_override: style, player_recent_sets: [style],
    compact_player_style: 'floating', album_details_layout: 'editorial_canvas',
    album_playing_row_animation: 'enabled', alert_family: 'signal', loop_control_style: 'capsule',
    revision: 1, waveform_recent_colors: ['#6789AB', '#56789A'],
    interaction_overrides: { item_hover: '#31465D', item_selected: '#3F5F7E',
      button_hover_background: '#27384B', button_pressed: '#203246',
      item_outline: { source: 'custom', color: '#86B7EF' } },
    selection_accent: { enabled: true, color: '#A1B2C3' },
  };
  const controller = appearance.createController({ initial, request: async () => initial });
  controller.configureSeekbar('waveform', () => {});
  controller.setActiveSection('seekbar');
  controller.setWaveformColor('fill', '#6789AB');
  controller.cancel();
  controller.setPlayerStyle({ ...style, surface: { ...style.surface, start: '#0A2F24' } });
  assert.equal(controller.getState().dirty, true);
  controller.restorePlayerSet(controller.getState().playerRecentSets[0]);
  const state = controller.getState();
  assert.equal(state.dirty, false);
  assert.equal(state.canSave, false);
  assert.deepEqual(state.draft, state.saved);
  assert.deepEqual(state.waveformColorUpdates, []);
  assert.equal(state.footer.status, 'Saved to your account');
});


test('disc presentation reads shared track totals while the superseded modal footer stays empty', async () => {
  const { TrackModal } = await import('../e2e/poms/trackModal.js');
  const modal = Object.create(TrackModal.prototype);
  modal.discHeaders = { allTextContents: async () => [' Disc 1 '] };
  modal.albumTrackTable = { total: { locator(selector) {
    assert.equal(selector, ':scope > *');
    return { allTextContents: async () => [' Total Length: 18m 00s ', ''] };
  } } };
  modal.readFooterLines = async () => assert.fail('Disc totals must not use the removed legacy footer');
  assert.deepEqual(await modal.readDiscGroupPresentation(), {
    headers: ['Disc 1'], totals: ['Total Length: 18m 00s'],
  });
});
