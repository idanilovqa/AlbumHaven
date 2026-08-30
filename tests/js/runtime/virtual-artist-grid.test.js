const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'virtual-artist-grid.js');
const helperSource = fs.readFileSync(helperPath, 'utf8');
const schedulerPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'gallery-cover-load-scheduler.js');
const schedulerSource = fs.readFileSync(schedulerPath, 'utf8');
const galleryCssPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css');
const galleryCssSource = fs.readFileSync(galleryCssPath, 'utf8');

function createRuntimeContext() {
  class FakeElement {}
  class FakeImageElement extends FakeElement {
    constructor() {
      super();
      this.isConnected = true;
      this.loading = 'eager';
      this.attributes = {
        src: '/cover?path=old',
        srcset: '/cover?path=old 1x',
        loading: 'eager',
        fetchpriority: 'high',
      };
    }

    removeAttribute(name) {
      delete this.attributes[name];
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }

    getAttribute(name) {
      return this.attributes[name] || '';
    }
  }

  class FakeDeferredCoverPlaceholder extends FakeElement {
    constructor(index) {
      super();
      this.attributes = {
        'data-deferred-cover-src': `/covers/deferred-${index}`,
        'data-deferred-cover-alt': `Deferred cover ${index}`,
        'data-cover-path': `covers/deferred-${index}.jpg`,
        'data-remote-cover-url': '',
      };
      this.replacement = null;
    }

    getAttribute(name) {
      return this.attributes[name] || '';
    }

    replaceWith(element) {
      this.replacement = element;
    }
  }

  class FakeAlbumTitleButton extends FakeElement {
    constructor(albumKey, rect, sectionOccurrenceKey = '', albumName = '', albumYear = '') {
      super();
      this.albumKey = albumKey;
      this.rect = rect;
      this.sectionOccurrenceKey = sectionOccurrenceKey;
      this.albumName = albumName;
      this.albumYear = albumYear;
    }

    getAttribute(name) {
      if (name === 'data-album-key') return this.albumKey;
      if (name === 'data-album') return JSON.stringify({ name: this.albumName, year: this.albumYear });
      return '';
    }

    getBoundingClientRect() {
      return this.rect;
    }

    closest(selector) {
      if (selector !== '[data-virtual-section-key]' || !this.sectionOccurrenceKey) return null;
      return {
        dataset: { virtualSectionKey: this.sectionOccurrenceKey },
        getAttribute(name) {
          return name === 'data-virtual-section-key' ? this.dataset.virtualSectionKey : '';
        },
      };
    }
  }

  class FakeRenderedNode {
    constructor(tagName, html = '', attributes = {}) {
      this.tagName = tagName;
      this.innerHTML = html;
      this.parentNode = null;
      this.__images = [];
      this.__attributes = new Map(Object.entries(attributes));
      this.childNodes = [{ serializedHtml: html }];
      this.dataset = {};
      Object.defineProperty(this.dataset, 'virtualSectionKey', {
        configurable: true,
        get: () => this.__attributes.get('data-virtual-section-key') || '',
        set: (value) => {
          this.__attributes.set('data-virtual-section-key', String(value || ''));
        },
      });
      const virtualSectionKey = this.__attributes.get('data-virtual-section-key');
      if (virtualSectionKey) this.dataset.virtualSectionKey = virtualSectionKey;
    }

    get attributes() {
      return Array.from(this.__attributes, ([name, value]) => ({ name, value }));
    }

    remove() {
      if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
        this.parentNode.removeChild(this);
      }
    }

    getAttribute(name) {
      if (name === 'data-virtual-section-key') return this.dataset.virtualSectionKey || '';
      return this.__attributes.get(name) || '';
    }

    setAttribute(name, value) {
      const normalizedValue = String(value || '');
      this.__attributes.set(name, normalizedValue);
    }

    removeAttribute(name) {
      this.__attributes.delete(name);
    }

    replaceChildren(...nodes) {
      this.childNodes = nodes;
      this.innerHTML = nodes.map((node) => String(node?.serializedHtml || '')).join('');
    }

    isEqualNode(other) {
      return Boolean(
        other
        && this.tagName === other.tagName
        && this.innerHTML === other.innerHTML
      );
    }

    querySelectorAll(selector) {
      if (selector === '.cover img') return this.__images;
      return [];
    }
  }

  class FakeScratchElement {
    constructor() {
      this._innerHTML = '';
      this.firstElementChild = null;
    }

    set innerHTML(value) {
      this._innerHTML = String(value || '');
      const normalized = this._innerHTML.trim();
      if (!normalized) {
        this.firstElementChild = null;
        return;
      }
      const outerMatch = normalized.match(/^<([a-z0-9-]+)([^>]*)>([\s\S]*)<\/\1>$/i);
      const tagName = outerMatch?.[1]?.toLowerCase() || 'div';
      const attributeText = outerMatch?.[2] || '';
      const innerHtml = outerMatch?.[3] || '';
      const attributes = {};
      Array.from(attributeText.matchAll(/([a-z0-9-]+)="([^"]*)"/gi)).forEach((match) => {
        attributes[match[1]] = match[2];
      });
      this.firstElementChild = new FakeRenderedNode(tagName, innerHtml, attributes);
    }

    get innerHTML() {
      return this._innerHTML;
    }
  }

  const scrollListeners = new Map();
  const scrollEl = {
    clientWidth: 980,
    clientHeight: 640,
    scrollTop: 0,
    scrollLeft: 0,
    getBoundingClientRect() {
      return { top: 0, right: 980, bottom: 640, left: 0, width: 980, height: 640 };
    },
    addEventListener(type, listener) {
      const listeners = scrollListeners.get(type) || [];
      listeners.push(listener);
      scrollListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      const listeners = scrollListeners.get(type) || [];
      scrollListeners.set(type, listeners.filter((candidate) => candidate !== listener));
    },
    dispatchEvent(event) {
      const listeners = scrollListeners.get(event?.type) || [];
      listeners.forEach((listener) => listener.call(this, event));
      return true;
    },
  };
  const containerEl = {
    innerHTML: '',
    children: [],
    syncInnerHtml() {
      this.innerHTML = this.children.map((child) => child.innerHTML || '').join('');
    },
    querySelectorAll(selector) {
      if (selector === '[data-deferred-cover-src]') {
        return context.__deferredCoverPlaceholders.filter((placeholder) => !placeholder.replacement);
      }
      if (
        selector === '.album-title-button[data-open-tracklist="1"][data-album-key]'
        || selector === '[data-open-tracklist="1"][data-album-key]'
      ) {
        return context.__albumTitleButtons;
      }
      if (selector === '.cover img') {
        return Array.isArray(context.__rows) ? context.__rows : [];
      }
      if (selector === '.album-row[data-section-key][data-block-index]') {
        context.__rowSelectorQueryCount += 1;
        return context.__rowSelectorQueryCount % 2 === 0 && Array.isArray(context.__rows)
          ? context.__rows
          : [];
      }
      return [];
    },
    querySelector(selector) {
      if (selector === '[data-deferred-cover-src]') {
        return context.__deferredCoverPlaceholders.find((placeholder) => !placeholder.replacement) || null;
      }
      if (selector === '.cover img[data-gallery-cover-priority="visible"][data-cover-visual-state="ready"]') {
        return context.__firstReadyCover || null;
      }
      return null;
    },
    appendChild(child) {
      const existingIndex = this.children.indexOf(child);
      if (existingIndex >= 0) {
        this.children.splice(existingIndex, 1);
      }
      child.parentNode = this;
      this.children.push(child);
      this.syncInnerHtml();
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
        child.parentNode = null;
      }
      this.syncInnerHtml();
      return child;
    },
  };
  Object.setPrototypeOf(containerEl, FakeElement.prototype);
  const topSpacerEl = { style: { height: '' } };
  const bottomSpacerEl = { style: { height: '' } };
  const elementsById = {
    'albums-scroll': scrollEl,
    'artist-groups': containerEl,
    'albums-spacer-top': topSpacerEl,
    'albums-spacer-bottom': bottomSpacerEl,
  };

  const documentListeners = new Map();
  const context = {
    Map,
    Math,
    HTMLElement: FakeElement,
    HTMLImageElement: FakeImageElement,
    state: {
      view: {
        artist_groups: [],
        primary_artist_groups: [],
        family_artist_groups: [],
      },
      gallery: {
        albumIndex: new Map(),
      },
    },
    document: {
      body: {
        classList: {
          contains(className) {
            return className === 'modal-open' && context.__modalOpen;
          },
        },
      },
      getElementById(id) {
        return elementsById[id] || null;
      },
      createElement(tagName) {
        if (String(tagName || '').toLowerCase() === 'img') return new FakeImageElement();
        return new FakeScratchElement();
      },
      querySelectorAll() {
        return [];
      },
      addEventListener(type, listener) {
        const listeners = documentListeners.get(type) || [];
        listeners.push(listener);
        documentListeners.set(type, listeners);
      },
      removeEventListener(type, listener) {
        const listeners = documentListeners.get(type) || [];
        documentListeners.set(type, listeners.filter((candidate) => candidate !== listener));
      },
      dispatchEvent(event) {
        const listeners = documentListeners.get(event?.type) || [];
        listeners.forEach((listener) => listener.call(this, event));
        return true;
      },
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
    },
    __nextTimeoutId: 0,
    __scheduledBrowserTimeouts: [],
    __deferredCoverPlaceholders: [],
    __albumTitleButtons: [],
    __firstReadyCover: null,
    __rowSelectorQueryCount: 0,
    __modalOpen: false,
    __documentListeners: documentListeners,
    clearedBrowserTimeouts: [],
    canceledBrowserAnimationFrames: [],
    scheduleBrowserAnimationFrame(callback) {
      return callback ? 1 : 0;
    },
    cancelBrowserAnimationFrame(frameId) {
      context.canceledBrowserAnimationFrames.push(frameId);
    },
    scheduleBrowserTimeout(callback, delay) {
      context.__nextTimeoutId += 1;
      context.__scheduledBrowserTimeouts.push({
        id: context.__nextTimeoutId,
        callback,
        delay,
      });
      return context.__nextTimeoutId;
    },
    clearBrowserTimeout(timeoutId) {
      context.clearedBrowserTimeouts.push(timeoutId);
    },
    escapeHtml(value) {
      return String(value ?? '');
    },
    renderStars(rating) {
      const filledCount = Number.isInteger(rating) && rating >= 1 && rating <= 10
        ? rating
        : 0;
      return Array.from({ length: 10 }, (_value, index) => (
        `<span class="star${index < filledCount ? ' filled' : ''}">`
        + `${index < filledCount ? '&#9733;' : '&#9734;'}</span>`
      )).join('');
    },
    formatAlbumDuration(seconds) {
      return `${Number(seconds || 0)}s`;
    },
    buildAlbumDisplayCoverUrl(album) {
      return `/covers/${encodeURIComponent(String(album?.name || ''))}`;
    },
    albumHasDisplayCover(album) {
      return Boolean(album?.hasCover);
    },
    buildDisplayGroups(groups) {
      return Array.isArray(groups) ? groups : [];
    },
    getAlbumPathSignature(album) {
      return String(album?.pathSignature || '');
    },
    groupAlbumTracks(tracks) {
      return {
        groups: [
          { tracks: tracks.slice(0, 2) },
          { isBonus: true, tracks: tracks.slice(2) },
        ],
      };
    },
    queuedTrackModalAlbumDetailPrewarms: [],
    queuedVisibleTrackModalAlbumDetailPrewarms: 0,
    galleryCoverSchedulerEnqueues: [],
    galleryCoverSchedulerGeneration: 0,
    galleryCoverFamilyPrefetchEnsures: 0,
    galleryCoverFamilyPrefetchReconciliations: [],
    galleryCoverSchedulerSuspends: [],
    galleryCoverSchedulerResumes: 0,
    galleryCoverSchedulerPromotions: [],
    galleryCoverLoadScheduler: {
      diagnostics: {
        active: 0,
        activeBackground: 0,
        queuedVisible: 0,
        queuedNear: 0,
      },
      startGeneration() {
        context.galleryCoverSchedulerGeneration += 1;
        return context.galleryCoverSchedulerGeneration;
      },
      ensureFamilyPrefetchReconciliation() {
        context.galleryCoverFamilyPrefetchEnsures += 1;
        return context.galleryCoverFamilyPrefetchEnsures;
      },
      reconcileFamilyPrefetch(productionUrls, options) {
        context.galleryCoverFamilyPrefetchReconciliations.push({
          productionUrls: [...productionUrls],
          ...options,
        });
        return Promise.resolve({ cancelled: false });
      },
      suspend(reason) {
        context.galleryCoverSchedulerSuspends.push(reason);
        return [];
      },
      resume() {
        context.galleryCoverSchedulerResumes += 1;
      },
      pruneObsoleteConsumerTasks() {},
      promote(productionUrl, priority) {
        context.galleryCoverSchedulerPromotions.push({ productionUrl, priority });
        return true;
      },
      isForegroundIdle() {
        const diagnostics = context.galleryCoverLoadScheduler.diagnostics;
        return Number(diagnostics.queuedVisible || 0) === 0
          && Number(diagnostics.queuedNear || 0) === 0
          && Number(diagnostics.active || 0) - Number(diagnostics.activeBackground || 0) === 0;
      },
      enqueue(productionUrl, options) {
        context.galleryCoverSchedulerEnqueues.push({ productionUrl, ...options });
        return Promise.resolve({ cached: true, productionUrl });
      },
    },
    queueTrackModalAlbumDetailsPrewarm(albumKey) {
      context.queuedTrackModalAlbumDetailPrewarms.push(albumKey);
    },
    queueVisibleTrackModalAlbumDetailsPrewarm() {
      context.queuedVisibleTrackModalAlbumDetailPrewarms += 1;
    },
  };

  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.createDeferredCoverPlaceholders = (count) => {
    context.__deferredCoverPlaceholders = Array.from(
      { length: count },
      (_value, index) => new FakeDeferredCoverPlaceholder(index),
    );
    return context.__deferredCoverPlaceholders;
  };
  context.createAlbumTitleButton = (
    albumKey,
    rect,
    sectionOccurrenceKey = '',
    albumName = '',
    albumYear = '',
  ) => (
    new FakeAlbumTitleButton(albumKey, rect, sectionOccurrenceKey, albumName, albumYear)
  );
  return { context, scrollEl, containerEl, topSpacerEl, bottomSpacerEl };
}

test('visible cover priming promotes scheduler work discovered after transient layout', () => {
  const { context, scrollEl } = createRuntimeContext();
  Object.setPrototypeOf(scrollEl, context.HTMLElement.prototype);
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const images = Array.from({ length: 5 }, (_value, index) => {
    const image = new context.HTMLImageElement();
    image.setAttribute('data-production-cover-src', `/cover?path=visible-after-layout-${index}`);
    image.setAttribute('data-gallery-cover-priority', 'near');
    image.setAttribute('fetchpriority', 'low');
    image.getBoundingClientRect = () => ({ top: 20, bottom: 260, width: 240, height: 240 });
    return image;
  });
  context.__rows = images;

  virtualGrid.primeVisibleCoverImages();

  assert.equal(images.every((image) => image.getAttribute('data-gallery-cover-priority') === 'visible'), true);
  assert.deepEqual(context.galleryCoverSchedulerPromotions, images.map((_image, index) => ({
    productionUrl: `/cover?path=visible-after-layout-${index}`,
    priority: 'visible',
  })));
  assert.equal(images.slice(0, 4).every((image) => image.getAttribute('fetchpriority') === 'high'), true);
  assert.equal(images[4].getAttribute('fetchpriority'), 'low');
});

function createMeasuredRow(sectionKey, blockIndex, options = {}) {
  let rowMeasureCalls = 0;
  let cardMeasureCalls = 0;
  const cardHeights = Array.isArray(options.cardHeights) ? options.cardHeights : [];
  return {
    getAttribute(name) {
      if (name === 'data-section-key') return sectionKey;
      if (name === 'data-block-index') return String(blockIndex);
      return '';
    },
    querySelectorAll(selector) {
      if (selector !== '.album-card') return [];
      return cardHeights.map((height) => ({
        getBoundingClientRect() {
          cardMeasureCalls += 1;
          return { height };
        },
      }));
    },
    getBoundingClientRect() {
      rowMeasureCalls += 1;
      return { height: options.rowHeight || 0 };
    },
    get rowMeasureCalls() {
      return rowMeasureCalls;
    },
    get cardMeasureCalls() {
      return cardMeasureCalls;
    },
  };
}

