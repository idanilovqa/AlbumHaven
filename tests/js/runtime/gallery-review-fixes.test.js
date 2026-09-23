const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/gallery-main-interactions.js'), 'utf8');

test('artist info aligns with Gallery while its connector tracks the offset trigger', () => {
  const surface = { dataset: {}, style: { setProperty() {} }, offsetWidth: 366 };
  const anchor = { getBoundingClientRect: () => ({ left: 174, right: 204, bottom: 220, width: 30, height: 30 }) };
  let synced = false;
  const context = { window: { innerWidth: 390 }, document: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 24 }) }) }, syncTriggerAnchor: (s, a) => { synced = s === surface && a === anchor; } };
  vm.createContext(context); vm.runInContext(source, context);
  context.positionGalleryAnchoredSurface(surface, anchor, 'left');
  assert.equal(surface.style.left, '24px');
  assert.equal(surface.style.maxWidth, '342px');
  assert.equal(synced, true);
});

test('family panel repaint restores the same artist and scroll without stealing outside focus', () => {
  let focused = null;
  const original = { dataset: { galleryFamilyArtist: 'Artist "A"' } };
  const replacement = { dataset: original.dataset, focus: options => { focused = options; } };
  const panel = { scrollTop: 96, contains: e => e === original, querySelectorAll: () => [replacement], set innerHTML(value) { this.html = value; this.scrollTop = 0; } };
  const context = { document: { activeElement: original } };
  vm.createContext(context); vm.runInContext(source, context);
  assert.equal(typeof context.renderGalleryFamilyPanelBody, 'function');
  context.renderGalleryFamilyPanelBody(panel, 'updated');
  assert.equal(panel.html, 'updated');
  assert.equal(panel.scrollTop, 96);
  assert.equal(focused.preventScroll, true);
  context.document.activeElement = {};
  focused = null;
  context.renderGalleryFamilyPanelBody(panel, 'next');
  assert.equal(focused, null);
});
