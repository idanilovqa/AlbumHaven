const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appearance = require('../../../music_app/static/js/appearance-backgrounds.js');

const classicGreen = () => ({
  surface: { mode: 'gradient', angle: 0, start: '#0A2F24', end: '#0A1422' },
  controls: { fill: '#24B86B', border: '#86EFAC' },
  waveform: { fill: '#387F68', edge: '#AFD8C2' },
  handles: { color: '#AFD8C2' },
});

const itemOutline = (source = 'automatic', color = null) => ({ source, color });
const interactionOverrides = () => ({
  item_hover: null,
  item_selected: null,
  button_hover_background: null,
  button_pressed: null,
  item_outline: itemOutline(),
});

const initialAppearance = () => ({
  revision: 7,
  main_surface_color: null,
  panel_background_color: null,
  palette_id: 'black',
  panel_index: 0,
  player_override: null,
  compact_player_style: 'docked',
  album_details_layout: 'classic_bar',
  album_playing_row_animation: 'enabled',
  alert_family: 'ember',
  interaction_overrides: interactionOverrides(),
  selection_accent: { enabled: true, color: '#6E9BD0' },
  player_style_override: classicGreen(),
  player_recent_sets: [classicGreen()],
});

const editableSnapshot = value => {
  const { revision, player_recent_sets, csrf_token, ...draft } = value;
  return draft;
};

test('a handle-only edit from native appearance preserves other components after save and reload', async () => {
  const nativeInitial = { ...initialAppearance(), palette_id: null, player_override: null, player_style_override: null, player_recent_sets: [] };
  const { controller } = setup({ initial: nativeInitial });
  controller.setPlayerStyleColor('handles.color', '#123456');
  assert.equal(controller.getState().draft.player_style_override.surface.mode, 'layered_gradient');
  assert.equal(await controller.save(), true);
  const reloaded = setup({ initial: controller.getState().saved }).controller;
  const attributes = new Map(), properties = new Map();
  appearance.applyTheme(reloaded.getState().saved, {
    style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) },
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
  });
  for (const component of ['surface', 'controls', 'waveform']) assert.equal(attributes.has(`data-appearance-native-${component}`), true);
  assert.equal(attributes.has('data-appearance-native-handles'), false);
  for (const token of ['player', 'play', 'waveform-fill', 'waveform-edge']) assert.equal(properties.has(`--appearance-${token}`), false);
  assert.equal(properties.get('--appearance-player-handle'), '#123456');
  assert.equal(properties.get('--appearance-interaction-outline'), appearance.resolveAppearance(nativeInitial).tokens.accent);
  appearance.clearTheme({
    style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) },
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
  });
  assert.equal([...attributes.keys()].some(key => key.startsWith('data-appearance-native-')), false);
});

test('native waveform edits keep intentional control pairing while preserving the native surface', () => {
  const { controller } = setup({ initial: { ...initialAppearance(), palette_id: null, player_override: null, player_style_override: null } });
  controller.setWaveformColor('fill', '#123456');
  const style = controller.getState().draft.player_style_override;
  assert.equal(style.surface.mode, 'layered_gradient');
  assert.equal(style.waveform.fill, '#123456');
  assert.equal(style.controls.fill, appearance.derivePairedPlayerColor('waveform.fill', '#123456').color);
  assert.deepEqual(style.native_components, ['surface', 'handles']);
});

test('old explicit player styles are never inferred native from matching colors', () => {
  const { nativePlayerStyle } = require('../../../music_app/static/js/appearance-palettes.js');
  const attributes = new Map();
  appearance.applyTheme({ ...initialAppearance(), palette_id: null, player_style_override: structuredClone(nativePlayerStyle) }, {
    style: { setProperty() {}, removeProperty() {} },
    setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key),
  });
  assert.equal([...attributes.keys()].some(key => key.startsWith('data-appearance-native-')), false);
});

for (const native_components of [null, 'surface', ['surface', 'surface'], ['unknown'], [1], {}, ['surface', 'controls', 'waveform', 'handles', 'surface']]) {
  test(`player style rejects invalid native component provenance ${JSON.stringify(native_components)}`, () => {
    const { normalizePlayerOverride } = require('../../../music_app/static/js/appearance-palettes.js');
    assert.throws(() => normalizePlayerOverride({ ...classicGreen(), native_components }), TypeError);
  });
}

function requireMethod(controller, name) {
  assert.equal(typeof controller[name], 'function', `Appearance workspace must expose ${name}()`);
  return controller[name].bind(controller);
}

function openElementClassesAt(markup, offset) {
  const stack = [];
  const tags = /<\/?([a-z][\w-]*)(?:\s[^>]*)?>/gi;
  let match;
  while ((match = tags.exec(markup)) && match.index < offset) {
    if (match[0].startsWith('</')) {
      stack.pop();
      continue;
    }
    if (match[0].endsWith('/>')) continue;
    stack.push(match[0].match(/\bclass="([^"]*)"/)?.[1] || '');
  }
  return stack;
}

