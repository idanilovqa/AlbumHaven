'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {actionFixture, admit, ready, ordinary, mainUrl, nativeReply, fullAlbum, completeDetails,
  source, outcome, deferred, A, B, assertPrivateDataAbsent} = require('./search-native-fixtures/native-actions.cjs');

for (const attribute of ['nativeAccountId', 'nativeLibraryId', 'privateUiContext']) {
  for (const phase of ['fetch', 'json']) test(`${attribute} A-B-A during native ${phase} permanently retires the captured Search action`, async t => {
    const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
    const work = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0]));
    const reply = nativeReply(h, 1), body = phase === 'json' ? h.requests[1].holdJson() : null;
    if (body) await h.requests[1].jsonStarted;
    const original = h.shell.dataset[attribute]; h.shell.dataset[attribute] = attribute === 'privateUiContext' ? B : '99'; h.shell.dataset[attribute] = original;
    if (body) body.resolve(reply); else h.reply(1, reply);
    assert.equal((await work).error.name, 'AbortError'); await h.flush();
    assert.equal(h.activations.length, 0); assert.equal(h.runtime().isCurrent(snapshot), false); assertPrivateDataAbsent(h);
  });
}

test('a newer actual player selection wins over a delayed Search play resolution', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const old = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0]));
  const newer = outcome(h.c.playTrackFromPayload({path: '/library/newer-choice.flac', src: '/track?path=%2Flibrary%2Fnewer-choice.flac', title: 'Newer user choice'}));
  h.reply(1, nativeReply(h, 1)); assert.equal((await old).error.name, 'AbortError'); await newer;
  assert.equal(h.activations.length, 0); assert.equal(h.streams.length, 1);
  assert.equal(h.streams[0][0].path, '/library/newer-choice.flac');
});

test('two Search play clicks retain only the exact newer request and binding', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const first = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0]));
  const second = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[1]));
  assert.equal(h.requests[1].options.signal.aborted, true); assert.equal(h.requests[2].options.signal.aborted, false);
  h.reply(1, {error: 'forbidden'}, 403); assert.equal((await first).error.name, 'AbortError');
  h.reply(2, nativeReply(h, 2, {path: '/library/twelve/current.flac'})); assert.equal((await second).value, true);
  assert.equal(h.activations.length, 1); assert.equal(h.streams[0][0].path, '/library/twelve/current.flac');
  assert.equal(h.runtime().canPlayTrack(snapshot, snapshot.result.tracks[1]), true);
});

for (const status of [401, 403, 404]) test(`obsolete ${status} from an old native action cannot revoke a new result`, async t => {
  const h = await actionFixture(t), before = await admit(h, ready({presentation: 'tracks'}));
  const old = outcome(h.runtime().playTrack(before, before.result.tracks[0]));
  const successor = await admit(h, ready({query: ':obsessed', presentation: 'tracks'}));
  h.reply(1, {error: 'forbidden'}, status); assert.equal((await old).error.name, 'AbortError');
  assert.equal(h.runtime().isCurrent(successor), true);
  assert.equal(h.runtime().canPlayTrack(successor, successor.result.tracks[0]), true);
  assert.equal(h.host.hidden, false); assert.equal(h.activations.length, 0);
});

test('current native session denial retires Search and every native selection source', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), lease = source(h, snapshot);
  const work = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0])); h.reply(1, {error: 'unauthenticated'}, 401);
  assert.equal((await work).error.status, 401); assert.equal(h.runtime().isCurrent(snapshot), false); assert.equal(lease.snapshot(), null);
  assert.equal(h.host.hidden, true); assert.equal(h.activations.length, 0);
});

test('a current Media denial cannot revoke a separately authorized Browse details binding', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), row = snapshot.result.tracks[0];
  const details = outcome(h.runtime().openAlbum(snapshot, row));
  h.reply(1, nativeReply(h, 1)); await h.flush(); h.reply(2, nativeReply(h, 2)); await h.flush();
  assert.equal(h.requests[3].url, '/album-details?album_key=native-album-eleven');
  const play = outcome(h.runtime().playTrack(snapshot, row)); h.reply(4, {error: 'forbidden'}, 403);
  assert.equal((await play).error.status, 403);
  h.reply(3, {ok: true, album: fullAlbum()}); assert.equal((await details).value, true);
  assert.equal(h.modal.hidden, false); assert.equal(h.c.getTrackModalSourcePageOwner().isCurrent(), true);
  assert.equal(h.runtime().canPlayTrack(snapshot, row), false); assert.equal(h.runtime().canOpenAlbum(snapshot, row), true);
});

