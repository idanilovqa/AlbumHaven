const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appearanceCss = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/appearance-backgrounds.css'), 'utf8');
const galleryCardCss = fs.readFileSync(path.join(__dirname, '../../../music_app/static/css/runtime/non-album-and-player.css'), 'utf8');

const runtime = () => require(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'));
const defaults = () => ({
  main_surface_color: null, panel_background_color: null,
  palette_id: null, panel_index: 0, player_override: null, compact_player_style: 'docked',
  docked_compact_player_behavior: 'follow_sidebar',
  docked_compact_player_regular_style: false,
  compact_player_motion: 'normal', floating_player_edge: { source: 'player', color: null },
  album_details_layout: 'classic_bar', album_playing_row_animation: 'enabled',
  alert_family: 'ember', loop_control_style: 'capsule',
  action_button_outlines: true, device_profiles: {},
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
  assert.match(appearanceCss, /:root\[data-appearance-palette\][^{]*:is\(\.related-box, \.artist-family-panel\)\s*\{[^}]*background:\s*var\(--appearance-card\)[^}]*border-color:\s*var\(--appearance-line\)[^}]*color:\s*var\(--appearance-ink\)/s);
  assert.match(appearanceCss, /:root\[data-appearance-palette\][^{]*\.artist-family-panel__artist\s*\{[^}]*background:\s*var\(--appearance-card\)/s);
  assert.match(appearanceCss, /:root:is\(\[data-appearance-palette\], \[data-appearance-item-hover\]\)[^{]*\.artist-family-panel__artist:hover\s*\{[^}]*background:\s*var\(--appearance-card\)/s);
  assert.match(appearanceCss, /:root\[data-appearance-palette\] :is\(\.related-chip, \.artist-family-panel__artist\):hover\s*\{[^}]*color:\s*var\(--appearance-ink\)/s);
  assert.match(appearanceCss, /:root:is\(\[data-appearance-palette\], \[data-appearance-item-selected\]\)[^{]*\.artist-family-panel__artist\.is-active\s*\{[^}]*background:\s*var\(--appearance-card\)/s);
  assert.match(appearanceCss, /:root\[data-appearance-palette\] :is\(\.related-chip\.active, \.artist-family-panel__artist\.is-active\)\s*\{[^}]*color:\s*var\(--appearance-ink\)/s);
});

test('light palettes render the notification glyph with contrast-safe palette ink', () => {
  assert.match(appearanceCss, /:root\[data-appearance-mode='light'\] \.cover-lookup-drawer-glyph img\s*\{[^}]*opacity:\s*0/s);
  assert.match(appearanceCss, /:root\[data-appearance-mode='light'\] \.cover-lookup-drawer-glyph::before\s*\{[^}]*background:\s*var\(--appearance-ink\)[^}]*mask-image:\s*url\('\/static\/images\/cover-lookup-notification-icon-offwhite\.png'\)/s);
});

test('the approved palettes expose three panel companions and coordinated player colors', () => {
  assert.deepEqual(runtime().palettes.map(palette => palette.id), [
    'steelblue', 'navy', 'harbor-mint', 'powderblue', 'graphite', 'slate', 'midnight',
    'black', 'blackgray', 'paper', 'silver', 'coollight', 'parchment-pine',
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
    'harbor-mint': '#52D7AA',
    powderblue: '#4F7398',
    graphite: '#8A96A3',
    slate: '#7896B4',
    midnight: '#8297CC',
    black: '#1DB954',
    blackgray: '#BDBDBD',
    paper: '#596775',
    silver: '#596775',
    coollight: '#526E8B',
    'parchment-pine': '#51B67D',
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
  }, playerEffective), playerEffective.tokens['player-control-border']);
  assert.equal(api.resolveInteractionOutline({
    ...base,
    interaction_overrides: interactions('theme'),
    player_style_override: customPlayer,
  }, playerEffective), playerEffective.tokens.accent);
  assert.equal(api.resolveInteractionOutline({
    ...base,
    interaction_overrides: interactions('player'),
    player_style_override: customPlayer,
  }, playerEffective), playerEffective.tokens['player-control-border']);
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

  assert.equal(properties.get('--appearance-interaction-outline'), runtime().resolveAppearance({
    ...defaults(), palette_id: 'steelblue', player_override: customPlayer,
  }).tokens['player-control-border']);
});

test('Harbor Mint resolves the approved surfaces, mint controls and player for every companion', () => {
  const api = runtime();
  const palette = api.palettes.find(item => item.id === 'harbor-mint');
  assert.ok(palette, 'Harbor Mint must be selectable');
  assert.equal(palette.name, 'Harbor Mint');
  const companions = ['#0E1B29', '#091522', '#1D3445'];
  companions.forEach((panel, panel_index) => {
    const effective = api.resolveAppearance({ ...defaults(), palette_id: 'harbor-mint', panel_index });
    assert.equal(effective.main, '#111E2C');
    assert.equal(effective.panel, panel);
    for (const [role, color] of Object.entries({
      ink: '#E6EDF5', muted: '#9AAFC2', control: '#203043',
      accent: '#52D7AA', play: '#52D7AA', player: '#0E1B29',
    })) assert.equal(effective.tokens[role], color, role);
    assert.deepEqual(effective.player, { background: '#0E1B29', fill: '#52D7AA', edge: '#9AAFC2' });
  });
});

test('Harbor Mint saves its companion while retaining custom player colors through reset', async () => {
  const { controller, requests, applied } = setup({ initial: { ...defaults(), player_override: green() } });
  controller.setPalette('harbor-mint');
  controller.setPanelIndex(2);
  const expected = { ...defaults(), palette_id: 'harbor-mint', panel_index: 2, player_override: green() };
  assert.deepEqual(applied, []);
  assert.deepEqual(runtime().resolveAppearance(controller.getState().draft).player, green());
  assert.equal(await controller.save(), true);
  assert.deepEqual(requests, [{ method: 'PUT', payload: expected }]);
  assert.deepEqual(applied, [expected]);
  controller.reset();
  assert.deepEqual(controller.getState().draft, { ...defaults(), player_override: green() });
  controller.cancel();
  assert.deepEqual(controller.getState().draft, expected);
  controller.setPlayerMode('palette');
  assert.deepEqual(runtime().resolveAppearance(controller.getState().draft).player, {
    background: '#0E1B29', fill: '#52D7AA', edge: '#9AAFC2',
  });
});

test('light palettes use a black Gallery Artbox hover frame', () => {
  assert.match(appearanceCss, /:root\[data-appearance-mode='light'\]\s*\{[^}]*--gallery-artbox-hover-frame:\s*#000;/s);
  assert.match(galleryCardCss, /\.album-card:hover,[^}]*border-color:\s*var\(--gallery-artbox-hover-frame,/s);
  assert.match(galleryCardCss, /\.album-card:hover \.cover::after,[^}]*border-color:\s*var\(--gallery-artbox-hover-frame,/s);
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
test('Parchment & Pine resolves its three dark companions on the approved light canvas', () => {
  const api = runtime();
  const palette = api.palettes.find(item => item.id === 'parchment-pine');
  assert.ok(palette, 'Parchment & Pine must be selectable');
  assert.equal(palette.name, 'Parchment & Pine');
  assert.equal(palette.panels.length, 3);
  ['#101512', '#11241D', '#15241B'].forEach((panel, panel_index) => {
    const effective = api.resolveAppearance({ ...defaults(), palette_id: palette.id, panel_index });
    assert.equal(effective.mode, 'light');
    assert.equal(effective.main, '#E8E0CF');
    assert.equal(effective.panel, panel);
    for (const [role, color] of Object.entries({
      ink: '#393C32', muted: '#777C6C', line: '#C7C4B4',
      'panel-ink': '#E2F0E5', 'panel-muted': '#98A79B', 'panel-line': '#354237',
    'panel-control': '#202422', 'floating-edge': '#101512',
      player: '#10251E', 'player-ink': '#D7E4DA',
      play: '#38B977', 'play-ink': '#083820', focus: '#81DFA9',
    })) assert.equal(effective.tokens[role], color, role);
  });
});

test('Parchment & Pine uses a dark default selection fill for every NavigationTree item', () => {
  assert.match(
    appearanceCss,
    /data-appearance-palette='parchment-pine'\]:not\(\[data-appearance-item-selected\]\) \.navigation-tree-item\s*\{[^}]*--selection-body-background:\s*color-mix\(in srgb, var\(--appearance-panel-ink\) 18%, var\(--appearance-panel-background\)\);/,
  );
});

test('Parchment & Pine keeps Artist Info on the light card color roles', () => {
  const darkChromeRule = appearanceCss.match(
    /:root\[data-appearance-palette='parchment-pine'\] :is\(([\s\S]*?)\)\s*\{[\s\S]*?--appearance-panel-ink/,
  );
  assert.ok(darkChromeRule);
  assert.doesNotMatch(darkChromeRule[1], /\.artist-info-overlay/);
});

test('Parchment & Pine gives content cards and controls distinct beige surfaces', () => {
  const palette = runtime().palettes.find(item => item.id === 'parchment-pine');
  assert.equal(palette.tokens.card, '#FFF7E5');
  assert.equal(palette.tokens.control, '#C8B58F');
  assert.notEqual(palette.tokens.card, palette.main);
  assert.notEqual(palette.tokens.control, palette.main);
});

test('Appearance settings use the selected panel companion instead of imitating the main canvas', () => {
  assert.match(appearanceCss, /\.appearance-background-editor\s*\{[^}]*background:\s*var\(--appearance-panel-background\);/s);
  assert.match(appearanceCss, /\.background-family\s*\{[^}]*background:\s*var\(--appearance-panel-background\);/s);
  assert.doesNotMatch(appearanceCss, /data-appearance-palette='parchment-pine'\] \.appearance-background-editor/);
});

test('Parchment & Pine retains an explicit custom player group for every companion', () => {
  const player_override = { background: '#123456', fill: '#ABCDEF', edge: '#987654' };
  for (const panel_index of [0, 1, 2]) {
    const effective = runtime().resolveAppearance({
      ...defaults(), palette_id: 'parchment-pine', panel_index, player_override,
    });
    assert.deepEqual(effective.player, player_override);
    assert.equal(effective.main, '#E8E0CF');
  }
});

test('Parchment & Pine panel roles reset when returning to an existing palette', () => {
  const properties = new Map();
  const root = {
    style: { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) },
    setAttribute() {}, removeAttribute() {},
  };
  const api = runtime();
  api.applyTheme({ ...defaults(), palette_id: 'parchment-pine' }, root);
  assert.equal(properties.get('--appearance-panel-ink'), '#E2F0E5');
  api.applyTheme({ ...defaults(), palette_id: 'paper' }, root);
  const expected = api.resolveAppearance({ ...defaults(), palette_id: 'paper' }).tokens;
  for (const role of ['ink', 'muted', 'line']) {
    assert.equal(properties.get('--appearance-panel-' + role), expected[role], role);
  }
  api.applyTheme(defaults(), root);
  for (const role of ['ink', 'muted', 'line', 'control', 'color-scheme']) {
    assert.equal(properties.has('--appearance-panel-' + role), false, role);
  }
  assert.equal(properties.has('--appearance-floating-edge'), false);
});
