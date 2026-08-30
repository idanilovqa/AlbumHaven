const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const responseStateHelperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'response-state-helpers.js');
const virtualGridHelperPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'virtual-artist-grid.js');
const helperSources = [
  { path: responseStateHelperPath, source: fs.readFileSync(responseStateHelperPath, 'utf8') },
  { path: virtualGridHelperPath, source: fs.readFileSync(virtualGridHelperPath, 'utf8') },
];

function createRuntimeContext() {
  class FakeElement {}

  class FakeRenderedNode {
    constructor(tagName, html = '') {
      this.tagName = tagName;
      this.innerHTML = html;
      this.dataset = {};
      this.parentNode = null;
    }

    remove() {
      if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
        this.parentNode.removeChild(this);
      }
    }

    getAttribute(name) {
      if (name === 'data-virtual-section-key') return this.dataset.virtualSectionKey || '';
      return '';
    }

    setAttribute(name, value) {
      if (name === 'data-virtual-section-key') this.dataset.virtualSectionKey = String(value || '');
    }

    isEqualNode(other) {
      return Boolean(
        other
        && this.tagName === other.tagName
        && this.innerHTML === other.innerHTML
      );
    }
  }

  class FakeScratchElement {
    constructor() {
      this._innerHTML = '';
      this.firstElementChild = null;
    }

    set innerHTML(value) {
      this._innerHTML = String(value || '');
      const normalized = this._innerHTML.trim();
      if (!normalized) {
        this.firstElementChild = null;
        return;
      }
      const tagMatch = normalized.match(/^<([a-z0-9-]+)/i);
      this.firstElementChild = new FakeRenderedNode(tagMatch ? tagMatch[1].toLowerCase() : 'div', normalized);
    }

    get innerHTML() {
      return this._innerHTML;
    }
  }

  const scrollEl = {
    clientWidth: 980,
    clientHeight: 640,
    scrollTop: 0,
    scrollLeft: 0,
    addEventListener() {},
    removeEventListener() {},
  };
  const containerEl = {
    innerHTML: '',
    children: [],
    querySelectorAll() {
      return [];
    },
    syncInnerHtml() {
      this.innerHTML = this.children.map((child) => child.innerHTML || '').join('');
    },
    appendChild(child) {
      const existingIndex = this.children.indexOf(child);
      if (existingIndex >= 0) {
        this.children.splice(existingIndex, 1);
      }
      child.parentNode = this;
      this.children.push(child);
      this.syncInnerHtml();
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) {
        this.children.splice(index, 1);
        child.parentNode = null;
      }
      this.syncInnerHtml();
      return child;
    },
  };
  const topSpacerEl = { style: { height: '' } };
  const bottomSpacerEl = { style: { height: '' } };
  const elementsById = {
    'albums-scroll': scrollEl,
    'artist-groups': containerEl,
    'albums-spacer-top': topSpacerEl,
    'albums-spacer-bottom': bottomSpacerEl,
  };

  const context = {
    Map,
    Math,
    HTMLElement: FakeElement,
    appBootstrap: {
      getInitialView() {
        return {
          artist_groups: [],
          primary_artist_groups: [],
          family_artist_groups: [],
          artists_sidebar: [],
          related_artists: [],
          album_count: 0,
          artist_count: 0,
          query: '',
          selected_artist: '',
          all_artists_active: false,
          show_all_artists_sidebar_link: true,
          related_filter_artists: [],
          primary_filter_active: false,
          gallery_scope: 'all',
          visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
          music_dir: '',
          app_name: 'Album Haven',
          app_version: '0.0.0-test',
          ignored_version_keys: [],
          manual_version_links: {},
          non_album_tracks: [],
          non_album_exception_values: [],
          initial_view_partial: false,
        };
      },
      getBootstrap() {
        return {};
      },
    },
    state: {
      view: {},
      status: {},
      ui: {
        pendingSidebarRevealArtist: '',
        pendingSidebarSelectedArtist: '',
        pendingSidebarAllArtistsActive: false,
        preSearchView: null,
      },
      gallery: {
        albumIndex: new Map(),
        relatedFilterBaseArtist: '',
        relatedFilterBaseQuery: '',
        relatedFilterBasePrimaryGroups: [],
        relatedFilterBaseFamilyGroups: [],
      },
    },
    document: {
      getElementById(id) {
        return elementsById[id] || null;
      },
      createElement() {
        return new FakeScratchElement();
      },
      querySelectorAll() {
        return [];
      },
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
    },
    scheduleBrowserAnimationFrame(callback) {
      if (typeof callback === 'function') callback();
      return 1;
    },
    cancelBrowserAnimationFrame() {},
    scheduleBrowserTimeout(callback) {
      if (typeof callback === 'function') callback();
      return 1;
    },
    clearBrowserTimeout() {},
    escapeHtml(value) {
      return String(value ?? '');
    },
    renderStars(rating) {
      return `stars:${rating}`;
    },
    formatAlbumDuration(seconds) {
      return `${Number(seconds || 0)}s`;
    },
    buildAlbumDisplayCoverUrl(album) {
      return `/covers/${encodeURIComponent(String(album?.name || ''))}`;
    },
    albumHasDisplayCover() {
      return false;
    },
    buildDisplayGroups(groups) {
      return Array.isArray(groups) ? groups : [];
    },
    getAlbumPathSignature(album) {
      return String(album?.pathSignature || '');
    },
    groupAlbumTracks(tracks) {
      return {
        groups: [{ tracks: Array.isArray(tracks) ? tracks : [] }],
      };
    },
  };

  vm.createContext(context);
  helperSources.forEach(({ path: helperPath, source }) => {
    vm.runInContext(source, context, { filename: helperPath });
  });
  return { context, containerEl };
}

