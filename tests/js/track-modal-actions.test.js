const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

function createLocator({ text = '', visible = true, count = 0, evaluateAll = null } = {}) {
  return {
    async textContent() {
      return text;
    },
    async isVisible() {
      return visible;
    },
    async count() {
      return count;
    },
    async evaluateAll(callback) {
      if (evaluateAll !== null) return evaluateAll;
      return callback([]);
    },
  };
}

function createTrackModalStub({ coverLoaded, noCover = false, coverCheckpoint = null }) {
  const waitCalls = [];
  const albumCoverImage = createLocator({ evaluateAll: coverLoaded });
  return {
    waitCalls,
    trackModal: {
      coverPlaceholderSelector: '#track-modal-cover .cover-placeholder',
      detailedCoverImageSelector: '#track-modal-cover .track-modal-cover-visual img',
      dialogSelector: '#track-modal',
      loadingRowSelector: '#track-modal .track-modal-loading-row',
      trackRowSelector: '#track-modal [data-track-row-path]',
      waitForPageCondition: async (_callback, options = {}) => {
        waitCalls.push(options.timeout ?? null);
      },
      dialog: {
        locator(selector) {
          assert.equal(selector, '#track-modal-cover .track-modal-cover-visual img');
          return albumCoverImage;
        },
      },
      detailedCoverImage: albumCoverImage,
      title: createLocator({ text: 'Neal Morse - One - 2004' }),
      subtitle: createLocator({ text: 'Neal Morse' }),
      footer: createLocator({ text: 'Total Main Album Length: 1h 19m' }),
      playButtons: createLocator({ count: 4 }),
      trackRows: createLocator({ count: 12 }),
      coverPlaceholder: createLocator({
        text: noCover ? 'No cover art' : '',
        visible: noCover,
      }),
      async readDetailedCoverImageCheckpoint() {
        return coverCheckpoint;
      },
    },
  };
}

test('TrackModalActions.waitForLoadedSummary accepts a modal with loaded cover art', async () => {
  const { TrackModalActions } = await import('../e2e/actions/trackModalActions.js');
  const { trackModal, waitCalls } = createTrackModalStub({ coverLoaded: true });

  const actions = new TrackModalActions(trackModal);
  const summary = await actions.waitForLoadedSummary({ timeout: 1234 });

  assert.deepEqual(waitCalls, [1234, 1234]);
  assert.equal(summary.coverLoaded, true);
  assert.equal(summary.coverReady, true);
});

test('TrackModalActions.waitForLoadedSummary accepts a modal with the no-cover placeholder', async () => {
  const { TrackModalActions } = await import('../e2e/actions/trackModalActions.js');
  const { trackModal, waitCalls } = createTrackModalStub({ coverLoaded: false, noCover: true });

  const actions = new TrackModalActions(trackModal);
  const summary = await actions.waitForLoadedSummary();

  assert.deepEqual(waitCalls, [60000, 15000]);
  assert.equal(summary.coverLoaded, false);
  assert.equal(summary.coverPlaceholderVisible, true);
  assert.equal(summary.coverReady, true);
});

test('TrackModalActions.closeIfOpen tolerates the modal closing between visibility and click', async () => {
  const { TrackModalActions } = await import('../e2e/actions/trackModalActions.js');
  let visibilityReads = 0;
  let clickOptions = null;
  const actions = new TrackModalActions({
    dialog: {
      async isVisible() {
        visibilityReads += 1;
        return visibilityReads === 1;
      },
    },
    closeButton: {
      async click(options) {
        clickOptions = options;
        throw new Error('locator became hidden');
      },
    },
  });

  await actions.closeIfOpen();
  assert.deepEqual(clickOptions, { timeout: 1000 });
  assert.equal(visibilityReads, 2);
});

test('TrackModalActions reads the displayed modal cover checkpoint through its POM', async () => {
  const { TrackModalActions } = await import('../e2e/actions/trackModalActions.js');
  const coverCheckpoint = {
    complete: true,
    currentSrc: 'http://127.0.0.1:4173/cover?path=joseph&size=480',
    productionSrc: '/cover?path=joseph&size=480',
    naturalWidth: 480,
    naturalHeight: 480,
  };
  const { trackModal } = createTrackModalStub({ coverLoaded: true, coverCheckpoint });

  const actions = new TrackModalActions(trackModal);

  assert.deepEqual(await actions.waitForDetailedCoverImageCheckpoint(), coverCheckpoint);
});

test('TrackModalActions reads raw title and artist playback attributes', async () => {
  const { TrackModalActions } = await import('../e2e/actions/trackModalActions.js');
  const actions = new TrackModalActions({
    trackRowAt() {
      return {
        async getAttribute(name) {
          return name === 'data-track-row-path' ? 'signal.mp3' : '';
        },
      };
    },
    playButtonAt() {
      return {
        async getAttribute(name) {
          return {
            'data-track-title': 'Signal featuring Guest',
            'data-track-artist': 'Signal Artist',
          }[name] || '';
        },
      };
    },
  });

  assert.deepEqual(await actions.readTrackAt(0), {
    path: 'signal.mp3',
    title: 'Signal featuring Guest',
    artist: 'Signal Artist',
  });
});

