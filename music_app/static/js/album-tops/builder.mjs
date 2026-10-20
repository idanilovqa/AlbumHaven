import {mountButton, mountTabs} from '../home-friends/native-controls.mjs';
import {openNativeDialog} from '../home-friends/native-dialog.mjs';
import {mountCreationSearch} from '../playlists/native-creation.mjs';
import {mountCollectionReorder} from '../playlists/reorder.mjs';
import {albumTopActionAllowed} from './model.mjs';
import {createAlbumTopDraft} from './draft.mjs';
import {mountMutationNotice, albumTopDraftErrorMessage} from './mutation-notice.mjs';
let pickerId = 0;
function element(parent, tag = 'div', className = '', text) {
  const node = parent.ownerDocument.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text; parent.append(node); return node;
}
export function draftAccess(state, value, existing) {
  const busy = value.busy || state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
  const allowed = albumTopActionAllowed(state, existing ? 'save' : 'create', existing?.top_ref);
  const stale = value.stale || Boolean(existing && (state.detail.data?.top_ref !== existing.top_ref || state.detail.data?.revision !== existing.revision));
  const membershipAllowed = !existing || Boolean(existing.edit_draft) && state.detail.data?.allowed_actions?.['library.album_tops.items.manage'] === true
    && ['add', 'remove', 'reorder'].every(name => albumTopActionAllowed(state, name, existing.top_ref));
  return {busy, stale, disabled: busy || stale || value.denied || value.remote?.retired === true || !allowed, membershipAllowed};
}
const pickerAvailable = (runtime, providers) => typeof providers.searchAlbums === 'function' && typeof providers.admitAlbum === 'function'
  && typeof runtime.searchHtml === 'function' && typeof runtime.tabsHtml === 'function' && typeof runtime.mountTabs === 'function';
