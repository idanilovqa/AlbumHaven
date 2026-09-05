export class NavigationTreeItem {
  constructor(root) {
    this.root = root;
    this.icon = root.locator('.navigation-tree-icon');
    this.label = root.locator('.navigation-tree-label');
    this.count = root.locator('.navigation-tree-count');
  }
}

export class NavigationTree {
  constructor(root) {
    this.root = root;
    this.items = root.locator(this.itemSelector);
    this.selectedItem = root.locator(`${this.itemSelector}.is-selected`);
  }

  get itemSelector() {
    return '[data-navigation-tree-item]';
  }

  itemByKey(key) {
    return new NavigationTreeItem(this.root.locator(
      `${this.itemSelector}[data-navigation-tree-key=${JSON.stringify(String(key))}]`,
    ).first());
  }
}
