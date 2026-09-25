import { OWNER, signIn } from '../actions/authActions.js';
import { createRoleMember } from '../actions/roleAssignmentActions.js';
import { RoleAssignmentPage } from '../poms/roleAssignmentPage.js';
import { test, expect } from '../support/baseFixtures.js';

const ADMIN = Object.freeze({ username: 'roles.admin', email: 'roles.admin@example.test',
  password: 'Cobalt Orchard 47! Glass River' });
const MEMBER = Object.freeze({ username: 'roles.member', email: 'roles.member@example.test',
  password: 'Amber Orchard 68! Silent Moon' });

test('FTC-CAP-AUDIT-007 delegated Admin assigns independent roles and individual capabilities', async ({ page, freshBrowserSession }) => {
  await signIn(page, OWNER, '/admin/members');
  const adminPage = await createRoleMember(page, freshBrowserSession, ADMIN, ['Admin']);
  const memberPage = await createRoleMember(adminPage, freshBrowserSession, MEMBER, ['Musician']);
  const access = new RoleAssignmentPage(adminPage);
  await access.openEditUser(MEMBER.username);
  await access.expectRoles(['Musician']);
  await expect(access.capability('Play')).toBeChecked();
  await expect(access.capability('Play')).toBeDisabled();
  await access.capability('Change covers').check();
  await access.submitAccountChanges();
  await access.openEditUser(MEMBER.username);
  await access.expectRoles(['Musician']);
  await expect(access.capability('Change covers')).toBeChecked();
  await expect(access.capability('Change covers')).toBeEnabled();
  await access.setRolesOnly(['Owner']);
  await access.submitAccountChanges();
  await access.expectRosterRole(MEMBER.username, 'Owner');
  await access.openEditUser(MEMBER.username);
  await access.expectRoles(['Owner']);
  await expect(access.capability('Admin')).not.toBeChecked();
  const denied = await memberPage.goto('/admin/members');
  expect(denied.status()).toBe(403);
  await expect(memberPage.getByText('Action not permitted.', { exact: true })).toBeVisible();
});

test('FTC-CAP-AUDIT-008 revoked Admin cannot submit an already-open assignment form', async ({ page, freshBrowserSession }) => {
  await signIn(page, OWNER, '/admin/members');
  const adminPage = await createRoleMember(page, freshBrowserSession, ADMIN, ['Admin']);
  const ownerAccess = new RoleAssignmentPage(page);
  await ownerAccess.openAddUser();
  await ownerAccess.fillCreateUser({ ...MEMBER, sendInvitation: false });
  await ownerAccess.setRolesOnly(['Viewer']);
  await ownerAccess.submitCreateUser();
  const adminAccess = new RoleAssignmentPage(adminPage);
  await adminAccess.open();
  await adminAccess.openEditUser(MEMBER.username);
  await adminAccess.setRolesOnly(['Owner']);
  await ownerAccess.openEditUser(ADMIN.username);
  await ownerAccess.setRolesOnly(['Viewer']);
  await ownerAccess.submitAccountChanges();
  await adminAccess.expectDeniedSave();
  await ownerAccess.openEditUser(MEMBER.username);
  await ownerAccess.expectRoles(['Viewer']);
});
