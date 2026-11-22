const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'library-live-events.js',
);

class FakeEventSource {
  static CLOSED = 2;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  emit(type, data = {}, lastEventId = '') {
    for (const listener of this.listeners[type] || []) listener({ data: JSON.stringify(data), lastEventId });
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function load({ locks = 'granted', allows = true, channel = true } = {}) {
  FakeEventSource.instances = [];
  const calls = { viewRefreshes: 0, artwork: [], loops: 0, appearance: 0, settings: 0, posted: [] };
  const timers = [];
  const channels = [];
  const context = {
    console,
    JSON,
    Number,
    Set,
    Object,
    Array,
    String,
    Promise,
    EventSource: FakeEventSource,
    navigator: {},
    window: {
      AlbumHavenCapabilities: { allows: (action) => allows && action === 'library.browse.read' },
      albumHavenWritesInFlight: 0,
      AlbumHavenAppearance: {
        instance: {
          controller: { dirty: false, getState() { return { dirty: this.dirty }; } },
          load: async (options) => { calls.appearance += 1; calls.appearanceOptions = options; },
        },
      },
    },
    state: {
      ui: { customCollectionArtworkByName: { Night: null, Day: null } },
      utility: {
        loopsLoaded: false,
        librarySettings: { loaded: true, settings: { a: 1 }, draft: { a: 1 } },
      },
    },
    scheduleBrowserTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearBrowserTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; },
    requestLibraryChangeViewRefresh() { calls.viewRefreshes += 1; },
    loadCustomCollectionArtwork: async (name) => { calls.artwork.push(name); },
    loadUtilityLoops: async () => { calls.loops += 1; },
    loadUtilityLibrarySettings: async () => { calls.settings += 1; },
    serializeLibrarySettingsDraft: (value) => JSON.stringify(value),
  };
  if (channel) {
    context.BroadcastChannel = class {
      constructor(name) { this.name = name; this.listeners = []; channels.push(this); }
      addEventListener(_type, listener) { this.listeners.push(listener); }
      postMessage(message) { calls.posted.push(message); }
      receive(message) { this.listeners.forEach((listener) => listener({ data: message })); }
    };
  }
  if (locks === 'granted') {
    context.navigator.locks = { request: (_name, callback) => { callback(); return new Promise(() => {}); } };
  } else if (locks === 'held-elsewhere') {
    context.navigator.locks = { request: () => new Promise(() => {}) };
  }
  let now = 10000;
  context.Date = { now: () => now };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const runTimers = () => {
    const due = timers.filter((timer) => !timer.cleared && !timer.ran);
    due.forEach((timer) => { timer.ran = true; timer.callback(); });
    return due.map((timer) => timer.delay);
  };
  const advance = (ms) => { now += ms; };
  return { context, calls, timers, channels, runTimers, advance };
}

test('the lock holder streams from the bootstrap revision and shares each event with sibling tabs', () => {
  const { context, calls, runTimers } = load();

  context.startLibraryLiveEvents(41);
  const [source] = FakeEventSource.instances;
  source.emit('change', { kinds: ['inventory'], refs: {} }, '42');
  source.emit('change', { kinds: ['covers'], refs: {} }, '43');

  assert.equal(source.url, '/api/live/library-events?since=41');
  assert.deepEqual(calls.posted.map((message) => message.revision), ['42', '43']);
  assert.deepEqual(runTimers(), [150]);
  assert.equal(calls.viewRefreshes, 1, 'events inside the window share one refresh');
  assert.equal(vm.runInContext('libraryLiveEvents.cursor', context), 43);
});

test('a tab without the lock opens no stream and applies the events its sibling shares', () => {
  const { context, calls, channels, runTimers } = load({ locks: 'held-elsewhere' });

  context.startLibraryLiveEvents(7);
  channels[0].receive({ type: 'change', revision: '9', kinds: ['ratings'], refs: { album_keys: ['a'] } });
  runTimers();

  assert.equal(FakeEventSource.instances.length, 0);
  assert.equal(calls.viewRefreshes, 1);
  assert.equal(vm.runInContext('libraryLiveEvents.cursor', context), 9, 'a later lock holder resumes after the shared revision');
});

test('events wait while this tab has its own write in flight', () => {
  const { context, calls, runTimers } = load();
  context.startLibraryLiveEvents(1);
  context.window.albumHavenWritesInFlight = 1;

  FakeEventSource.instances[0].emit('change', { kinds: ['inventory'], refs: {} }, '2');
  assert.deepEqual(runTimers(), [150]);
  assert.equal(calls.viewRefreshes, 0);

  context.window.albumHavenWritesInFlight = 0;
  assert.deepEqual(runTimers(), [300]);
  assert.equal(calls.viewRefreshes, 1);
});

test('each change kind goes to the owner of the surface that shows it', () => {
  const { context, calls, runTimers } = load();
  context.startLibraryLiveEvents(1);
  context.state.ui.nonAlbumCollectionName = 'Open';
  context.state.utility.loopsLoaded = true;
  const source = FakeEventSource.instances[0];

  source.emit('change', { kinds: ['collections'], refs: { collection_names: ['Night', 'Elsewhere'] } }, '2');
  source.emit('change', { kinds: ['loops'], refs: {} }, '3');
  source.emit('change', { kinds: ['appearance'], refs: {} }, '4');
  source.emit('change', { kinds: ['library_settings'], refs: {} }, '5');
  runTimers();

  assert.equal(calls.viewRefreshes, 0, 'none of these needs the gallery refetched');
  assert.deepEqual(calls.artwork, ['Night'], 'only artwork this tab has loaded or shows');
  assert.equal(calls.loops, 1);
  assert.equal(calls.appearance, 1);
  assert.equal(calls.appearanceOptions?.background, true, 'never disables the open editor');
  assert.equal(calls.settings, 1);
});

test('unsaved Appearance and Library settings edits are never replaced', () => {
  const { context, calls, runTimers } = load();
  context.startLibraryLiveEvents(1);
  context.window.AlbumHavenAppearance.instance.controller.dirty = true;
  context.state.utility.librarySettings.draft = { a: 2 };

  FakeEventSource.instances[0].emit('change', { kinds: ['appearance', 'library_settings'], refs: {} }, '2');
  runTimers();

  assert.equal(calls.appearance, 0);
  assert.equal(calls.settings, 0);
});

test('a resync refreshes every surface and an unknown kind still refreshes the view', () => {
  const { context, calls, runTimers, advance } = load();
  context.startLibraryLiveEvents(1);
  context.state.utility.loopsLoaded = true;

  FakeEventSource.instances[0].emit('resync', { head: 90 }, '90');
  runTimers();
  assert.equal(calls.viewRefreshes, 1);
  assert.deepEqual(calls.artwork, ['Night', 'Day']);
  assert.equal(calls.loops, 1);
  assert.equal(vm.runInContext('libraryLiveEvents.cursor', context), 90);

  advance(1000);
  FakeEventSource.instances[0].emit('change', { kinds: ['something_new'], refs: {} }, '91');
  runTimers();
  assert.equal(calls.viewRefreshes, 2);
});

test('a refused stream retries later from the newest revision; lost access stops it', () => {
  const { context, timers } = load();
  context.startLibraryLiveEvents(5);
  const first = FakeEventSource.instances[0];
  first.emit('change', { kinds: ['inventory'], refs: {} }, '6');

  first.readyState = FakeEventSource.CLOSED;
  first.emit('error');
  const retry = timers.find((timer) => timer.delay === 30000);
  retry.callback();
  assert.equal(FakeEventSource.instances[1].url, '/api/live/library-events?since=6');

  FakeEventSource.instances[1].emit('unauthorized');
  assert.equal(FakeEventSource.instances[1].readyState, FakeEventSource.CLOSED);
});

test('readers without library access or EventSource never connect', () => {
  const denied = load({ allows: false });
  denied.context.startLibraryLiveEvents(1);
  assert.equal(FakeEventSource.instances.length, 0);

  const legacy = load({ locks: 'none', channel: false });
  legacy.context.startLibraryLiveEvents(null);
  assert.equal(FakeEventSource.instances[0].url, '/api/live/library-events', 'without a cursor the server follows from its current head');
});

// Owner 2026-11-22: "merged two albums. In another tab I checked - still two album cards were shown".
// Their stream was open through a tunnel and never delivered the notice; the status check got through.
test('a change the stream never delivered is caught up from the status check', () => {
  const { context, calls, runTimers } = load();
  context.startLibraryLiveEvents(9);

  context.observeLibraryLiveEventsHead(10);
  runTimers();
  assert.equal(calls.viewRefreshes, 0, 'one check only leads a notice still on its way');

  context.observeLibraryLiveEventsHead(10);
  runTimers();
  assert.equal(calls.viewRefreshes, 1);
  assert.equal(vm.runInContext('libraryLiveEvents.cursor', context), 10);

  context.observeLibraryLiveEventsHead(10);
  context.observeLibraryLiveEventsHead(10);
  runTimers();
  assert.equal(calls.viewRefreshes, 1, 'caught up once');
});

test('a tab without the stream catches up by itself', () => {
  const { context, calls, runTimers } = load({ locks: 'held-elsewhere' });
  context.startLibraryLiveEvents(9);
  context.observeLibraryLiveEventsHead(10);
  context.observeLibraryLiveEventsHead(11);
  runTimers();
  assert.equal(calls.viewRefreshes, 1);
});

test('a status check adds no refresh when the stream delivers, or before live updates start', () => {
  const { context, calls, runTimers } = load();
  context.observeLibraryLiveEventsHead(5);
  context.observeLibraryLiveEventsHead(5);
  runTimers();
  assert.equal(calls.viewRefreshes, 0);

  context.startLibraryLiveEvents(9);
  context.observeLibraryLiveEventsHead(10);
  FakeEventSource.instances[0].emit('change', { kinds: ['loops'], refs: {} }, '10');
  context.observeLibraryLiveEventsHead(10);
  context.observeLibraryLiveEventsHead(null);
  runTimers();
  assert.equal(calls.viewRefreshes, 0);
});

test('every status poll hands the newest change to live updates', () => {
  const poll = fs.readFileSync(path.join(path.dirname(sourcePath), 'gallery-refresh-and-status.js'), 'utf8');
  assert.match(poll, /observeLibraryLiveEventsHead\(data\.live_events_head\)/);
});

test('a burst of changes refreshes the view at most once a second', () => {
  const { context, calls, runTimers, advance } = load();
  context.startLibraryLiveEvents(1);
  const source = FakeEventSource.instances[0];

  source.emit('change', { kinds: ['inventory'], refs: {} }, '2');
  runTimers();
  advance(200);
  source.emit('change', { kinds: ['inventory'], refs: {} }, '3');
  assert.deepEqual(runTimers(), [150]);
  assert.equal(calls.viewRefreshes, 1, 'the second change waits for the interval');

  advance(800);
  assert.deepEqual(runTimers(), [800]);
  assert.equal(calls.viewRefreshes, 2, 'the deferred change is not lost');
});
