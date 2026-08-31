import { LoginPage, MembersPage } from '../poms/authPages.js';
import { OWNER, signIn } from '../actions/authActions.js';
import {
  databaseState,
  expect,
  holdMail,
  releaseMail,
  test,
  waitForMessage,
} from '../support/fixtures.js';

const LISTENER = Object.freeze({
  username: 'listener.plus',
  email: 'listener+phase7@example.test',
  password: 'Phase Seven Listener Passphrase 2026!',
});

async function createListener(page, { holdDelivery = false } = {}) {
  const members = new MembersPage(page);
  await members.open();
  await members.openAddUser();
  await members.fillCreateUser({
    username: LISTENER.username,
    email: LISTENER.email,
    password: LISTENER.password,
  });
  if (holdDelivery) await holdMail();
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

test('FTC-PERMISSIONS-005 creates an active plus-addressed user before password-free welcome delivery', async ({ browser, page }) => {
  await signIn(page);
  const { completion } = await createListener(page, { holdDelivery: true });

  const listenerContext = await browser.newContext();
  const listenerPage = await listenerContext.newPage();
  await signIn(listenerPage, {
    username: LISTENER.username,
    password: LISTENER.password,
  }, '/account');
  await expect(listenerPage.getByRole('heading', { name: 'Password & security' })).toBeVisible();

  await releaseMail();
  await completion;
  await expect(page.getByText(LISTENER.email)).toBeVisible();
  const message = await waitForMessage(LISTENER.email);
  expect(message.body).toContain(LISTENER.username);
  expect(message.body).toContain('/login');
  expect(message.body).not.toContain(LISTENER.password);
  expect(message.body).not.toMatch(/activat(e|ion)/i);
  await listenerContext.close();
});

test('FTC-PERMISSIONS-009 denies limited administration and preserves owner-only authority', async ({ browser, page }) => {
  await signIn(page);
  const { completion } = await createListener(page);
  await completion;
  await waitForMessage(LISTENER.email);

  const ownerState = await databaseState();
  const ownerId = ownerState.owner.id;
  await page.goto('/admin/accounts/new');
  await expect(page.getByText('system.admin')).toHaveCount(0);

  const listenerContext = await browser.newContext();
  const listenerPage = await listenerContext.newPage();
  await signIn(listenerPage, {
    username: LISTENER.username,
    password: LISTENER.password,
  }, '/account');
  const denied = await listenerPage.goto('/admin/members');
  expect(denied.status()).toBe(403);
  await expect(listenerPage.getByText('Action not permitted.')).toBeVisible();
  await listenerContext.close();

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
  await listenerRow.getByRole('link', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Resend email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('If delivery is available');
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
