import { expect, test } from '../support/baseFixtures.js';
import {
  readGeneratedMp3AlbumTags,
  temporarilyMakeGeneratedMp3Unavailable,
} from '../helpers/physicalTagHelpers.js';
import { holdStructuralSavePersistence } from '../helpers/structuralSavePollWindowHelpers.js';

// Owner (2026-11-23): once a save's files are written and verified, it has succeeded. While the library
// catches up ("finishing"), a reload or another tab still shows the new values until the library holds them;
// only a failed file write puts the old values back.
const FIXTURE_ARTIST = 'E2E Rarity Artist';
const FINISHING_ALBUM = 'Queued Album Rename Fixture';
const FINISHING_RENAMED_ALBUM = 'Finishing Album Rename Fixture';
const FINISHING_YEAR = '2026';
const FINISHING_TRACK_COUNT = 18;
const FAILED_ALBUM = 'Two Track Rarity Fixture';
const FAILED_TRACK_FILENAME = '01 - Apply Rarity Here.mp3';
const ARTIST_VIEW_URL = `/?surface=albums&artist=${encodeURIComponent(FIXTURE_ARTIST)}`;
const PENDING_TAG_EDITS_KEY = 'albumHaven.pendingTagEdits';
// The inventory lock a scan's or startup build's publication holds while it writes: held passively, so the
// save waits its ceiling and answers "finishing" (no request is intercepted).
const HOLD_INVENTORY_PUBLICATION = "SELECT pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'));";
// The save's lock-wait ceiling (EDIT_SAVE_LOCK_WAIT_SECONDS) plus the response.
const FINISHING_ANSWER_TIMEOUT_MS = 90000;
const albumDetailsTitle = (albumName, year = FINISHING_YEAR) => `${FIXTURE_ARTIST} • ${albumName} • ${year}`;

async function pendingTagEditIds(page) {
  return page.evaluate((key) => {
    try { return (JSON.parse(window.localStorage.getItem(key) || '[]') || []).map((entry) => entry.id); } catch { return []; }
  }, PENDING_TAG_EDITS_KEY);
}

test('FTC-TAGS-043 a save that finishes while a scan holds the library shows its new album name immediately, still shows it after a reload, in a second tab and in Album Details, and keeps it once the library holds it', { tag: '@area:tag-edit' }, async ({
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  const gate = await holdStructuralSavePersistence({ lockSql: HOLD_INVENTORY_PUBLICATION });
  let secondTab = null;
  try {
    await stepLogger.step('Rename the album while a publication holds the library; the new name shows at once', async () => {
      await galleryActions.goto(ARTIST_VIEW_URL);
      await galleryActions.waitForGalleryReady();
      await galleryActions.selectAlbumDetailsByIdentity({ artist: FIXTURE_ARTIST, album: FINISHING_ALBUM, year: FINISHING_YEAR });
      await trackModalActions.waitForInteractiveSummary();
      await trackModalActions.openTagEditor();
      await tagEditorActions.waitForOpen({ expectedTrackCount: FINISHING_TRACK_COUNT });
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.setAlbumName(FINISHING_RENAMED_ALBUM);
      // Owner (2026-11-23): the new name shows at the Save, on the saving page, before the server answers.
      const accepted = await tagEditorActions.applyAndReturnFinishingEdit({
        timeout: FINISHING_ANSWER_TIMEOUT_MS,
        onBeforeResponse: async () => {
          await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, FINISHING_RENAMED_ALBUM);
          await galleryActions.waitForAlbumHidden(FINISHING_ALBUM);
        },
      });
      expect(accepted.payload.save_task_status).toBe('finishing');
      const physicalTags = await readGeneratedMp3AlbumTags({ artist: FIXTURE_ARTIST, album: FINISHING_ALBUM });
      expect(physicalTags).toHaveLength(FINISHING_TRACK_COUNT);
      for (const track of physicalTags) expect(track.albumValues).toEqual([FINISHING_RENAMED_ALBUM]);
      await trackModalActions.waitForTitle(albumDetailsTitle(FINISHING_RENAMED_ALBUM));
      await trackModalActions.close();
    });

    await stepLogger.step('A reload shows the new album name on the card and in Album Details', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, FINISHING_RENAMED_ALBUM);
      await galleryActions.waitForAlbumHidden(FINISHING_ALBUM);
      await galleryActions.selectAlbumDetailsByIdentity({ artist: FIXTURE_ARTIST, album: FINISHING_RENAMED_ALBUM, year: FINISHING_YEAR });
      const summary = await trackModalActions.waitForInteractiveSummary();
      await trackModalActions.waitForTitle(albumDetailsTitle(FINISHING_RENAMED_ALBUM));
      expect(summary.trackRows).toBe(FINISHING_TRACK_COUNT);
      await trackModalActions.close();
    });

    await stepLogger.step('A second tab of the same browser shows the new album name too', async () => {
      secondTab = await page.context().newPage();
      await secondTab.goto(ARTIST_VIEW_URL, { waitUntil: 'domcontentloaded' });
      await expect(secondTab.getByText(FINISHING_RENAMED_ALBUM, { exact: true }).first()).toBeVisible({ timeout: 30000 });
      await expect(secondTab.getByText(FINISHING_ALBUM, { exact: true })).toHaveCount(0);
    });

    await stepLogger.step('Once the publication ends, the library holds the save and the kept edit is dropped', async () => {
      await gate.release();
      await expect.poll(() => pendingTagEditIds(page), { timeout: 120000 }).toEqual([]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await galleryActions.waitForGalleryReady();
      await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, FINISHING_RENAMED_ALBUM);
      await galleryActions.waitForAlbumHidden(FINISHING_ALBUM);
      expect(await galleryActions.readAlbumIdentityCardCount({
        artist: FIXTURE_ARTIST, album: FINISHING_RENAMED_ALBUM, year: FINISHING_YEAR,
      })).toBe(1);
    });
  } finally {
    await secondTab?.close();
    await gate.dispose();
  }
});

test('FTC-TAGS-044 a save whose file write fails shows the old values again, keeps no pending edit, and a reload shows the old values', { tag: '@area:tag-edit' }, async ({
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  await stepLogger.step('Open the two-track album in the tag editor', async () => {
    await galleryActions.goto(ARTIST_VIEW_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.selectAlbumDetailsByIdentity({ artist: FIXTURE_ARTIST, album: FAILED_ALBUM, year: FINISHING_YEAR });
    await trackModalActions.waitForInteractiveSummary();
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: 2 });
    await tagEditorActions.selectTrackByFilename(FAILED_TRACK_FILENAME);
    await tagEditorActions.setAlbumName('Never Written Album');
  });

  await stepLogger.step('The file write fails: the old values return and nothing is kept for later', async () => {
    const unavailableTrack = temporarilyMakeGeneratedMp3Unavailable({
      artist: FIXTURE_ARTIST, album: FAILED_ALBUM, filename: FAILED_TRACK_FILENAME,
    });
    try {
      const failure = await tagEditorActions.applyAndWaitForFailure({ expectedErrorPattern: /^Failed to edit tags\.$/u });
      expect(failure.status).toBe(500);
    } finally {
      unavailableTrack.restore();
    }
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, FAILED_ALBUM);
    await galleryActions.waitForAlbumHidden('Never Written Album');
    expect(await pendingTagEditIds(page)).toEqual([]);
  });

  await stepLogger.step('A reload shows the old values', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, FAILED_ALBUM);
    await galleryActions.waitForAlbumHidden('Never Written Album');
  });
});
