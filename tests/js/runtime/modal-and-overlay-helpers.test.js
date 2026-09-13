const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'modal-and-overlay-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const buttonComponentPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'button-component.js');
const galleryMainComponentsPath = path.join(path.dirname(helperPath), 'gallery-main-components.js');
const galleryMainComponentsSource = fs.readFileSync(galleryMainComponentsPath, 'utf8');
const bootstrapGalleryHandlersSource = fs.readFileSync(
  path.join(path.dirname(helperPath), 'bootstrap-gallery-event-handlers.js'),
  'utf8',
);
const compactTableSource = fs.readFileSync(
  path.join(path.dirname(helperPath), 'compact-data-table.js'),
  'utf8',
);
const albumTrackTableSource = fs.readFileSync(
  path.join(path.dirname(helperPath), 'album-track-table.js'),
  'utf8',
);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens) {
    tokens.forEach((token) => this.values.delete(token));
  }

  contains(token) {
    return this.values.has(token);
  }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.attributes = {};
    this.hidden = true;
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList();
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.offsetTop = 0;
    this.offsetLeft = 0;
    this.offsetParent = null;
    this.children = [];
  }

  getAttribute(name) {
    return this.attributes[name] || '';
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelector(selector) {
    if (selector === '.cover') {
      return this.cover || null;
    }
    return null;
  }
}

function loadHelper() {
  const preloaders = [];
  class FakePreloader {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.src = '';
      this.decodePromise = new Promise((resolve, reject) => {
        this.resolveDecode = resolve;
        this.rejectDecode = reject;
      });
      preloaders.push(this);
    }

    decode() {
      return this.decodePromise;
    }
  }
  const viewport = new FakeElement('albums-viewport');
  viewport.clientWidth = 900;
  viewport.clientHeight = 620;
  const scroll = new FakeElement('albums-scroll');
  const glow = new FakeElement('gallery-focus-glow');
  const elementsById = {
    'albums-viewport': viewport,
    'albums-scroll': scroll,
    'gallery-focus-glow': glow,
  };
  const body = new FakeElement('body');
  body.appendChild = (child) => {
    if (child?.id) {
      elementsById[child.id] = child;
    }
    body.children.push(child);
    return child;
  };
  const rafQueue = [];
  const context = {
    Date: { now() { return context.__now; } },
    __now: 1800000,
    Image: FakePreloader,
    HTMLElement: FakeElement,
    HTMLImageElement: FakeElement,
    document: {
      documentElement: {
        getAttribute() { return null; },
      },
      getElementById(id) {
        return elementsById[id] || null;
      },
      body,
      createElement(tagName) {
        return new FakeElement(tagName);
      },
    },
    state: {
      gallery: {
        focusedAlbumGlowCard: null,
        pendingAlbumGlowCard: null,
        focusGlowRaf: 0,
        focusGlowKey: '',
        focusGlowVisible: false,
      },
      versionPicker: {},
      ui: {},
      lightbox: {},
      coverLookup: {
        optimisticAlbumCovers: {},
      },
      coverRefreshTokens: {},
      coverFailures: {
        localDisplayPaths: {},
      },
      modalReleases: [],
      modalReleaseIndex: 0,
      utility: {},
      view: {},
      player: { current: null },
    },
    scheduleBrowserAnimationFrame(callback) {
      rafQueue.push(callback);
      return rafQueue.length;
    },
    cancelBrowserAnimationFrame() {},
    scheduleBrowserTimeout(callback) {
      if (typeof callback === 'function') {
        callback();
      }
      return 1;
    },
    escapeHtml(value) {
      return String(value ?? '');
    },
    formatTrackDuration(value) {
      const seconds = Math.max(0, Math.floor(Number(value) || 0));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    },
    formatAlbumDuration(value) {
      const seconds = Math.max(0, Math.floor(Number(value) || 0));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    },
    getPlayerPlaybackSnapshot() {
      return { paused: true, ended: true, currentTime: 0, duration: 0 };
    },
    formatLoopTime(value) {
      return String(value ?? 0);
    },
    getProblematicAlbumForTrackPath() {
      return null;
    },
    getCurrentGalleryPreferenceArtist() {
      return '';
    },
    getCombineSimilarArtistsPreference() {
      return false;
    },
    normalizeVisibleLibraryCategorySelection(categories) {
      return Array.isArray(categories) && categories.length
        ? categories
        : ['main_library', 'hoard', 'new_arrivals'];
    },
    flattenVisibleAlbums() {
      return [];
    },
    compareAlbumVariants() {
      return 0;
    },
    getAlbumPathSignature() {
      return '';
    },
    buildRemoteCoverLookupImageUrl() {
      return '';
    },
    getAlbumIdentity(album) {
      return String(album?.key || '');
    },
    ButtonComponent: require(buttonComponentPath),
  };

  vm.createContext(context);
  vm.runInContext(compactTableSource, context, {
    filename: path.join(path.dirname(helperPath), 'compact-data-table.js'),
  });
  vm.runInContext(albumTrackTableSource, context, {
    filename: path.join(path.dirname(helperPath), 'album-track-table.js'),
  });
  vm.runInContext(helperSource, context, { filename: helperPath });
  context.__preloaders = preloaders;
  return {
    context,
    viewport,
    scroll,
    glow,
    flushAnimationFrame() {
      const callback = rafQueue.shift();
      if (callback) callback();
    },
  };
}

test('non-album tracks follow the displayed artist family instead of a retained root list', () => {
  const { context } = loadHelper();
  const tracks = [
    { artist: 'Neal Morse', title: 'Solo track' },
    { artist: 'Flying Colors', title: 'Family track' },
    { artist: 'Folkstone', title: 'Unrelated track' },
  ];
  context.state.view = {
    selected_artist: 'Neal Morse',
    related_artists: ['Flying Colors'],
    non_album_tracks: tracks,
  };
  assert.deepEqual(Array.from(context.getVisibleNonAlbumTracks()), tracks.slice(0, 2));
  context.state.view.non_album_tracks = [tracks[2]];
  assert.equal(context.getVisibleNonAlbumTracks().length, 0);
});

