const test = require('node:test');
const assert = require('node:assert/strict');
let model, session;
test.before(async () => {model = await import('../../../music_app/static/js/playlists/model.mjs'); session = await import('../../../music_app/static/js/playlists/creation-session.mjs');});
const descriptor = (patch = {}) => ({kind: 'library', ref: 'catalog:one', revision: 'r1', allowed_actions: {can_read: true, can_use_for_playlist: true}, ...patch});
const payload = (patch = {}) => ({playlist_sidebar: {items: []}, playlist_index: {playlists: []},
  playlist_actions: {can_create: true}, playlist_creation_source: descriptor(), ...patch});
const ack = {scopeKey: 'account:library', request_key: 'operation:one', playlist_id: 'created:one', revision: 'r1'};
const providers = {readPlaylistCreationSource() {}, createPlaylistFromSelection() {}};
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function setup(read = async () => payload({playlist_index: {playlists: [{playlist_id: ack.playlist_id, title: 'Created', allowed_actions: {can_open: true}}]}})) {
  const controller = model.createPlaylistController({readPlaylists: read}); controller.setScope(ack.scopeKey); controller.accept(payload());
  return controller;
}
test('creation admission needs item-aware providers, current root grant and explicit source descriptor', () => {
  const controller = setup(), state = controller.getSnapshot();
  assert.equal(session.canOpenPlaylistCreation(state, providers), true);
  assert.equal(session.canOpenPlaylistCreation(state, {createPlaylist() {}}), false);
  assert.equal(session.canOpenPlaylistCreation(state, providers, 'missing'), false);
  for (const patch of [{playlist_actions: {}}, {playlist_creation_source: null}, {playlist_creation_source: descriptor({allowed_actions: Object.create({can_read: true, can_use_for_playlist: true})})}]) {
    controller.accept(payload(patch)); assert.equal(session.canOpenPlaylistCreation(controller.getSnapshot(), providers), false);
  }
  const inherited = Object.create({playlist_actions: {can_create: true}}); Object.assign(inherited, payload()); delete inherited.playlist_actions;
  controller.accept(inherited); assert.equal(session.canOpenPlaylistCreation(controller.getSnapshot(), providers), false);
});

test('new Create opening renews before capturing the dialog source and refreshes only a changed descriptor', async () => {
  let reads = 0, begins = 0;
  const fresh = descriptor({ref: 'catalog:renewed', revision: 'r2'});
  const controller = setup(async () => {reads++; return payload({playlist_creation_source: fresh});});
  const configured = {...providers, async beginPlaylistCreationSource(request) {
    begins++; assert.equal(request.renewExpired, true); return fresh;
  }};
  const next = await session.preparePlaylistCreationOpening({controller, providers: configured});
  assert.equal(next.source.ref, fresh.ref); assert.equal(reads, 1); assert.equal(begins, 1);
  assert.equal((await session.preparePlaylistCreationOpening({controller, providers: configured})).source.ref, fresh.ref);
  assert.equal(reads, 1, 'a valid cached descriptor does not disturb directory/draft state');
});

test('new Create opening is retired by navigation roundtrip or abort before delayed renewal resolves', async () => {
  for (const revoke of [controller => {controller.select('other:playlist', {fromNavigation: true, load: false});
    controller.select(null, {fromNavigation: true, load: false}); controller.accept(payload());}, (_controller, signal) => signal.abort()]) {
    const controller = setup(), pending = deferred(), signal = new AbortController();
    const opening = session.preparePlaylistCreationOpening({controller, signal: signal.signal,
      providers: {...providers, beginPlaylistCreationSource: () => pending.promise}});
    revoke(controller, signal); pending.resolve(descriptor({ref: 'catalog:renewed'}));
    assert.equal(await opening, null);
    assert.equal(controller.getSnapshot().resource.data.playlist_creation_source.ref, 'catalog:one');
  }
});

test('reopened Create surfaces exact old receipt without constructing a new form or key', async () => {
  let reads = 0;
  const controller = setup(async () => {reads++; return payload();});
  const recovered = {...ack, request_key: 'original:key'};
  const outcome = await session.preparePlaylistCreationOpening({controller,
    providers: {...providers, beginPlaylistCreationSource: async () => ({...descriptor(), recovered_creation: recovered})}});
  assert.deepEqual(outcome.recoveredCreation, {request_key: 'original:key', playlist_id: ack.playlist_id, revision: ack.revision});
  assert.equal(reads, 1);
  await assert.rejects(session.preparePlaylistCreationOpening({controller, providers: {...providers,
    beginPlaylistCreationSource: async () => {throw Object.assign(new Error('Still unknown'), {status: 'unknown'});}}}), /Still unknown/);
});

