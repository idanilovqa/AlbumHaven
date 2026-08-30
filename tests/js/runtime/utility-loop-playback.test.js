const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-loop-playback.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const waveformPeaksPath = path.join(
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
const waveformPeaksSource = fs.readFileSync(waveformPeaksPath, 'utf8');

class FakeElement {
  constructor(options = {}) {
    this.tagName = options.tagName || 'DIV';
    this.type = options.type || '';
    this.disabled = Boolean(options.disabled);
    this.isContentEditable = Boolean(options.isContentEditable);
    this.attributes = { ...(options.attributes || {}) };
    this.closestMap = new Map(Object.entries(options.closestMap || {}));
    this.focusCalls = [];
    this._hidden = Boolean(options.hidden);
    this.hiddenWrites = [];
    this.value = String(options.value ?? '');
    this.dataset = { ...(options.dataset || {}) };
    this.style = {};
    this.rect = options.rect || { left: 0, width: 100, top: 0, height: 20 };
    this.listeners = new Map();
  }

  get hidden() {
    return this._hidden;
  }

  set hidden(value) {
    this._hidden = Boolean(value);
    this.hiddenWrites.push(this._hidden);
  }

  getAttribute(name) {
    return this.attributes[name] || '';
  }

  closest(selector) {
    return this.closestMap.get(selector) || null;
  }

  focus(options = {}) {
    this.focusCalls.push(options);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  dispatch(name, event = {}) {
    const handlers = this.listeners.get(name) || [];
    handlers.forEach((handler) => handler({
      preventDefault() {},
      ...event,
    }));
  }
}

class FakeAudio {
  constructor(options = {}) {
    this.attributes = { src: options.src || '' };
    this.currentTime = Number(options.currentTime) || 0;
    this.duration = Number(options.duration) || 0;
    this.paused = Boolean(options.paused);
    this.ended = Boolean(options.ended);
    this.loop = false;
    this.dataset = {};
    this.listeners = new Map();
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.emitMetadataOnLoad = options.emitMetadataOnLoad !== false;
  }

  addEventListener(type, listener, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ listener, once: Boolean(options.once) });
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    const listeners = [...(this.listeners.get(type) || [])];
    listeners.forEach(({ listener, once }) => {
      listener();
      if (once) {
        this.listeners.set(
          type,
          (this.listeners.get(type) || []).filter((entry) => entry.listener !== listener),
        );
      }
    });
  }

  getAttribute(name) {
    return this.attributes[name] || '';
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  load() {
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    if (this.emitMetadataOnLoad) this.dispatch('loadedmetadata');
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
    this.dispatch('pause');
  }
}

function loadHelper(overrides = {}) {
  const context = {
    HTMLElement: FakeElement,
    AbortController,
    Map,
    setTimeout,
    URLSearchParams,
    state: {
      player: { streaming: { generation: 0 } },
      utility: {
        activeTab: 'loops',
        loops: [],
        loopsLoaded: false,
        selectedLoopId: '',
        loopRepeatEnabled: false,
        loopKeyboardSeekBound: false,
        loopEditors: {},
      },
    },
    getUtilityModalElements: () => ({
      overlay: { hidden: false, contains: () => true },
      list: {},
    }),
    renderUtilityLoopList: () => {},
    renderUtilityModalContent: () => {},
    cssEscape: (value) => String(value || ''),
    clampPositionToViewport: (left, top) => ({ left, top }),
    formatLoopTime: (value) => String(value),
    parseLoopTime: (value) => Number(value),
    showToast: () => {},
    showBrowserPrompt: () => '',
    showBrowserConfirm: () => true,
    loopEditSessionExpiryController: {
      start: () => {},
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: () => false,
      stop: () => false,
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    buildUtilityLoopGroupKey: (loop) => {
      const artist = String(loop?.artist || '').trim().toLowerCase();
      const title = String(loop?.title || '').trim().toLowerCase();
      const album = String(loop?.album || '').trim().toLowerCase();
      if (artist || title || album) {
        return `${artist}::${title}::${album}`;
      }
      return String(loop?.id || '');
    },
    groupUtilityLoops: (loops) => {
      const items = Array.isArray(loops) ? loops : [];
      const groups = [];
      const byKey = new Map();
      items.forEach((loop) => {
        const key = context.buildUtilityLoopGroupKey(loop);
        if (!key) return;
        let group = byKey.get(key);
        if (!group) {
          group = {
            key,
            representativeLoop: loop,
            loops: [],
          };
          byKey.set(key, group);
          groups.push(group);
        }
        group.loops.push(loop);
      });
      return groups;
    },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    console,
  };
  Object.assign(context, overrides);
  vm.createContext(context);
  vm.runInContext(waveformPeaksSource, context, { filename: waveformPeaksPath });
  vm.runInContext(helperSource, context, { filename: helperPath });
  return context;
}

test('Loops without an explicit Space owner delegates to global playback', () => {
  const context = loadHelper();

  assert.equal(
    context.handleUtilityLoopSpacePlayback({ target: new FakeElement() }),
    false,
  );
});

test('central utility tab transition clears loop Space ownership and collapses groups when entering Loops', () => {
  const context = loadHelper({
    state: {
      utility: {
        activeTab: 'loops',
        loopSpaceOwnerId: 'loop-1',
        loops: [
          { id: 'loop-1', artist: 'Artist', title: 'Song', album: 'Album' },
          { id: 'loop-2', artist: 'Artist', title: 'Other song', album: 'Album' },
        ],
        collapsedLoopGroups: {},
      },
    },
  });

  assert.equal(context.setUtilityActiveTab('log-history'), 'log-history');
  assert.equal(context.state.utility.activeTab, 'log-history');
  assert.equal(context.state.utility.loopSpaceOwnerId, '');

  assert.equal(context.setUtilityActiveTab('loops'), 'loops');
  assert.equal(context.state.utility.activeTab, 'loops');
  assert.equal(context.state.utility.loopSpaceOwnerId, '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.state.utility.collapsedLoopGroups)),
    {
      'artist::song::album': true,
      'artist::other song::album': true,
    },
  );

  context.state.utility.collapsedLoopGroups['artist::song::album'] = false;
  assert.equal(context.setUtilityActiveTab('loops'), 'loops');
  assert.equal(
    context.state.utility.collapsedLoopGroups['artist::song::album'],
    false,
    'manual expansion remains intact while the Loops tab stays open',
  );
  assert.equal(
    context.handleUtilityLoopSpacePlayback({ target: new FakeElement({ tagName: 'BUTTON' }) }),
    false,
  );
});

test('focused or play-requested loop owns Space until Loops is left', async () => {
  const audio = new FakeAudio({ paused: false, duration: 12, src: '/loops/media/loop-1' });
  const entry = new FakeElement({
    attributes: { 'data-utility-loop-entry': 'loop-1' },
  });
  const neutralControl = new FakeElement();
  const context = loadHelper({
    state: {
      utility: {
        activeTab: 'loops',
        loopSpaceOwnerId: '',
      },
    },
    document: {
      querySelector(selector) {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        return null;
      },
      querySelectorAll: () => [],
    },
  });

  context.claimUtilityLoopSpaceOwnerFromTarget(entry);
  assert.equal(context.state.utility.loopSpaceOwnerId, 'loop-1');
  assert.equal(context.handleUtilityLoopSpacePlayback({ target: entry }), true);
  assert.equal(audio.paused, true);
  assert.equal(audio.pauseCalls, 1);

  assert.equal(context.handleUtilityLoopSpacePlayback({ target: neutralControl }), true);
  await Promise.resolve();
  assert.equal(audio.paused, false);
  assert.equal(audio.playCalls, 1);

  context.clearUtilityLoopSpaceOwner();
  assert.equal(context.state.utility.loopSpaceOwnerId, '');
  assert.equal(context.handleUtilityLoopSpacePlayback({ target: neutralControl }), false);
});

test('owned Space resume request preserves neutral focus while visible loop play request focuses timeline', async () => {
  const audio = new FakeAudio({ paused: true, duration: 12, src: '/loops/media/loop-1' });
  const entry = new FakeElement({
    attributes: { 'data-utility-loop-entry': 'loop-1' },
  });
  const playButton = new FakeElement({
    tagName: 'BUTTON',
    closestMap: { '[data-utility-loop-entry]': entry },
  });
  const timeline = new FakeElement({ tagName: 'INPUT', type: 'range' });
  const neutralControl = new FakeElement({ tagName: 'BUTTON' });
  const context = loadHelper({
    state: {
      utility: {
        activeTab: 'loops',
        loopSpaceOwnerId: 'loop-1',
        loopRepeatEnabled: false,
        selectedLoopId: '',
      },
    },
    document: {
      querySelector(selector) {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        if (selector === '[data-loop-play="loop-1"]') return playButton;
        if (selector === '[data-loop-timeline="loop-1"]') return timeline;
        return null;
      },
      querySelectorAll: () => [],
      addEventListener() {},
    },
  });

  assert.equal(context.handleUtilityLoopSpacePlayback({ target: neutralControl }), true);
  await Promise.resolve();
  assert.equal(audio.playCalls, 1);
  assert.equal(timeline.focusCalls.length, 0);

  audio.paused = true;
  context.initializeUtilityLoopPlayer({ id: 'loop-1' });
  playButton.dispatch('click');
  await Promise.resolve();
  assert.equal(audio.playCalls, 2);
  assert.equal(timeline.focusCalls.length, 1);
});

test('saved-loop playback waits for active global-player ownership to release before native media playback', async () => {
  const events = [];
  let resolveGlobalPause;
  const globalPause = new Promise((resolve) => {
    resolveGlobalPause = resolve;
  });
  const audio = new FakeAudio({ paused: true, duration: 12, src: '/loops/media/loop-1' });
  const secondAudio = new FakeAudio({ paused: true, duration: 12, src: '/loops/media/loop-2' });
  audio.play = () => {
    events.push('loop-play');
    audio.playCalls += 1;
    audio.paused = false;
    return Promise.resolve();
  };
  secondAudio.play = () => {
    events.push('second-loop-play');
    secondAudio.playCalls += 1;
    secondAudio.paused = false;
    return Promise.resolve();
  };
  let snapshotReadCount = 0;
  const context = loadHelper({
    getPlayerPlaybackSnapshot: () => ({
      paused: snapshotReadCount++ > 0,
      ended: false,
      src: '/track?path=current',
    }),
    pausePlayerPlaybackForHandoff(playback) {
      events.push(['global-pause', playback]);
      return globalPause;
    },
    document: {
      querySelector(selector) {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        if (selector === '[data-loop-audio="loop-2"]') return secondAudio;
        return null;
      },
      querySelectorAll: () => [],
    },
  });

  assert.equal(context.toggleUtilityLoopPlayback('loop-1'), true);
  assert.equal(context.toggleUtilityLoopPlayback('loop-2'), true);
  await Promise.resolve();

  assert.equal(events[0]?.[0], 'global-pause');
  assert.equal(audio.playCalls, 1, 'native loop playback must retain the initiating browser activation');
  assert.equal(secondAudio.playCalls, 1, 'a second loop must retain its own initiating browser activation');
  assert.equal(audio.muted, true, 'the first loop must stay silent until global ownership releases');
  assert.equal(secondAudio.muted, true, 'a second loop must stay silent until the shared handoff releases');
  resolveGlobalPause();
  await globalPause;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => Array.isArray(event)).length, 2);
  assert.deepEqual(events.filter((event) => typeof event === 'string').sort(), ['loop-play', 'second-loop-play']);
  assert.equal(audio.playCalls, 1);
  assert.equal(secondAudio.playCalls, 1);
  assert.equal(audio.muted, false);
  assert.equal(secondAudio.muted, false);
});

