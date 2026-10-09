const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Only browser primitives are instrumented. Production sources run whole and
// unmodified, including the eager VirtualArtistGrid constructor when requested.
function createMetadataLifetimeRuntime({ grid = false } = {}) {
  const counts = {
    measures: 0, writes: 0, observes: 0, unobserves: 0, disconnects: 0,
    listenerAdds: 0, listenerRemoves: 0, frameRequests: 0, frameCancels: 0,
  };
  class Element {
    constructor() { this.listeners = new Map(); this.hidden = false; this.isConnected = true; }
    addEventListener(type, callback) {
      counts.listenerAdds += 1;
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) {
      counts.listenerRemoves += 1;
      this.listeners.get(type)?.delete(callback);
    }
  }
  const frames = new Map(), frameHistory = new Map(), observers = [], fontCallbacks = [];
  let nextFrame = 0, resolveFonts;
  const ready = new Promise(resolve => { resolveFonts = resolve; });
  const then = ready.then.bind(ready);
  ready.then = callback => { fontCallbacks.push(callback); return then(callback); };
  const media = new Element();
  media.matches = false;
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.nodes = new Set(); observers.push(this); }
    observe(node) { counts.observes += 1; this.nodes.add(node); }
    unobserve(node) { counts.unobserves += 1; this.nodes.delete(node); }
    disconnect() { counts.disconnects += 1; this.nodes.clear(); }
    deliver() { this.callback([], this); }
  }
  function card() {
    const root = new Element(), row = new Element(), text = new Element();
    const classes = new Set(), styles = new Map();
    row.parentElement = root;
    text.parentElement = row;
    Object.defineProperty(row, 'clientWidth', { get() { counts.measures += 1; return 120; } });
    Object.defineProperty(text, 'scrollWidth', { get() { counts.measures += 1; return 300; } });
    row.classList = {
      contains: name => classes.has(name),
      toggle(name, force) {
        counts.writes += 1;
        const add = force === undefined ? !classes.has(name) : Boolean(force);
        if (add) classes.add(name); else classes.delete(name);
        return add;
      },
      remove(name) { counts.writes += 1; classes.delete(name); },
    };
    row.style = {
      setProperty(name, value) { counts.writes += 1; styles.set(name, String(value)); },
      getPropertyValue: name => styles.get(name) || '',
      removeProperty(name) {
        counts.writes += 1;
        const previous = styles.get(name) || '';
        styles.delete(name);
        return previous;
      },
    };
    root.querySelectorAll = selector => {
      if (selector === '.album-card [data-gallery-metadata-text]') return [text];
      if (selector === 'img[data-gallery-cover-src]') return [];
      throw new Error(`Unexpected lifetime fixture selector: ${selector}`);
    };
    return { root, row, text };
  }
  const container = card();
  const elements = new Map([
    ['artist-groups', container.root], ['albums-scroll', new Element()],
    ['albums-spacer-top', new Element()], ['albums-spacer-bottom', new Element()],
  ]);
  const document = new Element();
  document.getElementById = id => elements.get(id) || null;
  document.fonts = { ready };
  const window = new Element();
  window.innerWidth = 600;
  window.matchMedia = query => {
    if (query !== '(prefers-reduced-motion: reduce)') throw new Error(`Unexpected media query: ${query}`);
    return media;
  };
  const context = vm.createContext({
    document, window, HTMLElement: Element, ResizeObserver,
    requestAnimationFrame(callback) {
      counts.frameRequests += 1;
      const id = ++nextFrame;
      frames.set(id, callback); frameHistory.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { counts.frameCancels += 1; frames.delete(id); },
  });
  const filenames = ['compact-player-helpers.js', 'mobile-navigation.js', 'gallery-card-component.js'];
  if (grid) filenames.push('virtual-artist-grid.js');
  for (const filename of filenames) {
    const sourcePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', filename);
    vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  }
  return {
    context, container, card, observers, media, frames, frameHistory, fontCallbacks,
    snapshot: () => ({ ...counts, pendingFrames: frames.size }),
    setWidth: width => { window.innerWidth = width; },
    reduce(matches) {
      media.matches = matches;
      for (const callback of media.listeners.get('change') || []) callback({ matches });
    },
    flushFrame() {
      const pending = [...frames];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    },
    async resolveFonts() { resolveFonts(); await ready; },
    currentGrid: () => vm.runInContext('virtualGrid', context),
    createGrid: () => vm.runInContext('new VirtualArtistGrid()', context),
  };
}

module.exports = { createMetadataLifetimeRuntime };
