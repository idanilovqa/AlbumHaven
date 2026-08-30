const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const repoRoot = path.join(__dirname, '..', '..');

test('third-party request evidence passively records only non-loopback HTTP traffic', async () => {
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/thirdPartyRequestEvidence.js'),
  ).href;
  const { observeNonLoopbackHttpRequests } = await import(moduleUrl);
  const page = new EventEmitter();
  const observer = observeNonLoopbackHttpRequests(page);
  const request = (url, method = 'GET', resourceType = 'document') => ({
    method: () => method,
    resourceType: () => resourceType,
    url: () => url,
  });

  page.emit('request', request('http://127.0.0.1:5010/view-data'));
  page.emit('request', request('http://localhost:5011/manual/cover.jpg'));
  page.emit('request', request('blob:http://127.0.0.1:5010/cache-id', 'GET', 'image'));
  page.emit('request', request('https://coverartarchive.org/release/example', 'GET', 'fetch'));

  assert.deepEqual(observer.snapshot(), [{
    method: 'GET',
    resourceType: 'fetch',
    url: 'https://coverartarchive.org/release/example',
  }]);
  observer.stop();
  assert.equal(page.listenerCount('request'), 0);
});
