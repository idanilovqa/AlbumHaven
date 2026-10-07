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

test('gallery scrolling enforces its deadline even while the gallery keeps moving', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  let scrollTop = 0;
  let actionsCount = 0;
  const actions = new GalleryActions({
    sectionByArtistHeading: () => ({ getByRole: () => ({ first: () => ({ count: async () => 0 }) }) }),
    async waitForGalleryScrollMovement(_previous, _direction, { timeout }) {
      assert.ok(timeout > 0 && timeout <= 20, 'Movement receives the remaining caller budget');
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  });
  actions.readGalleryScrollState = async () => ({ scrollTop, maxScrollTop: 100000, clientHeight: 320 });
  actions.scrollGalleryBy = async () => { scrollTop += 240; actionsCount += 1; };
  await assert.rejects(actions.scrollToAlbumUnderHeading('Artist', 'Missing', { timeout: 20 }), /Timed out/);
  assert.equal(actionsCount, 1);
});

test('topology sampling tolerates navigation activity but keeps exact rendered identities', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  const expected = [{ album: 'Album', year: '2002' }];
  let activity = 1;
  let navigations = 0;
  const actions = new GalleryActions({
    readViewGenerationState: () => ({ revision: 7, activityRevision: activity, artistTopology: 'current', settled: true }),
    readRenderedAlbumIdentities: async () => expected,
  });
  actions.readGalleryScrollState = async () => ({ scrollTop: 42, maxScrollTop: 100 });
  actions.scrollToAlbumUnderHeading = async (_artist, _album, options) => {
    assert.ok(options.timeout > 0 && options.timeout <= 100);
    navigations += 1;
    activity += 4;
  };
  const result = await actions.waitForAlbumIdentityTopology('Artist', expected, { timeout: 100 });
  assert.deepEqual(result.identities, expected);
  assert.equal(navigations, 1);
  assert.equal(result.scroll.scrollTop, 42);
});

test('gallery generation distinguishes activity from authority and surfaces observer errors', async () => {
  const { GalleryPage } = await import(galleryPageUrl);
  let observation = { stateRevision: 29, topologyRevision: 2, galleryArtistTopologies: { Artist: 'identity' } };
  const page = Object.create(GalleryPage.prototype);
  page.productionViewObserver = { read: () => observation };
  const initial = page.readViewGenerationState('Artist');
  observation = { ...observation, stateRevision: 57 };
  const current = page.readViewGenerationState('Artist');
  assert.equal(current.revision, initial.revision);
  assert.notEqual(current.activityRevision, initial.activityRevision);
  assert.equal(current.artistTopology, 'identity');
  observation.latestGalleryPageError = 'failed continuation';
  assert.throws(() => page.readViewGenerationState('Artist'), /failed continuation/);
});

test('gallery target state does not resurrect bootstrap authority after a view request', async () => {
  const { GalleryPage } = await import(galleryPageUrl);
  const page = Object.create(GalleryPage.prototype);
  page.productionViewObserver = { read: () => ({ allowBootstrapFallback: false, activeRequestCount: 0, pendingPayloadReadCount: 0, stateRevision: 1 }) };
  page.readProductionBootstrapPayload = async () => assert.fail('Old bootstrap must not become fresh authority');
  page.page = { locator: () => ({ count: async () => 0 }), url: () => 'http://localhost/' };
  page.albumCard = { detailsButtonByArtistAndAlbum: () => ({ count: async () => 0 }) };
  page.libraryLoader = { isVisible: async () => false };
  page.artistHeadings = { allTextContents: async () => [] };
  const state = await page.readAlbumTargetState({ artist: 'Artist', album: 'Album' });
  assert.equal(state.canonicalMatch, false);
});

