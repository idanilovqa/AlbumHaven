const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const ownerModule = import(pathToFileURL(path.join(root, 'tests/e2e/support/mobileFixtures.js')).href);
const guardModule = import(pathToFileURL(path.join(root, 'tests/e2e/support/requestInterceptionGuard.js')).href);
const page = () => ({ closeCalls: 0, route() { return 'original'; }, async close() { this.closeCalls += 1; } });
function context(options = {}) {
  const result = new EventEmitter();
  const pages = [page()];
  result.pages = () => pages;
  result.route = () => 'original';
  result.closeCalls = 0;
  result.newPage = async () => {
    if (options.pageError) throw options.pageError;
    const value = page(); pages.push(value); result.emit('page', value); return value;
  };
  result.close = async () => { result.closeCalls += 1; await options.close?.(); };
  return result;
}

test('owned mobile fresh contexts and every page reject interception until close', async () => {
  const { createMobileBrowserSessions } = await ownerModule;
  const fresh = context();
  let receivedOptions;
  const sessions = createMobileBrowserSessions({ newContext: async options => { receivedOptions = options; return fresh; } }, context(), { baseURL: 'http://localhost:6190' });
  const session = await sessions.create({ viewport: { width: 390, height: 844 } });
  assert.deepEqual(receivedOptions, { baseURL: 'http://localhost:6190', viewport: { width: 390, height: 844 } });
  assert.throws(() => fresh.route(), /production-parity violation/);
  for (const value of fresh.pages()) assert.throws(() => value.route(), /production-parity violation/);
  const popup = await fresh.newPage();
  assert.throws(() => popup.route(), /production-parity violation/);
  await session.close(); await sessions.closeAll();
  assert.equal(fresh.closeCalls, 1);
  assert.equal(fresh.route(), 'original');
  assert.equal(popup.route(), 'original');
});

test('same-context mobile tabs keep the owning context guard and close only their own page', async () => {
  const { createMobileBrowserSessions } = await ownerModule;
  const { installContextRequestInterceptionGuard } = await guardModule;
  const shared = context();
  const restore = installContextRequestInterceptionGuard(shared);
  const sessions = createMobileBrowserSessions({}, shared);
  try {
    const session = await sessions.createPage();
    assert.equal(session.context, shared);
    assert.throws(() => session.page.route(), /production-parity violation/);
    await sessions.closeAll();
    assert.equal(session.page.closeCalls, 1);
    assert.equal(shared.closeCalls, 0);
    assert.equal(shared.pages()[0].closeCalls, 0);
    assert.throws(() => shared.route(), /production-parity violation/);
  } finally { restore(); }
});

test('mobile teardown settles every owned close before restoring guards and aggregates failure', async () => {
  const { createMobileBrowserSessions } = await ownerModule;
  const failure = new Error('first context close failed');
  let resolveDelayed;
  const delayed = new Promise(resolve => { resolveDelayed = resolve; });
  const first = context({ close: async () => { throw failure; } });
  const second = context({ close: () => delayed });
  const contexts = [first, second];
  const sessions = createMobileBrowserSessions({ newContext: async () => contexts.shift() }, context());
  await sessions.create(); await sessions.create();
  let settled = false;
  const closing = sessions.closeAll();
  closing.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(first.closeCalls, 1); assert.equal(second.closeCalls, 1);
  assert.throws(() => first.route(), /production-parity violation/);
  assert.throws(() => second.route(), /production-parity violation/);
  resolveDelayed();
  await assert.rejects(closing, error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === failure);
  assert.equal(first.route(), 'original'); assert.equal(second.route(), 'original');
  await sessions.closeAll();
  assert.equal(first.closeCalls, 1); assert.equal(second.closeCalls, 1);
});

test('fresh-page creation failure closes its guarded context and propagates the original error', async () => {
  const { createMobileBrowserSessions } = await ownerModule;
  const failure = new Error('new page failed');
  const fresh = context({ pageError: failure });
  const sessions = createMobileBrowserSessions({ newContext: async () => fresh }, context());
  await assert.rejects(sessions.create(), error => error === failure);
  assert.equal(fresh.closeCalls, 1); assert.equal(fresh.route(), 'original');
  await sessions.closeAll();
  assert.equal(fresh.closeCalls, 1);
});
