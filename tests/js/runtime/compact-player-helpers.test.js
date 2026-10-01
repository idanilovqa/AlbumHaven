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
  'compact-player-helpers.js',
);
const templatePath = path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html');
const playbackControlMacroPath = path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'partials', 'playback-control-cluster.html');
const stylePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'non-album-and-player.css');
const appChromeStylePath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'app-chrome.css');
const controllerPath = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'compact-player-controller.js');

function loadHelper() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.existsSync(helperPath) ? fs.readFileSync(helperPath, 'utf8') : '', context, {
    filename: helperPath,
  });
  return context;
}

const plain = value => JSON.parse(JSON.stringify(value));

function loadQueueController(t, initialIndex = 0) {
  const tracks = ['A', 'B', 'C', 'D'].map(name => ({ path: `${name}.flac`, src: `/track/${name}` }));
  const starts = [];
  const results = [];
  const errors = [];
  const controls = {
    player: {
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      dataset: {},
      style: { setProperty() {} },
    },
    previous: {},
    next: {},
  };
  const context = {
    window: { setTimeout, clearTimeout },
    state: { player: { current: tracks[initialIndex], playbackQueue: { tracks, currentIndex: initialIndex } } },
    canStartPlaybackInThisTab: () => true,
    startStreamingTrack: track => new Promise((resolve, reject) => starts.push({ track, resolve, reject })),
    observeStreamingFacadeCallback: result => result.catch(error => errors.push(error)),
  };
  context.getPlayerPlaybackSnapshot = () => ({ src: context.state.player.current?.src, paused: false });
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(helperPath, 'utf8'), context, { filename: helperPath });
  const playbackPath = path.join(path.dirname(controllerPath), 'player-loop-playback.js');
  vm.runInContext(fs.readFileSync(playbackPath, 'utf8'), context, { filename: playbackPath });
  vm.runInContext(fs.readFileSync(controllerPath, 'utf8'), context, { filename: controllerPath });
  context.setCurrentPlayerTrack = track => { context.state.player.current = track; };
  context.compactPlayerElements = () => controls;
  context.updatePlayerUi = () => context.syncCompactPlayerUi();
  const playTrack = context.playTrackFromPayload;
  context.playTrackFromPayload = (...args) => {
    const result = playTrack(...args);
    results.push(result);
    // Keep expected RED rejections owned by this harness; production reporting is asserted separately.
    result.catch(() => {});
    return result;
  };
  const settle = async (index, error) => {
    if (error) starts[index].reject(error);
    else starts[index].resolve({ track: starts[index].track });
    await new Promise(resolve => setImmediate(resolve));
  };
  t.after(async () => {
    starts.forEach(start => start.resolve({ track: start.track }));
    await Promise.allSettled(results);
    await new Promise(resolve => setImmediate(resolve));
  });
  return { context, tracks, starts, controls, errors, settle };
}

for (const savedMode of [null, 'expanded', 'compact']) {
  test(`desktop return restores compact-player controls with ${savedMode || 'absent'} saved mode`, t => {
    const { context, controls } = loadQueueController(t);
    const events = new Map();
    const element = () => ({ dataset: {}, hidden: false, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, setAttribute() {}, addEventListener() {}, querySelector() { return null; } });
    Object.assign(controls, { player: element(), expanded: element(), compact: element(), collapse: element(), expand: element() });
    controls.previous.addEventListener = () => {};
    controls.next.addEventListener = () => {};
    const writes = [];
    context.document = { documentElement: { ...element(), getAttribute: () => 'docked' }, getElementById: () => null };
    context.window = { setTimeout, clearTimeout, innerWidth: 600, innerHeight: 800, localStorage: { getItem: () => savedMode, setItem: (...args) => writes.push(args) }, addEventListener: (name, callback) => events.set(name, callback) };
    context.initCompactPlayer();
    assert.equal(controls.collapse.hidden, true);
    context.window.innerWidth = 1200;
    events.get('resize')();
    assert.equal(controls.collapse.hidden, false);
    assert.equal(controls.expand.hidden, true, "docked presentation has no expand chevron");
    assert.equal(controls.expanded.inert, savedMode === 'compact');
    assert.deepEqual(writes, [], 'responsive changes do not overwrite the saved preference');
  });
}

