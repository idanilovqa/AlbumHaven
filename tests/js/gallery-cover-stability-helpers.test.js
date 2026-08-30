const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const helperUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'helpers',
  'galleryCoverStabilityHelpers.js',
)).href;

test('Joseph outage helper renames and restores only its runner-owned fixture', async () => {
  const helper = await import(helperUrl);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-e2e-helper-'));
  const mediaRoot = path.join(tempRoot, 'media');
  fs.mkdirSync(mediaRoot);
  const sourcePath = path.join(mediaRoot, 'Neal Morse - The Dreamer - Joseph, Pt. One.png');
  fs.writeFileSync(sourcePath, 'fixture');
  try {
    const outage = helper.temporarilyMakeJosephCoverUnavailable(
      `/cover?path=${encodeURIComponent(sourcePath)}`,
      'http://127.0.0.1:4173/albums',
      { mediaRoot },
    );
    assert.equal(fs.existsSync(sourcePath), false);
    outage.restore();
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), 'fixture');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Joseph outage helper rejects the owner library drive before touching the filesystem', async () => {
  const helper = await import(helperUrl);
  assert.throws(
    () => helper.temporarilyMakeJosephCoverUnavailable(
      'http://127.0.0.1:4173/cover?path=N%3A%5CMusic%5CNeal%20Morse%20-%20The%20Dreamer%20-%20Joseph%2C%20Pt.%20One.png',
      '',
      { mediaRoot: path.join(os.tmpdir(), 'album-haven-e2e-owned', 'media') },
    ),
    /Refusing to alter/,
  );
});

function createTrafficPage() {
  const page = new EventEmitter();
  page.url = () => 'http://127.0.0.1:4173/?surface=albums';
  return page;
}

test('exact cover traffic resolves only the requested 200 response with body evidence', async () => {
  const helper = await import(helperUrl);
  const page = createTrafficPage();
  const traffic = helper.observeExactCoverTraffic(page);
  const url = 'http://127.0.0.1:4173/cover?path=Neal%20Morse%20-%20The%20Dreamer%20-%20Joseph%2C%20Pt.%20One.png';
  const pending = traffic.waitForResponse(url, { timeout: 1000 });
  page.emit('response', {
    url: () => url,
    status: () => 200,
    ok: () => true,
    body: async () => Buffer.from('full-cover'),
    request: () => ({ method: () => 'GET' }),
  });

  const evidence = await pending;
  assert.equal(evidence.url, url);
  assert.equal(evidence.status, 200);
  assert.notEqual(evidence.bodyHash, '');
  traffic.stop();
});

test('exact cover traffic counts unrelated covers without reading every response body', async () => {
  const helper = await import(helperUrl);
  const page = createTrafficPage();
  const traffic = helper.observeExactCoverTraffic(page);
  const url = 'http://127.0.0.1:4173/cover?path=Unrelated.png&size=480';
  let bodyReads = 0;
  page.emit('response', {
    url: () => url,
    status: () => 200,
    ok: () => true,
    body: async () => { bodyReads += 1; return Buffer.from('unrelated'); },
    request: () => ({ method: () => 'GET' }),
  });

  const evidence = await traffic.waitForResponse(url);
  assert.equal(evidence.bodyHash, '');
  assert.equal(bodyReads, 0);
  assert.equal(traffic.responseCount(url), 1);
  traffic.stop();
});

test('exact cover traffic rejects a requestfailed event for the unsized full URL', async () => {
  const helper = await import(helperUrl);
  const page = createTrafficPage();
  const traffic = helper.observeExactCoverTraffic(page);
  const url = 'http://127.0.0.1:4173/cover?path=Joseph%2C%20Pt.%20One.png';
  const pending = traffic.waitForResponse(url, { timeout: 1000 });
  page.emit('requestfailed', {
    url: () => url,
    method: () => 'GET',
    failure: () => ({ errorText: 'net::ERR_INVALID_HTTP_RESPONSE' }),
  });

  await assert.rejects(pending, /Exact cover request failed: net::ERR_INVALID_HTTP_RESPONSE/);
  traffic.stop();
});
