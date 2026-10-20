'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {F, REQUEST, fixture, input, field, fill, choose, file, fakeFile, commandJob, button, click, choice, choiceOptions, settle} = V;
test.before(V.load);

test('native intake defaults to URL and the actual shared Choice exposes exactly the four source kinds', async t => {
  const h = await fixture(t);
  assert.deepEqual(choiceOptions(choice(h.host, 'Source type')),
    [['url', 'URL'], ['pasted_html', 'Pasted HTML'], ['uploaded_html', 'Uploaded HTML'], ['text', 'Plain text']]);
  assert.equal(field(h.host, 'Album Top title').value, ''); assert.equal(field(h.host, 'Album Top description').value, '');
  assert.ok(field(h.host, 'Source URL')); assert.ok(button(h.host, 'Save source')); assert.ok(button(h.host, 'Close'));
  assert.equal(h.requests.length, 0); V.noSave(h); assert.equal(h.keyCalls(), 0);
});

for (const kind of ['url', 'pasted_html', 'uploaded_html', 'text']) test(`explicit ${kind} intake sends exactly one source command through the real controller/provider`, async t => {
  const h = await fixture(t), content = kind === 'url' ? 'https://example.test/private-source?q=kept'
    : '<script>inertEvidence()</script>\n2. Second source\n1. First source';
  fill(h, kind, content);
  if (kind === 'uploaded_html') {const selected = fakeFile({name: 'album-source.html', content}); file(h.host, selected.value); await settle();
    assert.equal(selected.reads(), 1);}
  assert.equal(h.count('submit'), 0); assert.equal(h.keyCalls(), 0); V.noSave(h);
  const save = button(h.host, 'Save source'); click(save); await settle(); click(save); await settle();
  assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1);
  assert.deepEqual(h.last('submit').body, {request_key: REQUEST, title: 'A new source Top', description: 'Private source notes',
    kind, filename: kind === 'uploaded_html' ? 'album-source.html' : null, content});
  assert.doesNotMatch(JSON.stringify(h.last('submit').body), /PRIVATE\/LOCAL\/PATH|webkitRelativePath|catalog_ref|selection/);
  assert.equal(button(h.host, 'Close').disabled, false); assert.equal(save.disabled, true);
  assert.match(h.host.textContent, /submit/i);
  h.last('submit').resolve(commandJob(h.last('submit').body, {status: 'queued', phase: 'source_processing', review: null}));
  await settle(); assert.equal(h.actual.getSnapshot().job.status, 'queued'); V.noSave(h);
  assert.equal(h.count('submit'), 1); assert.equal(h.count('process'), 0);
});

for (const [label, fieldLabel, invalid] of [
  ['overlong Unicode title', 'Album Top title', '🪄'.repeat(101)],
  ['overlong description', 'Album Top description', 'x'.repeat(1001)],
  ['title lone surrogate', 'Album Top title', '\ud800'],
  ['content lone surrogate', 'Source content', '\udfff'],
  ['NUL content', 'Source content', 'a\0b'],
  ['serialized UTF8 limit', 'Source content', '🪄'.repeat(128 * 1024)],
]) test(`visible ${label} rejection remains editable and a corrected source reuses its allocated key`, async t => {
  const h = await fixture(t); fill(h); input(h.host, fieldLabel, invalid); click(button(h.host, 'Save source')); await settle();
  assert.equal(h.count('submit'), 0); assert.equal(h.actual.getSnapshot().status, 'error');
  assert.equal(h.actual.getSnapshot().error.responseRejected, true); assert.equal(field(h.host, fieldLabel).disabled, false);
  assert.ok(h.host.querySelector('[role="alert"]'), 'local rejection is visible');
  input(h.host, fieldLabel, fieldLabel === 'Album Top title' ? 'Corrected title' : fieldLabel === 'Album Top description' ? 'Corrected notes' : 'Corrected source');
  click(button(h.host, 'Save source')); await settle(); assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1);
  h.last('submit').resolve(commandJob(h.last('submit').body)); await settle(); assert.equal(h.actual.getSnapshot().status, 'ready'); V.noSave(h);
});

test('uncertain visible intake retries only its exact original command and keeps Close available', async t => {
  const h = await fixture(t); fill(h, 'pasted_html', '<b>Original source</b>'); const oldInput = field(h.host, 'Source content');
  click(button(h.host, 'Save source')); await settle(); const original = h.last('submit');
  original.reject(new TypeError('PRIVATE_BACKEND_PATH_AND_ERROR')); await settle();
  assert.equal(h.actual.getSnapshot().status, 'uncertain'); assert.equal(button(h.host, 'Close').disabled, false);
  assert.match(h.host.textContent, /unknown|uncertain/i); assert.doesNotMatch(h.host.textContent, /PRIVATE_BACKEND_PATH_AND_ERROR/);
  oldInput.value = 'Replacement'; oldInput.dispatchEvent(new h.context.Event('input'));
  click(button(h.host, 'Retry')); await settle(); const next = h.last('submit');
  assert.equal(h.count('submit'), 2); assert.deepEqual(next.body, original.body); assert.equal(h.keyCalls(), 1);
  next.resolve(commandJob(next.body)); await settle(); assert.equal(h.actual.getSnapshot().status, 'ready'); V.noSave(h);
});

test('surface disposal leaves a pending task alive and late submit acknowledgement cannot restore its UI', async t => {
  const h = await fixture(t); fill(h); click(button(h.host, 'Save source')); await settle(); const request = h.last('submit');
  const close = button(h.host, 'Close'); click(close); assert.equal(h.calls.close, 1);
  h.view.dispose(); assert.equal(h.host.children.length, 0); assert.equal(request.options.signal.aborted, false);
  assert.equal(h.actual.getSnapshot().status, 'loading'); assert.equal(h.calls.importDispose, 0);
  request.resolve(commandJob(request.body)); await settle();
  assert.equal(h.actual.getSnapshot().job.job_ref, V.JOB); assert.equal(h.host.children.length, 0);
  click(close); assert.equal(h.calls.close, 1); V.noSave(h);
});

test('repeated update is passive and never substitutes captured controllers or providers', async t => {
  const h = await fixture(t); fill(h); const calls = h.requests.length, keyCalls = h.keyCalls();
  for (let n = 0; n < 4; n++) h.view.update(); await settle();
  assert.equal(h.requests.length, calls); assert.equal(h.keyCalls(), keyCalls);
  assert.equal(field(h.host, 'Album Top title').value, 'A new source Top'); V.noSave(h);
});
