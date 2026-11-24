// A view is named by its address: a history entry's state holds only where the entry is in the app's
// navigation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const scripts = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js');
const helpers = fs.readFileSync(path.join(scripts, 'runtime', 'browser-navigation-helpers.js'), 'utf8');

const NAVIGATION = {
  albumHavenNavigationPosition: 3, albumHavenDiscoveryPosition: 1, mobilePages: [{ kind: 'utilities' }], imageLightbox: true,
};
const madeUpView = () => ({
  selected_artist: 'Made up',
  artist_count: 1,
  artist_groups: [{ artist: 'Made up', albums: [{ name: 'Made up album' }] }],
});

function browser({ state = null, settings = false } = {}) {
  const writes = [];
  const history = {
    state,
    pushState(next, _title, url) { writes.push({ how: 'push', next: structuredClone(next), url }); },
    replaceState(next, _title, url) { writes.push({ how: 'replace', next: structuredClone(next), url }); },
  };
  const context = {
    window: {
      history,
      location: { href: 'http://localhost/?surface=albums', origin: 'http://localhost' },
      ...(settings ? {
        AlbumHavenSettingsNavigation: {
          instance: { pushLibraryHistory(url, next) { writes.push({ how: 'settings', next: structuredClone(next), url }); } },
        },
      } : {}),
    },
    buildUrl: view => `/?artist=${encodeURIComponent(view.selected_artist)}`,
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);
  return { context, writes };
}

for (const settings of [false, true]) {
  test(`choosing a view keeps none of it in history state (settings navigation ${settings})`, () => {
    const { context, writes } = browser({ settings });

    context.pushBrowserViewState(madeUpView());

    assert.deepEqual(writes, [{ how: settings ? 'settings' : 'push', next: {}, url: '/?artist=Made%20up' }]);
  });
}

test('a view correcting its address keeps only where the entry is in the navigation', () => {
  const { context, writes } = browser({ state: { ...NAVIGATION, ...madeUpView() } });

  context.replaceBrowserViewState(madeUpView());

  assert.deepEqual(writes, [{ how: 'replace', next: NAVIGATION, url: '/?artist=Made%20up' }]);
});

test('an entry loaded again keeps only its navigation', () => {
  const { context, writes } = browser({ state: { albumHavenNavigationPosition: 2, ...madeUpView() } });

  context.dropViewFromHistoryState();

  assert.deepEqual(writes, [{ how: 'replace', next: { albumHavenNavigationPosition: 2 }, url: 'http://localhost/?surface=albums' }]);
});

test('an entry holding only its navigation is not written again', () => {
  for (const state of [null, {}, { ...NAVIGATION }]) {
    const { context, writes } = browser({ state });

    context.dropViewFromHistoryState();

    assert.deepEqual(writes, []);
  }
});

test('every history write in the page scripts passes the navigation alone, never the view', () => {
  const files = [];
  const collect = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === 'vendor') continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.name.endsWith('.js') && entry.name !== 'runtime-bundle.js') files.push(file);
    }
  };
  collect(scripts);
  const found = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const write of source.matchAll(/history\.(?:pushState|replaceState)\(/g)) {
      let depth = 0;
      let end = write.index + write[0].length;
      // The first argument: up to the first comma outside brackets.
      for (; end < source.length; end += 1) {
        const char = source[end];
        if ('([{'.includes(char)) depth += 1;
        else if (')]}'.includes(char)) depth -= 1;
        else if (char === ',' && depth === 0) break;
      }
      const state = source.slice(write.index + write[0].length, end);
      if (/\bstate\.view\b|\bview\b|stateSnapshot = view/.test(state)) found.push(`${path.basename(file)}: ${state.trim()}`);
    }
    if (/function pushBrowserViewState\([^)]*= *view\b/.test(source)) found.push(`${path.basename(file)}: the view by default`);
  }

  assert.deepEqual(found, []);
});
