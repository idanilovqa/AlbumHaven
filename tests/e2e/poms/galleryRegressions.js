function observeArtistPlacement({ targetArtist, headingSelector, observe = false }) {
  const read = () => {
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

  };
  if (!observe) return read();
  const samples = [];
  let frame;
  const sample = () => {
    samples.push({ at: performance.now(), stable: Object.values(read()).every(Boolean) });
    frame = requestAnimationFrame(sample);
  };
  frame = requestAnimationFrame(sample);
  return { finish() { cancelAnimationFrame(frame); return samples; } };
}

export class GalleryRegressions {
  constructor(page) {
    this.page=page;
    this.artistHeadingSelector='#artist-groups .family-artist-header[data-scroll-artist]';
    this.familyToggle=page.locator('[data-gallery-bar-action="artist-family"]');
    this.familyPanel=page.locator('#artist-family-panel');
    this.nealSidebar=page.locator('[data-sidebar-artist="Neal Morse"]');
    this.rootSidebar=page.locator('#sidebar-list [data-sidebar-all-artists="1"]');
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
    this.toolbarInfo=page.locator('[data-gallery-bar-instance="gallery"] [data-artist-info-trigger]').first();
    this.headingInfo=page.locator('#artist-groups .family-artist-header [data-artist-info-trigger]').first();
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
    return this.page.evaluate(observeArtistPlacement, {
      targetArtist: artist, headingSelector: this.artistHeadingSelector,
    });
  }
  async startArtistJumpPlacementObservation(artist) {
    const handle = await this.page.evaluateHandle(observeArtistPlacement, {
      targetArtist: artist, headingSelector: this.artistHeadingSelector, observe: true,
    });
    let finished = false;
    return { async finish() {
      if (finished) return [];
      finished = true;
      try {
        // parity-check: allow-read-only-measurement-evaluate -- collect closure-owned geometry samples and stop its frame
        return await handle.evaluate(observation => observation.finish());
      } finally { await handle.dispose(); }
    } };
  }
  async firstAlbumKeyForArtist(artist) {
    // parity-check: allow-read-only-measurement-evaluate -- read first rendered album identity under exact artist heading
    return this.page.evaluate(({ artist, headingSelector }) => {
      const heading = [...document.querySelectorAll(headingSelector)]
        .find(candidate => candidate.getAttribute('data-scroll-artist') === artist);
      return heading?.closest('.artist-section')?.querySelector('[data-open-tracklist="1"][data-album-key]')
        ?.getAttribute('data-album-key') || '';
    }, { artist, headingSelector: this.artistHeadingSelector });
  }
  albumMetadataByKey(key) { return this.albumCardByKey(key).locator('.album-meta-row'); }
  get mobileAlbum() { return this.page.locator('#mobile-page-outlet #track-modal'); }
  get mobileBack() { return this.page.locator('#mobile-back-button'); }
  async longPressArtist(row) {
    const box = await row.boundingBox();
    if (!box) throw new Error('Artist row is not visible for long press');
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      await cdp.send('Input.synthesizeTapGesture', {
        x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2),
        duration: 600, gestureSourceType: 'touch', tapCount: 1,
      });
    } finally { await cdp.detach(); }
  }
  async readArtistJumpOwnership(artist) {
    // parity-check: allow-read-only-measurement-evaluate -- retain authoritative anchor ownership on placement failure
    return this.page.evaluate(requestedArtist => ({
      requestedArtist,
      anchorArtist: state.view?.gallery_page?.anchor_artist || null,
      anchorGroupArtist: state.view?.gallery_page?.anchor_group_artist || null,
      offset: state.view?.gallery_page?.offset ?? null,
      sidebarCount: (state.view?.artists_sidebar || []).length,
      loadedArtists: (state.view?.artist_groups || []).map(group => group.artist),
      renderedArtists: [...document.querySelectorAll('[data-scroll-artist]')]
        .map(element => element.getAttribute('data-scroll-artist')),
    }), artist);
  }
  albumCardByKey(key) {
    return this.cards.filter({
      has: this.page.locator(`[data-album-key=${JSON.stringify(key)}]`),
    }).first();
  }

  async sidebarArtistSourceIndex(artist) {
    // parity-check: allow-read-only-measurement-evaluate -- read canonical sidebar source index
    return this.sidebarList.evaluate((list, targetArtist) => (
      Array.isArray(list.albumHavenSidebarArtistsSource)
        ? list.albumHavenSidebarArtistsSource.findIndex(item => String(item?.artist || '') === targetArtist)
        : -1
    ), artist);
  }
  async revealArtistWithWheel(artist) {
    const normalizedArtist = String(artist || '').trim();
    const row = this.page.locator(
      `${this.sidebarArtistSelector}[data-sidebar-artist=${JSON.stringify(normalizedArtist)}]`,
    ).first();
    if (!await row.count()) {
      const targetIndex = await this.sidebarArtistSourceIndex(normalizedArtist);
      if (targetIndex < 0) throw new Error(`Artist Tree does not contain ${normalizedArtist}`);
      for (let attempt = 0; attempt < 5 && !await row.count(); attempt += 1) {
        // parity-check: allow-read-only-measurement-evaluate -- aim native wheel input inside the actual visible scroll owner
        const position = await this.sidebarList.evaluate((list, index) => {
          const owner = list.clientHeight > 0 && list.scrollHeight > list.clientHeight + 1
            ? list : list.closest('.sidebar');
          if (!owner) return null;
          const bounds = owner.getBoundingClientRect();
          const top = Math.max(0, bounds.top);
          const bottom = Math.min(window.innerHeight, bounds.bottom);
          const left = Math.max(0, bounds.left);
          const right = Math.min(window.innerWidth, bounds.right);
          if (bottom <= top || right <= left) return null;
          const listTop = owner === list ? 0 : list.getBoundingClientRect().top - bounds.top + owner.scrollTop;
          return {
            x: (left + right) / 2,
            y: (top + bottom) / 2,
            delta: listTop + index * 47 - owner.scrollTop,
          };
        }, targetIndex);
        if (!position) throw new Error('Artist Tree scroll viewport is not visible');
        await this.page.mouse.move(position.x, position.y);
        await this.page.mouse.wheel(0, position.delta);
        await this.page.waitForTimeout(1000);
      }
      await row.waitFor({ state: 'attached', timeout: 1000 });
    }
    await row.scrollIntoViewIfNeeded();
    await row.waitFor({ state: 'visible', timeout: 1000 });
    return row;
  }
  async openArtistTreeContextMenu(artist) {
    const row = await this.revealArtistWithWheel(artist);
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
    // parity-check: allow-read-only-measurement-evaluate -- retain a visible DOM card across native reverse scrolling
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
    // parity-check: allow-read-only-measurement-evaluate -- measure the retained card after native scrolling
    return anchor.evaluate(saved => ({
      connected: Boolean(saved.card?.isConnected),
      delta: saved.card?.isConnected && saved.top !== null
        ? saved.card.getBoundingClientRect().top - saved.top : null,
    }));
  }

  async revealAlbumWithGalleryWheel(album) {
    let previousTop = null;
    let stableSamples = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const viewport = await this.galleryScroll.boundingBox();
      const bounds = await album.boundingBox();
      if (!viewport || !bounds) throw new Error('Gallery or target album is not rendered');
      const contained = bounds.y >= viewport.y && bounds.y + bounds.height <= viewport.y + viewport.height;
      if (contained) {
        stableSamples = bounds.y === previousTop ? stableSamples + 1 : 0;
        if (stableSamples >= 2) return;
      } else {
        stableSamples = 0;
        await this.page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
        const distance = bounds.y - (viewport.y + viewport.height / 2 - bounds.height / 2);
        await this.page.mouse.wheel(0, Math.max(-520, Math.min(520, distance)));
      }
      previousTop = bounds.y;
      await this.page.waitForTimeout(80);
    }
    throw new Error('Target album did not settle inside the gallery after native scrolling');
  }

  async readFullyVisibleGalleryAlbumOutsideArtist(excludedArtist) {
    // parity-check: allow-read-only-measurement-evaluate -- identify a different artist's visible album after native wheel input
    return this.page.evaluate(excluded => {
      const viewport = document.getElementById('albums-scroll').getBoundingClientRect();
      for (const metadata of document.querySelectorAll('#artist-groups .album-meta-row')) {
        const bounds = metadata.getBoundingClientRect();
        if (bounds.height <= 0 || bounds.top < viewport.top || bounds.bottom > viewport.bottom) continue;
        const card = metadata.closest('.album-card');
        const artist = card?.closest('.artist-section')
          ?.querySelector('.family-artist-header[data-scroll-artist]')?.getAttribute('data-scroll-artist');
        const albumKey = card?.querySelector('[data-open-tracklist="1"][data-album-key]')?.getAttribute('data-album-key');
        if (artist && artist !== excluded && albumKey) return { artist, albumKey };
      }
      return null;
    }, excludedArtist);
  }

  async scrollToDifferentGalleryArtist(artist) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const viewport = await this.galleryScroll.boundingBox();
      if (!viewport) throw new Error('Gallery is not rendered');
      await this.page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
      await this.page.mouse.wheel(0, 320);
      await this.page.waitForTimeout(80);
      const target = await this.readFullyVisibleGalleryAlbumOutsideArtist(artist);
      if (!target) continue;
      await this.revealAlbumWithGalleryWheel(this.albumMetadataByKey(target.albumKey));
      return target;
    }
    throw new Error('Native gallery scrolling did not reveal a different artist');
  }

  async captureSemanticVisibleCardAnchor(albumKey) {
    // parity-check: allow-read-only-measurement-evaluate -- retain a visible card across native scrolling
    return this.page.evaluate(targetKey => {
      const scroll = document.getElementById('albums-scroll');
      const bounds = scroll.getBoundingClientRect();
      const card = [...document.querySelectorAll('#artist-groups .album-card')]
        .find(item => {
          const rect = item.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom
            && item.querySelector('[data-open-tracklist="1"][data-album-key]')
              ?.getAttribute('data-album-key') === targetKey;
        });
      const trigger = card?.querySelector('[data-open-tracklist="1"][data-album-key]');
      const artist = card?.closest('.artist-section')
        ?.querySelector('.family-artist-header[data-scroll-artist]')
        ?.getAttribute('data-scroll-artist') || '';
      return {
        albumKey: trigger?.getAttribute('data-album-key') || '',
        artist,
        top: card?.getBoundingClientRect().top ?? null,
      };
    }, albumKey);
  }

  async readSemanticVisibleCardAnchorContinuity(anchor) {
    // parity-check: allow-read-only-measurement-evaluate -- resolve the same semantic card after gallery rerenders
    return this.page.evaluate(saved => {
      const section = [...document.querySelectorAll('#artist-groups .artist-section')]
        .find(item => item.querySelector('.family-artist-header[data-scroll-artist]')
          ?.getAttribute('data-scroll-artist') === saved.artist);
      const card = [...(section?.querySelectorAll('.album-card') || [])]
        .find(item => item.querySelector('[data-open-tracklist="1"][data-album-key]')
          ?.getAttribute('data-album-key') === saved.albumKey);
      return {
        connected: Boolean(card?.isConnected),
        delta: card?.isConnected && saved.top !== null
          ? card.getBoundingClientRect().top - saved.top
          : null,
      };
    }, anchor);
  }
  async startVisibleCardAnchorObservation(anchor) {
    // parity-check: allow-read-only-measurement-evaluate -- sample the semantic card every frame across rerenders
    const handle = await this.page.evaluateHandle(saved => {
      const samples = [];
      let frame;
      let originalCard;
      const sample = () => {
        const section = [...document.querySelectorAll('#artist-groups .artist-section')]
          .find(item => item.querySelector('.family-artist-header[data-scroll-artist]')
            ?.getAttribute('data-scroll-artist') === saved.artist);
        const card = [...(section?.querySelectorAll('.album-card') || [])]
          .find(item => item.querySelector('[data-open-tracklist="1"][data-album-key]')
            ?.getAttribute('data-album-key') === saved.albumKey);
        const connected = Boolean(card?.isConnected);
        const delta = connected && saved.top !== null
          ? card.getBoundingClientRect().top - saved.top
          : null;
        if (originalCard === undefined) originalCard = card || null;
        const scroller = document.querySelector('#albums-scroll');
        const scrollRect = scroller?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        const row = card?.closest('.album-row') || card?.parentElement;
        const rowRect = row?.getBoundingClientRect();
        samples.push({
          at: performance.now(), epoch: performance.timeOrigin + performance.now(),
          connected, delta, stable: connected && Math.abs(delta) <= 1,
          originalConnected: Boolean(originalCard?.isConnected), sameNode: card === originalCard,
          scrollTop: scroller?.scrollTop, scrollHeight: scroller?.scrollHeight,
          viewportTop: cardRect?.top,
          contentTop: cardRect && scrollRect ? cardRect.top - scrollRect.top + scroller.scrollTop : null,
          rowTop: rowRect?.top, rowHeight: rowRect?.height,
          sectionTop: section?.getBoundingClientRect().top,
          sectionHeight: section?.getBoundingClientRect().height,
        });
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      return {
        finish() {
          cancelAnimationFrame(frame);
          return samples;
        },
      };
    }, anchor);
    let finished = false;
    return {
      async finish() {
        if (finished) return [];
        finished = true;
        try {
          // parity-check: allow-read-only-measurement-evaluate -- stop and collect closure-owned samples
          return await handle.evaluate(observation => observation.finish());
        } finally {
          await handle.dispose();
        }
      },
    };
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
