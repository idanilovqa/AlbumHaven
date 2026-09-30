import { BasePage } from './basePage.js';

// Read-only browser callback, colocated in the owning Settings POM for selectors/DOM ownership.
export function readProblematicSelectionEvidence(selectors) {
  const visible = node => {
    if (!node || typeof node.getBoundingClientRect !== 'function') return false;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)
        || Number(style.opacity || 1) === 0) return false;
      if (current !== node) {
        const bounds = current.getBoundingClientRect();
        if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX)) {
          left = Math.max(left, bounds.left); right = Math.min(right, bounds.right);
        }
        if (['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowY)) {
          top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom);
        }
      }
    }
    return right > left && bottom > top;
  };
  const detail = document.querySelector(selectors.detail);
  const rows = Array.from(detail?.querySelectorAll(selectors.trackRows) || []);
  const selected = typeof getSelectedProblematicAlbum === 'function' ? getSelectedProblematicAlbum() : null;
  const converted = detail?.querySelector(selectors.converted);
  const empty = Array.from(detail?.querySelectorAll('.utility-detail-meta') || []).find(node => (
    /^(Only album-level problems found\. )?No per-track problems/.test(String(node.textContent || '').trim())
  ));
  const path = row => String(row.getAttribute('data-problematic-track-path') || '');
  return {
    activeKey: String(document.querySelector(selectors.active)?.getAttribute('data-problematic-album-key') || ''),
    selectedKey: String(state.utility?.selectedProblematicKey || ''), runtimeKey: String(selected?.key || ''),
    title: String(detail?.querySelector('.utility-detail-title')?.textContent || '').trim(),
    headingVisible: visible(detail?.querySelector('.utility-detail-title')),
    trackPaths: (selected?.tracks || []).map(track => String(track.path || '')),
    renderedPaths: rows.map(path), visibleRenderedPaths: rows.filter(visible).map(path),
    albumReasons: Array.from(detail?.querySelectorAll('[data-album-problem-type]') || []).filter(visible).map(node => String(node.textContent || '').trim()),
    emptyText: empty && visible(empty) ? String(empty.textContent || '').trim() : '',
    convertedText: converted ? String(converted.textContent || '').trim() : '',
    convertedPressed: converted?.getAttribute('aria-pressed') || '',
    query: String(state.utility?.searchQuery || ''), filters: [...(state.utility?.selectedProblemFilters || [])],
  };
}

// Locators and read-only observations for the real shared Settings boundary.
export class SettingsRefactorShell extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    // The same component changes from a desktop dialog to a mobile page region.
    this.dialog = page.locator('#utility-modal > .utility-modal-dialog');
    this.header = this.dialog.locator('.utility-modal-header');
    this.tabs = this.dialog.locator('[data-utility-tab]');
    this.selectedTab = this.dialog.locator('[data-utility-tab][aria-selected="true"]');
    this.close = this.dialog.locator('#utility-modal-close');
    this.body = this.dialog.locator('.utility-modal-body');
    this.tree = this.dialog.locator('#utility-problematic-list');
    this.rows = this.tree.locator('[data-problematic-album-key]');
    this.resultCount = this.dialog.locator('#utility-problematic-count');
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

  rowByKey(key) { return this.tree.locator(`[data-problematic-album-key=${JSON.stringify(String(key))}]`); }
  detailTrackByPath(path) { return this.dialog.locator(`[role="row"][data-cdt-row-key][data-problematic-track-path=${JSON.stringify(String(path))}]`); }

  async readProblemSelectionEvidence() {
    // parity-check: allow-read-only-measurement-evaluate -- compare actual selected data and visibly rendered tracks against immutable observed response evidence
    return this.page.evaluate(readProblematicSelectionEvidence, {
      detail: '#utility-problematic-detail', active: '#utility-problematic-list [aria-current="true"]',
      trackRows: '[role="row"][data-cdt-row-key][data-problematic-track-path]', converted: '[data-toggle-problematic-display-repair]',
    });
  }

  async readProblemVirtualWindow() {
    // parity-check: allow-read-only-measurement-evaluate -- observe mounted identities and native viewport coverage without mutating scroll or application state
    return this.tree.evaluate(list => {
      const horizontal = list.dataset.problematicVirtualAxis === 'horizontal';
      const bounds = list.getBoundingClientRect();
      const rows = Array.from(list.querySelectorAll('[data-problematic-album-key]'));
      const first = rows[0]?.getBoundingClientRect(), last = rows.at(-1)?.getBoundingClientRect();
      const keys = rows.map(row => String(row.getAttribute('data-problematic-album-key') || ''));
      return {
        horizontal, offset: horizontal ? list.scrollLeft : list.scrollTop,
        viewport: horizontal ? list.clientWidth : list.clientHeight,
        extent: horizontal ? list.scrollWidth : list.scrollHeight,
        start: Number(list.dataset.problematicVirtualStart), end: Number(list.dataset.problematicVirtualEnd), keys,
        visibleKeys: rows.filter(row => {
          const rect = row.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.right > bounds.left && rect.left < bounds.right
            && rect.bottom > bounds.top && rect.top < bounds.bottom;
        }).map(row => String(row.getAttribute('data-problematic-album-key') || '')),
        viewportCovered: Boolean(first && last && (horizontal
          ? first.left <= bounds.left + first.width && last.right >= bounds.right - last.width
          : first.top <= bounds.top + first.height && last.bottom >= bounds.bottom - last.height)),
      };
    });
  }

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
