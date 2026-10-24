const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const repo = path.resolve(__dirname, '../../..');
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playtables/selection.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom/client']}).outputFiles[0].text;

// Bounded hook driver exercises the real React owner and native event adapter.
// Real browser layout and React scheduling remain a separate verification gate.
function fixture(t) {
  const native = createNativeHomeRuntime(), doc = native.document;
  const host = doc.createElement('section'); doc.body.appendChild(host);
  host.before = node => host.parentNode.insertBefore(node, host);
  host.innerHTML = '<div data-cdt-row-key="a" tabindex="0">A</div><div data-cdt-row-key="b" tabindex="0">B</div>';
  const runtime = {buttonHtml: options => native.context.ButtonComponent.renderButton(options)};
  let value = {scopeKey: 'owned', instance: {}, rows: ['a', 'b'].map(rowKey => ({rowKey, readable: true, selectable: true}))};
  const listeners = new Set(), actions = [], roots = [], slots = [];
  const adapter = {snapshot: () => value, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);}};
  let cursor = 0, effects = [], element, tree;
  const changed = (old, deps) => !old || !deps || !old.deps || deps.some((value, index) => !Object.is(value, old.deps[index]));
  const hooks = {...React,
    useRef(initial) {return slots[cursor++] ||= {current: initial};},
    useState(initial) {const slot = slots[cursor++] ||= {value: initial}; return [slot.value, value => {slot.value = value;}];},
    useLayoutEffect(callback, deps) {const index = cursor++, old = slots[index];
      if (changed(old, deps)) effects.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: callback()};});},
  };
  const root = {
    render(next) {element = next; cursor = 0; effects = []; tree = element.type(element.props); for (const effect of effects) effect();},
    unmount() {for (const slot of slots) slot?.cleanup?.();},
  };
  const loaded = {exports: {}};
  vm.runInNewContext(built, {module: loaded, exports: loaded.exports, AbortController, console,
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react-dom/client') return {createRoot: node => {roots.push(node); return root;}};
      assert.fail(`Unexpected dependency: ${name}`);
    }});
  const mount = loaded.exports.mountPlaytableSelection(host, {sourceAdapter: adapter, tableKey: 'test', runtime,
    onPlaylistAction: (packet, lifetime) => actions.push({packet, lifetime})});
  t.after(() => mount.dispose());
  return {host, doc, root, roots, mount, runtime, adapter, actions, listeners, exports: loaded.exports,
    render() {root.render(element); return tree;},
    click(key) {const event = new native.context.Event('click'); host.querySelector(`[data-cdt-row-key="${key}"]`).dispatchEvent(event);},
    patch(patch) {value = {...value, ...patch}; for (const listener of [...listeners]) listener();},
  };
}

test('native mount creates a React action sibling and retains table nodes through selection and refresh', t => {
  const value = fixture(t), before = value.host.querySelector('[data-cdt-row-key="a"]');
  assert.equal(value.roots[0].parentElement, value.host.parentElement);
  assert.notEqual(value.roots[0], value.host);
  value.click('a'); const actions = value.render();
  assert.equal(actions.props.snapshot.selectedCount, 1);
  assert.equal(value.mount.getSnapshot().selectedCount, 1);
  assert.equal(value.host.querySelector('[data-cdt-row-key="a"]'), before);
  value.mount.update(); assert.equal(value.host.querySelector('[data-cdt-row-key="a"]'), before);
  assert.equal(value.mount.openSelection(before), true); assert.equal(value.actions.length, 1);
});

test('React replacement adapter retires previous receipts and disposal releases roots and listeners', t => {
  const value = fixture(t); value.click('a'); value.mount.openSelection(value.host);
  const previous = value.actions[0].lifetime;
  const next = {snapshot: () => ({scopeKey: 'new', instance: 'new-instance', rows: [{rowKey: 'a', readable: true, selectable: true}]}),
    subscribe: () => () => {}};
  value.mount.update({sourceAdapter: next});
  assert.equal(previous.isCurrent(), false); assert.equal(value.listeners.size, 0);
  assert.equal(value.mount.getSnapshot().selectedCount, 0);
  value.click('a'); assert.equal(value.mount.getSnapshot().scopeKey, 'new');
  value.mount.dispose(); assert.equal(value.host.listeners.length, 0); assert.equal(value.roots[0].isConnected, false);
});

