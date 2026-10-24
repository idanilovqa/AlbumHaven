const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'playback-ownership-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const protocolFixture = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', 'fixtures', 'playback-protocol-v1.json',
), 'utf8'));

function loadHelper(overrides = {}) {
  const stopStreamingPlaybackCalls = [];
  const context = {
    state: {
      player: {
        current: null,
        ownership: {
          tabId: 'local-tab',
          lockStatus: 'unlocked',
          blockedReason: '',
          mirroredTrack: null,
          activeClaim: null,
          channel: null,
          heartbeatTimer: 0,
          initialized: true,
        },
      },
    },
    window: {},
    AbortController,
    getLocalStorageItem: () => '',
    setLocalStorageItem: () => true,
    updatePlayerUi: () => {},
    stopStreamingPlayback: (reason) => {
      stopStreamingPlaybackCalls.push(reason);
    },
    clearInterval: () => {},
    clearTimeout: () => {},
    setInterval: () => 0,
    setTimeout: () => 0,
    showToast: () => {},
    console,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, stopStreamingPlaybackCalls };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function jsonResponse(payload, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || (options.ok === false ? 409 : 200),
    json: async () => payload,
  };
}

const localTrack = {
  src: '/track?path=local.flac',
  path: 'C:/Music/local.flac',
  title: 'Local Track',
  artist: 'Local Artist',
  album: 'Local Album',
  coverPath: '',
};

test('server claim acquisition uses protocol v1 and keeps paths out of ownership state', async () => {
  const requests = [];
  const { context } = loadHelper({
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method: options.method, body });
      if (url === '/playback/refs') {
        return jsonResponse({
          ...protocolFixture.valid.refsResponse,
          expiresAt: '2099-10-24T00:00:00Z',
          tracks: [{
            ...protocolFixture.valid.refsResponse.tracks[0],
            clientKey: body.tracks[0].clientKey,
          }],
        });
      }
      return jsonResponse({
        ...protocolFixture.valid.claimResponse,
        expiresAt: '2099-10-23T23:00:30Z',
      });
    },
  });

  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    url: '/playback/refs',
    method: 'POST',
    body: {
      protocol: protocolFixture.protocol,
      tracks: [{ clientKey: requests[0].body.tracks[0].clientKey, path: localTrack.path }],
    },
  });
  assert.equal(requests[1].url, '/playback/state');
  assert.equal(requests[1].method, 'PUT');
  assert.equal(requests[1].body.protocol, protocolFixture.protocol);
  assert.equal(requests[1].body.clientSurface, protocolFixture.valid.claimRequest.clientSurface);
  assert.equal(requests[1].body.state, protocolFixture.valid.claimRequest.state);
  assert.equal(
    requests[1].body.track.playbackRef,
    protocolFixture.valid.claimRequest.track.playbackRef,
  );
  const forbiddenClaimTrackKeys = Object.keys(
    protocolFixture.invalid.pathLeakingClaimRequest.track,
  ).filter((key) => !(key in protocolFixture.valid.claimRequest.track));
  assert.equal(forbiddenClaimTrackKeys.some((key) => key in requests[1].body.track), false);
  assert.equal(JSON.stringify(requests[1].body).includes(localTrack.path), false);
  assert.equal(
    context.state.player.ownership.activeClaim.claimToken,
    protocolFixture.valid.claimResponse.claimToken,
  );
});

test('protocol fixture rejects unsupported responses and strips untrusted path metadata', async () => {
  let statePuts = 0;
  const { context } = loadHelper({
    fetch: async (url, options = {}) => {
      if (url === '/playback/refs') {
        return jsonResponse(protocolFixture.invalid.unsupportedRefsResponse);
      }
      if (options.method === 'PUT') statePuts += 1;
      return jsonResponse({ is_playing_here: false, is_playing_elsewhere: false });
    },
  });

  assert.equal(await context.claimPlaybackOwnership(localTrack), false);
  assert.equal(statePuts, 0);
  context.syncMirroredPlaybackState(protocolFixture.invalid.pathLeakingPlaybackState);
  assert.equal(
    Object.prototype.hasOwnProperty.call(context.state.player.ownership.mirroredTrack, 'path'),
    false,
  );
});

