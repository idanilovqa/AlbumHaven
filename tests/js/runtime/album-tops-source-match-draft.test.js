'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./album-tops-source-match-fixtures/picker.cjs');
const {F, JOB, OTHER_JOB} = S;
test.before(S.load);

const badJobs = [
  ['missing', undefined], ['undefined', undefined], ['null', null], ['empty', ''], ['number', 42], ['object', {}], ['array', [JOB]],
  ['boxed string', new String(JOB)], ['uppercase', JOB.toUpperCase()], ['leading space', ' ' + JOB],
  ['trailing space', JOB + ' '], ['newline', JOB + '\n'], ['CRLF', JOB + '\r\n'],
  ['NUL', JOB + '\0'], ['suffix', JOB + 'x'], ['truncated', JOB.slice(0, -1)],
  ['no hyphens', JOB.replaceAll('-', '')], ['all zero', '00000000-0000-0000-0000-000000000000'],
];
for (const [label, sourceJobRef] of badJobs) test(`source-match rejects ${label} job before owners or I/O`, async t => {
  const f = await S.base(t), calls = f.api.calls.length, subscriptions = f.subscriptions.started;
  const options = f.options({sourceJobRef});
  if (label === 'missing') delete options.sourceJobRef;
  assert.throws(() => f.construct(options), TypeError);
  assert.equal(f.subscriptions.started, subscriptions);
  assert.equal(f.api.calls.length, calls); S.noWrites(f);
});

for (const phase of ['loading', 'ready']) test(`source-match rejects a selected Top with ${phase} detail before owners`, async t => {
  const gate = F.deferred(), f = await S.base(t, {handlers: phase === 'loading' ? {read: () => gate.promise} : {}});
  const opening = f.controller.open(F.TOP);
  if (phase === 'ready') await opening;
  const calls = f.api.calls.length, subscriptions = f.subscriptions.started;
  assert.equal(f.controller.getSnapshot().selectedTopRef, F.TOP);
  assert.equal(f.controller.getSnapshot().detail.status, phase);
  assert.throws(() => f.construct(f.options()), TypeError);
  assert.equal(f.subscriptions.started, subscriptions); assert.equal(f.api.calls.length, calls);
  gate.resolve(F.mixed()); await opening; S.noWrites(f);
});

test('source-match captures the job UUID once and shares it across search, preparation, acquisition and retry', async t => {
  let attempts = 0;
  const f = await S.base(t, {handlers: {acquireRemoteAlbum: body => {
    if (++attempts === 1) throw new TypeError('Synthetic lost acquisition response');
    return f.api.acquisition(body);
  }}});
  const options = f.options(), draft = f.own(f.construct(options));
  assert.equal(draft.getSnapshot().capacity, 1);
  assert.equal(draft.getSnapshot().sourceMatch, true);
  options.sourceJobRef = OTHER_JOB; options.mode = 'edit';
  const [candidate] = await S.remoteResults(draft);
  assert.equal(await draft.selectRemote(candidate), false);
  const original = F.clone(f.api.last('acquireRemoteAlbum').args[0]);
  assert.equal(draft.getSnapshot().remote.status, 'unknown');
  assert.equal(await draft.retryRemoteAcquisition(), true);
  const destination = {kind: 'create', draft_ref: JOB};
  assert.equal(draft.getSnapshot().formRef, JOB);
  assert.deepEqual(f.api.last('searchRemoteAlbums').args[0], {destination, title: 'Remote album', artist: 'Remote artist'});
  assert.deepEqual(f.api.last('beginRemotePreparation').args[0], {destination, form_ref: JOB});
  assert.deepEqual(f.api.last('acquireRemoteAlbum').args[0], original);
  assert.deepEqual(original.destination, destination);
  assert.equal(original.release_group_id, F.RG); assert.equal(original.preparation_ref, F.PARENT);
  for (const call of F.remoteCalls(f.api)) {
    assert.equal(call.args[1].scopeKey, F.SCOPE);
    assert.equal(call.args[1].remoteContext, f.api.identity);
    assert.equal(call.args[1].isCurrent(), true);
  }
  const [selected] = draft.getSnapshot().items;
  assert.equal(selected.album_ref, undefined); assert.equal(selected.item_ref, null);
  assert.equal(selected.selection_key, 'remote:' + F.ACQUISITION);
  assert.deepEqual(selected.source, {kind: 'remote_acquisition', acquisition_ref: F.ACQUISITION, evidence_version: F.VERSION});
  draft.edit({title: 'Explicitly reviewed row'});
  assert.equal(await draft.submit(), false); assert.equal(await draft.submit(), false);
  assert.equal(f.api.count('beginRemotePreparation'), 1); assert.equal(f.api.count('acquireRemoteAlbum'), 2);
  S.noWrites(f); S.noCleanup(f);
});

