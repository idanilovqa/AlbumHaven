'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {harness, settle, plain} = require('./library-mix-navigation-fixture.cjs');

function globalMix(h, confirmLeave = () => true) {
  h.context.state.view = {context_ref: 'a'.repeat(64), surface: {active: 'albums'}};
  h.history.replaceState(h.history.state, '', 'https://albumhaven.test/?artist=Retained&gallery_display=flat');
  const scopeKey = h.runtime.snapshot().scopeKey;
  let active = true;
  return {scopeKey, open: () => h.runtime.openDraft({token: 'mix:global', scopeKey, fromGlobal: true,
    isCurrent: () => active, confirmLeave, onDiscard: () => {active = false; h.calls.discard++;}})};
}

test('global Library Mix opens through existing native draft navigation while Playlist page is initially hidden', () => {
  const h = harness(), mix = globalMix(h), view = h.context.state.view;
  assert.equal(h.runtime.snapshot().visible, false); assert.equal(mix.open(), true);
  assert.equal(h.location.search, '?surface=playlists'); assert.equal(h.runtime.snapshot().draftToken, 'mix:global');
  assert.equal(h.runtime.snapshot().playlistId, null); assert.equal(h.context.state.view, view);
  assert.deepEqual(plain(h.history.state.playlistDraft), {token: 'mix:global', scopeKey: mix.scopeKey});
  assert.equal(mix.open(), false); assert.equal(h.calls.fetch.length, 0);
  assert.doesNotMatch(JSON.stringify(h.history.state), /entries|recipe|source_ref|library_mix|playback_order/);
});

test('Close, Back cancellation and accepted discard preserve the native history owner and cannot resurrect an abandoned mix', async () => {
  const h = harness(); let decision = false, asks = 0;
  const mix = globalMix(h, () => {asks++; return decision;}); assert.equal(mix.open(), true);
  assert.equal(await h.runtime.closeDraft('mix:global'), false); await settle();
  assert.equal(h.runtime.snapshot().draftToken, 'mix:global'); assert.equal(h.calls.discard, 0);
  h.history.go(-1); await settle();
  assert.equal(h.runtime.snapshot().draftToken, 'mix:global'); assert.equal(h.index(), 1); assert.ok(asks >= 2);
  decision = true; await h.runtime.closeDraft('mix:global'); await settle();
  assert.equal(h.index(), 0); assert.equal(h.location.search, '?artist=Retained&gallery_display=flat');
  assert.equal(h.calls.discard, 1); assert.equal(h.runtime.snapshot().draftToken, null);
  h.history.go(1); await settle();
  assert.equal(h.history.state.playlistDraft, undefined); assert.equal(h.runtime.snapshot().draftToken, null);
});

test('global opening cannot bypass authentication, an existing draft, native history ownership or obsolete scope', () => {
  for (const invalidate of [h => {h.shell.hidden = true;}, h => {delete h.shell.dataset.nativeAccountId;},
    h => {h.shell.dataset.nativeLibraryId = 'other';}]) {
    const h = harness(), mix = globalMix(h); invalidate(h);
    assert.equal(mix.open(), false); assert.equal(h.history.state.playlistDraft, undefined);
  }
  const h = harness(); assert.equal(h.open(), true); const before = plain(h.history.state);
  assert.equal(h.runtime.openDraft({token: 'mix:second', scopeKey: h.runtime.snapshot().scopeKey, fromGlobal: true,
    isCurrent: () => true, confirmLeave: () => true, onDiscard() {}}), false);
  assert.deepEqual(plain(h.history.state), before);
});

test('saved-mix completion is bound to exact draft token and scope and retires it only on admitted completion', async () => {
  const h = harness(), mix = globalMix(h); mix.open();
  for (const values of [{token: 'wrong', scopeKey: mix.scopeKey}, {token: 'mix:global', scopeKey: 'other'}]) {
    assert.equal(await h.runtime.completeLibraryMixDraft({...values, playlist_id: 'saved'}), false);
    assert.equal(h.runtime.snapshot().draftToken, 'mix:global');
  }
  h.context.fetchAndRender = async (_url, _push, options) => {
    const value = {context_ref: 'a'.repeat(64), surface: {active: 'playlists'},
      playlist_sidebar: {active_playlist_id: 'saved', items: [{playlist_id: 'saved', title: 'Saved mix', allowed_actions: {can_open: true}}]},
      playlist_detail: {playlist_id: 'saved', title: 'Saved mix', track_rows: []}};
    assert.equal(options.shouldApplyResponse(value), true);
    h.context.state.view = value; h.location.href = 'https://albumhaven.test/?surface=playlists&playlist_id=saved';
    return true;
  };
  assert.equal(await h.runtime.completeLibraryMixDraft({token: 'mix:global', scopeKey: mix.scopeKey, playlist_id: 'saved'}), true);
  assert.equal(h.calls.discard, 1); assert.equal(h.runtime.snapshot().draftToken, null);
  assert.equal(h.runtime.snapshot().playlistId, 'saved');
});
