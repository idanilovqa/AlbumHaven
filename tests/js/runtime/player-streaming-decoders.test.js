const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const decodersPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'player-streaming-decoders.js');

// A build's decoder classes. [failing] names classes whose decoders never start (a browser that cannot
// run a Worker); every other decoder answers the self-check clip exactly.
function loadDecoders({ failing = [] } = {}) {
  const made = [];
  const context = { console: { warn() {} }, atob: (text) => Buffer.from(text, 'base64').toString('binary'), Uint8Array, Promise };
  const clips = {};
  const decoderClass = (className, codec) => class {
    constructor() {
      this.className = className;
      this.freed = false;
      this.resets = 0;
      this.ready = failing.includes(className) ? Promise.reject(new Error('no worker')) : Promise.resolve();
      this.ready.catch(() => {});
      made.push(this);
    }

    async decode() {
      const clip = clips[codec];
      const channel = new Float32Array(clip.frames);
      channel[0] = clip.magnitude;
      return { samplesDecoded: clip.frames, channelData: [channel, channel] };
    }

    async flush() { return { samplesDecoded: 0, channelData: [] }; }

    async reset() { this.resets += 1; }

    free() { this.freed = true; }
  };
  context.window = {
    'mpg123-decoder': { MPEGDecoder: decoderClass('MPEGDecoder', 'mp3'), MPEGDecoderWebWorker: decoderClass('MPEGDecoderWebWorker', 'mp3') },
    'flac-decoder': { FLACDecoder: decoderClass('FLACDecoder', 'flac'), FLACDecoderWebWorker: decoderClass('FLACDecoderWebWorker', 'flac') },
  };
  context.document = {
    createElement: () => ({}),
    head: { appendChild: (script) => queueMicrotask(() => script.onload()) },
  };
  context.state = { player: { streaming: {} } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(decodersPath, 'utf8'), context, { filename: decodersPath });
  Object.assign(clips, vm.runInContext('STREAMING_DECODER_SELF_CHECK_CLIPS', context));
  return { context, made };
}

// sandbox5 r26 (2026-11-21): at 4x CPU a press waited behind about 0.7 s of decoding a second on the
// page's thread. Songs decode in each build's Worker class; the pool hands a stream a started one.
test('songs decode in the build\'s Worker class, and the first stream takes a decoder started at warm-up', async () => {
  const { context, made } = loadDecoders();
  assert.deepEqual([...await context.ensureStreamingDecoders()], ['mp3', 'flac']);
  await new Promise((resolve) => setImmediate(resolve));
  const warmed = made.filter(({ freed }) => !freed);
  assert.deepEqual(warmed.map(({ className }) => className), ['MPEGDecoderWebWorker', 'FLACDecoderWebWorker']);

  const decoder = context.createStreamingDecoder('mp3');
  assert.equal(decoder, warmed[0], 'the warm decoder, not a new Worker');
  assert.equal(context.createStreamingDecoder('mp3').className, 'MPEGDecoderWebWorker', 'an empty pool starts another');
});

test('a browser that cannot start a decoder Worker decodes on the page instead', async () => {
  const { context } = loadDecoders({ failing: ['MPEGDecoderWebWorker'] });
  assert.deepEqual([...await context.ensureStreamingDecoders()], ['mp3', 'flac']);
  assert.equal(context.createStreamingDecoder('mp3').className, 'MPEGDecoder');
  assert.equal(context.createStreamingDecoder('flac').className, 'FLACDecoderWebWorker');
});

test('a released decoder is reset for the next stream while the pool has room, and freed past it', async () => {
  const { context } = loadDecoders();
  await context.ensureStreamingDecoders();
  const streams = [0, 1, 2, 3].map(() => context.createStreamingDecoder('mp3'));
  const resetsBefore = streams.map(({ resets }) => resets);
  for (const decoder of streams) context.releaseStreamingDecoder('mp3', decoder);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(streams.map(({ resets, freed }, index) => [resets - resetsBefore[index], freed]),
    [[1, false], [1, false], [0, true], [0, true]]);
  assert.equal(context.createStreamingDecoder('mp3'), streams[1], 'the next stream takes a reset one');
});
