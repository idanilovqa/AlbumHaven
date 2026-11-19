const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPendingProjectionFetch } = require('../helpers/pending-projection-fetch');
const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/gallery-refresh-and-status.js'), 'utf8');
// The visible-artist lookup a refresh falls back to when no album anchor is captured.
const galleryMainSource = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/gallery-main-interactions.js'), 'utf8');
function fixture({ mobile = false } = {}) {
  const pending = [], renders = [], timers = [];
  const scroll = { scrollTop: 0, clientHeight: 500, scrollHeight: 1000 };
  const semanticScrollAnchor = { albumKey: 'a1', offset: 24, scrollLeft: 0, scrollTop: 400 };
  const state = { ui: {}, busy: false, view: { query: '', selected_artist: '', surface_request: 'albums', artist_count: 6045, album_count: 20000, artists_sidebar: [{ artist: 'A', count: 5 }], artist_groups: [{ artist: 'A', albums: [{ key: 'a1' }] }], gallery_page: { next_cursor: 'page-1', revision: 'r1', has_more: true, page_size: 8 } } };
  const context = vm.createContext({ state, URL, URLSearchParams, AbortController, console, window: { innerWidth: mobile ? 390 : 1024, location: { href: 'https://localhost/', assign() {} }, matchMedia: query => ({ matches: mobile && /max-width/.test(query) }) }, document: { documentElement: { clientWidth: mobile ? 390 : 1024 }, getElementById: id => id === 'albums-scroll' ? scroll : null }, virtualGrid: { captureScrollAnchor: () => semanticScrollAnchor, getUserScrollIntentGeneration: () => 7 }, buildApiUrl: () => '/view-data?surface=albums', getAlbumCardRenderKey: album => album.key, applyViewPayload: data => { state.view = { ...state.view, ...data }; }, renderArtistGroups: options => renders.push(options), scheduleBrowserAnimationFrame: callback => timers.push(callback), showToast() {}, fetch: (url, options) => new Promise((resolve, reject) => pending.push({ url, options, resolveResponse: resolve, resolve: data => resolve({ ok: true, status: 200, json: async () => data }), reject })) });
  loadPendingProjectionFetch(context);
  vm.runInContext(galleryMainSource, context);
  vm.runInContext(source, context);
  return { context, state, scroll, pending, renders, timers, semanticScrollAnchor };
}
const page = (groups, extra = {}) => ({ artist_groups: groups, gallery_page: { next_cursor: null, revision: 'r1', has_more: false, page_size: 50 }, ...extra });
test('root page appends split artist albums without duplicates and preserves authoritative sidebar/totals', async () => {
  const f = fixture(); const sidebar = f.state.view.artists_sidebar;
  const promise = f.context.loadNextRootGalleryPage();
  assert.equal(f.pending.length, 1); assert.match(f.pending[0].url, /gallery_cursor=page-1/); assert.match(f.pending[0].url, /gallery_page_size=50/); assert.match(f.pending[0].url, /omit_sidebar=1/);
  f.pending[0].resolve(page([{ artist: 'A', albums: [{ key: 'a1' }, { key: 'a2' }] }, { artist: 'B', albums: [{ key: 'a1' }] }]));
  assert.equal(await promise, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.view.artist_groups)), [{ artist: 'A', albums: [{ key: 'a1' }, { key: 'a2' }] }, { artist: 'B', albums: [{ key: 'a1' }] }]);
  assert.equal(f.state.view.artists_sidebar, sidebar); assert.equal(f.state.view.artist_count, 6045); assert.equal(f.state.view.album_count, 20000);
  assert.equal(f.renders[0].preserveScroll, true); assert.equal(f.renders[0].preserveMountedGalleryChildren, true);
  assert.deepEqual(f.renders[0].semanticScrollAnchor, f.semanticScrollAnchor);
  assert.equal(f.renders[0].semanticScrollOwnerGeneration, 7);
});

