'use strict';
// Authored only. Run solely in an approved composed native Node closure.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');

test('I01 strict command excludes ownership claims, unsafe IDs, raw fields and custom mapping', async () => {
  const C = await F.load('contract.mjs'); assert.deepEqual(C.validateCommand(F.command()), F.command());
  for (const patch of [{account_id: 1}, {library_id: 3}, {source_ref: 'AAAAAAAA-0000-4000-8000-000000000003'}, {job_ref: 'not-a-uuid'}, {upload_sha256: 'B'.repeat(64)}, {parser_version: 'custom'}, {mapping_name: 'custom'}, {original_generation: 0}, {original_generation: 2147483648}, {total_rows: 0}, {total_rows: 100001}, {original_matching_library_id: Number.MAX_SAFE_INTEGER + 1}, {original_matching_library_id: true}]) {
    assert.throws(() => C.validateCommand(F.command(patch)), JSON.stringify(patch));
  }
});
test('I02 source and acceptance require exact context, scope, protocol, identity and non-durable acceptance', async () => {
  const C = await F.load('contract.mjs'); C.validateSource(F.source(), F.STAMP);
  for (const patch of [{context_ref: 'e'.repeat(64)}, {context_scope: 'library'}, {operation: 'import'}, {raw: []}]) assert.throws(() => C.validateSource({...F.source(), ...patch}, F.STAMP));
  for (const [protocol, operation] of [[F.REVIEW, 'start'], [F.JOB, 'start'], [F.JOB, 'resume']]) {
    const good = F.accepted(protocol, operation); C.validateAccepted(good, F.STAMP, protocol, operation, F.SOURCE, F.JOBREF);
    for (const patch of [{source_ref: F.OTHER}, {job_ref: F.OTHER}, {durable_start_confirmed: true}, {phase: 'completed'}, {result: {}}, {context_scope: 'goals-v1'}]) assert.throws(() => C.validateAccepted({...good, ...patch}, F.STAMP, protocol, operation, F.SOURCE, F.JOBREF));
  }
});
test('I03 dry-run DTO rejects raw values, wrong row sums, malformed problems and invented success', async () => {
  const C = await F.load('contract.mjs'); const valid = C.validateReview(F.review(), F.STAMP, 'status', F.SOURCE, F.JOBREF);
  assert.equal(valid.phase, 'review_ready'); assert.ok(Object.isFrozen(valid.review.command));
  for (const mutate of [v => v.result.phase = 'completed', v => v.result.review = null, v => v.result.review.raw_cells = [], v => v.result.review.command.job_ref = F.OTHER, v => v.result.review.advisory_not_reservation = false, v => v.result.review.checked_rows = 3, v => v.result.review.start_offset = 1, v => v.result.review.planned_batches = 0, v => v.result.review.proposed_counts[0] = 3, v => v.result.review.review_counts[0] = 0, v => v.result.review.problems[0].row = 0, v => v.result.review.problems[0].field = 'private_path', v => v.result.review.problems[0].code = 'raw-secret', v => v.result.review.problems[0].value = 'private', v => v.result.review.problems = Array(33).fill({row: 1, code: 'invalid_count', field: 'play_count'})]) {
    const value = F.review(); mutate(value); assert.throws(() => C.validateReview(value, F.STAMP, 'status', F.SOURCE, F.JOBREF));
  }
});
test('I04 unavailable durable counts remain null and are not normalized to a zero receipt', async () => {
  const C = await F.load('contract.mjs'); const missing = {confirmed_rows: null, remaining_rows: null, confirmed_counts: null, disposition: null, cancel_requested: null, pending_attempt: null};
  const result = C.validateJob(F.job(missing), F.STAMP, 'status', F.SOURCE, F.JOBREF);
  assert.equal(result.confirmed_rows, null); assert.equal(result.confirmed_counts, null);
  for (const patch of [{remaining_rows: 4}, {confirmed_counts: [0, 0, 0, 0, 0, 0, 0]}, {disposition: 'completed'}, {cancel_requested: false}]) assert.throws(() => C.validateJob(F.job({...missing, ...patch}), F.STAMP, 'status', F.SOURCE, F.JOBREF));
});
test('I05 confirmed prefix conservation and settled diagnostic never supply durable proof', async () => {
  const C = await F.load('contract.mjs'); C.validateJob(F.job(), F.STAMP, 'status', F.SOURCE, F.JOBREF);
  for (const patch of [{confirmed_rows: -1}, {remaining_rows: 1}, {confirmed_counts: [2, 2, 0, 0, 0, 0, 0]}, {disposition: 'completed'}, {command: F.command({job_ref: F.OTHER})}, {pending_attempt: {batch_no: 0, attempt_no: 1, state: 'ready'}}, {pending_attempt: {batch_no: 1, attempt_no: 1, state: 'invented'}}]) assert.throws(() => C.validateJob(F.job(patch), F.STAMP, 'status', F.SOURCE, F.JOBREF));
  const value = F.job(); value.settled_diagnostic = {phase: 'completed', uncertain: false, error: null, snapshot_kind: 'settled_process_diagnostic', durable_proof: false};
  assert.equal(C.validateJob(value, F.STAMP, 'status', F.SOURCE, F.JOBREF).confirmed_rows, 2);
  value.settled_diagnostic.durable_proof = true; assert.throws(() => C.validateJob(value, F.STAMP, 'status', F.SOURCE, F.JOBREF));
});
test('I06 supported file checks do not read bytes and reject empty/large/non-TSV sources', async () => {
  const C = await F.load('contract.mjs'); let reads = 0;
  const file = {name: 'SUPPORTED.TSV', size: 1, slice() {reads++; throw new Error('No client byte read');}};
  assert.equal(C.validateFile(file), file); assert.equal(reads, 0);
  for (const bad of [null, {name: 'a.tsv', size: 0, slice() {}}, {name: 'a.tsv', size: 67108865, slice() {}}, {name: 'a.csv', size: 1, slice() {}}, {name: 'a.sqlite', size: 1, slice() {}}, {name: 'a.tsv', size: 1}, {name: 'a.tsv', size: 1.5, slice() {}}]) assert.throws(() => C.validateFile(bad));
});
test('I07 bounded JSON rejects redirects, MIME confusion, oversize, malformed UTF-8 and non-JSON', async () => {
  const C = await F.load('contract.mjs'); assert.deepEqual(await C.readBoundedJSON(F.response({ok: true})), {ok: true});
  const redirected = F.response({}); Object.defineProperty(redirected, 'redirected', {value: true});
  for (const bad of [redirected, new Response('{}', {headers: {'Content-Type': 'text/html'}}), new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': '12289'}}), new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': 'not-a-size'}}), F.response({padding: 'x'.repeat(12289)}), new Response(new Uint8Array([0xc3, 0x28]), {headers: {'Content-Type': 'application/json'}}), new Response('{bad', {headers: {'Content-Type': 'application/json'}})]) await assert.rejects(C.readBoundedJSON(bad));
});
test('I08 bounded reader aborts, cancels and releases its stream rather than retaining upload evidence', async () => {
  const C = await F.load('contract.mjs'); let cancels = 0, releases = 0, reads = 0;
  const input = {redirected: false, headers: new Headers({'Content-Type': 'application/json'}), body: {getReader: () => ({read() {reads++; return Promise.resolve({done: true});}, cancel() {cancels++; return Promise.resolve();}, releaseLock() {releases++;}})}};
  const abort = new AbortController(); abort.abort(); await assert.rejects(C.readBoundedJSON(input, abort.signal));
  assert.equal(reads, 0); assert.equal(cancels, 1); assert.equal(releases, 1);
});
