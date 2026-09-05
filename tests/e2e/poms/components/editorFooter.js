import { SharedButton } from './sharedButton.js';

export class EditorFooter {
  constructor(host) {
    this.host = host;
    this.root = host.locator('[data-editor-footer]');
    this.status = this.root.locator('.editor-footer-status');
    this.actions = this.root.locator('.editor-footer-actions');
    this.reset = new SharedButton(this.root.locator('[data-editor-footer-action="reset"]'));
    this.retry = new SharedButton(this.root.locator('[data-editor-footer-action="retry"]'));
    this.secondary = new SharedButton(this.root.locator('[data-editor-footer-action="secondary"]'));
    this.primary = new SharedButton(this.root.locator('[data-editor-footer-action="primary"]'));
  }
}
