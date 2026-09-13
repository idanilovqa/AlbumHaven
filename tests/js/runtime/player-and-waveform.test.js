const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const waveformPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'player-and-waveform.js',
);
const loopPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'player-loop-playback.js',
);
const peaksPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'player-waveform-peaks.js',
);
const waveformSource = fs.readFileSync(waveformPath, 'utf8');
const loopSource = fs.readFileSync(loopPath, 'utf8');
const peaksSource = fs.readFileSync(peaksPath, 'utf8');

test('waveform peak shaping preserves silence and separates hits from quieter material', () => {
  const { context } = loadRuntime();

  assert.equal(context.shapeWaveformPeak(0), 0);
  assert.equal(context.shapeWaveformPeak(1), 1);
  assert.ok(context.shapeWaveformPeak(0.5) < 0.25);
  assert.ok(context.shapeWaveformPeak(0.8) < 0.65);
});

test('updateWaveformAppearance publishes the effective seekbar presentation', async () => {
  const player = {
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const wrapClasses = new Set();
  const documentRootClasses = new Set();
  const classList = (classes) => ({
    toggle(name, force) {
      if (force) classes.add(name);
      else classes.delete(name);
    },
  });
  const wrap = { classList: classList(wrapClasses) };
  const timeline = { parentElement: wrap };
  const waveformCanvas = { hidden: false, getContext: () => null };
  const documentRoot = { classList: classList(documentRootClasses) };
  const { context } = loadRuntime({
    document: {
      documentElement: documentRoot,
      getElementById(id) {
        if (id === 'player-timeline') return timeline;
        if (id === 'player-waveform-canvas') return waveformCanvas;
        return null;
      },
      querySelector(selector) {
        return selector === '.global-player' ? player : null;
      },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
  });

  context.state.player.appearance.seekbarMode = 'default';
  await context.updateWaveformAppearance();

  assert.equal(player.attributes['data-player-seekbar-presentation'], 'regular');
  assert.equal(documentRootClasses.has('has-waveform-player'), false);
  assert.equal(wrapClasses.has('is-waveform'), false);

  context.state.player.appearance.seekbarMode = 'waveform';
  await context.updateWaveformAppearance();

  assert.equal(player.attributes['data-player-seekbar-presentation'], 'waveform');
  assert.equal(documentRootClasses.has('has-waveform-player'), true);
  assert.equal(wrapClasses.has('is-waveform'), true);

  context.state.player.appearance.seekbarMode = 'default';
  context.state.player.loopActive = true;
  await context.updateWaveformAppearance();

  assert.equal(player.attributes['data-player-seekbar-presentation'], 'waveform');
  assert.equal(documentRootClasses.has('has-waveform-player'), true);
  assert.equal(wrapClasses.has('is-waveform'), true);
});

function loadRuntime(overrides = {}) {
  const context = {
    state: {
      player: {
        current: null,
        playbackQueue: null,
        loopActive: false,
        loopStart: 0,
        loopEnd: 30,
        waveform: {
          renderToken: 0,
          compactPeaks: null,
        },
        appearance: {
          seekbarMode: 'waveform',
          waveformFillColor: '#ffffff',
          waveformEdgeColor: '#000000',
        },
      },
      utility: {
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        selectedLoopGroupKey: '',
        selectedLoopDetailMode: '',
        activeTab: '',
      },
    },
    window: {
      devicePixelRatio: 1,
      addEventListener() {},
    },
    document: {
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() {
        return [];
      },
      addEventListener() {},
    },
    getStreamingPlaybackSnapshot: () => ({
      currentTime: 0,
      duration: 0,
      paused: true,
      ended: false,
      src: '',
      readyState: 0,
    }),
    clearWaveformCanvas() {},
    persistPlayerState() {},
    refreshTrackModalPlaybackState() {},
    refreshNonAlbumModalPlaybackState() {},
    updateLoopInputsFromState() {},
    updateWaveformAppearance() {},
    loopEditSessionExpiryController: {
      stop() {},
    },
    showToast() {},
    showBrowserPrompt: () => '',
    buildUtilityLoopGroupKey: () => '',
    renderUtilityModalContent() {},
    formatLoopTime(value) {
      return String(value);
    },
    getTimelineSecondsFromClientX: () => 0,
    getTrackIdentity: (track) => String(track?.path || ''),
    resolveAlbumForPlayerTrack: () => null,
    openTrackModal() {},
    parseLoopTime: () => 0,
    setAlbumPlaybackQueue() {},
    getPlayerElements: () => ({}),
    console,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(waveformSource, context, { filename: waveformPath });
  vm.runInContext(loopSource, context, { filename: loopPath });
  return { context };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function peakPayload(seed) {
  return {
    sampleCount: 720,
    left: Array.from({ length: 720 }, () => seed),
    right: Array.from({ length: 720 }, () => seed / 2),
  };
}

function loadWaveformSelectionRuntime(fetchImpl) {
  const loaded = loadRuntime({
    AbortController,
    Map,
    setTimeout,
    URLSearchParams,
    fetch: fetchImpl,
  });
  loaded.context.state.player.streaming = { generation: 7 };
  vm.runInContext(peaksSource, loaded.context, { filename: peaksPath });
  return loaded;
}

async function run() {
  {
    const { context } = loadRuntime();
    assert.equal(context.formatLoopTime(0.9996, true), '0:01.000');
    assert.equal(context.formatLoopTime(59.9996, true), '1:00.000');
    assert.equal(
      context.formatLoopTime(59.9996, false),
      '0:59',
      'whole-second display keeps its existing floor behavior',
    );
  }

  {
    const requests = [];
    const cachedHit = deferred();
    const { context } = loadWaveformSelectionRuntime((url, options) => {
      requests.push({ url: String(url), options });
      return cachedHit.promise;
    });
    let waveformRenders = 0;
    context.updateWaveformAppearance = async () => { waveformRenders += 1; };
    const track = { path: 'C:/Music/cached.flac', title: 'Cached' };

    context.setCurrentPlayerTrack(track);

    assert.equal(requests.length, 1, 'track selection probes Postgres waveform cache immediately');
    assert.match(requests[0].url, /(?:\?|&)cachedOnly=1(?:&|$)/);
    const readiness = context.handleStreamingPlaybackWaveformReady({
      generation: 7,
      currentPath: track.path,
      continuityPath: '',
    });
    assert.equal(
      requests.length,
      1,
      'audio readiness must await the in-flight cache-only probe instead of starting a duplicate build request',
    );
    cachedHit.resolve({ ok: true, status: 200, json: async () => peakPayload(0.75) });
    await readiness;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(context.state.player.waveform.compactPeaks.path, track.path);
    assert.equal(context.state.player.waveform.compactPeaks.generation, 7);
    assert.equal(context.state.player.waveform.compactPeaks.data.left[0], 0.75);
    assert.equal(waveformRenders, 2, 'the cache hit rerenders after the selection-time empty canvas pass');
  }

  {
    const requests = [];
    const { context } = loadWaveformSelectionRuntime(async (url) => {
      requests.push(String(url));
      if (requests.length === 1) return { ok: false, status: 204 };
      return { ok: true, status: 200, json: async () => peakPayload(0.5) };
    });
    const track = { path: 'C:/Music/uncached.flac', title: 'Uncached' };

    context.setCurrentPlayerTrack(track);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.state.player.waveform.compactPeaks, null);
    assert.equal(requests.length, 1, 'a cache miss does not start waveform generation during selection');
    assert.match(requests[0], /(?:\?|&)cachedOnly=1(?:&|$)/);

    await context.handleStreamingPlaybackWaveformReady({
      generation: 7,
      currentPath: track.path,
      continuityPath: '',
    });

    assert.equal(requests.length, 2, 'audio readiness retains the existing waveform build fallback');
    assert.doesNotMatch(requests[1], /(?:\?|&)cachedOnly=1(?:&|$)/);
    assert.equal(context.state.player.waveform.compactPeaks.data.left[0], 0.5);
  }

  {
    const requests = [];
    const staleHit = deferred();
    const { context } = loadWaveformSelectionRuntime((url) => {
      requests.push(String(url));
      return staleHit.promise;
    });

    context.setCurrentPlayerTrack({ path: 'C:/Music/old.flac', title: 'Old' });
    context.state.player.streaming.generation = 8;
    context.state.player.current = { path: 'C:/Music/current.flac', title: 'Current' };
    staleHit.resolve({ ok: true, status: 200, json: async () => peakPayload(0.25) });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requests.length, 1);
    assert.equal(context.state.player.waveform.compactPeaks, null,
      'a stale cache-only response never publishes into a newer path or generation');
  }

  {
    const streamingSnapshot = {
      currentTime: 8.5,
      duration: 42,
      paused: false,
      ended: false,
      src: '/track?path=streaming.flac',
      readyState: 4,
    };
    const { context } = loadRuntime({
      getStreamingPlaybackSnapshot: () => streamingSnapshot,
    });

    assert.deepEqual(
      JSON.parse(JSON.stringify(context.getPlayerPlaybackSnapshot())),
      streamingSnapshot,
      'the player facade must delegate its playback snapshot to the streaming engine',
    );
    streamingSnapshot.currentTime = 41.25;
    streamingSnapshot.duration = 42.5;
    assert.equal(context.getPlayerPlaybackSnapshot().currentTime, 41.25);
    assert.equal(
      context.getPlayerPlaybackSnapshot().duration,
      42.5,
      'the facade must render the engine duration after authoritative EOS corrects provisional metadata',
    );
  }

  {
    assert.doesNotMatch(waveformSource, /function getPlayerAudioContext\s*\(/);
    assert.doesNotMatch(waveformSource, /decodeAudioData\s*\(/);
    assert.doesNotMatch(waveformSource, /\.arrayBuffer\s*\(/);
    assert.doesNotMatch(
      waveformSource,
      /fetch\s*\(\s*src\s*\)/,
      'waveform rendering must not fetch and decode the complete /track response',
    );
    assert.match(waveformSource, /loadWaveformPeaks\s*\(/);
  }

  {
    const operations = [];
    const drawingContext = {
      arc(...args) { operations.push(['arc', ...args]); },
      beginPath() { operations.push(['beginPath']); },
      clearRect() {},
      clip() {},
      closePath() {},
      fill() {},
      lineTo(...args) { operations.push(['lineTo', ...args]); },
      moveTo(...args) { operations.push(['moveTo', ...args]); },
      rect() {},
      restore() {},
      save() {},
      scale() {},
      setTransform() {},
      stroke() {},
    };
    const canvas = {
      clientHeight: 40,
      clientWidth: 100,
      getContext: () => drawingContext,
      height: 0,
      width: 0,
    };
    const { context } = loadRuntime();

    context.drawWaveformOnCanvas(canvas, {
      left: [0.1, 0.2, 0.3, 0.2],
      right: [0.2, 0.3, 0.2, 0.1],
    }, 0.75);

    const playheadStart = operations.findIndex((operation) => (
      operation[0] === 'moveTo' && operation[1] === 75 && operation[2] === 0
    ));
    assert.ok(playheadStart >= 0, 'the waveform canvas draws the playhead at 75% progress');
    assert.deepEqual(operations[playheadStart + 1], ['lineTo', 75, 40]);
    assert.ok(operations.some((operation) => (
      operation[0] === 'arc' && operation[1] === 75 && operation[2] === 20
    )), 'the waveform canvas draws the visible playhead cursor knob');
  }

  {
    const operations = [];
    const drawingContext = {
      arc(...args) { operations.push(['arc', ...args]); },
      beginPath() { operations.push(['beginPath']); },
      clearRect() {},
      clip() {},
      closePath() {},
      fill() {},
      lineTo(...args) { operations.push(['lineTo', ...args]); },
      moveTo(...args) { operations.push(['moveTo', ...args]); },
      rect() {},
      restore() {},
      save() {},
      scale() {},
      setTransform() {},
      stroke() {},
    };
    const canvas = {
      clientHeight: 40,
      clientWidth: 100,
      getContext: () => drawingContext,
      height: 0,
      width: 0,
    };
    const { context } = loadRuntime();

    context.drawWaveformOnCanvas(canvas, {
      left: [0.1, 0.2, 0.3, 0.2],
      right: [0.2, 0.3, 0.2, 0.1],
    }, 0.75);

    const playheadStart = operations.findIndex((operation) => (
      operation[0] === 'moveTo' && operation[1] === 75 && operation[2] === 0
    ));
    assert.ok(playheadStart >= 0, 'the waveform canvas draws the playhead at 75% progress');
    assert.deepEqual(operations[playheadStart + 1], ['lineTo', 75, 40]);
    assert.ok(operations.some((operation) => (
      operation[0] === 'arc' && operation[1] === 75 && operation[2] === 20
    )), 'the waveform canvas draws the visible playhead cursor knob');
  }

  {
    const { context } = loadRuntime();
    const album = { key: 'alpha', name: 'Album Alpha' };
    const modalCalls = [];
    const createButton = () => {
      let clickHandler = null;
      return {
        addEventListener(type, handler) {
          if (type === 'click') clickHandler = handler;
        },
        click() {
          clickHandler?.();
        },
      };
    };
    const albumLink = createButton();
    const coverButton = createButton();
    context.state.player.current = {
      src: '/track?path=current.flac',
      path: 'C:/Music/current.flac',
      title: 'Current',
    };
    context.getPlayerElements = () => ({ albumLink, coverButton });
    context.resolveAlbumForPlayerTrack = () => album;
    context.openTrackModal = (...args) => modalCalls.push(args);
    context.setCurrentPlayerTrack = () => {};
    context.updatePlayerUi = () => {};
    context.restorePlayerState = () => {};

    context.attachPlayerEvents();
    albumLink.click();
    coverButton.click();

    assert.equal(modalCalls.length, 2);
    assert.strictEqual(modalCalls[0][0], album);
    assert.equal(modalCalls[0].length, 1, 'the album title keeps the normal gallery-enabled modal default');
    assert.strictEqual(modalCalls[1][0], album);
    assert.deepEqual(
      JSON.parse(JSON.stringify(modalCalls[1][1])),
      { coverLightboxGallery: false },
      'the player cover opens a single-cover lightbox modal',
    );
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

test('persistent-player loop editing keeps one stereo canvas with a symmetric overshoot overlay', () => {
  const template = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'templates', 'index.html',
  ), 'utf8');
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  assert.equal((template.match(/id="player-waveform-canvas"/g) || []).length, 1);
  assert.doesNotMatch(template, /utility-saved-loop-waveform[^]*data-loop-range-owner="global-player"/);
  assert.match(waveformSource, /drawChannel\(peaksLeft,\s*topMid[^)]*\)[^]*drawChannel\(peaksRight,\s*bottomMid[^)]*\)/);
  assert.match(
    css,
    /\.player-timeline-wrap\s*>\s*\.loop-range-surface\s+\.loop-range-selection\s*\{[^}]*(?:inset-block:\s*-\d+(?:\.\d+)?px|top:\s*(-?\d+(?:\.\d+)?px)[^}]*bottom:\s*\1)/s,
  );
});

test('persistent-player loop controls overlay beside Play without displacing the main area', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const shellRule = css.match(/(?:^|\n)\.player-shell\s*\{([^}]*)\}/s)?.[1] || '';
  const clusterRule = css.match(/\.loop-play-control-cluster\s*\{([^}]*)\}/s)?.[1] || '';
  const mountRule = css.match(/\.loop-play-control-actions\s*\{([^}]*)\}/s)?.[1] || '';
  const mainRule = css.match(/\.player-main\s*\{([^}]*)\}/s)?.[1] || '';
  const activeRootRule = css.match(
    /\.loop-edit-actions\.is-active\[data-loop-action-engaged="true"\]\s*\{([^}]*)\}/s,
  )?.[1] || '';

  assert.match(shellRule, /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/);
  assert.doesNotMatch(shellRule, /auto\s+auto\s+minmax/);
  assert.doesNotMatch(css, /grid-template-columns:\s*auto\s+auto\s+auto\s+minmax\(0,\s*1fr\)/);
  assert.match(mountRule, /position:\s*absolute/);
  assert.match(clusterRule, /--loop-play-control-size:\s*48px/);
  assert.match(clusterRule, /container-type:\s*inline-size/);
  assert.match(mountRule, /left:\s*60\.4166667cqw/);
  assert.match(mountRule, /top:\s*58\.3333333cqw/);
  assert.match(mountRule, /width:\s*39px/);
  assert.match(mainRule, /grid-column:\s*2/);
  assert.match(mainRule, /width:\s*100%/);
  assert.doesNotMatch(
    mainRule,
    /margin-left|width:\s*calc\(100%\s*-/,
    'the overlaid control pod must not reserve horizontal waveform space',
  );
  assert.doesNotMatch(activeRootRule, /margin-inline-end/);
  assert.match(
    css,
    /\.loop-play-control-actions\s+\.loop-edit-action-pod::before,[^]*\.loop-play-control-actions\s+\.loop-edit-action-pod::after\s*\{[^}]*display:\s*none/s,
    'both players must remove painted attachment arcs from the transparent Play-circle cutout',
  );
});

