// Instant return in an ordinary browser: signing out deletes the copy (IAR-W02, IAR-W03). Each
// case signs in on its own session, so signing out never touches another test's session.
import { expect, test } from '../support/baseFixtures.js';
import { authenticateProductionContext } from '../support/performanceAuthentication.js';
import { primeCopy, keptPages, LIBRARY_PATH } from '../helpers/instantReturnHelpers.js';

test.use({ reuseAuthentication: false, serviceWorkers: 'allow' });

test('FTC-IAR-W02 signing out deletes the copy; the next start is the sign-in page, never the library', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions }) => {
  await authenticateProductionContext(page);
  await primeCopy(page, galleryActions);

  await page.goto('/account');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('form', { name: 'Album Haven sign in' })).toBeVisible();
  await expect.poll(() => keptPages(page)).toEqual([]);

  const drawnLibrary = [];
  page.on('framenavigated', async () => {
    drawnLibrary.push(await page.locator('#artist-groups .album-card').count().catch(() => 0));
  });
  await page.goto(LIBRARY_PATH);
  await expect(page.getByRole('form', { name: 'Album Haven sign in' })).toBeVisible();
  expect(drawnLibrary.every(count => count === 0)).toBe(true);

  // Offline there is nothing left to show.
  await context.setOffline(true);
  await page.goto(LIBRARY_PATH).catch(() => {});
  await expect(page.locator('#artist-groups .album-card')).toHaveCount(0);
  await context.setOffline(false);
});

test('FTC-IAR-W03 a tab that leaves the library after another tab signed out keeps no copy', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions }) => {
  await authenticateProductionContext(page);
  await primeCopy(page, galleryActions);
  await page.evaluate(() => history.pushState(null, '', '/?surface=albums&saved=other-view'));

  const other = await context.newPage();
  try {
    await other.goto('/account');
    await other.getByRole('button', { name: 'Sign out' }).click();
    await expect(other.getByRole('form', { name: 'Album Haven sign in' })).toBeVisible();

    // The library tab is hidden with a changed view, which asks the worker to save it.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(() => keptPages(page), { timeout: 10_000 }).toEqual([]);
  } finally {
    await other.close();
  }
});
