const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const {
  _private: terminalSummary,
} = require('./playwright-terminal-summary.cjs');
const {
  assertProviderWriteSafeEnv,
  buildAndAssertProviderWriteSafeEnv,
} = require('./playwright-provider-safety.cjs');
const {
  DEFAULT_PLAYWRIGHT_BROWSER,
  normalizeBrowserSelection,
} = require('./playwright-runtime-flags.cjs');
const { resolvePlaywrightPython } = require('./playwright-python.cjs');
const {
  classifyPerformanceThreshold,
} = require('./performance-threshold-classification.cjs');
const { resolveTimingBudget } = require('./performance-times-contract.cjs');
const {
  _private: { loadDotEnvFile },
} = require('./run-playwright.cjs');

const repoRoot = path.join(__dirname, '..');
const runnerPath = path.join(__dirname, 'run-playwright.cjs');
const performanceHistoryRoot = path.join(repoRoot, 'test-results', 'playwrightPerformanceHistory');
const performanceTargetArtifactsRoot = path.join(
  repoRoot,
  'test-results',
  'playwright-performance-targets',
);
const fixtureProfileLoaderPath = path.join(repoRoot, 'scripts', 'ci', 'load-fixture-profile.py');
const DEFAULT_REPEAT_COUNT = 1;
const DEFAULT_TEST_TIMEOUT_MS = 240000;
const DEFAULT_REAL_APP_PORT = 5001;
const DEFAULT_REAL_APP_PORT_BLOCK_SIZE = 10;
const DEFAULT_SCAN_APP_PORT = 4174;
const DEFAULT_THRESHOLD_RETRY_TOTAL_RUNS = 3;
const SCAN_STATUS_SAMPLES_ROOT = path.join(repoRoot, '.tmp', 'playwright-scan-status');
const SCAN_PERFORMANCE_APP_PATH = path.join(repoRoot, 'tests', 'e2e', 'support', 'scanPerformanceApp.py');
const SCAN_SETUP_DATABASE_ENV = 'ALBUM_HAVEN_SCAN_PERFORMANCE_SETUP_DATABASE_URL';
const SCAN_RUNTIME_DATABASE_ENV = 'ALBUM_HAVEN_SCAN_PERFORMANCE_DATABASE_URL';
const SCAN_ALLOW_SHARED_DATABASE_ENV = 'ALBUM_HAVEN_SCAN_PERFORMANCE_ALLOW_SHARED_DATABASE';
const SCAN_DATABASE_RUNBOOK = '.env.example';
const PERFORMANCE_CHILD_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SCAN_DATABASE_NAME = 'album_haven_scan_e2e';
const SCAN_SETUP_DATABASE_ROLE = 'album_haven_migrator';
const SCAN_RUNTIME_DATABASE_ROLE = 'album_haven_app';
const PRELOADED_RELEASE_FIXTURE_MODE = 'preloaded-release';
const GENERATED_ISOLATED_FIXTURE_MODE = 'generated-isolated';
const OWNER_RUNTIME_ENV_KEYS = Object.freeze([
  'MUSIC_DIR',
  'MUSIC_APP_DATA_DIR',
  'MUSIC_CACHE_PATH',
  'MUSIC_COVER_CACHE_PATH',
  'MUSIC_LIBRARY_ROOTS_PATH',
  'PLAYWRIGHT_REAL_APP_URL',
]);
const LIVE_COVER_PROVIDER_DOMAIN_SUFFIXES = Object.freeze([
  'apple.com',
  'mzstatic.com',
  'deezer.com',
  'dzcdn.net',
  'youtube.com',
  'youtu.be',
  'ytimg.com',
  'googlevideo.com',
  'googleapis.com',
  'googleusercontent.com',
  'ggpht.com',
  'spotify.com',
  'spotifycdn.com',
  'scdn.co',
  'genius.com',
  'discogs.com',
  'coverartarchive.org',
  'musicbrainz.org',
  'bandcamp.com',
  'bcbits.com',
  'archive.org',
]);
const PLAYWRIGHT_LAST_RUN_DIR_BY_CONFIG = Object.freeze({
  'playwright.config.cjs': 'default',
  'playwright.synthetic-large-library.config.cjs': 'synthetic-large-library',
  'playwright.utility-problematic-files.config.cjs': 'utility-problematic-files',
  'playwright.performance.config.cjs': 'performance',
  'playwright.scan-performance.config.cjs': 'scan-performance',
});
const KNOWN_UNSAFE_BROWSER_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);
const PERFORMANCE_GROUPS = Object.freeze({
  all: [
    'idle-memory',
    'playback-start',
    'gapless-playback',
    'all-artists',
    'artist-family',
    'search-all-artists',
    'utility-problematic-files',
    'utility-rules',
    'selected-artist',
    'search-browse',
    'root-album-browse',
    'app-open-all-artists',
    'problematic-files-focused',
    'rules-focused',
    'scan-cold',
    'scan-cached',
    'scan-add-album',
    'scan-metadata',
    'scan-page',
  ],
  'idle-memory': [
    'idle-memory',
  ],
  'playback-start': [
    'playback-start',
  ],
  'gapless-playback': [
    'gapless-playback',
  ],
  'real-app': [
    'all-artists',
    'artist-family',
    'search-all-artists',
    'utility-problematic-files',
    'utility-rules',
    'selected-artist',
    'search-browse',
    'root-album-browse',
    'app-open-all-artists',
    'problematic-files-focused',
    'rules-focused',
  ],
  scan: [
    'scan-cold',
    'scan-cached',
    'scan-add-album',
    'scan-metadata',
    'scan-page',
  ],
});

