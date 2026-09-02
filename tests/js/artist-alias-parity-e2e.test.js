const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..', '..');

function moduleUrl(relativePath) {
  return pathToFileURL(path.join(repoRoot, relativePath)).href;
}

test('alias parity helper keeps empty-key fixture albums mutually isolated', async () => {
  const helpers = await import(moduleUrl('tests/e2e/helpers/artistAliasParityHelpers.js'));

  assert.deepEqual(
    helpers.expectedOtherEmptyKeyAlbums('東京事変'),
    ['Boris Signal', 'Three Bangs', 'Three Stars'],
  );
  assert.equal(helpers.MORSE_ALBUMS[0].credit, 'Morse Portnoy George');
  assert.equal(helpers.MORSE_ALBUMS[1].credit, 'Morse, Portnoy & George');
  assert.equal(helpers.WHITESPACE_DISPLAY_ARTIST, 'Signal  Family Lead');
  assert.equal(helpers.WHITESPACE_SEARCH_ARTIST, 'Signal Family Lead');
  assert.equal(helpers.WHITESPACE_ALBUM_YEAR, 2011);
});

test('FTC-SEARCH-NAV-022 keeps startup, collapsed search, and family browsing in order', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/specs/artistAliasParity.spec.js'),
    'utf8',
  );
  const scenario = source.split("test('FTC-SEARCH-NAV-022", 2)[1];
  const checkpoints = [
    'expectStartupProjectionRebuilt(expect, startupRelationProjectionReadiness)',
    'readSidebarArtistNameCount(WHITESPACE_DISPLAY_ARTIST)',
    'search(WHITESPACE_SEARCH_ARTIST',
    'waitForArtistHeadings([',
    'waitForAlbumVisibleUnderHeading(WHITESPACE_DISPLAY_ARTIST, WHITESPACE_ALBUM)',
    'WHITESPACE_RELATED_ARTIST,',
    'WHITESPACE_RELATED_ALBUM,',
    'readAlbumCreditByName(WHITESPACE_ALBUM)',
    'readAlbumYearByName(WHITESPACE_ALBUM)',
    'waitForViewReady(WHITESPACE_DISPLAY_ARTIST',
    'readChipTexts()',
    'clickChipByName(WHITESPACE_RELATED_ARTIST)',
    'waitForOnlyArtistHeadings([WHITESPACE_RELATED_ARTIST])',
    'readArtistHeadings()).not.toContain(WHITESPACE_DISPLAY_ARTIST)',
    'waitForAlbumVisibleUnderHeading(',
  ];
  let cursor = -1;
  for (const checkpoint of checkpoints) {
    const next = scenario.indexOf(checkpoint, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order whitespace checkpoint: ${checkpoint}`);
    cursor = next;
  }
  assert.doesNotMatch(scenario, /page\.(?:route|evaluate|addInitScript|setContent)\s*\(/);
});

test('startup projection evidence is captured once before state-mutating scenarios', () => {
  const fixtureSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/support/baseFixtures.js'),
    'utf8',
  );
  const helperSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/helpers/startupRelationProjectionReadiness.js'),
    'utf8',
  );
  const fixture = fixtureSource
    .split('startupRelationProjectionReadiness:', 2)[1]
    ?.split('galleryActions:', 1)[0] || '';

  assert.match(
    fixtureSource,
    /readAuthenticatedStartupRelationProjectionReadiness/,
  );
  assert.match(fixture, /scope:\s*'worker'/);
  assert.match(fixture, /auto:\s*true/);
  assert.match(
    fixture,
    /use\(await readAuthenticatedStartupRelationProjectionReadiness\(/,
  );
  assert.doesNotMatch(fixture, /(?:post|put|patch|delete)\s*\(/i);
  assert.match(helperSource, /const statusURL = new URL\('\/status', baseURL\)/);
  assert.match(helperSource, /method:\s*'GET'/);
  assert.match(helperSource, /payload\?\.relation_projection/);
  assert.doesNotMatch(helperSource, /method:\s*'(?:POST|PUT|PATCH|DELETE)'/i);
});

test('gallery action shapes production status telemetry and reads exact card credit', async () => {
  const { GalleryActions } = await import(moduleUrl('tests/e2e/actions/galleryActions.js'));
  const actions = new GalleryActions({
    async readLatestProductionViewPayload() {
      return {
        persistence_backend: 'postgres',
        persistence_seam: 'library_browse',
        view_data_source: 'postgres_library_browse',
      };
    },
    async readStatusPayload() {
      return {
        relation_projection: {
          ready: true,
          startup_rebuilt: true,
          rebuild_reason: 'missing_projection',
          duration_ms: 12.5,
        },
      };
    },
    albumCard: {
      subtitleByAlbumName(albumName) {
        assert.equal(albumName, 'Cover 2 Cover');
        return { async textContent() { return 'Morse, Portnoy & George · 2012'; } };
      },
      yearByAlbumName(albumName) {
        assert.equal(albumName, 'Cover 2 Cover');
        return { async textContent() { return '2012'; } };
      },
    },
  });

  assert.deepEqual(await actions.readRelationProjectionReadiness(), {
    ready: true,
    startupRebuilt: true,
    rebuildReason: 'missing_projection',
    durationMs: 12.5,
  });
  assert.equal(
    await actions.readAlbumCreditByName('Cover 2 Cover'),
    'Morse, Portnoy & George · 2012',
  );
  assert.equal(await actions.readAlbumYearByName('Cover 2 Cover'), '2012');
  assert.deepEqual(await actions.readBrowseTelemetry(), {
    persistenceBackend: 'postgres',
    persistenceSeam: 'library_browse',
    viewDataSource: 'postgres_library_browse',
  });
});

test('navigation action delegates exact sidebar identity counting to its POM', async () => {
  const { NavigationPanelActions } = await import(
    moduleUrl('tests/e2e/actions/navigationPanelActions.js')
  );
  const requested = [];
  const actions = new NavigationPanelActions({
    sidebarArtistByName(name) {
      requested.push(name);
      return { async count() { return 1; } };
    },
  });

  assert.equal(await actions.readSidebarArtistNameCount('Morse Portnoy George'), 1);
  assert.deepEqual(requested, ['Morse Portnoy George']);
});

test('navigation action reads the exact canonical sidebar album count through its POM', async () => {
  const { NavigationPanelActions } = await import(
    moduleUrl('tests/e2e/actions/navigationPanelActions.js')
  );
  const requested = [];
  const actions = new NavigationPanelActions({
    sidebarArtistCountByName(name) {
      requested.push(name);
      return { async textContent() { return '2'; } };
    },
  });

  assert.equal(await actions.readSidebarArtistAlbumCount('Morse Portnoy George'), 2);
  assert.deepEqual(requested, ['Morse Portnoy George']);
});

test('album-card POM owns the exact subtitle selector used by the action layer', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/poms/albumCard.js'),
    'utf8',
  );

  assert.match(source, /get subtitleWithinCardSelector\(\) \{\s+return '\.album-subtitle';/);
  assert.match(source, /subtitleByAlbumName\(albumName\)/);
  assert.match(source, /cardByAlbumName\(albumName\)\.locator\(this\.subtitleWithinCardSelector\)/);
  assert.match(source, /yearByAlbumName\(albumName\)/);
  assert.match(source, /cardByAlbumName\(albumName\)\.locator\(this\.yearWithinCardSelector\)/);
  assert.doesNotMatch(source, /\.evaluate(?:All)?\s*\(/);
});

test('alias parity spec stays scenario-only and avoids browser-side mutation shortcuts', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/specs/artistAliasParity.spec.js'),
    'utf8',
  );

  assert.doesNotMatch(source, /\.locator\s*\(/);
  assert.doesNotMatch(source, /\.evaluate\s*\(/);
  assert.doesNotMatch(source, /page\.(?:route|addInitScript|setContent)\s*\(/);
  assert.doesNotMatch(source, /(?:rebuild|setup|test)[-_ ]route/i);
});

test('FTC-SEARCH-NAV-020 preserves the approved family-chip transition sequence', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/specs/artistAliasParity.spec.js'),
    'utf8',
  );
  const familyStep = source
    .split("stepLogger.step('Exercise the existing Artist Family chip semantics", 2)[1]
    .split("stepLogger.step('Keep both source credits under the canonical root grouping'", 1)[0];
  const checkpoints = [
    "clickChipByName('Neal Morse')",
    "waitForOnlyArtistHeadings(['Neal Morse'])",
    'waitForAlbumHidden(fixture.album)',
    'clickPrimaryChip()',
    "waitForPrimaryAndRelatedFilterActive('Neal Morse')",
    "waitForOnlyArtistHeadings([MORSE_CANONICAL_ARTIST, 'Neal Morse'])",
    'expectMorseAlbums(expect, galleryActions)',
    "clickChipByName('Neal Morse')",
    "waitForChipActive('Neal Morse', false)",
    'waitForOnlyArtistHeadings([MORSE_CANONICAL_ARTIST])',
  ];
  let cursor = -1;
  for (const checkpoint of checkpoints) {
    const next = familyStep.indexOf(checkpoint, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order family checkpoint: ${checkpoint}`);
    cursor = next;
  }
  assert.match(familyStep, /expect\(nealOnlyAlbums\.length\)\.toBeGreaterThan\(0\)/);
  assert.match(familyStep, /expect\(nealOnlyAlbums\)\.not\.toContain\(fixture\.album\)/);
});

