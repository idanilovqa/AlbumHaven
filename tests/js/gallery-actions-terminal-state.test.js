const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const galleryActionsUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'actions',
  'galleryActions.js',
)).href;
const galleryPageUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'poms',
  'galleryPage.js',
)).href;

function settledSnapshot(overrides = {}) {
  return {
    activeLoader: false,
    activeRequestUrl: '',
    attachedMatch: false,
    busy: false,
    canonicalApplied: true,
    canonicalMatch: false,
    canonicalQuery: 'Joseph',
    expectedAlbum: 'Joseph: Part One - The Dreamer',
    expectedArtist: 'Neal Morse',
    expectedQuery: 'Joseph',
    inputQuery: 'Joseph',
    locationQuery: 'Joseph',
    pendingViewTransition: false,
    settledEmpty: false,
    startupHydrating: false,
    ...overrides,
  };
}

test('gallery target classification keeps every unsettled production state retryable', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);
  const retryableCases = [
    ['active request', { activeRequestUrl: '/view-data?surface=albums&q=Joseph' }],
    ['busy runtime', { busy: true }],
    ['active loader', { activeLoader: true }],
    ['pending view transition', { pendingViewTransition: true }],
    ['input query mismatch', { inputQuery: 'Jose' }],
    ['location query mismatch', { locationQuery: 'Jose' }],
    ['canonical query mismatch', { canonicalQuery: 'Jose' }],
    ['startup hydration', { startupHydrating: true }],
    ['canonical result not applied', { canonicalApplied: false }],
    ['canonical match awaiting virtual attachment', { canonicalMatch: true }],
  ];

  for (const [name, overrides] of retryableCases) {
    assert.deepEqual(
      classifyGalleryAlbumTargetState(settledSnapshot(overrides)),
      { status: 'retryable', reason: name },
      name,
    );
  }
});

test('gallery target classification reports a canonical match only after virtual attachment', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);

  assert.deepEqual(
    classifyGalleryAlbumTargetState(settledSnapshot({
      attachedMatch: true,
      canonicalMatch: true,
    })),
    { status: 'ready', reason: 'expected album attached' },
  );
});

test('waitForAlbumVisibleUnderHeading mounts a canonical album detached by virtualization', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  const scrollCalls = [];
  const actions = new GalleryActions({
    async readAlbumTargetState() {
      return settledSnapshot({ canonicalMatch: true });
    },
  });
  actions.scrollToAlbumUnderHeading = async (...args) => scrollCalls.push(args);

  await actions.waitForAlbumVisibleUnderHeading('Neal Morse', 'Joseph: Part One - The Dreamer', {
    expectedQuery: 'Joseph',
    timeout: 100,
  });

  assert.equal(scrollCalls.length, 1);
  assert.equal(scrollCalls[0][0], 'Neal Morse');
  assert.equal(scrollCalls[0][1], 'Joseph: Part One - The Dreamer');
  assert.equal(scrollCalls[0][2].expectedQuery, 'Joseph');
  assert.ok(scrollCalls[0][2].timeout > 0);
});

test('gallery target classification rejects an attached DOM match without canonical response evidence', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);
  const snapshot = settledSnapshot({
    attachedMatch: true,
    canonicalMatch: false,
    observedAlbums: ['Selected Track Split Fixture'],
    observedArtists: ['Rarity Artist'],
  });

  assert.throws(
    () => classifyGalleryAlbumTargetState(snapshot),
    (error) => {
      assert.deepEqual(error.observedState, snapshot);
      return true;
    },
  );
});

