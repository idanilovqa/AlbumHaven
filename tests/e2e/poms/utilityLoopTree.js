import { BasePage } from './basePage.js';

export class UtilityLoopTree extends BasePage {
  constructor(page, testInfo = null) {
    super(page, testInfo);
    this.groupButtons = page.locator('.utility-loop-group-list-item');
    this.childButtons = page.locator('[data-utility-loop-id]');
    this.expandedToggles = page.locator('[data-utility-loop-collapse][aria-expanded="true"]');
    this.trees = page.locator(this.treeSelector);
    this.emptyState = page.locator('#utility-problematic-list .utility-empty-state');
  }

  groupButtonByTitle(title) {
    return this.page.locator('.utility-loop-group-list-item').filter({
      has: this.page.locator('.utility-list-item-title').filter({ hasText: title }),
    }).first();
  }

  titleForGroup(groupButton) {
    return groupButton.locator('.utility-list-item-title');
  }

  metaForGroup(groupButton) {
    return groupButton.locator('.utility-list-item-meta');
  }

  countForGroup(groupButton) {
    return groupButton.locator('.navigation-tree-count');
  }

  collapseToggleForGroup(groupButton) {
    return groupButton.locator('[data-utility-loop-collapse]');
  }

  async isRetainedSelectedSong(handle) {
    // parity-check: allow-read-only-measurement-evaluate -- artwork must retain the selected mounted song node
    return handle.evaluate(node => node.isConnected && node.getAttribute('aria-current') === 'true');
  }

  async readSongChildOrder(songKey) {
    // parity-check: allow-read-only-measurement-evaluate -- read the rendered song tree order only
    return this.trees.evaluateAll((trees, key) => {
      const tree = trees.find(node => node.getAttribute('data-utility-loop-tree') === key);
      return Array.from(tree?.querySelectorAll('[data-utility-loop-id]') || [], node => node.getAttribute('data-utility-loop-id'));
    }, songKey);
  }

  get treeSelector() {
    return '[data-utility-loop-tree]';
  }
}
