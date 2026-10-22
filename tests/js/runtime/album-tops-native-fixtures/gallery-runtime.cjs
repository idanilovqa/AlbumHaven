'use strict';
const vm = require('node:vm');
const {readRepo} = require('../native-home-harness.cjs');

// Add the native saved-Top dependencies to the established dialog fixture.
// Rendering, reconciliation, geometry, motion, selection and View remain their
// complete production owners. Only browser APIs and fixture shell are supplied.
function installGalleryRuntime(env, runtime, {frames, timers}) {
  const {context: c, document: doc} = env;
  let sequence = 0;
  const schedule = callback => {const key = --sequence; frames.set(key, callback); return key;};
  Object.assign(c, {
    scheduleBrowserAnimationFrame: schedule, cancelBrowserAnimationFrame: key => frames.delete(key),
    // Zero-delay browser tasks run after the dispatch/microtask turn, not as
    // animation frames. Positive-delay timers remain pending for explicit owner
    // cancellation; these component tests do not advance a wall-clock animation.
    scheduleBrowserTimeout(callback, delay = 0) {
      const key = --sequence, timer = {callback, task: null}; timers.set(key, timer);
      if (Number(delay) <= 0) timer.task = setImmediate(() => {
        if (timers.get(key) !== timer) return;
        timers.delete(key); callback();
      });
      return key;
    },
    clearBrowserTimeout(key) {
      const timer = timers.get(key);
      if (!timer) return;
      timers.delete(key); if (timer.task !== null) clearImmediate(timer.task);
    },
    usesMobilePageLayout: () => c.innerWidth <= 900,
    matchMedia(query) {const target = doc.createElement('media'); target.matches = query.includes('reduce') ? false : c.innerWidth <= 600; return target;},
  });
  c.ResizeObserver.prototype.unobserve = function () {};
  const proto = c.Element.prototype;
  Object.assign(proto, {clientWidth: 980, clientHeight: 600, scrollWidth: 0, scrollHeight: 0, offsetWidth: 100, offsetHeight: 100});
  for (const id of ['albums-scroll', 'artist-groups', 'albums-spacer-top', 'albums-spacer-bottom']) {
    const element = doc.createElement('div'); element.id = id; doc.body.append(element);
  }
  c.state ||= {}; c.state.view ||= {}; c.state.gallery ||= {};
  for (const file of ['runtime/compact-player-helpers.js', 'runtime/modal-and-overlay-helpers.js', 'runtime/virtual-artist-grid.js',
    'runtime/gallery-display-preference-helpers.js', 'runtime/resource-selection.js', 'unfolding-action-button.js', 'client-device-preferences.js']) {
    vm.runInContext(readRepo(`music_app/static/js/${file}`), c, {filename: file});
  }
  // Loading the full shared file constructs Artist's idle singleton. Its real
  // destructor removes its own listeners before these Top-only cases begin.
  env.owner('virtualGrid').destroy();
  Object.assign(runtime, {
    escapeHtml: env.owner('escapeHtml'),
    galleryPreferences() {const value = env.owner('getSavedGalleryDisplayPreferences')(); return {
      galleryDisplayMode: value.defaultGalleryDisplayMode, galleryScalePercent: value.defaultGalleryScalePercent, mobileGalleryColumns: 3};},
    viewChooserHtml: config => c.UnfoldingActionButton.render(config),
    mountViewChooser: (host, options) => c.UnfoldingActionButton.mount(host, options),
    viewIconHtml(mode) {const holder = doc.createElement('div'); holder.innerHTML = env.owner('buildGalleryBarHtml')({}); return holder.querySelector(`[data-gallery-view-choice="${mode}"] svg`)?.outerHTML || '';},
    createGalleryHost: options => new (env.owner('ResourceGalleryHost'))(options),
    createGalleryMetadataOwner: options => env.owner('createGalleryCardMetadataMotion')(options),
    createGalleryFocusOwner: options => env.owner('createGalleryFocusGlowOwner')(options),
    createResourceSelection: options => c.AlbumHavenResourceSelection.create(options),
    projectResourceTarget: value => c.AlbumHavenResourceSelection.projectTarget(value),
    projectResourceOrigin: value => c.AlbumHavenResourceSelection.projectOrigin(value),
    setGalleryDisplayMode(mode) {const preferences = env.owner('getSavedGalleryDisplayPreferences')();
      env.owner('persistCurrentGalleryDisplayPreferences')({gallery_display_mode: mode, gallery_scale_percent: preferences.defaultGalleryScalePercent}); return true;},
  });
}
module.exports = {installGalleryRuntime};
