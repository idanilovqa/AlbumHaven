// The gallery's side of returning to a place (IAR-W27): what is taken as the place, and the way back
// to it, through the gallery's own paging and scroll anchors.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'gallery-return-place.js');
const source = fs.readFileSync(helperPath, 'utf8');

const album = (id, artist) => ({ album_id: id, key: `${artist.toLowerCase()}::album ${id}`, name: `Album ${id}`, year: 2001, artist });

function page({
  laidOutAfter = 0, groups = [], place = null, paged = true, sidebar = [], fetched = [], previousPage = null, nextPages = [],
  overlay = { hidden: true, scrollTop: 0 },
} = {}) {
  const listeners = new Map();
  const calls = { fetch: [], anchors: [], opened: [], saved: [], steps: [], next: 0, done: 0 };
  const scroll = {
    scrollTop: 900, scrollHeight: 90000, getBoundingClientRect: () => ({ top: 0, height: 800, width: 1200 }),
  };
  const list = { scrollTop: 0, querySelector: () => null };
  let current = 'entry-now';
  let returning = place;
  let grid = groups;
  let sectionReads = 0;
  const sectionOf = key => grid.find(group => `artist:${group.artist}` === key);
  const context = {
    Promise, Number, String, Math,
    state: {
      busy: false,
      ui: {},
      modalReleases: [],
      modalReleaseIndex: 0,
      view: {
        artist_groups: groups, primary_artist_groups: [], family_artist_groups: [],
        artists_sidebar: sidebar, gallery_page: paged ? { has_more: true } : null,
      },
    },
    window: {
      AlbumHavenReturnPlace: {
        currentKey: () => current,
        returning: () => returning,
        placeFor: () => place,
        save: (key, value) => calls.saved.push([key, JSON.parse(JSON.stringify(value))]),
        hide: () => calls.steps.push('hide'),
        done: () => { returning = null; calls.done += 1; },
      },
      navigation: {
        get currentEntry() { return { key: current }; },
        addEventListener: (name, listener) => listeners.set(`navigation:${name}`, listener),
      },
      addEventListener: (name, listener) => listeners.set(`window:${name}`, listener),
      removeEventListener: (name) => listeners.delete(`window:${name}`),
    },
    document: {
      visibilityState: 'visible',
      getElementById: id => (id === 'albums-scroll' ? scroll : null),
      addEventListener: (name, listener) => listeners.set(`document:${name}`, listener),
      removeEventListener: (name) => listeners.delete(`document:${name}`),
    },
    getTrackModalElements: () => ({ overlay, list }),
    getCurrentTrackModalAlbum: () => context.state.modalReleases[0] || null,
    getAlbumRequestKey: value => value.key || '',
    getIndexedAlbum: key => grid.flatMap(group => group.albums).find(value => value.key === key) || null,
    isPagedRootGallery: () => paged,
    buildApiUrl: (_view, options = {}) => `/view-data?anchor=${options.galleryAnchorArtist || ''}`,
    async fetchAndRender(url, push, options) {
      calls.fetch.push({ url, push, options: { ...options } });
      grid = fetched;
      context.state.view.gallery_page = { has_more: true, has_previous: Boolean(previousPage) };
      context.state.view.artist_groups = fetched;
      return true;
    },
    isRootGalleryPageRequestLoading: () => false,
    async loadNextRootGalleryPage() {
      if (!nextPages[calls.next]) return false;
      grid = [...grid, ...nextPages[calls.next]];
      context.state.view.artist_groups = grid;
      calls.next += 1;
      return true;
    },
    async loadPreviousRootGalleryPage() {
      if (!context.state.view.gallery_page.has_previous) return false;
      grid = [...previousPage, ...grid];
      context.state.view.artist_groups = grid;
      context.state.view.gallery_page.has_previous = false;
      calls.previous = (calls.previous || 0) + 1;
      return true;
    },
    openTrackModal(value) {
      calls.opened.push(value);
      overlay.hidden = false;
    },
    scheduleBrowserAnimationFrame: callback => setImmediate(callback),
    virtualGrid: {
      get sections() {
        // A page just loaded can wait some frames to be laid out.
        sectionReads += 1;
        return (sectionReads <= laidOutAfter ? [] : grid).map(group => ({ kind: 'artist', group }));
      },
      get sectionByRenderedKey() { return { get: key => (sectionOf(key) ? { kind: 'artist', group: sectionOf(key) } : undefined) }; },
      getRenderedSectionKey: section => `artist:${section.group.artist}`,
      captureScrollAnchor: () => (grid[0] ? {
        scrollTop: scroll.scrollTop, offsetTop: -82.4,
        albumKey: grid[0].albums[0].key, sectionOccurrenceKey: `artist:${grid[0].artist}`,
      } : { scrollTop: scroll.scrollTop }),
      scrollToArtist: artist => calls.steps.push(`jump ${artist}`),
      restoreOwnedScrollAnchor(anchor) {
        calls.steps.push('anchor');
        calls.anchors.push({ ...anchor });
      },
      render() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: helperPath });
  return {
    context, calls, scroll, list, overlay, listeners,
    moveTo(key, navigationType) {
      const from = { key: current };
      current = key;
      listeners.get('navigation:currententrychange')({ navigationType, from });
    },
  };
}

