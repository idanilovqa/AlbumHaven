const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const appearance = require('../../../music_app/static/js/appearance-backgrounds.js');
const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
function load(file, names, extra = {}) {
  return vm.runInNewContext(fs.readFileSync(path.join(runtime, file), 'utf8') + `\n;({${names.join(',')}})`, { window: {}, ...extra });
}

test('deliberate pinch steps through 1/2/3 columns in both directions without jitter or invalid values', () => {
  const { resolvePinchColumns: columns } = load('mobile-navigation.js', ['resolvePinchColumns']);
  assert.equal(columns(2, 1.27), 2);
  assert.equal(columns(2, 1.28), 1);
  assert.equal(columns(2, 1 / 1.28), 3);
  assert.equal(columns(1, 1 / 1.28 ** 2), 3);
  assert.equal(columns(3, 1.28 ** 2), 1);
  for (const scale of [0, -1, Infinity, NaN]) assert.equal(columns(2, scale), 2);
  assert.equal(columns(3, .01), 3);
  assert.equal(columns(1, 100), 1);
});

test('a mobile row tap toggles current playback, a second tap restarts, and child actions are independent', () => {
  let now = 1000, toggles = 0;
  const restarts = [];
  const button = { click: () => toggles++ };
  const row = { dataset: { trackPlaying: 'true' }, ownerDocument: { getSelection: () => null }, querySelector: () => button };
  const event = { detail: 1, currentTarget: row, target: { closest: () => null }, preventDefault() {} };
  const api = load('album-track-table.js', ['handleAlbumTrackRowClick', 'handleAlbumTrackRowDoubleClick'], {
    Date: { now: () => now }, usesMobilePageLayout: () => true,
    activateSharedTrackButton: (target, options) => restarts.push([target, options.restart]),
  });
  api.handleAlbumTrackRowClick(event);
  assert.equal(toggles, 1);
  now += 120;
  api.handleAlbumTrackRowClick(event);
  assert.deepEqual(restarts, [[button, true]]);
  api.handleAlbumTrackRowDoubleClick(event);
  assert.equal(restarts.length, 1, 'native dblclick must not cause a third playback action');
  now += 1000;
  api.handleAlbumTrackRowClick(event);
  assert.equal(toggles, 2);
  api.handleAlbumTrackRowClick({ ...event, target: { closest: () => button } });
  assert.equal(toggles, 2);
});

test('Follow mode rejects every appearance mutation until explicit Custom and preserves desktop values', () => {
  const controller = appearance.createController({ initial: {
    revision: 1, main_surface_color: null, panel_background_color: null, player_override: null,
    interaction_overrides: { item_hover: null, item_selected: null, button_hover_background: null, button_pressed: null, item_outline: { source: 'automatic', color: null } },
    palette_id: 'black', panel_index: 0, album_details_layout: 'classic_bar',
    selection_accent: { enabled: true, color: '#6E9BD0' }, player_style_override: null,
  } });
  controller.setDeviceProfile('mobile');
  const cases = [
    ['backgrounds', () => controller.setPalette('parchment-pine')],
    ['seekbar', () => controller.setSeekbarMode('waveform')],
    ['album-page', () => controller.setAlbumDetailsLayout('stacked_bar')],
    ['alerts', () => controller.setAlertFamily('quiet')],
    ['selection-accent', () => controller.setActionButtonOutlines(false)],
  ];
  for (const [section, mutation] of cases) {
    controller.setActiveSection(section);
    const before = controller.getState();
    assert.equal(before.canEdit, false);
    mutation();
    controller.resetSection();
    assert.deepEqual(controller.getState().draft, before.draft);
    assert.deepEqual(controller.getState().deviceProfiles, before.deviceProfiles);
    assert.equal(controller.getState().seekbarMode, before.seekbarMode);
  }
  controller.setActiveSection('album-page');
  controller.setDeviceSectionMode('custom');
  assert.equal(controller.getState().canEdit, true);
  controller.setAlbumDetailsLayout('stacked_bar');
  assert.equal(controller.getState().draft.album_details_layout, 'stacked_bar');
  controller.setDeviceSectionMode('follow');
  assert.equal(controller.getState().draft.album_details_layout, 'classic_bar');
  assert.equal(controller.getState().canEdit, false);
  controller.setDeviceSectionMode('custom');
  assert.equal(controller.getState().draft.album_details_layout, 'stacked_bar');
  controller.setDeviceProfile('web_desktop');
  assert.equal(controller.getState().draft.album_details_layout, 'classic_bar');
});

test('surface coordination closes unrelated owners, retains real children, and clears closed entries', () => {
  const listeners = new Map();
  const document = { addEventListener: (name, fn) => listeners.set(name, fn), dispatchEvent: event => listeners.get(event.type)?.(event) };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  const api = load('trigger-anchor.js', ['activateTriggerSurface', 'clearTriggerAnchor'], { document, CustomEvent });
  const make = () => ({ ownerDocument: document, children: [], contains(node) { return this.children.includes(node); } });
  const parent = make(), child = make(), unrelated = make(); parent.children.push(child);
  const closed = [];
  api.activateTriggerSurface(parent, () => closed.push('parent'));
  api.activateTriggerSurface(child, () => closed.push('child'));
  assert.deepEqual(closed, []);
  api.activateTriggerSurface(unrelated, () => closed.push('other'));
  assert.deepEqual(closed, ['child', 'parent']);
  api.clearTriggerAnchor(unrelated);
  document.dispatchEvent(new CustomEvent('album-haven:surface-opening', { detail: { surface: parent } }));
  assert.deepEqual(closed, ['child', 'parent']);
});