test('older details denial cannot revoke the same row newer details flow', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), row = snapshot.result.tracks[0];
  const first = outcome(h.runtime().openAlbum(snapshot, row)); h.reply(1, nativeReply(h, 1)); await h.flush();
  const second = outcome(h.runtime().openAlbum(snapshot, row)); h.reply(3, nativeReply(h, 3)); await h.flush();
  h.reply(2, {error: 'forbidden'}, 403); assert.equal((await first).error.name, 'AbortError');
  h.reply(4, nativeReply(h, 4)); await h.flush(); h.reply(5, {ok: true, album: fullAlbum()});
  assert.equal((await second).value, true); assert.equal(h.opens.length, 1); assert.equal(h.runtime().canOpenAlbum(snapshot, row), true);
});

for (const stage of ['resolution', 'reauthorization', 'hydration']) test(`source replacement during details ${stage} prevents native presentation`, async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const work = outcome(h.runtime().openAlbum(snapshot, snapshot.result.tracks[0]));
  if (stage !== 'resolution') {h.reply(1, nativeReply(h, 1)); await h.flush();}
  if (stage === 'hydration') {h.reply(2, nativeReply(h, 2)); await h.flush();}
  const pending = stage === 'resolution' ? 1 : stage === 'reauthorization' ? 2 : 3;
  const value = stage === 'hydration' ? {ok: true, album: fullAlbum()} : nativeReply(h, pending);
  const successor = await admit(h, ready({query: ':obsessed'}));
  h.reply(pending, value); assert.equal((await work).error.name, 'AbortError');
  assert.equal(h.opens.length, 0); assert.equal(h.modal.hidden, true); assert.equal(h.runtime().isCurrent(successor), true);
});

test('deferred foreground navigation keeps current action authority until the real request claims its slot', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), decision = deferred();
  const form = h.c.openReactFormDialog({title: 'Pending form', pageId: 'search-action-deferral', beforeDismiss: () => decision.promise});
  const next = ready({query: ':obsessed'}), navigation = h.read(mainUrl(next), {}, true);
  assert.equal(h.requests.length, 1); assert.equal(h.runtime().canPlayTrack(snapshot, snapshot.result.tracks[0]), true);
  const play = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0])); assert.equal(h.requests.length, 2);
  decision.resolve(true); await h.flush(); assert.equal(h.requests.length, 3); assert.equal(h.requests[1].options.signal.aborted, true);
  h.reply(1, nativeReply(h, 1)); assert.equal((await play).error.name, 'AbortError');
  h.reply(2, next); assert.equal((await navigation).value, true); await form.promise; assert.equal(h.activations.length, 0);
});

test('real queued foreground dispatch retires a just-admitted action without old action cleanup stealing its source', async t => {
  const h = await actionFixture(t), one = ready({presentation: 'tracks'}), two = ready({query: ':obsessed', presentation: 'tracks'});
  const first = h.read(mainUrl(one)); await h.read(mainUrl(two), {interruptCurrent: false});
  let action, request;
  const stop = h.runtime().subscribe(() => {const snapshot = h.runtime().snapshot();
    if (!action && snapshot.status === 'ready' && snapshot.result.tracks.length) {
      action = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0])); request = h.requests.at(-1);
    }}); t.after(stop);
  h.reply(0, one); await first; await h.flush(); assert.ok(action); assert.equal(request.options.signal.aborted, true);
  const index = h.requests.indexOf(request); h.reply(index, nativeReply(h, index)); assert.equal((await action).error.name, 'AbortError');
  const successorIndex = h.requests.findIndex(value => new URL(value.url, h.location).searchParams.get('q') === ':obsessed');
  h.reply(successorIndex, two); await h.invocations.at(-1).outcome;
  assert.equal(h.runtime().snapshot().status, 'ready'); assert.equal(h.runtime().canPlayTrack(h.runtime().snapshot(), h.runtime().snapshot().result.tracks[0]), true);
  assert.equal(h.activations.length, 0);
});

