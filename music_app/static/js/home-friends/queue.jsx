import {prepareQueuePlaylistSource} from './queue-playlist-source.mjs';
import {queueSelectionIds} from './queue-selection.mjs';
import {PlaytableSelectionActions, usePlaytableSelection} from '../playtables/selection.jsx';
import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button, NativeHtml} from './components.jsx';

const EMPTY = Object.freeze({enabled: true, entries: [], revision: 0});
export function useExplicitQueue(runtime) {
  const api = runtime.explicitQueue?.();
  const [value, setValue] = useState(() => api?.getSnapshot() || EMPTY);
  useEffect(() => {
    const refresh = () => setValue(api?.getSnapshot() || EMPTY);
    refresh(); return api?.subscribe(refresh);
  }, [api]);
  return {api, value};
}
const EMPTY_SELECTION = Object.freeze({selectedIds: Object.freeze([]), album: null, artist: null, status: 'empty'});
export function useQueueDetails({runtime, api, scopeKey, enabled, selectedIds = []}) {
  const current = useRef(null), [held, setHeld] = useState(null);
  current.current = {runtime, api, scopeKey, enabled};
  useLayoutEffect(() => {
    if (!enabled || !api || typeof runtime.createQueueResourceSelection !== 'function') {setHeld(null); return undefined;}
    const owns = () => current.current.runtime === runtime && current.current.api === api && current.current.scopeKey === scopeKey && current.current.enabled;
    const adapter = runtime.createQueueResourceSelection({queue: api, scopeKey, isCurrent: owns});
    if (!adapter) {setHeld(null); return undefined;}
    const refresh = () => {if (owns()) setHeld({runtime, api, scopeKey, adapter, value: adapter.getSnapshot()});};
    const unsubscribe = adapter.subscribe(refresh); refresh();
    // History carries occurrence identities only. A remounted Queue must
    // admit those rows again through its current session/source authority.
    const restored = queueSelectionIds(selectedIds, {entries: api.getSnapshot().entries.filter(row => row.sourceReadable === true)});
    if (restored.length) Promise.resolve(adapter.select(restored)).catch(() => {});
    return () => {unsubscribe?.(); adapter.dispose();};
  }, [runtime, api, scopeKey, enabled]);
  const active = enabled && held?.runtime === runtime && held.api === api && held.scopeKey === scopeKey ? held : null;
  const detailRuntime = useMemo(() => active ? {...runtime, ...active.adapter} : runtime, [runtime, active?.adapter]);
  return {adapter: active?.adapter || null, value: active?.value || EMPTY_SELECTION, runtime: detailRuntime};
}
export function QueueHeader({runtime, api, value}) {
  const [error, setError] = useState(''), held = useRef(null);
  useEffect(() => {const token = {}; held.current = token; return () => {if (held.current === token) held.current = null;};}, [runtime, api]);
  const safe = action => {try {Promise.resolve(action()).catch(() => {if (held.current) setError('Queue could not be changed.');});} catch {if (held.current) setError('Queue could not be changed.');}};
  return <div className="gallery-bar__actions">
    <Button runtime={runtime} icon={value.enabled ? 'pause' : 'play'} disabled={!api}
      onClick={() => safe(() => api?.setEnabled(!value.enabled))}>{value.enabled ? 'Deactivate queue' : 'Activate queue'}</Button>
    <Button runtime={runtime} icon="delete" disabled={!api || !value.entries.length}
      onClick={() => safe(async () => {
        const pendingIds = value.entries.filter(entry => !entry.current).map(entry => entry.id);
        const token = held.current, scope = runtime.snapshot?.().scopeKey;
        const current = () => token && held.current === token && runtime.snapshot?.().scopeKey === scope;
        if (current() && pendingIds.length && await runtime.confirm?.('Clear the queued tracks?') && current()) api?.clear(pendingIds);
      })}>Clear queue</Button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
export function QueuePanel({runtime, api, value, scopeKey, selectedIds = [], onSelect}) {
  const syncingSelection = useRef(false);
  const drag = useRef(null), menu = useRef(null), owner = useRef(null), mounted = useRef(false), playing = useRef(null), host = useRef(null);
  const [error, setError] = useState('');
  const safe = action => {try {Promise.resolve(action()).catch(() => {if (mounted.current) setError('This Queue action is unavailable.');});} catch {if (mounted.current) setError('This Queue action is unavailable.');}};
  owner.current = {api, value, scopeKey};
  useEffect(() => {
    mounted.current = true;
    const request = new AbortController();
    Promise.resolve(api?.refresh?.({signal: request.signal})).catch(() => {});
    return () => {mounted.current = false; playing.current?.abort(); request.abort(); menu.current?.close(); owner.current = null;};
  }, [api]);
  const sourceAdapter = useMemo(() => {
    let cached = null, snapshot = null;
    return {snapshot() {
      if (!api || owner.current?.api !== api || owner.current?.scopeKey !== scopeKey) return null;
      const next = api.getSnapshot();
      if (next !== cached) {cached = next; snapshot = {scopeKey, instance: api, revision: next.revision,
        rows: next.entries.map(row => ({rowKey: row.id, readable: row.sourceReadable === true, selectable: row.sourceReadable === true}))};}
      return snapshot;
    }, subscribe: listener => api?.subscribe(listener) || (() => {})};
  }, [api, scopeKey]);
  const runPlay = id => {
    playing.current?.abort(); const request = new AbortController(); playing.current = request;
    safe(() => api.play(id, {signal: request.signal, isCurrent: () => mounted.current && owner.current?.api === api && playing.current === request}));
  };
  const openPlaylist = async (packet, lifetime, anchor, options = {}) => {
    if (!api?.playlistSelection || !lifetime.isCurrent()) return false;
    const prepared = await prepareQueuePlaylistSource({queue: api, sourceAdapter, packet, lifetime,
      scopeCurrent: () => runtime.snapshot?.().scopeKey === scopeKey});
    if (!prepared) {
      if (mounted.current && lifetime.isCurrent()) throw new Error('This Queue selection cannot currently be used for a Playlist. Refresh its source and try again.');
      return false;
    }
    if (!mounted.current || !lifetime.isCurrent()) return false;
    return runtime.openPlaylistAction?.(packet, lifetime, prepared, anchor, options) ?? false;
  };
  const selection = usePlaytableSelection(host, {sourceAdapter, tableKey: 'home-explicit-queue', enabled: Boolean(api),
    onPlaylistAction: openPlaylist, onError: message => {if (mounted.current) setError(message);},
    onContextAction: (packet, lifetime, anchor) => {
      if (!api?.playlistSelection || !lifetime.isCurrent()) return false;
      menu.current = runtime.openChoice(anchor, {formats: [{value: 'create', label: 'Create new playlist'}, {value: 'add', label: 'Add to playlist'}],
        label: 'Selected track actions', actionMenu: true, menuWidth: 'content', updateTriggerLabel: false,
        onSelect: mode => {if (lifetime.isCurrent()) safe(() => openPlaylist(packet, lifetime, anchor, {mode}));}});
      return Boolean(menu.current);
    },
    initialSelectedRowKeys: selectedIds, isViewCurrent: () => owner.current?.api === api && owner.current.scopeKey === scopeKey,
    onSelectionChange: snapshot => {if (!syncingSelection.current) onSelect?.(snapshot.selectedRowKeys);},
    onInspect: () => onSelect?.(selection.ownerRef.current?.getSnapshot().selectedRowKeys || [], {inspect: true}),
    onPlay: id => {if (api.getSnapshot().entries.some(row => row.id === id && row.canPlay)) runPlay(id);}});
  useLayoutEffect(() => {
    const native = selection.ownerRef.current;
    if (!native) return;
    const desired = new Set(selectedIds), current = new Set(native.getSnapshot().selectedRowKeys);
    syncingSelection.current = true;
    try {
      for (const id of current) if (!desired.has(id)) native.select(id, {toggle: true});
      for (const id of desired) if (!current.has(id)) native.select(id, {toggle: true});
    } finally {syncingSelection.current = false;}
  }, [selectedIds, sourceAdapter]);
  const escape = runtime.escapeHtml, rows = value.entries, pendingRows = rows.filter(row => !row.current);
  const move = (id, before) => {
    const current = api?.getSnapshot();
    if (!current || current.revision !== value.revision || id === before) return;
    const ids = current.entries.filter(row => !row.current).map(row => row.id), from = ids.indexOf(id), to = ids.indexOf(before);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1); ids.splice(to, 0, id); safe(() => api.reorder(ids));
  };
  const options = api?.timingOptions?.() || [];
  const label = timing => options.find(option => (option.value ?? option.id) === timing)?.label || timing;
  const html = runtime.tableHtml({id: 'home-explicit-queue', ariaLabel: 'Explicitly queued tracks', density: 'compact',
    columns: '36px minmax(0,2fr) minmax(0,1fr) minmax(120px,1fr) 100px', narrowColumns: '36px minmax(0,1fr) 100px',
    columnsConfig: [{key: 'number', label: '#'}, {key: 'title', label: 'Track'}, {key: 'album', label: 'Album', hideWhenNarrow: true},
      {key: 'timing', label: 'Play when', hideWhenNarrow: true}, {key: 'actions', label: 'Actions'}],
    rows: rows.map((row, index) => ({key: row.id, tabIndex: row.sourceReadable === true ? 0 : -1, ariaDisabled: row.sourceReadable !== true, dataAttributes: {'queue-row': row.id},
      className: `album-track-table__row${row.current ? ' album-track-table__row--current' : ''}`,
      cells: {number: escape(index + 1), title: {content: `<span class="album-track-table__title">${escape(row.title || 'Unknown track')}</span><span class="album-track-table__artist">${escape(row.artist || '')}</span><span>${escape(label(row.timing))}</span>`},
        album: escape(row.album || '–'), timing: {content: runtime.buttonHtml({label: label(row.timing), size: 'small', disabled: row.current,
          attributes: {'data-queue-timing': row.id}})}, actions: {content: [
          runtime.actionHtml({icon: 'play', ariaLabel: `Play ${row.title || 'track'}`, presentation: 'bare', disabled: !row.canPlay,
            hidden: row.ready === false, attributes: {'data-queue-play': row.id}}),
          runtime.actionHtml({icon: 'ascending', ariaLabel: 'Move up', presentation: 'bare', disabled: pendingRows.indexOf(row) <= 0 || row.current, attributes: {'data-queue-up': row.id}}),
          runtime.actionHtml({icon: 'descending', ariaLabel: 'Move down', presentation: 'bare', disabled: pendingRows.indexOf(row) === pendingRows.length - 1 || row.current, attributes: {'data-queue-down': row.id}}),
          runtime.actionHtml({icon: 'delete', ariaLabel: 'Remove queued track', presentation: 'bare', disabled: row.current, attributes: {'data-queue-remove': row.id}}),
        ].join('')}}})), emptyHtml: '<p>No tracks have been queued.</p>', overflow: 'local', frame: 'outline'});
  useEffect(() => {
    for (const node of host.current?.querySelectorAll('[data-queue-row]') || []) node.draggable = !rows.find(row => row.id === node.dataset.queueRow)?.current;
  }, [html]);
  return <div ref={host} className="album-track-table album-track-table--collection" onDragStart={event => {
    const id = event.target.closest('[data-queue-row]')?.dataset.queueRow;
    if (!id || rows.find(row => row.id === id)?.current) return event.preventDefault();
    drag.current = {id, revision: value.revision}; event.dataTransfer.setData('text/plain', id); event.dataTransfer.effectAllowed = 'move';
  }} onDragOver={event => {
    const id = event.target.closest('[data-queue-row]')?.dataset.queueRow;
    if (drag.current?.revision === value.revision && pendingRows.some(row => row.id === id)) event.preventDefault();
  }}
    onDrop={event => {event.preventDefault(); const held = drag.current; drag.current = null;
      if (held?.revision === value.revision) move(held.id, event.target.closest('[data-queue-row]')?.dataset.queueRow);}}
    onDragEnd={() => {drag.current = null;}}>
    {selection.snapshot.selectedCount > 0 && <PlaytableSelectionActions runtime={runtime} {...selection} available={Boolean(api?.playlistSelection && runtime.openPlaylistAction)}/>}
    {error && <p role="alert">{error}</p>}
    {!value.enabled && <p role="status">Queue is inactive. Your queued tracks are kept.</p>}
    <NativeHtml html={html} onClick={event => {
      const button = event.target.closest('button'); if (!button || button.disabled || !api) return;
      const id = button.dataset.queueTiming || button.dataset.queuePlay || button.dataset.queueUp || button.dataset.queueDown || button.dataset.queueRemove;
      const row = rows.find(row => row.id === id); if (!row || api.getSnapshot().revision !== value.revision) return;
      if (button.dataset.queueTiming) menu.current = runtime.openChoice(button, {formats: options.map(option => ({...option, value: option.value ?? option.id, disabled: option.enabled !== true})),
        selected: row.timing, label: 'Queue timing', menuWidth: 'content', updateTriggerLabel: false,
        onSelect: timing => {if (mounted.current && owner.current?.api === api && api.getSnapshot().entries.some(entry => entry.id === id)) safe(() => api.retime(id, timing));}});
      else if (button.dataset.queuePlay) runPlay(id);
      else if (button.dataset.queueRemove) safe(() => api.remove(id));
      else move(id, pendingRows[pendingRows.indexOf(row) + (button.dataset.queueUp ? -1 : 1)]?.id);
    }}/>
  </div>;
}