function setup(options = {}) {
  const initial = options.initial || initialAppearance();
  const requests = [];
  const applied = [];
  const controller = appearance.createController({
    initial,
    request: async (method, payload) => {
      requests.push({ method, payload });
      if (method === 'GET') return initial;
      const { expected_revision, applied_player_set, ...draft } = payload;
      return {
        ...draft,
        revision: expected_revision + 1,
        player_recent_sets: applied_player_set
          ? [applied_player_set, ...initial.player_recent_sets].slice(0, 5)
          : initial.player_recent_sets,
      };
    },
    apply: value => applied.push(value),
    ...options,
  });
  return { controller, requests, applied, initial };
}

for (const action of ['match', 'reset']) {
  test(`migrated aggregate player ${action} clears legacy colors through save and reload`, async () => {
    const initial = { ...initialAppearance(), player_style_override: null,
      player_override: { background: '#123456', fill: '#345678', edge: '#567890' } };
    const { controller, requests } = setup({ initial });
    controller.setPalette('slate');
    if (action === 'match') controller.setPlayerMode('palette');
    else controller.resetSection('seekbar');
    assert.equal(controller.getState().draft.player_override, null);
    assert.equal(controller.getState().draft.player_style_override, null);
    assert.equal(controller.getState().draft.palette_id, 'slate');
    assert.equal(await controller.save(), true);
    assert.equal(requests[0].payload.player_override, null);
    const reloaded = setup({ initial: { ...controller.getState().saved, revision: 8, player_recent_sets: initial.player_recent_sets } }).controller;
    assert.equal(reloaded.getState().draft.player_override, null);
    assert.equal(reloaded.getState().draft.player_style_override, null);
  });
}

test('solid player colors stay solid after a new Start selection and restored unequal endpoints', () => {
  const { controller } = setup();
  const style = classicGreen();
  style.surface = { mode: 'solid', angle: 45, start: '#123456', end: '#ABCDEF' };
  controller.setPlayerStyle(style);
  const properties = new Map();
  const root = { style: { setProperty: (name, value) => properties.set(name, value), removeProperty() {} }, setAttribute() {}, removeAttribute() {} };
  appearance.applyTheme(controller.getState().draft, root);
  assert.equal(properties.get('--appearance-player-surface-start'), '#123456');
  assert.equal(properties.get('--appearance-player-surface-end'), '#123456');
  appearance.setPlayerStylePath(controller, 'surface.start', '#345678');
  assert.equal(controller.getState().draft.player_style_override.surface.end, '#345678');
  appearance.applyTheme(controller.getState().draft, root);
  assert.equal(properties.get('--appearance-player-surface-end'), '#345678');
});

test('one aggregate draft keeps Main elements, Player & Seekbar, and Selection accent edits while navigating', () => {
  const { controller, initial } = setup();
  controller.setPalette('slate');
  requireMethod(controller, 'setPlayerStyle')({
    ...classicGreen(),
    waveform: { fill: '#527A91', edge: '#A7C3D2' },
  });
  requireMethod(controller, 'setSelectionAccent')({ enabled: true, color: '#526B8B' });
  requireMethod(controller, 'setInteractionOverrides')({ ...interactionOverrides(), button_hover_background: '#27384B' });
  const draft = controller.getState().draft;

  for (const section of ['seekbar', 'selection-accent', 'backgrounds']) {
    requireMethod(controller, 'setActiveSection')(section);
    assert.equal(controller.getState().activeSection, section);
    assert.deepEqual(controller.getState().draft, draft);
  }
  assert.deepEqual(controller.getState().saved, editableSnapshot(initial));
});

test('new aggregate pages promote a legacy preference with complete interaction defaults', () => {
  const { controller } = setup({
    initial: {
      main_surface_color: null,
      panel_background_color: null,
    },
  });

  controller.setAlertFamily('signal');
  controller.setAlbumDetailsLayout('stacked_bar');
  controller.setSelectionAccent({ enabled: true, color: '#A1B2C3' });

  assert.deepEqual(controller.getState().draft.interaction_overrides, interactionOverrides());
  assert.doesNotThrow(() => controller.setInteractionOverrides({
    ...controller.getState().draft.interaction_overrides,
    item_hover: '#31465D',
  }));
  assert.equal(controller.getState().draft.interaction_overrides.item_hover, '#31465D');
});

test('Alerts is a durable aggregate section with three curated families', async () => {
  const { controller, requests } = setup();
  assert.equal(typeof controller.setAlertFamily, 'function');
  controller.setAlertFamily('signal');
  assert.equal(controller.getState().draft.alert_family, 'signal');
  assert.throws(() => controller.setAlertFamily('custom'));
  assert.equal(await controller.save(), true);
  assert.equal(requests[0].payload.alert_family, 'signal');

  controller.setAlertFamily('quiet');
  controller.resetSection('alerts');
  assert.equal(controller.getState().draft.alert_family, 'ember');
});

