const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

test('worklet playback tests cannot render without explicit stereo or silence evidence', () => {
  const source = read('tests/js/runtime/gapless-playback-processor.test.js');

  assert.match(source, /function assertRenderedStereo\s*\(/);
  assert.match(source, /function assertRenderedSilence\s*\(/);
  assert.match(source, /function assertRenderedNonSilentStereo\s*\(/);
  assert.doesNotMatch(
    source,
    /^\s*renderQuantum\(fixture\);\s*$/m,
    'a worklet quantum cannot be discarded without explicit stereo or silence evidence',
  );
});

test('streaming-engine tests cannot inject valid PCM without asserting exact enqueue evidence', () => {
  const source = read('tests/js/runtime/player-streaming-engine.test.js');

  assert.match(source, /function receivePcmAndAssertEnqueue\s*\(/);
  assert.doesNotMatch(
    source,
    /\.receive\(createPcmMessage\s*\(/,
    'valid PCM injection must assert generation, stream, role, frame count, and samples',
  );
  assert.match(source, /const malformedPcm = createPcmMessage/);
  assert.match(source, /diagnostics\.pcmEvidence\.frames, 0/);
  assert.equal((source.match(/const wirePcm = createPcmMessage/g) || []).length, 1);
  assert.equal((source.match(/\.receive\(wirePcm\)/g) || []).length, 1);
  const helperStart = source.indexOf('function receivePcmAndAssertEnqueue');
  const helperEnd = source.indexOf('\n}\n', helperStart) + 3;
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperBody = source.slice(helperStart, helperEnd);
  const outsideHelper = source.slice(0, helperStart) + source.slice(helperEnd);
  assert.match(helperBody, /const wirePcm = createPcmMessage/);
  assert.match(helperBody, /\.receive\(wirePcm\)/);
  assert.doesNotMatch(outsideHelper, /\bwirePcm\b/);
  assert.doesNotMatch(
    outsideHelper,
    /\b(?:const|let)\s+(?!malformedPcm\b)\w+\s*=\s*createPcmMessage\s*\(/,
    'constructed PCM may only flow through the asserting helper or an explicit malformed-frame case',
  );
});
