const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const proposedRuntimeFiles = [
  'album-artbox.js',
  'gallery-main-components.js',
  'gallery-main-state.js',
  'gallery-main-interactions.js',
];
const bootstrapGalleryEventHandlersSource = fs.readFileSync(
  path.join(runtimeRoot, 'bootstrap-gallery-event-handlers.js'),
  'utf8',
);
const coreStateAndHelpersSource = fs.readFileSync(
  path.join(runtimeRoot, 'core-state-and-helpers.js'),
  'utf8',
);
const galleryMainInteractionsSource = fs.readFileSync(
  path.join(runtimeRoot, 'gallery-main-interactions.js'),
  'utf8',
);
const galleryMainCssSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'gallery-main.css'),
  'utf8',
);
const galleryMainComponentsSource = fs.readFileSync(path.join(runtimeRoot, 'gallery-main-components.js'), 'utf8');
const galleryMainStateSource = fs.readFileSync(path.join(runtimeRoot, 'gallery-main-state.js'), 'utf8');
const mobileLayoutCssSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'mobile-layout.css'),
  'utf8',
);
const buttonComponentCssSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'button-component.css'),
  'utf8',
);
const triggerAnchorCssSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'trigger-anchor.css'),
  'utf8',
);
const galleryBarTemplateSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'partials', 'gallery-bar.html'),
  'utf8',
);
const indexTemplateSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'),
  'utf8',
);

test('connected trigger accents follow light palette colors', () => {
  assert.match(
    triggerAnchorCssSource,
    /:root\[data-appearance-mode='light'\]\s*\{[^}]*--appearance-selected-accent:\s*var\(--appearance-accent,\s*#596775\);/,
  );
  assert.match(
    triggerAnchorCssSource,
    /--trigger-anchor-accent:\s*var\(--appearance-selected-accent\);/,
  );
});

test('connected triggers leave the edge adjoining their surface unpainted', () => {
  // The continuous outline and opaque inner mask own paint; the trigger still
  // omits the border facing its popup for both opening directions.
  assert.match(
    triggerAnchorCssSource,
    /\.trigger-anchor-open\s*\{[^}]*border-bottom:\s*0 !important;[^}]*linear-gradient\(var\(--trigger-anchor-background\), var\(--trigger-anchor-background\)\) padding-box !important;/s,
  );
  assert.match(
    triggerAnchorCssSource,
    /\.trigger-anchor-open::after\s*\{[^}]*background:\s*var\(--trigger-anchor-border-fill\);/s,
  );
  assert.match(
    triggerAnchorCssSource,
    /\.trigger-anchor-open\[data-trigger-anchor-edge="bottom"\]\s*\{[^}]*border-top:\s*0 !important;[^}]*--trigger-anchor-direction:\s*to top;/s,
  );
  assert.match(
    triggerAnchorCssSource,
    /\.trigger-anchor-open\[data-trigger-anchor-edge="bottom"\]::before\s*\{[^}]*top:\s*calc\(-1 \* var\(--trigger-anchor-gap, 0px\) - 4px\); bottom:\s*0;/s,
  );
});

test('Gallery toolbar buttons keep the main surface on mobile and use the control surface on desktop', () => {
  assert.match(
    galleryMainCssSource,
    /\.gallery-bar__actions\s*\{[^}]*--gallery-toolbar-button-background:\s*var\(--appearance-main-surface,\s*var\(--panel\)\)/,
  );
  assert.match(
    galleryMainCssSource,
    /\.gallery-action-button\s*\{[^}]*background:\s*var\(--gallery-toolbar-button-background,\s*var\(--appearance-main-surface,\s*var\(--panel\)\)\)/,
  );
  assert.match(
    galleryMainCssSource,
    /@media \(min-width: 901px\)\s*\{[\s\S]*?\.gallery-bar__actions\s*\{[^}]*--gallery-toolbar-button-background:\s*var\(--appearance-control,\s*var\(--panel\)\)[^}]*\}[\s\S]*?\.gallery-action-button\s*\{[^}]*background:\s*var\(--gallery-toolbar-button-background,\s*var\(--appearance-control,\s*var\(--panel\)\)\)[^}]*\}/,
  );
  assert.match(
    galleryMainCssSource,
    /\.gallery-bar__actions :is\(\.gallery-view-cluster, \.gallery-view-choice\)\s*\{[^}]*background:\s*var\(--gallery-toolbar-button-background\)/,
  );
});

test('connected dropdown surfaces follow their light content context', () => {
  assert.match(
    indexTemplateSource,
    /data-anchored-surface="album-types" data-trigger-anchor-context="content"/,
  );
  assert.match(
    triggerAnchorCssSource,
    /:root\[data-appearance-mode='light'\] :is\(\.shell-main-surface, \.settings-outlet\)\s*\{[^}]*--trigger-anchor-background:\s*var\(--appearance-card\);/,
  );
  assert.match(
    triggerAnchorCssSource,
    /:root\s*\{[^}]*--trigger-anchor-background:\s*var\(--appearance-panel-background, var\(--panel\)\);/,
  );
  assert.match(
    triggerAnchorCssSource,
    /:root \[data-trigger-anchor-context='content'\],\s*:root\[data-appearance-palette\] \[data-trigger-anchor-context='content'\]\s*\{[^}]*--trigger-anchor-background:\s*var\(--appearance-card\);[^}]*--text:\s*var\(--appearance-ink\);[^}]*--muted:\s*var\(--appearance-muted\);/,
  );
  assert.match(
    triggerAnchorCssSource,
    /\.trigger-anchor-open\[data-trigger-anchor-context='content'\]\s*\{[^}]*--trigger-anchor-background:\s*var\(--appearance-card, var\(--panel\)\);/,
  );
});

test('app-bar dropdown surfaces use Settings panel text and hover tokens after portaling', () => {
  assert.match(
    indexTemplateSource,
    /data-anchored-surface="sources" data-trigger-anchor-context="chrome"/,
  );
  assert.match(
    triggerAnchorCssSource,
    /data-trigger-anchor-context='chrome'[^}]*\{[^}]*--text:\s*var\(--appearance-panel-ink,[^}]*--muted:\s*var\(--appearance-panel-muted,[^}]*--panel:\s*var\(--appearance-panel-background,[^}]*--dropdown-item-hover-background:\s*var\(--appearance-panel-action-hover-background,[^}]*color:\s*var\(--text\);/,
  );
  assert.match(
    triggerAnchorCssSource,
    /\.trigger-anchor-open\[data-trigger-anchor-context='chrome'\]\s*\{[^}]*--trigger-anchor-background:\s*var\(--appearance-panel-background, var\(--panel\)\);/,
  );
});

function loadRuntime(overrides = {}) {
  const context = {
    escapeHtml: (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;'),
    console,
    hasHydratedLibraryNonAlbumTracks: () => false,
    albumHasDisplayCover: album => Boolean(album?.cover_url),
    buildAlbumDisplayCoverUrl: album => album?.cover_url || '',
    buildAlbumLightboxCoverUrl: album => album?.cover_url || '',
    ...overrides,
  };
  vm.createContext(context);
  proposedRuntimeFiles.forEach((filename) => {
    const sourcePath = path.join(runtimeRoot, filename);
    if (fs.existsSync(sourcePath)) vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  });
  return context;
}

function requireContract(context, name) {
  assert.equal(typeof context[name], 'function', `${name} must be provided by the Gallery refactor runtime`);
  return context[name];
}

test('search gallery shows artist information in the header and in artist section headings', () => {
  const context = loadRuntime({ state: { view: { query: 'Neal Morse' } } });
  const config = { artist: 'Neal Morse', artistCount: 1, albumCount: 3, contextKind: 'artist' };
  const galleryBar = context.buildGalleryBarHtml(config);
  const artistHeading = context.buildFamilyArtistHeaderHtml(config);

  // Owner (11-08): the header names one artist during a search too, so its info icon shows there.
  assert.match(galleryBar, /data-artist-info-trigger="1" data-artist="Neal Morse"/);
  assert.match(
    artistHeading,
    /class="artist-name"[^>]*>Neal Morse<\/h2>[\s\S]*?data-artist-info-trigger[\s\S]*?gallery-divider__line[\s\S]*?3 albums/,
  );
  // Search results open the same artist panel, with its MusicBrainz and Discogs links.
  const opener = galleryMainInteractionsSource.slice(galleryMainInteractionsSource.indexOf('function openGalleryArtistInfo('));
  assert.doesNotMatch(opener.slice(0, opener.search(/\r?\n}\r?\n/)), /state\.view\.query/);
  const chrome = galleryMainInteractionsSource.slice(galleryMainInteractionsSource.indexOf('function updateGalleryMainChrome('));
  assert.match(chrome.slice(0, chrome.search(/\r?\n}\r?\n/)), /openingQuery[\s\S]*closeGalleryMainSurface\(false\)/,
    'a changed search closes the artist panel whose information it replaced');
});

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Artist Family controls follow selected artist and close without focusing a hidden root trigger', () => {
  let focusCount = 0;
  const trigger = { hidden: false, setAttribute() {}, focus() { focusCount += 1; } };
  const view = { selected_artist: '' };
  const context = loadRuntime({
    state: { view }, window: {},
    document: { querySelectorAll: () => [], getElementById: () => null,
      querySelector: selector => selector === '[data-gallery-bar-action="artist-family"]' ? trigger : null },
  });
  context.ensureGalleryMainState = () => ({});
  context.focusGalleryMainSurface = () => {};
  context.updateGalleryMainControls();
  assert.equal(trigger.hidden, true);
  view.selected_artist = 'Neal Morse';
  context.updateGalleryMainControls();
  assert.equal(trigger.hidden, false);
  const panel = { hidden: true, matches: () => false, setAttribute() {},
    classList: { add() {}, remove() {} } };
  context.openGalleryMainSurface('artist-family', trigger, panel);
  assert.equal(panel.hidden, false);
  view.selected_artist = '';
  context.updateGalleryMainControls();
  assert.equal(trigger.hidden, true);
  assert.equal(panel.hidden, true);
  assert.equal(focusCount, 0);
});

test('an open Album Types menu hydrates deferred loose tracks after navigation changes the view', async () => {
  let hydrationCount = 0;
  const view = {};
  const anchor = { setAttribute() {}, contains: () => false };
  const surface = {
    hidden: true,
    matches: () => false,
    setAttribute() {},
    contains: () => false,
    classList: { add() {}, remove() {} },
  };
  const context = loadRuntime({
    state: { view },
    window: {},
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: id => id === 'gallery-album-types-menu' ? surface : null,
      body: { appendChild() {} },
    },
  });
  context.ensureGalleryMainState = () => ({ albumTypes: [], sources: {} });
  context.focusGalleryMainSurface = () => {};
  context.hydrateDeferredNonAlbumTracks = async () => { hydrationCount += 1; };
  context.openGalleryMainSurface('album-types', anchor, surface);

  view.non_album_tracks_deferred = true;
  vm.runInContext('galleryMainSurfaceController = createAnchoredSurfaceController()', context);
  context.updateGalleryMainControls();
  await Promise.resolve();

  assert.equal(hydrationCount, 1);
});

test('opening Sources hydrates deferred loose tracks', async () => {
  let hydrationCount = 0;
  const view = { non_album_tracks_deferred: true };
  const anchor = { setAttribute() {}, contains: () => false };
  const surface = {
    hidden: true,
    matches: () => false,
    setAttribute() {},
    contains: () => false,
    classList: { add() {}, remove() {} },
  };
  const context = loadRuntime({
    state: { view },
    window: {},
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      body: { appendChild() {} },
    },
  });
  context.hydrateDeferredNonAlbumTracks = async () => { hydrationCount += 1; };

  context.openGalleryMainSurface('sources', anchor, surface);
  await Promise.resolve();

  assert.equal(hydrationCount, 1);
});

test('initial Artist Family markup is hidden only when no effective artist is selected', () => {
  const button = indexTemplateSource.match(/<button[^>]*data-gallery-bar-action="artist-family"[^>]*>/)?.[0];
  assert.match(button, /\{% if not effective_selected_artist %\} hidden\{% endif %\}/);
});

test('artist info ignores queued pre-open scroll but dismisses real post-open movement', () => {
  const listeners = {};
  const scroll = { scrollTop: 0, scrollLeft: 0, addEventListener: (type, callback) => { listeners[type] = callback; } };
  const context = loadRuntime({
    document: { getElementById: id => id === 'albums-scroll' ? scroll : null,
      querySelector: () => null, addEventListener() {} },
    window: { addEventListener() {} },
    requestAnimationFrame: () => 1,
  });
  // Keep unrelated chrome/layout work outside this event-lifecycle test.
  context.ensureGalleryMainState = () => ({});
  context.observeArtistFamilyPanelBounds = () => null;
  context.updateGalleryMainChrome = () => {};
  context.focusGalleryMainSurface = () => {};
  context.initGalleryMain();
  const anchor = { setAttribute() {} };
  const surface = { hidden: true, matches: () => false, setAttribute() {},
    classList: { add() {}, remove() {} } };
  context.openGalleryMainSurface('artist:Neal Morse', anchor, surface);
  listeners.scroll();
  assert.equal(surface.hidden, false, 'queued event at the opening position must not close the popup');
  scroll.scrollTop = 1;
  listeners.scroll();
  assert.equal(surface.hidden, true, 'actual vertical movement dismisses the popup');
  context.openGalleryMainSurface('artist:Neal Morse', anchor, surface);
  listeners.scroll();
  assert.equal(surface.hidden, false, 'reopening records the new position');
  scroll.scrollLeft = 1;
  listeners.scroll();
  assert.equal(surface.hidden, true, 'actual horizontal movement dismisses the popup');
});