test('canonical detached album above the viewport is found by reversing at the gallery boundary', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  let scrollTop = 720;
  const movements = [];
  const target = { count: async () => Number(scrollTop <= 240) };
  const actions = new GalleryActions({
    async readAlbumTargetState() {
      return settledSnapshot({ canonicalMatch: true, attachedMatch: scrollTop <= 240 });
    },
    sectionByArtistHeading() {
      return { getByRole: () => ({ first: () => target }) };
    },
    async waitForGalleryScrollMovement(previous, direction) {
      assert.equal(Math.sign(scrollTop - previous), direction);
    },
  });
  actions.readGalleryScrollState = async () => ({ scrollTop, maxScrollTop: 720, clientHeight: 320 });
  actions.scrollGalleryBy = async delta => {
    movements.push(delta);
    scrollTop = Math.max(0, Math.min(720, scrollTop + delta));
  };
  actions.readAlbumGalleryViewportState = async () => ({
    attached: scrollTop <= 240, intersects: scrollTop <= 240,
  });

  await actions.waitForAlbumVisibleUnderHeading('Neal Morse', 'Joseph: Part One - The Dreamer', {
    expectedQuery: 'Joseph', timeout: 1000, maxAttempts: 4,
  });
  assert.deepEqual(movements, [-240, -240]);
  assert.equal(scrollTop, 240);
});

test('gallery target classification throws immediately for an idle canonical mismatch with observed state', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);
  const snapshot = settledSnapshot({
    observedAlbums: ['Sola Scriptura', 'The Similitude of a Dream'],
    observedArtists: ['Neal Morse'],
  });

  assert.throws(
    () => classifyGalleryAlbumTargetState(snapshot),
    (error) => {
      assert.match(error.message, /Neal Morse/);
      assert.match(error.message, /Joseph: Part One - The Dreamer/);
      assert.match(error.message, /Sola Scriptura/);
      assert.deepEqual(error.observedState, snapshot);
      return true;
    },
  );
});

test('gallery target classification treats the explicit settled empty UI as terminal', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);
  const snapshot = settledSnapshot({
    loaderStatus: 'No artists, albums, or tracks matched your search.',
    loaderTitle: 'Nothing found',
    observedAlbums: [],
    observedArtists: [],
    settledEmpty: true,
  });

  assert.throws(
    () => classifyGalleryAlbumTargetState(snapshot),
    /Settled gallery cannot satisfy expected album/,
  );
});

test('gallery target state uses the current search input for local transitions that reuse a response payload', async () => {
  const { GalleryPage } = await import(galleryPageUrl);
  const groups = [{ artist: 'Neal Morse', albums: [{ name: 'Joseph', key: 'joseph' }] }];
  const observation = {
    stateRevision: 1, activeRequestCount: 0, pendingPayloadReadCount: 0,
    latestFullPayload: { query: 'Joseph', artist_groups: groups },
  };
  const projection = {
    surface: 'albums', query: '', selected_artist: 'Neal Morse',
    locationQuery: '', locationArtist: 'Neal Morse', artist_groups: groups,
  };
  let inputQuery = '';
  const owner = {
    productionViewObserver: { read: () => observation },
    page: { url: () => 'http://localhost/?artist=Neal+Morse', locator: () => ({
      count: async () => 1, inputValue: async () => inputQuery,
    }) },
    readAppliedGalleryProjection: async () => projection,
    albumCard: { detailsButtonByArtistAndAlbum: () => ({ count: async () => 1 }) },
    libraryLoader: { isVisible: async () => false },
    artistHeadings: { allTextContents: async () => ['Neal Morse'] },
  };
  const expected = { artist: 'Neal Morse', album: 'Joseph' };
  const cleared = await GalleryPage.prototype.readAlbumTargetState.call(owner, expected);
  assert.equal(cleared.expectedQuery, '');
  assert.equal(cleared.canonicalQuery, '');
  assert.equal(cleared.canonicalReadyMatch, true);
  inputQuery = 'unsubmitted draft';
  const draft = await GalleryPage.prototype.readAlbumTargetState.call(owner, expected);
  assert.equal(draft.expectedQuery, 'unsubmitted draft');
  assert.equal(draft.canonicalQuery, '', 'typing cannot change the applied query evidence');
});

