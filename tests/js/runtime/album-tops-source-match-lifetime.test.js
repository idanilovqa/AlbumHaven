'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./album-tops-source-match-fixtures/picker.cjs');
const {F, JOB, OTHER_JOB} = S;
test.before(S.load);

async function retire(f, cause) {
  if (cause === 'scope') {
    f.controller.setScope('source-match:new-session'); await f.controller.load();
    f.controller.setScope(F.SCOPE); await f.controller.load();
  } else if (cause === 'navigation') {
    await f.controller.open(F.TOP); await f.controller.open(null);
  } else if (cause === 'permission') {
    f.api.control.list = () => ({tops: [], next_cursor: null,
      allowed_actions: {[F.BROWSE]: true, [F.CREATE]: false, can_create: false}});
    await f.controller.load();
  } else if (cause === 'context') {
    f.api.setIdentity(Object.freeze({context: 'c'.repeat(64), generation: 2})); f.draft.refresh();
    f.api.setIdentity(f.api.identity); f.draft.refresh();
  } else if (cause === 'method') {
    const old = f.api.providers.remoteContext;
    f.api.providers.remoteContext = () => f.api.identity; f.draft.refresh();
    f.api.providers.remoteContext = old; f.draft.refresh();
  } else f.draft.dispose();
}

for (const first of ['local', 'remote']) test(`pending ${first} admission cannot overlap another pool or overfill on completion`, async t => {
  const gate = F.deferred(), handlers = first === 'local' ? {admitAlbum: () => gate.promise} : {acquireRemoteAlbum: () => gate.promise};
  handlers.searchAlbums = () => ({albums: [F.album(13), F.album(14)], next_cursor: null});
  const f = await S.fixture(t, {handlers}), locals = await S.localResults(f.draft), remotes = await S.remoteResults(f.draft);
  const pending = first === 'local' ? f.draft.select(locals[0]) : f.draft.selectRemote(remotes[0]);
  await F.drain();
  const method = first === 'local' ? 'admitAlbum' : 'acquireRemoteAlbum';
  assert.equal(f.api.count(method), 1); assert.equal(f.draft.getSnapshot().busy, true);
  const before = f.api.calls.length;
  assert.equal(await f.draft.select(locals[1]), false); assert.equal(await f.draft.selectRemote(remotes[1]), false);
  assert.equal(await f.draft.submit(), false); assert.equal(f.api.calls.length, before);
  gate.resolve(first === 'local' ? {album_ref: F.C} : f.api.acquisition(f.api.last(method).args[0]));
  assert.equal(await pending, true); assert.equal(f.draft.getSnapshot().items.length, 1);
  assert.equal(await f.draft.select(locals[1]), false); assert.equal(await f.draft.selectRemote(remotes[1]), false);
  assert.equal(f.draft.getSnapshot().items.length, 1); assert.equal(f.api.count(method), 1);
  S.noWrites(f); S.noCleanup(f);
});

for (const cause of ['scope', 'navigation', 'permission', 'dispose']) test(`pending local source-match admission is fenced by actual ${cause} retirement`, async t => {
  const gate = F.deferred(), f = await S.fixture(t, {handlers: {admitAlbum: () => gate.promise}});
  const [row] = await S.localResults(f.draft), pending = f.draft.select(row);
  assert.equal(f.api.count('admitAlbum'), 1);
  const request = f.api.last('admitAlbum').args[1];
  await retire(f, cause); gate.resolve({album_ref: F.C});
  assert.equal(await pending, false); assert.equal(request.signal.aborted, true);
  assert.deepEqual(f.draft.getSnapshot().items, []);
  const count = f.api.calls.length;
  assert.equal(await f.draft.select(row), false); assert.equal(await f.draft.submit(), false);
  assert.equal(f.api.calls.length, count); S.noWrites(f);
});

