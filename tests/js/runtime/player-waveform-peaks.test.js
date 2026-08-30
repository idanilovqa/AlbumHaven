const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'player-waveform-peaks.js',
);
const moduleSource = fs.existsSync(modulePath) ? fs.readFileSync(modulePath, 'utf8') : '';

function loadPeaksRuntime(fetchImpl, overrides = {}) {
  assert.notEqual(moduleSource, '', 'player-waveform-peaks.js must provide the bounded peak loader');
  const context = {
    AbortController,
    Map,
    setTimeout: overrides.setTimeout || setTimeout,
    URLSearchParams,
    console,
    fetch: fetchImpl,
    state: {
      player: {
        streaming: { generation: 7 },
        waveform: { renderToken: 0 },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(moduleSource, context, { filename: modulePath });
  assert.equal(typeof context.loadWaveformPeaks, 'function');
  return context;
}

function peakPayload(seed) {
  return {
    sampleCount: 280,
    left: Array.from({ length: 280 }, () => seed),
    right: Array.from({ length: 280 }, () => seed / 2),
  };
}

test('loadWaveformPeaks requests 280 compact bins by raw path and generation', async () => {
  const requests = [];
  const context = loadPeaksRuntime(async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => peakPayload(0.25) };
  });

  const peaks = await context.loadWaveformPeaks('C:/Music/Album/01.flac', 280, 7);

  assert.equal(peaks.sampleCount, 280);
  assert.equal(peaks.left.length, 280);
  assert.equal(peaks.right.length, 280);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/playback\/waveform\?/);
  assert.match(requests[0].url, /bins=280/);
  assert.match(decodeURIComponent(requests[0].url), /path=C%3A|C:\/Music\/Album\/01\.flac/);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('loadSavedLoopWaveformPeaks requests bounded server peaks by loop id without fetching media', async () => {
  const requests = [];
  const context = loadPeaksRuntime(async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => peakPayload(0.4) };
  });

  assert.equal(typeof context.loadSavedLoopWaveformPeaks, 'function');
  const peaks = await context.loadSavedLoopWaveformPeaks('saved-loop-42');

  assert.equal(peaks.sampleCount, 280);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/playback\/waveform\?/);
  assert.match(requests[0].url, /loop_id=saved-loop-42/);
  assert.doesNotMatch(requests[0].url, /\/loops\/media\//);
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('saved-loop peaks use the bounded busy schedule and cache a successful loop identity', async () => {
  const attempts = new Map();
  const delays = [];
  const context = loadPeaksRuntime(async (url) => {
    const identity = new URL(`http://album-haven.test${url}`).searchParams.get('loop_id');
    const attempt = (attempts.get(identity) || 0) + 1;
    attempts.set(identity, attempt);
    if (identity === 'always-busy' || (identity === 'eventually-cached' && attempt < 3)) {
      return { ok: false, status: 429 };
    }
    return { ok: true, status: 200, json: async () => peakPayload(0.6) };
  }, {
    setTimeout(callback, delay) {
      delays.push(delay);
      callback();
      return delays.length;
    },
  });

  assert.equal(await context.loadSavedLoopWaveformPeaks('always-busy'), null);
  assert.equal(attempts.get('always-busy'), 6, 'five bounded retries follow the initial request');
  assert.deepEqual(delays, [50, 100, 200, 400, 800]);

  const first = await context.loadSavedLoopWaveformPeaks('eventually-cached');
  const repeated = await context.loadSavedLoopWaveformPeaks('eventually-cached');
  assert.strictEqual(repeated, first, 'the retained small identity cache reuses the peak payload');
  assert.equal(attempts.get('eventually-cached'), 3, 'a cache hit must not issue another fetch');
  assert.deepEqual(delays, [50, 100, 200, 400, 800, 50, 100]);
});

test('a newer generation aborts and suppresses a stale peak result', async () => {
  const pending = [];
  const context = loadPeaksRuntime((url, options) => new Promise((resolve) => {
    pending.push({ url: String(url), options, resolve });
  }));

  const stale = context.loadWaveformPeaks('C:/Music/old.flac', 280, 7);
  context.state.player.streaming.generation = 8;
  const current = context.loadWaveformPeaks('C:/Music/current.flac', 280, 8);
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve({ ok: true, json: async () => peakPayload(0.5) });
  pending[0].resolve({ ok: true, json: async () => peakPayload(0.1) });

  assert.equal(await stale, null);
  assert.equal((await current).left[0], 0.5);
});

test('cancelWaveformPeakLoads aborts and evicts same-generation work so the identity can retry', async () => {
  const pending = [];
  const context = loadPeaksRuntime((url, options) => new Promise((resolve) => {
    pending.push({ url: String(url), options, resolve });
  }));
  assert.equal(typeof context.cancelWaveformPeakLoads, 'function');

  const first = context.loadWaveformPeaks('C:/Music/retry.flac', 280, 7);
  assert.equal(pending.length, 1);
  context.cancelWaveformPeakLoads(7);
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve({ ok: true, json: async () => peakPayload(0.1) });
  assert.equal(await first, null, 'a cancelled request must not publish a stale result');

  const retry = context.loadWaveformPeaks('C:/Music/retry.flac', 280, 7);
  assert.equal(pending.length, 2, 'cancellation must evict the in-flight identity');
  assert.equal(pending[1].options.signal.aborted, false);
  pending[1].resolve({ ok: true, json: async () => peakPayload(0.75) });
  assert.equal((await retry).left[0], 0.75);
});

test('foreground view work suspends optional peaks and resumes the current waveform after navigation', async () => {
  const pending = [];
  const context = loadPeaksRuntime((url, options) => new Promise((resolve) => {
    pending.push({ url: String(url), options, resolve });
  }));
  context.state.player.current = { path: 'C:/Music/current.flac' };
  context.state.player.waveform.compactPeaks = null;
  context.updateWaveformAppearance = async () => {};

  const initial = context.loadWaveformPeaks('C:/Music/current.flac', 280, 7);
  const suspension = context.suspendPlayerWaveformPeakLoadsForForegroundView();

  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve({ ok: true, json: async () => peakPayload(0.1) });
  assert.equal(await initial, null);

  const resumed = context.resumePlayerWaveformPeakLoadsAfterForegroundView(suspension);
  assert.equal(pending.length, 2, 'foreground completion retries the still-current optional waveform');
  assert.equal(pending[1].options.signal.aborted, false);
  pending[1].resolve({ ok: true, json: async () => peakPayload(0.75) });

  assert.equal((await resumed).left[0], 0.75);
  assert.equal(context.state.player.waveform.compactPeaks.path, 'C:/Music/current.flac');
});

test('foreground suspension prevents a new optional waveform request until navigation resumes', async () => {
  const requests = [];
  const context = loadPeaksRuntime(async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => peakPayload(0.65) };
  });
  context.state.player.current = { path: 'C:/Music/current.flac' };
  context.state.player.waveform.compactPeaks = null;
  context.updateWaveformAppearance = async () => {};

  const suspension = context.suspendPlayerWaveformPeakLoadsForForegroundView();
  assert.equal(
    await context.loadWaveformPeaks('C:/Music/current.flac', 280, 7),
    null,
  );
  assert.deepEqual(requests, [], 'search intent must not admit new waveform extraction work');

  const resumed = await context.resumePlayerWaveformPeakLoadsAfterForegroundView(suspension);
  assert.equal(resumed.left[0], 0.65);
  assert.equal(requests.length, 1, 'the current waveform retries only after foreground completion');
});

