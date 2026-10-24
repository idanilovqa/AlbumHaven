const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');

const repo = path.resolve(__dirname, '../../..');
const bundle = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/comparison.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const side = (listen_count, play_count = null) => ({listen_count, play_count, full_listen_count: null, rating: null, favorite: null});
const row = (id, yours, friend, extra = {}) => ({id, title: `Title ${id}`, artist: 'An artist', kind: 'track',
  yours: side(yours), friend: side(friend), ...extra});
const value = rows => ({status: 'ready', data: {rows}});
const walk = tree => tree?.$$typeof === Symbol.for('react.portal') ? walk(tree.children)
  : !React.isValidElement(tree) ? [] : [tree, ...React.Children.toArray(tree.props.children).flatMap(walk)];
const portals = tree => tree?.$$typeof === Symbol.for('react.portal') ? [tree]
  : !React.isValidElement(tree) ? [] : React.Children.toArray(tree.props.children).flatMap(portals);
const component = (tree, name) => walk(tree).find(element => element.type?.name === name);
const state = extra => ({friendRef: 'friend:1', kind: 'tracks', period: 'week', commonOnly: false,
  order: 'general', ascending: false, view: 'rows', selection: null, ...extra});

// Explicit hook commits exercise the real component callbacks against actual
// native Table/Card/Artbox markup. This is not React DOM, CSS geometry, provider
// installation, playback or rendered acceptance coverage. The native chooser
// lifetime itself is covered by home-comparison-view-control.test.js.
function fixture(extra = {}, initialPhone = false, entry = 'ComparisonPanel') {
  const native = createNativeHomeRuntime(), {context, document} = native;
  for (const name of ['runtime/compact-data-table.js', 'unfolding-action-button.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js', name), 'utf8'), context);
  }
  context.Element.prototype.focus = function () {document.activeElement = this;};
  const runtime = {
    buttonHtml: config => context.ButtonComponent.renderButton(config),
    actionHtml: config => context.ButtonComponent.renderActionButton(config),
    tableHtml: config => context.buildCompactDataTable(config),
    galleryCardHtml: config => context.buildGalleryCardHtml(config),
    artboxHtml: config => context.buildAlbumArtboxHtml(config),
    escapeHtml: context.escapeHtml,
  };
  const media = {matches: initialPhone, listeners: new Set(),
    addEventListener(type, callback) {assert.equal(type, 'change'); this.listeners.add(callback);},
    removeEventListener(type, callback) {assert.equal(type, 'change'); this.listeners.delete(callback);}};
  const window = {matchMedia(query) {assert.equal(query, '(max-width: 900px)'); return media;}};
  let cursor = 0, effects = [], slots = [], tree;
  const changed = [], selected = [];
  let props = {runtime, friendName: 'Maya', friendRef: 'friend:1', kind: 'tracks', period: 'week',
    value: value([row('a', 1, 7), row('b', 4, 1)]), presentation: state(),
    onPresentationChange: next => changed.push(next), onSelection: next => selected.push(next), ...extra};
  if (props.viewControlsHost) props.viewControlsHost = document.createElement('header');
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useState(value) {const index = cursor++; if (!(index in slots)) slots[index] = typeof value === 'function' ? value() : value;
      return [slots[index], next => {slots[index] = typeof next === 'function' ? next(slots[index]) : next;}];},
    useMemo(callback, deps) {const index = cursor++, old = slots[index];
      if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) slots[index] = {deps, value: callback()};
      return slots[index].value;},
    useLayoutEffect(callback, deps) {const index = cursor++, old = slots[index];
      if (!old || deps.some((value, offset) => !Object.is(value, old.deps[offset]))) {
        effects.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: callback()};});
      }},
  };
  const loaded = {exports: {}};
  vm.runInNewContext(bundle, {module: loaded, exports: loaded.exports, window, require: name => name === 'react' ? hooks
    : require(name)});
  const host = document.createElement('section'); document.body.append(host);
  let previousHtml;
  return {...native, host, changed, selected, runtime, media,
    resize(phone) {media.matches = phone; for (const callback of media.listeners) callback();},
    render(next = {}) {
      props = {...props, ...next}; cursor = 0; effects = [];
      tree = loaded.exports[entry](props); if (tree.props.ref) tree.props.ref.current = host;
      const table = walk(tree).find(element => element.type?.name === 'NativeHtml' && element.props.className?.startsWith('home-comparison__table'));
      const html = table?.props.html || '';
      if (previousHtml !== html) {host.innerHTML = html; previousHtml = html;}
      for (const effect of effects) effect(); return tree;
    },
    click(key) {
      const table = walk(tree).find(element => element.type?.name === 'NativeHtml' && element.props.className?.startsWith('home-comparison__table'));
      const button = host.querySelector(`[data-cdt-sort="${key}"]`);
      assert.ok(button, `native heading ${key}`); button.focus();
      const event = {target: button, currentTarget: host, defaultPrevented: false,
        preventDefault() {this.defaultPrevented = true;}, stopPropagation() {}};
      table.props.onClick(event); assert.equal(event.defaultPrevented, true);
    },
    ids() {return host.querySelectorAll('[data-comparison-id]').map(node => node.dataset.comparisonId);},
    last() {return changed.at(-1);},
    dispose() {for (const slot of slots) slot?.cleanup?.(); host.remove();},
  };
}