test('forward continuation preserves anchored backward-page ownership', async () => {
  const f = fixture();
  f.state.view.gallery_page = {
    ...f.state.view.gallery_page,
    previous_cursor: 'page-before-anchor',
    has_previous: true,
  };

  const request = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve(page([{ artist: 'B', albums: [{ key: 'b1' }] }]));
  assert.equal(await request, true);
  assert.equal(f.state.view.gallery_page.previous_cursor, 'page-before-anchor');
  assert.equal(f.state.view.gallery_page.has_previous, true);
});

test('root page loads only near end, with one in-flight owner', async () => {
  const f = fixture(); f.scroll.scrollHeight = 5000;
  assert.equal(await f.context.loadNextRootGalleryPage(), false); assert.equal(f.pending.length, 0);
  f.scroll.scrollTop = 3500; const first = f.context.loadNextRootGalleryPage();
  assert.equal(await f.context.loadNextRootGalleryPage(), false); assert.equal(f.pending.length, 1);
  f.pending[0].resolve(page([])); await first;
});
test('root page measures its prefetch threshold to the last loaded artist, not held space below it', async () => {
  const f = fixture(); f.scroll.scrollHeight = 20000; f.scroll.scrollTop = 1000;
  f.context.virtualGrid = { ...f.context.virtualGrid, heldTrailingSpace: 15000 };
  const request = f.context.loadNextRootGalleryPage();
  assert.equal(f.pending.length, 1, 'the loaded artists end near the viewport');
  f.pending[0].resolve(page([])); await request;
});
test('root page prefetches eight viewports ahead on desktop and mobile with one in-flight owner', async () => {
  const desktop = fixture();
  desktop.scroll.clientHeight = 632;
  desktop.scroll.scrollHeight = 8285;
  desktop.scroll.scrollTop = 2913;
  const desktopRequest = desktop.context.loadNextRootGalleryPage();
  assert.equal(desktop.pending.length, 1, 'desktop must prefetch before scrolling can reach the old extent');
  assert.equal(await desktop.context.loadNextRootGalleryPage(), false);
  assert.equal(desktop.pending.length, 1, 'desktop prefetch keeps one request owner');
  desktop.pending[0].resolve(page([]));
  assert.equal(await desktopRequest, true);

  const mobile = fixture({ mobile: true });
  mobile.scroll.clientHeight = 632;
  mobile.scroll.scrollHeight = 8285;
  mobile.scroll.scrollTop = 2913;
  const first = mobile.context.loadNextRootGalleryPage();
  assert.equal(mobile.pending.length, 1, 'mobile must start before a fast flick can reach the old extent');
  assert.equal(await mobile.context.loadNextRootGalleryPage(), false);
  assert.equal(mobile.pending.length, 1, 'mobile prefetch keeps one request owner');
  mobile.pending[0].resolve(page([]));
  assert.equal(await first, true);
});
test('short initial page fills viewport but full buffer does not idle-drain', async () => {
  const f = fixture(); f.scroll.scrollHeight = 300; const first = f.context.loadNextRootGalleryPage();
  f.scroll.scrollHeight = 5000;
  f.pending[0].resolve(page([{ artist: 'B', albums: [{ key: 'b' }] }], { gallery_page: { next_cursor: 'page-2', revision: 'r1', has_more: true } })); await first;
  for (const callback of f.timers.splice(0)) await callback();
  assert.equal(f.pending.length, 1);
});
for (const change of ['query', 'selected_artist', 'revision']) test(`stale root continuation cannot replace new ${change}`, async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage();
  if (change === 'revision') f.state.ui.viewStateRevision = 1; else f.state.view[change] = 'new';
  f.pending[0].resolve(page([{ artist: 'stale', albums: [{ key: 'stale' }] }]));
  assert.equal(await first, false); assert.equal(f.renders.length, 0); assert.equal(f.state.view.artist_groups[0].artist, 'A');
});
test('catalog revision mismatch keeps mounted page and refuses mixed snapshots', async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve(page([{ artist: 'stale', albums: [] }], { gallery_page: { next_cursor: null, revision: 'r2', has_more: false } }));
  assert.equal(await first, false); assert.equal(f.renders.length, 0); assert.equal(f.state.view.artist_groups[0].artist, 'A');
});
test('failed continuation keeps cards and releases request for later user retry', async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage(); f.pending[0].reject(new Error('offline'));
  assert.equal(await first, false); assert.equal(f.renders.length, 0);
  const second = f.context.loadNextRootGalleryPage(); assert.equal(f.pending.length, 2); f.pending[1].resolve(page([])); await second;
});
test('explicit navigation aborts continuation without taking foreground request slot', async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage(); assert.equal(f.state.busy, false);
  f.context.claimLocalViewStateNavigation(); assert.equal(f.pending[0].options.signal.aborted, true);
  f.pending[0].resolve(page([])); assert.equal(await first, false);
});

