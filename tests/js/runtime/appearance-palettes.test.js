const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appearanceCss = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');

const runtime = () => require(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'));
const defaults = () => ({
  main_surface_color: null, panel_background_color: null,
  palette_id: null, panel_index: 0, player_override: null, compact_player_style: 'docked',
  album_details_layout: 'classic_bar', album_playing_row_animation: 'enabled',
  alert_family: 'ember',
});
const green = () => ({ background: '#112820', fill: '#79B390', edge: '#DCEBE3' });
const steel = () => ({ background: '#14283B', fill: '#8BAED1', edge: '#B9CADD' });
const powder = () => ({ background: '#CBDEED', fill: '#4F7398', edge: '#395571' });
const playerStyle = () => ({
  surface: { mode: 'gradient', angle: 0, start: '#0A2F24', end: '#0A1422' },
  controls: { fill: '#24B86B', border: '#86EFAC' },
  waveform: { fill: '#387F68', edge: '#AFD8C2' },
  handles: { color: '#AFD8C2' },
});
const interactions = source => ({
  item_hover: null,
  item_selected: null,
  button_hover_background: null,
  button_pressed: null,
  item_outline: { source, color: source === 'custom' ? '#86B7EF' : null },
});

function setup(overrides = {}) {
  const requests = [], applied = [];
  const controller = runtime().createController({
    initial: defaults(),
    request: async (method, payload) => { requests.push({ method, payload }); return payload || defaults(); },
    apply: (preference) => applied.push(preference),
    ...overrides,
  });
  return { controller, requests, applied };
}

test('empty cover artwork follows the active main-elements palette', () => {
  assert.match(appearanceCss, /:root\[data-appearance-palette\][^{]*\.track-modal-cover-shell \.cover-placeholder/);
  assert.match(appearanceCss, /:root\[data-appearance-palette\][^{]*\.utility-detail-cover-placeholder/);
  assert.match(appearanceCss, /background:\s*linear-gradient\([^;]*var\(--appearance-card\)[^;]*var\(--appearance-main-surface\)[^;]*var\(--appearance-control\)/s);
  assert.match(appearanceCss, /color:\s*var\(--appearance-muted\)/);
  assert.match(appearanceCss, /border-color:\s*var\(--appearance-line\)/);
});

test('Artist Family filters and gallery options follow the active palette interaction tokens', () => {
  assert.match(appearanceCss, /:root\[data-appearance-palette\][^{]*\.gallery-options-floating-button\s*\{[^}]*background:\s*var\(--appearance-control\)[^}]*color:\s*var\(--appearance-ink\)[^}]*border-color:\s*var\(--appearance-line\)/s);
  assert.match(appearanceCss, /:root\[data-appearance-palette\][^{]*\.related-box\s*\{[^}]*background:\s*var\(--appearance-card\)[^}]*border-color:\s*var\(--appearance-line\)[^}]*color:\s*var\(--appearance-ink\)/s);
  assert.match(appearanceCss, /:root\[data-appearance-palette\][^{]*\.related-chip\s*\{[^}]*background:\s*var\(--appearance-control\)[^}]*border-color:\s*var\(--appearance-line\)[^}]*color:\s*var\(--appearance-ink\)/s);
  assert.match(appearanceCss, /:root:is\(\[data-appearance-palette\], \[data-appearance-item-hover\]\) \.related-chip:hover\s*\{[^}]*background:\s*var\(--appearance-item-hover,\s*var\(--appearance-hover\)\)/s);
  assert.match(appearanceCss, /:root\[data-appearance-palette\] \.related-chip:hover\s*\{[^}]*color:\s*var\(--appearance-ink\)/s);
  assert.match(appearanceCss, /:root:is\(\[data-appearance-palette\], \[data-appearance-item-selected\]\) \.related-chip\.active\s*\{[^}]*background:\s*var\(--appearance-item-selected,\s*var\(--appearance-hover\)\)/s);
  assert.match(appearanceCss, /:root\[data-appearance-palette\] \.related-chip\.active\s*\{[^}]*color:\s*var\(--appearance-ink\)/s);
});

test('light palettes render the notification glyph with contrast-safe palette ink', () => {
  assert.match(appearanceCss, /:root\[data-appearance-mode='light'\] \.cover-lookup-drawer-glyph img\s*\{[^}]*opacity:\s*0/s);
  assert.match(appearanceCss, /:root\[data-appearance-mode='light'\] \.cover-lookup-drawer-glyph::before\s*\{[^}]*background:\s*var\(--appearance-ink\)[^}]*mask-image:\s*url\('\/static\/images\/cover-lookup-notification-icon-offwhite\.png'\)/s);
});

