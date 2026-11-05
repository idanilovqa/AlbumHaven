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
    Blob,
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
    performance,
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

function activeOwnershipState() {
  return {
    player: {
      current: localTrack,
      ownership: {
        tabId: 'departing-client',
        lockStatus: 'unlocked',
        blockedReason: '',
        mirroredTrack: null,
        activeClaim: {
          claimToken: 'departing-claim',
          leaseDeadline: Infinity,
          track: { playbackRef: 'departing-ref' },
        },
        channel: null,
        heartbeatTimer: 0,
        initialized: true,
      },
    },
  };
}

test('rejected handoff beacon removes the unusable session envelope', () => {
  const storage = new Map();
  const removed = [];
  let beacons = 0;
  const { context } = loadHelper({
    state: activeOwnershipState(),
    crypto: require('node:crypto').webcrypto,
    window: { crypto: require('node:crypto').webcrypto },
    getPlayerPlaybackSnapshot: () => ({ paused: false, ended: false }),
    getSessionStorageItem: key => storage.get(key) || '',
    setSessionStorageItem: (key, value) => { storage.set(key, value); return true; },
    removeSessionStorageItem: key => {
      if (storage.has(key)) removed.push(key);
      storage.delete(key);
    },
    navigator: { sendBeacon: () => { beacons += 1; return false; } },
  });

  assert.equal(context.stagePlaybackOwnershipHandoff(null), false);
  assert.equal(beacons, 1);
  assert.equal(storage.size, 0);
  assert.deepEqual(removed, ['albumhaven.playbackHandoff.v1']);
  assert.equal(context.stagePlaybackOwnershipHandoff(null), false);
  assert.equal(beacons, 1, 'one lifecycle cannot emit another handoff after a rejected beacon');
});

for (const failureMode of ['beacon', 'storage']) {
  test(`BFCache ${failureMode} failure renews the retained live claim without a null acquire`, async () => {
    const storage = new Map();
    const requests = [];
    let beacons = 0;
    const { context } = loadHelper({
      state: activeOwnershipState(),
      crypto: require('node:crypto').webcrypto,
      window: { crypto: require('node:crypto').webcrypto },
      getPlayerPlaybackSnapshot: () => ({ paused: false, ended: false, currentTime: 19 }),
      getSessionStorageItem: key => storage.get(key) || '',
      setSessionStorageItem: (key, value) => {
        if (failureMode === 'storage') return false;
        storage.set(key, value);
        return true;
      },
      removeSessionStorageItem: key => storage.delete(key),
      navigator: { sendBeacon: () => { beacons += 1; return false; } },
      fetch: async (url, options = {}) => {
        const body = JSON.parse(options.body);
        requests.push({ url, body });
        if (url === '/playback/refs') return jsonResponse({ protocol: 1,
          tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'retained-ref' }] });
        return jsonResponse({ protocol: 1, claimToken: body.claimToken,
          expiresAt: '2099-10-23T23:00:30Z', playbackState: { is_playing_here: true } });
      },
    });

    assert.equal(context.stagePlaybackOwnershipHandoff(null), false);
    assert.equal(beacons, failureMode === 'beacon' ? 1 : 0);
    assert.equal(storage.size, 0);
    assert.equal(await context.restorePlaybackOwnershipFromPageCache({
      paused: false, ended: false, currentTime: 19,
    }), true);

    const renewal = requests.find(({ url }) => url === '/playback/state');
    assert.ok(renewal);
    assert.equal(renewal.body.clientId, 'departing-client');
    assert.equal(renewal.body.claimToken, 'departing-claim');
    assert.equal(Object.prototype.hasOwnProperty.call(renewal.body, 'handoff'), false);
    assert.equal(requests.filter(({ url }) => url === '/playback/state').length, 1);
  });
}

