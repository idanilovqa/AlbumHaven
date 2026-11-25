import { expect, test } from '../support/baseFixtures.js';
import { AppBarActions } from '../actions/index.js';
import { AppBar } from '../poms/index.js';
import { markAlbumTracksAsRarities, unmarkAlbumTracksAsRarities } from '../helpers/looseTrackRarityFixture.js';

const ARTIST = 'Mastodon';
// An album whose media files exist, so a full rescan keeps its tracks indexed.
const ALBUM = 'Crack The Skye Fixture 07';
const NOTE = 'Still indexing loose tracks, so more may appear.';

async function expectNoteBelowTable(page) {
  const note = page.locator('#non-album-modal-table [data-loose-tracks-partial-note]');
  await expect(note).toHaveCount(1);
  await expect(note).toBeVisible();
  await expect(note).toHaveText(NOTE);
  const [noteBox, tableBox] = await Promise.all([
    note.boundingBox(),
    page.locator('#non-album-modal-table .album-track-table').boundingBox(),
  ]);
  expect(noteBox.y).toBeGreaterThanOrEqual(tableBox.y + tableBox.height - 1);
}

test('FTC-LOOSE-SCAN-NOTE-001 Loose Tracks notes that a running scan may add tracks and drops the note when it ends', { tag: '@area:gallery-search' }, async ({
  artistPageSettingsActions,
  freshBrowserSession,
  galleryActions,
  page,
  stepLogger,
}) => {
  test.setTimeout(420000);
  const note = page.locator('#non-album-modal-table [data-loose-tracks-partial-note]');
  const marked = await markAlbumTracksAsRarities({ artist: ARTIST, album: ALBUM });
  try {
    // Scans are started from a second tab, as a background scan would be, so this page stays on Loose Tracks.
    const other = await freshBrowserSession.create();
    await other.page.goto('/?surface=albums');
    const otherAppBar = new AppBarActions(new AppBar(other.page, test.info()));
    const runFullRescan = async (whileRunning = async () => {}) => {
      await otherAppBar.triggerFullRescanAndWaitForBusy();
      await whileRunning();
      await otherAppBar.waitForIncrementalScanComplete({ timeout: 300000 });
    };
    // A scan is the owner that publishes the marked rows into the gallery and Loose Tracks projections.
    await stepLogger.step('A first scan publishes the marked album as loose tracks', async () => {
      await runFullRescan();
    });
    await stepLogger.step('No scan and a complete store: library-wide Loose Tracks shows no note', async () => {
      await galleryActions.goto('/?surface=albums');
      await galleryActions.waitForGalleryReady();
      await artistPageSettingsActions.openLibraryWideNonAlbumTracks();
      await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTrackRows.first()).toBeVisible();
      await expect(note).toHaveCount(0);
    });
    // parity-check: allow-read-only-measurement-evaluate -- a marker that a document reload would erase
    await page.evaluate(() => { window.__looseScanNoteDocument = true; });
    await stepLogger.step('A scan runs: the note appears below the open table, and goes when it ends', async () => {
      await runFullRescan(async () => {
        await expectNoteBelowTable(page);
        await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTrackRows.first()).toBeVisible();
      });
      await expect(note).toHaveCount(0, { timeout: 30000 });
      await expect(artistPageSettingsActions.artistPageSettings.nonAlbumTrackRows.first()).toBeVisible();
      expect(await page.evaluate(() => window.__looseScanNoteDocument === true)).toBe(true);
      await artistPageSettingsActions.closeNonAlbumTracks();
    });
    await stepLogger.step("An artist's Loose Tracks show the note while a scan runs and drop it after", async () => {
      await galleryActions.goto(`/?surface=albums&artist=${encodeURIComponent(ARTIST)}`);
      await galleryActions.waitForGalleryReady();
      await artistPageSettingsActions.openNonAlbumTracks(marked.tracks);
      await expect(note).toHaveCount(0);
      await runFullRescan(() => expectNoteBelowTable(page));
      await expect(note).toHaveCount(0, { timeout: 30000 });
    });
  } finally {
    await unmarkAlbumTracksAsRarities(marked);
  }
});
