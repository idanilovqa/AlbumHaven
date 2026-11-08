// Production web releases support the latest and the immediately previous stable shell. Each one
// is described in tests/fixtures/android-bridge/stable-shells.json; this runs the web bridge client,
// its native playback adapter and Settings against each of their handshakes, and against each with
// one optional capability missing, so an older shell's capability set hides features, never errors.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadCapabilityUi } = require('../support/capability-ui-context.cjs');

const repoRoot = path.join(__dirname, '..', '..', '..');
const runtimeDir = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime');
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'android-bridge');
const readJson = file => JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8'));
const stableShells = readJson('stable-shells.json');
const SUPPORTED = ['latest', 'previous'];
const RUNTIME_FILES = ['player-streaming-engine.js', 'android-bridge-client.js', 'player-listen-session-helpers.js',
  'playback-ownership-helpers.js', 'android-settings.js'];
const AUDIO_CAPABILITIES = ['playback.native.v1', 'playback.webview.v1'];

const tracks = ['Signal A', 'Signal B', 'Signal C'].map((title, index) => ({
  path: `C:/Music/Android Acceptance/0${index + 1} ${title}.flac`,
  src: `/track?id=${index}`,
  title,
  artist: 'Android Acceptance',
  album: 'Playback Ownership',
  durationSeconds: 180,
}));

/** The handshake answer `shell` gives this site, built from its protocol's shared fixture. */
function stableHandshake(shell, capabilities = shell.capabilities) {
  const { sandbox: _sandbox, ...payload } = readJson(shell.fixture).handshakeResponse.payload;
  return {
    ...payload,
    applicationId: 'org.albumhaven.app',
    variant: 'stable',
    bridgeProtocol: shell.bridgeProtocolMax,
    bridgeProtocolMin: shell.bridgeProtocolMin,
    bridgeProtocolMax: shell.bridgeProtocolMax,
    capabilities,
  };
}

/** The capabilities a shell needs to accept `message`, as BridgeController and PlaybackBridge check them. */
function capabilitiesFor({ name, payload }) {
  if (name === 'sandbox.select') return ['sandbox.select.v1'];
  if (name.startsWith('updates.')) return ['updates.manual.v1'];
  if (name === 'files.save') return ['files.save.v1'];
  if (name === 'playback.setLoop' || name === 'playback.clearLoop') return ['playback.native.v1', 'playback.loops.v2'];
  if (name === 'playback.loadQueue' && payload.keepCurrent) return ['playback.native.v1', 'playback.queue.v1'];
  if (name.startsWith('playback.')) return ['playback.native.v1'];
  return [`unknown command ${name}`];
}

const V1_LOAD = readJson('v1.json').loadQueueRequest.payload;
const sortedKeys = (value, optional) => Object.keys(value).filter(key => key !== optional).sort().join();

/** PlaybackBridge.parseLoad accepts exactly the v1 keys, with `keepCurrent` and `resumeToken` optional. */
function isV1LoadQueue(payload) {
  return sortedKeys(payload, 'keepCurrent') === sortedKeys(V1_LOAD)
    && Array.isArray(payload.items)
    && payload.items.every(item => sortedKeys(item, 'resumeToken') === sortedKeys(V1_LOAD.items[0], 'resumeToken'));
}

