const test = require('node:test');
const assert = require('node:assert/strict');

function buildBootstrapDocument(initialView, bootstrap = {}) {
  return `<html><script>window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = ${JSON.stringify({
    startup_payload: { first_paint_view: initialView },
    initial_view: initialView,
    bootstrap,
  })};</script></html>`;
}

function buildPostgresRootView(payloadTier = 'full') {
  return {
    persistence_backend: 'postgres',
    persistence_seam: 'library_browse',
    view_data_source: 'postgres_library_browse',
    payload_tier: payloadTier,
    query: '',
    selected_artist: '',
  };
}

async function withPostgresRuntimeEnvironment(databaseUrl, callback) {
  const previousDatabaseUrl = process.env.ALBUM_HAVEN_APP_DATABASE_URL;
  const previousBrowseBackend = process.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE;
  process.env.ALBUM_HAVEN_APP_DATABASE_URL = databaseUrl;
  process.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE = 'postgres';
  try {
    return await callback();
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.ALBUM_HAVEN_APP_DATABASE_URL;
    else process.env.ALBUM_HAVEN_APP_DATABASE_URL = previousDatabaseUrl;
    if (previousBrowseBackend === undefined) delete process.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE;
    else process.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE = previousBrowseBackend;
  }
}

test('performance runtime guard requires an exact isolated CI database and app-role identity', async () => {
  const { requirePostgresRuntimeEnv } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const acceptedUrl =
    'postgresql://album_haven_app_p_32912922438_1_3@127.0.0.1/album_haven_ci_p_32912922438_1_3';

  await withPostgresRuntimeEnvironment(acceptedUrl, () => {
    assert.doesNotThrow(() => requirePostgresRuntimeEnv('the synthetic benchmark'));
  });

  for (const unsafeUrl of [
    'postgresql://album_haven_app@localhost/album_haven_core',
    'postgresql://album_haven_app@localhost/album_haven_fake_e2e',
    'postgresql://album_haven_app_other@localhost/album_haven_ci_p_32912922438_1_3',
    'postgresql://album_haven_app_p_32912922438_1_3@example.test/album_haven_ci_p_32912922438_1_3',
    'postgresql://album_haven_app_p_32912922438_1_3:secret@localhost/album_haven_ci_p_32912922438_1_3',
  ]) {
    await withPostgresRuntimeEnvironment(unsafeUrl, () => {
      assert.throws(
        () => requirePostgresRuntimeEnv('the synthetic benchmark'),
        (error) => {
          assert.match(error.message, /the synthetic benchmark/);
          assert.match(
            error.message,
            /exact album_haven_ci_<suffix>\/album_haven_app_<suffix> identity on loopback/i,
          );
          return true;
        },
      );
    });
  }
});

function withRenderedPostgresSidebarPreview(callback) {
  class FakeElement {
    constructor({ hidden = false, textContent = '' } = {}) {
      this.hidden = hidden;
      this.textContent = textContent;
    }
  }
  const element = (options) => new FakeElement(options);
  const elementsById = new Map([
    ['library-loader', element({ hidden: true })],
    ['library-loader-title', element()],
    ['library-loader-status', element()],
    ['library-loader-browse-button', element({ hidden: true })],
  ]);
  const selectors = {
    activeAllArtistsSelector: '.all-active',
    activeAllArtistsCountSelector: '.all-active .count',
    albumCardSelector: '.album-card',
    artistHeadingSelector: '.artist-heading',
    sidebarArtistSelector: '.sidebar-artist',
  };
  const previous = {
    HTMLElement: global.HTMLElement,
    document: global.document,
    state: global.state,
    window: global.window,
  };
  global.HTMLElement = FakeElement;
  global.document = {
    getElementById: (id) => elementsById.get(id) || null,
    querySelector: (selector) => {
      if (selector === selectors.activeAllArtistsSelector) return element();
      if (selector === selectors.activeAllArtistsCountSelector) return element({ textContent: '40' });
      return null;
    },
    querySelectorAll: (selector) => {
      if (selector === selectors.sidebarArtistSelector) return Array.from({ length: 40 }, () => element());
      if (selector === selectors.artistHeadingSelector) return [element()];
      if (selector === selectors.albumCardSelector) return [element()];
      return [];
    },
  };
  global.window = {
    __ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__: {
      bootstrap: { startupHydration: { tier: 'sidebar', embeddedViewPatch: null } },
    },
    __ALBUM_HAVEN_STARTUP_METRICS__: {
      marks: { first_gallery_paint: { detail: { artistSectionCount: 1 } } },
    },
  };
  global.state = {
    view: {
      ...buildPostgresRootView('sidebar'),
      artist_groups: [{ artist: 'Preview Artist', albums: [{ album: 'Preview Album' }] }],
    },
  };
  try {
    return callback({ selectors, window: global.window });
  } finally {
    Object.entries(previous).forEach(([name, value]) => {
      if (value === undefined) delete global[name];
      else global[name] = value;
    });
  }
}

