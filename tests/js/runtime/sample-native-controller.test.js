'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {id, deferred, plain, parent, options, refs, captured, captureResult, representatives, controllerFixture} = require('./sample-native-fixtures.cjs');

test('Random uses exact acquired bigint strings, one shuffle-copy and one frozen capture intent', async t => {
  const h = await controllerFixture(); t.after(() => h.controller.dispose());
  const input = {parent: parent(), options: options()}; await h.generate(input);
  assert.equal(h.calls.representatives.length, 1); assert.equal(h.calls.capture.length, 1); assert.equal(h.draws(), 2);
  const body = h.calls.capture[0]; assert.deepEqual(body.random_order, [refs[1], refs[2], refs[0]]);
  assert.equal(body.playlist_ref, input.parent.playlist_ref); assert.equal(body.revision, '3');
  assert.deepEqual(body.options, input.options); assert.equal(body.request_key, id(90));
  input.parent.revision = '99'; input.options.songs_per_group = 99;
  assert.equal(body.revision, '3'); assert.equal(body.options.songs_per_group, 2);
  assert.deepEqual(refs, ['inventory-track:5:9007199254740993', 'inventory-track:5:9223372036854775807', 'inventory-track:5:3']);
});

test('Most listened never acquires representatives or consumes randomness', async t => {
  const h = await controllerFixture(); t.after(() => h.controller.dispose());
  await h.generate({options: options('most_listened')});
  assert.equal(h.calls.representatives.length, 0); assert.equal(h.draws(), 0);
  assert.equal(h.calls.capture[0].random_order, null);
});

test('repeated Generate during acquisition or capture preserves original key and request', async t => {
  for (const phase of ['acquisition', 'capture']) {
    const pending = deferred(), entered = deferred(); let count = 0;
    const h = await controllerFixture({[phase === 'acquisition' ? 'readSamplePlaylistRepresentatives' : 'captureSamplePlaylist']: async () => {
      count++; entered.resolve(); return pending.promise;
    }}); t.after(() => h.controller.dispose());
    const first = h.generate(); await entered.promise; await h.generate();
    assert.equal(count, 1); assert.equal(h.keys(), 1);
    pending.resolve(phase === 'acquisition' ? representatives(h.scopeKey) : captureResult({scopeKey: h.scopeKey, request_key: id(90)})); await first;
    assert.equal(h.keys(), 1); assert.equal(h.draws(), 2);
  }
});

test('uncertain capture retries the original permutation/key and recovery is lookup-only', async t => {
  const writes = []; let failed = true;
  const h = await controllerFixture({captureSamplePlaylist: async input => {
    writes.push(plain({...input, signal: undefined})); if (failed) throw new Error('Response lost'); return captureResult(input);
  }}); t.after(() => h.controller.dispose());
  await h.generate(); const draws = h.draws(), keys = h.keys(); failed = false;
  await h.controller.retryCapture(); assert.equal(writes.length, 2); assert.deepEqual(writes[1], writes[0]);
  assert.equal(h.draws(), draws); assert.equal(h.keys(), keys); assert.equal(h.calls.representatives.length, 1);
  await h.controller.recoverCapture(); assert.equal(writes.length, 2); assert.equal(h.calls.read.length, 1);
  assert.equal(h.calls.read[0].request_key, id(90)); assert.equal(h.draws(), draws);
});

for (const mismatch of ['parent', 'options', 'duplicate', 'numeric', 'overflow', 'foreign_library']) test(`acquisition ${mismatch} is rejected before capture`, async t => {
  const h = await controllerFixture({readSamplePlaylistRepresentatives: async input => {
    const value = representatives(input.scopeKey);
    if (mismatch === 'parent') value.data.parent.revision = '4';
    else if (mismatch === 'options') value.data.options.songs_per_group = 4;
    else if (mismatch === 'duplicate') value.data.representative_refs.push(refs[0]);
    else if (mismatch === 'numeric') value.data.representative_refs[0] = 9007199254740992;
    else if (mismatch === 'overflow') value.data.representative_refs[0] = 'inventory-track:5:9223372036854775808';
    else value.data.representative_refs[0] = 'inventory-track:6:3';
    return value;
  }}); t.after(() => h.controller.dispose());
  await h.generate(); assert.equal(h.calls.capture.length, 0); assert.equal(h.controller.source(), null);
});

