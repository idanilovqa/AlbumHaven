export class AlbumTrackTable {
  constructor(root) {
    this.root = root.locator('.album-track-table');
    this.tables = this.root.locator('.compact-data-table');
    this.rows = this.root.locator('.album-track-table__row');
    this.discHeadings = this.root.locator('.album-track-table__disc-heading');
    this.total = this.root.locator('.album-track-table__total');
    this.playButtons = this.root.locator('.album-track-table__play');
    this.problemHeaders = this.tables.locator('.compact-data-table-header [data-cdt-column="problem"][aria-hidden="true"]');
    this.problemCells = this.rows.locator('[data-cdt-column="problem"]');
    this.durationCells = this.rows.locator('[data-cdt-column="duration"]');
    this.secondTableHeaders = this.tables.nth(1).locator('[role="columnheader"]');
    this.discHeadingsInsideTables = this.tables.locator('.album-track-table__disc-heading');
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
}
