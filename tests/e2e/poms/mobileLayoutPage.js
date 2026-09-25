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
    this.librarySectionButtons = page.locator('[data-mobile-library-mode]');
    this.homeCards = this.home.locator('.album-card');
    this.homeAlbums = this.home.locator('[data-open-tracklist]');
    this.homeGrid = page.locator('.mobile-home-grid');
    this.searchInput = page.locator('#search-input');
    this.searchButton = page.locator('#mobile-search-button');
    this.libraryButton = page.locator('#mobile-library-button');
    this.artistRail = page.locator('#shell-navigation-rail');
    this.closeArtistRail = this.artistRail.locator('[data-close-artists-drawer]');
    this.artistsMode = page.getByRole('button', { name: 'Artists', exact: true });
    this.playlistsMode = page.getByRole('button', { name: 'Playlists', exact: true });
    this.libraryPlaceholder = page.locator('#mobile-library-placeholder');
    this.galleryCards = page.locator('#artist-groups .album-card');
    this.familyButton = page.locator('[data-gallery-bar-action="artist-family"]');
    this.familyPanel = page.locator('#artist-family-panel');
    this.viewCluster = page.locator('#gallery-view-cluster-options');
    this.activeView = this.viewCluster.locator('.is-active');
    this.threeColumnsButton = page.getByRole('button', { name: 'Use three columns' });
    this.twoColumnsButton = page.getByRole('button', { name: 'Use two columns' });
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
    this.securityHeading = page.getByRole('heading', { name: 'Password & security' });
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
    // parity-check: allow-read-only-measurement-evaluate -- measure label clipping in the rendered navigation controls.
    return this.librarySectionButtons.evaluateAll(buttons => buttons.length === 3
      && buttons.every(button => button.scrollWidth <= button.clientWidth));
  }

  async hasNoHorizontalOverflow() {
    // parity-check: allow-read-only-measurement-evaluate -- measure rendered document width without changing application state.
    return this.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  }
}

