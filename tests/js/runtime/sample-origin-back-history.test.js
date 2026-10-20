'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {closeHarness, settle, F} = require('./sample-origin-back-fixtures.cjs');

test('real Settings discard precedes origin callback and the pending history-only return is single use', async () => {
  const h = closeHarness(), gate = F.deferred(), entered = F.deferred(); let retained;
  const pending = h.runtime.closeDraft(h.token, async returnToParent => {
    assert.equal(h.calls.discard, 1); assert.equal(h.active(), false);
    assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(h.history.state.playlistDraft, undefined);
    assert.equal(typeof returnToParent, 'function'); retained = returnToParent; entered.resolve();
    await gate.promise; return true;
  }, h.originIsCurrent);
  await Promise.race([entered.promise, settle().then(() => assert.equal(typeof retained, 'function', 'source callback reached after real discard'))]);
  assert.equal(retained(), true, 'intentional discard does not invalidate independent departure context');
  assert.equal(retained(), false, 'consume before navigation and before attempt settles');
  gate.resolve(); assert.equal(await pending, true); await settle();
  assert.equal(retained(), false); assert.deepEqual(h.backCalls.go, [-1]); assert.equal(h.index(), 0);
  assert.equal(h.backCalls.fallback.length, 0); assert.equal(h.calls.fetch.length, 0);
});

test('missing invalid unsafe equal or backward positions refuse origin history without ordinary fetch fallback', async () => {
  const positions = [
    ['missing parent', undefined, 1], ['invalid parent', '0', 1], ['unsafe parent', 9007199254740992, 1],
    ['missing departure', 0, undefined], ['invalid departure', 0, '1'], ['unsafe departure', 0, 9007199254740992],
    ['equal', 1, 1], ['backward', 2, 1],
  ];
  for (const [name, parentPosition, departurePosition] of positions) {
    const h = closeHarness({parentPosition, departurePosition}); let calls = 0;
    assert.equal(await h.runtime.closeDraft(h.token, returnToParent => {calls++; return returnToParent();}, h.originIsCurrent), false, name);
    if (Number.isSafeInteger(departurePosition)) assert.equal(calls, 1, name);
    else assert.ok(calls <= 1, `${name}: invalid departure may fail closed before source callback`);
    assert.equal(h.calls.discard, 1, name);
    assert.equal(h.active(), false, name);
    assert.equal(h.runtime.snapshot().retainedDraftToken, null, name);
    assert.equal(h.history.state.playlistDraft, undefined, name);
    assert.deepEqual(h.backCalls.go, [], name); assert.deepEqual(h.backCalls.fallback, [], name);
    assert.equal(h.calls.fetch.length, 0, name);
  }
});

test('ordinary closeDraft without origin callback keeps its established history and fetch fallback', async () => {
  const valid = closeHarness(); assert.equal(await valid.runtime.closeDraft(valid.token), true); await settle();
  assert.deepEqual(valid.backCalls.go, [-1]); assert.equal(valid.backCalls.fallback.length, 0);
  const missing = closeHarness({parentPosition: undefined});
  assert.equal(await missing.runtime.closeDraft(missing.token), true);
  assert.deepEqual(missing.backCalls.go, []);
  assert.deepEqual(missing.backCalls.fallback, [['/view-data?surface=playlists', true]]);
});

test('false or throwing source return settles its unused callback without fallback or later navigation', async () => {
  for (const mode of ['false', 'throw']) {
    const h = closeHarness(); let retained;
    try {
      const result = await h.runtime.closeDraft(h.token, returnToParent => {
        retained = returnToParent; if (mode === 'throw') throw new Error('Original source return failed'); return false;
      }, h.originIsCurrent);
      assert.equal(result, false);
    } catch (error) {assert.equal(mode, 'throw'); assert.match(error.message, /Original source return failed/);}
    assert.equal(typeof retained, 'function'); assert.equal(retained(), false, mode);
    await settle(); assert.deepEqual(h.backCalls.go, []); assert.deepEqual(h.backCalls.fallback, []);
  }
});

for (const change of ['source guard', 'scope', 'runtime', 'navigation owner', 'URL', 'position'])
  test(`pending history callback rejects stale ${change} without fetch or second navigation`, async () => {
    const h = closeHarness(), gate = F.deferred(), entered = F.deferred(); let retained;
    const pending = h.runtime.closeDraft(h.token, async returnToParent => {
      retained = returnToParent; entered.resolve(); await gate.promise; return returnToParent();
    }, h.originIsCurrent);
    await Promise.race([entered.promise, settle().then(() => assert.equal(typeof retained, 'function', 'source callback reached after real discard'))]);
    if (change === 'source guard') h.retireOrigin();
    else if (change === 'scope') {h.shell.dataset.nativeLibraryId = 'another-library'; h.runtime.sync();}
    else if (change === 'runtime') h.context.AlbumHavenPlaylistRuntime = {...h.runtime};
    else if (change === 'navigation owner') h.context.AlbumHavenSettingsNavigation.instance = {...h.navigation};
    else if (change === 'URL') h.history.replaceState(h.history.state, '', 'https://albumhaven.test/?artist=Replacement');
    else h.history.replaceState({...h.history.state, albumHavenNavigationPosition: 99}, '', h.location.href);
    gate.resolve(); assert.equal(await pending, false); assert.equal(retained(), false); await settle();
    assert.equal(h.calls.discard, 1); assert.deepEqual(h.backCalls.go, []); assert.deepEqual(h.backCalls.fallback, []);
    assert.equal(h.calls.fetch.length, 0);
  });

test('origin return requires its separate currentness guard without weakening ordinary closeDraft', async () => {
  for (const guard of [undefined, null, false, 'not-a-guard']) {
    const h = closeHarness();
    assert.equal(await h.runtime.closeDraft(h.token, () => assert.fail('invalid origin guard must not run return'), guard), false);
    assert.equal(h.calls.discard, 0); assert.equal(h.runtime.snapshot().retainedDraftToken, h.token);
    assert.deepEqual(h.backCalls.go, []); assert.deepEqual(h.backCalls.fallback, []);
  }
});

test('false or throwing callable origin guard fails closed before source callback or navigation', async () => {
  for (const mode of ['false', 'throw']) {
    const h = closeHarness(); let returns = 0;
    const guard = () => {if (mode === 'throw') throw new Error('Retired origin'); return false;};
    assert.equal(await h.runtime.closeDraft(h.token, () => {returns++; return true;}, guard), false);
    assert.equal(returns, 0); assert.deepEqual(h.backCalls.go, []); assert.deepEqual(h.backCalls.fallback, []);
  }
});

test('a refused first history invocation is consumed even if the position is restored before settlement', async () => {
  const h = closeHarness(), entered = F.deferred(), gate = F.deferred(); let retained;
  const pending = h.runtime.closeDraft(h.token, async returnToParent => {
    retained = returnToParent; entered.resolve(); await gate.promise; return false;
  }, h.originIsCurrent);
  await Promise.race([entered.promise, settle().then(() => assert.equal(typeof retained, 'function', 'source callback reached after real discard'))]);
  const state = h.history.state, url = h.location.href;
  h.history.replaceState({...state, albumHavenNavigationPosition: 99}, '', url);
  assert.equal(retained(), false);
  h.history.replaceState(state, '', url);
  assert.equal(retained(), false, 'first invocation consumed the callback, not only successful history.go');
  gate.resolve(); assert.equal(await pending, false); assert.equal(retained(), false);
  assert.deepEqual(h.backCalls.go, []); assert.deepEqual(h.backCalls.fallback, []); assert.equal(h.calls.fetch.length, 0);
});
