const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n?/gu, '\n');
}

test('FTC-COVERS-016 keeps the 7500px local cover active when matching remote art is not an improvement', () => {
  const spec = read('tests/e2e/specs/coverLookupMatching.spec.js');
  const allowedResolutionSet = spec.match(
    /const ALLOWED_MATCH_RESOLUTIONS = new Set\(\[([\s\S]*?)\]\);/u,
  );

  assert.ok(allowedResolutionSet, 'FTC-COVERS-016 must keep an explicit allowed-resolution set.');
  assert.match(allowedResolutionSet[1], /'2937x6819'/u);
  assert.match(allowedResolutionSet[1], /'4518x4518'/u);
  assert.match(spec, /const FALSE_MATCH_NAMES = \[[\s\S]*?\];/u);
  assert.match(spec, /const FALSE_MATCH_RESOLUTIONS = new Set\(\[[\s\S]*?\]\);/u);
  assert.match(spec, /const FALSE_ARTIST_IDENTITIES = \[[\s\S]*?\];/u);
  assert.match(
    spec,
    /expect\(candidates\.some\(\(candidate\) => FALSE_MATCH_NAMES\.includes\(candidate\.name\)\)\)\.toBe\(false\)/u,
  );
  assert.match(
    spec,
    /expect\(candidates\.some\(\(candidate\) => FALSE_MATCH_RESOLUTIONS\.has\(candidate\.resolution\)\)\)[\s\S]*?\.toBe\(false\)/u,
  );
  assert.match(
    spec,
    /baselineLocalCover = await coverLookupActions\.readActiveLocalCoverEvidence\(\);[\s\S]*?expect\(baselineLocalCover\.isActive\)\.toBe\(true\);[\s\S]*?expect\(baselineLocalCover\.image\.naturalWidth\)\.toBe\(480\);[\s\S]*?expect\(baselineLocalCover\.resolution\)\.toBe\('7500x7500'\);/u,
  );
  assert.match(
    spec,
    /baselineFullSizeCover = await coverLookupActions\.readFullSizeCoverEvidence\(\{[\s\S]*?source: baselineLocalCover\.fullSizeSource,[\s\S]*?\}\);/u,
  );
  assert.match(
    spec,
    /expect\(providerEvidence\.fixture_original_source_sha256\)\.toBe\(\s*baselineFullSizeCover\.sha256\.toLowerCase\(\),?\s*\);/u,
  );
  assert.match(
    spec,
    /expect\(providerEvidence\.fixture_candidate_artists\)[\s\S]*?\.toEqual\(expect\.arrayContaining\(FALSE_ARTIST_IDENTITIES\)\);/u,
  );
  assert.match(
    spec,
    /const selectedCandidates = candidates\.filter\(\(candidate\) => candidate\.selected\);\s*expect\(selectedCandidates\)\.toHaveLength\(0\);/u,
  );
  assert.match(
    spec,
    /preservedLocalCover = await coverLookupActions\.readActiveLocalCoverEvidence\(\);[\s\S]*?expect\(preservedLocalCover\.isActive\)\.toBe\(true\);[\s\S]*?expect\(preservedLocalCover\.sourcePath\)\.toBe\(baselineLocalCover\.sourcePath\);[\s\S]*?expect\(preservedLocalCover\.image\.naturalWidth\)\.toBe\(480\);[\s\S]*?expect\(preservedLocalCover\.resolution\)\.toBe\('7500x7500'\);/u,
  );
  assert.match(
    spec,
    /preservedFullSizeCover = await coverLookupActions\.readFullSizeCoverEvidence\(\{[\s\S]*?source: preservedLocalCover\.fullSizeSource,[\s\S]*?\}\);[\s\S]*?expect\(preservedFullSizeCover\.sha256\)\.toBe\(baselineFullSizeCover\.sha256\);/u,
  );
  assert.match(spec, /expect\(thirdPartyRequestEvidence\.snapshot\(\)\)\.toEqual\(\[\]\);/u);
});

