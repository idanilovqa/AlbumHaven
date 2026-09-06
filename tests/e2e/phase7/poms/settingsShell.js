import { expect } from '@playwright/test';

export class SettingsShell {
  constructor(page) {
    this.page = page;
    this.navigation = page.getByRole('complementary', { name: 'Settings navigation' });
    this.items = this.navigation.getByRole('navigation').locator('a, button');
    this.users = this.navigation.getByRole('link', { name: 'Users', exact: true });
    this.myAccount = this.navigation.getByRole('link', { name: 'My account', exact: true });
    this.signOut = this.navigation.getByRole('button', { name: 'Sign Out', exact: true });
    this.library = page.getByRole('link', { name: 'Album Haven library', exact: true });
    this.cancel = page.getByRole('link', { name: 'Cancel', exact: true });
    this.changePassword = page.getByRole('button', { name: 'Change password', exact: true });
    this.alert = page.getByRole('alert');
    this.passwordChanged = page.getByRole('status').filter({ hasText: 'Your password was changed.' });
  }

  async expectOwnerNavigation(active) {
    await expect(this.navigation.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(this.items).toHaveCount(3);
    await expect(this.items.nth(0)).toHaveAccessibleName('Users');
    await expect(this.items.nth(1)).toHaveAccessibleName('My account');
    await expect(this.items.nth(2)).toHaveAccessibleName('Sign Out');
    await expect(active === 'users' ? this.users : this.myAccount).toHaveAttribute('aria-current', 'page');
    await expect(active === 'users' ? this.myAccount : this.users).not.toHaveAttribute('aria-current', 'page');
  }

  async geometry() {
    // parity-check: allow-read-only-measurement-evaluate -- observe sidebar geometry and icons without mutating the DOM
    return this.navigation.evaluate((nav) => {
      const rect = (node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        bounds: rect(nav),
        heading: rect(nav.querySelector('h2')),
        entries: Array.from(nav.querySelectorAll('nav a, nav button'), (entry) => ({
          text: entry.textContent.trim(),
          bounds: rect(entry),
          icons: Array.from(entry.querySelectorAll('[aria-hidden="true"]'), (icon) => icon.outerHTML),
        })),
      };
    });
  }

  async retain() {
    const document = await this.page.evaluateHandle(() => window.document);
    const sidebar = await this.navigation.elementHandle();
    const geometry = await this.geometry();
    return {
      assertUnchanged: async () => {
        // parity-check: allow-read-only-measurement-evaluate -- retained Document identity proves no full document navigation
        expect(await document.evaluate((original) => original === window.document)).toBe(true);
        // parity-check: allow-read-only-measurement-evaluate -- compare original sidebar node with the current shared component
        expect(await sidebar.evaluate((original) => original.isConnected && original === document.querySelector('[data-settings-nav]'))).toBe(true);
        expect(await this.geometry()).toEqual(geometry);
      },
      dispose: async () => { await document.dispose(); await sidebar.dispose(); },
    };
  }
}

export async function retainPlayingDocument(page, player) {
  const document = await page.evaluateHandle(() => window.document);
  const playerElement = await player.elementHandle();
  return {
    assertUnchanged: async () => {
      // parity-check: allow-read-only-measurement-evaluate -- verify navigation did not replace the playing document
      expect(await document.evaluate((original) => original === window.document)).toBe(true);
      // parity-check: allow-read-only-measurement-evaluate -- verify the same bottom player stays mounted
      expect(await playerElement.evaluate((original) => original.isConnected && original === document.querySelector('.global-player'))).toBe(true);
    },
    dispose: async () => { await document.dispose(); await playerElement.dispose(); },
  };
}