for (const change of ['DOM activity', 'replacement', 'artist split']) {
  test(`topology sampling retries ${change} without accepting a mixed window`, async () => {
    const { GalleryActions } = await import(galleryActionsUrl);
    const expected = [{ album: 'Album', year: '2002' }, { album: 'Album', year: '2014' }];
    let activityRevision = 1;
    let revision = 1;
    let artistTopology = 'original';
    let reads = 0;
    let resets = 0;
    const actions = new GalleryActions({
      readViewGenerationState: () => ({ revision, activityRevision, artistTopology, settled: true }),
      readRenderedAlbumIdentities: async () => {
        reads += 1;
        if (reads === (change === 'DOM activity' ? 1 : 2)) {
          if (change === 'DOM activity') activityRevision += 1;
          if (change === 'replacement') revision += 1;
          if (change === 'artist split') artistTopology = 'split';
        }
        return expected;
      },
    });
    actions.readGalleryScrollState = async () => ({ scrollTop: 42 });
    actions.scrollToAlbumUnderHeading = async () => {};
    actions.restoreGalleryScrollPosition = async (position) => { assert.equal(position, 42); resets += 1; };
    const result = await actions.waitForAlbumIdentityTopology('Artist', expected, { timeout: 500 });
    assert.deepEqual(result.identities, expected);
    assert.equal(resets, 1);
    assert.equal(reads, 4);
  });
}

test('topology sampling cannot accept exact identities after its deadline', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  const expected = [{ album: 'Album', year: '2002' }];
  const actions = new GalleryActions({
    readViewGenerationState: () => ({ revision: 1, settled: true }),
    readRenderedAlbumIdentities: async () => expected,
  });
  actions.readGalleryScrollState = async () => ({ scrollTop: 42 });
  actions.scrollToAlbumUnderHeading = async () => new Promise((resolve) => setTimeout(resolve, 25));
  await assert.rejects(actions.waitForAlbumIdentityTopology('Artist', expected, { timeout: 20 }), /Timed out/);
});

test('gallery wheel hover receives the caller deadline', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  const events = [];
  const actions = new GalleryActions({
    galleryScroll: { hover: async (options) => events.push(options) },
    page: { mouse: { wheel: async (x, y) => events.push([x, y]) } },
  });
  await actions.scrollGalleryBy(240, { timeout: 17 });
  assert.deepEqual(events, [{ timeout: 17 }, [0, 240]]);
});

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

test('album absence waits for complete canonical scope rather than a settled partial page', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  let reads = 0;
  const actions = new GalleryActions({
    async readAlbumTargetState() {
      reads += 1;
      return settledSnapshot({ canonicalScopeComplete: reads > 1 });
    },
  });
  await actions.expectAlbumAbsentFromSettledGallery({
    artist: 'Neal Morse', album: 'Joseph: Part One - The Dreamer', query: 'Joseph',
  });
  assert.ok(reads > 1, 'unseen on a partial page is not proven absent from the canonical scope');
});

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

test('gallery boundary waits for advertised continuation before reversing', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  let scrollTop = 720;
  let reads = 0;
  const movements = [];
  const target = { count: async () => Number(scrollTop === 960) };
  const actions = new GalleryActions({
    sectionByArtistHeading: () => ({ getByRole: () => ({ first: () => target }) }),
    async waitForGalleryScrollMovement(previous, direction) {
      assert.equal(Math.sign(scrollTop - previous), direction);
    },
  });
  actions.readGalleryScrollState = async () => {
    const continued = reads++ > 0;
    return {
      scrollTop, clientHeight: 320, maxScrollTop: continued ? 960 : 720,
      pagination: { busy: false, page: { offset: continued ? 18 : 12, next_offset: continued ? null : 18 } },
    };
  };
  actions.scrollGalleryBy = async (delta) => { movements.push(delta); scrollTop += delta; };
  actions.readAlbumGalleryViewportState = async () => ({
    attached: scrollTop === 960, intersects: scrollTop === 960,
  });
  await actions.scrollToAlbumUnderHeading('E2E Rarity Artist', 'Fixture', { maxAttempts: 1, timeout: 1000 });
  assert.deepEqual(movements, [240]);
});

