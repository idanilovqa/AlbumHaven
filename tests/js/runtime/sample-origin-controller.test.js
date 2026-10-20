'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const F = require('./sample-origin-fixtures.cjs');
for (const kind of Object.keys(F.origins)) {
  test(`${kind}: existing Sample controller sends exact typed origin with one frozen Random intent`, async t => {
    const h = await F.typedController(kind); t.after(() => h.controller.dispose());
    const origin = F.origins[kind](), before = F.plain(origin); await h.generateOrigin({origin});
    assert.equal(h.typedCalls.representatives.length, 1); assert.equal(h.typedCalls.capture.length, 1);
    const acquire = h.typedCalls.representatives[0], capture = h.typedCalls.capture[0];
    assert.deepEqual(F.plain(acquire.origin), before); assert.deepEqual(F.plain(capture.origin), before);
    assert.equal(Object.hasOwn(acquire, 'playlist_ref'), false); assert.equal(Object.hasOwn(capture, 'revision'), false);
    assert.deepEqual(capture.random_order, [F.refs[1], F.refs[2], F.refs[0]]); assert.equal(h.draws(), 2); assert.equal(h.keys(), 1);
    if (kind === 'album_top') origin.revision = '4';
    else if (kind === 'album_set') origin.selections.reverse(); else origin.track_refs.reverse();
    assert.deepEqual(F.plain(capture.origin), before); assert.equal(h.controller.source().source.kind, 'library');
  });
  test(`${kind}: Most-listened bypasses acquisition and random draws`, async t => {
    const h = await F.typedController(kind); t.after(() => h.controller.dispose());
    await h.generateOrigin({options: F.options('most_listened')});
    assert.equal(h.typedCalls.representatives.length, 0); assert.equal(h.draws(), 0);
    assert.equal(h.typedCalls.capture.length, 1); assert.equal(h.typedCalls.capture[0].random_order, null);
  });
  test(`${kind}: uncertain capture retries exact origin/key/order and lookup recovery never recaptures`, async t => {
    let failed = true; const writes = [];
    const h = await F.typedController(kind, {captureSamplePlaylist: async input => {
      writes.push(F.plain({...input, signal: undefined})); if (failed) throw new Error('response lost'); return F.v2Capture(input);
    }}); t.after(() => h.controller.dispose());
    await h.generateOrigin(); const keyCount = h.keys(), drawCount = h.draws(); failed = false;
    await h.controller.retryCapture(); assert.deepEqual(writes[1], writes[0]);
    await h.controller.recoverCapture(); assert.equal(writes.length, 2); assert.equal(h.typedCalls.read.length, 1);
    assert.equal(h.typedCalls.read[0].request_key, writes[0].request_key); assert.equal(h.keys(), keyCount); assert.equal(h.draws(), drawCount);
  });
  test(`${kind}: dedicated library receipt Save keeps captured order and ordinary shared mutation ownership`, async t => {
    const h = await F.typedController(kind); t.after(() => h.controller.dispose()); await h.generateOrigin();
    assert.ok(h.controller.source()); h.controller.edit({title: 'Manual Sample', description: 'Explicit save'});
    await h.controller.save(); await h.controller.save();
    assert.equal(h.typedCalls.save.length, 1); const command = h.typedCalls.save[0];
    assert.deepEqual(command.source, {kind: 'library', ref: F.id(90), revision: F.id(2)});
    assert.equal(command.source_protocol, F.PROTOCOL); assert.equal(command.request_key, F.id(91));
    assert.deepEqual(command.entry_refs, [F.id(11), F.id(12), F.id(13)]); assert.equal(command.mode, 'ordinary');
    for (const key of ['origin', 'recipe', 'library_mix', 'playlist_ref', 'top_ref']) assert.equal(Object.hasOwn(command, key), false);
  });
  for (const phase of ['acquisition', 'capture']) for (const retirement of ['scope', 'dispose'])
    test(`${kind}: ${retirement} retires late ${phase} without preview or next step`, async t => {
      const waiting = F.deferred(), entered = F.deferred(); let submitted;
      const method = phase === 'acquisition' ? 'readSamplePlaylistRepresentatives' : 'captureSamplePlaylist';
      const h = await F.typedController(kind, {[method]: async input => {submitted = input; entered.resolve(); return waiting.promise;}});
      t.after(() => h.controller.dispose());
      const operation = h.generateOrigin();
      await Promise.race([entered.promise, operation.then(() => {throw new Error('The typed seam returned before its expected boundary');})]);
      if (retirement === 'dispose') h.controller.dispose(); else h.retire();
      waiting.resolve(phase === 'acquisition' ? F.v2Representatives(submitted) : F.v2Capture(submitted)); await operation;
      assert.equal(h.controller.source(), null); assert.equal(h.typedCalls.save.length, 0);
      if (phase === 'acquisition') assert.equal(h.typedCalls.capture.length, 0);
      if (retirement === 'dispose') assert.equal(submitted.signal.aborted, true);
    });
}
for (const mismatch of ['other_origin', 'changed_order', 'mixed_parent', 'foreign_representative', 'duplicate_representative'])
  test(`typed acquisition rejects ${mismatch} before capture`, async t => {
    const h = await F.typedController('album_details', {readSamplePlaylistRepresentatives: async input => {
      const value = F.v2Representatives(input);
      if (mismatch === 'other_origin') value.data.origin = F.origins.album_top();
      else if (mismatch === 'changed_order') value.data.origin.track_refs.reverse();
      else if (mismatch === 'mixed_parent') value.data.parent = F.parent();
      else if (mismatch === 'foreign_representative') value.data.representative_refs[0] = 'inventory-track:6:3';
      else value.data.representative_refs.push(F.refs[0]); return value;
    }}); t.after(() => h.controller.dispose()); await h.generateOrigin();
    assert.equal(h.typedCalls.capture.length, 0); assert.equal(h.controller.source(), null);
  });
