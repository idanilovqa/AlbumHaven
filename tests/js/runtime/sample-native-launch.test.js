'use strict';
// Actual native mount and runtime lifecycle under the repository's bounded DOM
// platform. These are unit integration contracts, NOT functional/E2E acceptance.
const test = require('node:test'), assert = require('node:assert/strict');
const {nativeMixFixture} = require('./library-mix-react-fixture.cjs');
const {installMouseEventDetail} = require('./sample-browser-platform.cjs');
const {historyPort} = require('./sample-origin-back-fixtures.cjs');
const {id, deferred, parent, options, entries, captured, captureResult, readResult, representatives} = require('./sample-native-fixtures.cjs');
async function mounted(t, overrides = {}) {
  const h = await nativeMixFixture(t); h.installNavigation(); installMouseEventDetail(h.c);
  let keySequence = 1000;
  h.c.crypto.randomUUID = () => id(keySequence++);
  const {mountPlaylists} = await import('../../../music_app/static/js/playlists/native.mjs');
  const calls = {capture: [], save: [], releases: [], navigation: [], discards: []};
  const detail = {playlist_id: id(70), revision: '3', title: 'Saved parent', playlist_kind: 'ordinary', items_complete: true,
    allowed_actions: {can_open: true, can_play: true, can_create_sample: true, can_edit: true, can_rename: true},
    track_rows: [{playlist_item_id: id(71), title: 'Parent track', availability: 'local', source_readable: true,
      allowed_actions: {can_read: true, can_play: true}}]};
  const payload = {context_ref: 'a'.repeat(64), surface: {active: 'playlists'},
    playlist_sidebar: {active_playlist_id: id(70), items: [{playlist_id: id(70), title: 'Saved parent', allowed_actions: {can_open: true}}]},
    playlist_detail: detail};
  h.state.view = payload; h.runtime.sync();
  const providers = {readPlaylists: async () => payload,
    readSamplePlaylistRepresentatives: async input => representatives(input.scopeKey),
    captureSamplePlaylist: async input => {calls.capture.push(input); return captureResult(input);},
    readSamplePlaylist: async input => readResult(input),
    hasPendingPlaylistOperation: () => false,
    createPlaylistFromSelection: async input => {calls.save.push(input); return {status: 'ready', data: {ok: true, action: 'create',
      playlist_id: id(80), revision: '1', changed: true, request_key: input.request_key, scopeKey: input.scopeKey}};}, ...overrides};
  const originalRelease = h.runtime.releaseDraft;
  h.runtime.releaseDraft = token => {calls.releases.push(token); return originalRelease(token);};
  const originalOpen = h.runtime.openDraft;
  h.runtime.openDraft = input => originalOpen({...input, onDiscard: () => {
    calls.discards.push(input.token); return input.onDiscard?.();
  }});
  // Only merge the same real native presentation functions used by the existing
  // Mix fixture; playback remains the actual Sample runtime implementation.
  const createRuntime = h.runtime.createSamplePlaylistRuntime;
  h.runtime.createSamplePlaylistRuntime = input => {
    const value = createRuntime(input);
    for (const key of ['buttonHtml', 'actionHtml', 'iconHtml', 'tableHtml', 'artboxHtml', 'albumTrackRow', 'escapeHtml', 'alertHtml', 'navigationItemHtml', 'openChoice'])
      value[key] = h.runtime[key];
    return value;
  };
  h.c.AlbumHavenPlaylistRuntime = h.runtime;
  const owner = mountPlaylists({host: h.host, runtime: h.runtime, providers, isRuntimeCurrent: () => h.c.AlbumHavenPlaylistRuntime === h.runtime});
  t.after(() => owner.dispose()); await h.settle();
  return {...h, owner, providers, detail, sampleCalls: calls,
    open: (patch = {}) => owner.openSamplePlaylist({parent: parent(), options: options(), ...patch}),
    async generate() {h.click(h.named('Generate')); await h.settle();}};
}