test('late acquisition releases its stale token without replacing the newer claim', async () => {
  const acquisitions = [];
  const releases = [];
  const { context } = loadHelper({
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') {
        return jsonResponse({
          protocol: 1,
          tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: `ref:${body.tracks[0].path}` }],
        });
      }
      if (options.method === 'DELETE') {
        releases.push(body);
        return jsonResponse({ protocol: 1 });
      }
      const pending = deferred();
      acquisitions.push({ body, pending });
      return pending.promise;
    },
  });
  const newerTrack = { ...localTrack, path: 'C:/Music/newer.flac', title: 'Newer' };

  const olderClaim = context.claimPlaybackOwnership(localTrack);
  await new Promise((resolve) => setImmediate(resolve));
  const newerClaim = context.claimPlaybackOwnership(newerTrack);
  await new Promise((resolve) => setImmediate(resolve));
  if (acquisitions.length === 1) {
    acquisitions[0].pending.resolve(jsonResponse({
      protocol: 1, claimToken: 'older-token', expiresAt: '2099-10-23T23:00:30Z',
      playbackState: { is_playing_here: true },
    }));
    assert.equal(await olderClaim, false);
    await new Promise((resolve) => setImmediate(resolve));
  }
  acquisitions[1].pending.resolve(jsonResponse({
    protocol: 1,
    claimToken: 'newer-token',
    expiresAt: '2099-10-23T23:00:30Z',
    playbackState: { is_playing_here: true },
  }));
  assert.equal(await newerClaim, true);
  acquisitions[0].pending.resolve(jsonResponse({
    protocol: 1,
    claimToken: 'older-token',
    expiresAt: '2099-10-23T23:00:30Z',
    playbackState: { is_playing_here: true },
  }));

  assert.equal(await olderClaim, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state.player.ownership.activeClaim.claimToken, 'newer-token');
  assert.equal(releases.some((body) => body.claimToken === 'older-token'), true);
});

test('resume waits for server release before acquiring a replacement claim', async () => {
  const pendingRelease = deferred();
  let claimNumber = 0;
  let serverToken = null;
  let prematureAcquisitions = 0;
  const { context } = loadHelper({
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') {
        return jsonResponse({
          protocol: 1,
          tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: `ref-${claimNumber + 1}` }],
        });
      }
      if (options.method === 'DELETE') {
        await pendingRelease.promise;
        if (serverToken === body.claimToken) serverToken = null;
        return jsonResponse({ protocol: 1 });
      }
      if (options.method === 'GET') return jsonResponse({ is_playing_elsewhere: true });
      if (serverToken && body.claimToken !== serverToken) {
        prematureAcquisitions += 1;
        return jsonResponse({ error: 'Playback is already claimed.' }, { ok: false });
      }
      claimNumber += 1;
      serverToken = `claim-token-${claimNumber}`;
      return jsonResponse({
        protocol: 1,
        claimToken: `claim-token-${claimNumber}`,
        expiresAt: '2099-10-23T23:00:30Z',
        playbackState: { is_playing_here: true },
      });
    },
  });

  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  const release = context.releasePlaybackOwnership('paused', localTrack);
  await new Promise((resolve) => setImmediate(resolve));
  const resume = context.claimPlaybackOwnership(localTrack);
  await new Promise((resolve) => setImmediate(resolve));
  pendingRelease.resolve(jsonResponse({ protocol: 1 }));
  await release;
  assert.equal(await resume, true);
  assert.equal(prematureAcquisitions, 0);
  assert.equal(context.state.player.ownership.activeClaim.claimToken, 'claim-token-2');
  assert.equal(serverToken, 'claim-token-2');
});

