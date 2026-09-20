const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runtime = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const read = name => fs.readFileSync(path.join(runtime, `${name}.js`), 'utf8');
const makeLoop = (id, song = 'track:1', extra = {}) => ({ id, song_key: song, song_identity_status: song ? 'resolved' : 'unresolved', order_revision: song ? 7 : null, can_reorder: Boolean(song), name: `Loop ${id}`, artist: 'Same Artist', album: 'Same Album', title: 'Same Song', duration_seconds: 20, ...extra });

class Element {
  constructor(attributes = {}, tagName = 'DIV') {
    this.attributes = { ...attributes }; this.tagName = tagName; this.children = []; this.parentNode = null;
    this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.scrollTop = 81;
    this.listeners = new Map(); this.classes = new Set((attributes.class || '').split(' ').filter(Boolean));
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: name => this.classes.has(name), toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.currentTime = tagName === 'AUDIO' ? 12 : undefined;
    this.paused = tagName === 'AUDIO' ? false : undefined;
    this.pauseCalls = 0; this.playCalls = 0;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  set innerHTML(html) {
    this._html = String(html);
    this.replaceChildren();
    const stack = [this];
    for (const match of this._html.matchAll(/<(\/?)([\w-]+)([^>]*)>/g)) {
      const tag = match[2].toUpperCase();
      if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
      const attributes = {};
      for (const attribute of match[3].matchAll(/([\w:-]+)(?:="([^"]*)"|='([^']*)')?/g)) attributes[attribute[1]] = attribute[2] ?? attribute[3] ?? '';
      const node = new Element(attributes, tag);
      stack.at(-1).appendChild(node);
      if (!['INPUT', 'IMG', 'BR', 'HR', 'META', 'LINK'].includes(tag) && !match[3].trim().endsWith('/')) stack.push(node);
    }
  }
  get innerHTML() { return this._html || ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  dispatch(name, extra = {}) { return this.listeners.get(name)?.({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
  appendChild(node) { if (node.parentNode) node.remove(); this.children.push(node); node.parentNode = this; return node; }
  insertBefore(node, before) { if (node === before) return node; if (node.parentNode) node.remove(); const index = this.children.indexOf(before); if (index < 0) return this.appendChild(node); this.children.splice(index, 0, node); node.parentNode = this; return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(value => this.matches(value.trim()));
    const simple = selector.trim().split(/\s+/).at(-1);
    const attribute = simple.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
    if (attribute) return Object.hasOwn(this.attributes, attribute[1]) && (attribute[2] === undefined || this.attributes[attribute[1]] === attribute[2]);
    if (simple.startsWith('.')) return this.classes.has(simple.slice(1));
    return this.tagName.toLowerCase() === simple.toLowerCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { const index = this.parentNode?.children.indexOf(this) || 0; return { top: index * 100, bottom: index * 100 + 90, left: 0, width: 400, height: 90 }; }
  animate() { return { finished: Promise.resolve(), cancel() {} }; }
  pause() { this.pauseCalls += 1; this.paused = true; }
  play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); }
}
function panel(loop) {
  const node = new Element({ class: 'utility-loop-entry', 'data-utility-loop-entry': loop.id });
  node.appendChild(new Element({ 'data-loop-audio': loop.id }, 'AUDIO'));
  const range = new Element({ 'data-loop-range-owner': `saved-loop-${loop.id}` });
  range._loopRangeController = { retainedRange: { startSeconds: 3, endSeconds: 8 } };
  node.appendChild(range);
  return node;
}
function setup() {
  const loops = [makeLoop('a'), makeLoop('b'), makeLoop('c'), makeLoop('other', 'track:2')];
  const detail = new Element(); const panels = new Element({ class: 'utility-loop-entry-list', 'data-loop-panel-song': 'track:1' }); detail.appendChild(panels);
  const list = new Element(); const treeChildren = new Element({ class: 'utility-loop-tree-children', 'data-loop-tree-song': 'track:1' }); list.appendChild(treeChildren);
  for (const loop of loops.filter(item => item.song_key === 'track:1')) {
    panels.appendChild(panel(loop)); treeChildren.appendChild(new Element({ 'data-utility-loop-id': loop.id, 'data-utility-loop-group-key': loop.song_key }));
  }
  const overlay = new Element(); overlay.append(detail, list);
  const elements = { overlay, detail, list, count: {}, search: new Element() };
  const requests = []; const renders = []; const created = []; const removed = [];
  let completeResponse;
  const response = new Promise(resolve => { completeResponse = resolve; });
  const context = {
    console: { error() {} }, window: {}, document: overlay, state: { utility: {
      loops, activeTab: 'loops', selectedLoopGroupKey: 'track:1', selectedLoopId: 'b', selectedLoopDetailMode: 'group', loopsLoaded: true,
      collapsedLoopGroups: {}, loopsSearchQuery: '', searchQuery: 'Problems unchanged', rulesSearchQuery: 'Rules unchanged',
      allowedActions: { 'library.loops.reorder': true }, loopOrderRevisions: { 'track:1': 7, 'track:2': 7 },
    } },
    getUtilityModalElements: () => elements,
    renderUtilityModalContent: () => renders.push('full'), showToast() {}, escapeHtml: value => String(value ?? ''),
    requestAnimationFrame: fn => { fn(0); return 1; }, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false }), setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return response; },
    initializeUtilityLoopPlayer: loop => created.push(loop.id), disposeMountedLoopActions: node => removed.push(node),
    bindOverlayPointerOrigin() {}, closeUtilityModal() {}, renderPlaybackControlCluster: () => '',
  };
  context.document.createElement = tag => new Element({}, tag.toUpperCase());
  context.document.activeElement = panels.children[1];
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(runtime, '../button-component.js'), 'utf8'), context);
  for (const name of ['player-and-waveform', 'utility-list-builders', 'utility-loop-playback', 'utility-renderers-and-actions', 'track-modal-and-gallery']) vm.runInContext(read(name), context);
  context.renderUtilityModalContent = () => renders.push('full');
  context.initializeUtilityLoopPlayer = loop => created.push(loop.id);
  context.disposeMountedLoopActions = node => removed.push(node);
  const finish = (payload, status = 200) => completeResponse({ ok: status >= 200 && status < 300, status, json: async () => payload });
  return { context, loops, elements, panels, treeChildren, requests, renders, created, removed, finish };
}
const item = (id, groupKey = 'track:1') => ({ type: 'loop', id, groupKey });
const order = container => container.children.map(node => node.getAttribute('data-utility-loop-entry') || node.getAttribute('data-utility-loop-id'));

