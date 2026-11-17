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
    id: 'BI-01 a reverse loop over shared albums inside a wheel handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.addEventListener('wheel', (event) => {",
    replacement: "document.addEventListener('wheel', (event) => {\n  for (let index = state.albums.length - 1; index >= 0; index -= 1) state.albums[index].seen = true;",
    expected: /^rejected BI-01 indexed-loop at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:wheel$/,
  },
  {
    id: 'BI-01 a count-down loop from a shared length inside a pointermove handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.addEventListener('pointermove', (event) => {",
    replacement: "document.addEventListener('pointermove', (event) => {\n  let remaining = state.albums.length; while (remaining--) state.albums[remaining].seen = true;",
    expected: /^rejected BI-01 indexed-loop at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:pointermove$/,
  },
  {
    id: 'BI-01 a loop bounded by a copy of a shared length inside a mousemove handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.addEventListener('mousemove', (event) => {",
    replacement: "document.addEventListener('mousemove', (event) => {\n  const total = state.albums.length; for (let index = 0; index < total; index += 1) state.albums[index].seen = true;",
    expected: /^rejected BI-01 indexed-loop at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:mousemove$/,
  },
  {
    id: 'BI-01 a reverse loop stepping by assignment inside a wheel handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.addEventListener('wheel', (event) => {",
    replacement: "document.addEventListener('wheel', (event) => {\n  for (let index = state.albums.length - 1; index >= 0; index = index - 1) state.albums[index].seen = true;",
    expected: /^rejected BI-01 indexed-loop at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:wheel$/,
  },
  {
    id: 'BI-01 a loop up to a copied length stepping by assignment inside a pointermove handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.addEventListener('pointermove', (event) => {",
    replacement: "document.addEventListener('pointermove', (event) => {\n  const total = state.albums.length; for (let index = 0; index < total; index = index + 1) state.albums[index].seen = true;",
    expected: /^rejected BI-01 indexed-loop at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:pointermove$/,
  },
  {
    id: 'BI-01 a loop up to a destructured length inside a mousemove handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.addEventListener('mousemove', (event) => {",
    replacement: "document.addEventListener('mousemove', (event) => {\n  const { length } = state.albums; for (let index = 0; index < length; index += 1) state.albums[index].seen = true;",
    expected: /^rejected BI-01 indexed-loop at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:mousemove$/,
  },
  {
    id: 'BI-01 structuredClone of shared albums inside a scroll handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.getElementById('albums-scroll')?.addEventListener('scroll', () => {",
    replacement: "document.getElementById('albums-scroll')?.addEventListener('scroll', () => {\n  structuredClone(state.albums);",
    expected: /^rejected BI-01 structuredClone at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:scroll$/,
  },
  {
    id: 'BI-01 reduceRight over shared albums inside a scroll handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.getElementById('albums-scroll')?.addEventListener('scroll', () => {",
    replacement: "document.getElementById('albums-scroll')?.addEventListener('scroll', () => {\n  state.albums.reduceRight((count, album) => count + album.size, 0);",
    expected: /^rejected BI-01 reduceRight at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:scroll$/,
  },
  {
    id: 'BI-01 findLastIndex over shared albums inside a resize handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "window.addEventListener('resize', () => {",
    replacement: "window.addEventListener('resize', () => {\n  state.albums.findLastIndex(Boolean);",
    expected: /^rejected BI-01 findLastIndex at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:resize$/,
  },
  {
    id: 'BI-01 lastIndexOf over shared albums inside a input handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.addEventListener('input', (event) => {",
    replacement: "document.addEventListener('input', (event) => {\n  state.albums.lastIndexOf(event.target);",
    expected: /^rejected BI-01 lastIndexOf at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:input$/,
  },
  {
    id: 'BI-01 toSorted copy of shared albums inside a dragover handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-event-handlers.js',
    anchor: "document.addEventListener('dragover', (event) => {",
    replacement: "document.addEventListener('dragover', (event) => {\n  state.albums.toSorted();",
    expected: /^rejected BI-01 toSorted at music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-event-handlers\.js#[^:]+:event:dragover$/,
  },
  {
    id: 'BI-01 toReversed copy of shared albums inside a wheel handler',
    language: 'js',
    file: 'music_app/static/js/runtime/bootstrap-init.js',
    anchor: "document.addEventListener('wheel', (event) => {",
    replacement: "document.addEventListener('wheel', (event) => {\n  state.albums.toReversed();",
    expected: /^rejected BI-01 toReversed at music_app\/static\/js\/runtime\/bootstrap-init\.js:\d+ from js:music_app\/static\/js\/runtime\/bootstrap-init\.js#[^:]+:event:wheel$/,
  },
  {
    id: 'BI-01 toSpliced copy of shared albums inside a pointermove handler',
    language: 'js',
    file: 'music_app/static/js/runtime/compact-player-controller.js',
    anchor: "els.compact?.addEventListener('pointermove', event => {",
    replacement: "els.compact?.addEventListener('pointermove', event => {\n  state.albums.toSpliced(0, 1);",
    expected: /^rejected BI-01 toSpliced at music_app\/static\/js\/runtime\/compact-player-controller\.js:\d+ from js:music_app\/static\/js\/runtime\/compact-player-controller\.js#[^:]+:event:pointermove$/,
  },
  {
    id: 'BI-01 flat copy of shared albums inside a pointermove handler',
    language: 'js',
    file: 'music_app/static/js/runtime/compact-player-controller.js',
    anchor: "els.cover?.addEventListener('pointermove', event => {",
    replacement: "els.cover?.addEventListener('pointermove', event => {\n  state.albums.flat();",
    expected: /^rejected BI-01 flat at music_app\/static\/js\/runtime\/compact-player-controller\.js:\d+ from js:music_app\/static\/js\/runtime\/compact-player-controller\.js#[^:]+:event:pointermove$/,
  },
  {
    id: 'BI-01 concat copy of shared albums inside a scroll handler',
    language: 'js',
    file: 'music_app/static/js/runtime/gallery-main-interactions.js',
    anchor: "scroll?.addEventListener('scroll', () => {",
    replacement: "scroll?.addEventListener('scroll', () => {\n  state.albums.concat([]);",
    expected: /^rejected BI-01 concat at music_app\/static\/js\/runtime\/gallery-main-interactions\.js:\d+ from js:music_app\/static\/js\/runtime\/gallery-main-interactions\.js#[^:]+:event:scroll$/,
  },
  {
    id: 'BI-01 a borrowed Array.prototype.forEach over shared albums inside a pointermove handler',
    language: 'js',
    file: 'music_app/static/js/runtime/player-loop-playback.js',
    anchor: "document.addEventListener('pointermove', (event) => {",
    replacement: "document.addEventListener('pointermove', (event) => {\n  Array.prototype.forEach.call(state.albums, album => { album.seen = true; });",
    expected: /^rejected BI-01 Array\.prototype\.forEach at music_app\/static\/js\/runtime\/player-loop-playback\.js:\d+ from js:music_app\/static\/js\/runtime\/player-loop-playback\.js#[^:]+:event:pointermove$/,
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
  {
    // The incident: an async route ran the file-backed Home build on the event
    // loop, so no other request was served for ~10 s on a 163k-file library.
    id: 'BI-08 Home builder called directly inside async def home_data',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '@router.get("/home-data")\ndef home_data(request: Request) -> JSONResponse:',
    replacement: '@router.get("/home-data")\nasync def home_data(request: Request) -> JSONResponse:',
    expected: /^rejected BI-08 event-loop-blocking:\w+:\S+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#home_data:route:GET \/home-data via build_home_payload > /,
  },
  {
    id: 'BI-08 async route that builds the Home payload directly on the event loop',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: '    scope = await history_scope_for_request(request)\n    try:\n        fields = ',
    replacement: '    scope = await history_scope_for_request(request)\n'
      + '    build_home_payload(query_args=_AsgiQueryArgs(request.query_params), config=_app_config(request), logger=_app_logger(request), library_state=_library_state(request), client_surface_class="desktop")\n'
      + '    try:\n        fields = ',
    expected: /^rejected BI-08 event-loop-blocking:\w+:\S+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#utilities_log_history:route:GET \/utilities\/log-history via build_home_payload > /,
  },
  {
    id: 'BI-08 async route reaching psycopg connect through a sync helper chain',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def album_notes_create_reserved() -> JSONResponse:\n',
    replacement: 'async def album_notes_create_reserved() -> JSONResponse:\n    _seeded_note_count()\n',
    prelude: 'import psycopg as _seeded_psycopg\n\n\ndef _seeded_note_count():\n    return _seeded_note_rows("postgresql://seeded")\n\n\n'
      + 'def _seeded_note_rows(database_url):\n    with _seeded_psycopg.connect(database_url) as connection:\n        return connection.execute("select 1").fetchall()\n',
    expected: /^rejected BI-08 event-loop-blocking:database:psycopg\.connect@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#album_notes_create_reserved:route:POST \/album-notes via _seeded_note_count > _seeded_note_rows$/,
  },
  {
    // A log-history write on the event loop: `append` shares a builtin list
    // method's name, so it was followed only once its receiver, a constructor
    // call of an app class, resolved.
    id: 'BI-08 async route reaching a connection through a container-named method on a constructed adapter',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def album_note_replies_create_reserved() -> JSONResponse:\n',
    replacement: 'async def album_note_replies_create_reserved() -> JSONResponse:\n'
      + '    _SeededHistoryAdapter({}).append({"action": "seeded"}, scope=None)\n',
    prelude: 'from music_app.services.log_history_postgres import LogHistoryPostgresAdapter as _SeededHistoryAdapter\n',
    expected: /^rejected BI-08 event-loop-blocking:database:\S+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#album_note_replies_create_reserved:route:POST \/album-note-replies via LogHistoryPostgresAdapter\.append/,
  },
  {
    // The incident: Edit Tags built its reservation keys with one
    // `Path(path).resolve()` per track on the event loop; `resolve` was not
    // treated as filesystem work, so the 48-request burst stalled the loop.
    id: 'BI-08 async route resolving each requested path on the event loop',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def album_notes_mutate_reserved(note_ref: str) -> JSONResponse:\n',
    replacement: 'async def album_notes_mutate_reserved(note_ref: str) -> JSONResponse:\n    _seeded_reservation_keys([note_ref])\n',
    prelude: 'from pathlib import Path\n\n\ndef _seeded_reservation_keys(track_paths):\n'
      + '    return {str(Path(path).resolve()) for path in track_paths}\n',
    expected: /^rejected BI-08 event-loop-blocking:filesystem:Path\.resolve@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#album_notes_mutate_reserved:route:DELETE \/album-notes\/\{note_ref\} via _seeded_reservation_keys$/,
  },
  {
    id: 'BI-08 async route removing a folder tree on the event loop',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def companies_read_reserved(request: Request, company_ref: str) -> JSONResponse:\n',
    replacement: 'async def companies_read_reserved(request: Request, company_ref: str) -> JSONResponse:\n    _seeded_shutil.rmtree(company_ref)\n',
    prelude: 'import shutil as _seeded_shutil\n',
    expected: /^rejected BI-08 event-loop-blocking:filesystem:shutil\.rmtree@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#companies_read_reserved:route:GET \/companies\/\{company_ref\}$/,
  },
  {
    id: 'BI-08 async route deleting a file through os on the event loop',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def companies_read_reserved(request: Request, company_ref: str) -> JSONResponse:\n',
    replacement: 'async def companies_read_reserved(request: Request, company_ref: str) -> JSONResponse:\n    _seeded_os.remove(company_ref)\n',
    prelude: 'import os as _seeded_os\n',
    expected: /^rejected BI-08 event-loop-blocking:filesystem:os\.remove@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#companies_read_reserved:route:GET \/companies\/\{company_ref\}$/,
  },
  {
    id: 'BI-08 async route creating a folder through a path on the event loop',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def companies_read_reserved(request: Request, company_ref: str) -> JSONResponse:\n',
    replacement: 'async def companies_read_reserved(request: Request, company_ref: str) -> JSONResponse:\n    _SeededPath(company_ref).mkdir(parents=True)\n',
    prelude: 'from pathlib import Path as _SeededPath\n',
    expected: /^rejected BI-08 event-loop-blocking:filesystem:Path\.mkdir@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#companies_read_reserved:route:GET \/companies\/\{company_ref\}$/,
  },
  {
    id: 'BI-08 async route constructing an app class whose __init__ reads a file',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def works_read_reserved(work_ref: str) -> JSONResponse:\n',
    replacement: 'async def works_read_reserved(work_ref: str) -> JSONResponse:\n    _SeededLoader(work_ref)\n',
    prelude: 'class _SeededLoader:\n    def __init__(self, path):\n        self.text = open(path).read()\n\n\n',
    expected: /^rejected BI-08 event-loop-blocking:filesystem:open@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#works_read_reserved:route:GET \/works\/\{work_ref\} via _SeededLoader\.__init__$/,
  },
  {
    // update is also a dict method: the receiver resolves through the factory that returns it.
    id: 'BI-08 async route calling a container-named method on an object a factory returns',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def soundtracks_read_reserved(request: Request, soundtrack_ref: str) -> JSONResponse:\n',
    replacement: 'async def soundtracks_read_reserved(request: Request, soundtrack_ref: str) -> JSONResponse:\n'
      + '    repository = _seeded_repository(request)\n    repository.update(soundtrack_ref)\n',
    prelude: 'import psycopg as _seeded_pg\n\n\nclass _SeededRepository:\n    def update(self, value):\n'
      + '        with _seeded_pg.connect(value) as connection:\n            connection.execute("select 1")\n\n\n'
      + 'def _seeded_repository(request):\n    return _SeededRepository()\n\n\n',
    expected: /^rejected BI-08 event-loop-blocking:database:psycopg\.connect@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#soundtracks_read_reserved:route:GET \/soundtracks\/\{soundtrack_ref\} via _SeededRepository\.update$/,
  },
  {
    id: 'BI-08 async route calling blocking work through a module-level alias',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def people_read_reserved(request: Request, person_ref: str) -> JSONResponse:\n',
    replacement: 'async def people_read_reserved(request: Request, person_ref: str) -> JSONResponse:\n    _SEEDED_READ(person_ref)\n',
    prelude: 'def _seeded_read(path):\n    return open(path).read()\n\n\n_SEEDED_READ = _seeded_read\n',
    expected: /^rejected BI-08 event-loop-blocking:filesystem:open@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#people_read_reserved:route:GET \/people\/\{person_ref\} via _seeded_read$/,
  },
  {
    id: 'BI-08 async route calling blocking work through a module-level dispatch table',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def album_opinions_crowd_read_reserved(album_ref: str) -> JSONResponse:\n',
    replacement: 'async def album_opinions_crowd_read_reserved(album_ref: str) -> JSONResponse:\n    _SEEDED_HANDLERS["read"](album_ref)\n',
    prelude: 'def _seeded_handler(path):\n    return open(path).read()\n\n\n_SEEDED_HANDLERS = {"read": _seeded_handler}\n',
    expected: /^rejected BI-08 event-loop-blocking:filesystem:open@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#album_opinions_crowd_read_reserved:route:GET \/album-opinions\/\{album_ref\}\/crowd via _seeded_handler$/,
  },
  {
    id: 'BI-08 async route waiting on a threading event on the event loop',
    language: 'py',
    file: 'music_app/routes/api_read_asgi_routes.py',
    anchor: 'async def album_note_replies_mutate_reserved(reply_ref: str) -> JSONResponse:\n',
    replacement: 'async def album_note_replies_mutate_reserved(reply_ref: str) -> JSONResponse:\n    _SEEDED_READY.wait(1)\n',
    prelude: 'import threading as _seeded_threading\n\n\n_SEEDED_READY = _seeded_threading.Event()\n',
    expected: /^rejected BI-08 event-loop-blocking:wait:Event\.wait@music_app\/routes\/api_read_asgi_routes\.py:\d+ at music_app\/routes\/api_read_asgi_routes\.py:\d+ from py:music_app\/routes\/api_read_asgi_routes\.py#album_note_replies_mutate_reserved:route:(PATCH|DELETE) \/album-note-replies\/\{reply_ref\}$/,
  },
  {
    id: 'BI-05 root settings reloaded through a new connection per requested path',
    language: 'py',
    file: 'music_app/routes/api_wave_c_asgi_routes.py',
    anchor: 'def news_center_preferences(request: Request) -> JSONResponse:\n',
    replacement: 'def news_center_preferences(request: Request) -> JSONResponse:\n'
      + '    [_seeded_track_root(_app_config(request), path) for path in request.query_params.getlist("path")]\n',
    prelude: 'from music_app.services.library_roots import load_library_root_settings as _seeded_load_roots\n\n\n'
      + 'def _seeded_track_root(config, path):\n    return _seeded_load_roots(config)\n',
    expected: /^rejected BI-05 database-connect-per-item:\S+ at music_app\/routes\/api_wave_c_asgi_routes\.py:\d+ from py:music_app\/routes\/api_wave_c_asgi_routes\.py#news_center_preferences:route:GET \/news-center\/preferences via _seeded_track_root > /,
  },
  {
    // The repair route scanned every album through `st = get_state()`: the
    // receiver is library state by evidence (a getter returning
    // `request.app.state.library_state`), not by its name.
    id: 'BI-04 library-state scan through an injected getter and a renamed receiver',
    language: 'py',
    file: 'music_app/routes/api_wave_c_asgi_routes.py',
    anchor: 'def recent_discovery_lookups(request: Request) -> JSONResponse:\n',
    replacement: 'def recent_discovery_lookups(request: Request) -> JSONResponse:\n'
      + '    _seeded_album_count(get_state=lambda: _seeded_state(request))\n',
    prelude: 'def _seeded_state(request):\n    return request.app.state.library_state\n\n\n'
      + 'def _seeded_album_count(*, get_state):\n    st = get_state()\n    return sum(1 for album in st["albums"] if album)\n',
    expected: /^py:routes\/api_wave_c_asgi_routes\.py#recent_discovery_lookups: \d+ reachable hazard\(s\) need a runtime contract \(.*library-state-scan:albums at music_app\/routes\/api_wave_c_asgi_routes\.py:\d+/,
  },
  {
    // The cover pass snapshot copied the whole file cache through
    // `cache if selected is None else subset`: a conditional expression
    // hid the registered collection from the scan.
    id: 'BI-04 library-state collection chosen by a conditional expression',
    language: 'py',
    file: 'music_app/routes/api_wave_c_asgi_routes.py',
    anchor: 'def discovery_lookup_detail(request: Request, lookup_ref: str) -> JSONResponse:\n',
    replacement: 'def discovery_lookup_detail(request: Request, lookup_ref: str) -> JSONResponse:\n'
      + '    _seeded_cover_snapshot(request.app.state.library_state, None)\n',
    prelude: 'def _seeded_cover_snapshot(library_state, selected):\n'
      + '    source = library_state.get("file_cache") or {} if selected is None else selected\n'
      + '    return {path: dict(entry) for path, entry in source.items()}\n',
    expected: /^py:routes\/api_wave_c_asgi_routes\.py#discovery_lookup_detail: \d+ reachable hazard\(s\) need a runtime contract \(.*library-state-scan:file_cache at music_app\/routes\/api_wave_c_asgi_routes\.py:\d+/,
  },
  {
    // Owner incident (sandbox2, 11-17): after a structural tag save the
    // finalizer resolved the cover path of every cached file (~163k, mostly on
    // a network share), through `_post_commit_value(..., lambda:
    // state_guard(refresh_runtime_state))`, a getter passed through
    // `**kwargs`, and a sibling closure. The pre-0211ed0bf shape: the whole
    // live file cache is the candidate set and every entry is resolved.
    id: 'BI-04 a structural save finalizer resolving every cached file cover path',
    language: 'py',
    file: 'music_app/services/save_tasks.py',
    anchor: '                        candidate_paths=affected_album_track_paths(\n'
      + '                            st,\n'
      + '                            previous_file_cache,\n'
      + '                            current_file_cache,\n'
      + '                            changed_paths,\n'
      + '                            current_separate_release_keys,\n'
      + '                        ),\n',
    replacement: '                        candidate_paths=st.get("file_cache", {}) or {},\n',
    also: [[
      '        for path in candidate_paths\n'
        + '        if album_identity(entry := file_cache.get(path)) in inherited_albums\n'
        + '        and cover_identity(entry) in inherited_identities\n',
      '        for path in candidate_paths\n'
        + '        if album_identity(entry := file_cache.get(path)) is not None\n'
        + '        and cover_identity(entry) in inherited_identities\n',
    ]],
    expected: /^rejected BI-04 library-state-scan-io:file_cache \(Path\.resolve@music_app\/services\/save_tasks\.py:\d+\) at music_app\/services\/save_tasks\.py:\d+ from py:music_app\/services\/save_tasks\.py#finalize_structural_tag_edit_save_task:background:executor via .*refresh_runtime_state > _structurally_inherited_cover_entries.* \(work class affected-set cannot do per-item I\/O over the whole library state\)$/,
  },
  {
    // A pasted album link expands through provider helpers that log per URL
    // and per probe. Handing them the history-writing app logger makes every
    // logged event open its own log-history connection: one request, N
    // connections. The logger arrives as a plain function argument.
    id: 'BI-05 a history-writing logger passed as an argument to per-URL provider helpers',
    language: 'py',
    file: 'music_app/services/cover_manual_links.py',
    anchor: '                extract_album_page_metadata=cover_provider_fallback_web.extract_genius_album_page_metadata,\n'
      + '                log_event=cover_provider_runtime.log_provider_event,\n',
    replacement: '                extract_album_page_metadata=cover_provider_fallback_web.extract_genius_album_page_metadata,\n'
      + '                log_event=_seeded_log_history_event,\n',
    prelude: 'from music_app.services.log_history import append_log_history as _seeded_append_log_history\n\n\n'
      + 'def _seeded_log_history_event(config, logger, action, **fields):\n'
      + '    _seeded_append_log_history(config, {"action": action, **fields})\n',
    expected: /^rejected BI-05 database-connect-per-item:\S+log_history_postgres\.py:\d+ at music_app\/services\/cover_manual_links\.py:\d+ from py:music_app\/routes\/api_wave_d_asgi_routes\.py#utilities_cover_lookup_add_remote:route:POST \/utilities\/cover-lookup\/add-remote via .*_seeded_log_history_event > /,
  },
];

function seededOverrides() {
  const js = {};
  const py = {};
  for (const defect of DEFECTS) {
    const overrides = defect.language === 'js' ? js : py;
    inject(overrides, defect.file, defect.anchor, defect.replacement);
    for (const [anchor, replacement] of defect.also || []) inject(overrides, defect.file, anchor, replacement);
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
