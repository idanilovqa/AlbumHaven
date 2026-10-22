const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const load = import('../../../music_app/static/js/playlists/reorder.mjs');

// Each case owns its DOM, clock queue, geometry and projection. These browser
// capabilities are fixture-only; the production adapter executes unchanged.
function fixture(mount, {accept = true, replaceOnCommit = true, deferProjection = false, scrollable = false, draft = false} = {}) {
  const env = createNativeHomeRuntime(), {document: doc} = env;
  const host = doc.createElement('section'); doc.body.appendChild(host);
  const win = doc.createElement('window'), frames = new Map(), observers = new Set(), commands = [], announcements = [];
  let serial = 0, adapter, focused = [], captures = new Set();
  Object.assign(win, {
    innerHeight: 600, innerWidth: 800,
    getComputedStyle: node => ({overflowY: node === host ? 'auto' : 'visible'}),
    requestAnimationFrame(callback) {const id = ++serial; frames.set(id, callback); return id;},
    cancelAnimationFrame(id) {frames.delete(id);},
    MutationObserver: class {
      constructor(callback) {this.callback = callback;}
      observe() {observers.add(this);}
      disconnect() {observers.delete(this);}
    },
  });
  doc.defaultView = win; doc.scrollingElement = doc.documentElement;
  Object.assign(doc.documentElement, {scrollTop: 0, scrollHeight: 600, clientHeight: 600});
  Object.assign(host, {scrollHeight: scrollable ? 1000 : 200, clientHeight: 200});
  host.setPointerCapture = id => captures.add(id); host.releasePointerCapture = id => captures.delete(id);
  const Element = host.constructor;
  Element.prototype.focus = function () {if (this.isConnected && !this.disabled) {doc.activeElement = this; focused.push(this);}};
  Element.prototype.scrollIntoView = function () {};
  Element.prototype.cloneNode = function (deep) {
    const copy = doc.createElement(this.tagName);
    for (const {name, value} of this.attributes) copy.setAttribute(name, value);
    if (deep) for (const node of this.childNodes) copy.appendChild(node.nodeType === 3 ? doc.createTextNode(node.textContent) : node.cloneNode(true));
    return copy;
  };
  Element.prototype.getBoundingClientRect = function () {
    const index = host.querySelectorAll('[data-playlist-row-key]').indexOf(this);
    const top = index < 0 ? 100 : 100 + index * 40 - (scrollable ? host.scrollTop : doc.documentElement.scrollTop);
    const height = index < 0 ? 200 : 40;
    return {left: 20, right: 720, top, bottom: top + height, width: 700, height};
  };
  let state = {scopeKey: 'owned-scope', playlistId: 'owned-playlist', source: {}, selectedRowKey: null,
    itemsComplete: true, canEdit: true, canReorder: true, unfiltered: true, defaultOrder: true, busy: false,
    rows: ['a', 'b', 'c'].map(id => ({row_key: `row:${id}`, playlist_item_id: id, title: `Track ${id}`}))};
  if (draft) {
    delete state.playlistId; state.draftToken = 'local-draft';
    state.rows = state.rows.map(({playlist_item_id, ...row}) => row);
  }
  const itemKey = row => draft ? row.row_key : row.playlist_item_id;
  const render = () => {
    const body = doc.createElement('div'); body.className = 'compact-data-table-body';
    for (const item of state.rows) {
      const row = doc.createElement('div'); row.dataset.playlistRowKey = item.row_key;
      const handle = doc.createElement('button'); handle.dataset.playlistsDrag = ''; handle.setAttribute('aria-label', `Reorder ${item.title}`);
      const icon = doc.createElement('span'); icon.textContent = 'Move'; handle.appendChild(icon); row.appendChild(handle); body.appendChild(row);
    }
    host.replaceChildren(body);
  };
  render();
  adapter = mount(host, {snapshot: () => state,
    ...(draft ? {collectionKey: value => value.draftToken, itemKey} : {}),
    onAnnounce: message => announcements.push(message), onReorder: order => {
    commands.push([...order]);
    if (accept !== true) return accept;
    if (deferProjection) return true;
    state = {...state, rows: order.map(id => state.rows.find(row => itemKey(row) === id))};
    if (replaceOnCommit) render();
    return true;
  }});
  const emit = (target, type, values = {}) => {
    const event = new env.context.Event(type);
    Object.assign(event, {pointerId: 7, clientX: 40, clientY: 120, button: 0, isPrimary: true}, values);
    target.dispatchEvent(event); return event;
  };
  return {host, doc, win, frames, observers, commands, announcements, captures, focused, adapter, render, emit,
    get state() {return state;}, patch(value) {state = {...state, ...value};},
    order: () => host.querySelectorAll('[data-playlist-row-key]').map(row => row.dataset.playlistRowKey),
    handle: id => host.querySelectorAll('[data-playlist-row-key]').find(row => row.dataset.playlistRowKey === `row:${id}`)?.querySelector('[data-playlists-drag]'),
    frame(time = 16) {const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(time);},
    mutations() {for (const observer of [...observers]) observer.callback([{target: host, removedNodes: []}]);},
    close() {adapter.dispose(); assert.equal(frames.size, 0); assert.equal(observers.size, 0); assert.equal(captures.size, 0); assert.equal(doc.listeners.length, 0); assert.equal(win.listeners.length, 0); assert.equal(host.listeners.length, 0);},
  };
}