test('render adopts same-cover in-flight work before pruning removed cover consumers', async () => {
  const { context, containerEl } = createRuntimeContext();
  const releaseWaiters = [];
  let released = false;
  const requestTokens = new WeakMap();
  context.AbortController = AbortController;
  context.galleryCoverPreviewCache = {
    normalizeProductionUrl(value) { return String(value || '').trim(); },
    recordInFlightPreemption() {},
    async resolve(productionUrl) {
      if (!released) {
        await new Promise((resolve) => { releaseWaiters.push(resolve); });
      }
      return { cached: true, displayUrl: `blob:${productionUrl}`, productionUrl };
    },
    async prefetch(productionUrl) {
      return { cached: true, productionUrl };
    },
  };
  context.beginGalleryCoverImageRequest = (image, productionUrl) => {
    const requestToken = Symbol(productionUrl);
    requestTokens.set(image, requestToken);
    image.setAttribute('data-production-cover-src', productionUrl);
    return { image, productionUrl, requestToken };
  };
  context.commitGalleryCoverImageRequest = (request, result) => {
    if (requestTokens.get(request.image) !== request.requestToken) return false;
    request.image.setAttribute('src', result.displayUrl);
    return true;
  };
  context.restoreGalleryCoverImageRequest = (request) => {
    if (requestTokens.get(request.image) !== request.requestToken) return null;
    request.image.setAttribute('data-gallery-cover-src', request.productionUrl);
    request.image.removeAttribute('data-gallery-cover-loading');
    return request.image;
  };
  vm.runInContext(schedulerSource, context, { filename: schedulerPath });
  const scheduler = vm.runInContext('galleryCoverLoadScheduler', context);
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const sameCoverUrl = '/cover?path=retained';
  const removedCoverUrl = '/cover?path=removed';
  const oldSameCoverImage = new context.HTMLImageElement();
  const oldRemovedCoverImage = new context.HTMLImageElement();
  const generationOne = scheduler.startGeneration();
  const sameCoverPromise = scheduler.enqueue(sameCoverUrl, {
    generation: generationOne,
    image: oldSameCoverImage,
    priority: 'visible',
  });
  const removedCoverPromise = scheduler.enqueue(removedCoverUrl, {
    generation: generationOne,
    image: oldRemovedCoverImage,
    priority: 'visible',
  });
  const sameCoverTask = scheduler.tasks.get(sameCoverUrl);
  const removedCoverTask = scheduler.tasks.get(removedCoverUrl);
  assert.equal(sameCoverTask.started, true);
  assert.equal(removedCoverTask.started, true);

  const generationTwo = scheduler.startGeneration();
  virtualGrid._coverLoadGeneration = generationTwo;
  const nextSameCoverImage = new context.HTMLImageElement();
  nextSameCoverImage.setAttribute('data-gallery-cover-src', sameCoverUrl);
  nextSameCoverImage.removeAttribute('data-gallery-cover-loading');
  const originalQuerySelectorAll = containerEl.querySelectorAll.bind(containerEl);
  containerEl.querySelectorAll = (selector) => (
    selector === 'img[data-gallery-cover-src]'
      && nextSameCoverImage.getAttribute('data-gallery-cover-src')
      ? [nextSameCoverImage]
      : originalQuerySelectorAll(selector)
  );
  virtualGrid.sections = [{
    blocksData: [],
    bottom: 100,
    kind: 'artist',
    sectionKey: 'retained-cover-section',
    top: 0,
  }];
  virtualGrid.totalHeight = 100;
  virtualGrid.renderSection = () => '<section></section>';
  virtualGrid.patchRenderedSections = () => {
    oldSameCoverImage.isConnected = false;
    oldRemovedCoverImage.isConnected = false;
  };
  virtualGrid.scheduleSelectedFamilyCoverPrefetch = () => {};
  virtualGrid.prewarmVisibleAlbumDetails = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  virtualGrid.scheduleMeasureRows = () => {};

  try {
    virtualGrid.render(true);

    assert.equal(
      sameCoverTask.cancelled,
      false,
      'the original same-cover task must remain in flight for the replacement consumer',
    );
    assert.equal(scheduler.tasks.get(sameCoverUrl), sameCoverTask);
    assert.equal(sameCoverTask.generation, generationTwo);
    assert.equal(
      sameCoverTask.imageRequests.some((request) => request.image === nextSameCoverImage),
      true,
      'the replacement image must adopt the existing same-cover task',
    );
    assert.equal(removedCoverTask.cancelled, true, 'a cover removed by the patch must be pruned');
    assert.equal(removedCoverTask.abortController.signal.aborted, true);
  } finally {
    released = true;
    releaseWaiters.splice(0).forEach((release) => release());
    await Promise.allSettled([sameCoverPromise, removedCoverPromise]);
  }
});

{
  const { context } = createRuntimeContext();
  const summary = JSON.parse(JSON.stringify(context.getAlbumCardSummary({
    preview_only: true,
    track_count_preview: 15,
    tracks: [
      { path: 'C:/Music/Studio Records/track-5.mp3' },
    ],
  })));
  assert.equal(
    summary.trackCount,
    15,
    'a compact preview must render its authoritative membership count instead of its partial hydrated tracks',
  );
}

{
  const { context } = createRuntimeContext();
  const summary = JSON.parse(JSON.stringify(context.getAlbumCardSummary({
    total_duration_seconds: 480,
    total_duration_display: '8m',
    tracks: [
      { duration_seconds: 100 },
      { duration_seconds: 200 },
      { duration_seconds: 300 },
    ],
  })));
  assert.deepEqual(summary, {
    trackCount: 2,
    lengthDisplay: '300s',
  });
}

{
  const { context } = createRuntimeContext();
  assert.equal(context.resolveGalleryRendererMode('cards'), 'cards');
  assert.equal(context.resolveGalleryRendererMode('covers'), 'covers');
  assert.equal(context.resolveGalleryRendererMode('list'), 'list');
  assert.equal(context.resolveGalleryRendererMode('unexpected-mode'), 'cards');
  const cardsConfig = context.getGalleryModeConfig('cards');
  const coversConfig = context.getGalleryModeConfig('covers');
  const listConfig = context.getGalleryModeConfig('list');
  assert.equal(cardsConfig.mode, 'cards');
  assert.equal(cardsConfig.renderer, context.renderArtistGroupsCardMode);
  assert.equal(cardsConfig.layoutConfig, context.CARD_GALLERY_LAYOUT_CONFIG);
  assert.equal(coversConfig.mode, 'covers');
  assert.equal(coversConfig.renderer, context.renderArtistGroupsCardMode);
  assert.equal(coversConfig.layoutConfig, context.CARD_GALLERY_LAYOUT_CONFIG);
  assert.equal(listConfig.mode, 'list');
  assert.equal(listConfig.renderer, context.renderArtistGroupsCardMode);
  assert.equal(listConfig.layoutConfig, context.CARD_GALLERY_LAYOUT_CONFIG);
  assert.equal(context.getGalleryModeRenderer('covers'), context.renderArtistGroupsCardMode);
  assert.equal(context.getGalleryModeRenderer('list'), context.renderArtistGroupsCardMode);
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  virtualGrid.render = () => {};

  virtualGrid.setGroups([], [], [], {
    preserveMountedGalleryChildren: true,
    preserveScroll: true,
  });
  assert.equal(
    virtualGrid._preserveExistingChildrenGeneration,
    virtualGrid._renderGeneration,
  );

  virtualGrid.setGroups([], [], [], { preserveScroll: true });
  assert.equal(virtualGrid._preserveExistingChildrenGeneration, -1);
}

{
  const { context, containerEl, topSpacerEl, bottomSpacerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  context.state.view.artist_groups = [
    {
      artist: 'Fallback Artist',
      artist_display: 'Fallback Artist',
      albums: [
        {
          key: 'fallback-1',
          name: 'Fallback Album',
          album_artist: 'Fallback Artist',
          album_rating: 7,
          tracks: [{ duration_seconds: 120 }],
          total_duration_seconds: 120,
        },
      ],
    },
  ];
  virtualGrid.setGroups([], [], null, {});
  assert.ok(containerEl.innerHTML.includes('Fallback Artist'));
  assert.ok(containerEl.innerHTML.includes('Fallback Album'));
  assert.equal(topSpacerEl.style.height, '0px');
  assert.equal(bottomSpacerEl.style.height, '0px');
  assert.equal(context.getIndexedAlbum('fallback-1')?.name, 'Fallback Album');
}

function createResponsiveGalleryScenario(galleryScalePercent, clientWidth) {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const albums = Array.from({ length: 6 }, (_value, index) => ({
    key: `responsive-${index + 1}`,
    name: `Responsive Album ${index + 1}`,
    album_artist: 'Responsive Artist',
    tracks: [],
  }));
  const section = {
    kind: 'artist',
    sectionKey: 'all:Responsive Artist:0',
    sectionType: 'all',
    group: {
      artist: 'Responsive Artist',
      artist_display: 'Responsive Artist',
      albums,
    },
  };
  context.state.view.gallery_scale_percent = galleryScalePercent;
  scrollEl.clientWidth = clientWidth;
  virtualGrid.sections = [section];
  virtualGrid.recalculate();
  return {
    albums,
    context,
    scrollEl,
    section,
    virtualGrid,
  };
}

function extractFirstGridTemplate(markup) {
  return String(markup || '').match(/grid-template-columns:\s*([^;]+);/)?.[1]?.trim() || '';
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const albumKey = 'snow-white-and-the-seven-dwarfs';
  const sectionKeys = [
    'artist:all:Frank Churchill:8',
    'artist:all:Frank Churchill / Leigh Harline / Larry Morey:9',
    'artist:all:Frank Churchill / Leigh Harline / Larry Morey / Frank Churchill / Larry Morey:10',
    'artist:all:Larry Morey:11',
    'artist:all:Leigh Harline:12',
  ];
  const occurrenceRects = [
    { top: -1009, bottom: -571 },
    { top: -505, bottom: -67 },
    { top: 0, bottom: 438 },
    { top: 504, bottom: 942 },
    { top: 1008, bottom: 1446 },
  ];
  context.__albumTitleButtons = sectionKeys.map((sectionKey, index) => (
    context.createAlbumTitleButton(albumKey, occurrenceRects[index], sectionKey)
  ));
  scrollEl.scrollTop = 7601;

  const anchor = virtualGrid.captureScrollAnchor();
  assert.equal(anchor.albumKey, albumKey);
  assert.equal(
    anchor.sectionOccurrenceKey,
    sectionKeys[2],
    'capture must record the exact repeated artist-section occurrence at the viewport',
  );

  context.__albumTitleButtons = sectionKeys.map((sectionKey, index) => (
    context.createAlbumTitleButton(albumKey, occurrenceRects[index], sectionKey)
  ));
  virtualGrid.restoreScrollAnchor(anchor);

  assert.equal(
    scrollEl.scrollTop,
    7601,
    'restore must keep the captured repeated occurrence instead of jumping 1009px to the first album-key match',
  );
}

test('scroll anchoring follows the same visible album when a scan changes its request key', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const sectionOccurrenceKey = 'artist:all:E2E Rarity Artist:0';
  context.__albumTitleButtons = [context.createAlbumTitleButton(
    'sparse-year-before-scan',
    { top: 80, bottom: 518 },
    sectionOccurrenceKey,
    'Sparse Year Edit Fixture',
  )];
  scrollEl.scrollTop = 4200;

  const anchor = virtualGrid.captureScrollAnchor();
  context.__albumTitleButtons = [context.createAlbumTitleButton(
    'sparse-year-after-scan',
    { top: 240, bottom: 678 },
    sectionOccurrenceKey,
    'Sparse Year Edit Fixture',
  )];
  virtualGrid.sections = [{ kind: 'artist', sectionKey: 'all:E2E Rarity Artist:0' }];

  virtualGrid.restoreScrollAnchor(anchor);

  assert.equal(scrollEl.scrollTop, 4360);
});

test('scroll anchoring keeps the same release year when duplicate album names survive a scan', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const sectionOccurrenceKey = 'artist:all:E2E Rarity Artist:0';
  context.__albumTitleButtons = [context.createAlbumTitleButton(
    'sparse-year-before-scan',
    { top: 80, bottom: 518 },
    sectionOccurrenceKey,
    'Sparse Year Edit Fixture',
    '2004',
  )];
  scrollEl.scrollTop = 4200;

  const anchor = virtualGrid.captureScrollAnchor();
  context.__albumTitleButtons = [
    context.createAlbumTitleButton(
      'sparse-year-before-scan',
      { top: 240, bottom: 678 },
      sectionOccurrenceKey,
      'Sparse Year Edit Fixture',
      '2014',
    ),
    context.createAlbumTitleButton(
      'sparse-year-after-scan',
      { top: 720, bottom: 1158 },
      sectionOccurrenceKey,
      'Sparse Year Edit Fixture',
      '2004',
    ),
  ];
  virtualGrid.sections = [{ kind: 'artist', sectionKey: 'all:E2E Rarity Artist:0' }];

  virtualGrid.restoreScrollAnchor(anchor);

  assert.equal(scrollEl.scrollTop, 4840);
});

test('scroll anchoring restores an offscreen same-release card from the virtual section model', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const sectionOccurrenceKey = 'artist:all:E2E Rarity Artist:0';
  context.__albumTitleButtons = [context.createAlbumTitleButton(
    'sparse-year-before-scan',
    { top: 80, bottom: 518 },
    sectionOccurrenceKey,
    'Sparse Year Edit Fixture',
    '2004',
  )];
  scrollEl.scrollTop = 4200;

  const anchor = virtualGrid.captureScrollAnchor();
  context.__albumTitleButtons = [context.createAlbumTitleButton(
    'sparse-year-before-scan',
    { top: 240, bottom: 678 },
    sectionOccurrenceKey,
    'Sparse Year Edit Fixture',
    '2014',
  )];
  virtualGrid.columns = 1;
  virtualGrid.sections = [{
    kind: 'artist',
    sectionKey: 'all:E2E Rarity Artist:0',
    top: 3000,
    blockOffsets: [0, 434],
    group: {
      albums: [
        { key: 'sparse-year-before-scan', name: 'Sparse Year Edit Fixture', year: 2014 },
        { key: 'sparse-year-after-scan', name: 'Sparse Year Edit Fixture', year: 2004 },
      ],
    },
  }];

  virtualGrid.restoreScrollAnchor(anchor);

  assert.equal(scrollEl.scrollTop, 3408);
});

test('setGroups absolute scroll preservation restores captured numeric coordinates immediately and on the next frame', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 800;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
    scheduledFrames.delete(frameId);
  };
  const anchorTrigger = context.createAlbumTitleButton(
    'absolute-scroll-album',
    { top: 40, bottom: 340 },
    'artist:all:Absolute Artist:0',
  );
  context.__albumTitleButtons = [anchorTrigger];
  virtualGrid.render = () => {
    scrollEl.scrollTop = 100;
    scrollEl.scrollLeft = 2;
    anchorTrigger.rect = { top: 240, bottom: 540 };
  };
  virtualGrid.primeVisibleCoverImages = () => {};
  scrollEl.scrollTop = 842;
  scrollEl.scrollLeft = 27;

  virtualGrid.setGroups(
    [{
      artist: 'Absolute Artist',
      artist_display: 'Absolute Artist',
      albums: [{
        key: 'absolute-scroll-album',
        name: 'Absolute Scroll Album',
        album_artist: 'Absolute Artist',
        tracks: [],
      }],
    }],
    [],
    null,
    { preserveScroll: true, preserveAbsoluteScroll: true },
  );

  assert.deepEqual(
    { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop },
    { scrollLeft: 27, scrollTop: 842 },
    'absolute mode must restore the captured numeric coordinates immediately instead of following a shifted card anchor',
  );
  const restoreFrame = scheduledFrames.get(virtualGrid._scrollRestoreRaf);
  assert.equal(typeof restoreFrame, 'function');
  scrollEl.scrollTop = 101;
  scrollEl.scrollLeft = 3;
  restoreFrame();
  assert.deepEqual(
    { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop },
    { scrollLeft: 27, scrollTop: 842 },
    'absolute mode must restore the same captured coordinates in its next-frame stabilization',
  );
});

