import { BasePage } from './basePage.js';

function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

export class TrackModal extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.dialog = page.locator(this.dialogSelector);
    this.loadingRow = page.locator(this.loadingRowSelector);
    this.trackRows = page.locator(this.trackRowSelector);
    this.closeButton = page.locator(this.closeButtonSelector);
    this.title = page.locator(this.titleSelector);
    this.subtitle = page.locator(this.subtitleSelector);
    this.footer = page.locator(this.footerSelector);
    this.discHeaders = this.dialog.locator('.track-disc-header');
    this.discTotals = this.dialog.locator('.track-disc-total');
    this.coverImage = page.locator(this.coverImageSelector);
    this.detailedCoverImage = page.locator(this.detailedCoverImageSelector);
    this.coverPlaceholder = page.locator(this.coverPlaceholderSelector);
    this.playButtons = page.locator(this.playButtonSelector);
    this.problemButtons = this.dialog.getByRole('button', {
      name: 'Open this track in Problematic Files',
      exact: true,
    });
    this.coverLookupButton = page.locator(this.coverLookupButtonSelector);
    this.fastCoverFetchButton = page.locator(this.fastCoverFetchButtonSelector);
    this.releaseTabs = page.locator('#track-modal-tabs [data-track-tab-index]');
    this.editTagsButton = page.getByRole('button', { name: 'Edit album tags', exact: true });
    this.coverLightboxButton = page.locator(this.coverLightboxButtonSelector);
    this.lightbox = page.locator(this.lightboxSelector);
    this.lightboxLoading = page.locator(this.lightboxLoadingSelector);
    this.lightboxImage = page.locator(this.lightboxImageSelector);
    this.lightboxCloseButton = page.locator(this.lightboxCloseButtonSelector);
    this.lightboxPreviousButton = page.locator('#image-lightbox-prev');
    this.lightboxNextButton = page.locator('#image-lightbox-next');
  }

  get dialogSelector() {
    return '#track-modal';
  }

  get loadingRowSelector() {
    return '#track-modal .track-modal-loading-row';
  }

  get trackRowSelector() {
    return '#track-modal [data-track-row-path]';
  }

  get closeButtonSelector() {
    return '#track-modal-close';
  }

  get titleSelector() {
    return '#track-modal-title';
  }

  get subtitleSelector() {
    return '#track-modal-subtitle';
  }

  get footerSelector() {
    return '#track-modal-footer';
  }

  get coverImageSelector() {
    return '#track-modal-cover img';
  }

  get detailedCoverImageSelector() {
    return '#track-modal-cover .track-modal-cover-visual img';
  }

  get coverPlaceholderSelector() {
    return '#track-modal-cover .cover-placeholder';
  }

  get playButtonSelector() {
    return '#track-modal .play-track-button';
  }

  get coverLookupButtonSelector() {
    return '#track-modal [data-open-track-modal-cover-lookup="1"]';
  }

  get fastCoverFetchButtonSelector() {
    return '#track-modal [data-track-modal-fast-cover-fetch="1"]';
  }

  get coverLightboxButtonSelector() {
    return '#track-modal-cover [data-open-lightbox="1"]';
  }

  get lightboxSelector() {
    return '#image-lightbox';
  }

  get lightboxImageSelector() {
    return '#image-lightbox-image';
  }

  get lightboxLoadingSelector() {
    return '#image-lightbox-loading';
  }

  get lightboxCloseButtonSelector() {
    return '#image-lightbox-close';
  }

  get globalPlayerSelector() {
    return '.global-player';
  }

  trackRowAt(index) {
    return this.trackRows.nth(index);
  }

  playButtonAt(index) {
    return this.trackRowAt(index).locator('.play-track-button').first();
  }

  trackTitleAt(index) {
    return this.trackRowAt(index).locator('.track-title').first();
  }

  trackNumberAt(index) {
    return this.trackRowAt(index).locator('.track-number').first();
  }

  async readDisplayedTrackNumbers() {
    const trackCount = await this.trackRows.count();
    return Promise.all(Array.from({ length: trackCount }, async (_, index) => {
      const text = String(await this.trackNumberAt(index).textContent() || '').trim();
      return Number.parseInt(text.replace(/\.$/u, ''), 10);
    }));
  }

  async readReleaseTabLabels() {
    return (await this.releaseTabs.allTextContents())
      .map((label) => String(label || '').trim())
      .filter(Boolean);
  }

  async readFooterLines() {
    const childLines = (await this.footer.locator(':scope > *').allTextContents())
      .map((line) => String(line || '').trim())
      .filter(Boolean);
    if (childLines.length) return childLines;
    const footerText = String(await this.footer.textContent() || '').trim();
    return footerText ? [footerText] : [];
  }

  async readDiscGroupPresentation() {
    const normalize = (values) => values
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    return {
      headers: normalize(await this.discHeaders.allTextContents()),
      totals: normalize(await this.discTotals.allTextContents()),
    };
  }

  secondaryArtistAt(index) {
    return this.trackRowAt(index).locator('.track-artist-name').first();
  }

  async readTrackCreditColorsAt(index) {
    const title = this.trackTitleAt(index);
    const secondaryArtist = this.secondaryArtistAt(index);
    return {
      // parity-check: allow-read-only-measurement-evaluate -- read the rendered track-title color
      title: await title.evaluate((element) => getComputedStyle(element).color),
      // parity-check: allow-read-only-measurement-evaluate -- read the rendered secondary-artist color
      secondaryArtist: await secondaryArtist.evaluate((element) => getComputedStyle(element).color),
    };
  }

  trackRowByTitle(trackTitle) {
    return this.trackRows.filter({
      has: this.page.locator('.track-title').filter({ hasText: exactNormalizedText(trackTitle) }),
    }).first();
  }

  problemButtonByTrackTitle(trackTitle) {
    return this.trackRowByTitle(trackTitle)
      .getByRole('button', { name: 'Open this track in Problematic Files', exact: true });
  }

  async readCoverLightboxSources() {
    return {
      full: String(await this.coverLightboxButton.getAttribute('data-cover-src') || ''),
      preview: String(await this.coverLightboxButton.getAttribute('data-cover-preview-src') || ''),
    };
  }

  async readFullCoverLayerCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- reads viewport/layer geometry and hit-testing only
    return this.lightbox.evaluate((lightbox, expectedPlayerSelector) => {
      const player = document.querySelector(expectedPlayerSelector);
      if (!(player instanceof HTMLElement)) {
        throw new Error('Expected the global player while measuring the full-cover layer.');
      }
      const lightboxBounds = lightbox.getBoundingClientRect();
      const playerBounds = player.getBoundingClientRect();
      const playerCenterX = playerBounds.left + (playerBounds.width / 2);
      const playerCenterY = playerBounds.top + (playerBounds.height / 2);
      const topmost = document.elementFromPoint(playerCenterX, playerCenterY);
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        lightbox: {
          left: lightboxBounds.left,
          top: lightboxBounds.top,
          right: lightboxBounds.right,
          bottom: lightboxBounds.bottom,
          width: lightboxBounds.width,
          height: lightboxBounds.height,
        },
        player: {
          left: playerBounds.left,
          top: playerBounds.top,
          right: playerBounds.right,
          bottom: playerBounds.bottom,
          width: playerBounds.width,
          height: playerBounds.height,
        },
        playerCenterCoveredByLightbox: Boolean(topmost?.closest('#image-lightbox')),
      };
    }, this.globalPlayerSelector);
  }

  async readDetailedCoverImageCheckpoint() {
    // parity-check: allow-read-only-measurement-evaluate -- actual modal image source and intrinsic dimensions only
    return this.detailedCoverImage.evaluate((image) => ({
      complete: image.complete,
      currentSrc: String(image.currentSrc || image.src || ''),
      productionSrc: String(
        image.getAttribute('data-production-cover-src')
        || image.getAttribute('src')
        || '',
      ),
      naturalWidth: Number(image.naturalWidth || 0),
      naturalHeight: Number(image.naturalHeight || 0),
    }));
  }
}