test('expired handoff renews the still-live retained claim without a null acquire', async () => {
  const startedAt = Date.parse('2026-10-25T12:00:00Z');
  let now = startedAt;
  const storage = new Map();
  const requests = [];
  const state = activeOwnershipState();
  state.player.ownership.activeClaim.leaseDeadline = 30_000;
  const { context } = loadHelper({
    Date: class extends Date { static now() { return now; } },
    performance: { now: () => now - startedAt },
    state,
    crypto: require('node:crypto').webcrypto,
    window: { crypto: require('node:crypto').webcrypto },
    getPlayerPlaybackSnapshot: () => ({ paused: false, ended: false, currentTime: 19 }),
    getSessionStorageItem: key => storage.get(key) || '',
    setSessionStorageItem: (key, value) => { storage.set(key, value); return true; },
    removeSessionStorageItem: key => storage.delete(key),
    navigator: { sendBeacon: () => true },
    fetch: async (url, options = {}) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url === '/playback/refs') return jsonResponse({ protocol: 1,
        tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'retained-ref' }] });
      return jsonResponse({ protocol: 1, claimToken: body.claimToken,
        expiresAt: new Date(now + 30_000).toISOString(), playbackState: { is_playing_here: true } });
    },
  });

  assert.equal(context.stagePlaybackOwnershipHandoff(null), true);
  now = startedAt + 16_000;
  assert.equal(await context.restorePlaybackOwnershipFromPageCache({
    paused: false, ended: false, currentTime: 19,
  }), true);
  const renewal = requests.find(({ url }) => url === '/playback/state');
  assert.ok(renewal);
  assert.equal(renewal.body.clientId, 'departing-client');
  assert.equal(renewal.body.claimToken, 'departing-claim');
  assert.equal(Object.prototype.hasOwnProperty.call(renewal.body, 'handoff'), false);
  assert.equal(requests.filter(({ url }) => url === '/playback/state').length, 1);
});

for (const snapshot of [
  { paused: true, ended: false, currentTime: 19 },
  { paused: false, ended: true, currentTime: 19 },
]) {
  test(`BFCache fallback rejects a ${snapshot.paused ? 'paused' : 'ended'} saved snapshot`, async () => {
    let requests = 0;
    const { context } = loadHelper({
      state: activeOwnershipState(),
      getSessionStorageItem: () => '',
      removeSessionStorageItem: () => {},
      fetch: async () => { requests += 1; return jsonResponse({ protocol: 1 }); },
    });

    assert.equal(await context.restorePlaybackOwnershipFromPageCache(snapshot), false);
    assert.equal(requests, 0);
  });
}

test('BFCache fallback rejects an expired retained claim without acquiring anonymously', async () => {
  const state = activeOwnershipState();
  state.player.ownership.activeClaim.leaseDeadline = 30_000;
  let requests = 0;
  const { context } = loadHelper({
    performance: { now: () => 30_001 },
    state,
    getSessionStorageItem: () => '',
    removeSessionStorageItem: () => {},
    fetch: async () => { requests += 1; return jsonResponse({ protocol: 1 }); },
  });

  assert.equal(await context.restorePlaybackOwnershipFromPageCache({
    paused: false, ended: false, currentTime: 19,
  }), false);
  assert.equal(requests, 0);
});

test('new document restore rejects a malformed envelope without retained ownership', async () => {
  let requests = 0;
  const { context } = loadHelper({
    state: { player: { current: localTrack, ownership: { tabId: '', activeClaim: null, initialized: true } } },
    getSessionStorageItem: () => '{not-json',
    removeSessionStorageItem: () => {},
    fetch: async () => { requests += 1; return jsonResponse({ protocol: 1 }); },
  });

  assert.equal(await context.restorePlaybackOwnershipFromPageCache({
    paused: false, ended: false, currentTime: 19,
  }), false);
  assert.equal(requests, 0);
});