test('Album Types uses the same theme-inheriting stacked-sleeves icon before and after hydration', () => {
  const context = loadRuntime();
  const bar = requireContract(context, 'buildGalleryBarHtml')({});
  const template = fs.readFileSync(path.join(__dirname, '../../../music_app/templates/index.html'), 'utf8');
  const icon = markup => markup.match(/data-gallery-bar-action="album-types"[^>]*>(<svg[\s\S]*?<\/svg>)/)[1];
  assert.equal(icon(bar), icon(template));
  assert.match(icon(bar), /<rect x="8" y="8" width="14" height="14" rx="2"\/>/);
  assert.match(icon(bar), /fill="currentColor" fill-rule="evenodd" stroke="none"/);
  assert.doesNotMatch(icon(bar), /#[0-9a-f]{3,8}|fill="(?:white|black)"/i);
});

test('reusable GalleryBar, switch, panel, divider, and artist heading render accessible contracts', () => {
  const context = loadRuntime();
  const buildGalleryBarHtml = requireContract(context, 'buildGalleryBarHtml');
  const buildSwitchHtml = requireContract(context, 'buildGallerySwitchHtml');
  const buildArtistFamilyPanelHtml = requireContract(context, 'buildArtistFamilyPanelHtml');
  const buildGalleryDividerHtml = requireContract(context, 'buildGalleryDividerHtml');
  const buildFamilyArtistHeaderHtml = requireContract(context, 'buildFamilyArtistHeaderHtml');

  const bar = buildGalleryBarHtml({
    primaryArtist: 'Neal Morse', artistCount: 3, albumCount: 12, contextKind: 'family',
  });
  assert.match(bar, /Neal Morse family/);
  assert.match(bar, /3 artists/);
  assert.match(bar, /12 albums/);
  assert.equal((bar.match(/data-gallery-bar-action=/g) || []).length, 3);
  assert.match(bar, /data-gallery-bar-action="artist-family"/);
  assert.match(bar, /data-gallery-bar-action="view"/);
  assert.match(bar, /data-gallery-bar-action="album-types"/);
  assert.doesNotMatch(bar, /aria-haspopup="menu"/);
  assert.doesNotMatch(bar, /data-artist-info-trigger/);

  const galleryBar = buildGalleryBarHtml({
    contextKind: 'gallery', artistCount: 1985, albumCount: 6057,
  });
  assert.match(galleryBar, /Gallery/);
  assert.match(galleryBar, /1985 artists/);
  assert.match(galleryBar, /6057 albums/);
  assert.doesNotMatch(galleryBar, /data-gallery-context-name>[^<]*family/);
  assert.doesNotMatch(galleryBar, /data-artist-info-trigger/);

  const artistBar = buildGalleryBarHtml({ contextKind: 'artist', artist: 'Transatlantic', albumCount: 5 });
  assert.match(artistBar, /Transatlantic/);
  assert.match(artistBar, /5 albums/);
  assert.match(artistBar, /data-artist-info-trigger/);

  const singleArtistBar = buildGalleryBarHtml({ contextKind: 'single-artist', artist: 'Alestorm', albumCount: 4 });
  assert.match(singleArtistBar, /data-gallery-context-name>Alestorm</);
  assert.match(singleArtistBar, /data-artist-info-trigger/);
  assert.match(singleArtistBar, /data-gallery-context-artist-divider hidden/);
  // "Alestorm (i) • 4 albums" on the title line; the summary line is free for pills.
  assert.match(singleArtistBar, /data-gallery-context-inline-total hidden><\/span>/);
  assert.match(singleArtistBar, /data-gallery-context-summary>4 albums<\/span>/);

  const toggle = buildSwitchHtml({ id: 'gallery-source-hoard', label: 'Hoard', checked: true });
  assert.match(toggle, /role="switch"/);
  assert.match(toggle, /aria-checked="true"/);
  assert.match(toggle, />Hoard</);

  const panel = buildArtistFamilyPanelHtml({ title: 'Artist Family', bodyHtml: '<p>Related artists</p>' });
  assert.match(panel, /data-artist-family-panel/);
  assert.match(panel, /class="artist-family-panel__heading"/);
  assert.match(panel, /Select or unselect an artist to update Gallery\./);
  assert.match(panel, /aria-label="Artist Family"/);
  assert.match(panel, /aria-hidden="true" hidden/);
  assert.match(panel, /Related artists/);
  assert.match(panel, /data-toggle-combine-similar-artists="1"/);
  assert.match(panel, /role="switch"/);
  assert.match(panel, />Combine similar artists</);

  assert.match(buildGalleryDividerHtml({ label: 'Family', albumCount: 9 }), /Family[\s\S]*9 albums/);
  const artistHeading = buildFamilyArtistHeaderHtml({ artist: 'Flying Colors', albumCount: 4 });
  assert.match(artistHeading, /class="artist-name"[^>]*>Flying Colors</);
  assert.match(artistHeading, /Flying Colors[\s\S]*4 albums/);
});

test('current GalleryBar owner keeps artist metadata to two lines on web and mobile', () => {
  const context = loadRuntime();
  const projection = {
    country: 'Russia',
    genres: ['Heavy Metal', 'Power Metal', 'Hard Rock', 'Fourth Genre'],
  };
  const markup = requireContract(context, 'buildGalleryBarHtml')({
    contextKind: 'artist',
    artist: 'Kipelov',
    albumCount: 4,
    artist_musicbrainz: projection,
  });

  const nameAt = markup.indexOf('Kipelov');
  const infoAt = markup.indexOf('data-artist-info-trigger');
  const firstGenreAt = markup.indexOf('Heavy Metal');
  const countAt = markup.indexOf('4 albums');
  const countryAt = markup.indexOf('Russia');
  assert.ok(nameAt >= 0 && nameAt < infoAt && infoAt < firstGenreAt && firstGenreAt < countAt && countAt < countryAt);
  assert.match(markup, /gallery-bar__title[\s\S]*data-artist-info-trigger[\s\S]*data-gallery-context-metadata[\s\S]*Heavy Metal[\s\S]*<\/div><span class="gallery-bar__summary"/);
  assert.match(markup, /class="ui-metadata-pill ui-metadata-pill--country"[^>]*>Russia</);
  assert.equal((markup.match(/ui-metadata-pill--genre/g) || []).length, 1);
  assert.match(markup, />Heavy Metal</);
  assert.doesNotMatch(markup, /Power Metal|Hard Rock/);
  assert.doesNotMatch(markup, /Fourth Genre/);
  assert.doesNotMatch(markup, /gallery-bar__actions[\s\S]*MusicBrainz/);

  assert.match(buttonComponentCssSource, /\.ui-metadata-pill\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(buttonComponentCssSource, /\.ui-metadata-pill--genre\s*\{[^}]*background:\s*#11202a[^}]*border[^;]*#4199c3[^}]*color:\s*#8bd9ff/is);
  // Country pill: the owner-approved violet (2026-11-07), as tokens with a light-theme variant.
  assert.match(buttonComponentCssSource, /\.ui-metadata-pill--country\s*\{[^}]*--ui-metadata-pill-country-fill:\s*#1c1730;[^}]*--ui-metadata-pill-country-border:\s*#8b6fd6;[^}]*--ui-metadata-pill-country-ink:\s*#cbb8ff;[^}]*background:\s*var\(--ui-metadata-pill-country-fill\)/s);
  assert.match(buttonComponentCssSource, /:root\[data-appearance-mode='light'\] \.ui-metadata-pill--country\s*\{[^}]*--ui-metadata-pill-country-fill:\s*#f1ecfd;[^}]*--ui-metadata-pill-country-ink:\s*#4a2e99;/s);
  assert.doesNotMatch(galleryMainCssSource, /ui-metadata-pill--country/, 'no page-local country colour');
  assert.match(markup, /data-gallery-context-summary>4 albums<span class="gallery-bar__artist-country"><span class="ui-metadata-pill ui-metadata-pill--country">Russia<\/span><\/span><\/span>/,
    'the second line is album count, fat dot, and country');
  assert.match(galleryMainCssSource, /\.gallery-bar__artist-country::before\s*\{[^}]*content:\s*"\\2022"/s);
  assert.match(galleryMainCssSource, /\.gallery-bar__summary\s*\{[^}]*display:\s*flex;[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(galleryMainCssSource + mobileLayoutCssSource, /\.gallery-bar__artist-metadata\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.equal((markup.match(/data-gallery-context-metadata/g) || []).length, 1, 'genre metadata has no third-row owner');
});

test('mobile artist GalleryBar ellipsizes instead of creating a third line', () => {
  const classes = new Set(['is-name-wrapping']);
  const context = loadRuntime({ window: { innerWidth: 390 } });
  const bar = {
    dataset: { galleryContextKind: 'artist' },
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
    },
    querySelector: () => ({}),
  };
  context.syncGalleryBarNameFit(bar, { textContent: 'A very long artist name', scrollWidth: 260, clientWidth: 100 });
  assert.equal(classes.has('is-name-wrapping'), false);
});

test('GalleryBar distinguishes confirmed-empty genres and never leaks metadata into family contexts', () => {
  const context = loadRuntime();
  const buildGalleryBarHtml = requireContract(context, 'buildGalleryBarHtml');
  const confirmedEmpty = buildGalleryBarHtml({
    contextKind: 'single-artist', artist: 'Unknown Artist', albumCount: 1,
    artist_musicbrainz: { country: null, genres: ['Genre unavailable'] },
  });
  assert.match(confirmedEmpty, /ui-metadata-pill--genre-unavailable[^>]*>Genre unavailable</);

  const family = buildGalleryBarHtml({
    contextKind: 'family', primaryArtist: 'Kipelov', artistCount: 2, albumCount: 6,
    artist_musicbrainz: { country: 'Russia', genres: ['Heavy Metal'] },
  });
  assert.doesNotMatch(family, /ui-metadata-pill|Russia|Heavy Metal|Genre unavailable/);

  const familyHeader = requireContract(context, 'buildFamilyArtistHeaderHtml')({
    artist: 'Kipelov', albumCount: 4,
    artist_musicbrainz: { country: 'Russia', genres: ['Heavy Metal'] },
  });
  const separator = requireContract(context, 'buildGalleryDividerHtml')({
    label: 'Family', albumCount: 2,
    artist_musicbrainz: { country: 'Russia', genres: ['Heavy Metal'] },
  });
  assert.doesNotMatch(familyHeader, /ui-metadata-pill|Russia|Heavy Metal|Genre unavailable/);
  assert.doesNotMatch(separator, /ui-metadata-pill|Russia|Heavy Metal|Genre unavailable/);
});

test('stored artist metadata survives the existing sticky-context projection into current owners', () => {
  const projection = { country: 'Russia', genres: ['Heavy Metal', 'Power Metal'] };
  const context = loadRuntime({
    virtualGrid: {
      sectionHeaderHeight: 52,
      sections: [{
        kind: 'artist', top: 200,
        group: { artist: 'Kipelov', albums: [{}, {}], artist_musicbrainz: projection },
      }],
    },
    document: {
      getElementById: () => ({ scrollTop: 260, getBoundingClientRect: () => ({ top: 100 }) }),
      querySelectorAll: () => [],
    },
  });

  const sections = plain(context.getGalleryMainContextSections());
  assert.deepEqual(sections[0].artist_musicbrainz, projection);
  const sticky = plain(context.resolveGalleryBarContext({
    scrollTop: 260,
    artistCount: 1,
    albumCount: 2,
    groups: sections,
  }));
  assert.deepEqual(sticky.artist_musicbrainz, projection);
  assert.equal(sticky.artist, 'Kipelov');

  assert.match(galleryMainInteractionsSource, /data-gallery-context-metadata/);
  assert.match(galleryMainInteractionsSource, /buildGalleryArtistMetadataHtml\s*\(/);
  assert.equal((galleryBarTemplateSource.match(/data-gallery-context-metadata/g) || []).length, 1,
    'the shared GalleryBar macro keeps one metadata slot for the gallery context');
  assert.match(indexTemplateSource, /gallery_bar\([^)]*gallery_context=true/);
});

test('the existing delegated Gallery handler opens the exact artist problem occurrence', () => {
  assert.match(
    bootstrapGalleryEventHandlersSource,
    /closest\(['"]\[data-open-musicbrainz-artist-problem\]['"]\)/,
  );
  assert.match(
    bootstrapGalleryEventHandlersSource,
    /openMusicBrainzArtistProblem\s*\([^)]*(?:dataset\.openMusicbrainzArtistProblem|getAttribute\(['"]data-open-musicbrainz-artist-problem['"]\))[^)]*\)/,
  );
  assert.doesNotMatch(
    bootstrapGalleryEventHandlersSource,
    /data-open-musicbrainz-artist-problem[\s\S]{0,300}openProblematicFiles\s*\(\s*\)/,
    'activation must carry the occurrence identity rather than opening a generic list',
  );
});

test('the retired inline Artist Family surface is removed while GalleryBar owns the only panel', () => {
  assert.doesNotMatch(indexTemplateSource, /id="related-box"/);
  assert.doesNotMatch(indexTemplateSource, /id="related-list"/);
  assert.doesNotMatch(indexTemplateSource, /id="related-toggle"/);
  assert.match(indexTemplateSource, /id="artist-family-panel"/);
});

test('Combine similar artists sits in its own row directly below the Artist Family header', () => {
  const context = loadRuntime();
  const buildArtistFamilyPanelHtml = requireContract(context, 'buildArtistFamilyPanelHtml');
  const panel = buildArtistFamilyPanelHtml({ title: 'Artist Family', bodyHtml: '<p>Artists</p>' });
  const headerEnd = panel.indexOf('</header>');
  const combineRow = panel.indexOf('artist-family-panel__combine-row');
  const combineSwitch = panel.indexOf('data-toggle-combine-similar-artists="1"');
  const body = panel.indexOf('artist-family-panel__body');

  assert.ok(headerEnd >= 0 && headerEnd < combineRow);
  assert.ok(combineRow <= combineSwitch && combineSwitch < body);
  assert.doesNotMatch(panel.slice(0, headerEnd), /data-toggle-combine-similar-artists/);

  const livePanel = indexTemplateSource.slice(
    indexTemplateSource.indexOf('<aside class="artist-family-panel"'),
    indexTemplateSource.indexOf('<aside class="artist-info-overlay"'),
  );
  const liveHeaderEnd = livePanel.indexOf('</header>');
  const liveCombineRow = livePanel.indexOf('artist-family-panel__combine-row');
  assert.ok(liveHeaderEnd >= 0 && liveHeaderEnd < liveCombineRow);
  assert.doesNotMatch(livePanel.slice(0, liveHeaderEnd), /data-toggle-combine-similar-artists/);
  assert.match(triggerAnchorCssSource, /:is\([^}]*\.artist-family-panel__combine-row \.gallery-switch[^}]*\)\s*\{[^}]*transition:\s*background-color 150ms ease/);
  assert.match(triggerAnchorCssSource, /\.artist-family-panel__combine-row \.gallery-switch, \.ui-filter-pill\):hover[^{}]*\{\s*background: var\(--dropdown-item-hover-background/);
  assert.doesNotMatch(triggerAnchorCssSource, /\.artist-family-panel__combine-row \.gallery-switch:hover[^{}]*\{\s*background: transparent/);
  assert.match(triggerAnchorCssSource, /\.artist-family-panel__combine-row \.gallery-switch:active[^}]*\{[^}]*background:\s*var\(--dropdown-item-hover-background[^}]*border-color:\s*transparent/);
  assert.match(triggerAnchorCssSource, /\.artist-family-panel__combine-row \.gallery-switch:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\),\s*:root \.artist-family-panel__combine-row \.gallery-switch:active/);
  assert.match(triggerAnchorCssSource, /\):hover:not\(:where\(\.gallery-switch\)\):not\(:disabled\):not\(\[aria-disabled="true"\]\)\s*\{\s*background: var\(--dropdown-item-hover-background/);
  assert.match(galleryMainCssSource, /\.gallery-switch, \.gallery-type-choice, \.gallery-menu-action[^}]*background:\s*transparent/);
});

test('Artist Family pills disable native dragging while the primary artist stays separated', () => {
  const state = {
    view: {
      selected_artist: 'Neal Morse',
      primary_artist_groups: [{ artist: 'Neal Morse', albums: [{}] }],
      family_artist_groups: [
        { artist: 'Cosmic Cathedral', albums: [{}] },
        { artist: 'The Neal Morse Band', albums: [{}] },
      ],
    },
    gallery: { mainState: createStateForContract() },
  };
  const context = loadRuntime({ state });
  const buildGalleryFamilyPanelBody = requireContract(context, 'buildGalleryFamilyPanelBody');
  const reorderGalleryFamilyArtists = requireContract(context, 'reorderGalleryFamilyArtists');
  const markup = buildGalleryFamilyPanelBody();

  assert.match(markup, /is-primary[^>]*draggable="false"/);
  assert.match(markup, /data-gallery-family-artist="Cosmic Cathedral"[^>]*draggable="false"/);
  const primaryIndex = markup.indexOf('data-gallery-family-artist="Neal Morse"');
  const dividerIndex = markup.indexOf('artist-family-panel__primary-divider');
  const relatedIndex = markup.indexOf('data-gallery-family-artist="Cosmic Cathedral"');
  assert.ok(primaryIndex >= 0 && primaryIndex < dividerIndex && dividerIndex < relatedIndex);
  assert.match(
    galleryMainCssSource,
    /\.artist-family-panel__primary-divider\s*\{[^}]*width:\s*100%[^}]*margin:/,
  );
  assert.deepEqual(
    plain(reorderGalleryFamilyArtists(['Cosmic Cathedral', 'The Neal Morse Band'], 'The Neal Morse Band', 'Cosmic Cathedral')),
    ['The Neal Morse Band', 'Cosmic Cathedral'],
  );
});

function createStateForContract() {
  return {
    sources: { main_library: true, new_arrivals: true, hoard: true },
    albumTypes: ['studio', 'ep'],
    view: 'cards',
    familyArtists: [],
  };
}

test('artist non-album tracks stay disabled until the family count is known', () => {
  const requested = [];
  const button = { dataset: {}, disabled: true, setAttribute(name, value) { this[name] = value; } };
  const context = loadRuntime({
    state: { view: { selected_artist: 'Agalloch', non_album_tracks_deferred: true } },
    window: {},
    document: {
      querySelectorAll: selector => selector === '[data-open-non-album-tracks]' ? [button] : [],
      querySelector: () => null,
      getElementById: () => null,
    },
    getVisibleNonAlbumTracks: () => [],
    hydrateArtistNonAlbumAvailability: () => { requested.push('availability'); return new Promise(() => {}); },
    hydrateDeferredNonAlbumTracks: options => { requested.push(options); return new Promise(() => {}); },
    hasHydratedArtistNonAlbumAvailability: () => Boolean(context.state.view.non_album_track_count_scope),
  });
  context.ensureGalleryMainState = () => ({ sources: {} });
  context.updateGalleryMainControls();
  assert.deepEqual(requested, ['availability']);
  assert.equal(button.disabled, true);
  assert.equal(button['aria-disabled'], 'true');
  context.state.view.non_album_track_count = 1;
  context.state.view.non_album_track_count_scope = 'artist-family:agalloch';
  context.updateGalleryMainControls();
  assert.equal(button.disabled, false);
  assert.equal(button['aria-disabled'], 'false');
  context.state.view.non_album_track_count = 0;
  context.updateGalleryMainControls();
  assert.equal(button.disabled, true, 'a confirmed empty artist collection is disabled');
  context.state.view = {
    query: 'Release',
    selected_artist: 'Agalloch',
    non_album_tracks: [],
    non_album_tracks_deferred: true,
  };
  context.updateGalleryMainControls();
  assert.equal(button.disabled, false, 'artist-scoped search retains its deferred menu fetch');
  button.dataset.libraryWide = '1';
  context.hasHydratedLibraryNonAlbumTracks = () => false;
  context.updateGalleryMainControls();
  assert.equal(button.disabled, false, 'artist-only hydration cannot disable library-wide browsing');
  context.hasHydratedLibraryNonAlbumTracks = () => true;
  context.updateGalleryMainControls();
  assert.equal(button.disabled, false, 'library-wide Loose Tracks is a navigation destination and stays pressable when empty');
  button.dataset.libraryWide = '';
  context.state.view = { query: 'Bright Eyes', selected_artist: '', non_album_tracks_deferred: true };
  context.hasNonAlbumSearchMatches = () => false;
  context.updateGalleryMainControls();
  assert.equal(requested.at(-1).libraryWide, true, 'search checks library-wide loose tracks without opening the menu');
  assert.equal(button.dataset.searchMatch, 'false');
  context.hasNonAlbumSearchMatches = () => true;
  context.updateGalleryMainControls();
  assert.equal(button.dataset.searchMatch, 'true');
  assert.equal(button['aria-description'], 'Contains tracks matching your search');
});

test('the phone Loose Tracks tab shows the search dot like the desktop button', () => {
  const tab = { dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const context = loadRuntime({
    state: { view: { query: 'Dragonland', selected_artist: '' } },
    window: {},
    document: {
      querySelectorAll: () => [],
      querySelector: selector => (selector === '.mobile-artists-mode-button[data-navigation-mode="collections"]' ? tab : null),
      getElementById: () => null,
    },
    getVisibleNonAlbumTracks: () => [],
  });
  context.ensureGalleryMainState = () => ({ sources: {} });
  context.hasNonAlbumSearchMatches = options => options.libraryWide === true;
  context.updateGalleryMainControls();
  assert.equal(tab.dataset.searchMatch, 'true');
  context.hasNonAlbumSearchMatches = () => false;
  context.updateGalleryMainControls();
  assert.equal(tab.dataset.searchMatch, 'false');
});

test('a search with an artist selected loads that artist\'s loose tracks only once its menu is open', () => {
  const requested = [];
  const menu = { hidden: true };
  const context = loadRuntime({
    state: { view: { query: 'Release', selected_artist: 'Agalloch', non_album_tracks_deferred: true } },
    window: {},
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: id => (id === 'gallery-album-types-menu' ? menu : null),
    },
    hydrateDeferredNonAlbumTracks: options => { requested.push(options.libraryWide); return new Promise(() => {}); },
  });
  const hydrate = requireContract(context, 'hydrateDeferredNonAlbumTracksForAlbumTypes');
  hydrate();
  assert.deepEqual(requested, [true], 'a closed menu keeps the search to its library-wide probe');
  menu.hidden = false;
  hydrate();
  assert.deepEqual(requested, [true, true, false], 'the open menu also resolves the artist\'s own button');
});

test('the live Album types menu starts with unavailable loose tracks disabled', () => {
  assert.match(
    indexTemplateSource,
    /\[\('studio', 'Studio'\), \('ep', 'EP'\), \('live', 'Live'\), \('demo', 'Demo'\), \('compilation', 'Compilation'\), \('single', 'Single'\)\]/,
  );
  assert.match(
    indexTemplateSource,
    /data-gallery-album-type="\{\{ value \}\}"[^>]*aria-pressed="\{\{ 'true' if value in \['studio', 'ep', 'compilation'\] else 'false' \}\}" disabled aria-disabled="true"/,
  );
  assert.match(
    indexTemplateSource,
    /\{% endfor %\}[\s\S]*?<div class="gallery-menu-divider"><\/div>[\s\S]*?data-gallery-featured-on="1"[^>]*aria-pressed="true"[\s\S]*?<div class="gallery-menu-divider"><\/div>[\s\S]*?data-open-non-album-tracks="1"/,
  );
  assert.match(
    indexTemplateSource,
    /data-open-non-album-tracks="1"[^>]*disabled[^>]*aria-disabled="true"/,
  );
  assert.match(
    galleryMainInteractionsSource,
    /const artistFamily = !libraryWide && selectedArtist[\s\S]*?const familyCountReady = artistFamily[\s\S]*?hasHydratedArtistNonAlbumAvailability\(\);[\s\S]*?Number\(state\.view\.non_album_track_count\) > 0/,
  );
  assert.match(
    galleryMainInteractionsSource,
    /typeAnchor[\s\S]*?openGalleryMainSurface\('album-types'[\s\S]*?hydrateDeferredNonAlbumTracksForAlbumTypes\(\)/,
  );
  assert.match(
    galleryMainCssSource,
    /\.gallery-menu-action:is\(:disabled, \[aria-disabled="true"\]\)[^}]*opacity:\s*\.55[^}]*cursor:\s*not-allowed/,
  );
  const context = loadRuntime();
  const hasGalleryNonAlbumTracks = requireContract(context, 'hasGalleryNonAlbumTracks');
  assert.equal(hasGalleryNonAlbumTracks({ non_album_tracks: [] }), false);
  assert.equal(hasGalleryNonAlbumTracks({ non_album_tracks: [{ title: 'Loose' }] }), true);
  assert.equal(hasGalleryNonAlbumTracks({ non_album_tracks: [], non_album_tracks_deferred: true }), false);
});

test('artist info triggers use a larger plain information glyph with neutral envelope styling', () => {
  const context = loadRuntime();
  const buildFamilyArtistHeaderHtml = requireContract(context, 'buildFamilyArtistHeaderHtml');
  const markup = buildFamilyArtistHeaderHtml({ artist: 'Neal Morse', albumCount: 2 });
  assert.match(markup, /gallery-info-button__glyph/);
  assert.doesNotMatch(markup, /ⓘ/);
  assert.match(galleryMainCssSource, /\.artist-info-overlay\s*\{[^}]*background:\s*var\(--panel\);[^}]*color:\s*var\(--text\);/);
  assert.match(galleryMainCssSource, /\.artist-info-overlay__full-page\s*\{[^}]*color:\s*var\(--appearance-accent,/);
  assert.match(galleryMainCssSource, /\.artist-info-overlay__image\s*\{[^}]*background:\s*var\(--panel-2,/);
  assert.match(galleryMainCssSource, /\.gallery-info-button\s*\{[^}]*width:\s*30px[^}]*height:\s*30px[^}]*border-radius:\s*6px/);
  assert.match(galleryMainCssSource, /\.artist-info-overlay::before/);
  assert.match(galleryMainCssSource, /\.artist-family-panel::before/);
});

test('view navigation closes the drawer controller as well as clearing its rendered family', () => {
  const renderRelatedBody = coreStateAndHelpersSource.match(/function renderRelated\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(renderRelatedBody, /galleryMainSurfaceController\?\.isOpen\?\.\('artist-family'\)/);
  assert.match(renderRelatedBody, /closeGalleryMainSurface\(false\)/);
  assert.match(renderRelatedBody, /galleryPanel\.hidden = true/);
});

function familyRefreshRuntime() {
  const classes = new Set();
  const attributes = new Map();
  let focusCount = 0;
  const trigger = { hidden: false, setAttribute(name, value) { attributes.set(name, value); },
    focus() { focusCount += 1; } };
  const panel = { hidden: true, matches: () => false, setAttribute() {},
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  const body = { innerHTML: '<button>Northlight</button>', dataset: { galleryRenderSignature: 'retained' } };
  const state = { view: { selected_artist: 'Northlight', query: 'Northlight', gallery_scope: 'all' }, ui: {} };
  const context = loadRuntime({ state, window: {}, document: {
    getElementById: () => null,
    querySelector: selector => ({
      '[data-artist-family-panel]': panel,
      '[data-gallery-bar-action="artist-family"]': trigger,
      '[data-gallery-family-panel-body]': body,
    })[selector] || null,
  } });
  context.focusGalleryMainSurface = () => {};
  vm.runInContext(coreStateAndHelpersSource.match(/function renderRelated\(\) \{[\s\S]*?\n\}/)[0], context);
  context.openGalleryMainSurface('artist-family', trigger, panel);
  return { context, state, panel, body, attributes, classes, focusCount: () => focusCount };
}

test('same-artist hydration preserves the open Family panel, its contents and focus', () => {
  const run = familyRefreshRuntime();
  run.state.view = { ...run.state.view, album_count: 4, related_artists: ['Northlight', 'Northlight Ensemble'] };
  run.context.renderRelated();
  assert.equal(run.panel.hidden, false);
  assert.equal(run.classes.has('is-open'), true);
  assert.equal(run.attributes.get('aria-expanded'), 'true');
  assert.equal(run.body.innerHTML, '<button>Northlight</button>');
  assert.equal(run.body.dataset.galleryRenderSignature, 'retained');
  assert.equal(run.focusCount(), 0);
  assert.equal(vm.runInContext('galleryMainSurfaceController.isOpen("artist-family")', run.context), true);
});

for (const change of [
  { selected_artist: 'Another Artist' }, { selected_artist: '' },
  { query: 'Other search' }, { gallery_scope: 'new_arrivals' },
]) {
  test(`Family panel closes on changed browse context ${JSON.stringify(change)}`, () => {
    const run = familyRefreshRuntime();
    Object.assign(run.state.view, change);
    run.context.renderRelated();
    assert.equal(run.panel.hidden, true);
    assert.equal(run.attributes.get('aria-expanded'), 'false');
    assert.equal(run.body.innerHTML, '');
    assert.equal(vm.runInContext('galleryMainSurfaceController.isOpen("artist-family")', run.context), false);
  });
}

test('pending artist navigation dismisses Family before the next payload arrives', () => {
  const run = familyRefreshRuntime();
  run.state.ui.pendingSidebarSelectedArtist = 'Another Artist';
  run.context.renderRelated();
  assert.equal(run.panel.hidden, true);
  assert.equal(run.body.innerHTML, '');
});

test('the collapsed Gallery view control hides the inactive icon instead of overlapping it', () => {
  const css = fs.readFileSync(path.join(runtimeRoot, '..', '..', 'css', 'unfolding-action-button.css'), 'utf8');
  for (const rule of ['flex: 0 0 0px', 'min-width: 0', 'overflow: hidden', 'visibility: hidden', 'pointer-events: none', 'outline: none !important', 'prefers-reduced-motion']) assert.ok(css.includes(rule));
 assert.doesNotMatch(css, /:is\(:hover, :focus-within\)[^{]*\{[^}]*outline:/);
 assert.doesNotMatch(css, /\.unfolding-action-button:focus-within\s*\{[^}]*outline:/);
 assert.match(css, /> \.unfolding-action-button__action:is\(:hover, :focus-visible\)\s*\{[^}]*color:\s*color-mix\(in srgb,[^}]*var\(--appearance-play, #4ade80\) 70%/s);
  assert.doesNotMatch(css, /border-left:/);
});

test('client Gallery state defaults to all sources, Studio plus EP and Compilation, cards, and an unfiltered gallery', () => {
  const context = loadRuntime();
 const createGalleryMainState = requireContract(context, 'createGalleryMainState');
 assert.deepEqual(
  plain(vm.runInContext('GALLERY_RELEASE_TYPES', context)),
  ['studio', 'ep', 'live', 'demo', 'compilation', 'single'],
 );
 assert.deepEqual(plain(createGalleryMainState()), {
    sources: { main_library: true, new_arrivals: true, hoard: true },
    albumTypes: ['studio', 'ep', 'compilation'],
    showFeaturedOn: true,
    splitAlbums: 'show',
    view: 'cards',
    familyArtists: [],
  });
});

test('explicit release-type choices remain intact instead of acquiring default compilations', () => {
  const context = loadRuntime();
  const createGalleryMainState = requireContract(context, 'createGalleryMainState');
  for (const albumTypes of [[], ['studio', 'ep'], ['compilation']]) {
    const created = createGalleryMainState({ albumTypes });
    assert.deepEqual(plain(created.albumTypes), albumTypes);
    assert.notEqual(created.albumTypes, albumTypes);
  }
});

test('new primary artist navigation resets filters while preserving the display preference', () => {
  const context = loadRuntime();
  const resetGalleryMainStateForPrimaryArtist = requireContract(context, 'resetGalleryMainStateForPrimaryArtist');
  const reset = resetGalleryMainStateForPrimaryArtist({
    sources: { main_library: false, new_arrivals: true, hoard: false },
    albumTypes: ['compilation'],
    view: 'covers',
    familyArtists: ['Neal Morse'],
    familySelectionExplicit: true,
  });

  assert.deepEqual(plain(reset), {
    sources: { main_library: true, new_arrivals: true, hoard: true },
    albumTypes: ['studio', 'ep', 'compilation'],
    showFeaturedOn: true,
    splitAlbums: 'show',
    view: 'covers',
    familyArtists: [],
  });
});

test('source, featured relationship, unavailable type, view, and family transitions retain durable values', () => {
  const context = loadRuntime();
  const createGalleryMainState = requireContract(context, 'createGalleryMainState');
  const reduceGalleryMainState = requireContract(context, 'reduceGalleryMainState');
  let state = createGalleryMainState();
  state = reduceGalleryMainState(state, { type: 'toggle-source', source: 'hoard' });
  state = reduceGalleryMainState(state, { type: 'toggle-featured-on' });
  state = reduceGalleryMainState(state, { type: 'toggle-album-type', albumType: 'compilation' });
  state = reduceGalleryMainState(state, { type: 'set-view', view: 'covers' });
  state = reduceGalleryMainState(state, { type: 'toggle-family-artist', artist: 'Flying Colors' });
  assert.deepEqual(plain(state), {
    sources: { main_library: true, new_arrivals: true, hoard: false },
    albumTypes: ['studio', 'ep', 'compilation'],
    showFeaturedOn: false,
    splitAlbums: 'show',
    view: 'covers',
    familyArtists: ['Flying Colors'],
  });
  assert.equal(reduceGalleryMainState(state, { type: 'set-view', view: 'No info' }).view, 'covers');
  assert.equal(reduceGalleryMainState(state, { type: 'set-view', view: 'Cards' }).view, 'cards');
});

test('Featured On is a relationship facet conjunctive with source and release filtering', () => {
  const context = loadRuntime();
  const createGalleryMainState = requireContract(context, 'createGalleryMainState');
  const reduceGalleryMainState = requireContract(context, 'reduceGalleryMainState');
  const filterGalleryModel = requireContract(context, 'filterGalleryModel');
  const groups = [{
    artist: 'Guest Artist',
    albums: [
      { key: 'owned-main-studio', artist_relationship: 'owned', release_type: 'studio', source: 'main_library' },
      { key: 'featured-main-studio', artist_relationship: 'featured', release_type: 'studio', source: 'main_library' },
      { key: 'featured-hoard-studio', artist_relationship: 'featured', release_type: 'studio', source: 'hoard' },
      { key: 'featured-main-compilation', artist_relationship: 'featured', release_type: 'compilation', source: 'main_library', is_compilation: true },
    ],
  }];

  let filterState = createGalleryMainState({
    sources: { main_library: true, new_arrivals: false, hoard: false },
    albumTypes: ['studio'],
  });
  assert.deepEqual(
    plain(filterGalleryModel({ groups, filterState })).groups[0].albums.map(album => album.key),
    ['owned-main-studio', 'featured-main-studio'],
  );

  filterState = reduceGalleryMainState(filterState, { type: 'toggle-featured-on' });
  assert.deepEqual(plain(filterGalleryModel({ groups, filterState })), {
    groups: [{ artist: 'Guest Artist', albums: [groups[0].albums[0]] }],
    totals: { artistCount: 1, albumCount: 1 },
  });
});

test('relationship controls synchronize and dispatch without enabling release-type controls', () => {
  const featuredAttributes = new Map();
  const featured = {
    dataset: { galleryFeaturedOn: '1' },
    setAttribute(name, value) { featuredAttributes.set(name, value); },
  };
  const splitAttributes = new Map();
  const split = {
    dataset: { gallerySplitAlbums: '1' },
    setAttribute(name, value) { splitAttributes.set(name, value); },
  };
  const releaseType = {
    dataset: { galleryAlbumType: 'studio' },
    setAttribute() {},
    disabled: false,
  };
  const state = { gallery: { mainState: {
    sources: { main_library: true, new_arrivals: true, hoard: true },
    albumTypes: ['studio', 'ep'],
    showFeaturedOn: false,
    splitAlbums: 'show',
    view: 'cards',
    familyArtists: [],
  } }, view: {} };
  const actions = [];
  const context = loadRuntime({
    state,
    window: { innerWidth: 1440 },
    document: {
      querySelector: () => null,
      querySelectorAll: selector => ({
        '[data-gallery-featured-on]': [featured],
        '[data-gallery-split-albums]': [split],
        '[data-gallery-album-type]': [releaseType],
      })[selector] || [],
    },
  });
  context.updateGalleryMainControls();
  assert.equal(featuredAttributes.get('aria-pressed'), 'false');
  assert.equal(splitAttributes.get('aria-valuenow'), '2');
  assert.equal(splitAttributes.get('aria-valuetext'), 'Show Split Albums');
  assert.equal(featured.disabled, false);
  assert.equal(releaseType.disabled, true);

  context.transitionGalleryMain = action => actions.push(action);
  const prevented = [];
  context.handleGalleryMainClick({
    preventDefault: () => prevented.push(true),
    target: { closest: selector => selector === '[data-gallery-featured-on]' ? featured : null },
  });
  assert.deepEqual(plain(actions), [{ type: 'toggle-featured-on' }]);
  assert.equal(prevented.length, 1);

  context.handleGalleryMainClick({
    preventDefault: () => prevented.push(true),
    detail: 1,
    clientX: 0,
    target: { closest: selector => selector === '[data-gallery-split-albums]' ? split : null },
  });
  assert.deepEqual(plain(actions), [
    { type: 'toggle-featured-on' },
    { type: 'set-split-albums', mode: 'separate' },
  ]);
  assert.equal(prevented.length, 2);
});

test('all-artists Non-album tracks opens the reloadable library-wide page', () => {
  const context = loadRuntime({
    state: { view: { selected_artist: '' }, ui: {} },
    window: { innerWidth: 1440 },
    document: { getElementById: () => null },
  });
  const button = {
    dataset: {},
    disabled: false,
    getAttribute: () => 'false',
  };
  let opened;
  context.openNonAlbumModal = options => { opened = options; };

  context.handleGalleryMainClick({
    preventDefault() {},
    target: {
      closest: selector => selector === '[data-open-non-album-tracks]' ? button : null,
    },
  });

  assert.deepEqual(plain(opened), { libraryWide: true });
});

test('the first Artist Family click deselects that artist from the default all-selected state', () => {
  const context = loadRuntime();
  const createGalleryMainState = requireContract(context, 'createGalleryMainState');
  const reduceGalleryMainState = requireContract(context, 'reduceGalleryMainState');
  const filterGalleryModel = requireContract(context, 'filterGalleryModel');
  const availableArtists = ['Neal Morse', 'Morse Portnoy George', 'Cosmic Cathedral'];

  let state = reduceGalleryMainState(createGalleryMainState(), {
    type: 'toggle-family-artist',
    artist: 'Morse Portnoy George',
    availableArtists,
  });
  assert.deepEqual(plain(state.familyArtists), ['Neal Morse', 'Cosmic Cathedral']);
  assert.equal(state.familySelectionExplicit, true);

  state = reduceGalleryMainState(state, {
    type: 'toggle-family-artist', artist: 'Neal Morse', availableArtists,
  });
  state = reduceGalleryMainState(state, {
    type: 'toggle-family-artist', artist: 'Cosmic Cathedral', availableArtists,
  });
  assert.deepEqual(plain(state.familyArtists), []);
  assert.equal(state.familySelectionExplicit, true);

  const filtered = filterGalleryModel({
    groups: availableArtists.map((artist) => ({ artist, albums: [{ key: artist }] })),
    filterState: state,
  });
  assert.deepEqual(plain(filtered.groups), []);
});

test('Artist Family panel counts remain based on the full family selection', () => {
  const state = {
    view: {
      selected_artist: 'Neal Morse',
      primary_artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'one' }, { key: 'two' }] }],
      family_artist_groups: [{ artist: 'Cosmic Cathedral', albums: [{ key: 'deep-water' }] }],
    },
    gallery: {
      mainState: {
        sources: { main_library: true, new_arrivals: true, hoard: true },
        albumTypes: ['studio', 'ep'],
        view: 'cards',
        familyArtists: [],
        familySelectionExplicit: true,
      },
    },
  };
  const context = loadRuntime({ state });
  const getGalleryFamilyPanelModel = requireContract(context, 'getGalleryFamilyPanelModel');

  const model = plain(getGalleryFamilyPanelModel());

  assert.equal(model.totals.artistCount, 2);
  assert.equal(model.totals.albumCount, 3);
  assert.deepEqual(model.groups.map((group) => group.artist), ['Neal Morse', 'Cosmic Cathedral']);
});

test('Artist Family counts follow Sources but ignore Album type filtering', () => {
  const state = {
    view: {
      selected_artist: 'Neal Morse',
      primary_artist_groups: [{
        artist: 'Neal Morse',
        albums: [
          { key: 'studio-main', release_type: 'studio', source: 'main_library' },
          { key: 'comp-main', release_type: 'compilation', source: 'main_library' },
          { key: 'studio-hoard', release_type: 'studio', source: 'hoard' },
        ],
      }],
      family_artist_groups: [],
    },
    gallery: {
      mainState: {
        sources: { main_library: true, new_arrivals: false, hoard: false },
        albumTypes: ['studio'],
        view: 'cards',
        familyArtists: [],
      },
    },
  };
  const context = loadRuntime({ state });
  const getFilteredGalleryMainModel = requireContract(context, 'getFilteredGalleryMainModel');
  const getGalleryFamilyPanelModel = requireContract(context, 'getGalleryFamilyPanelModel');

  assert.equal(getFilteredGalleryMainModel().totals.albumCount, 1);
  assert.equal(getGalleryFamilyPanelModel().totals.albumCount, 2);

  state.gallery.mainState.albumTypes = ['compilation'];
  assert.equal(getFilteredGalleryMainModel().totals.albumCount, 1);
  assert.equal(getGalleryFamilyPanelModel().totals.albumCount, 2);

  state.gallery.mainState.sources = { main_library: false, new_arrivals: false, hoard: true };
  assert.equal(getGalleryFamilyPanelModel().totals.albumCount, 1);
});

test('Artist Family panel loads the complete known family even when the current gallery contains only Devin', () => {
  const state = {
    view: {
      selected_artist: 'Devin Townsend',
      related_artists: [
        'Casualties of Cool',
        'IR8',
        'Strapping Young Lad',
        'The Devin Townsend Band',
        'The Devin Townsend Project',
      ],
      primary_artist_groups: [{ artist: 'Devin Townsend', albums: [{ key: 'ocean-machine' }] }],
      family_artist_groups: [],
    },
    gallery: {
      mainState: {
        sources: { main_library: true, new_arrivals: true, hoard: true },
        albumTypes: ['studio', 'ep'],
        view: 'cards',
        familyArtists: [],
      },
    },
  };
  const context = loadRuntime({
    state,
    getRelatedFilterCacheState: () => ({
      relatedFilterBaseArtist: 'Devin Townsend',
      relatedFilterBaseQuery: '',
      relatedFilterBasePrimaryGroups: [{ artist: 'Devin Townsend', albums: [{ key: 'ocean-machine' }] }],
      relatedFilterBaseFamilyGroups: [
        { artist: 'Casualties of Cool', albums: [{ key: 'casualties' }] },
        { artist: 'IR8', albums: [{ key: 'ir8' }] },
        { artist: 'Strapping Young Lad', albums: [{ key: 'city' }] },
        { artist: 'The Devin Townsend Band', albums: [{ key: 'accelerated' }] },
        { artist: 'The Devin Townsend Project', albums: [{ key: 'ki' }] },
      ],
    }),
  });
  const getGalleryFamilyPanelGroups = requireContract(context, 'getGalleryFamilyPanelGroups');
  const buildGalleryFamilyPanelBody = requireContract(context, 'buildGalleryFamilyPanelBody');

  assert.deepEqual(
    plain(getGalleryFamilyPanelGroups()).map((group) => group.artist),
    [
      'Devin Townsend',
      'Casualties of Cool',
      'IR8',
      'Strapping Young Lad',
      'The Devin Townsend Band',
      'The Devin Townsend Project',
    ],
  );
  const markup = buildGalleryFamilyPanelBody();
  assert.match(markup, /data-gallery-family-artist="Casualties of Cool"/);
  assert.match(markup, /data-gallery-family-artist="IR8"/);
  assert.match(markup, /data-gallery-family-artist="The Devin Townsend Project"/);
});

test('Artist Family resolves an IR8 member identity to its visible split-release group', () => {
  const splitGroup = {
    artist: 'IR8 / Sexoturica',
    artist_display: 'IR8 / Sexoturica',
    variation_names: ['IR8', 'IR8 / Sexoturica'],
    albums: [{ key: 'split-release', name: 'IR8 vs Sexoturica' }],
  };
  const state = {
    view: {
      selected_artist: 'Devin Townsend',
      related_artists: ['IR8'],
      primary_artist_groups: [{ artist: 'Devin Townsend', albums: [{ key: 'ocean-machine' }] }],
      family_artist_groups: [
        { artist: 'IR8', artist_display: 'IR8', albums: [] },
        splitGroup,
      ],
    },
    gallery: {
      mainState: {
        sources: { main_library: true, new_arrivals: true, hoard: true },
        albumTypes: ['studio', 'ep'],
        view: 'cards',
        familyArtists: [],
      },
    },
  };
  const context = loadRuntime({
    state,
    groupMatchesRelatedArtists: (group, artists) => (
      (group.variation_names || []).some((name) => artists.has(name))
    ),
  });
  const getGalleryFamilyPanelGroups = requireContract(context, 'getGalleryFamilyPanelGroups');
  const buildGalleryFamilyPanelBody = requireContract(context, 'buildGalleryFamilyPanelBody');

  const groups = plain(getGalleryFamilyPanelGroups());
  assert.deepEqual(groups.map((group) => group.artist), ['Devin Townsend', 'IR8 / Sexoturica']);
  assert.equal(groups[1].albums[0].name, 'IR8 vs Sexoturica');
  const markup = buildGalleryFamilyPanelBody();
  assert.match(markup, /data-gallery-family-artist="IR8 \/ Sexoturica"/);
  assert.doesNotMatch(markup, /data-gallery-family-artist="IR8"/);
});

test('Artist Family prefers nonempty exact groups over broad album-credit alias matches', () => {
  const state = {
    view: {
      selected_artist: 'Control Signal Lead',
      related_artists: [
        'Control Signal Lead / Control Signal Partner',
        'Control Signal Partner',
      ],
      primary_artist_groups: [{
        artist: 'Control Signal Lead',
        albums: [{
          key: 'compilation-credit',
          artists: [
            'Control Signal Lead',
            'Control Signal Lead / Control Signal Partner',
            'Control Signal Partner',
          ],
        }, { key: 'lead-solo' }],
      }],
      family_artist_groups: [{
        artist: 'Control Signal Partner',
        albums: [{ key: 'partner-solo' }],
      }, {
        artist: 'Control Signal Lead / Control Signal Partner',
        albums: [{ key: 'shared-release' }],
      }],
    },
    gallery: {
      mainState: {
        sources: { main_library: true, new_arrivals: true, hoard: true },
        albumTypes: ['studio', 'ep'],
        view: 'cards',
        familyArtists: [],
      },
    },
  };
  const context = loadRuntime({
    state,
    groupMatchesRelatedArtists: (group, artists) => (
      (group.albums || []).some((album) => (
        (album.artists || []).some((artist) => artists.has(artist))
      ))
    ),
  });
  const getGalleryFamilyPanelGroups = requireContract(context, 'getGalleryFamilyPanelGroups');

  assert.deepEqual(
    plain(getGalleryFamilyPanelGroups()).map((group) => group.artist),
    [
      'Control Signal Lead',
      'Control Signal Lead / Control Signal Partner',
      'Control Signal Partner',
    ],
  );
});

test('GalleryBar scroll context uses absolute virtual section coordinates instead of mounted DOM offsets', () => {
  const context = loadRuntime({
    document: { getElementById: () => null },
    virtualGrid: {
      sections: [
        { top: 1200, group: { artist: 'Neal Morse & The Resonance', albums: [{}, {}] } },
        { top: 2200, group: { artist: 'Cosmic Cathedral', albums: [{}] } },
      ],
    },
  });
  const getGalleryMainContextSections = requireContract(context, 'getGalleryMainContextSections');
  assert.deepEqual(plain(getGalleryMainContextSections()), [
    { artist: 'Neal Morse & The Resonance', albumCount: 2, artist_musicbrainz: null, top: 1200, labelBottom: 1200 },
    { artist: 'Cosmic Cathedral', albumCount: 1, artist_musicbrainz: null, top: 2200, labelBottom: 2200 },
  ]);
});

test('family panel heading uses the selected primary artist with an adjacent count', () => {
  const title = {}, total = {}, name = {}, summary = {};
  const info = { dataset: {}, setAttribute() {}, remove() {} };
  const bar = { offsetHeight: 54, querySelector: selector => selector === '[data-gallery-context-name]' ? name : selector === '[data-gallery-context-summary]' ? summary : info };
  const context = loadRuntime({ state: { gallery: {}, view: {
    selected_artist: 'Neal Morse',
    primary_artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'one', source: 'main_library' }] }],
    family_artist_groups: [{ artist: 'Cosmic Cathedral', albums: [{ key: 'two', source: 'main_library' }] }],
  } }, document: {
    querySelectorAll: () => [],
    querySelector: selector => ({ '[data-gallery-bar-instance="gallery"]': bar, '[data-gallery-family-panel-title]': title, '[data-gallery-family-panel-total]': total })[selector] || null,
    getElementById: id => id === 'albums-scroll' ? { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) } : null,
  } });
  context.updateGalleryMainControls = () => {};
  context.updateGalleryMainChrome();
  assert.equal(title.textContent, 'Neal Morse Family');
  assert.equal(title.title, title.textContent);
  assert.equal(total.textContent, '2 albums');
  const markup = context.buildArtistFamilyPanelHtml({ title: title.textContent, albumTotal: total.textContent });
  assert.match(markup, /<h2[^>]*>Neal Morse Family<\/h2><span aria-hidden="true">•<\/span><span data-gallery-family-panel-total>2 albums<\/span>/);
  assert.match(indexTemplateSource, /data-gallery-family-panel-title>Artist Family<\/h2><span aria-hidden="true">•<\/span><span data-gallery-family-panel-total>/);
});

test('Artist Family panel uses fixed-width reusable filter pills with optional artwork', () => {
  const state = {
    view: {
      selected_artist: 'Neal Morse',
      primary_artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'one', cover_url: '/cover?path=neal' }] }],
      family_artist_groups: [{ artist: 'Cosmic Cathedral', albums: [{ key: 'deep-water', cover_url: '/cover?path=cosmic' }] }],
    },
    gallery: {
      mainState: {
        sources: { main_library: true, new_arrivals: true, hoard: true },
        albumTypes: ['studio', 'ep'],
        view: 'cards',
        familyArtists: [],
      },
    },
  };
  const context = loadRuntime({ state });
  const buildGalleryFamilyPanelBody = requireContract(context, 'buildGalleryFamilyPanelBody');
  const buildFilterPillHtml = requireContract(context, 'buildFilterPillHtml');

  const markup = buildGalleryFamilyPanelBody();
  const textOnlyPill = buildFilterPillHtml({ label: 'Text only', count: 3 });

  assert.match(markup, /class="ui-filter-pill artist-family-panel__artist is-active is-primary"[^>]*data-gallery-family-artist="Neal Morse"/);
  assert.match(markup, /class="ui-filter-pill artist-family-panel__artist is-active"[^>]*data-gallery-family-artist="Cosmic Cathedral"/);
  assert.match(markup, /title="Cosmic Cathedral"/);
  assert.match(galleryMainCssSource, /\.artist-family-panel\s*\{[^}]*width:\s*min\(390px, 92vw\)/);
  assert.doesNotMatch(galleryMainCssSource, /\.artist-family-panel\s*\{[^}]*width:\s*max-content/);
  assert.match(markup, /ui-filter-pill__artwork artist-family-panel__artwork/);
  assert.match(markup, /data-gallery-cover-src="\/cover\?path=neal"/);
  assert.match(markup, /data-production-cover-src="\/cover\?path=cosmic"/);
  assert.doesNotMatch(markup, /<img[^>]+\ssrc=/);
  assert.match(markup, /ui-filter-pill__marker artist-family-panel__marker/);
  assert.match(markup, /ui-filter-pill__count artist-family-panel__count/);
  assert.match(galleryMainCssSource, /\.artist-family-panel__artist\.is-active\s*\{[^}]*border-color:\s*var\(--appearance-play,\s*#4bc173\)/);
  assert.match(galleryMainCssSource, /\.artist-family-panel__marker\s*\{[^}]*background:\s*var\(--appearance-play,\s*#4bc173\)/);
  assert.match(galleryMainCssSource, /\.artist-family-panel__count\s*\{[^}]*color:\s*var\(--appearance-ink[^}]*background:\s*color-mix\(in srgb, var\(--appearance-control/);
  assert.match(galleryMainCssSource, /:root \.artist-family-panel__artist\s*\{[^}]*background:\s*var\(--family-row-background,\s*var\(--panel,\s*#111517\)\)/);
  assert.doesNotMatch(galleryMainCssSource, /--family-row-selected/);
  assert.match(textOnlyPill, /class="ui-filter-pill"/);
  assert.match(textOnlyPill, /ui-filter-pill__label/);
  assert.doesNotMatch(textOnlyPill, /ui-filter-pill__artwork/);
  assert.match(galleryMainCssSource, /\.artist-family-panel__name\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.doesNotMatch(galleryMainCssSource, /\.artist-family-panel__artist:is\(:hover, :focus-visible\) \.artist-family-panel__name\s*\{[^}]*text-decoration:\s*underline/);
  assert.match(triggerAnchorCssSource, /:is\([^}]*\.ui-filter-pill[^}]*\)\s*\{[^}]*transition:\s*background-color 150ms ease/);
  assert.match(triggerAnchorCssSource, /:is\([^}]*\.ui-filter-pill[^}]*\):hover[^}]*\{[^}]*background:\s*var\(--dropdown-item-hover-background/);
  assert.doesNotMatch(galleryMainCssSource, /\.artist-family-panel__artist\.is-primary\s*\{/);
  assert.match(galleryMainCssSource, /height: 60px/);
  assert.doesNotMatch(galleryMainCssSource, /\.artist-family-panel__artist\s*\{[^}]*background:\s*[^;{}]*!important/);
});

test('Artist Family panel sends deferred artwork through the shared gallery cover loader', () => {
  const activated = [];
  const panelBody = {
    contains: () => false,
    innerHTML: '',
    querySelectorAll: () => [],
    scrollTop: 12,
  };
  const context = loadRuntime({
    document: { activeElement: null },
    virtualGrid: { activateGalleryCoverImages: root => activated.push(root) },
  });

  context.renderGalleryFamilyPanelBody(panelBody, '<button>Family</button>');

  assert.equal(panelBody.innerHTML, '<button>Family</button>');
  assert.deepEqual(activated, [panelBody]);
  assert.equal(panelBody.scrollTop, 12);
});

test('all unavailable release types remain inert while catalog-backed facts are classified', () => {
  const context = loadRuntime();
  const classifyGalleryReleaseType = requireContract(context, 'classifyGalleryReleaseType');
  const createGalleryMainState = requireContract(context, 'createGalleryMainState');
  const reduceGalleryMainState = requireContract(context, 'reduceGalleryMainState');
  const filterGalleryModel = requireContract(context, 'filterGalleryModel');
  assert.equal(classifyGalleryReleaseType({ release_type: 'studio' }), 'studio');
  assert.equal(classifyGalleryReleaseType({ release_type: 'album', is_compilation: true }), 'compilation');
  assert.equal(classifyGalleryReleaseType({ release_type: 'ep', title: 'Definitely Live' }), 'studio');
  assert.equal(classifyGalleryReleaseType({ title: 'World Tour (Live)' }), 'studio');
  assert.equal(classifyGalleryReleaseType({ title: 'Early Demos' }), 'studio');
  assert.equal(classifyGalleryReleaseType({ title: 'Collected Works: Compilation' }), 'studio');
  assert.equal(classifyGalleryReleaseType({ title: 'Radio Single' }), 'studio');
  assert.equal(classifyGalleryReleaseType({ title: 'Ordinary Record' }), 'studio');

  assert.deepEqual(plain(createGalleryMainState().albumTypes), ['studio', 'ep', 'compilation']);
  assert.equal(createGalleryMainState().splitAlbums, 'show');
  for (const mode of ['hide', 'separate', 'show']) {
    assert.equal(reduceGalleryMainState(createGalleryMainState(), { type: 'set-split-albums', mode }).splitAlbums, mode);
  }
  assert.equal(reduceGalleryMainState(createGalleryMainState(), { type: 'set-split-albums', mode: 'bogus' }).splitAlbums, 'show');
  for (const albumType of ['studio', 'live', 'demo', 'compilation', 'ep', 'single']) {
    const state = createGalleryMainState();
    assert.deepEqual(
      plain(reduceGalleryMainState(state, { type: 'toggle-album-type', albumType })),
      plain(state),
    );
  }

  const filtered = plain(filterGalleryModel({
    groups: [
      {
        key: 'primary', artist: 'Neal Morse', albums: [
          { key: 'studio', release_type: 'studio', source: 'main_library' },
          { key: 'ep', release_type: 'ep', source: 'new_arrivals' },
          { key: 'live', release_type: 'live', source: 'main_library' },
        ],
      },
      { key: 'family', artist: 'Flying Colors', albums: [{ key: 'single', release_type: 'single', source: 'hoard' }] },
    ],
    filterState: {
      sources: { main_library: true, new_arrivals: true, hoard: true },
      albumTypes: ['studio', 'ep', 'compilation'],
      view: 'cards',
      familyArtists: [],
    },
  }));
  assert.deepEqual(filtered.groups.map((group) => ({ key: group.key, albums: group.albums.map((album) => album.key) })), [
    { key: 'primary', albums: ['studio', 'ep', 'live'] },
    { key: 'family', albums: ['single'] },
  ]);
  assert.deepEqual(filtered.totals, { artistCount: 2, albumCount: 4 });

  const withoutSplits = plain(filterGalleryModel({
    groups: [{
      artist: 'Jordsjø',
      albums: [
        { key: 'split', release_type: 'Split', source: 'main_library' },
        { key: 'studio', release_type: 'Album', source: 'main_library' },
      ],
    }],
    filterState: { ...createGalleryMainState(), splitAlbums: 'hide' },
  }));
  assert.deepEqual(withoutSplits.groups[0].albums.map((album) => album.key), ['studio']);
  for (const splitAlbums of ['show', 'separate']) {
    const withSplits = plain(filterGalleryModel({
      groups: [{ artist: 'Jordsjø', albums: [{ key: 'split', release_type: 'Split', source: 'main_library' }] }],
      filterState: { ...createGalleryMainState(), splitAlbums },
    }));
    assert.deepEqual(withSplits.groups[0].albums.map((album) => album.key), ['split'], splitAlbums);
  }
});

test('art-only Gallery hover frame covers the complete card edge', () => {
  assert.match(
    galleryMainCssSource,
    /\.album-card\[data-gallery-release-year\]\[data-gallery-display="covers"\]::after\s*\{[^}]*inset:\s*-1px;[^}]*border:\s*5px solid transparent;[^}]*border-radius:\s*14px;[^}]*clip-path:/s,
  );
  assert.match(
    galleryMainCssSource,
    /\.album-card\[data-gallery-release-year\]\[data-gallery-display="covers"\]:is\(:hover, :focus-within\)::after\s*\{[^}]*border-color:\s*var\(--gallery-artbox-hover-frame,[^}]*opacity:\s*1;/s,
  );
  assert.doesNotMatch(galleryMainCssSource, /\.gallery-card__year-frame\s*\{/);
});

test('default Gallery filters retain compilation metadata while type controls are unavailable', () => {
  const context = loadRuntime();
  const createGalleryMainState = requireContract(context, 'createGalleryMainState');
  const filterGalleryModel = requireContract(context, 'filterGalleryModel');
  const filtered = plain(filterGalleryModel({
    groups: [{
      artist: 'IR8 / Sexoturica',
      albums: [{
        key: 'ir8 / sexoturica::ir8 vs sexoturica',
        name: 'IR8 vs Sexoturica',
        is_compilation: true,
        source: 'main_library',
      }],
    }],
    filterState: createGalleryMainState(),
  }));

  assert.equal(filtered.groups.length, 1);
  assert.equal(filtered.groups[0].artist, 'IR8 / Sexoturica');
  assert.deepEqual(filtered.groups[0].albums.map((album) => album.key), ['ir8 / sexoturica::ir8 vs sexoturica']);
  assert.deepEqual(filtered.totals, { artistCount: 1, albumCount: 1 });
});

test('targeted reconciliation updates affected groups and counts without loader, menu, scroll, or root replacement', () => {
  const calls = [];
  const galleryRoot = { id: 'gallery-root' };
  const activeSurface = { id: 'album-types-menu' };
  const scrollContainer = { scrollTop: 640 };
  const context = loadRuntime();
  const reconcileGalleryMain = requireContract(context, 'reconcileGalleryMain');
  const result = reconcileGalleryMain({
    galleryRoot,
    activeSurface,
    scrollContainer,
    changedGroupKeys: ['artist:flying-colors'],
    nextGroups: [{ key: 'artist:flying-colors', albumCount: 2 }],
    totals: { artistCount: 2, albumCount: 8 },
    replaceGroup: (key) => calls.push(['replaceGroup', key]),
    updateCounts: (totals) => calls.push(['updateCounts', totals]),
    showCentralLoader: () => calls.push(['showCentralLoader']),
    closeSurface: () => calls.push(['closeSurface']),
    replaceGalleryRoot: () => calls.push(['replaceGalleryRoot']),
  });
  assert.deepEqual(calls, [
    ['replaceGroup', 'artist:flying-colors'],
    ['updateCounts', { artistCount: 2, albumCount: 8 }],
  ]);
  assert.equal(scrollContainer.scrollTop, 640);
  assert.equal(result.galleryRoot, galleryRoot);
  assert.equal(result.activeSurface, activeSurface);
});

test('scroll context distinguishes the gallery root, a selected family, and the current artist', () => {
  const context = loadRuntime();
  const resolveGalleryBarContext = requireContract(context, 'resolveGalleryBarContext');
  const groups = [
    { artist: 'Neal Morse', albumCount: 6, top: 80 },
    { artist: 'Transatlantic', albumCount: 4, top: 700 },
  ];
  assert.deepEqual(plain(resolveGalleryBarContext({ scrollTop: 0, artistCount: 1985, albumCount: 6057, groups })), {
    kind: 'gallery', artistCount: 1985, albumCount: 6057,
  });
  assert.deepEqual(plain(resolveGalleryBarContext({ scrollTop: 0, primaryArtist: 'Neal Morse', artistCount: 2, albumCount: 10, groups })), {
    kind: 'family', primaryArtist: 'Neal Morse', artistCount: 2, albumCount: 10,
  });
  assert.deepEqual(plain(resolveGalleryBarContext({ scrollTop: 0, primaryArtist: 'Alestorm', hasFamily: false, artistCount: 1, albumCount: 4, groups })), {
    kind: 'single-artist', artist: 'Alestorm', albumCount: 4,
  });
  assert.deepEqual(plain(resolveGalleryBarContext({ scrollTop: 760, galleryBarBottom: 120, primaryArtist: 'Neal Morse', artistCount: 2, albumCount: 10, groups })), {
    kind: 'artist', artist: 'Transatlantic', albumCount: 4,
  });
});

test('anchored surfaces toggle, dismiss, and return focus while switch activation stays open', () => {
  const context = loadRuntime();
  const createAnchoredSurfaceController = requireContract(context, 'createAnchoredSurfaceController');
  const anchor = { focusCalls: 0, focus() { this.focusCalls += 1; } };
  const surface = { contains: (target) => target === 'inside' };
  const controller = createAnchoredSurfaceController();
  assert.equal(controller.activate({ key: 'sources', anchor, surface }), 'opened');
  assert.equal(controller.handlePointerDown({ target: 'inside', isSwitchActivation: true }), false);
  assert.equal(controller.isOpen('sources'), true);
  assert.equal(controller.handlePointerDown({ target: 'outside' }), true);
  assert.equal(anchor.focusCalls, 1);
  controller.activate({ key: 'sources', anchor, surface });
  assert.equal(controller.activate({ key: 'sources', anchor, surface }), 'closed');
  assert.equal(anchor.focusCalls, 2);
  controller.activate({ key: 'sources', anchor, surface });
  assert.equal(controller.handleKeyDown({ key: 'Escape', preventDefault() {} }), true);
  assert.equal(anchor.focusCalls, 3);
});

test('search suggestions escape content stacking and align to the search field in viewport coordinates', () => {
  const body = { appendChild(surface) { surface.parentElement = body; } };
  const field = { getBoundingClientRect: () => ({ left: 72, bottom: 46, width: 360 }) };
  const input = { getBoundingClientRect: () => ({ width: 324 }), closest: () => field };
  const context = loadRuntime({ document: { body, getElementById: () => input } });
  const surface = { style: {}, parentElement: {} };
  context.positionSearchSuggestionsSurface(surface);
  assert.equal(surface.parentElement, body);
  assert.deepEqual(surface.style, { position: 'fixed', top: '45px', left: '72px', right: 'auto', width: '360px' });
  assert.match(bootstrapGalleryEventHandlersSource, /positionSearchSuggestionsSurface\(popover\)/);
});

test('artist info dismisses on outside, Escape, repeat, and outside scroll but not internal scroll', () => {
  const context = loadRuntime();
  const shouldDismissArtistInfoOverlay = requireContract(context, 'shouldDismissArtistInfoOverlay');
  assert.equal(shouldDismissArtistInfoOverlay({ reason: 'outside-pointer' }), true);
  assert.equal(shouldDismissArtistInfoOverlay({ reason: 'escape' }), true);
  assert.equal(shouldDismissArtistInfoOverlay({ reason: 'repeat-anchor' }), true);
  assert.equal(shouldDismissArtistInfoOverlay({ reason: 'scroll', scrollInsideOverlay: false }), true);
  assert.equal(shouldDismissArtistInfoOverlay({ reason: 'scroll', scrollInsideOverlay: true }), false);
});

test('local artist information stays capability-bounded and leaves unavailable optional enrichment empty', () => {
  const context = loadRuntime();
  const resolveGalleryArtistInfo = requireContract(context, 'resolveGalleryArtistInfo');
  assert.deepEqual(plain(resolveGalleryArtistInfo({ albums: [{}, {}] }, 'Local Artist')), {
    summary: 'Local Artist has 2 albums in this Gallery view.',
    imageUrl: '',
    wikipediaUrl: '',
    isLongBiography: false,
  });
  const unsafe = resolveGalleryArtistInfo({
    albums: [],
    artist_summary: 'Short local summary',
    artist_image_url: 'C:\\Music\\private.jpg',
    wikipedia_url: 'javascript:alert(1)',
  }, 'Local Artist');
  assert.equal(unsafe.imageUrl, '');
  assert.equal(unsafe.wikipediaUrl, '');

  for (const artist of ['Neal Morse', 'Devin Townsend', 'Ария', 'The Flower Kings']) {
    const trial = resolveGalleryArtistInfo({ albums: [{}] }, artist);
    assert.match(trial.imageUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/Special:Redirect\/file\//);
  }
});

test('family panel reserves its lower bound only for an overlapping visible player', () => {
  const observed = [];
  let playerBounds = { left: 0, right: 800, top: 684, bottom: 800, width: 800, height: 116 };
  const player = {
    id: 'bottom-player', hidden: false, style: { untouched: 'yes' },
    getBoundingClientRect: () => playerBounds,
  };
  const panel = {
    style: { bottom: '' },
    getBoundingClientRect: () => ({ left: 410, right: 800, width: 390 }),
  };
  let observerCallback;
  class ResizeObserver {
    constructor(callback) { observerCallback = callback; }
    observe(target) { observed.push(target); }
    disconnect() {}
  }
  const context = loadRuntime({ ResizeObserver, window: { innerHeight: 800, innerWidth: 800 } });
  const observeArtistFamilyPanelBounds = requireContract(context, 'observeArtistFamilyPanelBounds');
  observeArtistFamilyPanelBounds({ panel, player });
  assert.deepEqual(observed, [player]);
  assert.equal(panel.style.bottom, '116px');

  playerBounds = { left: 0, right: 96, top: 704, bottom: 800, width: 96, height: 96 };
  observerCallback();
  assert.equal(panel.style.bottom, '0px');

  playerBounds = { left: 0, right: 800, top: 684, bottom: 800, width: 800, height: 116 };
  player.hidden = true;
  observerCallback();
  assert.equal(panel.style.bottom, '0px');
  assert.deepEqual(player.style, { untouched: 'yes' });

  context.refreshCount = 0;
  vm.runInContext('galleryFamilyPanelObserver = { refresh() { refreshCount += 1; } }', context);
  const positionArtistFamilyPanelEnvelope = requireContract(context, 'positionArtistFamilyPanelEnvelope');
  const positionedPanel = { dataset: {}, style: { setProperty() {} }, getBoundingClientRect: () => ({ top: 52 }) };
  const anchor = {
    getBoundingClientRect: () => ({ bottom: 42, right: 780, width: 34, height: 34 }),
    closest: () => ({ getBoundingClientRect: () => ({ bottom: 52 }) }),
  };
  positionArtistFamilyPanelEnvelope(positionedPanel, anchor);
  assert.equal(context.refreshCount, 1);
});

test('local Gallery filters preserve the current URL and browser history', () => {
  const context = loadRuntime();
  const applyGalleryClientTransition = requireContract(context, 'applyGalleryClientTransition');
  const historyCalls = [];
  const location = { href: 'https://albumhaven.test/?artist=Neal+Morse&q=progressive' };
  const history = {
    length: 7,
    pushState: (...args) => historyCalls.push(['pushState', ...args]),
    replaceState: (...args) => historyCalls.push(['replaceState', ...args]),
  };
  applyGalleryClientTransition({
    state: { sources: { main_library: true }, albumTypes: ['studio', 'ep'], view: 'cards', familyArtists: [] },
    action: { type: 'set-view', view: 'covers' },
    location,
    history,
  });
  assert.equal(location.href, 'https://albumhaven.test/?artist=Neal+Morse&q=progressive');
  assert.equal(history.length, 7);
  assert.deepEqual(historyCalls, []);
});

test('enabling a source omitted by a direct category URL requests hidden source data without changing that URL', () => {
  const context = loadRuntime();
  const resolveGallerySourceHydrationRequest = requireContract(context, 'resolveGallerySourceHydrationRequest');
  const buildGallerySourceHydrationView = requireContract(context, 'buildGallerySourceHydrationView');
  const nextState = {
    sources: { main_library: true, new_arrivals: true, hoard: false },
    albumTypes: ['studio', 'ep'],
    view: 'cards',
    familyArtists: [],
  };
  assert.deepEqual(plain(resolveGallerySourceHydrationRequest({
    currentCategories: ['new_arrivals'],
    nextState,
    action: { type: 'toggle-source', source: 'main_library' },
  })), ['main_library', 'new_arrivals']);
  assert.equal(resolveGallerySourceHydrationRequest({
    currentCategories: ['main_library', 'new_arrivals'],
    nextState: { ...nextState, sources: { ...nextState.sources, main_library: false } },
    action: { type: 'toggle-source', source: 'main_library' },
  }), null);
  assert.deepEqual(plain(buildGallerySourceHydrationView({
    currentView: { gallery_scope: 'new_arrivals', visible_library_categories: ['new_arrivals'], selected_artist: 'Neal Morse' },
    hydrationCategories: ['main_library', 'new_arrivals'],
  })), {
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'new_arrivals'],
    selected_artist: 'Neal Morse',
  });
});

test('source filtering keeps duplicated albums when any provenance category remains enabled', () => {
  const context = loadRuntime();
  const filterGalleryModel = requireContract(context, 'filterGalleryModel');
  const filtered = plain(filterGalleryModel({
    groups: [{
      artist: 'Shared Artist',
      albums: [{
        key: 'shared-release',
        library_root_category: 'main_library',
        root_provenance: { categories: ['main_library', 'hoard'] },
      }],
    }],
    filterState: {
      sources: { main_library: false, new_arrivals: false, hoard: true },
      albumTypes: ['studio', 'ep'],
      view: 'cards',
      familyArtists: [],
    },
  }));
  assert.deepEqual(filtered.groups.map((group) => group.albums.map((album) => album.key)), [['shared-release']]);
});

test('opening a Gallery surface moves focus inside it or onto the empty dialog itself', () => {
  const context = loadRuntime();
  const focusGalleryMainSurface = requireContract(context, 'focusGalleryMainSurface');
  const shouldFocusGalleryMainSurface = requireContract(context, 'shouldFocusGalleryMainSurface');
  assert.equal(shouldFocusGalleryMainSurface('sources'), true);
  assert.equal(shouldFocusGalleryMainSurface('album-types'), true);
  assert.equal(shouldFocusGalleryMainSurface('artist-family'), true);
  assert.equal(shouldFocusGalleryMainSurface('artist:Local Artist'), true);
  assert.equal(shouldFocusGalleryMainSurface('search-suggestions'), false);
  let controlFocused = false;
  const control = { focus: () => { controlFocused = true; } };
  const menu = { querySelector: () => control };
  assert.equal(focusGalleryMainSurface(menu), control);
  assert.equal(controlFocused, true);

  let dialogFocused = false;
  const dialog = { querySelector: () => null, tabIndex: 0, focus: () => { dialogFocused = true; } };
  assert.equal(focusGalleryMainSurface(dialog), dialog);
  assert.equal(dialog.tabIndex, -1);
  assert.equal(dialogFocused, true);
});


test('Artist Family connector measures the trigger gap and tracks the Gallery bottom edge', () => {
  const values = {};
  const context = loadRuntime({ window: { innerWidth: 1200 } });
  const panel = { dataset: {}, style: { setProperty: (key, value) => { values[key] = value; } } };
  const anchor = {
    getBoundingClientRect: () => ({ width: 34, height: 34, right: 1100, bottom: 60 }),
    closest: () => ({ getBoundingClientRect: () => ({ bottom: 72 }) }),
  };
  context.positionArtistFamilyPanelEnvelope(panel, anchor);
  assert.equal(panel.style.top, '72px');
  assert.equal(values['--gallery-anchor-gap'], '12px');
  assert.equal(values['--gallery-anchor-right'], '100px');
  assert.equal(values['--gallery-anchor-width'], '34px');
});


test('Artist Family drag selection paints one state and never retoggles a crossed pill', () => {
  const context = loadRuntime();
  const toggled = [];
  const paint = context.createGalleryFamilyPaintController(artist => toggled.push(artist));
  paint.begin('first', true);
  paint.visit('second', true);
  paint.visit('already-off', false);
  paint.visit('first', false);
  assert.deepEqual(toggled, ['first', 'second']);
  paint.end();
  paint.visit('outside-gesture', true);
  assert.deepEqual(toggled, ['first', 'second']);
  paint.begin('first', false);
  paint.visit('second', false);
  paint.visit('already-on', true);
  assert.deepEqual(toggled, ['first', 'second', 'first', 'second']);
});

test('root gallery summary retains authoritative totals across full hydration', () => {
  const context = loadRuntime();
  const preview = {artistCount:7,albumCount:7};
  assert.deepEqual(JSON.parse(JSON.stringify(context.resolveGallerySummaryTotals({initial_view_partial:true,artist_count:120,album_count:900},preview))), {artistCount:120,albumCount:900});
  const hydrated = { artistCount: 135, albumCount: 915 };
  assert.deepEqual(JSON.parse(JSON.stringify(context.resolveGallerySummaryTotals(
    { initial_view_partial: false, artist_count: 120, album_count: 900 }, hydrated,
    context.createGalleryMainState(),
  ))), { artistCount: 120, albumCount: 900 });
  assert.equal(context.resolveGallerySummaryTotals({initial_view_partial:true,selected_artist:'Artist'},preview),preview);
});
test('full root gallery summary preserves client-filtered and query totals', () => {
  const context = loadRuntime();
  const view = { initial_view_partial: false, artist_count: 120, album_count: 900 };
  const filtered = { artistCount: 2, albumCount: 3 };
  const filters = [
    { sources: { hoard: false } },
    { albumTypes: ['studio'] },
    { albumTypes: ['studio', 'ep'] },
    { showFeaturedOn: false },
    { familyArtists: ['Artist'] },
    { familySelectionExplicit: true },
  ];
  for (const overrides of filters) {
    assert.equal(context.resolveGallerySummaryTotals(
      view, filtered, context.createGalleryMainState(overrides),
    ), filtered);
  }
  assert.equal(context.resolveGallerySummaryTotals(
    { ...view, query: 'Artist' }, filtered, context.createGalleryMainState(),
  ), filtered);
});
test('a source switch over a partial gallery keeps an immediate exact count below the title', () => {
  const context = loadRuntime();
  const partial = { initial_view_partial: true, artist_count: 120, album_count: 900, loaded_library_categories: ['main_library', 'new_arrivals', 'hoard'] };
  const mounted = { artistCount: 80, albumCount: 200 };
  const hoardOnly = context.createGalleryMainState({ sources: { main_library: false, new_arrivals: false, hoard: true } });

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.resolveGallerySummaryTotals(partial, mounted, hoardOnly, null, {
      hoard: { artistCount: 7, albumCount: 11 },
    }))),
    { artistCount: 7, albumCount: 11 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.resolveGallerySummaryTotals(partial, mounted, hoardOnly))),
    mounted,
  );
  const complete = { ...partial, initial_view_partial: false };
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.resolveGallerySummaryTotals(complete,
      mounted, hoardOnly, null, { hoard: { artistCount: 7, albumCount: 11 } }))),
    { artistCount: 7, albumCount: 11 },
  );
});

