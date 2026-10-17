import {createNativeOwnerScope} from './native-owner-scope.mjs';
import {cycleTableSort,sortTableRows} from '../home-friends/table-order.mjs';
import {safeServerArtworkUrl} from '../home-friends/model.mjs';
import {createTrackPreferenceController,paintTrackLoveCell} from '../home-friends/track-preference.mjs';
import {mountPlaylistReorder} from './reorder.mjs';
import {playlistTrackMetricColumns,playlistTrackMetricCells,getPlaylistTrackMetricValue} from './track-metrics.mjs';
import {defaultFilters,granted,hasPlaylistFilters,playlistDraft,playlistFilters,visiblePlaylistRows} from './model.mjs';
import {createPlaytableSource,mountPlaytableSelection} from '../playtables/native-selection.mjs';
const METRIC_COLUMNS = playlistTrackMetricColumns();
const playlistColumns = reorderable => [
  ...(reorderable ? [{key: 'order', label: 'Order', action: true, width: 70}] : []),
  {key: 'number', label: '#', required: true, width: 36},
  {key: 'title', label: 'Track', identity: true, width: 100},
  {key: 'artist', label: 'Artist', width: 112, autoMinWidth: 641}, {key: 'album', label: 'Album', width: 112, autoMinWidth: 641},
  {key: 'availability', label: 'Availability', width: 88, autoMinWidth: 641},
  ...METRIC_COLUMNS.map(({hideWhenNarrow, ...column}) => ({...column, width: parseFloat(column.width),
    autoMinWidth: column.key === 'track_rating' ? 481 : 0, required: ['love_tier', 'duration'].includes(column.key)})),
];
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

export function playlistTableHtml(runtime, {rows, sourceRows = rows, detail, reorderable = false, sort = null, preferenceFor}) {
  const escape = runtime.escapeHtml;
  const positions = new Map(sourceRows.map((row, index) => [row, index]));
  reorderable = reorderable && !sorted(sort);
  const columns = playlistColumns(reorderable);
  return runtime.tableHtml({id: 'playlist-tracks', ariaLabel: `${detail.title || 'Playlist'} tracks`, density: 'compact', frame: 'outline', sort,
    selection: 'multiple', overflow: 'local',
    columns: columns.map(column => column.identity ? 'minmax(0,1fr)' : `${column.width}px`).join(' '), columnsConfig: columns,
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
            title: 'Play track', presentation: 'bare', hidden: track.availability !== 'local', disabled: !playable(runtime, detail, track), attributes: {'data-playlists-play': '1'}}) + '</span>'},
          title: {content: `<div class="home-detail__release playlists__track-identity">${artwork}<div>${native?.cells?.title?.content || escape(track.title)}</div></div>` + runtime.actionHtml({icon: 'more',
            ariaLabel: `Show details for ${track.title || 'track'}`, title: 'Show track and album information', presentation: 'bare',
            disabled: track.source_readable !== true, attributes: {'data-playlists-select': '1'}})},
          ...playlistTrackMetricCells(runtime, track, preferenceFor?.(track)),
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