const deep = [{ artist: 'Artist 041', albums: [album(1500, 'Artist 041')] }];
const first = [{ artist: 'Artist 000', albums: [album(1000, 'Artist 000')] }];
const sidebar = [{ artist: 'Artist 000' }, { artist: 'Artist 041' }];
const PLACE = { top: 48000, offset: -82, artist: 'Artist 041', album: { id: 1500 } };

test('IAR-W27: the place left is the album at the top by its id, its artist, where, and the open album', () => {
  const overlay = { hidden: false, scrollTop: 5 };
  const { context, calls, list, listeners } = page({ groups: deep, overlay });
  context.state.modalReleases = [album(1500, 'Artist 041')];
  list.scrollTop = 120;

  listeners.get('window:pagehide')();

  assert.deepEqual(calls.saved, [['entry-now', {
    top: 900, offset: -82, artist: 'Artist 041', album: { id: 1500, key: 'artist 041::album 1500' },
    open: { id: 1500, key: 'artist 041::album 1500', top: 120, page: 5 },
  }]]);
});

test('IAR-W27: a page left while still returning keeps the place it was returning to', () => {
  const { calls, listeners } = page({ groups: first, place: PLACE });

  listeners.get('window:pagehide')();

  assert.deepEqual(calls.saved, []);
});

test('IAR-W27: deep in All artists, the way back is one anchored window, then the album where it was', async () => {
  const { context, calls } = page({ groups: first, place: PLACE, sidebar, fetched: deep });

  await context.initReturnPlace();

  assert.deepEqual(calls.fetch, [{ url: '/view-data?anchor=Artist 041', push: false, options: { preserveScroll: false } }]);
  const anchor = calls.anchors.at(-1);
  assert.equal(anchor.albumKey, 'artist 041::album 1500');
  assert.equal(anchor.sectionOccurrenceKey, 'artist:Artist 041');
  assert.equal(anchor.albumName, 'Album 1500');
  assert.equal(anchor.offsetTop, -82);
  assert.equal(calls.done, 1);
});

test('IAR-W27: an album later in a long artist is reached by the next pages, a bounded number of them', async () => {
  const filler = index => [{ artist: 'Artist 041', albums: [album(2000 + index, 'Artist 041')] }];
  const found = page({ groups: first, place: PLACE, sidebar, fetched: filler(0), nextPages: [filler(1), deep] });
  await found.context.initReturnPlace();
  assert.equal(found.calls.next, 2);
  assert.equal(found.calls.anchors.at(-1).albumKey, 'artist 041::album 1500');

  const gone = page({ groups: first, place: PLACE, sidebar, fetched: filler(0), nextPages: Array.from({ length: 1000 }, (_, i) => filler(i + 1)) });
  await gone.context.initReturnPlace();
  assert.ok(gone.calls.next <= 8, `${gone.calls.next} pages`);
  assert.equal(gone.calls.done, 1, 'shown, wherever it got to');
});

test('IAR-W27: the jump comes before the anchor, so a pending reset to the top never pages up from there', async () => {
  const { context, calls } = page({ groups: first, place: PLACE, sidebar, fetched: deep });

  await context.initReturnPlace();

  assert.deepEqual(calls.steps.slice(0, 2), ['jump Artist 041', 'anchor']);
});

test('IAR-W27: Back within the page does not paint the top of the view on the way to its place', async () => {
  const { context, calls } = page({ groups: first, place: PLACE, sidebar, fetched: deep });

  context.restoreTraversedPlace();
  for (let turn = 0; turn < 200 && !calls.done; turn += 1) await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.steps[0], 'hide');
  assert.equal(calls.done, 1);
});

test('IAR-W27: offline, a kept window can start inside the artist: the page before it has the album', async () => {
  const later = [{ artist: 'Artist 041', albums: [album(1508, 'Artist 041')] }, { artist: 'Artist 042', albums: [album(1512, 'Artist 042')] }];
  const { context, calls } = page({ groups: first, place: PLACE, sidebar, fetched: later, previousPage: deep });

  await context.initReturnPlace();

  assert.equal(calls.previous, 1);
  assert.equal(calls.next, 0);
  assert.equal(calls.anchors.at(-1).albumKey, 'artist 041::album 1500');
});

