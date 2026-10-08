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

function createHarness() {
  const activeLink = new FakeElement({
    width: 212,
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
  return { context, activeLink, sidebarList, scrollContainer, player, initialScrollTop };
}

test('a selected-artist payload change reveals a fully offscreen row within the player-safe viewport', () => {
  const { context, activeLink, scrollContainer, player, initialScrollTop } = createHarness();
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


test('hidden and zero-size rows retain a reveal until the selected tree is visible', () => {
  const { context, activeLink, sidebarList, scrollContainer, initialScrollTop } = createHarness();
  const visibleRect = activeLink.rect;
  sidebarList.hidden = true;
  context.__testRenderSidebar();
  assert.equal(context.__testState.ui.pendingSidebarRevealArtist, 'Bottom Artist');
  assert.equal(scrollContainer.scrollTop, initialScrollTop);
  sidebarList.hidden = false;
  activeLink.rect = { top: 0, bottom: 0, width: 0, height: 0 };
  context.__testRenderSidebar();
  assert.equal(context.__testState.ui.pendingSidebarRevealArtist, 'Bottom Artist');
  assert.equal(scrollContainer.scrollTop, initialScrollTop);
  activeLink.rect = visibleRect;
  context.__testRenderSidebar();
  assert.equal(context.__testState.ui.pendingSidebarRevealArtist, '');
  assert.ok(scrollContainer.scrollTop > initialScrollTop);
});

test('a queued reveal uses the latest selection instead of a superseded payload', () => {
  const { context, activeLink, scrollContainer, player, initialScrollTop } = createHarness();
  const callbacks = [];
  context.scheduleBrowserAnimationFrame = callback => callbacks.push(callback);
  context.__testRenderSidebar();
  context.__testApplyViewPayload({ query: '', selected_artist: 'Latest Artist',
    artists_sidebar: [{ artist: 'Latest Artist', count: 1 }] });
  callbacks.shift()();
  const safeTop = 8;
  const safeBottom = player.rect.top - 8;
  assert.equal(scrollContainer.scrollTop, initialScrollTop + activeLink.rect.top
    - (safeTop + (safeBottom - safeTop - activeLink.rect.height) / 2));
  assert.equal(context.__testState.ui.pendingSidebarRevealArtist, '');
});
