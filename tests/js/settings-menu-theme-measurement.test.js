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
  const element = { getAnimations: () => [transition], ownerDocument: { documentElement: { hasAttribute: () => false } } };
  const original = global.getComputedStyle;
  global.getComputedStyle = () => {
    assert.equal(settled, true);
    return { getPropertyValue: () => '#171717', backgroundColor: 'rgb(23, 45, 67)' };
  };
  try {
    const pending = SettingsModalAppBar.prototype.readAdminHoverTheme.call({ adminPanelMenuItem: { evaluate: callback => callback(element) } });
    const measured = await pending;
    assert.deepEqual(measured.actual, [23, 45, 67]);
    assert.deepEqual(measured.expected, [23, 45, 67]);
  } finally { global.getComputedStyle = original; }
});

test('default account hover protects the approved navy color even when unused appearance tokens exist', async () => {
  const { SettingsModalAppBar } = await import(moduleUrl);
  const original = global.getComputedStyle;
  const tokens = { '--text': '#eeeeee', '--panel': '#171717', '--appearance-item-hover': 'rgb(28, 38, 34)' };
  let backgroundColor = 'rgb(23, 45, 67)';
  global.getComputedStyle = () => ({ getPropertyValue: name => tokens[name] || '', backgroundColor });
  const element = { getAnimations: () => [], ownerDocument: { documentElement: { hasAttribute: () => false } } };
  const owner = { adminPanelMenuItem: { evaluate: callback => callback(element) } };
  const assertHover = measurement => measurement.expected.forEach((channel, index) => {
    assert.ok(Math.abs(channel - measurement.actual[index]) <= 1, 'each hover channel must match the approved account-menu color within 1');
  });
  try {
    const correct = await SettingsModalAppBar.prototype.readAdminHoverTheme.call(owner);
    assert.deepEqual(correct.expected, [23, 45, 67]);
    assertHover(correct);
    backgroundColor = 'rgb(34, 34, 34)';
    const wrong = await SettingsModalAppBar.prototype.readAdminHoverTheme.call(owner);
    assert.throws(() => assertHover(wrong), /each hover channel/);
  } finally { global.getComputedStyle = original; }
});

for (const attribute of ['data-appearance-palette', 'data-appearance-item-hover']) {
  test(`explicit ${attribute} uses the saved row-hover token without accepting arbitrary observed colors`, async () => {
    const { SettingsModalAppBar } = await import(moduleUrl);
    const original = global.getComputedStyle;
    const tokens = { '--appearance-item-hover': '#387f68', '--appearance-hover': '#abcdef' };
    global.getComputedStyle = () => ({ getPropertyValue: name => tokens[name] || '', backgroundColor: 'rgb(56, 127, 104)' });
    const element = { getAnimations: () => [], ownerDocument: { documentElement: { hasAttribute: name => name === attribute } } };
    try {
      const result = await SettingsModalAppBar.prototype.readAdminHoverTheme.call({ adminPanelMenuItem: { evaluate: callback => callback(element) } });
      assert.deepEqual(result.expected, [56, 127, 104]);
      assert.deepEqual(result.actual, result.expected);
    } finally { global.getComputedStyle = original; }
  });
}
