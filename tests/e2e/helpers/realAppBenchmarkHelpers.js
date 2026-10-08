import { expect } from '@playwright/test';

import {
  expectPostgresLibraryBrowseTelemetry,
  isRootAlbumsViewDataResponse,
} from './performanceHelpers.js';
import { assertIsolatedE2EDatabase } from './managedAppLifecycle.js';

export function requirePostgresRuntimeEnv(benchmarkName) {
  const databaseUrl = String(process.env.ALBUM_HAVEN_APP_DATABASE_URL || '').trim();
  expect(databaseUrl, `ALBUM_HAVEN_APP_DATABASE_URL is required for ${benchmarkName}.`).not.toBe('');
  assertIsolatedE2EDatabase(databaseUrl, {
    context: benchmarkName,
    requireCiIdentity: true,
  });
  expect(
    String(process.env.ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE || '').trim(),
    `${benchmarkName} must force ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE=postgres.`,
  ).toBe('postgres');
}

export async function readRuntimeView(page) {
  const viewHandle = await page.waitForFunction(() => {
    const view = typeof state !== 'undefined' ? state.view : null;
    return view && typeof view === 'object' ? JSON.parse(JSON.stringify(view)) : null;
  });
  return viewHandle.jsonValue();
}

export function readLibraryStartupEntrySnapshot(selectors) {
  const loader = document.getElementById('library-loader');
  const title = document.getElementById('library-loader-title');
  const status = document.getElementById('library-loader-status');
  const browseButton = document.getElementById('library-loader-browse-button');
  const bootstrap = window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__?.bootstrap || {};
  const bootstrapHydrationTier = String(bootstrap.startupHydration?.tier || 'full');
  const embeddedSidebarArtists = bootstrap.startupHydration?.embeddedViewPatch?.artists_sidebar;
  const embeddedSidebarArtistCount = Array.isArray(embeddedSidebarArtists) ? embeddedSidebarArtists.length : 0;
  const runtimeView = typeof state !== 'undefined' && state?.view && typeof state.view === 'object'
    ? state.view
    : {};
  const runtimeSidebarArtistCount = Array.isArray(runtimeView.artists_sidebar) ? runtimeView.artists_sidebar.length : 0;
  const runtimeArtistCount = Number(runtimeView.artist_count || 0);
  const runtimePayloadTier = String(runtimeView.payload_tier || '').trim();
  const runtimePostgresBrowse = String(runtimeView.persistence_backend || '').trim() === 'postgres'
    && String(runtimeView.persistence_seam || '').trim() === 'library_browse'
    && String(runtimeView.view_data_source || '').trim() === 'postgres_library_browse';
  const runtimeArtistGroupCount = Array.isArray(runtimeView.artist_groups)
    ? runtimeView.artist_groups.length
    : 0;
  const visibleSidebarArtistCount = document.querySelectorAll(selectors.sidebarArtistSelector).length;
  const visibleArtistHeadingCount = document.querySelectorAll(selectors.artistHeadingSelector).length;
  const visibleAlbumCardCount = document.querySelectorAll(selectors.albumCardSelector).length;
  const loaderVisible = loader instanceof HTMLElement && !loader.hidden;
  const allArtistsActive = document.querySelector(selectors.activeAllArtistsSelector) instanceof HTMLElement;
  const allArtistsCountNode = document.querySelector(selectors.activeAllArtistsCountSelector);
  const visibleAllArtistsCount = Number.parseInt(
    String(allArtistsCountNode?.textContent || '').replace(/[^\d-]/g, '').trim(),
    10,
  ) || 0;
  const firstGalleryPaint = window.__ALBUM_HAVEN_STARTUP_METRICS__?.marks?.first_gallery_paint;
  const firstGalleryPaintSectionCount = Number(firstGalleryPaint?.detail?.artistSectionCount || 0);
  const postgresSidebarPreview = !loaderVisible
    && runtimePostgresBrowse
    && runtimePayloadTier === 'sidebar'
    && runtimeArtistGroupCount > 0
    && visibleSidebarArtistCount > 0
    && visibleArtistHeadingCount > 0
    && visibleAlbumCardCount > 0
    && allArtistsActive
    && firstGalleryPaintSectionCount > 0;
  const directFullSidebar = !loaderVisible
    && runtimePostgresBrowse
    && runtimePayloadTier === 'full'
    && visibleSidebarArtistCount > 100
    && visibleAllArtistsCount === visibleSidebarArtistCount
    && visibleArtistHeadingCount > 0
    && visibleAlbumCardCount > 0
    && allArtistsActive
    && firstGalleryPaintSectionCount > 0;
  const postgresPagedRoot = !loaderVisible
    && runtimePostgresBrowse
    && runtimePayloadTier === 'gallery_page'
    && runtimeView.initial_view_partial === false
    && !String(runtimeView.query || '').trim()
    && !String(runtimeView.selected_artist || '').trim()
    && runtimeArtistCount > 0
    && runtimeSidebarArtistCount === runtimeArtistCount
    && visibleAllArtistsCount === runtimeArtistCount
    && visibleSidebarArtistCount > 0
    && visibleSidebarArtistCount <= runtimeArtistCount
    && visibleArtistHeadingCount > 0
    && visibleAlbumCardCount > 0
    && allArtistsActive
    && firstGalleryPaintSectionCount > 0;
  const startupMode = postgresPagedRoot ? 'postgres-paged-root' : loaderVisible
    ? 'loader-first'
    : (
      postgresSidebarPreview
        ? 'postgres-sidebar-preview-first'
        : (directFullSidebar ? 'direct-full-sidebar' : 'unknown')
    );
  const snapshot = {
    ready: startupMode !== 'unknown',
    visible: loaderVisible,
    title: (title?.textContent || '').trim(),
    status: (status?.textContent || '').trim(),
    browseButtonVisible: browseButton instanceof HTMLElement && !browseButton.hidden,
    bootstrapHydrationTier,
    embeddedSidebarArtistCount,
    visibleSidebarArtistCount,
    visibleAllArtistsCount,
    visibleArtistHeadingCount,
    visibleAlbumCardCount,
    firstGalleryPaintSectionCount,
    runtimeArtistGroupCount,
    runtimeSidebarArtistCount,
    runtimeArtistCount,
    runtimePayloadTier,
    runtimePostgresBrowse,
    startupMode,
  };
  return selectors.snapshot || snapshot.ready ? snapshot : false;
}

