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
    this.familyToggle = page.locator('[data-gallery-bar-action="artist-family"]');
    this.familyPanel = page.locator('#artist-family-panel');
    this.combineSimilarArtistsButton = page.locator(this.combineSimilarArtistsButtonSelector);
    this.nonAlbumTracksButton = page.locator(this.nonAlbumTracksButtonSelector);
    this.nonAlbumTracksModal = page.locator(this.nonAlbumTracksModalSelector);
    this.nonAlbumTrackRows = page.locator(this.nonAlbumTrackRowSelector);
    this.nonAlbumTrackTitles = page.locator(this.nonAlbumTrackTitleSelector);
    this.nonAlbumTrackSections = this.nonAlbumTracksModal.locator('.album-track-table__disc');
    this.nonAlbumTrackSectionTitles = this.nonAlbumTracksModal.locator('.album-track-table__disc-heading');
    this.nonAlbumTrackTable = this.nonAlbumTracksModal.locator('.album-track-table');
    this.nonAlbumTrackTotal = this.nonAlbumTracksModal.locator('.album-track-table__total');
    this.nonAlbumCompactTables = this.nonAlbumTracksModal.getByRole('table');
    this.nonAlbumColumnHeaders = this.nonAlbumTracksModal.getByRole('columnheader');
    this.nonAlbumPlayCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="number"] .album-track-table__play');
    this.nonAlbumNumberCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="number"]');
    this.nonAlbumTrackCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="title"]');
    this.nonAlbumPathCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="path"]');
    this.nonAlbumProblemCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="problem"]');
    this.nonAlbumDurationCells = this.nonAlbumTracksModal.locator('.compact-data-table-row [data-cdt-column="duration"]');
    this.nonAlbumHeader = this.nonAlbumTracksModal.locator('.album-details-header');
    this.nonAlbumHeaderActions = this.nonAlbumHeader.locator('.album-details-header__action');
    this.nonAlbumHeaderFolderActions = this.nonAlbumHeader.locator('.album-details-header__action-icon--folder');
    this.nonAlbumDialog = this.nonAlbumTracksModal.getByRole('dialog');
    this.nonAlbumTracksCloseButton = page.locator(this.nonAlbumTracksCloseButtonSelector);
    this.nonAlbumTracksEditTagsButton = this.nonAlbumTracksModal.getByRole('button', {
      name: 'Edit tags',
      exact: true,
    });
  }

  get buttonSelector() {
    return '[data-gallery-bar-action="album-types"]';
  }

  get menuSelector() {
    return '#gallery-album-types-menu';
  }

  get combineSimilarArtistsButtonSelector() {
    return '#artist-family-panel [data-toggle-combine-similar-artists="1"]';
  }

  get nonAlbumTracksButtonSelector() {
    return '#gallery-album-types-menu [data-open-non-album-tracks="1"]';
  }

  get nonAlbumTracksModalSelector() {
    return '#non-album-modal';
  }

  get nonAlbumTrackRowSelector() {
    return '#non-album-modal [data-track-row-path]';
  }

  get nonAlbumTrackTitleSelector() {
    return '#non-album-modal [data-track-row-path] .album-track-table__title';
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
      has: this.page.locator('.album-track-table__title').filter({
        hasText: new RegExp(`^\\s*${String(trackTitle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'),
      }),
    });
  }

  nonAlbumTrackArtistByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).locator('.album-track-table__secondary');
  }

  nonAlbumTrackPathByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).locator('[data-cdt-column="path"]');
  }

  nonAlbumTrackNumberByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).locator('[data-cdt-column="number"]');
  }

  nonAlbumTrackCellByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).locator('[data-cdt-column="title"]');
  }

  nonAlbumPlayButtonByTitle(trackTitle) {
    return this.nonAlbumTrackRowByTitle(trackTitle).getByRole('button', {
      name: 'Play track',
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
      firstRow.locator('[data-cdt-column="title"]').boundingBox(),
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