test('peak cache retains at most current plus next identities keyed by raw path and generation', async () => {
  const requests = [];
  const context = loadPeaksRuntime(async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => peakPayload(requests.length / 10) };
  });

  await context.loadWaveformPeaks('C:/Music/a.flac', 280, 7);
  await context.loadWaveformPeaks('C:/Music/a.flac', 280, 7);
  assert.equal(requests.length, 1, 'a repeated current identity must hit the cache');
  await context.loadWaveformPeaks('C:/Music/b.flac', 280, 7);
  await context.loadWaveformPeaks('C:/Music/b.flac', 280, 7);
  assert.equal(requests.length, 2, 'a repeated next identity must hit the cache');
  await context.loadWaveformPeaks('C:/Music/c.flac', 280, 7);
  assert.equal(requests.length, 3);
  await context.loadWaveformPeaks('C:/Music/b.flac', 280, 7);
  assert.equal(requests.length, 3, 'the recently retained identity must survive max-two eviction');
  await context.loadWaveformPeaks('C:/Music/a.flac', 280, 7);
  assert.equal(requests.length, 4, 'the evicted first identity must be fetched again');

  context.state.player.streaming.generation = 8;
  await context.loadWaveformPeaks('C:/Music/a.flac', 280, 8);
  assert.equal(requests.length, 5, 'the same raw path in a new generation is a distinct identity');
});

