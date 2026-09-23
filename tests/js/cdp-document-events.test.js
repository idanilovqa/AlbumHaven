const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let CDPDocumentEvents, ProductionViewObserver, getProductionViewObserver;
const modulesReady = Promise.all([
  import(pathToFileURL(path.join(__dirname, '../e2e/helpers/cdpDocumentEvents.js')).href),
  import(pathToFileURL(path.join(__dirname, '../e2e/helpers/productionViewObserver.js')).href),
]).then(([adapter, core]) => {
  CDPDocumentEvents = adapter.CDPDocumentEvents;
  ProductionViewObserver = core.ProductionViewObserver;
  getProductionViewObserver = core.getProductionViewObserver;
});

async function setup() {
  await modulesReady;
  const session = new EventEmitter();
  const calls = [];
  const bodies = new Map();
  session.send = async (method, args) => {
    calls.push([method, args]);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'old' } } };
    if (method === 'Network.getResponseBody') return { body: JSON.stringify(bodies.get(args.requestId)), base64Encoded: false };
    return {};
  };
  session.detach = async () => { calls.push(['detach']); };
  const page = new EventEmitter();
  page.context = () => ({ newCDPSession: async () => session });
  page.isClosed = () => false;
  const events = new CDPDocumentEvents(page);
  const observer = new ProductionViewObserver(page, events);
  await observer.initialize();
  const start = (id, loaderId, url = 'http://app/view-data?q=same') => session.emit('Network.requestWillBeSent', {
    requestId: id, frameId: 'main', loaderId, request: { url, method: 'GET' }, type: 'Fetch',
  });
  const commit = loaderId => session.emit('Page.frameNavigated', { frame: { id: 'main', loaderId } });
  const fail = id => session.emit('Network.loadingFailed', { requestId: id, errorText: 'net::ERR_ABORTED' });
  const respond = (id, payload) => {
    bodies.set(id, payload);
    session.emit('Network.responseReceived', { requestId: id, response: { status: 200 } });
    session.emit('Network.loadingFinished', { requestId: id });
  };
  return { session, page, calls, events, observer, start, commit, fail, respond };
}

test('initialization is explicit, awaited, and singleton per Page', async () => {
  const h = await setup();
  assert.deepEqual(h.calls.map(call => call[0]), ['Page.enable', 'Network.enable', 'Page.getFrameTree']);
  assert.equal(getProductionViewObserver(h.page), getProductionViewObserver(h.page));
  await h.observer.dispose();
  assert.equal(h.calls.at(-1)[0], 'detach');
});

test('outgoing refresh after document headers is retired only by actual loader commit', async () => {
  const h = await setup();
  h.session.emit('Network.responseReceived', { requestId: 'document', response: { status: 200 } });
  h.start('outgoing', 'old'); h.fail('outgoing');
  assert.match(h.observer.read().latestFullPayloadError, /Request failed/);
  h.commit('new');
  assert.equal(h.observer.read().latestFullPayloadError, null);
  h.start('late-old', 'old'); h.fail('late-old');
  assert.equal(h.observer.read().latestFullPayloadError, null);
});

test('same-URL new-document failure arriving before commit event is retained after commit', async () => {
  const h = await setup();
  h.start('old', 'old');
  h.start('new', 'new'); h.fail('new');
  h.commit('new'); h.fail('old');
  assert.match(h.observer.read().latestFullPayloadError, /Request failed/);
  assert.equal(h.observer.documentGeneration, 1);
});

test('new-document failure before DOMContentLoaded is never cleared later', async () => {
  const h = await setup(); h.commit('new'); h.start('new', 'new'); h.fail('new');
  h.session.emit('Page.domContentEventFired', {});
  assert.match(h.observer.read().latestFullPayloadError, /Request failed/);
});

