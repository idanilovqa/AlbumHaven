'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const P = require('./foobar-account-history-play-fixture.cjs');

test('HP01 actual native adapter remains lazy until explicit check and explicit Play', async t => {
  const f = await P.platform(t); assert.equal(f.nativeCalls().length, 0); await f.choose();
  assert.equal(f.nativeCalls().length, 0); const item = f.row(); await f.actions.play(item);
  assert.equal(f.nativeCalls().length, 0); await f.check(item);
  assert.equal(f.activations.length, 0); assert.equal(f.actions.state(item).canAttemptPlay, true);
  await f.play(); assert.equal(f.nativeCalls().length, 2); assert.equal(f.activations.length, 1);
  assert.equal(f.actions.state(item).canAttemptPlay, false);
});
test('HP02 genuine transport sends source proof with native context and actual CSRF wrapper', async t => {
  const f = await P.platform(t); await f.choose(P.history([P.row(9, {source_revision: '3'})], {source_revision: '8'}));
  await f.check(); await f.play();
  for (const call of f.nativeCalls()) {
    assert.equal(call.init.method, 'POST'); assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.cache, 'no-store');
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('X-AlbumHaven-Context'), P.NATIVE_CONTEXT); assert.notEqual(headers.get('X-AlbumHaven-Context'), P.STAMP);
    assert.equal(headers.get('X-AlbumHaven-Foobar-Context'), null); assert.equal(headers.get('X-Album-Haven-CSRF'), 'synthetic-csrf');
    assert.equal(headers.get('Content-Type'), 'application/json'); assert.ok(call.init.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(call.init.body), {version: P.VERSION, source_ref: P.SOURCE, source_revision: '8', observations: [[f.row().observation_ref, '3']]});
    assert.doesNotMatch(call.init.body, /library|inventory|track_ref|path|title|can_start_here/);
  }
  assert.deepEqual(f.nativeCalls().map(call => call.route), ['/history/native/eligibility', '/history/native/play']);
});
test('HP03 actual lexical dispatcher consumes private target through detached activation boundary', async t => {
  const f = await P.platform(t); await f.choose(); await f.check(); const value = P.target(); await f.play(value);
  const {button, options} = f.activations[0]; assert.deepEqual(options, {focusTimeline: true});
  assert.equal(button.getAttribute('data-track-path'), value.path); assert.equal(button.getAttribute('data-src'), '/track?path=' + encodeURIComponent(value.path));
  assert.equal(button.getAttribute('data-inventory-track-ref'), value.inventory_track_ref);
  assert.equal(button.getAttribute('data-track-title'), value.title); assert.equal(button.getAttribute('data-track-artist'), value.artist);
  assert.equal(button.getAttribute('data-track-album'), value.album_title); assert.equal(button.getAttribute('data-track-duration-seconds'), '123.5');
  assert.equal(f.c.TrackActionsRuntime, undefined); assert.equal(typeof f.nativeTracks.play, 'function');
});
test('HP04 nullable title artist album and duration retain genuine dispatcher fallback', async t => {
  const f = await P.platform(t); await f.choose();
  for (const key of ['title', 'artist', 'album_title', 'duration_seconds']) {
    await f.check(); await f.play(P.target({[key]: null})); assert.equal(f.activations.length, ['title', 'artist', 'album_title', 'duration_seconds'].indexOf(key) + 1);
    const attribute = {title: 'data-track-title', artist: 'data-track-artist', album_title: 'data-track-album', duration_seconds: 'data-track-duration-seconds'}[key];
    assert.equal(f.activations.at(-1).button.getAttribute(attribute), key === 'duration_seconds' ? 'null' : '');
  }
  await f.check(); await f.play(P.target({title: null, artist: null, album_title: null, duration_seconds: null}));
  assert.equal(f.activations.length, 5); assert.equal(f.actions.state(f.row()).canAttemptPlay, false);
});
test('HP05 malformed private target fields never reach the native dispatcher', async t => {
  const f = await P.platform(t); await f.choose();
  const invalid = [null, {}, {...P.target(), extra: true}, P.target({path: '/other.flac'}), P.target({track_ref: ''}), P.target({path: null}),
    P.target({title: 3}), P.target({artist: []}), P.target({album_title: {}}), P.target({duration_seconds: '12'}),
    P.target({duration_seconds: -1}), P.target({duration_seconds: 1e30}), P.target({inventory_track_ref: 'inventory-track:2:9'}),
    P.target({inventory_track_ref: 'inventory-track:1:0'}), P.target({playback_state: {can_start_here: false}}), P.target({playback_state: {can_start_here: true, extra: true}}),
    P.target({title: 'x\nunsafe'}), P.target({artist: '\ud800'}), P.target({album_title: 'é'.repeat(2049)})];
  for (const value of invalid) {await f.check(); await f.play(value); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(f.row()).canAttemptPlay, false);}
});
test('HP06 nonfinite duration decoded by genuine transport is rejected rather than silently coerced', async t => {
  const f = await P.platform(t); await f.choose();
  for (const value of ['NaN', '1e999', '-1e999']) {
    const raw = JSON.stringify(P.envelope('play', P.target())).replace('"duration_seconds":123.5', '"duration_seconds":' + value);
    await f.check(); f.wire.enqueue('/history/native/play', () => Promise.resolve(new Response(raw, {headers: {'Content-Type': 'application/json'}})));
    await f.actions.play(f.row()); assert.equal(f.activations.length, 0); assert.match(f.actions.state(f.row()).notice, /unavailable/i);
  }
});
test('HP07 eligibility requires exact boolean original row and native envelope', async t => {
  const f = await P.platform(t); await f.choose(); const item = f.row(), valid = f.eligible(item);
  const invalid = [{...valid, protocol: P.VERSION + '-other'}, {...valid, operation: 'play'}, {...valid, extra: true}, {...valid, result: []},
    {...valid, result: [{observation_ref: item.observation_ref, can_attempt_play: 1}]},
    {...valid, result: [{observation_ref: P.id(8), can_attempt_play: true}]},
    {...valid, result: [{observation_ref: item.observation_ref, can_attempt_play: true, path: '/synthetic/no.flac'}]},
    {...valid, result: [...valid.result, ...valid.result]}];
  for (const value of invalid) {f.wire.enqueue('/history/native/eligibility', value); await f.actions.check(item); assert.equal(f.actions.state(item).canAttemptPlay, false); await f.actions.play(item);}
  assert.equal(f.nativeCalls().length, invalid.length); assert.equal(f.activations.length, 0);
});
test('HP08 negative eligibility and media denial do not imply physical availability', async t => {
  const f = await P.platform(t); await f.choose(); await f.check(f.row(), false); await f.actions.play(f.row());
  assert.equal(f.nativeCalls().length, 1); assert.match(f.actions.state(f.row()).notice, /No permitted native/);
  await f.check(); f.media(false); await f.play(); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(f.row()).canAttemptPlay, false);
});
test('HP09 same account different library invalidates grant while history stays readable', async t => {
  const f = await P.platform(t); await f.choose(); const page = f.owner.controller.getSnapshot().page; await f.check();
  f.shell.dataset.nativeLibraryId = '2'; assert.equal(f.actions.state(f.row()).canAttemptPlay, false); await f.actions.play(f.row());
  assert.equal(f.nativeCalls().length, 1); assert.equal(f.owner.controller.getSnapshot().page, page); assert.equal(f.root.dataset.accountFoobarContext, P.STAMP);
  assert.equal(f.owner.controller.getSnapshot().status, 'ready'); assert.equal(f.host.querySelectorAll('.foobar-history__row').length, 20);
});
test('HP10 native context and generation independently retire grant without clearing account rows', async t => {
  for (const change of ['context', 'generation']) {
    const f = await P.platform(t); await f.choose(); const page = f.owner.controller.getSnapshot().page; await f.check();
    if (change === 'context') {f.shell.dataset.privateUiContext = 'd'.repeat(64); f.transport.generation();} else f.transport.invalidate();
    assert.equal(f.actions.state(f.row()).canAttemptPlay, false); await f.actions.play(f.row()); assert.equal(f.nativeCalls().length, 1);
    assert.equal(f.owner.controller.getSnapshot().page, page); assert.equal(f.activations.length, 0);
  }
});
test('HP11 native actor account markers disconnected and view owner invalidate grants', async t => {
  for (const change of [f => {f.shell.dataset.nativeAccountId = 'other-owner';}, f => {f.root.dataset.accountFoobarContext = 'e'.repeat(64);},
    f => {f.root.dataset.accountFoobarScope = 'not-account';}, f => {f.root.dataset.accountFoobarHistoryAllowed = 'false';}, f => f.current(false), f => f.host.remove()]) {
    const f = await P.platform(t); await f.choose(); await f.check(); change(f); assert.equal(f.actions.state(f.row()).canAttemptPlay, false);
    await f.actions.play(f.row()); assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0);
  }
});
test('HP12 selected source family mode refresh revision and retirement all invalidate native eligibility', async t => {
  for (const change of ['source', 'family', 'mode', 'refresh', 'revision', 'retire']) {
    const f = await P.platform(t); if (change === 'source') {f.wire.enqueue('/history/sources', P.sources([P.source(), P.source(2)])); await f.owner.controller.loadSources();}
    await f.choose(); const item = f.row(); await f.check(item);
    if (change === 'source') {f.wire.enqueue('/history/list', P.history([P.row(9)], {source_ref: P.id(2)})); f.owner.controller.selectSource(P.id(2));}
    if (change === 'family') {f.wire.enqueue('/history/list', P.page(0, {family: 'enhanced'})); f.owner.controller.setFamily('enhanced');}
    if (change === 'mode') {f.wire.enqueue('/history/list', P.page(0, {mode: 'individual'})); f.owner.controller.setMode('individual');}
    if (change === 'refresh' || change === 'revision') {f.wire.enqueue('/history/list', P.page(0, {revision: change === 'revision' ? '2' : '1'})); await f.owner.controller.loadHistory();}
    if (change === 'retire') f.owner.retire();
    await P.settle(); assert.equal(f.actions.state(item).canAttemptPlay, false); await f.actions.play(item); assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0);
  }
});
test('HP13 evicted observation loses eligibility and stale row objects cannot be checked', async t => {
  const f = await P.platform(t); await f.choose(); const item = f.row(); await f.check(item);
  for (let n = 1; n <= 5; n++) {f.wire.enqueue('/history/list', P.page(n)); await f.owner.controller.loadHistory({next: true});}
  assert.equal(f.owner.controller.getSnapshot().page.items.includes(item), false); assert.equal(f.actions.state(item).canAttemptPlay, false);
  await f.actions.check(item); await f.actions.play(item); assert.equal(f.nativeCalls().length, 1); assert.equal(f.activations.length, 0);
});
test('HP14 late eligibility after same-account library change cannot create a grant', async t => {
  const f = await P.platform(t); await f.choose(); const late = P.deferred(), item = f.row(); f.wire.enqueue('/history/native/eligibility', () => late.promise);
  const work = f.actions.check(item); f.shell.dataset.nativeLibraryId = '2'; late.resolve(P.response(f.eligible(item))); await work;
  assert.equal(f.actions.state(item).canAttemptPlay, false); assert.equal(f.actions.state(item).busy, false); assert.equal(f.activations.length, 0);
});
test('HP15 late private Play response after library context view and controller changes never dispatches', async t => {
  for (const change of [f => {f.shell.dataset.nativeLibraryId = '2';}, f => {f.shell.dataset.privateUiContext = 'd'.repeat(64);}, f => f.current(false), f => f.owner.retire()]) {
    const f = await P.platform(t); await f.choose(); const item = f.row(); await f.check(); const late = P.deferred();
    f.wire.enqueue('/history/native/play', () => late.promise); const work = f.actions.play(item); change(f);
    late.resolve(P.response(P.envelope('play', P.target()))); await work; assert.equal(f.activations.length, 0); assert.equal(f.actions.state(item).canAttemptPlay, false);
  }
});
test('HP16 genuine canPlay capability hook changing context is fenced before native dispatch', async t => {
  const f = await P.platform(t); await f.choose(); await f.check(); let checks = 0;
  f.capabilityHook(action => {assert.equal(action, 'library.media.read'); checks++; f.shell.dataset.nativeLibraryId = '2';});
  await f.play(); assert.equal(checks, 1); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(f.row()).canAttemptPlay, false);
});
test('HP17 lost acknowledgement and HTTP failures consume grant with no automatic redispatch', async t => {
  const f = await P.platform(t); await f.choose();
  for (const response of [() => Promise.reject(new TypeError('lost synthetic acknowledgement')), () => Promise.resolve(P.response({error: 'forbidden'}, 403)),
    () => Promise.resolve({ok: true, status: 200, json: async () => {throw new SyntaxError('lost body');}})]) {
    await f.check(); f.wire.enqueue('/history/native/play', response); await f.actions.play(f.row()); const count = f.nativeCalls().length;
    await P.settle(); await f.actions.play(f.row()); assert.equal(f.nativeCalls().length, count); assert.equal(f.activations.length, 0); assert.equal(f.actions.state(f.row()).canAttemptPlay, false);
  }
});
test('HP18 one retained grant and one pending owner supersede older deferred checks', async t => {
  const f = await P.platform(t); await f.choose(); const first = f.row(), second = f.row(1), late = P.deferred();
  await f.check(first); await f.check(second); assert.equal(f.actions.state(first).canAttemptPlay, false); assert.equal(f.actions.state(second).canAttemptPlay, true);
  f.wire.enqueue('/history/native/eligibility', () => late.promise); const work = f.actions.check(first), signal = f.nativeCalls().at(-1).init.signal;
  assert.equal(f.actions.state(first).busy, true); assert.equal(f.actions.state(second).busy, true); assert.equal(f.actions.state(second).canAttemptPlay, false);
  await f.check(second); assert.equal(signal.aborted, true); late.resolve(P.response(f.eligible(first))); await work;
  assert.equal(f.actions.state(first).canAttemptPlay, false); assert.equal(f.actions.state(second).canAttemptPlay, true); assert.equal(f.actions.state(first).busy, false);
});
test('HP19 double Play while acknowledgement is pending cannot enqueue or replay an action', async t => {
  const f = await P.platform(t); await f.choose(); await f.check(); const late = P.deferred(); f.wire.enqueue('/history/native/play', () => late.promise);
  const work = f.actions.play(f.row()); await f.actions.play(f.row()); assert.equal(f.nativeCalls().length, 2);
  late.resolve(P.response(P.envelope('play', P.target()))); await work; await f.actions.play(f.row());
  assert.equal(f.activations.length, 1); assert.equal(f.nativeCalls().length, 2);
});
test('HP20 disposed adapter aborts pending work and late target cannot publish or dispatch', async t => {
  const f = await P.platform(t); await f.choose(); await f.check(); const item = f.row(), late = P.deferred(); let notices = 0;
  f.actions.subscribe(() => notices++); f.wire.enqueue('/history/native/play', () => late.promise); const work = f.actions.play(item);
  const signal = f.nativeCalls().at(-1).init.signal; f.view.dispose(); const afterDispose = notices;
  assert.equal(signal.aborted, true); late.resolve(P.response(P.envelope('play', P.target()))); await work;
  f.transport.invalidate(); assert.equal(notices, afterDispose); assert.equal(f.activations.length, 0); assert.equal(f.host.childNodes.length, 0);
});
test('HP21 malformed or account-only context response cannot authorize native playback', async t => {
  for (const context of [P.STAMP, 'x', '', null]) {
    const f = await P.platform(t); await f.choose(); f.wire.enqueue('/history/native/eligibility', f.eligible(f.row(), true, context));
    await f.actions.check(f.row()); assert.equal(f.actions.state(f.row()).canAttemptPlay, false); assert.equal(f.activations.length, 0);
  }
});
test('HP22 invalid native shell scope and absent media activation fail closed without hidden shell', async t => {
  for (const library of ['', '0', '-1', 'library-one']) {
    const f = await P.platform(t); await f.choose(); f.shell.dataset.nativeLibraryId = library; await f.actions.check(f.row()); assert.equal(f.nativeCalls().length, 0);
  }
  const f = await P.platform(t); await f.choose(); await f.check(); delete f.c.activateSharedTrackButton; await f.play(); assert.equal(f.activations.length, 0);
});