test('hiding a loaded source scopes Loose Tracks and its Edit tags collection', async () => {
  const { context } = loadHelper();
  for (const filename of ['gallery-main-state.js', 'gallery-main-interactions.js']) {
    vm.runInContext(fs.readFileSync(path.join(path.dirname(helperPath), filename), 'utf8'), context, { filename });
  }
  // These are the current public non-album payload shape: no root/category field.
  const mainTrack = { path: '/fixture/main/song.mp3', artist: 'Main Artist', title: 'Main loose song' };
  const hoardTrack = { path: '/fixture/hoard/song.mp3', artist: 'Hoard Artist', title: 'Hoard loose song' };
  const categories = ['main_library', 'new_arrivals', 'hoard'];
  context.state.view = {
    selected_artist: '', gallery_scope: 'all', query: '',
    visible_library_categories: categories, loaded_library_categories: categories,
    non_album_tracks: [mainTrack, hoardTrack],
  };
  context.window = { location: { href: 'http://localhost/' }, history: {} };
  context.renderArtistGroups = () => {};
  const requests = [];
  let completeRefresh;
  const responseReady = new Promise(resolve => { completeRefresh = resolve; });
  context.buildApiUrl = view => '/view?' + new URLSearchParams(
    view.visible_library_categories.map(category => ['category', category]),
  ).toString();
  context.fetchAndRender = async url => {
    requests.push(url);
    await responseReady;
    // Network boundary: the server already returns a category-scoped list.
    const selected = new URL(url, 'http://localhost').searchParams.getAll('category');
    if (!selected.includes('hoard')) context.state.view = {
      ...context.state.view, non_album_tracks: [mainTrack],
      visible_library_categories: selected, loaded_library_categories: selected,
    };
  };
  const edited = [];
  context.closeNonAlbumModal = () => {};
  context.openTagEditor = album => edited.push(album);
  context.showRepairAlert = () => {};

  context.transitionGalleryMain({ type: 'toggle-source', source: 'hoard' });
  assert.equal(context.getVisibleNonAlbumTracks().length, 0, 'unscoped records stay unavailable during refresh');
  context.openNonAlbumTagEditor();
  assert.equal(edited.length, 0, 'an immediate Edit tags action cannot use stale records');
  completeRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(context.getVisibleNonAlbumTracks(), track => track.path), [mainTrack.path],
    'a hidden source must not remain in the Loose Tracks collection');
  context.openNonAlbumTagEditor();
  assert.deepEqual(Array.from(edited[0].tracks, track => track.path), [mainTrack.path]);
  assert.ok(requests.length > 0, 'payloads without category provenance need an authoritative scoped refresh');
});

test('backend-scoped non-album search matches survive an empty album gallery', () => {
  const { context } = loadHelper();
  const tracks = [
    { artist: 'Flying Colors', title: 'Family track' },
    { artist: 'Folkstone', title: 'Unrelated track' },
  ];
  context.state.view = { non_album_tracks: tracks, artist_groups: [{ artist: 'Neal Morse' }] };
  assert.deepEqual(Array.from(context.getVisibleNonAlbumTracks()), tracks);
  context.state.view.query = 'Family';
  context.state.view.non_album_tracks = [tracks[0]];
  context.state.view.artist_groups.push({ artist: 'Flying Colors' });
  assert.deepEqual(Array.from(context.getVisibleNonAlbumTracks()), [tracks[0]]);
  context.state.view.artist_groups = [];
  assert.deepEqual(Array.from(context.getVisibleNonAlbumTracks()), [tracks[0]]);
  context.state.view.selected_artist = 'Unrelated Artist';
  assert.equal(context.getVisibleNonAlbumTracks().length, 0);
});

test('non-album artist scope retains folder matches and canonical album artists', () => {
  const { context } = loadHelper();
  const tracks = [
    { artist: 'Unknown', display_path: 'Rock\\Neal Morse\\song.mp3' },
    { artist: 'Guest', album_artist: 'neal morse' },
    { artist: 'Other', display_path: 'Rock\\Other\\Neal Morse.mp3' },
  ];
  context.state.view = { selected_artist: 'Neal Morse', non_album_tracks: tracks };
  assert.deepEqual(Array.from(context.getVisibleNonAlbumTracks()), tracks.slice(0, 2));
});

test('non-album artist scope expands only aliases of the displayed family', () => {
  const { context } = loadHelper();
  const tracks = [
    { artist: 'Unknown', display_path: 'Rock/Alias/song.mp3' },
    { artist: 'Unknown', display_path: 'Rock/Family Alias/song.mp3' },
    { artist: 'Unknown', display_path: 'Rock/Family_Alias/song.mp3' },
    { artist: 'Unknown', display_path: 'Rock/Unrelated Alias/song.mp3' },
  ];
  context.state.view = {
    selected_artist: 'Canonical', related_artists: ['Family'], non_album_tracks: tracks,
    artist_family_filters: [
      { display_name: 'Canonical', variation_names: ['Canonical', 'Alias'] },
      { display_name: 'Family', variation_names: ['Family', 'Family Alias'] },
      { display_name: 'Unrelated', variation_names: ['Unrelated', 'Unrelated Alias'] },
    ],
  };
  assert.deepEqual(Array.from(context.getVisibleNonAlbumTracks()), tracks.slice(0, 3));
  context.state.view.selected_artist = 'Another Artist';
  context.state.view.related_artists = [];
  assert.deepEqual(Array.from(context.getVisibleNonAlbumTracks()), [],
    'retained aliases must not authorize tracks after the displayed artist changes');
});

