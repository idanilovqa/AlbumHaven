import {mountViewControl} from '../home-friends/view-control.mjs';
import {albumTopActionAllowed} from './model.mjs';
import {isManualProgress, isTopActivity} from './progress.mjs';
import {createAlbumTopDetails} from './details.mjs';
import {DEFAULT_TOP_READ_VIEW, normalizeTopReadView, projectTopReadView} from './read-view.mjs';
import {mountAlbumTopReadControls} from './read-controls.mjs';
const node = (parent, className = '') => {const element = parent.ownerDocument.createElement('div'); element.className = className; parent.append(element); return element;};
export function mountAlbumTopGallery(host, runtime, {controller, state, providers, toolsHost, panelHost, sourceReplay,
  readView: initialReadView = DEFAULT_TOP_READ_VIEW, onReadViewChange = () => {}}) {
  let disposed = false, owner = null, snapshot = null, latestState = state;
  let readView = normalizeTopReadView(initialReadView), readControls = null;
  const sourceShell = runtime.snapshot();
  const tools = toolsHost || node(host), viewTools = node(tools), filters = panelHost || node(host), errorHost = node(host), filteredEmpty = node(host), scroll = node(host), viewport = node(scroll, 'albums-viewport');
  tools.classList.add('collection-filter-toolbar');
  filteredEmpty.hidden = true;
  const glow = node(viewport, 'gallery-focus-glow'); glow.hidden = true; glow.setAttribute('aria-hidden', 'true');
  function current() {
    if (disposed || !owner) return false;
    const value = controller.getSnapshot(), shell = runtime.snapshot();
    return !disposed && value.scopeKey === owner.scopeKey && value.detail.data === owner.detail
      && value.detail.status === 'ready' && value.directory?.status !== 'denied' && value.selectedTopRef === owner.detail.top_ref
      && shell.authenticated && shell.visible && shell.scopeKey === owner.scopeKey && shell.topRef === owner.detail.top_ref
      && shell.viewVersion === sourceShell.viewVersion && shell.viewRequestId === sourceShell.viewRequestId;
  }
  const details = createAlbumTopDetails({runtime, controller, sourceReplay, readOwner: () => current() ? owner : null,
    onError() {if (current()) {errorHost.hidden = false; errorHost.innerHTML = runtime.alertHtml({severity: 'error', role: 'alert', message: 'Album details could not be opened. Try again.'});}}});
  function cardProps(row, view) {
    const detail = owner.detail, progress = detail.top_viewer_overlay?.item_progress?.[row.album_ref];
    const paused = isTopActivity(detail.top_viewer_overlay?.activity) && !detail.top_viewer_overlay.activity.active;
    const canChange = albumTopActionAllowed(latestState, 'set_manual_completion') && isManualProgress(progress);
    const complete = isManualProgress(progress) && (canChange || paused), completed = complete && progress.manual_completed_at !== null;
    const busy = latestState.mutation.refreshing === true || ['loading', 'uncertain'].includes(latestState.mutation.status);
    const remote = row.source_kind === 'remote_summary', open = !remote && row.native_album?.allowed_actions?.can_view_details === true;
    const url = !remote ? row.native_album?.artwork_url : null;
    return {identity: row.item_ref, interaction: open || complete ? 'controlled' : 'none', actionRef: row.album_ref,
      actions: {open, complete}, openDisabled: busy || latestState.detail.refreshing === true,
      completion: complete ? {completed, disabled: busy || !canChange,
        label: `${completed ? 'Clear completion' : 'Mark completed'} in this Top: ${row.title}`} : undefined,
      title: row.title, artist: [row.artist, remote ? 'Remote album summary · tracks unavailable' : ''].filter(Boolean).join(' · '),
      year: row.year, displayMode: view.displayMode,
      artboxHtml: runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${row.title} artwork`,
        coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" decoding="async" onerror="handleUtilityAlbumArtboxError(this)">` : ''})};
  }
  function renderCard(row, view) {
    let html = runtime.galleryCardHtml(cardProps(row.value, view));
    const detached = host.ownerDocument.createElement('div'); detached.innerHTML = html;
    const element = detached.firstElementChild; element.remove();
    return {element, update(next, nextView) {
      const markup = runtime.galleryCardHtml(cardProps(next.value, nextView));
      if (markup === html) return;
      const active = element.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement : null;
      const focus = active?.getAttribute('data-gallery-card-intent');
      detached.innerHTML = markup; const replacement = detached.firstElementChild;
      if (focus === 'open' || focus === 'complete') {
        const nextButton = replacement.querySelector(`[data-gallery-card-intent="${focus}"]`);
        if (nextButton) {
          for (const attribute of [...active.attributes]) if (!nextButton.hasAttribute(attribute.name)) active.removeAttribute(attribute.name);
          for (const attribute of [...nextButton.attributes]) active.setAttribute(attribute.name, attribute.value);
          active.replaceChildren(...nextButton.childNodes); nextButton.replaceWith(active);
        }
      }
      for (const attribute of [...element.attributes]) if (!replacement.hasAttribute(attribute.name)) element.removeAttribute(attribute.name);
      for (const attribute of [...replacement.attributes]) element.setAttribute(attribute.name, attribute.value);
      element.replaceChildren(...replacement.childNodes); html = markup;
      if (focus === 'open' || focus === 'complete') element.querySelector(`[data-gallery-card-intent="${focus}"]:not(:disabled)`)?.focus({preventScroll: true});
    }};
  }
  function action(row, event, captured) {
    if (!current() || captured !== snapshot) return;
    const button = event.target.closest('[data-gallery-card-intent]'), value = row.value;
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('data-gallery-card-ref') !== value.album_ref) return;
    event.preventDefault(); event.stopPropagation();
    if (button.getAttribute('data-gallery-card-intent') === 'open') {errorHost.hidden = true; void details.open(value); return;}
    const state = controller.getSnapshot(), progress = owner.detail.top_viewer_overlay?.item_progress?.[value.album_ref];
    if (button.getAttribute('data-gallery-card-intent') !== 'complete' || !isManualProgress(progress)
      || state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status)
      || !albumTopActionAllowed(state, 'set_manual_completion', owner.detail.top_ref)
      || !owner.detail.items.includes(value)) return;
    controller.mutate('set_manual_completion', {album_ref: value.album_ref, completed: progress.manual_completed_at === null});
  }
  let gallery, metadata, focus, viewControl;
  function update(next) {
    if (disposed) return;
    latestState = next.state;
    const changed = !owner || owner.detail !== next.state.detail.data || owner.providers !== next.providers || owner.scopeKey !== next.state.scopeKey;
    if (changed) {
      details.retire(); errorHost.hidden = true;
      owner = Object.freeze({detail: next.state.detail.data, providers: next.providers, scopeKey: next.state.scopeKey});
    }
    if (!current()) {dispose(); return;}
    const preferences = runtime.snapshot();
    snapshot = Object.freeze({scopeKey: owner.scopeKey, resourceKey: owner.detail.top_ref,
      displayMode: preferences.galleryDisplayMode, galleryScalePercent: preferences.galleryScalePercent,
      mobileColumns: preferences.mobileGalleryColumns});
    if (!gallery) {
      gallery = runtime.createGalleryHost({host: viewport, readSnapshot: () => snapshot, renderCard, onAction: action, isCurrent: current});
      metadata = runtime.createGalleryMetadataOwner({root: viewport, isCurrent: current});
      focus = runtime.createGalleryFocusOwner({viewport, scroll, glow, isCurrent: current});
    }
    const props = {kind: 'albums', value: snapshot.displayMode, isCurrent: current,
      onChange: mode => {if (current() && owner.detail.items.length) runtime.setGalleryDisplayMode(mode);}};
    tools.hidden = false;
    const controlProps = {controller, providers: owner.providers, state: latestState, view: readView, isCurrent: current,
      onChange(value) {if (current()) {readView = normalizeTopReadView(value); onReadViewChange(readView);
        if (current()) update({state: latestState, providers: owner.providers});}}};
    if (!readControls) readControls = mountAlbumTopReadControls(tools, filters, runtime, controlProps); else readControls.update(controlProps);
    if (tools.lastElementChild !== viewTools) tools.append(viewTools);
    viewTools.hidden = owner.detail.items.length === 0;
    if (viewTools.hidden) {viewControl?.dispose(); viewControl = null;}
    else if (!viewControl) viewControl = mountViewControl(viewTools, runtime, props); else viewControl.update(props);
    const visible = projectTopReadView(owner.detail, readView);
    filteredEmpty.hidden = owner.detail.items.length === 0 || visible.length > 0;
    if (!filteredEmpty.hidden) filteredEmpty.innerHTML = runtime.alertHtml({severity: 'info', role: 'status', message: 'No albums match these filters. Reset filters to show all albums.'});
    if (gallery.update(visible.map(value => ({key: value.item_ref, value})))) {metadata?.update(); focus.refresh();}
  }
  function dispose() {
    if (disposed) return; disposed = true; details.dispose(); readControls?.dispose(); viewControl?.dispose(); metadata?.dispose(); focus?.dispose(); gallery?.dispose();
    viewTools.remove(); if (!panelHost) filters.remove();
    if (toolsHost) tools.hidden = true; else tools.remove();
    errorHost.remove(); filteredEmpty.remove(); scroll.remove(); owner = null; snapshot = null;
  }
  try {update({state, providers});} catch (error) {dispose(); throw error;}
  return {update, dispose};
}
