// Native, preview-only UI contract. No persistence or import authority.
export const PROTOCOL = 'foobar_preview_v1';
export const MAPPING = 'foobar_text_tools_snapshot_v1';
export const MAX_INPUT_BYTES = 67108864;
export const MAX_RESPONSE_BYTES = 262144;
export const MAX_WINDOW_ROWS = 100;
export const CAPABILITIES_URL = '/integrations/foobar/preview-capabilities';
export const PREVIEW_URL = '/integrations/foobar/preview';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = () => { throw new Error('Invalid preview response.'); };
export const SUMMARY_KEYS = Object.freeze(['rows_total', 'exact_unique_rows', 'ambiguous_rows', 'unmatched_rows', 'identity_conflict_rows', 'duplicate_target_groups', 'duplicate_target_rows', 'rows_with_field_errors', 'unsupported_nonempty_field_count']);
export const FIELD_CATEGORIES = Object.freeze({rating:'source_taste_observation',play_count:'aggregate_count',play_count_enhanced:'aggregate_count',first_played:'raw_date_boundary',last_played:'raw_date_boundary',added:'raw_date_boundary',first_played_enhanced:'raw_date_boundary',last_played_enhanced:'raw_date_boundary',added_enhanced:'raw_date_boundary',favorite:'source_taste_observation',played_times:'local_history_field_unparsed',played_times_js:'local_history_field_unparsed',played_times_raw:'local_history_field_unparsed',lastfm_played_times_js:'lastfm_history_field_unparsed',lastfm_play_count:'lastfm_count_field_unparsed'});
const states = new Set(['absent','empty','unavailable','valid','invalid','unsupported']);
const matches = new Set(['exact_unique','ambiguous','unmatched','identity_conflict']);

export function validateCapabilities(value, expected) {
  if (!exact(value, ['protocol','status','mapping','context_ref','max_input_bytes','max_response_bytes','max_window_rows']) || value.protocol !== PROTOCOL || !digest(expected) || value.context_ref !== expected || !['available','unavailable'].includes(value.status) || value.mapping !== MAPPING || value.max_input_bytes !== MAX_INPUT_BYTES || value.max_response_bytes !== MAX_RESPONSE_BYTES || value.max_window_rows !== MAX_WINDOW_ROWS) fail();
  return Object.freeze({...value});
}

export function validatePage(value, requestedOffset, expected) {
  if (!exact(value, ['protocol','status','mapping','context_ref','source_sha256','inventory_revision','offset','total_rows','returned_rows','next_offset','summary','rows']) || value.protocol !== PROTOCOL || !digest(expected) || value.context_ref !== expected || value.status !== 'preview_only' || value.mapping !== MAPPING || !digest(value.source_sha256) || !digest(value.inventory_revision) || !integer(value.offset,99999) || value.offset !== requestedOffset || !integer(value.total_rows,100000) || !integer(value.returned_rows,MAX_WINDOW_ROWS) || !Array.isArray(value.rows) || value.rows.length !== value.returned_rows || !exact(value.summary,SUMMARY_KEYS)) fail();
  if (value.returned_rows !== Math.min(MAX_WINDOW_ROWS, Math.max(0,value.total_rows-value.offset))) fail();
  const next = value.offset + value.returned_rows;
  if (value.next_offset !== (next < value.total_rows ? next : null)) fail();
  for (const key of SUMMARY_KEYS) if (!integer(value.summary[key],3000000)) fail();
  if (value.summary.rows_total !== value.total_rows || value.summary.exact_unique_rows + value.summary.ambiguous_rows + value.summary.unmatched_rows + value.summary.identity_conflict_rows !== value.total_rows) fail();
  const rows = value.rows.map((row,index) => {
    if (!exact(row,['ordinal','line_number','match_status','candidate_count','candidates_truncated','duplicate_target','fields']) || row.ordinal !== value.offset+index+1 || !integer(row.line_number,100001) || row.line_number < 2 || !matches.has(row.match_status) || !integer(row.candidate_count,100000) || typeof row.candidates_truncated !== 'boolean' || typeof row.duplicate_target !== 'boolean' || !Array.isArray(row.fields) || row.fields.length > Object.keys(FIELD_CATEGORIES).length) fail();
    if (row.line_number !== row.ordinal+1) fail();
    const seen = new Set();
    const fields = row.fields.map(field => {
      if (!exact(field,['name','category','state']) || !Object.hasOwn(FIELD_CATEGORIES,field.name) || FIELD_CATEGORIES[field.name] !== field.category || !states.has(field.state) || seen.has(field.name)) fail();
      seen.add(field.name); return Object.freeze({...field});
    });
    return Object.freeze({...row,fields:Object.freeze(fields)});
  });
  return Object.freeze({...value,summary:Object.freeze({...value.summary}),rows:Object.freeze(rows)});
}

export function validateFile(file) {
  if (!file || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_INPUT_BYTES || !/\.tsv$/i.test(file.name)) throw new Error('Choose a nonempty UTF-8 TSV file, at most 64 MiB.');
  return file;
}

// Only rejection of the body reader's actual I/O await receives this marker.
export class PreviewBodyInterruptedError extends Error {
  constructor(){super('Preview response transport was interrupted.');this.name='PreviewBodyInterruptedError';}
}

export async function readBoundedJSON(response, signal) {
  if (!response || response.redirected || !response.headers?.get('content-type')?.toLowerCase().startsWith('application/json')) fail();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) fail();
  const reader = response.body?.getReader();
  if (!reader) fail();
  const decoder = new TextDecoder('utf-8',{fatal:true});
  let bytes=0, text='';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted','AbortError');
      let item;
      try { item = await reader.read(); }
      catch { throw new PreviewBodyInterruptedError(); }
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) fail();
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) fail();
      text += decoder.decode(item.value,{stream:true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