test('typed origin diagnostics survive preview without becoming DTO grants or track diagnostics', async t => {
  const diagnostics = [[0, 'remote_summary'], [2, 'unavailable'], [3, 'ambiguous_edition'], [4, 'tracks_unavailable']];
  const h = await F.typedController('album_top', {captureSamplePlaylist: async input => F.v2Capture(input, {
    origin_diagnostics: diagnostics, source_diagnostics: [[3, 'length_excluded']], native_actions: {can_save: false, can_play: false}})});
  t.after(() => h.controller.dispose()); await h.generateOrigin(); const source = h.controller.source(); assert.ok(source);
  assert.deepEqual(source.origin_diagnostics, diagnostics); assert.deepEqual(source.source_diagnostics, [[3, 'length_excluded']]);
  assert.equal(h.controller.canSave(), false); assert.equal(source.detail.allowed_actions.can_play, false);
});
test('unknown shared Save blocks a second typed Generate/key and reconciles original destination only', async t => {
  let pending = false, writes = 0;
  const h = await F.typedController('album_set', {hasPendingPlaylistOperation: () => pending,
    createPlaylistFromSelection: async () => {pending = true; writes++; throw Object.assign(new Error('unknown'), {status: 'unknown'});},
    recoverPlaylistCreation: async input => ({scopeKey: input.scopeKey, ok: true, action: 'create', playlist_id: F.id(80), revision: '1', request_key: F.id(91)})});
  t.after(() => h.controller.dispose()); await h.generateOrigin(); await h.controller.save(); const keys = h.keys();
  await h.generateOrigin({origin: F.origins.album_details()}); assert.equal(h.keys(), keys); assert.equal(writes, 1);
  await h.controller.recoverSave(); assert.equal(h.controller.getSnapshot().mutation.data.playlist_id, F.id(80)); assert.equal(writes, 1);
});
test('crossed receipt kind remains rejected in both directions without changing v1 DTO', async t => {
  for (const typed of [false, true]) {
    const make = typed ? () => F.typedController('album_set', {captureSamplePlaylist: async input => F.captureResult(input)})
      : () => F.controllerFixture({captureSamplePlaylist: async input => F.v2Capture(input)});
    const h = await make(); t.after(() => h.controller.dispose()); await (typed ? h.generateOrigin() : h.generate());
    assert.equal(h.controller.source(), null);
  }
  const legacy = await F.controllerFixture(); t.after(() => legacy.controller.dispose()); await legacy.generate();
  assert.equal(legacy.controller.source().source.kind, 'playlist'); assert.equal(Object.hasOwn(legacy.calls.capture[0], 'origin'), false);
});