test('setGroups absolute scroll preservation can retain an explicit interaction-boundary coordinate', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 825;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  scrollEl.scrollTop = 9592;
  scrollEl.scrollLeft = 37;

  virtualGrid.setGroups([], [], [], {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
    absoluteScrollPosition: { scrollLeft: 11, scrollTop: 9040 },
  });

  assert.deepEqual(
    { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop },
    { scrollLeft: 11, scrollTop: 9040 },
  );
  scrollEl.scrollTop = 9592;
  scrollEl.scrollLeft = 37;
  scheduledFrames.get(virtualGrid._scrollRestoreRaf)?.();
  assert.deepEqual(
    { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop },
    { scrollLeft: 11, scrollTop: 9040 },
  );
});

test('setGroups renders the immediate virtual window from the explicit preserved coordinate', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const renderedCoordinates = [];
  virtualGrid.render = () => {
    renderedCoordinates.push({
      scrollLeft: scrollEl.scrollLeft,
      scrollTop: scrollEl.scrollTop,
    });
  };
  virtualGrid.primeVisibleCoverImages = () => {};
  scrollEl.scrollTop = 9592;
  scrollEl.scrollLeft = 37;

  virtualGrid.setGroups([], [], [], {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
    absoluteScrollPosition: { scrollLeft: 11, scrollTop: 9040 },
  });

  assert.deepEqual(
    renderedCoordinates,
    [{ scrollLeft: 11, scrollTop: 9040 }],
    'the synchronous optimistic render must use the interaction-boundary coordinate, not a stale modal-era window',
  );
});

test('setGroups carries forward unchanged row measurements across optimistic regrouping', () => {
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  const buildAlbums = (artist, count) => Array.from({ length: count }, (_value, index) => ({
    album_artist: artist,
    key: `${artist.toLowerCase()}-${index + 1}`,
    name: `${artist} Album ${index + 1}`,
    tracks: [],
  }));
  const stableAlbums = buildAlbums('Stable Preceding Artist', 4);
  const editedAlbums = buildAlbums('Edited Artist', 4);

  virtualGrid.setGroups([], [], [{
    artist: 'Stable Preceding Artist',
    artist_display: 'Stable Preceding Artist',
    albums: stableAlbums,
  }, {
    artist: 'Edited Artist',
    artist_display: 'Edited Artist',
    albums: editedAlbums,
  }]);
  const stableSectionKey = 'all:Stable Preceding Artist:0';
  const editedSectionKey = 'all:Edited Artist:0';
  const stableSection = virtualGrid.sectionByKey.get(stableSectionKey);
  const stableMeasuredHeights = stableSection.blockHeights.map(() => 137);
  stableSection.blockHeights = stableMeasuredHeights.slice();
  stableSection.measuredBlockKeys = stableSection.blockMeasureKeys.slice();
  virtualGrid.recalculate();
  const editedTopBeforeRegroup = virtualGrid.sectionByKey.get(editedSectionKey).top;

  virtualGrid.setGroups([], [], [{
    artist: 'Stable Preceding Artist',
    artist_display: 'Stable Preceding Artist',
    albums: stableAlbums,
  }, {
    artist: 'Edited Artist',
    artist_display: 'Edited Artist',
    albums: [...editedAlbums, ...buildAlbums('Edited Artist', 1).map((album) => ({
      ...album,
      key: 'edited-artist-new',
      name: 'Edited Artist New Album',
    }))],
  }], {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
  });

  assert.deepEqual(
    virtualGrid.sectionByKey.get(stableSectionKey).blockHeights,
    stableMeasuredHeights,
    'unchanged preceding rows must retain measured heights instead of reverting to the collapsed estimate',
  );
  assert.equal(
    virtualGrid.sectionByKey.get(editedSectionKey).top,
    editedTopBeforeRegroup,
    'an optimistic edit must not shift the edited section because unrelated preceding measurements were discarded',
  );
});

test('setGroups keeps provisional row heights when one inserted album shifts downstream rows', () => {
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  virtualGrid.columns = 4;
  const albums = Array.from({ length: 20 }, (_value, index) => ({
    album_artist: 'Virtualized Artist',
    key: `virtualized-${index + 1}`,
    name: `Virtualized Album ${index + 1}`,
    tracks: [],
  }));

  virtualGrid.setGroups([], [], [{
    artist: 'Virtualized Artist',
    artist_display: 'Virtualized Artist',
    albums,
  }]);
  const sectionKey = 'all:Virtualized Artist:0';
  const originalSection = virtualGrid.sectionByKey.get(sectionKey);
  const measuredHeights = originalSection.blockHeights.map((_height, index) => 371 + index);
  originalSection.blockHeights = measuredHeights.slice();
  originalSection.measuredBlockKeys = originalSection.blockMeasureKeys.slice();
  virtualGrid.recalculate();

  virtualGrid.setGroups([], [], [{
    artist: 'Virtualized Artist',
    artist_display: 'Virtualized Artist',
    albums: [
      ...albums.slice(0, 7),
      {
        album_artist: 'Virtualized Artist',
        key: 'virtualized-inserted',
        name: 'Virtualized Inserted Album',
        tracks: [],
      },
      {
        album_artist: 'Virtualized Artist',
        key: 'virtualized-inserted-second',
        name: 'Virtualized Inserted Album 2',
        tracks: [],
      },
      ...albums.slice(7),
    ],
  }], {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
  });

  const regroupedSection = virtualGrid.sectionByKey.get(sectionKey);
  assert.deepEqual(
    regroupedSection.blockHeights.slice(0, measuredHeights.length),
    measuredHeights,
    'changed downstream rows must keep their measured height as the provisional rerender geometry',
  );
  assert.equal(
    regroupedSection.blockHeights.at(-1),
    virtualGrid.collapsedRowHeight,
    'a genuinely new trailing row should start from the collapsed estimate',
  );
  assert.equal(
    regroupedSection.measuredBlockKeys[0],
    regroupedSection.blockMeasureKeys[0],
    'an unchanged row can remain measured',
  );
  assert.equal(
    regroupedSection.measuredBlockKeys[2],
    '',
    'a changed row must still be scheduled for remeasurement',
  );
});

test('setGroups retains unchanged measurements when an unrelated artist is inserted earlier', () => {
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  const buildGroup = (artist) => ({
    artist,
    artist_display: artist,
    albums: Array.from({ length: 4 }, (_value, index) => ({
      album_artist: artist,
      key: `${artist.toLowerCase()}-${index + 1}`,
      name: `${artist} Album ${index + 1}`,
      tracks: [],
    })),
  });
  const stableGroup = buildGroup('Stable Artist');

  virtualGrid.setGroups([], [], [stableGroup, buildGroup('Later Artist')]);
  const originalStableSection = virtualGrid.sectionByKey.get('all:Stable Artist:0');
  const stableMeasuredHeights = originalStableSection.blockHeights.map(() => 137);
  originalStableSection.blockHeights = stableMeasuredHeights.slice();
  originalStableSection.measuredBlockKeys = originalStableSection.blockMeasureKeys.slice();
  virtualGrid.recalculate();

  virtualGrid.setGroups([], [], [
    buildGroup('Inserted Artist'),
    stableGroup,
    buildGroup('Later Artist'),
  ], {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
  });

  assert.deepEqual(
    virtualGrid.sectionByKey.get('all:Stable Artist:0').blockHeights,
    stableMeasuredHeights,
    'an unrelated insertion must not discard measurements for a semantically unchanged artist section',
  );
});

test('setGroups keeps an artist section identity stable when preceding artists disappear', () => {
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  const buildGroup = (artist) => ({
    artist,
    artist_display: artist,
    albums: [{
      album_artist: artist,
      key: `${artist.toLowerCase()}-album`,
      name: `${artist} Album`,
      tracks: [],
    }],
  });
  const stableGroup = buildGroup('Stable Artist');

  virtualGrid.setGroups([], [], [buildGroup('Removed Artist'), stableGroup]);
  const initialSectionKey = virtualGrid.sections.find(
    (section) => section.group?.artist === 'Stable Artist',
  )?.sectionKey;

  virtualGrid.setGroups([], [], [stableGroup], { preserveScroll: true });
  const refreshedSectionKey = virtualGrid.sections.find(
    (section) => section.group?.artist === 'Stable Artist',
  )?.sectionKey;

  assert.equal(
    refreshedSectionKey,
    initialSectionKey,
    'scan reconciliation must keep the same artist anchor when earlier artists leave the dataset',
  );
});

test('row measurement stabilization retains absolute coordinates after rendered anchors shift', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 850;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
    scheduledFrames.delete(frameId);
  };
  const anchorTrigger = context.createAlbumTitleButton(
    'measured-absolute-album',
    { top: 50, bottom: 350 },
    'artist:all:Measured Artist:0',
  );
  context.__albumTitleButtons = [anchorTrigger];
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  scrollEl.scrollTop = 1200;
  scrollEl.scrollLeft = 21;
  virtualGrid.setGroups(
    [{
      artist: 'Measured Artist',
      artist_display: 'Measured Artist',
      albums: [{
        key: 'measured-absolute-album',
        name: 'Measured Absolute Album',
        album_artist: 'Measured Artist',
        tracks: [],
      }],
    }],
    [],
    null,
    { preserveScroll: true, preserveAbsoluteScroll: true },
  );
  scheduledFrames.get(virtualGrid._scrollRestoreRaf)?.();

  const section = {
    sectionKey: 'artist:measured-absolute',
    blockHeights: [120],
    blockMeasureKeys: ['row:1:measured-absolute-album'],
    measuredBlockKeys: [''],
  };
  virtualGrid.sectionByKey = new Map([[section.sectionKey, section]]);
  context.__rows = [createMeasuredRow(section.sectionKey, 0, { rowHeight: 360 })];
  context.__rowSelectorQueryCount = 1;
  virtualGrid.render = () => {
    anchorTrigger.rect = { top: 250, bottom: 550 };
  };
  scrollEl.scrollTop = 1200;
  scrollEl.scrollLeft = 21;

  virtualGrid.measureRenderedRows();

  assert.deepEqual(
    { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop },
    { scrollLeft: 21, scrollTop: 1200 },
    'row-height reconciliation must retain absolute coordinates instead of following a shifted card anchor',
  );
  const stabilizeFrame = scheduledFrames.get(virtualGrid._stabilizeRaf);
  assert.equal(typeof stabilizeFrame, 'function');
  scrollEl.scrollTop = 111;
  scrollEl.scrollLeft = 4;
  stabilizeFrame();
  assert.deepEqual(
    { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop },
    { scrollLeft: 21, scrollTop: 1200 },
  );
});

test('a newer user scroll invalidates a pending absolute setGroups restoration', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 880;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
    scheduledFrames.delete(frameId);
  };
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  scrollEl.scrollTop = 900;
  scrollEl.scrollLeft = 14;

  virtualGrid.setGroups([], [], [], {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
  });
  const staleRestoreFrameId = virtualGrid._scrollRestoreRaf;
  const staleRestoreFrame = scheduledFrames.get(staleRestoreFrameId);
  assert.equal(typeof staleRestoreFrame, 'function');

  scrollEl.scrollTop = 1400;
  scrollEl.scrollLeft = 33;
  scrollEl.dispatchEvent({ type: 'wheel' });
  scrollEl.dispatchEvent({ type: 'scroll' });
  staleRestoreFrame();

  assert.ok(
    context.canceledBrowserAnimationFrames.includes(staleRestoreFrameId),
    'a newer user scroll must cancel the pending absolute restoration frame',
  );
  assert.deepEqual(
    { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop },
    { scrollLeft: 33, scrollTop: 1400 },
    'a stale absolute restoration callback must not snap back after newer user navigation',
  );
});

test('setGroups absolute scroll mode skips discarded relative anchor capture work', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  let relativeAnchorCaptureCount = 0;
  virtualGrid.captureScrollAnchor = () => {
    relativeAnchorCaptureCount += 1;
    return { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop };
  };
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  scrollEl.scrollTop = 920;
  scrollEl.scrollLeft = 18;

  virtualGrid.setGroups([], [], [], {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
  });

  assert.equal(
    relativeAnchorCaptureCount,
    0,
    'absolute mode must not scan rendered cards or read anchor layout that it will discard',
  );
});

test('row measurement in absolute scroll mode skips discarded relative anchor capture work', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  scrollEl.scrollTop = 1120;
  scrollEl.scrollLeft = 24;
  virtualGrid.setGroups([], [], [], {
    preserveScroll: true,
    preserveAbsoluteScroll: true,
  });

  let relativeAnchorCaptureCount = 0;
  virtualGrid.captureScrollAnchor = () => {
    relativeAnchorCaptureCount += 1;
    return { scrollLeft: scrollEl.scrollLeft, scrollTop: scrollEl.scrollTop };
  };
  const section = {
    sectionKey: 'artist:absolute-measure-performance',
    blockHeights: [120],
    blockMeasureKeys: ['row:1:absolute-measure-performance'],
    measuredBlockKeys: [''],
  };
  virtualGrid.sectionByKey = new Map([[section.sectionKey, section]]);
  context.__rows = [createMeasuredRow(section.sectionKey, 0, { rowHeight: 360 })];
  context.__rowSelectorQueryCount = 1;

  virtualGrid.measureRenderedRows();

  assert.equal(
    relativeAnchorCaptureCount,
    0,
    'absolute measurement stabilization must not perform relative DOM anchor scans/layout reads',
  );
});

test('row measurement reconciliation retains the settled scroll render owner', () => {
  const { context, scrollEl, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 980;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  virtualGrid.setGroups(
    [{
      artist: 'Measured Scroll Artist',
      artist_display: 'Measured Scroll Artist',
      albums: [{
        key: 'measured-scroll-album',
        name: 'Measured Scroll Album',
        album_artist: 'Measured Scroll Artist',
        tracks: [],
      }],
    }],
    [],
    null,
    { preserveScroll: true },
  );
  scrollEl.scrollTop = 2735;
  virtualGrid.onScroll();
  const scrollRenderFrameId = virtualGrid._raf;
  scheduledFrames.get(scrollRenderFrameId)();

  const section = virtualGrid.sections.find((candidate) => candidate.kind === 'artist');
  section.blockHeights = [120];
  section.blockMeasureKeys = ['row:1:measured-scroll-album'];
  section.measuredBlockKeys = [''];
  virtualGrid.sectionByKey = new Map([[section.sectionKey, section]]);
  const measuredRows = [createMeasuredRow(section.sectionKey, 0, { rowHeight: 360 })];
  const originalQuerySelectorAll = containerEl.querySelectorAll.bind(containerEl);
  containerEl.querySelectorAll = (selector) => (
    selector === '.album-row[data-section-key][data-block-index]'
      ? measuredRows
      : originalQuerySelectorAll(selector)
  );
  virtualGrid.render = () => {
    context.__ALBUM_HAVEN_VIRTUAL_GRID__.latestRender = {
      renderGeneration: virtualGrid._renderGeneration,
      renderRafOwner: Number(virtualGrid._activeRenderRafOwner || 0),
      viewportTop: scrollEl.scrollTop,
    };
  };
  virtualGrid.measureRenderedRows();

  const diagnostics = context.__ALBUM_HAVEN_VIRTUAL_GRID__;
  assert.equal(diagnostics.latestMeasurement.changed, true);
  assert.equal(section.blockHeights[0], 360);
  assert.equal(diagnostics.latestScroll.renderRafOwner, scrollRenderFrameId);
  assert.equal(diagnostics.latestRender.renderRafOwner, scrollRenderFrameId);
  assert.equal(diagnostics.latestRender.renderGeneration, diagnostics.latestScroll.renderGeneration);
});

test('same-viewport rerenders retain the settled scroll render owner', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 990;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  virtualGrid.setGroups(
    [{
      artist: 'Settled Scroll Artist',
      artist_display: 'Settled Scroll Artist',
      albums: [{
        key: 'settled-scroll-album',
        name: 'Settled Scroll Album',
        album_artist: 'Settled Scroll Artist',
        tracks: [],
      }],
    }],
    [],
    null,
    { preserveScroll: true },
  );
  scrollEl.scrollTop = 1020;
  virtualGrid.onScroll();
  const scrollRenderFrameId = virtualGrid._raf;
  scheduledFrames.get(scrollRenderFrameId)();
  virtualGrid.render(true);

  const diagnostics = context.__ALBUM_HAVEN_VIRTUAL_GRID__;
  assert.equal(diagnostics.latestScroll.scrollTop, 1020);
  assert.equal(diagnostics.latestRender.viewportTop, 1020);
  assert.equal(diagnostics.latestRender.renderRafOwner, scrollRenderFrameId);
});

