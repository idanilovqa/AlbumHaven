import { expect } from '@playwright/test';

const LASTFM_JOURNEY_PATHS = new Set([
  '/playback/session/scrobble',
  '/playback/session/complete',
]);

function matchingLastfmJourneyPath(request) {
  if (!request || request.method() !== 'POST') return '';
  const pathname = new URL(request.url()).pathname;
  return LASTFM_JOURNEY_PATHS.has(pathname) ? pathname : '';
}

function journeyTitles(events) {
  return events.map((event) => String(event.request?.title || '').trim());
}

export function observeLastfmJourneyRequests(page) {
  const scrobbles = [];
  const completions = [];
  const inFlightRequests = new Map();
  const pendingResponseReads = new Set();

  const ensureLifecycle = (request, pathname = matchingLastfmJourneyPath(request)) => {
    if (!pathname) return null;
    if (!inFlightRequests.has(request)) {
      const event = {
        request: request.postDataJSON(),
        response: null,
        status: null,
      };
      const lifecycle = {
        pathname,
        event,
        requestFinished: false,
        responseBodyFinished: false,
      };
      inFlightRequests.set(request, lifecycle);
      if (pathname === '/playback/session/scrobble') {
        scrobbles.push(event);
      } else {
        completions.push(event);
      }
    }
    return inFlightRequests.get(request);
  };
  const settleLifecycle = (request) => {
    const lifecycle = inFlightRequests.get(request);
    if (lifecycle?.requestFinished && lifecycle.responseBodyFinished) {
      inFlightRequests.delete(request);
    }
  };
  const onRequest = (request) => {
    ensureLifecycle(request);
  };
  const onResponse = (response) => {
    const request = response.request();
    const pathname = matchingLastfmJourneyPath(request);
    const lifecycle = ensureLifecycle(request, pathname);
    if (!lifecycle || lifecycle.responseReadStarted) return;
    lifecycle.responseReadStarted = true;
    const responseRead = response.json().then((responsePayload) => {
      lifecycle.event.response = responsePayload;
      lifecycle.event.status = response.status();
    }).catch((error) => {
      lifecycle.event.response = { ok: false, error: error?.message || String(error) };
      lifecycle.event.status = response.status();
    }).finally(() => {
      lifecycle.responseBodyFinished = true;
      pendingResponseReads.delete(responseRead);
      settleLifecycle(request);
    });
    pendingResponseReads.add(responseRead);
  };
  const onRequestFinished = (request) => {
    const lifecycle = ensureLifecycle(request);
    if (!lifecycle) return;
    lifecycle.requestFinished = true;
    settleLifecycle(request);
  };
  const onRequestFailed = (request) => {
    const lifecycle = ensureLifecycle(request);
    if (!lifecycle) return;
    lifecycle.event.response = {
      ok: false,
      error: request.failure()?.errorText || 'Matching Last.fm journey request failed.',
    };
    lifecycle.event.status = 0;
    lifecycle.requestFinished = true;
    lifecycle.responseBodyFinished = true;
    settleLifecycle(request);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFailed);

  return {
    scrobbles,
    completions,
    async waitForStableExactJourneys({
      scrobbleTitles,
      completionTitles,
      timeout = 60000,
    }) {
      let stableExactObservations = 0;
      await expect.poll(
        () => {
          const exactCountsAndIdentities = (
            JSON.stringify(journeyTitles(scrobbles)) === JSON.stringify(scrobbleTitles)
            && JSON.stringify(journeyTitles(completions)) === JSON.stringify(completionTitles)
          );
          const quiescent = inFlightRequests.size === 0 && pendingResponseReads.size === 0;
          stableExactObservations = exactCountsAndIdentities && quiescent
            ? stableExactObservations + 1
            : 0;
          return stableExactObservations;
        },
        {
          message: 'Expected exact Last.fm journeys to remain stable after every matching request settled.',
          timeout,
          intervals: [250, 500, 750, 1000],
        },
      ).toBeGreaterThanOrEqual(2);
    },
    async stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFailed);
      await Promise.allSettled([...pendingResponseReads]);
    },
  };
}