test('persistent-player controls and timelines use mode-specific centerlines', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const playerRule = css.match(/\.global-player\s*\{([^}]*)\}/s)?.[1] || '';
  const waveformRule = css.match(/\.player-waveform-canvas\s*\{([^}]*)\}/s)?.[1] || '';
  const waveformTimelineRule = css.match(
    /\.player-timeline-wrap\.is-waveform\s+\.player-timeline\s*\{([^}]*)\}/s,
  )?.[1] || '';

  assert.match(playerRule, /--player-waveform-centerline:\s*57px/);
  assert.match(playerRule, /--player-regular-centerline:\s*39px/);
  assert.match(playerRule, /--player-controls-size:\s*48px/);
  assert.match(playerRule, /--player-leading-width:\s*114px/);
  assert.match(
    css,
    /\.global-player\[data-player-seekbar-presentation="waveform"\]\s+\.player-controls\s*\{[^}]*margin-top:\s*calc\(var\(--player-waveform-centerline\)\s*-\s*\(var\(--player-controls-size\)\s*\/\s*2\)\)/s,
  );
  assert.match(
    css,
    /\.global-player\[data-player-seekbar-presentation="regular"\]\s+\.player-controls\s*\{[^}]*margin-top:\s*calc\(var\(--player-regular-centerline\)\s*-\s*\(var\(--player-controls-size\)\s*\/\s*2\)\)/s,
  );
  assert.match(
    css,
    /\.global-player\[data-player-seekbar-presentation="waveform"\]\s+\.player-timeline-wrap\s*\{[^}]*top:\s*29px[^}]*height:\s*56px/s,
  );
  assert.match(
    css,
    /\.global-player\[data-player-seekbar-presentation="regular"\]\s+\.player-timeline-wrap\s*\{[^}]*top:\s*15px[^}]*height:\s*48px/s,
  );
  assert.match(waveformRule, /bottom:\s*0/);
  assert.match(waveformRule, /height:\s*56px/);
  assert.match(waveformTimelineRule, /position:\s*absolute/);
  assert.match(waveformTimelineRule, /opacity:\s*0\.42/);
  assert.match(waveformTimelineRule, /appearance:\s*none/);
  assert.match(
    css,
    /\.player-timeline-wrap\.is-waveform\s+\.player-timeline::-webkit-slider-runnable-track\s*\{[^}]*background:\s*transparent/s,
  );
  assert.match(
    css,
    /\.player-timeline-wrap\.is-waveform\s+\.player-timeline::-webkit-slider-thumb\s*\{[^}]*appearance:\s*none[^}]*width:\s*0[^}]*height:\s*0/s,
  );
});