test('L01 filtering to another song selects its detail while matching current songs retain mounted players', () => {
  const h = setup();
  h.context.renderUtilityLoopList = () => {};
  h.context.renderUtilityLoops = () => h.renders.push(h.context.state.utility.selectedLoopGroupKey);
  h.context.state.utility.loops[3].title = 'Exclusive match';
  h.context.state.utility.loopsSearchQuery = 'Loop b';
  h.context.filterUtilityLoopViews();
  assert.deepEqual(h.renders, []);
  assert.equal(h.panels.children[1].hidden, false);
  h.context.state.utility.loopsSearchQuery = 'Exclusive';
  h.context.filterUtilityLoopViews();
  assert.equal(h.context.state.utility.selectedLoopGroupKey, 'track:2');
  assert.equal(h.context.state.utility.selectedLoopId, 'other');
  assert.deepEqual(h.renders, ['track:2']);
});

test('L01 no matching loops displays an explicit detail message without destroying retained players', () => {
  const h = setup(); h.context.renderUtilityLoopList = () => {};
  const retained = h.panels.children[1];
  h.context.state.utility.loopsSearchQuery = 'nothing matches';
  h.context.filterUtilityLoopViews();
  assert.ok(h.elements.detail.querySelector('[data-loop-search-empty]'));
  assert.equal(retained.parentNode, h.panels);
  assert.equal(h.panels.hidden, true);
  h.context.state.utility.loopsSearchQuery = '';
  h.context.filterUtilityLoopViews();
  assert.equal(h.panels.hidden, false);
  assert.equal(h.elements.detail.querySelector('[data-loop-search-empty]').hidden, true);
});

test('L05 approved insertion cues and keyboard moves do not change panel geometry', () => {
  const css = fs.readFileSync(path.resolve(runtime, '../../css/runtime/non-album-and-player.css'), 'utf8');
  assert.match(css, /\.utility-loop-reorder-actions\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.utility-loop-reorder-actions:focus-within\s*\{[^}]*opacity:\s*1/s);
  assert.match(css, /\.utility-loop-entry\.is-dragging[^}]*opacity:\s*0\.35/s);
  assert.match(css, /\.is-drop-before[^}]*::before[^}]*height:\s*3px/s);
  assert.match(css, /var\(--appearance-interaction-outline/);
  assert.match(css, /\.utility-loop-entry\[hidden\][^}]*display:\s*none/s, 'filtered grid panels must override their explicit display rule');
});

