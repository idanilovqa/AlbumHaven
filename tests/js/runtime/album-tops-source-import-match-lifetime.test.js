'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./album-tops-source-match-fixtures/session.cjs');
const {F, JOB, OTHER_JOB} = M;
test.before(M.load);

for (const state of ['loading', 'uncertain', 'result']) test(`matching constructor rejects actual import ${state} before allocating owners`, async t => {
  const h = await M.fixture(t), gate = F.deferred(); let pending;
  if (state === 'loading') {h.reply('read', gate.promise); pending = h.actualImport.open(JOB);}
  else if (state === 'uncertain') {
    h.reply('cancel', () => {throw new TypeError('Unknown cancel response');});
    assert.equal(await h.actualImport.cancel(), false); assert.equal(h.actualImport.getSnapshot().status, 'uncertain');
  } else {
    assert.equal(h.actualImport.select('1', M.local(F.A)), true);
    h.reply('finalize', (_path, _options, command) => M.receipt(command));
    assert.equal(await h.actualImport.finalize(), true); assert.ok(h.actualImport.getSnapshot().result);
  }
  const counts = {...h.subscriptions}, calls = h.api.calls.length + h.transport.length;
  assert.throws(() => h.construct(h.options()), TypeError);
  assert.deepEqual(h.subscriptions, counts); assert.equal(h.api.calls.length + h.transport.length, calls);
  if (pending) {gate.resolve(M.job()); assert.equal(await pending, true);}
  assert.deepEqual(M.selections(h), []);
});

for (const change of ['same review', 'revision', 'job', 'missing row', 'canceled', 'saved']) {
  test(`source refresh to ${change} permanently retires the old matching session`, async t => {
    const h = await M.fixture(t), session = h.create(); await M.selectLocal(session);
    const gate = F.deferred(), next = M.job();
    if (change === 'revision') next.revision = '5';
    if (change === 'job') next.job_ref = OTHER_JOB;
    if (change === 'missing row') {
      next.review.rows = next.review.rows.filter(row => row.row_ref !== '2');
      next.review.ordered_row_refs = next.review.ordered_row_refs.filter(ref => ref !== '2');
    }
    if (change === 'canceled') {next.status = 'canceled'; next.phase = 'source_processing';}
    if (change === 'saved') {next.top_ref = M.SAVED_TOP; next.phase = 'top_created';}
    h.reply('read', gate.promise); const pending = h.actualImport.open(next.job_ref);
    assert.equal(h.actualImport.getSnapshot().status, 'loading'); assert.equal(session.confirm(), false);
    gate.resolve(next); assert.equal(await pending, true);
    assert.equal(session.confirm(), false); assert.deepEqual(M.selections(h), []);
    assert.equal(await session.draft.submit(), false); M.noImplicitSave(h);
  });
}

for (const operation of ['process', 'cancel', 'finalize']) test(`explicit ${operation} starts elsewhere and retires matching before its acknowledgment`, async t => {
  const h = await M.fixture(t), session = h.create(); await M.selectLocal(session);
  if (operation === 'finalize') assert.equal(h.actualImport.select('1', M.local(F.A)), true);
  const gate = F.deferred(); h.reply(operation, gate.promise);
  const pending = h.actualImport[operation]();
  assert.equal(h.actualImport.getSnapshot().status, 'loading'); assert.equal(session.confirm(), false);
  const sent = h.transport.at(-1);
  gate.resolve(operation === 'finalize' ? M.receipt(sent.body)
    : M.job(operation === 'cancel' ? {status: 'canceled', phase: 'source_processing'} : {}));
  assert.equal(await pending, true); assert.equal(session.confirm(), false); assert.deepEqual(M.selections(h), []);
  const count = h.transport.length; session.dispose(); assert.equal(h.transport.length, count);
  assert.equal(h.topController.getSnapshot().selectedTopRef, null);
  assert.equal(h.api.count('execute'), 0);
  assert.equal(h.transport.filter(row => row.path === '/album-tops').length, operation === 'finalize' ? 1 : 0,
    'the only create is the explicit external finalization, never the matcher');
});

