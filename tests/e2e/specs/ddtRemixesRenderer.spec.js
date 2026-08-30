import { expect, test } from '../support/baseFixtures.js';
import { readGeneratedMp3AlbumTags } from '../helpers/physicalTagHelpers.js';

const ARTIST = 'ДДТ';
const SOURCE_ALBUM = 'Ремиксы';
const DESTINATION_ALBUM = 'Ремиксы6';
const YEAR = '2000';
const ARTIST_VIEW_URL = `/?surface=albums&artist=${encodeURIComponent(ARTIST)}`;
const TRACKS = [
  ['01. Фонограммщик.mp3', 'Фонограммщик'],
  ['02. Террорист.mp3', 'Террорист'],
  ['03. Конвейер.mp3', 'Конвейер'],
  ['04. Храм.mp3', 'Храм'],
  ['05. Российское танго.mp3', 'Российское Танго'],
  ['06. В последнюю осень.mp3', 'В последнюю осень'],
  ['07. Милиционер в рок-клубе.mp3', 'Mилиционер в рок-клубе'],
  ['08. Революция.mp3', 'Революция'],
  ['09. Мальчик слепой.mp3', 'Мальчик слепой'],
  ['10. Это все.mp3', 'Это всё'],
].map(([filename, title]) => ({ filename, title }));
const MOVE_ORDER = [
  '07. Милиционер в рок-клубе.mp3',
  '06. В последнюю осень.mp3',
  '03. Конвейер.mp3',
  '09. Мальчик слепой.mp3',
  '08. Революция.mp3',
];
const albumDetailsTitle = (album) => `${ARTIST} - ${album} - ${YEAR}`;

