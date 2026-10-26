'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./foobar-maintenance-fixture.cjs'), {F} = M;

test('MO01 mounted maintenance never posts on mount update disclosure or ordinary source selection', async t => {
  const f = await M.standalone(t, {state: null}); assert.equal(f.start.disabled, true); assert.equal(f.more.disabled, true);
  f.owner.update(M.idle()); f.section.open = true; f.section.dispatchEvent(new f.c.Event('toggle')); await F.settle();
  assert.equal(f.start.disabled, false); assert.equal(f.more.disabled, true); assert.equal(f.wire.calls.length, 0);
});
test('MO02 mounted maintenance posts exact current source null cursor and genuine session CSRF', async t => {
  const f = await M.standalone(t); await M.complete(f);
  const call = M.calls(f)[0]; assert.equal(M.calls(f).length, 1); assert.equal(call.url, '/integrations/foobar/account/maintenance');
  assert.deepEqual(M.body(call), {version: M.VERSION, source_ref: F.SOURCE, cursor: null});
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.redirect, 'error');
  const headers = new Headers(call.init.headers); assert.equal(headers.get('X-Album-Haven-CSRF'), 'synthetic-maintenance-csrf'); assert.equal(headers.get('X-AlbumHaven-Foobar-Context'), F.STAMP); assert.equal(headers.get('Content-Type'), 'application/json'); assert.equal(headers.get('Accept'), 'application/json');
  assert.equal(call.init.signal.aborted, true); assert.equal(f.time.tasks.size, 0);
});
test('MO03 mounted maintenance requires explicit continuation and passes the exact returned cursor', async t => {
  const f = await M.standalone(t), next = M.cursor();
  await M.complete(f, M.payload({inspected: 20, removed_receipts: 20, next_cursor: next}));
  assert.equal(M.calls(f).length, 1); assert.equal(f.more.disabled, false); await F.settle(); assert.equal(M.calls(f).length, 1);
  f.wire.enqueue('/maintenance', M.payload({inspected: 1, removed_receipts: 1})); f.click(f.more); await F.settle();
  assert.deepEqual(M.body(M.calls(f)[1]).cursor, next); assert.equal(f.more.disabled, true); assert.match(f.status.textContent, /This pass inspected 1 expired receipts, removed 1/); assert.doesNotMatch(f.status.textContent, /inspected 21|removed 21/);
});
test('MO04 mounted maintenance continues key-only work with null cursor and no inferred receipt page', async t => {
  const f = await M.standalone(t); await M.complete(f, M.payload({removed_keys: 100, more_retired_keys: true}));
  assert.equal(f.more.disabled, false); f.wire.enqueue('/maintenance', M.payload({removed_keys: 2})); f.click(f.more); await F.settle();
  assert.equal(M.body(M.calls(f)[1]).cursor, null); assert.match(f.status.textContent, /retired 2 request-key records/); assert.equal(f.more.disabled, true);
});
test('MO05 mounted maintenance fresh pass always restarts from null rather than stored continuation', async t => {
  const f = await M.standalone(t); await M.complete(f, M.payload({inspected: 20, protected_receipts: 20, next_cursor: M.cursor()}));
  await M.complete(f); assert.equal(M.body(M.calls(f)[1]).cursor, null); assert.equal(f.more.disabled, true);
});
test('MO06 mounted maintenance reports protected receipts without resuming cancelling or reconciling jobs', async t => {
  const f = await M.standalone(t); await M.complete(f, M.payload({inspected: 20, removed_receipts: 3, protected_receipts: 17}));
  assert.match(f.status.textContent, /inspected 20 expired receipts, removed 3, protected 17/); assert.match(f.status.textContent, /Protected job receipts require their genuine status\/reconciliation flow/); assert.match(f.status.textContent, /Imported history was not deleted/);
  assert.deepEqual(f.wire.calls.map(call => call.route), ['/maintenance']); assert.doesNotMatch(f.status.textContent, /import completed|history cleared|Last.fm.*combined|plays removed/i);
});
test('MO07 mounted maintenance busy guard rejects duplicate synthetic clicks and disables both controls', async t => {
  const f = await M.standalone(t), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise);
  f.click(f.start); assert.equal(f.start.disabled, true); assert.equal(f.more.disabled, true); f.start.dispatchEvent(new f.c.Event('click')); f.more.dispatchEvent(new f.c.Event('click'));
  assert.equal(M.calls(f).length, 1); pending.resolve(F.response(M.payload())); await F.settle(); assert.equal(f.start.disabled, false);
});
test('MO08 mounted maintenance disables every importing review submitted and discovery state', async t => {
  const f = await M.standalone(t);
  for (const phase of ['checking', 'selected', 'reviewing', 'review_ready', 'saving_personal', 'submitting', 'importing', 'paused', 'complete', 'disposed', null]) {
    f.owner.update(M.idle({phase})); assert.equal(f.start.disabled, true, String(phase)); f.start.dispatchEvent(new f.c.Event('click'));
  }
  for (const patch of [{submitted: true}, {discoveryLoading: true}, {source: null}, {source: {source_ref: 'invalid'}}]) {f.owner.update(M.idle(patch)); assert.equal(f.start.disabled, true); f.start.dispatchEvent(new f.c.Event('click'));}
  assert.equal(M.calls(f).length, 0);
});
test('MO09 mounted maintenance admits only idle or unsubmitted error with selected source', async t => {
  const f = await M.standalone(t); f.owner.update(M.idle({phase: 'error'})); assert.equal(f.start.disabled, false); await M.complete(f);
  f.owner.update(M.idle({phase: 'error', submitted: true})); assert.equal(f.start.disabled, true); assert.equal(M.calls(f).length, 1);
});
test('MO10 mounted maintenance lost acknowledgment remains explicitly uncertain and never auto retries', async t => {
  const f = await M.standalone(t); f.wire.enqueue('/maintenance', () => Promise.reject(new TypeError('Synthetic lost acknowledgment'))); await M.dispatch(f);
  M.uncertain(f); assert.equal(M.calls(f).length, 1); await F.settle(); f.owner.update(M.idle()); await F.settle(); assert.equal(M.calls(f).length, 1); assert.equal(f.start.disabled, false); assert.equal(f.time.tasks.size, 0);
});
test('MO11 mounted maintenance uncertain continuation clears old cursor and fresh action uses current state', async t => {
  const f = await M.standalone(t); await M.complete(f, M.payload({inspected: 20, removed_receipts: 20, next_cursor: M.cursor()}));
  f.wire.enqueue('/maintenance', () => Promise.reject(new TypeError('Lost second-page acknowledgment'))); f.click(f.more); await F.settle(); M.uncertain(f);
  await M.complete(f, M.payload({inspected: 2, protected_receipts: 2})); assert.equal(M.body(M.calls(f)[2]).cursor, null); assert.equal(M.calls(f).length, 3);
});
test('MO12 mounted maintenance non-success status cannot be interpreted as confirmed rollback or success', async t => {
  const f = await M.standalone(t); for (const code of [400, 401, 403, 409, 429, 500, 503]) {
    f.wire.enqueue('/maintenance', () => Promise.resolve(F.response(M.payload(), code))); await M.dispatch(f); M.uncertain(f);
  } assert.equal(M.calls(f).length, 7);
});
test('MO13 mounted maintenance rejects malformed foreign and contradictory successful wire replies', async t => {
  const f = await M.standalone(t); for (const value of [M.payload({source_ref: F.OTHER}), M.payload({}, {context_ref: 'b'.repeat(64)}), M.payload({removed_keys: 101}), M.payload({history_deleted: true}), M.payload({job_reconciled: true}), {result: '<img src=x>'}]) {
    f.wire.enqueue('/maintenance', value); await M.dispatch(f); M.uncertain(f); assert.equal(f.section.querySelector('img'), null);
  } assert.equal(M.calls(f).length, 6);
});
test('MO14 mounted maintenance enforces bounded JSON content length stream bytes encoding and MIME', async t => {
  const f = await M.standalone(t), options = {headers: {'Content-Type': 'application/json'}};
  const replies = [new Response('not json', options), new Response('{}', {headers: {'Content-Type': 'text/html'}}), new Response('{}', {headers: {'Content-Type': 'application/json', 'Content-Length': '12289'}}), new Response(' '.repeat(12289), options), new Response(new Uint8Array([0xc3, 0x28]), options)];
  for (const response of replies) {f.wire.enqueue('/maintenance', () => Promise.resolve(response)); await M.dispatch(f); M.uncertain(f);}
  assert.equal(M.calls(f).length, 5); assert.equal(f.time.tasks.size, 0);
});
test('MO15 mounted maintenance deadline abort is uncertain without retry and does not claim server cancellation', async t => {
  const f = await M.standalone(t); f.wire.enqueue('/maintenance', (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Synthetic deadline', 'AbortError')), {once: true})));
  f.click(f.start); await f.time.tick(65000); M.uncertain(f); assert.equal(M.calls(f).length, 1); assert.equal(M.calls(f)[0].init.signal.aborted, true); assert.equal(f.time.tasks.size, 0);
});
test('MO16 mounted maintenance source switch aborts old owner and fences out-of-order success', async t => {
  const f = await M.standalone(t), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.click(f.start);
  f.owner.update(M.idle({source: {source_ref: F.OTHER}})); assert.equal(M.calls(f)[0].init.signal.aborted, true); assert.equal(f.status.textContent, ''); assert.equal(f.start.disabled, false);
  await M.complete(f, M.payload({source_ref: F.OTHER, inspected: 2, removed_receipts: 2})); const current = f.status.textContent;
  pending.resolve(F.response(M.payload({inspected: 20, removed_receipts: 20, next_cursor: M.cursor()}))); await F.settle();
  assert.equal(f.status.textContent, current); assert.equal(f.more.disabled, true); assert.equal(M.body(M.calls(f)[1]).source_ref, F.OTHER);
});
test('MO17 mounted maintenance late old failure cannot overwrite a newer current-source result', async t => {
  const f = await M.standalone(t), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.click(f.start);
  f.owner.update(M.idle({source: {source_ref: F.OTHER}})); await M.complete(f, M.payload({source_ref: F.OTHER, removed_keys: 4})); const current = f.status.textContent;
  pending.reject(Error('Late old transport failure')); await F.settle(); assert.equal(f.status.textContent, current); assert.doesNotMatch(current, /not confirmed/);
});
test('MO18 mounted maintenance changed context scope currentness and capability fence activation', async t => {
  const f = await M.standalone(t);
  f.current(false); f.start.dispatchEvent(new f.c.Event('click')); f.current(true); f.allow(false); f.start.dispatchEvent(new f.c.Event('click')); f.allow(true);
  f.root.dataset.accountFoobarContext = 'b'.repeat(64); f.start.dispatchEvent(new f.c.Event('click')); f.root.dataset.accountFoobarContext = F.STAMP;
  f.root.dataset.accountFoobarScope = 'foreign'; f.start.dispatchEvent(new f.c.Event('click')); f.root.dataset.accountFoobarScope = F.SCOPE;
  f.root.remove(); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 0);
});
test('MO19 mounted maintenance retired account cannot publish a previously admitted response', async t => {
  const f = await M.standalone(t), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.click(f.start); const checking = f.status.textContent;
  f.root.dataset.accountFoobarContext = 'b'.repeat(64); pending.resolve(F.response(M.payload({inspected: 20, protected_receipts: 20}))); await F.settle();
  assert.equal(f.status.textContent, checking); assert.doesNotMatch(f.status.textContent, /This pass inspected/); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 1);
});
test('MO20 mounted maintenance disposal releases detached listeners aborts request and blocks stale clicks', async t => {
  const f = await M.standalone(t), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.click(f.start); f.owner.dispose(); f.owner.dispose();
  assert.equal(f.section.isConnected, false); assert.equal(M.calls(f)[0].init.signal.aborted, true); assert.equal(f.start.listeners.length, 0); assert.equal(f.more.listeners.length, 0);
  f.start.dispatchEvent(new f.c.Event('click')); pending.resolve(F.response(M.payload())); await F.settle(); assert.equal(M.calls(f).length, 1); assert.equal(f.host.children.length, 0);
});
test('MO21 mounted maintenance uses native named buttons polite status and no focus theft', async t => {
  const f = await M.standalone(t), outside = f.document.createElement('button'); outside.textContent = 'Other settings'; f.document.body.append(outside);
  assert.equal(f.start.type, 'button'); assert.equal(f.more.type, 'button'); assert.equal(f.start.textContent, 'Clean expired metadata'); assert.equal(f.more.textContent, 'Continue bounded cleanup');
  assert.equal(f.status.getAttribute('aria-live'), 'polite'); assert.equal(f.status.getAttribute('role'), 'status'); assert.match(f.section.textContent, /Imported history and job checkpoints are kept/);
  const pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.start.focus(); f.click(f.start); outside.focus(); pending.resolve(F.response(M.payload())); await F.settle(); assert.equal(f.document.activeElement, outside);
});
test('MO22 mounted maintenance selected-source change retires continuation and visible old pass data', async t => {
  const f = await M.standalone(t); await M.complete(f, M.payload({inspected: 20, protected_receipts: 20, next_cursor: M.cursor(), more_retired_keys: true}));
  f.owner.update(M.idle({source: {source_ref: F.OTHER}})); assert.equal(f.more.disabled, true); assert.equal(f.status.textContent, ''); f.more.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 1);
  await M.complete(f, M.payload({source_ref: F.OTHER})); assert.equal(M.body(M.calls(f)[1]).cursor, null);
});
test('MO23 mounted maintenance unchanged idle update does not unlock duplicate in-flight request', async t => {
  const f = await M.standalone(t), pending = F.deferred(); f.wire.enqueue('/maintenance', () => pending.promise); f.click(f.start); f.owner.update(M.idle());
  assert.equal(f.start.disabled, true); f.start.dispatchEvent(new f.c.Event('click')); assert.equal(M.calls(f).length, 1); pending.resolve(F.response(M.payload())); await F.settle();
});
test('MO24 mounted maintenance observes rotated CSRF only through the genuine session fetch owner', async t => {
  const f = await M.standalone(t); await M.complete(f); f.document.cookie = '__Host-album_haven_csrf=rotated-maintenance-csrf'; await M.complete(f);
  assert.equal(new Headers(M.calls(f)[0].init.headers).get('X-Album-Haven-CSRF'), 'synthetic-maintenance-csrf'); assert.equal(new Headers(M.calls(f)[1].init.headers).get('X-Album-Haven-CSRF'), 'rotated-maintenance-csrf');
  assert.deepEqual(Object.keys(M.body(M.calls(f)[1])).sort(), ['cursor', 'source_ref', 'version']);
});
