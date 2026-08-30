const assert = require('node:assert/strict');
const test = require('node:test');

const galleryActionsModule = import('../e2e/actions/galleryActions.js');

class FakeElement {
  constructor(bounds, options = {}) {
    this.bounds = bounds;
    this.hidden = Boolean(options.hidden);
    this.attributes = new Map(Object.entries(options.attributes || {}));
    this.classList = {
      contains: (name) => (options.classes || []).includes(name),
    };
  }

  getBoundingClientRect() {
    return this.bounds;
  }

  getAttribute(name) {
    return this.attributes.get(name) || '';
  }
}

class FakeImageElement extends FakeElement {
  constructor(bounds, options = {}) {
    super(bounds, options);
    this.complete = Boolean(options.complete);
    this.naturalWidth = Number(options.naturalWidth || 0);
    this.currentSrc = String(options.currentSrc || '');
  }
}

function card(title, bounds, visual, selectors) {
  return new class FakeCardElement extends FakeElement {
    constructor() {
      super(bounds, { attributes: { 'data-gallery-card-key': title } });
    }

    querySelector(selector) {
      if (selector === selectors.coverImageSelector) {
        return visual instanceof FakeImageElement ? visual : null;
      }
      if (selector === selectors.coverPlaceholderSelector) {
        return visual instanceof FakeImageElement ? null : visual;
      }
      if (selector === selectors.titleSelector) {
        return { textContent: title };
      }
      return null;
    }
  }();
}

