const key = value => typeof value === 'string' && value.length > 0;
const sameKeys = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const sameRows = (left, right) => left.length === right.length && left.every((row, index) => {
  const next = right[index];
  return row.rowKey === next.rowKey && row.sectionKey === next.sectionKey
    && row.readable === next.readable && row.selectable === next.selectable;
});

// This projection is deliberately a whitelist. Native media/write identities
// remain in the source adapter, never in selection state or action packets.
function readSource(adapter) {
  let value;
  try {value = adapter.snapshot();} catch {return null;}
  if (!value || value.active === false || !key(value.scopeKey) || value.instance == null || !Array.isArray(value.rows)) return null;
  const seen = new Set(), rows = [];
  for (const row of value.rows) {
    if (!key(row?.rowKey) || seen.has(row.rowKey)) return null;
    seen.add(row.rowKey);
    rows.push(Object.freeze({rowKey: row.rowKey, sectionKey: key(row.sectionKey) ? row.sectionKey : null,
      readable: row.readable === true, selectable: row.readable === true && row.selectable !== false}));
  }
  return {scopeKey: value.scopeKey, instance: value.instance, revision: value.revision, rows: Object.freeze(rows)};
}

export const EMPTY_PLAYTABLE_SELECTION = Object.freeze({scopeKey: null, rows: Object.freeze([]),
  selectedRowKeys: Object.freeze([]), focusedRowKey: null, generation: 0, selectedCount: 0, droppedCount: 0});

/** One owner per logical source, spanning all rendered sections. The adapter
 * replaces instance on source/provider/access replacement, and revision for a
 * changed view or mapping not represented by the public row facts. */