test('non-scrollable regrouping publishes a settled viewport render owner', () => {
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 995;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  const runScheduledFrames = () => {
    while (scheduledFrames.size) {
      const [frameId, callback] = scheduledFrames.entries().next().value;
      scheduledFrames.delete(frameId);
      callback();
    }
  };
  const group = (artist, album) => ({
    artist,
    artist_display: artist,
    albums: [{
      key: `${artist}:${album}`,
      name: album,
      album_artist: artist,
      tracks: [],
    }],
  });

  virtualGrid.setGroups([group('Initial Artist', 'Initial Album')], [], null, {});
  runScheduledFrames();
  virtualGrid.setGroups([], [group('Filtered Artist', 'Only Album')], null, {
    preserveScroll: true,
  });
  runScheduledFrames();

  const diagnostics = context.__ALBUM_HAVEN_VIRTUAL_GRID__;
  assert.equal(diagnostics.latestMeasurement.changed, false);
  assert.equal(diagnostics.latestScroll.renderGeneration, virtualGrid._renderGeneration);
  assert.ok(diagnostics.latestScroll.renderRafOwner > 0);
  assert.equal(
    diagnostics.latestRender.renderRafOwner,
    diagnostics.latestScroll.renderRafOwner,
  );
  assert.equal(diagnostics.latestRender.renderGeneration, virtualGrid._renderGeneration);
  assert.equal(diagnostics.latestScroll.scrollTop, 0);
  assert.equal(diagnostics.latestRender.viewportTop, 0);
  assert.equal(diagnostics.latestMeasurement.scrollTop, 0);
});

test('scroll render timer completes a pending frame when animation frames are starved', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 1000;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  virtualGrid.setGroups(
    [{
      artist: 'Starved Frame Artist',
      artist_display: 'Starved Frame Artist',
      albums: Array.from({ length: 12 }, (_value, index) => ({
        key: `starved-frame-album-${index + 1}`,
        name: `Starved Frame Album ${index + 1}`,
        album_artist: 'Starved Frame Artist',
        tracks: [],
      })),
    }],
    [],
    null,
    { preserveScroll: true },
  );
  scrollEl.scrollTop = 510;
  virtualGrid.onScroll();
  const scrollRenderFrameId = virtualGrid._raf;
  const fallback = context.__scheduledBrowserTimeouts.find(({ delay }) => delay === 100);

  assert.ok(fallback, 'expected a bounded scroll-render fallback timer');
  fallback.callback();

  const diagnostics = context.__ALBUM_HAVEN_VIRTUAL_GRID__;
  assert.equal(diagnostics.latestScroll.scrollTop, 510);
  assert.equal(diagnostics.latestRender.viewportTop, 510);
  assert.equal(diagnostics.latestRender.renderRafOwner, scrollRenderFrameId);
  assert.equal(virtualGrid._raf, null);
  assert.deepEqual(context.canceledBrowserAnimationFrames, [scrollRenderFrameId]);

  scheduledFrames.get(scrollRenderFrameId)();
  assert.equal(diagnostics.latestRender.renderRafOwner, scrollRenderFrameId);
});

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const albumKey = 'repeated-album';
  const capturedOccurrenceKey = 'artist:all:Captured Artist:2';
  const renderedDuplicateOccurrenceKey = 'artist:all:Rendered Duplicate:0';
  const capturedSection = { kind: 'artist', sectionKey: 'all:Captured Artist:2' };
  const renderedDuplicateSection = { kind: 'artist', sectionKey: 'all:Rendered Duplicate:0' };
  const renderedDuplicate = context.createAlbumTitleButton(
    albumKey,
    { top: 240, bottom: 678 },
    renderedDuplicateOccurrenceKey,
  );
  const anchor = {
    albumKey,
    sectionOccurrenceKey: capturedOccurrenceKey,
    scrollLeft: 0,
    scrollTop: 7601,
    offsetTop: 0,
  };
  virtualGrid.sections = [capturedSection, renderedDuplicateSection];
  context.__albumTitleButtons = [renderedDuplicate];
  scrollEl.scrollTop = anchor.scrollTop;

  virtualGrid.restoreScrollAnchor(anchor);

  assert.equal(
    scrollEl.scrollTop,
    anchor.scrollTop,
    'an off-DOM captured occurrence that remains in the grid model must preserve the numeric anchor',
  );

  virtualGrid.sections = [renderedDuplicateSection];
  virtualGrid.restoreScrollAnchor(anchor);

  assert.equal(
    scrollEl.scrollTop,
    anchor.scrollTop + 240,
    'a duplicate album-key occurrence may become the fallback only after the captured occurrence leaves the model',
  );
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const primaryGroups = [
    {
      artist: 'Broadcast',
      artist_display: 'Broadcast',
      albums: [
        { key: 'tender-buttons', name: 'Tender Buttons', album_artist: 'Broadcast', album_rating: 10, tracks: [] },
      ],
    },
  ];
  const familyGroups = [
    {
      artist: 'Trish Keenan',
      artist_display: 'Trish Keenan',
      albums: [
        { pathSignature: 'solo-path', name: 'Solo', album_artist: 'Trish Keenan', album_rating: 8, tracks: [] },
      ],
    },
  ];
  virtualGrid.setGroups(primaryGroups, familyGroups, null, {});
  assert.equal(virtualGrid.sections[0].title, 'Primary Artist');
  assert.equal(virtualGrid.sections[2].title, 'Family');
  assert.equal(context.getIndexedAlbum('tender-buttons')?.name, 'Tender Buttons');
  assert.equal(context.getIndexedAlbum('solo-path')?.name, 'Solo');
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);

  const firstToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
  const secondToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();

  assert.deepEqual(context.galleryCoverSchedulerSuspends, ['utility-modal-preemption']);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(firstToken), true);
  assert.equal(context.galleryCoverSchedulerResumes, 0);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(secondToken), true);
  assert.equal(context.galleryCoverSchedulerResumes, 1);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(firstToken), false);
  assert.equal(context.galleryCoverSchedulerResumes, 1);
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);

  const firstToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
  const secondToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();

  assert.deepEqual(context.galleryCoverSchedulerSuspends, ['utility-modal-preemption']);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(secondToken), true);
  assert.equal(context.galleryCoverSchedulerResumes, 0);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(firstToken), true);
  assert.equal(context.galleryCoverSchedulerResumes, 1);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(secondToken), false);
  assert.equal(context.galleryCoverSchedulerResumes, 1);
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);

  const firstToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();
  const secondToken = virtualGrid.suspendSelectedArtistCoverLoadsForUserAction();

  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(9999), false);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(), false);
  assert.equal(context.galleryCoverSchedulerResumes, 0);

  virtualGrid.destroy();

  assert.equal(context.galleryCoverSchedulerResumes, 1);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(firstToken), false);
  assert.equal(virtualGrid.resumeSelectedArtistCoverLoadsAfterUserAction(secondToken), false);
  assert.equal(context.galleryCoverSchedulerResumes, 1);
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const groups = [{
    artist: 'Neal Morse',
    artist_display: 'Neal Morse',
    albums: [{ key: 'joseph', name: 'Joseph', album_artist: 'Neal Morse', tracks: [] }],
  }];
  const scheduledFrames = new Map();
  let nextFrameId = 40;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
    scheduledFrames.delete(frameId);
  };
  scrollEl.scrollTop = 480;
  const staleRenderFrameId = context.scheduleBrowserAnimationFrame(() => {
    scrollEl.scrollTop = 480;
  });
  const staleMeasureFrameId = context.scheduleBrowserAnimationFrame(() => {
    scrollEl.scrollTop = 480;
  });
  virtualGrid._raf = staleRenderFrameId;
  virtualGrid._measureRaf = staleMeasureFrameId;
  virtualGrid._measureTimeout = 43;
  virtualGrid.render = () => {
    scrollEl.scrollTop = 480;
  };
  let restoredMeasuredAnchor = false;
  virtualGrid.restoreScrollAnchor = () => {
    restoredMeasuredAnchor = true;
    scrollEl.scrollTop = 842;
  };

  virtualGrid.setGroups(groups, [], null, {});
  scrollEl.scrollTop = 842;
  virtualGrid.stabilizeScrollAfterMeasurement({ scrollTop: 842 });
  const currentFrameIds = [...scheduledFrames.keys()].filter((frameId) => (
    frameId !== staleRenderFrameId && frameId !== staleMeasureFrameId
  ));
  currentFrameIds.forEach((frameId) => {
    const callback = scheduledFrames.get(frameId);
    scheduledFrames.delete(frameId);
    callback();
  });
  scheduledFrames.get(staleRenderFrameId)?.();
  scheduledFrames.get(staleMeasureFrameId)?.();

  assert.equal(
    scrollEl.scrollTop,
    0,
    'a non-preserved search render must defeat browser scroll anchoring and remain at the first result',
  );
  assert.deepEqual(context.canceledBrowserAnimationFrames, [staleRenderFrameId, staleMeasureFrameId]);
  assert.equal(scheduledFrames.has(staleRenderFrameId), false);
  assert.equal(scheduledFrames.has(staleMeasureFrameId), false);
  assert.ok(context.clearedBrowserTimeouts.includes(43));
  assert.equal(restoredMeasuredAnchor, false);
  assert.equal(virtualGrid._resetScrollAfterMeasure, false);

  scrollEl.scrollTop = 320;
  virtualGrid.stabilizeScrollAfterMeasurement({ scrollTop: 320 });
  const preservedFrameId = [...scheduledFrames.keys()].at(-1);
  const preservedFrame = scheduledFrames.get(preservedFrameId);
  scheduledFrames.delete(preservedFrameId);
  preservedFrame();
  assert.equal(restoredMeasuredAnchor, true);
  assert.equal(scrollEl.scrollTop, 842, 'preserved renders must retain measured anchor restoration');
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 600;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
  };
  let restoreCount = 0;
  virtualGrid.restoreScrollAnchor = (anchor) => {
    restoreCount += 1;
    scrollEl.scrollTop = Number(anchor?.scrollTop || 0);
  };
  virtualGrid.primeVisibleCoverImages = () => {};

  scrollEl.scrollTop = 6320;
  virtualGrid.stabilizeScrollAfterMeasurement({ scrollTop: 6336 });
  const stabilizeFrameId = virtualGrid._stabilizeRaf;
  const stabilizeFrame = scheduledFrames.get(stabilizeFrameId);
  assert.equal(scrollEl.scrollTop, 6336);
  assert.equal(restoreCount, 1);

  scrollEl.dispatchEvent({ type: 'scroll' });
  stabilizeFrame();

  assert.equal(
    restoreCount,
    2,
    'the scroll event from the immediate anchor restore must preserve its next-frame stabilization',
  );
  assert.equal(
    context.canceledBrowserAnimationFrames.includes(stabilizeFrameId),
    false,
    'a matching programmatic anchor-restore event must not cancel its own stabilization frame',
  );
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 700;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
  };
  virtualGrid.restoreScrollAnchor = (anchor) => {
    scrollEl.scrollTop = Number(anchor?.scrollTop || 0);
  };
  virtualGrid.primeVisibleCoverImages = () => {};

  scrollEl.scrollTop = 6336;
  virtualGrid.stabilizeScrollAfterMeasurement({ scrollTop: 6336 });
  const staleStabilizeFrameId = virtualGrid._stabilizeRaf;
  const staleStabilizeFrame = scheduledFrames.get(staleStabilizeFrameId);
  assert.equal(typeof staleStabilizeFrame, 'function');

  scrollEl.scrollTop = 6888;
  scrollEl.dispatchEvent({ type: 'scroll' });
  staleStabilizeFrame();

  assert.equal(
    scrollEl.scrollTop,
    6888,
    'a delayed measurement anchor must not undo a newer user scroll',
  );
  assert.ok(
    context.canceledBrowserAnimationFrames.includes(staleStabilizeFrameId),
    'a newer scroll should cancel the pending measurement stabilization frame',
  );
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 800;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
    scheduledFrames.delete(frameId);
  };
  virtualGrid.restoreScrollAnchor = () => {
    scrollEl.scrollTop = 1694;
  };
  virtualGrid.primeVisibleCoverImages = () => {};

  scrollEl.scrollTop = 1694;
  assert.equal(
    virtualGrid.restoreOwnedAbsoluteScrollPosition({ scrollLeft: 0, scrollTop: 1147 }),
    true,
  );
  assert.equal(scrollEl.scrollTop, 1147);
  const terminalRestoreFrame = scheduledFrames.get(virtualGrid._scrollRestoreRaf);
  assert.equal(typeof terminalRestoreFrame, 'function');
  scrollEl.scrollTop = 1129;
  virtualGrid.onScroll();
  terminalRestoreFrame();
  assert.equal(
    scrollEl.scrollTop,
    1147,
    'a terminal mutation owner must correct a same-frame browser scroll-anchor adjustment',
  );
  scrollEl.scrollTop = 1129;
  virtualGrid.onScroll();
  assert.equal(
    scrollEl.scrollTop,
    1147,
    'a terminal mutation owner must correct a browser scroll-anchor adjustment after its scheduled frame',
  );
  virtualGrid.stabilizeScrollAfterMeasurement({ scrollTop: 1694 });
  const stabilizationFrame = scheduledFrames.get(virtualGrid._stabilizeRaf);
  assert.equal(typeof stabilizationFrame, 'function');
  stabilizationFrame();

  assert.equal(
    scrollEl.scrollTop,
    1147,
    'a terminal mutation owner must survive delayed virtual-grid measurement reconciliation',
  );
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 900;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };

  scrollEl.scrollTop = 7149;
  virtualGrid.onScroll();

  const renderFrameId = virtualGrid._raf;
  const renderFrame = scheduledFrames.get(renderFrameId);
  assert.equal(typeof renderFrame, 'function');
  const diagnostics = context.__ALBUM_HAVEN_VIRTUAL_GRID__;
  assert.equal(
    diagnostics.events.length,
    1,
    'one pending render RAF cycle must allocate only one scroll-history record',
  );
  for (let index = 0; index < 20; index += 1) {
    scrollEl.scrollTop = 7150 + index;
    virtualGrid.onScroll();
  }
  assert.equal(
    diagnostics.events.length,
    1,
    'coalesced raw scroll events must update latest state without allocating event-history records',
  );
  assert.equal(diagnostics.latestScroll.scrollTop, 7169);
  renderFrame();

  assert.ok(diagnostics, 'the production virtual grid should expose bounded read-only diagnostics');
  assert.ok(diagnostics.events.length <= diagnostics.maxEvents);
  assert.ok(diagnostics.events.some((event) => event.type === 'scroll-event'));
  assert.ok(diagnostics.events.some((event) => event.type === 'render-completed'));
  assert.equal(diagnostics.latestScroll.scrollTop, 7169);
  assert.equal(diagnostics.latestRender.viewportTop, 7169);
  assert.equal(diagnostics.latestRender.viewportBottom, 7809);
  assert.equal(diagnostics.latestRender.renderGeneration, virtualGrid._renderGeneration);
  assert.equal(diagnostics.latestRender.renderRafOwner, renderFrameId);
  assert.equal(diagnostics.latestRender.topSpacerHeight, 0);
  assert.equal(diagnostics.latestRender.bottomSpacerHeight, 0);

  for (let index = 0; index < diagnostics.maxEvents + 5; index += 1) {
    virtualGrid.recordDiagnosticEvent('bounded-probe', { index });
  }
  assert.equal(diagnostics.events.length, diagnostics.maxEvents);
  assert.equal(diagnostics.events.at(-1).index, diagnostics.maxEvents + 4);
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 950;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
  };

  scrollEl.scrollTop = 547;
  virtualGrid.onScroll();
  const pendingScrollFrameId = virtualGrid._raf;

  virtualGrid.setGroups(
    [{ artist: 'Hydrated Artist', artist_display: 'Hydrated Artist', albums: [] }],
    [],
    null,
    {
      absoluteScrollPosition: { scrollLeft: 0, scrollTop: 547 },
      preserveAbsoluteScroll: true,
      preserveScroll: true,
    },
  );

  const diagnostics = context.__ALBUM_HAVEN_VIRTUAL_GRID__;
  assert.ok(context.canceledBrowserAnimationFrames.includes(pendingScrollFrameId));
  assert.equal(diagnostics.latestScroll.scrollTop, 547);
  assert.equal(diagnostics.latestScroll.renderGeneration, virtualGrid._renderGeneration);
  assert.equal(diagnostics.latestScroll.renderRafOwner, pendingScrollFrameId);
  assert.equal(diagnostics.latestRender.viewportTop, 547);
  assert.equal(diagnostics.latestRender.renderGeneration, virtualGrid._renderGeneration);
  assert.equal(diagnostics.latestRender.renderRafOwner, pendingScrollFrameId);
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = new Map();
  let nextFrameId = 100;
  context.scheduleBrowserAnimationFrame = (callback) => {
    nextFrameId += 1;
    scheduledFrames.set(nextFrameId, callback);
    return nextFrameId;
  };
  context.cancelBrowserAnimationFrame = (frameId) => {
    context.canceledBrowserAnimationFrames.push(frameId);
  };
  virtualGrid.render = () => {};
  let primeCount = 0;
  virtualGrid.primeVisibleCoverImages = () => {
    primeCount += 1;
  };
  const firstGroups = [{ artist: 'First', artist_display: 'First', albums: [] }];
  const secondGroups = [{ artist: 'Second', artist_display: 'Second', albums: [] }];

  virtualGrid.setGroups(firstGroups, [], null, {});
  const firstGenerationFrameId = virtualGrid._scrollRestoreRaf;
  virtualGrid.setGroups(secondGroups, [], null, {});
  const secondGenerationFrameId = virtualGrid._scrollRestoreRaf;
  scrollEl.scrollTop = 777;

  scheduledFrames.get(firstGenerationFrameId)();
  assert.equal(scrollEl.scrollTop, 777, 'a stale setGroups frame must not reset the current generation scroll');
  assert.equal(primeCount, 2, 'a stale setGroups frame must not prime covers in the current generation');
  assert.ok(context.canceledBrowserAnimationFrames.includes(firstGenerationFrameId));

  scheduledFrames.get(secondGenerationFrameId)();
  assert.equal(scrollEl.scrollTop, 0);
  assert.equal(primeCount, 3, 'only the current generation frame may prime visible covers');
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  context.state.view.selected_artist = 'Family Relative';
  virtualGrid.render = () => {};
  virtualGrid.primeVisibleCoverImages = () => {};
  scrollEl.scrollTop = 842;

  virtualGrid.setGroups(
    [{ artist: 'Family Relative', artist_display: 'Family Relative', albums: [] }],
    [],
    null,
    {
      preserveScroll: true,
      resetScrollForUserArtistSelection: true,
    },
  );

  assert.equal(
    scrollEl.scrollTop,
    0,
    'an explicit user artist selection must override anchor preservation and show the new primary heading',
  );
  assert.equal(virtualGrid._resetScrollAfterMeasure, true);
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const events = [];
  const groups = [
    {
      artist: 'Root Artist',
      artist_display: 'Root Artist',
      albums: Array.from({ length: 4 }, (_value, index) => ({
        key: `root-${index + 1}`,
        name: `Root Album ${index + 1}`,
        album_artist: 'Root Artist',
        album_rating: 8,
        hasCover: true,
        tracks: [],
      })),
    },
  ];

  virtualGrid.setGroups(groups, [], null, {});
  assert.deepEqual(context.queuedTrackModalAlbumDetailPrewarms, []);
  assert.equal(context.queuedVisibleTrackModalAlbumDetailPrewarms, 0);

  context.queueTrackModalAlbumDetailsPrewarm = (albumKey) => {
    events.push(`prewarm:${albumKey}`);
    context.queuedTrackModalAlbumDetailPrewarms.push(albumKey);
  };
  context.state.view.selected_artist = 'Root Artist';
  virtualGrid.setGroups(groups, [], null, {});
  assert.deepEqual(context.queuedTrackModalAlbumDetailPrewarms, []);
  assert.equal(context.queuedVisibleTrackModalAlbumDetailPrewarms, 0);
  assert.deepEqual(events, [], 'rendering must not speculate album-detail requests without user intent');

  assert.equal(
    context.__scheduledBrowserTimeouts.some((entry) => entry.delay === 2000 || entry.delay === 700),
    false,
    'gallery covers must not use the retired delayed serial loader',
  );
}

