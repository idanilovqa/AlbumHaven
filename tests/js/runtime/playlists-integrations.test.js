const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const model = import('../../../music_app/static/js/playlists/integrations.mjs');
const row = (id = 'item:one', extra = {}) => ({playlist_item_id: id, title: 'Unresolved original', availability: 'unresolved', source_readable: true,
  allowed_actions: {can_review_matches: true, can_accept_match: true}, ...extra});
const detail = (extra = {}) => ({playlist_id: 'playlist:one', title: 'My playlist', track_rows: [row()],
  allowed_actions: {can_play: true, can_review_matches: true, can_accept_match: true}, ...extra});
const context = (extra = {}) => ({scopeKey: 'scope:one', detail: detail(), selectedItemId: 'item:one', status: 'ready', ...extra});
const playback = (extra = {}) => ({scopeKey: 'scope:one', playlist_id: 'playlist:one', revision: 'queue:1', shuffle: false, repeat: 'off',
  current_playlist_id: 'playlist:one', current_playlist_item_id: 'item:one',
  allowed_actions: {can_shuffle: true, can_repeat: true, can_return_to_current: true}, ...extra});
const candidate = (id = 'candidate:one', extra = {}) => ({candidate_ref: id, title: 'Possible version', artist: 'Artist', album_title: 'Album',
  version_label: 'Remaster', allowed_actions: {can_accept_match: true}, ...extra});
const matches = (extra = {}) => ({scopeKey: 'scope:one', playlist_id: 'playlist:one', playlist_item_id: 'item:one', revision: 'match:1',
  candidates: [candidate()], allowed_actions: {can_accept_match: true}, ...extra});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const flush = async () => {await Promise.resolve(); await Promise.resolve(); await Promise.resolve();};
async function setup(providers = {}, subject = context()) {
  const {createPlaylistIntegrations} = await model;
  const controller = createPlaylistIntegrations({providers}); controller.setContext(subject); await flush();
  return controller;
}

test('unconfigured integrations stay unavailable without fabricating a queue or matches', async () => {
  const controller = await setup();
  assert.equal(controller.getSnapshot().playback.status, 'unavailable');
  assert.equal(controller.getSnapshot().matches.status, 'unavailable');
  assert.equal(await controller.playbackIntent('shuffle'), false);
  assert.equal(await controller.acceptMatch(), false); controller.dispose();
});

test('reads are scoped to exact detail and item identities and carry cancellation signals', async () => {
  const calls = [], subject = context();
  const controller = await setup({readPlayback: value => {calls.push(value); return playback();}, readMatches: value => {calls.push(value); return matches();}}, subject);
  assert.strictEqual(controller.getSnapshot().detail, subject.detail);
  assert.equal(controller.getSnapshot().selectedItemId, 'item:one');
  assert.equal(calls.length, 2);
  for (const call of calls) {assert.equal(call.scopeKey, 'scope:one'); assert.equal(call.playlist_id, 'playlist:one'); assert.ok(call.signal instanceof AbortSignal);}
  assert.equal(calls[1].playlist_item_id, 'item:one');
  assert.equal(controller.getSnapshot().currentItemId, 'item:one'); controller.dispose();
});

test('read permission requires exact own grants and readable unresolved or missing selected rows', async () => {
  for (const bad of [undefined, 1, 'true', false]) {
    let calls = 0;
    const subject = context({detail: detail({allowed_actions: {can_play: bad, can_review_matches: bad}})});
    const controller = await setup({readPlayback() {calls++;}, readMatches() {calls++;}}, subject);
    assert.equal(calls, 0); controller.dispose();
  }
  for (const badRow of [row('item:one', {availability: 'local'}), row('item:one', {source_readable: false}),
    row('item:one', {allowed_actions: Object.create({can_review_matches: true})})]) {
    let calls = 0;
    const controller = await setup({readMatches() {calls++;}}, context({detail: detail({track_rows: [badRow]})}));
    assert.equal(calls, 0); controller.dispose();
  }
});

