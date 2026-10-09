import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {cycleTableSort, sortTableRows} from '../home-friends/table-order.mjs';
import {safeServerArtworkUrl} from '../home-friends/model.mjs';
import {useTrackPreferences} from '../home-friends/track-preference.jsx';
import {paintTrackLoveCell} from '../home-friends/track-preference.mjs';
import {mountPlaylistReorder} from './reorder.mjs';
import {playlistTrackMetricColumns, playlistTrackMetricCells, getPlaylistTrackMetricValue} from './track-metrics.mjs';
import {defaultFilters, granted, hasPlaylistFilters, playlistDraft, playlistFilters, visiblePlaylistRows} from './model.mjs';
import {PlaytableSelectionActions, usePlaytableSelection, usePlaytableSource} from '../playtables/selection.jsx';

const METRIC_COLUMNS = playlistTrackMetricColumns();
const SORT_COLUMNS = Object.fromEntries(METRIC_COLUMNS.filter(column => column.sortable).map(column => [column.key,
  {type: column.type, getValue: row => getPlaylistTrackMetricValue(row, column.key)}]));
const sorted = sort => Boolean(sort && Object.hasOwn(SORT_COLUMNS, sort.key) && ['asc', 'desc'].includes(sort.direction));
const sameSort = (left, right) => sorted(left) || sorted(right)
  ? left?.key === right?.key && left?.direction === right?.direction : true;
const canReorder = value => value.itemsComplete && value.canEdit && value.canReorder && value.unfiltered && value.defaultOrder && !value.busy
  && value.rows.length > 1 && value.rows.every(row => typeof row.playlist_item_id === 'string' && row.playlist_item_id)
  && new Set(value.rows.map(row => row.row_key)).size === value.rows.length
  && new Set(value.rows.map(row => row.playlist_item_id)).size === value.rows.length;
const playable = (runtime, detail, row) => row.source_readable === true && row.availability !== 'missing'
  && typeof row.playlist_item_id === 'string' && Boolean(row.playlist_item_id) && granted(detail, 'can_play')
  && typeof runtime.trackIntent === 'function' && typeof runtime.canTrackIntent === 'function'
  && runtime.canTrackIntent('play', row, {playlist_id: detail.playlist_id}) === true;

export function playlistReorderSnapshot(controller, selectedRowKey = null, sort = null) {
  const state = controller.getSnapshot(), detail = state.resource.status === 'ready' ? state.resource.data?.detail : null;
  return {scopeKey: state.scopeKey, playlistId: detail?.playlist_id, source: detail, selectedRowKey,
    rows: visiblePlaylistRows(detail, detail && playlistDraft(state, detail.playlist_id), defaultFilters),
    itemsComplete: detail?.items_complete === true, canEdit: granted(detail, 'can_edit'), canReorder: granted(detail, 'can_reorder'),
    unfiltered: !hasPlaylistFilters(playlistFilters(state)), defaultOrder: detail?.author_order === true && !sorted(sort),
    busy: state.mutation.status === 'loading'};
}
export function paintPlaylistCurrent(host, rows, itemId) {
  const current = rows.filter(row => row.source_readable === true && row.playlist_item_id && row.playlist_item_id === itemId);
  const key = current.length === 1 ? current[0].row_key : null;
  for (const node of host.querySelectorAll('[data-playlist-row-key]')) {
    if (key !== null && node.dataset.playlistRowKey === key) node.setAttribute('aria-current', 'true');
    else node.removeAttribute('aria-current');
  }
}
export function restorePlaylistSelectionFocus(root, rowKey, document) {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return false;
  const row = [...(root?.querySelectorAll('[data-playlist-row-key]') || [])].find(node => node.dataset.playlistRowKey === rowKey);
  const target = row?.querySelector('[data-playlists-select]');
  if (!target || target.disabled || !target.isConnected) return false;
  target.focus({preventScroll: true}); return true;
}