/* Automatic render-time album-detail prewarming was intentionally removed.
{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const section = {
    kind: 'artist',
    top: 0,
    bottom: 600,
    blocksData: [{
      kind: 'row',
      albums: [{ key: 'selected-1' }, { key: 'selected-2' }],
    }],
    blockOffsets: [0],
    blockHeights: [600],
  };
  context.state.view.selected_artist = 'Neal Morse';
  context.galleryCoverLoadScheduler.diagnostics.active = 1;
  context.galleryCoverLoadScheduler.diagnostics.queuedNear = 1;
  virtualGrid.lastKey = 'range:selected';

  virtualGrid.prewarmVisibleAlbumDetails([section], 0, 600, 2, 'range:selected');
  const pendingCoverCallback = context.__scheduledBrowserTimeouts.at(-1);
  assert.equal(pendingCoverCallback.delay, 16);
  assert.deepEqual(
    context.queuedTrackModalAlbumDetailPrewarms,
    [],
    'selected-artist detail prewarming must not compete with the first visible cover',
  );
  pendingCoverCallback.callback();
  const readinessCallback = context.__scheduledBrowserTimeouts.at(-1);
  assert.notEqual(readinessCallback.id, pendingCoverCallback.id);
  assert.deepEqual(context.queuedTrackModalAlbumDetailPrewarms, []);

  readinessCallback.callback();
  assert.deepEqual(
    context.queuedTrackModalAlbumDetailPrewarms,
    [],
    'one decoded cover must not release detail requests while other foreground covers remain',
  );

  context.galleryCoverLoadScheduler.diagnostics.active = 0;
  context.galleryCoverLoadScheduler.diagnostics.queuedNear = 0;
  const foregroundIdleCallback = context.__scheduledBrowserTimeouts.at(-1);
  foregroundIdleCallback.callback();
  assert.deepEqual(
    context.queuedTrackModalAlbumDetailPrewarms,
    ['selected-1', 'selected-2'],
    'full foreground-cover idle should release selected-artist detail prewarming',
  );
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const section = {
    kind: 'artist',
    top: 0,
    bottom: 600,
    blocksData: [{
      kind: 'row',
      albums: Array.from({ length: 4 }, (_value, index) => ({ key: `root-${index + 1}` })),
    }],
    blockOffsets: [0],
    blockHeights: [600],
  };
  context.__albumTitleButtons = [
    context.createAlbumTitleButton('root-1', {
      top: 20, right: 220, bottom: 60, left: 20, width: 200, height: 40,
    }),
    context.createAlbumTitleButton('root-3', {
      top: 180, right: 700, bottom: 220, left: 500, width: 200, height: 40,
    }),
    context.createAlbumTitleButton('root-2', {
      top: 180, right: 460, bottom: 220, left: 260, width: 200, height: 40,
    }),
    context.createAlbumTitleButton('root-4', {
      top: 260, right: 220, bottom: 300, left: 20, width: 200, height: 40,
    }),
  ];
  scrollEl.getBoundingClientRect = () => ({
    top: 100, right: 980, bottom: 740, left: 0, width: 980, height: 640,
  });
  virtualGrid.lastKey = 'range:first';

  virtualGrid.prewarmVisibleAlbumDetails([section], 0, 600, 2, 'range:first');
  const firstCallback = context.__scheduledBrowserTimeouts.at(-1);
  assert.equal(firstCallback.delay, 200);
  assert.deepEqual(context.queuedTrackModalAlbumDetailPrewarms, [], 'root prewarming should be debounced');

  virtualGrid.lastKey = 'range:second';
  scrollEl.scrollTop = 20;
  virtualGrid.prewarmVisibleAlbumDetails([section], 20, 620, 2, 'range:second');
  const secondCallback = context.__scheduledBrowserTimeouts.at(-1);
  assert.notEqual(secondCallback.id, firstCallback.id);
  assert.ok(context.clearedBrowserTimeouts.includes(firstCallback.id), 'a new range should cancel stale work');

  firstCallback.callback();
  assert.deepEqual(context.queuedTrackModalAlbumDetailPrewarms, []);
  secondCallback.callback();
  assert.deepEqual(
    context.queuedTrackModalAlbumDetailPrewarms,
    ['root-3', 'root-2'],
    'root prewarming should use the first two intersecting rendered title buttons in DOM order',
  );
}

{
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const events = [];
  const section = {
    kind: 'artist',
    top: 0,
    bottom: 600,
    blocksData: [{
      kind: 'row',
      albums: [{ key: 'root-1' }, { key: 'root-2' }, { key: 'root-3' }],
    }],
    blockOffsets: [0],
    blockHeights: [600],
  };
  context.__albumTitleButtons = [
    context.createAlbumTitleButton('root-1', {
      top: 140, right: 220, bottom: 180, left: 20, width: 200, height: 40,
    }),
    context.createAlbumTitleButton('root-2', {
      top: 140, right: 460, bottom: 180, left: 260, width: 200, height: 40,
    }),
    context.createAlbumTitleButton('root-3', {
      top: 140, right: 700, bottom: 180, left: 500, width: 200, height: 40,
    }),
  ];
  scrollEl.getBoundingClientRect = () => ({
    top: 100, right: 980, bottom: 740, left: 0, width: 980, height: 640,
  });
  context.queueTrackModalAlbumDetailsPrewarm = (albumKey) => events.push(`prewarm:${albumKey}`);
  virtualGrid.lastKey = 'range:stable';

  virtualGrid.prewarmVisibleAlbumDetails([section], 0, 600, 2, 'range:stable');
  const staleDuplicate = context.__scheduledBrowserTimeouts.at(-1);
  virtualGrid.prewarmVisibleAlbumDetails([section], 0, 600, 2, 'range:stable');
  const currentCallback = context.__scheduledBrowserTimeouts.at(-1);
  staleDuplicate.callback();
  currentCallback.callback();
  assert.deepEqual(events, [
    'prewarm:root-1',
    'prewarm:root-2',
  ], 'repeated renders should keep one current detail-prewarm batch');
}
*/

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  context.state.view.artist_groups = [
    {
      artist: 'Neal Morse',
      artist_display: 'Neal Morse',
      albums: [
        {
          key: 'neal morse::one',
          pathSignature: 'X:\\SyntheticMusic\\Synthetic Artist\\One\\01 - Creation.mp3',
          name: 'One',
          album_artist: 'Neal Morse',
          album_rating: 10,
          tracks: [{ path: 'X:\\SyntheticMusic\\Synthetic Artist\\One\\01 - Creation.mp3', duration_seconds: 120 }],
          total_duration_seconds: 120,
        },
      ],
    },
  ];

  virtualGrid.setGroups([], [], null, {});

  assert.match(
    containerEl.innerHTML,
    /data-album-key="neal morse::one"/,
    'live album cards must keep the stable album key on tracklist triggers',
  );
  assert.equal(context.getIndexedAlbum('neal morse::one')?.name, 'One');
  assert.equal(
    context.getIndexedAlbum('X:\\SyntheticMusic\\Synthetic Artist\\One\\01 - Creation.mp3')?.name,
    'One',
  );
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const section = {
    sectionKey: 'artist:test',
    blockHeights: [420],
    blockMeasureKeys: ['row:3:alpha|beta|gamma'],
    measuredBlockKeys: ['row:3:alpha|beta|gamma'],
  };
  virtualGrid.sectionByKey = new Map([[section.sectionKey, section]]);
  const measuredRow = createMeasuredRow(section.sectionKey, 0, {
    cardHeights: [301, 318, 292],
    rowHeight: 318,
  });
  context.__rows = [measuredRow];
  virtualGrid.measureRenderedRows();
  assert.equal(measuredRow.cardMeasureCalls, 0);
  assert.equal(measuredRow.rowMeasureCalls, 0);
  assert.equal(section.blockHeights[0], 420);
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const section = {
    sectionKey: 'artist:test',
    blockHeights: [420],
    blockMeasureKeys: ['row:3:alpha|beta|gamma'],
    measuredBlockKeys: [''],
  };
  virtualGrid.sectionByKey = new Map([[section.sectionKey, section]]);
  const measuredRow = createMeasuredRow(section.sectionKey, 0, {
    cardHeights: [301, 318, 292],
    rowHeight: 318,
  });
  context.__rows = [measuredRow];
  virtualGrid.measureRenderedRows();
  assert.equal(measuredRow.cardMeasureCalls, 0);
  assert.equal(measuredRow.rowMeasureCalls, 1);
  assert.equal(section.blockHeights[0], 318);
  assert.equal(section.measuredBlockKeys[0], 'row:3:alpha|beta|gamma');
}

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const first = { key: 'artist:alpha', html: '<section class="artist-section alpha">Alpha</section>' };
  const second = { key: 'artist:beta', html: '<section class="artist-section beta">Beta</section>' };
  virtualGrid.patchRenderedSections([first, second]);
  const alphaNode = containerEl.children[0];
  const betaNode = containerEl.children[1];
  assert.equal(containerEl.children.length, 2);
  assert.equal(alphaNode.dataset.virtualSectionKey, 'artist:alpha');
  assert.equal(betaNode.dataset.virtualSectionKey, 'artist:beta');

  const secondUpdated = { key: 'artist:beta', html: '<section class="artist-section beta">Beta Updated</section>' };
  virtualGrid.patchRenderedSections([first, secondUpdated]);
  assert.equal(containerEl.children.length, 2);
  assert.equal(containerEl.children[0], alphaNode);
  assert.notEqual(containerEl.children[1], betaNode);
  assert.equal(containerEl.children[1].innerHTML, 'Beta Updated');
}

test('replacing a keyed artist section never transiently mounts both versions', () => {
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const original = {
    key: 'artist:merge-target',
    html: '<section class="artist-section">Original album card</section>',
  };
  virtualGrid.patchRenderedSections([original]);

  const mountedKeyCounts = [];
  const originalAppendChild = containerEl.appendChild;
  const originalRemoveChild = containerEl.removeChild;
  const recordMountedKeyCount = () => {
    mountedKeyCounts.push(containerEl.children.filter(
      (child) => child.dataset.virtualSectionKey === original.key,
    ).length);
  };
  containerEl.appendChild = function appendChildAndRecord(child) {
    const result = originalAppendChild.call(this, child);
    recordMountedKeyCount();
    return result;
  };
  containerEl.removeChild = function removeChildAndRecord(child) {
    const result = originalRemoveChild.call(this, child);
    recordMountedKeyCount();
    return result;
  };

  virtualGrid.patchRenderedSections([{
    ...original,
    html: '<section class="artist-section">Merged album card</section>',
  }]);

  assert.equal(
    Math.max(...mountedKeyCounts),
    1,
    'a section replacement must remove the obsolete keyed section before mounting its replacement',
  );
});