test('overlapping selections sharing a claim token never delete the newer selection claim', async () => {
  const acquisitions = [];
  const releases = [];
  const { context } = loadHelper({
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') return jsonResponse({ protocol: 1, tracks: [{
        clientKey: body.tracks[0].clientKey, playbackRef: `ref:${body.tracks[0].path}`,
      }] });
      if (options.method === 'DELETE') {
        releases.push(body.claimToken);
        return jsonResponse({ protocol: 1 });
      }
      if (!body.claimToken) return jsonResponse({ protocol: 1, claimToken: 'shared-token',
        expiresAt: '2099-10-23T23:00:30Z', playbackState: { is_playing_here: true } });
      const pending = deferred();
      acquisitions.push({ body, pending });
      return pending.promise;
    },
  });
  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  const older = context.claimPlaybackOwnership({ ...localTrack, path: 'older.flac' });
  await new Promise((resolve) => setImmediate(resolve));
  const newer = context.claimPlaybackOwnership({ ...localTrack, path: 'newer.flac' });
  await new Promise((resolve) => setImmediate(resolve));
  const response = () => jsonResponse({ protocol: 1, claimToken: 'shared-token',
    expiresAt: '2099-10-23T23:00:30Z', playbackState: { is_playing_here: true } });
  if (acquisitions.length === 1) {
    acquisitions[0].pending.resolve(response());
    assert.equal(await older, false);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(acquisitions.map(({ body }) => body.claimToken), ['shared-token', 'shared-token']);
  acquisitions[1].pending.resolve(response());
  assert.equal(await newer, true);
  acquisitions[0].pending.resolve(response());
  assert.equal(await older, false);
  assert.deepEqual(releases, []);
  assert.equal(context.state.player.ownership.activeClaim.claimToken, 'shared-token');
  assert.equal(context.state.player.ownership.activeClaim.track.playbackRef, 'ref:newer.flac');
});

test('ownership requests abort stalled transport within a bounded deadline', async () => {
  const timers = [];
  let requestSignal;
  const { context } = loadHelper({
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      requestSignal = options.signal;
      options.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }),
  });
  const request = context.playbackOwnershipRequest('GET', '/playback/state');
  const rejected = assert.rejects(request, /abort|timeout/i);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 0 && timers[0].delay <= 10000);
  timers[0].callback();
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('release drains claim-scoped listen requests before clearing and deleting the claim', async () => {
  const pendingDrain = deferred();
  const releases = [];
  const { context } = loadHelper({
    drainPlaybackSessionRequests: (claimToken) => {
      assert.equal(claimToken, 'claim-token-1');
      return pendingDrain.promise;
    },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') {
        return jsonResponse({
          protocol: 1,
          tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'playback-ref-1' }],
        });
      }
      if (options.method === 'DELETE') {
        releases.push(body);
        return jsonResponse({ protocol: 1 });
      }
      return jsonResponse({
        protocol: 1,
        claimToken: 'claim-token-1',
        expiresAt: '2099-10-23T23:00:30Z',
        playbackState: { is_playing_here: true },
      });
    },
  });

  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  const release = context.releasePlaybackOwnership('paused', localTrack);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(context.state.player.ownership.activeClaim.claimToken, 'claim-token-1');
  assert.deepEqual(releases, []);

  pendingDrain.resolve();
  assert.equal(await release, true);
  assert.equal(context.state.player.ownership.activeClaim, null);
  assert.equal(releases.length, 1);
  assert.equal(releases[0].claimToken, 'claim-token-1');
});