test('cover lookup local-card resolution locators stay owned by the CoverLookup POM', () => {
  const pom = read('tests/e2e/poms/coverLookup.js');
  const actions = read('tests/e2e/actions/coverLookupActions.js');

  assert.match(
    pom,
    /localCoverResolutionWithin\(card\)\s*\{[\s\S]*?card\.locator\(this\.localCoverResolutionWithinCardSelector\)\.first\(\);?[\s\S]*?\}/u,
    'CoverLookup must expose the local-cover resolution locator through its POM API.',
  );
  assert.doesNotMatch(
    actions,
    /\.locator\s*\(/u,
    'CoverLookupActions must consume POM-owned locators instead of constructing locators.',
  );
  assert.match(
    actions,
    /this\.coverLookup\.localCoverResolutionWithin\(card\)\.textContent\(\)/u,
    'Local-cover evidence must read its resolution through the CoverLookup POM.',
  );
});

test('core E2E actions use real Playwright input without DOM event fallbacks', () => {
  const appBar = read('tests/e2e/actions/appBarActions.js');
  const navigation = read('tests/e2e/actions/navigationPanelActions.js');
  const player = read('tests/e2e/actions/globalPlayerActions.js');
  const loops = read('tests/e2e/actions/utilityLoopsActions.js');

  for (const source of [appBar, navigation, player, loops]) {
    assert.doesNotMatch(source, /\.dispatchEvent\s*\(/);
    assert.doesNotMatch(source, /\.evaluate\s*\(/);
  }
  assert.match(appBar, /scanIndicator\.click\(\{ button: 'right' \}\)/);
  assert.doesNotMatch(navigation, /\.click\(\{[\s\S]*?force\s*:/);
  assert.match(navigation, /clickAllArtists does not accept forced clicks/);
  assert.match(player, /loopStartHandle\.focus\(\)[\s\S]*keyboard\.press\('Escape'\)/);
  assert.match(player, /page\.mouse\.down\(\)[\s\S]*page\.mouse\.move\([\s\S]*page\.mouse\.up\(\)/);
  assert.doesNotMatch(loops, /catch\s*\([^)]*\)\s*\{[\s\S]*data-loop-play/);
});

test('tag-save permission fault injection is isolated, allowlisted, and idempotently restored', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/postgresPrivilegeHelpers.js'),
  ).href;
  const { temporarilyRevokeRuntimeDeletePrivileges } = await import(moduleUrl);
  const validEnv = {
    ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
      'postgresql://album_haven_migrator_f_123_1_2@localhost:5432/album_haven_ci_f_123_1_2',
  };
  let rejectedExecCount = 0;
  const rejectedExec = async () => {
    rejectedExecCount += 1;
    return { stdout: '' };
  };

  await assert.rejects(
    temporarilyRevokeRuntimeDeletePrivileges(
      ['library.ignored_versions'],
      {
        env: {
          ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL:
            'postgresql://album_haven_migrator@localhost:5432/album_haven_core',
        },
        execFileAsync: rejectedExec,
        platform: 'win32',
      },
    ),
    /requires album_haven_fake_e2e/u,
  );
  await assert.rejects(
    temporarilyRevokeRuntimeDeletePrivileges(
      ['library.local_albums'],
      {
        env: validEnv,
        execFileAsync: rejectedExec,
        platform: 'win32',
      },
    ),
    /rejects library\.local_albums/u,
  );
  assert.equal(rejectedExecCount, 0);

  const calls = [];
  const execFileAsync = async (command, args, options) => {
    calls.push({ args, command, options });
    if (calls.length === 1) {
      return {
        stdout: [
          'library.ignored_versions|t',
          'library.manual_versions|true',
          '',
        ].join('\n'),
      };
    }
    return { stdout: '' };
  };
  const guard = await temporarilyRevokeRuntimeDeletePrivileges(
    ['library.manual_versions', 'library.ignored_versions'],
    { env: validEnv, execFileAsync, platform: 'win32' },
  );
  await guard.restore();
  await guard.restore();

  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.options.windowsHide === true));
  assert.ok(calls.every((call) => (
    call.args.includes('--set=ON_ERROR_STOP=1')
    && call.args.some((arg) => arg.includes('album_haven_ci_f_123_1_2'))
  )));
  assert.match(calls[0].args.at(-1), /has_table_privilege\('album_haven_app_f_123_1_2'/u);
  assert.match(calls[1].args.at(-1), /^--command=revoke delete on table library\.ignored_versions, library\.manual_versions from album_haven_app_f_123_1_2$/u);
  assert.match(calls[2].args.at(-1), /^--command=grant delete on table library\.ignored_versions, library\.manual_versions to album_haven_app_f_123_1_2$/u);

  let prebrokenCalls = 0;
  await assert.rejects(
    temporarilyRevokeRuntimeDeletePrivileges(
      ['library.ignored_versions', 'library.manual_versions'],
      {
        env: validEnv,
        execFileAsync: async () => {
          prebrokenCalls += 1;
          return {
            stdout: [
              'library.ignored_versions|t',
              'library.manual_versions|f',
              '',
            ].join('\n'),
          };
        },
        platform: 'win32',
      },
    ),
    /missing library\.manual_versions/u,
  );
  assert.equal(prebrokenCalls, 1);
});

test('FTC-TAGS-023 keeps SQL in a helper and browser behavior in actions', () => {
  const helper = read('tests/e2e/helpers/postgresPrivilegeHelpers.js');
  const connectionGuard = read('tests/e2e/helpers/isolatedPostgresConnection.js');
  const tagEditorActions = read('tests/e2e/actions/tagEditorActions.js');
  const trackModalActions = read('tests/e2e/actions/trackModalActions.js');
  const spec = read('tests/e2e/specs/nonAlbumRarity.spec.js');

  assert.match(helper, /ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL/);
  assert.match(helper, /resolveIsolatedE2ESetupConnection/);
  assert.match(connectionGuard, /album_haven_fake_e2e/);
  assert.match(connectionGuard, /album_haven_ci_<suffix>\/album_haven_migrator_<suffix>/);
  assert.match(helper, /library\.ignored_versions/);
  assert.match(helper, /library\.manual_versions/);
  assert.doesNotMatch(spec, /\b(?:execFile|psql|revoke delete|grant delete)\b/iu);
  assert.match(
    tagEditorActions,
    /applyAndWaitForAsyncFailure[\s\S]*save_task_id[\s\S]*toBe\('failed'\)[\s\S]*repairAlertMessage\)\.toContainText\([\s\S]*failedTaskError[\s\S]*editPayload:\s*payload/,
  );
  assert.match(
    trackModalActions,
    /readAlbumIdentity[\s\S]*editTagsButton\.getAttribute\('data-album-key'\)/,
  );
  assert.match(
    spec,
    /FTC-TAGS-023[\s\S]*temporarilyRevokeRuntimeDeletePrivileges[\s\S]*applyAndWaitForAsyncFailure[\s\S]*privilegeGuard\.restore\(\)[\s\S]*applyAndWaitForSavedFiles/,
  );
});

test('FTC-NON-ALBUM-006 keeps one canonical rarity album before and after reload', () => {
  const spec = read('tests/e2e/specs/nonAlbumRarity.spec.js');
  const scenarioStart = spec.indexOf(
    "test('FTC-NON-ALBUM-010 / FTC-NON-ALBUM-009 / FTC-NON-ALBUM-008 / FTC-NON-ALBUM-007 / FTC-NON-ALBUM-006 / FTC-TAGS-007 / FTC-NON-ALBUM-005 keeps rarity modal transitions and sibling album state canonical'",
  );
  const scenarioEnd = spec.indexOf('\ntest(', scenarioStart + 1);
  assert.ok(scenarioStart >= 0, 'Expected the combined rarity scenario.');
  const scenario = spec.slice(
    scenarioStart,
    scenarioEnd >= 0 ? scenarioEnd : spec.length,
  );
  const albumReadCall = 'const albumNames = await galleryActions.readAlbumNamesByHeading(RARITY_ARTIST);';
  const albumReadPositions = [...scenario.matchAll(
    /const albumNames = await galleryActions\.readAlbumNamesByHeading\(RARITY_ARTIST\);/gu,
  )].map((match) => match.index);

  assert.match(scenario, /async \(\{[\s\S]*navigationPanelActions,[\s\S]*\}\) =>/u);
  assert.equal(albumReadPositions.length, 2, 'Expected canonical-card checks before and after reload.');
  assert.match(
    scenario.slice(0, albumReadPositions[0]),
    /trackModalActions\.close\(\);[\s\S]*searchToolbarActions\.clearSearch\(\{ submitWithEnter: true \}\);[\s\S]*searchToolbarActions\.waitForQuery\(''\);[\s\S]*galleryActions\.waitForGalleryReady\(\);[\s\S]*navigationPanelActions\.selectSidebarArtistByName\(RARITY_ARTIST\);[\s\S]*navigationPanelActions\.waitForSidebarSelection\(RARITY_ARTIST\);\s*$/u,
  );
  assert.match(
    scenario.slice(albumReadPositions[0] + albumReadCall.length, albumReadPositions[1]),
    /expect\(albumNames\.filter\(\(albumName\) => albumName === RARITY_ALBUM\)\)\.toEqual\(\[RARITY_ALBUM\]\);[\s\S]*expect\(new Set\(albumNames\)\.size\)\.toBe\(albumNames\.length\);[\s\S]*searchToolbarActions\.reloadCurrentView\(\);[\s\S]*galleryActions\.waitForGalleryReady\(\);[\s\S]*searchToolbarActions\.waitForQuery\(''\);[\s\S]*navigationPanelActions\.waitForSidebarSelection\(RARITY_ARTIST\);[\s\S]*galleryActions\.waitForAlbumVisibleUnderHeading\(RARITY_ARTIST, RARITY_ALBUM\);\s*$/u,
  );
  assert.match(
    scenario.slice(albumReadPositions[1] + albumReadCall.length),
    /expect\(albumNames\.filter\(\(albumName\) => albumName === RARITY_ALBUM\)\)\.toEqual\(\[RARITY_ALBUM\]\);[\s\S]*expect\(new Set\(albumNames\)\.size\)\.toBe\(albumNames\.length\);/u,
  );
});

test('search-clear observation latches family visibility only from an atomic active-request sample', () => {
  const searchToolbar = read('tests/e2e/poms/searchToolbar.js');

  assert.match(
    searchToolbar,
    /artistFamilyPanelVisible:\s*visible\(artistFamilyPanel\),[\s\S]*?runtimeViewRequestActive:/,
  );
  assert.match(
    searchToolbar,
    /familyControlsVisibleDuringActiveRequest\s*\|\|=\s*Boolean\(\s*domResult\.artistFamilyPanelVisible\s*&&\s*domResult\.runtimeViewRequestActive\s*\)/,
  );
  assert.doesNotMatch(
    searchToolbar,
    /familyControlsVisibleDuringActiveRequest\s*\|\|=\s*Boolean\(\s*activeViewDataRequests\.size\s*>\s*0/,
  );
  assert.match(
    searchToolbar,
    /familyControlsVisibleDuringActiveRequest:\s*finalTransitionObservation\.familyControlsVisibleDuringActiveRequest/,
  );
});

test('active sidebar viewport evidence uses the scrolling sidebar and excludes the player overlap', () => {
  const navigation = read('tests/e2e/actions/navigationPanelActions.js');

  assert.match(
    navigation,
    /document\.querySelector\(selectors\.sidebarScrollContainerSelector\)/,
  );
  assert.match(
    navigation,
    /document\.querySelector\(selectors\.globalPlayerSelector\)/,
  );
  assert.match(navigation, /activeRect\.top >= sidebarRect\.top \+ selectors\.viewportPadding/);
  assert.match(
    navigation,
    /const visibleBottom = Math\.min\([\s\S]*sidebarRect\.bottom - selectors\.viewportPadding,[\s\S]*playerRect\.top - selectors\.viewportPadding[\s\S]*activeRect\.bottom <= visibleBottom/,
  );
  assert.doesNotMatch(navigation, /sidebarList\.getBoundingClientRect\(\)/);
});

test('offscreen sidebar setup scrolls the opposite boundary based on the target position', () => {
  const navigation = read('tests/e2e/actions/navigationPanelActions.js');

  assert.match(navigation, /const firstArtist = this\.navigationPanel\.sidebarArtists\.first\(\)/);
  assert.match(navigation, /const lastArtist = this\.navigationPanel\.sidebarArtists\.last\(\)/);
  assert.match(navigation, /const artistCount = await this\.navigationPanel\.sidebarArtists\.count\(\)/);
  assert.match(navigation, /let targetIndex = -1/);
  assert.match(
    navigation,
    /sidebarArtists\.nth\(index\)\.getAttribute\('data-sidebar-artist'\)/,
  );
  assert.match(
    navigation,
    /targetIndex >= artistCount \/ 2[\s\S]*\? firstArtist[\s\S]*: lastArtist/,
  );
  assert.match(navigation, /await boundaryArtist\.scrollIntoViewIfNeeded\(\)/);
  assert.match(navigation, /timeout: options\.timeout \|\| 10000/);
});

test('search correctness E2E covers identical-query reselection and debounce-only no-match clearing', () => {
  const actions = read('tests/e2e/actions/searchToolbarActions.js');
  const spec = read('tests/e2e/specs/searchTreeCorrectness.spec.js');
  const naturalClearStart = actions.indexOf('async clearSearchByInputDebounce(options = {})');
  const naturalClearEnd = actions.indexOf('\n  async ', naturalClearStart + 1);
  assert.ok(naturalClearStart >= 0, 'Expected a debounce-only search-clear action.');
  const naturalClear = actions.slice(
    naturalClearStart,
    naturalClearEnd >= 0 ? naturalClearEnd : actions.length,
  );

  assert.match(naturalClear, /input\.fill\(''\)/);
  assert.match(naturalClear, /recentSearchPopover\)\.toBeHidden/);
  assert.match(naturalClear, /waitForQuery\('', options\)/);
  assert.doesNotMatch(naturalClear, /\.press\('Enter'\)/);
  assert.doesNotMatch(naturalClear, /applyButton\.click\(\)/);
  assert.match(
    spec,
    /search\(ONE_FAMILY_QUERY, \{ submitWithEnter: true \}\)[\s\S]*waitForSidebarSelection\(ONE_FAMILY_QUERY\)/,
  );
  assert.match(
    spec,
    /search\(ONE_FAMILY_QUERY, \{ clickApply: true \}\)[\s\S]*waitForSidebarSelection\(ONE_FAMILY_QUERY\)/,
  );
  assert.match(
    spec,
    /openRecentSearches\(\)[\s\S]*clearSearchByInputDebounce\(\)[\s\S]*waitForGalleryReady\(\)[\s\S]*waitForGalleryScrollAtStart\(\)/,
  );
});

test('scan-cold retries a swallowed status-menu click before selecting the already-open menu action', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/appBarActions.js')).href;
  const { AppBarActions } = await import(moduleUrl);
  const interactions = [];
  let statusMenuVisible = false;
  const actions = new AppBarActions({
    scanIndicator: {
      async click(options) {
        interactions.push(options?.button === 'right' ? 'open-menu' : 'scan-indicator');
        if (interactions.filter((interaction) => interaction === 'open-menu').length >= 2) {
          statusMenuVisible = true;
        }
      },
    },
    scanActionButton: {
      async click() {
        interactions.push('select-action');
      },
    },
    statusContextMenu: {
      async isVisible() {
        return statusMenuVisible;
      },
    },
  });

  await actions.openStatusMenu();
  await actions.goToScanPage({ menuAlreadyOpen: true });

  assert.deepEqual(interactions, ['open-menu', 'open-menu', 'select-action']);
  assert.match(
    read('tests/e2e/scanPerformance/scanPerformance.spec.js'),
    /openStatusMenu\(\)[\s\S]{0,240}goToScanPage\(\{ menuAlreadyOpen: true \}\)/,
  );
});

test('FTC-OPS-003E requires local-image cover authority and keeps cancellation off the Scan Page', () => {
  const spec = read('tests/e2e/scanPerformance/scanPerformance.spec.js');
  const scenarioStart = spec.indexOf('test(`${SCAN_CANCEL_CASE_ID}');
  assert.ok(scenarioStart >= 0, 'Expected the FTC-OPS-003E Scan Page cancellation scenario.');
  const scenario = spec.slice(scenarioStart);

  assert.match(
    scenario,
    /waitForVisibleGalleryCoversLoaded\(\{\s*minimumCount:\s*6,\s*requireLocalImage:\s*true,\s*timeout:\s*60000,\s*\}\);/,
  );
  assert.match(
    scenario,
    /triggerIncrementalScanAndWaitForBusy\(\);\s*await scanPageActions\.expectCancelAbsent\(\);\s*await appBarActions\.openStatusMenu\(\);/,
  );
  assert.match(
    scenario,
    /triggerFullRescanAndWaitForBusy\(\);\s*await scanPageActions\.expectCancelAbsent\(\);\s*await appBarActions\.openStatusMenu\(\);/,
  );
  assert.match(
    read('music_app/static/js/runtime/status-ui-helpers.js'),
    /covers_in_progress[\s\S]*coverBusy[\s\S]*syncStatusContextButtonPresentation\(fetchOrCancelButton, \{[\s\S]*action: 'cancel-cover-scan'[\s\S]*label: 'Cancel Album Cover Scan'/,
  );
});

test('stable search clearing establishes user focus before observing network activity', () => {
  const actions = read('tests/e2e/actions/searchToolbarActions.js');
  const methodStart = actions.indexOf('async clearSearchAndObserveStableGallery(options = {})');
  const methodEnd = actions.indexOf('\n  async ', methodStart + 1);
  assert.ok(methodStart >= 0, 'Expected the stable search-clear action.');
  const method = actions.slice(methodStart, methodEnd >= 0 ? methodEnd : actions.length);

  assert.match(method, /input\.focus\(\)/);
  assert.ok(
    method.indexOf('input.focus()') < method.indexOf('startSearchClearTransitionObservation()'),
    'User focus must cancel pending gallery reconciliation before request observation starts.',
  );
});

test('Scan Page exit readiness checks every hidden control in one browser condition', () => {
  const actions = read('tests/e2e/actions/scanPageActions.js');
  const method = actions.match(
    /async waitForDedicatedPageHidden\(options = \{\}\) \{([\s\S]*?)\n  \}/u,
  );

  assert.ok(method, 'ScanPageActions must expose dedicated-page hidden readiness.');
  assert.match(method[1], /waitForPageCondition/u);
  assert.match(method[1], /loaderSelector/u);
  assert.match(method[1], /backButtonSelector/u);
  assert.match(method[1], /cancelButtonSelector/u);
  assert.match(method[1], /browseButtonSelector/u);
  assert.doesNotMatch(method[1], /await expect\(/u);
  assert.doesNotMatch(method[1], /await this\.waitForHidden/u);
});

test('incremental scan actions expose separate busy and completion boundaries', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/appBarActions.js')).href;
  const { AppBarActions } = await import(moduleUrl);
  const interactions = [];
  const refreshResponse = {
    request: () => ({ method: () => 'POST' }),
    ok: () => true,
    status: () => 200,
    url: () => 'http://127.0.0.1:4173/refresh-api',
  };
  const completedScanStatus = {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: true,
    scan_outcome: 'completed',
    last_error: null,
  };
  const actions = new AppBarActions({
    page: {
      request: {
        async get(pathname) {
          assert.equal(pathname, '/status');
          interactions.push('status-probe');
          return {
            ok: () => true,
            status: () => 200,
            async json() { return completedScanStatus; },
          };
        },
      },
      async waitForResponse(predicate) {
        assert.equal(predicate(refreshResponse), true);
        interactions.push('refresh-response-armed');
        return refreshResponse;
      },
    },
    scanIndicator: {
      async click() { interactions.push('click'); },
      async getAttribute(name) {
        assert.equal(name, 'class');
        return 'scan-indicator is-busy';
      },
    },
    scanIndicatorSelector: '#scan-indicator',
    async waitForPageCondition(predicate, options, selector) {
      interactions.push({ predicate: String(predicate), options, selector });
    },
  });

  await actions.triggerIncrementalScanAndWaitForBusy();
  assert.equal(await actions.readIncrementalScanBusyState(), true);
  await actions.waitForIncrementalScanComplete({ timeout: 12345 });

  assert.equal(interactions[0], 'refresh-response-armed');
  assert.equal(interactions[1], 'click');
  assert.match(interactions[2].predicate, /is-busy/);
  assert.deepEqual(interactions[2].options, { timeout: 10000 });
  assert.equal(interactions[3], 'status-probe');
  assert.equal(interactions[2].selector, '#scan-indicator');
});

test('rating authority E2E action observes the real view-data response without interception', async () => {
  const actionModuleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/searchToolbarActions.js'),
  ).href;
  const helperModuleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/albumRatingAuthorityHelpers.js'),
  ).href;
  const [{ SearchToolbarActions }, { readAlbumRatingAuthority }] = await Promise.all([
    import(actionModuleUrl),
    import(helperModuleUrl),
  ]);
  const interactions = [];
  const payload = {
    artist_groups: [{
      artist: 'Album Rating Contract',
      albums: [{
        name: 'Rating Numeric Authority',
        tag_album_rating: 3,
        album_preference: { rating: 8 },
        gallery_list_block: { summary: { album_preference: { rating: 8 } } },
      }],
    }],
  };
  const response = {
    request: () => ({ method: () => 'GET' }),
    ok: () => true,
    url: () => 'http://127.0.0.1:4173/view-data?q=Rating+Numeric+Authority&surface=albums',
    json: async () => payload,
  };
  const actions = new SearchToolbarActions({
    page: {
      async waitForResponse(predicate) {
        assert.equal(predicate(response), true);
        interactions.push('response-armed');
        return response;
      },
    },
    input: {
      async fill(value) { interactions.push(`fill:${value}`); },
      async press(value) { interactions.push(`press:${value}`); },
    },
  });

  const observedPayload = await actions.searchAndReadViewDataPayload(
    'Rating Numeric Authority',
    { submitWithEnter: true },
  );

  assert.deepEqual(interactions, [
    'response-armed',
    'fill:Rating Numeric Authority',
    'press:Enter',
  ]);
  assert.deepEqual(readAlbumRatingAuthority(observedPayload, 'Rating Numeric Authority'), {
    appRating: 8,
    summaryAppRating: 8,
    tagRating: 3,
  });
  assert.doesNotMatch(read('tests/e2e/specs/albumRatings.spec.js'), /page\.route\s*\(/);
});

test('base failure artifacts do not rewrite the running application timers', () => {
  const fixtures = read('tests/e2e/support/baseFixtures.js');
  assert.doesNotMatch(fixtures, /stopPageBackgroundActivity/);
  assert.doesNotMatch(fixtures, /window\.(?:setTimeout|setInterval|requestAnimationFrame)\s*=/);
  assert.doesNotMatch(fixtures, /page\.evaluate\s*\(/);
});

test('gallery POM exact-name contracts cannot confuse Neal Morse with related project names', () => {
  const albumCard = read('tests/e2e/poms/albumCard.js');
  const galleryPage = read('tests/e2e/poms/galleryPage.js');

  for (const source of [albumCard, galleryPage]) {
    assert.match(source, /function exactNormalizedText\(value\)/);
    assert.match(source, /new RegExp\(`\^\\\\s\*/);
  }
  assert.doesNotMatch(albumCard, /hasText: artistName/);
  assert.doesNotMatch(albumCard, /hasText: albumName/);
  assert.doesNotMatch(galleryPage, /hasText: artistHeading/);
});

test('Last.fm production path selects its named fixture album before opening or playing', () => {
  const spec = read('tests/e2e/specs/lastfmProductionPath.spec.js');
  const helper = read('tests/e2e/helpers/lastfmProviderHelpers.js');
  const fixture = read('tests/e2e/support/isolatedLibraryApp.py');

  assert.match(helper, /artist: 'Album Haven Last\.fm Fixture'/);
  assert.match(helper, /album: 'Signed Scrobble Journey'/);
  assert.match(helper, /track: 'Fake Loop Source'/);
  assert.match(fixture, /LASTFM_SCROBBLE_ARTIST = "Album Haven Last\.fm Fixture"/);
  assert.match(fixture, /LASTFM_SCROBBLE_ALBUM = "Signed Scrobble Journey"/);
  assert.doesNotMatch(spec, /clickFirstAlbumDetails\(/);
  assert.match(
    spec,
    /selectSidebarArtistByName\(LASTFM_PLAYBACK_TARGET\.artist\)[\s\S]*clickAlbumDetailsByArtistAndAlbum\([\s\S]*LASTFM_PLAYBACK_TARGET\.artist,[\s\S]*LASTFM_PLAYBACK_TARGET\.album,[\s\S]*readTrackAt\(0\)[\s\S]*playTrackAtAndWaitForLastfmJourney\(0/,
  );
  assert.doesNotMatch(spec, /\.locator\s*\(|\.evaluate\s*\(|page\.route\s*\(/);
});

test('consecutive Last.fm evidence observes through the stop boundary and proves completion identities', () => {
  const actions = read('tests/e2e/actions/trackModalActions.js');
  const spec = read('tests/e2e/specs/lastfmProductionPath.spec.js');

  assert.match(
    actions,
    /toHaveAttribute\('aria-label', 'Pause track'[\s\S]*followingTrackButton\.click\(\)[\s\S]*toHaveAttribute\('aria-label', 'Play track'\)[\s\S]*waitForStableExactJourneys\([\s\S]*journeyObserver\.stop\(\)/,
  );
  assert.match(
    actions,
    /page\.on\('request', onRequest\)[\s\S]*page\.on\('response', onResponse\)[\s\S]*page\.on\('requestfinished', onRequestFinished\)[\s\S]*page\.on\('requestfailed', onRequestFailed\)/,
  );
  assert.doesNotMatch(
    actions,
    /if \(await followingTrackButton\.count\(\)\)/,
  );
  assert.match(
    spec,
    /expect\(journeys\.completions\)\.toHaveLength\(LASTFM_CONSECUTIVE_PLAYBACK_TRACKS\.length\)/,
  );
  assert.match(
    spec,
    /completionStartedAt\.every\(\(startedAt\) => startedAt\.length > 0\)[\s\S]*new Set\(completionStartedAt\)\.size[\s\S]*completionStartedAt\)\.toEqual\(scrobbleStartedAt\)/,
  );
});

test('Space playback E2E requires a foreground player and POM-owned focused-control paths', () => {
  const spec = read('tests/e2e/specs/playerOverlaySpaceShortcut.spec.js');
  const globalPlayerActions = read('tests/e2e/actions/globalPlayerActions.js');
  const globalPlayer = read('tests/e2e/poms/globalPlayer.js');
  const coverLookupActions = read('tests/e2e/actions/coverLookupActions.js');
  const settingsActions = read('tests/e2e/actions/settingsModalAppBarActions.js');
  const trackModalActions = read('tests/e2e/actions/trackModalActions.js');
  const trackModal = read('tests/e2e/poms/trackModal.js');

  assert.match(
    spec,
    /waitForCurrentTrack\([\s\S]*expectVisiblePlayer\(\)[\s\S]*expectForegroundPlayerAndToggle\('albumDetails'[\s\S]*expectForegroundPlayerAndToggle\('notifications'[\s\S]*expectForegroundPlayerAndToggle\('settings'/,
  );
  assert.match(
    globalPlayerActions,
    /expectVisiblePlayer\(options = \{\}\)[\s\S]*globalPlayer\.player\)\.toBeVisible/,
  );
  assert.match(
    globalPlayerActions,
    /expectForegroundPlayerAndToggle\(surfaceName, expectedState[\s\S]*readForegroundLaneCheckpoint\(surfaceName\)[\s\S]*playButton\.click\(\{ trial: true \}\)[\s\S]*playButton\.click\(\)[\s\S]*expect\(surface\)\.toBeVisible/,
  );
  assert.match(
    globalPlayer,
    /readForegroundLaneCheckpoint\(surfaceName\)[\s\S]*player\.boundingBox\(\)[\s\S]*surface\.boundingBox\(\)[\s\S]*viewportSize\(\)/,
  );
  assert.match(
    coverLookupActions,
    /pressSpaceOnFocusedDrawerOpener\([\s\S]*openDrawer\([\s\S]*drawerButton\.focus\(\)[\s\S]*toBeFocused\(\)[\s\S]*drawerButton\.press\('Space'\)[\s\S]*waitForDrawerState\(true/,
  );
  assert.match(
    coverLookupActions,
    /pressSpaceOnFocusedDrawerClose\([\s\S]*drawerCloseButton\.focus\(\)[\s\S]*toBeFocused\(\)[\s\S]*drawerCloseButton\.press\('Space'\)[\s\S]*waitForDrawerState\(true/,
  );
  assert.match(
    settingsActions,
    /pressSpaceOnFocusedSettingsOpener\([\s\S]*openSettings\([\s\S]*settingsButton\.focus\(\)[\s\S]*toBeFocused\(\)[\s\S]*settingsButton\.press\('Space'\)[\s\S]*waitForOpen/,
  );
  assert.match(
    settingsActions,
    /pressSpaceOnFocusedSettingsClose\([\s\S]*closeButton\.focus\(\)[\s\S]*toBeFocused\(\)[\s\S]*closeButton\.press\('Space'\)[\s\S]*waitForOpen/,
  );
  assert.match(
    trackModalActions,
    /pressSpaceOnFocusedCloseControl\([\s\S]*closeButton\.focus\(\)[\s\S]*toBeFocused\(\)[\s\S]*closeButton\.press\('Space'\)[\s\S]*waitForLoadedSummary/,
  );
  assert.match(
    spec,
    /openCoverLightbox\(\)[\s\S]*expectFullCoverAbovePlayer\(\)[\s\S]*pressSpaceOnFocusedLightboxClose\([\s\S]*closeCoverLightbox\(\)/,
  );
  assert.match(
    trackModal,
    /readFullCoverLayerCheckpoint\(\)[\s\S]*getBoundingClientRect\(\)[\s\S]*elementFromPoint\(playerCenterX, playerCenterY\)[\s\S]*playerCenterCoveredByLightbox/,
  );
  assert.match(
    trackModalActions,
    /expectFullCoverAbovePlayer\(options = \{\}\)[\s\S]*readFullCoverLayerCheckpoint\(\)[\s\S]*playerCenterCoveredByLightbox\)\.toBe\(true\)/,
  );
  assert.match(
    trackModalActions,
    /pressSpaceOnFocusedLightboxClose\([\s\S]*lightboxCloseButton\.focus\(\)[\s\S]*toBeFocused\(\)[\s\S]*lightboxCloseButton\.press\('Space'\)[\s\S]*afterSpace[\s\S]*lightbox\)\.toBeVisible[\s\S]*lightboxCloseButton\)\.toBeFocused/,
  );
  assert.doesNotMatch(spec, /\.locator\s*\(|\.evaluate\s*\(|page\.keyboard|\.press\(['"]Space['"]\)/);
});

test('player artwork search-context E2E restores playback through an action-owned reload', () => {
  const spec = read('tests/e2e/specs/playerArtworkSearchContext.spec.js');
  const globalPlayerActions = read('tests/e2e/actions/globalPlayerActions.js');

  assert.match(
    spec,
    /reloadAndWaitForRestoredTrack\([\s\S]*selectSidebarArtistByName\([\s\S]*openCurrentAlbumFromCover\(\)/,
  );
  assert.match(
    globalPlayerActions,
    /waitForReloadPlaybackOutcome\(/,
  );
  assert.match(globalPlayerActions, /requireAutoplay/);
  assert.match(globalPlayerActions, /resumeIfPaused\(/);
  assert.match(globalPlayerActions, /reloadOutcome:\s*'blocked-resumed'/);
  assert.doesNotMatch(spec, /\.reload\s*\(|\bpage\./);
});

test('cover lookup and loop journeys select exact seeded albums before feature actions', () => {
  const galleryActions = read('tests/e2e/actions/galleryActions.js');
  const albumCard = read('tests/e2e/poms/albumCard.js');
  const coverLookupActions = read('tests/e2e/actions/coverLookupActions.js');
  const coverLookupFixtureData = read('tests/e2e/helpers/coverLookupFixtureData.js');
  const coverLookupProviderHelpers = read('tests/e2e/helpers/coverLookupProviderHelpers.js');
  const isolatedLibraryApp = read('tests/e2e/support/isolatedLibraryApp.py');
  const coverLookup = read('tests/e2e/specs/coverLookup.spec.js');
  const loops = read('tests/e2e/specs/loops.functional.spec.js');

  assert.match(galleryActions, /selectAlbumDetailsByIdentity\(expected/);
  assert.match(galleryActions, /albumCard\.clickDetailsByIdentity\(artist, album, year\)/);
  assert.match(albumCard, /cardByIdentity\(artistName, albumName, year, \{ visible: true \}\)/);
  assert.doesNotMatch(coverLookup, /clickFirstAlbumDetails\(/);
  assert.match(coverLookup, /COVER_LOOKUP_TEST_TARGETS/);
  assert.match(coverLookupFixtureData, /canonicalPersistence[\s\S]*artist: 'Mastodon'[\s\S]*album: 'Crack The Skye'[\s\S]*year: '2009'/);
  assert.match(coverLookupFixtureData, /notificationActioned[\s\S]*notificationFailed[\s\S]*cancelClear[\s\S]*notificationActive/);
  assert.match(
    coverLookup,
    /waitForTaskStatus\(actionedTaskTitle, 'Completed'\)[\s\S]*waitForTaskStatus\(noResultTaskTitle, 'Completed — no result'\)[\s\S]*waitForTaskStatus\(failedTaskTitle, 'Failed'\)[\s\S]*clearFinishedTasksAndPreserveActive\([\s\S]*\[actionedTaskTitle, noResultTaskTitle, failedTaskTitle\],[\s\S]*activeTaskTitle[\s\S]*reloadAndOpenDrawer\(\)[\s\S]*waitForTaskActive\(activeTaskTitle\)[\s\S]*expectTaskHiddenImmediately\(actionedTaskTitle\)[\s\S]*expectTaskHiddenImmediately\(noResultTaskTitle\)[\s\S]*expectTaskHiddenImmediately\(failedTaskTitle\)/,
  );
  assert.match(
    coverLookupActions,
    /clearFinishedTasksAndPreserveActive\(finishedTaskTitles, activeTaskTitle[\s\S]*clear-completed[\s\S]*for \(const taskTitle of finishedTaskTitles\)[\s\S]*expectTaskHiddenImmediately\(taskTitle\)[\s\S]*taskCardByTitle\(activeTaskTitle\)[\s\S]*waitForTaskActive\(activeTaskTitle/,
  );
  assert.match(
    coverLookup,
    /FTC-COVERS-013[\s\S]*holdLaterProviderFixture\(\)[\s\S]*waitForLaterProviderFixtureBlocked\(\)[\s\S]*waitForPartialRemoteCandidates\(\)[\s\S]*waitForTaskActive\(taskTitle\)[\s\S]*selectFirstRemoteCoverAndSave\(\{[\s\S]*?stableCoverLocator:\s*trackModalActions\.trackModal\.detailedCoverImage,[\s\S]*?\}\)[\s\S]*waitForTaskStatus\(taskTitle, 'Art chosen'[\s\S]*releaseLaterProviderFixture\(\)[\s\S]*reloadAndOpenDrawer\(\)/,
  );
  assert.match(coverLookup, /selectedRemoteCover = selection\.candidate[\s\S]*selectedCoverPath = String\(selection\.payload\?\.optimistic_cover_path[\s\S]*modal\.activeLocalCover\.coverPath[\s\S]*selectedCoverPath/);
  assert.match(
    coverLookup,
    /selectedRemoteCandidateId = selection\.candidateId[\s\S]*readRemoteCandidateEvidence\([\s\S]*selectedRemoteCandidateId[\s\S]*persistedSelectedRemoteCover\.sha256[\s\S]*selectedRemoteCover\.sha256/,
  );
  assert.doesNotMatch(coverLookup, /modal\.firstRemoteMatch\.sha256/);
  assert.match(coverLookupActions, /readRemoteCandidateEvidence\(candidateId/);
  assert.match(coverLookupActions, /readCoverLookupProviderEvidence[\s\S]*isCoverLookupCancellationSettledBeforeArchiveWork/);
  assert.match(coverLookupProviderHelpers, /musicbrainzStarted <= 2[\s\S]*cover_art_archive_requests === 0/);
  assert.match(coverLookupProviderHelpers, /Refusing to control a non-loopback cover provider fixture/);
  assert.match(
    coverLookup,
    /FTC-COVERS-022[\s\S]*holdCandidateImageFixture\(\)[\s\S]*openCoverLookupAndReadRequestOrder\(\)[\s\S]*waitForCandidateImageFixtureBlocked\(\)[\s\S]*closeModal\(\)[\s\S]*openCoverLookupAndReadRequestOrder\(\)[\s\S]*candidate_image_released\)\.toBe\(false\)[\s\S]*releaseCandidateImageFixture\(\)[\s\S]*readRemoteCandidateEvidence\(appleCandidate\.id\)/,
  );
  assert.match(
    coverLookupActions,
    /holdCandidateImageFixture\(\)[\s\S]*'hold-candidate-images'[\s\S]*waitForCandidateImageFixtureBlocked\(options[\s\S]*candidate_image_requests[\s\S]*candidate_image_released/,
  );
  assert.match(
    coverLookupProviderHelpers,
    /export async function setCoverLookupCandidateImageGate[\s\S]*method: 'POST'[\s\S]*JSON\.stringify\(\{ action \}\)/,
  );
  assert.match(isolatedLibraryApp, /cover_lookup_later_provider_gate\.wait\(\)/);
  assert.match(isolatedLibraryApp, /cover_lookup_candidate_image_gate\.wait\(\)/);
  assert.match(isolatedLibraryApp, /release_cover_lookup_later_provider\(\)[\s\S]*self\._server\.shutdown\(\)/);
  assert.doesNotMatch(loops, /clickFirstAlbumDetails\(/);
  assert.match(loops, /album: 'Signed Scrobble Journey'/);
  assert.match(loops, /expect\(selectedTrack\.title\)\.toBe\(LOOP_TRACK_TITLE\)/);
  assert.match(
    loops,
    /waitForCurrentTrack\([\s\S]*waitForPlaybackState\([\s\S]*readCurrentPlaybackSummary\([\s\S]*trackModalActions\.close\(\)/,
  );
});

test('FTC-COVERS-007 alert-placement scenario cleans its completed lookup state', () => {
  const spec = read('tests/e2e/specs/coverLookup.spec.js');
  const scenarioTitle = 'FTC-COVERS-007 lookup-start alert does not reposition the cover modal';
  const scenarioMarker = `test('${scenarioTitle}',`;
  const nextScenarioMarker = "test('FTC-COVERS-007 notification states and bulk clear preserve active work',";
  const scenarioStart = spec.indexOf(scenarioMarker);
  assert.ok(scenarioStart >= 0, `Expected exact scenario title: ${scenarioTitle}`);
  assert.equal(
    spec.indexOf(scenarioMarker, scenarioStart + scenarioMarker.length),
    -1,
    `Expected one exact scenario title: ${scenarioTitle}`,
  );
  const scenarioEnd = spec.indexOf(nextScenarioMarker, scenarioStart + scenarioMarker.length);
  assert.ok(
    scenarioEnd > scenarioStart,
    'Expected the notification-state scenario to bound the alert-placement scenario.',
  );
  const scenario = spec.slice(scenarioStart, scenarioEnd);

  assert.match(
    scenario,
    /let taskTitle = '';[\s\S]*taskTitle = await coverLookupActions\.readModalSubtitle\(\);[\s\S]*expect\(taskTitle\)\.not\.toEqual\(''\);[\s\S]*startSearchAndReadToastPlacement\(\)[\s\S]*waitForTaskStatus\(taskTitle, 'Completed'\)[\s\S]*clearTaskAndExpectImmediateRemoval\(taskTitle\)[\s\S]*waitForDrawerEmpty\(\)[\s\S]*setProviderFixtureMode\('normal'\)/u,
  );
});

test('FTC-COVERS-017 keeps primary and other-art provider evidence independent after completion and reload', () => {
  const spec = read('tests/e2e/specs/coverLookup.spec.js');
  const scenarioTitle = 'FTC-COVERS-017 manual lookup progressively retains provider alternatives';
  const scenarioMarker = `test('${scenarioTitle}',`;
  const nextScenarioMarker = "test('FTC-COVERS-020 provider deadline keeps candidates found by earlier services',";
  const scenarioStart = spec.indexOf(scenarioMarker);
  assert.ok(scenarioStart >= 0, `Expected exact scenario title: ${scenarioTitle}`);
  assert.equal(
    spec.indexOf(scenarioMarker, scenarioStart + scenarioMarker.length),
    -1,
    `Expected one exact scenario title: ${scenarioTitle}`,
  );
  const scenarioEnd = spec.indexOf(nextScenarioMarker, scenarioStart + scenarioMarker.length);
  assert.ok(
    scenarioEnd > scenarioStart,
    'Expected FTC-COVERS-020 to bound the progressive-provider scenario.',
  );
  const scenario = spec.slice(scenarioStart, scenarioEnd);

  for (const providerGroup of ['discogsGroup', 'archiveGroup']) {
    assert.match(
      scenario,
      new RegExp(`expect\\(${providerGroup}\\.cards\\)\\.toBeGreaterThanOrEqual\\(1\\)`),
    );
    assert.match(
      scenario,
      new RegExp(`expect\\(${providerGroup}\\.otherArtCards\\)\\.toBeGreaterThanOrEqual\\(1\\)`),
    );
  }
  for (const providerGroup of ['restoredDiscogsGroup', 'restoredArchiveGroup']) {
    assert.match(
      scenario,
      new RegExp(`expect\\(${providerGroup}\\.cards\\)\\.toBeGreaterThanOrEqual\\(1\\)`),
    );
    assert.match(
      scenario,
      new RegExp(`expect\\(${providerGroup}\\.otherArtCards\\)\\.toBeGreaterThanOrEqual\\(1\\)`),
    );
  }
});

test('FTC-COVERS-017 reads each remote candidate set from one atomic browser snapshot', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/coverLookupActions.js'),
  ).href;
  const { CoverLookupActions } = await import(moduleUrl);
  const selectors = {
    image: '.cover-lookup-art-preview-image',
    name: '.cover-lookup-art-name',
    resolution: '.cover-lookup-art-resolution',
    source: '.cover-lookup-art-source',
  };
  const card = ({ id, imageSrc, name, resolution, selected, source }) => {
    const descendants = new Map([
      [selectors.image, { getAttribute: (attribute) => (attribute === 'src' ? imageSrc : null) }],
      [selectors.name, { textContent: name }],
      [selectors.resolution, { textContent: resolution }],
      [selectors.source, { textContent: source }],
    ]);
    return {
      classList: { contains: (className) => className === 'is-active' && selected },
      getAttribute: (attribute) => (attribute === 'data-select-remote-cover' ? id : null),
      querySelector: (selector) => descendants.get(selector) || null,
    };
  };
  const snapshot = [
    card({
      id: 'manual:https://covers.example/selected.jpg',
      imageSrc: 'https://covers.example/selected.jpg',
      name: 'Selected manual cover',
      resolution: '2937x6819',
      selected: true,
      source: 'Manual URL',
    }),
    card({
      id: 'coverartarchive:release-017:booklet',
      imageSrc: 'https://covers.example/booklet.jpg',
      name: 'Booklet',
      resolution: '1200x1200',
      selected: false,
      source: 'Cover Art Archive',
    }),
  ];
  let evaluateAllCalls = 0;
  const page = new EventEmitter();
  page.url = () => 'http://127.0.0.1:4173/';
  const actions = new CoverLookupActions({
    page,
    remoteCoverCards: {
      async count() {
        assert.fail('readRemoteCandidateSummaries must not split one snapshot across count() and nth() calls');
      },
      async evaluateAll(pageFunction, argument) {
        evaluateAllCalls += 1;
        return pageFunction(snapshot, argument);
      },
      nth() {
        assert.fail('readRemoteCandidateSummaries must not read cards through sequential nth() calls');
      },
    },
    remoteCoverImageWithinCardSelector: selectors.image,
    remoteCoverNameWithinCardSelector: selectors.name,
    remoteCoverResolutionWithinCardSelector: selectors.resolution,
    remoteCoverSourceWithinCardSelector: selectors.source,
  });

  assert.deepEqual(await actions.readRemoteCandidateSummaries(), [
    {
      id: 'manual:https://covers.example/selected.jpg',
      imageSrc: 'https://covers.example/selected.jpg',
      name: 'Selected manual cover',
      resolution: '2937x6819',
      selected: true,
      source: 'Manual URL',
    },
    {
      id: 'coverartarchive:release-017:booklet',
      imageSrc: 'https://covers.example/booklet.jpg',
      name: 'Booklet',
      resolution: '1200x1200',
      selected: false,
      source: 'Cover Art Archive',
    },
  ]);
  assert.equal(evaluateAllCalls, 1, 'The action must capture one browser-side candidate snapshot.');
});

test('cover lookup provider gate cleanup stays fixture-owned after a failed scenario', async () => {
  const coverLookupActions = read('tests/e2e/actions/coverLookupActions.js');
  const baseFixtures = read('tests/e2e/support/baseFixtures.js');
  const resetProviderFixture = coverLookupActions.match(
    /async resetProviderFixture\(\) \{([\s\S]*?)\n  \}\n\n  async setProviderFixtureMode/u,
  );

  assert.ok(resetProviderFixture, 'CoverLookupActions must retain a bounded provider-reset action.');
  assert.match(
    coverLookupActions,
    /laterProviderFixtureHeld = false[\s\S]*candidateImageFixtureHeld = false[\s\S]*providerFixtureMode = 'no-results'[\s\S]*holdLaterProviderFixture\(\)[\s\S]*laterProviderFixtureHeld = true[\s\S]*releaseLaterProviderFixture\(\)[\s\S]*if \(this\.candidateImageFixtureHeld\)[\s\S]*releaseCandidateImageFixture\(\)[\s\S]*if \(this\.laterProviderFixtureHeld\)[\s\S]*'release-later-provider'[\s\S]*laterProviderFixtureHeld = false/,
  );
  assert.match(
    resetProviderFixture[1],
    /setCoverLookupProviderMode\(this\.coverLookup\.testInfo, 'no-results'\)[\s\S]*providerFixtureMode = 'no-results'[\s\S]*setCoverLookupProviderLatency\(this\.coverLookup\.testInfo, 0\)[\s\S]*providerFixtureLatencySeconds = 0/u,
  );
  assert.doesNotMatch(
    resetProviderFixture[1],
    /if \(this\.(?:providerFixtureMode|providerFixtureLatencySeconds)/u,
  );
  assert.match(
    baseFixtures,
    /coverLookupActions: async[\s\S]*try \{[\s\S]*await use\(actions\)[\s\S]*finally \{[\s\S]*const cleanupErrors = \[\][\s\S]*try \{[\s\S]*releaseLaterProviderFixture\(\)[\s\S]*catch \(error\) \{[\s\S]*cleanupErrors\.push\(\{ stage: 'release', error \}\)[\s\S]*try \{[\s\S]*resetProviderFixture\(\)[\s\S]*catch \(error\) \{[\s\S]*cleanupErrors\.push\(\{ stage: 'reset', error \}\)[\s\S]*cleanupErrors\.length[\s\S]*if \(!didTestFail\(testInfo\)\)[\s\S]*testInfo\.attach/,
  );

  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/coverLookupActions.js'),
  ).href;
  const { CoverLookupActions } = await import(moduleUrl);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options?.body || '{}')));
    return {
      ok: true,
      status: 200,
      async json() { return {}; },
    };
  };

  const page = new EventEmitter();
  page.url = () => 'http://127.0.0.1:4173/';
  const actions = new CoverLookupActions({
    page,
    testInfo: {
      config: {
        metadata: { providerBaseURL: 'http://127.0.0.1:4175' },
      },
    },
  });

  try {
    assert.equal(actions.providerFixtureMode, 'no-results');
    assert.equal(actions.providerFixtureLatencySeconds, 0);
    await actions.resetProviderFixture();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { action: 'set-mode', mode: 'no-results' },
    { action: 'set-itunes-search-delay', delay_seconds: 0 },
  ]);
});

test('releasing a later provider keeps normal mode until terminal fixture cleanup resets it', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/coverLookupActions.js'),
  ).href;
  const { CoverLookupActions } = await import(moduleUrl);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({
      url: String(url),
      method: options?.method,
      body: JSON.parse(String(options?.body || '{}')),
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return { mode: requests.at(-1).body.mode };
      },
    };
  };

  const page = new EventEmitter();
  page.url = () => 'http://127.0.0.1:4173/';
  const actions = new CoverLookupActions({
    page,
    testInfo: {
      config: {
        metadata: { providerBaseURL: 'http://127.0.0.1:4175' },
      },
    },
  });

  try {
    assert.equal(actions.providerFixtureMode, 'no-results');
    await actions.setProviderFixtureMode('normal');
    actions.laterProviderFixtureHeld = true;
    await actions.releaseLaterProviderFixture();
    assert.equal(
      actions.providerFixtureMode,
      'normal',
      'Releasing the gate must not erase candidates from the request that was waiting behind it.',
    );
    await actions.resetProviderFixture();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map(({ body }) => body), [
    { action: 'set-mode', mode: 'normal' },
    { action: 'release-later-provider' },
    { action: 'set-mode', mode: 'no-results' },
    { action: 'set-itunes-search-delay', delay_seconds: 0 },
  ]);
});

test('manual all-provider scenarios explicitly opt into normal provider results', () => {
  const spec = read('tests/e2e/specs/coverLookup.spec.js');
  const scenarios = [
    {
      title: 'FTC-COVERS-007 notification states and bulk clear preserve active work',
      searchMarker: 'startSearchAndReadToastPlacement()',
    },
    {
      title: 'FTC-COVERS-013 partial cover results survive drawer reopen, save cancellation, and reload',
      searchMarker: 'holdLaterProviderFixture()',
    },
    {
      title: 'FTC-COVERS-017 manual lookup progressively retains provider alternatives',
      searchMarker: 'enterManualUrls(',
    },
    {
      title: 'FTC-COVERS-019 manual lookup leaves the user-owned cover unchanged before Save',
      searchMarker: 'startSearch()',
    },
  ];

  const missingOptIns = [];
  for (const { title, searchMarker } of scenarios) {
    const scenarioStart = spec.indexOf(`test('${title}',`);
    assert.ok(scenarioStart >= 0, `Expected exact scenario title: ${title}`);
    const scenarioEnd = spec.indexOf("\ntest('", scenarioStart + 1);
    const scenario = spec.slice(scenarioStart, scenarioEnd < 0 ? undefined : scenarioEnd);
    const optIn = scenario.indexOf("setProviderFixtureMode('normal')");
    const search = scenario.indexOf(searchMarker);
    assert.ok(search >= 0, `Expected ${title} to contain ${searchMarker}`);
    if (optIn < 0 || optIn >= search) missingOptIns.push(title);
  }
  assert.deepEqual(
    missingOptIns,
    [],
    'Every manual all-provider scenario must opt into normal results before searching.',
  );
});

test('automatic cover scans isolate the coverless candidate without weakening later improvement coverage', () => {
  const spec = read('tests/e2e/specs/coverLookup.spec.js');
  const coverlessTitle = 'FTC-COVERS-018 automatic lookup applies the first acceptable cover and stops later providers';
  const improvementTitle = 'FTC-COVERS-019 automatic improvement preserves a user-owned cover and clears after gallery open';

  const readScenario = (title) => {
    const marker = `test('${title}',`;
    const start = spec.indexOf(marker);
    assert.ok(start >= 0, `Expected exact scenario title: ${title}`);
    assert.equal(
      spec.indexOf(marker, start + marker.length),
      -1,
      `Expected one exact scenario title: ${title}`,
    );
    const end = spec.indexOf("\ntest('", start + marker.length);
    return spec.slice(start, end < 0 ? undefined : end);
  };

  const coverlessScenario = readScenario(coverlessTitle);
  const coverlessMode = coverlessScenario.indexOf(
    "setProviderFixtureMode('automatic-coverless')",
  );
  const coverlessScan = coverlessScenario.indexOf('triggerIncrementalScanAndWaitForBusy()');
  assert.ok(coverlessMode >= 0, 'FTC-COVERS-018 must opt into the Fixture08-only provider mode.');
  assert.ok(
    coverlessMode < coverlessScan,
    'FTC-COVERS-018 must isolate provider results before its automatic scan starts.',
  );
  assert.doesNotMatch(coverlessScenario, /setProviderFixtureMode\('automatic-scan'\)/u);

  const improvementScenario = readScenario(improvementTitle);
  const differentArtStep = improvementScenario.indexOf(
    "stepLogger.step('Keep different automatic artwork suggestion-only and show its indicator'",
  );
  assert.ok(differentArtStep >= 0, 'Expected the bounded different-art improvement step.');
  const differentArtScenario = improvementScenario.slice(differentArtStep);
  const improvementMode = differentArtScenario.indexOf(
    "setProviderFixtureMode('automatic-scan')",
  );
  const improvementScan = differentArtScenario.indexOf('triggerIncrementalScanAndWait()');
  assert.ok(
    improvementMode >= 0 && improvementMode < improvementScan,
    'FTC-COVERS-019 must retain automatic-scan for its later Fixture09 different-art phase.',
  );
});

test('FTC-COVERS-018 proves the neutral Fixture 09 candidate cannot mutate its user cover', () => {
  const spec = read('tests/e2e/specs/coverLookup.spec.js');
  const coverLookupActions = read('tests/e2e/actions/coverLookupActions.js');
  const title = 'FTC-COVERS-018 automatic lookup applies the first acceptable cover and stops later providers';
  const scenarioStart = spec.indexOf(`test('${title}',`);
  assert.ok(scenarioStart >= 0, `Expected exact scenario title: ${title}`);
  const scenarioEnd = spec.indexOf("\ntest('", scenarioStart + title.length);
  const scenario = spec.slice(scenarioStart, scenarioEnd < 0 ? undefined : scenarioEnd);
  const scanBoundary = scenario.indexOf('triggerIncrementalScanAndWaitForBusy()');
  assert.ok(scanBoundary >= 0, 'FTC-COVERS-018 must retain the real incremental-scan boundary.');

  const beforeScan = scenario.slice(0, scanBoundary);
  assert.match(
    beforeScan,
    /selectAlbumDetailsByIdentityAndReadPayload\(\s*USER_OWNED_IMPROVEMENT_TARGET,?\s*\)/u,
  );
  assert.match(beforeScan, /neutralBaselineAlbum\s*=\s*opened\.album/u);
  assert.match(beforeScan, /expect\(neutralBaselineAlbum\.cover_selection_origin\)\.toBe\('user'\)/u);
  assert.match(beforeScan, /expect\(neutralBaselineAlbum\.local_cover_width\)\.toBe\(640\)/u);
  assert.match(beforeScan, /expect\(neutralBaselineAlbum\.local_cover_height\)\.toBe\(640\)/u);
  assert.match(
    beforeScan,
    /expect\(USER_COVER_LINKED_FIELDS\.every\(\(field\) => neutralBaselineAlbum\[field\] !== null\)\)\.toBe\(true\)/u,
  );
  assert.match(
    beforeScan,
    /neutralBaselineFullSizeCover\s*=\s*await coverLookupActions\.readFullSizeCoverEvidence\(\{[\s\S]*?coverPath:\s*neutralBaselineAlbum\.cover_path,[\s\S]*?coverRevision:\s*neutralBaselineAlbum\.cover_revision,[\s\S]*?\}\)/u,
  );
  assert.match(beforeScan, /trackModalActions\.waitForCoverLookupImprovementIndicator\(false\)/u);

  const afterScan = scenario.slice(scanBoundary);
  assert.match(
    afterScan,
    /waitForAutomaticProviderSearch\(\s*USER_OWNED_IMPROVEMENT_TARGET,?\s*\)/u,
  );
  assert.match(
    afterScan,
    /selectAlbumDetailsByIdentityAndReadPayload\(\s*USER_OWNED_IMPROVEMENT_TARGET,?\s*\)/u,
  );
  assert.match(afterScan, /neutralPreservedAlbum\s*=\s*opened\.album/u);
  assert.match(
    afterScan,
    /expect\(neutralPreservedAlbum\.cover_selection_origin\)\.toBe\(neutralBaselineAlbum\.cover_selection_origin\)/u,
  );
  assert.match(
    afterScan,
    /expect\(neutralPreservedAlbum\.cover_path\)\.toBe\(neutralBaselineAlbum\.cover_path\)/u,
  );
  assert.match(
    afterScan,
    /expect\(neutralPreservedAlbum\.cover_revision\)\.toBe\(neutralBaselineAlbum\.cover_revision\)/u,
  );
  assert.match(
    afterScan,
    /for \(const field of USER_COVER_LINKED_FIELDS\) \{\s*expect\(neutralPreservedAlbum\[field\]\)\.toBe\(neutralBaselineAlbum\[field\]\);\s*\}/u,
  );
  assert.match(afterScan, /trackModalActions\.waitForCoverLookupImprovementIndicator\(false\)/u);
  assert.match(
    afterScan,
    /neutralCandidate\s*=\s*candidates\.find\([\s\S]*?automatic-coverless-neutral[\s\S]*?\)/u,
  );
  assert.match(afterScan, /expect\(neutralCandidate\.resolution\)\.toBe\('600x600'\)/u);
  assert.match(afterScan, /expect\(neutralCandidate\.selected\)\.toBe\(false\)/u);
  assert.match(
    afterScan,
    /neutralCandidateEvidence\s*=\s*await coverLookupActions\.readRemoteCandidateEvidence\(neutralCandidate\.id\)/u,
  );
  assert.match(afterScan, /expect\(neutralCandidateEvidence\.naturalWidth\)\.toBe\(600\)/u);
  assert.match(afterScan, /expect\(neutralCandidateEvidence\.naturalHeight\)\.toBe\(600\)/u);
  assert.match(afterScan, /expect\(neutralCandidateEvidence\.src\)\.toContain\('automatic-coverless-neutral'\)/u);
  assert.match(
    coverLookupActions,
    /naturalHeight:\s*element instanceof HTMLImageElement \? element\.naturalHeight : 0/u,
    'Displayed-image evidence must capture the browser-decoded natural height.',
  );
  assert.match(
    coverLookupActions,
    /naturalHeight:\s*displayedState\.naturalHeight/u,
    'Displayed-image evidence must return the browser-decoded natural height.',
  );
  assert.match(
    afterScan,
    /expect\(providerEvidence\.fixture_neutral_original_source_sha256\)\.toBe\(\s*neutralBaselineFullSizeCover\.sha256\.toLowerCase\(\),?\s*\)/u,
  );
  assert.match(
    afterScan,
    /expect\(evidenceAfterOpen\)\.toEqual\(evidenceBeforeOpen\)/u,
    'Opening the persisted neutral result must not issue another provider search.',
  );
});

test('FTC-COVERS-019 captures the user-cover baseline before its first automatic scan', () => {
  const spec = read('tests/e2e/specs/coverLookup.spec.js');
  const title = 'FTC-COVERS-019 automatic improvement preserves a user-owned cover and clears after gallery open';
  const scenarioStart = spec.indexOf(`test('${title}',`);
  assert.ok(scenarioStart >= 0, `Expected exact scenario title: ${title}`);
  const scenarioEnd = spec.indexOf("\ntest('", scenarioStart + 1);
  const scenario = spec.slice(scenarioStart, scenarioEnd < 0 ? undefined : scenarioEnd);
  const firstScan = scenario.indexOf('triggerIncrementalScanAndWait()');
  assert.ok(firstScan >= 0, 'Expected FTC-COVERS-019 to run an automatic scan.');
  const baseline = scenario.slice(0, firstScan);

  assert.match(baseline, /expect\(baselineAlbum\.cover_selection_origin\)\.toBe\('user'\)/u);
  assert.match(baseline, /expect\(baselineAlbum\.local_cover_width\)\.toBe\(640\)/u);
  assert.match(baseline, /expect\(baselineAlbum\.local_cover_height\)\.toBe\(640\)/u);
  assert.match(
    baseline,
    /expect\(USER_COVER_LINKED_FIELDS\.every\(\(field\) => baselineAlbum\[field\] !== null\)\)\.toBe\(true\)/u,
  );
  assert.match(
    baseline,
    /trackModalActions\.waitForCoverLookupImprovementIndicator\(false\)/u,
  );
});

test('cover lookup cancellation evidence accepts one pre-cancel retry but rejects archive work or a third request', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/coverLookupProviderHelpers.js'),
  ).href;
  const { isCoverLookupCancellationSettledBeforeArchiveWork } = await import(moduleUrl);
  const evidence = {
    musicbrainz_started: 1,
    musicbrainz_completed: 0,
    cover_art_archive_requests: 0,
    later_provider_released: true,
  };

  assert.equal(isCoverLookupCancellationSettledBeforeArchiveWork(evidence), true);
  assert.equal(isCoverLookupCancellationSettledBeforeArchiveWork({
    ...evidence,
    musicbrainz_started: 2,
    musicbrainz_completed: 0,
  }), true);
  assert.equal(isCoverLookupCancellationSettledBeforeArchiveWork({
    ...evidence,
    musicbrainz_started: 2,
    musicbrainz_completed: 2,
  }), true);
  assert.equal(isCoverLookupCancellationSettledBeforeArchiveWork({
    ...evidence,
    musicbrainz_started: 3,
  }), false);
  assert.equal(isCoverLookupCancellationSettledBeforeArchiveWork({
    ...evidence,
    cover_art_archive_requests: 1,
  }), false);
});

test('cover lookup action explicitly sets and resets fixture Apple search latency', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/coverLookupActions.js'),
  ).href;
  const { CoverLookupActions } = await import(moduleUrl);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({
      url: String(url),
      method: options?.method,
      body: JSON.parse(String(options?.body || '{}')),
    });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          itunes_search_delay_seconds: requests.at(-1).body.delay_seconds,
        };
      },
    };
  };

  const page = new EventEmitter();
  page.url = () => 'http://127.0.0.1:4173/';
  const actions = new CoverLookupActions({
    page,
    testInfo: {
      config: {
        metadata: { providerBaseURL: 'http://127.0.0.1:4175' },
      },
    },
  });

  try {
    await actions.setProviderFixtureLatency(0.1);
    await actions.resetProviderFixture();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    {
      url: 'http://127.0.0.1:4175/cover-lookup-fixture/control',
      method: 'POST',
      body: { action: 'set-itunes-search-delay', delay_seconds: 0.1 },
    },
    {
      url: 'http://127.0.0.1:4175/cover-lookup-fixture/control',
      method: 'POST',
      body: { action: 'set-mode', mode: 'no-results' },
    },
    {
      url: 'http://127.0.0.1:4175/cover-lookup-fixture/control',
      method: 'POST',
      body: { action: 'set-itunes-search-delay', delay_seconds: 0 },
    },
  ]);
});

test('shared fixtures guard request interception without blocking passive observation', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/support/requestInterceptionGuard.js'),
  ).href;
  const { BLOCKED_INTERCEPTION_METHODS, installRequestInterceptionGuard } = await import(moduleUrl);
  const observations = [];
  const target = {
    on(eventName) { observations.push(eventName); },
  };
  for (const methodName of BLOCKED_INTERCEPTION_METHODS) {
    target[methodName] = (...args) => `original:${methodName}:${args.join(',')}`;
  }
  const restore = installRequestInterceptionGuard(target, 'page');
  const dynamicMethod = 'route';
  const { route: destructuredRoute } = target;

  assert.throws(() => target[dynamicMethod]('**/*', () => {}), /production-parity violation/);
  assert.throws(() => destructuredRoute('**/*', () => {}), /production-parity violation/);
  for (const methodName of BLOCKED_INTERCEPTION_METHODS) {
    assert.throws(
      () => target[methodName]('argument'),
      new RegExp(`production-parity violation: page\\.${methodName}`),
    );
  }
  target.on('request');
  target.on('response');
  assert.deepEqual(observations, ['request', 'response']);

  restore();
  for (const methodName of BLOCKED_INTERCEPTION_METHODS) {
    assert.equal(target[methodName]('argument'), `original:${methodName}:argument`);
  }
});

test('context guard covers existing pages and future popups, then restores every patch', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/support/requestInterceptionGuard.js'),
  ).href;
  const { installContextRequestInterceptionGuard } = await import(moduleUrl);
  const createPage = () => ({
    route() { return 'original-page-route'; },
    routeFromHAR() { return 'original-page-har'; },
  });
  const existingPage = createPage();
  const popup = createPage();
  const context = new EventEmitter();
  context.pages = () => [existingPage];
  context.route = () => 'original-context-route';
  context.routeFromHAR = () => 'original-context-har';
  const observedPopups = [];
  let popupWasGuardedBeforeExistingListener = false;
  context.on('page', (page) => {
    observedPopups.push(page);
    assert.throws(
      () => page.route('/listener-api', () => {}),
      /production-parity violation/,
    );
    popupWasGuardedBeforeExistingListener = true;
  });

  const listenerCountBeforeGuard = context.listenerCount('page');
  const restore = installContextRequestInterceptionGuard(context);
  assert.throws(() => existingPage.route('/api', () => {}), /production-parity violation/);
  assert.throws(() => context.route('/api', () => {}), /production-parity violation/);

  context.emit('page', popup);
  assert.deepEqual(observedPopups, [popup], 'popup observation must remain available to tests');
  assert.equal(popupWasGuardedBeforeExistingListener, true);
  assert.throws(() => popup.route('/api', () => {}), /production-parity violation/);

  restore();
  restore();
  assert.equal(context.listenerCount('page'), listenerCountBeforeGuard);
  assert.equal(existingPage.route(), 'original-page-route');
  assert.equal(popup.route(), 'original-page-route');
  assert.equal(context.route(), 'original-context-route');
});

test('all E2E specs inherit guarded fixtures and cannot create direct browser pages', () => {
  const e2eRoot = path.join(repoRoot, 'tests/e2e');
  const sources = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith('.js')) sources.push([entryPath, fs.readFileSync(entryPath, 'utf8')]);
    }
  };
  visit(e2eRoot);

  const directBrowserCreation = /\bbrowser\.newPage\s*\(|\bcontext\.newPage\s*\(|\.newContext\s*\(/;
  const baseFixturesPath = path.join(e2eRoot, 'support', 'baseFixtures.js');
  for (const [filePath, source] of sources) {
    assert.doesNotMatch(source, /\b(?:chromium|firefox|webkit)\.launch\s*\(/, filePath);
    if (filePath === baseFixturesPath) {
      const fixtureStart = source.indexOf('  freshBrowserSession: async');
      const fixtureEnd = source.indexOf('\n  startupRelationProjectionReadiness:', fixtureStart);
      assert.notEqual(fixtureStart, -1, 'freshBrowserSession fixture must remain explicitly named');
      assert.notEqual(fixtureEnd, -1, 'freshBrowserSession fixture must remain independently bounded');
      const freshBrowserSessionFixture = source.slice(fixtureStart, fixtureEnd);
      assert.match(
        freshBrowserSessionFixture,
        /freshBrowserSession: async \(\{ browser, testArtifacts \}, use, testInfo\)[\s\S]*browser\.newContext\([\s\S]*installContextRequestInterceptionGuard\(context\)[\s\S]*context\.newPage\(\)[\s\S]*new GalleryActions\(new GalleryPage\(page, testInfo\)\)[\s\S]*new CoverLookupActions\(new CoverLookup\(page, testInfo\)\)[\s\S]*new TrackModalActions\(new TrackModal\(page, testInfo\)\)[\s\S]*restoreInterceptionGuard\(\)[\s\S]*context\.close\(\)[\s\S]*session\.restoreInterceptionGuard\(\)[\s\S]*session\.context\.close\(\)/,
      );
      assert.equal(
        (freshBrowserSessionFixture.match(/\.newContext\s*\(/g) || []).length,
        1,
        'freshBrowserSession owns exactly one context creation',
      );
      assert.equal(
        (freshBrowserSessionFixture.match(/\bcontext\.newPage\s*\(/g) || []).length,
        1,
        'freshBrowserSession owns exactly one page creation',
      );
      const sourceOutsideFreshBrowserSession = source.slice(0, fixtureStart) + source.slice(fixtureEnd);
      assert.doesNotMatch(sourceOutsideFreshBrowserSession, directBrowserCreation, filePath);
    } else {
      assert.doesNotMatch(source, directBrowserCreation, filePath);
    }
    if (!filePath.endsWith('.spec.js')) continue;
    assert.match(source, /from ['"]\.\.\/support\/(?:base|performance)Fixtures\.js['"]/, filePath);
    assert.doesNotMatch(source, /from ['"]@playwright\/test['"]/, filePath);
  }

  const baseFixtures = read('tests/e2e/support/baseFixtures.js');
  const coverLookupSpec = read('tests/e2e/specs/coverLookup.spec.js');
  assert.match(
    coverLookupSpec,
    /FTC-COVERS-011 selected local art remains authoritative after rescan and app restart[\s\S]*freshBrowserSession[\s\S]*managedAppLifecycle\.restart\(\)[\s\S]*freshBrowserSession\.create\(\)/,
  );
  const performanceFixtures = read('tests/e2e/support/performanceFixtures.js');
  assert.match(baseFixtures, /requestInterceptionGuard:[\s\S]*?\{ auto: true \}/);
  assert.match(performanceFixtures, /test as base[\s\S]*?base\.extend\s*\(/);
  assert.match(performanceFixtures, /GRACE USED — above 1000 ms target; within 1200 ms hard ceiling/);
  assert.match(performanceFixtures, /TARGET MET — at or below 1000 ms; 1200 ms hard ceiling/);
  const focusedProblematicSpec = read('tests/e2e/utilityProblematicFiles/utilityProblematicFiles.spec.js');
  const timingBudgetHelper = read('tests/e2e/helpers/timingBudget.js');
  assert.match(focusedProblematicSpec, /problematic-files-focused-readiness-contract/);
  assert.match(focusedProblematicSpec, /evaluateTimingBudget\(/);
  assert.match(focusedProblematicSpec, /expectTimingBudgetOutcome\(/);
  assert.match(focusedProblematicSpec, /formatTimingBudgetOutcome\(/);
  assert.match(timingBudgetHelper, /GRACE USED:/);
  assert.match(timingBudgetHelper, /TARGET MET:/);
  assert.match(timingBudgetHelper, /HARD FAIL:/);
});

test('gallery cover readiness requires decoded images or explicit final placeholders', () => {
  const gallery = read('tests/e2e/actions/galleryActions.js');

  assert.match(gallery, /coverImage\.complete\s*&&\s*coverImage\.naturalWidth\s*>\s*0/);
  assert.match(gallery, /url\.origin\s*===\s*window\.location\.origin/);
  assert.match(gallery, /url\.pathname\s*===\s*'\/cover'/);
  assert.match(gallery, /options\.allowPlaceholder\s*===\s*true/);
  assert.match(gallery, /allowPlaceholder requires a named placeholderScenario/);
  assert.match(gallery, /cover-placeholder-deferred/);
  assert.doesNotMatch(gallery, /allowPendingRemoteFallback/);
  assert.doesNotMatch(gallery, /remoteCoverTried/);
});

test('gallery readiness uses hydration state instead of a fixed virtualized-card count', () => {
  const gallery = read('tests/e2e/actions/galleryActions.js');

  assert.match(gallery, /options\.minimumCards === undefined\s*\? 1/);
  assert.match(gallery, /metrics\.initialRefreshCompleted/);
  assert.match(gallery, /metrics\.marks\?\.initial_refresh_complete/);
  assert.match(gallery, /libraryLoader\.hidden/);
  assert.match(gallery, /visibleCards\.length >= selectors\.minimumCards/);
  assert.match(gallery, /bounds\.width > 0 && bounds\.height > 0/);
  assert.doesNotMatch(gallery, /minimumCards \?\? 10/);
});

test('album identity topology uses action-owned scrolling and rendered card locators only', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const expected = [
    { album: 'Sparse Album Edit Fixture', year: '2000' },
    { album: 'Sparse Album Edit Result', year: '2000' },
    { album: 'Sparse Year Edit Fixture', year: '2004' },
    { album: 'Sparse Year Edit Fixture', year: '2014' },
  ];
  const scrolls = [];
  const resets = [];
  let modeledScrollTop = 9134;
  let generationReadCount = 0;
  let renderedWindowReadCount = 0;
  const generationStates = [
    { revision: 1, settled: true },
    { revision: 2, settled: true },
    { revision: 2, settled: true },
    { revision: 2, settled: true },
  ];
  const galleryPage = {
    readViewGenerationState() {
      const generation = generationStates[generationReadCount];
      generationReadCount += 1;
      return generation;
    },
    async readRenderedAlbumIdentities(artistName, expectedAlbumNames) {
      assert.equal(artistName, 'E2E Rarity Artist');
      assert.deepEqual(expectedAlbumNames, [
        'Sparse Album Edit Fixture',
        'Sparse Album Edit Result',
        'Sparse Year Edit Fixture',
      ]);
      const attempt = Math.floor(renderedWindowReadCount / expected.length);
      const windowIndex = renderedWindowReadCount % expected.length;
      renderedWindowReadCount += 1;
      if (attempt === 0) {
        return [{
          ...expected[windowIndex],
          key: `mixed-generation-${windowIndex}`,
        }];
      }
      return expected.map((identity, index) => ({
        ...identity,
        key: `rendered-card-${index}`,
      }));
    },
  };
  const actions = new GalleryActions(galleryPage);
  actions.readGalleryScrollState = async () => ({
    clientHeight: 720,
    maxScrollTop: 10000,
    scrollTop: modeledScrollTop,
  });
  actions.scrollToAlbumUnderHeading = async (artistName, albumName, options) => {
    const attempt = Math.floor(scrolls.length / expected.length);
    const windowIndex = scrolls.length % expected.length;
    if (attempt === 1 && windowIndex === 0) {
      assert.equal(
        modeledScrollTop,
        9134,
        'A stable-generation retry must restore the captured gallery position before traversing again.',
      );
    }
    scrolls.push({ artistName, albumName, options });
    modeledScrollTop = 10000;
  };
  actions.restoreGalleryScrollPosition = async (targetScrollTop) => {
    resets.push({ from: modeledScrollTop, to: targetScrollTop });
    modeledScrollTop = targetScrollTop;
  };

  const topology = await actions.waitForAlbumIdentityTopology(
    'E2E Rarity Artist',
    expected,
    { waitAtBoundary: true },
  );
  assert.deepEqual(topology.identities, expected);
  assert.equal(topology.scroll.scrollTop, 9134);
  assert.equal(generationReadCount, 4);
  assert.equal(renderedWindowReadCount, expected.length * 2);
  assert.deepEqual(resets, [{ from: 10000, to: 9134 }]);
  assert.deepEqual(scrolls, [expected, expected].flatMap((attempt) => (
    attempt.map((identity) => ({
      artistName: 'E2E Rarity Artist',
      albumName: identity.album,
      options: { waitAtBoundary: true, year: identity.year },
    }))
  )));

  const pom = read('tests/e2e/poms/galleryPage.js');
  const galleryActions = read('tests/e2e/actions/galleryActions.js');
  const sparseScenario = read('tests/e2e/helpers/sparseTagEditScenario.js');
  assert.doesNotMatch(pom, /virtualGrid\.sections/);
  assert.doesNotMatch(pom, /readAlbumIdentityTopology/);
  assert.doesNotMatch(galleryActions, /completeVirtualGrid/);
  assert.doesNotMatch(sparseScenario, /completeVirtualGrid/);
  assert.match(
    pom,
    /readRenderedAlbumIdentities[\s\S]*return matchingCards\.evaluateAll/,
  );
  assert.match(
    galleryActions,
    /waitForAlbumIdentityTopology[\s\S]*retryRequiresScrollReset[\s\S]*restoreGalleryScrollPosition\(scroll\.scrollTop[\s\S]*readViewGenerationState\(\)[\s\S]*new Map\(\)[\s\S]*scrollToAlbumUnderHeading\(artistName, identity\.album,[\s\S]*year: identity\.year[\s\S]*readRenderedAlbumIdentities[\s\S]*generationBefore\.revision !== generationAfter\.revision/,
  );
  assert.match(
    galleryActions,
    /restoreGalleryScrollPosition[\s\S]*maxScrollActions[\s\S]*Math\.min\(target, scrollState\.maxScrollTop\)[\s\S]*scrollActions < maxScrollActions[\s\S]*scrollGalleryBy\(deltaY\)[\s\S]*waitForGalleryScrollMovement/,
  );
  const clampedResetActions = new GalleryActions({
    async waitForGalleryScrollMovement() {},
  });
  let clampedScrollTop = 0;
  const clampedWheelDeltas = [];
  clampedResetActions.readGalleryScrollState = async () => ({
    clientHeight: 720,
    maxScrollTop: 5000,
    scrollTop: clampedScrollTop,
  });
  clampedResetActions.scrollGalleryBy = async (deltaY) => {
    clampedWheelDeltas.push(deltaY);
    clampedScrollTop = Math.min(5000, clampedScrollTop + deltaY);
  };
  const clampedReset = await clampedResetActions.restoreGalleryScrollPosition(
    9134,
    { maxActions: 2, timeout: 100 },
  );
  assert.equal(clampedReset.scrollTop, 5000);
  assert.deepEqual(clampedWheelDeltas, [5000]);

  const boundedResetActions = new GalleryActions({
    async waitForGalleryScrollMovement() {},
  });
  let boundedScrollTop = 0;
  const boundedWheelDeltas = [];
  boundedResetActions.readGalleryScrollState = async () => ({
    clientHeight: 720,
    maxScrollTop: 5000,
    scrollTop: boundedScrollTop,
  });
  boundedResetActions.scrollGalleryBy = async (deltaY) => {
    boundedWheelDeltas.push(deltaY);
    boundedScrollTop += Math.sign(deltaY);
  };
  await assert.rejects(
    boundedResetActions.restoreGalleryScrollPosition(
      4000,
      { maxActions: 2, timeout: 100 },
    ),
    /with 2 of 2 production wheel actions/,
  );
  assert.equal(boundedWheelDeltas.length, 2);
});

test('mounted topology allows only the edited-card-sized trailing virtual boundary change', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/galleryActions.js'),
  ).href;
  const { evaluateMountedAlbumWindowTransition } = await import(moduleUrl);
  const card = (album, nodeId) => ({
    album,
    key: album.toLowerCase(),
    nodeId,
    year: '2000',
  });
  const initialCards = [
    card('Before', 1),
    card('Source', 2),
    card('After A', 3),
    card('After B', 4),
  ];
  const legitimateInsertion = evaluateMountedAlbumWindowTransition({
    editedAlbumNames: new Set(['Source', 'Destination']),
    initialCards,
    settledCards: [
      card('Before', 1),
      card('Source', 2),
      card('Destination', 5),
      card('After A', 3),
    ],
  });
  assert.deepEqual(
    legitimateInsertion.sharedSettled,
    legitimateInsertion.sharedInitial,
  );
  assert.equal(legitimateInsertion.removedAtSuffix, true);
  assert.equal(legitimateInsertion.addedAtSuffix, true);
  assert.equal(legitimateInsertion.boundaryChangeCount, 1);
  assert.equal(legitimateInsertion.boundaryChangeBudget, 1);

  const upwardJump = evaluateMountedAlbumWindowTransition({
    editedAlbumNames: new Set(['Source', 'Destination']),
    initialCards,
    settledCards: [
      card('Earlier A', 6),
      card('Earlier B', 7),
      card('Before', 1),
      card('Source', 2),
      card('Destination', 5),
    ],
  });
  assert.equal(upwardJump.addedAtSuffix, false);
  assert.ok(upwardJump.boundaryChangeCount > upwardJump.boundaryChangeBudget);
});

test('tag moves protect transient topology where observable and settle every repeated move exactly', () => {
  const pom = read('tests/e2e/poms/galleryPage.js');
  const actions = read('tests/e2e/actions/galleryActions.js');
  const spec = read('tests/e2e/specs/albumTagRename.spec.js');
  const caseStart = spec.indexOf("test('FTC-TAGS-015");
  const caseSource = spec.slice(caseStart);
  const firstMoveStart = caseSource.indexOf(
    "stepLogger.step('Move the first track into the destination album'",
  );
  const secondMoveStart = caseSource.indexOf(
    "stepLogger.step('Move the second track into the same destination album'",
    firstMoveStart,
  );
  const firstMoveSource = caseSource.slice(firstMoveStart, secondMoveStart);

  assert.ok(caseStart >= 0);
  assert.match(
    pom,
    /cardNodeIds = new WeakMap[\s\S]*?observedCards = cards\.map[\s\S]*?data-gallery-card-key[\s\S]*?nodeId[\s\S]*?orderIndex[\s\S]*?rowTop[\s\S]*?albumTrackCountSelector/,
  );
  assert.match(
    pom,
    /sameTopology[\s\S]*?JSON\.stringify\(left\.cards\) === JSON\.stringify\(right\.cards\)/,
  );
  assert.match(
    pom,
    /exactMultiplicity[\s\S]*?exactTrackCounts[\s\S]*?exactAbsence/,
  );
  assert.match(
    actions,
    /expectStableAlbumTopologyTransitionDuring[\s\S]*?observation\.violations[\s\S]*?finalSample\.cards[\s\S]*?baseline\.cards/,
  );
  assert.match(
    actions,
    /evaluateMountedAlbumWindowTransition[\s\S]*?sharedSettled[\s\S]*?sharedInitial[\s\S]*?removedAtSuffix[\s\S]*?addedAtSuffix[\s\S]*?boundaryChangeCount[\s\S]*?boundaryChangeBudget/,
    'shared unrelated cards must retain DOM identity and only a bounded trailing virtualization change is permitted',
  );
  assert.equal(
    caseSource.match(/expectStableAlbumTopologyTransitionDuring\(/g)?.length,
    4,
    'the first move, overlapping second move, first restore, and final merge must each be continuously observed',
  );
  assert.match(
    caseSource,
    /Repeat the same destination move through the owner-reported fifth edit[\s\S]*?applyAndWaitForSavedFiles\(\)[\s\S]*?readAlbumCardSummaryByIdentity[\s\S]*?readAlbumCardSummaryByIdentity/,
    'edits 3-5 must wait for physical-save completion and then assert both exact persisted cards',
  );
  assert.match(caseSource, /trackCount: '17 tracks'[\s\S]*?trackCount: '1 track'/);
  assert.match(caseSource, /trackCount: '16 tracks'[\s\S]*?trackCount: '2 tracks'/);
  assert.match(
    caseSource,
    /trackCount: '18 tracks'[\s\S]*?absentIdentities:[\s\S]*?SPLIT_RENAMED_ALBUM/,
  );
  assert.match(
    caseSource,
    /Move the second track into the same destination album[\s\S]*?Verify effective source numbering and the incomplete-order diagnosis[\s\S]*?settingsModalAppBarActions\.openSettings\(\)[\s\S]*?utilityTabBarActions\.openTab\('problematic-files'\)[\s\S]*?utilityProblematicFilesActions\.search\(SPLIT_ORIGINAL_ALBUM\)[\s\S]*?utilityProblematicFilesActions\.selectAlbumByTitle\(SPLIT_ORIGINAL_ALBUM\)[\s\S]*?readSelectedDetailSummary\(\)[\s\S]*?expect\(\[\.\.\.new Set\(detail\.problemReasons\)\]\)\.toEqual\(\[[\s\S]*?'Incomplete track order: Disc 1 missing 1, 2',[\s\S]*?\]\)[\s\S]*?settingsModalAppBarActions\.closeSettings\(\)[\s\S]*?galleryActions\.goto\(ARTIST_VIEW_URL\)[\s\S]*?Repeat the same destination move through the owner-reported fifth edit/,
    'after move 2, the production E2E must verify the exact Problematic Files diagnosis before edits 3-5 continue',
  );
  assert.match(
    caseSource,
    /firstMovePersistenceGate = await holdStructuralSavePersistence\(\)[\s\S]*?stage === 'before-edit-response'[\s\S]*?releaseFirstMoveStartCheckpoint\(firstMoveStartState\)[\s\S]*?Move the second track into the same destination album[\s\S]*?firstMoveCompletionSettledBeforeSecondEditResponse = firstMoveCompletionSettled[\s\S]*?await firstMovePersistenceGate\.release\(\)[\s\S]*?await firstMoveCompletionPromise[\s\S]*?Expected edit 2 to claim and render before edit 1 reconciled/,
    'the persistence gate must hold edit 1 at its terminal POST while edit 2 claims and renders, then release both overlapping completions',
  );
  assert.ok(firstMoveStart >= 0 && secondMoveStart > firstMoveStart);
  assert.equal(
    firstMoveSource.match(/checkpoint\(stage, \{ arm: true \}\)/g)?.length,
    1,
    'edit 1 must stop using the topology observer after its before-response checkpoint',
  );
  assert.match(
    firstMoveSource,
    /let firstMoveStartState = null[\s\S]*?if \(stage === 'before-edit-response'\) \{[\s\S]*?firstMoveStartState = await checkpoint\(stage, \{ arm: true \}\)[\s\S]*?return firstMoveStartState;[\s\S]*?if \(!firstMoveStartState\)[\s\S]*?throw new Error[\s\S]*?return firstMoveStartState;/,
    'edit 1 must reuse its retained plain snapshot after the move-1 observer finishes',
  );
  assert.match(
    caseSource,
    /Move the second track into the same destination album[\s\S]*?ftc-tags-015-after-second-move-gallery\.png[\s\S]*?waitForExactAlbumDetails\(\{[\s\S]*?title:\s*albumDetailsTitle\(SPLIT_ORIGINAL_ALBUM\)[\s\S]*?trackTitles:\s*sourceTrackTitlesAfterSecondMove[\s\S]*?displayedTrackNumbers[\s\S]*?ftc-tags-015-after-second-move-source-details\.png[\s\S]*?openTagEditor\(\)[\s\S]*?trackFilenames\)\.toEqual\([\s\S]*?sourceFilenamesAfterSecondMove[\s\S]*?ftc-tags-015-after-second-move-source-editor\.png[\s\S]*?title:\s*albumDetailsTitle\(SPLIT_RENAMED_ALBUM\)[\s\S]*?trackTitles:\s*destinationTrackTitlesAfterSecondMove[\s\S]*?ftc-tags-015-after-second-move-destination-details\.png[\s\S]*?trackFilenames\)\.toEqual\([\s\S]*?destinationFilenamesAfterSecondMove[\s\S]*?ftc-tags-015-after-second-move-destination-editor\.png[\s\S]*?Verify effective source numbering and the incomplete-order diagnosis/,
    'before Problematic Files navigation, move 2 must prove exact source and numeric-suffix destination membership in Details and Edit Tags',
  );
  assert.match(
    caseSource,
    /const topologyObservations = \[\][\s\S]*?transition:\s*'move-1'[\s\S]*?transition:\s*'move-2-overlapping-saves'[\s\S]*?transition:\s*'restore-1'[\s\S]*?transition:\s*'restore-final-merge'[\s\S]*?testArtifacts\.queueJsonAttachment\(\s*'ftc-tags-015-topology-observations'[\s\S]*?topologyObservations/,
    'all four continuously observed topology transitions must remain fixture-owned machine-readable evidence',
  );
  assert.doesNotMatch(
    caseSource,
    /testInfo\.attach\(/,
    'FTC-TAGS-015 evidence must flow through the shared artifact fixture',
  );
  assert.match(
    caseSource,
    /ftc-tags-015-after-first-restore-gallery\.png/,
    'the first restore must retain labeled intermediate 14/4 gallery proof',
  );
  assert.match(
    caseSource,
    /Capture the verified stable gallery, details, and editors[\s\S]*?setViewportSize\(\{ width: 1280, height: 960 \}\)[\s\S]*?scrollToAlbumUnderHeading\([\s\S]*?SPLIT_ORIGINAL_ALBUM[\s\S]*?scrollToAlbumUnderHeading\([\s\S]*?SPLIT_RENAMED_ALBUM[\s\S]*?ftc-tags-015-stable-gallery\.png[\s\S]*?setViewportSize\(\{ width: 1280, height: 720 \}\)[\s\S]*?scrollToAlbumUnderHeading\([\s\S]*?SPLIT_RENAMED_ALBUM[\s\S]*?readAlbumIdentityCardCount\([\s\S]*?album: SPLIT_ORIGINAL_ALBUM[\s\S]*?readAlbumIdentityCardCount\([\s\S]*?album: SPLIT_RENAMED_ALBUM/,
    'the retained stable-gallery proof must expose the numeric-suffix albums, then remount both identities at the regression viewport before opening details',
  );
});

test('FTC-TAGS-008 terminal-failure compensation reloads one exact two-track rarity card before later cases', () => {
  const spec = read('tests/e2e/specs/albumTagRename.spec.js');
  const caseStart = spec.indexOf("test('FTC-TAGS-008 keeps an accepted terminal failure");
  const caseEnd = spec.indexOf("test('FTC-TAGS-009", caseStart);
  const caseSource = spec.slice(caseStart, caseEnd);

  assert.ok(caseStart >= 0 && caseEnd > caseStart);
  assert.match(
    caseSource,
    /readVisibleHistoryText\(\)[\s\S]*?settingsModalAppBarActions\.closeSettings\(\)[\s\S]*?privilegeGuard\.restore\(\)[\s\S]*?Reload the compensated rarity fixture as one exact two-track album[\s\S]*?trackModalActions\.closeIfOpen\(\)[\s\S]*?page\.reload\(\{ waitUntil: 'domcontentloaded' \}\)[\s\S]*?waitForGalleryReady\(\)[\s\S]*?readAlbumIdentityCardCount\(\{[\s\S]*?album:\s*FAILURE_FIXTURE_ALBUM[\s\S]*?year:\s*FIXTURE_YEAR[\s\S]*?\}\)\)\.toBe\(1\)[\s\S]*?waitForExactAlbumDetails\(\{[\s\S]*?trackTitles:\s*\['Apply Rarity Here', 'Remain Editable'\]/,
    'terminal-failure cleanup must prove the reloaded rarity identity has one card and its exact two physical tracks',
  );
});

test('terminal tag-save contracts keep one pending POST authoritative without status polling', () => {
  const actions = read('tests/e2e/actions/tagEditorActions.js');
  const renameSpec = read('tests/e2e/specs/albumTagRename.spec.js');
  const creditsSpec = read('tests/e2e/specs/albumTrackCredits.spec.js');
  const autoNumberSpec = read('tests/e2e/specs/tagEditorAutoNumber.spec.js');

  assert.match(
    actions,
    /applyAndWaitForTerminalSavedResponse[\s\S]*?timeout = options\.timeout \|\| 35000[\s\S]*?Writing tag changes\.\.\.[\s\S]*?expect\(postSettled\)\.toBe\(false\)[\s\S]*?whilePostInFlight[\s\S]*?save_task_status\)\.toBe\('completed'\)[\s\S]*?Tag changes saved\.[\s\S]*?expect\(saveTaskPollCount\)\.toBe\(0\)/,
  );
  assert.match(
    actions,
    /terminalAlertDismissalTimeout[\s\S]*?save_task_status\)\.toBe\('completed'\)[\s\S]*?Tag changes saved\.[\s\S]*?terminalAlertDismissalTimeout/,
  );
  assert.doesNotMatch(actions, /applyAndWaitForProductionPollWindowExhaustion/);
  assert.match(
    renameSpec,
    /applyAndWaitForTerminalSavedResponse\([\s\S]*?whilePostInFlight[\s\S]*?isPostSettled\(\)\)\.toBe\(false\)[\s\S]*?readAlbumIdentityCardCount[\s\S]*?waitForTitle[\s\S]*?isPostSettled\(\)\)\.toBe\(false\)[\s\S]*?persistenceGate\.release\(\)/,
  );
  assert.match(
    creditsSpec,
    /applyAndWaitForTerminalSavedResponse\([\s\S]*?whilePostInFlight[\s\S]*?isPostSettled\(\)\)\.toBe\(false\)[\s\S]*?readSplitCredits[\s\S]*?isPostSettled\(\)\)\.toBe\(false\)[\s\S]*?persistenceGate\.release\(\)/,
  );
  assert.match(
    autoNumberSpec,
    /applyAndWaitForSavedFiles\(\{\s*terminalAlertDismissalTimeout: 3500,\s*\}\)/,
  );

  const optimisticMethodStart = actions.indexOf('async applyAndObserveOptimisticState');
  const optimisticMethod = actions.slice(optimisticMethodStart);
  assert.ok(optimisticMethodStart >= 0);
  assert.match(optimisticMethod, /save_task_status\)\.toBe\('completed'\)/);
  assert.match(optimisticMethod, /Tag changes saved\./);
  assert.doesNotMatch(optimisticMethod, /saveTaskStatuses|\/utilities\/save-task\/|production poller/);
  assert.doesNotMatch(optimisticMethod, /Library view updated from saved files\./);
});

test('FTC-TAGS-008 keeps terminal failure copy compact and opens the exact raw Log History detail', () => {
  const spec = read('tests/e2e/specs/albumTagRename.spec.js');
  const caseStart = spec.indexOf("test('FTC-TAGS-008 keeps an accepted terminal failure");
  const caseEnd = spec.indexOf("test('FTC-TAGS-009", caseStart);
  const caseSource = spec.slice(caseStart, caseEnd);

  assert.ok(caseStart >= 0 && caseEnd > caseStart);
  assert.match(caseSource, /utilityLogHistoryActions/);
  assert.match(caseSource, /expect\(failure\.task\.error\)\.toContain\('ignored_versions'\)/);
  assert.match(caseSource, /expect\(failure\.alertText\)\.toBe\('Failed to edit tags\.'\)/);
  assert.match(
    caseSource,
    /expectTerminalFailureRemainsReadable\('Failed to edit tags\.'\)[\s\S]*?openLogHistoryFromFailure\(\)[\s\S]*?utilityLogHistoryActions\.waitForReady\(\)[\s\S]*?readVisibleHistoryText\(\)[\s\S]*?toContain\(failure\.task\.error\)/,
  );
  assert.doesNotMatch(caseSource, /failure\.alertText\)\.toContain\('ignored_versions'\)/);
});

test('FTC-TAGS-020 completion observation uses the authoritative edit POST without save-task polling', () => {
  const actions = read('tests/e2e/actions/tagEditorActions.js');
  const methodStart = actions.indexOf('async applyAndReturnAcceptedEdit');
  const methodEnd = actions.indexOf('async applyAndWaitForTerminalSavedResponse', methodStart);
  const method = actions.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0 && methodEnd > methodStart);
  assert.match(method, /save_task_status\)\.toBe\('completed'\)/);
  assert.match(
    method,
    /const terminalSavedAlert = this\.tagEditor\.repairAlertMessage;[\s\S]*?waitForCompletion:\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?await expect\(terminalSavedAlert\)\.toHaveText\(\s*'Tag changes saved\.'[\s\S]*?return payload;/,
    'completion must await the captured exact saved alert before returning the authoritative terminal POST payload',
  );
  assert.doesNotMatch(method, /saveTaskStatuses/);
  assert.doesNotMatch(method, /\/utilities\/save-task\//);
  assert.doesNotMatch(method, /production poller/);
  const confirmClickStartedAt = method.indexOf(
    'const confirmClickPromise = this.tagEditor.confirmButton.click();',
  );
  const beforeResponseStartedAt = method.indexOf(
    'options.onBeforeResponse({ confirmationClickedAt })',
  );
  const confirmClickAwaitedAt = method.indexOf('await confirmClickPromise;');
  const beforeResponseAwaitedAt = method.indexOf('await beforeResponsePromise;');
  assert.ok(confirmClickStartedAt >= 0, 'the real confirm click must start as a promise');
  assert.ok(
    beforeResponseStartedAt > confirmClickStartedAt,
    'the concurrent-interaction hook must start after the real confirm click is initiated',
  );
  assert.ok(
    confirmClickAwaitedAt > beforeResponseStartedAt,
    'the helper must not await the click before starting the concurrent-interaction hook',
  );
  assert.ok(
    beforeResponseAwaitedAt > confirmClickAwaitedAt,
    'the helper must await the concurrent-interaction hook before accepting the response',
  );
  assert.doesNotMatch(method, /\.route\(|\.unroute\(|route\.fetch\(|route\.fulfill\(/);
});

test('FTC-TAGS-020 restores scroll after its suffix-five diagnostic traversal', () => {
  const spec = read('tests/e2e/specs/ddtStudioRecordsRenderer.spec.js');
  const caseStart = spec.indexOf("test('FTC-TAGS-020");
  const caseSource = spec.slice(caseStart);

  assert.ok(caseStart >= 0);
  assert.match(
    caseSource,
    /if \(suffix === 5\) \{[\s\S]*?await settingsModalAppBarActions\.closeSettings\(\);[\s\S]*?await trackModalActions\.close\(\);[\s\S]*?await galleryActions\.restoreGalleryScrollPosition\(preEditScrollTop\);[\s\S]*?await openAlbumDetails\(SOURCE_ALBUM\);/,
    'the intentional suffix diagnostic must restore its own scroll side effect before the preservation checkpoint',
  );
});

test('functional race checks arm transient mutation observation before submit and compare reload from the immediate playback position', () => {
  const identitySpec = read('tests/e2e/specs/albumIdentityConsolidation.spec.js');
  const reloadSpec = read('tests/e2e/specs/playerReloadAutoplayAllowed.spec.js');
  const playerActions = read('tests/e2e/actions/globalPlayerActions.js');

  assert.match(
    identitySpec,
    /const pendingContinuityPromise = utilityProblematicFilesActions[\s\S]*?\.waitForMutationOverlayAndReadContinuity\(\);[\s\S]*?applyAndReturnAcceptedEdit\(\)[\s\S]*?await pendingContinuityPromise/,
  );
  assert.match(
    playerActions,
    /const preReload = await this\.globalPlayer\.readPlaybackTiming\(\);[\s\S]*?page\.reload[\s\S]*?preReload,/,
  );
  assert.match(
    reloadSpec,
    /restored\.initialRestore\.currentTime - restored\.preReload\.currentTime/,
  );
});

test('the first selected-track move proves exact numeric-suffix destination membership', () => {
  const spec = read('tests/e2e/specs/albumTagRename.spec.js');
  const caseStart = spec.indexOf("test('FTC-TAGS-009");
  const caseEnd = spec.indexOf("test('FTC-TAGS-015", caseStart);
  const caseSource = spec.slice(caseStart, caseEnd);

  assert.ok(caseStart >= 0);
  const proofStart = caseSource.indexOf(
    "stepLogger.step('Verify both covered albums and exact track counts in the current gallery'",
  );
  const proofEnd = caseSource.indexOf(
    "stepLogger.step('Move a second source track into a distinct destination album'",
    proofStart,
  );
  const proofSource = caseSource.slice(proofStart, proofEnd);

  assert.ok(proofStart >= 0 && proofEnd > proofStart);
  assert.match(
    proofSource,
    /waitForExactAlbumDetails\(\{[\s\S]*?title:\s*albumDetailsTitle\(SPLIT_RENAMED_ALBUM\)[\s\S]*?trackTitles:\s*\[EXPECTED_SPLIT_TRACK_TITLES\[0\]\][\s\S]*?displayedTrackNumbers:\s*\[1\]/,
    'the destination Details view must prove the exact moved title and displayed number',
  );
  assert.match(
    proofSource,
    /ftc-tags-009-first-move-destination-details\.png[\s\S]*?openTagEditor\(\)[\s\S]*?trackFilenames\)\.toEqual\(\s*\[SPLIT_SELECTED_FILENAME\][\s\S]*?ftc-tags-009-first-move-destination-editor\.png/,
    'the destination Edit Tags view must prove the exact moved filename and retain labeled proof',
  );
});

test('sparse optimistic POM observation atomically reads visible section count and rendered identities', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/poms/galleryPage.js'),
  ).href;
  const { parseArtistAlbumCount } = await import(moduleUrl);
  assert.equal(
    typeof parseArtistAlbumCount,
    'function',
    'Expected a visible artist-meta count reader that does not depend on the mounted virtual window.',
  );
  assert.equal(parseArtistAlbumCount('14 albums'), 14);
  assert.equal(parseArtistAlbumCount('1 album'), 1);

  const pom = read('tests/e2e/poms/galleryPage.js');
  const observationMethod = pom.match(
    /async readProductionVisibleAlbumObservation[\s\S]*?\n  }/,
  )?.[0] || '';
  assert.match(
    observationMethod,
    /sectionByArtistHeading\(artistName\)[\s\S]*await section\.evaluate[\s\S]*artistMetaText[\s\S]*\.artist-meta[\s\S]*renderedIdentities[\s\S]*albumCount:\s*parseArtistAlbumCount\(observation\.artistMetaText\)/,
  );
  assert.doesNotMatch(
    observationMethod,
    /readRenderedAlbumIdentities|productionViewObserver|virtualGrid|__ALBUM_HAVEN_VIRTUAL_GRID__/,
  );
});

test('sparse optimistic action rejects a missing adjacent identity without scrolling', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/galleryActions.js'),
  ).href;
  const { GalleryActions } = await import(moduleUrl);
  const observationCalls = [];
  const actions = new GalleryActions({
    async readProductionVisibleAlbumObservation(artistName, expectedAlbumNames) {
      observationCalls.push({ artistName, expectedAlbumNames });
      return {
        albumCount: 14,
        renderedIdentities: [
          { album: 'Sparse Year Edit Fixture', year: '2014' },
        ],
      };
    },
  });
  actions.readGalleryScrollState = async () => ({
    clientHeight: 720,
    maxScrollTop: 10000,
    scrollTop: 9134,
  });
  actions.scrollToAlbumUnderHeading = async () => {
    assert.fail('A transient optimistic observation must not scroll the gallery.');
  };
  actions.scrollGalleryBy = async () => {
    assert.fail('A transient optimistic observation must not scroll the gallery.');
  };

  await assert.rejects(
    actions.readCurrentProductionVisibleAlbumObservation(
      'E2E Rarity Artist',
      [
        { album: 'Sparse Year Edit Fixture', year: '2004' },
        { album: 'Sparse Year Edit Fixture', year: '2014' },
      ],
      { expectedAlbumCount: 14 },
    ),
    /Expected every provided E2E Rarity Artist album identity to be rendered in the current optimistic window/,
  );
  assert.deepEqual(observationCalls, [{
    artistName: 'E2E Rarity Artist',
    expectedAlbumNames: ['Sparse Year Edit Fixture'],
  }]);
});

test('sparse optimistic action accepts exact adjacent identities and preserves count and scroll', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/galleryActions.js'),
  ).href;
  const { GalleryActions } = await import(moduleUrl);
  const actions = new GalleryActions({
    async readProductionVisibleAlbumObservation() {
      return {
        albumCount: 14,
        renderedIdentities: [
          { album: 'Sparse Year Edit Fixture', year: '2014' },
          { album: 'Sparse Year Edit Fixture', year: '2004' },
        ],
      };
    },
  });
  actions.readGalleryScrollState = async () => ({
    clientHeight: 720,
    maxScrollTop: 10000,
    scrollTop: 9134,
  });
  actions.scrollToAlbumUnderHeading = async () => {
    assert.fail('An exact adjacent optimistic observation must not scroll the gallery.');
  };
  actions.scrollGalleryBy = async () => {
    assert.fail('An exact adjacent optimistic observation must not scroll the gallery.');
  };

  const observation = await actions.readCurrentProductionVisibleAlbumObservation(
    'E2E Rarity Artist',
    [
      { album: 'Sparse Year Edit Fixture', year: '2004' },
      { album: 'Sparse Year Edit Fixture', year: '2014' },
    ],
    { expectedAlbumCount: 14 },
  );

  assert.deepEqual(observation, {
    albumCount: 14,
    renderedIdentities: [
      { album: 'Sparse Year Edit Fixture', year: '2004' },
      { album: 'Sparse Year Edit Fixture', year: '2014' },
    ],
    scroll: {
      clientHeight: 720,
      maxScrollTop: 10000,
      scrollTop: 9134,
    },
  });

  const sparseScenario = read('tests/e2e/helpers/sparseTagEditScenario.js');
  const sparseSpec = read('tests/e2e/specs/sparseTagEditReconciliation.spec.js');
  const yearScenario = sparseSpec.slice(
    sparseSpec.indexOf("test('FTC-TAGS-013"),
  );
  const transientObservation = sparseScenario.match(
    /readOptimisticState: async \(stage\) => \{[\s\S]*?return \{ stage, \.\.\.topology \};\s*\}/,
  )?.[0] || '';
  assert.match(
    sparseScenario,
    /visibleAlbumCountBeforeEdit[\s\S]*readCurrentProductionVisibleAlbumObservation[\s\S]*resultIdentities\.length - 1/,
  );
  assert.match(
    sparseScenario,
    /await galleryActions\.selectAlbumDetailsByIdentity\(\{\s*artist:\s*FIXTURE_ARTIST,\s*\.\.\.originalIdentity,\s*\},\s*\{\s*waitAtBoundary:\s*true,\s*\}\);/,
    'The root startup preview must finish hydrating before the sparse fixture is declared absent.',
  );
  const initialTopologyIndex = sparseScenario.indexOf(
    'waitForAlbumIdentityTopology(\n      FIXTURE_ARTIST,\n      [originalIdentity],\n      { waitAtBoundary: true },',
  );
  const initialAlbumSelectionIndex = sparseScenario.indexOf(
    'selectAlbumDetailsByIdentity({\n      artist: FIXTURE_ARTIST,\n      ...originalIdentity,',
  );
  assert.ok(
    initialTopologyIndex >= 0 && initialTopologyIndex < initialAlbumSelectionIndex,
    'The sparse fixture topology must be observed before opening the modal hides its virtualized card.',
  );
  assert.match(
    sparseScenario,
    /visibleObservationBeforeEdit[\s\S]*readCurrentProductionVisibleAlbumObservation\(\s*FIXTURE_ARTIST,\s*\[\],\s*\)/,
    'The post-topology section-count read must not require the virtualized target card to remain mounted.',
  );
  assert.match(transientObservation, /readCurrentProductionVisibleAlbumObservation/);
  assert.doesNotMatch(
    transientObservation,
    /waitForAlbumIdentityTopology|scrollToAlbum|waitForGalleryScrollPosition/,
  );
  assert.match(
    yearScenario,
    /appBarActions[\s\S]*trackCount: 17[\s\S]*trackCount: 1[\s\S]*verifyAfterIncrementalScan: true/,
  );
  assert.match(
    sparseScenario,
    /if \(verifyAfterIncrementalScan\)[\s\S]*appBarActions\.triggerIncrementalScanAndWait\(\)[\s\S]*assertAlbumTopologyAndTrackCounts[\s\S]*freshBrowserSession\.create\(\)/,
  );
});

test('sparse tag response observation starts while the initial topology observation is still pending', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/tagEditorActions.js'),
  ).href;
  const { TagEditorActions } = await import(moduleUrl);
  const createDeferred = () => {
    let resolve;
    const promise = new Promise((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  };
  const editResponseDeferred = createDeferred();
  const initialObservationStarted = createDeferred();
  const releaseInitialObservation = createDeferred();
  const retainedObservationStarted = createDeferred();
  const observedStages = [];
  const request = {
    method: () => 'POST',
    postDataJSON: () => ({
      album: { key: 'sparse-source' },
      confirmed: true,
      updates: {
        'D:\\Synthetic Music\\Rarity Artist\\Sparse Album\\01 Apply Rarity.mp3': {
          album: 'Sparse Album Edit Result',
        },
      },
    }),
    url: () => 'http://127.0.0.1:4173/utilities/edit-tags',
  };
  const editResponse = {
    json: async () => ({
      ok: true,
      save_task_id: 'sparse-save-task',
      save_task_status: 'completed',
      updated_albums: [],
    }),
    ok: () => true,
    request: () => request,
    status: () => 200,
    url: () => 'http://127.0.0.1:4173/utilities/edit-tags',
  };
  const completedResponse = {
    json: async () => ({
      ok: true,
      status: 'completed',
      updated_albums: [],
    }),
    request: () => ({ method: () => 'GET' }),
    url: () => 'http://127.0.0.1:4173/utilities/save-task/sparse-save-task',
  };
  const page = new EventEmitter();
  page.waitForRequest = async (predicate) => {
    assert.equal(predicate(request), true);
    return request;
  };
  page.waitForResponse = async (predicate) => {
    assert.equal(predicate(editResponse), true);
    return editResponseDeferred.promise;
  };
  const passingLocator = {
    _apiName: 'Locator',
    async _expect() {
      return { matches: true, received: { value: true }, log: [] };
    },
    toString() {
      return '<deterministic tag editor locator>';
    },
  };
  const actions = new TagEditorActions({
    applyButton: { async click() {} },
    confirmButton: {
      async click() {
        editResponseDeferred.resolve(editResponse);
      },
    },
    confirmDialog: passingLocator,
    confirmOverlay: passingLocator,
    overlay: passingLocator,
    page,
    repairAlertMessage: passingLocator,
  });
  const operation = actions.applyAndObserveOptimisticState({
    expectedField: 'album',
    expectedValue: 'Sparse Album Edit Result',
    expectedFilename: '01 Apply Rarity.mp3',
    readOptimisticState: async (stage) => {
      observedStages.push(stage);
      if (stage === 'before-edit-response') {
        initialObservationStarted.resolve();
        await releaseInitialObservation.promise;
      } else {
        retainedObservationStarted.resolve();
      }
      return { stage };
    },
  });

  let orderingFailure = null;
  await initialObservationStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.deepEqual(
      [...observedStages],
      [
        'before-edit-response',
        'after-terminal-response',
      ],
      'The response-stage observation must start from the edit response instead of waiting for the initial topology traversal.',
    );
  } catch (error) {
    orderingFailure = error;
  } finally {
    releaseInitialObservation.resolve();
    await retainedObservationStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    page.emit('response', completedResponse);
    await operation;
  }
  if (orderingFailure) throw orderingFailure;
});

test('saved-file completion callback runs before post-completion UI assertions', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/tagEditorActions.js'),
  ).href;
  const { TagEditorActions } = await import(moduleUrl);
  const events = [];
  const request = {
    method: () => 'POST',
    url: () => 'http://127.0.0.1:4173/utilities/edit-tags',
  };
  const editPayload = {
    ok: true,
    save_task_id: 'completed-save-task',
    updated_albums: [],
  };
  const editResponse = {
    json: async () => editPayload,
    ok: () => true,
    request: () => request,
    status: () => 200,
    url: () => request.url(),
  };
  const completedTask = {
    ok: true,
    status: 'completed',
    updated_albums: [],
  };
  const completedResponse = {
    json: async () => completedTask,
    request: () => ({ method: () => 'GET' }),
    url: () => (
      'http://127.0.0.1:4173/utilities/save-task/completed-save-task'
    ),
  };
  const page = new EventEmitter();
  page.waitForResponse = async (predicate) => {
    assert.equal(predicate(editResponse), true);
    return editResponse;
  };
  const locator = (label) => ({
    _apiName: 'Locator',
    async _expect(expression) {
      events.push(`assert:${label}:${expression}`);
      return { matches: true, received: { value: true }, log: [] };
    },
    toString() {
      return `<${label}>`;
    },
  });
  const actions = new TagEditorActions({
    applyButton: { async click() {} },
    confirmButton: {
      async click() {
        page.emit('response', completedResponse);
      },
    },
    confirmDialog: locator('confirm-dialog'),
    confirmOverlay: locator('confirm-overlay'),
    overlay: locator('overlay'),
    page,
    repairAlert: locator('repair-alert'),
    repairAlertMessage: locator('repair-alert-message'),
  });

  await actions.applyAndWaitForSavedFiles({
    timeout: 1000,
    onSaveTaskCompleted(completion) {
      events.push('callback');
      assert.equal(completion.saveTaskId, 'completed-save-task');
      assert.equal(completion.task, completedTask);
      assert.equal(completion.editPayload, editPayload);
    },
  });

  const callbackIndex = events.indexOf('callback');
  const alertAssertionIndex = events.findIndex((event) => (
    event.startsWith('assert:repair-alert-message:')
  ));
  const overlayAssertionIndex = events.findIndex((event) => (
    event.startsWith('assert:overlay:')
  ));
  assert.ok(callbackIndex >= 0, 'The terminal save completion callback must run.');
  assert.ok(
    callbackIndex < alertAssertionIndex,
    'The terminal callback must run before the success-alert assertion.',
  );
  assert.ok(
    callbackIndex < overlayAssertionIndex,
    'The terminal callback must run before the overlay assertion.',
  );
});

test('terminal tag-edit failure waits for the failure notification before reading it', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/tagEditorActions.js'),
  ).href;
  const { TagEditorActions } = await import(moduleUrl);
  const events = [];
  let alertText = 'Writing tag changes...';
  const passingLocator = {
    _apiName: 'Locator',
    async _expect() {
      return { matches: true, received: { value: true }, log: [] };
    },
    toString() {
      return '<deterministic tag editor locator>';
    },
  };
  const repairAlertMessage = {
    _apiName: 'Locator',
    async _expect(expression) {
      events.push(expression);
      if (expression === 'to.have.text') alertText = 'Failed to edit tags.';
      return { matches: true, received: { value: alertText }, log: [] };
    },
    async textContent() {
      return alertText;
    },
    toString() {
      return '<repair alert message>';
    },
  };
  const actions = new TagEditorActions({
    confirmOverlay: passingLocator,
    overlay: passingLocator,
    repairAlert: passingLocator,
    repairAlertMessage,
  });

  const result = await actions.readTerminalEditFailure({
    payload: {
      error: 'permission denied for table ignored_versions',
      save_task_id: 'failed-save-task',
      save_task_status: 'failed',
    },
    response: { status: () => 500 },
    timeout: 1000,
  });

  assert.ok(events.includes('to.have.text'));
  assert.equal(result.alertText, 'Failed to edit tags.');
});

test('FTC-OPS-003C proves the enabled cover cancel action is rendered only while production cover work is active', async () => {
  const helperUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/helpers/scanPerformanceHelpers.js')).href;
  const { waitForStatusCoverScan } = await import(helperUrl);
  const payloads = [
    { covers_in_progress: false },
    { covers_in_progress: true },
  ];
  const observedPaths = [];
  const activeStatus = await waitForStatusCoverScan({
    async get(url) {
      observedPaths.push(url);
      const payload = payloads.shift();
      return {
        ok: () => true,
        async json() { return payload; },
      };
    },
  }, { timeoutMs: 100, pollMs: 1 });
  assert.equal(activeStatus.covers_in_progress, true);
  assert.deepEqual(observedPaths, ['/status', '/status']);

  const actions = read('tests/e2e/actions/appBarActions.js');
  assert.match(
    actions,
    /expectActiveCoverScanAction[\s\S]*waitForPageCondition[\s\S]*coverActionButtonSelector[\s\S]*Cancel Album Cover Scan[\s\S]*cancel-cover-scan/,
  );
  assert.doesNotMatch(
    actions.match(/async expectActiveCoverScanAction[\s\S]*?\n  }/)?.[0] || '',
    /await expect\(/,
  );
  assert.doesNotMatch(
    actions.match(/async expectActiveCoverScanAction[\s\S]*?\n  }/)?.[0] || '',
    /\.click\(/,
  );

  const spec = read('tests/e2e/scanPerformance/scanPerformance.spec.js');
  const scenarioStart = spec.indexOf('test(`${SCAN_PAGE_CASE_ID}');
  const nextScenario = spec.indexOf('test(`${SCAN_CANCEL_CASE_ID}', scenarioStart);
  const scenario = spec.slice(scenarioStart, nextScenario);
  assert.match(
    scenario,
    /async \(\{[\s\S]*?\n\s*stepLogger,\n\s*\}, testInfo\) => \{/,
  );
  assert.doesNotMatch(
    scenario,
    /\n\s*testInfo,\n\s*\}\) => \{/,
  );
  assert.match(
    scenario,
    /appBarActions\.openStatusMenu\(\)[\s\S]*Promise\.all\(\[[\s\S]*waitForStatusCoverScan\(statusSampler[\s\S]*appBarActions\.expectActiveCoverScanAction\(\{ timeout: 120000 \}\)[\s\S]*appBarActions\.dismissStatusMenu\(\)[\s\S]*waitForStatusIdle\(statusSampler/,
  );
  assert.doesNotMatch(
    scenario,
    /waitForStatusCoverScan\(request,\s*\{ timeoutMs: 1000 \}\)/,
  );
});

test('scan-cold arms discovery observation before navigation can expose the short phase', () => {
  const spec = read('tests/e2e/scanPerformance/scanPerformance.spec.js');
  const scenarioStart = spec.indexOf('test(`${COLD_CASE_ID}');
  const scenarioEnd = spec.indexOf('test(`${CACHED_CASE_ID}', scenarioStart);
  assert.ok(scenarioStart >= 0 && scenarioEnd > scenarioStart, 'Expected cold scan scenario.');
  const scenario = spec.slice(scenarioStart, scenarioEnd);
  const samplerStart = scenario.indexOf('await statusSampler.start()');
  const observation = scenario.indexOf('const discoveryVisiblePromise');
  const recordedDiscovery = scenario.indexOf('waitForStatusDiscovery(statusSampler');
  const navigation = scenario.indexOf('galleryActions.goto()');

  assert.ok(samplerStart >= 0 && observation >= 0 && recordedDiscovery >= 0 && navigation >= 0);
  assert.ok(
    samplerStart < observation && observation < recordedDiscovery && recordedDiscovery < navigation,
    'Discovery observation must be armed before navigation exposes the ephemeral phase.',
  );
});

test('metadata scan checks the busy indicator before long-lived artist navigation', () => {
  const spec = read('tests/e2e/scanPerformance/scanPerformance.spec.js');
  const scenarioStart = spec.indexOf('test(`${METADATA_CASE_ID}');
  assert.ok(scenarioStart >= 0, 'Expected the metadata scan performance scenario.');
  const scenario = spec.slice(scenarioStart);
  const busyIndicatorCheck = scenario.indexOf(
    "stepLogger.step('Keep the busy scan indicator left click inert",
  );
  const artistNavigation = scenario.indexOf(
    "stepLogger.step('Open the existing metadata artist",
  );

  assert.ok(busyIndicatorCheck >= 0, 'Expected the busy scan indicator assertion.');
  assert.ok(artistNavigation >= 0, 'Expected the existing-artist navigation step.');
  assert.ok(
    busyIndicatorCheck < artistNavigation,
    'The busy assertion must run while the freshly-started scan is still known active.',
  );
});

test('album-details selection supports production prewarming without a click-time response', () => {
  const actions = read('tests/e2e/actions/galleryActions.js');
  const albumCard = read('tests/e2e/poms/albumCard.js');
  const methodStart = actions.indexOf('async selectAlbumDetailsByIdentityAndReadPayload(');
  const methodEnd = actions.indexOf('\n  albumCoverByName(', methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'Expected album-details selection helper.');
  const method = actions.slice(methodStart, methodEnd);

  assert.doesNotMatch(method, /waitForResponse/u);
  assert.match(method, /clickDetailsByIdentity/u);
  assert.match(method, /waitForOpenDetailsIdentity/u);
  assert.match(method, /page\.on\('response'/u);
  assert.match(method, /page\.request\.get/u);
  assert.match(method, /\/album-details\?album_key=/u);
  assert.match(method, /Album details identity mismatch/u);
  assert.match(
    albumCard,
    /waitForOpenDetailsIdentity[\s\S]*exactNormalizedText\(expectedTitle\)[\s\S]*trackModalTrackRowSelector/u,
    'The fallback must prove the exact clicked modal identity is fully loaded.',
  );
});

test('decoded gallery window ignores offscreen native-lazy cards until real traversal brings them into view', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/poms/galleryPage.js')).href;
  const { readDecodedProductionCardWindow } = await import(moduleUrl);
  class FakeElement {
    constructor(bounds = {}) {
      this.bounds = {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        ...bounds,
      };
    }

    getBoundingClientRect() { return this.bounds; }
  }
  class FakeImageElement extends FakeElement {
    constructor({ complete, naturalWidth, productionSrc, loading }) {
      super();
      this.complete = complete;
      this.naturalWidth = naturalWidth;
      this.attributes = new Map([
        ['data-production-cover-src', productionSrc],
        ['loading', loading],
      ]);
    }

    getAttribute(name) { return this.attributes.get(name) || ''; }
  }
  const card = (key, bounds, image) => ({
    getBoundingClientRect() { return bounds; },
    getAttribute(name) { return name === 'data-gallery-card-key' ? key : ''; },
    querySelector() { return image; },
  });
  const gallery = new FakeElement({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 });
  const visibleImage = new FakeImageElement({
    complete: true,
    naturalWidth: 480,
    productionSrc: '/cover?path=visible',
    loading: 'eager',
  });
  const offscreenLazyImage = new FakeImageElement({
    complete: false,
    naturalWidth: 0,
    productionSrc: '/cover?path=near',
    loading: 'lazy',
  });
  const cards = [
    card('visible', { left: 20, top: 20, right: 220, bottom: 320, width: 200, height: 300 }, visibleImage),
    card('near', { left: 20, top: 620, right: 220, bottom: 920, width: 200, height: 300 }, offscreenLazyImage),
  ];
  const originals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLImageElement: globalThis.HTMLImageElement,
    scheduler: globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__,
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLImageElement = FakeImageElement;
  globalThis.document = {
    querySelector(selector) { return selector === '#albums-scroll' ? gallery : null; },
    querySelectorAll(selector) { return selector === '.album-card' ? cards : []; },
  };
  globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ = {
    active: 0,
    queuedVisible: 0,
    queuedNear: 0,
    queuedBackground: 0,
  };
  const args = {
    cardSelector: '.album-card',
    coverImageSelector: '.cover img',
    galleryScrollSelector: '#albums-scroll',
  };
  try {
    assert.equal(readDecodedProductionCardWindow(args), true);
    assert.deepEqual(readDecodedProductionCardWindow({ ...args, snapshot: true }), {
      candidateCount: 1,
      decodedCards: [{ key: 'visible', productionSrc: '/cover?path=visible' }],
      schedulerSettled: true,
      terminalCount: 0,
    });
    globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ = {
      active: 2,
      activeForeground: 0,
      foregroundIdle: true,
      queuedVisible: 0,
      queuedNear: 0,
      queuedBackground: 10,
    };
    assert.equal(
      readDecodedProductionCardWindow(args),
      true,
      'background-only cover work must not block a settled visible card window',
    );
    visibleImage.complete = false;
    visibleImage.naturalWidth = 0;
    assert.equal(readDecodedProductionCardWindow(args), false, 'one positive intersecting candidate is required and must settle');
    cards[0].getBoundingClientRect = () => ({
      left: 20, top: 20, right: 20, bottom: 320, width: 0, height: 300,
    });
    assert.equal(readDecodedProductionCardWindow(args), false, 'zero-size cards cannot satisfy the visible candidate contract');
  } finally {
    if (originals.document === undefined) delete globalThis.document;
    else globalThis.document = originals.document;
    if (originals.HTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originals.HTMLElement;
    if (originals.HTMLImageElement === undefined) delete globalThis.HTMLImageElement;
    else globalThis.HTMLImageElement = originals.HTMLImageElement;
    if (originals.scheduler === undefined) delete globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__;
    else globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ = originals.scheduler;
  }

  const pom = read('tests/e2e/poms/galleryPage.js');
  const traversal = read('tests/e2e/actions/galleryActions.js');
  assert.match(pom, /cardBounds\.width > 0[\s\S]*entry\.key && entry\.productionSrc && entry\.intersects/);
  assert.match(pom, /windowState\.candidateCount > 0/);
  assert.match(traversal, /scrollGalleryBy\(deltaY\)[\s\S]*waitForGalleryScrollMovement/);
  assert.match(traversal, /page\.mouse\.wheel\(0, deltaY\)/);
});

test('decoded gallery window ignores terminal no-art cards while enforcing the required production-cover count', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/poms/galleryPage.js')).href;
  const { readDecodedProductionCardWindow } = await import(moduleUrl);
  class FakeElement {
    constructor(bounds = {}) {
      this.bounds = bounds;
    }

    getBoundingClientRect() { return this.bounds; }
  }
  class FakeImageElement extends FakeElement {
    constructor({ naturalWidth, productionSrc }) {
      super({});
      this.complete = true;
      this.naturalWidth = naturalWidth;
      this.productionSrc = productionSrc;
    }

    getAttribute(name) {
      return name === 'data-production-cover-src' ? this.productionSrc : '';
    }
  }
  const visibleBounds = {
    left: 20,
    top: 20,
    right: 220,
    bottom: 320,
    width: 200,
    height: 300,
  };
  const card = (key, image = null) => ({
    getBoundingClientRect() { return visibleBounds; },
    getAttribute(name) { return name === 'data-gallery-card-key' ? key : ''; },
    querySelector() { return image; },
  });
  const gallery = new FakeElement({
    left: 0,
    top: 0,
    right: 500,
    bottom: 500,
    width: 500,
    height: 500,
  });
  const firstDecodedCover = new FakeImageElement({
    naturalWidth: 480,
    productionSrc: '/cover?path=first',
  });
  const secondDecodedCover = new FakeImageElement({
    naturalWidth: 480,
    productionSrc: '/cover?path=second',
  });
  const cards = [
    card('first', firstDecodedCover),
    card('second', secondDecodedCover),
    card('legitimate-no-art'),
  ];
  const originals = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    HTMLImageElement: globalThis.HTMLImageElement,
    scheduler: globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__,
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.HTMLImageElement = FakeImageElement;
  globalThis.document = {
    querySelector(selector) { return selector === '#albums-scroll' ? gallery : null; },
    querySelectorAll(selector) { return selector === '.album-card' ? cards : []; },
  };
  globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ = {
    active: 0,
    queuedVisible: 0,
    queuedNear: 0,
    queuedBackground: 0,
  };
  const args = {
    cardSelector: '.album-card',
    coverImageSelector: '.cover img',
    galleryScrollSelector: '#albums-scroll',
    minimumDecodedCount: 2,
  };
  try {
    assert.equal(
      readDecodedProductionCardWindow(args),
      true,
      'a legitimate no-art card must not block two decoded production covers',
    );
    secondDecodedCover.naturalWidth = 0;
    assert.equal(
      readDecodedProductionCardWindow(args),
      false,
      'a terminal production-cover failure must not satisfy the required decoded-cover count',
    );
  } finally {
    if (originals.document === undefined) delete globalThis.document;
    else globalThis.document = originals.document;
    if (originals.HTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originals.HTMLElement;
    if (originals.HTMLImageElement === undefined) delete globalThis.HTMLImageElement;
    else globalThis.HTMLImageElement = originals.HTMLImageElement;
    if (originals.scheduler === undefined) delete globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__;
    else globalThis.__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__ = originals.scheduler;
  }
});

test('FTC-COVERS-014 ends visible-cover timing at decode before collecting visual evidence', () => {
  const searchActions = read('tests/e2e/actions/searchToolbarActions.js');
  const helper = read('tests/e2e/helpers/galleryCoverStabilityHelpers.js');
  const spec = read('tests/e2e/specs/galleryCoverStability.spec.js');
  const coverRuntime = read('music_app/static/js/runtime/modal-and-overlay-helpers.js');
  const submissionBoundary = searchActions.indexOf('options.recordSubmissionBoundary()');
  const enterSubmission = searchActions.indexOf("await this.searchToolbar.input.press('Enter')");
  const timerStart = spec.indexOf('visibleCoverStartedAt = await readPagePerformanceNow(page)');
  const searchSubmission = spec.indexOf("await searchToolbarActions.search('Joseph'");
  const nativeDecode = helper.indexOf('await element.decode()');
  const capturedDecodeBoundary = helper.indexOf("element.getAttribute('data-cover-decoded-at-ms')");
  const decodedBoundary = helper.indexOf('const decodedAtMs =');
  const bounds = helper.indexOf('await image.boundingBox()');
  const pixels = helper.indexOf('new OffscreenCanvas(64, 64)');
  const screenshot = helper.indexOf("await image.screenshot({ animations: 'disabled' })");

  assert.ok(submissionBoundary >= 0, 'the search action must expose the real user submission boundary');
  assert.ok(enterSubmission > submissionBoundary, 'timing must begin immediately before the real Enter submission');
  assert.ok(searchSubmission >= 0, 'the scenario must submit the Joseph search through the search action');
  assert.ok(timerStart > searchSubmission, 'the timer must be armed by the search submission callback');
  assert.ok(nativeDecode >= 0, 'the helper must wait for native decoded image readiness');
  assert.ok(capturedDecodeBoundary > nativeDecode, 'the helper must read the app-captured native decode boundary after verifying decode');
  assert.ok(decodedBoundary > capturedDecodeBoundary, 'the measured boundary must be selected from the captured decode timestamp');
  assert.ok(pixels > decodedBoundary, 'pixel evidence must remain after the native decode timestamp');
  assert.ok(bounds > pixels, 'bounding-box evidence must remain outside the native decode timer');
  assert.ok(screenshot > bounds, 'screenshot evidence must remain after decoded timing');
  assert.match(spec, /async recordSubmissionBoundary\(\)\s*\{\s*visibleCoverStartedAt = await readPagePerformanceNow\(page\);/);
  assert.match(spec, /startedAtMs: visibleCoverStartedAt/);
  assert.match(spec, /visibleCoverElapsedMs = baseline\.decodedElapsedMs/);
  assert.doesNotMatch(helper, /expect\.poll/);
  assert.match(spec, /VISIBLE_COVER_BUDGET = Object\.freeze\(\{ targetMaximum: 1000, graceMs: 200 \}\)/);
  assert.match(spec, /expectTimingBudget\([\s\S]*?visibleCoverElapsedMs,[\s\S]*?VISIBLE_COVER_BUDGET/);
  assert.match(spec, /formatTimingBudgetOutcome\('Visible Joseph cover', timingOutcome\)/);
  assert.match(helper, /visualState: element\.getAttribute\('data-cover-visual-state'\)/);
  assert.match(coverRuntime, /imageElement\.decode\(\)/);
  assert.match(coverRuntime, /data-cover-decoded-at-ms/);
  assert.match(coverRuntime, /performance\.now\(\)/);
  assert.match(helper, /capturedDecodedAtMs/);
  assert.match(helper, /capturedDecodedAtMs\s*>=\s*Number\(startedAtMs\)/);
  assert.match(helper, /visibility: getComputedStyle\(element\)\.visibility/);
  assert.match(helper, /expectAlbumCardCoverPresentationReady/);
  assert.match(spec, /expectAlbumCardCoverPresentationReady\(expect, baseline\)/);
  assert.match(
    helper,
    /JOSEPH_PREVIEW_RESPONSE_HASH = '84b7ef18d9c825fcedfb872a40835b7d9667f497936b0ad2ba526ff096531568'/,
  );
  assert.doesNotMatch(
    helper,
    /18b5b37bf116826dfe9f2fafd64ee6338e2128b907e0d6c9ce42cad94c8a10a3/,
  );
  assert.match(
    spec,
    /const baselineResponse = await coverTraffic\.waitForResponse\(baseline\.productionSrc\);\s*expectJosephCoverRouteResponse\(expect, baselineResponse\);/,
  );
  assert.doesNotMatch(spec, /page\.(?:route|evaluate|addInitScript|setContent)\s*\(/);
});

test('gallery placeholder readiness requires a named intentional no-art scenario', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const actions = new GalleryActions({});

  await assert.rejects(
    actions.waitForVisibleGalleryCoversLoaded({ allowPlaceholder: true }),
    /named placeholderScenario/,
  );

  const realAppSources = [
    'tests/e2e/helpers/utilityPerformanceHelpers.js',
    'tests/e2e/helpers/realAppBenchmarkHelpers.js',
    'tests/e2e/helpers/appOpenAllArtistsHelpers.js',
    'tests/e2e/helpers/allArtistsResponsivenessHelpers.js',
    ...fs.readdirSync(path.join(repoRoot, 'tests/e2e/syntheticLargeLibrary'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `tests/e2e/syntheticLargeLibrary/${name}`),
  ];
  for (const relativePath of realAppSources) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /allowPlaceholder\s*:\s*true/, relativePath);
    assert.doesNotMatch(source, /requireLocalImage\s*:\s*false/, relativePath);
  }
});

test('gallery scrolling uses Playwright input instead of evaluated DOM mutation', () => {
  const gallery = read('tests/e2e/actions/galleryActions.js');

  assert.match(gallery, /scrollIntoViewIfNeeded\(\)/);
  assert.match(gallery, /page\.mouse\.wheel\(0, deltaY\)/);
  assert.doesNotMatch(gallery, /scrollTop\s*=/);
  assert.doesNotMatch(gallery, /\.scrollIntoView\s*\(/);
});

test('gallery scroll movement waits for the matching production virtual-grid render', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/poms/galleryPage.js')).href;
  const { hasSettledVirtualGalleryRender } = await import(moduleUrl);
  class FakeElement {}
  const gallery = new FakeElement();
  gallery.scrollTop = 480;
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalDiagnostics = globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
  globalThis.HTMLElement = FakeElement;
  globalThis.document = {
    querySelector(selector) {
      assert.equal(selector, '#albums-scroll');
      return gallery;
    },
  };
  globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ = {
    latestScroll: {
      renderGeneration: 4,
      renderRafOwner: 12,
      scrollTop: 480,
    },
    latestRender: {
      renderGeneration: 4,
      renderRafOwner: 11,
      viewportTop: 480,
    },
  };

  try {
    const probe = {
      expectedDirection: 1,
      galleryScrollSelector: '#albums-scroll',
      priorPosition: 0,
    };
    assert.equal(
      hasSettledVirtualGalleryRender(probe),
      false,
      'Scroll movement alone must not release traversal before its render frame.',
    );
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestRender.renderRafOwner = 12;
    assert.equal(
      hasSettledVirtualGalleryRender(probe),
      true,
      'The matching render owner and viewport release the next locator read.',
    );
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
    if (originalDiagnostics === undefined) delete globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
    else globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ = originalDiagnostics;
  }
});

test('mounted gallery checkpoints wait for the final unchanged virtual-grid measurement', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/poms/galleryPage.js')).href;
  const { hasSettledVirtualGalleryMeasurement } = await import(moduleUrl);
  class FakeElement {}
  const gallery = new FakeElement();
  Object.assign(gallery, { scrollTop: 480 });
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalDiagnostics = globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
  globalThis.HTMLElement = FakeElement;
  globalThis.document = {
    querySelector(selector) {
      assert.equal(selector, '#albums-scroll');
      return gallery;
    },
  };
  globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ = {
    latestScroll: { renderGeneration: 4, renderRafOwner: 12, scrollTop: 480 },
    latestRender: { renderGeneration: 4, renderRafOwner: 12, viewportTop: 480 },
    latestMeasurement: { changed: true, renderGeneration: 4, scrollTop: 480 },
  };

  try {
    assert.equal(
      hasSettledVirtualGalleryMeasurement({ galleryScrollSelector: '#albums-scroll' }),
      false,
      'A measurement that changed row geometry still has stabilization work to finish.',
    );
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestMeasurement.changed = false;
    assert.equal(
      hasSettledVirtualGalleryMeasurement({ galleryScrollSelector: '#albums-scroll' }),
      true,
      'The checkpoint settles only after an unchanged measurement matches the rendered viewport.',
    );
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
    if (originalDiagnostics === undefined) delete globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
    else globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ = originalDiagnostics;
  }
});

test('gallery scroll boundary settles only with current matching virtual-grid diagnostics', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/poms/galleryPage.js')).href;
  const { hasSettledVirtualGalleryRender } = await import(moduleUrl);
  class FakeElement {}
  const gallery = new FakeElement();
  Object.assign(gallery, {
    clientHeight: 600,
    scrollHeight: 1800,
    scrollTop: 1200,
  });
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  const originalDiagnostics = globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
  globalThis.HTMLElement = FakeElement;
  globalThis.document = {
    querySelector(selector) {
      assert.equal(selector, '#albums-scroll');
      return gallery;
    },
  };
  globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ = {
    latestScroll: {
      renderGeneration: 7,
      renderRafOwner: 21,
      scrollTop: 1200,
    },
    latestRender: {
      renderGeneration: 7,
      renderRafOwner: 20,
      viewportTop: 1200,
    },
  };

  try {
    const downBoundaryProbe = {
      expectedDirection: 1,
      galleryScrollSelector: '#albums-scroll',
      priorPosition: 1200,
    };
    assert.equal(
      hasSettledVirtualGalleryRender(downBoundaryProbe),
      false,
      'A boundary must not settle while the render owner is stale.',
    );
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestRender.renderRafOwner = 21;
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestRender.renderGeneration = 6;
    assert.equal(
      hasSettledVirtualGalleryRender(downBoundaryProbe),
      false,
      'A boundary must not settle across render generations.',
    );
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestRender.renderGeneration = 7;
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestScroll.scrollTop = 1190;
    assert.equal(
      hasSettledVirtualGalleryRender(downBoundaryProbe),
      false,
      'A boundary must not settle with a stale scroll diagnostic.',
    );
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestScroll.scrollTop = 1200;
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestRender.viewportTop = 1190;
    assert.equal(
      hasSettledVirtualGalleryRender(downBoundaryProbe),
      false,
      'A boundary must not settle with a stale rendered viewport.',
    );
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestRender.viewportTop = 1200;
    assert.equal(
      hasSettledVirtualGalleryRender(downBoundaryProbe),
      true,
      'The live lower boundary settles once its diagnostics fully match.',
    );

    gallery.scrollTop = 0;
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestScroll.scrollTop = 0;
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__.latestRender.viewportTop = 0;
    assert.equal(
      hasSettledVirtualGalleryRender({ ...downBoundaryProbe, expectedDirection: -1, priorPosition: 0 }),
      true,
      'The live upper boundary follows the same settled diagnostic contract.',
    );
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
    if (originalDiagnostics === undefined) delete globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__;
    else globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ = originalDiagnostics;
  }
});

test('decoded gallery traversal settles the current virtual window before every wheel step', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const events = [];
  const settledWindows = [
    { decodedCards: [{ key: 'album-a', productionSrc: '/cover/a' }] },
    { decodedCards: [{ key: 'album-b', productionSrc: '/cover/b' }] },
  ];
  const actions = new GalleryActions({
    async waitForDecodedProductionCardWindow() {
      const windowState = settledWindows.shift();
      events.push(`settled:${windowState.decodedCards[0].key}`);
      return windowState;
    },
    async waitForGalleryScrollMovement() {
      events.push('moved');
    },
  });
  actions.readGalleryScrollState = async () => ({
    clientHeight: 600,
    maxScrollTop: 1200,
    scrollTop: 0,
  });
  actions.scrollGalleryBy = async (deltaY) => events.push(`wheel:${deltaY}`);

  const observed = await actions.traverseDistinctDecodedGalleryCards(2);

  assert.deepEqual(observed.map((entry) => entry.key), ['album-a', 'album-b']);
  assert.deepEqual(events, ['settled:album-a', 'wheel:420', 'moved', 'settled:album-b']);
  const gallery = read('tests/e2e/actions/galleryActions.js');
  const traversalStart = gallery.indexOf('async traverseDistinctDecodedGalleryCards');
  const traversalEnd = gallery.indexOf('\n  async waitForCoverSchedulerIdle', traversalStart);
  const traversal = gallery.slice(traversalStart, traversalEnd);
  assert.match(traversal, /waitForDecodedProductionCardWindow/);
  assert.match(traversal, /waitForGalleryScrollMovement/);
  assert.doesNotMatch(traversal, /waitForTimeout/);
});

test('mounted gallery continuity checkpoint settles the visible production card window after scrolling', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const events = [];
  const actions = new GalleryActions({
    async waitForDecodedProductionCardWindow(options) {
      events.push({ action: 'settled-production-window', options });
      return {
        candidateCount: 3,
        decodedCards: [
          { key: 'album-a', productionSrc: '/cover/a' },
          { key: 'album-b', productionSrc: '/cover/b' },
          { key: 'album-c', productionSrc: '/cover/c' },
        ],
        schedulerSettled: true,
        terminalCount: 0,
      };
    },
    async waitForVirtualGalleryMeasurementSettled(options) {
      events.push({ action: 'virtual-grid-measurement-settled', options });
    },
  });
  actions.scrollGalleryToMiddle = async () => events.push({ action: 'scroll-middle' });
  actions.waitForVisibleGalleryCoversLoaded = async (options) => {
    events.push({ action: 'minimum-visible-covers', options });
  };
  actions.readGalleryScrollState = async () => {
    events.push({ action: 'read-scroll' });
    return { maxScrollTop: 2400, scrollTop: 1200 };
  };

  const checkpoint = await actions.prepareMountedGalleryContinuityCheckpoint({
    minimumDecodedCovers: 2,
  });

  assert.deepEqual(events, [
    { action: 'scroll-middle' },
    {
      action: 'settled-production-window',
      options: { minimumDecodedCount: 2, timeout: 60000 },
    },
    { action: 'virtual-grid-measurement-settled', options: { timeout: 60000 } },
    { action: 'read-scroll' },
  ]);
  assert.deepEqual(checkpoint, {
    decodedCoverCount: 2,
    maxScrollTop: 2400,
    scrollTop: 1200,
  });
});

test('decoded gallery traversal continues past its requested count until a settled target eviction', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const events = [];
  const settledWindows = [
    { decodedCards: [
      { key: 'new-album-a', productionSrc: '/cover/new-a' },
      { key: 'new-album-b', productionSrc: '/cover/new-b' },
    ] },
    { decodedCards: [
      { key: 'later-album-a', productionSrc: '/cover/later-a' },
      { key: 'later-album-b', productionSrc: '/cover/later-b' },
    ] },
  ];
  const targetCacheStates = [true, false];
  const actions = new GalleryActions({
    async waitForDecodedProductionCardWindow() {
      const windowState = settledWindows.shift();
      events.push(`settled:${windowState.decodedCards.map((entry) => entry.key).join(',')}`);
      return windowState;
    },
    async waitForGalleryScrollMovement() {
      events.push('moved');
    },
    async waitForCoverSchedulerIdle() {
      events.push('scheduler-idle');
    },
    async readCoverCacheState(productionUrl) {
      const active = targetCacheStates.shift();
      events.push(`cache:${productionUrl}:${active ? 'active' : 'inactive'}`);
      return { active };
    },
  });
  actions.readGalleryScrollState = async () => ({
    clientHeight: 600,
    maxScrollTop: 1200,
    scrollTop: 0,
  });
  actions.scrollGalleryBy = async (deltaY) => events.push(`wheel:${deltaY}`);

  const observed = await actions.traverseDistinctDecodedGalleryCards(2, {
    untilCoverEvicted: '/cover/retained',
  });

  assert.deepEqual(observed, [
    { key: 'new-album-a', productionSrc: '/cover/new-a' },
    { key: 'new-album-b', productionSrc: '/cover/new-b' },
  ]);
  assert.deepEqual(events, [
    'settled:new-album-a,new-album-b',
    'scheduler-idle',
    'cache:/cover/retained:active',
    'wheel:420',
    'moved',
    'settled:later-album-a,later-album-b',
    'scheduler-idle',
    'cache:/cover/retained:inactive',
  ]);
});

test('decoded gallery traversal fails at max steps while its settled eviction target remains active', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const events = [];
  const settledWindows = ['album-a', 'album-b'].map((key) => ({
    decodedCards: [{ key, productionSrc: `/cover/${key}` }],
  }));
  const actions = new GalleryActions({
    async waitForDecodedProductionCardWindow() {
      const windowState = settledWindows.shift();
      events.push(`settled:${windowState.decodedCards[0].key}`);
      return windowState;
    },
    async waitForGalleryScrollMovement() {
      events.push('moved');
    },
    async waitForCoverSchedulerIdle() {
      events.push('scheduler-idle');
    },
    async readCoverCacheState(productionUrl) {
      events.push(`cache:${productionUrl}:active`);
      return { active: true };
    },
  });
  actions.readGalleryScrollState = async () => ({
    clientHeight: 600,
    maxScrollTop: 1200,
    scrollTop: 0,
  });
  actions.scrollGalleryBy = async (deltaY) => events.push(`wheel:${deltaY}`);

  await assert.rejects(actions.traverseDistinctDecodedGalleryCards(1, {
    maxSteps: 2,
    untilCoverEvicted: '/cover/retained',
  }));
  assert.deepEqual(events, [
    'settled:album-a',
    'scheduler-idle',
    'cache:/cover/retained:active',
    'wheel:420',
    'moved',
    'settled:album-b',
    'scheduler-idle',
    'cache:/cover/retained:active',
  ]);
});

test('decoded gallery traversal bounds a final viewport batch overshoot to the requested insertion-order count', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const entry = (index) => ({ key: `album-${index}`, productionSrc: `/cover/${index}` });
  const settledWindows = [
    { decodedCards: Array.from({ length: 46 }, (_value, index) => entry(index)) },
    { decodedCards: Array.from({ length: 6 }, (_value, index) => entry(index + 46)) },
  ];
  const wheelDeltas = [];
  const actions = new GalleryActions({
    async waitForDecodedProductionCardWindow() { return settledWindows.shift(); },
    async waitForGalleryScrollMovement() {},
  });
  actions.readGalleryScrollState = async () => ({
    clientHeight: 600,
    maxScrollTop: 1200,
    scrollTop: 0,
  });
  actions.scrollGalleryBy = async (deltaY) => wheelDeltas.push(deltaY);

  const observed = await actions.traverseDistinctDecodedGalleryCards(48);

  assert.equal(observed.length, 48);
  assert.equal(new Set(observed.map((item) => item.key)).size, 48);
  assert.deepEqual(observed.map((item) => item.key), Array.from({ length: 48 }, (_value, index) => `album-${index}`));
  assert.deepEqual(wheelDeltas, [420]);
});

test('decoded gallery traversal still fails when two bounded windows remain below 48 unique cards', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const entry = (index) => ({ key: `short-${index}`, productionSrc: `/cover/short-${index}` });
  const settledWindows = [
    { decodedCards: Array.from({ length: 46 }, (_value, index) => entry(index)) },
    { decodedCards: [entry(46)] },
  ];
  const actions = new GalleryActions({
    async waitForDecodedProductionCardWindow() { return settledWindows.shift(); },
    async waitForGalleryScrollMovement() {},
  });
  actions.readGalleryScrollState = async () => ({
    clientHeight: 600,
    maxScrollTop: 1200,
    scrollTop: 0,
  });
  actions.scrollGalleryBy = async () => {};

  await assert.rejects(
    actions.traverseDistinctDecodedGalleryCards(48, { maxSteps: 2 }),
    /Expected 48 distinct decoded gallery cards, observed 47 after 2 settled virtual windows \(max 2\)/,
  );
});

test('decoded gallery traversal settles the bottom window then reverses through missed windows', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const events = [];
  const settledWindows = ['album-a', 'album-b', 'album-c'].map((key) => ({
    decodedCards: [{ key, productionSrc: `/cover/${key}` }],
  }));
  const scrollStates = [
    { clientHeight: 600, maxScrollTop: 1200, scrollTop: 0 },
    { clientHeight: 600, maxScrollTop: 1200, scrollTop: 1200 },
  ];
  const actions = new GalleryActions({
    async waitForDecodedProductionCardWindow() {
      const windowState = settledWindows.shift();
      events.push(`settled:${windowState.decodedCards[0].key}`);
      return windowState;
    },
    async waitForGalleryScrollMovement(previousScrollTop, direction) {
      events.push(`moved:${previousScrollTop}:${direction}`);
    },
  });
  actions.readGalleryScrollState = async () => scrollStates.shift();
  actions.scrollGalleryBy = async (deltaY) => events.push(`wheel:${deltaY}`);

  const observed = await actions.traverseDistinctDecodedGalleryCards(3);

  assert.deepEqual(observed.map((entry) => entry.key), ['album-a', 'album-b', 'album-c']);
  assert.deepEqual(events, [
    'settled:album-a',
    'wheel:420',
    'moved:0:1',
    'settled:album-b',
    'wheel:-420',
    'moved:1200:-1',
    'settled:album-c',
  ]);
});

test('decoded gallery traversal honors its settled-window bound and fails loudly', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  let settledWindowCount = 0;
  const wheelDeltas = [];
  const actions = new GalleryActions({
    async waitForDecodedProductionCardWindow() {
      settledWindowCount += 1;
      return { decodedCards: [{ key: 'same-album', productionSrc: '/cover/same' }] };
    },
    async waitForGalleryScrollMovement() {},
  });
  actions.readGalleryScrollState = async () => ({
    clientHeight: 600,
    maxScrollTop: 1200,
    scrollTop: 0,
  });
  actions.scrollGalleryBy = async (deltaY) => wheelDeltas.push(deltaY);

  await assert.rejects(
    actions.traverseDistinctDecodedGalleryCards(3, { maxSteps: 2 }),
    /Expected 3 distinct decoded gallery cards, observed 1 after 2 settled virtual windows \(max 2\); bottom reverse not reached\./,
  );
  assert.equal(settledWindowCount, 2);
  assert.deepEqual(wheelDeltas, [420]);
});

test('gallery cover scroll-away chooses a direction that moves from either boundary', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { planGalleryScrollAway } = await import(moduleUrl);
  const clampScroll = (scrollTop, deltaY, maxScrollTop) => (
    Math.min(maxScrollTop, Math.max(0, scrollTop + deltaY))
  );

  const fromTop = planGalleryScrollAway({ scrollTop: 0, maxScrollTop: 1200, clientHeight: 600 });
  assert.equal(fromTop.direction, 1);
  assert.ok(fromTop.deltaY > 0);
  assert.ok(clampScroll(0, fromTop.deltaY, 1200) >= fromTop.minimumScrollDelta);
  assert.ok(clampScroll(0, -10000, 1200) < fromTop.minimumScrollDelta,
    'the former fixed upward scroll must fail because it cannot move a gallery already at the top');

  const fromBottom = planGalleryScrollAway({ scrollTop: 1200, maxScrollTop: 1200, clientHeight: 600 });
  assert.equal(fromBottom.direction, -1);
  assert.ok(fromBottom.deltaY < 0);
  assert.ok(1200 - clampScroll(1200, fromBottom.deltaY, 1200) >= fromBottom.minimumScrollDelta);

  const gallery = read('tests/e2e/actions/galleryActions.js');
  const spec = read('tests/e2e/specs/galleryCoverStability.spec.js');
  assert.match(
    spec,
    /waitForSelectedArtistGallery\(ARTIST\);[\s\S]{0,200}waitForCoverSchedulerIdle\(\{ timeout: 30000 \}\);[\s\S]{0,200}await galleryActions\.scrollToAlbumUnderHeading\(ARTIST, ALBUM\);\s*const awayState = await galleryActions\.scrollAlbumAwayFromViewport\(ARTIST, ALBUM\)/,
  );
  assert.doesNotMatch(
    spec,
    /waitForQuery\('\'\);[\s\S]{0,200}waitForAlbumVisibleUnderHeading\(ARTIST, ALBUM\);[\s\S]{0,200}waitForCoverSchedulerIdle/,
  );
  assert.match(spec, /traverseDistinctDecodedGalleryCards\(48/);
  assert.match(spec, /excludeKeys:\s*\[baselineAlbumKey\]/);
  assert.match(spec, /untilCoverEvicted:\s*baseline\.productionSrc/);
  assert.match(spec, /readCoverCacheState\(baseline\.productionSrc\)/);
  assert.match(spec, /expect\(cacheState\.active\)\.toBe\(false\)/);
  assert.match(spec, /expect\(cacheState\.activeCount\)\.toBe\(48\)/);
  assert.match(spec, /waitForCoverSchedulerIdle/);
  assert.match(spec, /isSameAlbumCardHandle\(baselineCardHandle, ALBUM\)/);
  assert.match(spec, /coverTraffic\.requestCount\(baseline\.productionSrc\)/);
  assert.match(spec, /coverTraffic\.responseCount\(baseline\.productionSrc\)/);
  assert.doesNotMatch(spec, /scrollGalleryBy\(-10000\)/);
  assert.match(gallery, /direction: -Number\(awayState\.direction \|\| 1\)/);
  assert.match(gallery, /waitAtBoundary: true/);
});

test('gallery album scroll uses directional wheel input when an attached virtual card stays offscreen', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const targetLookups = [];
  const wheelDeltas = [];
  const movementWaits = [];
  const viewportReads = [];
  const viewportStates = [
    {
      attached: true,
      detached: false,
      intersects: false,
      offscreen: true,
      scrollDirection: 1,
    },
    {
      attached: true,
      detached: false,
      intersects: true,
      offscreen: false,
      scrollDirection: 0,
    },
  ];
  const actions = new GalleryActions({
    page: {
      mouse: { wheel: async () => { throw new Error('use the action scroll seam'); } },
    },
    async waitForGalleryScrollMovement(previousScrollTop, direction) {
      movementWaits.push([previousScrollTop, direction]);
    },
    sectionByArtistHeading() {
      const targetVersion = targetLookups.length + 1;
      targetLookups.push(targetVersion);
      return {
        getByRole() {
          return {
            first() {
              return {
                async count() { return 1; },
              };
            },
          };
        },
      };
    },
  });
  actions.waitForAlbumVisibleUnderHeading = async () => {};
  actions.readGalleryScrollState = async () => ({
    scrollTop: 120,
    clientHeight: 600,
    maxScrollTop: 1800,
  });
  actions.scrollGalleryBy = async (deltaY) => wheelDeltas.push(deltaY);
  actions.readAlbumGalleryViewportState = async (artistName, albumName) => {
    viewportReads.push([artistName, albumName]);
    return viewportStates.shift();
  };

  await actions.scrollToAlbumUnderHeading('Neal Morse', 'Joseph: Part One - The Dreamer', {
    maxAttempts: 2,
  });

  assert.equal(viewportReads.length, 2);
  assert.deepEqual(viewportReads[1], ['Neal Morse', 'Joseph: Part One - The Dreamer']);
  assert.deepEqual(targetLookups, [1]);
  assert.deepEqual(wheelDeltas, [450]);
  assert.deepEqual(movementWaits, [[120, 1]]);
});

test('gallery target viewport snapshot returns detached immediately without locator waits', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/poms/galleryPage.js')).href;
  const { GalleryPage } = await import(moduleUrl);
  let evaluateAllCalls = 0;
  const neverSettles = () => new Promise(() => {});
  const galleryPage = Object.create(GalleryPage.prototype);
  galleryPage.albumCard = {
    cardsByArtistAndAlbum(artistName, albumName) {
      assert.equal(artistName, 'Metallica');
      assert.equal(albumName, "Kill 'Em All");
      return {
        count: neverSettles,
        boundingBox: neverSettles,
        async evaluateAll(callback, args) {
          evaluateAllCalls += 1;
          return callback([], args);
        },
      };
    },
  };

  let timeoutId;
  try {
    const state = await Promise.race([
      galleryPage.readAlbumGalleryViewportState('Metallica', "Kill 'Em All"),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Atomic detached viewport snapshot waited on a locator.')),
          100,
        );
      }),
    ]);
    assert.deepEqual(state, {
      attached: false,
      detached: true,
      intersects: false,
      offscreen: true,
      scrollDirection: 0,
    });
    assert.equal(evaluateAllCalls, 1);
  } finally {
    clearTimeout(timeoutId);
  }
});

test('gallery target viewport snapshot measures attached card and stable gallery bounds atomically', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/poms/galleryPage.js')).href;
  const { GalleryPage } = await import(moduleUrl);
  class FakeElement {
    constructor(bounds) {
      this.bounds = bounds;
    }

    getBoundingClientRect() {
      return this.bounds;
    }
  }
  const gallery = new FakeElement({
    left: 0,
    top: 0,
    right: 600,
    bottom: 500,
    width: 600,
    height: 500,
  });
  const card = new FakeElement({
    left: 40,
    top: 80,
    right: 280,
    bottom: 400,
    width: 240,
    height: 320,
  });
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  let evaluateAllCalls = 0;
  const galleryPage = Object.create(GalleryPage.prototype);
  galleryPage.albumCard = {
    cardsByArtistAndAlbum() {
      return {
        async evaluateAll(callback, args) {
          evaluateAllCalls += 1;
          return callback([card], args);
        },
      };
    },
  };
  globalThis.HTMLElement = FakeElement;
  globalThis.document = {
    querySelector(selector) {
      assert.equal(selector, '#albums-scroll');
      return gallery;
    },
  };

  try {
    assert.deepEqual(
      await galleryPage.readAlbumGalleryViewportState('Metallica', "Kill 'Em All"),
      {
        attached: true,
        detached: false,
        intersects: true,
        offscreen: false,
        scrollDirection: 0,
      },
    );
    assert.equal(evaluateAllCalls, 1);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = originalHTMLElement;
  }

  const pom = read('tests/e2e/poms/galleryPage.js');
  const actions = read('tests/e2e/actions/galleryActions.js');
  assert.match(
    pom,
    /const cards = year[\s\S]*cardByIdentity\(artistName, albumName, year\)[\s\S]*cardsByArtistAndAlbum\(artistName, albumName\)[\s\S]*return cards\.evaluateAll/,
  );
  assert.match(
    actions,
    /galleryPage\.readAlbumGalleryViewportState\(artistName, albumName, options\)/,
  );
});

test('gallery album scroll accepts a target that intersects after the final attached-card wheel step', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const wheelDeltas = [];
  const movementWaits = [];
  let targetLookups = 0;
  let viewportReads = 0;
  const actions = new GalleryActions({
    async waitForGalleryScrollMovement(previousScrollTop, direction) {
      movementWaits.push([previousScrollTop, direction]);
    },
    sectionByArtistHeading() {
      targetLookups += 1;
      return {
        getByRole() {
          return {
            first() {
              return {
                async count() { return targetLookups === 16 ? 1 : 0; },
              };
            },
          };
        },
      };
    },
  });
  actions.readGalleryScrollState = async () => ({
    scrollTop: 1000,
    clientHeight: 736,
    maxScrollTop: 100000,
  });
  actions.scrollGalleryBy = async (deltaY) => wheelDeltas.push(deltaY);
  actions.readAlbumGalleryViewportState = async () => {
    viewportReads += 1;
    if (viewportReads === 1) {
      return {
        attached: true,
        detached: false,
        intersects: false,
        offscreen: true,
        scrollDirection: -1,
      };
    }
    return {
      attached: true,
      detached: false,
      intersects: true,
      offscreen: false,
      scrollDirection: 0,
    };
  };

  await actions.scrollToAlbumUnderHeading('Mastodon', 'Crack The Skye', {
    maxAttempts: 16,
  });

  assert.equal(targetLookups, 16);
  assert.equal(viewportReads, 2);
  assert.deepEqual(wheelDeltas, [
    ...Array.from({ length: 15 }, () => 552),
    -552,
  ]);
  assert.deepEqual(movementWaits, [
    ...Array.from({ length: 15 }, () => [1000, 1]),
    [1000, -1],
  ]);
});

test('gallery album scroll observes an exact target after the final explicit wheel action', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const wheelDeltas = [];
  const movementWaits = [];
  let scrollTop = 0;
  let targetLookups = 0;
  const actions = new GalleryActions({
    async waitForGalleryScrollMovement(previousScrollTop, direction) {
      movementWaits.push([previousScrollTop, direction]);
    },
    sectionByArtistHeading() {
      targetLookups += 1;
      return {
        getByRole(role, options) {
          assert.equal(role, 'button');
          assert.deepEqual(options, { name: 'Crack The Skye', exact: true });
          return {
            first() {
              return {
                async count() { return targetLookups === 3 ? 1 : 0; },
              };
            },
          };
        },
      };
    },
  });
  actions.readGalleryScrollState = async () => ({
    scrollTop,
    clientHeight: 600,
    maxScrollTop: 9000,
  });
  actions.scrollGalleryBy = async (deltaY) => {
    wheelDeltas.push(deltaY);
    scrollTop += deltaY;
  };
  actions.readAlbumGalleryViewportState = async () => ({
    attached: true,
    detached: false,
    intersects: true,
    offscreen: false,
    scrollDirection: 0,
  });

  await actions.scrollToAlbumUnderHeading('Mastodon', 'Crack The Skye', {
    maxAttempts: 2,
  });

  assert.equal(targetLookups, 3);
  assert.deepEqual(wheelDeltas, [450, 450]);
  assert.deepEqual(movementWaits, [[0, 1], [450, 1]]);
});

test('gallery album scroll reaches an exact target beyond sixteen virtual windows', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const wheelDeltas = [];
  const movementWaits = [];
  let scrollTop = 0;
  let targetLookups = 0;
  const actions = new GalleryActions({
    async waitForGalleryScrollMovement(previousScrollTop, direction) {
      movementWaits.push([previousScrollTop, direction]);
      assert.ok(scrollTop > previousScrollTop);
    },
    sectionByArtistHeading() {
      targetLookups += 1;
      return {
        getByRole(role, options) {
          assert.equal(role, 'button');
          assert.deepEqual(options, { name: 'Crack The Skye', exact: true });
          return {
            first() {
              return {
                async count() { return targetLookups >= 18 ? 1 : 0; },
              };
            },
          };
        },
      };
    },
  });
  actions.readGalleryScrollState = async () => ({
    scrollTop,
    clientHeight: 600,
    maxScrollTop: 9000,
  });
  actions.scrollGalleryBy = async (deltaY) => {
    wheelDeltas.push(deltaY);
    scrollTop = Math.min(9000, scrollTop + deltaY);
  };
  actions.readAlbumGalleryViewportState = async () => ({
    attached: true,
    detached: false,
    intersects: true,
    offscreen: false,
    scrollDirection: 0,
  });

  await actions.scrollToAlbumUnderHeading('Mastodon', 'Crack The Skye');

  assert.equal(targetLookups, 18);
  assert.deepEqual(wheelDeltas, Array.from({ length: 17 }, () => 450));
  assert.deepEqual(
    movementWaits,
    Array.from({ length: 17 }, (_, index) => [index * 450, 1]),
  );
});

test('gallery album scroll stops after exhausting the measured scroll boundary', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const wheelDeltas = [];
  const movementWaits = [];
  let scrollTop = 0;
  let targetLookups = 0;
  const actions = new GalleryActions({
    async waitForGalleryScrollMovement(previousScrollTop, direction) {
      movementWaits.push([previousScrollTop, direction]);
      assert.ok(scrollTop > previousScrollTop);
    },
    sectionByArtistHeading() {
      targetLookups += 1;
      return {
        getByRole() {
          return { first: () => ({ async count() { return 0; } }) };
        },
      };
    },
  });
  actions.readGalleryScrollState = async () => ({
    scrollTop,
    clientHeight: 600,
    maxScrollTop: 1350,
  });
  actions.scrollGalleryBy = async (deltaY) => {
    wheelDeltas.push(deltaY);
    scrollTop = Math.min(1350, scrollTop + deltaY);
  };

  await assert.rejects(
    actions.scrollToAlbumUnderHeading('Missing Artist', 'Missing Album'),
    /after scrolling the gallery/,
  );

  assert.deepEqual(wheelDeltas, [450, 450, 450]);
  assert.deepEqual(movementWaits, [[0, 1], [450, 1], [900, 1]]);
  assert.equal(targetLookups, 4, 'the helper re-queries after the final settled wheel before testing the boundary');
  assert.equal(scrollTop, 1350);
});

test('gallery album scroll fails after bounded attempts while an attached target stays non-intersecting', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const wheelDeltas = [];
  let viewportReads = 0;
  const target = {
    async count() { return 1; },
  };
  const actions = new GalleryActions({
    async waitForGalleryScrollMovement() {},
    sectionByArtistHeading() {
      return { getByRole: () => ({ first: () => target }) };
    },
  });
  actions.waitForAlbumVisibleUnderHeading = async () => {};
  actions.readGalleryScrollState = async () => ({
    scrollTop: 120,
    clientHeight: 600,
    maxScrollTop: 1800,
  });
  actions.scrollGalleryBy = async (deltaY) => wheelDeltas.push(deltaY);
  actions.readAlbumGalleryViewportState = async () => {
    viewportReads += 1;
    return {
      attached: true,
      detached: false,
      intersects: false,
      offscreen: true,
      scrollDirection: 1,
    };
  };

  await assert.rejects(actions.scrollToAlbumUnderHeading(
    'Neal Morse',
    'Joseph: Part One - The Dreamer',
    { maxAttempts: 2 },
  ));
  assert.deepEqual(wheelDeltas, [450, 450]);
  assert.equal(viewportReads, 5, 'the helper observes the exact target once more after the final wheel action');
});

