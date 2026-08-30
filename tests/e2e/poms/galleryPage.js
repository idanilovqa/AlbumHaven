import { AlbumCard } from './albumCard.js';
import { BasePage } from './basePage.js';
import {
  ProductionViewObserver,
  hasAppliedCanonicalArtistSurface,
  hasStableDomEvidence,
  readCanonicalAlbumTargetEvidence,
} from '../helpers/productionViewObserver.js';

function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

export function parseArtistAlbumCount(value) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(\d+)\s+albums?$/u);
  if (!match) {
    throw new Error(`Expected an exact visible artist album count, received: ${normalized || '<empty>'}.`);
  }
  const albumCount = Number(match[1]);
  if (!Number.isSafeInteger(albumCount)) {
    throw new Error(`Visible artist album count is outside the safe integer range: ${match[1]}.`);
  }
  return albumCount;
}

export function hasSettledVirtualGalleryRender(args = {}) {
  const gallery = document.querySelector(args.galleryScrollSelector);
  if (!(gallery instanceof HTMLElement)) return false;
  const priorPosition = Number(args.priorPosition || 0);
  const expectedDirection = Number(args.expectedDirection || 1);
  const movement = gallery.scrollTop - priorPosition;
  const hasRequestedMovement = expectedDirection > 0 ? movement > 1 : movement < -1;
  const maxScrollTop = Math.max(0, gallery.scrollHeight - gallery.clientHeight);
  const reachedRequestedBoundary = expectedDirection > 0
    ? gallery.scrollTop >= maxScrollTop - 2
    : gallery.scrollTop <= 2;
  if (!hasRequestedMovement && !reachedRequestedBoundary) return false;
  const diagnostics = globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
  const latestScroll = diagnostics?.latestScroll;
  const latestRender = diagnostics?.latestRender;
  const scrollRenderOwner = Number(latestScroll?.renderRafOwner || 0);
  const completedRenderOwner = Number(latestRender?.renderRafOwner || 0);
  return scrollRenderOwner > 0
    && completedRenderOwner === scrollRenderOwner
    && Number(latestRender?.renderGeneration || 0)
      === Number(latestScroll?.renderGeneration || 0)
    && Math.abs(Number(latestScroll?.scrollTop || 0) - gallery.scrollTop) <= 2
    && Math.abs(Number(latestRender?.viewportTop || 0) - gallery.scrollTop) <= 2;
}

export function hasSettledVirtualGalleryMeasurement(args = {}) {
  const gallery = document.querySelector(args.galleryScrollSelector);
  if (!(gallery instanceof HTMLElement)) return false;
  const diagnostics = globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
  const latestScroll = diagnostics?.latestScroll;
  const latestRender = diagnostics?.latestRender;
  const latestMeasurement = diagnostics?.latestMeasurement;
  const renderGeneration = Number(latestRender?.renderGeneration || 0);
  const scrollRenderOwner = Number(latestScroll?.renderRafOwner || 0);
  return Boolean(latestMeasurement)
    && latestMeasurement.changed === false
    && scrollRenderOwner > 0
    && Number(latestRender?.renderRafOwner || 0) === scrollRenderOwner
    && Number(latestScroll?.renderGeneration || 0) === renderGeneration
    && Number(latestMeasurement?.renderGeneration || 0) === renderGeneration
    && Math.abs(Number(latestScroll?.scrollTop || 0) - gallery.scrollTop) <= 2
    && Math.abs(Number(latestRender?.viewportTop || 0) - gallery.scrollTop) <= 2
    && Math.abs(Number(latestMeasurement?.scrollTop || 0) - gallery.scrollTop) <= 2;
}

function readDecodedProductionCardWindow(args = {}) {
  const minimumDecodedCount = Math.max(1, Math.floor(Number(args.minimumDecodedCount) || 1));
  const galleryScroll = document.querySelector(args.galleryScrollSelector);
  const emptyState = {
    candidateCount: 0,
    decodedCards: [],
    schedulerSettled: false,
    terminalCount: 0,
  };
  if (!(galleryScroll instanceof HTMLElement)) return args.snapshot ? emptyState : false;
  const galleryBounds = galleryScroll.getBoundingClientRect();
  if (!(galleryBounds.width > 0 && galleryBounds.height > 0)) return args.snapshot ? emptyState : false;
  const diagnostics = globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__;
  const schedulerSettled = Boolean(
    diagnostics
    && diagnostics.active === 0
    && diagnostics.queuedVisible === 0
    && diagnostics.queuedNear === 0
    && diagnostics.queuedBackground === 0
  );
  const entries = [...document.querySelectorAll(args.cardSelector)].map((card) => {
    const cardBounds = card.getBoundingClientRect();
    const intersects = cardBounds.width > 0
      && cardBounds.height > 0
      && cardBounds.right > galleryBounds.left
      && cardBounds.left < galleryBounds.right
      && cardBounds.bottom > galleryBounds.top
      && cardBounds.top < galleryBounds.bottom;
    const image = card.querySelector(args.coverImageSelector);
    const key = String(card.getAttribute('data-gallery-card-key') || '').trim();
    const productionSrc = image instanceof HTMLImageElement
      ? String(image.getAttribute('data-production-cover-src') || '').trim()
      : '';
    return {
      key,
      productionSrc,
      intersects,
      decoded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      terminal: intersects
        && image instanceof HTMLImageElement
        && image.complete
        && image.naturalWidth < 1
        && schedulerSettled,
    };
  }).filter((entry) => entry.key && entry.productionSrc && entry.intersects);
  const windowState = {
    candidateCount: entries.length,
    decodedCards: entries.filter((entry) => entry.decoded).map(({ key, productionSrc }) => ({
      key,
      productionSrc,
    })),
    schedulerSettled,
    terminalCount: entries.filter((entry) => entry.terminal).length,
  };
  if (args.snapshot) return windowState;
  return windowState.candidateCount > 0
    && windowState.decodedCards.length >= minimumDecodedCount
    && windowState.decodedCards.length + windowState.terminalCount === windowState.candidateCount;
}

