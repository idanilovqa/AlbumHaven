import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const DECODER_PATH = fileURLToPath(new URL('../support/decode_audio_evidence.py', import.meta.url));

export function decodeAudioSampleEvidence(mediaBytes, options = {}) {
  const result = spawnSync(
    resolvePlaywrightPython(options.env || process.env),
    [DECODER_PATH],
    {
      encoding: 'utf8',
      env: options.env || process.env,
      input: mediaBytes,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Audio evidence decoder failed: ${String(result.stderr || '').trim()}`);
  }
  const evidence = JSON.parse(String(result.stdout || '{}'));
  if (!(Number(evidence.frameCount) > 0)
      || !(Number(evidence.finiteSamples) > 0)
      || !(Number(evidence.nonZeroSamples) > 0)
      || !(Number(evidence.peakSample) > 0)) {
    throw new Error(`Decoded audio evidence is silent or invalid: ${JSON.stringify(evidence)}`);
  }
  return evidence;
}
