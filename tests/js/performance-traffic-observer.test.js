const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const request = (url = 'http://app/view-data') => ({ url: () => url });
function response(owner, bytes = 10) {
  return { request: () => owner, url: owner.url, status: () => 200, body: async () => Buffer.alloc(bytes) };
}

test('traffic counts only responses belonging to requests started inside the action', async () => {
  const { collectResponseTrafficDuringAction } = await import('../e2e/helpers/performanceHelpers.js');
  const page = new EventEmitter();
  const previous = request();
  const current = request();
  const result = await collectResponseTrafficDuringAction(page, () => true, async () => {
    page.emit('request', current);
    page.emit('response', response(previous, 900));
    page.emit('response', response(current, 17));
    return 'visible';
  });
  assert.deepEqual(result, {
    requests: [current.url()], responses: [{ bodyBytes: 17, status: 200, url: current.url() }], result: 'visible',
  });
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
});

test('traffic retains every new matching request and excludes unrelated resources', async () => {
  const { collectResponseTrafficDuringAction } = await import('../e2e/helpers/performanceHelpers.js');
  const page = new EventEmitter();
  const result = await collectResponseTrafficDuringAction(page, item => item.url().includes('/view-data'), async () => {
    for (const url of ['http://app/view-data', 'http://app/cover', 'http://app/view-data']) {
      const owner = request(url);
      page.emit('request', owner);
      page.emit('response', response(owner));
    }
  });
  assert.equal(result.requests.length, 2);
  assert.equal(result.responses.length, 2);
});

test('traffic preserves action failure and removes both listeners', async () => {
  const { collectResponseTrafficDuringAction } = await import('../e2e/helpers/performanceHelpers.js');
  const page = new EventEmitter();
  const failure = new Error('action failed');
  await assert.rejects(collectResponseTrafficDuringAction(page, () => true, async () => {
    const owner = request();
    page.emit('request', owner);
    page.emit('response', { ...response(owner), body: async () => { throw new Error('body aborted'); } });
    throw failure;
  }), error => error === failure);
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
});

test('traffic does not hide response-body failures after a successful action', async () => {
  const { collectResponseTrafficDuringAction } = await import('../e2e/helpers/performanceHelpers.js');
  const page = new EventEmitter();
  const failure = new Error('transfer failed');
  await assert.rejects(collectResponseTrafficDuringAction(page, () => true, async () => {
    const owner = request();
    page.emit('request', owner);
    page.emit('response', { ...response(owner), body: async () => { throw failure; } });
  }), error => error === failure);
  assert.equal(page.listenerCount('request'), 0);
  assert.equal(page.listenerCount('response'), 0);
});
