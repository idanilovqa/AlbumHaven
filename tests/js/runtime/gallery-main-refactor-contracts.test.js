const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const proposedRuntimeFiles = [
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
const galleryMainCssSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'gallery-main.css'),
  'utf8',
);
const indexTemplateSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'),
  'utf8',
);

function loadRuntime(overrides = {}) {
  const context = {
    escapeHtml: (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;'),
    console,
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

test('reusable GalleryBar, switch, panel, info overlay, divider, and artist heading render accessible contracts', () => {
  const context = loadRuntime();
  const buildGalleryBarHtml = requireContract(context, 'buildGalleryBarHtml');
  const buildSwitchHtml = requireContract(context, 'buildGallerySwitchHtml');
  const buildArtistFamilyPanelHtml = requireContract(context, 'buildArtistFamilyPanelHtml');
  const buildArtistInfoOverlayHtml = requireContract(context, 'buildArtistInfoOverlayHtml');
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

  const overlay = buildArtistInfoOverlayHtml({
    artist: 'Neal Morse', summary: 'Selectable biography', imageUrl: '/artist.jpg',
    readMoreUrl: '/artists/neal-morse', wikipediaUrl: 'https://en.wikipedia.org/wiki/Neal_Morse',
  });
  assert.match(overlay, /data-artist-info-overlay/);
  assert.match(overlay, /Selectable biography/);
  assert.match(overlay, /src="\/artist\.jpg"/);
  assert.match(overlay, />Read more</);
  assert.match(overlay, />Wikipedia</);

  assert.match(buildGalleryDividerHtml({ label: 'Family', albumCount: 9 }), /Family[\s\S]*9 albums/);
  const artistHeading = buildFamilyArtistHeaderHtml({ artist: 'Flying Colors', albumCount: 4 });
  assert.match(artistHeading, /class="artist-name"[^>]*>Flying Colors</);
  assert.match(artistHeading, /Flying Colors[\s\S]*4 albums/);
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
  assert.match(markup, /artist-family-panel__primary-divider/);
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

test('the live Album types menu starts with unavailable loose tracks disabled', () => {
  assert.match(
    indexTemplateSource,
    /data-open-non-album-tracks="1"[^>]*disabled[^>]*aria-disabled="true"/,
  );
  const context = loadRuntime();
  const hasGalleryNonAlbumTracks = requireContract(context, 'hasGalleryNonAlbumTracks');
  assert.equal(hasGalleryNonAlbumTracks({ non_album_tracks: [] }), false);
  assert.equal(hasGalleryNonAlbumTracks({ non_album_tracks: [{ title: 'Loose' }] }), true);
});

test('artist info triggers use a larger plain information glyph with neutral envelope styling', () => {
  const context = loadRuntime();
  const buildFamilyArtistHeaderHtml = requireContract(context, 'buildFamilyArtistHeaderHtml');
  const markup = buildFamilyArtistHeaderHtml({ artist: 'Neal Morse', albumCount: 2 });
  assert.match(markup, /gallery-info-button__glyph/);
  assert.doesNotMatch(markup, /ⓘ/);
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

test('the collapsed Gallery view control hides the inactive icon instead of overlapping it', () => {
  const css = fs.readFileSync(path.join(runtimeRoot, '..', '..', 'css', 'unfolding-action-button.css'), 'utf8');
  for (const rule of ['flex: 0 0 0px', 'min-width: 0', 'overflow: hidden', 'visibility: hidden', 'pointer-events: none', 'outline: none !important', 'prefers-reduced-motion']) assert.ok(css.includes(rule));
  assert.match(css, /:is\(:hover, :focus-within\)[^{]*\{[^}]*outline:/);
  assert.doesNotMatch(css, /border-left:/);
});

test('client Gallery state defaults to all sources, Studio plus EP, cards, and an unfiltered gallery', () => {
  const context = loadRuntime();
  const createGalleryMainState = requireContract(context, 'createGalleryMainState');
  assert.deepEqual(plain(createGalleryMainState()), {
    sources: { main_library: true, new_arrivals: true, hoard: true },
    albumTypes: ['studio', 'ep'],
    view: 'cards',
    familyArtists: [],
  });
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
    albumTypes: ['studio', 'ep'],
    view: 'covers',
    familyArtists: [],
  });
});

test('source, supported type, view, and family transitions retain durable cards and covers values', () => {
  const context = loadRuntime();
  const createGalleryMainState = requireContract(context, 'createGalleryMainState');
  const reduceGalleryMainState = requireContract(context, 'reduceGalleryMainState');
  let state = createGalleryMainState();
  state = reduceGalleryMainState(state, { type: 'toggle-source', source: 'hoard' });
  state = reduceGalleryMainState(state, { type: 'toggle-album-type', albumType: 'compilation' });
  state = reduceGalleryMainState(state, { type: 'set-view', view: 'covers' });
  state = reduceGalleryMainState(state, { type: 'toggle-family-artist', artist: 'Flying Colors' });
  assert.deepEqual(plain(state), {
    sources: { main_library: true, new_arrivals: true, hoard: false },
    albumTypes: ['studio', 'ep', 'compilation'],
    view: 'covers',
    familyArtists: ['Flying Colors'],
  });
  assert.equal(reduceGalleryMainState(state, { type: 'set-view', view: 'No info' }).view, 'covers');
  assert.equal(reduceGalleryMainState(state, { type: 'set-view', view: 'Cards' }).view, 'cards');
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

test('GalleryBar scroll context uses absolute virtual section coordinates instead of mounted DOM offsets', () => {
  const context = loadRuntime({
    virtualGrid: {
      sections: [
        { top: 1200, group: { artist: 'Neal Morse & The Resonance', albums: [{}, {}] } },
        { top: 2200, group: { artist: 'Cosmic Cathedral', albums: [{}] } },
      ],
    },
  });
  const getGalleryMainContextSections = requireContract(context, 'getGalleryMainContextSections');
  assert.deepEqual(plain(getGalleryMainContextSections()), [
    { artist: 'Neal Morse & The Resonance', albumCount: 2, top: 1200 },
    { artist: 'Cosmic Cathedral', albumCount: 1, top: 2200 },
  ]);
});

test('Artist Family panel reuses the legacy selected and primary visual hierarchy', () => {
  const state = {
    view: {
      selected_artist: 'Neal Morse',
      primary_artist_groups: [{ artist: 'Neal Morse', albums: [{ key: 'one' }] }],
      family_artist_groups: [{ artist: 'Cosmic Cathedral', albums: [{ key: 'deep-water' }] }],
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

  const markup = buildGalleryFamilyPanelBody();

  assert.match(markup, /class="artist-family-panel__artist is-active is-primary"[^>]*data-gallery-family-artist="Neal Morse"/);
  assert.match(markup, /class="artist-family-panel__artist is-active"[^>]*data-gallery-family-artist="Cosmic Cathedral"/);
  assert.match(
    galleryMainCssSource,
    /\.artist-family-panel__artist\.is-active\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--accent\) 22%, var\(--panel-2\)\)[^}]*box-shadow:/,
  );
  assert.match(
    galleryMainCssSource,
    /\.artist-family-panel__artist\.is-primary\s*\{[^}]*border-width:\s*2px[^}]*0 0 18px color-mix\(in srgb, var\(--accent\) 16%, transparent\)/,
  );
  assert.match(
    galleryMainCssSource,
    /\.artist-family-panel__artist\.is-primary\.is-active\s*\{[^}]*0 0 22px color-mix\(in srgb, var\(--accent\) 24%, transparent\)/,
  );
});

test('unavailable release types remain inert while Studio and Compilation use catalog-backed facts', () => {
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

  for (const albumType of ['live', 'demo', 'ep', 'single']) {
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
      albumTypes: ['studio', 'ep'],
      view: 'cards',
      familyArtists: [],
    },
  }));
  assert.deepEqual(filtered.groups.map((group) => ({ key: group.key, albums: group.albums.map((album) => album.key) })), [
    { key: 'primary', albums: ['studio', 'ep', 'live'] },
    { key: 'family', albums: ['single'] },
  ]);
  assert.deepEqual(filtered.totals, { artistCount: 2, albumCount: 4 });
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
    canReadMore: false,
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

test('family panel observes player height and changes only its own lower bound', () => {
  const observed = [];
  const player = { id: 'bottom-player', style: { untouched: 'yes' } };
  const panel = { style: { bottom: '' } };
  let observerCallback;
  class ResizeObserver {
    constructor(callback) { observerCallback = callback; }
    observe(target) { observed.push(target); }
    disconnect() {}
  }
  const context = loadRuntime({ ResizeObserver });
  const observeArtistFamilyPanelBounds = requireContract(context, 'observeArtistFamilyPanelBounds');
  observeArtistFamilyPanelBounds({ panel, player });
  observerCallback([{ target: player, contentRect: { height: 116 } }]);
  assert.deepEqual(observed, [player]);
  assert.equal(panel.style.bottom, '116px');
  assert.deepEqual(player.style, { untouched: 'yes' });
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

test('partial root gallery summary uses known totals instead of preview album count', () => {
  const context = loadRuntime();
  const preview = {artistCount:7,albumCount:7};
  assert.deepEqual(JSON.parse(JSON.stringify(context.resolveGallerySummaryTotals({initial_view_partial:true,artist_count:120,album_count:900},preview))), {artistCount:120,albumCount:900});
  assert.equal(context.resolveGallerySummaryTotals({initial_view_partial:false,artist_count:120,album_count:900},preview),preview);
  assert.equal(context.resolveGallerySummaryTotals({initial_view_partial:true,selected_artist:'Artist'},preview),preview);
});
test('partial bootstrap gallery chrome reports empty results after all sources are hidden', () => {
  const name = { textContent: '' };
  const summary = { textContent: '' };
  const bar = { offsetHeight: 54,
    querySelector: selector => selector === '[data-gallery-context-name]' ? name
      : selector === '[data-gallery-context-summary]' ? summary : null };
  const scroll = { scrollTop: 0 };
  const context = loadRuntime({ state: { gallery: {}, view: {
    initial_view_partial: true, artist_count: 120, album_count: 900,
    artist_groups: [{ artist: 'Preview artist', albums: [{ key: 'preview', source: 'main_library' }] }],
  } }, document: {
    querySelector: selector => selector === '[data-gallery-bar]' ? bar : null,
    getElementById: id => id === 'albums-scroll' ? scroll : null,
  } });
  context.updateGalleryMainControls = () => {};
  context.state.gallery.mainState = context.createGalleryMainState({
    sources: { main_library: false, new_arrivals: false, hoard: false },
  });
  context.updateGalleryMainChrome();
  assert.equal(summary.textContent, '0 artists · 0 albums');
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
    querySelector: selector => selector === '[data-gallery-bar]' ? bar : null,
    getElementById: id => id === 'albums-scroll' ? { scrollTop: 0 } : null,
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
