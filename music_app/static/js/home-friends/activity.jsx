import {trackLoveHtml} from './track-preference.mjs';
import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button, NativeHtml} from './components.jsx';
import {NativeChoice} from './native-choice.jsx';
import {metric, safeServerArtworkUrl} from './model.mjs';
import {ResourceDetail} from './resource-detail.jsx';
import {ArtistSelectionRows} from './artist-selection.jsx';
import {detailSelection} from './detail-projection.mjs';
import {cycleTableSort, sortTableRows} from './table-order.mjs';
import {useTrackPreferences} from './track-preference.jsx';
import {activityTrackRow, readableActivityTrack, playableActivityTrack, paintActivityTracks} from './activity-tracks.jsx';
import {PlaytableSelectionActions, usePlaytableSelection, usePlaytableSource} from '../playtables/selection.jsx';

const EMPTY_ROWS = Object.freeze([]);
const readableResource = row => row?.source_readable !== false
  && !(Object.hasOwn(row?.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read !== true);
const resourceTarget = (row, kind) => {
  const target = detailSelection(row?.[`${kind}_target`]);
  return target?.kind === kind ? target : row?.kind === kind
    ? detailSelection({kind, ref: row.detail_ref, allowed_actions: row.allowed_actions}) : null;
};

export function activityTimestamp(value, zone) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '–';
  try {return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short', ...(zone ? {timeZone: zone} : {})}).format(new Date(value));}
  catch {return value;}
}
export function projectActivityRows(rows, order = 'server', ascending = false) {
  return sortTableRows(rows, {key: order, direction: order === 'server' ? 'default' : ascending ? 'asc' : 'desc'}, {
    listen_count: {type: 'number', getValue: row => row.listen_count},
    duration_seconds: {type: 'number', getValue: row => row.duration_seconds},
    last_listened_at: {type: 'number', getValue: row => Number.isFinite(Date.parse(row.last_listened_at)) ? Date.parse(row.last_listened_at) : null},
    title: {type: 'text', getValue: row => row.title},
  });
}
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '–';
export function ActivityPanel({runtime, value, kind = 'tracks', view = 'rows', scopeKey, account_ref = null, period = 'week', readDetail,
  selectedResourceId, onResourceSelect, onTracksSelect, selectedTrackIds, listenedAlbumsRef, nowPlaying}) {
  const [order, setOrder] = useState('server'), [ascending, setAscending] = useState(false), [localSelectedId, setSelectedId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const root = useRef(null), trackHost = useRef(null), returnFocus = useRef(null), sortFocus = useRef(null), latest = useRef(null), resourceSelection = useRef(null);
  const rows = value?.status === 'ready' ? value.data?.rows || EMPTY_ROWS : EMPTY_ROWS;
  const tracks = ['tracks', 'listens'].includes(kind);
  const context = useMemo(() => ({scopeKey, account_ref, kind, period}), [scopeKey, account_ref, kind, period]);
  const trackControlled = tracks && typeof onTracksSelect === 'function';
  const controlled = !tracks && selectedResourceId !== undefined, targetKind = kind === 'artists' ? 'artist' : 'album';
  const candidates = rows.filter(row => row.id === (controlled ? selectedResourceId : localSelectedId));
  const candidate = !trackControlled && candidates.length === 1 && readableResource(candidates[0]) ? candidates[0] : null;
  // Retiring the parent's stale id is synchronous. Keeping its tombstone until
  // a new selection prevents permission restoration from reopening the pane.
  if (!controlled) resourceSelection.current = null;
  else {
    if (!resourceSelection.current || resourceSelection.current.id !== selectedResourceId) {
      resourceSelection.current = {id: selectedResourceId, runtime, value, context, retired: false, notified: false};
    }
    const held = resourceSelection.current;
    if (selectedResourceId != null && (held.runtime !== runtime || held.value !== value || held.context !== context
      || !candidate || resourceTarget(candidate, targetKind)?.allowed_actions.can_view_details !== true)) held.retired = true;
  }
  const selected = controlled && resourceSelection.current.retired ? null : candidate;
  const selectedId = selected?.id ?? null;
  latest.current = {runtime, value, context, rows, order, ascending, onResourceSelect};
  const current = row => latest.current?.runtime === runtime && latest.current?.value === value && latest.current?.context === context
    && latest.current?.order === order && latest.current?.ascending === ascending && root.current?.isConnected
    && value?.status === 'ready' && (!row || rows.includes(row));
  const love = useTrackPreferences({runtime, source: value, rows: tracks ? rows : EMPTY_ROWS, context, isCurrent: () => current(),
    onError: message => {if (current()) setActionError({value, context, message});}});
  const sorted = useMemo(() => projectActivityRows(rows, order, ascending), [rows, order, ascending]);
  const positions = useMemo(() => new Map(rows.map((row, index) => [row, index])), [rows]);
  const escape = runtime.escapeHtml;
  const metricSort = {key: order === 'listen_count' ? 'listens' : order === 'duration_seconds' ? 'duration' : null,
    direction: order === 'server' ? 'default' : ascending ? 'asc' : 'desc'};
  const zone = runtime.preferredTimeZone?.();
  useLayoutEffect(() => {
    latest.current = {runtime, value, context, rows, order, ascending, onResourceSelect};
    return () => {latest.current = null;};
  }, [runtime, value, context, rows, order, ascending, onResourceSelect]);
  useLayoutEffect(() => {
    const held = resourceSelection.current;
    if (controlled && held.retired && !held.notified) {
      held.notified = true;
      onResourceSelect?.(null, targetKind);
    }
    if (!controlled && localSelectedId && !selected) setSelectedId(null);
    if (!selected && returnFocus.current) {
      const button = [...root.current.querySelectorAll('[data-home-activity-select],[data-home-artist-select]')]
        .find(node => (node.dataset.homeActivitySelect || node.dataset.homeArtistSelect) === returnFocus.current && !node.disabled);
      returnFocus.current = null; button?.focus({preventScroll: true});
    }
  }, [controlled, selected, localSelectedId, selectedResourceId, targetKind, onResourceSelect]);
  useLayoutEffect(() => {
    const pending = sortFocus.current;
    if (!pending) return;
    sortFocus.current = null;
    if (pending.context !== context || pending.value !== value) return;
    const document = root.current.ownerDocument, active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    [...root.current.querySelectorAll('[data-cdt-sort]')].find(button => button.dataset.cdtSort === pending.key && !button.disabled)?.focus({preventScroll: true});
  }, [order, ascending, context, value]);
  const close = () => {returnFocus.current = selectedId; setSelectedId(null);};
  const selectResource = (row, resourceKind = targetKind) => {
    if (!row || !current(row) || !readableResource(row) || latest.current.onResourceSelect !== onResourceSelect
      || !tracks && row.kind !== targetKind) return;
    if (tracks && resourceTarget(row, resourceKind)?.allowed_actions.can_view_details !== true) return;
    if (controlled) resourceSelection.current = {id: row.id, runtime, value, context, retired: false, notified: false};
    else if (!tracks) setSelectedId(row.id);
    onResourceSelect?.(row, resourceKind);
  };
  const changeOrder = next => {latest.current = {...latest.current, order: next}; setOrder(next);};
  const rowFor = event => {
    if (!current() || event.defaultPrevented || !root.current.contains(event.target)) return null;
    const id = event.target.closest('[data-home-activity-row]')?.dataset.homeActivityRow;
    const matches = rows.filter(row => row.id === id);
    return matches.length === 1 && readableActivityTrack(matches[0]) ? matches[0] : null;
  };
  const intent = runtime.trackIntent, canIntent = runtime.canTrackIntent;
  const play = row => {
    const ownsIntent = () => current(row) && runtime.trackIntent === intent && runtime.canTrackIntent === canIntent;
    const failed = error => {if (ownsIntent() && error?.name !== 'AbortError') setActionError({value, context, message: 'This track could not be played.'});};
    try {
      if (!ownsIntent() || !playableActivityTrack(runtime, row, context) || !ownsIntent()) return;
      setActionError(null);
      // Capture native player ownership during this interaction. Deferring the
      // call would let an older click replace a newer native selection.
      Promise.resolve(intent.call(runtime, 'play', row, context)).catch(failed);
    } catch (error) {failed(error);}
  };
  const source = usePlaytableSource({runtime, sourceRows: rows, rows: sorted, context, instance: value, revision: sorted, enabled: tracks,
    isCurrent: () => latest.current?.runtime === runtime && latest.current?.value === value
      && latest.current?.context === context && root.current?.isConnected && value?.status === 'ready',
    rowFacts: row => ({rowKey: row.id, readable: readableResource(row) && readableActivityTrack(row),
      selectable: readableResource(row) && readableActivityTrack(row)})});
  const selectedRow = rowKey => {
    const found = rows.filter(row => row.id === rowKey);
    return found.length === 1 && readableActivityTrack(found[0]) && current(found[0]) ? found[0] : null;
  };
  const selection = usePlaytableSelection(trackHost, {sourceAdapter: source.sourceAdapter, tableKey: `home-activity-${kind}`, enabled: tracks,
    isViewCurrent: () => current(),
    initialSelectedRowKeys: trackControlled ? selectedTrackIds : undefined,
    onSelectionChange: snapshot => {if (trackControlled && current()) onTracksSelect(snapshot.selectedRowKeys);},
    onInspect: rowKey => {const row = selectedRow(rowKey); if (!row) return;
      if (trackControlled) onTracksSelect(selection.ownerRef.current?.getSnapshot().selectedRowKeys || [row.id], {inspect: true});
      else setSelectedId(row.id);},
    onPlay: rowKey => {const row = selectedRow(rowKey); if (row) play(row);},
    onContextAction: typeof runtime.openPlaytableContext === 'function' ? (packet, lifetime, anchor) => runtime.openPlaytableContext(packet, lifetime, source.sourceAdapter, anchor) : undefined,
    onPlaylistAction: source.actionsAvailable ? (packet, lifetime, anchor, options) => runtime.openPlaylistAction(packet, lifetime, source.sourceAdapter, anchor, options) : undefined,
    onError: message => {if (current()) setActionError({value, context, message});}});
  const select = event => {
    if (!current() || event.defaultPrevented || !root.current.contains(event.target)) return;
    const heading = event.target.closest('[data-cdt-sort]');
    if (heading) {
      if (heading.disabled || !['listens', 'duration'].includes(heading.dataset.cdtSort)) return;
      event.preventDefault(); event.stopPropagation();
      sortFocus.current = {key: heading.dataset.cdtSort, context, value};
      const next = cycleTableSort(metricSort, heading.dataset.cdtSort);
      changeOrder(next.direction === 'default' ? 'server' : next.key === 'listens' ? 'listen_count' : 'duration_seconds');
      latest.current = {...latest.current, ascending: next.direction === 'asc'};
      setAscending(next.direction === 'asc'); return;
    }
    if (tracks) {
      const row = rowFor(event);
      if (!row) return;
      const action = event.target.closest('[data-home-activity-play],[data-track-love]');
      if (action) {
        event.preventDefault(); event.stopPropagation();
        if (!action.disabled && !(event.detail > 1)) {
          if (action.hasAttribute('data-track-love')) {setActionError(null); love.cycle(row);} else play(row);
        }
        return;
      }
      const selectButton = event.target.closest('[data-home-activity-select]');
      if (selectButton && !selectButton.disabled) {
        if (trackControlled) selection.ownerRef.current?.select(row.id); else setSelectedId(row.id);
      }
      return;
    }
    const button = event.target.closest('[data-home-activity-select]');
    if (button && !button.disabled) {
      const matches = rows.filter(row => row.id === button.dataset.homeActivitySelect);
      if (matches.length === 1) selectResource(matches[0]);
    }
  };
  const columns = [...(tracks ? [{key: 'number', label: '#'}] : []), {key: 'title', label: kind === 'artists' ? 'Artist' : kind === 'albums' ? 'Album' : 'Track'},
    ...(kind === 'artists' ? [] : [{key: 'artist', label: 'Artist', hideWhenNarrow: tracks}]),
    ...(['tracks', 'listens'].includes(kind) ? [{key: 'album', label: 'Album', hideWhenNarrow: true}] : []),
    ...(kind === 'albums' ? [{key: 'favorite', label: 'Favorite'}] : []),
    ...(tracks ? [{key: 'availability', label: 'Availability', hideWhenNarrow: true}, {key: 'love', label: 'Love'}] : []),
    {key: 'listens', label: 'Listens', sortable: true}, ...(kind === 'artists' ? [] : [{key: 'rating', label: 'Rating'}]),
    ...(['tracks', 'listens'].includes(kind) ? [{key: 'duration', label: 'Length', sortable: true}] : []),
    {key: 'last', label: kind === 'listens' ? 'Listened at' : 'Last listened', hideWhenNarrow: tracks}];
  const width = column => column.key === 'number' ? '36px' : tracks && column.key === 'title' ? 'minmax(0,1.3fr)'
    : ['title', 'artist', 'album'].includes(column.key) ? 'minmax(0,1fr)' : column.key === 'last' ? 'minmax(96px,1fr)' : 'minmax(52px,auto)';
  // Love and current/selected state are painted into persistent native cells.
  // Neither selection nor player notifications may replace a row's click target.
  const table = useMemo(() => kind === 'artists' ? '' : runtime.tableHtml({id: `home-activity-${kind}`, ariaLabel: 'Recent listening', density: 'compact', columns: columns.map(width).join(' '),
    narrowColumns: columns.filter(column => !column.hideWhenNarrow).map(width).join(' '), columnsConfig: columns, sort: metricSort,
    rows: [...(tracks && nowPlaying ? [{key: `now-playing:${nowPlaying.occurrence_ref}`,
      className: 'album-track-table__row album-track-table__row--current album-track-table__row--playing',
      dataAttributes: {'now-playing': 'true'}, cells: {number: '▶',
        title: {content: `<span class="album-track-table__title">${escape(nowPlaying.row.title || 'Unknown track')}</span><span role="status">Now playing</span>`},
        artist: escape(nowPlaying.row.artist || '–'), album: escape(nowPlaying.row.album_title || '–'),
        availability: '', love: {content: trackLoveHtml(runtime, nowPlaying.row)}, rating: escape(metric(nowPlaying.row.rating)),
        listens: '–', duration: escape(duration(nowPlaying.row.duration_seconds)), last: 'Live'}}] : []), ...sorted.map(row => {
      const readable = readableResource(row) && (!tracks || readableActivityTrack(row));
      const title = readable ? row.title || 'Unknown' : `Unavailable ${row.kind === 'listen' ? 'track' : row.kind}`;
      const cells = {
        ...(!tracks ? {title: {content: `<span>${escape(title)}</span>` + runtime.actionHtml({icon: 'more', ariaLabel: `Select ${title}`, presentation: 'bare', disabled: !readable,
          attributes: {'data-home-activity-select': row.id}})}} : {}),
        artist: escape(readable ? row.artist || '–' : '–'), album: escape(readable ? row.album_title || '–' : '–'), listens: escape(metric(readable ? row.listen_count : null)),
        favorite: readable && typeof row.favorite === 'boolean' ? row.favorite ? 'Yes' : 'No' : '–',
        rating: escape(metric(readable ? row.rating : null)), duration: escape(duration(readable ? row.duration_seconds : null)), last: escape(activityTimestamp(readable ? row.last_listened_at : null, zone)),
      };
      return tracks ? activityTrackRow(runtime, row, positions.get(row), context, cells)
        : {key: row.id, ariaSelected: readable && row.id === selectedId, ariaDisabled: !readable, cells};
    })], emptyHtml: '<p>No listening items were returned.</p>', overflow: 'local', frame: 'outline', selection: tracks ? 'multiple' : 'single'}),
  [runtime, sorted, positions, context, tracks, kind, order, ascending, zone, nowPlaying, tracks ? null : selectedId]);
  useLayoutEffect(() => {
    if (!tracks) return;
    const paint = () => {if (current()) paintActivityTracks(root.current, runtime, rows, context, love);};
    paint();
    return runtime.subscribeTrackPlayback?.(paint);
  }, [runtime, value, table, rows, context, tracks, love.version]);
  return <section ref={root} className="home-activity" aria-label="Listening results" onKeyDownCapture={event => {
    if (tracks && (event.repeat || event.isComposing) && ['Enter', ' '].includes(event.key)) {event.preventDefault(); event.stopPropagation();}
  }}>
    <div className="home-activity__controls"><NativeChoice runtime={runtime} label="Activity order" value={order} onChange={changeOrder}
      options={ [['server', 'Server order'], ['last_listened_at', 'Last listened'], ['listen_count', 'Listens'], ['title', 'Name'],
        ...(['tracks', 'listens'].includes(kind) ? [['duration_seconds', 'Length']] : [])] }/>
      <Button runtime={runtime} icon={ascending ? 'ascending' : 'descending'} disabled={order === 'server'}
        onClick={() => {latest.current = {...latest.current, ascending: !ascending}; setAscending(!ascending);}}>{`Sort ${ascending ? 'descending' : 'ascending'} by the selected activity order`}</Button>
      {(value?.data?.next_cursor || value?.data?.pagination) && order !== 'server'
        && <span className="home-friends__muted">{value.data.pagination ? 'Sorted within this page' : 'Sorted within loaded history'}</span>}</div>
    {tracks && <PlaytableSelectionActions runtime={runtime} {...selection} available={source.actionsAvailable}/>}
    {kind === 'artists' ? <><ArtistSelectionRows runtime={runtime} rows={sorted}
      view={['rows', 'list'].includes(view) ? 'list' : 'cards'} selectedId={selectedId} onSelect={selectResource}/>
      <div ref={listenedAlbumsRef} className="home-activity__listened-albums"/></>
      : kind === 'albums' && !['rows', 'list'].includes(view) ? <div className={`home-activity__cards home-activity__cards--${kind}`}>
      {sorted.map(row => {
        const readable = readableResource(row), title = readable ? row.title || 'Unknown' : `Unavailable ${row.kind}`;
        const url = readable ? safeServerArtworkUrl(row.artwork_url) : null, artboxHtml = runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${title} artwork`,
          coverHtml: url ? `<img src="${escape(url)}" alt="" loading="lazy" decoding="async" onerror="handleUtilityAlbumArtboxError(this)">` : ''});
        return <div key={row.id} className="home-activity__card" data-selected={readable && row.id === selectedId}>
          <NativeHtml html={runtime.galleryCardHtml({identity: row.id, title, artist: readable ? row.artist : '', interaction: 'none',
            displayMode: view === 'covers' ? 'covers' : 'cards', artboxHtml,
            listeningSummaryHtml: `<div class="chip-row"><span>Listens: ${escape(metric(readable ? row.listen_count : null))}</span><span>Last: ${escape(activityTimestamp(readable ? row.last_listened_at : null, zone))}</span></div>`})}/>
          <Button runtime={runtime} icon={view === 'covers' ? 'more' : undefined} selected={readable && row.id === selectedId} disabled={!readable}
            attributes={{'data-home-activity-select': row.id}} onClick={() => selectResource(row)}>{`Select ${title}`}</Button>
        </div>;
      })}</div> : <div ref={trackHost} className={tracks ? 'album-track-table album-track-table--collection' : ''}><NativeHtml html={table} onClick={select}/></div>}
    {actionError?.value === value && actionError?.context === context && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: actionError.message})}/>}
    {selected && !controlled && <aside className="home-activity__selection" aria-label="Selected listening item"><header><h3>{selected.title}</h3><Button runtime={runtime} icon="close" onClick={close}>Close selection</Button></header>
      {selected.artist && <p>{selected.artist}{selected.album_title && ` · ${selected.album_title}`}</p>}
      {['album', 'artist'].includes(selected.kind) && <ResourceDetail runtime={runtime} scopeKey={scopeKey} readDetail={readDetail}
        selection={resourceTarget(selected, selected.kind)}/>}
      {tracks && typeof onResourceSelect === 'function' && ['album', 'artist'].map(resourceKind =>
        resourceTarget(selected, resourceKind)?.allowed_actions.can_view_details === true && <Button key={resourceKind} runtime={runtime}
          onClick={() => selectResource(selected, resourceKind)}>{`View ${resourceKind === 'album' ? 'Album' : 'Artist'}`}</Button>)}
      <dl><dt>Listens</dt><dd>{metric(selected.listen_count)}</dd><dt>Rating</dt><dd>{metric(selected.rating)}</dd>
        <dt>Last listened</dt><dd>{activityTimestamp(selected.last_listened_at, zone)}</dd>{selected.source_label && <><dt>Source</dt><dd>{selected.source_label}</dd></>}</dl>
    </aside>}
  </section>;
}
