const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {installNativeSearch} = require('./native-search-harness.cjs');
const bundles = new Map();
const elements = node => React.isValidElement(node)
  ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const component = (tree, name) => elements(tree).find(node => node.type?.name === name);
const buttons = tree => elements(tree).filter(node => node.type?.name === 'Button');
const button = (tree, label) => buttons(tree).find(node => {
  const text = React.Children.toArray(node.props.children).join('');
  return typeof label === 'string' ? text === label : label.test(text);
});
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const settle = () => new Promise(resolve => setImmediate(resolve));

// Bounded handler/effect execution of the real component tree with distinct hook
// lifetimes. This is not React reconciliation, browser event propagation, native
// layout/focus/geometry verification or owner acceptance. NativeDialog itself runs.
function bundle(entry) {
  const source = path.resolve(__dirname, '../../../music_app/static/js', entry);
  if (!bundles.has(source)) bundles.set(source, buildSync({entryPoints: [source], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text);
  return bundles.get(source);
}
function componentExports(entry) {
  const loaded = new Module(`${__filename}.${entry.replace(/\W/g, '-')}.fixture.cjs`, module);
  loaded.filename = loaded.id; loaded.paths = module.paths; loaded._compile(bundle(entry), loaded.filename);
  return loaded.exports;
}
function hookDriver(entry) {
  const fibers = new Map(); let current, rootTree, lateUpdates = 0;
  const changed = (previous, deps) => !previous || !deps || !previous.deps
    || deps.length !== previous.deps.length || deps.some((value, index) => !Object.is(value, previous.deps[index]));
  function effect(callback, deps) {
    const fiber = current, index = fiber.cursor++, previous = fiber.slots[index];
    if (changed(previous, deps)) fiber.pending.push(() => {previous?.cleanup?.(); fiber.slots[index] = {deps, cleanup: callback()};});
  }
  const hooks = {...React,
    useRef(value) {const fiber = current, index = fiber.cursor++; return fiber.slots[index] ||= {current: value};},
    useState(value) {
      const fiber = current, index = fiber.cursor++, slot = fiber.slots[index] ||= {value: typeof value === 'function' ? value() : value};
      return [slot.value, next => {if (fiber.disposed) {lateUpdates++; return;}
        slot.value = typeof next === 'function' ? next(slot.value) : next;}];
    },
    useEffect: effect, useLayoutEffect: effect,
    useSyncExternalStore(subscribe, getSnapshot) {effect(() => subscribe(() => {}), [subscribe, getSnapshot]); return getSnapshot();},
  };
  const loaded = {exports: {}};
  const driver = {exports: loaded.exports,
    render(name, Component, props) {
      const fiber = fibers.get(name) || {slots: [], disposed: false}; fibers.set(name, fiber);
      assert.equal(fiber.disposed, false, 'disposed hook owner must never remount under the old identity');
      current = fiber; fiber.cursor = 0; fiber.pending = [];
      let tree; try {tree = Component(props);} finally {current = null;}
      for (const run of fiber.pending) run();
      return tree;
    },
    renderMounted() {return driver.render('session', rootTree.type, rootTree.props);},
    dispose(name) {
      for (const [key, fiber] of [...fibers.entries()].reverse()) {
        if (fiber.disposed || name && key !== name) continue;
        fiber.disposed = true; for (const slot of fiber.slots) slot?.cleanup?.();
      }
    }, lateUpdates: () => lateUpdates,
  };
  vm.runInNewContext(bundle(entry), {module: loaded, exports: loaded.exports, console, AbortController,
    URL, URLSearchParams, TextEncoder, crypto: {randomUUID: require('node:crypto').randomUUID},
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react-dom') return {createPortal: (children, host) => React.createElement('native-portal', {host}, children)};
      if (name === 'react-dom/client') return {createRoot: () => ({render(tree) {rootTree = tree;}, unmount() {driver.dispose();}})};
      assert.fail(`Unexpected Top sharing dependency ${name}`);
    }});
  driver.exports = loaded.exports; return driver;
}

function nativeRuntime() {
  const native = createNativeHomeRuntime(), search = installNativeSearch(native);
  const calls = {owners: [], closes: [], confirms: []};
  const runtime = {buttonHtml: value => native.context.ButtonComponent.renderButton(value),
    actionHtml: value => native.context.ButtonComponent.renderActionButton(value),
    alertHtml: value => native.context.buildOnPageAlertHtml(value),
    galleryCardHtml: value => native.context.buildGalleryCardHtml(value), artboxHtml: value => native.context.buildAlbumArtboxHtml(value),
    searchHtml: search.render, openChoice: () => ({close() {}}),
    confirm: async (...args) => {calls.confirms.push(args); return false;}, confirmRetryOriginal: async () => false,
    openForm(options) {
      const owner = {options, dismissDisabled: options.dismissDisabled,
        setDismissDisabled(value) {this.dismissDisabled = value;},
        close(_value, closeOptions) {calls.closes.push(closeOptions); options.onClose(null, closeOptions); return true;}};
      calls.owners.push(owner); options.onMount({id: 'native-top-share-host'}); return owner;
    }};
  return {native, runtime, calls};
}
module.exports = {React, elements, component, button, buttons, plain, deferred, settle, hookDriver, componentExports, nativeRuntime};
