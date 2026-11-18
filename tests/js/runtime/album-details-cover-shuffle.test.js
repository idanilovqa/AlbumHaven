const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'album-details-components.js'), 'utf8');

function node(extra = {}) {
  const listeners = {};
  const self = {
    classList: { set: new Set(), add(name) { this.set.add(name); }, remove(name) { this.set.delete(name); }, contains(name) { return this.set.has(name); } },
    attributes: {},
    style: { setProperty() {}, removeProperty() {} },
    children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    append(child) { this.children.push(child); child.parentElement = self; },
    remove() { if (self.parentElement) self.parentElement.children = self.parentElement.children.filter(c => c !== self); self.parentElement = null; },
    addEventListener(type, listener) { listeners[type] = listener; },
    fire(type) { listeners[type]?.(); },
    animate() { return { finished: new Promise(() => {}) }; },
    querySelector: () => null,
    querySelectorAll: () => [],
    ...extra,
  };
  return self;
}

test('the rising cover shows its decoded rear picture until its own image arrives, over 900ms', () => {
  // Owner 2026-11-17: "When covers change in 3-covers artbox, the cover that appears from underneath is
  // absent" and "The animation is too fast on changing covers, slow it down a bit".
  const timings = [];
  const context = { console, window: { matchMedia: () => ({ matches: false }) } };
  vm.createContext(context);
  vm.runInContext(source, context);

  const rearImage = node({ complete: true, naturalWidth: 480 });
  const oldRear = node({ querySelector: () => rearImage });
  oldRear.setAttribute('data-album-details-cover-index', '1');
  oldRear.classList.add('is-top');
  const oldFront = node({ cloneNode: () => node() });
  const oldStack = node({
    querySelector: selector => (selector === '.album-details-cover-stack__front' ? oldFront : (selector.includes('"1"') ? oldRear : null)),
    querySelectorAll: () => [oldRear],
  });
  oldStack.setAttribute('data-album-details-cover-active-index', '0');
  const previous = context.captureAlbumDetailsCoverStack(oldStack);

  const visual = node();
  const risingImage = node({ complete: false, naturalWidth: 0 });
  visual.append(risingImage);
  const newFront = node({ querySelector: () => risingImage, animate(frames, timing) { timings.push(timing.duration); return { finished: new Promise(() => {}) }; } });
  const stack = node({
    querySelector: selector => (selector === '.album-details-cover-stack__front' ? newFront : null),
    animate: () => ({ finished: new Promise(() => {}) }),
  });
  stack.setAttribute('data-album-details-cover-active-index', '1');

  assert.equal(context.animateAlbumDetailsCoverShuffle(previous, stack, 1), true);
  assert.ok(visual.children.includes(rearImage), 'the decoded rear picture stands in');
  assert.equal(rearImage.classList.contains('album-details-cover-stack__stand-in'), true);
  assert.deepEqual(timings, [900]);
  risingImage.fire('load');
  assert.equal(visual.children.includes(rearImage), false, 'the real cover takes over once loaded');
});

test('Album Details shows the previews the gallery already loaded, never a separate full-size download', () => {
  // Owner 2026-11-17: "that 3 cover artbox should have really loaded all the previews while it was at gallery
  // ... there were supposed to be no black absent covers".
  const context = { console };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(context.albumDetailsCoverPreviewUrl({ imageUrl: '/cover?selection_id=a' }), '/cover?selection_id=a&size=480');
  const tagEditor = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'tag-editor-and-optimistic-updates.js'), 'utf8');
  assert.match(tagEditor, /const coverSrc = activeSelectedCover\?\.imageUrl && !\(selectedCoverIndex === 0 && albumHasDisplayCover\(album\)\)\s*\? albumDetailsCoverPreviewUrl\(activeSelectedCover\)\s*: buildAlbumDisplayCoverUrl\(album\);/);
});