test('artist-tree reflow checkpoint only observes runtime view and scroll state', async () => {
  const { GalleryPage } = await import(galleryPageUrl);
  const view = Object.freeze({ query: 'ДДТ', selected_artist: 'ДДТ' });
  const state = Object.freeze({ view });
  const scroll = Object.freeze({
    scrollTop: 240,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
  });
  const checkpoint = await GalleryPage.prototype.readArtistTreeReflowCheckpoint.call({
    galleryScroll: {
      evaluate: (measure, reference) => require('node:vm').runInNewContext(
        `"use strict"; (${measure.toString()})(scroll, reference)`,
        { state, scroll, reference },
      ),
    },
  });
  assert.equal(checkpoint.query, 'ДДТ');
  assert.equal(checkpoint.selectedArtist, 'ДДТ');
  assert.equal(checkpoint.scrollTop, 240);
});

test('artist-tree checkpoint follows the captured trigger and rejects missing or hidden references', async () => {
  const { GalleryPage } = await import(galleryPageUrl);
  let referenceTop = 40;
  const makeTrigger = (key, kind, top) => {
    const card = Object.freeze({
      getAttribute: () => `card-${key}`,
      getBoundingClientRect: () => ({ top: top(), bottom: top() + 220 }),
    });
    return Object.freeze({
      getAttribute: () => key,
      matches: () => kind === 'artbox',
      closest: () => card,
      getBoundingClientRect: () => ({ top: top(), bottom: top() + 200 }),
    });
  };
  const earlier = makeTrigger('earlier', 'artbox', () => 40);
  const original = makeTrigger('original', 'artbox', () => referenceTop);
  let triggers = [original];
  const scroll = Object.freeze({
    scrollTop: 240,
    querySelectorAll: (selector) => selector === '.album-row' ? [] : triggers,
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
  });
  const pom = { galleryScroll: { evaluate: (measure, reference) => measure(scroll, reference) } };
  const before = await GalleryPage.prototype.readArtistTreeReflowCheckpoint.call(pom);
  assert.equal(before.anchorTrigger, 'artbox');
  assert.equal(before.anchorVisible, true);
  triggers = [earlier, original];
  const after = await GalleryPage.prototype.readArtistTreeReflowCheckpoint.call(pom, before);
  assert.equal(after.anchorKey, 'original');
  assert.equal(after.anchorCardKey, 'card-original');
  assert.equal(after.anchorOffset, 40);
  assert.equal(after.anchorVisible, true);
  referenceTop = -300;
  const hidden = await GalleryPage.prototype.readArtistTreeReflowCheckpoint.call(pom, before);
  assert.equal(hidden.anchorVisible, false);
  triggers = [earlier];
  const missing = await GalleryPage.prototype.readArtistTreeReflowCheckpoint.call(pom, before);
  assert.equal(missing.anchorKey, '');
  assert.equal(missing.anchorOffset, null);
  assert.equal(missing.anchorVisible, false);
});


test('exact heading readiness rejects an optimistic GalleryBar while canonical navigation is pending', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  let predicate, selectors, timeout;
  const owner = { galleryPage: { artistHeadingSelector: '.artist',
    waitForPageCondition: async (callback, options, args) => {
      predicate = callback; selectors = args; timeout = options.timeout;
    },
  } };
  await GalleryActions.prototype.waitForOnlyArtistHeadings.call(owner, ['Latest Artist'], { timeout: 10000 });
  assert.equal(timeout, 10000);
  const runtime = { view: {}, busy: true, ui: { activeViewRequestUrl: '/view-data?artist=Latest' } };
  let headings = ['Latest Artist'];
  const run = () => require('node:vm').runInNewContext(`(${predicate.toString()})(selectors)`, {
    state: runtime, selectors,
    document: { querySelectorAll: () => headings.map(textContent => ({ textContent })) },
  });
  assert.equal(run(), false);
  runtime.busy = false;
  assert.equal(run(), false, 'in-flight canonical response is still required');
  runtime.ui.activeViewRequestUrl = '';
  runtime.ui.pendingViewRequest = { artist: 'Latest Artist' };
  assert.equal(run(), false, 'queued canonical navigation is still required');
  runtime.ui.pendingViewRequest = null;
  assert.equal(run(), true);
  headings = ['Old Artist'];
  assert.equal(run(), false, 'settled state still requires the exact heading');
});

