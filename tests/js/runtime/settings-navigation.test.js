const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../../../music_app/static/js/settings-navigation.js');

function harness({ library = false, initialPath = '/admin/members' } = {}) {
  const listeners = new Map();
  const attributes = (values = {}) => ({
    values, hidden: false, children: [], childNodes: [], style: {}, dataset: {},
    classList: (() => { const classes = new Set(); return { contains(name) { return classes.has(name); }, add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } }; })(),
    getAttribute(name) { return this.values[name] ?? null; },
    setAttribute(name, value) { this.values[name] = String(value); },
    removeAttribute(name) { delete this.values[name]; },
    hasAttribute(name) { return name in this.values; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(name, fn) { listeners.set(`${this.name || ''}:${name}`, fn); },
    removeEventListener() {}, contains(node) { return node === this || this.children.includes(node); },
    replaceChildren(...nodes) { this.children = nodes; this.childNodes = nodes; },
    append(...nodes) { this.children.push(...nodes); this.childNodes = this.children; },
    appendChild(node) { this.append(node); return node; },
    focus() {}, cloneNode() { return this; },
  });
  const users = attributes({ href: '/admin/members', 'data-settings-section': 'users', 'data-navigation-tree-key': 'users', 'data-navigation-tree-item': 'settings' });
  const account = attributes({ href: '/account', 'data-settings-section': 'account', 'data-navigation-tree-key': 'account', 'data-navigation-tree-item': 'settings' });
  users.dataset.settingsSection = 'users';
  account.dataset.settingsSection = 'account';
  const nav = attributes();
  nav.querySelectorAll = () => [users, account];
  const outlet = attributes();
  outlet.innerHTML = 'initial';
  const host = attributes();
  host.hidden = library;
  host.querySelector = (selector) => selector === '[data-settings-nav]' ? nav : selector === '[data-settings-outlet]' ? outlet : null;
  const shell = attributes();
  const body = attributes();
  const document = {
    readyState: 'loading', title: 'Library', body,
    querySelector(selector) {
      return ({ '[data-settings-host]': host, '[data-settings-nav]': nav, '[data-settings-outlet]': outlet, '#app-shell': library ? shell : null })[selector] || null;
    },
    getElementById(id) { return id === 'app-shell' ? shell : null; },
    querySelectorAll() { return []; },
    addEventListener(name, fn) { listeners.set(`document:${name}`, fn); },
    removeEventListener() {}, importNode(node) { return node; },
  };
  const historyCalls = [];
  const location = new URL(initialPath, 'http://localhost:5000');
  const historyEntries = [{ url: location.href, state: { galleryMarker: 'initial' } }];
  let historyIndex = 0;
  const galleryPops = [];
  const window = {
    document, location, URL, AbortController,
    history: {
      get state() { return historyEntries[historyIndex].state; },
      pushState(state, title, url) {
        historyCalls.push(['push', String(url)]);
        location.href = new URL(url, location).href;
        historyEntries.splice(++historyIndex, Infinity, { url: location.href, state: structuredClone(state) });
      },
      replaceState(state, title, url) {
        historyCalls.push(['replace', String(url)]);
        location.href = new URL(url, location).href;
        historyEntries[historyIndex] = { url: location.href, state: structuredClone(state) };
      },
      go(delta) {
        historyCalls.push(['go', delta]);
        const target = historyIndex + delta;
        if (target < 0 || target >= historyEntries.length) return;
        queueMicrotask(() => {
          historyIndex = target;
          location.href = historyEntries[target].url;
          let stopped = false;
          listeners.get('window:popstate')?.({
            state: window.history.state,
            stopImmediatePropagation() { stopped = true; },
          });
          if (!stopped) galleryPops.push(location.href);
        });
      },
    },
    addEventListener(name, fn) { listeners.set(`window:${name}`, fn); },
    removeEventListener() {}, scrollTo() {},
  };
  const responses = [];
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const value = responses.shift();
    return typeof value === 'function' ? value() : value;
  };
  class DOMParser {
    parseFromString(html) {
      if (html === 'MISSING_SETTINGS_CONTENT') return { title: 'Unrelated page', querySelector() { return null; } };
      const content = attributes();
      content.innerHTML = html;
      content.children = [{ textContent: html }];
      content.childNodes = content.children;
      const parsedHost = attributes();
      parsedHost.querySelector = (selector) => selector === '[data-settings-outlet]' ? content : selector === '[data-settings-nav]' ? nav : null;
      return {
        title: html,
        querySelector(selector) { return ({ '[data-settings-host]': parsedHost, '[data-settings-outlet]': content, '[data-settings-nav]': nav })[selector] || null; },
        querySelectorAll() { return []; },
      };
    }
  }
  const context = vm.createContext({ window, fetch, DOMParser, URL, AbortController, console, setTimeout, clearTimeout, buildUrl: (view) => view.url });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/navigation-tree.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
  const navigation = window.AlbumHavenSettingsNavigation.create({ document, window, fetch, DOMParser });
  window.AlbumHavenSettingsNavigation.instance = navigation;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/browser-navigation-helpers.js'), 'utf8'), context);
  historyCalls.length = 0;
  const respond = (html, url = 'http://localhost:5000/account', status = 200) => responses.push({ ok: status >= 200 && status < 300, status, url, redirected: false, headers: { get: () => 'text/html' }, text: async () => html });
  return { navigation, respond, responses, requests, historyCalls, historyEntries, galleryPops, window, get historyIndex() { return historyIndex; }, pushLibraryView: context.pushBrowserViewState, nav, outlet, host, shell, users, account, listeners, location, document };
}