for (const stage of ['searchRemoteAlbums', 'beginRemotePreparation', 'acquireRemoteAlbum']) {
  for (const cause of ['scope', 'navigation', 'permission', 'context', 'method', 'dispose']) {
    test(`source-job ${stage} response cannot admit after ${cause} retirement or restoration`, async t => {
      const gate = F.deferred(), f = await S.fixture(t, {handlers: {[stage]: () => gate.promise}});
      let pending;
      if (stage === 'searchRemoteAlbums') {
        assert.equal(f.draft.setRemoteTitle('Pending source row'), true); pending = f.draft.searchRemote();
      } else {
        const [candidate] = await S.remoteResults(f.draft); pending = f.draft.selectRemote(candidate);
      }
      await F.drain(); assert.equal(f.api.count(stage), 1);
      const call = f.api.last(stage), body = call.args[0], request = call.args[1];
      assert.deepEqual(body.destination, {kind: 'create', draft_ref: JOB});
      await retire(f, cause);
      gate.resolve(stage === 'searchRemoteAlbums' ? F.searchPage(body, [F.summary()])
        : stage === 'beginRemotePreparation' ? f.api.parent(body) : f.api.acquisition(body));
      assert.equal(await pending, false); assert.equal(request.signal.aborted, true);
      assert.equal(request.isCurrent(), false); assert.equal(f.draft.canEditMembership(), false);
      assert.deepEqual(f.draft.getSnapshot().items, []);
      if (stage !== 'acquireRemoteAlbum') assert.equal(f.api.count('acquireRemoteAlbum'), 0);
      const count = f.api.calls.length;
      assert.equal(await f.draft.retryRemoteAcquisition(), false);
      assert.equal(await f.draft.submit(), false); assert.equal(f.api.calls.length, count);
      S.noWrites(f); S.noCleanup(f);
    });
  }
}

for (const status of [401, 403]) test(`consumed source-match ${status} retires actual controller authority before late rows can be selected`, async t => {
  const f = await S.fixture(t, {handlers: {acquireRemoteAlbum: () => {
    throw Object.assign(new Error('Source matching denied'), {status, code: 'forbidden', responseRejected: true});
  }}});
  const [candidate] = await S.remoteResults(f.draft);
  assert.equal(await f.draft.selectRemote(candidate), false);
  assert.equal(f.controller.getSnapshot().directory.status, 'denied');
  assert.equal(f.draft.getSnapshot().denied, true); assert.deepEqual(f.draft.getSnapshot().items, []);
  const count = f.api.calls.length;
  assert.equal(await f.draft.selectRemote(candidate), false); assert.equal(await f.draft.submit(), false);
  assert.equal(f.api.calls.length, count); S.noWrites(f);
});

test('late old-job denial cannot poison a replacement job using the same actual controller', async t => {
  const gate = F.deferred();
  const f = await S.fixture(t, {handlers: {acquireRemoteAlbum: () => gate.promise}});
  const [candidate] = await S.remoteResults(f.draft), old = f.draft.selectRemote(candidate);
  await F.drain(); assert.equal(f.api.count('acquireRemoteAlbum'), 1);
  f.controller.setScope('source-match:replacement-session'); await f.controller.load();
  delete f.api.control.acquireRemoteAlbum;
  const replacement = f.create({sourceJobRef: OTHER_JOB});
  const [newCandidate] = await S.remoteResults(replacement);
  assert.equal(await replacement.selectRemote(newCandidate), true);
  const selected = F.clone(replacement.getSnapshot().items);
  assert.deepEqual(f.api.last('acquireRemoteAlbum').args[0].destination, {kind: 'create', draft_ref: OTHER_JOB});
  gate.reject(Object.assign(new Error('Old consumed denial'), {status: 403, responseRejected: true}));
  assert.equal(await old, false);
  assert.equal(f.controller.getSnapshot().directory.status, 'ready');
  assert.equal(replacement.canEditMembership(), true);
  assert.deepEqual(replacement.getSnapshot().items, selected); assert.equal(replacement.getSnapshot().formRef, OTHER_JOB);
  assert.equal(await replacement.submit(), false); S.noWrites(f); S.noCleanup(f);
});

test('a begin acknowledgment subscriber cannot acquire after actual navigation changes the destination', async t => {
  const f = await S.fixture(t), [candidate] = await S.remoteResults(f.draft);
  let moved = false, navigation;
  const unsubscribe = f.draft.subscribe(() => {
    if (!moved && f.draft.getSnapshot().remote.preparation) {
      moved = true; navigation = f.controller.open(F.TOP);
    }
  });
  t.after(unsubscribe);
  assert.equal(await f.draft.selectRemote(candidate), false); await navigation;
  assert.equal(moved, true); assert.equal(f.api.count('beginRemotePreparation'), 1);
  assert.equal(f.api.count('acquireRemoteAlbum'), 0); assert.deepEqual(f.draft.getSnapshot().items, []); S.noWrites(f);
});

test('source-match disposal preserves the reviewed selection without cleanup or persistence I/O', async t => {
  const f = await S.fixture(t), [candidate] = await S.remoteResults(f.draft);
  assert.equal(await f.draft.selectRemote(candidate), true);
  const selected = F.clone(f.draft.getSnapshot().items), calls = f.api.calls.length;
  f.draft.dispose(); f.draft.dispose();
  assert.deepEqual(f.draft.getSnapshot().items, selected); assert.equal(f.subscriptions.live, 0);
  assert.equal(await f.draft.submit(), false); assert.equal(f.api.calls.length, calls);
  S.noWrites(f); S.noCleanup(f);
});