test('IAR-W27: offline, an address whose first page was never kept still finds the window kept around the artist', async () => {
  const { context, calls } = page({ place: PLACE, paged: false, sidebar, fetched: deep });
  context.state.ui.galleryUnreachable = 'the library';

  await context.initReturnPlace();

  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.anchors.at(-1).albumKey, 'artist 041::album 1500');
});

test('IAR-W27: an album gone from its artist leaves the gallery at that artist, reading no further', async () => {
  const around = [{ artist: 'Artist 041', albums: [album(1501, 'Artist 041')] }, { artist: 'Artist 042', albums: [album(1512, 'Artist 042')] }];
  const { context, calls } = page({ groups: first, place: PLACE, sidebar, fetched: around, nextPages: [deep] });

  await context.initReturnPlace();

  assert.equal(calls.next, 0);
  assert.equal(calls.steps.at(-1), 'jump Artist 041');
});

test('IAR-W27: an album loaded but not yet laid out is anchored once it is, never before', async () => {
  const { context, calls } = page({ groups: deep, place: PLACE, paged: false, laidOutAfter: 5 });

  await context.initReturnPlace();

  assert.ok(calls.anchors.length > 0);
  assert.ok(calls.anchors.every(anchor => anchor.sectionOccurrenceKey === 'artist:Artist 041'));
});

test('IAR-W27: an artist no longer in the library is not asked for', async () => {
  const { context, calls } = page({ groups: first, place: PLACE, sidebar: [{ artist: 'Artist 000' }] });

  await context.initReturnPlace();

  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.done, 1);
});

test('IAR-W27: an artist view needs no request', async () => {
  const { context, calls } = page({ groups: deep, place: PLACE, paged: false });

  await context.initReturnPlace();

  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.anchors.at(-1).albumKey, 'artist 041::album 1500');
});

test('IAR-W27: the album that was open opens again, as loaded by the server', async () => {
  const { context, calls } = page({ groups: deep, place: { top: 0, open: { id: 1500, key: 'artist 041::album 1500', top: 0 } }, paged: false });

  await context.initReturnPlace();

  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0].album_id, 1500);
  assert.equal(calls.opened[0].preview_only, true);
});

test('IAR-W27: scrolling or pressing meanwhile takes over', async () => {
  const { context, calls, listeners } = page({ groups: first, place: PLACE, sidebar, fetched: deep });

  const returned = context.initReturnPlace();
  listeners.get('window:wheel')({});
  await returned;

  assert.deepEqual(calls.anchors, []);
  assert.ok(calls.done >= 1, 'shown at once');
});

test('IAR-W27: choosing another view keeps the place of the entry it came from', () => {
  const { calls, listeners, scroll, moveTo } = page({ groups: deep });

  listeners.get('document:click')();
  scroll.scrollTop = 0;
  moveTo('entry-next', 'push');

  assert.equal(calls.saved[0][0], 'entry-now');
  assert.equal(calls.saved[0][1].top, 900);
});

test('IAR-W27: neither an address correction nor a focus moved by the next render loses that place', () => {
  const { calls, listeners, scroll, moveTo } = page({ groups: deep });

  listeners.get('document:click')();
  scroll.scrollTop = 0;
  listeners.get('document:focusin')({ target: { id: 'artist-groups' } });
  listeners.get('navigation:currententrychange')({ navigationType: 'replace', from: { key: 'entry-now' } });
  moveTo('entry-next', 'push');

  assert.equal(calls.saved[0][1].top, 900);
});

test('IAR-W27: focusing search takes the place before typing pushes a search', () => {
  const { calls, listeners, scroll, moveTo } = page({ groups: deep });

  listeners.get('document:focusin')({ target: { id: 'search-input' } });
  scroll.scrollTop = 0;
  moveTo('entry-next', 'push');

  assert.equal(calls.saved[0][1].top, 900);
});

test('IAR-W27: Back within the page keeps the place of the entry it left', () => {
  const { calls, moveTo } = page({ groups: deep });

  moveTo('entry-before', 'traverse');

  assert.equal(calls.saved[0][0], 'entry-now');
  assert.equal(calls.saved[0][1].top, 900);
});

test('IAR-W27: without the page script of a copy kept by an earlier build, nothing happens', async () => {
  const { context, calls } = page({ groups: deep });
  context.window.AlbumHavenReturnPlace = undefined;

  await context.initReturnPlace();

  assert.deepEqual(calls.fetch, []);
});