test('exact album selection delegates one retrying Playwright click to the identity-card POM', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const selected = [];
  const actions = new GalleryActions({
    albumCard: {
      async clickDetailsByIdentity(artist, album, year) {
        selected.push([artist, album, year]);
      },
    },
  });
  actions.scrollToAlbumUnderHeading = async () => {};

  const identity = await actions.selectAlbumDetailsByIdentity({
    artist: 'Mastodon',
    album: 'Crack The Skye',
    year: '2009',
  });

  assert.deepEqual(selected, [['Mastodon', 'Crack The Skye', '2009']]);
  assert.deepEqual(identity, {
    artist: 'Mastodon',
    album: 'Crack The Skye',
    year: '2009',
  });

  const albumCard = read('tests/e2e/poms/albumCard.js');
  assert.match(
    albumCard,
    /clickDetailsByIdentity\(artistName, albumName, year\)[\s\S]*?const card = this\.cardByIdentity\(artistName, albumName, year, \{ visible: true \}\)[\s\S]*?card\.locator\(this\.detailsButtonWithinCardSelector\)\.click\(\)/,
  );
});

test('exact album payload selection retries a swallowed click when prewarming starts the request', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const pageEvents = new EventEmitter();
  const requestKey = 'fixture-mastodon-crack-the-skye-2009';
  let clickCount = 0;
  let modalOpen = false;
  const request = {
    method: () => 'GET',
    url: () => `http://127.0.0.1:8000/album-details?album_key=${requestKey}`,
  };
  const response = {
    request() {
      return request;
    },
    url() {
      return `http://127.0.0.1:8000/album-details?album_key=${requestKey}`;
    },
    async json() {
      return {
        ok: true,
        album: {
          album_artist: 'Mastodon',
          name: 'Crack The Skye',
          year: '2009',
        },
      };
    },
    ok() { return true; },
    status() { return 200; },
  };
  const actions = new GalleryActions({
    page: {
      on: pageEvents.on.bind(pageEvents),
      off: pageEvents.off.bind(pageEvents),
      request: {
        async get() {
          throw new Error('The observed production response should be used.');
        },
      },
    },
    albumCard: {
      async readRequestKeyByIdentity() { return requestKey; },
      async clickDetailsByIdentity() {
        clickCount += 1;
        if (clickCount === 1) {
          pageEvents.emit('request', request);
          pageEvents.emit('response', response);
        }
        if (clickCount === 2) modalOpen = true;
      },
      async isOpenDetailsIdentity() {
        return modalOpen;
      },
      async waitForOpenDetailsIdentity() {
        assert.equal(clickCount, 2, 'a matching prewarm request must not disguise the swallowed click');
      },
    },
  });
  actions.scrollToAlbumUnderHeading = async () => {};

  const opened = await actions.selectAlbumDetailsByIdentityAndReadPayload({
    artist: 'Mastodon',
    album: 'Crack The Skye',
    year: '2009',
  }, { timeout: 1000 });

  assert.equal(clickCount, 2);
  assert.equal(opened.album.name, 'Crack The Skye');
  assert.equal(pageEvents.listenerCount('request'), 0);
  assert.equal(pageEvents.listenerCount('response'), 0);
});