for (const [name, initialIndex, offsets, expected] of [
  ['next', 0, [1, 1], ['B.flac', 'C.flac']],
  ['previous', 3, [-1, -1], ['C.flac', 'B.flac']],
  ['mixed', 1, [1, -1, 1, 1], ['C.flac', 'B.flac', 'C.flac', 'D.flac']],
]) {
  test(`compact pending ${name} navigation advances before streaming startup completes`, async t => {
    const { context, starts, tracks, settle } = loadQueueController(t, initialIndex);
    offsets.forEach(offset => context.playCompactQueueOffset(offset));
    assert.deepEqual(starts.map(start => start.track.path), expected);
    assert.equal(context.state.player.current, tracks[initialIndex]);
    await settle(starts.length - 1);
    assert.equal(context.state.player.current.path, expected.at(-1));
    assert.equal(context.currentQueueIndex(), tracks.findIndex(track => track.path === expected.at(-1)));
  });
}

test('compact pending navigation refreshes button bounds and cannot step past the queue', t => {
  const { context, starts, controls } = loadQueueController(t);
  [-1, 1, 1, 1, 1].forEach(offset => context.playCompactQueueOffset(offset));
  assert.deepEqual(starts.map(start => start.track.path), ['B.flac', 'C.flac', 'D.flac']);
  assert.equal(controls.next.disabled, true);
  assert.equal(controls.previous.disabled, false);
});

for (const outcome of ['success', 'rejection']) {
  test(`compact older ${outcome} cannot clear a newer pending selection`, async t => {
    const { context, starts, controls, errors, settle } = loadQueueController(t);
    context.playCompactQueueOffset(1);
    context.playCompactQueueOffset(1);
    await settle(0, outcome === 'rejection' ? new Error('older startup failed') : null);
    assert.equal(context.currentQueueIndex(), 2);
    context.playCompactQueueOffset(1);
    assert.deepEqual(starts.map(start => start.track.path), ['B.flac', 'C.flac', 'D.flac']);
    assert.equal(controls.next.disabled, true);
    assert.deepEqual(errors, []);
  });
}

for (const outcome of ['false', 'rejection']) {
  test(`compact latest ${outcome} restores the playing cursor and controls`, async t => {
    const { context, starts, controls, errors, settle } = loadQueueController(t);
    if (outcome === 'false') context.canStartPlaybackInThisTab = () => false;
    context.playCompactQueueOffset(1);
    if (outcome === 'rejection') await settle(0, new Error('startup failed'));
    else await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.state.player.playbackQueue.currentIndex, 0);
    assert.equal(context.currentQueueIndex(), 0);
    assert.equal(controls.previous.disabled, true);
    assert.equal(controls.next.disabled, false);
    assert.equal(errors.length, outcome === 'rejection' ? 1 : 0);
    context.canStartPlaybackInThisTab = () => true;
    context.playCompactQueueOffset(1);
    assert.equal(starts.at(-1).track.path, 'B.flac');
  });
}

test('compact latest failure followed by older completion cannot restore the abandoned selection', async t => {
  const { context, starts, settle } = loadQueueController(t);
  context.playCompactQueueOffset(1);
  context.playCompactQueueOffset(1);
  await settle(1, new Error('newer startup failed'));
  await settle(0);
  assert.equal(context.state.player.current.path, 'A.flac');
  assert.equal(context.state.player.playbackQueue.currentIndex, 0);
  context.playCompactQueueOffset(1);
  assert.equal(starts.at(-1).track.path, 'B.flac');
});

test('compact pending navigation preserves cursor through queue metadata refresh', t => {
  const { context, starts } = loadQueueController(t);
  context.playCompactQueueOffset(1);
  context.state.player.playbackQueue.tracks = context.state.player.playbackQueue.tracks.map(track => ({ ...track, artist: 'Updated' }));
  context.playCompactQueueOffset(1);
  assert.deepEqual(starts.map(start => start.track.path), ['B.flac', 'C.flac']);
});

