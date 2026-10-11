const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..', '..');

test('sidebar artist names use one bulk DOM read without changing list semantics', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/navigationPanelActions.js'),
  ).href;
  const { NavigationPanelActions } = await import(moduleUrl);
  const attributeValues = [
    '  Gamma  ',
    '',
    null,
    'Beta',
    '   ',
    'Alpha',
    'Beta',
  ];
  let bulkReadCount = 0;

  const actions = new NavigationPanelActions({
    sidebarArtists: {
      async evaluateAll(callback) {
        bulkReadCount += 1;
        const elements = attributeValues.map((value) => ({
          getAttribute(attributeName) {
            assert.equal(attributeName, 'data-sidebar-artist');
            return value;
          },
        }));
        return callback(elements);
      },
      async count() {
        assert.fail('readSidebarArtistNames must not count rows in a separate browser round trip');
      },
      nth() {
        assert.fail('readSidebarArtistNames must not read rows through sequential locators');
      },
    },
  });

  assert.deepEqual(
    await actions.readSidebarArtistNames(),
    ['Gamma', 'Beta', 'Alpha', 'Beta'],
  );
  assert.equal(bulkReadCount, 1);
});

test('sidebar preview readiness accepts a fully hydrated virtualized artist list', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/actions/navigationPanelActions.js'),
  ).href;
  const { NavigationPanelActions } = await import(moduleUrl);
  const originalDocument = global.document;
  const originalHTMLElement = global.HTMLElement;

  class FakeElement {}
  const countNode = new FakeElement();
  countNode.textContent = '1427';
  const sidebarList = new FakeElement();
  sidebarList.getAttribute = (name) => (name === 'data-sidebar-virtualized' ? 'true' : null);
  sidebarList.albumHavenSidebarArtistsSource = Array.from({ length: 1427 }, () => ({}));
  let mountedCount = 0;
  global.HTMLElement = FakeElement;
  global.document = {
    querySelector(selector) {
      if (selector === '#all-artists-count') return countNode;
      if (selector === '#sidebar-list') return sidebarList;
      return null;
    },
    querySelectorAll(selector) {
      assert.equal(selector, '#sidebar-artists');
      return Array.from({ length: mountedCount }, () => new FakeElement());
    },
  };

  try {
    const actions = new NavigationPanelActions({
      sidebarArtistSelector: '#sidebar-artists',
      sidebarListSelector: '#sidebar-list',
      allArtistsCountSelector: '#all-artists-count',
      async waitForPageCondition(callback, _options, selectors) {
        assert.equal(callback(selectors), false);
        mountedCount = 170;
        assert.equal(callback(selectors), true);
      },
    });
    await actions.waitForSidebarPreviewHydrated();
  } finally {
    global.document = originalDocument;
    global.HTMLElement = originalHTMLElement;
  }
});

test('mounted-family continuity flags synchronous clear/rebuild but permits stable child reordering', async () => {
  const modulePath = path.join(repoRoot, 'tests/e2e/poms/navigationPanel.js');
  const moduleUrl = pathToFileURL(modulePath).href;
  const { classifyMountedFamilyGalleryContinuity } = await import(moduleUrl);

  assert.deepEqual(classifyMountedFamilyGalleryContinuity({
    initialChildCount: 3,
    finalChildCount: 3,
    finalUsesOnlyInitialChildren: false,
    removedAllInitialChildren: true,
  }), {
    galleryChildrenReplaced: true,
    galleryCleared: true,
  });
  assert.deepEqual(classifyMountedFamilyGalleryContinuity({
    initialChildCount: 3,
    finalChildCount: 3,
    finalUsesOnlyInitialChildren: true,
    removedAllInitialChildren: false,
  }), {
    galleryChildrenReplaced: false,
    galleryCleared: false,
  });

  const source = fs.readFileSync(modulePath, 'utf8');
  assert.match(source, /record\.removedNodes/);
  assert.match(source, /initialChildSet\.has/);
  assert.doesNotMatch(source, /globalThis\.state/);
  assert.match(source, /typeof state !== ['"]undefined['"]/);
});