export function createPlaytableSelection({sourceAdapter, tableKey = 'playtable', isViewCurrent = () => true}) {
  if (typeof sourceAdapter?.snapshot !== 'function') throw new TypeError('Playtable selection needs a source adapter.');
  if (!key(tableKey)) throw new TypeError('Playtable selection needs a public table key.');
  let source = null, snapshot = EMPTY_PLAYTABLE_SELECTION, disposed = false, viewGeneration = 0, selectionGeneration = 0, anchor = null;
  const listeners = new Set(), receipts = new Set();
  const currentView = () => {try {return isViewCurrent() === true;} catch {return false;}};
  const publish = (selectedRowKeys, focusedRowKey, droppedCount = 0) => {
    snapshot = Object.freeze({scopeKey: source?.scopeKey || null, rows: source?.rows || EMPTY_PLAYTABLE_SELECTION.rows,
      selectedRowKeys: Object.freeze(selectedRowKeys), focusedRowKey, generation: snapshot.generation + 1,
      selectedCount: selectedRowKeys.length, droppedCount});
    for (const listener of [...listeners]) listener();
  };
  const retire = target => {
    for (const receipt of [...receipts]) if (!target || receipt.target === target) receipt.abort();
  };
  const update = () => {
    if (disposed) return snapshot;
    const next = readSource(sourceAdapter);
    const replaced = source?.scopeKey !== next?.scopeKey || source?.instance !== next?.instance;
    const changed = replaced || source?.revision !== next?.revision || !sameRows(source?.rows || [], next?.rows || []);
    if (!changed) return snapshot;
    source = next; viewGeneration += 1;
    const selectable = new Set((source?.rows || []).filter(row => row.selectable).map(row => row.rowKey));
    if (replaced || !selectable.has(anchor)) anchor = null;
    const selected = replaced ? [] : snapshot.selectedRowKeys.filter(rowKey => selectable.has(rowKey));
    const dropped = replaced ? 0 : snapshot.selectedRowKeys.length - selected.length;
    if (replaced || !sameKeys(selected, snapshot.selectedRowKeys)) selectionGeneration += 1;
    const focused = !replaced && selectable.has(snapshot.focusedRowKey) ? snapshot.focusedRowKey : null;
    const generation = viewGeneration;
    retire();
    if (!disposed && generation === viewGeneration) publish(selected, focused, dropped);
    return snapshot;
  };
  const select = (rowKey, {toggle = false, preserve = false, range = false} = {}) => {
    update();
    if (disposed || !source?.rows.some(row => row.rowKey === rowKey && row.selectable)) return false;
    const before = snapshot.selectedRowKeys;
    const ordered = source.rows.filter(row => row.selectable).map(row => row.rowKey);
    const ranged = range && anchor !== null && ordered.includes(anchor);
    const first = ordered.indexOf(anchor), last = ordered.indexOf(rowKey);
    const rangeKeys = ranged ? ordered.slice(Math.min(first, last), Math.max(first, last) + 1) : null;
    const selected = ranged ? toggle ? [...new Set([...before, ...rangeKeys])] : rangeKeys
      : preserve && before.includes(rowKey) ? [...before]
      : toggle ? before.includes(rowKey) ? before.filter(value => value !== rowKey) : [...before, rowKey] : [rowKey];
    if (!sameKeys(before, selected)) {
      const view = viewGeneration, selection = ++selectionGeneration;
      retire('selection');
      if (disposed || view !== viewGeneration || selection !== selectionGeneration) return false;
    }
    if (!ranged && !(preserve && before.includes(rowKey))) anchor = rowKey;
    if (!sameKeys(before, selected) || snapshot.focusedRowKey !== rowKey || snapshot.droppedCount) publish(selected, rowKey);
    return true;
  };
  const action = ({target = 'selection', sectionKey} = {}) => {
    update();
    if (disposed || !source || !currentView() || !['selection', 'section'].includes(target) || target === 'section' && !key(sectionKey)) return null;
    const selected = new Set(snapshot.selectedRowKeys);
    const rows = source.rows.filter(row => target === 'section' ? row.sectionKey === sectionKey : selected.has(row.rowKey));
    if (!rows.length || rows.some(row => !row.selectable)) return null;
    const view = viewGeneration, selection = selectionGeneration;
    retire(); // One current action per source; a newer invocation supersedes it.
    update();
    if (disposed || !source || !currentView() || view !== viewGeneration
      || target === 'selection' && selection !== selectionGeneration) return null;
    const aborter = new AbortController();
    const invalidations = new Set();
    const receipt = {target, abort() {
      if (aborter.signal.aborted) return;
      receipts.delete(receipt); aborter.abort();
      for (const listener of [...invalidations]) listener();
      invalidations.clear();
    }};
    receipts.add(receipt);
    const isCurrent = () => {
      update();
      const valid = !disposed && !aborter.signal.aborted && currentView() && view === viewGeneration
        && (target === 'section' || selection === selectionGeneration);
      if (!valid) receipt.abort();
      return valid;
    };
    return {
      packet: Object.freeze({scopeKey: source.scopeKey, row_keys: Object.freeze(rows.map(row => row.rowKey)),
        origin: Object.freeze({tableKey, target, ...(target === 'section' ? {sectionKey} : {})})}),
      lifetime: Object.freeze({signal: aborter.signal, isCurrent,
        subscribeInvalidation(listener) {
          if (!isCurrent()) {listener(); return () => {};}
          invalidations.add(listener); return () => invalidations.delete(listener);
        },
        // The picker closes the receipt when finished without clearing selection.
        dispose: receipt.abort,
      }),
    };
  };
  update();
  const unsubscribe = sourceAdapter.subscribe?.(update);
  return {
    getSnapshot: () => snapshot, subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    update, select, context: rowKey => select(rowKey, {preserve: true}), action,
    dispose() {if (disposed) return; disposed = true; unsubscribe?.(); source = null; retire();
      publish([], null); listeners.clear();},
  };
}

export const PLAYTABLE_INTERACTIVE = 'button,a,input,select,textarea,label,summary,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],[role="button"],[role="link"],[role="checkbox"],[role="slider"],[data-cdt-sort],[data-playlists-drag]';
const ROW = '[data-cdt-row-key]';

/** Paint selection only. The existing player owner retains current/playing,
 * animation and missing-row paint; selection never replaces native row nodes. */
export function paintPlaytableSelection(host, snapshot) {
  const rows = new Map(snapshot.rows.map(row => [row.rowKey, row]));
  const selected = new Set(snapshot.selectedRowKeys);
  for (const node of host.querySelectorAll(ROW)) {
    const row = rows.get(node.getAttribute('data-cdt-row-key'));
    if (row?.selectable && selected.has(row.rowKey)) node.setAttribute('aria-selected', 'true');
    else node.removeAttribute('aria-selected');
  }
}