function loadSite({ respond, source = file => fs.readFileSync(path.join(runtimeDir, file), 'utf8') }) {
  let capabilities = [];
  const bridge = {
    sent: [],
    refused: [],
    postMessage(raw) {
      const message = JSON.parse(raw);
      bridge.sent.push(message);
      const answer = respond(message);
      if (message.name === 'bridge.handshake') capabilities = answer?.capabilities || [];
      // A shell refuses every command whose capability it lacks, so the site must never send one.
      const missing = message.name === 'bridge.handshake' ? []
        : capabilitiesFor(message).filter(name => !capabilities.includes(name));
      if (missing.length) bridge.refused.push(`${message.name} without ${missing.join(', ')}`);
      const invalid = message.name === 'playback.loadQueue' && !isV1LoadQueue(message.payload);
      if (invalid) bridge.refused.push(`${message.name} with keys outside the v1 contract`);
      const payload = answer || (missing.length
        ? { ok: false, error: { code: 'unsupported_command', message: 'Unsupported command' } }
        : invalid ? { ok: false, error: { code: 'invalid_payload', message: 'Invalid playback command' } }
        : { ok: true, ...(message.name === 'playback.loadQueue' ? { queueRevision: message.payload.queueRevision } : {}) });
      Promise.resolve(payload).then(answer => bridge.onmessage({
        data: JSON.stringify({ ...message, type: 'response', payload: answer }),
      }));
    },
  };
  // The cogwheel menu's Update row, hidden until Settings shows it.
  const updateRow = {
    hidden: true, attributes: {}, label: { textContent: '' }, detail: {},
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector(selector) { return selector === '[data-android-update-label]' ? this.label : this.detail; },
    closest() { return this; },
  };
  // Browser audio must never start next to a negotiated native player.
  const forbidden = name => class { constructor() { throw new Error(`${name} must not start inside a native shell`); } };
  const window = {
    crypto,
    AlbumHavenBridge: bridge,
    AudioContext: forbidden('AudioContext'),
    WebSocket: forbidden('WebSocket'),
    ButtonComponent: {
      renderButton: ({ label, disabled, attributes = {} }) => `<button${disabled ? ' disabled' : ''} ${Object.keys(attributes).join(' ')}>${label}</button>`,
    },
  };
  const context = {
    window,
    console,
    crypto,
    TextEncoder,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance: { now: () => 0 },
    AudioContext: window.AudioContext,
    WebSocket: window.WebSocket,
    document: { addEventListener: () => {}, querySelector: selector => (selector === '[data-android-update-menu-item]' ? updateRow : null) },
    escapeHtml: value => String(value),
    buildOnPageAlertHtml: ({ severity, title, message, actionsHtml = '' }) => `<alert ${severity}>${title}|${message}${actionsHtml}</alert>`,
    buildStatusBadgeHtml: ({ label, variant }) => `<badge ${variant}>${label}</badge>`,
    state: {
      utility: { activeTab: 'appearance' },
      player: {
        playbackQueue: { tracks, currentIndex: 0 },
        current: null,
        streaming: {
          mode: 'stopped', generation: 0, roles: { current: null, continuity: null },
          snapshot: { currentTime: 0, duration: 0, paused: true, ended: false, src: '', readyState: 0 },
          diagnostics: { bufferedFrames: { current: 0, continuity: 0 }, inFlightFrames: { current: 0, continuity: 0 }, activeRoles: [] },
        },
      },
    },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          protocol: 1,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          tracks: body.tracks.map((track, index) => ({
            clientKey: track.clientKey, playbackRef: `opaque-ref-${index}`, resumeToken: `opaque-resume-${index}`,
          })),
        }),
      };
    },
    handleStreamingPlaybackFirstFrame: async () => {},
    handleStreamingPlaybackPosition: async () => {},
    handleStreamingPlaybackBoundary: async () => {},
    handleStreamingPlaybackEnded: async () => {},
    updatePlayerUi: () => {},
  };
  vm.createContext(context);
  loadCapabilityUi(context);
  for (const file of RUNTIME_FILES) vm.runInContext(source(file), context, { filename: file });
  vm.runInContext(`globalThis.api = { androidBridge, connectAndroidBridge, androidNativePlaybackRoute,
    isAndroidPlaybackUnavailable, isAndroidUpdateRequired, isAndroidNativePlayback, buildAndroidSettingsHtml,
    initAndroidSettings, handleAndroidSettingsClick, protocolRange: [ANDROID_BRIDGE_PROTOCOL_MIN, ANDROID_BRIDGE_PROTOCOL_MAX],
    capabilityUse: ANDROID_BRIDGE_CAPABILITY_USE, start: startStreamingTrack, pause: pauseStreamingPlayback,
    resume: resumeStreamingPlayback, seek: seekStreamingPlayback, continuity: scheduleStreamingContinuity,
    setLoop: setStreamingLoop, stop: stopStreamingPlayback };`, context);
  return { api: context.api, bridge, context, updateRow };
}

const answering = handshake => message => (message.name === 'bridge.handshake' ? handshake : null);
const commands = (bridge, name) => bridge.sent.filter(message => message.name === name);

