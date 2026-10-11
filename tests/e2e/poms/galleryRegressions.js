export class GalleryRegressions {
  constructor(page) {
    this.page=page;
    this.artistHeadingSelector='#artist-groups .family-artist-header[data-scroll-artist]';
    this.familyToggle=page.locator('[data-gallery-bar-action="artist-family"]');
    this.familyPanel=page.locator('#artist-family-panel');
    this.nealSidebar=page.locator('[data-sidebar-artist="Neal Morse"]');
    this.rootSidebar=page.locator('[data-sidebar-all-artists="1"]');
    this.rootArtistCount=this.rootSidebar.locator('.navigation-tree-count');
    this.search=page.getByRole('combobox',{name:'Search music'});
    this.options=page.locator('.recent-search-option');
    this.summary=page.locator('[data-gallery-context-summary]');
    this.galleryContextName=page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]');
    this.numberHeader=page.locator('#track-modal [role=columnheader][data-cdt-column=number]').first();
    this.yearCard=page.locator('.album-card[data-gallery-release-year]').first();
    this.year=this.yearCard.locator('.gallery-card__hover-year');
    this.infoSummary=page.locator('[data-artist-info-overlay] [data-artist-info-summary]');
    this.cards=page.locator('.album-card');
    this.loader=page.locator('#library-loader');
    this.galleryScroll=page.locator('#albums-scroll');
    this.sidebarList=page.locator('#sidebar-list');
    this.sidebarArtistSelector='#sidebar-list [data-sidebar-artist]';
    this.sidebarArtists=page.locator(this.sidebarArtistSelector);
    this.artistTreeContextMenu=page.locator('#artist-tree-context-menu');
    this.scrollToArtistAction=page.locator('[data-artist-tree-action="scroll-to-artist"]');
    this.view=page.locator('[data-gallery-view-cluster]');
    this.noInfo=page.getByRole('button',{name:'No info',exact:true});
    this.cardsView=page.getByRole('button',{name:'Cards',exact:true});
    this.info=page.locator('[data-artist-info-trigger]').first();
    this.infoPanel=page.locator('[data-artist-info-overlay]');
    this.modal=page.locator('#track-modal');
    this.dialog=this.modal.locator('.track-modal-dialog');
    this.header=this.modal.locator('.track-modal-header');
    this.activeReleaseTab=this.modal.locator('[data-track-tab-index][aria-selected="true"]');
    this.art=this.modal.locator('.track-modal-cover .album-artbox');
    this.tracks=this.modal.locator('.track-modal-list');
    this.rows=this.modal.locator('.album-track-table__row');
    this.warning=page.locator('#toast-layer .system-warning-notification').filter({hasText:'Library watcher needs attention'});
    this.warningDismiss=this.warning.getByRole('button',{name:'Dismiss',exact:true});
    this.warningGoLibrary=this.warning.getByRole('button',{name:'Go to Library page',exact:true});
    this.removedWarningButton=page.getByRole('button',{name:'Library warning',exact:true});
    this.removedWarningPanel=page.locator('#library-warning-panel');
    this.scanWarning=page.locator('#library-scan-warning');
    this.libraryCheck=page.locator('#scan-indicator .status-check');
    this.library=page.getByRole('button',{name:'Library status',exact:true});
    this.openScan=page.locator('[data-status-action="go-to-scan-page"]:visible');
  }
  async readArtistJumpPlacement(artist) {
    // parity-check: allow-read-only-measurement-evaluate -- assert rendered artist content and chrome placement
    return this.page.evaluate(({ targetArtist, headingSelector }) => {
      const scroll = document.getElementById('albums-scroll');
      const header = [...document.querySelectorAll(headingSelector)]
        .find(item => item.getAttribute('data-scroll-artist') === targetArtist);
      const section = header?.closest('.artist-section');
      const rows = section?.querySelector('.artist-rows');
      const firstCard = section?.querySelector('.album-card');
      const chromeName = document.querySelector(
        '[data-gallery-bar-instance="gallery"] [data-gallery-context-name]',
      );
      if (!scroll || !header || !rows || !firstCard || !chromeName) {
        return { rendered: false, chromeMatches: false, rowsAligned: false, firstCardUncut: false };
      }
      const scrollRect = scroll.getBoundingClientRect();
      const rowsRect = rows.getBoundingClientRect();
      const firstCardRect = firstCard.getBoundingClientRect();
      return {
        rendered: true,
        chromeMatches: chromeName.textContent.trim() === targetArtist,
        rowsAligned: Math.abs(rowsRect.top - scrollRect.top) <= 1,
        firstCardUncut: firstCardRect.top >= scrollRect.top - 1,
      };
    }, { targetArtist: artist, headingSelector: this.artistHeadingSelector });
  }

  async openArtistTreeContextMenu(artist) {
    const normalizedArtist = String(artist || '').trim();
    const row = this.page.locator(
      `${this.sidebarArtistSelector}[data-sidebar-artist=${JSON.stringify(normalizedArtist)}]`,
    ).first();
    if (!await row.count()) {
      // parity-check: allow-read-only-measurement-evaluate -- locate the requested source index before native wheel input
      const targetIndex = await this.sidebarList.evaluate((list, targetArtist) => (
        Array.isArray(list.albumHavenSidebarArtistsSource)
          ? list.albumHavenSidebarArtistsSource.findIndex(item => String(item?.artist || '') === targetArtist)
          : -1
      ), normalizedArtist);
      if (targetIndex < 0) throw new Error(`Artist Tree does not contain ${normalizedArtist}`);
      const box = await this.sidebarList.boundingBox();
      if (!box) throw new Error('Artist Tree is not visible');
      for (let attempt = 0; attempt < 5 && !await row.count(); attempt += 1) {
        const firstIndex = Number(await this.sidebarArtists.first().getAttribute('data-sidebar-virtual-index')) || 0;
        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await this.page.mouse.wheel(0, (targetIndex - firstIndex) * 47);
        await this.page.waitForTimeout(40);
      }
      await row.waitFor({ state: 'attached' });
    }
    await row.scrollIntoViewIfNeeded();
    await row.click({ button: 'right' });
  }
  async readMountedArtistsNearCenter() {
    // parity-check: allow-read-only-measurement-evaluate -- choose adjacent mounted groups for UI navigation
    return this.page.evaluate(() => {
      const groups = Array.isArray(state.view?.artist_groups) ? state.view.artist_groups : [];
      const center = Math.max(0, Math.floor(groups.length / 2) - 1);
      return groups.slice(center, center + 3).map(group => String(group.artist || '')).filter(Boolean);
    });
  }

  async captureVisibleCardAnchor() {
    // parity-check: allow-read-only-measurement-evaluate -- retain a visible card across native scrolling
    return this.page.evaluateHandle(() => {
      const scroll = document.getElementById('albums-scroll');
      const bounds = scroll.getBoundingClientRect();
      const card = [...document.querySelectorAll('#artist-groups .album-card')]
        .find(item => {
          const rect = item.getBoundingClientRect();
          return rect.top >= bounds.top && rect.top < bounds.bottom;
        });
      return { card, top: card?.getBoundingClientRect().top ?? null };
    });
  }

  async readVisibleCardAnchorContinuity(anchor) {
    // parity-check: allow-read-only-measurement-evaluate -- measure visual movement after native scrolling
    return anchor.evaluate(saved => ({
      connected: Boolean(saved.card?.isConnected),
      delta: saved.card?.isConnected && saved.top !== null
        ? saved.card.getBoundingClientRect().top - saved.top
        : null,
    }));
  }

  async readPrecedingRenderedGroupCompleteness() {
    // parity-check: allow-read-only-measurement-evaluate -- compare rendered preceding groups to authoritative totals
    return this.page.evaluate(() => {
      const chromeArtist = document.querySelector(
        '[data-gallery-bar-instance="gallery"] [data-gallery-context-name]',
      )?.textContent?.trim();
      const groups = Array.isArray(state.view?.artist_groups) ? state.view.artist_groups : [];
      const index = groups.findIndex(group => String(group.artist || '') === chromeArtist);
      return groups.slice(Math.max(0, index - 2), index).map(group => {
        const artist = String(group.artist || '');
        const heading = [...document.querySelectorAll('[data-scroll-artist]')]
          .find(item => item.getAttribute('data-scroll-artist') === artist);
        const sidebar = (state.view.artists_sidebar || [])
          .find(item => String(item.artist || '') === artist);
        return {
          artist,
          renderedAlbums: heading?.closest('.artist-section')?.querySelectorAll('.album-card').length || 0,
          loadedAlbums: Array.isArray(group.albums) ? group.albums.length : 0,
          authoritativeAlbums: Number(sidebar?.count || 0),
        };
      });
    });
  }

  async readRenderedArtistAlbumCount(artist) {
    // parity-check: allow-read-only-measurement-evaluate -- count target cards after exact local materialization
    return this.page.evaluate(targetArtist => {
      const heading = [...document.querySelectorAll('[data-scroll-artist]')]
        .find(item => item.getAttribute('data-scroll-artist') === targetArtist);
      return heading?.closest('.artist-section')?.querySelectorAll('.album-card').length || 0;
    }, artist);
  }

  async readContinuationGeometry() {
    // parity-check: allow-read-only-measurement-evaluate -- measure distance from current root-page boundary
    return this.galleryScroll.evaluate(scroll => ({
      remaining: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
      viewport: scroll.clientHeight,
    }));
  }

  async captureVisibleGalleryAnchor() {
    // parity-check: allow-read-only-measurement-evaluate -- retain a visible card at the native continuation boundary, without changing DOM or app state
    return this.page.evaluateHandle(() => {
      const scroll = document.getElementById('albums-scroll');
      const bounds = scroll.getBoundingClientRect();
      const element = [...document.querySelectorAll('#artist-groups .album-card')].find(card => {
        const rect = card.getBoundingClientRect();
        return rect.top < bounds.bottom && rect.bottom > bounds.top;
      });
      return { element, top: element?.getBoundingClientRect().top, scrollTop: scroll.scrollTop,
        loadedCount: state.view.artist_groups.reduce((count, group) => count + group.albums.length, 0) };
    });
  }
  async captureVisibleGalleryAnchorOnNextScroll() {
    // parity-check: allow-read-only-measurement-evaluate -- capture native scroll before continuation can merge
    return this.page.evaluateHandle(() => new Promise((resolve, reject) => {
      const scroll = document.getElementById('albums-scroll');
      const initialLoadedCount = state.view.artist_groups.reduce(
        (count, group) => count + group.albums.length,
        0,
      );
      let frame;
      let timeout;
      let finished = false;
      const cleanup = () => {
        scroll.removeEventListener('scroll', onScroll);
        if (frame !== undefined) cancelAnimationFrame(frame);
        clearTimeout(timeout);
      };
      const fail = message => {
        finished = true;
        cleanup();
        reject(new Error(message));
      };
      const sample = () => {
        if (finished) return;
        const loadedCount = state.view.artist_groups.reduce(
          (count, group) => count + group.albums.length,
          0,
        );
        if (loadedCount !== initialLoadedCount) {
          fail('Gallery continuation merged before a pre-merge anchor rendered.');
          return;
        }
        const bounds = scroll.getBoundingClientRect();
        const element = [...document.querySelectorAll('#artist-groups .album-card')].find(card => {
          const rect = card.getBoundingClientRect();
          return rect.top < bounds.bottom && rect.bottom > bounds.top;
        });
        if (element) {
          finished = true;
          cleanup();
          resolve({
            element,
            top: element.getBoundingClientRect().top,
            scrollTop: scroll.scrollTop,
            loadedCount,
          });
          return;
        }
        frame = requestAnimationFrame(sample);
      };
      const onScroll = () => { frame = requestAnimationFrame(sample); };
      scroll.addEventListener('scroll', onScroll, { once: true });
      timeout = setTimeout(
        () => fail('Timed out waiting for a pre-merge gallery anchor to render.'),
        1000,
      );
    }));
  }

  async readGalleryAnchorContinuity(anchor) {
    // parity-check: allow-read-only-measurement-evaluate -- read card identity and compensate only for native wheel movement
    return anchor.evaluate(saved => ({
      connected: saved.element.isConnected,
      drift: saved.element.getBoundingClientRect().top - saved.top
        + document.getElementById('albums-scroll').scrollTop - saved.scrollTop,
    }));
  }
  cover(card) { return card.locator('img').first(); }
  async observeSearchContinuity(query) {
    let pendingRequests = 0;
    const onRequest = request => {
      const url = new URL(request.url());
      if (url.pathname === '/view-data' && url.searchParams.get('q') === query) pendingRequests += 1;
    };
    this.page.on('request', onRequest);
    let observation;
    try {
      // parity-check: allow-read-only-measurement-evaluate -- sample actual gallery visibility throughout native search without modifying product state
      observation = await this.page.evaluateHandle(() => {
        const gallery = document.getElementById('artist-groups');
        const scroll = document.getElementById('albums-scroll');
        const loader = document.getElementById('library-loader');
        const evidence = { samples: 0, pendingSearchSamples: 0, previousGalleryVisible: 0, missingSearchLoader: 0, blockingLoader: 0, searching: 0, warningExposures: 0 };
        const visible = element => Boolean(element?.getClientRects().length) && !element.hidden
          && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        let frame;
        const inspect = () => {
          evidence.samples += 1;
          if (state.ui.pendingGallerySearch) {
            evidence.pendingSearchSamples += 1;
            if (visible(scroll) && visible(gallery)) evidence.previousGalleryVisible += 1;
            if (!visible(loader) || !loader.classList.contains('is-searching')) evidence.missingSearchLoader += 1;
          }
          if (visible(loader)) {
            if (loader.classList.contains('is-searching') && document.getElementById('library-loader-title')?.textContent === 'Searching') evidence.searching += 1;
            else evidence.blockingLoader += 1;
          }
          if ([...loader.querySelectorAll('[role="alert"]')].some(visible)) evidence.warningExposures += 1;
        };
        const sample = () => { inspect(); frame = requestAnimationFrame(sample); };
        sample();
        return { finish() { cancelAnimationFrame(frame); inspect(); return evidence; } };
      });
    } catch (error) {
      this.page.off('request', onRequest);
      throw error;
    }
    return { observation, onRequest, readPendingRequests: () => pendingRequests };
  }
  async finishSearchContinuity({ observation, onRequest, readPendingRequests }) {
    try {
      // parity-check: allow-read-only-measurement-evaluate -- collect and stop the owned search visibility sampler
      const evidence = await observation.evaluate(value => value.finish());
      return { ...evidence, pendingRequests: readPendingRequests() };
    } finally {
      this.page.off('request', onRequest);
      await observation.dispose();
    }
  }
  async observeLoaderVisibility() {
    // parity-check: allow-read-only-measurement-evaluate -- observe loader visibility without changing product state
    return this.page.evaluateHandle(() => {
      const loader = document.getElementById('library-loader');
      const evidence = { seen: false };
      const record = () => {
        if (loader && !loader.hidden && getComputedStyle(loader).display !== 'none') evidence.seen = true;
      };
      const observer = new MutationObserver(record);
      observer.observe(loader, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
      record();
      return { finish() { observer.disconnect(); record(); return evidence.seen; } };
    });
  }
  async finishLoaderVisibility(observation) {
    try {
      // parity-check: allow-read-only-measurement-evaluate -- collect and stop owned loader visibility observer
      return await observation.evaluate(value => value.finish());
    } finally {
      await observation.dispose();
    }
  }
  async readCompletedStartupPartialView() {
    // parity-check: allow-read-only-measurement-evaluate -- observe the production full-hydration paint marker
    return this.page.evaluate(() => window.__ALBUM_HAVEN_STARTUP_METRICS__
      ?.marks?.initial_refresh_complete?.detail?.partialView ?? null);
  }
  yearWithin(card) { return card.locator('.gallery-card__hover-year'); }
  numberPlay(row) { return row.locator('.album-track-table__number-play'); }
  async readTrackPath(row) {
    const path = String(await row.getAttribute('data-track-row-path') || '');
    if (!path) throw new Error('The selected production track row has no playback path.');
    return path;
  }
  title(row) { return row.locator('.album-track-table__title'); }
  number(row) { return row.locator('.album-track-table__number'); }
  play(row) { return row.locator('.album-track-table__play'); }
  async selection() {
    // parity-check: allow-read-only-measurement-evaluate -- observe native user text selection
    return this.page.evaluate(()=>document.getSelection()?.toString() || '');
  }
  async center(locator) { const box=await locator.boundingBox(); return box.x+box.width/2; }
}