for (const retire of ['dispose', 'scope']) test(`late acquisition/capture after ${retire} cannot publish or launch a further step`, async t => {
  for (const phase of ['acquisition', 'capture']) {
    const pending = deferred(), entered = deferred(); let signal;
    const h = await controllerFixture({[phase === 'acquisition' ? 'readSamplePlaylistRepresentatives' : 'captureSamplePlaylist']: async input => {
      signal = input.signal; entered.resolve(); return pending.promise;
    }}); t.after(() => h.controller.dispose());
    const first = h.generate(); await entered.promise;
    if (retire === 'dispose') h.controller.dispose(); else h.retire();
    pending.resolve(phase === 'acquisition' ? representatives(h.scopeKey) : captureResult({scopeKey: h.scopeKey, request_key: id(90)})); await first;
    assert.equal(h.controller.source(), null); assert.equal(h.calls.save.length, 0);
    if (phase === 'acquisition') assert.equal(h.calls.capture.length, 0);
    if (retire === 'dispose') assert.equal(signal.aborted, true);
  }
});

test('projection remains Sample, uses occurrence refs and native hints without changing receipt DTO grants', async t => {
  const original = captureResult({scopeKey: 'sample:scope', request_key: id(90)});
  const h = await controllerFixture({captureSamplePlaylist: async () => original}); t.after(() => h.controller.dispose());
  await h.generate(); const source = h.controller.source();
  assert.equal(source.source.kind, 'playlist'); assert.equal(source.source_protocol, 'sample_playlist_selection_v1');
  assert.deepEqual(source.entry_refs, [id(11), id(12), id(13)]);
  assert.deepEqual(source.detail.track_rows.map(row => row.playlist_item_id), source.entry_refs);
  assert.equal(source.detail.allowed_actions.can_play, true); assert.equal(h.controller.canSave(), true);
  assert.equal(source.recipe, undefined); assert.equal(source.detail.library_mix, undefined);
  assert.deepEqual(original.data.allowed_actions, {can_read: true, can_use_for_playlist: false, can_play: false});
  assert.ok(original.data.entries.every(row => row.allowed_actions.can_select === false && row.allowed_actions.can_play === false));
});

test('empty acquisition captures [] without random draw; diagnostics remain visible and Save/Play unavailable', async t => {
  const h = await controllerFixture({readSamplePlaylistRepresentatives: async input => representatives(input.scopeKey, {representative_refs: []}),
    captureSamplePlaylist: async input => {assert.deepEqual(input.random_order, []); return captureResult(input, {
      entries: [], group_counts: [], diagnostics: [[3, 'length_excluded']], native_actions: {can_save: false, can_play: false}});}});
  t.after(() => h.controller.dispose()); await h.generate();
  assert.equal(h.draws(), 0); assert.equal(h.controller.canSave(), false);
  assert.equal(h.controller.source().detail.allowed_actions.can_play, false);
  assert.match(JSON.stringify(h.controller.getSnapshot()), /length_excluded/);
  await h.controller.save(); assert.equal(h.calls.save.length, 0);
});

test('Save preserves complete captured author order with separate key and no Mix/recipe properties', async t => {
  const h = await controllerFixture(); t.after(() => h.controller.dispose()); await h.generate();
  h.controller.edit({title: 'Explicit Sample', description: 'Manual destination'});
  await h.controller.save(); const command = h.calls.save[0];
  assert.deepEqual(command.entry_refs, [id(11), id(12), id(13)]); assert.equal(command.request_key, id(91));
  assert.deepEqual(command.source, {kind: 'playlist', ref: id(90), revision: id(2)}); assert.equal(command.mode, 'ordinary');
  for (const key of ['recipe', 'library_mix', 'mix_playback_order']) assert.equal(Object.hasOwn(command, key), false);
  await h.controller.save(); assert.equal(h.calls.save.length, 1);
});

