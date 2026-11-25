import { expect, test } from '../support/baseFixtures.js';
import { readGeneratedMp3TagSnapshots } from '../helpers/physicalTagHelpers.js';
import { removeRelationCompatibilityEvidence } from '../helpers/postgresProjectionFixture.js';

// FTC-TAGS-045: an edit made while the relation index waits for reconciliation is saved at once with the normal
// message and shows in the editor, the files and the gallery under its new artist. After a restart the
// reconciliation owner parks the index for the explicit initialization, and saves keep working meanwhile.
// The case owns its database and media copy, so the parked index stays with it.
const FIXTURE_ARTIST = 'E2E Rarity Artist';
const FIXTURE_ALBUM = 'Two Track Rarity Fixture';
const FIXTURE_YEAR = '2026';
const RECONCILED_ARTIST = 'E2E Reconciled Artist';
const PARKED_EDIT_ARTIST = 'E2E Parked Edit Artist';
const FIXTURE_TRACK_COUNT = 2;
const ROOT_GALLERY_URL = '/?surface=albums';
// Start-up readiness waits 5 s before its relation work; the reconciliation replay of one album then takes well
// under a second at production calibration. 20 s leaves room for a hosted runner.
const RECONCILED_GROUPING_BOUND_MS = 20_000;

async function albumArtistFrames() {
  const snapshots = await readGeneratedMp3TagSnapshots({ artist: FIXTURE_ARTIST, album: FIXTURE_ALBUM });
  expect(snapshots).toHaveLength(FIXTURE_TRACK_COUNT);
  return snapshots.map(({ frames }) => frames?.TPE2);
}

async function editAlbumArtist({ galleryActions, trackModalActions, tagEditorActions }, fromArtist, toArtist) {
  await galleryActions.selectAlbumDetailsByIdentity({ artist: fromArtist, album: FIXTURE_ALBUM, year: FIXTURE_YEAR });
  await trackModalActions.waitForInteractiveSummary();
  await trackModalActions.openTagEditor();
  await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
  await tagEditorActions.selectAllTracks();
  await tagEditorActions.setAlbumArtist(toArtist);
  expect((await tagEditorActions.applyAndWaitForSavedFiles()).save_task_status).toBe('completed');
}