test('gallery return continues in the measured opposite direction after row-height reconciliation', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  const wheelDeltas = [];
  const targetLookups = [];
  let targetCountCalls = 0;
  const target = {
    async count() {
      targetCountCalls += 1;
      return targetCountCalls >= 3 ? 1 : 0;
    },
    async scrollIntoViewIfNeeded() {},
  };
  const actions = new GalleryActions({
    async waitForGalleryScrollMovement() {},
    sectionByArtistHeading(artistName) {
      return {
        getByRole(role, options) {
          targetLookups.push({ artistName, role, options });
          return { first: () => target };
        },
      };
    },
  });
  const scrollStates = [
    { scrollTop: 600, maxScrollTop: 1200, clientHeight: 640 },
    { scrollTop: 120, maxScrollTop: 1200, clientHeight: 640 },
  ];
  actions.readGalleryScrollState = async () => scrollStates.shift();
  actions.scrollGalleryBy = async (deltaY) => wheelDeltas.push(deltaY);
  actions.waitForAlbumVisibleUnderHeading = async () => {};
  actions.readAlbumGalleryViewportState = async () => ({
    attached: true,
    detached: false,
    intersects: true,
    offscreen: false,
  });

  await actions.scrollToAlbumUnderHeading('Neal Morse', 'Joseph: Part One - The Dreamer', {
    direction: -1,
  });

  assert.deepEqual(wheelDeltas, [-480, -480]);
  assert.ok(wheelDeltas.every((deltaY) => deltaY < 0));
  assert.deepEqual(targetLookups[0], {
    artistName: 'Neal Morse',
    role: 'button',
    options: { name: 'Joseph: Part One - The Dreamer', exact: true },
  });
});

