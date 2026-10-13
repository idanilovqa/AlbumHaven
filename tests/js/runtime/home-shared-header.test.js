const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
const source = name => path.join(repo, 'music_app/static/js/home-friends', name);
function exportsFor(name) {
  assert.ok(fs.existsSync(source(name)), `PRODUCT_NOT_IMPLEMENTED: ${name}`);
  const code = buildSync({entryPoints: [source(name)], bundle: true, platform: 'node', format: 'cjs',
    write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  const mod = new Module(`${__filename}.${name}.cjs`, module); mod.filename = mod.id; mod.paths = module.paths;
  mod._compile(code, mod.filename); return mod.exports;
}
function native() {
  const env = createNativeHomeRuntime();
  return {document: env.document, runtime: {buttonHtml: config => env.context.ButtonComponent.renderButton(config),
    actionHtml: config => env.context.ButtonComponent.renderActionButton(config), iconHtml: name => env.context.ButtonComponent.renderIconSvg(name), openChoice() {},
    artboxHtml: config => env.context.buildAlbumArtboxHtml(config), alertHtml: config => env.context.buildOnPageAlertHtml(config)}};
}
const markup = (component, props) => renderToStaticMarkup(React.createElement(component, props));
function parsed(document, html) {const host = document.createElement('div'); host.innerHTML = html; return host;}

// This is pure arithmetic over measured inputs, never simulated DOM geometry.
test('header fit uses measured content budgets including every inter-group gap', async () => {
  assert.ok(fs.existsSync(source('header-layout.mjs')), 'PRODUCT_NOT_IMPLEMENTED: measured header budget owner');
  const {headerActionsFit: fit} = await import(pathToFileURL(source('header-layout.mjs')).href);
  assert.equal(typeof fit, 'function');
  for (const [input, expected] of [
    [{availableWidth: 308, identityWidth: 100, actionsWidth: 200, gap: 8}, true],
    [{availableWidth: 307.99, identityWidth: 100, actionsWidth: 200, gap: 8}, false],
    [{availableWidth: 356, identityWidth: 100, actionsWidth: 200, outsideWidth: 40, gap: 8}, true],
    [{availableWidth: 355.99, identityWidth: 100, actionsWidth: 200, outsideWidth: 40, gap: 8}, false],
    [{availableWidth: 700, identityWidth: 420, actionsWidth: 300, gap: 8}, false],
    [{availableWidth: 300, identityWidth: 40, actionsWidth: 100, gap: 8}, true],
    [{availableWidth: 0, identityWidth: 0, actionsWidth: 0, gap: 0}, false],
    [{availableWidth: 250.5, identityWidth: 50.25, actionsWidth: 190.25, gap: 10}, true],
  ]) assert.equal(fit(input), expected, JSON.stringify(input));
});

test('header fit rejects unusable measurement inputs rather than declaring room', async () => {
  assert.ok(fs.existsSync(source('header-layout.mjs')), 'PRODUCT_NOT_IMPLEMENTED: measured header budget owner');
  const {headerActionsFit: fit} = await import(pathToFileURL(source('header-layout.mjs')).href);
  const valid = {availableWidth: 1000, identityWidth: 100, actionsWidth: 200, outsideWidth: 40, gap: 8};
  for (const field of Object.keys(valid)) for (const value of [NaN, Infinity, -1]) {
    assert.equal(fit({...valid, [field]: value}), false, `${field}: ${value}`);
  }
});

test('SharedHeader owns one native Tools disclosure and mounts each original slot once', () => {
  const {SharedHeader} = exportsFor('shared-header.jsx'), {runtime, document} = native();
  const mark = label => React.createElement('button', {key: label, 'data-test-slot': label, type: 'button'}, label);
  const host = parsed(document, markup(SharedHeader, {runtime, id: 'recent', identity: mark('identity'),
    leading: mark('leading'), actions: [mark('Reset'), mark('Missing')], outsideActions: mark('View'), finalAction: mark('Collapse')}));
  const header = host.querySelector('[data-shared-header="recent"]'); assert.ok(header);
  const tools = header.querySelector('[data-header-tools]'); assert.ok(tools);
  const trigger = tools.tagName === 'BUTTON' ? tools : tools.querySelector('button');
  assert.ok(trigger); assert.equal(trigger.getAttribute('type'), 'button');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.ok(trigger.getAttribute('aria-controls'));
  const capsule = header.querySelector('[data-header-action-capsule]'); assert.ok(capsule);
  assert.equal(capsule.id, trigger.getAttribute('aria-controls'));
  for (const label of ['identity', 'leading', 'Reset', 'Missing', 'View', 'Collapse']) {
    assert.equal(host.querySelectorAll(`[data-test-slot="${label}"]`).length, 1, `${label} retains one owner`);
  }
  assert.equal(capsule.querySelectorAll('[data-test-slot="Reset"]').length, 1);
  assert.equal(capsule.querySelectorAll('[data-test-slot="Missing"]').length, 1);
  assert.equal(capsule.querySelectorAll('[data-test-slot="identity"]').length, 0);
});

test('Period closed control is icon-only while native choice retains readable selected option', () => {
  const {Period} = exportsFor('components.jsx'), {runtime, document} = native();
  for (const [value, label] of [['week', 'Last week'], ['month', 'Last month'], ['six', 'Last 6 months'], ['year', 'Last year'], ['all', 'All time']]) {
    const host = parsed(document, markup(Period, {runtime, value, total: 99, range: 'Server private range', onChange() {}}));
    const button = host.querySelector('button'); assert.ok(button);
    assert.equal(button.textContent.trim(), '', 'closed control does not repeat period text');
    assert.match(button.getAttribute('aria-label'), new RegExp(label));
    assert.equal(button.getAttribute('aria-haspopup'), 'menu');
    assert.ok(button.querySelector('svg'), 'icon is visible');
    assert.equal(host.querySelectorAll('.home-friends__range').length, 0);
    assert.equal(host.querySelectorAll('.home-friends__listens').length, 0, 'count belongs beside identity');
  }
});

test('listens badge keeps zero distinct from unknown and escapes server labels', () => {
  const {ListensBadge} = exportsFor('shared-header.jsx'), {runtime, document} = native();
  for (const [total, expected] of [[0, '0'], [124, '124'], [null, '–'], [undefined, '–']]) {
    const host = parsed(document, markup(ListensBadge, {runtime, total, range: 'Range <safe>'}));
    assert.match(host.textContent, new RegExp(expected));
    assert.ok(host.querySelector('svg'), 'listens count has a megaphone icon');
    assert.equal(host.querySelectorAll('safe').length, 0);
  }
});

test('SharedHeader preserves caller-selected final action priority without inspecting or duplicating controls', () => {
  const {SharedHeader} = exportsFor('shared-header.jsx'), {runtime, document} = native();
  const mark = label => React.createElement('button', {key: label, 'data-test-slot': label, type: 'button'}, label);
  for (const order of [['Collapse'], ['Collapse', 'More actions'], ['Collapse', 'More actions', 'Close']]) {
    const host = parsed(document, markup(SharedHeader, {runtime, id: 'tail', leading: mark('Expand'), identity: mark('Identity'),
      actions: [mark('Reset'), mark('Missing')], outsideActions: mark('View'), finalAction: order.map(mark)}));
    const capsule = host.querySelector('[data-header-action-capsule]'); assert.ok(capsule);
    const actual = capsule.querySelectorAll('[data-test-slot]').map(node => node.getAttribute('data-test-slot'));
    assert.deepEqual(actual.slice(-order.length), order, 'caller tail order is retained at the end of capsule');
    assert.equal(capsule.querySelectorAll('[data-test-slot="Expand"]').length, 0, 'leading expansion remains outside capsule');
    for (const label of ['Expand', 'Identity', 'Reset', 'Missing', 'View', ...order]) {
      assert.equal(host.querySelectorAll(`[data-test-slot="${label}"]`).length, 1, `${label} has one original slot`);
    }
  }
});