async function owned(t, options) {
  const {mountPlaylistReorder} = await load;
  const value = fixture(mountPlaylistReorder, options); t.after(() => value.close()); return value;
}
function start(value, id = 'a', y = 120) {value.emit(value.handle(id).firstElementChild, 'pointerdown', {clientY: y});}
function move(value, y = 200) {value.emit(value.doc, 'pointermove', {clientY: y}); value.frame();}
function release(value, y = 200) {return value.emit(value.doc, 'pointerup', {clientY: y});}

test('pointer reorder previews native rows and commits exactly one full item order on release', async t => {
  const value = await owned(t); start(value); move(value);
  assert.deepEqual(value.order(), ['row:b', 'row:c', 'row:a']); assert.deepEqual(value.commands, []);
  const ghost = value.host.querySelector('.playlists__reorder-ghost');
  assert.equal(ghost.inert, true); assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(value.handle('a').getAttribute('aria-grabbed'), 'true');
  assert.equal(release(value).defaultPrevented, true);
  assert.deepEqual(value.commands, [['b', 'c', 'a']]); assert.deepEqual(value.order(), ['row:b', 'row:c', 'row:a']);
  assert.equal(value.doc.activeElement, value.handle('a')); assert.equal(ghost.isConnected, false);
  assert.deepEqual(value.announcements, ['Moved to position 3 of 3.']);
  release(value); assert.equal(value.commands.length, 1);
});

test('release uses final pointer coordinates and ignores other pointer identities', async t => {
  const value = await owned(t); start(value);
  value.emit(value.doc, 'pointermove', {pointerId: 9, clientY: 200}); value.frame();
  value.emit(value.doc, 'pointerup', {pointerId: 9, clientY: 200});
  assert.equal(value.host.classList.contains('is-reordering'), false); assert.deepEqual(value.commands, []);
  release(value, 160); assert.deepEqual(value.commands, [['b', 'a', 'c']]);
});

test('clicks, tiny movement and a drag back to the original slot do not reorder', async t => {
  const value = await owned(t); start(value); release(value, 124); assert.deepEqual(value.commands, []);
  start(value); move(value, 200); release(value, 120); assert.deepEqual(value.commands, []);
  assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
});

