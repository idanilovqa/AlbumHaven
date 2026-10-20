'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');
const {fixture, open, close, fill, button, click, settle, F, job, review, saved, submit, acknowledge} = I;
test.before(I.load);

for (const kind of ['url', 'text', 'pasted_html', 'uploaded_html']) test(`actual index ${kind} intake uses one composed private provider submit and no duplicate process`, async t => {
  const h = await fixture(t), root = await open(h), content = kind === 'url' ? 'https://example.test/source?private=SOURCE' : '<p>SECRET_SOURCE_BODY</p>';
  fill(root, {kind, content});
  if (kind === 'uploaded_html') {const file = I.fakeFile({name: 'review.html', content}); I.file(root, file.value); await settle(); assert.equal(file.reads(), 1);}
  const save = button(root, 'Save source'); click(save); await settle(); click(save); await settle();
  assert.equal(h.count('submit'), 1); const request = h.last('submit');
  assert.deepEqual(request.body, {request_key: request.body.request_key, title: 'A new source Top', description: 'Private source notes', kind,
    filename: kind === 'uploaded_html' ? 'review.html' : null, content});
  assert.match(request.body.request_key, /^[0-9a-f-]{36}$/); assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.headers['X-AlbumHaven-Context'], I.N.A);
  assert.equal(request.options.headers['Content-Type'], 'application/json'); assert.ok(request.options.signal);
  await acknowledge(h, request); assert.ok(h.formHost().querySelector('[aria-label="Source review"]'));
  assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0); assert.equal(h.navigations.length, 0);
  I.privateFree(h, [content, 'Private source notes', '/PRIVATE/LOCAL/PATH/source.html']);
});

test('local invalid source remains editable inside the actual native dialog and correction retains its allocated key', async t => {
  const h = await fixture(t), root = await open(h); fill(root, {title: ' ', content: 'Correctable source'});
  const keys = [...h.keys]; click(button(root, 'Save source')); await settle();
  assert.equal(h.count('submit'), 0); assert.ok(root.querySelector('[role="alert"]'));
  assert.equal(I.field(root, 'Album Top title').disabled, false); assert.equal(button(root, 'Retry'), undefined);
  I.input(root, 'Album Top title', 'Corrected title'); click(button(root, 'Save source')); await settle();
  assert.equal(h.count('submit'), 1); assert.deepEqual(h.keys, keys); assert.ok(keys.includes(h.last('submit').body.request_key));
  await acknowledge(h, h.last('submit')); assert.equal(h.count('process'), 0);
});

test('definitive rejected submit closes and the next real Import submits corrected input under a fresh key', async t => {
  const h = await fixture(t), first = await submit(h, {content: 'First admitted source'});
  first.reply({error_code: 'source_rejected', error: 'PRIVATE_SERVER_FAILURE'}, 422); await settle();
  const rejected = h.formHost(); assert.match(rejected.textContent, /Retry the same source, or close this view and start a new import/);
  assert.doesNotMatch(rejected.textContent, /PRIVATE_SERVER_FAILURE/); assert.equal(I.field(rejected, 'Source content').disabled, true);
  assert.equal(button(rejected, 'Save source').disabled, true); assert.ok(button(rejected, 'Retry')); assert.equal(await close(h), null);
  const second = await submit(h, {content: 'Corrected new source'}); assert.notEqual(second.body.request_key, first.body.request_key);
  assert.equal(first.body.content, 'First admitted source'); assert.equal(second.body.content, 'Corrected new source');
  await acknowledge(h, second); assert.equal(h.count('submit'), 2); assert.equal(h.count('finalize'), 0);
});

test('closing 33 definitive rejections releases capacity instead of exhausting the 32 retained-owner bound', async t => {
  const h = await fixture(t), keys = [];
  for (let n = 0; n < 33; n++) {
    assert.equal(button(h.host, 'Import Album Top').disabled, false);
    const request = await submit(h, {content: `Attempt ${n}`}); keys.push(request.body.request_key);
    request.reply({error_code: 'invalid_source'}, 422); await settle(); assert.equal(await close(h), null);
  }
  assert.equal(new Set(keys).size, 33); assert.equal(h.count('submit'), 33);
  assert.equal(button(h.host, 'Import Album Top').disabled, false); assert.equal(h.cards().length, 0);
});

