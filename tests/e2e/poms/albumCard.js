import { BasePage } from './basePage.js';
import { SmallAlert } from './components/smallAlert.js';

function normalizedTextPattern(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(/\\s+/g, '\\s+');
}

function exactNormalizedText(value) {
  return new RegExp(`^\\s*${normalizedTextPattern(value)}\\s*$`, 'u');
}

function normalizeVisibleText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export class AlbumCard extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.cards = page.locator(this.cardSelector);
    this.detailsButtons = page.locator(this.detailsButtonSelector);
    this.coverImages = page.locator(this.coverImageSelector);
    this.visibleCoverPlaceholders = page.locator(`${this.cardSelector} ${this.coverPlaceholderWithinCardSelector}:visible`);
    this.visibleTitles = page.locator(`${this.cardSelector}:visible ${this.titleButtonSelector}`);
  }

  get cardSelector() {
    return '#artist-groups .album-card';
  }

  get detailsButtonSelector() {
    return '#artist-groups [data-open-tracklist="1"]';
  }

  get titleButtonSelector() {
    return '.album-title-button';
  }

  get detailsButtonWithinCardSelector() {
    return '.album-title-button[data-open-tracklist="1"]';
  }

  get coverImageSelector() {
    return '#artist-groups .album-card .cover img';
  }

  get trackModalSelector() {
    return '#track-modal';
  }

  get trackModalTitleSelector() {
    return '#track-modal-title';
  }

  get trackModalTrackRowSelector() {
    return '#track-modal [data-track-row-path]';
  }

  get coverImageWithinCardSelector() {
    return '.cover img';
  }

  get coverPlaceholderWithinCardSelector() {
    return '.cover-placeholder';
  }

  get subtitleWithinCardSelector() {
    return '.album-subtitle';
  }

  get trackCountWithinCardSelector() {
    return '.track-count';
  }

  get yearWithinCardSelector() {
    return '.album-subtitle';
  }

  get ratingRowWithinCardSelector() {
    return '.rating-row';
  }

  get ratingStarsWithinCardSelector() {
    return '.rating-row .stars';
  }

  get ratingStarsWithinRowSelector() {
    return '.stars';
  }

  get ratingTextWithinCardSelector() {
    return '.rating-row .rating-text';
  }

  get ratingTextWithinRowSelector() {
    return '.rating-text';
  }

  get ratingStarWithinCardSelector() {
    return '.rating-row .stars .star';
  }

  get ratingStarWithinRowSelector() {
    return '.stars .star';
  }

  get ratingFilledStarWithinCardSelector() {
    return '.rating-row .stars .star.filled';
  }

  get ratingEmptyStarWithinCardSelector() {
    return '.rating-row .stars .star:not(.filled)';
  }

  cardAt(index) {
    return this.cards.nth(index);
  }

  detailsButtonAt(index) {
    return this.detailsButtons.nth(index);
  }

  cardByAlbumName(albumName) {
    return this.cards.filter({
      has: this.page.locator(this.titleButtonSelector).filter({ hasText: exactNormalizedText(albumName) }),
    });
  }

  cardByArtistAndAlbum(artistName, albumName) {
    return this.cardsByArtistAndAlbum(artistName, albumName).first();
  }

  cardsByArtistAndAlbum(artistName, albumName, options = {}) {
    return this.page.locator('#artist-groups .artist-section').filter({
      has: this.page.locator('.artist-name').filter({ hasText: exactNormalizedText(artistName) }),
    }).first().locator(options.visible ? '.album-card:visible' : '.album-card').filter({
      has: this.page.locator(this.titleButtonSelector).filter({ hasText: exactNormalizedText(albumName) }),
    });
  }

  cardByIdentity(artistName, albumName, year, options = {}) {
    return this.cardsByArtistAndAlbum(artistName, albumName, options).filter({
      has: this.page.locator(this.yearWithinCardSelector).filter({
        hasText: new RegExp(`(?:^| · )${String(year).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'u'),
      }),
    });
  }

  coverImageByAlbumName(albumName) {
    return this.page.locator('#artist-groups .album-card:visible').filter({
      has: this.page.locator(this.titleButtonSelector).filter({ hasText: exactNormalizedText(albumName) }),
    }).locator(this.coverImageWithinCardSelector).first();
  }

  coverPlaceholderByAlbumName(albumName) {
    return this.page.locator('#artist-groups .album-card:visible').filter({
      has: this.page.locator(this.titleButtonSelector).filter({ hasText: exactNormalizedText(albumName) }),
    }).locator(this.coverPlaceholderWithinCardSelector).first();
  }

  artboxByAlbumName(albumName) {
    return this.cardByAlbumName(albumName).locator('.album-artbox').first();
  }

  emptyArtboxMarkByAlbumName(albumName) {
    return this.artboxByAlbumName(albumName).locator('.album-artbox__missing-mark svg');
  }

  missingAlertByAlbumName(albumName) {
    return new SmallAlert(this.cardByAlbumName(albumName).locator('[data-small-alert="error"]').first());
  }

  async readCoverPlaceholderAppearance(albumName) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect a real coverless card's palette treatment
    return this.coverPlaceholderByAlbumName(albumName).evaluate((placeholder) => {
      const style = getComputedStyle(placeholder);
      return {
        backgroundImage: style.backgroundImage,
        borderColor: style.borderColor,
        color: style.color,
      };
    });
  }

  async readAlbumArtboxAppearance(albumName) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the shared AlbumArtbox empty-state treatment
    return this.artboxByAlbumName(albumName).evaluate((artbox) => {
      const style = getComputedStyle(artbox);
      const bounds = artbox.getBoundingClientRect();
      return {
        state: artbox.getAttribute('data-album-artbox-state'),
        backgroundImage: style.backgroundImage,
        color: style.color,
        width: bounds.width,
        height: bounds.height,
        missingMarkVisible: Boolean(
          artbox.querySelector('.album-artbox__missing-mark')?.getClientRects().length,
        ),
      };
    });
  }

  async readFirstVisibleCoverPlaceholderAppearance() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect a rendered coverless card's palette treatment
    return this.visibleCoverPlaceholders.first().evaluate((placeholder) => {
      const style = getComputedStyle(placeholder);
      const card = placeholder.closest('.album-card');
      return {
        album: String(card?.querySelector('.album-title-button')?.textContent || '').trim(),
        backgroundImage: style.backgroundImage,
        borderColor: style.borderColor,
        color: style.color,
      };
    });
  }

  visibleDetailsButtonByAlbumName(albumName) {
    return this.page.locator('#artist-groups .album-card:visible').filter({
      has: this.page.locator(this.titleButtonSelector).filter({ hasText: exactNormalizedText(albumName) }),
    }).locator(this.detailsButtonWithinCardSelector).first();
  }

  detailsButtonByArtistAndAlbum(artistName, albumName) {
    return this.cardsByArtistAndAlbum(artistName, albumName, { visible: true })
      .locator(this.detailsButtonWithinCardSelector)
      .first();
  }

  async clickDetailsByIdentity(artistName, albumName, year) {
    const card = this.cardByIdentity(artistName, albumName, year);
    await card.locator(this.detailsButtonWithinCardSelector).click();
  }

  async readRequestKeyByIdentity(artistName, albumName, year) {
    const card = this.cardByIdentity(artistName, albumName, year);
    const requestKey = String(
      await card.locator(this.detailsButtonWithinCardSelector).getAttribute('data-album-key') || '',
    ).trim();
    if (!requestKey) {
      throw new Error(`Album card ${artistName} / ${albumName} / ${year} has no request key.`);
    }
    return requestKey;
  }

  async waitForOpenDetailsIdentity(artistName, albumName, year, options = {}) {
    const timeout = options.timeout || 30000;
    await this.page.locator(this.trackModalSelector).waitFor({ state: 'visible', timeout });
    await this.page.locator(this.trackModalTrackRowSelector).first().waitFor({
      state: 'visible',
      timeout,
    });
    await this.waitForOpenDetailsHeaderIdentity(artistName, albumName, year, { timeout });
  }

  async readOpenDetailsHeaderIdentity() {
    const header = this.page.locator('#track-modal .album-details-header');
    const layout = String(await header.getAttribute('data-album-details-layout') || '').trim();
    const title = normalizeVisibleText(await this.page.locator(this.trackModalTitleSelector).textContent());
    const subtitle = normalizeVisibleText(await this.page.locator('#track-modal-subtitle').textContent());
    return { layout, title, subtitle };
  }

  async waitForOpenDetailsHeaderIdentity(artistName, albumName, year, options = {}) {
    const timeout = options.timeout || 30000;
    const artist = normalizeVisibleText(artistName);
    const album = normalizeVisibleText(albumName);
    const normalizedYear = normalizeVisibleText(year);
    const header = this.page.locator('#track-modal .album-details-header');
    await header.waitFor({ state: 'visible', timeout });
    const layout = String(await header.getAttribute('data-album-details-layout') || '').trim();
    const title = layout === 'editorial_canvas'
      ? album
      : [artist, album, ...(layout === 'classic_bar' ? [normalizedYear] : [])].join(' • ');
    await this.page.locator(this.trackModalTitleSelector).filter({
      hasText: exactNormalizedText(title),
    }).waitFor({ state: 'visible', timeout });
    if (layout !== 'classic_bar') {
      await this.page.locator('#track-modal-subtitle').filter({
        hasText: new RegExp(
          layout === 'editorial_canvas'
            ? `^\\s*${normalizedTextPattern(artist)}\\s*•\\s*${normalizedTextPattern(normalizedYear)}(?:\\s*•|\\s*$)`
            : `^\\s*${normalizedTextPattern(normalizedYear)}(?:\\s*•|\\s*$)`,
          'u',
        ),
      }).waitFor({ state: 'visible', timeout });
    }
  }

  async isOpenDetailsIdentity(artistName, albumName, year) {
    if (!await this.page.locator(this.trackModalSelector).isVisible()) return false;
    const artist = normalizeVisibleText(artistName);
    const album = normalizeVisibleText(albumName);
    const normalizedYear = normalizeVisibleText(year);
    const { layout, title, subtitle } = await this.readOpenDetailsHeaderIdentity();
    if (layout === 'classic_bar') {
      return title === `${artist} • ${album} • ${normalizedYear}`
        || title === `${artist} - ${album} - ${normalizedYear}`;
    }
    if (layout === 'stacked_bar') {
      return title === `${artist} • ${album}`
        && (subtitle === normalizedYear || subtitle.startsWith(`${normalizedYear}•`));
    }
    if (layout === 'editorial_canvas') {
      return title === album
        && (subtitle === `${artist}•${normalizedYear}`
          || subtitle.startsWith(`${artist}•${normalizedYear}•`));
    }
    return false;
  }

  detailsButtonByAlbumName(albumName) {
    return this.cardByAlbumName(albumName).locator(this.detailsButtonWithinCardSelector);
  }

  subtitleByAlbumName(albumName) {
    return this.cardByAlbumName(albumName).locator(this.subtitleWithinCardSelector).first();
  }

  trackCountByAlbumName(albumName) {
    return this.cardByAlbumName(albumName).locator(this.trackCountWithinCardSelector).first();
  }

  yearByAlbumName(albumName) {
    return this.cardByAlbumName(albumName).locator(this.yearWithinCardSelector).first();
  }

  ratingRowByArtistAndAlbum(artistName, albumName) {
    return this.cardByArtistAndAlbum(artistName, albumName, { visible: true })
      .locator(this.ratingRowWithinCardSelector);
  }

  ratingStarsByArtistAndAlbum(artistName, albumName) {
    return this.cardByArtistAndAlbum(artistName, albumName, { visible: true })
      .locator(this.ratingStarsWithinCardSelector);
  }

  ratingTextByArtistAndAlbum(artistName, albumName) {
    return this.cardByArtistAndAlbum(artistName, albumName, { visible: true })
      .locator(this.ratingTextWithinCardSelector);
  }

  ratingStarPositionsByArtistAndAlbum(artistName, albumName) {
    return this.cardByArtistAndAlbum(artistName, albumName, { visible: true })
      .locator(this.ratingStarWithinCardSelector);
  }

  ratingFilledStarsByArtistAndAlbum(artistName, albumName) {
    return this.cardByArtistAndAlbum(artistName, albumName, { visible: true })
      .locator(this.ratingFilledStarWithinCardSelector);
  }

  ratingEmptyStarsByArtistAndAlbum(artistName, albumName) {
    return this.cardByArtistAndAlbum(artistName, albumName, { visible: true })
      .locator(this.ratingEmptyStarWithinCardSelector);
  }
}