export class TrackModalActions {
  constructor(trackModal) {
    this.trackModal = trackModal;
  }

  async readTrackCreditColorsAt(index) {
    return this.trackModal.readTrackCreditColorsAt(index);
  }

  async waitForReady(options = {}) {
    await this.trackModal.waitForPageCondition((selectors) => {
      const modal = document.querySelector(selectors.dialogSelector);
      const loadingRow = document.querySelector(selectors.loadingRowSelector);
      const trackRows = document.querySelectorAll(selectors.trackRowSelector).length;
      return modal instanceof HTMLElement && !modal.hidden && !loadingRow && trackRows > 0;
    }, {
      timeout: options.timeout || 60000,
    }, {
      dialogSelector: this.trackModal.dialogSelector,
      loadingRowSelector: this.trackModal.loadingRowSelector,
      trackRowSelector: this.trackModal.trackRowSelector,
    });
  }

  async waitForClosed(options = {}) {
    await this.trackModal.waitForHidden(this.trackModal.dialog, { timeout: options.timeout || 60000 });
  }

  async clickClose(options = {}) {
    await this.trackModal.closeButton.click(options);
  }

  async close(options = {}) {
    await this.clickClose();
    await this.waitForClosed(options);
  }

  async closeIfOpen(options = {}) {
    if (!(await this.trackModal.dialog.isVisible())) return;
    try {
      await this.clickClose({ timeout: options.actionTimeout || 1000 });
    } catch (error) {
      if (!(await this.trackModal.dialog.isVisible())) return;
      throw error;
    }
    await this.waitForClosed(options);
  }

  async pressSpaceOnFocusedCloseControl(options = {}) {
    await this.waitForLoadedSummary(options);
    await this.trackModal.closeButton.focus();
    await expect(this.trackModal.closeButton).toBeFocused();
    await this.trackModal.closeButton.press('Space');
    await this.waitForLoadedSummary(options);
    await options.afterSpace?.();
    await expect(this.trackModal.closeButton).toBeFocused();
  }

  async readSummary() {
    const albumCoverImage = this.trackModal.detailedCoverImage;
    // parity-check: allow-read-only-measurement-evaluate -- atomic decoded visible album-cover state only
    const coverLoaded = await albumCoverImage.evaluateAll((images) => images.some((image) => (
      image instanceof HTMLImageElement
      && image.complete
      && image.naturalWidth > 0
      && image.getBoundingClientRect().width > 0
      && image.getBoundingClientRect().height > 0
    )));
    const coverPlaceholderText = await this.trackModal.coverPlaceholder.isVisible()
      ? String(await this.trackModal.coverPlaceholder.textContent() || '').trim()
      : '';
    const coverPlaceholderVisible = coverPlaceholderText === 'No cover art';
    return {
      title: String(await this.trackModal.title.textContent() || '').trim(),
      subtitle: String(await this.trackModal.subtitle.textContent() || '').trim(),
      footer: String(await this.trackModal.footer.textContent() || '').trim(),
      playButtons: await this.trackModal.playButtons.count(),
      trackRows: await this.trackModal.trackRows.count(),
      coverLoaded,
      coverPlaceholderVisible,
      coverReady: coverLoaded || coverPlaceholderVisible,
    };
  }