const draftRowKey = row => row.album_ref || row.selection_key;
function remotePickerAvailable(draft, providers) {
  if (!['setPool', 'setRemoteTitle', 'setRemoteArtist', 'searchRemote', 'selectRemote', 'retryRemoteAcquisition',
    'readRemotePreparationState', 'maintainRemotePreparations', 'closeRemotePreparation'].every(key => typeof draft[key] === 'function')
    || !['remoteContext', 'searchRemoteAlbums', 'beginRemotePreparation', 'acquireRemoteAlbum',
      'readRemotePreparationState', 'maintainRemotePreparations', 'closeRemotePreparation'].every(key => typeof providers[key] === 'function')) return false;
  try {return Boolean(providers.remoteContext());} catch {return false;}
}
// Remote preparation is explicit, volatile authoring work. Rendering and disposal
// never acquire, poll, reclaim, close, or acknowledge a membership command.
export function mountRemoteAlbumPicker(host, runtime, props) {
  const owners = [], candidates = new Map(), parents = new Map(), inputs = [];
  let latest = props, disposed = false, confirming = false, redraw = () => {}, rendering = false, revision = 0;
  const superseded = Symbol('retired remote picker render');
  const root = element(host, 'section', 'album-top-builder__remote'); root.setAttribute('aria-label', 'Remote album preparation');
  const fields = element(root, 'div', 'album-top-builder__remote-fields tag-editor-form');
  const actions = element(root, 'div', 'playlists__actions'), status = element(root, 'p', 'playlists__note'); status.setAttribute('role', 'status');
  const cards = element(root, 'div', 'home-activity__cards album-top-builder__cards'), management = element(root, 'div', 'album-top-builder__remote-management');
  element(management, 'p', 'playlists__note', 'Remote albums contain an album summary only. Tracks and artwork are unavailable. Preparations expire; they are not saved membership.');
  const managementActions = element(management, 'div', 'playlists__actions'), capacity = element(management, 'p', 'playlists__note');
  const parentList = element(management, 'div', 'album-top-builder__remote-parents');
  function dispose() {
    if (disposed) return; disposed = true; revision++;
    inputs.forEach(({input, change}) => input.removeEventListener('input', change));
    for (const item of candidates.values()) item.card.removeEventListener('click', item.click);
    const controls = [...parents.values()].map(item => item.control).concat(owners.splice(0));
    candidates.clear(); parents.clear(); root.remove();
    let failure; for (const owner of controls) {try {owner.dispose();} catch (error) {failure ??= error;}}
    if (failure) throw failure;
  }
  const button = (parent, options) => {const owner = mountButton(element(parent, 'span'), runtime, options); owners.push(owner); return owner;};
  const blocked = () => disposed || latest.blocked === true || confirming || latest.value.remote?.retired === true;
  const actionBusy = () => blocked() || latest.value.remote?.operation?.status === 'loading';
  const managementBusy = () => actionBusy() || Boolean(latest.value.remote?.operation);
  const memberBlocked = () => blocked() || latest.disabled || latest.value.remote?.membershipRetired === true;
  const current = captured => !disposed && latest.value === captured && latest.draft.getSnapshot() === captured && !latest.blocked && !captured.remote?.retired;
  async function confirmed(message, title, run) {
    if (managementBusy() || typeof runtime.confirm !== 'function') return false;
    const captured = latest.value; confirming = true; redraw(latest);
    try {
      if (!current(captured)) return false;
      const accepted = await runtime.confirm(message, {title, acceptLabel: 'Discard preparations', danger: true});
      if (accepted !== true || !current(captured)) return false;
      return await run();
    } finally {confirming = false; if (!disposed) redraw(latest);}
  }
  try {
    for (const [key, label, method] of [['title', 'Remote album title', 'setRemoteTitle'], ['artist', 'Remote artist (optional)', 'setRemoteArtist']]) {
      const wrapper = element(fields, 'label'); element(wrapper, 'span', '', label);
      const input = element(wrapper, 'input'); input.type = 'text'; input.maxLength = 100; input.setAttribute('aria-label', label); input.autocomplete = 'off';
      const change = () => {if (!memberBlocked()) latest.draft[method](input.value);}; input.addEventListener('input', change); inputs.push({key, input, change});
    }
    const search = button(actions, {label: 'Search remote albums', onClick: () => {if (!memberBlocked()) latest.draft.searchRemote();}});
    const retry = button(actions, {label: 'Retry preparation', onClick: () => {if (!actionBusy()) latest.draft.retryRemoteAcquisition();}});
    const ownState = button(managementActions, {label: 'Check preparation status', onClick: () => {if (!managementBusy()) latest.draft.readRemotePreparationState();}});
    const reclaim = button(managementActions, {label: 'Reclaim expired preparations', onClick: () => {if (!managementBusy()) latest.draft.maintainRemotePreparations();}});
    const legacy = button(managementActions, {label: 'Discard legacy preparations', onClick: () => confirmed(
      'Discard your legacy remote preparations? This can invalidate selections in other open editors. Saved Album Tops are unchanged.',
      'Discard legacy preparations', () => latest.draft.maintainRemotePreparations({discardLegacy: true, confirmed: true}))});
    const close = button(managementActions, {label: 'Close current preparation', onClick: () => {
      const ref = latest.value.remote?.preparation?.preparation_ref; if (!managementBusy() && ref) latest.draft.closeRemotePreparation(ref);
    }});
    function render(next, version) {
      const currentPass = () => !disposed && revision === version;
      const check = () => {if (!currentPass()) throw superseded;};
      const {value} = next, remote = value.remote || {}, operation = remote.operation;
      check();
      const locked = actionBusy(), waiting = Boolean(operation), canRetry = ['unknown', 'in_flight'].includes(operation?.status);
      inputs.forEach(({key, input}) => {if (input.value !== (remote[key] || '')) input.value = remote[key] || ''; input.disabled = memberBlocked();});
      search.update({label: 'Search remote albums', disabled: memberBlocked() || !remote.title?.trim() || remote.search?.status === 'loading', onClick: () => {if (!memberBlocked()) latest.draft.searchRemote();}}); check();
      retry.update({label: 'Retry preparation', disabled: locked || !canRetry, onClick: () => {if (!actionBusy()) latest.draft.retryRemoteAcquisition();}}); check();
      ownState.update({label: 'Check preparation status', disabled: locked || waiting, onClick: () => {if (!managementBusy()) latest.draft.readRemotePreparationState();}}); check();
      reclaim.update({label: 'Reclaim expired preparations', disabled: locked || waiting, onClick: () => {if (!managementBusy()) latest.draft.maintainRemotePreparations();}}); check();
      legacy.update({label: 'Discard legacy preparations', disabled: locked || waiting || typeof runtime.confirm !== 'function', onClick: () => confirmed(
        'Discard your legacy remote preparations? This can invalidate selections in other open editors. Saved Album Tops are unchanged.',
        'Discard legacy preparations', () => latest.draft.maintainRemotePreparations({discardLegacy: true, confirmed: true}))}); check();
      close.update({label: 'Close current preparation', disabled: locked || waiting || !remote.preparation, onClick: () => {
        const ref = latest.value.remote?.preparation?.preparation_ref; if (!managementBusy() && ref) latest.draft.closeRemotePreparation(ref);
      }}); check();
      const messages = {loading: 'Preparing remote album…', in_flight: 'Preparation is still in progress. Use Retry preparation to check this same attempt.',
        failed: 'Remote preparation failed. Select the album again explicitly to start another attempt.',
        unknown: 'The preparation result is unknown. Retry the same attempt before starting another.', consumed: 'This acquisition was consumed. Only the membership receipt can confirm the saved change.',
        pending: value.sourceMatch ? 'Remote album selected. Confirm this match to use it for the source row.' : 'Remote album selected. Save your Album Top to add it.', closed: 'Preparation closed. Remove affected selections before choosing them again.',
        maintenance_required: 'Preparation maintenance is required. Choose a maintenance action below, then explicitly select the album again.',
        limit: 'Remote preparation capacity is full. Check preparation status and explicitly close or reclaim preparations.',
        unavailable: 'This preparation is unavailable. Reopen the editor if its private context changed.', confirmation_required: 'Confirm the preparation cleanup before continuing.',
        progress: 'Maintenance made progress. Run it again explicitly if more work remains.', complete: 'Preparation maintenance is complete.'};
      status.textContent = remote.retired ? 'Remote preparation is no longer available in this editor. Close and reopen it.'
        : remote.membershipRetired ? 'Album membership editing was retired for this editor. Your visible selections are preserved.'
          : messages[remote.status] || (remote.search?.status === 'loading' ? 'Searching remote albums…' : remote.search?.status === 'error'
            ? 'Remote search failed. Use Search remote albums to try again.' : remote.search?.status === 'ready' && !remote.search.candidates.length ? 'No matching remote albums.' : 'Search by album title and optionally artist.');
      const counts = remote.result?.capacity || remote.ownState?.capacity || remote.maintenance?.capacity || remote.preparation?.capacity;
      capacity.textContent = counts ? counts.counts_complete === false ? 'Preparation counts are incomplete. Run maintenance to initialize or reclaim them.'
        : Number.isSafeInteger(counts.worst_case_new_acquisitions) ? `Last observed capacity: ${counts.worst_case_new_acquisitions} additional remote acquisitions.` : 'Preparation status received.' : '';
      const wanted = new Set();
      for (const row of remote.search?.candidates || []) {
        const key = row.release_group_id; wanted.add(key); let item = candidates.get(key);
        if (!item) {
          const node = element(cards), card = element(node), note = element(node, 'p', 'playlists__note', 'Remote album summary · tracks unavailable');
          item = {node, card, note, row, html: null}; item.click = event => {if (!memberBlocked() && !item.selected && event.target.closest('[data-gallery-card-intent="select"]')) latest.draft.selectRemote(item.row);};
          card.addEventListener('click', item.click); candidates.set(key, item);
        }
        item.row = row; item.selected = value.items.some(item => item.release_group_id === key);
        const artwork = runtime.artboxHtml({state: 'empty', label: `${row.title} artwork unavailable`}); check();
        const html = runtime.galleryCardHtml({identity: key, actionRef: key, interaction: 'controlled', actions: {select: true}, title: row.title,
          artist: row.artist_display, year: row.first_release_date ? Number(row.first_release_date.slice(0, 4)) : null, displayMode: 'cards',
          artboxHtml: artwork}); check();
        if (html !== item.html) {item.card.innerHTML = html; item.html = html;}
        const control = item.card.querySelector('[data-gallery-card-intent="select"]');
        if (control) {control.disabled = memberBlocked() || item.selected || value.items.length >= (value.capacity ?? 5000); control.setAttribute('aria-disabled', String(control.disabled)); control.setAttribute('aria-label', `Select remote album ${row.title}`);}
        cards.append(item.node);
      }
      for (const [key, item] of candidates) if (!wanted.has(key)) {candidates.delete(key); item.card.removeEventListener('click', item.click); item.node.remove();}
      const wantedParents = new Set();
      for (const [index, row] of (remote.ownState?.parents || []).entries()) {
        const key = row.preparation_ref; wantedParents.add(key); let item = parents.get(key);
        if (!item) {const node = element(parentList), label = element(node, 'p', 'playlists__note');
          const control = mountButton(element(node), runtime, {label: 'Close saved preparation'});
          if (!currentPass()) {try {control.dispose();} finally {node.remove();} throw superseded;}
          item = {node, label, control}; parents.set(key, item);}
        item.label.textContent = `Preparation ${index + 1}: ${row.state}; ${row.pending_count} pending acquisitions.`;
        item.control.update({label: 'Close saved preparation', disabled: locked || waiting || typeof runtime.confirm !== 'function', onClick: () => confirmed(
          'Close this saved preparation? It may belong to another open editor and its unsaved selections will become unavailable. Saved Album Tops are unchanged.',
          'Close saved preparation', () => latest.draft.closeRemotePreparation(key, {confirmed: true}))}); check();
        parentList.append(item.node);
      }
      for (const [key, item] of parents) if (!wantedParents.has(key)) {parents.delete(key); item.node.remove(); item.control.dispose(); check();}
    }
    function update(next) {
      if (disposed) return; latest = {...next, blocked: next.blocked ?? next.disabled}; revision++;
      if (rendering) return; rendering = true;
      try {let observed; do {observed = revision; try {render(latest, observed);} catch (error) {if (error !== superseded) {try {dispose();} catch {} throw error;}}
      } while (!disposed && observed !== revision);} finally {rendering = false;}
    }
    redraw = update; update(props);
    return {update, dispose};
  } catch (error) {try {dispose();} catch {} throw error;}
}