for (const replacement of ['queue', 'tracks', 'index', 'clear']) {
  test(`compact pending navigation discards its cursor after ${replacement} replacement`, async t => {
    const { context, tracks, starts, settle } = loadQueueController(t);
    context.playCompactQueueOffset(1);
    const originalQueue = context.state.player.playbackQueue;
    if (replacement === 'queue') context.state.player.playbackQueue = { tracks: [tracks[3], tracks[0], tracks[2]], currentIndex: 0 };
    if (replacement === 'tracks') originalQueue.tracks = [tracks[3], tracks[0], tracks[2]];
    if (replacement === 'index') {
      originalQueue.currentIndex = 3;
      context.state.player.current = tracks[2];
    }
    if (replacement === 'clear') context.state.player.playbackQueue = null;
    const replacementQueue = context.state.player.playbackQueue;
    const expectedIndex = replacement === 'clear' ? -1 : replacement === 'index' ? 2 : 1;
    assert.equal(context.currentQueueIndex(), expectedIndex);
    context.playCompactQueueOffset(1);
    assert.equal(starts.length, replacement === 'clear' ? 1 : 2);
    if (replacement !== 'clear') {
      assert.equal(starts[1].track.path, replacement === 'index' ? 'D.flac' : 'C.flac');
      await settle(1);
    }
    await settle(0, new Error('superseded compact startup failed'));
    assert.equal(context.state.player.playbackQueue, replacementQueue);
    if (replacementQueue) assert.equal(replacementQueue.currentIndex, replacement === 'index' ? 3 : 2);
  });
}

test('compact player is eligible only above the desktop shell breakpoint', () => {
  const helper = loadHelper();

  assert.equal(helper.isCompactPlayerEligible({ viewportWidth: 901, desktopBreakpoint: 900 }), true);
  assert.equal(helper.isCompactPlayerEligible({ viewportWidth: 900, desktopBreakpoint: 900 }), false);
  assert.equal(helper.isCompactPlayerEligible({ viewportWidth: 430, desktopBreakpoint: 900 }), false);
});

test('mobile ignores a persisted compact mode and desktop restores it', () => {
  const helper = loadHelper();

  assert.equal(helper.resolveCompactPlayerMode({ eligible: true, persistedMode: 'compact' }), 'compact');
  assert.equal(helper.resolveCompactPlayerMode({ eligible: false, persistedMode: 'compact' }), 'expanded');
  assert.equal(helper.resolveCompactPlayerMode({ eligible: true, persistedMode: 'unknown' }), 'expanded');
});

test('compact mode persistence writes only canonical presentation modes', () => {
  const helper = loadHelper();
  const writes = [];
  const storage = { setItem: (key, value) => writes.push([key, value]) };

  assert.equal(helper.persistCompactPlayerMode(storage, 'compact'), true);
  assert.equal(helper.persistCompactPlayerMode(storage, 'expanded'), true);
  assert.equal(helper.persistCompactPlayerMode(storage, 'floating'), false);
  assert.deepEqual(writes, [
    ['albumhaven.compactPlayer.mode.v1', 'compact'],
    ['albumhaven.compactPlayer.mode.v1', 'expanded'],
  ]);
});

test('docked is the default compact style and invalid stored values normalize safely', () => {
  const helper = loadHelper();

  assert.equal(helper.normalizeCompactPlayerStyle(), 'docked');
  assert.equal(helper.normalizeCompactPlayerStyle('docked'), 'docked');
  assert.equal(helper.normalizeCompactPlayerStyle('floating'), 'floating');
  assert.equal(helper.normalizeCompactPlayerStyle('bottom-left'), 'docked');
});

