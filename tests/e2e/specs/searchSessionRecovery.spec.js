import { expect, test as base } from '../support/baseFixtures.js';
import { createMobileBrowserSessions } from '../support/mobileFixtures.js';
import { authenticateProductionContext } from '../support/performanceAuthentication.js';

const test = base.extend({
  sameSessionTabs: async ({ browser, context, requestInterceptionGuard }, use) => {
    const tabs = createMobileBrowserSessions(browser, context);
    try { await use(tabs); } finally { await tabs.closeAll(); }
  },
});

test.use({ reuseAuthentication: false });

test('FTC-PERMISSIONS-007 returns a populated gallery to sign-in after native logout in another tab', {
  tag: '@area:gallery-search',
}, async ({ page, sameSessionTabs, galleryActions }) => {
  await authenticateProductionContext(page);
  await galleryActions.goto('/?surface=albums&artist=Neal%20Morse');
  await galleryActions.waitForGalleryReady();
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const unauthorizedStatus = page.waitForResponse(response => (
    new URL(response.url()).pathname === '/status' && response.status() === 401
  ));
  const otherSession = await sameSessionTabs.createPage();
  const otherPage = otherSession.page;
  try {
    await otherPage.goto('/account');
    await otherPage.getByRole('button', { name: 'Sign out' }).click();
    await expect(otherPage.getByRole('form', { name: 'Album Haven sign in' })).toBeVisible();
    await unauthorizedStatus;
    await expect(page.getByRole('form', { name: 'Album Haven sign in' })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await otherSession.close();
  }
});
