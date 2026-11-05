const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const read = (file) => fs.readFileSync(path.join(runtimeRoot, file), 'utf8');

function load(overrides = {}) {
  const menu = { hidden: true, dataset: {}, style: {}, innerHTML: '' };
  const calls = { fetches: [], lookups: [], renders: 0, toasts: [], closed: 0 };
  const context = vm.createContext({
    console,
    URL,
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    state: { modalReleases: [], modalReleaseIndex: 0, coverLookup: { modal: {} } },
    albumHasDisplayCover: (album) => Boolean(album?.cover_path),
    buildAlbumDisplayCoverUrl: (album) => `/cover?path=${album.cover_path || album.remote_cover_url}`,
    ensureAlbumCardContextMenu: () => menu,
    hideAlbumCardContextMenu: () => { menu.hidden = true; },
    renderTrackModalRelease: () => { calls.renders += 1; },
    openCoverLookupModal: (album, options) => { calls.lookups.push([album.key, options]); },
    closeCoverLookupModal: () => { calls.closed += 1; },
    syncCoverLookupSaveButton: () => {},
    showToast: (message) => calls.toasts.push(message),
    hasPendingLocalCoverSelection: () => Boolean(context.state.coverLookup.modal.pendingLocalPath),
    fetch: async (url, options) => {
      calls.fetches.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, additional_artworks: overrides.savedArtworks || [] }) };
    },
    ...overrides.context,
  });
  vm.runInContext(read('album-artbox.js'), context);
  vm.runInContext(read('album-additional-artbox.js'), context);
  return { context, menu, calls };
}

const testimony = () => ({ key: 'neal-morse::testimony', name: 'Testimony', cover_path: 'D:/Music/Testimony/cover.jpg' });

test('the first artbox offers Add another artbox only when it has art and no second artbox', () => {
  const { context, menu } = load();
  context.state.modalReleases = [testimony()];
  assert.equal(context.showAlbumArtboxContextMenu(10, 20, 0), true);
  assert.match(menu.innerHTML, /data-album-card-action="add-artbox">Add another artbox</);

  context.state.modalReleases = [{ key: 'no-art', name: 'No art' }];
  assert.equal(context.showAlbumArtboxContextMenu(10, 20, 0), false, 'an album without art cannot add an artbox');

  context.state.modalReleases = [{ ...testimony(), additional_artworks: [{ slot: 1, source_kind: 'local', cover_path: 'D:/Music/Testimony/back.jpg' }] }];
  assert.equal(context.showAlbumArtboxContextMenu(10, 20, 0), false, 'at most two artboxes');
  assert.equal(context.showAlbumArtboxContextMenu(10, 20, 1), true);
  assert.match(menu.innerHTML, /data-album-card-action="remove-artbox">Remove artbox</);
});

test('a new second artbox shows a plain + Add art box and disappears when Album Details closes', () => {
  const { context, calls } = load();
  context.state.modalReleases = [testimony()];
  context.beginAlbumAdditionalArtbox();
  assert.equal(calls.renders, 1);
  const html = context.buildAlbumAdditionalArtboxHtml(testimony());
  assert.match(html, /album-artbox--add/);
  assert.match(html, /class="album-artbox__add" data-open-additional-artbox="1"><span class="album-artbox__add-plus" aria-hidden="true">\+<\/span><span>Add art<\/span>/);
  context.openAlbumAdditionalArtboxLookup();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.lookups)), [['neal-morse::testimony', { artboxSlot: 1 }]], 'the same Cover Look Up opens for slot 1');

  context.clearPendingAlbumAdditionalArtbox();
  assert.equal(context.buildAlbumAdditionalArtboxHtml(testimony()), '', 'an empty artbox never outlives Album Details');
});

test('a saved second artbox renders its own art and keeps the main cover separate', () => {
  const { context } = load();
  const album = { ...testimony(), additional_artworks: [{ slot: 1, source_kind: 'local', cover_path: 'D:/Music/Testimony/back.jpg' }] };
  const html = context.buildAlbumAdditionalArtboxHtml(album);
  assert.match(html, /data-artbox-slot="1"/);
  assert.match(html, /src="\/cover\?path=D:\/Music\/Testimony\/back\.jpg"/);
  assert.doesNotMatch(html, /cover\.jpg/);
});