test('stalled gallery continuation fails within the supplied timeout without reversing', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  const actions = new GalleryActions({
    sectionByArtistHeading: () => ({ getByRole: () => ({ first: () => ({ count: async () => 0 }) }) }),
  });
  actions.readGalleryScrollState = async () => ({
    scrollTop: 720, clientHeight: 320, maxScrollTop: 720,
    pagination: { busy: false, page: { offset: 12, next_offset: 18 } },
  });
  actions.scrollGalleryBy = async () => assert.fail('Must not reverse while another page is advertised');
  await assert.rejects(
    actions.scrollToAlbumUnderHeading('E2E Rarity Artist', 'Fixture', { timeout: 25 }),
    /Expected advertised gallery continuation to settle/,
  );
});

test('gallery navigation surfaces observed continuation failure', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  const actions = new GalleryActions({
    galleryScroll: { evaluate: async () => ({ scrollTop: 0, maxScrollTop: 0, clientHeight: 320 }) },
    productionViewObserver: { read: () => ({ latestGalleryPageError: 'HTTP 500 for continuation' }) },
  });
  await assert.rejects(actions.readGalleryScrollState(), /HTTP 500 for continuation/);
});

test('upward gallery navigation starting at top reverses to find a later album', async () => {
  const { GalleryActions } = await import(galleryActionsUrl);
  let scrollTop = 0;
  const movements = [];
  const target = { count: async () => Number(scrollTop === 240) };
  const actions = new GalleryActions({
    sectionByArtistHeading: () => ({ getByRole: () => ({ first: () => target }) }),
    async waitForGalleryScrollMovement(previous, direction) {
      assert.equal(Math.sign(scrollTop - previous), direction);
    },
  });
  actions.readGalleryScrollState = async () => ({ scrollTop, clientHeight: 320, maxScrollTop: 720 });
  actions.scrollGalleryBy = async (delta) => { movements.push(delta); scrollTop += delta; };
  actions.readAlbumGalleryViewportState = async () => ({ attached: true, intersects: true });
  await actions.scrollToAlbumUnderHeading('Artist', 'Album', { direction: -1, maxAttempts: 1 });
  assert.deepEqual(movements, [240]);
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

for (const present of [true, false]) {
  test(`default gallery navigation reverses once from bottom and ${present ? 'finds an earlier virtual album' : 'fails for an absent album'}`, async () => {
    const { GalleryActions } = await import(galleryActionsUrl);
    let scrollTop = 720;
    const movements = [];
    const target = { count: async () => Number(present && scrollTop <= 240) };
    const actions = new GalleryActions({
      sectionByArtistHeading: () => ({ getByRole: () => ({ first: () => target }) }),
      async waitForGalleryScrollMovement(previous, direction) {
        assert.equal(Math.sign(scrollTop - previous), direction);
      },
    });
    actions.readGalleryScrollState = async () => ({ scrollTop, maxScrollTop: 720, clientHeight: 320 });
    actions.scrollGalleryBy = async delta => {
      movements.push(delta);
      assert.ok(movements.length <= 3, 'navigation must stop at the opposite boundary');
      scrollTop = Math.max(0, Math.min(720, scrollTop + delta));
    };
    actions.readAlbumGalleryViewportState = async () => ({ attached: true, intersects: true });
    const navigation = actions.scrollToAlbumUnderHeading('E2E Rarity Artist', 'Fixture Album');
    if (present) await navigation;
    else await assert.rejects(navigation, /Expected album/);
    assert.deepEqual(movements, present ? [-240, -240] : [-240, -240, -240]);
  });
}

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
  const targetStateSource = GalleryPage.prototype.readAlbumTargetState.toString();
  assert.match(
    targetStateSource,
    /inputQuery = await input\.count\(\) \? await input\.inputValue\(\) : ''[\s\S]*canonicalQuery = String\(inputQuery \|\| ''\)\.trim\(\)/,
  );
  assert.doesNotMatch(targetStateSource, /runtimeQuery|state\?\.view\?\.query/);
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
