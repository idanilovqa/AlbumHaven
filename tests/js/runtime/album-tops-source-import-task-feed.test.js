'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./album-tops-source-import-task-fixtures/tasks.cjs');
const {F, JOB, REQUEST, INPUT, summary, page, ready, drain, noImplicitActions} = H;
test.before(H.load);

for (const [status, top_ref, byline] of [
  ['queued', null, 'Waiting to process'], ['running', null, 'Processing source'],
  ['completed', null, 'Ready for review'], ['completed', H.SAVED_TOP, 'Album Top created'],
  ['failed', null, 'Source processing failed'], ['canceled', null, 'Import canceled'],
]) test(`real registry receives only truthful summary fields for ${status}/${top_ref ? 'saved' : 'unsaved'}`, async t => {
  const value = summary({status, top_ref, phase: top_ref ? 'top_created' : status === 'completed' ? 'review_evidence' : 'source_processing',
    error: status === 'failed' ? 'source_processing_failed' : null,
    source: {content: INPUT.content}, acquisition_ref: F.id(800), query: 'PRIVATE_QUERY', raw_url: 'https://private.example.test/path'});
  const h = await ready(t, {feed: [value]});
  assert.deepEqual(h.rows(), [{id: JOB, title: INPUT.title, createdAt: H.TIME, typeLabel: 'Album Top import', read: false, byline, statusLabel: byline}]);
  assert.equal(h.cards().length, 1); assert.match(h.cards()[0].markup, new RegExp(byline));
  assert.doesNotMatch(JSON.stringify(h.rows()), /Private source description|acquisition_ref|raw_url|PRIVATE_QUERY|private\.example|neverRunPrivateSource/);
  assert.deepEqual(h.tasks.getSnapshot(), {scopeKey: F.SCOPE, retainedCount: 0, capacity: 32, canCreate: true});
  noImplicitActions(h);
});

test('refresh and drawer Show read only and coalesce any overlapping requests into one successor', async t => {
  const h = await ready(t), first = h.hold('list'), second = h.hold('list');
  const before = h.calls('list').length;
  const work = h.tasks.refresh(); await drain();
  for (let n = 0; n < 10; n++) {h.tasks.refresh(); h.show();}
  await drain(); assert.equal(h.calls('list').length, before + 1);
  first.resolve(page()); await work; await drain();
  assert.equal(h.calls('list').length, before + 2);
  second.resolve(page([summary()])); await drain();
  assert.equal(h.calls('list').length, before + 2); assert.equal(h.rows().length, 1); noImplicitActions(h);
});

test('cursor pagination preserves all distinct persisted jobs independently of controller capacity', async t => {
  const h = await ready(t), first = Array.from({length: 50}, (_, n) => summary({job_ref: F.id(2000 + n), request_key: F.id(3000 + n)}));
  const last = summary({job_ref: F.id(2050), request_key: F.id(3050)}), cursor = F.id(4000);
  h.queue('list', page(first, cursor)); h.queue('list', page([last]));
  const before = h.calls('list').length; await h.tasks.refresh(); await drain();
  const calls = h.calls('list').slice(before);
  assert.equal(calls.length, 2); assert.equal(calls[0].options.cursor ?? null, null);
  assert.equal(calls[1].options.cursor, cursor); assert.equal(calls[1].path, `/album-tops/source-imports?cursor=${cursor}`);
  assert.equal(calls[0].options.signal, calls[1].options.signal); assert.equal(calls[0].options.scopeKey, F.SCOPE);
  assert.equal(h.rows().length, 51); assert.equal(h.tasks.getSnapshot().retainedCount, 0); noImplicitActions(h);
});

