'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs');
const N = require('./foobar-account-import-native-fixture.cjs');

test('I31 native sibling Settings host mounts real account control and shared primitives', async t => {
  const f = await N.native(t, F.wire(), {sibling: true}); assert.equal(f.root.contains(f.host), false);
  assert.match(f.host.textContent, /Import a Foobar2000 export/); assert.equal(f.field('selected-source').value, F.SOURCE);
  assert.equal(f.field('selected-source').readOnly, true); assert.equal(f.action('preview').disabled, true);
  assert.equal(f.field('matching').disabled, true); assert.match(f.host.textContent, /still import source evidence without library matching/);
  assert.equal(f.action('defaultSource').classList.contains('ui-button'), true); assert.equal(f.action('preview').type, 'button');
});
test('I32 native dry-run renders six overlapping categories and requires fresh checkbox plus confirm', async t => {
  const f = await N.native(t), selected = await N.reviewed(f);
  const table = f.host.querySelector('[role="table"]'); assert.ok(table); assert.equal(table.getAttribute('data-cdt-mobile'), 'stack');
  for (const label of ['Accepted source rows', 'Unmatched local rows', 'Ambiguous local rows', 'Rows with invalid or unsupported fields', 'Protected rows', 'Unchanged rows']) assert.match(table.textContent, new RegExp(label));
  assert.match(f.host.textContent, /categories overlap/); assert.match(f.host.textContent, /not a reservation/); assert.match(f.host.textContent, /No import has been applied/);
  f.click(f.action('confirm')); assert.equal(f.wire.calls.filter(call => (call.route.startsWith('/job/') && call.route !== '/job/list')).length, 0);
  const check = f.field('confirmation'); check.checked = true; f.change(check); assert.equal(f.action('confirm').disabled, false);
  f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); f.click(f.action('confirm')); f.click(f.action('confirm')); await F.settle();
  assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 1); assert.equal(f.wire.calls.at(-1).init.body, selected);
  assert.equal(check.checked, false); assert.match(f.host.textContent, /No confirmed row count is available/); assert.equal(f.host.querySelector('progress').hidden, true);
});
test('I33 native untrusted file names remain text and shared Table receives empty data cells only', async t => {
  const f = await N.native(t); await N.reviewed(f, {selected: F.file('<img src=x onerror=alert(1)>.tsv')});
  assert.match(f.host.textContent, /<img src=x onerror=alert\(1\)>\.tsv/); assert.equal(f.host.querySelector('img'), null);
  assert.ok(f.tables.length >= 2); for (const table of f.tables) for (const row of table.rows) assert.ok(Object.values(row.cells).every(value => value === ''), 'Only fixed skeleton enters shared Table HTML API');
  assert.equal(f.host.querySelectorAll('[data-cdt-column="problem"]').at(-1).textContent, 'The existing rating is protected and will not be replaced.');
});
test('I34 native file/scope changes clear confirmation and require a new dry run', async t => {
  const f = await N.native(t, F.wire(), {library: '23'}); await N.reviewed(f); const check = f.field('confirmation'); check.checked = true; f.change(check);
  f.field('matching').checked = true; f.change(f.field('matching')); await F.settle(); assert.equal(check.checked, false); assert.equal(f.action('confirm').disabled, true);
  f.choose(F.file('another.tsv')); await F.settle(); assert.equal(f.field('file').value, ''); assert.equal(f.action('confirm').disabled, true); assert.equal(f.wire.calls.length, 4);
});
test('I35 native rejected file shows actionable error with no request or prior review reuse', async t => {
  const f = await N.native(t); await N.reviewed(f); f.choose(F.file('unsupported.xml')); await F.settle();
  assert.equal(f.action('preview').disabled, true); assert.equal(f.action('confirm').disabled, true); assert.match(f.host.querySelectorAll('[role="alert"]').find(node => !node.hidden && node.textContent).textContent, /nonempty UTF-8 TSV/);
  assert.equal(f.wire.calls.length, 4); assert.equal(f.field('file').value, '');
});
test('I36 native repeated review clicks are disabled and cancel-review never presents stale ready result', async t => {
  const f = await N.native(t); f.choose(F.file()); await F.settle();
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')); f.click(f.action('preview')); f.click(f.action('preview')); await F.settle();
  assert.equal(f.wire.calls.length, 3); assert.equal(f.action('cancelReview').hidden, false);
  f.wire.enqueue('/review/cancel', F.review({phase: 'reviewing', review: null}, 'cancel')); f.click(f.action('cancelReview')); await F.settle();
  f.wire.enqueue('/review/status', F.review()); await f.time.tick();
  assert.equal(f.action('confirm').disabled, true); assert.match(f.host.textContent, /Review cancelled/); assert.equal(f.wire.calls.filter(call => (call.route.startsWith('/job/') && call.route !== '/job/list')).length, 0);
});
test('I37 native unknown checkpoint is not zero and uncertain prefix is not completion', async t => {
  const f = await N.native(t); await N.recover(f, F.job({phase: 'needs_reconciliation', uncertain: true, confirmed_rows: null, remaining_rows: null, confirmed_counts: null, disposition: null, cancel_requested: null}));
  assert.match(f.host.textContent, /No confirmed row count is available/); assert.match(f.host.textContent, /uncertain outcome/);
  assert.equal(f.host.querySelector('progress').hidden, true); assert.doesNotMatch(f.host.textContent, /0 of 4|confirmed the complete import/);
  assert.equal(f.action('clear').disabled, true); assert.equal(f.action('resume').disabled, true);
});
test('I38 native uncertain job needs original file reselection and same-job dry run, not new import', async t => {
  const f = await N.native(t); await N.recover(f, F.job({uncertain: true}));
  assert.equal(f.action('resume').disabled, true); f.choose(F.file()); await F.settle(); assert.equal(f.action('resume').disabled, false);
  f.wire.enqueue('/review/start', F.accepted(F.REVIEW, 'start')); f.click(f.action('resume')); await F.settle();
  const upload = f.wire.calls.at(-1); assert.equal(upload.route, '/review/start');
  assert.deepEqual(JSON.parse(upload.init.headers['X-AlbumHaven-Foobar-Command']), {version: F.REVIEW, source_ref: F.SOURCE, job_ref: F.JOBREF, mapping_name: F.MAPPING, matching_library_id: null, resume: true, conflict_after: 0, problem_after: 0, previous_review_sha256: null});
  assert.equal(f.action('defaultSource').disabled, true); assert.equal(f.action('recover').disabled, true);
});
test('I39 native pending stop and unavailable original library block resume but retain status', async t => {
  const f = await N.native(t, F.wire(), {library: '24'}); await N.recover(f, F.job({command: F.command({original_matching_library_id: 23}), cancel_pending: true}));
  f.choose(F.file()); await F.settle(); assert.equal(f.action('resume').disabled, true); assert.equal(f.action('status').disabled, false); assert.equal(f.action('cancel').disabled, true);
  assert.match(f.host.textContent, /original library/); assert.equal(f.field('source-reference').value, F.SOURCE); assert.equal(f.field('job-reference').value, F.JOBREF);
});
test('I40 native last-confirmed completed snapshot cannot unlock a replacement import', async t => {
  const f = await N.native(t); await N.recover(f, F.job({phase: 'completed', snapshot_kind: 'last_confirmed', disposition: 'completed', confirmed_rows: 4, remaining_rows: 0, confirmed_counts: [0, 3, 0, 1, 1, 0, 2]}));
  assert.equal(f.action('clear').disabled, true); assert.doesNotMatch(f.host.textContent, /server has confirmed the complete import/);
  f.wire.enqueue('/job/status', F.job({phase: 'completed', disposition: 'completed', confirmed_rows: 4, remaining_rows: 0, confirmed_counts: [0, 3, 0, 1, 1, 0, 2]})); await f.time.tick();
  assert.equal(f.action('clear').disabled, false); assert.match(f.action('clear').textContent, /Start another import/); assert.match(f.host.textContent, /server has confirmed the complete import/);
  f.click(f.action('clear')); await F.settle(); assert.equal(f.field('job-reference').value, ''); assert.equal(f.action('defaultSource').disabled, false);
});
test('I41 native review/job headings receive requested focus without stealing outside focus', async t => {
  const f = await N.native(t); await N.reviewed(f); assert.ok(f.document.activeElement.id.endsWith('-review-title'));
  const outside = f.document.createElement('button'); f.document.body.append(outside); outside.focus();
  const check = f.field('confirmation'); check.checked = true; f.change(check); f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); f.click(f.action('confirm')); await F.settle();
  assert.equal(f.document.activeElement, outside);
});
test('I42 native UUID Enter is keyboard-operable and invalid input receives focus without request', async t => {
  const f = await N.native(t); const input = f.field('source-choice'); input.value = 'bad'; const event = f.key(input, 'Enter'); await F.settle();
  assert.equal(event.defaultPrevented, true); assert.equal(f.document.activeElement, input); assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(f.wire.calls.length, 2);
  input.value = F.SOURCE; f.wire.enqueue('/ui/source', F.source()); f.key(input, 'Enter'); await F.settle(); assert.equal(f.wire.calls.length, 3); assert.equal(input.getAttribute('aria-invalid'), null);
  assert.equal(f.key(input, 'ArrowDown').defaultPrevented, false);
});
for (const lifecycle of ['close', 'pagehide', 'policy', 'matching', 'detached', 'not-current']) test(`I43 native ${lifecycle} retires controls and cannot revive on late response or Back restoration`, async t => {
  const f = await N.native(t), late = F.deferred(); f.choose(F.file()); await F.settle(); f.wire.enqueue('/review/start', () => late.promise);
  f.click(f.action('preview')); await F.settle(); const request = f.wire.calls.at(-1);
  if (lifecycle === 'close') f.owner.dispose();
  if (lifecycle === 'pagehide') f.c.dispatchEvent(new f.c.Event('pagehide'));
  if (lifecycle === 'policy') f.document.dispatchEvent(new f.c.Event('album-haven:policy-invalidated'));
  if (lifecycle === 'matching') {f.root.dataset.accountFoobarMatchingLibraryId = '23'; f.mutation(f.root, 'data-account-foobar-matching-library-id');}
  if (lifecycle === 'detached') {f.host.remove(); f.idleCheck();}
  if (lifecycle === 'not-current') {f.current(false); f.idleCheck();}
  assert.equal(request.init.signal.aborted, true); late.resolve(F.response(F.accepted(F.REVIEW, 'start'))); await F.settle();
  f.c.dispatchEvent(new f.c.Event('pageshow')); assert.equal(f.host.querySelector('.foobar-import'), null); assert.equal(f.time.tasks.size, 0); assert.equal(f.wire.calls.length, 3);
});
test('I44 narrow-view source contract keeps local overflow, stackable table, wrapping controls and visible focus', () => {
  const css = F.read('music_app/static/css/foobar-import.css'), source = F.read('music_app/static/js/foobar-import/index.mjs');
  assert.match(css, /@media\s*\(max-width:\s*600px\)/); assert.match(css, /overflow-x:\s*auto/); assert.match(css, /flex-wrap:\s*wrap/);
  assert.match(css, /overflow-wrap:\s*anywhere/); assert.match(css, /:focus-visible/); assert.match(css, /min-width:\s*0/);
  assert.match(source, /mobile:\s*'stack'/); assert.match(source, /wrapper\.tabIndex\s*=\s*0/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage|indexedDB)\s*\./);
  // Source coverage only: these assertions do not claim rendered browser layout,
  // keyboard Tab order, screen-reader speech, hit targets or visual QA passed.
});
