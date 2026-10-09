const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const load = import('../../../music_app/static/js/playtables/selection.mjs');

const facts = (rowKey, sectionKey = 'disc:1', extra = {}) => ({rowKey, sectionKey, readable: true, selectable: true, ...extra});
function source(rows = [facts('a'), facts('b'), facts('c', 'disc:2')]) {
  let value = {scopeKey: 'account/library', instance: {}, revision: 1, rows};
  const listeners = new Set();
  return {snapshot: () => value, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    patch(next) {value = {...value, ...next}; for (const listener of [...listeners]) listener();},
    replace(next) {value = next; for (const listener of [...listeners]) listener();}, listeners};
}
async function core(t, rows) {
  const adapter = source(rows), {createPlaytableSelection} = await load;
  const owner = createPlaytableSelection({sourceAdapter: adapter, tableKey: 'album'});
  t.after(() => owner.dispose()); return {adapter, owner};
}

test('plain selection, additive toggles and context share one ordered set across discs', async t => {
  const {owner} = await core(t);
  owner.select('a'); owner.select('c', {toggle: true}); owner.select('b', {toggle: true});
  assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['a', 'c', 'b']);
  owner.context('c'); assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['a', 'c', 'b']);
  owner.select('a', {toggle: true}); assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['c', 'b']);
  owner.context('a'); assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['a']);
  owner.select('a', {toggle: true}); assert.equal(owner.getSnapshot().selectedCount, 0);
  assert.equal(owner.action(), null);
});

test('action keys follow current source order while highlight order retains every occurrence', async t => {
  const {owner, adapter} = await core(t);
  owner.select('c'); owner.select('a', {toggle: true});
  const original = owner.action();
  assert.deepEqual(original.packet, {scopeKey: 'account/library', row_keys: ['a', 'c'], origin: {tableKey: 'album', target: 'selection'}});
  adapter.patch({rows: [facts('c', 'disc:2'), facts('b'), facts('a')]});
  assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['c', 'a']);
  assert.equal(original.lifetime.isCurrent(), false);
  assert.deepEqual(owner.action().packet.row_keys, ['c', 'a']);
});

test('filter/access removal drops only no-longer-exposed selections and reports the new count', async t => {
  const {owner, adapter} = await core(t);
  owner.select('a'); owner.select('b', {toggle: true}); owner.select('c', {toggle: true});
  adapter.patch({rows: [facts('a'), facts('c', 'disc:2', {readable: false})]});
  assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['a']);
  assert.equal(owner.getSnapshot().selectedCount, 1); assert.equal(owner.getSnapshot().droppedCount, 2);
  assert.equal(owner.select('b'), false); assert.equal(owner.select('c'), false);
  adapter.patch({rows: [facts('a'), facts('b'), facts('c', 'disc:2')]});
  assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['a']);
});

test('section actions use exact current order without rewriting the selected set', async t => {
  const {owner, adapter} = await core(t);
  owner.select('c');
  const section = owner.action({target: 'section', sectionKey: 'disc:1'});
  assert.deepEqual(section.packet.row_keys, ['a', 'b']);
  assert.deepEqual(section.packet.origin, {tableKey: 'album', target: 'section', sectionKey: 'disc:1'});
  assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['c']);
  owner.select('a'); assert.equal(section.lifetime.isCurrent(), true);
  adapter.patch({rows: [facts('b'), facts('c', 'disc:2')]});
  assert.equal(section.lifetime.isCurrent(), false);
  assert.deepEqual(owner.action({target: 'section', sectionKey: 'disc:1'}).packet.row_keys, ['b']);
  assert.equal(owner.action({target: 'section', sectionKey: 'absent'}), null);
});

test('a section cannot silently omit denied or unselectable rows', async t => {
  const {owner} = await core(t, [facts('a'), facts('b', 'disc:1', {selectable: false})]);
  assert.equal(owner.action({target: 'section', sectionKey: 'disc:1'}), null);
  assert.equal(owner.select('b'), false);
  owner.select('a'); assert.deepEqual(owner.action().packet.row_keys, ['a']);
});