function detailsViewportHarness(GalleryPage, GalleryActions, initialTitleTop = 90) {
  let scrollTop = 1982;
  const movements = [], clicks = [];
  class Element {
    constructor(bounds) { this.bounds = bounds; }
    getBoundingClientRect() { return this.bounds(); }
  }
  const gallery = new Element(() => ({ left: 264, right: 1408, top: 130, bottom: 884, width: 1144, height: 754 }));
  const card = new Element(() => ({ left: 1130, right: 1403, top: initialTitleTop - 289 + 1982 - scrollTop,
    bottom: initialTitleTop + 107 + 1982 - scrollTop, width: 273, height: 396 }));
  const title = new Element(() => ({ left: 1142, right: 1391, top: initialTitleTop + 1982 - scrollTop,
    bottom: initialTitleTop + 22 + 1982 - scrollTop, width: 249, height: 22 }));
  const evaluateAll = elements => async (measure, args) => require('node:vm').runInNewContext(
    `(${measure.toString()})(elements, args)`, {
      elements, args, HTMLElement: Element,
      document: { querySelector: selector => { assert.equal(selector, '#albums-scroll'); return gallery; } },
    },
  );
  const cards = {
    first() { return this; }, count: async () => 1, evaluateAll: evaluateAll([card]),
    locator(selector) { assert.equal(selector, '.album-title-button[data-open-tracklist="1"]'); return { evaluateAll: evaluateAll([title]) }; },
  };
  const pom = {
    galleryScrollSelector: '#albums-scroll', galleryScroll: { hover: async () => {} },
    sectionByArtistHeading: () => ({}),
    albumCard: {
      detailsButtonWithinCardSelector: '.album-title-button[data-open-tracklist="1"]',
      cardByIdentity(artist, album, year) { assert.deepEqual([artist, album, year], ['ДДТ', 'Студийные записи4', '1999']); return cards; },
      async clickDetailsByIdentity() {
        const bounds = title.getBoundingClientRect();
        assert.ok(bounds.top >= 130 && bounds.bottom <= 884, 'the actual details action must be fully visible before its native click');
        clicks.push('native-title-click');
      },
    },
    page: { mouse: { wheel: async (x, y) => { assert.equal(x, 0); movements.push(y); scrollTop += y; } } },
    async waitForGalleryScrollMovement(previous, direction) { assert.equal(Math.sign(scrollTop - previous), direction); },
  };
  pom.readAlbumGalleryViewportState = (...args) => GalleryPage.prototype.readAlbumGalleryViewportState.call(pom, ...args);
  const actions = new GalleryActions(pom);
  actions.readGalleryScrollState = async () => ({ scrollTop, clientHeight: 754, maxScrollTop: 7000 });
  return { actions, pom, movements, clicks };
}

for (const [titleTop, direction] of [[90, -1], [875, 1]]) {
  test(`opening details uses native wheel ${direction < 0 ? 'up' : 'down'} when a partial card has a clipped title`, async () => {
    const { GalleryPage } = await import(galleryPageUrl);
    const { GalleryActions } = await import(galleryActionsUrl);
    const h = detailsViewportHarness(GalleryPage, GalleryActions, titleTop);
    const card = await h.pom.readAlbumGalleryViewportState('ДДТ', 'Студийные записи4', { year: '1999' });
    assert.equal(card.intersects, true, 'the visible card edge is insufficient to click its title');
    await h.actions.selectAlbumDetailsByIdentity({ artist: 'ДДТ', album: 'Студийные записи4', year: '1999' });
    assert.deepEqual(h.movements, [direction * 566]);
    assert.deepEqual(h.clicks, ['native-title-click']);
  });
}

test('opening an already visible details action does not add scroll or recovery navigation', async () => {
  const { GalleryPage } = await import(galleryPageUrl);
  const { GalleryActions } = await import(galleryActionsUrl);
  const h = detailsViewportHarness(GalleryPage, GalleryActions, 400);
  await h.actions.selectAlbumDetailsByIdentity({ artist: 'ДДТ', album: 'Студийные записи4', year: '1999' });
  assert.deepEqual(h.movements, []);
  assert.deepEqual(h.clicks, ['native-title-click']);
});
