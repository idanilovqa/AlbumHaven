const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('production search config is owner-only, sandbox1-only, and has no server lifecycle', () => {
  const config = read('playwright.production-search-benchmark.config.cjs');
  const packageJson = JSON.parse(read('package.json'));
  const guard = require('../e2e/support/productionSearchBenchmarkGuard.cjs');
  assert.doesNotMatch(config, /webServer\s*:/u);
  assert.match(config, /workers:\s*1/u);
  assert.match(config, /trace:\s*'off'/u);
  assert.match(config, /screenshot:\s*'off'/u);
  assert.match(config, /video:\s*'off'/u);
  assert.equal(
    packageJson.scripts['test:e2e:performance:production-search'],
    'playwright test --config=playwright.production-search-benchmark.config.cjs',
  );
  assert.throws(() => guard.assertProductionSearchBenchmarkInvocation({
    argv: [], env: {},
  }), new RegExp(guard.APPROVAL_ENV));
  assert.throws(() => guard.assertProductionSearchBenchmarkInvocation({
    argv: [],
    env: {
      [guard.APPROVAL_ENV]: guard.PRODUCTION_SEARCH_BENCHMARK_APPROVAL,
      [guard.URL_ENV]: `${guard.PRODUCTION_SEARCH_BENCHMARK_URL}/`,
    },
  }), /must be exactly https:\/\/sandbox1\.albumhaven\.org/u);
  assert.throws(() => guard.assertProductionSearchBenchmarkInvocation({
    argv: [],
    env: {
      CI: 'true',
      [guard.APPROVAL_ENV]: guard.PRODUCTION_SEARCH_BENCHMARK_APPROVAL,
      [guard.URL_ENV]: guard.PRODUCTION_SEARCH_BENCHMARK_URL,
    },
  }), /owner-invoked/u);
  assert.doesNotThrow(() => guard.assertProductionSearchBenchmarkInvocation({
    argv: ['--list'], env: {},
  }));
});