test('L05 stable song identity never merges tracks sharing artist album and title', () => {
  const { context, loops } = setup();
  const groups = context.groupUtilityLoops(loops);
  assert.deepEqual(Array.from(groups, group => group.key), ['track:1', 'track:2']);
  assert.deepEqual(Array.from(groups[0].loops, loop => loop.id), ['a', 'b', 'c']);
});

test('L05 unresolved historical loops retain distinct identities without metadata grouping', () => {
  const { context } = setup();
  const groups = context.groupUtilityLoops([makeLoop('old-1', null), makeLoop('old-2', null)]);
  assert.equal(groups.length, 2);
  assert.deepEqual(Array.from(groups, group => group.key), ['unresolved:old-1', 'unresolved:old-2']);
});

test('L05 reorder sends exact song membership and expected revision, excluding other songs', async () => {
  const h = setup();
  const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0], { url: '/loops/reorder', body: { song_key: 'track:1', expected_revision: 7, ordered_ids: ['c', 'a', 'b'] } });
  h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]].map(loop => ({ ...loop, order_revision: 8 })) });
  assert.equal(await pending, true);
  assert.ok(h.context.state.utility.loops.some(loop => loop.id === 'other'));
});

for (const [name, dragged, target, position] of [
  ['same target', item('a'), item('a'), 'after'],
  ['same position', item('a'), item('b'), 'before'],
  ['cross song', item('a'), item('other', 'track:2'), 'before'],
  ['outside', item('a'), null, 'before'],
  ['cancelled boundary', item('c'), item('a'), ''],
  ['song group drag', { type: 'group', id: 'track:1' }, { type: 'group', id: 'track:2' }, 'before'],
]) test(`L05 ${name} makes no request and preserves mounted order`, async () => {
  const h = setup();
  assert.equal(await h.context.reorderUtilityLoops(dragged, target, position), false);
  assert.deepEqual(h.requests, []); assert.deepEqual(order(h.panels), ['a', 'b', 'c']);
});

test('L05 unresolved song cannot submit an order even with a reorder grant', async () => {
  const h = setup();
  h.context.state.utility.loops = [makeLoop('a', null), makeLoop('b', null)];
  assert.equal(await h.context.reorderUtilityLoops(item('b', 'unresolved:a'), item('a', 'unresolved:a'), 'before'), false);
  assert.deepEqual(h.requests, []);
});

for (const direction of ['up', 'down']) test(`L05 accessible move ${direction} uses the same revision-checked mutation`, async () => {
  const h = setup();
  assert.equal(typeof h.context.moveUtilityLoop, 'function');
  const pending = h.context.moveUtilityLoop('b', direction);
  const ids = direction === 'up' ? ['b', 'a', 'c'] : ['a', 'c', 'b'];
  assert.deepEqual(h.requests[0]?.body, { song_key: 'track:1', expected_revision: 7, ordered_ids: ids });
  h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ids, loops: ids.map(id => ({ ...h.loops.find(loop => loop.id === id), order_revision: 8 })) });
  assert.equal(await pending, true);
});

for (const success of [true, false]) test(`L05 ${success ? 'success' : 'rollback'} retains exact audio range and panel nodes`, async () => {
  const h = setup();
  const original = [...h.panels.children]; const audio = original[1].querySelector('[data-loop-audio]');
  const range = original[1].querySelector('[data-loop-range-owner]')._loopRangeController;
  const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  assert.deepEqual(order(h.panels), ['c', 'a', 'b']);
  assert.deepEqual(order(h.treeChildren), ['c', 'a', 'b']);
  assert.deepEqual(h.renders, []);
  h.finish(success ? { ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]].map(loop => ({ ...loop, order_revision: 8 })) } : { ok: false, error: 'Write failed' }, success ? 200 : 500);
  assert.equal(await pending, success);
  assert.deepEqual(order(h.panels), success ? ['c', 'a', 'b'] : ['a', 'b', 'c']);
  assert.deepEqual(order(h.treeChildren), order(h.panels));
  for (const node of original) assert.ok(h.panels.children.includes(node));
  assert.equal(original[1].querySelector('[data-loop-audio]'), audio);
  assert.equal(audio.currentTime, 12); assert.equal(audio.paused, false); assert.equal(audio.pauseCalls, 0);
  assert.equal(original[1].querySelector('[data-loop-range-owner]')._loopRangeController, range);
  assert.deepEqual(range.retainedRange, { startSeconds: 3, endSeconds: 8 });
  assert.equal(h.elements.list.scrollTop, 81); assert.deepEqual(h.renders, []);
});