test('startup entry snapshot recognizes the rendered Postgres sidebar preview before full hydration', async () => {
  const { readLibraryStartupEntrySnapshot } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');

  withRenderedPostgresSidebarPreview(({ selectors }) => {
    const snapshot = readLibraryStartupEntrySnapshot(selectors);

    assert.equal(snapshot.startupMode, 'postgres-sidebar-preview-first');
    assert.equal(snapshot.visibleSidebarArtistCount, 40);
    assert.equal(snapshot.runtimePostgresBrowse, true);
    assert.equal(snapshot.firstGalleryPaintSectionCount, 1);
  });
});

test('startup entry snapshot fails closed before the production gallery paint', async () => {
  const { readLibraryStartupEntrySnapshot } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');

  withRenderedPostgresSidebarPreview(({ selectors, window }) => {
    window.__ALBUM_HAVEN_STARTUP_METRICS__.marks = {};
    assert.equal(readLibraryStartupEntrySnapshot(selectors), false);
  });
});

test('expectManualStartupEntryPath accepts direct-full-sidebar startup mode', async () => {
  const { expectManualStartupEntryPath } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');

  assert.doesNotThrow(() => {
    expectManualStartupEntryPath({
      startupMode: 'direct-full-sidebar',
      visibleSidebarArtistCount: 128,
      visibleAllArtistsCount: 128,
    }, 'all-artists benchmark');
  });
});

test('expectManualStartupEntryPath accepts a painted Postgres sidebar preview after bootstrap release', async () => {
  const { expectManualStartupEntryPath } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');

  assert.doesNotThrow(() => {
    expectManualStartupEntryPath({
      startupMode: 'postgres-sidebar-preview-first',
      runtimePostgresBrowse: true,
      runtimePayloadTier: 'sidebar',
      firstGalleryPaintSectionCount: 1,
      visibleSidebarArtistCount: 40,
    }, 'app-open benchmark');
  });
});

test('production bootstrap parser preserves braces and quotes inside JSON strings', async () => {
  const { parseProductionBootstrapPayload } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const initialView = { ...buildPostgresRootView('full'), app_name: 'Album {"Haven"}' };

  const payload = parseProductionBootstrapPayload(buildBootstrapDocument(initialView, {
    startupPreview: { mode: 'full_view' },
  }));

  assert.equal(payload.initial_view.app_name, 'Album {"Haven"}');
});

test('startup authority accepts a production embedded-sidebar bootstrap without a later response', async () => {
  const {
    expectRootBrowseStartupAuthorityEvidence,
    parseProductionBootstrapPayload,
  } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const bootstrapPayload = parseProductionBootstrapPayload(buildBootstrapDocument(
    buildPostgresRootView('sidebar'),
    {
      startupPreview: { mode: 'fresh_preview' },
      startupHydration: { required: true, tier: 'sidebar' },
    },
  ));

  const evidence = expectRootBrowseStartupAuthorityEvidence({
    rootBrowsePayloads: [],
    bootstrapPayloads: [bootstrapPayload],
  });

  assert.equal(evidence.kind, 'embedded-sidebar-bootstrap');
});

test('startup authority accepts a production direct-full bootstrap without a later response', async () => {
  const {
    expectRootBrowseStartupAuthorityEvidence,
    parseProductionBootstrapPayload,
  } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const bootstrapPayload = parseProductionBootstrapPayload(buildBootstrapDocument(
    buildPostgresRootView('full'),
    {
      startupPreview: { mode: 'full_view' },
      startupHydration: { required: false, tier: 'full' },
    },
  ));

  const evidence = expectRootBrowseStartupAuthorityEvidence({
    rootBrowsePayloads: [],
    bootstrapPayloads: [bootstrapPayload],
  });

  assert.equal(evidence.kind, 'direct-full-bootstrap');
});

test('startup authority rejects missing production response and bootstrap evidence', async () => {
  const { expectRootBrowseStartupAuthorityEvidence } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');

  assert.throws(() => expectRootBrowseStartupAuthorityEvidence({
    rootBrowsePayloads: [],
    bootstrapPayloads: [],
  }));
});

test('startup runtime failure guard rejects console and network failures', async () => {
  const { expectNoUnexpectedRuntimeFailures } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');

  assert.doesNotThrow(() => expectNoUnexpectedRuntimeFailures([
    { kind: 'console', type: 'log', text: 'startup complete' },
  ], 'startup benchmark'));
  assert.throws(() => expectNoUnexpectedRuntimeFailures([
    { kind: 'console', type: 'error', text: 'boom' },
  ], 'startup benchmark'));
  assert.throws(() => expectNoUnexpectedRuntimeFailures([
    { kind: 'requestfailed', type: 'net::ERR_FAILED', text: 'GET /cover' },
  ], 'startup benchmark'));
  assert.throws(() => expectNoUnexpectedRuntimeFailures([
    { kind: 'httpresponse', type: '500', text: 'GET 500 /view-data' },
  ], 'startup benchmark'));
});

