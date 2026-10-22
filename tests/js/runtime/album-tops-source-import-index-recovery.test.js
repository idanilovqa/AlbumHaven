'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');
const {fixture, submit, acknowledge, close, button, settle} = I;
test.before(I.load);

test('definitive rejection Close releases the actual task without confirmation before a fresh-key corrected import', async t => {
  const h = await fixture(t), first = await submit(h, {content: 'First immutable admitted source'});
  first.reply({error_code: 'source_rejected'}, 422); await settle();
  assert.equal(I.field(h.formHost(), 'Source content').disabled, true); assert.ok(button(h.formHost(), 'Retry'));
  assert.equal(h.owner('activeAppConfirmDialog'), null); assert.equal(await close(h), null);
  assert.equal(h.owner('activeAppConfirmDialog'), null); assert.equal(h.cards().length, 0);
  assert.equal(button(h.host, 'Import Album Top').disabled, false); assert.equal(h.count('submit'), 1);
  const second = await submit(h, {content: 'Corrected fresh source'});
  assert.notEqual(second.body.request_key, first.body.request_key); assert.equal(first.body.content, 'First immutable admitted source');
  assert.equal(second.body.content, 'Corrected fresh source'); assert.equal(h.count('submit'), 2);
  await acknowledge(h, second); const review = h.formHost().querySelector('[aria-label="Source review"]');
  assert.ok(review); assert.equal(review.hidden, false); assert.equal(h.owner('activeAppConfirmDialog'), null);
  assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0); assert.equal(h.navigations.length, 0);
});