test('unknown submission closes without abort, then real notification Open resumes and retries the exact admitted command', async t => {
  const h = await fixture(t), first = await submit(h, {content: 'Immutable unknown source'});
  first.reject(new TypeError('wire lost')); await settle(); assert.equal(await close(h), null);
  assert.equal(first.options.signal.aborted, false); assert.equal(h.cards().length, 1);
  const id = 'pending:' + first.body.request_key; assert.equal(h.cards()[0].id, id);
  const keys = h.keys.length; h.activate(id); await settle(); assert.equal(h.count('navigate'), 1); await h.settleNavigation();
  assert.equal(h.count('read'), 0); assert.equal(h.keys.length, keys, 'retained resume allocates no submission key');
  const root = h.formHost(); assert.equal(I.field(root, 'Source content').disabled, true); assert.equal(h.cards()[0].read, true);
  click(button(root, 'Retry')); await settle(); assert.equal(h.count('submit'), 2);
  assert.deepEqual(h.last('submit').body, first.body); assert.equal(h.last('submit').url, first.url);
  await acknowledge(h, h.last('submit')); assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0);
});

test('all review rows survive real matching, ambiguous keyboard order and explicit server duplicate receipt', async t => {
  const h = await fixture(t), request = await submit(h), evidence = review(); evidence.ordered_row_refs = null;
  await acknowledge(h, request, {review: evidence}); const root = h.formHost();
  assert.deepEqual([...root.querySelectorAll('[data-source-row-ref]')].map(row => row.dataset.sourceRowRef), ['1','2','3']);
  await I.match(h, '1'); await I.match(h, '3'); assert.equal(h.count('search'), 2); assert.equal(h.count('admit'), 2);
  assert.equal(button(root, 'Save Album Top').disabled, true);
  const handle = root.querySelector('[data-source-row-ref="1"] [data-source-row-drag]'); assert.equal(handle.getAttribute('aria-label'), 'Move source row 1');
  handle.focus(); h.dispatch(handle, 'keydown', {key: 'End'}); await settle(); click(button(root, 'Confirm order')); await settle();
  click(button(root, 'Save Album Top')); await settle(); const save = h.last('finalize');
  assert.deepEqual(save.body.source_review, {job_ref: I.JOB, revision: '4', rows: [
    {row_ref: '2', selection: null}, {row_ref: '3', selection: {kind: 'local_catalog', album_ref: F.C}},
    {row_ref: '1', selection: {kind: 'local_catalog', album_ref: F.C}}]});
  assert.equal(save.body.request_key, I.JOB); save.reply(I.receipt(save.body)); await settle();
  assert.match(root.textContent, /unresolved/i); assert.match(root.textContent, /duplicate/i); assert.ok(button(root, 'Open Album Top'));
  assert.equal(h.count('finalize'), 1); assert.equal(h.navigations.length, 0); I.privateFree(h);
});

test('explicit receipt Open closes the actual native form and finishes the same navigation handoff successfully', async t => {
  const h = await fixture(t), save = await saved(h); assert.equal(h.navigations.length, 0);
  const originalForm = h.owner('activeAppFormDialog'); click(button(h.formHost(), 'Open Album Top')); await settle();
  assert.notEqual(h.owner('activeAppFormDialog'), originalForm); assert.equal(h.count('navigate'), 1);
  assert.equal(h.navigations[0].options.top_ref, I.SAVED_TOP); await h.settleNavigation(I.SAVED_TOP);
  assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.runtime.snapshot().topRef, I.SAVED_TOP);
  assert.equal(h.count('finalize'), 1); assert.equal(h.last('finalize'), save); I.privateFree(h);
});

