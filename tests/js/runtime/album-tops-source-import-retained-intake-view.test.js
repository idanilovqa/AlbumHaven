'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const V = require('./album-tops-source-import-view-fixtures/view.cjs');
const {fixture, fill, input, field, button, click, choice, settle} = V;
const labels = {url: 'URL', text: 'Plain text', pasted_html: 'Pasted HTML', uploaded_html: 'Uploaded HTML'};
let mountSourceImportView;
test.before(async () => {await V.load(); ({mountSourceImportView} = await V.F.load('album-tops/source-import-view.mjs'));});
const rejected = () => Object.assign(new Error('PRIVATE_REJECTION'), {status: 422, responseRejected: true});

for (const kind of Object.keys(labels)) for (const outcome of ['pending', 'uncertain', 'definitive']) {
  test(`${outcome} ${kind} remount restores exact locked intake through the actual controller and native Choice`, async t => {
    const h = await fixture(t), content = kind === 'url' ? 'https://example.test/source?private=retained'
      : '<b>Private retained source</b>\n1. Artist - Album';
    fill(h, kind, content); input(h.host, 'Album Top title', '\u0085 Retained title \u3000');
    let selected;
    if (kind === 'uploaded_html') {selected = V.fakeFile({name: '<img src=x onerror=retainedInjected()>.html', content}); V.file(h.host, selected.value); await settle();}
    click(button(h.host, 'Save source')); await settle(); const first = h.last('submit');
    if (outcome !== 'pending') {first.reject(outcome === 'uncertain' ? new TypeError('Lost acknowledgment') : rejected()); await settle();}
    const expected = {title: 'Retained title', description: 'Private source notes', kind,
      filename: kind === 'uploaded_html' ? '<img src=x onerror=retainedInjected()>.html' : null, content};
    assert.deepEqual(h.actual.getSubmittedSource(), expected); h.view.dispose();
    assert.equal(first.options.signal.aborted, false); assert.equal(h.calls.importDispose, 0);
    const resumed = mountSourceImportView(h.host, h.runtime, h.props);
    try {
      assert.equal(field(h.host, 'Album Top title').value, expected.title); assert.equal(field(h.host, 'Album Top title').disabled, true);
      assert.equal(field(h.host, 'Album Top description').value, expected.description); assert.equal(field(h.host, 'Album Top description').disabled, true);
      const kindControl = choice(h.host, 'Source type'); assert.equal(kindControl.disabled, true);
      assert.equal(kindControl.getAttribute('aria-label'), 'Source type: ' + labels[kind]);
      const source = field(h.host, kind === 'url' ? 'Source URL' : 'Source content');
      assert.equal(source.value, content); assert.equal(source.disabled, true);
      assert.equal(Boolean(source.closest('[hidden]')), kind === 'uploaded_html');
      if (kind === 'uploaded_html') {
        const upload = field(h.host, 'HTML file'); assert.equal(upload.disabled, true);
        assert.equal(Boolean(upload.closest('[hidden]')), false); assert.equal(Array.from(upload.files || []).length, 0);
        assert.equal(selected.reads(), 1, 'remount never re-reads the old browser File');
        assert.equal(upload.value ?? '', '');
        const retainedName = h.host.querySelector('[aria-label="Retained HTML filename"]');
        assert.ok(retainedName); assert.equal(Boolean(retainedName.closest('[hidden]')), false);
        assert.equal(retainedName.textContent, expected.filename); assert.equal(retainedName.querySelector('img'), null);
        assert.equal(h.context.retainedInjected, undefined);
      }
      assert.equal(button(h.host, 'Save source').disabled, true); assert.equal(h.actual.canSubmit(), false);
      assert.equal(h.count('submit'), 1); assert.equal(h.keyCalls(), 1);
      const copy = h.actual.getSubmittedSource(); assert.throws(() => {copy.content = 'Changed projection';}, TypeError);
      source.value = 'Attempted replacement'; source.dispatchEvent(new h.context.Event('input'));
      let acknowledged = first;
      if (outcome !== 'pending') {
        click(button(h.host, 'Retry')); await settle(); acknowledged = h.last('submit');
        assert.deepEqual(acknowledged.body, first.body); assert.equal(h.count('submit'), 2);
      } else assert.equal(button(h.host, 'Retry'), undefined);
      acknowledged.resolve(V.commandJob(first.body)); await settle(); assert.equal(h.actual.getSubmittedSource(), null);
      const evidence = h.host.querySelector('[aria-label="Source evidence"]'); assert.ok(evidence); assert.equal(evidence.hidden, false);
      assert.ok(evidence.textContent.includes(content)); assert.equal(h.actual.getSnapshot().job.source.kind, kind);
      assert.equal(h.keyCalls(), 1); assert.equal(h.calls.importDispose, 0); V.noSave(h);
    } finally {resumed.dispose();}
  });
}

