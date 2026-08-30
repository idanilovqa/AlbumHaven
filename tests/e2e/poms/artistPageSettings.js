import { BasePage } from './basePage.js';

function exactNormalizedText(value) {
  const escaped = String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped.replace(/\\s+/g, '\\s+')}\\s*$`, 'u');
}

export class ArtistPageSettings extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.button = page.locator(this.buttonSelector);
    this.menu = page.locator(this.menuSelector);
    this.combineSimilarArtistsButton = page.locator(this.combineSimilarArtistsButtonSelector);
    this.nonAlbumTracksButton = page.locator(this.nonAlbumTracksButtonSelector);
    this.nonAlbumTracksCount = this.nonAlbumTracksButton.locator(this.countSelector);
    this.nonAlbumTracksModal = page.locator(this.nonAlbumTracksModalSelector);
    this.nonAlbumTrackRows = page.locator(this.nonAlbumTrackRowSelector);
    this.nonAlbumTrackTitles = page.locator(this.nonAlbumTrackTitleSelector);
    this.nonAlbumTrackSections = this.nonAlbumTracksModal.locator('[data-non-album-section]');
    this.nonAlbumTrackSectionTitles = this.nonAlbumTracksModal.locator('.non-album-track-section-title');
    this.nonAlbumCompactTables = this.nonAlbumTracksModal.getByRole('table');
    this.nonAlbumColumnHeaders = this.nonAlbumTracksModal.getByRole('columnheader');
    this.nonAlbumControlCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="control"]');
    this.nonAlbumTrackCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="track"]');
    this.nonAlbumPathCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="path"]');
    this.nonAlbumExceptionLabels = this.nonAlbumTracksModal.locator('.non-album-type-cell');
    this.nonAlbumDialog = this.nonAlbumTracksModal.getByRole('dialog');
    this.nonAlbumTracksCloseButton = page.locator(this.nonAlbumTracksCloseButtonSelector);
    this.nonAlbumTracksEditTagsButton = this.nonAlbumTracksModal.getByRole('button', {
      name: 'Edit album tags',
      exact: true,
    });
  }

  get buttonSelector() {
    return '#gallery-options-button';
  }

  get menuSelector() {
    return '#gallery-options-menu';
  }

  get combineSimilarArtistsButtonSelector() {
    return '#gallery-options-menu [data-toggle-combine-similar-artists="1"]';
  }

  get nonAlbumTracksButtonSelector() {
    return '#gallery-options-menu [data-open-non-album-modal="1"]';
  }

  get nonAlbumTracksModalSelector() {
    return '#non-album-modal';
  }

  get nonAlbumTrackRowSelector() {
    return '#non-album-modal [data-track-row-path]';
  }

  get nonAlbumTrackTitleSelector() {
    return '#non-album-modal [data-track-row-path] .track-title';
  }

  get nonAlbumTracksCloseButtonSelector() {
    return '#non-album-modal-close';
  }

  get countSelector() {
    return '.gallery-options-count';
  }

  get combineStateCountSelector() {
    return this.countSelector;
  }

  nonAlbumTrackRowByTitle(trackTitle) {
    return this.nonAlbumTrackRows.filter({
      has: this.page.locator('.track-title').filter({
        hasText: exactNormalizedText(trackTitle),
      }),
    });
  }

  nonAlbumTrackArtistByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).locator('.non-album-track-artist');
  }

  nonAlbumTrackPathByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).locator('[data-cdt-column="path"]');
  }

  nonAlbumTrackControlByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).locator('[data-cdt-column="control"]');
  }

  nonAlbumTrackCellByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).locator('[data-cdt-column="track"]');
  }

  nonAlbumPlayButtonByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).getByRole('button', {
      name: `Play ${trackTitle}`,
      exact: true,
    });
  }

  async readNonAlbumDialogWidth() {
    const box = await this.nonAlbumDialog.boundingBox();
    return Number(box?.width || 0);
  }

  async readNonAlbumPlayToTrackGap(trackTitle) {
    const [playButtonBox, trackCellBox] = await Promise.all([
      this.nonAlbumPlayButtonByTitle(trackTitle).boundingBox(),
      this.nonAlbumTrackCellByTitle(trackTitle).boundingBox(),
    ]);
    if (!playButtonBox || !trackCellBox) return null;
    return trackCellBox.x - (playButtonBox.x + playButtonBox.width);
  }

  async readFirstNonAlbumHeaderAlignment() {
    const table = this.nonAlbumCompactTables.first();
    const firstRow = table.getByRole('row').nth(1);
    const [trackHeader, pathHeader, trackCell, pathCell] = await Promise.all([
      table.getByRole('columnheader', { name: 'Track', exact: true }).boundingBox(),
      table.getByRole('columnheader', { name: 'File path', exact: true }).boundingBox(),
      firstRow.locator('[data-cdt-column="track"]').boundingBox(),
      firstRow.locator('[data-cdt-column="path"]').boundingBox(),
    ]);
    if (!trackHeader || !pathHeader || !trackCell || !pathCell) return null;
    return {
      trackOffset: Math.abs(trackHeader.x - trackCell.x),
      pathOffset: Math.abs(pathHeader.x - pathCell.x),
    };
  }

  problemButtonForNonAlbumTrack(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).getByRole('button', {
      name: 'Open this track in Problematic Files',
      exact: true,
    });
  }
}
