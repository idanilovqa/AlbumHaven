const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'mobile-navigation.js'),
  'utf8',
);

function element() {
  return {
    hidden: true,
    inert: false,
    dataset: {},
    textContent: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    appendChild() {},
    setAttribute() {},
    removeAttribute() {},
    getClientRects: () => [],
  };
}

function load(width) {
  const elements = new Map();
  const document = {
    title: 'Album Haven v0.11.20',
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => element(),
    body: element(),
  };
  const context = {
    window: { innerWidth: width }, document, console, state: { view: {}, ui: {} },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.cancelMobileGalleryPinch = () => {};
  context.syncMobileAlbumHeader = () => {};
  context.syncMobileLoopHeader = () => {};
  return { context, document, pages: vm.runInContext('mobilePageState.pages', context) };
}

test('the tab title follows the open phone page and returns when the page closes', () => {
  // Owner 2026-11-17: the browser tab kept an album's or a collection's name after navigating away.
  const { context, document, pages } = load(390);

  pages.push({ kind: 'non-album', title: 'Женя машина', subtitle: '' });
  context.syncMobilePageShell();
  assert.equal(document.title, 'Женя машина — Album Haven');

  pages.pop();
  context.syncMobilePageShell();
  assert.equal(document.title, 'Album Haven v0.11.20');
});

test('on desktop the tab title follows every navigation', () => {
  // Owner 2026-11-17: "yes, if that's plausible" to the desktop tab following navigation.
  const { context, document } = load(1400);
  const sync = () => context.syncAlbumHavenDocumentTitle();

  context.state.view.selected_artist = 'Dragonland';
  sync();
  assert.equal(document.title, 'Dragonland — Album Haven');

  context.state.view.query = 'holy war';
  sync();
  assert.equal(document.title, 'Search: holy war — Album Haven');

  context.getCurrentTrackModalAlbum = () => ({ name: 'Holy War' });
  document.getElementById('track-modal').hidden = false;
  sync();
  assert.equal(document.title, 'Holy War — Album Haven');

  document.getElementById('cover-lookup-modal').hidden = false;
  sync();
  assert.equal(document.title, 'Cover Art Look Up — Album Haven', 'the topmost page names the tab');

  document.getElementById('cover-lookup-modal').hidden = true;
  document.getElementById('track-modal').hidden = true;
  context.state.ui.nonAlbumCollectionName = 'Женя машина';
  document.getElementById('non-album-modal').hidden = false;
  sync();
  assert.equal(document.title, 'Женя машина — Album Haven');

  document.getElementById('non-album-modal').hidden = true;
  context.state.view.query = '';
  context.state.view.selected_artist = '';
  sync();
  assert.equal(document.title, 'Album Haven v0.11.20');
});
