'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {row, fixture} = require('./notification-source-fixtures/registry.cjs');

for (const [friend, top, expected] of [
  [false, true, '1 notification'], [true, false, '1 notification'], [true, true, '2 notifications'],
]) test(`actual mixed-source drawer summary is ${expected} (friend=${friend}, import=${top})`, t => {
  const h = fixture(t), friends = h.register({name: 'friend-requests', label: 'Friend requests'});
  const imports = h.register({name: 'album-top-source-imports', label: 'Album Top imports'});
  friends.replace(friend ? [row('friend', {title: 'Friend Person', byline: 'Requested friendship', typeLabel: 'Friend request'})] : []);
  imports.replace(top ? [row('import', {title: 'Source Top', statusLabel: 'Ready for review'})] : []);
  const {summary, badge, body} = h.mountDrawer();
  assert.equal(summary.textContent, expected); assert.equal(badge.textContent, String(Number(friend) + Number(top)));
  assert.equal(badge.hidden, false); assert.doesNotMatch(summary.textContent, /friend request/);
  const labels = Array.from(body.querySelectorAll('.cover-lookup-task-type'), node => node.textContent);
  assert.deepEqual(labels.sort(), [friend ? 'Friend request' : null, top ? 'Album Top import' : null].filter(Boolean).sort());
  if (friend) assert.match(body.textContent, /Pending response/);
  if (top) assert.match(body.textContent, /Ready for review/);
  assert.equal(h.calls.length, 0);
});

for (const unread of [false, true]) test(`read cards remain inspectable while summary counts only ${unread ? 'one unread notification' : 'zero unread notifications'}`, t => {
  const h = fixture(t), friends = h.register({name: 'friend-requests'}), imports = h.register({name: 'album-top-source-imports'});
  friends.replace([row('friend', {typeLabel: 'Friend request', read: true})]);
  imports.replace([row('import', {read: !unread, statusLabel: 'Album Top created'})]);
  const {summary, badge, body} = h.mountDrawer();
  assert.equal(summary.textContent, unread ? '1 notification' : 'No activity');
  assert.equal(badge.hidden, !unread); assert.equal(badge.textContent, unread ? '1' : '');
  assert.equal(body.querySelectorAll('[data-open-request-notification]').length, 2);
  assert.match(body.textContent, /Album Top created/); assert.equal(h.calls.length, 0);
});