test('queue projections never present a foreign or absent current item as a playlist member', async () => {
  for (const extra of [{current_playlist_id: 'playlist:other'}, {current_playlist_item_id: 'removed:item'},
    {current_playlist_id: null, current_playlist_item_id: null}]) {
    const controller = await setup({readPlayback: () => playback(extra)});
    assert.equal(controller.getSnapshot().currentItemId, null); controller.dispose();
  }
});

test('invalid subject, modes, revisions, sparse and duplicate match candidates fail closed', async () => {
  for (const data of [playback({scopeKey: 'other'}), playback({playlist_id: 'other'}), playback({shuffle: 'false'}),
    playback({repeat: 'random'}), playback({revision: ''}), playback({current_playlist_id: null})]) {
    const controller = await setup({readPlayback: () => data});
    assert.equal(controller.getSnapshot().playback.status, 'error'); controller.dispose();
  }
  for (const data of [matches({playlist_item_id: 'other'}), matches({revision: ''}), matches({candidates: Array(1)}),
    matches({candidates: [candidate(), candidate()]}), matches({candidates: [candidate('')]})]) {
    const controller = await setup({readMatches: () => data});
    assert.equal(controller.getSnapshot().matches.status, 'error'); controller.dispose();
  }
});

test('candidate projections copy only display fields and opaque refs, dropping explicitly unreadable data', async () => {
  const source = matches({candidates: [candidate('one', {path: '/private/audio', track_ref: 'private', media_url: '/media'}),
    candidate('two', {source_readable: false, title: 'Secret'}), candidate('three', {allowed_actions: {can_read: false}})]});
  const controller = await setup({readMatches: () => source});
  const data = controller.getSnapshot().matches.data;
  assert.deepEqual(data.candidates.map(value => value.candidate_ref), ['one']);
  assert.doesNotMatch(JSON.stringify(data), /private|Secret|media_url|track_ref/);
  assert.ok(Object.isFrozen(data.candidates[0]));
  source.candidates[0].title = 'Changed later'; assert.equal(data.candidates[0].title, 'Possible version'); controller.dispose();
});

test('choosing a candidate never accepts it and cannot choose an unknown identity', async () => {
  let writes = 0;
  const controller = await setup({readMatches: () => matches(), acceptMatch() {writes++;}});
  assert.equal(controller.chooseCandidate('missing'), false);
  assert.equal(controller.chooseCandidate('candidate:one'), true);
  assert.equal(controller.getSnapshot().candidateRef, 'candidate:one'); assert.equal(writes, 0); controller.dispose();
});

test('match acceptance requires every current explicit grant', async () => {
  for (const options of [{detailGrant: false}, {rowGrant: false}, {resultGrant: false}, {candidateGrant: false}, {candidateGrant: 'true'}]) {
    let writes = 0;
    const subject = context({detail: detail({allowed_actions: {can_review_matches: true, can_accept_match: options.detailGrant ?? true},
      track_rows: [row('item:one', {allowed_actions: {can_review_matches: true, can_accept_match: options.rowGrant ?? true}})]})});
    const controller = await setup({readMatches: () => matches({allowed_actions: {can_accept_match: options.resultGrant ?? true},
      candidates: [candidate('candidate:one', {allowed_actions: {can_accept_match: options.candidateGrant ?? true}})]}), acceptMatch() {writes++;}}, subject);
    controller.chooseCandidate('candidate:one'); assert.equal(await controller.acceptMatch(), false); assert.equal(writes, 0); controller.dispose();
  }
});

test('match acceptance uses a fresh revision and explicit acknowledgement, then rereads without optimistic matching', async () => {
  const calls = []; let reads = 0;
  const controller = await setup({readMatches: () => {reads++; return matches();}, acceptMatch: value => {calls.push(value); return {ok: true, ...value};}});
  controller.chooseCandidate('candidate:one'); assert.equal(await controller.acceptMatch(), true);
  assert.equal(calls.length, 1); assert.equal(calls[0].revision, 'match:1'); assert.equal(calls[0].candidate_ref, 'candidate:one');
  assert.equal(calls[0].playlist_item_id, 'item:one'); assert.equal(reads, 2);
  assert.equal(controller.getSnapshot().candidateRef, null); assert.equal(controller.getSnapshot().detail.track_rows[0].availability, 'unresolved'); controller.dispose();
});

