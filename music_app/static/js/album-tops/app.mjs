import {mountButton, mountStatus} from '../home-friends/native-controls.mjs';
import {mountAlbumProgress} from '../home-friends/album-progress.mjs';
import {mountSharedHeader} from '../home-friends/shared-header.mjs';
import {albumTopActionAllowed} from './model.mjs';
import {isManualProgress, isTopActivity} from './progress.mjs';
import {openShareAlbumTop} from './sharing.mjs';
import {openAlbumTopBuilder, openAddAlbumTop, mountInlineAlbumTopEdit} from './builder.mjs';
import {albumTopAddAllowed} from './draft.mjs';
import {mountMutationNotice} from './mutation-notice.mjs';
function node(parent, tag = 'div', className = '') {const result = parent.ownerDocument.createElement(tag); result.className = className; parent.append(result); return result;}
export function mountAlbumTopsView(host, runtime, props) {
  const {controller, providers} = props;
  let latest = props, disposed = false, dialog = null, dialogIntent = null, inline = null, normalHeader = null, restoreFocus = false, dialogToken = null, updating = false, pending = null;
  const section = node(host, 'section', 'album-tops'); section.setAttribute('aria-label', 'Album Tops');
  const normal = node(section), headerHost = node(normal), description = node(normal, 'p'), statusHost = node(normal), empty = node(normal), cards = node(normal, 'div', 'home-activity__cards home-activity__cards--albums'), noticeHost = node(normal), editHost = node(section);
  const status = mountStatus(statusHost, runtime, {value: latest.state.directory, label: 'Album Tops', retry: () => controller.load()});
  const notice = mountMutationNotice(noticeHost, runtime, {controller, value: latest.state.mutation});
  const cardOwners = new Map(), consumedShareRequests = new WeakSet();
  const failureHost = node(section); failureHost.setAttribute('data-album-top-dialog-fallback', '');
  function retireDialog() {const previous = dialog; dialog = null; dialogToken = null; previous?.dispose();}
  function returnHeaderFocus(preferred) {return [preferred, headerHost.querySelector('[data-header-tools]'), headerHost.querySelector('[data-shared-header]')].find(item => item?.isConnected && !item.disabled && item.getAttribute('aria-disabled') !== 'true' && !item.closest('[hidden],[inert],[aria-hidden="true"]') && item.getClientRects().length > 0);}
  function closeDialog(options) {dialogIntent = null; retireDialog(); if (inline) {const previousInline = inline; inline = null; previousInline.dispose();} restoreFocus ||= options?.restoreFocus === true; update(latest);}
  function show(kind, top, opener) {if (disposed) return; dialogIntent = {kind, top, topRef: top?.top_ref || latest.state.selectedTopRef, opener, providers: latest.providers, scopeKey: latest.state.scopeKey}; update(latest);}
  function createHeader(parent, edit = null) {
    const target = parent === headerHost ? parent : node(parent);
    const owner = mountSharedHeader(target, runtime, {id: 'album-tops', tabIndex: -1, ariaLabel: 'Album Tops header', className: 'album-tops__header'});
    const controls = new Map(); let currentEdit = edit;
    const context = node(owner.slots.content, 'div', 'gallery-bar__context'), title = node(context, 'div', 'gallery-bar__title'), titleText = node(title, 'span');
    const progressHost = node(context, 'span'), progressOwner = mountAlbumProgress(progressHost);
    function control(key, label, options, leading = false) {let item = controls.get(key); if (!item) {const host = node(leading ? owner.slots.leading : owner.slots.actions, 'span'); item = {host, owner: mountButton(host, runtime, {label, ...options})}; controls.set(key, item);} else item.owner.update({label, ...options}); item.host.hidden = false;}
    function refresh(nextEdit = currentEdit) {
      currentEdit = nextEdit; const {state, onOpen} = latest, selected = state.selectedTopRef, detail = state.detail.data;
      progressHost.hidden = !selected || Boolean(currentEdit);
      progressOwner.update({summary: state.scopeKey && selected && detail?.top_ref === selected
        && state.directory.status !== 'denied' && state.detail.status === 'ready' ? detail.completion_summary : null,
        label: 'Manually completed albums in this Top'});
      const busy = state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
      for (const item of controls.values()) item.host.hidden = true;
      if (selected) control('back', 'Back', {icon: 'back', disabled: currentEdit?.busy === true, onClick: async () => {if (!currentEdit || await currentEdit.cancel({restoreFocus: false})) onOpen(null);}}, true);
      if (currentEdit) {if (title.firstChild !== currentEdit.fields) title.replaceChildren(currentEdit.fields); if (currentEdit.actions.parentNode !== owner.slots.actions) owner.slots.actions.append(currentEdit.actions);}
      else {
        if (title.firstChild !== titleText) title.replaceChildren(titleText);
        titleText.textContent = selected && detail ? detail.title : 'Album Tops';
        if (!selected && albumTopActionAllowed(state, 'create')) control('create', 'Create Album Top', {icon: 'add', disabled: busy, onClick: event => {if (albumTopActionAllowed(controller.getSnapshot(), 'create')) show('create', null, event.target.closest('button'));}});
        const guarded = action => {const current = controller.getSnapshot(); return current.detail.data === detail && albumTopActionAllowed(current, action, detail?.top_ref);};
        if (selected && albumTopActionAllowed(state, 'set_activity')) {
          const active = detail.top_viewer_overlay.activity.active;
          control('activity', active ? 'Deactivate Album Top' : 'Activate Album Top', {icon: active ? 'pause' : 'bolt', disabled: busy,
            onClick: () => {if (guarded('set_activity')) controller.mutate('set_activity', {active: !active});}});
        }
        if (selected && albumTopAddAllowed(state)) control('add', 'Add albums', {icon: 'add', disabled: busy, onClick: event => {if (guarded('add') && albumTopAddAllowed(controller.getSnapshot())) show('add', detail, event.target.closest('button'));}});
        if (selected && albumTopActionAllowed(state, 'save')) control('edit', 'Edit Album Top', {icon: 'edit', disabled: busy, onClick: event => {if (guarded('save')) show('edit', detail, event.target.closest('button'));}});
        if (selected && albumTopActionAllowed(state, 'view_sharing')) control('share', 'Share', {icon: 'share', disabled: busy, onClick: event => {if (guarded('view_sharing')) show('share', detail, event.target.closest('button'));}});
        if (selected && albumTopActionAllowed(state, 'copy')) control('copy', 'Save a copy', {icon: 'save', disabled: busy, onClick: () => {if (guarded('copy')) controller.mutate('copy');}});
        if (selected && albumTopActionAllowed(state, 'delete')) control('delete', 'Delete Album Top', {icon: 'delete', disabled: busy, onClick: async () => {const current = controller.getSnapshot(); if (!guarded('delete')) return;
          if (await runtime.confirm(`Delete “${detail.title}”?`, {title: 'Delete Album Top', acceptLabel: 'Delete', danger: true}) !== true || disposed || controller.getSnapshot() !== current) return; await controller.mutate('delete');}});
      }
      owner.update({id: 'album-tops', tabIndex: -1, ariaLabel: 'Album Tops header', className: 'album-tops__header'});
    }
    refresh(); return {update: refresh, dispose() {progressOwner.dispose(); for (const item of controls.values()) {item.owner.dispose(); item.host.remove();} context.remove(); owner.dispose(); if (target !== headerHost) target.remove();}};
  }
  normalHeader = createHeader(headerHost);
  function render(next) {
    if (disposed) return; latest = next; const {state} = latest, selected = state.selectedTopRef, detail = state.detail.data;
    const denied = state.directory.status === 'denied' || state.detail.status === 'denied';
    if (dialogIntent && (dialogIntent.kind === 'add' && (dialogIntent.providers !== latest.providers || dialogIntent.scopeKey !== state.scopeKey) || denied || dialogIntent.topRef && dialogIntent.topRef !== selected)) {dialogIntent = null; retireDialog(); inline?.dispose(); inline = null;}
    const inlineWanted = dialogIntent?.kind === 'edit' && dialogIntent.top?.edit_draft && !denied;
    normal.hidden = Boolean(inlineWanted); editHost.hidden = !inlineWanted;
    if (inlineWanted) {
      retireDialog();
      normalHeader?.dispose(); normalHeader = null;
      if (inline) inline.update({state}); else inline = mountInlineAlbumTopEdit(editHost, runtime, {controller, state, providers, existing: dialogIntent.top,
        mountHeader: createHeader, onRestoreFocus: () => {restoreFocus = true;}, onClose: closeDialog});
      return;
    }
    if (inline) {const previousInline = inline; inline = null; previousInline.dispose();}
    if (!normalHeader) normalHeader = createHeader(headerHost);
    normalHeader.update(null);
    if (restoreFocus) {restoreFocus = false; returnHeaderFocus(headerHost.querySelector('[aria-label="Edit Album Top"]'))?.focus({preventScroll: true});}
    const resource = selected ? state.detail : state.directory, ready = resource.status === 'ready' || resource.status === 'empty';
    const busy = state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
    const paused = isTopActivity(detail?.top_viewer_overlay?.activity) && !detail.top_viewer_overlay.activity.active;
    description.hidden = !selected || !detail?.description && !paused;
    description.textContent = selected ? [detail?.description, paused ? 'Inactive for you. Progress is paused.' : ''].filter(Boolean).join(' ') : '';
    status.update({value: resource, label: selected ? 'this Album Top' : 'Album Tops', retry: () => selected ? controller.open(selected) : controller.load()});
    empty.hidden = !(selected && ready && detail.items.length === 0); if (!empty.hidden) empty.innerHTML = runtime.alertHtml({severity: 'info', role: 'status', message: 'No albums in this Top'});
    const wanted = new Set();
    for (const [index, row] of (ready ? selected ? detail.items : state.directory.data.tops : []).entries()) {
      const ref = selected ? row.item_ref : row.top_ref, key = `${selected || 'directory'}:${ref}`; wanted.add(key);
      const progressRows = detail?.top_viewer_overlay?.item_progress, progress = selected && progressRows && Object.hasOwn(progressRows, row.album_ref) ? progressRows[row.album_ref] : null;
      const canChangeProgress = selected && albumTopActionAllowed(state, 'set_manual_completion') && isManualProgress(progress);
      const complete = selected && isManualProgress(progress) && (canChangeProgress || paused), completed = complete && progress.manual_completed_at !== null;
      let item = cardOwners.get(key);
      if (!item) {const host = node(cards); item = {host, html: null, click: null}; const listener = event => item.click?.(event); item.listener = listener; host.addEventListener('click', listener); cardOwners.set(key, item);}
      const html = runtime.galleryCardHtml({identity: ref, interaction: !selected || complete ? 'controlled' : 'none', actionRef: selected ? row.album_ref : ref,
        actions: {open: !selected, complete}, completion: complete ? {completed, disabled: busy || !canChangeProgress, label: `${completed ? 'Clear completion' : 'Mark completed'} in this Top: ${row.title}`} : undefined,
        title: row.title, artist: selected ? row.artist : [row.description, isTopActivity(row.top_viewer_overlay?.activity) && !row.top_viewer_overlay.activity.active ? 'Inactive for you' : ''].filter(Boolean).join(' · '), year: row.year, displayMode: 'cards', artboxHtml: runtime.artboxHtml({state: 'empty', label: `${row.title} artwork`})});
      if (item.html !== html) {const active = item.host.ownerDocument.activeElement, preserve = complete && item.host.contains(active) && active?.matches('[data-gallery-card-intent="complete"]'); item.host.innerHTML = html; item.html = html; if (preserve) item.host.querySelector('[data-gallery-card-intent="complete"]:not(:disabled)')?.focus({preventScroll: true});}
      item.click = event => {if (!selected && event.target.closest('[data-gallery-card-intent="open"]')) {latest.onOpen(ref); return;}
        const button = event.target.closest('[data-gallery-card-intent="complete"]'), current = controller.getSnapshot();
        if (!complete || !button || button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('data-gallery-card-ref') !== row.album_ref
          || current.scopeKey !== state.scopeKey || current.detail.data !== detail || current.mutation.refreshing === true || ['loading', 'uncertain'].includes(current.mutation.status)
          || !albumTopActionAllowed(current, 'set_manual_completion', selected) || !current.detail.data.items.some(item => item.album_ref === row.album_ref)) return;
        event.preventDefault(); event.stopPropagation(); return controller.mutate('set_manual_completion', {album_ref: row.album_ref, completed: !completed});};
      if (cards.children[index] !== item.host) cards.insertBefore(item.host, cards.children[index] || null);
    }
    for (const [key, item] of cardOwners) if (!wanted.has(key)) {item.host.removeEventListener('click', item.listener); item.host.remove(); cardOwners.delete(key);}
    notice.update({controller, value: state.mutation});
    const request = latest.shareRequest;
    if (request && !consumedShareRequests.has(request) && !busy && request.isCurrent() && request.row.top_ref === selected && albumTopActionAllowed(state, 'view_sharing')) {
      // Retire locally before notifying the parent: it may synchronously render or close.
      consumedShareRequests.add(request); latest = {...latest, shareRequest: null};
      dialogIntent = {kind: 'share', topRef: selected}; latest.onShareRequestHandled?.(request);
    }
    const key = dialogIntent && JSON.stringify([dialogIntent.kind, dialogIntent.topRef || null]);
    if (dialogToken && dialogToken.key !== key) retireDialog();
    if (dialogIntent && !dialogToken) {
      const intent = dialogIntent, opener = intent.opener, token = {key}; dialogToken = token;
      const options = {runtime, controller, state, providers: intent.kind === 'add' ? intent.providers : providers, existing: intent.top || null, fallbackHost: failureHost,
        onClose: options => {if (!disposed && dialogToken === token) closeDialog(options);},
        onFormSaved: latest.onFormSaved, returnFocus: () => returnHeaderFocus(opener)};
      const opened = intent.kind === 'share' ? openShareAlbumTop(options) : intent.kind === 'add' ? openAddAlbumTop(options) : openAlbumTopBuilder(options);
      if (!disposed && dialogToken === token) dialog = opened; else opened?.dispose();
    } else dialog?.update({state});
  }
  function update(next) {
    if (disposed) return; pending = next; if (updating) return; updating = true;
    try {while (pending && !disposed) {const current = pending; pending = null; render(current);}} finally {updating = false;}
  }
  update(props);
  return {update, dispose() {if (disposed) return; disposed = true; pending = null; retireDialog(); inline?.dispose(); normalHeader?.dispose(); status.dispose(); notice.dispose(); for (const item of cardOwners.values()) item.host.removeEventListener('click', item.listener); cardOwners.clear(); section.remove();}};
}
