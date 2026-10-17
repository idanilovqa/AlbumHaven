const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 2000}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const pref = love_tier => ({rating: null, love_tier, allowed_actions: {can_set_love_tier: true}});
const outcome = promise => promise.then(value => ({ok: true, value}), error => ({ok: false, error}));
function fixture() {
  const requests = [];
  const context = vm.createContext({window: {}, document: {getElementById: () => ({dataset: {nativeAccountId: 'actor-one', nativeLibraryId: '1'}})},
    PrivateUITransport: {generation: () => 1}, fetch: (url, options) => new Promise(resolve => {requests.push({url, options, resolve});})});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/track-actions.js'), 'utf8'), context);
  const runtime = vm.runInContext('TrackActionsRuntime', context);
  for (const name of ['acceptRead', 'readEpoch', 'preference', 'setLove']) assert.equal(typeof runtime[name], 'function', name);
  const canonical = {track_ref: 'track:key-one', track_preference: pref('off')};
  const alias = {track_ref: '/private/one.flac', track_preference: pref('off')};
  const trusted = source => ({...source, inventory_track_ref: 'inventory-track:1:11', canonical_track_ref: canonical.track_ref,
    source_readable: true, availability: 'local', allowed_actions: {can_read: true}});
  const write = source => runtime.setLove({source, love_tier: 'loved', isCurrent: () => true});
  function acknowledge(index) {
    const request = requests[index], body = JSON.parse(request.options.body);
    request.resolve({ok: true, json: async () => ({ok: true, actor_id: 'actor-one', library_id: '1',
      track_ref: body.track_ref, track_preference: pref('loved')})});
  }
  return {runtime, requests, canonical, alias, trusted, write, acknowledge};
}

test('Final stale alias transport settlement retires reads begun while that transport was pending', async () => {
  const f = fixture();
  assert.notEqual(f.runtime.preference(f.canonical).identity, f.runtime.preference(f.alias).identity);
  const first = outcome(f.write(f.canonical)), second = outcome(f.write(f.alias));
  assert.equal(f.requests.length, 2);
  const canonical = f.trusted(f.canonical), alias = f.trusted(f.alias);
  f.runtime.acceptRead(canonical, f.runtime.readEpoch()); f.runtime.acceptRead(alias, f.runtime.readEpoch());
  f.acknowledge(0); assert.equal((await first).ok, false, 'first pre-admission acknowledgement must be stale');

  // This request began after the first settlement, but while the remaining
  // transport could still commit. Its response must not recover authority.
  const readDuringLastTransport = f.runtime.readEpoch();
  f.acknowledge(1); assert.equal((await second).ok, false, 'last pre-admission acknowledgement must be stale');
  assert.notEqual(f.runtime.readEpoch(), readDuringLastTransport, 'settling the last stale transport must retire its overlapping reads');
  f.runtime.acceptRead({...canonical, track_preference: pref('obsessed')}, readDuringLastTransport);
  f.runtime.acceptRead({...alias, track_preference: pref('obsessed')}, readDuringLastTransport);
  for (const source of [canonical, alias]) {
    const value = f.runtime.preference(source);
    assert.ok(value === null || value.allowed_actions.can_set_love_tier === false, 'old response must not restore editing');
    assert.notEqual(value?.love_tier, 'obsessed', 'old response must not replace visible Love');
  }
  const denied = outcome(f.write(alias)); assert.equal(f.requests.length, 2); assert.equal((await denied).ok, false);

  const freshEpoch = f.runtime.readEpoch();
  f.runtime.acceptRead({...canonical, track_preference: pref('off')}, freshEpoch);
  f.runtime.acceptRead({...alias, track_preference: pref('off')}, freshEpoch);
  assert.equal(f.runtime.preference(canonical).identity, f.runtime.preference(alias).identity);
  assert.equal(f.runtime.preference(alias).love_tier, 'off');
  assert.equal(f.runtime.preference(alias).allowed_actions.can_set_love_tier, true);
  const fresh = f.write(alias); assert.equal(f.requests.length, 3);
  assert.equal(JSON.parse(f.requests[2].options.body).track_ref, canonical.track_ref);
  f.acknowledge(2); await fresh;
  assert.equal(f.runtime.preference(canonical).love_tier, 'loved');
});