test('source/provider/scope retirement and observed ABA never resurrect selection or callbacks', async t => {
  const {owner, adapter} = await core(t), original = adapter.snapshot();
  owner.select('a'); const action = owner.action(); let invalidations = 0;
  action.lifetime.subscribeInvalidation(() => invalidations++);
  adapter.patch({instance: {}}); adapter.replace(original);
  assert.equal(invalidations, 1); assert.equal(action.lifetime.signal.aborted, true);
  assert.equal(action.lifetime.isCurrent(), false); assert.deepEqual(owner.getSnapshot().selectedRowKeys, []);
  owner.select('a'); adapter.patch({scopeKey: 'another-account/library'});
  assert.equal(owner.getSnapshot().selectedCount, 0);
});

test('exact view revisions revoke receipts even when row keys and source instance match', async t => {
  const {owner, adapter} = await core(t);
  owner.select('a'); const action = owner.action();
  adapter.patch({revision: 2});
  assert.equal(action.lifetime.isCurrent(), false); assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['a']);
  const next = owner.action(); owner.select('b'); owner.select('a');
  assert.equal(next.lifetime.isCurrent(), false);
});

test('invalid, duplicate and retired sources fail closed without leaking private properties', async t => {
  const {owner, adapter} = await core(t, [facts('a', 'disc:1', {track_ref: {path: '/private/music'}, canonical_track_ref: 'private'})]);
  owner.select('a');
  assert.doesNotMatch(JSON.stringify(owner.getSnapshot()), /private|track_ref/);
  assert.deepEqual(Object.keys(owner.getSnapshot().rows[0]), ['rowKey', 'sectionKey', 'readable', 'selectable']);
  assert.equal(Object.isFrozen(owner.getSnapshot().rows[0]), true);
  adapter.patch({rows: [facts('a'), facts('a')]});
  assert.equal(owner.getSnapshot().selectedCount, 0); assert.equal(owner.select('a'), false);
  adapter.patch({rows: [facts('a')], active: false});
  assert.equal(owner.action({target: 'section', sectionKey: 'disc:1'}), null);
});

test('disposal retires receipts and subscriptions exactly once', async t => {
  const {owner, adapter} = await core(t);
  owner.select('a'); const action = owner.action(); let retired = 0;
  action.lifetime.subscribeInvalidation(() => retired++);
  owner.dispose(); owner.dispose();
  assert.equal(adapter.listeners.size, 0); assert.equal(retired, 1); assert.equal(owner.select('a'), false);
  assert.equal(action.lifetime.isCurrent(), false);
  action.lifetime.subscribeInvalidation(() => retired++); assert.equal(retired, 2);
});

test('a newer action retires an older receipt without changing row selection', async t => {
  const {owner} = await core(t);
  owner.select('c'); const first = owner.action();
  const second = owner.action({target: 'section', sectionKey: 'disc:1'});
  assert.equal(first.lifetime.isCurrent(), false); assert.equal(second.lifetime.isCurrent(), true);
  assert.deepEqual(owner.getSnapshot().selectedRowKeys, ['c']);
  second.lifetime.dispose(); assert.equal(second.lifetime.isCurrent(), false);
});

test('synchronous invalidation cannot reopen an action against a replaced source', async t => {
  const {owner, adapter} = await core(t);
  owner.select('a'); const previous = owner.action();
  previous.lifetime.subscribeInvalidation(() => adapter.patch({instance: {}}));
  assert.equal(owner.action(), null);
  assert.equal(owner.getSnapshot().selectedCount, 0);
  owner.select('b'); const next = owner.action();
  next.lifetime.subscribeInvalidation(() => owner.dispose());
  assert.equal(owner.select('a'), false); assert.equal(owner.getSnapshot().selectedCount, 0);
});

