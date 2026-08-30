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