test('mobile artist dialog restores previous inert states instead of enabling an unrelated hidden surface', () => {
  const make = inert => ({ inert });
  const nodes = [make(false), make(true), make(false)], backdrop = { hidden: true };
  const attrs = new Map(), overlay = { classList: { toggle() {} }, setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key) };
  const { syncMobileArtistInfoDialog: sync } = load('mobile-navigation.js', ['syncMobileArtistInfoDialog'], {
    window: { innerWidth: 390 }, document: { querySelector: () => backdrop, querySelectorAll: () => nodes },
  });
  sync(overlay, true);
  assert.ok(nodes.every(node => node.inert));
  assert.equal(attrs.get('aria-modal'), 'true');
  sync(overlay, false);
  assert.deepEqual(nodes.map(node => node.inert), [false, true, false]);
  assert.equal(backdrop.hidden, true);
});


test('sliding family reserves the player edge before its first touch, using its settled horizontal bounds', () => {
  let moving = true;
  const playerBounds = { left: 0, right: 390, top: 524, bottom: 600, width: 390, height: 76 };
  const panel = { style: {}, getBoundingClientRect: () => moving ? { left: 390, right: 683 } : { left: 97, right: 390 } };
  const player = { getBoundingClientRect: () => playerBounds };
  const { observeArtistFamilyPanelBounds: observe } = load('gallery-main-interactions.js', ['observeArtistFamilyPanelBounds'], {
    window: { innerHeight: 600 },
    getComputedStyle: node => node === panel ? { transform: moving ? 'matrix(1, 0, 0, 1, 293, 0)' : 'none' }
      : { opacity: '1', display: 'block', visibility: 'visible' },
    DOMMatrixReadOnly: class { constructor() { this.m41 = 293; } },
  });
  const observer = observe({ panel, player });
  assert.equal(panel.style.bottom, '76px');
  moving = false;
  observer.refresh();
  assert.equal(panel.style.bottom, '76px');
  // Desktop floating transports outside the panel's horizontal span do not reserve space.
  playerBounds.right = 50;
  observer.refresh();
  assert.equal(panel.style.bottom, '0px');
});

for (const mobile of [false, true]) test(`Gallery View ${mobile ? 'mobile popup stays exclusive' : 'desktop inline unfold retains Family'}`, () => {
  let configured, familyCloses = 0, controlCloses = 0, mobileLayout = mobile;
  const cluster = { dataset: {}, querySelectorAll: () => [], contains: () => false };
  const family = { contains: () => false };
  const document = { addEventListener() {}, querySelectorAll: () => [],
    querySelector: selector => selector === '[data-gallery-view-cluster]' ? cluster : null };
  const surfaces = load('trigger-anchor.js', ['activateTriggerSurface', 'clearTriggerAnchor'], { document });
  const control = { select() {}, close() { controlCloses++; configured.onClose(); } };
  const api = load('gallery-main-interactions.js', ['updateGalleryMainControls'], {
    document, window: { innerWidth: mobile ? 390 : 1440 },
    state: { gallery: { mainState: { view: 'cards', sources: {}, albumTypes: [] } }, view: { selected_artist: 'Neal Morse' } },
    normalizeGalleryView: value => value || 'cards', usesMobilePageLayout: () => mobileLayout,
    ...surfaces,
    UnfoldingActionButton: { mount(_root, options) { if (options) { configured = options; cluster.dataset.unfoldDirection = options.direction; } return control; } },
  });
  surfaces.activateTriggerSurface(family, () => familyCloses++);
  api.updateGalleryMainControls();
  assert.equal(configured.direction, mobile ? 'down' : 'left');
  configured.onOpen();
  api.updateGalleryMainControls();
  assert.equal(controlCloses, 0, 'same-layout updates must not close the open disclosure');
  assert.equal(familyCloses, mobile ? 1 : 0);
  configured.onClose();
  assert.equal(familyCloses, mobile ? 1 : 0, 'closing an inline control must not close Family');
  configured.onOpen();
  mobileLayout = !mobile;
  api.updateGalleryMainControls();
  assert.equal(controlCloses, 1, 'a direction change must close through the prior component owner');
  assert.equal(configured.direction, mobileLayout ? 'down' : 'left');
  api.updateGalleryMainControls();
  assert.equal(controlCloses, 1, 'same-layout updates must not repeat the breakpoint close');
  const nextFamily = { contains: () => false };
  let nextFamilyCloses = 0;
  surfaces.activateTriggerSurface(nextFamily, () => nextFamilyCloses++);
  assert.equal(controlCloses, 1, 'a retired view owner must not be closed again by another popup');
  configured.onOpen();
  assert.equal(nextFamilyCloses, mobileLayout ? 1 : 0);
});