async function dom(t, options = {}) {
  const env = createNativeHomeRuntime(), doc = env.document;
  const host = doc.createElement('section'); doc.body.appendChild(host);
  const adapter = source(), calls = {inspect: [], play: [], actions: []};
  const render = () => {
    host.innerHTML = '<div class="compact-data-table" data-cdt-selection="multiple">'
      + adapter.snapshot().rows.map(row => `<div role="row" data-cdt-row-key="${row.rowKey}" tabindex="0" class="album-track-table__row"><span>${row.rowKey}</span><button>Play</button></div>`).join('')
      + '</div><button data-playtable-section-action="disc:1">Section</button>';
  };
  render();
  const {bindPlaytableSelection} = await load;
  const owner = bindPlaytableSelection(host, {sourceAdapter: adapter, tableKey: 'album',
    onInspect: rowKey => calls.inspect.push(rowKey), onPlay: rowKey => calls.play.push(rowKey),
    onPlaylistAction: (packet, lifetime, anchor) => calls.actions.push({packet, lifetime, anchor}), ...options});
  const emit = (target, type, props = {}) => {
    const event = new env.context.Event(type); Object.assign(event, {detail: 1}, props); target.dispatchEvent(event); return event;
  };
  const row = rowKey => host.querySelectorAll('[data-cdt-row-key]').find(node => node.dataset.cdtRowKey === rowKey);
  t.after(() => {owner.dispose(); assert.equal(host.listeners.length, 0); assert.equal(doc.listeners.length, 0);});
  return {env, host, doc, adapter, calls, render, owner, emit, row};
}

test('native click selects without playing and preserves row/button nodes and current paint', async t => {
  const value = await dom(t), a = value.row('a'), button = a.querySelector('button');
  a.classList.add('album-track-table__row--playing', 'album-track-table__row--missing'); a.setAttribute('aria-current', 'true');
  value.emit(a.firstElementChild, 'click'); value.emit(value.row('c'), 'click', {metaKey: true});
  assert.deepEqual(value.calls.inspect, ['a']); assert.deepEqual(value.calls.play, []);
  assert.equal(value.row('a'), a); assert.equal(a.querySelector('button'), button);
  assert.equal(a.getAttribute('aria-selected'), 'true'); assert.equal(a.getAttribute('aria-current'), 'true');
  assert.equal(a.classList.contains('album-track-table__row--playing'), true);
  assert.equal(a.classList.contains('album-track-table__row--missing'), true);
  value.emit(a, 'click', {ctrlKey: true, detail: 2}); assert.equal(a.getAttribute('aria-selected'), 'true');
});

test('context on selected rows preserves the set and section actions do not select', async t => {
  const value = await dom(t);
  value.emit(value.row('a'), 'click'); value.emit(value.row('c'), 'click', {ctrlKey: true});
  assert.equal(value.emit(value.row('a'), 'contextmenu', {button: 2}).defaultPrevented, true);
  assert.deepEqual(value.calls.actions[0].packet.row_keys, ['a', 'c']);
  value.emit(value.host.querySelector('[data-playtable-section-action]'), 'click');
  assert.deepEqual(value.calls.actions[1].packet.row_keys, ['a', 'b']);
  assert.deepEqual(value.owner.getSnapshot().selectedRowKeys, ['a', 'c']);
  value.emit(value.row('b'), 'contextmenu', {button: 2});
  assert.deepEqual(value.calls.actions[2].packet.row_keys, ['b']);
});

test('macOS Ctrl-click in either browser ordering does not toggle the selected set', async t => {
  const value = await dom(t, {platform: 'mac'});
  value.emit(value.row('a'), 'click'); value.emit(value.row('c'), 'click', {metaKey: true});
  value.emit(value.row('a'), 'click', {ctrlKey: true}); value.emit(value.row('a'), 'contextmenu', {ctrlKey: true});
  assert.deepEqual(value.calls.actions[0].packet.row_keys, ['a', 'c']);
  value.emit(value.row('b'), 'contextmenu', {ctrlKey: true}); value.emit(value.row('b'), 'click', {ctrlKey: true});
  assert.deepEqual(value.owner.getSnapshot().selectedRowKeys, ['b']);
});

test('interactive descendants, composition, repeated keys and secondary clicks retain native ownership', async t => {
  const value = await dom(t), row = value.row('a');
  for (const type of ['click', 'contextmenu', 'dblclick', 'keydown']) value.emit(row.querySelector('button'), type, {key: 'Enter'});
  value.emit(row, 'click', {button: 2}); value.emit(row, 'click', {isComposing: true});
  value.emit(row, 'keydown', {key: 'Enter', repeat: true}); value.emit(row, 'keydown', {key: 'Enter', ctrlKey: true, isComposing: true});
  value.emit(row, 'keydown', {key: 'F10', shiftKey: true, repeat: true});
  assert.deepEqual(value.calls, {inspect: [], play: [], actions: []}); assert.equal(value.owner.getSnapshot().selectedCount, 0);
});