test('FTC-SEARCH-NAV-020 resets a real deep gallery viewport through family-tree selection', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/specs/artistAliasParity.spec.js'),
    'utf8',
  );
  const resetStep = source
    .split("stepLogger.step('Reset the deep gallery viewport when the family tree selects a different artist'", 2)[1]
    .split("stepLogger.step('Keep both source credits under the canonical root grouping'", 1)[0];
  const checkpoints = [
    'searchToolbarActions.search(MORSE_CANONICAL_ARTIST, { submitWithEnter: true })',
    'searchToolbarActions.waitForQuery(MORSE_CANONICAL_ARTIST)',
    'artistFamilyActions.waitForViewReady(MORSE_CANONICAL_ARTIST, {',
    "selectSidebarArtistByName('Neal Morse')",
    "artistFamilyActions.waitForViewReady('Neal Morse', {",
    'waitForAlbumVisibleUnderHeading(',
    'selectSidebarArtistByName(MORSE_CANONICAL_ARTIST)',
    'artistFamilyActions.waitForViewReady(MORSE_CANONICAL_ARTIST, {',
    'jumpGalleryToMiddle()',
    "selectSidebarArtistByName('Neal Morse')",
    "waitForSidebarSelection('Neal Morse')",
    "artistFamilyActions.waitForViewReady('Neal Morse', {",
    'waitForGalleryScrollAtStart()',
    'readArtistSelectionGalleryViewportState(',
    'expectNealMorseScrollResetViewport(expect, viewport)',
  ];
  let cursor = -1;
  for (const checkpoint of checkpoints) {
    const next = resetStep.indexOf(checkpoint, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order scroll-reset checkpoint: ${checkpoint}`);
    cursor = next;
  }
  assert.doesNotMatch(resetStep, /viewport\.album/);
});

test('jumpGalleryToMiddle waits for real wheel movement before reading its snapshot', () => {
  const actionSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/actions/galleryActions.js'),
    'utf8',
  );
  const scrollMethod = actionSource
    .split('async scrollGalleryToMiddle()', 2)[1]
    .split('async readRelationProjectionReadiness', 1)[0];
  const checkpoints = [
    'readGalleryScrollState()',
    'scrollGalleryBy(deltaY)',
    'waitForGalleryScrollMovement(',
  ];
  let cursor = -1;
  for (const checkpoint of checkpoints) {
    const next = scrollMethod.indexOf(checkpoint, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order real-scroll checkpoint: ${checkpoint}`);
    cursor = next;
  }
});

