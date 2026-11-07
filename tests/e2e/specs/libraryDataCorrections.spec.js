import { expect, test } from '../support/baseFixtures.js';
import {
  createUnreadableCreditFixture,
  readFixtureTrackArtists,
  removeUnreadableCreditFixture,
} from '../helpers/unreadableCreditFixture.js';

const UNREADABLE_REASON = 'Track artist unreadable — using album artist';

let ownedFixture;

test.beforeEach(async ({ appBarActions, galleryActions, managedAppLifecycle }) => {
  await managedAppLifecycle.stop();
  try {
    ownedFixture = await createUnreadableCreditFixture();
  } finally {
    await managedAppLifecycle.restart();
  }
  await galleryActions.goto();
  await galleryActions.waitForGalleryReady();
  await appBarActions.triggerFullRescanAndWait();
  await appBarActions.waitForScanAndCoverRefreshIdle();
});

test.afterEach(async ({ appBarActions, galleryActions, librarySettingsActions, managedAppLifecycle, settingsModalAppBarActions }) => {
  try {
    // The setting belongs to the whole library: always leave it at its default.
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    await settingsModalAppBarActions.openSettings();
    await librarySettingsActions.open();
    await librarySettingsActions.chooseDataCorrectionsMode('Display only');
    await librarySettingsActions.save();
    await settingsModalAppBarActions.closeSettings();
    await appBarActions.waitForScanAndCoverRefreshIdle();
    if (ownedFixture) await removeUnreadableCreditFixture(ownedFixture);
    ownedFixture = null;
    await appBarActions.triggerFullRescanAndWait();
    await appBarActions.waitForScanAndCoverRefreshIdle();
  } finally {
    ownedFixture = null;
    await managedAppLifecycle.stop();
    await managedAppLifecycle.restart();
  }
});

async function expectAlbumUnderOwner({ galleryActions, navigationPanelActions, searchToolbarActions }) {
  const owner = ownedFixture.ownerName;
  await galleryActions.goto('/');
  await galleryActions.waitForGalleryReady();
  await searchToolbarActions.search(ownedFixture.album, { submitWithEnter: true });
  await navigationPanelActions.waitForSidebarSelection(owner);
  await galleryActions.waitForSelectedArtistGallery(owner, { queryValue: ownedFixture.album });
  expect(await navigationPanelActions.readActiveSidebarArtistName()).toBe(owner);
  await expect.poll(() => galleryActions.readAlbumCardCount({ artist: owner, album: ownedFixture.album }),
    { message: 'the album is shown under its readable album artist', timeout: 15000 }).toBe(1);
  const artists = await navigationPanelActions.readRuntimeSidebarArtistNames();
  expect(artists).toContain(owner);
  expect(artists).not.toContain('??');
}

async function readProblematicAlbum({ settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions }) {
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('problematic-files');
  await utilityProblematicFilesActions.waitForReady({ requirePopulated: true });
  await utilityProblematicFilesActions.search(ownedFixture.album);
  await utilityProblematicFilesActions.waitForSearchResults(ownedFixture.album);
  const summary = await utilityProblematicFilesActions.selectAlbumByTitle(ownedFixture.album);
  return { summary, rows: await utilityProblematicFilesActions.readDetectedTrackRows() };
}

test(
  'FTC-LIBRARY-CORRECTIONS-001 an unreadable track artist shows the album artist, is a problem, and Write in tags fixes the tags',
  { tag: '@area:tag-edit' },
  async ({
    galleryActions, librarySettingsActions, navigationPanelActions, searchToolbarActions,
    settingsModalAppBarActions, stepLogger, utilityLogHistoryActions, utilityProblematicFilesActions, utilityTabBarActions,
  }) => {
    test.setTimeout(600000);
    const browse = { galleryActions, navigationPanelActions, searchToolbarActions };
    const problems = { settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions };
    const unreadable = ownedFixture.files.map(() => ['??']);
    const corrected = ownedFixture.files.map(() => [ownedFixture.ownerName]);

    await stepLogger.step('Display only: the album sits under its readable artist and no "??" artist exists', async () => {
      await expectAlbumUnderOwner(browse);
      expect(await readFixtureTrackArtists(ownedFixture)).toEqual(unreadable);
    });

    await stepLogger.step('Problematic Files flags every file with the unreadable track artist', async () => {
      const { summary, rows } = await readProblematicAlbum(problems);
      expect(summary.problemReasons).toContain(UNREADABLE_REASON);
      expect(rows.map((row) => row.filename).sort()).toEqual(ownedFixture.files.map((file) => file.filename).sort());
      expect(rows.every((row) => row.reasons.includes(UNREADABLE_REASON))).toBe(true);
      await settingsModalAppBarActions.closeSettings();
    });

    await stepLogger.step('Library settings shows Library Data Corrections above Album ratings, Display only chosen', async () => {
      await settingsModalAppBarActions.openSettings();
      await librarySettingsActions.open();
      expect(await librarySettingsActions.readDataCorrections()).toEqual({
        heading: 'Library Data Corrections',
        description: 'Corrects text metadata across your whole library.',
        options: [
          { label: 'Display only', checked: true, disabled: false },
          { label: 'Write in tags', checked: false, disabled: false },
        ],
        aboveAlbumRatings: true,
      });
      expect(await readFixtureTrackArtists(ownedFixture)).toEqual(unreadable);
    });

    await stepLogger.step('Write in tags, saved: the app writes the album artist into each file', async () => {
      await librarySettingsActions.chooseDataCorrectionsMode('Write in tags');
      await librarySettingsActions.save();
      await settingsModalAppBarActions.closeSettings();
      await expect.poll(() => readFixtureTrackArtists(ownedFixture),
        { message: 'the corrected track artist is written into every file', timeout: 300000, intervals: [5000] }).toEqual(corrected);
    });

    await stepLogger.step('History records the automatic correction like any tag edit', async () => {
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('log-history');
      await utilityLogHistoryActions.waitForReady();
      await expect.poll(() => utilityLogHistoryActions.readVisibleHistoryText(),
        { message: 'History lists the corrected album', timeout: 60000 }).toContain(ownedFixture.album);
      await settingsModalAppBarActions.closeSettings();
    });

    await stepLogger.step('The setting is kept, the album still shows under its artist, and the problem is gone', async () => {
      await settingsModalAppBarActions.openSettings();
      await librarySettingsActions.open();
      expect((await librarySettingsActions.readDataCorrections()).options.map((option) => option.checked)).toEqual([false, true]);
      await settingsModalAppBarActions.closeSettings();
      await expectAlbumUnderOwner(browse);
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('problematic-files');
      await utilityProblematicFilesActions.waitForReady();
      await utilityProblematicFilesActions.search(ownedFixture.album);
      await utilityProblematicFilesActions.waitForNoSearchResults(ownedFixture.album, { timeout: 120000 });
      await settingsModalAppBarActions.closeSettings();
    });
  },
);
