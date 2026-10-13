const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');

const root = path.resolve(process.env.ALBUMHAVEN_FRONTEND_ROOT || path.join(__dirname, '../../..'));
const local = createRequire(path.join(root, 'package.json'));
const React = local('react');
const {renderToStaticMarkup} = local('react-dom/server');
const {buildSync} = local('esbuild');
const {createNativeHomeRuntime} = local('./tests/js/runtime/native-home-harness.cjs');
const code = buildSync({
  entryPoints: [path.join(root, 'music_app/static/js/home-friends/components.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react-dom'],
}).outputFiles[0].text;
const loaded = {exports: {}};
vm.runInNewContext(code, {module: loaded, exports: loaded.exports, require: local});
const {Tabs} = loaded.exports;

// Actual installed React and React DOM server render the unmodified wrapper.
// The existing native fixture only parses the resulting markup; its production
// tabs renderer is loaded unchanged. No React hooks are replaced. SSR does not
// run layout effects, mount listeners, hydrate, exercise focus, or prove that a
// mounted component reconciles changed IDs. Browser coverage is separate.
function render(items, value = 'albums') {
  const native = createNativeHomeRuntime();
  const filename = path.join(root, 'music_app/static/js/runtime/in-page-tabs.js');
  vm.runInContext(fs.readFileSync(filename, 'utf8'), native.context, {filename});
  const runtime = {
    tabsHtml: options => native.context.buildInPageTabsHtml(options),
    mountTabs() { assert.fail('SSR must not mount native listeners'); },
  };
  const markup = renderToStaticMarkup(React.createElement(Tabs, {
    runtime, id: 'search-result-tabs', label: 'Search result types', items, value,
    onChange() { assert.fail('SSR must not dispatch selection changes'); },
  }));
  const host = native.document.createElement('div');
  host.innerHTML = markup;
  const tablist = host.querySelector('[role="tablist"]');
  assert.ok(tablist, 'the actual native tablist survives React SSR');
  assert.equal(tablist.id, 'search-result-tabs');
  assert.equal(tablist.getAttribute('aria-label'), 'Search result types');
  assert.equal(host.querySelectorAll('[role="tablist"]').length, 1);
  assert.equal(host.querySelectorAll('[role="tab"]').length, items.length);
  assert.deepEqual(native.forbiddenCalls, []);
  return {markup, tablist, tab: key => tablist.querySelector(`[data-in-page-tab="${key}"]`)};
}

function assertSelection(button, selected, disabled = false) {
  assert.ok(button);
  assert.equal(button.getAttribute('aria-selected'), String(selected));
  assert.equal(button.getAttribute('tabindex'), selected ? '0' : '-1');
  assert.equal(button.hasAttribute('disabled'), disabled);
  assert.equal(button.getAttribute('aria-disabled'), disabled ? 'true' : null);
}

test('actual React SSR forwards each shared Tabs panelId into native aria-controls', () => {
  const view = render([
    ['albums', 'Albums', {panelId: 'search-album-results'}],
    ['tracks', 'Tracks', {panelId: 'search-track-results'}],
  ]);
  assert.equal(view.tab('albums').getAttribute('aria-controls'), 'search-album-results');
  assert.equal(view.tab('tracks').getAttribute('aria-controls'), 'search-track-results');
  assert.equal(view.tab('albums').id, 'search-result-tabs-albums');
  assert.equal(view.tab('tracks').id, 'search-result-tabs-tracks');
  assertSelection(view.tab('albums'), true);
  assertSelection(view.tab('tracks'), false);
});

test('actual React SSR keeps existing shared Tabs consumers without panelId unchanged', () => {
  const view = render([
    ['albums', 'Albums'],
    ['tracks', 'Tracks', {}],
  ], 'tracks');
  for (const key of ['albums', 'tracks']) {
    assert.equal(view.tab(key).hasAttribute('aria-controls'), false);
  }
  assertSelection(view.tab('albums'), false);
  assertSelection(view.tab('tracks'), true);
  assert.equal(view.tab('albums').textContent, 'Albums');
  assert.equal(view.tab('tracks').textContent, 'Tracks');
});

test('actual React SSR preserves disabled tabs and native enabled-selection fallback', () => {
  const view = render([
    ['albums', 'Albums', {disabled: true, panelId: 'disabled-album-results'}],
    ['tracks', 'Tracks', {panelId: 'enabled-track-results'}],
  ], 'albums');
  assertSelection(view.tab('albums'), false, true);
  assertSelection(view.tab('tracks'), true);
  assert.equal(view.tab('albums').getAttribute('aria-controls'), 'disabled-album-results');
  assert.equal(view.tab('tracks').getAttribute('aria-controls'), 'enabled-track-results');
});

test('fresh actual React SSR with updated props renders new panel IDs without stale associations', () => {
  const previous = render([
    ['albums', 'Albums', {panelId: 'previous-album-results'}],
    ['tracks', 'Tracks', {panelId: 'previous-track-results'}],
  ]);
  const updated = render([
    ['albums', 'Albums', {panelId: 'current-album-results'}],
    ['tracks', 'Tracks', {panelId: 'current-track-results'}],
  ], 'tracks');
  assert.equal(previous.tab('albums').getAttribute('aria-controls'), 'previous-album-results');
  assert.equal(previous.tab('tracks').getAttribute('aria-controls'), 'previous-track-results');
  assert.equal(updated.tab('albums').getAttribute('aria-controls'), 'current-album-results');
  assert.equal(updated.tab('tracks').getAttribute('aria-controls'), 'current-track-results');
  assert.doesNotMatch(updated.markup, /previous-(?:album|track)-results/);
  assertSelection(updated.tab('albums'), false);
  assertSelection(updated.tab('tracks'), true);
});
