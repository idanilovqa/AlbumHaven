export class GalleryRegressions {
  constructor(page) {
    this.page=page;
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
    this.view=page.locator('[data-gallery-view-cluster]');
    this.noInfo=page.getByRole('button',{name:'No info',exact:true});
    this.cardsView=page.getByRole('button',{name:'Cards',exact:true});
    this.info=page.locator('[data-artist-info-trigger]').first();
    this.infoPanel=page.locator('[data-artist-info-overlay]');
    this.modal=page.locator('#track-modal');
    this.dialog=this.modal.locator('.track-modal-dialog');
    this.header=this.modal.locator('.track-modal-header');
    this.activeReleaseTab=this.modal.locator('[data-track-tab-index].is-active');
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
  cover(card) { return card.locator('img').first(); }
  async observeSelectionLoader() {
    // parity-check: allow-read-only-measurement-evaluate -- observe rendered selection loader transitions without modifying product state
    return this.page.evaluateHandle(() => {
      const loader = document.getElementById('library-loader');
      const evidence = { selections: 0, warningExposures: 0, missingSpinners: 0 };
      const inspect = () => {
        if (loader.hidden || document.getElementById('library-loader-title')?.textContent !== 'Loading selection') return;
        evidence.selections += 1;
        if ([...loader.querySelectorAll('[role="alert"]')].some(alert => alert.getClientRects().length > 0)) {
          evidence.warningExposures += 1;
        }
        if (!loader.querySelector('.library-loader-spinner')?.getClientRects().length) {
          evidence.missingSpinners += 1;
        }
      };
      const observer = new MutationObserver(inspect);
      observer.observe(loader, { subtree: true, childList: true, attributes: true, characterData: true });
      inspect();
      return { finish() { inspect(); observer.disconnect(); return evidence; } };
    });
  }
  async finishSelectionLoaderObservation(observation) {
    try {
      // parity-check: allow-read-only-measurement-evaluate -- read and disconnect the owned loader observer
      return await observation.evaluate(value => value.finish());
    } finally { await observation.dispose(); }
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