test('TrackModalActions records playback timing after actionability and immediately before the real click', async () => {
  const { TrackModalActions } = await import('../e2e/actions/trackModalActions.js');
  const operations = [];
  const playButton = {
    async getAttribute(name) {
      return {
        'data-track-title': 'Measured Track',
        'data-track-artist': 'Measured Artist',
      }[name] || '';
    },
    async click(options = {}) {
      operations.push(options.trial ? 'actionability' : 'click');
    },
  };
  const actions = new TrackModalActions({
    trackRowAt() {
      return {
        async getAttribute(name) {
          return name === 'data-track-row-path' ? 'measured-track.mp3' : '';
        },
      };
    },
    playButtonAt() {
      return playButton;
    },
  });

  const track = await actions.playTrackAt(0, {
    async recordClickBoundary() {
      operations.push('boundary');
    },
  });

  assert.deepEqual(track, {
    path: 'measured-track.mp3',
    title: 'Measured Track',
    artist: 'Measured Artist',
  });
  assert.deepEqual(
    operations,
    ['actionability', 'boundary', 'click'],
    'the measured interval must exclude normal Playwright actionability waiting',
  );
});

test('TrackModalActions validates the exact track before installing Last.fm response waiters', async () => {
  const { TrackModalActions } = await import('../e2e/actions/trackModalActions.js');
  let waiterCount = 0;
  let clickCount = 0;
  const actions = new TrackModalActions({
    page: {
      waitForResponse() {
        waiterCount += 1;
        throw new Error('response waiter must not be installed for the wrong track');
      },
    },
    trackRowAt() {
      return {
        async getAttribute(name) {
          return name === 'data-track-row-path' ? 'wrong.mp3' : '';
        },
      };
    },
    playButtonAt() {
      return {
        async getAttribute(name) {
          return name === 'data-track-title' ? 'Wrong Track' : '';
        },
        async click() {
          clickCount += 1;
        },
      };
    },
  });

  await assert.rejects(
    actions.playTrackAtAndWaitForLastfmJourney(0, { title: 'Fake Loop Source' }),
    /Expected to play "Fake Loop Source", received "Wrong Track"/,
  );
  assert.equal(waiterCount, 0);
  assert.equal(clickCount, 0);
});

test('Last.fm journey observation preserves request order for responses published after the pause UI flips and removes every listener', async () => {
  const { observeLastfmJourneyRequests } = await import('../e2e/actions/trackModalActions.js');
  const page = new EventEmitter();
  let pauseUiFlipped = false;
  let releaseFirstResponseBody;
  const firstResponseBody = new Promise((resolve) => {
    releaseFirstResponseBody = resolve;
  });
  const createRequest = (title, startedAt) => ({
    method: () => 'POST',
    url: () => 'http://127.0.0.1:4173/playback/session/complete',
    postDataJSON: () => ({ title, started_at: startedAt }),
  });
  const firstRequest = createRequest('Second Fixture Track', '2026-07-23T01:02:02Z');
  const secondRequest = createRequest('Third Fixture Track', '2026-07-23T01:02:03Z');
  const firstResponse = {
    request: () => firstRequest,
    status: () => 200,
    async json() {
      assert.equal(pauseUiFlipped, true);
      await firstResponseBody;
      return { ok: true };
    },
  };
  const secondResponse = {
    request: () => secondRequest,
    status: () => 200,
    async json() {
      assert.equal(
        pauseUiFlipped,
        true,
        'the matching response body must remain observed after the following-track pause boundary',
      );
      return { ok: true };
    },
  };
  const observer = observeLastfmJourneyRequests(page);

  try {
    page.emit('request', firstRequest);
    page.emit('request', secondRequest);
    pauseUiFlipped = true;
    page.emit('response', firstResponse);
    page.emit('requestfinished', firstRequest);
    page.emit('response', secondResponse);
    page.emit('requestfinished', secondRequest);
    await Promise.resolve();
    releaseFirstResponseBody();

    await observer.waitForStableExactJourneys({
      scrobbleTitles: [],
      completionTitles: ['Second Fixture Track', 'Third Fixture Track'],
      timeout: 1000,
    });

    assert.deepEqual(
      observer.completions.map((event) => event.request.title),
      ['Second Fixture Track', 'Third Fixture Track'],
    );
  } finally {
    await observer.stop();
  }

  for (const eventName of ['request', 'response', 'requestfinished', 'requestfailed']) {
    assert.equal(page.listenerCount(eventName), 0, `${eventName} listener must be removed`);
  }
});

test('TrackModalActions waits for the exact production zoom target and settled transform', async () => {
  const { TrackModalActions } = await import('../e2e/actions/trackModalActions.js');
  const wheelCalls = [];
  let waitCallback = null;
  let waitArg = null;
  const actions = new TrackModalActions({
    lightboxImageSelector: '#image-lightbox-image',
    lightboxImage: {
      async hover() {},
      async evaluate(callback) {
        return callback({ dataset: { lightboxZoom: '1' } });
      },
    },
    page: {
      mouse: {
        async wheel(deltaX, deltaY) {
          wheelCalls.push([deltaX, deltaY]);
        },
      },
    },
    async waitForPageCondition(callback, _options, arg) {
      waitCallback = callback;
      waitArg = arg;
    },
  });

  await actions.zoomCoverLightbox({ steps: 4 });

  assert.deepEqual(wheelCalls, [[0, -120], [0, -120], [0, -120], [0, -120]]);
  assert.deepEqual(waitArg, {
    selector: '#image-lightbox-image',
    finalZoom: 1.8,
  });
  const waitSource = String(waitCallback);
  assert.match(waitSource, /dataset\.lightboxZoom/);
  assert.match(waitSource, /dataset\.lightboxTargetTransform/);
  assert.match(waitSource, /dataset\.lightboxTargetOrigin/);
  assert.match(waitSource, /getAnimations/);
  assert.match(waitSource, /DOMMatrixReadOnly/);
  assert.doesNotMatch(waitSource, /waitForTimeout|setTimeout/);
});
