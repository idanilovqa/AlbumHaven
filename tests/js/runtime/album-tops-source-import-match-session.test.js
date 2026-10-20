'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./album-tops-source-match-fixtures/session.cjs');
const {F, JOB, OTHER_JOB} = M;
test.before(M.load);

for (const rowRef of [undefined, null, '', 2, '0', '02', '4', '5001', '2\n', {}, ['2']]) {
  test(`matching session rejects missing or invalid source row ${JSON.stringify(rowRef)} before owner allocation`, async t => {
    const h = await M.fixture(t), counts = {...h.subscriptions}, requests = h.api.calls.length + h.transport.length;
    assert.throws(() => h.construct(h.options({rowRef})), TypeError);
    assert.deepEqual(h.subscriptions, counts); assert.equal(h.api.calls.length + h.transport.length, requests);
    assert.deepEqual(M.selections(h), []); M.noImplicitSave(h);
  });
}

for (const status of ['queued', 'running', 'failed', 'canceled']) test(`matching session rejects ${status} source jobs before owner allocation`, async t => {
  const h = await M.fixture(t, {wire: M.job({status, phase: 'source_processing', review: null,
    error: status === 'failed' ? 'source_processing_failed' : null})}), before = {...h.subscriptions};
  assert.throws(() => h.construct(h.options()), TypeError); assert.deepEqual(h.subscriptions, before); M.noImplicitSave(h);
});

for (const state of ['idle', 'saved']) test(`matching session cannot start from ${state} import`, async t => {
  const h = await M.fixture(t, state === 'idle' ? {opened: false} : {wire: M.job({top_ref: M.SAVED_TOP, phase: 'top_created'})});
  const before = {...h.subscriptions};
  assert.throws(() => h.construct(h.options()), TypeError); assert.deepEqual(h.subscriptions, before); M.noImplicitSave(h);
});

test('matching confirms one actual canonical local admission for its captured row without touching evidence or navigation', async t => {
  const h = await M.fixture(t), before = h.importController.getSnapshot(), options = h.options();
  const session = h.own(h.construct(options)); options.rowRef = '1';
  assert.equal(session.draft.getSnapshot().sourceMatch, true); assert.equal(session.draft.getSnapshot().capacity, 1);
  assert.equal(session.confirm(), false, 'opening or searching never matches a row');
  const selected = await M.selectLocal(session);
  assert.equal(selected.album_ref, F.C); assert.deepEqual(h.importController.getSnapshot().rows, before.rows);
  assert.deepEqual(M.selections(h), []); assert.equal(session.confirm(), true);
  assert.deepEqual(M.selections(h).map(row => row.args), [['2', M.local(F.C)]]);
  const after = h.importController.getSnapshot();
  assert.deepEqual(after.rows, [{row_ref: '3', selection: null}, {row_ref: '2', selection: M.local(F.C)}, {row_ref: '1', selection: null}]);
  assert.deepEqual(after.job, before.job); assert.deepEqual(after.job.source, M.SOURCE);
  assert.deepEqual(after.job.review, M.review()); assert.equal(after.orderConfirmed, true);
  assert.equal(session.confirm(), false); assert.equal(session.confirm(), false); assert.equal(M.selections(h).length, 1);
  selected.album_ref = F.id(999); assert.deepEqual(after.rows[1].selection, M.local(F.C), 'review owns a detached selector');
  assert.equal(h.transport.length, 1, 'only the explicit original import read');
  assert.equal(await session.draft.submit(), false); M.noImplicitSave(h);
});

test('remote confirmation preserves exact acquisition evidence bound to the source job', async t => {
  const h = await M.fixture(t), session = h.create(), before = h.importController.getSnapshot();
  const selected = await M.selectRemote(session);
  assert.equal(selected.album_ref, undefined); assert.equal(session.draft.getSnapshot().formRef, JOB);
  assert.deepEqual(h.api.last('beginRemotePreparation').args[0], {destination: {kind: 'create', draft_ref: JOB}, form_ref: JOB});
  assert.deepEqual(h.api.last('acquireRemoteAlbum').args[0].destination, {kind: 'create', draft_ref: JOB});
  assert.deepEqual(M.selections(h), []); assert.equal(session.confirm(), true);
  assert.deepEqual(M.selections(h).map(row => row.args), [['2', M.remote()]]);
  assert.deepEqual(h.importController.getSnapshot().job, before.job);
  assert.deepEqual(h.importController.getSnapshot().rows.map(row => row.row_ref), ['3', '2', '1']);
  assert.equal(session.confirm(), false); assert.equal(M.selections(h).length, 1); M.noImplicitSave(h);
});

test('independent row sessions may explicitly choose the same canonical album without client deduplication', async t => {
  const h = await M.fixture(t), first = h.create({rowRef: '1'}), third = h.create({rowRef: '3'});
  await M.selectLocal(first); await M.selectLocal(third);
  assert.equal(first.confirm(), true); assert.equal(third.confirm(), true);
  assert.deepEqual(M.selections(h).map(row => row.args), [['1', M.local(F.C)], ['3', M.local(F.C)]]);
  assert.deepEqual(h.importController.getSnapshot().rows, [
    {row_ref: '3', selection: M.local(F.C)}, {row_ref: '2', selection: null}, {row_ref: '1', selection: M.local(F.C)}]);
  assert.equal(h.api.count('admitAlbum'), 2); assert.equal(h.importController.getSnapshot().job.review.rows.length, 3); M.noImplicitSave(h);
});

