import { expect } from '@playwright/test';

/** Selectors and user interactions for the shared responsive application shell. */
export class MobileLayoutPage {
  constructor(page) {
    this.page = page;
    this.loginForm = page.getByRole('form', { name: 'Album Haven sign in' });
    this.username = page.getByLabel('Username');
    this.password = page.getByLabel('Password', { exact: true });
    this.signInButton = page.getByRole('button', { name: 'Sign in', exact: true });
    this.appShell = page.locator('#app-shell');
    this.home = page.locator('#mobile-home');
    this.galleryContextName = page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]');
    this.artistHeading = page.locator('#shell-navigation-rail h2');
    this.homeCards = this.home.locator('.album-card');
    this.homeAlbums = this.home.locator('[data-open-tracklist]');
    this.homeTabs = this.home.getByRole('tablist', { name: 'Recent listening' });
    this.homePanel = this.home.getByRole('tabpanel');
    this.recentTab = page.getByRole('tab', { name: 'Recent', exact: true });
    this.newsTab = page.getByRole('tab', { name: 'News', exact: true });
    this.searchInput = page.locator('#search-input');
    this.searchButton = page.locator('#mobile-search-button');
    this.libraryButton = page.locator('#mobile-library-button');
    this.artistRail = page.locator('#shell-navigation-rail');
    this.closeArtistRail = this.artistRail.locator('[data-close-artists-drawer]');
    this.artistPlaceholderTabs = page.locator('[data-mobile-library-mode]');
    this.galleryCards = page.locator('#artist-groups .album-card');
    this.galleryAlbums = this.galleryCards.locator('[data-open-tracklist]');
    this.galleryGrid = this.galleryCards.first().locator('..');
    this.albumIdentity = page.locator('.mobile-album-identity');
    this.timeline = page.locator('#player-timeline');
    this.playerPlay = page.locator('#player-play');
    this.cancelAppearance = page.locator('#utility-modal-footer [data-editor-footer-action="secondary"]');
    this.thinOption = page.locator('[data-appearance-seekbar-mode="thin"]');
    this.regularOption = page.locator('[data-appearance-seekbar-mode="default"]');
    this.waveformOption = page.locator('[data-appearance-seekbar-mode="waveform"]');
    this.playerPreview = page.locator('[data-player-live-preview]');
    this.playerPreviewKnob = this.playerPreview.locator('.player-preview-seekbar > span');
    this.familyButton = page.locator('[data-gallery-bar-action="artist-family"]');
    this.familyPanel = page.locator('#artist-family-panel');
    this.viewCluster = page.locator('#gallery-view-cluster-options');
    this.activeView = this.viewCluster.locator('.is-active');
    this.zoomButton = page.getByRole('button', { name: 'Gallery zoom', exact: true });
    this.zoomMenu = page.locator('#mobile-gallery-density-menu');
    this.albumPage = page.locator('#mobile-page-outlet #track-modal');
    this.trackTable = page.locator('#track-modal .album-track-table');
    this.albumDialogs = page.locator('#track-modal [aria-modal="true"]');
    this.editTags = page.locator('#track-modal-edit-tags');
    this.backButton = page.locator('#mobile-back-button');
    this.player = page.locator('.global-player');
    this.settingsButton = page.locator('#app-shell [data-account-menu-trigger]');
    this.utilitiesButton = page.locator('#app-shell [data-open-utilities]');
    this.utilitiesPage = page.locator('#mobile-page-outlet #utility-modal');
    this.utilitiesDialogs = page.locator('#utility-modal [role="dialog"]');
    this.pageTitle = page.locator('#mobile-page-title');
    this.profileButton = page.locator('#app-shell .account-profile-button');
    this.adminLink = page.locator('#app-shell [data-account-menu-admin]');
    this.accountNavToggle = page.locator('[data-settings-outlet] [data-settings-nav-toggle]');
    this.accountLink = page.locator('[data-settings-nav] [data-settings-section="account"]');
    this.securityHeading = page.getByRole('heading', { name: 'Password', exact: true });
    this.settingsSectionsButton = page.locator('#mobile-settings-button');
    this.settingsDrawer = page.locator('#mobile-settings-drawer');
    this.subsectionButton = page.locator('#mobile-settings-section-button');
    this.subsectionMenu = page.locator('#mobile-settings-subsection-menu');
    this.albumCover = page.locator('#track-modal-cover');
    this.albumThumbnail = page.locator('#mobile-page-cover');
    this.albumRows = page.locator('#track-modal .album-track-table__row');
    this.pageOutlet = page.locator('#mobile-page-outlet');
    this.playerTime = page.locator('#player-time');
    this.playerArtist = page.locator('#player-artist');
    this.playerGlyph = page.locator('#player-play > svg');
    this.appearanceEditor = page.locator('#utility-modal .appearance-background-editor');
    this.searchControl = page.locator('#mobile-navigation .search-field-control');
    this.findBetterArt = page.locator('#cover-lookup-find-better-button');
    this.coverCandidates = page.locator('#cover-lookup-modal .cover-lookup-gallery').first().locator('.cover-lookup-art-card');
    this.coverBody = page.locator('#cover-lookup-modal-body');
    this.manualCoverSearch = page.locator('#cover-lookup-modal .cover-lookup-manual-add');
    this.coverResults = page.locator('#cover-lookup-modal .cover-lookup-results');
    this.mobileAlbumLayoutChoice = page.locator('.appearance-background-editor [data-album-details-layout]').first();
    this.familyArtists = page.locator('#artist-family-panel [data-gallery-family-artist]');
    this.fullArtwork = page.locator('#image-lightbox-image');
    this.fullArtworkNav = page.locator('.image-lightbox-navigation');
    this.allArtists = page.locator('#sidebar-list a').filter({ hasText: /All artists/i }).first();
    this.galleryScroll = page.locator('#albums-scroll');
    this.mobileNavigation = page.locator('#mobile-navigation');
    this.coverLookupPage = page.locator('#mobile-page-outlet #cover-lookup-modal');
    this.mobileAppearance = page.locator('[data-appearance-device="mobile"]');
    this.followAppearance = page.locator('[data-appearance-device-mode="follow"]');
    this.customAppearance = page.locator('[data-appearance-device-mode="custom"]');
    this.appearanceFields = page.locator('.appearance-device-fields');
    this.saveAppearance = page.locator('#utility-modal-footer [data-editor-footer-action="primary"]');
  }

  async signIn(username, password) {
    await this.page.goto('/');
    await expect(this.loginForm).toBeVisible();
    await this.username.fill(username);
    await this.password.fill(password);
    await this.signInButton.click();
    await expect(this.appShell).toBeVisible();
  }

  async browseArtist(name = 'Northlight') {
    await this.libraryButton.click();
    await this.artist(name).click();
    await expect(this.home).not.toBeVisible();
    await expect(this.galleryCards.first()).toBeVisible();
  }

  albumLayout(value) {
    if (!['classic_bar', 'stacked_bar', 'editorial_canvas'].includes(value)) throw new TypeError('Invalid album layout');
    return this.page.locator(`.appearance-album-layout-card[data-album-details-layout="${value}"]`);
  }

  async saveAppearanceChanges() {
    const saved = this.page.waitForResponse(response => response.url().endsWith('/account/appearance') && response.request().method() === 'PUT');
    await this.saveAppearance.click();
    expect((await saved).status()).toBe(200);
    await expect(this.saveAppearance).toBeDisabled();
  }

  async seekAt(fraction) {
    const box = await this.timeline.boundingBox();
    await this.timeline.click({ position: { x: box.width * fraction, y: box.height - 2 } });
  }

  async thinProgressGeometry() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the live range's visual track and actual audio progress.
    return this.timeline.evaluate(input => ({
      backgroundSize: getComputedStyle(input).backgroundSize,
      height: input.getBoundingClientRect().height,
      bottom: input.getBoundingClientRect().bottom,
      playerBottom: input.closest('.global-player').getBoundingClientRect().bottom,
      progress: parseFloat(input.style.getPropertyValue('--player-seek-progress')),
      value: Number(input.value), max: Number(input.max),
    }));
  }

  async expectGalleryAlbumInventory(titles, lastTitle) {
    // A virtual gallery mounts its viewport, not the entire library at once.
    const labels = this.galleryCards.locator('.album-title-button');
    await expect(labels.first()).toBeVisible();
    const seen = new Set(await labels.allTextContents());
    await this.scrollRegion('gallery', 1400);
    await expect(this.galleryCards.getByRole('button', { name: lastTitle, exact: true })).toBeVisible();
    for (const title of await labels.allTextContents()) seen.add(title);
    expect([...seen].map(title => title.trim()).sort()).toEqual([...titles].sort());
  }

  async selectView(view) {
    if (!['cards', 'covers', 'list'].includes(view)) throw new TypeError('Unknown gallery view');
    await this.activeView.click();
    await this.viewCluster.locator(`[data-gallery-view-choice="${view}"]`).click();
    await expect(this.viewCluster).not.toHaveClass(/is-open/);
  }

  artist(name) {
    return this.page.locator('#sidebar-list [data-sidebar-artist]').filter({ hasText: name }).first();
  }

  utilityTab(name) {
    if (!['appearance', 'integrations', 'problematic-files', 'rules'].includes(name)) {
      throw new TypeError('Unknown utility tab');
    }
    return this.page.locator(`#utility-modal [data-utility-tab="${name}"]`);
  }

  async openSettings() {
    await this.settingsButton.click();
    await this.utilitiesButton.click();
    await expect(this.utilitiesPage).toBeVisible();
  }

  async diagnosticState() {
    // parity-check: allow-read-only-measurement-evaluate -- capture existing view and computed geometry without mutating production state.
    return this.page.evaluate(() => {
      const selectors = ['#artist-family-panel', '.player-shell', '.player-play-cluster', '#player-play', '#player-time', '#shell-navigation-rail'];
      const nodes = Object.fromEntries(selectors.map(selector => {
        const el = document.querySelector(selector);
        if (!el) return [selector, null];
        const style = getComputedStyle(el), box = el.getBoundingClientRect();
        return [selector, { hidden: el.hidden, classes: el.className, x: box.x, y: box.y, width: box.width, height: box.height,
          display: style.display, opacity: style.opacity, visibility: style.visibility, gridColumns: style.gridTemplateColumns, position: style.position }];
      }));
      return { nodes, url: location.href, selectedArtist: state.view.selected_artist, query: state.view.query,
        activeSurface: galleryMainSurfaceController?.current()?.key, pendingView: state.ui.pendingViewTransition,
        pendingRequest: state.ui.activeViewRequestUrl, searchTimer: Boolean(state.ui.pendingSelectedArtistReconcileTimer) };
    });
  }

  async librarySectionLabelsFit() {
    // parity-check: allow-read-only-measurement-evaluate -- measure the requested single drawer heading.
    return this.artistHeading.evaluate(heading => heading.scrollWidth <= heading.clientWidth);
  }

  async selectColumns(columns) {
    if (![1, 2, 3].includes(columns)) throw new TypeError('Invalid column count');
    await this.zoomButton.click();
    await this.zoomMenu.locator(`[data-mobile-grid-columns="${columns}"]`).click();
    await expect(this.zoomMenu).not.toBeVisible();
  }

  async selectUtility(section) {
    if (!['rules', 'loops', 'log-history', 'appearance', 'integrations'].includes(section)) throw new TypeError('Invalid section');
    await this.settingsSectionsButton.click();
    await this.settingsDrawer.locator(`[data-mobile-settings-choice="${section}"]`).click();
    await expect(this.settingsDrawer).not.toBeVisible();
  }

  async selectSubsection(key) {
    if (!['library', 'lastfm', 'backgrounds', 'seekbar', 'selection-accent', 'alerts', 'album-page'].includes(key)) throw new TypeError('Invalid subsection');
    await this.subsectionButton.click();
    await this.subsectionMenu.locator(`[data-mobile-subsection="${key}"]`).click();
    await expect(this.subsectionMenu).not.toBeVisible();
  }

  async openPassword() {
    await this.settingsButton.click();
    await this.adminLink.click();
    await this.accountNavToggle.click();
    await this.accountLink.click();
    await expect(this.securityHeading).toBeVisible();
  }

  async search(query) {
    if (!(await this.searchInput.isVisible())) await this.searchButton.click();
    await this.searchInput.fill(query);
    await this.searchInput.press('Enter');
    await expect(this.galleryCards.first()).toBeVisible();
  }

  async openAlbumBody(title) {
    const card = this.galleryCards.filter({ has: this.page.getByRole('button', { name: title, exact: true }) });
    await card.locator('.album-meta-row').click();
    await expect(this.trackTable).toBeVisible();
  }

  async playRow(index) { await this.albumRows.nth(index).locator('.album-track-table__title').click(); }

  async scrollRegion(region, delta) {
    const target = region === 'album' ? this.pageOutlet : region === 'cover' ? this.coverBody : this.galleryScroll;
    await target.hover();
    await this.page.mouse.wheel(0, delta);
  }

  async hasNoHorizontalOverflow() {
    // parity-check: allow-read-only-measurement-evaluate -- measure rendered document width without changing application state.
    return this.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  }
}

