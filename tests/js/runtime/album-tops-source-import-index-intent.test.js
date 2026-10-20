'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');
const {fixture, job, summary, open, close, button, click, settle} = I;
test.before(I.load);
async function beginRead(h, value) {
  const forms = h.forms.length;
  h.activate(value.job_ref); await settle(); await h.settleNavigation();
  assert.equal(h.count('read'), 1); assert.equal(h.forms.length, forms);
  assert.equal(h.cards().find(card => card.id === value.job_ref).read, false);
  return h.last('read');
}

test('new admitted direct Import then Close supersedes an older notification read without reopening or marking its card', async t => {
  const value = job(), h = await fixture(t, {feed: [summary(value)]}), read = await beginRead(h, value);
  assert.equal(button(h.host, 'Import Album Top').disabled, false);
  const root = await open(h); assert.equal(h.forms.length, 1); assert.equal(h.keys.length, 1);
  assert.equal(I.field(root, 'Album Top title').value, ''); assert.equal(await close(h), null);
  read.reply(value); await settle();
  assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.forms.length, 1,
    'late success cannot replace the newer direct-entry intent even after its view has closed');
  assert.equal(h.cards().find(card => card.id === value.job_ref).read, false);
  const marked = h.currentSource().replacements.flatMap(row => row.rows).filter(row => row.id === value.job_ref && row.read);
  assert.equal(marked.length, 0); assert.equal(h.count('navigate'), 1); assert.equal(h.count('read'), 1);
  assert.equal(h.count('submit'), 0); assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0);
});

test('a real capacity-disabled direct Import cannot supersede the current notification read or consume another key', async t => {
  const value = job(), h = await fixture(t, {feed: [summary(value)]});
  // Thirty-one genuine unknown submissions plus the actual server-job read
  // reach the existing bound. No task snapshot or capacity owner is replaced.
  for (let n = 0; n < 31; n++) {
    const pending = await I.submit(h, {content: `Retained unknown ${n}`});
    pending.reject(new TypeError('Lost acknowledgment')); await settle(); assert.equal(await close(h), null);
  }
  const read = await beginRead(h, value), keys = [...h.keys], forms = h.forms.length;
  const refused = button(h.host, 'Import Album Top'); assert.ok(refused); assert.equal(refused.disabled, true);
  click(refused); await settle(); assert.equal(h.forms.length, forms); assert.deepEqual(h.keys, keys);
  assert.equal(h.owner('activeAppFormDialog'), null); read.reply(value); await settle();
  assert.equal(h.forms.length, forms + 1); assert.ok(h.formHost().querySelector('[aria-label="Source review"]'));
  assert.equal(h.cards().find(card => card.id === value.job_ref).read, true);
  assert.equal(h.count('read'), 1); assert.equal(h.count('navigate'), 1); assert.deepEqual(h.keys, keys);
  assert.equal(h.count('submit'), 31); assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0);
});
