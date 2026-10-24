export const BASE = '/integrations/foobar/account';
export const PROTOCOL = 'foobar_account_history_v1', SCOPE = 'account-foobar-v1';
export const MAX_RESPONSE_BYTES = 131072, PAGE_SIZE = 20;
const MAX = '9223372036854775807', MIN = '-9223372036854775808';
export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (code = 'unavailable') => {throw Object.assign(new Error('Invalid Foobar history response.'), {code});};
export const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
  && (value.length < 19 || value <= MAX);
const signed = value => decimal(value) || typeof value === 'string' && /^-[1-9][0-9]{0,18}$/.test(value)
  && (value.length < 20 || value.slice(1) <= MIN.slice(1));
const greaterThanOne = value => decimal(value) && value !== '0' && value !== '1';
const kinds = ['grouped_aggregate', 'first_boundary', 'unknown_dates_bucket'];
const wellFormed = value => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};
const text = (value, maximum) => typeof value === 'string' && value.length <= maximum && wellFormed(value)
  && !/[\u0000\r\t\n]/.test(value)
  && new TextEncoder().encode(value).byteLength <= maximum;
export function validateQuery(value) {
  if (!exact(value, ['source_ref', 'family', 'mode']) || !uuid(value.source_ref)
    || !['standard', 'enhanced'].includes(value.family) || !['grouped', 'individual'].includes(value.mode)) fail();
  return Object.freeze({...value});
}
export function sourceCursor(value, expected) {
  if (!hex(expected) || !exact(value, ['context_ref', 'source_ref']) || value.context_ref !== expected || !uuid(value.source_ref)) fail();
  return Object.freeze({...value});
}
export function historyCursor(value, expected, query) {
  validateQuery(query);
  if (!hex(expected) || !exact(value, ['context_ref', 'source_ref', 'source_revision', 'family', 'mode', 'sort_key', 'kind', 'observation_ref'])
    || value.context_ref !== expected || value.source_ref !== query.source_ref || value.family !== query.family || value.mode !== query.mode
    || !decimal(value.source_revision) || !signed(value.sort_key) || !uuid(value.observation_ref) || !kinds.includes(value.kind)
    || (value.mode === 'grouped') !== (value.kind === 'grouped_aggregate')) fail();
  return Object.freeze({...value});
}
function envelope(value, expected, operation) {
  if (!exact(value, ['protocol', 'operation', 'result', 'context_ref', 'context_scope'])
    || value.protocol !== PROTOCOL || value.operation !== operation || value.context_ref !== expected
    || value.context_scope !== SCOPE || !hex(expected)) fail();
  return value.result;
}
function label(value, maximum) {
  if (!exact(value, ['state', 'text', 'truncated']) || !['absent', 'empty', 'valid'].includes(value.state)
    || typeof value.truncated !== 'boolean') fail();
  if (value.state === 'absent' ? value.text !== null || value.truncated
    : !text(value.text, maximum) || value.state === 'empty' && (value.text !== '' || value.truncated)
      || value.state === 'valid' && value.text === '') fail();
  return Object.freeze({...value});
}
function boundary(value) {
  if (!exact(value, ['state', 'label', 'truncated', 'resolution', 'unix_microseconds', 'fraction_digits'])
    || !['absent', 'empty', 'unavailable', 'valid'].includes(value.state) || typeof value.truncated !== 'boolean'
    || !['not_supplied', 'unresolved', 'resolved'].includes(value.resolution)) fail();
  if (value.state === 'absent' ? value.label !== null || value.truncated : !text(value.label, 128)) fail();
  // Date classification trims ASCII whitespace, while public labels retain the
  // original bounded prefix. Empty evidence can therefore be long/truncated.
  if (value.state !== 'absent') {
    const normalized = value.label.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, '');
    if (value.state === 'empty' && normalized !== '') fail();
    if (!value.truncated && (value.state === 'unavailable' && normalized !== 'N/A'
      || value.state === 'valid' && (normalized === '' || normalized === 'N/A'))) fail();
  }
  if (value.state === 'valid') {
    if (!value.label || value.resolution === 'not_supplied') fail();
  } else if (value.resolution !== 'not_supplied') fail();
  if (value.resolution === 'resolved' ? !signed(value.unix_microseconds) || value.truncated
    || !Number.isInteger(value.fraction_digits) || value.fraction_digits < 0 || value.fraction_digits > 6
    : value.unix_microseconds !== null || value.fraction_digits !== null) fail();
  return Object.freeze({...value});
}
function projection(value, query, revision) {
  const keys = ['source_kind', 'family', 'source_revision', 'artist', 'title', 'album', 'count_state', 'total',
    'status', 'reason', 'first', 'last', 'timestamp_coverage', 'first_marker_weight', 'aggregate_remainder',
    'first_sort_key', 'remainder_sort_key', 'grouped_sort_key', 'show_grouped_count', 'show_remainder_count'];
  if (!exact(value, keys) || value.source_kind !== 'foobar_local' || value.family !== query.family
    || !decimal(value.source_revision) || value.source_revision === '0' || BigInt(value.source_revision) > BigInt(revision)
    || !['absent', 'empty', 'unavailable', 'invalid', 'valid'].includes(value.count_state)
    || (value.count_state === 'valid' ? !decimal(value.total) : value.total !== null)
    || !['ready', 'unavailable', 'needs_reconciliation'].includes(value.status)
    || ![null, 'invalid_count', 'count_unavailable', 'zero_count_with_boundaries', 'boundary_order_conflict', 'single_count_boundary_conflict'].includes(value.reason)
    || ![0, 1].includes(value.first_marker_weight)
    || value.aggregate_remainder !== null && !decimal(value.aggregate_remainder)
    || value.first_sort_key !== null && !signed(value.first_sort_key)
    || !signed(value.remainder_sort_key) || !signed(value.grouped_sort_key)) fail();
  const first = boundary(value.first), last = boundary(value.last);
  // Check only contradictions visible in this wire. Hidden full-source hashes
  // remain the codec's responsibility; truncated equal labels prove no equality.
  if (value.status === 'ready') {
    if (value.total === '0' && (first.state === 'valid' || last.state === 'valid')) fail();
    if (first.resolution === 'resolved' && last.resolution === 'resolved') {
      const firstStart = BigInt(first.unix_microseconds), lastStart = BigInt(last.unix_microseconds);
      const firstEnd = firstStart + 10n ** BigInt(6 - first.fraction_digits) - 1n;
      const lastEnd = lastStart + 10n ** BigInt(6 - last.fraction_digits) - 1n;
      if (firstStart > lastEnd || value.total === '1' && firstEnd < lastStart) fail();
    } else if (value.total === '1' && first.state === 'valid' && last.state === 'valid'
      && !first.truncated && !last.truncated && first.label !== last.label) fail();
  }
  const marker = value.status === 'ready' && value.total !== '0' && first.state === 'valid' ? 1 : 0;
  if (value.status === 'ready' ? value.count_state !== 'valid' || value.reason !== null
    : value.status === 'unavailable' ? !['absent', 'empty', 'unavailable'].includes(value.count_state) || value.reason !== 'count_unavailable'
      : value.count_state === 'invalid' ? value.reason !== 'invalid_count'
        : value.count_state !== 'valid' || !['zero_count_with_boundaries', 'boundary_order_conflict', 'single_count_boundary_conflict'].includes(value.reason)) fail();
  if (value.timestamp_coverage !== (first.state === 'valid' || last.state === 'valid' ? 'boundary_evidence' : 'no_timestamps')
    || value.first_marker_weight !== marker || value.first_sort_key !== (marker ? first.unix_microseconds ?? MIN : null)
    || value.grouped_sort_key !== (last.unix_microseconds ?? MIN) || value.remainder_sort_key !== value.grouped_sort_key
    || (value.status === 'ready' ? value.aggregate_remainder !== String(BigInt(value.total) - BigInt(marker)) : value.aggregate_remainder !== null)
    || value.show_grouped_count !== (value.status === 'ready' && greaterThanOne(value.total))
    || value.show_remainder_count !== greaterThanOne(value.aggregate_remainder)) fail();
  return Object.freeze({...value, artist: label(value.artist, 48), title: label(value.title, 96), album: label(value.album, 48), first, last});
}
export function validateSources(value, expected, cursor = null) {
  const result = envelope(value, expected, 'sources');
  if (!exact(result, ['items', 'next_cursor']) || !Array.isArray(result.items) || result.items.length > PAGE_SIZE) fail();
  const seen = new Set();
  let previous = cursor?.source_ref ?? '';
  const items = result.items.map(item => {
    if (!exact(item, ['source_ref', 'created_at', 'is_default', 'observation_count']) || !uuid(item.source_ref)
      || !text(item.created_at, 128) || typeof item.is_default !== 'boolean' || !decimal(item.observation_count)
      || seen.has(item.source_ref) || item.source_ref <= previous) fail();
    previous = item.source_ref; seen.add(item.source_ref); return Object.freeze({...item});
  });
  const next = result.next_cursor === null ? null : sourceCursor(result.next_cursor, expected);
  if (next && (items.length !== PAGE_SIZE || next.source_ref !== items.at(-1).source_ref || cursor && next.source_ref === cursor.source_ref)) fail();
  return Object.freeze({items: Object.freeze(items), next_cursor: next});
}
export function validateHistory(value, expected, query, cursor = null) {
  validateQuery(query);
  const result = envelope(value, expected, 'history');
  if (!exact(result, ['source_ref', 'source_revision', 'family', 'mode', 'items', 'next_cursor'])
    || result.source_ref !== query.source_ref || result.family !== query.family || result.mode !== query.mode
    || !decimal(result.source_revision)
    || !Array.isArray(result.items) || result.items.length > PAGE_SIZE) fail();
  if (cursor && result.source_revision !== cursor.source_revision) fail('stale_history');
  const seen = new Set();
  let previous = cursor;
  const items = result.items.map(item => {
    if (!exact(item, ['observation_ref', 'kind', 'projection']) || !uuid(item.observation_ref) || !kinds.includes(item.kind)
      || (query.mode === 'grouped') !== (item.kind === 'grouped_aggregate') || seen.has(item.observation_ref + ':' + item.kind)) fail();
    const selected = projection(item.projection, query, result.source_revision);
    if (item.kind === 'first_boundary' && (selected.first_marker_weight !== 1 || selected.status !== 'ready')
      || item.kind === 'unknown_dates_bucket' && selected.status === 'ready' && selected.total !== '0' && selected.aggregate_remainder === '0') fail();
    const key = item.kind === 'first_boundary' ? selected.first_sort_key : item.kind === 'grouped_aggregate' ? selected.grouped_sort_key : selected.remainder_sort_key;
    const rank = item.kind === 'first_boundary' ? 1 : 0;
    if (previous) {
      const priorRank = previous.kind === 'first_boundary' ? 1 : 0;
      // Server chronology is exact, not rounded through Date/Number: DESC
      // signed microseconds, DESC arm rank, then DESC observation UUID.
      if (BigInt(key) > BigInt(previous.sort_key) || key === previous.sort_key
        && (rank > priorRank || rank === priorRank && item.observation_ref >= previous.observation_ref)) fail();
    }
    previous = {sort_key: key, kind: item.kind, observation_ref: item.observation_ref};
    seen.add(item.observation_ref + ':' + item.kind);
    return Object.freeze({...item, projection: selected});
  });
  const next = result.next_cursor === null ? null : historyCursor(result.next_cursor, expected, query);
  if (next) {
    const last = items.at(-1), selected = last?.projection;
    const key = last?.kind === 'first_boundary' ? selected?.first_sort_key : last?.kind === 'grouped_aggregate' ? selected?.grouped_sort_key : selected?.remainder_sort_key;
    if (items.length !== PAGE_SIZE || next.source_revision !== result.source_revision || next.kind !== last.kind
      || next.observation_ref !== last.observation_ref || next.sort_key !== key
      || cursor && next.sort_key === cursor.sort_key && next.kind === cursor.kind && next.observation_ref === cursor.observation_ref) fail();
  }
  return Object.freeze({...result, items: Object.freeze(items), next_cursor: next});
}
export async function readBoundedJSON(response, assertCurrent) {
  if (!response || response.redirected || !/^application\/json(?:\s*;[^\r\n]*)?$/i.test(response.headers?.get('content-type') || '')) fail();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) fail();
  const reader = response.body?.getReader(); if (!reader) fail();
  const decoder = new TextDecoder('utf-8', {fatal: true}); let bytes = 0, result = '';
  try {
    while (true) {
      assertCurrent(); const item = await reader.read(); assertCurrent();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || item.value.byteLength > MAX_RESPONSE_BYTES - bytes) fail();
      bytes += item.value.byteLength; result += decoder.decode(item.value, {stream: true});
    }
    result += decoder.decode(); assertCurrent(); return JSON.parse(result);
  } finally {try {await reader.cancel();} finally {reader.releaseLock();}}
}
