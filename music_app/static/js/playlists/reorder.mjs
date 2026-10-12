const ROW = '[data-playlist-row-key]', HANDLE = '[data-playlists-drag]';
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const identity = value => typeof value === 'string' && value.length > 0;
const scopeMatches = (left, right) => left.scopeKey === right.scopeKey && left.collectionKey === right.collectionKey
  && left.source === right.source && left.selectedRowKey === right.selectedRowKey;

/** Native table gesture adapter. snapshot() supplies the current complete ordered
 * rows and {scopeKey, playlistId, source, selectedRowKey, itemsComplete, canEdit,
 * canReorder, unfiltered, defaultOrder, busy}. source is the immutable detail DTO.
 * collectionKey(snapshot) and itemKey(row) optionally select local presentation
 * identities for unsaved collections. Defaults preserve persisted Playlist IDs.
 * onReorder(itemIds) is synchronous: only an exact true accepts the draft command.
 * Call update() after replacing table markup. No transport or persistence lives here. */
export function mountPlaylistReorder(host, {snapshot, onReorder, onAnnounce = () => {},
  collectionKey = value => value.playlistId, itemKey = row => row.playlist_item_id}) {
  const doc = host.ownerDocument, win = doc.defaultView;
  let drag = null, frame = 0, disposed = false, blockedUntil = 0, pendingFocus = null;
  const nodes = () => [...host.querySelectorAll(ROW)];
  const read = () => {
    const value = snapshot();
    const collection = value && collectionKey(value);
    if (disposed || !host.isConnected || !value || !identity(value.scopeKey) || !identity(collection)
      || !value.source || value.itemsComplete !== true || value.canEdit !== true || value.canReorder !== true
      || value.unfiltered !== true || value.defaultOrder !== true || value.busy !== false || !Array.isArray(value.rows)) return null;
    const rows = Array.from(value.rows);
    if (rows.length < 2 || rows.some(row => !identity(row?.row_key))) return null;
    const keys = rows.map(row => row.row_key), ids = rows.map(row => itemKey(row));
    if (ids.some(id => !identity(id)) || new Set(keys).size !== keys.length || new Set(ids).size !== ids.length) return null;
    return {...value, collectionKey: collection, keys, ids};
  };
  const currentDom = state => {
    const current = nodes();
    return current.length === state.keys.length && current.every((node, index) => node.dataset.playlistRowKey === state.keys[index]) ? current : null;
  };
  const ownsDom = state => {
    const current = nodes();
    return current.length === state.expected.length && current.every((node, index) => node === state.expected[index])
      && current.every(node => node.parentElement === state.parent && state.identities.get(node) === node.dataset.playlistRowKey);
  };
  const valid = state => {
    const value = read();
    return value && scopeMatches(value, state.before) && same(value.keys, state.before.keys) && same(value.ids, state.before.ids)
      && state.row.contains(state.handle) && !state.handle.disabled && state.handle.getAttribute('aria-disabled') !== 'true' && ownsDom(state);
  };
  const handleFor = (event, current) => {
    const handle = event.target.closest?.(HANDLE), row = handle?.closest(ROW);
    return handle && host.contains(handle) && !handle.disabled && handle.getAttribute('aria-disabled') !== 'true'
      && current.includes(row) ? {handle, row} : null;
  };
  const focusCurrent = () => {
    if (!pendingFocus) return;
    const value = read(), pending = pendingFocus;
    if (!value || !scopeMatches(value, pending.before)
      || !same(value.ids, pending.ids) && !same(value.ids, pending.before.ids)) {pendingFocus = null; return;}
    if (!same(value.ids, pending.ids)) return;
    if (!currentDom(value)) return;
    pendingFocus = null;
    const active = doc.activeElement;
    if (active && active !== pending.handle && active !== doc.body && active.isConnected) return;
    const handle = nodes().find(node => node.dataset.playlistRowKey === pending.key)?.querySelector(HANDLE);
    if (handle && !handle.disabled && handle.getAttribute('aria-disabled') !== 'true') {
      handle.focus({preventScroll: true}); handle.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
    }
  };
  const commit = (before, key, ids, handle) => {
    if (same(ids, before.ids)) return;
    if (onReorder([...ids]) === true && !disposed) {
      const current = read();
      if (!current || !scopeMatches(current, before) || !same(current.ids, ids) && !same(current.ids, before.ids)) return;
      pendingFocus = {before, key, ids, handle}; focusCurrent();
      onAnnounce(`Moved to position ${ids.indexOf(before.ids[before.keys.indexOf(key)]) + 1} of ${ids.length}.`);
    }
  };
  const stop = ({cancel = true, focus = false, announce = false} = {}) => {
    const old = drag;
    if (!old) return;
    const owned = valid(old), restore = ownsDom(old);
    drag = null; win.cancelAnimationFrame(frame); frame = 0;
    old.observer?.disconnect(); old.ghost?.remove();
    old.row.classList.remove('is-dragging'); host.classList.remove('is-reordering');
    old.handle.setAttribute('aria-grabbed', 'false');
    doc.removeEventListener('pointermove', pointerMove, true); doc.removeEventListener('pointerup', pointerUp, true);
    doc.removeEventListener('pointercancel', pointerCancel, true); doc.removeEventListener('keydown', escape, true);
    doc.removeEventListener('visibilitychange', hidden); doc.removeEventListener('scroll', schedule, true);
    win.removeEventListener('blur', interrupted); win.removeEventListener('resize', interrupted); win.removeEventListener('pagehide', interrupted);
    try {host.releasePointerCapture?.(old.pointerId);} catch { /* Capture may already have been lost. */ }
    if (old.active) blockedUntil = Date.now() + 500;
    if (cancel && restore && old.active) for (const node of old.original) old.parent.appendChild(node);
    if (focus && owned && old.handle.isConnected) old.handle.focus({preventScroll: true});
    if (cancel && announce && old.active) onAnnounce('Move cancelled.');
    return {old, owned};
  };
  const scrollOwner = () => {
    for (let node = host; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(win.getComputedStyle(node).overflowY)) return node;
    }
    return doc.scrollingElement;
  };
  const viewport = scroller => scroller === doc.scrollingElement
    ? {top: 0, bottom: win.innerHeight, height: win.innerHeight, left: 0, right: win.innerWidth}
    : scroller.getBoundingClientRect();
  const paint = (time, final = false) => {
    frame = 0;
    const state = drag;
    if (!state) return;
    if (!valid(state) || scrollOwner() !== state.scroller) {stop(); return;}
    if (!state.active && Math.hypot(state.x - state.startX, state.y - state.startY) < 6) return;
    if (!state.active) {
      state.active = true;
      state.rects = state.original.map(node => node.getBoundingClientRect());
      state.scrollTop = state.scroller.scrollTop; state.viewportTop = viewport(state.scroller).top;
      const box = state.row.getBoundingClientRect();
      state.offsetX = state.startX - box.left; state.offsetY = state.startY - box.top;
      const ghost = state.row.cloneNode(true);
      for (const node of [ghost, ...ghost.querySelectorAll('[id]')]) node.removeAttribute('id');
      ghost.removeAttribute('data-playlist-row-key'); ghost.removeAttribute('data-cdt-row-key');
      ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
      for (const node of ghost.querySelectorAll('button,a,input,select,textarea,[tabindex]')) node.tabIndex = -1;
      ghost.classList.add('playlists__reorder-ghost');
      Object.assign(ghost.style, {width: `${box.width}px`, height: `${box.height}px`, left: '0px', top: '0px'});
      state.parent.appendChild(ghost); state.ghost = ghost;
      state.row.classList.add('is-dragging'); host.classList.add('is-reordering'); state.handle.setAttribute('aria-grabbed', 'true');
    }
    const box = viewport(state.scroller);
    const y = state.y + state.scroller.scrollTop - state.scrollTop + state.viewportTop - box.top;
    let target = state.expected.indexOf(state.row), distance = Math.abs(y - (state.rects[target].top + state.rects[target].height / 2));
    state.rects.forEach((box, index) => {const next = Math.abs(y - (box.top + box.height / 2)); if (next + 3 < distance) {target = index; distance = next;}});
    const from = state.expected.indexOf(state.row);
    if (target !== from) {
      state.expected.splice(from, 1); state.expected.splice(target, 0, state.row);
      state.parent.insertBefore(state.row, state.expected[target + 1] || state.ghost);
    }
    state.ghost.style.transform = `translate3d(${state.x - state.offsetX}px,${state.y - state.offsetY}px,0)`;
    if (final) return;
    const edge = Math.min(45, box.height / 4);
    const speed = state.x < box.left || state.x > box.right ? 0 : state.y < box.top + edge
      ? -Math.min(720, Math.max(0, (box.top + edge - state.y) * 16))
      : state.y > box.bottom - edge ? Math.min(720, Math.max(0, (state.y - box.bottom + edge) * 16)) : 0;
    const elapsed = state.time === null ? 16 : Math.min(32, Math.max(0, time - state.time)); state.time = time;
    const nextScroll = Math.max(0, Math.min(state.scroller.scrollHeight - state.scroller.clientHeight, state.scroller.scrollTop + speed * elapsed / 1000));
    if (nextScroll !== state.scroller.scrollTop) {state.scroller.scrollTop = nextScroll; schedule();}
  };
  function schedule() {if (drag && !frame) frame = win.requestAnimationFrame(time => paint(time));}
  function pointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.buttons === 0) {stop({focus: true, announce: true}); return;}
    drag.x = event.clientX; drag.y = event.clientY; event.preventDefault(); schedule();
  }
  function pointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    win.cancelAnimationFrame(frame); frame = 0; paint(0, true);
    if (!drag) return;
    const stopped = stop({cancel: false});
    if (!stopped.old.active) return;
    event.preventDefault(); event.stopPropagation();
    if (stopped.owned) {
      const {old} = stopped;
      const ids = old.expected.map(node => old.before.ids[old.before.keys.indexOf(node.dataset.playlistRowKey)]);
      // Restore the native presentation before asking the controller to render
      // an accepted order; a rejected command leaves no preview behind.
      for (const node of old.original) old.parent.appendChild(node);
      commit(old.before, old.row.dataset.playlistRowKey, ids, old.handle);
    }
  }
  function pointerCancel(event) {if (drag && (event.pointerId === undefined || event.pointerId === drag.pointerId)) stop({focus: true, announce: true});}
  function interrupted() {stop();}
  function hidden() {if (doc.hidden) stop();}
  function escape(event) {
    if (drag && event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); stop({focus: true, announce: true});}
  }
  const down = event => {
    blockedUntil = 0; pendingFocus = null;
    if (disposed || drag || event.button !== 0 || event.isPrimary === false) return;
    const before = read(), current = before && currentDom(before), target = current && handleFor(event, current);
    if (!target || current.some(node => node.parentElement !== target.row.parentElement)) return;
    const scroller = scrollOwner(); if (!scroller) return;
    event.preventDefault(); target.handle.focus({preventScroll: true});
    drag = {...target, before, scroller, parent: target.row.parentElement, original: current, expected: [...current],
      identities: new Map(current.map(node => [node, node.dataset.playlistRowKey])), pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, time: null};
    doc.addEventListener('pointermove', pointerMove, {capture: true, passive: false}); doc.addEventListener('pointerup', pointerUp, true);
    doc.addEventListener('pointercancel', pointerCancel, true); doc.addEventListener('keydown', escape, true);
    doc.addEventListener('visibilitychange', hidden); doc.addEventListener('scroll', schedule, true);
    win.addEventListener('blur', interrupted); win.addEventListener('resize', interrupted); win.addEventListener('pagehide', interrupted);
    if (win.MutationObserver) {
      drag.observer = new win.MutationObserver(records => {
        const relevant = records.some(record => host.contains(record.target)
          || [...(record.removedNodes || [])].some(node => node === host || node.contains?.(host)));
        if (relevant && drag && !valid(drag)) stop();
      });
      drag.observer.observe(doc.documentElement, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-playlist-row-key']});
    }
    try {host.setPointerCapture?.(event.pointerId);} catch { /* Document listeners retain bounded pointer ownership. */ }
  };
  const key = event => {
    if (disposed || drag) return;
    blockedUntil = 0; pendingFocus = null;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const before = read(), current = before && currentDom(before), target = current && handleFor(event, current);
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    const from = current.indexOf(target.row), to = event.key === 'Home' ? 0 : event.key === 'End' ? current.length - 1
      : Math.max(0, Math.min(current.length - 1, from + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1)));
    const ids = [...before.ids]; ids.splice(to, 0, ids.splice(from, 1)[0]);
    commit(before, target.row.dataset.playlistRowKey, ids, target.handle);
  };
  const click = event => {if (drag?.active || Date.now() < blockedUntil) {event.preventDefault(); event.stopImmediatePropagation();}};
  const nativeDrag = event => {if (event.target.closest?.(HANDLE)) event.preventDefault();};
  host.addEventListener('pointerdown', down); host.addEventListener('keydown', key); host.addEventListener('lostpointercapture', pointerCancel);
  host.addEventListener('click', click, true); host.addEventListener('dblclick', click, true); host.addEventListener('dragstart', nativeDrag);
  return {
    update() {if (drag && !valid(drag)) stop(); if (!disposed) focusCurrent();},
    dispose() {
      if (disposed) return;
      stop(); disposed = true; pendingFocus = null;
      host.removeEventListener('pointerdown', down); host.removeEventListener('keydown', key); host.removeEventListener('lostpointercapture', pointerCancel);
      host.removeEventListener('click', click, true); host.removeEventListener('dblclick', click, true); host.removeEventListener('dragstart', nativeDrag);
    },
  };
}