test('docked compact behavior follows the folded artist tree by default and accepts stay docked', () => {
  const helper = loadHelper();

  assert.equal(helper.normalizeDockedCompactPlayerBehavior(), 'follow_sidebar');
  assert.equal(helper.normalizeDockedCompactPlayerBehavior('follow_sidebar'), 'follow_sidebar');
  assert.equal(helper.normalizeDockedCompactPlayerBehavior('stay_docked'), 'stay_docked');
  assert.equal(helper.normalizeDockedCompactPlayerBehavior('unknown'), 'follow_sidebar');
  assert.equal(helper.useCompactPlayerRailMode({
    style: 'docked', behavior: 'follow_sidebar', artistTreeFolded: true,
  }), true);
  assert.equal(helper.useCompactPlayerRailMode({
    style: 'docked', behavior: 'stay_docked', artistTreeFolded: true,
  }), false);
  assert.equal(helper.useCompactPlayerRailMode({
    style: 'floating', behavior: 'follow_sidebar', artistTreeFolded: true,
  }), false);
  assert.equal(helper.useCompactPlayerRailMode({
    style: 'docked', behavior: 'follow_sidebar', artistTreeFolded: false,
  }), false);
});

test('compact controller reduces a folded follow-sidebar player to the rail controls', () => {
  const classes = value => ({
    values: new Set(value ? [value] : []),
    toggle(name, enabled) { if (enabled) this.values.add(name); else this.values.delete(name); },
    add(name) { this.values.add(name); },
    remove(name) { this.values.delete(name); },
    contains(name) { return this.values.has(name); },
  });
  const element = () => ({
    hidden: false, inert: false, classList: classes(), dataset: {},
    style: { setProperty() {} }, setAttribute() {}, querySelector() { return null; },
  });
  const player = element(), expanded = element(), compact = element(), root = element();
  const collapse = element(), expand = element(), shell = element(), tree = element();
  shell.classList.add('is-artist-tree-folded');
  tree.getBoundingClientRect = () => ({ left: 0, width: 56 });
  let behavior = 'follow_sidebar';
  root.getAttribute = name => name === 'data-compact-player-style' ? 'docked'
    : name === 'data-docked-compact-player-behavior' ? behavior : null;
  const context = loadHelper();
  Object.assign(context, {
    state: { player: { current: null, playbackQueue: null } },
    getPlayerPlaybackSnapshot: () => ({ paused: true, src: '' }),
    document: {
      documentElement: root, activeElement: null,
      getElementById: id => id === 'app-shell' ? shell : id === 'shell-navigation-rail' ? tree : null,
    },
    window: { setTimeout, clearTimeout, innerWidth: 1200, innerHeight: 800, localStorage: {}, addEventListener() {} },
  });
  vm.runInContext(fs.readFileSync(controllerPath, 'utf8'), context, { filename: controllerPath });
  context.compactPlayerElements = () => ({ player, expanded, compact, collapse, expand });

  context.applyCompactPlayerMode('compact', { persist: false });
  assert.equal(player.classList.contains('is-rail-compact'), true);
  assert.equal(root.classList.contains('has-follow-sidebar-compact-player'), true);

  behavior = 'stay_docked';
  context.applyCompactPlayerMode('compact', { persist: false });
  assert.equal(player.classList.contains('is-rail-compact'), false);
  assert.equal(root.classList.contains('has-follow-sidebar-compact-player'), false);
});

test('floating pointer movement becomes a drag only after crossing the threshold', () => {
  const helper = loadHelper();

  assert.equal(helper.didCompactPlayerDrag({ startX: 20, startY: 20, currentX: 23, currentY: 24, threshold: 6 }), false);
  assert.equal(helper.didCompactPlayerDrag({ startX: 20, startY: 20, currentX: 26, currentY: 20, threshold: 6 }), true);
  assert.equal(helper.didCompactPlayerDrag({ startX: 20, startY: 20, currentX: 25, currentY: 24, threshold: 6 }), true);
});

test('floating position is clamped inside the visible viewport with its safety margin', () => {
  const helper = loadHelper();

  assert.deepEqual(
    plain(helper.clampCompactPlayerPosition({
      x: 900,
      y: -20,
      playerWidth: 96,
      playerHeight: 96,
      viewportWidth: 1000,
      viewportHeight: 700,
      margin: 12,
    })),
    { x: 892, y: 12 },
  );
  assert.deepEqual(
    plain(helper.clampCompactPlayerPosition({
      x: 40,
      y: 500,
      playerWidth: 96,
      playerHeight: 96,
      viewportWidth: 1000,
      viewportHeight: 700,
      margin: 12,
    })),
    { x: 40, y: 500 },
  );
  assert.deepEqual(
    plain(helper.clampCompactPlayerPosition({
      x: 0,
      y: 600,
      playerWidth: 96,
      playerHeight: 96,
      viewportWidth: 1200,
      viewportHeight: 700,
      margin: 4,
      leftMargin: 12,
    })),
    { x: 12, y: 600 },
  );
});