for (const replacement of ['host', 'runtime', 'disposal']) test(`${replacement} retirement aborts the exact native request before late settlement`, async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const work = outcome(h.runtime().playTrack(snapshot, snapshot.result.tracks[0]));
  if (replacement === 'host') {h.host.remove(); await h.flush();}
  else if (replacement === 'runtime') {h.replaceRuntime(); await h.flush();}
  else (await h.mount()).dispose();
  h.reply(1, nativeReply(h, 1)); assert.equal((await work).error.name, 'AbortError');
  assert.equal(h.activations.length, 0); assert.equal(h.requests[1].options.signal.aborted, true);
});

test('Back and Forward discard native bindings and obtain fresh Search authority before another action', async t => {
  const h = await actionFixture(t), first = await admit(h, ready({presentation: 'tracks'}), {push: true});
  const old = outcome(h.runtime().playTrack(first, first.result.tracks[0]));
  await admit(h, ready({query: ':obsessed'}), {push: true});
  h.history.back(); const backRequest = h.requests.length - 1;
  assert.equal(h.runtime().canPlayTrack(first, first.result.tracks[0]), false);
  h.reply(1, nativeReply(h, 1)); assert.equal((await old).error.name, 'AbortError');
  h.reply(backRequest, ready({presentation: 'tracks'})); await h.invocations.at(-1).outcome;
  const restored = h.runtime().snapshot(); assert.notEqual(restored.sourceIdentity, first.sourceIdentity);
  const action = outcome(h.runtime().playTrack(restored, restored.result.tracks[0])), actionIndex = h.requests.length - 1;
  h.history.forward(); const forwardIndex = h.requests.length - 1;
  h.reply(actionIndex, nativeReply(h, actionIndex)); assert.equal((await action).error.name, 'AbortError');
  h.reply(forwardIndex, ready({query: ':obsessed'})); await h.invocations.at(-1).outcome;
  assert.equal(h.activations.length, 0); assertPrivateDataAbsent(h);
});

test('retained native Album history owner reauthorizes its own Search query and hydrates anew', async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'}));
  const first = outcome(h.runtime().openAlbum(snapshot, snapshot.result.tracks[0])); await completeDetails(h, 1); assert.equal((await first).value, true);
  const original = h.c.getTrackModalSourcePageOwner(); assert.ok(original?.token);
  // The same real replay owner is invoked by mobile Back/Forward. It may outlive
  // the visible Search result, but never the actor/library/context generation.
  await admit(h, ready({query: ':obsessed'})); assert.equal(original.isCurrent(), true);
  const index = h.requests.length, replay = outcome(h.c.restoreTrackModalSourcePage({sourcePageToken: original.token, albumKey: original.albumKey},
    {signal: new AbortController().signal, isCurrent: () => true}));
  assert.equal(new URL(h.requests[index].url, h.location).searchParams.get('q'), ':loved');
  h.reply(index, nativeReply(h, index)); await h.flush();
  assert.equal(h.requests[index + 1].url, '/album-details?album_key=native-album-eleven');
  h.reply(index + 1, {ok: true, album: fullAlbum(undefined, {name: 'Fresh replay Album'})});
  assert.equal((await replay).value, true); assert.equal(h.hydrations.length, 2);
  assert.equal(h.state.modalReleases[0].name, 'Fresh replay Album');
  h.change('actor'); await h.flush(); assert.equal(h.c.getTrackModalSourcePageOwner().isCurrent(), false);
});

test('a native Album replay cannot restore from cached rows after current source denial', async t => {
  const h = await actionFixture(t), snapshot = await admit(h), first = outcome(h.runtime().openAlbum(snapshot, snapshot.result.albums[0]));
  await completeDetails(h, 1); await first; const owner = h.c.getTrackModalSourcePageOwner(), index = h.requests.length;
  const replay = outcome(h.c.restoreTrackModalSourcePage({sourcePageToken: owner.token, albumKey: owner.albumKey},
    {signal: new AbortController().signal, isCurrent: () => true}));
  h.reply(index, {error: 'forbidden'}, 403); assert.equal((await replay).error.status, 403);
  assert.equal(h.hydrations.length, 1); assert.equal(h.opens.length, 1); assert.equal(owner.isCurrent(), false);
});