test('non-album modal adapts ordered exception groups into one shared AlbumTrackTable', () => {
  const { context } = loadHelper();
  const markup = context.buildNonAlbumTrackSectionsMarkup([
    {
      path: 'C:/Music/Artist/Interview.mp3',
      display_path: 'Artist/Interview.mp3',
      title: 'An Interview',
      artist: 'Guest Artist',
      exception_type: 'Interview',
      duration_seconds: 95,
    },
    {
      path: 'C:/Music/Artist/Rarity.mp3',
      display_path: 'Artist/Rarity.mp3',
      title: 'Rare Song',
      artist: 'Main Artist feat. Guest',
      exception_type: 'Non-album rarity',
      duration_seconds: 245,
    },
  ]);

  assert.ok(
    markup.indexOf('>Non-album rarity<') < markup.indexOf('>Interviews<'),
    'rarities must render before interviews regardless of payload order',
  );
  assert.equal((markup.match(/class="album-track-table"/g) || []).length, 1);
  assert.equal((markup.match(/class="album-track-table__total"/g) || []).length, 1);
  assert.match(markup, /--cdt-columns: 36px minmax\(180px, 1fr\) minmax\(220px, \.9fr\) 20px minmax\(54px, auto\)/);
  assert.doesNotMatch(markup, /data-cdt-column="play"/);
  assert.match(markup, /data-cdt-column="number"/);
  assert.match(markup, /data-cdt-column="title"/);
  assert.match(markup, /data-cdt-column="path"/);
  assert.match(markup, /data-cdt-column="problem"/);
  assert.match(markup, /data-cdt-column="duration"/);
  assert.match(
    markup,
    /compact-data-table-header"><div role="columnheader" data-cdt-column="number"[^>]*>#<\/div><div role="columnheader" data-cdt-column="title"[^>]*>Track<\/div><div role="columnheader" data-cdt-column="path"[^>]*>File path<\/div><div data-cdt-column="problem"[^>]*aria-hidden="true"><\/div><div role="columnheader" data-cdt-column="duration"[^>]*>Length<\/div>/,
  );
  assert.match(markup, /class="album-track-table__secondary">Main Artist feat\. Guest</);
  assert.match(markup, /data-track-row-path="C:\/Music\/Artist\/Rarity\.mp3"/);
  assert.match(markup, /class="play-track-button album-track-table__play"/);
  assert.match(markup, /data-cdt-column="number"[^>]*><span class="album-track-table__number-play"><span class="album-track-table__number">1<\/span><button class="play-track-button/);
  assert.match(markup, /Artist\/Rarity\.mp3/);
  assert.doesNotMatch(markup, /non-album-type-cell/);
  assert.match(markup, /class="track-duration"[^>]*>4:05<\/span>/);
  assert.match(markup, /Total Length: 5:40/);

  const rarityOnly = context.buildNonAlbumTrackSectionsMarkup([{
    path: 'C:/Music/Artist/Rarity.mp3',
    title: 'Rare Song',
    artist: 'Main Artist',
    exception_type: 'Non-album rarity',
  }]);
  assert.match(rarityOnly, />Non-album rarity</);
  assert.doesNotMatch(rarityOnly, />Interviews</);

  const otherOnly = context.buildNonAlbumTrackSectionsMarkup([{
    path: 'C:/Music/Artist/Albumless.mp3',
    title: 'Albumless Song',
    artist: 'Main Artist',
    album: '',
    exception_type: '',
    reason_label: 'Unmarked',
  }]);
  assert.match(otherOnly, />Other</);
  assert.doesNotMatch(otherOnly, />Loose tracks</);

  const missingMetadata = context.buildNonAlbumTrackSectionsMarkup([{
    path: 'C:\\Music\\Unsorted\\Artist - Possible Song.flac',
    display_path: 'Unsorted\\Artist - Possible Song.flac',
    title: '',
    artist: '',
    exception_type: '',
  }]);
  assert.match(missingMetadata, /class="album-track-table__title">Artist - Possible Song\.flac/);
  assert.doesNotMatch(missingMetadata, /Unknown track|Unknown Artist/);
});

function createAlbumCard(viewport, options = {}) {
  const card = new FakeElement('album-card');
  card.offsetTop = Number(options.cardTop || 0);
  card.offsetLeft = Number(options.cardLeft || 0);
  card.offsetParent = viewport;
  card.offsetWidth = 240;
  card.offsetHeight = 360;
  const cover = new FakeElement('cover');
  cover.offsetTop = Number(options.coverTop || 0);
  cover.offsetLeft = Number(options.coverLeft || 0);
  cover.offsetWidth = Number(options.coverWidth || 220);
  cover.offsetHeight = Number(options.coverHeight || 220);
  cover.offsetParent = card;
  card.cover = cover;
  return card;
}

{
  const { context } = loadHelper();
  const imageElement = new FakeElement('cover-image');
  imageElement.dataset = {};
  imageElement.attributes = {
    'data-cover-path': 'C:/covers/local-primary-1.jpg',
    'data-remote-cover-url': 'https://images.example/primary-1-thumb.jpg',
  };
  imageElement.getAttribute = (name) => imageElement.attributes[name] || '';
  context.handleAlbumDisplayCoverImageError(imageElement);
  assert.equal(
    context.state.coverFailures.localDisplayPaths['C:/covers/local-primary-1.jpg'],
    true,
  );
  assert.equal(imageElement.dataset.remoteCoverTried, '1');
  assert.equal(imageElement.src, 'https://images.example/primary-1-thumb.jpg');
}

{
  const { context } = loadHelper();
  const imageElement = new FakeElement('cover-image');
  imageElement.dataset = {};
  imageElement.attributes = {
    'data-cover-path': 'C:/covers/local-primary-1.jpg',
  };
  imageElement.getAttribute = (name) => imageElement.attributes[name] || '';
  imageElement.closest = (selector) => (selector === '.album-card' ? new FakeElement('album-card') : null);
  let replacedWith = null;
  imageElement.replaceWith = (node) => {
    replacedWith = node;
  };
  context.handleAlbumDisplayCoverImageError(imageElement);
  assert.equal(
    context.state.coverFailures.localDisplayPaths['C:/covers/local-primary-1.jpg'],
    true,
  );
  assert.equal(replacedWith?.className, 'cover-placeholder cover-placeholder-blank');
  assert.equal(replacedWith?.attributes['aria-hidden'], 'true');
  assert.equal(replacedWith?.textContent, undefined);
}

async function flushLightboxPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

{
  const { context } = loadHelper();
  const imageElement = new FakeElement('album-cover-image');
  imageElement.complete = false;
  imageElement.naturalWidth = 0;

  assert.equal(context.markAlbumDisplayCoverImagePending(imageElement), true);
  assert.equal(imageElement.attributes['data-cover-visual-state'], 'pending');
  assert.equal(imageElement.attributes['aria-hidden'], 'true');
  assert.equal(context.handleAlbumDisplayCoverImageLoad(imageElement), false);
  assert.equal(imageElement.attributes['data-cover-visual-state'], 'pending');

  imageElement.complete = true;
  imageElement.naturalWidth = 480;
  assert.equal(context.handleAlbumDisplayCoverImageLoad(imageElement), true);
  assert.equal(imageElement.attributes['data-cover-visual-state'], 'ready');
  assert.equal(imageElement.attributes['aria-hidden'], undefined);
}

test('album cover load records native decode readiness and clears the prior source timestamp', async () => {
  const { context } = loadHelper();
  let resolveDecode;
  context.performance = { now: () => 4321.25 };
  const imageElement = new FakeElement('timed-album-cover-image');
  imageElement.complete = true;
  imageElement.naturalWidth = 480;
  imageElement.currentSrc = '/cover?path=current&size=480';
  imageElement.src = imageElement.currentSrc;
  imageElement.decode = () => new Promise((resolve) => {
    resolveDecode = resolve;
  });
  imageElement.setAttribute('data-cover-decoded-at-ms', '100');

  assert.equal(context.markAlbumDisplayCoverImagePending(imageElement), true);
  assert.equal(imageElement.getAttribute('data-cover-decoded-at-ms'), '');
  assert.equal(context.handleAlbumDisplayCoverImageLoad(imageElement), true);
  assert.equal(imageElement.getAttribute('data-cover-decoded-at-ms'), '');

  resolveDecode();
  await flushLightboxPromises();
  assert.equal(imageElement.getAttribute('data-cover-decoded-at-ms'), '4321.25');
});

test('album cover decode readiness ignores a stale source completion', async () => {
  const { context } = loadHelper();
  let resolveDecode;
  context.performance = { now: () => 9876.5 };
  const imageElement = new FakeElement('stale-timed-album-cover-image');
  imageElement.complete = true;
  imageElement.naturalWidth = 480;
  imageElement.currentSrc = '/cover?path=first&size=480';
  imageElement.src = imageElement.currentSrc;
  imageElement.decode = () => new Promise((resolve) => {
    resolveDecode = resolve;
  });

  assert.equal(context.handleAlbumDisplayCoverImageLoad(imageElement), true);
  imageElement.currentSrc = '/cover?path=second&size=480';
  imageElement.src = imageElement.currentSrc;
  resolveDecode();
  await flushLightboxPromises();
  assert.equal(imageElement.getAttribute('data-cover-decoded-at-ms'), '');
});

{
  const { context } = loadHelper();
  const imageElement = new FakeElement('track-modal-cover-image');
  const visual = new FakeElement('track-modal-cover-visual');
  const lightboxTrigger = new FakeElement('track-modal-cover-button');
  lightboxTrigger.disabled = false;
  lightboxTrigger.attributes = {
    'data-open-lightbox': '1',
    'data-cover-src': '/cover?path=missing',
    'data-cover-preview-src': '/cover?path=missing&size=480',
    'data-cover-alt': 'Album cover',
    'data-lightbox-gallery': 'visible',
  };
  lightboxTrigger.removeAttribute = (name) => {
    delete lightboxTrigger.attributes[name];
  };
  visual.classList.add('is-loading');
  visual.closest = (selector) => (selector === '[data-open-lightbox="1"]' ? lightboxTrigger : null);
  imageElement.closest = (selector) => (selector === '.track-modal-cover-visual' ? visual : null);
  imageElement.getAttribute = () => '';
  let finalPlaceholder = null;
  visual.replaceWith = (node) => {
    finalPlaceholder = node;
  };

  context.handleAlbumDisplayCoverImageError(imageElement);

  assert.equal(finalPlaceholder?.className, 'cover-placeholder');
  assert.equal(finalPlaceholder?.textContent, 'No cover art');
  assert.equal(lightboxTrigger.disabled, true);
  assert.equal(lightboxTrigger.attributes['data-open-lightbox'], undefined);
  assert.equal(lightboxTrigger.attributes['data-cover-src'], undefined);
  assert.equal(lightboxTrigger.attributes['data-cover-preview-src'], undefined);
  assert.equal(lightboxTrigger.attributes['data-cover-alt'], undefined);
  assert.equal(lightboxTrigger.attributes['data-lightbox-gallery'], undefined);
}

test('lightbox stays pending through decode and falls back when full-source decode fails', async () => {
  const { context } = loadHelper();
  const image = new FakeElement('image-lightbox-image');
  const loading = new FakeElement('image-lightbox-loading');
  image.src = '';
  image.alt = '';
  image.hidden = false;
  const removeImageAttribute = image.removeAttribute.bind(image);
  image.removeAttribute = (name) => {
    if (name === 'src') image.src = '';
    removeImageAttribute(name);
  };
  context.getLightboxElements = () => ({ image, loading, overlay: new FakeElement('image-lightbox') });
  context.setLightboxZoom = () => {};
  context.state.lightbox = {
    items: [],
    currentIndex: -1,
    loadToken: 0,
  };

  assert.equal(context.showStandaloneLightboxItem({
    src: '/cover?path=joseph&full=1',
    previewSrc: '/cover?path=joseph&size=480',
    remoteSrc: '/remote-cover?album=joseph',
    alt: 'Album cover for Joseph: Part One - The Dreamer',
  }), true);
  assert.equal(image.src, '');
  assert.equal(image.hidden, true);
  assert.equal(image.alt, '');
  assert.equal(image.getAttribute('aria-hidden'), 'true');
  assert.equal(loading.hidden, false, 'the accessible loading indicator should replace the hidden image');
  assert.equal(context.__preloaders[0].src, '/cover?path=joseph&full=1');

  context.__preloaders[0].onload();
  assert.equal(image.src, '', 'preloader load must not reveal the image before decode completes');
  assert.equal(image.hidden, true);
  assert.equal(loading.hidden, false);
  context.__preloaders[0].rejectDecode(new Error('full source decode failed'));
  await flushLightboxPromises();
  assert.equal(context.__preloaders[1].src, '/cover?path=joseph&size=480', 'a failed full source should preload the proven preview source');
  context.__preloaders[1].onload();
  assert.equal(image.hidden, true, 'preview must also remain pending through decode');
  context.__preloaders[1].resolveDecode();
  await flushLightboxPromises();
  assert.equal(image.src, '/cover?path=joseph&size=480');
  assert.equal(image.hidden, false);
  assert.equal(image.alt, 'Album cover for Joseph: Part One - The Dreamer');
  assert.equal(image.getAttribute('aria-hidden'), '');
  assert.equal(loading.hidden, true);
});

test('lightbox exhausts broken sources without a native broken image and retries full source on reopen', async () => {
  const { context } = loadHelper();
  const image = new FakeElement('image-lightbox-image');
  const loading = new FakeElement('image-lightbox-loading');
  image.src = '';
  const removeImageAttribute = image.removeAttribute.bind(image);
  image.removeAttribute = (name) => {
    if (name === 'src') image.src = '';
    removeImageAttribute(name);
  };
  context.getLightboxElements = () => ({ image, loading, overlay: new FakeElement('image-lightbox') });
  context.setLightboxZoom = () => {};
  context.state.lightbox = { items: [], currentIndex: -1, loadToken: 0 };

  context.showStandaloneLightboxItem({
    src: '/cover?path=joseph&full=1',
    previewSrc: '/cover?path=joseph&size=480',
    remoteSrc: '/remote-cover?album=joseph',
  });
  context.__preloaders[0].onerror();
  context.__preloaders[1].onerror();
  assert.equal(context.__preloaders[2].src, '/remote-cover?album=joseph', 'the remote source should remain the final image fallback');
  context.__preloaders[2].onerror();
  assert.equal(image.src, '');
  assert.equal(image.hidden, true, 'an exhausted fallback chain must not leave the browser broken-image icon visible');
  assert.equal(loading.hidden, true, 'terminal exhaustion must not leave a false loading status');

  assert.equal(context.showStandaloneLightboxItem({
    src: '/cover?path=joseph&full=1',
    previewSrc: '/cover?path=joseph&size=480',
    remoteSrc: '/remote-cover?album=joseph',
  }), true);
  assert.equal(
    context.__preloaders[3].src,
    '/cover?path=joseph&full=1',
    'each explicit reopen should retry the full source after a transient failure',
  );
  context.__preloaders[3].onload();
  assert.equal(image.hidden, true);
  context.__preloaders[3].resolveDecode();
  await flushLightboxPromises();
  assert.equal(image.src, '/cover?path=joseph&full=1');
  assert.equal(image.hidden, false);
  assert.equal(image.alt, 'Full-size album cover');
  assert.equal(image.getAttribute('aria-hidden'), '');
  assert.equal(loading.hidden, true);
});

test('stale navigation and close-like invalidation during decode cannot reveal an old source', async () => {
  const { context } = loadHelper();
  const image = new FakeElement('image-lightbox-image');
  const loading = new FakeElement('image-lightbox-loading');
  image.src = '';
  const removeImageAttribute = image.removeAttribute.bind(image);
  image.removeAttribute = (name) => {
    if (name === 'src') image.src = '';
    removeImageAttribute(name);
  };
  context.getLightboxElements = () => ({ image, loading, overlay: new FakeElement('image-lightbox') });
  context.setLightboxZoom = () => {};
  context.state.lightbox = { items: [], currentIndex: -1, loadToken: 0 };

  context.showStandaloneLightboxItem({ src: '/cover?path=old', previewSrc: '/cover?path=old&size=480' });
  const staleLoader = context.__preloaders[0];
  staleLoader.onload();
  assert.equal(image.hidden, true);
  context.showStandaloneLightboxItem({ src: '/cover?path=new', previewSrc: '/cover?path=new&size=480' });
  staleLoader.resolveDecode();
  await flushLightboxPromises();
  assert.equal(image.src, '', 'a queued event from the previous item must not commit after navigation');
  assert.equal(image.hidden, true);
  context.__preloaders[1].onload();
  context.__preloaders[1].resolveDecode();
  await flushLightboxPromises();
  assert.equal(image.src, '/cover?path=new');

  context.showStandaloneLightboxItem({ src: '/cover?path=closing' });
  const closingLoader = context.__preloaders[2];
  closingLoader.onload();
  context.state.lightbox.loadToken += 1;
  context.cancelActiveLightboxPreloader();
  loading.hidden = true;
  closingLoader.resolveDecode();
  await flushLightboxPromises();
  assert.equal(image.src, '', 'a decode completing after close invalidation must not reveal its source');
  assert.equal(image.hidden, true);
});

{
  const { context, viewport, glow, flushAnimationFrame } = loadHelper();
  const card = createAlbumCard(viewport, { cardTop: 20, cardLeft: 24, coverTop: 0, coverLeft: 0 });
  let positionCalls = 0;
  const originalPositioner = context.positionGalleryFocusGlow;
  context.positionGalleryFocusGlow = (...args) => {
    positionCalls += 1;
    return originalPositioner(...args);
  };

  context.scheduleGalleryFocusGlow(card);
  flushAnimationFrame();
  assert.equal(positionCalls, 1);
  assert.equal(glow.style.left, '134px');
  assert.equal(glow.style.top, '130px');
  assert.equal(context.state.gallery.focusGlowVisible, true);

  context.scheduleGalleryFocusGlow(card, { force: true });
  flushAnimationFrame();
  assert.equal(positionCalls, 1);
}

{
  const { context, viewport, glow, flushAnimationFrame } = loadHelper();
  const card = createAlbumCard(viewport, { cardTop: 20, cardLeft: 24, coverTop: 0, coverLeft: 0 });

  context.scheduleGalleryFocusGlow(card);
  flushAnimationFrame();
  assert.equal(glow.style.left, '134px');

  viewport.clientWidth = 980;
  context.scheduleGalleryFocusGlow(card, { force: true });
  flushAnimationFrame();
  assert.equal(glow.style.left, '134px');
  assert.equal(context.state.gallery.focusGlowKey, '134:130:220:220:980:620');
}

{
  const { context, viewport, flushAnimationFrame } = loadHelper();
  const card = createAlbumCard(viewport, { cardTop: 20, cardLeft: 24, coverTop: 0, coverLeft: 0 });
  let metricsCalls = 0;
  const originalMetrics = context.getGalleryFocusGlowMetrics;
  context.getGalleryFocusGlowMetrics = (...args) => {
    metricsCalls += 1;
    return originalMetrics(...args);
  };

  context.scheduleGalleryFocusGlow(card);
  flushAnimationFrame();
  assert.equal(metricsCalls, 1);
}

{
  const { context } = loadHelper();
  const url = context.buildCoverUrl('C:/covers/primary-1.jpg', { size: 320 });
  assert.equal(
    url,
    '/cover?path=C%3A%2Fcovers%2Fprimary-1.jpg&size=320&v=epoch-6',
  );
  context.__now += 300000;
  assert.equal(
    context.buildCoverUrl('C:/covers/primary-1.jpg', { size: 320 }),
    url,
    'a cover URL must stay pinned for the app session even when the revalidation epoch rolls over',
  );
}

test('buildCoverUrl keeps one server process cover identity stable across browser epochs', () => {
  const buildUrlForProcess = (coverCacheToken, now) => {
    const { context } = loadHelper();
    context.__now = now;
    context.window = context;
    context.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = {
      bootstrap: { coverCacheToken },
    };
    return context.buildCoverUrl('C:/covers/primary-1.jpg', { size: 320 });
  };

  const firstProcessUrl = buildUrlForProcess('process-a', 1800000);
  const secondProcessUrl = buildUrlForProcess('process-b', 1800000);
  const repeatedFirstProcessUrl = buildUrlForProcess('process-a', 2100000);
  const readVersionToken = (url) => new URL(url, 'http://127.0.0.1').searchParams.get('v');

  assert.equal(readVersionToken(firstProcessUrl), 'process-process-a');
  assert.equal(readVersionToken(secondProcessUrl), 'process-process-b');
  assert.notEqual(secondProcessUrl, firstProcessUrl);
  assert.equal(repeatedFirstProcessUrl, firstProcessUrl);
});

test('album display cover rejects a canonical preview URL for a different local cover path', () => {
  const { context } = loadHelper();
  const stalePreviewUrl = '/cover?path=C%3A%2Fmusic%2FKaipa%2FArt%2Fback.jpg&size=480&v=old-revision';

  const url = context.buildAlbumDisplayCoverUrl({
    key: 'kaipa::kaipa::1975',
    name: 'Kaipa',
    album_artist: 'Kaipa',
    cover_path: 'C:/music/Kaipa/cover.jpg',
    cover_preview_url: stalePreviewUrl,
  });
  const parsed = new URL(url, 'http://127.0.0.1');

  assert.notEqual(url, stalePreviewUrl);
  assert.equal(parsed.pathname, '/cover');
  assert.equal(parsed.searchParams.get('path'), 'C:/music/Kaipa/cover.jpg');
});

test('album display cover rejects an older preview revision for the current local cover path', () => {
  const { context } = loadHelper();
  const stalePreviewUrl = '/cover?path=C%3A%2Fmusic%2FKaipa%2Fcover.jpg&size=480&v=old-revision';

  const url = context.buildAlbumDisplayCoverUrl({
    key: 'kaipa::kaipa::1975',
    name: 'Kaipa',
    album_artist: 'Kaipa',
    cover_path: 'C:/music/Kaipa/cover.jpg',
    cover_preview_url: stalePreviewUrl,
    cover_revision: 'selected-front-revision',
  });
  const parsed = new URL(url, 'http://127.0.0.1');

  assert.notEqual(url, stalePreviewUrl);
  assert.equal(parsed.searchParams.get('path'), 'C:/music/Kaipa/cover.jpg');
  assert.equal(parsed.searchParams.get('v'), 'selected-front-revision');
});

test('markAlbumCoverPathsFresh preserves authoritative album and track cover revisions', () => {
  const { context } = loadHelper();
  const album = {
    key: 'kaipa::kaipa::1975',
    name: 'Kaipa',
    album_artist: 'Kaipa',
    cover_path: 'C:/music/Kaipa/cover.jpg',
    cover_revision: 'authoritative-album-revision',
    tracks: [{
      cover_path: 'C:/music/Kaipa/track-cover.jpg',
      cover_revision: 'authoritative-track-revision',
    }],
  };

  context.markAlbumCoverPathsFresh([album]);

  assert.equal(
    context.state.coverRefreshTokens[album.cover_path],
    'authoritative-album-revision',
  );
  assert.equal(
    context.state.coverRefreshTokens[album.tracks[0].cover_path],
    'authoritative-track-revision',
  );
  assert.equal(
    new URL(context.buildAlbumDisplayCoverUrl(album), 'http://127.0.0.1').searchParams.get('v'),
    'authoritative-album-revision',
  );
  assert.equal(
    new URL(context.buildAlbumLightboxCoverUrl(album), 'http://127.0.0.1').searchParams.get('v'),
    'authoritative-album-revision',
  );
});

test('markAlbumCoverPathsFresh keeps transient refresh tokens when revisions are absent', () => {
  const { context } = loadHelper();
  const album = {
    cover_path: 'C:/music/Kaipa/cover.jpg',
    tracks: [{ cover_path: 'C:/music/Kaipa/track-cover.jpg' }],
  };

  context.markAlbumCoverPathsFresh([album]);

  assert.equal(context.state.coverRefreshTokens[album.cover_path], context.__now);
  assert.equal(context.state.coverRefreshTokens[album.tracks[0].cover_path], context.__now);
});

{
  const { context } = loadHelper();
  const url = context.buildAlbumDisplayCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/primary-1.jpg',
  });
  assert.equal(
    url,
    '/cover?path=C%3A%2Fcovers%2Fprimary-1.jpg&size=480&v=epoch-6',
  );
}

