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
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

test('buildUtilityIntegrationDetail renders the Foobar help-first detail contract', () => {
  const context = loadHelpers();

  const html = context.buildUtilityIntegrationDetail({
    key: 'foobar',
    title: 'Foobar2000',
    description: 'Help-first setup, manual export references, and local sync contract prep.',
    status_label: 'How To and reference assets ready',
    help_route: '/utilities/integrations/foobar/help',
    problem_surface: 'Utilities > Problematic Files',
    continuous_sync: {
      label: 'Continuous Foobar sync',
      enabled: false,
      default_state: 'off',
      cadence_when_enabled: 'Once a week',
      disabled_behavior: 'One-time import only',
    },
    source_families: [
      {
        key: 'manual_snapshot_exports',
        title: 'Manual snapshot exports',
        description: 'Playback Statistics XML and Text Tools exports stay one-time user-triggered snapshots.',
      },
      {
        key: 'live_custom_db',
        title: 'Live custom DB source',
        description: 'A selected Foobar custom DB path stays one-time import only until Continuous Foobar sync is enabled.',
      },
    ],
    write_back_scopes: ['History of plays', 'Favorite songs'],
    reference_assets: [
      {
        asset_key: 'how-to-modal-copy',
        title: 'How To modal copy',
        description: 'Exact checked-in help copy baseline.',
        view_url: '/utilities/integrations/foobar/assets/how-to-modal-copy',
        download_url: '/utilities/integrations/foobar/assets/how-to-modal-copy?download=1',
      },
      {
        asset_key: 'text-tools-standard-preset',
        title: 'Standard Text Tools preset',
        description: 'Recommended default preset.',
        view_url: '/utilities/integrations/foobar/assets/text-tools-standard-preset',
        download_url: '/utilities/integrations/foobar/assets/text-tools-standard-preset?download=1',
      },
    ],
  });

  assert.match(html, /Foobar2000/);
  assert.match(html, /How To and reference assets ready/);
  assert.match(html, /Continuous Foobar sync/);
  assert.match(html, /One-time import only/);
  assert.match(html, /History of plays/);
  assert.match(html, /Favorite songs/);
  assert.match(html, /Utilities &gt; Problematic Files/);
  assert.match(html, /Manual snapshot exports/);
  assert.match(html, /Live custom DB source/);
  assert.match(html, /href="\/utilities\/integrations\/foobar\/assets\/how-to-modal-copy"/);
  assert.match(html, /href="\/utilities\/integrations\/foobar\/assets\/text-tools-standard-preset\?download=1"/);
});
