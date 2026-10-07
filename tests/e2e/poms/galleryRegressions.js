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
    this.numberHeader=page.locator('#track-modal [role=columnheader][data-cdt-column=number]').first();
    this.yearCard=page.locator('.album-card[data-gallery-release-year]').first();
    this.year=this.yearCard.locator('.gallery-card__hover-year');
    this.infoSummary=page.locator('[data-artist-info-overlay] [data-artist-info-summary]');
    this.cards=page.locator('.album-card');
    this.sidebarArtists=page.locator('#sidebar-list [data-sidebar-artist]');
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
        const evidence = { samples: 0, hiddenGallery: 0, blockingLoader: 0, warningExposures: 0 };
        const visible = element => Boolean(element?.getClientRects().length) && !element.hidden
          && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        let frame;
        const inspect = () => {
          evidence.samples += 1;
          if (!visible(scroll) || !visible(gallery) || !gallery.querySelector('.album-card')) evidence.hiddenGallery += 1;
          if (visible(loader)) evidence.blockingLoader += 1;
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
