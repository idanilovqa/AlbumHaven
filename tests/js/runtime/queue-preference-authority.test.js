const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 2000}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const pref = (canSet = true, tier = 'loved') => ({rating: 4, love_tier: tier, allowed_actions: {can_set_love_tier: canSet}});
const outcome = promise => promise.then(value => ({ok: true, value}), error => ({ok: false, error}));
function fixture() {
  const requests = [];
  const context = vm.createContext({window: {}, document: {getElementById: () => ({dataset: {nativeAccountId: 'actor-one', nativeLibraryId: '1'}})},
    PrivateUITransport: {generation: () => 1},
    fetch: async (url, options) => {const response = deferred(); requests.push({url, options, response}); return response.promise;}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/track-actions.js'), 'utf8'), context);
  const runtime = vm.runInContext('TrackActionsRuntime', context);
  for (const method of ['acceptRead', 'preference', 'setLove', 'readEpoch']) assert.equal(typeof runtime[method], 'function', method);
  const canonical = {inventory_track_ref: 'inventory-track:1:11', canonical_track_ref: 'track:key-one', track_ref: 'track:key-one',
    source_readable: true, availability: 'local', allowed_actions: {can_read: true}, track_preference: pref()};
  const alias = {...canonical, track_ref: '/private/one.flac'};
  runtime.acceptRead(canonical, runtime.readEpoch()); runtime.acceptRead(alias, runtime.readEpoch());
  assert.equal(runtime.preference(canonical).identity, runtime.preference(alias).identity, 'fixture must establish trusted aliases');
  function acknowledge(index, tier = 'obsessed') {
    const request = requests[index], body = JSON.parse(request.options.body);
    request.response.resolve({ok: true, json: async () => ({ok: true, actor_id: 'actor-one', library_id: '1',
      track_ref: body.track_ref, track_preference: pref(true, tier)})});
  }
  const write = source => runtime.setLove({source, love_tier: 'obsessed', isCurrent: () => true});
  return {runtime, canonical, alias, requests, acknowledge, write};
}
async function rejectsWithoutDispatch(f, source) {
  const before = f.requests.length, result = outcome(f.write(source));
  assert.equal(f.requests.length, before, 'denied or locked alias must not dispatch');
  assert.equal((await result).ok, false);
}
function readableDenied(runtime, source) {
  const value = runtime.preference(source);
  assert.ok(value, 'readable denied preference keeps its known value');
  assert.equal(value.love_tier, 'loved'); assert.equal(value.rating, 4);
  assert.equal(value.allowed_actions.can_set_love_tier, false);
  return value;
}

for (const deniedAlias of ['canonical', 'alias']) {
  test(`Fresh ${deniedAlias} preference denial overrides stale sibling grants while preserving readable taste`, async () => {
    const f = fixture(), staleEpoch = f.runtime.readEpoch();
    f.runtime.acceptRead({...f[deniedAlias], track_preference: pref(false)}, f.runtime.readEpoch());
    const left = readableDenied(f.runtime, f.canonical), right = readableDenied(f.runtime, f.alias);
    assert.equal(left.identity, right.identity);
    await rejectsWithoutDispatch(f, f.canonical); await rejectsWithoutDispatch(f, f.alias);
    f.runtime.acceptRead({...f.alias, track_preference: pref(true, 'off')}, staleEpoch);
    readableDenied(f.runtime, f.canonical); readableDenied(f.runtime, f.alias);
  });
}

test('Admitted preference denial suppresses an already-dispatched alias acknowledgement', async () => {
  const f = fixture(), pending = outcome(f.write(f.alias)); assert.equal(f.requests.length, 1);
  f.runtime.acceptRead({...f.canonical, track_preference: pref(false)}, f.runtime.readEpoch());
  readableDenied(f.runtime, f.canonical); readableDenied(f.runtime, f.alias);
  await rejectsWithoutDispatch(f, f.canonical); await rejectsWithoutDispatch(f, f.alias);
  f.acknowledge(0); assert.equal((await pending).ok, false, 'a denied old write cannot republish edit authority');
  readableDenied(f.runtime, f.canonical); readableDenied(f.runtime, f.alias);
  await rejectsWithoutDispatch(f, f.alias);
});

test('Preference denial and a fresh regrant cannot release an unsettled native transport lock', async () => {
  const f = fixture(), pending = outcome(f.write(f.canonical)); assert.equal(f.requests.length, 1);
  f.runtime.acceptRead({...f.alias, track_preference: pref(false)}, f.runtime.readEpoch());
  f.runtime.acceptRead({...f.canonical, track_preference: pref(true)}, f.runtime.readEpoch());
  f.runtime.acceptRead({...f.alias, track_preference: pref(true)}, f.runtime.readEpoch());
  await rejectsWithoutDispatch(f, f.alias); await rejectsWithoutDispatch(f, f.canonical);
  f.acknowledge(0); assert.equal((await pending).ok, false, 'later regrant cannot revive a write invalidated by denial');
  // Refresh current authority only after the old server transport settles.
  f.runtime.acceptRead({...f.canonical, track_preference: pref(true)}, f.runtime.readEpoch());
  f.runtime.acceptRead({...f.alias, track_preference: pref(true)}, f.runtime.readEpoch());
  const fresh = f.write(f.alias); assert.equal(f.requests.length, 2);
  assert.equal(JSON.parse(f.requests[1].options.body).track_ref, f.canonical.canonical_track_ref);
  f.acknowledge(1); await fresh;
  assert.equal(f.runtime.preference(f.canonical).love_tier, 'obsessed');
});
