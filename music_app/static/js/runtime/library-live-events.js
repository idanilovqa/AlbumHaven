// Live library change events (owner rule: every place showing a changed value updates at once,
// in every tab and on every device). One tab per browser profile holds the server-sent event
// stream and shares each event with its sibling tabs; every tab applies events through the
// owners that already refresh those values, never by patching markup here.
const LIBRARY_LIVE_EVENTS_URL = '/api/live/library-events';
const LIBRARY_LIVE_EVENTS_CHANNEL = 'album-haven-library-events';
const LIBRARY_LIVE_EVENTS_LOCK = 'album-haven-library-events';
const LIBRARY_LIVE_EVENTS_COALESCE_MS = 150;
const LIBRARY_LIVE_EVENTS_WRITE_SETTLE_MS = 300;
const LIBRARY_LIVE_EVENTS_RETRY_MS = 30000;

const libraryLiveEvents = {
  started: false,
  cursor: null,
  source: null,
  channel: null,
  pendingKinds: new Set(),
  pendingCollectionNames: new Set(),
  pendingAllCollections: false,
  flushTimer: 0,
  nextViewRefreshAt: 0,
};

function readLibraryLiveEventsCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
}

// Collects one event's work; repeated events within the window cost one refresh.
function noteLibraryLiveChange(message) {
  const revision = readLibraryLiveEventsCursor(message?.revision);
  if (revision !== null) {
    libraryLiveEvents.cursor = Math.max(libraryLiveEvents.cursor ?? 0, revision);
  }
  if (message?.type === 'resync') {
    libraryLiveEvents.pendingKinds.add('resync');
  } else {
    const refs = message?.refs && typeof message.refs === 'object' ? message.refs : {};
    const bulk = new Set(Array.isArray(refs.bulk) ? refs.bulk : []);
    for (const kind of Array.isArray(message?.kinds) ? message.kinds : []) {
      libraryLiveEvents.pendingKinds.add(String(kind));
    }
    if (bulk.has('collections')) libraryLiveEvents.pendingAllCollections = true;
    for (const name of Array.isArray(refs.collection_names) ? refs.collection_names : []) {
      libraryLiveEvents.pendingCollectionNames.add(String(name));
    }
  }
  scheduleLibraryLiveEventsFlush(LIBRARY_LIVE_EVENTS_COALESCE_MS);
}

function scheduleLibraryLiveEventsFlush(delay) {
  if (libraryLiveEvents.flushTimer) clearBrowserTimeout(libraryLiveEvents.flushTimer);
  libraryLiveEvents.flushTimer = scheduleBrowserTimeout(() => {
    libraryLiveEvents.flushTimer = 0;
    flushLibraryLiveEvents();
  }, delay);
}

// Kinds owned by one surface each; every other kind (inventory, covers, ratings, track
// preferences, MusicBrainz matches, a resync or a kind this page does not know yet) reaches the
// gallery, album pages and Problematic Files through the view refresh.
const LIBRARY_LIVE_SURFACE_KINDS = new Set(['collections', 'loops', 'appearance', 'library_settings']);
// A watcher burst commits many small changes; the view follows them at most once a second.
const LIBRARY_LIVE_VIEW_REFRESH_INTERVAL_MS = 1000;

function flushLibraryLiveEvents() {
  // This tab's own write is still in flight: its optimistic owner already shows the change,
  // so the matching event waits until the write settles instead of racing it.
  if (Number(window.albumHavenWritesInFlight || 0) > 0) {
    scheduleLibraryLiveEventsFlush(LIBRARY_LIVE_EVENTS_WRITE_SETTLE_MS);
    return;
  }
  const kinds = libraryLiveEvents.pendingKinds;
  const collectionNames = libraryLiveEvents.pendingCollectionNames;
  const resync = kinds.has('resync');
  const allCollections = libraryLiveEvents.pendingAllCollections || resync;
  libraryLiveEvents.pendingKinds = new Set();
  libraryLiveEvents.pendingCollectionNames = new Set();
  libraryLiveEvents.pendingAllCollections = false;
  if ([...kinds].some((kind) => !LIBRARY_LIVE_SURFACE_KINDS.has(kind))) refreshLibraryLiveView();
  if (kinds.has('collections') || resync) refreshLiveCollectionArtwork(collectionNames, allCollections);
  if ((kinds.has('loops') || resync) && state.utility?.loopsLoaded) void loadUtilityLoops(true);
  if (kinds.has('appearance') || resync) {
    const controller = window.AlbumHavenAppearance?.instance?.controller;
    // Unsaved edits in this tab's Appearance editor stay; its Save reports the newer revision.
    if (controller && !controller.getState().dirty) void window.AlbumHavenAppearance.instance.load();
  }
  if (kinds.has('library_settings') || resync) {
    const settings = state.utility?.librarySettings;
    if (settings?.loaded && settings.settings
      && serializeLibrarySettingsDraft(settings.draft) === serializeLibrarySettingsDraft(settings.settings)) {
      void loadUtilityLibrarySettings(true);
    }
  }
}