test('source total prefetch caches every rapid toggle combination from one request', async () => {
  const requests = [];
  let responseRevision = 42;
  const sourceTotals = Object.fromEntries([
    '',
    'hoard',
    'hoard|main_library',
    'hoard|main_library|new_arrivals',
    'hoard|new_arrivals',
    'main_library',
    'main_library|new_arrivals',
    'new_arrivals',
  ].map((key, index) => [key, { artist_count: index, album_count: index + 10 }]));
  const context = loadRuntime({
    state: {
      status: { inventory_mutation_revision: 42 },
      gallery: {
        mainState: {
          sources: { main_library: true, new_arrivals: true, hoard: true },
        },
        sourceTotalsByScope: {},
      },
      view: {
        loaded_library_categories: ['main_library', 'new_arrivals', 'hoard'],
        artist_count: 120,
        album_count: 900,
      },
    },
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({
        inventory_mutation_revision: responseRevision,
        source_totals_by_scope: sourceTotals,
      }) };
    },
  });

  await Promise.all([
    context.prefetchGallerySourceTotalsForAllScopes(),
    context.prefetchGallerySourceTotalsForAllScopes(),
  ]);

  assert.deepEqual(requests, ['/home-data?source_totals=1']);
  assert.deepEqual(plain(context.state.gallery.sourceTotalsByScope), Object.fromEntries(
    Object.entries(sourceTotals).map(([key, value]) => [key, {
      artistCount: value.artist_count,
      albumCount: value.album_count,
    }]),
  ));
  assert.equal(context.state.gallery.sourceTotalsRevision, 42);

  context.state.status.inventory_mutation_revision = 43;
  responseRevision = 43;
  await context.prefetchGallerySourceTotalsForAllScopes();

  assert.deepEqual(requests, [
    '/home-data?source_totals=1',
    '/home-data?source_totals=1',
  ]);
  assert.equal(context.state.gallery.sourceTotalsRevision, 43);
});
test('a source transition waits for its exact total instead of flashing the previous count', async () => {
  let releaseTotals;
  const totalsReady = new Promise(resolve => { releaseTotals = resolve; });
  const renders = [];
  const context = loadRuntime({
    state: { status: { inventory_mutation_revision: 42 }, gallery: {}, view: {
      loaded_library_categories: ['main_library', 'new_arrivals', 'hoard'],
      artist_count: 120,
      album_count: 900,
    } },
    window: { location: {}, history: {} },
    renderArtistGroups: options => renders.push(options),
  });
  context.state.gallery.mainState = context.createGalleryMainState();
  context.state.gallery.sourceTotalsRevision = 41;
  context.state.gallery.sourceTotalsByScope = {
    'hoard|new_arrivals': { artistCount: 99, albumCount: 99 },
  };
  context.prefetchGallerySourceTotalsForAllScopes = async () => {
    await totalsReady;
    context.state.gallery.sourceTotalsByScope['hoard|new_arrivals'] = {
      artistCount: 7,
      albumCount: 11,
    };
    return true;
  };

  const transition = context.transitionGalleryMain({
    type: 'toggle-source',
    source: 'main_library',
  });
  assert.equal(context.state.gallery.mainState.sources.main_library, true);
  assert.equal(renders.length, 0);

  releaseTotals();
  await transition;

  assert.equal(context.state.gallery.mainState.sources.main_library, false);
  assert.equal(renders.length, 1);
});
test('a source transition keeps its current state when exact totals stay stale', async () => {
  const renders = [];
  const context = loadRuntime({
    state: { status: { inventory_mutation_revision: 42 }, gallery: {}, view: {
      loaded_library_categories: ['main_library', 'new_arrivals', 'hoard'],
      artist_count: 120,
      album_count: 900,
    } },
    window: { location: {}, history: {} },
    renderArtistGroups: options => renders.push(options),
  });
  context.state.gallery.mainState = context.createGalleryMainState();
  context.state.gallery.sourceTotalsRevision = 41;
  context.prefetchGallerySourceTotalsForAllScopes = async () => false;

  assert.equal(await context.transitionGalleryMain({
    type: 'toggle-source',
    source: 'main_library',
  }), false);
  assert.equal(context.state.gallery.mainState.sources.main_library, true);
  assert.equal(renders.length, 0);
});
test('partial bootstrap gallery chrome reports empty results after all sources are hidden', () => {
  const name = { textContent: '' };
  const summary = { textContent: '' };
  const bar = { offsetHeight: 54,
    querySelector: selector => selector === '[data-gallery-context-name]' ? name
      : selector === '[data-gallery-context-summary]' ? summary : null };
  const scroll = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
  const context = loadRuntime({ state: { gallery: {}, view: {
    initial_view_partial: true, artist_count: 120, album_count: 900,
    artist_groups: [{ artist: 'Preview artist', albums: [{ key: 'preview', source: 'main_library' }] }],
  } }, document: {
    querySelectorAll: () => [],
    querySelector: selector => selector === '[data-gallery-bar-instance="gallery"]' ? bar : null,
    getElementById: id => id === 'albums-scroll' ? scroll : null,
  } });
  context.updateGalleryMainControls = () => {};
  context.state.gallery.mainState = context.createGalleryMainState({
    sources: { main_library: false, new_arrivals: false, hoard: false },
  });
  context.updateGalleryMainChrome();
  assert.equal(summary.textContent, '0 artists · 0 albums');
});

