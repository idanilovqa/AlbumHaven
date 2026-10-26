/** One optional visible-Top owner: four-item reads and one paced explicit advance. */
export function createCurrentTopListeningView({document, isCurrent, onChange, onBaselineChanged = () => {}}) {
  const window = document.defaultView;
  let disposed = false, options = null, request = null, timer = null, processing = false,
    stopped = false, message = '', targetRevision = null, dirty = new Set(), requestRefs = [];
  const cache = new Map();
  const visible = () => !disposed && options?.enabled === true && document.visibilityState !== 'hidden'
    && isCurrent() === true;
  function cancel() {if (timer !== null) window.clearTimeout(timer); timer = null; request?.abort(); request = null; requestRefs = [];}
  const hasWork = () => options?.itemRefs.some(ref => !cache.has(ref) || dirty.has(ref)
    || processing && cache.get(ref) && !cache.get(ref).unavailable && cache.get(ref).revision !== null
      && (cache.get(ref).continuation || cache.get(ref).baselineStatus === 'needs_explicit_start'));
  function schedule(delay = 1500) {
    if (!visible() || !hasWork() || timer !== null || request || stopped) return;
    timer = window.setTimeout(() => {timer = null; void step();}, delay);
  }
  async function step() {
    if (!visible() || request || stopped) return;
    const captured = options, controller = new AbortController();
    const refs = captured.itemRefs.filter(ref => !cache.has(ref) || dirty.has(ref)).slice(0, 4);
    const advance = !refs.length && processing ? captured.itemRefs.find(ref => {
      const row = cache.get(ref); return row && !row.unavailable && row.revision !== null
        && (row.continuation || row.baselineStatus === 'needs_explicit_start');
    }) : null;
    if (!refs.length && !advance) {processing = false; message = ''; onChange(); return;}
    const previous = advance ? cache.get(advance)?.revision : null;
    request = controller; requestRefs = advance ? [advance] : refs;
    const current = () => visible() && request === controller && options?.detail === captured.detail
      && options?.scopeKey === captured.scopeKey && options?.providers === captured.providers
      && options?.targetRevision === captured.targetRevision
      && requestRefs.every(ref => options.itemRefs.includes(ref));
    try {
      const args = {...captured, itemRefs: advance ? [advance] : refs,
        signal: controller.signal, isCurrent: current};
      const result = advance
        ? await captured.providers.advanceTopListening(args, previous)
        : await captured.providers.readTopListening(args);
      if (!current()) return;
      if (result.baselineChanged === true) {
        processing = false; stopped = true; message = 'Listening baseline started. Refreshing current progress…';
        onBaselineChanged(captured.detail.top_ref); return;
      }
      for (const [ref, incoming] of result.items) {
        let value = incoming;
        const prior = cache.get(ref)?.reportedEvidence;
        if (advance && incoming.reportedEvidence?.status === 'not_requested'
          && prior?.status === 'available' && prior.has_plays === true
          && prior.binding === incoming.reportedEvidence.binding) {
          const retained = {...prior, freshness: 'last-read-not-refreshed-by-advance'};
          value = {...incoming, reportedEvidence: retained, presentation: {...incoming.presentation,
            predicates: {...incoming.presentation.predicates, has_plays: true}, reported_evidence: retained}};
        }
        cache.set(ref, value); dirty.delete(ref);
      }
      // One terminal GET refreshes optional import predicates; never repeat the
      // import scan on each measured POST or poll an idle completed view.
      if (advance && result.items.get(advance)?.continuation === false
        && (result.items.get(advance)?.reportedEvidence?.status === 'not_requested'
          || result.items.get(advance)?.presentation?.predicates?.has_plays === null)) dirty.add(advance);
      if (advance && result.items.get(advance)?.revision === previous
        && result.items.get(advance)?.continuation) {
        stopped = true; processing = false; message = 'Progress paused. Update again to resume.';
      }
    } catch (error) {
      if (current() && error?.name !== 'AbortError') {
        stopped = true; processing = false; message = 'Listening progress unavailable. You can retry explicitly.';
      }
    } finally {
      if (request === controller) {
        request = null; requestRefs = [];
        if (!stopped && !hasWork()) {processing = false; message = "";}
        onChange(); schedule();
      }
    }
  }
  const visibility = () => {if (!visible()) cancel(); else schedule();};
  document.addEventListener('visibilitychange', visibility);
  return {
    update(next) {
      if (disposed) return;
      const changed = options && (options.detail !== next.detail || options.scopeKey !== next.scopeKey
        || options.providers !== next.providers || options.accountId !== next.accountId || options.libraryId !== next.libraryId);
      if (changed) {cancel(); cache.clear(); dirty.clear(); stopped = false; processing = false; targetRevision = null;}
      if (request && requestRefs.some(ref => !next.itemRefs.includes(ref))) cancel();
      options = {...next, itemRefs: [...new Set(next.itemRefs)].slice(0, 64)};
      if (targetRevision !== next.targetRevision) {
        for (const ref of options.itemRefs) dirty.add(ref);
        targetRevision = next.targetRevision;
      }
      if (!visible()) cancel(); else schedule();
    },
    start() {
      if (!visible()) return;
      stopped = false; processing = true; message = 'Updating visible albums…';
      for (const ref of options.itemRefs) dirty.add(ref);
      // Explicit intent owns the immediate timer before a synchronous render
      // can schedule the ordinary paced discovery timer. Do not abort an
      // already admitted request or create a second in-flight operation.
      if (timer !== null) window.clearTimeout(timer);
      timer = null; schedule(0); onChange();
    },
    presentation() {return Object.fromEntries([...cache].filter(([,row]) => row.presentation)
      .map(([,row]) => [row.presentation.album_ref,row.presentation]));},
    status: () => ({processing, message}),
    dispose() {if (disposed) return; disposed = true; cancel(); cache.clear(); dirty.clear();
      document.removeEventListener('visibilitychange', visibility); options = null;},
  };
}
