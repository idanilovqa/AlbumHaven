import { test, expect } from '../support/baseFixtures.js';
import { enrollCapabilityProfile } from '../actions/capabilityProfileEnrollment.js';

test('FTC-CAP-AUDIT-020 unimplemented Move setting stays disabled through role synchronization and save', async ({ page, freshBrowserSession }) => {
  const { editor } = await enrollCapabilityProfile(page, freshBrowserSession, { roles: ['Viewer'], visible: [] });
  const move = editor.capability('Move music');
  await expect(move).toBeVisible();
  await expect(move).toBeDisabled();
  await expect(move).not.toBeChecked();
  for (const role of ['Listener', 'Musician', 'Owner', 'Admin']) {
    await editor.role(role).check();
    await expect(move).toBeDisabled();
    await expect(move).not.toBeChecked();
  }
  await editor.rolesOnly.click();
  await expect(move).toBeDisabled();
  await expect(move).not.toBeChecked();
  await editor.saveChangedAccess();
  await editor.page.reload();
  await expect(editor.role('Owner')).toBeChecked();
  await expect(move).toBeDisabled();
  await expect(move).not.toBeChecked();
});