test('production search invocation requires fresh exact-0084 database attestation', () => {
  const guard = require('../e2e/support/productionSearchBenchmarkGuard.cjs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-production-search-db-'));
  const statePath = path.join(tempRoot, 'state.json');
  const attestationPath = path.join(tempRoot, 'attestation.json');
  const migrationPath = path.join(
    root,
    'migrations/postgres/0084_create_local_artist_search_projection.sql',
  );
  const migrationSha256 = crypto.createHash('sha256').update(fs.readFileSync(migrationPath)).digest('hex');
  fs.writeFileSync(statePath, '{}');
  const baseAttestation = {
    schemaVersion: 2,
    issuedAt: new Date().toISOString(),
    benchmarkOrigin: guard.PRODUCTION_SEARCH_BENCHMARK_URL,
    databaseIdentityProof: {
      scheme: 'hmac-sha256-v1',
      keyVersion: 7,
      proof: 'a'.repeat(64),
    },
    migration: {
      filename: '0084_create_local_artist_search_projection.sql',
      sha256: migrationSha256,
    },
  };
  const env = {
    [guard.APPROVAL_ENV]: guard.PRODUCTION_SEARCH_BENCHMARK_APPROVAL,
    [guard.URL_ENV]: guard.PRODUCTION_SEARCH_BENCHMARK_URL,
    [guard.STORAGE_STATE_ENV]: statePath,
    [guard.DATABASE_ATTESTATION_ENV]: attestationPath,
  };
  try {
    fs.writeFileSync(attestationPath, JSON.stringify(baseAttestation));
    assert.doesNotThrow(() => guard.assertProductionSearchBenchmarkInvocation({ argv: [], env }));
    assert.deepEqual(
      guard.readProductionSearchDatabaseAttestation({ env }).databaseIdentityProof,
      baseAttestation.databaseIdentityProof,
    );

    fs.writeFileSync(attestationPath, JSON.stringify({
      ...baseAttestation,
      schemaVersion: 1,
      databaseIdentitySha256: 'a'.repeat(64),
      databaseIdentityProof: undefined,
    }));
    assert.throws(
      () => guard.readProductionSearchDatabaseAttestation({ env }),
      /fresh database attestation/u,
    );
    fs.writeFileSync(attestationPath, JSON.stringify(baseAttestation));

    fs.writeFileSync(attestationPath, JSON.stringify({
      ...baseAttestation,
      databaseIdentityProof: {
        ...baseAttestation.databaseIdentityProof,
        scheme: 'sha256',
      },
    }));
    assert.throws(
      () => guard.readProductionSearchDatabaseAttestation({ env }),
      /database identity attestation/u,
    );
    fs.writeFileSync(attestationPath, JSON.stringify(baseAttestation));

    const nearExpiryIssuedAtMs = Date.now() - (14 * 60 * 1000);
    fs.writeFileSync(attestationPath, JSON.stringify({
      ...baseAttestation,
      issuedAt: new Date(nearExpiryIssuedAtMs).toISOString(),
    }));
    assert.doesNotThrow(() => guard.readProductionSearchDatabaseAttestation({
      env,
      nowMs: nearExpiryIssuedAtMs + (14 * 60 * 1000),
    }));
    assert.throws(
      () => guard.readProductionSearchDatabaseAttestation({
        env,
        nowMs: nearExpiryIssuedAtMs + (15 * 60 * 1000) + 1,
      }),
      /fresh database attestation/u,
    );

    fs.writeFileSync(attestationPath, JSON.stringify({
      ...baseAttestation,
      issuedAt: new Date(Date.now() - (16 * 60 * 1000)).toISOString(),
    }));
    assert.throws(
      () => guard.assertProductionSearchBenchmarkInvocation({ argv: [], env }),
      /fresh database attestation/u,
    );

    fs.writeFileSync(attestationPath, JSON.stringify({
      ...baseAttestation,
      migration: { ...baseAttestation.migration, sha256: 'b'.repeat(64) },
    }));
    assert.throws(
      () => guard.assertProductionSearchBenchmarkInvocation({ argv: [], env }),
      /0084 migration checksum/u,
    );
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test('production authentication state is filtered without exposing secrets', async () => {
  const authSource = read('tests/e2e/support/productionSearchAuthentication.js');
  assert.doesNotMatch(authSource, /console\.|password|username/iu);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-production-search-auth-'));
  const statePath = path.join(tempRoot, 'state.json');
  const sessionCookie = {
    name: 'session', value: 'not-reported', domain: 'sandbox1.albumhaven.org', path: '/', expires: -1,
    httpOnly: true, secure: true, sameSite: 'Lax',
  };
  fs.writeFileSync(statePath, JSON.stringify({
    cookies: [sessionCookie, { ...sessionCookie, domain: 'example.test' }],
    origins: [
      { origin: 'https://sandbox1.albumhaven.org', localStorage: [] },
      { origin: 'https://example.test', localStorage: [{ name: 'secret', value: 'discarded' }] },
    ],
  }));
  try {
    const auth = await import(pathToFileURL(
      path.join(root, 'tests/e2e/support/productionSearchAuthentication.js'),
    ));
    assert.deepEqual(auth.readProductionSearchStorageState({
      [auth.PRODUCTION_SEARCH_STORAGE_STATE_ENV]: statePath,
    }), {
      cookies: [sessionCookie],
      origins: [{ origin: 'https://sandbox1.albumhaven.org', localStorage: [] }],
    });
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test('production search journey blocks forbidden requests before navigation', () => {
  const spec = read('tests/e2e/productionRealData/searchFirstVisible.spec.js');
  const helper = read('tests/e2e/helpers/productionSearchBenchmark.js');
  assert.ok(spec.indexOf("page.on('request'") < spec.indexOf("galleryActions.goto('/?surface=albums')"));
  assert.match(helper, /static\.cloudflareinsights\.com/u);
  assert.match(helper, /beacon\.min\.js/u);
  assert.match(helper, /\/cdn-cgi\/rum/u);
  assert.doesNotMatch(spec, /route\.abort\('blockedbyclient'\)/u);
  assert.match(spec, /requestInterceptionGuardEnabled:\s*false/u);
  const baseFixtures = read('tests/e2e/support/baseFixtures.js');
  assert.match(
    baseFixtures,
    /requestInterceptionGuardEnabled:\s*\[true,\s*\{\s*option:\s*true\s*\}\]/u,
  );
  assert.match(
    baseFixtures,
    /requestInterceptionGuard:[\s\S]*requestInterceptionGuardEnabled[\s\S]*if \(!requestInterceptionGuardEnabled\)/u,
  );
  assert.match(
    spec,
    /if \(!\['GET', 'HEAD'\]\.includes\(request\.method\(\)\) \|\| url\.origin !== ALLOWED_ORIGIN\) \{[\s\S]*?forbiddenRequests\.push\([\s\S]*?\n\s*\}/u,
  );
  assert.doesNotMatch(spec, /hostTelemetryRequests\.push/u);
  assert.match(spec, /\['GET', 'HEAD'\]\.includes\(request\.method\(\)\)/u);
  assert.match(spec, /url\.origin !== ALLOWED_ORIGIN/u);
  assert.match(spec, /forbiddenRequests\.push\(\{[\s\S]*method:[\s\S]*origin:[\s\S]*pathname:/u);
  assert.match(spec, /expect\([\s\S]*forbiddenRequests[\s\S]*\)\.toEqual\(\[\]\)/u);
  const sanitizedRecord = /forbiddenRequests\.push\((\{[\s\S]*?\})\);/u.exec(spec)?.[1] || '';
  assert.doesNotMatch(sanitizedRecord, /headers|postData|request\.url/u);
  assert.doesNotMatch(spec, /route\.fulfill|request\.(?:post|put|patch|delete)|addInitScript|setContent/u);
  assert.match(spec, /query: 'Devin', expectedArtist: 'Devin Townsend'/u);
  assert.match(spec, /query: 'Neal Morse', expectedArtist: 'Neal Morse'/u);
  assert.doesNotMatch(spec, /viewStateRevision/u);
  assert.doesNotMatch(spec, /waitForGalleryReady/u);
  assert.ok(spec.indexOf('waitForVisible') < spec.indexOf('waitForStatusResult'));
  assert.ok(spec.indexOf('waitForStatusResult') < spec.indexOf('measureSyntheticSearchPreviewFirstVisible'));
});

test('production search submit and generation seams avoid the debounce race', () => {
  const actions = read('tests/e2e/actions/searchToolbarActions.js');
  const galleryActions = read('tests/e2e/actions/galleryActions.js');
  const galleryPage = read('tests/e2e/poms/galleryPage.js');
  const observer = read('tests/e2e/helpers/productionViewObserver.js');
  assert.match(actions, /submitPreparedQueryWithEnter[\s\S]*input\.fill\(normalizedQuery\)[\s\S]*input\.press\('Enter'\)/u);
  assert.doesNotMatch(actions.match(/submitPreparedQueryWithEnter[\s\S]*?\n  \}/u)?.[0] || '', /dispatchEvent|\.evaluate\(/u);
  assert.match(observer, /requestGeneration:\s*this\.latestFullRequestSequence/u);
  assert.match(galleryPage, /renderGeneration:[\s\S]*latestRender\?\.renderGeneration/u);
  assert.match(galleryActions, /generationAfter\.requestGeneration > generationBefore\.requestGeneration/u);
  assert.match(galleryActions, /generationAfter\.renderGeneration > generationBefore\.renderGeneration/u);
});

test('production search captures the expected card paint before Playwright polling', () => {
  const galleryActions = read('tests/e2e/actions/galleryActions.js');
  const galleryPage = read('tests/e2e/poms/galleryPage.js');
  const method = /async measureSyntheticSearchPreviewFirstVisible[\s\S]*?\n  \}/u
    .exec(galleryActions)?.[0] || '';
  const observerStart = method.indexOf('startSearchPreviewFirstVisibleObservation');
  const submission = method.indexOf('submitPreparedQueryWithEnter');
  const expectedCardResolution = method.indexOf('resolveSearchPreviewExpectedCard');
  const capturedTimingRead = method.indexOf('readExpectedPaint(expectedCard)');
  const generationPolling = method.indexOf('expect.poll');

  assert.ok(observerStart >= 0 && observerStart < submission,
    'the read-only browser observer must be installed before search submission');
  assert.ok(expectedCardResolution >= 0 && expectedCardResolution < capturedTimingRead,
    'the exact preview card must come from the parsed payload before its captured timing is read');
  assert.ok(capturedTimingRead >= 0 && capturedTimingRead < generationPolling,
    'the browser-captured first paint must not wait for Playwright generation polling');
  assert.doesNotMatch(method, /previewPaintAtMs\s*=\s*await[\s\S]{0,160}?\.evaluate/u);
  assert.match(galleryPage, /startSearchPreviewFirstVisibleObservation[\s\S]*MutationObserver/u);
  assert.match(galleryPage, /startSearchPreviewFirstVisibleObservation[\s\S]*requestAnimationFrame[\s\S]*requestAnimationFrame/u);
  assert.match(galleryPage, /renderGeneration[\s\S]*baselineRenderGeneration/u);
});

test('production search budgets, readiness, and sanitized timings are exact', async () => {
  const helpers = await import(pathToFileURL(
    path.join(root, 'tests/e2e/helpers/productionSearchBenchmark.js'),
  ));
  assert.deepEqual(helpers.PRODUCTION_SEARCH_FIRST_VISIBLE_BUDGET, {
    targetMs: 800, graceMs: 400, hardCeilingMs: 1200,
  });
  assert.equal(helpers.classifyProductionSearchFirstVisible(800), 'target-met');
  assert.equal(helpers.classifyProductionSearchFirstVisible(801), 'grace-used');
  assert.equal(helpers.classifyProductionSearchFirstVisible(1200), 'grace-used');
  assert.equal(helpers.classifyProductionSearchFirstVisible(1201), 'hard-fail');
  assert.equal(helpers.isProductionSearchHostTelemetryRequest({
    method: 'GET',
    url: 'https://static.cloudflareinsights.com/beacon.min.js/v123?token=hidden',
    allowedOrigin: 'https://sandbox1.albumhaven.org',
  }), true);
  assert.equal(helpers.isProductionSearchHostTelemetryRequest({
    method: 'POST',
    url: 'https://sandbox1.albumhaven.org/cdn-cgi/rum',
    allowedOrigin: 'https://sandbox1.albumhaven.org',
  }), true);
  assert.equal(helpers.isProductionSearchHostTelemetryRequest({
    method: 'POST',
    url: 'https://sandbox1.albumhaven.org/api/search',
    allowedOrigin: 'https://sandbox1.albumhaven.org',
  }), false);
  assert.equal(helpers.isProductionSearchHostTelemetryRequest({
    method: 'GET',
    url: 'https://example.test/beacon.min.js/v123',
    allowedOrigin: 'https://sandbox1.albumhaven.org',
  }), false);
  const payload = {
    search_context: { result_groups: { direct_matches: ['Devin Townsend'] } },
    artist_groups: [{ artist: 'Devin Townsend', albums: [{ name: 'Expected album' }] }],
  };
  assert.equal(helpers.hasDirectSearchPreviewArtist(payload, 'Devin Townsend'), true);
  assert.equal(helpers.expectedAlbumFromSearchPreview(payload, 'Devin Townsend'), 'Expected album');
  assert.deepEqual(helpers.unavailableTiming(), { availability: 'unavailable', valueMs: null });
  assert.deepEqual(helpers.availableTiming(null), { availability: 'unavailable', valueMs: null });
  assert.deepEqual(helpers.availableTiming(undefined), { availability: 'unavailable', valueMs: null });
  assert.deepEqual(helpers.calculateProductionSearchPhaseDurations({
    submittedAtMs: 100,
    previewResponseEndAtMs: 350,
    previewDomReadyAtMs: 410,
    previewPaintAtMs: 425,
    fullHydrationPaintAtMs: 700,
  }), {
    browserProcessingMs: 60,
    fullHydrationMs: 600,
    renderMs: 15,
    responseToFirstVisibleMs: 75,
    submitToFirstVisibleMs: 325,
  });
  assert.throws(() => helpers.calculateProductionSearchPhaseDurations({
    submittedAtMs: 100,
    previewResponseEndAtMs: 350,
    previewDomReadyAtMs: 340,
    previewPaintAtMs: 425,
    fullHydrationPaintAtMs: 700,
  }), /monotonic/u);
  const expectedDatabaseIdentityProof = {
    scheme: 'hmac-sha256-v1',
    keyVersion: 7,
    proof: 'a'.repeat(64),
  };
  assert.deepEqual(helpers.readProductionSearchReadiness({
    album_total: 0,
    relation_projection: { ready: true, builder_version: 'v1' },
    database_identity: {
      ready: true,
      schema_version: 2,
      scheme: expectedDatabaseIdentityProof.scheme,
      key_version: expectedDatabaseIdentityProof.keyVersion,
      proof: expectedDatabaseIdentityProof.proof,
      catalog_album_count: 1,
    },
  }, expectedDatabaseIdentityProof), {
    builderVersion: 'v1',
    catalogAlbumCountPositive: true,
    databaseIdentityMatched: true,
    relationProjectionReady: true,
  });
  assert.throws(() => helpers.readProductionSearchReadiness({
    album_total: 999,
    relation_projection: { ready: true, builder_version: 'v1' },
    database_identity: {
      ready: true,
      schema_version: 2,
      scheme: 'hmac-sha256-v1',
      key_version: 7,
      proof: 'a'.repeat(64),
      catalog_album_count: 0,
    },
  }, expectedDatabaseIdentityProof), /readiness/u);
  assert.throws(() => helpers.readProductionSearchReadiness({
    album_total: 1,
    relation_projection: { ready: false, builder_version: 'v1' },
    database_identity: {
      ready: true,
      schema_version: 2,
      scheme: 'hmac-sha256-v1',
      key_version: 7,
      proof: 'a'.repeat(64),
      catalog_album_count: 1,
    },
  }, expectedDatabaseIdentityProof), /readiness/u);
  assert.throws(() => helpers.readProductionSearchReadiness({
    album_total: 1,
    relation_projection: { ready: true, builder_version: 'v1' },
    database_identity: {
      ready: true,
      schema_version: 2,
      scheme: 'hmac-sha256-v1',
      key_version: 7,
      proof: 'b'.repeat(64),
      catalog_album_count: 1,
    },
  }, expectedDatabaseIdentityProof), /database identity/u);
  assert.throws(() => helpers.readProductionSearchReadiness({
    album_total: 1,
    relation_projection: { ready: true, builder_version: 'v1' },
    database_identity: {
      ready: true,
      schema_version: 1,
      scheme: 'hmac-sha256-v1',
      key_version: 7,
      proof: 'a'.repeat(64),
      catalog_album_count: 1,
    },
  }, expectedDatabaseIdentityProof), /database identity/u);
  const performanceTimes = JSON.parse(read('tests/ci/performance-times.json'));
  assert.deepEqual(performanceTimes['search-browse.searchBrowseReadyMs'].local, {
    targetMs: 800, graceMs: 400, hardCeilingMs: 1200,
  });
  assert.deepEqual(performanceTimes['search-browse.searchBrowseReadyMs'].ci, {
    targetMs: 800, graceMs: 400, hardCeilingMs: 1200,
  });
  assert.equal(
    performanceTimes['artist-family-local-managed-chrome.devinSearchResultsReadyMs'],
    undefined,
  );
  assert.equal(
    performanceTimes['artist-family-local-managed-chrome.nealMorseSearchResultsReadyMs'],
    undefined,
  );
});

test('paired search calibration has isolated identical synthetic cases and one orchestrated command', () => {
  const spec = read('tests/e2e/syntheticLargeLibrary/searchPreviewPairedCalibration.spec.js');
  const artistFamilySpec = read('tests/e2e/syntheticLargeLibrary/artistFamilyResponsiveness.spec.js');
  const packageJson = JSON.parse(read('package.json'));
  const docs = read('docs/production-search-benchmark.md');
  const runner = read('scripts/run-performance-playwright.cjs');

  assert.match(spec, /query: 'Devin', expectedArtist: 'Devin Townsend'/u);
  assert.match(spec, /query: 'Neal Morse', expectedArtist: 'Neal Morse'/u);
  assert.match(spec, /for \(const scenario of SEARCHES\)/u);
  assert.match(spec, /galleryActions\.goto\('\/\?surface=albums'\)/u);
  assert.match(spec, /\{ expectedArtist: scenario\.expectedArtist, timeout: 120000 \}/u);
  assert.doesNotMatch(spec, /evaluateArtistFamilyLocalBenchmark|PRODUCTION_SEARCH_FIRST_VISIBLE_BUDGET|hardCeiling|targetMs|graceMs/u);
  assert.doesNotMatch(
    artistFamilySpec,
    /DEVIN_SEARCH_QUERY|DEVIN_ARTIST|devinSearchResultsReady|nealMorseSearchResultsReady|devin-search-results-ready|neal-morse-search-results-ready/u,
  );
  assert.match(
    runner,
    /PERFORMANCE_TARGETS\['paired-search-calibration'\]\s*=\s*\{[\s\S]*measurementExpected:\s*false/u,
  );
  assert.equal(
    packageJson.scripts['test:e2e:performance:paired-search-calibration'],
    'node scripts/run-paired-search-calibration.cjs',
  );
  assert.match(docs, /npm run test:e2e:performance:paired-search-calibration/u);
  assert.match(docs, /production[^\n]*first/iu);
  assert.match(docs, /synthetic[^\n]*(?:skip|does not run)[^\n]*production[^\n]*fail/iu);
  assert.match(docs, /no synthetic threshold/iu);
});

test('retained production search artifacts exclude payloads and full artist arrays', () => {
  const spec = read('tests/e2e/productionRealData/searchFirstVisible.spec.js');
  const galleryActions = read('tests/e2e/actions/galleryActions.js');
  const attachmentStart = spec.indexOf('const metrics =');
  const attachmentEnd = spec.indexOf('expect(result.directPreviewMatch');
  const metricsSource = spec.slice(attachmentStart, attachmentEnd);
  assert.doesNotMatch(metricsSource, /payload|expectedCard|artist_groups|direct_matches/u);
  assert.match(metricsSource, /browserProcessing:\s*availableTiming\(phaseDurations\.browserProcessingMs\)/u);
  assert.match(metricsSource, /fullHydration:\s*availableTiming\(phaseDurations\.fullHydrationMs\)/u);
  assert.match(metricsSource, /render:\s*availableTiming\(phaseDurations\.renderMs\)/u);
  assert.match(galleryActions, /previewResponseEndAtMs/u);
  assert.match(galleryActions, /fullHydrationPaintAtMs/u);
  assert.match(galleryActions, /fullHydrationGeneration/u);
  assert.match(
    galleryActions,
    /fullHydrationGeneration\.renderGeneration > previewGeneration\.renderGeneration/u,
  );
  assert.match(galleryActions, /payloadTier !== 'search_preview'/u);
  assert.match(galleryActions, /performance\.getEntriesByName/u);
  assert.match(galleryActions, /requestAnimationFrame/u);
  assert.match(spec, /readProductionSearchReadiness/u);
  assert.match(spec, /readProductionSearchDatabaseAttestation/u);
  assert.doesNotMatch(
    metricsSource,
    /databaseIdentityProof|database_identity|hmac-sha256|proof|sha256/u,
  );
  const perCaseAttestation = 'const expectedDatabaseIdentityProof = readProductionSearchDatabaseAttestation()';
  assert.doesNotMatch(spec, /const EXPECTED_DATABASE_IDENTITY_SHA256/u);
  assert.doesNotMatch(spec, /const EXPECTED_DATABASE_IDENTITY_PROOF/u);
  assert.ok(spec.indexOf(perCaseAttestation) > spec.indexOf('await galleryActions.waitForGalleryReady'));
  assert.ok(spec.indexOf(perCaseAttestation) < spec.indexOf('measureSyntheticSearchPreviewFirstVisible'));
});