test('changed same-artist reconciliation retains an unrelated undecoded card as the scroll anchor', () => {
  const {
    context,
    containerEl,
    scrollEl,
  } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const albumCardSelector = '.album-card[data-gallery-card-key]';

  const makeCard = (key, renderKey, content = renderKey) => {
    const attributeValues = new Map([
      ['data-gallery-card-key', key],
      ['data-gallery-card-render-key', renderKey],
    ]);
    return {
      key,
      parentNode: null,
      childNodes: [content],
      get attributes() {
        return Array.from(attributeValues, ([name, value]) => ({ name, value }));
      },
      getAttribute(name) {
        return attributeValues.get(name) || '';
      },
      setAttribute(name, value) {
        attributeValues.set(name, String(value));
      },
      removeAttribute(name) {
        attributeValues.delete(name);
      },
      replaceChildren(...children) {
        this.childNodes = [...children];
      },
      querySelector() {
        return null;
      },
      replaceWith(replacement) {
        const parent = this.parentNode;
        const index = parent?.cards.indexOf(this) ?? -1;
        if (!parent || index < 0) return;
        const previousParent = replacement.parentNode;
        if (previousParent && previousParent !== parent) {
          const previousIndex = previousParent.cards.indexOf(replacement);
          if (previousIndex >= 0) previousParent.cards.splice(previousIndex, 1);
        }
        parent.cards[index] = replacement;
        parent.childNodes = [...parent.cards];
        replacement.parentNode = parent;
        this.parentNode = null;
      },
    };
  };
  const makeSection = (key, version, cards) => {
    const section = {
      cards: [...cards],
      childNodes: [...cards],
      dataset: { virtualSectionKey: key },
      innerHTML: version,
      parentNode: null,
      tagName: 'section',
      getAttribute(name) {
        return name === 'data-virtual-section-key' ? key : '';
      },
      isEqualNode(other) {
        return this.innerHTML === other?.innerHTML;
      },
      querySelectorAll(selector) {
        return selector === albumCardSelector ? this.cards : [];
      },
      replaceChildren(...children) {
        this.cards = [...children];
        this.childNodes = [...children];
        this.cards.forEach((card) => {
          card.parentNode = this;
        });
      },
      remove() {
        this.parentNode?.removeChild(this);
      },
    };
    section.cards.forEach((card) => {
      card.parentNode = section;
    });
    return section;
  };

  const originalContainerQuerySelectorAll = containerEl.querySelectorAll.bind(containerEl);
  containerEl.querySelectorAll = (selector) => (
    selector === albumCardSelector
      ? containerEl.children.flatMap((section) => section.cards || [])
      : originalContainerQuerySelectorAll(selector)
  );
  virtualGrid.createRenderedSectionNode = (record) => record.node;

  const editedOld = makeCard('album-a', 'render-a-old', 'old canonical content');
  const scrollAnchor = makeCard('album-b', 'render-b-stable');
  const removed = makeCard('album-c', 'render-c');
  const initialSection = makeSection(
    'artist:same',
    'initial',
    [editedOld, scrollAnchor, removed],
  );
  scrollEl.scrollTop = 420;

  virtualGrid.patchRenderedSections([{
    key: 'artist:same',
    html: 'initial',
    node: initialSection,
  }]);

  const editedNew = makeCard('album-a', 'render-a-new', 'new canonical content');
  const anchorTemplate = makeCard('album-b', 'render-b-stable');
  const inserted = makeCard('album-d', 'render-d');
  const canonicalSection = makeSection(
    'artist:same',
    'canonical',
    [editedNew, anchorTemplate, inserted],
  );

  virtualGrid.patchRenderedSections([{
    key: 'artist:same',
    html: 'canonical',
    node: canonicalSection,
  }], { preserveExistingChildren: true });

  const finalCards = containerEl.children[0].cards;
  assert.deepEqual(
    finalCards.map((card) => card.key),
    ['album-a', 'album-b', 'album-d'],
  );
  assert.strictEqual(
    finalCards[0],
    editedOld,
    'a canonical render-key change must patch the stable album card Element in place',
  );
  assert.equal(finalCards[0].getAttribute('data-gallery-card-render-key'), 'render-a-new');
  assert.deepEqual(finalCards[0].childNodes, ['new canonical content']);
  assert.notStrictEqual(finalCards[0], editedNew);
  assert.equal(finalCards.includes(removed), false);
  assert.strictEqual(finalCards[2], inserted);
  assert.strictEqual(
    finalCards[1],
    scrollAnchor,
    'the unrelated undecoded card Element must remain the mounted scroll anchor',
  );
  assert.notStrictEqual(finalCards[1], anchorTemplate);
  assert.equal(scrollEl.scrollTop, 420);
});

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const originalPrimary = {
    key: 'artist:lead',
    html: '<section class="artist-section lead">Lead</section>',
  };
  const originalPartner = {
    key: 'family:partner',
    html: '<section class="artist-section partner">Partner</section>',
  };
  virtualGrid.patchRenderedSections([originalPrimary, originalPartner]);
  const primaryNode = containerEl.children[0];
  const partnerNode = containerEl.children[1];

  const promotedPartner = {
    key: 'artist:partner',
    html: '<section class="artist-section partner primary">Partner Primary</section>',
  };
  const demotedLead = {
    key: 'family:lead',
    html: '<section class="artist-section lead family">Lead Family</section>',
  };
  virtualGrid.patchRenderedSections([promotedPartner, demotedLead], {
    preserveExistingChildren: true,
  });

  assert.equal(containerEl.children.length, 2);
  assert.equal(containerEl.children[0], primaryNode);
  assert.equal(containerEl.children[1], partnerNode);
  assert.equal(primaryNode.dataset.virtualSectionKey, 'artist:partner');
  assert.equal(primaryNode.innerHTML, 'Partner Primary');
  assert.doesNotMatch(primaryNode.innerHTML, /<section\b/i);
  assert.equal(partnerNode.dataset.virtualSectionKey, 'family:lead');
  assert.equal(partnerNode.innerHTML, 'Lead Family');
  assert.doesNotMatch(partnerNode.innerHTML, /<section\b/i);

  virtualGrid._renderGeneration = 12;
  virtualGrid._preserveExistingChildrenGeneration = 12;
  const measuredPartner = {
    ...promotedPartner,
    html: '<section class="artist-section partner primary">Partner Primary Measured</section>',
  };
  virtualGrid.patchRenderedSections([measuredPartner, demotedLead]);

  assert.equal(
    containerEl.children[0],
    primaryNode,
    'a later measurement render in the preserved generation must keep the mounted section',
  );
  assert.equal(primaryNode.innerHTML, 'Partner Primary Measured');

  virtualGrid._renderGeneration = 13;
  const ordinaryPartner = {
    ...measuredPartner,
    html: '<section class="artist-section partner primary">Ordinary Replacement</section>',
  };
  virtualGrid.patchRenderedSections([ordinaryPartner, demotedLead]);
  assert.notEqual(
    containerEl.children[0],
    primaryNode,
    'the preservation contract must not leak into a later render generation',
  );
}

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const album = (artist, name, index) => ({
    album_artist: artist,
    key: `${artist}-${index}`,
    name,
    tracks: [],
  });
  const partnerAlbums = Array.from(
    { length: 10 },
    (_value, index) => album('Control Signal Partner', `Partner ${index + 1}`, index),
  );
  const leadAlbums = Array.from(
    { length: 10 },
    (_value, index) => album(
      'Control Signal Lead',
      index === 9 ? 'Control Lead Solo' : `Lead ${index + 1}`,
      index,
    ),
  );
  const ownerAlbums = [album(
    'Control Signal Lead / Control Signal Partner',
    'Non-Compilation Cross-Credits',
    0,
  )];

  context.state.view.selected_artist = 'Control Signal Partner';
  virtualGrid.setGroups(
    [{
      artist: 'Control Signal Partner',
      artist_display: 'Control Signal Partner',
      albums: partnerAlbums,
    }],
    [{
      artist: 'Control Signal Lead',
      artist_display: 'Control Signal Lead',
      albums: leadAlbums,
    }, {
      artist: 'Control Signal Lead / Control Signal Partner',
      artist_display: 'Control Signal Lead / Control Signal Partner',
      albums: ownerAlbums,
    }],
    null,
    {},
    context.CARD_GALLERY_LAYOUT_CONFIG,
  );

  const initialChildren = [...containerEl.children];
  const initialPartnerSection = initialChildren.find((node) => (
    node.innerHTML.includes('<h2 class="artist-name">Control Signal Partner</h2>')
  ));
  assert.ok(initialPartnerSection, 'the selected primary family member must be attached');
  assert.match(
    initialPartnerSection.innerHTML,
    /class="[^"]*album-title-button[^"]*"[^>]*>Partner 1<\/button>/,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      virtualGrid.sections
        .filter((section) => section.kind === 'artist')
        .map((section) => section.group.artist),
    )),
    [
      'Control Signal Partner',
      'Control Signal Lead',
      'Control Signal Lead / Control Signal Partner',
    ],
    'local promotion keeps complete family data even when offscreen sections are not mounted',
  );
  assert.doesNotMatch(
    containerEl.innerHTML,
    /Control Lead Solo/,
    'offscreen family albums must remain virtualized',
  );

  context.state.view.selected_artist = 'Control Signal Lead';
  virtualGrid.setGroups(
    [{
      artist: 'Control Signal Lead',
      artist_display: 'Control Signal Lead',
      albums: leadAlbums,
    }],
    [{
      artist: 'Control Signal Partner',
      artist_display: 'Control Signal Partner',
      albums: partnerAlbums,
    }, {
      artist: 'Control Signal Lead / Control Signal Partner',
      artist_display: 'Control Signal Lead / Control Signal Partner',
      albums: ownerAlbums,
    }],
    null,
    {
      preserveMountedGalleryChildren: true,
    },
    context.CARD_GALLERY_LAYOUT_CONFIG,
  );

  assert.equal(containerEl.children.length, initialChildren.length);
  containerEl.children.forEach((child, index) => {
    assert.equal(child, initialChildren[index]);
  });
  const promotedLeadSection = containerEl.children.find((node) => (
    node.innerHTML.includes('<h2 class="artist-name">Control Signal Lead</h2>')
  ));
  assert.ok(promotedLeadSection);
  assert.match(
    promotedLeadSection.innerHTML,
    /class="[^"]*album-title-button[^"]*"[^>]*>Lead 1<\/button>/,
  );
  const retainedLead = virtualGrid.sections.find((section) => (
    section.kind === 'artist'
    && section.group.artist === 'Control Signal Lead'
  ));
  assert.equal(retainedLead.group.albums.at(-1).name, 'Control Lead Solo');
  const retainedPartner = virtualGrid.sections.find((section) => (
    section.kind === 'artist'
    && section.group.artist === 'Control Signal Partner'
  ));
  assert.ok(retainedPartner);
  assert.equal(
    retainedPartner.group.albums.at(-1).name,
    'Partner 10',
    'the demoted offscreen member remains available for virtualized scrolling',
  );
}

{
  const { context, containerEl, topSpacerEl, bottomSpacerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  context.state.view.primary_artist_groups = [
    {
      artist: 'Rendered Artist',
      artist_display: 'Rendered Artist',
      albums: [
        {
          key: 'rendered-1',
          name: 'Rendered Album',
          album_artist: 'Rendered Artist',
          album_rating: 8,
          tracks: [{ duration_seconds: 180 }],
          total_duration_seconds: 180,
        },
      ],
    },
  ];
  virtualGrid.setGroups = () => {
    containerEl.children = [];
    containerEl.innerHTML = '';
  };
  context.renderArtistGroups();
  assert.match(containerEl.innerHTML, /Primary Artist/);
  assert.match(containerEl.innerHTML, /Rendered Artist/);
  assert.match(containerEl.innerHTML, /Rendered Album/);
  assert.equal(topSpacerEl.style.height, '0px');
  assert.equal(bottomSpacerEl.style.height, '0px');
  assert.equal(context.getIndexedAlbum('rendered-1')?.name, 'Rendered Album');
}

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  context.state.view.selected_artist = 'Mono';
  context.state.view.selected_artist_family_display_mode = 'chronological';
  context.state.view.primary_artist_groups = [
    {
      artist: 'Mono',
      artist_display: 'Mono',
      albums: [{ key: 'mono-1', name: 'Hymn to the Immortal Wind', album_artist: 'Mono', tracks: [] }],
    },
  ];
  context.state.view.family_artist_groups = [
    {
      artist: 'World\'s End Girlfriend',
      artist_display: 'World\'s End Girlfriend',
      albums: [{ key: 'weg-1', name: 'Palmless Prayer / Mass Murder Refrain', album_artist: 'World\'s End Girlfriend', tracks: [] }],
    },
  ];
  context.state.view.artist_groups = [
    {
      artist: 'Chronological',
      artist_display: 'Chronological',
      albums: [
        { key: 'weg-1', name: 'Palmless Prayer / Mass Murder Refrain', album_artist: 'World\'s End Girlfriend', tracks: [] },
        { key: 'mono-1', name: 'Hymn to the Immortal Wind', album_artist: 'Mono', tracks: [] },
      ],
    },
  ];
  virtualGrid.setGroups = () => {
    containerEl.children = [];
    containerEl.innerHTML = '';
  };

  context.renderArtistGroups();

  assert.doesNotMatch(containerEl.innerHTML, /Primary Artist/);
  assert.doesNotMatch(containerEl.innerHTML, /Family/);
  assert.match(containerEl.innerHTML, /Chronological/);
  assert.match(containerEl.innerHTML, /Palmless Prayer \/ Mass Murder Refrain/);
  assert.match(containerEl.innerHTML, /Hymn to the Immortal Wind/);
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  let receivedLayoutConfig = null;
  let receivedOptions = null;
  virtualGrid.setGroups = (...args) => {
    receivedOptions = args[3];
    receivedLayoutConfig = args[4];
  };
  context.state.view.gallery_display_mode = 'list';
  context.state.view.primary_artist_groups = [
    {
      artist: 'Renderer Carrier',
      artist_display: 'Renderer Carrier',
      albums: [{ key: 'renderer-carrier-1', name: 'Shared Layout', album_artist: 'Renderer Carrier', tracks: [] }],
    },
  ];

  context.renderArtistGroups({ preserveScroll: true });

  assert.deepEqual(JSON.parse(JSON.stringify(receivedOptions)), { preserveScroll: true });
  assert.equal(receivedLayoutConfig, context.CARD_GALLERY_LAYOUT_CONFIG);
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const receivedOptions = [];
  virtualGrid.setGroups = (...args) => {
    receivedOptions.push(args[3]);
  };
  context.state.view.query = '';
  context.state.view.payload_tier = 'full';
  context.state.view.initial_view_partial = false;
  context.state.view.selected_artist = 'Control Signal Partner';
  context.state.view.primary_artist_groups = [{
    artist: 'Control Signal Partner',
    albums: [{ key: 'partner-1', name: 'Partner 1', tracks: [] }],
  }];
  context.state.view.family_artist_groups = [{
    artist: 'Control Signal Lead',
    albums: [{ key: 'lead-1', name: 'Control Lead Solo', tracks: [] }],
  }];

  context.renderArtistGroups({ preserveScroll: true });
  assert.deepEqual(
    JSON.parse(JSON.stringify(receivedOptions[0])),
    { preserveScroll: true },
  );

  context.state.view.initial_view_partial = true;
  context.renderArtistGroups({ preserveScroll: true });
  assert.deepEqual(
    JSON.parse(JSON.stringify(receivedOptions[1])),
    { preserveScroll: true },
  );
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  context.state.view.selected_artist = 'БИ-2';

  virtualGrid.setGroups(
    [
      {
        artist: 'БИ-2',
        artist_display: 'БИ-2',
        albums: [{ key: 'bi2-1', name: 'Аллилуйя', album_artist: 'БИ-2', tracks: [] }],
      },
    ],
    [],
    null,
    {},
    context.CARD_GALLERY_LAYOUT_CONFIG,
  );

  assert.equal(virtualGrid.bufferSectionsOverride, 0);

  virtualGrid.setGroups(
    [
      {
        artist: 'БИ-2',
        artist_display: 'БИ-2',
        albums: [{ key: 'bi2-1', name: 'Аллилуйя', album_artist: 'БИ-2', tracks: [] }],
      },
    ],
    [],
    null,
    { preserveScroll: true },
    context.CARD_GALLERY_LAYOUT_CONFIG,
  );

  assert.equal(virtualGrid.bufferSectionsOverride, null);
}

