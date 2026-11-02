const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'android-bridge-v1.json'), 'utf8'));
const runtimeDir = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime');
const handshakePayload = fixture.handshakeResponse.payload;

function loadRuntime({ bridge } = {}) {
  const listeners = [];
  const context = {
    window: {
      crypto,
      ButtonComponent: {
        renderButton: ({ label, disabled, attributes }) => `<button${disabled ? ' disabled' : ''} ${Object.keys(attributes).join(' ')}>${label}</button>`,
      },
    },
    document: { addEventListener: (type, listener) => listeners.push({ type, listener }), querySelector: () => null },
    state: { utility: { activeTab: 'appearance' } },
    setTimeout,
    clearTimeout,
    escapeHtml: value => String(value),
    buildOnPageAlertHtml: ({ severity, title, message }) => `<alert ${severity}>${title}|${message}</alert>`,
    calls: [],
  };
  if (bridge) context.window.AlbumHavenBridge = bridge;
  vm.createContext(context);
  for (const file of ['android-bridge-client.js', 'android-settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtimeDir, file), 'utf8'), context, { filename: file });
  }
  vm.runInContext(`globalThis.api = { androidBridge, androidSettings, buildAndroidSettingsHtml,
    connectAndroidBridge, initAndroidSettings, isAndroidPlaybackUnavailable, isAndroidShell, selectAndroidSandbox };`, context);
  context.listeners = listeners;
  return context;
}

function fakeBridge(respond) {
  const bridge = {
    sent: [],
    postMessage(raw) {
      const message = JSON.parse(raw);
      bridge.sent.push(message);
      const payload = respond(message);
      if (payload) {
        queueMicrotask(() => bridge.onmessage({ data: JSON.stringify({ ...message, type: 'response', payload }) }));
      }
    },
  };
  return bridge;
}

test('ordinary browsers have no Android shell and never gate playback', async () => {
  const { api } = loadRuntime();
  assert.equal(api.isAndroidShell(), false);
  assert.equal(api.isAndroidPlaybackUnavailable(), false);
  assert.equal(await api.connectAndroidBridge(), null);
});

test('ordinary browsers register no Android listeners', () => {
  const context = loadRuntime();
  context.api.initAndroidSettings();
  assert.equal(context.listeners.length, 0);
});

test('handshake request matches the shared fixture envelope', async () => {
  const bridge = fakeBridge(() => handshakePayload);
  const { api } = loadRuntime({ bridge });
  const info = await api.connectAndroidBridge();
  const { id, ...sent } = bridge.sent[0];
  const { id: _fixtureId, ...expected } = fixture.handshakeRequest;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(sent, expected);
  assert.equal(info.variant, 'sandbox');
});

test('connection is negotiated once per document', async () => {
  const bridge = fakeBridge(() => handshakePayload);
  const { api } = loadRuntime({ bridge });
  await Promise.all([api.connectAndroidBridge(), api.connectAndroidBridge()]);
  assert.equal(bridge.sent.length, 1);
});

test('playback stays unavailable before and after a handshake without native audio', async () => {
  const bridge = fakeBridge(() => handshakePayload);
  const { api } = loadRuntime({ bridge });
  assert.equal(api.isAndroidPlaybackUnavailable(), true);
  await api.connectAndroidBridge();
  assert.equal(api.isAndroidPlaybackUnavailable(), true);
});

test('incompatible handshake leaves the shell gated and reports no info', async () => {
  const bridge = fakeBridge(() => ({ ok: false, error: { code: 'incompatible_bridge', message: 'No shared protocol' } }));
  const { api } = loadRuntime({ bridge });
  assert.equal(await api.connectAndroidBridge(), null);
  assert.equal(api.isAndroidPlaybackUnavailable(), true);
});

test('native playback capability lifts the gate', async () => {
  const bridge = fakeBridge(() => ({ ...handshakePayload, capabilities: ['playback.native.v1'] }));
  const { api } = loadRuntime({ bridge });
  await api.connectAndroidBridge();
  assert.equal(api.isAndroidPlaybackUnavailable(), false);
});

test('malformed and uncorrelated bridge replies are ignored', async () => {
  const bridge = fakeBridge(() => null);
  const { api } = loadRuntime({ bridge });
  const pending = api.connectAndroidBridge();
  bridge.onmessage({ data: 'not json' });
  bridge.onmessage({ data: JSON.stringify({ type: 'response', id: 'other', payload: { ok: true } }) });
  assert.equal(api.androidBridge.pending.size, 1);
  bridge.onmessage({ data: JSON.stringify({ ...bridge.sent[0], type: 'response', payload: handshakePayload }) });
  assert.equal((await pending).variant, 'sandbox');
});

test('stable card shows the version with no selector or native update action', () => {
  const { api } = loadRuntime();
  const html = api.buildAndroidSettingsHtml({ variant: 'stable', versionName: '0.9.50', versionCode: 1, capabilities: [] });
  assert.match(html, /Stable · 0\.9\.50 \(1\)/);
  assert.doesNotMatch(html, /Sandbox server|Check for updates/);
});

test('sandbox card shows the approved selector and notice without ownership wording', () => {
  const { api } = loadRuntime();
  const html = api.buildAndroidSettingsHtml(handshakePayload);
  assert.match(html, /S · Sandbox/);
  assert.match(html, /Sandbox server/);
  assert.match(html, /https:\/\/sandbox2\.albumhaven\.org/);
  assert.match(html, /Changing sandbox stops playback, clears the current queue, and loads the selected server\./);
  assert.doesNotMatch(html, /ownership/i);
});

test('failed sandbox switch keeps the current server and explains it', async () => {
  const bridge = fakeBridge(message => (message.name === 'bridge.handshake'
    ? handshakePayload
    : { ok: false, error: { code: 'connection_failed', message: 'Sandbox is unreachable' } }));
  const context = loadRuntime({ bridge });
  vm.runInContext('renderUtilityAndroid = () => { calls.push(androidSettings.status.title); };', context);
  await context.api.connectAndroidBridge();
  await context.api.selectAndroidSandbox(3);
  assert.deepEqual([...context.calls], ['Switching to sandbox3…', 'Could not connect to sandbox3.']);
  assert.equal(context.api.androidSettings.switching, false);
  assert.match(context.api.androidSettings.status.message, /Still using sandbox2/);
  assert.deepEqual(bridge.sent[1].payload, { slot: 3 });
});

test('selecting the current sandbox sends nothing', async () => {
  const bridge = fakeBridge(() => handshakePayload);
  const { api } = loadRuntime({ bridge });
  await api.connectAndroidBridge();
  await api.selectAndroidSandbox(2);
  assert.equal(bridge.sent.length, 1);
});

test('connected slot from the shell becomes the approved success status', async () => {
  const bridge = fakeBridge(() => ({ ...handshakePayload, sandbox: { slot: 3, connectedSlot: 3 } }));
  const { api } = loadRuntime({ bridge });
  api.initAndroidSettings();
  await api.connectAndroidBridge();
  await new Promise(setImmediate);
  assert.equal(api.androidSettings.status.severity, 'success');
  assert.equal(api.androidSettings.status.title, 'Connected to sandbox3.');
});