function loadOwnedLoopKeyboardHelper() {
  const audio = new FakeAudio({ paused: false, duration: 12, src: '/loops/media/loop-1' });
  const entry = new FakeElement({
    attributes: { 'data-utility-loop-entry': 'loop-1' },
  });
  const target = new FakeElement({
    tagName: 'BUTTON',
    closestMap: { '[data-utility-loop-entry]': entry },
  });
  const context = loadHelper({
    state: {
      utility: {
        activeTab: 'loops',
        loopSpaceOwnerId: 'loop-1',
      },
    },
    document: {
      querySelector(selector) {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        return null;
      },
      querySelectorAll: () => [],
    },
  });
  return { audio, context, target };
}

test('saved-loop playback ignores Shift+Space', () => {
  const { audio, context, target } = loadOwnedLoopKeyboardHelper();
  let prevented = 0;
  let stopped = 0;

  assert.equal(context.handleUtilityLoopKeyboardSeek({
    key: ' ',
    code: 'Space',
    shiftKey: true,
    target,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  }), false);
  assert.equal(audio.pauseCalls, 0);
  assert.deepEqual({ prevented, stopped }, { prevented: 0, stopped: 0 });
});

test('saved-loop playback ignores repeated Space', () => {
  const { audio, context, target } = loadOwnedLoopKeyboardHelper();
  let prevented = 0;
  let stopped = 0;

  assert.equal(context.handleUtilityLoopKeyboardSeek({
    key: ' ',
    code: 'Space',
    repeat: true,
    target,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  }), false);
  assert.equal(audio.pauseCalls, 0);
  assert.deepEqual({ prevented, stopped }, { prevented: 0, stopped: 0 });
});

test('saved-loop playback ignores IME-composing Space', () => {
  const { audio, context, target } = loadOwnedLoopKeyboardHelper();
  let prevented = 0;
  let stopped = 0;

  assert.equal(context.handleUtilityLoopKeyboardSeek({
    key: ' ',
    code: 'Space',
    isComposing: true,
    target,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  }), false);
  assert.equal(audio.pauseCalls, 0);
  assert.deepEqual({ prevented, stopped }, { prevented: 0, stopped: 0 });
});