{
  const { context } = loadHelper();
  const canonicalPreviewUrl = '/cover?path=C%3A%2Fcovers%2Fprimary-1.jpg&size=480&v=epoch-6';
  const url = context.buildAlbumDisplayCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/primary-1.jpg',
    cover_preview_url: canonicalPreviewUrl,
  });
  assert.equal(
    url,
    canonicalPreviewUrl,
    'the runtime scheduler must preserve the server-authored production cover identity',
  );
  assert.equal(
    context.buildAlbumDisplayCoverUrl({
      key: 'primary-1',
      name: 'Primary One',
      album_artist: 'Howard Shore',
      cover_path: 'C:/covers/primary-1.jpg',
    }),
    canonicalPreviewUrl,
    'full hydration must retain the preview identity after replacing the album object',
  );
  context.markAlbumCoverPathsFresh([{
    cover_path: 'C:/covers/primary-1.jpg',
    tracks: [],
  }]);
  assert.notEqual(
    context.buildAlbumDisplayCoverUrl({
      key: 'primary-1',
      name: 'Primary One',
      album_artist: 'Howard Shore',
      cover_path: 'C:/covers/primary-1.jpg',
      cover_preview_url: canonicalPreviewUrl,
    }),
    canonicalPreviewUrl,
    'an explicit cover refresh must supersede the startup epoch identity',
  );
}

