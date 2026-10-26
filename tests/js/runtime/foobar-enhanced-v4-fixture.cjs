'use strict';
// Synthetic DTOs, controlled transport, and DOM selection only. No product
// validation, cursor decision, retained-window algorithm or renderer is copied.
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');
const H = require('./foobar-account-history-fixture.cjs');
const IMPORT_MAPPING = 'foobar_enhanced_playcount_store_v1';
const IMPORT_PARSER = 'foobar_enhanced_sqlite_record_v1';
const HISTORY = 'foobar_account_enhanced_history_v1';
const UNIX = '17927136001234567', RAW = '134371872001234567';
const ISO = '2026-10-23T00:00:00.1234567Z';
const query = patch => ({source_ref: F.SOURCE, family: 'local_entries', mode: 'individual', ...patch});
const entry = patch => ({ordinal: 0, raw_filetime_ticks: RAW, unix_100ns: UNIX,
  state: 'resolved', code: null, iso_utc: ISO, provenance: 'incomplete_possibly_seeded', ...patch});
const record = (n = 999999, patch = {}) => ({observation_ref: H.id(n), observation_revision: '1',
  effective_sha256: 'b'.repeat(64), display_sha256: 'c'.repeat(64), label: 'Source file ' + n,
  label_kind: 'source_filename', label_truncated: false, local_vector_count: '1',
  count_meaning: 'reported_local_vector_entries_not_lifetime_plays',
  local_provenance: 'incomplete_possibly_seeded', entry: entry(), ...patch});
const cursor = (row, direction = 'older', patch = {}) => ({context_ref: F.STAMP, source_ref: F.SOURCE,
  source_revision: '1', view: row.entry === null ? 'records' : 'entries',
  sort_key: row.entry?.state === 'resolved' ? row.entry.unix_100ns : H.MIN,
  observation_ref: row.observation_ref, ordinal: String(row.entry?.ordinal ?? -1), direction, ...patch});
const history = (items = [record()], patch = {}) => ({protocol: HISTORY, context_ref: F.STAMP, context_scope: F.SCOPE,
  result: {source_ref: F.SOURCE, source_revision: '1', view: 'entries', ordering: 'resolved_time_then_undated',
    items, next_cursor: null, previous_cursor: null, ...patch}});
function page(index = 0, {mode = 'individual', more = true, prior = index > 0, revision = '1', source = F.SOURCE} = {}) {
  const items = Array.from({length: 20}, (_, n) => record(999999 - index * 20 - n, {entry: mode === 'grouped' ? null : entry()}));
  const c = row => ({source_revision: revision, source_ref: source});
  return history(items, {source_ref: source, source_revision: revision,
    view: mode === 'grouped' ? 'records' : 'entries', ordering: mode === 'grouped' ? 'source_record_identity' : 'resolved_time_then_undated',
    next_cursor: more ? cursor(items.at(-1), 'older', c()) : null,
    previous_cursor: prior ? cursor(items[0], 'newer', c()) : null});
}
const command = patch => F.command({mapping_name: IMPORT_MAPPING, parser_version: IMPORT_PARSER, ...patch});
const proposal = patch => F.proposal({command: command(), proposed_counts: [1, 3, 0, 0, 0, 0, 0],
  review_counts: [4, 0, 0, 2, 0, 1], problems: [], problems_truncated: false,
  problem_items: [], problem_count: 0, problem_after: 0, problem_next: null, problem_remaining: 0, ...patch});
const review = patch => F.review({review: proposal(), ...patch});
const job = patch => F.job({command: command(), confirmed_counts: [0, 2, 0, 0, 0, 0, 0], ...patch});
function file(name = 'finalized.sqlite', size = 100) {
  const value = Object.defineProperty(new Blob([new Uint8Array(100)], {type: 'application/vnd.sqlite3'}), 'name', {value: name});
  if (size !== 100) Object.defineProperty(value, 'size', {value: size});
  // If a consumer starts reading upload bytes, fail at that exact boundary.
  for (const method of ['arrayBuffer', 'text', 'slice', 'stream']) Object.defineProperty(value, method, {value() {assert.fail('No browser byte read: ' + method);}});
  return value;
}
async function importReady(f, {selected = file(), value = proposal()} = {}) {
  f.wire.enqueue('/ui/source', F.source()); await f.owner.initialize();
  f.owner.setMapping(IMPORT_MAPPING); f.owner.choose(selected);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: value}));
  await f.owner.preview(); await f.time.tick(); assert.equal(f.owner.getState().phase, 'review_ready'); return selected;
}
async function selected(f, first = page(), mode = 'individual', sources = H.sources()) {
  f.wire.enqueue('/history/sources', sources); await f.controller.initialize();
  f.controller.setFamily('local_entries'); f.controller.setMode(mode);
  f.wire.enqueue('/history/enhanced', first); f.controller.selectSource(first.result.source_ref); await F.settle();
  assert.equal(f.controller.getSnapshot().status, first.result.items.length ? 'ready' : 'empty');
}
function field(f, label) {
  const labels = f.host.querySelectorAll('label').filter(node => node.querySelector('span')?.textContent === label);
  assert.equal(labels.length, 1, 'Exactly one history control label: ' + label);
  const selects = labels[0].querySelectorAll('select'); assert.equal(selects.length, 1); return selects[0];
}
async function nativeSelected(f, first = page(), mode = 'individual') {
  const family = field(f, 'Count family'); family.value = 'local_entries'; f.change(family);
  const view = field(f, 'View'); view.value = mode; f.change(view);
  f.wire.enqueue('/history/enhanced', first); const source = field(f, 'Account source'); source.value = first.result.source_ref; f.change(source); await F.settle();
  assert.equal(f.owner.controller.getSnapshot().status, first.result.items.length ? 'ready' : 'empty');
}
module.exports = {F, H, IMPORT_MAPPING, IMPORT_PARSER, HISTORY, UNIX, RAW, ISO, query, entry, record, cursor,
  history, page, command, proposal, review, job, file, importReady, selected, field, nativeSelected};
