const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {fixture: nativeFixture} = require('./home-friends-native-app-fixture.cjs');
const {installPrivateContext} = require('./private-context-harness.cjs');
const source = path.resolve(__dirname, '../../../music_app/static/js');
let mountViewControl;
test.before(async () => {({mountViewControl} = await import(pathToFileURL(path.join(source, 'home-friends/view-control.mjs'))));});

// Actual native chooser ownership; existing native bridge and events remain.
function fixture(t, {width = 1200} = {}) {
  const native = nativeFixture(t), {context, document} = native;
  // Production owns both the canonical chooser and its trigger-surface adapter.
  // Load the actual bridge rather than substituting the fixture's raw chooser.
  context.dispatchEvent = document.dispatchEvent.bind(document);
  installPrivateContext(context);
  vm.runInContext(fs.readFileSync(path.join(source,'runtime/home-friends-bridge.js'),'utf8'),context,{filename:'home-friends-bridge.js'});
  const bridge = context.AlbumHavenHomeRuntime, mediaQueries = [], mounts = [], focusCalls = [];
  context.matchMedia = query => {
    const record = {query, matches: width <= Number(query.match(/\d+/)[0]), listeners: new Set(),
      addEventListener(type, callback) {assert.equal(type, 'change'); this.listeners.add(callback);},
      removeEventListener(type, callback) {assert.equal(type, 'change'); this.listeners.delete(callback);}};
    mediaQueries.push(record); return record;
  };
  const runtime = {...bridge, mountViewChooser(element, options) {
    // This fixture has no browser focus engine. As in the native owner's own
    // tests, record its focus calls and expose the resulting activeElement.
    for (const button of element.querySelectorAll('button')) button.focus = () => {
      document.activeElement = button; focusCalls.push(button);
    };
    const owner = bridge.mountViewChooser(element, options);
    const record = {element, options, owner, configurations: 0, destroyed: 0}; mounts.push(record);
    return {select: value => owner.select(value), configure(value) {record.configurations++; owner.configure(value);},
      destroy() {record.destroyed++; owner.destroy();}};
  }};
  let owner, disposed = false;
  const host = document.createElement('span'); document.body.appendChild(host);
  const render = props => {
    assert.equal(disposed, false);
    if (owner) owner.update(props); else owner = native.own(mountViewControl(host, runtime, props));
    return host.firstElementChild;
  };
  const emit = (target, type, details = {}) => {
    const event = new context.Event(type); Object.assign(event, details); target.dispatchEvent(event); return event;
  };
  const glyph = mode => {const holder = document.createElement('div'); holder.innerHTML = bridge.viewIconHtml(mode); return holder.innerHTML;};
  return {...native, runtime, host, render, mounts, mediaQueries, focusCalls, emit, glyph,
    resize(next) {width = next; for (const media of mediaQueries) {
      media.matches = next <= Number(media.query.match(/\d+/)[0]); for (const callback of [...media.listeners]) callback();
    }},
    dispose() {owner?.dispose(); disposed = true; host.remove();},
  };
}
const actions = root => root.querySelectorAll('[data-action-value]');
const active = root => actions(root).find(button => button.getAttribute('aria-pressed') === 'true');
const props = extra => ({kind: 'albums', context: 'comparison', value: 'rows', ...extra});

test('comparison owns exactly Rows and Small covers with the native list and cards glyphs', t => {
  const h = fixture(t), changes = [], root = h.render(props({onChange: value => changes.push(value)}));
  assert.deepEqual(actions(root).map(button => [button.dataset.actionValue, button.getAttribute('aria-label')]),
    [['rows', 'Rows'], ['covers', 'Small covers']]);
  assert.equal(root.getAttribute('aria-label'), 'Comparison album view');
  assert.deepEqual(actions(root).map(button => button.querySelector('.action-button__icon').innerHTML), [h.glyph('list'), h.glyph('cards')]);
  assert.ok(actions(root).every(button => button.classList.contains('action-button')));
  assert.equal(active(root).dataset.actionValue, 'rows');
  h.emit(actions(root)[0], 'click', {detail: 1});
  assert.equal(root.classList.contains('is-open'), true);
  h.emit(actions(root)[1].querySelector('svg'), 'click', {detail: 1});
  assert.deepEqual(changes, ['covers']); assert.equal(active(root).dataset.actionValue, 'covers');
  assert.equal(root.classList.contains('is-open'), false);
  assert.strictEqual(h.document.activeElement, actions(root)[1]);
  h.render(props({value: 'covers', onChange: value => changes.push(`current:${value}`)}));
  h.render(props({value: 'rows', onChange: value => changes.push(`current:${value}`)}));
  assert.strictEqual(h.host.firstElementChild, root, 'controlled value synchronization preserves the native owner');
  assert.equal(active(root).dataset.actionValue, 'rows'); assert.equal(h.mounts.length, 1);
  h.mounts[0].options.onSelect('covers'); h.mounts[0].options.onSelect('cards');
  assert.deepEqual(changes, ['covers', 'current:covers'], 'only live comparison choices reach the latest callback');
  h.dispose(); assert.deepEqual(h.forbiddenCalls, []);
});

