const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../e2e/poms/settingsModalAppBar.js')).href;

test('theme measurements compare resolved sRGB colors without browser canvas mutation', async () => {
  const { readThemeColorChannels } = await import(moduleUrl);
  const mixed = readThemeColorChannels('color-mix(in srgb, #387f68 14%, #171717)');
  [27.62, 37.56, 34.34].forEach((expected, index) => assert.ok(Math.abs(mixed[index] - expected) < 1e-9));
  assert.deepEqual(readThemeColorChannels('rgb(28, 38, 34)'), [28, 38, 34]);
  assert.deepEqual(readThemeColorChannels('color(srgb 0.1 0.2 0.3)'), [25.5, 51, 76.5]);
});

test('theme measurements reject unsupported colors instead of accepting an observed value', async () => {
  const { readThemeColorChannels } = await import(moduleUrl);
  assert.throws(() => readThemeColorChannels('var(--unresolved-color)'), /Unsupported/);
});

test('hover measurements await real finite transitions before sampling color', async () => {
  const { SettingsModalAppBar } = await import(moduleUrl);
  let settled = false;
  const transition = { effect: { getComputedTiming: () => ({ endTime: 120 }) }, finished: Promise.resolve().then(() => { settled = true; }) };
  const element = { getAnimations: () => [transition] };
  const original = global.getComputedStyle;
  global.getComputedStyle = () => {
    assert.equal(settled, true);
    return { getPropertyValue: () => '#171717', backgroundColor: 'rgb(23, 23, 23)' };
  };
  try {
    const pending = SettingsModalAppBar.prototype.readAdminHoverTheme.call({ adminPanelMenuItem: { evaluate: callback => callback(element) } });
    const measured = await pending;
    assert.deepEqual(measured.actual, [23, 23, 23]);
    measured.expected.forEach(channel => assert.ok(Math.abs(channel - 23) < 1e-9));
  } finally { global.getComputedStyle = original; }
});

test('shared account hover uses independent text/panel tokens and rejects the waveform hover color', async () => {
  const { SettingsModalAppBar } = await import(moduleUrl);
  const original = global.getComputedStyle;
  const tokens = { '--text': '#eeeeee', '--panel': '#171717', '--appearance-item-hover': 'rgb(28, 38, 34)' };
  let backgroundColor = 'rgb(34, 34, 34)';
  global.getComputedStyle = () => ({ getPropertyValue: name => tokens[name] || '', backgroundColor });
  const owner = { adminPanelMenuItem: { evaluate: callback => callback({ getAnimations: () => [] }) } };
  const assertHover = measurement => measurement.expected.forEach((channel, index) => {
    assert.ok(Math.abs(channel - measurement.actual[index]) <= 1, 'each hover channel must match the shared baseline within 1');
  });
  try {
    const correct = await SettingsModalAppBar.prototype.readAdminHoverTheme.call(owner);
    correct.expected.forEach(channel => assert.ok(Math.abs(channel - 33.75) < 1e-9));
    assertHover(correct);
    backgroundColor = tokens['--appearance-item-hover'];
    const wrong = await SettingsModalAppBar.prototype.readAdminHoverTheme.call(owner);
    assert.throws(() => assertHover(wrong), /each hover channel/);
  } finally { global.getComputedStyle = original; }
});
