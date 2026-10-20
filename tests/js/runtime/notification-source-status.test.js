'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {SCOPE, row, plain, fixture} = require('./notification-source-fixtures/registry.cjs');

test('legacy registered rows retain Pending response when statusLabel is omitted', t => {
  const h = fixture(t), source = h.register({label: 'Friend requests'});
  source.replace([row('friend', {typeLabel: 'Friend request', byline: 'Requested friendship'})]);
  assert.equal(h.cards().length, 1); assert.match(h.cards()[0].markup, />Pending response<\/span>/);
  assert.match(h.cards()[0].markup, />Friend request<\/span>/); assert.equal(h.calls.length, 0);
});

test('optional statusLabel and every display field remain escaped plain text', t => {
  const h = fixture(t), source = h.register();
  const hostile = '<img src=x onerror="privateCode()"> & <script>privateScript()</script>';
  source.replace([row('task', {title: hostile, byline: hostile, statusLabel: hostile})]);
  const card = h.cards()[0];
  assert.doesNotMatch(card.markup, /<img src=x|<script>|onerror="privateCode\(\)"/);
  assert.match(card.markup, /&lt;img src=x onerror=&quot;privateCode\(\)&quot;&gt; &amp;/);
  const {body} = h.mountDrawer();
  assert.equal(body.querySelector('.cover-lookup-task-status-label').textContent, hostile);
  assert.equal(body.querySelector('.cover-lookup-task-title').textContent, hostile);
  assert.equal(body.querySelector('.cover-lookup-task-byline').textContent, hostile);
  assert.equal(body.querySelector('script'), null); assert.equal(body.querySelector('img'), null);
});

test('error retains only explicitly supplied current records and renders the feed error alongside them', t => {
  const h = fixture(t), source = h.register();
  source.replace([row('obsolete'), row('old-uncertain')]);
  source.replace([row('retained', {statusLabel: 'Submission result unknown', byline: 'Submission result unknown'})], {status: 'error'});
  assert.deepEqual(h.cards().map(card => card.id), ['retained']); assert.equal(h.statuses().length, 1);
  assert.match(h.statuses()[0].markup, /Album Top imports could not be loaded/);
  const {body} = h.mountDrawer();
  assert.match(body.textContent, /Album Top imports could not be loaded/);
  assert.match(body.textContent, /Submission result unknown/); assert.doesNotMatch(body.textContent, /obsolete|old-uncertain/);
  const trigger = body.querySelector('[data-open-request-notification]'); assert.ok(trigger);
  h.click(trigger); assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'retained');
  trigger.dispatchEvent(new h.context.Event('keydown', {key: 'Enter'}));
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1][0], 'retained');
  assert.equal(h.calls[1][1].parentSurface, '#cover-lookup-drawer');
  assert.equal(typeof h.calls[1][1].returnFocus, 'function');
});

test('an error with no explicitly supplied records does not silently keep an old cache', t => {
  const h = fixture(t), source = h.register(); source.replace([row('old')]); source.replace([], {status: 'error'});
  assert.equal(h.cards().length, 0); assert.equal(h.statuses().length, 1);
  assert.match(h.statuses()[0].markup, /could not be loaded/);
});

for (const status of ['denied', 'unavailable']) test(`${status} discards even explicitly supplied records immediately`, t => {
  const h = fixture(t), source = h.register(); source.replace([row('old')], {status: 'ready'});
  source.replace([row('must-not-survive', {statusLabel: 'Private pending action'})], {status});
  assert.equal(h.cards().length, 0); assert.equal(h.statuses().length, 1);
  assert.doesNotMatch(h.statuses()[0].markup, /must-not-survive|Private pending action/);
});

test('scope loss rejects error updates and removes retained cards and actions', t => {
  const h = fixture(t); let current = true;
  const source = h.register({isCurrent: () => current}); source.replace([row()], {status: 'error'});
  current = false;
  assert.equal(source.replace([row('stale')], {status: 'error'}), false);
  assert.equal(h.cards().length, 0); assert.equal(h.statuses().length, 0); assert.equal(h.calls.length, 0);
});

test('same-name successor cannot be overwritten or disposed by the retired source handle', t => {
  const h = fixture(t), old = h.register({name: 'album-top-source-imports'}); old.replace([row('old')]);
  const next = h.register({name: 'album-top-source-imports', scopeKey: `${SCOPE}:next`});
  next.replace([row('next', {statusLabel: 'Ready for review'})]);
  assert.equal(old.replace([row('stale')], {status: 'error'}), false); old.dispose();
  assert.deepEqual(h.cards().map(card => card.id), ['next']); assert.match(h.cards()[0].markup, /Ready for review/);
});

test('statusLabel is detached scalar evidence and arbitrary private payload fields are not retained', t => {
  const h = fixture(t), source = h.register(), input = row('one', {statusLabel: 'Saving Album Top',
    source: {content: 'PRIVATE_SOURCE'}, acquisition_ref: 'PRIVATE_ACQUISITION', raw_url: 'PRIVATE_URL', query: 'PRIVATE_QUERY'});
  source.replace([input]); input.statusLabel = 'Injected after projection'; input.source.content = 'Changed';
  const record = h.cards()[0].source.records.get('one');
  assert.equal(record.statusLabel, 'Saving Album Top'); assert.equal(Object.isFrozen(record), true);
  for (const key of ['source', 'acquisition_ref', 'raw_url', 'query']) assert.equal(Object.hasOwn(record, key), false);
  assert.doesNotMatch(JSON.stringify(plain(record)), /PRIVATE_|Changed|Injected/);
});

for (const avatarUrl of ['javascript:alert(1)', 'data:image/png;base64,abc', '//foreign.example.test/a', '/x\\y', '/x y']) {
  test(`existing unsafe-avatar filtering remains intact (${avatarUrl})`, t => {
    const h = fixture(t), source = h.register(); source.replace([row('one', {avatarUrl, statusLabel: 'Ready for review'})]);
    assert.equal(h.cards()[0].source.records.get('one').avatarUrl, ''); assert.doesNotMatch(h.cards()[0].markup, /<img/);
  });
}

test('legacy identity filtering and source-local isolation remain intact with error records', t => {
  const h = fixture(t), first = h.register(), second = h.register();
  first.replace([row('one'), row('one'), row(''), row('   ')], {status: 'error'});
  second.replace([row('one', {title: 'Independent source', typeLabel: 'Friend request'})]);
  assert.equal(h.cards().length, 2); assert.equal(h.statuses().length, 1);
  first.dispose(); assert.equal(h.cards().length, 1); assert.match(h.cards()[0].markup, /Independent source/);
});
