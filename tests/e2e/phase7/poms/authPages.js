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

  async fillCreateUser({ username, email, password }) {
    await this.page.getByLabel('Username').fill(username);
    await this.page.getByLabel('Email address').fill(email);
    await this.page.locator('input[name="password"]').fill(password);
  }

  async submitCreateUser() {
    await this.page.getByRole('button', { name: 'Create user' }).click();
    await expect(this.page).toHaveURL(/\/admin\/members\?created=1$/);
  }

  async createUser(values) {
    await this.fillCreateUser(values);
    await this.submitCreateUser();
  }

  async readAllowedActions() {
    return JSON.parse(await this.allowedActions.textContent());
  }

  async readDocumentText() {
    return this.documentBody.innerText();
  }
}
