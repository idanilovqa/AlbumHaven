'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const R = require('./notification-source-fixtures/registry.cjs');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');

function parsedTemplate(document) {
  const template = document.createElement('template');
  template.innerHTML = ' leading <button class="fragment-check">Open</button><span>tail</span>';
  assert.equal(template.content.firstElementChild.tagName, 'BUTTON');
  assert.equal(template.content.firstElementChild.className, 'fragment-check');
  return template;
}

test('the real registry fixture installs fragment support before rendering an actual task card', t => {
  const h = R.fixture(t); parsedTemplate(h.document);
  const handle = h.register(); handle.replace([R.row('fragment', {title: 'Fragment task', statusLabel: 'Ready for review'})]);
  const {body} = h.mountDrawer();
  assert.equal(body.querySelectorAll('[data-open-request-notification]').length, 1);
  assert.match(body.textContent, /Fragment task/); assert.match(body.textContent, /Ready for review/);
  assert.equal(h.calls.length, 0);
});

test('the actual index fixture installs fragment support before its real registry renders a source card', async t => {
  await I.load(); const value = I.job(), h = await I.fixture(t, {feed: [I.summary(value)]});
  parsedTemplate(h.document); await h.showNotifications();
  const body = h.document.getElementById('cover-lookup-drawer-body');
  assert.equal(body.querySelectorAll('[data-open-request-notification]').length, 1);
  assert.match(body.textContent, /Ready for review/); assert.equal(h.cards().length, 1);
  assert.equal(h.cards()[0].id, value.job_ref); assert.equal(h.cards()[0].read, false);
  assert.equal(h.forms.length, 0); assert.equal(h.navigations.length, 0);
  for (const kind of ['submit', 'process', 'finalize', 'read']) assert.equal(h.count(kind), 0);
});