test('repeat state leaves native media looping disabled so the app can restart short saved loops reliably', () => {
  const selectedAudio = new FakeAudio();
  const otherAudio = new FakeAudio();
  const createRepeatButton = (loopId) => ({
    attributes: {
      'aria-pressed': 'false',
      'data-toggle-loop-repeat': loopId,
    },
    classList: { toggle() {} },
    getAttribute(name) {
      return this.attributes[name] || '';
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  });
  const selectedButton = createRepeatButton('loop-1');
  const otherButton = createRepeatButton('loop-2');
  const context = loadHelper({
    state: {
      utility: {
        loopRepeatEnabled: true,
        selectedLoopId: 'loop-1',
      },
    },
    document: {
      querySelector(selector) {
        if (selector === '[data-loop-audio="loop-1"]') return selectedAudio;
        if (selector === '[data-loop-audio="loop-2"]') return otherAudio;
        return null;
      },
      querySelectorAll(selector) {
        return selector === '[data-toggle-loop-repeat]'
          ? [selectedButton, otherButton]
          : [];
      },
    },
  });

  context.updateUtilityLoopRepeatButton('loop-2');

  assert.equal(selectedAudio.loop, false);
  assert.equal(otherAudio.loop, false);
  assert.equal(selectedButton.attributes['aria-pressed'], 'true');
  assert.equal(otherButton.attributes['aria-pressed'], 'false');
});

{
  const context = loadHelper();
  const loops = [
    { id: 'alpha' },
    { id: 'beta' },
    { id: 'gamma' },
  ];

  const reordered = context.buildReorderedUtilityLoops(
    loops,
    { type: 'group', id: 'alpha', groupKey: 'alpha' },
    { type: 'group', id: 'gamma', groupKey: 'gamma' },
    'after',
  );

  assert.deepEqual(JSON.parse(JSON.stringify(reordered)), [
    { id: 'beta' },
    { id: 'gamma' },
    { id: 'alpha' },
  ]);
}

{
  const context = loadHelper();
  const loops = [
    { id: 'alpha', artist: 'Neal Morse', title: 'The Door', album: 'One' },
    { id: 'beta', artist: 'Neal Morse', title: 'The Door', album: 'One' },
    { id: 'gamma', artist: 'Neal Morse', title: 'The Door', album: 'One' },
  ];
  const groupKey = 'neal morse::the door::one';

  const reordered = context.buildReorderedUtilityLoops(
    loops,
    { type: 'loop', id: 'gamma', groupKey },
    { type: 'loop', id: 'alpha', groupKey },
    'before',
  );

  assert.deepEqual(JSON.parse(JSON.stringify(reordered)), [
    { id: 'gamma', artist: 'Neal Morse', title: 'The Door', album: 'One' },
    { id: 'alpha', artist: 'Neal Morse', title: 'The Door', album: 'One' },
    { id: 'beta', artist: 'Neal Morse', title: 'The Door', album: 'One' },
  ]);
}

{
  const context = loadHelper();
  const loops = [
    { id: 'alpha' },
    { id: 'beta' },
  ];

  assert.equal(
    context.buildReorderedUtilityLoops(
      loops,
      { type: 'group', id: 'alpha', groupKey: 'alpha' },
      { type: 'group', id: 'alpha', groupKey: 'alpha' },
      'after',
    ),
    null,
  );
  assert.equal(
    context.buildReorderedUtilityLoops(
      loops,
      { type: 'group', id: 'missing', groupKey: 'missing' },
      { type: 'group', id: 'alpha', groupKey: 'alpha' },
      'after',
    ),
    null,
  );
}

{
  const timeline = new FakeElement({
    tagName: 'INPUT',
    type: 'range',
  });
  const audio = {
    currentTime: 12,
    duration: 53,
  };
  const loopEntry = new FakeElement({
    attributes: {
      'data-utility-loop-entry': 'loop-1',
    },
  });
  const target = new FakeElement({
    tagName: 'BUTTON',
    closestMap: {
      '[data-utility-loop-entry]': loopEntry,
    },
  });
  const context = loadHelper({
    document: {
      querySelector: (selector) => {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        if (selector === '[data-loop-timeline="loop-1"]') return timeline;
        if (selector === '[data-loop-play="loop-1"]') return null;
        if (selector === '[data-loop-time="loop-1"]') return null;
        return null;
      },
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  });
  let prevented = false;

  const handled = context.handleUtilityLoopKeyboardSeek({
    key: 'ArrowLeft',
    target,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });

  assert.equal(handled, true);
  assert.equal(prevented, true);
  assert.equal(audio.currentTime, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(timeline.focusCalls)), [{ preventScroll: true }]);
}

{
  const timeline = new FakeElement({
    tagName: 'INPUT',
    type: 'range',
  });
  const audio = {
    currentTime: 12,
    duration: 53,
  };
  const loopEntry = new FakeElement({
    attributes: {
      'data-utility-loop-entry': 'loop-1',
    },
  });
  const target = new FakeElement({
    tagName: 'INPUT',
    type: 'text',
    closestMap: {
      '[data-utility-loop-entry]': loopEntry,
    },
  });
  const context = loadHelper({
    document: {
      querySelector: (selector) => {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        if (selector === '[data-loop-timeline="loop-1"]') return timeline;
        return null;
      },
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  });

  const handled = context.handleUtilityLoopKeyboardSeek({
    key: 'ArrowRight',
    target,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(handled, false);
  assert.equal(audio.currentTime, 12);
  assert.equal(timeline.focusCalls.length, 0);
}

{
  const timeline = new FakeElement({
    tagName: 'INPUT',
    type: 'range',
  });
  let playCalls = 0;
  let pauseCalls = 0;
  const audio = {
    currentTime: 12,
    duration: 53,
    paused: true,
    ended: false,
    play() {
      playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      pauseCalls += 1;
      this.paused = true;
    },
  };
  const loopEntry = new FakeElement({
    attributes: {
      'data-utility-loop-entry': 'loop-1',
    },
  });
  const target = new FakeElement({
    tagName: 'BUTTON',
    closestMap: {
      '[data-utility-loop-entry]': loopEntry,
    },
  });
  const context = loadHelper({
    document: {
      querySelector: (selector) => {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        if (selector === '[data-loop-timeline="loop-1"]') return timeline;
        if (selector === '[data-loop-play="loop-1"]') return null;
        if (selector === '[data-loop-time="loop-1"]') return null;
        return null;
      },
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
  });
  let prevented = false;

  const played = context.handleUtilityLoopKeyboardSeek({
    key: ' ',
    code: 'Space',
    target,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });

  assert.equal(played, true);
  assert.equal(prevented, true);
  assert.equal(playCalls, 1);
  assert.equal(pauseCalls, 0);

  const paused = context.handleUtilityLoopKeyboardSeek({
    key: ' ',
    code: 'Space',
    target,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    stopPropagation() {},
  });

  assert.equal(paused, true);
  assert.equal(playCalls, 1);
  assert.equal(pauseCalls, 1);
}

async function verifyPitchPreviewRestoresPlaybackWhenMetadataLoadsSynchronously() {
  const audio = new FakeAudio({
    src: '/loops/original.mp3',
    currentTime: 17,
    duration: 60,
    paused: false,
  });
  const context = loadHelper({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        media_url: '/loops/pitched.mp3',
      }),
    }),
    document: {
      querySelector: (selector) => {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        return null;
      },
      querySelectorAll: () => [],
    },
  });

  await context.renderUtilityLoopPitchPreview('loop-1', 3);

  assert.equal(audio.currentTime, 17);
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.paused, false);
}

verifyPitchPreviewRestoresPlaybackWhenMetadataLoadsSynchronously().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function verifyPitchPreviewRestoresLatestPlaybackStateAfterPendingRequest() {
  let resolveFetch;
  const responsePending = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const audio = new FakeAudio({
    src: '/loops/original.mp3',
    currentTime: 17,
    duration: 60,
    paused: false,
    emitMetadataOnLoad: false,
  });
  const context = loadHelper({
    fetch: () => responsePending,
    document: {
      querySelector: (selector) => {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        return null;
      },
      querySelectorAll: () => [],
    },
  });

  const previewPending = context.renderUtilityLoopPitchPreview('loop-1', 3);
  audio.currentTime = 23;
  audio.paused = false;
  resolveFetch({
    ok: true,
    json: async () => ({
      ok: true,
      media_url: '/loops/pitched.mp3',
    }),
  });
  await previewPending;
  audio.dispatch('loadedmetadata');

  assert.equal(audio.currentTime, 23);
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.paused, false);
}

verifyPitchPreviewRestoresLatestPlaybackStateAfterPendingRequest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function verifyPitchPreviewRestartsAfterPlaybackNaturallyEndsWhileRequestIsPending() {
  let resolveFetch;
  const responsePending = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const audio = new FakeAudio({
    src: '/loops/original.mp3',
    currentTime: 58,
    duration: 60,
    paused: false,
    emitMetadataOnLoad: false,
  });
  const context = loadHelper({
    fetch: () => responsePending,
    document: {
      querySelector: (selector) => {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        return null;
      },
      querySelectorAll: () => [],
    },
  });

  const previewPending = context.renderUtilityLoopPitchPreview('loop-1', 3);
  audio.currentTime = 60;
  audio.paused = true;
  audio.ended = true;
  resolveFetch({
    ok: true,
    json: async () => ({
      ok: true,
      media_url: '/loops/pitched.mp3',
    }),
  });
  await previewPending;
  audio.dispatch('loadedmetadata');

  assert.equal(audio.currentTime, 0);
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.paused, false);
}