test('an older replay denial cannot revoke the newer exact retained Album replay', async t => {
  const h = await actionFixture(t), snapshot = await admit(h), first = outcome(h.runtime().openAlbum(snapshot, snapshot.result.albums[0]));
  await completeDetails(h, 1); await first; const owner = h.c.getTrackModalSourcePageOwner();
  const descriptor = {sourcePageToken: owner.token, albumKey: owner.albumKey}, options = {signal: new AbortController().signal, isCurrent: () => true};
  const index = h.requests.length, old = outcome(h.c.restoreTrackModalSourcePage(descriptor, options));
  const next = outcome(h.c.restoreTrackModalSourcePage(descriptor, options));
  h.reply(index, {error: 'forbidden'}, 403); assert.equal((await old).error.name, 'AbortError');
  h.reply(index + 1, nativeReply(h, index + 1)); await h.flush();
  h.reply(index + 2, {ok: true, album: fullAlbum()}); assert.equal((await next).value, true);
  assert.equal(h.c.getTrackModalSourcePageOwner().isCurrent(), true);
});


for (const response of ['success', 'denial']) test(`a newer actual ordinary Album wins over delayed initial Search details ${response}`, async t => {
  const h = await actionFixture(t), snapshot = await admit(h, ready({presentation: 'tracks'})), row = snapshot.result.tracks[0];
  const token = h.state.ui.pendingTrackModalLoadToken;
  const work = outcome(h.runtime().openAlbum(snapshot, row));
  assert.equal(h.requests.length, 2); assert.equal(h.opens.length, 0);
  h.c.openTrackModal(fullAlbum('ordinary-newer-album', {name: 'Newest ordinary Album'}), {foreground: true});
  const newerToken = h.state.ui.pendingTrackModalLoadToken;
  const newerTitle = h.document.getElementById('track-modal-title').textContent;
  assert.ok(newerToken > token, 'actual ordinary modal owner advanced its native selection token');
  assert.match(newerTitle, /Newest ordinary Album/);
  assert.equal(h.runtime().isCurrent(snapshot), true, 'the competing modal does not merely replace the Search result');
  assert.equal(h.opens.length, 1); assert.equal(h.modal.hidden, false);
  h.reply(1, response === 'success' ? nativeReply(h, 1) : {error: 'forbidden'}, response === 'success' ? 200 : 403);
  assert.equal((await work).error.name, 'AbortError'); await h.flush();
  assert.equal(h.requests.length, 2, 'old initial resolution must not begin reauthorization or Album hydration');
  assert.equal(h.hydrations.length, 0); assert.equal(h.opens.length, 1);
  assert.equal(h.state.ui.pendingTrackModalLoadToken, newerToken);
  assert.equal(h.state.modalReleases[0].key, 'ordinary-newer-album');
  assert.equal(h.document.getElementById('track-modal-title').textContent, newerTitle);
  assert.equal(h.runtime().canOpenAlbum(snapshot, row), true, 'obsolete denial cannot revoke the still-current Search row');
});

test('Search native presentation and retained replay survive their own legitimate modal-token increments', async t => {
  const h = await actionFixture(t), snapshot = await admit(h), before = h.state.ui.pendingTrackModalLoadToken;
  const work = outcome(h.runtime().openAlbum(snapshot, snapshot.result.albums[0]));
  await completeDetails(h, 1); assert.equal((await work).value, true);
  const opened = h.state.ui.pendingTrackModalLoadToken, retained = h.c.getTrackModalSourcePageOwner();
  assert.ok(opened > before); assert.equal(retained.isCurrent(), true);
  const index = h.requests.length, replay = outcome(h.c.restoreTrackModalSourcePage(
    {sourcePageToken: retained.token, albumKey: retained.albumKey},
    {signal: new AbortController().signal, isCurrent: () => true}));
  h.reply(index, nativeReply(h, index)); await h.flush();
  assert.equal(h.requests[index + 1].url, '/album-details?album_key=native-album-eleven');
  h.reply(index + 1, {ok: true, album: fullAlbum()}); assert.equal((await replay).value, true);
  assert.ok(h.state.ui.pendingTrackModalLoadToken > opened);
  assert.equal(h.c.getTrackModalSourcePageOwner().isCurrent(), true);
  assert.equal(h.opens.length, 2); assert.equal(h.hydrations.length, 2);
});
