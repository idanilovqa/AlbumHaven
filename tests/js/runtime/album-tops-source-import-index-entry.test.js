'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');
const {fixture, button, click, settle, open, close, measure, F} = I;
test.before(I.load);
const labels = root => [...root.querySelectorAll('button')].filter(node => !node.closest('[hidden]')).map(node => node.getAttribute('aria-label') || node.textContent.trim());

test('actual directory keeps one-click Create followed by Import in the shared action slot', async t => {
  const h = await fixture(t), header = measure(h, 1000), actions = header.querySelector('.home-header__primary-actions');
  assert.deepEqual(labels(actions), ['Create Album Top', 'Import Album Top']);
  assert.equal(h.host.querySelectorAll('[data-shared-header]').length, 1);
  for (const slot of ['leading', 'outside', 'final-action']) assert.deepEqual(labels(header.querySelector(`.home-header__${slot}`)), []);
  click(button(h.host, 'Create Album Top')); await settle();
  assert.equal(h.forms.length, 1); assert.notEqual(h.forms[0].options.pageId, 'album-top-import');
  assert.ok(h.formHost().querySelector('[name="top-name"]'), 'manual builder opens directly, without a chooser');
  assert.equal(h.count('submit'), 0); assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0);
});

test('duplicate Import activation owns one actual native dialog and allocates no second key', async t => {
  const h = await fixture(t), opener = button(h.host, 'Import Album Top'); click(opener); await settle();
  const keys = h.keys.length, root = h.formHost(); click(opener); click(opener); await settle();
  assert.equal(h.forms.length, 1); assert.equal(h.keys.length, keys); assert.equal(h.formHost(), root);
  assert.equal(h.forms[0].options.title, 'Import Album Top'); assert.equal(h.forms[0].options.pageId, 'album-top-import');
  assert.equal(h.count('submit'), 0); assert.equal(h.count('read'), 0);
});

for (const width of [210, 80]) test(`real shared Tools at width ${width} preserves Import ordering, keyboard and Escape`, async t => {
  const h = await fixture(t), header = measure(h, width), tools = header.querySelector('[data-header-tools]');
  assert.equal(header.getAttribute('data-header-compact'), 'true'); assert.ok(header.querySelector('.home-header__actions').hasAttribute('inert'));
  tools.focus(); h.dispatch(tools, 'keydown', {key: 'Enter'}); await settle();
  // Native button activation is a browser click following Enter; the fixture
  // dispatches it explicitly rather than implementing a second menu owner.
  assert.equal(tools.getAttribute('aria-expanded'), 'false'); click(tools);
  assert.equal(tools.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(labels(header.querySelector('.home-header__primary-actions')), ['Create Album Top', 'Import Album Top']);
  h.dispatch(header, 'keydown', {key: 'Escape'}); await settle();
  assert.equal(tools.getAttribute('aria-expanded'), 'false'); assert.equal(h.document.activeElement, tools);
  assert.equal(h.forms.length, 0); click(tools); await open(h); assert.equal(h.forms.length, 1);
});

for (const compact of [false, true]) test(`Import close restores the current ${compact ? 'shared Tools' : 'visible Import'} focus target`, async t => {
  const h = await fixture(t); measure(h, 1000); const opener = button(h.host, 'Import Album Top'); opener.focus(); await open(h);
  if (compact) measure(h, 210);
  assert.equal(await close(h), null); const expected = compact ? h.header().querySelector('[data-header-tools]') : opener;
  assert.equal(h.document.activeElement, expected); assert.equal(Boolean(expected.closest('[hidden],[inert]')), false);
  assert.equal(h.count('submit'), 0);
});

test('existing create denial hides both directory entry actions without allocating an import', async t => {
  const h = await fixture(t, {allowed: false});
  assert.equal(button(h.host, 'Create Album Top'), undefined); assert.equal(button(h.host, 'Import Album Top'), undefined);
  assert.equal(h.forms.length, 0); assert.equal(h.count('submit'), 0); assert.equal(h.count('finalize'), 0);
});

for (const compact of [false, true]) test(`missing actual notification owner leaves Import visibly disabled${compact ? ' inside Tools' : ''}`, async t => {
  const h = await fixture(t, {registry: false}); measure(h, compact ? 210 : 1000);
  if (compact) click(h.header().querySelector('[data-header-tools]'));
  const entry = button(h.host, 'Import Album Top'); assert.ok(entry); assert.equal(entry.disabled, true);
  assert.equal(button(h.host, 'Create Album Top').disabled, false); const keys = h.keys.length; click(entry); await settle();
  assert.equal(h.keys.length, keys); assert.equal(h.forms.length, 0); assert.equal(h.count('feed'), 0);
  await h.replaceRegistry(); assert.equal(button(h.host, 'Import Album Top').disabled, false); await open(h);
});

test('selected Top and its actual inline Edit do not expose the directory import entry', async t => {
  const h = await fixture(t, {topRef: F.TOP}); assert.equal(button(h.host, 'Import Album Top'), undefined);
  click(button(h.host, 'Edit Album Top')); await settle(); assert.ok(h.host.querySelector('.album-top-inline-edit'));
  assert.equal(button(h.host, 'Import Album Top'), undefined); assert.equal(h.forms.length, 0); assert.equal(h.count('submit'), 0);
});

test('a retained directory Import button cannot activate after actual selected-Top navigation', async t => {
  const h = await fixture(t), entry = button(h.host, 'Import Album Top'); await h.navigate(F.TOP);
  const keys = h.keys.length; click(entry); await settle(); assert.equal(h.keys.length, keys); assert.equal(h.forms.length, 0);
  assert.equal(button(h.host, 'Import Album Top'), undefined); assert.equal(h.runtime.snapshot().topRef, F.TOP);
});

test('32 closed uncertain submissions retain the exact bounded capacity; further Import is disabled before network', async t => {
  const h = await fixture(t);
  for (let index = 0; index < 32; index++) {
    const request = await I.submit(h, {content: `Private source ${index}`}); request.reject(new TypeError('connection lost'));
    await settle(); assert.equal(await close(h), null); assert.equal(h.count('submit'), index + 1);
  }
  assert.equal(new Set(h.calls('submit').map(row => row.body.request_key)).size, 32);
  measure(h, 210); click(h.header().querySelector('[data-header-tools]'));
  const entry = button(h.host, 'Import Album Top'); assert.equal(entry.disabled, true);
  const keys = h.keys.length; click(entry); await settle(); assert.equal(h.keys.length, keys); assert.equal(h.count('submit'), 32);
  assert.equal(h.cards().length, 32); assert.equal(h.count('process'), 0); assert.equal(h.count('finalize'), 0);
  // Full capacity still permits exact retained recovery, then durable feed
  // acknowledgment plus Close frees a slot through the actual index wrapper.
  const first = h.calls('submit')[0]; h.activate('pending:' + first.body.request_key); await settle(); await h.settleNavigation();
  click(button(h.formHost(), 'Retry')); await settle(); assert.deepEqual(h.last('submit').body, first.body);
  const value = I.commandJob(first.body); h.setFeed([I.summary(value)]); h.last('submit').reply(value); await settle();
  assert.equal(await close(h), null); measure(h, 1000); assert.equal(button(h.host, 'Import Album Top').disabled, false);
  const next = await I.submit(h, {content: 'Recovered capacity'}); assert.notEqual(next.body.request_key, first.body.request_key);
});
