const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function load() {
  const context = {state:{ui:{},status:{}},document:{getElementById:()=>null}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../../../music_app/static/js/runtime/library-warning-ui.js'),'utf8'),context);
  return context;
}

function renderScanWarning(problem, scanPageVisible = true, dismissed = true) {
  const context = load();
  const elements = new Map(['library-scan-warning']
    .map(id => [id, { innerHTML: '', hidden: true, dataset: {} }]));
  context.document.getElementById = id => elements.get(id) || null;
  elements.set('library-loader', { classList: { contains: () => scanPageVisible } });
  context.escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  context.ButtonComponent = require('../../../music_app/static/js/button-component.js');
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/alert-components.js'), 'utf8'), context);
  context.renderLibraryWarning({ watcher_health: {
    state: 'warning', warning_token: 'owned-warning', dismissed, problems: [problem],
  } });
  const notice = elements.get('library-scan-warning');
  assert.equal(notice.hidden, !scanPageVisible || !dismissed);
  return notice.innerHTML;
}

test('status refresh keeps the Library notice hidden outside the dedicated scan page', () => {
  renderScanWarning({ allowed_actions: { 'library.refresh': true } }, false);
});

test('watcher health renders a path-free Library notice with the authorized full scan action', () => {
  const html = renderScanWarning({
    state: 'overflow', root_key: 'root_1234567890abcdef',
    message: 'Private Music C:\\Private Music\\song.flac',
    allowed_actions: { 'library.refresh': true },
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /Some library changes may have been missed\./);
  assert.match(html, /class="[^"]*button[^"]*"/);
  assert.match(html, /data-status-action="full-rescan"/);
  assert.match(html, />Full Rescan</);
  assert.doesNotMatch(html, /Private Music|[A-Z]:\\|root_1234567890abcdef/);
});

test('watcher health keeps the Library notice but omits the action for a read-only reviewer', () => {
  for (const allowed_actions of [{}, { 'library.refresh': false }, { 'library.refresh': 'true' }]) {
    const html = renderScanWarning({
      state: 'root_unavailable', root_key: 'root_fedcba0987654321',
      message: 'Private Music C:\\Private Music', allowed_actions,
    });
    assert.match(html, /role="alert"/);
    assert.match(html, /A watched library folder became unavailable\./);
    assert.doesNotMatch(html, /data-status-action|Full Rescan|root_fedcba0987654321|Private Music|[A-Z]:\\/);
  }
});
test('Library warning requires acknowledgement of the current warning token', () => {
  const context = load();
  const health = { state: 'warning', warning_token: 'first' };
  assert.equal(context.libraryWarningPresentation(health, '').dismissed, false);
  assert.equal(context.libraryWarningPresentation(health, 'first').dismissed, true);
  assert.equal(context.libraryWarningPresentation({ ...health, dismissed: true }, '').dismissed, true);
  assert.equal(context.libraryWarningPresentation({ ...health, warning_token: 'second' }, 'first').dismissed, false);
  assert.equal(context.libraryWarningPresentation({ state: 'healthy' }, 'first').warning, false);
  assert.equal(renderScanWarning({ allowed_actions: { 'library.refresh': true } }, true, false), '');
});