test('selected-count affordance consumes native Button with disabled and filtered-count states', t => {
  const value = fixture(t), ownerRef = {current: {openSelection() {}}};
  const render = patch => value.exports.PlaytableSelectionActions({runtime: value.runtime, ownerRef,
    snapshot: {selectedCount: 0, droppedCount: 0, ...patch}});
  const empty = React.Children.toArray(render().props.children);
  assert.equal(empty[1].props.disabled, true); assert.equal(empty[1].props.children, 'Add to playlist');
  const filtered = React.Children.toArray(render({selectedCount: 1, droppedCount: 2}).props.children);
  assert.equal(filtered[1].props.disabled, false);
  const status = React.Children.toArray(filtered[0].props.children).join('');
  assert.match(status, /1 row selected/); assert.match(status, /2 no longer visible or selectable/);
  assert.equal(filtered[0].props['aria-live'], 'polite');
  assert.match(fs.readFileSync(path.join(repo, 'music_app/static/css/runtime/album-track-table.css'), 'utf8'), /selection-actions[^{}]*\{[^}]*flex-wrap: wrap/);
});

test('consumer source construction is inert until commit and effect replay replaces disposed native adapters', () => {
  const slots = []; let cursor = 0, effects = [], created = 0, retired = 0, updated = 0;
  const hooks = {...React,
    useRef(initial) {return slots[cursor++] ||= {current: initial};},
    useMemo(factory, deps) {const index = cursor++, old = slots[index];
      if (!old || deps.some((value, index) => value !== old.deps[index])) slots[index] = {deps, value: factory()};
      return slots[index].value;},
    useLayoutEffect(callback, deps) {const index = cursor++, old = slots[index];
      if (!old || deps.some((value, index) => value !== old.deps[index])) effects.push(() => {
        old?.cleanup?.(); slots[index] = {deps, callback, cleanup: callback()};
      });},
  };
  const loaded = {exports: {}};
  vm.runInNewContext(built, {module: loaded, exports: loaded.exports, AbortController,
    require(name) {if (name === 'react') return hooks; if (name === 'react-dom/client') return {}; assert.fail(name);}});
  const instance = {}, context = {scopeKey: 'owned'}, rows = [{id: 'a'}];
  const runtime = {openPlaylistAction() {}, createPlaytableSource() {
    created++; let disposed = false;
    return {snapshot: () => disposed ? null : {scopeKey: 'owned', instance}, subscribe: () => () => {},
      updateRows() {assert.equal(disposed, false); updated++; return true;}, resolveRows: () => null,
      dispose() {disposed = true; retired++;}};
  }};
  const result = loaded.exports.usePlaytableSource({runtime, sourceRows: rows, rows, context, instance, revision: rows,
    isCurrent: () => true, rowFacts: row => ({rowKey: row.id, readable: true})});
  assert.equal(created, 0); assert.equal(result.sourceAdapter.snapshot(), null);
  for (const effect of effects) effect();
  assert.equal(created, 1); assert.equal(updated, 1); assert.equal(result.sourceAdapter.snapshot().instance, instance);
  for (const slot of slots) slot.cleanup?.();
  assert.equal(retired, 1); assert.equal(result.sourceAdapter.snapshot(), null);
  for (const slot of slots) if (slot.callback) slot.cleanup = slot.callback();
  assert.equal(created, 2); assert.equal(updated, 2); assert.equal(result.sourceAdapter.snapshot().instance, instance);
  for (const slot of slots) slot.cleanup?.();
  assert.equal(retired, 2);
});