/** Host-scoped native event adapter, installed/disposed by the React owner.
 * Explicit descendant buttons remain their consumer's responsibility. */
export function bindPlaytableSelection(host, options) {
  const sourceAdapter = options.sourceAdapter;
  let current = options, disposed = false, suppressContext = null, painted = [];
  let touchPress = null, touchClick = null, lastTouch = null, playedTouch = null, touchCancelled = false;
  const time = event => Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now();
  const unmodified = event => !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  const currentView = () => {try {return typeof current.isViewCurrent !== 'function' || current.isViewCurrent() === true;} catch {return false;}};
  const owner = createPlaytableSelection({...options, isViewCurrent: currentView});
  const paint = () => {if (!disposed) {paintPlaytableSelection(host, owner.getSnapshot()); painted = [...host.querySelectorAll(ROW)];}};
  const unsubscribe = owner.subscribe(paint);
  const rowFor = event => {
    if (disposed || !host.isConnected || !currentView() || event.defaultPrevented || event.isComposing || !host.contains(event.target)
      || event.target.closest?.(PLAYTABLE_INTERACTIVE)) return null;
    owner.update();
    const node = event.target.closest?.(ROW), rowKey = node?.getAttribute('data-cdt-row-key');
    if (!node || !host.contains(node) || node.getAttribute('aria-disabled') === 'true') return null;
    const matches = [...host.querySelectorAll(ROW)].filter(row => row.getAttribute('data-cdt-row-key') === rowKey);
    return matches.length === 1 && owner.getSnapshot().rows.some(row => row.rowKey === rowKey && row.selectable) ? {node, rowKey} : null;
  };
  const invoke = (callback, args, message, isCurrent = () => true) => {
    const before = owner.getSnapshot();
    const failed = () => {owner.update();
      if (!disposed && owner.getSnapshot() === before && isCurrent()
        && (current.onPlay === callback || current.onPlaylistAction === callback || current.onContextAction === callback)) current.onError?.(message);
    };
    try {Promise.resolve(callback?.(...args)).catch(failed);}
    catch {failed();}
  };
  const open = (anchor, target = {}, options = {}) => {
    if (disposed || !host.isConnected || typeof current.onPlaylistAction !== 'function' && typeof current.onContextAction !== 'function') return false;
    const action = owner.action(target);
    if (!action) return false;
    invoke(options.context && current.onContextAction || current.onPlaylistAction, [action.packet, action.lifetime, anchor, options], 'Playlist actions could not be opened.', action.lifetime.isCurrent);
    return true;
  };
  const playRow = (row, event, playOptions) => {
    event.preventDefault();
    const text = host.ownerDocument.getSelection?.();
    if (text && row.node.contains(text.anchorNode) && row.node.contains(text.focusNode)) text.removeAllRanges();
    invoke(current.onPlay, [row.rowKey, event, playOptions], 'This track could not be played.');
  };
  const click = event => {
    if (disposed || event.defaultPrevented || event.isComposing || event.button > 0) return;
    const section = event.target.closest?.('[data-playtable-section-action]');
    if (section && host.contains(section)) {
      if (!section.disabled && section.getAttribute('aria-disabled') !== 'true'
        && open(section, {target: 'section', sectionKey: section.getAttribute('data-playtable-section-action')})) event.preventDefault();
      return;
    }
    const row = rowFor(event);
    if (!row) {touchClick = null; lastTouch = null; return;}
    const now = time(event), proof = touchClick;
    const touch = !touchCancelled && unmodified(event) && (event.pointerType === 'touch' || event.sourceCapabilities?.firesTouchEvents === true
      || proof?.node === row.node && now >= proof.time && now - proof.time <= 750);
    touchClick = null;
    if (!touch) lastTouch = null;
    if (event.detail > 1 && !touch) return;
    // On macOS Ctrl-click is a context gesture. Defer to contextmenu so the
    // browser's click/contextmenu ordering cannot toggle a selected row twice.
    const mac = current.platform === 'mac' || current.platform == null
      && /Mac|iPhone|iPad/.test(host.ownerDocument.defaultView?.navigator?.platform || '');
    if (event.ctrlKey && mac) return;
    if (touch && lastTouch?.node === row.node && lastTouch.snapshot === owner.getSnapshot()
      && now >= lastTouch.time && now - lastTouch.time <= 320 && typeof current.onPlay === 'function') {
      lastTouch = null; playedTouch = {node: row.node, snapshot: owner.getSnapshot(), time: now};
      playRow(row, event, {restart: true}); return;
    }
    const selected = owner.select(row.rowKey, {toggle: event.ctrlKey || event.metaKey, range: event.shiftKey});
    lastTouch = touch && selected ? {node: row.node, snapshot: owner.getSnapshot(), time: now} : null;
    if (selected && !event.ctrlKey && !event.metaKey && !event.shiftKey)
      current.onInspect?.(row.rowKey, event);
  };
  const context = event => {
    touchPress = null; touchClick = null; lastTouch = null;
    const row = rowFor(event);
    if (!row) return;
    if (suppressContext?.node === row.node) {suppressContext = null; event.preventDefault(); return;}
    if (owner.context(row.rowKey) && open(row.node, {}, {context: true})) event.preventDefault();
  };
  const doubleClick = event => {
    if (event.button > 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const row = rowFor(event);
    if (!row || typeof current.onPlay !== 'function') return;
    const now = time(event);
    if (playedTouch?.node === row.node && playedTouch.snapshot === owner.getSnapshot()
      && now >= playedTouch.time && now - playedTouch.time <= 750) {
      playedTouch = null; event.preventDefault(); return;
    }
    playRow(row, event);
  };
  const keydown = event => {
    if (event.repeat || event.isComposing || event.altKey) return;
    touchPress = null; touchClick = null; lastTouch = null; playedTouch = null;
    suppressContext = null;
    const row = rowFor(event);
    if (!row) return;
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      if (owner.context(row.rowKey) && open(row.node, {}, {context: true})) {
        event.preventDefault(); suppressContext = {node: row.node};
      }
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      if (typeof current.onPlay !== 'function') return;
      event.preventDefault(); invoke(current.onPlay, [row.rowKey, event], 'This track could not be played.');
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (owner.select(row.rowKey, {toggle: event.ctrlKey || event.metaKey, range: event.shiftKey}) && !event.ctrlKey && !event.metaKey && !event.shiftKey)
        current.onInspect?.(row.rowKey, event);
    }
  };
  const pointerdown = event => {
    suppressContext = null; touchPress = null; touchClick = null; playedTouch = null; touchCancelled = false;
    if (event.pointerType !== 'touch' || event.isPrimary === false || !unmodified(event)) {lastTouch = null; return;}
    const row = rowFor(event);
    if (row) touchPress = {...row, pointerId: event.pointerId, x: event.clientX, y: event.clientY};
    else lastTouch = null;
  };
  const pointermove = event => {
    if (touchPress && (Math.abs(event.clientX - touchPress.x) > 10 || Math.abs(event.clientY - touchPress.y) > 10)) {
      touchPress = null; lastTouch = null; touchCancelled = true;
    }
  };
  const pointerup = event => {
    pointermove(event);
    const row = event.pointerType === 'touch' && rowFor(event);
    if (row && touchPress?.node === row.node && touchPress.pointerId === event.pointerId)
      touchClick = {node: row.node, time: time(event)};
    touchPress = null;
  };
  const pointercancel = () => {touchPress = null; touchClick = null; lastTouch = null; playedTouch = null; touchCancelled = true;};
  const handlers = {click, contextmenu: context, dblclick: doubleClick, keydown, pointerdown, pointermove, pointerup, pointercancel};
  for (const [type, callback] of Object.entries(handlers)) host.addEventListener(type, callback);
  paint();
  return {...owner, openSelection: (anchor, options) => open(anchor, {}, options),
    update(next) {
      if (disposed) return owner.getSnapshot();
      if (next?.sourceAdapter && next.sourceAdapter !== sourceAdapter) throw new TypeError('Remount selection for a replacement adapter.');
      if (next) current = {...current, ...next};
      const result = owner.update(); paint(); return result;
    },
    dispose() {if (disposed) return; disposed = true;
      for (const [type, callback] of Object.entries(handlers)) host.removeEventListener(type, callback);
      unsubscribe(); owner.dispose();
      for (const node of painted) if (host.contains(node)) node.removeAttribute('aria-selected');
      painted = [];
    },
  };
}
