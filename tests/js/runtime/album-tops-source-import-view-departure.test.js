'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {fixture, input, choose, file, fakeFile, fill, button, click, settle} = V;
test.before(V.load);

test('a clean intake grants dismissal without opening a confirmation or requesting closure itself', async t => {
  const h = await fixture(t); assert.equal(await h.view.beforeDismiss(), true);
  assert.equal(h.calls.confirms.length, 0); assert.equal(h.calls.close, 0); assert.equal(h.calls.importDispose, 0);
  assert.ok(h.host.children.length); V.noSave(h);
});

for (const change of ['title', 'description', 'content', 'kind', 'file']) test(`explicit ${change} intake changes require the actual native discard confirmation`, async t => {
  const h = await fixture(t);
  if (change === 'title') input(h.host, 'Album Top title', 'Dirty title');
  if (change === 'description') input(h.host, 'Album Top description', 'Dirty description');
  if (change === 'content') input(h.host, 'Source URL', 'https://example.test/dirty');
  if (change === 'kind') choose(h.host, 'text');
  if (change === 'file') {choose(h.host, 'uploaded_html'); file(h.host, fakeFile().value); await settle();}
  const first = h.view.beforeDismiss(); await settle(); assert.equal(h.calls.confirms.length, 1);
  assert.equal(await h.view.beforeDismiss(), false, 'one native departure confirmation owns the pending decision');
  h.answer(false); assert.equal(await first, false); await settle();
  assert.ok(h.host.children.length); assert.equal(h.calls.close, 0); assert.equal(h.count('submit'), 0);
  const second = h.view.beforeDismiss(); await settle(); h.answer(true); assert.equal(await second, true); await settle();
  assert.equal(h.calls.confirms.length, 2); assert.equal(h.calls.close, 0); assert.equal(h.calls.importDispose, 0);
  assert.ok(h.host.children.length, 'permission alone never disposes the surface');
});

test('Close requests the native wrapper dismissal without bypassing or owning its confirmation', async t => {
  const h = await fixture(t); fill(h); click(button(h.host, 'Close')); await settle();
  assert.equal(h.calls.close, 1); assert.equal(h.calls.confirms.length, 0); assert.ok(h.host.children.length);
  const allowed = h.view.beforeDismiss(); await settle(); h.answer(false); assert.equal(await allowed, false); await settle();
  assert.equal(h.calls.close, 1); assert.ok(h.host.children.length); V.noSave(h);
});

test('a positive confirmation for older intake values cannot authorize departure after an intervening edit', async t => {
  const h = await fixture(t); fill(h); const pending = h.view.beforeDismiss(); await settle();
  input(h.host, 'Album Top title', 'Changed after prompt'); h.answer(true); assert.equal(await pending, false); await settle();
  assert.equal(V.field(h.host, 'Album Top title').value, 'Changed after prompt'); assert.equal(h.calls.close, 0); V.noSave(h);
});

for (const retirement of ['dispose', 'depart', 'scope']) test(`late positive native confirmation cannot revive or close a ${retirement} surface`, async t => {
  const h = await fixture(t); fill(h); const pending = h.view.beforeDismiss(); await settle();
  if (retirement === 'dispose') h.view.dispose(); else h[retirement]();
  // The shared confirmation shell may remain until answered; the stale result
  // has no authority to close a replacement or restore source content.
  const modal = h.document.getElementById('app-confirm-modal'); if (!modal.hidden) h.answer(true);
  assert.equal(await pending, false); await settle();
  assert.equal(h.host.children.length, 0); assert.equal(h.calls.close, 0); assert.equal(h.calls.importDispose, 0); V.noSave(h);
});

test('acknowledged source input becomes a clean review baseline rather than prompting for already-saved intake', async t => {
  const h = await fixture(t); fill(h); click(button(h.host, 'Save source')); await settle();
  h.last('submit').resolve(V.commandJob(h.last('submit').body)); await settle();
  assert.equal(await h.view.beforeDismiss(), true); assert.equal(h.calls.confirms.length, 0); assert.equal(h.calls.close, 0); V.noSave(h);
});

test('an unchanged completed review is clean, explicit matching is dirty, and clearing restores its baseline', async t => {
  const h = await fixture(t, {opened: true}); assert.equal(await h.view.beforeDismiss(), true); assert.equal(h.calls.confirms.length, 0);
  await V.localMatch(h); const pending = h.view.beforeDismiss(); await settle(); h.answer(false); assert.equal(await pending, false); await settle();
  click(button(h.row('2'), 'Clear match for source row 2')); await settle();
  assert.equal(await h.view.beforeDismiss(), true); assert.equal(h.calls.confirms.length, 1); V.noSave(h);
});

test('confirming an ambiguous order is dirty even when the original row positions do not move', async t => {
  const review = V.review(); review.ordered_row_refs = null;
  const h = await fixture(t, {opened: true, wire: V.job({review})}); assert.equal(await h.view.beforeDismiss(), true);
  click(button(h.host, 'Confirm order')); await settle(); assert.deepEqual(h.actual.getSnapshot().rows.map(row => row.row_ref), ['1', '2', '3']);
  const pending = h.view.beforeDismiss(); await settle(); assert.equal(h.calls.confirms.length, 1);
  h.answer(true); assert.equal(await pending, true); await settle(); assert.equal(h.calls.close, 0); V.noSave(h);
});

test('a review selection change while native confirmation is pending invalidates the positive answer', async t => {
  const h = await fixture(t, {opened: true}); await V.localMatch(h); const pending = h.view.beforeDismiss(); await settle();
  assert.equal(h.actual.select('2', null), true); h.answer(true); assert.equal(await pending, false); await settle();
  assert.equal(await h.view.beforeDismiss(), true); assert.equal(h.calls.close, 0); V.noSave(h);
});

test('a newer job revision owns a fresh review baseline and invalidates the earlier discard prompt', async t => {
  const h = await fixture(t, {opened: true}); await V.localMatch(h); const pending = h.view.beforeDismiss(); await settle();
  h.setWire(V.job({revision: '5'})); assert.equal(await h.actual.open(V.JOB), true);
  h.answer(true); assert.equal(await pending, false); await settle(); assert.equal(h.actual.getSnapshot().job.revision, '5');
  assert.equal(await h.view.beforeDismiss(), true); assert.equal(h.calls.close, 0); V.noSave(h);
});

test('forced disposal is immediate, never prompts, and stale Close controls cannot request another dismissal', async t => {
  const h = await fixture(t); fill(h); const close = button(h.host, 'Close'); h.view.dispose(); h.view.dispose();
  click(close); await settle(); assert.equal(h.host.children.length, 0); assert.equal(h.calls.close, 0);
  assert.equal(h.calls.confirms.length, 0); assert.equal(h.calls.importDispose, 0); V.noSave(h);
});