const settleNavigation = () => new Promise(resolve => setImmediate(resolve));

test('content navigation preserves the shared sidebar and updates history only after success', async () => {
  const app = harness();
  const sidebar = app.nav;
  app.respond('My account content');
  assert.equal(await app.navigation.navigate('/account'), true);
  assert.equal(app.host.querySelector('[data-settings-nav]'), sidebar);
  assert.equal(app.requests.length, 1);
  assert.match(app.requests[0].url, /\/account$/);
  assert.equal(app.historyCalls.at(-1)[0], 'push');
  assert.match(app.historyCalls.at(-1)[1], /\/account$/);
  assert.equal(app.outlet.childNodes[0].textContent, 'My account content');
  assert.equal(app.document.title, 'My account content');
  assert.equal(app.account.getAttribute('aria-current'), 'page');
  assert.equal(app.users.getAttribute('aria-current'), null);
});

test('external, logout, API and unrelated routes are not fetched as settings content', async () => {
  const app = harness();
  for (const url of ['https://outside.example/account', '/logout', '/api/admin/members', '/login', '/account/not-a-page']) {
    assert.equal(await app.navigation.navigate(url), false, url);
  }
  assert.equal(app.requests.length, 0);
  assert.equal(app.historyCalls.length, 0);
});

test('a rejected protected-page response leaves the current content and history intact', async () => {
  const app = harness();
  app.respond('Access denied', 'http://localhost:5000/admin/members', 403);
  assert.equal(await app.navigation.navigate('/admin/members'), false);
  assert.equal(app.outlet.innerHTML, 'initial');
  assert.equal(app.historyCalls.length, 0);
});

test('history restoration does not push a duplicate browser entry', async () => {
  const app = harness();
  app.respond('Restored account');
  assert.equal(await app.navigation.navigate('/account', { historyMode: 'none' }), true);
  assert.equal(app.historyCalls.filter(([mode]) => mode === 'push').length, 0);
});

