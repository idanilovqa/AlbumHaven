export class SmallAlert {
  constructor(root) {
    this.root = root;
    this.icon = root.locator('.small-alert__icon');
    this.text = root.locator('.small-alert__text');
  }
}
