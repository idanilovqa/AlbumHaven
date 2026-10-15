'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const {id, recipe, mixMetadata, capture, deferred, plain} = require('./library-mix-fixtures.cjs');
const {row} = require('./library-mix-native-fixture.cjs');

// Actual delivered mount owners and controls. Only external playback results are
// deferred; no hook scheduler, virtual tree, form, menu or owner is substituted.
function playbackRuntime(h) {
  const requests = [], subscriptions = [];
  const runtime = {...h.runtime,
    canTrackIntent: (intent, value) => intent === 'play' && value.allowed_actions?.can_play === true,
    readPlayback: async options => ({status: 'ready', data: {scopeKey: options.scopeKey,
      playlist_id: options.playlist_id, library_mix_order: 'regular'}}),
    subscribePlayback(options) {
      const subscription = {options, retired: false}; subscriptions.push(subscription);
      return () => {subscription.retired = true;};
    },
    trackIntent(intent, value, options) {
      const pending = deferred(); requests.push({intent, row: value, options, ...pending});
      return pending.promise;
    },
    setLibraryMixOrder: () => true,
  };
  return {runtime, requests, subscriptions};
}
function detail(playlistId = id(80)) {
  return {playlist_id: playlistId, library_mix: mixMetadata(), allowed_actions: {can_play: true},
    track_rows: [row(1), row(2), row(3)]};
}

test('native temporary mix owns one main landmark and removes it with its caller container contents', async t => {
  const h = await nativeMixFixture(t), scopeKey = h.runtime.snapshot().scopeKey;
  const controller = h.api.createLibraryMixController({scopeKey, isCurrent: () => true,
    requestKey: () => id(90), providers: {beginLibraryMix: async options => capture({scopeKey,
      library_mix: mixMetadata(options.recipe)})}});
  await controller.prepare(recipe());
  const page = h.mount('page', {runtime: h.mixRuntime(controller), controller, onSaved() {}, onClose() {}});
  await h.settle();
  const mains = page.host.querySelectorAll('main[aria-label="Temporary Library Mix"]');
  assert.equal(mains.length, 1);
  assert.ok(mains[0].querySelector('[data-shared-header="library-mix"]'));
  assert.equal(mains[0].querySelectorAll('[data-playlist-row-key]').length, 3);
  assert.equal(mains[0].parentNode, page.host);
  page.unmount(); await h.settle();
  assert.equal(mains[0].isConnected, false);
  assert.equal(page.host.childNodes.length, 0);
  assert.equal(page.host.querySelector('main'), null);
  assert.equal(page.host.getAttribute('aria-label'), null, 'caller is not left labelled as a retired page');
});

test('saved mix playback completion releases busy state after same-owner rows refresh and next play uses current rows', async t => {
  const h = await nativeMixFixture(t), playback = playbackRuntime(h), value = detail(), scopeKey = h.runtime.snapshot().scopeKey;
  const mounted = h.mount('order', {runtime: playback.runtime, detail: value, scopeKey, rows: value.track_rows});
  await h.settle(); h.click(h.named('Play mix', mounted.host)); await h.settle();
  assert.equal(playback.requests.length, 1);
  assert.equal(h.named('Play mix', mounted.host).disabled, true);
  const currentRows = [value.track_rows[2], value.track_rows[0]];
  mounted.render({runtime: playback.runtime, detail: value, scopeKey, rows: currentRows}); await h.settle();
  assert.equal(h.named('Play mix', mounted.host).disabled, true, 'props refresh does not unlock a pending operation');
  playback.requests[0].resolve(true); await h.settle();
  assert.equal(h.named('Play mix', mounted.host).disabled, false);
  h.click(h.named('Play mix', mounted.host)); await h.settle();
  assert.equal(playback.requests.length, 2);
  assert.equal(playback.requests[1].row, currentRows[0]);
  assert.deepEqual(plain(playback.requests[1].options.displayedItemIds), [id(13), id(11)]);
  playback.requests[1].resolve(true); await h.settle();
  assert.equal(h.named('Play mix', mounted.host).disabled, false);
});

test('retired saved mix completion cannot unlock replacement playback or repopulate disposed controls', async t => {
  const h = await nativeMixFixture(t), playback = playbackRuntime(h), first = detail(), scopeKey = h.runtime.snapshot().scopeKey;
  const mounted = h.mount('order', {runtime: playback.runtime, detail: first, scopeKey});
  await h.settle(); h.click(h.named('Play mix', mounted.host)); await h.settle();
  const oldSubscription = playback.subscriptions[0], next = detail(id(81));
  mounted.render({runtime: playback.runtime, detail: next, scopeKey: 'replacement-scope'}); await h.settle();
  assert.equal(oldSubscription.retired, true);
  assert.equal(h.named('Play mix', mounted.host).disabled, false);
  h.click(h.named('Play mix', mounted.host)); await h.settle();
  assert.equal(playback.requests.length, 2);
  assert.equal(playback.requests[1].options.scopeKey, 'replacement-scope');
  assert.equal(playback.requests[1].options.playlist_id, id(81));
  playback.requests[0].resolve(true); await h.settle();
  assert.equal(h.named('Play mix', mounted.host).disabled, true, 'old owner cannot release replacement operation');
  playback.requests[1].resolve(true); await h.settle();
  assert.equal(h.named('Play mix', mounted.host).disabled, false);
  h.click(h.named('Play mix', mounted.host)); await h.settle();
  const finalSubscription = playback.subscriptions.at(-1);
  mounted.unmount();
  playback.requests[2].resolve(true);
  finalSubscription.options.onChange({status: 'ready', data: {scopeKey: 'replacement-scope',
    playlist_id: id(81), library_mix_order: 'shuffle'}});
  oldSubscription.options.onChange({status: 'ready', data: {scopeKey, playlist_id: id(80), library_mix_order: 'unplayed_first'}});
  await h.settle();
  assert.equal(finalSubscription.retired, true);
  assert.equal(mounted.host.childNodes.length, 0);
  assert.equal(h.named('Play mix', mounted.host), undefined);
});


test('superseded pre-admission saved play cannot release a reentrant same-owner operation', async t => {
  const h = await nativeMixFixture(t), playback = playbackRuntime(h), value = detail(), scopeKey = h.runtime.snapshot().scopeKey;
  const currentRows = [value.track_rows[2], value.track_rows[0]];
  const canPlay = playback.runtime.canTrackIntent;
  let armed = false, reentries = 0, mounted;
  playback.runtime.canTrackIntent = (intent, candidate, options) => {
    if (armed) {
      armed = false; reentries++;
      mounted.render({runtime: playback.runtime, detail: value, scopeKey, rows: currentRows});
      h.click(h.named('Play mix', mounted.host));
    }
    return canPlay(intent, candidate, options);
  };
  mounted = h.mount('order', {runtime: playback.runtime, detail: value, scopeKey, rows: value.track_rows});
  await h.settle();
  armed = true;
  h.click(h.named('Play mix', mounted.host)); await h.settle();
  assert.equal(reentries, 1);
  assert.equal(playback.requests.length, 1, 'superseded outer invocation never acquires a playback operation');
  assert.equal(playback.requests[0].row, currentRows[0]);
  assert.deepEqual(plain(playback.requests[0].options.displayedItemIds), [id(13), id(11)]);
  assert.equal(h.named('Play mix', mounted.host).disabled, true, 'outer pre-admission finally cannot release nested busy state');
  playback.requests[0].resolve(true); await h.settle();
  assert.equal(h.named('Play mix', mounted.host).disabled, false);
});
