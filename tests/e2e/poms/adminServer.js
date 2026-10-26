export class AdminServerPage {
  constructor(page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Album previews' });
    this.form = page.getByRole('form', { name: 'Album previews' });
    this.path = page.locator('[data-preview-path]');
    this.save = page.getByRole('button', { name: 'Save', exact: true });
  }

  mode(value) {
    return this.page.locator(`[data-preview-mode=${JSON.stringify(String(value))}]`);
  }
}
