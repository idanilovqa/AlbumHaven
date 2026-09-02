import { expect } from '@playwright/test';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';

export function evaluateMountedAlbumWindowTransition({
  editedAlbumNames,
  initialCards,
  settledCards,
}) {
  const editedNames = editedAlbumNames instanceof Set
    ? editedAlbumNames
    : new Set(editedAlbumNames || []);
  const toIdentity = (card) => ({
    album: card.album,
    key: card.key,
    nodeId: card.nodeId,
    year: card.year,
  });
  const isEdited = (card) => editedNames.has(String(card.album || '').trim());
  const initialUnrelated = (initialCards || []).filter((card) => !isEdited(card));
  const settledUnrelated = (settledCards || []).filter((card) => !isEdited(card));
  const initialKeys = new Set(initialUnrelated.map((card) => card.key));
  const settledKeys = new Set(settledUnrelated.map((card) => card.key));
  const sharedInitial = initialUnrelated
    .filter((card) => settledKeys.has(card.key))
    .map(toIdentity);
  const sharedSettled = settledUnrelated
    .filter((card) => initialKeys.has(card.key))
    .map(toIdentity);
  const removed = initialUnrelated
    .filter((card) => !settledKeys.has(card.key))
    .map(toIdentity);
  const added = settledUnrelated
    .filter((card) => !initialKeys.has(card.key))
    .map(toIdentity);
  const suffixKeys = (cards, count) => (
    count > 0 ? cards.slice(-count).map((card) => card.key) : []
  );
  const initialEditedCount = (initialCards || []).filter(isEdited).length;
  const settledEditedCount = (settledCards || []).filter(isEdited).length;
  return {
    added,
    addedAtSuffix: JSON.stringify(added.map((card) => card.key))
      === JSON.stringify(suffixKeys(settledUnrelated, added.length)),
    boundaryChangeBudget: Math.abs(settledEditedCount - initialEditedCount),
    boundaryChangeCount: added.length + removed.length,
    removed,
    removedAtSuffix: JSON.stringify(removed.map((card) => card.key))
      === JSON.stringify(suffixKeys(initialUnrelated, removed.length)),
    sharedInitial,
    sharedSettled,
  };
}

export function readVisibleGalleryCoverReadiness(selectors) {
  const toRect = (rect) => ({
    left: Number(rect.left || 0),
    top: Number(rect.top || 0),
    right: Number(rect.right || 0),
    bottom: Number(rect.bottom || 0),
    width: Number(rect.width || 0),
    height: Number(rect.height || 0),
  });
  const intersects = (rect, viewport) => (
    rect.width > 0
    && rect.height > 0
    && viewport.width > 0
    && viewport.height > 0
    && rect.right > viewport.left
    && rect.left < viewport.right
    && rect.bottom > viewport.top
    && rect.top < viewport.bottom
  );
  const galleryScroll = document.querySelector(selectors.galleryScrollSelector);
  const scrollerRect = galleryScroll instanceof HTMLElement
    ? toRect(galleryScroll.getBoundingClientRect())
    : null;
  const ready = [];
  const unready = [];
  const excluded = [];

  for (const [index, card] of Array.from(document.querySelectorAll(selectors.albumCardSelector)).entries()) {
    if (!(card instanceof HTMLElement)) continue;
    const cardRect = toRect(card.getBoundingClientRect());
    const titleNode = card.querySelector(selectors.titleSelector);
    const title = String(
      titleNode?.textContent
      || card.getAttribute('data-gallery-card-key')
      || `album card ${index + 1}`,
    ).trim();
    const coverImage = card.querySelector(selectors.coverImageSelector);
    const placeholder = card.querySelector(selectors.coverPlaceholderSelector);
    const visual = coverImage instanceof HTMLImageElement
      ? coverImage
      : (placeholder instanceof HTMLElement ? placeholder : null);
    if (!(visual instanceof HTMLElement)) {
      excluded.push({
        title,
        reason: 'cover visual missing',
        cardRect,
        visualRect: null,
      });
      continue;
    }
    const visualRect = toRect(visual.getBoundingClientRect());
    const visualIntersects = scrollerRect !== null && intersects(visualRect, scrollerRect);
    if (
      !(visualRect.width > 0 && visualRect.height > 0)
      || (selectors.requireVisible && !visualIntersects)
    ) {
      excluded.push({
        title,
        reason: !(visualRect.width > 0 && visualRect.height > 0)
          ? 'cover visual has no rendered area'
          : 'cover visual outside gallery viewport',
        cardRect,
        visualRect,
      });
      continue;
    }

    const entry = {
      title,
      kind: coverImage instanceof HTMLImageElement ? 'image' : 'placeholder',
      cardRect,
      visualRect,
      visualState: String(visual.getAttribute('data-cover-visual-state') || ''),
      ariaHidden: String(visual.getAttribute('aria-hidden') || ''),
    };
    let isReady = false;
    let reason = '';
    if (coverImage instanceof HTMLImageElement) {
      Object.assign(entry, {
        complete: Boolean(coverImage.complete),
        naturalWidth: Number(coverImage.naturalWidth || 0),
        currentSrc: String(coverImage.currentSrc || ''),
        productionSrc: String(coverImage.getAttribute('data-production-cover-src') || '').trim(),
        loading: String(coverImage.getAttribute('loading') || ''),
      });
      isReady = coverImage.complete && coverImage.naturalWidth > 0;
      reason = isReady ? 'decoded image' : 'image pending decode';
      if (isReady && selectors.requireLocalImage) {
        try {
          const url = new URL(entry.productionSrc, window.location.href);
          isReady = Boolean(entry.productionSrc)
            && url.origin === window.location.origin
            && url.pathname === '/cover';
          reason = isReady ? 'decoded local image' : 'decoded image lacks local cover authority';
        } catch {
          isReady = false;
          reason = 'invalid production cover source';
        }
      }
    } else {
      const style = globalThis.getComputedStyle(placeholder);
      const deferred = placeholder.classList.contains('cover-placeholder-deferred');
      const visiblyStyled = style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.visibility !== 'collapse'
        && Number(style.opacity || 1) > 0;
      Object.assign(entry, {
        deferred,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
      });
      isReady = selectors.allowPlaceholder && !deferred && visiblyStyled;
      reason = isReady ? 'final visible placeholder' : 'placeholder is not an allowed final state';
    }
    (isReady ? ready : unready).push({ ...entry, reason });
  }

  const schedulerSource = globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ || {};
  const scheduler = Object.fromEntries(
    Object.entries(schedulerSource)
      .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)),
  );
  const candidateCount = ready.length + unready.length;
  const result = selectors.requireVisible && scrollerRect === null
    ? false
    : (
      candidateCount >= selectors.minimumCount
      && (
        selectors.allowPlaceholder
          ? ready.length >= selectors.minimumCount
          : unready.length === 0
      )
    );
  if (!selectors.snapshot) return result;
  return {
    result,
    candidateCount,
    readyCount: ready.length,
    unreadyCount: unready.length,
    scrollerRect,
    ready,
    unready,
    excluded,
    scheduler,
  };
}

export function planGalleryScrollAway(scrollState) {
  const maxScrollTop = Math.max(0, Number(scrollState?.maxScrollTop || 0));
  const currentScrollPosition = Math.min(maxScrollTop, Math.max(0, Number(scrollState?.scrollTop || 0)));
  const clientHeight = Math.max(0, Number(scrollState?.clientHeight || 0));
  const availableAbove = currentScrollPosition;
  const availableBelow = maxScrollTop - currentScrollPosition;
  const direction = availableBelow >= availableAbove ? 1 : -1;
  const availableDistance = direction > 0 ? availableBelow : availableAbove;
  if (!(availableDistance >= 1)) {
    throw new Error('Gallery cannot move away from the target album in either direction.');
  }
  return {
    deltaY: direction * Math.max(maxScrollTop, clientHeight, 1),
    direction,
    minimumScrollDelta: Math.min(120, availableDistance),
  };
}