export function playlistTableHtml(runtime, {rows, sourceRows = rows, detail, reorderable = false, sort = null}) {
  const escape = runtime.escapeHtml;
  const positions = new Map(sourceRows.map((row, index) => [row, index]));
  reorderable = reorderable && !sorted(sort);
  const leadingColumns = `${reorderable ? '70px ' : ''}36px minmax(160px,1.3fr) minmax(90px,.7fr) minmax(90px,.7fr) minmax(95px,.6fr)`;
  return runtime.tableHtml({id: 'playlist-tracks', ariaLabel: `${detail.title || 'Playlist'} tracks`, density: 'compact', frame: 'outline', sort,
    selection: 'multiple', overflow: 'local', mobile: 'preserve',
    columns: `${leadingColumns} ${METRIC_COLUMNS.map(column => column.width).join(' ')}`,
    narrowColumns: `${leadingColumns} ${METRIC_COLUMNS.filter(column => !column.hideWhenNarrow).map(column => column.width).join(' ')}`,
    columnsConfig: [...(reorderable ? [{key: 'order', label: 'Order', action: true}] : []),
      {key: 'number', label: '#'}, {key: 'title', label: 'Track'}, {key: 'artist', label: 'Artist'},
      {key: 'album', label: 'Album'}, {key: 'availability', label: 'Availability'}, ...METRIC_COLUMNS],
    rows: rows.map((track, index) => {
      const position = positions.get(track) ?? index;
      const native = typeof runtime.albumTrackRow === 'function' ? runtime.albumTrackRow({title: track.title,
        secondary_artist: track.secondary_artist, availability: track.availability, duration_display: track.duration_display}, position, {readOnly: true}) : null;
      const artworkUrl = track.source_readable === true ? safeServerArtworkUrl(track.artwork_url) : null;
      const artwork = runtime.artboxHtml({state: artworkUrl ? 'ready' : 'empty', label: `${track.title || 'Track'} artwork`,
        coverHtml: artworkUrl ? `<img src="${escape(artworkUrl)}" alt="" loading="lazy" decoding="async" onerror="handleUtilityAlbumArtboxError(this)">` : ''});
      return {key: track.row_key, className: native?.className || 'album-track-table__row',
        tabIndex: track.source_readable === true ? 0 : -1, ariaDisabled: track.source_readable !== true,
        dataAttributes: {'playlist-row-key': track.row_key}, cells: {
          number: {content: `<span class="album-track-table__number-play"><span class="album-track-table__number">${escape(position + 1)}</span>` + runtime.actionHtml({icon: 'play', className: 'album-track-table__play', ariaLabel: `Play ${track.title || 'track'}`,
            title: 'Play track', presentation: 'bare', disabled: !playable(runtime, detail, track), attributes: {'data-playlists-play': '1'}}) + '</span>'},
          title: {content: `<div class="home-detail__release playlists__track-identity">${artwork}<div>${native?.cells?.title?.content || escape(track.title)}</div></div>` + runtime.actionHtml({icon: 'more',
            ariaLabel: `Show details for ${track.title || 'track'}`, title: 'Show track and album information', presentation: 'bare',
            disabled: track.source_readable !== true, attributes: {'data-playlists-select': '1'}})},
          ...playlistTrackMetricCells(runtime, track),
          artist: {content: escape(track.artist || track.secondary_artist || '–')}, album: {content: escape(track.album_title || '–')},
          availability: {content: escape({local: 'Local', missing: 'Missing', unresolved: 'Needs review'}[track.availability])
            + (track.source_readable === true && ['missing', 'unresolved'].includes(track.availability) ? runtime.buttonHtml({label: 'Review', size: 'small',
              attributes: {'data-playlists-select': 'review', 'aria-label': `Review ${track.title || 'track'}`}}) : '')},
          ...(reorderable ? {order: {content: runtime.buttonHtml({label: '↕', size: 'small',
            attributes: {'data-playlists-drag': '1', 'aria-label': `Reorder ${track.title || 'track'}; use arrow keys, Home or End`, 'aria-grabbed': 'false'}}) + [['up', 'Move up', index === 0], ['down', 'Move down', index === rows.length - 1]]
            .map(([direction, label, disabled]) => runtime.buttonHtml({label, size: 'small', disabled,
              attributes: {'data-playlists-move': direction, 'aria-label': `${label}: ${track.title}`}})).join('')}} : {}),
        }};
    }), emptyHtml: '<p role="status">No tracks match these filters.</p>',
  });
}

/** Owns native row presentation and table gestures. Playback and author order
 * remain commands to the current runtime/controller, never local transport. */
