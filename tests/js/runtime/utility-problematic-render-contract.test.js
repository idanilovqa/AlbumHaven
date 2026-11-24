// Request-capture contract (tests/ci/bounded-interactions.json) for opening Problematic Files: the real
// loader, renderProblematicFilesTab, renderProblematicFiles and the real virtual list, at 20 and 14,000
// problematic albums. Committing a payload visits each of its albums once; every render after that, and
// every reopen of a loaded list, visits a bounded number of albums whatever the list's length.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequestCapture, jsonResponse, measureInteractionContract } = require('../helpers/request-capture');
const { loadPendingProjectionFetch } = require('../helpers/pending-projection-fetch');

const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
const RUNTIME_FILES = [
  'problematic-files-virtual-list.js', 'utility-list-builders.js',
  'utility-renderers-and-actions.js', 'utility-loaders-and-cover-lookup.js',
];
const ROW_KEY = 'data-problematic-album-key';

// The virtual list's container: rows mount from one-element templates; every insert, removal and
// markup or text write is one DOM mutation.
function createList(counts) {
  const document = { activeElement: null };
  class Element {
    constructor(tagName) {
      Object.assign(this, { tagName, ownerDocument: document, children: [], parentNode: null, attributes: {}, dataset: {}, style: { cssText: '' } });
    }
    setAttribute(name, value) { counts.domMutations += 1; this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    closest() { return null; }
    focus() { document.activeElement = this; }
    remove() {
      if (!this.parentNode) return;
      counts.domMutations += 1;
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    insertBefore(node, reference) {
      if (node === reference) return node;
      counts.domMutations += 1;
      node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1);
      this.children.splice(reference === null ? this.children.length : this.children.indexOf(reference), 0, node);
      node.parentNode = this;
      return node;
    }
    replaceChildren(...nodes) {
      counts.domMutations += 1;
      this.children.forEach((node) => { node.parentNode = null; });
      this.children = [];
      nodes.forEach(node => this.insertBefore(node, null));
    }
    querySelectorAll(selector) {
      return selector === `[${ROW_KEY}]` ? this.children.filter(child => child.getAttribute(ROW_KEY) !== null) : [];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    get innerHTML() { return this.markup || ''; }
    set innerHTML(html) { counts.domMutations += 1; this.children = []; this.markup = html; }
  }
  document.createElement = (tagName) => {
    if (tagName !== 'template') return new Element(tagName);
    const content = new Element('fragment');
    return {
      content,
      set innerHTML(html) {
        const [, tag, attributes] = html.match(/^<([a-z]+)([^>]*)><\/\1>$/);
        const row = new Element(tag);
        for (const [, name, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) row.attributes[name] = value;
        content.children = [row];
        row.parentNode = content;
      },
    };
  };
  return Object.assign(new Element('div'), {
    clientHeight: 340, clientWidth: 320, scrollLeft: 0, scrollTop: 0, addEventListener() {}, removeEventListener() {},
  });
}

function createControl(counts) {
  let text = '';
  const mutate = () => { counts.domMutations += 1; };
  return {
    dataset: {}, hidden: false, disabled: false, value: '',
    classList: { add: mutate, remove: mutate, toggle: mutate },
    setAttribute: mutate, removeAttribute() {}, querySelector: () => null,
    get textContent() { return text; },
    set textContent(value) { mutate(); text = String(value); },
    set innerHTML(_value) { mutate(); },
  };
}

// Every read of an album's property is one visit, so each pass over the list is counted, whichever
// copy of the array it walks.
function problematicAlbums(count, counts) {
  return Array.from({ length: count }, (_, index) => new Proxy({
    key: `synthetic-album-${String(index).padStart(6, '0')}`,
    name: `Synthetic Album ${index}`,
    album_artist: `Synthetic Artist ${index % 97}`,
    detail_loaded: false,
    problem_reasons: [index % 2 ? 'Missing year' : 'Poor art quality'],
  }, {
    get(target, property, receiver) {
      counts.itemsVisited += 1;
      return Reflect.get(target, property, receiver);
    },
  }));
}

function openSettings(albums) {
  const counts = { itemsVisited: 0, domMutations: 0 };
  const items = problematicAlbums(albums, counts);
  const capture = createRequestCapture(url => jsonResponse(url.endsWith('?limit=50')
    ? { complete: false, has_more: albums > 50, items: items.slice(0, 50) }
    : { complete: true, items }));
  const frames = [];
  const els = {
    tabs: [], overlay: createControl(counts), list: createList(counts), detail: createControl(counts),
    count: createControl(counts), search: createControl(counts), problemFilterButton: createControl(counts),
    problemFilterMenu: null, sidebarLabel: createControl(counts),
  };
  const context = vm.createContext({
    Promise, URL, console: { info() {}, warn() {}, error() {}, log() {} },
    window: {
      performance: { now: () => 0 },
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
      cancelAnimationFrame() {},
      addEventListener() {},
      removeEventListener() {},
      NavigationTree: { updateItem() {}, setItemSelected() {} },
    },
    state: {
      utility: {
        activeTab: 'problematic-files', problematicFiles: [], loaded: false, loading: false, loadPromise: null,
        detailLoadPromises: {}, selectedProblematicKey: '',
        problematicDiagnostics: { summaryLoad: null, detailLoads: {}, lastDetailLoad: null },
      },
    },
    fetch: capture.fetch,
    getUtilityModalElements: () => els,
    scheduleBrowserAnimationFrame(callback) { callback(); return 1; },
    scheduleBrowserTimeout() { return 0; },
    clearBrowserTimeout() { return true; },
    showToast() {},
    escapeHtml: value => String(value ?? ''),
    // Rows are the virtual list's: one element per mounted album.
    buildProblematicAlbumListItem: album => `<button ${ROW_KEY}="${album.key}"></button>`,
    getProblematicAlbumNavigationOptions: () => ({}),
  });
  loadPendingProjectionFetch(context);
  for (const file of RUNTIME_FILES) {
    vm.runInContext(fs.readFileSync(path.join(runtimeRoot, file), 'utf8'), context, { filename: file });
  }
  // The selected album's detail has its own request contract; this one covers the list.
  context.loadProblematicAlbumDetail = async () => null;
  context.isUtilityModalOpen = () => true;
  context.syncUtilityTabAlignment = () => {};
  const settle = async () => {
    for (let turn = 0; turn < 10; turn += 1) await new Promise(setImmediate);
    frames.splice(0).forEach(frame => frame());
  };
  return { albums, capture, context, counts, els, settle };
}

// The rows the real virtual list mounts for this list at the top of its viewport.
function windowRows({ context, els }, albums) {
  const range = context.window.ProblematicFilesVirtualList.calculateRange({
    count: albums, offset: 0, viewport: els.list.clientHeight,
  });
  return range.end - range.start;
}

// One open of Problematic Files (a forced load of the complete list) raced by the status poll's reloads of
// the same library version, during the load and right after it; then renders of the committed list:
// reopening the loaded tab, and selecting a mounted row.
async function openAndRender(session) {
  const { albums, capture, context, counts, els, settle } = session;
  const before = capture.requests.length;
  const mutationsBefore = counts.domMutations;
  context.state.status = { inventory_mutation_revision: 1, watcher_health: { state: 'healthy', problems: [] } };
  const statusReload = () => context.loadProblematicFiles(true, { preserveSelectedDetail: true, reuseSameVersion: true });
  await Promise.all([context.loadProblematicFiles(true), statusReload()]);
  await settle();
  assert.equal((await statusReload()).length, albums, 'a status reload right after the load keeps its list');
  await settle();
  assert.equal(context.state.utility.problematicFiles.length, albums, 'the complete list is committed');
  assert.equal(els.count.textContent, String(albums), 'the count shows every album');
  const mounted = els.list.querySelectorAll(`[${ROW_KEY}]`).map(row => row.getAttribute(ROW_KEY));
  assert.equal(mounted[0], 'synthetic-album-000000', 'the list starts at its first album');
  assert.equal(mounted.length, windowRows(session, albums), 'exactly the virtual list window is mounted');
  const domMutations = counts.domMutations - mutationsBefore;

  const visitsBefore = counts.itemsVisited;
  await context.loadProblematicFiles();
  context.state.utility.selectedProblematicKey = mounted[1];
  context.renderProblematicFilesTab();
  await settle();
  const itemsVisited = counts.itemsVisited - visitsBefore;
  assert.equal(context.state.utility.selectedProblematicKey, mounted[1]);

  const requests = capture.urls().slice(before);
  assert.deepEqual(requests, ['/utilities/problematic-files?limit=50', '/utilities/problematic-files']);
  return { requests, metrics: { itemsVisited, domMutations } };
}

test('request capture: Problematic Files renders a committed list visiting a bounded number of albums per render', async () => {
  const id = 'js:runtime/utility-loaders-and-cover-lookup.js#loadProblematicFiles';
  const { cardinalities, budgets } = require('../../ci/bounded-interactions.json').interactions.find(entry => entry.id === id);
  await measureInteractionContract(id, { setup: albums => openSettings(albums), act: openAndRender });

  // A third size between the registered pair, and a bound on DOM work from the real virtual list window:
  // a longer list may replace the whole mounted window (one removal and one insertion per row) at most once
  // more than the smallest list does.
  const opened = {};
  for (const albums of [cardinalities.small, 2000, cardinalities.production]) {
    const session = openSettings(albums);
    opened[albums] = { ...(await openAndRender(session)).metrics, window: windowRows(session, albums) };
  }
  const smallest = opened[cardinalities.small];
  for (const [albums, { domMutations, itemsVisited, window }] of Object.entries(opened)) {
    assert.equal(itemsVisited, budgets.itemsVisited, `${albums} albums: renders visit a bounded number of albums`);
    assert.ok(domMutations <= smallest.domMutations + 2 * window,
      `${albums} albums: ${domMutations} DOM mutations exceed ${smallest.domMutations} + 2 x ${window} window rows`);
  }
  assert.equal(opened[2000].domMutations, budgets.domMutations, '2,000 albums: the same DOM work as the production size');
  assert.equal(opened[cardinalities.production].domMutations, budgets.domMutations);
});
