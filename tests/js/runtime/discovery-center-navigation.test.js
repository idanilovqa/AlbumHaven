const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime',
  'discovery-center-navigation.js',
);

function harness({ responseStatus = 200, responseUrl, redirected = false, initialPosition } = {}) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const historyCalls = [];
  const requests = [];
  const errors = [];
  const assigned = [];
  const location = {
    origin: 'https://albumhaven.test',
    href: 'https://albumhaven.test/news?tab=inbox',
    pathname: '/news',
    assign(value) { assigned.push(value); },
  };
  const replacement = {
    dataset: { discoveryCenterActiveTab: 'history' },
    setAttribute() {},
    removeAttribute() {},
  };
  const section = {
    dataset: { discoveryCenterActiveTab: 'inbox' },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    replaceWith(value) { this.replacement = value; },
  };
  const document = {
    title: 'Discovery inbox',
    querySelector(selector) {
      if (selector === '[data-discovery-center-page-kind]') return section;
      return null;
    },
    addEventListener(name, callback) { documentListeners.set(name, callback); },
  };
  const window = {
    location,
    history: {
      state: {
        initial: true,
        ...(Number.isSafeInteger(initialPosition)
          ? { albumHavenDiscoveryPosition: initialPosition }
          : {}),
      },
      pushState(state, _title, url) {
        historyCalls.push(['push', String(url)]);
        location.href = new URL(url, location.href).href;
        location.pathname = new URL(location.href).pathname;
        this.state = state;
      },
      replaceState(state, _title, url) {
        historyCalls.push(['replace', String(url)]);
        location.href = new URL(url, location.href).href;
        location.pathname = new URL(location.href).pathname;
        this.state = state;
      },
      go(delta) { historyCalls.push(['go', delta]); },
    },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
  };
  const fetch = async (url, options) => {
    requests.push([url, options]);
    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      redirected,
      url: responseUrl || url,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html></html>',
    };
  };
  class DOMParser {
    parseFromString() {
      return {
        title: 'Discovery history',
        querySelector: selector => selector === '[data-discovery-center-page-kind]' ? replacement : null,
      };
    }
  }
  const context = vm.createContext({
    window, document, fetch, DOMParser, URL, AbortController,
    console: { error: (...args) => errors.push(args) },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  historyCalls.length = 0;
  return { context, document, documentListeners, windowListeners, historyCalls, requests, errors, assigned, location, section, replacement };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('Discovery Center tabs replace their page section without a document reload', async () => {
  const app = harness();
  const link = {
    href: 'https://albumhaven.test/news?tab=history',
    hasAttribute: () => false,
    target: '',
  };
  let prevented = false;
  app.documentListeners.get('click')({
    target: { closest: selector => selector === '[data-discovery-center-page-kind] a[href]' ? link : null },
    preventDefault() { prevented = true; },
    defaultPrevented: false,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
  });
  await settle();

  assert.equal(prevented, true);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0][0], 'https://albumhaven.test/news?tab=history');
  assert.equal(app.requests[0][1].headers.Accept, 'text/html');
  assert.equal(app.section.replacement, app.replacement);
  assert.deepEqual(app.historyCalls, [['push', 'https://albumhaven.test/news?tab=history']]);
  assert.equal(app.document.title, 'Discovery history');
  assert.equal(app.errors.length, 0);
});

test('Discovery Center navigation failure keeps current content and never hard navigates', async () => {
  const app = harness({ responseStatus: 503 });

  assert.equal(await app.context.window.AlbumHavenDiscoveryNavigation.instance.navigate(
    '/news?tab=history',
  ), false);
  assert.equal(app.section.replacement, undefined);
  assert.deepEqual(app.historyCalls, []);
  assert.equal(app.location.href, 'https://albumhaven.test/news?tab=inbox');
  assert.equal(app.errors.length, 1);
});

test('Discovery Center rejects a cross-origin redirect without navigating the document', async () => {
  const app = harness({ redirected: true, responseUrl: 'https://outside.example/news' });

  assert.equal(await app.context.window.AlbumHavenDiscoveryNavigation.instance.navigate(
    '/news?tab=history',
  ), false);
  assert.deepEqual(app.assigned, []);
  assert.deepEqual(app.historyCalls, []);
  assert.equal(app.errors.length, 1);
});

test('failed Discovery Center history navigation restores the displayed entry', async () => {
  const app = harness({ responseStatus: 503, initialPosition: 1 });
  app.context.window.history.state = { albumHavenDiscoveryPosition: 0 };
  app.location.href = 'https://albumhaven.test/news?tab=history';
  app.windowListeners.get('popstate')({ stopImmediatePropagation() {} });
  await settle();

  assert.deepEqual(app.historyCalls, [['go', 1]]);
  assert.equal(app.section.replacement, undefined);
});