test('malformed or out-of-domain compact peak payloads are rejected nonfatally', async () => {
  const malformedPayloads = [
    { sampleCount: 280, left: null, right: Array(280).fill(0.5) },
    { sampleCount: 279, left: Array(280).fill(0.5), right: Array(280).fill(0.5) },
    { sampleCount: 280, left: Array(279).fill(0.5), right: Array(280).fill(0.5) },
    { sampleCount: 280, left: Array(280).fill(-0.01), right: Array(280).fill(0.5) },
    { sampleCount: 280, left: Array(280).fill(0.5), right: Array(280).fill(1.01) },
    { sampleCount: 280, left: Array(280).fill(Number.NaN), right: Array(280).fill(0.5) },
  ];

  for (const [index, payload] of malformedPayloads.entries()) {
    const context = loadPeaksRuntime(async () => ({ ok: true, json: async () => payload }));
    assert.equal(
      await context.loadWaveformPeaks(`C:/Music/malformed-${index}.flac`, 280, 7),
      null,
      `malformed payload ${index} must remain optional and never enter the peak cache`,
    );
  }
});

test('optional waveform failure is nonfatal and leaves playback generation untouched', async () => {
  const context = loadPeaksRuntime(async () => { throw new Error('peak service unavailable'); });
  assert.equal(await context.loadWaveformPeaks('C:/Music/a.flac', 280, 7), null);
  assert.equal(context.state.player.streaming.generation, 7);
});

test('a transient busy response retries within the same identity until backend cleanup releases admission', async () => {
  let attempts = 0;
  const context = loadPeaksRuntime(async () => {
    attempts += 1;
    if (attempts < 3) return { ok: false, status: 429 };
    return { ok: true, status: 200, json: async () => peakPayload(0.375) };
  });

  const peaks = await context.loadWaveformPeaks('C:/Music/promoted-next.flac', 280, 7);

  assert.equal(attempts, 3);
  assert.equal(peaks.left[0], 0.375);
});

test('non-ok, invalid, and rejected requests are evicted so the same identity can retry', async (t) => {
  const failures = [
    { name: 'non-ok response', response: { ok: false } },
    { name: 'invalid payload', response: { ok: true, json: async () => ({ sampleCount: 280 }) } },
    { name: 'rejected request', error: new Error('temporary admission failure') },
  ];

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      let attempts = 0;
      const context = loadPeaksRuntime(async () => {
        attempts += 1;
        if (attempts === 1) {
          if (failure.error) throw failure.error;
          return failure.response;
        }
        return { ok: true, json: async () => peakPayload(0.625) };
      });

      assert.equal(await context.loadWaveformPeaks('C:/Music/retry.flac', 280, 7), null);
      assert.equal((await context.loadWaveformPeaks('C:/Music/retry.flac', 280, 7)).left[0], 0.625);
      assert.equal(attempts, 2, 'an optional transient failure must not poison the identity cache');
    });
  }
});