export function classifyGalleryAlbumTargetState(snapshot = {}) {
  const expectedArtist = String(snapshot.expectedArtist || '').trim();
  const expectedAlbum = String(snapshot.expectedAlbum || '').trim();
  const expectedQuery = String(snapshot.expectedQuery || '').trim();
  const retryableChecks = [
    [Boolean(String(snapshot.activeRequestUrl || '').trim()), 'active request'],
    [Boolean(snapshot.busy), 'busy runtime'],
    [Boolean(snapshot.activeLoader), 'active loader'],
    [Boolean(snapshot.pendingViewTransition), 'pending view transition'],
    [String(snapshot.inputQuery || '').trim() !== expectedQuery, 'input query mismatch'],
    [String(snapshot.locationQuery || '').trim() !== expectedQuery, 'location query mismatch'],
    [String(snapshot.canonicalQuery || '').trim() !== expectedQuery, 'canonical query mismatch'],
    [Boolean(snapshot.startupHydrating), 'startup hydration'],
    [snapshot.canonicalApplied === false, 'canonical result not applied'],
    [Boolean(snapshot.canonicalMatch) && !snapshot.attachedMatch, 'canonical match awaiting virtual attachment'],
  ];
  const retryable = retryableChecks.find(([matches]) => matches);
  if (retryable) {
    return { status: 'retryable', reason: retryable[1] };
  }
  if (snapshot.canonicalMatch && snapshot.attachedMatch) {
    return { status: 'ready', reason: 'expected album attached' };
  }

  const observedState = { ...snapshot };
  const error = new Error(
    `Settled gallery cannot satisfy expected album "${expectedAlbum}" for artist "${expectedArtist}". `
    + `Observed state: ${JSON.stringify(observedState)}`,
  );
  error.observedState = observedState;
  throw error;
}

export class GalleryActions {
  constructor(galleryPage) {
    this.galleryPage = galleryPage;
  }

  async goto(pathname = '/?surface=albums') {
    await this.galleryPage.goto(pathname);
  }

  async clickFirstAlbumDetails() {
    await this.galleryPage.albumDetailsButtons.first().click();
  }

  async clickAlbumDetailsAt(index) {
    await this.galleryPage.albumCard.detailsButtonAt(index).click();
  }

  async clickAlbumDetailsByAlbumName(albumName) {
    await this.galleryPage.albumCard.detailsButtonByAlbumName(albumName).first().click();
  }

  async waitForGalleryReady(options = {}) {
    const minimumCards = options.minimumCards === undefined
      ? 1
      : Math.max(1, Number(options.minimumCards) || 1);
    await this.galleryPage.waitForVisible(this.galleryPage.albumCards.first(), { timeout: options.timeout || 60000 });
    await this.galleryPage.waitForPageCondition((selectors) => {
      const visibleCards = Array.from(document.querySelectorAll(selectors.albumCardSelector))
        .filter((card) => {
          if (!(card instanceof HTMLElement) || card.hidden) return false;
          const bounds = card.getBoundingClientRect();
          return bounds.width > 0 && bounds.height > 0;
        });
      const metrics = window.__ALBUM_HAVEN_STARTUP_METRICS__ || {};
      const refreshFinished = Boolean(metrics.initialRefreshCompleted)
        || Boolean(metrics.marks?.initial_refresh_complete);
      const libraryLoader = document.querySelector(selectors.libraryLoaderSelector);
      const loaderHidden = !(libraryLoader instanceof HTMLElement) || libraryLoader.hidden;
      return visibleCards.length >= selectors.minimumCards && refreshFinished && loaderHidden;
    }, {
      timeout: options.timeout || 60000,
    }, {
      albumCardSelector: this.galleryPage.albumCard.cardSelector,
      libraryLoaderSelector: this.galleryPage.libraryLoaderSelector,
      minimumCards,
    });
  }

  async expectCentralLoaderHidden(options = {}) {
    await expect(this.galleryPage.libraryLoader).toBeHidden({
      timeout: options.timeout || 30000,
    });
  }

  async waitForVisibleGalleryCoversLoaded(options = {}) {
    const minimumCount = Number(options.minimumCount || 6);
    const requireVisible = options.requireVisible ?? true;
    const allowPlaceholder = options.allowPlaceholder === true;
    const placeholderScenario = String(options.placeholderScenario || '').trim();
    if (allowPlaceholder && !placeholderScenario) {
      throw new Error('allowPlaceholder requires a named placeholderScenario for an intentional no-art fixture.');
    }
    const requireLocalImage = options.requireLocalImage ?? process.env.PLAYWRIGHT_REAL_APP === '1';
    const selectors = {
      albumCardSelector: this.galleryPage.albumCard.cardSelector,
      coverImageSelector: this.galleryPage.albumCard.coverImageWithinCardSelector,
      coverPlaceholderSelector: this.galleryPage.albumCard.coverPlaceholderWithinCardSelector,
      titleSelector: this.galleryPage.albumCard.titleButtonSelector,
      galleryScrollSelector: this.galleryPage.galleryScrollSelector,
      minimumCount,
      requireVisible,
      allowPlaceholder,
      requireLocalImage,
    };
    try {
      await this.galleryPage.waitForPageCondition(readVisibleGalleryCoverReadiness, {
        timeout: options.timeout || 60000,
      }, selectors);
    } catch (error) {
      let snapshot = { error: 'readiness snapshot unavailable' };
      try {
        // parity-check: allow-read-only-measurement-evaluate -- failure-only cover readiness diagnostics
        snapshot = await this.galleryPage.page.evaluate(
          readVisibleGalleryCoverReadiness,
          { ...selectors, snapshot: true },
        );
      } catch (snapshotError) {
        snapshot = { error: String(snapshotError?.message || snapshotError) };
      }
      throw new Error(
        `Visible gallery covers did not become ready. ${JSON.stringify(snapshot)}`,
        { cause: error },
      );
    }
  }

  async waitForInitialAllArtistsSections(options = {}) {
    await this.galleryPage.waitForPageCondition((selectors) => {
      const galleryScroll = document.querySelector(selectors.galleryScrollSelector);
      const headings = document.querySelectorAll(selectors.artistHeadingSelector).length;
      const sidebarArtists = document.querySelectorAll(selectors.sidebarArtistSelector).length;
      const allArtistsActiveLink = document.querySelector(selectors.allArtistsActiveSelector);
      const locationSearch = String(location.search || '');
      const expectedQuery = String(selectors.expectedQuery || '');
      const queryMatches = !expectedQuery || locationSearch.includes(`q=${encodeURIComponent(expectedQuery)}`);
      const scrolls = !(galleryScroll instanceof HTMLElement)
        ? false
        : galleryScroll.scrollHeight > galleryScroll.clientHeight;
      return !location.search.includes('artist=')
        && queryMatches
        && allArtistsActiveLink instanceof HTMLElement
        && headings >= 1
        && (headings >= selectors.minimumHeadingCount || sidebarArtists >= selectors.minimumHeadingCount)
        && galleryScroll instanceof HTMLElement
        && (
          !selectors.requireScrollable
          || scrolls
        );
    }, {
      timeout: options.timeout || 30000,
    }, {
      galleryScrollSelector: this.galleryPage.galleryScrollSelector,
      artistHeadingSelector: this.galleryPage.artistHeadingSelector,
      sidebarArtistSelector: this.galleryPage.sidebarArtistSelector,
      allArtistsActiveSelector: this.galleryPage.allArtistsActiveSelector,
      minimumHeadingCount: Number(options.minimumHeadingCount || 4),
      expectedQuery: String(options.expectedQuery || ''),
      requireScrollable: options.requireScrollable !== false,
    });
  }

  async readInitialAllArtistsReadinessSnapshot(options = {}) {
    const galleryScrollPresent = await this.galleryPage.galleryScroll.count() > 0;
    const scrollMetrics = galleryScrollPresent ? await this.readGalleryScrollState() : {
      scrollTop: 0,
      clientHeight: 0,
      maxScrollTop: 0,
    };
    // parity-check: allow-read-only-measurement-evaluate -- runtime startup telemetry read only
    const runtime = await this.galleryPage.page.evaluate(() => ({
      appBusy: Boolean(globalThis.appState?.busy),
      activeViewRequestUrl: String(globalThis.appState?.ui?.activeViewRequestUrl || ''),
      startupMarkNames: Object.keys(globalThis.__ALBUM_HAVEN_STARTUP_METRICS__?.marks || {}).sort(),
    }));
    const locationSearch = new URL(this.galleryPage.page.url()).search;
    const expectedQuery = String(options.expectedQuery || '');
    const scrollHeight = scrollMetrics.clientHeight + scrollMetrics.maxScrollTop;
    return {
      locationSearch,
      queryMatches: !expectedQuery || locationSearch.includes(`q=${encodeURIComponent(expectedQuery)}`),
      allArtistsActive: await this.galleryPage.allArtistsActiveLink.count() > 0,
      headingCount: await this.galleryPage.artistHeadings.count(),
      sidebarArtistCount: await this.galleryPage.sidebarArtists.count(),
      minimumHeadingCount: Number(options.minimumHeadingCount || 4),
      galleryScrollPresent,
      scrollHeight,
      clientHeight: scrollMetrics.clientHeight,
      scrolls: scrollMetrics.maxScrollTop > 0,
      requireScrollable: options.requireScrollable !== false,
      ...runtime,
    };
  }