test('keyboard selection/context and explicit playback remain distinct guarded intents', async t => {
  const value = await dom(t), row = value.row('a');
  assert.equal(value.emit(row, 'keydown', {key: ' '}).defaultPrevented, true);
  value.emit(value.row('c'), 'keydown', {key: ' ', ctrlKey: true});
  assert.deepEqual(value.owner.getSnapshot().selectedRowKeys, ['a', 'c']);
  value.emit(row, 'keydown', {key: 'F10', shiftKey: true});
  value.emit(row, 'contextmenu'); assert.equal(value.calls.actions.length, 1);
  value.emit(row, 'keydown', {key: 'Enter', ctrlKey: true}); value.emit(row, 'dblclick', {detail: 2});
  assert.deepEqual(value.calls.play, ['a', 'a']);
  assert.deepEqual(value.calls.inspect, ['a']);
});

test('native context menu is retained without an app action and duplicate DOM keys cannot act', async t => {
  const value = await dom(t, {onPlaylistAction: undefined});
  assert.equal(value.emit(value.row('a'), 'contextmenu').defaultPrevented, false);
  assert.equal(value.owner.getSnapshot().selectedCount, 1);
  value.host.insertAdjacentHTML('beforeend', '<div data-cdt-row-key="a">Duplicate</div>');
  value.emit(value.row('a'), 'click'); value.emit(value.row('a'), 'dblclick');
  assert.deepEqual(value.calls.inspect, []); assert.deepEqual(value.calls.play, []);
});

test('filter refresh and row replacement repaint current keys but detached old nodes cannot dispatch', async t => {
  const value = await dom(t), before = value.row('a');
  value.emit(before, 'click');
  value.adapter.patch({rows: [facts('c', 'disc:2'), facts('a')]}); value.render(); value.owner.update();
  assert.notEqual(value.row('a'), before); assert.equal(value.row('a').getAttribute('aria-selected'), 'true');
  value.emit(before, 'dblclick'); assert.deepEqual(value.calls.play, []);
  value.adapter.patch({rows: [facts('c', 'disc:2')]}); value.render(); value.owner.update();
  assert.equal(value.owner.getSnapshot().selectedCount, 0); assert.equal(value.owner.getSnapshot().droppedCount, 1);
});

test('disposal never removes selection painted by a replacement table owner', async t => {
  const value = await dom(t); value.emit(value.row('a'), 'click');
  value.host.innerHTML = '<div data-cdt-row-key="a" aria-selected="true">Replacement resource</div>';
  const next = value.row('a'); value.owner.dispose();
  assert.equal(next.getAttribute('aria-selected'), 'true');
});

test('deliberate row playback clears only text selection contained in that row', async t => {
  const value = await dom(t), row = value.row('a'), text = row.firstElementChild.firstChild;
  let cleared = 0;
  const selection = {anchorNode: text, focusNode: text, removeAllRanges() {cleared++;}};
  value.doc.getSelection = () => selection;
  value.emit(row, 'dblclick'); assert.equal(cleared, 1);
  selection.anchorNode = value.row('b'); value.emit(row, 'dblclick'); assert.equal(cleared, 1);
  value.emit(row.querySelector('button'), 'dblclick'); assert.equal(value.calls.play.length, 2);
});

test('transient stale rendered views retire action receipts without destroying same-source selection', async t => {
  let current = true;
  const value = await dom(t, {isViewCurrent: () => current});
  value.emit(value.row('a'), 'click'); value.emit(value.row('a'), 'contextmenu');
  current = false;
  assert.equal(value.calls.actions[0].lifetime.isCurrent(), false);
  value.emit(value.row('b'), 'click'); value.emit(value.row('a'), 'dblclick');
  assert.deepEqual(value.owner.getSnapshot().selectedRowKeys, ['a']); assert.deepEqual(value.calls.play, []);
  current = true; value.owner.update();
  assert.deepEqual(value.owner.getSnapshot().selectedRowKeys, ['a']);
  assert.equal(value.calls.actions[0].lifetime.isCurrent(), false);
});

