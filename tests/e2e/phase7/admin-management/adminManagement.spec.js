import { AccountPage, InvitationPage, MembersPage } from '../poms/authPages.js';
import { SettingsModalAppBar } from '../../poms/settingsModalAppBar.js';
import { SettingsModalAppBarActions } from '../../actions/settingsModalAppBarActions.js';
import { invitationPathFrom, OWNER, signIn } from '../actions/authActions.js';
import {
  databaseAction,
  databaseState,
  expect,
  test,
  waitForMessage,
} from '../support/baseFixtures.js';

const LISTENER = Object.freeze({
  username: 'listener.plus',
  email: 'listener+phase7@example.test',
  password: 'Cobalt Tundra 47! Glass Harbor',
});

const SMTP_LISTENER = Object.freeze({
  username: 'smtp.listener',
  email: 'smtp.listener+phase7@example.test',
  password: 'Amber Quasar 82! Frosted Pine',
});

const MENU_LISTENER = Object.freeze({
  username: 'menu.listener',
  email: 'menu.listener+phase7@example.test',
  password: 'Copper Orchard 68! Silent Moon',
});

const LISTENER_CAPABILITIES = Object.freeze([
  'View library',
  'Play and download files',
  'View library resources',
  'Create playlists',
  'Discovery and listening views',
]);

const EDITABLE_CAPABILITIES = Object.freeze([
  'View library',
  'Play and download files',
  'Review library problems',
  'Remove missing library inventory',
  'View library resources',
  'Create playlists',
  'Edit own playlists',
  'Manage playlist items',
  'Track preferences',
  'Discovery and listening views',
  'View saved loops',
  'Play saved loop media',
  'View album opinions',
  'View library rules',
  'View operational logs',
  'View virtual discography',
]);

test('admin detail password Enter reauthenticates before retrying Save changes', async ({ page }) => {
  await signIn(page, OWNER, '/admin/members');
  const members = new MembersPage(page);
  await members.openAddUser();
  await members.createUser({ username: 'keyboard.listener', email: 'keyboard.listener@example.test' });
  const row = page.getByRole('row').filter({ hasText: 'keyboard.listener' });
  await row.getByRole('button', { name: 'Actions for keyboard.listener' }).click();
  await row.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(members.adminForm).toBeVisible();
  await databaseAction('age-owner-authentication');
  const mutations = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/admin/reauthenticate' || request.method() === 'PATCH' && /^\/admin\/accounts\/\d+$/.test(pathname)) {
      mutations.push({ pathname, method: request.method() });
    }
  });
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const password = members.reauthPassword;
  await expect(password).toBeVisible();
  await password.fill(OWNER.password);
  await password.press('Enter');
  await expect(page).toHaveURL(/\/admin\/members$/);
  expect(mutations.map(({ method }) => method)).toEqual(['PATCH', 'POST', 'PATCH']);
  expect(mutations[1].pathname).toBe('/admin/reauthenticate');
  await expect(members.reauthPanel).toHaveCount(0);
});

test('admin last-row actions remain usable in the scrolling tablet roster', async ({ page }) => {
  await signIn(page, OWNER, '/admin/members');
  const members = new MembersPage(page);
  await members.openAddUser();
  await members.createUser({ username: 'zzz.menu', email: 'zzz.menu@example.test' });
  await page.setViewportSize({ width: 800, height: 720 });
  const row = page.getByRole('row').last();
  await expect(row).toContainText('zzz.menu');
  const trigger = row.getByRole('button', { name: 'Actions for zzz.menu' });
  await trigger.scrollIntoViewIfNeeded();
  const table = page.getByRole('table', { name: 'Managed users' });
  // parity-check: allow-read-only-measurement-evaluate -- compare native table scroll geometry before and after opening its menu
  const before = await table.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }));
  await trigger.click();
  const menu = row.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await expect.poll(() => members.menuItemsAreHitTestable(menu)).toBe(true);
  // parity-check: allow-read-only-measurement-evaluate -- opening the floating menu must not expand or scroll the table vertically
  expect(await table.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }))).toEqual(before);
  await menu.getByRole('menuitem').first().press('Escape');
  await expect(trigger).toBeFocused();
  await expect(menu).toBeHidden();
  await trigger.click();
  const tableBox = await table.boundingBox();
  await page.mouse.move(tableBox.x + tableBox.width / 2, tableBox.y + tableBox.height / 2);
  await page.mouse.wheel(-100, 0);
  await expect(menu).toBeHidden();
  await trigger.click();
  await page.setViewportSize({ width: 810, height: 720 });
  await expect(menu).toBeHidden();
  await trigger.click();
  await menu.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await expect(members.adminForm).toBeVisible();
  await expect(members.openActionMenus).toHaveCount(0);
});