function buildPagedPostgresRootView() {
  return {
    ...buildPostgresRootView('gallery_page'),
    initial_view_partial: false,
    artist_count: 2,
    album_count: 3,
    artists_sidebar: [{ artist: 'Alpha', count: 2 }, { artist: 'Beta', count: 1 }],
    artist_groups: [{ artist: 'Alpha', albums: [{ key: 'alpha/first', preview_only: true }] }],
    gallery_page: {
      page_size: 1,
      has_more: true,
      next_cursor: Buffer.from(JSON.stringify([1, 'a'.repeat(64), 1])).toString('base64url'),
      revision: 'a'.repeat(64),
    },
  };
}

test('startup authority accepts a bounded complete gallery page with authoritative sidebar and totals', async () => {
  const { expectRootBrowseStartupAuthorityEvidence, parseProductionBootstrapPayload } =
    await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const initialView = buildPagedPostgresRootView();
  const bootstrapPayload = parseProductionBootstrapPayload(buildBootstrapDocument(initialView, {
    startupPreview: { mode: 'full_view' },
    startupHydration: { required: false, tier: 'full' },
  }));
  const evidence = expectRootBrowseStartupAuthorityEvidence({
    rootBrowsePayloads: [], bootstrapPayloads: [bootstrapPayload],
  });
  assert.equal(evidence.kind, 'paged-root-bootstrap');
  assert.equal(evidence.payload, bootstrapPayload.startup_payload.first_paint_view);
});

test('startup authority accepts a complete root page response without requiring full hydration', async () => {
  const { expectRootBrowseStartupAuthorityEvidence } =
    await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const payload = buildPagedPostgresRootView();
  assert.equal(expectRootBrowseStartupAuthorityEvidence({ rootBrowsePayloads: [payload] }).kind,
    'paged-root-view-data');
});

test('paged startup authority rejects partial pages, incomplete metadata and unbounded hydration', async () => {
  const { expectRootBrowseStartupAuthorityEvidence } =
    await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  for (const invalidate of [
    (view) => { view.initial_view_partial = true; },
    (view) => { view.artists_sidebar.pop(); },
    (view) => { view.album_count = 0; },
    (view) => { view.gallery_page.page_size = 101; },
    (view) => { view.gallery_page.next_cursor = null; },
    (view) => { view.gallery_page.next_cursor = 'invalid'; },
    (view) => { view.gallery_page.revision = ''; },
    (view) => { view.artist_groups[0].albums.push({ key: 'extra' }); },
  ]) {
    const payload = buildPagedPostgresRootView();
    invalidate(payload);
    assert.throws(() => expectRootBrowseStartupAuthorityEvidence({ rootBrowsePayloads: [payload] }));
  }
});
test('startup entry recognizes bounded root paint only with the complete sidebar metadata', async () => {
  const { readLibraryStartupEntrySnapshot } =
    await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  withRenderedPostgresSidebarPreview(({ selectors }) => {
    global.state.view = {
      ...buildPagedPostgresRootView(),
      artist_count: 128,
      album_count: 128,
      artists_sidebar: Array.from({ length: 128 }, (_, index) => ({ artist: `Artist ${index}`, count: 1 })),
    };
    const originalQuerySelector = global.document.querySelector;
    global.document.querySelector = (selector) => selector === selectors.activeAllArtistsCountSelector
      ? { textContent: '128' } : originalQuerySelector(selector);
    const snapshot = readLibraryStartupEntrySnapshot(selectors);
    assert.equal(snapshot.startupMode, 'postgres-paged-root');
    assert.equal(snapshot.visibleSidebarArtistCount, 40);
    assert.equal(snapshot.runtimeSidebarArtistCount, 128);
    assert.equal(snapshot.visibleAllArtistsCount, 128);
    global.state.view.artists_sidebar.pop();
    assert.equal(readLibraryStartupEntrySnapshot(selectors), false);
  });
});

test('manual paged startup evidence requires synchronized authoritative artist totals', async () => {
  const { expectManualStartupEntryPath } =
    await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const snapshot = {
    startupMode: 'postgres-paged-root',
    runtimePostgresBrowse: true,
    runtimePayloadTier: 'gallery_page',
    runtimeSidebarArtistCount: 128,
    runtimeArtistCount: 128,
    visibleSidebarArtistCount: 40,
    visibleAllArtistsCount: 128,
    firstGalleryPaintSectionCount: 1,
  };
  assert.doesNotThrow(() => expectManualStartupEntryPath(snapshot, 'paged startup'));
  assert.throws(() => expectManualStartupEntryPath({ ...snapshot, runtimeSidebarArtistCount: 40 }, 'paged startup'));
  assert.throws(() => expectManualStartupEntryPath({ ...snapshot, visibleAllArtistsCount: 40 }, 'paged startup'));
});

