'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {fixture, fill, field, button, click, choice, settle} = V;
const INPUT = Object.fromEntries(Object.entries(V.SOURCE).filter(([key]) => key !== 'request_key'));
const RECOVERY = 'This submission was rejected. Retry the same source, or close this view and start a new import to change it.';
let mountSourceImportView;
test.before(async () => {await V.load(); ({mountSourceImportView} = await V.F.load('album-tops/source-import-view.mjs'));});
const rejected = () => Object.assign(new Error('SECRET_SERVER_REJECTION'), {status: 409, responseRejected: true});
function locked(h) {
  assert.equal(h.actual.canSubmit(), false);
  for (const label of ['Album Top title', 'Album Top description']) assert.equal(field(h.host, label).disabled, true);
  assert.equal(choice(h.host, 'Source type').disabled, true); assert.equal(button(h.host, 'Save source').disabled, true);
  assert.equal(button(h.host, 'Close').disabled, false);
  for (const node of h.host.querySelectorAll('input,textarea')) {
    assert.equal(node.disabled, true); node.value = 'Attempted replacement'; node.dispatchEvent(new h.context.Event('input'));
  }
  click(button(h.host, 'Save source')); assert.equal(h.count('submit'), 1);
}
async function retryExact(h, original) {
  click(button(h.host, 'Retry')); await settle(); assert.equal(h.count('submit'), 2);
  assert.deepEqual(h.last('submit').body, original.body); assert.equal(h.keyCalls(), 1);
  h.last('submit').resolve(V.commandJob(original.body)); await settle(); assert.equal(h.actual.getSnapshot().status, 'ready');
  assert.equal(h.actual.getSnapshot().job.source.content, original.body.content); V.noSave(h);
}

test('definitive server rejection locks the current intake and gives honest exact-retry or new-import recovery', async t => {
  const h = await fixture(t); fill(h); click(button(h.host, 'Save source')); await settle(); const original = h.last('submit');
  original.reject(rejected()); await settle(); assert.equal(h.actual.getSnapshot().status, 'error'); locked(h);
  assert.ok(h.host.textContent.includes(RECOVERY)); assert.doesNotMatch(h.host.textContent, /SECRET_SERVER_REJECTION/);
  await retryExact(h, original);
});

test('a remounted view over an already-dispatched definitive rejection cannot mistake it for editable local validation', async t => {
  const h = await fixture(t), pending = h.actual.submit(INPUT); await settle(); const original = h.last('submit');
  original.reject(rejected()); assert.equal(await pending, false); await settle(); assert.equal(h.actual.canSubmit(), false);
  h.view.dispose(); const resumed = mountSourceImportView(h.host, h.runtime, h.props);
  try {
    locked(h); assert.ok(h.host.textContent.includes(RECOVERY)); assert.doesNotMatch(h.host.textContent, /SECRET_SERVER_REJECTION/);
    assert.equal(h.calls.close, 0); click(button(h.host, 'Close')); assert.equal(h.calls.close, 1);
    assert.equal(h.actual.getSnapshot().status, 'error'); assert.equal(h.calls.importDispose, 0);
    await retryExact(h, original);
  } finally {resumed.dispose();}
});

test('a remounted locally rejected controller remains editable and its corrected intake reuses the allocated key', async t => {
  const h = await fixture(t); assert.equal(await h.actual.submit({...INPUT, content: '\ud800'}), false); await settle();
  assert.equal(h.actual.getSnapshot().status, 'error'); assert.equal(h.actual.getSnapshot().error.responseRejected, true);
  assert.equal(h.actual.canSubmit(), true); assert.equal(h.count('submit'), 0); assert.equal(h.keyCalls(), 1);
  h.view.dispose(); const resumed = mountSourceImportView(h.host, h.runtime, h.props);
  try {
    assert.equal(field(h.host, 'Album Top title').disabled, false); assert.equal(field(h.host, 'Album Top description').disabled, false);
    assert.equal(choice(h.host, 'Source type').disabled, false); assert.equal(h.host.textContent.includes(RECOVERY), false);
    fill(h, 'text', 'New corrected private source'); click(button(h.host, 'Save source')); await settle();
    assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1); assert.equal(h.last('submit').body.request_key, V.REQUEST);
    assert.equal(h.last('submit').body.content, 'New corrected private source');
    h.last('submit').resolve(V.commandJob(h.last('submit').body)); await settle(); assert.equal(h.actual.getSnapshot().status, 'ready'); V.noSave(h);
  } finally {resumed.dispose();}
});

test('a remounted uncertain submission stays locked and retained until an explicit exact retry settles it', async t => {
  const h = await fixture(t), pending = h.actual.submit(INPUT); await settle(); const original = h.last('submit');
  original.reject(new Error('SECRET_UNCERTAIN_RESULT')); assert.equal(await pending, false); await settle();
  h.view.dispose(); const resumed = mountSourceImportView(h.host, h.runtime, h.props);
  try {
    locked(h); assert.equal(h.actual.getSnapshot().status, 'uncertain'); assert.match(h.host.textContent, /unknown|uncertain/i);
    assert.equal(h.host.textContent.includes(RECOVERY), false); assert.doesNotMatch(h.host.textContent, /SECRET_UNCERTAIN_RESULT/);
    await retryExact(h, original);
  } finally {resumed.dispose();}
});