verifyPitchPreviewRestartsAfterPlaybackNaturallyEndsWhileRequestIsPending().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function verifyPitchPreviewKeepsExplicitPauseWhileRequestIsPending() {
  let resolveFetch;
  const responsePending = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const audio = new FakeAudio({
    src: '/loops/original.mp3',
    currentTime: 17,
    duration: 60,
    paused: false,
    emitMetadataOnLoad: false,
  });
  const context = loadHelper({
    fetch: () => responsePending,
    document: {
      querySelector: (selector) => {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        return null;
      },
      querySelectorAll: () => [],
    },
  });

  const previewPending = context.renderUtilityLoopPitchPreview('loop-1', 3);
  audio.currentTime = 23;
  audio.paused = true;
  audio.ended = false;
  resolveFetch({
    ok: true,
    json: async () => ({
      ok: true,
      media_url: '/loops/pitched.mp3',
    }),
  });
  await previewPending;
  audio.dispatch('loadedmetadata');

  assert.equal(audio.currentTime, 23);
  assert.equal(audio.playCalls, 0);
  assert.equal(audio.paused, true);
}

verifyPitchPreviewKeepsExplicitPauseWhileRequestIsPending().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function verifyPitchPreviewIgnoresStaleOutOfOrderResponse() {
  const pendingResponses = [];
  const pitchValue = { textContent: '' };
  const audio = new FakeAudio({
    src: '/loops/original.mp3',
    currentTime: 17,
    duration: 60,
    paused: false,
    emitMetadataOnLoad: false,
  });
  const context = loadHelper({
    fetch: () => new Promise((resolve) => {
      pendingResponses.push(resolve);
    }),
    document: {
      querySelector: (selector) => {
        if (selector === '[data-loop-audio="loop-1"]') return audio;
        if (selector === '[data-loop-pitch-control="loop-1"] [data-loop-pitch-value]') {
          return pitchValue;
        }
        return null;
      },
      querySelectorAll: () => [],
    },
  });

  const firstPreviewPending = context.renderUtilityLoopPitchPreview('loop-1', 1);
  const secondPreviewPending = context.renderUtilityLoopPitchPreview('loop-1', 2);

  pendingResponses[1]({
    ok: true,
    json: async () => ({
      ok: true,
      media_url: '/loops/pitched-plus-2.mp3',
    }),
  });
  await secondPreviewPending;
  audio.dispatch('loadedmetadata');

  assert.equal(audio.getAttribute('src'), '/loops/pitched-plus-2.mp3');
  assert.equal(audio.dataset.pitch, '2');
  assert.equal(pitchValue.textContent, '+2 pst');
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.paused, false);

  pendingResponses[0]({
    ok: true,
    json: async () => ({
      ok: true,
      media_url: '/loops/pitched-plus-1.mp3',
    }),
  });
  await firstPreviewPending;
  audio.dispatch('loadedmetadata');

  assert.equal(audio.getAttribute('src'), '/loops/pitched-plus-2.mp3');
  assert.equal(audio.dataset.pitch, '2');
  assert.equal(pitchValue.textContent, '+2 pst');
  assert.equal(audio.playCalls, 1);
  assert.equal(audio.paused, false);
}

verifyPitchPreviewIgnoresStaleOutOfOrderResponse().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function createSavedLoopEditorHarness(options = {}) {
  const loop = {
    id: 'loop-1',
    name: 'Opening phrase',
    artist: 'Artist',
    title: 'Song',
    album: 'Album',
    duration_seconds: 12,
  };
  const createdLoop = options.createdLoop || loop;
  const responseLoops = options.responseLoops || [loop];
  const editor = new FakeElement({ hidden: options.hidden !== false });
  const main = new FakeElement();
  const actionRoot = new FakeElement({ attributes: { 'data-loop-action-state': options.hidden === false ? 'editing' : 'idle' } });
  const timeline = new FakeElement();
  const playbackTime = new FakeElement();
  const boundaryTimes = new FakeElement({ hidden: options.hidden !== false });
  const canvas = new FakeElement({
    tagName: 'CANVAS',
    rect: { left: 100, width: 200, top: 0, height: 60 },
  });
  const startHandle = new FakeElement({
    tagName: 'BUTTON',
    attributes: { 'data-loop-range-handle': 'start' },
  });
  const endHandle = new FakeElement({
    tagName: 'BUTTON',
    attributes: { 'data-loop-range-handle': 'end' },
  });
  const startTime = new FakeElement();
  const endTime = new FakeElement();
  const audio = new FakeAudio({ src: '/loops/media/loop-1', duration: 12, paused: true });
  const dialogCalls = [];
  const toastCalls = [];
  const fetchCalls = [];
  const waveformLoads = [];
  const waveformDraws = [];
  const rangeControllerMounts = [];
  const renderCalls = [];
  const waveform = {
    left: Array.from({ length: 280 }, () => 0.4),
    right: Array.from({ length: 280 }, () => 0.2),
    sampleCount: 280,
  };
  editor.matches = (selector) => selector === '[data-loop-range-surface]';
  editor.querySelector = (selector) => ({
    '[data-loop-range-waveform]': canvas,
    '[data-loop-range-handle="start"]': startHandle,
    '[data-loop-range-handle="end"]': endHandle,
  }[selector] || null);
  boundaryTimes.querySelector = (selector) => ({
    '[data-loop-range-time="start"]': startTime,
    '[data-loop-range-time="end"]': endTime,
  }[selector] || null);
  main.querySelector = (selector) => ({
    '[data-loop-timeline]': timeline,
    '[data-loop-time]': playbackTime,
    '[data-loop-range-times]': boundaryTimes,
  }[selector] || null);
  main.classList = { toggle() {} };
  const elements = new Map([
    ['[data-loop-range-owner="saved-loop-loop-1"]', editor],
    ['[data-saved-loop-main-surface="loop-1"]', main],
    ['[data-loop-action-owner="saved-loop-loop-1"]', actionRoot],
    ['[data-loop-audio="loop-1"]', audio],
  ]);
  const context = loadHelper({
    ...(options.loopEditSessionExpiryController ? {
      loopEditSessionExpiryController: options.loopEditSessionExpiryController,
    } : {}),
    state: {
      utility: {
        activeTab: 'loops',
        loops: [loop],
        loopsLoaded: true,
        selectedLoopId: 'loop-1',
        loopRepeatEnabled: false,
        loopKeyboardSeekBound: false,
        loopEditors: options.hidden === false ? {
          'loop-1': {
            active: true,
            startSeconds: contextParse(options.start ?? '0:02.250'),
            endSeconds: contextParse(options.end ?? '0:08.750'),
            durationSeconds: 12,
          },
        } : {},
      },
    },
    document: {
      querySelector: (selector) => elements.get(selector) || null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    formatLoopTime(value, includeMilliseconds = false) {
      const seconds = Math.max(0, Number(value) || 0);
      const minutes = Math.floor(seconds / 60);
      const remaining = seconds - (minutes * 60);
      return includeMilliseconds
        ? `${minutes}:${remaining.toFixed(3).padStart(6, '0')}`
        : `${minutes}:${String(Math.floor(remaining)).padStart(2, '0')}`;
    },
    parseLoopTime(value) {
      const [minutes, seconds] = String(value || '').split(':');
      return seconds === undefined ? Number(minutes) : (Number(minutes) * 60) + Number(seconds);
    },
    async showLoopNameDialog() {
      dialogCalls.push('open');
      if (options.dialogPromise) return options.dialogPromise;
      return Object.prototype.hasOwnProperty.call(options, 'dialogResult')
        ? options.dialogResult
        : 'Second phrase';
    },
    async showLoopDeleteConfirmDialog() {
      return options.deleteConfirmed !== false;
    },
    showBrowserPrompt() {
      throw new Error('saved-loop creation must use the app-owned loop-name dialog');
    },
    async fetch(url, init = {}) {
      if (String(url).startsWith('/playback/waveform?')) {
        waveformLoads.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => options.waveformPromise || waveform,
        };
      }
      fetchCalls.push({ url, init });
      if (url === '/loops/delete' && options.deleteResponse) {
        return options.deleteResponse;
      }
      return {
        ok: true,
        json: async () => ({ ok: true, loop: createdLoop, loops: responseLoops }),
      };
    },
    renderUtilityModalContent() {
      renderCalls.push({
        loopIds: Array.from(context.state.utility.loops || [], (item) => String(item.id || '')),
        selectedLoopId: context.state.utility.selectedLoopId,
        selectedLoopGroupKey: context.state.utility.selectedLoopGroupKey,
        selectedLoopDetailMode: context.state.utility.selectedLoopDetailMode,
      });
    },
    drawCombinedLoopWaveform(target, data, progressRatio) {
      waveformDraws.push({ target, data, progressRatio });
    },
    showToast(...args) {
      toastCalls.push(args);
    },
    mountLoopEditActionControl({ root, active }) {
      const controller = {
        update(next) {
          root.setAttribute('data-loop-action-state', next.active ? 'editing' : 'idle');
        },
      };
      controller.update({ active });
      return controller;
    },
    createLoopRangeController(controllerOptions) {
      rangeControllerMounts.push(controllerOptions);
      const {
        getRange, onRangeInteractionStart, onRangePreview, onRangeCommit, onSeek, onCancel,
      } = controllerOptions;
      return {
        render: () => getRange(),
        interact: (role) => onRangeInteractionStart(role),
        preview: (range) => onRangePreview(range),
        commit: (range) => onRangeCommit(range),
        seek: (seconds) => onSeek(seconds),
        cancel: () => onCancel(),
      };
    },
    drawWaveformOnCanvas(target, data, progressRatio) {
      waveformDraws.push({ target, data, progressRatio });
    },
  });
  return {
    context,
    editor,
    main,
    timeline,
    playbackTime,
    audio,
    canvas,
    startHandle,
    endHandle,
    startTime,
    endTime,
    boundaryTimes,
    actionRoot,
    elements,
    dialogCalls,
    toastCalls,
    fetchCalls,
    waveform,
    waveformLoads,
    waveformDraws,
    rangeControllerMounts,
    renderCalls,
  };
}