test('the approved eleven palettes expose three panel companions and coordinated player colors', () => {
  assert.deepEqual(runtime().palettes.map(palette => palette.id), [
    'steelblue', 'navy', 'powderblue', 'graphite', 'slate', 'midnight',
    'black', 'blackgray', 'paper', 'silver', 'coollight',
  ]);
  for (const palette of runtime().palettes) {
    assert.equal(palette.panels.length, 3);
    for (let index = 0; index < 3; index++) {
      const effective = runtime().resolveAppearance({ ...defaults(), palette_id: palette.id, panel_index: index });
      assert.equal(effective.main, palette.main);
      assert.equal(effective.panel, palette.panels[index][1]);
      assert.match(effective.player.background, /^#[0-9A-F]{6}$/i);
      assert.match(effective.player.fill, /^#[0-9A-F]{6}$/i);
      assert.match(effective.player.edge, /^#[0-9A-F]{6}$/i);
    }
  }
  assert.deepEqual(runtime().resolveAppearance({ ...defaults(), palette_id: 'steelblue' }).player, steel());
  assert.deepEqual(runtime().resolveAppearance({ ...defaults(), palette_id: 'powderblue' }).player, powder());
});

test('every Main elements palette provides a coordinated selection accent', () => {
  assert.deepEqual(Object.fromEntries(runtime().palettes.map(palette => [palette.id, palette.selectionAccent])), {
    steelblue: '#8BAED1',
    navy: '#91B4E3',
    powderblue: '#4F7398',
    graphite: '#8A96A3',
    slate: '#7896B4',
    midnight: '#8297CC',
    black: '#1DB954',
    blackgray: '#BDBDBD',
    paper: '#596775',
    silver: '#596775',
    coollight: '#526E8B',
  });
});

test('palette and companion edits stay in the preview and save one complete preference', async () => {
  const { controller, requests, applied } = setup();
  controller.setPalette('steelblue');
  controller.setPanelIndex(2);
  const expected = { ...defaults(), palette_id: 'steelblue', panel_index: 2 };
  assert.deepEqual(controller.getState().draft, expected);
  assert.deepEqual(controller.getState().saved, defaults());
  assert.deepEqual(applied, []);
  assert.equal(await controller.save(), true);
  assert.deepEqual(requests, [{ method: 'PUT', payload: expected }]);
  assert.deepEqual(applied, [expected]);
  assert.equal(controller.getState().canSave, false);
});

test('compact player style shares the Appearance draft and saves with the canonical preference', async () => {
  const { controller, requests } = setup();
  controller.setCompactPlayerStyle('floating');
  assert.equal(controller.getState().draft.compact_player_style, 'floating');
  assert.throws(() => controller.setCompactPlayerStyle('unknown'), TypeError);
  assert.equal(await controller.save(), true);
  assert.equal(requests[0].payload.compact_player_style, 'floating');
});

test('unknown palette, invalid companion and unknown player mode cannot alter the draft', () => {
  const { controller } = setup();
  controller.setPalette('steelblue');
  const before = controller.getState().draft;
  assert.throws(() => controller.setPalette('unapproved'), TypeError);
  for (const invalid of [-1, 3, true, '1', 1.5]) {
    assert.throws(() => controller.setPanelIndex(invalid), TypeError);
  }
  assert.throws(() => controller.setPlayerMode('unapproved'), TypeError);
  assert.deepEqual(controller.getState().draft, before);
});

test('Custom player colors copies all effective values and survives palette, panel and background reset', () => {
  const { controller } = setup();
  controller.setPalette('steelblue');
  controller.setPlayerMode('custom');
  assert.deepEqual(controller.getState().draft.player_override, steel());
  for (const [field, value] of Object.entries(green())) controller.setPlayerColor(field, value.toLowerCase());
  controller.setPalette('powderblue');
  controller.setPanelIndex(1);
  assert.deepEqual(controller.getState().draft.player_override, green());
  assert.deepEqual(runtime().resolveAppearance(controller.getState().draft).player, green());
  controller.reset();
  assert.deepEqual(controller.getState().draft, { ...defaults(), player_override: green() });
  assert.deepEqual(runtime().resolveAppearance(controller.getState().draft).player, green());
});

test('Match palette clears the whole custom group and all three effective colors follow the palette again', () => {
  const { controller } = setup({ initial: { ...defaults(), palette_id: 'steelblue', player_override: green() } });
  controller.setPalette('powderblue');
  assert.deepEqual(runtime().resolveAppearance(controller.getState().draft).player, green());
  controller.setPlayerMode('palette');
  assert.equal(controller.getState().draft.player_override, null);
  assert.deepEqual(runtime().resolveAppearance(controller.getState().draft).player, powder());
  controller.setPalette('steelblue');
  assert.deepEqual(runtime().resolveAppearance(controller.getState().draft).player, steel());
});

test('invalid fill stays invalid after a valid edge edit and blocks the entire save', async () => {
  const { controller, requests } = setup();
  controller.setPalette('steelblue');
  controller.setPlayerMode('custom');
  controller.setPlayerColor('fill', '#GG0000');
  assert.equal(controller.getState().draft.player_override.fill, steel().fill);
  assert.equal(controller.getState().canSave, false);
  controller.setPlayerColor('edge', '#123456');
  assert.equal(controller.getState().draft.player_override.edge, '#123456');
  assert.equal(controller.getState().canSave, false);
  assert.ok(Object.values(controller.getState().errors).some(Boolean));
  assert.equal(await controller.save(), false);
  assert.deepEqual(requests, []);
  controller.setPlayerColor('fill', '#abcdef');
  assert.equal(controller.getState().canSave, true);
  assert.equal(controller.getState().draft.player_override.fill, '#ABCDEF');
});

test('Cancel restores the saved nested player group after edits, resets and palette changes', () => {
  const saved = { ...defaults(), palette_id: 'steelblue', panel_index: 2, player_override: green() };
  const { controller, applied } = setup({ initial: saved });
  controller.setPlayerColor('background', '#000000');
  controller.setPalette('paper');
  controller.reset();
  controller.cancel();
  assert.deepEqual(controller.getState().draft, saved);
  assert.deepEqual(controller.getState().saved, saved);
  assert.deepEqual(saved.player_override, green());
  assert.equal(controller.getState().dirty, false);
  assert.deepEqual(applied, []);
});

test('failed grouped save retains every draft value and retry applies the complete server preference', async () => {
  let fail = true;
  const { controller, applied } = setup({ request: async (_method, payload) => {
    if (fail) throw new Error('Appearance unavailable');
    return payload;
  } });
  controller.setPalette('powderblue');
  controller.setPanelIndex(1);
  controller.setPlayerMode('custom');
  controller.setPlayerColor('fill', '#FFAACC');
  const draft = controller.getState().draft;
  assert.equal(await controller.save(), false);
  assert.deepEqual(controller.getState().draft, draft);
  assert.deepEqual(controller.getState().saved, defaults());
  assert.ok(controller.getState().error);
  assert.deepEqual(applied, []);
  fail = false;
  assert.equal(await controller.save(), true);
  assert.deepEqual(applied, [draft]);
});

test('load failure leaves grouped preferences untrusted until a successful full reload', async () => {
  let fail = true;
  const saved = { ...defaults(), palette_id: 'paper', panel_index: 1, player_override: green() };
  const { controller, applied } = setup({ request: async () => {
    if (fail) throw new Error('Offline');
    return { ...saved, csrf_token: 'account-session-token' };
  } });
  assert.equal(await controller.load(), false);
  assert.equal(controller.getState().canSave, false);
  assert.deepEqual(applied, []);
  fail = false;
  assert.equal(await controller.load(), true);
  assert.deepEqual(controller.getState().saved, saved);
  assert.deepEqual(controller.getState().draft, saved);
  assert.deepEqual(applied, [saved]);
});

test('session clear discards palette and custom waveform group and rejects a late save', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const { controller, applied } = setup({
    initial: { ...defaults(), palette_id: 'steelblue', player_override: green() },
    request: () => pending,
  });
  controller.setPalette('paper');
  const submitted = controller.getState().draft;
  const saving = controller.save();
  controller.clear();
  resolve(submitted);
  assert.equal(await saving, false);
  assert.deepEqual(controller.getState().saved, defaults());
  assert.deepEqual(controller.getState().draft, defaults());
  assert.equal(controller.getState().canSave, false);
  assert.deepEqual(applied, []);
});

test('aggregate palette edits coordinate selection accent while preserving interaction and player sections', () => {
  const customPlayerStyle = playerStyle();
  const initial = {
    ...defaults(),
    revision: 9,
    interaction_overrides: interactions('automatic'),
    selection_accent: { enabled: true, color: '#526B8B' },
    player_style_override: customPlayerStyle,
    player_recent_sets: [customPlayerStyle],
  };
  const { controller } = setup({ initial });
  controller.setPalette('slate');
  const state = controller.getState();

  assert.equal(state.revision, 9);
  assert.deepEqual(state.draft.interaction_overrides, initial.interaction_overrides);
  assert.deepEqual(state.draft.selection_accent, { enabled: true, color: '#7896B4' });
  assert.deepEqual(state.draft.player_style_override, customPlayerStyle);
  assert.deepEqual(state.playerRecentSets, [customPlayerStyle]);
});

test('automatic, theme, player, and custom outline sources resolve against the effective Appearance', () => {
  const api = runtime();
  assert.equal(typeof api.resolveInteractionOutline, 'function');
  const base = { ...defaults(), palette_id: 'steelblue', panel_index: 0 };
  const themeEffective = api.resolveAppearance(base);
  const customPlayer = playerStyle();
  const playerEffective = api.resolveAppearance({ ...base, player_override: customPlayer });

  assert.equal(api.resolveInteractionOutline({
    ...base,
    interaction_overrides: interactions('automatic'),
    player_style_override: null,
  }, themeEffective), themeEffective.tokens.accent);
  assert.equal(api.resolveInteractionOutline({
    ...base,
    interaction_overrides: interactions('automatic'),
    player_style_override: customPlayer,
  }, playerEffective), customPlayer.controls.border);
  assert.equal(api.resolveInteractionOutline({
    ...base,
    interaction_overrides: interactions('theme'),
    player_style_override: customPlayer,
  }, playerEffective), playerEffective.tokens.accent);
  assert.equal(api.resolveInteractionOutline({
    ...base,
    interaction_overrides: interactions('player'),
    player_style_override: customPlayer,
  }, playerEffective), customPlayer.controls.border);
  assert.equal(api.resolveInteractionOutline({
    ...base,
    interaction_overrides: interactions('custom'),
    player_style_override: customPlayer,
  }, playerEffective), '#86B7EF');
});

test('saved theme application publishes the resolved player-aware interaction outline token', () => {
  const properties = new Map();
  const root = {
    style: {
      setProperty(name, value) { properties.set(name, value); },
      removeProperty(name) { properties.delete(name); },
    },
    setAttribute() {},
    removeAttribute() {},
  };
  const customPlayer = playerStyle();

  runtime().applyTheme({
    ...defaults(),
    palette_id: 'steelblue',
    interaction_overrides: interactions('automatic'),
    selection_accent: { enabled: true, color: '#8BAED1' },
    player_style_override: customPlayer,
  }, root);

  assert.equal(properties.get('--appearance-interaction-outline'), customPlayer.controls.border);
});


for (const paletteId of [null, ...runtime().palettes.map(palette => palette.id)]) {
  test(`resolved player palette ${paletteId || 'default'} supplies every CSS player token`, () => {
    const { tokens } = runtime().resolveAppearance({ ...defaults(), palette_id: paletteId });
    for (const key of ['player', 'player-surface-start', 'player-surface-end', 'player-ink', 'play', 'play-ink', 'player-control-border', 'player-handle']) {
      assert.match(tokens[key] || '', /^#[0-9A-F]{6}$/i, key);
    }
    assert.match(tokens['player-surface-angle'] || '', /^\d+(?:\.\d+)?deg$/);
  });
}

for (const background of ['#101820', '#F0F4F8']) {
  test(`legacy player control ink contrasts with the resolved ${background} control fill`, () => {
    const api = runtime();
    const { tokens } = api.resolveAppearance({ ...defaults(), player_override: { background, fill: '#4D8D70', edge: '#9DCEB2' } });
    assert.ok(api.contrastRatio(tokens['play'], tokens['play-ink']) >= 4.5);
  });
}
