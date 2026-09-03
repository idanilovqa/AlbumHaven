const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const jsRoot = path.join(__dirname, '../../../music_app/static/js');
const defaults = () => ({ main_surface_color: null, panel_background_color: null, palette_id: null, panel_index: 0, player_override: null });

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    ...extra,
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); },
    removeEventListener() {},
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); },
  };
}

function loadRuntime(initial, seekbarMode) {
  const api = require(path.join(jsRoot, 'appearance-backgrounds.js'));
  const styles = new Map(), attributes = new Map();
  const root = {
    dataset: {},
    style: {
      setProperty: (name, value) => styles.set(name, value),
      removeProperty: (name) => styles.delete(name),
      getPropertyValue: (name) => styles.get(name) || '',
    },
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => attributes.get(name) || null,
  };
  const document = eventTarget({
    documentElement: root,
    getElementById: (id) => id === 'appearance-bootstrap' ? { textContent: JSON.stringify(initial) } : null,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
  const window = eventTarget({
    document, devicePixelRatio: 1,
    location: { href: 'https://music.test/', origin: 'https://music.test' },
    confirm: () => true,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    fetch: async (_url, options) => ({
      ok: true, status: 200, redirected: false,
      json: async () => options.method === 'GET' ? { ...initial, csrf_token: 'own-session' } : JSON.parse(options.body),
    }),
  });
  root.ownerDocument = document;
  document.defaultView = window;
  const instance = api.installBrowser(window, document);
  window.AlbumHavenAppearance = { instance, getSavedPlayerColors: () => instance.getSavedPlayerColors() };
  const appearance = { seekbarMode, waveformFillColor: '#FF00FF', waveformEdgeColor: '#00FFFF' };
  const context = vm.createContext({
    window, document, console,
    state: { player: { appearance }, utility: {} },
    CustomEvent: window.CustomEvent,
    getComputedStyle: () => root.style,
    getStreamingPlaybackSnapshot: () => ({ currentTime: 0, duration: 0, paused: true }),
    renderUtilityModalContent() {},
  });
  for (const file of ['appearance-backgrounds-bridge.js', 'player-and-waveform.js', 'loop-range-controls.js']) {
    const filename = path.join(jsRoot, 'runtime', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
  return { api, instance, context, appearance, styles, root };
}

function draw(context, name) {
  const paints = [];
  const ctx = {
    setTransform() {}, clearRect() {}, scale() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, rect() {}, clip() {}, save() {}, restore() {}, arc() {},
    fill() { paints.push(['fill', this.fillStyle]); },
    fillRect() { paints.push(['fill', this.fillStyle]); },
    stroke() { paints.push(['stroke', this.strokeStyle]); },
  };
  context[name]({ clientWidth: 100, clientHeight: 40, width: 100, height: 40, getContext: () => ctx }, {
    left: [0.2, 0.8, 0.3], right: [0.4, 0.6, 0.2],
  }, 0.5);
  return paints;
}

function assertColors(paints, fill, edge) {
  assert.ok(paints.some(([kind, color]) => kind === 'fill' && color === fill));
  assert.ok(paints.some(([kind, color]) => kind === 'stroke' && color === edge));
  assert.ok(paints.every(([, color]) => color === fill || color === edge));
}

for (const drawFunction of ['drawWaveformOnCanvas', 'drawCombinedLoopWaveform']) {
  for (const seekbarMode of ['default', 'waveform']) {
    test(`${drawFunction} uses saved player group, keeps drafts private and preserves ${seekbarMode} seekbar mode`, async () => {
      const initial = { ...defaults(), palette_id: 'steelblue' };
      const { instance, context, appearance } = loadRuntime(initial, seekbarMode);
      await instance.load();
      assertColors(draw(context, drawFunction), '#8BAED1', '#B9CADD');

      instance.controller.setPlayerMode('custom');
      instance.controller.setPlayerColor('background', '#112820');
      instance.controller.setPlayerColor('fill', '#79B390');
      instance.controller.setPlayerColor('edge', '#DCEBE3');
      assertColors(draw(context, drawFunction), '#8BAED1', '#B9CADD');
      assert.equal(await instance.controller.save(), true);
      assertColors(draw(context, drawFunction), '#79B390', '#DCEBE3');
      assert.deepEqual(appearance, { seekbarMode, waveformFillColor: '#FF00FF', waveformEdgeColor: '#00FFFF' });

      instance.controller.setPalette('powderblue');
      instance.controller.setPlayerMode('palette');
      assertColors(draw(context, drawFunction), '#79B390', '#DCEBE3');
      assert.equal(await instance.controller.save(), true);
      assertColors(draw(context, drawFunction), '#4F7398', '#395571');
      assert.equal(appearance.seekbarMode, seekbarMode);
    });
  }
}

test('dark and light palette CSS uses approved colors and session cleanup removes every appearance token', () => {
  const { api, instance, styles, root } = loadRuntime({ ...defaults(), palette_id: 'steelblue' }, 'waveform');
  styles.set('--unrelated-preference', '#ABCDEF');
  api.applyTheme({ ...defaults(), palette_id: 'steelblue' }, root);
  assert.equal(styles.get('--appearance-main-surface'), '#2D455D');
  assert.equal(styles.get('--appearance-ink'), '#EFF4FA');
  assert.equal(styles.get('--appearance-player'), '#14283B');
  assert.equal(styles.get('--appearance-waveform-fill'), '#8BAED1');
  api.applyTheme({ ...defaults(), palette_id: 'powderblue', panel_index: 1 }, root);
  assert.equal(styles.get('--appearance-main-surface'), '#DCEAF5');
  assert.equal(styles.get('--appearance-panel-background'), '#C5DAEB');
  assert.equal(styles.get('--appearance-ink'), '#21364B');
  assert.equal(styles.get('--appearance-player'), '#CBDEED');
  assert.equal(styles.get('--appearance-waveform-edge'), '#395571');
  instance.clearSession();
  assert.deepEqual([...styles], [['--unrelated-preference', '#ABCDEF']]);
  assert.equal(instance.getSavedPlayerColors(), null);
});
