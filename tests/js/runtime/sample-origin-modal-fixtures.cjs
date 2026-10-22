const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {withPlaylistDomPlatform} = require('./playlist-dom-platform.cjs');
const {installSampleModalSelectors, installSampleStateDefaults} = require('./sample-browser-platform.cjs');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'track-modal-lightbox-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

function loadHelper(options = {}) {
  // Reuse the unchanged bounded DOM parser/selectors, rather than making
  // querySelector silently return null. The product VM below retains one state.
  const dom = withPlaylistDomPlatform(createNativeHomeRuntime()), document = dom.document;
  installSampleModalSelectors(dom.context);
  const element = (id, tag = 'div') => {
    const node = document.createElement(tag); node.id = id; document.body.append(node);
    dom.setRect(node, {width: 100, height: 32}); return node;
  };
  const trackModal = element('track-modal'); trackModal.hidden = true; trackModal.className = 'track-modal';
  const trackModalDialog = element('track-modal-dialog'); trackModalDialog.className = 'track-modal-dialog';
  const trackModalHeader = element('track-modal-header'); trackModalHeader.className = 'track-modal-header';
  const trackModalClose = element('track-modal-close', 'button');
  const trackModalTitle = element('track-modal-title');
  const trackModalSubtitle = element('track-modal-subtitle');
  const trackModalCover = element('track-modal-cover');
  const trackModalMissingWarning = element('track-modal-missing-warning');
  const trackModalDuplicateWarning = element('track-modal-duplicate-warning');
  const trackModalDuplicateTabs = element('track-modal-duplicate-tabs');
  const trackModalList = element('track-modal-list');
  const trackModalFooter = element('track-modal-footer');
  const trackModalTabs = element('track-modal-tabs');
  const trackModalEditTags = element('track-modal-edit-tags', 'button');
  const trackModalFolder = element('track-modal-folder', 'button');
  const utilityModal = element('utility-modal'); utilityModal.hidden = true; utilityModal.className = 'utility-modal';
  const lightboxOverlay = element('image-lightbox'); lightboxOverlay.hidden = true; lightboxOverlay.className = 'image-lightbox';
  const lightboxLoading = element('image-lightbox-loading');
  const lightboxImage = element('image-lightbox-image', 'img');
  const lightboxPrev = element('image-lightbox-prev', 'button');
  const lightboxNext = element('image-lightbox-next', 'button');
  trackModal.append(trackModalDialog);
  trackModalDialog.append(trackModalHeader, trackModalClose, trackModalCover,
    trackModalMissingWarning, trackModalDuplicateWarning, trackModalDuplicateTabs, trackModalList,
    trackModalFooter, trackModalTabs, trackModalEditTags, trackModalFolder);
  trackModalHeader.append(trackModalTitle, trackModalSubtitle);
  lightboxOverlay.append(lightboxLoading, lightboxImage, lightboxPrev, lightboxNext);
  const openButton = element('album-open-button', 'button'); openButton.dataset.openTracklist = '1';
  openButton.dataset.albumKey = 'alpha';
  const modalSchedulingEvents = [];
  const galleryImages = Array.isArray(options.galleryImageSources)
    ? options.galleryImageSources.map((src, index) => {
      const image = element(`gallery-cover-${index}`, 'img');
      image.setAttribute('src', src);
      const removeAttribute = image.removeAttribute.bind(image);
      image.removeAttribute = (name) => {
        if (name === 'src') {
          modalSchedulingEvents.push(`suspend-gallery-src-${index}`);
        }
        removeAttribute(name);
      };
      return image;
    })
    : [];
  const galleryEl = element('artist-groups'); galleryEl.append(...galleryImages);
  const indexedAlbums = new Map(
    Array.isArray(options.initialAlbums) && options.initialAlbums.length
      ? options.initialAlbums.map((album) => [String(album.key || ''), album])
      : [['alpha', { key: 'alpha', name: 'Album Alpha' }]],
  );
  const context = {
    activeTagEditMutationClaim: options.activeTagEditMutationClaim || null,
    virtualGrid: options.virtualGrid,
    scheduleBrowserAnimationFrame: options.scheduleBrowserAnimationFrame,
    compactCurrentViewForIdle: options.compactCurrentViewForIdle,
    AbortController,
    Promise,
    Array,
    Map,
    HTMLElement: dom.context.HTMLElement,
    Element: dom.context.Element,
    Event: dom.context.Event,
    getComputedStyle(element) {
      const zIndex = element.id === 'image-lightbox' ? 4600
        : element.id === 'utility-modal' ? 112
          : element.classList.contains('is-above-settings') ? 114 : 100;
      return { zIndex: String(zIndex), position: 'fixed', opacity: '1', visibility: 'visible' };
    },
    document,
    state: {
      status: {
        inventory_mutation_revision: Number(options.inventoryMutationRevision || 0),
      },
      modalReleases: [],
      modalReleaseIndex: 0,
      ui: {
        pendingSelectedArtistReconcileTimer: 0,
        pendingTrackModalLoadAlbumKey: '',
        pendingTrackModalLoadToken: 0,
      },
      gallery: {
        albumIndex: indexedAlbums,
      },
      utility: {
        loaded: Boolean(options.utilityLoaded),
      },
      busy: Boolean(options.busy),
      view: {
        query: '',
        selected_artist: '',
      },
      lightbox: {
        sourceAlbumKey: '',
        items: [],
        currentIndex: -1,
        panX: 0,
        panY: 0,
        dragging: false,
      },
    },
    getTrackModalElements() {
      return {
        overlay: trackModal,
        title: trackModalTitle,
        subtitle: trackModalSubtitle,
        cover: trackModalCover,
        missingWarning: trackModalMissingWarning,
        duplicateWarning: trackModalDuplicateWarning,
        duplicateTabs: trackModalDuplicateTabs,
        list: trackModalList,
        footer: trackModalFooter,
        tabs: trackModalTabs,
        editTags: trackModalEditTags,
        folder: trackModalFolder,
        close: trackModalClose,
      };
    },
    getLightboxElements() {
      return {
        overlay: lightboxOverlay,
        loading: lightboxLoading,
        image: lightboxImage,
        prev: lightboxPrev,
        next: lightboxNext,
      };
    },
    bindOverlayPointerOriginCalls: 0,
    bindOverlayPointerOrigin() {
      context.bindOverlayPointerOriginCalls += 1;
    },
    getAlbumReleaseSet(album) {
      return {
        releases: [album, { ...album, key: 'beta' }],
        selectedIndex: 0,
      };
    },
    hideVersionContextMenuCalls: 0,
    hideVersionContextMenu() {
      context.hideVersionContextMenuCalls += 1;
    },
    renderTrackModalReleaseCalls: [],
    renderTrackModalReleaseAlbums: [],
    renderTrackModalRelease(album) {
      context.renderTrackModalReleaseCalls.push(album?.key || null);
      context.renderTrackModalReleaseAlbums.push(album);
    },
    attachSharedPlayerCalls: 0,
    attachSharedPlayer() {
      context.attachSharedPlayerCalls += 1;
    },
    clearPendingSelectedArtistReconcileCalls: 0,
    clearPendingSelectedArtistReconcile() {
      context.clearPendingSelectedArtistReconcileCalls += 1;
      context.state.ui.pendingSelectedArtistReconcileTimer = 0;
    },
    loadProblematicFilesCalls: [],
    loadProblematicFiles(force) {
      context.loadProblematicFilesCalls.push(force);
      return Promise.resolve();
    },
    fetchCalls: [],
    fetch(url, requestOptions = {}) {
      modalSchedulingEvents.push('fetch-album-details');
      context.fetchCalls.push({ url, requestOptions });
      if (typeof options.onFetchAlbumDetails === 'function') {
        return Promise.resolve(options.onFetchAlbumDetails({ context, indexedAlbums, url, requestOptions }));
      }
      const album = options.fetchedAlbum || indexedAlbums.get('alpha') || null;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, album }),
      });
    },
    modalSchedulingEvents,
    showToastCalls: [],
    showToast(message, tone, duration) {
      context.showToastCalls.push({ message, tone, duration });
    },
    escapeHtml(value) {
      return String(value);
    },
    albumHasDisplayCover(album) {
      return Boolean(album?.cover_path || options.albumHasDisplayCover);
    },
    buildAlbumDisplayCoverUrlCalls: [],
    buildAlbumDisplayCoverUrl(album) {
      context.buildAlbumDisplayCoverUrlCalls.push(album);
      return '/cover.png';
    },
    buildTrackModalCoverVisualHtml() {
      return '<img alt="">';
    },
    console: {
      error(...args) {
        context.consoleErrorCalls.push(args);
      },
    },
    consoleErrorCalls: [],
    setLightboxZoomCalls: [],
    setLightboxZoom(zoom) {
      context.setLightboxZoomCalls.push(zoom);
    },
    updateLightboxNavStateCalls: 0,
    updateLightboxNavState() {
      context.updateLightboxNavStateCalls += 1;
    },
    stopLightboxDragCalls: 0,
    stopLightboxDrag() {
      context.stopLightboxDragCalls += 1;
    },
    showLightboxItemCalls: [],
    showLightboxItem(index) {
      context.showLightboxItemCalls.push(index);
      context.state.lightbox.currentIndex = index;
      return true;
    },
    getIndexedAlbum(key) {
      return indexedAlbums.get(key) || null;
    },
    getAlbumIdentity(album) {
      return String(album?.identity_key || album?.key || '');
    },
    getAlbumRequestKey(album) {
      return String(album?.request_key || album?.key || '');
    },
    tagEditViewMutationStillOwnsResources(claim) {
      return claim === context.activeTagEditMutationClaim;
    },
    overlayClickStartedOnOverlay() {
      return Boolean(options.overlayClickCloses);
    },
    getRepairConfirmElements() {
      return { overlay: { hidden: true } };
    },
    closeRepairConfirmModal() {
      context.closeRepairConfirmModalCalls += 1;
    },
    closeRepairConfirmModalCalls: 0,
    getCoverLookupModalElements() {
      return { overlay: { hidden: true } };
    },
    closeCoverLookupModal() {
      context.closeCoverLookupModalCalls += 1;
    },
    closeCoverLookupModalCalls: 0,
    getCoverLookupDeleteConfirmElements() {
      return { overlay: { hidden: true } };
    },
    closeCoverLookupDeleteConfirm() {
      context.closeCoverLookupDeleteConfirmCalls += 1;
    },
    closeCoverLookupDeleteConfirmCalls: 0,
    getUtilityModalElements() {
      return { overlay: utilityModal };
    },
    closeUtilityModal() {
      context.closeUtilityModalCalls += 1;
    },
    closeUtilityModalCalls: 0,
    getNonAlbumModalElements() {
      return { overlay: { hidden: true } };
    },
    closeNonAlbumModal() {
      context.closeNonAlbumModalCalls += 1;
    },
    closeNonAlbumModalCalls: 0,
    stepLightboxCalls: [],
    stepLightbox(direction) {
      context.stepLightboxCalls.push(direction);
    },
  };

  context.window = context;
  installSampleStateDefaults(context.state);
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'bootstrap-state.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'response-state-helpers.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'album-artbox.js'), 'utf8'), context);
  vm.runInContext(helperSource, context, { filename: helperPath });

  return {
    context,
    trackModal,
    trackModalCover,
    galleryImages,
    utilityModal,
    lightboxOverlay,
    lightboxImage,
    openButton,
    element,
  };
}
// Retained modal owner unit inputs with actual bounded DOM behavior.
// No existing test is imported, evaluated, or changed. Render HTML remains stubbed.
function modalFixture() {
  const h = loadHelper(), c = h.context, extra = new Map(), prepared = new Map();
  c.window = c; c.state.player = {current: null};
  let scope = 'sample:scope', browse = true;
  c.TrackActionsRuntime = {scope: () => ({token: scope})};
  c.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: scope, authenticated: true})};
  c.AlbumHavenCapabilities = {allows: name => name === 'library.browse.read' ? browse : false};
  for (const id of ['non-album-modal', 'non-album-modal-header', 'non-album-modal-table', 'non-album-modal-close']) {
    const node = h.element(id, id.endsWith('-close') ? 'button' : 'div'); extra.set(id, node);
  }
  const loose = extra.get('non-album-modal'); loose.hidden = true; loose.className = 'non-album-modal';
  loose.append(extra.get('non-album-modal-header'), extra.get('non-album-modal-table'), extra.get('non-album-modal-close'));
  Object.assign(c, {
    formatTrackDuration: value => String(value), formatAlbumDuration: value => String(value),
    getPlayerPlaybackSnapshot: () => ({paused: true, ended: false}), getProblematicAlbumForTrackPath: () => null,
    buildAlbumTrackTableHtml: () => '<table></table>', albumTrackTableColumns: () => [],
    buildAlbumDetailsHeaderHtml: () => '<header></header>', buildLooseTracksHeaderActionsHtml: () => '',
    activeGallerySourceCategories: state => state.categories,
    gallerySourceScopesEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    NativePlaytables: {
      prepare(key, sourceIdentity, groups, privateRows, isCurrent) {
        const owner = {sourceIdentity, groups, privateRows, isCurrent};
        owner.source = {snapshot: () => prepared.get(key) === owner && isCurrent() ? {rows: privateRows} : null};
        prepared.set(key, owner); return owner;
      },
      mount() {}, retire(key) {prepared.delete(key);},
    },
  });
  vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), 'modal-and-overlay-helpers.js'), 'utf8'), c,
    {filename: 'runtime/modal-and-overlay-helpers.js'});
  // The shared header's visual implementation is not under test here.
  c.buildLooseTracksHeaderActionsHtml = () => '';
  const capturePhysical = options => {
    assert.equal(typeof c.captureTrackModalSampleOrigin, 'function', 'See NATIVE-SEAMS.md; never install a test implementation');
    return c.captureTrackModalSampleOrigin({libraryRef: '5', ...options});
  };
  const captureLoose = () => {
    assert.equal(typeof c.captureNonAlbumSampleOrigin, 'function', 'See NATIVE-SEAMS.md; never install a test implementation');
    return c.captureNonAlbumSampleOrigin({libraryRef: '5'});
  };
  return {...h, c, prepared, capturePhysical, captureLoose, extra,
    setScope: value => {scope = value;}, denyBrowse: () => {browse = false;},
    button(index) {const result = h.element('duplicate', 'button'); result.dataset.albumKey = 'actual:alpha';
      result.setAttribute('data-album-key', 'actual:alpha'); result.setAttribute('data-duplicate-source-index', String(index)); return result;}};
}
module.exports = {modalFixture};