export function mountAlbumPicker(host, runtime, {draft, providers = {}, value, disabled, blocked = disabled, readOnly = false, onOpenAlbum}) {
  const acquired = []; let acquiring = true, partialSection = null;
  const acquire = owner => {if (acquiring) acquired.push(owner); return owner;};
  try {
  const id = `album-top-picker-native-${++pickerId}`, source = {}, rows = new Map();
  let latest = {value, disabled, blocked}, disposed = false, pendingFocus = null, rendering = false, revision = 0;
  const superseded = Symbol('retired album picker render');
  const section = partialSection = element(host, 'section', 'album-top-builder__picker'); section.setAttribute('aria-label', 'Choose albums');
  const tabsHost = element(section), poolHost = element(section), searchHost = element(section), remoteHost = element(section), live = element(section, 'span', 'sr-only');
  const hasRemote = !readOnly && remotePickerAvailable(draft, providers);
  const pools = hasRemote ? acquire(mountTabs(poolHost, runtime, poolProps())) : null;
  const remote = hasRemote ? acquire(mountRemoteAlbumPicker(remoteHost, runtime, {draft, value, disabled, blocked})) : null;
  live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  const capacity = element(section, 'p', 'playlists__note', value.sourceMatch
    ? 'One album can be selected for this source row. Remove it before choosing another.'
    : 'The 5,000-album limit is reached. Remove an album before adding another.'); capacity.setAttribute('role', 'status');
  const scroll = element(section, 'div', 'album-top-builder__scroll gallery-scrollbar'); scroll.setAttribute('role', 'tabpanel');
  const cards = element(scroll, 'div', 'home-activity__cards album-top-builder__cards playlists__tracks');
  const empty = element(scroll, 'p', 'playlists__note'); empty.setAttribute('role', 'status');
  const retryHost = element(scroll), moreHost = element(scroll);
  const search = acquire(mountCreationSearch(searchHost, runtime, searchProps())), tabs = acquire(mountTabs(tabsHost, runtime, tabsProps()));
  const retry = acquire(mountButton(retryHost, runtime, {label: 'Retry search', onClick: () => {if (!readOnly) draft.setQuery(latest.value.query);}}));
  const more = acquire(mountButton(moreHost, runtime, {label: 'Load more albums', onClick: () => {if (!readOnly) draft.loadMore();}}));
  function searchProps() {return {id: `${id}-search`, value: latest.value.query, disabled: readOnly || latest.disabled, maxLength: 100, label: 'Search albums', placeholder: 'Search albums or artists', onChange: query => {if (!readOnly) draft.setQuery(query);}};}
  function poolProps() {return {id: `${id}-pools`, label: 'Album source', items: [['local', 'Local albums', {disabled: latest.disabled || latest.value.remote?.membershipRetired === true}], ['remote', 'Remote albums', {disabled: latest.disabled || latest.value.remote?.membershipRetired === true}]], value: latest.value.pool || 'local', onChange: pool => {if (!latest.disabled && !latest.value.remote?.membershipRetired) draft.setPool(pool);}};}
  function tabsProps() {return {id: `${id}-tabs`, label: 'Album selection', items: [...(readOnly ? [] : [['all', 'All']]), ['selected', `Selected (${latest.value.items.length})`]], value: readOnly ? 'selected' : latest.value.tab, onChange: tab => {if (!readOnly) draft.setTab(tab);}};}
  function remember(event, selector) {const button = event.target.closest('button'); if (cards.ownerDocument.activeElement === button) pendingFocus = {from: button, selector, index: [...cards.querySelectorAll(selector)].indexOf(button)};}
  const gesture = acquire(mountCollectionReorder(cards, {
    rowSelector: '[data-album-draft-key]', handleSelector: '[data-album-draft-move]', rowKeyAttribute: 'data-album-draft-key', layout: 'grid',
    collectionKey: () => latest.value.topRef || 'new-album-top', itemKey: draftRowKey,
    snapshot: () => {const current = draft.getSnapshot(); return {scopeKey: current.scopeKey, source, selectedRowKey: null,
      rows: current.items.map(row => ({...row, row_key: draftRowKey(row)})), itemsComplete: true, canEdit: !readOnly && !latest.disabled,
      canReorder: !readOnly && !latest.disabled && current.tab === 'selected', unfiltered: true, defaultOrder: true, busy: current.busy};},
    onReorder: refs => draft.reorder(refs), onAnnounce: text => {live.textContent = text;},
  }));
  const sameInputs = (before, next) => before?.length === next.length && next.every((value, index) => Object.is(value, before[index]));
  function render(next, version) {
    const currentPass = () => !disposed && revision === version;
    const check = () => {if (!currentPass()) throw superseded;};
    const {value, disabled} = next; check();
    search.update(searchProps()); check(); tabs.update(tabsProps()); check(); pools?.update(poolProps()); check();
    const showingRemote = hasRemote && value.pool === 'remote' && value.tab !== 'selected';
    poolHost.hidden = readOnly || value.tab === 'selected'; searchHost.hidden = readOnly || showingRemote || value.tab === 'selected'; remoteHost.hidden = !showingRemote;
    scroll.hidden = showingRemote;
    remote?.update({draft, value, disabled, blocked: latest.blocked ?? disabled}); check();
    const selected = readOnly || value.tab === 'selected', albums = selected ? value.items : value.search.items, atCapacity = value.items.length >= (value.capacity ?? 5000);
    capacity.hidden = readOnly || !atCapacity; scroll.setAttribute('aria-labelledby', `${id}-tabs-${readOnly ? 'selected' : value.tab}`); live.textContent = `${value.items.length} albums selected`;
    const wanted = new Set();
    albums.forEach((row, index) => {
      const key = `${selected ? 'selected' : 'search'}:${selected ? draftRowKey(row) : row.local_album_id}`; wanted.add(key);
      let item = rows.get(key);
      if (!item) {
        const root = element(cards), card = element(root); item = {root, card, row, selected, html: null, controls: []}; rows.set(key, item);
        try {
        const rowButton = (parent, props) => {const owner = mountButton(parent, runtime, props);
          if (!currentPass()) {owner.dispose(); throw superseded;} item.controls.push(owner); return acquire(owner);};
        if (selected && !readOnly) {
          root.setAttribute('data-album-draft-key', draftRowKey(row)); const actions = element(root, 'div', 'playlists__actions');
          item.move = rowButton(element(actions), {label: 'Move'}); item.remove = rowButton(element(actions), {label: 'Remove'});
        }
        item.click = event => {
          if (latest.disabled) return;
          if (readOnly && event.target.closest('[data-gallery-card-intent="open"]')) {onOpenAlbum?.(item.row); return;}
          if (!readOnly && !item.selected && latest.value.items.length < (latest.value.capacity ?? 5000) && event.target.closest('[data-gallery-card-intent="select"]')) {remember(event, '[data-gallery-card-intent="select"]'); draft.select(item.row);}
        };
        card.addEventListener('click', item.click);
        } catch (error) {
          if (rows.get(key) === item) rows.delete(key);
          card.removeEventListener('click', item.click); root.remove();
          for (const owner of item.controls) {try {owner.dispose();} catch {}}
          throw error;
        }
      }
      item.row = row;
      // Cache renderer inputs, never the current action row or authority. A row
      // can be replaced under its key while its display facts stay unchanged.
      const identity = selected ? draftRowKey(row) : String(row.local_album_id), actionRef = String(row.local_album_id || draftRowKey(row));
      const artist = [row.artist, row.source_kind === 'remote_summary' ? 'Remote album summary · tracks unavailable' : ''].filter(Boolean).join(' · ');
      const cardInputs = [runtime.galleryCardHtml, runtime.artboxHtml, identity, actionRef, selected, row.title, artist, row.year];
      if (!sameInputs(item.cardInputs, cardInputs)) {
        const artwork = runtime.artboxHtml({state: 'empty', label: `${row.title} artwork`}); check();
        const html = runtime.galleryCardHtml({identity, actionRef,
          interaction: readOnly || !selected ? 'controlled' : 'none', actions: {select: !selected, open: readOnly && typeof onOpenAlbum === 'function'}, title: row.title, artist, year: row.year, displayMode: 'cards',
          artboxHtml: artwork}); check();
        if (html !== item.html) {item.card.innerHTML = html; item.html = html;}
        item.cardInputs = cardInputs;
      }
      const control = item.card.querySelector('[data-gallery-card-intent="select"]');
      if (control) {control.disabled = disabled || atCapacity; control.setAttribute('aria-disabled', String(control.disabled));}
      const open = item.card.querySelector('[data-gallery-card-intent="open"]');
      if (open) {open.disabled = disabled; open.setAttribute('aria-disabled', String(disabled));}
      if (selected && !readOnly) {
        const controlInputs = [runtime.buttonHtml, disabled, row.title];
        if (!sameInputs(item.controlInputs, controlInputs)) {
          item.move.update({label: 'Move', size: 'small', disabled, attributes: {'data-album-draft-move': '', 'aria-label': `Reorder ${row.title}`}}); check();
          item.remove.update({label: 'Remove', size: 'small', disabled, ariaLabel: `Remove ${row.title}`, attributes: {'data-album-draft-remove': ''}, onClick: event => {remember(event, '[data-album-draft-remove]'); draft.remove(draftRowKey(item.row));}}); check();
          item.controlInputs = controlInputs;
        }
      }
      if (cards.children[index] !== item.root) cards.insertBefore(item.root, cards.children[index] || null);
    });
    for (const [key, item] of rows) if (!wanted.has(key)) {rows.delete(key); item.card.removeEventListener('click', item.click); item.root.remove();
      let failure; for (const owner of item.controls) {try {owner.dispose();} catch (error) {failure ??= error;}}
      if (failure) throw failure; check();}
    empty.hidden = albums.length > 0; empty.textContent = selected ? 'No albums selected.' : value.search.status === 'loading' ? 'Searching albums…' : value.query.trim() ? 'No matching albums on this page.' : 'Type an album or artist to search.';
    retryHost.hidden = selected || value.search.status !== 'error'; retry.update({label: 'Retry search', disabled, onClick: () => {if (!readOnly) draft.setQuery(latest.value.query);}}); check();
    moreHost.hidden = selected || !value.search.next_cursor; more.update({label: 'Load more albums', disabled: disabled || value.search.status === 'loading', onClick: () => {if (!readOnly) draft.loadMore();}}); check(); gesture.update(); check();
    if (pendingFocus && !value.busy) {const pending = pendingFocus; pendingFocus = null; const active = cards.ownerDocument.activeElement;
      if (!disabled && (!active || active === cards.ownerDocument.body || active === pending.from)) {const controls = [...cards.querySelectorAll(pending.selector)].filter(node => !node.disabled);
        (pending.from.isConnected && !pending.from.disabled ? pending.from : controls[Math.min(pending.index, controls.length - 1)] || section.querySelector('[role="tab"][aria-selected="true"]'))?.focus({preventScroll: true});}}
  }
  function dispose() {
    if (disposed) return; disposed = true; revision++;
    const controls = [gesture, search, tabs, pools, remote, retry, more].filter(Boolean);
    for (const item of rows.values()) {controls.push(...item.controls); item.card.removeEventListener('click', item.click);}
    rows.clear(); section.remove();
    let failure; for (const owner of controls) {try {owner.dispose();} catch (error) {failure ??= error;}}
    if (failure) throw failure;
  }
  function update(next) {
    if (disposed) return; latest = {...next, disabled: next.disabled || next.value.remote?.retired === true || next.value.remote?.membershipRetired === true}; revision++;
    if (rendering) return; rendering = true;
    try {let observed; do {observed = revision; try {render(latest, observed);} catch (error) {if (error !== superseded) {try {dispose();} catch {} throw error;}}
    } while (!disposed && observed !== revision);} finally {rendering = false;}
  }
  update(latest); acquiring = false; acquired.length = 0;
  return {update, dispose};
  } catch (error) {for (const owner of acquired.reverse()) {try {owner.dispose?.();} catch {}} partialSection?.remove(); throw error;}
}

