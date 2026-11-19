const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'mobile-navigation.js',
), 'utf8');

function load() {
  const context = {
    window: { addEventListener() {}, history: { state: null }, location: { href: 'http://localhost/' } },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null },
    state: { ui: {}, view: {} },
    URL,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test('Back between two collections is a page change, not the same page', () => {
  // Audit 2026-11-18: Loose Tracks pages have no album key, so Back from collection B to A kept B on screen.
  const { isSameMobilePage } = load();
  const page = (collectionName, libraryWide = true) => ({ kind: 'non-album', albumKey: '', libraryWide, collectionName });
  assert.equal(isSameMobilePage(page('Mix'), page('Mix')), true);
  assert.equal(isSameMobilePage(page('A'), page('B')), false);
  assert.equal(isSameMobilePage(page(''), page('B')), false, 'All Loose Tracks and a collection differ');
  assert.equal(isSameMobilePage(page('', false), page('', true)), false, 'an artist page and the library page differ');
  assert.equal(isSameMobilePage({ kind: 'album', albumKey: 'k' }, { kind: 'album', albumKey: 'k' }), true);
  assert.equal(isSameMobilePage({ kind: 'utilities', albumKey: '', tab: 'rules' }, { kind: 'utilities', albumKey: '', tab: 'loops' }), false);
});