test('FTC-PERMISSIONS-011 owner discovers Settings and Users through the shared rounded menu', async ({ page }) => {
  await signIn(page);
  const menu = new SettingsModalAppBar(page);
  const actions = new SettingsModalAppBarActions(menu);
  await expect(menu.toolbarAdminLink).toBeHidden();
  await menu.settingsButton.click();
  await expect(menu.accountMenu).toBeVisible();
  await expect(menu.accountMenu.getByRole('menuitem')).toHaveCount(3);
  await expect(menu.accountMenu.getByRole('menuitem').nth(0)).toHaveAccessibleName('Settings');
  await expect(menu.accountMenu.getByRole('menuitem').nth(1)).toHaveAccessibleName('Admin Panel');
  await expect(menu.accountMenu.getByRole('menuitem').nth(2)).toHaveAccessibleName('Sign Out');
  await expect(menu.settingsButton).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.settingsMenuItem).toBeFocused();
  await menu.adminPanelMenuItem.hover();
  await expect(menu.adminPanelMenuItem).toHaveCSS('border-radius', '9px');
  await expect(menu.adminPanelMenuItem).toHaveCSS('background-color', 'rgb(23, 45, 67)');
  await menu.settingsMenuItem.press('Escape');
  await expect(menu.accountMenu).toBeHidden();
  await expect(menu.settingsButton).toBeFocused();
  await actions.openSettings();
  await expect(menu.modal).toBeVisible();
  await expect(menu.accountMenu).toBeHidden();
  await expect(menu.modal.getByRole('link', { name: 'Users & access' })).toHaveCount(0);
  await actions.closeSettings();
  await menu.settingsButton.click();
  await menu.adminPanelMenuItem.click();
  await expect(page).toHaveURL(/\/admin\/members$/);
  await expect(page.getByRole('link', { name: 'Users', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Back to library' })).toHaveCount(0);
  const members = new MembersPage(page);
  await expect(members.placeholderEntries).toHaveCount(0);
  const account = await members.openMyAccount();
  await expect(account.heading).toBeVisible();
  await expect(account.signedInIdentity).toContainText(new RegExp(OWNER.username, 'i'));
  await expect(account.myAccountLink).toHaveAttribute('aria-current', 'page');
  await expect(account.currentPassword).toBeEditable();
  await expect(account.newPassword).toBeEditable();
  await expect(account.confirmPassword).toBeEditable();
  await expect(account.activeSessions).toBeVisible();
  await expect(account.currentDevice).toContainText('Active now');
  await expect(account.currentDevice).toContainText('Current');
  const returnedMembers = await account.openUsers();
  await expect(returnedMembers.usersLink).toHaveAttribute('aria-current', 'page');
  await expect(returnedMembers.placeholderEntries).toHaveCount(0);
});

test('FTC-PERMISSIONS-012 limited member sees no Admin Panel and signs out through the shared menu', async ({ page, freshBrowserSession }) => {
  await signIn(page);
  const members = new MembersPage(page);
  await members.open();
  await members.openAddUser();
  await members.fillCreateUser({ ...MENU_LISTENER, sendInvitation: false });
  await members.submitCreateUser();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const invite = await members.copyInviteLink(MENU_LISTENER.username);
  const recipient = await freshBrowserSession.create();
  await recipient.page.goto(invitationPathFrom(invite));
  await new InvitationPage(recipient.page).complete(MENU_LISTENER.password);
  await signIn(recipient.page, MENU_LISTENER);
  const menu = new SettingsModalAppBar(recipient.page);
  await menu.settingsButton.click();
  await expect(menu.accountMenu).toBeVisible();
  await expect(menu.settingsMenuItem).toBeVisible();
  await expect(menu.adminPanelMenuItem).toHaveCount(0);
  await expect(menu.signOutMenuItem).toBeVisible();
  await menu.signOutMenuItem.click();
  await expect(recipient.page).toHaveURL(/\/login$/);
  const protectedAccount = await recipient.page.goto('/account');
  expect(protectedAccount.status()).toBe(401);
  await expect(recipient.page.getByText('Authentication required.')).toBeVisible();
});

async function createListener(page) {
  const members = new MembersPage(page);
  await members.open();
  await members.openAddUser();
  await members.fillCreateUser({
    username: LISTENER.username,
    email: LISTENER.email,
    sendInvitation: true,
  });
  const requestSeen = page.waitForRequest(
    (request) => request.method() === 'POST'
      && new URL(request.url()).pathname === '/admin/accounts',
  );
  const creation = members.submitCreateUser();
  await requestSeen;
  await expect.poll(async () => (
    (await databaseState()).accounts.some(
      (account) => account.username_display === LISTENER.username,
    )
  )).toBe(true);
  return { completion: creation };
}

test('creates, rotates, accepts, and signs in through a copied invitation', async ({ page, freshBrowserSession }) => {
  await signIn(page);
  const members = new MembersPage(page);
  await members.open();
  await members.openAddUser();
  await members.fillCreateUser({ ...LISTENER, sendInvitation: false });
  await members.submitCreateUser();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const firstUrl = await members.copyInviteLink(LISTENER.username);
  const secondUrl = await members.copyInviteLink(LISTENER.username);

  const recipient = await freshBrowserSession.create();
  await recipient.page.goto(invitationPathFrom(firstUrl));
  await expect(
    recipient.page.getByText('Invitation link is invalid or expired.'),
  ).toBeVisible();

  await recipient.page.goto(invitationPathFrom(secondUrl));
  await new InvitationPage(recipient.page).complete(LISTENER.password);
  await signIn(recipient.page, LISTENER, '/account');
  await expect(
    recipient.page.getByRole('heading', { name: 'Password & security' }),
  ).toBeVisible();

  const account = new AccountPage(recipient.page);
  await expect(account.myAccountLink).toHaveAttribute('aria-current', 'page');
  await expect(account.usersLink).toHaveCount(0);
  await expect(account.signedInIdentity).toContainText(LISTENER.username);
  await expect(account.currentPassword).toBeEditable();
  await expect(account.activeSessions).toBeVisible();
  await expect(account.currentDevice).toContainText('Current');

  await recipient.page.goto(invitationPathFrom(secondUrl));
  await expect(
    recipient.page.getByText('Invitation link is invalid or expired.'),
  ).toBeVisible();
});

test('delivers a usable invitation through the local SMTP capture server', async ({ page, freshBrowserSession }) => {
  await signIn(page);
  const members = new MembersPage(page);
  await members.open();
  await members.openAddUser();
  await members.fillCreateUser({ ...SMTP_LISTENER, sendInvitation: true });
  await members.submitCreateUser();

  const message = await waitForMessage(SMTP_LISTENER.email);
  expect(message.body).not.toContain(SMTP_LISTENER.password);

  const recipient = await freshBrowserSession.create();
  await recipient.page.goto(invitationPathFrom(message.body));
  await new InvitationPage(recipient.page).complete(SMTP_LISTENER.password);
  await signIn(recipient.page, SMTP_LISTENER, '/account');
  await expect(
    recipient.page.getByRole('heading', { name: 'Password & security' }),
  ).toBeVisible();
});

test('FTC-PERMISSIONS-009 denies limited administration and preserves owner-only authority', async ({ page, freshBrowserSession }) => {
  await signIn(page);
  const { completion } = await createListener(page);
  await completion;
  const invitationMessage = await waitForMessage(
    LISTENER.email,
    (message) => /invitation/i.test(message.subject),
  );

  const ownerState = await databaseState();
  const ownerId = ownerState.owner.id;
  await page.goto('/admin/accounts/new');
  await expect(page.getByText('system.admin')).toHaveCount(0);
  const newMember = new MembersPage(page);
  await expect(newMember.capabilityRole).toHaveValue('listener');
  await expect(newMember.ownerRoleOption).toHaveCount(0);

  const listenerSession = await freshBrowserSession.create();
  const listenerPage = listenerSession.page;
  await listenerPage.goto(invitationPathFrom(invitationMessage));
  await new InvitationPage(listenerPage).complete(LISTENER.password);
  await signIn(listenerPage, {
    username: LISTENER.username,
    password: LISTENER.password,
  }, '/account');
  const denied = await listenerPage.goto('/admin/members');
  expect(denied.status()).toBe(403);
  await expect(listenerPage.getByText('Action not permitted.')).toBeVisible();

  await page.goto(`/admin/accounts/${ownerId}`);
  const members = new MembersPage(page);
  await expect(members.capabilityRole).toHaveValue('owner');
  await expect(members.capabilityRole).toHaveText('Owner');
  await expect(members.capabilityRole).toBeDisabled();
  await expect(members.ownerFullAccess).toBeVisible();
  await expect(members.libraryAccess).toBeChecked();
  await expect(members.libraryAccess).toBeDisabled();
  await expect(members.capabilitySwitches).toHaveCount(EDITABLE_CAPABILITIES.length);
  for (const label of EDITABLE_CAPABILITIES) {
    await expect(members.capabilitySwitch(label)).toBeChecked();
    await expect(members.capabilitySwitch(label)).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: 'Send email', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resend email', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke sessions' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Disable account/ })).toHaveCount(0);
  const allowed = await members.readAllowedActions();
  expect(allowed['accounts.manage']).toBe(true);
  expect(allowed['accounts.membership.manage']).toBe(true);
  expect(allowed['accounts.capabilities.manage']).toBe(true);
  expect(allowed['accounts.welcome.send']).toBe(true);
  expect(allowed['accounts.password_reset.send']).toBe(true);
  expect(allowed['system.admin']).toBeUndefined();

  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === '__Host-album_haven_csrf',
  );
  const session = (await page.context().cookies()).find(
    (cookie) => cookie.name === '__Host-album_haven_session',
  );
  const ownerMutation = await page.context().request.patch(`/admin/accounts/${ownerId}`, {
    headers: {
      Cookie: `${session.name}=${session.value}; ${csrf.name}=${csrf.value}`,
      Origin: new URL(page.url()).origin,
      'X-Album-Haven-CSRF': csrf.value,
    },
    data: {
      is_active: false,
      current_library_access: false,
      capability_keys: ['library.browse.read'],
      confirm_disable: true,
      confirm_remove_access: true,
    },
  });
  expect(ownerMutation.status()).toBe(403);
  expect((await databaseState()).owner.is_active).toBe(true);

  await page.goto('/admin/members');
  const listenerRow = page.getByRole('row').filter({ hasText: LISTENER.username });
  await listenerRow.getByRole('button', {
    name: `Actions for ${LISTENER.username}`,
  }).click();
  await listenerRow.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(members.capabilityRole).toHaveValue('listener');
  await expect(members.ownerRoleOption).toHaveCount(0);
  await expect(members.libraryAccess).toBeChecked();
  await expect(members.libraryAccess).toBeEnabled();
  await expect(members.capabilitySwitches).toHaveCount(EDITABLE_CAPABILITIES.length);
  await expect(members.checkedCapabilitySwitches).toHaveCount(LISTENER_CAPABILITIES.length);
  for (const label of LISTENER_CAPABILITIES) {
    await expect(members.capabilitySwitch(label)).toBeChecked();
    await expect(members.capabilitySwitch(label)).toBeEnabled();
  }
  await expect(
    page.getByRole('button', { name: 'Resend email', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('If delivery is available');
  const resetMessage = await waitForMessage(
    LISTENER.email,
    (message) => /reset/i.test(message.subject),
  );
  expect(page.url()).not.toContain('token=');
  expect(await members.readDocumentText()).not.toContain('purpose=password-reset');
  expect(resetMessage.body).not.toContain(LISTENER.password);
});

test('FTC-PERMISSIONS-009 Owner save preserves inherited capabilities and membership', async ({ page }) => {
  await signIn(page);
  const members = new MembersPage(page);
  await members.open();
  await members.openEditUser(OWNER.username);
  const before = await databaseState();
  expect(before.owner_membership_role).toBe('owner');
  await expect(members.capabilityRole).toHaveValue('owner');
  await expect(members.ownerFullAccess).toBeVisible();
  await expect(members.libraryAccess).toBeChecked();
  await expect(members.libraryAccess).toBeDisabled();

  await members.submitAccountChanges();
  await members.openEditUser(OWNER.username);
  await expect(members.capabilityRole).toHaveValue('owner');
  await expect(members.capabilityRole).toBeDisabled();
  await expect(members.ownerFullAccess).toBeVisible();
  await expect(members.libraryAccess).toBeChecked();
  await expect(members.libraryAccess).toBeDisabled();
  await expect(members.capabilitySwitches).toHaveCount(EDITABLE_CAPABILITIES.length);
  for (const label of EDITABLE_CAPABILITIES) {
    await expect(members.capabilitySwitch(label)).toBeChecked();
    await expect(members.capabilitySwitch(label)).toBeDisabled();
  }
  const after = await databaseState();
  expect(after.owner_membership_role).toBe(before.owner_membership_role);
  expect(after.owner_capabilities).toEqual(before.owner_capabilities);
  expect(after.owner).toEqual(before.owner);
});
