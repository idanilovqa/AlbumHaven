export class AppConfirmDialog {
  constructor(page) {
    this.overlay = page.locator('#app-confirm-modal');
    this.dialog = this.overlay.getByRole('dialog');
    this.title = this.overlay.locator('#app-confirm-title');
    this.message = this.overlay.locator('#app-confirm-text');
    this.cancelButton = this.overlay.locator('#app-confirm-cancel');
    this.acceptButton = this.overlay.locator('#app-confirm-accept');
  }

  async readStackingCheckpoint(underlyingModal) {
    // parity-check: allow-read-only-measurement-evaluate -- shared dialog owns its foreground evidence
    return this.dialog.evaluate((dialog, underlyingSelector) => {
      const overlay = dialog.closest('#app-confirm-modal');
      const underlying = document.querySelector(underlyingSelector);
      const bounds = dialog.getBoundingClientRect();
      const topmost = document.elementFromPoint(
        bounds.left + (bounds.width / 2),
        bounds.top + (bounds.height / 2),
      );
      return {
        confirmationZIndex: Number(getComputedStyle(overlay).zIndex) || 0,
        underlyingZIndex: Number(getComputedStyle(underlying).zIndex) || 0,
        confirmationOwnsTopElement: Boolean(topmost?.closest('#app-confirm-modal')),
      };
    }, underlyingModal);
  }
}
