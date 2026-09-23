const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
function load(names, overrides = {}) {
  const context = vm.createContext({
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    ...overrides,
  });
  for (const name of ['alert-components', ...names]) {
    vm.runInContext(fs.readFileSync(path.join(runtime, `${name}.js`), 'utf8'), context);
  }
  return context;
}

test('log history retains stale status semantics and escapes failure details in shared alerts', () => {
  const context = load(['utility-log-history-ui'], {
    window: { ButtonComponent: { renderButton: () => '<button>Refresh</button>' } },
  });
  context.canExportUtilityLogHistory = () => false;
  context.buildConsoleLog = () => '';
  const html = context.buildUtilityLogHistoryConsole({ items: [], stale: true, error: '<script>failure</script>' });
  assert.match(html, /role="status"[^>]*data-on-page-alert="info"/);
  assert.match(html, /New activity is available\. Refresh to capture it\./);
  assert.match(html, /data-on-page-alert="error"/);
  assert.match(html, /&lt;script&gt;failure&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('failed saved-loop loading has one shared alert and keeps loading distinct', () => {
  const elements = { overlay: { hidden: false }, list: { innerHTML: 'old rows' }, detail: { classList: { add() {} }, innerHTML: '' }, count: {} };
  const context = load(['utility-renderers-and-actions'], {
    state: { utility: { loopsLoadError: '<unavailable>' } },
    getUtilityModalElements: () => elements,
    getFilteredUtilityLoops: () => [],
  });
  context.renderUtilityLoops();
  assert.equal(elements.list.innerHTML, '');
  assert.match(elements.detail.innerHTML, /data-on-page-alert="error"/);
  assert.match(elements.detail.innerHTML, /&lt;unavailable&gt;/);
  context.state.utility.loopsLoading = true;
  context.renderUtilityLoops();
  assert.match(elements.detail.innerHTML, /Loading loops/);
  assert.doesNotMatch(elements.detail.innerHTML, /data-on-page-alert/);
});
