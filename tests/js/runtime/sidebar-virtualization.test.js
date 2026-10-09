const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const template = fs.readFileSync(
  path.join(repoRoot, 'music_app', 'templates', 'components', 'navigation-tree-item.html'),
  'utf8',
);
const sources = [
  'music_app/static/js/navigation-tree.js',
  'music_app/static/js/runtime/view-state-helpers.js',
  'music_app/static/js/runtime/browser-navigation-helpers.js',
  'music_app/static/js/runtime/render-markup-helpers.js',
].map(relativePath => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));

function loadHelpers() {
  const context = {
    URL,
    URLSearchParams,
    document: {
      getElementById(id) {
        return id === 'navigation-tree-item-template' ? { textContent: template } : null;
      },
    },
    state: { view: {} },
    window: { location: { origin: 'http://localhost:5000' } },
  };
  vm.createContext(context);
  sources.forEach(source => vm.runInContext(source, context));
  return context;
}

function artists(count) {
  return Array.from({ length: count }, (_, index) => ({
    artist: `Artist ${String(index).padStart(4, '0')}`,
    artist_display: `Artist ${String(index).padStart(4, '0')}`,
    count: index + 1,
  }));
}

test('large artist inventories render a bounded selection-aware window', () => {
  const context = loadHelpers();
  const source = artists(6000);
  const selectedArtist = source[4321].artist;
  const windowRange = context.resolveSidebarVirtualWindow(source, {
    selectedArtist,
    forceSelected: true,
  });
  const html = context.buildSidebarHtml({
    surface: { active: 'albums' },
    artist_count: source.length,
    selected_artist: selectedArtist,
    show_all_artists_sidebar_link: true,
  }, source, { virtualWindow: windowRange });

  assert.equal(windowRange.virtualized, true);
  assert.equal(windowRange.end - windowRange.start, 160);
  assert.ok(windowRange.start <= 4321 && windowRange.end > 4321);
  assert.equal((html.match(/data-sidebar-artist=/g) || []).length, 160);
  assert.equal((html.match(/artist-link active/g) || []).length, 1);
  assert.match(html, /data-sidebar-artist="Artist 4321"/);
  assert.match(html, /data-sidebar-virtual-spacer="before"/);
  assert.match(html, /data-sidebar-virtual-spacer="after"/);
  assert.match(html, />6000<\/span>/);
});

test('scroll position advances the artist window while preserving canonical order', () => {
  const context = loadHelpers();
  const source = artists(6000);
  const first = context.resolveSidebarVirtualWindow(source, { scrollTop: 0, viewportHeight: 720 });
  const later = context.resolveSidebarVirtualWindow(source, { scrollTop: 47000, viewportHeight: 720 });
  const html = context.buildSidebarHtml({ surface: { active: 'albums' } }, source, {
    virtualWindow: later,
  });
  const renderedIndexes = [...html.matchAll(/data-sidebar-virtual-index="(\d+)"/g)]
    .map(match => Number(match[1]));

  assert.equal(first.start, 0);
  assert.ok(later.start > first.start);
  assert.equal(later.end - later.start, 160);
  assert.deepEqual(renderedIndexes, Array.from(
    { length: later.end - later.start },
    (_, offset) => later.start + offset,
  ));
});

test('nearby scroll events retain the mounted artist window', () => {
  const context = loadHelpers();
  const source = artists(6000);
  const current = context.resolveSidebarVirtualWindow(source, {
    scrollTop: 47000,
    viewportHeight: 720,
  });
  const nearby = context.resolveSidebarVirtualWindow(source, {
    scrollTop: 47047,
    viewportHeight: 720,
    previousWindow: current,
  });

  assert.deepEqual(
    { start: nearby.start, end: nearby.end },
    { start: current.start, end: current.end },
  );
});

test('deep windows keep exact spacer geometry for long artist names', () => {
  const context = loadHelpers();
  const source = artists(6000);
  source[4321].artist = 'A very long artist name that remains complete for assistive technology';
  source[4321].artist_display = source[4321].artist;
  const windowRange = context.resolveSidebarVirtualWindow(source, {
    selectedArtist: source[4321].artist,
    forceSelected: true,
  });
  const html = context.buildSidebarHtml({
    surface: { active: 'albums' },
    selected_artist: source[4321].artist,
  }, source, { virtualWindow: windowRange });
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'base-layout.css'),
    'utf8',
  );

 assert.match(css, /\.artist-list\[data-sidebar-virtualized='true'\] \.artist-link\s*\{[^}]*height:\s*41px/s);
 assert.match(css, /\.artist-list\[data-sidebar-virtualized='true'\] \.artist-link \.artist-name-label\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s);
 assert.doesNotMatch(css, /(?<!virtualized='true'\] )\.artist-link\s*\{[^}]*height:\s*41px/s);
 assert.match(css, /\.artist-link \.artist-name-label\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(html, new RegExp(`data-sidebar-virtual-spacer="before"[^>]*height:${windowRange.start * 47 - 6}px`));
  assert.match(html, new RegExp(`data-sidebar-virtual-spacer="after"[^>]*height:${(source.length - windowRange.end) * 47 - 6}px`));
  assert.match(html, /A very long artist name that remains complete for assistive technology/);
  assert.equal((html.match(/artist-link active/g) || []).length, 1);
});