test('missing, contradictory or wrong-subject acknowledgements never report accepted matches', async () => {
  for (const acknowledgement of [undefined, {}, {ok: 'true'}, {ok: true}, {ok: true, status: 'denied'},
    {ok: true, scopeKey: 'scope:one', playlist_id: 'playlist:one', playlist_item_id: 'other', candidate_ref: 'candidate:one'}]) {
    const controller = await setup({readMatches: () => matches(), acceptMatch: () => acknowledgement});
    controller.chooseCandidate('candidate:one'); assert.equal(await controller.acceptMatch(), false);
    assert.notEqual(controller.getSnapshot().matchMutation.status, 'ready'); controller.dispose();
  }
});

test('playback delegates intent with revision and never changes queue modes before authoritative refresh', async () => {
  const pending = deferred(), calls = []; let data = playback();
  const controller = await setup({readPlayback: () => data, playbackIntent: value => {calls.push(value); return pending.promise;}});
  const write = controller.playbackIntent('shuffle'); await flush();
  assert.equal(controller.getSnapshot().playback.data.shuffle, false);
  assert.equal(await controller.playbackIntent('repeat'), false);
  assert.equal(calls[0].shuffle, true); assert.equal(calls[0].revision, 'queue:1'); assert.equal(calls[0].action, 'shuffle');
  data = playback({shuffle: true, revision: 'queue:2'}); pending.resolve({ok: true, ...calls[0]});
  assert.equal(await write, true); assert.equal(controller.getSnapshot().playback.data.shuffle, true); controller.dispose();
});

test('repeat cycles request values and return-current preserves the player-owned identity', async () => {
  const calls = []; let data = playback();
  const controller = await setup({readPlayback: () => data, playbackIntent: value => {calls.push(value); return {ok: true, ...value};}});
  for (const [repeat, next] of [['off', 'all'], ['all', 'one'], ['one', 'off']]) {
    data = playback({repeat}); await controller.loadPlayback(); assert.equal(await controller.playbackIntent('repeat'), true);
    assert.equal(calls.at(-1).repeat, next);
  }
  assert.equal(await controller.playbackIntent('return_to_current'), true);
  assert.equal(calls.at(-1).playlist_item_id, 'item:one'); assert.equal(calls.at(-1).action, 'return_to_current'); controller.dispose();
});

test('selection and detail replacement cancel stale matches without replacing playback on row selection alone', async () => {
  const pending = deferred(); let readCalls = 0, signal;
  const subject = context({detail: detail({track_rows: [row(), row('item:two')]})});
  const controller = await setup({readPlayback: () => {readCalls++; return playback();}, readMatches: args => {signal = args.signal; return pending.promise;}}, subject);
  const oldSignal = signal;
  controller.setContext({...subject, selectedItemId: 'item:two'}); await flush();
  assert.equal(oldSignal.aborted, true); assert.equal(readCalls, 1);
  pending.resolve(matches()); await flush(); assert.equal(controller.getSnapshot().matches.status, 'error');
  assert.equal(controller.getSnapshot().selectedItemId, 'item:two'); controller.dispose();
});

test('scope replacement cancels pending writes and late acknowledgements cannot cross accounts', async () => {
  const pending = deferred(); let request;
  const controller = await setup({readMatches: () => matches(), acceptMatch: args => {request = args; return pending.promise;}});
  controller.chooseCandidate('candidate:one'); const write = controller.acceptMatch(); await flush();
  controller.setContext(context({scopeKey: 'scope:two'})); assert.equal(request.signal.aborted, true);
  pending.resolve({ok: true, ...request}); assert.equal(await write, false);
  assert.equal(controller.getSnapshot().scopeKey, 'scope:two'); assert.notEqual(controller.getSnapshot().matchMutation.status, 'ready'); controller.dispose();
});