test('boundary promotion publishes prefetched current peaks and evicts the completed source', async () => {
  const requests = [];
  const context = loadPeaksRuntime(async (url) => {
    requests.push(String(url));
    return { ok: true, json: async () => peakPayload(requests.length / 10) };
  });
  context.state.player.waveform.compactPeaks = null;

  await context.loadWaveformPeaks('C:/Music/outgoing.flac', 280, 7);
  await context.loadWaveformPeaks('C:/Music/incoming.flac', 280, 7);
  const promoted = await context.promoteWaveformPeaks(
    'C:/Music/outgoing.flac',
    'C:/Music/incoming.flac',
    7,
  );

  assert.equal(promoted.left[0], 0.2);
  assert.equal(context.state.player.waveform.compactPeaks.path, 'C:/Music/incoming.flac');
  assert.equal(context.state.player.waveform.compactPeaks.generation, 7);
  assert.equal(context.state.player.waveform.compactPeaks.data, promoted);
  await context.loadWaveformPeaks('C:/Music/incoming.flac', 280, 7);
  assert.equal(requests.length, 2, 'the promoted current peaks remain cached');
  await context.loadWaveformPeaks('C:/Music/outgoing.flac', 280, 7);
  assert.equal(requests.length, 3, 'the completed source is evicted at promotion');
  await context.loadWaveformPeaks('C:/Music/next.flac', 280, 7);
  await context.loadWaveformPeaks('C:/Music/incoming.flac', 280, 7);
  assert.equal(requests.length, 4, 'the cache remains bounded to promoted current plus next');
});

test('boundary promotion retries a cancelled incoming preload with a fresh controller and publishes it', async () => {
  const pending = [];
  const context = loadPeaksRuntime((url, options) => new Promise((resolve) => {
    pending.push({ url: String(url), options, resolve });
  }));
  context.state.player.waveform.compactPeaks = null;

  const cancelledPreload = context.loadWaveformPeaks('C:/Music/incoming.flac', 280, 7);
  assert.equal(pending.length, 1);
  context.cancelWaveformPeakLoads(7);
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve({ ok: true, json: async () => peakPayload(0.125) });
  assert.equal(await cancelledPreload, null);

  const promotion = context.promoteWaveformPeaks(
    'C:/Music/outgoing.flac',
    'C:/Music/incoming.flac',
    7,
  );

  assert.equal(pending.length, 2, 'promotion must retry the now-current missing identity once');
  assert.equal(pending[1].options.signal.aborted, false);
  pending[1].resolve({ ok: true, json: async () => peakPayload(0.75) });
  const promoted = await promotion;

  assert.equal(promoted.left[0], 0.75);
  assert.equal(context.state.player.waveform.compactPeaks.path, 'C:/Music/incoming.flac');
  assert.equal(context.state.player.waveform.compactPeaks.generation, 7);
  assert.equal(context.state.player.waveform.compactPeaks.data, promoted);
});

test('stale boundary promotion does not retry or abort the active generation controller', async () => {
  const requests = [];
  const pending = [];
  const context = loadPeaksRuntime((url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length > 2) {
      return Promise.resolve({ ok: true, json: async () => peakPayload(0.875) });
    }
    return new Promise((resolve) => pending.push({ options, resolve }));
  });

  const cancelledPreload = context.loadWaveformPeaks('C:/Music/incoming.flac', 280, 7);
  context.cancelWaveformPeakLoads(7);
  pending[0].resolve({ ok: true, json: async () => peakPayload(0.125) });
  assert.equal(await cancelledPreload, null);

  context.state.player.streaming.generation = 8;
  const activeGenerationLoad = context.loadWaveformPeaks('C:/Music/current.flac', 280, 8);
  assert.equal(requests.length, 2);
  assert.equal(pending[1].options.signal.aborted, false);

  const stalePromotion = await context.promoteWaveformPeaks(
    'C:/Music/outgoing.flac',
    'C:/Music/incoming.flac',
    7,
  );

  assert.equal(stalePromotion, null);
  assert.equal(requests.length, 2, 'stale promotion must not launch an old-generation recovery');
  assert.equal(pending[1].options.signal.aborted, false);
  pending[1].resolve({ ok: true, json: async () => peakPayload(0.5) });
  assert.equal((await activeGenerationLoad).left[0], 0.5);
});