test('L05 stale revision reconciles latest membership while retaining surviving media', async () => {
  const h = setup(); const survivor = h.panels.children[1]; const audio = survivor.querySelector('[data-loop-audio]');
  const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  assert.equal(h.requests.length, 1);
  h.finish({ ok: false, error: 'Order changed', song_key: 'track:1', order_revision: 9, ordered_ids: ['b', 'c'], loops: [h.loops[1], h.loops[2]].map(loop => ({ ...loop, order_revision: 9 })) }, 409);
  assert.equal(await pending, false);
  assert.deepEqual(order(h.panels), ['b', 'c']);
  assert.equal(h.panels.children[0], survivor); assert.equal(survivor.querySelector('[data-loop-audio]'), audio);
  assert.equal(audio.paused, false); assert.deepEqual(h.created, []);
});

test('L05 a late reorder response cannot repaint the new active tab', async () => {
  const h = setup(); const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  assert.equal(h.requests.length, 1);
  h.context.state.utility.activeTab = 'rules';
  h.elements.detail.replaceChildren(new Element({ id: 'new-rules-view' }));
  const current = h.elements.detail.firstElementChild;
  h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]] });
  await pending;
  assert.equal(h.elements.detail.firstElementChild, current);
  assert.deepEqual(h.renders, []);
});

test('L05 a second pending reorder cannot race the same song revision', async () => {
  const h = setup(); const first = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  assert.equal(h.requests.length, 1);
  assert.equal(await h.context.reorderUtilityLoops(item('a'), item('b'), 'after'), false);
  assert.equal(h.requests.length, 1);
  h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]] });
  await first;
});

test('L05 missing reorder authority never submits a mutation', async () => {
  const h = setup(); h.context.state.utility.allowedActions = {};
  assert.equal(await h.context.reorderUtilityLoops(item('c'), item('a'), 'before'), false);
  assert.deepEqual(h.requests, []);
});

test('L05 conflict membership creates only new players and preserves surviving audio', async () => {
  const h = setup(); const survivor = h.panels.children[1];
  const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  assert.equal(h.requests.length, 1);
  h.finish({ ok: false, error: 'Song changed', song_key: 'track:1', order_revision: 10, ordered_ids: ['b', 'new'], loops: [{ ...h.loops[1], order_revision: 10 }, makeLoop('new', 'track:1', { order_revision: 10 })] }, 409);
  await pending;
  assert.deepEqual(order(h.panels), ['b', 'new']);
  assert.equal(h.panels.children[0], survivor);
  assert.deepEqual(h.created, ['new']);
  assert.equal(survivor.querySelector('[data-loop-audio]').paused, false);
});

for (const [query, ids] of [['owned title', ['a']], ['OTHER ARTIST', ['b']], ['special album', ['c']], ['bridge name', ['d']], ['no match', []], ['', ['a', 'b', 'c', 'd']]]) {
  test(`L01 independent Loops query matches ${query || 'all records'}`, () => {
    const h = setup();
    h.context.state.utility.loops = [makeLoop('a', 'track:1', { title: 'Owned title' }), makeLoop('b', 'track:2', { artist: 'Other Artist' }), makeLoop('c', 'track:3', { album: 'Special Album' }), makeLoop('d', 'track:4', { name: 'Bridge Name' })];
    h.context.state.utility.loopsSearchQuery = query;
    assert.equal(typeof h.context.getFilteredUtilityLoops, 'function');
    assert.deepEqual(Array.from(h.context.getFilteredUtilityLoops(), loop => loop.id), ids);
    assert.equal(h.context.state.utility.searchQuery, 'Problems unchanged');
    assert.equal(h.context.state.utility.rulesSearchQuery, 'Rules unchanged');
    assert.equal(h.context.state.utility.loops.length, 4);
  });
}

