'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const M = require('./foobar-enhanced-consumers-fixture.cjs'), {E, F, P, N} = M;

test('EN01 actual Enhanced entry native request preserves original observation revision and current page revision', async t => {
  const f = await P.platform(t); await M.selected(f); await f.check(); await f.play();
  assert.equal(f.row().enhanced.observation_revision, '3'); assert.equal(f.row().projection, undefined);
  assert.deepEqual(f.nativeCalls().map(call => call.route), ['/history/native/eligibility', '/history/native/play']);
  for (const call of f.nativeCalls()) {
    assert.deepEqual(JSON.parse(call.init.body), {version: P.VERSION, source_ref: F.SOURCE, source_revision: '8', observations: [[f.row().observation_ref, '3']]});
    const headers = new Headers(call.init.headers); assert.equal(headers.get('X-AlbumHaven-Context'), P.NATIVE_CONTEXT);
    assert.equal(headers.get('X-Album-Haven-CSRF'), 'synthetic-csrf'); assert.equal(headers.get('X-AlbumHaven-Foobar-Context'), null);
    assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.cache, 'no-store'); assert.equal(call.init.method, 'POST');
    assert.doesNotMatch(call.init.body, /path|library|ordinal|FILETIME|iso_utc|inventory|rating|favorite/);
  }
});
test('EN02 actual Enhanced grouped header native request uses original revision without requiring a local entry', async t => {
  const f = await P.platform(t); await M.selected(f, 'grouped'); assert.equal(f.row().enhanced.entry, null);
  await f.check(); await f.play(); assert.equal(f.activations.length, 1);
  for (const call of f.nativeCalls()) assert.deepEqual(JSON.parse(call.init.body), {version: P.VERSION, source_ref: F.SOURCE, source_revision: '8', observations: [[f.row().observation_ref, '3']]});
  assert.match(f.host.textContent, /Source records \(not chronological\)/); M.noPublicTarget(f);
});
test('EN03 genuine Enhanced native buttons require separate explicit eligibility and Play clicks', async t => {
  const f = await P.platform(t); await M.selected(f); const button = f.nativeButtons()[0];
  assert.equal(button.disabled, false); assert.match(button.textContent, /Check playback match/); assert.equal(f.nativeCalls().length, 0);
  await f.actions.play(f.row()); assert.equal(f.nativeCalls().length, 0);
  f.wire.enqueue('/history/native/eligibility', f.eligible()); f.click(button); await P.settle();
  assert.equal(f.activations.length, 0); assert.equal(f.nativeButtons()[0], button); assert.match(button.textContent, /Check and play matched track/);
  f.wire.enqueue('/history/native/play', P.envelope('play', P.target())); f.click(button); await P.settle();
  assert.equal(f.activations.length, 1); assert.equal(f.nativeCalls().length, 2); assert.match(button.textContent, /Check playback match/);
});
test('EN04 Enhanced negative eligibility and native media denial never imply playable file availability', async t => {
  const f = await P.platform(t); await M.selected(f); await f.check(f.row(), false); await f.actions.play(f.row());
  assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0); assert.match(f.host.textContent, /No permitted native playback attempt/);
  await f.check(); f.media(false); await f.play(); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(f.row()).canAttemptPlay, false);
  assert.match(f.host.textContent, /Actual file availability is checked on that click/);
});
test('EN05 Enhanced private Play keeps nullable metadata through the genuine lexical dispatcher', async t => {
  const f = await P.platform(t); await M.selected(f); await f.check(); await f.play(P.target({title: null, artist: null, album_title: null, duration_seconds: null}));
  assert.equal(f.activations.length, 1); const {button, options} = f.activations[0]; assert.equal(button.isConnected, false); assert.deepEqual(options, {focusTimeline: true});
  assert.equal(button.getAttribute('data-track-title'), ''); assert.equal(button.getAttribute('data-track-artist'), ''); assert.equal(button.getAttribute('data-track-album'), ''); assert.equal(button.getAttribute('data-track-duration-seconds'), 'null');
  assert.equal(f.c.TrackActionsRuntime, undefined); assert.equal(typeof f.nativeTracks.play, 'function'); M.noPublicTarget(f);
});
test('EN06 Enhanced native eligibility and private Play never mutate public history or leak paths into DOM', async t => {
  const f = await P.platform(t); await M.selected(f); const before = JSON.stringify(f.owner.controller.getSnapshot()), row = f.row();
  await f.check(); M.noPublicTarget(f); await f.play(); M.noPublicTarget(f);
  assert.equal(JSON.stringify(f.owner.controller.getSnapshot()), before); assert.equal(f.row(), row);
  assert.deepEqual(Object.keys(f.actions.state(row)).sort(), ['busy', 'canAttemptPlay', 'notice']);
  assert.equal(row.enhanced.entry.iso_utc, E.ISO); assert.equal(row.enhanced.entry.raw_filetime_ticks, E.RAW);
});
test('EN07 Enhanced empty and unavailable grouped headers remain readable with only lazy potential eligibility', async t => {
  for (const count of ['0', null]) {
    const f = await P.platform(t), value = E.history([E.record(9, {observation_revision: '3', entry: null, local_vector_count: count, local_provenance: count === null ? null : 'incomplete_possibly_seeded'})], {source_revision: '8', view: 'records', ordering: 'source_record_identity'});
    await M.selected(f, 'grouped', value); assert.equal(f.nativeCalls().length, 0); assert.equal(f.nativeButtons().length, 1);
    assert.match(f.host.textContent, count === null ? /No usable local timestamp vector/ : /0 reported local timestamp entries/);
    await f.check(); assert.equal(f.actions.state(f.row()).canAttemptPlay, true); assert.equal(f.activations.length, 0); assert.equal(f.row().enhanced.entry, null);
  }
});
test('EN08 Enhanced equal-time entries share observation proof but never share retained row grants', async t => {
  const f = await P.platform(t), rows = [1, 0].map(ordinal => E.record(9, {observation_revision: '3', local_vector_count: '2', entry: E.entry({ordinal})}));
  await M.selected(f, 'individual', E.history(rows, {source_revision: '8'})); const first = f.row(), second = f.row(1);
  await f.check(first); assert.equal(f.actions.state(first).canAttemptPlay, true); assert.equal(f.actions.state(second).canAttemptPlay, false);
  await f.check(second); assert.equal(f.actions.state(first).canAttemptPlay, false); assert.equal(f.actions.state(second).canAttemptPlay, true);
  assert.deepEqual(JSON.parse(f.nativeCalls()[0].init.body), JSON.parse(f.nativeCalls()[1].init.body));
  await f.actions.play(first); assert.equal(f.nativeCalls().length, 2); assert.equal(f.activations.length, 0);
});
test('EN09 Enhanced selected-library change retires native grant without destroying account history', async t => {
  const f = await P.platform(t); await M.selected(f); const page = f.owner.controller.getSnapshot().page; await f.check();
  f.shell.dataset.nativeLibraryId = '2'; assert.equal(f.actions.state(f.row()).canAttemptPlay, false); await f.actions.play(f.row());
  assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0); assert.equal(f.owner.controller.getSnapshot().page, page); assert.equal(f.owner.controller.getSnapshot().status, 'ready');
  assert.match(f.host.textContent, /2026-10-23T00:00:00.1234567Z/);
});
test('EN10 Enhanced account retirement clears imported rows and revokes old native controls', async t => {
  const f = await P.platform(t); await M.selected(f); const row = f.row(), button = f.nativeButtons()[0]; await f.check(); f.owner.retire();
  assert.equal(f.actions.state(row).canAttemptPlay, false); assert.equal(f.owner.controller.getSnapshot().status, 'retired'); assert.equal(f.owner.controller.getSnapshot().page, null);
  assert.equal(button.isConnected, false); assert.equal(button.listeners.length, 0); f.click(button); await f.actions.play(row);
  assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 0);
});
test('EN11 Enhanced source family mode and revision replacement invalidate original row grants', async t => {
  for (const change of ['source', 'family', 'mode', 'revision']) {
    const f = await P.platform(t);
    if (change === 'source') {f.wire.enqueue('/history/sources', P.sources([P.source(), P.source(2)])); await f.owner.controller.loadSources();}
    await M.selected(f); const row = f.row(); await f.check();
    if (change === 'source') {f.wire.enqueue('/history/enhanced', M.history('individual', {source_ref: P.id(2)})); f.owner.controller.selectSource(P.id(2));}
    if (change === 'family') {f.wire.enqueue('/history/list', P.page(0, {mode: 'individual'})); f.owner.controller.setFamily('standard');}
    if (change === 'mode') {f.wire.enqueue('/history/enhanced', M.history('grouped')); f.owner.controller.setMode('grouped');}
    if (change === 'revision') {f.wire.enqueue('/history/enhanced', M.history('individual', {source_revision: '9'})); await f.owner.controller.loadHistory();}
    await P.settle(); assert.equal(f.actions.state(row).canAttemptPlay, false); await f.actions.play(row);
    assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0); assert.equal(f.owner.controller.getSnapshot().status, 'ready');
  }
});
test('EN12 Enhanced delayed eligibility after selected-library drift cannot create a grant', async t => {
  const f = await P.platform(t); await M.selected(f); const row = f.row(), late = P.deferred(), page = f.owner.controller.getSnapshot().page;
  f.wire.enqueue('/history/native/eligibility', () => late.promise); const work = f.actions.check(row); f.shell.dataset.nativeLibraryId = '2';
  late.resolve(P.response(f.eligible(row))); await work; assert.equal(f.actions.state(row).canAttemptPlay, false); assert.equal(f.actions.state(row).busy, false);
  assert.equal(f.owner.controller.getSnapshot().page, page); assert.equal(f.activations.length, 0); assert.equal(f.nativeCalls().length, 1);
});
test('EN13 Enhanced delayed private Play after account library or native generation retirement stays inert', async t => {
  for (const change of [f => f.owner.retire(), f => {f.shell.dataset.nativeLibraryId = '2';}, f => f.transport.invalidate(), f => {f.root.dataset.accountFoobarContext = 'e'.repeat(64);}]) {
    const f = await P.platform(t); await M.selected(f); const row = f.row(); await f.check(); const late = P.deferred();
    f.wire.enqueue('/history/native/play', () => late.promise); const work = f.actions.play(row); change(f);
    late.resolve(P.response(P.envelope('play', P.target()))); await work;
    assert.equal(f.activations.length, 0); assert.equal(f.actions.state(row).canAttemptPlay, false); assert.equal(f.nativeCalls().length, 2);
  }
});
test('EN14 Enhanced eviction discards old native row eligibility without growing the rendered window', async t => {
  const f = await P.platform(t); await M.selected(f, 'individual', E.page()); const row = f.row(); await f.check();
  for (let n = 1; n <= 5; n++) {f.wire.enqueue('/history/enhanced', E.page(n)); await f.owner.controller.loadHistory({next: true});}
  assert.equal(f.owner.controller.getSnapshot().page.items.includes(row), false); assert.equal(f.owner.controller.getSnapshot().pages.length, 5); assert.equal(f.nativeButtons().length, 100);
  await f.actions.check(row); await f.actions.play(row); assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0);
});
test('EN15 standalone Enhanced entry and grouped evidence stay readable without native shell or controls', async t => {
  // The genuine side-effect entry owns its controller privately and imports
  // once. Drive both views on one mount instead of dereferencing a hidden owner
  // or expecting a cached entry module to initialize a second synthetic page.
  const f = await N.platform(t, {entry: true}); assert.equal(f.owner, undefined);
  const family = E.field(f, 'Count family'); family.value = 'local_entries'; f.change(family);
  for (const mode of ['individual', 'grouped']) {
    const before = f.wire.calls.length; f.wire.enqueue('/history/enhanced', M.history(mode));
    const view = E.field(f, 'View'); view.value = mode; f.change(view);
    if (mode === 'individual') {const source = E.field(f, 'Account source'); source.value = F.SOURCE; f.change(source);}
    await F.settle(); assert.equal(f.wire.calls.length, before + 1);
    const request = f.wire.calls.at(-1); assert.equal(request.route, '/history/enhanced');
    assert.deepEqual(JSON.parse(request.init.body), {version: E.HISTORY, source_ref: F.SOURCE, view: mode === 'individual' ? 'entries' : 'records', cursor: null});
    assert.equal(request.init.method, 'POST'); assert.equal(request.init.credentials, 'same-origin'); assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.headers['X-AlbumHaven-Foobar-Context'], F.STAMP); assert.equal(request.init.headers['X-AlbumHaven-Context'], undefined);
    assert.equal(E.field(f, 'Count family').value, 'local_entries'); assert.equal(E.field(f, 'View').value, mode); assert.equal(E.field(f, 'Account source').value, F.SOURCE);
    const rows = f.host.querySelectorAll('.foobar-history__row'); assert.equal(rows.length, 1); assert.equal(rows[0].querySelector('h4').textContent, 'Source file 9');
    assert.equal(rows[0].querySelector('button'), null); assert.match(rows[0].textContent, /Original filename label, not resolved library metadata/);
    assert.match(rows[0].textContent, /Cached Last.fm timestamps are excluded/); assert.match(rows[0].textContent, /incomplete or seeded/);
    if (mode === 'individual') {assert.ok(rows[0].textContent.includes(E.ISO)); assert.ok(rows[0].textContent.includes(E.RAW)); assert.match(rows[0].textContent, /Vector position 2/);}
    else {assert.match(rows[0].textContent, /2 reported local timestamp entries/); assert.match(rows[0].textContent, /not a lifetime play count/); assert.doesNotMatch(rows[0].textContent, /2026-10-23T|Original FILETIME ticks/);}
    assert.equal(f.host.querySelector('.foobar-history__status').getAttribute('role'), 'status');
    assert.equal(f.document.getElementById('app-shell'), null); assert.equal(f.c.AlbumHavenPrivateUITransport, undefined); assert.equal(f.c.AlbumHavenTrackPlayback, undefined);
    assert.ok(f.wire.calls.every(call => ['/history/sources', '/history/enhanced'].includes(call.route))); assert.match(f.host.textContent, /Display only/);
    assert.doesNotMatch(f.host.outerHTML, /data-track-path|data-inventory-track-ref|data-src|synthetic\/library-one|albumListeningIntent/);
  }
  assert.equal(f.wire.calls.length, 3); assert.equal(f.wire.remaining(), 0);
});
test('EN16 Enhanced pending eligibility disables every real row control and prevents duplicate click requests', async t => {
  const f = await P.platform(t); await M.selected(f, 'individual', E.page()); const row = f.row(), late = P.deferred();
  f.wire.enqueue('/history/native/eligibility', () => late.promise); f.click(f.nativeButtons()[0]);
  assert.ok(f.nativeButtons().every(button => button.disabled)); for (const button of f.nativeButtons()) f.click(button); assert.equal(f.nativeCalls().length, 1);
  late.resolve(P.response(f.eligible(row))); await P.settle(); assert.ok(f.nativeButtons().every(button => !button.disabled)); assert.equal(f.activations.length, 0);
});
test('EN17 Enhanced native repaint preserves focused row and measured scroll without leaked path attributes', async t => {
  const f = await P.platform(t); await M.selected(f, 'individual', E.page()); f.scroller.scrollTop = 250; const old = f.nativeButtons()[5]; old.focus();
  f.wire.enqueue('/history/enhanced', E.page(1)); await f.owner.controller.loadHistory({next: true}); const current = f.nativeButtons()[5];
  assert.notEqual(current, old); assert.equal(f.document.activeElement, current); assert.equal(f.scroller.scrollTop, 250); assert.equal(old.listeners.length, 0); assert.equal(old.isConnected, false);
  f.click(old); assert.equal(f.nativeCalls().length, 0); M.noPublicTarget(f);
});
test('EN18 Enhanced genuine native capability check cannot dispatch after changing selected library', async t => {
  const f = await P.platform(t); await M.selected(f); await f.check(); let checks = 0;
  f.capabilityHook(action => {assert.equal(action, 'library.media.read'); checks++; f.shell.dataset.nativeLibraryId = '2';}); await f.play();
  assert.equal(checks, 1); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(f.row()).canAttemptPlay, false);
});
test('EN19 Enhanced malformed eligibility cannot inject native targets or substitute an observation', async t => {
  const f = await P.platform(t); await M.selected(f); const valid = f.eligible();
  for (const value of [{...valid, context_ref: F.STAMP}, {...valid, result: [{observation_ref: P.id(8), can_attempt_play: true}]},
    {...valid, result: [{observation_ref: f.row().observation_ref, can_attempt_play: true, path: '/synthetic/foreign.flac'}]},
    {...valid, result: [{observation_ref: f.row().observation_ref, can_attempt_play: 'true'}]}]) {
    f.wire.enqueue('/history/native/eligibility', value); await f.actions.check(f.row()); await f.actions.play(f.row());
    assert.equal(f.actions.state(f.row()).canAttemptPlay, false); assert.equal(f.activations.length, 0); M.noPublicTarget(f);
  }
});
test('EN20 Enhanced malformed private target consumes grant without bypassing native target validation', async t => {
  const f = await P.platform(t); await M.selected(f);
  for (const value of [P.target({path: '/synthetic/different.flac'}), P.target({inventory_track_ref: 'inventory-track:2:9'}), P.target({duration_seconds: '1'}), P.target({playback_state: {can_start_here: false}})]) {
    await f.check(); await f.play(value); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(f.row()).canAttemptPlay, false); M.noPublicTarget(f);
  }
});