test('person headings toggle one whole-pair order and General restores the combined baseline', () => {
  const h = fixture(); let tree = h.render();
  assert.deepEqual(h.ids(), ['a', 'b']);
  h.click('yours'); tree = h.render(); assert.deepEqual(h.ids(), ['b', 'a']);
  assert.equal(h.last().order, 'yours'); assert.equal(h.last().ascending, false);
  assert.equal(h.host.querySelector('[data-cdt-column="yours"]').getAttribute('aria-sort'), 'descending');
  assert.match(h.document.activeElement.getAttribute('aria-label'), /Activate for ascending order/);
  h.click('yours'); tree = h.render(); assert.deepEqual(h.ids(), ['a', 'b']);
  assert.equal(h.last().ascending, true);
  h.click('friend'); tree = h.render(); assert.equal(h.last().order, 'friend'); assert.equal(h.last().ascending, false);
  component(tree, 'ComparisonControls').props.onOrder('general'); h.render();
  assert.deepEqual(h.ids(), ['a', 'b']); assert.equal(h.last().order, 'general');
  assert.equal(h.last().ascending, false); assert.equal(h.last().metricSort, null); h.dispose();
});

test('native metric sorting cycles both directions then baseline, preserving zero, unknown and pair identity', () => {
  const rows = [row('high', 9, 1, {friend: side(1, 8)}), row('zero', 1, 2, {friend: side(2, 0)}),
    row('unknown', 99, 1, {friend: side(1, null)})];
  const h = fixture({value: value(rows)}); h.render();
  h.click('friend:play_count'); h.render(); assert.deepEqual(h.ids(), ['zero', 'high', 'unknown']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.last().metricSort)), {side: 'friend', key: 'play_count', direction: 'ascending'});
  assert.equal(h.document.activeElement.dataset.cdtSort, 'friend:play_count');
  assert.match(h.document.activeElement.getAttribute('aria-label'), /Sort by Maya PC: ascending/);
  h.click('friend:play_count'); h.render(); assert.deepEqual(h.ids(), ['high', 'zero', 'unknown']);
  h.click('friend:play_count'); h.render(); assert.deepEqual(h.ids(), ['unknown', 'high', 'zero']);
  for (const pair of h.host.querySelectorAll('[data-comparison-id]')) {
    assert.deepEqual(pair.querySelectorAll('[data-home-comparison-select]').map(button => button.dataset.homeComparisonSelect), [pair.dataset.comparisonId, pair.dataset.comparisonId]);
  }
  assert.equal(h.last().metricSort, null); h.dispose();
});

