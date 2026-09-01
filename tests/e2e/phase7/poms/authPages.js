import { expect } from '@playwright/test';

export class LoginPage {
  constructor(page) {
    this.page = page;
    this.username = page.getByLabel('Username');
    this.password = page.getByLabel('Password', { exact: true });
    this.submit = page.getByRole('button', { name: 'Sign in' });
  }

  async open(returnTo = '/') {
    await this.page.goto(`/login?return_to=${encodeURIComponent(returnTo)}`);
    await expect(this.submit).toBeVisible();
  }

  async signIn(username, password) {
    await this.username.fill(username);
    await this.password.fill(password);
    await this.submit.click();
  }
}

export class RecoveryPage {
  constructor(page) {
    this.page = page;
  }

  async request(candidate) {
    await this.page.goto('/forgot-password');
    const formToken = await this.page.locator('input[name="csrf_token"]').inputValue();
    const cookies = await this.page.context().cookies();
    const csrfCookie = cookies.find(
      (cookie) => cookie.name === '__Host-album_haven_forgot_csrf',
    );
    expect(csrfCookie).toBeTruthy();
    expect(csrfCookie.value).toBe(formToken);
    await this.page.getByLabel('Username or email').fill(candidate);
    const responsePromise = this.page.waitForResponse(
      (response) => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/forgot-password',
    );
    await this.page.getByRole('button', { name: 'Send reset link' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect(this.page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  }

  async complete(newPassword) {
    await this.page.getByLabel('New password', { exact: true }).fill(newPassword);
    await this.page.getByLabel('Confirm new password').fill(newPassword);
    await this.page.getByRole('button', { name: 'Change password' }).click();
    await expect(this.page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  }
}

export class InvitationPage {
  constructor(page) {
    this.page = page;
    this.newPassword = page.getByLabel('New password', { exact: true });
    this.confirmPassword = page.getByLabel('Confirm new password');
    this.submit = page.getByRole('button', { name: 'Set password' });
  }

  async complete(password) {
    await expect(
      this.page.getByRole('heading', { name: 'Accept invitation' }),
    ).toBeVisible();
    await this.newPassword.fill(password);
    await this.confirmPassword.fill(password);
    const responsePromise = this.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/accept-invitation'
    ));
    await this.submit.click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect(
      this.page.getByRole('heading', { name: 'Your password has been created.' }),
    ).toBeVisible();
  }
}

export class MembersPage {
  constructor(page) {
    this.page = page;
    this.allowedActions = page.locator('#admin-allowed-actions');
    this.documentBody = page.locator('body');
  }

  async open() {
    await this.page.goto('/admin/members');
    await expect(this.page.getByRole('heading', { name: 'Users & access' })).toBeVisible();
  }

  async openAddUser() {
    await this.page.getByRole('link', { name: /Add user/ }).click();
    await expect(this.page.getByRole('heading', { name: 'Add user' })).toBeVisible();
  }

  async fillCreateUser({ username, email, sendInvitation = false }) {
    await this.page.getByLabel('Username').fill(username);
    await this.page.getByLabel('Email address').fill(email);
    await this.page.locator('input[name="send_invitation"]')
      .setChecked(sendInvitation);
  }

  async submitCreateUser() {
    await this.page.getByRole('button', { name: 'Create user' }).click();
    await expect(this.page).toHaveURL(/\/admin\/members\?created=1$/);
  }

  async createUser(values) {
    await this.fillCreateUser(values);
    await this.submitCreateUser();
  }

  async copyInviteLink(username) {
    const row = this.page.getByRole('row').filter({ hasText: username });
    const actions = row.getByRole('button', { name: `Actions for ${username}` });
    if (await actions.getAttribute('aria-expanded') !== 'true') {
      await actions.click();
    }
    const responsePromise = this.page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/invitation/copy')
    ));
    await row.getByRole('menuitem', { name: 'Copy invite link' }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const expectedUrl = String((await response.json()).invitation_url || '');
    expect(expectedUrl).toMatch(/^https:\/\/[^/]+\/accept-invitation\?/);

    const fallback = this.page.getByLabel('Invitation link', { exact: true });
    let copiedUrl = '';
    await expect.poll(async () => {
      if (await fallback.isVisible()) {
        copiedUrl = await fallback.inputValue();
        return copiedUrl;
      }
      // parity-check: allow-read-only-measurement-evaluate -- read the clipboard result of the real menu action
      copiedUrl = await this.page.evaluate(() => navigator.clipboard.readText());
      return copiedUrl;
    }).toBe(expectedUrl);
    return copiedUrl;
  }

  async readAllowedActions() {
    return JSON.parse(await this.allowedActions.textContent());
  }

  async readDocumentText() {
    return this.documentBody.innerText();
  }
}