test('actual native launch opens one temporary owner and Generate/Save are distinct explicit actions', async t => {
  const h = await mounted(t); assert.equal(h.open(), true); await h.settle();
  const token = h.runtime.snapshot().retainedDraftToken; assert.ok(token); assert.equal(h.open(), false);
  assert.equal(h.sampleCalls.save.length, 0); assert.equal(h.sampleCalls.capture.length, 0);
  assert.ok(h.named('Generate')); await h.generate(); assert.equal(h.sampleCalls.capture.length, 1);
  assert.equal(h.sampleCalls.save.length, 0); assert.ok(h.host.querySelector('#playlist-tracks[role="table"]'));
  assert.equal(h.host.querySelectorAll('[data-playlists-play]').length, 3);
  assert.equal(h.named('Save as playlist').disabled, false); assert.equal(h.named('Play').disabled, false);
  assert.doesNotMatch(h.host.textContent, /updates automatically|Last\.fm/);
});

for (const mismatch of ['parent', 'revision', 'scope', 'unreadable', 'incomplete']) test(`native launch refuses ${mismatch} parent without capture or token`, async t => {
  const h = await mounted(t);
  let input = parent();
  if (mismatch === 'parent') input.playlist_ref = id(99);
  else if (mismatch === 'revision') input.revision = '4';
  else if (mismatch === 'scope') h.shell.dataset.nativeAccountId = '9';
  else {
    if (mismatch === 'unreadable') h.detail.allowed_actions.can_open = false;
    else h.detail.items_complete = false;
    h.runtime.sync(); await h.owner.refresh(); await h.settle();
  }
  assert.equal(h.open({parent: input}), false); assert.equal(h.sampleCalls.capture.length, 0);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null);
});

test('Sample toolbar button opens temporary setup and never invokes durable mutation provider', async t => {
  let legacy = 0;
  const h = await mounted(t, {createSamplePlaylist: () => {legacy++; throw new Error('Old durable mutation route');}});
  h.click(h.named('Sample Playlist')); await h.settle();
  assert.equal(legacy, 0); assert.equal(h.sampleCalls.save.length, 0);
  assert.ok(h.runtime.snapshot().retainedDraftToken); assert.ok(h.named('Generate'));
});

test('failed destination open retains acknowledged Save; repeated Open only navigates with ordinary semantics', async t => {
  const h = await mounted(t), navigations = [];
  h.c.fetchAndRender = async (url, _push, settings) => {navigations.push({url, settings}); return false;};
  assert.equal(h.open(), true); await h.settle(); await h.generate();
  const token = h.runtime.snapshot().retainedDraftToken;
  h.click(h.named('Save as playlist')); await h.settle();
  assert.equal(h.sampleCalls.save.length, 1); assert.equal(h.runtime.snapshot().retainedDraftToken, token);
  assert.equal(navigations.length, 1); assert.match(navigations[0].url, new RegExp(id(80)));
  assert.equal(h.named('Save as playlist').disabled, true);
  h.click(h.named('Open saved playlist')); await h.settle();
  assert.equal(navigations.length, 2); assert.equal(navigations[1].url, navigations[0].url);
  assert.equal(h.sampleCalls.save.length, 1); assert.equal(h.sampleCalls.capture.length, 1);
  assert.equal(h.runtime.snapshot().retainedDraftToken, token);
  assert.doesNotMatch(h.host.textContent, /already saved this playlist|Loved and Obsessed/);
});

test('actual close uses temporary confirmLeave and cannot forget provider-owned uncertain Save', async t => {
  let pending = false;
  const h = await mounted(t, {hasPendingPlaylistOperation: () => pending,
    createPlaylistFromSelection: async () => {pending = true; throw Object.assign(new Error('Lost response'), {status: 'unknown'});}});
  assert.equal(h.open(), true); await h.settle(); await h.generate();
  const token = h.runtime.snapshot().retainedDraftToken;
  h.click(h.named('Save as playlist')); await h.settle();
  await h.runtime.closeDraft(token); await h.settle();
  assert.equal(pending, true); assert.equal(h.runtime.snapshot().retainedDraftToken, token);
});