/** Everything a page does with a shell that can run it: connect, Settings, and playback. */
async function exerciseSite(handshake) {
  const { api, bridge, context, updateRow } = loadSite({ respond: answering(handshake) });
  const has = name => handshake.capabilities.includes(name);
  api.initAndroidSettings();
  const info = await api.connectAndroidBridge();
  assert.equal(api.isAndroidUpdateRequired(), false);
  assert.equal(info.versionCode, handshake.versionCode);

  const settings = api.buildAndroidSettingsHtml(info);
  assert.match(settings, /Stable · 0\.9\.50 \(1\)/);
  assert.doesNotMatch(settings, /Check for update/);
  // Updates run from the cogwheel menu's row, shown only to a shell that offers them.
  assert.equal(updateRow.hidden, !has('updates.manual.v1'));
  if (!updateRow.hidden) {
    assert.equal(updateRow.label.textContent, 'Check for update');
    api.handleAndroidSettingsClick({ target: updateRow, preventDefault() {} });
    await new Promise(setImmediate);
    assert.equal(commands(bridge, 'updates.check').length, 1);
    // A reply that names no update state still releases the pressed row.
    assert.equal(updateRow.getAttribute('aria-disabled'), null);
  }

  const native = handshake.capabilities.includes('playback.native.v1');
  const audible = AUDIO_CAPABILITIES.some(name => handshake.capabilities.includes(name));
  assert.equal(api.isAndroidPlaybackUnavailable(), !audible);
  assert.equal(await api.androidNativePlaybackRoute(), native);
  if (native) {
    await api.start(tracks[0], { autoplay: true });
    // The web queue changes under Android: the new successor replaces the queue around the playing item.
    context.state.player.playbackQueue = { tracks: [tracks[0], tracks[2]], currentIndex: 0 };
    await api.continuity(tracks[2]);
    // Android reports the playing track's rate, which loop points are counted in.
    const queueRevision = commands(bridge, 'playback.loadQueue').at(-1).payload.queueRevision;
    bridge.onmessage({ data: JSON.stringify({
      protocol: 1, id: 'state-event', type: 'event', name: 'playback.state',
      payload: { ...readJson('v1.json').stateEvent.payload, queueRevision, state: 'playing', sampleRate: 44100 },
    }) });
    await api.continuity(tracks[0], { kind: 'long-loop', startSeconds: 10, endSeconds: 20 });
    api.setLoop(false);
    await api.pause();
    await api.resume();
    await api.seek(30);
    await api.stop();
    await new Promise(setImmediate);
    const [load] = commands(bridge, 'playback.loadQueue');
    assert.ok(load.payload.items.every(item => ('resumeToken' in item) === has('playback.resumption.v1')));
    assert.equal(commands(bridge, 'playback.loadQueue').length, has('playback.queue.v1') ? 2 : 1);
    for (const name of ['playback.setLoop', 'playback.clearLoop']) {
      assert.equal(commands(bridge, name).length, has('playback.loops.v2') ? 1 : 0, name);
    }
    for (const name of ['playback.pause', 'playback.play', 'playback.seek', 'playback.stop']) {
      assert.equal(commands(bridge, name).length >= 1, true, name);
    }
  }
  assert.deepEqual(bridge.refused, []);
  // Every command after the handshake speaks the protocol the shell negotiated.
  assert.ok(bridge.sent.slice(1).every(message => message.protocol === handshake.bridgeProtocol));
  return { api, bridge };
}

test('the stable shell record names the latest and previous shells by their protocol fixtures', () => {
  assert.equal(stableShells.schemaVersion, 1);
  assert.equal(stableShells.channel, 'stable');
  assert.deepEqual(Object.keys(stableShells.shells).sort(), [...SUPPORTED].sort());
  const current = readJson('v1.json').capabilities.stable;
  for (const role of SUPPORTED) {
    const shell = stableShells.shells[role];
    assert.equal(shell.fixture, `v${shell.bridgeProtocolMax}.json`, role);
    assert.equal(readJson(shell.fixture).protocol, shell.bridgeProtocolMax, role);
    assert.ok(shell.bridgeProtocolMin >= 1 && shell.bridgeProtocolMin <= shell.bridgeProtocolMax, role);
    assert.equal(new Set(shell.capabilities).size, shell.capabilities.length, role);
    if (shell.versionCode === null) {
      // Before its first promotion a record can only describe what the shell source advertises.
      assert.equal(shell.sourceCommit, null, role);
      assert.ok(shell.capabilities.every(name => current.includes(name)), role);
    } else {
      assert.ok(Number.isInteger(shell.versionCode) && shell.versionCode > 0, role);
      assert.match(shell.sourceCommit, /^[0-9a-f]{40}$/, role);
    }
  }
  const { latest, previous } = stableShells.shells;
  if (latest.versionCode !== null && previous.versionCode !== null) assert.ok(latest.versionCode >= previous.versionCode);
});

test('the site speaks a bridge protocol of both the latest and the previous stable shell', () => {
  const { api } = loadSite({ respond: () => null });
  const [min, max] = api.protocolRange;
  for (const role of SUPPORTED) {
    const shell = stableShells.shells[role];
    assert.ok(Math.min(max, shell.bridgeProtocolMax) >= Math.max(min, shell.bridgeProtocolMin), role);
  }
});

