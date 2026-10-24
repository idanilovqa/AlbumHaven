'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const E = require('./foobar-enhanced-v4-fixture.cjs'), {F, H} = E;
const I = require('./foobar-account-import-native-fixture.cjs');
const N = require('./foobar-account-history-native-fixture.cjs');
const P = require('./foobar-account-history-play-fixture.cjs');
async function importReview(f, proposal = E.proposal()) {
  f.field('mapping').value = E.IMPORT_MAPPING; f.change(f.field('mapping')); await F.settle();
  return I.reviewed(f, {selected: E.file(), proposal});
}

test('EU01 genuine format field exposes explicit SQLite choice and disables Enhanced library matching', async t => {
  const f = await I.native(t, F.wire(), {library: '23'}), mapping = f.field('mapping');
  assert.deepEqual(mapping.querySelectorAll('option').map(node => node.value), [F.MAPPING, E.IMPORT_MAPPING]);
  assert.equal(mapping.disabled, false); mapping.value = E.IMPORT_MAPPING; f.change(mapping); await F.settle();
  assert.equal(f.field('file').accept, '.sqlite,.sqlite3,.db,application/vnd.sqlite3'); assert.equal(f.field('matching').disabled, false); assert.equal(f.field('matching').checked, false);
  assert.match(f.host.textContent, /finalized, self-contained artifact/); assert.match(f.host.textContent, /not a live database copy/); assert.match(f.host.textContent, /Optional exact-alias association/); assert.match(f.host.textContent, /never changes native ratings\/favourites or grants playback/);
  assert.equal(f.action('preview').disabled, true); assert.equal(f.wire.calls.length, 2);
});
test('EU02 genuine Enhanced review presents unavailable source evidence and no taste diagnostic claims', async t => {
  const f = await I.native(t); await importReview(f);
  const table = f.host.querySelectorAll('[role="table"]').find(node => node.textContent.includes('Accepted source records')); assert.ok(table);
  for (const label of ['Accepted source records', 'Records with a permitted library association', 'Ambiguous aliases or conflicting associations', 'Incoming records with unavailable, invalid or unsupported payloads', 'Native taste changes not attempted', 'Unchanged source records']) assert.ok(table.textContent.includes(label), label);
  assert.match(f.host.textContent, /not lifetime play counts, sessions, duration or full-album proof/); assert.match(f.host.textContent, /do not erase previously usable values/); assert.match(f.host.textContent, /Empty valid vectors are genuine corrections/); assert.match(f.host.textContent, /does not provide per-record diagnostic pages/);
  assert.equal(f.host.querySelector('.foobar-import__personal').hidden, true); assert.equal(f.action('savePersonal').disabled, true); assert.equal(f.action('nextProblems').disabled, true); assert.equal(f.action('nextConflicts').disabled, true);
  assert.equal(f.action('confirm').disabled, true); assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 0);
});
test('EU03 genuine Enhanced confirm requires checkbox and sends the same original File once', async t => {
  const f = await I.native(t), file = await importReview(f); f.click(f.action('confirm')); assert.equal(f.wire.calls.length, 4);
  f.field('confirmation').checked = true; f.change(f.field('confirmation')); f.wire.enqueue('/job/start', F.accepted(F.JOB, 'start'));
  f.click(f.action('confirm')); f.click(f.action('confirm')); await F.settle();
  assert.equal(f.wire.calls.filter(call => call.route === '/job/start').length, 1); assert.equal(f.wire.calls.at(-1).init.body, file); assert.equal(f.field('mapping').disabled, true); assert.equal(f.field('confirmation').checked, false);
});
test('EU04 genuine format change clears checkbox and old artifact while keeping exact field identities', async t => {
  const f = await I.native(t); await importReview(f); f.field('confirmation').checked = true; f.change(f.field('confirmation'));
  f.field('mapping').value = F.MAPPING; f.change(f.field('mapping')); await F.settle();
  assert.equal(f.field('confirmation').checked, false); assert.equal(f.field('file').value, ''); assert.equal(f.field('file').accept, '.tsv,text/tab-separated-values'); assert.equal(f.action('confirm').disabled, true); assert.equal(f.action('preview').disabled, true);
  assert.equal(f.wire.calls.length, 4); assert.match(f.host.textContent, /No file selected/);
});
test('EU05 genuine Enhanced restart recovery locks original format and explains temporary artifact lifetime', async t => {
  const f = await I.native(t); await I.recover(f, E.job({uncertain: true}));
  assert.equal(f.field('mapping').value, E.IMPORT_MAPPING); assert.equal(f.field('mapping').disabled, true); assert.equal(f.action('resume').disabled, true);
  assert.match(f.host.textContent, /Temporary SQLite uploads are not retained for restart recovery/); assert.match(f.host.textContent, /reselect the exact original file/); assert.equal(f.field('job-reference').value, F.JOBREF);
  f.choose(E.file()); await F.settle(); assert.equal(f.action('resume').disabled, false); assert.equal(f.field('matching').disabled, true);
});
test('EU06 genuine history controls select local entries explicitly with full precision and honest provenance', async t => {
  const f = await N.platform(t); await E.nativeSelected(f, E.history());
  assert.equal(E.field(f, 'Count family').value, 'local_entries'); assert.equal(E.field(f, 'View').value, 'individual');
  assert.match(f.host.textContent, /Chronological local entries \+ undated tail/); assert.match(f.host.textContent, /2026-10-23T00:00:00.1234567Z/); assert.match(f.host.textContent, /134371872001234567/);
  assert.match(f.host.textContent, /Vector position 1; position is not a stable event ID/); assert.match(f.host.textContent, /incomplete or seeded/); assert.match(f.host.textContent, /Cached Last.fm timestamps are excluded/);
  assert.equal(f.host.querySelector('.foobar-history__count'), null);
});
test('EU07 genuine grouped source records distinguish empty unavailable and reported vector size', async t => {
  const f = await N.platform(t), value = E.history([E.record(3, {entry: null, local_vector_count: '0'}), E.record(2, {entry: null, local_vector_count: null, local_provenance: null}), E.record(1, {entry: null, local_vector_count: '2'})], {view: 'records', ordering: 'source_record_identity'});
  await E.nativeSelected(f, value, 'grouped'); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 3);
  assert.match(f.host.textContent, /Source records \(not chronological\)/); assert.match(f.host.textContent, /0 reported local timestamp entries/); assert.match(f.host.textContent, /No usable local timestamp vector is available/); assert.match(f.host.textContent, /2 reported local timestamp entries/); assert.match(f.host.textContent, /not a lifetime play count/);
  assert.doesNotMatch(f.host.querySelector('.foobar-history__rows').textContent, /2026-10-23T/);
});
test('EU08 genuine unresolved Enhanced rows preserve huge raw integers without inventing dates or metadata', async t => {
  const f = await N.platform(t), raw = E.record(1, {label: '<img src=x onerror=alert(1)>', label_kind: 'source_record', entry: E.entry({raw_filetime_ticks: '18446744073709551615', unix_100ns: '18330299337709551615', state: 'unresolved', code: 'sentinel_like', iso_utc: null})});
  await E.nativeSelected(f, E.history([raw])); assert.equal(f.host.querySelector('img'), null); assert.match(f.host.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(f.host.textContent, /18446744073709551615/); assert.match(f.host.textContent, /Undated timestamp evidence/); assert.match(f.host.textContent, /resembles a sentinel/); assert.match(f.host.textContent, /track metadata is unavailable/);
  assert.doesNotMatch(f.host.querySelector('.foobar-history__rows').textContent, /1970-|2026-|Native title/);
});
test('EU09 genuine Enhanced rows never acquire native controls paths or lazy eligibility even in Home', async t => {
  const f = await P.platform(t); await E.nativeSelected(f);
  // Historical title retained. Home now has explicit lazy controls, but never
  // requests eligibility automatically or acquires a path from history rows.
  const rows = f.host.querySelectorAll('.foobar-history__row'); assert.equal(rows.length, 20); assert.ok(rows.every(row => row.querySelector('button') !== null));
  const row = f.owner.controller.getSnapshot().page.items[0]; await f.actions.play(row);
  assert.equal(f.nativeCalls().length, 0); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(row).canAttemptPlay, false);
  for (const value of [f.host.outerHTML, JSON.stringify(f.owner.controller.getSnapshot())]) assert.doesNotMatch(value, /data-track-id|data-track-path|data-selection-key|inventory-track|synthetic\/library-one|albumListeningIntent/);
});
test('EU10 genuine TSV native grant retires when switching to Enhanced local evidence', async t => {
  const f = await P.platform(t); await f.choose(); const old = f.row(); await f.check(); assert.equal(f.actions.state(old).canAttemptPlay, true);
  f.wire.enqueue('/history/enhanced', E.page(0, {mode: 'grouped'})); const family = E.field(f, 'Count family'); family.value = 'local_entries'; f.change(family); await F.settle();
  assert.equal(f.actions.state(old).canAttemptPlay, false); await f.actions.play(old); assert.equal(f.activations.length, 0); assert.equal(f.nativeCalls().length, 1);
  assert.ok(f.nativeButtons().every(button => button !== null && /Check playback match/.test(button.textContent)));
  assert.ok(f.owner.controller.getSnapshot().page.items.every(row => !f.actions.state(row).canAttemptPlay));
});
test('EU11 genuine Enhanced manual newer older controls cap rows and preserve measured scroll anchors', async t => {
  const f = await N.platform(t); await E.nativeSelected(f); assert.equal(f.c.IntersectionObserver, undefined);
  for (let n = 1; n < 5; n++) {f.wire.enqueue('/history/enhanced', E.page(n)); f.click(f.button('Load older')); await F.settle();}
  f.scroller.scrollTop = 1250; f.wire.enqueue('/history/enhanced', E.page(5)); f.click(f.button('Load older')); await F.settle();
  assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 100); assert.equal(f.scroller.scrollTop, 250); assert.match(f.host.textContent, /Loaded pages 2–6/); assert.equal(f.button('Load newer').disabled, false);
  f.wire.enqueue('/history/enhanced', E.page()); f.click(f.button('Load newer')); await F.settle(); assert.equal(f.scroller.scrollTop, 1250); assert.match(f.host.textContent, /Loaded pages 1–5/); assert.equal(f.button('Load newer').disabled, true);
});
test('EU12 genuine Enhanced delayed auto-eviction honors current visible rows and manual fallback', async t => {
  const f = await N.platform(t); await E.nativeSelected(f); for (let n = 1; n < 5; n++) {f.wire.enqueue('/history/enhanced', E.page(n)); f.click(f.button('Load older')); await F.settle();}
  const wait = F.deferred(); f.wire.enqueue('/history/enhanced', () => wait.promise); f.scroll(4600); assert.equal(f.owner.controller.getSnapshot().status, 'loading'); f.scroll(0);
  wait.resolve(F.response(E.page(5))); await F.settle(); assert.equal(f.owner.controller.getSnapshot().firstPage, 0); assert.equal(f.scroller.scrollTop, 0); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 100);
  f.wire.enqueue('/history/enhanced', E.page(5)); f.click(f.button('Load older')); await F.settle(); assert.equal(f.owner.controller.getSnapshot().firstPage, 1);
});
test('EU13 genuine Enhanced failure shows alert rather than source-confirmed end and refresh resets keyset', async t => {
  const f = await N.platform(t); await E.nativeSelected(f); f.wire.enqueue('/history/enhanced', () => Promise.reject(new TypeError('unavailable'))); f.click(f.button('Load older')); await F.settle();
  assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 0); assert.equal(f.host.querySelector('.foobar-history__status').getAttribute('role'), 'alert'); assert.doesNotMatch(f.host.textContent, /End confirmed by the source response/);
  f.wire.enqueue('/history/enhanced', E.page(0, {more: false})); f.click(f.button('Refresh selected source')); await F.settle();
  assert.equal(JSON.parse(f.wire.calls.at(-1).init.body).cursor, null); assert.match(f.host.textContent, /End confirmed by the source response/); assert.equal(f.button('Load older').disabled, true);
});
test('EU14 genuine Enhanced delayed manual read cannot steal focus or resurrect retired account rows', async t => {
  const f = await N.platform(t); await E.nativeSelected(f); const wait = F.deferred(); f.wire.enqueue('/history/enhanced', () => wait.promise); f.button('Load older').focus(); f.click(f.button('Load older'));
  const outside = f.document.createElement('button'); f.document.body.append(outside); outside.focus(); f.owner.retire(); wait.resolve(F.response(E.page(1))); await F.settle();
  assert.equal(f.document.activeElement, outside); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 0); assert.ok(f.host.querySelectorAll('select').every(node => node.disabled));
});
test('EU15 genuine Enhanced variable-height response-time anchor survives delayed append and reverse', async t => {
  const f = await N.platform(t, {variable: true}); await E.nativeSelected(f); for (let n = 1; n < 5; n++) {f.wire.enqueue('/history/enhanced', E.page(n)); f.click(f.button('Load older')); await F.settle();}
  const rows = () => f.host.querySelectorAll('.foobar-history__row'), wait = F.deferred(); f.scroller.scrollTop = 1500;
  f.wire.enqueue('/history/enhanced', () => wait.promise); f.click(f.button('Load older')); f.scroller.scrollTop = 1700;
  const anchor = rows().find(row => row.getBoundingClientRect().bottom > 0), label = anchor.querySelector('h4').textContent, before = anchor.getBoundingClientRect().top;
  wait.resolve(F.response(E.page(5))); await F.settle(); assert.equal(rows().find(row => row.querySelector('h4').textContent === label).getBoundingClientRect().top, before);
  f.wire.enqueue('/history/enhanced', E.page()); f.click(f.button('Load newer')); await F.settle(); assert.equal(rows().find(row => row.querySelector('h4').textContent === label).getBoundingClientRect().top, before);
});