test('unknown provider-owned Save blocks a fresh Generate/key and reconciles the original on remount', async t => {
  let pending = false, saves = 0;
  const h = await controllerFixture({hasPendingPlaylistOperation: () => pending,
    createPlaylistFromSelection: async () => {pending = true; saves++; throw Object.assign(new Error('Unknown'), {status: 'unknown'});},
    recoverPlaylistCreation: async input => ({ok: true, action: 'create', request_key: id(91), playlist_id: id(80), revision: '1', scopeKey: input.scopeKey})});
  t.after(() => h.controller.dispose()); await h.generate(); await h.controller.save();
  const keys = h.keys(); await h.generate(); await h.controller.save();
  assert.equal(saves, 1); assert.equal(h.keys(), keys); assert.equal(h.controller.pendingSave(), true);
  await h.controller.recoverSave(); assert.equal(saves, 1);
  assert.equal(h.controller.getSnapshot().mutation.data.playlist_id, id(80));
});

for (const patch of [{styles: ['rock']}, {countries: ['GB']}, {songs_per_group: undefined}, {unknown_facets: undefined}])
  test(`unsupported or missing explicit control is not defaulted: ${JSON.stringify(patch)}`, async t => {
    const h = await controllerFixture(); t.after(() => h.controller.dispose()); await h.generate({options: options('random', patch)});
    assert.equal(h.calls.capture.length, 0); assert.equal(h.calls.representatives.length, 0);
  });

test('repeated Save while pending allocates one independent key and late disposed acknowledgment cannot publish', async t => {
  const entered = deferred(), waiting = deferred(); let input, count = 0;
  const h = await controllerFixture({createPlaylistFromSelection: async value => {input = value; count++; entered.resolve(); return waiting.promise;}});
  t.after(() => h.controller.dispose()); await h.generate();
  const saving = h.controller.save(); await entered.promise; await h.controller.save();
  assert.equal(count, 1); assert.equal(h.keys(), 2);
  h.controller.dispose(); waiting.resolve({status: 'ready', data: {ok: true, action: 'create', request_key: input.request_key,
    playlist_id: id(80), revision: '1', scopeKey: h.scopeKey}}); await saving;
  assert.notEqual(h.controller.getSnapshot().mutation.status, 'ready'); assert.equal(input.signal.aborted, true);
});

test('missing capture lookup is not permission to reroll or replace a lost receipt key', async t => {
  const h = await controllerFixture({captureSamplePlaylist: async () => {throw new Error('Unknown capture');},
    readSamplePlaylist: async () => {throw Object.assign(new Error('source_unavailable'), {status: 404});}});
  t.after(() => h.controller.dispose()); await h.generate(); const draws = h.draws(), keys = h.keys();
  await h.controller.recoverCapture(); assert.equal(h.calls.representatives.length, 1);
  assert.equal(h.draws(), draws); assert.equal(h.keys(), keys); assert.equal(h.controller.source(), null);
});

test('new deliberate Generate after representative-set conflict gets new key and one new permutation', async t => {
  let attempts = 0; const commands = [];
  const h = await controllerFixture({captureSamplePlaylist: async input => {
    commands.push(plain({...input, signal: undefined}));
    if (++attempts === 1) throw Object.assign(new Error('source_changed'), {status: 409, responseRejected: true});
    return captureResult(input);
  }}); t.after(() => h.controller.dispose()); await h.generate();
  assert.equal(h.controller.source(), null); assert.equal(h.calls.representatives.length, 1);
  await h.generate(); assert.equal(h.calls.representatives.length, 2); assert.equal(h.draws(), 4);
  assert.notEqual(commands[0].request_key, commands[1].request_key);
  assert.deepEqual(commands[0].options, commands[1].options);
});

for (const hints of [undefined, {can_save: false, can_play: false}]) test(`foundation grants cannot substitute for native hints ${JSON.stringify(hints)}`, async t => {
  const h = await controllerFixture({captureSamplePlaylist: async input => captureResult(input, {native_actions: hints})});
  t.after(() => h.controller.dispose()); await h.generate();
  assert.equal(h.controller.canSave(), false);
  assert.equal(h.controller.source()?.detail.allowed_actions.can_play === true, false);
  await h.controller.save(); assert.equal(h.calls.save.length, 0);
});