test('gallery bar stays visible throughout active search transitions', () => {
  assert.match(bootstrapGalleryEventHandlersSource,
    /function updateGallerySearchDraftQuery\(nextQuery\)[\s\S]*?syncGalleryBarSearchVisibility\(\);/);
  const name = { textContent: '' };
  const summary = { textContent: '' };
  const bar = { hidden: false, offsetHeight: 54,
    querySelector: selector => selector === '[data-gallery-context-name]' ? name
      : selector === '[data-gallery-context-summary]' ? summary : null };
  const context = loadRuntime({ state: { gallery: {}, ui: { searchDraftQuery: '' }, view: {
    query: '', artist_groups: [],
  } }, document: {
    querySelectorAll: () => [],
    querySelector: selector => selector === '[data-gallery-bar-instance="gallery"]' ? bar : null,
    getElementById: id => id === 'albums-scroll' ? { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) } : null,
  } });
  context.updateGalleryMainControls = () => {};
  context.state.gallery.mainState = context.createGalleryMainState();

  context.updateGalleryMainChrome();
  assert.equal(bar.hidden, false);

  context.state.ui.searchDraftQuery = 'neal morse';
  context.updateGalleryMainChrome();
  assert.equal(bar.hidden, false, 'Gallery header remains visible during search');

  context.state.ui.searchDraftQuery = '';
  context.state.view.query = 'neal morse';
  context.updateGalleryMainChrome();
  assert.equal(bar.hidden, false, 'Gallery header remains visible during search');

  context.state.ui.searchDraftQuery = 'neal morse';
  context.state.view.selected_artist = 'Neal Morse';
  context.syncGalleryBarSearchVisibility();
  assert.equal(bar.hidden, false, 'resolved artist links show the Gallery family controls even when q is retained');

  context.state.ui.searchDraftQuery = 'neal morse band';
  context.syncGalleryBarSearchVisibility();
  assert.equal(bar.hidden, false, 'Gallery header remains visible during search');

  context.state.ui.searchDraftQuery = '';
  context.state.view.selected_artist = '';
  context.state.view.query = '';
  context.updateGalleryMainChrome();
  assert.equal(bar.hidden, false, 'clearing search restores Gallery context');
});