test('Cover Look Up for the second artbox blocks the first artbox art', () => {
  const { context } = load();
  context.state.coverLookup.modal = { artboxSlot: 1, album: { ...testimony(), remote_cover_url: 'https://img.example/front.jpg' } };
  assert.equal(context.isCoverLookupItemInFirstArtbox({ path: 'D:/Music/Testimony/cover.jpg' }, 'local'), true);
  assert.equal(context.isCoverLookupItemInFirstArtbox({ path: 'D:/Music/Testimony/back.jpg' }, 'local'), false);
  assert.equal(context.isCoverLookupItemInFirstArtbox({ url: 'https://img.example/front.jpg' }, 'remote'), true);
  assert.equal(context.isCoverLookupItemInFirstArtbox({}, 'saved-remote'), true);
  context.state.coverLookup.modal.artboxSlot = 0;
  assert.equal(context.isCoverLookupItemInFirstArtbox({ path: 'D:/Music/Testimony/cover.jpg' }, 'local'), false, 'the album cover lookup is unchanged');
});

test('saving the second artbox posts slot 1 and updates Album Details', async () => {
  const saved = [{ slot: 1, source_kind: 'remote', remote_cover_url: 'https://img.example/back.jpg' }];
  const { context, calls } = load({ savedArtworks: saved });
  const album = testimony();
  context.state.modalReleases = [album];
  context.state.coverLookup.modal = {
    artboxSlot: 1, album, selectedRemoteId: 'c2',
    possibleMatches: [{ id: 'c1', url: 'https://img.example/front.jpg' }, { id: 'c2', url: 'https://img.example/back.jpg' }],
  };
  await context.saveAdditionalArtworkFromLookup();
  assert.equal(calls.fetches[0].url, '/utilities/cover-lookup/additional-artwork');
  assert.deepEqual(calls.fetches[0].body, { album: testimony(), slot: 1, source_kind: 'remote', remote_url: 'https://img.example/back.jpg' });
  assert.deepEqual(JSON.parse(JSON.stringify(album.additional_artworks)), saved);
  assert.equal(calls.closed, 1);
  assert.equal(calls.renders, 1);
});

test('Album Details link row shows only known Discogs and MusicBrainz release pages', () => {
  const context = vm.createContext({ URL, escapeHtml: (value) => String(value ?? '').replaceAll('"', '&quot;') });
  vm.runInContext(read('album-details-components.js'), context);
  const html = context.buildAlbumServiceLinksHtml([
    { provider: 'discogs', url: 'https://www.discogs.com/release/663181' },
    { provider: 'musicbrainz', url: 'https://musicbrainz.org/release/abc' },
    { provider: 'discogs', url: 'https://evil.example/release/1' },
    { provider: 'musicbrainz', url: 'http://musicbrainz.org/release/abc' },
    { provider: 'spotify', url: 'https://open.spotify.com/album/x' },
  ]);
  assert.equal((html.match(/album-details-service-link"/g) || []).length, 2);
  assert.match(html, /service-discogs\.png" alt="" width="16" height="16"><span class="album-details-service-link__label">Discogs</);
  assert.match(html, /service-musicbrainz\.png[^>]*><span class="album-details-service-link__label">MusicBrainz</);
  assert.equal(context.buildAlbumServiceLinksHtml([]), '', 'no known release page, no link row');
});

test('AlbumTrackTable renders a named section as a shaded row before its first track', () => {
  const context = vm.createContext({ escapeHtml: (value) => String(value ?? ''), ButtonComponent: require(path.join(runtimeRoot, '..', 'button-component.js')) });
  vm.runInContext(read('compact-data-table.js'), context);
  vm.runInContext(read('album-track-table.js'), context);
  const html = context.buildAlbumTrackTableHtml({
    groups: [{ discNumber: 1, tracks: [
      { path: 'a', title: 'At the Fathomless Depths', trackNumber: 1, sectionTitle: "Storm of the Light's Bane" },
      { path: 'b', title: "Night's Blood", trackNumber: 2 },
      { path: 'c', title: 'Where Dead Angels Lie (Demo)', trackNumber: 3, sectionTitle: 'Where Dead Angels Lie' },
    ] }],
    totalLength: '1h 5m',
  });
  assert.equal((html.match(/class="compact-data-table"/g) || []).length, 1, 'sections stay inside one table');
  const first = html.indexOf("Storm of the Light's Bane");
  const second = html.indexOf('>Where Dead Angels Lie<');
  assert.ok(first < html.indexOf('At the Fathomless Depths') && html.indexOf("Night's Blood") < second && second < html.indexOf('Where Dead Angels Lie (Demo)'));
  assert.match(html, /compact-data-table-row--full-span album-track-table__section-row"[^>]*aria-label="Where Dead Angels Lie"/);
  assert.equal((html.match(/class="album-track-table__total"/g) || []).length, 1, 'one Total Length for the album');
});