test('L01 Loops search remains enabled with an empty saved-loop collection', () => {
  const h = setup(); h.context.state.utility.loops = [];
  h.context.renderUtilityLoops();
  assert.equal(h.elements.search.disabled, false);
});

for (const type of ['input', 'search']) test(`L01 shared ${type} event updates only the Loops query`, () => {
  const h = setup(); h.context.attachUtilityModalEvents();
  h.elements.search.value = 'Bridge Name'; h.elements.search.dispatch(type);
  assert.equal(h.context.state.utility.loopsSearchQuery, 'Bridge Name');
  assert.equal(h.context.state.utility.searchQuery, 'Problems unchanged');
  assert.equal(h.context.state.utility.rulesSearchQuery, 'Rules unchanged');
});

for (const containerType of ['tree', 'panel'])
for (const [label, sourceIndex, clientY, targetIndex, position, ordered] of [
  ['above first', 2, -8, 0, 'before', ['c', 'a', 'b']],
  ['between rows', 2, 95, 1, 'before', ['a', 'c', 'b']],
  ['below last', 0, 298, 2, 'after', ['b', 'c', 'a']],
]) {
  test(`${containerType} shows and accepts drops ${label}`, async () => {
    const h = setup(); h.context.bindUtilityLoopDragAndDrop();
    const container = h.context.document.querySelector(`[data-loop-${containerType}-song]`);
    container.children[sourceIndex].dispatch('dragstart');
    let accepted = false;
    container.dispatch('dragover', { clientY, preventDefault() { accepted = true; } });
    assert.equal(accepted, true);
    assert.equal(container.children[targetIndex].classList.contains(`is-drop-${position}`), true);
    const pending = container.dispatch('drop', { clientY });
    assert.equal(container.children.some(node => node.classList.contains('is-drop-before') || node.classList.contains('is-drop-after')), false);
    assert.deepEqual(h.requests[0].body.ordered_ids, ordered);
    h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ordered, loops: ordered.map(id => h.loops.find(loop => loop.id === id)) });
    await pending;
  });
}

test('panel gaps ignore hidden rows and clear a stale cue for invalid song membership', () => {
  const h = setup(); h.context.bindUtilityLoopDragAndDrop();
  h.panels.children[0].hidden = true;
  h.panels.children[2].dispatch('dragstart');
  h.panels.dispatch('dragover', { clientY: -8 });
  assert.equal(h.panels.children[0].classList.contains('is-drop-before'), false);
  assert.equal(h.panels.children[1].classList.contains('is-drop-before'), true);
  h.panels.children.forEach(node => { node.hidden = true; });
  h.panels.dispatch('dragover', { clientY: -8 });
  assert.equal(h.panels.children[1].classList.contains('is-drop-before'), false);
  h.panels.children.forEach(node => { node.hidden = false; });
  h.panels.dispatch('dragover', { clientY: 95 });
  assert.equal(h.panels.children[1].classList.contains('is-drop-before'), true);
  h.panels.setAttribute('data-loop-panel-song', 'track:2');
  h.panels.dispatch('dragover', { clientY: -8 });
  assert.equal(h.panels.children[1].classList.contains('is-drop-before'), false);
  assert.deepEqual(h.requests, []);
});

test('L05 live panel drag binds handles, exposes the intended insertion cue, and uses the revision path', async () => {
  const h = setup();
  h.context.bindUtilityLoopDragAndDrop();
  const first = h.panels.children[0]; const last = h.panels.children[2];
  assert.equal(last.getAttribute('draggable'), 'true');
  const transfer = { setData() {}, getData() { return ''; } };
  last.dispatch('dragstart', { dataTransfer: transfer });
  first.dispatch('dragover', { clientY: 1, dataTransfer: transfer });
  assert.equal(first.classList.contains('is-drop-before'), true);
  const pending = first.dispatch('drop', { clientY: 1, dataTransfer: transfer });
  assert.deepEqual(h.requests[0]?.body, { song_key: 'track:1', expected_revision: 7, ordered_ids: ['c', 'a', 'b'] });
  assert.equal(first.classList.contains('is-drop-before'), false);
  h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]] });
  assert.equal(await pending, true);
});