test('server-rendered searches retain the gallery bar', () => {
  assert.match(indexTemplateSource,
    /gallery_bar\('Gallery'[^)]*aria_label='Gallery controls'\)/);
});

test('root gallery summary counts canonical albums once across artist credits after filtering', () => {
  const name = { textContent: '' };
  const summary = { textContent: '' };
  const bar = { offsetHeight: 54,
    querySelector: selector => selector === '[data-gallery-context-name]' ? name
      : selector === '[data-gallery-context-summary]' ? summary : null };
  const shared = { key: 'shared-release', album: 'Same title', source: 'main_library' };
  const distinctVersion = { key: 'distinct-release', album: 'Same title', source: 'hoard' };
  const context = loadRuntime({ state: { gallery: {}, view: {
    artist_count: 2, album_count: 2,
    artist_groups: [
      { artist: 'Lead', albums: [shared, distinctVersion] },
      { artist: 'Guest', albums: [{ ...shared }] },
    ],
  } }, document: {
    querySelectorAll: () => [],
    querySelector: selector => selector === '[data-gallery-bar-instance="gallery"]' ? bar : null,
    getElementById: id => id === 'albums-scroll' ? { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) } : null,
  } });
  context.updateGalleryMainControls = () => {};
  context.state.gallery.mainState = context.createGalleryMainState();
  context.updateGalleryMainChrome();
  assert.equal(summary.textContent, '2 artists · 2 albums');
  assert.equal(context.getFilteredGalleryMainModel().totals.albumCount, 3,
    'card placements remain available to existing model consumers');
  context.state.gallery.mainState.sources.hoard = false;
  context.updateGalleryMainChrome();
  assert.equal(summary.textContent, '2 artists · 1 album');
  context.state.gallery.mainState.sources.main_library = false;
  context.updateGalleryMainChrome();
  assert.equal(summary.textContent, '0 artists · 0 albums');
});