  async waitForLoadedSummary(options = {}) {
    await this.waitForReady(options);
    await this.trackModal.waitForPageCondition((selectors) => {
      const coverImage = document.querySelector(selectors.coverImageSelector);
      const coverPlaceholder = document.querySelector(selectors.coverPlaceholderSelector);
      const coverLoaded = coverImage instanceof HTMLImageElement
        && coverImage.complete
        && coverImage.naturalWidth > 0
        && coverImage.getBoundingClientRect().width > 0
        && coverImage.getBoundingClientRect().height > 0;
      const finalNoCoverState = coverPlaceholder instanceof HTMLElement
        && !coverPlaceholder.hidden
        && coverPlaceholder.getBoundingClientRect().width > 0
        && coverPlaceholder.getBoundingClientRect().height > 0
        && String(coverPlaceholder.textContent || '').trim() === 'No cover art';
      return coverLoaded || finalNoCoverState;
    }, {
      timeout: options.coverTimeout || options.timeout || 15000,
    }, {
      coverImageSelector: this.trackModal.detailedCoverImageSelector,
      coverPlaceholderSelector: this.trackModal.coverPlaceholderSelector,
    });
    const summary = await this.readSummary();
    expect(summary.trackRows).toBeGreaterThan(0);
    expect(summary.playButtons).toBeGreaterThan(0);
    expect(summary.title).not.toEqual('');
    expect(summary.coverReady).toBe(true);
    return summary;
  }

  async waitForInteractiveSummary(options = {}) {
    await this.waitForReady(options);
    const summary = await this.readSummary();
    expect(summary.trackRows).toBeGreaterThan(0);
    expect(summary.playButtons).toBeGreaterThan(0);
    expect(summary.title).not.toEqual('');
    return summary;
  }

  async waitForTitle(expectedTitle, options = {}) {
    await expect(this.trackModal.title).toHaveText(String(expectedTitle), {
      timeout: options.timeout || 30000,
    });
    return this.readSummary();
  }

  async readReleaseTabLabels() {
    return this.trackModal.readReleaseTabLabels();
  }

  async readFooterLines() {
    return this.trackModal.readFooterLines();
  }

  async readDiscGroupPresentation() {
    return this.trackModal.readDiscGroupPresentation();
  }

  async readTrackCredits(count) {
    return Promise.all(Array.from({ length: count }, async (_, index) => {
      const [visibleCredit, rawTrack] = await Promise.all([
        this.readTrackCreditAt(index),
        this.readTrackAt(index),
      ]);
      return {
        rawTitle: rawTrack.title,
        rawArtist: rawTrack.artist,
        ...visibleCredit,
      };
    }));
  }

  async waitForExactTrackRowCount(count, options = {}) {
    await expect(this.trackModal.trackRows).toHaveCount(Number(count), {
      timeout: options.timeout || 30000,
    });
    return this.readSummary();
  }

  async readAlbumSplitCredits({
    destinationCreditCount,
    destinationAlbum,
    destinationTrackCount,
    galleryActions,
    sourceCreditCount,
    sourceAlbum,
    sourceTrackCount,
  }) {
    await this.closeIfOpen();
    await galleryActions.waitForAlbumVisible(destinationAlbum);
    await galleryActions.clickAlbumDetailsByAlbumName(destinationAlbum);
    const destinationSummary = await this.waitForExactTrackRowCount(destinationTrackCount);
    const destination = {
      credits: await this.readTrackCredits(destinationCreditCount),
      trackRows: destinationSummary.trackRows,
    };

    await this.close();
    await galleryActions.clickAlbumDetailsByAlbumName(sourceAlbum);
    const sourceSummary = await this.waitForExactTrackRowCount(sourceTrackCount);
    const source = {
      credits: await this.readTrackCredits(sourceCreditCount),
      trackRows: sourceSummary.trackRows,
    };
    return { destination, source };
  }