test('denial aborts the whole scoped integration and discards supplied private bodies', async () => {
  const pending = deferred(); let queueSignal;
  const controller = await setup({readPlayback: args => {queueSignal = args.signal; return pending.promise;},
    readMatches: () => ({status: 'denied', data: matches()})});
  assert.equal(queueSignal.aborted, true);
  assert.equal(controller.getSnapshot().playback.status, 'denied'); assert.equal(controller.getSnapshot().matches.data, null);
  pending.resolve(playback()); await flush(); assert.equal(controller.getSnapshot().playback.status, 'denied');
  assert.equal(await controller.loadPlayback(), false); controller.dispose();
});

test('playback subscriptions reject stale emissions and unsubscribe on subject replacement/disposal', async () => {
  const callbacks = []; let stopped = 0;
  const controller = await setup({readPlayback: () => playback(), subscribePlayback: args => {callbacks.push(args); return () => {stopped++;};}});
  callbacks[0].onChange(playback({shuffle: true})); assert.equal(controller.getSnapshot().playback.data.shuffle, true);
  controller.setContext(context({detail: detail()})); await flush(); assert.equal(stopped, 1);
  callbacks[0].onChange(playback({repeat: 'one'})); assert.equal(controller.getSnapshot().playback.data.repeat, 'off');
  controller.dispose(); assert.equal(stopped, 2); assert.equal(callbacks[1].signal.aborted, true);
});

test('synchronous subscription denial still runs the returned cleanup exactly once', async () => {
  let stopped = 0, signal;
  const controller = await setup({readPlayback: () => playback(), subscribePlayback: args => {
    signal = args.signal; args.onChange({status: 'denied', data: playback()}); return () => {stopped++;};
  }});
  assert.equal(signal.aborted, true); assert.equal(stopped, 1);
  assert.equal(controller.getSnapshot().playback.status, 'denied'); assert.equal(controller.getSnapshot().detail, null);
  controller.dispose(); assert.equal(stopped, 1);
});

test('provider replacement clears drafts and cancellation prevents old match responses resurfacing', async () => {
  const pending = deferred(); let signal;
  const controller = await setup({readMatches: args => {signal = args.signal; return pending.promise;}});
  controller.configure({readMatches: () => matches({candidates: [candidate('fresh:one')]})}); await flush();
  assert.equal(signal.aborted, true); pending.resolve(matches()); await flush();
  assert.deepEqual(controller.getSnapshot().matches.data.candidates.map(value => value.candidate_ref), ['fresh:one']);
  assert.equal(controller.getSnapshot().candidateRef, null); controller.dispose();
});

test('provider replacement alone cannot revive an already denied subject', async () => {
  let calls = 0;
  const controller = await setup({readMatches: () => ({status: 'denied'})});
  controller.configure({readMatches: () => {calls++; return matches();}}); await flush();
  assert.equal(calls, 0); assert.equal(controller.getSnapshot().matches.status, 'denied');
  controller.setContext(context()); await flush(); assert.equal(calls, 1); controller.dispose();
});

test('subscription grant revocation aborts a pending playback intent', async () => {
  const pending = deferred(); let subscription, request;
  const controller = await setup({readPlayback: () => playback(), subscribePlayback: args => {subscription = args; return () => {};},
    playbackIntent: args => {request = args; return pending.promise;}});
  const write = controller.playbackIntent('shuffle'); await flush();
  subscription.onChange(playback({allowed_actions: {can_shuffle: false}}));
  assert.equal(request.signal.aborted, true); pending.resolve({ok: true, ...request});
  assert.equal(await write, false); assert.equal(controller.getSnapshot().available.shuffle, false); controller.dispose();
});

test('subscription revocation during an acknowledged intent refresh cancels its completion', async () => {
  const refresh = deferred(); let subscription, request, reads = 0;
  const controller = await setup({readPlayback: () => ++reads === 1 ? playback() : refresh.promise,
    subscribePlayback: args => {subscription = args; return () => {};}, playbackIntent: args => {request = args; return {ok: true, ...args};}});
  const write = controller.playbackIntent('shuffle'); await flush();
  assert.equal(controller.getSnapshot().playback.status, 'loading');
  subscription.onChange(playback({allowed_actions: {can_shuffle: false}}));
  assert.equal(request.signal.aborted, true); refresh.resolve(playback());
  assert.equal(await write, false); assert.equal(controller.getSnapshot().playbackMutation.status, 'unavailable'); controller.dispose();
});

