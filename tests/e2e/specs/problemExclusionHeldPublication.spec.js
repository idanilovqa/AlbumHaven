import { expect, test } from '../support/baseFixtures.js';
import { withRefusedIgnoredRepairWrite } from '../helpers/postgresPrivilegeHelpers.js';
import { holdStructuralSavePersistence } from '../helpers/structuralSavePollWindowHelpers.js';

// Deadlock part 3 (6.5 and owner, 11-24): an exclusion made while a scan holds the library answers at once and
// is kept until the library is free. One the library then cannot save comes back in Problematic Files and is
// reported in Rules, in the owner's words, after a reload; the other one still applies.
const REFUSED_ARTIST = 'Generated Problem Fixture';
const REFUSED_ALBUM = 'Encoding And Missing Metadata';
const APPLIED_ALBUM = 'Neal Morse Plays Pink Floyd';
const APPLIED_REASON = 'Missing cover art';
// The inventory lock a scan's publication holds while it writes, held passively (no request is intercepted).
const HOLD_INVENTORY_PUBLICATION = "SELECT pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));";
const DRAIN_TIMEOUT_MS = 120000;

async function openProblematicFiles({ settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions }) {
  await settingsModalAppBarActions.openSettings();
  await utilityTabBarActions.openTab('problematic-files');
  await utilityProblematicFilesActions.waitForReady({ requirePopulated: true, diagnosticTerm: APPLIED_ALBUM });
}

async function albumProblemReasons(utilityProblematicFilesActions, album) {
  await utilityProblematicFilesActions.search(album);
  await utilityProblematicFilesActions.waitForSearchResults(album);
  await utilityProblematicFilesActions.selectAlbumByTitle(album);
  return utilityProblematicFilesActions.readAlbumProblemReasons();
}

async function exclude(utilityProblematicFilesActions, album, reason) {
  await albumProblemReasons(utilityProblematicFilesActions, album);
  await utilityProblematicFilesActions.selectAlbumProblem(reason);
  await utilityProblematicFilesActions.openExclusionConfirmation();
  await utilityProblematicFilesActions.confirmExclusion();
  // Shown as made at once, while the library is still held.
  expect(await utilityProblematicFilesActions.readAlbumProblemReasons()).not.toContain(reason);
}

test('FTC-UTIL-PROBLEMS-015 an exclusion the library cannot save after a held scan comes back and is reported in Rules, while the other applies', { tag: '@area:problematic-files' }, async ({
  galleryActions,
  page,
  settingsModalAppBarActions,
  stepLogger,
  utilityProblematicFilesActions,
  utilityRulesActions,
  utilityTabBarActions,
}) => {
  const utilities = { settingsModalAppBarActions, utilityTabBarActions, utilityProblematicFilesActions };
  let refusedReason = '';

  await stepLogger.step('Open Problematic Files and choose the problem the database will refuse', async () => {
    await galleryActions.goto('/?surface=albums');
    await galleryActions.waitForGalleryReady();
    await openProblematicFiles(utilities);
    [refusedReason] = await albumProblemReasons(utilityProblematicFilesActions, REFUSED_ALBUM);
    expect(refusedReason).toBeTruthy();
    expect(await albumProblemReasons(utilityProblematicFilesActions, APPLIED_ALBUM)).toContain(APPLIED_REASON);
  });

  await withRefusedIgnoredRepairWrite(REFUSED_ALBUM, async () => {
    const gate = await holdStructuralSavePersistence({ lockSql: HOLD_INVENTORY_PUBLICATION });
    try {
      await stepLogger.step('Exclude both problems while a scan holds the library', async () => {
        await exclude(utilityProblematicFilesActions, REFUSED_ALBUM, refusedReason);
        await exclude(utilityProblematicFilesActions, APPLIED_ALBUM, APPLIED_REASON);
      });
    } finally {
      await gate.dispose();
    }

    await stepLogger.step('After the scan, Rules report the refused change in the approved words', async () => {
      const expected = {
        title: "This change wasn't applied",
        message: `${REFUSED_ALBUM}: ${refusedReason}. The library could not save it. Change it again to try once more.`,
      };
      // The drain applies the kept changes once the library is free; the page learns of it on a reload.
      await expect.poll(async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await galleryActions.waitForGalleryReady();
        await settingsModalAppBarActions.openSettings();
        await utilityTabBarActions.openTab('rules');
        await utilityRulesActions.waitForReady();
        await utilityRulesActions.openProblemExclusions();
        return utilityRulesActions.readNotAppliedAlerts();
      }, { timeout: DRAIN_TIMEOUT_MS, intervals: [2000, 5000] }).toEqual([expected]);
      const rules = await utilityRulesActions.readProblemExclusionRows();
      expect(rules.album.some((row) => row.includes(APPLIED_ALBUM) && row.includes(APPLIED_REASON))).toBe(true);
      expect(rules.album.some((row) => row.includes(REFUSED_ALBUM))).toBe(false);
    });

    await stepLogger.step('Problematic Files shows the refused problem again; the applied one stays excluded', async () => {
      await utilityTabBarActions.openTab('problematic-files');
      await utilityProblematicFilesActions.waitForReady({ requirePopulated: true, diagnosticTerm: REFUSED_ALBUM });
      expect(await albumProblemReasons(utilityProblematicFilesActions, REFUSED_ALBUM)).toContain(refusedReason);
      expect(await albumProblemReasons(utilityProblematicFilesActions, APPLIED_ALBUM)).not.toContain(APPLIED_REASON);
    });
  });
});
