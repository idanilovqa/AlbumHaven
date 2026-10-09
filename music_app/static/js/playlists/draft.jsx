import {RetryOriginalRequest} from './mutation-status.jsx';
import React, {useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button, NativeHtml} from '../home-friends/components.jsx';
import {NativeChoice} from '../home-friends/native-choice.jsx';
import {detailDuration} from '../home-friends/detail-projection.jsx';
import {CreationSearch, creationReviewRow} from './creation.jsx';
import {PlaylistFilterControls} from './directory-filters.jsx';
import {PlaylistFilterSurface} from './filter-surface.jsx';
import {usePlaylistFilterSession} from './filter-session.jsx';
import {DEFAULT_PLAYLIST_FILTERS} from './filters.mjs';
import {PlaylistSelectionPanel} from './selection.jsx';
import {missingPlaylistDraftTopIntent, projectMissingPlaylistDraft} from './draft.mjs';
import {mountPlaylistReorder} from './reorder.mjs';
import {MissingPlaylistLocalMatch} from './draft-local-match.jsx';
import {cycleTableSort, sortTableRows} from '../home-friends/table-order.mjs';
import {playlistTrackMetricColumns, playlistTrackMetricCells, getPlaylistTrackMetricValue} from './track-metrics.mjs';
import {PlaytableSelectionActions} from '../playtables/selection.jsx';
import {editorRowSelectable, useEditorPlaytableSelection} from '../playtables/editor-selection.jsx';

const known = value => typeof value === 'string' && value.trim() ? value : 'Unknown';
const metricColumns = playlistTrackMetricColumns();
const metricSortColumns = Object.fromEntries(metricColumns.filter(column => column.sortable).map(column =>
  [column.key, {type: column.type, getValue: row => getPlaylistTrackMetricValue(row, column.key)}]));
const rowAttributes = ['data-draft-pick', 'data-draft-review', 'data-draft-remove', 'data-draft-move', 'data-playlists-drag'];
const samePage = (left, right) => left.draftToken && left.draftToken === right.draftToken
  && left.scopeKey === right.scopeKey && left.source?.kind === right.source?.kind
  && left.source?.ref === right.source?.ref && left.source?.revision === right.source?.revision;

export function MissingPlaylistDraftHeader({runtime, title, filtersId, filtersOpen, busy, actions, onAction}) {
  const host = useRef(null);
  const html = runtime.galleryBarHtml({contextKind: 'recent', title: title || 'Missing tracks', actionsHtml: [
    ['top', 'Create Album Top', !actions.top, 'create-top'], ['export', 'Export TXT', !actions.export, 'export-text'],
    ['filters', 'Filters', !actions.filters, 'filters'], ['save', 'Save', !actions.save, 'save'], ['close', 'Close playlist preview', !actions.close, 'close'],
  ].map(([action, label, unavailable, icon]) => {
    const options = {disabled: busy || unavailable, title: action === 'top' && unavailable
      ? 'Album Top creation is unavailable for these source albums.' : label,
    attributes: {'data-playlists-draft-action': action,
      ...(action === 'filters' ? {'aria-expanded': String(filtersOpen), 'aria-controls': filtersId} : {})}};
    return runtime.actionHtml({...options, icon, ariaLabel: label, presentation: 'bare'});
  }).join('')});
  const initial = useRef(html);
  useLayoutEffect(() => {
    const node = host.current, document = node.ownerDocument;
    const active = node.contains(document.activeElement) ? document.activeElement.dataset.playlistsDraftAction : null;
    if (node.innerHTML !== html) node.innerHTML = html;
    if (active) [...node.querySelectorAll('[data-playlists-draft-action]')]
      .find(button => button.dataset.playlistsDraftAction === active && !button.disabled)?.focus({preventScroll: true});
  }, [html]);
  return <header ref={host} className="gallery-bar playlists__header" dangerouslySetInnerHTML={{__html: initial.current}}
    onClick={event => {
      const button = event.target.closest('[data-playlists-draft-action]');
      if (button && !button.disabled) onAction(button.dataset.playlistsDraftAction);
    }}/>;
}

