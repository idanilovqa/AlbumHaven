'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const P = require('./foobar-account-history-play-fixture.cjs');
const N = require('./foobar-account-history-native-fixture.cjs');

test('HU01 genuine row button requires separate check and Play activations', async t => {
  const f = await P.platform(t); await f.choose(); const button = f.nativeButtons()[0];
  assert.match(button.textContent, /Check playback match/); assert.equal(f.nativeCalls().length, 0);
  f.wire.enqueue('/history/native/eligibility', f.eligible()); f.click(button); await P.settle();
  assert.equal(f.nativeButtons()[0], button); assert.match(button.textContent, /Check and play matched track/); assert.equal(f.activations.length, 0);
  f.wire.enqueue('/history/native/play', P.envelope('play', P.target())); f.click(button); await P.settle();
  assert.equal(f.activations.length, 1); assert.equal(f.nativeButtons()[0], button); assert.match(button.textContent, /Check playback match/);
  assert.match(f.host.textContent, /Playback requested/);
});
test('HU02 pending native request disables every real row button without another dispatch', async t => {
  const f = await P.platform(t); await f.choose(); const late = P.deferred(); f.wire.enqueue('/history/native/eligibility', () => late.promise);
  f.click(f.nativeButtons()[0]); assert.ok(f.nativeButtons().every(button => button.disabled));
  for (const button of f.nativeButtons()) f.click(button); assert.equal(f.nativeCalls().length, 1);
  late.resolve(P.response(f.eligible())); await P.settle(); assert.ok(f.nativeButtons().every(button => !button.disabled)); assert.equal(f.activations.length, 0);
});
test('HU03 native grant is private and neither public history DOM nor controller retains a target', async t => {
  const f = await P.platform(t); await f.choose(); const before = JSON.stringify(f.owner.controller.getSnapshot()); await f.check(); await f.play();
  assert.equal(JSON.stringify(f.owner.controller.getSnapshot()), before);
  for (const value of [f.host.outerHTML, JSON.stringify(f.owner.controller.getSnapshot()), JSON.stringify(f.actions.state(f.row()))]) {
    assert.doesNotMatch(value, /synthetic\/library-one|inventory-track:1:9|Native title|Native artist|Native album|data-track-path|data-inventory-track-ref|data-src|albumListeningIntent/);
  }
  assert.deepEqual(Object.keys(f.actions.state(f.row())).sort(), ['busy', 'canAttemptPlay', 'notice']); assert.equal(f.storage.length, 0);
});
test('HU04 row focus listener ownership and measured scroll survive genuine native repaint', async t => {
  const f = await P.platform(t); await f.choose(); f.scroller.scrollTop = 250; const old = f.nativeButtons()[5]; old.focus();
  f.wire.enqueue('/history/list', P.page(1)); await f.owner.controller.loadHistory({next: true});
  const next = f.nativeButtons()[5]; assert.notEqual(next, old); assert.equal(f.document.activeElement, next); assert.equal(f.scroller.scrollTop, 250);
  assert.equal(old.isConnected, false); assert.equal(old.listeners.length, 0); const count = f.nativeCalls().length; f.click(old); assert.equal(f.nativeCalls().length, count);
  assert.equal(f.outer.scrollTop, 0);
});
test('HU05 evicted focused native control moves focus to page status without scroll jump', async t => {
  const f = await P.platform(t); await f.choose();
  for (let n = 1; n < 5; n++) {f.wire.enqueue('/history/list', P.page(n)); await f.owner.controller.loadHistory({next: true});}
  const old = f.nativeButtons()[0]; old.focus(); f.scroller.scrollTop = 1250;
  f.wire.enqueue('/history/list', P.page(5)); await f.owner.controller.loadHistory({next: true});
  assert.equal(old.listeners.length, 0); assert.equal(f.document.activeElement.getAttribute('tabindex'), '-1');
  assert.match(f.document.activeElement.textContent, /Loaded pages 2–6/); assert.equal(f.scroller.scrollTop, 250); assert.equal(f.nativeButtons().length, 100);
});
test('HU06 source refresh immediately aborts pending native work while late results remain inert', async t => {
  const f = await P.platform(t); await f.choose(); const item = f.row(), late = P.deferred(); f.wire.enqueue('/history/native/eligibility', () => late.promise);
  f.click(f.nativeButtons()[0]); const signal = f.nativeCalls()[0].init.signal;
  f.wire.enqueue('/history/sources', P.sources()); f.click(f.button('Refresh source list')); await P.settle();
  assert.equal(signal.aborted, true); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 0);
  late.resolve(P.response(f.eligible(item))); await P.settle(); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(item).canAttemptPlay, false);
});
test('HU07 account-only entry remains display-only and never constructs a library shell', async t => {
  const f = await N.platform(t, {entry: true}); await f.choose();
  assert.equal(f.document.getElementById('app-shell'), null); assert.equal(f.c.AlbumHavenPrivateUITransport, undefined); assert.equal(f.c.AlbumHavenTrackPlayback, undefined);
  assert.ok(f.host.querySelectorAll('.foobar-history__row').every(row => row.querySelector('button') === null));
  assert.ok(f.wire.calls.every(call => ['/history/sources', '/history/list'].includes(call.route))); assert.match(f.host.textContent, /Display only/);
});
test('HU08 current native view retirement disables controls and prevents click dispatch', async t => {
  const f = await P.platform(t); await f.choose(); await f.check(); f.current(false); f.update();
  assert.ok(f.nativeButtons().every(button => button.disabled)); for (const button of f.nativeButtons()) f.click(button);
  assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0);
});
test('HU09 native checks and Play do not change history viewport or public source labels', async t => {
  const f = await P.platform(t, {variable: true}); await f.choose(); f.scroller.scrollTop = 275;
  const labels = f.host.querySelectorAll('.foobar-history__row').map(row => row.querySelector('h4').textContent);
  await f.check(); await f.play(); assert.equal(f.scroller.scrollTop, 275); assert.equal(f.outer.scrollTop, 0);
  assert.deepEqual(f.host.querySelectorAll('.foobar-history__row').map(row => row.querySelector('h4').textContent), labels);
  assert.match(f.host.textContent, /Actual file availability is checked on that click/); assert.doesNotMatch(f.host.textContent, /Native title/);
});
test('HU10 missing native dependencies return no adapter without acquiring hidden runtime ownership', async () => {
  const {createFoobarHistoryNativeActions} = await P.load('native-actions.mjs');
  for (const input of [{}, {controller: {}}, {controller: {}, transport: {}, tracks: {}, isCurrent: () => true}]) assert.equal(createFoobarHistoryNativeActions(input), null);
});
