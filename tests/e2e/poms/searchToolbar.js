import { BasePage } from './basePage.js';
import {
  ProductionViewObserver,
  hasAppliedCanonicalArtistSurface,
  hasStableDomEvidence,
  readCanonicalArtistGroups,
} from '../helpers/productionViewObserver.js';

export function resolveCurrentCanonicalQuery(payloadQuery, runtimeQuery) {
  if (runtimeQuery === null || runtimeQuery === undefined) {
    return String(payloadQuery || '').trim();
  }
  return String(runtimeQuery || '').trim();
}

export function resolveCurrentCanonicalView(payload = {}, runtimeView = null) {
  const payloadQuery = String(payload?.query || '').trim();
  const runtimeQuery = runtimeView && typeof runtimeView === 'object'
    ? String(runtimeView.query || '').trim()
    : null;
  if (runtimeQuery !== null && runtimeQuery !== payloadQuery) {
    return {
      query: runtimeQuery,
      surface: String(runtimeView.surface || '').trim().toLowerCase(),
      artists: [...new Set(
        (Array.isArray(runtimeView.artists) ? runtimeView.artists : [])
          .map((artist) => String(artist || '').trim())
          .filter(Boolean),
      )],
    };
  }
  return {
    query: payloadQuery,
    surface: String(payload?.surface?.active || '').trim().toLowerCase(),
    artists: readCanonicalArtistGroups(payload).map((group) => group.artist),
  };
}