{
  const { context } = loadHelper();
  const url = context.buildAlbumDisplayCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/primary-1.jpg',
    preview_only: true,
  });
  assert.equal(
    url,
    '/cover?path=C%3A%2Fcovers%2Fprimary-1.jpg&size=480&v=epoch-6',
  );
}

{
  const { context } = loadHelper();
  const url = context.buildAlbumDisplayCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/local-primary-1.jpg',
    remote_cover_url: 'https://images.example/primary-1.jpg',
    remote_cover_thumbnail_url: 'https://images.example/primary-1-thumb.jpg',
  });
  assert.equal(
    url,
    '/cover?path=C%3A%2Fcovers%2Flocal-primary-1.jpg&size=480&v=epoch-6',
  );
}

{
  const { context } = loadHelper();
  context.rememberFailedLocalDisplayCoverPath('C:/covers/local-primary-1.jpg');
  const url = context.buildAlbumDisplayCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/local-primary-1.jpg',
  });
  assert.equal(url, '');
}

{
  const { context } = loadHelper();
  context.buildRemoteCoverLookupImageUrl = (url) => `remote:${url}`;
  context.rememberFailedLocalDisplayCoverPath('C:/covers/local-primary-1.jpg');
  const url = context.buildAlbumDisplayCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/local-primary-1.jpg',
    remote_cover_url: 'https://images.example/primary-1.jpg',
    remote_cover_thumbnail_url: 'https://images.example/primary-1-thumb.jpg',
  });
  assert.equal(url, 'remote:https://images.example/primary-1-thumb.jpg');
}

