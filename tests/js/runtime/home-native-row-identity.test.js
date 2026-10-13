const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const repo = path.resolve(__dirname, '../../..');
function fixture(entry, name) {
  const native = createNativeHomeRuntime(), template = native.document.createElement('script');
  template.id = 'navigation-tree-item-template'; template.textContent = fs.readFileSync(path.join(repo, 'music_app/templates/components/navigation-tree-item.html'), 'utf8');
  native.document.body.append(template);
  vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/navigation-tree.js'), 'utf8'), native.context);
  const runtime = {navigationItemHtml: config => native.context.NavigationTree.renderItem(config),
    artboxHtml: config => native.context.buildAlbumArtboxHtml(config), escapeHtml: value => String(value)};
  const frames = new Map(); let sequence = 0;
  native.document.defaultView = {requestAnimationFrame: callback => {frames.set(++sequence, callback); return sequence;}, cancelAnimationFrame: id => frames.delete(id)};
  const slots = []; let cursor = 0, effects = [], tree, initialized = false;
  const effect = (callback, deps) => {
    const index = cursor++, prior = slots[index];
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) effects.push(() => {prior?.cleanup?.(); slots[index] = {deps, cleanup: callback()};});
  };
  const hooks = {...React, useRef(initial) {return slots[cursor++] ||= {current: initial};}, useEffect: effect, useLayoutEffect: effect};
  const code = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends', entry)], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react']}).outputFiles[0].text;
  const mod = {exports: {}};
  vm.runInNewContext(code, {module: mod, exports: mod.exports, require: value => value === 'react' ? hooks : require(value), console});
  const root = native.document.createElement('div'); native.document.body.append(root);
  // Bounded native update/handler fixture. It deliberately DOES NOT emulate
  // React DOM reconciliation, browser focus or real paint scheduling. The
  // dangerous-markup object identity contract is asserted directly.
  function render(props) {
    cursor = 0; effects = [];
    let Component = mod.exports[name];
    if (name === 'ArtistSelectionRows') {const rows = Component({runtime, rows: [props.row], selectedId: props.selected ? props.row.id : null, onSelect: props.onSelect});
      Component = rows.props.children[0].type;}
    tree = Component({runtime, ...props}); tree.props.ref.current = root;
    if (!initialized) {root.innerHTML = tree.props.dangerouslySetInnerHTML.__html; initialized = true;}
    for (const run of effects) run(); return tree;
  }
  return {runtime, root, frames, render, click() {tree.props.onClick(native.event('click', root.firstElementChild));},
    frame() {const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback());},
    dispose() {for (const slot of slots) slot?.cleanup?.(); root.remove();}};
}
const artist = patch => ({id: 'artist:one', title: 'Artist One', listen_count: 3, source_readable: true, allowed_actions: {can_read: true}, ...patch});
const person = {account_ref: 'member:one', display_name: 'Person One', handle: 'person', avatar_url: null};
const personProps = patch => ({person, rowKey: 'person:one', selected: false, disabled: false, ...patch});

for (const kind of ['artist', 'person']) test(`${kind} row retains one initial markup object while native updates reconcile current state`, () => {
  const h = fixture(kind === 'artist' ? 'artist-selection.jsx' : 'friends-directory.jsx', kind === 'artist' ? 'ArtistSelectionRows' : 'PersonNavigation');
  const initial = kind === 'artist' ? {row: artist(), selected: false} : personProps();
  const first = h.render(initial), button = h.root.firstElementChild;
  const same = h.render({...initial}); assert.equal(same.props.dangerouslySetInnerHTML, first.props.dangerouslySetInnerHTML);
  const changed = kind === 'artist' ? {...initial, selected: true, row: artist({title: 'Artist Updated'})}
    : {...initial, selected: true, person: {...person, display_name: 'Person Updated'}};
  const tree = h.render(changed);
  assert.equal(tree.props.dangerouslySetInnerHTML, first.props.dangerouslySetInnerHTML);
  assert.equal(h.root.firstElementChild, button); assert.equal(button.getAttribute('aria-current'), 'true');
  assert.match(button.textContent, /Updated/); h.dispose();
});

test('ArtistRow uses latest readable row callback and blocks a revoked native row', () => {
  const h = fixture('artist-selection.jsx', 'ArtistSelectionRows'), calls = [];
  const first = artist(), updated = artist({title: 'New'});
  h.render({row: first, onSelect: row => calls.push(['old', row])});
  h.render({row: updated, onSelect: row => calls.push(['new', row])}); h.click();
  assert.deepEqual(calls, [['new', updated]]);
  h.render({row: artist({source_readable: false}), onSelect: row => calls.push(['revoked', row])});
  assert.equal(h.root.firstElementChild.disabled, true); assert.match(h.root.textContent, /Unavailable artist/);
  h.click(); assert.equal(calls.length, 1); h.dispose();
});

test('PersonNavigation selected parent rerender does not retire two-frame activation or its latest callback', () => {
  const h = fixture('friends-directory.jsx', 'PersonNavigation'), calls = []; let selected = false;
  const props = () => personProps({selected, onSelect() {selected = true; h.render(props());}, onActivate: () => calls.push(selected ? 'current' : 'old')});
  const first = h.render(props()); h.click();
  assert.equal(h.render(props()).props.dangerouslySetInnerHTML, first.props.dangerouslySetInnerHTML);
  assert.equal(h.root.firstElementChild.getAttribute('aria-current'), 'true');
  assert.deepEqual(calls, []); h.frame(); assert.deepEqual(calls, []); h.frame(); assert.deepEqual(calls, ['current']); h.dispose();
});

for (const retirement of ['disabled', 'hidden', 'unmount']) test(`PersonNavigation cancels deferred activation after ${retirement}`, () => {
  const h = fixture('friends-directory.jsx', 'PersonNavigation'), calls = [];
  const props = personProps({onActivate: () => calls.push('activate')}); h.render(props); h.click(); h.frame();
  if (retirement === 'disabled') h.render({...props, disabled: true});
  if (retirement === 'hidden') h.root.hidden = true;
  if (retirement === 'unmount') h.dispose();
  h.frame(); assert.deepEqual(calls, []);
  if (retirement !== 'unmount') h.dispose(); assert.equal(h.frames.size, 0);
});

test('newer same-row activation cancels an earlier pending frame chain', () => {
  const h = fixture('friends-directory.jsx', 'PersonNavigation'), calls = [];
  h.render(personProps({onActivate: () => calls.push('activate')}));
  h.click(); h.frame(); h.click(); h.frame(); assert.deepEqual(calls, []);
  h.frame(); assert.deepEqual(calls, ['activate']); h.dispose();
});