test('persistent-player metadata and timestamps use approved mode offsets', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');

  assert.match(css, /\.global-player\[data-player-seekbar-presentation="waveform"\]\s+\.player-meta\s*\{[^}]*top:\s*7px[^}]*left:\s*calc\(-1\s*\*\s*var\(--player-leading-width\)\)/s);
  assert.match(css, /\.global-player\[data-player-seekbar-presentation="waveform"\]\s+\.player-time\s*\{[^}]*top:\s*8px/s);
  assert.match(css, /\.global-player\[data-player-seekbar-presentation="regular"\]\s+\.player-meta\s*\{[^}]*top:\s*10px[^}]*left:\s*0/s);
  assert.match(css, /\.global-player\[data-player-seekbar-presentation="regular"\]\s+\.player-time\s*\{[^}]*top:\s*11px/s);
});

test('persistent player restores the compact unclipped player and stereo waveform geometry', () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const baseLayoutCss = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'base-layout.css',
  ), 'utf8');
  const playerHeight = Number(baseLayoutCss.match(/--player-height:\s*(\d+)px/)?.[1] || 0);
  const waveformRule = css.match(/\.player-waveform-canvas\s*\{([^}]*)\}/s)?.[1] || '';
  const rangeSurfaceRule = css.match(
    /\.player-timeline-wrap\s*>\s*\.loop-range-surface\s*\{([^}]*)\}/s,
  )?.[1] || '';
  const waveformHeight = Number(waveformRule.match(/height:\s*(\d+)px/)?.[1] || 0);

  assert.equal(playerHeight, 68, 'regular mode uses the approved compact expanded-player height');
  assert.match(css, /:root\.has-waveform-player\s*\{[^}]*--player-height:\s*92px/s);
  assert.match(css, /:root\.has-compact-player\s*\{[^}]*--player-height:\s*0px/s);
  assert.equal(waveformHeight, 56, 'the stereo canvas is slightly smaller than the foobar reference');
  assert.match(rangeSurfaceRule, /height:\s*56px/);
});