test('Alerts and Album page expose the approved live-preview contracts', () => {
  const alerts = appearance.alertsMarkup();
  const album = appearance.albumPageMarkup();
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');

  for (const family of ['ember', 'signal', 'quiet']) assert.match(alerts, new RegExp(`data-alert-family="${family}"`));
  for (const severity of ['error', 'warning', 'info']) assert.match(alerts, new RegExp(`data-alert-preview-severity="${severity}"`));
  assert.match(alerts, /data-alert-live-preview/);
  assert.match(alerts, /data-alert-preview-small-compact/);
  assert.match(alerts, /data-alert-preview-small-expanded/);

  for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) assert.match(album, new RegExp(`data-album-details-layout="${layout}"`));
  assert.match(album, /data-album-preview-state="present"/);
  assert.match(album, /data-album-preview-state="missing"/);
  assert.match(album, /data-album-page-live-preview/);
  assert.match(album, /data-album-preview-present/);
  assert.match(album, /data-album-preview-missing[^>]*hidden/);
  assert.match(album, /Album details unavailable/);
  assert.match(album, /Total Length: 1h 17m 13s/);
  assert.match(css, /\.appearance-album-layout-card/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*\.appearance-album-page__workspace/);
  const activeTrackRule = css.match(/\.appearance-album-preview__track\.is-playing::after\s*\{([^}]*)\}/s)?.[1] || '';
  assert.match(activeTrackRule, /mask(?:-composite)?\s*:/, 'the animated spectrum is clipped to the active row perimeter');
  assert.doesNotMatch(activeTrackRule, /transform\s*:\s*rotate/, 'the preview must not rotate a rectangle across the table');
  assert.match(css, /@keyframes\s+appearance-track-spectrum\s*\{[^}]*--appearance-track-spectrum-angle/s);
});

test('Main elements and Player & Seekbar keep their live previews visible while settings scroll', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'), 'utf8');
  const main = source.slice(source.indexOf('function editorMarkup()'), source.indexOf('function seekbarMarkup('));
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');

  assert.match(main, /class="background-choices"[\s\S]*class="background-player-section"[\s\S]*class="background-preview-column"/);
  assert.match(css, /\.background-preview-column\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);

  for (const mode of ['default', 'waveform']) {
    const player = appearance.seekbarMarkup(mode);
    const seekbarModeOffset = player.indexOf('<section class="player-seekbar-mode"');
    const openClasses = openElementClassesAt(player, seekbarModeOffset);

    assert.ok(seekbarModeOffset > 0);
    assert.ok(player.indexOf('data-player-live-preview') < seekbarModeOffset);
    assert.ok(seekbarModeOffset < player.indexOf('<div class="player-editor-workspace"'));
    assert.ok(!openClasses.includes('player-preview-dock'), `${mode} selector must scroll outside the sticky preview`);
    assert.equal((player.match(/class="player-seekbar-mode"/g) || []).length, 1);
  }
  assert.match(css, /\.player-preview-dock\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/s);
});

test('Main elements preview demonstrates inert shared Save and Cancel button interactions', () => {
  assert.equal(typeof appearance.editorMarkup, 'function');
  const markup = appearance.editorMarkup();
  const actions = markup.match(/<div class="background-preview-actions"[\s\S]*?<\/div>/)?.[0] || '';

  assert.match(actions, /<strong[^>]*>Buttons<\/strong>/);
  assert.match(actions, /Hover, press, or use Tab to preview interactions\./);
  assert.match(actions, /class="button ui-button ui-button--secondary ui-button--small ui-button--quiet"[^>]*data-background-preview-cancel/);
  assert.match(actions, /class="button ui-button ui-button--primary ui-button--small"[^>]*data-background-preview-save/);
  assert.doesNotMatch(actions, /data-background-(?:cancel|save)(?:[\s=>])/);
});

test('selecting a Main elements palette applies its coordinated selection accent', () => {
  const { controller } = setup();
  controller.setSelectionAccent({ enabled: false, color: '#34CA78' });
  controller.setPalette('paper');
  assert.deepEqual(controller.getState().draft.selection_accent, { enabled: false, color: '#596775' });
  controller.setPalette('midnight');
  assert.deepEqual(controller.getState().draft.selection_accent, { enabled: false, color: '#8297CC' });
  assert.ok(appearance.selectionAccentColors.includes('#34CA78'));
  assert.ok(appearance.selectionAccentColors.includes('#8297CC'));
});

test('one Save submits the complete aggregate draft with revision and one applied player-set event', async () => {
  const { controller, requests } = setup();
  controller.setPalette('slate');
  const player = { ...classicGreen(), controls: { fill: '#4D8A72', border: '#9AC7B4' } };
  requireMethod(controller, 'setPlayerStyle')(player);
  requireMethod(controller, 'setSelectionAccent')({ enabled: true, color: '#526B8B' });
  requireMethod(controller, 'setInteractionOverrides')({ ...interactionOverrides(), button_hover_background: '#27384B' });
  const submittedDraft = controller.getState().draft;

  assert.equal(await controller.save(), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'PUT');
  assert.deepEqual(requests[0].payload, {
    ...submittedDraft,
    expected_revision: 7,
    applied_player_set: player,
  });
  assert.equal(controller.getState().revision, 8);
  assert.equal(controller.getState().dirty, false);
});

test('global Cancel restores every section and its footer becomes clean', () => {
  const { controller, initial } = setup();
  controller.setPalette('paper');
  requireMethod(controller, 'setPlayerStyle')({ ...classicGreen(), handles: { color: '#FFFFFF' } });
  requireMethod(controller, 'setSelectionAccent')({ enabled: false, color: '#6E9BD0' });
  requireMethod(controller, 'setInteractionOverrides')({ ...interactionOverrides(), item_hover: '#30343A' });

  controller.cancel();
  assert.deepEqual(controller.getState().draft, editableSnapshot(initial));
  assert.equal(controller.getState().dirty, false);
  assert.equal(controller.getState().footer.dirty, false);
  assert.equal(controller.getState().footer.canSave, false);
});