test('gallery return waits at the real boundary for delayed virtual-card reattachment', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  let attached = false;
  let boundaryWaits = 0;
  const target = {
    async count() {
      return attached ? 1 : 0;
    },
  };
  const actions = new GalleryActions({
    async readAlbumTargetState() {
      return {
        activeRequestUrl: '/view-data',
        attachedMatch: false,
        busy: true,
        canonicalApplied: false,
        canonicalMatch: false,
        canonicalQuery: '',
        expectedAlbum: 'Joseph: Part One - The Dreamer',
        expectedArtist: 'Neal Morse',
        expectedQuery: '',
        inputQuery: '',
        locationQuery: '',
        pendingViewTransition: true,
        startupHydrating: false,
      };
    },
    sectionByArtistHeading() {
      return {
        getByRole() {
          return { first: () => target };
        },
      };
    },
  });
  actions.readGalleryScrollState = async () => ({
    scrollTop: 0,
    maxScrollTop: 1200,
    clientHeight: 640,
  });
  actions.waitForAlbumVisibleUnderHeading = async () => {
    boundaryWaits += 1;
    attached = true;
  };
  actions.readAlbumGalleryViewportState = async () => ({
    attached: true,
    detached: false,
    intersects: true,
    offscreen: false,
  });

  await actions.scrollToAlbumUnderHeading('Neal Morse', 'Joseph: Part One - The Dreamer', {
    direction: -1,
    waitAtBoundary: true,
  });

  assert.equal(boundaryWaits, 1, 'the boundary wait reattaches the card before the next viewport check');
});