export async function waitForLibraryStartupEntryVisible(
  page,
  galleryActions,
  navigationPanelActions,
  options = {},
) {
  const galleryPage = galleryActions.galleryPage;
  const navigationPanel = navigationPanelActions.navigationPanel;
  const stateHandle = await page.waitForFunction(readLibraryStartupEntrySnapshot, {
    activeAllArtistsSelector: navigationPanel.activeAllArtistsSelector,
    activeAllArtistsCountSelector: navigationPanel.activeAllArtistsCountSelector,
    albumCardSelector: galleryPage.albumCard.cardSelector,
    artistHeadingSelector: galleryPage.artistHeadingSelector,
    sidebarArtistSelector: navigationPanel.sidebarArtistSelector,
  }, {
    timeout: options.timeout || 60000,
  });
  return stateHandle.jsonValue();
}

export async function readLibraryStartupEntryState(page, galleryActions, navigationPanelActions) {
  const galleryPage = galleryActions.galleryPage;
  const navigationPanel = navigationPanelActions.navigationPanel;
  // parity-check: allow-read-only-measurement-evaluate -- snapshot rendered production startup state only
  return page.evaluate(readLibraryStartupEntrySnapshot, {
    activeAllArtistsSelector: navigationPanel.activeAllArtistsSelector,
    activeAllArtistsCountSelector: navigationPanel.activeAllArtistsCountSelector,
    albumCardSelector: galleryPage.albumCard.cardSelector,
    artistHeadingSelector: galleryPage.artistHeadingSelector,
    sidebarArtistSelector: navigationPanel.sidebarArtistSelector,
    snapshot: true,
  });
}