{
  const { context } = createRuntimeContext();
  vm.runInContext('albumHasDisplayCover = () => true;', context);
  const visibleCoverHtml = vm.runInContext(
    'buildAlbumCardCoverHtml({ key: "bi2-1", name: "Иномарки", album_artist: "БИ-2", cover_path: "covers/1.jpg", tracks: [] }, { coverPriority: "visible" })',
    context,
  );
  const nearCoverHtml = vm.runInContext(
    'buildAlbumCardCoverHtml({ key: "bi2-2", name: "Горизонт событий", album_artist: "БИ-2", cover_path: "covers/2.jpg", tracks: [] }, { coverPriority: "near" })',
    context,
  );

  assert.match(visibleCoverHtml, /loading="eager"/);
  assert.match(visibleCoverHtml, /fetchpriority="high"/);
  assert.match(visibleCoverHtml, /data-gallery-cover-priority="visible"/);
  assert.match(visibleCoverHtml, /data-cover-visual-state="pending"/);
  assert.match(visibleCoverHtml, /aria-hidden="true"/);
  assert.match(visibleCoverHtml, /onload="handleAlbumDisplayCoverImageLoad\(this\)"/);
  assert.match(nearCoverHtml, /loading="lazy"/);
  assert.match(nearCoverHtml, /data-gallery-cover-priority="near"/);
  assert.match(nearCoverHtml, /data-gallery-cover-src="/);
  assert.match(
    galleryCssSource,
    /\.album-card \.cover img\[data-cover-visual-state="pending"\] \{ visibility: hidden; \}/,
  );
  assert.match(
    galleryCssSource,
    /\.album-card \.cover img\[data-cover-visual-state="ready"\] \{ visibility: visible; \}/,
  );
}

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const albums = Array.from({ length: 6 }, (_value, index) => ({
    key: `all-artists-${index}`,
    name: `All Artists Album ${index}`,
    album_artist: `Artist ${index}`,
    album_rating: 8,
    hasCover: true,
    tracks: [],
  }));

  virtualGrid.setGroups(
    [{
      artist: 'All artists',
      artist_display: 'All artists',
      albums,
    }],
    [],
    null,
    {},
    context.CARD_GALLERY_LAYOUT_CONFIG,
  );

  assert.equal(
    (containerEl.innerHTML.match(/<img /g) || []).length,
    6,
    'every on-screen All Artists cover should enter the foreground scheduler immediately',
  );
  assert.equal((containerEl.innerHTML.match(/loading="eager"/g) || []).length, 6);
  assert.equal(context.galleryCoverFamilyPrefetchEnsures, 0);
  assert.equal((containerEl.innerHTML.match(/fetchpriority="high"/g) || []).length, 6);
  assert.doesNotMatch(containerEl.innerHTML, /data-deferred-cover-src=/);
}

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  context.state.view.selected_artist = 'Neal Morse';
  const albums = Array.from({ length: 7 }, (_value, index) => ({
    key: `neal-${index}`,
    name: `Neal Album ${index}`,
    album_artist: 'Neal Morse',
    album_rating: 8,
    hasCover: true,
    tracks: [],
  }));

  virtualGrid.setGroups(
    [
      {
        artist: 'Neal Morse',
        artist_display: 'Neal Morse',
        albums,
      },
    ],
    [],
    null,
    {},
    context.CARD_GALLERY_LAYOUT_CONFIG,
  );

  assert.equal((containerEl.innerHTML.match(/loading="eager"/g) || []).length, 6);
  assert.equal(context.galleryCoverFamilyPrefetchEnsures, 1);
  assert.equal(context.galleryCoverFamilyPrefetchReconciliations.length, 1);
  assert.equal(
    context.galleryCoverFamilyPrefetchReconciliations[0].productionUrls.length,
    7,
    'selected-family browsing must reconcile every family cover for cache-only background prefetch',
  );
  assert.equal(
    context.galleryCoverFamilyPrefetchReconciliations[0].generation,
    virtualGrid._coverLoadGeneration,
  );
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  context.state.view.selected_artist = 'Neal Morse';
  const group = (artist, names) => ({
    artist,
    artist_display: artist,
    albums: names.map((name) => ({
      key: `${artist}:${name}`,
      name,
      album_artist: artist,
      hasCover: true,
      tracks: [],
    })),
  });
  const primary = [group('Neal Morse', ['Joseph'])];
  const fullFamily = [
    group('Transatlantic', ['Bridge Across Forever']),
    group('Flying Colors', ['Second Nature']),
  ];

  virtualGrid.setGroups(primary, fullFamily, null, {});
  context.state.view.related_filter_artists = ['Transatlantic'];
  virtualGrid.setGroups([], [fullFamily[0]], null, { preserveScroll: true });

  assert.equal(context.galleryCoverFamilyPrefetchReconciliations.length, 2);
  assert.deepEqual(
    [...context.galleryCoverFamilyPrefetchReconciliations[1].productionUrls].sort(),
    [
      '/covers/Bridge%20Across%20Forever',
      '/covers/Joseph',
      '/covers/Second%20Nature',
    ],
    'an early family-chip filter must not shrink the selected-family background prefetch universe',
  );
  context.state.view.related_filter_artists = [];
  virtualGrid.setGroups(primary, [fullFamily[0]], null, { preserveScroll: true });
  assert.deepEqual(
    [...context.galleryCoverFamilyPrefetchReconciliations[2].productionUrls].sort(),
    ['/covers/Bridge%20Across%20Forever', '/covers/Joseph'],
    'an authoritative unfiltered refresh must replace stale selected-family URLs',
  );
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const activeImage = vm.runInContext('new HTMLImageElement()', context);
  context.state.view.selected_artist = 'Neal Morse';
  context.__rows = [activeImage];

  virtualGrid.onPointerDown({
    target: {
      closest(selector) {
        assert.equal(selector, '[data-open-tracklist="1"][data-album-key], .album-card');
        return { dataset: { albumKey: 'neal morse::neal morse' } };
      },
    },
  });

  assert.equal(activeImage.getAttribute('src'), '/cover?path=old');
  assert.equal(activeImage.getAttribute('srcset'), '/cover?path=old 1x');
  assert.equal(activeImage.getAttribute('loading'), 'eager');
  assert.equal(activeImage.getAttribute('fetchpriority'), 'high');
}

test('selected primary section remains mounted while browsing related family sections', () => {
  const { context, containerEl, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const albums = (artist, count) => Array.from({ length: count }, (_value, index) => ({
    album_artist: artist,
    key: `${artist}-${index}`,
    name: `${artist} ${index + 1}`,
    tracks: [],
  }));

  context.state.view.selected_artist = 'Selected Artist';
  virtualGrid.setGroups(
    [{ artist: 'Selected Artist', albums: albums('Selected Artist', 10) }],
    [
      { artist: 'Family One', albums: albums('Family One', 10) },
      { artist: 'Family Two', albums: albums('Family Two', 10) },
    ],
    null,
    {},
    context.CARD_GALLERY_LAYOUT_CONFIG,
  );

  scrollEl.scrollTop = Math.max(0, virtualGrid.totalHeight - scrollEl.clientHeight);
  virtualGrid.render(true);

  assert.match(containerEl.innerHTML, /<h2 class="artist-name">Selected Artist<\/h2>/);
  assert.match(containerEl.innerHTML, /<h2 class="artist-name">Family Two<\/h2>/);
});

test('deferred pointer render retains the scroll frame owner across a render generation change', () => {
  const { context, scrollEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const scheduledFrames = [];
  context.scheduleBrowserAnimationFrame = (callback) => {
    scheduledFrames.push(callback);
    return scheduledFrames.length;
  };
  context.cancelBrowserAnimationFrame = () => {};
  virtualGrid.scheduleMeasureRows = () => {};
  virtualGrid.sections = [];
  virtualGrid.totalHeight = 0;

  virtualGrid.onPointerDown({
    pointerId: 91,
    target: {
      closest() {
        return { dataset: { albumKey: 'ddt::studio-recordings' } };
      },
    },
  });
  scrollEl.scrollTop = 240;
  virtualGrid.onScroll();
  const scrollFrameOwner = virtualGrid.diagnostics.latestScroll.renderRafOwner;
  scheduledFrames.shift()();
  virtualGrid._renderGeneration += 1;

  context.document.dispatchEvent({ type: 'pointerup', pointerId: 91 });
  scheduledFrames.shift()();

  assert.equal(virtualGrid.diagnostics.latestRender.renderRafOwner, scrollFrameOwner);
});

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  let patchCount = 0;
  virtualGrid.patchRenderedSections = () => {
    patchCount += 1;
  };
  virtualGrid.scheduleMeasureRows = () => {};
  virtualGrid.sections = [];
  virtualGrid.totalHeight = 0;

  virtualGrid.onPointerDown({
    pointerId: 41,
    target: {
      closest(selector) {
        assert.equal(selector, '[data-open-tracklist="1"][data-album-key], .album-card');
        return { dataset: { albumKey: 'neal morse::joseph' } };
      },
    },
  });
  virtualGrid.render(true, { preserveExistingChildren: true });
  virtualGrid.render(false);

  assert.equal(patchCount, 0, 'mounted gallery DOM must remain stable during the active pointer gesture');
  const scheduledGestureFrames = [];
  context.scheduleBrowserAnimationFrame = (callback) => {
    scheduledGestureFrames.push(callback);
    return scheduledGestureFrames.length;
  };
  context.document.dispatchEvent({ type: 'pointerup', pointerId: 41 });
  assert.equal(patchCount, 0, 'pointerup must not patch the target before the browser dispatches click');
  scheduledGestureFrames.shift()();
  assert.equal(patchCount, 1, 'the latest deferred render must flush once when the pointer gesture ends');

  virtualGrid.onPointerDown({
    pointerId: 42,
    target: {
      closest() {
        return { dataset: { albumKey: 'neal morse::joseph' } };
      },
    },
  });
  virtualGrid.render(true);
  context.document.dispatchEvent({ type: 'pointercancel', pointerId: 42 });
  scheduledGestureFrames.shift()();
  assert.equal(patchCount, 2, 'pointer cancellation must release and flush the gesture guard');

  virtualGrid.destroy();
  assert.equal(context.__documentListeners.get('pointerup')?.length || 0, 0);
  assert.equal(context.__documentListeners.get('pointercancel')?.length || 0, 0);
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const snowWhiteIdentity = 'snow-white-and-the-seven-dwarfs';
  const sectionKeys = [
    'artist:all:Frank Churchill:8',
    'artist:all:Frank Churchill / Leigh Harline / Larry Morey:9',
    'artist:all:Frank Churchill / Leigh Harline / Larry Morey / Frank Churchill / Larry Morey:10',
    'artist:all:Larry Morey:11',
    'artist:all:Leigh Harline:12',
  ];
  const makeSection = (sectionKey) => ({
    dataset: { virtualSectionKey: sectionKey },
    getAttribute(name) {
      return name === 'data-virtual-section-key' ? sectionKey : '';
    },
  });
  const makeCard = (section, index, decoded = true) => {
    const image = new context.HTMLImageElement();
    image.complete = decoded;
    image.naturalWidth = decoded ? 480 : 0;
    return {
      index,
      getAttribute(name) {
        if (name === 'data-gallery-card-key') return snowWhiteIdentity;
        if (name === 'data-gallery-card-render-key') return 'same-snow-white-render';
        return '';
      },
      closest(selector) {
        assert.equal(selector, '[data-virtual-section-key]');
        return section;
      },
      querySelector(selector) {
        return selector === '.cover img' || selector === 'img[data-production-cover-src]'
          ? image
          : null;
      },
    };
  };
  const retainedSections = sectionKeys.map(makeSection);
  const retainedCards = retainedSections.map((section, index) => makeCard(section, index));

  virtualGrid.rememberRenderedAlbumCards({
    querySelectorAll(selector) {
      assert.equal(selector, '.album-card[data-gallery-card-key]');
      return retainedCards;
    },
  });

  assert.equal(
    virtualGrid.albumCardNodeCache.size,
    retainedCards.length,
    'the same album rendered under five artist headings must retain five section-owned nodes',
  );

  const replacements = [];
  retainedSections.forEach((section, index) => {
    const nextCard = makeCard(section, index, false);
    nextCard.replaceWith = (node) => replacements.push(node);
    virtualGrid.reuseRenderedAlbumCards({
      dataset: section.dataset,
      getAttribute: section.getAttribute,
      querySelectorAll() { return [nextCard]; },
    });
  });

  assert.deepEqual(
    replacements,
    retainedCards,
    'virtual reconciliation must not move one album-card node through repeated artist-section occurrences',
  );

  const measuredSections = sectionKeys.map((sectionKey) => ({
    sectionKey: sectionKey.replace(/^artist:/, ''),
    blockHeights: [420],
    blockMeasureKeys: ['row:4:snow-white'],
    measuredBlockKeys: [''],
  }));
  virtualGrid.sectionByKey = new Map(measuredSections.map((section) => [section.sectionKey, section]));
  context.__rows = measuredSections.map((section) => createMeasuredRow(section.sectionKey, 0, { rowHeight: 439 }));
  virtualGrid.measureRenderedRows();
  assert.deepEqual(
    measuredSections.map((section) => section.blockHeights[0]),
    [439, 439, 439, 439, 439],
    'each repeated section row must remain measurable instead of collapsing after node reuse',
  );
}

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const buildAlbums = (artist, prefix) => Array.from({ length: 120 }, (_value, index) => ({
    album_artist: artist,
    cover_path: `covers/${prefix}-${index}.jpg`,
    hasCover: true,
    key: `${prefix}-${index}`,
    name: `${prefix} Album ${index + 1}`,
    tracks: [],
  }));
  const primaryAlbums = buildAlbums('Large Family Lead', 'lead');
  const familyAlbums = buildAlbums('Large Family Partner', 'partner');
  context.state.view.query = '';
  context.state.view.payload_tier = 'full';
  context.state.view.initial_view_partial = false;
  context.state.view.selected_artist = 'Large Family Lead';
  context.state.view.primary_artist_groups = [{
    artist: 'Large Family Lead',
    artist_display: 'Large Family Lead',
    albums: primaryAlbums,
  }];
  context.state.view.family_artist_groups = [{
    artist: 'Large Family Partner',
    artist_display: 'Large Family Partner',
    albums: familyAlbums,
  }];

  context.renderArtistGroups();

  const retainedAlbumCount = virtualGrid.sections
    .filter((section) => section.kind === 'artist')
    .reduce((count, section) => count + section.group.albums.length, 0);
  const mountedAlbumCount = (
    containerEl.innerHTML.match(/data-gallery-card-key=/g) || []
  ).length;
  assert.equal(retainedAlbumCount, primaryAlbums.length + familyAlbums.length);
  assert.ok(
    mountedAlbumCount < retainedAlbumCount,
    `expected viewport virtualization to mount fewer than ${retainedAlbumCount} albums; mounted ${mountedAlbumCount}`,
  );
  assert.ok(
    virtualGrid.diagnostics.latestRender.sections.every((section) => (
      section.firstBlockIndex === null
      || section.lastBlockIndex < 119
    )),
    'the initial viewport must not queue every row block in a large complete family',
  );
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const retainedImage = new context.HTMLImageElement();
  retainedImage.complete = true;
  retainedImage.naturalWidth = 480;
  retainedImage.setAttribute(
    'data-production-cover-src',
    'http://127.0.0.1:4173/cover?path=joseph&size=480&v=initial',
  );
  context.galleryCoverPreviewCache = {
    hasActive(productionUrl) {
      assert.match(productionUrl, /\/cover\?path=joseph/);
      return false;
    },
  };
  const retainedCard = {
    attributes: {
      'data-gallery-card-key': 'neal::joseph-2023',
      'data-gallery-card-render-key': 'same-cover-and-metadata',
    },
    getAttribute(name) { return this.attributes[name] || ''; },
    querySelector(selector) {
      if (selector !== '.cover img' && selector !== 'img[data-production-cover-src]') return null;
      return retainedImage;
    },
  };
  let replacement = null;
  const nextCard = {
    attributes: {
      'data-gallery-card-key': 'neal::joseph-2023',
      'data-gallery-card-render-key': 'same-cover-and-metadata',
    },
    getAttribute(name) { return this.attributes[name] || ''; },
    replaceWith(node) { replacement = node; },
  };
  virtualGrid.rememberRenderedAlbumCards({
    querySelectorAll(selector) {
      assert.equal(selector, '.album-card[data-gallery-card-key]');
      return [retainedCard];
    },
  });
  virtualGrid.reuseRenderedAlbumCards({
    querySelectorAll(selector) {
      assert.equal(selector, '.album-card[data-gallery-card-key]');
      return [nextCard];
    },
  });

  assert.equal(replacement, retainedCard, 'the decoded card node should survive regrouping and virtual-row reconciliation');
  assert.match(
    retainedImage.getAttribute('data-gallery-cover-src'),
    /\/cover\?path=joseph/,
    'a retained node whose blob was evicted must rehydrate from the production cache key',
  );
}