test('paged authority distinguishes an accumulated runtime from one bounded response', async () => {
  const { expectPagedRootBrowseAuthority } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const payload = buildPagedPostgresRootView();
  payload.artist_groups[0].albums.push({ key: 'alpha/second', preview_only: true });
  payload.gallery_page.next_cursor = Buffer.from(JSON.stringify([1, payload.gallery_page.revision, 2])).toString('base64url');
  assert.throws(() => expectPagedRootBrowseAuthority(payload));
  assert.doesNotThrow(() => expectPagedRootBrowseAuthority(payload, { accumulated: true }));
  payload.gallery_page.next_cursor = Buffer.from(JSON.stringify([1, payload.gallery_page.revision, 3])).toString('base64url');
  assert.throws(() => expectPagedRootBrowseAuthority(payload, { accumulated: true }));
});

test('startup authority keeps bootstrap evidence separate from cursor continuation responses', async () => {
  const { collectRootBrowseStartupAuthorityEvidence, expectRootBrowseStartupAuthorityEvidence } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  let listener;
  const page = { on: (_event, callback) => { listener = callback; }, off: () => {} };
  const initialView = buildPagedPostgresRootView();
  const document = buildBootstrapDocument(initialView, {
    startupPreview: { mode: 'full_view' }, startupHydration: { required: false, tier: 'full' },
  });
  const evidence = await collectRootBrowseStartupAuthorityEvidence(page, async () => {
    listener({ url: () => 'http://localhost/?surface=albums', request: () => ({ resourceType: () => 'document' }), text: async () => document });
    listener({ url: () => 'http://localhost/view-data?surface=albums&gallery_cursor=next&omit_sidebar=1',
      request: () => ({ resourceType: () => 'fetch' }), json: async () => { throw new Error('A continuation cannot replace initial authority'); } });
  });
  assert.deepEqual(evidence.rootBrowsePayloads, []);
  assert.equal(expectRootBrowseStartupAuthorityEvidence(evidence).kind, 'paged-root-bootstrap');
});


test('paged root wire summaries reject track payloads, including empty arrays', async () => {
  const { expectRootBrowseStartupAuthorityEvidence } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  for (const tracks of [[], [{ title: 'Unexpected hydration' }], null, {}]) {
    const payload = buildPagedPostgresRootView();
    payload.artist_groups[0].albums[0].tracks = tracks;
    assert.throws(() => expectRootBrowseStartupAuthorityEvidence({ rootBrowsePayloads: [payload] }));
  }
});

test('embedded root previews allow empty tracks without relaxing page bounds', async () => {
  const { expectRootBrowseStartupAuthorityEvidence, parseProductionBootstrapPayload } =
    await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const payload = buildPagedPostgresRootView();
  const check = () => expectRootBrowseStartupAuthorityEvidence({ bootstrapPayloads: [
    parseProductionBootstrapPayload(buildBootstrapDocument(payload, {
      startupPreview: { mode: 'full_view' },
      startupHydration: { tier: 'full', required: false },
    })),
  ] });
  assert.doesNotThrow(check);
  payload.artist_groups[0].albums[0].tracks = [];
  assert.doesNotThrow(check);
  for (const tracks of [[{ title: 'Unexpected hydration' }], null, {}, '', false]) {
    payload.artist_groups[0].albums[0].tracks = tracks;
    assert.throws(check);
  }
  payload.artist_groups[0].albums[0].tracks = [];
  payload.artist_groups[0].albums.push({ key: 'unexpected-second', preview_only: true, tracks: [] });
  payload.gallery_page.next_cursor = Buffer.from(JSON.stringify([1, payload.gallery_page.revision, 2])).toString('base64url');
  assert.throws(check);
});

test('paged root runtime summaries allow only omitted or empty track arrays', async () => {
  const { expectPagedRootBrowseAuthority } = await import('../../tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const payload = buildPagedPostgresRootView();
  assert.doesNotThrow(() => expectPagedRootBrowseAuthority(payload, { accumulated: true }));
  payload.artist_groups[0].albums[0].tracks = [];
  assert.doesNotThrow(() => expectPagedRootBrowseAuthority(payload, { accumulated: true }));
  for (const tracks of [[{ title: 'Unexpected hydration' }], null, {}, '', false]) {
    payload.artist_groups[0].albums[0].tracks = tracks;
    assert.throws(() => expectPagedRootBrowseAuthority(payload, { accumulated: true }));
  }
});