test('artist-selection viewport evidence stays action-owned and read-only', () => {
  const actionSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/actions/galleryActions.js'),
    'utf8',
  );
  const viewportMethods = actionSource
    .split('async readArtistHeadingGalleryViewportState(artistName)', 2)[1]
    .split('async scrollAlbumAwayFromViewport', 1)[0];

  assert.match(viewportMethods, /this\.galleryPage\.headingByArtistName\(artistName\)/);
  assert.match(viewportMethods, /this\.galleryPage\.firstAlbumCardByArtistName\(artistName\)/);
  assert.match(viewportMethods, /heading\.boundingBox\(\)/);
  assert.match(viewportMethods, /this\.readGalleryScrollState\(\)/);
  assert.match(
    viewportMethods,
    /this\.readAlbumGalleryViewportState\(artistName, retainedAlbumName\)/,
  );
  assert.doesNotMatch(viewportMethods, /\.evaluate(?:All)?\s*\(/);
  assert.doesNotMatch(viewportMethods, /\.click\s*\(|mouse\.wheel|scrollIntoView/);
});

test('FTC-SEARCH-NAV-020 viewport helper separates the first visible Neal card from retained Joseph presence', () => {
  const helperSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/helpers/artistAliasParityHelpers.js'),
    'utf8',
  );
  assert.match(helperSource, /NEAL_MORSE_RETAINED_ALBUM = 'Joseph: Part One - The Dreamer'/);
  assert.match(helperSource, /viewport\.heading[\s\S]*?attached: true[\s\S]*?intersects: true[\s\S]*?offscreen: false/);
  assert.match(helperSource, /viewport\.firstAlbum[\s\S]*?attached: true[\s\S]*?intersects: true[\s\S]*?offscreen: false/);
  assert.match(helperSource, /viewport\.retainedAlbum[\s\S]*?attached: true[\s\S]*?intersects: false[\s\S]*?offscreen: true/);
});