export function expectManualStartupEntryPath(loaderState, benchmarkName) {
  const startupMode = String(loaderState?.startupMode || '');
  expect(
    ['loader-first', 'postgres-sidebar-preview-first', 'direct-full-sidebar', 'postgres-paged-root'].includes(startupMode),
    `Expected ${benchmarkName} to expose loader-first, Postgres sidebar-preview-first, direct-full-sidebar, or paged-root startup.`,
  ).toBe(true);
  if (startupMode === 'loader-first') {
    expect(
      String(loaderState?.title || '').trim(),
      `Expected ${benchmarkName} to render the manual startup loader title before hydration.`,
    ).toBe('Loading library');
    expect(
      String(loaderState?.status || '').trim(),
      `Expected ${benchmarkName} to render the manual startup empty-shell copy before hydration.`,
    ).toBe('Waiting for the first albums to become available...');
    return;
  }
  if (startupMode === 'postgres-paged-root') {
    expect(loaderState.runtimePostgresBrowse).toBe(true);
    expect(loaderState.runtimePayloadTier).toBe('gallery_page');
    expect(loaderState.runtimeArtistCount).toBeGreaterThan(0);
    expect(loaderState.runtimeSidebarArtistCount).toBe(loaderState.runtimeArtistCount);
    expect(loaderState.visibleAllArtistsCount).toBe(loaderState.runtimeArtistCount);
    expect(loaderState.visibleSidebarArtistCount).toBeGreaterThan(0);
    expect(loaderState.visibleSidebarArtistCount).toBeLessThanOrEqual(loaderState.runtimeArtistCount);
    expect(loaderState.firstGalleryPaintSectionCount).toBeGreaterThan(0);
    return;
  }
  if (startupMode === 'direct-full-sidebar') {
    expect(
      Number(loaderState?.visibleSidebarArtistCount || 0),
      `Expected ${benchmarkName} to render a fully hydrated sidebar during direct-full-sidebar startup.`,
    ).toBeGreaterThan(100);
    expect(
      Number(loaderState?.visibleAllArtistsCount || 0),
      `Expected ${benchmarkName} to synchronize the All Artists visible count during direct-full-sidebar startup.`,
    ).toBe(Number(loaderState?.visibleSidebarArtistCount || 0));
    return;
  }
  if (startupMode === 'postgres-sidebar-preview-first') {
    expect(loaderState?.runtimePostgresBrowse, `Expected ${benchmarkName} preview state to come from Postgres library_browse.`).toBe(true);
    expect(loaderState?.runtimePayloadTier, `Expected ${benchmarkName} preview state to retain sidebar payload semantics.`).toBe('sidebar');
    expect(
      Number(loaderState?.firstGalleryPaintSectionCount || 0),
      `Expected ${benchmarkName} preview state to reach the first production gallery paint.`,
    ).toBeGreaterThan(0);
    expect(
      Number(loaderState?.visibleSidebarArtistCount || 0),
      `Expected ${benchmarkName} preview state to render sidebar artists.`,
    ).toBeGreaterThan(0);
    return;
  }
  throw new Error(`Unhandled ${benchmarkName} startup mode ${startupMode}.`);
}

export function flattenAlbums(artistGroups) {
  return artistGroups.flatMap((group) => (
    Array.isArray(group?.albums) ? group.albums : []
  ));
}

export function countPlayableTrackPaths(albums) {
  return albums.reduce((total, album) => {
    const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
    return total + tracks.filter((track) => String(track?.path || '').trim()).length;
  }, 0);
}

export function pickSearchableArtistName(artistNames) {
  const selectedArtist = artistNames.find((artistName) => (
    String(artistName || '').trim().length >= 3
    && /[A-Za-z]/.test(String(artistName || '').trim())
  ));
  expect(selectedArtist, 'Expected a concrete sidebar artist name suitable for the real-app search benchmark.').toBeTruthy();
  return String(selectedArtist || '').trim();
}

