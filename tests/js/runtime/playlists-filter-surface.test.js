const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/filter-surface.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;

// Bounded React-hook/native-DOM adapter probe. The existing form/page owner is
// tested separately; this does not claim browser layout or React reconciliation.
function fixture(phone = false, withMedia = true) {
  const env = createNativeHomeRuntime(), host = env.document.createElement('div'), trigger = env.document.createElement('button');
  // This focused adapter probe owns focus return; the shared component fixture
  // keeps its default prohibition for every other suite.
  env.context.Element.prototype.focus = function () {if (this.isConnected && !this.disabled) env.document.activeElement = this;};
  const query = host.querySelector.bind(host);
  host.querySelector = selector => selector === 'input:not(:disabled), button:not(:disabled)'
    ? host.querySelectorAll('input, button').find(node => !node.disabled) || null : query(selector);
  env.document.body.append(host, trigger);
  const win = env.document.createElement('window'), media = env.document.createElement('media');
  media.matches = phone; win.innerWidth = phone ? 390 : 1200;
  if (withMedia) win.matchMedia = query => {assert.equal(query, '(max-width: 900px)'); return media;};
  let cursor = 0, effects = [], disposed = false, updatesAfterDispose = 0;
  const slots = [], closes = [], formCloses = [];
  const hooks = {...React,
    useRef(value) {return slots[cursor++] ||= {current: value};},
    useState(initial) {const slot = slots[cursor++] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slot.value, next => {if (disposed) updatesAfterDispose++; slot.value = typeof next === 'function' ? next(slot.value) : next;}];},
    useLayoutEffect(effect, deps) {const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) effects.push(() => {
        old?.cleanup?.(); slots[index] = {deps, cleanup: effect()};
      });},
  };
  const loaded = {exports: {}};
  vm.runInNewContext(built, {module: loaded, exports: loaded.exports, require: name => name === 'react' ? hooks : require(name), window: win});
  let tree;
  const content = React.createElement('input', {'aria-label': 'Find tracks'});
  const render = (props = {}) => {
    cursor = 0; effects = [];
    tree = loaded.exports.PlaylistFilterSurface({runtime: {}, id: 'owned-filters', returnFocus: () => trigger,
      onClose: options => closes.push(options), children: content, ...props});
    if (tree.type === 'section') {
      tree.props.ref.current = host;
      if (!host.firstElementChild) host.append(env.document.createElement('input'));
    }
    for (const effect of effects) effect();
    return tree;
  };
  return {...env, host, trigger, media, win, closes, formCloses, render,
    mountForm(close = options => {formCloses.push(options); return Promise.resolve(true);}) {return tree.props.children(close);},
    resize(next) {media.matches = next; win.innerWidth = next ? 390 : 1200;
      (withMedia ? media : win).dispatchEvent(new env.context.Event(withMedia ? 'change' : 'resize'));},
    unmount() {disposed = true; for (const slot of slots) slot.cleanup?.(); host.remove(); trigger.remove();},
    updatesAfterDispose: () => updatesAfterDispose,
  };
}
const key = (value, options = {}) => ({key: value, defaultPrevented: false, repeat: false, isComposing: false,
  preventDefault() {this.defaultPrevented = true;}, stopPropagation() {this.stopped = true;}, ...options});

test('desktop keeps an inline region; ordinary Escape returns focus while Choice and held-key ownership survive', () => {
  const f = fixture(), tree = f.render();
  assert.equal(tree.type, 'section'); assert.equal(tree.props.id, 'owned-filters');
  assert.match(tree.props.className, /--inline/); assert.equal(tree.props['aria-label'], 'Playlist filters');
  for (const options of [{defaultPrevented: true}, {repeat: true}, {isComposing: true}]) tree.props.onKeyDown(key('Escape', options));
  const menu = f.document.createElement('button'); menu.setAttribute('aria-expanded', 'true'); f.host.append(menu);
  tree.props.onKeyDown(key('Escape')); assert.equal(f.closes.length, 0);
  menu.remove(); const event = key('Escape'); tree.props.onKeyDown(event);
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(f.closes.length, 1); assert.equal(f.document.activeElement, f.trigger); f.unmount();
});