function contextParse(value) {
  const [minutes, seconds] = String(value || '').split(':');
  return seconds === undefined ? Number(minutes) : (Number(minutes) * 60) + Number(seconds);
}

test('first saved-loop creation activation opens one combined inline range without prompting or posting', async () => {
  const harness = createSavedLoopEditorHarness();

  await harness.context.createLoopFromSavedLoop('loop-1');

  assert.equal(harness.editor.hidden, false);
  assert.deepEqual(harness.dialogCalls, []);
  assert.deepEqual(harness.fetchCalls, []);
  assert.deepEqual(harness.waveformLoads, ['/playback/waveform?loop_id=loop-1&bins=280']);
  assert.equal(harness.waveformDraws.length, 1);
  assert.strictEqual(harness.waveformDraws[0].target, harness.canvas);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.waveformDraws[0].data)),
    harness.waveform,
  );
});

test('Enter opens saved-loop naming from active edit mode without creating the loop', async () => {
  const harness = createSavedLoopEditorHarness({
    hidden: false,
    dialogResult: null,
  });
  assert.equal(typeof harness.context.handleSavedLoopEditKeydown, 'function');
  let prevented = 0;
  let stopped = 0;
  harness.startHandle.closestMap.set('[role="dialog"], dialog, [aria-modal="true"]', {});

  const handled = harness.context.handleSavedLoopEditKeydown({
    key: 'Enter',
    target: harness.startHandle,
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() { prevented += 1; },
    stopPropagation() { stopped += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handled, true);
  assert.deepEqual(harness.dialogCalls, ['open']);
  assert.deepEqual(harness.fetchCalls, []);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test('saved-loop creation ignores a second activation while the waveform editor is still opening', async () => {
  let resolveWaveform;
  const waveformPromise = new Promise((resolve) => {
    resolveWaveform = resolve;
  });
  const harness = createSavedLoopEditorHarness({ waveformPromise });

  const opening = harness.context.createLoopFromSavedLoop('loop-1');
  const duplicate = harness.context.createLoopFromSavedLoop('loop-1');
  await duplicate;

  assert.deepEqual(harness.waveformLoads, ['/playback/waveform?loop_id=loop-1&bins=280']);
  assert.deepEqual(harness.dialogCalls, []);
  assert.deepEqual(harness.fetchCalls, []);

  resolveWaveform(harness.waveform);
  await opening;

  assert.equal(harness.waveformDraws.length, 1);
  assert.deepEqual(harness.dialogCalls, []);
});

test('saved-loop editor stays hidden and busy until waveform draw succeeds, and stays idle on failure', async () => {
  let resolveWaveform;
  const waveformPromise = new Promise((resolve) => {
    resolveWaveform = resolve;
  });
  const harness = createSavedLoopEditorHarness({ waveformPromise });

  const opening = harness.context.openSavedLoopCreation('loop-1');
  await Promise.resolve();
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.boundaryTimes.hidden, true);
  assert.equal(harness.actionRoot.getAttribute('aria-busy'), 'true');
  assert.equal(harness.editor.hiddenWrites.filter((value) => value === false).length, 0);

  resolveWaveform(harness.waveform);
  assert.equal(await opening, true);
  assert.equal(harness.waveformDraws.length, 1);
  assert.equal(harness.editor.hidden, false);
  assert.equal(harness.boundaryTimes.hidden, true, 'the obsolete second timestamp row stays hidden');
  assert.equal(harness.actionRoot.getAttribute('aria-busy'), 'false');
  assert.equal(harness.editor.hiddenWrites.filter((value) => value === false).length, 1);

  const failed = createSavedLoopEditorHarness({
    waveformPromise: Promise.reject(new Error('waveform unavailable')),
  });
  assert.equal(await failed.context.openSavedLoopCreation('loop-1'), false);
  assert.equal(failed.editor.hidden, true);
  assert.equal(failed.boundaryTimes.hidden, true);
  assert.equal(failed.actionRoot.getAttribute('data-loop-action-state'), 'idle');
  assert.equal(failed.actionRoot.getAttribute('aria-busy'), 'false');
  assert.equal(failed.waveformDraws.length, 0);
  assert.deepEqual(failed.fetchCalls, []);
});

test('cancel during pending saved-loop waveform load invalidates stale completion without side effects', async () => {
  let resolveWaveform;
  const harness = createSavedLoopEditorHarness({
    waveformPromise: new Promise((resolve) => { resolveWaveform = resolve; }),
  });

  const opening = harness.context.openSavedLoopCreation('loop-1');
  await Promise.resolve();
  harness.editor._loopRangeController.cancel();
  assert.equal(harness.editor.hidden, true);

  resolveWaveform(harness.waveform);
  assert.equal(await opening, false);
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.boundaryTimes.hidden, true);
  assert.equal(harness.actionRoot.getAttribute('data-loop-action-state'), 'idle');
  assert.equal(harness.actionRoot.getAttribute('aria-busy'), 'false');
  assert.equal(harness.waveformDraws.length, 0);
  assert.deepEqual(harness.toastCalls, []);
  assert.deepEqual(harness.fetchCalls, []);
});

test('saved-loop rerender during pending waveform load completes on the current replacement root', async () => {
  let resolveWaveform;
  const harness = createSavedLoopEditorHarness({
    waveformPromise: new Promise((resolve) => { resolveWaveform = resolve; }),
  });
  const opening = harness.context.openSavedLoopCreation('loop-1');
  await Promise.resolve();

  const replacementCanvas = new FakeElement({
    tagName: 'CANVAS',
    rect: { left: 100, width: 200, top: 0, height: 60 },
  });
  const replacementRoot = new FakeElement({ hidden: true });
  replacementRoot.matches = (selector) => selector === '[data-loop-range-surface]';
  replacementRoot.querySelector = (selector) => ({
    '[data-loop-range-waveform]': replacementCanvas,
    '[data-loop-range-handle="start"]': harness.startHandle,
    '[data-loop-range-handle="end"]': harness.endHandle,
  }[selector] || null);
  const replacementActionRoot = new FakeElement({ attributes: { 'data-loop-action-state': 'idle' } });
  harness.elements.set('[data-loop-range-owner="saved-loop-loop-1"]', replacementRoot);
  harness.elements.set('[data-loop-action-owner="saved-loop-loop-1"]', replacementActionRoot);

  resolveWaveform(harness.waveform);
  assert.equal(await opening, true);
  assert.equal(harness.editor.hidden, true);
  assert.equal(replacementRoot.hidden, false);
  assert.equal(replacementActionRoot.getAttribute('data-loop-action-state'), 'editing');
  assert.equal(replacementActionRoot.getAttribute('aria-busy'), 'false');
  assert.equal(harness.waveformDraws.length, 1);
  assert.strictEqual(harness.waveformDraws[0].target, replacementCanvas);
  assert.deepEqual(harness.toastCalls, []);
  assert.deepEqual(harness.fetchCalls, []);
});

test('saved-loop preview and commit keep the single top-right time slot ordered across crossing and reopen', async () => {
  const harness = createSavedLoopEditorHarness();
  await harness.context.openSavedLoopCreation('loop-1');
  const controller = harness.editor._loopRangeController;

  controller.preview({ startSeconds: 3, endSeconds: 9 });
  assert.equal(harness.playbackTime.textContent, '0:03.000 - 0:09.000');
  assert.equal(harness.boundaryTimes.hidden, true);

  controller.commit({ startSeconds: 10, endSeconds: 2 });
  assert.equal(harness.playbackTime.textContent, '0:02.000 - 0:10.000');

  harness.context.cancelSavedLoopCreation('loop-1');
  assert.equal(harness.boundaryTimes.hidden, true);
  await harness.context.openSavedLoopCreation('loop-1');
  harness.editor._loopRangeController.preview({ startSeconds: 1.00571425, endSeconds: 8 });
  assert.equal(harness.playbackTime.textContent, '0:01.006 - 0:08.000');
  assert.equal(harness.boundaryTimes.hidden, true);
});

test('saved-loop creation keeps its captured duration when media metadata changes during editing', async () => {
  const harness = createSavedLoopEditorHarness();

  await harness.context.openSavedLoopCreation('loop-1');
  assert.equal(harness.rangeControllerMounts.length, 1);
  assert.equal(harness.context.state.utility.loopEditors['loop-1'].durationSeconds, 12);
  assert.equal(harness.rangeControllerMounts[0].getDuration(), 12);

  harness.audio.duration = 48;
  assert.equal(
    harness.rangeControllerMounts[0].getDuration(),
    12,
    'late audio metadata cannot rescale the active saved-loop edit',
  );
  const range = harness.context.syncSavedLoopRange('loop-1', { startSeconds: 3, endSeconds: 40 });
  assert.equal(range.durationSeconds, 12);
  assert.deepEqual(
    { startSeconds: range.startSeconds, endSeconds: range.endSeconds },
    { startSeconds: 3, endSeconds: 12 },
  );
});

test('active saved-loop playback redraws its waveform with live playhead progress', async () => {
  const harness = createSavedLoopEditorHarness();
  await harness.context.openSavedLoopCreation('loop-1');
  harness.context.initializeUtilityLoopPlayer({ id: 'loop-1' });
  harness.audio.duration = 12;
  harness.audio.currentTime = 3;
  harness.audio.dispatch('timeupdate');

  assert.strictEqual(harness.waveformDraws.at(-1).target, harness.canvas);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.waveformDraws.at(-1).data)),
    harness.waveform,
  );
  assert.equal(harness.waveformDraws.at(-1).progressRatio, 0.25);
});

