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

test('complete sidebar readiness uses logical virtual rows but requires mounted content and an exact badge', async () => {
  const { NavigationPanelActions } = await import('../e2e/actions/navigationPanelActions.js');
  const previous = { document: global.document, HTMLElement: global.HTMLElement };
  class Element {}
  const badge = Object.assign(new Element(), { textContent: '6343' });
  const list = Object.assign(new Element(), {
    getAttribute: () => 'true',
    albumHavenSidebarArtistsSource: Array.from({ length: 6343 }, (_, i) => ({ artist: `Artist ${i}` })),
  });
  let mounted = 40;
  global.HTMLElement = Element;
  global.document = {
    querySelector: selector => selector === '#count' ? badge : list,
    querySelectorAll: () => Array.from({ length: mounted }, () => new Element()),
  };
  try {
    const actions = new NavigationPanelActions({
      sidebarArtistSelector: '#artists', sidebarListSelector: '#list', allArtistsCountSelector: '#count',
      async waitForPageCondition(predicate, _options, selectors) {
        assert.equal(predicate(selectors), true, 'A populated virtual window represents the complete logical tree');
        mounted = 0;
        assert.equal(predicate(selectors), false, 'An empty visible tree must not pass');
        mounted = 40;
        const source = list.albumHavenSidebarArtistsSource;
        list.albumHavenSidebarArtistsSource = undefined;
        assert.equal(predicate(selectors), false, 'Missing virtual data must not pass');
        list.albumHavenSidebarArtistsSource = source;
        if (selectors.allArtistsCountSelector) {
          badge.textContent = '6000';
          assert.equal(predicate(selectors), false, 'A stale count must not pass');
          badge.textContent = '6343';
        }
      },
    });
    await actions.waitForSidebarFullyHydrated();
    await actions.waitForSidebarAndAllArtistsCountSynchronized();
  } finally {
    global.document = previous.document;
    global.HTMLElement = previous.HTMLElement;
  }
});

test('logical sidebar name reads retain all virtual identities without changing mounted-row accessors', async () => {
  const { NavigationPanelActions } = await import('../e2e/actions/navigationPanelActions.js');
  const previous = global.document;
  const source = [{ artist: ' Gamma ' }, { artist: 'Alpha' }, { artist: 'Beta' }];
  global.document = { querySelector: () => ({
    getAttribute: () => 'true', albumHavenSidebarArtistsSource: source,
  }) };
  try {
    const actions = new NavigationPanelActions({
      sidebarListSelector: '#list',
      sidebarArtists: {
        count: async () => 1,
        evaluateAll: async (callback, arg) => callback([{ getAttribute: () => 'Gamma' }], arg),
      },
    });
    assert.deepEqual(await actions.readHydratedSidebarArtistNames(), ['Gamma', 'Alpha', 'Beta']);
    assert.deepEqual(await actions.readSidebarArtistNames(), ['Gamma']);
    assert.equal(await actions.readSidebarArtistCount(), 1);
  } finally { global.document = previous; }
});

test('complete sidebar count checks preserve nonvirtual behavior', async () => {
  const { NavigationPanelActions } = await import('../e2e/actions/navigationPanelActions.js');
  const previous = { document: global.document, HTMLElement: global.HTMLElement };
  class Element {}
  const badge = Object.assign(new Element(), { textContent: '120' });
  const list = Object.assign(new Element(), { getAttribute: () => null });
  global.HTMLElement = Element;
  global.document = {
    querySelector: selector => selector === '#count' ? badge : list,
    querySelectorAll: () => Array.from({ length: 120 }, () => new Element()),
  };
  try {
    const actions = new NavigationPanelActions({
      sidebarArtistSelector: '#artists', sidebarListSelector: '#list', allArtistsCountSelector: '#count',
      sidebarArtists: { evaluateAll: async (callback, arg) => callback([
        { getAttribute: () => ' Alpha ' }, { getAttribute: () => 'Beta' },
      ], arg) },
      async waitForPageCondition(predicate, _options, selectors) {
        assert.equal(predicate(selectors), true);
        if (selectors.allArtistsCountSelector) {
          badge.textContent = '121';
          assert.equal(predicate(selectors), false);
          badge.textContent = '120';
        }
      },
    });
    await actions.waitForSidebarFullyHydrated();
    await actions.waitForSidebarAndAllArtistsCountSynchronized();
    assert.deepEqual(await actions.readHydratedSidebarArtistNames(), ['Alpha', 'Beta']);
  } finally {
    global.document = previous.document;
    global.HTMLElement = previous.HTMLElement;
  }
});