test('heartbeat does not renew a paused claim while its listen requests are draining', async () => {
  const pendingDrain = deferred();
  let heartbeat = null;
  let statePuts = 0;
  let paused = false;
  const { context } = loadHelper({
    setInterval: (callback) => { heartbeat = callback; return 17; },
    drainPlaybackSessionRequests: () => pendingDrain.promise,
    getPlayerPlaybackSnapshot: () => ({ paused, ended: false }),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') {
        return jsonResponse({
          protocol: 1,
          tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'playback-ref-1' }],
        });
      }
      if (options.method === 'PUT') {
        statePuts += 1;
        return jsonResponse({
          protocol: 1,
          claimToken: 'claim-token-1',
          expiresAt: '2099-10-23T23:00:30Z',
          playbackState: { is_playing_here: true },
        });
      }
      return jsonResponse({ protocol: 1 });
    },
  });

  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  assert.equal(statePuts, 1);
  context.state.player.current = localTrack;
  paused = true;
  const release = context.releasePlaybackOwnership('paused', localTrack);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof heartbeat, 'function');

  await heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statePuts, 1, 'a paused client cannot extend a claim while release is draining');

  pendingDrain.resolve();
  await release;
});

test('new selection renews while old listen drain is pending and obsolete release cannot delete it', async () => {
  const pendingDrain = deferred();
  const writes = [];
  const releases = [];
  const { context } = loadHelper({
    drainPlaybackSessionRequests: () => pendingDrain.promise,
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') return jsonResponse({ protocol: 1, tracks: [{
        clientKey: body.tracks[0].clientKey, playbackRef: `ref:${body.tracks[0].path}`,
      }] });
      if (options.method === 'DELETE') {
        releases.push(body.claimToken);
        return jsonResponse({ protocol: 1 });
      }
      writes.push(body);
      return jsonResponse({ protocol: 1, claimToken: 'shared-token',
        expiresAt: '2099-10-23T23:00:30Z', playbackState: { is_playing_here: true } });
    },
  });
  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  const release = context.releasePlaybackOwnership();
  await new Promise((resolve) => setImmediate(resolve));
  let acquired = false;
  const resume = context.claimPlaybackOwnership({ ...localTrack, path: 'new-selection.flac' })
    .then((result) => { acquired = result; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquired, true, 'old listen drain must not block a new selection');
  assert.equal(writes.length, 2);
  assert.equal(writes[1].claimToken, 'shared-token');
  assert.equal(writes[1].track.playbackRef, 'ref:new-selection.flac');
  pendingDrain.resolve();
  assert.equal(await release, false);
  assert.equal(await resume, true);
  assert.deepEqual(releases, []);
  assert.equal(context.state.player.ownership.activeClaim.track.playbackRef, 'ref:new-selection.flac');
});

test('renewal failure stops audible output and clears local ownership', async () => {
  let heartbeat = null;
  let stateRequests = 0;
  const { context, stopStreamingPlaybackCalls } = loadHelper({
    setInterval: (callback) => { heartbeat = callback; return 17; },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') {
        return jsonResponse({ protocol: 1, tracks: [{
          clientKey: body.tracks[0].clientKey,
          playbackRef: 'playback-ref-1',
        }] });
      }
      stateRequests += 1;
      if (stateRequests === 1) {
        return jsonResponse({
          protocol: 1,
          claimToken: 'claim-token-1',
          expiresAt: '2099-10-23T23:00:30Z',
          playbackState: { is_playing_here: true },
        });
      }
      return jsonResponse({ error: 'claim expired' }, { ok: false, status: 409 });
    },
    getPlayerPlaybackSnapshot: () => ({ paused: false, ended: false }),
  });

  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  assert.equal(typeof heartbeat, 'function');
  context.state.player.current = localTrack;
  await heartbeat();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stateRequests, 2, 'renewal must reach the server before rejection stops playback');
  assert.equal(stopStreamingPlaybackCalls.length, 1);
  assert.match(stopStreamingPlaybackCalls[0], /ownership|claim|lease/);
  assert.equal(context.state.player.ownership.activeClaim, null);
});