test('each visit creates a fresh floating default at the practical lower-left viewport corner', () => {
  const helper = loadHelper();
  const options = {
    treeRect: { left: 0, top: 64, width: 280, height: 636 },
    playerWidth: 96,
    playerHeight: 96,
    viewportWidth: 1200,
    viewportHeight: 700,
    margin: 4,
    leftMargin: 12,
  };

  const first = helper.createCompactPlayerSessionPosition(options);
  first.x = 700;
  first.y = 100;
  const nextVisit = helper.createCompactPlayerSessionPosition(options);

  assert.deepEqual(plain(nextVisit), { x: 12, y: 600 });
});

test('floating default uses the viewport bottom while the navigation rail is still resizing', () => {
  const helper = loadHelper();

  assert.deepEqual(plain(helper.createCompactPlayerSessionPosition({
    treeRect: { left: 0, top: 64, width: 280, height: 500 },
    playerWidth: 96,
    playerHeight: 96,
    viewportWidth: 1200,
    viewportHeight: 700,
    margin: 4,
    leftMargin: 12,
  })), { x: 12, y: 600 });
});

test('floating controller keeps the player within the practical viewport edge', () => {
  const controller = fs.readFileSync(controllerPath, 'utf8');

  assert.match(controller, /const FLOATING_COMPACT_PLAYER_MARGIN = 8/);
  assert.match(controller, /const FLOATING_COMPACT_PLAYER_LEFT_MARGIN = 12/);
  assert.equal((controller.match(/margin: FLOATING_COMPACT_PLAYER_MARGIN/g) || []).length, 5);
  assert.equal((controller.match(/leftMargin: FLOATING_COMPACT_PLAYER_LEFT_MARGIN/g) || []).length, 4);
});

test('docked queue controls disable previous and next at their respective boundaries', () => {
  const helper = loadHelper();

  assert.deepEqual(plain(helper.resolveCompactQueueControls({ queueLength: 3, currentIndex: 0 })), {
    previousDisabled: true,
    nextDisabled: false,
  });
  assert.deepEqual(plain(helper.resolveCompactQueueControls({ queueLength: 3, currentIndex: 1 })), {
    previousDisabled: false,
    nextDisabled: false,
  });
  assert.deepEqual(plain(helper.resolveCompactQueueControls({ queueLength: 3, currentIndex: 2 })), {
    previousDisabled: false,
    nextDisabled: true,
  });
  assert.deepEqual(plain(helper.resolveCompactQueueControls({ queueLength: 0, currentIndex: -1 })), {
    previousDisabled: true,
    nextDisabled: true,
  });
});

test('docked player geometry follows the rendered artist-tree panel', () => {
  const helper = loadHelper();

  assert.deepEqual(plain(helper.resolveDockedCompactGeometry({ left: 8, width: 264 })), {
    left: 8,
    width: 264,
  });
});

test('docked geometry preserves its last visible left edge while Settings hides the library rail', () => {
  const context = loadHelper();
  const properties = new Map();
  let rect = { left: 8, width: 264 };
  context.document = { getElementById: () => ({ getBoundingClientRect: () => rect }) };
  vm.runInContext(fs.readFileSync(controllerPath, 'utf8'), context, { filename: controllerPath });
  context.compactPlayerElements = () => ({ player: { style: { setProperty: (key, value) => properties.set(key, value) } } });
  context.syncDockedCompactGeometry();
  rect = { left: 0, width: 0 };
  context.syncDockedCompactGeometry();
  assert.equal(properties.get('--compact-docked-left'), '8px');
  rect = { left: 12, width: 290 };
  context.syncDockedCompactGeometry();
  assert.equal(properties.get('--compact-docked-left'), '12px');
});