test('search and selected artist views never fetch a root continuation', async () => {
  for (const field of ['query', 'selected_artist']) {
    const f = fixture(); f.state.view[field] = 'Neal Morse';
    assert.equal(await f.context.loadNextRootGalleryPage(), false); assert.equal(f.pending.length, 0);
  }
});
test('nonadvancing cursor cannot idle-loop or duplicate mounted albums', async () => {
  const f = fixture(); const first = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve(page([{ artist: 'A', albums: [{ key: 'a2' }] }], { gallery_page: { next_cursor: 'page-1', revision: 'r1', has_more: true } }));
  assert.equal(await first, false); assert.equal(f.renders.length, 0); assert.equal(f.timers.length, 0);
});

test('stale cursor restarts one bounded page without clearing mounted cards', async () => {
  const f = fixture(); const old = f.state.view;
  f.context.fetch = (url, options) => new Promise(resolve => f.pending.push({ url, options, resolve }));
  f.context.renderView = options => f.renders.push(options);
  const first = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve({ status: 409, ok: false, json: async () => ({ restart_required: true }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pending.length, 2); assert.equal(f.state.view, old);
  assert.equal(new URL(f.pending[1].url, 'https://localhost').searchParams.has('gallery_cursor'), false);
  assert.equal(new URL(f.pending[1].url, 'https://localhost').searchParams.has('omit_sidebar'), false);
  f.pending[1].resolve({ status: 200, ok: true, json: async () => page([{ artist: 'New', albums: [{ key: 'new' }] }], { artists_sidebar: [{ artist: 'New', count: 1 }], artist_count: 1, album_count: 1, gallery_page: { revision: 'r2', has_more: false, next_cursor: null } }) });
  assert.equal(await first, true); assert.equal(f.state.view.artist_groups[0].artist, 'New'); assert.equal(f.state.view.artist_count, 1);
});

test('stale cursor recovery retains the mounted artist window instead of returning to the root', async () => {
  const f = fixture();
  f.scroll.scrollTop = 300;
  f.state.view.artist_groups = [{ artist: 'Hamster Theater', albums: [{ key: 'public-execution' }] }];
  f.state.view.gallery_page.anchor_artist = 'Earlier jump target';
  f.context.fetch = (url, options) => new Promise(resolve => f.pending.push({ url, options, resolve }));
  f.context.renderView = options => f.renders.push(options);
  const request = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve({ status: 409, ok: false, json: async () => ({ restart_required: true }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pending.length, 2);
  const recoveryUrl = new URL(f.pending[1].url, 'https://localhost');
  f.pending[1].resolve({
    status: 200, ok: true,
    json: async () => page(f.state.view.artist_groups, {
      gallery_page: { revision: 'r2', has_more: false, next_cursor: null },
    }),
  });
  assert.equal(await request, true);
  assert.equal(recoveryUrl.searchParams.get('gallery_anchor_artist'), 'Hamster Theater');
  assert.equal(recoveryUrl.searchParams.has('gallery_cursor'), false);
});

test('stale cursor recovery rejects later continuation churn without restarting again', async () => {
  const f = fixture();
  const groups = Array.from({ length: 75 }, (_, index) => ({
    artist: `Retained ${index}`, albums: [{ key: `retained-${index}` }],
  }));
  f.state.view.artist_groups = groups;
  f.context.fetch = (url, options) => new Promise(resolve => f.pending.push({ url, options, resolve }));
  f.context.renderView = options => f.renders.push(options);

  const request = f.context.loadNextRootGalleryPage();
  f.pending[0].resolve({ status: 409, ok: false, json: async () => ({ restart_required: true }) });
  await new Promise(resolve => setImmediate(resolve));
  f.pending[1].resolve({ status: 409, ok: false, json: async () => ({ restart_required: true }) });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(f.pending.length, 2, 'a second conflict must not consume another restart');
  assert.equal(await request, false);
  assert.equal(f.state.view.artist_groups, groups);
  assert.equal(f.renders.length, 0);
});

test('stale cursor recovery survives deletion of the first retained artist', async () => {
  const f = fixture();
  f.scroll.scrollTop = 300;
  const surviving = { artist: 'Survivor', albums: [{ key: 'surviving-release' }] };
  f.state.view.artist_groups = [
    { artist: 'Deleted artist', albums: [{ key: 'deleted-release' }] }, surviving,
  ];
  const requests = [];
  f.context.renderView = options => f.renders.push(options);
  f.context.fetch = async url => {
    requests.push(url);
    const params = new URL(url, 'https://localhost').searchParams;
    if (params.has('gallery_cursor')) {
      return { status: 409, ok: false, json: async () => ({ restart_required: true }) };
    }
    if (params.get('gallery_anchor_artist') === 'Deleted artist') {
      return { status: 400, ok: false, json: async () => ({ error: 'Gallery artist anchor is unavailable.' }) };
    }
    return { status: 200, ok: true, json: async () => page([surviving], {
      gallery_page: { revision: 'r2', has_more: false, next_cursor: null },
    }) };
  };
  assert.equal(await f.context.loadNextRootGalleryPage(), true);
  assert.equal(f.state.view.artist_groups[0].artist, 'Survivor');
  assert.ok(requests.length <= 4, 'missing-anchor recovery must remain bounded');
});

test('stale cursor recovery caps missing retained-artist requests', async () => {
  const f = fixture();
  f.scroll.scrollTop = 300;
  const retained = Array.from({ length: 12 }, (_, index) => ({
    artist: `Missing ${index}`, albums: [{ key: `missing-${index}` }],
  }));
  f.state.view.artist_groups = retained;
  f.context.renderView = options => f.renders.push(options);
  const requests = [];
  f.context.fetch = async url => {
    requests.push(url);
    if (new URL(url, 'https://localhost').searchParams.has('gallery_cursor')) {
      return { status: 409, ok: false, json: async () => ({ restart_required: true }) };
    }
    return {
      status: 400,
      ok: false,
      json: async () => ({ error: 'Gallery artist anchor is unavailable.' }),
    };
  };

  assert.equal(await f.context.loadNextRootGalleryPage(), false);
  assert.equal(requests.length, 8, 'the original cursor request counts toward the recovery cap');
  assert.equal(f.state.view.artist_groups, retained);
  assert.equal(f.renders.length, 0);
});

test('stale cursor recovery recognizes the trailing release after its rating changes', async () => {
  const f = fixture();
  f.scroll.scrollTop = 300;
  f.state.view.artist_groups = [{ artist: 'Retained artist', albums: [{ key: 'tail', rating: 1 }] }];
  // A render fingerprint changes with presentation metadata; identity does not.
  f.context.getAlbumCardRenderKey = album => JSON.stringify([album.key, album.rating]);
  f.context.getAlbumCardNodeIdentity = album => album.key;
  f.context.renderView = options => f.renders.push(options);
  let requests = 0;
  f.context.fetch = async url => {
    requests += 1;
    if (new URL(url, 'https://localhost').searchParams.get('gallery_cursor') === 'page-1') {
      return { status: 409, ok: false, json: async () => ({ restart_required: true }) };
    }
    return { status: 200, ok: true, json: async () => page([
      { artist: 'Retained artist', albums: [{ key: 'tail', rating: 5 }] },
    ], { gallery_page: { revision: 'r2', has_more: true, next_cursor: `fresh-${requests}` } }) };
  };
  assert.equal(await f.context.loadNextRootGalleryPage(), true);
  assert.equal(requests, 2, 'a metadata edit must not force pagination past the retained release');
  assert.equal(f.state.view.artist_groups[0].albums[0].rating, 5);
});

test('stale cursor recovery accepts a complete trailing artist after its final album is deleted', async () => {
  const f = fixture();
  f.scroll.scrollTop = 300;
  f.state.view.artist_groups = [{
    artist: 'Retained artist', albums: [{ key: 'survivor' }, { key: 'deleted-tail' }],
  }];
  f.context.renderView = options => f.renders.push(options);
  let requests = 0;
  f.context.fetch = async url => {
    requests += 1;
    if (new URL(url, 'https://localhost').searchParams.get('gallery_cursor') === 'page-1') {
      return { status: 409, ok: false, json: async () => ({ restart_required: true }) };
    }
    return { status: 200, ok: true, json: async () => page([
      { artist: 'Retained artist', albums: [{ key: 'survivor' }] },
      { artist: 'Subsequent artist', albums: [{ key: 'subsequent' }] },
    ], { gallery_page: { revision: 'r2', has_more: true, next_cursor: `fresh-${requests}` } }) };
  };
  assert.equal(await f.context.loadNextRootGalleryPage(), true);
  assert.equal(requests, 2, 'complete anchored artist groups establish that the tail was removed');
  assert.equal(f.state.view.artist_groups[0].albums[0].key, 'survivor');
});

test('stale cursor restarts when same-view background refresh advances view revision', async () => {
  const f = fixture();
  f.context.fetch = (url, options) => new Promise(resolve => f.pending.push({ url, options, resolve }));
  f.context.renderView = options => f.renders.push(options);
  const first = f.context.loadNextRootGalleryPage();
  f.state.ui.viewStateRevision = 1;
  f.pending[0].resolve({ status: 409, ok: false, json: async () => ({ restart_required: true }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pending.length, 2, 'same-view snapshot churn must restart from a fresh first page');
  f.pending[1].resolve({
    status: 200,
    ok: true,
    json: async () => page([{ artist: 'New', albums: [{ key: 'new' }] }], {
      gallery_page: { revision: 'r2', has_more: false, next_cursor: null },
    }),
  });
  assert.equal(await first, true);
  assert.equal(f.state.view.artist_groups[0].artist, 'New');
});

test('continuation uses the loaded source scope rather than retained browser scope', async () => {
  const f = fixture(); f.state.view.gallery_scope = 'main'; f.state.view.visible_library_categories = ['main_library'];
  f.state.view.gallery_page_scope = { gallery_scope: 'all', visible_library_categories: ['hoard'] };
  f.context.buildApiUrl = view => '/view-data?surface=albums&gallery_scope=' + view.gallery_scope + '&category=' + view.visible_library_categories[0];
  const result = f.context.loadNextRootGalleryPage();
  assert.match(f.pending[0].url, /gallery_scope=all&category=hoard/);
  f.pending[0].resolve(page([])); await result;
});

test('anchored gallery prepends earlier complete groups near the top without replacing forward continuation', async () => {
  const f = fixture();
  f.state.view.gallery_page = {
    next_cursor: 'forward-page',
    has_more: true,
    previous_cursor: 'earlier-page',
    has_previous: true,
    revision: 'r1',
    page_size: 50,
  };
  f.scroll.scrollTop = 500;

  const loading = f.context.loadPreviousRootGalleryPage();
  assert.equal(f.pending.length, 1);
  const requestUrl = new URL(f.pending[0].url, 'https://localhost');
  assert.equal(requestUrl.searchParams.get('gallery_cursor'), 'earlier-page');
  assert.equal(requestUrl.searchParams.get('gallery_page_direction'), 'previous');
  assert.equal(requestUrl.searchParams.get('omit_sidebar'), '1');

  f.pending[0].resolve({
    artist_groups: [{ artist: 'Earlier', albums: [{ key: 'earlier-1' }, { key: 'earlier-2' }] }],
    gallery_page: {
      previous_cursor: null,
      has_previous: false,
      next_cursor: 'existing-page',
      has_more: true,
      revision: 'r1',
      page_size: 50,
    },
  });

  assert.equal(await loading, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(f.state.view.artist_groups.map(group => group.artist))),
    ['Earlier', 'A'],
  );
  assert.equal(f.state.view.gallery_page.next_cursor, 'forward-page');
  assert.equal(f.state.view.gallery_page.has_more, true);
  assert.equal(f.state.view.gallery_page.has_previous, false);
  assert.equal(f.renders[0].preserveScroll, true);
  assert.equal(f.renders[0].preserveMountedGalleryChildren, true);
});

test('anchored gallery does not request earlier pages until the user scrolls near the top', async () => {
  const f = fixture();
  f.state.view.gallery_page = {
    ...f.state.view.gallery_page,
    previous_cursor: 'earlier-page',
    has_previous: true,
  };
  f.scroll.scrollTop = 4500;
  f.scroll.scrollHeight = 10000;

  assert.equal(await f.context.loadPreviousRootGalleryPage(), false);
  assert.equal(f.pending.length, 0);
});

test('anchored gallery measures the earlier-page threshold from its first loaded artist, not held space', async () => {
  const f = fixture();
  f.state.view.gallery_page = {
    ...f.state.view.gallery_page,
    previous_cursor: 'earlier-page',
    has_previous: true,
  };
  f.scroll.scrollTop = 4500;
  f.scroll.scrollHeight = 10000;
  f.context.virtualGrid = { ...f.context.virtualGrid, leadingExtent: 4000 };

  const loading = f.context.loadPreviousRootGalleryPage();
  assert.equal(f.pending.length, 1, 'the first loaded artist is near the viewport');
  f.pending[0].resolve({
    artist_groups: [{ artist: 'Earlier', albums: [{ key: 'earlier-1' }] }],
    gallery_page: { ...f.state.view.gallery_page, previous_cursor: null, has_previous: false },
  });
  assert.equal(await loading, true);
});

for (const mobile of [false, true]) {
  for (const scrollTop of [1779, 754 * 8]) {
    test(`reverse prefetch loads earlier groups before the boundary (${mobile ? 'mobile' : 'desktop'}, ${scrollTop}px)`, async () => {
      const f = fixture({ mobile });
      f.scroll.clientHeight = 754;
      f.scroll.scrollHeight = 20000;
      f.scroll.scrollTop = scrollTop;
      f.state.view.gallery_page = {
        ...f.state.view.gallery_page,
        previous_cursor: 'earlier-page',
        has_previous: true,
      };
      const loading = f.context.loadPreviousRootGalleryPage();
      assert.equal(f.pending.length, 1, 'earlier groups must load before the two-viewport boundary');
      assert.equal(await f.context.loadPreviousRootGalleryPage(), false);
      assert.equal(f.pending.length, 1, 'prefetch must retain one request owner');
      f.pending[0].resolve(page([{ artist: 'Earlier', albums: [{ key: 'earlier-1' }] }], {
        gallery_page: { revision: 'r1', previous_cursor: 'older-page', has_previous: true },
      }));
      assert.equal(await loading, true);
      assert.equal(f.state.view.gallery_page.next_cursor, 'page-1');
      assert.equal(f.renders[0].preserveScroll, true);
      assert.equal(f.renders[0].preserveMountedGalleryChildren, true);
      assert.equal(f.timers.length, 0, 'reverse prefetch must not drain earlier pages on an idle timer');
    });
  }
}


for (const direction of ['Next', 'Previous']) {
  for (const cancel of [false, true]) {
    test(`pending ${direction} gallery page keeps cards and ${cancel ? 'aborts' : 'recovers'}`, async () => {
      const f = fixture();
      if (direction === 'Previous') {
        f.state.view.gallery_page.previous_cursor = 'earlier-page';
        f.state.view.gallery_page.has_previous = true;
      }
      const callbacks = [];
      const cleared = [];
      f.context.setTimeout = callback => { callbacks.push(callback); return 17; };
      f.context.clearTimeout = timer => cleared.push(timer);
      const mounted = f.state.view.artist_groups;
      const request = f.context[`load${direction}RootGalleryPage`]();
      f.pending[0].resolveResponse({
        status: 503,
        clone: () => ({ json: async () => ({ ok: false, code: 'gallery_projection_pending' }) }),
      });
      await new Promise(setImmediate);
      assert.equal(f.state.view.artist_groups, mounted);
      assert.equal(f.renders.length, 0);
      assert.equal(callbacks.length, 1);
      assert.equal(await f.context[`load${direction}RootGalleryPage`](), false);
      if (cancel) {
        f.context.claimLocalViewStateNavigation();
        assert.equal(await request, false);
        assert.deepEqual(cleared, [17]);
        assert.equal(f.pending.length, 1);
        assert.equal(f.state.view.artist_groups, mounted);
      } else {
        callbacks[0]();
        await new Promise(setImmediate);
        assert.equal(f.pending.length, 2);
        assert.equal(f.pending[1].url, f.pending[0].url);
        f.pending[1].resolve(page([{ artist: 'B', albums: [{ key: 'b1' }] }]));
        assert.equal(await request, true);
        assert.deepEqual(Array.from(f.state.view.artist_groups, group => group.artist),
          direction === 'Previous' ? ['B', 'A'] : ['A', 'B']);
        assert.equal(f.renders[0].preserveScroll, true);
        assert.equal(f.renders[0].preserveMountedGalleryChildren, true);
      }
    });
  }
}

test('pending recovery after cursor restart retains cards', async () => {
  const f = fixture();
  const retries = [];
  f.context.setTimeout = callback => { retries.push(callback); return 1; };
  f.context.clearTimeout = () => {};
  f.context.renderView = options => f.renders.push(options);
  const mounted = f.state.view.artist_groups;
  const request = f.context.loadNextRootGalleryPage();
  f.pending[0].resolveResponse({ status: 409, json: async () => ({ restart_required: true }) });
  await new Promise(setImmediate);
  const restartedUrl = f.pending[1].url;
  assert.equal(new URL(restartedUrl, 'https://localhost').searchParams.has('gallery_cursor'), false);
  f.pending[1].resolveResponse({
    status: 503,
    clone: () => ({ json: async () => ({ code: 'gallery_projection_pending' }) }),
  });
  await new Promise(setImmediate);
  assert.equal(f.state.view.artist_groups, mounted);
  assert.equal(f.renders.length, 0);
  assert.equal(retries.length, 1);
  retries[0]();
  await new Promise(setImmediate);
  assert.equal(f.pending[2].url, restartedUrl);
  const recovered = page([{ artist: 'New', albums: [{ key: 'new1' }, { key: 'new2' }] }], {
    gallery_page: { revision: 'r2', next_cursor: null, has_more: false },
  });
  f.pending[2].resolve(recovered);
  assert.equal(await request, true);
  assert.equal(f.state.view.artist_groups[0].artist, 'New');
  assert.equal(f.renders[0].preserveMountedGalleryChildren, true);
});

// A catalog change reloads only the anchored window around the visible album, whatever the scroll
// depth; earlier and later pages reload through their cursors when the user scrolls to them.
function deepRootGallery(f, artists, visibleIndex) {
  f.state.view.artist_groups = Array.from({ length: artists }, (_, index) => ({
    artist: `Retained ${index}`, albums: [{ key: `retained-${index}` }],
  }));
  f.semanticScrollAnchor.albumKey = `retained-${visibleIndex}`;
  f.scroll.scrollTop = 300;
  f.context.renderView = options => f.renders.push(options);
}

const windowAround = (anchor, extra = {}) => page(
  Array.from({ length: 50 }, (_, offset) => ({ artist: `Fresh ${anchor} ${offset}`, albums: [{ key: offset === 16 ? `retained-${anchor}` : `fresh-${anchor}-${offset}` }] })),
  { gallery_page: { revision: 'r2', has_more: true, next_cursor: 'after-window', has_previous: true, previous_cursor: 'before-window', anchor_artist: `Retained ${anchor}`, anchor_offset: anchor, anchor_group_artist: `Retained ${anchor}` }, ...extra },
);

test('stale cursor recovery reloads only the window around the visible album', async () => {
  const f = fixture();
  deepRootGallery(f, 20000, 12000);
  const requests = [];
  f.context.fetch = async (url) => {
    requests.push(new URL(url, 'https://localhost').searchParams);
    return requests.length === 1
      ? { status: 409, ok: false, json: async () => ({ restart_required: true }) }
      : { status: 200, ok: true, json: async () => windowAround(12000) };
  };
  assert.equal(await f.context.loadNextRootGalleryPage(), true);
  assert.equal(requests.length, 2, 'one conflict and one window, whatever the scroll depth');
  assert.equal(requests[1].get('gallery_anchor_artist'), 'Retained 12000');
  assert.equal(requests[1].has('gallery_cursor'), false);
  assert.equal(requests[1].has('omit_sidebar'), false, 'the recovered window refreshes the sidebar totals');
  assert.equal(f.state.view.artist_groups.length, 50, 'pages outside the window are not retained');
  assert.ok(f.state.view.artist_groups.some(group => group.albums[0].key === 'retained-12000'));
  assert.equal(f.state.view.gallery_page.previous_cursor, 'before-window');
  assert.equal(f.state.view.gallery_page.next_cursor, 'after-window');
  assert.equal(f.renders.length, 1);
  assert.equal(f.renders[0].semanticScrollAnchor, f.semanticScrollAnchor, 'the visible album keeps its on-screen offset');
  assert.deepEqual([f.renders[0].semanticScrollAnchor.albumKey, f.renders[0].semanticScrollAnchor.offset], ['retained-12000', 24]);
  assert.equal(f.renders[0].semanticScrollOwnerGeneration, 7, 'restoration is skipped only if the user scrolled meanwhile');
});

test('stale cursor recovery anchors at the nearest surviving neighbour of a deleted visible artist', async () => {
  const f = fixture();
  deepRootGallery(f, 300, 150);
  const anchors = [];
  f.context.fetch = async (url) => {
    const params = new URL(url, 'https://localhost').searchParams;
    if (params.has('gallery_cursor')) return { status: 409, ok: false, json: async () => ({ restart_required: true }) };
    anchors.push(params.get('gallery_anchor_artist'));
    return params.get('gallery_anchor_artist') === 'Retained 150'
      ? { status: 400, ok: false, json: async () => ({ error: 'Gallery artist anchor is unavailable.' }) }
      : { status: 200, ok: true, json: async () => windowAround(151) };
  };
  assert.equal(await f.context.loadNextRootGalleryPage(), true);
  assert.deepEqual(anchors, ['Retained 150', 'Retained 151']);
});
