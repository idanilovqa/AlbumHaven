// The guard's own regression suite: reintroduce the historical unbounded
// mechanisms into real application sources (in memory only) and require the
// real registry validator to report every one of them. A defect the guard
// does not catch fails this test. Each defect lands in its own function so
// one report can never stand in for another, and the unmodified repository
// must validate cleanly, so a defect is never "caught" by a pre-existing error.

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
    file: 'music_app/static/js/runtime/utility-loaders-and-cover-lookup.js',
    anchor: "  form.addEventListener('scroll', closeOnScroll, { once: true });",
    replacement: "  form.addEventListener('scroll', () => { closeOnScroll(); syncSeededLooseTrackRows(); }, { once: true });\n"
      + "  function syncSeededLooseTrackRows() { state.view.non_album_tracks.forEach(track => track.visible = true); }",
    expected: /^js:runtime\/utility-loaders-and-cover-lookup\.js#openTagEditorExceptionMenu: \d+ reachable hazard\(s\) need a runtime contract \(.*forEach at /,
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
    id: 'BI-H17 Home routed through generic view-data from a one-shot click handler',
    language: 'js',
    file: 'music_app/static/js/runtime/mobile-navigation.js',
    anchor: "    if (event.target.closest?.('[data-mobile-back]')) navigateMobileBack();\n",
    replacement: "    if (event.target.closest?.('[data-mobile-back]')) navigateMobileBack();\n"
      + "    if (event.target.closest?.('[data-mobile-home]')) void fetch('/view-data?surface=home');\n",
    expected: /^rejected BI-04 route-owner:\/view-data\?surface=home at music_app\/static\/js\/runtime\/mobile-navigation\.js:\d+ from js:music_app\/static\/js\/runtime\/mobile-navigation\.js#/,
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
    // A hot path: the foreground-ready probe waits for paint with
    // requestAnimationFrame and reschedules itself until the document is healthy.
    id: 'BI-H13 timer callback that sweeps every pending entry (timers were never analyzed)',
    language: 'js',
    file: 'music_app/static/js/runtime/android-bridge-client.js',
    anchor: '    if (foregroundDocumentHealthy()) {\n',
    replacement: '    androidBridge.pending.forEach(entry => entry.reject(new Error(\'Android bridge timed out.\')));\n    if (foregroundDocumentHealthy()) {\n',
    expected: /^js:runtime\/android-bridge-client\.js#afterPaint: \d+ reachable hazard\(s\) need a runtime contract \(.*forEach at music_app\/static\/js\/runtime\/android-bridge-client\.js:\d+/,
  },
  {
    // A hot path: the startup progress animation reschedules its own frame
    // until the bar reaches its target.
    id: 'BI-H13 requestAnimationFrame animation loop that rescans every gallery card each frame',
    language: 'js',
    // A statically proven animation loop: a contract entry would leave the new
    // hazard to its runtime contract instead of reporting it here.
    file: 'music_app/static/js/runtime/utility-renderers-and-actions.js',
    anchor: '      const result = scrollFocusedRowsIntoView();\n',
    replacement: '      const result = scrollFocusedRowsIntoView();\n'
      + "      document.querySelectorAll('.album-card').forEach(card => card.classList.toggle('dimmed', !result.layoutReady));\n",
    expected: /^js:runtime\/utility-renderers-and-actions\.js#finishFocusedNavigation: \d+ reachable hazard\(s\) need a runtime contract \(.*querySelectorAll at music_app\/static\/js\/runtime\/utility-renderers-and-actions\.js:\d+/,
  },
  {
    id: 'BI-H13 self-rescheduling setTimeout poller that rescans every loop range',
    language: 'js',
    file: 'music_app/static/js/runtime/loop-range-controls.js',
    anchor: '      if (!pointerWithin && !retained()) renderEngagement(false);\n    }, 500);',
    replacement: '      if (!pointerWithin && !retained()) renderEngagement(false);\n'
      + "      document.querySelectorAll('[data-loop-range]').forEach(range => range.classList.remove('engaged'));\n"
      + '      leave();\n    }, 500);',
    expected: /^js:runtime\/loop-range-controls\.js#leave: \d+ reachable hazard\(s\) need a runtime contract \(.*querySelectorAll at music_app\/static\/js\/runtime\/loop-range-controls\.js:\d+/,
  },
  {
    id: 'BI-09 resize observer that rescans every gallery card (observers were never analyzed)',
    language: 'js',
    file: 'music_app/static/js/runtime/gallery-main-interactions.js',
    anchor: '  const observer = new ResizeObserver(update);\n  observer.observe(player);',
    replacement: "  const observer = new ResizeObserver(() => { document.querySelectorAll('.album-card').forEach(card => card.classList.remove('panel-overlap')); update(); });\n  observer.observe(player);",
    expected: /^js:runtime\/gallery-main-interactions\.js#observeArtistFamilyPanelBounds: \d+ reachable hazard\(s\) need a runtime contract \(.*querySelectorAll at music_app\/static\/js\/runtime\/gallery-main-interactions\.js:\d+/,
  },
  {
    id: 'BI-01 direct card scan inside a mouseover handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "  if (handleUtilityBootstrapMouseOver(event)) return;\n  handleGalleryBootstrapMouseOver(event);",
    replacement: "  document.querySelectorAll('.album-card.hovered').forEach(card => card.classList.remove('hovered'));\n  if (handleUtilityBootstrapMouseOver(event)) return;\n  handleGalleryBootstrapMouseOver(event);",
    expected: /^rejected BI-01 querySelectorAll at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#<top-level>:event:mouseover$/,
  },
  {
    id: 'BI-01 direct surface scan inside a resize handler',
    language: 'js',
    file: 'music_app/static/js/runtime/trigger-anchor.js',
    anchor: "globalThis.addEventListener?.('resize', syncActiveTriggerSurfaces);",
    replacement: "globalThis.addEventListener?.('resize', () => { document.querySelectorAll('[data-trigger-anchor]').forEach(surface => surface.removeAttribute('data-placed')); syncActiveTriggerSurfaces(); });",
    expected: /^rejected BI-01 querySelectorAll at music_app\/static\/js\/runtime\/trigger-anchor\.js:\d+ from js:music_app\/static\/js\/runtime\/trigger-anchor\.js#<top-level>:event:resize$/,
  },
  {
    id: 'BI-01 card scan reached through an optional call on the virtualGrid singleton',
    language: 'js',
    file: 'music_app/static/js/runtime/utility-renderers-and-actions.js',
    anchor: '      if (!event.ctrlKey && (event.deltaY || event.deltaX)) relinquish();',
    replacement: '      if (!event.ctrlKey && (event.deltaY || event.deltaX)) relinquish();\n      virtualGrid?.captureScrollAnchor?.();',
    expected: /^js:runtime\/utility-renderers-and-actions\.js#bindProblematicFocusUserInput: \d+ reachable hazard\(s\) need a runtime contract \(.*at music_app\/static\/js\/runtime\/virtual-artist-grid\.js:\d+/,
  },
  {
    id: 'BI-01 tab scan reached through a window.fn() call',
    language: 'js',
    file: 'music_app/static/js/runtime/utility-renderers-and-actions.js',
    anchor: "    strip.addEventListener('scroll', update, { passive: true });",
    replacement: "    strip.addEventListener('scroll', () => { update(); window.syncSeededUtilityTabs(); }, { passive: true });\n"
      + "    function syncSeededUtilityTabs() { document.querySelectorAll('[data-utility-tab]').forEach(tab => tab.classList.add('seen')); }",
    expected: /^js:runtime\/utility-renderers-and-actions\.js#syncUtilityTabAlignment: \d+ reachable hazard\(s\) need a runtime contract \(.*querySelectorAll at music_app\/static\/js\/runtime\/utility-renderers-and-actions\.js:\d+/,
  },
  {
    id: 'BI-01 helper chain deeper than the call-depth limit',
    language: 'js',
    file: 'music_app/static/js/runtime/utility-list-builders.js',
    anchor: "      list.addEventListener?.('wheel', releaseRetainedGeometry, { passive: true });",
    replacement: "      list.addEventListener?.('wheel', () => { releaseRetainedGeometry(); seededDepth1(); }, { passive: true });\n"
      + [1, 2, 3, 4, 5, 6, 7].map(level => `      function seededDepth${level}() { seededDepth${level + 1}(); }`).join('\n')
      + "\n      function seededDepth8() { return list.scrollTop; }",
    expected: /^js:runtime\/utility-list-builders\.js#settleProblematicSaveTaskMutation: \d+ reachable hazard\(s\) need a runtime contract \(.*call-depth-exceeded at music_app\/static\/js\/runtime\/utility-list-builders\.js:\d+/,
  },
  {
    id: 'BI-01 includes() over a shared collection from an input handler',
    language: 'js',
    file: 'music_app/static/js/account.js',
    anchor: "  confirmation?.addEventListener('input', validateMatch);",
    replacement: "  confirmation?.addEventListener('input', () => { validateMatch(); seededPasswordReused(); });\n"
      + '  function seededPasswordReused() { return window.knownPasswordHashes.includes(password.value); }',
    expected: /^js:account\.js#mount: \d+ reachable hazard\(s\) need a runtime contract \(.*includes at music_app\/static\/js\/account\.js:\d+/,
  },
  {
    id: 'BI-01 indexed loop bounded by a shared collection length from an input handler',
    language: 'js',
    file: 'music_app/static/js/runtime/search-input.js',
    anchor: "    updateSearchClearAction(event.target);\n  }\n});",
    replacement: "    updateSearchClearAction(event.target);\n    countSeededMatches(event.target.value);\n  }\n});\n"
      + 'function countSeededMatches(query) { let found = 0; for (let index = 0; index < state.view.non_album_tracks.length; index += 1) found += Number(query === state.view.non_album_tracks[index].title); return found; }',
    expected: /^js:runtime\/search-input\.js#<top-level>: \d+ reachable hazard\(s\) need a runtime contract \(.*indexed-loop at music_app\/static\/js\/runtime\/search-input\.js:\d+/,
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
    id: 'BI-06 read request that walks the music root',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    normalized_work_ref = str(work_ref or "").strip()\n',
    replacement: '    normalized_work_ref = str(work_ref or "").strip()\n    list(os.walk(normalized_work_ref))\n',
    prelude: 'import os\n',
    expected: /^rejected BI-06 os\.walk at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#works_read_reserved:route:GET \/works\/\{work_ref\}$/,
  },
  {
    id: 'BI-H11 settings read that parses media through a helper',
    language: 'py',
    file: 'music_app/routes/api_wave_a_asgi_routes.py',
    anchor: '    scope = await root_request_scope(request)\n    return JSONResponse(',
    replacement: '    scope = await root_request_scope(request)\n    _probe_seeded_tracks(request.app.state.config)\n    return JSONResponse(',
    prelude: 'from mutagen import File as MutagenFile\n\n\ndef _probe_seeded_tracks(config):\n    return [MutagenFile(path) for path in config.get("TRACK_PATHS", [])]\n',
    expected: /^py:routes\/api_wave_a_asgi_routes\.py#library_settings_read: \d+ reachable hazard\(s\) need a runtime contract \(.*mutagen\.File at /,
  },
  {
    id: 'BI-04 new unregistered debug rebuild route',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '@router.get("/status")',
    replacement: '@router.get("/debug/library-rebuild")\ndef debug_library_rebuild(request: Request):\n    return build_relation_views([], {})\n\n\n@router.get("/status")',
    expected: /^unregistered entrypoint py:music_app\/routes\/api_read_asgi_routes\.py#debug_library_rebuild:route:GET \/debug\/library-rebuild$/,
  },
  {
    id: 'BI-04 read request that hydrates the whole library state',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    normalized_person_ref = str(person_ref or "").strip()\n',
    replacement: '    normalized_person_ref = str(person_ref or "").strip()\n    hydrate_library_state_for_config(request.app.state.library_state, request.app.state.config)\n',
    prelude: 'from music_app.services.state import hydrate_library_state_for_config\n',
    expected: /^rejected BI-04 library-scale:py:music_app\/services\/state\.py#hydrate_library_state_for_config at music_app\/services\/state\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#people_read_reserved:route:GET \/people\/\{person_ref\} via hydrate_library_state_for_config$/,
  },
  {
    id: 'BI-04 read request that waits on an executor-run relation rebuild',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    normalized_soundtrack_ref = str(soundtrack_ref or "").strip()\n',
    replacement: '    normalized_soundtrack_ref = str(soundtrack_ref or "").strip()\n    _SEEDED_POOL.submit(build_relation_views_for_seed, [], request.app.state.config).result()\n',
    prelude: 'from music_app.services.relations import build_relation_views as build_relation_views_for_seed\n_SEEDED_POOL = ThreadPoolExecutor(max_workers=1)\n',
    expected: /^rejected BI-04 library-scale:py:music_app\/services\/relations\.py#build_relation_views at music_app\/services\/relations\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#soundtracks_read_reserved:route:GET \/soundtracks\/\{soundtrack_ref\} via build_relation_views$/,
  },
  {
    id: 'BI-06 folder walk behind a method name defined by two classes',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    normalized_company_ref = str(company_ref or "").strip()\n',
    replacement: '    normalized_company_ref = str(company_ref or "").strip()\n    request.app.state.seeded_index.seeded_collect(normalized_company_ref)\n',
    prelude: 'class _SeededFolderIndex:\n    def seeded_collect(self, root):\n        return list(os.walk(root))\n\n\n'
      + 'class _SeededMemoryIndex:\n    def seeded_collect(self, root):\n        return []\n',
    expected: /^py:routes\/api_read_asgi_routes\.py#companies_read_reserved: \d+ reachable hazard\(s\) need a runtime contract \(.*os\.walk at music_app\/routes\/api_read_asgi_routes\.py:\d+/,
  },
  {
    id: 'BI-06 per-track existence probe in a read request',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    normalized_album_ref = str(album_ref or "").strip()\n',
    replacement: '    normalized_album_ref = str(album_ref or "").strip()\n    [path for path in _SEEDED_TRACK_PATHS if Path(path).exists()]\n',
    prelude: 'from pathlib import Path\n_SEEDED_TRACK_PATHS: list[str] = []\n',
    expected: /^py:routes\/api_read_asgi_routes\.py#album_opinions_crowd_read_reserved: \d+ reachable hazard\(s\) need a runtime contract \(.*Path\.exists at music_app\/routes\/api_read_asgi_routes\.py:\d+/,
  },
  {
    id: 'BI-07 thread target that escapes name-based background discovery',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    headers = {"Cache-Control": "no-store"}\n',
    replacement: '    headers = {"Cache-Control": "no-store"}\n    threading.Thread(target=_seeded_rebuild_library, daemon=True).start()\n',
    prelude: 'import threading\n\n\ndef _seeded_rebuild_library():\n    return None\n',
    expected: /^unregistered entrypoint py:music_app\/routes\/api_read_asgi_routes\.py#_seeded_rebuild_library:background:thread$/,
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

let runs = null;
const validations = () => {
  runs ??= Promise.all([validateRepository(), validateRepository(seededOverrides())]);
  return runs;
};

test('the unmodified repository validates cleanly, so no seeded defect hides behind an existing error', { timeout: 300_000 }, async () => {
  const [clean] = await validations();
  assert.deepEqual(clean.errors, []);
});

test('the guard reports every seeded historical defect in real application sources', { timeout: 300_000 }, async () => {
  const [clean, injected] = await validations();
  const baseline = new Set(clean.errors);
  const introduced = injected.errors.filter(error => !baseline.has(error));
  const missed = DEFECTS.filter(defect => !introduced.some(error => defect.expected.test(error)));
  assert.deepEqual(missed.map(defect => defect.id), [], `guard missed seeded defects; new errors were:\n${introduced.join('\n')}`);
});
