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

function renderScanWarning(problem, {
  scanPageVisible = true,
  dismissed = true,
  repairRequired = false,
  problems = [problem],
} = {}) {
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
    state: 'warning', warning_token: 'owned-warning', dismissed,
    repair_required: repairRequired, problems,
  } });
  const notice = elements.get('library-scan-warning');
  assert.equal(notice.hidden, !scanPageVisible);
  return notice.innerHTML;
}

test('status refresh keeps the Library notice hidden outside the dedicated scan page', () => {
  renderScanWarning(
    { allowed_actions: { 'library.refresh': true } },
    { scanPageVisible: false },
  );
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

test('repair-required watcher health reuses the full-rescan action as Repair library', () => {
  const html = renderScanWarning({
    state: 'overflow',
    allowed_actions: { 'library.refresh': true },
  }, { repairRequired: true });
  assert.match(html, /data-status-action="full-rescan"/);
  assert.match(html, />Repair library</);
  assert.doesNotMatch(html, />Full Rescan</);
});

test('repair-required watcher health omits the action for a read-only reviewer', () => {
  for (const allowed_actions of [{}, { 'library.refresh': false }, { 'library.refresh': 'true' }]) {
    const html = renderScanWarning({
      state: 'root_unavailable', root_key: 'root_fedcba0987654321',
      message: 'Private Music C:\\Private Music', allowed_actions,
    }, { repairRequired: true });
    assert.match(html, /role="alert"/);
    assert.match(html, /A watched library folder became unavailable\./);
    assert.doesNotMatch(
      html,
      /data-status-action|Repair library|Full Rescan|root_fedcba0987654321|Private Music|[A-Z]:\\/,
    );
  }
});

test('Library Status renders every operational incident without private path data', () => {
  const html = renderScanWarning(null, {
    repairRequired: true,
    problems: [
      {
        state: 'overflow',
        root_key: 'root_1234567890abcdef',
        message: 'Private Music C:\\Private Music\\song.flac',
        allowed_actions: { 'library.refresh': true },
      },
      {
        state: 'rollback_pending_work',
        root_key: 'root_fedcba0987654321',
        message: '/srv/private/music/album.flac',
        allowed_actions: { 'library.refresh': true },
      },
    ],
  });

  assert.equal((html.match(/data-operational-item/g) || []).length, 2);
  const alertContentStart = html.indexOf('class="on-page-alert__content"');
  const operationalListStart = html.search(/<(?:ul|ol)\b[^>]*>/);
  const operationalItemIndexes = [...html.matchAll(/data-operational-item/g)]
    .map((match) => match.index);
  const firstOperationalItem = operationalItemIndexes[0];
  const actionsStart = html.indexOf('class="on-page-alert__actions"');
  assert.ok(alertContentStart >= 0, 'Operational incidents must stay inside alert content.');
  assert.ok(
    operationalListStart > alertContentStart && operationalListStart < firstOperationalItem,
    'Operational incidents must render in a semantic list inside alert content.',
  );
  assert.ok(
    actionsStart === -1 || operationalItemIndexes.every((index) => index < actionsStart),
    'Operational incidents must never render inside the alert actions boundary.',
  );
  assert.doesNotMatch(
    html,
    /Private Music|[A-Z]:\\|\/srv\/private|root_1234567890abcdef|root_fedcba0987654321/,
  );
});
test('Library warning requires acknowledgement of the current warning token', () => {
  const context = load();
  const health = { state: 'warning', warning_token: 'first' };
  assert.equal(context.libraryWarningPresentation(health, '').dismissed, false);
  assert.equal(context.libraryWarningPresentation(health, 'first').dismissed, true);
  assert.equal(context.libraryWarningPresentation({ ...health, dismissed: true }, '').dismissed, true);
  assert.equal(context.libraryWarningPresentation({ ...health, warning_token: 'second' }, 'first').dismissed, false);
  assert.equal(context.libraryWarningPresentation({ state: 'healthy' }, 'first').warning, false);
});

test('Library Status keeps an acknowledged unresolved incident visible', () => {
  const html = renderScanWarning({
    state: 'overflow',
    incident_id: '11111111-1111-1111-1111-111111111111',
    acknowledged: true,
    allowed_actions: { 'library.refresh': true },
  }, { dismissed: true, repairRequired: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /data-operational-item/);
  assert.match(html, />Repair library</);
});

test('Library Health visibility changes once per transition and stays quiet on repeated status renders', () => {
  const context = load();
  let hidden = true;
  const healthWrites = [];
  const health = {
    get hidden() { return hidden; },
    set hidden(value) { healthWrites.push(value); hidden = value; },
  };
  const notice = { hidden: true, innerHTML: '' };
  const loader = { classList: { toggle() {} } };
  context.document.getElementById = id => ({
    'library-health': health, 'library-scan-warning': notice, 'library-loader': loader,
  }[id] || null);
  context.buildOnPageAlertHtml = () => '<div role="alert">Library warning</div>';
  const healthy = { watcher_health: { state: 'healthy' } };
  context.renderLibraryWarning(healthy, { scanPageVisible: false });
  context.renderLibraryWarning(healthy, { scanPageVisible: false });
  assert.deepEqual(healthWrites, []);
  const warning = { watcher_health: { state: 'warning', dismissed: true, problems: [] } };
  context.renderLibraryWarning(warning, { scanPageVisible: false });
  assert.deepEqual(healthWrites, []);
  context.renderLibraryWarning(warning, { scanPageVisible: true });
  context.renderLibraryWarning(warning, { scanPageVisible: true });
  assert.deepEqual(healthWrites, [false]);
  assert.equal(notice.hidden, false);
  context.renderLibraryWarning(warning, { scanPageVisible: false });
  context.renderLibraryWarning(healthy, { scanPageVisible: false });
  assert.deepEqual(healthWrites, [false, true]);
  assert.equal(notice.hidden, true);
});
