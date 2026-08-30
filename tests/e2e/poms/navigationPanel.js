import { BasePage } from './basePage.js';

export function classifyMountedFamilyGalleryContinuity(observation = {}) {
  const initialChildCount = Number(observation.initialChildCount || 0);
  const finalChildCount = Number(observation.finalChildCount || 0);
  return {
    galleryChildrenReplaced: Boolean(
      initialChildCount !== finalChildCount
      || !observation.finalUsesOnlyInitialChildren
    ),
    galleryCleared: Boolean(
      observation.removedAllInitialChildren
      || finalChildCount === 0
    ),
  };
}

export class NavigationPanel extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.sidebarArtists = page.locator(this.sidebarArtistSelector);
    this.allArtistsLink = page.locator(this.allArtistsSelector);
    this.allArtistsCount = page.locator(this.allArtistsCountSelector);
    this.activeSidebarLink = page.locator(this.activeSidebarLinkSelector);
    this.activeAllArtistsLink = page.locator(this.activeAllArtistsSelector);
  }

  get sidebarArtistSelector() {
    return '#sidebar-list [data-sidebar-artist]';
  }

  get allArtistsSelector() {
    return '#sidebar-list [data-sidebar-all-artists="1"]';
  }

  get allArtistsCountSelector() {
    return '#sidebar-list [data-sidebar-all-artists="1"] .artist-count';
  }

  get activeSidebarLinkSelector() {
    return '#sidebar-list .artist-link.active';
  }

  get activeAllArtistsSelector() {
    return '.artist-link.active[data-sidebar-all-artists="1"]';
  }

  get sidebarScrollContainerSelector() {
    return '.sidebar';
  }

  get globalPlayerSelector() {
    return '.global-player';
  }

  get activeAllArtistsCountSelector() {
    return '.artist-link.active[data-sidebar-all-artists="1"] .artist-count';
  }

  get artistHeadingSelector() {
    return '#artist-groups .artist-name';
  }

  get libraryLoaderSelector() {
    return '#library-loader';
  }

  get libraryLoaderSpinnerSelector() {
    return '#library-loader .library-loader-spinner';
  }

  sidebarArtistByName(artistName) {
    const selectedArtist = String(artistName || '').trim();
    return this.page.locator(
      `${this.sidebarArtistSelector}[data-sidebar-artist=${JSON.stringify(selectedArtist)}]`,
    ).first();
  }

  sidebarArtistCountByName(artistName) {
    return this.sidebarArtistByName(artistName).locator('.artist-count');
  }

  sidebarArtistLabelByName(artistName) {
    return this.sidebarArtistByName(artistName).locator('.artist-name-label');
  }

  sidebarArtistLabelsByText(artistName) {
    return this.page.locator(
      `${this.sidebarArtistSelector} .artist-name-label`,
    ).filter({ hasText: new RegExp(`^\\s*${String(artistName || '').trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\s+/g, '\\s+')}\\s*$`, 'u') });
  }

  async startMountedFamilySelectionObservation() {
    const viewDataRequests = [];
    const recordRequest = (request) => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/view-data') {
        viewDataRequests.push(request.url());
      }
    };
    this.page.on('request', recordRequest);
    let observationHandle;
    try {
      // parity-check: allow-read-only-measurement-evaluate -- observe local family navigation without changing app state
      observationHandle = await this.page.evaluateHandle((selectors) => {
        const initialGallery = document.querySelector(selectors.artistGroupsSelector);
        if (!(initialGallery instanceof HTMLElement) || !initialGallery.children.length) {
          throw new Error('Mounted-family observation requires a populated artist gallery.');
        }
        const initialChildren = Array.from(initialGallery.children);
        const initialChildSet = new Set(initialChildren);
        const presentInitialChildren = new Set(initialChildren);
        let removedAllInitialChildren = false;
        const visible = (element) => {
          if (!(element instanceof HTMLElement) || element.hidden) return false;
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || 1) > 0
            && bounds.width > 0
            && bounds.height > 0;
        };
        const result = {
          galleryReplaced: false,
          loadingScreenActivated: false,
          loaderSpinnerActivated: false,
        };
        const inspect = (mutationRecords = []) => {
          mutationRecords.forEach((record) => {
            if (record.type !== 'childList' || record.target !== initialGallery) return;
            Array.from(record.removedNodes).forEach((node) => {
              if (initialChildSet.has(node)) {
                presentInitialChildren.delete(node);
              }
            });
            if (presentInitialChildren.size === 0) {
              removedAllInitialChildren = true;
            }
            Array.from(record.addedNodes).forEach((node) => {
              if (initialChildSet.has(node)) {
                presentInitialChildren.add(node);
              }
            });
          });
          const gallery = document.querySelector(selectors.artistGroupsSelector);
          result.galleryReplaced ||= gallery !== initialGallery;
          result.loadingScreenActivated ||= visible(
            document.querySelector(selectors.libraryLoaderSelector),
          );
          result.loaderSpinnerActivated ||= visible(
            document.querySelector(selectors.libraryLoaderSpinnerSelector),
          );
        };
        inspect();
        const observer = new MutationObserver((records) => inspect(records));
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        return {
          finish() {
            inspect(observer.takeRecords());
            observer.disconnect();
            const finalGallery = document.querySelector(selectors.artistGroupsSelector);
            const finalChildren = finalGallery instanceof HTMLElement
              ? Array.from(finalGallery.children)
              : [];
            return {
              ...result,
              finalChildCount: finalChildren.length,
              finalUsesOnlyInitialChildren: finalChildren.every(
                (child) => initialChildSet.has(child),
              ),
              initialChildCount: initialChildren.length,
              removedAllInitialChildren,
              visibleGroupNames: Array.from(
                document.querySelectorAll(selectors.artistHeadingSelector),
              ).map((heading) => String(heading.textContent || '').trim()).filter(Boolean),
            };
          },
        };
      }, {
        artistGroupsSelector: '#artist-groups',
        artistHeadingSelector: this.artistHeadingSelector,
        libraryLoaderSelector: this.libraryLoaderSelector,
        libraryLoaderSpinnerSelector: this.libraryLoaderSpinnerSelector,
      });
    } catch (error) {
      this.page.off('request', recordRequest);
      throw error;
    }
    let finished = false;
    return {
      finish: async () => {
        if (finished) return null;
        finished = true;
        this.page.off('request', recordRequest);
        // parity-check: allow-read-only-measurement-evaluate -- finish the mounted-family DOM observer
        const domResult = await observationHandle.evaluate((observation) => observation.finish());
        await observationHandle.dispose();
        const galleryContinuity = classifyMountedFamilyGalleryContinuity(domResult);
        // parity-check: allow-read-only-measurement-evaluate -- read the settled local family-navigation state
        const runtimeResult = await this.page.evaluate(() => {
          const runtimeState = typeof state !== 'undefined' ? state : null;
          const view = runtimeState?.view || {};
          const groupName = (group) => String(group?.artist || group?.artist_display || '').trim();
          return {
            activeViewRequestUrl: String(runtimeState?.ui?.activeViewRequestUrl || ''),
            familyGroupNames: (Array.isArray(view.family_artist_groups)
              ? view.family_artist_groups
              : []).map(groupName).filter(Boolean),
            pendingSelectedArtistReconcile: Boolean(
              runtimeState?.ui?.pendingSelectedArtistReconcileTimer,
            ),
            pendingViewTransition: Boolean(runtimeState?.ui?.pendingViewTransition),
            primaryGroupNames: (Array.isArray(view.primary_artist_groups)
              ? view.primary_artist_groups
              : []).map(groupName).filter(Boolean),
            query: String(view.query || '').trim(),
            selectedArtist: String(view.selected_artist || '').trim(),
          };
        });
        const location = new URL(this.page.url());
        return {
          ...domResult,
          ...galleryContinuity,
          ...runtimeResult,
          locationArtist: String(location.searchParams.get('artist') || '').trim(),
          locationHasQuery: location.searchParams.has('q'),
          viewDataRequests: [...viewDataRequests],
        };
      },
    };
  }

  async waitForMountedFamilySelectionSettled(expectedArtist, options = {}) {
    await this.waitForPageCondition((expected) => {
      const runtimeState = typeof state !== 'undefined' ? state : null;
      const view = runtimeState?.view || {};
      const location = new URL(window.location.href);
      const primaryGroups = Array.isArray(view.primary_artist_groups)
        ? view.primary_artist_groups
        : [];
      const primaryName = String(
        primaryGroups[0]?.artist || primaryGroups[0]?.artist_display || '',
      ).trim();
      return String(view.selected_artist || '').trim() === expected
        && String(view.query || '').trim() === ''
        && primaryGroups.length === 1
        && primaryName === expected
        && String(location.searchParams.get('artist') || '').trim() === expected
        && !location.searchParams.has('q')
        && !runtimeState?.ui?.pendingSelectedArtistReconcileTimer
        && !runtimeState?.ui?.activeViewRequestUrl
        && !runtimeState?.ui?.pendingViewTransition;
    }, {
      timeout: options.timeout || 30000,
    }, String(expectedArtist || '').trim());
  }

  async readRuntimeSidebarArtistNames() {
    // parity-check: allow-read-only-measurement-evaluate -- runtime view is the canonical full tree behind the virtualized sidebar window
    return this.page.evaluate(() => (
      Array.isArray(state?.view?.artists_sidebar)
        ? state.view.artists_sidebar
          .map((item) => String(item?.artist_display || item?.artist || '').trim())
          .filter(Boolean)
        : []
    ));
  }
}