{
  const { context } = loadHelper();
  context.buildRemoteCoverLookupImageUrl = (url) => `remote:${url}`;
  context.rememberFailedLocalDisplayCoverPath('C:/covers/local-primary-1.jpg');
  const url = context.buildAlbumDisplayCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/local-primary-1.jpg',
    remote_cover_thumbnail_url: 'https://images.example/primary-1-thumb.jpg',
  });
  assert.equal(url, 'remote:https://images.example/primary-1-thumb.jpg');
}

{
  const { context } = loadHelper();
  context.rememberFailedLocalDisplayCoverPath('C:/covers/local-primary-1.jpg');
  assert.equal(
    context.albumHasDisplayCover({
      key: 'primary-1',
      name: 'Primary One',
      album_artist: 'Howard Shore',
      cover_path: 'C:/covers/local-primary-1.jpg',
      remote_cover_url: 'https://images.example/primary-1.jpg',
    }),
    true,
  );
}

{
  const { context } = loadHelper();
  context.rememberFailedLocalDisplayCoverPath('C:/covers/local-primary-1.jpg');
  assert.equal(
    context.albumHasDisplayCover({
      key: 'primary-1',
      name: 'Primary One',
      album_artist: 'Howard Shore',
      cover_path: 'C:/covers/local-primary-1.jpg',
      remote_cover_thumbnail_url: 'https://images.example/primary-1-thumb.jpg',
    }),
    true,
  );
}