test('sorting retains selected identity and native trigger while selection changes alone do not replace rows', () => {
  const h = fixture(); let tree = h.render();
  const table = component(tree, 'NativeHtml'), button = h.host.querySelector('[data-home-comparison-select="a"]');
  button.focus();
  table.props.onClick({target: button, currentTarget: h.host, defaultPrevented: false});
  tree = h.render();
  assert.equal(h.host.querySelector('[data-home-comparison-select="a"]'), button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  h.click('yours'); tree = h.render();
  assert.equal(h.last().selection.id, 'a');
  assert.equal(component(tree, 'DetailSummary').props.row.id, 'a');
  assert.equal(h.document.activeElement.dataset.cdtSort, 'yours'); h.dispose();
});

test('replaced sources retire old controls and selection gestures while preserving valid local presentation', () => {
  const first = value([row('first', 3, 2)]), second = value([row('second', 1, 4)]);
  const h = fixture({value: first}); const old = h.render(), oldControls = component(old, 'ComparisonControls');
  const oldButton = h.host.querySelector('[data-home-comparison-select="first"]');
  const oldTable = component(old, 'NativeHtml');
  let tree = h.render({value: second});
  assert.notEqual(component(tree, 'ComparisonControls').key, oldControls.key);
  oldControls.props.onOrder('friend'); oldControls.props.onCommonOnly(true);
  oldTable.props.onClick({target: oldButton, currentTarget: h.host, defaultPrevented: false});
  tree = h.render();
  assert.equal(h.last().order, 'general'); assert.equal(h.last().commonOnly, false);
  assert.deepEqual(h.selected, []); assert.deepEqual(h.ids(), ['second']); h.dispose();
});

test('friend, kind and period changes reset scoped sort/view and retire header portal callbacks', () => {
  for (const next of [{friendRef: 'friend:2'}, {kind: 'tracks'}, {period: 'month'}]) {
    const h = fixture({kind: 'albums', value: value([row('album:1', 2, 3, {kind: 'album'})]),
      presentation: state({kind: 'albums', view: 'covers', metricSort: {side: 'friend', key: 'rating', direction: 'descending'}}),
      viewControlsHost: {name: 'native header'}});
    const old = h.render(), oldView = component(old, 'ViewControl');
    assert.equal(portals(old)[0].containerInfo.tagName, 'HEADER');
    let tree = h.render(next); tree = h.render();
    oldView.props.onChange('covers'); component(old, 'ComparisonControls').props.onOrder('friend'); tree = h.render();
    assert.equal(h.last().view, 'rows'); assert.equal(h.last().order, 'general'); assert.equal(h.last().metricSort, null);
    assert.equal(component(tree, 'ViewControl')?.props.context ?? 'comparison', 'comparison');
    if (next.kind) assert.equal(component(tree, 'ViewControl'), undefined);
    else assert.notEqual(component(tree, 'ViewControl').key, oldView.key);
    h.dispose();
  }
});

test('new page, common filter and denial clear selection, and unreadable sources never retain details', () => {
  for (const replacement of [value([row('other', 3, 2)]), {status: 'denied', data: null}, {status: 'empty', data: {rows: []}}]) {
    const h = fixture({presentation: state({selection: {id: 'selected', kind: 'track'}}), value: value([row('selected', 3, 2)])});
    assert.equal(component(h.render(), 'DetailSummary').props.row.id, 'selected');
    let tree = h.render({value: replacement}); tree = h.render();
    assert.equal(component(tree, 'DetailSummary').props.row, null); assert.equal(h.last().selection, null);
    assert.equal(h.selected.at(-1), null); h.dispose();
  }
  const h = fixture({presentation: state({selection: {id: 'own-only', kind: 'track'}}), value: value([row('own-only', 3, null)])});
  let tree = h.render(); component(tree, 'ComparisonControls').props.onCommonOnly(true); tree = h.render(); h.render();
  assert.equal(component(tree, 'DetailSummary').props.row, null); assert.equal(h.last().selection, null); h.dispose();
});

test('unmount and blocked resource changes reject retained card/header callbacks', () => {
  for (const blocked of ['unmount', 'loading', 'denied', 'unavailable', 'error']) {
    const h = fixture({kind: 'albums', presentation: state({kind: 'albums', view: 'covers'}), value: value([row('album', 3, 2, {kind: 'album'})])});
    const old = h.render(), cards = component(old, 'ComparisonCards'), view = component(old, 'ViewControl');
    if (blocked === 'unmount') h.dispose(); else h.render({value: {status: blocked, data: null}});
    cards.props.onSelect(cards.props.rows[0]); view.props.onChange('rows');
    component(old, 'ComparisonControls').props.onOrder('friend');
    assert.deepEqual(h.selected, []);
    if (blocked !== 'unmount') {
      const tree = h.render(); assert.equal(component(tree, 'DetailSummary').props.row, null);
      assert.equal(h.last().order, 'general'); assert.equal(h.last().view, 'covers'); h.dispose();
    }
  }
});


test('native phone resize switches covers to one shared identity and releases its media listener', () => {
  const h = fixture({kind: 'albums', presentation: state({kind: 'albums', view: 'covers'}),
    value: value([row('album', 3, 2, {kind: 'album'})])}, true);
  let tree = h.render();
  assert.equal(component(tree, 'ComparisonCards'), undefined);
  assert.equal(h.host.querySelectorAll('.album-card').length, 1);
  assert.equal(h.host.querySelectorAll('[data-home-comparison-select]').length, 1);
  h.resize(false); tree = h.render();
  assert.equal(component(tree, 'ComparisonCards').props.rows[0].id, 'album');
  assert.equal(h.host.querySelectorAll('[data-home-comparison-select]').length, 0, 'the desktop sort strip has no duplicate row controls');
  h.resize(true); tree = h.render(); assert.equal(component(tree, 'ComparisonCards'), undefined);
  assert.equal(h.last().view, 'covers'); assert.equal(h.host.querySelectorAll('.album-card').length, 1);
  assert.equal(h.media.listeners.size, 1); h.dispose(); assert.equal(h.media.listeners.size, 0);
});


test('cover focus highlights the matching stable identity and announces only that counterpart', () => {
  const rows = [row('album:a', 3, 0, {kind: 'album', title: 'Same name'}), row('album:b', 1, null, {kind: 'album', title: 'Same name'})];
  const h = fixture({rows, kind: 'albums', onSelect() {}}, false, 'ComparisonCards');
  const pair = (tree, id) => walk(tree).find(node => node.props['data-comparison-id'] === id);
  const sideOf = (tree, id, side) => walk(pair(tree, id)).find(node => node.type === 'section' && node.props['data-comparison-side'] === side);
  let tree = h.render();
  sideOf(tree, 'album:a', 'yours').props.onFocusCapture(); tree = h.render();
  assert.equal(sideOf(tree, 'album:a', 'friend').props['data-comparison-highlighted'], 'true');
  assert.equal(sideOf(tree, 'album:b', 'friend').props['data-comparison-highlighted'], undefined);
  const announcement = walk(tree).find(node => node.props.role === 'status').props.children;
  assert.match(announcement, /Maya, matching album: Same name/); assert.match(announcement, /Track listens: 0/);
  tree = h.render({rows: [...rows].reverse()}); tree = h.render();
  sideOf(tree, 'album:a', 'yours').props.onFocusCapture(); tree = h.render();
  assert.equal(sideOf(tree, 'album:a', 'friend').props['data-comparison-highlighted'], 'true');
  assert.equal(sideOf(tree, 'album:b', 'friend').props['data-comparison-highlighted'], undefined);
  tree = h.render({rows: [rows[1]]}); tree = h.render();
  assert.equal(sideOf(tree, 'album:b', 'friend').props['data-comparison-highlighted'], undefined);
  assert.equal(walk(tree).find(node => node.props.role === 'status').props.children, ''); h.dispose();
});
