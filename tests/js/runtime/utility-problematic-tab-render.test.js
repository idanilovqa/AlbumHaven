const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { loadPendingProjectionFetch } = require('../helpers/pending-projection-fetch');

const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const rendererPath = path.join(runtimeRoot, 'utility-renderers-and-actions.js');
const loaderPath = path.join(runtimeRoot, 'utility-loaders-and-cover-lookup.js');
const TAB_RENDERERS = [
  'renderProblematicFiles', 'renderUtilityRules', 'renderUtilityLoops', 'renderUtilityLogHistory',
  'renderUtilityIntegrations', 'renderUtilityAppearance', 'renderUtilityAndroid',
];

// The real renderer and Problematic Files loaders, with every tab's renderer recorded instead of drawn.
function loadSettings({ activeTab = 'problematic-files', fetch } = {}) {
  const rendered = [];
  const context = {
    Promise,
    console: { info() {}, warn() {}, error() {} },
    window: { performance: { now: () => 0 } },
    state: {
      utility: {
        activeTab, problematicFiles: [], loaded: false, loading: false, loadPromise: null, detailLoadPromises: {},
        selectedProblematicKey: '', problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    getUtilityModalElements: () => ({
      tabs: [], overlay: { hidden: false, setAttribute() {}, removeAttribute() {} },
      list: { dataset: {} }, detail: { classList: { remove() {} }, setAttribute() {} },
    }),
    scheduleBrowserAnimationFrame(callback) { callback(); return 1; },
    scheduleBrowserTimeout() { return 0; },
    clearBrowserTimeout() { return true; },
    showToast() {},
    fetch,
  };
  vm.createContext(context);
  loadPendingProjectionFetch(context);
  vm.runInContext(fs.readFileSync(rendererPath, 'utf8'), context, { filename: rendererPath });
  vm.runInContext(fs.readFileSync(loaderPath, 'utf8'), context, { filename: loaderPath });
  for (const name of TAB_RENDERERS) context[name] = () => rendered.push([name, context.state.utility.activeTab]);
  context.disposeProblematicFilesVirtualList = () => {};
  context.isUtilityModalOpen = () => true;
  return { context, rendered };
}

const summary = () => ({
  ok: true, status: 200, async json() { return { complete: true, items: [{ key: 'a', name: 'A', detail_loaded: false }] }; },
});

test('the bounded-interaction guard sees no other tab renderer reached from the Problematic Files loaders', () => {
  // The loaders drew through the generic per-tab dispatcher, so the guard charged every tab's rendering to
  // Problematic Files. They now reach that tab's renderer alone.
  const { analyzeJavaScriptSources } = require('../../../scripts/ci/bounded-interaction-discovery.cjs');
  const { hazards } = analyzeJavaScriptSources({
    'music_app/static/js/runtime/utility-renderers-and-actions.js': fs.readFileSync(rendererPath, 'utf8'),
    'music_app/static/js/runtime/utility-loaders-and-cover-lookup.js': fs.readFileSync(loaderPath, 'utf8'),
  });
  const otherTabs = TAB_RENDERERS.filter((name) => name !== 'renderProblematicFiles');
  const reached = hazards
    .filter((hazard) => /#(loadProblematicFiles|loadNextProblematicArtistPage)\b/.test(String(hazard.entrypoint))
      || ['loadProblematicFiles', 'loadNextProblematicArtistPage'].includes((hazard.via || [])[0]))
    .flatMap((hazard) => (hazard.via || []).filter((name) => otherTabs.includes(name)));
  assert.deepEqual([...new Set(reached)], []);
});

test('loading Problematic Files draws only that tab, never another tab renderer', async () => {
  const { context, rendered } = loadSettings({ fetch: async () => summary() });

  await context.loadProblematicFiles(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(rendered.length >= 1, 'the open Problematic Files tab is drawn');
  assert.deepEqual([...new Set(rendered.map(([name]) => name))], ['renderProblematicFiles']);
});

test('a tab switch while Problematic Files loads leaves the newly open tab to its own loader', async () => {
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const { context, rendered } = loadSettings({ fetch: () => response });

  const load = context.loadProblematicFiles(true);
  const beforeSwitch = rendered.length;
  context.state.utility.activeTab = 'loops';
  release(summary());
  await load;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(rendered.slice(beforeSwitch), [], 'the load draws nothing once its tab is no longer open');
  assert.ok(rendered.slice(0, beforeSwitch).every(([name, tab]) => name === 'renderProblematicFiles'
    && tab === 'problematic-files'), 'before the switch it drew only its own tab');
});