  async waitForInitialRefreshCompleted(options = {}) {
    await this.galleryPage.waitForPageCondition(() => {
      const metrics = window.__ALBUM_HAVEN_STARTUP_METRICS__ || {};
      return Boolean(metrics.initialRefreshCompleted) || Boolean(metrics.marks?.initial_refresh_complete);
    }, {
      timeout: options.timeout || 60000,
    });
  }

  async waitForInitialVisibleRefreshCompleted(options = {}) {
    await this.galleryPage.waitForPageCondition(() => {
      const metrics = window.__ALBUM_HAVEN_STARTUP_METRICS__ || {};
      return Boolean(metrics.initialVisibleRefreshCompleted)
        || Boolean(metrics.marks?.initial_visible_refresh_complete)
        || Boolean(metrics.initialRefreshCompleted)
        || Boolean(metrics.marks?.initial_refresh_complete);
    }, {
      timeout: options.timeout || 60000,
    });
  }

  async waitForSelectedArtistGallery(artistName, options = {}) {
    await this.galleryPage.waitForPageCondition((selectors) => {
      const headings = Array.from(document.querySelectorAll(selectors.artistHeadingSelector))
        .map((element) => (element.textContent || '').trim())
        .filter(Boolean);
      const activeLink = document.querySelector(selectors.activeSidebarLinkSelector);
      const activeText = (activeLink?.textContent || '').trim();
      const hasMatchingHeading = headings.includes(selectors.expectedArtist);
      const hasArtistParam = location.search.includes(`artist=${encodeURIComponent(selectors.expectedArtist)}`);
      const hasMatchingSidebarSelection = activeText.includes(selectors.expectedArtist);
      const hasDerivedSearchSelection = Boolean(location.search.includes(`q=${encodeURIComponent(selectors.queryValue)}`) && hasMatchingHeading);
      if (selectors.requireExclusiveView) {
        return headings.length === 1 && headings[0] === selectors.expectedArtist && (hasArtistParam || hasMatchingSidebarSelection);
      }
      if (selectors.requireArtistQuery) {
        return hasMatchingHeading && hasArtistParam;
      }
      return hasMatchingHeading && (hasArtistParam || hasMatchingSidebarSelection || hasDerivedSearchSelection);
    }, {
      timeout: options.timeout || 30000,
    }, {
      artistHeadingSelector: this.galleryPage.artistHeadingSelector,
      expectedArtist: artistName,
      activeSidebarLinkSelector: '#sidebar-list .artist-link.active',
      queryValue: String(options.queryValue || artistName),
      requireExclusiveView: Boolean(options.requireExclusiveView),
      requireArtistQuery: Boolean(options.requireArtistQuery),
    });
  }

  async readArtistHeadings() {
    return this.galleryPage.artistHeadings.allTextContents();
  }

  async readArtistHeadingOccurrencesAcrossGallery(options = {}) {
    const occurrencesBySection = new Map();
    const readMountedOccurrences = async () => {
      // parity-check: allow-read-only-measurement-evaluate -- inventory mounted virtual artist sections
      const mounted = await this.galleryPage.page.evaluate((selectors) => (
        Array.from(document.querySelectorAll(selectors.artistHeadingSelector))
          .map((heading) => {
            const section = heading.closest('[data-virtual-section-key]');
            return {
              artist: String(heading.textContent || '').trim(),
              sectionKey: String(section?.getAttribute('data-virtual-section-key') || '').trim(),
            };
          })
          .filter((entry) => entry.artist && entry.sectionKey)
      ), {
        artistHeadingSelector: this.galleryPage.artistHeadingSelector,
      });
      mounted.forEach((entry) => occurrencesBySection.set(entry.sectionKey, entry));
    };

    let scrollState = await this.readGalleryScrollState();
    if (scrollState.scrollTop > 2) {
      await this.scrollGalleryBy(-scrollState.scrollTop);
      await this.galleryPage.waitForGalleryScrollMovement(scrollState.scrollTop, -1, {
        timeout: options.timeout || 30000,
      });
      await this.waitForGalleryScrollAtStart({ timeout: options.timeout || 30000 });
      scrollState = await this.readGalleryScrollState();
    }

    await readMountedOccurrences();
    while (scrollState.scrollTop < scrollState.maxScrollTop - 2) {
      const previousScrollTop = scrollState.scrollTop;
      const deltaY = Math.max(1, Math.floor(scrollState.clientHeight * 0.8));
      await this.scrollGalleryBy(deltaY);
      await this.galleryPage.waitForGalleryScrollMovement(previousScrollTop, 1, {
        timeout: options.timeout || 30000,
      });
      scrollState = await this.readGalleryScrollState();
      await readMountedOccurrences();
    }

    return [...occurrencesBySection.values()];
  }

  async readSectionLabels() {
    return this.galleryPage.sectionLabels.allTextContents();
  }

  async waitForArtistHeadings(expectedArtists, options = {}) {
    await this.galleryPage.waitForPageCondition((selectors) => {
      const headings = Array.from(document.querySelectorAll(selectors.artistHeadingSelector))
        .map((element) => (element.textContent || '').trim())
        .filter(Boolean);
      return selectors.expectedArtists.every((expectedArtist) => headings.includes(expectedArtist));
    }, {
      timeout: options.timeout || 30000,
    }, {
      artistHeadingSelector: this.galleryPage.artistHeadingSelector,
      expectedArtists,
    });
  }

  async waitForOnlyArtistHeadings(expectedArtists, options = {}) {
    await this.galleryPage.waitForPageCondition((selectors) => {
      const headings = Array.from(document.querySelectorAll(selectors.artistHeadingSelector))
        .map((element) => (element.textContent || '').trim())
        .filter(Boolean);
      if (!headings.length) return false;
      return headings.length === selectors.expectedArtists.length
        && selectors.expectedArtists.every((expectedArtist) => headings.includes(expectedArtist));
    }, {
      timeout: options.timeout || 30000,
    }, {
      artistHeadingSelector: this.galleryPage.artistHeadingSelector,
      expectedArtists,
    });
  }

  async waitForDisplayedArtistSections(expectedArtists, options = {}) {
    const observedArtists = new Set();
    const timeout = Number(options.timeout || 60000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const visibleArtists = (await this.galleryPage.artistHeadings.allTextContents())
        .map((artist) => artist.trim())
        .filter(Boolean);
      visibleArtists.forEach((artist) => observedArtists.add(artist));
      if (expectedArtists.every((expectedArtist) => observedArtists.has(expectedArtist))) {
        return;
      }
      const scrollState = await this.readGalleryScrollState();
      if (!(scrollState.maxScrollTop > 0)) {
        break;
      }
      const atBottom = scrollState.scrollTop >= scrollState.maxScrollTop - 2;
      const deltaY = atBottom
        ? -scrollState.maxScrollTop
        : Math.max(120, Math.floor(scrollState.clientHeight * 0.8));
      await this.scrollGalleryBy(deltaY);
    }
    throw new Error(`Expected gallery sections were not displayed: ${expectedArtists.join(', ')}`);
  }

  async waitForAlbumVisible(albumName, options = {}) {
    await this.galleryPage.waitForVisible(
      this.galleryPage.albumCard.cardByAlbumName(albumName).first(),
      { timeout: options.timeout || 30000 },
    );
  }

  async hasVisibleAlbum(albumName) {
    return this.galleryPage.hasVisibleAlbum(albumName);
  }

  async waitForAlbumHidden(albumName, options = {}) {
    await this.galleryPage.waitForHidden(
      this.galleryPage.albumCard.cardByAlbumName(albumName).first(),
      { timeout: options.timeout || 30000 },
    );
  }

  async waitForAlbumCountByHeading(artistName, expectedAlbumCount, options = {}) {
    await this.galleryPage.waitForPageCondition((selectors) => {
      const sections = Array.from(document.querySelectorAll(selectors.artistSectionSelector));
      const section = sections.find((element) => {
        const heading = element.querySelector(selectors.artistHeadingSelector);
        return (heading?.textContent || '').trim() === selectors.artistName;
      });
      if (!(section instanceof HTMLElement)) return false;
      return section.querySelectorAll(selectors.albumCardSelector).length === selectors.expectedAlbumCount;
    }, {
      timeout: options.timeout || 30000,
    }, {
      artistSectionSelector: '#artist-groups .artist-section',
      artistHeadingSelector: this.galleryPage.artistHeadingSelector,
      albumCardSelector: this.galleryPage.albumCard.cardSelector,
      artistName,
      expectedAlbumCount: Number(expectedAlbumCount),
    });
  }