for (const outcome of ['error', 'uncertain']) test(`failed source operation ${outcome} cannot revive an already retired match`, async t => {
  const h = await M.fixture(t), session = h.create(); await M.selectLocal(session);
  const error = Object.assign(new Error('Synthetic cancel failure'), outcome === 'error' ? {responseRejected: true, status: 409} : {});
  h.reply('cancel', () => {throw error;}); assert.equal(await h.actualImport.cancel(), false);
  assert.equal(h.actualImport.getSnapshot().status, outcome); assert.equal(session.confirm(), false);
  assert.deepEqual(M.selections(h), []); M.noImplicitSave(h);
});

for (const change of ['scope', 'navigation', 'import lifetime', 'session disposal']) test(`matching cannot survive ${change} and restoration`, async t => {
  const h = await M.fixture(t), session = h.create(); await M.selectLocal(session);
  if (change === 'scope') {
    h.topController.setScope('source-import:new-session');
    assert.equal(session.confirm(), false); h.topController.setScope(F.SCOPE); await h.topController.load();
  } else if (change === 'navigation') {
    await h.topController.open(F.TOP); assert.equal(session.confirm(), false); await h.topController.open(null);
  } else if (change === 'import lifetime') {
    h.live.current = false; assert.equal(session.confirm(), false); h.live.current = true;
  } else {session.dispose(); session.dispose();}
  assert.equal(session.confirm(), false); assert.deepEqual(M.selections(h), []); M.noImplicitSave(h);
});

for (const pool of ['local', 'remote']) {
  for (const retirement of ['source read', 'cancel', 'scope', 'dispose']) {
    test(`late ${pool} admission after ${retirement} cannot publish a source-row match`, async t => {
      const gate = F.deferred(), method = pool === 'local' ? 'admitAlbum' : 'acquireRemoteAlbum';
      const h = await M.fixture(t, {handlers: {[method]: () => gate.promise}}), session = h.create();
      let pending;
      if (pool === 'local') {
        await session.draft.setQuery('Found'); pending = session.draft.select(session.draft.getSnapshot().search.items[0]);
      } else pending = session.draft.selectRemote(await M.remoteCandidate(session));
      await F.drain(); assert.equal(h.api.count(method), 1); assert.equal(session.confirm(), false, 'busy draft cannot confirm');
      const sent = h.api.last(method);
      if (retirement === 'source read') {h.reply('read', M.job()); await h.actualImport.open(JOB);}
      else if (retirement === 'cancel') {h.reply('cancel', M.job({status: 'canceled', phase: 'source_processing'})); await h.actualImport.cancel();}
      else if (retirement === 'scope') h.topController.setScope('source-import:new-library');
      else session.dispose();
      gate.resolve(pool === 'local' ? {album_ref: F.C} : h.api.acquisition(sent.args[0]));
      assert.equal(await pending, false); assert.equal(sent.args[1].signal.aborted, true);
      assert.equal(session.confirm(), false); assert.deepEqual(M.selections(h), []);
      assert.deepEqual(session.draft.getSnapshot().items, []);
      assert.equal(h.api.count('closeRemotePreparation'), 0); assert.equal(h.api.count('maintainRemotePreparations'), 0);
      assert.equal(h.api.count('execute'), 0); assert.equal(h.transport.filter(row => row.path === '/album-tops').length, 0);
    });
  }
}

for (const pool of ['local', 'remote']) test(`current directory denial fences a previously admitted ${pool} match`, async t => {
  const h = await M.fixture(t), session = h.create();
  if (pool === 'local') await M.selectLocal(session); else await M.selectRemote(session);
  assert.equal(h.topController.observeDenial(F.SCOPE, Object.assign(new Error('Denied'), {status: 403})), true);
  assert.equal(session.confirm(), false); assert.deepEqual(M.selections(h), []); M.noImplicitSave(h);
});

test('session disposal removes its import subscription and all draft/top subscriptions without any requests', async t => {
  const h = await M.fixture(t), session = h.create(); await M.selectRemote(session);
  assert.ok(h.subscriptions.importLive > 0); assert.ok(h.subscriptions.topLive > 0);
  const calls = h.api.calls.length + h.transport.length;
  session.dispose(); session.dispose();
  assert.equal(h.subscriptions.importLive, 0); assert.equal(h.subscriptions.topLive, 0);
  assert.equal(session.confirm(), false); assert.equal(h.api.calls.length + h.transport.length, calls);
  assert.deepEqual(M.selections(h), []); M.noImplicitSave(h);
});