export function parseProductionBootstrapPayload(documentHtml) {
  const source = String(documentHtml || '');
  const marker = 'window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = ';
  const assignmentIndex = source.indexOf(marker);
  expect(assignmentIndex, 'Expected the production root document to embed its startup payload.').toBeGreaterThanOrEqual(0);

  const objectStart = source.indexOf('{', assignmentIndex + marker.length);
  expect(objectStart, 'Expected the production startup payload assignment to contain an object.').toBeGreaterThanOrEqual(0);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(objectStart, index + 1));
    }
  }
  throw new Error('Production startup payload object did not terminate in the root document.');
}

function isRootAlbumsDocumentResponse(response) {
  const url = new URL(response.url());
  return response.request().resourceType() === 'document'
    && url.pathname === '/'
    && !url.searchParams.has('artist')
    && !url.searchParams.has('q');
}

export async function collectRootBrowseStartupAuthorityEvidence(page, action) {
  const rootBrowsePayloadPromises = [];
  const bootstrapPayloadPromises = [];
  const collectResponse = (response) => {
    if (isRootAlbumsViewDataResponse(response)
      && !new URL(response.url()).searchParams.has('gallery_cursor')) {
      rootBrowsePayloadPromises.push(response.json());
    }
    if (isRootAlbumsDocumentResponse(response)) {
      bootstrapPayloadPromises.push(response.text().then(parseProductionBootstrapPayload));
    }
  };

  page.on('response', collectResponse);
  try {
    await action();
  } finally {
    page.off('response', collectResponse);
  }
  const [rootBrowsePayloads, bootstrapPayloads] = await Promise.all([
    Promise.all(rootBrowsePayloadPromises),
    Promise.all(bootstrapPayloadPromises),
  ]);
  return { rootBrowsePayloads, bootstrapPayloads };
}

export function expectPagedRootBrowseAuthority(payload, { accumulated = false, embedded = false } = {}) {
  expectPostgresLibraryBrowseTelemetry(payload, 'gallery_page');
  expect(payload.initial_view_partial).toBe(false);
  expect(String(payload.query || '').trim()).toBe('');
  expect(String(payload.selected_artist || '').trim()).toBe('');
  expect(Array.isArray(payload.artists_sidebar)).toBe(true);
  expect(payload.artist_count).toBeGreaterThan(0);
  expect(payload.artists_sidebar.length).toBe(payload.artist_count);
  expect(payload.album_count).toBeGreaterThan(0);
  const page = payload.gallery_page;
  expect(page).toBeTruthy();
  expect(Number.isInteger(page.page_size)).toBe(true);
  expect(page.page_size).toBeGreaterThan(0);
  expect(page.page_size).toBeLessThanOrEqual(100);
  expect(page.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(typeof page.has_more).toBe('boolean');
  expect(Array.isArray(payload.artist_groups)).toBe(true);
  const albums = flattenAlbums(payload.artist_groups);
  for (const album of albums) {
    const hasTracks = Object.prototype.hasOwnProperty.call(album || {}, 'tracks');
    // API summaries omit tracks; SSR and client compaction retain empty arrays.
    expect(!hasTracks || ((accumulated || embedded) && Array.isArray(album.tracks) && album.tracks.length === 0)).toBe(true);
  }
  const count = albums.length;
  expect(count).toBeGreaterThan(0);
  if (!accumulated) expect(count).toBeLessThanOrEqual(page.page_size);
  if (page.has_more) {
    if (accumulated) expect(count).toBeGreaterThanOrEqual(page.page_size);
    else expect(count).toBe(page.page_size);
    expect(typeof page.next_cursor).toBe('string');
    const cursor = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString('utf8'));
    expect(cursor).toHaveLength(3);
    expect(cursor[0]).toBe(1);
    expect(cursor[1]).toBe(page.revision);
    expect(Number.isInteger(cursor[2])).toBe(true);
    expect(cursor[2]).toBe(count);
  } else {
    expect(page.next_cursor).toBeNull();
  }
}

