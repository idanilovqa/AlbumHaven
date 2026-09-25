import { expect } from '@playwright/test';
import { MembersPage } from './authPages.js';

export class RoleAssignmentPage extends MembersPage {
  constructor(page) {
    super(page);
    this.roles = page.getByRole('group', { name: 'Roles', exact: true });
    this.additional = page.getByRole('group', { name: 'Additional capabilities', exact: true });
    this.rolesOnly = page.getByRole('button', { name: 'Use selected roles only', exact: true });
    this.error = page.locator('[data-admin-form-error]');
  }

  role(label) { return this.roles.getByRole('checkbox', { name: label, exact: true }); }
  capability(label) { return this.additional.getByRole('checkbox', { name: label, exact: true }); }

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
