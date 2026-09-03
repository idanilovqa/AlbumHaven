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
  const window = {
    document, location, URL, AbortController,
    history: {
      pushState(state, title, url) { historyCalls.push(['push', String(url)]); location.href = new URL(url, location).href; },
      replaceState(state, title, url) { historyCalls.push(['replace', String(url)]); location.href = new URL(url, location).href; },
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
  const context = vm.createContext({ window, fetch, DOMParser, URL, AbortController, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/navigation-tree.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
  const navigation = window.AlbumHavenSettingsNavigation.create({ document, window, fetch, DOMParser });
  const respond = (html, url = 'http://localhost:5000/account', status = 200) => responses.push({ ok: status >= 200 && status < 300, status, url, redirected: false, headers: { get: () => 'text/html' }, text: async () => html });
  return { navigation, respond, responses, requests, historyCalls, nav, outlet, host, shell, users, account, listeners, location, document };
}

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
