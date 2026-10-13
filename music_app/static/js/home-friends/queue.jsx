import {prepareQueuePlaylistSource} from './queue-playlist-source.mjs';
import {queueSelectionIds} from './queue-selection.mjs';
import {PlaytableSelectionActions, usePlaytableSelection} from '../playtables/selection.jsx';
import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button} from './components.jsx';
import {useTrackPreferences} from './track-preference.jsx';
import {paintTrackLoveCell} from './track-preference.mjs';
import {playlistTrackMetricCells} from '../playlists/track-metrics.mjs';
import {TrackTableColumnsAction, useTrackTablePresentation} from '../playtables/track-table-presentation.jsx';

const QUEUE_COLUMNS = Object.freeze([
  {key: 'number', label: '#', width: 36, autoMinWidth: 641},
  {key: 'title', label: 'Track', identity: true, width: 100},
  {key: 'album', label: 'Album', width: 112, autoMinWidth: 641},
  {key: 'timing', label: 'Play when', width: 120, autoMinWidth: 641},
  {key: 'love_tier', label: 'Love', required: true, width: 36},
  {key: 'duration', label: 'Length', required: true, width: 54},
  {key: 'actions', label: 'Actions', action: true, width: 72, autoMinWidth: 641},
]);

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
  const tableHost = useRef(null), renderedStructure = useRef(null), renderedRuntime = useRef(null), renderedResource = useRef(null), commandScope = useRef(null);
  const [error, setError] = useState('');
  const safe = action => {try {Promise.resolve(action()).catch(() => {if (mounted.current) setError('This Queue action is unavailable.');});} catch {if (mounted.current) setError('This Queue action is unavailable.');}};
  owner.current = {api, value, scopeKey};
  const resourceKey = useMemo(() => ({api, scopeKey}), [api, scopeKey]);
  // Command handles contain occurrence IDs only. Read data and permissions stay
  // in the native owner; a snapshot repaint must not cancel the same command.
  const commandRows = useMemo(() => {
    const previous = new Map((commandScope.current?.resourceKey === resourceKey ? commandScope.current.rows : []).map(handle => [handle.id, handle]));
    const rows = value.entries.map(row => previous.get(row.id) || Object.freeze({id: row.id}));
    commandScope.current = {resourceKey, rows}; return rows;
  }, [resourceKey, value.entries]);
  const preferenceRuntime = useMemo(() => ({...runtime, trackPreference: api?.trackPreference,
    setTrackLove: api?.setTrackLove, subscribeTrackPreferences: api?.subscribeTrackPreferences}), [runtime, api]);
  const current = () => owner.current?.api === api && owner.current?.scopeKey === scopeKey;
  const love = useTrackPreferences({runtime: preferenceRuntime, source: resourceKey, rows: commandRows, context: {scopeKey},
    isCurrent: current, onError: message => {if (mounted.current) setError(message);}});
  const commandsById = useMemo(() => new Map(commandRows.map(handle => [handle.id, handle])), [commandRows]);
  const commandRow = row => commandsById.get(row.id);
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
    safe(() => api.play(id, {signal: request.signal, isCurrent: () => mounted.current && current() && playing.current === request}));
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
    columns: QUEUE_COLUMNS.map(column => column.identity ? 'minmax(0,1fr)' : `${column.width}px`).join(' '),
    columnsConfig: QUEUE_COLUMNS,
    rows: rows.map((row, index) => {
      const display = {...row, source_readable: row.sourceReadable === true}, metrics = playlistTrackMetricCells(preferenceRuntime, display, love.get(commandRow(row)));
      return {key: row.id, tabIndex: row.sourceReadable === true ? 0 : -1, ariaDisabled: row.sourceReadable !== true, dataAttributes: {'queue-row': row.id},
      className: `album-track-table__row${row.current ? ' album-track-table__row--current' : ''}`,
      cells: {number: escape(index + 1), love_tier: metrics.love_tier, duration: metrics.duration,
        title: {content: `<div class="home-detail__release">` + (row.canPlay ? runtime.actionHtml({icon: 'play', ariaLabel: `Play ${row.title || 'track'}`, presentation: 'bare',
          attributes: {'data-queue-play': row.id}}) : '') + `<span class="album-track-table__title">${escape(row.title || 'Unknown track')}<span class="album-track-table__secondary">${escape([row.artist, label(row.timing)].filter(Boolean).join(' · '))}</span></span></div>`},
        album: escape(row.album || '–'), timing: {content: runtime.buttonHtml({label: label(row.timing), size: 'small', disabled: row.current,
          attributes: {'data-queue-timing': row.id}})}, actions: {content: [
          runtime.actionHtml({icon: 'ascending', ariaLabel: 'Move up', presentation: 'bare', disabled: pendingRows.indexOf(row) <= 0 || row.current, attributes: {'data-queue-up': row.id}}),
          runtime.actionHtml({icon: 'descending', ariaLabel: 'Move down', presentation: 'bare', disabled: pendingRows.indexOf(row) === pendingRows.length - 1 || row.current, attributes: {'data-queue-down': row.id}}),
          runtime.actionHtml({icon: 'delete', ariaLabel: 'Remove queued track', presentation: 'bare', disabled: row.current, attributes: {'data-queue-remove': row.id}}),
        ].join('')}}};}), emptyHtml: '<p>No tracks have been queued.</p>', overflow: 'local', frame: 'outline'});
  const structure = JSON.stringify([options.map(option => [option.value ?? option.id, option.label]),
    rows.map(row => [row.id, row.current, row.sourceReadable, row.canPlay, row.title, row.artist, row.album, row.timing, row.duration_seconds])]);
  useLayoutEffect(() => {
    const node = tableHost.current;
    if (!node) return;
    const sameResource = renderedResource.current === resourceKey;
    const document = node.ownerDocument, focused = sameResource && node.contains(document.activeElement) ? document.activeElement : null;
    const focusedId = focused?.closest('[data-queue-row]')?.dataset.queueRow;
    const attribute = ['data-track-love', 'data-queue-play', 'data-queue-timing', 'data-queue-up', 'data-queue-down', 'data-queue-remove'].find(name => focused?.hasAttribute(name));
    const paint = (pendingOnly = false) => {
      const elements = new Map([...node.querySelectorAll('[data-queue-row]')].map(element => [element.dataset.queueRow, element]));
      for (const row of rows) {
        const element = elements.get(row.id), handle = commandRow(row), state = love.get(handle);
        if (pendingOnly && !state.pending) continue;
        if (element) element.draggable = !row.current;
        paintTrackLoveCell(element?.querySelector('[data-track-love-cell]'), preferenceRuntime,
          {...row, source_readable: row.sourceReadable === true}, state, handle);
      }
    };
    // Record pending focus before replacing native markup, then repaint only
    // public cells. The stable command handle belongs to this exact occurrence.
    const replace = !sameResource || renderedStructure.current !== structure || renderedRuntime.current !== runtime;
    if (replace && sameResource) paint(true);
    if (replace) {node.innerHTML = html; renderedStructure.current = structure; renderedRuntime.current = runtime;}
    renderedResource.current = resourceKey;
    paint();
    selection.ownerRef.current?.update();
    if (focused && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) {
      const row = [...node.querySelectorAll('[data-queue-row]')].find(element => element.dataset.queueRow === focusedId);
      const target = attribute ? row?.querySelector(`[${attribute}]`) : row?.tabIndex === 0 ? row : null;
      if (target && !target.disabled) target.focus({preventScroll: true});
    }
  }, [html, structure, rows, love.version, preferenceRuntime, commandRows, resourceKey, runtime]);
  const presentation = useTrackTablePresentation(tableHost, {runtime, resourceKey, source: value, columns: QUEUE_COLUMNS,
    identityReserve: 176, enabled: Boolean(api), isCurrent: current});
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
    <PlaytableSelectionActions runtime={runtime} {...selection} available={Boolean(api?.playlistSelection && runtime.openPlaylistAction)}>
      <TrackTableColumnsAction runtime={runtime} {...presentation}/>
    </PlaytableSelectionActions>
    {error && <p role="alert">{error}</p>}
    {!value.enabled && <p role="status">Queue is inactive. Your queued tracks are kept.</p>}
    <div ref={tableHost} onClick={event => {
      const button = event.target.closest('button'); if (!button || button.disabled || !api || !current()) return;
      if (button.hasAttribute('data-track-love')) {
        event.preventDefault(); event.stopPropagation();
        const id = button.closest('[data-queue-row]')?.dataset.queueRow, row = commandsById.get(id);
        if (row && !(event.detail > 1)) love.cycle(row);
        return;
      }
      const id = button.dataset.queueTiming || button.dataset.queuePlay || button.dataset.queueUp || button.dataset.queueDown || button.dataset.queueRemove;
      const row = rows.find(row => row.id === id); if (!row || api.getSnapshot().revision !== value.revision) return;
      if (button.dataset.queueTiming) menu.current = runtime.openChoice(button, {formats: options.map(option => ({...option, value: option.value ?? option.id, disabled: option.enabled !== true})),
        selected: row.timing, label: 'Queue timing', menuWidth: 'content', updateTriggerLabel: false,
        onSelect: timing => {if (mounted.current && current() && api.getSnapshot().entries.some(entry => entry.id === id && !entry.current)) safe(() => api.retime(id, timing));}});
      else if (button.dataset.queuePlay) runPlay(id);
      else if (button.dataset.queueRemove) safe(() => api.remove(id));
      else move(id, pendingRows[pendingRows.indexOf(row) + (button.dataset.queueUp ? -1 : 1)]?.id);
    }}/>
  </div>;
}
