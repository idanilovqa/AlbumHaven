const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const helpers = import(pathToFileURL(path.join(__dirname, '../e2e/helpers/playbackResumeHelpers.js')).href);

function claimRequest(state) {
  return {
    url: () => 'http://127.0.0.1:5600/playback/state',
    method: () => 'PUT',
    postDataJSON: () => ({ state }),
    timing: () => ({ startTime: 1000, responseEnd: 40 }),
    failure: () => null,
  };
}

test('the claim observer waits for a claim request still in flight, then reports it answered', async () => {
  const { observePlaybackClaimRequests } = await helpers;
  const page = new EventEmitter();
  page.off = page.removeListener;
  const claims = observePlaybackClaimRequests(page);
  const mark = claims.mark();
  const renewal = claimRequest('playing');
  page.emit('request', renewal);

  const settled = claims.settledSince(mark, 5000);
  setTimeout(() => page.emit('requestfinished', renewal), 20);
  const records = await settled;

  assert.deepEqual(records.map(({ method, state, settled: done, answeredAtEpochMs }) => (
    { method, state, settled: done, answeredAtEpochMs })), [
    { method: 'PUT', state: 'playing', settled: true, answeredAtEpochMs: 1040 },
  ]);
  claims.stop();
});

test('the claim observer still names a claim request that never settles', async () => {
  const { observePlaybackClaimRequests } = await helpers;
  const page = new EventEmitter();
  page.off = page.removeListener;
  const claims = observePlaybackClaimRequests(page);
  const mark = claims.mark();
  page.emit('request', claimRequest('playing'));

  const records = await claims.settledSince(mark, 30);

  assert.deepEqual(records.map(({ state, settled }) => ({ state, settled })), [{ state: 'playing', settled: false }]);
  claims.stop();
});
