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
        localPlaylistImport: {
          selectedFileName: '',
          selectedFile: null,
          analyzeBusy: false,
          error: '',
          lastAnalysis: null,
        },
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

test('buildUtilityIntegrationDetail renders the local playlist import analyze surface', () => {
  const context = loadHelpers();

  const html = context.buildUtilityIntegrationDetail({
    key: 'local_playlist_import',
    title: 'Import Local Playlist',
    description: 'Separate Utilities analyze/preview seam for local playlist files before parser and persistence work land.',
    status_label: 'Analyze/preview contract ready',
    analyze_route: '/utilities/imports/local-playlists/analyze',
    import_route: '/utilities/imports/local-playlists/import',
    supported_extensions: ['.fpl', '.m3u', '.m3u8', '.pls'],
    target_options: [
      { key: 'playlist', title: 'Playlist', description: 'Phase 3 default target.' },
      { key: 'album_top', title: 'Album Top', description: 'Blocked until later analyzer work.' },
    ],
    local_library_completion: {
      status: 'preview_direction_reserved',
      label: 'Completion & preview direction reserved',
      detail: 'Later analyzer work will show missing tracks.',
    },
    import_status: {
      can_import: false,
      label: 'Final import execution lands later',
      detail: 'Phase 3 stops at validation plus preview-shape prep.',
    },
  });

  assert.match(html, /Import Local Playlist/);
  assert.match(html, /Analyze\/preview contract ready/);
  assert.match(html, /data-local-playlist-import-file/);
  assert.match(html, /data-analyze-local-playlist="1"/);
  assert.match(html, /Supports: \.fpl, \.m3u, \.m3u8, \.pls/);
  assert.match(html, /Completion &amp; preview direction reserved/);
  assert.doesNotMatch(html, /Completion &amp;amp; preview direction reserved/);
  assert.match(html, /Phase 3 default target\./);
  assert.match(html, /Blocked until later analyzer work\./);
});

test('buildUtilityIntegrationDetail renders returned local playlist preview status', () => {
  const context = loadHelpers({
    state: {
      utility: {
        localPlaylistImport: {
          selectedFileName: '2026.fpl',
          selectedFile: null,
          analyzeBusy: false,
          error: '',
          lastAnalysis: {
            status: {
              key: 'preview_contract_ready',
              label: 'Preview contract ready',
              detail: 'Phase 3 validates the selected file and returns the future analysis shape before parser work lands.',
            },
            source: {
              filename: '2026.fpl',
              extension: '.fpl',
              source_kind: 'foobar_fpl',
              parser_mode: 'binary_adapter_reserved',
              size_bytes: 3,
            },
            target_recommendation: {
              recommended_target: 'playlist',
              allowed_targets: ['playlist'],
              blocked_targets: [
                { key: 'album_top', reason: 'Album-group matching and local-library completion analysis land in later phases.' },
              ],
            },
            local_library_completion: {
              status: 'preview_direction_reserved',
              label: 'Completion preview direction reserved',
              detail: 'Later analyzer work will show missing tracks and local-library completion candidates before Album Top creation.',
            },
            preview: {
              normalized_rows: [],
              album_groups: [],
              unresolved_rows: [],
            },
            import_status: {
              can_import: false,
              label: 'Parser and import execution land later',
              detail: 'This Phase 3 seam stops at validation plus preview-shape prep.',
            },
          },
        },
        integrationDrafts: {
          lastfm: {
            username: '',
            password: '',
            timezone: '',
          },
        },
      },
    },
  });

  const html = context.buildUtilityIntegrationDetail({
    key: 'local_playlist_import',
    title: 'Import Local Playlist',
    description: 'Separate Utilities analyze/preview seam for local playlist files before parser and persistence work land.',
    status_label: 'Analyze/preview contract ready',
    analyze_route: '/utilities/imports/local-playlists/analyze',
    import_route: '/utilities/imports/local-playlists/import',
    supported_extensions: ['.fpl'],
    target_options: [],
    local_library_completion: {
      status: 'preview_direction_reserved',
      label: 'Completion preview direction reserved',
      detail: 'Later analyzer work will show missing tracks.',
    },
    import_status: {
      can_import: false,
      label: 'Final import execution lands later',
      detail: 'Phase 3 stops at validation plus preview-shape prep.',
    },
  });

  assert.match(html, /2026\.fpl/);
  assert.match(html, /foobar_fpl/);
  assert.match(html, /binary_adapter_reserved/);
  assert.match(html, /Recommended target: playlist/);
  assert.match(html, /Album Top unavailable: Album-group matching and local-library completion analysis land in later phases\./);
});