test('stable source-row identity survives unrelated selections and ambiguous review reorder', async t => {
  const review = M.review(); review.ordered_row_refs = null;
  const h = await M.fixture(t, {wire: M.job({review})}), session = h.create(), evidence = h.importController.getSnapshot().job;
  await M.selectLocal(session);
  assert.equal(h.actualImport.select('1', M.local(F.A)), true);
  assert.equal(h.actualImport.reorder(['2', '3', '1']), true);
  const before = h.importController.getSnapshot(); assert.equal(before.orderConfirmed, false);
  assert.equal(session.confirm(), true);
  assert.deepEqual(h.importController.getSnapshot().rows, [
    {row_ref: '2', selection: M.local(F.C)}, {row_ref: '3', selection: null}, {row_ref: '1', selection: M.local(F.A)}]);
  assert.deepEqual(h.importController.getSnapshot().job, evidence); assert.equal(h.importController.getSnapshot().orderConfirmed, false);
  assert.deepEqual(evidence.review.rows, M.review().rows); M.noImplicitSave(h);
});

test('a completed source review in definitive error state may start a fresh explicit matching session', async t => {
  const h = await M.fixture(t); h.reply('read', () => {throw Object.assign(new Error('Read rejected'), {status: 409, responseRejected: true});});
  assert.equal(await h.actualImport.open(JOB), false); assert.equal(h.actualImport.getSnapshot().status, 'error');
  const session = h.create(); await M.selectLocal(session); assert.equal(session.confirm(), true);
  assert.equal(h.actualImport.getSnapshot().status, 'ready'); assert.deepEqual(M.selections(h)[0].args, ['2', M.local(F.C)]); M.noImplicitSave(h);
});

const malformedItems = [
  ['zero choices', []], ['multiple choices', [{album_ref: F.A}, {album_ref: F.B}]],
  ['null item', [null]], ['sparse item', new Array(1)],
  ['unadmitted local evidence', [{local_album_id: 13, title: 'Raw source evidence'}]],
  ['unknown remote summary', [{source_kind: 'remote_summary', release_group_id: F.RG, title: 'Search is not acquisition'}]],
  ['zero canonical UUID', [{album_ref: '00000000-0000-0000-0000-000000000000'}]],
  ['noncanonical UUID', [{album_ref: 'A7191CE0-2EF6-41C5-8FB5-926FC9A3D12C'}]],
  ['UUID newline', [{album_ref: F.C + '\n'}]],
  ['missing remote version', [{source_kind: 'remote_summary', source: {kind: 'remote_acquisition', acquisition_ref: F.ACQUISITION}}]],
  ['extra remote selector field', [{source_kind: 'remote_summary', source: {...M.remote(), title: 'must not be projected away'}}]],
  ['uppercase evidence', [{source_kind: 'remote_summary', source: {...M.remote(), evidence_version: 'A'.repeat(64)}}]],
  ['unknown selector kind', [{source_kind: 'remote_summary', source: {kind: 'remote_retained', admission_ref: F.ADMISSION}}]],
];
for (const [label, items] of malformedItems) test(`confirm rejects ${label} in exposed draft data without publishing any selector`, async t => {
  const h = await M.fixture(t), session = h.create(), before = h.actualImport.getSnapshot();
  // Defensive structural boundary only. This does not claim same-page JavaScript
  // cannot forge an otherwise valid canonical identifier; server admission owns that.
  session.draft.getSnapshot().items = F.clone(items);
  assert.equal(session.confirm(), false); assert.equal(h.actualImport.getSnapshot(), before);
  assert.deepEqual(M.selections(h), []); M.noImplicitSave(h);
});

test('a rejected malformed choice does not consume the later explicit valid confirmation', async t => {
  const h = await M.fixture(t), session = h.create(); await M.selectLocal(session);
  const selected = session.draft.getSnapshot().items[0], canonical = selected.album_ref;
  selected.album_ref = 'invalid'; assert.equal(session.confirm(), false); assert.deepEqual(M.selections(h), []);
  selected.album_ref = canonical; assert.equal(session.confirm(), true);
  assert.deepEqual(M.selections(h).map(row => row.args), [['2', M.local(F.C)]]); M.noImplicitSave(h);
});

test('synchronous import selection subscribers cannot recursively confirm the same row twice', async t => {
  const h = await M.fixture(t), session = h.create(); await M.selectLocal(session);
  let reentered = false, nested;
  const off = h.actualImport.subscribe(() => {
    if (!reentered && h.actualImport.getSnapshot().rows.some(row => row.row_ref === '2' && row.selection)) {
      reentered = true; nested = session.confirm();
    }
  }); t.after(off);
  assert.equal(session.confirm(), true); assert.equal(reentered, true); assert.equal(nested, false);
  assert.equal(M.selections(h).length, 1); M.noImplicitSave(h);
});

for (const phase of ['loading', 'ready']) test(`matching requires a directory destination rather than a ${phase} selected Top`, async t => {
  const gate = F.deferred(), h = await M.fixture(t, {handlers: phase === 'loading' ? {read: () => gate.promise} : {}});
  const pending = h.topController.open(F.TOP); if (phase === 'ready') await pending;
  const counts = {...h.subscriptions};
  assert.throws(() => h.construct(h.options()), TypeError); assert.deepEqual(h.subscriptions, counts);
  gate.resolve(F.mixed()); await pending; assert.deepEqual(M.selections(h), []);
  assert.equal(h.api.count('execute'), 0);
});

test('matching retains the real draft create gate when directory permission is unavailable', async t => {
  const h = await M.fixture(t, {directoryReady: false}), session = h.create();
  assert.equal(session.draft.canEditMembership(), false); assert.equal(session.confirm(), false);
  assert.equal(await session.draft.setQuery('Blocked'), false); assert.equal(h.api.count('searchAlbums'), 0);
  assert.deepEqual(M.selections(h), []); M.noImplicitSave(h);
});
