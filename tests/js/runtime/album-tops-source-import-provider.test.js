'use strict';
// Independently authored against TEST-CONTRACT.md before product implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-membership-fixtures/top-builder-fixtures.cjs');
let createSourceImportProviders;
test.before(async () => {({createSourceImportProviders} = await F.load('album-tops/source-import-provider.mjs'));});
const id = n => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOB = id(1), REQUEST = id(2), TOP = id(3), ALBUM = id(4), OTHER = id(5), ACQUISITION = id(6);
const TIME = '2026-10-19T12:00:00+00:00';
const command = (patch = {}) => ({request_key: REQUEST, title: 'Imported Top', description: 'Private evidence',
  kind: 'text', filename: null, content: '1. Artist - Album', ...patch});
const row = (ref = '1', patch = {}) => ({row_ref: ref, candidate_line: Number(ref), raw_text: `${ref}. Artist - Album`,
  explicit_rank: Number(ref), catalog_ref: null, match_state: 'unresolved', ...patch});
const review = (patch = {}) => ({parser_version: 2, state: 'review_required', rows: [row()], issues: [], ordered_row_refs: ['1'], ...patch});
const job = (patch = {}) => ({job_ref: JOB, request_key: REQUEST, status: 'completed', revision: '2', title: 'Imported Top', kind: 'text',
  created_at: TIME, updated_at: TIME, phase: 'review_evidence', error: null, top_ref: null, source: command(), review: review(), ...patch});
const local = album_ref => ({kind: 'local_catalog', album_ref});
const finalCommand = (rows = [{row_ref: '1', selection: local(ALBUM)}], patch = {}) => ({request_key: JOB,
  title: 'Imported Top', description: '', source_review: {job_ref: JOB, revision: '2', rows}, ...patch});
const report = (row_ref = '1', patch = {}) => ({row_ref, position: Number(row_ref), original_explicit_rank: Number(row_ref),
  catalog_ref: ALBUM, outcome: 'matched', retained_row_ref: null, ...patch});
const receipt = (patch = {}) => ({action: 'create', request_key: JOB, top_ref: TOP, revision: '1', source_job_ref: JOB,
  source_locked: true, source_derived: true, source_report: [report()], ...patch});
function fixture(reply) {
  const calls = [], options = {scopeKey: 'account/session/library', signal: new AbortController().signal, isCurrent: () => true};
  const providers = createSourceImportProviders({request: async (...args) => {
    calls.push(args); return typeof reply === 'function' ? reply(...args) : reply;
  }});
  return {providers, options, calls};
}
const frozen = value => {if (value && typeof value === 'object') {assert.equal(Object.isFrozen(value), true); for (const child of Object.values(value)) frozen(child);}};

for (const kind of ['text', 'pasted_html', 'uploaded_html', 'url']) test(`source submission preserves ${kind} evidence and original owner options`, async () => {
  const content = kind === 'url' ? 'https://example.test/list?private=1#rank' : '<script>private()</script>\n2. Artist – Album';
  const input = command({kind, content, filename: kind === 'uploaded_html' ? 'source.html' : null});
  const wire = job({kind, source: structuredClone(input)}), h = fixture(wire), options = {...h.options, command: input};
  const result = await h.providers.submitSourceImport(options);
  assert.deepEqual(h.calls, [['/album-tops/source-imports', options, input]]);
  assert.equal(h.calls[0][1], options); assert.deepEqual(result.source, input);
  assert.equal(result.source.content, content); assert.equal(result.job_ref, JOB); frozen(result);
  wire.source.content = 'changed'; wire.review.rows[0].raw_text = 'changed';
  assert.equal(result.source.content, content); assert.equal(result.review.rows[0].raw_text, '1. Artist - Album');
});

for (const [method, suffix, post] of [['readSourceImport', '', false], ['processSourceImport', '/process', true], ['cancelSourceImport', '/cancel', true]]) {
  test(`${method} uses one exact job endpoint and passes abort/currentness options unchanged`, async () => {
    const h = fixture(job()), options = {...h.options, job_ref: JOB};
    const result = await h.providers[method](options);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], `/album-tops/source-imports/${JOB}${suffix}`);
    assert.equal(h.calls[0][1], options); assert.deepEqual(h.calls[0][2], post ? {} : undefined);
    assert.equal(result.job_ref, JOB); frozen(result);
  });
}

