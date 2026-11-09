import { expect } from '@playwright/test';

import { AppBarActions } from '../actions/appBarActions.js';
import { ScanPageActions } from '../actions/scanPageActions.js';
import {
  readWatcherRecoveryManifest,
  watcherRecoveryTextContainsPrivateIdentity,
} from '../helpers/libraryFilesystemWatcherFixture.js';
import { AppBar } from '../poms/appBar.js';
import { ScanPage } from '../poms/scanPage.js';

export function createWatcherRecoveryViewerActions({
  freshBrowserSession,
  registerContext = () => () => {},
  testInfo = null,
}) {
  const manifest = readWatcherRecoveryManifest();

  return {
    async loginAndOpenStatusPage() {
      const { context, page } = await freshBrowserSession.create({ authenticated: false });
      const unregisterContext = registerContext(context);
      let closed = false;
      const closeContext = async () => {
        if (closed) return;
        await context.close();
        closed = true;
        unregisterContext();
      };
      try {
        await page.goto('/login');
        await page.getByRole('textbox', { name: 'Username', exact: true })
          .fill(manifest.viewerUsername);
        await page.getByLabel('Password', { exact: true }).fill(manifest.viewerPassword);
        await Promise.all([
          page.waitForURL((url) => new URL(url).pathname !== '/login'),
          page.getByRole('button', { name: 'Sign in', exact: true }).click(),
        ]);
        await expect(page.locator('#app-shell')).toBeVisible();

        const appBar = new AppBar(page, testInfo);
        const appBarActions = new AppBarActions(appBar);
        const scanPage = new ScanPage(page, testInfo);
        const scanPageActions = new ScanPageActions(scanPage);
        await appBarActions.openStatusMenu();
        await scanPageActions.openStatusPageFromMenu();

        return {
          page,
          context,
          async expectOperationalIncidentVisible() {
            await expect(scanPage.healthWarning).toBeVisible();
            await expect(scanPage.problemItems).toHaveCount(1);
            await expect(scanPage.problemItems).toContainText('Library recovery is required.');
            const warningText = String(await scanPage.healthWarning.textContent() || '');
            const containsPrivateIdentity = watcherRecoveryTextContainsPrivateIdentity(
              warningText,
              manifest,
            );
            expect(containsPrivateIdentity, 'Watcher warning must not expose an owned root identity.')
              .toBe(false);
          },
          expectRepairUnavailable() {
            return scanPageActions.expectRepairUnavailable();
          },
          async close() {
            await closeContext();
          },
        };
      } catch (error) {
        try {
          await closeContext();
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            'Watcher recovery viewer setup and browser context cleanup both failed.',
          );
        }
        throw error;
      }
    },
  };
}