test('BFCache fallback fails closed when retained claim renewal is rejected', async () => {
  const requests = [];
  const { context } = loadHelper({
    state: activeOwnershipState(),
    getSessionStorageItem: () => '',
    removeSessionStorageItem: () => {},
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (!body) return jsonResponse({ protocol: 1, is_playing_here: false, is_playing_elsewhere: false });
      if (url === '/playback/refs') return jsonResponse({ protocol: 1,
        tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'retained-ref' }] });
      return jsonResponse({ error: 'claim expired' }, { ok: false, status: 409 });
    },
  });

  assert.equal(await context.restorePlaybackOwnershipFromPageCache({
    paused: false, ended: false, currentTime: 19,
  }), false);
  const renewal = requests.find(({ url }) => url === '/playback/state');
  assert.ok(renewal);
  assert.equal(renewal.body.claimToken, 'departing-claim');
  assert.equal(Object.prototype.hasOwnProperty.call(renewal.body, 'handoff'), false);
  assert.equal(requests.filter(({ url }) => url === '/playback/state').length, 1);
});

test('BFCache valid handoff ignores the retained heartbeat until consume completes', async () => {
  const envelope = {
    id: '12345678-1234-4123-8123-123456789abc',
    token: 'H'.repeat(43),
    expiresAt: '2099-10-23T23:00:15Z',
  };
  const pendingConsume = deferred();
  const requests = [];
  let heartbeat = null;
  let storageReads = 0;
  const { context } = loadHelper({
    state: activeOwnershipState(),
    crypto: require('node:crypto').webcrypto,
    window: { crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
    getPlayerPlaybackSnapshot: () => ({ paused: false, ended: false, currentTime: 19 }),
    getSessionStorageItem: () => (++storageReads === 1 ? '' : JSON.stringify(envelope)),
    removeSessionStorageItem: () => {},
    setInterval: (callback) => { heartbeat = callback; return 17; },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method: options.method, body });
      if (url === '/playback/refs') return jsonResponse({ protocol: 1,
        tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'handoff-ref' }] });
      if (options.method === 'PUT') {
        await pendingConsume.promise;
        return jsonResponse({ protocol: 1, claimToken: body.claimToken,
          expiresAt: '2099-10-23T23:00:30Z', playbackState: { is_playing_here: true } });
      }
      if (options.method === 'GET') return jsonResponse({ protocol: 1,
        is_playing_here: false, is_playing_elsewhere: true, track: localTrack });
      return jsonResponse({ protocol: 1 });
    },
  });
  context.startPlaybackOwnershipHeartbeat();

  const recovery = context.restorePlaybackOwnershipFromPageCache({
    paused: false, ended: false, currentTime: 19,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof heartbeat, 'function');
  heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  pendingConsume.resolve();

  assert.equal(await recovery, true);
  assert.equal(requests.filter(({ method }) => method === 'GET').length, 0,
    'the departing-client heartbeat cannot reject the fresh handoff client as another owner');
  assert.equal(context.isActivePlaybackOwner(), true);
  assert.equal(context.getPlaybackOwnershipState().tabId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(context.getPlaybackOwnershipState().heartbeatTimer, 17,
    'the retained heartbeat remains armed after recovery');
});

test('BFCache retained-claim fallback defers its heartbeat until the exact renewal completes', async () => {
  const pendingRenewal = deferred();
  const puts = [];
  let heartbeat = null;
  const { context } = loadHelper({
    state: activeOwnershipState(),
    getPlayerPlaybackSnapshot: () => ({ paused: false, ended: false, currentTime: 19 }),
    getSessionStorageItem: () => '',
    removeSessionStorageItem: () => {},
    setInterval: (callback) => { heartbeat = callback; return 23; },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') return jsonResponse({ protocol: 1,
        tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'retained-ref' }] });
      if (url === '/playback/state' && options.method === 'PUT') {
        puts.push(body);
        if (puts.length === 1) await pendingRenewal.promise;
        return jsonResponse({ protocol: 1, claimToken: body.claimToken,
          expiresAt: '2099-10-23T23:00:30Z', playbackState: { is_playing_here: true } });
      }
      return jsonResponse({ protocol: 1, is_playing_here: true, is_playing_elsewhere: false });
    },
  });
  context.startPlaybackOwnershipHeartbeat();

  const recovery = context.restorePlaybackOwnershipFromPageCache({
    paused: false, ended: false, currentTime: 19,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof heartbeat, 'function');
  heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  pendingRenewal.resolve();

  assert.equal(await recovery, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(puts.length, 1, 'the mid-recovery heartbeat cannot enqueue a second renewal');
  assert.equal(puts[0].clientId, 'departing-client');
  assert.equal(puts[0].claimToken, 'departing-claim');
  assert.equal(Object.prototype.hasOwnProperty.call(puts[0], 'handoff'), false);
  assert.equal(context.isActivePlaybackOwner(), true);
  assert.equal(context.getPlaybackOwnershipState().heartbeatTimer, 23);

  heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(puts.length, 2, 'the retained heartbeat resumes ordinary renewal after recovery');
});