export function mountPlaylistTracks(container, runtime, initialProps) {
  let props = initialProps, disposed = false, initialized = false;
  let revision = 0, rendering = false, queued = false;
  let sort = null, displayed = [], source = null, selection = null;
  let renderedHtml = null, context = null, resource = null;
  let sortScope = null, sortPlaylist = null, hasLocalSort = false, localSort = null;
  let preferences = null, reorder = null;
  const scope = createNativeOwnerScope();
  let cleanupError = null;
  const release = callback => scope.defer(() => {
    try {callback();} catch (error) {cleanupError ||= error;}
  });
  const own = owner => {release(() => owner.dispose()); return owner;};
  const doc = container.ownerDocument;
  const host = doc.createElement('div'), actions = doc.createElement('div');
  const announcement = doc.createElement('span'), sortNote = doc.createElement('p');
  release(() => container.replaceChildren());
  release(() => {
    const previous = source;
    source = null;
    previous?.dispose();
  });
  release(() => {
    const previous = selection;
    selection = null;
    previous?.dispose();
  });

  function current(row) {
    const owner = props;
    return !disposed && host.isConnected && owner.controller.getSnapshot() === owner.state
      && props === owner && !disposed && owner.state.resource.status === 'ready'
      && owner.state.resource.data?.detail === owner.detail
      && owner.state.selectedPlaylistId === owner.detail.playlist_id
      && (!row || displayed.includes(row) && owner.detail.track_rows.includes(row));
  }

  function play(row) {
    const owner = props, intent = runtime.trackIntent, canIntent = runtime.canTrackIntent;
    const rows = displayed;
    const ownsIntent = () => !disposed && props === owner && displayed === rows
      && runtime.trackIntent === intent && runtime.canTrackIntent === canIntent && current(row);
    const failed = () => {
      if (ownsIntent()) owner.onError?.('This track could not be played.');
    };
    try {
      if (!ownsIntent() || !playable(runtime, owner.detail, row) || !ownsIntent()) return;
      Promise.resolve(intent.call(runtime, 'play', row, {
        playlist_id: owner.detail.playlist_id,
        scopeKey: owner.state.scopeKey,
        displayedItemIds: rows.map(item => item.playlist_item_id)
      })).catch(failed);
    } catch {
      failed();
    }
  }

  function sourceOptions(owner, rows, ownerContext) {
    return {
      runtime, sourceRows: owner.detail.track_rows, rows, context: ownerContext,
      instance: owner.detail, revision: owner.state, isCurrent: current,
      rowFacts: row => ({rowKey: row.row_key, readable: row.source_readable === true,
        selectable: row.source_readable === true})
    };
  }

  function selectionOptions(owner, rows, ownerContext, ownerSource, reorderable) {
    const owns = () => !disposed && source === ownerSource && context === ownerContext && current();
    const resolve = key => {
      const matches = rows.filter(row => row.row_key === key);
      return matches.length === 1 && props === owner && owns() && current(matches[0]) ? matches[0] : null;
    };
    return {
      runtime, actionsHost: actions, sourceAdapter: ownerSource.sourceAdapter,
      tableKey: 'playlist-tracks', isViewCurrent: owns,
      onInspect: key => {const row = resolve(key); if (row) owner.onSelect?.(row);},
      onPlay: key => {const row = resolve(key); if (row) play(row);},
      onContextAction: typeof runtime.openPlaytableContext === 'function'
        ? (packet, lifetime, anchor) => runtime.openPlaytableContext(packet, lifetime, ownerSource.sourceAdapter, anchor)
        : undefined,
      onPlaylistAction: ownerSource.actionsAvailable
        ? (packet, lifetime, anchor, options) => runtime.openPlaylistAction(packet, lifetime, ownerSource.sourceAdapter, anchor, options)
        : undefined,
      onError: owner.onError,
      tablePresentation: {resourceKey: ownerContext, source: owner.state,
        columns: playlistColumns(reorderable), isCurrent: owns}
    };
  }

  function render() {
    if (disposed) return;
    revision++;
    if (!initialized || rendering) {queued = true; return;}
    rendering = true;
    const token = revision, owner = props;
    const live = () => !disposed && revision === token && props === owner;
    try {
      const changed = !context || context.scopeKey !== owner.state.scopeKey
        || context.playlist_id !== owner.detail.playlist_id || resource !== owner.detail;
      if (changed) {
        const previousSelection = selection;
        selection = null;
        previousSelection?.dispose();
        if (!live()) return;
        const previousSource = source;
        source = null;
        previousSource?.dispose();
        if (!live()) return;
        context = {scopeKey: owner.state.scopeKey, playlist_id: owner.detail.playlist_id};
        resource = owner.detail;
        if (sortScope !== context.scopeKey || sortPlaylist !== context.playlist_id) {
          hasLocalSort = false;
          localSort = null;
          sortScope = context.scopeKey;
          sortPlaylist = context.playlist_id;
        }
      }
      const ownerContext = context;
      const savedSort = owner.detail.saved_default_sort;
      sort = hasLocalSort ? localSort
        : ['love_tier', 'play_count', 'popularity_count', 'duration'].includes(savedSort?.key)
          && ['asc', 'desc'].includes(savedSort?.direction) ? savedSort : null;
      const rows = sortTableRows(owner.rows, sort, {...SORT_COLUMNS,
        love_tier: {type: 'number', getValue: row => getPlaylistTrackMetricValue(row, 'love_tier', preferences.get(row).preference)}});
      if (!live()) return;
      displayed = rows;
      const reorderable = canReorder(playlistReorderSnapshot(owner.controller, owner.selected, sort));
      if (!live()) return;
      const html = playlistTableHtml(runtime, {
        // Live Love state is painted into the retained native cell below.
        // Including pending/tier in the structural HTML would replace every
        // row and its focused button before that identity-preserving paint.
        rows, sourceRows: owner.rows, detail: owner.detail, reorderable, sort
      });
      if (!live()) return;
      const focused = host.contains(doc.activeElement) ? doc.activeElement : null;
      const key = focused?.closest('[data-playlist-row-key]')?.dataset.playlistRowKey;
      const attribute = ['data-cdt-sort', 'data-playlists-move', 'data-playlists-play',
        'data-playlists-select', 'data-track-love'].find(name => focused?.hasAttribute(name));
      const value = attribute && focused.getAttribute(attribute);
      if (html !== renderedHtml) {host.innerHTML = html; renderedHtml = html;}
      for (const row of rows) {
        const element = [...host.querySelectorAll('[data-playlist-row-key]')]
          .find(node => node.dataset.playlistRowKey === row.row_key);
        paintTrackLoveCell(element?.querySelector('[data-track-love-cell]'), runtime, row, preferences.get(row));
        if (!live()) return;
      }
      if (!source) {
        const acquired = createPlaytableSource(sourceOptions(owner, rows, ownerContext));
        if (!live()) {acquired.dispose(); return;}
        source = acquired;
      } else {
        source.update(sourceOptions(owner, rows, ownerContext));
        if (!live()) return;
      }
      const ownerSource = source;
      const options = selectionOptions(owner, rows, ownerContext, ownerSource, reorderable);
      if (!selection) {
        const acquired = mountPlaytableSelection(host, options);
        if (!live() || source !== ownerSource) {acquired.dispose(); return;}
        selection = acquired;
      } else {
        selection.update(options);
        if (!live() || source !== ownerSource) return;
      }
      reorder.update();
      if (!live()) return;
      paintPlaylistCurrent(host, rows, owner.currentItemId);
      sortNote.hidden = !sorted(sort);
      sortNote.textContent = sorted(sort) ? 'Sorted view. Restore default order to reorder tracks.' : '';
      if (focused && (!doc.activeElement || doc.activeElement === doc.body || !doc.activeElement.isConnected)) {
        const row = [...host.querySelectorAll('[data-playlist-row-key]')]
          .find(node => node.dataset.playlistRowKey === key);
        const search = attribute === 'data-cdt-sort' ? host : row;
        const target = attribute
          ? [...(search?.querySelectorAll(`[${attribute}]`) || [])]
            .find(node => node.getAttribute(attribute) === value && !node.disabled)
          : row?.getAttribute('tabindex') === '0' ? row : null;
        target?.focus({preventScroll: true});
      }
      if (!live()) return;
      owner.onDisplayedRowsChange?.({detail: owner.detail, scopeKey: owner.state.scopeKey, rows});
    } finally {
      rendering = false;
      if (queued && !disposed) {queued = false; render();}
    }
  }

  function click(event) {
    if (!current() || event.defaultPrevented || !host.contains(event.target)) return;
    const sortButton = event.target.closest('[data-cdt-sort]');
    if (sortButton) {
      if (sortButton.disabled || !Object.hasOwn(SORT_COLUMNS, sortButton.dataset.cdtSort)) return;
      event.preventDefault(); event.stopPropagation();
      localSort = cycleTableSort(sort, sortButton.dataset.cdtSort);
      hasLocalSort = true;
      render();
      return;
    }
    const key = event.target.closest('[data-playlist-row-key]')?.dataset.playlistRowKey;
    const matches = displayed.filter(row => row.row_key === key), row = matches.length === 1 ? matches[0] : null;
    if (!row || !current(row) || event.target.closest('[data-playlists-drag]')) return;
    const love = event.target.closest('[data-track-love]'), playButton = event.target.closest('[data-playlists-play]');
    if (love || playButton) {
      event.preventDefault(); event.stopPropagation();
      if (!(love || playButton).disabled && event.detail <= 1) {
        if (love) preferences.cycle(row); else play(row);
      }
      return;
    }
    const move = event.target.closest('[data-playlists-move]');
    if (move) {
      if (move.disabled) return;
      const order = playlistReorderSnapshot(props.controller, props.selected, sort);
      if (order.source !== props.detail || !canReorder(order)) return;
      const ids = order.rows.map(item => item.playlist_item_id), index = ids.indexOf(row.playlist_item_id);
      const next = index + (move.dataset.playlistsMove === 'up' ? -1 : 1);
      if (index >= 0 && next >= 0 && next < ids.length) {
        [ids[index], ids[next]] = [ids[next], ids[index]];
        props.controller.reorder(ids);
      }
      return;
    }
    const inspect = event.target.closest('[data-playlists-select]');
    if (inspect && !inspect.disabled && row.source_readable === true) props.onSelect?.(row);
  }
  function keydown(event) {
    if ((event.repeat || event.isComposing) && (['Enter', ' '].includes(event.key)
      || event.target.closest('[data-playlists-drag]'))) {
      event.preventDefault(); event.stopPropagation();
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    revision++;
    scope.dispose();
    try {props.onDisplayedRowsChange?.(null);} catch (error) {cleanupError ||= error;}
    if (cleanupError) throw cleanupError;
  }

  try {
    host.className = 'album-track-table album-track-table--collection playlists__tracks';
    announcement.className = 'sr-only'; announcement.setAttribute('aria-live', 'polite');
    sortNote.className = 'playlists__note'; sortNote.setAttribute('role', 'status');
    container.replaceChildren(announcement, actions, sortNote, host);
    preferences = createTrackPreferenceController({
      getView: () => ({runtime, source: props.detail, rows: props.rows, context,
        isCurrent: current, onError: props.onError}),
      onChange: render, onError: message => {if (!disposed) props.onError?.(message);}
    });
    release(() => preferences.cancel());
    const unsubscribe = runtime.subscribeTrackPreferences?.(() => {
      if (disposed) return;
      preferences.sync();
      if (!disposed) render();
    });
    if (unsubscribe) release(unsubscribe);
    reorder = own(mountPlaylistReorder(host, {
      snapshot: () => playlistReorderSnapshot(props.controller, props.selected, sort),
      onReorder: ids => !disposed && props.controller.reorder(ids),
      onAnnounce: message => {if (!disposed) announcement.textContent = message;}
    }));
    scope.listen(host, 'click', click);
    scope.listen(host, 'keydown', keydown, true);
    initialized = true;
    queued = false;
    render();
    if (!disposed) preferences.sync();
    return {
      element: container,
      update(next) {
        if (disposed) return;
        const filtersChanged = playlistFilters(props.state) !== playlistFilters(next.state);
        props = next;
        revision++;
        // A filter transition retires writes even when the same row remains
        // visible and the detail/provider object is otherwise unchanged.
        if (filtersChanged) preferences.cancel();
        preferences.sync();
        if (!disposed) render();
      },
      dispose
    };
  } catch (error) {
    disposed = true;
    revision++;
    scope.dispose();
    throw error;
  }
}