test('saved-loop waveform seek moves playback without changing editor boundaries', async () => {
  const harness = createSavedLoopEditorHarness();
  await harness.context.openSavedLoopCreation('loop-1');
  const before = { ...harness.context.state.utility.loopEditors['loop-1'] };

  harness.editor._loopRangeController.seek(4.5);

  assert.equal(harness.audio.currentTime, 4.5);
  assert.equal(harness.timeline.value, '4.5');
  assert.equal(harness.context.state.utility.loopEditors['loop-1'].startSeconds, before.startSeconds);
  assert.equal(harness.context.state.utility.loopEditors['loop-1'].endSeconds, before.endSeconds);
});

test('saved-loop edit hides pitch through its editing class while keeping the boundary timestamp visible', async () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const harness = createSavedLoopEditorHarness();

  await harness.context.openSavedLoopCreation('loop-1');
  harness.editor._loopRangeController.preview({ startSeconds: 2.25, endSeconds: 8.75 });

  assert.equal(harness.playbackTime.hidden, false);
  assert.equal(harness.playbackTime.textContent, '0:02.250 - 0:08.750');
  assert.match(css, /\.utility-loop-main\.is-loop-editing\s+\.utility-loop-pitch-control\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(css, /\.utility-loop-main\.is-loop-editing\s+\.utility-loop-time\s*\{[^}]*display:\s*none/s);
});

test('saved-loop edit keeps its semantic timeline transparent beneath the canvas playhead', async () => {
  const css = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css',
  ), 'utf8');
  const harness = createSavedLoopEditorHarness();
  harness.audio.currentTime = 4;
  harness.audio.paused = false;
  const originalAudio = harness.audio;

  await harness.context.openSavedLoopCreation('loop-1');

  assert.strictEqual(harness.elements.get('[data-loop-audio="loop-1"]'), originalAudio);
  assert.equal(harness.audio.pauseCalls, 0);
  assert.equal(harness.audio.currentTime, 4);
  assert.equal(harness.timeline.hidden, false, 'the semantic playback timeline remains available in edit mode');
  assert.match(css, /\.utility-loop-main\.is-loop-editing\s+\.utility-loop-timeline\s*\{[^}]*appearance:\s*none[^}]*background:\s*transparent/s);
  assert.match(css, /\.utility-loop-main\.is-loop-editing\s+\.utility-loop-timeline::\-webkit-slider-runnable-track\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.utility-loop-main\.is-loop-editing\s+\.utility-loop-timeline::\-webkit-slider-thumb\s*\{[^}]*width:\s*0[^}]*height:\s*0/s);
  harness.editor._loopRangeController.preview({ startSeconds: 2.25, endSeconds: 8.75 });
  assert.equal(harness.playbackTime.textContent, '0:02.250 - 0:08.750');
  assert.equal(harness.boundaryTimes.hidden, true, 'there is no second boundary-time output');

  harness.audio.currentTime = 5;
  harness.context.updateUtilityLoopPlayerUi('loop-1');
  assert.equal(harness.timeline.value, '5');
  assert.equal(harness.timeline.hidden, false);
  assert.equal(harness.playbackTime.textContent, '0:02.250 - 0:08.750');
});

