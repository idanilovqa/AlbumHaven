const nodeTest = require('node:test');
const test = (name, run) => nodeTest(name, {timeout: 2000}, run);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const pref = love_tier => ({rating: null, love_tier, allowed_actions: {can_set_love_tier: true}});
function fixture() {
  const requests = [], shell = {dataset: {nativeAccountId: 'actor-one', nativeLibraryId: '1'}};
  const context = vm.createContext({window: {}, document: {getElementById: () => shell},
    PrivateUITransport: {generation: () => 1},
    fetch: async (url, options) => {const response = deferred(); requests.push({url, options, response}); return response.promise;}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/track-actions.js'), 'utf8'), context);
  const runtime = vm.runInContext('TrackActionsRuntime', context);
  for (const method of ['acceptRead', 'preference', 'setLove', 'readEpoch']) assert.equal(typeof runtime[method], 'function', method);
  const canonical = {track_ref: 'track:key-one', track_preference: pref('off')};
  const pathAlias = {track_ref: '/private/one.flac', track_preference: pref('off')};
  const trusted = source => ({...source, canonical_track_ref: canonical.track_ref, inventory_track_ref: 'inventory-track:1:11',
    availability: 'local', source_readable: true, allowed_actions: {can_read: true}});
  const acknowledge = (index, tier) => {
    const request = requests[index], body = JSON.parse(request.options.body);
    request.response.resolve({ok: true, json: async () => ({ok: true, actor_id: 'actor-one', library_id: '1',
      track_ref: body.track_ref, track_preference: pref(tier)})});
  };
  return {runtime, requests, canonical, pathAlias, trusted, acknowledge};
}
const active = () => true;
const settledFailure = promise => promise.then(value => ({ok: true, value}), error => ({ok: false, error}));
async function blocked(f, source) {
  const before = f.requests.length;
  const result = settledFailure(f.runtime.setLove({source, love_tier: 'loved', isCurrent: active}));
  assert.equal(f.requests.length, before, 'blocked duplicate must not dispatch another mutation');
  assert.equal((await result).ok, false, 'blocked duplicate must reject');
}

for (const abortFirst of [false, true]) {
  test(`Trusted alias admission retains both existing transport locks${abortFirst ? ' after caller abort' : ''}`, async () => {
    const f = fixture(), controller = new AbortController();
    assert.notEqual(f.runtime.preference(f.canonical).identity, f.runtime.preference(f.pathAlias).identity);
    const first = settledFailure(f.runtime.setLove({source: f.canonical, love_tier: 'loved', signal: controller.signal, isCurrent: active}));
    const second = settledFailure(f.runtime.setLove({source: f.pathAlias, love_tier: 'obsessed', isCurrent: active}));
    assert.equal(f.requests.length, 2, 'before trusted admission the two refs are independent');
    assert.equal(JSON.parse(f.requests[0].options.body).track_ref, f.canonical.track_ref);
    assert.equal(JSON.parse(f.requests[1].options.body).track_ref, f.pathAlias.track_ref);

    const canonical = f.trusted(f.canonical), alias = f.trusted(f.pathAlias);
    f.runtime.acceptRead(canonical, f.runtime.readEpoch());
    f.runtime.acceptRead(alias, f.runtime.readEpoch());
    const canonicalPreference = f.runtime.preference(canonical), aliasPreference = f.runtime.preference(alias);
    assert.ok(canonicalPreference === null && aliasPreference === null
      || canonicalPreference && aliasPreference && canonicalPreference.identity === aliasPreference.identity,
    'trusted admission must merge aliases or make both unavailable before awaiting old transports');
    if (abortFirst) controller.abort();
    await blocked(f, canonical); await blocked(f, alias);

    // Even a new read cannot unlock an identity while an admitted alias has a
    // dispatched transport. A caller abort does not undo a server-side write.
    f.runtime.acceptRead(canonical, f.runtime.readEpoch());
    f.acknowledge(0, 'loved'); assert.equal((await first).ok, false, 'pre-merge acknowledgement must not publish');
    await blocked(f, alias); await blocked(f, canonical);
    f.acknowledge(1, 'obsessed'); assert.equal((await second).ok, false, 'second pre-merge acknowledgement must not publish');

    // Settling stale transports is not itself a fresh authoritative read.
    await blocked(f, canonical); await blocked(f, alias);
    const after = f.runtime.preference(canonical);
    assert.ok(after === null || after.allowed_actions.can_set_love_tier === false);

    f.runtime.acceptRead({...canonical, track_preference: pref('off')}, f.runtime.readEpoch());
    f.runtime.acceptRead({...alias, track_preference: pref('off')}, f.runtime.readEpoch());
    assert.equal(f.runtime.preference(canonical).identity, f.runtime.preference(alias).identity);
    assert.equal(f.runtime.preference(canonical).love_tier, 'off');
    assert.equal(f.runtime.preference(alias).allowed_actions.can_set_love_tier, true);
    const fresh = f.runtime.setLove({source: alias, love_tier: 'loved', isCurrent: active});
    assert.equal(f.requests.length, 3); assert.equal(JSON.parse(f.requests[2].options.body).track_ref, canonical.track_ref);
    f.acknowledge(2, 'loved'); await fresh;
    assert.equal(f.runtime.preference(canonical).love_tier, 'loved');
  });
}