const PERFORMANCE_TARGETS = {
  'idle-memory': {
    kind: 'isolated',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-isolated-postgres-memory',
    coverageDescription: 'Production-app browser memory retention coverage backed by isolated Postgres fixtures.',
    specPath: 'tests/e2e/performance/idleMemory.spec.js',
    aliasNames: ['idle-memory', 'idle', 'memory'],
    reportId: 'idleMemory',
    casePattern: 'FTC-GALLERY-STARTUP-005',
    grep: '(FTC-OPS-019|FTC-GALLERY-STARTUP-005)',
    casePatterns: ['FTC-OPS-019', 'FTC-GALLERY-STARTUP-005'],
  },
  'playback-start': {
    kind: 'isolated',
    fixtureProfile: 'playback-media',
    fixtureMode: GENERATED_ISOLATED_FIXTURE_MODE,
    coverageClass: 'real-app-isolated-postgres-playback',
    coverageDescription: 'Production album-detail playback-start and repeated-use coverage backed by isolated Postgres and generated MP3 media.',
    specPath: 'tests/e2e/performance/playbackStart.spec.js',
    aliasNames: ['playback-start', 'player-start', 'album-playback-start'],
    reportId: 'playbackStart',
    casePattern: 'FTC-PLAYER-013',
  },
  'gapless-playback': {
    kind: 'isolated',
    fixtureProfile: 'playback-media',
    fixtureMode: GENERATED_ISOLATED_FIXTURE_MODE,
    coverageClass: 'real-app-isolated-postgres-playback',
    coverageDescription: 'Production WebSocket/worklet gapless-boundary coverage backed by isolated Postgres and generated lossless/VBR media.',
    specPath: 'tests/e2e/performance/gaplessPlayback.spec.js',
    aliasNames: ['gapless-playback', 'gapless', 'playback-boundary'],
    reportId: 'gaplessPlayback',
    casePattern: 'FTC-PLAYER-016',
    grep: '(FTC-PLAYER-016|FTC-PLAYER-013 immediate Album Details replacement)',
    casePatterns: ['FTC-PLAYER-016', 'FTC-PLAYER-013 immediate Album Details replacement'],
  },
  'all-artists': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app broad All Artists startup, round-trip, deep-scroll, album-details, and memory coverage through the selected library_browse repository.',
    specPath: 'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
    grep: 'FTC-GALLERY-STARTUP-005A',
    aliasNames: ['all-artists', 'all-artists-round-trip', 'library-browse-all-artists'],
    reportId: 'allArtistsLocal',
    casePattern: 'FTC-GALLERY-STARTUP-005A',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'artist-family': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app selected-artist and artist-family browse/load coverage through the selected library_browse repository with visible Neal Morse family interactions.',
    specPath: 'tests/e2e/syntheticLargeLibrary/artistFamilyResponsiveness.spec.js',
    aliasNames: ['artist-family', 'family', 'neal-morse-family'],
    reportId: 'artistFamilyLocal',
    casePattern: 'FTC-SEARCH-NAV-005A',
    casePatterns: [
      'Neal Morse scrolling keeps each displayed artist heading unique before and after filtering',
      'Neal Morse family search, filters, details, settings, and clear-search flows stay responsive on synthetic data',
    ],
    metricCasePattern: 'Neal Morse family search, filters, details, settings, and clear-search flows stay responsive on synthetic data',
    supportsAggregatedThresholdRetries: true,
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'search-all-artists': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app multi-family search, search-scoped All Artists, follow-up tree selection, and memory coverage through the selected library_browse repository.',
    specPath: 'tests/e2e/syntheticLargeLibrary/allArtistsResponsiveness.spec.js',
    grep: 'FTC-SEARCH-NAV-003A',
    aliasNames: ['search-all-artists', 'search-all-artists-round-trip', 'library-browse-search-all-artists'],
    reportId: 'searchAllArtistsLocal',
    casePattern: 'FTC-SEARCH-NAV-003A',
    casePatterns: [
      'FTC-SEARCH-NAV-005 direct-loads a filtered Ария gallery',
      'FTC-SEARCH-NAV-026 clears an Ария search',
      'FTC-SEARCH-NAV-003A multi-family search keeps search-scoped All artists',
    ],
    metricCasePattern: 'FTC-SEARCH-NAV-003A multi-family search keeps search-scoped All artists',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'utility-problematic-files': {
    kind: 'synthetic',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Isolated production-app broad Problematic Files responsiveness coverage through generated media and normal Postgres product tables, including search, per-problem filtering, detail updates, and memory.',
    specPath: 'tests/e2e/utilityProblematicFiles/utilitiesResponsiveness.spec.js',
    fixtureProfile: 'utility-problematic-files',
    grep: 'FTC-UTIL-PROBLEMS-009',
    aliasNames: ['utility-problematic-files', 'problematic-files', 'library-browse-utility-problematic-files'],
    reportId: 'utilityProblematicFilesLocal',
    casePattern: 'FTC-UTIL-PROBLEMS-009',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
      ALBUM_HAVEN_E2E_FIXTURE_PROFILE: 'utility-problematic-files',
      ALBUM_HAVEN_UTILITY_PROJECTION_PREWARM_ENABLED: '0',
      PLAYWRIGHT_ISOLATED_LIBRARY_APP: '1',
    },
  },
  'utility-rules': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app broad Rules utility responsiveness coverage through the selected utility projection, including sibling utility-tab readiness and memory.',
    specPath: 'tests/e2e/syntheticLargeLibrary/utilitiesResponsiveness.spec.js',
    grep: 'FTC-UTIL-RULES-002',
    aliasNames: ['utility-rules', 'rules', 'library-browse-utility-rules'],
    reportId: 'utilityRulesLocal',
    casePattern: 'FTC-UTIL-RULES-002',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'selected-artist': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app selected-artist UI coverage through the selected library_browse repository; search, utility projections, and root gallery flows remain separate visible targets.',
    specPath: 'tests/e2e/syntheticLargeLibrary/selectedArtist.spec.js',
    grep: 'FTC-GALLERY-STARTUP-005Q',
    aliasNames: ['selected-artist', 'artist', 'library-browse-artist'],
    reportId: 'selectedArtistFocusedLocal',
    casePattern: 'FTC-GALLERY-STARTUP-005Q',
    casePatterns: [
      'Selected artist UI reports library_browse telemetry and timing',
      'FTC-ARTIST-FAMILY-004 keeps the IR8 / Sexoturica split release in the Devin Townsend family',
    ],
    metricCasePattern: 'Selected artist UI reports library_browse telemetry and timing',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'search-browse': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app visible search UI coverage through the selected library_browse repository; Perfect Search parity, alias/family/related/person search behavior, utility projections, and root gallery flows remain separate targets.',
    specPath: 'tests/e2e/syntheticLargeLibrary/searchBrowse.spec.js',
    grep: 'FTC-GALLERY-STARTUP-005R',
    aliasNames: ['search-browse', 'search', 'library-browse-search'],
    reportId: 'searchBrowseFocusedLocal',
    casePattern: 'FTC-GALLERY-STARTUP-005R',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'root-album-browse': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app root All Artists gallery UI coverage through the selected library_browse repository; distinct from selected-artist, search-scoped All Artists, and utility targets.',
    specPath: 'tests/e2e/syntheticLargeLibrary/rootAlbumBrowse.spec.js',
    grep: 'FTC-GALLERY-STARTUP-005S',
    aliasNames: ['root-album-browse', 'root-albums', 'library-browse-root-albums'],
    reportId: 'rootAlbumBrowseFocusedLocal',
    casePattern: 'FTC-GALLERY-STARTUP-005S',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'app-open-all-artists': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app-open loader-first root route plus visible All Artists UI readiness through selected runtime seams.',
    specPath: 'tests/e2e/syntheticLargeLibrary/appOpenAllArtists.spec.js',
    grep: 'FTC-GALLERY-STARTUP-005T',
    aliasNames: ['app-open-all-artists', 'all-artists-ui', 'library-browse-app-open-all-artists'],
    reportId: 'appOpenAllArtistsFocusedLocal',
    casePattern: 'FTC-GALLERY-STARTUP-005T',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'problematic-files-focused': {
    kind: 'synthetic',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Isolated production-app Problematic Files UI coverage through normal Postgres product tables and the selected utility route surface.',
    specPath: 'tests/e2e/utilityProblematicFiles/utilityProblematicFiles.spec.js',
    fixtureProfile: 'utility-problematic-files',
    grep: 'FTC-UTIL-PROBLEMS-010',
    aliasNames: ['problematic-files-focused', 'problematic-files-ui', 'library-browse-problematic-files'],
    reportId: 'problematicFilesFocusedLocal',
    casePattern: 'FTC-UTIL-PROBLEMS-010',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
      ALBUM_HAVEN_E2E_FIXTURE_PROFILE: 'utility-problematic-files',
      PLAYWRIGHT_ISOLATED_LIBRARY_APP: '1',
    },
  },
  'rules-focused': {
    kind: 'synthetic',
    fixtureProfile: 'synthetic-large-library',
    fixtureMode: PRELOADED_RELEASE_FIXTURE_MODE,
    coverageClass: 'real-app-library-browse-load',
    coverageDescription: 'Real local app visible Settings > Rules UI coverage through the selected utility projection surface; narrower than the broader utility responsiveness suite, but not API-only.',
    specPath: 'tests/e2e/syntheticLargeLibrary/utilityRules.spec.js',
    grep: 'FTC-UTIL-RULES-002P',
    aliasNames: ['rules-focused', 'rules-ui', 'library-browse-rules'],
    reportId: 'rulesFocusedLocal',
    casePattern: 'FTC-UTIL-RULES-002P',
    env: {
      ALBUM_HAVEN_PERSISTENCE_LIBRARY_BROWSE: 'postgres',
    },
  },
  'scan-cold': {
    kind: 'scan',
    fixtureProfile: 'scan-library',
    fixtureMode: GENERATED_ISOLATED_FIXTURE_MODE,
    coverageClass: 'scanner-index-cache',
    coverageDescription: 'Synthetic filesystem scanner/index/cache benchmark using generated temporary media fixtures; not a real-app Postgres browse/load benchmark.',
    specPath: 'tests/e2e/scanPerformance/scanPerformance.spec.js',
    grep: 'FTC-OPS-014',
    aliasNames: ['scan-cold'],
    reportId: 'scanColdLocal',
    casePattern: 'FTC-OPS-014',
    env: {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO: 'cold',
      ALBUM_HAVEN_COVER_PROVIDER_GROUPS: 'offline',
    },
  },
  'scan-cached': {
    kind: 'scan',
    fixtureProfile: 'scan-library',
    fixtureMode: GENERATED_ISOLATED_FIXTURE_MODE,
    coverageClass: 'scanner-index-cache',
    coverageDescription: 'Synthetic filesystem scanner/index/cache benchmark for unchanged generated fixture cache startup; not a real-app Postgres browse/load benchmark.',
    specPath: 'tests/e2e/scanPerformance/scanPerformance.spec.js',
    grep: 'FTC-OPS-015',
    aliasNames: ['scan-cached', 'scan-unchanged-cache'],
    reportId: 'scanCachedLocal',
    casePattern: 'FTC-OPS-015',
    env: {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO: 'cached',
      ALBUM_HAVEN_COVER_PROVIDER_GROUPS: 'offline',
    },
  },
  'scan-add-album': {
    kind: 'scan',
    fixtureProfile: 'scan-library',
    fixtureMode: GENERATED_ISOLATED_FIXTURE_MODE,
    coverageClass: 'scanner-index-cache',
    coverageDescription: 'Synthetic filesystem scanner/index/cache benchmark for generated fixture incremental album addition; not a real-app Postgres browse/load benchmark.',
    specPath: 'tests/e2e/scanPerformance/scanPerformance.spec.js',
    grep: 'FTC-OPS-016',
    aliasNames: ['scan-add-album', 'scan-incremental-add'],
    reportId: 'scanAddAlbumLocal',
    casePattern: 'FTC-OPS-016',
    env: {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO: 'add-album',
      ALBUM_HAVEN_COVER_PROVIDER_GROUPS: 'offline',
    },
  },
  'scan-metadata': {
    kind: 'scan',
    fixtureProfile: 'scan-library',
    fixtureMode: GENERATED_ISOLATED_FIXTURE_MODE,
    coverageClass: 'scanner-index-cache',
    coverageDescription: 'Synthetic filesystem scanner/index/cache benchmark for generated fixture metadata mutation; not a real-app Postgres browse/load benchmark.',
    specPath: 'tests/e2e/scanPerformance/scanPerformance.spec.js',
    grep: 'FTC-OPS-017',
    aliasNames: ['scan-metadata', 'scan-incremental-metadata'],
    reportId: 'scanMetadataLocal',
    casePattern: 'FTC-OPS-017',
    env: {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO: 'metadata',
      ALBUM_HAVEN_COVER_PROVIDER_GROUPS: 'offline',
    },
  },
  'scan-page': {
    kind: 'scan',
    fixtureProfile: 'scan-library',
    fixtureMode: GENERATED_ISOLATED_FIXTURE_MODE,
    coverageClass: 'scanner-index-cache',
    coverageDescription: 'Production-path Scan Page functional coverage using generated temporary media and isolated Postgres-backed scanner state.',
    specPath: 'tests/e2e/scanPerformance/scanPerformance.spec.js',
    grep: 'FTC-OPS-003(C|E)',
    aliasNames: ['scan-page', 'scan-page-context'],
    casePatterns: ['FTC-OPS-003C', 'FTC-OPS-003E'],
    measurementExpected: false,
    env: {
      ALBUM_HAVEN_SCAN_PERFORMANCE_SCENARIO: 'add-album',
      ALBUM_HAVEN_COVER_PROVIDER_GROUPS: 'offline',
    },
  },
};

const TARGETS_BY_ALIAS = new Map(
  Object.values(PERFORMANCE_TARGETS)
    .flatMap((target) => target.aliasNames.map((alias) => [alias, target]))
);

function scanDatabasePreflightError(reason) {
  return new Error([
    `Scan performance database preflight failed: ${reason}`,
    `Scan targets reset app-owned tables and require the existing dedicated ${SCAN_DATABASE_NAME} database.`,
    `Set ${SCAN_SETUP_DATABASE_ENV}=postgresql://${SCAN_SETUP_DATABASE_ROLE}@localhost:5432/${SCAN_DATABASE_NAME}`,
    `Set ${SCAN_RUNTIME_DATABASE_ENV}=postgresql://${SCAN_RUNTIME_DATABASE_ROLE}@localhost:5432/${SCAN_DATABASE_NAME}`,
    'For local passwordless automation, set PGPASSFILE to your PostgreSQL password file.',
    `Database and role provisioning instructions: ${SCAN_DATABASE_RUNBOOK}`,
    'The performance runner will not create database roles and must never run scan targets against album_haven_core.',
  ].join('\n'));
}

