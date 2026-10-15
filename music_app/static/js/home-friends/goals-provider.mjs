// Home continuity is a delivery fence, never the ownership of account Goals.
export const GOAL_PERIODS = Object.freeze(['week', 'month', 'six-months', 'year']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000';
const revision = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const fail = () => {throw Object.assign(new Error('Goals response is unavailable.'), {status: 502});};
const abort = () => Object.assign(new Error('Goals request superseded.'), {name: 'AbortError'});
const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;};
export function normalizeGoals(value) {
  if (!object(value) || !(value.goal_ref === null || uuid(value.goal_ref)) || !revision(value.revision)
    || !object(value.periods) || !Array.isArray(value.albums) || value.allowed_actions?.can_read !== true) fail();
  const refs = new Set(), albums = value.albums.map(row => {
    if (!object(row) || !uuid(row.catalog_ref) || refs.has(row.catalog_ref)
      || !['title', 'artist_display'].every(key => typeof row[key] === 'string' && row[key].length > 0)
      || !['first_release_date', 'primary_type'].every(key => row[key] === null || typeof row[key] === 'string')) fail();
    refs.add(row.catalog_ref);
    return {catalog_ref: row.catalog_ref, title: row.title, artist_display: row.artist_display,
      first_release_date: row.first_release_date, primary_type: row.primary_type};
  });
  const periods = {};
  for (const period of GOAL_PERIODS) {
    const source = value.periods[period];
    if (!object(source) || source.period !== period || source.top_ref !== value.goal_ref || !Array.isArray(source.album_refs)
      || new Set(source.album_refs).size !== source.album_refs.length || source.album_refs.some(ref => !refs.has(ref))
      || source.total !== source.album_refs.length || !Number.isSafeInteger(source.completed) || source.completed < 0
      || source.completed > source.total || !object(source.manual_completed_at)) fail();
    const marks = {};
    for (const ref of source.album_refs) {
      const mark = source.manual_completed_at[ref];
      if (mark !== null && (typeof mark !== 'string' || !Number.isFinite(Date.parse(mark)))) fail();
      marks[ref] = mark;
    }
    if (Object.keys(source.manual_completed_at).length !== source.total
      || Object.values(marks).filter(mark => mark !== null).length !== source.completed) fail();
    let cycle = null;
    if (source.cycle !== null) {
      const row = source.cycle;
      if (!object(row) || !uuid(row.cycle_id) || typeof row.started_at !== 'string' || !Number.isFinite(Date.parse(row.started_at))
        || !['start_date', 'due_date'].every(key => date(row[key]))
        || typeof row.timezone_name !== 'string' || !row.timezone_name) fail();
      cycle = {cycle_id: row.cycle_id, started_at: row.started_at, start_date: row.start_date,
        due_date: row.due_date, timezone_name: row.timezone_name};
    } else if (source.total !== 0) fail();
    periods[period] = {period, cycle, album_refs: [...source.album_refs], manual_completed_at: marks,
      total: source.total, completed: source.completed};
  }
  if (value.goal_ref === null && (value.revision !== '1' || albums.length || GOAL_PERIODS.some(period => periods[period].cycle))) fail();
  return freeze({goal_ref: value.goal_ref, revision: value.revision, albums, periods,
    allowed_actions: {can_read: true, can_add: value.allowed_actions.can_add === true,
      can_reset: value.allowed_actions.can_reset === true}});
}
export function createGoalsProvider(transport) {
  let disposed = false, generation = 0;
  const listeners = new Set();
  const unsubscribe = transport.subscribe?.(() => {generation++; for (const listener of [...listeners]) listener();});
  async function request(path, options = {}) {
    if (disposed) throw abort();
    const context = transport.context(), epoch = generation;
    const current = () => !disposed && epoch === generation && !options.signal?.aborted
      && transport.context() === context && (options.isCurrent === undefined || options.isCurrent());
    const result = await transport.request(path, {...options, expected: context, isCurrent: current});
    if (!current()) throw abort();
    if (result?.context_ref !== context || result?.status !== 'ready' || !object(result.data)) fail();
    return result.data;
  }
  return Object.freeze({
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    async read(options) {return normalizeGoals(await request('/account/goals', options));},
    async reset(command, options) {return request('/account/goals/reset', {...options, method: 'POST', body: command});},
    async operation(key, options) {if (!uuid(key)) fail(); return request(`/account/goals/operations/${encodeURIComponent(key)}`, options);},
    dispose() {if (disposed) return; disposed = true; generation++; unsubscribe?.(); listeners.clear();},
  });
}