for (const action of ['close', 'dispose', 'replacement', 'scope']) test(`late native capture cannot revive after ${action}`, async t => {
  const waiting = deferred(), entered = deferred(); let input;
  const h = await mounted(t, {captureSamplePlaylist: async value => {input = value; entered.resolve(); return waiting.promise;}});
  const history = action === 'close' ? historyPort(h) : null;
  const parentEntry = history?.mark();
  assert.equal(h.open(), true); await h.settle(); h.click(h.named('Generate')); await entered.promise;
  const token = h.runtime.snapshot().retainedDraftToken;
  if (action === 'dispose') h.owner.dispose();
  else if (action === 'replacement') h.owner.configureProviders({...h.providers, readSamplePlaylist: async () => {throw new Error('replacement');}});
  else if (action === 'scope') {h.shell.dataset.nativeAccountId = '9'; h.runtime.sync();}
  else {h.runtime.confirmDraft = async () => true; await h.runtime.closeDraft(token);}
  waiting.resolve(captureResult(input)); await h.settle();
  assert.equal(input.signal.aborted, true); assert.equal(h.sampleCalls.save.length, 0);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  assert.equal(h.host.querySelector('main[aria-label="Temporary Sample Playlist"]'), null);
  if (history) history.assertReturned(parentEntry);
});

test('empty native capture preserves diagnostics and Back while Save and Play stay disabled', async t => {
  const h = await mounted(t, {captureSamplePlaylist: async input => captureResult(input, {entries: [], group_counts: [],
    diagnostics: [[3, 'length_excluded']], native_actions: {can_save: false, can_play: false}})});
  assert.equal(h.open(), true); await h.settle(); await h.generate();
  assert.equal(h.named('Save as playlist').disabled, true); assert.equal(h.named('Play').disabled, true);
  assert.ok(h.runtime.snapshot().retainedDraftToken); assert.equal(h.sampleCalls.save.length, 0);
  assert.match(h.host.textContent, /length|excluded|No tracks/i);
});

test('dirty saved parent cannot be silently sampled as its saved revision', async t => {
  const h = await mounted(t), title = h.host.querySelector('input[aria-label="Playlist title"]');
  assert.ok(title); assert.equal(title.disabled, false);
  title.value = 'Unsaved changed parent'; title.dispatchEvent(new h.c.Event('input', {bubbles: true})); await h.settle();
  assert.match(h.host.textContent, /Unsaved draft/);
  assert.equal(h.open(), false); assert.equal(h.sampleCalls.capture.length, 0); assert.equal(h.sampleCalls.save.length, 0);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(title.value, 'Unsaved changed parent');
});

test('true-empty current parent cannot open Sample even with a stale positive capability hint', async t => {
  const h = await mounted(t); h.detail.track_rows = [];
  h.runtime.sync(); await h.owner.refresh(); await h.settle();
  assert.equal(h.open(), false); assert.equal(h.sampleCalls.capture.length, 0);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null);
});

test('actual native Sample row Play starts the clicked occurrence in captured order', async t => {
  const h = await mounted(t); assert.equal(h.open(), true); await h.settle(); await h.generate();
  h.c.fetch = async (url, input) => {
    h.calls.requests.push({url, ...input}); assert.equal(url, '/playlists/creation-source/sample/native-queue');
    return h.reply(JSON.parse(input.body), {mutate: value => {
      value.data.source_protocol = 'sample_playlist_selection_v1'; value.data.source.kind = 'playlist'; return value;
    }});
  };
  const buttons = [...h.host.querySelectorAll('[data-playlists-play]')]; assert.equal(buttons.length, 3);
  assert.equal(new h.c.MouseEvent('click').detail, 0, 'programmatic MouseEvent default is zero');
  buttons[2].dispatchEvent(new h.c.MouseEvent('click', {bubbles: true, cancelable: true, detail: 2}));
  await h.settle();
  assert.equal(h.calls.requests.length, 0, 'second-click detail does not bypass the actual row gate');
  assert.equal(h.calls.starts.length, 0);
  h.click(buttons[2]); await h.settle();
  assert.equal(h.calls.starts.length, 1); assert.equal(h.calls.starts[0].playlistItemId, id(13));
  assert.deepEqual(JSON.parse(h.calls.requests[0].body).entry_refs, [id(11), id(12), id(13)]);
  assert.equal(JSON.parse(h.calls.requests[0].body).starting_entry_ref, id(13));
  assert.equal(h.state.player.playbackQueue.currentIndex, 2); assert.equal(h.state.player.playbackQueue.playlistId, null);
  assert.equal(h.sampleCalls.save.length, 0);
});