export function missingPlaylistDraftTableHtml(runtime, {id, state, projection, disabled = false,
  sort = {key: null, direction: 'default'}}) {
  const escape = runtime.escapeHtml, selected = new Set(state.selectedKeys);
  const metrics = metricColumns;
  const identityColumns = '30px 70px 36px minmax(0,1.3fr) minmax(0,.7fr) minmax(0,.7fr) minmax(64px,.7fr)';
  const positions = new Map(projection.authoredEntries.map((entry, index) => [entry.row_key, index]));
  const reorderable = projection.canReorder && !disabled;
  return runtime.tableHtml({id, ariaLabel: `${state.title || 'Missing playlist'} tracks`, density: 'compact', frame: 'outline',
    selection: 'multiple', overflow: 'local',
    sort, sortDisabled: disabled,
    columns: `${identityColumns} ${metrics.map(column => column.width).join(' ')} 40px`,
    narrowColumns: `30px 36px minmax(0,1fr) ${metrics.filter(column => !column.hideWhenNarrow).map(column => column.width).join(' ')} 40px`,
    columnsConfig: [{key: 'selection', label: 'Select', header: 'screen-reader'}, {key: 'order', label: 'Order', action: true, hideWhenNarrow: true},
      {key: 'number', label: '#'}, {key: 'title', label: 'Track'}, {key: 'artist', label: 'Artist', hideWhenNarrow: true}, {key: 'album', label: 'Album', hideWhenNarrow: true},
      {key: 'availability', label: 'Availability', hideWhenNarrow: true}, ...metrics, {key: 'remove', label: 'Remove', action: true}],
    rows: projection.entries.map(entry => {
      const index = positions.get(entry.row_key), title = known(entry.title);
      // Only presentation facts reach AlbumTrackTable. Its native media contract
      // never receives a source occurrence, draft token or fabricated item ID.
      const native = runtime.albumTrackRow({title, secondary_artist: entry.artist, availability: entry.availability,
        duration_display: entry.duration_seconds === null ? '—' : detailDuration(entry.duration_seconds)}, index, {readOnly: true});
      const artwork = runtime.artboxHtml({state: entry.artwork_url ? 'ready' : 'empty', label: `${title} artwork`,
        coverHtml: entry.artwork_url ? `<img src="${escape(entry.artwork_url)}" alt="" loading="lazy" decoding="async" onerror="handleUtilityAlbumArtboxError(this)">` : ''});
      const metadata = {current: '', last_known: 'Last-known metadata', unknown: 'Metadata freshness unknown'}[entry.metadata_state];
      return {key: entry.row_key, className: native.className,
        tabIndex: !disabled && editorRowSelectable(entry) ? 0 : undefined, ariaDisabled: disabled || !editorRowSelectable(entry),
        dataAttributes: {'playlist-row-key': entry.row_key}, cells: {
          selection: {content: `<input type="checkbox" data-draft-pick="${escape(entry.row_key)}" aria-label="Select ${escape(title)}"${selected.has(entry.row_key) ? ' checked' : ''}${disabled ? ' disabled' : ''}>`},
          order: {content: runtime.buttonHtml({label: '↕', size: 'small', disabled: !reorderable,
            attributes: {'data-playlists-drag': '1', 'aria-label': `Reorder ${title}; use arrow keys, Home or End`, 'aria-grabbed': 'false'}})
            + [['up', 'Move up', index === 0], ['down', 'Move down', index === projection.authoredEntries.length - 1]]
            .map(([direction, label, edge]) => runtime.buttonHtml({label, size: 'small', disabled: !reorderable || edge,
              attributes: {'data-draft-move': direction, 'aria-label': `${label}: ${title}`}})).join('')},
          number: {content: `<span class="album-track-table__number-play"><span class="album-track-table__number">${escape(index + 1)}</span>`
            + runtime.actionHtml({icon: 'play', className: 'album-track-table__play', ariaLabel: `Playback unavailable for ${title}`,
              title: 'Source playback is unavailable for this unsaved playlist.', presentation: 'bare', hidden: entry.availability === 'missing', disabled: true}) + '</span>'},
          title: {content: `<div class="home-detail__release playlists-draft__identity">${artwork}<div>${native.cells.title.content}`
            + (metadata ? `<span class="album-track-table__secondary">${escape(metadata)}</span>` : '') + '</div></div>'},
          artist: {content: escape(known(entry.artist))}, album: {content: escape(known(entry.album_title))},
          availability: {content: `<span class="album-track-table__secondary">${entry.availability === 'local' ? 'Matched locally' : entry.availability === 'missing' ? 'Confirmed missing' : 'Availability unknown'}</span>`
            + runtime.buttonHtml({label: 'Review', size: 'small', disabled,
              attributes: {'data-draft-review': entry.row_key, 'aria-label': `Review ${title}`}})},
          ...playlistTrackMetricCells(runtime, entry),
          remove: {content: runtime.actionHtml({icon: 'delete', ariaLabel: `Remove ${title}`, title: 'Remove from this draft',
            presentation: 'bare', disabled, attributes: {'data-draft-remove': entry.row_key}})},
        }};
    }), emptyHtml: `<p role="status">${projection.authoredEntries.length ? 'No tracks match these filters.' : 'No tracks remain in this draft.'}</p>`,
  });
}

