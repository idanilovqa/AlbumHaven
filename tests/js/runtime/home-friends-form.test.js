const {installPrivateContext} = require('./private-context-harness.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
function setup({playlists = false} = {}) {
  const observers = [], nodes = new Map(), focus = [];
  const document = {activeElement: null, getElementById: id => nodes.get(id),
    createElement: tag => node(tag), addEventListener() {}, removeEventListener() {}};
  function node(tag = 'div') {
    let children = [];
    const attributes = new Map(), listeners = new Map(), classes = new Set();
    const element = {
      tagName: tag.toUpperCase(), hidden: false, disabled: false, style: {}, dataset: {}, parentNode: null,
      classList: {add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value), toggle(value, enabled) {if (enabled) classes.add(value); else classes.delete(value);}}, listeners,
      get children() { return children; },
      set innerHTML(_value) { children.forEach(child => {child.parentNode = null;}); children = []; },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: name => attributes.get(name) ?? null,
      removeAttribute: name => attributes.delete(name),
      addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
      appendChild(child) { children.push(child); child.parentNode = element; },
      contains(child) { return child === element || children.some(value => value.contains(child)); },
      closest(selector) {
        if (selector === '.confirm-modal-actions') return element.footer || element.parentNode?.closest(selector) || null;
        if (selector === '[hidden], [inert]') return element.hidden || element.inert ? element : element.parentNode?.closest(selector) || null;
        return null;
      },
      getClientRects() { return element.closest('[hidden], [inert]') ? [] : [{}]; },
      focus(options) {document.activeElement = element; focus.push([element, options]);},
      querySelectorAll() {
        return children.flatMap(child => [...(['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'A'].includes(child.tagName)
          || child.getAttribute('tabindex') === '0' ? [child] : []), ...child.querySelectorAll()]);
      },
      querySelector: () => null,
    };
    return element;
  }
  for (const name of ['modal', 'title', 'content', 'error', 'cancel', 'submit']) nodes.set(`app-form-${name}`, node(['cancel', 'submit'].includes(name) ? 'button' : 'div'));
  const modal = nodes.get('app-form-modal'), content = nodes.get('app-form-content'), footer = node();
  const panel = node(); modal.appendChild(panel); modal.querySelector = () => panel;
  panel.appendChild(content); panel.appendChild(footer);
  footer.footer = footer; footer.appendChild(nodes.get('app-form-cancel')); footer.appendChild(nodes.get('app-form-submit'));
  modal.hidden = true;
  const trigger = node('button'); document.activeElement = trigger;
  document.body = node('body');
  const home = node(); home.dataset = {homeAccountId: '1', homeLibraryId: '2'}; nodes.set('mobile-home', home);
  if (playlists) {
    nodes.set('playlists-root', node());
    for (const name of ['modal', 'title', 'text', 'cancel', 'accept']) nodes.set(`app-confirm-${name}`, node(['cancel', 'accept'].includes(name) ? 'button' : 'div'));
    nodes.get('app-confirm-modal').hidden = true;
  }
  const window = {location: {href: 'https://albumhaven.test/?surface=home'}, history: {state: {albumHavenNavigationPosition: 4}},
    addEventListener() {}, dispatchEvent() {}};
  const state = {view: {}, ui: {}, player: {}};
  const context = vm.createContext({document, window, URL, URLSearchParams, Event,
    state, shouldShowMobileHome: () => state.view?.surface?.active !== 'playlists',
    bindOverlayPointerOrigin: () => {}, overlayClickStartedOnOverlay: (_modal, event) => event.backdrop === true,
    MutationObserver: class { constructor(callback) {this.callback = callback; observers.push(this);} observe() {} disconnect() {this.disconnected = true;} },
    escapeHtml: value => String(value),
  });
  installPrivateContext(context);
  for (const name of ['browser-dialog-helpers.js', 'track-actions.js', 'home-friends-bridge.js', ...(playlists ? ['playlists-react-bridge.js'] : [])]) {
    vm.runInContext(fs.readFileSync(path.join(runtime, name), 'utf8'), context, {filename: name});
  }
  function fire(name, values = {}) {
    const event = {prevented: false, stopped: false, preventDefault() {this.prevented = true;}, stopPropagation() {this.stopped = true;}, ...values};
    modal.listeners.get(name)?.(event);
    return event;
  }
  return {context, bridge: window.AlbumHavenHomeRuntime, playlists: window.AlbumHavenPlaylistRuntime, document, nodes, node, content, modal, footer, trigger, focus, observers, fire};
}

test('React form content uses one native dialog, scoped close and no duplicate footer', async () => {
  const h = setup(); let host, close, closed;
  const result = h.bridge.openForm({title: 'Edit profile', onMount(value, finish) {host = value; close = finish;}, onClose(value) {closed = value;}});
  assert.notStrictEqual(host, h.content, 'a detached portal host remains safe for React unmount after native close');
  assert.strictEqual(h.content.children[0], host);
  assert.strictEqual(result.close, close);
  assert.equal(h.modal.hidden, false);
  assert.equal(h.nodes.get('app-form-title').textContent, 'Edit profile');
  assert.equal(h.nodes.get('app-form-cancel').hidden, true);
  assert.equal(h.nodes.get('app-form-submit').hidden, true);
  assert.equal(h.footer.hidden, true);
  const input = h.node('input'); host.appendChild(input);
  close('saved');
  assert.equal(await result.promise, 'saved');
  assert.strictEqual(closed, host);
  assert.equal(h.modal.hidden, true);
  assert.equal(h.content.children.length, 0);
  assert.strictEqual(host.children[0], input, 'native clears only its wrapper, not React-owned children');
  assert.strictEqual(h.document.activeElement, h.trigger);
  assert.equal(h.focus.at(-1)[1].preventScroll, true);
  assert.equal(h.footer.hidden, false);
  assert.equal(h.content.getAttribute('tabindex'), null);
  assert.equal(h.observers.at(-1).disconnected, true);
});

test('content-owned dialog waits for portal controls and traps focus through visible enabled controls', () => {
  const h = setup(); let host;
  const result = h.bridge.openForm({onMount(value) {host = value;}});
  assert.strictEqual(h.document.activeElement, h.content);
  const hidden = h.node('input'), disabled = h.node('button'), first = h.node('button'), last = h.node('select');
  hidden.hidden = true; disabled.disabled = true;
  [hidden, disabled, first, last].forEach(value => host.appendChild(value));
  h.observers.at(-1).callback();
  assert.strictEqual(h.document.activeElement, first);
  last.focus(); h.observers.at(-1).callback();
  assert.strictEqual(h.document.activeElement, last, 'later portal changes never steal interaction focus');
  assert.equal(h.fire('keydown', {key: 'Tab'}).prevented, true);
  assert.strictEqual(h.document.activeElement, first);
  assert.equal(h.fire('keydown', {key: 'Tab', shiftKey: true}).prevented, true);
  assert.strictEqual(h.document.activeElement, last);
  h.trigger.focus(); h.fire('keydown', {key: 'Tab'});
  assert.strictEqual(h.document.activeElement, first);
  result.close();
});

test('native empty-content focus trap keeps focus within the dialog', () => {
  const h = setup(), result = h.bridge.openForm();
  assert.equal(h.fire('keydown', {key: 'Tab', shiftKey: true}).prevented, true);
  assert.strictEqual(h.document.activeElement, h.content);
  result.close();
});

for (const dismiss of ['escape', 'backdrop']) test(`native ${dismiss} closes React content once and releases modal ownership`, async () => {
  const h = setup(); let closed = 0;
  const result = h.bridge.openForm({onClose() {closed++;}});
  if (dismiss === 'escape') {
    const event = h.fire('keydown', {key: 'Escape'});
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  } else {
    h.fire('click', {backdrop: false});
    assert.equal(h.modal.hidden, false, 'content-origin click cannot dismiss the native overlay');
    h.fire('click', {backdrop: true});
  }
  result.close('late');
  assert.equal(await result.promise, null);
  assert.equal(closed, 1);
  assert.strictEqual(h.document.activeElement, h.trigger);
  const replacement = h.bridge.openForm();
  result.close('old-owner');
  assert.equal(h.modal.hidden, false);
  replacement.close(); await replacement.promise;
});

test('Home refuses an occupied native form without mounting into or closing it', async () => {
  const h = setup(); let owner, mounted = false;
  const native = h.context.showAppFormDialog({title: 'Other form', onMount(_host, controls) {owner = controls;}});
  assert.throws(() => h.bridge.openForm({title: 'Home', onMount() {mounted = true;}}), /unavailable/);
  assert.equal(mounted, false);
  assert.equal(h.modal.hidden, false);
  assert.equal(h.nodes.get('app-form-title').textContent, 'Other form');
  owner.close(); await native;
  const home = h.bridge.openForm(); home.close(); await home.promise;
});

test('ordinary native footer is unchanged after content-owned close', async () => {
  const h = setup(), home = h.bridge.openForm(); home.close(); await home.promise;
  let owner;
  const native = h.context.showAppFormDialog({onMount(_host, controls) {owner = controls;}});
  assert.equal(h.nodes.get('app-form-cancel').hidden, false);
  assert.equal(h.nodes.get('app-form-submit').hidden, false);
  assert.equal(h.nodes.get('app-form-cancel').textContent, 'Cancel');
  assert.equal(h.nodes.get('app-form-submit').textContent, 'Apply');
  assert.equal(h.footer.hidden, false);
  assert.strictEqual(h.document.activeElement, h.nodes.get('app-form-cancel'));
  owner.close(); await native;
});

test('missing native host, hidden Home or absent owner rejects without mounting', () => {
  for (const unavailable of ['host', 'hidden', 'owner']) {
    const h = setup(); let mounted = false;
    if (unavailable === 'host') h.nodes.delete('app-form-content');
    if (unavailable === 'hidden') h.context.shouldShowMobileHome = () => false;
    if (unavailable === 'owner') h.context.showAppFormDialog = undefined;
    assert.throws(() => h.bridge.openForm({onMount() {mounted = true;}}), /unavailable/);
    assert.equal(mounted, false);
    assert.equal(h.modal.hidden, true);
  }
});

test('failing mount or cleanup cannot strand the native form or focus', async () => {
  const h = setup();
  assert.throws(() => h.bridge.openForm({onMount() {throw new Error('Mount failed');}}), /Mount failed/);
  assert.equal(h.modal.hidden, true);
  assert.strictEqual(h.document.activeElement, h.trigger);
  const home = h.bridge.openForm({onClose() {home.close(); throw new Error('Cleanup failed');}});
  assert.throws(() => home.close(), /Cleanup failed/);
  assert.equal(await home.promise, null);
  assert.equal(h.modal.hidden, true);
  const next = h.bridge.openForm(); next.close(); await next.promise;
});


test('closing a retired React portal can preserve the new route focus', async () => {
  const h = setup(), home = h.bridge.openForm();
  const nextRouteControl = h.node('button'); nextRouteControl.focus();
  home.close(null, {restoreFocus: false});
  assert.equal(await home.promise, null);
  assert.strictEqual(h.document.activeElement, nextRouteControl);
  const ordinary = h.bridge.openForm(); ordinary.close(); await ordinary.promise;
  assert.strictEqual(h.document.activeElement, nextRouteControl, 'default close still restores its own trigger');
});

test('Home and Playlists share one native form owner across surface changes', async () => {
  const h = setup({playlists: true}); let homeClosed = 0, playlistMounted = 0;
  const home = h.bridge.openForm({title: 'Home profile', onClose() {homeClosed++;}});
  h.context.state.view = {surface: {active: 'playlists'}};
  assert.throws(() => h.playlists.openForm({title: 'Playlist sharing', onMount() {playlistMounted++;}}), /unavailable/);
  assert.equal(playlistMounted, 0); assert.equal(homeClosed, 0);
  assert.equal(h.nodes.get('app-form-title').textContent, 'Home profile');
  const routeFocus = h.node('button'); routeFocus.focus(); home.close(null, {restoreFocus: false}); await home.promise;
  let portal; const playlist = h.playlists.openForm({title: 'Playlist sharing', onMount(host) {portal = host; playlistMounted++;}});
  assert.equal(homeClosed, 1); assert.equal(playlistMounted, 1); assert.strictEqual(h.content.children[0], portal);
  home.close('stale'); assert.equal(h.modal.hidden, false); assert.equal(h.nodes.get('app-form-title').textContent, 'Playlist sharing');
  playlist.close('saved'); assert.equal(await playlist.promise, 'saved'); assert.strictEqual(h.document.activeElement, routeFocus);
});

test('content-owned focus excludes controls in hidden or inert ancestors and hidden inputs', async () => {
  const h = setup(); let host;
  const form = h.bridge.openForm({onMount(value) {host = value;}});
  const hiddenParent = h.node(), inertParent = h.node(), hiddenInput = h.node('input'), visible = h.node('button');
  hiddenParent.hidden = true; inertParent.inert = true; hiddenInput.type = 'hidden';
  hiddenParent.appendChild(h.node('input')); inertParent.appendChild(h.node('button'));
  [hiddenParent, inertParent, hiddenInput, visible].forEach(value => host.appendChild(value));
  h.observers.at(-1).callback(); assert.strictEqual(h.document.activeElement, visible);
  h.fire('keydown', {key: 'Tab'}); assert.strictEqual(h.document.activeElement, visible);
  h.fire('keydown', {key: 'Tab', shiftKey: true}); assert.strictEqual(h.document.activeElement, visible);
  form.close(); await form.promise;
});

test('native form cleanup preserves preexisting footer and content focus attributes', async () => {
  const h = setup(); h.footer.hidden = true; h.content.setAttribute('tabindex', '0');
  const form = h.bridge.openForm();
  assert.equal(h.content.getAttribute('tabindex'), '-1'); form.close(); await form.promise;
  assert.equal(h.footer.hidden, true); assert.equal(h.content.getAttribute('tabindex'), '0');
  assert.equal(h.modal.listeners.size, 0);
  assert.equal(h.nodes.get('app-form-cancel').listeners.size, 0);
  assert.equal(h.nodes.get('app-form-submit').listeners.size, 0);
});

test('Home and Playlist confirmation calls use the same native owner without replacing an active prompt', async () => {
  const h = setup({playlists: true}), first = h.bridge.confirm('Discard Home draft?');
  h.context.state.view = {surface: {active: 'playlists'}};
  const second = h.playlists.confirm('Discard Playlist draft?');
  assert.strictEqual(first, second);
  assert.equal(h.nodes.get('app-confirm-text').textContent, 'Discard Home draft?');
  h.nodes.get('app-confirm-cancel').listeners.get('click')(); assert.equal(await first, false); assert.equal(await second, false);
  const playlist = h.playlists.confirm('Discard Playlist draft?');
  assert.equal(h.nodes.get('app-confirm-text').textContent, 'Discard Playlist draft?');
  assert.equal(h.nodes.get('app-confirm-accept').textContent, 'Discard');
  assert.equal(h.nodes.get('app-confirm-accept').classList.contains('confirm-modal-danger'), true);
  h.nodes.get('app-confirm-accept').listeners.get('click')(); assert.equal(await playlist, true);
  h.context.state.view = {surface: {active: 'home'}};
  assert.equal(await h.playlists.confirm('Invisible request'), false);
  assert.equal(h.nodes.get('app-confirm-modal').hidden, true);
});