export { readDecodedProductionCardWindow };

export class GalleryPage extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.albumCard = new AlbumCard(page, testInfo);
    this.albumCards = this.albumCard.cards;
    this.albumDetailsButtons = this.albumCard.detailsButtons;
    this.libraryLoader = page.locator(this.libraryLoaderSelector);
    this.libraryLoaderSpinner = page.locator(this.libraryLoaderSpinnerSelector);
    this.libraryLoaderStatus = page.locator(this.libraryLoaderStatusSelector);
    this.libraryLoaderTitle = page.locator(this.libraryLoaderTitleSelector);
    this.artistHeadings = page.locator(this.artistHeadingSelector);
    this.sectionLabels = page.locator(this.sectionLabelSelector);
    this.galleryScroll = page.locator(this.galleryScrollSelector);
    this.allArtistsActiveLink = page.locator(this.allArtistsActiveSelector);
    this.sidebarArtists = page.locator(this.sidebarArtistSelector);
    this.coverReadyStates = page.locator(this.coverReadyStateSelector);
    this.productionViewObserver = new ProductionViewObserver(page);
  }

  async hasVisibleAlbum(albumName) {
    const album = this.albumCard.cardByAlbumName(albumName).first();
    if (await album.count() === 0) return false;
    return album.isVisible();
  }

  get libraryLoaderSelector() {
    return '#library-loader';
  }

  get libraryLoaderSpinnerSelector() {
    return '#library-loader .library-loader-spinner';
  }

  get libraryLoaderStatusSelector() {
    return '#library-loader-status';
  }

  get libraryLoaderTitleSelector() {
    return '#library-loader-title';
  }

  get artistHeadingSelector() {
    return '#artist-groups .artist-name';
  }

  get artistSectionSelector() {
    return '#artist-groups .artist-section';
  }

  get artistHeadingWithinSectionSelector() {
    return '.artist-name';
  }

  get albumCardWithinSectionSelector() {
    return '.album-card';
  }

  get albumRowWithinSectionSelector() {
    return '.album-row';
  }

  get albumTitleButtonWithinSectionSelector() {
    return '.album-title-button';
  }

  get albumDetailsButtonWithinSectionSelector() {
    return '[data-open-tracklist="1"]';
  }

  get sectionLabelSelector() {
    return '#artist-groups .section-split-label';
  }

  get galleryScrollSelector() {
    return '#albums-scroll';
  }

  get allArtistsActiveSelector() {
    return '.artist-link.active[data-sidebar-all-artists="1"]';
  }

  get sidebarArtistSelector() {
    return '[data-sidebar-artist]';
  }

  get coverReadyStateSelector() {
    return '.cover img, .cover-placeholder';
  }

  sectionByArtistHeading(artistHeading) {
    return this.page.locator(this.artistSectionSelector).filter({
      has: this.page.locator(this.artistHeadingWithinSectionSelector).filter({
        hasText: exactNormalizedText(artistHeading),
      }),
    }).first();
  }

  headingByArtistName(artistName) {
    return this.artistHeadings.filter({ hasText: exactNormalizedText(artistName) }).first();
  }

  firstAlbumCardByArtistName(artistName) {
    return this.sectionByArtistHeading(artistName)
      .locator(this.albumCardWithinSectionSelector)
      .first();
  }

  albumRowsByArtistName(artistName) {
    return this.sectionByArtistHeading(artistName)
      .locator(this.albumRowWithinSectionSelector);
  }

  async readRenderedAlbumIdentities(artistName, expectedAlbumNames) {
    const section = this.sectionByArtistHeading(artistName);
    const matchingCards = section.locator(
      this.albumCardWithinSectionSelector,
    ).filter({
      has: this.page.locator(
        this.albumTitleButtonWithinSectionSelector,
      ),
    });
    // parity-check: allow-read-only-measurement-evaluate -- atomically read the current rendered production-card window without inspecting virtual-grid state
    return matchingCards.evaluateAll((cards, selectors) => {
      const expectedAlbums = new Set(selectors.expectedAlbumNames);
      return cards.map((element) => ({
        album: String(
          element.querySelector(selectors.albumTitleSelector)?.textContent || '',
        ).trim(),
        key: String(element.getAttribute('data-gallery-card-key') || '').trim(),
        year: String(
          element.querySelector(selectors.albumYearSelector)?.textContent || '',
        ).trim(),
      })).filter(({ album }) => expectedAlbums.has(album));
    }, {
      expectedAlbumNames: expectedAlbumNames.map((album) => String(album || '').trim()),
      albumTitleSelector: this.albumTitleButtonWithinSectionSelector,
      albumYearSelector: this.albumCard.yearWithinCardSelector,
    });
  }

  async readRenderedAlbumCardTrackCounts(artistName) {
    const section = this.sectionByArtistHeading(artistName);
    const renderedCards = section.locator(this.albumCardWithinSectionSelector);
    // parity-check: allow-read-only-measurement-evaluate -- atomically read the mounted production-card count labels
    return renderedCards.evaluateAll((cards, selectors) => cards.map((card) => {
      const trackCountText = String(
        card.querySelector(selectors.trackCountSelector)?.textContent || '',
      ).trim();
      const trackCountMatch = trackCountText.match(/^(\d+)\s+tracks?$/i);
      return {
        album: String(
          card.querySelector(selectors.albumTitleSelector)?.textContent || '',
        ).trim(),
        year: String(
          card.querySelector(selectors.albumYearSelector)?.textContent || '',
        ).trim(),
        trackCount: trackCountMatch ? Number(trackCountMatch[1]) : -1,
        trackCountText,
      };
    }).filter(({ album }) => Boolean(album)), {
      albumTitleSelector: this.albumTitleButtonWithinSectionSelector,
      albumYearSelector: this.albumCard.yearWithinCardSelector,
      trackCountSelector: this.albumCard.trackCountWithinCardSelector,
    });
  }

  async readMountedAlbumInventory() {
    // parity-check: allow-read-only-measurement-evaluate -- atomically read every mounted production-card identity and row position across current gallery sections
    return this.page.locator(this.artistSectionSelector).evaluateAll((sections, selectors) => (
      sections.flatMap((section, sectionIndex) => {
        const groupArtist = String(
          section.querySelector(selectors.artistHeadingSelector)?.textContent || '',
        ).trim();
        const sectionBounds = section.getBoundingClientRect();
        return [...section.querySelectorAll(selectors.albumCardSelector)].map(
          (card, orderIndex) => {
            const row = card.closest(selectors.albumRowSelector) || card;
            return {
              album: String(
                card.querySelector(selectors.albumTitleSelector)?.textContent || '',
              ).trim(),
              groupArtist,
              key: String(card.getAttribute('data-gallery-card-key') || '').trim(),
              orderIndex,
              rowTop: Math.round(row.getBoundingClientRect().top - sectionBounds.top),
              sectionIndex,
              trackCount: String(
                card.querySelector(selectors.trackCountSelector)?.textContent || '',
              ).trim(),
              year: String(
                card.querySelector(selectors.albumYearSelector)?.textContent || '',
              ).trim(),
            };
          },
        );
      })
    ), {
      albumCardSelector: this.albumCardWithinSectionSelector,
      albumRowSelector: this.albumRowWithinSectionSelector,
      albumTitleSelector: this.albumTitleButtonWithinSectionSelector,
      albumYearSelector: this.albumCard.yearWithinCardSelector,
      artistHeadingSelector: this.artistHeadingWithinSectionSelector,
      trackCountSelector: this.albumCard.trackCountWithinCardSelector,
    });
  }

  async readProductionVisibleAlbumObservation(artistName, expectedAlbumNames) {
    const section = this.sectionByArtistHeading(artistName);
    // parity-check: allow-read-only-measurement-evaluate -- atomically read the visible production section count and expected album identities
    const observation = await section.evaluate((element, selectors) => {
      const artistMetaText = String(
        element.querySelector('.artist-meta')?.textContent || '',
      ).trim();
      const expectedAlbums = new Set(selectors.expectedAlbumNames);
      const renderedIdentities = [...element.querySelectorAll(selectors.albumCardSelector)]
        .map((card) => ({
          album: String(
            card.querySelector(selectors.albumTitleSelector)?.textContent || '',
          ).trim(),
          year: String(
            card.querySelector(selectors.albumYearSelector)?.textContent || '',
          ).trim(),
        }))
        .filter(({ album }) => expectedAlbums.has(album));
      return {
        artistMetaText,
        renderedIdentities,
      };
    }, {
      albumCardSelector: this.albumCardWithinSectionSelector,
      albumTitleSelector: this.albumTitleButtonWithinSectionSelector,
      albumYearSelector: this.albumCard.yearWithinCardSelector,
      expectedAlbumNames: expectedAlbumNames.map((album) => String(album || '').trim()),
    });
    return {
      albumCount: parseArtistAlbumCount(observation.artistMetaText),
      renderedIdentities: observation.renderedIdentities,
    };
  }

  readViewGenerationState() {
    const observation = this.productionViewObserver.read();
    return {
      revision: Number(observation.stateRevision || 0),
      settled: Number(observation.activeRequestCount || 0) === 0
        && Number(observation.pendingPayloadReadCount || 0) === 0,
    };
  }

  async readVirtualGridDiagnostics() {
    // parity-check: allow-read-only-measurement-evaluate -- snapshot bounded production virtual-grid diagnostics
    return this.page.evaluate(() => {
      const diagnostics = globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
      if (!diagnostics || typeof diagnostics !== 'object') return null;
      return JSON.parse(JSON.stringify(diagnostics));
    });
  }

  async readAlbumGalleryViewportState(artistName, albumName, options = {}) {
    const year = String(options.year || '').trim();
    const cards = year
      ? this.albumCard.cardByIdentity(artistName, albumName, year)
      : this.albumCard.cardsByArtistAndAlbum(artistName, albumName);
    // parity-check: allow-read-only-measurement-evaluate -- atomically measure the exact virtual album card and its gallery viewport
    return cards.evaluateAll(
      (cards, galleryScrollSelector) => {
        if (cards.length === 0) {
          return {
            attached: false,
            detached: true,
            intersects: false,
            offscreen: true,
            scrollDirection: 0,
          };
        }
        const galleryScroll = document.querySelector(galleryScrollSelector);
        if (!(galleryScroll instanceof HTMLElement)) {
          throw new Error('Expected the gallery scroll surface to be visible.');
        }
        const cardBounds = cards[0].getBoundingClientRect();
        const galleryBounds = galleryScroll.getBoundingClientRect();
        if (!(galleryBounds.width > 0 && galleryBounds.height > 0)) {
          throw new Error('Expected the gallery scroll surface to be visible.');
        }
        if (!(cardBounds.width > 0 && cardBounds.height > 0)) {
          return {
            attached: true,
            detached: false,
            intersects: false,
            offscreen: true,
            scrollDirection: 0,
          };
        }
        const intersects = cardBounds.right > galleryBounds.left
          && cardBounds.left < galleryBounds.right
          && cardBounds.bottom > galleryBounds.top
          && cardBounds.top < galleryBounds.bottom;
        const scrollDirection = cardBounds.bottom <= galleryBounds.top
          ? -1
          : cardBounds.top >= galleryBounds.bottom
            ? 1
            : 0;
        return {
          attached: true,
          detached: false,
          intersects,
          offscreen: !intersects,
          scrollDirection,
        };
      },
      this.galleryScrollSelector,
    );
  }

  async readStatusPayload() {
    const response = await this.page.request.get('/status');
    if (!response.ok()) {
      throw new Error(`Expected production status telemetry, received HTTP ${response.status()}.`);
    }
    return response.json();
  }

  async readLatestProductionViewPayload() {
    const observation = await this.productionViewObserver.readLatestFullPayloadWhenSettled();
    if (observation.latestFullPayloadError) {
      throw new Error(`Production view observation failed: ${observation.latestFullPayloadError}`);
    }
    if (!observation.latestFullPayload) {
      throw new Error('Expected an observed production view response before reading browse telemetry.');
    }
    return observation.latestFullPayload;
  }

  async readAlbumTargetState(expected = {}) {
    const initialObservation = this.productionViewObserver.read();
    if (initialObservation.latestFullPayloadError) {
      throw new Error(`Production view observation failed: ${initialObservation.latestFullPayloadError}`);
    }
    const initiallyBusy = initialObservation.activeRequestCount > 0
      || initialObservation.pendingPayloadReadCount > 0;
    const bootstrapPayload = !initialObservation.latestFullPayload && !initiallyBusy
      ? await this.readProductionBootstrapPayload()
      : null;
    const payload = initialObservation.latestFullPayload
      || bootstrapPayload?.startup_payload?.first_paint_view
      || bootstrapPayload?.initial_view
      || null;
    const input = this.page.locator('#search-input');
    const inputQuery = await input.count() ? await input.inputValue() : '';
    const canonicalQuery = String(inputQuery || '').trim();
    const expectedQuery = expected.query === undefined
      ? canonicalQuery
      : String(expected.query || '').trim();
    const expectedArtist = String(expected.artist || '').trim();
    const expectedAlbum = String(expected.album || '').trim();
    const canonicalEvidence = readCanonicalAlbumTargetEvidence({
      ...initialObservation,
      latestFullPayload: payload,
    }, {
      album: expectedAlbum,
      artist: expectedArtist,
    });
    const initialAttachedMatch = await this.albumCard
      .detailsButtonByArtistAndAlbum(expectedArtist, expectedAlbum)
      .count() > 0;
    const locationQuery = new URL(this.page.url()).searchParams.get('q') || '';
    const loaderVisible = await this.libraryLoader.isVisible();
    const spinnerVisible = loaderVisible
      && await this.libraryLoaderSpinner.isVisible();
    const loaderTitle = loaderVisible
      ? String(await this.libraryLoaderTitle.textContent() || '').trim()
      : '';
    const loaderStatus = loaderVisible
      ? String(await this.libraryLoaderStatus.textContent() || '').trim()
      : '';
    const settledEmpty = loaderVisible
      && !spinnerVisible
      && loaderTitle === 'Nothing found'
      && loaderStatus === 'No artists, albums, or tracks matched your search.';
    const activeLoader = loaderVisible && !settledEmpty;
    const attachedArtists = (await this.artistHeadings.allTextContents())
      .map((artist) => String(artist || '').trim())
      .filter(Boolean);
    const startupHydrating = payload === null || Boolean(
      bootstrapPayload?.bootstrap?.startupHydration?.required,
    );
    const finalAttachedMatch = await this.albumCard
      .detailsButtonByArtistAndAlbum(expectedArtist, expectedAlbum)
      .count() > 0;
    const finalAttachedArtists = (await this.artistHeadings.allTextContents())
      .map((artist) => String(artist || '').trim())
      .filter(Boolean);
    const finalObservation = this.productionViewObserver.read();
    if (finalObservation.latestFullPayloadError) {
      throw new Error(`Production view observation failed: ${finalObservation.latestFullPayloadError}`);
    }
    const observationChanged = finalObservation.stateRevision !== initialObservation.stateRevision;
    const domChanged = !hasStableDomEvidence(
      { attachedArtists, attachedMatch: initialAttachedMatch },
      { attachedArtists: finalAttachedArtists, attachedMatch: finalAttachedMatch },
    );
    const busy = initiallyBusy
      || finalObservation.activeRequestCount > 0
      || finalObservation.pendingPayloadReadCount > 0
      || observationChanged
      || domChanged;
    const canonicalApplied = hasAppliedCanonicalArtistSurface(
      canonicalEvidence.observedArtists,
      finalAttachedArtists,
      {
        loaderVisible,
        payloadPresent: payload !== null,
        settledEmpty,
      },
    );

    return {
      activeLoader,
      activeRequestUrl: finalObservation.activeRequestUrl,
      attachedMatch: finalAttachedMatch,
      busy,
      canonicalApplied,
      canonicalMatch: canonicalEvidence.canonicalMatch,
      canonicalSource: canonicalEvidence.canonicalSource,
      canonicalQuery,
      expectedAlbum,
      expectedArtist,
      expectedQuery,
      inputQuery: String(inputQuery || '').trim(),
      latestFullRequestUrl: finalObservation.latestFullRequestUrl,
      loaderStatus,
      loaderTitle,
      locationQuery: String(locationQuery || '').trim(),
      observedAlbums: canonicalEvidence.observedAlbums,
      observedArtists: canonicalEvidence.observedArtists,
      pendingViewTransition: busy || (!startupHydrating && !canonicalApplied),
      settledEmpty,
      startupHydrating,
    };
  }

  async waitForCoverSchedulerIdle(options = {}) {
    await this.waitForPageCondition(() => {
      const diagnostics = globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__;
      return Boolean(
        diagnostics
        && diagnostics.active === 0
        && diagnostics.queuedVisible === 0
        && diagnostics.queuedNear === 0
        && diagnostics.queuedBackground === 0
      );
    }, { timeout: options.timeout || 30000 });
  }

  async waitForDecodedProductionCardWindow(options = {}) {
    const selectors = {
      cardSelector: this.albumCard.cardSelector,
      coverImageSelector: this.albumCard.coverImageWithinCardSelector,
      galleryScrollSelector: this.galleryScrollSelector,
      minimumDecodedCount: options.minimumDecodedCount,
    };
    try {
      await this.waitForPageCondition(
        readDecodedProductionCardWindow,
        { timeout: options.timeout || 10000 },
        selectors,
      );
    } catch (error) {
      // parity-check: allow-read-only-measurement-evaluate -- snapshot the stalled production-card window
      const windowState = await this.page.evaluate(readDecodedProductionCardWindow, {
        ...selectors,
        snapshot: true,
      });
      // parity-check: allow-read-only-measurement-evaluate -- explain a stalled virtual gallery window
      const diagnostics = await this.page.evaluate((args) => {
        const scroll = document.querySelector(args.galleryScrollSelector);
        const container = document.querySelector('#artist-groups');
        const topSpacer = document.querySelector('#albums-spacer-top');
        const bottomSpacer = document.querySelector('#albums-spacer-bottom');
        const rect = (element) => {
          if (!(element instanceof HTMLElement)) return null;
          const bounds = element.getBoundingClientRect();
          return {
            top: bounds.top,
            bottom: bounds.bottom,
            height: bounds.height,
          };
        };
        const scrollBounds = rect(scroll);
        return {
          scroll: scroll instanceof HTMLElement ? {
            scrollTop: scroll.scrollTop,
            clientHeight: scroll.clientHeight,
            scrollHeight: scroll.scrollHeight,
            bounds: scrollBounds,
          } : null,
          topSpacer: rect(topSpacer),
          bottomSpacer: rect(bottomSpacer),
          container: rect(container),
          sections: [...document.querySelectorAll('#artist-groups .artist-section')].map((section) => ({
            title: String(section.querySelector('.artist-name')?.textContent || '').trim(),
            bounds: rect(section),
          })),
          cards: [...document.querySelectorAll(args.cardSelector)].map((card) => {
            const image = card.querySelector(args.coverImageSelector);
            const bounds = rect(card);
            return {
              title: String(card.querySelector('.album-title-button')?.textContent || '').trim(),
              bounds,
              intersects: Boolean(bounds && scrollBounds
                && bounds.bottom > scrollBounds.top
                && bounds.top < scrollBounds.bottom),
              complete: image instanceof HTMLImageElement && image.complete,
              naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
              loading: image instanceof HTMLImageElement
                ? String(image.getAttribute('data-gallery-cover-loading') || '')
                : '',
            };
          }),
          scheduler: { ...(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ || {}) },
          virtualGrid: { ...(globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ || {}) },
        };
      }, selectors);
      throw new Error(
        `Decoded production-card window stalled: ${JSON.stringify({ windowState, ...diagnostics })}`,
        { cause: error },
      );
    }

    // parity-check: allow-read-only-measurement-evaluate -- snapshot the settled production-card window
    return this.page.evaluate(readDecodedProductionCardWindow, {
      ...selectors,
      snapshot: true,
    });
  }

  async waitForGalleryScrollMovement(previousScrollTop, direction, options = {}) {
    await this.waitForPageCondition(hasSettledVirtualGalleryRender, {
      timeout: options.timeout || 5000,
    }, {
      expectedDirection: Number(direction || 1),
      galleryScrollSelector: this.galleryScrollSelector,
      priorPosition: Number(previousScrollTop || 0),
    });
  }

  async waitForVirtualGalleryMeasurementSettled(options = {}) {
    await this.waitForPageCondition(hasSettledVirtualGalleryMeasurement, {
      timeout: options.timeout || 5000,
    }, {
      galleryScrollSelector: this.galleryScrollSelector,
    });
  }

  async readCoverCacheState(productionUrl) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the production Cache Storage and diagnostics contract
    return this.page.evaluate(async (url) => {
      const diagnostics = globalThis.__ALBUM_HAVEN_GALLERY_COVER_CACHE__;
      const cache = await globalThis.caches.open(String(diagnostics?.cacheName || ''));
      const response = await cache.match(url);
      return {
        active: Array.isArray(diagnostics?.activeProductionUrls)
          && diagnostics.activeProductionUrls.includes(url),
        activeCount: Number(diagnostics?.activeCount || 0),
        cached: Boolean(response),
        cachedStatus: Number(response?.status || 0),
        cachedType: String(response?.headers?.get?.('content-type') || ''),
      };
    }, productionUrl);
  }

  async startAlbumCardMultiplicityObservation(expected) {
    const observationHandle = await this.page.evaluateHandle((options) => {
      const gallery = document.querySelector('#artist-groups');
      if (!(gallery instanceof HTMLElement)) {
        throw new Error('Album-card multiplicity observation requires the mounted gallery.');
      }
      const normalize = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
      const expectedArtist = normalize(options.artist);
      const expectedAlbum = normalize(options.album);
      const expectedYear = normalize(options.year);
      const samples = [];
      let mutationRecordCount = 0;
      let estimatedCount = 0;
      let recordPeakCount = 0;
      const countMatchingCardsInNode = (node) => {
        if (!(node instanceof Element)) return 0;
        const candidates = [
          ...(node.matches(options.albumCardWithinSectionSelector) ? [node] : []),
          ...node.querySelectorAll(options.albumCardWithinSectionSelector),
        ];
        return candidates.filter((card) => (
          normalize(card.querySelector(options.albumTitleSelector)?.textContent) === expectedAlbum
          && normalize(card.querySelector(options.albumYearSelector)?.textContent) === expectedYear
        )).length;
      };
      const readCount = () => {
        const section = Array.from(document.querySelectorAll(options.artistSectionSelector))
          .find((candidate) => normalize(
            candidate.querySelector(options.artistHeadingWithinSectionSelector)?.textContent,
          ) === expectedArtist);
        if (!(section instanceof HTMLElement)) return 0;
        return Array.from(section.querySelectorAll(options.albumCardWithinSectionSelector))
          .filter((card) => (
            normalize(card.querySelector(options.albumTitleSelector)?.textContent) === expectedAlbum
            && normalize(card.querySelector(options.albumYearSelector)?.textContent) === expectedYear
          )).length;
      };
      const inspect = (phase, records = []) => {
        mutationRecordCount += records.length;
        let matchingAdded = 0;
        let matchingRemoved = 0;
        records.forEach((record) => {
          if (record.type !== 'childList') return;
          matchingAdded += Array.from(record.addedNodes)
            .reduce((sum, node) => sum + countMatchingCardsInNode(node), 0);
          matchingRemoved += Array.from(record.removedNodes)
            .reduce((sum, node) => sum + countMatchingCardsInNode(node), 0);
          estimatedCount = Math.max(
            0,
            estimatedCount
              + Array.from(record.addedNodes)
                .reduce((sum, node) => sum + countMatchingCardsInNode(node), 0)
              - Array.from(record.removedNodes)
                .reduce((sum, node) => sum + countMatchingCardsInNode(node), 0),
          );
          recordPeakCount = Math.max(recordPeakCount, estimatedCount);
        });
        const count = readCount();
        if (!records.length) {
          estimatedCount = count;
          recordPeakCount = Math.max(recordPeakCount, count);
        }
        samples.push({
          phase: String(phase || ''),
          count,
          matchingAdded,
          matchingRemoved,
          mutationRecords: records.length,
        });
      };
      estimatedCount = readCount();
      recordPeakCount = estimatedCount;
      inspect('initial');
      const observer = new MutationObserver((records) => inspect('mutation', records));
      observer.observe(gallery, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      return {
        checkpoint(phase) {
          const pending = observer.takeRecords();
          if (pending.length) inspect('pending-mutation', pending);
          inspect(phase);
          return samples.at(-1);
        },
        finish() {
          const pending = observer.takeRecords();
          if (pending.length) inspect('pending-mutation', pending);
          inspect('final');
          observer.disconnect();
          return {
            finalCount: samples.at(-1)?.count || 0,
            maxCount: Math.max(
              recordPeakCount,
              ...samples.map((sample) => sample.count),
            ),
            mutationRecordCount,
            samples: [...samples],
          };
        },
      };
    }, {
      album: String(expected.album || '').trim(),
      artist: String(expected.artist || '').trim(),
      year: String(expected.year || '').trim(),
      artistSectionSelector: this.artistSectionSelector,
      artistHeadingWithinSectionSelector: this.artistHeadingWithinSectionSelector,
      albumCardWithinSectionSelector: this.albumCardWithinSectionSelector,
      albumTitleSelector: this.albumCard.titleButtonSelector,
      albumYearSelector: this.albumCard.yearWithinCardSelector,
    });
    let finished = false;
    return {
      // parity-check: allow-read-only-measurement-evaluate -- snapshot exact-card multiplicity without changing app state
      checkpoint: async (phase) => observationHandle.evaluate(
        (observation, label) => observation.checkpoint(label),
        String(phase || ''),
      ),
      finish: async () => {
        if (finished) return null;
        finished = true;
        // parity-check: allow-read-only-measurement-evaluate -- disconnect and read the gallery mutation observer
        const result = await observationHandle.evaluate((observation) => observation.finish());
        await observationHandle.dispose();
        return result;
      },
    };
  }

  async startStableAlbumTopologyObservation(expected = {}) {
    const identities = Array.isArray(expected.identities)
      ? expected.identities.map((identity) => ({
        album: String(identity.album || '').trim(),
        trackCount: String(identity.trackCount || '').trim(),
        year: String(identity.year || '').trim(),
      }))
      : [];
    const absentIdentities = Array.isArray(expected.absentIdentities)
      ? expected.absentIdentities.map((identity) => ({
        album: String(identity.album || '').trim(),
        year: String(identity.year || '').trim(),
      }))
      : [];
    if (!identities.length) {
      throw new Error('Stable album-topology observation requires album identities.');
    }
    const observationHandle = await this.galleryScroll.evaluateHandle((gallery, options) => {
      const normalize = (value) => String(value || '').trim();
      const expectedIdentityKeys = options.identities.map(
        ({ album, year }) => `${album}\u0000${year}`,
      );
      const expectedTrackCounts = Object.fromEntries(options.identities.map(
        ({ album, trackCount, year }) => [`${album}\u0000${year}`, trackCount],
      ));
      const absentIdentityKeys = options.absentIdentities.map(
        ({ album, year }) => `${album}\u0000${year}`,
      );
      const samples = [];
      const violations = [];
      const cardNodeIds = new WeakMap();
      let nextCardNodeId = 1;
      let armed = false;
      let baseline = null;
      let mutationRecordCount = 0;

      const readSnapshot = (phase) => {
        const section = Array.from(document.querySelectorAll(options.artistSectionSelector))
          .find((candidate) => normalize(
            candidate.querySelector(options.artistHeadingWithinSectionSelector)?.textContent,
          ) === options.artist);
        const cards = section instanceof HTMLElement
          ? Array.from(section.querySelectorAll(options.albumCardWithinSectionSelector))
          : [];
        const sectionBounds = section instanceof HTMLElement
          ? section.getBoundingClientRect()
          : { top: 0 };
        const observedCards = cards.map((card, orderIndex) => {
          if (!cardNodeIds.has(card)) {
            cardNodeIds.set(card, nextCardNodeId);
            nextCardNodeId += 1;
          }
          const album = normalize(card.querySelector(options.albumTitleSelector)?.textContent);
          const year = normalize(card.querySelector(options.albumYearSelector)?.textContent);
          const row = card.closest(options.albumRowWithinSectionSelector) || card;
          const rowBounds = row.getBoundingClientRect();
          return {
            album,
            key: normalize(card.getAttribute('data-gallery-card-key')),
            nodeId: cardNodeIds.get(card),
            orderIndex,
            rowTop: Math.round(rowBounds.top - sectionBounds.top),
            trackCount: normalize(
              card.querySelector(options.albumTrackCountSelector)?.textContent,
            ),
            year,
          };
        });
        const matchingCards = observedCards.filter(({ album, year }) => (
          expectedIdentityKeys.includes(`${album}\u0000${year}`)
        ));
        return {
          phase: String(phase || ''),
          cards: observedCards,
          galleryRootConnected: gallery.isConnected
            && document.querySelector(options.galleryScrollSelector) === gallery,
          identities: matchingCards,
          identityCounts: Object.fromEntries(
            [...expectedIdentityKeys, ...absentIdentityKeys].map((identityKey) => [
            identityKey,
            observedCards.filter(({ album, year }) => (
              `${album}\u0000${year}` === identityKey
            )).length,
          ])),
        };
      };

      const sameTopology = (left, right) => (
        JSON.stringify(left.cards) === JSON.stringify(right.cards)
      );
      const inspect = (phase, records = []) => {
        mutationRecordCount += records.length;
        const sample = readSnapshot(phase);
        samples.push(sample);
        if (armed && baseline && !sameTopology(sample, baseline)) {
          violations.push(sample);
        }
        return sample;
      };

      const observer = new MutationObserver((records) => inspect('mutation', records));
      observer.observe(gallery, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      inspect('initial');
      return {
        checkpoint(phase, shouldArm = false, strictArm = true) {
          const pending = observer.takeRecords();
          if (pending.length) inspect('pending-mutation', pending);
          const sample = inspect(phase);
          if (shouldArm && !armed) {
            const exactMultiplicity = expectedIdentityKeys.every(
              (identityKey) => sample.identityCounts[identityKey] === 1,
            );
            const exactTrackCounts = expectedIdentityKeys.every((identityKey) => {
              const expectedTrackCount = expectedTrackCounts[identityKey];
              if (!expectedTrackCount) return true;
              return sample.identities.find(
                ({ album, year }) => `${album}\u0000${year}` === identityKey,
              )?.trackCount === expectedTrackCount;
            });
            const exactAbsence = absentIdentityKeys.every(
              (identityKey) => sample.identityCounts[identityKey] === 0,
            );
            if (
              !exactMultiplicity
              || !exactTrackCounts
              || !exactAbsence
              || sample.identities.length !== expectedIdentityKeys.length
            ) {
              if (!strictArm) {
                armed = true;
                baseline = sample;
                return {
                  armFailure: {
                    exactAbsence,
                    exactMultiplicity,
                    exactTrackCounts,
                    matchingIdentityCount: sample.identities.length,
                  },
                  armed,
                  baseline,
                  sample,
                  violationCount: violations.length,
                };
              }
              throw new Error(
                `Cannot arm stable album topology from ${JSON.stringify(sample)}.`,
              );
            }
            armed = true;
            baseline = sample;
          }
          return {
            armed,
            baseline,
            sample,
            violationCount: violations.length,
          };
        },
        finish() {
          const pending = observer.takeRecords();
          if (pending.length) inspect('pending-mutation', pending);
          const finalSample = inspect('final');
          observer.disconnect();
          return {
            armed,
            baseline,
            finalSample,
            mutationRecordCount,
            samples: [...samples],
            violations: [...violations],
          };
        },
      };
    }, {
      artist: String(expected.artist || '').trim(),
      identities,
      absentIdentities,
      artistSectionSelector: this.artistSectionSelector,
      artistHeadingWithinSectionSelector: this.artistHeadingWithinSectionSelector,
      albumCardWithinSectionSelector: this.albumCardWithinSectionSelector,
      albumRowWithinSectionSelector: this.albumRowWithinSectionSelector,
      albumTitleSelector: this.albumCard.titleButtonSelector,
      albumTrackCountSelector: this.albumCard.trackCountWithinCardSelector,
      albumYearSelector: this.albumCard.yearWithinCardSelector,
      galleryScrollSelector: this.galleryScrollSelector,
    });
    let finished = false;
    return {
      // parity-check: allow-read-only-measurement-evaluate -- arm or sample exact production-card identity, order, and row geometry
      checkpoint: async (phase, options = {}) => observationHandle.evaluate(
        (observation, input) => observation.checkpoint(
          input.phase,
          input.arm,
          input.strictArm,
        ),
        {
          arm: options.arm === true,
          phase: String(phase || ''),
          strictArm: options.strict !== false,
        },
      ),
      finish: async () => {
        if (finished) return null;
        finished = true;
        // parity-check: allow-read-only-measurement-evaluate -- disconnect and read the stable gallery-topology observer
        const result = await observationHandle.evaluate((observation) => observation.finish());
        await observationHandle.dispose();
        return result;
      },
    };
  }
}
