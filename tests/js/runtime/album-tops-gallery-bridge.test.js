'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {TOP, environment, read} = require('./album-tops-native-gallery-fixture.cjs');

function bridgeFixture() {
  const f = environment(), {context: c, document: doc} = f;
  for (const id of ['app-shell', 'album-tops-root', 'shell-main-surface']) {const element = doc.createElement('div'); element.id = id; doc.body.append(element);}
  const shell = doc.getElementById('app-shell');
  shell.dataset.nativeAccountId = '41'; shell.dataset.nativeLibraryId = '51';
  let identity = 'private-context', generation = 3, columns = 2;
  const writes = [], privateListeners = new Set();
  const preferences = {displayPreferences: {defaultGalleryDisplayMode: 'covers', defaultGalleryScalePercent: 120}};
  const galleryState = new Proxy(preferences, {
    get(target, key) {assert.equal(key, 'displayPreferences', 'only shared saved preference reads are allowed'); return target[key];},
    set(target, key, value) {assert.equal(key, 'displayPreferences', 'only shared saved preference writes are allowed'); target[key] = value; return true;},
  });
  const view = Object.freeze({surface: Object.freeze({active: 'album_tops'}), top_ref: TOP, sentinel: 'native view identity'});
  c.state.view = view; c.state.gallery = galleryState; c.state.ui = {activeViewRequestId: 7};
  c.location = {href: 'https://albumhaven.example/?surface=album_tops'};
  c.AlbumHavenHomeRuntime = f.runtime;
  c.PrivateUITransport = {context: () => identity, generation: () => generation,
    subscribe(callback) {privateListeners.add(callback); return () => privateListeners.delete(callback);}};
  vm.runInContext(read('music_app/static/js/runtime/gallery-display-preference-helpers.js'), c, {filename: 'gallery-display-preference-helpers.js'});
  c.getLibrarySidebarMode = () => 'album_tops';
  c.selectLibrarySidebarMode = () => assert.fail('View preference may not navigate sidebar');
  c.persistGalleryDisplayPreferences = () => {
    const value = preferences.displayPreferences;
    writes.push({gallery_display_mode: value.defaultGalleryDisplayMode, gallery_scale_percent: value.defaultGalleryScalePercent});
  };
  c.AlbumHavenDevicePreferences = {read(field, fallback) {assert.equal(field, 'mobileGridColumns'); assert.equal(fallback, 3); return columns;}};
  vm.runInContext(read('music_app/static/js/runtime/album-tops-react-bridge.js'), c, {filename: 'album-tops-react-bridge.js'});
  const bridge = c.AlbumHavenAlbumTopsRuntime;
  return {...f, bridge, writes, view, shell, artistGallery: galleryState,
    preferences(next, nextColumns = columns) {preferences.displayPreferences = next; columns = nextColumns; doc.dispatchEvent(new c.Event('album-haven:preferences-sync'));},
    revoke() {identity = null; generation++; privateListeners.forEach(listener => listener());},
  };
}

test('bridge exposes saved View, scale, and mobile columns and responds to preference sync', () => {
  const f = bridgeFixture(), initial = f.bridge.snapshot(), updates = [];
  assert.equal(initial.galleryDisplayMode, 'covers');
  assert.equal(initial.galleryScalePercent, 120);
  assert.equal(initial.mobileGalleryColumns, 2);
  const unsubscribe = f.bridge.subscribe(() => updates.push(f.bridge.snapshot()));
  f.preferences({defaultGalleryDisplayMode: 'list', defaultGalleryScalePercent: 80}, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].galleryDisplayMode, 'list');
  assert.equal(updates[0].galleryScalePercent, 80);
  assert.equal(updates[0].mobileGalleryColumns, 1);
  assert.equal(updates[0].viewVersion, initial.viewVersion);
  assert.equal(f.context.state.view, f.view);
  assert.equal(f.context.state.gallery, f.artistGallery);
  unsubscribe();
  f.preferences({defaultGalleryDisplayMode: 'cards', defaultGalleryScalePercent: 100}, 3);
  assert.equal(updates.length, 1);
});

test('bridge View writes only saved presentation preference and preserves saved scale', () => {
  const f = bridgeFixture();
  assert.equal(f.bridge.setGalleryDisplayMode('list'), true);
  assert.deepEqual(f.writes, [{gallery_display_mode: 'list', gallery_scale_percent: 120}]);
  assert.equal(f.bridge.snapshot().galleryDisplayMode, 'list');
  assert.equal(f.bridge.snapshot().galleryScalePercent, 120);
  assert.equal(f.context.state.view, f.view);
  assert.equal(f.context.state.gallery, f.artistGallery);
  assert.equal(f.bridge.setGalleryDisplayMode('unknown'), false);
  assert.equal(f.writes.length, 1);
});

test('bridge rejects preference writes after shell departure or authentication loss', () => {
  const f = bridgeFixture();
  f.shell.hidden = true;
  assert.equal(f.bridge.setGalleryDisplayMode('cards'), false);
  f.shell.hidden = false; f.revoke();
  assert.equal(f.bridge.setGalleryDisplayMode('cards'), false);
  assert.deepEqual(f.writes, []);
});

test('bridge delegates Gallery and presentation to actual shared owners', () => {
  const f = bridgeFixture(), host = f.document.createElement('div'); f.host.append(host);
  const snapshot = {scopeKey: 'scope', resourceKey: TOP, displayMode: 'cards', galleryScalePercent: 100, mobileColumns: 3};
  const gallery = f.bridge.createGalleryHost({host, readSnapshot: () => snapshot, isCurrent: () => true,
    renderCard() {const element = f.document.createElement('article'); return {element, update() {}};}});
  assert.equal(gallery instanceof f.owner('ResourceGalleryHost'), true);
  assert.equal(gallery.update([{key: 'one'}]), true);
  const metadata = f.bridge.createGalleryMetadataOwner({root: host, isCurrent: () => true});
  const scroll = f.document.createElement('div'), viewport = f.document.createElement('div'), glow = f.document.createElement('div');
  f.host.append(scroll); scroll.append(viewport); viewport.append(glow);
  const focus = f.bridge.createGalleryFocusOwner({scroll, viewport, glow, isCurrent: () => true});
  f.flush(); metadata.dispose(); focus.dispose(); gallery.dispose();
  assert.equal(host.children.length, 0);
  assert.equal(f.context.state.gallery, f.artistGallery);
});