test('ordinary create retains its own generated destination and multi-selection mutation owner', async t => {
  const f = await S.base(t), draft = f.create({mode: 'edit', sourceJobRef: JOB});
  const [local] = await S.localResults(draft); assert.equal(await draft.select(local), true);
  const [remote] = await S.remoteResults(draft); assert.equal(await draft.selectRemote(remote), true);
  const form = draft.getSnapshot().formRef;
  assert.equal(draft.getSnapshot().sourceMatch, false);
  assert.match(form, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(form, JOB); assert.equal(draft.getSnapshot().items.length, 2);
  assert.deepEqual(f.api.last('beginRemotePreparation').args[0], {destination: {kind: 'create', draft_ref: form}, form_ref: form});
  assert.equal(draft.edit({title: 'Ordinary mixed Top'}), true);
  await draft.submit();
  assert.deepEqual(f.mutations, [['create', {title: 'Ordinary mixed Top', description: '', draft_ref: form,
    selections: [{kind: 'local_catalog', album_ref: F.C},
      {kind: 'remote_acquisition', acquisition_ref: F.ACQUISITION, evidence_version: F.VERSION}]}]]);
  assert.equal(f.api.count('execute'), 1);
});

test('source-match local selection uses real search and canonical admission, never caller evidence or implicit submit', async t => {
  const f = await S.fixture(t, {handlers: {admitAlbum: () => ({album_ref: F.id(813)})}});
  assert.equal(await f.draft.submit(), false);
  assert.equal(await f.draft.select(F.album(13)), false); assert.equal(f.api.count('admitAlbum'), 0);
  const [row] = await S.localResults(f.draft);
  assert.equal(await f.draft.select({...row, album_ref: F.id(999), title: 'Caller evidence is not a match'}), true);
  assert.equal(f.api.last('admitAlbum').args[0], 13);
  assert.equal(f.api.last('admitAlbum').args[1].scopeKey, F.SCOPE);
  const [selected] = f.draft.getSnapshot().items;
  assert.equal(selected.album_ref, F.id(813)); assert.equal(selected.title, 'Found local album');
  assert.equal(selected.local_album_id, 13); assert.equal(selected.item_ref, null);
  f.draft.edit({title: 'Not a create command', description: 'Row matching only'});
  assert.equal(await f.draft.submit(), false); assert.equal(await f.draft.submit(), false);
  assert.deepEqual(F.remoteCalls(f.api), []); S.noWrites(f);
});

for (const first of ['local', 'remote']) test(`one ${first} selection blocks both pools until explicit removal`, async t => {
  const f = await S.fixture(t, {handlers: {searchAlbums: () => ({albums: [F.album(13), F.album(14)], next_cursor: null})}});
  const locals = await S.localResults(f.draft), remotes = await S.remoteResults(f.draft);
  if (first === 'local') assert.equal(await f.draft.select(locals[0]), true);
  else assert.equal(await f.draft.selectRemote(remotes[0]), true);
  const original = F.clone(f.draft.getSnapshot().items), calls = f.api.calls.length;
  assert.equal(await f.draft.select(locals[1]), false);
  assert.equal(await f.draft.selectRemote(remotes[1]), false);
  assert.equal(f.api.calls.length, calls); assert.deepEqual(f.draft.getSnapshot().items, original);
  assert.equal(f.draft.remove(original[0].album_ref || original[0].selection_key), true);
  assert.deepEqual(f.draft.getSnapshot().items, []);
  if (first === 'local') assert.equal(await f.draft.selectRemote(remotes[1]), true);
  else assert.equal(await f.draft.select(locals[1]), true);
  assert.equal(f.draft.getSnapshot().items.length, 1); assert.equal(await f.draft.submit(), false);
  S.noWrites(f); S.noCleanup(f);
});

test('remote matches must be exact current search candidates, not cloned or stale raw summaries', async t => {
  const f = await S.fixture(t), [old] = await S.remoteResults(f.draft);
  assert.equal(await f.draft.selectRemote(F.clone(old)), false);
  assert.equal(f.draft.setRemoteTitle('Replacement query'), true);
  assert.equal(await f.draft.searchRemote(), true);
  assert.equal(await f.draft.selectRemote(old), false);
  assert.equal(f.api.count('beginRemotePreparation'), 0);
  const [current] = f.draft.getSnapshot().remote.search.candidates;
  assert.equal(await f.draft.selectRemote(current), true);
  assert.equal(f.draft.getSnapshot().items.length, 1); S.noWrites(f);
});

for (const grant of [F.BROWSE, F.CREATE, 'can_create']) test(`source-match uses the actual directory ${grant} permission gate`, async t => {
  const f = await S.fixture(t, {handlers: {list: () => ({tops: [], next_cursor: null,
    allowed_actions: {[F.BROWSE]: true, [F.CREATE]: true, can_create: true, [grant]: false}})}});
  assert.equal(f.controller.getSnapshot().directory.status, 'empty');
  assert.equal(f.draft.canEditMembership(), false);
  assert.equal(await f.draft.setQuery('Forbidden'), false);
  assert.equal(f.draft.setRemoteTitle('Forbidden'), false);
  assert.equal(await f.draft.searchRemote(), false); assert.equal(await f.draft.submit(), false);
  assert.equal(f.api.count('searchAlbums'), 0); assert.deepEqual(F.remoteCalls(f.api), []); S.noWrites(f);
});

test('source-match construction keeps existing unavailable-directory permission behavior', async t => {
  const f = await S.fixture(t, {ready: false});
  assert.equal(f.draft.canEdit(), false); assert.equal(await f.draft.setQuery('Wait for directory'), false);
  assert.equal(f.api.calls.length, 0); assert.equal(f.subscriptions.live, 1);
  assert.equal(await f.controller.load(), true); assert.equal(f.draft.canEditMembership(), true);
  await S.localResults(f.draft); assert.equal(f.api.count('searchAlbums'), 1); S.noWrites(f);
});

for (const sourceJobRef of [JOB, '00000000-0000-0000-0000-000000000001']) {
  test(`nonzero canonical job ${sourceJobRef} is accepted without a UUID-version restriction`, async t => {
    const f = await S.base(t), draft = f.create({sourceJobRef});
    assert.equal(draft.getSnapshot().sourceMatch, true); assert.equal(draft.getSnapshot().capacity, 1);
    await S.remoteResults(draft);
    assert.deepEqual(f.api.last('searchRemoteAlbums').args[0].destination, {kind: 'create', draft_ref: sourceJobRef});
    assert.equal(draft.getSnapshot().formRef, sourceJobRef); S.noWrites(f);
  });
}

test('source-match created during actual directory loading remains blocked until its authorized read completes', async t => {
  const gate = F.deferred(), f = await S.base(t, {ready: false, handlers: {list: () => gate.promise}});
  const pending = f.controller.load(), draft = f.create();
  assert.equal(f.controller.getSnapshot().directory.status, 'loading'); assert.equal(draft.canEditMembership(), false);
  assert.equal(await draft.setQuery('Not yet'), false); assert.equal(await draft.submit(), false);
  assert.equal(f.api.count('searchAlbums'), 0);
  gate.resolve({tops: [], next_cursor: null, allowed_actions: {[F.BROWSE]: true, [F.CREATE]: true, can_create: true}});
  assert.equal(await pending, true); assert.equal(draft.canEditMembership(), true);
  await S.localResults(draft); assert.equal(f.api.count('searchAlbums'), 1); S.noWrites(f);
});