test('FTC-SEARCH-NAV-020 POM owns the selected artist first-card locator', () => {
  const pomSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/poms/galleryPage.js'),
    'utf8',
  );
  const method = pomSource
    .split('firstAlbumCardByArtistName(artistName)', 2)[1]
    .split('async readStatusPayload()', 1)[0];
  assert.match(method, /this\.sectionByArtistHeading\(artistName\)/);
  assert.match(method, /this\.albumCardWithinSectionSelector/);
  assert.match(method, /\.first\(\)/);
});

test('FTC-SEARCH-NAV-020 verifies root aggregation before real sidebar regrouping', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/specs/artistAliasParity.spec.js'),
    'utf8',
  );
  const rootStep = source
    .split("stepLogger.step('Keep both source credits under the canonical root grouping'", 2)[1];
  const checkpoints = [
    'searchToolbarActions.clearSearch({ submitWithEnter: true })',
    "searchToolbarActions.waitForQuery('')",
    'clickAllArtists({ expectArtistQueryCleared: true })',
    'waitForInitialAllArtistsSections({ minimumHeadingCount: 4 })',
    'readSidebarArtistNameCount(MORSE_CANONICAL_ARTIST)',
    'readSidebarArtistAlbumCount(MORSE_CANONICAL_ARTIST)',
    'readSidebarArtistNameCount(MORSE_ALIAS_ARTIST)',
    'selectSidebarArtistByName(MORSE_CANONICAL_ARTIST)',
    'waitForSidebarSelection(MORSE_CANONICAL_ARTIST)',
    'expectMorseAlbums(expect, galleryActions)',
  ];
  let cursor = -1;
  for (const checkpoint of checkpoints) {
    const next = rootStep.indexOf(checkpoint, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order root regrouping checkpoint: ${checkpoint}`);
    cursor = next;
  }
  assert.doesNotMatch(rootStep, /scrollToAlbumUnderHeading/);
});

test('artist-family actions delegate exact chip identity to the POM', () => {
  const actionSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/actions/artistFamilyActions.js'),
    'utf8',
  );
  const pomSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/poms/artistFamily.js'),
    'utf8',
  );

  assert.match(actionSource, /this\.artistFamily\.chipByName\(name\)\.click/);
  assert.match(pomSource, /chipByName\(name\)/);
  assert.match(pomSource, /hasText: exactNormalizedText\(name\)/);
  assert.doesNotMatch(actionSource, /chips\.filter\(\{ hasText: name \}\)/);
});

test('isolated pre-start inventory gives every alias fixture one album without runtime branching', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/support/isolatedLibraryApp.py'),
    'utf8',
  );
  const buildFileCache = source
    .split('def build_file_cache(', 2)[1]
    .split('def materialize_file_cache_tracks', 1)[0];

  assert.match(buildFileCache, /alias_fixture_indices = set\(alias_artist_by_index\)/);
  assert.match(
    buildFileCache,
    /redistributed_album_count = len\(alias_fixture_indices\) \* max\(0, albums_per_artist - 1\)/,
  );
  assert.match(buildFileCache, /1\s+if artist_index in alias_fixture_indices/);
  assert.match(buildFileCache, /artist in WHITESPACE_FAMILY_FIXTURES/);
  assert.match(buildFileCache, /"Whitespace Family"/);
  assert.doesNotMatch(buildFileCache, /(?:scenario|runtime|request|route).*alias/i);
});

test('alias parity support reads production responses and DOM locators without evaluate telemetry', () => {
  const helperSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/helpers/artistAliasParityHelpers.js'),
    'utf8',
  );
  const pomSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/poms/galleryPage.js'),
    'utf8',
  );
  const observerSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/helpers/productionViewObserver.js'),
    'utf8',
  );
  const actionSource = fs.readFileSync(
    path.join(repoRoot, 'tests/e2e/actions/galleryActions.js'),
    'utf8',
  );
  const telemetryMethod = actionSource
    .split('async readBrowseTelemetry()', 2)[1]
    .split('async readAlbumCreditByName', 1)[0];
  const aliasActionMethods = actionSource
    .split('async readAlbumNamesByHeading(artistName)', 2)[1]
    .split('async clickAlbumDetailsByArtistAndAlbum', 1)[0];
  const responseMethod = pomSource
    .split('async readStatusPayload()', 2)[1]
    .split('async waitForCoverSchedulerIdle', 1)[0];

  assert.doesNotMatch(helperSource, /\.evaluate(?:All)?\s*\(/);
  assert.doesNotMatch(aliasActionMethods, /\.evaluate(?:All)?\s*\(/);
  assert.doesNotMatch(telemetryMethod, /\.evaluate(?:All)?\s*\(/);
  assert.doesNotMatch(responseMethod, /\.evaluate(?:All)?\s*\(/);
  assert.match(pomSource, /new ProductionViewObserver\(page\)/);
  assert.match(observerSource, /page\.on\('response'/);
  assert.match(observerSource, /\['\/view-data', '\/home-data'\]/);
  assert.match(observerSource, /latestFullRequestSequence/);
  assert.match(telemetryMethod, /readLatestProductionViewPayload/);
});

test('Morse helper requires exactly two titles, exact years, and exact raw subtitle credits', async () => {
  const helpers = await import(moduleUrl('tests/e2e/helpers/artistAliasParityHelpers.js'));
  const observed = {
    'Cover to Cover': { credit: 'Morse Portnoy George', year: '2006' },
    'Cover 2 Cover': { credit: 'Morse, Portnoy & George', year: '2012' },
  };
  const expect = (actual) => ({
    toBe(expected) { assert.equal(actual, expected); },
    toEqual(expected) { assert.deepEqual(actual, expected); },
  });

  await helpers.expectMorseAlbums(expect, {
    async readAlbumNamesByHeading() { return Object.keys(observed); },
    async waitForAlbumVisibleUnderHeading(_artist, album) { assert.ok(observed[album]); },
    async readAlbumCreditByName(album) { return observed[album].credit; },
    async readAlbumYearByName(album) { return observed[album].year; },
  });
});
