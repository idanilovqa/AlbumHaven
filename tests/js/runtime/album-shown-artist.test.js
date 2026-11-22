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
  key: 'idja', name: 'Idja', year: '1999', album_artist: 'Korpiklaani', display_artist: 'Shaman',
});
const plain = () => ({ key: 'manala', name: 'Manala', year: '2012', album_artist: 'Korpiklaani' });
const escapeHtml = (value) => String(value ?? '');

test('the phone page subtitle names the artist as the card does', () => {
  const context = load('mobile-navigation.js', ['mobilePageDescriptor'], {
    getAlbumRequestKey: (album) => album.key, state: { utility: {} },
  });
  for (const kind of ['album', 'cover-lookup']) {
    assert.match(context.mobilePageDescriptor(kind, credited()).subtitle, /Shaman · 1999/);
    assert.doesNotMatch(context.mobilePageDescriptor(kind, credited()).subtitle, /Korpiklaani/);
    assert.match(context.mobilePageDescriptor(kind, plain()).subtitle, /Korpiklaani · 2012/);
  }
});

test('the Cover Look Up subtitle and split chooser name the artist as the card does; the search keeps the tag', () => {
  const context = load('cover-lookup-modal-and-drawer.js', [
    'buildCoverLookupAlbumSubtitleHtml', 'buildCoverLookupCurrentReleaseLabel', 'buildCoverLookupSearchQuery',
  ], { escapeHtml });
  assert.match(context.buildCoverLookupAlbumSubtitleHtml(credited()), />Shaman</);
  assert.match(context.buildCoverLookupAlbumSubtitleHtml(plain()), />Korpiklaani</);
  assert.equal(context.buildCoverLookupCurrentReleaseLabel(credited()), 'Shaman · Idja · 1999');
  assert.equal(context.buildCoverLookupCurrentReleaseLabel(plain()), 'Korpiklaani · Manala · 2012');
  assert.match(context.buildCoverLookupSearchQuery(credited()), /^Korpiklaani /);
});

test('the Album Details loading title names the artist as the card does', () => {
  for (const [album, title] of [[credited(), 'Shaman - Idja - 1999'], [plain(), 'Korpiklaani - Manala - 2012']]) {
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
  for (const [album, artist] of [[credited(), 'Shaman'], [plain(), 'Korpiklaani']]) {
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
    { path: 'one', artist: 'Korpiklaani' }, { path: 'guest', artist: 'A Guest' },
    { path: 'corrected', artist: 'korpiklani', display_artist: 'Corrected Artist' },
  ] };
  const track = { path: 'one', title: 'Idja', artist: 'Korpiklaani' };
  assert.equal(playerText({ mobile: true, album, track }), 'Shaman');
  assert.equal(playerText({ mobile: false, album, track }), 'Shaman - Idja');
  assert.equal(track.artist, 'Korpiklaani', 'scrobbles and identities keep the tag');

  assert.equal(playerText({ mobile: true, album, track: { path: 'guest', artist: 'A Guest' } }), 'A Guest');
  assert.equal(playerText({ mobile: true, album, track: { path: 'corrected', artist: 'korpiklani' } }), 'Corrected Artist');
  // Another album's track, or no album known: the track's own artist.
  assert.equal(playerText({ mobile: true, album, track: { path: 'elsewhere', artist: 'Korpiklaani' } }), 'Korpiklaani');
  assert.equal(playerText({ mobile: true, album: null, track }), 'Korpiklaani');
});