function createAlbum(artist, name, keySuffix) {
  return {
    key: `${artist.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${keySuffix}`,
    name,
    album_artist: artist,
    artists: [artist],
    album_rating: 7,
    tracks: [{ duration_seconds: 210 }],
    total_duration_seconds: 210,
  };
}

function createArtistGroup(artist, albumCount, namePrefix) {
  return {
    artist,
    artist_display: artist,
    albums: Array.from({ length: albumCount }, (_value, index) => (
      createAlbum(artist, `${namePrefix} ${index + 1}`, index + 1)
    )),
  };
}

function buildTreeSelectionPayload(selectedArtist, familyArtists) {
  const primaryGroup = createArtistGroup(selectedArtist, 4, `${selectedArtist} Release`);
  const familyGroups = familyArtists
    .filter((artist) => artist !== selectedArtist)
    .map((artist) => createArtistGroup(artist, 3, `${artist} Release`));
  const artistGroups = [primaryGroup, ...familyGroups];
  return {
    query: 'Neal Morse',
    selected_artist: selectedArtist,
    primary_artist_groups: [primaryGroup],
    family_artist_groups: familyGroups,
    artist_groups: artistGroups,
    related_artists: familyGroups.map((group) => group.artist),
    related_filter_artists: [],
    primary_filter_active: false,
    gallery_scope: 'all',
    visible_library_categories: ['main_library', 'hoard', 'new_arrivals'],
    album_count: artistGroups.reduce((sum, group) => sum + group.albums.length, 0),
    artist_count: artistGroups.length,
  };
}

{
  const expectedGalleryRerenderMs = 120;
  const { context, containerEl } = createRuntimeContext();
  const familyArtists = [
    'Neal Morse',
    'Cosmic Cathedral',
    'Transatlantic',
    'Mike Portnoy',
    'Randy George',
    'Bill Hubauer',
    'Phil Keaggy',
    'Roine Stolt',
    'Flying Colors',
    'The Resonance',
    'John Petrucci',
    'Jordan Rudess',
    'Steve Hackett',
    'Dave Meros',
    'Eric Gillette',
    'Ted Leonard',
    'Casey McPherson',
    'Rich Mouser',
  ];
  const measuredPayloads = [
    buildTreeSelectionPayload('Cosmic Cathedral', familyArtists),
    buildTreeSelectionPayload('Transatlantic', familyArtists),
  ];

  const warmPayload = measuredPayloads[0];
  context.applyViewPayload(warmPayload, { trackSidebarReveal: false });
  context.renderArtistGroups();
  assert.match(containerEl.innerHTML, /Cosmic Cathedral/);
  assert.match(containerEl.innerHTML, /Primary Artist/);
  assert.ok(Array.isArray(context.state.view.family_artist_groups));
  assert.ok(context.state.view.family_artist_groups.length > 0);

  const elapsedMs = [];
  for (let index = 0; index < 8; index += 1) {
    const payload = measuredPayloads[index % measuredPayloads.length];
    const startedAt = process.hrtime.bigint();
    context.applyViewPayload(payload, { trackSidebarReveal: false });
    context.renderArtistGroups();
    elapsedMs.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }

  assert.ok(
    Math.max(...elapsedMs) < expectedGalleryRerenderMs,
    `expected gallery rerenders under ${expectedGalleryRerenderMs}ms, got ${elapsedMs.map((value) => value.toFixed(2)).join(', ')}`,
  );
}
