'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {fixture, fill, field, input, button, click, settle} = V;
test.before(V.load);

for (const invalid of ['blank title', 'unpaired surrogate']) test(`locally rejected ${invalid} remains editable without Retry and correction retains its key`, async t => {
  const h = await fixture(t); fill(h);
  input(h.host, invalid === 'blank title' ? 'Album Top title' : 'Source content', invalid === 'blank title' ? ' ' : '\ud800');
  click(button(h.host, 'Save source')); await settle();
  assert.equal(h.actual.getSnapshot().status, 'error'); assert.equal(h.actual.canSubmit(), true);
  assert.equal(h.count('submit'), 0); assert.equal(h.keyCalls(), 1); assert.equal(button(h.host, 'Retry'), undefined);
  assert.equal(field(h.host, 'Album Top title').disabled, false); assert.equal(field(h.host, 'Source content').disabled, false);
  assert.equal(button(h.host, 'Save source').disabled, false); assert.ok(h.host.querySelector('[role="alert"]'));
  input(h.host, invalid === 'blank title' ? 'Album Top title' : 'Source content', 'Corrected source');
  click(button(h.host, 'Save source')); await settle(); assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1);
  assert.equal(h.last('submit').body.request_key, V.REQUEST);
  h.last('submit').resolve(V.commandJob(h.last('submit').body)); await settle();
  assert.equal(h.actual.getSnapshot().status, 'ready'); assert.equal(h.calls.confirms.length, 0); V.noSave(h);
});

for (const status of [409, 422]) test(`dispatched definitive ${status} rejection permits dismissal without treating admitted intake as an unsent draft`, async t => {
  const h = await fixture(t); fill(h); click(button(h.host, 'Save source')); await settle(); const request = h.last('submit');
  request.reject(Object.assign(new Error('PRIVATE_REJECTION'), {status, responseRejected: true})); await settle();
  assert.equal(h.actual.getSnapshot().status, 'error'); assert.equal(h.actual.canSubmit(), false);
  assert.equal(field(h.host, 'Source content').disabled, true); assert.ok(button(h.host, 'Retry'));
  assert.match(h.host.textContent, /Retry the same source, or close this view and start a new import/);
  const allowed = h.view.beforeDismiss(); await settle(); assert.equal(h.calls.confirms.length, 0);
  assert.equal(await allowed, true); assert.equal(h.calls.close, 0, 'dismissal permission does not itself close the wrapper');
  assert.equal(h.actual.getSnapshot().status, 'error'); assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1);
  click(button(h.host, 'Close')); await settle(); assert.equal(h.calls.close, 1); assert.equal(h.calls.importDispose, 0);
  V.noSave(h);
});

for (const localError of [false, true]) test(`${localError ? 'locally rejected editable' : 'unsent editable'} input still requires real discard confirmation`, async t => {
  const h = await fixture(t); fill(h);
  if (localError) {input(h.host, 'Album Top title', ' '); click(button(h.host, 'Save source')); await settle();}
  assert.equal(h.actual.canSubmit(), true); assert.equal(h.count('submit'), 0);
  const canceled = h.view.beforeDismiss(); await settle(); assert.equal(h.calls.confirms.length, 1);
  h.answer(false); assert.equal(await canceled, false); await settle(); assert.ok(h.host.children.length);
  const accepted = h.view.beforeDismiss(); await settle(); assert.equal(h.calls.confirms.length, 2);
  h.answer(true); assert.equal(await accepted, true); await settle();
  assert.equal(h.calls.close, 0); assert.equal(h.calls.importDispose, 0); assert.equal(h.count('submit'), 0); V.noSave(h);
});

test('uncertain admitted intake stays retained with exact explicit Retry and no editable-draft confirmation', async t => {
  const h = await fixture(t); fill(h); click(button(h.host, 'Save source')); await settle(); const first = h.last('submit');
  first.reject(new TypeError('response lost')); await settle();
  assert.equal(h.actual.getSnapshot().status, 'uncertain'); assert.equal(h.actual.canSubmit(), false);
  assert.equal(field(h.host, 'Source content').disabled, true); assert.ok(button(h.host, 'Retry'));
  assert.equal(await h.view.beforeDismiss(), true); assert.equal(h.calls.confirms.length, 0); assert.equal(first.options.signal.aborted, false);
  click(button(h.host, 'Retry')); await settle(); assert.equal(h.count('submit'), 2); assert.equal(h.keyCalls(), 1);
  assert.deepEqual(h.last('submit').body, first.body); assert.equal(h.last('submit').path, first.path);
  h.last('submit').resolve(V.commandJob(first.body)); await settle(); assert.equal(h.actual.getSnapshot().status, 'ready'); V.noSave(h);
});
