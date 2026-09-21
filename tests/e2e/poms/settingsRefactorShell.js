import { BasePage } from './basePage.js';

// Locators and read-only observations for the real shared Settings boundary.
export class SettingsRefactorShell extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    this.header = this.dialog.locator('.utility-modal-header');
    this.tabs = this.dialog.locator('[data-utility-tab]');
    this.selectedTab = this.dialog.locator('[data-utility-tab][aria-selected="true"]');
    this.close = this.dialog.locator('#utility-modal-close');
    this.body = this.dialog.locator('.utility-modal-body');
    this.tree = this.dialog.locator('#utility-problematic-list');
    this.rows = this.tree.locator('[data-problematic-album-key]');
    this.search = this.dialog.locator('#utility-problematic-search');
    this.filters = this.dialog.locator('#utility-problem-filter-button');
    this.filterIcon = this.filters.locator('svg');
    this.periodDialog = page.getByRole('dialog', { name: 'Date range', exact: true });
    this.filterMenu = this.dialog.locator('#utility-problem-filter-menu');
    this.filterOptions = this.filterMenu.locator('[data-problem-filter-value]');
    this.heading = this.dialog.locator('#utility-problematic-detail .utility-detail-title').first();
    this.headerArt = this.dialog.locator('#utility-problematic-detail .utility-detail-header .album-artbox').first();
    this.enlarge = this.dialog.locator('#utility-problematic-detail .utility-artbox-trigger').first();
    this.lightbox = page.locator('#image-lightbox');
    this.lightboxImage = page.locator('#image-lightbox-image');
    this.lightboxClose = page.getByRole('button', { name: 'Close full-screen cover', exact: true });
  }

  tab(key) { return this.dialog.locator(`[data-utility-tab="${key}"]`); }
  rowTitle(row) { return row.locator('.utility-list-item-title'); }
  rowMeta(row) { return row.locator('.utility-list-item-meta'); }
  rowCount(row) { return row.locator('.navigation-tree-count'); }
  rowArt(row) { return row.locator('.album-artbox'); }
  artworkRows(state) { return this.rows.filter({ has: this.page.locator(`[data-album-artbox-state="${state}"]`) }); }
  filter(value) { return this.filterOptions.filter({ hasText: value }); }
  activeRow() { return this.tree.locator('[data-problematic-album-key][aria-current="true"]'); }

  async imageLoaded(image) {
    // parity-check: allow-read-only-measurement-evaluate -- require decoded real image bytes rather than a placeholder
    return image.evaluate(node => node.complete && node.naturalWidth > 0);
  }

  async geometry() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect joined header geometry and actual pointer hit ownership
    return this.dialog.evaluate(dialog => {
      const rect = node => { const { left, right, top, bottom, width, height } = node.getBoundingClientRect(); return { left, right, top, bottom, width, height }; };
      const header = dialog.querySelector('.utility-modal-header');
      const tab = header.querySelector('[aria-selected="true"]');
      const close = header.querySelector('#utility-modal-close');
      const active = rect(tab), headerBounds = rect(header), closeBounds = rect(close);
      const style = getComputedStyle(header);
      return {
        dialog: rect(dialog), active, header: headerBounds, close: closeBounds,
        joinedLeft: parseFloat(style.getPropertyValue('--active-tab-left')),
        joinedRight: parseFloat(style.getPropertyValue('--active-tab-right')),
        closeOwnsHit: close.contains(document.elementFromPoint((closeBounds.left + closeBounds.right) / 2, (closeBounds.top + closeBounds.bottom) / 2)),
        tabOwnsHit: tab.contains(document.elementFromPoint((active.left + active.right) / 2, (active.top + active.bottom) / 2)),
      };
    });
  }

  async filterGeometry() {
    // parity-check: allow-read-only-measurement-evaluate -- observe actual anchored dropdown and viewport bounds after resize
    return this.filterMenu.evaluate(menu => {
      const rect = node => { const { left, right, top, bottom } = node.getBoundingClientRect(); return { left, right, top, bottom }; };
      return { menu: rect(menu), dialog: rect(menu.closest('.utility-modal-dialog')), anchor: rect(document.getElementById('utility-problem-filter-button')), viewport: { width: innerWidth, height: innerHeight } };
    });
  }

  async retainTree(row) {
    const tree = await this.tree.elementHandle();
    const item = await row.elementHandle();
    // parity-check: allow-read-only-measurement-evaluate -- capture the real scroller before selection
    const scrollTop = await tree.evaluate(node => node.scrollTop);
    return {
      read: async () => {
        // parity-check: allow-read-only-measurement-evaluate -- compare retained nodes, native focus and scroll without mutating application state
        return this.page.evaluate(({ tree, item, scrollTop }) => ({
          treeRetained: tree.isConnected && tree === document.getElementById('utility-problematic-list'),
          rowRetained: item.isConnected && tree.contains(item),
          focused: document.activeElement === item,
          scrollDelta: tree.scrollTop - scrollTop,
          scrollTop: tree.scrollTop,
          visible: item.getBoundingClientRect().top >= tree.getBoundingClientRect().top - 1 && item.getBoundingClientRect().bottom <= tree.getBoundingClientRect().bottom + 1,
        }), { tree, item, scrollTop });
      },
      dispose: async () => { await tree.dispose(); await item.dispose(); },
    };
  }
}
