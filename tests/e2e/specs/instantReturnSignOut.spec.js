// Instant return in an ordinary browser: signing out deletes the copy (IAR-W02). The case signs in
// on its own session, so signing out never touches another test's session.
import { expect, test } from '../support/baseFixtures.js';
import { authenticateProductionContext } from '../support/performanceAuthentication.js';
import { primeCopy, keptPages, LIBRARY_PATH } from '../helpers/instantReturnHelpers.js';

test.use({ reuseAuthentication: false, serviceWorkers: 'allow' });

test('FTC-IAR-W02 signing out deletes the copy; the next start is the sign-in page, never the library', {
  tag: '@area:gallery-search',
}, async ({ page, context, galleryActions }) => {
  const signInForm = page.getByRole('form', { name: 'Album Haven sign in' });
  const albumTitles = galleryActions.galleryPage.albumCard.visibleTitles;
  await authenticateProductionContext(page);
  await primeCopy(page, galleryActions);

  await page.goto('/account');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(signInForm).toBeVisible();
  await expect.poll(() => keptPages(page)).toEqual([]);

  // The next start is the sign-in page; no album title is ever drawn on the way.
  const drawnTitles = [];
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) drawnTitles.push(await albumTitles.count());
  });
  await page.goto(LIBRARY_PATH);
  await expect(signInForm).toBeVisible();
  await expect(albumTitles).toHaveCount(0);
  expect(drawnTitles.every(count => count === 0)).toBe(true);

  // Offline there is nothing left to show: the browser's own error, not the library.
  await context.setOffline(true);
  await expect(page.goto(LIBRARY_PATH)).rejects.toThrow(/ERR_INTERNET_DISCONNECTED|net::/);
  await expect(albumTitles).toHaveCount(0);
  await context.setOffline(false);
});