function mountEditor(host, runtime, options, inline, close) {
  const acquired = []; let acquiring = true, partialForm = null, partialDraft = null, partialRelease = null, partialUnsubscribe = null;
  const acquire = owner => {if (acquiring) acquired.push(owner); return owner;};
  try {
  const {controller, providers = {}, existing = null, mountHeader, onRestoreFocus} = options;
  let state = options.state, disposed = false, expanded = Boolean(existing?.items?.length), closeError = false, releaseOwner = null,
    guardReady = !inline, guardUnavailable = false, focused = false, closedRequest = null, picker = null;
  const initialMutation = state.mutation, draft = partialDraft = createAlbumTopDraft({controller, providers});
  let value = draft.getSnapshot(), access = draftAccess(state, value, existing);
  const form = partialForm = element(host, 'form', inline ? 'album-top-inline-edit album-top-builder' : 'playlists__form tag-editor-form album-top-builder');
  form.setAttribute('aria-label', existing ? 'Edit Album Top' : 'Create Album Top');
  const fields = form.ownerDocument.createElement('div'); fields.className = 'album-top-builder__identity tag-editor-form';
  const inputs = [];
  for (const [name, key, label, max] of [['top-name', 'title', 'Name', 100], ['top-subtitle', 'description', 'Subtitle', 200]]) {
    const wrapper = element(fields, 'label'); if (!inline) element(wrapper, 'span', '', label);
    const input = element(wrapper, 'input'); input.name = name; input.setAttribute('aria-label', `Album Top ${key === 'title' ? 'name' : 'subtitle'}`); input.maxLength = max; input.required = key === 'title';
    const change = () => draft.edit({[key]: input.value}); input.addEventListener('input', change); inputs.push({input, key, change});
  }
  const actions = form.ownerDocument.createElement('div'); actions.className = 'playlists__actions';
  const saveHost = element(actions), cancelHost = element(actions);
  const save = acquire(mountButton(saveHost, runtime, {label: existing ? 'Save' : 'Create Album Top', type: 'submit', variant: 'primary'}));
  const cancelButton = acquire(mountButton(cancelHost, runtime, {label: 'Cancel', onClick: () => cancel()}));
  const header = inline ? acquire(mountHeader(form, {fields, actions, busy: access.busy, cancel})) : null;
  if (!inline) form.append(fields);
  const content = element(form, 'div', inline ? 'album-top-inline-edit__content' : '');
  const findHost = element(content), pickerHost = element(content), unavailable = element(content, 'p', 'playlists__note'), errors = element(content), noticeHost = element(content);
  const find = acquire(mountButton(findHost, runtime, {label: 'Find albums', onClick: () => {expanded = !expanded; render();}}));
  const notice = acquire(mountMutationNotice(noticeHost, runtime, {controller, value: state.mutation}));
  if (!inline) form.append(actions);
  const acknowledgedSave = current => {const mutation = current.mutation; return mutation !== initialMutation && mutation.status === 'ready' && mutation.action === 'save'
    && mutation.command?.top_ref === existing.top_ref && mutation.command.revision === existing.revision
    && mutation.data?.top_ref === existing.top_ref && mutation.data.request_key === mutation.command.request_key;};
  function currentGuard() {
    const snapshot = draft.getSnapshot(), current = controller.getSnapshot();
    if (disposed || snapshot.denied || current.scopeKey !== snapshot.scopeKey || current.selectedTopRef !== existing.top_ref || current.directory.status === 'denied' || current.detail.status === 'denied') return false;
    const saved = acknowledgedSave(current);
    if (saved && current.mutation.refreshing === true && current.detail.status === 'loading') return true;
    return albumTopActionAllowed(current, 'save', existing.top_ref) && (saved ? current.detail.data?.revision === current.mutation.data.revision : !snapshot.stale && current.detail.data?.revision === existing.revision);
  }
  function canLeave() {return currentGuard() && !draft.getSnapshot().busy && controller.getSnapshot().mutation.refreshing !== true && !['loading', 'uncertain'].includes(controller.getSnapshot().mutation.status);}
  if (inline) {
    const release = typeof runtime.deferDraftNavigation === 'function' && runtime.registerDraftNavigation?.({isCurrent: currentGuard,
      confirmLeave: async confirm => {if (!canLeave()) return false; if (!draft.getSnapshot().dirty) return true;
        return await confirm('Discard these unsaved Album Top changes?', {title: 'Discard Album Top changes', acceptLabel: 'Discard', danger: true}) === true && canLeave();},
      onDiscard: () => {draft.dispose(); options.onClose();}});
    if (typeof release === 'function') {releaseOwner = partialRelease = release; guardReady = true;} else guardUnavailable = true;
  }
  async function cancel({restoreFocus = true} = {}) {
    if (disposed || access.busy) return false;
    if (!inline) return close();
    if (!guardReady) {options.onClose({restoreFocus}); return true;}
    return await runtime.deferDraftNavigation(() => {if (restoreFocus) onRestoreFocus?.(); return true;}) === true;
  }
  const submit = event => {event.preventDefault(); if (!disposed && !access.disabled && guardReady) draft.submit();}; form.addEventListener('submit', submit);
  function render() {
    if (disposed) return; value = draft.getSnapshot(); access = draftAccess(state, value, existing);
    const saved = inline && acknowledgedSave(state);
    if (inline && (access.stale && !saved || value.denied)) {releaseOwner?.(); releaseOwner = null; guardReady = false;}
    const disabled = access.disabled || !guardReady;
    form.setAttribute('aria-busy', String(access.busy));
    inputs.forEach(({input, key}) => {if (input.value !== value[key]) input.value = value[key]; input.disabled = disabled;});
    save.update({label: existing ? 'Save' : 'Create Album Top', type: 'submit', variant: 'primary', disabled: disabled || !value.title.trim() || Boolean(existing && !value.dirty)});
    cancelButton.update({label: 'Cancel', disabled: access.busy, onClick: () => cancel()});
    header?.update({fields, actions, busy: access.busy, cancel});
    // The parent controller listener can render before the draft listener marks
    // membership retirement. Keep an acquired picker through that notification
    // order; a newly opened Manage-only editor still never acquires one.
    const hasPicker = pickerAvailable(runtime, providers), showPicker = hasPicker
      && (access.membershipAllowed || Boolean(picker)) && (inline || expanded);
    findHost.hidden = inline || !hasPicker || !access.membershipAllowed;
    find.update({label: 'Find albums', disabled, selected: expanded, onClick: () => {expanded = !expanded; render();}});
    if (showPicker) {const blocked = access.stale || value.denied || !guardReady || state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status)
      || !albumTopActionAllowed(state, existing ? 'save' : 'create', existing?.top_ref);
      const membershipDisabled = disabled || !access.membershipAllowed;
      if (picker) picker.update({value, disabled: membershipDisabled, blocked}); else picker = acquire(mountAlbumPicker(pickerHost, runtime, {draft, providers, value, disabled: membershipDisabled, blocked}));}
    else {picker?.dispose(); picker = null;}
    unavailable.hidden = inline ? hasPicker && access.membershipAllowed : hasPicker;
    unavailable.textContent = inline ? 'Album membership is unavailable for editing. Your existing selection is preserved.' : 'Album selection is unavailable from this provider.';
    errors.replaceChildren();
    const alert = (severity, message) => {element(errors).innerHTML = runtime.alertHtml({severity, role: severity === 'error' ? 'alert' : 'status', message});};
    if (guardUnavailable) alert('error', 'Editing is unavailable because navigation protection could not be started. Cancel and reopen this Top.');
    if (value.remote?.retired) alert('info', 'This editor’s private source changed. Close and reopen it to continue; your visible selection has been preserved.');
    else if (value.remote?.membershipRetired) alert('info', 'Album membership editing was retired for this editor. Metadata-only changes remain available when permitted.');
    if (value.error) alert('error', albumTopDraftErrorMessage(value.error) || value.error.message || 'These changes could not be prepared. Your draft is preserved.');
    if (closeError) alert('error', 'The Top was saved, but this form could not return to its parent. Close it to continue.');
    if (access.stale && !saved) alert('info', inline ? 'This Top changed. Your draft is preserved; cancel and reopen it to review the current values.' : 'This Top changed. Your draft is preserved; close and reopen it to review the current values.');
    notice.update({controller, value: state.mutation}); options.onAccess?.(access);
    if (inline && guardReady && !focused) {focused = true; inputs[0].input.focus({preventScroll: true});}
    if (inline) {
      if (value.denied || state.scopeKey !== value.scopeKey || state.selectedTopRef !== existing.top_ref) {options.onClose(); return;}
      if (saved && !state.mutation.refreshing) options.onClose({restoreFocus: true});
    } else if (state.mutation !== initialMutation && state.mutation.status === 'ready' && state.mutation.action === (existing ? 'save' : 'create') && closedRequest !== state.mutation.command?.request_key) {
      closedRequest = state.mutation.command?.request_key; const receipt = state.mutation.data;
      Promise.resolve(close({force: true, restoreFocus: true})).then(closed => {if (closed !== false) options.onFormSaved?.(receipt); else if (!disposed) {closeError = true; render();}}).catch(() => {if (!disposed) {closeError = true; render();}});
    }
  }
  const unsubscribe = partialUnsubscribe = draft.subscribe(render); render(); acquiring = false; acquired.length = 0;
  return {update(next) {state = next.state; render();}, beforeDismiss: () => access.busy ? false : draft.getSnapshot().dirty
    ? runtime.confirm('Discard these unsaved Album Top changes?', {title: 'Discard Album Top changes', acceptLabel: 'Discard', danger: true}) : true,
    dispose() {if (disposed) return; disposed = true; unsubscribe(); releaseOwner?.(); draft.dispose(); picker?.dispose(); header?.dispose(); find.dispose(); notice.dispose(); save.dispose(); cancelButton.dispose(); form.removeEventListener('submit', submit); inputs.forEach(({input, change}) => input.removeEventListener('input', change)); form.remove();}};
  } catch (error) {partialUnsubscribe?.(); partialRelease?.(); partialDraft?.dispose(); for (const owner of acquired.reverse()) {try {owner.dispose?.();} catch {}} partialForm?.remove(); throw error;}
}