test('comparison uses the Home 900px boundary and native keyboard focus in both unfolding directions', t => {
  for (const [width, direction, forward] of [[900, 'down', 'ArrowDown'], [901, 'left', 'ArrowRight']]) {
    const h = fixture(t, {width}), changes = [], root = h.render(props({onChange: value => changes.push(value)}));
    assert.equal(h.mediaQueries[0].query, '(max-width: 900px)'); assert.equal(root.dataset.unfoldDirection, direction);
    actions(root)[0].focus(); const event = h.emit(root, 'keydown', {key: forward});
    assert.equal(event.defaultPrevented, true); assert.strictEqual(h.document.activeElement, actions(root)[1]);
    h.emit(root, 'keydown', {key: 'Escape'});
    assert.strictEqual(h.document.activeElement, actions(root)[0]); assert.equal(root.classList.contains('is-open'), false);
    assert.deepEqual(changes, []);
    h.resize(width === 900 ? 901 : 900);
    assert.equal(root.dataset.unfoldDirection, direction === 'down' ? 'left' : 'down');
    assert.equal(h.mounts.length, 1); assert.equal(h.mounts[0].configurations, 1);
    h.dispose(); assert.equal(h.mediaQueries[0].listeners.size, 0);
  }
});

test('same-kind context changes retire the old owner, callback, media listener and open surface', t => {
  const h = fixture(t, {width: 800}), changes = [];
  const ordinary = h.render({kind: 'albums', value: 'cards', onChange: value => changes.push(`old:${value}`)});
  h.emit(actions(ordinary)[1], 'click', {detail: 1});
  assert.equal(ordinary.classList.contains('is-open'), true);
  const oldMount = h.mounts[0], oldMedia = h.mediaQueries[0], oldResize = [...oldMedia.listeners][0];
  const comparison = h.render(props({value: 'covers', onChange: value => changes.push(value)}));
  assert.notStrictEqual(comparison, ordinary); assert.equal(oldMount.destroyed, 1);
  assert.equal(ordinary.classList.contains('is-open'), false); assert.equal(oldMedia.listeners.size, 0);
  assert.equal(ordinary.listeners.length, 0, 'all native root listeners are removed');
  assert.equal(h.document.listeners.filter(entry => entry.type === 'pointerdown').length, 1);
  assert.equal(comparison.dataset.unfoldDirection, 'down'); assert.equal(active(comparison).dataset.actionValue, 'covers');
  oldMount.options.onSelect('list'); oldResize(); h.emit(actions(ordinary)[0], 'click', {detail: 1});
  assert.deepEqual(changes, []); assert.equal(oldMount.configurations, 0, 'queued old media events cannot configure a retired owner');
  const currentMount = h.mounts[1], currentMedia = h.mediaQueries[1], currentResize = [...currentMedia.listeners][0];
  h.emit(actions(comparison)[1], 'click', {detail: 1});
  h.dispose(); currentMount.options.onSelect('rows'); currentResize();
  assert.deepEqual(changes, []); assert.equal(currentMount.destroyed, 1); assert.equal(currentMount.configurations, 0);
  assert.equal(comparison.classList.contains('is-open'), false); assert.equal(comparison.listeners.length, 0);
  assert.equal(h.document.listeners.filter(entry => entry.type === 'pointerdown').length, 0);
  assert.equal(vm.runInContext('activeTriggerSurface', h.context), null);
});

test('ordinary Album, Artist and Track families retain their native choices, labels, glyphs and breakpoint', async t => {
  const {buildRecentViewIcon} = await import(pathToFileURL(path.join(source, 'home-friends/recent-view-icons.mjs')));
  for (const [kind, choices, icons, label] of [
    ['albums', [['list', 'Rows'], ['cards', 'Cards'], ['covers', 'No info']], ['list', 'cards', 'covers'], 'View'],
    ['artists', [['list', 'Rows'], ['cards', 'Circles']], ['list', 'covers'], 'View'],
    ['tracks', [['grouped', 'Grouped tracks'], ['history', 'Listening history']], null, 'Track grouping'],
  ]) {
    const h = fixture(t, {width: 800}), changes = [], value = choices[0][0];
    const root = h.render({kind, value, onChange: next => changes.push(next)});
    assert.deepEqual(actions(root).map(button => [button.dataset.actionValue, button.getAttribute('aria-label')]), choices);
    assert.equal(root.getAttribute('aria-label'), label); assert.equal(h.mediaQueries[0].query, '(max-width: 600px)');
    assert.equal(root.dataset.unfoldDirection, 'left'); h.resize(600); assert.equal(root.dataset.unfoldDirection, 'down');
    const glyphs = actions(root).map(button => button.querySelector('.action-button__icon').innerHTML);
    if (icons) assert.deepEqual(glyphs, icons.map(h.glyph));
    else assert.deepEqual(glyphs, choices.map(([mode]) => {
      const holder = h.document.createElement('div'); holder.innerHTML = buildRecentViewIcon(mode); return holder.innerHTML;
    }));
    h.emit(actions(root)[0], 'click', {detail: 1}); h.emit(actions(root).at(-1), 'click', {detail: 1});
    assert.deepEqual(changes, [choices.at(-1)[0]]);
    h.dispose(); assert.deepEqual(h.forbiddenCalls, []);
  }
});