function parseScanDatabaseUrl(envName, rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    throw scanDatabasePreflightError(`${envName} is not a valid Postgres URL.`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw scanDatabasePreflightError(`${envName} must use a postgres or postgresql URL.`);
  }
  if (parsed.password || parsed.search || parsed.hash) {
    throw scanDatabasePreflightError(
      `${envName} must be passwordless and must not include query or fragment connection overrides.`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    throw scanDatabasePreflightError(`${envName} must use a loopback database host.`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).trim().toLowerCase();
  if (!databaseName || databaseName === 'album_haven_core') {
    throw scanDatabasePreflightError(`${envName} must target an isolated scan database, not album_haven_core.`);
  }
  return {
    databaseName,
    host,
    port: parsed.port || '5432',
    protocol: parsed.protocol,
    username: decodeURIComponent(parsed.username || '').toLowerCase(),
  };
}

function assertScanPerformanceDatabaseConfiguration(targets, env) {
  if (!targets.some((target) => target.kind === 'scan')) {
    return;
  }
  const missingEnvNames = [SCAN_SETUP_DATABASE_ENV, SCAN_RUNTIME_DATABASE_ENV].filter(
    (envName) => !String(env[envName] || '').trim(),
  );
  if (missingEnvNames.length > 0) {
    throw scanDatabasePreflightError(`missing ${missingEnvNames.join(' and ')}.`);
  }
  const setupIdentity = parseScanDatabaseUrl(
    SCAN_SETUP_DATABASE_ENV,
    String(env[SCAN_SETUP_DATABASE_ENV]).trim(),
  );
  const runtimeIdentity = parseScanDatabaseUrl(
    SCAN_RUNTIME_DATABASE_ENV,
    String(env[SCAN_RUNTIME_DATABASE_ENV]).trim(),
  );
  const setupDatabaseIdentity = [
    setupIdentity.protocol,
    setupIdentity.host,
    setupIdentity.port,
    setupIdentity.databaseName,
  ].join('|');
  const runtimeDatabaseIdentity = [
    runtimeIdentity.protocol,
    runtimeIdentity.host,
    runtimeIdentity.port,
    runtimeIdentity.databaseName,
  ].join('|');
  if (setupDatabaseIdentity !== runtimeDatabaseIdentity) {
    throw scanDatabasePreflightError(
      `${SCAN_SETUP_DATABASE_ENV} and ${SCAN_RUNTIME_DATABASE_ENV} must target the same isolated database.`,
    );
  }
  if (String(env[SCAN_ALLOW_SHARED_DATABASE_ENV] || '').trim()) {
    throw scanDatabasePreflightError(
      `${SCAN_ALLOW_SHARED_DATABASE_ENV} is a broad shared-database bypass and is not allowed.`,
    );
  }
  if (setupIdentity.databaseName === SCAN_DATABASE_NAME) {
    if (setupIdentity.username !== SCAN_SETUP_DATABASE_ROLE
      || runtimeIdentity.username !== SCAN_RUNTIME_DATABASE_ROLE) {
      throw scanDatabasePreflightError(
        `the dedicated local identity requires ${SCAN_SETUP_DATABASE_ROLE}/${SCAN_RUNTIME_DATABASE_ROLE} roles.`,
      );
    }
    return;
  }

  const suffixMatch = /^album_haven_ci_([a-z0-9]+(?:_[a-z0-9]+)*)$/.exec(
    setupIdentity.databaseName,
  );
  if (!suffixMatch) {
    throw scanDatabasePreflightError(
      `database must be the dedicated ${SCAN_DATABASE_NAME} identity or album_haven_ci_<suffix>.`,
    );
  }
  const suffix = suffixMatch[1];
  const expectedSetupRole = `${SCAN_SETUP_DATABASE_ROLE}_${suffix}`;
  const expectedRuntimeRole = `${SCAN_RUNTIME_DATABASE_ROLE}_${suffix}`;
  if (setupIdentity.username !== expectedSetupRole
    || runtimeIdentity.username !== expectedRuntimeRole) {
    throw scanDatabasePreflightError(
      `CI database suffix ${suffix} requires matching ${expectedSetupRole}/${expectedRuntimeRole} roles.`,
    );
  }
}

function assertPerformanceTargetFixtureConfiguration(targets, env) {
  for (const target of targets) {
    const targetName = target.aliasNames?.[0] || target.specPath;
    const expectedProfile = String(target.fixtureProfile || '').trim();
    const selectedProfile = String(env.ALBUM_HAVEN_FIXTURE_PROFILE || '').trim();
    if (!expectedProfile || selectedProfile !== expectedProfile) {
      throw new Error(
        `Performance target ${targetName} requires ALBUM_HAVEN_FIXTURE_PROFILE=${expectedProfile}.`,
      );
    }
    if (String(env.PLAYWRIGHT_REAL_APP || '').trim() === '1') {
      throw new Error(
        `Performance target ${targetName} rejects PLAYWRIGHT_REAL_APP owner mode.`,
      );
    }
    for (const envName of OWNER_RUNTIME_ENV_KEYS) {
      if (String(env[envName] || '').trim()) {
        throw new Error(
          `Performance target ${targetName} rejects inherited owner or generic runtime root ${envName}.`,
        );
      }
    }

    const fixtureRoot = String(env.ALBUM_HAVEN_FIXTURE_ROOT || '').trim();
    const mediaRoot = String(env.ALBUM_HAVEN_MEDIA_ROOT || '').trim();
    if (target.fixtureMode === PRELOADED_RELEASE_FIXTURE_MODE) {
      if (!fixtureRoot || !mediaRoot || !path.isAbsolute(fixtureRoot) || !path.isAbsolute(mediaRoot)) {
        throw new Error(
          `Performance target ${targetName} uses fixture mode preloaded-release and requires absolute ALBUM_HAVEN_FIXTURE_ROOT and ALBUM_HAVEN_MEDIA_ROOT.`,
        );
      }
      const expectedMediaRoot = path.resolve(path.resolve(fixtureRoot), 'media');
      if (path.resolve(mediaRoot) !== expectedMediaRoot) {
        throw new Error(
          `Performance target ${targetName} requires ALBUM_HAVEN_MEDIA_ROOT to be the exact media directory under ALBUM_HAVEN_FIXTURE_ROOT.`,
        );
      }
      continue;
    }
    if (target.fixtureMode === GENERATED_ISOLATED_FIXTURE_MODE) {
      if (fixtureRoot || mediaRoot) {
        throw new Error(
          `Performance target ${targetName} uses fixture mode generated-isolated and rejects inherited ALBUM_HAVEN_FIXTURE_ROOT or ALBUM_HAVEN_MEDIA_ROOT.`,
        );
      }
      continue;
    }
    throw new Error(`Performance target ${targetName} has unsupported fixture mode ${target.fixtureMode}.`);
  }
}

function runScanPerformanceDatabasePreflight(targets, env, spawnSync = childProcess.spawnSync) {
  if (!targets.some((target) => target.kind === 'scan')) return;
  const result = spawnSync(
    resolvePlaywrightPython(env),
    [SCAN_PERFORMANCE_APP_PATH, '--preflight-only'],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
      timeout: 30000,
    },
  );
  if (result?.error || result?.status !== 0) {
    throw scanDatabasePreflightError(
      'read-only connectivity or connected database-role identity verification failed.',
    );
  }
}

function runConfiguredPerformanceSuite(args, baseEnv = process.env, dependencies = {}) {
  const loadEnv = dependencies.loadEnv || ((env) => loadDotEnvFile(env));
  const runDatabasePreflight = dependencies.runDatabasePreflight || runScanPerformanceDatabasePreflight;
  const runSuite = dependencies.runSuite || runSequentialPerformanceSuite;
  const targets = resolveRequestedTargets(args);
  assertSinglePreloadedFixtureProfile(targets);
  const childEnv = loadEnv({ ...baseEnv });
  assertPerformanceTargetFixtureConfiguration(targets, childEnv);
  const preparedFixture = args.preparedFixture === true;
  assertScanPerformanceDatabaseConfiguration(targets, childEnv);
  runDatabasePreflight(targets, childEnv);
  return runSuite({
    ...args,
    selectedContract: args.selectedContract || 'local',
    trustedCi: args.trustedCi === true,
    preparedFixture,
    ...resolveConfiguredPerformanceBasePorts(childEnv),
  });
}

function resolveConfiguredPerformanceBasePort(env, name, fallback) {
  const rawValue = String(env?.[name] ?? '').trim();
  if (!rawValue) return fallback;
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535. Received: ${rawValue}`);
  }
  return port;
}

function resolveConfiguredPerformanceBasePorts(env = {}) {
  return {
    realAppBasePort: resolveConfiguredPerformanceBasePort(
      env,
      'PLAYWRIGHT_REAL_APP_PORT',
      DEFAULT_REAL_APP_PORT,
    ),
    scanAppBasePort: resolveConfiguredPerformanceBasePort(
      env,
      'PLAYWRIGHT_PORT',
      DEFAULT_SCAN_APP_PORT,
    ),
  };
}

function resolveManagedRealAppPortForSequence(sequenceIndex, basePort = DEFAULT_REAL_APP_PORT) {
  const normalizedSequenceIndex = Number.isInteger(sequenceIndex) && sequenceIndex > 0 ? sequenceIndex : 0;
  let candidatePort = Number.isInteger(basePort) && basePort > 0
    ? basePort
    : DEFAULT_REAL_APP_PORT;
  let safeBlockIndex = 0;
  while (safeBlockIndex < normalizedSequenceIndex) {
    candidatePort += DEFAULT_REAL_APP_PORT_BLOCK_SIZE;
    while (managedRealAppPortBlockHasUnsafeBrowserPort(candidatePort)) {
      candidatePort += DEFAULT_REAL_APP_PORT_BLOCK_SIZE;
    }
    safeBlockIndex += 1;
  }
  return candidatePort;
}

function resolveManagedRealAppAttemptPort(basePort, attemptNumber) {
  const normalizedBasePort = Number.isInteger(basePort) && basePort > 0
    ? basePort
    : DEFAULT_REAL_APP_PORT;
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 1) {
    return normalizedBasePort;
  }
  return normalizedBasePort + (attemptNumber - 1);
}

function isKnownUnsafeBrowserPort(port) {
  return Number.isInteger(port) && KNOWN_UNSAFE_BROWSER_PORTS.has(port);
}

function managedRealAppPortBlockHasUnsafeBrowserPort(basePort, blockSize = DEFAULT_REAL_APP_PORT_BLOCK_SIZE) {
  if (!Number.isInteger(basePort) || basePort <= 0 || !Number.isInteger(blockSize) || blockSize <= 0) {
    return false;
  }
  for (let offset = 0; offset < blockSize; offset += 1) {
    if (isKnownUnsafeBrowserPort(basePort + offset)) {
      return true;
    }
  }
  return false;
}

function normalizeTargetKey(rawValue) {
  return String(rawValue || '').trim().toLowerCase();
}

function parseIntegerOption(rawValue, flagName) {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive integer. Received: ${rawValue}`);
  }
  return value;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const preparedFixtureDefaults = { preparedFixture: false };
  const options = {
    browser: DEFAULT_PLAYWRIGHT_BROWSER,
    grep: '',
    group: 'all',
    headless: true,
    repeatCount: DEFAULT_REPEAT_COUNT,
    targetInput: '',
  };
  Object.defineProperty(options, 'preparedFixture', {
    value: preparedFixtureDefaults.preparedFixture,
    writable: true,
    enumerable: false,
  });
  Object.defineProperty(options, 'selectedContract', {
    value: 'local', writable: true, enumerable: false,
  });
  Object.defineProperty(options, 'trustedCi', {
    value: false, writable: true, enumerable: false,
  });

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--headless') {
      options.headless = true;
      continue;
    }
    if (arg === '--headed') {
      options.headless = false;
      continue;
    }
    if (arg === '--prepared-fixture') {
      options.preparedFixture = true;
      continue;
    }
    if (arg === '--performance-contract' || arg.startsWith('--performance-contract=')) {
      options.selectedContract = arg === '--performance-contract'
        ? String(argv[++index] || '').trim().toLowerCase()
        : arg.slice('--performance-contract='.length).trim().toLowerCase();
      if (!['local', 'ci'].includes(options.selectedContract)) {
        throw new Error('--performance-contract must be local or ci.');
      }
      if (options.selectedContract === 'ci') {
        options.trustedCi = process.env.GITHUB_ACTIONS === 'true'
          && process.env.GITHUB_EVENT_NAME === 'pull_request';
        if (!options.trustedCi) {
          throw new Error('The CI performance contract requires a trusted GitHub Actions pull_request run.');
        }
      }
      continue;
    }
    if (arg === '--group') {
      options.group = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--group=')) {
      options.group = arg.slice('--group='.length);
      continue;
    }
    if (arg === '--test') {
      options.targetInput = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--test=')) {
      options.targetInput = arg.slice('--test='.length);
      continue;
    }
    if (arg === '--repeat-count') {
      options.repeatCount = parseIntegerOption(argv[index + 1], '--repeat-count');
      index += 1;
      continue;
    }
    if (arg.startsWith('--repeat-count=')) {
      options.repeatCount = parseIntegerOption(arg.slice('--repeat-count='.length), '--repeat-count');
      continue;
    }
    if (arg === '--browser') {
      options.browser = normalizeBrowserSelection(argv[index + 1] || '', {});
      index += 1;
      continue;
    }
    if (arg === '--grep') {
      options.grep = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg.startsWith('--browser=')) {
      options.browser = normalizeBrowserSelection(arg.slice('--browser='.length), {});
      continue;
    }
    if (arg.startsWith('--grep=')) {
      options.grep = arg.slice('--grep='.length);
      continue;
    }
    if (!options.targetInput && !arg.startsWith('--')) {
      options.targetInput = arg;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  return options;
}

function resolveNamedTarget(targetInput) {
  return TARGETS_BY_ALIAS.get(normalizeTargetKey(targetInput)) || null;
}

function normalizeRelativeSpecPath(targetInput) {
  const candidatePath = path.isAbsolute(targetInput)
    ? targetInput
    : path.resolve(repoRoot, targetInput);
  return path.relative(repoRoot, candidatePath).replace(/\\/g, '/');
}

function resolvePathTarget(targetInput) {
  const specPath = normalizeRelativeSpecPath(targetInput);
  const knownTargets = Object.values(PERFORMANCE_TARGETS).filter((target) => target.specPath === specPath);
  if (knownTargets.length === 1) {
    return knownTargets[0];
  }
  if (specPath === PERFORMANCE_TARGETS['idle-memory'].specPath) {
    return {
      ...PERFORMANCE_TARGETS['idle-memory'],
      specPath,
    };
  }
  if (
    specPath === PERFORMANCE_TARGETS['artist-family'].specPath
    || specPath.includes('/syntheticLargeLibrary/')
    || specPath.includes('/utilityProblematicFiles/')
  ) {
    return {
    kind: 'synthetic',
      specPath,
      aliasNames: [],
    };
  }
  if (
    specPath === PERFORMANCE_TARGETS['scan-cold'].specPath
    || specPath.includes('/scanPerformance/')
  ) {
    return {
      kind: 'scan',
      specPath,
      aliasNames: [],
    };
  }
  throw new Error(
    `Unsupported performance spec path: ${targetInput}. `
    + 'Use one of the known names or a supported performance spec path.'
  );
}