test('saved-loop cancellation and naming-dialog cancellation never pause or recreate media', async () => {
  const harness = createSavedLoopEditorHarness({
    hidden: false,
    dialogResult: null,
    start: '0:02.250',
    end: '0:08.750',
  });
  harness.audio.currentTime = 5.5;
  harness.audio.paused = false;
  const originalAudio = harness.audio;

  await harness.context.createLoopFromSavedLoop('loop-1');
  harness.context.cancelSavedLoopCreation('loop-1');

  assert.strictEqual(harness.elements.get('[data-loop-audio="loop-1"]'), originalAudio);
  assert.equal(harness.audio.pauseCalls, 0);
  assert.equal(harness.audio.currentTime, 5.5);
  assert.equal(harness.timeline.hidden, false);
});

test('saved-loop editor shares expiry ownership, renews for boundary interactions and changes, and manual cancel does not pause', async () => {
  const starts = [];
  const renewals = [];
  const stops = [];
  const harness = createSavedLoopEditorHarness({
    loopEditSessionExpiryController: {
      start: (session) => starts.push(session),
      renewAfterBoundaryEdit: (ownerId) => renewals.push(ownerId),
      noteUntouchedWholeRangeWrap: () => false,
      stop: (ownerId) => stops.push(ownerId),
    },
  });

  await harness.context.openSavedLoopCreation('loop-1');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].ownerId, 'saved-loop-loop-1');

  harness.editor._loopRangeController.interact('end');
  harness.editor._loopRangeController.preview({ startSeconds: 2, endSeconds: 10 });
  harness.editor._loopRangeController.commit({ startSeconds: 2, endSeconds: 10 });
  assert.deepEqual(renewals, ['saved-loop-loop-1', 'saved-loop-loop-1']);

  harness.audio.paused = false;
  harness.context.cancelSavedLoopCreation('loop-1');
  assert.deepEqual(stops, ['saved-loop-loop-1']);
  assert.equal(harness.audio.pauseCalls, 0);
});

test('saved-loop automatic expiry exits only its editor and pauses its playing audio', async () => {
  let expire;
  const harness = createSavedLoopEditorHarness({
    loopEditSessionExpiryController: {
      start: ({ onExpire }) => { expire = onExpire; },
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: () => false,
      stop: () => true,
    },
  });

  await harness.context.openSavedLoopCreation('loop-1');
  harness.audio.paused = false;
  assert.equal(typeof expire, 'function');

  expire();

  assert.equal(harness.context.state.utility.loopEditors['loop-1'].active, false);
  assert.equal(harness.editor.hidden, true);
  assert.equal(harness.audio.pauseCalls, 1);
});

test('saved-loop playback reports a whole-range wrap without treating forward progress as a wrap', async () => {
  const wraps = [];
  const harness = createSavedLoopEditorHarness({
    loopEditSessionExpiryController: {
      start: () => {},
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: (ownerId) => wraps.push(ownerId),
      stop: () => false,
    },
  });
  await harness.context.openSavedLoopCreation('loop-1');
  harness.context.initializeUtilityLoopPlayer({ id: 'loop-1' });
  harness.audio.paused = false;

  harness.audio.currentTime = 6;
  harness.audio.dispatch('timeupdate');
  harness.audio.currentTime = 11.8;
  harness.audio.dispatch('timeupdate');
  harness.audio.currentTime = 0.1;
  harness.audio.dispatch('timeupdate');

  assert.deepEqual(wraps, ['saved-loop-loop-1']);
});

test('selected saved-loop repeat restarts from zero when short media reaches its ended event', async () => {
  const wraps = [];
  const harness = createSavedLoopEditorHarness({
    loopEditSessionExpiryController: {
      start: () => {},
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: (ownerId) => wraps.push(ownerId),
      stop: () => false,
    },
  });
  harness.context.state.utility.loopRepeatEnabled = true;
  await harness.context.openSavedLoopCreation('loop-1');
  harness.context.initializeUtilityLoopPlayer({ id: 'loop-1' });
  harness.audio.currentTime = harness.audio.duration;
  harness.audio.paused = true;
  harness.audio.ended = true;

  harness.audio.dispatch('ended');
  await Promise.resolve();

  assert.equal(harness.audio.loop, false);
  assert.equal(harness.audio.currentTime, 0);
  assert.equal(harness.audio.paused, false);
  assert.equal(harness.audio.playCalls, 1);
  assert.deepEqual(wraps, ['saved-loop-loop-1']);
});

test('saved-loop playback reports a coarse native repeat wrap that skips the end threshold', async () => {
  const wraps = [];
  const harness = createSavedLoopEditorHarness({
    loopEditSessionExpiryController: {
      start: () => {},
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: (ownerId) => wraps.push(ownerId),
      stop: () => false,
    },
  });
  await harness.context.openSavedLoopCreation('loop-1');
  harness.context.initializeUtilityLoopPlayer({ id: 'loop-1' });
  harness.audio.paused = false;
  harness.audio.loop = true;

  harness.audio.currentTime = 8.5;
  harness.audio.dispatch('timeupdate');
  harness.audio.seeking = true;
  harness.audio.currentTime = 0.8;
  harness.audio.dispatch('timeupdate');

  assert.deepEqual(wraps, ['saved-loop-loop-1']);
});

test('saved-loop playback does not treat a backward seek as a native repeat wrap', async () => {
  const wraps = [];
  const harness = createSavedLoopEditorHarness({
    loopEditSessionExpiryController: {
      start: () => {},
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: (ownerId) => wraps.push(ownerId),
      stop: () => false,
    },
  });
  await harness.context.openSavedLoopCreation('loop-1');
  harness.context.initializeUtilityLoopPlayer({ id: 'loop-1' });
  harness.audio.paused = false;
  harness.audio.loop = true;

  harness.audio.currentTime = 8.5;
  harness.audio.dispatch('timeupdate');
  harness.context.seekUtilityLoopPlayback('loop-1', -7.7);
  harness.audio.dispatch('timeupdate');

  assert.deepEqual(wraps, []);
});

test('saved-loop shared range state normalizes crossed values into a bounded positive interval', () => {
  const harness = createSavedLoopEditorHarness({ hidden: false, start: '0:02.000', end: '0:10.000' });

  assert.equal(typeof harness.context.syncSavedLoopRange, 'function');
  const range = harness.context.syncSavedLoopRange('loop-1', { startSeconds: 15, endSeconds: -2 });
  assert.equal(range.startSeconds, 0);
  assert.equal(range.endSeconds, 12);
  assert.ok(range.startSeconds < range.endSeconds);
});

test('second activation names and posts the validated editor range with source_loop_id', async () => {
  const openingLoop = {
    id: 'loop-1', name: 'Opening phrase', artist: 'Artist', title: 'Song', album: 'Album', duration_seconds: 12,
  };
  const secondLoop = {
    id: 'loop-2', name: 'Second phrase', artist: 'Artist', title: 'Song', album: 'Album', duration_seconds: 6.5,
  };
  const responseLoops = [secondLoop, openingLoop];
  const harness = createSavedLoopEditorHarness({
    hidden: false,
    start: '0:02.250',
    end: '0:08.750',
    createdLoop: secondLoop,
    responseLoops,
  });

  await harness.context.createLoopFromSavedLoop('loop-1');

  assert.deepEqual(harness.dialogCalls, ['open']);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].url, '/loops/create');
  assert.equal(harness.fetchCalls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(harness.fetchCalls[0].init.body), {
    name: 'Second phrase',
    source_loop_id: 'loop-1',
    start_seconds: 2.25,
    end_seconds: 8.75,
  });
  assert.deepEqual(
    Array.from(harness.context.state.utility.loops, (loop) => loop.id),
    ['loop-2', 'loop-1'],
    'the server response order is retained',
  );
  assert.equal(harness.context.state.utility.selectedLoopId, 'loop-2');
  assert.equal(harness.context.state.utility.selectedLoopGroupKey, 'artist::song::album');
  assert.equal(harness.context.state.utility.selectedLoopDetailMode, 'group');
  assert.deepEqual(harness.renderCalls, [{
    loopIds: ['loop-2', 'loop-1'],
    selectedLoopId: 'loop-2',
    selectedLoopGroupKey: 'artist::song::album',
    selectedLoopDetailMode: 'group',
  }], 'the complete selected group is established before the single render');
});

