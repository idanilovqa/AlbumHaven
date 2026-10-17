const names = {week: 'Weekly', month: 'Monthly', 'six-months': 'Six-month', year: 'Yearly'};

// Presentation only. The caller supplies explicit navigation intent; this owner
// never infers a visit from hydration, focus, a saved tab or a receipt recovery.
export function createGoalsAttentionView({controller, visitState, document, isCurrent, notify, onChange = () => {}, refreshAttention = () => {}}) {
  let disposed = false, intent = null, lastEntered = null, period = null, token = null, shown = false, notice = null, noticeData = null, intentCycle = undefined, queued = false;
  let focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  let noticePeriod = null;
  let visibilityGeneration = 0;
  const current = () => {
    if (disposed || !focused || document.visibilityState === 'hidden') return false;
    try {return isCurrent() === true && !disposed && focused && document.visibilityState !== 'hidden';} catch {return false;}
  };
  const retireNotice = () => {const previous = notice; notice = null; noticeData = null; noticePeriod = null; try {previous?.dispose();} catch {}};
  const visibleIntent = captured => current() && intent === captured && controller.getSnapshot().period === period;
  function show(message, variant, expected) {
    retireNotice();
    if (!current() || controller.getSnapshot() !== expected || (typeof document.hasFocus === 'function' && !document.hasFocus())) return;
    const captured = intent, state = controller.getSnapshot(), selected = state.period;
    let owned;
    try {owned = notify?.(message, variant);} catch {return;}
    if (!current() || intent !== captured || controller.getSnapshot().period !== selected || controller.getSnapshot().data !== state.data || controller.getSnapshot().status !== 'ready') {try {owned?.dispose();} catch {}}
    else {notice = owned; noticeData = controller.getSnapshot().data; noticePeriod = selected;}
  }
  function reconcile() {
    if (disposed) return;
    const state = controller.getSnapshot();
    if (state.status === 'denied' || state.mutation === 'idle' && !state.error) visitState.pendingToken = null;
    const active = current();
    if (!active || state.status !== 'ready' || notice && (state.data !== noticeData || state.period !== noticePeriod)) retireNotice();
    if (!active || state.period !== period || state.status !== 'ready') token = null;
    if (!intent || !visibleIntent(intent) || state.status !== 'ready' || state.mutation !== 'idle'
      || state.attentionStatus !== 'ready' || state.error || controller.getSnapshot() !== state) {onChange(); return;}
    const attention = state.attention, selected = attention?.periods[state.period];
    const goal = state.data?.periods[state.period];
    if (!selected || attention.goal_ref !== state.data.goal_ref || attention.revision !== state.data.revision
      || selected.cycle_id !== (goal.cycle?.cycle_id ?? null) || selected.total !== goal.total || selected.completed !== goal.completed) return;
    if (!shown) {
      shown = true;
      if (selected.total > 0 && selected.due) show(`${names[state.period]} Goals period has ended. Completed ${selected.completed} of ${selected.total} albums. Use Reset to start the next period; remove albums or keep unfinished albums to repeat them.`, 'info', state);
      else if (selected.total > 0 && selected.achieved) show(`${names[state.period]} Goals achieved. Completed ${selected.completed} of ${selected.total} albums.`, 'success', state);
    }
    if (controller.getSnapshot() !== state) return;
    if (state.period === 'week' && attention.weekly_event && !attention.weekly_acknowledged && !token && !visitState.pendingToken) {
      const captured = intent;
      const acquired = controller.createVisit({isCurrent: () => visibleIntent(captured)});
      if (!acquired || !visibleIntent(captured)) return;
      token = acquired; visitState.pendingToken = acquired;
      void controller.acknowledgeVisit(acquired).then(() => {
        const latest = controller.getSnapshot();
        if (latest.mutation === 'idle' && !latest.error && visitState.pendingToken === acquired) visitState.pendingToken = null;
        if (!disposed) onChange();
      });
    }
    onChange();
  }
  function schedule() {
    if (disposed || queued) return; queued = true;
    queueMicrotask(() => {queued = false; if (!disposed) reconcile();});
  }
  const unsubscribe = controller.subscribe(() => {
    const state = controller.getSnapshot();
    if (notice && (state.status !== 'ready' || state.data !== noticeData || state.period !== noticePeriod)) retireNotice();
    const cycle = state.data?.periods[state.period]?.cycle?.cycle_id ?? null;
    if (intent && (state.period !== period || ['denied','idle'].includes(state.status) || state.data && intentCycle !== undefined && cycle !== intentCycle)) {
      intent = null; token = null; retireNotice();
    } else if (intent && state.data && intentCycle === undefined) intentCycle = cycle;
    schedule();
  });
  const hidden = () => {
    if (document.visibilityState === 'hidden') {visibilityGeneration++; intent = null; token = null; retireNotice();}
  };
  const blur = () => {visibilityGeneration++; focused = false; retireNotice();};
  const focus = () => {focused = true; schedule();};
  document.addEventListener('visibilitychange', hidden);
  document.defaultView?.addEventListener('blur', blur);
  document.defaultView?.addEventListener('focus', focus);
  return {
    enter(value) {
      if (disposed || !value || value === lastEntered) return;
      lastEntered = value;
      if (document.visibilityState === 'hidden') return;
      retireNotice(); intent = value; period = controller.getSnapshot().period; intentCycle = controller.getSnapshot().data ? controller.getSnapshot().data.periods[period].cycle?.cycle_id ?? null : undefined; token = null; shown = false; schedule();
      if (current() && controller.getSnapshot().status === 'ready') void refreshAttention();
    },
    update: schedule,
    canDismiss() {
      const state = controller.getSnapshot();
      return Boolean(visitState.pendingToken) && !['submitting', 'recovering', 'refreshing'].includes(state.mutation)
        && Boolean(state.error);
    },
    dismiss() {
      const pending = visitState.pendingToken;
      if (!current() || !pending || !controller.dismissAttentionAcknowledgment(pending)) return false;
      if (visitState.pendingToken === pending) visitState.pendingToken = null;
      intent = null; token = null; retireNotice(); onChange(); void refreshAttention({immediate:true}); return true;
    },
    completed(promise, before) {
      const captured = intent, visibility = visibilityGeneration, selectedPeriod = before.period, prior = before.data?.periods[selectedPeriod];
      if (!current() || controller.getSnapshot().period !== selectedPeriod || !prior?.cycle || prior.total === 0 || prior.completed === prior.total) return;
      void promise.then(() => {
        const after = controller.getSnapshot(), next = after.data?.periods[selectedPeriod];
        if (!current() || visibility !== visibilityGeneration || intent !== captured || after.status !== 'ready' || after.mutation !== 'idle' || after.error
          || after.period !== selectedPeriod || after.data === before.data || next?.cycle?.cycle_id !== prior.cycle.cycle_id
          || next.total === 0 || next.completed !== next.total) return;
        shown = true; show(`${names[selectedPeriod]} Goals achieved. Completed ${next.completed} of ${next.total} albums.`, 'success', after);
      });
    },
    dispose() {
      if (disposed) return; disposed = true; intent = null; token = null;
      try {unsubscribe();} finally {retireNotice(); document.removeEventListener('visibilitychange', hidden); document.defaultView?.removeEventListener('blur', blur); document.defaultView?.removeEventListener('focus', focus);}
    },
  };
}
