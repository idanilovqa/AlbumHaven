import {prepareQueuePlaylistSource} from './queue-playlist-source.mjs';
import {queueSelectionIds} from './queue-selection.mjs';
import {mountPlaytableSelection} from '../playtables/native-selection.mjs';
import {mountButton} from './native-controls.mjs';
import {createTrackPreferences} from './track-preference-ui.mjs';
import {paintTrackLoveCell} from './track-preference.mjs';
import {playlistTrackMetricCells} from '../playlists/track-metrics.mjs';
import {mountTrackTablePresentation, mountTrackTableColumnsAction} from '../playtables/native-track-table-presentation.mjs';
const QUEUE_COLUMNS = Object.freeze([{key: 'number', label: '#', width: 36, autoMinWidth: 641}, {key: 'title', label: 'Track', identity: true, width: 100}, {key: 'album', label: 'Album', width: 112, autoMinWidth: 641}, {key: 'timing', label: 'Play when', width: 120, autoMinWidth: 641}, {key: 'love_tier', label: 'Love', required: true, width: 36}, {key: 'duration', label: 'Length', required: true, width: 54}, {key: 'actions', label: 'Actions', action: true, width: 72, autoMinWidth: 641}]);
const EMPTY = Object.freeze({enabled: true, entries: [], revision: 0});
const EMPTY_SELECTION = Object.freeze({selectedIds: Object.freeze([]), album: null, artist: null, status: 'empty'});
export function createExplicitQueue(runtime, onChange) {
  const api = runtime.explicitQueue?.(); let disposed = false, unsubscribe;
  const getSnapshot = () => ({api, value: api?.getSnapshot() || EMPTY});
  function dispose() {if (disposed) return; disposed = true; const release = unsubscribe; unsubscribe = null; release?.();}
  try {
    let subscribing = true, notified = false; const notify = () => {if (!disposed) onChange?.(getSnapshot());};
    const release = api?.subscribe(() => {if (subscribing) notified = true; else notify();}); subscribing = false;
    if (disposed) release?.(); else {unsubscribe = release; if (notified) notify();}
  }
  catch (error) {try {dispose();} catch {} throw error;}
  return {getSnapshot, dispose};
}
export function createQueueDetails(initial, onChange) {
  let props, adapter, detailRuntime, unsubscribe, disposed = false, generation = 0;
  const getSnapshot = () => ({adapter: adapter || null, value: adapter?.getSnapshot() || EMPTY_SELECTION, runtime: detailRuntime || props.runtime});
  function release() {
    const previous = adapter, unlisten = unsubscribe; adapter = unsubscribe = detailRuntime = null;
    let failure; try {unlisten?.();} catch (error) {failure = error;}
    try {previous?.dispose();} catch (error) {failure ??= error;} if (failure) throw failure;
  }
  function dispose() {if (disposed) return; disposed = true; generation++; release();}
  function update(next) {
    if (disposed) return;
    if (props && ['runtime', 'api', 'scopeKey', 'enabled'].every(key => Object.is(props[key], next[key]))) {props = next; return;}
    const owner = ++generation; const current = () => !disposed && generation === owner && props.enabled;
    try {
      release(); if (disposed || generation !== owner) return; props = next;
      if (props.enabled && props.api && typeof props.runtime.createQueueResourceSelection === 'function') {
        const nextAdapter = props.runtime.createQueueResourceSelection({queue: props.api, scopeKey: props.scopeKey, isCurrent: current});
        if (!current()) {nextAdapter?.dispose(); return;} adapter = nextAdapter;
        if (adapter) {
          detailRuntime = {...props.runtime, ...adapter};
          let subscribing = true, notified = false; const notify = () => {if (current()) onChange?.(getSnapshot());};
          const unlisten = adapter.subscribe(() => {if (subscribing) notified = true; else notify();}); subscribing = false;
          if (!current()) {unlisten?.(); return;} unsubscribe = unlisten;
          if (notified) {notify(); if (!current()) return;}
          const snapshot = props.api.getSnapshot(); if (!current()) return;
          const restored = queueSelectionIds(props.selectedIds || [], {entries: snapshot.entries.filter(row => row.sourceReadable === true)});
          if (restored.length) {Promise.resolve(adapter.select(restored)).catch(() => {}); if (!current()) return;}
        }
      }
      if (!disposed && generation === owner) onChange?.(getSnapshot());
    } catch (error) {try {dispose();} catch {} throw error;}
  }
  update(initial); return {getSnapshot, update, dispose};
}
export function mountQueueHeader(host, runtime, initial) {
  let props = initial, disposed = false, generation = 0, toggle, clear;
  host.classList.add('gallery-bar__actions'); const toggleHost = host.ownerDocument.createElement('span'), clearHost = host.ownerDocument.createElement('span'), error = host.ownerDocument.createElement('span'); error.setAttribute('role', 'alert'); error.hidden = true; host.append(toggleHost, clearHost, error);
  function dispose() {
    if (disposed) return; disposed = true; generation++;
    let failure; for (const cleanup of [() => toggle?.dispose(), () => clear?.dispose(), () => host.replaceChildren()]) {try {cleanup();} catch (error) {failure ??= error;}} if (failure) throw failure;
  }
  function showError(message) {if (!disposed) {error.textContent = message; error.hidden = !message;}}
  function safe(action) {if (disposed) return; const owner = generation; try {Promise.resolve(action()).catch(() => {if (!disposed && generation === owner) showError('Queue could not be changed.');});} catch {if (!disposed && generation === owner) showError('Queue could not be changed.');}}
  function update(next) {
    if (disposed) return; if (props.api !== next.api) {generation++; showError('');} props = next; const {api, value} = props;
    try {
      toggle.update({label: value.enabled ? 'Deactivate queue' : 'Activate queue', icon: value.enabled ? 'pause' : 'play', disabled: !api, onClick: () => safe(() => props.api?.setEnabled(!props.value.enabled))});
      if (disposed) return;
      clear.update({label: 'Clear queue', icon: 'delete', disabled: !api || !value.entries.length, onClick: () => safe(async () => {
        const pendingIds = props.value.entries.filter(entry => !entry.current).map(entry => entry.id), owner = generation, scope = runtime.snapshot?.().scopeKey;
        const current = () => !disposed && generation === owner && runtime.snapshot?.().scopeKey === scope;
        if (current() && pendingIds.length && await runtime.confirm?.('Clear the queued tracks?') && current()) props.api?.clear(pendingIds);
      })});
    } catch (error) {try {dispose();} catch {} throw error;}
  }
  try {toggle = mountButton(toggleHost, runtime, {label: 'Queue'}); clear = mountButton(clearHost, runtime, {label: 'Clear queue'}); update(initial);}
  catch (error) {try {dispose();} catch {} throw error;}
  return {element: host, update, dispose};
}
export function mountQueuePanel(host, runtime, initial) {
  let props, resourceKey, preferenceRuntime, commands = new Map(), sourceAdapter, cached, snapshot, selection, presentation, columns, love, request, playing, menu,
    disposed = false, generation = 0, drag, structure, syncing = false, rendering = false, pendingProps, updateRevision = 0;
  const node = (tag, className) => {const element = host.ownerDocument.createElement(tag); if (className) element.className = className; host.append(element); return element;};
  host.className = 'album-track-table album-track-table--collection';
  const actions = node('div'), columnHost = node('span'), error = node('p'), inactive = node('p'), table = node('div'); error.setAttribute('role', 'alert'); error.hidden = true; inactive.setAttribute('role', 'status'); inactive.textContent = 'Queue is inactive. Your queued tracks are kept.';
  const acquired = new Set(), retired = Symbol('retired queue');
  const check = () => {if (disposed) throw retired;};
  function acquire(owner) {if (disposed) {try {owner?.dispose();} finally {throw retired;}} acquired.add(owner); return owner;}
  function release(owner) {if (owner && acquired.delete(owner)) owner.dispose();}
  const current = owner => !disposed && (owner === undefined || generation === owner);
  const showError = message => {if (!disposed) {error.textContent = message; error.hidden = !message;}};
  const safe = action => {if (disposed) return; const owner = generation; try {Promise.resolve(action()).catch(() => {if (current(owner)) showError('This Queue action is unavailable.');});} catch {if (current(owner)) showError('This Queue action is unavailable.');}};
  function paint() {
    if (disposed || !love || !props) return;
    const byId = new Map([...table.querySelectorAll('[data-queue-row]')].map(element => [element.dataset.queueRow, element]));
    for (const row of props.value.entries) {const element = byId.get(row.id), handle = commands.get(row.id); if (element) element.draggable = !row.current; paintTrackLoveCell(element?.querySelector('[data-track-love-cell]'), preferenceRuntime, {...row, source_readable: row.sourceReadable === true}, love.get(handle), handle);}
  }
  function runPlay(id) {if (!props.api || disposed) return; const owner = generation, previous = playing; playing = null; previous?.abort(); if (!current(owner)) return; const abort = new AbortController(); playing = abort; safe(() => props.api.play(id, {signal: abort.signal, isCurrent: () => current(owner) && playing === abort}));}
  async function openPlaylist(packet, lifetime, anchor, options = {}) {
    const {api, scopeKey} = props, owner = generation;
    if (!current(owner) || !api?.playlistSelection || !lifetime.isCurrent()) return false;
    const prepared = await prepareQueuePlaylistSource({queue: api, sourceAdapter, packet, lifetime, scopeCurrent: () => current(owner) && runtime.snapshot?.().scopeKey === scopeKey});
    if (!prepared) {if (current(owner) && lifetime.isCurrent()) throw new Error('This Queue selection cannot currently be used for a Playlist. Refresh its source and try again.'); return false;}
    if (!current(owner) || !lifetime.isCurrent()) return false;
    return runtime.openPlaylistAction?.(packet, lifetime, prepared, anchor, options) ?? false;
  }
  function move(id, before) {if (disposed) return; const {api, value} = props, latest = api?.getSnapshot(); if (!latest || latest.revision !== value.revision || id === before) return;
    const ids = latest.entries.filter(row => !row.current).map(row => row.id), from = ids.indexOf(id), to = ids.indexOf(before); if (from < 0 || to < 0) return; ids.splice(from, 1); ids.splice(to, 0, id); safe(() => api.reorder(ids));}
  function click(event) {
    const button = event.target.closest('button'), {api, value} = props; if (!button || button.disabled || !api || !current()) return;
    if (button.hasAttribute('data-track-love')) {event.preventDefault(); event.stopPropagation(); const handle = commands.get(button.closest('[data-queue-row]')?.dataset.queueRow); if (handle && !(event.detail > 1)) love.cycle(handle); return;}
    const id = button.dataset.queueTiming || button.dataset.queuePlay || button.dataset.queueUp || button.dataset.queueDown || button.dataset.queueRemove, row = value.entries.find(row => row.id === id);
    if (!row || api.getSnapshot().revision !== value.revision) return;
    if (button.dataset.queueTiming) {const owner = generation; const previousMenu = menu; menu = null; previousMenu?.close(); if (!current(owner)) return; const nextMenu = runtime.openChoice(button, {formats: (api.timingOptions?.() || []).map(option => ({...option, value: option.value ?? option.id, disabled: option.enabled !== true})), selected: row.timing, label: 'Queue timing', menuWidth: 'content', updateTriggerLabel: false,
      onSelect: timing => {if (current(owner) && api.getSnapshot().entries.some(entry => entry.id === id && !entry.current)) safe(() => api.retime(id, timing));}}); if (current(owner)) menu = nextMenu; else nextMenu?.close({restoreFocus: false});}
    else if (button.dataset.queuePlay) runPlay(id); else if (button.dataset.queueRemove) safe(() => api.remove(id));
    else {const pending = value.entries.filter(row => !row.current); move(id, pending[pending.indexOf(row) + (button.dataset.queueUp ? -1 : 1)]?.id);}
  }
  const dragStart = event => {if (disposed) return; const id = event.target.closest('[data-queue-row]')?.dataset.queueRow; if (!id || props.value.entries.find(row => row.id === id)?.current) {event.preventDefault(); return;} drag = {id, revision: props.value.revision}; event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move';};
  const dragOver = event => {if (disposed) return; const id = event.target.closest('[data-queue-row]')?.dataset.queueRow; if (drag?.revision === props.value.revision && props.value.entries.some(row => row.id === id && !row.current)) event.preventDefault();};
  const drop = event => {if (disposed) return; event.preventDefault(); const held = drag; drag = null; if (held?.revision === props.value.revision) move(held.id, event.target.closest('[data-queue-row]')?.dataset.queueRow);};
  const dragEnd = () => {drag = null;};
  table.addEventListener('click', click); host.addEventListener('dragstart', dragStart); host.addEventListener('dragover', dragOver); host.addEventListener('drop', drop); host.addEventListener('dragend', dragEnd);
  function reset() {
    generation++; const refresh = request, play = playing, previousMenu = menu; request = playing = menu = null;
    let failure; const clean = callback => {try {callback();} catch (error) {failure ??= error;}};
    clean(() => refresh?.abort()); clean(() => play?.abort()); clean(() => previousMenu?.close({restoreFocus: false}));
    for (const owner of [...acquired].reverse()) clean(() => release(owner));
    selection = presentation = columns = love = null; commands = new Map(); cached = snapshot = structure = null; error.textContent = ''; error.hidden = true;
    if (failure) throw failure;
  }
  function dispose() {
    if (disposed) return; disposed = true; pendingProps = null; drag = null;
    let failure; const clean = callback => {try {callback();} catch (error) {failure ??= error;}};
    clean(reset); clean(() => table.removeEventListener('click', click)); clean(() => host.removeEventListener('dragstart', dragStart));
    clean(() => host.removeEventListener('dragover', dragOver)); clean(() => host.removeEventListener('drop', drop)); clean(() => host.removeEventListener('dragend', dragEnd)); clean(() => host.replaceChildren());
    if (failure) throw failure;
  }
  function update(next) {
    if (disposed) return; updateRevision++; if (rendering) {pendingProps = next; return;} rendering = true;
    try {
      const changed = !props || props.api !== next.api || props.scopeKey !== next.scopeKey; if (changed) reset(); check(); props = next; const {api, value, scopeKey} = props, owner = generation;
      if (changed) {
        resourceKey = {api, scopeKey}; preferenceRuntime = {...runtime, trackPreference: api?.trackPreference, setTrackLove: api?.setTrackLove, subscribeTrackPreferences: api?.subscribeTrackPreferences};
        sourceAdapter = {snapshot() {if (!api || !current(owner)) return null; const latest = api.getSnapshot(); if (!current(owner)) return null; if (latest !== cached) {cached = latest; snapshot = {scopeKey, instance: api, revision: latest.revision, rows: latest.entries.map(row => ({rowKey: row.id, readable: row.sourceReadable === true, selectable: row.sourceReadable === true}))};} return snapshot;}, subscribe(listener) {if (!current(owner) || !api) return () => {}; const release = api.subscribe(() => {if (current(owner)) listener();}) || (() => {}); if (!current(owner)) {release(); return () => {};} return release;}};
        request = new AbortController(); Promise.resolve(api?.refresh?.({signal: request.signal})).catch(() => {}); check();
      }
      commands = new Map(value.entries.map(row => [row.id, commands.get(row.id) || Object.freeze({id: row.id})]));
      const loveOptions = {runtime: preferenceRuntime, source: resourceKey, rows: [...commands.values()], context: {scopeKey}, isCurrent: () => current(owner), onError: showError};
      if (love) love.update(loveOptions); else love = acquire(createTrackPreferences(loveOptions, paint)); check();
      const rows = value.entries, pending = rows.filter(row => !row.current), options = api?.timingOptions?.() || [], label = timing => options.find(option => (option.value ?? option.id) === timing)?.label || timing, escape = runtime.escapeHtml; check();
      const nextStructure = JSON.stringify([options.map(option => [option.value ?? option.id, option.label]), rows.map(row => [row.id, row.current, row.sourceReadable, row.canPlay, row.title, row.artist, row.album, row.timing, row.duration_seconds])]);
      if (structure !== nextStructure) {
        const focused = table.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement : null, focusedId = focused?.closest('[data-queue-row]')?.dataset.queueRow;
        const attribute = ['data-track-love', 'data-queue-play', 'data-queue-timing', 'data-queue-up', 'data-queue-down', 'data-queue-remove'].find(name => focused?.hasAttribute(name));
        const html = runtime.tableHtml({id: 'home-explicit-queue', ariaLabel: 'Explicitly queued tracks', density: 'compact', columns: QUEUE_COLUMNS.map(column => column.identity ? 'minmax(0,1fr)' : `${column.width}px`).join(' '), columnsConfig: QUEUE_COLUMNS,
          rows: rows.map((row, index) => {const metrics = playlistTrackMetricCells(preferenceRuntime, {...row, source_readable: row.sourceReadable === true}, love.get(commands.get(row.id))); return {key: row.id, tabIndex: row.sourceReadable === true ? 0 : -1, ariaDisabled: row.sourceReadable !== true, dataAttributes: {'queue-row': row.id}, className: `album-track-table__row${row.current ? ' album-track-table__row--current' : ''}`, cells: {
            number: escape(index + 1), love_tier: metrics.love_tier, duration: metrics.duration, title: {content: '<div class="home-detail__release">' + (row.canPlay ? runtime.actionHtml({icon: 'play', ariaLabel: `Play ${row.title || 'track'}`, presentation: 'bare', attributes: {'data-queue-play': row.id}}) : '') + `<span class="album-track-table__title">${escape(row.title || 'Unknown track')}<span class="album-track-table__secondary">${escape([row.artist, label(row.timing)].filter(Boolean).join(' · '))}</span></span></div>`}, album: escape(row.album || '–'), timing: {content: runtime.buttonHtml({label: label(row.timing), size: 'small', disabled: row.current, attributes: {'data-queue-timing': row.id}})}, actions: {content: [runtime.actionHtml({icon: 'ascending', ariaLabel: 'Move up', presentation: 'bare', disabled: pending.indexOf(row) <= 0 || row.current, attributes: {'data-queue-up': row.id}}), runtime.actionHtml({icon: 'descending', ariaLabel: 'Move down', presentation: 'bare', disabled: pending.indexOf(row) === pending.length - 1 || row.current, attributes: {'data-queue-down': row.id}}), runtime.actionHtml({icon: 'delete', ariaLabel: 'Remove queued track', presentation: 'bare', disabled: row.current, attributes: {'data-queue-remove': row.id}})].join('')}}};}), emptyHtml: '<p>No tracks have been queued.</p>', overflow: 'local', frame: 'outline'});
        check(); table.innerHTML = html; structure = nextStructure;
        if (focused) {const row = [...table.querySelectorAll('[data-queue-row]')].find(element => element.dataset.queueRow === focusedId), target = attribute ? row?.querySelector(`[${attribute}]`) : row?.tabIndex === 0 ? row : null; if (target && !target.disabled) target.focus({preventScroll: true});}
      }
      check(); paint(); check(); inactive.hidden = value.enabled;
      const selectionOptions = {runtime, sourceAdapter, tableKey: 'home-explicit-queue', enabled: Boolean(api), actionsHost: actions, onPlaylistAction: openPlaylist, onError: showError,
        onContextAction: (packet, lifetime, anchor) => {if (!current(owner) || !api?.playlistSelection || !lifetime.isCurrent()) return false; const previousMenu = menu; menu = null; previousMenu?.close(); if (!current(owner) || !lifetime.isCurrent()) return false; const nextMenu = runtime.openChoice(anchor, {formats: [{value: 'create', label: 'Create new playlist'}, {value: 'add', label: 'Add to playlist'}], label: 'Selected track actions', actionMenu: true, menuWidth: 'content', updateTriggerLabel: false, onSelect: mode => {if (lifetime.isCurrent()) safe(() => openPlaylist(packet, lifetime, anchor, {mode}));}}); if (!current(owner) || !lifetime.isCurrent()) {nextMenu?.close({restoreFocus: false}); return false;} menu = nextMenu; return Boolean(menu);},
        initialSelectedRowKeys: props.selectedIds || [], isViewCurrent: () => current(owner), onSelectionChange: result => {if (current(owner) && !syncing && JSON.stringify(result.selectedRowKeys) !== JSON.stringify(props.selectedIds || [])) props.onSelect?.(result.selectedRowKeys);}, onInspect: () => {if (current(owner)) props.onSelect?.(selection?.getSnapshot().selectedRowKeys || [], {inspect: true});}, onPlay: id => {if (api.getSnapshot().entries.some(row => row.id === id && row.canPlay)) runPlay(id);}};
      if (selection) selection.update(selectionOptions); else selection = acquire(mountPlaytableSelection(host, selectionOptions)); check();
      const desired = new Set(props.selectedIds || []), selected = new Set(selection.getSnapshot().selectedRowKeys); syncing = true;
      try {for (const id of selected) if (!desired.has(id)) {selection.select(id, {toggle: true}); check();} for (const id of desired) if (!selected.has(id)) {selection.select(id, {toggle: true}); check();}} finally {syncing = false;}
      const presentationOptions = {runtime, resourceKey, source: value, columns: QUEUE_COLUMNS, identityReserve: 176, enabled: Boolean(api), isCurrent: () => current(owner)};
      if (presentation) presentation.update(presentationOptions); else {presentation = acquire(mountTrackTablePresentation(table, presentationOptions)); columns = acquire(mountTrackTableColumnsAction(columnHost, runtime, presentation));}
    } catch (error) {if (error !== retired) {try {dispose();} catch {} throw error;}} finally {rendering = false; if (pendingProps) {const next = pendingProps, revision = updateRevision; pendingProps = null; queueMicrotask(() => {if (!disposed && updateRevision === revision) update(next);});}}
  }
  update(initial); return {element: host, update, dispose};
}