test('phone delegates its whole filter page and close footer to the native form owner', () => {
  const f = fixture(true), tree = f.render();
  assert.equal(tree.type.name, 'NativeDialog'); assert.equal(tree.props.title, 'Playlist filters');
  assert.equal(tree.props.pageId, 'playlist-filters'); assert.equal(tree.props.contentOwnsFooter, false);
  const page = f.mountForm(); assert.equal(page.type, 'section'); assert.match(page.props.className, /--form/);
  assert.equal(page.props.children.props['aria-label'], 'Find tracks');
  tree.props.onClose({current: true, restoreFocusRequested: true});
  assert.equal(f.closes.length, 1); assert.equal(f.closes[0].restoreFocusRequested, true); f.unmount();
});

test('desktop-to-phone resize collapses instead of opening an unexpected page and retains the current trigger', () => {
  const f = fixture(); f.render(); f.resize(true);
  assert.equal(f.closes.length, 1); assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.formCloses.length, 0); f.unmount();
});

test('phone-to-desktop resize waits for the native parent return before mounting inline and focusing a field', () => {
  const f = fixture(true), tree = f.render(); f.mountForm(); f.resize(false); f.resize(false);
  assert.equal(f.formCloses.length, 1); assert.equal(f.formCloses[0].reason, 'resize');
  assert.equal(f.formCloses[0].restoreFocus, false); assert.equal(f.render().type.name, 'NativeDialog');
  tree.props.onClose({current: true}); const inline = f.render();
  assert.equal(inline.type, 'section'); assert.match(inline.props.className, /--inline/);
  assert.equal(f.closes.length, 0); assert.equal(f.document.activeElement, f.host.firstElementChild); f.unmount();
});

test('newer native navigation prevents a pending resize from reopening or focusing filters', () => {
  const f = fixture(true), tree = f.render(); f.mountForm(); f.resize(false);
  const destination = f.document.createElement('button'); f.document.body.append(destination); destination.focus();
  tree.props.onClose({current: false, restoreFocusRequested: false});
  assert.equal(f.closes.length, 1); assert.equal(f.document.activeElement, destination);
  assert.equal(f.render().type.name, 'NativeDialog'); f.unmount();
});

test('a second narrow resize before native close leaves the page closed instead of reopening a stale inline row', () => {
  const f = fixture(true), tree = f.render(); f.mountForm(); f.resize(false); f.resize(true);
  tree.props.onClose({current: true}); assert.equal(f.closes.length, 1); f.unmount();
});

test('resource unmount retires resize listeners and late native closure cannot write or focus a replacement', () => {
  const f = fixture(true), tree = f.render(); f.mountForm(); f.resize(false); f.unmount();
  tree.props.onClose({current: true}); f.resize(false);
  assert.equal(f.closes.length, 0); assert.equal(f.updatesAfterDispose(), 0);
  assert.equal(f.media.listeners.length, 0);
});

test('width-only environments keep the same responsive ownership and remove their fallback listener', () => {
  const f = fixture(false, false); f.render(); f.resize(true);
  assert.equal(f.closes.length, 1); f.unmount(); assert.equal(f.win.listeners.length, 0);
});

test('inline dismissal never focuses an unavailable trigger', () => {
  for (const kind of ['disabled', 'removed']) {
    const f = fixture(), tree = f.render();
    if (kind === 'disabled') f.trigger.disabled = true; else f.trigger.remove();
    const other = f.document.createElement('button'); f.document.body.append(other); other.focus();
    tree.props.onKeyDown(key('Escape')); assert.equal(f.document.activeElement, other); f.unmount();
  }
});

test('compact filter CSS changes layout only and keeps the native Choice and Search surfaces', () => {
  const css = fs.readFileSync(path.join(repo, 'music_app/static/css/runtime/playlists-react.css'), 'utf8');
  const section = css.slice(css.indexOf('/* Compact desktop fields'));
  assert.match(section, /--inline \.ui-choice__label \{ display: none;/);
  assert.match(section, /--form \.playlists__filters \{ display: grid;/);
  assert.match(section, /--search-field-height: 28px/);
  assert.doesNotMatch(section, /background|color:|border|outline|box-shadow|#[0-9a-f]/i);
});


test('native close can refuse without an onClose notification, allowing a later resize attempt', async () => {
  const f = fixture(true); f.render(); let attempts = 0;
  f.mountForm(() => {attempts++; return false;});
  f.resize(false); await Promise.resolve();
  assert.equal(f.render().type.name, 'NativeDialog');
  f.resize(false); await Promise.resolve();
  assert.equal(attempts, 2); assert.equal(f.closes.length, 0); f.unmount();
});