{
  const { context } = loadHelper();
  context.rememberFailedLocalDisplayCoverPath('C:/covers/local-primary-1.jpg');
  context.markAlbumCoverPathsFresh([
    {
      cover_path: 'C:/covers/local-primary-1.jpg',
      tracks: [],
    },
  ]);
  const url = context.buildAlbumDisplayCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/local-primary-1.jpg',
  });
  assert.match(
    url,
    /^\/cover\?path=C%3A%2Fcovers%2Flocal-primary-1\.jpg&size=480(?:&v=\d+)?$/,
  );
}

{
  const { context } = loadHelper();
  const url = context.buildAlbumLightboxCoverUrl({
    key: 'primary-1',
    name: 'Primary One',
    album_artist: 'Howard Shore',
    cover_path: 'C:/covers/local-primary-1.jpg',
    remote_cover_url: 'https://images.example/primary-1.jpg',
    remote_cover_thumbnail_url: 'https://images.example/primary-1-thumb.jpg',
  });
  assert.equal(
    url,
    '/cover?path=C%3A%2Fcovers%2Flocal-primary-1.jpg&v=epoch-6',
  );
}

{
  const { context } = loadHelper();
  context.state.view.primary_artist_groups = [
    {
      artist: 'Howard Shore',
      albums: [
        { key: 'primary-1', name: 'Primary One', album_artist: 'Howard Shore', cover_path: 'C:/covers/primary-1.jpg' },
      ],
    },
  ];
  context.state.view.family_artist_groups = [
    {
      artist: 'Annie Lennox',
      albums: [
        { key: 'family-1', name: 'Family One', album_artist: 'Annie Lennox', cover_path: 'C:/covers/family-1.jpg' },
      ],
    },
  ];
  context.state.view.artist_groups = [
    {
      artist: 'Howard Shore',
      albums: [
        { key: 'primary-1', name: 'Primary One', album_artist: 'Howard Shore', cover_path: 'C:/covers/primary-1.jpg' },
      ],
    },
    {
      artist: 'Annie Lennox',
      albums: [
        { key: 'family-1', name: 'Family One', album_artist: 'Annie Lennox', cover_path: 'C:/covers/family-1.jpg' },
      ],
    },
    {
      artist: 'Unrelated Match',
      albums: [
        { key: 'other-1', name: 'Other One', album_artist: 'Unrelated Match', cover_path: 'C:/covers/other-1.jpg' },
      ],
    },
  ];

  const items = context.getLightboxGalleryItems();
  assert.equal(
    Array.from(items, (item) => item.key).join('|'),
    'primary-1::Primary One::Howard Shore|family-1::Family One::Annie Lennox',
  );
  assert.equal(items[0].src, '/cover?path=C%3A%2Fcovers%2Fprimary-1.jpg&v=epoch-6');
}

