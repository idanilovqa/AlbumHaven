const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');

test('status polling classifies transient loopback connection resets as retryable', async () => {
  const { isRetryableStatusProbeError } = await import(pathToFileURL(path.join(
    repoRoot,
    'tests',
    'e2e',
    'actions',
    'appBarActions.js',
  )).href);

  assert.equal(isRetryableStatusProbeError(new Error('apiRequestContext.get: read ECONNRESET')), true);
  assert.equal(isRetryableStatusProbeError(new Error('connect ECONNREFUSED 127.0.0.1:5300')), true);
  assert.equal(isRetryableStatusProbeError(new Error('apiRequestContext.get: socket hang up')), true);
  assert.equal(isRetryableStatusProbeError(new Error('Status request failed with HTTP 500.')), false);
});
