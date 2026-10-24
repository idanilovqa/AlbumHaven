'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const D = require('./foobar-account-diagnostic-pages-fixture.cjs'), {P, F} = D;
const table = f => f.host.querySelectorAll('[role="table"]').find(node => node.textContent.includes('Review finding'));
const rows = f => table(f).querySelectorAll('[data-cdt-column="row"]').map(node => node.textContent).filter(text => /· row [0-9]+$/.test(text));
const prepare = (f, value) => f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: value}));
const noWrites = f => assert.equal(f.wire.calls.filter(x => (x.route.startsWith('/job/') && x.route !== '/job/list') || x.route === '/review/personal-changes').length, 0);
test('D12 native problem table shows safe source labels exact instance totals and every reachable page', async t => {
  const value = D.page(); value.problem_items[0].source_title = '<img src=x onerror=alert(1)>';
  const f = await P.native(t, value); assert.ok(table(f)); const first = rows(f);
  assert.equal(first.length, 32); assert.ok(first[0].includes('<img src=x onerror=alert(1)>')); assert.equal(table(f).querySelectorAll('img,script').length, 0);
  assert.match(f.host.textContent, /40 problem instances in total\. 32 shown on this page\. 8 problem instances remain/); assert.match(f.host.textContent, /not distinct-track counts/);
  assert.equal(f.action('firstProblems').disabled, true); assert.equal(f.action('nextProblems').disabled, false);
  prepare(f, D.page(true)); f.click(f.action('nextProblems')); await F.settle(); await f.time.tick(); const second = rows(f);
  assert.equal(second.length, 8); assert.equal(new Set([...first, ...second]).size, 40);
  assert.match(f.host.textContent, /40 problem instances in total\. 8 shown on this page\. 0 problem instances remain/);
  assert.equal(f.action('nextProblems').disabled, true); assert.equal(f.action('firstProblems').disabled, false); noWrites(f);
});
test('D13 actual problem page clicks clear selections both confirmations and duplicate pending clicks', async t => {
  const f = await P.native(t, D.page()), original = P.fields(f); P.select(f, 0); P.acknowledge(f);
  f.field('confirmation').checked = true; f.change(f.field('confirmation'));
  prepare(f, D.page(true)); const before = f.wire.calls.length; f.click(f.action('nextProblems')); f.click(f.action('nextProblems')); await F.settle();
  assert.equal(f.wire.calls.length, before + 1); assert.equal(f.wire.calls.at(-1).init.body, f.selected);
  assert.ok(original.every(x => !x.checked)); assert.equal(f.field('confirmation').checked, false); assert.equal(f.field('personal-confirmation').checked, false);
  assert.equal(f.action('confirm').disabled, true); assert.equal(f.action('savePersonal').disabled, true);
  await f.time.tick(); assert.equal(P.fields(f).length, 32); assert.ok(P.fields(f).every(x => !x.checked));
  P.select(f, 0); P.acknowledge(f); prepare(f, D.page()); f.click(f.action('firstProblems')); await F.settle();
  assert.equal(D.header(f.wire.calls.at(-1)).problem_after, 0); assert.equal(D.header(f.wire.calls.at(-1)).conflict_after, 0); assert.equal(D.header(f.wire.calls.at(-1)).previous_review_sha256, null);
  await f.time.tick(); assert.equal(f.field('personal-confirmation').checked, false); assert.ok(P.fields(f).every(x => !x.checked)); noWrites(f);
});
test('D14 native problem and conflict navigation preserve the other cursor and reset together', async t => {
  const f = await P.native(t, D.page()); prepare(f, D.page(false, true)); f.click(f.action('nextConflicts')); await F.settle(); await f.time.tick();
  prepare(f, D.page(true, true)); f.click(f.action('nextProblems')); await F.settle();
  assert.equal(D.header(f.wire.calls.at(-1)).conflict_after, 64); assert.equal(D.header(f.wire.calls.at(-1)).problem_after, 63); await f.time.tick();
  prepare(f, D.page()); f.click(f.action('firstConflicts')); await F.settle();
  assert.equal(D.header(f.wire.calls.at(-1)).conflict_after, 0); assert.equal(D.header(f.wire.calls.at(-1)).problem_after, 0); await f.time.tick();
  assert.equal(rows(f).length, 32); assert.equal(P.fields(f).length, 32); assert.equal(f.field('matching').checked, true); noWrites(f);
});
test('D15 native pagehide retires pending problem navigation and ignores late acknowledgement', async t => {
  const f = await P.native(t, D.page()), late = F.deferred();
  const confirmation = f.field('confirmation'), personalConfirmation = f.field('personal-confirmation'); f.wire.enqueue('/review/start', () => late.promise);
  f.click(f.action('nextProblems')); await F.settle(); const request = f.wire.calls.at(-1);
  f.c.dispatchEvent(new f.c.Event('pagehide')); assert.equal(request.init.signal.aborted, true);
  late.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await F.settle();
  assert.equal(f.time.tasks.size, 0); assert.equal(confirmation.checked, false); assert.equal(personalConfirmation.checked, false); assert.equal(f.host.querySelector('.foobar-import'), null); noWrites(f);
});