test('handoff retry reuses the same fresh runtime pair', async () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const envelope = { id: '12345678-1234-4123-8123-123456789abc',
    token: 'A'.repeat(43), expiresAt: new Date(now + 15_000).toISOString() };
  const puts = [];
  const storageEvents = [];
  const { context } = loadHelper({
    Date: class extends Date { static now() { return now; } },
    crypto: require('node:crypto').webcrypto,
    window: { crypto: { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
    state: { player: { current: null, ownership: { tabId: '', initialized: true } } },
    getSessionStorageItem: () => { storageEvents.push('get'); return JSON.stringify(envelope); },
    removeSessionStorageItem: () => { storageEvents.push('remove'); },
    setTimeout: (callback, delay) => { if (delay === 100) callback(); return delay; },
    fetch: async (url, options = {}) => {
      const body = JSON.parse(options.body);
      if (url === '/playback/refs') return jsonResponse({ protocol: 1,
        tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'handoff-ref' }] });
      puts.push(body);
      if (puts.length === 1) return jsonResponse({ error: 'not staged yet' }, { ok: false, status: 409 });
      return jsonResponse({ protocol: 1, claimToken: body.claimToken,
        expiresAt: new Date(now + 30_000).toISOString(), playbackState: { is_playing_here: true } });
    },
  });

  assert.deepEqual(storageEvents, ['get', 'remove'], 'the envelope is recovered before restore starts');
  assert.equal(await context.canRestoreActivePlayback({ track: localTrack }), true);
  assert.equal(puts.length, 2);
  assert.equal(puts[0].clientId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(puts[0].claimToken.length, 43);
  assert.deepEqual(puts[1], puts[0]);
  assert.deepEqual(puts[0].handoff, { id: envelope.id, token: envelope.token });
});

test('lost committed consume response retries the exact runtime pair', async () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const envelope = { id: '12345678-1234-4123-8123-123456789abc',
    token: 'C'.repeat(43), expiresAt: new Date(now + 15_000).toISOString() };
  const puts = [];
  let committed = false;
  const { context } = loadHelper({
    Date: class extends Date { static now() { return now; } },
    crypto: require('node:crypto').webcrypto,
    window: { crypto: { randomUUID: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } },
    state: { player: { current: null, ownership: { tabId: '', initialized: true } } },
    getSessionStorageItem: () => JSON.stringify(envelope),
    removeSessionStorageItem: () => {},
    setTimeout: (callback, delay) => { if (delay === 100) callback(); return delay; },
    fetch: async (url, options = {}) => {
      const body = JSON.parse(options.body);
      if (url === '/playback/refs') return jsonResponse({ protocol: 1,
        tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'handoff-ref' }] });
      puts.push(body);
      if (!committed) {
        committed = true;
        throw new Error('response lost after commit');
      }
      return jsonResponse({ protocol: 1, claimToken: body.claimToken,
        expiresAt: new Date(now + 30_000).toISOString(), playbackState: { is_playing_here: true } });
    },
  });

  assert.equal(await context.canRestoreActivePlayback({ track: localTrack }), true);
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[1], puts[0]);
  assert.equal(puts[0].clientId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(puts[0].claimToken.length, 43);
  assert.deepEqual(puts[0].handoff, { id: envelope.id, token: envelope.token });
});

