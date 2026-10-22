const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {fixture: nativeFixture} = require('./playlist-native-review-fixture.cjs');
const repo = path.resolve(__dirname, '../../..');
const tableModule = import(pathToFileURL(path.join(repo, 'music_app/static/js/playlists/native-track-table.mjs')));
const row = (id, patch = {}) => ({row_key: `item:${id}`, playlist_item_id: id, title: id, source_readable: true,
  availability: 'local', duration_seconds: null, ...patch});
const settled = () => new Promise(resolve => setImmediate(resolve));

// Real native table and selection/reorder owners. Only external providers and
// bounded DOM platform capabilities are supplied by this test fixture.
async function fixture(t, {rows = [row('b', {duration_seconds: 20}), row('a', {duration_seconds: 0}), row('unknown'), row('tie', {duration_seconds: 20})], grants = {}, configureRuntime} = {}) {
  const native = nativeFixture(), doc = native.document, container = native.host;
  const exports = await tableModule;
  const scrollCalls = [];
  // Bounded platform behavior for the canonical Choice owner's selected-item
  // reveal. No product/menu method is replaced and unsupported options fail.
  native.context.Element.prototype.scrollIntoView = function(options = {}) {
    assert.equal(options.block, 'nearest');
    scrollCalls.push({target: this, options: {...options}});
    if (!this.isConnected) return;
    const box = this.getBoundingClientRect();
    for (let parent = this.parentElement; parent; parent = parent.parentElement) {
      const viewport = parent.getBoundingClientRect();
      if (parent.scrollHeight > parent.clientHeight) {
        const delta = box.top < viewport.top ? box.top - viewport.top
          : box.bottom > viewport.bottom ? box.bottom - viewport.bottom : 0;
        parent.scrollTop = Math.max(0, Math.min(parent.scrollHeight - parent.clientHeight, parent.scrollTop + delta));
      }
    }
  };
  native.context.addEventListener = doc.addEventListener.bind(doc);
  native.context.removeEventListener = doc.removeEventListener.bind(doc);
  for (const file of ['trigger-anchor.js', 'library-settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), native.context);
  }
  let detail = {playlist_id: 'table:owned', title: 'Owned playlist', track_rows: rows, items_complete: true, author_order: true,
    allowed_actions: {can_play: true, can_edit: true, can_reorder: true, ...grants}};
  let state = {scopeKey: 'scope:owned', selectedPlaylistId: detail.playlist_id, resource: {status: 'ready', data: {detail}},
    drafts: {}, filters: {}, mutation: {status: 'idle'}};
  const plays = [], selects = [], errors = [], moves = [];
  const controller = {getSnapshot: () => state, reorder: ids => {moves.push([...ids]); return true;}};
  const runtime = {...native.runtime, canTrackIntent: () => true, trackIntent: (...args) => {plays.push(args);}};
  runtime.openChoice = (trigger, options) => native.context.openUtilityChoiceDropdown(trigger, options);
  configureRuntime?.(runtime);
  let props, owner, host, disposed = false, mountedRuntime = runtime;
  function capture() {return [...host.listeners];}
  function render(patch = {}) {
    assert.equal(disposed, false);
    props = {...{controller, rows, detail, state, selected: null, currentItemId: null,
      onSelect: value => selects.push(value), onError: value => errors.push(value)}, ...props, state, detail, rows, ...patch};
    // Runtime identity belongs to native mount ownership, not update props.
    if (patch.runtime && patch.runtime !== mountedRuntime) {owner?.dispose(); owner = null; mountedRuntime = patch.runtime;}
    if (owner) owner.update(props); else owner = exports.mountPlaylistTracks(container, mountedRuntime, props);
    host = container.querySelector('.playlists__tracks');
    return capture();
  }
  function emit(name, target, values = {}, captured) {
    const type = {onClick: 'click', onDoubleClick: 'dblclick', onKeyDown: 'keydown', onContextMenu: 'contextmenu'}[name];
    const event = Object.assign(new native.context.Event(type), {button: 0, detail: 1}, values);
    if (!captured) target.dispatchEvent(event);
    else {
      // Replay real acquired listeners after retirement. Never manufacture a
      // product callback or route an old target to the new table owner.
      event.target = target;
      for (const phase of [true, false]) for (const entry of captured) {
        if (entry.type === type && entry.capture === phase && !event.stopped) entry.callback(event);
      }
    }
    return event;
  }
  function close() {if (disposed) return; disposed = true; owner.dispose(); assert.equal(container.childNodes.length, 0); assert.equal(host.listeners.length, 0); container.remove();}
  t.after(close); render();
  return {container, scrollCalls, setRect: native.setRect, get host() {return host;}, doc, runtime, controller, plays, selects, errors, moves, render, emit, close,
    exports, get state() {return state;}, get detail() {return detail;}, get rows() {return rows;},
    patchState(patch) {state = {...state, ...patch};},
    replaceRows(next) {rows = next; detail = {...detail, track_rows: rows}; state = {...state, resource: {status: 'ready', data: {detail}}};},
    order: () => [...host.querySelectorAll('[data-playlist-row-key]')].map(node => node.dataset.playlistRowKey),
    row: id => host.querySelector(`[data-playlist-row-key="item:${id}"]`),
    sort: key => emit('onClick', host.querySelector(`[data-cdt-sort="${key}"]`)),
  };
}

test('Length sorts supplied numbers with unknown last, stable ties and a third-click authored-order reset', async t => {
  const value = await fixture(t); value.emit('onClick', value.row('b')); value.render({selected: 'item:b'});
  assert.equal(value.host.querySelector('[data-cdt-sort="title"]'), null);
  value.sort('duration'); value.render();
  assert.deepEqual(value.order(), ['item:a', 'item:b', 'item:tie', 'item:unknown']);
  assert.equal(value.row('a').querySelector('.album-track-table__number').textContent, '2');
  assert.equal(value.row('b').querySelector('.album-track-table__number').textContent, '1');
  assert.equal(value.row('b').getAttribute('aria-selected'), 'true');
  assert.equal(value.host.querySelector('[data-cdt-column="duration"]').getAttribute('aria-sort'), 'ascending');
  assert.equal(value.host.querySelector('[data-playlists-drag]'), null);
  value.sort('duration'); value.render();
  assert.deepEqual(value.order(), ['item:b', 'item:tie', 'item:a', 'item:unknown']);
  value.sort('duration'); value.render();
  assert.deepEqual(value.order(), ['item:b', 'item:a', 'item:unknown', 'item:tie']);
  assert.ok(value.host.querySelector('[data-playlists-drag]'));
  assert.equal(value.row('b').getAttribute('aria-selected'), 'true');
  assert.deepEqual(value.moves, []);
});

test('metric headers sort their own supplied facts and retain the canonical author rows', async t => {
  const rows = [row('many', {play_count: 4, popularity_count: 0, love_tier: 'loved', listen_count: 0}),
    row('zero', {play_count: 0, popularity_count: 7, love_tier: 'off', listen_count: 100}), row('unknown', {listen_count: 500})];
  const value = await fixture(t, {rows});
  assert.equal(value.host.querySelector('[data-cdt-sort="track_rating"]'), null);
  for (const [key, expected] of [['play_count', ['item:zero', 'item:many', 'item:unknown']],
    ['popularity_count', ['item:many', 'item:zero', 'item:unknown']], ['love_tier', ['item:zero', 'item:many', 'item:unknown']]]) {
    value.sort(key); value.render(); assert.deepEqual(value.order(), expected);
  }
  assert.deepEqual(rows.map(track => track.playlist_item_id), ['many', 'zero', 'unknown']);
  assert.deepEqual(value.moves, []); assert.deepEqual(value.plays, []);
});

test('native narrow columns keep Length and Loves, align headers and expose user-selected extras with local overflow', async t => {
  const value = await fixture(t);
  value.setRect(value.host, {width: 320, height: 400}); value.render();
  const table = value.host.querySelector('.compact-data-table');
  const visible = () => [...table.querySelector('.compact-data-table-header').querySelectorAll('[data-cdt-column]')]
    .filter(cell => !cell.hasAttribute('data-cdt-responsive-hidden')).map(cell => cell.dataset.cdtColumn);
  const aligned = () => {
    for (const row of table.querySelectorAll('[data-playlist-row-key]')) {
      assert.deepEqual([...row.querySelectorAll('[data-cdt-column]')]
        .filter(cell => !cell.hasAttribute('data-cdt-responsive-hidden')).map(cell => cell.dataset.cdtColumn), visible());
    }
    assert.ok(visible().includes('title')); assert.ok(visible().includes('duration')); assert.ok(visible().includes('love_tier'));
    assert.match(table.style.getPropertyValue('--cdt-responsive-columns'), /minmax\(100px,1fr\)/);
    assert.equal(table.getAttribute('data-cdt-overflow'), 'local');
  };
  assert.equal(table.hasAttribute('data-cdt-responsive'), true);
  assert.equal(table.querySelector('[data-cdt-column="track_rating"]').hasAttribute('data-cdt-responsive-hidden'), true);
  assert.equal(table.querySelector('[data-cdt-column="popularity_count"]').hasAttribute('data-cdt-responsive-hidden'), true);
  aligned();
  for (const key of ['track_rating', 'popularity_count', 'play_count']) {
    value.emit('onClick', value.container.querySelector('[data-track-table-columns]'));
    const menu = value.doc.querySelector('[role="menu"]'); assert.ok(menu);
    assert.ok(value.scrollCalls.some(call => menu.contains(call.target) && call.options.block === 'nearest'));
    value.emit('onClick', menu.querySelector(`[data-foobar-format="${key}"]`));
    assert.ok(visible().includes(key)); aligned();
    assert.equal(value.doc.querySelector('[role="menu"]'), null);
  }
  assert.ok(parseFloat(table.style.getPropertyValue('--cdt-responsive-min-width')) > 320);
  // DOM evidence checks the shared grid/overflow contract. Real clipping,
  // truncation, alignment and horizontal scrolling remain browser acceptance.
});

test('artwork uses the native empty state for unsafe and denied URLs without leaking media fields', async t => {
  const value = await fixture(t, {rows: [row('cover', {artwork_url: '/covers/owned.jpg'}), row('unsafe', {artwork_url: 'file:///private/music.jpg'}),
    row('denied', {source_readable: false, artwork_url: '/covers/denied.jpg', path: '/private/music.flac'})]});
  assert.equal(value.row('cover').querySelector('img').getAttribute('src'), '/covers/owned.jpg');
  for (const id of ['unsafe', 'denied']) {
    assert.equal(value.row(id).querySelector('img'), null);
    assert.ok(value.row(id).querySelector('[data-album-artbox-state="empty"]'));
  }
  assert.doesNotMatch(value.host.innerHTML, /private\/music|covers\/denied|data-src=|data-track-path=/);
  assert.equal(value.row('cover').getAttribute('tabindex'), '0');
  assert.equal(value.row('denied').getAttribute('tabindex'), '-1');
});

test('sorting preserves focused header and row identities while current-player paint preserves every native node', async t => {
  const value = await fixture(t), header = value.host.querySelector('[data-cdt-sort="duration"]'); header.focus();
  value.sort('duration'); value.render();
  assert.equal(value.doc.activeElement, value.host.querySelector('[data-cdt-sort="duration"]'));
  value.row('b').focus(); value.render({selected: 'item:b'});
  assert.equal(value.doc.activeElement, value.row('b'));
  const nodes = [...value.host.querySelectorAll('[data-playlist-row-key]')];
  value.render({currentItemId: 'b'});
  assert.equal(value.row('b').getAttribute('aria-current'), 'true');
  value.render({currentItemId: 'a'});
  assert.equal(value.row('b').hasAttribute('aria-current'), false);
  assert.equal(value.row('a').getAttribute('aria-current'), 'true');
  assert.deepEqual([...value.host.querySelectorAll('[data-playlist-row-key]')], nodes);
});

test('removing a focused row never sends focus to a different row control', async t => {
  const value = await fixture(t), button = value.row('b').querySelector('[data-playlists-select]'); button.focus();
  value.replaceRows(value.rows.filter(track => track.playlist_item_id !== 'b')); value.render();
  assert.notEqual(value.doc.activeElement, value.row('a').querySelector('[data-playlists-select]'));
  assert.equal(button.isConnected, false);
});

test('sorted state revokes manual reorder immediately and snapshot blocks native pointer and keyboard adapters', async t => {
  const value = await fixture(t), handlers = value.render(), down = value.row('b').querySelector('[data-playlists-move="down"]');
  value.sort('duration');
  value.emit('onClick', down, {}, handlers);
  assert.deepEqual(value.moves, []);
  const snapshot = value.exports.playlistReorderSnapshot(value.controller, 'item:b', {key: 'duration', direction: 'asc'});
  assert.equal(snapshot.defaultOrder, false);
  value.render(); assert.equal(value.host.querySelector('[data-playlists-move]'), null);
  value.sort('duration'); value.render(); value.sort('duration'); value.render();
  value.emit('onClick', value.row('b').querySelector('[data-playlists-move="down"]'));
  assert.deepEqual(value.moves, [['a', 'b', 'unknown', 'tie']]);
});

test('single click and plain Enter select; double click, Ctrl+Enter, Cmd+Enter and explicit Play send canonical intent', async t => {
  const value = await fixture(t), track = value.rows[0];
  value.emit('onClick', value.row('b'));
  value.emit('onKeyDown', value.row('b'), {key: 'Enter'}); await settled();
  assert.deepEqual(value.selects, [track, track]); assert.deepEqual(value.plays, []);
  for (const [name, target, event] of [
    ['onDoubleClick', value.row('b'), {}], ['onKeyDown', value.row('b'), {key: 'Enter', ctrlKey: true}],
    ['onKeyDown', value.row('b'), {key: 'Enter', metaKey: true}], ['onClick', value.row('b').querySelector('[data-playlists-play]'), {}],
  ]) {value.emit(name, target, event); await settled();}
  assert.equal(value.plays.length, 4);
  for (const [intent, source, options] of value.plays) {assert.equal(intent, 'play'); assert.equal(source, track); assert.equal(options.playlist_id, value.detail.playlist_id);}
  assert.deepEqual(value.selects, [track, track]);
});

test('Playlist shared selection keeps occurrence keys across sorting and drops filtered batch targets', async t => {
  const created = [], calls = [];
  const value = await fixture(t, {configureRuntime(runtime) {
    runtime.createPlaytableSource = require('./playtable-source-fixture.cjs').createSourceFactory(created);
    runtime.openPlaylistAction = (packet, lifetime, source) => calls.push({packet, lifetime, source});
  }});
  value.render();
  value.emit('onClick', value.row('b')); value.emit('onClick', value.row('a'), {metaKey: true});
  value.emit('onContextMenu', value.row('b'));
  assert.deepEqual(Array.from(calls[0].packet.row_keys), ['item:b', 'item:a']);
  value.render({selected: 'item:unknown'});
  assert.equal(value.row('b').getAttribute('aria-selected'), 'true');
  assert.equal(value.row('a').getAttribute('aria-selected'), 'true');
  assert.equal(value.row('unknown').hasAttribute('aria-selected'), false);
  value.sort('duration'); value.render(); assert.equal(created.length, 1);
  assert.equal(calls[0].lifetime.isCurrent(), false);
  value.emit('onContextMenu', value.row('b'));
  assert.deepEqual(Array.from(calls[1].packet.row_keys), ['item:a', 'item:b']);
  value.render({rows: value.rows.filter(row => row.playlist_item_id !== 'b')});
  assert.equal(calls[1].lifetime.isCurrent(), false); assert.equal(value.row('b'), null);
  value.emit('onContextMenu', value.row('a'));
  assert.deepEqual(Array.from(calls[2].packet.row_keys), ['item:a']);
  assert.equal(calls[2].source.snapshot().instance, created[0].snapshot().instance);
  assert.doesNotMatch(JSON.stringify(calls[2].packet) + value.host.innerHTML, /fixture-private/);
  value.render({rows: value.rows.map(track => ({...track}))});
  value.emit('onContextMenu', value.row('a')); assert.equal(calls.length, 3);
  assert.equal(calls[2].source.snapshot(), null);
  value.replaceRows(value.rows.map(track => ({...track}))); value.render();
  assert.equal(created.length, 2); assert.equal(calls[2].lifetime.isCurrent(), false);
  assert.equal(value.row('a').hasAttribute('aria-selected'), false);
});

test('selection callbacks preserve the native double-click target across both clicks and player paint', async t => {
  const value = await fixture(t), original = value.row('b'), button = original.querySelector('[data-playlists-play]');
  value.render({onSelect: track => value.render({selected: track.row_key, rows: [...value.rows]})});
  value.emit('onClick', original);
  assert.equal(value.row('b'), original); assert.equal(original.getAttribute('aria-selected'), 'true');
  value.emit('onClick', original, {detail: 2});
  assert.equal(value.row('b'), original);
  value.emit('onDoubleClick', original);
  value.render({rows: [...value.rows], currentItemId: 'a'});
  await settled();
  assert.equal(value.plays.length, 1); assert.equal(value.plays[0][1], value.rows[0]);
  assert.equal(value.row('b'), original); assert.equal(original.querySelector('[data-playlists-play]'), button);
  assert.equal(value.row('a').getAttribute('aria-current'), 'true');
});

test('started playback survives harmless row-array, selection and player rerenders', async t => {
  for (const action of ['explicit', 'double', 'keyboard']) {
    const value = await fixture(t), root = value.row('b');
    if (action === 'explicit') value.emit('onClick', root.querySelector('[data-playlists-play]'));
    if (action === 'double') value.emit('onDoubleClick', root);
    if (action === 'keyboard') value.emit('onKeyDown', root, {key: 'Enter', ctrlKey: true});
    value.render({rows: [...value.rows], selected: 'item:b', currentItemId: 'a'});
    await settled(); assert.equal(value.plays.length, 1, `${action} retains canonical ownership`);
    assert.equal(value.plays[0][1], value.rows[0]); assert.equal(value.row('b'), root); value.close();
  }
});

test('row playback ignores controls, inputs, editable cells, repeats and composing keys', async t => {
  const value = await fixture(t), root = value.row('b');
  const editable = value.doc.createElement('span'); editable.setAttribute('contenteditable', 'true'); root.appendChild(editable);
  const input = value.doc.createElement('input'); root.appendChild(input);
  for (const target of [input, editable, ...root.querySelectorAll('button')]) {
    value.emit('onDoubleClick', target);
    value.emit('onKeyDown', target, {key: 'Enter', ctrlKey: true});
  }
  for (const patch of [{repeat: true}, {isComposing: true}, {altKey: true}, {shiftKey: true}]) {
    value.emit('onKeyDown', root, {key: 'Enter', ctrlKey: true, ...patch});
  }
  const header = value.host.querySelector('[data-cdt-sort="duration"]');
  assert.equal(value.emit('onKeyDown', header, {key: 'Enter', repeat: true}).defaultPrevented, true);
  assert.equal(value.emit('onKeyDown', root.querySelector('[data-playlists-play]'), {key: 'Enter', repeat: true}).defaultPrevented, true);
  await settled(); assert.deepEqual(value.plays, []);
});

test('double-clicking explicit Play dispatches only its first click', async t => {
  const value = await fixture(t), button = value.row('b').querySelector('[data-playlists-play]');
  value.emit('onClick', button, {detail: 1}); value.emit('onClick', button, {detail: 2}); value.emit('onDoubleClick', button);
  await settled(); assert.equal(value.plays.length, 1);
});

test('native Love cycles without selection or playback and retains its focused button through acknowledgement', async t => {
  const value = await fixture(t), requests = [];
  let finish, tier = 'off';
  const preference = () => ({identity: 'opaque:owned', love_tier: tier, rating: null, allowed_actions: {can_set_love_tier: true}});
  value.runtime.trackPreference = track => track === value.rows[0] ? preference() : null;
  value.runtime.setTrackLove = request => {requests.push(request); return new Promise(resolve => {finish = resolve;});};
  value.render({rows: [...value.rows]});
  const button = value.row('b').querySelector('[data-track-love]'); button.focus();
  value.emit('onClick', button); value.emit('onClick', button, {detail: 2}); value.emit('onDoubleClick', button);
  value.render(); await settled();
  assert.equal(requests.length, 1); assert.equal(requests[0].love_tier, 'loved'); assert.equal(requests[0].context.scopeKey, value.state.scopeKey);
  assert.equal(button, value.row('b').querySelector('[data-track-love]')); assert.equal(value.doc.activeElement, button); assert.equal(button.disabled, true);
  assert.deepEqual(value.selects, []); assert.deepEqual(value.plays, []);
  tier = 'loved'; finish(preference()); await settled(); value.render();
  assert.equal(button, value.row('b').querySelector('[data-track-love]')); assert.equal(value.doc.activeElement, button);
  assert.equal(button.disabled, false); assert.equal(button.dataset.loveTier, 'loved');
});

test('retired Playlist rows cancel pending Love and cannot receive late feedback', async t => {
  const value = await fixture(t), requests = []; let finish;
  const preference = {identity: 'opaque:owned', love_tier: 'off', rating: null, allowed_actions: {can_set_love_tier: true}};
  value.runtime.trackPreference = () => preference;
  value.runtime.setTrackLove = request => {requests.push(request); return new Promise(resolve => {finish = resolve;});};
  value.render({rows: [...value.rows]}); value.emit('onClick', value.row('b').querySelector('[data-track-love]')); await settled();
  value.replaceRows(value.rows.slice(1)); value.render(); assert.equal(requests[0].signal.aborted, true);
  finish({...preference, love_tier: 'loved'}); await settled(); value.render();
  assert.deepEqual(value.errors, []); assert.equal(value.row('b'), null); assert.deepEqual(value.selects, []); assert.deepEqual(value.plays, []);
});

test('changing Playlist filters retires pending Love even when the row stays visible', async t => {
  const value = await fixture(t), requests = []; let finish;
  const preference = {identity: 'opaque:owned', love_tier: 'off', rating: null, allowed_actions: {can_set_love_tier: true}};
  value.runtime.trackPreference = () => preference;
  value.runtime.setTrackLove = request => {requests.push(request); return new Promise(resolve => {finish = resolve;});};
  value.render({rows: [...value.rows]}); value.emit('onClick', value.row('b').querySelector('[data-track-love]')); await settled();
  value.patchState({filters: {[value.detail.playlist_id]: {query: 'b'}}}); value.render();
  assert.ok(value.row('b')); assert.equal(requests[0].signal.aborted, true);
  finish({...preference, love_tier: 'loved'}); await settled(); assert.deepEqual(value.errors, []);
});

for (const patch of [{availability: 'missing'}, {source_readable: false}, {playlist_item_id: null}]) {
  test(`unplayable row blocks every playback gesture: ${JSON.stringify(patch)}`, async t => {
    const value = await fixture(t, {rows: [row('blocked', patch)]}), root = value.row('blocked');
    const button = root.querySelector('[data-playlists-play]'); assert.equal(button.disabled, true);
    value.emit('onClick', button); value.emit('onDoubleClick', root); value.emit('onKeyDown', root, {key: 'Enter', ctrlKey: true});
    await settled(); assert.deepEqual(value.plays, []);
  });
}

test('denied playlist capability blocks every playback gesture even when the runtime would allow it', async t => {
  const value = await fixture(t, {grants: {can_play: false}}), root = value.row('b');
  value.emit('onClick', root.querySelector('[data-playlists-play]')); value.emit('onDoubleClick', root);
  value.emit('onKeyDown', root, {key: 'Enter', ctrlKey: true}); await settled(); assert.deepEqual(value.plays, []);
});

test('scope, view, provider, filter and unmount retirement blocks stale explicit and row handlers', async t => {
  const changes = [
    value => value.patchState({scopeKey: 'scope:other'}),
    value => value.patchState({selectedPlaylistId: 'other'}),
    value => value.replaceRows(value.rows.map(track => ({...track}))),
    value => value.patchState({resource: {status: 'denied', data: null}}),
    value => value.patchState({filters: {[value.detail.playlist_id]: {query: 'gone'}}}),
    value => value.render({rows: value.rows.slice(1)}),
    value => value.render({rows: value.rows.map(track => ({...track}))}),
    value => {value.runtime.canTrackIntent = () => false;},
    value => {value.runtime.trackIntent = () => {assert.fail('replacement provider must not receive stale intent');};},
    value => value.render({runtime: {...value.runtime}}),
    value => {value.sort('duration');},
    value => value.close(),
  ];
  for (const [changeIndex, change] of changes.entries()) {
    for (const action of ['explicit', 'double', 'keyboard']) {
      const value = await fixture(t), root = value.row('b'), handlers = value.render();
      const nativeHandler = action !== 'explicit' && value.host.listeners.filter(entry => entry.type === (action === 'double' ? 'dblclick' : 'keydown') && !entry.capture).at(-1).callback;
      change(value);
      if (action === 'explicit') value.emit('onClick', root.querySelector('[data-playlists-play]'), {}, handlers);
      if (nativeHandler) nativeHandler({target: root, button: 0, key: action === 'keyboard' ? 'Enter' : undefined,
        ctrlKey: action === 'keyboard', preventDefault() {}, defaultPrevented: false});
      await settled(); assert.deepEqual(value.plays, [], `${action} stale dispatch must be rejected (change ${changeIndex})`);
      value.close();
    }
  }
});

test('runtime authorization is rechecked at dispatch and stale playback failures do not paint a new view', async t => {
  const value = await fixture(t); let allowed = true, reject;
  value.runtime.canTrackIntent = () => allowed; value.render();
  allowed = false; value.emit('onDoubleClick', value.row('b')); await settled(); assert.deepEqual(value.plays, []);
  allowed = true; value.runtime.trackIntent = () => new Promise((_resolve, fail) => {reject = fail;}); value.render();
  value.emit('onDoubleClick', value.row('b')); await settled();
  value.patchState({scopeKey: 'next'}); reject(new Error('unavailable')); await settled(); assert.deepEqual(value.errors, []);
});

test('a newer native player choice survives every older Playlist playback gesture', async t => {
  for (const action of ['explicit', 'double', 'keyboard']) {
    const value = await fixture(t); let playing = null;
    value.runtime.trackIntent = (_intent, track) => {playing = track.playlist_item_id; return Promise.resolve();}; value.render();
    const root = value.row('b');
    if (action === 'explicit') value.emit('onClick', root.querySelector('[data-playlists-play]'));
    if (action === 'double') value.emit('onDoubleClick', root);
    if (action === 'keyboard') value.emit('onKeyDown', root, {key: 'Enter', ctrlKey: true});
    assert.equal(playing, 'b', `${action} activates in its event turn`);
    playing = 'newer-native-choice'; await settled();
    assert.equal(playing, 'newer-native-choice'); assert.deepEqual(value.selects, []); value.close();
  }
});

test('provider replacement during the final grant check cannot receive the old click', async t => {
  const value = await fixture(t); let replaceDuringCheck = false;
  value.runtime.canTrackIntent = () => {
    if (replaceDuringCheck) value.runtime.trackIntent = () => assert.fail('replacement provider received the old intent');
    return true;
  };
  value.render(); replaceDuringCheck = true; value.emit('onDoubleClick', value.row('b'));
  await settled(); assert.deepEqual(value.plays, []); assert.deepEqual(value.errors, []);
});

test('synchronous throws and rejected native playback report the current generic failure', async t => {
  for (const intent of [() => {throw new Error('private failure');}, () => Promise.reject(new Error('private failure'))]) {
    const value = await fixture(t); value.runtime.trackIntent = intent; value.render();
    value.emit('onDoubleClick', value.row('b')); await settled();
    assert.deepEqual(value.errors, ['This track could not be played.']); value.close();
  }
});

for (const retirement of ['filter-cancel', 'grant-loss-sync']) {
  test(`current Playlist Love operation survives ${retirement} abort callback reentry`, async t => {
    const value = await fixture(t), requests = [], pending = [];
    let tier = 'off', allowed = true, abortCallbacks = 0, reentry;
    const preference = () => ({identity: 'opaque:reentry', love_tier: tier, rating: null,
      allowed_actions: {can_set_love_tier: allowed}});
    value.runtime.trackPreference = track => track === value.rows[0] ? preference() : null;
    value.runtime.setTrackLove = request => {
      requests.push(request);
      return new Promise((resolve, reject) => pending.push({resolve, reject}));
    };
    value.render({rows: [...value.rows]});
    const original = value.row('b').querySelector('[data-track-love]'); original.focus();
    value.emit('onClick', original); await settled();
    assert.equal(requests.length, 1); assert.equal(original.disabled, true);
    requests[0].signal.addEventListener('abort', () => {
      abortCallbacks++;
      // The old provider's abort callback can synchronously update the actual
      // current owner, restore authority and activate its connected control.
      allowed = true; value.render();
      const button = value.row('b').querySelector('[data-track-love]');
      reentry = {button, connected: button?.isConnected, disabled: button?.disabled};
      if (button) value.emit('onClick', button);
    }, {once: true});
    if (retirement === 'filter-cancel') value.patchState({filters: {[value.detail.playlist_id]: {query: 'b'}}});
    else allowed = false;
    value.render(); await settled();
    assert.equal(abortCallbacks, 1);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(reentry.connected, true); assert.equal(reentry.disabled, false);
    const currentButton = reentry.button;
    if (retirement === 'filter-cancel') {
      // The filter removes the structural Order column. The new operation
      // belongs to the newly mounted current button, not the detached old row.
      assert.equal(value.host.querySelector('[data-cdt-column="order"]'), null);
      assert.equal(value.host.querySelector('[data-playlists-drag]'), null);
      assert.equal(value.host.querySelector('[data-playlists-move]'), null);
      assert.equal(original.isConnected, false);
      assert.notEqual(currentButton, original);
    } else assert.equal(currentButton, original);
    assert.equal(requests.length, 2, 'the new current operation reaches its real provider');
    assert.equal(requests[1].signal.aborted, false);
    assert.equal(value.row('b').querySelector('[data-track-love]'), currentButton);
    assert.equal(currentButton.disabled, true);
    // An old completion must not clear the replacement's pending entry.
    pending[0].reject(new Error('retired private failure')); await settled();
    assert.equal(requests[1].signal.aborted, false); assert.equal(currentButton.disabled, true);
    assert.deepEqual(value.errors, []);
    tier = 'loved'; pending[1].resolve(preference()); await settled(); value.render();
    assert.equal(requests[1].signal.aborted, false);
    assert.equal(value.row('b').querySelector('[data-track-love]'), currentButton);
    assert.equal(currentButton.disabled, false); assert.equal(currentButton.dataset.loveTier, 'loved');
    assert.equal(value.doc.activeElement, currentButton);
    assert.deepEqual(value.errors, []); assert.deepEqual(value.selects, []); assert.deepEqual(value.plays, []);
  });
}

for (const status of [401, 403]) {
  test(`Playlist permission-loss sync retains current ${status} denial feedback`, async t => {
    const value = await fixture(t), requests = [];
    let allowed = true, reject;
    const preference = () => ({identity: 'opaque:denial', love_tier: 'off', rating: null,
      allowed_actions: {can_set_love_tier: allowed}});
    value.runtime.trackPreference = track => track === value.rows[0] ? preference() : null;
    value.runtime.setTrackLove = request => {requests.push(request); return new Promise((_resolve, fail) => {reject = fail;});};
    value.render(); value.emit('onClick', value.row('b').querySelector('[data-track-love]')); await settled();
    assert.equal(requests.length, 1);
    allowed = false; value.render(); assert.equal(requests[0].signal.aborted, true);
    reject(Object.assign(new Error('private denial'), {status})); await settled();
    assert.deepEqual(value.errors, ['You no longer have permission to change Love for this track.']);
    assert.deepEqual(value.plays, []); assert.deepEqual(value.selects, []);
    assert.equal(value.row('b').querySelector('[data-track-love]'), null);
  });
}

test('filter cancellation does not turn an old permission denial into current feedback', async t => {
  const value = await fixture(t), requests = [];
  let reject;
  const preference = {identity: 'opaque:filter-denial', love_tier: 'off', rating: null,
    allowed_actions: {can_set_love_tier: true}};
  value.runtime.trackPreference = track => track === value.rows[0] ? preference : null;
  value.runtime.setTrackLove = request => {requests.push(request); return new Promise((_resolve, fail) => {reject = fail;});};
  value.render(); value.emit('onClick', value.row('b').querySelector('[data-track-love]')); await settled();
  value.patchState({filters: {[value.detail.playlist_id]: {query: 'b'}}}); value.render();
  assert.equal(requests[0].signal.aborted, true);
  reject(Object.assign(new Error('retired private denial'), {status: 403})); await settled();
  assert.deepEqual(value.errors, []); assert.deepEqual(value.plays, []); assert.deepEqual(value.selects, []);
});

for (const status of [401, 403]) {
  for (const phase of ['replacement-pending', 'replacement-settled', 'replacement-settled-then-revoked']) {
    test(`old ${status} denial cannot paint after grant-loss reentry with ${phase}`, async t => {
      const value = await fixture(t), requests = [], pending = [];
      let allowed = true, tier = 'off', abortCallbacks = 0, reentry;
      const preference = () => ({identity: 'opaque:denial-reentry', love_tier: tier, rating: null,
        allowed_actions: {can_set_love_tier: allowed}});
      value.runtime.trackPreference = track => track === value.rows[0] ? preference() : null;
      value.runtime.setTrackLove = request => {
        requests.push(request);
        return new Promise((resolve, reject) => pending.push({resolve, reject}));
      };
      value.render();
      const original = value.row('b').querySelector('[data-track-love]'); original.focus();
      value.emit('onClick', original); await settled(); assert.equal(requests.length, 1);
      requests[0].signal.addEventListener('abort', () => {
        abortCallbacks++;
        allowed = true; value.render();
        const button = value.row('b').querySelector('[data-track-love]');
        reentry = {button, connected: button?.isConnected, disabled: button?.disabled};
        if (button) value.emit('onClick', button);
      }, {once: true});
      allowed = false; value.render(); await settled();
      assert.equal(abortCallbacks, 1); assert.equal(requests[0].signal.aborted, true);
      assert.equal(reentry.connected, true); assert.equal(reentry.disabled, false);
      assert.equal(reentry.button, original);
      assert.equal(requests.length, 2); assert.equal(requests[1].signal.aborted, false);
      assert.equal(original.disabled, true);
      if (phase !== 'replacement-pending') {
        tier = 'loved'; pending[1].resolve(preference()); await settled(); value.render();
        assert.equal(original.disabled, false); assert.equal(original.dataset.loveTier, 'loved');
        if (phase === 'replacement-settled-then-revoked') {
          allowed = false; value.render();
          assert.equal(value.row('b').querySelector('[data-track-love]'), null);
        }
      }
      pending[0].reject(Object.assign(new Error('retired private denial'), {status})); await settled();
      assert.deepEqual(value.errors, [], 'retired denial must not be attributed to replacement authority');
      assert.equal(requests[1].signal.aborted, false);
      if (phase === 'replacement-pending') {
        assert.equal(value.row('b').querySelector('[data-track-love]'), original);
        assert.equal(original.disabled, true);
        tier = 'loved'; pending[1].resolve(preference()); await settled(); value.render();
        assert.equal(original.disabled, false); assert.equal(original.dataset.loveTier, 'loved');
      }
      assert.deepEqual(value.errors, []); assert.deepEqual(value.selects, []); assert.deepEqual(value.plays, []);
    });
  }
}