test('section reset follows the page that owns each setting', () => {
  const { controller } = setup();
  controller.setCompactPlayerStyle('floating');
  controller.setInteractionOverrides({ ...interactionOverrides(), item_hover: '#35506B', button_pressed: '#785568' });
  controller.setSelectionAccent({ enabled: false, color: '#526B8B' });

  controller.resetSection('backgrounds');
  assert.equal(controller.getState().draft.compact_player_style, 'floating');
  assert.equal(controller.getState().draft.interaction_overrides.item_hover, '#35506B');

  controller.resetSection('seekbar');
  assert.equal(controller.getState().draft.compact_player_style, 'docked');

  controller.resetSection('selection-accent');
  assert.deepEqual(controller.getState().draft.selection_accent, { enabled: true, color: '#34CA78' });
  assert.deepEqual(controller.getState().draft.interaction_overrides, {
    item_hover: null,
    item_selected: null,
    button_hover_background: null,
    button_pressed: null,
    item_outline: itemOutline(),
  });
});

test('Player and Seekbar restore, compact choice, Save, Cancel, and Reset share the aggregate draft', async () => {
  const { controller, requests, initial } = setup();
  controller.restoreWaveformColors({ fill: '#005C20', edge: '#D11F1F' });
  let state = controller.getState();
  assert.equal(state.draft.player_style_override.waveform.fill, '#005C20');
  assert.equal(state.draft.player_style_override.waveform.edge, '#D11F1F');
  assert.equal(state.draft.player_override, null);
  assert.equal(state.canSave, true);

  controller.setCompactPlayerStyle('floating');
  assert.equal(controller.getState().draft.compact_player_style, 'floating');
  assert.equal(await controller.save(), true);
  assert.equal(requests[0].payload.compact_player_style, 'floating');
  assert.equal(requests[0].payload.applied_player_set.waveform.fill, '#005C20');

  controller.setCompactPlayerStyle('docked');
  controller.cancel();
  assert.equal(controller.getState().draft.compact_player_style, 'floating');
  assert.equal(controller.getState().dirty, false);

  controller.setCompactPlayerStyle('docked');
  controller.restoreWaveformColors({ fill: '#123456', edge: '#ABCDEF' });
  controller.resetSection('seekbar');
  state = controller.getState();
  assert.equal(state.draft.player_style_override, null);
  assert.equal(state.draft.compact_player_style, 'docked');
  assert.deepEqual(state.waveformColorUpdates, []);
  assert.equal(state.canSave, true);
});

test('failed and conflicted Save retain the complete draft for retry', async () => {
  for (const response of [new Error('Unavailable'), { status: 409, error: 'appearance_conflict' }]) {
    const initial = initialAppearance();
    const { controller } = setup({
      initial,
      request: async () => {
        if (response instanceof Error) throw response;
        const error = new Error(response.error);
        error.status = response.status;
        throw error;
      },
    });
    controller.setPalette('silver');
    requireMethod(controller, 'setSelectionAccent')({ enabled: true, color: '#737548' });
    const draft = controller.getState().draft;

    assert.equal(await controller.save(), false);
    assert.deepEqual(controller.getState().draft, draft);
    assert.deepEqual(controller.getState().saved, editableSnapshot(initial));
    assert.equal(controller.getState().footer.dirty, true);
    assert.equal(controller.getState().footer.canRetry, true);
  }
});

test('a revision conflict advances the server revision while retaining the draft for a successful retry', async () => {
  const initial = initialAppearance();
  let putCount = 0;
  const { controller } = setup({
    initial,
    request: async (method, payload) => {
      if (method === 'GET') return initial;
      putCount += 1;
      if (putCount === 1) {
        const error = new Error('appearance_conflict');
        error.status = 409;
        error.data = { appearance: { ...initial, revision: 8 } };
        throw error;
      }
      assert.equal(payload.expected_revision, 8);
      const { expected_revision, applied_player_set, ...draft } = payload;
      return { ...draft, revision: expected_revision + 1, player_recent_sets: initial.player_recent_sets };
    },
  });
  controller.setPalette('silver');
  const draft = controller.getState().draft;

  assert.equal(await controller.save(), false);
  assert.equal(controller.getState().revision, 8);
  assert.deepEqual(controller.getState().draft, draft);
  assert.equal(await controller.save(), true);
  assert.equal(controller.getState().revision, 9);
  assert.equal(controller.getState().dirty, false);
});

