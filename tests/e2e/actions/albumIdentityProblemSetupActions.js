export async function prepareConsolidatedProblematicRelease({
  artist,
  artistViewUrl,
  fixtureYear,
  galleryActions,
  sourceAlbum,
  splitTracks,
  stepLogger,
  tagEditorActions,
  temporaryAlbum,
  trackModalActions,
  tracks,
  year,
}) {
  await stepLogger.step('Prepare the consolidated release year', async () => {
    await galleryActions.goto(artistViewUrl);
    await galleryActions.waitForGalleryReady();
    await tagEditorActions.openForAlbum({
      album: sourceAlbum,
      artist,
      expectedTrackCount: tracks.length,
      galleryActions,
      trackModalActions,
      year: fixtureYear,
    });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setYear(year);
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
    await galleryActions.goto(artistViewUrl);
    await galleryActions.waitForGalleryReady();
  });

  await stepLogger.step('Prepare a split release with two numbering problems', async () => {
    await tagEditorActions.openForAlbum({
      album: sourceAlbum,
      artist,
      expectedTrackCount: tracks.length,
      galleryActions,
      trackModalActions,
      year,
    });
    await tagEditorActions.selectTracksByFilenames(splitTracks.map((track) => track.filename));
    await tagEditorActions.setAlbumName(temporaryAlbum);
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
    await tagEditorActions.openForAlbum({
      album: temporaryAlbum,
      artist,
      expectedTrackCount: splitTracks.length,
      galleryActions,
      trackModalActions,
      year,
    });
    await tagEditorActions.selectTrackByFilename(splitTracks[0].filename);
    await tagEditorActions.setTrackNumber(18);
    await tagEditorActions.selectTrackByFilename(splitTracks[1].filename);
    await tagEditorActions.setTrackNumber('');
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
  });

  await stepLogger.step('Merge the split release into one durable problematic identity', async () => {
    await tagEditorActions.openForAlbum({
      album: temporaryAlbum,
      artist,
      expectedTrackCount: splitTracks.length,
      galleryActions,
      trackModalActions,
      year,
    });
    await tagEditorActions.selectAllTracks();
    await tagEditorActions.setAlbumName(sourceAlbum);
    await tagEditorActions.applyAndWaitForSavedFiles();
    await trackModalActions.closeIfOpen();
    await galleryActions.goto(artistViewUrl);
    await galleryActions.waitForGalleryReady();
  });
}
