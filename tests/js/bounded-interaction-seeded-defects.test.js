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
    id: 'BI-01 card scan reached through a local const alias of a helper (aliased calls were treated as hazard-free)',
    language: 'js',
    file: 'music_app/static/js/admin-members.js',
    anchor: "  window.addEventListener?.('wheel', closeOnLayoutChange, { capture: true, passive: true });",
    replacement: "  window.addEventListener?.('wheel', () => { closeOnLayoutChange(); const seededSync = seededSyncAdminRows; seededSync(); }, { capture: true, passive: true });\n"
      + "  function seededSyncAdminRows() { document.querySelectorAll('[data-account-row]').forEach(row => row.classList.add('seen')); }",
    expected: /^js:admin-members\.js#mount: \d+ reachable hazard\(s\) need a runtime contract \(.*querySelectorAll at music_app\/static\/js\/admin-members\.js:\d+/,
  },
  {
    id: 'BI-01 grid relayout reached through a local alias of the virtualGrid singleton',
    language: 'js',
    file: 'music_app/static/js/runtime/mobile-navigation.js',
    anchor: "  gallery.addEventListener('touchmove', event => {\n    if (!gesture || event.touches.length !== 2) return;\n",
    replacement: "  gallery.addEventListener('touchmove', event => {\n    if (!gesture || event.touches.length !== 2) return;\n"
      + '    const seededGrid = virtualGrid;\n    seededGrid.captureScrollAnchor();\n',
    expected: /^js:runtime\/mobile-navigation\.js#initMobileGalleryPinch: \d+ reachable hazard\(s\) need a runtime contract \(.*at music_app\/static\/js\/runtime\/virtual-artist-grid\.js:\d+/,
  },
  {
    id: 'BI-01 thumbnail scan reached through an object literal hook from a touchmove handler',
    language: 'js',
    file: 'music_app/static/js/runtime/track-modal-lightbox-helpers.js',
    anchor: "  overlay.addEventListener('touchmove', event => {\n    if (event.touches.length !== 1 || state.lightbox.zoom > 1) start = null;\n",
    replacement: "  const seededLightboxHooks = { onSwipe() { document.querySelectorAll('.lightbox-thumb').forEach(thumb => thumb.classList.add('seen')); } };\n"
      + "  overlay.addEventListener('touchmove', event => {\n    if (event.touches.length !== 1 || state.lightbox.zoom > 1) start = null;\n"
      + '    seededLightboxHooks.onSwipe();\n',
    expected: /^js:runtime\/track-modal-lightbox-helpers\.js#bindLightboxSwipe: \d+ reachable hazard\(s\) need a runtime contract \(.*querySelectorAll at music_app\/static\/js\/runtime\/track-modal-lightbox-helpers\.js:\d+/,
  },
  {
    id: 'BI-01 resize handler that dispatches through a computed hook nobody can resolve',
    language: 'js',
    file: 'music_app/static/js/settings-navigation.js',
    anchor: '    const syncDrawerLayout = () => closeDrawer(false);',
    replacement: '    const syncDrawerLayout = () => { closeDrawer(false); window.seededDrawerHooks[document.body.dataset.layout](); };',
    expected: /^js:settings-navigation\.js#create: \d+ reachable hazard\(s\) need a runtime contract \(.*unresolved-call:…\[…\] at music_app\/static\/js\/settings-navigation\.js:\d+/,
  },
  {
    id: 'BI-01 scroll listener installed from a constant event list (non-literal event names were never discovered)',
    language: 'js',
    file: 'music_app/static/js/runtime/trigger-anchor.js',
    anchor: "  document.addEventListener('selectionchange', confine);\n",
    replacement: "  document.addEventListener('selectionchange', confine);\n"
      + "  for (const seededType of ['scroll']) document.addEventListener(seededType, () => document.querySelectorAll('[data-trigger-anchor]').forEach(anchor => anchor.removeAttribute('data-placed')));\n",
    expected: /^rejected BI-01 querySelectorAll at music_app\/static\/js\/runtime\/trigger-anchor\.js:\d+ from js:music_app\/static\/js\/runtime\/trigger-anchor\.js#installPanelSelectionBoundary:event:scroll$/,
  },
  {
    id: 'BI-13 listener whose event name cannot be resolved',
    language: 'js',
    file: 'music_app/static/js/settings-navigation.js',
    anchor: "    window.addEventListener('resize', syncDrawerLayout);",
    replacement: "    window.addEventListener('resize', syncDrawerLayout);\n    window.addEventListener(window.seededLayoutEvent, syncDrawerLayout);",
    expected: /^unresolved-trigger at music_app\/static\/js\/settings-navigation\.js:\d+: /,
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
    id: 'BI-07 gallery rebuild queued as a lambda through a helper parameter (helper-launched work was invisible)',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: "        payload = await request.json()\n        if not isinstance(payload, dict):\n            raise LogHistoryQueryError('Invalid history export request')\n",
    replacement: "        payload = await request.json()\n        if not isinstance(payload, dict):\n            raise LogHistoryQueryError('Invalid history export request')\n"
      + '        _seeded_queue(_app_config(request), "rebuild", lambda: _seeded_rebuild_gallery(_app_config(request)))\n',
    prelude: '_SEEDED_QUEUE_POOL = ThreadPoolExecutor(max_workers=1)\n\n\ndef _seeded_queue(config, key, action):\n    return _SEEDED_QUEUE_POOL.submit(action)\n\n\n'
      + 'def _seeded_rebuild_gallery(config):\n    return None\n',
    expected: /^unregistered entrypoint py:music_app\/routes\/api_read_asgi_routes\.py#_seeded_rebuild_gallery:background:executor$/,
  },
  {
    id: 'BI-04 background reconciler that rebuilds every relation view without a batching contract',
    language: 'py',
    file: 'music_app/services/cover_lookup_tasks.py',
    anchor: '    claimed_at = monotonic()\n    with _STALE_COVER_LOOKUP_RECONCILIATION_LOCK:\n',
    replacement: '    claimed_at = monotonic()\n    _seeded_build_relation_views([], config)\n    with _STALE_COVER_LOOKUP_RECONCILIATION_LOCK:\n',
    prelude: 'from music_app.services.relations import build_relation_views as _seeded_build_relation_views\n',
    expected: /^py:services\/cover_lookup_tasks\.py#_reconcile_stale_cover_lookup_tasks: \d+ reachable hazard\(s\) need a runtime contract \(.*library-scale:py:music_app\/services\/relations\.py#build_relation_views at /,
  },
  {
    id: 'BI-04 read route that scans every album in the in-memory library state',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    return JSONResponse({"ok": True, "loops": [project_loop_for_client(item)',
    replacement: '    library_state = request.app.state.library_state\n'
      + '    [album for album in library_state.get("albums", []) if getattr(album, "loops", None)]\n'
      + '    return JSONResponse({"ok": True, "loops": [project_loop_for_client(item)',
    expected: /^py:routes\/api_read_asgi_routes\.py#utilities_loops: \d+ reachable hazard\(s\) need a runtime contract \(.*library-state-scan:albums at music_app\/routes\/api_read_asgi_routes\.py:\d+/,
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

// Registry-side bypasses: a contract that "proves" an entry with a test that
// measures something else, and a test identity that only names part of a test.
test('the guard rejects a contract proved by a helper test under an unregistered id', async () => {
  const fsPromises = require('node:fs/promises');
  const os = require('node:os');
  const { loadRegistry } = require('../../scripts/ci/validate-bounded-interactions.cjs');
  const { measureScalePair } = require('./helpers/bounded-interaction-counter');
  const { evidenceErrors } = require('../../scripts/run-bounded-interactions.cjs');
  const helperId = 'py:services/move_planner.py#build_move_availability_payload';
  const helperTest = 'test_move_availability_contract_probes_one_artist_folder_at_production_artist_count';
  // The helper's own measurement is rejected outright...
  await assert.rejects(() => measureScalePair({
    id: helperId, small: 20, large: 14_000, run: async () => ({ stat_calls: 0 }), budgets: { stat_calls: 4 },
  }), /measured id is not a registered interaction/);
  // ...and a route entry whose test measured only the helper is not proven.
  const entry = { ...loadRegistry().interactions.find(item => item.id === 'py:routes/api_read_asgi_routes.py#album_details'), testIdentity: helperTest };
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'seeded-evidence-'));
  const evidence = path.join(dir, 'evidence.jsonl');
  await fsPromises.writeFile(evidence, `${JSON.stringify({ id: helperId, test: helperTest })}\n`);
  assert.deepEqual(evidenceErrors([entry], evidence), [
    `py:routes/api_read_asgi_routes.py#album_details: its test "${helperTest}" did not measure py:routes/api_read_asgi_routes.py#album_details`,
  ]);
});

test('the guard rejects a test identity that is only a substring of the real test name', () => {
  const { loadRegistry, validateSchema } = require('../../scripts/ci/validate-bounded-interactions.cjs');
  const registry = loadRegistry();
  const entry = registry.interactions.find(item => item.id === 'js:runtime/track-modal-and-gallery.js#attachUtilityModalEvents');
  entry.testIdentity = 'BI Utility search keystroke stores the query';
  const errors = validateSchema(registry, {
    fileExists: file => fs.existsSync(path.join(ROOT, file)),
    readFile: file => fs.readFileSync(path.join(ROOT, file), 'utf8'),
  });
  assert.deepEqual(errors, [
    'js:runtime/track-modal-and-gallery.js#attachUtilityModalEvents: test identity "BI Utility search keystroke stores the query" is not defined in tests/js/runtime/utility-search-input-bounded.test.js',
  ]);
});

test('the guard reports every seeded historical defect in real application sources', { timeout: 300_000 }, async () => {
  const [clean, injected] = await validations();
  const baseline = new Set(clean.errors);
  const introduced = injected.errors.filter(error => !baseline.has(error));
  const missed = DEFECTS.filter(defect => !introduced.some(error => defect.expected.test(error)));
  assert.deepEqual(missed.map(defect => defect.id), [], `guard missed seeded defects; new errors were:\n${introduced.join('\n')}`);
});