test('successful Sample Save admits ordinary destination then releases its temporary token once', async t => {
  const h = await mounted(t), waiting = deferred(), completion = []; let admitted = 0, retainedAtAdmission;
  const originalComplete = h.runtime.completeLibraryMixDraft;
  h.runtime.completeLibraryMixDraft = input => {completion.push(input); return originalComplete(input);};
  t.after(() => waiting.resolve(false));
  h.c.fetchAndRender = async (url, _push, navigation) => {
    if (await waiting.promise !== true) return false;
    const payload = {context_ref: h.c.AlbumHavenPrivateUITransport.context(), surface: {active: 'playlists'},
      playlist_sidebar: {active_playlist_id: id(80), items: [{playlist_id: id(80), title: 'Saved Sample', allowed_actions: {can_open: true}}]},
      playlist_detail: {playlist_id: id(80), revision: '1', title: 'Saved Sample', playlist_kind: 'ordinary', track_rows: [], allowed_actions: {can_open: true}}};
    assert.equal(navigation.shouldApplyResponse(payload), true); admitted++;
    retainedAtAdmission = h.runtime.snapshot().retainedDraftToken;
    // Same bounded response admission used by existing actual native navigation
    // tests. This is not a substitute for production fetch/browser E2E.
    h.state.view = payload;
    h.c.AlbumHavenSettingsNavigation.instance.writeLibraryHistory(`/?${new URL(url, h.c.location.href).searchParams}`,
      {...h.c.history.state}, {mode: 'push'});
    return true;
  };
  assert.equal(h.open(), true); await h.settle(); await h.generate();
  const token = h.runtime.snapshot().retainedDraftToken;
  h.click(h.named('Save as playlist')); await h.settle();
  assert.equal(completion.length, 1); assert.notEqual(completion[0].artistLoved, true);
  assert.equal(h.runtime.snapshot().retainedDraftToken, token); assert.deepEqual(h.sampleCalls.discards, []);
  waiting.resolve(true); await h.settle();
  assert.equal(admitted, 1); assert.equal(retainedAtAdmission, token);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(h.runtime.snapshot().playlistId, id(80));
  assert.deepEqual(h.sampleCalls.discards, [token]); assert.equal(h.sampleCalls.save.length, 1);
  assert.equal(h.c.history.state.playlistDraft, undefined);
  h.owner.dispose(); await h.settle();
  assert.deepEqual(h.sampleCalls.discards, [token]); assert.equal(h.sampleCalls.save.length, 1);
});

test('sorted native Sample row Play retains author order and clicked start without changing Save order', async t => {
  const h = await mounted(t, {captureSamplePlaylist: async input => captureResult(input, {
    entries: entries().map((row, index) => ({...row, duration_seconds: 90 - index * 30}))})});
  assert.equal(h.open(), true); await h.settle(); await h.generate();
  const before = [...h.host.querySelectorAll('[data-playlists-play]')];
  assert.deepEqual(before.map(button => button.getAttribute('aria-label')), ['Play Track 11', 'Play Track 12', 'Play Track 13']);
  h.click(h.host.querySelector('[data-cdt-sort="duration"]')); await h.settle();
  const sorted = [...h.host.querySelectorAll('[data-playlists-play]')];
  assert.deepEqual(sorted.map(button => button.getAttribute('aria-label')), ['Play Track 13', 'Play Track 12', 'Play Track 11']);
  h.c.fetch = async (url, input) => {
    h.calls.requests.push({url, ...input}); assert.equal(url, '/playlists/creation-source/sample/native-queue');
    return h.reply(JSON.parse(input.body), {mutate: value => {
      value.data.source_protocol = 'sample_playlist_selection_v1'; value.data.source.kind = 'playlist'; return value;
    }});
  };
  h.click(sorted[0]); await h.settle();
  assert.equal(h.calls.starts.length, 1); assert.equal(h.calls.starts[0].playlistItemId, id(13));
  assert.deepEqual(JSON.parse(h.calls.requests[0].body).entry_refs, [id(11), id(12), id(13)]);
  assert.equal(JSON.parse(h.calls.requests[0].body).starting_entry_ref, id(13));
  assert.deepEqual(Array.from(h.state.player.playbackQueue.tracks, row => row.playlistItemId), [id(11), id(12), id(13)]);
  assert.equal(h.state.player.playbackQueue.currentIndex, 2);
  h.c.fetchAndRender = async () => false;
  h.click(h.named('Save as playlist')); await h.settle();
  assert.equal(h.sampleCalls.save.length, 1); assert.deepEqual(h.sampleCalls.save[0].entry_refs, [id(11), id(12), id(13)]);
});
