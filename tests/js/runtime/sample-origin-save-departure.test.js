'use strict';
// Actual native Save -> completeLibraryMixDraft -> Settings -> fetchAndRender ->
// browser history. The existing integration fixture supplies the real Top parent.
const test = require('node:test'), assert = require('node:assert/strict');
const {platform, topOwner, A} = require('./sample-origin-integration-fixture.cjs');
const Native = require('./sample-native-fixtures.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const SAVED = A.F.id(80);
function savedPayload(ref = SAVED, canOpen = true) {
  return {ok: true, context_ref: 'a'.repeat(64), surface: {active: 'playlists'},
    playlist_sidebar: {active_playlist_id: ref, items: [{playlist_id: ref, title: 'Saved Sample', allowed_actions: {can_open: canOpen}}]},
    playlist_detail: {playlist_id: ref, revision: '1', title: 'Saved Sample', description: '', playlist_kind: 'ordinary',
      items_complete: true, track_rows: [], allowed_actions: {can_open: true}}};
}
function observeChild(h, register, receiver) {
  return function (owner) {
    return register.call(receiver, {...owner,
      confirmLeave(...args) {h.events.push('confirm-child'); return owner.confirmLeave(...args);},
      discard(...args) {h.events.push('discard-child'); return owner.discard(...args);}});
  };
}
function installActualDestination(t, h) {
  const {c} = h, requests = [], applied = [], historyWrites = [];
  // Entire unchanged production owners are evaluated, not extracted functions.
  // The response-state owner supplies real private preference/read admission.
  for (const file of ['runtime/view-state-helpers.js', 'runtime/response-state-helpers.js',
    'runtime/mobile-navigation.js', 'runtime/browser-navigation-helpers.js',
    'runtime/track-modal-lightbox-helpers.js', 'runtime/gallery-refresh-and-status.js']) h.load(file);
  Object.assign(c, {
    startupMetrics: {markOnce() {}, schedulePaintMark() {}, completeInitialRefresh() {}, completeVisibleInitialRefresh() {}},
    appBootstrap: {},
    // Only unrelated paint is isolated. This terminal sink never approves a
    // response, changes request guards, supplies a marker or writes history.
    renderRelated() {}, hideGalleryOptionsMenu() {}, renderLibraryLoader() {},
    renderView() {}, renderArtistGroups() {}, resumeScanPageGalleryCoverLoads() {},
    applyViewPayload(payload, options) {
      assert.equal(options.isCurrentResponse(), true, 'real fetch owner admitted the response at its sink');
      h.events.push('apply'); applied.push({payload, options, marker: plain(c.history.state?.playlistDraft || null),
        retainedToken: h.runtime.snapshot().retainedDraftToken});
      h.state.view = payload; return payload;
    },
    fetch(url, options = {}) {
      assert.match(url, /^\/view-data\?surface=playlists&playlist_id=/, 'only the real saved destination read is expected');
      const waiting = deferred(), record = {url, options, requestId: h.state.ui.activeViewRequestId, settled: false,
        respond(payload = savedPayload()) {assert.equal(record.settled, false); record.settled = true;
          waiting.resolve({ok: true, status: 200, json: async () => payload});}};
      requests.push(record); h.events.push('fetch'); return waiting.promise;
    },
  });
  const push = c.history.pushState;
  c.history.pushState = function (state, title, url) {
    historyWrites.push({url: new URL(url, c.location.href).href, state: plain(state)}); h.events.push('history');
    return push.call(this, state, title, url);
  };
  // Resolve unfinished fixture transport at teardown; no timers or owner retries.
  t.after(() => {for (const request of requests) if (!request.settled) request.respond({ok: false, error: 'Fixture teardown'});});
  return {requests, applied, historyWrites};
}
async function prepare(t, {parent = true} = {}) {
  const h = parent ? await topOwner(t, {mode: 'inline'}) : await platform(t);
  let title = null;
  if (parent) {
    title = h.form.querySelector('[aria-label="Album Top name"]');
    h.input(title, 'Keep this exact unsaved Top title');
    assert.equal(h.registrations.length, 1);
    const registration = h.registrations[0].handle;
    registration.registerPlaylistChild = observeChild(h, registration.registerPlaylistChild, registration);
  } else {
    const register = h.nav.setPlaylistDraftOwner;
    h.nav.setPlaylistDraftOwner = observeChild(h, register, h.nav);
    const payload = savedPayload(Native.parent().playlist_ref);
    Object.assign(payload.playlist_detail, {revision: Native.parent().revision, title: 'Ordinary saved parent',
      allowed_actions: {can_open: true, can_create_sample: true, can_edit: true, can_rename: true},
      track_rows: [{playlist_item_id: Native.id(71), title: 'Parent track', source_readable: true,
        availability: 'local', allowed_actions: {can_read: true, can_play: true}}]});
    h.state.view = payload;
    h.nav.writeLibraryHistory(`/?surface=playlists&playlist_id=${Native.parent().playlist_ref}`, {...h.c.history.state}, {mode: 'replace'});
    h.runtime.sync();
  }
  const keys = [], receipts = [], saves = [], recoveries = [], completions = [], disposals = [];
  const open = h.runtime.openDraft;
  h.runtime.openDraft = input => open({...input, onDiscard() {disposals.push(input.token); return input.onDiscard();}});
  const uuid = h.c.crypto.randomUUID;
  h.c.crypto.randomUUID = () => {const value = uuid(); keys.push(value); return value;};
  const baseRead = h.providers.readPlaylists;
  const providers = {...h.providers,
    readPlaylists: input => h.state.view.playlist_detail ? Promise.resolve(h.state.view) : baseRead(input),
    ...(parent ? {} : {captureSamplePlaylist: async input => {h.calls.capture.push(input); return Native.captureResult(input);}}),
    createPlaylistFromSelection: async input => {
      saves.push(input); h.calls.save.push(input);
      const receipt = Object.freeze({ok: true, action: 'create', playlist_id: SAVED, revision: '1',
        request_key: input.request_key, scopeKey: input.scopeKey});
      receipts.push(receipt); h.events.push('durable-save'); return {status: 'ready', data: receipt};
    },
    recoverPlaylistCreation: async input => {recoveries.push(input); assert.fail('An acknowledged Save needs navigation retry, not mutation recovery');},
  };
  h.facade.configureProviders(providers); await h.settle();
  const complete = h.runtime.completeLibraryMixDraft;
  h.runtime.completeLibraryMixDraft = function (input) {
    const record = {input, settled: false}; completions.push(record);
    return Promise.resolve(complete.call(this, input)).then(value => {record.settled = true; record.value = value; return value;},
      error => {record.settled = true; record.error = error; throw error;});
  };
  const destination = installActualDestination(t, h);
  const source = {view: h.state.view, form: h.form, title, titleValue: title?.value,
    surface: h.sourceSurface};
  if (parent) h.click(h.sourceButton()); else h.click(h.named('Sample Playlist', h.host));
  await h.settle(); if (parent) h.assertSetup(); else h.setup(); await h.generate();
  assert.equal(h.calls.capture.length, 1); assert.equal(saves.length, 0);
  const token = h.runtime.snapshot().retainedDraftToken, marker = plain(h.c.history.state.playlistDraft);
  const start = {url: h.c.location.href, history: h.history.mark(), writes: destination.historyWrites.length, documentTitle: h.document.title};
  assert.ok(token); assert.equal(h.calls.draft[0].parentRegistration ?? null, parent ? h.registrations[0].handle : null);
  h.events.length = 0;
  return {...h, ...destination, parent, source, start, token, marker, keys, receipts, saves, recoveries, completions, disposals,
    async save() {h.click(h.named('Save as playlist', h.host)); await h.settle();},
    assertOneSave(keyCount = keys.length) {
      assert.equal(saves.length, 1); assert.equal(receipts.length, 1); assert.equal(h.calls.capture.length, 1);
      assert.equal(receipts[0].request_key, saves[0].request_key); assert.equal(receipts[0].playlist_id, SAVED);
      assert.equal(keys.length, keyCount, 'navigation attempts cannot allocate a new command key');
      assert.equal(recoveries.length, 0);
      assert.ok(completions.every(({input}) => input.playlist_id === SAVED && input.token === token
        && input.scopeKey === receipts[0].scopeKey && input.sample === true));
    },
  };
}
function assertRetained(h) {
  assert.equal(h.state.view, h.source.view); assert.equal(h.runtime.snapshot().retainedDraftToken, h.token);
  assert.deepEqual(plain(h.c.history.state.playlistDraft), h.marker); assert.equal(h.c.location.href, h.start.url);
  assert.equal(h.history.index(), h.start.history.index); assert.equal(h.historyWrites.length, h.start.writes);
  assert.equal(h.document.querySelector('form[aria-label="Edit Album Top"]'), h.source.form);
  assert.equal(h.source.form.querySelector('[aria-label="Album Top name"]'), h.source.title);
  assert.equal(h.source.title.value, h.source.titleValue); assert.equal(h.document.title, h.start.documentTitle);
  assert.equal(h.source.form.isConnected, true); assert.equal(h.hidden(h.source.surface), true); assert.equal(h.inactive(h.source.surface), true);
  assert.equal(h.calls.draft[0].isCurrent(), true); assert.deepEqual(h.disposals, []);
  assert.equal(h.events.includes('discard-child'), false); assert.equal(h.events.includes('discard-parent'), false);
}
function assertOpened(h, expectedSaveKeys) {
  h.assertOneSave(expectedSaveKeys);
  assert.equal(h.applied.length, 1); assert.equal(h.applied[0].payload.playlist_detail.playlist_id, SAVED);
  assert.equal(h.runtime.snapshot().playlistId, SAVED); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  assert.equal(h.c.history.state.playlistDraft, undefined);
  assert.equal(new URL(h.c.location.href).searchParams.get('playlist_id'), SAVED);
  assert.equal(h.historyWrites.length, h.start.writes + 1); assert.equal(h.history.index(), h.start.history.index + 1);
  assert.equal(h.events.filter(value => value === 'discard-child').length, h.parent ? 1 : 0);
  assert.deepEqual(h.disposals, [h.token]);
  assert.equal(h.completions.at(-1).settled, true); assert.equal(h.completions.at(-1).value, true);
  assert.deepEqual(h.history.traversals, [], 'saved destination is not a retained-parent Back');
}

test('active real Top child cannot expose the single-level retained marker bypass', async t => {
  const h = await prepare(t);
  assert.equal(h.nav.retainPlaylistDraftNavigation(h.token, () => assert.fail('relationship bypass callback')), false);
  assert.equal(h.nav.retainedPlaylistDraft(), null);
  assert.equal(h.nav.isPlaylistDraftCurrent(h.marker), true); assert.deepEqual(h.events, []);
  assert.equal(h.requests.length, 0); assert.equal(h.saves.length, 0); assertRetained(h);
});

test('durable Sample Save parent cancellation preserves the exact draft and receipt; Open saved retries only navigation', async t => {
  const h = await prepare(t), first = deferred(), second = deferred(); let asks = 0;
  t.after(() => {first.resolve(false); second.resolve(false);});
  h.c.showAppConfirmDialog = () => (++asks === 1 ? first.promise : second.promise);
  await h.save(); const keyCount = h.keys.length, receipt = h.receipts[0], request = h.saves[0];
  assert.deepEqual(h.events, ['durable-save', 'confirm-child', 'confirm-parent']); assertRetained(h);
  assert.equal(h.requests.length, 0); assert.equal(h.applied.length, 0);
  first.resolve(false); await h.settle(); assertRetained(h); h.assertOneSave(keyCount);
  assert.equal(h.completions[0].value, false); assert.equal(h.completions[0].settled, true);
  assert.equal(h.named('Save as playlist', h.host).disabled, true);
  assert.equal(h.named('Check original Save', h.host).disabled, true);
  assert.equal(h.named('Open saved playlist', h.host).disabled, false);
  h.click(h.named('Open saved playlist', h.host)); await h.settle();
  assert.equal(asks, 2); assertRetained(h); assert.equal(h.requests.length, 0);
  assert.equal(h.receipts[0], receipt); assert.equal(h.saves[0], request); h.assertOneSave(keyCount);
  assert.deepEqual(h.events, ['durable-save', 'confirm-child', 'confirm-parent', 'confirm-child', 'confirm-parent']);
  second.resolve(true); await h.settle();
  assert.deepEqual(h.events, ['durable-save', 'confirm-child', 'confirm-parent', 'confirm-child', 'confirm-parent',
    'discard-child', 'discard-parent', 'fetch']);
  assert.equal(h.requests.length, 1); assert.equal(h.applied.length, 0);
  h.requests[0].respond(); await h.settle(); assertOpened(h, keyCount);
  assert.equal(h.events.filter(value => value === 'discard-parent').length, 1);
  assert.equal(h.applied[0].marker, null); assert.equal(h.applied[0].retainedToken, null);
  assert.equal(h.svc.count('execute'), 0); assert.equal(h.receipts[0], receipt);
  h.nav.destroy(); await h.settle();
  assert.equal(h.events.filter(value => value === 'discard-parent').length, 1);
  assert.equal(h.events.filter(value => value === 'discard-child').length, 1); h.assertOneSave(keyCount);
});

test('accepted real Top Sample Save confirms child then parent before once-only cleanup and authorized destination', async t => {
  const h = await prepare(t), parent = deferred(); h.c.showAppConfirmDialog = () => parent.promise;
  t.after(() => parent.resolve(false));
  await h.save(); const keyCount = h.keys.length;
  assert.deepEqual(h.events, ['durable-save', 'confirm-child', 'confirm-parent']); assertRetained(h);
  assert.equal(h.requests.length, 0); parent.resolve(true); await h.settle();
  assert.deepEqual(h.events, ['durable-save', 'confirm-child', 'confirm-parent', 'discard-child', 'discard-parent', 'fetch']);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(h.state.view, h.source.view);
  assert.equal(h.requests[0].options.credentials, 'same-origin'); assert.equal(h.requests[0].options.cache, 'no-store');
  assert.equal(h.requests[0].options.headers['X-AlbumHaven-Context'], 'a'.repeat(64));
  h.requests[0].respond(); await h.settle(); assertOpened(h, keyCount);
  assert.deepEqual(h.events, ['durable-save', 'confirm-child', 'confirm-parent', 'discard-child', 'discard-parent', 'fetch', 'apply', 'history']);
  assert.equal(h.applied[0].marker, null); assert.equal(h.applied[0].retainedToken, null);
  assert.equal(h.svc.count('execute'), 0); assert.equal(h.hidden(h.source.surface), true);
});

for (const invalid of ['wrong saved identity', 'missing destination read grant']) test(`accepted departure rejects ${invalid} without destination or duplicate Save`, async t => {
  const h = await prepare(t); h.c.showAppConfirmDialog = async () => true;
  await h.save(); const keyCount = h.keys.length, before = h.c.location.href, writes = h.historyWrites.length;
  assert.deepEqual(h.events, ['durable-save', 'confirm-child', 'confirm-parent', 'discard-child', 'discard-parent', 'fetch']);
  assert.equal(h.requests.length, 1);
  h.requests[0].respond(invalid === 'wrong saved identity' ? savedPayload(A.F.id(81)) : savedPayload(SAVED, false));
  await h.settle(); h.assertOneSave(keyCount);
  assert.equal(h.applied.length, 0); assert.equal(h.state.view, h.source.view);
  assert.equal(h.c.location.href, before); assert.equal(h.historyWrites.length, writes);
  assert.equal(h.runtime.snapshot().retainedDraftToken, null); assert.equal(h.completions[0].settled, true);
  assert.notEqual(h.completions[0].value, true);
  assert.equal(h.events.filter(value => value === 'discard-parent').length, 1);
  assert.equal(h.events.filter(value => value === 'discard-child').length, 1);
});

for (const changed of ['private scope', 'destination URL and position']) test(`post-disposal saved destination response loses authority after ${changed} changes`, async t => {
  const h = await prepare(t); h.c.showAppConfirmDialog = async () => true;
  await h.save(); const keyCount = h.keys.length;
  assert.equal(h.requests.length, 1); assert.equal(h.runtime.snapshot().retainedDraftToken, null);
  if (changed === 'private scope') {h.shell.dataset.nativeLibraryId = '6'; h.runtime.sync();}
  else h.c.history.replaceState({...h.c.history.state, albumHavenNavigationPosition: 999}, '', '/?surface=albums&newer=1');
  const url = h.c.location.href, state = plain(h.c.history.state), writes = h.historyWrites.length;
  h.requests[0].respond(); await h.settle(); h.assertOneSave(keyCount);
  assert.equal(h.applied.length, 0); assert.equal(h.state.view, h.source.view);
  assert.equal(h.c.location.href, url); assert.deepEqual(plain(h.c.history.state), state);
  assert.equal(h.historyWrites.length, writes); assert.equal(h.completions[0].settled, true); assert.notEqual(h.completions[0].value, true);
  assert.equal(h.events.filter(value => value === 'discard-parent').length, 1);
  assert.equal(h.events.filter(value => value === 'discard-child').length, 1);
});

test('ordinary parentless Sample completion keeps its real retained transport and releases once after successful admission', async t => {
  const h = await prepare(t, {parent: false}); h.c.showAppConfirmDialog = () => assert.fail('no dirty retained parent exists');
  assert.equal(h.nav.retainPlaylistDraftNavigation(h.token, () => {
    assert.deepEqual(plain(h.nav.retainedPlaylistDraft()), h.marker); return true;
  }), true);
  await h.save(); const keyCount = h.keys.length;
  assert.equal(h.requests.length, 1); assert.equal(h.runtime.snapshot().retainedDraftToken, h.token);
  assert.deepEqual(h.events, ['durable-save', 'fetch']); assert.equal(h.applied.length, 0);
  h.requests[0].respond(); await h.settle(); assertOpened(h, keyCount);
  assert.deepEqual(h.applied[0].marker, h.marker); assert.equal(h.applied[0].retainedToken, h.token);
  assert.equal(h.events.includes('confirm-parent'), false); assert.equal(h.events.includes('discard-parent'), false);
  assert.equal(h.events.includes('confirm-child'), false);
  // Parentless release disposes through runtime.releaseDraft, not Settings discard.
  assert.deepEqual(h.disposals, [h.token]);
  h.nav.destroy(); await h.settle(); assert.deepEqual(h.disposals, [h.token]);
  h.assertOneSave(keyCount);
});