test('accepted reorder blocks the trailing click across row replacement, then releases for new input', async t => {
  const value = await owned(t); let activations = 0;
  const activate = () => activations++;
  value.host.addEventListener('click', activate);
  start(value); move(value); release(value);
  assert.equal(value.emit(value.handle('a'), 'click').defaultPrevented, true);
  assert.equal(value.emit(value.handle('a'), 'dblclick').defaultPrevented, true); assert.equal(activations, 0);
  value.emit(value.handle('a'), 'pointerdown', {button: 2});
  assert.equal(value.emit(value.handle('a'), 'click').defaultPrevented, false); assert.equal(activations, 1);
  value.host.removeEventListener('click', activate);
});

for (const key of ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Home', 'End']) {
  test(`keyboard ${key} submits ordered item identities and restores current handle focus`, async t => {
    const value = await owned(t); value.handle('b').focus();
    const event = value.emit(value.handle('b'), 'keydown', {key});
    const towardStart = ['ArrowUp', 'ArrowLeft', 'Home'].includes(key);
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(value.commands, [towardStart ? ['b', 'a', 'c'] : ['a', 'c', 'b']]);
    assert.equal(value.doc.activeElement, value.handle('b'));
  });
}

test('keyboard edge and modified shortcuts do not commit; deferred render focuses the replacement', async t => {
  const value = await owned(t, {replaceOnCommit: false}); value.handle('a').focus();
  value.emit(value.handle('a'), 'keydown', {key: 'Home'}); value.emit(value.handle('a'), 'keydown', {key: 'End', ctrlKey: true});
  assert.deepEqual(value.commands, []);
  value.emit(value.handle('a'), 'keydown', {key: 'End'}); const old = value.doc.activeElement;
  value.render(); value.adapter.update(); assert.notEqual(value.doc.activeElement, old); assert.equal(value.doc.activeElement, value.handle('a'));
});

test('deferred focus never steals another live control or follows a replaced source', async t => {
  const value = await owned(t, {replaceOnCommit: false}); value.handle('a').focus();
  value.emit(value.handle('a'), 'keydown', {key: 'End'});
  const outside = value.doc.createElement('button'); value.doc.body.appendChild(outside); outside.focus();
  value.render(); value.adapter.update(); assert.equal(value.doc.activeElement, outside);
  value.handle('a').focus(); value.emit(value.handle('a'), 'keydown', {key: 'Home'});
  value.patch({source: {}}); value.render(); value.adapter.update(); assert.equal(value.doc.activeElement.isConnected, false);
});

test('accepted commands can wait for the next React projection before restoring focus', async t => {
  const value = await owned(t, {deferProjection: true}); value.handle('a').focus();
  value.emit(value.handle('a'), 'keydown', {key: 'End'});
  assert.deepEqual(value.commands, [['b', 'c', 'a']]);
  assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
  value.patch({rows: value.commands[0].map(id => value.state.rows.find(row => row.playlist_item_id === id))});
  value.render(); value.adapter.update(); assert.equal(value.doc.activeElement, value.handle('a'));
});

for (const cancel of ['Escape', 'pointercancel', 'lostpointercapture', 'blur', 'resize', 'pagehide', 'visibilitychange', 'dispose']) {
  test(`${cancel} cancels without committing and cleans up the owned gesture`, async t => {
    const value = await owned(t); start(value); move(value);
    if (cancel === 'Escape') value.emit(value.doc, 'keydown', {key: 'Escape'});
    else if (cancel === 'dispose') value.adapter.dispose();
    else if (cancel === 'visibilitychange') {value.doc.hidden = true; value.emit(value.doc, cancel);}
    else value.emit(['blur', 'resize', 'pagehide'].includes(cancel) ? value.win : cancel === 'lostpointercapture' ? value.host : value.doc, cancel);
    release(value);
    assert.deepEqual(value.commands, []); assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
    assert.equal(value.host.querySelector('.playlists__reorder-ghost'), null);
    assert.equal(value.frames.size, 0); assert.equal(value.observers.size, 0); assert.equal(value.captures.size, 0);
  });
}

