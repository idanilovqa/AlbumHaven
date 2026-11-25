// The saved player keeps resume tokens and what it shows, never a music file's path; the paths come
// back from the server when the page restores it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'player-saved-tokens.js');

function load(respond) {
  const requests = [];
  const removed = [];
  const context = vm.createContext({
    window: { localStorage: { removeItem: key => removed.push(key) } },
    persisted: 0,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      const answer = respond(url, body);
      return { ok: answer !== null, json: async () => answer };
    },
  });
  context.persistPlayerState = () => { context.persisted += 1; };
  context.isPathLikeAlbumKey = value => /\.flac(\||$)/.test(String(value));
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { context, requests, removed };
}

const song = (name) => ({ src: `/track?path=${encodeURIComponent(`C:/Music/${name}.flac`)}`, path: `C:/Music/${name}.flac`, title: name, artist: 'Artist', album: 'Album', coverRef: 'cover-ref' });
const flush = () => new Promise(resolve => setImmediate(resolve));
const issueTokens = (url, body) => ({ protocol: 1, tracks: body.tracks.map(track => ({ clientKey: track.clientKey, playbackRef: 'ref', resumeToken: `token-${track.path.split('/').pop().replace('.flac', '')}` })) });

test('a saved player names songs by resume token and keeps no path, folder-named album or album snapshot', async () => {
  const { context, requests, removed } = load(issueTokens);
  assert.deepEqual(removed, ['albumhaven.playerState.v1', 'albumhaven.androidNativeQueue.v1'], 'what earlier versions saved with paths goes');
  const [one, two] = [song('one'), song('two')];
  const payload = {
    track: two, currentTime: 3, paused: true,
    playbackQueue: { tracks: [one, two], currentIndex: 1, albumRef: 'C:/Music/Album', albumSnapshot: { tracks: [one, two] } },
  };

  assert.equal(context.playerStateForDevice(payload), null, 'nothing is saved before the current song has its token');
  await flush();
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), { url: '/playback/refs', body: { protocol: 1, prepare: false,
    tracks: [{ clientKey: '0', path: 'C:/Music/two.flac' }, { clientKey: '1', path: 'C:/Music/one.flac' }] } });
  assert.equal(context.persisted, 1, 'the player is saved again once the tokens are in');

  const record = JSON.parse(JSON.stringify(context.playerStateForDevice(payload)));
  assert.deepEqual(record.track, { title: 'two', artist: 'Artist', album: 'Album', coverRef: 'cover-ref', resumeToken: 'token-two' });
  assert.deepEqual(record.playbackQueue, { tracks: [
    { title: 'one', artist: 'Artist', album: 'Album', coverRef: 'cover-ref', resumeToken: 'token-one' },
    { title: 'two', artist: 'Artist', album: 'Album', coverRef: 'cover-ref', resumeToken: 'token-two' },
  ], currentIndex: 1 });
  assert.doesNotMatch(JSON.stringify(record), /C:|Music|\.flac"/);
  assert.equal(requests.length, 1, 'tokens already known are not asked for again');
});

test('a song the server refuses a token for is not asked for again, and the rest of the queue is kept', async () => {
  const { context, requests } = load(() => null);
  const payload = { track: song('gone'), playbackQueue: null };
  context.playerStateForDevice(payload);
  await flush();
  context.playerStateForDevice(payload);
  await flush();
  assert.equal(requests.length, 1);
});

test('a restored player takes each path from the server; a song no longer there leaves the queue', async () => {
  const { context, requests } = load((url, body) => ({ protocol: 1, tracks: body.tracks.map(track => ({
    clientKey: track.clientKey, playbackRef: track.resumeToken === 'token-gone' ? null : 'ref',
    path: track.resumeToken === 'token-gone' ? null : `C:/Music/${track.resumeToken.slice(6)}.flac` })) }));
  const saved = (name) => ({ title: name, artist: 'Artist', album: 'Album', resumeToken: `token-${name}` });
  const restored = await context.playerStateFromDevice({
    track: saved('two'), currentTime: 3, account: 'a1',
    playbackQueue: { tracks: [saved('gone'), saved('two'), saved('three')], currentIndex: 1 },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(requests[0])), { url: '/playback/refs/resume', body: { protocol: 1, includePath: true,
    tracks: ['two', 'gone', 'two', 'three'].map((name, index) => ({ clientKey: String(index), resumeToken: `token-${name}` })) } });
  assert.equal(restored.track.path, 'C:/Music/two.flac');
  assert.equal(restored.track.src, '/track?path=C%3A%2FMusic%2Ftwo.flac');
  assert.equal(restored.track.resumeToken, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.playbackQueue.tracks.map(track => track.title))), ['two', 'three']);
  assert.equal(restored.playbackQueue.currentIndex, 0);
  assert.equal(restored.account, 'a1');
});

test('a saved player that names paths, or whose song is gone, is not restored', async () => {
  const { context, requests } = load((url, body) => ({ tracks: body.tracks.map(track => ({ clientKey: track.clientKey, path: null })) }));
  assert.equal(await context.playerStateFromDevice({ track: song('old') }), null);
  assert.equal(await context.playerStateFromDevice({ track: { ...song('old'), resumeToken: 'token-old' } }), null);
  assert.equal(requests.length, 0, 'a record naming a path is never sent anywhere');
  assert.equal(await context.playerStateFromDevice({ track: { title: 'x', resumeToken: 'token-x' } }), null);
});