test('floating album details require a pointer double-click while keyboard and docked activation stay direct', () => {
  const helper = loadHelper();

  assert.equal(helper.shouldOpenCompactPlayerAlbum({ style: 'floating', eventType: 'click', detail: 1 }), false);
  assert.equal(helper.shouldOpenCompactPlayerAlbum({ style: 'floating', eventType: 'dblclick', detail: 2 }), true);
  assert.equal(helper.shouldOpenCompactPlayerAlbum({ style: 'floating', eventType: 'click', detail: 0 }), true);
  assert.equal(helper.shouldOpenCompactPlayerAlbum({ style: 'docked', eventType: 'click', detail: 1 }), true);
  assert.equal(helper.shouldOpenCompactPlayerAlbum({ style: 'docked', eventType: 'dblclick', detail: 2 }), false);
});

test('compact cover keeps its accessible label without a native hover tooltip', () => {
  const controller = fs.readFileSync(controllerPath, 'utf8');
  assert.match(controller, /els\.cover\.setAttribute\('aria-label', openLabel\)/);
  assert.doesNotMatch(controller, /els\.cover\.title\s*=\s*openLabel/);
});

test('compact player keeps stable cover, metadata, and shared playback controls', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const compact = template.match(/<div class="compact-player-shell"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  const component = fs.readFileSync(playbackControlMacroPath, 'utf8');
  for (const name of ['data-compact-player-cover', 'data-compact-player-title', 'data-compact-player-artist',
    'data-compact-player-title-text', 'data-compact-player-artist-text',
    'data-compact-player-hover-bubble', 'data-compact-player-summary']) assert.ok(compact.includes(name));
  assert.ok(compact.includes("playback_control_cluster('compact-player')"));
  assert.match(component, /data-compact-player-play[^>]*aria-label="Play"/);
  assert.doesNotMatch(compact, /waveform|seekbar/);
});

test('rail metadata bubble retains pointer interaction and opens Album Details from its album name', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const controller = fs.readFileSync(controllerPath, 'utf8');
  const css = fs.readFileSync(stylePath, 'utf8');

  assert.match(template, /data-compact-player-hover-bubble[^>]*aria-hidden="true"[^>]*inert/);
  assert.match(template, /data-compact-player-hover-bubble[^]*?<button[^>]*class="player-album-link compact-player-hover-album"[^>]*data-compact-player-album/);
  assert.match(controller, /albumLink:\s*compact\?\.querySelector\('\[data-compact-player-album\]'\)/);
  assert.match(controller, /els\.hoverBubble\.inert = true/);
  assert.match(controller, /els\.hoverBubble\.inert = false/);
  assert.match(controller, /els\.albumLink\?\.addEventListener\('click',\s*openCurrentAlbumDetails\)/);
  assert.match(css, /\.global-player\.is-compact-metadata-visible \.compact-player-hover-bubble\s*\{[^}]*pointer-events:\s*auto;/s);
});

test('sidebar presentation preserves always-floating and stay-docked compatibility', () => {
  const h = loadHelper();
  assert.equal(typeof h.resolveCompactPlayerPresentation, 'function');
  for (const style of ['docked', 'floating']) {
    for (const behavior of ['follow_sidebar', 'float_on_collapse', 'artbox', 'stay_docked']) {
      for (const artistTreeFolded of [false, true]) {
        const input = { eligible: true, mode: 'compact', style, behavior, artistTreeFolded };
        const expected = style === 'floating' ? 'floating'
          : !artistTreeFolded || behavior === 'stay_docked' ? 'docked'
          : { follow_sidebar: 'rail_play', float_on_collapse: 'floating', artbox: 'rail_artbox' }[behavior];
        assert.equal(h.resolveCompactPlayerPresentation(input), expected, JSON.stringify(input));
        assert.equal(h.resolveCompactPlayerPresentation({ ...input, eligible: false }), 'expanded');
        assert.equal(h.resolveCompactPlayerPresentation({ ...input, mode: 'expanded' }), 'expanded');
      }
    }
  }
  assert.equal(h.resolveCompactPlayerPresentation({
    eligible: true, mode: 'compact', style: 'invalid', behavior: 'invalid', artistTreeFolded: true,
  }), 'rail_play');
});

