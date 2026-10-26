'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const H = require('./foobar-account-history-fixture.cjs'), N = require('./foobar-account-history-native-fixture.cjs');
test('H20 actual account entry mounts with no library or import owner and explicit source selection', async t => {
  const f = await N.platform(t, {entry: true}); assert.equal(f.document.getElementById('app-shell'), null); assert.equal(f.host.getAttribute('role'), 'region'); assert.equal(f.wire.calls.length, 1); assert.equal(f.wire.calls[0].route, '/history/sources'); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 0); assert.match(f.host.textContent, /Choose an existing source/); await f.choose(H.history()); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 1);
});
test('H21 actual native source family mode controls retain separate explicit all-time scope', async t => {
  const f = await N.platform(t); await f.choose(); const selects = f.host.querySelectorAll('select'); assert.match(f.host.textContent, /Standard counts · All time/);
  f.wire.enqueue('/history/list', H.page(0, {family: 'enhanced'})); selects[1].value = 'enhanced'; f.change(selects[1]); await H.settle(); assert.match(f.host.textContent, /Enhanced counts · All time/);
  f.wire.enqueue('/history/list', H.page(0, {family: 'enhanced', mode: 'individual'})); selects[2].value = 'individual'; f.change(selects[2]); await H.settle(); assert.equal(JSON.parse(f.wire.calls.at(-1).init.body).mode, 'individual'); assert.match(f.host.textContent, /Undated aggregate remainder/);
});
test('H22 actual native zero one two and missing counts never acquire fabricated badges', async t => {
  const f = await N.platform(t), rows = ['0', '1', '2'].map((total, n) => H.row(10-n, {total, aggregate_remainder: total, show_grouped_count: total === '2', show_remainder_count: total === '2'}));
  rows.push(H.row(1, {count_state: 'absent', total: null, aggregate_remainder: null, status: 'unavailable', reason: 'count_unavailable', show_grouped_count: false, show_remainder_count: false})); await f.choose(H.history(rows));
  assert.equal(f.host.querySelectorAll('.foobar-history__count').length, 1); assert.match(f.host.textContent, /2 reported plays/); assert.match(f.host.textContent, /No plays reported/); assert.match(f.host.textContent, /Count unavailable/); assert.doesNotMatch(f.host.textContent, /1 reported plays/);
});
test('H23 actual native equal boundaries show undated remainder one and last-known source label', async t => {
  const f = await N.platform(t); await f.choose(H.history([])); const b = H.boundary(), patch = {first: b, last: b, timestamp_coverage: 'boundary_evidence', first_marker_weight: 1, aggregate_remainder: '1', first_sort_key: '10', grouped_sort_key: '10', remainder_sort_key: '10', show_remainder_count: false};
  f.wire.enqueue('/history/list', H.history([H.row(2, patch, 'first_boundary'), H.row(2, patch, 'unknown_dates_bucket')], {mode: 'individual'})); const mode = f.host.querySelectorAll('select')[2]; mode.value = 'individual'; f.change(mode); await H.settle();
  assert.equal(f.host.querySelectorAll('.foobar-history__count').length, 0); assert.match(f.host.textContent, /First-play boundary/); assert.match(f.host.textContent, /Undated aggregate remainder/); assert.match(f.host.textContent, /1 reported play/); assert.match(f.host.textContent, /Last-known listened time \(source boundary\)/); assert.match(f.host.textContent, /1970-01-01T00:00:00.000010Z/); assert.match(f.host.textContent, /not a timestamp for every play/);
});
test('H24 actual native raw unresolved and hostile source labels stay text without native actions', async t => {
  const f = await N.platform(t), raw = '<img src=x onerror=alert(1)>', b = H.boundary(null, 'local source time');
  await f.choose(H.history([H.row(1, {title: H.label(raw), last: b, timestamp_coverage: 'boundary_evidence'})])); assert.match(f.host.textContent, /<img src=x onerror=alert\(1\)>/); assert.equal(f.host.querySelector('img'), null); assert.match(f.host.textContent, /timezone or exact date unresolved/); assert.match(f.host.textContent, /Last.fm and Album Haven listening stay separate/);
  const row = f.host.querySelector('.foobar-history__row'); assert.equal(row.querySelector('button'), null); assert.equal(row.querySelector('[data-track-id]'), null); assert.equal(row.querySelector('[data-selection-key]'), null); assert.ok(f.wire.calls.every(x => ['/history/sources', '/history/list'].includes(x.route)));
});
test('H25 actual native manual older newer fallback works without IntersectionObserver and reports honest range', async t => {
  const f = await N.platform(t); assert.equal(f.c.IntersectionObserver, undefined); await f.choose();
  for (let n = 1; n <= 5; n++) {f.wire.enqueue('/history/list', H.page(n)); f.click(f.button('Load older')); await H.settle();}
  assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 100); assert.match(f.host.textContent, /Loaded pages 2–6/); assert.match(f.host.textContent, /total unknown/); assert.equal(f.button('Load newer').disabled, false);
  f.wire.enqueue('/history/list', H.page(0)); f.click(f.button('Load newer')); await H.settle(); assert.match(f.host.textContent, /Loaded pages 1–5/); assert.equal(f.button('Load newer').disabled, true);
});
test('H26 actual native anchors preserve measured retained row across append eviction and reverse reload', async t => {
  const f = await N.platform(t); await f.choose();
  f.scroller.scrollTop = 250; f.wire.enqueue('/history/list', H.page(1)); f.click(f.button('Load older')); await H.settle(); assert.equal(f.scroller.scrollTop, 250);
  for (let n = 2; n <= 4; n++) {f.wire.enqueue('/history/list', H.page(n)); f.click(f.button('Load older')); await H.settle();}
  f.scroller.scrollTop = 1250; f.wire.enqueue('/history/list', H.page(5)); f.click(f.button('Load older')); await H.settle(); assert.equal(f.scroller.scrollTop, 250);
  f.wire.enqueue('/history/list', H.page(0)); f.click(f.button('Load newer')); await H.settle(); assert.equal(f.scroller.scrollTop, 1250);
});
test('H27 actual native delayed automatic eviction honors rows visible when response arrives', async t => {
  const f = await N.platform(t); await f.choose(); for (let n = 1; n <= 4; n++) {f.wire.enqueue('/history/list', H.page(n)); f.click(f.button('Load older')); await H.settle();}
  const late = H.deferred(); f.wire.enqueue('/history/list', () => late.promise); f.scroll(4600); assert.equal(f.owner.controller.getSnapshot().status, 'loading'); f.scroll(0); late.resolve(H.response(H.page(5))); await H.settle(); assert.equal(f.owner.controller.getSnapshot().firstPage, 0); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 100); assert.equal(f.scroller.scrollTop, 0);
});
test('H28 actual native pagehide and marker mutation retire owners and clear visible rows', async t => {
  const f = await N.platform(t); await f.choose(); f.root.dataset.accountFoobarHistoryAllowed = 'false'; for (const observer of f.observers) if (observer.active) observer.callback([{type: 'attributes', target: f.root}]);
  assert.equal(f.owner.controller.getSnapshot().status, 'retired'); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 0); assert.equal(f.host.querySelectorAll('select').every(x => x.disabled), true); f.c.dispatchEvent(new f.c.Event('pagehide')); assert.equal(f.owner.controller.getSnapshot().status, 'retired');
});
test('H34 actual native last-only singleton stays an explicitly counted undated aggregate', async t => {
  const f = await N.platform(t); await f.choose(H.history([])); const b = H.boundary();
  f.wire.enqueue('/history/list', H.history([H.row(1, {total: '1', aggregate_remainder: '1', show_grouped_count: false, show_remainder_count: false, last: b, timestamp_coverage: 'boundary_evidence', grouped_sort_key: '10', remainder_sort_key: '10'}, 'unknown_dates_bucket')], {mode: 'individual'})); const mode = f.host.querySelectorAll('select')[2]; mode.value = 'individual'; f.change(mode); await H.settle();
  assert.match(f.host.textContent, /1 reported play/); assert.match(f.host.textContent, /Last-known listened time/); assert.match(f.host.textContent, /1970-01-01T00:00:00.000010Z/); assert.equal(f.host.querySelectorAll('.foobar-history__count').length, 0); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 1);
});
test('H41 actual native variable-height delayed append eviction reverse preserve response-time anchor', async t => {
  const f = await N.platform(t, {variable: true});
  const page = n => {const value = H.page(n); value.result.items.forEach(row => {row.projection.title = H.label('Record ' + Number(row.observation_ref.slice(-12)));}); return value;};
  await f.choose(page(0)); for (let n = 1; n <= 4; n++) {f.wire.enqueue('/history/list', page(n)); f.click(f.button('Load older')); await H.settle();}
  const rows = () => f.host.querySelectorAll('.foobar-history__row'), late = H.deferred(); f.scroller.scrollTop = 1500;
  f.wire.enqueue('/history/list', () => late.promise); f.click(f.button('Load older')); f.scroller.scrollTop = 1700;
  const anchor = rows().find(row => row.getBoundingClientRect().bottom > 0), title = anchor.querySelector('h4').textContent, before = anchor.getBoundingClientRect().top;
  late.resolve(H.response(page(5))); await H.settle(); let retained = rows().find(row => row.querySelector('h4').textContent === title); assert.ok(retained); assert.equal(retained.getBoundingClientRect().top, before);
  f.wire.enqueue('/history/list', page(0)); f.click(f.button('Load newer')); await H.settle(); retained = rows().find(row => row.querySelector('h4').textContent === title); assert.equal(retained.getBoundingClientRect().top, before);
  assert.equal(f.outer.scrollTop, 0); assert.equal(f.scroller, f.inner);
});
test('H42 actual native outer-overflow and document owners support scrolling and cleanup', async t => {
  for (const scrollOwner of ['outer', 'document']) {
    const f = await N.platform(t, {scrollOwner}); await f.choose(); f.wire.enqueue('/history/list', H.page(1)); f.scroll(650); await H.settle(); assert.equal(f.owner.controller.getSnapshot().lastPage, 1); assert.equal(f.inner.scrollTop, 0); assert.equal(f.scroller, scrollOwner === 'outer' ? f.outer : f.document.documentElement);
  }
});
test('H43 actual native hidden disconnected and unchanged scroll cannot start automatic reads', async t => {
  const f = await N.platform(t); await f.choose(); const count = f.wire.calls.length; f.scroll(0); assert.equal(f.wire.calls.length, count); f.host.setAttribute('hidden', ''); f.scroll(650); assert.equal(f.wire.calls.length, count); f.host.removeAttribute('hidden'); f.host.remove(); f.scroll(660); assert.equal(f.wire.calls.length, count);
});
test('H48 actual native delayed manual completion never steals external focus across retirement', async t => {
  const f = await N.platform(t); await f.choose(); const late = H.deferred(); f.wire.enqueue('/history/list', () => late.promise); f.button('Load older').focus(); f.click(f.button('Load older'));
  const outside = f.document.createElement('button'); f.document.body.append(outside); outside.focus(); f.owner.retire(); late.resolve(H.response(H.page(1))); await H.settle(); assert.equal(f.document.activeElement, outside); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 0);
});
test('H49 actual native pending manual request cannot restore body focus after retirement or query switch', async t => {
  for (const change of ['retire', 'family', 'mode', 'source']) {
    const f = await N.platform(t); if (change === 'source') {f.wire.enqueue('/history/sources', H.sources([H.source(), H.source(2)])); await f.owner.controller.loadSources();} await f.choose();
    const late = H.deferred(); f.wire.enqueue('/history/list', () => late.promise); f.button('Load older').focus(); f.click(f.button('Load older')); f.document.activeElement = f.document.body;
    if (change === 'retire') f.owner.retire();
    if (change === 'family') {f.wire.enqueue('/history/list', H.history([H.row(90, {family: 'enhanced'})], {family: 'enhanced'})); f.owner.controller.setFamily('enhanced');}
    if (change === 'mode') {f.wire.enqueue('/history/list', H.history([H.row(90, {}, 'unknown_dates_bucket')], {mode: 'individual'})); f.owner.controller.setMode('individual');}
    if (change === 'source') {f.wire.enqueue('/history/list', H.history([H.row(90)], {source_ref: H.id(2)})); f.owner.controller.selectSource(H.id(2));}
    await H.settle(); late.resolve(H.response(H.page(1))); await H.settle(); assert.equal(f.document.activeElement, f.document.body, change + ' cannot steal focus from body');
  }
});