test('current destination failure after native self-close reopens the same receipt for an explicit navigation retry', async t => {
  const h = await fixture(t); await saved(h); click(button(h.formHost(), 'Open Album Top')); await settle();
  const first = h.last('navigate'); first.reply({error: 'PRIVATE_NAVIGATION_FAILURE'}, 503); await settle();
  const root = h.formHost(); assert.ok(button(root, 'Open Album Top')); assert.doesNotMatch(root.textContent, /PRIVATE_NAVIGATION_FAILURE/);
  assert.equal(h.count('finalize'), 1); assert.equal(h.count('submit'), 1);
  click(button(root, 'Open Album Top')); await settle(); assert.equal(h.count('navigate'), 2); await h.settleNavigation(I.SAVED_TOP);
  assert.equal(h.runtime.snapshot().topRef, I.SAVED_TOP); assert.equal(h.count('finalize'), 1);
});

test('a superseding real native navigation cannot resurrect a self-closed receipt dialog', async t => {
  const h = await fixture(t); await saved(h); click(button(h.formHost(), 'Open Album Top')); await settle(); const old = h.last('navigate');
  const replacement = h.runtime.navigate({top_ref: F.OTHER}); await settle(); const current = h.last('navigate'); assert.notEqual(current, old);
  current.reply(I.route(F.OTHER)); assert.equal(await replacement, true); await settle();
  old.reply(I.route(I.SAVED_TOP)); await settle(); assert.equal(h.runtime.snapshot().topRef, F.OTHER);
  assert.equal(h.owner('activeAppFormDialog'), null); assert.equal(h.count('finalize'), 1);
});

test('source title, markup, URL and review evidence stay inert and outside all actual route/history/card projections', async t => {
  const attack = '<img id=source-injected src=x onerror=sourceInjected()>', h = await fixture(t);
  const request = await submit(h, {title: 'Untrusted <b>title</b>', description: 'SECRET_SOURCE_BODY', kind: 'pasted_html', content: attack});
  const evidence = review(); evidence.rows[0].raw_text = attack; evidence.issues = ['SECRET_SOURCE_BODY'];
  await acknowledge(h, request, {review: evidence}); assert.ok(h.formHost().textContent.includes(attack));
  assert.equal(h.document.querySelector('#source-injected'), null); assert.equal(h.context.sourceInjected, undefined);
  I.privateFree(h, ['SECRET_SOURCE_BODY', 'onerror=sourceInjected()']);
});

test('failed durable processing retries only on the actual explicit action, never from submit acknowledgment', async t => {
  const h = await fixture(t), request = await submit(h); await acknowledge(h, request,
    {status: 'failed', phase: 'source_processing', review: null, error: 'source_processing_failed'});
  assert.equal(h.count('process'), 0); const retry = button(h.formHost(), 'Retry processing'); click(retry); await settle(); click(retry); await settle();
  assert.equal(h.count('process'), 1); assert.equal(new URL(h.last('process').url, h.location).pathname, `/album-tops/source-imports/${I.JOB}/process`);
  h.last('process').reply(I.commandJob(request.body)); await settle(); assert.ok(h.formHost().querySelector('[aria-label="Source review"]'));
  assert.equal(h.count('submit'), 1); assert.equal(h.count('finalize'), 0); assert.equal(h.navigations.length, 0);
});

test('uncertain finalization closes and resumes through the native card with exact original review and key', async t => {
  const h = await fixture(t), request = await submit(h); await acknowledge(h, request); await I.match(h);
  click(button(h.formHost(), 'Save Album Top')); await settle(); const save = h.last('finalize'); save.reject(new TypeError('lost save'));
  await settle(); assert.equal(await close(h), null); assert.match(h.cards()[0].markup, /Save result unknown/);
  h.activate(I.JOB); await settle(); await h.settleNavigation(); assert.equal(h.count('read'), 0);
  click(button(h.formHost(), 'Retry')); await settle(); assert.equal(h.count('finalize'), 2); assert.deepEqual(h.last('finalize').body, save.body);
  h.last('finalize').reply(I.receipt(save.body)); await settle(); assert.ok(button(h.formHost(), 'Open Album Top'));
  assert.equal(h.count('navigate'), 1, 'only the explicit card directory navigation occurred');
});