function refreshLibraryLiveView() {
  const wait = libraryLiveEvents.nextViewRefreshAt - Date.now();
  if (wait > 0) {
    libraryLiveEvents.pendingKinds.add('inventory');
    scheduleLibraryLiveEventsFlush(wait);
    return;
  }
  libraryLiveEvents.nextViewRefreshAt = Date.now() + LIBRARY_LIVE_VIEW_REFRESH_INTERVAL_MS;
  requestLibraryChangeViewRefresh();
}

function refreshLiveCollectionArtwork(names, all) {
  const loaded = Object.keys(state.ui?.customCollectionArtworkByName || {});
  const targets = all ? loaded : loaded.filter((name) => names.has(name));
  const current = String(state.ui?.nonAlbumCollectionName || '').trim();
  if (current && (all || names.has(current)) && !targets.includes(current)) targets.push(current);
  for (const name of targets) {
    void loadCustomCollectionArtwork(name).catch((error) => {
      console.error('[AlbumHaven][LiveEvents] Failed to refresh collection artwork.', error);
    });
  }
}

function receiveLibraryLiveEvent(type, event) {
  let data = {};
  try {
    data = JSON.parse(event.data || '{}');
  } catch (_error) {
    data = {};
  }
  const message = { type, revision: event.lastEventId, kinds: data.kinds, refs: data.refs };
  libraryLiveEvents.channel?.postMessage(message);
  noteLibraryLiveChange(message);
}

function openLibraryLiveEventsSource() {
  const cursor = libraryLiveEvents.cursor;
  const url = cursor === null ? LIBRARY_LIVE_EVENTS_URL : `${LIBRARY_LIVE_EVENTS_URL}?since=${cursor}`;
  const source = new EventSource(url);
  libraryLiveEvents.source = source;
  source.addEventListener('change', (event) => receiveLibraryLiveEvent('change', event));
  source.addEventListener('resync', (event) => receiveLibraryLiveEvent('resync', event));
  source.addEventListener('unauthorized', () => source.close());
  source.addEventListener('error', () => {
    // EventSource reconnects by itself with Last-Event-ID; a refused stream stays closed,
    // and the status poll keeps the page current until the next attempt.
    if (source.readyState !== EventSource.CLOSED || libraryLiveEvents.source !== source) return;
    scheduleBrowserTimeout(() => {
      if (libraryLiveEvents.source === source) openLibraryLiveEventsSource();
    }, LIBRARY_LIVE_EVENTS_RETRY_MS);
  });
}

function startLibraryLiveEvents(bootstrapHead) {
  if (libraryLiveEvents.started || typeof EventSource !== 'function') return;
  if (window.AlbumHavenCapabilities && !window.AlbumHavenCapabilities.allows('library.browse.read')) return;
  libraryLiveEvents.started = true;
  libraryLiveEvents.cursor = readLibraryLiveEventsCursor(bootstrapHead);
  if (typeof BroadcastChannel === 'function') {
    libraryLiveEvents.channel = new BroadcastChannel(LIBRARY_LIVE_EVENTS_CHANNEL);
    libraryLiveEvents.channel.addEventListener('message', (event) => noteLibraryLiveChange(event.data));
  }
  // Browsers allow few connections per origin, so only the lock holder streams; when it
  // closes, the next tab takes the lock and resumes from the last revision it was sent.
  if (navigator.locks?.request && libraryLiveEvents.channel) {
    void navigator.locks.request(LIBRARY_LIVE_EVENTS_LOCK, () => {
      openLibraryLiveEventsSource();
      return new Promise(() => {});
    });
  } else {
    openLibraryLiveEventsSource();
  }
}
