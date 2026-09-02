const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const appJsPath = path.join(repoRoot, 'music_app', 'static', 'app.js');
const runtimeBundlePath = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime-bundle.js');
const {
  RUNTIME_SCRIPT_PATHS,
  buildRuntimeBundle,
} = require(path.join(repoRoot, 'scripts', 'build-runtime-bundle.cjs'));

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n');
}

function loadStartupAlbumCardRenderer() {
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const start = appJs.indexOf('  const isObject =');
  const end = appJs.indexOf('  const extractInitialView =');
  assert.notEqual(start, -1, 'startup helper block must have a stable opening marker');
  assert.notEqual(end, -1, 'startup helper block must have a stable closing marker');
  const context = {
    HTMLImageElement: class {},
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${appJs.slice(start, end)}\nglobalThis.__buildStartupAlbumCardHtml = buildStartupAlbumCardHtml;`,
    context,
    { filename: appJsPath },
  );
  return context.__buildStartupAlbumCardHtml;
}

const expectedRuntimeOrder = [
  'session-csrf-fetch.js',
  'bootstrap-state.js',
  'startup-metrics-helpers.js',
  'response-state-helpers.js',
  'view-state-helpers.js',
  'browser-navigation-helpers.js',
  'browser-storage-helpers.js',
  'browser-dialog-helpers.js',
  'browser-viewport-helpers.js',
  'browser-scheduling-helpers.js',
  'view-value-helpers.js',
  'markup-format-helpers.js',
  'loader-status-helpers.js',
  'status-ui-helpers.js',
  'notification-ui-helpers.js',
  'render-markup-helpers.js',
  'core-state-and-helpers.js',
  'player-streaming-engine.js',
  'shell-navigation-drawer.js',
  'account-menu.js',
  'bootstrap-refocus-helpers.js',
  'client-preferences-helpers.js',
  'gallery-display-preference-helpers.js',
  'playback-ownership-helpers.js',
  'modal-and-overlay-helpers.js',
  'track-modal-lightbox-helpers.js',
  'player-waveform-peaks.js',
  'loop-range-controls.js',
  'loop-edit-session-expiry.js',
  'player-and-waveform.js',
  'gallery-refresh-and-status.js',
  'problematic-album-helpers.js',
  'browser-log-history-store.js',
  'compact-data-table.js',
  'utility-list-builders.js',
  'problem-exclusion-mutations.js',
  'library-settings.js',
  'cover-lookup-notification-helpers.js',
  'utility-renderers-and-actions.js',
  'utility-loop-playback.js',
  'utility-loaders-and-cover-lookup.js',
  'cover-lookup-modal-and-drawer.js',
  'tag-editor-and-optimistic-updates.js',
  'player-state-persistence-helpers.js',
  'player-listen-session-helpers.js',
  'gallery-cover-preview-cache.js',
  'gallery-cover-load-scheduler.js',
  'virtual-artist-grid.js',
  'player-loop-playback.js',
  'track-modal-and-gallery.js',
  'bootstrap-utility-event-handlers.js',
  'bootstrap-gallery-event-handlers.js',
  'bootstrap-event-handlers.js',
  'bootstrap-init.js',
];

test('app loader fetches one generated runtime bundle instead of individual runtime modules', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const bundleJs = fs.readFileSync(runtimeBundlePath, 'utf8');

  assert.deepEqual(
    RUNTIME_SCRIPT_PATHS,
    expectedRuntimeOrder.map((fileName) => `js/runtime/${fileName}`),
  );
  assert.equal(normalizeNewlines(bundleJs), normalizeNewlines(buildRuntimeBundle()));
  assert.match(appJs, /const runtimeAssetVersion = encodeURIComponent\(/);
  assert.match(appJs, /const runtimeBundlePath = `js\/runtime-bundle\.js\$\{runtimeAssetVersion/);
  assert.doesNotMatch(appJs, /const scriptPaths = \[/);
  assert.doesNotMatch(appJs, /Promise\.all\(scriptPaths\.map/);
  assert.equal((appJs.match(/window\.fetch\(/g) || []).length, 2);

  let previousIndex = -1;
  for (const fileName of expectedRuntimeOrder) {
    assert.doesNotMatch(appJs, new RegExp(`'js/runtime/${fileName.replaceAll('.', '\\.')}'`));
    const marker = `// BEGIN js/runtime/${fileName}`;
    const index = bundleJs.indexOf(marker);
    assert.notEqual(index, -1, `missing ${marker}`);
    assert.ok(index > previousIndex, `${fileName} should appear after the previous runtime module`);
    previousIndex = index;
  }

  assert.match(bundleJs, /runtime_boot_complete/);
  assert.match(
    bundleJs,
    /\/\/ BEGIN js\/runtime\/player-streaming-engine\.js[\s\S]*\/\/ END js\/runtime\/player-streaming-engine\.js/,
  );
  assert.ok(
    bundleJs.indexOf('// BEGIN js/runtime/core-state-and-helpers.js')
      < bundleJs.indexOf('// BEGIN js/runtime/player-streaming-engine.js'),
  );
  assert.ok(
    bundleJs.indexOf('// BEGIN js/runtime/player-streaming-engine.js')
      < bundleJs.indexOf('// BEGIN js/runtime/shell-navigation-drawer.js'),
  );
  assert.ok(
    bundleJs.indexOf('// BEGIN js/runtime/player-waveform-peaks.js')
      < bundleJs.indexOf('// BEGIN js/runtime/loop-range-controls.js'),
    'waveform peaks must load before the shared loop controls',
  );
  assert.ok(
    bundleJs.indexOf('// BEGIN js/runtime/loop-range-controls.js')
      < bundleJs.indexOf('// BEGIN js/runtime/loop-edit-session-expiry.js'),
    'shared loop controls must load before loop edit session expiry',
  );
  assert.ok(
    bundleJs.indexOf('// BEGIN js/runtime/loop-edit-session-expiry.js')
      < bundleJs.indexOf('// BEGIN js/runtime/player-and-waveform.js'),
    'loop edit session expiry must load before player integrations',
  );
  assert.ok(
    bundleJs.indexOf('// BEGIN js/runtime/bootstrap-event-handlers.js')
      < bundleJs.indexOf('// BEGIN js/runtime/bootstrap-init.js'),
  );
  assert.doesNotMatch(appJs, /cached_preview/);
  assert.doesNotMatch(bundleJs, /cached_preview/);
  for (const runtimePath of RUNTIME_SCRIPT_PATHS) {
    const runtimeSource = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', runtimePath), 'utf8');
    assert.doesNotMatch(runtimeSource, /cached_preview/, `${runtimePath} must use the current startup preview contract`);
  }
});

test('startup album covers stay presentation-hidden until native decoded readiness', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  assert.match(appJs, /data-cover-visual-state="pending" aria-hidden="true"/);
  assert.match(appJs, /handleStartupAlbumCoverImageLoad\(this\)/);
  assert.match(appJs, /imageElement\.complete/);
  assert.match(appJs, /imageElement\.naturalWidth/);
  assert.match(appJs, /imageElement\.dataset\.coverVisualState = 'ready'/);
  assert.match(appJs, /imageElement\.removeAttribute\('aria-hidden'\)/);
  assert.match(appJs, /cover-placeholder cover-placeholder-blank/);
});

test('startup and runtime covers preserve the server-authored production cache identity', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const bundleJs = fs.readFileSync(runtimeBundlePath, 'utf8');

  assert.match(appJs, /album\?\.cover_preview_url/);
  assert.match(appJs, /return canonicalPreviewUrl/);
  assert.match(appJs, /rememberStartupCoverUrls\(initialView\)/);
  assert.match(bundleJs, /album\?\.cover_preview_url/);
  assert.match(bundleJs, /rememberedStartupUrls\.get\(localCoverPath\)/);
  assert.match(bundleJs, /startupPreviewUrl && !state\.coverRefreshTokens\[localCoverPath\]/);
});

test('startup fallback album cards render ten app-owned rating positions without inventing zero', () => {
  const buildStartupAlbumCardHtml = loadStartupAlbumCardRenderer();
  const ratedMarkup = buildStartupAlbumCardHtml({
    key: 'rated',
    name: 'Rated',
    album_artist: 'Rating Artist',
    album_rating: 4,
    tag_album_rating: 9,
    album_preference: { rating: 6 },
  });
  const unratedMarkup = buildStartupAlbumCardHtml({
    key: 'unrated',
    name: 'Unrated',
    album_artist: 'Rating Artist',
    album_rating: 8,
    tag_album_rating: 9,
  });

  assert.match(ratedMarkup, /<div class="stars" role="img" aria-label="Album rating 6\/10">/);
  assert.match(ratedMarkup, /<div class="rating-text">6\/10<\/div>/);
  assert.equal((ratedMarkup.match(/class="star filled"/g) || []).length, 6);
  assert.equal((ratedMarkup.match(/&#9733;/g) || []).length, 6);
  assert.equal((ratedMarkup.match(/&#9734;/g) || []).length, 4);

  assert.match(unratedMarkup, /<div class="stars" role="img" aria-label="Album unrated">/);
  assert.equal((unratedMarkup.match(/class="star filled"/g) || []).length, 0);
  assert.equal((unratedMarkup.match(/&#9733;/g) || []).length, 0);
  assert.equal((unratedMarkup.match(/&#9734;/g) || []).length, 10);
  assert.doesNotMatch(unratedMarkup, /class="rating-text"|0\/10/);
});