for (const bad of ['', JOB.toUpperCase(), '00000000-0000-0000-0000-000000000000', JOB + '\n', 1]) {
  test(`invalid job reference is rejected before request: ${JSON.stringify(bad)}`, async () => {
    for (const method of ['readSourceImport', 'processSourceImport', 'cancelSourceImport']) {
      const h = fixture(job()); await assert.rejects(async () => h.providers[method]({...h.options, job_ref: bad})); assert.equal(h.calls.length, 0);
    }
  });
}

for (const patch of [{title: ''}, {title: ' '}, {title: 'x'.repeat(101)}, {description: 'x'.repeat(1001)},
  {title: '\ud800'}, {description: '\udfff'}, {content: '\ud800'}, {content: 'a\0b'}, {kind: 'html'},
  {kind: 'uploaded_html', filename: ''}, {filename: 'unexpected.html'}, {request_key: REQUEST + '\n'}, {extra: true}]) {
  test(`invalid submission command rejected before transport ${JSON.stringify(patch).slice(0,70)}`, async () => {
    const h = fixture(job()); await assert.rejects(async () => h.providers.submitSourceImport({...h.options, command: command(patch)})); assert.equal(h.calls.length, 0);
  });
}

test('Unicode scalar title length and Python whitespace normalization are preserved', async () => {
  const title = '🎵'.repeat(100), input = command({title: '\u0085' + title + '\u001c'});
  const h = fixture(job({title, source: command({title})}));
  const result = await h.providers.submitSourceImport({...h.options, command: input});
  assert.equal(h.calls[0][2].title, title); assert.equal(result.title, title); assert.equal(input.title, '\u0085' + title + '\u001c');
});

test('UTF-8 body bound rejects multibyte overflow without truncation or request', async () => {
  const h = fixture(job()); const input = command({content: '🎵'.repeat(140000)});
  assert.ok(Buffer.byteLength(JSON.stringify(input), 'utf8') > 512 * 1024);
  await assert.rejects(async () => h.providers.submitSourceImport({...h.options, command: input})); assert.equal(h.calls.length, 0);
});

for (const patch of [{request_key: OTHER}, {source: command({content: 'different'})}, {source: command({description: 'different'})}]) {
  test(`submission rejects response evidence mismatch ${JSON.stringify(patch)}`, async () => {
    const h = fixture(job(patch)); await assert.rejects(async () => h.providers.submitSourceImport({...h.options, command: command()})); assert.equal(h.calls.length, 1);
  });
}

