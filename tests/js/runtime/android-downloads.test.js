// Downloads inside the Android app: same-origin server files through a cookie-less link the shell
// asks this page for (downloads.link.v1), and page-built files handed to the shell (files.save.v1).
// Without either capability the page keeps what it did before.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadCapabilityUi } = require('../support/capability-ui-context.cjs');

const repoRoot = path.join(__dirname, '..', '..', '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'android-bridge', 'v1.json'), 'utf8'));
const runtimeDir = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime');
const handshakePayload = fixture.handshakeResponse.payload;
const without = name => ({ ...handshakePayload, capabilities: handshakePayload.capabilities.filter(item => item !== name) });

function loadRuntime({ handshake = handshakePayload, shell = true, answer = () => ({}), fetchResponse } = {}) {
  const sent = [];
  const fetches = [];
  const anchors = [];
  const bridge = {
    postMessage(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.type !== 'command') return;
      const payload = message.name === 'bridge.handshake' ? handshake : { ok: true, ...answer(message) };
      queueMicrotask(() => bridge.onmessage({ data: JSON.stringify({ ...message, type: 'response', payload }) }));
    },
  };
  const context = {
    window: { crypto, btoa: text => Buffer.from(text, 'binary').toString('base64') },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    Blob,
    URL: { createObjectURL: () => 'blob:page-file', revokeObjectURL() {} },
    document: {
      body: { appendChild() {} },
      createElement: () => {
        const anchor = { click() { anchors.push({ href: anchor.href, download: anchor.download }); }, remove() {} };
        return anchor;
      },
    },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return fetchResponse ?? { ok: true, json: async () => ({ url: fixture.downloadLinkResponse.payload.url, expiresAt: 'x' }) };
    },
  };
  if (shell) context.window.AlbumHavenBridge = bridge;
  vm.createContext(context);
  loadCapabilityUi(context);
  vm.runInContext(fs.readFileSync(path.join(runtimeDir, 'android-bridge-client.js'), 'utf8'), context);
  vm.runInContext('globalThis.api = { connectAndroidBridge, downloadPageFile };', context);
  return { api: context.api, bridge, sent, fetches, anchors };
}

async function askForLink(runtime, request = fixture.downloadLinkRequest) {
  await runtime.api.connectAndroidBridge();
  runtime.sent.length = 0;
  runtime.bridge.onmessage({ data: JSON.stringify(request) });
  await new Promise(setImmediate);
  return runtime.sent;
}

test('the shell asks for a link and the page answers with the one the server issued', async () => {
  const runtime = loadRuntime();
  const replies = await askForLink(runtime);
  assert.deepEqual(replies, [fixture.downloadLinkResponse]);
  assert.equal(runtime.fetches.length, 1);
  const { url, options } = runtime.fetches[0];
  assert.equal(url, '/downloads/links');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(options.body), { path: fixture.downloadLinkRequest.payload.path });
});

test('a path the server refuses answers download_unavailable', async () => {
  const runtime = loadRuntime({
    fetchResponse: { ok: false, json: async () => ({ detail: 'Download unavailable.', code: 'download_unavailable' }) },
  });
  const [reply] = await askForLink(runtime);
  assert.equal(reply.id, fixture.downloadLinkRequest.id);
  assert.deepEqual(reply.payload, { ok: false, error: { code: 'download_unavailable', message: 'Download unavailable.' } });
});

test('a shell without downloads.link.v1 is never answered and nothing is requested', async () => {
  const runtime = loadRuntime({ handshake: without('downloads.link.v1') });
  assert.deepEqual(await askForLink(runtime), []);
  assert.deepEqual(runtime.fetches, []);
});

test('a page-built file goes to a shell with files.save.v1 in chunks within the message limit', async () => {
  const runtime = loadRuntime();
  const text = `${'é'.repeat(60 * 1024)}\n`;
  await runtime.api.downloadPageFile('album-haven-logs-2026-11-05.json', 'application/json', text);

  const saves = runtime.sent.filter(message => message.name === 'files.save');
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(saves.length, Math.ceil(bytes.length / (45 * 1024)));
  assert.equal(new Set(saves.map(message => message.payload.transfer)).size, 1);
  assert.deepEqual(Buffer.concat(saves.map(message => Buffer.from(message.payload.data, 'base64'))), bytes);
  for (const [index, message] of saves.entries()) {
    assert.equal(Buffer.byteLength(JSON.stringify(message)) <= fixture.maxMessageBytes, true);
    assert.deepEqual(Object.keys(message.payload).sort(), Object.keys(fixture.fileSaveRequest.payload).sort());
    assert.equal(message.payload.offset, index * 45 * 1024);
    assert.equal(message.payload.size, bytes.length);
    assert.equal(message.payload.name, 'album-haven-logs-2026-11-05.json');
    assert.equal(message.payload.mimeType, 'application/json');
  }
  assert.deepEqual(runtime.anchors, []);
});

test('a file over 10 MB is refused before anything reaches the shell', async () => {
  const runtime = loadRuntime();
  await assert.rejects(() => runtime.api.downloadPageFile('big.json', 'application/json', 'x'.repeat(10 * 1024 * 1024 + 1)));
  assert.equal(runtime.sent.filter(message => message.name === 'files.save').length, 0);
});

test('a refused save rejects the download', async () => {
  const runtime = loadRuntime({ answer: () => ({ ok: false, error: { code: 'save_failed', message: 'The file was not saved' } }) });
  await assert.rejects(() => runtime.api.downloadPageFile('a.json', 'application/json', '{}'), /The file was not saved/);
  assert.deepEqual(runtime.anchors, []);
});

for (const [name, options] of [['a browser', { shell: false }], ['a shell without files.save.v1', { handshake: without('files.save.v1') }]]) {
  test(`${name} keeps the download anchor`, async () => {
    const runtime = loadRuntime(options);
    await runtime.api.downloadPageFile('album-haven-logs-2026-11-05.json', 'application/json', '{}');
    assert.deepEqual(runtime.anchors, [{ href: 'blob:page-file', download: 'album-haven-logs-2026-11-05.json' }]);
    assert.equal(runtime.sent.filter(message => message.name === 'files.save').length, 0);
  });
}
