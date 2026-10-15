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
  return {busy, stale, disabled: busy || stale || value.denied || !allowed, membershipAllowed};
}
const pickerAvailable = (runtime, providers) => typeof providers.searchAlbums === 'function' && typeof providers.admitAlbum === 'function'
  && typeof runtime.searchHtml === 'function' && typeof runtime.tabsHtml === 'function' && typeof runtime.mountTabs === 'function';
export function mountAlbumPicker(host, runtime, {draft, value, disabled}) {
  const acquired = []; let acquiring = true, partialSection = null;
  const acquire = owner => {if (acquiring) acquired.push(owner); return owner;};
  try {
  const id = `album-top-picker-native-${++pickerId}`, source = {}, rows = new Map();
  let latest = {value, disabled}, disposed = false, pendingFocus = null;
  const section = partialSection = element(host, 'section', 'album-top-builder__picker'); section.setAttribute('aria-label', 'Choose albums');
  const searchHost = element(section), tabsHost = element(section), live = element(section, 'span', 'sr-only');
  live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite');
  const capacity = element(section, 'p', 'playlists__note', 'The 5,000-album limit is reached. Remove an album before adding another.'); capacity.setAttribute('role', 'status');
  const scroll = element(section, 'div', 'album-top-builder__scroll gallery-scrollbar'); scroll.setAttribute('role', 'tabpanel');
  const cards = element(scroll, 'div', 'home-activity__cards album-top-builder__cards playlists__tracks');
  const empty = element(scroll, 'p', 'playlists__note'); empty.setAttribute('role', 'status');
  const retryHost = element(scroll), moreHost = element(scroll);
  const search = acquire(mountCreationSearch(searchHost, runtime, searchProps())), tabs = acquire(mountTabs(tabsHost, runtime, tabsProps()));
  const retry = acquire(mountButton(retryHost, runtime, {label: 'Retry search', onClick: () => draft.setQuery(latest.value.query)}));
  const more = acquire(mountButton(moreHost, runtime, {label: 'Load more albums', onClick: () => draft.loadMore()}));
  function searchProps() {return {id: `${id}-search`, value: latest.value.query, disabled: latest.disabled, maxLength: 100, label: 'Search albums', placeholder: 'Search albums or artists', onChange: query => draft.setQuery(query)};}
  function tabsProps() {return {id: `${id}-tabs`, label: 'Album selection', items: [['all', 'All'], ['selected', `Selected (${latest.value.items.length})`]], value: latest.value.tab, onChange: tab => draft.setTab(tab)};}
  function remember(event, selector) {const button = event.target.closest('button'); if (cards.ownerDocument.activeElement === button) pendingFocus = {from: button, selector, index: [...cards.querySelectorAll(selector)].indexOf(button)};}
  const gesture = acquire(mountCollectionReorder(cards, {
    rowSelector: '[data-album-draft-key]', handleSelector: '[data-album-draft-move]', rowKeyAttribute: 'data-album-draft-key', layout: 'grid',
    collectionKey: () => latest.value.topRef || 'new-album-top', itemKey: row => row.album_ref,
    snapshot: () => {const current = draft.getSnapshot(); return {scopeKey: current.scopeKey, source, selectedRowKey: null,
      rows: current.items.map(row => ({...row, row_key: row.album_ref})), itemsComplete: true, canEdit: !latest.disabled,
      canReorder: !latest.disabled && current.tab === 'selected', unfiltered: true, defaultOrder: true, busy: current.busy};},
    onReorder: refs => draft.reorder(refs), onAnnounce: text => {live.textContent = text;},
  }));
  const sameInputs = (before, next) => before?.length === next.length && next.every((value, index) => Object.is(value, before[index]));
  function update(next) {
    if (disposed) return; latest = next; const {value, disabled} = latest;
    search.update(searchProps()); tabs.update(tabsProps());
    const selected = value.tab === 'selected', albums = selected ? value.items : value.search.items, atCapacity = value.items.length >= 5000;
    capacity.hidden = !atCapacity; scroll.setAttribute('aria-labelledby', `${id}-tabs-${value.tab}`); live.textContent = `${value.items.length} albums selected`;
    const wanted = new Set();
    albums.forEach((row, index) => {
      const key = `${selected ? 'selected' : 'search'}:${selected ? row.album_ref : row.local_album_id}`; wanted.add(key);
      let item = rows.get(key);
      if (!item) {
        const root = element(cards), card = element(root); item = {root, card, row, selected, html: null, controls: []};
        if (selected) {
          root.setAttribute('data-album-draft-key', row.album_ref); const actions = element(root, 'div', 'playlists__actions');
          item.move = acquire(mountButton(element(actions), runtime, {label: 'Move'})); item.remove = acquire(mountButton(element(actions), runtime, {label: 'Remove'})); item.controls.push(item.move, item.remove);
        }
        item.click = event => {if (!latest.disabled && !item.selected && latest.value.items.length < 5000 && event.target.closest('[data-gallery-card-intent="select"]')) {remember(event, '[data-gallery-card-intent="select"]'); draft.select(item.row);}};
        card.addEventListener('click', item.click); rows.set(key, item);
      }
      item.row = row;
      // Cache renderer inputs, never the current action row or authority. A row
      // can be replaced under its key while its display facts stay unchanged.
      const identity = selected ? row.album_ref : String(row.local_album_id), actionRef = String(row.local_album_id || row.album_ref);
      const cardInputs = [runtime.galleryCardHtml, runtime.artboxHtml, identity, actionRef, selected, row.title, row.artist, row.year];
      if (!sameInputs(item.cardInputs, cardInputs)) {
        const html = runtime.galleryCardHtml({identity, actionRef,
          interaction: selected ? 'none' : 'controlled', actions: {select: !selected}, title: row.title, artist: row.artist, year: row.year, displayMode: 'cards',
          artboxHtml: runtime.artboxHtml({state: 'empty', label: `${row.title} artwork`})});
        if (html !== item.html) {item.card.innerHTML = html; item.html = html;}
        item.cardInputs = cardInputs;
      }
      const control = item.card.querySelector('[data-gallery-card-intent="select"]');
      if (control) {control.disabled = disabled || atCapacity; control.setAttribute('aria-disabled', String(control.disabled));}
      if (selected) {
        const controlInputs = [runtime.buttonHtml, disabled, row.title];
        if (!sameInputs(item.controlInputs, controlInputs)) {
          item.move.update({label: 'Move', size: 'small', disabled, attributes: {'data-album-draft-move': '', 'aria-label': `Reorder ${row.title}`}});
          item.remove.update({label: 'Remove', size: 'small', disabled, ariaLabel: `Remove ${row.title}`, attributes: {'data-album-draft-remove': ''}, onClick: event => {remember(event, '[data-album-draft-remove]'); draft.remove(item.row.album_ref);}});
          item.controlInputs = controlInputs;
        }
      }
      if (cards.children[index] !== item.root) cards.insertBefore(item.root, cards.children[index] || null);
    });
    for (const [key, item] of rows) if (!wanted.has(key)) {item.controls.forEach(owner => owner.dispose()); item.card.removeEventListener('click', item.click); item.root.remove(); rows.delete(key);}
    empty.hidden = albums.length > 0; empty.textContent = selected ? 'No albums selected.' : value.search.status === 'loading' ? 'Searching albums…' : value.query.trim() ? 'No matching albums on this page.' : 'Type an album or artist to search.';
    retryHost.hidden = selected || value.search.status !== 'error'; retry.update({label: 'Retry search', disabled, onClick: () => draft.setQuery(latest.value.query)});
    moreHost.hidden = selected || !value.search.next_cursor; more.update({label: 'Load more albums', disabled: disabled || value.search.status === 'loading', onClick: () => draft.loadMore()}); gesture.update();
    if (pendingFocus && !value.busy) {const pending = pendingFocus; pendingFocus = null; const active = cards.ownerDocument.activeElement;
      if (!disabled && (!active || active === cards.ownerDocument.body || active === pending.from)) {const controls = [...cards.querySelectorAll(pending.selector)].filter(node => !node.disabled);
        (pending.from.isConnected && !pending.from.disabled ? pending.from : controls[Math.min(pending.index, controls.length - 1)] || section.querySelector('[role="tab"][aria-selected="true"]'))?.focus({preventScroll: true});}}
  }
  update(latest); acquiring = false; acquired.length = 0;
  return {update, dispose() {if (disposed) return; disposed = true; gesture.dispose(); search.dispose(); tabs.dispose(); retry.dispose(); more.dispose(); for (const item of rows.values()) {item.controls.forEach(owner => owner.dispose()); item.card.removeEventListener('click', item.click);} rows.clear(); section.remove();}};
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
    const hasPicker = pickerAvailable(runtime, providers), showPicker = hasPicker && access.membershipAllowed && (inline || expanded);
    findHost.hidden = inline || !hasPicker || !access.membershipAllowed;
    find.update({label: 'Find albums', disabled, selected: expanded, onClick: () => {expanded = !expanded; render();}});
    if (showPicker) {if (picker) picker.update({value, disabled}); else picker = acquire(mountAlbumPicker(pickerHost, runtime, {draft, value, disabled}));}
    else {picker?.dispose(); picker = null;}
    unavailable.hidden = inline ? hasPicker && access.membershipAllowed : hasPicker;
    unavailable.textContent = inline ? 'Album membership is unavailable for editing. Your existing selection is preserved.' : 'Album selection is unavailable from this provider.';
    errors.replaceChildren();
    const alert = (severity, message) => {element(errors).innerHTML = runtime.alertHtml({severity, role: severity === 'error' ? 'alert' : 'status', message});};
    if (guardUnavailable) alert('error', 'Editing is unavailable because navigation protection could not be started. Cancel and reopen this Top.');
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