  async restoreAlbumSplitIfVisible({
    destinationAlbum,
    galleryActions,
    sourceAlbum,
    tagEditorActions,
  }) {
    await this.closeIfOpen();
    if (!(await galleryActions.hasVisibleAlbum(destinationAlbum))) return false;
    await galleryActions.clickAlbumDetailsByAlbumName(destinationAlbum);
    await this.waitForLoadedSummary();
    await this.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 1 });
    await tagEditorActions.setAlbumName(sourceAlbum);
    await tagEditorActions.applyAndWaitForSavedFiles();
    await this.closeIfOpen();
    return true;
  }

  async waitForCoverImageLoaded(options = {}) {
    await this.trackModal.waitForPageCondition((selectors) => {
      const coverImage = document.querySelector(selectors.coverImageSelector);
      return coverImage instanceof HTMLImageElement
        && coverImage.complete
        && coverImage.naturalWidth > 0
        && coverImage.getBoundingClientRect().width > 0
        && coverImage.getBoundingClientRect().height > 0;
    }, {
      timeout: options.timeout || options.coverTimeout || 15000,
    }, {
      coverImageSelector: this.trackModal.detailedCoverImageSelector,
    });
    const summary = await this.readSummary();
    expect(summary.coverLoaded).toBe(true);
    return summary;
  }

  async waitForDetailedCoverImageCheckpoint(options = {}) {
    await this.waitForCoverImageLoaded(options);
    return this.trackModal.readDetailedCoverImageCheckpoint();
  }

  async readTrackAt(index) {
    const row = this.trackModal.trackRowAt(index);
    const playButton = this.trackModal.playButtonAt(index);
    return {
      path: String(await row.getAttribute('data-track-row-path') || ''),
      title: String(await playButton.getAttribute('data-track-title') || ''),
      artist: String(await playButton.getAttribute('data-track-artist') || ''),
    };
  }

  async readTrackTitles() {
    // parity-check: allow-read-only-measurement-evaluate -- one atomic read of production modal track titles
    return this.trackModal.playButtons.evaluateAll((buttons) => (
      buttons.map((button) => String(button.getAttribute('data-track-title') || '').trim())
    ));
  }

  async waitForExactAlbumDetails(expected, options = {}) {
    const expectedTitle = String(expected.title || '').trim();
    const expectedTrackTitles = Array.isArray(expected.trackTitles)
      ? expected.trackTitles.map((title) => String(title || '').trim())
      : [];
    await expect(this.trackModal.title).toHaveText(expectedTitle, {
      timeout: options.timeout || 30000,
    });
    await expect(this.trackModal.trackRows).toHaveCount(expectedTrackTitles.length, {
      timeout: options.timeout || 30000,
    });
    expect(await this.readTrackTitles()).toEqual(expectedTrackTitles);
    if (Array.isArray(expected.displayedTrackNumbers)) {
      expect(await this.trackModal.readDisplayedTrackNumbers()).toEqual(
        expected.displayedTrackNumbers,
      );
    }
    return this.readSummary();
  }

  async readTrackCreditAt(index) {
    const titleElement = this.trackModal.trackTitleAt(index);
    const secondaryArtistElement = this.trackModal.secondaryArtistAt(index);
    const fullTitle = String(await titleElement.textContent() || '').trim();
    const secondaryArtist = await secondaryArtistElement.count()
      ? String(await secondaryArtistElement.textContent() || '').trim()
      : '';
    const title = secondaryArtist && fullTitle.endsWith(secondaryArtist)
      ? fullTitle.slice(0, -secondaryArtist.length).trim()
      : fullTitle;
    return { title, secondaryArtist };
  }

  async expectProblemLinkVisibleForTrack(trackTitle) {
    const trackRow = this.trackModal.trackRowByTitle(trackTitle);
    await expect(trackRow).toBeVisible();
    await expect(this.trackModal.problemButtonByTrackTitle(trackTitle)).toBeVisible();
  }

  async expectProblemLinkAbsentForTrack(trackTitle) {
    const trackRow = this.trackModal.trackRowByTitle(trackTitle);
    await expect(trackRow).toBeVisible();
    await expect(this.trackModal.problemButtonByTrackTitle(trackTitle)).toHaveCount(0);
  }

  async expectProblemLinksAbsent() {
    await expect(this.trackModal.trackRows.first()).toBeVisible();
    await expect(this.trackModal.problemButtons).toHaveCount(0);
  }

  async readTrackPathByTitle(trackTitle) {
    const trackRow = this.trackModal.trackRowByTitle(trackTitle);
    await expect(trackRow).toBeVisible();
    return String(await trackRow.getAttribute('data-track-row-path') || '');
  }

  async openProblematicFilesForTrack(trackTitle) {
    await this.trackModal.problemButtonByTrackTitle(trackTitle).click();
  }

  async openTagEditor() {
    await this.trackModal.editTagsButton.click();
  }

  async readAlbumIdentity() {
    return String(
      await this.trackModal.editTagsButton.getAttribute('data-album-key') || '',
    ).trim();
  }

  async playTrackAt(index, options = {}) {
    const track = await this.readTrackAt(index);
    const playButton = this.trackModal.playButtonAt(index);
    if (typeof options.recordClickBoundary === 'function') {
      await playButton.click({ trial: true });
      await options.recordClickBoundary(track);
    }
    await playButton.click();
    return track;
  }

  async playTrackAtAndWaitForLastfmJourney(index, options = {}) {
    const expectedTitle = String(options.title || '');
    const track = await this.readTrackAt(index);
    if (expectedTitle && track.title !== expectedTitle) {
      throw new Error(`Expected to play ${JSON.stringify(expectedTitle)}, received ${JSON.stringify(track.title)}.`);
    }
    const scrobbleResponsePromise = this.trackModal.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/playback/session/scrobble'
    ), { timeout: options.timeout || 30000 });
    const completeResponsePromise = this.trackModal.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/playback/session/complete'
    ), { timeout: options.timeout || 30000 });
    await this.trackModal.playButtonAt(index).click();
    const scrobbleResponse = await scrobbleResponsePromise;
    const scrobble = await scrobbleResponse.json();
    if (!scrobbleResponse.ok() || scrobble.ok !== true || scrobble.scrobbled !== true) {
      throw new Error(`Expected accepted Last.fm scrobble, received HTTP ${scrobbleResponse.status()}: ${JSON.stringify(scrobble)}`);
    }
    const completeResponse = await completeResponsePromise;
    const completion = await completeResponse.json();
    if (!completeResponse.ok() || completion.ok !== true) {
      throw new Error(`Expected persisted playback completion, received HTTP ${completeResponse.status()}: ${JSON.stringify(completion)}`);
    }
    return { track, scrobble, completion };
  }

  async playTrackAtAndWaitForConsecutiveLastfmJourneys(index, expectedTitles, options = {}) {
    const titles = [...expectedTitles].map((title) => String(title || '').trim()).filter(Boolean);
    if (titles.length < 2) {
      throw new Error('Consecutive Last.fm playback requires at least two expected tracks.');
    }
    for (let offset = 0; offset < titles.length; offset += 1) {
      const track = await this.readTrackAt(index + offset);
      if (track.title !== titles[offset]) {
        throw new Error(
          `Expected consecutive track ${index + offset + 1} to be `
          + `${JSON.stringify(titles[offset])}, received ${JSON.stringify(track.title)}.`,
        );
      }
    }

    const journeyObserver = observeLastfmJourneyRequests(this.trackModal.page);
    try {
      await this.trackModal.playButtonAt(index).click();
      const followingTrackButton = this.trackModal.playButtonAt(index + titles.length);
      await expect(followingTrackButton).toHaveAttribute('aria-label', 'Pause track', {
        timeout: options.timeout || 60000,
      });
      await followingTrackButton.click();
      await expect(followingTrackButton).toHaveAttribute('aria-label', 'Play track');
      await journeyObserver.waitForStableExactJourneys({
        scrobbleTitles: titles,
        completionTitles: titles,
        timeout: options.timeout || 60000,
      });
    } finally {
      await journeyObserver.stop();
    }

    for (const event of journeyObserver.scrobbles) {
      if (
        event.status < 200
        || event.status >= 300
        || event.response?.ok !== true
        || event.response?.scrobbled !== true
      ) {
        throw new Error(`Expected accepted consecutive scrobble: ${JSON.stringify(event)}.`);
      }
    }
    for (const event of journeyObserver.completions) {
      if (event.status < 200 || event.status >= 300 || event.response?.ok !== true) {
        throw new Error(`Expected persisted consecutive completion: ${JSON.stringify(event)}.`);
      }
    }
    return {
      scrobbles: journeyObserver.scrobbles,
      completions: journeyObserver.completions,
    };
  }

  async openCoverLookup() {
    await this.trackModal.coverLookupButton.click();
  }

  async openCoverLookupAndReadRequestOrder() {
    const page = this.trackModal.page;
    const requestOrder = [];
    const onRequest = (request) => {
      if (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/utilities/cover-lookup/gallery'
      ) {
        requestOrder.push('gallery-request');
      }
    };
    const onResponse = (response) => {
      if (
        response.request().method() === 'GET'
        && new URL(response.url()).pathname === '/utilities/cover-lookup/tasks'
      ) {
        requestOrder.push('tasks-response');
      }
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    try {
      const galleryRequest = page.waitForRequest((request) => (
        request.method() === 'POST'
        && new URL(request.url()).pathname === '/utilities/cover-lookup/gallery'
      ));
      const tasksResponse = page.waitForResponse((response) => (
        response.request().method() === 'GET'
        && new URL(response.url()).pathname === '/utilities/cover-lookup/tasks'
      ));
      await this.openCoverLookup();
      await Promise.all([galleryRequest, tasksResponse]);
      return requestOrder;
    } finally {
      page.off('request', onRequest);
      page.off('response', onResponse);
    }
  }

  async waitForCoverLookupImprovementIndicator(expected, options = {}) {
    const timeout = options.timeout || 30000;
    if (expected) {
      await expect(this.trackModal.coverLookupButton).toHaveClass(
        /\bhas-unseen-automatic-improvement\b/,
        { timeout },
      );
      await expect(this.trackModal.coverLookupButton).toHaveAttribute(
        'aria-label',
        /new automatic cover candidate/i,
        { timeout },
      );
      return;
    }
    await expect(this.trackModal.coverLookupButton).not.toHaveClass(
      /\bhas-unseen-automatic-improvement\b/,
      { timeout },
    );
    await expect(this.trackModal.coverLookupButton).not.toHaveAttribute(
      'aria-label',
      /new automatic cover candidate/i,
      { timeout },
    );
  }

  async startFastCoverFetch() {
    await this.trackModal.fastCoverFetchButton.click();
  }

  async openCoverLightbox(options = {}) {
    await this.trackModal.coverLightboxButton.click();
    await this.trackModal.waitForVisible(this.trackModal.lightbox, { timeout: options.timeout || 15000 });
    await this.trackModal.waitForPageCondition((selector) => {
      const image = document.querySelector(selector);
      return image instanceof HTMLImageElement
        && !image.hidden
        && image.complete
        && image.naturalWidth > 0;
    }, { timeout: options.timeout || 15000 }, this.trackModal.lightboxImageSelector);
  }

  async expectFullCoverAbovePlayer(options = {}) {
    await expect(this.trackModal.lightbox).toBeVisible({ timeout: options.timeout || 15000 });
    const checkpoint = await this.trackModal.readFullCoverLayerCheckpoint();
    expect(Math.abs(checkpoint.lightbox.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(checkpoint.lightbox.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(checkpoint.lightbox.right - checkpoint.viewport.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(checkpoint.lightbox.bottom - checkpoint.viewport.height)).toBeLessThanOrEqual(1);
    expect(checkpoint.lightbox.width).toBeGreaterThanOrEqual(checkpoint.viewport.width - 1);
    expect(checkpoint.lightbox.height).toBeGreaterThanOrEqual(checkpoint.viewport.height - 1);
    expect(checkpoint.playerCenterCoveredByLightbox).toBe(true);
    return checkpoint;
  }

  async pressSpaceOnFocusedLightboxClose(options = {}) {
    await expect(this.trackModal.lightbox).toBeVisible({ timeout: options.timeout || 15000 });
    await this.trackModal.lightboxCloseButton.focus();
    await expect(this.trackModal.lightboxCloseButton).toBeFocused();
    await this.trackModal.lightboxCloseButton.press('Space');
    await options.afterSpace?.();
    await expect(this.trackModal.lightbox).toBeVisible({ timeout: options.timeout || 15000 });
    await expect(this.trackModal.lightboxCloseButton).toBeFocused();
  }

  async expectCoverLightboxNavigationUnavailable(options = {}) {
    const timeout = options.timeout || 15000;
    await expect(this.trackModal.lightboxPreviousButton).toBeHidden({ timeout });
    await expect(this.trackModal.lightboxPreviousButton).toBeDisabled({ timeout });
    await expect(this.trackModal.lightboxNextButton).toBeHidden({ timeout });
    await expect(this.trackModal.lightboxNextButton).toBeDisabled({ timeout });
  }

  async expectCoverLightboxNavigationAvailable(options = {}) {
    const timeout = options.timeout || 15000;
    await expect(this.trackModal.lightboxPreviousButton).toBeVisible({ timeout });
    await expect(this.trackModal.lightboxPreviousButton).toBeEnabled({ timeout });
    await expect(this.trackModal.lightboxNextButton).toBeVisible({ timeout });
    await expect(this.trackModal.lightboxNextButton).toBeEnabled({ timeout });
  }

  async readCoverLightboxSources() {
    return this.trackModal.readCoverLightboxSources();
  }

  async zoomCoverLightbox(options = {}) {
    const steps = Math.max(1, Number(options.steps || 4));
    await this.trackModal.lightboxImage.hover();
    // parity-check: allow-read-only-measurement-evaluate -- reads the production zoom state only
    const initialZoom = await this.trackModal.lightboxImage.evaluate((image) => (
      Number(image.dataset.lightboxZoom || 1)
    ));
    let expectedZoom = Number.isFinite(initialZoom) ? initialZoom : 1;
    for (let index = 0; index < steps; index += 1) {
      const step = expectedZoom < 2 ? 0.2 : 0.35;
      expectedZoom = Math.round(Math.min(5, expectedZoom + step) * 1000) / 1000;
      await this.trackModal.page.mouse.wheel(0, -120);
    }
    await this.trackModal.waitForPageCondition(({ selector, finalZoom }) => {
      const image = document.querySelector(selector);
      if (!(image instanceof HTMLImageElement) || !image.classList.contains('is-zoomed')) return false;
      if (Number(image.dataset.lightboxZoom) !== finalZoom) return false;
      if (image.style.transform !== image.dataset.lightboxTargetTransform) return false;
      if (image.style.transformOrigin !== image.dataset.lightboxTargetOrigin) return false;
      if (image.getAnimations().some((animation) => (
        animation.playState === 'running' || animation.playState === 'pending'
      ))) return false;
      const computedTransform = getComputedStyle(image).transform;
      const matrix = new DOMMatrixReadOnly(computedTransform === 'none' ? undefined : computedTransform);
      return Math.abs(matrix.a - finalZoom) < 0.000001
        && Math.abs(matrix.d - finalZoom) < 0.000001;
    }, { timeout: options.timeout || 15000 }, {
      selector: this.trackModal.lightboxImageSelector,
      finalZoom: expectedZoom,
    });
  }

  async closeCoverLightbox(options = {}) {
    await this.trackModal.lightboxCloseButton.click();
    await this.trackModal.waitForHidden(this.trackModal.lightbox, { timeout: options.timeout || 15000 });
  }
}