for (const action of ['cancel', 'retry']) {
  test(`conflict baseline refresh preserves the server snapshot and explicit ${action}`, async () => {
    const initial = initialAppearance();
    const serverStyle = classicGreen();
    serverStyle.surface.start = '#123456';
    const server = { ...initial, revision: 8, palette_id: 'slate', panel_index: 1,
      player_style_override: serverStyle, player_recent_sets: [serverStyle],
      waveform_recent_colors: ['#ABCDEF', '#123456'] };
    const requests = [];
    const { controller, applied } = setup({ initial, request: async (_method, payload) => {
      requests.push(payload);
      if (requests.length === 1) throw Object.assign(new Error('appearance_conflict'), {
        status: 409, data: { appearance: server },
      });
      const { expected_revision, applied_player_set, waveform_color_updates, ...draft } = payload;
      return { ...draft, revision: expected_revision + 1, player_recent_sets: server.player_recent_sets };
    } });
    controller.setPalette('silver');
    controller.restoreWaveformColors({ fill: '#345678', edge: '#56789A' });
    const before = controller.getState();
    assert.equal(await controller.save(), false);
    const conflicted = controller.getState();
    assert.deepEqual(conflicted.saved, editableSnapshot(server));
    assert.equal(conflicted.revision, 8);
    assert.deepEqual(conflicted.draft, before.draft, 'the entire draft remains available for explicit retry');
    assert.deepEqual(conflicted.waveformColorUpdates, before.waveformColorUpdates);
    assert.deepEqual(conflicted.playerRecentSets, server.player_recent_sets);
    assert.deepEqual(conflicted.recentColors, server.waveform_recent_colors);
    assert.deepEqual(applied, [editableSnapshot(server)], 'only confirmed server preferences recolor the live app');
    if (action === 'cancel') {
      controller.cancel();
      assert.deepEqual(controller.getState().draft, editableSnapshot(server));
      controller.setAlertFamily('quiet');
    }
    assert.equal(await controller.save(), true);
    assert.equal(requests[1].expected_revision, 8);
    if (action === 'cancel') {
      assert.equal(requests[1].palette_id, 'slate');
      assert.equal(requests[1].panel_index, 1);
      assert.deepEqual(requests[1].player_style_override, serverStyle);
      assert.equal(requests[1].alert_family, 'quiet');
      assert.equal(requests[1].applied_player_set, null);
      assert.equal(requests[1].waveform_color_updates, undefined);
    } else {
      assert.deepEqual(requests[1], { ...requests[0], expected_revision: 8 }, 'retry only advances the expected server revision');
    }
  });
}

for (const snapshot of [{ revision: 8 }, { ...initialAppearance(), revision: 8, player_recent_sets: ['invalid'] }]) {
  test(`conflict baseline rejects an incomplete snapshot (${Object.keys(snapshot).length} fields) atomically`, async () => {
    const { controller, applied } = setup({ request: async () => {
      throw Object.assign(new Error('appearance_conflict'), { status: 409, data: { appearance: snapshot } });
    } });
    controller.setPalette('silver');
    const before = controller.getState();
    assert.equal(await controller.save(), false);
    assert.equal(controller.getState().revision, before.revision);
    assert.deepEqual(controller.getState().saved, before.saved);
    assert.deepEqual(controller.getState().draft, before.draft);
    assert.deepEqual(applied, []);
  });
}

test('conflict baseline from a cleared account cannot restore prior state', async () => {
  let reject;
  const { controller, applied } = setup({ request: () => new Promise((_resolve, fail) => { reject = fail; }) });
  controller.setPalette('silver');
  const pending = controller.save();
  controller.clear('Session ended');
  const cleared = controller.getState();
  reject(Object.assign(new Error('appearance_conflict'), {
    status: 409, data: { appearance: { ...initialAppearance(), revision: 8 } },
  }));
  assert.equal(await pending, false);
  assert.deepEqual(controller.getState(), cleared);
  assert.deepEqual(applied, []);
});

test('EditorPage exposes one reusable global footer with contextual Reset, Cancel, and Save slots', () => {
  const source = path.join(__dirname, '../../../music_app/static/js/editor-page.js');
  assert.ok(fs.existsSync(source), 'Reusable EditorPage/EditorFooter module must exist');
  const editorPage = require(source);
  assert.equal(typeof editorPage.mountFooter, 'function');

  const container = { innerHTML: '', addEventListener(){}, removeEventListener(){} };
  editorPage.mountFooter(container, {
    dirty: true,
    canSave: true,
    resetLabel: 'Reset Player & Seekbar',
    status: 'Unsaved changes in 3 sections',
    primary: { label: 'Save', action: () => {} },
    secondary: { label: 'Cancel', action: () => {} },
  });
  assert.match(container.innerHTML, /data-editor-footer/);
  assert.match(container.innerHTML, />Reset Player &amp; Seekbar</);
  assert.match(container.innerHTML, />Cancel</);
  assert.match(container.innerHTML, />Save</);
  assert.doesNotMatch(container.innerHTML, /Save appearance/);

  const withoutMessage = { innerHTML: '', addEventListener(){}, removeEventListener(){} };
  editorPage.mountFooter(withoutMessage, { canSave: true });
  assert.doesNotMatch(withoutMessage.innerHTML, /editor-footer-status/);
  const appearanceSource = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'), 'utf8');
  assert.doesNotMatch(appearanceSource, /Appearance draft/);
});

test('shared footer runs Save after its reusable button is enabled by live editor state', () => {
  const editorPage = require('../../../music_app/static/js/editor-page.js');
  const listeners = new Map();
  const saveButton = { disabled: true };
  const container = {
    innerHTML: '',
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener() {},
  };
  let saves = 0;
  editorPage.mountFooter(container, {
    canSave: false,
    primary: { label: 'Save', action: () => { saves += 1; } },
  });
  saveButton.disabled = false;
  listeners.get('click')({
    target: { closest: () => ({ getAttribute: () => 'primary', disabled: saveButton.disabled }) },
  });
  assert.equal(saves, 1);
});