test('small artist inventories retain full markup without virtual spacers', () => {
  const context = loadHelpers();
  const source = artists(200);
  const windowRange = context.resolveSidebarVirtualWindow(source, {
    scrollTop: 47000,
    viewportHeight: 720,
  });
  const html = context.buildSidebarHtml({ surface: { active: 'albums' } }, source, {
    virtualWindow: windowRange,
  });

  assert.equal(windowRange.virtualized, false);
  assert.equal((html.match(/data-sidebar-artist=/g) || []).length, source.length);
  assert.doesNotMatch(html, /data-sidebar-virtual-spacer=/);
});

test('sidebar scrolling advances the mounted window without changing scroll position', () => {
  const source = artists(6000);
  const coreSource = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'core-state-and-helpers.js'),
    'utf8',
  );
  class FakeElement {
    constructor() {
      this.dataset = {};
      this.listeners = new Map();
      this.scrollTop = 0;
      this.scrollHeight = 300000;
      this.clientHeight = 720;
      this.hidden = false;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    getBoundingClientRect() { return { top: 0, bottom: 720, width: 240, height: 720 }; }
    querySelector() { return null; }
  }
  const sidebarList = new FakeElement();
  const scrollContainer = new FakeElement();
  sidebarList.closest = () => scrollContainer;
  const ranges = [];
  let signatureCalls = 0;
  const context = {
    appBootstrap: { getInitialView: () => ({ artists_sidebar: source }) },
    document: {
      getElementById: id => id === 'sidebar-list' ? sidebarList : null,
      querySelector: () => null,
      activeElement: null,
    },
    window: { location: { href: 'http://localhost:5000/', origin: 'http://localhost:5000' } },
    HTMLElement: FakeElement,
    URL,
    Intl,
    Map,
    Set,
    console,
  };
  vm.createContext(context);
  vm.runInContext(sources.at(-1), context);
  vm.runInContext(`${coreSource}\n;globalThis.__state = state; globalThis.__renderSidebar = renderSidebar;`, context);
  context.resolveSidebarArtists = () => source;
  context.resolveViewSurface = () => 'albums';
  context.buildSidebarHtml = (_view, _artists, options) => {
    ranges.push({ ...options.virtualWindow });
    return '<span></span>';
  };
  context.buildSidebarStructureSignature = (_artists, options) => {
    signatureCalls += 1;
    return `${options.virtualWindow.start}:${options.virtualWindow.end}`;
  };
  context.applySidebarSelectionMarkup = () => {};
  context.scheduleBrowserAnimationFrame = callback => { callback(); return 1; };

  context.__renderSidebar();
  assert.equal(ranges.at(-1).start, 0);
  assert.equal(typeof scrollContainer.listeners.get('scroll'), 'function');
  scrollContainer.scrollTop = 47000;
  scrollContainer.listeners.get('scroll')();
  assert.ok(ranges.at(-1).start > 0);
  assert.equal(scrollContainer.scrollTop, 47000);
  const renderCount = ranges.length;
  const signatureCount = signatureCalls;
  scrollContainer.scrollTop += 47;
  scrollContainer.listeners.get('scroll')();
  assert.equal(ranges.length, renderCount, 'retained windows must not rebuild or rescan the sidebar');
  assert.equal(signatureCalls, signatureCount, 'retained windows must not recompute the full structure signature');
});

test('window replacement restores keyboard focus to the same artist link', () => {
  const coreSource = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'core-state-and-helpers.js'),
    'utf8',
  );
  const original = {
    closest: selector => selector === '.artist-link' ? original : null,
    getAttribute: name => name === 'data-sidebar-artist' ? 'Focused Artist' : null,
  };
  let focused = false;
  const replacement = {
    getAttribute: name => name === 'data-sidebar-artist' ? 'Focused Artist' : null,
    focus: options => { focused = options?.preventScroll === true; },
  };
  const sidebarList = {
    contains: element => element === original,
    querySelector: () => null,
    querySelectorAll: () => [replacement],
  };
  const context = {
    appBootstrap: { getInitialView: () => ({}) },
    document: { activeElement: original },
    window: { location: { href: 'http://localhost:5000/', origin: 'http://localhost:5000' } },
    URL,
    Intl,
    Map,
    Set,
    console,
  };
  vm.createContext(context);
  vm.runInContext(`${coreSource}\n;globalThis.__capture = captureSidebarFocus; globalThis.__restore = restoreSidebarFocus;`, context);

  const focusIdentity = context.__capture(sidebarList);
  context.__restore(sidebarList, focusIdentity);
  assert.equal(focused, true);
});
