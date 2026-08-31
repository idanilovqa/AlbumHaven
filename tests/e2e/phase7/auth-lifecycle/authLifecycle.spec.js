import { LoginPage, RecoveryPage } from '../poms/authPages.js';
import { OWNER, resetLinkFrom, signIn } from '../actions/authActions.js';
import {
  databaseAction,
  databaseState,
  expect,
  messages,
  test,
  waitForMessage,
} from '../support/fixtures.js';

async function loginResponse(page, username, password) {
  const login = new LoginPage(page);
  await login.open('/account');
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/login',
  );
  await login.signIn(username, password);
  return responsePromise;
}

test('FTC-PERMISSIONS-003 reconciles Rendref and signs in through a token-free safe return', async ({ page }) => {
  const before = await databaseState();
  expect(before.owner.id).toBe(before.owner.owner_account_id);

  await signIn(page, OWNER, '/account');

  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Password & security' })).toBeVisible();
  await expect(page.getByText(/Signed in as Rendref/)).toBeVisible();
  expect(page.url()).not.toContain('token=');
  const after = await databaseState();
  expect(after.owner.id).toBe(before.owner.id);
  expect(after.owner.library_id).toBe(before.owner.library_id);
});

test('FTC-PERMISSIONS-004 keeps failures generic and throttles durably', async ({ browser, page }) => {
  const unknown = await loginResponse(page, 'unknown.user', 'Wrong private passphrase 2026!');
  const wrong = await loginResponse(page, OWNER.username, 'Wrong private passphrase 2026!');
  await databaseAction('disable-owner');
  const disabled = await loginResponse(page, OWNER.username, OWNER.password);

  expect([unknown.status(), wrong.status(), disabled.status()]).toEqual([401, 401, 401]);
  await expect(page.getByRole('alert')).toHaveText(
    'Sign-in failed. Check your credentials and try again.',
  );

  await fetch(`${process.env.PHASE7_AUTH_CONTROL_URL}/reset`, { method: 'POST' });
  const statuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    statuses.push((await loginResponse(page, OWNER.username, 'Wrong private passphrase 2026!')).status());
  }
  expect(statuses).toEqual([401, 401, 401, 401, 401, 401]);
  const accountThrottle = (await databaseState()).throttles.find(
    (bucket) => bucket.bucket_kind === 'login_account',
  );
  expect(accountThrottle).toMatchObject({ failure_count: 5, blocked: true });

  const secondWorker = await browser.newContext({
    baseURL: process.env.PHASE7_AUTH_WORKER_URL,
  });
  const secondWorkerPage = await secondWorker.newPage();
  const secondWorkerLogin = new LoginPage(secondWorkerPage);
  await secondWorkerLogin.open('/account');
  const secondWorkerResponse = secondWorkerPage.waitForResponse(
    (response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/login',
  );
  await secondWorkerLogin.signIn(OWNER.username, OWNER.password);
  expect((await secondWorkerResponse).status()).toBe(401);
  await expect(secondWorkerPage.getByRole('alert')).toHaveText(
    'Sign-in failed. Check your credentials and try again.',
  );
  await secondWorker.close();
});

test('FTC-PERMISSIONS-006 completes a token-free, single-use reset and revokes prior sessions', async ({ browser, page }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  await signIn(firstPage);
  await signIn(secondPage);
  expect((await databaseState()).owner.active_sessions).toBe(2);

  const recovery = new RecoveryPage(page);
  await recovery.request('unknown@example.test');
  expect((await messages()).some((message) => message.to === 'unknown@example.test')).toBe(false);
  await recovery.request('rendref@example.test');
  const recoveryState = await databaseState();
  expect(recoveryState.reset_tokens).toHaveLength(1);
  expect(recoveryState.outbox).toHaveLength(1);
  await expect.poll(async () => (await databaseState()).outbox[0]).toMatchObject({
    delivery_status: 'sent',
    attempt_count: 1,
  });
  const message = await waitForMessage('rendref@example.test');
  const resetPath = resetLinkFrom(message);
  await page.goto(resetPath);
  await expect(page).toHaveURL(/\/reset-password$/);
  expect(page.url()).not.toContain('token=');
  const newPassword = 'Phase Seven Replacement Passphrase 2026!';
  await recovery.complete(newPassword);

  await firstPage.goto('/account');
  await secondPage.goto('/account');
  await expect(firstPage.getByText('Authentication required.')).toBeVisible();
  await expect(secondPage.getByText('Authentication required.')).toBeVisible();
  expect((await loginResponse(page, OWNER.username, OWNER.password)).status()).toBe(401);
  expect((await loginResponse(page, OWNER.username, newPassword)).status()).toBe(303);

  const replay = await page.goto(resetPath);
  expect(replay.status()).toBe(400);
  await expect(page).toHaveURL(/\/reset-password\?invalid=1$/);
  expect(page.url()).not.toContain('token=');
  await first.close();
  await second.close();
});

test('FTC-PERMISSIONS-007 rejects expired sessions across HTML, API, and media without leaks', async ({ page }) => {
  await signIn(page);
  await databaseAction('expire-owner-sessions');

  const html = await page.goto('/account');
  expect(html.status()).toBe(401);
  await expect(page.getByText('Authentication required.')).toBeVisible();
  const api = await page.request.get('/status');
  expect(api.status()).toBe(401);
  const privatePath = 'C:\\Private Music\\secret.flac';
  const media = await page.request.get(`/track?path=${encodeURIComponent(privatePath)}`);
  expect(media.status()).toBe(401);
  expect(await media.text()).not.toContain(privatePath);
});

test('FTC-PERMISSIONS-008 enforces session CSRF and makes logout revoke reuse', async ({ browser, page, context }) => {
  await signIn(page);
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === '__Host-album_haven_session');
  const csrf = cookies.find((cookie) => cookie.name === '__Host-album_haven_csrf');
  expect(session).toBeTruthy();
  expect(csrf).toBeTruthy();

  const cookieHeader = `${session.name}=${session.value}; ${csrf.name}=${csrf.value}`;
  const submitMutation = (token) => context.request.post('/admin/reauthenticate', {
    data: { password: OWNER.password },
    headers: {
      Cookie: cookieHeader,
      Origin: new URL(page.url()).origin,
      ...(token === null ? {} : { 'X-Album-Haven-CSRF': token }),
    },
  });
  const mutationStatuses = [];
  for (const token of [null, 'invalid', csrf.value]) {
    mutationStatuses.push((await submitMutation(token)).status());
  }
  expect(mutationStatuses).toEqual([403, 403, 200]);

  const logoutWithoutCsrf = await context.request.post('/logout', {
    form: {},
    headers: {
      Cookie: cookieHeader,
      Origin: new URL(page.url()).origin,
    },
  });
  expect(logoutWithoutCsrf.status()).toBe(400);

  await page.goto('/account');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  const replayContext = await browser.newContext();
  await replayContext.addCookies([{
    name: session.name,
    value: session.value,
    domain: session.domain,
    path: session.path,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  }]);
  const replayPage = await replayContext.newPage();
  const replay = await replayPage.goto('/account');
  expect(replay.status()).toBe(401);
  await replayContext.close();
});
