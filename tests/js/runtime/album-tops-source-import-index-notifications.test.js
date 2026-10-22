'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');
const {fixture, job, summary, button, click, settle, F} = I;
test.before(I.load);
async function begin(t, {value = job(), ...options} = {}) {
  const h = await fixture(t, {...options, feed: [summary(value)]}); h.activate(value.job_ref); await settle();
  assert.equal(h.count('navigate'), 1); assert.equal(h.count('read'), 0); await h.settleNavigation();
  assert.equal(h.count('read'), 1); return {h, value, read: h.last('read')};
}

for (const key of [null, 'Enter', ' ']) test(`server-only notification ${key || 'click'} uses actual native directory, exact read, dialog and one read mark`, async t => {
  const value = job(), h = await fixture(t, {topRef: F.TOP, feed: [summary(value)]});
  assert.equal(h.navigations.length, 0); assert.equal(h.forms.length, 0); assert.equal(h.count('read'), 0);
  assert.equal(h.cards()[0].read, false); h.activate(value.job_ref, key); await settle();
  assert.equal(h.navigations[0].options.top_ref, null); assert.equal(h.count('read'), 0); assert.equal(h.cards()[0].read, false);
  await h.settleNavigation(); const read = h.last('read'); assert.equal(new URL(read.url, h.location).pathname, `/album-tops/source-imports/${value.job_ref}`);
  assert.equal(read.options.method, 'GET'); assert.equal(read.options.headers['X-AlbumHaven-Context'], I.N.A);
  assert.equal(h.forms.length, 0); read.reply(value); await settle();
  assert.equal(h.forms.length, 1); assert.equal(h.forms[0].options.pageId, 'album-top-import');
  assert.ok(h.formHost().querySelector('[aria-label="Source review"]')); assert.equal(h.cards()[0].read, true);
  const source = h.currentSource(), readChanges = source.replacements.filter((row, index, all) => row.rows.find(card => card.id === value.job_ref)?.read === true
    && all[index - 1]?.rows.find(card => card.id === value.job_ref)?.read !== true);
  assert.equal(readChanges.length, 1); assert.equal(h.count('read'), 1); assert.equal(h.count('submit'), 0); I.privateFree(h);
});

test('completion and explicit feed refresh update cards without opening or navigating', async t => {
  const h = await fixture(t, {feed: [summary(job({status: 'running', review: null, phase: 'source_processing'}))]});
  h.setFeed([summary(job())]); await h.showNotifications(); assert.equal(h.cards().length, 1);
  assert.match(h.cards()[0].markup, /Ready for review/); assert.equal(h.navigations.length, 0); assert.equal(h.forms.length, 0);
  assert.equal(h.count('read'), 0); assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0);
});

test('a duplicate pending activation leaves the original navigation/read owner intact', async t => {
  const value = job(), h = await fixture(t, {feed: [summary(value)]}); h.activate(value.job_ref); await settle();
  const work = h.navigations[0]; h.activate(value.job_ref); await settle(); assert.equal(h.navigations.length, 1);
  assert.equal(work.options.isCurrent(), true); await h.settleNavigation(); h.activate(value.job_ref); await settle();
  assert.equal(h.count('read'), 1); assert.equal(h.navigations.length, 1); h.last('read').reply(value); await settle();
  assert.equal(h.forms.length, 1); assert.equal(h.cards()[0].read, true);
});

for (const failure of ['rejected', 'wrong job', 'wrong request']) test(`server-only ${failure} read cannot mark a notification as opened`, async t => {
  const {h, value, read} = await begin(t);
  if (failure === 'rejected') read.reply({error_code: 'temporary_failure'}, 503);
  else read.reply(job(failure === 'wrong job' ? {job_ref: F.OTHER} : {request_key: F.id(999), source: {...value.source, request_key: F.id(999)}}));
  await settle(); assert.equal(h.cards()[0].read, false);
  if (failure === 'rejected') {
    assert.ok(button(h.formHost(), 'Retry')); click(button(h.formHost(), 'Retry')); await settle(); assert.equal(h.count('read'), 2);
    h.last('read').reply(value); await settle(); assert.ok(h.formHost().querySelector('[aria-label="Source review"]'));
    assert.equal(h.cards()[0].read, false, 'read retry alone is not a successful notification Open');
    assert.equal(await I.close(h), null); h.activate(value.job_ref); await settle(); await h.settleNavigation();
    assert.equal(h.count('read'), 3, 'Close safely collected the settled controller; explicit Open starts a fresh read');
    assert.equal(h.owner('activeAppFormDialog'), null);
    assert.equal(h.cards()[0].read, false); const fresh = h.last('read'); assert.equal(fresh.url, read.url);
    fresh.reply(value); await settle(); assert.ok(h.formHost().querySelector('[aria-label="Source review"]'));
    assert.equal(h.cards()[0].read, true);
  } else if (failure === 'wrong job') {
    // The real provider rejects a wrong-job DTO before acknowledgment. A
    // retained read-error view is allowed, but it must expose only Retry.
    if (h.forms.length) {
      assert.ok(button(h.formHost(), 'Retry'));
      const review = h.formHost().querySelector('[aria-label="Source review"]');
      assert.ok(review); assert.equal(review.hidden, true);
      assert.equal(review.querySelectorAll('[data-source-row-ref]').length, 0);
    }
  } else assert.equal(h.forms.length, 0, 'acknowledged request mismatch cannot enter a source dialog');
  assert.equal(h.count('submit'), 0); assert.equal(h.count('finalize'), 0);
});