export function expectRootBrowseStartupAuthorityEvidence(evidence) {
  const rootBrowsePayloads = Array.isArray(evidence?.rootBrowsePayloads)
    ? evidence.rootBrowsePayloads
    : [];
  const bootstrapPayloads = Array.isArray(evidence?.bootstrapPayloads)
    ? evidence.bootstrapPayloads
    : [];
  const authoritativeResponse = rootBrowsePayloads.find((payload) => (
    payload?.persistence_backend === 'postgres'
    && payload?.persistence_seam === 'library_browse'
    && payload?.view_data_source === 'postgres_library_browse'
  ));
  if (authoritativeResponse?.payload_tier === 'gallery_page') {
    expectPagedRootBrowseAuthority(authoritativeResponse);
    return { kind: 'paged-root-view-data', payload: authoritativeResponse };
  }
  if (authoritativeResponse) {
    expectPostgresLibraryBrowseTelemetry(authoritativeResponse, 'full');
    return { kind: 'root-view-data', payload: authoritativeResponse };
  }

  const bootstrapEvidence = bootstrapPayloads.map((payload) => {
    const initialView = payload?.startup_payload?.first_paint_view || payload?.initial_view;
    return { bootstrap: payload?.bootstrap, initialView };
  }).find(({ initialView }) => (
    initialView?.persistence_backend === 'postgres'
    && initialView?.persistence_seam === 'library_browse'
    && initialView?.view_data_source === 'postgres_library_browse'
  ));
  expect(
    bootstrapEvidence,
    'Expected startup authority from a full root view-data response or the production root bootstrap payload.',
  ).toBeTruthy();

  const { bootstrap, initialView } = bootstrapEvidence;
  if (initialView.payload_tier === 'gallery_page') {
    expectPagedRootBrowseAuthority(initialView, { embedded: true });
    expect(bootstrap?.startupPreview?.mode).toBe('full_view');
    expect(bootstrap?.startupHydration?.tier).toBe('full');
    expect(bootstrap?.startupHydration?.required).toBe(false);
    return { kind: 'paged-root-bootstrap', payload: initialView };
  }
  expectPostgresLibraryBrowseTelemetry(initialView);
  expect(String(initialView.query || '').trim()).toBe('');
  expect(String(initialView.selected_artist || '').trim()).toBe('');
  expect(['sidebar', 'full']).toContain(String(initialView.payload_tier || '').trim());
  const previewMode = String(bootstrap?.startupPreview?.mode || '').trim();
  expect(['fresh_preview', 'full_view']).toContain(previewMode);
  const startupMode = initialView.payload_tier === 'sidebar'
    ? 'embedded-sidebar-bootstrap'
    : 'direct-full-bootstrap';
  if (startupMode === 'embedded-sidebar-bootstrap') {
    expect(bootstrap?.startupHydration?.tier).toBe('sidebar');
    expect(bootstrap?.startupHydration?.required).toBe(true);
  } else {
    expect(previewMode).toBe('full_view');
    expect(bootstrap?.startupHydration?.tier).toBe('full');
  }
  return { kind: startupMode, payload: initialView };
}

export function expectNoUnexpectedRuntimeFailures(runtimeLogs, benchmarkName) {
  const failures = (Array.isArray(runtimeLogs) ? runtimeLogs : []).filter((entry) => (
    ['pageerror', 'requestfailed', 'httpresponse'].includes(String(entry?.kind || ''))
    || (
      entry?.kind === 'console'
      && ['error', 'assert'].includes(String(entry?.type || ''))
    )
  ));
  expect(
    failures,
    `Expected ${benchmarkName} to finish without browser console or network failures.`,
  ).toEqual([]);
}