function resolvePerformanceTarget(targetInput) {
  const namedTarget = resolveNamedTarget(targetInput);
  if (namedTarget) {
    return namedTarget;
  }
  return resolvePathTarget(targetInput);
}

function listDefaultPerformanceTargets() {
  return PERFORMANCE_GROUPS.all.map((targetKey) => PERFORMANCE_TARGETS[targetKey]);
}

function listGroupedPerformanceTargets(group = 'all') {
  const normalizedGroup = normalizeTargetKey(group) || 'all';
  const groupTargets = PERFORMANCE_GROUPS[normalizedGroup];
  if (!groupTargets) {
    throw new Error(
      `Unsupported performance group: ${group}. `
      + `Use one of: ${Object.keys(PERFORMANCE_GROUPS).join(', ')}.`
    );
  }
  return groupTargets.map((targetKey) => PERFORMANCE_TARGETS[targetKey]);
}

function summarizePerformanceTargets(targets = listDefaultPerformanceTargets()) {
  return targets.map((target) => ({
    name: target.aliasNames[0] || target.specPath,
    kind: target.kind,
    coverageClass: target.coverageClass || 'unclassified',
    description: target.coverageDescription || '',
    specPath: target.specPath,
    casePattern: target.casePattern || target.grep || '',
  }));
}

function resolveRequestedTargets(options) {
  if (!String(options.targetInput || '').trim()) {
    return listGroupedPerformanceTargets(options.group);
  }
  return [resolvePerformanceTarget(options.targetInput)];
}

function assertSinglePreloadedFixtureProfile(targets) {
  const fixtureProfiles = [...new Set(
    targets
      .filter((target) => target.kind === 'synthetic')
      .map((target) => String(target.fixtureProfile || 'synthetic-large-library').trim())
      .filter(Boolean),
  )];
  if (fixtureProfiles.length > 1) {
    throw new Error(
      'A grouped performance run cannot combine preloaded fixture profiles '
      + `${fixtureProfiles.join(', ')} without reloading PostgreSQL between targets. `
      + 'Run one --test target at a time or use the cloud performance matrix.',
    );
  }
}

function buildRunnerArgs(options) {
  const target = resolvePerformanceTarget(options.targetInput);
  return buildTargetRunnerArgs(target, options);
}

function resolveAttemptTimeoutMs(options = {}) {
  const overrideTimeoutMs = Number(options.testTimeoutMs);
  if (Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0) {
    return overrideTimeoutMs;
  }
  return DEFAULT_TEST_TIMEOUT_MS;
}

function buildTargetRunnerArgs(target, options) {
  const args = ['test', target.specPath];

  if (target.kind === 'isolated') {
    args.push(
      '-c',
      'playwright.performance.config.cjs',
      '--project=idle-memory'
    );
  } else if (target.kind === 'synthetic') {
    const config = target.fixtureProfile === 'utility-problematic-files'
      ? 'playwright.utility-problematic-files.config.cjs'
      : 'playwright.synthetic-large-library.config.cjs';
    args.push(
      '-c',
      config,
      `--real-app-port=${options.realAppPort || DEFAULT_REAL_APP_PORT}`
    );
  } else if (target.kind === 'scan') {
    args.push(
      '-c',
      'playwright.scan-performance.config.cjs'
    );
  } else {
    throw new Error(`Unsupported performance target kind: ${target.kind}`);
  }

  args.push(`--browser=${options.browser || DEFAULT_PLAYWRIGHT_BROWSER}`);

  if (options.headless) {
    args.push('--headless');
  }

  const grepPattern = String(options.grep || target.grep || '').trim();
  if (grepPattern) {
    args.push(`--grep=${grepPattern}`);
  }

  args.push(
    '--workers=1',
    `--timeout=${resolveAttemptTimeoutMs(options)}`
  );

  return args;
}

function buildBatchRunnerArgs(targets, options) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('buildBatchRunnerArgs requires at least one performance target.');
  }
  const [firstTarget] = targets;
  if (targets.length === 1) {
    return buildTargetRunnerArgs(firstTarget, options);
  }
  return buildTargetRunnerArgs(
    {
      ...firstTarget,
      grep: '',
    },
    options,
  );
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function median(values = []) {
  if (!values.length) {
    return null;
  }
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values = []) {
  const filtered = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!filtered.length) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function readLatestAttemptMetrics(
  target,
  verificationGroupId,
  attemptNumber,
  historyRoot = performanceHistoryRoot,
) {
  if (!target.reportId) {
    return null;
  }
  const manifestPath = path.join(historyRoot, target.reportId, 'index.json');
  const manifest = readJson(manifestPath, null);
  const latestEntry = manifest?.runs?.[0];
  if (
    !latestEntry?.metricsPath
    || latestEntry?.verificationRunGroup?.id !== verificationGroupId
    || latestEntry?.verificationRunGroup?.attempt !== attemptNumber
  ) {
    return null;
  }
  const metricsPath = path.join(historyRoot, target.reportId, latestEntry.metricsPath);
  const runMetrics = readJson(metricsPath, null);
  if (!runMetrics) {
    return null;
  }
  return {
    latestEntry,
    runMetrics,
  };
}

function buildVerificationGroup(target, options) {
  const targetName = target.aliasNames[0] || target.specPath;
  const requestedAttempts = Math.max(1, Number(options.repeatCount) || DEFAULT_REPEAT_COUNT);
  const maxAttempts = requestedAttempts > 1
    ? requestedAttempts
    : DEFAULT_THRESHOLD_RETRY_TOTAL_RUNS;
  return {
    id: `${targetName}-${Date.now()}`,
    label: targetName,
    maxAttempts,
    policy: requestedAttempts > 1 ? 'explicit-diagnostic-repeat' : 'ci-hard-ceiling-recovery',
    requestedAttempts,
    selectedContract: options.selectedContract || 'local',
    trustedCi: options.trustedCi === true,
  };
}

function buildBatchVerificationGroup(targets, options) {
  const batchLabel = targets.map((target) => target.aliasNames[0] || target.specPath).join('+');
  const requestedAttempts = Math.max(1, Number(options.repeatCount) || DEFAULT_REPEAT_COUNT);
  const maxAttempts = requestedAttempts > 1
    ? requestedAttempts
    : DEFAULT_THRESHOLD_RETRY_TOTAL_RUNS;
  return {
    id: `${batchLabel}-${Date.now()}`,
    label: batchLabel,
    maxAttempts,
    policy: requestedAttempts > 1 ? 'explicit-diagnostic-repeat' : 'ci-hard-ceiling-recovery',
    requestedAttempts,
    selectedContract: options.selectedContract || 'local',
    trustedCi: options.trustedCi === true,
  };
}

function buildAttemptEnv(baseEnv, verificationGroup, attemptNumber) {
  return {
    ...baseEnv,
    PLAYWRIGHT_OPEN_PERFORMANCE_REPORT: '0',
    PLAYWRIGHT_PERF_VERIFICATION_GROUP_ID: verificationGroup.id,
    PLAYWRIGHT_PERF_VERIFICATION_GROUP_LABEL: verificationGroup.label,
    PLAYWRIGHT_PERF_VERIFICATION_POLICY: verificationGroup.policy,
    PLAYWRIGHT_PERF_VERIFICATION_MAX_ATTEMPTS: String(verificationGroup.maxAttempts),
    PLAYWRIGHT_PERF_VERIFICATION_ATTEMPT: String(attemptNumber),
    PLAYWRIGHT_PERFORMANCE_CONTRACT: verificationGroup.selectedContract || 'local',
    PLAYWRIGHT_PERFORMANCE_CONTRACT_TRUSTED: verificationGroup.trustedCi === true ? '1' : '0',
  };
}

function formatDisplayedAttemptTotal(verificationGroup) {
  if ((verificationGroup?.requestedAttempts || 0) > 1) {
    return verificationGroup.requestedAttempts;
  }
  return 1;
}

function createAttemptRecord(
  target,
  attemptNumber,
  status,
  latestMetricsRecord,
  parsedTestResults = [],
  artifacts = {},
) {
  const benchmarkValidation = latestMetricsRecord?.runMetrics?.rawMetrics?.benchmarkValidation;
  const validationResults = benchmarkValidation?.results;
  return {
    attemptNumber,
    status,
    measurementExpected: target.measurementExpected !== false && Boolean(target.reportId),
    expectedCasePatterns: listTargetCasePatterns(target),
    runId: latestMetricsRecord?.runMetrics?.runId || null,
    metricCaseId: latestMetricsRecord?.runMetrics?.caseId || null,
    metricCasePattern: target.metricCasePattern || latestMetricsRecord?.runMetrics?.caseId || null,
    metricsPath: latestMetricsRecord?.latestEntry?.metricsPath
      ? (artifacts.artifactRoot
        ? path.posix.join('history', target.reportId, latestMetricsRecord.latestEntry.metricsPath)
        : latestMetricsRecord.latestEntry.metricsPath)
      : null,
    reportPath: latestMetricsRecord?.latestEntry?.reportPath
      ? (artifacts.artifactRoot
        ? path.posix.join('history', target.reportId, latestMetricsRecord.latestEntry.reportPath)
        : latestMetricsRecord.latestEntry.reportPath)
      : null,
    validationResults: Array.isArray(validationResults) ? validationResults : [],
    reporterFinalized: artifacts.reporterFinalized === true,
    processStatus: Number.isInteger(artifacts.processStatus) ? artifacts.processStatus : status,
    structuredStatus: artifacts.structuredStatus || null,
    metricsComplete: Boolean(latestMetricsRecord) && Array.isArray(validationResults) && validationResults.length > 0,
    functionalChecksComplete: benchmarkValidation?.functionalChecksComplete === true,
    nonTimingChecksComplete: benchmarkValidation?.nonTimingChecksComplete === true,
    failureCategory: benchmarkValidation?.failureCategory || null,
    parsedTestResults: Array.isArray(parsedTestResults) ? parsedTestResults : [],
    artifactRoot: artifacts.artifactRoot || null,
    artifactDir: artifacts.artifactDir || null,
  };
}

function isFinalizedPlaywrightJsonReport(report) {
  const stats = report?.stats;
  const countKeys = ['expected', 'unexpected', 'skipped', 'flaky'];
  if (!Array.isArray(report?.suites) || report.suites.length === 0
      || !Array.isArray(report?.errors) || !stats) {
    return false;
  }
  if (!countKeys.every((key) => Number.isInteger(stats[key]) && stats[key] >= 0)) {
    return false;
  }
  return countKeys.reduce((total, key) => total + stats[key], 0) > 0;
}

function listTargetCasePatterns(target) {
  const configuredPatterns = Array.isArray(target.casePatterns)
    ? target.casePatterns
    : [target.casePattern || target.grep];
  return configuredPatterns
    .map((pattern) => String(pattern || '').trim())
    .filter(Boolean);
}

function parsedTestMatchesTarget(target, entry) {
  const casePatterns = listTargetCasePatterns(target);
  if (casePatterns.length === 0) {
    return true;
  }
  const searchableText = [entry?.fullName, entry?.testName, entry?.suiteName]
    .map((value) => String(value || ''))
    .join('\n');
  return casePatterns.some((casePattern) => searchableText.includes(casePattern));
}

function filterParsedTestsForTarget(target, parsedTestResults = []) {
  if (listTargetCasePatterns(target).length === 0) {
    return parsedTestResults;
  }
  return parsedTestResults.filter((entry) => parsedTestMatchesTarget(target, entry));
}