test('root summary preserves unkeyed occurrences and selected-artist family totals', () => {
  const context = loadRuntime();
  const groups = [
    { artist: 'Lead', albums: [{ key: 'shared' }, { album: 'Untitled' }] },
    { artist: 'Guest', albums: [{ key: 'shared' }, { album: 'Untitled' }] },
  ];
  const mounted = { artistCount: 2, albumCount: 4 };
  const root = context.resolveGallerySummaryTotals({}, mounted, context.createGalleryMainState(), groups);
  assert.equal(root.albumCount, 3, 'missing keys must not collapse unrelated records');
  assert.equal(context.resolveGallerySummaryTotals({ selected_artist: 'Lead' }, mounted,
    context.createGalleryMainState(), groups), mounted);
});


test('family header contributes to panel width and never truncates the full family name', () => {
  assert.match(galleryMainCssSource, /\.artist-family-panel__title-row h2\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(galleryMainCssSource, /\.artist-family-panel > header\s*\{[^}]*contain:\s*inline-size/);
  assert.match(galleryMainCssSource, /\.artist-family-panel__heading p\s*\{[^}]*contain:\s*inline-size/);
});

test('family rows use available album art and retain independent pressed states', () => {
  const groups = [
    { artist: 'One', albums: [{}, { cover_url: '/cover/one' }] },
    { artist: 'Two', albums: [{ cover_url: '/cover/two' }] },
    { artist: 'Three', albums: [] },
  ];
  const context = loadRuntime({ state: { view: { selected_artist: 'One' } } });
  context.ensureGalleryMainState = () => ({ familySelectionExplicit: true, familyArtists: ['One', 'Two'] });
  context.getGalleryFamilyPanelModel = () => ({ groups });
  context.getGalleryFamilyPanelGroups = () => groups;
  const html = context.buildGalleryFamilyPanelBody();
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 2);
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 1);
  assert.match(html, /src="\/cover\/one"/);
  assert.match(html, /src="\/cover\/two"/);
  assert.match(html, /data-album-artbox-state="empty"/);
  assert.equal((html.match(/<button /g) || []).length, 3);
  assert.match(html, /artist-family-panel__primary-divider/);
  assert.doesNotMatch(html, /data-open-lightbox/);
});


