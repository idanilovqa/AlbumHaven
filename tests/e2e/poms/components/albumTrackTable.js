export class AlbumTrackTable {
  constructor(root) {
    this.root = root.locator('.album-track-table');
    this.tables = this.root.locator('.compact-data-table');
    this.rows = this.root.locator('.album-track-table__row');
    this.discHeadings = this.root.locator('.album-track-table__disc-heading');
    this.total = this.root.locator('.album-track-table__total');
    this.aggregateTotal = this.total.locator('.album-track-table__aggregate-total');
    this.mainTotal = this.total.locator('.album-track-table__main-total');
    this.bonusTotal = this.total.locator('.album-track-table__bonus-total');
    this.playButtons = this.root.locator('.album-track-table__play');
    this.problemHeaders = this.tables.locator('.compact-data-table-header [data-cdt-column="problem"][aria-hidden="true"]');
    this.problemCells = this.rows.locator('[data-cdt-column="problem"]');
    this.durationCells = this.rows.locator('[data-cdt-column="duration"]');
    this.secondTableHeaders = this.tables.nth(1).locator('[role="columnheader"]');
    this.discHeadingsInsideTables = this.tables.locator('.album-track-table__disc-heading');
  }

  async readPlayingSpectra(rowIndex = 0) {
    // parity-check: allow-read-only-measurement-evaluate -- inspect both rendered spectra without changing playback or preferences
    return this.rows.nth(rowIndex).evaluate((row) => ['::before', '::after'].map((pseudo) => {
      const style = getComputedStyle(row, pseudo);
      return { animation: style.animationName, display: style.display, opacity: style.opacity };
    }));
  }

  async readFinalEdgeHandoff() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the rendered final-table edge and footer border
    return this.tables.last().evaluate((table) => {
      const root = table.closest('.album-track-table');
      const total = root?.querySelector('.album-track-table__total');
      if (!(total instanceof HTMLElement)) throw new Error('Expected an AlbumTrackTable total footer.');
      const edge = getComputedStyle(table, '::after');
      const footer = getComputedStyle(total);
      return {
        edgeWidth: edge.width,
        edgeRight: edge.right,
        edgeBackground: edge.backgroundImage,
        footerBorderRightWidth: footer.borderRightWidth,
        footerCornerLayer: getComputedStyle(total, '::after').content,
      };
    });
  }

  async readRunningAnimationCount(rowIndex = 0) {
    // parity-check: allow-read-only-measurement-evaluate -- measure running animations on the real playing row and its pseudo-elements
    return this.rows.nth(rowIndex).evaluate((row) => row.getAnimations({ subtree: true })
      .filter((animation) => animation.playState === 'running').length);
  }
}
