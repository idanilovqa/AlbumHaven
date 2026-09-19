function normalizeUtilityLogHistoryQuery(draft, { now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const parts = value => Object.fromEntries(formatter.formatToParts(value).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const parseDate = text => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text || ''))) throw new Error('Choose a valid date range.');
    const [year, month, day] = text.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Choose valid calendar dates.');
    return date;
  };
  const local = parts(new Date(now));
  let start, end;
  if (draft?.preset === 'custom') {
    start = parseDate(draft.fromDate); end = parseDate(draft.toDate);
    if (start > end) throw new Error('The start date must precede the end date.');
  } else {
    const days = { today: 1, '7-days': 7, '30-days': 30 }[draft?.preset];
    if (!days) throw new Error('Choose a date preset.');
    end = new Date(Date.UTC(local.year, local.month - 1, local.day));
    start = new Date(end.getTime() - (days - 1) * 86400000);
  }
  end = new Date(end.getTime() + 86400000);
  const dayBoundaryUtc = date => {
    const target = date.getTime();
    const representedTime = value => {
      const p = parts(new Date(value));
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    };
    // Check both sides of offset changes so a repeated midnight uses its first occurrence.
    const midnights = [];
    for (let hours = -48; hours <= 48; hours += 6) {
      const sample = target + hours * 3600000;
      const candidate = target - (representedTime(sample) - sample);
      if (representedTime(candidate) === target) midnights.push(candidate);
    }
    if (midnights.length) return new Date(Math.min(...midnights)).toISOString();
    // Midnight can be skipped. Find the first valid instant reaching this calendar day.
    let before = target / 1000 - 48 * 3600;
    let after = target / 1000 + 48 * 3600;
    while (after - before > 1) {
      const middle = Math.floor((before + after) / 2);
      const p = parts(new Date(middle * 1000));
      if (Date.UTC(p.year, p.month - 1, p.day) < target) before = middle;
      else after = middle;
    }
    return new Date(after * 1000).toISOString();
  };
  const list = value => Array.from(new Set((Array.isArray(value) ? value : []).map(item => String(item).trim()).filter(Boolean))).sort();
  return { from_utc: dayBoundaryUtc(start), to_utc: dayBoundaryUtc(end), sources: list(draft.sources), event_types: list(draft.event_types), text: String(draft.text || '').trim(), event_ids: [] };
}

