'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {F, fixture, fill, input, choose, file, fakeFile, button, click, settle} = V;
test.before(V.load);

for (const [label, size] of [['negative', -1], ['NaN', NaN], ['infinity', Infinity], ['oversized', 512 * 1024 + 1],
  ['string', '12'], ['missing', undefined]]) test(`uploaded HTML rejects ${label} file size before reading it`, async t => {
  const h = await fixture(t); fill(h, 'uploaded_html'); const selected = fakeFile(); selected.value.size = size;
  file(h.host, selected.value); await settle(); assert.equal(selected.reads(), 0);
  assert.ok(h.host.querySelector('[role="alert"]')); click(button(h.host, 'Save source')); await settle();
  assert.equal(h.count('submit'), 0); V.noSave(h);
});

test('an empty uploaded file is visibly rejected and may be replaced without submitting', async t => {
  const h = await fixture(t); fill(h, 'uploaded_html'); file(h.host, fakeFile({content: '', size: 0}).value); await settle();
  assert.ok(h.host.querySelector('[role="alert"]')); click(button(h.host, 'Save source')); await settle(); assert.equal(h.count('submit'), 0);
  const next = fakeFile({name: 'nonempty.html', content: 'Nonempty source'}); file(h.host, next.value); await settle();
  assert.equal(h.count('submit'), 0); click(button(h.host, 'Save source')); await settle();
  assert.equal(h.count('submit'), 1); assert.equal(h.last('submit').body.content, 'Nonempty source');
  assert.equal(h.last('submit').body.filename, 'nonempty.html'); h.last('submit').resolve(V.commandJob(h.last('submit').body)); await settle();
});

test('the inclusive 512 KiB read bound does not bypass the real serialized command bound', async t => {
  const h = await fixture(t); fill(h, 'uploaded_html'); const selected = fakeFile({size: 512 * 1024, content: 'x'.repeat(512 * 1024)});
  file(h.host, selected.value); await settle(); assert.equal(selected.reads(), 1); assert.equal(h.count('submit'), 0);
  click(button(h.host, 'Save source')); await settle(); assert.equal(h.count('submit'), 0);
  assert.equal(h.actual.getSnapshot().error.responseRejected, true); assert.ok(h.host.querySelector('[role="alert"]'));
  const corrected = fakeFile({content: 'Small corrected source'}); file(h.host, corrected.value); await settle();
  click(button(h.host, 'Save source')); await settle(); assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1);
  h.last('submit').resolve(V.commandJob(h.last('submit').body)); await settle();
});

test('a file read failure exposes a generic error and not the thrown message or local path', async t => {
  const h = await fixture(t); fill(h, 'uploaded_html'); file(h.host, fakeFile({error: new Error('SECRET /home/private/source.html')}).value);
  await settle(); assert.ok(h.host.querySelector('[role="alert"]')); assert.doesNotMatch(h.host.textContent, /SECRET|\/home\/private|PRIVATE\/LOCAL\/PATH/);
  click(button(h.host, 'Save source')); await settle(); assert.equal(h.count('submit'), 0); V.noSave(h);
});

for (const oldOutcome of ['resolve', 'reject']) test(`a replaced file's late ${oldOutcome} cannot overwrite the current file or error`, async t => {
  const h = await fixture(t), gate = F.deferred(); fill(h, 'uploaded_html');
  file(h.host, fakeFile({name: 'old.html', promise: gate.promise}).value);
  const current = fakeFile({name: 'current.html', content: 'Current complete source'}); file(h.host, current.value); await settle();
  if (oldOutcome === 'resolve') gate.resolve('Obsolete PRIVATE source'); else gate.reject(new Error('Obsolete PRIVATE failure'));
  await settle(); assert.equal(h.count('submit'), 0); assert.doesNotMatch(h.host.textContent, /Obsolete PRIVATE/);
  click(button(h.host, 'Save source')); await settle();
  assert.deepEqual({filename: h.last('submit').body.filename, content: h.last('submit').body.content},
    {filename: 'current.html', content: 'Current complete source'});
  h.last('submit').resolve(V.commandJob(h.last('submit').body)); await settle();
});