test('rapid saved-loop creation activations share one pending save and POST once', async () => {
  let resolveDialog;
  const dialogPromise = new Promise((resolve) => {
    resolveDialog = resolve;
  });
  const harness = createSavedLoopEditorHarness({
    hidden: false,
    start: '0:02.250',
    end: '0:08.750',
    dialogPromise,
  });

  const firstSave = harness.context.createLoopFromSavedLoop('loop-1');
  const duplicateSave = harness.context.createLoopFromSavedLoop('loop-1');
  await Promise.resolve();

  assert.deepEqual(harness.dialogCalls, ['open']);
  assert.deepEqual(harness.fetchCalls, []);

  resolveDialog('Second phrase');
  await Promise.all([firstSave, duplicateSave]);

  assert.equal(harness.fetchCalls.length, 1);
});

test('blank name and invalid saved-loop editor ranges never POST', async () => {
  const cancelled = createSavedLoopEditorHarness({ hidden: false, dialogResult: null });
  await cancelled.context.createLoopFromSavedLoop('loop-1');
  assert.deepEqual(cancelled.dialogCalls, ['open']);
  assert.deepEqual(cancelled.fetchCalls, []);

  const blankName = createSavedLoopEditorHarness({ hidden: false, dialogResult: '   ' });
  await blankName.context.createLoopFromSavedLoop('loop-1');
  assert.deepEqual(blankName.dialogCalls, ['open']);
  assert.deepEqual(blankName.fetchCalls, []);

  const invalidRange = createSavedLoopEditorHarness({ hidden: false, start: '0:09.000', end: '0:03.000' });
  await invalidRange.context.createLoopFromSavedLoop('loop-1');
  assert.deepEqual(invalidRange.dialogCalls, []);
  assert.deepEqual(invalidRange.fetchCalls, []);
});

test('saved-loop integration mounts shared action and range controllers without a detached editor', () => {
  assert.match(helperSource, /mountLoopEditActionControl\s*\(/);
  assert.match(helperSource, /createLoopRangeController\s*\(/);
  assert.match(helperSource, /drawCombinedLoopWaveform\s*\(/);
  assert.match(helperSource, /loadSavedLoopWaveformPeaks\s*\(/);
  assert.doesNotMatch(helperSource, /ensureWaveformDataForSrc/);
  assert.doesNotMatch(helperSource, /getSavedLoopEditorElements|dragSavedLoopEditorHandle/);
  assert.doesNotMatch(helperSource, /data-create-loop-from-saved|data-saved-loop-editor/);
  assert.match(helperSource, /mountLoopEditActionControl\s*\(\s*\{[^]*enabled:\s*true/);
});

test('saved-loop create and cancel preserve one audio node and one pending POST', () => {
  assert.match(helperSource, /onEnter\s*:/);
  assert.match(helperSource, /onCreate\s*:/);
  assert.match(helperSource, /onCancel\s*:/);
  assert.match(helperSource, /Escape|onCancel/);
  assert.match(helperSource, /savedLoopEditorBusy/);
  assert.match(helperSource, /if\s*\([^)]*savedLoopEditorBusy[^)]*\)\s*return/);
  assert.doesNotMatch(
    helperSource,
    /on(?:Enter|Cancel)[^]*?\.remove\s*\(\)|on(?:Enter|Cancel)[^]*?replaceWith\s*\(/,
    'enter and cancel must retain the existing audio element',
  );
});

test('saved-loop success applies returned order and selects the complete group before rendering', () => {
  const createStart = helperSource.indexOf('async function createLoopFromSavedLoop');
  const createEnd = helperSource.indexOf('async function deleteSavedLoop', createStart);
  const createSource = helperSource.slice(createStart, createEnd);
  const responseAssignment = createSource.indexOf('state.utility.loops = Array.isArray(data.loops)');
  const selectionAssignment = createSource.indexOf('state.utility.selectedLoopId', responseAssignment);
  const groupAssignment = createSource.indexOf('state.utility.selectedLoopGroupKey', selectionAssignment);
  const detailModeAssignment = createSource.indexOf(
    "state.utility.selectedLoopDetailMode = 'group'",
    groupAssignment,
  );
  const renderAfterSelection = Math.min(
    ...['renderUtilityLoopList', 'renderUtilityModalContent']
      .map((token) => createSource.indexOf(token, detailModeAssignment))
      .filter((index) => index >= 0),
  );
  assert.ok(createStart >= 0 && createEnd > createStart, 'the saved-loop creation source is inspectable');
  assert.ok(responseAssignment >= 0, 'the ordered response collection replaces stale loop state');
  assert.ok(selectionAssignment > responseAssignment, 'the returned loop is selected after applying its collection');
  assert.ok(groupAssignment > selectionAssignment, 'the returned loop group is selected too');
  assert.ok(detailModeAssignment > groupAssignment, 'successful creation restores the complete media group');
  assert.ok(renderAfterSelection > detailModeAssignment, 'sidebar or detail refresh happens immediately after selection');
});

test('saved-loop deletion awaits the app-owned confirmation dialog instead of browser confirm', () => {
  const deleteStart = helperSource.indexOf('async function deleteSavedLoop');
  const deleteEnd = helperSource.indexOf('function buildReorderedUtilityLoops', deleteStart);
  const deleteSource = helperSource.slice(deleteStart, deleteEnd);
  assert.ok(deleteStart >= 0 && deleteEnd > deleteStart, 'the saved-loop deletion source is inspectable');
  assert.match(deleteSource, /await\s+showLoopDeleteConfirmDialog\s*\(/);
  assert.doesNotMatch(deleteSource, /showBrowserConfirm\s*\(/);
});

test('failed saved-loop deletion keeps the active editor expiry session running', async () => {
  const stops = [];
  const harness = createSavedLoopEditorHarness({
    hidden: false,
    deleteResponse: {
      ok: false,
      json: async () => ({ ok: false, error: 'Delete unavailable' }),
    },
    loopEditSessionExpiryController: {
      start: () => {},
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: () => false,
      stop: (ownerId) => stops.push(ownerId),
    },
  });

  await harness.context.deleteSavedLoop('loop-1');

  assert.deepEqual(stops, []);
  assert.equal(harness.context.state.utility.loopEditors['loop-1'].active, true);
  assert.equal(harness.editor.hidden, false);
});

test('successful saved-loop deletion stops the editor expiry once after confirmation', async () => {
  const stops = [];
  let confirmDeletion;
  const confirmedDeletion = new Promise((resolve) => {
    confirmDeletion = resolve;
  });
  const harness = createSavedLoopEditorHarness({
    hidden: false,
    deleteResponse: {
      ok: true,
      json: async () => confirmedDeletion,
    },
    loopEditSessionExpiryController: {
      start: () => {},
      renewAfterBoundaryEdit: () => false,
      noteUntouchedWholeRangeWrap: () => false,
      stop: (ownerId) => stops.push(ownerId),
    },
  });

  const deletion = harness.context.deleteSavedLoop('loop-1');
  await Promise.resolve();
  assert.deepEqual(stops, []);

  confirmDeletion({ ok: true, loops: [] });
  await deletion;

  assert.deepEqual(stops, ['saved-loop-loop-1']);
});