export function PlaylistTracks({runtime, rows, detail, controller, state, selected, currentItemId, onSelect, onError}) {
  const host = useRef(null), owner = useRef(null), latest = useRef(null), renderedHtml = useRef(null), [announcement, setAnnouncement] = useState('');
  const [sortState, setSort] = useState(null);
  const sort = sortState?.scopeKey === state.scopeKey && sortState?.playlistId === detail.playlist_id ? sortState : (['love_tier', 'play_count', 'popularity_count', 'duration'].includes(detail.saved_default_sort?.key)
    && ['asc', 'desc'].includes(detail.saved_default_sort?.direction) ? detail.saved_default_sort : null);
  const filters = playlistFilters(state), preferenceSource = useMemo(() => ({detail, filters}), [detail, filters]);
  const love = useTrackPreferences({runtime, source: preferenceSource, rows, context: {scopeKey: state.scopeKey, playlist_id: detail.playlist_id},
    isCurrent: () => controller.getSnapshot() === state && state.resource.status === 'ready' && state.resource.data?.detail === detail
      && state.selectedPlaylistId === detail.playlist_id,
    onError});
  const displayed = useMemo(() => sortTableRows(rows, sort, {...SORT_COLUMNS,
    love_tier: {type: 'number', getValue: row => getPlaylistTrackMetricValue(row, 'love_tier', love.get(row).preference)}}),
  [rows, sort, love.version, runtime, detail, state.scopeKey]);
  const view = useMemo(() => ({runtime, rows: displayed, detail, state, sort}), [runtime, displayed, detail, state, sort]);
  const context = useMemo(() => ({scopeKey: state.scopeKey, playlist_id: detail.playlist_id}), [state.scopeKey, detail.playlist_id]);
  latest.current = {view, selected, onSelect, onError};
  const reorderable = canReorder(playlistReorderSnapshot(controller, selected, sort));
  const html = useMemo(() => playlistTableHtml(runtime, {rows: displayed, sourceRows: rows, detail, reorderable, sort}), [runtime, displayed, rows, detail, reorderable, sort]);
  const current = row => {
    const next = latest.current?.view;
    return next?.runtime === runtime && next.detail === detail && next.state === state && sameSort(next.sort, sort)
      && host.current?.isConnected && controller.getSnapshot() === state && state.resource.status === 'ready'
      && state.resource.data?.detail === detail && state.selectedPlaylistId === detail.playlist_id
      && (!row || next.rows.includes(row) && detail.track_rows.includes(row));
  };
  useLayoutEffect(() => {
    latest.current = {view, selected, onSelect, onError};
    owner.current = mountPlaylistReorder(host.current, {snapshot: () => playlistReorderSnapshot(controller, latest.current?.selected || null, latest.current?.view.sort),
      onReorder: ids => controller.reorder(ids), onAnnounce: setAnnouncement});
    return () => {owner.current?.dispose(); owner.current = null; latest.current = null;};
  }, [controller]);
  useLayoutEffect(() => {
    const node = host.current, focused = node.contains(document.activeElement) ? document.activeElement : null;
    const key = focused?.closest('[data-playlist-row-key]')?.dataset.playlistRowKey;
    const attribute = ['data-cdt-sort', 'data-playlists-move', 'data-playlists-play', 'data-playlists-select', 'data-track-love'].find(name => focused?.hasAttribute(name));
    const value = attribute && focused.getAttribute(attribute);
    // Selection/player paint is deliberately absent from this stored markup.
    // Comparing live innerHTML would replace rows just because aria state changed.
    if (renderedHtml.current !== html) {node.innerHTML = html; renderedHtml.current = html;}
    const rowElements = new Map([...node.querySelectorAll('[data-playlist-row-key]')].map(element => [element.dataset.playlistRowKey, element]));
    for (const row of displayed) {
      const element = rowElements.get(row.row_key);
      paintTrackLoveCell(element?.querySelector('[data-track-love-cell]'), runtime, row, love.get(row));
    }
    owner.current?.update();
    if (focused && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) {
      const row = key && [...node.querySelectorAll('[data-playlist-row-key]')].find(candidate => candidate.dataset.playlistRowKey === key);
      const controls = attribute && (attribute === 'data-cdt-sort' ? node : row)?.querySelectorAll(`[${attribute}]`);
      const target = attribute ? [...(controls || [])].find(button => button.getAttribute(attribute) === value && !button.disabled)
        : row?.getAttribute('tabindex') === '0' ? row : null;
      target?.focus({preventScroll: true});
    }
  }, [html, detail, reorderable, displayed, love.version, runtime]);
  useLayoutEffect(() => {
    owner.current?.update();
  }, [displayed, html, selected]);
  // Player notifications never invalidate the HTML memo or replace native rows.
  useLayoutEffect(() => {paintPlaylistCurrent(host.current, displayed, currentItemId);}, [displayed, html, currentItemId]);
  const rowFor = event => {
    if (!current() || event.defaultPrevented || !host.current.contains(event.target)) return null;
    const key = event.target.closest('[data-playlist-row-key]')?.dataset.playlistRowKey;
    const matches = displayed.filter(row => row.row_key === key);
    return matches.length === 1 && current(matches[0]) ? matches[0] : null;
  };
  const intent = runtime.trackIntent, canIntent = runtime.canTrackIntent;
  const play = row => {
    const ownsIntent = () => current(row) && runtime.trackIntent === intent && runtime.canTrackIntent === canIntent;
    const failed = () => {if (ownsIntent()) latest.current.onError('This track could not be played.');};
    try {
      if (!ownsIntent() || !playable(runtime, detail, row) || !ownsIntent()) return;
      // Native activation starts in this event turn. Deferring the invocation
      // could replace a newer choice already made in the native player.
      Promise.resolve(intent.call(runtime, 'play', row, {playlist_id: detail.playlist_id, scopeKey: state.scopeKey, displayedItemIds: displayed.map(item => item.playlist_item_id)})).catch(failed);
    } catch {failed();}
  };
  const source = usePlaytableSource({runtime, sourceRows: detail.track_rows, rows: displayed, context, instance: detail, revision: view,
    isCurrent: () => latest.current?.view.runtime === runtime && latest.current?.view.detail === detail && host.current?.isConnected
      && controller.getSnapshot().scopeKey === state.scopeKey && controller.getSnapshot().resource.status === 'ready'
      && controller.getSnapshot().resource.data?.detail === detail && controller.getSnapshot().selectedPlaylistId === detail.playlist_id,
    rowFacts: row => ({rowKey: row.row_key, readable: row.source_readable === true, selectable: row.source_readable === true})});
  const selectedRow = rowKey => {
    const found = displayed.filter(row => row.row_key === rowKey);
    return found.length === 1 && current(found[0]) ? found[0] : null;
  };
  const selection = usePlaytableSelection(host, {sourceAdapter: source.sourceAdapter, tableKey: 'playlist-tracks',
    isViewCurrent: () => current(),
    onInspect: rowKey => {const row = selectedRow(rowKey); if (row?.source_readable === true) onSelect(row);},
    onPlay: rowKey => {const row = selectedRow(rowKey); if (row) play(row);},
    onPlaylistAction: source.actionsAvailable ? (packet, lifetime, anchor) => runtime.openPlaylistAction(packet, lifetime, source.sourceAdapter, anchor) : undefined,
    onError});
  return <><span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    <PlaytableSelectionActions runtime={runtime} {...selection} available={source.actionsAvailable}/>
    {sorted(sort) && <p className="playlists__note" role="status">Sorted view. Restore default order to reorder tracks.</p>}
    <div ref={host} className="album-track-table playlists__tracks" onClick={event => {
      if (!current() || event.defaultPrevented || !host.current.contains(event.target)) return;
      const sortButton = event.target.closest('[data-cdt-sort]');
      if (sortButton) {
        if (sortButton.disabled || !Object.hasOwn(SORT_COLUMNS, sortButton.dataset.cdtSort)) return;
        event.preventDefault(); event.stopPropagation();
        const next = {...cycleTableSort(sort, sortButton.dataset.cdtSort), scopeKey: state.scopeKey, playlistId: detail.playlist_id};
        latest.current = {...latest.current, view: {...view, sort: next}};
        owner.current?.update(); setSort(next); return;
      }
      const row = rowFor(event);
      if (!row || event.target.closest('[data-playlists-drag]')) return;
      const loveButton = event.target.closest('[data-track-love]');
      if (loveButton) {
        event.preventDefault(); event.stopPropagation();
        if (!loveButton.disabled && !(event.detail > 1)) love.cycle(row);
        return;
      }
      const playButton = event.target.closest('[data-playlists-play]');
      if (playButton) {
        event.preventDefault(); event.stopPropagation();
        if (!playButton.disabled && !(event.detail > 1)) play(row);
        return;
      }
      const move = event.target.closest('[data-playlists-move]');
      if (move) {
        if (move.disabled) return;
        const order = playlistReorderSnapshot(controller, selected, sort);
        if (order.source !== detail || !canReorder(order)) return;
        const ids = order.rows.map(value => value.playlist_item_id);
        const index = ids.indexOf(row.playlist_item_id), next = index + (move.dataset.playlistsMove === 'up' ? -1 : 1);
        if (index >= 0 && next >= 0 && next < ids.length) {[ids[index], ids[next]] = [ids[next], ids[index]]; controller.reorder(ids);}
        return;
      }
      const select = event.target.closest('[data-playlists-select]');
      if (select && !select.disabled && row.source_readable === true) onSelect(row);
    }} onKeyDownCapture={event => {
      if ((event.repeat || event.isComposing) && (['Enter', ' '].includes(event.key) || event.target.closest('[data-playlists-drag]'))) {
        event.preventDefault(); event.stopPropagation();
      }
    }}/></>;
}