test('FTC-TAGS-045 saves edits while relations await reconciliation and parks the replay for initialization', { tag: '@area:tag-edit' }, async ({
  freshBrowserSession,
  galleryActions,
  managedAppLifecycle,
  page,
  stepLogger,
  tagEditorActions,
  trackModalActions,
}) => {
  test.setTimeout(240_000);

  await stepLogger.step('Open the gallery of a library whose relation index awaits reconciliation', async () => {
    await removeRelationCompatibilityEvidence();
    await galleryActions.goto(ROOT_GALLERY_URL);
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(FIXTURE_ARTIST, FIXTURE_ALBUM);
  });

  await stepLogger.step('Save a new album artist: it shows at once in the reopened editor and in the files', async () => {
    await editAlbumArtist({ galleryActions, trackModalActions, tagEditorActions }, FIXTURE_ARTIST, RECONCILED_ARTIST);
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
    await tagEditorActions.selectAllTracks();
    expect(await tagEditorActions.readEditableValues(['album_artist'])).toEqual({ album_artist: RECONCILED_ARTIST });
    await tagEditorActions.close();
    await trackModalActions.close();
    expect(await albumArtistFrames()).toEqual(Array(FIXTURE_TRACK_COUNT).fill([RECONCILED_ARTIST]));
  });

  await stepLogger.step('Right after the save the album is under its new artist only, in place', async () => {
    // The save publishes its own albums' gallery membership even while the relation publication waits for the
    // reconciliation replay; family and alias grouping settle after the replay.
    const scrollBefore = await galleryActions.readGalleryScrollState();
    await galleryActions.waitForGalleryReady();
    await galleryActions.waitForAlbumVisibleUnderHeading(RECONCILED_ARTIST, FIXTURE_ALBUM);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: RECONCILED_ARTIST, album: FIXTURE_ALBUM, year: FIXTURE_YEAR,
    })).toBe(1);
    expect(await galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST, album: FIXTURE_ALBUM, year: FIXTURE_YEAR,
    })).toBe(0);
    const scrollAfter = await galleryActions.readGalleryScrollState();
    expect(Math.abs(scrollAfter.scrollTop - scrollBefore.scrollTop)).toBeLessThanOrEqual(2);
  });

  let restarted = null;
  await stepLogger.step('After a restart the reconciliation parks for the explicit initialization', async () => {
    await page.goto('about:blank');
    await managedAppLifecycle.restart();
    restarted = await freshBrowserSession.create();
    await restarted.galleryActions.goto(ROOT_GALLERY_URL);
    await restarted.galleryActions.waitForGalleryReady();
    // The pending edit changed the sources since the legacy publication: only the explicit initialization can
    // prove the relation compatibility, so the owner parks once instead of retrying, and /status says so.
    await expect.poll(
      async () => (await restarted.galleryActions.readRelationProjectionReadiness()).rebuildReason,
      { timeout: RECONCILED_GROUPING_BOUND_MS },
    ).toBe('needs_initialization');
    expect((await restarted.galleryActions.readRelationProjectionReadiness()).ready).toBe(true);
    // Browsing is unaffected: the same page shows the album once under its new artist, in place.
    const scrollBefore = await restarted.galleryActions.readGalleryScrollState();
    await restarted.galleryActions.waitForAlbumVisibleUnderHeading(RECONCILED_ARTIST, FIXTURE_ALBUM);
    expect(await restarted.galleryActions.readAlbumIdentityCardCount({
      artist: RECONCILED_ARTIST, album: FIXTURE_ALBUM, year: FIXTURE_YEAR,
    })).toBe(1);
    expect(await restarted.galleryActions.readAlbumIdentityCardCount({
      artist: FIXTURE_ARTIST, album: FIXTURE_ALBUM, year: FIXTURE_YEAR,
    })).toBe(0);
    const scrollAfter = await restarted.galleryActions.readGalleryScrollState();
    expect(Math.abs(scrollAfter.scrollTop - scrollBefore.scrollTop)).toBeLessThanOrEqual(2);
  });

  await stepLogger.step('A second save while parked persists and shows once under its new artist', async () => {
    await editAlbumArtist(restarted, RECONCILED_ARTIST, PARKED_EDIT_ARTIST);
    await restarted.trackModalActions.openTagEditor();
    await restarted.tagEditorActions.waitForOpen({ expectedTrackCount: FIXTURE_TRACK_COUNT });
    await restarted.tagEditorActions.selectAllTracks();
    expect(await restarted.tagEditorActions.readEditableValues(['album_artist']))
      .toEqual({ album_artist: PARKED_EDIT_ARTIST });
    await restarted.tagEditorActions.close();
    await restarted.trackModalActions.close();
    expect(await albumArtistFrames()).toEqual(Array(FIXTURE_TRACK_COUNT).fill([PARKED_EDIT_ARTIST]));
    await restarted.galleryActions.waitForAlbumVisibleUnderHeading(PARKED_EDIT_ARTIST, FIXTURE_ALBUM);
    for (const [artist, count] of [[PARKED_EDIT_ARTIST, 1], [RECONCILED_ARTIST, 0], [FIXTURE_ARTIST, 0]]) {
      expect(await restarted.galleryActions.readAlbumIdentityCardCount({
        artist, album: FIXTURE_ALBUM, year: FIXTURE_YEAR,
      })).toBe(count);
    }
    expect((await restarted.galleryActions.readRelationProjectionReadiness()).rebuildReason)
      .toBe('needs_initialization');
  });
});
