export const MORSE_CANONICAL_ARTIST = 'Morse Portnoy George';
export const MORSE_ALIAS_ARTIST = 'Morse, Portnoy & George';
export const MORSE_ALBUMS = [
  { album: 'Cover to Cover', credit: MORSE_CANONICAL_ARTIST, year: 2006 },
  { album: 'Cover 2 Cover', credit: MORSE_ALIAS_ARTIST, year: 2012 },
];
export const NEAL_MORSE_RETAINED_ALBUM = 'Joseph: Part One - The Dreamer';

export function expectNealMorseScrollResetViewport(expect, viewport) {
  expect(viewport.scroll.scrollTop).toBeLessThanOrEqual(2);
  expect(viewport.heading).toMatchObject({ attached: true, intersects: true, offscreen: false });
  expect(viewport.firstAlbum).toMatchObject({
    attached: true,
    intersects: true,
    offscreen: false,
  });
  expect(viewport.retainedAlbum).toMatchObject({
    attached: true,
    intersects: false,
    offscreen: true,
  });
}

export const WHITESPACE_DISPLAY_ARTIST = 'Signal  Family Lead';
export const WHITESPACE_SEARCH_ARTIST = 'Signal Family Lead';
export const WHITESPACE_RELATED_ARTIST = 'Signal Family Relative';
export const WHITESPACE_ALBUM = 'Double Space Signal';
export const WHITESPACE_ALBUM_YEAR = 2011;
export const WHITESPACE_RELATED_ALBUM = 'Relative Signal';

export const EMPTY_KEY_ARTISTS = [
  { artist: '東京事変', album: 'Tokyo Signal' },
  { artist: 'Борис', album: 'Boris Signal' },
  { artist: '!!!', album: 'Three Bangs' },
  { artist: '***', album: 'Three Stars' },
];

export function expectedOtherEmptyKeyAlbums(selectedArtist) {
  return EMPTY_KEY_ARTISTS
    .filter(({ artist }) => artist !== selectedArtist)
    .map(({ album }) => album);
}

export function expectStartupProjectionRebuilt(expect, readiness) {
  expect(readiness).toEqual({
    ready: true,
    startupRebuilt: true,
    rebuildReason: 'missing_projection',
    durationMs: expect.any(Number),
  });
  expect(readiness.durationMs).toBeGreaterThan(0);
}

export async function expectPostgresBrowse(expect, galleryActions) {
  expect(await galleryActions.readBrowseTelemetry()).toEqual({
    persistenceBackend: 'postgres',
    persistenceSeam: 'library_browse',
    viewDataSource: 'postgres_library_browse',
  });
}

export async function expectMorseAlbums(expect, galleryActions) {
  for (const fixture of MORSE_ALBUMS) {
    await galleryActions.waitForAlbumVisibleUnderHeading(MORSE_CANONICAL_ARTIST, fixture.album);
  }
  const visibleAlbumNames = await galleryActions.readAlbumNamesByHeading(MORSE_CANONICAL_ARTIST);
  expect(visibleAlbumNames).toEqual(MORSE_ALBUMS.map(({ album }) => album));
  for (const fixture of MORSE_ALBUMS) {
    const credit = await galleryActions.readAlbumCreditByName(fixture.album);
    expect(credit).toBe(fixture.credit);
    expect(await galleryActions.readAlbumYearByName(fixture.album)).toBe(String(fixture.year));
  }
}
