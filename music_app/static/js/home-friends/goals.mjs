import {createGoalsAttentionView} from './goals-attention-view.mjs';
import {createGoalsProvider} from './goals-provider.mjs';
import {createGoalsController} from './goals-model.mjs';
import {mountChoice, mountButton} from './native-controls.mjs';
import {mountAlbumProgress} from './album-progress.mjs';
import {mountGoalAdmission} from './goals-admission.mjs';
import {mountGoalBonusSettings, mountGoalBonusSwitch} from './goals-bonus-settings.mjs';
import {createAlbumTopBackendProviders} from '../album-tops/backend-providers.mjs';
import {openNativeDialog} from './native-dialog.mjs';

const periodIcons = {week: 'calendar-week', month: 'calendar-month', 'six-months': 'calendar-six-months', year: 'calendar-year'};
const periods = [['week', '1 week'], ['month', '1 month'], ['six-months', '6 months'], ['year', 'This year']];
export function isGoalCycleDue(cycle, now = new Date()) {
  if (!cycle || !/^\d{4}-\d{2}-\d{2}$/.test(cycle.due_date) || typeof cycle.timezone_name !== 'string') return false;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone: cycle.timezone_name,
      year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(now).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}` >= cycle.due_date;
  } catch {return false;}
}
export function mountGoalsPanel(host, runtime, initial) {
  const doc = host.ownerDocument;
  let provider, controller, resetHost, periodHost, progressHost, body, status, error, retryHost, list, emptyHost, startHost, addHost;
  let disposed = false, dialog = null, dialogGuard = null, unsubscribe, choice, progress, reset, retry, start, add;
  let attentionView, dismissAttention, dismissAttentionHost, retryAttention, retryAttentionHost;
  let rendering = false, queuedRender = false, frameSnapshot = null;
  let menu = null, menuGuard = null, menuGeneration = 0;
  let bonusHost, bonusSwitch, bonusOutcome, sourceSequence = 0;
  const sourceTransport = initial.sourceTransport || null;
  let sourceContext = null;
  try {sourceContext = sourceTransport?.context() || null;} catch {}
  const sourceCurrent = () => {try {return current() && Boolean(sourceContext) && sourceTransport?.context() === sourceContext;} catch {return false;}};
  const nodes = [], rows = new Map();
  const node = (parent, tag = 'div') => {const value = doc.createElement(tag); nodes.push(value); parent.append(value); return value;};
  const current = () => !disposed && initial.isCurrent?.() !== false;
  function closeDialog() {const old = dialog; dialog = null; dialogGuard = null; old?.dispose();}
  function closeMenu() {
    const previous = menu; menu = null; menuGuard = null; menuGeneration++;
    // Retirement must still clear private rows if an external close hook fails.
    try {previous?.close({restoreFocus: false});} catch {}
  }
  function openAlbumActions(ref, anchor) {
    closeMenu();
    const captured = controller.getSnapshot(), data = captured.data, period = captured.period, selected = data?.periods[period];
    const valid = () => current() && controller.getSnapshot().data === data && controller.getSnapshot().period === period
      && controller.getSnapshot().status === 'ready' && controller.getSnapshot().mutation === 'idle'
      && selected?.album_refs.includes(ref) && anchor.isConnected;
    if (!valid()) return;
    const formats = [];
    const completed = selected.manual_completed_at[ref] !== null;
    if (data.allowed_actions.can_complete) formats.push({value: 'completion', label: completed ? 'Clear completion' : 'Mark completed'});
    if (data.allowed_actions.can_remove) formats.push({value: 'remove', label: 'Remove from goals'});
    if (!formats.length) return;
    const expected = Object.freeze({data, period, revision: data.revision, cycle_id: selected.cycle?.cycle_id ?? null});
    const operation = menuGeneration;
    const opened = runtime.openChoice(anchor, {formats, label: 'Goal album actions', actionMenu: true,
      menuWidth: 'content', updateTriggerLabel: false, initialFocus: 'first', onSelect: action => {
        if (!valid() || operation !== menuGeneration || !formats.some(item => item.value === action)) return;
        closeMenu();
        if (!valid()) return;
        if (action === 'completion') {const result = controller.setCompletion(ref, !completed, expected); if (!completed) attentionView?.completed(result, captured);}
        else void controller.remove(ref, expected);
      }});
    if (!valid() || operation !== menuGeneration) {try {opened?.close({restoreFocus: false});} catch {}}
    else {menu = opened; menuGuard = valid;}
  }
  function retireRowAction(row) {
    const previous = row.goalActionOwner; row.goalActionOwner = null;
    try {previous?.dispose();} catch {}
  }
  function disposeRow(row) {
    row.removeEventListener('contextmenu', row.goalContextMenu);
    try {retireRowAction(row);} finally {row.goalActionHost = null; row.remove();}
  }
  function openAdmission() {
    const captured = controller.getSnapshot(), data = captured.data, period = captured.period;
    const valid = () => current() && controller.getSnapshot().status === 'ready'
      && controller.getSnapshot().mutation === 'idle' && controller.getSnapshot().data === data
      && controller.getSnapshot().period === period && data?.allowed_actions.can_add === true;
    if (!valid()) return;
    closeMenu(); closeDialog(); if (!valid()) return;
    const expected = Object.freeze({data, period, revision: data.revision});
    const opened = openNativeDialog(runtime, {title: 'Add albums to Goals',
      returnFocus: () => (data.periods[period].total ? addHost : startHost).querySelector('button')}, {
      fallbackHost: body,
      mount(content, close) {return mountGoalAdmission(content, runtime, {provider, controller, expected, isCurrent: valid,
        onClose: () => close(), onConfirm: (evidence, capturedExpected) => {
          if (!valid() || capturedExpected !== expected) return;
          close({restoreFocus: false});
          if (valid()) void controller.add(evidence, expected);
        }});},
      onClose() {dialog = null; dialogGuard = null;},
    });
    if (!valid() || opened.closed) opened.dispose(); else {dialog = opened; dialogGuard = valid;}
  }
  function openBonusSettings() {
    const captured = controller.getSnapshot(), {data, settings, bonus, period} = captured;
    const valid = () => current() && controller.getSnapshot().status === 'ready'
      && controller.getSnapshot().mutation === 'idle' && controller.getSnapshot().bonusStatus === 'ready'
      && controller.getSnapshot().data === data && controller.getSnapshot().settings === settings
      && controller.getSnapshot().bonus === bonus && controller.getSnapshot().period === period;
    if (!valid() || !data.allowed_actions.can_add) return;
    closeMenu(); closeDialog(); if (!valid()) return;
    const expected = Object.freeze({data, settings, bonus, period});
    const scope = `goals-bonus-sources-${++sourceSequence}`;
    const opened = openNativeDialog(runtime, {title: 'Bonus album settings',
      returnFocus: () => bonusHost.querySelector('button')}, {fallbackHost: body,
      mount(content, close) {
        let sources = null, child = null, stop = null, retired = false;
        const sourceValid = () => !retired && valid() && sourceCurrent();
        const dispose = () => {if (retired) return;retired=true;const old=child;child=null;
          try {stop?.();} finally {try {sources?.dispose();} finally {old?.dispose();}}};
        try {
          if (sourceValid()) sources = createAlbumTopBackendProviders({transport: sourceTransport,
            acceptsScope: value => value === scope && sourceValid()});
          child = mountGoalBonusSettings(content, runtime, {controller, expected,
            proposedEnabled: !settings.enabled, sourceProvider: sources, sourceScope: scope,
            sourceCurrent: sourceValid, isCurrent: valid,
            onClose: () => close(),
            onSave: values => {if (!valid()) return;close({restoreFocus:false});if (valid()) void controller.saveBonusSettings(values, expected);},
            onDraw: () => {if (!valid() || !sourceValid()) return;close({restoreFocus:false});if (valid() && sourceCurrent()) void controller.drawBonus(expected);}});
          stop = sourceTransport?.subscribe?.(() => {if (!sourceCurrent()) child?.updateSource({sourceProvider:null,sourceScope:null,sourceCurrent:()=>false});});
          if (!sourceCurrent()) child.updateSource({sourceProvider:null,sourceScope:null,sourceCurrent:()=>false});
          return {dispose};
        } catch(error) {dispose();throw error;}
      }, onClose() {dialog = null; dialogGuard = null;}});
    if (!valid() || opened.closed) opened.dispose(); else {dialog = opened; dialogGuard = valid;}
  }
  function confirmReset() {
    const captured = controller.getSnapshot(), period = captured.period, data = captured.data;
    if (!current() || captured.status !== 'ready' || captured.mutation !== 'idle' || data?.allowed_actions.can_reset !== true) return;
    closeDialog();
    const due = isGoalCycleDue(data.periods[period].cycle), settings = captured.settings, bonus = captured.bonus;
    const valid = () => current() && controller.getSnapshot().data === data && controller.getSnapshot().period === period
      && controller.getSnapshot().mutation === 'idle' && controller.getSnapshot().data?.allowed_actions.can_reset === true
      && (!due || controller.getSnapshot().settings === settings && controller.getSnapshot().bonus === bonus);
    const expected = Object.freeze({data, settings, bonus, period});
    const opened = openNativeDialog(runtime, {title: 'Reset goals', returnFocus: () => resetHost.querySelector('button')}, {fallbackHost: body, mount(content, close) {
      const explanation = doc.createElement('p'); explanation.textContent = due
        ? 'Restart these albums, or start the next period with unfinished albums. Existing larger periods and history are kept. Saved bonus carry settings apply; a transition never draws a new album.'
        : 'Keep all albums and clear completion for this period. Other periods and history stay unchanged.'; content.append(explanation);
      let operation = 'reset', operationChoice = null;
      const choiceHost = doc.createElement('span'); content.append(choiceHost);
      const operationProps = () => ({label:'Period action', value:operation,
        options:[['reset','Restart these albums'],['transition','Start next period']],
        disabled:captured.bonusStatus!=='ready', onChange:value=>{
          if(valid() && ['reset','transition'].includes(value)) {operation=value;operationChoice?.update(operationProps());submit.update(submitProps());}
        }});
      if (due) operationChoice = mountChoice(choiceHost, runtime, operationProps());
      const actions = doc.createElement('div'); content.append(actions);
      const cancelHost = doc.createElement('span'), submitHost = doc.createElement('span'); actions.append(cancelHost, submitHost);
      const cancel = mountButton(cancelHost, runtime, {label: 'Cancel', onClick: () => close()});
      const submitProps = () => ({label: due ? operation==='transition' ? 'Start next period' : 'Restart these albums' : 'Reset', onClick: () => {
        if (!valid() || operation==='transition' && (captured.bonusStatus!=='ready' || !isGoalCycleDue(data.periods[period].cycle))) return;
        close({restoreFocus: false});
        if (valid()) {
          if (operation==='transition') void controller.transition(expected);
          else void controller.reset({period, revision: data.revision, cycle_id: data.periods[period].cycle?.cycle_id ?? null});
        }
      }});
      const submit = mountButton(submitHost, runtime, submitProps());
      return {dispose() {try {operationChoice?.dispose();} finally {try {submit.dispose();} finally {cancel.dispose();actions.remove();choiceHost.remove();explanation.remove();}}}};
    }, onClose() {dialog = null;dialogGuard = null;}});
    if (!valid() || opened.closed) opened.dispose(); else {dialog = opened; dialogGuard = valid;}
  }
  function render() {
    if (rendering) {if (frameSnapshot !== controller.getSnapshot()) queuedRender = true; return;}
    rendering = true;
    try {do {queuedRender = false; renderFrame();} while (queuedRender && current());}
    finally {rendering = false; frameSnapshot = null;}
  }
  function renderFrame() {
    if (!current()) {closeMenu(); closeDialog(); return;}
    const snapshot = controller.getSnapshot(), data = snapshot.data, selected = data?.periods[snapshot.period];
    frameSnapshot = snapshot;
    const checkpoint = () => {
      if (current() && controller.getSnapshot() === snapshot) return true;
      queuedRender = current(); return false;
    };
    if (menuGuard && !menuGuard()) closeMenu();
    if (!checkpoint()) return;
    if (snapshot.status !== 'ready' || snapshot.mutation !== 'idle' || dialogGuard && !dialogGuard()) closeDialog();
    if (!checkpoint()) return;
    choice.update({icon: periodIcons[snapshot.period], showLabel: false, label: 'Period', className: 'home-friends__period',
      menuWidth: 'content', value: snapshot.period, options: periods,
      disabled: snapshot.mutation !== 'idle', onChange: value => {if (current()) {closeDialog(); controller.selectPeriod(value); attentionView?.enter({});}}});
    if (!checkpoint()) return;
    progress.update({summary: snapshot.status === 'ready' ? selected : null, label: 'Goals completed'});
    if (!checkpoint()) return;
    reset.update({label: 'Reset', icon: 'undo', disabled: snapshot.status !== 'ready' || snapshot.mutation !== 'idle' || data?.allowed_actions.can_reset !== true,
      onClick: confirmReset});
    if (!checkpoint()) return;
    resetHost.hidden = snapshot.status !== 'ready' || !selected?.cycle || selected.total === 0 && !isGoalCycleDue(selected.cycle);
    bonusSwitch.update({id:'goals-bonus-enabled', enabled:snapshot.settings?.enabled===true,
      disabled:snapshot.status!=='ready'||snapshot.bonusStatus!=='ready'||snapshot.mutation!=='idle'||data?.allowed_actions.can_add!==true, onClick:openBonusSettings});
    if (!checkpoint()) return;
    bonusOutcome.textContent = snapshot.status==='ready' && snapshot.outcome?.action==='bonus_draw' && snapshot.outcome.reason==='no_eligible_source'
      ? 'No eligible unfinished album was available in your active Album Top sources.' : '';
    bonusOutcome.hidden = !bonusOutcome.textContent;
    const canAdd = snapshot.status === 'ready' && data?.allowed_actions.can_add === true;
    startHost.hidden = !canAdd || selected.total !== 0;
    addHost.hidden = !canAdd || selected.total === 0;
    start.update({label: 'Start', variant: 'primary', disabled: !canAdd || snapshot.mutation !== 'idle', onClick: openAdmission});
    if (!checkpoint()) return;
    add.update({label: 'Add', icon: 'add', disabled: !canAdd || snapshot.mutation !== 'idle', onClick: openAdmission});
    if (!checkpoint()) return;
    emptyHost.hidden = snapshot.status === 'ready' && selected.total > 0;
    status.setAttribute('role', 'status');
    status.textContent = snapshot.status === 'ready' ? selected.total ? '' : 'The goals were not set'
      : snapshot.status === 'loading' || snapshot.status === 'idle' ? 'Loading Goals…'
      : snapshot.status === 'denied' ? 'Goals are unavailable for this session.' : 'Goals could not be loaded.';
    error.setAttribute('role', 'alert'); error.textContent = snapshot.error?.message || '';
    retryHost.hidden = !snapshot.error || ['submitting', 'recovering', 'refreshing'].includes(snapshot.mutation);
    updateAttentionDismiss();
    retry.update({label: 'Retry', disabled: retryHost.hidden, onClick: () => {if (current()) void controller.retry();}});
    if (!checkpoint()) return;
    const desired = snapshot.status === 'ready' ? selected.album_refs : [];
    for (const [ref, row] of rows) if (!desired.includes(ref)) {disposeRow(row); rows.delete(ref);}
    const albums = new Map((data?.albums || []).map(album => [album.catalog_ref, album]));
    for (const [index, ref] of desired.entries()) {
      let row = rows.get(ref);
      const album = albums.get(ref), key = JSON.stringify(album);
      if (!row) {
        row = doc.createElement('div'); row.dataset.goalAlbumRef = ref; rows.set(ref, row);
        row.goalContextMenu = event => {
          const anchor = row.goalActionHost?.querySelector('button');
          if (!anchor || anchor.disabled || !current()) return;
          event.preventDefault(); openAlbumActions(ref, anchor);
        };
        row.addEventListener('contextmenu', row.goalContextMenu);
      }
      if (row.goalRenderKey !== key || row.goalCardRenderer !== runtime.galleryCardHtml || row.goalArtworkRenderer !== runtime.artboxHtml) {
        const artwork = runtime.artboxHtml({state: 'missing', label: `${album.title} artwork`});
        if (!checkpoint()) return;
        const markup = runtime.galleryCardHtml({identity: ref, title: album.title, artist: album.artist_display,
          year: album.first_release_date?.slice(0, 4) || '', interaction: 'none', displayMode: 'cards',
          artboxHtml: artwork, listeningSummaryHtml: ''});
        if (!checkpoint()) return;
        retireRowAction(row);
        if (!checkpoint()) return;
        row.innerHTML = markup;
        if (!checkpoint()) return;
        row.goalRenderKey = key; row.goalCardRenderer = runtime.galleryCardHtml; row.goalArtworkRenderer = runtime.artboxHtml;
      }
      const canAct = data.allowed_actions.can_complete || data.allowed_actions.can_remove;
      if (canAct && !row.goalActionOwner) {
        const actionHost = doc.createElement('div'); actionHost.className = 'gallery-card__actions';
        row.querySelector('.album-card').append(actionHost); row.goalActionHost = actionHost;
        row.goalActionOwner = mountButton(actionHost, runtime, {label: 'Goal album actions', icon: 'more-vertical', disabled: true});
        if (!checkpoint()) {retireRowAction(row); return;}
      }
      if (canAct) row.goalActionOwner.update({label: 'Goal album actions', icon: 'more-vertical', attributes: {'aria-haspopup': 'menu'},
        disabled: snapshot.mutation !== 'idle',
        onClick: event => openAlbumActions(ref, event.target.closest('button'))});
      if (!checkpoint()) return;
      if (!canAct && row.goalActionOwner) {const actionHost = row.goalActionHost; row.goalActionHost = null; retireRowAction(row); actionHost.remove();}
      if (!checkpoint()) return;
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
      if (!checkpoint()) return;
    }
    if (menuGuard && !menuGuard()) closeMenu();
  }
  function updateAttentionDismiss() {
    if (disposed || !dismissAttention) return;
    dismissAttentionHost.hidden = !attentionView?.canDismiss();
    dismissAttention.update({label:'Dismiss visit acknowledgment', disabled:dismissAttentionHost.hidden, onClick:()=>attentionView?.dismiss()});
    const snapshot = controller.getSnapshot();
    retryAttentionHost.hidden = !snapshot.attentionError || snapshot.mutation !== 'idle' || Boolean(snapshot.error);
    retryAttention.update({label:'Retry goal attention', disabled:retryAttentionHost.hidden,
      onClick:()=>{if (current()) void initial.owner.refreshAttention({immediate:true});}});
  }
  function dispose() {
    if (disposed) return; disposed = true; attentionView?.dispose(); dismissAttention?.dispose(); retryAttention?.dispose(); unsubscribe?.(); closeMenu(); closeDialog(); if (!initial.owner) {try {controller?.dispose();} finally {provider?.dispose();}}
    bonusSwitch?.dispose(); retry?.dispose(); start?.dispose(); add?.dispose(); reset?.dispose(); progress?.dispose(); choice?.dispose();
    for (const row of rows.values()) disposeRow(row);
    nodes.reverse().forEach(value => value.remove()); rows.clear();
  }
  try {
    if (initial.owner) {provider = initial.owner.provider; controller = initial.owner.controller;}
    else {provider = createGoalsProvider(initial.transport); controller = createGoalsController({provider, canDrawBonus:sourceCurrent});}
    const firstAction = initial.header.actions.firstChild;
    resetHost = node(initial.header.actions, 'span'); addHost = node(initial.header.actions, 'span'); periodHost = node(initial.header.actions, 'span');
    initial.header.actions.insertBefore(resetHost, firstAction); initial.header.actions.insertBefore(addHost, firstAction); initial.header.actions.insertBefore(periodHost, firstAction);
    progressHost = node(initial.header.content, 'span'); body = node(host);
    bonusHost = node(body);bonusHost.className='home-goals__bonus-controls';
    bonusSwitch = mountGoalBonusSwitch(bonusHost,runtime,{id:'goals-bonus-enabled',enabled:false,disabled:true,onClick:openBonusSettings});
    bonusOutcome = node(body,'p');bonusOutcome.setAttribute('role','status');
    emptyHost = node(body); emptyHost.className = 'home-goals__empty-state'; status = node(emptyHost); startHost = node(emptyHost, 'span'); error = node(body);
    retryHost = node(body, 'span'); body.className = 'home-recent__body gallery-scrollbar';
    list = node(body); list.className = 'home-recent__rows'; list.dataset.homeDisplay = 'cards';
    list.setAttribute('aria-label', 'Goal albums');
    choice = mountChoice(periodHost, runtime, {label: 'Period', options: periods, value: 'week'});
    progress = mountAlbumProgress(progressHost);
    reset = mountButton(resetHost, runtime, {label: 'Reset', icon: 'undo', disabled: true});
    start = mountButton(startHost, runtime, {label: 'Start', variant: 'primary', disabled: true});
    add = mountButton(addHost, runtime, {label: 'Add', icon: 'add', disabled: true});
    retry = mountButton(retryHost, runtime, {label: 'Retry', disabled: true});
    if (initial.owner) {
      dismissAttentionHost = node(body, 'span');
      dismissAttention = mountButton(dismissAttentionHost, runtime, {label:'Dismiss visit acknowledgment', disabled:true});
      retryAttentionHost = node(body, 'span');
      retryAttention = mountButton(retryAttentionHost, runtime, {label:'Retry goal attention', disabled:true});
      attentionView = createGoalsAttentionView({controller, visitState:initial.owner.visitState, document:doc,
        isCurrent:current, notify:(message, variant) => runtime.showOwnedToast?.(message, variant), onChange:updateAttentionDismiss,
        refreshAttention:options=>initial.owner.refreshAttention?.(options)});
      if (initial.visitIntent) attentionView.enter(initial.visitIntent);
    }
    let rendered = null;
    const panelKeys = ['status','data','period','mutation','error','bonusStatus','settings','bonus','outcome'];
    unsubscribe = controller.subscribe(() => {
      const next = controller.getSnapshot();
      if (rendered && panelKeys.every(key => rendered[key] === next[key])) return;
      rendered = next; render();
    });
    rendered = controller.getSnapshot(); render();
    const mountedState = controller.getSnapshot();
    if (mountedState.mutation === 'idle' && !mountedState.error && !['loading', 'ready'].includes(mountedState.bonusStatus)) void controller.loadBonus();
  } catch (error) {dispose(); throw error;}
  return {update(next) {if (next?.visitIntent) attentionView?.enter(next.visitIntent); render(); attentionView?.update();}, dispose};
}