test('locally rejected unadmitted input is not restored as locked submitted evidence on remount', async t => {
  const h = await fixture(t); fill(h, 'text', 'Locally rejected private text'); input(h.host, 'Album Top title', ' ');
  click(button(h.host, 'Save source')); await settle(); assert.equal(h.actual.getSubmittedSource(), null);
  assert.equal(h.actual.canSubmit(), true); assert.equal(h.count('submit'), 0); h.view.dispose();
  const resumed = mountSourceImportView(h.host, h.runtime, h.props);
  try {
    assert.equal(field(h.host, 'Album Top title').disabled, false); assert.equal(field(h.host, 'Album Top title').value, '');
    assert.ok(field(h.host, 'Source URL')); assert.equal(button(h.host, 'Retry'), undefined);
    assert.equal(h.actual.getSubmittedSource(), null); assert.equal(h.count('submit'), 0); assert.equal(h.keyCalls(), 1); V.noSave(h);
  } finally {resumed.dispose();}
});

test('a changed acknowledged job supplies remounted evidence instead of an earlier definitive-error submitted projection', async t => {
  const h = await fixture(t); fill(h, 'text', 'Old unacknowledged source'); click(button(h.host, 'Save source')); await settle();
  h.last('submit').reject(rejected()); await settle(); assert.ok(h.actual.getSubmittedSource()); h.view.dispose();
  const source = {request_key: V.F.id(997), title: 'New acknowledged source', description: 'New notes', kind: 'url', filename: null,
    content: 'https://example.test/new-authoritative-source'};
  const value = V.commandJob(source, {job_ref: V.F.id(998)}); h.setWire(value);
  assert.equal(await h.actual.open(value.job_ref), true); assert.equal(h.actual.getSubmittedSource(), null);
  const resumed = mountSourceImportView(h.host, h.runtime, h.props);
  try {
    const evidence = h.host.querySelector('[aria-label="Source evidence"]'); assert.ok(evidence); assert.equal(evidence.hidden, false);
    assert.ok(evidence.textContent.includes(source.content)); assert.equal(evidence.textContent.includes('Old unacknowledged source'), false);
    assert.equal(h.actual.getSnapshot().job.job_ref, value.job_ref); assert.equal(h.count('submit'), 1); assert.equal(h.count('read'), 1); V.noSave(h);
  } finally {resumed.dispose();}
});

for (const retirement of ['scope', 'dispose']) test(`${retirement} prevents remount from exposing retired admitted source`, async t => {
  const h = await fixture(t); fill(h, 'text', 'Retired private source'); click(button(h.host, 'Save source')); await settle(); const request = h.last('submit');
  h.view.dispose(); if (retirement === 'scope') h.scope(); else h.actual.dispose();
  assert.equal(h.actual.getSubmittedSource(), null); const resumed = mountSourceImportView(h.host, h.runtime, h.props);
  try {
    assert.equal(h.host.children.length, 0); request.resolve(V.commandJob(request.body)); await settle();
    assert.equal(h.host.children.length, 0); assert.equal(h.actual.getSubmittedSource(), null); assert.equal(h.count('submit'), 1); V.noSave(h);
  } finally {resumed.dispose();}
});