test('gallery traversal reverses from a settled virtual boundary instead of polling without yield', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/galleryActions.js')).href;
  const { GalleryActions } = await import(moduleUrl);
  let scrollTop = 1200;
  let reversed = false;
  const wheelDeltas = [];
  const target = {
    async count() {
      return reversed ? 1 : 0;
    },
  };
  const actions = new GalleryActions({
    async readAlbumTargetState() {
      return {
        activeLoader: false,
        activeRequestUrl: '',
        attachedMatch: false,
        busy: false,
        canonicalApplied: true,
        canonicalMatch: true,
        canonicalQuery: '',
        expectedAlbum: 'Sparse Album Edit Fixture',
        expectedArtist: 'E2E Rarity Artist',
        expectedQuery: '',
        inputQuery: '',
        locationQuery: '',
        pendingViewTransition: false,
        startupHydrating: false,
      };
    },
    async waitForGalleryScrollMovement(previousScrollTop, direction) {
      assert.equal(previousScrollTop, 1200);
      assert.equal(direction, -1);
    },
    sectionByArtistHeading() {
      return {
        getByRole() {
          return { first: () => target };
        },
      };
    },
  });
  actions.waitForAlbumVisibleUnderHeading = async () => {
    assert.fail('A settled detached virtual card must yield by reversing gallery traversal.');
  };
  actions.readGalleryScrollState = async () => ({
    scrollTop,
    maxScrollTop: 1200,
    clientHeight: 640,
  });
  actions.scrollGalleryBy = async (deltaY) => {
    wheelDeltas.push(deltaY);
    scrollTop += deltaY;
    reversed = true;
  };
  actions.readAlbumGalleryViewportState = async () => ({
    attached: true,
    detached: false,
    intersects: true,
    offscreen: false,
    scrollDirection: 0,
  });

  await actions.scrollToAlbumUnderHeading(
    'E2E Rarity Artist',
    'Sparse Album Edit Fixture',
    { waitAtBoundary: true },
  );

  assert.deepEqual(wheelDeltas, [-480]);
});

