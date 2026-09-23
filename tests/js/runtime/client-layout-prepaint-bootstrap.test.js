const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..', '..');
const bootstrapPath = path.join(root, 'music_app', 'static', 'js', 'client-layout-bootstrap.js');
const templatePath = path.join(root, 'music_app', 'templates', 'index.html');

function loadBootstrap() {
  delete require.cache[require.resolve(bootstrapPath)];
  return require(bootstrapPath);
}

test('captures saved tree, compact player, and gallery scale before markup paints', () => {
  const bootstrap = loadBootstrap();
  const storage = new Map([
    ['albumhaven.shellLayoutPreferences.v1', JSON.stringify({ artistTreeFolded: true })],
    ['albumhaven.compactPlayer.mode.v1', 'compact'],
    ['albumhaven.galleryDisplayPreferences.v1', JSON.stringify({ defaultGalleryScalePercent: 120 })],
  ]);
  const result = bootstrap.resolveClientLayoutPreferences({
    storage: { getItem: key => storage.get(key) ?? null },
    href: 'http://localhost:5001/',
    viewportWidth: 1200,
    appearance: { compact_player_style: 'docked', docked_compact_player_behavior: 'follow_sidebar' },
  });

  assert.deepEqual(result, {
    artistTreeFolded: true,
    compactPlayerMode: 'compact',
    compactPlayerPresentation: 'rail_play',
    galleryScalePercent: 120,
  });
});

test('URL scale wins while invalid or inaccessible browser storage falls back safely', () => {
  const bootstrap = loadBootstrap();
  const brokenStorage = { getItem() { throw new Error('denied'); } };
  assert.deepEqual(bootstrap.resolveClientLayoutPreferences({
    storage: brokenStorage,
    href: 'http://localhost:5001/?gallery_scale_percent=80',
    viewportWidth: 1200,
    appearance: {},
  }), {
    artistTreeFolded: false,
    compactPlayerMode: 'expanded',
    compactPlayerPresentation: 'expanded',
    galleryScalePercent: 80,
  });

  assert.equal(bootstrap.resolveClientLayoutPreferences({
    storage: { getItem: () => '{bad json' },
    href: 'http://localhost:5001/?gallery_scale_percent=999',
    viewportWidth: 1200,
    appearance: {},
  }).galleryScalePercent, 100);
});

test('mobile keeps the tree and player expanded while retaining the saved gallery scale', () => {
  const bootstrap = loadBootstrap();
  const values = {
    'albumhaven.shellLayoutPreferences.v1': JSON.stringify({ artistTreeFolded: true }),
    'albumhaven.compactPlayer.mode.v1': 'compact',
    'albumhaven.galleryDisplayPreferences.v1': JSON.stringify({ defaultGalleryScalePercent: 90 }),
  };
  assert.deepEqual(bootstrap.resolveClientLayoutPreferences({
    storage: { getItem: key => values[key] ?? null },
    href: 'http://localhost:5001/',
    viewportWidth: 900,
    appearance: {},
  }), {
    artistTreeFolded: false,
    compactPlayerMode: 'expanded',
    compactPlayerPresentation: 'expanded',
    galleryScalePercent: 90,
  });
});

test('startup gallery geometry uses the saved scale and available width', () => {
  const bootstrap = loadBootstrap();
  assert.deepEqual(bootstrap.resolveStartupGalleryGeometry({
    availableWidth: 1000,
    scalePercent: 120,
  }), { columns: 3, cardTrackWidth: 324 });
  assert.deepEqual(bootstrap.resolveStartupGalleryGeometry({
    availableWidth: 1000,
    scalePercent: 80,
  }), { columns: 4, cardTrackWidth: 239.5 });
});

test('library template captures preferences in the head and finalizes before deferred runtime', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const scriptIndex = template.indexOf("filename='js/client-layout-bootstrap.js'");
  const bodyIndex = template.indexOf('<body>');
  const playerIndex = template.indexOf('class="global-player shell-bottom-player"');
  const finalizeIndex = template.indexOf('AlbumHavenClientLayoutBootstrap.finalize');

  assert.ok(scriptIndex > -1 && scriptIndex < bodyIndex, 'pre-paint bootstrap must block before body parsing');
  assert.ok(finalizeIndex > playerIndex, 'finalizer must run after the tree, gallery, and player markup exists');
  assert.ok(finalizeIndex < template.lastIndexOf('</body>'), 'finalizer must run before the first completed document frame');
  assert.match(template, /data-client-layout-pending="true"\][^}]*transition:\s*none\s*!important/s);
  assert.match(fs.readFileSync(bootstrapPath, 'utf8'), /void root\.offsetWidth;\s*root\.removeAttribute\('data-client-layout-pending'\)/);
  assert.match(fs.readFileSync(bootstrapPath, 'utf8'), /data-docked-compact-player-regular-style/);
});

test('fallback startup gallery renderer consumes the captured scale', () => {
  const appEntry = fs.readFileSync(path.join(root, 'music_app', 'static', 'app.js'), 'utf8');
  assert.match(appEntry, /__ALBUM_HAVEN_CLIENT_LAYOUT__\?\.galleryScalePercent/);
  assert.match(appEntry, /240 \* \(galleryScalePercent \/ 100\)/);
  assert.match(appEntry, /Number\(scrollEl\.clientWidth \|\| 0\) - 4/);
  assert.match(appEntry, /const startupCardTrackWidth = \(width - \(columns - 1\) \* 14\) \/ columns/);
  assert.match(appEntry, /repeat\(\$\{columns\}, minmax\(0, \$\{startupCardTrackWidth\}px\)\)/);
});