function resolveDisplaySuiteName(target) {
  const targetName = target.aliasNames[0] || target.specPath;
  if (targetName === 'all-artists') {
    return 'All Artists Round Trip';
  }
  if (targetName === 'artist-family') {
    return 'Artist Family Navigation';
  }
  if (targetName === 'search-all-artists') {
    return 'Search All Artists';
  }
  if (targetName === 'utility-problematic-files') {
    return 'Problematic Files Utility';
  }
  if (targetName === 'utility-rules') {
    return 'Rules Utility';
  }
  if (targetName === 'selected-artist') {
    return 'Selected Artist Browse';
  }
  if (targetName === 'search-browse') {
    return 'Search Browse';
  }
  if (targetName === 'root-album-browse') {
    return 'Root Album Browse';
  }
  if (targetName === 'app-open-all-artists') {
    return 'App Open All Artists';
  }
  if (targetName === 'problematic-files-focused') {
    return 'Problematic Files Utility';
  }
  if (targetName === 'rules-focused') {
    return 'Rules Utility';
  }
  return targetName;
}

function summarizeTargetRun(target, result) {
  const targetName = target.aliasNames[0] || target.specPath;
  const displaySuiteName = resolveDisplaySuiteName(target);
  const latestAttemptWithParsedTests = [...(result?.attemptRecords || [])]
    .reverse()
    .find((attemptRecord) => Array.isArray(attemptRecord.parsedTestResults) && attemptRecord.parsedTestResults.length > 0);
  const parsedTests = filterParsedTestsForTarget(target, latestAttemptWithParsedTests?.parsedTestResults || []);
  const tests = parsedTests.map((entry) => ({
    status: entry.status === 'failed' ? 'failed' : 'passed',
    testName: entry.testName,
    fullName: `${displaySuiteName} > ${entry.testName}`,
  }));
  const failedTests = tests.filter((entry) => entry.status === 'failed').map((entry) => entry.fullName);

  return {
    suiteName: displaySuiteName,
    status: result?.exitCode === 0 ? 'passed' : 'failed',
    tests: tests.length ? tests : [{
      status: result?.exitCode === 0 ? 'passed' : 'failed',
      testName: targetName,
      fullName: `${displaySuiteName} > ${targetName}`,
    }],
    failedTests,
  };
}

function formatSuiteTerminalSummary(suites = []) {
  return terminalSummary.formatSuiteTerminalSummary(suites);
}

function shouldAutoRetryThresholdFailure(target, verificationGroup, attemptRecord) {
  if (verificationGroup.requestedAttempts > 1) {
    return false;
  }
  return classifyPerformanceAttempt(attemptRecord, verificationGroup.selectedContract).eligibleForRecovery;
}

function classifyPerformanceAttempt(attemptRecord = {}, selectedContract = 'local') {
  const explicitCategory = attemptRecord.failureCategory || null;
  if (explicitCategory && explicitCategory !== 'timing-hard-ceiling') {
    return { outcome: 'failed', eligibleForRecovery: false, failureCategory: explicitCategory };
  }
  const results = Array.isArray(attemptRecord.validationResults) ? attemptRecord.validationResults : [];
  const complete = attemptRecord.reporterFinalized === true
    && attemptRecord.metricsComplete === true
    && attemptRecord.functionalChecksComplete === true
    && attemptRecord.nonTimingChecksComplete === true;
  const timingMetricIds = results
    .filter((result) => result?.units === 'ms')
    .map((result) => result?.metricId);
  const validTimingResults = results.length > 0
    && new Set(timingMetricIds).size === timingMetricIds.length
    && results.every((result) => {
      if (result?.units !== 'ms') {
        return Number.isFinite(Number(result?.actual))
          && Number.isFinite(Number(result?.hardCeiling ?? result?.allowedMaximum))
          && result?.passed === true;
      }
      let budget;
      try {
        budget = resolveTimingBudget(result?.metricId, selectedContract);
      } catch (_error) {
        return false;
      }
      return result?.units === 'ms'
        && result?.contractName === selectedContract
        && Number.isFinite(Number(result?.actual))
        && Number(result?.targetMaximum) === budget.targetMaximum
        && Number(result?.graceMs) === budget.graceMs
        && Number(result?.hardCeiling) === budget.hardCeiling
        && ['target-met', 'grace-used', 'hard-fail'].includes(result?.performanceStatus)
        && (result.performanceStatus === 'hard-fail' ? result.passed === false : result.passed === true);
    });
  const hasHardFailure = results.some((result) => result?.performanceStatus === 'hard-fail');
  const expectedCasePatterns = Array.isArray(attemptRecord.expectedCasePatterns)
    ? attemptRecord.expectedCasePatterns
    : [];
  const parsedCases = Array.isArray(attemptRecord.parsedTestResults)
    ? attemptRecord.parsedTestResults
    : [];
  const multiCaseTimingEvidenceComplete = expectedCasePatterns.length <= 1 || (
    Boolean(String(attemptRecord.metricCasePattern || attemptRecord.metricCaseId || '').trim())
    &&
    parsedCases.filter((entry) => entry?.status === 'failed').length === 1
    && parsedCases.filter((entry) => entry?.status === 'failed').every((entry) => (
      [entry?.fullName, entry?.testName, entry?.suiteName]
        .map((value) => String(value || ''))
        .join('\n')
        .includes(String(attemptRecord.metricCasePattern || attemptRecord.metricCaseId || ''))
    ))
    && expectedCasePatterns.every((pattern) => parsedCases.some((entry) => (
      [entry?.fullName, entry?.testName, entry?.suiteName]
        .map((value) => String(value || ''))
        .join('\n')
        .includes(pattern)
    )))
  );
  const processAndStructurePassed = attemptRecord.processStatus === 0
    && attemptRecord.structuredStatus === 'passed';
  if (attemptRecord.status === 0 || processAndStructurePassed) {
    if (attemptRecord.measurementExpected === false) {
      const caseMatches = expectedCasePatterns.map((pattern) => parsedCases.filter((entry) => (
        [entry?.fullName, entry?.testName, entry?.suiteName]
          .map((value) => String(value || ''))
          .join('\n')
          .includes(pattern)
      )));
      const casesComplete = expectedCasePatterns.length > 0
        && parsedCases.every((entry) => entry?.status === 'passed')
        && caseMatches.every((matches) => matches.length === 1);
      if (attemptRecord.reporterFinalized === true && casesComplete) {
        return { outcome: 'passed', eligibleForRecovery: false, failureCategory: null };
      }
      return {
        outcome: 'failed',
        eligibleForRecovery: false,
        failureCategory: attemptRecord.reporterFinalized === true
          ? 'functional-contract'
          : 'reporter-finalization',
      };
    }
    if (complete && validTimingResults && !hasHardFailure) {
      return { outcome: 'passed', eligibleForRecovery: false, failureCategory: null };
    }
  }
  if (complete && validTimingResults && hasHardFailure && multiCaseTimingEvidenceComplete) {
    return {
      outcome: 'hard-fail',
      eligibleForRecovery: selectedContract === 'ci',
      failureCategory: 'timing-hard-ceiling',
    };
  }
  const failureCategory = !attemptRecord.reporterFinalized
    ? 'reporter-finalization'
    : (!attemptRecord.metricsComplete ? 'missing-metrics' : (explicitCategory || 'assertion'));
  return { outcome: 'failed', eligibleForRecovery: false, failureCategory };
}

function buildAggregatedThresholdEvaluation(attemptRecords = []) {
  const optionalFiniteNumber = (value) => (
    value !== null
    && value !== undefined
    && !(typeof value === 'string' && value.trim() === '')
    && Number.isFinite(Number(value))
      ? Number(value)
      : null
  );
  const resolveEffectiveCeiling = (result = {}) => {
    const isDeclared = (value) => value !== null
      && value !== undefined
      && !(typeof value === 'string' && value.trim() === '');
    const hardCeilingDeclared = isDeclared(result.hardCeiling);
    const allowedMaximumDeclared = isDeclared(result.allowedMaximum);
    const hardCeiling = optionalFiniteNumber(result.hardCeiling);
    const allowedMaximum = optionalFiniteNumber(result.allowedMaximum);
    const consistent = (!hardCeilingDeclared || hardCeiling !== null)
      && (!allowedMaximumDeclared || allowedMaximum !== null)
      && !(hardCeilingDeclared && allowedMaximumDeclared && hardCeiling !== allowedMaximum);
    return {
      consistent,
      value: consistent ? (hardCeiling ?? allowedMaximum) : null,
    };
  };
  const resultMap = new Map();
  for (const attemptRecord of attemptRecords) {
    for (const result of attemptRecord.validationResults || []) {
      const entry = resultMap.get(result.key) || {
        key: result.key,
        checkpointKey: result.checkpointKey || '',
        description: result.description || '',
        units: result.units || '',
        targetMaximum: optionalFiniteNumber(result.targetMaximum),
        graceMs: optionalFiniteNumber(result.graceMs),
        allowedMaximum: optionalFiniteNumber(result.allowedMaximum),
        allowedText: result.allowedText || '',
        actuals: [],
        passCount: 0,
        reportedPassCount: 0,
        classificationPolicy: result.classificationPolicy || null,
        calibrationState: result.calibrationState || null,
        blocking: result.blocking,
        failingSampleCount: result.failingSampleCount,
        effectiveCeiling: resolveEffectiveCeiling(result).value,
        contractConsistent: true,
      };
      const resultTargetMaximum = optionalFiniteNumber(result.targetMaximum);
      const resultGraceMs = optionalFiniteNumber(result.graceMs);
      const resultAllowedMaximum = optionalFiniteNumber(result.allowedMaximum);
      const effectiveCeiling = resolveEffectiveCeiling(result);
      entry.contractConsistent = entry.contractConsistent
        && entry.units === (result.units || '')
        && entry.targetMaximum === resultTargetMaximum
        && entry.graceMs === resultGraceMs
        && entry.allowedMaximum === resultAllowedMaximum
        && effectiveCeiling.consistent
        && entry.effectiveCeiling === effectiveCeiling.value
        && entry.classificationPolicy === (result.classificationPolicy || null)
        && entry.calibrationState === (result.calibrationState || null)
        && entry.blocking === result.blocking
        && entry.failingSampleCount === result.failingSampleCount;
      const actual = (
        result.actual !== null
        && result.actual !== undefined
        && !(typeof result.actual === 'string' && result.actual.trim() === '')
      ) ? Number(result.actual) : Number.NaN;
      if (Number.isFinite(actual)) {
        entry.actuals.push(actual);
      }
      const rawClassification = classifyPerformanceThreshold({
        units: result.units,
        actual,
        targetMaximum: result.targetMaximum,
        graceMs: result.graceMs,
        hardCeiling: effectiveCeiling.value,
        calibrationState: result.calibrationState,
        blocking: result.blocking,
        processPassed: attemptRecord.status === 0,
        reportedPassed: result.passed,
        reportedStatus: result.performanceStatus,
        classificationPolicy: result.classificationPolicy,
        sampleCount: result.sampleCount,
        overThresholdCount: result.overThresholdCount,
        failingSampleCount: result.failingSampleCount,
      });
      if (Number.isFinite(actual) && result.passed) {
        entry.reportedPassCount += 1;
      }
      if (rawClassification.passed) {
        entry.passCount += 1;
      }
      resultMap.set(result.key, entry);
    }
  }

  const totalRuns = attemptRecords.length;
  const requiredPassCount = totalRuns;
  const everyAttemptPassed = attemptRecords.every((record) => record.status === 0);
  const metrics = [...resultMap.values()].map((entry) => {
    const medianActual = median(entry.actuals);
    const meanActual = mean(entry.actuals);
    const medianClassification = classifyPerformanceThreshold({
      units: entry.units,
      actual: medianActual,
      targetMaximum: entry.targetMaximum,
      graceMs: entry.graceMs,
      hardCeiling: entry.effectiveCeiling,
      calibrationState: entry.calibrationState,
      blocking: entry.blocking,
      processPassed: everyAttemptPassed,
    });
    const passed = medianClassification.passed
      && entry.contractConsistent
      && entry.actuals.length === totalRuns
      && entry.passCount >= requiredPassCount;
    const performanceStatus = medianClassification.performanceStatus;
    return {
      ...entry,
      medianActual,
      meanActual,
      totalRuns,
      requiredPassCount,
      performanceStatus,
      thresholdPassed: medianClassification.thresholdPassed,
      policyPassed: medianClassification.policyPassed,
      graceUsed: performanceStatus === 'grace-used',
      passed,
    };
  });

  return {
    totalRuns,
    requiredPassCount,
    metrics,
    failedMetrics: metrics.filter((metric) => !metric.passed),
    passed: everyAttemptPassed && metrics.length > 0 && metrics.every((metric) => metric.passed),
  };
}