test('a stale response cannot replace the most recently requested settings view', async () => {
  const app = harness();
  let resolveFirst;
  app.responses.push(() => new Promise((resolve) => { resolveFirst = resolve; }));
  const first = app.navigation.navigate('/account');
  app.respond('Newest Users content', 'http://localhost:5000/admin/members');
  assert.equal(await app.navigation.navigate('/admin/members'), true);
  resolveFirst({ ok: true, status: 200, url: 'http://localhost:5000/account', headers: { get: () => 'text/html' }, text: async () => 'Stale account content' });
  assert.equal(await first, false);
  assert.match(app.historyCalls.at(-1)[1], /\/admin\/members$/);
  assert.equal(app.historyCalls.filter(([mode]) => mode === 'push').length, 1);
  assert.equal(app.outlet.childNodes[0].textContent, 'Newest Users content');
  assert.equal(app.document.title, 'Newest Users content');
  assert.equal(app.users.getAttribute('aria-current'), 'page');
  assert.equal(app.account.getAttribute('aria-current'), null);
});

for (const selection of [
  { name: 'cached artist', url: '/?artist=Newest', selected_artist: 'Newest', all_artists: false },
  { name: 'cached All artists', url: '/?all_artists=1', selected_artist: '', all_artists: true },
]) {
  for (const delayedStage of ['headers', 'body']) {
    test(`${selection.name} history invalidates delayed Settings ${delayedStage}`, async () => {
      const app = harness({ library: true, initialPath: '/?artist=Initial' });
      let releaseResponse;
      let releaseBody;
      let bodyStarted;
      const readingBody = new Promise(resolve => { bodyStarted = resolve; });
      const response = {
        ok: true, status: 200, url: 'http://localhost:5000/account',
        headers: { get: () => 'text/html' },
        text: () => {
          bodyStarted();
          return delayedStage === 'body'
            ? new Promise(resolve => { releaseBody = resolve; })
            : Promise.resolve('Stale account content');
        },
      };
      app.responses.push(delayedStage === 'headers'
        ? () => new Promise(resolve => { releaseResponse = resolve; })
        : response);
      const pending = app.navigation.navigate('/account');
      const signal = app.requests[0].options.signal;
      if (delayedStage === 'body') await readingBody;

      // Cached selection commits through the actual browser history bridge;
      // there is no library fetch whose cancellation could invalidate Settings.
      const selectedView = {
        url: selection.url, selected_artist: selection.selected_artist,
        all_artists: selection.all_artists, galleryMarker: 'newest-cache-selection',
      };
      app.shell.replaceChildren({ textContent: selection.name });
      app.document.title = selection.name;
      app.pushLibraryView(selectedView);
      const newestState = structuredClone(app.window.history.state);
      if (delayedStage === 'headers') releaseResponse(response);
      else releaseBody('Stale account content');

      assert.equal(await pending, false);
      assert.equal(signal.aborted, true);
      assert.equal(app.requests.length, 1, 'the cached library choice must not require another request');
      assert.equal(app.location.href, new URL(selection.url, 'http://localhost:5000').href);
      assert.equal(app.historyIndex, 1);
      assert.equal(app.historyEntries.length, 2);
      assert.deepEqual(app.window.history.state, newestState);
      assert.equal(app.window.history.state.selected_artist, selection.selected_artist);
      assert.equal(app.window.history.state.all_artists, selection.all_artists);
      assert.equal(app.host.hidden, true);
      assert.equal(app.shell.hidden, false);
      assert.equal(app.shell.childNodes[0].textContent, selection.name);
      assert.equal(app.document.title, selection.name);
      assert.equal(app.outlet.childNodes.length, 0);
      assert.deepEqual(app.historyCalls, [['push', new URL(selection.url, 'http://localhost:5000').href]]);
    });
  }
}

test('missing settings content and redirected external HTML cannot replace the current view', async () => {
  const app = harness();
  app.respond('MISSING_SETTINGS_CONTENT');
  assert.equal(await app.navigation.navigate('/account'), false);
  app.respond('External document', 'https://outside.example/account');
  assert.equal(await app.navigation.navigate('/account'), false);
  assert.equal(app.outlet.innerHTML, 'initial');
  assert.equal(app.document.title, 'Library');
  assert.equal(app.historyCalls.length, 0);
});