for (const cursor of [undefined, null, OTHER]) test(`summary list projects private evidence away (${cursor})`, async () => {
  const wire = {jobs: [job({acquisition: {secret: 'private-url'}, private_path: '/private'})], next_cursor: null};
  const h = fixture(wire), options = {...h.options, cursor};
  const result = await h.providers.listSourceImports(options);
  assert.equal(h.calls[0][0], '/album-tops/source-imports' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
  assert.equal(h.calls[0][1], options); assert.equal(h.calls[0][2], undefined);
  assert.deepEqual(Object.keys(result.jobs[0]).sort(), ['job_ref','request_key','status','revision','title','kind','created_at','updated_at','phase','error','top_ref'].sort());
  assert.equal(JSON.stringify(result).includes('Private evidence'), false); assert.equal(JSON.stringify(result).includes('/private'), false); frozen(result);
});
for (const reply of [{jobs: [job(), job()], next_cursor: null}, {jobs: Array.from({length: 51}, (_, n) => job({job_ref: id(100+n)})), next_cursor: null}, {jobs: [], next_cursor: JOB+'\n'}]) {
  test('summary list rejects duplicate, oversized or malformed page ' + JSON.stringify(reply).length, async () => {
    const h = fixture(reply); await assert.rejects(async () => h.providers.listSourceImports(h.options)); assert.equal(h.calls.length, 1);
  });
}

for (const patch of [{job_ref: OTHER}, {revision: '0'}, {revision: '2\n'}, {revision: '9223372036854775808'},
  {status: 'unknown'}, {phase: 'top_created'}, {top_ref: TOP}, {created_at: '2026-10-19T12:00:00'},
  {updated_at: 'not-a-date'}, {review: review({ordered_row_refs: []})}, {review: review({ordered_row_refs: ['2']})},
  {review: review({rows: [row(), row()]})}, {review: review({rows: [row('1', {catalog_ref: ALBUM})]})},
  {review: review({rows: [row('1', {match_state: 'matched'})]})}, {review: review({rows: [row('1', {candidate_line: 0})]})},
  {review: review({parser_version: 3})}]) {
  test(`detailed job rejects malformed identity/review ${JSON.stringify(patch).slice(0,90)}`, async () => {
    const h = fixture(job(patch)); await assert.rejects(async () => h.providers.readSourceImport({...h.options, job_ref: JOB}));
  });
}

test('ambiguous review order remains explicitly null and raw HTML is inert immutable text', async () => {
  const wire = job({review: review({rows: [row('1', {raw_text: '<img onerror="private()">', explicit_rank: null})], ordered_row_refs: null})});
  const h = fixture(wire), result = await h.providers.readSourceImport({...h.options, job_ref: JOB});
  assert.equal(result.review.ordered_row_refs, null); assert.equal(result.review.rows[0].raw_text, '<img onerror="private()">'); frozen(result);
});

test('finalization preserves complete explicit row order, duplicate selection and unresolved row', async () => {
  const rows = [{row_ref: '2', selection: local(ALBUM)}, {row_ref: '1', selection: local(ALBUM)}, {row_ref: '3', selection: null}];
  const expected = [report('2', {position: 1}), report('1', {position: 2, outcome: 'duplicate', retained_row_ref: '2'}),
    report('3', {catalog_ref: null, outcome: 'unresolved'})];
  const wire = receipt({source_report: expected}), h = fixture(wire), input = finalCommand(rows), options = {...h.options, command: input};
  const result = await h.providers.finalizeSourceImport(options);
  assert.deepEqual(h.calls, [['/album-tops', options, input]]); assert.equal(h.calls[0][1], options);
  assert.deepEqual(result, wire); assert.equal(h.calls[0][2].source_review.rows.length, 3, 'client cannot dedupe source rows'); frozen(result);
  wire.source_report[0].catalog_ref = OTHER; assert.equal(result.source_report[0].catalog_ref, ALBUM);
});

test('remote acquisition selection stays explicit and receipt supplies canonical identity', async () => {
  const selection = {kind: 'remote_acquisition', acquisition_ref: ACQUISITION, evidence_version: 'b'.repeat(64)};
  const input = finalCommand([{row_ref: '1', selection}]), h = fixture(receipt());
  const result = await h.providers.finalizeSourceImport({...h.options, command: input});
  assert.deepEqual(h.calls[0][2].source_review.rows[0].selection, selection); assert.equal(result.source_report[0].catalog_ref, ALBUM);
});

for (const patch of [{request_key: REQUEST}, {extra: true}, {source_review: {job_ref: JOB, revision: '02', rows: [{row_ref: '1', selection: local(ALBUM)}]}},
  {source_review: {job_ref: JOB, revision: '2\n', rows: [{row_ref: '1', selection: local(ALBUM)}]}},
  {source_review: {job_ref: JOB, revision: '9223372036854775808', rows: [{row_ref: '1', selection: local(ALBUM)}]}}]) {
  test('malformed finalization command cannot call transport ' + JSON.stringify(patch).slice(0,70), async () => {
    const h = fixture(receipt()); await assert.rejects(async () => h.providers.finalizeSourceImport({...h.options, command: finalCommand(undefined, patch)})); assert.equal(h.calls.length, 0);
  });
}
for (const rows of [[], [{row_ref: '1', selection: null}], [{row_ref: '01', selection: local(ALBUM)}],
  [{row_ref: '5001', selection: local(ALBUM)}], [{row_ref: '1\n', selection: local(ALBUM)}],
  [{row_ref: '1', selection: local(ALBUM)}, {row_ref: '1', selection: null}],
  [{row_ref: '1', selection: {kind: 'local_catalog', album_ref: ALBUM, path: '/private'}}],
  [{row_ref: '1', selection: {kind: 'remote_acquisition', acquisition_ref: ACQUISITION, evidence_version: 'B'.repeat(64)}}],
  [{row_ref: '1', selection: {kind: 'retained_remote', item_ref: JOB}}],
  Array.from({length: 5001}, (_, n) => ({row_ref: String(n+1), selection: local(ALBUM)}))]) {
  test('invalid finalization row vector is rejected before request ' + JSON.stringify(rows).slice(0,90), async () => {
    const h = fixture(receipt()); await assert.rejects(async () => h.providers.finalizeSourceImport({...h.options, command: finalCommand(rows)})); assert.equal(h.calls.length, 0);
  });
}

for (const patch of [{action: 'copy'}, {request_key: OTHER}, {source_job_ref: OTHER}, {top_ref: TOP+'\n'},
  {revision: '2'}, {source_locked: false}, {source_derived: false}, {source_report: []},
  {source_report: [report('2')]}, {source_report: [report('1', {position: 2})]},
  {source_report: [report('1', {catalog_ref: OTHER})]}, {source_report: [report('1', {outcome: 'duplicate', retained_row_ref: '2'})]},
  {source_report: [report('1', {catalog_ref: null, outcome: 'unresolved'})]}]) {
  test('final receipt cannot silently replace or omit reviewed source ' + JSON.stringify(patch).slice(0,90), async () => {
    const h = fixture(receipt(patch)); await assert.rejects(async () => h.providers.finalizeSourceImport({...h.options, command: finalCommand()})); assert.equal(h.calls.length, 1);
  });
}

for (const [name, mutate] of [
  ['reordered report', rows => rows.reverse()],
  ['duplicate matched canonical', rows => {rows[1].outcome = 'matched'; rows[1].retained_row_ref = null;}],
  ['self retained row', rows => {rows[1].retained_row_ref = '2';}],
  ['unknown retained row', rows => {rows[1].retained_row_ref = '3';}],
  ['missing row', rows => rows.pop()],
]) test('complete finalization receipt rejects ' + name, async () => {
  const rows = [{row_ref: '1', selection: local(ALBUM)}, {row_ref: '2', selection: local(ALBUM)}];
  const wire = receipt({source_report: [report(), report('2', {outcome: 'duplicate', retained_row_ref: '1'})]}); mutate(wire.source_report);
  const h = fixture(wire); await assert.rejects(async () => h.providers.finalizeSourceImport({...h.options, command: finalCommand(rows)}));
});

for (const name of ['AbortError', 'Error']) test('transport failure propagates unchanged without secondary attempt: ' + name, async () => {
  const failure = Object.assign(new Error('bounded request rejected'), {name, status: 403});
  for (const [method, extra] of [['submitSourceImport', {command: command()}], ['readSourceImport', {job_ref: JOB}],
    ['processSourceImport', {job_ref: JOB}], ['cancelSourceImport', {job_ref: JOB}], ['listSourceImports', {}],
    ['finalizeSourceImport', {command: finalCommand()}]]) {
    const h = fixture(() => {throw failure;});
    await assert.rejects(async () => h.providers[method]({...h.options, ...extra}), error => error === failure);
    assert.equal(h.calls.length, 1);
  }
});

test('detailed URL projection excludes acquisition blobs but preserves original private URL evidence', async () => {
  const source = command({kind: 'url', content: 'https://example.test/private-list?token=not-a-credential#rank'});
  const h = fixture(job({kind: 'url', source, acquisition: {body_base64: 'private', decoded_text: 'private html'}}));
  const result = await h.providers.readSourceImport({...h.options, job_ref: JOB});
  assert.deepEqual(result.source, source); assert.equal(Object.hasOwn(result, 'acquisition'), false); frozen(result);
});

for (const status of ['queued', 'running', 'failed', 'canceled']) test('valid non-completed job is retained without invented review: ' + status, async () => {
  const h = fixture(job({status, phase: 'source_processing', review: null, error: status === 'failed' ? 'source_processing_failed' : null}));
  const result = await h.providers.readSourceImport({...h.options, job_ref: JOB});
  assert.equal(result.status, status); assert.equal(result.review, null);
});

test('canceled job can retain prior review and maximum bigint revision without coercion', async () => {
  const h = fixture(job({status: 'canceled', phase: 'source_processing', revision: '9223372036854775807'}));
  const result = await h.providers.readSourceImport({...h.options, job_ref: JOB});
  assert.equal(result.revision, '9223372036854775807'); assert.deepEqual(result.review, review());
});

test('fifty distinct job summaries are accepted without truncation', async () => {
  const jobs = Array.from({length: 50}, (_, n) => job({job_ref: id(100+n)}));
  const h = fixture({jobs, next_cursor: id(149)}), result = await h.providers.listSourceImports(h.options);
  assert.equal(result.jobs.length, 50); assert.equal(result.next_cursor, id(149));
});

test('five thousand explicit review rows remain complete and an extra row is rejected', async () => {
  const rows = Array.from({length: 5000}, (_, n) => row(String(n+1)));
  const wire = job({review: review({rows, ordered_row_refs: rows.map(value => value.row_ref)})});
  const h = fixture(wire), result = await h.providers.readSourceImport({...h.options, job_ref: JOB});
  assert.equal(result.review.rows.length, 5000); assert.equal(result.review.ordered_row_refs.at(-1), '5000');
  wire.review.rows.push(row('5001')); wire.review.ordered_row_refs.push('5001');
  await assert.rejects(async () => h.providers.readSourceImport({...h.options, job_ref: JOB}));
  assert.equal(result.review.rows.length, 5000, 'transport mutation cannot rewrite admitted evidence');
});
