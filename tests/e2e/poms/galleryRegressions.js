export class GalleryRegressions {
  constructor(page) {
    this.page=page;
    this.familyToggle=page.locator('[data-gallery-bar-action="artist-family"]');
    this.familyPanel=page.locator('#artist-family-panel');
    this.nealSidebar=page.locator('[data-sidebar-artist="Neal Morse"]');
    this.rootSidebar=page.locator('[data-sidebar-all-artists="1"]');
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
    this.warning=page.getByRole('button',{name:'Library warning',exact:true});
    this.warningPanel=page.locator('#library-warning-panel');
    this.scanWarning=page.locator('#library-scan-warning');
    this.libraryCheck=page.locator('#scan-indicator .status-check');
    this.library=page.getByRole('button',{name:'Library status',exact:true});
    this.openScan=page.locator('[data-status-action="go-to-scan-page"]:visible');
  }
  cover(card) { return card.locator('img').first(); }
  yearWithin(card) { return card.locator('.gallery-card__hover-year'); }
  numberPlay(row) { return row.locator('.album-track-table__number-play'); }
  title(row) { return row.locator('.album-track-table__title'); }
  number(row) { return row.locator('.album-track-table__number'); }
  play(row) { return row.locator('.album-track-table__play'); }
  async selection() {
    // parity-check: allow-read-only-measurement-evaluate -- observe native user text selection
    return this.page.evaluate(()=>document.getSelection()?.toString() || '');
  }
  async center(locator) { const box=await locator.boundingBox(); return box.x+box.width/2; }
}