test('reopened missing Inspect recovers the old Create before an unsaved page can allocate a replacement key', async () => {
  const missing = {...payload(), playlist_detail: {playlist_id: 'source:playlist', title: 'Source', track_rows: [],
    missing_playlist_creation_source: descriptor({kind: 'playlist', ref: 'source:playlist'})}};
  const controller = setup(async () => missing); controller.accept(missing, 'source:playlist');
  let resolved = false, checks = 0, begins = 0;
  const configured = {...providers, beginPlaylistCreationSource() {begins++; assert.fail('Missing source must not use ordinary renewal');},
    async recoverPlaylistCreation() {checks++; if (!resolved) throw Object.assign(new Error('Still unknown'), {status: 'unknown'});
      return {...ack, request_key: 'original:missing-key'};}};
  await assert.rejects(session.preparePlaylistCreationOpening({controller, providers: configured, mode: 'missing'}), /Still unknown/);
  resolved = true;
  const result = await session.preparePlaylistCreationOpening({controller, providers: configured, mode: 'missing'});
  assert.equal(result.mode, 'missing'); assert.equal(result.recoveredCreation.request_key, 'original:missing-key');
  assert.equal(checks, 2); assert.equal(begins, 0);
});
test('successful creation refreshes current authority, awaits native return, then navigates once', async () => {
  const controller = setup(), context = session.playlistCreationContext(controller.getSnapshot()), closing = deferred(), calls = [];
  const pending = session.completePlaylistCreation({ack, context, controller, isCurrent: () => true,
    close: options => {calls.push(['close', options]); return closing.promise;}, navigate: id => calls.push(['navigate', id])});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['close', {force: true, restoreFocus: false}]]);
  closing.resolve(true); assert.equal(await pending, true); assert.deepEqual(calls[1], ['navigate', ack.playlist_id]);
});
test('a failed refresh never resubmits creation or fabricates an opening', async () => {
  const controller = setup(async () => {throw Error('read failed');}), context = session.playlistCreationContext(controller.getSnapshot());
  await assert.rejects(session.completePlaylistCreation({ack, context, controller, isCurrent: () => true,
    close: () => assert.fail('failed refresh must preserve confirmed-create status'), navigate: () => assert.fail('no navigation')}), /refresh failed/);
});
test('revoked destination grant closes truthfully without manufacturing a directory item', async () => {
  const controller = setup(async () => payload()), context = session.playlistCreationContext(controller.getSnapshot()), notes = [];
  assert.equal(await session.completePlaylistCreation({ack, context, controller, isCurrent: () => true,
    close: async options => {assert.equal(options.restoreFocus, true); return true;}, navigate: () => assert.fail('not authorized'), notify: text => notes.push(text)}), true);
  assert.match(notes[0], /Playlist created/); assert.deepEqual(controller.getSnapshot().resource.data.items, []);
});
test('scope replacement during native return prevents an old continuation navigating', async () => {
  const controller = setup(), context = session.playlistCreationContext(controller.getSnapshot()), closing = deferred();
  const pending = session.completePlaylistCreation({ack, context, controller, isCurrent: () => true,
    close: () => closing.promise, navigate: () => assert.fail('retired navigation')});
  await new Promise(resolve => setImmediate(resolve)); controller.setScope('other:library'); closing.resolve(true);
  assert.equal(await pending, false);
});
test('rejected native closure and changed source revision cannot complete an old form', async () => {
  const controller = setup(), context = session.playlistCreationContext(controller.getSnapshot());
  assert.equal(await session.completePlaylistCreation({ack, context, controller, isCurrent: () => true,
    close: async () => false, navigate: () => assert.fail('unclosed form')}), false);
  const changed = setup(async () => payload({playlist_creation_source: descriptor({revision: 'r2'})}));
  assert.equal(await session.completePlaylistCreation({ack, context: session.playlistCreationContext(changed.getSnapshot()), controller: changed,
    isCurrent: () => true, close: () => assert.fail('stale source'), navigate: () => assert.fail('stale source')}), false);
});

test('native return cannot resume after a different lifecycle restores the same source and scope', async () => {
  for (const retire of [controller => controller.configure({readPlaylists: async () => payload()}), controller => controller.suspend()]) {
    const controller = setup(), context = session.playlistCreationContext(controller.getSnapshot()), closing = deferred();
    const pending = session.completePlaylistCreation({ack, context, controller, isCurrent: () => true,
      close: () => closing.promise, navigate: () => assert.fail('old lifecycle navigation'), notify: () => assert.fail('old lifecycle notification')});
    await new Promise(resolve => setImmediate(resolve));
    retire(controller); controller.accept(payload({playlist_index: {playlists: [{playlist_id: ack.playlist_id, allowed_actions: {can_open: true}}]}}));
    assert.equal(session.samePlaylistCreationContext(context, session.playlistCreationContext(controller.getSnapshot())), true);
    closing.resolve(true); assert.equal(await pending, false);
  }
});
