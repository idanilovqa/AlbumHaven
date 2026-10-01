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

// The mobile/current NavigationTree paints selection with its rendered pseudo edge.
export async function readNavigationSelectionPaint(selectedItem) {
  // parity-check: allow-read-only-measurement-evaluate -- observe the selected item and its actual edge, not configured tokens
  return selectedItem.evaluateAll(elements => {
    if (!elements[0]) return null;
    const item = getComputedStyle(elements[0]);
    const accent = getComputedStyle(elements[0], '::before');
    return {
      fill: item.backgroundColor,
      accent: {
        backgroundColor: accent.backgroundColor,
        width: accent.width,
        height: accent.height,
        content: accent.content,
        display: accent.display,
        visibility: accent.visibility,
        opacity: accent.opacity,
        top: accent.top,
        bottom: accent.bottom,
        left: accent.left,
      },
    };
  });
}
