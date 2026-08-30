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
  'core-state-and-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const responseHelperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'response-state-helpers.js',
);
const responseHelperSource = fs.readFileSync(responseHelperPath, 'utf8');

class FakeElement {
  constructor(rect = {}) {
    this.rect = rect;
    this.dataset = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.offsetHeight = Number(rect.height || 0);
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

test('a selected-artist payload change reveals a fully offscreen row within the player-safe viewport', () => {
  const activeLink = new FakeElement({
    top: 1040,
    bottom: 1080,
    height: 40,
  });
  const scrollContainer = new FakeElement({
    top: 0,
    bottom: 800,
    height: 800,
  });
  const initialScrollTop = 900;
  scrollContainer.scrollTop = initialScrollTop;
  scrollContainer.scrollHeight = 3000;
  scrollContainer.clientHeight = 800;
  const player = new FakeElement({
    top: 720,
    bottom: 800,
    height: 80,
  });
  const sidebarList = new FakeElement();
  sidebarList.dataset.sidebarStructureSignature = 'stable-sidebar';
  sidebarList.querySelector = () => activeLink;
  sidebarList.closest = () => scrollContainer;

  const context = {
    appBootstrap: {
      getInitialView() {
        return {
          query: '',
          selected_artist: '',
          artists_sidebar: [{ artist: 'Bottom Artist', count: 1 }],
          show_all_artists_sidebar_link: false,
        };
      },
    },
    window: {
      location: {
        href: 'http://localhost/?artist=Bottom+Artist',
        origin: 'http://localhost',
      },
    },
    document: {
      getElementById(id) {
        return id === 'sidebar-list' ? sidebarList : null;
      },
      querySelector(selector) {
        return selector === '.global-player' ? player : null;
      },
    },
    HTMLElement: FakeElement,
    URL,
    Intl,
    Map,
    Set,
    console,
  };
  vm.createContext(context);
  vm.runInContext(`${helperSource}
${responseHelperSource}
globalThis.__testState = state;
globalThis.__testRenderSidebar = renderSidebar;
globalThis.__testApplyViewPayload = applyViewPayload;`, context);
  context.resolveSidebarArtists = () => context.__testState.view.artists_sidebar;
  context.buildSidebarStructureSignature = () => 'stable-sidebar';
  context.applySidebarSelectionMarkup = () => {};
  context.resolveViewSurface = () => 'albums';
  context.scheduleBrowserAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  context.__testApplyViewPayload({
    query: 'bottom',
    selected_artist: 'Bottom Artist',
    artists_sidebar: [{ artist: 'Bottom Artist', count: 1 }],
  });
  const pendingRevealArtist = context.__testState.ui.pendingSidebarRevealArtist;

  context.__testRenderSidebar();

  const safeTop = 8;
  const safeBottom = player.rect.top - 8;
  const expectedTop = initialScrollTop
    + activeLink.rect.top
    - (safeTop + ((safeBottom - safeTop - activeLink.rect.height) / 2));
  assert.equal(pendingRevealArtist, 'Bottom Artist');
  assert.equal(scrollContainer.scrollTop, expectedTop);
  assert.equal(context.__testState.ui.pendingSidebarRevealArtist, '');
});
