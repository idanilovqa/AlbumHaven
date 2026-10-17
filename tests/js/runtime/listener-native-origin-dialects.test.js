'use strict';
// Characterization of the unchanged native target projector. This file does
// not add a listener controller or fix Home's current wire/UI adapter mismatch.
// Explicit UI-origin construction below is test input, not a production adapter.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.ALBUM_TOP_TEST_ROOT || path.resolve(__dirname, '../../..');
const ROW = 'activity_' + 'a'.repeat(64), SNAPSHOT = 'A'.repeat(43);
const SUBJECT = '00000000-0000-4000-8000-000000000001';
const plain = value => JSON.parse(JSON.stringify(value));
function owner() {
  const context = vm.createContext({window: {}});
  vm.runInContext(fs.readFileSync(path.join(ROOT,
    'music_app/static/js/runtime/resource-selection.js'), 'utf8'), context,
    {filename: 'resource-selection.js'});
  return context.window.AlbumHavenResourceSelection;
}

for (const audience of ['own', 'friend']) for (const kind of ['album', 'artist']) {
  test(`${audience}/${kind}: wire origin is not silently treated as the UI origin`, () => {
    const native = owner();
    const wire = {audience, subject_ref: audience === 'own' ? null : SUBJECT,
      kind: 'tracks', period: 'all', snapshot_ref: SNAPSHOT};
    const target = {kind, ref: ROW, origin: wire, identity_ref: kind + '_' + 'b'.repeat(64),
      allowed_actions: {can_view_details: true}};
    assert.equal(native.projectOrigin(wire), null);
    assert.equal(native.projectTarget(target), null);
    const uiOrigin = {source: 'activity', account_ref: wire.subject_ref,
      kind: 'tracks', period: 'all', snapshot_ref: SNAPSHOT};
    const admitted = native.projectTarget({...target, origin: uiOrigin});
    assert.deepEqual(plain(admitted), {...target, origin: uiOrigin});
    assert.equal(admitted.ref, ROW, 'an activity coordinate must not become a catalog reference');
    assert.equal(admitted.native_actions, undefined, 'projection alone does not resolve inventory or native actions');
    assert.deepEqual(wire, {audience, subject_ref: audience === 'own' ? null : SUBJECT,
      kind: 'tracks', period: 'all', snapshot_ref: SNAPSHOT}, 'the private POST origin remains unchanged');
    const runtime = native.create();
    for (const intent of ['open', 'page', 'embed', 'play', 'artist_gallery', 'artwork']) {
      assert.equal(runtime.canResourceIntent(intent, admitted, {scopeKey: 'listener-contract', origin: uiOrigin}), false,
        'a projected target without a current native source cannot authorize ' + intent);
    }
  });
}
