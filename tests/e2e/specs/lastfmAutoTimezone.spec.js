import { expect, test } from '../support/baseFixtures.js';

test('FTC-PLAYBACK-LASTFM-015 browser timezone is auto-detected and persisted exactly once', async ({
  galleryActions,
  settingsModalAppBarActions,
  stepLogger,
  utilityIntegrationsActions,
  utilityTabBarActions,
}) => {
  let browserTimeZone = '';

  await stepLogger.step('Confirm pre-start fixture seeding and record the managed-browser IANA timezone', async () => {
    expect(process.env.PLAYWRIGHT_MANAGED_APP).toBe('1');
    browserTimeZone = await utilityIntegrationsActions.readBrowserTimeZone();
    expect(browserTimeZone).toMatch(/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/);
    utilityIntegrationsActions.startLastfmTimeZoneSaveObservation();
  });

  await stepLogger.step('Open the Postgres-backed Last.fm integration with no saved timezone', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
    await utilityIntegrationsActions.waitForLastfmTimeZone(browserTimeZone);
    expect(utilityIntegrationsActions.readLastfmTimeZoneSaveRequests()).toEqual([{
      timezone: browserTimeZone,
      saveTimezoneOnly: true,
    }]);
  });

  await stepLogger.step('Reload the production app and retain the saved timezone without another write', async () => {
    await settingsModalAppBarActions.closeSettings();
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await utilityTabBarActions.openTab('integrations');
    await utilityIntegrationsActions.waitForReady();
    await utilityIntegrationsActions.waitForLastfmTimeZone(browserTimeZone);
    expect(utilityIntegrationsActions.readLastfmTimeZoneSaveRequests()).toEqual([{
      timezone: browserTimeZone,
      saveTimezoneOnly: true,
    }]);
    utilityIntegrationsActions.stopLastfmTimeZoneSaveObservation();
  });
});