  async waitForMinimumAlbumCountByHeading(artistName, minimumAlbumCount, options = {}) {
    await this.galleryPage.waitForPageCondition((selectors) => {
      const sections = Array.from(document.querySelectorAll(selectors.artistSectionSelector));
      const section = sections.find((element) => {
        const heading = element.querySelector(selectors.artistHeadingSelector);
        return (heading?.textContent || '').trim() === selectors.artistName;
      });
      if (!(section instanceof HTMLElement)) return false;
      return section.querySelectorAll(selectors.albumCardSelector).length
        >= selectors.minimumAlbumCount;
    }, {
      timeout: options.timeout || 30000,
    }, {
      artistSectionSelector: '#artist-groups .artist-section',
      artistHeadingSelector: this.galleryPage.artistHeadingSelector,
      albumCardSelector: this.galleryPage.albumCard.cardSelector,
      artistName,
      minimumAlbumCount: Number(minimumAlbumCount),
    });
  }

  async readAlbumNamesByHeading(artistName) {
    return (await this.galleryPage.sectionByArtistHeading(artistName)
      .locator(this.galleryPage.albumTitleButtonWithinSectionSelector)
      .allTextContents())
      .map((albumName) => albumName.trim())
      .filter(Boolean);
  }

  async waitForPositiveRenderedAlbumCardTrackCounts(expected, options = {}) {
    const artist = String(expected.artist || '').trim();
    const album = String(expected.album || '').trim();
    const year = String(expected.year || '').trim();
    const targetTrackCount = Number(expected.trackCount);
    let lastSummaries = [];
    await expect.poll(async () => {
      lastSummaries = await this.galleryPage.readRenderedAlbumCardTrackCounts(artist);
      const targetSummary = lastSummaries.find((summary) => (
        summary.album === album && summary.year === year
      ));
      return {
        allPositive: lastSummaries.length > 0
          && lastSummaries.every((summary) => summary.trackCount > 0),
        targetTrackCount: Number(targetSummary?.trackCount ?? -1),
      };
    }, {
      message: `Expected every rendered ${artist} album card to keep a positive track count `
        + `and ${album} (${year}) to show ${targetTrackCount} tracks. `
        + `Last summaries: ${JSON.stringify(lastSummaries)}`,
      timeout: Number(options.timeout || 10000),
      intervals: [50, 100, 250],
    }).toEqual({
      allPositive: true,
      targetTrackCount,
    });
    return lastSummaries;
  }

  async readCurrentProductionVisibleAlbumObservation(
    artistName,
    expectedIdentities,
    options = {},
  ) {
    const expected = expectedIdentities.map((identity) => ({
      album: String(identity.album || '').trim(),
      year: String(identity.year || '').trim(),
    })).sort((left, right) => (
      left.album.localeCompare(right.album) || left.year.localeCompare(right.year)
    ));
    const scroll = await this.readGalleryScrollState();
    const observation = await this.galleryPage.readProductionVisibleAlbumObservation(
      artistName,
      [...new Set(expected.map(({ album }) => album))],
    );
    const renderedIdentities = observation.renderedIdentities.map((identity) => ({
      album: String(identity.album || '').trim(),
      year: String(identity.year || '').trim(),
    })).sort((left, right) => (
      left.album.localeCompare(right.album) || left.year.localeCompare(right.year)
    ));
    expect(
      renderedIdentities,
      `Expected every provided ${artistName} album identity to be rendered in the current optimistic window`,
    ).toEqual(expected);
    if (options.expectedAlbumCount !== undefined) {
      expect(
        Number(observation.albumCount),
        `Expected the visible ${artistName} album count after the optimistic edit.`,
      ).toBe(Number(options.expectedAlbumCount));
    }
    return {
      albumCount: Number(observation.albumCount),
      renderedIdentities,
      scroll,
    };
  }