test('copied handoff envelope has one winner and bounded loser with fresh document credentials', async () => {
  const baseNow = Date.parse('2026-10-25T12:00:00Z');
  const envelope = { id: '12345678-1234-4123-8123-123456789abc',
    token: 'B'.repeat(43), expiresAt: new Date(baseNow + 500).toISOString() };
  let acceptedRuntimeClaim = '';
  const attempts = [];

  async function restoreCopy(clientId) {
    let now = baseNow;
    let storageReads = 0;
    const { context } = loadHelper({
      Date: class extends Date { static now() { return now; } },
      crypto: require('node:crypto').webcrypto,
      window: { crypto: { randomUUID: () => clientId } },
      state: { player: { current: localTrack, ownership: { tabId: '', initialized: true } } },
      getSessionStorageItem: () => (++storageReads === 1 ? '' : JSON.stringify(envelope)),
      removeSessionStorageItem: () => {},
      setTimeout: (callback, delay) => {
        if (delay <= 100) { now += 500; callback(); }
        return delay;
      },
      fetch: async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        if (!body) return jsonResponse({ protocol: 1, is_playing_here: false, is_playing_elsewhere: false });
        if (url === '/playback/refs') return jsonResponse({ protocol: 1,
          tracks: [{ clientKey: body.tracks[0].clientKey, playbackRef: 'handoff-ref' }] });
        attempts.push(body);
        if (!acceptedRuntimeClaim) {
          acceptedRuntimeClaim = body.claimToken;
          return jsonResponse({ protocol: 1, claimToken: body.claimToken,
            expiresAt: new Date(baseNow + 30_000).toISOString(), playbackState: { is_playing_here: true } });
        }
        return jsonResponse({ error: 'handoff consumed' }, { ok: false, status: 409 });
      },
    });
    return context.restorePlaybackOwnershipFromPageCache({
      paused: false, ended: false, currentTime: 19,
    });
  }

  assert.equal(await restoreCopy('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), true);
  assert.equal(await restoreCopy('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), false);
  assert.equal(attempts.length, 2, 'the copied-envelope loser stops at the handoff deadline');
  assert.notEqual(attempts[0].clientId, attempts[1].clientId);
  assert.notEqual(attempts[0].claimToken, attempts[1].claimToken);
  assert.deepEqual(attempts.map(({ handoff }) => handoff), [
    { id: envelope.id, token: envelope.token },
    { id: envelope.id, token: envelope.token },
  ]);
  assert.equal(attempts.every(({ claimToken, handoff }) => Boolean(claimToken && handoff)), true,
    'a copied-envelope loser never falls back to an anonymous acquire');
});

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

test('each claim answer says afresh whether listen writes can reach Last.fm', async () => {
  const answers = [{ available: false }, { available: true }, undefined];
  const { context } = loadHelper({
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') {
        return jsonResponse({
          ...protocolFixture.valid.refsResponse,
          expiresAt: '2099-10-24T00:00:00Z',
          tracks: [{ ...protocolFixture.valid.refsResponse.tracks[0], clientKey: body.tracks[0].clientKey }],
        });
      }
      const scrobbling = answers.shift();
      return jsonResponse({
        ...protocolFixture.valid.claimResponse,
        expiresAt: '2099-10-23T23:00:30Z',
        ...(scrobbling ? { scrobbling } : {}),
      });
    },
  });

  assert.equal(context.isScrobblingUnavailableAtClaim(), false, 'no claim says nothing');
  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  assert.equal(context.isScrobblingUnavailableAtClaim(), true);
  assert.equal(await context.refreshPlaybackOwnershipClaim(localTrack), true);
  assert.equal(context.isScrobblingUnavailableAtClaim(), false);
  // A heartbeat answer that does not say leaves the writes to the server's own 409.
  assert.equal(await context.refreshPlaybackOwnershipClaim(localTrack), true);
  assert.equal(context.state.player.ownership.activeClaim.scrobblingAvailable, null);
  assert.equal(context.isScrobblingUnavailableAtClaim(), false);
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

function leaseHarness({ clientOffsetMs = 0, renew }) {
  const serverNow = Date.parse('2026-10-25T12:00:00Z');
  const clock = { monotonic: 0 };
  const timers = [];
  let heartbeat = null;
  let renewals = 0;
  const loaded = loadHelper({
    Date: class extends Date { static now() { return serverNow + clientOffsetMs + clock.monotonic; } },
    performance: { now: () => clock.monotonic },
    setInterval: (callback) => { heartbeat = callback; return 17; },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    getPlayerPlaybackSnapshot: () => ({ paused: false, ended: false, currentTime: 0 }),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      if (url === '/playback/refs') return jsonResponse({ protocol: 1, tracks: [{
        clientKey: body.tracks[0].clientKey, playbackRef: 'playback-ref-1',
      }], expiresAt: new Date(serverNow + clock.monotonic + 86_400_000).toISOString() });
      const answer = () => jsonResponse({ protocol: 1, claimToken: 'claim-1',
        expiresAt: new Date(serverNow + clock.monotonic + 30_000).toISOString(),
        playbackState: { is_playing_here: true } });
      if (!body.claimToken) return answer();
      renewals += 1;
      return renew ? renew(answer, options.signal) : answer();
    },
  });
  loaded.context.state.player.current = localTrack;
  const leaseTimers = () => timers.filter(({ delay }) => delay === 30_000);
  return { ...loaded, clock, timers, leaseTimers, heartbeat: () => heartbeat(), renewals: () => renewals };
}

for (const clientOffsetMs of [300_000, -300_000]) {
  test(`a client clock ${clientOffsetMs > 0 ? 'ahead of' : 'behind'} the server by 5 minutes acquires and renews`, async () => {
    const harness = leaseHarness({ clientOffsetMs });
    const { context, clock, stopStreamingPlaybackCalls } = harness;

    assert.equal(await context.claimPlaybackOwnership(localTrack), true);
    assert.equal(context.isActivePlaybackOwner(), true);
    assert.equal(harness.leaseTimers().length, 1, 'the lease is timed from the answer, not the server clock');
    for (const at of [10_000, 20_000, 30_000, 40_000]) {
      clock.monotonic = at;
      harness.heartbeat();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(harness.renewals(), 4);
    clock.monotonic = 65_000;
    for (const { callback } of harness.leaseTimers().slice(0, -1)) await callback();
    assert.equal(context.isActivePlaybackOwner(), true);
    assert.equal(context.state.player.ownership.activeClaim.claimToken, 'claim-1');
    assert.equal(context.state.player.ownership.blockedReason, '');
    assert.deepEqual(stopStreamingPlaybackCalls, []);
  });
}

test('lease expiry defers to an in-flight renewal that the server confirms', async () => {
  const pendingRenewal = deferred();
  const harness = leaseHarness({ renew: (answer) => pendingRenewal.promise.then(answer) });
  const { context, clock, stopStreamingPlaybackCalls } = harness;
  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  clock.monotonic = 10_000;
  harness.heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.renewals(), 1);

  clock.monotonic = 30_000;
  const expiry = harness.leaseTimers()[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.isActivePlaybackOwner(), false, 'listen writes stop at the local lease deadline');
  assert.deepEqual(stopStreamingPlaybackCalls, [], 'the pending renewal still decides ownership');
  pendingRenewal.resolve();
  await expiry;
  assert.equal(context.isActivePlaybackOwner(), true);
  assert.equal(context.state.player.ownership.activeClaim.claimToken, 'claim-1');
  assert.deepEqual(stopStreamingPlaybackCalls, []);
});

test('lease expiry leaves a play queued behind a slow renewal to decide ownership', async () => {
  const pendingRenewal = deferred();
  let slow = true;
  const harness = leaseHarness({ renew: (answer) => {
    if (!slow) return answer();
    slow = false;
    return pendingRenewal.promise.then(answer);
  } });
  const { context, clock, stopStreamingPlaybackCalls } = harness;
  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  clock.monotonic = 20_000;
  harness.heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.renewals(), 1);

  clock.monotonic = 30_000;
  const expiry = harness.leaseTimers()[0].callback();
  clock.monotonic = 32_000;
  const play = context.claimPlaybackOwnership(localTrack);
  clock.monotonic = 35_000;
  pendingRenewal.resolve();
  await expiry;
  assert.equal(await play, true, 'the queued play acquires once the renewal settles');
  assert.equal(harness.renewals(), 2);
  assert.equal(context.isActivePlaybackOwner(), true);
  assert.equal(context.state.player.ownership.blockedReason, '');
  assert.deepEqual(stopStreamingPlaybackCalls, []);
});

test('lease expiry still drops ownership when renewals stop answering', async () => {
  const harness = leaseHarness({ renew: (_answer, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  const { context, clock, stopStreamingPlaybackCalls } = harness;
  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  clock.monotonic = 30_000;
  await harness.leaseTimers()[0].callback();
  assert.equal(context.state.player.ownership.activeClaim, null, 'no renewal in flight: the lease ends');
  assert.deepEqual(stopStreamingPlaybackCalls, ['ownership-lost']);

  assert.equal(await context.claimPlaybackOwnership(localTrack), true);
  harness.heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.renewals(), 1);
  clock.monotonic = 60_000;
  const expiry = harness.leaseTimers()[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(context.state.player.ownership.activeClaim, null);
  const renewalDeadline = harness.timers.filter(({ delay }) => delay === 10_000).at(-1);
  renewalDeadline.callback();
  await expiry;
  assert.equal(context.state.player.ownership.activeClaim, null);
  assert.equal(context.state.player.ownership.blockedReason, 'playback_unavailable');
  assert.deepEqual(stopStreamingPlaybackCalls, ['ownership-lost', 'ownership-lost']);
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

test('APK without native playback stays visibly blocked without claiming ownership', async () => {
  const requests = [];
  const toasts = [];
  const { context } = loadHelper({
    isAndroidPlaybackUnavailable: () => true,
    showToast: message => toasts.push(message),
    fetch: async (url, options) => {
      requests.push(`${options?.method || 'GET'} ${url}`);
      return { ok: true, status: 200, json: async () => ({ is_playing_elsewhere: false }) };
    },
  });
  assert.equal(await vm.runInContext("claimPlaybackOwnership({ path: 'a', title: 'A' })", context), false);
  assert.equal(context.state.player.ownership.blockedReason, 'playback_unavailable');
  assert.equal(context.state.player.ownership.lockStatus, 'locked');
  assert.equal(requests.some(request => request.startsWith('PUT') || request.startsWith('POST')), false);
  assert.deepEqual(toasts, ['Playback is unavailable.']);
});

test('a native-playback shell leaves the claim to Android and reads ownership as its client', async () => {
  const nativeClientId = '0c8f5a54-2d1e-4b7a-9a43-6f2d8b1c3e70';
  const requests = [];
  const { context } = loadHelper({
    isAndroidNativePlayback: () => true,
    getAndroidNativePlaybackClientId: () => nativeClientId,
    fetch: async (url, init = {}) => {
      requests.push({ url, method: init.method || 'GET' });
      return jsonResponse({ protocol: 1, is_playing_here: true, is_playing_elsewhere: false });
    },
  });

  assert.equal(await context.canStartPlaybackInThisTab(localTrack), true);
  assert.equal(context.getPlaybackOwnershipTabId(), nativeClientId);
  await context.handlePlaybackOwnershipEvent();
  assert.deepEqual(requests, [{ url: `/playback/state?client_id=${nativeClientId}`, method: 'GET' }]);
  assert.equal(context.isActivePlaybackOwner(), false);
});