test('a failed native directory navigation never starts the server job read or marks its card', async t => {
  const value = job(), h = await fixture(t, {feed: [summary(value)]}); h.activate(value.job_ref); await settle();
  h.last('navigate').reply({error: 'navigation lost'}, 503); await settle();
  assert.equal(h.count('read'), 0); assert.equal(h.forms.length, 0); assert.equal(h.cards()[0].read, false);
  h.activate(value.job_ref); await settle(); assert.equal(h.count('navigate'), 2); await h.settleNavigation();
  h.last('read').reply(value); await settle(); assert.equal(h.cards()[0].read, true);
});

test('superseding directory navigation cannot consume the old card activation or start its read', async t => {
  const value = job(), h = await fixture(t, {feed: [summary(value)]}); h.activate(value.job_ref); await settle(); const old = h.last('navigate');
  const next = h.runtime.navigate({top_ref: F.OTHER}); await settle(); h.last('navigate').reply(I.route(F.OTHER)); assert.equal(await next, true);
  old.reply(I.route()); await settle(); assert.equal(h.runtime.snapshot().topRef, F.OTHER);
  assert.equal(h.count('read'), 0); assert.equal(h.forms.length, 0); assert.equal(h.cards()[0].read, false);
});

for (const reason of ['actor', 'library', 'context', 'logout', 'registry', 'dispose', 'navigation', 'receipt']) test(`pending notification read cannot open or mark after ${reason} retirement`, async t => {
  const {h, value, read} = await begin(t); const oldSource = h.currentSource();
  if (reason === 'registry') await h.replaceRegistry();
  else if (reason === 'dispose') await h.dispose();
  else if (reason === 'navigation') await h.navigate(F.OTHER);
  else if (reason === 'receipt') {h.setFeed([summary(job({revision: '5', phase: 'top_created', top_ref: I.SAVED_TOP}))]); await h.showNotifications();}
  else await h.change(reason);
  read.reply(value); await settle(); assert.equal(h.forms.length, 0);
  assert.ok(h.cards().every(card => !card.read));
  const oldMarks = oldSource.replacements.flatMap(row => row.rows).filter(row => row.id === value.job_ref && row.read);
  assert.deepEqual(oldMarks, []); assert.equal(h.count('submit'), 0);
  if (['actor','library','context','logout','registry','dispose'].includes(reason)) assert.equal(read.options.signal.aborted, true);
});

test('newer explicit card Open wins over the earlier pending job read and old completion cannot close its dialog', async t => {
  const first = job(), second = job({job_ref: F.OTHER, request_key: F.id(998), source: {...I.SOURCE, request_key: F.id(998)}});
  const h = await fixture(t, {feed: [summary(first), summary(second)]}); h.activate(first.job_ref); await settle(); await h.settleNavigation();
  const old = h.last('read'); h.activate(second.job_ref); await settle(); await h.settleNavigation();
  const current = h.last('read'); assert.notEqual(current, old); current.reply(second); await settle(); const root = h.formHost();
  old.reply(first); await settle(); assert.equal(h.formHost(), root); assert.equal(h.forms.length, 1);
  assert.equal(h.cards().find(row => row.id === second.job_ref).read, true); assert.equal(h.cards().find(row => row.id === first.job_ref).read, false);
});

test('an already saved source card explicitly opens only its validated Top without reading or finalizing the source', async t => {
  const value = job({revision: '5', phase: 'top_created', top_ref: I.SAVED_TOP}), h = await fixture(t, {feed: [summary(value)]});
  assert.equal(h.navigations.length, 0); h.activate(value.job_ref); await settle();
  assert.equal(h.navigations[0].options.top_ref, I.SAVED_TOP); await h.settleNavigation(I.SAVED_TOP);
  assert.equal(h.runtime.snapshot().topRef, I.SAVED_TOP); assert.equal(h.cards()[0].read, true);
  assert.equal(h.count('read'), 0); assert.equal(h.count('finalize'), 0); assert.equal(h.forms.length, 0);
});
