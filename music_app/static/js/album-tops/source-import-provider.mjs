// Private source evidence remains inert. Only explicit selectors reach Top creation.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const uuid = value => typeof value === 'string' && value.length === 36 && value !== '00000000-0000-0000-0000-000000000000'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const revision = value => typeof value === 'string' && value.length <= 19 && /^[1-9][0-9]*$/.test(value)
  && !/[^0-9]/.test(value) && BigInt(value) <= 9223372036854775807n;
const rowRef = value => typeof value === 'string' && value.length <= 4 && /^[1-9][0-9]*$/.test(value)
  && !/[^0-9]/.test(value) && Number(value) <= 5000;
const positive = value => Number.isSafeInteger(value) && value > 0;
const rank = value => value === null || positive(value) && value <= 9999;
const kinds = new Set(['text', 'pasted_html', 'uploaded_html', 'url']);
const error = (local = false) => Object.assign(new Error('Source import response or command is invalid.'),
  {status: local ? 400 : 502, ...(local ? {responseRejected: true} : {})});
function check(valid, local = false) {if (!valid) throw error(local);}
function text(value, maximum = Infinity) {
  if (typeof value !== 'string' || value.includes('\0')) return false;
  const chars = Array.from(value);
  return chars.length <= maximum && chars.every(char => char.codePointAt(0) < 0xd800 || char.codePointAt(0) > 0xdfff);
}
// Match the existing server title normalizer, including Python's C0/NEL spaces.
const stripTitle = value => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
function titles(value, local) {
  check(text(value.title) && text(value.description, 1000), local);
  const title = stripTitle(value.title); check(title.length > 0 && text(title, 100), local);
  return {title, description: value.description};
}
function bounded(value, local) {check(new TextEncoder().encode(JSON.stringify(value)).byteLength <= 512 * 1024, local); return value;}
function freeze(value) {
  if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
  return value;
}
function source(value, local = false) {
  check(keys(value, ['request_key', 'title', 'description', 'kind', 'filename', 'content']) && uuid(value.request_key)
    && kinds.has(value.kind) && text(value.content) && stripTitle(value.content).length > 0, local);
  check(value.kind === 'uploaded_html' ? text(value.filename, 255) && stripTitle(value.filename).length > 0
    && !['.', '..'].includes(value.filename) && !/[\x00-\x1f\x7f/\\:]/.test(value.filename) : value.filename === null, local);
  return bounded({request_key: value.request_key, ...titles(value, local), kind: value.kind,
    filename: value.filename, content: value.content}, local);
}
function date(value) {
  if (typeof value !== 'string' || value.length > 32 || /[\r\n]/.test(value)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}
function review(value) {
  check(object(value) && [1, 2].includes(value.parser_version) && value.state === 'review_required'
    && Array.isArray(value.rows) && value.rows.length <= 5000 && Array.isArray(value.issues)
    && value.issues.length <= 5000 && value.issues.every(issue => text(issue)));
  const refs = new Set();
  const rows = value.rows.map(row => {
    check(object(row) && rowRef(row.row_ref) && !refs.has(row.row_ref) && positive(row.candidate_line)
      && text(row.raw_text) && rank(row.explicit_rank) && row.catalog_ref === null && row.match_state === 'unresolved');
    refs.add(row.row_ref);
    return {row_ref: row.row_ref, candidate_line: row.candidate_line, raw_text: row.raw_text,
      explicit_rank: row.explicit_rank, catalog_ref: null, match_state: 'unresolved'};
  });
  const order = value.ordered_row_refs;
  check(order === null || Array.isArray(order) && order.length === rows.length
    && new Set(order).size === rows.length && order.every(ref => refs.has(ref)));
  return {parser_version: value.parser_version, state: value.state, rows, issues: [...value.issues],
    ordered_row_refs: order === null ? null : [...order]};
}
function projectJob(value, detail) {
  check(object(value) && uuid(value.job_ref) && uuid(value.request_key) && revision(value.revision)
    && ['queued', 'running', 'completed', 'failed', 'canceled'].includes(value.status)
    && text(value.title, 100) && stripTitle(value.title).length > 0 && kinds.has(value.kind)
    && date(value.created_at) && date(value.updated_at)
    && value.error === (value.status === 'failed' ? 'source_processing_failed' : null)
    && (value.top_ref === null || uuid(value.top_ref)));
  check(value.phase === (value.top_ref !== null ? 'top_created' : value.status === 'completed' ? 'review_evidence' : 'source_processing'));
  check(value.top_ref === null || value.status === 'completed');
  const result = Object.fromEntries(['job_ref','request_key','status','revision','title','kind','created_at','updated_at','phase','error','top_ref'].map(key => [key, value[key]]));
  if (detail) {
    result.source = source(value.source);
    check(result.source.request_key === result.request_key && result.source.title === result.title && result.source.kind === result.kind);
    check(value.review !== null || value.status !== 'completed');
    check(value.review === null || ['completed', 'canceled'].includes(value.status));
    result.review = value.review === null ? null : review(value.review);
  }
  return freeze(result);
}
export function sourceImportSelection(value) {
  if (value === null) return null;
  if (keys(value, ['kind', 'album_ref']) && value.kind === 'local_catalog' && uuid(value.album_ref))
    return freeze({kind: value.kind, album_ref: value.album_ref});
  check(keys(value, ['kind', 'acquisition_ref', 'evidence_version']) && value.kind === 'remote_acquisition'
    && uuid(value.acquisition_ref) && typeof value.evidence_version === 'string' && value.evidence_version.length === 64
    && /^[0-9a-f]{64}$/.test(value.evidence_version), true);
  return freeze({kind: value.kind, acquisition_ref: value.acquisition_ref, evidence_version: value.evidence_version});
}
function finalCommand(value) {
  check(keys(value, ['request_key','title','description','source_review']) && uuid(value.request_key)
    && keys(value.source_review, ['job_ref','revision','rows']), true);
  const input = value.source_review;
  check(input.job_ref === value.request_key && revision(input.revision) && Array.isArray(input.rows)
    && input.rows.length > 0 && input.rows.length <= 5000, true);
  const refs = new Set(), rows = Array.from(input.rows, row => {
    check(keys(row, ['row_ref','selection']) && rowRef(row.row_ref) && !refs.has(row.row_ref), true);
    refs.add(row.row_ref); return {row_ref: row.row_ref, selection: sourceImportSelection(row.selection)};
  });
  check(rows.some(row => row.selection !== null), true);
  return bounded({request_key: value.request_key, ...titles(value, true), source_review: {job_ref: input.job_ref, revision: input.revision, rows}}, true);
}
function receipt(value, command) {
  check(object(value) && value.action === 'create' && value.request_key === command.request_key
    && uuid(value.top_ref) && value.revision === '1' && value.source_job_ref === command.source_review.job_ref
    && value.source_locked === true && value.source_derived === true && Array.isArray(value.source_report)
    && value.source_report.length === command.source_review.rows.length);
  const first = new Map();
  const report = value.source_report.map((row, index) => {
    const intended = command.source_review.rows[index];
    check(object(row) && row.row_ref === intended.row_ref && row.position === index + 1 && rank(row.original_explicit_rank));
    if (intended.selection === null) check(row.outcome === 'unresolved' && row.catalog_ref === null && row.retained_row_ref === null);
    else {
      check(uuid(row.catalog_ref));
      if (intended.selection.kind === 'local_catalog') check(row.catalog_ref === intended.selection.album_ref);
      if (first.has(row.catalog_ref)) check(row.outcome === 'duplicate' && row.retained_row_ref === first.get(row.catalog_ref));
      else {check(row.outcome === 'matched' && row.retained_row_ref === null); first.set(row.catalog_ref, row.row_ref);}
    }
    return {row_ref: row.row_ref, position: row.position, original_explicit_rank: row.original_explicit_rank,
      catalog_ref: row.catalog_ref, outcome: row.outcome, retained_row_ref: row.retained_row_ref};
  });
  check(first.size > 0);
  return freeze({action: 'create', request_key: value.request_key, top_ref: value.top_ref, revision: '1',
    source_job_ref: value.source_job_ref, source_locked: true, source_derived: true, source_report: report});
}
export function sourceImportCommand(value) {return freeze(source(value, true));}

export function createSourceImportProviders({request}) {
  async function jobRequest(options, suffix, body) {
    const jobRef = options.job_ref;
    check(uuid(jobRef), true);
    const result = projectJob(await request(`/album-tops/source-imports/${jobRef}${suffix}`, options, body), true);
    check(result.job_ref === jobRef); return result;
  }
  return Object.freeze({
    async submitSourceImport(options) {
      const command = sourceImportCommand(options.command);
      const result = projectJob(await request('/album-tops/source-imports', options, command), true);
      check(result.request_key === command.request_key && Object.keys(command).every(key => result.source[key] === command[key]));
      return result;
    },
    readSourceImport: options => jobRequest(options, ''),
    processSourceImport: options => jobRequest(options, '/process', {}),
    cancelSourceImport: options => jobRequest(options, '/cancel', {}),
    async listSourceImports(options) {
      const cursor = options.cursor ?? null; check(cursor === null || uuid(cursor), true);
      const value = await request('/album-tops/source-imports' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), options);
      check(object(value) && Array.isArray(value.jobs) && value.jobs.length <= 50 && (value.next_cursor === null || uuid(value.next_cursor)));
      const jobs = value.jobs.map(value => projectJob(value, false));
      check(new Set(jobs.map(value => value.job_ref)).size === jobs.length);
      return freeze({jobs, next_cursor: value.next_cursor});
    },
    async finalizeSourceImport(options) {
      const command = freeze(finalCommand(options.command));
      return receipt(await request('/album-tops', options, command), command);
    },
  });
}