function hasAggregateValidationResults(attemptRecords = []) {
  return attemptRecords.length > 1
    && attemptRecords.every((record) => Array.isArray(record.validationResults));
}

function formatAggregateMetricValue(metric, value) {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  if (metric.units === 'bytes') {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(value)} ms`;
}

function printAggregatedThresholdSummary(target, summary) {
  const targetName = target.aliasNames[0] || target.specPath;
  console.log(`=== Aggregated threshold summary for ${targetName} (${summary.totalRuns} runs) ===`);
  for (const metric of summary.metrics) {
    console.log(
      `[aggregate] ${metric.key}: median ${formatAggregateMetricValue(metric, metric.medianActual)}, `
      + `mean ${formatAggregateMetricValue(metric, metric.meanActual)}, `
      + `passes ${metric.passCount}/${metric.totalRuns}, `
      + `ceiling ${metric.allowedText || formatAggregateMetricValue(metric, metric.allowedMaximum)} `
      + `=> ${metric.performanceStatus.toUpperCase()} (${metric.passed ? 'PASS' : 'FAIL'})`
    );
  }
}

function resolvePerformanceTargetArtifactRoot(target) {
  const targetName = String(target?.aliasNames?.[0] || target?.specPath || 'target');
  const targetId = targetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'target';
  return path.join(performanceTargetArtifactsRoot, targetId);
}

function resolvePerformanceAttemptArtifactDir(targetRoot, attemptNumber) {
  return path.join(targetRoot, `attempt-${attemptNumber}`);
}

function preparePerformanceTargetArtifactRoot(targetRoot) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
}

function assertFixtureDatabaseUrlSafe(databaseUrl) {
  const scheme = String(databaseUrl).match(/^([^:]+):/)?.[1] || '';
  if (!['postgresql', 'postgres'].includes(scheme)) {
    throw new Error('DATABASE_MIGRATOR_URL scheme must be postgresql.');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch (error) {
    throw new Error(`DATABASE_MIGRATOR_URL is malformed: ${error?.message || error}`);
  }

  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('DATABASE_MIGRATOR_URL must use a loopback host.');
  }
  if (parsed.search || parsed.hash || parsed.pathname.includes(';')) {
    throw new Error('DATABASE_MIGRATOR_URL query, path parameters, and fragment are forbidden.');
  }

  let databaseName;
  let username;
  try {
    databaseName = decodeURIComponent(String(parsed.pathname || '').replace(/^\/+/, ''));
    username = decodeURIComponent(parsed.username || '');
  } catch (error) {
    throw new Error(`DATABASE_MIGRATOR_URL contains malformed encoding: ${error?.message || error}`);
  }

  if (databaseName === 'album_haven_core') {
    throw new Error('DATABASE_MIGRATOR_URL database album_haven_core is forbidden for CI fixtures.');
  }
  const databaseMatch = /^album_haven_ci_([a-z0-9]+(?:_[a-z0-9]+)*)$/.exec(databaseName);
  if (!databaseMatch) {
    throw new Error('DATABASE_MIGRATOR_URL database name must use the strict album_haven_ci_<suffix> contract.');
  }

  const suffix = databaseMatch[1];
  if (username !== `album_haven_migrator_${suffix}`) {
    throw new Error('DATABASE_MIGRATOR_URL must use the matching suffixed migrator role.');
  }
  const authority = String(databaseUrl).match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] || '';
  const userInfo = authority.includes('@') ? authority.slice(0, authority.lastIndexOf('@')) : '';
  if (parsed.password || userInfo.includes(':')) {
    throw new Error('DATABASE_MIGRATOR_URL must use pgpass instead of an embedded password.');
  }

  return databaseUrl;
}

function reloadPreloadedFixtureForAttempt(target, env, spawnSync = childProcess.spawnSync) {
  if (target.fixtureMode !== PRELOADED_RELEASE_FIXTURE_MODE) return;

  const selectedProfile = String(env.ALBUM_HAVEN_FIXTURE_PROFILE || '').trim();
  const python = String(env.PLAYWRIGHT_PYTHON || '').trim();
  const fixtureRoot = String(env.ALBUM_HAVEN_FIXTURE_ROOT || '').trim();
  const databaseUrl = String(env.DATABASE_MIGRATOR_URL || '').trim();
  const expectedProfile = String(target.fixtureProfile || '').trim();
  if (!python || !fixtureRoot || !databaseUrl || selectedProfile !== expectedProfile) {
    throw new Error(
      `Performance target ${target.aliasNames?.[0] || target.specPath} cannot restore its released fixture: `
      + 'PLAYWRIGHT_PYTHON, ALBUM_HAVEN_FIXTURE_ROOT, the exact ALBUM_HAVEN_FIXTURE_PROFILE, '
      + 'and DATABASE_MIGRATOR_URL are required.',
    );
  }
  assertFixtureDatabaseUrlSafe(databaseUrl);

  const result = spawnSync(python, [
    fixtureProfileLoaderPath,
    '--fixture-root', fixtureRoot,
    '--profile', selectedProfile,
    '--database-url', databaseUrl,
    '--replace-existing',
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result?.error) throw result.error;
  if (result?.stdout) process.stdout.write(result.stdout);
  if (result?.stderr) process.stderr.write(result.stderr);
  if (result?.status !== 0 || result?.signal) {
    throw new Error(
      `Performance target ${target.aliasNames?.[0] || target.specPath} fixture restore failed `
      + `(status=${String(result?.status)}, signal=${String(result?.signal || 'none')}).`,
    );
  }
}

function runPerformanceAttempt(
  target,
  runnerArgs,
  baseEnv,
  verificationGroup,
  attemptNumber,
  artifactRoot,
  preparedFixture = false,
) {
  const artifactDir = artifactRoot
    ? resolvePerformanceAttemptArtifactDir(artifactRoot, attemptNumber)
    : null;
  if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
  const attemptRunnerArgs = artifactDir
    ? [...runnerArgs, `--output=${artifactDir}`]
    : runnerArgs;
  const attemptEnv = buildAttemptEnv(baseEnv, verificationGroup, attemptNumber);
  delete attemptEnv.PLAYWRIGHT_JSON_OUTPUT_FILE;
  if (target.measurementExpected === false && artifactDir) {
    attemptEnv.PLAYWRIGHT_JSON_OUTPUT_FILE = path.join(artifactDir, 'report.json');
  }
  if (artifactRoot) {
    attemptEnv.PLAYWRIGHT_PERFORMANCE_HISTORY_ROOT = path.join(artifactRoot, 'history');
  }
  assertProviderWriteSafeEnv(attemptEnv);
  if (!preparedFixture) {
    reloadPreloadedFixtureForAttempt(target, attemptEnv);
  }
  const lastRunPath = resolvePlaywrightLastRunPath(attemptRunnerArgs);
  if (lastRunPath) {
    fs.rmSync(lastRunPath, { force: true });
  }
  const result = childProcess.spawnSync(process.execPath, [runnerPath, ...attemptRunnerArgs], {
    cwd: repoRoot,
    env: attemptEnv,
    encoding: 'utf8',
    maxBuffer: PERFORMANCE_CHILD_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const combinedOutput = `${result.stdout || ''}${result.stderr || ''}`;
  assertNoLiveCoverProviderDomains(combinedOutput, verificationGroup?.label);
  const structuredLastRun = readPlaywrightLastRun(lastRunPath);
  const structuredJsonReport = target.measurementExpected === false && artifactDir
    ? readJson(path.join(artifactDir, 'report.json'), null)
    : null;
  return {
    artifactDir,
    artifactRoot,
    combinedOutput,
    reporterFinalized: combinedOutput.includes('[playwright-performance-reporter] flush-complete')
      || isFinalizedPlaywrightJsonReport(structuredJsonReport),
    processStatus: typeof result.status === 'number' ? result.status : 1,
    structuredStatus: String(structuredLastRun?.status || '').toLowerCase() || null,
    status: resolvePerformanceAttemptStatus(result.status, {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    }, structuredLastRun, {
      structuredResultRequired: Boolean(lastRunPath)
        && combinedOutput.includes('[playwright-performance-reporter] flush-complete'),
    }),
  };
}

function assertNoLiveCoverProviderDomains(output, targetName = 'scan') {
  const text = String(output || '');
  const urlPattern = /https?:\/\/[^\s"'<>\])}]+/gi;
  for (const rawUrl of text.match(urlPattern) || []) {
    let hostname;
    try {
      hostname = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, '');
    } catch (_error) {
      continue;
    }
    if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.localhost')) {
      continue;
    }
    if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
      continue;
    }
    const providerDomain = LIVE_COVER_PROVIDER_DOMAIN_SUFFIXES.find(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
    if (providerDomain) {
      throw new Error(
        `Scan performance target ${String(targetName || 'scan')} contacted live cover provider domain ${hostname}; `
        + 'scan E2E must use offline providers or an explicit loopback fixture.',
      );
    }
  }
}

function resolvePlaywrightLastRunPath(runnerArgs = []) {
  for (let index = 0; index < runnerArgs.length; index += 1) {
    const argument = String(runnerArgs[index] || '');
    if (argument === '--output') {
      const outputPath = String(runnerArgs[index + 1] || '').trim();
      return outputPath
        ? path.join(path.isAbsolute(outputPath) ? outputPath : path.resolve(repoRoot, outputPath), '.last-run.json')
        : '';
    }
    if (argument.startsWith('--output=')) {
      const outputPath = argument.slice('--output='.length).trim();
      return outputPath
        ? path.join(path.isAbsolute(outputPath) ? outputPath : path.resolve(repoRoot, outputPath), '.last-run.json')
        : '';
    }
  }

  let configPath = '';
  for (let index = 0; index < runnerArgs.length; index += 1) {
    const argument = String(runnerArgs[index] || '');
    if (argument === '-c' || argument === '--config') {
      configPath = String(runnerArgs[index + 1] || '');
      break;
    }
    if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length);
      break;
    }
  }
  const outputDir = PLAYWRIGHT_LAST_RUN_DIR_BY_CONFIG[path.basename(configPath).toLowerCase()];
  return outputDir
    ? path.join(repoRoot, 'test-results', 'playwright-artifacts', outputDir, '.last-run.json')
    : '';
}

function readPlaywrightLastRun(lastRunPath) {
  if (!lastRunPath) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(lastRunPath, 'utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch (_error) {
    return null;
  }
}

function resolvePerformanceAttemptStatus(spawnStatus, output, structuredLastRun = null, options = {}) {
  const normalizedSpawnStatus = typeof spawnStatus === 'number' ? spawnStatus : 1;
  const combinedOutput = output && typeof output === 'object'
    ? `${output.stdout || ''}\n${output.stderr || ''}`
    : String(output || '');
  const parsedTests = terminalSummary.parsePlaywrightListResults(combinedOutput);
  if (options.structuredResultRequired && !structuredLastRun) {
    return 1;
  }
  if (String(structuredLastRun?.status || '').toLowerCase() === 'failed') {
    return 1;
  }
  if (parsedTests.some((entry) => entry.status === 'failed')) {
    return 1;
  }
  if (
    String(structuredLastRun?.status || '').toLowerCase() === 'passed'
    && parsedTests.length === 0
  ) {
    return 1;
  }
  return normalizedSpawnStatus;
}

function resolveAttemptPorts(target, targetPorts, attemptNumber) {
  if (target.kind !== 'synthetic' || attemptNumber <= 1) {
    return targetPorts;
  }
  return {
    ...targetPorts,
    realAppPort: resolveManagedRealAppAttemptPort(targetPorts.realAppPort, attemptNumber),
  };
}

function describeTargetLaunch(target, options, attemptNumber, targetPorts) {
  const targetName = target.aliasNames[0] || target.specPath;
  const modeLabel = options.headless ? 'headless' : 'headed';
  const browserLabel = String(options.browser || DEFAULT_PLAYWRIGHT_BROWSER).trim()
    || DEFAULT_PLAYWRIGHT_BROWSER;
  const segments = [
    `target=${targetName}`,
    `attempt=${attemptNumber}`,
    `mode=${modeLabel}`,
    `browser=${browserLabel}`,
  ];
  const suitePosition = options.launchContext
    && Number.isFinite(options.launchContext.batchIndex)
    && Number.isFinite(options.launchContext.batchCount)
    ? `${options.launchContext.batchIndex}/${options.launchContext.batchCount}`
    : '';
  if (suitePosition) {
    segments.push(`suite_target=${suitePosition}`);
  }
  if (target.kind === 'synthetic') {
    segments.push(`real_app_port=${targetPorts.realAppPort}`);
    if (!options.headless) {
      segments.push('note=fresh_browser_session_per_target');
    }
  } else if (target.kind === 'scan') {
    segments.push(`scan_app_port=${targetPorts.scanAppPort}`);
  }
  return segments.join(' | ');
}

function applyTargetEnvOverrides(baseEnv, targetEnv) {
  const mergedEnv = {
    ...baseEnv,
  };
  for (const [key, value] of Object.entries(targetEnv || {})) {
    if (value === null) {
      delete mergedEnv[key];
      continue;
    }
    mergedEnv[key] = value;
  }
  return mergedEnv;
}

function buildSyntheticFixtureIsolationEnv(target) {
  if (target.kind !== 'synthetic') {
    return {};
  }
  return {
    MUSIC_DIR: '',
    MUSIC_APP_DATA_DIR: '',
    MUSIC_CACHE_PATH: '',
    MUSIC_COVER_CACHE_PATH: '',
    MUSIC_LIBRARY_ROOTS_PATH: '',
    PLAYWRIGHT_REAL_APP_URL: '',
  };
}

function buildScanStatusSamplesEnv(target, scanAppPort, attemptNumber) {
  if (target.kind !== 'scan') return {};
  const targetLabel = String(target.aliasNames?.[0] || 'scan')
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'scan';
  fs.mkdirSync(SCAN_STATUS_SAMPLES_ROOT, { recursive: true });
  const samplesPath = path.join(
    SCAN_STATUS_SAMPLES_ROOT,
    `${targetLabel}-port-${scanAppPort}-attempt-${attemptNumber}-${crypto.randomUUID()}.jsonl`,
  );
  fs.rmSync(samplesPath, { force: true });
  return { ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH: samplesPath };
}

function cleanupManagedScanStatusSamples(samplesEnv) {
  const samplesPath = samplesEnv?.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH;
  if (!samplesPath) return;
  const managedRoot = path.resolve(SCAN_STATUS_SAMPLES_ROOT);
  const resolvedSamplesPath = path.resolve(samplesPath);
  const relativePath = path.relative(managedRoot, resolvedSamplesPath);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return;
  }
  fs.rmSync(resolvedSamplesPath, { force: true });
}

function runSinglePerformanceAttempt(target, options, verificationGroup, attemptNumber, targetPorts) {
  const attemptPorts = resolveAttemptPorts(target, targetPorts, attemptNumber);
  console.log(`[performance-runner] ${describeTargetLaunch(target, options, attemptNumber, attemptPorts)}`);
  const runnerArgs = buildTargetRunnerArgs(target, {
    ...options,
    realAppPort: attemptPorts.realAppPort,
    targetInput: target.aliasNames[0] || target.specPath,
  });
  const managedScanStatusEnv = buildScanStatusSamplesEnv(
    target,
    attemptPorts.scanAppPort,
    attemptNumber,
  );
  const baseEnv = buildAndAssertProviderWriteSafeEnv(
    applyTargetEnvOverrides(
      applyTargetEnvOverrides({
        ...process.env,
        PLAYWRIGHT_HEADLESS: options.headless ? 'true' : 'false',
        ...(target.kind === 'scan' ? { PLAYWRIGHT_PORT: String(attemptPorts.scanAppPort) } : {}),
        ...managedScanStatusEnv,
      }, target.env || {}),
      buildSyntheticFixtureIsolationEnv(target),
    ),
  );
  const artifactRoot = options.useLegacyArtifacts
    ? null
    : resolvePerformanceTargetArtifactRoot(target);
  try {
    const result = runPerformanceAttempt(
      target,
      runnerArgs,
      baseEnv,
      verificationGroup,
      attemptNumber,
      artifactRoot,
      options.preparedFixture,
    );
    const latestMetricsRecord = readLatestAttemptMetrics(
      target,
      verificationGroup.id,
      attemptNumber,
      artifactRoot ? path.join(artifactRoot, 'history') : undefined,
    );
    return createAttemptRecord(
      target,
      attemptNumber,
      result.status,
      latestMetricsRecord,
      terminalSummary.parsePlaywrightListResults(result.combinedOutput),
      result,
    );
  } finally {
    cleanupManagedScanStatusSamples(managedScanStatusEnv);
  }
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveBatchTargetStatus(target, parsedTests, fallbackStatus) {
  if (listTargetCasePatterns(target).length === 0) {
    return fallbackStatus;
  }
  const matchingTests = Array.isArray(parsedTests)
    ? parsedTests.filter((entry) => parsedTestMatchesTarget(target, entry))
    : [];
  for (const entry of matchingTests) {
    if (entry?.status === 'failed') {
      return 1;
    }
    if (entry?.status === 'passed') {
      return 0;
    }
  }
  return fallbackStatus;
}

function runBatchPerformanceAttempt(targets, options, verificationGroup, attemptNumber, targetPorts) {
  const [firstTarget] = targets;
  const runnerArgs = buildBatchRunnerArgs(targets, {
    ...options,
    realAppPort: targetPorts.realAppPort,
  });
  const managedScanStatusEnv = buildScanStatusSamplesEnv(
    firstTarget,
    targetPorts.scanAppPort,
    attemptNumber,
  );
  const baseEnv = buildAndAssertProviderWriteSafeEnv(
    applyTargetEnvOverrides(
      applyTargetEnvOverrides({
        ...process.env,
        PLAYWRIGHT_HEADLESS: options.headless ? 'true' : 'false',
        ...(firstTarget.kind === 'scan' ? { PLAYWRIGHT_PORT: String(targetPorts.scanAppPort) } : {}),
        ...managedScanStatusEnv,
      }, firstTarget.env || {}),
      buildSyntheticFixtureIsolationEnv(firstTarget),
    ),
  );
  try {
    const result = runPerformanceAttempt(
      firstTarget,
      runnerArgs,
      baseEnv,
      verificationGroup,
      attemptNumber,
      null,
      options.preparedFixture,
    );
    const parsedTests = terminalSummary.parsePlaywrightListResults(result.combinedOutput);
    return targets.map((target) => {
      const latestMetricsRecord = readLatestAttemptMetrics(
        target,
        verificationGroup.id,
        attemptNumber,
        undefined,
      );
      const targetStatus = resolveBatchTargetStatus(target, parsedTests, result.status);
      return createAttemptRecord(
        target,
        attemptNumber,
        targetStatus,
        latestMetricsRecord,
        filterParsedTestsForTarget(target, parsedTests),
        result,
      );
    });
  } finally {
    cleanupManagedScanStatusSamples(managedScanStatusEnv);
  }
}

function runTargetWithPolicy(target, options, targetPorts) {
  const verificationGroup = buildVerificationGroup(target, options);
  const targetName = target.aliasNames[0] || target.specPath;
  const attemptRecords = [];
  const forcedAttempts = verificationGroup.requestedAttempts > 1;
  const totalPlannedAttempts = forcedAttempts ? verificationGroup.maxAttempts : 1;
  const displayedAttemptTotal = formatDisplayedAttemptTotal(verificationGroup);
  preparePerformanceTargetArtifactRoot(resolvePerformanceTargetArtifactRoot(target));

  for (let attemptNumber = 1; attemptNumber <= totalPlannedAttempts; attemptNumber += 1) {
    console.log(`=== Performance run ${attemptNumber}/${displayedAttemptTotal} for ${targetName} ===`);
    const attemptRecord = runSinglePerformanceAttempt(target, options, verificationGroup, attemptNumber, targetPorts);
    attemptRecords.push(attemptRecord);
  }

  if (!forcedAttempts) {
    while (
      attemptRecords.length < verificationGroup.maxAttempts
      && shouldAutoRetryThresholdFailure(target, verificationGroup, attemptRecords.at(-1))
    ) {
      const attemptNumber = attemptRecords.length + 1;
      console.log(`=== Performance recovery run ${attemptNumber}/${verificationGroup.maxAttempts} for ${targetName} ===`);
      attemptRecords.push(runSinglePerformanceAttempt(
        target, options, verificationGroup, attemptNumber, targetPorts,
      ));
    }
  }

  const lastAttempt = attemptRecords.at(-1);
  const classifications = attemptRecords.map((record) => (
    classifyPerformanceAttempt(record, verificationGroup.selectedContract)
  ));
  const firstPassingIndex = classifications.findIndex((entry) => entry.outcome === 'passed');
  const passed = forcedAttempts
    ? classifications.every((entry) => entry.outcome === 'passed')
    : classifications.at(-1).outcome === 'passed';
  const policyResult = {
    schemaVersion: 1,
    target: targetName,
    selectedContract: verificationGroup.selectedContract,
    attemptCount: attemptRecords.length,
    finalStatus: passed ? 'passed' : 'failed',
    recoveryUsed: !forcedAttempts && attemptRecords.length > 1,
    primaryAttempt: firstPassingIndex >= 0 ? attemptRecords[firstPassingIndex].attemptNumber : null,
    attemptRecords: attemptRecords.map((record, index) => ({
      attemptNumber: record.attemptNumber,
      ...classifications[index],
      processStatus: record.processStatus,
      reporterFinalized: record.reporterFinalized,
      metricsComplete: record.metricsComplete,
      functionalChecksComplete: record.functionalChecksComplete,
      nonTimingChecksComplete: record.nonTimingChecksComplete,
      runId: record.runId,
      metricsPath: record.metricsPath,
      reportPath: record.reportPath,
    })),
  };
  if (!forcedAttempts) {
    fs.writeFileSync(
      path.join(resolvePerformanceTargetArtifactRoot(target), 'policy-result.json'),
      `${JSON.stringify(policyResult, null, 2)}\n`,
      'utf8',
    );
  }
  return {
    exitCode: passed ? 0 : 1,
    attemptRecords,
    aggregateSummary: null,
    verificationGroup,
    lastAttempt,
    schemaVersion: policyResult.schemaVersion,
    target: policyResult.target,
    attemptCount: policyResult.attemptCount,
    finalStatus: policyResult.finalStatus,
    recoveryUsed: policyResult.recoveryUsed,
    selectedContract: policyResult.selectedContract,
    primaryAttempt: policyResult.primaryAttempt,
  };
}

function summarizeTargetAttemptRecords(target, verificationGroup, attemptRecords) {
  if (target.supportsAggregatedThresholdRetries && hasAggregateValidationResults(attemptRecords)) {
    const aggregateSummary = buildAggregatedThresholdEvaluation(attemptRecords);
    printAggregatedThresholdSummary(target, aggregateSummary);
    return {
      exitCode: aggregateSummary.passed ? 0 : 1,
      attemptRecords,
      aggregateSummary,
      verificationGroup,
      lastAttempt: attemptRecords[attemptRecords.length - 1],
    };
  }

  return {
    exitCode: attemptRecords.some((record) => record.status !== 0) ? 1 : 0,
    attemptRecords,
    aggregateSummary: null,
    verificationGroup,
    lastAttempt: attemptRecords[attemptRecords.length - 1],
  };
}

function groupTargetsForFullSuite(targets) {
  const batches = [];
  const batchIndexByKey = new Map();
  for (const target of targets) {
    const envKey = JSON.stringify(Object.entries(target.env || {}).sort(([leftKey], [rightKey]) => (
      leftKey.localeCompare(rightKey)
    )));
    const explicitBatchKey = String(target.fullSuiteBatchKey || '').trim();
    const batchKey = explicitBatchKey
      ? `${explicitBatchKey}:${target.kind}:${target.specPath}:${envKey}`
      : `single:${target.aliasNames[0] || target.specPath}`;
    const existingBatchIndex = batchIndexByKey.get(batchKey);
    if (existingBatchIndex !== undefined) {
      batches[existingBatchIndex].push(target);
      continue;
    }
    batchIndexByKey.set(batchKey, batches.length);
    batches.push([target]);
  }
  return batches;
}

function resolveFullSuiteBudgetGroupKey(target) {
  if (target.coverageClass === 'scanner-index-cache') {
    return 'scanner-index-cache';
  }
  if (target.coverageClass === 'real-app-library-browse-load') {
    return `real-app:${target.aliasNames[0] || target.specPath}`;
  }
  if (target.coverageClass === 'real-app-isolated-postgres-memory') {
    return 'idle-memory';
  }
  return `${target.kind}:${target.coverageClass || target.specPath}`;
}

function groupBatchesForFullSuiteBudgets(targets) {
  const budgetGroups = [];
  const budgetGroupIndexByKey = new Map();
  for (const batchTargets of groupTargetsForFullSuite(targets)) {
    const budgetGroupKey = resolveFullSuiteBudgetGroupKey(batchTargets[0]);
    const existingBudgetGroupIndex = budgetGroupIndexByKey.get(budgetGroupKey);
    if (existingBudgetGroupIndex !== undefined) {
      budgetGroups[existingBudgetGroupIndex].batches.push(batchTargets);
      continue;
    }
    budgetGroupIndexByKey.set(budgetGroupKey, budgetGroups.length);
    budgetGroups.push({
      key: budgetGroupKey,
      batches: [batchTargets],
    });
  }
  return budgetGroups;
}

function runBatchedPerformanceSuite(targets, options) {
  const budgetGroups = groupBatchesForFullSuiteBudgets(targets);
  let exitCode = 0;
  const suiteSummaries = [];
  let nextRealAppPortSequence = 0;
  let nextScanAppPort = options.scanAppBasePort || DEFAULT_SCAN_APP_PORT;
  const totalBatchCount = budgetGroups.reduce(
    (count, budgetGroup) => count + budgetGroup.batches.length,
    0,
  );
  let batchIndex = 0;

  for (const budgetGroup of budgetGroups) {
    if (budgetGroups.length > 1) {
      console.log(`=== Performance budget group: ${budgetGroup.key} ===`);
    }

    for (const batchTargets of budgetGroup.batches) {
      batchIndex += 1;
      const batchLabel = batchTargets.map((target) => target.aliasNames[0] || target.specPath).join(', ');
      console.log(`=== Performance batch ${batchIndex}/${totalBatchCount}: ${batchLabel} ===`);
      const batchTarget = batchTargets[0];
      const targetPorts = {
        realAppPort: batchTarget.kind === 'synthetic'
          ? resolveManagedRealAppPortForSequence(
            nextRealAppPortSequence++,
            options.realAppBasePort,
          )
          : (options.realAppBasePort || DEFAULT_REAL_APP_PORT),
        scanAppPort: batchTarget.kind === 'scan'
          ? nextScanAppPort++
          : DEFAULT_SCAN_APP_PORT,
      };
      const batchOptions = {
        ...options,
        testTimeoutMs: batchTargets.length > 1
          ? resolveAttemptTimeoutMs(options)
          : options.testTimeoutMs,
        launchContext: {
          batchIndex,
          batchCount: totalBatchCount,
          batchLabel,
        },
      };

      if (batchTargets.length === 1) {
        const result = runTargetWithPolicy(batchTarget, batchOptions, targetPorts);
        suiteSummaries.push(summarizeTargetRun(batchTarget, result));
        if (result.exitCode !== 0 && exitCode === 0) {
          exitCode = result.exitCode;
        }
        continue;
      }

      const verificationGroup = buildBatchVerificationGroup(batchTargets, batchOptions);
      const attemptRecordsByTarget = new Map(
        batchTargets.map((target) => [target.aliasNames[0] || target.specPath, []])
      );
      const initialAttemptRecords = runBatchPerformanceAttempt(batchTargets, batchOptions, verificationGroup, 1, targetPorts);
      for (let index = 0; index < batchTargets.length; index += 1) {
        const target = batchTargets[index];
        const attemptRecord = initialAttemptRecords[index];
        attemptRecordsByTarget.get(target.aliasNames[0] || target.specPath).push(attemptRecord);
      }

      for (const target of batchTargets) {
        const targetKey = target.aliasNames[0] || target.specPath;
        const targetAttemptRecords = attemptRecordsByTarget.get(targetKey) || [];
        const firstAttempt = targetAttemptRecords[0];
        if (!firstAttempt || !shouldAutoRetryThresholdFailure(target, verificationGroup, firstAttempt)) {
          continue;
        }
        console.log(
          `=== Initial threshold miss detected for ${targetKey}; collecting `
          + `${verificationGroup.maxAttempts - 1} additional sequential runs for aggregate evaluation ===`
        );
        for (let attemptNumber = 2; attemptNumber <= verificationGroup.maxAttempts; attemptNumber += 1) {
          console.log(`=== Performance run ${attemptNumber}/${verificationGroup.maxAttempts} for ${targetKey} ===`);
          const attemptRecord = runSinglePerformanceAttempt(
            target,
            { ...batchOptions, useLegacyArtifacts: true },
            verificationGroup,
            attemptNumber,
            targetPorts,
          );
          targetAttemptRecords.push(attemptRecord);
        }
      }

      for (const target of batchTargets) {
        const targetKey = target.aliasNames[0] || target.specPath;
        const targetAttemptRecords = attemptRecordsByTarget.get(targetKey) || [];
        const targetResult = summarizeTargetAttemptRecords(target, verificationGroup, targetAttemptRecords);
        suiteSummaries.push(summarizeTargetRun(target, targetResult));
        if (targetResult.exitCode !== 0 && exitCode === 0) {
          exitCode = targetResult.exitCode;
        }
      }
    }
  }

  const finalSummary = formatSuiteTerminalSummary(suiteSummaries);
  if (finalSummary) {
    process.stdout.write(`\n${finalSummary}`);
  }
  return exitCode;
}

function runSequentialPerformanceSuite(options) {
  const targets = resolveRequestedTargets(options);
  if (!String(options.targetInput || '').trim()) {
    return runBatchedPerformanceSuite(targets, options);
  }
  let exitCode = 0;
  const suiteSummaries = [];
  let nextRealAppPortSequence = 0;
  let nextScanAppPort = options.scanAppBasePort || DEFAULT_SCAN_APP_PORT;

  for (const target of targets) {
    console.log(`=== Performance target: ${target.aliasNames[0] || target.specPath} ===`);
    const targetPorts = {
      realAppPort: targets.length > 1 && target.kind === 'synthetic'
        ? resolveManagedRealAppPortForSequence(
          nextRealAppPortSequence++,
          options.realAppBasePort,
        )
        : (options.realAppBasePort || DEFAULT_REAL_APP_PORT),
      scanAppPort: targets.length > 1 && target.kind === 'scan'
        ? nextScanAppPort++
        : (options.scanAppBasePort || DEFAULT_SCAN_APP_PORT),
    };
    const result = runTargetWithPolicy(target, options, targetPorts);
    suiteSummaries.push(summarizeTargetRun(target, result));
    if (result.exitCode !== 0 && exitCode === 0) {
      exitCode = result.exitCode;
    }
  }

  const finalSummary = formatSuiteTerminalSummary(suiteSummaries);
  if (finalSummary) {
    process.stdout.write(`\n${finalSummary}`);
  }
  return exitCode;
}

function printUsage() {
  console.log('Usage: npm run test:e2e:performance -- [--group all|idle-memory|playback-start|gapless-playback|real-app|scan] [--test <name-or-path>] [--repeat-count <n>] [--headed|--headless] [--browser chromium|chrome|edge] [--grep <pattern>]');
  console.log('Known names: idle-memory, playback-start, gapless-playback, all-artists, artist-family, search-all-artists, utility-problematic-files, utility-rules, selected-artist, search-browse, root-album-browse, app-open-all-artists, problematic-files-focused, rules-focused, scan-cold, scan-cached, scan-add-album, scan-metadata, scan-page');
  console.log('Known groups: all, idle-memory, playback-start, gapless-playback, real-app, scan');
  console.log('Coverage classes: real-app-isolated-postgres-memory, real-app-isolated-postgres-playback, real-app-library-browse-load, scanner-index-cache.');
  console.log('The performance runner defaults to headless mode; pass --headed to keep the browser visible.');
  console.log('The browser defaults to Playwright-managed Chromium; branded Chrome and Edge are explicit comparison overrides.');
  console.log('When --test is omitted, the command runs the default approved performance target group sequentially.');
}

module.exports = {
  _private: {
    applyTargetEnvOverrides,
    assertSinglePreloadedFixtureProfile,
    assertNoLiveCoverProviderDomains,
    buildAggregatedThresholdEvaluation,
    classifyPerformanceAttempt,
    buildAttemptEnv,
    buildBatchRunnerArgs,
    buildSyntheticFixtureIsolationEnv,
    buildAndAssertProviderWriteSafeEnv,
    buildScanStatusSamplesEnv,
    cleanupManagedScanStatusSamples,
    resolveAttemptTimeoutMs,
    groupTargetsForFullSuite,
    resolveBatchTargetStatus,
    formatDisplayedAttemptTotal,
    buildVerificationGroup,
    buildRunnerArgs,
    hasAggregateValidationResults,
    groupBatchesForFullSuiteBudgets,
    listDefaultPerformanceTargets,
    listGroupedPerformanceTargets,
    mean,
    median,
    normalizeRelativeSpecPath,
    parseCliArgs,
    printUsage,
    loadDotEnvFile,
    assertScanPerformanceDatabaseConfiguration,
    runScanPerformanceDatabasePreflight,
    runConfiguredPerformanceSuite,
    readLatestAttemptMetrics,
    isKnownUnsafeBrowserPort,
    isFinalizedPlaywrightJsonReport,
    managedRealAppPortBlockHasUnsafeBrowserPort,
    resolveManagedRealAppAttemptPort,
    resolveManagedRealAppPortForSequence,
    resolveConfiguredPerformanceBasePorts,
    resolveAttemptPorts,
    resolveRequestedTargets,
    resolvePerformanceTarget,
    resolvePerformanceAttemptStatus,
    resolvePerformanceAttemptArtifactDir,
    resolvePerformanceTargetArtifactRoot,
    resolvePlaywrightLastRunPath,
    runSinglePerformanceAttempt,
    runTargetWithPolicy,
    runSequentialPerformanceSuite,
    shouldAutoRetryThresholdFailure,
    summarizePerformanceTargets,
    summarizeTargetRun,
    formatSuiteTerminalSummary,
  },
  PERFORMANCE_TARGETS,
};

if (require.main === module) {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    printUsage();
    process.exit(0);
  }
  try {
    const args = parseCliArgs();
    const exitCode = runConfiguredPerformanceSuite(args);
    process.exit(exitCode);
  } catch (error) {
    console.error(error?.message || error);
    printUsage();
    process.exit(1);
  }
}