for (const patch of [{itemsComplete: false}, {canEdit: false}, {canReorder: 'true'}, {unfiltered: false}, {defaultOrder: false}, {busy: true}, {scopeKey: ''}]) {
  test(`invalid authoring context ${Object.keys(patch)[0]} rejects pointer and keyboard gestures`, async t => {
    const value = await owned(t); value.patch(patch);
    start(value); release(value); value.emit(value.handle('a'), 'keydown', {key: 'End'});
    assert.deepEqual(value.commands, []); assert.equal(value.captures.size, 0);
  });
}

for (const field of ['scopeKey', 'playlistId', 'source', 'selectedRowKey', 'canReorder', 'unfiltered', 'busy']) {
  test(`a changed ${field} cancels the in-flight gesture before any draft command`, async t => {
    const value = await owned(t); start(value); move(value);
    const patch = {scopeKey: 'new-scope', playlistId: 'other-playlist', source: {}, selectedRowKey: 'row:b', canReorder: false, unfiltered: false, busy: true};
    value.patch({[field]: patch[field]}); value.render(); value.adapter.update(); release(value);
    assert.deepEqual(value.commands, []); assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
    assert.equal(value.frames.size, 0); assert.equal(value.observers.size, 0);
  });
}

test('sparse, missing and duplicate item or row identities cannot authorize reorder', async t => {
  const value = await owned(t), original = value.state.rows;
  const invalid = [Array(3), original.map((row, i) => i === 1 ? {...row, playlist_item_id: null} : row),
    original.map((row, i) => i === 1 ? {...row, playlist_item_id: 'a'} : row),
    original.map((row, i) => i === 1 ? {...row, row_key: 'row:a'} : row)];
  for (const rows of invalid) {value.patch({rows}); start(value); release(value); value.emit(value.handle('a'), 'keydown', {key: 'End'});}
  assert.deepEqual(value.commands, []);
});

test('membership, DOM replacement and removal cancel without rewriting newer nodes', async t => {
  const value = await owned(t); start(value); move(value);
  value.patch({rows: value.state.rows.slice(1)}); value.render(); value.mutations(); release(value);
  assert.deepEqual(value.commands, []); assert.deepEqual(value.order(), ['row:b', 'row:c']);
  start(value, 'b', 120); move(value, 160); const replaced = value.handle('b');
  value.render(); value.mutations(); release(value, 160); assert.equal(replaced.isConnected, false); assert.deepEqual(value.commands, []);
  start(value, 'b', 120); move(value, 160); value.host.remove(); value.mutations(); release(value, 160);
  assert.deepEqual(value.commands, []); assert.equal(value.frames.size, 0);
});

test('rejected commands restore the original presentation and never announce acceptance', async t => {
  const value = await owned(t, {accept: 'true'}); start(value); move(value); release(value);
  assert.deepEqual(value.commands, [['b', 'c', 'a']]); assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
  assert.deepEqual(value.announcements, []); assert.equal(value.host.classList.contains('is-reordering'), false);
});

test('release rechecks revoked grants and rolls back owned preview even without a render update', async t => {
  const value = await owned(t); start(value); move(value); value.patch({canEdit: false}); release(value);
  assert.deepEqual(value.commands, []); assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
  assert.equal(value.host.querySelector('.playlists__reorder-ghost'), null);
});

test('lost pointer buttons cancel, and an unexpected DOM identity change is never overwritten', async t => {
  const value = await owned(t); start(value); move(value);
  value.emit(value.doc, 'pointermove', {clientY: 200, buttons: 0}); release(value);
  assert.deepEqual(value.commands, []); assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
  start(value); move(value); value.handle('b').parentElement.dataset.playlistRowKey = 'new-key'; value.mutations();
  assert.deepEqual(value.order(), ['new-key', 'row:c', 'row:a']); assert.deepEqual(value.commands, []);
});

