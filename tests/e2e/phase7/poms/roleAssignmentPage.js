import { expect } from '@playwright/test';
import { CapabilityEditorPage } from './capabilityEditorPage.js';

export class RoleAssignmentPage extends CapabilityEditorPage {
  constructor(page) {
    super(page);
    this.error = page.locator('[data-admin-form-error]');
  }

  async setRolesOnly(labels) {
    for (const label of ['Viewer', 'Listener', 'Musician', 'Owner', 'Admin']) {
      await this.role(label).setChecked(labels.includes(label));
    }
    await this.rolesOnly.click();
  }

  async expectRoles(labels) {
    for (const label of ['Viewer', 'Listener', 'Musician', 'Owner', 'Admin']) {
      await expect(this.role(label)).toBeChecked({ checked: labels.includes(label) });
    }
  }

  async expectRosterRole(username, label) {
    const row = this.page.getByRole('row').filter({
      has: this.page.getByText(username, { exact: true }),
    });
    await expect(row.locator('[data-label="Role / access"]')).toContainText(label);
  }

  async expectDeniedSave() {
    await this.saveChanges.click();
    await expect(this.error).toBeVisible();
    await expect(this.error).toContainText('Action not permitted.');
  }
}
