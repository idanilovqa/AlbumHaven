export class CompactPlayerStyleControl {
  constructor(root) {
    this.root = root;
    this.heading = root.getByRole('heading', { name: 'Compact player' });
    this.buttons = root.locator('button[data-compact-player-style]');
  }

  button(style) {
    return this.root.locator(`button[data-compact-player-style="${style}"]`);
  }
}
