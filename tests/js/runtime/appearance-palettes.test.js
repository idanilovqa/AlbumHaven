const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const runtime = () => require(path.join(__dirname, '../../../music_app/static/js/appearance-backgrounds.js'));
const defaults = () => ({
  main_surface_color: null, panel_background_color: null,
  palette_id: null, panel_index: 0, player_override: null,
});
const green = () => ({ background: '#112820', fill: '#79B390', edge: '#DCEBE3' });
const steel = () => ({ background: '#14283B', fill: '#8BAED1', edge: '#B9CADD' });
const powder = () => ({ background: '#CBDEED', fill: '#4F7398', edge: '#395571' });

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
