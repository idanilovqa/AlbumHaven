const { expect } = require('@playwright/test');

/** Selectors and user interactions for the shared responsive application shell. */
class MobileLayoutPage {
  constructor(page) {
    this.page = page;
    this.loginForm = page.getByRole('form', { name: 'Album Haven sign in' });
    this.username = page.getByLabel('Username');
    this.password = page.getByLabel('Password', { exact: true });
    this.signInButton = page.getByRole('button', { name: 'Sign in', exact: true });
    this.appShell = page.locator('#app-shell');
    this.home = page.locator('#mobile-home');
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

  async hasNoHorizontalOverflow() {
    // parity-check: allow-read-only-measurement-evaluate -- measure rendered document width without changing application state.
    return this.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  }
}

module.exports = { MobileLayoutPage };