test('a network failure preserves mounted content and allows a subsequent navigation', async () => {
  const app = harness();
  app.responses.push(() => Promise.reject(new TypeError('Network request failed')));
  assert.equal(await app.navigation.navigate('/account'), false);
  assert.equal(app.outlet.innerHTML, 'initial');
  assert.equal(app.historyCalls.length, 0);
  app.respond('Recovered account');
  assert.equal(await app.navigation.navigate('/account'), true);
  assert.equal(app.outlet.childNodes[0].textContent, 'Recovered account');
});

test('forward history restoration preserves the original library URL for the logo return', async () => {
  const app = harness({ library: true, initialPath: '/?artist=Navigation' });
  app.respond('Users', 'http://localhost:5000/admin/members');
  assert.equal(await app.navigation.navigate('/admin/members'), true);
  app.location.href = 'http://localhost:5000/?artist=Navigation';
  assert.equal(await app.navigation.navigate(app.location.href, { historyMode: 'none' }), true);
  app.location.href = 'http://localhost:5000/admin/members';
  app.respond('Forward Users', app.location.href);
  assert.equal(await app.navigation.navigate(app.location.href, { historyMode: 'none' }), true);
  assert.equal(await app.navigation.navigate('/'), true);
  assert.equal(app.location.href, 'http://localhost:5000/?artist=Navigation');
  assert.equal(app.host.hidden, true);
  assert.equal(app.shell.hidden, false);
});

for (const direction of ['back', 'forward']) {
  test(`cancelled ${direction} from unsaved Appearance restores the library history entry`, async () => {
    const app = harness({ library: true, initialPath: '/?artist=Initial' });
    app.respond('Users', 'http://localhost:5000/admin/members');
    await app.navigation.navigate('/admin/members');
    await app.navigation.navigate('/');
    app.pushLibraryView({ url: '/?artist=Current' }, { selected_artist: 'Current', gallery: { retained: true } });
    if (direction === 'back') {
      // Scan Page return restores a URL while preserving the existing snapshot.
      app.window.history.replaceState(app.window.history.state, '', '/?artist=Current&return=scan');
    }
    if (direction === 'forward') {
      app.window.history.go(-3);
      await settleNavigation();
    }
    const originalUrl = app.location.href;
    const originalIndex = app.historyIndex;
    const originalState = structuredClone(app.window.history.state);
    const originalEntries = structuredClone(app.historyEntries);
    const requestCount = app.requests.length;
    const galleryPopCount = app.galleryPops.length;
    let prompts = 0;
    app.window.AlbumHavenAppearance = { instance: { allowLeave() { prompts++; return false; } } };
    const delta = direction === 'back' ? -2 : 1;

    app.window.history.go(delta);
    await settleNavigation();

    assert.equal(app.location.href, originalUrl);
    assert.equal(app.historyIndex, originalIndex);
    assert.deepEqual(app.window.history.state, originalState);
    assert.deepEqual(app.historyEntries, originalEntries);
    assert.equal(app.host.hidden, true);
    assert.equal(app.shell.hidden, false);
    assert.equal(app.requests.length, requestCount);
    assert.equal(app.galleryPops.length, galleryPopCount);
    assert.equal(prompts, 1, 'restoring the old entry must not prompt again');

    app.window.AlbumHavenAppearance.instance.allowLeave = () => true;
    app.respond('Users after discard', 'http://localhost:5000/admin/members');
    app.window.history.go(delta);
    await settleNavigation();
    assert.equal(app.location.pathname, '/admin/members');
    assert.equal(app.outlet.childNodes[0].textContent, 'Users after discard');
  });
}

test('cancelled gallery history navigation preserves the dirty Appearance screen and snapshot', async () => {
  const app = harness({ library: true, initialPath: '/?artist=Initial' });
  app.pushLibraryView({ url: '/?artist=Current' }, { selected_artist: 'Current' });
  let prompts = 0;
  app.window.AlbumHavenAppearance = { instance: { allowLeave() { prompts++; return false; } } };

  app.window.history.go(-1);
  await settleNavigation();

  assert.equal(app.location.search, '?artist=Current');
  assert.equal(app.historyIndex, 1);
  assert.equal(app.window.history.state.selected_artist, 'Current');
  assert.equal(app.host.hidden, true);
  assert.equal(app.galleryPops.length, 0);
  assert.equal(prompts, 1);
});