test('every shell capability the site reads is declared with what its absence means', () => {
  const { api } = loadSite({ respond: () => null });
  const read = new Set();
  for (const file of fs.readdirSync(runtimeDir).filter(name => name.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(runtimeDir, file), 'utf8');
    for (const match of source.matchAll(/hasAndroidCapability\('([^']+)'\)|_CAPABILITY = '([^']+)'/g)) read.add(match[1] || match[2]);
  }
  assert.deepEqual([...read].sort(), Object.keys(api.capabilityUse).sort());
  assert.ok(Object.values(api.capabilityUse).every(use => use === 'optional' || use === 'required'));
});

test('capabilities the site requires are in both supported stable shells', () => {
  const { api } = loadSite({ respond: () => null });
  const required = Object.keys(api.capabilityUse).filter(name => api.capabilityUse[name] === 'required');
  for (const role of SUPPORTED) {
    assert.deepEqual(required.filter(name => !stableShells.shells[role].capabilities.includes(name)), [], role);
  }
});

for (const role of SUPPORTED) {
  const shell = stableShells.shells[role];

  test(`the ${role} stable shell runs the site: connect, Settings and native playback`, async () => {
    await exerciseSite(stableHandshake(shell));
  });

  for (const missing of shell.capabilities) {
    test(`the ${role} stable shell without ${missing} hides that feature without errors`, async () => {
      await exerciseSite(stableHandshake(shell, shell.capabilities.filter(name => name !== missing)));
    });
  }
}

test('the latest sandbox shell runs the site', async () => {
  const handshake = readJson('v1.json').handshakeResponse.payload;
  const { api } = loadSite({ respond: answering(handshake) });
  const info = await api.connectAndroidBridge();
  assert.match(api.buildAndroidSettingsHtml(info), /Sandbox server/);
  assert.equal(await api.androidNativePlaybackRoute(), true);
});

test('a shell with no audio capability keeps playback failed closed', async () => {
  const { api } = await exerciseSite(stableHandshake(stableShells.shells.latest, ['updates.manual.v1']));
  assert.equal(api.isAndroidPlaybackUnavailable(), true);
});

test('a shell with no shared protocol leaves the site in its update-required state', async () => {
  const { api } = loadSite({
    respond: () => ({ ok: false, error: { code: 'incompatible_bridge', message: 'No shared protocol' } }),
  });
  assert.equal(await api.connectAndroidBridge(), null);
  assert.equal(api.isAndroidUpdateRequired(), true);
  assert.equal(api.isAndroidPlaybackUnavailable(), true);
  assert.equal(await api.androidNativePlaybackRoute(), false);
  assert.match(api.buildAndroidSettingsHtml(null), /<alert warning>Update required\|This version of Album Haven can’t open the current site\. Install the latest app to continue\.<\/alert>/);
});

test('an unreachable shell is a connection failure, not an update requirement', async () => {
  const { api } = loadSite({ respond: () => ({ ok: false, error: { code: 'timeout', message: 'Timed out' } }) });
  assert.equal(await api.connectAndroidBridge(), null);
  assert.equal(api.isAndroidUpdateRequired(), false);
  assert.match(api.buildAndroidSettingsHtml(null), /This app could not connect to the current site/);
});

// A site that requires a capability names it in the handshake. Today none is required, so the
// test promotes one in the loaded source.
function requiringUpdates(file) {
  const source = fs.readFileSync(path.join(runtimeDir, file), 'utf8');
  return file === 'android-bridge-client.js'
    ? source.replace('"updates.manual.v1": "optional"', '"updates.manual.v1": "required"') : source;
}

test('a required capability is named in the handshake and a refusing shell shows update required', async () => {
  const { api, bridge } = loadSite({
    source: requiringUpdates,
    respond: () => ({ ok: false, error: { code: 'update_required', message: 'Missing required capability' } }),
  });
  assert.equal(await api.connectAndroidBridge(), null);
  assert.deepEqual(bridge.sent[0].payload.requiredCapabilities, ['updates.manual.v1']);
  assert.equal(api.isAndroidUpdateRequired(), true);
  assert.equal(api.isAndroidPlaybackUnavailable(), true);
});

test('a shell that negotiates without a required capability still leaves the site update-required', async () => {
  const handshake = stableHandshake(stableShells.shells.latest,
    stableShells.shells.latest.capabilities.filter(name => name !== 'updates.manual.v1'));
  const { api, bridge } = loadSite({ source: requiringUpdates, respond: answering(handshake) });
  assert.equal(await api.connectAndroidBridge(), null);
  assert.equal(api.isAndroidUpdateRequired(), true);
  assert.equal(api.isAndroidPlaybackUnavailable(), true);
  await api.androidNativePlaybackRoute();
  assert.deepEqual(bridge.sent.map(message => message.name), ['bridge.handshake']);
});

test('a shell that negotiates a protocol outside the site range leaves the site update-required', async () => {
  const handshake = { ...stableHandshake(stableShells.shells.latest), bridgeProtocol: 9, bridgeProtocolMin: 9, bridgeProtocolMax: 9 };
  const { api } = loadSite({ respond: answering(handshake) });
  assert.equal(await api.connectAndroidBridge(), null);
  assert.equal(api.isAndroidUpdateRequired(), true);
});
