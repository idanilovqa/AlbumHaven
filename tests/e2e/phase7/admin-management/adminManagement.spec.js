import { InvitationPage, MembersPage } from '../poms/authPages.js';
import { SettingsModalAppBar } from '../../poms/settingsModalAppBar.js';
import { SettingsModalAppBarActions } from '../../actions/settingsModalAppBarActions.js';
import { invitationPathFrom, OWNER, signIn } from '../actions/authActions.js';
import {
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