{
  const { context } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const cards = Array.from({ length: 60 }, (_value, index) => ({
    getAttribute(name) {
      return name === 'data-gallery-card-key' ? `decoded-${index}` : 'same-render';
    },
    querySelector(selector) {
      if (selector !== '.cover img') return null;
      const image = new context.HTMLImageElement();
      image.complete = true;
      image.naturalWidth = 480;
      return image;
    },
  }));
  virtualGrid.rememberRenderedAlbumCards({ querySelectorAll() { return cards; } });
  assert.equal(virtualGrid.albumCardNodeCache.size, 48, 'decoded detached-card retention must stay bounded');
  assert.equal(virtualGrid.albumCardNodeCache.has('decoded-0'), false, 'the oldest decoded card should be evicted first');

  const inFlightImage = new context.HTMLImageElement();
  inFlightImage.complete = false;
  inFlightImage.naturalWidth = 0;
  inFlightImage.setAttribute('data-cover-visual-state', 'pending');
  inFlightImage.setAttribute('data-gallery-cover-loading', '1');
  inFlightImage.setAttribute('data-production-cover-src', '/cover?path=in-flight');
  const inFlightCard = {
    getAttribute(name) { return name === 'data-gallery-card-key' ? 'in-flight' : 'same-render'; },
    querySelector(selector) {
      return selector === '.cover img' || selector === 'img[data-production-cover-src]'
        ? inFlightImage
        : null;
    },
  };
  virtualGrid.rememberRenderedAlbumCards({ querySelectorAll() { return [inFlightCard]; } });
  assert.equal(
    virtualGrid.albumCardNodeCache.has('in-flight'),
    true,
    'same-render pending cards must survive measurement reconciliation without a detached duplicate request',
  );
  let pendingReplacement = null;
  context.galleryCoverPreviewCache = {
    hasActive() {
      throw new Error('pending retained requests must rearm without decoded object-URL lookup');
    },
  };
  virtualGrid._coverLoadGeneration += 1;
  virtualGrid.reuseRenderedAlbumCards({
    querySelectorAll() {
      return [{
        getAttribute(name) { return name === 'data-gallery-card-key' ? 'in-flight' : 'same-render'; },
        replaceWith(node) { pendingReplacement = node; },
      }];
    },
  });
  assert.equal(pendingReplacement, inFlightCard);
  assert.equal(inFlightImage.getAttribute('data-gallery-cover-src'), '/cover?path=in-flight');
  assert.equal(inFlightImage.getAttribute('data-gallery-cover-loading'), '');

  const enqueueCountBeforeActivation = context.galleryCoverSchedulerEnqueues.length;
  const retainedRoot = {
    querySelectorAll(selector) {
      assert.equal(selector, 'img[data-gallery-cover-src]');
      return inFlightImage.getAttribute('data-gallery-cover-src') ? [inFlightImage] : [];
    },
  };
  virtualGrid.activateGalleryCoverImages(retainedRoot);
  virtualGrid.activateGalleryCoverImages(retainedRoot);
  const retainedEnqueues = context.galleryCoverSchedulerEnqueues.slice(enqueueCountBeforeActivation);
  assert.equal(retainedEnqueues.length, 1, 'activation must attach one fresh request token, not loop reenqueue');
  assert.equal(retainedEnqueues[0].productionUrl, '/cover?path=in-flight');
  assert.equal(retainedEnqueues[0].generation, virtualGrid._coverLoadGeneration);
  assert.equal(retainedEnqueues[0].image, inFlightImage);
  assert.equal(inFlightImage.getAttribute('data-gallery-cover-src'), '');
  assert.equal(inFlightImage.getAttribute('data-gallery-cover-loading'), '1');

  inFlightImage.complete = true;
  inFlightImage.naturalWidth = 480;
  inFlightImage.setAttribute('data-cover-visual-state', 'ready');
  virtualGrid.rememberRenderedAlbumCards({ querySelectorAll() { return [inFlightCard]; } });
  assert.equal(virtualGrid.albumCardNodeCache.has('in-flight'), true, 'the reattached image may settle decoded');

  virtualGrid.destroy();
  assert.equal(virtualGrid.albumCardNodeCache.size, 0, 'destroy must release every retained card node');
}

{
  const { context } = createRuntimeContext();
  const markup = context.albumCardHtml({
    key: 'stable-album-key',
    pathSignature: 'payload-dependent-track-paths',
    name: 'Joseph: Part One - The Dreamer',
    album_artist: 'Neal Morse',
    album_rating: 8,
    hasCover: true,
    tracks: [],
  });

  assert.match(markup, /data-gallery-card-key="stable-album-key"/);
  assert.doesNotMatch(markup, /data-gallery-card-key="payload-dependent-track-paths"/);

  const baseAlbum = {
    key: 'stable-album-key',
    name: 'Joseph: Part One - The Dreamer',
    album_artist: 'Neal Morse',
    cover_path: 'X:/SyntheticMusic/Synthetic Artist/Synthetic Album/cover-original.jpg',
    hasCover: true,
    tracks: [],
  };
  const eagerKey = context.getAlbumCardRenderKey(baseAlbum, { coverPriority: 'visible' });
  const deferredKey = context.getAlbumCardRenderKey(baseAlbum, { coverPriority: 'near' });
  const remoteChangedKey = context.getAlbumCardRenderKey({
    ...baseAlbum,
    remote_cover_thumbnail_url: 'https://covers.example/joseph-new.jpg',
  });
  const editionChangedKey = context.getAlbumCardRenderKey({
    ...baseAlbum,
    edition: 'Deluxe Edition',
  });
  assert.equal(eagerKey, deferredKey, 'viewport scheduling hints must not replace an already-decoded semantic card');
  assert.notEqual(eagerKey, remoteChangedKey, 'remote fallback updates must invalidate retained local-cover cards');
  assert.notEqual(
    eagerKey,
    editionChangedKey,
    'edition changes must invalidate retained cards so their modal version identity stays current',
  );
  const persistedLocalPathChangedKey = context.getAlbumCardRenderKey({
    ...baseAlbum,
    cover_path: 'X:/SyntheticMusic/Synthetic Artist/Synthetic Album/cover-persisted-replacement.jpg',
  });
  assert.equal(
    context.buildAlbumDisplayCoverUrl(baseAlbum),
    context.buildAlbumDisplayCoverUrl({ ...baseAlbum, cover_path: 'X:/SyntheticMusic/Synthetic Artist/Synthetic Album/cover-persisted-replacement.jpg' }),
    'the optimistic display URL fixture intentionally stays unchanged',
  );
  assert.notEqual(
    eagerKey,
    persistedLocalPathChangedKey,
    'a persisted local cover path change must invalidate the retained card even when its optimistic display URL is unchanged',
  );
}

{
  const { context, containerEl } = createRuntimeContext();
  const virtualGrid = vm.runInContext('virtualGrid', context);
  const retainedNode = vm.runInContext(
    'virtualGrid.createRenderedSectionNode({ key: "artist:retained", html: "<section>Retained</section>" })',
    context,
  );
  const removedNode = vm.runInContext(
    'virtualGrid.createRenderedSectionNode({ key: "artist:removed", html: "<section>Removed</section>" })',
    context,
  );
  const retainedImage = vm.runInContext('new HTMLImageElement()', context);
  const removedImage = vm.runInContext('new HTMLImageElement()', context);
  retainedNode.__images = [retainedImage];
  removedNode.__images = [removedImage];
  containerEl.appendChild(retainedNode);
  containerEl.appendChild(removedNode);

  virtualGrid.patchRenderedSections([
    { key: 'artist:retained', html: '<section>Retained</section>' },
  ]);

  assert.equal(containerEl.children.includes(retainedNode), true);
  assert.equal(containerEl.children.includes(removedNode), false);
  assert.equal(retainedImage.getAttribute('src'), '/cover?path=old');
  assert.equal(retainedImage.getAttribute('srcset'), '/cover?path=old 1x');
  assert.equal(removedImage.getAttribute('src'), '/cover?path=old');
  assert.equal(removedImage.getAttribute('srcset'), '/cover?path=old 1x');
  assert.equal(removedImage.getAttribute('loading'), 'eager');
  assert.equal(removedImage.getAttribute('fetchpriority'), 'high');
}


{
  const { context } = createRuntimeContext();

  [1, 10].forEach((rating) => {
    const markup = context.albumCardHtml({
      key: `app-rated-${rating}`,
      name: `App Rated ${rating}`,
      album_artist: 'Rating Artist',
      album_rating: 4,
      tag_album_rating: 9,
      album_preference: { rating },
      tracks: [],
    });

    assert.match(markup, /<div class="rating-row">/);
    assert.match(
      markup,
      new RegExp(`<div class="stars" role="img" aria-label="Album rating ${rating}/10">`),
    );
    assert.match(markup, new RegExp(`<div class="rating-text">${rating}/10</div>`));
    assert.doesNotMatch(markup, /Album rating 4\/10|Album rating 9\/10/);
    assert.equal((markup.match(/<span class="star(?: filled)?">/g) || []).length, 10);
    assert.equal((markup.match(/<span class="star filled">/g) || []).length, rating);
    assert.equal((markup.match(/<span class="star">/g) || []).length, 10 - rating);
    assert.equal((markup.match(/&#9733;/g) || []).length, rating);
    assert.equal((markup.match(/&#9734;/g) || []).length, 10 - rating);
  });
}

{
  const { context } = createRuntimeContext();
  const invalidAppRatingCases = [
    ['album preference absent', {}],
    ['album preference null', { album_preference: null }],
    ['rating absent from album preference', { album_preference: {} }],
    ['rating explicitly cleared', { album_preference: { rating: null } }],
    ['rating undefined', { album_preference: { rating: undefined } }],
    ['numeric string', { album_preference: { rating: '7' } }],
    ['malformed string', { album_preference: { rating: 'excellent' } }],
    ['non-integer number', { album_preference: { rating: 7.5 } }],
    ['zero', { album_preference: { rating: 0 } }],
    ['negative', { album_preference: { rating: -1 } }],
    ['above ten', { album_preference: { rating: 11 } }],
    ['boolean', { album_preference: { rating: true } }],
  ];

  invalidAppRatingCases.forEach(([label, overlay]) => {
    const markup = context.albumCardHtml({
      key: `unrated-${label}`,
      name: `Unrated ${label}`,
      album_artist: 'Rating Artist',
      album_rating: 8,
      tag_album_rating: 9,
      tracks: [],
      ...overlay,
    });

    assert.match(markup, /class="rating-row"/, `${label} must render the rating row`);
    assert.match(
      markup,
      /<div class="stars" role="img" aria-label="Album unrated">/,
      `${label} must expose the unrated state to assistive technology`,
    );
    assert.equal(
      (markup.match(/<span class="star(?: filled)?">/g) || []).length,
      10,
      `${label} must render ten star positions`,
    );
    assert.equal(
      (markup.match(/<span class="star filled">/g) || []).length,
      0,
      `${label} must not fill any stars`,
    );
    assert.equal(
      (markup.match(/<span class="star">/g) || []).length,
      10,
      `${label} must render ten empty stars`,
    );
    assert.equal((markup.match(/&#9733;/g) || []).length, 0, `${label} must not render solid stars`);
    assert.equal((markup.match(/&#9734;/g) || []).length, 10, `${label} must render hollow stars`);
    assert.doesNotMatch(markup, /aria-label="Album rating/, `${label} must not invent numeric ARIA text`);
    assert.doesNotMatch(markup, /class="rating-text"/, `${label} must omit rating text`);
    assert.doesNotMatch(markup, /\/10/, `${label} must omit the rating denominator`);
  });
}

test('narrower viewport drops a column without exceeding the 100-scale card width', () => {
  const scenario = createResponsiveGalleryScenario(100, 760);
  const { context, scrollEl, section, virtualGrid } = scenario;
  const wide = {
    columns: virtualGrid.columns,
    gridTemplate: extractFirstGridTemplate(
      virtualGrid.renderSection(section, 0, Number.POSITIVE_INFINITY),
    ),
  };

  scrollEl.clientWidth = 750;
  virtualGrid.recalculate();
  const narrow = {
    columns: virtualGrid.columns,
    gridTemplate: extractFirstGridTemplate(
      virtualGrid.renderSection(section, 0, Number.POSITIVE_INFINITY),
    ),
  };

  assert.deepEqual(
    {
      galleryScalePercent: context.state.view.gallery_scale_percent,
      wide,
      narrow,
    },
    {
      galleryScalePercent: 100,
      wide: {
        columns: 3,
        gridTemplate: 'repeat(3, minmax(0, 240px))',
      },
      narrow: {
        columns: 2,
        gridTemplate: 'repeat(2, minmax(0, 240px))',
      },
    },
  );
});

test('selected gallery scale controls both the breakpoint and card-width cap', () => {
  const scenario = createResponsiveGalleryScenario(125, 940);
  const { context, scrollEl, section, virtualGrid } = scenario;
  const wide = {
    columns: virtualGrid.columns,
    gridTemplate: extractFirstGridTemplate(
      virtualGrid.renderSection(section, 0, Number.POSITIVE_INFINITY),
    ),
  };

  scrollEl.clientWidth = 920;
  virtualGrid.recalculate();
  const narrow = {
    columns: virtualGrid.columns,
    gridTemplate: extractFirstGridTemplate(
      virtualGrid.renderSection(section, 0, Number.POSITIVE_INFINITY),
    ),
  };

  assert.deepEqual(
    {
      galleryScalePercent: context.state.view.gallery_scale_percent,
      wide,
      narrow,
    },
    {
      galleryScalePercent: 125,
      wide: {
        columns: 3,
        gridTemplate: 'repeat(3, minmax(0, 300px))',
      },
      narrow: {
        columns: 2,
        gridTemplate: 'repeat(2, minmax(0, 300px))',
      },
    },
  );
});

test('fallback rows preserve the selected gallery scale track cap', () => {
  const scenario = createResponsiveGalleryScenario(125, 920);
  const {
    albums,
    context,
    virtualGrid,
  } = scenario;
  const markup = context.renderArtistGroupsMarkupFallback(
    [{
      artist: 'Responsive Artist',
      artist_display: 'Responsive Artist',
      albums,
    }],
    [],
    [],
    virtualGrid.columns,
    context.CARD_GALLERY_LAYOUT_CONFIG,
  );

  assert.deepEqual(
    {
      columns: virtualGrid.columns,
      galleryScalePercent: context.state.view.gallery_scale_percent,
      gridTemplate: extractFirstGridTemplate(markup),
    },
    {
      columns: 2,
      galleryScalePercent: 125,
      gridTemplate: 'repeat(2, minmax(0, 300px))',
    },
  );
});

test('rating stars explicitly stay on one line', () => {
  const starsRule = galleryCssSource.match(/\.stars\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(
    starsRule,
    /flex-wrap\s*:\s*nowrap\s*;/,
    'the album-card stars rule must explicitly prevent responsive wrapping',
  );
});

test('rating row component derives star size and score reservation from its rendered content', () => {
  const ratingRowRule = galleryCssSource.match(/\.rating-row\s*\{([^}]*)\}/)?.[1] || '';
  const ratingReservationRule = galleryCssSource.match(/\.rating-row::after\s*\{([^}]*)\}/)?.[1] || '';
  const starsRule = galleryCssSource.match(/\.stars\s*\{([^}]*)\}/)?.[1] || '';
  const starRule = galleryCssSource.match(/\.star\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(ratingRowRule, /--rating-star-interval-count\s*:\s*9\s*;/);
  assert.match(
    ratingRowRule,
    /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+max-content\s*;/,
    'the score column must measure its reference content instead of using a fixed screen dimension',
  );
  assert.match(ratingRowRule, /column-gap\s*:\s*0\.5em\s*;/);
  assert.doesNotMatch(
    ratingRowRule,
    /(?:grid-template-columns|column-gap)[^;]*(?:px|rem|vw|vh)\b/,
    'the responsive rating columns and gap must not depend on fixed viewport dimensions',
  );

  assert.match(ratingReservationRule, /content\s*:\s*["']10\/10["']\s*;/);
  assert.match(ratingReservationRule, /visibility\s*:\s*hidden\s*;/);
  assert.match(starsRule, /container-type\s*:\s*inline-size\s*;/);
  assert.match(
    starRule,
    /font-size\s*:\s*calc\(100cqi\s*\/\s*var\(--rating-star-interval-count\)\)\s*;/,
    'each star must scale from the live star-area width and the nine intervals between ten positions',
  );
  assert.doesNotMatch(
    starRule,
    /font-size[^;]*(?:px|rem|vw|vh|clamp)\b/,
    'star glyph sizing must not fall back to hardcoded screen-size bounds',
  );
});
