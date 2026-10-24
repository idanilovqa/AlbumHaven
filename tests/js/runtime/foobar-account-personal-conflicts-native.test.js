'use strict';
// Real native renderer/controller in the existing platform-only native harness.
// These are not browser layout, accessibility-tree, backend or persistence tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./foobar-account-personal-conflicts-fixture.cjs'), {F, N} = P;
const saves = f => f.wire.calls.filter(call => call.route === '/review/personal-changes');
const jobs = f => f.wire.calls.filter(call => (call.route.startsWith('/job/') && call.route !== '/job/list'));
const conflictsTable = f => f.host.querySelectorAll('[role="table"]').find(node => node.textContent.includes('Consequence or reason unavailable'));

test('P23 native conflict table shows exact field values consequences and preserve-by-default controls', async t => {
  const f = await P.native(t), table = conflictsTable(f); assert.ok(table); assert.equal(table.getAttribute('data-cdt-mobile'), 'stack');
  for (const label of ['Song from source (labels may be shortened)', 'Field', 'Your current value', 'Incoming proposal', 'Consequence or reason unavailable']) assert.ok(table.textContent.includes(label));
  assert.match(table.textContent, /Source artist \/ Source song \(Source album\) · row 1/);
  assert.match(table.textContent, /2 of 5/); assert.match(table.textContent, /5 of 5/); assert.match(table.textContent, /Off/); assert.match(table.textContent, /Loved/);
  assert.match(f.host.textContent, /3 personal-field conflicts in total\. 3 shown on this page\. 0 conflicts remain/);
  assert.match(f.host.textContent, /separate from import/); assert.match(f.host.textContent, /does not import source rows or advance import progress/);
  assert.equal(P.fields(f).length, 3); assert.ok(P.fields(f).every(node => node.checked === false));
  assert.equal(f.field('personal-confirmation').checked, false); assert.equal(f.action('savePersonal').disabled, true);
  assert.equal(f.action('nextConflicts').disabled, true); assert.equal(f.action('firstConflicts').disabled, true);
  assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0);
});
test('P24 native controls offer individual fields only and never a select-all or blanket save', async t => {
  const f = await P.native(t, P.page());
  assert.equal(P.fields(f).length, 32); assert.match(f.host.textContent, /40 personal-field conflicts in total\. 32 shown on this page\. 8 conflicts remain/);
  const actionable = f.host.querySelectorAll('button,input').map(node => (node.getAttribute('data-foobar-import-action') || '') + ' ' + (node.getAttribute('aria-label') || '') + ' ' + node.textContent).join('\n');
  assert.doesNotMatch(actionable, /select.?all|apply.?all|save.?all|override.?all/i);
  assert.match(f.host.textContent, /At most 32 exact fields/); assert.match(f.host.textContent, /same original file again/); assert.match(f.host.textContent, /fresh whole-file review/);
  assert.equal(f.action('nextConflicts').disabled, false); assert.equal(f.action('savePersonal').disabled, true);
});
test('P25 personal selection and personal confirmation are separate from import confirmation', async t => {
  const f = await P.native(t), importCheck = f.field('confirmation'), personalCheck = f.field('personal-confirmation');
  importCheck.checked = true; f.change(importCheck); assert.equal(f.action('confirm').disabled, false); assert.equal(f.action('savePersonal').disabled, true);
  f.click(f.action('savePersonal')); assert.equal(saves(f).length, 0);
  P.select(f, 0); assert.equal(importCheck.checked, false); assert.equal(f.action('confirm').disabled, true); assert.equal(personalCheck.checked, false); assert.equal(f.action('savePersonal').disabled, true);
  P.acknowledge(f); assert.equal(f.action('savePersonal').disabled, false); assert.equal(f.action('confirm').disabled, true);
  P.select(f, 1); assert.equal(personalCheck.checked, false); assert.equal(f.action('savePersonal').disabled, true);
  P.acknowledge(f); P.select(f, 0, false); assert.equal(personalCheck.checked, false); assert.equal(f.action('savePersonal').disabled, true);
  assert.match(f.host.textContent, /1 of up to 32 fields selected/); assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0);
});
test('P26 native partial selection saves just one field and success does not start import or advance progress', async t => {
  const f = await P.native(t); P.select(f, 1); P.acknowledge(f);
  f.wire.enqueue('/review/personal-changes', P.receipt([P.favorite()])); f.click(f.action('savePersonal')); await F.settle();
  assert.equal(saves(f).length, 1); assert.deepEqual(JSON.parse(saves(f)[0].init.body).choices, [[1, 'favorite']]); assert.equal(jobs(f).length, 0);
  assert.equal(f.action('confirm').disabled, true); assert.equal(f.field('confirmation').checked, false); assert.equal(f.field('personal-confirmation').checked, false); assert.equal(f.action('savePersonal').disabled, true);
  assert.match(f.host.textContent, /Saved 1 selected personal fields/); assert.match(f.host.textContent, /No import was started by this save/); assert.match(f.host.textContent, /fresh review/);
  assert.equal(f.host.querySelector('progress').hidden, true); assert.doesNotMatch(f.host.textContent, /Server-confirmed prefix:|server has confirmed the complete import/); assert.equal(f.time.tasks.size, 0);
  f.click(f.action('savePersonal')); f.click(f.action('confirm')); await F.settle(); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0);
});
test('P27 ordinary import excludes personal selections and never silently saves protected fields', async t => {
  const f = await P.native(t); P.select(f, 0); P.acknowledge(f);
  f.field('confirmation').checked = true; f.change(f.field('confirmation'));
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); f.click(f.action('confirm')); await F.settle();
  assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 1); assert.equal(jobs(f)[0].init.body, f.selected);
  assert.deepEqual(JSON.parse(jobs(f)[0].init.headers['X-AlbumHaven-Foobar-Command']), {version: F.JOB, ...P.proposal().command, inventory_sha256: 'c'.repeat(64), review_sha256: 'd'.repeat(64)});
});
test('P28 next and first conflict pages clear every selection and both confirmations', async t => {
  const f = await P.native(t, P.page()), initial = P.fields(f), table = conflictsTable(f);
  const rows = table.querySelectorAll('[data-cdt-column="row"]').map(node => /· row (\d+)$/.exec(node.textContent)?.[1]).filter(Boolean);
  P.select(f, 0); P.acknowledge(f); f.field('confirmation').checked = true; f.change(f.field('confirmation'));
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: P.page(true)}));
  f.click(f.action('nextConflicts')); f.click(f.action('nextConflicts')); await F.settle();
  assert.ok(initial.every(node => node.checked === false)); assert.equal(f.field('confirmation').checked, false); assert.equal(f.field('personal-confirmation').checked, false);
  assert.equal(f.action('savePersonal').disabled, true); assert.equal(f.action('confirm').disabled, true);
  const request = f.wire.calls.at(-1); assert.equal(request.route, '/review/start'); assert.equal(request.init.body, f.selected); assert.equal(JSON.parse(request.init.headers['X-AlbumHaven-Foobar-Command']).conflict_after, 64);
  await f.time.tick(); assert.equal(P.fields(f).length, 8); assert.ok(P.fields(f).every(node => node.checked === false)); assert.equal(f.action('savePersonal').disabled, true);
  assert.match(f.host.textContent, /40 personal-field conflicts in total\. 8 shown on this page\. 0 conflicts remain/); assert.equal(f.action('nextConflicts').disabled, true); assert.equal(f.action('firstConflicts').disabled, false);
  const remaining = conflictsTable(f).querySelectorAll('[data-cdt-column="row"]').map(node => /· row (\d+)$/.exec(node.textContent)?.[1]).filter(Boolean);
  assert.deepEqual([...rows, ...remaining], Array.from({length: 40}, (_, index) => String(index + 1)));
  P.select(f, 0); P.acknowledge(f); f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: P.page()}));
  f.click(f.action('firstConflicts')); await F.settle(); await f.time.tick(); assert.equal(P.fields(f).length, 32); assert.ok(P.fields(f).every(node => node.checked === false));
  assert.equal(f.field('personal-confirmation').checked, false); assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0);
});
test('P29 malformed-provenance fields stay visible disabled and cannot be forced into a personal request', async t => {
  const f = await P.native(t), disabled = f.field('personal-field-2');
  assert.equal(disabled.disabled, true); assert.equal(disabled.getAttribute('aria-disabled'), 'true'); assert.match(conflictsTable(f).textContent, /ownership history requires review/);
  disabled.checked = true; f.change(disabled); assert.equal(disabled.checked, false); P.acknowledge(f);
  assert.equal(f.field('personal-confirmation').checked, false); assert.equal(f.action('savePersonal').disabled, true); f.click(f.action('savePersonal')); assert.equal(saves(f).length, 0);
  P.select(f, 0); P.acknowledge(f); f.wire.enqueue('/review/personal-changes', P.receipt()); f.click(f.action('savePersonal')); await F.settle();
  assert.deepEqual(JSON.parse(saves(f)[0].init.body).choices, [[1, 'rating']]);
});
test('P30 native pending personal save burns cached controls before dispatch and blocks repeated clicks', async t => {
  const f = await P.native(t), late = F.deferred(); P.select(f, 0); P.acknowledge(f); const selected = P.fields(f)[0];
  f.wire.enqueue('/review/personal-changes', () => late.promise); f.click(f.action('savePersonal')); f.click(f.action('savePersonal')); await F.settle();
  assert.equal(selected.checked, false); assert.equal(f.field('personal-confirmation').checked, false); assert.equal(f.field('confirmation').checked, false);
  for (const action of ['savePersonal', 'confirm', 'preview', 'defaultSource', 'selectSource', 'recover', 'nextConflicts', 'firstConflicts']) assert.equal(f.action(action).disabled, true, action);
  assert.equal(f.field('file').disabled, true); assert.equal(f.field('matching').disabled, true); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0);
  assert.equal(f.host.querySelector('progress').hidden, true); late.resolve(F.response(P.receipt())); await F.settle();
  assert.equal(saves(f).length, 1); assert.equal(f.action('confirm').disabled, true); assert.equal(f.action('savePersonal').disabled, true); assert.equal(f.action('preview').disabled, false);
});
test('P31 native lost save response requires fresh review without automatic redispatch or counter claims', async t => {
  const f = await P.native(t); P.select(f, 0); P.acknowledge(f);
  f.wire.enqueue('/review/personal-changes', () => Promise.reject(new Error('connection lost after possible commit'))); f.click(f.action('savePersonal')); await F.settle();
  assert.match(f.host.querySelectorAll('[role="alert"]').find(node => !node.hidden && node.textContent).textContent, /may already have changed/); assert.match(f.host.textContent, /fresh review/);
  assert.equal(P.fields(f).length, 0); assert.equal(f.field('personal-confirmation').checked, false); assert.equal(f.field('confirmation').checked, false); assert.equal(f.action('savePersonal').disabled, true); assert.equal(f.action('confirm').disabled, true);
  f.click(f.action('savePersonal')); f.click(f.action('confirm')); await F.settle(); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0); assert.equal(f.time.tasks.size, 0);
  assert.doesNotMatch(f.host.textContent, /Saved 1 selected personal fields|Server-confirmed prefix:|server has confirmed the complete import/);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: P.proposal({conflicts: [P.favorite(), P.disabled()], conflict_count: 2, review_sha256: 'e'.repeat(64)})}));
  f.click(f.action('preview')); await F.settle(); await f.time.tick(); assert.ok(P.fields(f).every(node => node.checked === false)); assert.equal(f.field('personal-confirmation').checked, false);
  assert.equal(f.action('savePersonal').disabled, true); assert.equal(f.action('confirm').disabled, true); assert.equal(saves(f).length, 1);
});
for (const lifecycle of ['session', 'pagehide', 'policy', 'library', 'detached']) test(`P32 native ${lifecycle} retirement clears personal choices and discards late save response`, async t => {
  const f = await P.native(t), late = F.deferred(); P.select(f, 0); P.acknowledge(f);
  f.wire.enqueue('/review/personal-changes', () => late.promise); f.click(f.action('savePersonal')); await F.settle(); const request = saves(f)[0];
  if (lifecycle === 'session') f.document.dispatchEvent(new f.c.Event('album-haven:session-changed'));
  if (lifecycle === 'pagehide') f.c.dispatchEvent(new f.c.Event('pagehide'));
  if (lifecycle === 'policy') f.document.dispatchEvent(new f.c.Event('album-haven:policy-invalidated'));
  if (lifecycle === 'library') {f.root.dataset.accountFoobarMatchingLibraryId = '24'; f.mutation(f.root, 'data-account-foobar-matching-library-id');}
  if (lifecycle === 'detached') {f.host.remove(); f.idleCheck();}
  assert.equal(request.init.signal.aborted, true); late.resolve(F.response(P.receipt())); await F.settle(); f.c.dispatchEvent(new f.c.Event('pageshow'));
  assert.equal(f.host.querySelector('.foobar-import'), null); assert.equal(f.time.tasks.size, 0); assert.equal(saves(f).length, 1); assert.equal(jobs(f).length, 0); assert.doesNotMatch(f.host.textContent, /Saved 1 selected personal fields/);
});
test('P33 native resumed personal save keeps existing durable counters and progress exactly unchanged', async t => {
  const f = await N.native(t, F.wire(), {library: '23'}), command = F.command({original_matching_library_id: 23}), conflict = P.rating({row: 3});
  await N.recover(f, F.job({command})); f.choose(F.file()); await F.settle();
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')).enqueue('/review/status', F.review({review: P.proposal({command, resume: true, start_offset: 2, checked_rows: 2, proposed_counts: [1, 1, 0, 0, 1, 0, 0], review_counts: [2, 0, 0, 0, 1, 0], conflicts: [conflict], conflict_count: 1})}));
  f.click(f.action('resume')); await F.settle(); await f.time.tick(); const progress = f.host.querySelector('progress');
  assert.equal(Number(progress.value), 2); assert.equal(progress.max, 4); assert.match(f.host.textContent, /Server-confirmed prefix: 2 of 4 source rows\. 2 rows are not yet confirmed/);
  P.select(f, 0); P.acknowledge(f); f.wire.enqueue('/review/personal-changes', P.receipt([conflict])); f.click(f.action('savePersonal')); await F.settle();
  assert.equal(Number(progress.value), 2); assert.equal(progress.max, 4); assert.equal(progress.hidden, false); assert.match(f.host.textContent, /Server-confirmed prefix: 2 of 4 source rows\. 2 rows are not yet confirmed/);
  assert.match(f.host.textContent, /Confirmed updates: 2 source-evidence rows, 1 ratings, 0 favourites and 1 new local associations/);
  assert.equal(jobs(f).length, 1); assert.equal(jobs(f)[0].route, '/job/status'); assert.equal(f.action('confirm').disabled, true); assert.equal(f.time.tasks.size, 0);
});
test('P34 personal field controls have real labels and consequences with only text in shared table cells', async t => {
  const f = await P.native(t);
  assert.equal(P.fields(f).length, 3, 'Require the genuine conflict controls before checking every label');
  for (const checkbox of P.fields(f)) {
    const label = checkbox.parentElement; assert.equal(label.tagName, 'LABEL'); assert.equal(label.htmlFor, checkbox.id);
    assert.match(label.textContent, /Change (?:rating|favourite) for Source artist \/ (?:Source song|Another source song) \(Source album\) · row \d+/);
    const description = f.host.querySelector('#' + checkbox.getAttribute('aria-describedby')); assert.ok(description); assert.ok(description.textContent.length > 0);
  }
  assert.ok(f.field('personal-confirmation').getAttribute('aria-describedby').includes('personal-explanation'));
  assert.equal(f.action('savePersonal').classList.contains('ui-button'), true); assert.equal(f.action('savePersonal').type, 'button');
  for (const table of f.tables) for (const row of table.rows) assert.ok(Object.values(row.cells).every(value => value === ''), 'Only fixed skeleton reaches shared Table HTML API');
  const source = F.read('music_app/static/js/foobar-import/index.mjs');
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage|indexedDB)\s*\./);
  assert.match(source, /conflictReleases\.splice\(0\)/);
});
test('P37 hostile HTML and Unicode source labels are visible text rather than parsed markup', async t => {
  const labels = {source_artist: '<b>Artist & friends</b>', source_title: '<img src=x onerror=alert(1)> 🎵 曲', source_album: '<svg onload=alert(1)>Album</svg>'};
  const f = await P.native(t, P.proposal({conflicts: [P.rating(labels)], conflict_count: 1})), table = conflictsTable(f);
  for (const value of Object.values(labels)) assert.ok(table.textContent.includes(value));
  assert.equal(table.querySelector('img'), null); assert.equal(table.querySelector('svg'), null); assert.equal(table.querySelector('b'), null);
  P.select(f, 0); P.acknowledge(f); f.wire.enqueue('/review/personal-changes', P.receipt()); f.click(f.action('savePersonal')); await F.settle();
  const request = JSON.parse(saves(f)[0].init.body); assert.deepEqual(request.choices, [[1, 'rating']]);
  assert.equal(Object.hasOwn(request, 'source_artist'), false); assert.equal(Object.hasOwn(request, 'source_title'), false); assert.equal(Object.hasOwn(request, 'source_album'), false);
});
test('P38 missing source labels use explicit source fallbacks and retain the original row reference', async t => {
  const f = await P.native(t, P.proposal({conflicts: [P.rating({source_artist: '', source_title: '', source_album: ''})], conflict_count: 1}));
  assert.match(conflictsTable(f).textContent, /Unknown source artist \/ Untitled source track · row 1/);
  assert.doesNotMatch(conflictsTable(f).textContent, /undefined|null|\(\)/); assert.equal(f.field('personal-field-0').disabled, false);
});
test('P41 actual matching checkbox captures on before pending render and submits the selected library', async t => {
  const f = await N.native(t, F.wire(), {library: '23'}), matching = f.field('matching');
  assert.equal(matching.checked, false); matching.checked = true; f.change(matching); await F.settle();
  assert.equal(matching.checked, true, 'The pending render must not discard the user selection');
  await N.reviewed(f, {proposal: P.proposal()});
  const starts = f.wire.calls.filter(call => call.route === '/review/start'); assert.equal(starts.length, 1);
  assert.equal(JSON.parse(starts[0].init.headers['X-AlbumHaven-Foobar-Command']).matching_library_id, 23);
  assert.equal(matching.checked, true); assert.equal(P.fields(f).length, 3); assert.ok(conflictsTable(f));
  assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0);
});
test('P42 actual matching checkbox captures off before pending render and submits no library', async t => {
  const f = await N.native(t, F.wire(), {library: '23'}), matching = f.field('matching');
  matching.checked = true; f.change(matching); await F.settle(); assert.equal(matching.checked, true);
  matching.checked = false; f.change(matching); await F.settle(); assert.equal(matching.checked, false);
  await N.reviewed(f, {proposal: F.proposal()});
  const starts = f.wire.calls.filter(call => call.route === '/review/start'); assert.equal(starts.length, 1);
  assert.equal(JSON.parse(starts[0].init.headers['X-AlbumHaven-Foobar-Command']).matching_library_id, null);
  assert.equal(matching.checked, false); assert.equal(P.fields(f).length, 0); assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0);
});
test('P43 native fixture resolves distinct import and personal confirmations by exact component identity', async t => {
  const f = await P.native(t), importCheck = f.field('confirmation'), personalCheck = f.field('personal-confirmation');
  assert.notEqual(importCheck, personalCheck); assert.match(importCheck.id, /^foobar-import-\d+-confirmation$/); assert.match(personalCheck.id, /^foobar-import-\d+-personal-confirmation$/);
  P.select(f, 0); personalCheck.checked = true; f.change(personalCheck);
  assert.equal(personalCheck.checked, true); assert.equal(importCheck.checked, false); assert.equal(f.action('savePersonal').disabled, false); assert.equal(f.action('confirm').disabled, true);
  personalCheck.checked = false; f.change(personalCheck); importCheck.checked = true; f.change(importCheck);
  assert.equal(importCheck.checked, true); assert.equal(personalCheck.checked, false); assert.equal(f.action('confirm').disabled, false); assert.equal(f.action('savePersonal').disabled, true);
  assert.equal(saves(f).length, 0); assert.equal(jobs(f).length, 0);
});
