import { BasePage } from './basePage.js';

export class ScanPage extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.loader = page.locator(this.loaderSelector);
    this.title = page.locator(this.titleSelector);
    this.status = page.locator(this.statusSelector);
    this.discoveryText = page.locator(
      `${this.titleSelector}, ${this.statusSelector}`,
    ).filter({ hasText: /discovering/i }).first();
    this.progressLines = page.locator(this.progressLineSelector);
    this.actions = page.locator(this.actionsSelector);
    this.cancelButton = page.getByRole('button', { name: /Cancel (?:Scan|Full Rescan)/ });
    this.browseButton = page.locator(this.browseButtonSelector);
    this.backButton = page.getByRole('button', { name: 'Back to previous library view' });
    this.searchInput = page.locator(this.searchInputSelector);
    this.activeSidebarSelection = page.locator(this.activeSidebarSelectionSelector);
    this.artistFamilyPanel = page.locator(this.artistFamilyPanelSelector);
    this.artistFamilyTitle = this.artistFamilyPanel.locator(this.artistFamilyTitleSelector);
    this.gallery = page.locator(this.gallerySelector);
    this.galleryHeadings = page.locator(this.galleryHeadingSelector);
    this.galleryCoverStates = page.locator(this.galleryCoverStateSelector);
    this.galleryScroll = page.locator(this.galleryScrollSelector);
  }

  get loaderSelector() {
    return '#library-loader';
  }

  get titleSelector() {
    return '#library-loader-title';
  }

  get statusSelector() {
    return '#library-loader-status';
  }

  get progressSelector() {
    return '#library-loader-progress';
  }

  get progressLineSelector() {
    return '#library-loader-progress .library-loader-progress-line';
  }

  get progressTitleSelector() {
    return '.library-loader-progress-title';
  }

  get progressDetailSelector() {
    return '.library-loader-progress-detail';
  }

  get browseButtonSelector() {
    return '#library-loader-browse-button';
  }

  get backButtonSelector() {
    return '[aria-label="Back to previous library view"]';
  }

  get actionsSelector() {
    return '#library-loader-actions';
  }

  get cancelButtonSelector() {
    return '#library-loader-cancel-button';
  }

  get searchInputSelector() {
    return '#search-input';
  }

  get activeSidebarSelectionSelector() {
    return '#sidebar-list .artist-link.active';
  }

  get artistFamilyPanelSelector() {
    return '#related-box';
  }

  get artistFamilyTitleSelector() {
    return '.related-title';
  }

  get gallerySelector() {
    return '#artist-groups';
  }

  get galleryHeadingSelector() {
    return '#artist-groups .artist-name';
  }

  get galleryCoverStateSelector() {
    return '#artist-groups .cover img, #artist-groups .cover-placeholder';
  }

  get galleryScrollSelector() {
    return '#albums-scroll';
  }

  get albumCardSelector() {
    return '#artist-groups .album-card';
  }

  get albumTitleSelector() {
    return '.album-title-button[data-open-tracklist="1"][data-album-key]';
  }

  get albumCoverImageSelector() {
    return '.cover img';
  }

  get albumCoverPlaceholderSelector() {
    return '.cover-placeholder';
  }

  async readActionPresentation() {
    const [cancelBounds, browseBounds, cancelStyle, browseStyle] = await Promise.all([
      this.cancelButton.boundingBox(),
      this.browseButton.boundingBox(),
      // parity-check: allow-read-only-measurement-evaluate -- verify the rendered destructive action treatment
      this.cancelButton.evaluate((button) => {
        const style = getComputedStyle(button);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
        };
      }),
      // parity-check: allow-read-only-measurement-evaluate -- compare the rendered neutral browse treatment
      this.browseButton.evaluate((button) => {
        const style = getComputedStyle(button);
        return {
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
        };
      }),
    ]);
    return {
      browseBounds,
      browseStyle,
      cancelBounds,
      cancelStyle,
    };
  }

  async startBrowseContinuityObservation() {
    // parity-check: allow-read-only-measurement-evaluate -- observe loader/gallery continuity without changing app state
    const observationHandle = await this.page.evaluateHandle((selectors) => {
      const result = {
        browseButtonVisibleDuringNormalLoading: false,
        galleryHiddenWithoutNormalLoading: false,
        loaderStates: [],
        scanPageActivated: false,
      };
      const seenLoaderStates = new Set();
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
      const inspect = () => {
        const loader = document.querySelector(selectors.loaderSelector);
        const gallery = document.querySelector(selectors.gallerySelector);
        const loaderVisible = visible(loader);
        const title = String(
          document.querySelector(selectors.titleSelector)?.textContent || '',
        ).trim();
        const status = String(
          document.querySelector(selectors.statusSelector)?.textContent || '',
        ).trim();
        const normalLoading = loaderVisible && title === 'Loading selection';
        if (
          normalLoading
          && visible(document.querySelector(selectors.browseButtonSelector))
        ) {
          result.browseButtonVisibleDuringNormalLoading = true;
        }
        if (!visible(gallery) && !normalLoading) {
          result.galleryHiddenWithoutNormalLoading = true;
        }
        if (!loaderVisible) return;
        const loaderKey = `${title}\n${status}`;
        if (!seenLoaderStates.has(loaderKey)) {
          seenLoaderStates.add(loaderKey);
          result.loaderStates.push({ title, status });
        }
        const scanCopy = `${title} ${status}`.toLowerCase();
        if (
          /discovering|scanning music files|updating cover|building artist families|refreshing artist relations/.test(scanCopy)
          || visible(document.querySelector(selectors.backButtonSelector))
        ) {
          result.scanPageActivated = true;
        }
      };
      inspect();
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      return {
        finish() {
          inspect();
          observer.disconnect();
          return result;
        },
      };
    }, {
      backButtonSelector: '[aria-label="Back to previous library view"]',
      browseButtonSelector: this.browseButtonSelector,
      gallerySelector: this.gallerySelector,
      loaderSelector: this.loaderSelector,
      statusSelector: this.statusSelector,
      titleSelector: this.titleSelector,
    });
    let finished = false;
    return {
      finish: async () => {
        if (finished) return null;
        finished = true;
        // parity-check: allow-read-only-measurement-evaluate -- finish and read the browse-continuity observer
        const result = await observationHandle.evaluate((observation) => observation.finish());
        await observationHandle.dispose();
        return result;
      },
    };
  }

  async waitForSearchReadiness(expected, options = {}) {
    const expectedState = {
      expectedAlbumCount: Number(expected.expectedAlbumCount),
      expectedQuery: String(expected.expectedQuery || '').trim(),
      expectedSelectedArtistName: String(expected.expectedSelectedArtistName || '').trim(),
      expectedSidebarArtistNames: [...expected.expectedSidebarArtistNames]
        .map((name) => String(name || '').trim()),
    };
    const selectors = {
      albumCardSelector: this.albumCardSelector,
      albumCoverImageSelector: this.albumCoverImageSelector,
      albumCoverPlaceholderSelector: this.albumCoverPlaceholderSelector,
      albumTitleSelector: this.albumTitleSelector,
      allArtistsCountSelector: '#sidebar-list [data-sidebar-all-artists="1"] .artist-count',
      galleryHeadingSelector: this.galleryHeadingSelector,
      loaderSelector: this.loaderSelector,
      searchInputSelector: this.searchInputSelector,
      selectedArtistSelector: `${this.activeSidebarSelectionSelector}[data-sidebar-artist]`,
      sidebarArtistSelector: '#sidebar-list [data-sidebar-artist]',
    };
    const readinessHandle = await this.page.waitForFunction(
      ({ expectedState: expectedValues, selectors: pageSelectors }) => {
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
        const query = String(
          document.querySelector(pageSelectors.searchInputSelector)?.value || '',
        ).trim();
        const locationUrl = new URL(window.location.href);
        const locationQuery = String(locationUrl.searchParams.get('q') || '').trim();
        const loaderVisible = visible(document.querySelector(pageSelectors.loaderSelector));
        const sidebarArtistNames = Array.from(
          document.querySelectorAll(pageSelectors.sidebarArtistSelector),
        ).map((link) => String(link.getAttribute('data-sidebar-artist') || '').trim());
        const allArtistsCountText = String(
          document.querySelector(pageSelectors.allArtistsCountSelector)?.textContent || '',
        ).trim();
        const allArtistsVisibleCountMatch = allArtistsCountText.match(/\d+/u);
        const allArtistsVisibleCount = allArtistsVisibleCountMatch
          ? Number(allArtistsVisibleCountMatch[0])
          : null;
        const selectedArtistLink = document.querySelector(
          pageSelectors.selectedArtistSelector,
        );
        const selectedArtistName = String(
          selectedArtistLink?.getAttribute('data-sidebar-artist') || '',
        ).trim();
        const selectedArtistHref = String(selectedArtistLink?.getAttribute('href') || '').trim();
        let selectedArtistHrefMatches = false;
        if (selectedArtistHref) {
          const selectedArtistUrl = new URL(selectedArtistHref, window.location.href);
          selectedArtistHrefMatches = String(
            selectedArtistUrl.searchParams.get('artist') || '',
          ).trim() === expectedValues.expectedSelectedArtistName
            && String(selectedArtistUrl.searchParams.get('q') || '').trim()
              === expectedValues.expectedQuery;
        }
        const galleryHeadings = Array.from(
          document.querySelectorAll(pageSelectors.galleryHeadingSelector),
        ).filter(visible).map((heading) => String(heading.textContent || '').trim());
        const albumCards = Array.from(
          document.querySelectorAll(pageSelectors.albumCardSelector),
        ).map((card) => {
          const titleButton = card.querySelector(pageSelectors.albumTitleSelector);
          const image = card.querySelector(pageSelectors.albumCoverImageSelector);
          const placeholder = card.querySelector(
            pageSelectors.albumCoverPlaceholderSelector,
          );
          const cardVisible = visible(card);
          const imageVisible = visible(image);
          const placeholderVisible = visible(placeholder);
          const approvedPlaceholder = placeholderVisible
            && !placeholder.classList.contains('cover-placeholder-deferred');
          const coverSettled = !cardVisible || Boolean(
            (imageVisible
              && image instanceof HTMLImageElement
              && image.complete
              && image.naturalWidth > 0)
            || approvedPlaceholder
          );
          return {
            albumKey: String(titleButton?.getAttribute('data-album-key') || '').trim(),
            coverSettled,
            title: String(titleButton?.textContent || '').trim(),
            visible: cardVisible,
          };
        });
        const snapshot = {
          albumCards,
          allArtistsVisibleCount,
          galleryHeadings,
          loaderVisible,
          query,
          selectedArtistHref,
          selectedArtistName,
          sidebarArtistNames,
          url: locationUrl.href,
        };
        const sidebarMatches = sidebarArtistNames.length
            === expectedValues.expectedSidebarArtistNames.length
          && sidebarArtistNames.every(
            (name, index) => name === expectedValues.expectedSidebarArtistNames[index],
          );
        const ready = query === expectedValues.expectedQuery
          && locationQuery === expectedValues.expectedQuery
          && !loaderVisible
          && sidebarMatches
          && allArtistsVisibleCount === expectedValues.expectedSidebarArtistNames.length
          && selectedArtistName === expectedValues.expectedSelectedArtistName
          && selectedArtistHrefMatches
          && galleryHeadings.length === 1
          && galleryHeadings[0] === expectedValues.expectedSelectedArtistName
          && albumCards.length === expectedValues.expectedAlbumCount
          && albumCards.every((card) => card.albumKey && card.title && card.coverSettled);
        return ready ? { completedAtMs: performance.now(), snapshot } : false;
      },
      { expectedState, selectors },
      { timeout: options.timeout || 60000 },
    );
    try {
      return await readinessHandle.jsonValue();
    } finally {
      await readinessHandle.dispose();
    }
  }

  async startGalleryExitObservation(options = {}) {
    // parity-check: allow-read-only-measurement-evaluate -- observe the Scan Page exit until a stable, usable top-of-gallery window is rendered
    const observationHandle = await this.page.evaluateHandle((selectors) => {
      const startedAt = performance.now();
      const initialRenderGeneration = Number(
        globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__?.latestRender?.renderGeneration || 0,
      );
      const initialCoverGeneration = Number(
        globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.generation || 0,
      );
      const result = {
        firstReadyAt: null,
        invalidSamples: [],
        sampleCount: 0,
        timeline: [],
      };
      let latestSample = null;
      let observedGalleryHidden = false;
      let candidateReadySignature = null;
      let candidateReadySampleCount = 0;
      const resetCandidateReadiness = () => {
        candidateReadySignature = null;
        candidateReadySampleCount = 0;
      };
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
      const readSample = (sampleSource) => {
        const loader = document.querySelector(selectors.loaderSelector);
        const gallery = document.querySelector(selectors.gallerySelector);
        const scroll = document.querySelector(selectors.galleryScrollSelector);
        const galleryVisible = visible(gallery);
        if (!galleryVisible) {
          observedGalleryHidden = true;
        }
        const loaderVisible = visible(loader);
        const scrollBounds = scroll instanceof HTMLElement
          ? scroll.getBoundingClientRect()
          : null;
        const visibleCards = Array.from(
          document.querySelectorAll(selectors.albumCardSelector),
        ).filter((card) => {
          if (!visible(card) || !scrollBounds) return false;
          const bounds = card.getBoundingClientRect();
          return bounds.bottom > scrollBounds.top && bounds.top < scrollBounds.bottom;
        });
        const headings = Array.from(
          document.querySelectorAll(selectors.galleryHeadingSelector),
        ).filter(visible).map((heading) => String(heading.textContent || '').trim());
        const cards = visibleCards.map((card) => {
          const titleButton = card.querySelector(selectors.albumTitleSelector);
          const image = card.querySelector(selectors.albumCoverImageSelector);
          const placeholder = card.querySelector(selectors.albumCoverPlaceholderSelector);
          const imageReady = image instanceof HTMLImageElement
            && image.complete
            && image.naturalWidth > 0;
          let productionCoverReady = false;
          if (imageReady) {
            const productionSource = String(
              image.getAttribute('data-production-cover-src') || '',
            ).trim();
            if (productionSource) {
              const productionUrl = new URL(productionSource, window.location.href);
              productionCoverReady = productionUrl.origin === window.location.origin
                && productionUrl.pathname === '/cover';
            }
          }
          const approvedPlaceholder = visible(placeholder)
            && !placeholder.classList.contains('cover-placeholder-deferred');
          return {
            albumKey: String(titleButton?.getAttribute('data-album-key') || '').trim(),
            coverSettled: selectors.requireRealCovers
              ? productionCoverReady
              : Boolean(imageReady || approvedPlaceholder),
            productionCoverReady,
            image: image instanceof HTMLImageElement ? {
              complete: image.complete,
              currentSrc: String(image.currentSrc || ''),
              galleryCoverLoading: image.getAttribute('data-gallery-cover-loading'),
              galleryCoverSrc: image.getAttribute('data-gallery-cover-src'),
              naturalHeight: image.naturalHeight,
              naturalWidth: image.naturalWidth,
              productionCoverSrc: image.getAttribute('data-production-cover-src'),
              src: image.getAttribute('src'),
            } : null,
            title: String(titleButton?.textContent || '').trim(),
          };
        });
        const sample = {
          cards,
          coverGeneration: Number(
            globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.generation || 0,
          ),
          foregroundIdle: Boolean(
            globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.foregroundIdle,
          ),
          scheduler: {
            active: Number(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.active || 0),
            activeBackground: Number(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.activeBackground || 0),
            activeForeground: Number(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.activeForeground || 0),
            queuedBackground: Number(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.queuedBackground || 0),
            queuedForeground: Number(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.queuedForeground || 0),
            queuedNear: Number(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.queuedNear || 0),
            queuedVisible: Number(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.queuedVisible || 0),
            suspended: Boolean(globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__?.suspended),
          },
          galleryVisible,
          headings,
          loaderTitle: String(
            document.querySelector(selectors.titleSelector)?.textContent || '',
          ).trim(),
          loaderVisible,
          renderGeneration: Number(
            globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__?.latestRender?.renderGeneration || 0,
          ),
          scrollTop: scroll instanceof HTMLElement ? Number(scroll.scrollTop || 0) : null,
        };
        latestSample = sample;
        const timelineSignature = JSON.stringify(sample);
        if (result.timeline.at(-1)?.signature !== timelineSignature) {
          result.timeline.push({
            elapsedMs: Math.round(performance.now() - startedAt),
            sample,
            sampleSource,
            signature: timelineSignature,
          });
          if (result.timeline.length > 200) result.timeline.shift();
        }
        const ready = !loaderVisible
          && galleryVisible
          && headings.length > 0
          && cards.length > 0
          && cards.every((card) => card.albumKey && card.title && card.coverSettled)
          && sample.scrollTop === 0
          && (
            (observedGalleryHidden && galleryVisible)
            || (
              sample.renderGeneration > initialRenderGeneration
              && sample.coverGeneration > initialCoverGeneration
            )
          );
        if (result.firstReadyAt === null) {
          if (!ready) {
            resetCandidateReadiness();
          } else {
            const readySignature = JSON.stringify({
              cardKeys: cards.map((card) => card.albumKey),
              headings,
              scrollTop: sample.scrollTop,
              coverGeneration: sample.coverGeneration,
              renderGeneration: sample.renderGeneration,
            });
            if (candidateReadySignature === readySignature) {
              if (sampleSource === 'animation-frame') {
                candidateReadySampleCount += 1;
              }
            } else {
              resetCandidateReadiness();
              candidateReadySignature = readySignature;
              if (sampleSource === 'animation-frame') {
                candidateReadySampleCount = 1;
              }
            }
            if (candidateReadySampleCount >= 2) {
              result.firstReadyAt = performance.now();
            }
          }
        } else if (!ready) {
          result.invalidSamples.push(sample);
        }
        result.sampleCount += 1;
        return sample;
      };
      readSample('initial');
      const observer = new MutationObserver(() => readSample('mutation'));
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      const intervalId = setInterval(() => readSample('interval'), 50);
      let animationFrameId = requestAnimationFrame(readAnimationFrameSample);
      function readAnimationFrameSample() {
        readSample('animation-frame');
        animationFrameId = requestAnimationFrame(readAnimationFrameSample);
      }
      return {
        async finish(settleMs) {
          await new Promise((resolve) => setTimeout(resolve, settleMs));
          observer.disconnect();
          clearInterval(intervalId);
          cancelAnimationFrame(animationFrameId);
          return {
            finalSample: latestSample,
            firstReadyMs: result.firstReadyAt === null
              ? null
              : Math.round(result.firstReadyAt - startedAt),
            invalidSamples: [...result.invalidSamples],
            requireRealCovers: selectors.requireRealCovers,
            sampleCount: result.sampleCount,
            timeline: result.timeline.map(({ signature, ...entry }) => entry),
          };
        },
      };
    }, {
      albumCardSelector: this.albumCardSelector,
      albumCoverImageSelector: this.albumCoverImageSelector,
      albumCoverPlaceholderSelector: this.albumCoverPlaceholderSelector,
      albumTitleSelector: this.albumTitleSelector,
      galleryHeadingSelector: this.galleryHeadingSelector,
      galleryScrollSelector: this.galleryScrollSelector,
      gallerySelector: this.gallerySelector,
      loaderSelector: this.loaderSelector,
      requireRealCovers: options.requireRealCovers === true,
      titleSelector: this.titleSelector,
    });
    let finished = false;
    return {
      finish: async (settleMs = 500) => {
        if (finished) return null;
        finished = true;
        // parity-check: allow-read-only-measurement-evaluate -- finish the bounded post-navigation gallery observation
        const result = await observationHandle.evaluate(
          (observation, durationMs) => observation.finish(durationMs),
          Math.max(0, Number(settleMs || 0)),
        );
        await observationHandle.dispose();
        return result;
      },
    };
  }

  async startPhaseObservation() {
    // parity-check: allow-read-only-measurement-evaluate -- observe visible Scan Page phase titles without changing app state
    const observationHandle = await this.page.evaluateHandle((selectors) => {
      const titles = [];
      const relationActionSamples = [];
      const appendTitle = (title) => {
        if (title && !titles.includes(title)) titles.push(title);
      };
      const inspect = () => {
        const loader = document.querySelector(selectors.loaderSelector);
        if (!(loader instanceof HTMLElement) || loader.hidden) return;
        const style = getComputedStyle(loader);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        appendTitle(String(
          document.querySelector(selectors.titleSelector)?.textContent || '',
        ).trim());
        for (const progressTitle of document.querySelectorAll(selectors.progressTitleSelector)) {
          appendTitle(String(progressTitle.textContent || '').trim());
        }
        const visible = (element) => {
          if (!(element instanceof HTMLElement) || element.hidden) return false;
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && bounds.width > 0
            && bounds.height > 0;
        };
        const loaderCopy = [
          String(document.querySelector(selectors.titleSelector)?.textContent || '').trim(),
          ...Array.from(document.querySelectorAll(selectors.progressTitleSelector))
            .map((title) => String(title.textContent || '').trim()),
        ].join(' ');
        if (/artist famil|artist relation|relationship/i.test(loaderCopy)) {
          relationActionSamples.push({
            browseVisible: visible(document.querySelector(selectors.browseButtonSelector)),
            cancelVisible: visible(document.querySelector(selectors.cancelButtonSelector)),
            loaderCopy,
          });
        }
      };
      inspect();
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      return {
        finish() {
          inspect();
          observer.disconnect();
          return { relationActionSamples, titles };
        },
      };
    }, {
      loaderSelector: this.loaderSelector,
      browseButtonSelector: this.browseButtonSelector,
      cancelButtonSelector: this.cancelButtonSelector,
      progressTitleSelector: `${this.progressLineSelector} ${this.progressTitleSelector}`,
      titleSelector: this.titleSelector,
    });
    let finished = false;
    return {
      finish: async () => {
        if (finished) return null;
        finished = true;
        // parity-check: allow-read-only-measurement-evaluate -- finish and read the Scan Page phase observer
        const result = await observationHandle.evaluate((observation) => observation.finish());
        await observationHandle.dispose();
        return result;
      },
    };
  }
}