  async waitForAlbumIdentityTopology(artistName, expectedIdentities, options = {}) {
    const expected = expectedIdentities.map((identity) => ({
      album: String(identity.album || '').trim(),
      year: String(identity.year || '').trim(),
    })).sort((left, right) => (
      left.album.localeCompare(right.album) || left.year.localeCompare(right.year)
    ));
    const scroll = await this.readGalleryScrollState();
    const expectedAlbumNames = [...new Set(expected.map(({ album }) => album))];
    const timeout = Number(options.timeout || 30000);
    const deadline = Date.now() + timeout;
    let lastGeneration = null;
    let lastObserved = [];
    let retryRequiresScrollReset = false;
    while (Date.now() <= deadline) {
      if (retryRequiresScrollReset) {
        await this.restoreGalleryScrollPosition(scroll.scrollTop, {
          timeout: Math.max(1, deadline - Date.now()),
        });
        retryRequiresScrollReset = false;
      }
      const generationBefore = this.galleryPage.readViewGenerationState();
      if (!generationBefore.settled) {
        lastGeneration = { before: generationBefore, after: null };
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const renderedCards = new Map();
      for (const identity of expected) {
        await this.scrollToAlbumUnderHeading(artistName, identity.album, {
          waitAtBoundary: options.waitAtBoundary === true,
          year: identity.year,
        });
        const windowIdentities = await this.galleryPage.readRenderedAlbumIdentities(
          artistName,
          expectedAlbumNames,
        );
        for (const renderedIdentity of windowIdentities) {
          const topologyKey = `${renderedIdentity.album}\u0000${renderedIdentity.year}`;
          renderedCards.set(topologyKey, {
            album: renderedIdentity.album,
            year: renderedIdentity.year,
          });
        }
      }
      const generationAfter = this.galleryPage.readViewGenerationState();
      lastGeneration = { before: generationBefore, after: generationAfter };
      if (
        generationBefore.revision !== generationAfter.revision
        || !generationAfter.settled
      ) {
        retryRequiresScrollReset = true;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const observed = [...renderedCards.values()].sort((left, right) => (
        left.album.localeCompare(right.album) || left.year.localeCompare(right.year)
      ));
      lastObserved = observed;
      if (JSON.stringify(observed) === JSON.stringify(expected)) {
        return {
          identities: expected,
          scroll,
        };
      }
      retryRequiresScrollReset = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(
      lastObserved,
      `Timed out after ${timeout} ms waiting for exact rendered album identity topology for `
      + `${artistName}. Last production view generation: ${JSON.stringify(lastGeneration)}.`,
    ).toEqual(expected);
  }

  async restoreGalleryScrollPosition(targetScrollTop, options = {}) {
    const target = Math.max(0, Number(targetScrollTop || 0));
    const timeout = Number(options.timeout || 10000);
    const maxScrollActions = Math.max(1, Number(options.maxActions || 8));
    const deadline = Date.now() + timeout;
    let scrollActions = 0;
    let scrollState = await this.readGalleryScrollState();
    let reachableTarget = Math.min(target, scrollState.maxScrollTop);
    while (
      Math.abs(scrollState.scrollTop - reachableTarget) > 2
      && Date.now() <= deadline
      && scrollActions < maxScrollActions
    ) {
      const deltaY = reachableTarget - scrollState.scrollTop;
      const direction = deltaY < 0 ? -1 : 1;
      await this.scrollGalleryBy(deltaY);
      await this.galleryPage.waitForGalleryScrollMovement(
        scrollState.scrollTop,
        direction,
        { timeout: Math.max(1, deadline - Date.now()) },
      );
      scrollActions += 1;
      scrollState = await this.readGalleryScrollState();
      reachableTarget = Math.min(target, scrollState.maxScrollTop);
    }
    if (Math.abs(scrollState.scrollTop - reachableTarget) > 2) {
      throw new Error(
        `Timed out after ${timeout} ms restoring the gallery from ${scrollState.scrollTop} `
        + `to reachable target ${reachableTarget} with ${scrollActions} of `
        + `${maxScrollActions} production wheel actions.`,
      );
    }
    return scrollState;
  }

  async waitForAlbumVisibleUnderHeading(artistName, albumName, options = {}) {
    const timeout = Number(options.timeout || 30000);
    const deadline = Date.now() + timeout;
    let lastSnapshot = null;
    while (Date.now() <= deadline) {
      lastSnapshot = await this.galleryPage.readAlbumTargetState({
        artist: artistName,
        album: albumName,
        query: options.expectedQuery,
      });
      const classification = classifyGalleryAlbumTargetState(lastSnapshot);
      if (classification.status === 'ready') return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out after ${timeout} ms waiting for album "${albumName}" under heading "${artistName}". `
      + `Last observed state: ${JSON.stringify(lastSnapshot)}`,
    );
  }

  async waitForAlbumCoverReadyUnderHeading(artistName, albumName, options = {}) {
    await this.waitForAlbumVisibleUnderHeading(artistName, albumName, options);
    const coverImage = this.galleryPage.albumCard
      .cardByArtistAndAlbum(artistName, albumName, { visible: true })
      .locator(this.galleryPage.albumCard.coverImageWithinCardSelector)
      .first();
    await this.galleryPage.waitForPageCondition((selectors) => {
      const section = Array.from(document.querySelectorAll(selectors.artistSectionSelector))
        .find((candidate) => String(
          candidate.querySelector(selectors.artistHeadingSelector)?.textContent || '',
        ).trim() === selectors.artistName);
      if (!(section instanceof HTMLElement)) return false;
      const card = Array.from(section.querySelectorAll(selectors.albumCardSelector))
        .find((candidate) => String(
          candidate.querySelector(selectors.albumTitleSelector)?.textContent || '',
        ).trim() === selectors.albumName);
      if (!(card instanceof HTMLElement)) return false;
      const image = card.querySelector(selectors.coverImageSelector);
      return image instanceof HTMLImageElement
        && image.complete
        && image.naturalWidth > 0
        && String(image.getAttribute('data-production-cover-src') || '').trim() !== '';
    }, {
      timeout: options.timeout || 30000,
    }, {
      artistSectionSelector: '#artist-groups .artist-section',
      artistHeadingSelector: this.galleryPage.artistHeadingSelector,
      albumCardSelector: this.galleryPage.albumCardWithinSectionSelector,
      albumTitleSelector: this.galleryPage.albumTitleButtonWithinSectionSelector,
      coverImageSelector: this.galleryPage.albumCard.coverImageWithinCardSelector,
      artistName,
      albumName,
    });
    return {
      productionSrc: String(
        await coverImage.getAttribute('data-production-cover-src') || '',
      ).trim(),
      renderedSrc: String(await coverImage.getAttribute('src') || '').trim(),
    };
  }

  async scrollToAlbumUnderHeading(artistName, albumName, options = {}) {
    const maxScrollActions = options.maxAttempts === undefined
      ? null
      : Math.max(1, Math.floor(Number(options.maxAttempts) || 1));
    let direction = Number(options.direction || 1) < 0 ? -1 : 1;
    let lastViewportState = null;
    let scrollActions = 0;
    let waitedAtBoundary = false;
    const year = String(options.year || '').trim();
    const reconcileBoundary = async (boundaryDirection) => {
      if (options.waitAtBoundary !== true || waitedAtBoundary) return false;
      waitedAtBoundary = true;
      const targetState = await this.galleryPage.readAlbumTargetState({
        artist: artistName,
        album: albumName,
        query: options.expectedQuery,
      });
      const classification = classifyGalleryAlbumTargetState(targetState);
      if (
        classification.status === 'retryable'
        && classification.reason === 'canonical match awaiting virtual attachment'
      ) {
        direction = -boundaryDirection;
        return true;
      }
      await this.waitForAlbumVisibleUnderHeading(artistName, albumName, options);
      return true;
    };
    while (true) {
      const section = this.galleryPage.sectionByArtistHeading(artistName);
      const target = year
        ? this.galleryPage.albumCard.cardByIdentity(artistName, albumName, year).first()
        : section.getByRole('button', { name: albumName, exact: true }).first();
      if (await target.count()) {
        lastViewportState = await this.readAlbumGalleryViewportState(
          artistName,
          albumName,
          { year },
        );
        if (lastViewportState.attached && lastViewportState.intersects) return;
        if (lastViewportState.attached) {
          const targetDirection = Number(lastViewportState.scrollDirection || direction) < 0 ? -1 : 1;
          const scrollState = await this.readGalleryScrollState();
          const reachedBoundary = targetDirection > 0
            ? scrollState.scrollTop >= scrollState.maxScrollTop - 2
            : scrollState.scrollTop <= 2;
          if (reachedBoundary) {
            if (await reconcileBoundary(targetDirection)) continue;
            break;
          }
          if (maxScrollActions !== null && scrollActions >= maxScrollActions) break;
          await this.scrollGalleryBy(
            targetDirection * Math.max(240, Math.round(scrollState.clientHeight * 0.75)),
          );
          await this.galleryPage.waitForGalleryScrollMovement(
            scrollState.scrollTop,
            targetDirection,
          );
          scrollActions += 1;
          lastViewportState = await this.readAlbumGalleryViewportState(
            artistName,
            albumName,
            { year },
          );
          if (lastViewportState.attached && lastViewportState.intersects) return;
          continue;
        }
      }
      const scrollState = await this.readGalleryScrollState();
      const reachedBoundary = direction > 0
        ? scrollState.scrollTop >= scrollState.maxScrollTop - 2
        : scrollState.scrollTop <= 2;
      if (reachedBoundary) {
        if (await reconcileBoundary(direction)) continue;
        break;
      }
      if (maxScrollActions !== null && scrollActions >= maxScrollActions) break;
      await this.scrollGalleryBy(direction * Math.max(240, Math.round(scrollState.clientHeight * 0.75)));
      await this.galleryPage.waitForGalleryScrollMovement(scrollState.scrollTop, direction);
      scrollActions += 1;
    }
    if (lastViewportState?.attached && !lastViewportState.intersects) {
      throw new Error(
        `Expected album "${albumName}" under heading "${artistName}" to intersect the gallery `
        + `after ${scrollActions} scroll actions.`,
      );
    }
    throw new Error(
      `Expected album "${albumName}" under heading "${artistName}" after scrolling the gallery `
      + `with ${scrollActions} scroll actions.`,
    );
  }

  async clickAlbumDetailsByHeadingAndIndex(artistName, indexWithinSection) {
    const section = this.galleryPage.sectionByArtistHeading(artistName);
    const card = section.locator(this.galleryPage.albumCardWithinSectionSelector).nth(indexWithinSection);
    const button = card.locator(this.galleryPage.albumDetailsButtonWithinSectionSelector).first();
    await button.scrollIntoViewIfNeeded();
    await button.click();
  }

  async waitForAllArtistsStructure(options = {}) {
    await this.waitForInitialAllArtistsSections(options);
  }

  async scrollGalleryToMiddle() {
    const scrollState = await this.readGalleryScrollState();
    const targetScrollTop = Math.round(scrollState.maxScrollTop * 0.5);
    const deltaY = targetScrollTop - scrollState.scrollTop;
    if (Math.abs(deltaY) < 1) return;
    await this.scrollGalleryBy(deltaY);
    await this.galleryPage.waitForGalleryScrollMovement(
      scrollState.scrollTop,
      Math.sign(deltaY),
    );
  }

  async prepareMountedGalleryContinuityCheckpoint(options = {}) {
    const minimumDecodedCovers = Number(options.minimumDecodedCovers || 1);
    await this.scrollGalleryToMiddle();
    await this.galleryPage.waitForDecodedProductionCardWindow({
      minimumDecodedCount: minimumDecodedCovers,
      timeout: options.timeout || 60000,
    });
    await this.galleryPage.waitForVirtualGalleryMeasurementSettled({
      timeout: options.timeout || 60000,
    });
    const scroll = await this.readGalleryScrollState();
    return {
      decodedCoverCount: minimumDecodedCovers,
      scrollTop: Number(scroll.scrollTop || 0),
      maxScrollTop: Number(scroll.maxScrollTop || 0),
    };
  }

  async readRelationProjectionReadiness() {
    const status = await this.galleryPage.readStatusPayload();
    const projection = status?.relation_projection || {};
    return {
      ready: Boolean(projection.ready),
      startupRebuilt: Boolean(projection.startup_rebuilt),
      rebuildReason: String(projection.rebuild_reason || '').trim(),
      durationMs: Number(projection.duration_ms || 0),
    };
  }

  async readBrowseTelemetry() {
    const payload = await this.galleryPage.readLatestProductionViewPayload();
    return {
      persistenceBackend: String(payload?.persistence_backend || '').trim(),
      persistenceSeam: String(payload?.persistence_seam || '').trim(),
      viewDataSource: String(payload?.view_data_source || '').trim(),
    };
  }

  async readAlbumCreditByName(albumName) {
    return String(
      await this.galleryPage.albumCard.subtitleByAlbumName(albumName).textContent() || '',
    ).trim();
  }

  async readAlbumYearByName(albumName) {
    return String(
      await this.galleryPage.albumCard.yearByAlbumName(albumName).textContent() || '',
    ).trim();
  }

  async clickAlbumDetailsByArtistAndAlbum(artistName, albumName) {
    await this.galleryPage.albumCard.detailsButtonByArtistAndAlbum(artistName, albumName).click();
  }

  async readVisibleAlbumLabelsByName(albumName) {
    const card = this.galleryPage.albumCard.cardByAlbumName(albumName).first();
    const selectors = {
      artistSelector: this.galleryPage.albumCard.subtitleWithinCardSelector,
      titleSelector: this.galleryPage.albumCard.titleButtonSelector,
    };
    // parity-check: allow-read-only-measurement-evaluate -- verify visible card-label layout
    return card.evaluate((element, labelSelectors) => {
      const title = element.querySelector(labelSelectors.titleSelector);
      const artist = element.querySelector(labelSelectors.artistSelector);
      if (!(title instanceof HTMLElement) || !(artist instanceof HTMLElement)) {
        throw new Error('Album card label elements are missing.');
      }
      const artistStyle = getComputedStyle(artist);
      const lineHeight = Number.parseFloat(artistStyle.lineHeight);
      const artistBounds = artist.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      return {
        artistLineClamp: String(artistStyle.webkitLineClamp || '').trim(),
        artistOverflow: String(artistStyle.overflow || '').trim(),
        artistText: String(artist.textContent || '').trim(),
        artistVisible: artistBounds.width > 0 && artistBounds.height > 0,
        artistRenderedLineCount: lineHeight > 0
          ? Math.ceil(artist.clientHeight / lineHeight)
          : 0,
        titleText: String(title.textContent || '').trim(),
        titleVisible: titleBounds.width > 0 && titleBounds.height > 0,
      };
    }, selectors);
  }

  async selectAlbumDetailsByIdentity(expected, options = {}) {
    const artist = String(expected.artist || '').trim();
    const album = String(expected.album || '').trim();
    const year = String(expected.year || '').trim();
    if (!artist || !album || !year) {
      throw new Error('Selecting an album requires an exact artist, album, and year.');
    }

    await this.scrollToAlbumUnderHeading(artist, album, options);
    await this.galleryPage.albumCard.clickDetailsByIdentity(artist, album, year);
    return { artist, album, year };
  }

  async selectAlbumDetailsByIdentityAndReadPayload(expected, options = {}) {
    const timeout = options.timeout || 30000;
    const artist = String(expected.artist || '').trim();
    const album = String(expected.album || '').trim();
    const year = String(expected.year || '').trim();
    if (!artist || !album || !year) {
      throw new Error('Selecting an album requires an exact artist, album, and year.');
    }
    await this.scrollToAlbumUnderHeading(artist, album, { ...options, year });
    const requestKey = await this.galleryPage.albumCard.readRequestKeyByIdentity(
      artist,
      album,
      year,
    );
    let response = null;
    const matchesAlbumDetailsRequest = (candidate) => (
      candidate.method() === 'GET'
      && new URL(candidate.url()).pathname === '/album-details'
      && new URL(candidate.url()).searchParams.get('album_key') === requestKey
    );
    const observeAlbumDetails = (candidate) => {
      if (matchesAlbumDetailsRequest(candidate.request())) {
        response = candidate;
      }
    };
    this.galleryPage.page.on('response', observeAlbumDetails);
    try {
      await expect.poll(async () => {
        if (await this.galleryPage.albumCard.isOpenDetailsIdentity(artist, album, year)) {
          return true;
        }
        await this.galleryPage.albumCard.clickDetailsByIdentity(artist, album, year);
        return this.galleryPage.albumCard.isOpenDetailsIdentity(artist, album, year);
      }, {
        timeout,
        intervals: [100, 250, 500],
        message: `Expected the album-details modal to open for ${artist} / ${album} / ${year}`,
      }).toBe(true);
      await this.galleryPage.albumCard.waitForOpenDetailsIdentity(
        artist,
        album,
        year,
        { timeout },
      );
      if (!response) {
        response = await authenticatedPageGet(
          this.galleryPage.page,
          `/album-details?album_key=${encodeURIComponent(requestKey)}`,
          { timeout },
        );
      }
    } finally {
      this.galleryPage.page.off('response', observeAlbumDetails);
    }
    const payload = await response.json();
    if (!response.ok() || payload?.ok !== true || !payload?.album) {
      throw new Error(
        `Album details failed with HTTP ${response.status()}: ${JSON.stringify(payload)}`,
      );
    }
    const actualIdentity = {
      artist: String(payload.album.album_artist || '').trim(),
      album: String(payload.album.name || '').trim(),
      year: String(payload.album.year || '').trim(),
    };
    const selected = { artist, album, year };
    if (JSON.stringify(actualIdentity) !== JSON.stringify(selected)) {
      throw new Error(
        `Album details identity mismatch for request key ${requestKey}: expected `
        + `${JSON.stringify(selected)}, received ${JSON.stringify(actualIdentity)}.`,
      );
    }
    return { selected, album: payload.album };
  }

  albumCoverByName(albumName) {
    return this.galleryPage.albumCard.coverImageByAlbumName(albumName);
  }

  async readAlbumKeyByName(albumName) {
    return String(
      await this.galleryPage.albumCard.visibleDetailsButtonByAlbumName(albumName).getAttribute('data-album-key')
      || '',
    );
  }

  async captureAlbumCardHandleByName(albumName) {
    const card = this.galleryPage.albumCard.cardByAlbumName(albumName).first();
    const handle = await card.elementHandle();
    if (!handle) {
      throw new Error(`Expected album card "${albumName}" to be attached.`);
    }
    return handle;
  }

  async isSameAlbumCardHandle(previousHandle, albumName) {
    const currentHandle = await this.captureAlbumCardHandleByName(albumName);
    // parity-check: allow-read-only-measurement-evaluate -- compare detached/current DOM node identity only
    return previousHandle.evaluate((previousNode, currentNode) => previousNode === currentNode, currentHandle);
  }

  async traverseDistinctDecodedGalleryCards(minimumCount, options = {}) {
    const requiredCount = Math.max(1, Number(minimumCount || 1));
    const observed = new Map();
    const excludedKeys = new Set((options.excludeKeys || []).map((value) => String(value || '').trim()));
    const maxSteps = Math.max(1, Number(options.maxSteps || 120));
    const untilCoverEvicted = String(options.untilCoverEvicted || '').trim();
    let direction = 1;
    let evictionSettled = !untilCoverEvicted;
    let reversedAtBottom = false;
    let settledWindows = 0;
    while (settledWindows < maxSteps && (observed.size < requiredCount || !evictionSettled)) {
      const windowState = await this.galleryPage.waitForDecodedProductionCardWindow({
        timeout: options.windowTimeout,
      });
      settledWindows += 1;
      windowState.decodedCards.forEach((entry) => {
        if (!excludedKeys.has(entry.key)) observed.set(entry.key, entry.productionSrc);
      });
      if (observed.size >= requiredCount && untilCoverEvicted) {
        await this.galleryPage.waitForCoverSchedulerIdle({
          timeout: options.schedulerTimeout || 30000,
        });
        evictionSettled = !(await this.galleryPage.readCoverCacheState(untilCoverEvicted)).active;
      }
      if (observed.size >= requiredCount && evictionSettled) break;
      if (settledWindows >= maxSteps) break;

      const scrollState = await this.readGalleryScrollState();
      const atTop = scrollState.scrollTop <= 2;
      const atBottom = scrollState.scrollTop >= scrollState.maxScrollTop - 2;
      if (direction > 0 && atBottom) {
        direction = -1;
        reversedAtBottom = true;
      } else if (direction < 0 && atTop) {
        break;
      }
      if (scrollState.maxScrollTop <= 0) break;

      const deltaY = direction * Math.max(240, Math.round(scrollState.clientHeight * 0.7));
      await this.scrollGalleryBy(deltaY);
      await this.galleryPage.waitForGalleryScrollMovement(scrollState.scrollTop, direction, {
        timeout: options.scrollTimeout,
      });
    }
    if (observed.size < requiredCount) {
      throw new Error(
        `Expected ${requiredCount} distinct decoded gallery cards, observed ${observed.size} `
        + `after ${settledWindows} settled virtual windows (max ${maxSteps}); `
        + `bottom reverse ${reversedAtBottom ? 'started' : 'not reached'}.`,
      );
    }
    if (!evictionSettled) {
      throw new Error(
        `Expected cover "${untilCoverEvicted}" to leave the active preview cache after `
        + `${settledWindows} settled virtual windows (max ${maxSteps}), but it remained active.`,
      );
    }
    return [...observed.entries()]
      .slice(0, requiredCount)
      .map(([key, productionSrc]) => ({ key, productionSrc }));
  }

  async waitForCoverSchedulerIdle(options = {}) {
    await this.galleryPage.waitForCoverSchedulerIdle(options);
  }

  async readCoverCacheState(productionUrl) {
    return this.galleryPage.readCoverCacheState(productionUrl);
  }

  async readAlbumGalleryViewportState(artistName, albumName, options = {}) {
    return this.galleryPage.readAlbumGalleryViewportState(artistName, albumName, options);
  }

  async readAlbumRatingSurface(artistName, albumName) {
    const albumCard = this.galleryPage.albumCard;
    const row = albumCard.ratingRowByArtistAndAlbum(artistName, albumName);
    const stars = albumCard.ratingStarsByArtistAndAlbum(artistName, albumName);
    const text = albumCard.ratingTextByArtistAndAlbum(artistName, albumName);
    const starPositions = albumCard.ratingStarPositionsByArtistAndAlbum(artistName, albumName);
    const filledStars = albumCard.ratingFilledStarsByArtistAndAlbum(artistName, albumName);
    const emptyStars = albumCard.ratingEmptyStarsByArtistAndAlbum(artistName, albumName);
    const rowCount = await row.count();
    if (rowCount === 0) {
      return {
        rowCount: 0,
        starCount: 0,
        filledStarCount: 0,
        emptyStarCount: 0,
        role: '',
        ariaLabel: '',
        text: '',
        glyphs: [],
        filledColor: '',
        emptyColor: '',
      };
    }
    const [starCount, filledStarCount, emptyStarCount] = await Promise.all([
      starPositions.count(),
      filledStars.count(),
      emptyStars.count(),
    ]);
    // parity-check: allow-read-only-measurement-evaluate -- inspect production star colors only
    const filledColor = filledStarCount > 0
      ? await filledStars.first().evaluate((star) => getComputedStyle(star).color)
      : '';
    // parity-check: allow-read-only-measurement-evaluate -- inspect production star colors only
    const emptyColor = emptyStarCount > 0
      ? await emptyStars.first().evaluate((star) => getComputedStyle(star).color)
      : '';
    return {
      rowCount,
      starCount,
      filledStarCount,
      emptyStarCount,
      role: String(await stars.getAttribute('role') || '').trim(),
      ariaLabel: String(await stars.getAttribute('aria-label') || '').trim(),
      text: await text.count() > 0 ? String(await text.textContent() || '').trim() : '',
      glyphs: (await starPositions.allTextContents()).map((glyph) => glyph.trim()),
      filledColor,
      emptyColor,
    };
  }

  async readAlbumRatingLayout(artistName, albumName) {
    const albumCard = this.galleryPage.albumCard;
    const row = albumCard.ratingRowByArtistAndAlbum(artistName, albumName);
    // parity-check: allow-read-only-measurement-evaluate -- inspect production rating-row geometry only
    return row.evaluate((ratingRow, selectors) => {
      const stars = ratingRow.querySelector(selectors.stars);
      const starPositions = Array.from(ratingRow.querySelectorAll(selectors.starPositions));
      const ratingText = ratingRow.querySelector(selectors.ratingText);
      if (!(stars instanceof HTMLElement) || starPositions.length !== 10) {
        throw new Error('Expected one album rating row with ten star positions.');
      }
      const rowBounds = ratingRow.getBoundingClientRect();
      const starBounds = starPositions.map((star) => star.getBoundingClientRect());
      const firstStarBounds = starBounds[0];
      const lastStarBounds = starBounds[starBounds.length - 1];
      const ratingTextBounds = ratingText instanceof HTMLElement
        ? ratingText.getBoundingClientRect()
        : null;
      return {
        rowWidth: rowBounds.width,
        starFontSize: Number.parseFloat(getComputedStyle(starPositions[0]).fontSize),
        starGlyphSpan: lastStarBounds.right - firstStarBounds.left,
        starsWidth: stars.getBoundingClientRect().width,
        starLineSpread: Math.max(...starBounds.map((bounds) => bounds.top))
          - Math.min(...starBounds.map((bounds) => bounds.top)),
        numericGap: ratingTextBounds ? ratingTextBounds.left - lastStarBounds.right : null,
      };
    }, {
      stars: albumCard.ratingStarsWithinRowSelector,
      starPositions: albumCard.ratingStarWithinRowSelector,
      ratingText: albumCard.ratingTextWithinRowSelector,
    });
  }

  async readArtistHeadingGalleryViewportState(artistName) {
    const heading = this.galleryPage.headingByArtistName(artistName);
    if (!(await heading.count())) {
      return { attached: false, intersects: false, offscreen: true };
    }
    const [headingBounds, galleryBounds] = await Promise.all([
      heading.boundingBox(),
      this.galleryPage.galleryScroll.boundingBox(),
    ]);
    if (!headingBounds) {
      return { attached: true, intersects: false, offscreen: true };
    }
    if (!galleryBounds) {
      throw new Error('Expected the gallery scroll surface to be visible.');
    }
    const intersects = headingBounds.x + headingBounds.width > galleryBounds.x
      && headingBounds.x < galleryBounds.x + galleryBounds.width
      && headingBounds.y + headingBounds.height > galleryBounds.y
      && headingBounds.y < galleryBounds.y + galleryBounds.height;
    return { attached: true, intersects, offscreen: !intersects };
  }

  async readFirstArtistAlbumGalleryViewportState(artistName) {
    const card = this.galleryPage.firstAlbumCardByArtistName(artistName);
    if (!(await card.count())) {
      return { attached: false, detached: true, intersects: false, offscreen: true };
    }
    const [cardBounds, galleryBounds] = await Promise.all([
      card.boundingBox(),
      this.galleryPage.galleryScroll.boundingBox(),
    ]);
    if (!cardBounds) {
      return { attached: true, detached: false, intersects: false, offscreen: true };
    }
    if (!galleryBounds) {
      throw new Error('Expected the gallery scroll surface to be visible.');
    }
    const intersects = cardBounds.x + cardBounds.width > galleryBounds.x
      && cardBounds.x < galleryBounds.x + galleryBounds.width
      && cardBounds.y + cardBounds.height > galleryBounds.y
      && cardBounds.y < galleryBounds.y + galleryBounds.height;
    return { attached: true, detached: false, intersects, offscreen: !intersects };
  }

  async readArtistSelectionGalleryViewportState(artistName, retainedAlbumName) {
    const [scroll, heading, firstAlbum, retainedAlbum] = await Promise.all([
      this.readGalleryScrollState(),
      this.readArtistHeadingGalleryViewportState(artistName),
      this.readFirstArtistAlbumGalleryViewportState(artistName),
      this.readAlbumGalleryViewportState(artistName, retainedAlbumName),
    ]);
    return { scroll, heading, firstAlbum, retainedAlbum };
  }

  async scrollAlbumAwayFromViewport(artistName, albumName, options = {}) {
    const beforeScroll = await this.readGalleryScrollState();
    const beforeAlbum = await this.readAlbumGalleryViewportState(artistName, albumName);
    if (!beforeAlbum.attached || !beforeAlbum.intersects) {
      throw new Error(`Expected album "${albumName}" to intersect the gallery before scrolling away.`);
    }
    const plan = planGalleryScrollAway(beforeScroll);
    await this.scrollGalleryBy(plan.deltaY);
    await this.galleryPage.waitForPageCondition((selectors) => {
      const normalize = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
      const galleryScroll = document.querySelector(selectors.galleryScrollSelector);
      if (!(galleryScroll instanceof HTMLElement)) return false;
      const moved = Math.abs(galleryScroll.scrollTop - selectors.beforeScrollTop)
        >= selectors.minimumScrollDelta;
      if (!moved) return false;
      const section = Array.from(document.querySelectorAll(selectors.artistSectionSelector))
        .find((candidate) => normalize(candidate.querySelector(selectors.artistHeadingSelector)?.textContent)
          === normalize(selectors.artistName));
      const card = section instanceof HTMLElement
        ? Array.from(section.querySelectorAll(selectors.albumCardSelector)).find((candidate) => (
          normalize(candidate.querySelector(selectors.albumTitleSelector)?.textContent)
            === normalize(selectors.albumName)
        ))
        : null;
      if (!(card instanceof HTMLElement)) return true;
      const galleryBounds = galleryScroll.getBoundingClientRect();
      const cardBounds = card.getBoundingClientRect();
      return cardBounds.right <= galleryBounds.left
        || cardBounds.left >= galleryBounds.right
        || cardBounds.bottom <= galleryBounds.top
        || cardBounds.top >= galleryBounds.bottom;
    }, {
      timeout: options.timeout || 15000,
    }, {
      galleryScrollSelector: this.galleryPage.galleryScrollSelector,
      artistSectionSelector: this.galleryPage.artistSectionSelector,
      artistHeadingSelector: this.galleryPage.artistHeadingWithinSectionSelector,
      albumCardSelector: this.galleryPage.albumCardWithinSectionSelector,
      albumTitleSelector: this.galleryPage.albumTitleButtonWithinSectionSelector,
      artistName,
      albumName,
      beforeScrollTop: beforeScroll.scrollTop,
      minimumScrollDelta: plan.minimumScrollDelta,
    });
    const afterScroll = await this.readGalleryScrollState();
    const afterAlbum = await this.readAlbumGalleryViewportState(artistName, albumName);
    return {
      beforeScroll,
      afterScroll,
      album: afterAlbum,
      scrollDelta: afterScroll.scrollTop - beforeScroll.scrollTop,
      minimumScrollDelta: plan.minimumScrollDelta,
      direction: plan.direction,
    };
  }

  async returnToAlbumAfterScrollAway(artistName, albumName, awayState, options = {}) {
    const scrollDelta = Number(awayState?.scrollDelta || 0);
    const minimumScrollDelta = Number(awayState?.minimumScrollDelta || 0);
    if (!(Math.abs(scrollDelta) >= minimumScrollDelta && minimumScrollDelta > 0)) {
      throw new Error('Returning to an album requires measured scroll-away movement.');
    }
    await this.scrollGalleryBy(-scrollDelta);
    await this.scrollToAlbumUnderHeading(artistName, albumName, {
      ...options,
      direction: -Number(awayState.direction || 1),
      waitAtBoundary: true,
    });
  }

  async scrollGalleryBy(deltaY) {
    if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 1) return;
    await this.galleryPage.galleryScroll.hover();
    await this.galleryPage.page.mouse.wheel(0, deltaY);
  }

  async readGalleryScrollState() {
    // parity-check: allow-read-only-measurement-evaluate gallery scroll metrics only
    return this.galleryPage.galleryScroll.evaluate((galleryScroll) => ({
      scrollTop: galleryScroll.scrollTop,
      clientHeight: galleryScroll.clientHeight,
      maxScrollTop: Math.max(0, galleryScroll.scrollHeight - galleryScroll.clientHeight),
    }));
  }

  async readVirtualGridDiagnostics() {
    return this.galleryPage.readVirtualGridDiagnostics();
  }

  async waitForGalleryScrollPosition(targetScrollTop, options = {}) {
    const target = Math.max(0, Number(targetScrollTop || 0));
    const tolerance = Math.max(0, Number(options.tolerance ?? 2));
    let lastScrollState = null;
    try {
      await expect.poll(async () => {
        lastScrollState = await this.readGalleryScrollState();
        return Math.abs(Number(lastScrollState.scrollTop || 0) - target);
      }, {
        message: `Expected the gallery to settle back at scroll position ${target}.`,
        timeout: Number(options.timeout || 10000),
        intervals: [16, 32, 50, 100],
      }).toBeLessThanOrEqual(tolerance);
    } catch (error) {
      const diagnostics = await this.readVirtualGridDiagnostics();
      throw new Error(
        `Gallery scroll did not settle at ${target}; last state `
        + `${JSON.stringify(lastScrollState)}; virtual grid ${JSON.stringify(diagnostics)}.`,
        { cause: error },
      );
    }
    return lastScrollState;
  }

  async waitForGalleryScrollAtStart(options = {}) {
    await this.galleryPage.waitForPageCondition((selectors) => {
      const galleryScroll = document.querySelector(selectors.galleryScrollSelector);
      return galleryScroll instanceof HTMLElement && galleryScroll.scrollTop <= 2;
    }, {
      timeout: options.timeout || 10000,
    }, {
      galleryScrollSelector: this.galleryPage.galleryScrollSelector,
    });
    return this.readGalleryScrollState();
  }

  async jumpGalleryToMiddle(options = {}) {
    await this.scrollGalleryToMiddle();
    if (Number(options.settleMs || 0) > 0) {
      await this.galleryPage.page.waitForTimeout(Number(options.settleMs));
    }
    return this.readJumpScrollState();
  }

  async readJumpScrollState() {
    const scrollState = await this.readGalleryScrollState();
    return {
      visibleArtists: (await this.galleryPage.artistHeadings.allTextContents())
        .map((artistName) => artistName.trim())
        .filter(Boolean),
      scrollTop: scrollState.scrollTop,
      maxScrollTop: scrollState.maxScrollTop,
    };
  }

  async readVisibleAlbumDetailButtonIndexes() {
    const scroller = await this.galleryPage.galleryScroll.boundingBox();
    if (!scroller) throw new Error('Expected the gallery scroll surface to be visible.');
    const visibleIndexes = [];
    const buttons = this.galleryPage.albumDetailsButtons;
    const buttonCount = await buttons.count();
    for (let index = 0; index < buttonCount; index += 1) {
      const bounds = await buttons.nth(index).boundingBox();
      if (!bounds) continue;
      if (bounds.y + bounds.height > scroller.y
        && bounds.y < scroller.y + scroller.height
        && bounds.width > 0
        && bounds.height > 0) {
        visibleIndexes.push(index);
      }
    }
    return visibleIndexes;
  }

  async startAlbumCardMultiplicityObservation(expected) {
    return this.galleryPage.startAlbumCardMultiplicityObservation(expected);
  }

  async observeAlbumCardMultiplicityDuring(expected, action) {
    const observation = await this.startAlbumCardMultiplicityObservation(expected);
    try {
      const actionResult = await action((phase) => observation.checkpoint(phase));
      return {
        actionResult,
        observation: await observation.finish(),
      };
    } catch (error) {
      const finalObservation = await observation.finish();
      throw new Error(
        `${error.message} Album-card multiplicity: ${JSON.stringify(finalObservation)}`,
        { cause: error },
      );
    }
  }

  async observeStableAlbumTopologyDuring(expected, action) {
    const observation = await this.galleryPage.startStableAlbumTopologyObservation(expected);
    try {
      const actionResult = await action(
        (phase, options = {}) => observation.checkpoint(phase, options),
      );
      return {
        actionResult,
        observation: await observation.finish(),
      };
    } catch (error) {
      const finalObservation = await observation.finish();
      throw new Error(
        `${error.message} Stable album topology: ${JSON.stringify(finalObservation)}`,
        { cause: error },
      );
    }
  }

  async expectStableAlbumTopologyTransitionDuring(expected, action) {
    const result = await this.observeStableAlbumTopologyDuring(expected, action);
    expect(result.observation.armed).toBe(true);
    expect(result.observation.violations).toEqual([]);
    expect(result.observation.finalSample.cards).toEqual(
      result.observation.baseline.cards,
    );
    const initialCards = result.observation.samples.find(
      (sample) => sample.phase === 'initial',
    )?.cards || [];
    const settledCards = result.observation.baseline.cards;
    const unexpectedTransientTopologies = result.observation.samples
      .filter((sample) => (
        JSON.stringify(sample.cards) !== JSON.stringify(initialCards)
        && JSON.stringify(sample.cards) !== JSON.stringify(settledCards)
      ))
      .map((sample) => ({
        cards: sample.cards,
        phase: sample.phase,
      }));
    expect(
      unexpectedTransientTopologies,
      'Expected one direct full-gallery topology transition without temporary cards or positions.',
    ).toEqual([]);

    const editedAlbumNames = new Set([
      ...(expected.identities || []).map((identity) => String(identity.album || '').trim()),
      ...(expected.absentIdentities || []).map((identity) => String(identity.album || '').trim()),
    ]);
    const mountedWindowTransition = evaluateMountedAlbumWindowTransition({
      editedAlbumNames,
      initialCards,
      settledCards,
    });
    expect(
      mountedWindowTransition.sharedSettled,
      'Expected unrelated mounted album identities and relative DOM order to remain stable.',
    ).toEqual(mountedWindowTransition.sharedInitial);
    expect(
      mountedWindowTransition.removedAtSuffix,
      'Expected any unrelated virtual-window eviction to occur only at the trailing boundary.',
    ).toBe(true);
    expect(
      mountedWindowTransition.addedAtSuffix,
      'Expected any unrelated virtual-window admission to occur only at the trailing boundary.',
    ).toBe(true);
    expect(
      mountedWindowTransition.boundaryChangeCount,
      'Expected virtual-window boundary changes not to exceed the edited-card insertion/removal.',
    ).toBeLessThanOrEqual(mountedWindowTransition.boundaryChangeBudget);
    return result;
  }

  async inspectExactAlbumDetailsAfterClosingCurrentModal(trackModalActions, expected) {
    await trackModalActions.closeIfOpen();
    await this.selectAlbumDetailsByIdentity(expected);
    const summary = await trackModalActions.waitForExactAlbumDetails(expected);
    await trackModalActions.close();
    return summary;
  }

  async readAlbumIdentityCardCount(expected) {
    return this.galleryPage.albumCard.cardByIdentity(
      String(expected.artist || '').trim(),
      String(expected.album || '').trim(),
      String(expected.year || '').trim(),
    ).count();
  }

  async readAlbumCardSummaryByIdentity(expected) {
    const card = this.galleryPage.albumCard.cardByIdentity(
      String(expected.artist || '').trim(),
      String(expected.album || '').trim(),
      String(expected.year || '').trim(),
    );
    await expect(card).toHaveCount(1);
    return {
      subtitle: String(
        await card.locator(
          this.galleryPage.albumCard.subtitleWithinCardSelector,
        ).textContent() || '',
      ).trim(),
      trackCount: String(
        await card.locator(
          this.galleryPage.albumCard.trackCountWithinCardSelector,
        ).textContent() || '',
      ).trim(),
    };
  }
}