test('same-document, subframe, canceled navigation, and nonreplacement statuses retain evidence', async () => {
  const h = await setup(); h.start('current', 'old'); h.fail('current');
  h.session.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'http://app/?q=changed' });
  h.session.emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', loaderId: 'child' } });
  h.session.emit('Network.loadingFailed', { requestId: 'document', errorText: 'net::ERR_ABORTED' });
  for (const status of [204, 205, 302]) h.session.emit('Network.responseReceived', { requestId: 'document', response: { status } });
  assert.equal(h.observer.documentGeneration, 0);
  assert.match(h.observer.read().latestFullPayloadError, /Request failed/);
});

test('redirected view response uses final request identity and body', async () => {
  const h = await setup(); h.start('redirect', 'old');
  h.session.emit('Network.requestWillBeSent', { requestId: 'redirect', frameId: 'main', loaderId: 'old',
    redirectResponse: { status: 302 }, request: { url: 'http://app/view-data?q=final', method: 'GET' } });
  h.respond('redirect', { query: 'final', artist_groups: [] });
  await h.observer.readLatestFullPayloadWhenSettled();
  assert.equal(h.observer.read().latestFullPayload.query, 'final');
});

test('old save body completion cannot overwrite post-commit view authority', async () => {
  const h = await setup();
  h.start('save', 'old', 'http://app/utilities/save-task/one');
  h.session.emit('Network.responseReceived', { requestId: 'save', response: { status: 200 } });
  h.commit('new'); h.start('current', 'new'); h.fail('current');
  h.session.emit('Network.loadingFailed', { requestId: 'save', errorText: 'net::ERR_ABORTED' });
  await Promise.resolve(); await Promise.resolve();
  assert.match(h.observer.read().latestFullPayloadError, /Request failed/);
  assert.equal(h.observer.read().latestCompletedSaveTaskPayload, null);
});


test('initialization failures propagate instead of running unobserved', async () => {
  await modulesReady;
  const page = new EventEmitter();
  page.context = () => ({ newCDPSession: async () => { throw new Error('session denied'); } });
  await assert.rejects(new CDPDocumentEvents(page).initialize(), /session denied/);
});

test('live-page detach failures propagate and records are released', async () => {
  const h = await setup(); h.start('pending', 'old');
  h.session.detach = async () => { throw new Error('detach failed'); };
  await assert.rejects(h.observer.dispose(), /detach failed/);
  assert.equal(h.events.records.size, 0);
});

test('page close detaches its observer session once', async () => {
  const h = await setup(); h.page.emit('close');
  await Promise.resolve(); await h.observer.dispose();
  assert.equal(h.calls.filter(call => call[0] === 'detach').length, 1);
});

test('late old save getResponseBody rejection preserves the current document error', async () => {
  const h = await setup();
  let rejectBody;
  const originalSend = h.session.send;
  h.session.send = (method, args) => method === 'Network.getResponseBody'
    ? new Promise((resolve, reject) => { rejectBody = reject; }) : originalSend(method, args);
  h.start('save', 'old', 'http://app/utilities/save-task/one');
  h.respond('save', {});
  await Promise.resolve();
  assert.equal(typeof rejectBody, 'function');
  h.commit('new'); h.start('current', 'new'); h.fail('current');
  const expected = h.observer.read().latestFullPayloadError;
  rejectBody(new Error('old body evicted'));
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.observer.read().latestFullPayloadError, expected);
});


test('a tracked view redirected to login preserves HTTP failure and completes active ownership', async () => {
  const h = await setup(); h.start('login-redirect', 'old');
  h.session.emit('Network.requestWillBeSent', { requestId: 'login-redirect', frameId: 'main', loaderId: 'old',
    redirectResponse: { status: 302 }, request: { url: 'http://app/login', method: 'GET' } });
  assert.equal(h.observer.read().activeRequestCount, 0);
  assert.match(h.observer.read().latestFullPayloadError, /HTTP 302/);
  assert.equal(h.events.records.has('login-redirect'), false);
});


test('fixture disposal awaits a detach already started by page close', async () => {
  const h = await setup();
  let finishDetach;
  h.session.detach = () => new Promise(resolve => { finishDetach = resolve; });
  h.page.emit('close');
  let disposed = false;
  const disposing = h.observer.dispose().then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  finishDetach();
  await disposing;
  assert.equal(disposed, true);
});