function createUtilityLogHistoryQueryController({ fetchPage, exportQuery, contextKey, now = () => new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, onChange = () => {}, onAccepted = () => {} }) {
  let epoch = 0, navigationEpoch = 0, context = contextKey, previousSelection = '', temporarySerial = 0, periodCapture = null;
  let state = { query: null, snapshot: null, items: [], selectedEventId: '', temporaryRowId: null, draft: null, stale: false, refreshRequired: false, error: '', loading: false, nextCursor: null, revision: '' };
  const emit = () => onChange({ ...state });
  const capture = async (query, selection, temporary, metadata = {}) => {
    const token = ++epoch;
    const baseToken = Object.keys(query).length === 0 ? ++navigationEpoch : null;
    state.loading = true; state.error = ''; emit();
    try {
      const page = await fetchPage({ query, cursor: null, snapshot: null, page_size: 500 });
      if (token !== epoch) return;
      state = { ...state, query, snapshot: page.snapshot, items: page.items || [], nextCursor: page.next_cursor || null, revision: page.revision || '', selectedEventId: selection, temporaryRowId: temporary, ...metadata, draft: null, stale: false, refreshRequired: false, error: '' };
      onAccepted({ query, items: state.items, page, publishNavigation: baseToken === navigationEpoch });
      if (!selection && temporary) periodCapture = { ...state, loading: false };
    } catch (error) {
      if (token !== epoch) return;
      state.error = error.message || String(error); throw error;
    } finally { if (token === epoch) { state.loading = false; emit(); } }
  };
  return {
    getState: () => ({ ...state }),
    beginDraft(draft = { preset: 'today' }) { state.draft = { ...draft }; emit(); },
    cancelDraft() { state.draft = null; emit(); },
    async applyDraft() {
      if (!state.draft) throw new Error('No query draft is open.');
      const query = normalizeUtilityLogHistoryQuery(state.draft, { now: typeof now === 'function' ? now() : now, timeZone });
      const dates = new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'medium' });
      const periodLabel = `${dates.format(new Date(query.from_utc))} – ${dates.format(new Date(new Date(query.to_utc).getTime() - 1))} · ${timeZone}`;
      if (!state.temporaryRowId) previousSelection = state.selectedEventId;
      const row = state.temporaryRowId || `log-query-${++temporarySerial}`;
      return capture(query, '', row, { periodLabel });
    },
    clear() { ++epoch; periodCapture = null; state = { ...state, temporaryRowId: null, periodLabel: undefined, query: null, snapshot: null, items: [], selectedEventId: previousSelection, draft: null, nextCursor: null, loading: false, error: '', stale: false, refreshRequired: false }; emit(); },
    selectEvent(id) { return capture({ event_ids: [String(id)] }, String(id), state.temporaryRowId); },
    selectPeriod() { if (!periodCapture) return; ++epoch; state = { ...periodCapture, draft: null, loading: false }; emit(); },
    refresh() { if (!state.query) return capture({}, '', null); return capture(state.query, state.selectedEventId, state.temporaryRowId); },
    async refreshNavigation() {
      const token = ++navigationEpoch, capturedContext = context;
      const page = await fetchPage({ query: {}, cursor: null, snapshot: null, page_size: 500 });
      if (token !== navigationEpoch || capturedContext !== context) return;
      onAccepted({ query: {}, items: page.items || [], page, navigationOnly: true, publishNavigation: true });
      emit();
    },
    async loadMore() {
      if (!state.nextCursor || state.loading || state.refreshRequired) return;
      const token = epoch;
      const baseToken = Object.keys(state.query || {}).length === 0 ? ++navigationEpoch : null;
      state.loading = true; state.error = ''; emit();
      try {
        const page = await fetchPage({ query: state.query, cursor: state.nextCursor, snapshot: state.snapshot, page_size: 500 });
        if (token !== epoch) return;
        if (page.snapshot !== state.snapshot) throw new Error('The log snapshot changed. Refresh to continue.');
        const items = new Map(state.items.map(item => [item.id, item]));
        (page.items || []).forEach(item => { if (!items.has(item.id)) items.set(item.id, item); });
        state.items = Array.from(items.values()); state.nextCursor = page.next_cursor || null;
        onAccepted({ query: state.query, items: state.items, page, publishNavigation: baseToken === navigationEpoch });
        if (!state.selectedEventId && state.temporaryRowId) periodCapture = { ...state, loading: false };
      } catch (error) { if (token !== epoch) return; state.error = error.message || String(error); if (error.status === 410) state.refreshRequired = true; throw error; }
      finally { if (token === epoch) { state.loading = false; emit(); } }
    },
    markStale(revision) { if (periodCapture && String(revision || '') !== String(periodCapture.revision || '')) periodCapture.stale = true; if (state.snapshot && String(revision || '') !== String(state.revision || '')) { state.stale = true; emit(); } },
    setContext(next) { if (next === context) return; context = next; ++epoch; ++navigationEpoch; previousSelection = ''; periodCapture = null; state = { query: null, snapshot: null, items: [], selectedEventId: '', temporaryRowId: null, draft: null, stale: false, refreshRequired: false, error: '', loading: false, nextCursor: null, revision: '' }; emit(); },
    async exportCurrent() {
      if (!state.query || !state.snapshot || (state.selectedEventId && !state.items.some(item => String(item.id) === state.selectedEventId))) throw new Error('Select an available log query before exporting.');
      const token = epoch;
      try {
        const result = await exportQuery({ query: state.query, snapshot: state.snapshot });
        if (token !== epoch) throw new Error('The log context changed before export completed.');
        return result;
      } catch (error) {
        if (token === epoch) { state.error = error.message || String(error); if (error.status === 410) state.refreshRequired = true; emit(); }
        throw error;
      }
    },
  };
}