export function mountInlineAlbumTopEdit(host, runtime, options) {return mountEditor(host, runtime, options, true);}
export function openAlbumTopBuilder({runtime, ...options}) {
  let editor = null, dialog = null, busy = false;
  const dialogOptions = () => ({title: options.existing ? 'Edit Album Top' : 'Create Album Top', pageId: options.existing ? 'album-top-edit' : 'album-top-create',
    returnFocus: options.returnFocus, showCloseButton: true, dismissDisabled: busy, beforeDismiss: () => editor?.beforeDismiss() ?? false});
  dialog = openNativeDialog(runtime, dialogOptions(), {fallbackHost: options.fallbackHost, mount(host, close) {editor = mountEditor(host, runtime, {...options, onAccess: access => {busy = access.busy; dialog?.update(dialogOptions());}}, false, close); return editor;}, onClose: options.onClose});
  return {update(next) {editor?.update(next); dialog.update(dialogOptions());}, dispose() {dialog.dispose();}};
}

// AT-R10: the same picker in an add-only native dialog. No metadata editor,
// second membership store, fake capability, or navigation owner is introduced.
export function openAddAlbumTop({runtime, ...options}) {
  let editor = null, dialog = null;
  const dialogOptions = () => ({title: 'Add albums', pageId: 'album-top-add', showCloseButton: true,
    returnFocus: options.returnFocus, beforeDismiss: () => editor?.beforeDismiss() ?? false,
    dismissDisabled: editor?.busy() ?? false});
  dialog = openNativeDialog(runtime, dialogOptions(), {fallbackHost: options.fallbackHost,
    mount(host, close) {
      let disposed = false, state = options.state, closingKey = null, closeError = false, rendering = false, queued = false;
      const {controller, providers = {}} = options, source = state.detail.data, initialMutation = state.mutation;
      const draft = createAlbumTopDraft({controller, providers, mode: 'add'}), acquired = [];
      let form, unsubscribe;
      const own = owner => {acquired.push(owner); return owner;};
      const busy = () => draft.getSnapshot().busy || state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
      const dispose = () => {if (disposed) return; disposed = true; unsubscribe?.(); draft.dispose();
        form?.removeEventListener('submit', submit); let failure;
        for (const owner of acquired.reverse()) {try {owner.dispose();} catch (error) {failure ??= error;}}
        form?.remove(); if (failure) throw failure;};
      const submit = event => {event.preventDefault(); if (!disposed && pickerAvailable(runtime, providers)) draft.submit();};
      try {
        form = element(host, 'form', 'album-top-builder album-top-add'); form.setAttribute('aria-label', 'Add albums');
        const subtitle = element(form, 'p', 'playlists__note', source.title);
        const pickerHost = element(form), statusHost = element(form), noticeHost = element(form), actions = element(form, 'div', 'playlists__actions');
        const available = pickerAvailable(runtime, providers);
        const picker = available ? own(mountAlbumPicker(pickerHost, runtime, {draft, providers, value: draft.getSnapshot(), disabled: false})) : null;
        const notice = own(mountMutationNotice(noticeHost, runtime, {controller, value: state.mutation}));
        const add = own(mountButton(element(actions), runtime, {label: 'Add albums', type: 'submit', variant: 'primary'}));
        const cancel = own(mountButton(element(actions), runtime, {label: 'Cancel', onClick: () => close()}));
        function render() {
          if (disposed) return; queued = true; if (rendering) return; rendering = true;
          try {while (queued && !disposed) {
            queued = false; const value = draft.getSnapshot(), mutation = state.mutation, locked = busy();
            const invalid = value.stale || value.denied || value.remote?.retired === true || value.remote?.membershipRetired === true || state.scopeKey !== value.scopeKey || state.selectedTopRef !== value.topRef;
            const acknowledged = mutation !== initialMutation && mutation.status === 'ready' && mutation.action === 'add'
              && value.submittedRequestKey && mutation.command?.request_key === value.submittedRequestKey
              && mutation.command?.top_ref === source.top_ref && mutation.command?.revision === source.revision
              && mutation.data?.top_ref === source.top_ref && mutation.data?.request_key === mutation.command?.request_key;
            subtitle.textContent = value.denied ? '' : source.title;
            form.setAttribute('aria-busy', String(locked));
            picker?.update({value, disabled: locked || invalid || acknowledged, blocked: invalid || acknowledged || mutation.refreshing === true || ['loading', 'uncertain'].includes(mutation.status)});
            add.update({label: 'Add albums', type: 'submit', variant: 'primary', disabled: !available || locked || invalid || acknowledged || !value.items.length});
            cancel.update({label: 'Cancel', disabled: locked, onClick: () => close()});
            notice.update({controller, value: mutation});
            const message = closeError ? 'The albums were added, but this form could not return to its parent. Close it to continue.'
              : value.denied ? 'This Album Top is no longer available.'
                : value.remote?.retired || value.remote?.membershipRetired ? 'This album selection is no longer editable. Close and reopen Add albums before submitting.'
                  : value.stale ? 'This Top changed. Close and reopen Add albums before submitting.'
                  : !available ? 'Album selection is unavailable from this provider.'
                    : value.error ? albumTopDraftErrorMessage(value.error) || 'These albums could not be prepared. Your selection is preserved.' : '';
            statusHost.innerHTML = message ? runtime.alertHtml({severity: closeError || value.error ? 'error' : 'info', role: closeError || value.error ? 'alert' : 'status', message}) : '';
            dialog?.update(dialogOptions());
            if (acknowledged && !locked && !mutation.refreshing && closingKey !== mutation.command.request_key) {
              closingKey = mutation.command.request_key;
              Promise.resolve(close({force: true, restoreFocus: true})).then(result => {if (result === false && !disposed) {closeError = true; render();}},
                () => {if (!disposed) {closeError = true; render();}});
            }
          }} finally {rendering = false;}
        }
        unsubscribe = draft.subscribe(render); form.addEventListener('submit', submit); render();
        editor = {update(next) {if (!disposed) {state = next.state; render();}}, busy,
          async beforeDismiss() {
            if (disposed || busy()) return false;
            if (draft.getSnapshot().dirty && !closingKey) {
              const accepted = await runtime.confirm('Discard these selected albums?', {title: 'Discard Album Top changes', acceptLabel: 'Discard', danger: true});
              return accepted === true && !disposed && !busy();
            }
            return true;
          },
          dispose};
        return editor;
      } catch (error) {dispose(); throw error;}
    }, onClose: options.onClose});
  return {update(next) {editor?.update(next); dialog.update(dialogOptions());}, dispose() {dialog.dispose();}};
}
