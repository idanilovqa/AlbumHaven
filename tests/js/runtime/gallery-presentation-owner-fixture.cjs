'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
const sources = ['compact-player-helpers.js', 'gallery-card-component.js', 'modal-and-overlay-helpers.js']
  .map(name => ({name, text: fs.readFileSync(path.join(root, 'music_app/static/js/runtime', name), 'utf8')}));

// Browser boundaries only. Ownership, motion calculations, event selection, and
// glow positioning are the complete production scripts, evaluated unmodified.
class Element {
  constructor(document) {
    this.ownerDocument = document;
    this.parentElement = null;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.mutations = [];
    this.clientWidth = 100;
    this.clientHeight = 100;
    this.scrollWidth = 100;
    this.offsetWidth = 100;
    this.offsetHeight = 100;
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.offsetParent = null;
    this._hidden = false;
    const classes = new Set();
    this.classList = {
      contains: name => classes.has(name),
      add: (...names) => { names.forEach(name => classes.add(name)); this.mutations.push(['add', ...names]); },
      remove: (...names) => { names.forEach(name => classes.delete(name)); this.mutations.push(['remove', ...names]); },
      toggle: (name, force = !classes.has(name)) => {
        if (force) classes.add(name); else classes.delete(name);
        this.mutations.push(['toggle', name, force]);
        return force;
      },
    };
    this.style = new Proxy({
      setProperty(name, value) { this[name] = String(value); },
      removeProperty(name) { delete this[name]; },
    }, {set: (target, name, value) => {
      this.mutations.push(['style', name, value]); target[name] = value; return true;
    }});
  }
  get hidden() { return this._hidden; }
  set hidden(value) { this._hidden = value; this.mutations.push(['hidden', value]); }
  get isConnected() { return this.connected === true || Boolean(this.parentElement?.isConnected); }
  append(...nodes) {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    if (selector === '.album-card [data-gallery-metadata-text]') {
      return this.attributes.has('data-gallery-metadata-text') && Boolean(this.parentElement?.closest('.album-card'));
    }
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return selector === '[data-gallery-metadata-text]' && this.attributes.has('data-gallery-metadata-text');
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const callback of [...(this.listeners.get(event.type) || [])]) callback.call(this, event);
    if (event.bubbles !== false) this.parentElement?.dispatchEvent(event);
  }
  listenerCount(name) { return this.listeners.get(name)?.size || 0; }
}

function fixture(t, {mobile = true, reducedMotion = false, resizeObserver = true, artist = false} = {}) {
  const document = {};
  const body = new Element(document), window = new Element(document), media = new Element(document);
  body.connected = true;
  media.matches = reducedMotion;
  let mobileLayout = mobile, sequence = 0;
  const frames = new Map(), timers = new Map(), observers = [], fontReady = [], idReads = [], ids = new Map();
  const enqueue = (queue, callback, delay) => { const id = ++sequence; queue.set(id, {callback, delay}); return id; };
  const flush = queue => {
    const pending = [...queue.values()]; queue.clear(); pending.forEach(entry => entry.callback());
  };
  Object.assign(document, {
    body, createElement: () => new Element(document),
    getElementById(id) { idReads.push(id); assert.ok(artist, 'resource owner must not read Artist DOM IDs'); return ids.get(id) || null; },
    fonts: {ready: {then(callback) { fontReady.push(callback); }}},
  });
  window.matchMedia = query => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return media; };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnected = false; observers.push(this); }
    observe(node) { this.targets.add(node); }
    unobserve(node) { this.targets.delete(node); }
    disconnect() { this.targets.clear(); this.disconnected = true; }
  }
  const gallery = artist ? {} : new Proxy({}, {
    get() { assert.fail('resource owner must not read Artist gallery state'); },
    set() { assert.fail('resource owner must not write Artist gallery state'); },
  });
  const context = vm.createContext({console, document, window, HTMLElement: Element,
    ResizeObserver: resizeObserver ? ResizeObserver : undefined,
    state: {gallery}, usesMobilePageLayout: () => mobileLayout,
    requestAnimationFrame: callback => enqueue(frames, callback), cancelAnimationFrame: id => frames.delete(id),
    scheduleBrowserAnimationFrame: callback => enqueue(frames, callback), cancelBrowserAnimationFrame: id => frames.delete(id),
    scheduleBrowserTimeout: (callback, delay) => enqueue(timers, callback, delay), clearBrowserTimeout: id => timers.delete(id),
  });
  sources.forEach(({name, text}) => vm.runInContext(text, context, {filename: name}));
  const owners = [];
  t.after(() => { owners.reverse().forEach(owner => owner?.dispose()); });
  function host() {
    const scroll = document.createElement(), viewport = document.createElement(), glow = document.createElement();
    body.append(scroll); scroll.append(viewport); viewport.append(glow);
    viewport.clientWidth = 600; viewport.clientHeight = 400;
    return {scroll, viewport, glow};
  }
  function card(viewport, {left = 20, top = 30, width = 100, height = 80, textWidth = 200} = {}) {
    const card = document.createElement(), cover = document.createElement(), row = document.createElement(), text = document.createElement();
    card.classList.add('album-card'); cover.classList.add('cover'); text.setAttribute('data-gallery-metadata-text', '');
    viewport.append(card); card.append(cover, row); row.append(text);
    Object.assign(card, {offsetParent: viewport, offsetLeft: left, offsetTop: top});
    Object.assign(cover, {offsetParent: card, offsetWidth: width, offsetHeight: height});
    text.scrollWidth = textWidth;
    return {card, cover, row, text};
  }
  function metadata(root, options = {}) {
    const owner = context.createGalleryCardMetadataMotion({root, isCurrent: () => true, ...options});
    owners.push(owner); return owner;
  }
  function focus(host, options = {}) {
    const owner = context.createGalleryFocusGlowOwner({...host, isCurrent: () => true, ...options});
    owners.push(owner); return owner;
  }
  return {context, document, window, media, body, gallery, frames, timers, observers, fontReady, ids, idReads,
    host, card, metadata, focus, own(owner) { owners.push(owner); return owner; },
    flushFrames: () => flush(frames), flushTimers: () => flush(timers),
    setMobile(value) { mobileLayout = value; },
    setReduced(value) { media.matches = value; media.dispatchEvent({type: 'change'}); },
  };
}

function emit(node, type, relatedTarget = null) { node.dispatchEvent({type, relatedTarget}); }
function firstCallback(queue) { assert.ok(queue.size > 0, 'an asynchronous callback was scheduled'); return queue.values().next().value.callback; }
function assertMotion(row, distance, duration) {
  assert.equal(row.classList.contains('is-card-text-overflowing'), distance > 0);
  assert.equal(row.style['--card-text-distance'], `${distance}px`);
  assert.equal(row.style['--card-text-duration'], `${duration}ms`);
}
function assertGlow(glow, left, top) {
  assert.equal(glow.hidden, false);
  assert.equal(glow.classList.contains('is-visible'), true);
  assert.equal(glow.style.left, `${left}px`);
  assert.equal(glow.style.top, `${top}px`);
}

module.exports = {fixture, emit, firstCallback, assertMotion, assertGlow};
