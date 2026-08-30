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
  'track-modal-lightbox-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.values.delete(token));
  }

  contains(token) {
    return this.values.has(token);
  }
}

  class FakeElement {
    constructor(id = '') {
      this.id = id;
      this.hidden = true;
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.classList = new FakeClassList();
      this.alt = '';
      this.src = '';
    }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  dispatchEvent(type, event = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.forEach((handler) => handler({
      preventDefault() {},
      target: this,
      ...event,
    }));
  }

  click(event = {}) {
    this.dispatchEvent('click', event);
  }

    closest() {
      return null;
    }

    getAttribute(name) {
      if (name === 'src') return this.src;
      return this.attributes.get(name) || '';
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'src') {
        this.src = String(value);
      }
    }

    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === 'src') {
        this.src = '';
      }
      if (name === 'srcset') {
        this.srcset = '';
      }
    }
  }

class FakeHtmlElement extends FakeElement {}

function loadHelper(options = {}) {
  const trackModal = new FakeElement('track-modal');
  const trackModalClose = new FakeElement('track-modal-close');
  const trackModalTitle = new FakeElement('track-modal-title');
  const trackModalSubtitle = new FakeElement('track-modal-subtitle');
  const trackModalCover = new FakeElement('track-modal-cover');
  const trackModalDuplicateWarning = new FakeElement('track-modal-duplicate-warning');
  const trackModalDuplicateTabs = new FakeElement('track-modal-duplicate-tabs');
  const trackModalList = new FakeElement('track-modal-list');
  const trackModalFooter = new FakeElement('track-modal-footer');
  const trackModalTabs = new FakeElement('track-modal-tabs');
  const trackModalEditTags = new FakeElement('track-modal-edit-tags');
  const trackModalFolder = new FakeElement('track-modal-folder');
  const utilityModal = new FakeElement('utility-modal');
  const lightboxOverlay = new FakeElement('image-lightbox');
  const lightboxLoading = new FakeElement('image-lightbox-loading');
  const lightboxImage = new FakeElement('image-lightbox-image');
  const lightboxPrev = new FakeElement('image-lightbox-prev');
  const lightboxNext = new FakeElement('image-lightbox-next');
  const openButton = new FakeHtmlElement('album-open-button');
  openButton.dataset.albumKey = 'alpha';
  const modalSchedulingEvents = [];
  const galleryImages = Array.isArray(options.galleryImageSources)
    ? options.galleryImageSources.map((src, index) => {
      const image = new FakeElement(`gallery-cover-${index}`);
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
  const galleryEl = {
    querySelectorAll(selector) {
      if (selector === 'img') return galleryImages;
      if (selector === 'img[data-modal-suspended-src]') {
        return galleryImages.filter((image) => Boolean(image.dataset.modalSuspendedSrc));
      }
      return [];
    },
  };
  const indexedAlbums = new Map(
    Array.isArray(options.initialAlbums) && options.initialAlbums.length
      ? options.initialAlbums.map((album) => [String(album.key || ''), album])
      : [['alpha', { key: 'alpha', name: 'Album Alpha' }]],
  );
  const elementsById = {
    'track-modal': trackModal,
    'track-modal-close': trackModalClose,
    'track-modal-title': trackModalTitle,
    'track-modal-subtitle': trackModalSubtitle,
    'track-modal-cover': trackModalCover,
    'track-modal-duplicate-warning': trackModalDuplicateWarning,
    'track-modal-duplicate-tabs': trackModalDuplicateTabs,
    'track-modal-list': trackModalList,
    'track-modal-footer': trackModalFooter,
    'track-modal-tabs': trackModalTabs,
    'track-modal-edit-tags': trackModalEditTags,
    'track-modal-folder': trackModalFolder,
    'utility-modal': utilityModal,
    'image-lightbox': lightboxOverlay,
    'image-lightbox-loading': lightboxLoading,
    'image-lightbox-image': lightboxImage,
    'image-lightbox-prev': lightboxPrev,
    'image-lightbox-next': lightboxNext,
    'artist-groups': galleryEl,
  };
  const documentListeners = new Map();
  const context = {
    virtualGrid: options.virtualGrid,
    AbortController,
    Promise,
    Array,
    Map,
    HTMLElement: FakeHtmlElement,
    document: {
      body: {
        classList: new FakeClassList(),
      },
      getElementById(id) {
        return elementsById[id] || null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-open-tracklist="1"]') {
          return [openButton];
        }
        return [];
      },
      addEventListener(type, handler) {
        if (!documentListeners.has(type)) {
          documentListeners.set(type, []);
        }
        documentListeners.get(type).push(handler);
      },
    },
    state: {
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

  vm.createContext(context);
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
    documentListeners,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function flushAlbumDetailsHydration() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createCoverSuspensionHarness(initialTokens = []) {
  const activeTokens = new Set(initialTokens);
  let nextToken = initialTokens.reduce((maximum, token) => Math.max(maximum, Number(token) || 0), 0);
  const calls = {
    suspend: 0,
    resume: 0,
    acquired: [],
    released: [],
  };
  return {
    activeTokens,
    calls,
    virtualGrid: {
      suspendSelectedArtistCoverLoadsForUserAction() {
        nextToken += 1;
        if (!activeTokens.size) calls.suspend += 1;
        activeTokens.add(nextToken);
        calls.acquired.push(nextToken);
        return nextToken;
      },
      resumeSelectedArtistCoverLoadsAfterUserAction(token) {
        const normalizedToken = Number(token);
        if (!activeTokens.delete(normalizedToken)) return false;
        calls.released.push(normalizedToken);
        if (!activeTokens.size) calls.resume += 1;
        return true;
      },
    },
  };
}

async function run() {
  {
    const { context, trackModal } = loadHelper();
    context.openTrackModal({ key: 'alpha', name: 'Album Alpha' });
    await flushMicrotasks();

    assert.equal(trackModal.hidden, false);
    assert.equal(context.state.modalReleaseIndex, 0);
    assert.equal(context.state.modalReleases.length, 2);
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
    assert.equal(context.attachSharedPlayerCalls, 1);
    assert.equal(context.clearPendingSelectedArtistReconcileCalls, 1);
    assert.deepEqual(context.loadProblematicFilesCalls, []);
    assert.equal(context.document.body.classList.contains('modal-open'), true);
  }

  {
    const previewAlbum = { key: 'alpha', name: 'Album Alpha Preview', preview_only: true };
    const hydratedAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: false,
      tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac' }],
    };
    const { context } = loadHelper({
      initialAlbums: [previewAlbum],
      fetchedAlbum: hydratedAlbum,
    });

    context.openTrackModal(previewAlbum, { coverLightboxGallery: false });
    assert.equal(
      context.state.ui.trackModalCoverLightboxGallery,
      false,
      'the player-origin modal must enter single-cover mode before detail hydration',
    );
    await flushMicrotasks();

    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
    assert.equal(
      context.state.ui.trackModalCoverLightboxGallery,
      false,
      'detail hydration must preserve the player-origin single-cover mode',
    );

    context.openTrackModal({ key: 'beta', name: 'Album Beta', tracks: [] });
    assert.equal(
      context.state.ui.trackModalCoverLightboxGallery,
      true,
      'an ordinary album open must restore gallery lightbox navigation',
    );
  }

  {
    const compactAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: false,
      tracks: [],
      track_count_preview: 16,
    };
    const hydratedAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: false,
      tracks: Array.from({ length: 16 }, (_value, index) => ({
        path: `C:\\Music\\Album Alpha\\${String(index + 1).padStart(2, '0')} Track.flac`,
      })),
    };
    const { context, trackModal } = loadHelper({
      initialAlbums: [compactAlbum],
      fetchedAlbum: hydratedAlbum,
    });

    context.openTrackModal(compactAlbum);

    assert.equal(trackModal.hidden, false, 'the loading shell must open immediately');
    assert.match(
      context.getTrackModalElements().list.innerHTML,
      /Loading album details/,
      'the compact album must show the loading shell while full membership is fetched',
    );
    assert.equal(context.fetchCalls.length, 1, 'the compact album must request details exactly once');
    assert.equal(context.fetchCalls[0].url, '/album-details?album_key=alpha');

    await flushMicrotasks();

    assert.equal(context.fetchCalls.length, 1, 'hydration must not duplicate the detail request');
    assert.equal(context.renderTrackModalReleaseAlbums.length, 1);
    assert.equal(context.renderTrackModalReleaseAlbums[0].tracks.length, 16);
  }

  {
    const partiallyRestoredAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: false,
      tracks: [{ path: 'C:\\Music\\Album Alpha\\02 Restored Track.flac' }],
      track_count_preview: 15,
    };
    const hydratedAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: false,
      tracks: Array.from({ length: 15 }, (_value, index) => ({
        path: `C:\\Music\\Album Alpha\\${String(index + 1).padStart(2, '0')} Track.flac`,
      })),
      track_count_preview: 15,
    };
    const { context, trackModal } = loadHelper({
      initialAlbums: [partiallyRestoredAlbum],
      fetchedAlbum: hydratedAlbum,
    });

    context.openTrackModal(partiallyRestoredAlbum);

    assert.match(
      context.getTrackModalElements().list.innerHTML,
      /Loading album details/,
      'an optimistic partial restore must not render as complete membership',
    );
    assert.equal(context.fetchCalls.length, 1, 'a declared-count mismatch must request full details');

    await flushMicrotasks();

    assert.equal(trackModal.hidden, false);
    assert.equal(context.renderTrackModalReleaseAlbums.length, 1);
    assert.equal(context.renderTrackModalReleaseAlbums[0].tracks.length, 15);
  }

  {
    const indexedAlpha = { key: 'alpha', name: 'Album Alpha Preview', preview_only: true };
    const indexedBeta = { key: 'beta', name: 'Album Beta Preview', preview_only: true };
    const hydratedAlpha = {
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: false,
      tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac' }],
    };
    const { context } = loadHelper({ initialAlbums: [indexedAlpha, indexedBeta] });
    const alphaButton = new context.HTMLElement('alpha-action');
    alphaButton.setAttribute('data-album-key', 'alpha');
    const betaButton = new context.HTMLElement('beta-action');
    betaButton.setAttribute('data-album-key', 'beta');

    context.openTrackModal(hydratedAlpha);

    assert.strictEqual(context.resolveTrackModalActionAlbum(alphaButton), hydratedAlpha);
    assert.strictEqual(context.resolveTrackModalActionAlbum(betaButton), indexedBeta);

    context.state.modalReleases = [];
    context.state.modalReleaseIndex = 0;

    assert.strictEqual(context.resolveTrackModalActionAlbum(alphaButton), indexedAlpha);
  }

  {
    const { context, trackModal } = loadHelper({
      busy: true,
      onFetchAlbumDetails({ indexedAlbums, url }) {
        assert.equal(url, '/album-details?album_key=alpha');
        const album = {
          key: 'alpha',
          name: 'Album Alpha',
          tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac' }],
        };
        indexedAlbums.set('alpha', album);
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, album }),
        };
      },
    });
    context.openTrackModal({ key: 'alpha', name: 'Album Alpha', preview_only: true });
    await flushMicrotasks();

    assert.equal(trackModal.hidden, false);
    assert.equal(context.fetchCalls.length, 1);
    assert.equal(context.fetchCalls[0].requestOptions.headers.Accept, 'application/json');
    assert.equal(context.showToastCalls.length, 0);
    assert.equal(context.state.ui.pendingTrackModalLoadAlbumKey, '');
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
  }

  {
    const scheduling = [];
    const hydratedAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac' }],
    };
    const { context } = loadHelper({
      virtualGrid: {
        suspendSelectedArtistCoverLoadsForUserAction() {
          scheduling.push('covers-suspended');
          return 7;
        },
        resumeSelectedArtistCoverLoadsAfterUserAction(token) {
          scheduling.push(`covers-resumed:${token}`);
        },
      },
      onFetchAlbumDetails({ indexedAlbums }) {
        assert.deepEqual(scheduling, ['covers-suspended']);
        indexedAlbums.set('alpha', hydratedAlbum);
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, album: hydratedAlbum }),
        };
      },
    });

    context.openTrackModal({ key: 'alpha', name: 'Album Alpha', preview_only: true });
    await flushMicrotasks();

    assert.deepEqual(scheduling, ['covers-suspended', 'covers-resumed:7']);
  }

  for (const completionOrder of [['beta', 'alpha'], ['alpha', 'beta']]) {
    const suspensionHarness = createCoverSuspensionHarness();
    const pendingResponses = new Map();
    const { context } = loadHelper({
      virtualGrid: suspensionHarness.virtualGrid,
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true },
        { key: 'beta', name: 'Album Beta', preview_only: true },
      ],
      onFetchAlbumDetails({ url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return new Promise((resolve) => pendingResponses.set(albumKey, resolve));
      },
    });

    context.openTrackModal({ key: 'alpha', name: 'Album Alpha', preview_only: true });
    context.openTrackModal({ key: 'beta', name: 'Album Beta', preview_only: true });

    assert.equal(suspensionHarness.calls.suspend, 1);
    assert.deepEqual(suspensionHarness.calls.acquired, [1, 2]);
    assert.deepEqual([...suspensionHarness.activeTokens], [1, 2]);

    for (const [index, albumKey] of completionOrder.entries()) {
      pendingResponses.get(albumKey)({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          ok: true,
          album: { key: albumKey, name: `Album ${albumKey}`, tracks: [] },
        }),
      });
      pendingResponses.delete(albumKey);
      await flushMicrotasks();
      if (index === 0) {
        assert.equal(suspensionHarness.calls.resume, 0);
      }
    }

    assert.equal(suspensionHarness.calls.resume, 1);
    assert.deepEqual(
      suspensionHarness.calls.released,
      completionOrder.map((albumKey) => (albumKey === 'alpha' ? 1 : 2)),
    );
    assert.equal(suspensionHarness.activeTokens.size, 0);
  }

  {
    const navigationToken = 40;
    const suspensionHarness = createCoverSuspensionHarness([navigationToken]);
    const pendingResponses = new Map();
    const { context } = loadHelper({
      virtualGrid: suspensionHarness.virtualGrid,
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true },
        { key: 'beta', name: 'Album Beta', preview_only: true },
      ],
      onFetchAlbumDetails({ url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return new Promise((resolve) => pendingResponses.set(albumKey, resolve));
      },
    });

    context.openTrackModal({ key: 'alpha', name: 'Album Alpha', preview_only: true });
    context.openTrackModal({ key: 'beta', name: 'Album Beta', preview_only: true });
    assert.deepEqual([...suspensionHarness.activeTokens], [navigationToken, 41, 42]);

    context.closeTrackModal();

    assert.deepEqual([...suspensionHarness.activeTokens], [navigationToken]);
    assert.deepEqual(suspensionHarness.calls.released, [41, 42]);
    assert.equal(suspensionHarness.calls.resume, 0);

    suspensionHarness.virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(navigationToken);
    assert.equal(suspensionHarness.calls.resume, 1);
  }

  {
    const { context, trackModal, trackModalCover, galleryImages } = loadHelper({
      galleryImageSources: ['/cover?path=one', '/cover?path=two'],
      onFetchAlbumDetails({ url }) {
        assert.equal(url, '/album-details?album_key=alpha');
        assert.equal(trackModal.hidden, false, 'the loading shell should be visible before the detail fetch starts');
        assert.deepEqual(
          galleryImages.map((image) => image.src),
          ['/cover?path=one', '/cover?path=two'],
          'opening the real modal must not strip already-loaded gallery image sources',
        );
        return new Promise(() => {});
      },
    });

    context.openTrackModal({
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: true,
      cover_path: 'C:/Music/Album Alpha/cover.jpg',
    });

    assert.equal(trackModal.hidden, false);
    assert.equal(context.fetchCalls.length, 1);
    assert.deepEqual(context.modalSchedulingEvents, ['fetch-album-details']);
    assert.match(trackModalCover.innerHTML, /Loading cover art/);
    assert.doesNotMatch(trackModalCover.innerHTML, /<img/);
    assert.deepEqual(galleryImages.map((image) => image.src), ['/cover?path=one', '/cover?path=two']);
    assert.deepEqual(galleryImages.map((image) => image.dataset.modalSuspendedSrc), [undefined, undefined]);

    context.closeTrackModal();

    assert.deepEqual(galleryImages.map((image) => image.src), ['/cover?path=one', '/cover?path=two']);
    assert.deepEqual(galleryImages.map((image) => image.dataset.modalSuspendedSrc), [undefined, undefined]);
  }

  {
    const trackPath = 'C:\\Music\\Album Alpha\\01 Track.flac';
    const { context } = loadHelper({
      initialAlbums: [{
        key: 'alpha',
        name: 'Album Alpha',
        album_artist: 'Artist Alpha',
        preview_only: true,
        tracks: [{ path: trackPath }],
      }],
      onFetchAlbumDetails({ url }) {
        assert.equal(
          url,
          '/album-details?album_key=alpha',
          'album detail requests must use the stable album key instead of a track-path signature',
        );
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            album: {
              key: 'alpha',
              name: 'Album Alpha',
              album_artist: 'Artist Alpha',
              tracks: [{ path: trackPath }],
            },
          }),
        };
      },
    });
    context.openTrackModal({
      key: 'alpha',
      name: 'Album Alpha',
      album_artist: 'Artist Alpha',
      preview_only: true,
      tracks: [{ path: trackPath }],
    });
    await flushMicrotasks();

    assert.equal(context.fetchCalls.length, 1);
    assert.equal(context.fetchCalls[0].url, '/album-details?album_key=alpha');
  }

  {
    const playbackContext = {
      kind: 'artist_page',
      end_behavior: 'stop',
      ordered_album_refs: ['alpha', 'beta'],
      albums: [
        { album_ref: 'alpha', can_play: true },
        { album_ref: 'beta', can_play: true },
      ],
    };
    const { context } = loadHelper({
      busy: true,
      onFetchAlbumDetails({ indexedAlbums }) {
        const album = {
          key: 'alpha',
          name: 'Album Alpha',
          tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac' }],
        };
        indexedAlbums.set('alpha', album);
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, album }),
        };
      },
    });
    context.state.view.playback_context = playbackContext;
    context.openTrackModal({
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: true,
      playback_context: playbackContext,
    });
    await flushMicrotasks();

    assert.strictEqual(context.getIndexedAlbum('alpha').playback_context, playbackContext);
    assert.strictEqual(context.state.modalReleases[0].playback_context, playbackContext);
  }

  {
    let resolveAlbumDetails;
    const { context, trackModal } = loadHelper({
      initialAlbums: [{ key: 'alpha', name: 'Album Alpha', preview_only: true }],
      onFetchAlbumDetails() {
        return new Promise((resolve) => {
          resolveAlbumDetails = resolve;
        });
      },
    });
    context.openTrackModal({
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: true,
      cover_path: 'C:/Music/Album Alpha/cover.jpg',
    });
    const elements = context.getTrackModalElements();

    assert.equal(trackModal.hidden, false);
    assert.equal(context.state.ui.pendingTrackModalLoadAlbumKey, 'alpha');
    assert.equal(elements.folder.dataset.album, '');
    assert.equal(elements.folder.dataset.albumKey, 'alpha');
    assert.equal(elements.editTags.dataset.album, '');
    assert.equal(elements.editTags.dataset.albumKey, 'alpha');
    assert.match(elements.subtitle.textContent, /Loading album details/);
    assert.match(elements.list.innerHTML, /Loading album details/);
    assert.match(elements.cover.innerHTML, /Loading cover art/);
    assert.doesNotMatch(elements.cover.innerHTML, /<img/);
    assert.doesNotMatch(elements.cover.innerHTML, /\/cover(?:\?|\.)/);
    assert.deepEqual(context.buildAlbumDisplayCoverUrlCalls, []);
    assert.deepEqual(context.renderTrackModalReleaseCalls, []);

    const hydratedAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      cover_path: 'C:/Music/Album Alpha/cover.jpg',
      tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac' }],
    };
    resolveAlbumDetails({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, album: hydratedAlbum }),
    });
    await flushMicrotasks();

    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
    assert.equal(context.renderTrackModalReleaseAlbums[0].cover_path, hydratedAlbum.cover_path);
    assert.equal(context.state.ui.pendingTrackModalLoadAlbumKey, '');

    context.closeTrackModal();
    await flushMicrotasks();

    assert.equal(trackModal.hidden, true);
    assert.equal(context.state.ui.pendingTrackModalLoadAlbumKey, '');
    assert.equal(elements.title.textContent, '');
    assert.equal(elements.cover.innerHTML, '');
    assert.equal(elements.list.innerHTML, '');
    assert.equal(elements.folder.dataset.album, '');
    assert.equal(elements.folder.dataset.albumKey, '');
    assert.equal(elements.editTags.dataset.album, '');
    assert.equal(elements.editTags.dataset.albumKey, '');
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
  }

  {
    const { context, trackModal } = loadHelper({
      onFetchAlbumDetails() {
        return new Promise(() => {});
      },
    });
    context.openTrackModal({ key: 'alpha', name: 'Album Alpha', preview_only: true });
    context.closeTrackModal();
    context.openTrackModal({ key: 'alpha', name: 'Album Alpha' });
    await flushMicrotasks();

    assert.equal(trackModal.hidden, false);
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
    assert.equal(context.state.ui.pendingTrackModalLoadAlbumKey, '');
  }

  {
    const { context } = loadHelper({
      onFetchAlbumDetails() {
        return {
          ok: false,
          status: 404,
          json: () => Promise.resolve({ ok: false, error: 'Album not found' }),
        };
      },
    });
    context.openTrackModal({ key: 'alpha', name: 'Album Alpha', preview_only: true });
    await flushMicrotasks();

    assert.equal(context.showToastCalls.length, 1);
    assert.equal(context.showToastCalls[0].message, 'Unable to load album details.');
    assert.equal(context.consoleErrorCalls.length, 1);
  }

  {
    const pendingFetches = new Map();
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
        { key: 'beta', name: 'Album Beta', preview_only: true, tracks: [] },
      ],
      onFetchAlbumDetails({ indexedAlbums, url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return new Promise((resolve) => {
          pendingFetches.set(albumKey, () => {
            const album = {
              key: albumKey,
              name: albumKey === 'alpha' ? 'Album Alpha' : 'Album Beta',
              tracks: [{ path: `C:\\Music\\${albumKey}\\01 Track.flac` }],
            };
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ ok: true, album }),
            });
          });
        });
      },
    });
    context.openTrackModal({ key: 'alpha', name: 'Album Alpha', preview_only: true });
    context.openTrackModal({ key: 'beta', name: 'Album Beta', preview_only: true });
    assert.equal(context.state.ui.pendingTrackModalLoadAlbumKey, 'beta');

    pendingFetches.get('alpha')();
    await flushMicrotasks();
    assert.deepEqual(context.renderTrackModalReleaseCalls, []);
    assert.equal((context.getIndexedAlbum('alpha')?.tracks || []).length, 1);

    pendingFetches.get('beta')();
    await flushMicrotasks();

    assert.equal(context.fetchCalls.length, 2);
    assert.deepEqual(
      context.fetchCalls.map((call) => call.url),
      ['/album-details?album_key=alpha', '/album-details?album_key=beta'],
    );
    assert.equal((context.getIndexedAlbum('beta')?.tracks || []).length, 1);
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['beta']);
    assert.equal(context.showToastCalls.length, 0);
  }

  {
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
      ],
      onFetchAlbumDetails({ url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            album: {
              key: albumKey,
              name: 'Album Alpha',
              preview_only: false,
              tracks: [{ path: `C:\\Music\\${albumKey}\\01 Track.flac` }],
            },
          }),
        };
      },
    });
    const scrollEl = new context.HTMLElement('scroll');
    scrollEl.getBoundingClientRect = () => ({ top: 0, bottom: 500, width: 400, height: 500 });
    const button = new context.HTMLElement('alpha-button');
    button.setAttribute('data-album-key', 'alpha');
    button.getBoundingClientRect = () => ({ top: 20, bottom: 60, width: 200, height: 40 });
    const containerEl = new context.HTMLElement('artist-groups');
    containerEl.querySelectorAll = (selector) => (
      selector === '.album-title-button[data-open-tracklist="1"][data-album-key]' ? [button] : []
    );

    context.queueVisibleTrackModalAlbumDetailsPrewarm(containerEl, scrollEl, 2);
    await flushMicrotasks();

    assert.equal(context.fetchCalls.length, 1);
    assert.equal((context.getIndexedAlbum('alpha')?.tracks || []).length, 1);

    context.openTrackModal(context.getIndexedAlbum('alpha'));

    assert.equal(context.fetchCalls.length, 1);
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
  }

  {
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
      ],
      onFetchAlbumDetails({ url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            album: {
              key: albumKey,
              name: 'Album Alpha',
              preview_only: false,
              tracks: [{ path: `C:\\Music\\${albumKey}\\01 Track.flac` }],
            },
          }),
        };
      },
    });

    context.queueTrackModalAlbumDetailsPrewarm('alpha');
    await flushMicrotasks();
    assert.equal(context.fetchCalls.length, 1);

    context.state.gallery.albumIndex.set('alpha', {
      key: 'alpha',
      name: 'Album Alpha',
      preview_only: true,
      tracks: [],
    });
    context.openTrackModal(context.getIndexedAlbum('alpha'));
    await flushMicrotasks();

    assert.equal(context.fetchCalls.length, 1);
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
  }

  {
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
      ],
      onFetchAlbumDetails({ url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            album: {
              key: albumKey,
              name: 'Album Alpha',
              preview_only: false,
              tracks: [{ path: `C:\\Music\\${albumKey}\\01 Track.flac` }],
            },
          }),
        };
      },
    });
    context.cacheHydratedTrackModalAlbum = () => {
      context.state.gallery.albumIndex.set('alpha', {
        key: 'alpha',
        name: 'Album Alpha',
        preview_only: true,
        tracks: [],
      });
    };

    context.openTrackModal({ key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] });
    await flushMicrotasks();

    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
    assert.equal(context.state.ui.pendingTrackModalLoadAlbumKey, '');
  }

  {
    const pendingFetches = new Map();
    const albums = ['alpha', 'beta', 'gamma', 'delta'].map((key) => ({
      key,
      name: `Album ${key}`,
      preview_only: true,
      tracks: [],
    }));
    const { context } = loadHelper({
      initialAlbums: albums,
      onFetchAlbumDetails({ url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return new Promise((resolve) => {
          if (!pendingFetches.has(albumKey)) pendingFetches.set(albumKey, []);
          pendingFetches.get(albumKey).push(resolve);
        });
      },
    });
    const resolveFetch = (albumKey) => {
      pendingFetches.get(albumKey).forEach((resolve) => resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          ok: true,
          album: {
            key: albumKey,
            name: `Album ${albumKey}`,
            preview_only: false,
            tracks: [{ path: `C:\\Music\\${albumKey}\\01 Track.flac` }],
          },
        }),
      }));
      pendingFetches.delete(albumKey);
    };

    context.queueTrackModalAlbumDetailsPrewarm('alpha');
    context.queueTrackModalAlbumDetailsPrewarm('beta');
    context.queueTrackModalAlbumDetailsPrewarm('gamma');

    assert.deepEqual(
      context.fetchCalls.map((call) => call.url),
      ['/album-details?album_key=alpha', '/album-details?album_key=beta'],
      'speculative prewarming should cap concurrent requests at two',
    );

    context.openTrackModal(context.getIndexedAlbum('alpha'));
    assert.equal(context.fetchCalls.length, 2, 'a user open should promote and reuse the speculative request');

    context.openTrackModal(context.getIndexedAlbum('gamma'));
    assert.equal(context.fetchCalls.length, 3, 'a direct user open should bypass the speculative limit');

    resolveFetch('gamma');
    await flushMicrotasks();
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['gamma']);

    resolveFetch('alpha');
    resolveFetch('beta');
    await flushMicrotasks();
    context.queueTrackModalAlbumDetailsPrewarm('delta');
    assert.equal(context.fetchCalls.at(-1).url, '/album-details?album_key=delta');

    resolveFetch('delta');
    await flushMicrotasks();
  }

  {
    const pendingFetches = new Map();
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
        { key: 'beta', name: 'Album Beta', preview_only: true, tracks: [] },
      ],
      onFetchAlbumDetails({ url, requestOptions }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return new Promise((resolve, reject) => {
          pendingFetches.set(albumKey, { reject, resolve });
          requestOptions.signal?.addEventListener('abort', () => {
            const error = new Error('speculative prewarm aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    });

    context.queueTrackModalAlbumDetailsPrewarm('alpha');
    context.queueTrackModalAlbumDetailsPrewarm('beta');
    assert.equal(context.fetchCalls.every((call) => call.requestOptions.signal), true);

    context.cancelTrackModalAlbumDetailsPrewarms();
    await flushMicrotasks();

    assert.equal(context.fetchCalls.every((call) => call.requestOptions.signal.aborted), true);
    assert.equal(pendingFetches.size, 2);
  }

  {
    let resolvePromotedFetch;
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
      ],
      onFetchAlbumDetails({ requestOptions }) {
        if (requestOptions.signal) {
          return new Promise((resolve, reject) => {
            resolvePromotedFetch = resolve;
            requestOptions.signal.addEventListener('abort', () => {
              const error = new Error('speculative prewarm aborted');
              error.name = 'AbortError';
              reject(error);
            }, { once: true });
          });
        }
        throw new Error('the interactive open must reuse the promoted speculative request');
      },
    });

    context.queueTrackModalAlbumDetailsPrewarm('alpha');
    context.openTrackModal(context.getIndexedAlbum('alpha'));

    assert.equal(context.fetchCalls.length, 1, 'an interactive open must reuse an in-flight prewarm');
    assert.equal(context.fetchCalls[0].requestOptions.signal.aborted, false);

    context.cancelTrackModalAlbumDetailsPrewarms();
    assert.equal(context.fetchCalls[0].requestOptions.signal.aborted, false,
      'global speculative cancellation must not abort a prewarm promoted by a user open');
    resolvePromotedFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        ok: true,
        album: {
          key: 'alpha',
          name: 'Album Alpha',
          preview_only: false,
          tracks: [{ path: 'C:\\Music\\alpha\\01 Track.flac' }],
        },
      }),
    });
    await flushMicrotasks();

    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
    assert.equal(context.showToastCalls.length, 0);
  }

  {
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
      ],
    });
    context.state.ui.searchDraftQuery = 'Joseph';
    context.state.view.query = '';

    context.queueTrackModalAlbumDetailsPrewarm('alpha');

    assert.deepEqual(
      context.fetchCalls,
      [],
      'a pending foreground search draft must block new speculative album-detail work',
    );
  }

  {
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
      ],
    });
    context.state.ui.searchDraftQuery = '';
    context.state.ui.albumDetailPrewarmSearchSuspended = true;
    context.state.view.query = '';

    context.queueTrackModalAlbumDetailsPrewarm('alpha');

    assert.deepEqual(
      context.fetchCalls,
      [],
      'an active search-intent suspension must survive draft normalization until navigation settles',
    );
  }

  {
    const previews = Array.from({ length: 12 }, (_value, index) => ({
      key: `album-${index + 1}`,
      name: `Album ${index + 1}`,
      preview_only: true,
      tracks: [],
    }));
    const { context } = loadHelper({
      initialAlbums: previews,
      onFetchAlbumDetails({ url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            album: {
              key: albumKey,
              name: `Hydrated ${albumKey}`,
              preview_only: false,
              tracks: [{ path: `C:\\Music\\${albumKey}\\01 Track.flac` }],
            },
          }),
        };
      },
    });

    for (let index = 1; index <= 11; index += 1) {
      await context.loadTrackModalAlbumDetails(`album-${index}`);
    }

    assert.equal(context.getIndexedAlbum('album-1').preview_only, true, 'the oldest hydrated album should be evicted');
    assert.equal(context.getIndexedAlbum('album-2').preview_only, false);
    await context.loadTrackModalAlbumDetails('album-2');
    await context.loadTrackModalAlbumDetails('album-12');

    assert.equal(context.getIndexedAlbum('album-2').preview_only, false, 'a cache hit should refresh LRU order');
    assert.equal(context.getIndexedAlbum('album-3').preview_only, true, 'the next-oldest album should be evicted');
    assert.equal(context.fetchCalls.length, 12, 'hydrated cache hits should not refetch');
  }

  {
    const preview = {
      key: 'gallery-alpha',
      request_key: 'request-alpha',
      identity_key: 'identity-alpha',
      name: 'Album Alpha',
      preview_only: true,
      tracks: [],
    };
    const { context } = loadHelper({
      initialAlbums: [preview],
      onFetchAlbumDetails() {
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            album: {
              ...preview,
              preview_only: false,
              tracks: [{ path: 'C:\\Music\\alpha\\01 Track.flac' }],
            },
          }),
        };
      },
    });
    context.state.gallery.albumIndex.set('request-alpha', preview);
    context.state.gallery.albumIndex.set('identity-alpha', preview);

    const prewarm = context.loadTrackModalAlbumDetails('request-alpha');
    const sharedUserLoad = context.loadTrackModalAlbumDetails('identity-alpha');
    assert.equal(sharedUserLoad, prewarm, 'request and identity aliases should share an in-flight load');
    await prewarm;

    const cachedAliasLoad = await context.loadTrackModalAlbumDetails('identity-alpha');
    assert.equal(cachedAliasLoad.preview_only, false);
    assert.equal(context.fetchCalls.length, 1, 'all hydrated aliases should resolve from one cached album');
  }

  {
    const suffixAlias = 'ddt::studio-records4::fixture-edition';
    const staleHydratedSuffix = {
      key: suffixAlias,
      request_key: suffixAlias,
      identity_key: suffixAlias,
      name: 'Studio Records4',
      album_artist: 'DDT',
      year: 1999,
      edition: 'Fixture Edition',
      preview_only: false,
      tracks: Array.from({ length: 13 }, (_value, index) => ({
        path: `C:\\Music\\DDT\\Studio Records\\${String(index + 4).padStart(2, '0')}.mp3`,
      })),
    };
    const compactSuffix = {
      key: suffixAlias,
      request_key: suffixAlias,
      identity_key: suffixAlias,
      name: 'Studio Records4',
      album_artist: 'DDT',
      year: 1999,
      edition: 'Fixture Edition',
      preview_only: true,
      track_count_preview: 1,
      tracks: [],
    };
    const hydratedSuffix = {
      ...compactSuffix,
      preview_only: false,
      tracks: [{
        path: 'C:\\Music\\DDT\\Studio Records\\03.mp3',
      }],
    };
    const { context } = loadHelper({
      initialAlbums: [compactSuffix],
      fetchedAlbum: hydratedSuffix,
    });

    context.cacheHydratedTrackModalAlbum(suffixAlias, staleHydratedSuffix);
    context.state.gallery.albumIndex.set(suffixAlias, compactSuffix);
    context.state.modalReleases = [];
    context.state.modalReleaseIndex = 0;

    const resolvedSuffix = await context.loadTrackModalAlbumDetails(suffixAlias);

    assert.strictEqual(
      resolvedSuffix,
      hydratedSuffix,
      'a live compact suffix identity must reject stale hydrated membership cached under its alias',
    );
    assert.equal(
      context.fetchCalls.length,
      1,
      'the stale alias must be rehydrated from the suffix identity instead of opening the source cache',
    );
  }

  {
    const sourceAlias = 'ddt::studio-records';
    const staleHydratedSource = {
      key: sourceAlias,
      request_key: sourceAlias,
      identity_key: sourceAlias,
      name: 'Studio Records',
      album_artist: 'DDT',
      year: 1999,
      preview_only: false,
      tracks: Array.from({ length: 16 }, (_value, index) => ({
        path: `C:\\Music\\DDT\\Studio Records\\${String(index + 1).padStart(2, '0')}.mp3`,
        is_problematic: index < 4,
      })),
    };
    const compactSourceAfterSplit = {
      key: sourceAlias,
      request_key: sourceAlias,
      identity_key: sourceAlias,
      name: 'Studio Records',
      album_artist: 'DDT',
      year: 1999,
      preview_only: true,
      track_count_preview: 15,
      tracks: [],
    };
    const authoritativeSourceAfterSplit = {
      ...compactSourceAfterSplit,
      preview_only: false,
      tracks: staleHydratedSource.tracks.slice(1).map((track) => ({
        ...track,
        is_problematic: true,
      })),
    };
    const { context } = loadHelper({
      initialAlbums: [compactSourceAfterSplit],
      fetchedAlbum: authoritativeSourceAfterSplit,
    });

    context.cacheHydratedTrackModalAlbum(sourceAlias, staleHydratedSource, {
      aliases: [sourceAlias],
    });
    context.state.gallery.albumIndex.set(sourceAlias, compactSourceAfterSplit);

    context.invalidateHydratedTrackModalAlbumDetails([staleHydratedSource]);

    assert.strictEqual(
      context.state.gallery.albumIndex.get(sourceAlias),
      compactSourceAfterSplit,
      'invalidation must restore the live compact projection instead of leaving stale hydrated rows indexed',
    );
    const resolvedSource = await context.loadTrackModalAlbumDetails(sourceAlias);
    assert.strictEqual(resolvedSource, authoritativeSourceAfterSplit);
    assert.equal(context.fetchCalls.length, 1);
    assert.equal(
      resolvedSource.tracks.every((track) => track.is_problematic === true),
      true,
      'reopening a structurally edited source must use authoritative problem annotations',
    );
  }

  {
    const removedPath = 'D:\\Synthetic Music\\Rarity Artist\\Two Tracks\\01 Apply Rarity.mp3';
    const siblingPath = 'D:\\Synthetic Music\\Rarity Artist\\Two Tracks\\02 Remain Editable.mp3';
    const staleAlbum = {
      key: 'rarity-album-before-save',
      request_key: 'request-before-save',
      identity_key: 'identity-before-save',
      name: 'Two Tracks',
      tracks: [
        { path: removedPath, title: 'Apply Rarity' },
        { path: siblingPath, title: 'Remain Editable' },
      ],
    };
    const currentStaleAlbum = {
      ...staleAlbum,
      key: 'rarity-album-current-modal',
      request_key: 'request-current-modal',
      identity_key: 'identity-current-modal',
    };
    const canonicalAlbum = {
      ...staleAlbum,
      key: 'rarity-album-after-save',
      request_key: 'request-after-save',
      identity_key: 'identity-after-save',
      tracks: [{ path: siblingPath, title: 'Remain Editable' }],
    };
    const { context } = loadHelper({ initialAlbums: [staleAlbum] });
    context.cacheHydratedTrackModalAlbum('request-before-save', staleAlbum);
    context.cacheHydratedTrackModalAlbum('request-current-modal', currentStaleAlbum);

    context.cacheHydratedTrackModalAlbum('request-after-save', canonicalAlbum, {
      aliases: [
        'request-before-save',
        'identity-before-save',
        'request-current-modal',
        'identity-current-modal',
      ],
    });

    for (const alias of [
      'request-before-save',
      'identity-before-save',
      'request-current-modal',
      'identity-current-modal',
      'request-after-save',
      'identity-after-save',
    ]) {
      assert.strictEqual(
        context.getCachedHydratedTrackModalAlbum(alias),
        canonicalAlbum,
        `${alias} should resolve the remaining-track album`,
      );
    }

    context.state.modalReleases = [canonicalAlbum];
    context.state.modalReleaseIndex = 0;
    const reopenEditButton = new context.HTMLElement('reopen-edit');
    reopenEditButton.setAttribute('data-album-key', 'request-before-save');
    const reopenedAlbum = context.resolveTrackModalActionAlbum(reopenEditButton);

    assert.strictEqual(reopenedAlbum, canonicalAlbum);
    assert.deepEqual(
      Array.from(reopenedAlbum.tracks, (track) => track.title),
      ['Remain Editable'],
    );
  }

  {
    const sharedRequestKey = 'rarity artist::sparse year edit fixture::fixture edition';
    const retainedSourceAlbum = {
      key: sharedRequestKey,
      name: 'Sparse Year Edit Fixture',
      album_artist: 'Rarity Artist',
      year: '2004',
      edition: 'Fixture Edition',
      tracks: Array.from({ length: 17 }, (_, index) => ({
        path: `D:\\Synthetic Music\\Rarity Artist\\Sparse Year Edit Fixture\\${index + 1}.mp3`,
      })),
    };
    const movedDestinationAlbum = {
      key: sharedRequestKey,
      name: 'Sparse Year Edit Fixture',
      album_artist: 'Rarity Artist',
      year: '2014',
      edition: 'Fixture Edition',
      tracks: [{
        path: 'D:\\Synthetic Music\\Rarity Artist\\Sparse Year Edit Fixture\\Moved.mp3',
      }],
    };
    const { context } = loadHelper({ initialAlbums: [movedDestinationAlbum] });
    context.cacheHydratedTrackModalAlbum(sharedRequestKey, movedDestinationAlbum);
    context.cacheHydratedTrackModalAlbum(sharedRequestKey, retainedSourceAlbum);
    context.state.modalReleases = [];
    context.state.modalReleaseIndex = 0;

    const sourceButton = new context.HTMLElement('source-year-card');
    sourceButton.setAttribute('data-album-key', sharedRequestKey);
    sourceButton.setAttribute(
      'data-album-version-key',
      context.getTrackModalAlbumVersionKey(retainedSourceAlbum),
    );
    const destinationButton = new context.HTMLElement('destination-year-card');
    destinationButton.setAttribute('data-album-key', sharedRequestKey);
    destinationButton.setAttribute(
      'data-album-version-key',
      context.getTrackModalAlbumVersionKey(movedDestinationAlbum),
    );

    assert.strictEqual(
      context.resolveTrackModalActionAlbum(sourceButton),
      retainedSourceAlbum,
      'the retained source card must resolve by its year-specific identity',
    );
    assert.strictEqual(
      context.resolveTrackModalActionAlbum(destinationButton),
      movedDestinationAlbum,
      'the moved destination card must resolve independently of shared-key insertion order',
    );
  }

  {
    const compactYearSplitAlbum = {
      key: 'rarity artist::sparse year edit fixture::fixture edition::year::2014',
      name: 'Sparse Year Edit Fixture',
      album_artist: 'Rarity Artist',
      year: '2014',
      edition: '',
      preview_only: true,
      track_count_preview: 1,
    };
    const { context } = loadHelper();
    context.state.gallery.albumIndex.clear();
    context.state.modalReleases = [];
    const newlyRenderedButton = new context.HTMLElement('new-year-card');
    newlyRenderedButton.setAttribute('data-album-key', compactYearSplitAlbum.key);
    newlyRenderedButton.setAttribute(
      'data-album-version-key',
      context.getTrackModalAlbumVersionKey(compactYearSplitAlbum),
    );
    newlyRenderedButton.setAttribute('data-album', JSON.stringify(compactYearSplitAlbum));

    const resolvedCompactAlbum = context.resolveTrackModalActionAlbum(newlyRenderedButton);
    assert.equal(resolvedCompactAlbum?.key, compactYearSplitAlbum.key);
    assert.equal(resolvedCompactAlbum?.year, compactYearSplitAlbum.year);
    assert.equal(resolvedCompactAlbum?.track_count_preview, 1);
  }

  test('openTrackModalForButton must not bypass the current-album identity resolver', () => {
    const originalTrackPath = 'D:\\Synthetic Music\\Rarity Artist\\Original\\01 Stay.mp3';
    const movedTrackPath = 'D:\\Synthetic Music\\Rarity Artist\\Destination\\02 Move.mp3';
    const liveOriginalAlbum = {
      key: 'live-original',
      request_key: 'request-before-save',
      identity_key: 'identity-before-save',
      name: 'Original',
      album_artist: 'Rarity Artist',
      tracks: [{ path: originalTrackPath, title: 'Stay' }],
    };
    const movedTrackDestination = {
      key: 'request-before-save',
      request_key: 'request-after-save',
      identity_key: 'identity-after-save',
      name: 'Destination',
      album_artist: 'Rarity Artist',
      tracks: [{ path: movedTrackPath, title: 'Move' }],
    };
    const { context } = loadHelper({ initialAlbums: [movedTrackDestination] });
    context.state.modalReleases = [liveOriginalAlbum];
    context.state.modalReleaseIndex = 0;

    const originalCardButton = new context.HTMLElement('original-card');
    originalCardButton.setAttribute('data-album-key', 'request-before-save');
    assert.strictEqual(
      context.resolveTrackModalActionAlbum(originalCardButton),
      liveOriginalAlbum,
      'the production action resolver already preserves the current remaining source album',
    );

    assert.equal(context.openTrackModalForButton(originalCardButton), true);
    assert.strictEqual(
      context.renderTrackModalReleaseAlbums.at(-1),
      liveOriginalAlbum,
      'the real card-open path must keep the original modal identity during optimistic alias churn',
    );
  });

  {
    const expectedSequentialOpenMs = 150;
    const albumsByKey = new Map([
      ['alpha', 'Album Alpha'],
      ['beta', 'Album Beta'],
    ]);
    const { context } = loadHelper({
      initialAlbums: [
        { key: 'alpha', name: 'Album Alpha', preview_only: true, tracks: [] },
        { key: 'beta', name: 'Album Beta', preview_only: true, tracks: [] },
      ],
      onFetchAlbumDetails({ indexedAlbums, url }) {
        const albumKey = new URL(`http://localhost${url}`).searchParams.get('album_key');
        const album = {
          key: albumKey,
          name: albumsByKey.get(albumKey),
          tracks: [{ path: `C:\\Music\\${albumKey}\\01 Track.flac` }],
        };
        indexedAlbums.set(albumKey, album);
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true, album }),
        };
      },
    });
    const elapsedMs = [];

    for (let index = 0; index < 12; index += 1) {
      const albumKey = index % 2 === 0 ? 'alpha' : 'beta';
      const startedAt = process.hrtime.bigint();
      context.openTrackModal({
        key: albumKey,
        name: albumsByKey.get(albumKey),
        preview_only: true,
        tracks: [],
      });
      await flushAlbumDetailsHydration();
      elapsedMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      context.closeTrackModal();
    }

    assert.equal(context.fetchCalls.length, 2);
    assert.equal((context.getIndexedAlbum('alpha')?.tracks || []).length, 1);
    assert.equal((context.getIndexedAlbum('beta')?.tracks || []).length, 1);
    assert.ok(
      Math.max(...elapsedMs) < expectedSequentialOpenMs,
      `expected repeated album-detail opens under ${expectedSequentialOpenMs}ms, got ${elapsedMs.map((value) => value.toFixed(2)).join(', ')}`,
    );
  }

  {
    const { context, lightboxOverlay, lightboxImage } = loadHelper();
    const activePreloader = { onload() {}, onerror() {} };
    context.state.lightbox.activePreloader = activePreloader;
    context.state.lightbox.loadToken = 3;
    context.openImageLightbox('/cover.png', 'Cover art', {
      sourceAlbumKey: 'alpha',
      items: [{ key: 'alpha', src: '/cover.png', alt: 'Cover art' }],
    });

    assert.equal(lightboxOverlay.hidden, false);
    assert.deepEqual(context.showLightboxItemCalls, [0]);
    assert.equal(context.document.body.classList.contains('modal-open'), true);

    context.closeImageLightbox();
    assert.equal(lightboxOverlay.hidden, true);
    assert.equal(lightboxImage.src, '');
    assert.equal(lightboxImage.alt, '');
    assert.equal(lightboxImage.hidden, true);
    assert.equal(lightboxImage.getAttribute('aria-hidden'), 'true');
    assert.equal(context.stopLightboxDragCalls, 1);
    assert.equal(context.state.lightbox.items.length, 0);
    assert.equal(context.state.lightbox.activePreloader, null);
    assert.equal(activePreloader.onload, null);
    assert.equal(activePreloader.onerror, null);
    assert.equal(context.state.lightbox.loadToken, 4);
    assert.equal(context.document.body.classList.contains('modal-open'), false);
  }

  {
    let resumedDeferredLoads = 0;
    const { context, trackModal } = loadHelper({
      virtualGrid: {
        scheduleDeferredGalleryCoverLoads() {
          resumedDeferredLoads += 1;
        },
      },
    });
    trackModal.hidden = false;
    context.closeTrackModal();
    assert.equal(resumedDeferredLoads, 0, 'cover scheduling must continue independently of modal close hooks');
  }

  {
    const { context, trackModal, openButton, documentListeners } = loadHelper({ utilityLoaded: true, overlayClickCloses: true });
    context.attachTrackButtons();
    context.attachModalEvents();

    trackModal.hidden = false;
    context.document.body.classList.add('modal-open');
    openButton.click();
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);

    const keydownHandlers = documentListeners.get('keydown') || [];
    keydownHandlers[0]({ key: 'Escape' });
    assert.equal(trackModal.hidden, true);
    assert.equal(context.state.modalReleases.length, 0);
    assert.equal(context.document.body.classList.contains('modal-open'), false);

    const lightboxKeydown = keydownHandlers[1];
    context.getLightboxElements().overlay.hidden = false;
    lightboxKeydown({
      key: 'ArrowRight',
      preventDefault() {},
    });
    assert.deepEqual(context.stepLightboxCalls, [1]);
  }

  {
    const { context, utilityModal, documentListeners } = loadHelper({ utilityLoaded: true });
    let activeEdit = true;
    let prevented = 0;
    context.cancelActiveSavedLoopCreation = () => {
      if (!activeEdit) return false;
      activeEdit = false;
      return true;
    };
    context.attachModalEvents();
    utilityModal.hidden = false;
    const keydown = (documentListeners.get('keydown') || [])[0];

    keydown({
      key: 'Escape',
      defaultPrevented: false,
      preventDefault() { prevented += 1; },
    });
    assert.equal(prevented, 1);
    assert.equal(context.closeUtilityModalCalls, 0, 'first Escape cancels only the active saved-loop edit');

    keydown({
      key: 'Escape',
      defaultPrevented: false,
      preventDefault() { prevented += 1; },
    });
    assert.equal(context.closeUtilityModalCalls, 1, 'the next Escape closes Settings after editing is inactive');

    keydown({
      key: 'Escape',
      defaultPrevented: true,
      preventDefault() { prevented += 1; },
    });
    assert.equal(context.closeUtilityModalCalls, 1, 'an already-consumed Escape never closes Settings');
  }

  {
    const { context } = loadHelper({ utilityLoaded: true });
    const button = new FakeHtmlElement('delegated-open-button');
    button.dataset.albumKey = 'alpha';
    button.getAttribute = (name) => (name === 'data-album-key' ? 'alpha' : '');
    const opened = context.openTrackModalForButton(button);

    assert.equal(opened, true);
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
  }

  {
    const fullAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      album_artist: 'Artist Alpha',
      tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac', title: 'Track 1' }],
    };
    const { context } = loadHelper({
      initialAlbums: [fullAlbum],
      onFetchAlbumDetails() {
        throw new Error('indexed selected-artist albums should not refetch album details');
      },
    });
    const button = new FakeHtmlElement('selected-artist-open-button');
    button.dataset.albumKey = 'alpha';
    button.getAttribute = (name) => (name === 'data-album-key' ? 'alpha' : '');
    context.state.view.selected_artist = 'Artist Alpha';

    const opened = context.openTrackModalForButton(button);
    await flushMicrotasks();

    assert.equal(opened, true);
    assert.deepEqual(context.renderTrackModalReleaseCalls, ['alpha']);
    assert.deepEqual(context.fetchCalls, []);
  }

  {
    const duplicateAlbum = {
      key: 'alpha',
      name: 'Album Alpha',
      tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac' }],
      duplicate_sources: [
        { tracks: [{ path: 'C:\\Music\\Album Alpha\\01 Track.flac' }] },
        { tracks: [{ path: 'D:\\Mirror\\Album Alpha\\01 Track.flac' }] },
      ],
    };
    const { context } = loadHelper({
      initialAlbums: [duplicateAlbum],
    });
    context.state.modalReleases = [duplicateAlbum];
    const button = new FakeHtmlElement('duplicate-folder-button');
    button.getAttribute = (name) => {
      if (name === 'data-album-key') return 'alpha';
      if (name === 'data-duplicate-source-index') return '1';
      return '';
    };

    const resolvedAlbum = context.resolveTrackModalDuplicateSourceAlbum(button);

    assert.equal(resolvedAlbum.key, 'alpha');
    assert.deepEqual(
      resolvedAlbum.tracks.map((track) => track.path),
      ['D:\\Mirror\\Album Alpha\\01 Track.flac'],
    );
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
