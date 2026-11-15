// Home from the in-library Settings and admin pages (owner, sandbox2).
export class LibraryHomeFromSettings {
  constructor(page) {
    this.page = page;
    this.settingsHost = page.locator('[data-settings-host]:not([hidden])');
    this.homeLogo = page.locator('a.app-bar-brand:visible').first();
    this.searchInput = page.locator('#search-input');
    this.galleryTitle = page.locator('[data-gallery-bar-instance="gallery"] .gallery-bar__title');
    this.albumCards = page.locator('#artist-groups .album-card');
  }

  viewParameters() {
    const url = new URL(this.page.url());
    return { path: url.pathname, query: url.searchParams.get('q'), artist: url.searchParams.get('artist') };
  }
}