test('cancelled popstate aborts an older Settings fetch before restoring history', async () => {
  const app = harness({ library: true, initialPath: '/?artist=Initial' });
  app.respond('Users', 'http://localhost:5000/admin/members');
  await app.navigation.navigate('/admin/members');
  await app.navigation.navigate('/');
  let resolvePending;
  app.responses.push(() => new Promise(resolve => { resolvePending = resolve; }));
  const pending = app.navigation.navigate('/account');
  const signal = app.requests.at(-1).options.signal;
  app.window.AlbumHavenAppearance = { instance: { allowLeave: () => false } };

  app.window.history.go(-1);
  await settleNavigation();
  resolvePending({ ok: true, status: 200, url: 'http://localhost:5000/account', headers: { get: () => 'text/html' }, text: async () => 'Stale account' });

  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
  assert.equal(app.location.search, '?artist=Initial');
  assert.equal(app.historyIndex, 2);
  assert.equal(app.host.hidden, true);
  assert.equal(app.shell.hidden, false);
  assert.equal(app.outlet.childNodes.length, 0);
});

test('failed Settings history fetch restores the original entry without overwriting its neighbor', async () => {
  const app = harness({ library: true, initialPath: '/?artist=Initial' });
  app.respond('Users', 'http://localhost:5000/admin/members');
  await app.navigation.navigate('/admin/members');
  await app.navigation.navigate('/');
  const originalEntries = structuredClone(app.historyEntries);
  app.responses.push(() => Promise.reject(new TypeError('Network failed')));

  app.window.history.go(-1);
  await settleNavigation();

  assert.equal(app.historyIndex, 2);
  assert.equal(app.location.search, '?artist=Initial');
  assert.deepEqual(app.historyEntries, originalEntries);
  assert.equal(app.host.hidden, true);
  assert.equal(app.galleryPops.length, 0);
});

test('library history retains its existing fallback when Settings navigation is absent', () => {
  const app = harness({ library: true, initialPath: '/' });
  app.window.AlbumHavenSettingsNavigation.instance = null;
  const snapshot = { selected_artist: 'Standalone' };
  app.pushLibraryView({ url: '/?artist=Standalone' }, snapshot);
  assert.equal(app.location.search, '?artist=Standalone');
  assert.deepEqual(app.window.history.state, snapshot);
});

test('an untracked pop during rollback releases navigation after restoring the displayed snapshot', async () => {
  const app = harness({ library: true, initialPath: '/?artist=Initial' });
  app.respond('Users', 'http://localhost:5000/admin/members');
  await app.navigation.navigate('/admin/members');
  await app.navigation.navigate('/');
  const displayedState = structuredClone(app.window.history.state);
  const originalGo = app.window.history.go.bind(app.window.history);
  const pendingRollbacks = [];
  app.window.history.go = (delta) => {
    if (delta > 0) pendingRollbacks.push(delta);
    else originalGo(delta);
  };
  app.window.AlbumHavenAppearance = { instance: { allowLeave: () => false } };
  app.window.history.go(-1);
  await settleNavigation();
  assert.deepEqual(pendingRollbacks, [1]);

  app.historyEntries[0].state = { legacy: true };
  originalGo(-1);
  await settleNavigation();

  assert.equal(app.location.search, '?artist=Initial');
  assert.deepEqual(app.window.history.state, displayedState);
  assert.equal(app.host.hidden, true);
  app.window.AlbumHavenAppearance.instance.allowLeave = () => true;
  app.respond('Account after rollback');
  assert.equal(await app.navigation.navigate('/account'), true);
  assert.equal(app.outlet.childNodes[0].textContent, 'Account after rollback');
});