test('Home keeps its context through density refreshes and returns to Gallery on a wide viewport', () => {
  const name = { textContent: '' }, summary = { textContent: '' };
  const bar = { hidden: false, offsetHeight: 54, dataset: {},
    querySelector: selector => selector === '[data-gallery-context-name]' ? name
      : selector === '[data-gallery-context-summary]' ? summary : null };
  const context = loadRuntime({ URL, window: { innerWidth: 390, location: { href: 'https://albumhaven.example/' } },
    state: { gallery: {}, ui: {}, view: { query: '', selected_artist: '', artist_groups: [], artist_count: 4, album_count: 8 } },
    document: {
    querySelectorAll: () => [],
      querySelector: selector => selector === '[data-gallery-bar-instance="gallery"]' ? bar : null,
      getElementById: id => id === 'albums-scroll' ? { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) } : id === 'mobile-home' ? { dataset: { accountName: 'Rendref' } } : null,
    },
  });
  vm.runInContext('function usesMobilePageLayout() { return window.innerWidth <= 900; }', context);
  vm.runInContext(fs.readFileSync(path.join(runtimeRoot, 'mobile-home.js'), 'utf8'), context);
  context.updateGalleryMainControls = () => {};
  context.state.gallery.mainState = context.createGalleryMainState();
  context.updateGalleryMainChrome();
  assert.equal(name.textContent, 'Rendref');
  assert.equal(summary.textContent, '');
  context.state.gallery.mainState.view = 'cards';
  context.updateGalleryMainChrome();
  assert.equal(name.textContent, 'Rendref');
  assert.equal(bar.dataset.galleryContextKind, 'home');
  context.window.innerWidth = 1180;
  context.updateGalleryMainChrome();
  assert.equal(name.textContent, 'Gallery');
  assert.equal(bar.dataset.galleryContextKind, 'gallery');
});

test('sticky artist changes only after the complete label is hidden, including reverse scrolling', () => {
  const context = loadRuntime();
  const groups = [{ artist: 'Previous', albumCount: 2, top: 0, labelBottom: 40 },
    { artist: 'Wrapped artist', albumCount: 3, top: 200, labelBottom: 268 }];
  for (const [scrollTop, artist] of [[267, 'Previous'], [268, 'Wrapped artist'], [269, 'Wrapped artist'], [267, 'Previous']]) {
    assert.equal(context.resolveGalleryBarContext({ scrollTop, galleryBarBottom: 100, groups }).artist, artist);
  }
});

