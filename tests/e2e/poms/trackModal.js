import { BasePage } from './basePage.js';
import { AlbumTrackTable } from './components/albumTrackTable.js';
import { AppConfirmDialog } from './components/appConfirmDialog.js';

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
    this.discHeaders = this.dialog.locator('.album-track-table__disc-heading');
    this.discTotals = this.dialog.locator('.album-track-table__disc-total');
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
    this.albumTrackTable = new AlbumTrackTable(this.dialog);
    this.header = this.dialog.locator('.album-details-header');
    this.headerActions = this.dialog.locator('.album-details-header__actions .action-button');
    this.missingAlert = this.dialog.locator('[data-on-page-alert="error"]');
    this.removeMissingAlbumButton = this.dialog.locator('[data-remove-missing-album="1"]');
    this.artbox = this.dialog.locator('#track-modal-cover .album-artbox');
    this.missingEditButton = this.dialog.getByRole('button', { name: 'Edit album tags unavailable while album is missing' });
    this.missingFolderButton = this.dialog.getByRole('button', { name: 'Open album folder unavailable while album is missing' });
    this.appConfirmDialog = new AppConfirmDialog(page);
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
    return '#track-modal-cover .album-artbox[data-album-artbox-state="empty"]';
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

  async readStackingCheckpoint(appBar) {
    const modalHandle = await this.dialog.elementHandle();
    const appBarHandle = await appBar.root.elementHandle();
    if (!modalHandle || !appBarHandle) {
      await modalHandle?.dispose();
      await appBarHandle?.dispose();
      throw new Error('Album Details and app bar must both be mounted for stacking inspection.');
    }
    try {
      // parity-check: allow-read-only-measurement-evaluate -- verify real overlay hit testing
      return await this.page.evaluate(({ modal, appBarElement }) => {
        const appBarBounds = appBarElement.getBoundingClientRect();
        const topmost = document.elementFromPoint(
          appBarBounds.left + (appBarBounds.width / 2),
          appBarBounds.top + (appBarBounds.height / 2),
        );
        return {
          modalZIndex: Number(getComputedStyle(modal).zIndex) || 0,
          appBarZIndex: Number(getComputedStyle(appBarElement).zIndex) || 0,
          appBarCoveredByAlbumDetails: Boolean(topmost?.closest('#track-modal')),
        };
      }, { modal: modalHandle, appBarElement: appBarHandle });
    } finally {
      await modalHandle.dispose();
      await appBarHandle.dispose();
    }
  }

  trackTitleAt(index) {
    return this.trackRowAt(index).locator('.album-track-table__title').first();
  }

  trackNumberAt(index) {
    return this.trackRowAt(index).locator('[data-cdt-column="number"]').first();
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
    return this.trackRowAt(index).locator('.album-track-table__secondary').first();
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
      has: this.page.locator('.album-track-table__title').filter({ hasText: exactNormalizedText(trackTitle) }),
    }).first();
  }

  playButtonByTrackTitle(trackTitle) {
    return this.trackRowByTitle(trackTitle).locator('.play-track-button').first();
  }

  async readAlbumTrackTableTotal() {
    return String(await this.albumTrackTable.aggregateTotal.textContent() || '').trim();
  }

  problemButtonByTrackTitle(trackTitle) {
    return this.trackRowByTitle(trackTitle)
      .getByRole('button', { name: 'Open this track in Problematic Files', exact: true });
  }

  problemCellByTrackTitle(trackTitle) {
    return this.trackRowByTitle(trackTitle).locator('[data-cdt-column="problem"]');
  }

  durationCellByTrackTitle(trackTitle) {
    return this.trackRowByTitle(trackTitle).locator('[data-cdt-column="duration"]');
  }

  async readEditorialTableAlignment() {
    const titleHandle = await this.title.elementHandle();
    const tableHandle = await this.albumTrackTable.tables.first().elementHandle();
    if (!titleHandle || !tableHandle) {
      await titleHandle?.dispose();
      await tableHandle?.dispose();
      throw new Error('Expected the Album Details title and track table for alignment measurement.');
    }
    try {
      // parity-check: allow-read-only-measurement-evaluate -- compare real Editorial title and table geometry
      return await this.page.evaluate(({ title, table }) => {
        const titleBounds = title.getBoundingClientRect();
        const tableBounds = table.getBoundingClientRect();
        return {
          titleLeft: titleBounds.left,
          tableLeft: tableBounds.left,
          delta: Math.abs(titleBounds.left - tableBounds.left),
        };
      }, { title: titleHandle, table: tableHandle });
    } finally {
      await titleHandle.dispose();
      await tableHandle.dispose();
    }
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
