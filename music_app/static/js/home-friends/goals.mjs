import {createGoalsProvider} from './goals-provider.mjs';
import {createGoalsController} from './goals-model.mjs';
import {mountChoice, mountButton} from './native-controls.mjs';
import {mountAlbumProgress} from './album-progress.mjs';
import {openNativeDialog} from './native-dialog.mjs';

const periodIcons = {week: 'calendar-week', month: 'calendar-month', 'six-months': 'calendar-six-months', year: 'calendar-year'};
const periods = [['week', '1 week'], ['month', '1 month'], ['six-months', '6 months'], ['year', 'This year']];
export function mountGoalsPanel(host, runtime, initial) {
  const doc = host.ownerDocument;
  let provider, controller, resetHost, periodHost, progressHost, body, status, error, retryHost, list;
  let disposed = false, dialog = null, dialogGuard = null, unsubscribe, choice, progress, reset, retry;
  let rendering = false, queuedRender = false, frameSnapshot = null;
  const nodes = [], rows = new Map();
  const node = (parent, tag = 'div') => {const value = doc.createElement(tag); nodes.push(value); parent.append(value); return value;};
  const current = () => !disposed && initial.isCurrent?.() !== false;
  function closeDialog() {const old = dialog; dialog = null; dialogGuard = null; old?.dispose();}
  function confirmReset() {
    const captured = controller.getSnapshot(), period = captured.period, data = captured.data;
    if (!current() || captured.status !== 'ready' || captured.mutation !== 'idle' || data?.allowed_actions.can_reset !== true) return;
    closeDialog();
    const valid = () => current() && controller.getSnapshot().data === data && controller.getSnapshot().period === period
      && controller.getSnapshot().mutation === 'idle' && controller.getSnapshot().data?.allowed_actions.can_reset === true;
    const opened = openNativeDialog(runtime, {title: 'Reset goals', returnFocus: () => resetHost.querySelector('button')}, {fallbackHost: body, mount(content, close) {
      const explanation = doc.createElement('p'); explanation.textContent = 'Keep all albums and clear completion for this period. Other periods and history stay unchanged.'; content.append(explanation);
      const actions = doc.createElement('div'); content.append(actions);
      const cancelHost = doc.createElement('span'), submitHost = doc.createElement('span'); actions.append(cancelHost, submitHost);
      const cancel = mountButton(cancelHost, runtime, {label: 'Cancel', onClick: () => close()});
      const submit = mountButton(submitHost, runtime, {label: 'Reset', onClick: () => {
        if (!valid()) return;
        close({restoreFocus: false});
        if (valid()) void controller.reset({period, revision: data.revision, cycle_id: data.periods[period].cycle?.cycle_id ?? null});
      }});
      return {dispose() {submit.dispose(); cancel.dispose(); actions.remove(); explanation.remove();}};
    }, onClose() {dialog = null;}});
    if (!valid() || opened.closed) opened.dispose(); else {dialog = opened; dialogGuard = valid;}
  }
  function render() {
    if (rendering) {if (frameSnapshot !== controller.getSnapshot()) queuedRender = true; return;}
    rendering = true;
    try {do {queuedRender = false; renderFrame();} while (queuedRender && current());}
    finally {rendering = false; frameSnapshot = null;}
  }
  function renderFrame() {
    if (!current()) {closeDialog(); return;}
    const snapshot = controller.getSnapshot(), data = snapshot.data, selected = data?.periods[snapshot.period];
    frameSnapshot = snapshot;
    const checkpoint = () => {
      if (current() && controller.getSnapshot() === snapshot) return true;
      queuedRender = current(); return false;
    };
    if (snapshot.status !== 'ready' || snapshot.mutation !== 'idle' || dialogGuard && !dialogGuard()) closeDialog();
    if (!checkpoint()) return;
    choice.update({icon: periodIcons[snapshot.period], showLabel: false, label: 'Period', className: 'home-friends__period',
      menuWidth: 'content', value: snapshot.period, options: periods,
      disabled: snapshot.mutation !== 'idle', onChange: value => {if (current()) {closeDialog(); controller.selectPeriod(value);}}});
    if (!checkpoint()) return;
    progress.update({summary: snapshot.status === 'ready' ? selected : null, label: 'Goals completed'});
    if (!checkpoint()) return;
    reset.update({label: 'Reset', icon: 'undo', disabled: snapshot.status !== 'ready' || snapshot.mutation !== 'idle' || data?.allowed_actions.can_reset !== true,
      onClick: confirmReset});
    if (!checkpoint()) return;
    resetHost.hidden = snapshot.status !== 'ready' || !selected?.cycle || selected.total === 0;
    status.setAttribute('role', 'status');
    status.textContent = snapshot.status === 'ready' ? selected.total ? '' : 'The goals were not set'
      : snapshot.status === 'loading' || snapshot.status === 'idle' ? 'Loading Goals…'
      : snapshot.status === 'denied' ? 'Goals are unavailable for this session.' : 'Goals could not be loaded.';
    error.setAttribute('role', 'alert'); error.textContent = snapshot.error?.message || '';
    retryHost.hidden = !snapshot.error || ['submitting', 'recovering', 'refreshing'].includes(snapshot.mutation);
    retry.update({label: 'Retry', disabled: retryHost.hidden, onClick: () => {if (current()) void controller.retry();}});
    if (!checkpoint()) return;
    const desired = snapshot.status === 'ready' ? selected.album_refs : [];
    for (const [ref, row] of rows) if (!desired.includes(ref)) {row.remove(); rows.delete(ref);}
    const albums = new Map((data?.albums || []).map(album => [album.catalog_ref, album]));
    for (const [index, ref] of desired.entries()) {
      let row = rows.get(ref);
      const album = albums.get(ref), key = JSON.stringify(album);
      if (!row) {row = doc.createElement('div'); row.dataset.goalAlbumRef = ref; rows.set(ref, row);}
      if (row.goalRenderKey !== key || row.goalCardRenderer !== runtime.galleryCardHtml || row.goalArtworkRenderer !== runtime.artboxHtml) {
        const artwork = runtime.artboxHtml({state: 'missing', label: `${album.title} artwork`});
        if (!checkpoint()) return;
        const markup = runtime.galleryCardHtml({identity: ref, title: album.title, artist: album.artist_display,
          year: album.first_release_date?.slice(0, 4) || '', interaction: 'none', displayMode: 'cards',
          artboxHtml: artwork, listeningSummaryHtml: ''});
        if (!checkpoint()) return;
        row.innerHTML = markup;
        if (!checkpoint()) return;
        row.goalRenderKey = key; row.goalCardRenderer = runtime.galleryCardHtml; row.goalArtworkRenderer = runtime.artboxHtml;
      }
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      if (!checkpoint()) return;
    }
  }
  function dispose() {
    if (disposed) return; disposed = true; unsubscribe?.(); closeDialog(); controller?.dispose(); provider?.dispose();
    retry?.dispose(); reset?.dispose(); progress?.dispose(); choice?.dispose();
    nodes.reverse().forEach(value => value.remove()); rows.clear();
  }
  try {
    provider = createGoalsProvider(initial.transport); controller = createGoalsController({provider});
    const firstAction = initial.header.actions.firstChild;
    resetHost = node(initial.header.actions, 'span'); periodHost = node(initial.header.actions, 'span');
    initial.header.actions.insertBefore(resetHost, firstAction); initial.header.actions.insertBefore(periodHost, firstAction);
    progressHost = node(initial.header.content, 'span'); body = node(host); status = node(body); error = node(body);
    retryHost = node(body, 'span'); body.className = 'home-recent__body gallery-scrollbar';
    list = node(body); list.className = 'home-recent__rows'; list.dataset.homeDisplay = 'cards';
    list.setAttribute('aria-label', 'Goal albums');
    choice = mountChoice(periodHost, runtime, {label: 'Period', options: periods, value: 'week'});
    progress = mountAlbumProgress(progressHost);
    reset = mountButton(resetHost, runtime, {label: 'Reset', icon: 'undo', disabled: true});
    retry = mountButton(retryHost, runtime, {label: 'Retry', disabled: true});
    unsubscribe = controller.subscribe(render); render(); void controller.load();
  } catch (error) {dispose(); throw error;}
  return {update() {render();}, dispose};
}