async function readWarmRootDiagnostics(page) {
  const diagnosticsHandle = await page.waitForFunction(() => {
    const metrics = window.__ALBUM_HAVEN_STARTUP_METRICS__ || {};
    const pendingFollowup = state?.ui?.pendingStartupHydrationFollowup || null;
    return {
      activeViewRequestUrl: String(state?.ui?.activeViewRequestUrl || '').trim(),
      activeViewRequestStartupHydrationTier: String(state?.ui?.activeViewRequestStartupHydrationTier || '').trim(),
      activeViewRequestStartupRefresh: Boolean(state?.ui?.activeViewRequestStartupRefresh),
      awaitingInitialDataRefresh: Boolean(state?.awaitingInitialDataRefresh),
      busy: Boolean(state?.busy),
      initialRefreshCompleted: Boolean(metrics.initialRefreshCompleted),
      initialVisibleRefreshCompleted: Boolean(metrics.initialVisibleRefreshCompleted),
      marks: metrics.marks || {},
      pendingStartupHydrationFollowup: pendingFollowup
        ? {
            endpoint: String(pendingFollowup.endpoint || '').trim(),
            queuedAtMs: Number(pendingFollowup.queuedAtMs || 0),
            startupHydrationTier: String(pendingFollowup.options?.startupHydrationTier || '').trim(),
          }
        : null,
      status: {
        coversInProgress: Boolean(state?.status?.covers_in_progress),
        relationsInProgress: Boolean(state?.status?.relations_in_progress),
        scanInProgress: Boolean(state?.status?.scan_in_progress),
      },
      view: {
        albumCount: Number(state?.view?.album_count || 0),
        artistCount: Number(state?.view?.artist_count || 0),
        payloadTier: String(state?.view?.payload_tier || '').trim(),
        persistenceBackend: String(state?.view?.persistence_backend || '').trim(),
        selectedArtist: String(state?.view?.selected_artist || '').trim(),
        viewDataSource: String(state?.view?.view_data_source || '').trim(),
      },
    };
  });
  return diagnosticsHandle.jsonValue();
}

export async function waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions, options = {}) {
  const timeout = Number(options.timeout || 120000);
  let stage = 'sidebar hydration';
  try {
    await navigationPanelActions.waitForSidebarFullyHydrated({ timeout });
    stage = 'initial sections';
    await galleryActions.waitForInitialAllArtistsSections({ timeout });
    stage = 'initial refresh complete';
    await galleryActions.waitForInitialRefreshCompleted({ timeout });
    stage = 'visible covers';
    await galleryActions.waitForVisibleGalleryCoversLoaded({
      minimumCount: Number(options.minimumVisibleCovers || 2),
      timeout,
    });
    stage = 'root idle';
    await page.waitForFunction(() => {
      return typeof state !== 'undefined'
        && !state.busy
        && !String(state.ui?.activeViewRequestUrl || '').trim();
    }, null, { timeout });
  } catch (error) {
    try {
      const diagnostics = await readWarmRootDiagnostics(page);
      console.log(`[real-app-warm-root] stage=${stage} timeout=${timeout}ms diagnostics=${JSON.stringify(diagnostics)}`);
    } catch (diagnosticError) {
      console.log(`[real-app-warm-root] stage=${stage} timeout=${timeout}ms diagnostics_unavailable=${String(diagnosticError?.message || diagnosticError)}`);
    }
    throw error;
  }
}

export async function enterAndWaitForPostgresBrowseWarmRoot(
  page,
  galleryActions,
  navigationPanelActions,
  scanPageActions,
  options = {},
) {
  const loaderState = await readLibraryStartupEntryState(page, galleryActions, navigationPanelActions);
  if (loaderState?.visible
    && String(loaderState?.startupMode || '') === 'loader-first'
    && loaderState?.browseButtonVisible) {
    await scanPageActions.clickBrowseScannedLibrary();
  }
  await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions, options);
}

export function createCoverResponseFailureCollector(page) {
  const failures = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/cover' && response.status() >= 400) {
      failures.push({
        status: response.status(),
        url: response.url(),
      });
    }
  });
  return {
    failures,
    assertNoFailures() {
      expect(failures, `Expected all real-data /cover responses to succeed, failures=${JSON.stringify(failures)}`).toEqual([]);
    },
  };
}
