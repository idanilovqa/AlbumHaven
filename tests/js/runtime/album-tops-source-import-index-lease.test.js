'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');
const {fixture, close, button, click, settle, summary} = I;
test.before(I.load);

for (const uncertain of [false, true]) test(`reopened ${uncertain ? 'uncertain' : 'pending'} card keeps its actual UUID-less controller through acknowledgment and durable feed`, async t => {
  const h = await fixture(t), original = await I.submit(h, {content: 'Exact retained source'}), oldForm = h.forms[0];
  if (uncertain) {original.reject(new TypeError('Lost acknowledgment')); await settle();}
  assert.equal(await close(h), null); assert.equal(original.options.signal.aborted, false);
  const keys = [...h.keys], id = 'pending:' + original.body.request_key;
  h.activate(id); await settle(); await h.settleNavigation();
  assert.equal(h.count('read'), 0); assert.equal(h.count('submit'), 1); assert.deepEqual(h.keys, keys);
  const active = h.owner('activeAppFormDialog'), reopened = h.formHost(); assert.ok(active);
  assert.equal(h.forms.length, 2); assert.equal(I.field(reopened, 'Source content').disabled, true);
  assert.equal(h.cards().find(card => card.id === id).read, true);
  // Exercise the captured actual old native owner, not a replacement close stub.
  await oldForm.result.close(null, {force: true, restoreFocus: false}); await settle();
  assert.equal(h.owner('activeAppFormDialog'), active);
  let acknowledged = original;
  if (uncertain) {click(button(reopened, 'Retry')); await settle(); acknowledged = h.last('submit');
    assert.deepEqual(acknowledged.body, original.body); assert.equal(h.count('submit'), 2);}
  const value = await I.acknowledge(h, acknowledged); h.setFeed([summary(value)]); await h.showNotifications();
  assert.equal(h.owner('activeAppFormDialog'), active); assert.ok(h.formHost().querySelector('[aria-label="Source review"]'));
  assert.equal(h.count('read'), 0); assert.equal(h.count('process'), 0); assert.deepEqual(h.keys, keys);
  await I.match(h, '2'); click(button(h.formHost(), 'Save Album Top')); await settle();
  const save = h.last('finalize'); assert.equal(save.body.request_key, I.JOB);
  assert.deepEqual(save.body.source_review.rows.find(row => row.row_ref === '2').selection,
    {kind: 'local_catalog', album_ref: I.F.C});
  save.reply(I.receipt(save.body)); await settle(); assert.ok(button(h.formHost(), 'Open Album Top'));
  assert.equal(h.count('submit'), uncertain ? 2 : 1); assert.equal(h.count('finalize'), 1); assert.equal(h.count('navigate'), 1);
});

test('receipt handoff lease survives its own form close and matching saved feed until failed destination reopens the exact receipt', async t => {
  const h = await fixture(t), save = await I.saved(h), submit = h.last('submit');
  click(button(h.formHost(), 'Open Album Top')); await settle(); const navigation = h.last('navigate');
  assert.equal(h.owner('activeAppFormDialog'), null);
  h.setFeed([summary(I.job({request_key: submit.body.request_key, title: submit.body.title, kind: submit.body.kind,
    source: I.F.clone(submit.body), revision: '5', top_ref: I.SAVED_TOP, phase: 'top_created'}))]);
  await h.showNotifications(); assert.equal(h.owner('activeAppFormDialog'), null);
  navigation.reply({error: 'Current destination failed'}, 503); await settle();
  assert.ok(button(h.formHost(), 'Open Album Top')); assert.equal(h.count('read'), 0); assert.equal(h.count('finalize'), 1);
  assert.equal(h.last('finalize'), save); click(button(h.formHost(), 'Open Album Top')); await settle();
  await h.settleNavigation(I.SAVED_TOP); assert.equal(h.runtime.snapshot().topRef, I.SAVED_TOP);
  assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.count('submit'), 1); assert.equal(h.count('process'), 0);
  assert.equal(h.count('finalize'), 1); assert.equal(h.count('navigate'), 2);
});