test('clearing a file selection invalidates its pending read and cannot submit the old contents', async t => {
  const h = await fixture(t), gate = F.deferred(); fill(h, 'uploaded_html');
  file(h.host, fakeFile({promise: gate.promise}).value); file(h.host, null); gate.resolve('Old cleared source'); await settle();
  click(button(h.host, 'Save source')); await settle(); assert.equal(h.count('submit'), 0); V.noSave(h);
});

for (const kind of ['url', 'pasted_html', 'text']) test(`switching from a pending file to ${kind} rejects its eventual publication`, async t => {
  const h = await fixture(t), gate = F.deferred(); fill(h, 'uploaded_html'); file(h.host, fakeFile({promise: gate.promise}).value);
  choose(h.host, kind); const content = kind === 'url' ? 'https://example.test/current' : 'Current typed source';
  input(h.host, kind === 'url' ? 'Source URL' : 'Source content', content); gate.resolve('STALE_FILE_CONTENT'); await settle();
  click(button(h.host, 'Save source')); await settle(); assert.equal(h.last('submit').body.kind, kind);
  assert.equal(h.last('submit').body.content, content); assert.equal(h.last('submit').body.filename, null);
  h.last('submit').resolve(V.commandJob(h.last('submit').body)); await settle();
});

for (const retirement of ['dispose', 'depart', 'scope']) test(`a pending file read cannot restore private evidence after ${retirement}`, async t => {
  const h = await fixture(t), gate = F.deferred(); fill(h, 'uploaded_html'); file(h.host, fakeFile({promise: gate.promise}).value);
  const retainedSave = button(h.host, 'Save source');
  if (retirement === 'dispose') h.view.dispose(); else h[retirement]();
  gate.resolve('RETIRED_PRIVATE_SOURCE'); await settle(); click(retainedSave); await settle();
  assert.equal(h.host.children.length, 0); assert.equal(h.count('submit'), 0); assert.equal(h.calls.importDispose, 0); V.noSave(h);
});

test('submission through the retained controller invalidates an older pending file read', async t => {
  const h = await fixture(t), gate = F.deferred(); fill(h, 'uploaded_html'); file(h.host, fakeFile({promise: gate.promise}).value);
  const pending = h.actual.submit({title: 'Admitted task', description: '', kind: 'text', filename: null, content: 'Actual submitted source'});
  await settle(); gate.resolve('OBSOLETE_FILE_AFTER_SUBMIT'); await settle();
  assert.equal(h.count('submit'), 1); assert.doesNotMatch(h.host.textContent, /OBSOLETE_FILE_AFTER_SUBMIT/);
  assert.equal(button(h.host, 'Close').disabled, false);
  h.last('submit').resolve(V.commandJob(h.last('submit').body)); assert.equal(await pending, true); await settle();
  assert.equal(h.actual.getSnapshot().job.source.content, 'Actual submitted source'); V.noSave(h);
});

for (const [label, options] of [['path-like filename', {name: '../source.html'}],
  ['overlong filename', {name: 'x'.repeat(256)}], ['filename lone surrogate', {name: '\ud800.html'}],
  ['content lone surrogate', {content: '\udfff'}], ['NUL content', {content: 'a\0b'}]]) {
  test(`uploaded ${label} is rejected through exact provider admission and can be corrected`, async t => {
    const h = await fixture(t); fill(h, 'uploaded_html'); file(h.host, fakeFile(options).value); await settle();
    assert.equal(h.count('submit'), 0); click(button(h.host, 'Save source')); await settle();
    assert.equal(h.count('submit'), 0); assert.equal(h.actual.getSnapshot().error.responseRejected, true);
    assert.ok(h.host.querySelector('[role="alert"]')); file(h.host, fakeFile({name: 'corrected.html', content: 'Corrected source'}).value); await settle();
    click(button(h.host, 'Save source')); await settle(); assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1);
    h.last('submit').resolve(V.commandJob(h.last('submit').body)); await settle();
  });
}