test('visible gallery cover readiness uses the cover visual intersection rather than its card bounds', async () => {
  const { readVisibleGalleryCoverReadiness } = await galleryActionsModule;
  const selectors = {
    albumCardSelector: '.album-card',
    coverImageSelector: '.cover img',
    coverPlaceholderSelector: '.cover-placeholder',
    titleSelector: '.album-title-button',
    galleryScrollSelector: '#albums-scroll',
    minimumCount: 2,
    requireVisible: true,
    allowPlaceholder: false,
    requireLocalImage: true,
  };
  const scroller = new FakeElement({
    left: 0, top: 100, right: 600, bottom: 500, width: 600, height: 400,
  });
  const pendingOutsideCover = new FakeImageElement({
    left: 20, top: 20, right: 220, bottom: 90, width: 200, height: 70,
  }, {
    complete: false,
    attributes: {
      'aria-hidden': 'true',
      'data-cover-visual-state': 'pending',
      'data-production-cover-src': '/cover?path=pending',
    },
  });
  const firstReadyCover = new FakeImageElement({
    left: 20, top: 120, right: 220, bottom: 320, width: 200, height: 200,
  }, {
    complete: true,
    naturalWidth: 480,
    currentSrc: 'http://album.test/cover?path=ready-one',
    attributes: {
      'data-cover-visual-state': 'ready',
      'data-production-cover-src': '/cover?path=ready-one',
    },
  });
  const secondReadyCover = new FakeImageElement({
    left: 240, top: 120, right: 440, bottom: 320, width: 200, height: 200,
  }, {
    complete: true,
    naturalWidth: 480,
    currentSrc: 'http://album.test/cover?path=ready-two',
    attributes: {
      'data-cover-visual-state': 'ready',
      'data-production-cover-src': '/cover?path=ready-two',
    },
  });
  const cards = [
    card('Partially intersecting card', {
      left: 20, top: 20, right: 220, bottom: 140, width: 200, height: 120,
    }, pendingOutsideCover, selectors),
    card('Ready One', {
      left: 20, top: 120, right: 220, bottom: 420, width: 200, height: 300,
    }, firstReadyCover, selectors),
    card('Ready Two', {
      left: 240, top: 120, right: 440, bottom: 420, width: 200, height: 300,
    }, secondReadyCover, selectors),
  ];
  const originals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLImageElement: globalThis.HTMLImageElement,
    window: globalThis.window,
    scheduler: globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__,
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLImageElement = FakeImageElement;
  globalThis.window = {
    location: { href: 'http://album.test/', origin: 'http://album.test' },
  };
  globalThis.document = {
    querySelector: (selector) => (selector === selectors.galleryScrollSelector ? scroller : null),
    querySelectorAll: (selector) => (selector === selectors.albumCardSelector ? cards : []),
  };
  globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ = {
    active: 0,
    queuedVisible: 0,
    queuedNear: 2,
    queuedBackground: 4,
  };

  try {
    assert.equal(readVisibleGalleryCoverReadiness(selectors), true);
    const snapshot = readVisibleGalleryCoverReadiness({ ...selectors, snapshot: true });
    assert.equal(snapshot.candidateCount, 2);
    assert.equal(snapshot.readyCount, 2);
    assert.deepEqual(snapshot.ready.map(({ title }) => title), ['Ready One', 'Ready Two']);
    assert.deepEqual(snapshot.unready, []);
    assert.deepEqual(snapshot.excluded.map(({ title, reason }) => ({ title, reason })), [{
      title: 'Partially intersecting card',
      reason: 'cover visual outside gallery viewport',
    }]);
    assert.equal(snapshot.scheduler.queuedNear, 2);

    secondReadyCover.complete = false;
    secondReadyCover.naturalWidth = 0;
    secondReadyCover.currentSrc = '';
    secondReadyCover.attributes.set('data-cover-visual-state', 'pending');
    secondReadyCover.attributes.set('aria-hidden', 'true');
    assert.equal(readVisibleGalleryCoverReadiness(selectors), false);
    const stalledSnapshot = readVisibleGalleryCoverReadiness({ ...selectors, snapshot: true });
    assert.equal(stalledSnapshot.candidateCount, 2);
    assert.equal(stalledSnapshot.readyCount, 1);
    assert.deepEqual(stalledSnapshot.unready.map((entry) => ({
      title: entry.title,
      reason: entry.reason,
      visualState: entry.visualState,
      ariaHidden: entry.ariaHidden,
      currentSrc: entry.currentSrc,
      visualRect: entry.visualRect,
    })), [{
      title: 'Ready Two',
      reason: 'image pending decode',
      visualState: 'pending',
      ariaHidden: 'true',
      currentSrc: '',
      visualRect: {
        left: 240, top: 120, right: 440, bottom: 320, width: 200, height: 200,
      },
    }]);
    assert.deepEqual(stalledSnapshot.scheduler, {
      active: 0,
      queuedVisible: 0,
      queuedNear: 2,
      queuedBackground: 4,
    });
  } finally {
    if (originals.document === undefined) delete globalThis.document;
    else globalThis.document = originals.document;
    if (originals.HTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originals.HTMLElement;
    if (originals.HTMLImageElement === undefined) delete globalThis.HTMLImageElement;
    else globalThis.HTMLImageElement = originals.HTMLImageElement;
    if (originals.window === undefined) delete globalThis.window;
    else globalThis.window = originals.window;
    if (originals.scheduler === undefined) delete globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__;
    else globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ = originals.scheduler;
  }
});

test('gallery cover readiness timeout reports titles, states, geometry, and scheduler diagnostics', async () => {
  const {
    GalleryActions,
    readVisibleGalleryCoverReadiness,
  } = await galleryActionsModule;
  const diagnosticSnapshot = {
    candidateCount: 2,
    readyCount: 1,
    unreadyCount: 1,
    ready: [{ title: 'Ready One' }],
    unready: [{
      title: 'Length And Repetition',
      visualState: 'pending',
      currentSrc: '',
      visualRect: { top: 120, bottom: 320 },
    }],
    scheduler: { active: 0, queuedNear: 2 },
  };
  const actions = new GalleryActions({
    albumCard: {
      cardSelector: '.album-card',
      coverImageWithinCardSelector: '.cover img',
      coverPlaceholderWithinCardSelector: '.cover-placeholder',
      titleButtonSelector: '.album-title-button',
    },
    galleryScrollSelector: '#albums-scroll',
    async waitForPageCondition(callback) {
      assert.equal(callback, readVisibleGalleryCoverReadiness);
      throw new Error('page wait timed out');
    },
    page: {
      async evaluate(callback, selectors) {
        assert.equal(callback, readVisibleGalleryCoverReadiness);
        assert.equal(selectors.snapshot, true);
        return diagnosticSnapshot;
      },
    },
  });

  await assert.rejects(
    actions.waitForVisibleGalleryCoversLoaded({ minimumCount: 2, timeout: 50 }),
    (error) => {
      assert.match(error.message, /Visible gallery covers did not become ready/);
      assert.match(error.message, /Length And Repetition/);
      assert.match(error.message, /"visualState":"pending"/);
      assert.match(error.message, /"currentSrc":""/);
      assert.match(error.message, /"visualRect":\{"top":120,"bottom":320\}/);
      assert.match(error.message, /"scheduler":\{"active":0,"queuedNear":2\}/);
      assert.equal(error.cause?.message, 'page wait timed out');
      return true;
    },
  );
});
