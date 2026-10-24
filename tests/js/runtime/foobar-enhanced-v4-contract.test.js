'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const E = require('./foobar-enhanced-v4-fixture.cjs'), {F, H} = E;
const validate = async (value, query = E.query(), cursor = null) => (await H.load('enhanced-contract.mjs')).validateEnhancedHistory(value, F.STAMP, query, cursor);
const rejects = async mutate => {const value = E.history(); mutate(value); await assert.rejects(validate(value));};

test('EV01 Enhanced contract keeps complete 100ns UTC and original FILETIME as exact strings', async () => {
  const p = await validate(E.history()); const row = p.items[0];
  assert.equal(row.kind, 'local_entry:0'); assert.equal(row.enhanced.entry.unix_100ns, '17927136001234567');
  assert.equal(row.enhanced.entry.raw_filetime_ticks, '134371872001234567'); assert.equal(row.enhanced.entry.iso_utc, '2026-10-23T00:00:00.1234567Z');
  assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.items)); assert.ok(Object.isFrozen(row)); assert.ok(Object.isFrozen(row.enhanced.entry));
  assert.equal(row.projection, undefined); assert.equal(row.path, undefined);
});
test('EV02 Enhanced contract distinguishes zero sentinel and outside-calendar raw evidence', async () => {
  for (const e of [
    {raw_filetime_ticks: '0', unix_100ns: '-116444736000000000', code: 'zero_or_unavailable'},
    {raw_filetime_ticks: '18446744073709551615', unix_100ns: '18330299337709551615', code: 'sentinel_like'},
    {raw_filetime_ticks: '2650467744000000000', unix_100ns: '2534023008000000000', code: 'outside_supported_calendar'},
  ]) {
    const raw = E.entry({...e, state: 'unresolved', iso_utc: null});
    const p = await validate(E.history([E.record(1, {entry: raw})]));
    assert.deepEqual(p.items[0].enhanced.entry, raw); assert.equal(p.items[0].enhanced.entry.iso_utc, null);
  }
});
test('EV03 Enhanced contract preserves negative subsecond and extreme resolved calendar boundaries', async () => {
  for (const e of [
    {raw_filetime_ticks: '1', unix_100ns: '-116444735999999999', iso_utc: '1601-01-01T00:00:00.0000001Z'},
    {raw_filetime_ticks: '116444735999999999', unix_100ns: '-1', iso_utc: '1969-12-31T23:59:59.9999999Z'},
    {raw_filetime_ticks: '2650467743999999999', unix_100ns: '2534023007999999999', iso_utc: '9999-12-31T23:59:59.9999999Z'},
  ]) assert.equal((await validate(E.history([E.record(1, {entry: E.entry(e)})]))).items[0].enhanced.entry.iso_utc, e.iso_utc);
});
test('EV04 Enhanced contract keeps equal-time ordinal positions separate and ordered', async () => {
  const rows = [2, 1, 0].map(ordinal => E.record(99, {local_vector_count: '3', entry: E.entry({ordinal})}));
  const p = await validate(E.history(rows)); assert.deepEqual(p.items.map(row => row.kind), ['local_entry:2', 'local_entry:1', 'local_entry:0']);
  await assert.rejects(validate(E.history([...rows].reverse()))); await assert.rejects(validate(E.history([rows[0], rows[0]])));
});
test('EV05 Enhanced contract sorts resolved evidence before the explicitly undated tail', async () => {
  const undated = E.record(999999, {entry: E.entry({raw_filetime_ticks: '0', unix_100ns: '-116444736000000000', state: 'unresolved', code: 'zero_or_unavailable', iso_utc: null})});
  const resolved = E.record(1); assert.equal((await validate(E.history([resolved, undated]))).items.length, 2);
  await assert.rejects(validate(E.history([undated, resolved])));
});
test('EV06 Enhanced record mode includes empty and unavailable vectors without invented timestamps', async () => {
  const rows = [E.record(3, {entry: null, local_vector_count: '0'}), E.record(2, {entry: null, local_vector_count: null, local_provenance: null}), E.record(1, {entry: null, local_vector_count: '32766'})];
  const p = await validate(E.history(rows, {view: 'records', ordering: 'source_record_identity'}), E.query({mode: 'grouped'}));
  assert.deepEqual(p.items.map(row => row.enhanced.local_vector_count), ['0', null, '32766']);
  assert.ok(p.items.every(row => row.kind === 'enhanced_record' && row.enhanced.entry === null));
});
test('EV07 Enhanced DTO rejects old envelopes account or source substitution and unknown fields', async () => {
  for (const change of [v => v.protocol = H.VERSION, v => v.context_ref = 'd'.repeat(64), v => v.context_scope = 'library', v => v.operation = 'history', v => v.result.source_ref = F.OTHER, v => v.result.extra = true, v => v.result.items[0].path = '/private/native.flac']) await rejects(change);
});
test('EV08 Enhanced DTO rejects number coercion leading signs zeros and integer overflows', async () => {
  for (const bad of [17927136001234568, '017927136001234567', '+17927136001234567', '1e6', '', '-0', '18446744073709551616']) {
    await rejects(v => v.result.items[0].entry.raw_filetime_ticks = bad);
    await rejects(v => v.result.items[0].entry.unix_100ns = bad);
  }
});
test('EV09 Enhanced DTO rejects impossible raw UTC code state and precision combinations', async () => {
  for (const patch of [{unix_100ns: '17927136001234568'}, {iso_utc: '2026-10-23T00:00:00.123Z'}, {iso_utc: '2026-10-23T00:00:00.1234568Z'}, {state: 'unresolved'}, {code: 'zero_or_unavailable'}, {provenance: 'complete'}, {ordinal: -1}, {ordinal: '0'}, {ordinal: 32766}, {ordinal: 0.5}]) await rejects(v => Object.assign(v.result.items[0].entry, patch));
  await rejects(v => Object.assign(v.result.items[0].entry, {raw_filetime_ticks: '0', unix_100ns: '-116444736000000000', iso_utc: null, code: 'sentinel_like', state: 'unresolved'}));
});
test('EV10 Enhanced DTO rejects impossible counts revisions provenance and entry views', async () => {
  for (const patch of [{local_vector_count: '0'}, {local_vector_count: null, local_provenance: null}, {local_vector_count: '32767'}, {local_vector_count: 1}, {local_provenance: null}, {observation_revision: '0'}, {observation_revision: '2'}, {observation_revision: '01'}, {count_meaning: 'lifetime_plays'}, {entry: null}]) await rejects(v => Object.assign(v.result.items[0], patch));
  await assert.rejects(validate(E.history([E.record()], {view: 'records', ordering: 'source_record_identity'}), E.query({mode: 'grouped'})));
});
test('EV11 Enhanced DTO accepts literal hostile labels but rejects invalid or oversized UTF8', async () => {
  const label = '<img src=x onerror=alert(1)>'; assert.equal((await validate(E.history([E.record(1, {label})]))).items[0].enhanced.label, label);
  for (const label of ['', 'x\ny', '\ud800', '\u2028', '😀'.repeat(65), 'a'.repeat(257)]) await rejects(v => v.result.items[0].label = label);
  assert.equal((await validate(E.history([E.record(1, {label: '😀'.repeat(64)})]))).items[0].enhanced.label.length, 128);
  for (const patch of [{label_kind: 'native_title'}, {label_truncated: 1}, {effective_sha256: 'B'.repeat(64)}, {display_sha256: ''}]) await rejects(v => Object.assign(v.result.items[0], patch));
});
test('EV12 Enhanced DTO rejects cached Lastfm native paths and stable-event claims', async () => {
  for (const key of ['cached_lastfm', 'cachedLastFM', 'lastfm_played_times', 'path', 'track_ref', 'duration', 'session_id', 'event_id']) await rejects(v => v.result.items[0][key] = 'not local evidence');
  for (const key of ['event_id', 'cached_lastfm', 'duration_seconds']) await rejects(v => v.result.items[0].entry[key] = 'not an ordinal');
});
test('EV13 Enhanced cursor is exact context source revision view direction and ordinal identity', async () => {
  const C = await H.load('enhanced-contract.mjs'), c = E.cursor(E.record());
  assert.deepEqual(C.enhancedCursor(c, F.STAMP, E.query()), c); assert.ok(Object.isFrozen(C.enhancedCursor(c, F.STAMP, E.query())));
  for (const patch of [{context_ref: 'd'.repeat(64)}, {source_ref: F.OTHER}, {source_revision: '-1'}, {source_revision: '01'}, {view: 'records'}, {direction: 'next'}, {direction: null}, {ordinal: '-1'}, {ordinal: '32766'}, {ordinal: 0}, {sort_key: '2534023008000000000'}, {sort_key: '-9223372036854775809'}, {extra: true}]) assert.throws(() => C.enhancedCursor({...c, ...patch}, F.STAMP, E.query()));
  const records = E.cursor(E.record(1, {entry: null})); assert.equal(C.enhancedCursor(records, F.STAMP, E.query({mode: 'grouped'})).ordinal, '-1');
  for (const patch of [{sort_key: '0'}, {ordinal: '0'}]) assert.throws(() => C.enhancedCursor({...records, ...patch}, F.STAMP, E.query({mode: 'grouped'})));
});
test('EV14 Enhanced initial continuation requires twenty rows and no previous cursor', async () => {
  const value = E.page(); await validate(value);
  const short = F.clone(value); short.result.items.pop(); short.result.next_cursor = E.cursor(short.result.items.at(-1)); await assert.rejects(validate(short));
  const prior = F.clone(value); prior.result.previous_cursor = E.cursor(prior.result.items[0], 'newer'); await assert.rejects(validate(prior));
  await assert.rejects(validate(E.history(Array.from({length: 21}, (_, i) => E.record(100 - i)))));
});
test('EV15 Enhanced response cursors bind exact returned endpoints and pinned revision', async () => {
  for (const patch of [{direction: 'newer'}, {ordinal: '1'}, {sort_key: '17927136001234566'}, {observation_ref: F.OTHER}, {source_revision: '2'}]) {
    const v = E.page(); Object.assign(v.result.next_cursor, patch); await assert.rejects(validate(v));
  }
  await assert.rejects(validate(E.page(1, {revision: '2'}), E.query(), E.page().result.next_cursor));
});
test('EV16 Enhanced older and newer boundaries reject overlap and wrong directional rows', async () => {
  const first = E.page(), second = E.page(1), third = E.page(2);
  assert.equal((await validate(second, E.query(), first.result.next_cursor)).items.length, 20);
  assert.equal((await validate(first, E.query(), second.result.previous_cursor)).items.length, 20);
  await assert.rejects(validate(first, E.query(), first.result.next_cursor));
  await assert.rejects(validate(third, E.query(), second.result.previous_cursor));
  const short = F.clone(first); short.result.items.shift(); short.result.previous_cursor = E.cursor(short.result.items[0], 'newer');
  await assert.rejects(validate(short, E.query(), second.result.previous_cursor));
});
test('EV17 Enhanced same-time page boundaries retain ordinal keysets in both directions', async () => {
  const rows = Array.from({length: 40}, (_, i) => E.record(1, {local_vector_count: '40', entry: E.entry({ordinal: 39 - i})}));
  const first = E.history(rows.slice(0, 20), {next_cursor: E.cursor(rows[19])});
  const second = E.history(rows.slice(20), {previous_cursor: E.cursor(rows[20], 'newer')});
  assert.equal((await validate(second, E.query(), first.result.next_cursor)).items[0].kind, 'local_entry:19');
  assert.equal((await validate(first, E.query(), second.result.previous_cursor)).items.at(-1).kind, 'local_entry:20');
});
test('EV18 Enhanced record continuation is source identity ordering rather than chronology', async () => {
  const first = E.page(0, {mode: 'grouped'}), second = E.page(1, {mode: 'grouped'}), q = E.query({mode: 'grouped'});
  assert.equal((await validate(second, q, first.result.next_cursor)).items[0].kind, 'enhanced_record');
  assert.equal((await validate(first, q, second.result.previous_cursor)).mode, 'grouped');
  const bad = F.clone(second); bad.result.ordering = 'resolved_time_then_undated'; await assert.rejects(validate(bad, q, first.result.next_cursor));
});
test('EV19 Enhanced import protocol v4 v3 v4 rejects all incompatible account predecessors', async () => {
  const C = await F.load('contract.mjs'); assert.equal(C.JOB, 'foobar_account_job_v3'); assert.equal(C.REVIEW, 'foobar_account_review_v4');
  C.validateSource(F.source(), F.STAMP);
  assert.throws(() => C.validateSource({...F.source(), protocol: 'foobar_account_import_v3'}, F.STAMP));
  assert.throws(() => C.validateReview({...E.review(), protocol: 'foobar_account_review_v3'}, F.STAMP, 'status', F.SOURCE, F.JOBREF));
  assert.throws(() => C.validateJob({...E.job(), protocol: 'foobar_account_job_v2'}, F.STAMP, 'status', F.SOURCE, F.JOBREF));
});
test('EV20 Enhanced command requires its distinct parser mapping and account-only association', async () => {
  const C = await F.load('contract.mjs'); assert.deepEqual(C.validateCommand(E.command()), E.command());
  // Historical title retained. The accepted association successor now admits
  // an exact positive selected-library ID, never a coerced or invalid scope.
  assert.equal(C.validateCommand(E.command({original_matching_library_id: 23})).original_matching_library_id, 23);
  for (const patch of [{parser_version: F.MAPPING}, {mapping_name: F.MAPPING}, {original_matching_library_id: 0}, {original_matching_library_id: -1}, {original_matching_library_id: '23'}, {mapping_name: 'sqlite'}, {raw_file: 'artifact'}]) assert.throws(() => C.validateCommand(E.command(patch)));
  assert.equal(C.validateCommand(F.command({original_matching_library_id: 23})).original_matching_library_id, 23);
});
test('EV21 Enhanced file admission has exact hundred-byte and 512MiB inclusive boundaries without reads', async () => {
  const C = await F.load('contract.mjs');
  for (const name of ['x.sqlite', 'x.sqlite3', 'x.DB']) for (const size of [100, 536870912]) {const file = E.file(name, size); assert.equal(C.validateFile(file, E.IMPORT_MAPPING), file);}
  for (const file of [E.file('x.sqlite', 99), E.file('x.sqlite', 536870913), E.file('x.sqlite', 100.5), E.file('x.tsv'), E.file('x.sqlite-wal')]) assert.throws(() => C.validateFile(file, E.IMPORT_MAPPING));
  assert.throws(() => C.validateFile(E.file())); assert.throws(() => C.validateFile(E.file(), 'custom'));
});
test('EV22 Enhanced review reports unavailable source evidence without matches taste or diagnostics', async () => {
  const C = await F.load('contract.mjs'), p = C.validateReview(E.review(), F.STAMP, 'status', F.SOURCE, F.JOBREF).review;
  assert.deepEqual(p.review_counts, [4, 0, 0, 2, 0, 1]); assert.deepEqual(p.proposed_counts, [1, 3, 0, 0, 0, 0, 0]);
  assert.deepEqual(p.problems, []); assert.deepEqual(p.problem_items, []); assert.deepEqual(p.conflicts, []);
  for (const mutate of [p => p.proposed_counts = [0, 3, 1, 0, 0, 0, 0], p => p.proposed_counts[4] = 1, p => p.review_counts[1] = 1, p => p.review_counts[2] = 1, p => p.review_counts[4] = 1, p => p.problems_truncated = true, p => p.problem_after = 1, p => p.conflict_after = 1]) {
    const value = E.review(); mutate(value.result.review); assert.throws(() => C.validateReview(value, F.STAMP, 'status', F.SOURCE, F.JOBREF));
  }
});
