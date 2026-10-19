import { HomeFeedbackPage } from './homeFeedbackPage.js';

/** Exact production controls only; no runtime state or fallback selectors. */
export class NativeAcceptancePage extends HomeFeedbackPage {
  constructor(page) {
    super(page);
    this.goalsTab = this.sections.getByRole('tab', { name: 'Goals', exact: true });
    this.goalAlbums = this.home.locator('[aria-label="Goal albums"]');
    this.goalStart = this.home.getByRole('button', { name: 'Start', exact: true });
    this.goalAdmission = page.getByRole('dialog', { name: 'Add albums to Goals', exact: true });
    this.goalForm = this.goalAdmission.locator('form[aria-label="Search albums for Goals"]');
    this.tops = page.locator('#album-tops-root').locator('section[aria-label="Album Tops"]');
    this.topHeader = this.tops.locator('[data-shared-header]');
    this.topProgress = this.tops.getByRole('progressbar', { name: 'Manually completed albums in this Top', exact: true });
    this.topEditor = page.locator('form[aria-label="Edit Album Top"]');
    this.search = page.locator('#search-input');
    this.advancedToggle = page.locator('#search-advanced-toggle');
    this.advanced = page.locator('#search-advanced-panel[role="dialog"]');
    this.capEnabled = this.advanced.locator('[data-advanced-cap]');
    this.cap = this.advanced.locator('[data-advanced-field="cap"]');
    this.preview = this.advanced.locator('pre[aria-label="Query preview"]');
    this.artistRoot = page.locator('#artist-page-root');
    this.artistName = page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]');
    this.discography = this.artistRoot.locator('[data-disclosure-key="discography"]');
    this.lightbox = page.locator('#image-lightbox');
    this.lightboxImage = this.lightbox.locator('#image-lightbox-image');
    this.sheetHandle = page.locator('#track-modal-sheet-handle');
    this.sheetToggle = page.locator('#track-modal-sheet-toggle');
    this.favorite = this.modal.locator('[data-album-preference-action="favorite"]');
    this.rating = this.modal.locator('select[aria-label="Your album rating"]');
    this.preferenceStatus = this.modal.locator('[data-album-preference-status]');
    this.enabledPreferenceActions = this.modal.locator('[data-album-preference-action]:enabled');
    this.goalAlbumCards = this.goalAlbums.locator('.album-card');
    this.topAlbumTitles = this.tops.locator('.album-card .album-title');
    this.topCompletions = this.tops.locator('[data-gallery-card-intent="complete"]');
    this.visibleAlbumCards = page.locator('.album-card:visible');
    this.advancedClose = this.advanced.locator('[data-search-help-close]');
    this.advancedApply = this.advanced.locator('[data-advanced-apply]');
    this.advancedReset = this.advanced.locator('[data-advanced-reset]');
    this.discographyPanel = this.discography.locator('[data-disclosure-panel]');
    this.modalCoverOpener = this.modal.locator('#track-modal-cover [data-open-lightbox="1"]');
    this.lightboxClose = page.locator('#image-lightbox-close');
  }
  exactActivity(title) {
    return this.activityRows.filter({ has: this.page.locator('.album-track-table__title').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  }
  exactFriend(ref) { return this.page.locator(`[data-home-person-ref=${JSON.stringify(ref)}]:visible`); }
  trackRow(title) {
    return this.modal.locator('[data-track-row-path]').filter({ has: this.page.locator('.album-track-table__title').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  }
  albumOpener(album, scope = this.page) {
    return scope.locator(`.album-title-button[data-open-tracklist="1"][data-album-key=${JSON.stringify(album.key)}]`)
      .filter({ hasText: new RegExp(`^${album.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
  }
  topOpener(top) { return this.tops.locator(`[data-gallery-card-intent="open"][data-gallery-card-ref=${JSON.stringify(top.ref)}]`); }
  topCompletion(album, completed) {
    return this.tops.getByRole('button', { name: `${completed ? 'Clear completion' : 'Mark completed'} in this Top: ${album.title}`, exact: true })
      .and(this.tops.locator(`[data-gallery-card-ref=${JSON.stringify(album.ref)}]`));
  }
  async imageReady(locator) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the displayed image decode state only
    return locator.evaluate(element => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0);
  }
  async foreground(locator) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect current DOM inert/hidden ancestry only
    return locator.evaluate(element => !element.closest('[hidden],[inert],[aria-hidden="true"]'));
  }
  async layout(locator) {
    // parity-check: allow-read-only-measurement-evaluate -- read native layout without mutation
    return locator.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width,
        viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
    });
  }
}