export function missingPlaylistDraftReorderSnapshot(controller, selectedRowKey = null, disabled = false, defaultOrder = true) {
  const state = controller.getSnapshot(), projection = projectMissingPlaylistDraft(state);
  return {scopeKey: state.scopeKey, draftToken: state.draftToken, source: state.sourceResource.data, selectedRowKey,
    rows: projection.authoredEntries, itemsComplete: state.sourceResource.status === 'ready', canEdit: projection.canEdit,
    canReorder: projection.canReorder, unfiltered: projection.unfiltered, defaultOrder, busy: disabled || state.mutation.status !== 'idle'};
}

export function MissingPlaylistDraftTracks({runtime, id, controller, state, projection, reviewKey, disabled, onReview}) {
  const host = useRef(null), owner = useRef(null), latest = useRef(null);
  const [announcement, setAnnouncement] = useState('');
  const [sort, setSort] = useState({key: null, direction: 'default'});
  latest.current = {controller, state, reviewKey, disabled, sort};
  const sorted = useMemo(() => ({...projection, entries: sortTableRows(projection.entries, sort, metricSortColumns),
    canReorder: projection.canReorder && sort.direction === 'default'}), [projection, sort]);
  const html = useMemo(() => missingPlaylistDraftTableHtml(runtime, {id, state, projection: sorted, disabled, sort}),
    [runtime, id, state, sorted, disabled, sort]);
  const initial = useRef(html);
  useLayoutEffect(() => {setSort({key: null, direction: 'default'});}, [controller, state.scopeKey, state.draftToken, state.source?.revision]);
  useLayoutEffect(() => {
    owner.current = mountPlaylistReorder(host.current, {
      snapshot: () => latest.current?.controller === controller
        ? missingPlaylistDraftReorderSnapshot(controller, latest.current.reviewKey, latest.current.disabled,
          latest.current.sort.direction === 'default') : null,
      collectionKey: value => value.draftToken, itemKey: row => row.row_key,
      onReorder: keys => controller.reorder(keys), onAnnounce: setAnnouncement,
    });
    return () => {owner.current?.dispose(); owner.current = null;};
  }, [controller]);
  useLayoutEffect(() => {
    const node = host.current, document = node.ownerDocument;
    const active = node.contains(document.activeElement) ? document.activeElement : null;
    const sortKey = active?.getAttribute('data-cdt-sort');
    const key = active?.closest('[data-playlist-row-key]')?.dataset.playlistRowKey;
    const attribute = rowAttributes.find(name => active?.hasAttribute(name)), value = attribute && active.getAttribute(attribute);
    const previous = [...node.querySelectorAll('[data-playlist-row-key]')], position = previous.findIndex(row => row.dataset.playlistRowKey === key);
    if (node.innerHTML !== html) node.innerHTML = html;
    owner.current?.update();
    if (sortKey && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) {
      [...node.querySelectorAll('[data-cdt-sort]')].find(button => button.dataset.cdtSort === sortKey && !button.disabled)?.focus({preventScroll: true});
      return;
    }
    if (!key || document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
    const rows = [...node.querySelectorAll('[data-playlist-row-key]')], row = rows.find(item => item.dataset.playlistRowKey === key);
    const same = attribute ? [...(row?.querySelectorAll(`[${attribute}]`) || [])].find(button => button.getAttribute(attribute) === value && !button.disabled)
      : row?.getAttribute('tabindex') === '0' ? row : null;
    const fallbackRow = rows[Math.min(Math.max(position, 0), rows.length - 1)];
    const fallback = (fallbackRow?.getAttribute('tabindex') === '0' ? fallbackRow : fallbackRow?.querySelector('[data-draft-pick]:not(:disabled)'))
      || node.closest('main')?.querySelector('[data-playlists-draft-action="filters"]:not(:disabled)');
    (same || fallback)?.focus({preventScroll: true});
  }, [html]);
  const selection = useEditorPlaytableSelection(host, {controller, state, rows: sorted.entries,
    tableKey: 'playlist-missing-draft', disabled, onInspect: onReview});
  const current = () => Boolean(owner.current) && !disabled && !latest.current.disabled && latest.current.controller === controller && latest.current.state === state
    && controller.getSnapshot() === state && projectMissingPlaylistDraft(state).canEdit;
  return <><span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    <PlaytableSelectionActions runtime={runtime} {...selection} available={false}/>
    <p className="playlists__note" role={selection.unavailableNotice ? 'status' : undefined}>
      Add to playlist is unavailable for these unsaved source tracks.
    </p>
    {sort.direction !== 'default' && <p className="playlists__note" role="status">Sorted view. Restore default table order to reorder tracks.</p>}
    <div ref={host} className="album-track-table album-track-table--collection playlists__tracks playlists-draft__tracks" dangerouslySetInnerHTML={{__html: initial.current}}
    onChange={event => {
      const input = event.target.closest('[data-draft-pick]');
      if (input && !input.disabled && current()) controller.toggle(input.dataset.draftPick);
    }} onClick={event => {
      if (event.defaultPrevented || !current()) return;
      const heading = event.target.closest('[data-cdt-sort]');
      if (heading) {
        if (heading.disabled || !Object.hasOwn(metricSortColumns, heading.dataset.cdtSort)) return;
        event.preventDefault(); event.stopPropagation();
        const next = cycleTableSort(latest.current.sort, heading.dataset.cdtSort);
        latest.current.sort = next; owner.current?.update(); setSort(next); return;
      }
      const node = event.target.closest('[data-playlist-row-key]');
      const entry = projection.entries.find(row => row.row_key === node?.dataset.playlistRowKey);
      if (!entry || event.target.closest('[data-playlists-drag]')) return;
      const control = event.target.closest('button');
      if (control?.disabled) return;
      if (control?.hasAttribute('data-draft-review')) {onReview(entry.row_key); return;}
      if (control?.hasAttribute('data-draft-remove')) {controller.remove(entry.row_key); return;}
      if (control?.hasAttribute('data-draft-move')) {
        if (!projection.canReorder || latest.current.sort.direction !== 'default') return;
        const keys = projection.authoredEntries.map(row => row.row_key), from = keys.indexOf(entry.row_key);
        const to = from + (control.dataset.draftMove === 'up' ? -1 : 1);
        if (from >= 0 && to >= 0 && to < keys.length) {
          [keys[from], keys[to]] = [keys[to], keys[from]];
          if (controller.reorder(keys)) setAnnouncement(`Moved to position ${to + 1} of ${keys.length}.`);
        }
        return;
      }
    }}/></>;
}

function DraftSourceStatus({runtime, value, locked, onReload}) {
  if (value.status === 'ready') return null;
  const retry = ['error', 'conflict', 'incomplete', 'refresh_required'].includes(value.status);
  const message = {loading: 'Checking source tracks…', denied: 'You no longer have permission to use this source.',
    unavailable: 'This source is unavailable.', error: 'The source tracks could not be refreshed.',
    conflict: 'This source changed. Refresh its tracks before saving.', incomplete: 'The source is incomplete. Refresh its tracks before saving.',
    refresh_required: 'Refresh source tracks before continuing this draft.'}[value.status] || 'This source is unavailable.';
  return <div aria-busy={value.status === 'loading'}>
    <NativeHtml html={runtime.alertHtml({severity: retry ? 'error' : 'info', role: retry ? 'alert' : 'status', message})}/>
    {retry && <Button runtime={runtime} disabled={locked} onClick={onReload}>Refresh tracks</Button>}
  </div>;
}

const filterSourceIdentity = state => state.draftToken && state.sourceResource.status === 'ready'
  ? [state.scopeKey, state.draftToken, state.sourceResource.data] : null;

// The native parent owns page lifetime, dirty dismissal and nested Top returns.
// This page never saves on navigation and never opens a parallel form or modal.
export function MissingPlaylistDraftPage({runtime, controller, state, onClose, onSaved, onTop, readDetail, directory, busy: parentBusy = false}) {
  const id = `playlist-draft-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const page = useRef(null), selectAll = useRef(null), pending = useRef(null), lifetime = useRef(null), latest = useRef(null), returnFocus = useRef(null);
  const [review, setReview] = useState(null), [message, setMessage] = useState('');
  const filterSession = usePlaylistFilterSession(controller, filterSourceIdentity);
  const filterOwner = filterSession.opening, filtersOpen = Boolean(filterOwner);
  const [completing, setCompleting] = useState(false);
  latest.current = {runtime, controller, state, onClose, onSaved, onTop, parentBusy};
  const projection = useMemo(() => projectMissingPlaylistDraft(state), [state]);
  const ready = state.sourceResource.status === 'ready', busy = parentBusy || state.mutation.status === 'loading' || completing;
  const locked = busy || !projection.canEdit;
  const reviewEntry = review?.token === state.draftToken ? projection.entries.find(entry => entry.row_key === review.key) : null;
  const reviewRow = creationReviewRow(reviewEntry, state.source);
  const mixed = projection.visibleSelectedCount > 0 && projection.visibleSelectedCount < projection.entries.length;
  const canExport = ready && projection.authoredEntries.length > 0 && typeof runtime.downloadText === 'function';
  const canTop = Boolean(missingPlaylistDraftTopIntent(state) && typeof onTop === 'function');
  useLayoutEffect(() => {
    const owner = {}; lifetime.current = owner; pending.current = null; returnFocus.current = null;
    setCompleting(false); setMessage(''); setReview(null);
    return () => {if (lifetime.current === owner) lifetime.current = null; pending.current = null;};
  }, [controller, state.draftToken, state.scopeKey, state.source?.kind, state.source?.ref, state.source?.revision]);
  useLayoutEffect(() => {if (selectAll.current) selectAll.current.indeterminate = mixed;}, [mixed]);
  useLayoutEffect(() => {
    if (!returnFocus.current || reviewRow || !page.current) return;
    const key = returnFocus.current; returnFocus.current = null;
    const document = page.current.ownerDocument, active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    [...page.current.querySelectorAll('[data-draft-review]')].find(button => button.dataset.draftReview === key && !button.disabled)?.focus({preventScroll: true});
  }, [reviewRow]);
  const renderCurrent = () => latest.current.controller === controller && latest.current.state === state
    && latest.current.runtime === runtime && controller.getSnapshot() === state
    && !parentBusy && !latest.current.parentBusy && !pending.current && Boolean(lifetime.current);
  const continuationCurrent = owner => lifetime.current === owner && latest.current.controller === controller
    && samePage(state, controller.getSnapshot()) && samePage(state, latest.current.state);
  const run = async action => {
    if (!renderCurrent() || busy || pending.current) return;
    setMessage('');
    if (action === 'filters') {if (ready) filterSession.toggle(); return;}
    if (action === 'export') {
      if (!canExport) return;
      const owner = lifetime.current;
      try {await runtime.downloadText({text: controller.exportText(), filename: 'playlist-missing.txt'});}
      catch {if (continuationCurrent(owner)) setMessage('TXT export is unavailable.');}
      return;
    }
    if (!['save', 'reconcile', 'retry', 'top', 'close'].includes(action)) return;
    const intent = action === 'top' ? controller.topIntent() : null;
    if (action === 'save' && !controller.canSave()
      || action === 'reconcile' && !controller.canReconcile?.()
      || action === 'retry' && !controller.canRetryOriginal?.()
      || action === 'top' && (!intent || typeof onTop !== 'function' || latest.current.onTop !== onTop)
      || action === 'close' && (typeof onClose !== 'function' || latest.current.onClose !== onClose)) return;
    const owner = lifetime.current, request = {}; pending.current = request; setCompleting(true);
    try {
      if (action === 'close') {await onClose({reason: state.mutation.status === 'ready' ? 'close' : 'discard', restoreFocusRequested: true}); return;}
      if (action === 'top') {
        const opened = await onTop(intent);
        if (opened === false && continuationCurrent(owner)) setMessage('Album Top could not be opened. Your draft is still here.');
        return;
      }
      const result = await (action === 'retry' ? controller.reconcile({retry: true}) : action === 'reconcile' ? controller.reconcile() : controller.save()), current = controller.getSnapshot();
      if (!result || !continuationCurrent(owner) || current.mutation.status !== 'ready'
        || ['scopeKey', 'request_key', 'playlist_id', 'revision'].some(key => current.mutation.data?.[key] !== result[key])) return;
      try {
        const opened = await latest.current.onSaved?.(result);
        if (opened === false && continuationCurrent(owner)) setMessage('Playlist saved, but it could not be opened.');
      }
      catch {if (continuationCurrent(owner)) setMessage('Playlist saved, but it could not be opened.');}
    } catch {
      if (continuationCurrent(owner)) setMessage({top: 'Album Top could not be opened. Your draft is still here.',
        close: 'This page could not be closed. Your draft is still here.',
        save: 'Save was not confirmed. Check your playlists before another attempt.',
        retry: 'The original Save is still unconfirmed.',
        reconcile: 'Save is still unconfirmed. Check again before starting another attempt.'}[action]);
    } finally {
      if (pending.current === request) {pending.current = null; if (continuationCurrent(owner)) setCompleting(false);}
    }
  };
  const mutationMessage = {loading: 'Saving playlist…', ready: 'Playlist saved.',
    error: 'Save was not confirmed. Your draft is still here; check your playlists before another attempt.',
    denied: 'You do not have permission to save this playlist.', conflict: 'This source changed. Save was not confirmed.',
    unavailable: 'Saving is unavailable. Your draft is still here.'}[state.mutation.status];
  const content = <main ref={page} className="playlists__content playlists-draft" aria-label="Unsaved missing playlist" aria-busy={busy}>
    <MissingPlaylistDraftHeader runtime={runtime} title={state.title} filtersId={`${id}-filters`} filtersOpen={filtersOpen} busy={busy}
      actions={{top: canTop, export: canExport, filters: ready, save: controller.getSnapshot() === state && controller.canSave(), close: typeof onClose === 'function'}} onAction={run}/>
    {ready && filtersOpen && <PlaylistFilterSurface key={filterOwner.id} runtime={runtime} id={`${id}-filters`}
      returnFocus={() => page.current?.querySelector('[data-playlists-draft-action="filters"]')}
      onClose={() => filterSession.close(filterOwner)}>
      <PlaylistFilterControls runtime={runtime} rows={projection.authoredEntries} filters={state.filters} disabled={locked} canReset={!projection.unfiltered}
        onChange={patch => {if (renderCurrent() && filterSession.current(filterOwner)) controller.setFilters(patch);}}
        onReset={() => {if (renderCurrent() && filterSession.current(filterOwner)) {controller.setQuery(''); controller.setFilters({...DEFAULT_PLAYLIST_FILTERS, availability: 'all'});}}}>
        <CreationSearch runtime={runtime} id={`${id}-search`} className="playlists-filter__search" value={state.query} disabled={locked}
          placeholder="Track, artist or album" onChange={query => {if (renderCurrent() && filterSession.current(filterOwner)) controller.setQuery(query);}}/>
        <NativeChoice runtime={runtime} label="Availability" value={state.filters.availability} disabled={locked}
          options={ [['all', 'All retained tracks'], ['local', 'Matched locally'], ['missing', 'Confirmed missing'], ['unresolved', 'Availability unknown']] }
          onChange={availability => {if (renderCurrent() && filterSession.current(filterOwner)) controller.setFilters({availability});}}/>
      </PlaylistFilterControls>
    </PlaylistFilterSurface>}
    <div className="playlists__scroll gallery-scrollbar">
      <div className="playlists__metadata tag-editor-form">
        <label>Name<input aria-label="Playlist name" value={state.title} maxLength={100} required disabled={locked}
          onChange={event => {if (renderCurrent() && !locked) controller.edit({title: event.target.value});}}/></label>
        <label>Description<textarea aria-label="Playlist description" rows={2} value={state.description} maxLength={1000} disabled={locked}
          onChange={event => {if (renderCurrent() && !locked) controller.edit({description: event.target.value});}}/></label>
        <p className="playlists__note" role="status">{state.mutation.status === 'ready' ? 'Saved playlist' : 'Unsaved playlist · Save keeps this playlist.'}</p>
      </div>
      <DraftSourceStatus runtime={runtime} value={state.sourceResource} locked={busy || state.mutation.request_key !== null}
        onReload={() => {if (renderCurrent()) controller.refresh();}}/>
      {ready && <>
        <div className="playlists__summary">
          <span>{projection.entries.length} displayed tracks · {projection.authoredEntries.length} retained</span>
          <label className="playlists-draft__select-visible"><input ref={selectAll} type="checkbox" aria-label="Select visible tracks"
            aria-checked={mixed ? 'mixed' : projection.visibleSelectedCount > 0}
            checked={projection.entries.length > 0 && projection.visibleSelectedCount === projection.entries.length} disabled={locked || !projection.entries.length}
            onChange={event => {if (renderCurrent()) controller.selectVisible(event.target.checked);}}/>Select visible</label>
          <Button runtime={runtime} disabled={locked || !projection.selectedCount} onClick={() => {if (renderCurrent()) controller.remove();}}>Remove selected</Button>
        </div>
        <MissingPlaylistDraftTracks {...{runtime, controller, state, projection}} id={`${id}-tracks`} reviewKey={reviewRow?.row_key} disabled={locked}
          onReview={key => {if (renderCurrent()) setReview({token: state.draftToken, key});}}/>
        {reviewRow && <div className="playlists__selection-context">
          <PlaylistSelectionPanel runtime={runtime} scopeKey={state.scopeKey} row={reviewRow} readDetail={readDetail}
            onClose={({rowKey, restoreFocusRequested} = {}) => {returnFocus.current = restoreFocusRequested ? rowKey : null; setReview(null);}}/>
          <MissingPlaylistLocalMatch runtime={runtime} controller={controller} row={reviewEntry} disabled={locked}/>
        </div>}
        <p className="playlists__note">TXT includes retained missing and unknown originals in draft order, regardless of filters. Export does not save this playlist.</p>
      </>}
      {mutationMessage && <NativeHtml html={runtime.alertHtml({severity: ['error', 'denied', 'conflict'].includes(state.mutation.status) ? 'error' : 'info',
        role: ['error', 'denied', 'conflict'].includes(state.mutation.status) ? 'alert' : 'status', message: mutationMessage})}/>}
      <RetryOriginalRequest runtime={runtime} scopeKey={state.scopeKey} available={controller.canRetryOriginal?.() === true}
        disabled={busy} retry={() => run('retry')} current={() => samePage(state, controller.getSnapshot()) && Boolean(lifetime.current)}/>
      {controller.canReconcile?.() && <Button runtime={runtime} disabled={busy} onClick={() => run('reconcile')}>Check save result</Button>}
      {message && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message})}/>}
    </div>
  </main>;
  return directory ? <div className="playlists">{directory}{content}</div> : content;
}
