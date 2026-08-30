export class NavigationPanelActions {
  constructor(navigationPanel) {
    this.navigationPanel = navigationPanel;
  }

  parseVisibleCount(text) {
    const normalized = String(text || '').replace(/[^\d-]/g, '').trim();
    return Number.parseInt(normalized, 10) || 0;
  }

  async readAllArtistsCount() {
    return this.navigationPanel.allArtistsLink.count();
  }

  async waitForAllArtistsVisibility(visible, options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const allArtistsLink = document.querySelector(selectors.allArtistsSelector);
      return Boolean(allArtistsLink) === selectors.visible;
    }, {
      timeout: options.timeout || 30000,
    }, {
      allArtistsSelector: this.navigationPanel.allArtistsSelector,
      visible: Boolean(visible),
    });
  }

  async readAllArtistsVisibleCount() {
    const text = await this.navigationPanel.allArtistsCount.textContent();
    return this.parseVisibleCount(text);
  }

  async waitForAllArtistsVisibleCountGreaterThan(previousCount, options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const countNode = document.querySelector(selectors.allArtistsCountSelector);
      if (!(countNode instanceof HTMLElement)) return false;
      const nextCount = Number.parseInt(String(countNode.textContent || '').replace(/[^\d-]/g, '').trim(), 10) || 0;
      return nextCount > selectors.previousCount;
    }, {
      timeout: options.timeout || 30000,
    }, {
      allArtistsCountSelector: this.navigationPanel.allArtistsCountSelector,
      previousCount: Number(previousCount || 0),
    });
  }

  async waitForSidebarPreviewHydrated(options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const sidebarArtists = document.querySelectorAll(selectors.sidebarArtistSelector).length;
      if (!(sidebarArtists > 0)) return false;
      if (sidebarArtists <= selectors.maximumSidebarCount) {
        return true;
      }
      const countNode = document.querySelector(selectors.allArtistsCountSelector);
      if (!(countNode instanceof HTMLElement)) return false;
      const visibleCount = Number.parseInt(String(countNode.textContent || '').replace(/[^\d-]/g, '').trim(), 10) || 0;
      return visibleCount === sidebarArtists;
    }, {
      timeout: options.timeout || 60000,
    }, {
      sidebarArtistSelector: this.navigationPanel.sidebarArtistSelector,
      allArtistsCountSelector: this.navigationPanel.allArtistsCountSelector,
      maximumSidebarCount: Number(options.maximumSidebarCount || 40),
    });
  }

  async waitForSidebarFullyHydrated(options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const sidebarArtists = document.querySelectorAll(selectors.sidebarArtistSelector).length;
      return sidebarArtists > selectors.minimumSidebarCount;
    }, {
      timeout: options.timeout || 60000,
    }, {
      sidebarArtistSelector: this.navigationPanel.sidebarArtistSelector,
      minimumSidebarCount: Number(options.minimumSidebarCount || 100),
    });
  }

  async waitForSidebarAndAllArtistsCountSynchronized(options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const sidebarArtists = document.querySelectorAll(selectors.sidebarArtistSelector).length;
      if (!(sidebarArtists > selectors.minimumSidebarCount)) return false;
      const countNode = document.querySelector(selectors.allArtistsCountSelector);
      if (!(countNode instanceof HTMLElement)) return false;
      const visibleCount = Number.parseInt(String(countNode.textContent || '').replace(/[^\d-]/g, '').trim(), 10) || 0;
      return visibleCount === sidebarArtists;
    }, {
      timeout: options.timeout || 60000,
    }, {
      sidebarArtistSelector: this.navigationPanel.sidebarArtistSelector,
      allArtistsCountSelector: this.navigationPanel.allArtistsCountSelector,
      minimumSidebarCount: Number(options.minimumSidebarCount || 100),
    });
  }

  async waitForAllArtistsVisibleCount(expectedCount, options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const countNode = document.querySelector(selectors.allArtistsCountSelector);
      if (!(countNode instanceof HTMLElement)) return false;
      const visibleCount = Number.parseInt(String(countNode.textContent || '').replace(/[^\d-]/g, '').trim(), 10) || 0;
      return visibleCount === selectors.expectedCount;
    }, {
      timeout: options.timeout || 60000,
    }, {
      allArtistsCountSelector: this.navigationPanel.allArtistsCountSelector,
      expectedCount: Number(expectedCount || 0),
    });
  }

  async waitForAllArtistsVisibleCountMatchesInitialRefreshTotal(options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const targetCount = Number(window.__ALBUM_HAVEN_STARTUP_METRICS__?.marks?.initial_refresh_complete?.detail?.artistCount || 0);
      if (!(targetCount > 0)) return false;
      const countNode = document.querySelector(selectors.allArtistsCountSelector);
      if (!(countNode instanceof HTMLElement)) return false;
      const visibleCount = Number.parseInt(String(countNode.textContent || '').replace(/[^\d-]/g, '').trim(), 10) || 0;
      return visibleCount === targetCount;
    }, {
      timeout: options.timeout || 60000,
    }, {
      allArtistsCountSelector: this.navigationPanel.allArtistsCountSelector,
    });
  }

  async waitForAllArtistsVisibleCountMatchesRuntimeArtistCount(options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const targetCount = Number(globalThis.state?.view?.artist_count || 0);
      if (!(targetCount > 0)) return false;
      const countNode = document.querySelector(selectors.allArtistsCountSelector);
      if (!(countNode instanceof HTMLElement)) return false;
      const visibleCount = Number.parseInt(String(countNode.textContent || '').replace(/[^\d-]/g, '').trim(), 10) || 0;
      return visibleCount === targetCount;
    }, {
      timeout: options.timeout || 60000,
    }, {
      allArtistsCountSelector: this.navigationPanel.allArtistsCountSelector,
    });
  }

  async readSidebarArtistCount() {
    return this.navigationPanel.sidebarArtists.count();
  }

  async readSidebarArtistNames() {
    // parity-check: allow-read-only-measurement-evaluate -- one atomic snapshot avoids per-row browser round trips
    return this.navigationPanel.sidebarArtists.evaluateAll((elements) => (
      elements
        .map((element) => String(element.getAttribute('data-sidebar-artist') || '').trim())
        .filter(Boolean)
    ));
  }

  async readRuntimeSidebarArtistNames() {
    return this.navigationPanel.readRuntimeSidebarArtistNames();
  }

  async waitForRuntimeSidebarArtistNames(expectedNames, options = {}) {
    const expected = Array.isArray(expectedNames)
      ? expectedNames.map((name) => String(name || '').trim()).filter(Boolean)
      : [];
    await this.navigationPanel.waitForPageCondition((expectedArtists) => {
      const names = Array.isArray(state?.view?.artists_sidebar)
        ? state.view.artists_sidebar
          .map((item) => String(item?.artist_display || item?.artist || '').trim())
          .filter(Boolean)
        : [];
      return names.length === expectedArtists.length
        && names.every((name, index) => name === expectedArtists[index]);
    }, {
      timeout: options.timeout || 60000,
    }, expected);
  }

  async readSidebarAlphabeticalState() {
    const displayedNames = await this.readSidebarArtistNames();
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    return {
      displayedNames,
      alphabeticalNames: [...displayedNames].sort(collator.compare),
    };
  }

  async waitForSidebarArtistNames(expectedNames, options = {}) {
    const expected = Array.isArray(expectedNames)
      ? expectedNames.map((name) => String(name || '').trim()).filter(Boolean)
      : [];
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const names = Array.from(document.querySelectorAll(selectors.sidebarArtistSelector))
        .map((element) => String(element.getAttribute('data-sidebar-artist') || '').trim())
        .filter(Boolean);
      return names.length === selectors.expected.length
        && names.every((name, index) => name === selectors.expected[index]);
    }, {
      timeout: options.timeout || 60000,
    }, {
      sidebarArtistSelector: this.navigationPanel.sidebarArtistSelector,
      expected,
    });
  }

  async readActiveSidebarArtistName() {
    const activeLink = this.navigationPanel.activeSidebarLink;
    if (await activeLink.count() !== 1) return '';
    return String(await activeLink.getAttribute('data-sidebar-artist') || '').trim();
  }

  async readSidebarArtistNameCount(artistName) {
    return this.navigationPanel.sidebarArtistByName(artistName).count();
  }

  async readSidebarArtistAlbumCount(artistName) {
    const text = await this.navigationPanel.sidebarArtistCountByName(artistName).textContent();
    return this.parseVisibleCount(text);
  }

  async readSidebarArtistLabel(artistName) {
    const text = await this.navigationPanel.sidebarArtistLabelByName(artistName).textContent();
    return String(text || '').trim();
  }

  async readSidebarArtistLabelCount(artistName) {
    return this.navigationPanel.sidebarArtistLabelsByText(artistName).count();
  }

  async waitForSidebarSelection(expected, options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const activeLinks = Array.from(document.querySelectorAll(selectors.activeSidebarLinkSelector));
      return activeLinks.some((link) => (
        link instanceof HTMLElement
        && (
          String(link.getAttribute(selectors.sidebarArtistAttribute) || '').trim() === selectors.expectedArtist
          || (
            String(link.getAttribute(selectors.sidebarAllArtistsAttribute) || '').trim() === selectors.allArtistsActiveValue
            && String(link.textContent || '').trim().includes(selectors.expectedArtist)
          )
        )
      ));
    }, {
      timeout: options.timeout || 10000,
    }, {
      activeSidebarLinkSelector: this.navigationPanel.activeSidebarLinkSelector,
      allArtistsActiveValue: '1',
      sidebarAllArtistsAttribute: 'data-sidebar-all-artists',
      sidebarArtistAttribute: 'data-sidebar-artist',
      expectedArtist: String(expected || '').trim(),
    });
  }

  async selectSidebarArtistAt(index, options = {}) {
    const artistLocator = this.navigationPanel.sidebarArtists.nth(index);
    const artistName = await artistLocator.getAttribute('data-sidebar-artist');
    if (!artistName) {
      throw new Error(`Expected a visible artist row at index ${index + 1} under All artists.`);
    }
    await artistLocator.click({ noWaitAfter: true, ...options });
    return artistName;
  }

  async selectSidebarArtistByName(artistName, options = {}) {
    const selectedArtist = String(artistName || '').trim();
    const artistLocator = this.navigationPanel.sidebarArtistByName(selectedArtist);
    await artistLocator.click({ noWaitAfter: true, ...options });
  }

  async moveSidebarArtistOutsideViewport(artistName, options = {}) {
    const selectedArtist = String(artistName || '').trim();
    const targetArtist = this.navigationPanel.sidebarArtistByName(selectedArtist);
    if (await targetArtist.count() !== 1) {
      throw new Error(`Expected one sidebar row for "${selectedArtist}" before scrolling.`);
    }
    const firstArtist = this.navigationPanel.sidebarArtists.first();
    const lastArtist = this.navigationPanel.sidebarArtists.last();
    const artistCount = await this.navigationPanel.sidebarArtists.count();
    let targetIndex = -1;
    for (let index = 0; index < artistCount; index += 1) {
      const candidateName = String(
        await this.navigationPanel.sidebarArtists.nth(index).getAttribute('data-sidebar-artist')
        || '',
      ).trim();
      if (candidateName === selectedArtist) {
        targetIndex = index;
        break;
      }
    }
    if (targetIndex < 0) {
      throw new Error(`Could not locate sidebar row "${selectedArtist}" within the rendered artist list.`);
    }
    const boundaryArtist = targetIndex >= artistCount / 2
      ? firstArtist
      : lastArtist;
    await boundaryArtist.scrollIntoViewIfNeeded();
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const target = Array.from(
        document.querySelectorAll(selectors.sidebarArtistSelector),
      ).find((element) => (
        String(element.getAttribute('data-sidebar-artist') || '').trim()
        === selectors.selectedArtist
      ));
      const sidebar = document.querySelector(selectors.sidebarScrollContainerSelector);
      const globalPlayer = document.querySelector(selectors.globalPlayerSelector);
      if (
        !(target instanceof HTMLElement)
        || !(sidebar instanceof HTMLElement)
        || !(globalPlayer instanceof HTMLElement)
      ) return false;
      const targetRect = target.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const playerRect = globalPlayer.getBoundingClientRect();
      const visibleTop = sidebarRect.top + selectors.viewportPadding;
      const visibleBottom = Math.min(
        sidebarRect.bottom - selectors.viewportPadding,
        playerRect.top - selectors.viewportPadding,
      );
      return targetRect.bottom <= visibleTop || targetRect.top >= visibleBottom;
    }, {
      timeout: options.timeout || 10000,
    }, {
      globalPlayerSelector: this.navigationPanel.globalPlayerSelector,
      selectedArtist,
      sidebarArtistSelector: this.navigationPanel.sidebarArtistSelector,
      sidebarScrollContainerSelector: this.navigationPanel.sidebarScrollContainerSelector,
      viewportPadding: Number(options.viewportPadding ?? 8),
    });
  }

  async selectMountedFamilyArtistAndObserveTransition(artistName, options = {}) {
    const selectedArtist = String(artistName || '').trim();
    const observation = await this.navigationPanel.startMountedFamilySelectionObservation();
    try {
      await this.selectSidebarArtistByName(selectedArtist, options);
      await this.navigationPanel.waitForMountedFamilySelectionSettled(
        selectedArtist,
        options,
      );
      return await observation.finish();
    } catch (error) {
      const transition = await observation.finish();
      throw new Error(
        `${error.message} Last mounted-family transition: ${JSON.stringify(transition)}`,
        { cause: error },
      );
    }
  }

  async clickAllArtists(options = {}) {
    const {
      expectArtistQueryCleared = false,
      waitTimeout,
      timeout,
      force,
      ...clickOptions
    } = options;
    if (force !== undefined) {
      throw new Error('clickAllArtists does not accept forced clicks; the All Artists link must be interactable through the real UI.');
    }
    await this.navigationPanel.allArtistsLink.scrollIntoViewIfNeeded();
    await this.navigationPanel.allArtistsLink.click({
      noWaitAfter: true,
      ...clickOptions,
    });
    if (!expectArtistQueryCleared) {
      return;
    }
    await this.navigationPanel.waitForPageCondition(() => !window.location.search.includes('artist='), {
      timeout: waitTimeout || timeout || 10000,
    });
  }

  async waitForActiveSelectionInViewport(options = {}) {
    await this.navigationPanel.waitForPageCondition((selectors) => {
      const activeLink = document.querySelector(selectors.activeSidebarLinkSelector);
      const sidebar = document.querySelector(selectors.sidebarScrollContainerSelector);
      const globalPlayer = document.querySelector(selectors.globalPlayerSelector);
      if (
        !(activeLink instanceof HTMLElement)
        || !(sidebar instanceof HTMLElement)
        || !(globalPlayer instanceof HTMLElement)
      ) return false;
      const activeRect = activeLink.getBoundingClientRect();
      const sidebarRect = sidebar.getBoundingClientRect();
      const playerRect = globalPlayer.getBoundingClientRect();
      const visibleBottom = Math.min(
        sidebarRect.bottom - selectors.viewportPadding,
        playerRect.top - selectors.viewportPadding,
      );
      return activeRect.top >= sidebarRect.top + selectors.viewportPadding
        && activeRect.bottom <= visibleBottom;
    }, {
      timeout: options.timeout || 10000,
    }, {
      activeSidebarLinkSelector: this.navigationPanel.activeSidebarLinkSelector,
      sidebarScrollContainerSelector: this.navigationPanel.sidebarScrollContainerSelector,
      globalPlayerSelector: this.navigationPanel.globalPlayerSelector,
      viewportPadding: Number(options.viewportPadding ?? 8),
    });
  }
}
