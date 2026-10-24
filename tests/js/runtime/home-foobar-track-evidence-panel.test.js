// Actual Home transport adaptation: all16 cases/assertions retained; BP14 uses real rejected-context receipt invalidation.
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('./foobar-track-evidence-fixture.cjs');
async function load(f, value = B.payload()) {const index = f.requests.length; f.click(f.button(index ? 'Refresh from beginning' : 'Load evidence')); await f.flush(); f.reply(index, value); await f.flush();}
test('BP01 detail mount is lazy and explicit load uses genuine private context and session CSRF', async t => {
  const f = await B.platform(t); f.mount(); assert.equal(f.requests.length, 0);
  assert.equal(f.host.getAttribute('role'), 'region'); assert.equal(f.host.getAttribute('aria-label'), 'Foobar imported track evidence');
  await load(f); assert.equal(f.requests.length, 1); const call = f.requests[0];
  assert.equal(call.url, '/integrations/foobar/account/history/native/evidence');
  assert.deepEqual(B.body(call), {version: B.VERSION, track_id: '11', family: 'standard', cursor: null});
  assert.equal(call.options.method, 'POST'); assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store');
  assert.equal(call.options.headers.get('X-AlbumHaven-Context'), B.CONTEXT); assert.equal(call.options.headers.get('X-Album-Haven-CSRF'), 'synthetic-evidence-csrf');
  assert.equal(f.host.querySelectorAll('section').length, 1); B.noPrivate(f.host);
});
test('BP02 sixty-five sources traverse four bounded pages with only the current twenty retained', async t => {
  const f = await B.platform(t); f.mount(); const seen = new Set(); let previousRows = [];
  for (let n = 0; n < 4; n++) {
    const value = B.page(n*20+1, n === 3 ? 5 : 20, n !== 3);
    f.click(f.button(n ? 'More sources' : 'Load evidence')); await f.flush();
    assert.equal(f.requests.length, n+1); assert.deepEqual(B.body(f.requests[n]).cursor, n ? B.cursor(B.item(n*20)) : null);
    f.reply(n, value); await f.flush();
    const rows = f.host.querySelectorAll('section'); assert.equal(rows.length, value.result.items.length); assert.ok(rows.length <= 20);
    for (const row of previousRows) assert.equal(row.isConnected, false); previousRows = rows;
    for (const row of value.result.items) {assert.equal(seen.has(row.source_ref), false); seen.add(row.source_ref); assert.ok(f.host.textContent.includes(row.source_ref));}
  }
  assert.equal(seen.size, 65); assert.equal(f.button('More sources').disabled, true); assert.match(f.host.textContent, /End of current source observations/);
  assert.equal(f.requests.length, 4); B.noPrivate(f.host);
});
test('BP03 explicit refresh accepts lower exact counts newer revisions and new keys before the cursor', async t => {
  const f = await B.platform(t); f.mount(); await load(f, B.page(21));
  const previous = f.host.querySelectorAll('section');
  const value = B.payload([B.item(1, {count: '0', source_revision: '9', association_version: '4'}), B.item(21, {count: '2', source_revision: '9'})]);
  await load(f, value); assert.equal(B.body(f.requests[1]).cursor, null);
  assert.equal(f.host.querySelectorAll('section').length, 2); assert.ok(previous.every(row => !row.isConnected));
  assert.match(f.host.textContent, /reported plays: 0/); assert.match(f.host.textContent, /reported plays: 2/); assert.match(f.host.textContent, /source revision 9 · association decision 4/);
  assert.match(f.host.textContent, /Each page is a current read/); assert.match(f.host.textContent, /Refresh from the beginning after imports or match changes/);
});
test('BP04 count family change clears prior rows and requires an explicit new read from beginning', async t => {
  const f = await B.platform(t); f.mount(); await load(f, B.page()); f.change('enhanced');
  assert.equal(f.requests.length, 1); assert.equal(f.host.querySelectorAll('section').length, 0); assert.equal(f.button('More sources').disabled, true);
  await load(f, B.payload([B.item()], {family: 'enhanced'}));
  assert.deepEqual(B.body(f.requests[1]), {version: B.VERSION, track_id: '11', family: 'enhanced', cursor: null}); assert.match(f.host.textContent, /Enhanced TSV reported plays: 12/);
});
test('BP05 pending family replacement aborts and fences late old-family response', async t => {
  const f = await B.platform(t); const owner = f.mount(); const old = owner.load(); await f.flush();
  f.change('enhanced'); assert.equal(f.requests[0].options.signal.aborted, true);
  const fresh = owner.load(); await f.flush(); f.reply(1, B.payload([B.item(2)], {family: 'enhanced'})); await fresh;
  f.reply(0, B.payload()); await old; assert.equal(f.host.querySelectorAll('section').length, 1);
  assert.ok(f.host.textContent.includes(B.item(2).source_ref)); assert.equal(f.host.textContent.includes(B.item(1).source_ref), false);
});
test('BP06 failed continuation is not true end and only explicit refresh can restart', async t => {
  const f = await B.platform(t); f.mount(); await load(f, B.page()); const rows = f.host.querySelectorAll('section');
  f.click(f.button('More sources')); await f.flush(); f.reject(1); await f.flush();
  assert.equal(f.host.querySelector('[role="alert"]').hidden, false); assert.match(f.host.textContent, /Previous page is not evidence of current completeness/);
  assert.doesNotMatch(f.host.textContent, /End of current source observations/); assert.equal(f.button('More sources').disabled, true); assert.equal(f.requests.length, 2);
  assert.ok(rows.every(row => row.isConnected)); await load(f, B.payload([]));
  assert.equal(B.body(f.requests[2]).cursor, null); assert.match(f.host.textContent, /No currently matched Foobar source evidence/); assert.equal(f.host.querySelectorAll('section').length, 0);
});
test('BP07 zero unavailable invalid and contradictory evidence remain separate without provider sums', async t => {
  const f = await B.platform(t); f.mount(); await load(f, B.payload([
    B.item(1, {count: '0'}), B.item(2, {count_state: 'invalid', count: null, status: 'needs_reconciliation', reason: 'invalid_count'}),
    B.item(3, {count: '1', status: 'needs_reconciliation', reason: 'single_count_boundary_conflict'}),
    B.item(4, {evidence_kind: 'enhanced_store', count_state: 'unavailable', count: null, status: 'unavailable', reason: 'local_timestamp_vector_unavailable'}),
    B.item(5, {evidence_kind: 'enhanced_store', count: '32766'}),
  ]));
  const rows = f.host.querySelectorAll('section'); assert.equal(rows.length, 5);
  assert.match(rows[0].textContent, /plays: 0/); assert.match(rows[1].textContent, /Unavailable.*invalid/); assert.match(rows[2].textContent, /plays: 1.*requires reconciliation/);
  assert.match(rows[3].textContent, /local timestamp entries: Unavailable/); assert.match(rows[4].textContent, /local timestamp entries: 32766/);
  assert.match(f.host.textContent, /never added to Last.fm or Album Haven listening, or summed across sources/);
  assert.match(f.host.textContent, /not lifetime plays or measured Full listens/); assert.match(f.host.textContent, /Cached Last.fm entries are excluded/); B.noPrivate(f.host);
});
test('BP08 malformed DTO fails closed without rendering private fields or a false empty result', async t => {
  const f = await B.platform(t); f.mount(); const value = B.payload(); value.result.items[0].path = '/synthetic/private.flac';
  await load(f, value); assert.equal(f.host.querySelectorAll('section').length, 0); assert.equal(f.host.querySelector('[role="alert"]').hidden, false);
  assert.doesNotMatch(f.host.textContent, /No currently matched|End of current/); B.noPrivate(f.host);
});
test('BP09 repeated load clicks cannot overlap and one owned deadline is cleared after completion', async t => {
  const f = await B.platform(t), owner = f.mount(); const first = owner.load(); await owner.load(); await f.flush();
  assert.equal(f.requests.length, 1); assert.equal(f.button('Load evidence').disabled, true); assert.equal(f.host.querySelector('select').disabled, true);
  assert.equal([...f.time.tasks.values()].filter(x => x.delay === 30000).length, 1);
  f.reply(0, B.payload()); await first; assert.equal(f.time.tasks.size, 0); assert.equal(f.button('Refresh from beginning').disabled, false);
});
test('BP10 owned deadline aborts without any automatic resend or inferred completeness', async t => {
  const f = await B.platform(t), owner = f.mount(); const pending = owner.load(); await f.flush(); await f.time.tick(30000);
  assert.equal(f.requests[0].options.signal.aborted, true); f.reject(0); await pending;
  assert.equal(f.requests.length, 1); assert.equal(f.host.querySelector('[role="alert"]').hidden, false); assert.equal(f.time.tasks.size, 0);
});
test('BP11 explicit Close disposes pending read DOM handlers and late reply without native effects', async t => {
  const f = await B.platform(t), owner = f.mount(); const pending = owner.load(); await f.flush(); const close = f.button('Close evidence');
  f.click(close); assert.equal(f.host.isConnected, false); assert.equal(f.requests[0].options.signal.aborted, true);
  f.reply(0, B.payload()); await pending; f.click(close); await owner.load(); assert.equal(f.requests.length, 1); assert.equal(f.host.childNodes.length, 0);
});
test('BP12 context change retires detail before a delayed response can publish', async t => {
  const f = await B.platform(t), owner = f.mount(); const pending = owner.load(); await f.flush();
  f.shell.dataset.privateUiContext = 'd'.repeat(64); f.mutate(f.shell);
  assert.equal(f.host.isConnected, false); assert.equal(f.requests[0].options.signal.aborted, true); f.reply(0, B.payload()); await pending; assert.equal(f.host.childNodes.length, 0);
});
test('BP13 caller retirement and detached host fence request initiation and pending completion', async t => {
  const f = await B.platform(t), owner = f.mount(); f.current(false); await owner.load(); assert.equal(f.requests.length, 0);
  f.current(true); const pending = owner.load(); await f.flush(); f.host.remove(); f.reply(0, B.payload()); await pending;
  assert.equal(f.host.querySelectorAll('section').length, 0); await owner.load(); assert.equal(f.requests.length, 1);
});
test('BP14 transport generation invalidation removes active detail and all owned controls', async t => {
  const f = await B.platform(t), owner = f.mount(); await load(f); assert.throws(() => f.transport.accept({context_ref: 'd'.repeat(64)}), /Reload to restore this session/);
  assert.equal(f.host.isConnected, false); assert.equal(f.host.childNodes.length, 0); await owner.load(); assert.equal(f.requests.length, 1);
});
test('BP15 focus is explicit and current while page refresh does not steal another control focus', async t => {
  const f = await B.platform(t), owner = f.mount(); const other = f.document.createElement('button'); f.document.body.append(other); other.focus();
  assert.equal(f.document.activeElement, other); owner.focus(); assert.equal(f.document.activeElement, f.host.querySelector('h4'));
  other.focus(); await load(f); assert.equal(f.document.activeElement, other); f.current(false); owner.focus(); assert.equal(f.document.activeElement, other);
});
test('BP16 HTTP refusal remains an explicit failure rather than zero matched evidence', async t => {
  const f = await B.platform(t), owner = f.mount(); const pending = owner.load(); await f.flush(); f.reply(0, {error: 'forbidden'}, 403); await pending;
  assert.equal(f.host.querySelector('[role="alert"]').hidden, false); assert.doesNotMatch(f.host.textContent, /No currently matched|End of current/); assert.equal(f.requests.length, 1);
});