test('reparented rows and replaced handles cancel without restoring rows into an obsolete owner', async t => {
  const value = await owned(t); start(value); move(value);
  const replacement = value.doc.createElement('div'); value.host.appendChild(replacement);
  for (const row of value.host.querySelectorAll('[data-playlist-row-key]')) replacement.appendChild(row);
  value.mutations(); release(value); assert.deepEqual(value.commands, []);
  assert.equal(replacement.children.length, 3); assert.deepEqual(value.order(), ['row:b', 'row:c', 'row:a']);
  value.render(); start(value); move(value); value.handle('a').remove(); value.mutations(); release(value);
  assert.deepEqual(value.commands, []); assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
});

test('auto-scroll is bounded to the current scroll owner and stops at cancellation', async t => {
  const value = await owned(t, {scrollable: true}); start(value); move(value, 290);
  assert.ok(value.host.scrollTop > 0 && value.host.scrollTop <= 12); assert.equal(value.doc.documentElement.scrollTop, 0);
  assert.equal(value.frames.size, 1); value.emit(value.doc, 'pointercancel');
  const top = value.host.scrollTop; value.frame(32); assert.equal(value.host.scrollTop, top); assert.equal(value.frames.size, 0);
  assert.deepEqual(value.commands, []);
});

test('disabled handles and foreign nodes never activate this adapter; disposal removes event ownership', async t => {
  const value = await owned(t); value.handle('a').disabled = true; start(value); release(value);
  value.emit(value.handle('a'), 'keydown', {key: 'End'}); assert.deepEqual(value.commands, []);
  const foreign = value.doc.createElement('button'); foreign.dataset.playlistsDrag = ''; value.doc.body.appendChild(foreign);
  value.emit(foreign, 'pointerdown'); release(value); value.emit(foreign, 'keydown', {key: 'End'}); assert.deepEqual(value.commands, []);
  value.handle('a').disabled = false; value.adapter.dispose(); start(value); release(value);
  value.emit(value.handle('a'), 'keydown', {key: 'End'}); assert.deepEqual(value.commands, []);
});

test('unsaved collection selectors reuse pointer and keyboard gestures without saved playlist or item IDs', async t => {
  const value = await owned(t, {draft: true});
  assert.equal(value.state.playlistId, undefined);
  assert.ok(value.state.rows.every(row => row.playlist_item_id === undefined));
  start(value); move(value); release(value);
  assert.deepEqual(value.commands, [['row:b', 'row:c', 'row:a']]);
  assert.equal(value.doc.activeElement, value.handle('a'));
  value.emit(value.handle('a'), 'keydown', {key: 'Home'});
  assert.deepEqual(value.commands[1], ['row:a', 'row:b', 'row:c']);
  assert.deepEqual(value.announcements, ['Moved to position 3 of 3.', 'Moved to position 1 of 3.']);
});

for (const patch of [{draftToken: 'other-draft'}, {source: {}}, {scopeKey: 'another-actor'}, {canEdit: false},
  {canReorder: false}, {unfiltered: false}, {busy: true}, {itemsComplete: false}]) {
  test(`unsaved gesture rechecks ${Object.keys(patch)[0]} before release`, async t => {
    const value = await owned(t, {draft: true}); start(value); move(value);
    value.patch(patch); release(value);
    assert.deepEqual(value.commands, []); assert.deepEqual(value.order(), ['row:a', 'row:b', 'row:c']);
    assert.equal(value.host.querySelector('.playlists__reorder-ghost'), null);
  });
}

test('unsaved collection identity selectors still reject missing and duplicate local identities', async t => {
  const value = await owned(t, {draft: true}), rows = value.state.rows;
  value.patch({draftToken: ''}); value.emit(value.handle('a'), 'keydown', {key: 'End'});
  value.patch({draftToken: 'local-draft', rows: rows.map((row, index) => index === 1 ? {...row, row_key: 'row:a'} : row)});
  start(value); release(value); value.emit(value.handle('a'), 'keydown', {key: 'End'});
  assert.deepEqual(value.commands, []);
});
