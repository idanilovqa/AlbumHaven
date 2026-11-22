// "Same as the card": the surfaces that name an album's artist follow display_artist (an applied
// MusicBrainz correction, else the name the album's release credits), and never change the tag.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtime = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');

function load(file, names, context = {}) {
  const source = fs.readFileSync(path.join(runtime, file), 'utf8').replaceAll('\r\n', '\n');
  vm.createContext(context);
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 3), context);
  }
  return context;
}

const credited = () => ({
  key: 'first', name: 'First Embers', year: '1999', album_artist: 'Brackenfold Choir', display_artist: 'Quillmere Duo',
});
const plain = () => ({ key: 'winter', name: 'Winter Embers', year: '2012', album_artist: 'Brackenfold Choir' });
const escapeHtml = (value) => String(value ?? '');

test('the phone page subtitle names the artist as the card does', () => {
  const context = load('mobile-navigation.js', ['mobilePageDescriptor'], {
    getAlbumRequestKey: (album) => album.key, state: { utility: {} },
  });
  for (const kind of ['album', 'cover-lookup']) {
    assert.match(context.mobilePageDescriptor(kind, credited()).subtitle, /Quillmere Duo · 1999/);
    assert.doesNotMatch(context.mobilePageDescriptor(kind, credited()).subtitle, /Brackenfold Choir/);
    assert.match(context.mobilePageDescriptor(kind, plain()).subtitle, /Brackenfold Choir · 2012/);
  }
});

test('the Cover Look Up subtitle and split chooser name the artist as the card does; the search keeps the tag', () => {
  const context = load('cover-lookup-modal-and-drawer.js', [
    'buildCoverLookupAlbumSubtitleHtml', 'buildCoverLookupCurrentReleaseLabel', 'buildCoverLookupSearchQuery',
  ], { escapeHtml });
  assert.match(context.buildCoverLookupAlbumSubtitleHtml(credited()), />Quillmere Duo</);
  assert.match(context.buildCoverLookupAlbumSubtitleHtml(plain()), />Brackenfold Choir</);
  assert.equal(context.buildCoverLookupCurrentReleaseLabel(credited()), 'Quillmere Duo · First Embers · 1999');
  assert.equal(context.buildCoverLookupCurrentReleaseLabel(plain()), 'Brackenfold Choir · Winter Embers · 2012');
  assert.match(context.buildCoverLookupSearchQuery(credited()), /^Brackenfold Choir /);
});

test('the Album Details loading title names the artist as the card does', () => {
  for (const [album, title] of [[credited(), 'Quillmere Duo - First Embers - 1999'], [plain(), 'Brackenfold Choir - Winter Embers - 2012']]) {
    const els = { overlay: {}, title: {}, subtitle: {} };
    const context = load('track-modal-lightbox-helpers.js', ['renderTrackModalLoadingState'], {
      getTrackModalElements: () => els,
      buildAlbumArtboxHtml: () => { throw new Error('past the title'); },
    });
    try { context.renderTrackModalLoadingState(album); } catch { /* only the title matters here */ }
    assert.equal(els.title.textContent, title);
  }
});

test('the version chooser names the artist as the card does', () => {
  class HTMLElement {}
  class HTMLButtonElement extends HTMLElement {}
  for (const [album, artist] of [[credited(), 'Quillmere Duo'], [plain(), 'Brackenfold Choir']]) {
    const description = new HTMLElement();
    const found = {
      '[data-version-picker-description]': description,
      '[data-version-picker-list]': new HTMLElement(),
      '[data-save-version-picker="1"]': new HTMLButtonElement(),
    };
    const context = load('modal-and-overlay-helpers.js', ['renderVersionPickerModal'], {
      HTMLElement, HTMLButtonElement, escapeHtml,
      state: { versionPicker: { album, selectedTargetKey: '' } },
      ensureVersionPickerModal: () => ({ querySelector: (selector) => found[selector] }),
      getVersionPickerCandidates: () => [],
    });
    try { context.renderVersionPickerModal(); } catch { /* only the description matters here */ }
    assert.equal(description.textContent, `Choose which ${artist} album should own "${album.name}" as a version.`);
  }
});

function playerText({ mobile, album, track }) {
  const els = { artist: { hidden: false }, title: {} };
  const context = load('player-loop-playback.js', ['playerShownArtist', 'renderGlobalPlayerMetadata'], {
    state: { player: { playbackQueue: album ? { albumSnapshot: album } : null } },
    usesMobilePageLayout: () => mobile,
    syncGlobalPlayerMetadataMotion: () => {},
  });
  context.renderGlobalPlayerMetadata(els, track);
  return mobile ? els.artist.textContent : els.title.textContent;
}

test('the player names the artist as the card does on phone and desktop, and keeps guests and the tag', () => {
  const album = { ...credited(), tracks: [
    { path: 'one', artist: 'Brackenfold Choir' }, { path: 'guest', artist: 'A Guest' },
    { path: 'corrected', artist: 'brackenfld', display_artist: 'Corrected Artist' },
  ] };
  const track = { path: 'one', title: 'First Embers', artist: 'Brackenfold Choir' };
  assert.equal(playerText({ mobile: true, album, track }), 'Quillmere Duo');
  assert.equal(playerText({ mobile: false, album, track }), 'Quillmere Duo - First Embers');
  assert.equal(track.artist, 'Brackenfold Choir', 'scrobbles and identities keep the tag');

  assert.equal(playerText({ mobile: true, album, track: { path: 'guest', artist: 'A Guest' } }), 'A Guest');
  assert.equal(playerText({ mobile: true, album, track: { path: 'corrected', artist: 'brackenfld' } }), 'Corrected Artist');
  // Another album's track, or no album known: the track's own artist.
  assert.equal(playerText({ mobile: true, album, track: { path: 'elsewhere', artist: 'Brackenfold Choir' } }), 'Brackenfold Choir');
  assert.equal(playerText({ mobile: true, album: null, track }), 'Brackenfold Choir');
});
