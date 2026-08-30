import { BasePage } from './basePage.js';

function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

export class AlbumCard extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.cards = page.locator(this.cardSelector);
    this.detailsButtons = page.locator(this.detailsButtonSelector);
    this.coverImages = page.locator(this.coverImageSelector);
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
    return '.album-year';
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
        hasText: exactNormalizedText(String(year)),
      }),
    });
  }

  coverImageByAlbumName(albumName) {
    return this.page.locator('#artist-groups .album-card:visible').filter({
      has: this.page.locator(this.titleButtonSelector).filter({ hasText: exactNormalizedText(albumName) }),
    }).locator(this.coverImageWithinCardSelector).first();
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
    const card = this.cardByIdentity(artistName, albumName, year, { visible: true });
    const matchingCount = await card.count();
    if (matchingCount !== 1) {
      throw new Error(
        `Expected one visible album card for ${artistName} / ${albumName} / ${year}, found ${matchingCount}.`,
      );
    }
    await card.locator(this.detailsButtonWithinCardSelector).click();
  }

  async readRequestKeyByIdentity(artistName, albumName, year) {
    const card = this.cardByIdentity(artistName, albumName, year, { visible: true });
    const matchingCount = await card.count();
    if (matchingCount !== 1) {
      throw new Error(
        `Expected one visible album card for ${artistName} / ${albumName} / ${year}, found ${matchingCount}.`,
      );
    }
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
    const expectedTitle = [artistName, albumName, year]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' - ');
    await this.page.locator(this.trackModalSelector).waitFor({ state: 'visible', timeout });
    await this.page.locator(this.trackModalTitleSelector).filter({
      hasText: exactNormalizedText(expectedTitle),
    }).waitFor({ state: 'visible', timeout });
    await this.page.locator(this.trackModalTrackRowSelector).first().waitFor({
      state: 'visible',
      timeout,
    });
  }

  async isOpenDetailsIdentity(artistName, albumName, year) {
    const expectedTitle = [artistName, albumName, year]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' - ');
    if (!await this.page.locator(this.trackModalSelector).isVisible()) return false;
    return this.page.locator(this.trackModalTitleSelector).filter({
      hasText: exactNormalizedText(expectedTitle),
    }).isVisible();
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