test('FTC-TAGS-015 preserves the surrounding DDT gallery through five Ремиксы rerenders', async ({
  freshBrowserSession,
  galleryActions,
  page,
  stepLogger,
  tagEditorActions,
  testArtifacts,
  trackModalActions,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const movedFilenames = [];
  const topologyObservations = [];
  const sourceTracks = () => TRACKS.filter(
    (track) => !movedFilenames.includes(track.filename),
  );
  const destinationTracks = () => TRACKS.filter(
    (track) => movedFilenames.includes(track.filename),
  );

  const verifyAlbum = async (album, tracks) => {
    await galleryActions.selectAlbumDetailsByIdentity({
      artist: ARTIST,
      album,
      year: YEAR,
    });
    await trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(album),
      trackTitles: tracks.map((track) => track.title),
    });
    await trackModalActions.openTagEditor();
    await tagEditorActions.waitForOpen({ expectedTrackCount: tracks.length });
    expect((await tagEditorActions.readSummary()).trackFilenames).toEqual(
      tracks.map((track) => track.filename),
    );
  };

  await stepLogger.step(
    'Open the ten-track Ремиксы fixture among the surrounding DDT album cards',
    async () => {
      await galleryActions.goto(ARTIST_VIEW_URL);
      await galleryActions.waitForGalleryReady();
      await verifyAlbum(SOURCE_ALBUM, TRACKS);
      await page.screenshot({
        path: testInfo.outputPath('ftc-tags-015-ddt-remixes-initial-editor.png'),
        fullPage: true,
      });
    },
  );

  for (const [index, filename] of MOVE_ORDER.entries()) {
    const movedCount = index + 1;
    await stepLogger.step(
      `Move ${filename} to ${DESTINATION_ALBUM} and verify both live cards`,
      async () => {
        if (index > 0) {
          await verifyAlbum(SOURCE_ALBUM, sourceTracks());
        }
        await tagEditorActions.selectTrackByFilename(filename);
        await tagEditorActions.setAlbumName(DESTINATION_ALBUM);
        movedFilenames.push(filename);
        const { actionResult, observation } =
          await galleryActions.expectStableAlbumTopologyTransitionDuring({
            artist: ARTIST,
            identities: [
              {
                album: SOURCE_ALBUM,
                trackCount: `${TRACKS.length - movedCount} tracks`,
                year: YEAR,
              },
              {
                album: DESTINATION_ALBUM,
                trackCount: movedCount === 1 ? '1 track' : `${movedCount} tracks`,
                year: YEAR,
              },
            ],
          }, (checkpoint) => tagEditorActions.applyAndObserveOptimisticState({
            expectedField: 'album',
            expectedValue: DESTINATION_ALBUM,
            expectedFilename: filename,
            readOptimisticState: (stage) => checkpoint(stage, { arm: true }),
            readCompletedState: (stage) => checkpoint(stage),
          }));
        expect(String(actionResult.payload?.save_task_id || '').trim()).not.toBe('');
        topologyObservations.push({
          transition: `move-${movedCount}`,
          filename,
          ...observation,
        });
        await trackModalActions.closeIfOpen();

        await verifyAlbum(SOURCE_ALBUM, sourceTracks());
        await tagEditorActions.close();
        await trackModalActions.close();
        await verifyAlbum(DESTINATION_ALBUM, destinationTracks());
        if (movedCount === MOVE_ORDER.length) {
          await page.screenshot({
            path: testInfo.outputPath('ftc-tags-015-ddt-remixes-after-five-moves.png'),
            fullPage: true,
          });
        }
        await tagEditorActions.close();
        await trackModalActions.close();
      },
    );
  }

  await stepLogger.step(
    'Restore all five tracks in one merge and retain every unrelated DDT card',
    async () => {
      await verifyAlbum(DESTINATION_ALBUM, destinationTracks());
      await tagEditorActions.selectAllTracks();
      await tagEditorActions.setAlbumName(SOURCE_ALBUM);
      const { actionResult, observation } =
        await galleryActions.expectStableAlbumTopologyTransitionDuring({
          artist: ARTIST,
          identities: [{
            album: SOURCE_ALBUM,
            trackCount: `${TRACKS.length} tracks`,
            year: YEAR,
          }],
          absentIdentities: [{
            album: DESTINATION_ALBUM,
            year: YEAR,
          }],
        }, (checkpoint) => tagEditorActions.applyAndObserveOptimisticState({
          expectedField: 'album',
          expectedValue: SOURCE_ALBUM,
          expectedFilenames: destinationTracks().map((track) => track.filename),
          readOptimisticState: (stage) => checkpoint(stage, { arm: true }),
          readCompletedState: (stage) => checkpoint(stage),
        }));
      expect(String(actionResult.payload?.save_task_id || '').trim()).not.toBe('');
      topologyObservations.push({
        transition: 'restore-final-merge',
        ...observation,
      });
      await trackModalActions.closeIfOpen();
      movedFilenames.length = 0;
      await galleryActions.waitForPositiveRenderedAlbumCardTrackCounts({
        artist: ARTIST,
        album: SOURCE_ALBUM,
        year: YEAR,
        trackCount: TRACKS.length,
      });
      await verifyAlbum(SOURCE_ALBUM, TRACKS);
      await tagEditorActions.close();
      await trackModalActions.close();
      await galleryActions.waitForAlbumHidden(DESTINATION_ALBUM);
    },
  );

  await stepLogger.step('Verify physical tags and a fresh-browser ten-track view', async () => {
    const physicalTags = await readGeneratedMp3AlbumTags({
      artist: ARTIST,
      album: SOURCE_ALBUM,
    });
    expect(
      physicalTags
        .map((track) => track.filename)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(
      TRACKS
        .map((track) => track.filename)
        .sort((left, right) => left.localeCompare(right)),
    );
    for (const track of physicalTags) {
      expect(track.albumValues).toEqual([SOURCE_ALBUM]);
    }

    const freshSession = await freshBrowserSession.create();
    await freshSession.galleryActions.goto(ARTIST_VIEW_URL);
    await freshSession.galleryActions.waitForGalleryReady();
    await freshSession.galleryActions.waitForAlbumHidden(DESTINATION_ALBUM);
    await freshSession.galleryActions.selectAlbumDetailsByIdentity({
      artist: ARTIST,
      album: SOURCE_ALBUM,
      year: YEAR,
    });
    await freshSession.trackModalActions.waitForExactAlbumDetails({
      title: albumDetailsTitle(SOURCE_ALBUM),
      trackTitles: TRACKS.map((track) => track.title),
    });
  });

  testArtifacts.queueJsonAttachment(
    'ftc-tags-015-ddt-remixes-topology-observations',
    topologyObservations,
  );
});