test('legacy Gallery options no longer owns source switches or New Arrivals navigation', () => {
  const { context } = loadHelper();
  if (typeof context.renderGalleryOptionsMenu === 'function') {
    context.renderGalleryOptionsMenu();
    const legacyMenu = context.document.getElementById('gallery-options-menu');
    assert.doesNotMatch(legacyMenu?.innerHTML || '', /data-gallery-category-toggle=/);
    assert.doesNotMatch(legacyMenu?.innerHTML || '', /data-open-(?:new-arrivals|main-gallery)=/);
  }
  assert.doesNotMatch(helperSource, /data-open-(?:new-arrivals|main-gallery)=/);
  assert.doesNotMatch(bootstrapGalleryHandlersSource, /data-open-(?:new-arrivals|main-gallery)=/);
  assert.doesNotMatch(bootstrapGalleryHandlersSource, /data-gallery-category-toggle/);

  vm.runInContext(galleryMainComponentsSource, context, { filename: galleryMainComponentsPath });
  const switches = ['main_library', 'new_arrivals', 'hoard'].map((source) => (
    context.buildGallerySwitchHtml({ id: `source-${source}`, source, label: source, checked: true })
  )).join('');
  assert.equal((switches.match(/role="switch"/g) || []).length, 3);
  assert.match(switches, /data-gallery-source="main_library"/);
  assert.match(switches, /data-gallery-source="new_arrivals"/);
  assert.match(switches, /data-gallery-source="hoard"/);
  assert.doesNotMatch(switches, /Open New Arrivals/);
});

{
  const { context } = loadHelper();
  context.showAlbumCardContextMenu(12, 24, {
    key: 'arrival-album',
    move_availability: {
      available_actions: ['move_to_hoard', 'move_to_library'],
      actions: {
        move_to_hoard: { available: true, target_category: 'hoard' },
        move_to_library: { available: true, target_category: 'main_library' },
      },
    },
  });
  const menu = context.document.getElementById('album-card-context-menu');
  assert.match(menu.innerHTML, /data-album-card-action="move_to_hoard"/);
  assert.match(menu.innerHTML, /Move to Hoard/);
  assert.match(menu.innerHTML, /data-album-card-action="move_to_library"/);
  assert.match(menu.innerHTML, /Move to Main Library/);
}
