import {recommendationSummary} from '../recommendations/presentation.mjs';
import {createCurrentTopListeningView} from './current-listening-view.mjs';
import {mountButton} from '../home-friends/native-controls.mjs';
import {mountViewControl} from '../home-friends/view-control.mjs';
import {albumTopActionAllowed} from './model.mjs';
import {isManualProgress, isTopActivity} from './progress.mjs';
import {createAlbumTopDetails} from './details.mjs';
import {DEFAULT_TOP_READ_VIEW, normalizeTopReadView, projectTopReadView} from './read-view.mjs';
import {mountAlbumTopReadControls} from './read-controls.mjs';
import {albumTopStatusPresentation, appendAlbumTopStatus, topStatusCoverage} from './status-presentation.mjs';
const node = (parent, className = '') => {const element = parent.ownerDocument.createElement('div'); element.className = className; parent.append(element); return element;};
export function mountAlbumTopGallery(host, runtime, {controller, state, providers, toolsHost, panelHost, sourceReplay,
  listeningPreference, readView: initialReadView = DEFAULT_TOP_READ_VIEW, onReadViewChange = () => {}}) {
  let disposed = false, owner = null, snapshot = null, latestState = state, manualPending = null;
  let readView = normalizeTopReadView(initialReadView), readControls = null;
  let preference = listeningPreference;
  const statusDetail = () => ({...owner.detail, top_viewer_overlay: {...owner.detail.top_viewer_overlay,
    item_listening_presentation: {...owner.detail.top_viewer_overlay?.item_listening_presentation,...listening.presentation()},
    ...(preference === undefined ? {} : {completed_target_preference: preference})}});
  const sourceShell = runtime.snapshot();
  const tools = toolsHost || node(host), viewTools = node(tools), filters = panelHost || node(host), errorHost = node(host), filteredEmpty = node(host), scroll = node(host), viewport = node(scroll, 'albums-viewport');
  tools.classList.add('collection-filter-toolbar');
  filteredEmpty.hidden = true;
  const glow = node(viewport, 'gallery-focus-glow'); glow.hidden = true; glow.setAttribute('aria-hidden', 'true');
  function current() {
    if (disposed || !owner || !host.isConnected) return false;
    const value = controller.getSnapshot(), shell = runtime.snapshot();
    return !disposed && value.scopeKey === owner.scopeKey && value.detail.data === owner.detail
      && value.detail.status === 'ready' && value.directory?.status !== 'denied' && value.selectedTopRef === owner.detail.top_ref
      && shell.authenticated && shell.visible && shell.scopeKey === owner.scopeKey && shell.topRef === owner.detail.top_ref
      && shell.viewVersion === sourceShell.viewVersion && shell.viewRequestId === sourceShell.viewRequestId;
  }
  const visibleItems = new Set();
  const listeningHost = node(tools), listeningNote = node(listeningHost);
  const listening = createCurrentTopListeningView({document: host.ownerDocument,isCurrent: current,
    onChange() {if (current()) update({state: latestState,providers: owner.providers});},
    onBaselineChanged(topRef) {if (current() && owner.detail.top_ref === topRef) void controller.open(topRef);}});
  const listeningButton = mountButton(listeningHost,runtime,{label:'Update listening',onClick:() => listening.start()});
  const Observer = host.ownerDocument.defaultView.IntersectionObserver;
  const intersection = typeof Observer === 'function' ? new Observer(entries => {
    for (const entry of entries) {
      const ref=entry.target.getAttribute('data-listening-item-ref');
      if (entry.isIntersecting) visibleItems.add(ref); else visibleItems.delete(ref);
    }
    updateListening();
  }) : null;
  function updateListening() {
    if (!owner || disposed) return;
    const shell=host.ownerDocument.getElementById('app-shell');
    const enabled=shell?.dataset.topListeningPresentationEnabled==='true' && Boolean(intersection)
      && typeof owner.providers.readTopListening==='function' && typeof owner.providers.advanceTopListening==='function';
    listeningHost.hidden=!enabled;
    const valid=new Set(owner.detail.items.map(row=>row.item_ref));
    listening.update({detail:owner.detail,providers:owner.providers,scopeKey:owner.scopeKey,
      accountId:shell?.dataset.nativeAccountId,libraryId:shell?.dataset.nativeLibraryId,
      itemRefs:[...visibleItems].filter(ref=>valid.has(ref)),enabled:enabled && host.isConnected,
      targetRevision:preference?.revision});
    const state=listening.status();
    listeningButton.update({label:state.processing?'Updating listening…':'Update listening',
      disabled:!enabled || !current() || !visibleItems.size || state.processing,
      onClick:()=>listening.start()});
    listeningNote.textContent=state.message || 'Recorded progress for visible albums. Updating can start a fresh baseline for older memberships.';
  }
  function syncFilterState(element,row) {
    const presentation=albumTopStatusPresentation(statusDetail(),row);
    const flag=readView.status==='all' ? true : presentation.flags[readView.status];
    const state=flag===null ? presentation.admitted ? 'unknown' : 'pending' : 'matching';
    element.setAttribute('data-listening-filter-state',state);
    let note=element.querySelector('.album-top-listening-filter-state');
    if (flag!==null) {note?.remove();return;}
    if (!note) {note=element.ownerDocument.createElement('p');note.className='album-top-listening-filter-state';element.append(note);}
    note.textContent=state==='pending' ? 'Status not checked yet. Not a confirmed filter match.'
      : 'Status unavailable from current evidence. Not a confirmed filter match.';
  }
  function syncListeningStatus(element,row) {
    syncFilterState(element,row);
    const presentation=albumTopStatusPresentation(statusDetail(),row);
    const existing=element.querySelector('.album-top-listening-status');
    if (!presentation.summary) {existing?.remove();return;}
    if (!existing) {appendAlbumTopStatus(element,presentation);return;}
    if (existing.textContent!==presentation.summary) existing.textContent=presentation.summary;
    if (existing.getAttribute('aria-label')!==presentation.explanation) existing.setAttribute('aria-label',presentation.explanation);
    if (existing.getAttribute('title')!==presentation.explanation) existing.setAttribute('title',presentation.explanation);
  }
  const details = createAlbumTopDetails({runtime, controller, sourceReplay, readOwner: () => current() ? owner : null,
    onError() {if (current()) {errorHost.hidden = false; errorHost.innerHTML = runtime.alertHtml({severity: 'error', role: 'alert', message: 'Album details could not be opened. Try again.'});}}});
  function cardProps(row, view) {
    const detail = owner.detail, progress = detail.top_viewer_overlay?.item_progress?.[row.album_ref];
    const paused = isTopActivity(detail.top_viewer_overlay?.activity) && !detail.top_viewer_overlay.activity.active;
    const canChange = albumTopActionAllowed(latestState, 'set_manual_completion') && isManualProgress(progress);
    const complete = isManualProgress(progress) && (canChange || paused), completed = complete && progress.manual_completed_at !== null;
    const busy = manualPending !== null || latestState.mutation.refreshing === true || ['loading', 'uncertain'].includes(latestState.mutation.status);
    const remote = ['remote_summary','recommendation_summary'].includes(row.source_kind), open = row.source_kind === 'recommendation_summary' || !remote && row.native_album?.allowed_actions?.can_view_details === true;
    const url = !remote ? row.native_album?.artwork_url : null;
    return {identity: row.item_ref, interaction: open || complete ? 'controlled' : 'none', actionRef: row.album_ref,
      actions: {open, complete}, openDisabled: busy || latestState.detail.refreshing === true,
      completion: complete ? {completed, disabled: busy || !canChange,
        label: `${completed ? 'Clear completion' : 'Mark completed'} in this Top: ${row.title}`} : undefined,
      unavailable: row.source_kind === 'recommendation_summary', title: row.title, artist: [row.artist, remote ? 'Remote album summary · tracks unavailable' : ''].filter(Boolean).join(' · '),
      year: row.year, displayMode: view.displayMode, recommendationLabel: recommendationSummary(row.recommended_by),
      artboxHtml: runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${row.title} artwork`,
        coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" decoding="async" onerror="handleUtilityAlbumArtboxError(this)">` : ''})};
  }
  function renderCard(row, view) {
    const markupFor = (row, view) => {
      const html = runtime.galleryCardHtml(cardProps(row, view));
      const presentation = albumTopStatusPresentation(statusDetail(), row);
      const container = host.ownerDocument.createElement('div');
      container.innerHTML = html;
      if (presentation.summary) appendAlbumTopStatus(container.firstElementChild, presentation);
      if (row.album_ref && host.ownerDocument.defaultView?.AlbumHavenRecommendations) {
        const actions = container.firstElementChild.querySelector('.gallery-card__actions') || container.firstElementChild;
        actions.insertAdjacentHTML('beforeend', runtime.buttonHtml({label:'Recommend',size:'small',attributes:{'data-recommend-top-item':row.item_ref}}));
      }
      return container.innerHTML;
    };
    let baseMarkup = runtime.galleryCardHtml(cardProps(row.value,view));
    let html = markupFor(row.value, view);
    const detached = host.ownerDocument.createElement('div'); detached.innerHTML = html;
    const element = detached.firstElementChild; element.remove();
    element.setAttribute('data-listening-item-ref',row.value.item_ref); syncFilterState(element,row.value); intersection?.observe(element);
    return {element, dispose() {intersection?.unobserve(element);visibleItems.delete(row.value.item_ref);}, update(next, nextView) {
      const nextBase=runtime.galleryCardHtml(cardProps(next.value,nextView));
      if (nextBase===baseMarkup) {syncListeningStatus(element,next.value);return;}
      baseMarkup=nextBase;
      const markup = markupFor(next.value, nextView);
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
      element.setAttribute('data-listening-item-ref',next.value.item_ref); syncFilterState(element,next.value);
      if (focus === 'open' || focus === 'complete') element.querySelector(`[data-gallery-card-intent="${focus}"]:not(:disabled)`)?.focus({preventScroll: true});
    }};
  }
  function action(row, event, captured) {
    if (!current() || captured !== snapshot) return;
    const button = event.target.closest('[data-gallery-card-intent]'), value = row.value;
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true' || button.getAttribute('data-gallery-card-ref') !== value.album_ref) return;
    event.preventDefault(); event.stopPropagation();
    if (button.getAttribute('data-gallery-card-intent') === 'open') {errorHost.hidden = true; if(value.source_kind === 'recommendation_summary') {const capturedOwner=owner;void host.ownerDocument.defaultView?.AlbumHavenRecommendations?.summary(value,()=>current() && owner===capturedOwner);} else void details.open(value); return;}
    const state = controller.getSnapshot(), progress = owner.detail.top_viewer_overlay?.item_progress?.[value.album_ref];
    if (manualPending || button.getAttribute('data-gallery-card-intent') !== 'complete' || !isManualProgress(progress)
      || state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status)
      || !albumTopActionAllowed(state, 'set_manual_completion', owner.detail.top_ref)
      || !owner.detail.items.includes(value)) return;
    void confirmManualCompletion(value, progress);
  }
  async function confirmManualCompletion(value, progress) {
    const captured = owner, pending = {};
    const completed = progress.manual_completed_at === null;
    const revision = progress.progress_revision, previous = progress.manual_completed_at;
    const advice = albumTopStatusPresentation(statusDetail(), value);
    const message = completed
      ? `Mark “${value.title}” completed in this Top? ${advice.counts.full === null
        ? 'Measured listening is unavailable.' : `Recorded evidence supports at least ${advice.counts.full} full listens.`} You can mark it anyway and clear this later. This does not change listening history or ratings.`
      : `Clear manual completion for “${value.title}” in this Top? This does not remove listening history or ratings. Automatic listening completion, if supported, remains separate. You can mark it again later.`;
    manualPending = pending;
    update({state: latestState, providers: captured.providers});
    try {
      const accepted = await runtime.confirm(message, {title: completed ? 'Mark album completed' : 'Clear manual completion',
        acceptLabel: completed ? 'Mark completed' : 'Clear completion', danger: false});
      if (accepted !== true || manualPending !== pending || owner !== captured || !current()) return;
      const live = controller.getSnapshot(), now = owner.detail.top_viewer_overlay?.item_progress?.[value.album_ref];
      if (!owner.detail.items.includes(value) || !isManualProgress(now)
        || now.progress_revision !== revision || now.manual_completed_at !== previous
        || live.mutation.refreshing === true || ['loading', 'uncertain'].includes(live.mutation.status)
        || !albumTopActionAllowed(live, 'set_manual_completion', owner.detail.top_ref)) return;
      await controller.mutate('set_manual_completion', {album_ref: value.album_ref, completed});
    } catch (_) {
      if (owner === captured && current()) {errorHost.hidden = false;
        errorHost.innerHTML = runtime.alertHtml({severity: 'error', role: 'alert', message: 'Completion could not be changed. Review the current state before trying again.'});}
    } finally {
      if (manualPending === pending) manualPending = null;
      if (owner === captured && current()) update({state: controller.getSnapshot(), providers: captured.providers});
    }
  }
  let gallery, metadata, focus, viewControl;
  function recommend(event) {
    if (!current() || (event.type === 'click' && !event.target.closest('[data-recommend-top-item]'))) return;
    const card = event.target.closest('[data-listening-item-ref]');
    if (!card || !viewport.contains(card)) return;
    const captured = owner, row = owner.detail.items.find(item => item.item_ref === card.getAttribute('data-listening-item-ref'));
    const ref = row?.native_album?.inventory_album_ref || `catalog-album:${row?.album_ref}`, source = row?.native_album?.inventory_album_ref ? undefined : {top_ref:owner.detail.top_ref,item_ref:row?.item_ref,revision:owner.detail.revision}, api = host.ownerDocument.defaultView?.AlbumHavenRecommendations;
    if (!api?.available('album', ref, source)) return;
    const isCurrent = () => current() && owner === captured && owner.detail.items.includes(row) && card.isConnected;
    event.preventDefault(); event.stopPropagation();
    const anchor = event.target.closest('[data-recommend-top-item]') || card.querySelector('button') || card;
    host.ownerDocument.defaultView.AlbumHavenPlaytableUI?.actions(anchor,{label:'Album recommendations',formats:[
      {value:'send',label:'Recommend to a friend'},{value:'manual',label:'Add to Recommended By…'}],onSelect:value=>{
      if (!isCurrent()) return false;
      void api.open({kind:'album',resource_ref:ref,source,manual:value==='manual',anchor,isCurrent});return true;}});
  }
  viewport.addEventListener('contextmenu', recommend);
  viewport.addEventListener('click', recommend);
  function update(next) {
    if (disposed) return;
    latestState = next.state;
    if (Object.hasOwn(next, 'listeningPreference')) preference = next.listeningPreference;
    const changed = !owner || owner.detail !== next.state.detail.data || owner.providers !== next.providers || owner.scopeKey !== next.state.scopeKey;
    if (changed) {
      details.retire(); errorHost.hidden = true; manualPending = null;
      owner = Object.freeze({detail: next.state.detail.data, providers: next.providers, scopeKey: next.state.scopeKey});
    }
    host.ownerDocument.defaultView?.AlbumHavenRecommendations?.reconcile();
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
    const controlProps = {controller, providers: owner.providers, state: latestState, presentationDetail: statusDetail(), view: readView, isCurrent: current,
      onChange(value) {if (current()) {readView = normalizeTopReadView(value); onReadViewChange(readView);
        if (current()) update({state: latestState, providers: owner.providers});}}};
    if (!readControls) readControls = mountAlbumTopReadControls(tools, filters, runtime, controlProps); else readControls.update(controlProps);
    if (tools.lastElementChild !== viewTools) tools.append(viewTools);
    viewTools.hidden = owner.detail.items.length === 0;
    if (viewTools.hidden) {viewControl?.dispose(); viewControl = null;}
    else if (!viewControl) viewControl = mountViewControl(viewTools, runtime, props); else viewControl.update(props);
    const visible = projectTopReadView(statusDetail(), readView);
    filteredEmpty.hidden = owner.detail.items.length === 0 || visible.length > 0;
    if (!filteredEmpty.hidden) {
      const coverage = readView.status === 'all' ? null : topStatusCoverage(statusDetail(), readView.status);
      const message = coverage?.unknown > 0
        ? coverage.known === 0
          ? 'Selected status unavailable. Choose Any status in Filter to keep your other filters.'
          : 'No known matches. Status is unavailable for some albums. Choose Any status in Filter to keep your other filters.'
        : 'No albums match these filters. Reset filters to show all albums.';
      filteredEmpty.innerHTML = runtime.alertHtml({severity: 'info', role: 'status', message});
    }
    if (gallery.update(visible.map(value => ({key: value.item_ref, value})))) {metadata?.update(); focus.refresh();}
    updateListening();
  }
  function dispose() {
    if (disposed) return; disposed = true; host.ownerDocument.defaultView?.AlbumHavenRecommendations?.reconcile(); viewport.removeEventListener('contextmenu',recommend);viewport.removeEventListener('click',recommend); manualPending = null; listening.dispose();listeningButton.dispose();intersection?.disconnect();visibleItems.clear();listeningHost.remove(); details.dispose(); readControls?.dispose(); viewControl?.dispose(); metadata?.dispose(); focus?.dispose(); gallery?.dispose();
    viewTools.remove(); if (!panelHost) filters.remove();
    if (toolsHost) tools.hidden = true; else tools.remove();
    errorHost.remove(); filteredEmpty.remove(); scroll.remove(); owner = null; snapshot = null;
  }
  try {update({state, providers});} catch (error) {dispose(); throw error;}
  return {update, dispose};
}
