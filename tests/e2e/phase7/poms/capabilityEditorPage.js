import { expect } from '@playwright/test';
import { MembersPage } from './authPages.js';

export class CapabilityEditorPage extends MembersPage {
  constructor(page) {
    super(page);
    this.capabilities = page.getByRole('group', { name: 'Capabilities', exact: true });
    this.rolesOnly = page.getByRole('button', { name: 'Use selected roles only', exact: true });
    this.revision = page.locator('[name="access_revision"]');
  }

  capability(label) { return this.capabilities.getByRole('checkbox', { name: label, exact: true }); }
  role(label) { return this.roles.getByRole('checkbox', { name: label, exact: true }); }

  async chooseIndividualCapabilities(labels) {
    await this.role('Viewer').check();
    await this.rolesOnly.click();
    for (const role of ['Viewer', 'Listener', 'Musician', 'Owner', 'Admin']) {
      await this.role(role).uncheck();
    }
    for (const label of labels) await this.capability(label).check();
  }

  async expectRequired(label, requiredBy) {
    await expect(this.capability(label)).toBeChecked();
    await expect(this.capability(label)).toBeDisabled();
    await expect(this.capability(label)).toHaveAttribute('title', `Required by ${requiredBy}`);
  }

  async saveChangedAccess() {
    const previous = await this.revision.inputValue();
    await this.saveWithoutLeaving();
    await expect(this.revision).not.toHaveValue(previous);
    await expect(this.revision).toHaveValue(/^[a-f0-9]{64}$/);
  }
}