test('background overlays detach only sidebar-integrated compact presentations', () => {
  const h = loadHelper();
  for (const presentation of ['docked', 'rail_play', 'rail_artbox']) {
    assert.equal(h.shouldDetachCompactPlayerForOverlay({ presentation, overlayActive: true }), true);
    assert.equal(h.shouldDetachCompactPlayerForOverlay({ presentation, overlayActive: false }), false);
  }
  for (const presentation of ['expanded', 'floating', undefined]) {
    assert.equal(h.shouldDetachCompactPlayerForOverlay({ presentation, overlayActive: true }), false);
  }
});

test('stay-docked drag is available only while the Artist Tree is collapsed', () => {
  const h = loadHelper();
  assert.equal(h.canDragStayDockedCompactPlayer({
    presentation: 'docked', behavior: 'stay_docked', artistTreeFolded: true,
  }), true);
  for (const options of [
    { presentation: 'docked', behavior: 'stay_docked', artistTreeFolded: false },
    { presentation: 'docked', behavior: 'follow_sidebar', artistTreeFolded: true },
    { presentation: 'floating', behavior: 'stay_docked', artistTreeFolded: true },
  ]) assert.equal(h.canDragStayDockedCompactPlayer(options), false);
});

test('sidebar motion uses approved timing and reduced motion overrides slow', () => {
  const h = loadHelper();
  assert.equal(typeof h.resolveCompactPlayerMotion, 'function');
  assert.deepEqual(plain(h.resolveCompactPlayerMotion()), { durationMs: 420, hoverDurationMs: 300 });
  assert.deepEqual(plain(h.resolveCompactPlayerMotion({ speed: 'slow' })), { durationMs: 1400, hoverDurationMs: 300 });
  for (const speed of ['normal', 'slow']) {
    assert.deepEqual(plain(h.resolveCompactPlayerMotion({ speed, reducedMotion: true })), {
      durationMs: 1, hoverDurationMs: 1,
    });
  }
});

test('rail metadata waits for artwork motion plus the approved hover delay', () => {
  const h = loadHelper();
  assert.equal(h.resolveCompactPlayerMetadataRevealDelay({
    presentation: 'rail_play', speed: 'normal', reducedMotion: false,
  }), 1120);
  assert.equal(h.resolveCompactPlayerMetadataRevealDelay({
    presentation: 'rail_play', speed: 'slow', reducedMotion: false,
  }), 2100);
  assert.equal(h.resolveCompactPlayerMetadataRevealDelay({
    presentation: 'rail_play', speed: 'slow', reducedMotion: true,
  }), 701);
  assert.equal(h.resolveCompactPlayerMetadataRevealDelay({
    presentation: 'rail_artbox', speed: 'slow', reducedMotion: false,
  }), 700);
  assert.equal(h.resolveCompactPlayerMetadataRevealDelay({
    presentation: 'docked', speed: 'normal', reducedMotion: false,
  }), null);
});

test('compact metadata summary omits missing separators', () => {
  const h = loadHelper();
  assert.equal(h.buildCompactPlayerMetadataSummary({
    artist: 'Fixture artist', title: 'Fixture song', album: 'Fixture album',
  }), 'Fixture artist - Fixture song / Fixture album');
  assert.equal(h.buildCompactPlayerMetadataSummary({ title: 'Fixture song' }), 'Fixture song');
  assert.equal(h.buildCompactPlayerMetadataSummary(null), '');
});

test('compact metadata row motion ignores rounding and scales with real overflow', () => {
  const h = loadHelper();
  assert.deepEqual(plain(h.resolveCompactPlayerMetadataRowMotion()), {
    overflowing: false, distance: 0, durationMs: 0,
  });
  assert.deepEqual(plain(h.resolveCompactPlayerMetadataRowMotion({
    scrollWidth: 101, clientWidth: 100,
  })), { overflowing: false, distance: 0, durationMs: 0 });
  assert.deepEqual(plain(h.resolveCompactPlayerMetadataRowMotion({
    scrollWidth: 200, clientWidth: 100,
  })), { overflowing: true, distance: 100, durationMs: 4200 });
});