test('L05 live drag rejects a native player control and Escape clears every cue without posting', () => {
  const h = setup(); h.context.bindUtilityLoopDragAndDrop();
  const first = h.panels.children[0]; const last = h.panels.children[2];
  const button = new Element({}, 'BUTTON'); last.appendChild(button);
  let rejected = false;
  last.dispatch('dragstart', { target: button, preventDefault() { rejected = true; } });
  assert.equal(rejected, true);
  assert.equal(h.context.state.utility.loopDragId || '', '');
  last.dispatch('dragstart'); first.dispatch('dragover', { clientY: 1 });
  h.context.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(first.classList.contains('is-drop-before'), false);
  assert.equal(h.context.state.utility.loopDragId || '', '');
  assert.deepEqual(h.requests, []);
});

test('L05 live panel markup exposes shared accessible move actions only for resolved authorized songs', () => {
  const h = setup();
  const html = h.context.buildUtilityLoopEntry(h.loops[1]);
  assert.match(html, /data-move-utility-loop="b"/);
  assert.match(html, /data-loop-move-direction="up"/);
  assert.match(html, /data-loop-move-direction="down"/);
  assert.match(html, /ui-button/);
  assert.doesNotMatch(h.context.buildUtilityLoopEntry(makeLoop('unknown', null)), /data-move-utility-loop/);
});

test('L05 filtered search still posts every loop in the selected song', async () => {
  const h = setup(); h.context.state.utility.loopsSearchQuery = 'Loop c';
  const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  assert.deepEqual(h.requests[0]?.body.ordered_ids, ['c', 'a', 'b']);
  h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]] });
  await pending;
});

test('L05 inserting a new panel from a detached markup host does not use a connected DOM move', () => {
  const h = setup();
  const host = new Element(); const fresh = panel(makeLoop('new')); host.appendChild(fresh);
  let connectedMoves = 0;
  h.panels.moveBefore = () => { connectedMoves += 1; throw new Error('Detached nodes cannot use moveBefore'); };
  h.context.moveUtilityLoopNode(h.panels, fresh);
  assert.equal(fresh.parentNode, h.panels);
  assert.equal(connectedMoves, 0);
});

test('L05 fallback DOM ordering never seeks or resumes naturally advancing media', () => {
  const h = setup(); const playing = h.panels.children[1]; const audio = playing.querySelector('audio');
  let position = 12; const seeks = [];
  Object.defineProperty(audio, 'currentTime', { get() { return position += 0.01; }, set(value) { seeks.push(value); } });
  h.context.moveUtilityLoopNode(h.panels, playing, h.panels.children[0]);
  assert.deepEqual(seeks, []);
  assert.equal(audio.playCalls, 0);
  assert.equal(audio.pauseCalls, 0);
});

test('L05 identical authoritative confirmation does not move the already ordered DOM again', async () => {
  const h = setup();
  const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  let additionalMoves = 0;
  for (const parent of [h.panels, h.treeChildren]) {
    const insert = parent.insertBefore.bind(parent);
    parent.insertBefore = (...args) => { additionalMoves += 1; return insert(...args); };
  }
  h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]] });
  await pending;
  assert.equal(additionalMoves, 0);
});

for (const status of [200, 500]) test(`L05 a late ${status} response cannot resurrect a song removed by a newer load`, async () => {
  const h = setup();
  const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  h.context.state.utility.loops = [h.loops[3]];
  h.context.state.utility.loopViewGeneration = 1;
  h.finish({ ok: status === 200, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]], error: 'Failure' }, status);
  await pending;
  assert.deepEqual(Array.from(h.context.state.utility.loops, loop => loop.id), ['other']);
});

for (const change of ['load', 'scope']) test(`L05 a newer ${change} with an equal song revision owns the cache`, async () => {
  const h = setup();
  const pending = h.context.reorderUtilityLoops(item('c'), item('a'), 'before');
  const current = [h.loops[1], h.loops[0], h.loops[2], h.loops[3]];
  if (change === 'scope') h.context.state.utility = { ...h.context.state.utility, loops: current };
  else { h.context.state.utility.loops = current; h.context.state.utility.loopDataGeneration = 1; }
  h.finish({ ok: true, song_key: 'track:1', order_revision: 8, ordered_ids: ['c', 'a', 'b'], loops: [h.loops[2], h.loops[0], h.loops[1]] });
  await pending;
  assert.equal(h.context.state.utility.loops, current);
});