for (const [label, pages] of [
  ['malformed body', [{}]], ['malformed summary', [page([{...summary(), revision: '0'}])]],
  ['overlarge provider page', [page(Array.from({length: 51}, (_, n) => summary({job_ref: F.id(2000 + n)})))]],
  ['duplicate page identity', [page([summary(), summary()])]],
  ['duplicate across pages', [page([summary()], F.id(4000)), page([summary()])]],
  ['repeated cursor', [page([], F.id(4000)), page([], F.id(4000))]],
  ['invalid cursor', [page([], 'bad-cursor')]],
]) test(`feed fails closed for ${label}, without partial cards or automatic mutation retry`, async t => {
  const h = await ready(t, {feed: [summary()]});
  for (const value of pages) h.queue('list', value);
  const before = h.calls('list').length; await h.tasks.refresh(); await drain();
  assert.equal(h.cards().length, 0); assert.equal(h.currentRegistration().replacements.at(-1).status.status, 'error');
  assert.equal(h.calls('list').length, before + pages.length);
  await drain(); assert.equal(h.calls('list').length, before + pages.length); noImplicitActions(h);
});

for (const overflow of [false, true]) test(`feed ${overflow ? 'rejects page 101' : 'accepts exactly 100 pages'} without unbounded traversal`, async t => {
  const h = await ready(t), before = h.calls('list').length;
  for (let index = 0; index < 100; index++) h.queue('list', page(
    [summary({job_ref: F.id(2000 + index), request_key: F.id(3000 + index)})],
    index === 99 && !overflow ? null : F.id(4000 + index)));
  await h.tasks.refresh(); await drain();
  assert.equal(h.calls('list').length, before + 100);
  assert.equal(h.currentRegistration().replacements.at(-1).status.status, overflow ? 'error' : 'ready');
  assert.equal(h.cards().length, overflow ? 0 : 100); noImplicitActions(h);
});

test('ordinary list failure clears durable-only cards but preserves uncertain local submission without a retry loop', async t => {
  const h = await ready(t, {feed: [summary()]}), controller = h.tasks.create(), work = controller.submit(INPUT);
  await drain(); h.last('submit').reject(new TypeError('Lost acknowledgment')); await work; h.tasks.release(controller); await drain();
  const before = h.calls('list').length;
  h.queue('list', () => {throw new TypeError('List failed');}); await h.tasks.refresh(); await drain();
  assert.equal(h.calls('list').length, before + 1); assert.equal(h.tasks.getSnapshot().retainedCount, 1);
  assert.equal(controller.getSnapshot().status, 'uncertain');
  assert.equal(h.cards().length, 1); assert.match(h.cards()[0].id, /^pending:/);
  assert.equal(h.rows()[0].byline, 'Submission result unknown');
  assert.ok(h.env.owner('getRequestNotificationCards')().some(row => row.status && /could not be loaded/.test(row.markup)));
  await drain(); assert.equal(h.calls('list').length, before + 1); noImplicitActions(h);
  await h.tasks.refresh(); await drain(); assert.ok(h.cards().some(row => row.id === JOB));
});

for (const status of [401, 403]) test(`list ${status} retires all controllers before denial callback and recovers only on explicit successful read`, async t => {
  let h, beforeCallback;
  h = await ready(t, {denied(scope, error) {
    beforeCallback = {scope, status: error.status, snapshot: h.tasks.getSnapshot(), controller: controller.getSnapshot().status,
      aborted: request.options.signal.aborted, cards: h.cards().length};
  }});
  const controller = h.tasks.create(), work = controller.submit(INPUT); await drain(); const request = h.last('submit');
  h.queue('list', () => {throw Object.assign(new Error('Denied'), {status});});
  const before = h.calls('list').length; await h.tasks.refresh(); await drain();
  assert.equal(beforeCallback.scope, F.SCOPE); assert.equal(beforeCallback.status, status);
  assert.equal(beforeCallback.snapshot.canCreate, false); assert.equal(beforeCallback.snapshot.retainedCount, 0);
  assert.equal(beforeCallback.controller, 'retired'); assert.equal(beforeCallback.aborted, true); assert.equal(beforeCallback.cards, 0);
  assert.equal(h.currentRegistration().replacements.at(-1).status.status, 'denied');
  assert.equal(h.tasks.create(), null); await drain(); assert.equal(h.calls('list').length, before + 1);
  request.resolve(H.job({request_key: request.body.request_key})); assert.equal(await work, false); await drain();
  assert.equal(h.cards().length, 0); assert.equal(h.tasks.getSnapshot().canCreate, false);
  await h.show(); await drain(); assert.equal(h.tasks.getSnapshot().canCreate, true); assert.ok(h.tasks.create());
});
