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
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const trim = value => value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
const textValue = (value, limit, blank = false) => typeof value === 'string' && [...value].length <= limit
  && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value) && (blank || trim(value).length > 0);
const partialDate = value => value === null || (typeof value === 'string'
  && /^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?$/.test(value) && value.slice(0, 4) !== '0000'
  && date(value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value));
function albumPreview(value) {
  if (!exactKeys(value, ['title', 'artist_display', 'first_release_date', 'primary_type'])
    || !textValue(value.title, 1000) || !textValue(value.artist_display, 1000)
    || !partialDate(value.first_release_date) || ![null, 'Album', 'Single', 'EP', 'Broadcast', 'Other'].includes(value.primary_type)) fail();
  return {title: value.title, artist_display: value.artist_display,
    first_release_date: value.first_release_date, primary_type: value.primary_type};
}
export function normalizeGoalSearchQuery(query) {
  if (!exactKeys(query, ['title', 'artist']) || !textValue(query.title, 100) || !textValue(query.artist, 100, true)) {
    throw Object.assign(new Error('Enter a title and optional artist, up to 100 characters each.'), {status: 400, code: 'invalid_search_query'});
  }
  return Object.freeze({title: trim(query.title), artist: trim(query.artist)});
}
export function normalizeGoalSearch(value) {
  if (!exactKeys(value, ['limit', 'candidates']) || value.limit !== 10
    || !Array.isArray(value.candidates) || value.candidates.length > 10) fail();
  const seen = new Set();
  const candidates = value.candidates.map(row => {
    if (!exactKeys(row, ['provider', 'entity_kind', 'release_group_id', 'title', 'artist_display', 'first_release_date', 'primary_type'])
      || row.provider !== 'musicbrainz' || row.entity_kind !== 'release-group'
      || !uuid(row.release_group_id) || seen.has(row.release_group_id)) fail();
    seen.add(row.release_group_id);
    const {title, artist_display, first_release_date, primary_type} = row;
    return {provider: 'musicbrainz', entity_kind: 'release-group', release_group_id: row.release_group_id,
      ...albumPreview({title, artist_display, first_release_date, primary_type})};
  });
  return freeze({limit: 10, candidates});
}
export function normalizeGoalEvidence(value) {
  if (!exactKeys(value, ['evidence_ref', 'evidence_version', 'expires_at', 'album']) || !uuid(value.evidence_ref)
    || typeof value.evidence_version !== 'string' || !/^[0-9a-f]{64}$/.test(value.evidence_version)
    || typeof value.expires_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.expires_at)
    || value.expires_at.slice(0, 4) === '0000'
    || !Number.isFinite(Date.parse(value.expires_at)) || !date(value.expires_at.slice(0, 10))) fail();
  return freeze({evidence_ref: value.evidence_ref, evidence_version: value.evidence_version,
    expires_at: value.expires_at, album: albumPreview(value.album)});
}
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
      can_reset: value.allowed_actions.can_reset === true,
      can_complete: value.allowed_actions.can_complete === true, can_remove: value.allowed_actions.can_remove === true}});
}
export function createGoalsProvider(transport) {
  let disposed = false, generation = 0;
  const listeners = new Set(), evidenceOwners = new WeakMap();
  const unsubscribe = transport.subscribe?.(() => {generation++; for (const listener of [...listeners]) listener();});
  async function request(path, options = {}) {
    if (disposed) throw abort();
    const context = transport.context(), epoch = generation;
    const current = () => !disposed && epoch === generation && !options.signal?.aborted
      && transport.context() === context && (options.isCurrent === undefined || options.isCurrent());
    if (!current()) throw abort();
    const result = await transport.request(path, {...options, expected: context, isCurrent: current});
    if (!current()) throw abort();
    if (result?.context_ref !== context || result?.status !== 'ready' || !object(result.data)) fail();
    return result.data;
  }
  return Object.freeze({
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    async read(options) {return normalizeGoals(await request('/account/goals', options));},
    async search(query, options) {
      const body = normalizeGoalSearchQuery(query);
      return normalizeGoalSearch(await request('/account/goals/remote-search', {...options, method: 'POST', body}));
    },
    async evidence(selection, options) {
      if (!exactKeys(selection, ['release_group_id']) || !uuid(selection.release_group_id)) fail();
      const epoch = generation, context = transport.context();
      const value = normalizeGoalEvidence(await request('/account/goals/remote-evidence',
        {...options, method: 'POST', body: Object.freeze({release_group_id: selection.release_group_id})}));
      if (disposed || epoch !== generation || transport.context() !== context || options?.signal?.aborted
        || (options?.isCurrent && !options.isCurrent())) throw abort();
      evidenceOwners.set(value, {epoch, context});
      return value;
    },
    isEvidenceCurrent(value) {
      const owner = object(value) && evidenceOwners.get(value);
      if (!owner || disposed) return false;
      try {const context = transport.context(); return !disposed && owner.epoch === generation && context === owner.context;} catch {return false;}
    },
    async add(command, options) {return request('/account/goals/add', {...options, method: 'POST', body: command});},
    async reset(command, options) {return request('/account/goals/reset', {...options, method: 'POST', body: command});},
    async completion(command, options) {return request('/account/goals/completion', {...options, method: 'POST', body: command});},
    async remove(command, options) {return request('/account/goals/remove', {...options, method: 'POST', body: command});},
    async operation(key, options) {if (!uuid(key)) fail(); return request(`/account/goals/operations/${encodeURIComponent(key)}`, options);},
    dispose() {if (disposed) return; disposed = true; generation++; unsubscribe?.(); listeners.clear();},
  });
}