function tap(value, rowKey, timeStamp, patch = {}) {
  const row = value.row(rowKey), pointer = {pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: 20, clientY: 20, ...patch};
  value.emit(row, 'pointerdown', {...pointer, timeStamp});
  value.emit(row, 'pointerup', {...pointer, timeStamp: timeStamp + 10});
  return value.emit(row, 'click', {timeStamp: timeStamp + 11, ...patch});
}

test('touch double-tap plays without a browser dblclick and suppresses a trailing dblclick', async t => {
  const value = await dom(t);
  tap(value, 'a', 100); assert.deepEqual(value.calls.play, []);
  assert.equal(value.row('a').getAttribute('aria-selected'), 'true');
  tap(value, 'a', 230); assert.deepEqual(value.calls.play, ['a']);
  value.emit(value.row('a'), 'dblclick', {timeStamp: 245, detail: 2});
  assert.deepEqual(value.calls.play, ['a']); assert.deepEqual(value.calls.inspect, ['a']);
  value.emit(value.row('a'), 'pointerdown', {pointerType: 'mouse', timeStamp: 1000});
  value.emit(value.row('a'), 'dblclick', {timeStamp: 1020});
  assert.deepEqual(value.calls.play, ['a', 'a']);
});

test('only a recognized touch double-tap requests native restart, once even with a trailing dblclick', async t => {
  const plays = [];
  const value = await dom(t, {onPlay: (rowKey, event, options) => plays.push({rowKey, type: event.type, options})});
  tap(value, 'a', 100); tap(value, 'a', 230);
  assert.deepEqual(plays, [{rowKey: 'a', type: 'click', options: {restart: true}}]);
  value.emit(value.row('a'), 'dblclick', {timeStamp: 245, detail: 2});
  assert.equal(plays.length, 1);
  value.emit(value.row('a'), 'pointerdown', {pointerType: 'mouse', timeStamp: 1000});
  value.emit(value.row('a'), 'dblclick', {timeStamp: 1020});
  value.emit(value.row('a'), 'keydown', {key: 'Enter', ctrlKey: true, timeStamp: 1100});
  assert.deepEqual(plays.slice(1), [{rowKey: 'a', type: 'dblclick', options: undefined},
    {rowKey: 'a', type: 'keydown', options: undefined}]);
});

test('late, different-row, modified and source-replaced touch taps never form a playback pair', async t => {
  for (const scenario of ['late', 'different', 'modified', 'source', 'revision']) {
    const value = await dom(t); tap(value, 'a', 100);
    if (scenario === 'source') value.adapter.patch({instance: {}});
    if (scenario === 'revision') value.adapter.patch({revision: 2});
    tap(value, scenario === 'different' ? 'b' : 'a', scenario === 'late' ? 600 : 220,
      scenario === 'modified' ? {ctrlKey: true} : {});
    assert.deepEqual(value.calls.play, [], scenario);
  }
});

test('touch scrolling, cancellation and native descendant controls cannot complete a row double-tap', async t => {
  const value = await dom(t); tap(value, 'a', 100);
  const row = value.row('a');
  value.emit(row, 'pointerdown', {pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 20, timeStamp: 200});
  value.emit(row, 'pointermove', {pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 80, timeStamp: 210});
  value.emit(row, 'pointerup', {pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 20, timeStamp: 220});
  value.emit(row, 'click', {pointerType: 'touch', timeStamp: 221});
  assert.deepEqual(value.calls.play, []);
  tap(value, 'a', 1000);
  value.emit(row, 'pointercancel'); tap(value, 'a', 1120); assert.deepEqual(value.calls.play, []);
  const button = row.querySelector('button');
  value.emit(button, 'pointerdown', {pointerType: 'touch', timeStamp: 1200});
  value.emit(button, 'click', {pointerType: 'touch', timeStamp: 1210});
  tap(value, 'a', 1280); assert.deepEqual(value.calls.play, []);
});