test('rejected playback acknowledgement, inherited grants and inherited providers stay inactive', async () => {
  const controller = await setup({readPlayback: () => playback({allowed_actions: Object.create({can_shuffle: true})}), playbackIntent() {throw Error('Not allowed');}});
  assert.equal(controller.getSnapshot().available.shuffle, false); assert.equal(await controller.playbackIntent('shuffle'), false); controller.dispose();
  let calls = 0;
  const inherited = await setup(Object.create({readPlayback() {calls++;}})); assert.equal(calls, 0); inherited.dispose();
  const wrong = await setup({readPlayback: () => playback(), playbackIntent: args => ({ok: true, ...args, playlist_item_id: 'wrong'})});
  assert.equal(await wrong.playbackIntent('return_to_current'), false); assert.equal(wrong.getSnapshot().playbackMutation.status, 'error'); wrong.dispose();
});

test('queue acknowledgements require the requested mode without missing or contradictory echoes', async () => {
  for (const [action, replacement] of [['shuffle', undefined], ['shuffle', false], ['repeat', undefined], ['repeat', 'off']]) {
    const controller = await setup({readPlayback: () => playback(), playbackIntent: args => ({ok: true, ...args, [action]: replacement})});
    assert.equal(await controller.playbackIntent(action), false); assert.equal(controller.getSnapshot().playbackMutation.status, 'error'); controller.dispose();
  }
});

const repo = path.resolve(__dirname, '../../..');
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/playlists/integrations.jsx')], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']});
const loaded = new Module(path.join(repo, 'playlist-integrations-fixture.cjs'), module);
loaded.filename = path.join(repo, 'playlist-integrations-fixture.cjs'); loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {PlaylistPlaybackControls, PlaylistMatchReview} = loaded.exports;
const native = createNativeHomeRuntime();
const runtime = {buttonHtml: value => native.context.ButtonComponent.renderButton(value),
  actionHtml: value => native.context.ButtonComponent.renderActionButton(value), alertHtml: value => native.context.buildOnPageAlertHtml(value)};
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, {runtime, ...props}));

test('unconfigured native controls remain visible and truthfully explain incomplete integrations', async () => {
  const controller = await setup(); const state = controller.getSnapshot();
  const controls = render(PlaylistPlaybackControls, {controller, state});
  assert.match(controls, /Shuffle/); assert.match(controls, /Repeat/); assert.match(controls, /Return to current/);
  assert.match(controls, /queue provider/); assert.match(controls, /disabled/);
  const review = render(PlaylistMatchReview, {controller, state});
  assert.match(review, /Unresolved original/); assert.match(review, /match provider/); assert.match(review, /Accept selected local match/);
  assert.doesNotMatch(review, /Possible version/); controller.dispose();
});

test('match review escapes provider labels and offers an explicit candidate choice before acceptance', async () => {
  const controller = await setup({readMatches: () => matches({candidates: [candidate('candidate:one', {title: '<script>Bad</script>'})]}), acceptMatch() {}});
  let html = render(PlaylistMatchReview, {controller, state: controller.getSnapshot()});
  assert.match(html, /&lt;script&gt;Bad&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Choose a possible local match/); assert.match(html, /disabled/);
  controller.chooseCandidate('candidate:one'); html = render(PlaylistMatchReview, {controller, state: controller.getSnapshot()});
  const host = native.document.createElement('div'); host.innerHTML = html;
  assert.equal(host.querySelector('[data-playlists-accept-match]').disabled, false); controller.dispose();
});

test('foreign current playback is explained without printing an unrelated title as playlist content', async () => {
  const controller = await setup({readPlayback: () => playback({current_playlist_id: 'elsewhere', current_title: 'Private foreign title'})});
  const html = render(PlaylistPlaybackControls, {controller, state: controller.getSnapshot()});
  assert.match(html, /another playlist/); assert.doesNotMatch(html, /Private foreign title|Current: Unresolved original/); controller.dispose();
});
