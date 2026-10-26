'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./foobar-account-import-fixture.cjs'), N = require('./foobar-account-import-native-fixture.cjs'), J = require('./foobar-account-job-discovery-fixture.cjs');
const filter = f => f.host.querySelectorAll('select').find(node => node.id.endsWith('-discovery-filter'));
test('J17 native discovery renders friendly dates confirmed progress stop label and advanced fallback', async t => {
  const f = await N.native(t, J.wire(J.list([J.item()])));
  assert.match(f.host.textContent, /Created: .+Updated:/); assert.match(f.host.textContent, /Confirmed progress: 2 of 4 rows/); assert.match(f.host.textContent, /Stop requested: Yes/);
  assert.match(f.host.textContent, /Advanced: recover using exact references/); assert.equal(filter(f).value, 'unfinished'); assert.equal(f.action('openJob0').disabled, false); assert.equal(f.action('nextJobs').disabled, true); assert.equal(f.action('firstJobs').disabled, true);
  assert.equal(f.host.querySelector('img'), null); assert.equal(J.writes(f).length, 0);
  const described = f.action('openJob0').getAttribute('aria-describedby').split(' ');
  assert.equal(described.length, 2);
  assert.match(f.document.getElementById(described[0]).textContent, /Created: .+Updated:/);
  assert.match(f.document.getElementById(described[1]).textContent, /Confirmed progress: 2 of 4 rows/);
});
test('J18 native next first refresh and recent filter events use exact bounded page requests', async t => {
  const first = J.page(), f = await N.native(t, J.wire(first));
  const previousButtons = Array.from({length: 20}, (_, n) => f.action('openJob' + n));
  f.wire.enqueue('/job/list', J.list([J.item(20)])); f.click(f.action('nextJobs')); await F.settle();
  for (const button of previousButtons) {assert.equal(button.isConnected, false); assert.equal(f.listeners().filter(x => x.target === button).length, 0);}
  assert.deepEqual(J.body(f.wire.calls.at(-1)).cursor, first.result.next_cursor); assert.equal(f.host.querySelectorAll('[data-foobar-import-action="openJob0"]').length, 1); assert.equal(f.host.querySelector('[data-foobar-import-action="openJob1"]'), null); assert.equal(f.action('firstJobs').disabled, false);
  f.wire.enqueue('/job/list', J.list()); f.click(f.action('firstJobs')); await F.settle(); assert.equal(J.body(f.wire.calls.at(-1)).cursor, null);
  f.wire.enqueue('/job/list', J.list([], {unfinished: false})); filter(f).value = 'recent'; f.change(filter(f)); await F.settle(); assert.deepEqual(J.body(f.wire.calls.at(-1)), {version: J.VERSION, unfinished: false, cursor: null});
  f.wire.enqueue('/job/list', J.list([], {unfinished: false})); f.click(f.action('refreshJobs')); await F.settle(); assert.equal(J.body(f.wire.calls.at(-1)).unfinished, false); assert.equal(J.writes(f).length, 0);
});
test('J19 native advisory open click reads actual status once and focuses retained job heading', async t => {
  const f = await N.native(t, J.wire(J.list([J.item()]))), late = F.deferred(); f.wire.enqueue('/job/status', () => late.promise);
  const open = f.action('openJob0'); open.focus(); assert.equal(f.document.activeElement, open); f.click(open); assert.equal(open.isConnected, true); f.click(open); await F.settle(); assert.equal(f.wire.calls.filter(x => x.route === '/job/status').length, 1);
  assert.match(f.document.activeElement.textContent, /import/i);
  const outside = f.document.createElement('button'); f.document.body.append(outside); outside.focus();
  late.resolve(F.response(F.job())); await F.settle(); assert.match(f.host.textContent, /2 of 4/); assert.equal(f.field('job-reference').value, F.JOBREF);
  assert.equal(f.document.activeElement, outside); assert.equal(f.action('refreshJobs').disabled, true); assert.equal(J.writes(f).length, 0); assert.equal(f.time.tasks.size, 0);
});
test('J20 native busy and failed initialization preserve manual recovery without default-source traffic', async t => {
  const f = await N.native(t, J.wire(J.busy()), {initialize: false});
  assert.match(f.host.textContent, /Incomplete busy snapshot/); assert.deepEqual(f.wire.calls.map(x => x.route), ['/job/list']); assert.equal(f.host.querySelector('[data-foobar-import-action="openJob0"]'), null);
  f.wire.enqueue('/job/list', () => Promise.reject(new Error('lost'))); f.click(f.action('refreshJobs')); await F.settle(); assert.match(f.host.textContent, /could not be read/);
  f.field('recover-source').value = F.SOURCE; f.field('recover-job').value = F.JOBREF; f.wire.enqueue('/job/status', F.job()); f.click(f.action('recover')); await F.settle();
  assert.equal(f.wire.calls.at(-1).route, '/job/status'); assert.equal(J.writes(f).length, 0);
});
test('J21 native file review and unresolved job prevent discovery controls from interrupting workflow', async t => {
  const f = await N.native(t, J.wire(J.list([J.item()]))); f.choose(F.file()); await F.settle();
  assert.equal(filter(f).disabled, true); assert.equal(f.action('refreshJobs').disabled, true); assert.equal(f.action('openJob0').disabled, true);
  const before = f.wire.calls.length; f.click(f.action('refreshJobs')); f.click(f.action('openJob0')); assert.equal(f.wire.calls.length, before);
  await N.reviewed(f); assert.equal(f.action('refreshJobs').disabled, true); assert.equal(filter(f).disabled, true);
  f.field('confirmation').checked = true; f.change(f.field('confirmation')); f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start')); f.click(f.action('confirm')); await F.settle();
  const after = f.wire.calls.length; f.click(f.action('refreshJobs')); assert.equal(f.wire.calls.length, after); assert.equal(f.time.tasks.size, 1);
});
test('J22 native pagehide retires pending discovery and ignores late response without source dispatch', async t => {
  const late = F.deferred(), f = await N.native(t, J.wire(() => late.promise), {initialize: false});
  const request = f.wire.calls[0]; f.c.dispatchEvent(new f.c.Event('pagehide')); assert.equal(request.init.signal.aborted, true);
  late.resolve(F.response(J.list([J.item()]))); await F.settle(); assert.equal(f.host.querySelector('.foobar-import'), null); assert.equal(f.wire.calls.length, 1); assert.equal(f.time.tasks.size, 0);
});
test('J23 discovery source remains narrowly scoped safe-text and actual recovery owned', () => {
  const controller = F.read('music_app/static/js/foobar-import/controller.mjs'), index = F.read('music_app/static/js/foobar-import/index.mjs');
  assert.match(controller, /await recoverJob\(ref,source\)/); assert.match(controller, /request\('\/job\/list'/); assert.doesNotMatch(controller, /localStorage|sessionStorage|indexedDB/);
  const rendering = index.slice(index.indexOf('const listed = state.discovery;'), index.indexOf('const choosing ='));
  assert.match(rendering, /replaceChildren\(\)/); assert.doesNotMatch(rendering, /innerHTML|insertAdjacentHTML/); assert.match(rendering, /selectDiscoveredJob/);
});
test('J24 native unfocused activation never steals external focus synchronously or after status', async t => {
  const f = await N.native(t, J.wire(J.list([J.item()]))), late = F.deferred();
  const outside = f.document.createElement('button'); f.document.body.append(outside); outside.focus();
  f.wire.enqueue('/job/status', () => late.promise); f.click(f.action('openJob0'));
  assert.equal(f.document.activeElement, outside); assert.equal(f.wire.calls.at(-1).route, '/job/status');
  late.resolve(F.response(F.job())); await F.settle(); assert.equal(f.document.activeElement, outside); assert.equal(J.writes(f).length, 0);
});