test('Appearance leave confirmation uses the app dialog instead of a browser confirm', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/appearance-backgrounds-bridge.js'), 'utf8');
  assert.match(bridge, /showAppConfirmDialog/);
  assert.doesNotMatch(bridge, /showBrowserConfirm|window\.confirm/);
});

test('Utilities provides one thin dialog-level footer slot for Appearance pages', () => {
  const template = fs.readFileSync(path.join(__dirname, '../../../music_app/templates/partials/primary-modals.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');
  const appearanceSource = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'), 'utf8');

  assert.match(template, /<div class="utility-modal-body">[\s\S]*<div class="utility-modal-footer" id="utility-modal-footer"/);
  assert.match(appearanceSource, /getElementById\?\.\('utility-modal-footer'\)/);
  assert.match(css, /\.editor-footer\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*min-height:/s);
  assert.match(css, /\.editor-footer-actions\s*\{[^}]*margin-left:\s*auto/s);
});

test('interaction overrides use seven coordinated families and the former focus shades for one outline role', () => {
  const expected = [
    ['blue', 'Blue', ['#31465D', '#3F5F7E', '#27384B', '#86B7EF', '#203246']],
    ['steel', 'Steel', ['#43545E', '#526B72', '#34434A', '#91B7C4', '#29373D']],
    ['green', 'Green', ['#3A524A', '#4F665D', '#2F443C', '#86B6A1', '#25382F']],
    ['olive', 'Olive', ['#55583A', '#737548', '#41452D', '#AAAC70', '#353823']],
    ['plum', 'Plum', ['#5B3D4E', '#785568', '#462F3C', '#B98AA3', '#38242F']],
    ['clay', 'Clay', ['#60463C', '#855F4F', '#4A352E', '#C7937D', '#3B2924']],
    ['neutral', 'Neutral', ['#4B5057', '#666B72', '#393D43', '#A1A8B0', '#2D3136']],
  ];
  const roles = ['item_hover', 'item_selected', 'button_hover_background', 'item_outline', 'button_pressed'];
  assert.deepEqual(appearance.interactionColorFamilies.map(family => [family.id, family.label, roles.map(role => family.colors[role])]), expected);
  const markup = appearance.interactionControlsMarkup();
  for (const label of ['Panel &amp; dropdown outline', 'Navigation hover', 'Navigation selected', 'Item hover background', 'Item hover &amp; keyboard focus outline', 'Item pressed']) assert.match(markup, new RegExp(`>${label}<`));
  assert.equal((markup.match(/class="appearance-interaction-row/g) || []).length, 6);
  assert.doesNotMatch(markup, /data-interaction-clear=/);
  assert.match(markup, /data-interaction-color="item_hover" data-color="#31465D"/);
  assert.match(markup, /data-item-outline-color[^>]*data-color-family="blue"[^>]*style="--swatch:#86B7EF"/);
  assert.match(markup, /data-item-outline-source="player"[^>]*>Use player colors</);
  assert.doesNotMatch(markup, />Item hover border<|>Keyboard focus<|>Button hover|>Button pressed/);
});

test('Selection and Hover has five controls, one combined outline preview, and one section-wide Use theme action', () => {
  const markup = appearance.selectionAccentMarkup();
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');
  assert.match(markup, /class="selection-hover-workspace"/);
  assert.match(markup, /class="selection-hover-controls"/);
  assert.match(markup, /class="selection-hover-preview"/);
  for (const state of ['navigation-hover', 'navigation-selected', 'item-hover-background', 'item-outline', 'item-pressed']) {
    assert.match(markup, new RegExp(`data-preview-state="${state}"`));
  }
  assert.equal((markup.match(/data-preview-state="item-outline"/g) || []).length, 1);
  assert.match(markup, /data-preview-state="item-outline"[^>]*>[\s\S]*Item hover &amp; keyboard focus outline[\s\S]*Actionable item/);
  assert.equal((markup.match(/data-interaction-use-theme/g) || []).length, 1);
  assert.match(markup, /data-interaction-use-theme[^>]*>Use theme</);
  assert.doesNotMatch(markup, /data-interaction-clear-all|>Revert to theme defaults|data-preview-state="item-hover-border"|data-preview-state="keyboard-focus"/);
  assert.match(css, /\.selection-hover-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,3fr\)\s+minmax\(220px,2fr\)/s);
  assert.match(css, /\.selection-hover-preview\s*\{[^}]*position:\s*sticky/s);
});

test('selection accents include bright presets followed by a full-spectrum picker', () => {
  const bright = ['#22D3EE', '#3B82F6', '#8B5CF6', '#EC4899', '#EF4444', '#F97316', '#FACC15', '#22C55E'];
  assert.deepEqual(appearance.brightAccentColors, bright);
  for (const color of bright) assert.ok(appearance.selectionAccentColors.includes(color));

  const markup = appearance.selectionAccentMarkup();
  const lastPreset = markup.lastIndexOf('data-aggregate-accent-color=');
  const spectrumPicker = markup.indexOf('data-aggregate-accent-custom');
  assert.ok(spectrumPicker > lastPreset, 'the full-spectrum picker must be the last accent option');
  assert.match(markup, /class="appearance-spectrum-picker"[^>]*aria-label="Choose any selection accent color"/);
  assert.match(markup, /type="color"[^>]*data-aggregate-accent-custom/);

  const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'), 'utf8');
  assert.match(source, /addEventListener\('input',[\s\S]*data-aggregate-accent-custom[\s\S]*setSelectionAccent/);
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');
  assert.match(css, /\.appearance-spectrum-picker\s*\{[^}]*conic-gradient/s);
  assert.match(css, /\.appearance-spectrum-picker\[data-selected='true'\]/);
});

test('selection-accent enable toggle preserves the rendered current color', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'), 'utf8');
  assert.match(source, /data-aggregate-accent-enabled[\s\S]*current\?\.color \|\| find\('\[data-aggregate-accent-custom\]'\)\.value[\s\S]*setSelectionAccent/);
});

test('Use theme clears interaction overrides, links the outline to theme, and keeps Selection Accent', () => {
  const initial = {
    ...initialAppearance(),
    interaction_overrides: {
      item_hover: '#31465D', item_selected: '#3F5F7E', button_hover_background: '#27384B',
      button_pressed: '#203246', item_outline: itemOutline('custom', '#86B7EF'),
    },
    selection_accent: { enabled: true, color: '#34CA78' },
  };
  const controller = appearance.createController({ initial, request: async () => initial });
  requireMethod(controller, 'useThemeInteractions')();
  assert.deepEqual(controller.getState().draft.interaction_overrides, {
    item_hover: null, item_selected: null, button_hover_background: null,
    button_pressed: null, item_outline: itemOutline('theme'),
  });
  assert.deepEqual(controller.getState().draft.selection_accent, { enabled: true, color: '#34CA78' });
});

test('item outline actions select a fixed custom swatch or relink to player colors', () => {
  const { controller } = setup();

  requireMethod(controller, 'setItemOutline')('custom', '#86b7ef');
  assert.deepEqual(controller.getState().draft.interaction_overrides.item_outline, itemOutline('custom', '#86B7EF'));
  controller.setItemOutline('player');
  assert.deepEqual(controller.getState().draft.interaction_overrides.item_outline, itemOutline('player'));
});

test('unsaved Appearance theme tokens apply only to the five live preview components', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'), 'utf8');
  assert.doesNotMatch(source, /applyDraftEditorTheme\(state\.draft, (?:editor|footerHost)\)/);
  assert.equal((source.match(/applyDraftEditorTheme\(state\.draft, preview\)/g) || []).length, 5);
  assert.match(source, /const preview = find\('\[data-background-preview\]'\);\s*applyDraftEditorTheme\(state\.draft, preview\)/);
  assert.match(source, /const preview = find\('\[data-player-live-preview\]'\);\s*applyDraftEditorTheme\(state\.draft, preview\)/);
  assert.match(source, /const preview = find\('\.selection-hover-preview'\);\s*applyDraftEditorTheme\(state\.draft, preview\)/);
  assert.match(source, /const preview = find\('\[data-alert-live-preview\]'\);\s*applyDraftEditorTheme\(state\.draft, preview\)/);
  assert.match(source, /const preview = editor\.querySelector\('\[data-album-page-live-preview\]'\);\s*applyDraftEditorTheme\(state\.draft, preview\)/);
  assert.match(source, /preview\.style\.setProperty\('--navigation-tree-selection-accent-color', accent\.color\)/);
  assert.doesNotMatch(source, /editor\.style\.setProperty\('--navigation-tree-selection-accent-color'/);
});

test('Item interaction tokens cover shared actionable controls without recoloring NavigationTree or Player', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');
  assert.match(css, /--appearance-item-action-hover-background/);
  assert.match(css, /--appearance-interaction-outline/);
  assert.match(css, /--appearance-item-action-pressed/);
  assert.match(css, /input\[type=['"]checkbox['"]\]/);
  assert.match(css, /input\[type=['"]radio['"]\]/);
  assert.match(css, /\[data-actionable\]/);
  assert.match(css, /\[role=['"]button['"]\]/);
  assert.match(css, /:not\(\.navigation-tree-item\)/);
  assert.match(css, /:not\(\.global-player \*\)/);
  assert.match(css, /:not\(:disabled\)/);
  assert.match(css, /:not\(\[aria-disabled=['"]true['"]\]\)/);
  assert.match(css, /:is\(button, \.button, \[role='button'\], \[data-actionable\]\)[^{]*:not\(\.navigation-tree-item\):not\(\.search-field-button\):not\(\.cover-lookup-task-open\):not\(\.global-player \*\):hover[^{}]*\{[^}]*border-color:\s*var\(--appearance-interaction-outline,/s);
  assert.match(css, /:is\(button, \.button, \[role='button'\], \[data-actionable\]\)[^{]*:not\(\.navigation-tree-item\):not\(\.search-field-button\):not\(\.cover-lookup-task-open\):not\(\.global-player \*\):hover[^{}]*\{[^}]*outline:\s*1px solid var\(--appearance-interaction-outline,[^;}]+;[^}]*outline-offset:\s*1px/s);
  assert.match(css, /:is\(button, input, select, \[role='button'\], \[data-actionable\]\)[^{]*:not\(\.global-player \*\)[^{]*:focus-visible[^{}]*\{[^}]*outline:\s*1px solid var\(--appearance-interaction-outline,[^;}]+;[^}]*outline-offset:\s*1px/s);
  assert.match(css, /:root\s+:is\(button, \.button, \[role='button'\], \[data-actionable\]\)[^{]*:hover[^{}]*\{[^}]*border-color:\s*var\(--appearance-interaction-outline,/s);
  assert.match(css, /:root\s+:is\(button, input, select, \[role='button'\], \[data-actionable\]\)[^{]*:not\(\.global-player \*\)[^{]*:focus-visible[^{}]*\{[^}]*outline:\s*1px solid var\(--appearance-interaction-outline,/s);
  assert.match(css, /:is\(input\[type='checkbox'\], input\[type='radio'\]\):not\(\.global-player \*\):hover:not\(:disabled\)[^{}]*\{[^}]*outline:\s*1px solid var\(--appearance-interaction-outline,/s);
  assert.match(css, /:root\[data-appearance-palette\]\s+:is\(input\[type='checkbox'\], input\[type='radio'\]\)\s*\{[^}]*accent-color:\s*var\(--appearance-accent\)/s);
  assert.doesNotMatch(css, /:root\[data-appearance-palette\][^{]*:focus-visible\s*\{[^}]*--appearance-interaction-outline/s);
});

test('interaction normalization accepts only the current closed shape or the exact rolling-upgrade legacy shape', () => {
  assert.equal(typeof appearance.normalizeInteractionOverrides, 'function');
  const normalize = appearance.normalizeInteractionOverrides;
  assert.deepEqual(normalize(interactionOverrides()), interactionOverrides());
  assert.deepEqual(normalize({
    ...interactionOverrides(),
    item_outline: itemOutline('custom', '#86b7ef'),
  }), {
    ...interactionOverrides(),
    item_outline: itemOutline('custom', '#86B7EF'),
  });
  assert.deepEqual(normalize({
    item_hover: null,
    item_selected: null,
    button_hover_background: null,
    button_hover_border: '#6E849D',
    button_pressed: null,
    focus: '#86B7EF',
  }).item_outline, itemOutline('custom', '#86B7EF'));
  assert.deepEqual(normalize({
    item_hover: null,
    item_selected: null,
    button_hover_background: null,
    button_hover_border: '#6E849D',
    button_pressed: null,
    focus: null,
  }).item_outline, itemOutline('custom', '#6E849D'));
  assert.deepEqual(normalize({
    item_hover: null,
    item_selected: null,
    button_hover_background: null,
    button_hover_border: null,
    button_pressed: null,
    focus: null,
  }).item_outline, itemOutline());

  for (const invalid of [
    { ...interactionOverrides(), extra: null },
    { ...interactionOverrides(), item_outline: { source: 'automatic' } },
    { ...interactionOverrides(), item_outline: { source: 'unknown', color: null } },
    { ...interactionOverrides(), item_outline: itemOutline('player', '#86B7EF') },
    { ...interactionOverrides(), item_outline: itemOutline('custom') },
  ]) assert.throws(() => normalize(invalid), TypeError);
});


test('correcting surface start clears the background alias error and preserves unrelated errors', async () => {
  const { controller, requests } = setup();
  controller.setPlayerColor('background', '#BADHEX');
  controller.setPlayerStyleColor('handles.color', '#INVALID');
  assert.equal(controller.getState().canSave, false);
  controller.setPlayerStyleColor('surface.start', '#345678');
  const state = controller.getState();
  assert.equal(state.errors.player_background, undefined);
  assert.equal(state.inputValues.player_background, '#345678');
  assert.equal(state.inputValues['player_style_surface.start'], '#345678');
  assert.ok(state.errors['player_style_handles.color']);
  assert.equal(state.inputValues['player_style_handles.color'], '#INVALID');
  assert.equal(await controller.save(), false);
  assert.equal(requests.length, 0);
  controller.setPlayerStyleColor('handles.color', '#456789');
  assert.equal(controller.getState().canSave, true);
  assert.equal(await controller.save(), true);
  assert.equal(requests[0].payload.player_style_override.surface.start, '#345678');
});

for (const mode of ['gradient', 'layered_gradient', 'solid']) {
  test(`Main player background edit updates and saves the active ${mode} structured style`, async () => {
    const initial = initialAppearance();
    initial.player_style_override.surface.mode = mode;
    if (mode === 'solid') initial.player_style_override.surface.end = initial.player_style_override.surface.start;
    const { controller, requests } = setup({ initial });
    controller.setPlayerColor('background', '#345678');
    const expected = structuredClone(initial.player_style_override);
    expected.surface.start = '#345678';
    if (mode === 'solid') expected.surface.end = '#345678';
    assert.deepEqual(controller.getState().draft.player_style_override, expected);
    assert.equal(controller.getState().effective.player.background, '#345678');
    assert.equal(await controller.save(), true);
    assert.deepEqual(requests[0].payload.player_style_override, expected);
    const reloaded = setup({ initial: { ...controller.getState().saved, revision: 8, player_recent_sets: [expected] } }).controller;
    assert.deepEqual(reloaded.getState().draft.player_style_override, expected);
  });
}
