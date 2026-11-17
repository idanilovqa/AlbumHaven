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
    hidden: false,
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

test('the tab title follows the open page and returns when the page closes', () => {
  // Owner 2026-11-17: the browser tab kept an album's or a collection's name after navigating away.
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
  const context = { window: { innerWidth: 390 }, document, console };
  vm.createContext(context);
  vm.runInContext(source, context);
  context.cancelMobileGalleryPinch = () => {};
  context.syncMobileAlbumHeader = () => {};
  context.syncMobileLoopHeader = () => {};

  const pages = vm.runInContext('mobilePageState.pages', context);
  pages.push({ kind: 'non-album', title: 'Женя машина', subtitle: '' });
  context.syncMobilePageShell();
  assert.equal(document.title, 'Женя машина — Album Haven');

  pages.pop();
  context.syncMobilePageShell();
  assert.equal(document.title, 'Album Haven v0.11.20');
});
