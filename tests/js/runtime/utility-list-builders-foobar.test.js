const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-list-builders.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelpers(overrides = {}) {
  const context = {
    state: {
      utility: {
        integrationDrafts: {
          lastfm: {
            username: '',
            password: '',
            timezone: '',
          },
        },
      },
    },
    escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    },
    buildUtilityLibrarySettingsDetail() {
      return '<div>Library settings</div>';
    },
    buildUtilityCollapsibleSection(_key, title, content) {
      return `<section><h4>${title}</h4>${content}</section>`;
    },
    formatLogHistoryTimestamp(value) {
      return value;
    },
    getDetectedBrowserTimeZone() {
      return 'America/Denver';
    },
    getSupportedBrowserTimeZones() {
      return ['America/Denver'];
    },
    groupProblemIgnoreItems() {
      return [];
    },
    getProblemIgnoreGroupTitle() {
      return 'Ignored';
    },
    showRepairAlert() {},
  };
  Object.assign(context, overrides);
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), '../button-component.js'), 'utf8'), context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

function installPolicy(context, actions) {
  context.document = {
    readyState: 'complete',
    getElementById: id => id === 'capability-bootstrap'
      ? { textContent: JSON.stringify({ allowed_actions: actions, available_tabs: ['integrations'] }) } : null,
    querySelectorAll: () => [],
  };
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), '../capability-ui.js'), 'utf8'), context);
}

test('buildUtilityIntegrationDetail mounts the current Foobar account importer without library administration', () => {
  const context = loadHelpers();
  installPolicy(context, { 'account.self.foobar.write': true });
  const html = context.buildUtilityIntegrationDetail({ key: 'foobar', title: 'Foobar2000' });
  assert.match(html, /Foobar2000/);
  assert.match(html, /data-foobar-import-host/);
  assert.match(html, /Loading import controls/);
  assert.doesNotMatch(html, /data-foobar-format-trigger|Playback Statistics XML|Import is unavailable in this build|data-foobar-help/);
});

test('buildUtilityIntegrationDetail denies Foobar mount when capability bootstrap is absent', () => {
  const html = loadHelpers().buildUtilityIntegrationDetail({ key: 'foobar' });
  assert.match(html, /Foobar import is unavailable/);
  assert.doesNotMatch(html, /data-foobar-import-host/);
});

test('buildUtilityIntegrationDetail denies Foobar mount for explicit denial and administrative-only grants', () => {
  for (const actions of [
    { 'account.self.foobar.write': false },
    { 'library.settings.manage': true, 'integration.settings.read': true, 'accounts.read': true },
  ]) {
    const context = loadHelpers();
    installPolicy(context, actions);
    const html = context.buildUtilityIntegrationDetail({ key: 'foobar' });
    assert.match(html, /Foobar import is unavailable/);
    assert.doesNotMatch(html, /data-foobar-import-host/);
  }
});
