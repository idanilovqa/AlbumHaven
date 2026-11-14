// The guard's own regression suite: reintroduce the historical unbounded
// mechanisms into real application sources (in memory only) and require the
// real registry validator to report every one of them. A defect the guard
// does not catch fails this test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateRepository } = require('../../scripts/ci/validate-bounded-interactions.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function inject(overrides, file, anchor, replacement) {
  const source = overrides[file] ?? fs.readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n');
  assert.ok(source.includes(anchor), `seeded defect anchor is missing from ${file}: ${anchor}`);
  overrides[file] = source.replace(anchor, replacement);
}

const DEFECTS = [
  {
    id: 'BI-H01 direct row scan inside a registered scroll handler',
    language: 'js',
    file: 'music_app/static/js/runtime/problematic-files-virtual-list.js',
    anchor: "list.addEventListener('scroll', schedule, { passive: true });",
    replacement: "list.addEventListener('scroll', () => { list.querySelectorAll('[data-problematic-row]').forEach(row => row.classList.add('seen')); schedule(); }, { passive: true });",
    expected: /^rejected BI-01 querySelectorAll at music_app\/static\/js\/runtime\/problematic-files-virtual-list\.js:\d+ from js:music_app\/static\/js\/runtime\/problematic-files-virtual-list\.js#create:event:scroll$/,
  },
  {
    id: 'BI-H01 library-wide row sync reached through a helper from a statically proven handler',
    language: 'js',
    file: 'music_app/static/js/runtime/mobile-navigation.js',
    anchor: "pageOutlet?.addEventListener('scroll', scheduleMobileAlbumThumbnail, { passive: true });",
    replacement: "pageOutlet?.addEventListener('scroll', () => { scheduleMobileAlbumThumbnail(); syncSeededLooseTrackRows(); }, { passive: true });\n"
      + "  function syncSeededLooseTrackRows() { state.view.non_album_tracks.forEach(track => track.visible = true); }",
    expected: /^js:runtime\/mobile-navigation\.js#initMobileNavigation: \d+ reachable hazard\(s\) need a runtime contract \(forEach at /,
  },
  {
    id: 'BI-H17 Home URL routed through generic view-data',
    language: 'js',
    file: 'music_app/static/js/runtime/view-state-helpers.js',
    anchor: "options.omitSidebar ? '/home-data?omit_sidebar=1' : '/home-data';",
    replacement: "options.omitSidebar ? '/home-data?omit_sidebar=1' : '/view-data?surface=home';",
    expected: /^rejected BI-04 route-owner:\/view-data\?surface=home at music_app\/static\/js\/runtime\/view-state-helpers\.js:\d+/,
  },
  {
    id: 'BI-H13 status poll that also fetches broad library data',
    language: 'js',
    file: 'music_app/static/js/runtime/gallery-refresh-and-status.js',
    anchor: "const response = await fetch('/status');",
    replacement: "const response = await fetch('/status');\n    await fetch('/view-data?include_non_album=1');",
    expected: /^js:runtime\/gallery-refresh-and-status\.js#pollStatus: request target \/view-data is not an allowed endpoint$/,
  },
  {
    id: 'BI-H13 new unregistered poller',
    language: 'js',
    file: 'music_app/static/js/runtime/gallery-refresh-and-status.js',
    anchor: 'async function pollStatus() {',
    replacement: 'function startSeededGalleryPoll() { setInterval(() => refreshCurrentView(), 2000); }\n\nasync function pollStatus() {',
    expected: /^unregistered entrypoint js:music_app\/static\/js\/runtime\/gallery-refresh-and-status\.js#startSeededGalleryPoll:timer:setInterval$/,
  },
  {
    id: 'BI-H05/H06/H14 status request that synchronously rebuilds relation views',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    library_state = _library_state(request)\n    # Status is observational',
    replacement: '    library_state = _library_state(request)\n    build_relation_views(list(library_state.get("albums") or []), request.app.state.config)\n    # Status is observational',
    prelude: 'from music_app.services.relations import build_relation_views\n',
    expected: /^rejected BI-04 library-scale:py:music_app\/services\/relations\.py#build_relation_views at music_app\/services\/relations\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#status:route:GET \/status via build_relation_views$/,
  },
  {
    id: 'BI-06 status request that walks the music root',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    # Status is observational',
    replacement: '    list(os.walk(str(request.app.state.config["MUSIC_DIR"])))\n    # Status is observational',
    prelude: 'import os\n',
    expected: /^rejected BI-06 os\.walk at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#status:route:GET \/status$/,
  },
  {
    id: 'BI-H11 settings read that parses media through a helper',
    language: 'py',
    file: 'music_app/routes/api_wave_a_asgi_routes.py',
    anchor: '    scope = await root_request_scope(request)\n    return JSONResponse(',
    replacement: '    scope = await root_request_scope(request)\n    _probe_seeded_tracks(request.app.state.config)\n    return JSONResponse(',
    prelude: 'from mutagen import File as MutagenFile\n\n\ndef _probe_seeded_tracks(config):\n    return [MutagenFile(path) for path in config.get("TRACK_PATHS", [])]\n',
    expected: /^py:routes\/api_wave_a_asgi_routes\.py#library_settings_read: \d+ reachable hazard\(s\) need a runtime contract \(mutagen\.File at /,
  },
  {
    id: 'BI-04 new unregistered debug rebuild route',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '@router.get("/status")',
    replacement: '@router.get("/debug/library-rebuild")\ndef debug_library_rebuild(request: Request):\n    return build_relation_views([], {})\n\n\n@router.get("/status")',
    expected: /^unregistered entrypoint py:music_app\/routes\/api_read_asgi_routes\.py#debug_library_rebuild:route:GET \/debug\/library-rebuild$/,
  },
];

function seededOverrides() {
  const js = {};
  const py = {};
  for (const defect of DEFECTS) {
    const overrides = defect.language === 'js' ? js : py;
    inject(overrides, defect.file, defect.anchor, defect.replacement);
    if (defect.prelude) inject(overrides, defect.file, 'from __future__ import annotations\n', `from __future__ import annotations\n${defect.prelude}`);
  }
  return { jsOverrides: js, pyOverrides: py };
}

test('the guard reports every seeded historical defect in real application sources', { timeout: 300_000 }, async () => {
  const [clean, injected] = await Promise.all([validateRepository(), validateRepository(seededOverrides())]);
  const baseline = new Set(clean.errors);
  const seeded = injected.errors;
  const introduced = seeded.filter(error => !baseline.has(error));
  const missed = DEFECTS.filter(defect => !introduced.some(error => defect.expected.test(error)));
  assert.deepEqual(missed.map(defect => defect.id), [], `guard missed seeded defects; new errors were:\n${introduced.join('\n')}`);
});