for (const replacement of [false, true]) {
  test(`late renewal cannot restore ownership after ${replacement ? 'replacement' : 'stop'}`, async () => {
    const pendingRenewal = deferred();
    let acquisitions = 0;
    let renewals = 0;
    const { context, stopStreamingPlaybackCalls } = loadHelper({
      fetch: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        if (url === '/playback/refs') return jsonResponse({ protocol: 1, tracks: [{
          clientKey: body.tracks[0].clientKey, playbackRef: 'playback-ref-1',
        }] });
        if (options.method === 'DELETE') return jsonResponse({ protocol: 1 });
        if (body.claimToken) {
          renewals += 1;
          return pendingRenewal.promise;
        }
        acquisitions += 1;
        return jsonResponse({ protocol: 1, claimToken: `claim-${acquisitions}`,
          expiresAt: '2099-10-23T23:00:30Z', playbackState: { is_playing_here: true } });
      },
    });
    assert.equal(await context.claimPlaybackOwnership(localTrack), true);
    context.state.player.current = localTrack;
    const renewal = context.refreshPlaybackOwnershipClaim();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renewals, 1);
    const release = context.releasePlaybackOwnership();
    pendingRenewal.resolve(jsonResponse({ protocol: 1, claimToken: 'claim-1',
      expiresAt: '2099-10-24T00:00:30Z', playbackState: { is_playing_here: true } }));
    assert.equal(await renewal, false);
    await release;
    if (replacement) assert.equal(await context.claimPlaybackOwnership(localTrack), true);
    const expectedClaim = context.state.player.ownership.activeClaim;
    assert.equal(context.state.player.ownership.activeClaim, expectedClaim);
    assert.equal(expectedClaim?.claimToken || null, replacement ? 'claim-2' : null);
    assert.deepEqual(stopStreamingPlaybackCalls, []);
  });
}

test('lease expiry silences output while a renewal request remains pending', async () => {
  const pendingRenewal = deferred();
  let expire;
  let renewals = 0;
  const { context, stopStreamingPlaybackCalls } = loadHelper({
    setTimeout: (callback, delay) => { if (delay > 10000) expire = callback; return 18; },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') return jsonResponse({ protocol: 1, tracks: [{
        clientKey: body.tracks[0].clientKey, playbackRef: 'playback-ref-1',
      }] });
      if (body.claimToken) {
        renewals += 1;
        return pendingRenewal.promise;
      }
      return jsonResponse({ protocol: 1, claimToken: 'claim-1',
        expiresAt: '2099-10-23T23:00:30Z', playbackState: { is_playing_here: true } });
    },
  });
  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  context.state.player.current = localTrack;
  const renewal = context.refreshPlaybackOwnershipClaim();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewals, 1);
  expire();
  assert.equal(context.state.player.ownership.activeClaim, null);
  assert.deepEqual(stopStreamingPlaybackCalls, ['ownership-lost']);
  pendingRenewal.resolve(jsonResponse({ protocol: 1, claimToken: 'claim-1',
    expiresAt: '2099-10-24T00:00:30Z', playbackState: { is_playing_here: true } }));
  assert.equal(await renewal, false);
  assert.equal(context.state.player.ownership.activeClaim, null);
  assert.equal(stopStreamingPlaybackCalls.length, 1);
});

{
  let updateCalls = 0;
  const { context, stopStreamingPlaybackCalls } = loadHelper({
    updatePlayerUi: () => {
      updateCalls += 1;
    },
  });
  const remoteTrack = {
    title: 'Remote Track',
    artist: 'Remote Artist',
    album: 'Remote Album',
    artworkUrl: null,
  };

  context.syncMirroredPlaybackState({
    is_playing_here: false,
    is_playing_elsewhere: true,
    status_label: 'Playing elsewhere',
    track: remoteTrack,
  });

  assert.deepEqual(
    stopStreamingPlaybackCalls,
    ['ownership-takeover'],
    'a remote owner closes the local streaming generation and both of its roles',
  );
  assert.equal(context.state.player.ownership.lockStatus, 'locked');
  assert.equal(context.state.player.ownership.blockedReason, 'playing_in_another_tab');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.player.ownership.mirroredTrack)),
    remoteTrack,
  );
  assert.equal(updateCalls, 1);
}