test('search readiness waits for the committed URL query and completed view request', () => {
  const search = read('tests/e2e/actions/searchToolbarActions.js');
  const searchPom = read('tests/e2e/poms/searchToolbar.js');
  const gallery = read('tests/e2e/actions/galleryActions.js');
  const galleryPom = read('tests/e2e/poms/galleryPage.js');

  assert.match(search, /waitForQuerySettled\(expectedQuery, options\)/);
  assert.doesNotMatch(search, /globalThis\.appState/);
  assert.match(searchPom, /searchParams\.get\('q'\)/);
  assert.match(searchPom, /const timeout = Number\(options\.timeout \|\| 30000\)/);
  assert.match(searchPom, /const initialObservation = this\.productionViewObserver\.read\(\)/);
  assert.match(searchPom, /const finalObservation = this\.productionViewObserver\.read\(\)/);
  assert.match(searchPom, /finalObservation\.stateRevision !== initialObservation\.stateRevision/);
  assert.match(searchPom, /!hasStableDomEvidence\(/);
  assert.match(searchPom, /activeRequestCount: busy \? Math\.max\(1, finalObservation\.activeRequestCount\) : 0/);
  assert.match(searchPom, /lastObservedState\.activeRequestCount === 0/);
  assert.match(searchPom, /lastObservedState\.pendingPayloadReadCount === 0/);
  assert.match(searchPom, /canonicalQuery === expected/);
  assert.match(searchPom, /lastObservedState\.canonicalApplied/);
  assert.match(searchPom, /canonicalSurface === 'home'/);
  assert.match(searchPom, /canonicalSidebarArtists/);
  assert.match(searchPom, /hasAppliedCanonicalArtistSurface\(/);
  assert.match(searchPom, /!lastObservedState\.activeLoader/);
  assert.match(galleryPom, /!hasStableDomEvidence\(/);
  assert.match(galleryPom, /attachedMatch: finalAttachedMatch/);
  assert.match(galleryPom, /payloadPresent: payload !== null/);
  assert.match(gallery, /waitForGalleryScrollAtStart/);
  assert.match(gallery, /galleryScroll\.scrollTop <= 2/);
});

test('the long cover notification lifecycle owns enough CI budget to reach cancellation', () => {
  const coverLookup = read('tests/e2e/specs/coverLookup.spec.js');
  const scenarioStart = coverLookup.indexOf(
    "test('FTC-COVERS-007 notification states and bulk clear preserve active work'",
  );
  const nextScenario = coverLookup.indexOf('\ntest(', scenarioStart + 1);
  const scenario = coverLookup.slice(scenarioStart, nextScenario);

  assert.match(scenario, /testInfo\.setTimeout\(240000\)/);
});

test('the rating authority scan lifecycle owns enough CI budget for queued cover refresh work', () => {
  const albumRatings = read('tests/e2e/specs/albumRatings.spec.js');
  const scenarioStart = albumRatings.indexOf(
    "test('FTC-ALBUM-TASTE-013 keeps app ratings authoritative while import and scan seed missing ratings'",
  );
  const scenario = albumRatings.slice(scenarioStart);

  assert.match(scenario, /testInfo\.setTimeout\(240000\)/);
});

test('track modal cover readiness rejects loading placeholders and requires a final visible state', () => {
  const trackModal = read('tests/e2e/actions/trackModalActions.js');

  assert.match(trackModal, /naturalWidth\s*>\s*0/);
  assert.match(trackModal, /getBoundingClientRect\(\)\.width\s*>\s*0/);
  assert.match(trackModal, /albumCoverImage\.evaluateAll/);
  assert.match(trackModal, /String\(coverPlaceholder\.textContent\s*\|\|\s*''\)\.trim\(\)\s*===\s*'No cover art'/);
  assert.doesNotMatch(trackModal, /return coverLoaded \|\| coverPlaceholderVisible/);
});

test('cover notification text selection retries only the atomic connected-node geometry probe', () => {
  const coverLookup = read('tests/e2e/actions/coverLookupActions.js');
  const selectionAction = coverLookup.match(
    /async dragSelectTaskTitleWithoutOpeningModal[\s\S]*?\n  async readTaskElapsed/,
  )?.[0] || '';

  assert.match(selectionAction, /expect\.poll\(async \(\) =>/);
  assert.match(selectionAction, /if \(!element\.isConnected\) return \[\]/);
  assert.match(selectionAction, /range\.selectNodeContents\(element\)/);
  assert.match(selectionAction, /page\.mouse\.down\(\)/);
  assert.match(selectionAction, /page\.mouse\.up\(\)/);
  assert.doesNotMatch(selectionAction, /element\.click\(|dispatchEvent|selection\.addRange/);
});

test('cover lookup hashes only decoded visible currentSrc response evidence', () => {
  const coverLookup = read('tests/e2e/actions/coverLookupActions.js');

  assert.match(coverLookup, /expect\(image,[\s\S]*?\)\.toBeVisible\(\)/);
  assert.match(coverLookup, /element\.complete\s*&&\s*element\.naturalWidth\s*>\s*0/);
  assert.match(coverLookup, /currentSrc:/);
  assert.match(coverLookup, /hasAttribute\('data-cover-visual-state'\)/);
  assert.match(coverLookup, /visualState[\s\S]*=== 'ready'/);
  assert.match(coverLookup, /imageResponseEvidence\.get\(src\)/);
  assert.doesNotMatch(coverLookup, /\bfetch\s*\(/);
});

test('cover lookup rejects a pending gallery blob transition before hashing response evidence', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/coverLookupActions.js')).href;
  const { isDisplayedImageEvidenceReady } = await import(moduleUrl);
  const decodedBlobState = {
    currentSrc: 'blob:http://127.0.0.1:4173/stale-cover',
    productionSrc: '/cover?path=fixture%2Fcover.jpg&v=new-revision',
    complete: true,
    naturalWidth: 480,
    width: 240,
    height: 240,
    hasVisualState: true,
  };

  assert.equal(
    isDisplayedImageEvidenceReady({ ...decodedBlobState, visualState: 'pending' }),
    false,
    'a decoded stale blob must not satisfy evidence after the production URL advances',
  );
  assert.equal(
    isDisplayedImageEvidenceReady({ ...decodedBlobState, visualState: 'ready' }),
    true,
    'the runtime ready state ties the displayed blob to the completed production request',
  );
  assert.equal(
    isDisplayedImageEvidenceReady({
      ...decodedBlobState,
      hasVisualState: false,
      visualState: '',
    }),
    true,
    'non-gallery images without the gallery visual-state contract remain measurable',
  );
});

test('cover lookup measures exact no-size production cover bytes through the action layer', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/coverLookupActions.js')).href;
  const { CoverLookupActions } = await import(moduleUrl);
  const page = new EventEmitter();
  const body = Buffer.from('exact full-size selected cover bytes');
  const requested = [];
  page.url = () => 'http://127.0.0.1:4173/?surface=albums';
  page.request = {
    async get(url, options) {
      requested.push({ url, options });
      return {
        ok: () => true,
        status: () => 200,
        body: async () => body,
      };
    },
  };
  const actions = new CoverLookupActions({ page });

  const evidence = await actions.readFullSizeCoverEvidence({
    coverPath: 'Mastodon/Crack The Skye/cover.jpg',
    coverRevision: 'A'.repeat(64),
    label: 'persisted canonical cover',
  });

  assert.equal(requested.length, 1);
  const requestedUrl = new URL(requested[0].url);
  assert.equal(requestedUrl.pathname, '/cover');
  assert.equal(requestedUrl.searchParams.get('path'), 'Mastodon/Crack The Skye/cover.jpg');
  assert.equal(requestedUrl.searchParams.get('v'), 'A'.repeat(64));
  assert.equal(requestedUrl.searchParams.has('size'), false);
  assert.deepEqual(requested[0].options, { headers: { Accept: 'image/*' } });
  assert.deepEqual(evidence, {
    src: requestedUrl.toString(),
    coverPath: 'Mastodon/Crack The Skye/cover.jpg',
    coverRevision: 'A'.repeat(64),
    sha256: createHash('sha256').update(body).digest('hex').toUpperCase(),
  });
  await assert.rejects(
    actions.readFullSizeCoverEvidence({
      source: '/cover?path=Mastodon%2FCrack%20The%20Skye%2Fcover.jpg&size=480',
      label: 'resized candidate',
    }),
    /cannot use a resized cover variant/,
  );
});

test('cover lookup records same-origin cover response evidence loaded through fetch', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/coverLookupActions.js')).href;
  const { CoverLookupActions } = await import(moduleUrl);
  const page = new EventEmitter();
  page.url = () => 'http://127.0.0.1:4173/';
  const actions = new CoverLookupActions({ page });
  const responseUrl = 'http://127.0.0.1:4173/cover?path=fixture%2Fcover.jpg&size=480';
  const body = Buffer.from('selected local cover bytes');

  page.emit('response', {
    request: () => ({ resourceType: () => 'fetch' }),
    url: () => responseUrl,
    finished: async () => null,
    ok: () => true,
    status: () => 200,
    body: async () => body,
  });

  const pendingEvidence = actions.imageResponseEvidence.get(responseUrl);
  assert.ok(pendingEvidence, 'fetch-loaded /cover responses must remain available as displayed-image evidence');
  const evidence = await pendingEvidence;
  assert.equal(evidence.error, null);
  assert.deepEqual(evidence.value, {
    src: responseUrl,
    sha256: createHash('sha256').update(body).digest('hex').toUpperCase(),
  });
});

test('cover lookup drawer actions use product state and the explicit close control', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/coverLookupActions.js')).href;
  const { CoverLookupActions } = await import(moduleUrl);
  const page = new EventEmitter();
  page.url = () => 'http://127.0.0.1:4173/';
  const events = [];
  let drawerOpen = false;
  const actions = new CoverLookupActions({
    page,
    async isDrawerOpen() { return drawerOpen; },
    drawerButton: {
      async click() {
        events.push('open-control');
        drawerOpen = true;
      },
    },
    drawerCloseButton: {
      async click() {
        events.push('close-control');
        drawerOpen = false;
      },
    },
    async waitForDrawerState(expectedOpen) {
      events.push(expectedOpen ? 'wait-open' : 'wait-closed');
      assert.equal(drawerOpen, expectedOpen);
    },
  });

  await actions.closeDrawer();
  await actions.openDrawer();
  await actions.openDrawer();
  await actions.closeDrawer();

  assert.deepEqual(events, ['open-control', 'wait-open', 'close-control', 'wait-closed']);
  const pom = read('tests/e2e/poms/coverLookup.js');
  assert.match(pom, /drawer\.hidden/);
  assert.match(pom, /classList\.contains\('is-open'\)/);
});

test('utility loop summaries read the group header instead of a saved-loop title', () => {
  const loops = read('tests/e2e/actions/utilityLoopsActions.js');
  const loopEntryCard = read('tests/e2e/poms/utilityLoopEntryCard.js');

  assert.match(loops, /entryCard\.detailTitle\.textContent\(\)/);
  assert.match(loopEntryCard, /this\.detailTitle\s*=\s*this\.detailHeader\.locator\('\.utility-detail-title'\)/);
  assert.doesNotMatch(loops, /\.locator\s*\(/);
});

test('loop playback clicks once before waiting for preload-none media readiness', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/utilityLoopsActions.js')).href;
  const { UtilityLoopsActions } = await import(moduleUrl);
  const events = [];
  const entry = {
    async count() { return 1; },
    async getAttribute(name) {
      assert.equal(name, 'data-utility-loop-entry');
      return 'loop-1';
    },
  };
  const actions = new UtilityLoopsActions({
    loopEntryCard: {
      entryByName(name) {
        assert.equal(name, 'Exact Loop');
        return entry;
      },
      playButtonForEntry(receivedEntry) {
        assert.equal(receivedEntry, entry);
        return { async click() { events.push('click'); } };
      },
    },
  });
  actions.waitForLoopMediaReady = async () => events.push('media-ready');
  actions.waitForLoopPlayback = async () => events.push('playing');
  actions.readLoopPlaybackSnapshot = async () => ({ currentTime: 0 });
  actions.waitForLoopProgress = async () => events.push('progress');

  const loopId = await actions.playLoopByName('Exact Loop');

  assert.equal(loopId, 'loop-1');
  assert.deepEqual(events, ['click', 'media-ready', 'playing', 'progress']);
});

test('loop playback fails loudly when an exact name identifies duplicate entries', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/utilityLoopsActions.js')).href;
  const { UtilityLoopsActions } = await import(moduleUrl);
  let clicked = false;
  const actions = new UtilityLoopsActions({
    loopEntryCard: {
      entryByName() {
        return { async count() { return 2; } };
      },
      playButtonForEntry() {
        return { async click() { clicked = true; } };
      },
    },
  });

  await assert.rejects(
    actions.playLoopByName('Duplicate Loop'),
    /exactly one saved loop entry named "Duplicate Loop", found 2/,
  );
  assert.equal(clicked, false);
});

test('loop functional coverage proves progress, repeat, and both live control orders', () => {
  const spec = read('tests/e2e/specs/loops.functional.spec.js');
  const actions = read('tests/e2e/actions/utilityLoopsActions.js');
  const pom = read('tests/e2e/poms/utilityLoopEntryCard.js');

  assert.match(spec, /FTC-UTIL-LOOPS-021 \/ FTC-UTIL-LOOPS-023 \/ FTC-UTIL-LOOPS-024/);
  assert.match(
    spec,
    /openTab\('appearance'\)[\s\S]*utilityAppearanceActions\.waitForReady\(\)[\s\S]*utilityAppearanceActions\.selectSeekbarMode\('waveform'\)[\s\S]*settingsModalAppBarActions\.closeSettings\(\)[\s\S]*waitForRenderedWaveform/,
  );
  assert.match(
    spec,
    /waitForRepeatCycle\(loopId\)[\s\S]*setSpeedByName\('Warmup Loop', 0\.75\)[\s\S]*stepPitchByName\([\s\S]*'Warmup Loop'/,
  );
  assert.match(
    spec,
    /stepPitchByName\([\s\S]*'Transition Loop'[\s\S]*setSpeedByName\('Transition Loop', 1\.25\)/,
  );
  assert.match(spec, /pitched\.restored\.currentTime\)[\s\S]*toBeLessThanOrEqual\(pitched\.restored\.duration\)/);
  assert.match(spec, /pitched\.restored\.currentTime\)[\s\S]*toBeGreaterThanOrEqual\([\s\S]*pitched\.requested\.currentTime/);
  assert.match(spec, /pitched\.requested\.duration - nestedLoopDurationSeconds/);
  assert.match(spec, /pitched\.restored\.duration - pitched\.requested\.duration/);
  assert.match(spec, /pitched\.progressed\.duration - pitched\.requested\.duration/);
  assert.match(spec, /readRepeatPressedByName\('Warmup Loop'\)[\s\S]*waitForRepeatCycle\(loopId\)/);
  assert.match(
    spec,
    /pressSpaceBeforeLoopOwnership\(LOOP_TRACK_TITLE[\s\S]*pressSpaceForOwnedLoopByName\([\s\S]*'Warmup Loop'[\s\S]*pressNeutralSpaceForOwnedLoop\([\s\S]*clickOwnershipSurface\(\)[\s\S]*pressNeutralSpaceAfterGlobalReclaim\([\s\S]*pressSpaceForOwnedLoopByName\([\s\S]*openTab\('rules'\)[\s\S]*openTab\('loops'\)[\s\S]*pressSpaceAfterLoopOwnershipReset/,
  );
  assert.doesNotMatch(spec, /\.locator\s*\(|\.evaluate\s*\(|page\.route\s*\(|\.press\(['"]Space['"]\)|page\.keyboard/);
  assert.match(actions, /currentTime >= expected\.afterCurrentTime \+ expected\.minimumDelta/);
  assert.match(actions, /waitForRepeatCycle\(loopId/);
  assert.match(actions, /waitForResponse\([\s\S]*\/loops\/pitch-preview/);
  assert.match(actions, /if \(!mediaUrl\)[\s\S]*pitch preview response omitted media_url/);
  assert.match(actions, /return \{ requested, restored, progressed \}/);
  assert.match(actions, /readRepeatPressedByName\(name\)/);
  assert.match(actions, /readLoopContinuity\(previousHandle, loopId\)/);
  assert.match(actions, /pressSpaceBeforeLoopOwnership\(groupTitle[\s\S]*neutralControl\.focus\(\)[\s\S]*neutralControl\.press\('Space'\)/);
  assert.match(actions, /pressSpaceForOwnedLoopByName\(name, expected[\s\S]*playButton\.focus\(\)[\s\S]*playButton\.press\('Space'\)[\s\S]*waitForLoopPlaybackState/);
  assert.match(actions, /pressNeutralSpaceForOwnedLoop\(groupTitle, loopId, expected[\s\S]*neutralControl\.press\('Space'\)[\s\S]*waitForLoopPlaybackState/);
  assert.match(actions, /pressNeutralSpaceAfterGlobalReclaim\(groupTitle, loopId, expectedLoop[\s\S]*neutralControl\.press\('Space'\)[\s\S]*afterSpace[\s\S]*waitForLoopPlaybackState/);
  assert.match(actions, /pressSpaceAfterLoopOwnershipReset\(groupTitle[\s\S]*neutralControl\.press\('Space'\)[\s\S]*afterSpace/);
  assert.doesNotMatch(actions, /\.locator\s*\(/);
  const player = read('tests/e2e/actions/globalPlayerActions.js');
  const playerPom = read('tests/e2e/poms/globalPlayer.js');
  assert.match(playerPom, /this\.ownershipSurface\s*=\s*this\.title/);
  assert.match(player, /clickOwnershipSurface\(\)[\s\S]*ownershipSurface\.click\(\)[\s\S]*expect\(after\)\.toEqual\(before\)/);
  assert.doesNotMatch(player, /\.locator\s*\(/);
  assert.match(pom, /audioByLoopId\(loopId\)/);
  assert.match(pom, /speedOptionForEntry\(entry, speed\)/);
  assert.match(pom, /pitchStepButtonForEntry\(entry, step\)/);
  assert.match(pom, /repeatPressedForEntry\(entry\)/);
});

test('main loop playhead waiter synchronizes a bounded baseline and accepts legal wrap', () => {
  const source = read('tests/e2e/actions/globalPlayerActions.js');
  const spec = read('tests/e2e/specs/loops.functional.spec.js');
  const helperStart = source.indexOf('async waitForMainLoopPlayheadAdvance(');
  const helperEnd = source.indexOf('\n  async setLoopRange(', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Expected the main-loop playhead helper.');
  const helper = source.slice(helperStart, helperEnd);

  assert.match(
    helper,
    /readLoopEditorSnapshot\(\)/,
    'the waiter must read the active loop bounds before choosing a baseline',
  );
  assert.match(helper, /startSeconds/);
  assert.match(helper, /endSeconds/);
  assert.ok(
    (helper.match(/waitForPageCondition\s*\(/g) || []).length >= 2,
    'the waiter must first synchronize inside the loop, then observe movement from that baseline',
  );
  assert.match(
    helper,
    /(currentValue|timelineValue|value)\s*>=\s*expected\.(?:startSeconds|loopStart)[^}]*\1\s*<=\s*expected\.(?:endSeconds|loopEnd)/s,
    'the synchronization phase must reject a stale baseline outside the active loop bounds',
  );
  assert.match(
    helper,
    /(?:baseline|synchronized)[^;=]*=\s*await\s+(?:this\.)?(?:readMainLoopVisualState|globalPlayer\.readMainLoopVisualSnapshot)\(\)/,
    'the forward-movement baseline must be captured after loop-bound synchronization',
  );
  assert.match(
    helper,
    /\|\|[^}]*(?:wrapped|wrap|startSeconds|loopStart)[^}]*(?:baseline|afterValue)/s,
    'the movement predicate must accept a legal end-to-start loop wrap',
  );
  assert.match(
    helper,
    /(?:endSeconds|loopEnd)[^;\n]*-[^;\n]*(?:baseline|afterValue)[^;\n]*\+[^;\n]*(?:currentValue|timelineValue|value)[^;\n]*-[^;\n]*(?:startSeconds|loopStart)/,
    'wrapped progress must be measured as circular forward delta across the loop boundary',
  );
  assert.doesNotMatch(
    helper,
    /Number\(timeline\.value\s*\|\|\s*0\)\s*>=\s*expected\.afterValue\s*\+\s*expected\.minimumDelta/,
    'a single monotonic comparison against the stale pre-range value can never observe wrap',
  );
  assert.match(helper, /timeout:\s*options\.timeout\s*\|\|\s*60000/);
  assert.doesNotMatch(helper, /retry|waitForTimeout/);
  assert.doesNotMatch(
    spec,
    /waitForMainLoopPlayheadAdvance\([^)]*\)[^;]{0,240}\.timeline\.value\)\s*\.toBeGreaterThan\(/s,
    'the scenario must trust the wrap-aware helper rather than reimpose a final monotonic assertion',
  );
});

test('loop hover evidence moves the real mouse to target geometry without locator scrolling', () => {
  const actions = read('tests/e2e/actions/globalPlayerActions.js');
  const savedActions = read('tests/e2e/actions/utilityLoopsActions.js');
  const helperStart = actions.indexOf('async hoverLoopAction(');
  const helperEnd = actions.indexOf('\n  async moveAwayFromLoopAction(', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Expected the loop hover action helper.');
  const helper = actions.slice(helperStart, helperEnd);

  assert.match(helper, /const bounds = await locator\.boundingBox\(\)/);
  assert.match(helper, /if \(!bounds\)[\s\S]*throw new Error/);
  assert.match(
    helper,
    /page\.mouse\.move\(\s*bounds\.x \+ \(bounds\.width \/ 2\),\s*bounds\.y \+ \(bounds\.height \/ 2\),?\s*\)/,
    'hover state must come from the actual pointer at the rendered target center',
  );
  assert.doesNotMatch(
    helper,
    /locator\.hover\s*\(|\.hover\s*\(/,
    'locator.hover may scroll an overflowing active pod and corrupt the tightly clipped evidence',
  );

  const savedHelperStart = savedActions.indexOf('async hoverLoopActionByName(');
  const savedHelperEnd = savedActions.indexOf('\n  async moveAwayFromLoopActionByName(', savedHelperStart);
  assert.ok(savedHelperStart >= 0 && savedHelperEnd > savedHelperStart, 'Expected the saved-loop hover action helper.');
  const savedHelper = savedActions.slice(savedHelperStart, savedHelperEnd);
  assert.match(savedHelper, /page\.mouse\.move\(/);
  assert.match(
    savedHelper,
    /toHaveAttribute\('data-loop-action-engaged', 'true'\)[\s\S]*toHaveCSS\('width', '55px'\)[\s\S]*readLoopActionVisualSnapshot/,
    'saved-loop hover must settle the production expansion before measuring its geometry',
  );
  assert.doesNotMatch(savedHelper, /waitForTimeout|timeout\s*:/);
});

test('main loop range actions use the editor frozen duration exposed by the production handles', () => {
  const pom = read('tests/e2e/poms/globalPlayer.js');
  const actions = read('tests/e2e/actions/globalPlayerActions.js');
  const snapshotStart = pom.indexOf('async readLoopEditorSnapshot(');
  const snapshotEnd = pom.indexOf('\n  async readLoopActionVisualSnapshot(', snapshotStart);
  const rangeStart = actions.indexOf('async setLoopRange(');
  const rangeEnd = actions.indexOf('\n  async clickLoopRangeAt(', rangeStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, 'Expected the loop editor snapshot helper.');
  assert.ok(rangeStart >= 0 && rangeEnd > rangeStart, 'Expected the loop range action helper.');
  const snapshot = pom.slice(snapshotStart, snapshotEnd);
  const range = actions.slice(rangeStart, rangeEnd);

  assert.match(
    snapshot,
    /loopStartHandle\.getAttribute\(['"]aria-valuemax['"]\)/,
    'the POM must read the duration rendered by the production range controller',
  );
  assert.match(snapshot, /duration\s*:\s*Number\(/);
  assert.match(range, /readLoopEditorSnapshot\(\)/);
  assert.match(range, /startSeconds\)\s*\/\s*(?:snapshot|editor|loop)\.duration/);
  assert.match(range, /endSeconds\)\s*\/\s*(?:snapshot|editor|loop)\.duration/);
  assert.doesNotMatch(
    range,
    /readPlaybackTiming\(\)/,
    'transport timing may advance to a continuity role after the loop editor freezes its duration',
  );
});

test('loop creation coverage uses the shared app dialog and POM-owned inline range surfaces', () => {
  const playerPom = read('tests/e2e/poms/globalPlayer.js');
  const playerActions = read('tests/e2e/actions/globalPlayerActions.js');
  const loopPom = read('tests/e2e/poms/utilityLoopEntryCard.js');
  const loopActions = read('tests/e2e/actions/utilityLoopsActions.js');
  const spec = read('tests/e2e/specs/loops.functional.spec.js');
  const expirySpec = read('tests/e2e/specs/loop-edit-expiry.functional.spec.js');

  for (const selector of [
    '#loop-name-modal',
    '#loop-name-form',
    '#loop-name-input',
    '#loop-name-error',
    '#loop-name-cancel',
    '#loop-name-submit',
  ]) {
    assert.match(playerPom, new RegExp(selector.replace('#', '\\#')));
  }
  assert.doesNotMatch(playerActions, /\.once\(['"]dialog['"]|showBrowserPrompt|dialog\.accept/);
  assert.match(playerActions, /submitBlankLoopName\(options/);
  assert.match(playerActions, /loopNameInput\.press\('Enter'\)/);
  assert.match(playerActions, /cancelLoopNameDialog\(options/);

  assert.match(loopPom, /\[data-saved-loop-main-surface\]/);
  assert.match(loopPom, /data-loop-range-owner="saved-loop-/);
  assert.match(loopPom, /canvas\[data-loop-range-waveform\]/);
  assert.match(loopPom, /getByRole\('slider', \{/);
  assert.match(loopPom, /name: boundary === 'start' \? 'Loop start' : 'Loop end'/);
  assert.match(loopPom, /\[data-loop-time\]/);
  assert.doesNotMatch(loopPom, /\[data-loop-range-time="(?:start|end)"\]/);
  assert.doesNotMatch(loopPom, /data-saved-loop-editor|data-saved-loop-waveform|data-saved-loop-handle/);
  assert.match(loopActions, /revealCreateAnotherLoopEditorByName\(name/);
  assert.match(loopActions, /waitForAutomaticLoopEditorExpiryByName\(name/);
  assert.match(loopActions, /dragLoopBoundaryByName\(name, boundary, targetFraction\)/);
  assert.match(loopActions, /page\.mouse\.down\(\)[\s\S]*page\.mouse\.move\([\s\S]*page\.mouse\.up\(\)/);
  assert.doesNotMatch(loopActions, /\.locator\s*\(/);

  assert.match(spec, /submitBlankLoopName\(\)[\s\S]*cancelLoopNameDialog\(\)/);
  assert.match(spec, /saveLoopWithName\('Warmup Loop', \{ submitWithEnter: true \}\)/);
  assert.match(spec, /readLoopEditorStateByName\('Warmup Loop'\)[\s\S]*editor: false/);
  assert.match(spec, /revealCreateAnotherLoopEditorByName\('Warmup Loop'\)/);
  assert.match(expirySpec, /installLoopEditExpiryClock\(\)/);
  assert.match(expirySpec, /advanceLoopEditExpiryClock\(299000\)[\s\S]*expectLoopEditorActive\(\)[\s\S]*advanceLoopEditExpiryClock\(1000\)[\s\S]*waitForAutomaticLoopEditorExpiry\(\)/);
  assert.match(expirySpec, /waitForRepeatCycle\(untouchedEditor\.loopId\)[\s\S]*advanceLoopEditExpiryClock\(13000\)[\s\S]*expectCreateAnotherLoopEditorActiveByName\(SAVED_LOOP_NAME\)[\s\S]*advanceLoopEditExpiryClock\(2000\)[\s\S]*waitForAutomaticLoopEditorExpiryByName\(SAVED_LOOP_NAME\)/);
  assert.match(spec, /dragLoopBoundaryByName\('Warmup Loop', 'start', 0\.25\)/);
  assert.match(spec, /dragLoopBoundaryByName\('Warmup Loop', 'end', 0\.75\)/);
  assert.match(spec, /activateCreateAnotherLoopByName\('Warmup Loop'\)[\s\S]*cancelLoopNameDialog\(\)[\s\S]*activateCreateAnotherLoopByName\('Warmup Loop'\)[\s\S]*submitLoopName\('Transition Loop'\)/);
  assert.doesNotMatch(spec, /\.locator\s*\(|\.evaluate\s*\(|waitForTimeout\s*\(|page\.once\(['"]dialog['"]|page\.route\s*\(/);
  assert.doesNotMatch(expirySpec, /\.locator\s*\(|\.evaluate\s*\(|waitForTimeout\s*\(|page\.once\(['"]dialog['"]|page\.route\s*\(/);
});

test('loop entry names use exact escaped matching rather than substring matching', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/poms/utilityLoopEntryCard.js')).href;
  const { UtilityLoopEntryCard } = await import(moduleUrl);
  let capturedTitlePattern = null;
  const locator = {
    locator() { return locator; },
    getByRole() { return locator; },
    filter(options) {
      if (options.hasText) capturedTitlePattern = options.hasText;
      return locator;
    },
    first() { return locator; },
  };
  const entryCard = new UtilityLoopEntryCard({ locator: () => locator });

  entryCard.entryByName('Cover (Live)');

  assert.ok(capturedTitlePattern instanceof RegExp);
  assert.equal(capturedTitlePattern.test('Cover (Live)'), true);
  assert.equal(capturedTitlePattern.test('  Cover (Live)  '), true);
  assert.equal(capturedTitlePattern.test('Cover (Live) Extended'), false);
  assert.equal(capturedTitlePattern.test('My Cover (Live)'), false);
});

test('Problematic Files reads visible rows in one POM-owned browser snapshot', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/utilityProblematicFilesActions.js')).href;
  const { UtilityProblematicFilesActions } = await import(moduleUrl);
  let evaluateAllCalls = 0;
  const row = {
    getAttribute(name) {
      assert.equal(name, 'data-problematic-album-key');
      return 'neal morse::?';
    },
    querySelector(selector) {
      return {
        '.utility-list-item-title': { textContent: '?' },
        '.utility-list-item-meta': { textContent: 'Neal Morse' },
        '.utility-list-item-issues': { textContent: '2 issues' },
      }[selector] || null;
    },
  };
  const actions = new UtilityProblematicFilesActions({
    listItems: {
      async evaluateAll(callback, selectors) {
        evaluateAllCalls += 1;
        return callback([row], selectors);
      },
    },
    listItemTitleSelector: '.utility-list-item-title',
    listItemMetaSelector: '.utility-list-item-meta',
    listItemIssuesSelector: '.utility-list-item-issues',
  });

  assert.deepEqual(await actions.readVisibleListItems(), [{
    key: 'neal morse::?',
    title: '?',
    meta: 'Neal Morse',
    issues: '2 issues',
  }]);
  assert.equal(evaluateAllCalls, 1);
});

test('Problematic Files readiness uses one POM-owned condition over the real rendered surface', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/utilityProblematicFilesActions.js')).href;
  const { UtilityProblematicFilesActions } = await import(moduleUrl);
  const originalDocument = global.document;
  try {
    const visibleElement = (textContent = '') => ({
      offsetWidth: 1,
      offsetHeight: 0,
      getClientRects: () => [],
      textContent,
    });
    global.document = {
      querySelector(selector) {
        return {
          '[data-problematic-album-key]': visibleElement(),
          '[data-problematic-album-key].is-active': visibleElement(),
          '#utility-problematic-detail .utility-detail-title': visibleElement('Cover to Cover'),
        }[selector] || null;
      },
    };
    let waitCalls = 0;
    const actions = new UtilityProblematicFilesActions({
      listItemSelector: '[data-problematic-album-key]',
      activeListItemSelector: '[data-problematic-album-key].is-active',
      detailTitleSelector: '#utility-problematic-detail .utility-detail-title',
      listEmptyStateSelector: '#utility-problematic-list .utility-empty-state',
      async waitForPageCondition(callback, options, argument) {
        waitCalls += 1;
        assert.equal(options.timeout, 4321);
        assert.equal(argument.requirePopulated, true);
        assert.equal(callback(argument), true);
      },
    });

    await actions.waitForReady({ timeout: 4321, requirePopulated: true });
    assert.equal(waitCalls, 1);
  } finally {
    global.document = originalDocument;
  }
});

test('Settings measurement prepares the real button action and observes the modal in one POM condition', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/settingsModalAppBarActions.js')).href;
  const { SettingsModalAppBarActions } = await import(moduleUrl);
  const originalDocument = global.document;
  try {
    const visibleElement = { offsetWidth: 1, offsetHeight: 0, getClientRects: () => [] };
    global.document = {
      querySelector(selector) {
        return ['#utility-modal', '#utility-modal-title', '.utility-modal-body'].includes(selector)
          ? visibleElement
          : null;
      },
    };
    const clickOptions = [];
    let conditionCalls = 0;
    const actions = new SettingsModalAppBarActions({
      settingsButton: {
        async click(options) { clickOptions.push(options); },
      },
      modalSelector: '#utility-modal',
      titleSelector: '#utility-modal-title',
      modalBodySelector: '.utility-modal-body',
      async waitForPageCondition(callback, options, argument) {
        conditionCalls += 1;
        assert.equal(options.timeout, 4321);
        assert.equal(callback(argument), true);
      },
    });

    await actions.prepareToOpenSettings();
    await actions.waitForOpen({ timeout: 4321 });
    assert.deepEqual(clickOptions, [{ trial: true }]);
    assert.equal(conditionCalls, 1);
  } finally {
    global.document = originalDocument;
  }
});

test('Problematic Files selection polling preserves POM selectors in the serialized argument', async () => {
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/actions/utilityProblematicFilesActions.js')).href;
  const { UtilityProblematicFilesActions } = await import(moduleUrl);
  const originalState = global.state;
  const originalDocument = global.document;
  const originalGetSelected = global.getSelectedProblematicAlbum;
  try {
    global.state = { utility: { selectedProblematicKey: 'neal morse::?' } };
    global.document = {
      querySelector(selector) {
        if (selector === '[data-problematic-album-key].is-active') {
          return { getAttribute: () => 'neal morse::?' };
        }
        if (selector === '#utility-problematic-detail .utility-detail-title') {
          return { textContent: '?' };
        }
        return null;
      },
    };
    global.getSelectedProblematicAlbum = () => ({ key: 'neal morse::?', detail_loaded: true });
    const actions = new UtilityProblematicFilesActions({
      activeListItemSelector: '[data-problematic-album-key].is-active',
      detailTitleSelector: '#utility-problematic-detail .utility-detail-title',
      async waitForPageCondition(callback, options, argument) {
        assert.equal(options.timeout, 4321);
        assert.deepEqual(argument, {
          key: 'neal morse::?',
          title: '?',
          activeListItemSelector: '[data-problematic-album-key].is-active',
          detailTitleSelector: '#utility-problematic-detail .utility-detail-title',
        });
        assert.equal(callback(argument), true);
      },
    });

    await actions.waitForSelectedDetailSelection(
      { expectedKey: 'neal morse::?', expectedTitle: '?' },
      { timeout: 4321 },
    );
  } finally {
    global.state = originalState;
    global.document = originalDocument;
    global.getSelectedProblematicAlbum = originalGetSelected;
  }
});

test('loop E2E helpers use the shared accessible scissors and range production surfaces', () => {
  const globalPlayer = read('tests/e2e/poms/globalPlayer.js');
  const savedLoop = read('tests/e2e/poms/utilityLoopEntryCard.js');
  const globalActions = read('tests/e2e/actions/globalPlayerActions.js');
  const savedActions = read('tests/e2e/actions/utilityLoopsActions.js');

  assert.match(globalPlayer, /data-loop-action-owner="global-player"/);
  assert.match(globalPlayer, /getByRole\('button', \{ name: 'Create a loop', exact: true \}\)/);
  assert.match(globalPlayer, /getByRole\('slider', \{ name: 'Loop start', exact: true \}\)/);
  assert.match(globalPlayer, /legacyLoopButton/);
  assert.match(globalPlayer, /legacyLoopPopup/);
  assert.match(savedLoop, /data-loop-action-owner/);
  assert.match(savedLoop, /name: 'Create another loop', exact: true/);
  assert.match(savedLoop, /data-loop-range-owner="saved-loop-/);
  assert.match(globalActions, /(?:enter|open)Loop(?:Edit|Creation)/i);
  assert.match(globalActions, /(?:drag|move)Loop(?:Start|End|Boundary|Handle)/i);
  assert.match(savedActions, /(?:enter|open)SavedLoop(?:Edit|Creation)|createAnotherLoop/i);
  assert.match(savedActions, /(?:cancel|escape)[^\n]*Loop/i);

  const compactLayoutStart = savedLoop.indexOf('async readCompactLayoutSnapshot(');
  const compactLayoutEnd = savedLoop.indexOf('\n  async readLoopActionVisualSnapshot(', compactLayoutStart);
  const compactLayoutHelper = savedLoop.slice(compactLayoutStart, compactLayoutEnd);
  assert.match(
    compactLayoutHelper,
    /this\.loopActionForEntry\(entry\)\.boundingBox\(\)/,
    'compact layout must measure the persistent action root in idle and active states',
  );
  assert.doesNotMatch(
    compactLayoutHelper,
    /this\.loopScissorsButtonForEntry\(entry\)\.boundingBox\(\)/,
    'compact layout must not wait for the hidden idle Enter button while editing',
  );
  assert.match(
    compactLayoutHelper,
    /scissorsBounds\s*:\s*(?:action|loopAction|actionRoot)Bounds/,
    'the stable root bounds must preserve the existing scissorsBounds result contract',
  );
  assert.doesNotMatch(
    compactLayoutHelper,
    /if \([^)]*!pitchBounds/,
    'compact layout measurement must remain usable while edit mode intentionally hides pitch',
  );
  assert.match(
    compactLayoutHelper,
    /pitchBounds,/,
    'idle-mode callers must still receive pitch geometry and enforce its visible placement',
  );
});

test('loop range E2E coverage measures rendered geometry and preserves in-drag synchronization evidence', () => {
  const spec = read('tests/e2e/specs/loops.functional.spec.js');
  const globalPom = read('tests/e2e/poms/globalPlayer.js');
  const globalActions = read('tests/e2e/actions/globalPlayerActions.js');
  const savedPom = read('tests/e2e/poms/utilityLoopEntryCard.js');
  const savedActions = read('tests/e2e/actions/utilityLoopsActions.js');

  for (const source of [globalPom, savedPom]) {
    assert.match(source, /selectionLeftFraction/);
    assert.match(source, /selectionRightFraction/);
    assert.match(source, /selectionStartErrorPixels/);
    assert.match(source, /selectionEndErrorPixels/);
    assert.match(source, /getComputedStyle\([^)]*\)\.cursor/);
    assert.match(source, /timeWaveformOverlap/);
    assert.match(source, /playerHeight/);
    assert.match(source, /waveformHeight/);
  }
  assert.match(globalPom, /metadataWaveformGap/);
  assert.match(globalPom, /coverCenterY/);
  assert.match(globalPom, /playCenterY/);
  assert.match(globalPom, /timelineCenterY/);
  assert.match(globalPom, /mainLeftGapFromPlay/);
  const actionVisualStart = globalPom.indexOf('async readLoopActionVisualSnapshot(');
  const actionVisualEnd = globalPom.indexOf('\n  async readMainLoopVisualSnapshot(', actionVisualStart);
  assert.ok(actionVisualStart >= 0 && actionVisualEnd > actionVisualStart, 'Expected the main-player visual snapshot helper.');
  const actionVisualHelper = globalPom.slice(actionVisualStart, actionVisualEnd);
  assert.match(
    actionVisualHelper,
    /this\.timeline\.boundingBox\(\)/,
    'centerline evidence must measure the exact native 36px idle/playing timeline surface',
  );
  assert.doesNotMatch(actionVisualHelper, /this\.loopRangeOwner\.boundingBox\(\)/);
  assert.match(savedPom, /pitchVisible:\s*Boolean\(pitchBox\)/);
  assert.match(savedPom, /timestampVisible:\s*visibility\.timeSlot/);

  for (const source of [globalActions, savedActions]) {
    assert.match(
      source,
      /mouse\.down\(\)[\s\S]*mouse\.move\([\s\S]*const dragSnapshot = await[\s\S]*mouse\.up\(\)[\s\S]*dragSnapshot/,
      'drag actions must retain rendered evidence before pointer-up',
    );
  }

  assert.match(spec, /cursors\.surface\)\.toBe\('default'\)/);
  assert.match(spec, /opened\.playerHeight\)\.toBe\(85\)/);
  assert.match(spec, /opened\.waveformHeight\)\.toBe\(36\)/);
  assert.doesNotMatch(spec, /opened\.playerHeight\)\.toBe\(78\)/);
  assert.match(spec, /opened\.metadataWaveformGap\)\.toBeGreaterThanOrEqual\(3\)/);
  assert.doesNotMatch(spec, /opened\.waveformHeight\)\.toBeGreaterThanOrEqual\(40\)/);
  assert.match(
    spec,
    /playingPlayerLayout\.coverCenterY - playingPlayerLayout\.playCenterY[\s\S]*toBeLessThanOrEqual\(1\)/,
  );
  assert.match(
    spec,
    /unavailable\.visual\.coverCenterY\)\.not\.toBeNull\(\)[\s\S]*unavailable\.visual\.coverCenterY - unavailable\.visual\.playCenterY[\s\S]*toBeLessThanOrEqual\(1\)[\s\S]*unavailable\.visual\.playCenterY - unavailable\.visual\.timelineCenterY[\s\S]*toBeLessThanOrEqual\(1\)[\s\S]*unavailable\.visual\.mainLeftGapFromPlay - 8[\s\S]*toBeLessThanOrEqual\(1\)/,
    'the no-track placeholder must share the compact active-player alignment contract',
  );
  assert.match(
    spec,
    /playingPlayerLayout\.playCenterY - playingPlayerLayout\.timelineCenterY[\s\S]*toBeLessThanOrEqual\(1\)/,
  );
  assert.match(
    spec,
    /idle\.timelineCenterY - playingPlayerLayout\.timelineCenterY[\s\S]*toBeLessThanOrEqual\(1\)/,
  );
  assert.match(
    spec,
    /idle\.mainAreaBounds\.x - playingPlayerLayout\.mainAreaBounds\.x[\s\S]*toBeLessThanOrEqual\(1\)/,
  );
  assert.match(spec, /mainLeftGapFromPlay - 8\)\)\.toBeLessThanOrEqual\(1\)/);
  assert.match(spec, /cursors\.startHandle\)\.toBe\('grab'\)/);
  assert.match(spec, /dragSnapshot\.cursors\.startHandle\)\.toBe\('grabbing'\)/);
  assert.match(spec, /pitchVisible\)\.toBe\(false\)/);
  assert.match(spec, /timestampVisible\)\.toBe\(true\)/);
  assert.match(spec, /timeWaveformOverlap\)\.toBe\(false\)/);
  assert.match(
    spec,
    /approved saved-loop two-row layout keeps the timeline below the timestamp row[\s\S]*toBeGreaterThanOrEqual\(compactLayout\.topRowBounds\.y \+ compactLayout\.topRowBounds\.height\)/,
  );
  assert.match(
    spec,
    /saved-loop timestamp row must finish before the waveform timeline begins[\s\S]*toBeLessThanOrEqual\(compactLayout\.timelineBounds\.y\)/,
  );
  assert.match(
    spec,
    /lowering the saved-loop timeline must keep it inside the compact player main area[\s\S]*toBeLessThanOrEqual\(compactLayout\.mainBounds\.y \+ compactLayout\.mainBounds\.height \+ 1\)/,
  );
  assert.doesNotMatch(spec, /playCenterY - compactLayout\.timelineCenterY/);
  assert.match(spec, /selectionStartErrorPixels\)\.toBeLessThanOrEqual\(1\)/);
  assert.match(spec, /selectionEndErrorPixels\)\.toBeLessThanOrEqual\(1\)/);
  assert.match(spec, /selectionLeftFraction\)[\s\S]*startHandleFraction/);
  assert.match(spec, /selectionRightFraction\)[\s\S]*endHandleFraction/);
});

test('loop action production path exposes the persistent enabled and engaged pod contract', () => {
  const controls = read('music_app/static/js/runtime/loop-range-controls.js');
  const player = read('music_app/static/js/runtime/player-loop-playback.js');
  const utility = read('music_app/static/js/runtime/utility-loop-playback.js');
  const template = read('music_app/templates/index.html');
  const css = read('music_app/static/css/runtime/non-album-and-player.css');

  assert.match(controls, /data-loop-action-pod/);
  assert.match(controls, /data-loop-action-divider/);
  assert.match(controls, /enabled\s*=\s*(?:true|false)/);
  assert.match(controls, /data-loop-action-engaged/);
  assert.match(controls, /pointerenter[^]*pointerleave[^]*focusin[^]*focusout/);
  assert.match(controls, /Start playing the track to edit the loop/);
  assert.match(player, /Boolean\(getPlayerPlaybackSnapshot\(\)\.src\s*\|\|\s*state\.player\.current\?\.src\)/);
  assert.match(utility, /mountLoopEditActionControl\s*\(\s*\{[^]*enabled:\s*true/);
  assert.match(
    template,
    /<span class="loop-play-control-actions player-loop-actions"[^>]*data-loop-action-mount="global-player"[^>]*data-loop-action-owner="global-player"[^>]*>\s*<\/span>/,
  );
  assert.doesNotMatch(css, /\.loop-edit-action:disabled\s*\{[^}]*cursor:\s*(?:wait|progress)/s);
});

test('loop player production markup keeps waveform identities and one timestamp per player', () => {
  const player = read('music_app/static/js/runtime/player-loop-playback.js');
  const utility = read('music_app/static/js/runtime/utility-loop-playback.js');
  const builder = read('music_app/static/js/runtime/utility-list-builders.js');
  const template = read('music_app/templates/index.html');
  const css = read('music_app/static/css/runtime/non-album-and-player.css');

  assert.doesNotMatch(player, /drawCombinedLoopWaveform\s*\(/);
  assert.match(utility, /drawCombinedLoopWaveform\s*\(/);
  assert.doesNotMatch(template, /data-loop-range-time=/);
  assert.equal((template.match(/id="player-time"/g) || []).length, 1);
  assert.match(builder, /data-loop-pitch-value>0 pst<\/span>/);
  assert.equal((builder.match(/data-loop-time=/g) || []).length, 1);
  assert.doesNotMatch(builder, /data-loop-range-times|data-loop-range-time=/);
  assert.doesNotMatch(css, /\.player-timeline-wrap\.is-waveform(?:\.is-looping)?\s+\.player-timeline\s*\{[^}]*opacity:\s*0\.0[0-9]/s);
  assert.doesNotMatch(utility, /elements\.timeline\.hidden\s*=\s*editor\.active/);
});