export class SearchToolbar extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.form = page.locator(this.formSelector);
    this.input = page.locator(this.inputSelector);
    this.applyButton = page.locator(this.applyButtonSelector);
    this.recentSearchPopover = page.getByRole('listbox', { name: 'Recent searches' });
    this.recentSearchOptions = this.recentSearchPopover.getByRole('option');
    this.mainContent = page.getByRole('main');
    this.productionViewObserver = new ProductionViewObserver(page);
  }

  get formSelector() {
    return '#search-form';
  }

  get inputSelector() {
    return '#search-input';
  }

  get applyButtonSelector() {
    return '#search-form button[type="submit"]';
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

  get artistGroupsSelector() {
    return '#artist-groups';
  }

  get galleryScrollSelector() {
    return '#albums-scroll';
  }

  get albumCardSelector() {
    return '#artist-groups .album-card';
  }

  get albumCoverImageSelector() {
    return '.cover img';
  }

  get artistFamilyPanelSelector() {
    return '#related-box';
  }

  get artistFamilyToggleSelector() {
    return '#related-toggle';
  }

  get artistFamilyListSelector() {
    return '#related-list';
  }

  get artistFamilyChipSelector() {
    return '#related-list .related-chip';
  }

  get sidebarArtistSelector() {
    return '[data-sidebar-artist]';
  }

  get sidebarArtistNameSelector() {
    return `${this.sidebarArtistSelector} .artist-name-label`;
  }

  recentSearchOption(query) {
    return this.recentSearchPopover.getByRole('option', {
      name: String(query || '').trim(),
      exact: true,
    });
  }

  async startSearchClearTransitionObservation() {
    const viewDataRequests = [];
    const familyViewDataRequests = [];
    const activeViewDataRequests = new Set();
    const familyVisibilityBoundaryChecks = [];
    let familyControlsVisibleDuringActiveRequest = false;
    let observationHandle = null;
    const recordFamilyVisibilityAtRequestBoundary = () => {
      if (!observationHandle) return;
      familyVisibilityBoundaryChecks.push(
        // parity-check: allow-read-only-measurement-evaluate -- measure Artist Family visibility at the active view-request boundary
        observationHandle.evaluate(
          (observation) => observation.read(),
        ).then((domResult) => {
          familyControlsVisibleDuringActiveRequest ||= Boolean(
            domResult.artistFamilyPanelVisible
            && domResult.runtimeViewRequestActive
          );
        }),
      );
    };
    const recordRequest = (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/view-data') {
        viewDataRequests.push(request.url());
        if (
          url.searchParams.has('artist')
          || url.searchParams.has('related_filter_artists')
          || String(url.searchParams.get('payload_tier') || '').trim() !== 'sidebar'
        ) {
          familyViewDataRequests.push(request.url());
        }
        activeViewDataRequests.add(request);
        recordFamilyVisibilityAtRequestBoundary();
      }
    };
    const finishRequest = (request) => {
      activeViewDataRequests.delete(request);
    };
    this.page.on('request', recordRequest);
    this.page.on('requestfinished', finishRequest);
    this.page.on('requestfailed', finishRequest);
    // parity-check: allow-read-only-measurement-evaluate -- observe loader and gallery mutations without changing app state
    observationHandle = await this.page.evaluateHandle((selectors) => {
      const gallery = document.querySelector(selectors.artistGroupsSelector);
      if (!(gallery instanceof HTMLElement)) {
        throw new Error('Search-clear observation requires the mounted artist gallery.');
      }
      const galleryScroll = document.querySelector(selectors.galleryScrollSelector);
      if (!(galleryScroll instanceof HTMLElement)) {
        throw new Error('Search-clear observation requires the mounted gallery scroll surface.');
      }
      const visible = (element) => {
        if (!(element instanceof HTMLElement) || element.hidden) return false;
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.visibility !== 'collapse'
          && Number(style.opacity || 1) > 0
          && bounds.width > 0
          && bounds.height > 0;
      };
      const initialGalleryText = String(gallery.textContent || '');
      const initialGalleryChildren = Array.from(gallery.children);
      const initialCards = Array.from(gallery.querySelectorAll(selectors.albumCardSelector));
      const initialCardContent = initialCards.map((card) => String(card.textContent || ''));
      const galleryViewport = galleryScroll.getBoundingClientRect();
      const initialVisibleCards = initialCards.filter((card) => {
        const bounds = card.getBoundingClientRect();
        return bounds.width > 0
          && bounds.height > 0
          && bounds.right > galleryViewport.left
          && bounds.left < galleryViewport.right
          && bounds.bottom > galleryViewport.top
          && bounds.top < galleryViewport.bottom;
      });
      const initialCoverImages = initialVisibleCards.map(
        (card) => card.querySelector(selectors.albumCoverImageSelector),
      );
      const readCoverState = (image) => (
        image instanceof HTMLImageElement
          ? {
            complete: Boolean(image.complete),
            currentSrc: String(image.currentSrc || ''),
            naturalHeight: Number(image.naturalHeight || 0),
            naturalWidth: Number(image.naturalWidth || 0),
            productionSrc: String(
              image.getAttribute('data-production-cover-src') || '',
            ),
            src: String(image.getAttribute('src') || ''),
          }
          : null
      );
      const initialCoverStates = initialCoverImages.map(readCoverState);
      const initialScrollTop = Number(galleryScroll.scrollTop || 0);
      const initialScrollHeight = Number(galleryScroll.scrollHeight || 0);
      const artistFamilyPanel = document.querySelector(selectors.artistFamilyPanelSelector);
      const artistFamilyToggle = document.querySelector(selectors.artistFamilyToggleSelector);
      const artistFamilyList = document.querySelector(selectors.artistFamilyListSelector);
      const initialFamilyChips = Array.from(
        document.querySelectorAll(selectors.artistFamilyChipSelector),
      );
      const initialFamilyChipTexts = initialFamilyChips.map(
        (chip) => String(chip.textContent || '').trim(),
      );
      const readFamilySelection = (chips) => chips.map((chip) => ({
        active: chip.classList.contains('active'),
        ariaPressed: String(chip.getAttribute('aria-pressed') || ''),
        primary: chip.classList.contains('is-primary'),
      }));
      const initialFamilySelection = readFamilySelection(initialFamilyChips);
      const initialFamilyPanelText = String(artistFamilyPanel?.textContent || '');
      const initialFamilyScrollTop = Number(artistFamilyList?.scrollTop || 0);
      const initialFamilyScrollHeight = Number(artistFamilyList?.scrollHeight || 0);
      const initialFamilyVisible = visible(artistFamilyPanel);
      const result = {
        cardContentChanged: false,
        cardNodesChanged: false,
        coverNodesChanged: false,
        coverStateChanged: false,
        galleryContentChanged: false,
        galleryMutationCount: 0,
        galleryReplaced: false,
        galleryReplacementMutationCount: 0,
        galleryScrollChanged: false,
        familyChipContentChanged: false,
        familyChipNodesChanged: false,
        familyControlsHidden: false,
        familyListReplaced: false,
        familyMutationCount: 0,
        familyPanelContentChanged: false,
        familyPanelReplaced: false,
        familyScrollChanged: false,
        familySelectionChanged: false,
        familyToggleReplaced: false,
        libraryLoaderMutationCount: 0,
        loaderActivated: false,
        spinnerMutationCount: 0,
        spinnerActivated: false,
      };
      const mutationTouches = (record, element) => {
        if (!(element instanceof Node)) return false;
        const target = record.target.nodeType === Node.TEXT_NODE
          ? record.target.parentNode
          : record.target;
        if (target === element || (target instanceof Node && element.contains(target))) {
          return true;
        }
        if (record.type !== 'childList') return false;
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) => node === element || (node instanceof Node && node.contains?.(element)),
        );
      };
      const mutationTouchesFamilyControls = (record) => (
        mutationTouches(record, artistFamilyPanel)
      );
      const inspect = (mutationRecords = []) => {
        const currentGallery = document.querySelector(selectors.artistGroupsSelector);
        const currentGalleryScroll = document.querySelector(selectors.galleryScrollSelector);
        const currentCards = currentGallery instanceof HTMLElement
          ? Array.from(currentGallery.querySelectorAll(selectors.albumCardSelector))
          : [];
        const currentCoverImages = initialVisibleCards.map(
          (card) => card.isConnected
            ? card.querySelector(selectors.albumCoverImageSelector)
            : null,
        );
        const libraryLoader = document.querySelector(selectors.libraryLoaderSelector);
        const spinner = document.querySelector(selectors.libraryLoaderSpinnerSelector);
        const currentFamilyPanel = document.querySelector(selectors.artistFamilyPanelSelector);
        const currentFamilyToggle = document.querySelector(selectors.artistFamilyToggleSelector);
        const currentFamilyList = document.querySelector(selectors.artistFamilyListSelector);
        const currentFamilyChips = Array.from(
          document.querySelectorAll(selectors.artistFamilyChipSelector),
        );
        result.galleryReplaced ||= currentGallery !== gallery;
        result.cardNodesChanged ||= (
          currentCards.length !== initialCards.length
          || currentCards.some((card, index) => card !== initialCards[index])
        );
        result.cardContentChanged ||= (
          currentCards.length !== initialCardContent.length
          || currentCards.some(
            (card, index) => String(card.textContent || '') !== initialCardContent[index],
          )
        );
        result.coverNodesChanged ||= (
          currentCoverImages.length !== initialCoverImages.length
          || currentCoverImages.some(
            (image, index) => image !== initialCoverImages[index],
          )
        );
        result.coverStateChanged ||= (
          currentCoverImages.length !== initialCoverStates.length
          || currentCoverImages.some(
            (image, index) => (
              JSON.stringify(readCoverState(image))
              !== JSON.stringify(initialCoverStates[index])
            ),
          )
        );
        result.galleryScrollChanged ||= (
          !(currentGalleryScroll instanceof HTMLElement)
          || Number(currentGalleryScroll.scrollTop || 0) !== initialScrollTop
          || Number(currentGalleryScroll.scrollHeight || 0) !== initialScrollHeight
        );
        result.familyPanelReplaced ||= currentFamilyPanel !== artistFamilyPanel;
        result.familyToggleReplaced ||= currentFamilyToggle !== artistFamilyToggle;
        result.familyListReplaced ||= currentFamilyList !== artistFamilyList;
        result.familyChipNodesChanged ||= (
          currentFamilyChips.length !== initialFamilyChips.length
          || currentFamilyChips.some((chip, index) => chip !== initialFamilyChips[index])
        );
        result.familyChipContentChanged ||= (
          currentFamilyChips.length !== initialFamilyChipTexts.length
          || currentFamilyChips.some(
            (chip, index) => String(chip.textContent || '').trim() !== initialFamilyChipTexts[index],
          )
        );
        result.familyPanelContentChanged ||= (
          String(currentFamilyPanel?.textContent || '') !== initialFamilyPanelText
        );
        result.familySelectionChanged ||= (
          JSON.stringify(readFamilySelection(currentFamilyChips))
          !== JSON.stringify(initialFamilySelection)
        );
        result.familyScrollChanged ||= (
          !(currentFamilyList instanceof HTMLElement)
          || Number(currentFamilyList.scrollTop || 0) !== initialFamilyScrollTop
          || Number(currentFamilyList.scrollHeight || 0) !== initialFamilyScrollHeight
        );
        result.familyControlsHidden ||= initialFamilyVisible && !visible(currentFamilyPanel);
        result.galleryContentChanged ||= (
          !(currentGallery instanceof HTMLElement)
          || String(currentGallery.textContent || '') !== initialGalleryText
          || currentGallery.children.length !== initialGalleryChildren.length
          || Array.from(currentGallery.children).some(
            (child, index) => child !== initialGalleryChildren[index],
          )
          || mutationRecords.some((record) => {
            if (!['childList', 'characterData'].includes(record.type)) return false;
            if (mutationTouchesFamilyControls(record)) return false;
            const target = record.target.nodeType === Node.TEXT_NODE
              ? record.target.parentNode
              : record.target;
            return target === gallery || (target instanceof Node && gallery.contains(target));
          })
        );
        for (const record of mutationRecords) {
          if (
            mutationTouches(record, gallery)
            && !mutationTouchesFamilyControls(record)
          ) {
            result.galleryMutationCount += 1;
          }
          if (mutationTouches(record, libraryLoader)) {
            result.libraryLoaderMutationCount += 1;
          }
          if (mutationTouches(record, spinner)) {
            result.spinnerMutationCount += 1;
          }
          if (mutationTouchesFamilyControls(record)) {
            result.familyMutationCount += 1;
          }
          if (
            record.type === 'childList'
            && [...record.addedNodes, ...record.removedNodes].some(
              (node) => (
                node === gallery
                || initialCards.includes(node)
                || (
                  node instanceof Element
                  && (
                    node.matches(selectors.artistGroupsSelector)
                    || node.matches(selectors.albumCardSelector)
                    || Boolean(node.querySelector(selectors.artistGroupsSelector))
                    || Boolean(node.querySelector(selectors.albumCardSelector))
                  )
                )
              ),
            )
          ) {
            result.galleryReplacementMutationCount += 1;
          }
        }
        result.loaderActivated ||= visible(
          libraryLoader,
        );
        result.spinnerActivated ||= visible(
          spinner,
        );
      };
      inspect();
      const observer = new MutationObserver((records) => inspect(records));
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      return {
        read() {
          inspect();
          return {
            ...result,
            decodedCoverCount: initialCoverStates.filter(
              (cover) => cover?.complete && cover.naturalWidth > 0,
            ).length,
            artistFamilyPanelVisible: visible(artistFamilyPanel),
            galleryScrollTop: initialScrollTop,
            runtimeViewRequestActive: (
              typeof state !== 'undefined'
              && Boolean(state?.busy)
              && String(state?.ui?.activeViewRequestUrl || '').startsWith('/view-data')
            ),
          };
        },
        finish() {
          inspect();
          observer.disconnect();
          const popover = document.querySelector(selectors.recentSearchPopoverSelector);
          return {
            ...result,
            decodedCoverCount: initialCoverStates.filter(
              (cover) => cover?.complete && cover.naturalWidth > 0,
            ).length,
            artistFamilyPanelVisible: visible(artistFamilyPanel),
            galleryScrollTop: initialScrollTop,
            recentSearchPopoverVisible: visible(popover),
            runtimeViewRequestActive: (
              typeof state !== 'undefined'
              && Boolean(state?.busy)
              && String(state?.ui?.activeViewRequestUrl || '').startsWith('/view-data')
            ),
            searchAriaExpanded: String(
              document.querySelector(selectors.searchInputSelector)
                ?.getAttribute('aria-expanded')
              || '',
            ),
          };
        },
      };
    }, {
      albumCardSelector: this.albumCardSelector,
      albumCoverImageSelector: this.albumCoverImageSelector,
      artistFamilyPanelSelector: this.artistFamilyPanelSelector,
      artistFamilyToggleSelector: this.artistFamilyToggleSelector,
      artistFamilyListSelector: this.artistFamilyListSelector,
      artistFamilyChipSelector: this.artistFamilyChipSelector,
      artistGroupsSelector: this.artistGroupsSelector,
      galleryScrollSelector: this.galleryScrollSelector,
      libraryLoaderSelector: this.libraryLoaderSelector,
      libraryLoaderSpinnerSelector: this.libraryLoaderSpinnerSelector,
      recentSearchPopoverSelector: '#recent-search-popover',
      searchInputSelector: this.inputSelector,
    });
    let finished = false;
    return {
      read: async () => {
        await Promise.all([...familyVisibilityBoundaryChecks]);
        // parity-check: allow-read-only-measurement-evaluate -- snapshot the active search-clear mutation observer
        const domResult = await observationHandle.evaluate(
          (observation) => observation.read(),
        );
        familyControlsVisibleDuringActiveRequest ||= Boolean(
          domResult.artistFamilyPanelVisible
          && domResult.runtimeViewRequestActive
        );
        return {
          ...domResult,
          activeViewDataRequestCount: activeViewDataRequests.size,
          familyControlsVisibleDuringActiveRequest,
          familyViewDataRequests: [...familyViewDataRequests],
          viewDataRequests: [...viewDataRequests],
        };
      },
      finish: async () => {
        if (finished) return null;
        finished = true;
        this.page.off('request', recordRequest);
        this.page.off('requestfinished', finishRequest);
        this.page.off('requestfailed', finishRequest);
        await Promise.all([...familyVisibilityBoundaryChecks]);
        // parity-check: allow-read-only-measurement-evaluate -- disconnect and read the completed search-clear observer
        const domResult = await observationHandle.evaluate(
          (observation) => observation.finish(),
        );
        familyControlsVisibleDuringActiveRequest ||= Boolean(
          domResult.artistFamilyPanelVisible
          && domResult.runtimeViewRequestActive
        );
        await observationHandle.dispose();
        return {
          ...domResult,
          familyControlsVisibleDuringActiveRequest,
          familyViewDataRequests: [...familyViewDataRequests],
          viewDataRequests: [...viewDataRequests],
        };
      },
    };
  }

  async readCanonicalSearchState(options = {}) {
    const source = String(options.source || 'latest').trim().toLowerCase();
    const observation = this.productionViewObserver.read();
    const forceBootstrap = source === 'bootstrap';
    const bootstrapPayload = !forceBootstrap && observation.latestFullPayload
      ? null
      : await this.readProductionBootstrapPayload();
    const payload = (forceBootstrap ? null : observation.latestFullPayload)
      || bootstrapPayload?.startup_payload?.first_paint_view
      || bootstrapPayload?.initial_view
      || {};
    return {
      query: String(payload.query || '').trim(),
      selectedArtist: String(payload.selected_artist || '').trim(),
      searchContext: payload.search_context || null,
      sidebarArtists: (Array.isArray(payload.artists_sidebar) ? payload.artists_sidebar : [])
        .map((entry) => String(entry?.artist_display || entry?.artist || '').trim())
        .filter(Boolean),
    };
  }

  async waitForLocalSearchClearSettled(transitionObservation, options = {}) {
    if (!transitionObservation || typeof transitionObservation.read !== 'function') {
      throw new Error('Local search-clear settling requires an active transition observation.');
    }
    const timeout = Number(options.timeout || 10000);
    const expectedViewDataRequestCount = Number(
      options.expectedViewDataRequestCount || 0,
    );
    const deadline = Date.now() + timeout;
    let lastObservedState = null;
    while (Date.now() <= deadline) {
      const initialProductionObservation = this.productionViewObserver.read();
      const initialTransitionObservation = await transitionObservation.read();
      if (
        initialTransitionObservation.viewDataRequests.length
        > expectedViewDataRequestCount
      ) {
        throw new Error(
          'Search clear exceeded its expected /view-data request count: '
          + JSON.stringify(initialTransitionObservation.viewDataRequests),
        );
      }
      // parity-check: allow-read-only-measurement-evaluate -- verify the production runtime query settled without mutating state
      const initialRuntimeState = await this.page.evaluate(() => ({
        query: typeof state !== 'undefined'
          ? String(state?.view?.query || '').trim()
          : null,
        searchContextPresent: typeof state !== 'undefined'
          ? Boolean(state?.view?.search_context)
          : null,
        searchDraftQuery: typeof state !== 'undefined'
          ? String(state?.ui?.searchDraftQuery || '').trim()
          : null,
      }));
      const initialInputQuery = String(await this.input.inputValue() || '').trim();
      const initialUrl = new URL(this.page.url());
      const initialLoaderVisible = await this.page.locator(this.libraryLoaderSelector).isVisible();
      const initialSpinnerVisible = await this.page
        .locator(this.libraryLoaderSpinnerSelector)
        .isVisible();

      // parity-check: allow-read-only-measurement-evaluate -- two paints establish a stable local-only transition boundary
      await this.page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));

      const finalProductionObservation = this.productionViewObserver.read();
      const finalTransitionObservation = await transitionObservation.read();
      // parity-check: allow-read-only-measurement-evaluate -- re-read the production runtime query after the paint boundary
      const finalRuntimeState = await this.page.evaluate(() => ({
        query: typeof state !== 'undefined'
          ? String(state?.view?.query || '').trim()
          : null,
        searchContextPresent: typeof state !== 'undefined'
          ? Boolean(state?.view?.search_context)
          : null,
        searchDraftQuery: typeof state !== 'undefined'
          ? String(state?.ui?.searchDraftQuery || '').trim()
          : null,
        virtualGridEvents: Array.isArray(globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__?.events)
          ? globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.events.slice(-20)
          : [],
      }));
      const finalInputQuery = String(await this.input.inputValue() || '').trim();
      const finalUrl = new URL(this.page.url());
      const finalLoaderVisible = await this.page.locator(this.libraryLoaderSelector).isVisible();
      const finalSpinnerVisible = await this.page
        .locator(this.libraryLoaderSpinnerSelector)
        .isVisible();
      const productionObservationStable = (
        initialProductionObservation.stateRevision
        === finalProductionObservation.stateRevision
      );
      const runtimeStateStable = (
        initialRuntimeState.query === finalRuntimeState.query
        && initialRuntimeState.searchContextPresent === finalRuntimeState.searchContextPresent
        && initialRuntimeState.searchDraftQuery === finalRuntimeState.searchDraftQuery
      );
      const transitionStayedLocal = (
        finalTransitionObservation.viewDataRequests.length
          === expectedViewDataRequestCount
        && finalTransitionObservation.activeViewDataRequestCount === 0
        && !finalTransitionObservation.galleryReplaced
        && !finalTransitionObservation.cardNodesChanged
        && !finalTransitionObservation.cardContentChanged
        && !finalTransitionObservation.coverNodesChanged
        && !finalTransitionObservation.coverStateChanged
        && !finalTransitionObservation.galleryScrollChanged
        && !finalTransitionObservation.loaderActivated
        && !finalTransitionObservation.spinnerActivated
      );
      lastObservedState = {
        activeRequestCount: finalProductionObservation.activeRequestCount,
        activeViewDataRequestCount: finalTransitionObservation.activeViewDataRequestCount,
        cardContentChanged: finalTransitionObservation.cardContentChanged,
        cardNodesChanged: finalTransitionObservation.cardNodesChanged,
        coverNodesChanged: finalTransitionObservation.coverNodesChanged,
        coverStateChanged: finalTransitionObservation.coverStateChanged,
        familyControlsVisibleDuringActiveRequest:
          finalTransitionObservation.familyControlsVisibleDuringActiveRequest,
        galleryContentChanged: finalTransitionObservation.galleryContentChanged,
        galleryMutationCount: finalTransitionObservation.galleryMutationCount,
        galleryReplaced: finalTransitionObservation.galleryReplaced,
        galleryReplacementMutationCount:
          finalTransitionObservation.galleryReplacementMutationCount,
        galleryScrollChanged: finalTransitionObservation.galleryScrollChanged,
        initialActiveRequestCount: initialProductionObservation.activeRequestCount,
        initialInputQuery,
        initialLoaderVisible,
        initialLocationQuery: String(initialUrl.searchParams.get('q') || '').trim(),
        initialPendingPayloadReadCount: initialProductionObservation.pendingPayloadReadCount,
        initialRuntimeQuery: initialRuntimeState.query,
        initialRuntimeSearchContextPresent: initialRuntimeState.searchContextPresent,
        initialRuntimeSearchDraftQuery: initialRuntimeState.searchDraftQuery,
        initialSpinnerVisible,
        initialUrlHasQueryParameter: initialUrl.searchParams.has('q'),
        inputQuery: finalInputQuery,
        loaderActivated: finalTransitionObservation.loaderActivated,
        loaderVisible: finalLoaderVisible,
        locationQuery: String(finalUrl.searchParams.get('q') || '').trim(),
        pendingPayloadReadCount: finalProductionObservation.pendingPayloadReadCount,
        productionObservationStable,
        runtimeQuery: finalRuntimeState.query,
        runtimeSearchContextPresent: finalRuntimeState.searchContextPresent,
        runtimeSearchDraftQuery: finalRuntimeState.searchDraftQuery,
        runtimeStateStable,
        spinnerActivated: finalTransitionObservation.spinnerActivated,
        spinnerVisible: finalSpinnerVisible,
        urlHasQueryParameter: finalUrl.searchParams.has('q'),
        viewDataRequests: finalTransitionObservation.viewDataRequests,
        virtualGridEvents: finalRuntimeState.virtualGridEvents,
      };
      if (
        initialProductionObservation.activeRequestCount === 0
        && initialProductionObservation.pendingPayloadReadCount === 0
        && finalProductionObservation.activeRequestCount === 0
        && finalProductionObservation.pendingPayloadReadCount === 0
        && productionObservationStable
        && runtimeStateStable
        && transitionStayedLocal
        && initialInputQuery === ''
        && finalInputQuery === ''
        && !initialUrl.searchParams.has('q')
        && !finalUrl.searchParams.has('q')
        && initialRuntimeState.query === ''
        && initialRuntimeState.searchContextPresent === false
        && finalRuntimeState.query === ''
        && finalRuntimeState.searchContextPresent === false
        && initialRuntimeState.searchDraftQuery === ''
        && finalRuntimeState.searchDraftQuery === ''
        && !initialLoaderVisible
        && !initialSpinnerVisible
        && !finalLoaderVisible
        && !finalSpinnerVisible
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out after ${timeout} ms waiting for a local-only search clear. `
      + `Observed state: ${JSON.stringify(lastObservedState)}`,
    );
  }

  async waitForQuerySettled(expectedQuery, options = {}) {
    const expected = String(expectedQuery || '').trim();
    const timeout = Number(options.timeout || 30000);
    const deadline = Date.now() + timeout;
    let lastObservedState = null;
    while (Date.now() <= deadline) {
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
      // parity-check: allow-read-only-measurement-evaluate -- runtime view is canonical for local transitions that intentionally reuse a prior production payload
      const runtimeView = await this.page.evaluate(() => {
        if (typeof state === 'undefined') return null;
        const artists = [];
        const seenArtists = new Set();
        for (const field of ['artist_groups', 'primary_artist_groups', 'family_artist_groups']) {
          for (const group of Array.isArray(state?.view?.[field]) ? state.view[field] : []) {
            const artist = String(group?.artist || group?.artist_display || '').trim();
            if (!artist || seenArtists.has(artist)) continue;
            seenArtists.add(artist);
            artists.push(artist);
          }
        }
        return {
          query: String(state?.view?.query || '').trim(),
          surface: String(state?.view?.surface?.active || '').trim().toLowerCase(),
          artists,
          activeViewRequestId: Number(state?.ui?.activeViewRequestId || 0),
          activeViewRequestUrl: String(state?.ui?.activeViewRequestUrl || ''),
          busy: Boolean(state?.busy),
          viewStateRevision: Number(state?.ui?.viewStateRevision || 0),
        };
      });
      const inputQuery = await this.input.inputValue();
      const locationQuery = new URL(this.page.url()).searchParams.get('q') || '';
      const loader = this.page.locator(this.libraryLoaderSelector);
      const loaderVisible = await loader.isVisible();
      const spinnerVisible = loaderVisible
        && await this.page.locator(this.libraryLoaderSpinnerSelector).isVisible();
      const loaderTitle = loaderVisible
        ? String(await this.page.locator(this.libraryLoaderTitleSelector).textContent() || '').trim()
        : '';
      const loaderStatus = loaderVisible
        ? String(await this.page.locator(this.libraryLoaderStatusSelector).textContent() || '').trim()
        : '';
      const settledEmpty = loaderVisible
        && !spinnerVisible
        && loaderTitle === 'Nothing found'
        && loaderStatus === 'No artists, albums, or tracks matched your search.';
      const activeLoader = loaderVisible && !settledEmpty;
      const canonicalView = resolveCurrentCanonicalView(payload, runtimeView);
      const canonicalArtists = canonicalView.artists;
      const attachedArtists = (await this.page.locator(this.artistHeadingSelector).allTextContents())
        .map((artist) => String(artist || '').trim())
        .filter(Boolean);
      const canonicalSurface = canonicalView.surface;
      const canonicalSidebarArtists = (Array.isArray(payload?.artists_sidebar) ? payload.artists_sidebar : [])
        .map((artist) => String(artist?.artist_display || artist?.artist || '').trim())
        .filter(Boolean);
      const attachedSidebarArtists = (await this.page
        .locator(this.sidebarArtistNameSelector)
        .allTextContents())
        .map((artist) => String(artist || '').trim())
        .filter(Boolean);
      const startupHydrating = payload === null || Boolean(
        bootstrapPayload?.bootstrap?.startupHydration?.required,
      );
      const finalAttachedArtists = (await this.page
        .locator(this.artistHeadingSelector)
        .allTextContents())
        .map((artist) => String(artist || '').trim())
        .filter(Boolean);
      const finalAttachedSidebarArtists = (await this.page
        .locator(this.sidebarArtistNameSelector)
        .allTextContents())
        .map((artist) => String(artist || '').trim())
        .filter(Boolean);
      const finalObservation = this.productionViewObserver.read();
      if (finalObservation.latestFullPayloadError) {
        throw new Error(`Production view observation failed: ${finalObservation.latestFullPayloadError}`);
      }
      const observationChanged = finalObservation.stateRevision !== initialObservation.stateRevision;
      const domChanged = !hasStableDomEvidence(
        { attachedArtists, sidebarArtists: attachedSidebarArtists },
        {
          attachedArtists: finalAttachedArtists,
          sidebarArtists: finalAttachedSidebarArtists,
        },
      );
      const busy = initiallyBusy
        || finalObservation.activeRequestCount > 0
        || finalObservation.pendingPayloadReadCount > 0
        || observationChanged
        || domChanged;
      const canonicalApplied = canonicalSurface === 'home'
        ? hasAppliedCanonicalArtistSurface(
          canonicalSidebarArtists,
          finalAttachedSidebarArtists,
          { loaderVisible, payloadPresent: payload !== null, settledEmpty },
        )
        : hasAppliedCanonicalArtistSurface(
          canonicalArtists,
          finalAttachedArtists,
          { loaderVisible, payloadPresent: payload !== null, settledEmpty },
        );
      lastObservedState = {
        activeLoader,
        activeRuntimeRequestId: Number(runtimeView?.activeViewRequestId || 0),
        activeRuntimeRequestUrl: String(runtimeView?.activeViewRequestUrl || ''),
        activeRequestCount: busy ? Math.max(1, finalObservation.activeRequestCount) : 0,
        canonicalQuery: canonicalView.query,
        canonicalApplied,
        canonicalSurface,
        inputQuery: String(inputQuery || '').trim(),
        latestFullRequestUrl: finalObservation.latestFullRequestUrl,
        loaderStatus,
        loaderTitle,
        locationQuery: String(locationQuery || '').trim(),
        pendingPayloadReadCount: finalObservation.pendingPayloadReadCount,
        runtimeBusy: Boolean(runtimeView?.busy),
        runtimeViewStateRevision: Number(runtimeView?.viewStateRevision || 0),
        settledEmpty,
        startupHydrating,
      };
      if (
        lastObservedState.activeRequestCount === 0
        && lastObservedState.pendingPayloadReadCount === 0
        && lastObservedState.canonicalQuery === expected
        && lastObservedState.canonicalApplied
        && lastObservedState.inputQuery === expected
        && lastObservedState.locationQuery === expected
        && !lastObservedState.activeLoader
        && !lastObservedState.startupHydrating
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out after ${timeout} ms waiting for settled search query "${expected}". `
      + `Observed state: ${JSON.stringify(lastObservedState)}`,
    );
  }
}
