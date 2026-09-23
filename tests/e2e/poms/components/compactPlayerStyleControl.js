export class CompactPlayerStyleControl {
  constructor(root) {
    this.root = root;
    this.heading = root.getByRole('heading', { name: 'Compact player' });
    this.buttons = root.locator('button[data-compact-player-style]');
    this.behaviorButtons = root.locator('button[data-docked-compact-player-behavior]');
  }

  button(style) {
    return this.root.locator(`button[data-compact-player-style="${style}"]`);
  }

  behaviorButton(behavior) {
    return this.root.locator(`button[data-docked-compact-player-behavior="${behavior}"]`);
  }
}