test('context sections measure actual wrapped labels and retain a virtual offscreen fallback', () => {
  const context = loadRuntime({
    virtualGrid: { sectionHeaderHeight: 52, sections: [
      { top: 200, group: { artist: 'Wrapped', albums: [{}] } },
      { top: 900, group: { artist: 'Offscreen', albums: [{}] } },
    ] },
    document: {
      getElementById: () => ({ scrollTop: 180, getBoundingClientRect: () => ({ top: 120 }) }),
      querySelectorAll: () => [{ dataset: { scrollArtist: 'Wrapped' },
        querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 208 }) }) }],
    },
  });
  assert.deepEqual(plain(context.getGalleryMainContextSections()).map(section => section.labelBottom), [268, 952]);
});

test('canonical parent Cards route does not fall back to an unrelated saved Rows default', () => {
  const mainState = {};
  const context = loadRuntime({ URL,
    window: { location: { href: 'https://example.test/?gallery_display=list' } },
    state: { gallery: { displayPreferences: { defaultGalleryDisplayMode: 'list' } } },
  });
  context.ensureGalleryMainState = () => mainState;
  context.syncGalleryMainStateFromLocation('/?surface=albums&artist=Northlight');
  assert.equal(mainState.view, 'cards');
  assert.equal(context.window.location.href, 'https://example.test/?gallery_display=list');
  // A normal reload/route sync still honors the explicit URL override; parent
  // restoration must not rewrite the existing local-view/history contract.
  context.syncGalleryMainStateFromLocation();
  assert.equal(mainState.view, 'list');
});

test('retained gallery chrome leaves unchanged Artist Family DOM untouched and still refreshes new context', () => {
  const writes = [];
  const tracked = (label, values) => new Proxy(values, {
    set(target, property, value) {
      writes.push(`${label}.${String(property)}`);
      target[property] = value;
      return true;
    },
  });
  const title = tracked('title', { textContent: 'Lead Family', title: 'Lead Family' });
  const total = tracked('total', { textContent: '2 albums' });
  const checkedAttributes = { 'aria-checked': 'false' };
  const combine = {
    disabled: false,
    getAttribute: name => checkedAttributes[name] ?? null,
    setAttribute(name, value) {
      writes.push(`combine.${name}`);
      checkedAttributes[name] = value;
    },
  };
  const panel = { style: { top: '72px' } };
  const name = { textContent: '' };
  const summary = { textContent: '' };
  let barBottom = 72;
  const bar = {
    offsetHeight: 54,
    getBoundingClientRect: () => ({ bottom: barBottom }),
    querySelector: selector => selector === '[data-gallery-context-name]' ? name
      : selector === '[data-gallery-context-summary]' ? summary : null,
  };
  const groups = [{ artist: 'Lead', albums: [{ key: 'one' }, { key: 'two' }] }];
  const body = tracked('body', { dataset: tracked('body.dataset', {}) });
  const elements = new Map([
    ['[data-gallery-bar-instance="gallery"]', bar],
    ['[data-gallery-family-panel-title]', title],
    ['[data-gallery-family-panel-total]', total],
    ['[data-gallery-family-panel-body]', body],
    ['[data-artist-family-panel]', panel],
  ]);
  let combineEnabled = false;
  let albumCount = 2;
  const context = loadRuntime({
    window: { innerWidth: 1440 },
    state: { gallery: {}, ui: { searchDraftQuery: 'Lead' }, view: {
      query: 'Lead', selected_artist: 'Lead', artist_groups: groups,
    } },
    getCombineSimilarArtistsPreference: () => combineEnabled,
    document: {
      querySelector: selector => elements.get(selector) || null,
      querySelectorAll: selector => selector === '[data-toggle-combine-similar-artists="1"]' ? [combine] : [],
      getElementById: id => id === 'albums-scroll' ? { scrollTop: 104 } : null,
    },
  });
  const mainState = context.ensureGalleryMainState();
  body.dataset.galleryRenderSignature = JSON.stringify({
    filters: mainState,
    groups: groups.map(group => [group.artist, group.albums.length]),
  });
  context.getFilteredGalleryMainModel = () => ({ groups, totals: { artistCount: 1, albumCount } });
  context.getGalleryFamilyPanelGroups = () => groups;
  context.getGalleryFamilyPanelModel = () => ({ totals: { albumCount } });
  context.getGalleryMainContextSections = () => [];
  context.hasGalleryArtistFamily = () => true;
  writes.length = 0;

  context.updateGalleryMainChrome();
  context.state.view.query = '';
  context.state.ui.searchDraftQuery = '';
  context.updateGalleryMainChrome();
  assert.deepEqual(writes, [], 'search clear and repeated chrome refreshes must not rewrite retained family DOM');
  assert.equal(name.textContent, 'Lead family');
  assert.equal(bar.hidden, false);

  context.state.view.selected_artist = 'Next';
  albumCount = 3;
  combineEnabled = true;
  barBottom = 80;
  context.updateGalleryMainChrome();
  assert.equal(name.textContent, 'Next family');
  assert.equal(title.textContent, 'Next Family');
  assert.equal(title.title, 'Next Family');
  assert.equal(total.textContent, '3 albums');
  assert.equal(checkedAttributes['aria-checked'], 'true');
  assert.equal(panel.style.top, '80px');
  assert.deepEqual(writes.sort(), ['combine.aria-checked', 'title.textContent', 'title.title', 'total.textContent']);

  context.state.view.selected_artist = '';
  context.updateGalleryMainControls();
  assert.equal(combine.disabled, true, 'no selected artist disables the family switch');
  assert.equal(checkedAttributes['aria-checked'], 'false');
});


function animatedFamilySurfaceRuntime() {
  const timers = new Map();
  let nextTimer = 0, hiddenWrites = 0, hidden = false;
  const listeners = new Map();
  const classes = new Set(['is-open']);
  const panel = {
    get hidden() { return hidden; },
    set hidden(value) { hiddenWrites++; hidden = value; },
    matches: selector => selector.includes('.artist-family-panel'),
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    setAttribute() {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const anchor = { setAttribute() {}, focus() {} };
  const context = loadRuntime({ state: { view: {}, ui: {} }, window: {
    matchMedia: () => ({ matches: false }),
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  }, document: { getElementById: () => null } });
  context.focusGalleryMainSurface = () => {};
  context.positionArtistFamilyPanelEnvelope = () => {};
  context.panel = panel; context.anchor = anchor;
  vm.runInContext("galleryMainSurfaceController = createAnchoredSurfaceController(); galleryMainSurfaceController.activate({ key: 'artist-family', surface: panel, anchor });", context);
  return { context, panel, anchor, timers, listeners, hiddenWrites: () => hiddenWrites };
}

test('surface replacement finishes the departing family drawer before search suggestions activate', () => {
  const run = animatedFamilySurfaceRuntime();
  const suggestions = { matches: () => false, hidden: true, setAttribute() {}, classList: { add() {} } };
  run.context.openGalleryMainSurface('search-suggestions', run.anchor, suggestions);
  assert.equal(run.panel.hidden, true);
  assert.equal(suggestions.hidden, false);
  assert.equal(run.timers.size, 0);
  assert.equal(run.listeners.size, 0);
  assert.equal(run.hiddenWrites(), 1);
});

for (const completion of ['transitionend', 'timeout']) {
  test(`animated family dismissal completes once through ${completion}`, () => {
    const run = animatedFamilySurfaceRuntime();
    run.context.closeGalleryMainSurface(false);
    assert.equal(run.panel.hidden, false, 'ordinary dismissal retains its closing animation');
    const transition = run.listeners.get('transitionend');
    const timeout = [...run.timers.values()][0];
    if (completion === 'transitionend') transition(); else timeout();
    assert.equal(run.panel.hidden, true);
    assert.equal(run.timers.size, 0);
    assert.equal(run.listeners.size, 0);
    transition(); timeout();
    assert.equal(run.hiddenWrites(), 1, 'already queued callbacks must not mutate a finished drawer');
  });
}

test('reopening a family drawer cancels the earlier closing callbacks', () => {
  const run = animatedFamilySurfaceRuntime();
  run.context.closeGalleryMainSurface(false);
  const staleFinish = [...run.timers.values()][0];
  run.context.openGalleryMainSurface('artist-family', run.anchor, run.panel);
  assert.equal(run.timers.size, 0);
  assert.equal(run.listeners.size, 0);
  run.context.closeGalleryMainSurface(false);
  const writes = run.hiddenWrites();
  staleFinish();
  assert.equal(run.panel.hidden, false, 'a stale close cannot finish the new animation');
  assert.equal(run.hiddenWrites(), writes);
});

test('ID-012: each click on the Split Albums switch moves Show -> Separate -> Hide -> Show', () => {
  const context = loadRuntime();
  const state = { splitAlbums: 'show' };
  context.ensureGalleryMainState = () => state;
  const visited = [];
  for (let click = 0; click < 3; click += 1) {
    state.splitAlbums = context.resolveSplitAlbumsSwitchMode();
    visited.push(state.splitAlbums);
  }
  assert.deepEqual(visited, ['separate', 'hide', 'show']);
  assert.match(galleryMainCssSource, /data-switch-position="1"\] \.gallery-switch__track \{ background: color-mix\(in oklch, #4da3ff 72%, var\(--appearance-play, #4bc173\)\); \}/);
});

test('artist information links MusicBrainz and Discogs only for an accepted match, as icon and text', () => {
  const ButtonComponent = require('../../../music_app/static/js/button-component.js');
  const context = loadRuntime({ ButtonComponent, state: { view: { query: '' } } });
  const build = requireContract(context, 'buildGalleryArtistExternalLinksHtml');
  const mbid = 'c0926f5d-098c-4f29-a463-5489b43a273a';

  const links = build({
    artist_mbid: mbid,
    musicbrainz_url: `https://musicbrainz.org/artist/${mbid}`,
    discogs_url: 'https://www.discogs.com/artist/218108',
  }, 'Neal Morse');
  assert.match(links, new RegExp(`<a class="ui-external-link ui-external-link--musicbrainz" href="https://musicbrainz\.org/artist/${mbid}" target="_blank" rel="noopener noreferrer" aria-label="Open Neal Morse on MusicBrainz">`));
  assert.match(links, /ui-external-link__icon[^>]*aria-hidden="true"[\s\S]*?<span class="ui-external-link__text">MusicBrainz<\/span>/);
  assert.match(links, /href="https:\/\/www\.discogs\.com\/artist\/218108"[^>]*aria-label="Open Neal Morse on Discogs"[\s\S]*?>Discogs</);
  assert.doesNotMatch(links, /ui-button/, 'links are plain icon and text, not buttons');
  assert.match(links, /^<div class="ui-external-link-list"><a class="ui-external-link ui-external-link--musicbrainz"[\s\S]*<\/a><\/div>$/,
    'service links share one vertical list');

  assert.equal(build(null, 'Angra'), '', 'unresolved artists carry no projection and show no links');
  assert.doesNotMatch(build({ musicbrainz_url: `https://musicbrainz.org/artist/${mbid}` }, 'Angra'), /Discogs/);
  assert.equal(build({ musicbrainz_url: `http://127.0.0.1:5050/artist/${mbid}`, discogs_url: 'https://evil.example/artist/1' }, 'Angra'), '',
    'only the public MusicBrainz and Discogs artist pages are linked');
});

test('the artist panel ends its text with one disabled Open full page and lists service links below it', () => {
  assert.doesNotMatch(galleryMainCssSource, /\.artist-info-overlay__links :is\(a, button\)/);
  assert.doesNotMatch(galleryMainCssSource, /\.ui-external-link[^,{]*\{/, 'no page-local external link styling');
  const panelSources = galleryMainInteractionsSource + galleryMainComponentsSource + galleryMainStateSource + galleryMainCssSource + mobileLayoutCssSource;
  assert.doesNotMatch(panelSources, /Read more|Read less|data-artist-info-read-more|canReadMore|is-expanded|artist-info-overlay__actions|data-artist-info-full-page|buildArtistInfoOverlayHtml/,
    'no expand or collapse, no Read more, and no separate Full page action');

  assert.match(galleryMainInteractionsSource, /^const GALLERY_ARTIST_FULL_PAGE_LABEL = 'Open full page';$/m, 'one label constant');
  const builder = galleryMainInteractionsSource.slice(galleryMainInteractionsSource.indexOf('function openGalleryArtistInfo('));
  assert.match(builder, /const fullPage = `<button type="button" class="artist-info-overlay__full-page" aria-disabled="true" disabled title="Artist pages are not available yet">\$\{GALLERY_ARTIST_FULL_PAGE_LABEL\}<\/button>`;/,
    'disabled for every artist, with the same title Full page had');
  assert.match(builder, /<p data-artist-info-summary\$\{isLongBiography \? ' data-artist-info-long' : ''\}>\$\{escapeHtml\(summary\)\} \$\{fullPage\}<\/p>\$\{links \? `<div class="artist-info-overlay__links">\$\{links\}<\/div>` : ''\}/,
    'the control is the last item of the text, and the service links follow below it');
  // An artist matched under another name shows the MusicBrainz name as its title and
  // names the tag under its links; a split artist lists its MusicBrainz artists first.
  assert.match(builder, /<\/div>` : ''\}\$\{identities\}\$\{credit\}/);
  assert.match(builder, /data-artist-info-credit>Tagged as \$\{escapeHtml\(artist\)\} in your files\.<\/p>/);
  assert.match(builder, /<h2>\$\{escapeHtml\(displayName\)\}<\/h2>/);
  assert.match(builder, /scrollHeight <= summaryElement\.clientHeight \+ 1\) summaryElement\.removeAttribute\('data-artist-info-long'\)/,
    'text that fits in five lines gets no clamp or fade');

  const clamp = galleryMainCssSource.match(/\.artist-info-overlay__body \[data-artist-info-summary\]\[data-artist-info-long\]\s*\{([^}]*)\}/);
  assert.ok(clamp, 'a long biography is clamped');
  assert.match(clamp[1], /max-height:\s*7\.5em;\s*overflow:\s*hidden/, 'five 1.5-line-height lines');
  assert.match(galleryMainCssSource, /\[data-artist-info-long\] \.artist-info-overlay__full-page\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*0;[^}]*--artist-info-full-page-background:\s*linear-gradient\(to right, transparent, var\(--panel\) 2em\)/,
    'the clamped control sits at the end of line five over a fade in the panel colour of either theme');
  assert.match(galleryMainCssSource, /\[data-artist-info-long\] \.artist-info-overlay__full-page::before\s*\{\s*content:\s*"…";\s*display:\s*inline-block/);
  assert.doesNotMatch(galleryMainCssSource + mobileLayoutCssSource, /-webkit-line-clamp/, 'one clamp mechanism, on desktop and mobile');
  const disabled = galleryMainCssSource.match(/\.artist-info-overlay__full-page:disabled\s*\{([^}]*)\}/)[1];
  assert.match(disabled, /color:\s*color-mix\(in srgb, var\(--appearance-accent,[^)]*\)\) 45%, transparent\)/, 'dimmed like Full page was');
  assert.doesNotMatch(disabled, /opacity/, 'dimming the colour keeps the fade behind it opaque');
});
