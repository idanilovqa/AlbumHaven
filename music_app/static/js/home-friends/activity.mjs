import {trackLoveHtml} from './track-preference.mjs';
import {mountButton, mountChoice} from './native-controls.mjs';
import {metric, ratingMetricHtml, safeServerArtworkUrl} from './model.mjs';
import {mountResourceDetail} from './resource-detail.mjs';
import {mountArtistSelectionRows} from './artist-selection.mjs';
import {detailSelection} from './detail-projection.mjs';
import {cycleTableSort, sortTableRows} from './table-order.mjs';
import {createTrackPreferences} from './track-preference-ui.mjs';
import {activityTrackRow, readableActivityTrack, playableActivityTrack, paintActivityTracks} from './activity-tracks.mjs';
import {mountTrackTablePresentation, mountTrackTableColumnsAction} from '../playtables/native-track-table-presentation.mjs';
import {mountPlaytableSelection, createPlaytableSource} from '../playtables/native-selection.mjs';
const EMPTY_ROWS = Object.freeze([]);
const readableResource = row => row?.source_readable !== false && !(Object.hasOwn(row?.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read !== true);
const resourceTarget = (row, kind) => {const target = detailSelection(row?.[`${kind}_target`]); return target?.kind === kind ? target : row?.kind === kind ? detailSelection({kind, ref: row.detail_ref, allowed_actions: row.allowed_actions}) : null;};
export function activityTimestamp(value, zone) {if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return '–'; try {return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short', ...(zone ? {timeZone: zone} : {})}).format(new Date(value));} catch {return value;}}
export function projectActivityRows(rows, order = 'server', ascending = false) {return sortTableRows(rows, {key: order, direction: order === 'server' ? 'default' : ascending ? 'asc' : 'desc'}, {
  listen_count: {type: 'number', getValue: row => row.listen_count}, duration_seconds: {type: 'number', getValue: row => row.duration_seconds}, last_listened_at: {type: 'number', getValue: row => Number.isFinite(Date.parse(row.last_listened_at)) ? Date.parse(row.last_listened_at) : null}, title: {type: 'text', getValue: row => row.title}});}
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '–';
export function mountActivityPanel(host, runtime, initial) {
  let props, context, contextKey, rows = EMPTY_ROWS, sorted = EMPTY_ROWS, order = 'server', ascending = false, localSelectedId = null, resourceSelection,
    disposed = false, rendering = false, rerender = false, pendingProps, updateRevision = 0, ownershipRevision = 0, frameRevision = 0, ownershipInputs, localRevision = null, localRendered = null, localValue = null, localContext = null, localProvider = null, source, sourceValue, selection, presentation, columnsAction, artists, love, selectedDetail, tableMarkup, lastSortRows, lastSortKey, notifiedListenedHost = null, error = '', localOwners = [];
  const node = (parent, tag, className, text) => {const element = host.ownerDocument.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; parent.append(element); return element;};
  host.classList.add('home-activity'); host.setAttribute('aria-label', 'Listening results');
  const controls = node(host, 'div', 'home-activity__controls'), orderHost = node(controls, 'span'), directionHost = node(controls, 'span'), sortedNote = node(controls, 'span', 'home-friends__muted'), columnsHost = node(controls, 'span');
  const selectionActions = node(host, 'div'), artistHost = node(host, 'div'), listenedHost = node(host, 'div', 'home-activity__listened-albums'), cardHost = node(host, 'div'), tableHost = node(host, 'div'), errorHost = node(host, 'div'), detailHost = node(host, 'aside', 'home-activity__selection');
  let orderChoice, directionButton, unsubscribePlayback;
  const acquired = new Set(), retired = Symbol('retired activity');
  const frameCurrent = () => !disposed && frameRevision === ownershipRevision;
  const check = () => {if (!frameCurrent()) throw retired;};
  function sameOwnership(left, right) {
    return left && ['scopeKey','account_ref','kind','period','value','readDetail','selectedResourceId'].every(key => left[key] === right[key]);
  }
  function acquire(owner) {if (!frameCurrent()) {try {owner?.dispose();} finally {throw retired;}} acquired.add(owner); return owner;}
  function release(owner) {if (owner && acquired.delete(owner)) owner.dispose();}
  function dispose() {
    if (disposed) return; disposed = true; pendingProps = null; rerender = false;
    let failure; const clean = callback => {try {callback();} catch (error) {failure ??= error;}};
    clean(() => tableHost.removeEventListener('click', click)); clean(() => cardHost.removeEventListener('click', click)); clean(() => host.removeEventListener('keydown', keydown, true));
    const unsubscribe = unsubscribePlayback; unsubscribePlayback = null; clean(() => unsubscribe?.());
    for (const owner of [...acquired].reverse()) clean(() => release(owner));
    clean(() => props?.listenedAlbumsRef?.(null)); clean(() => host.replaceChildren());
    if (failure) throw failure;
  }
  const tracks = () => ['tracks', 'listens'].includes(props.kind);
  const current = row => frameCurrent() && host.isConnected && props.value?.status === 'ready' && (!row || rows.includes(row));
  function showError(message) {if (!disposed) {error = message || ''; errorHost.innerHTML = error ? runtime.alertHtml({severity: 'error', role: 'alert', message: error}) : '';}}
  function paint() {if (props && tracks() && current() && love) paintActivityTracks(tableHost, runtime, rows, context, love);}
  function clearLocal() {localRevision = null; localRendered = null; localValue = null; localContext = null; localProvider = null; release(selectedDetail); selectedDetail = null; for (const owner of localOwners) release(owner); localOwners = []; detailHost.replaceChildren();}
  function selectedRow() {
    const controlled = !tracks() && props.selectedResourceId !== undefined, selectedId = controlled ? props.selectedResourceId : localSelectedId;
    const candidates = rows.filter(row => row.id === selectedId), candidate = !(tracks() && typeof props.onTracksSelect === 'function') && candidates.length === 1 && readableResource(candidates[0]) ? candidates[0] : null;
    if (!controlled) resourceSelection = null;
    else {
      if (!resourceSelection || resourceSelection.id !== selectedId) resourceSelection = {id: selectedId, value: props.value, context, retired: false, notified: false};
      if (selectedId != null && (resourceSelection.value !== props.value || resourceSelection.context !== context || !candidate || resourceTarget(candidate, props.kind === 'artists' ? 'artist' : 'album')?.allowed_actions.can_view_details !== true)) resourceSelection.retired = true;
      if (resourceSelection.retired) {if (!resourceSelection.notified) {resourceSelection.notified = true; props.onResourceSelect?.(null, props.kind === 'artists' ? 'artist' : 'album');} return null;}
    }
    if (!candidate && !controlled) localSelectedId = null;
    return candidate;
  }
  function selectResource(row, resourceKind = props.kind === 'artists' ? 'artist' : 'album') {
    if (!row || !current(row) || !readableResource(row) || !tracks() && row.kind !== resourceKind) return;
    if (tracks() && resourceTarget(row, resourceKind)?.allowed_actions.can_view_details !== true) return;
    if (!tracks() && props.selectedResourceId !== undefined) resourceSelection = {id: row.id, value: props.value, context, retired: false, notified: false};
    else if (!tracks()) localSelectedId = row.id;
    props.onResourceSelect?.(row, resourceKind); render();
  }
  function play(row) {
    const value = props.value, ownedContext = context, intent = runtime.trackIntent, canIntent = runtime.canTrackIntent;
    const owns = () => current(row) && props.value === value && context === ownedContext && runtime.trackIntent === intent && runtime.canTrackIntent === canIntent;
    const failed = failure => {if (owns() && failure?.name !== 'AbortError') showError('This track could not be played.');};
    try {if (!owns() || !playableActivityTrack(runtime, row, context) || !owns()) return; showError(''); Promise.resolve(intent.call(runtime, 'play', row, context)).catch(failed);} catch (failure) {failed(failure);}
  }
  function changeOrder(next) {order = next; render();}
  function chooseTrack(rowKey) {const matches = rows.filter(row => row.id === rowKey); return matches.length === 1 && readableActivityTrack(matches[0]) && current(matches[0]) ? matches[0] : null;}
  function click(event) {
    if (!current() || event.defaultPrevented || !host.contains(event.target)) return;
    const heading = event.target.closest('[data-cdt-sort]');
    if (heading) {const key = heading.dataset.cdtSort; if (heading.disabled || !['listens', 'duration'].includes(key)) return; event.preventDefault(); event.stopPropagation();
      const next = cycleTableSort({key: order === 'listen_count' ? 'listens' : order === 'duration_seconds' ? 'duration' : null, direction: order === 'server' ? 'default' : ascending ? 'asc' : 'desc'}, key);
      order = next.direction === 'default' ? 'server' : next.key === 'listens' ? 'listen_count' : 'duration_seconds'; ascending = next.direction === 'asc'; render();
      [...host.querySelectorAll('[data-cdt-sort]')].find(button => button.dataset.cdtSort === key && !button.disabled)?.focus({preventScroll: true}); return;
    }
    if (tracks()) {
      const row = chooseTrack(event.target.closest('[data-home-activity-row]')?.dataset.homeActivityRow); if (!row) return;
      const action = event.target.closest('[data-home-activity-play],[data-track-love]');
      if (action) {event.preventDefault(); event.stopPropagation(); if (!action.disabled && !(event.detail > 1)) {if (action.hasAttribute('data-track-love')) {showError(''); love.cycle(row);} else play(row);} return;}
      const selectButton = event.target.closest('[data-home-activity-select]');
      if (selectButton && !selectButton.disabled) {if (typeof props.onTracksSelect === 'function') selection?.select(row.id); else {localSelectedId = row.id; render();}}
    } else {const trigger = event.target.closest('[data-home-activity-select]'); if (trigger && !trigger.disabled) {const matches = rows.filter(row => row.id === trigger.dataset.homeActivitySelect); if (matches.length === 1) selectResource(matches[0]);}}
  }
  const keydown = event => {if (!disposed && props && tracks() && (event.repeat || event.isComposing) && ['Enter', ' '].includes(event.key)) {event.preventDefault(); event.stopPropagation();}};
  
  function render() {
    if (disposed) return; if (rendering) {rerender = true; return;} if (pendingProps) return; rendering = true; frameRevision = ownershipRevision;
    try {
      const kind = props.kind, isTracks = tracks(), value = props.value, selected = selectedRow(); check();
      const selectedId = selected?.id ?? null, escape = runtime.escapeHtml, zone = runtime.preferredTimeZone?.(); check();
      const sortKey = `${order}:${ascending}`; if (lastSortRows !== rows || lastSortKey !== sortKey) {sorted = projectActivityRows(rows, order, ascending); lastSortRows = rows; lastSortKey = sortKey;}
      orderChoice.update({label: 'Activity order', value: order, onChange: changeOrder, options: [['server', 'Server order'], ['last_listened_at', 'Last listened'], ['listen_count', 'Listens'], ['title', 'Name'], ...(isTracks ? [['duration_seconds', 'Length']] : [])]}); check();
      directionButton.update({label: `Sort ${ascending ? 'descending' : 'ascending'} by the selected activity order`, icon: ascending ? 'ascending' : 'descending', disabled: order === 'server', onClick: () => {if (!disposed) {ascending = !ascending; render();}}}); check();
      sortedNote.hidden = !(value?.data?.next_cursor || value?.data?.pagination) || order === 'server'; sortedNote.textContent = value?.data?.pagination ? 'Sorted within this page' : 'Sorted within loaded history';
      const loveOptions = {runtime, source: value, rows: isTracks ? rows : EMPTY_ROWS, context, isCurrent: () => current(), onError: showError};
      if (love) love.update(loveOptions); else love = acquire(createTrackPreferences(loveOptions, paint)); check();
      const columns = [...(isTracks ? [{key: 'number', label: '#'}] : []), {key: 'title', label: kind === 'artists' ? 'Artist' : kind === 'albums' ? 'Album' : 'Track'}, ...(kind === 'artists' ? [] : [{key: 'artist', label: 'Artist'}]), ...(isTracks ? [{key: 'album', label: 'Album'}] : []), ...(kind === 'albums' ? [{key: 'favorite', label: 'Favorite'}] : []), ...(isTracks ? [{key: 'availability', label: 'Availability'}, {key: 'love', label: 'Love'}] : []), {key: 'listens', label: 'Listens', sortable: true}, ...(kind === 'artists' ? [] : [{key: 'rating', label: 'Rating'}]), ...(isTracks ? [{key: 'duration', label: 'Length', sortable: true}] : []), {key: 'last', label: kind === 'listens' ? 'Listened at' : 'Last listened'}];
      const width = column => column.key === 'number' ? '36px' : isTracks && column.key === 'title' ? 'minmax(0,1.3fr)' : ['title', 'artist', 'album'].includes(column.key) ? 'minmax(0,1fr)' : column.key === 'last' ? 'minmax(96px,1fr)' : 'minmax(52px,auto)';
      const cards = kind === 'albums' && !['rows', 'list'].includes(props.view);
      artistHost.hidden = kind !== 'artists'; listenedHost.hidden = kind !== 'artists'; cardHost.hidden = !cards; tableHost.hidden = kind === 'artists' || cards;
      if (kind === 'artists') {const settings = {rows: sorted, view: ['rows', 'list'].includes(props.view) ? 'list' : 'cards', selectedId, onSelect: selectResource}; if (artists) artists.update(settings); else artists = acquire(mountArtistSelectionRows(artistHost, runtime, settings)); check(); if (notifiedListenedHost !== listenedHost) {notifiedListenedHost = listenedHost; props.listenedAlbumsRef?.(listenedHost);}}
      else {release(artists); artists = null; if (notifiedListenedHost) {notifiedListenedHost = null; props.listenedAlbumsRef?.(null);}}
      check();
      if (cards) {
        cardHost.className = `home-activity__cards home-activity__cards--${kind}`;
        const markup = sorted.map(row => {const readable = readableResource(row), title = readable ? row.title || 'Unknown' : `Unavailable ${row.kind}`, url = readable ? safeServerArtworkUrl(row.artwork_url) : null;
          const artboxHtml = runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${title} artwork`, coverHtml: url ? `<img src="${escape(url)}" alt="" loading="lazy" decoding="async">` : ''});
          return `<div class="home-activity__card" data-selected="${readable && row.id === selectedId}">${runtime.galleryCardHtml({identity: row.id, title, artist: readable ? row.artist : '', interaction: 'none', displayMode: props.view === 'covers' ? 'covers' : 'cards', artboxHtml, listeningSummaryHtml: `<div class="chip-row"><span>Listens: ${escape(metric(readable ? row.listen_count : null))}</span><span>Last: ${escape(activityTimestamp(readable ? row.last_listened_at : null, zone))}</span></div>`})}${runtime.buttonHtml({label: `Select ${title}`, disabled: !readable, attributes: {'data-home-activity-select': row.id, 'aria-pressed': String(readable && row.id === selectedId)}})}</div>`;}).join('');
        check(); if (cardHost.innerHTML !== markup) {const focused = cardHost.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement?.dataset.homeActivitySelect : null; cardHost.innerHTML = markup; if (focused) [...cardHost.querySelectorAll('[data-home-activity-select]')].find(button => button.dataset.homeActivitySelect === focused && !button.disabled)?.focus({preventScroll:true});}
      }
      if (kind !== 'artists' && !cards) {
        const positions = new Map(rows.map((row, index) => [row, index])), nowPlaying = props.nowPlaying;
        const markup = runtime.tableHtml({id: `home-activity-${kind}`, ariaLabel: 'Recent listening', density: 'compact', columns: columns.map(width).join(' '), columnsConfig: columns, sort: {key: order === 'listen_count' ? 'listens' : order === 'duration_seconds' ? 'duration' : null, direction: order === 'server' ? 'default' : ascending ? 'asc' : 'desc'},
          rows: [...(isTracks && nowPlaying ? [{key: `now-playing:${nowPlaying.occurrence_ref}`, className: 'album-track-table__row album-track-table__row--current album-track-table__row--playing', dataAttributes: {'now-playing': 'true'}, cells: {number: '▶', title: {content: `<span class="album-track-table__title">${escape(nowPlaying.row.title || 'Unknown track')}</span><span role="status">Now playing</span>`}, artist: escape(nowPlaying.row.artist || '–'), album: escape(nowPlaying.row.album_title || '–'), availability: '', love: {content: trackLoveHtml(runtime, nowPlaying.row)}, rating: ratingMetricHtml(runtime, nowPlaying.row, nowPlaying.row.kind), listens: '–', duration: escape(duration(nowPlaying.row.duration_seconds)), last: 'Live'}}] : []), ...sorted.map(row => {
            const readable = readableResource(row) && (!isTracks || readableActivityTrack(row)), title = readable ? row.title || 'Unknown' : `Unavailable ${row.kind === 'listen' ? 'track' : row.kind}`;
            const cells = {...(!isTracks ? {title: {content: `<span>${escape(title)}</span>` + runtime.actionHtml({icon: 'more', ariaLabel: `Select ${title}`, presentation: 'bare', disabled: !readable, attributes: {'data-home-activity-select': row.id}})}} : {}), artist: escape(readable ? row.artist || '–' : '–'), album: escape(readable ? row.album_title || '–' : '–'), listens: escape(metric(readable ? row.listen_count : null)), favorite: readable && typeof row.favorite === 'boolean' ? row.favorite ? 'Yes' : 'No' : '–', rating: ratingMetricHtml(runtime, readable ? row : null, row.kind), duration: escape(duration(readable ? row.duration_seconds : null)), last: escape(activityTimestamp(readable ? row.last_listened_at : null, zone))};
            return isTracks ? activityTrackRow(runtime, row, positions.get(row), context, cells) : {key: row.id, ariaSelected: readable && row.id === selectedId, ariaDisabled: !readable, cells};
          })], emptyHtml: '<p>No listening items were returned.</p>', overflow: 'local', frame: 'outline', selection: isTracks ? 'multiple' : 'single'});
        check(); tableHost.className = isTracks ? 'album-track-table album-track-table--collection' : '';
        if (tableMarkup !== markup) {tableHost.innerHTML = markup; tableMarkup = markup;}
      }
      check(); selectionActions.hidden = !isTracks; columnsHost.hidden = !isTracks;
      if (isTracks) {
        const settings = {runtime, sourceRows: rows, rows: sorted, context, instance: value, revision: sorted, enabled: true, isCurrent: () => current(), rowFacts: row => ({rowKey: row.id, readable: readableResource(row) && readableActivityTrack(row), selectable: readableResource(row) && readableActivityTrack(row)})};
        if (!source || sourceValue !== value) {release(selection); selection = null; release(source); source = null; check(); source = acquire(createPlaytableSource(settings)); sourceValue = value;} else source.update(settings); check();
        const selectionOptions = {runtime, sourceAdapter: source.sourceAdapter, tableKey: `home-activity-${kind}`, enabled: true, actionsHost: selectionActions, isViewCurrent: () => current(), initialSelectedRowKeys: props.selectedTrackIds,
          onSelectionChange: snapshot => {if (!rendering && current() && typeof props.onTracksSelect === 'function' && JSON.stringify(snapshot.selectedRowKeys) !== JSON.stringify(props.selectedTrackIds || [])) props.onTracksSelect(snapshot.selectedRowKeys);},
          onInspect: rowKey => {const row = chooseTrack(rowKey); if (!row) return; if (typeof props.onTracksSelect === 'function') props.onTracksSelect(selection?.getSnapshot().selectedRowKeys || [row.id], {inspect: true}); else {localSelectedId = row.id; render();}}, onPlay: rowKey => {const row = chooseTrack(rowKey); if (row) play(row);},
          onContextAction: typeof runtime.openPlaytableContext === 'function' ? (packet, lifetime, anchor) => runtime.openPlaytableContext(packet, lifetime, source.sourceAdapter, anchor) : undefined,
          onPlaylistAction: source.actionsAvailable ? (packet, lifetime, anchor, options) => runtime.openPlaylistAction(packet, lifetime, source.sourceAdapter, anchor, options) : undefined, onError: showError};
        // Parent-controlled IDs are authority, not a request to replay an old
        // native snapshot as a fresh activation. Rebuild only when they differ;
        // render-time source/initialization publications cannot select upstream.
        if (selection && typeof props.onTracksSelect === 'function'
          && JSON.stringify(selection.getSnapshot().selectedRowKeys) !== JSON.stringify(props.selectedTrackIds || [])) {
          release(selection); selection = null; check();
        }
        if (selection) selection.update(selectionOptions); else selection = acquire(mountPlaytableSelection(tableHost, selectionOptions)); check();
        const presentationOptions = {runtime, resourceKey: context, enabled: true, source: value, columns: columns.map(column => ({key: column.key, label: column.label, identity: column.key === 'title', required: ['number', 'love', 'duration'].includes(column.key), autoMinWidth: ['artist', 'album', 'availability', 'last'].includes(column.key) ? 641 : column.key === 'rating' ? 481 : 0, width: ({number: 36, title: 100, love: 36, duration: 54, rating: 64, listens: 64, last: 160, availability: 88})[column.key] || 112})), isCurrent: () => current()};
        if (presentation) presentation.update(presentationOptions); else {presentation = acquire(mountTrackTablePresentation(tableHost, presentationOptions)); columnsAction = acquire(mountTrackTableColumnsAction(columnsHost, runtime, presentation));} check(); paint();
      } else {release(selection); selection = null; release(source); source = null; release(presentation); presentation = null; release(columnsAction); columnsAction = null;}
      check();
      detailHost.hidden = !selected || !isTracks && props.selectedResourceId !== undefined;
      const rebuildLocal = localRevision !== ownershipRevision || localRendered !== selected || localValue !== value || localContext !== context || localProvider !== props.readDetail;
      if (detailHost.hidden || rebuildLocal) clearLocal();
      check(); if (!detailHost.hidden && rebuildLocal) {
        const revision = ownershipRevision; localRevision = revision; localRendered = selected; localValue = value; localContext = context; localProvider = props.readDetail;
        detailHost.setAttribute('aria-label', 'Selected listening item'); const header = node(detailHost, 'header'); node(header, 'h3', '', selected.title);
        localOwners.push(acquire(mountButton(node(header, 'span'), runtime, {label: 'Close selection', icon: 'close', onClick: () => {const id = selected.id; localSelectedId = null; render(); [...host.querySelectorAll('[data-home-activity-select],[data-home-artist-select]')].find(button => (button.dataset.homeActivitySelect || button.dataset.homeArtistSelect) === id && !button.disabled)?.focus({preventScroll: true});}}))); check();
        if (selected.artist) node(detailHost, 'p', '', `${selected.artist}${selected.album_title ? ` · ${selected.album_title}` : ''}`);
        if (['album', 'artist'].includes(selected.kind)) selectedDetail = acquire(mountResourceDetail(node(detailHost, 'div'), runtime, {isOwnerCurrent: () => revision === ownershipRevision && current(selected) && props.value === value && localRendered === selected, scopeKey: props.scopeKey, readDetail: props.readDetail, selection: resourceTarget(selected, selected.kind)}));
        check();
        if (isTracks && typeof props.onResourceSelect === 'function') for (const resourceKind of ['album', 'artist']) if (resourceTarget(selected, resourceKind)?.allowed_actions.can_view_details === true) localOwners.push(acquire(mountButton(node(detailHost, 'span'), runtime, {label: `View ${resourceKind === 'album' ? 'Album' : 'Artist'}`, onClick: () => selectResource(selected, resourceKind)})));
        check();
        const facts = node(detailHost, 'dl'); for (const [label, text] of [['Listens', metric(selected.listen_count)], ['Rating', null], ['Last listened', activityTimestamp(selected.last_listened_at, zone)], ...(selected.source_label ? [['Source', selected.source_label]] : [])]) {node(facts, 'dt', '', label); const dd = node(facts, 'dd', '', text ?? ''); if (label === 'Rating') dd.innerHTML = ratingMetricHtml(runtime, selected, selected.kind);}
      }
    } catch (error) {if (error !== retired) {try {dispose();} catch {} throw error;}} finally {rendering = false; if (pendingProps) {const next = pendingProps, revision = updateRevision; queueMicrotask(() => {if (!disposed && updateRevision === revision && pendingProps === next) {pendingProps = null; update(next);}});} else if (rerender) {rerender = false; queueMicrotask(render);}}
  }
  function update(next) {
    if (disposed) return; updateRevision++;
    const normalized = {kind: 'tracks', view: 'rows', account_ref: null, period: 'week', ...next};
    // Invalidate before returning to native focus, but keep harmless parent
    // publications from retiring a stable local detail on every render.
    if (!sameOwnership(ownershipInputs, normalized)) ownershipRevision++;
    ownershipInputs = normalized;
    if (rendering) {pendingProps = normalized; return;}
    pendingProps = null; const previous = props; props = normalized;
    const key = JSON.stringify([props.scopeKey, props.account_ref, props.kind, props.period]);
    if (contextKey !== key) {contextKey = key; context = {scopeKey: props.scopeKey, account_ref: props.account_ref, kind: props.kind, period: props.period}; sourceValue = null; localSelectedId = null; order = 'server'; ascending = false;}
    if (previous?.value !== props.value) showError(''); rows = props.value?.status === 'ready' ? props.value.data?.rows || EMPTY_ROWS : EMPTY_ROWS; render();
  }
  try {
    orderChoice = acquire(mountChoice(orderHost, runtime, {label: 'Activity order', options: []}));
    directionButton = acquire(mountButton(directionHost, runtime, {label: 'Sort'}));
    tableHost.addEventListener('click', click); cardHost.addEventListener('click', click); host.addEventListener('keydown', keydown, true);
    const unsubscribe = runtime.subscribeTrackPlayback?.(paint);
    if (disposed) {unsubscribe?.(); throw retired;} unsubscribePlayback = unsubscribe;
    update(initial);
  } catch (error) {try {dispose();} catch {} if (error !== retired) throw error;}
  return {element: host, update, dispose};
}