test('persistent-player handles live inside the full stereo range surface', () => {
  const template = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'templates', 'index.html',
  ), 'utf8');
  assert.match(
    template,
    /<div class="loop-range-surface" data-loop-range-surface hidden>[^]*id="player-loop-start-handle"[^]*id="player-loop-end-handle"[^]*<\/div>/s,
  );
  assert.doesNotMatch(
    template,
    /id="player-loop-region"[^>]*><\/div>\s*<\/div>\s*<button[^>]*id="player-loop-start-handle"/s,
    'the range surface must not close before either stereo-spanning handle',
  );
});

test('waveform progress redraws both stereo channels inside one clipped trail', () => {
  const operations = [];
  const drawingContext = {
    arc(...args) { operations.push(['arc', ...args]); },
    beginPath() {},
    clearRect() {},
    clip() { operations.push(['clip']); },
    closePath() {},
    fill() { operations.push(['fill']); },
    lineTo() {},
    moveTo() {},
    rect(...args) { operations.push(['rect', ...args]); },
    restore() { operations.push(['restore']); },
    save() { operations.push(['save']); },
    scale() {},
    setTransform() {},
    stroke() {},
  };
  const canvas = {
    clientHeight: 40,
    clientWidth: 100,
    getContext: () => drawingContext,
    height: 0,
    width: 0,
  };
  const { context } = loadRuntime();

  context.drawWaveformOnCanvas(canvas, {
    left: [0.1, 0.2, 0.3, 0.2],
    right: [0.2, 0.3, 0.2, 0.1],
  }, 0.75);

  assert.deepEqual(operations.filter(([name]) => name === 'rect'), [['rect', 0, 0, 75, 40]]);
  assert.equal(operations.filter(([name]) => name === 'clip').length, 1);
  const playheadArcIndex = operations.findIndex(([name]) => name === 'arc');
  assert.ok(playheadArcIndex > 0);
  assert.equal(
    operations.slice(0, playheadArcIndex).filter(([name]) => name === 'fill').length,
    4,
    'base and played treatments must each render both L and R channels',
  );
  assert.equal(operations.filter(([name]) => name === 'save').length, 1);
  assert.equal(operations.filter(([name]) => name === 'restore').length, 1);
});
