const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPaths = [
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'view-value-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'core-state-and-helpers.js'),
  path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime', 'loader-status-helpers.js'),
];
const indexTemplatePath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'templates',
  'index.html',
);

function loadHelpers() {
  const context = {
    appBootstrap: {
      getInitialView() {
        return {};
      },
    },
    window: {
      location: {
        href: 'http://localhost/',
        origin: 'http://localhost',
      },
    },
  };
  vm.createContext(context);
  for (const helperPath of helperPaths) {
    vm.runInContext(fs.readFileSync(helperPath, 'utf8'), context, { filename: helperPath });
  }
  return context;
}

function createLoaderRenderFixture() {
  const context = loadHelpers();
  const spinner = { hidden: false };
  const loader = {
    hidden: true,
    classList: {
      values: new Set(),
      toggle(name, enabled) {
        if (enabled) this.values.add(name);
        else this.values.delete(name);
      },
      contains(name) {
        return this.values.has(name);
      },
    },
    querySelector(selector) {
      return selector === '.library-loader-spinner' ? spinner : null;
    },
  };
  const title = { textContent: '' };
  const status = { textContent: '' };
  const progress = { innerHTML: '' };
  const browseButton = { hidden: true, disabled: false, textContent: '' };
  const cancelButton = { hidden: true, disabled: false, textContent: '' };
  const actions = { hidden: true };
  const backButton = { hidden: false };
  const phaseGuide = { hidden: false };
  const scroll = { hidden: false };
  const elements = {
    'library-loader': loader,
    'library-loader-title': title,
    'library-loader-status': status,
    'library-loader-progress': progress,
    'library-loader-actions': actions,
    'library-loader-browse-button': browseButton,
    'library-loader-cancel-button': cancelButton,
    'library-loader-back-button': backButton,
    'library-loader-phase-guide': phaseGuide,
    'albums-scroll': scroll,
  };
  context.document = {
    getElementById(id) {
      return elements[id] || null;
    },
  };
  return {
    context,
    elements,
    loader,
    spinner,
    title,
    status,
    progress,
    actions,
    browseButton,
    cancelButton,
    backButton,
    phaseGuide,
    scroll,
  };
}

function trackPropertyWrites(target, property) {
  let value = target[property];
  let writes = 0;
  Object.defineProperty(target, property, {
    configurable: true,
    get() {
      return value;
    },
    set(nextValue) {
      writes += 1;
      value = nextValue;
    },
  });
  return {
    reset() {
      writes = 0;
    },
    read() {
      return writes;
    },
  };
}

test('shouldShowLibraryLoader stays hidden for an idle empty root view', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 0,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    query: '',
    selected_artist: '',
  }, {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    forceScanPageVisible: false,
    awaitingInitialDataRefresh: false,
  }), false);
});

test('shouldShowLibraryLoader stays visible while the library is empty and startup work is active', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 0,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    query: '',
    selected_artist: '',
  }, {
    scan_in_progress: true,
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    forceScanPageVisible: false,
    awaitingInitialDataRefresh: false,
  }), true);
});

test('shouldShowLibraryLoader keeps a populated gallery browseable during an incremental scan', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 1,
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    primary_artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    query: 'Broadcast',
    selected_artist: 'Broadcast',
  }, {
    scan_in_progress: true,
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    forceScanPageVisible: false,
    awaitingInitialDataRefresh: false,
  }), false);
});

test('shouldShowLibraryLoader keeps a populated search gallery browseable through every background job', () => {
  const { shouldShowLibraryLoader } = loadHelpers();
  const view = {
    album_count: 1,
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    primary_artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    family_artist_groups: [{
      artist: 'Broadcast Family',
      albums: [{ key: 'broadcast-family::signal' }],
    }],
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    query: 'tender',
    selected_artist: 'Broadcast',
  };

  for (const status of [
    { scan_in_progress: true },
    { relations_in_progress: true },
    { covers_in_progress: true },
  ]) {
    assert.equal(shouldShowLibraryLoader(view, status, {
      forceScanPageVisible: false,
      awaitingInitialDataRefresh: false,
    }), false);
  }
});

test('shouldShowLibraryLoader keeps an explicitly opened idle Scan Page visible', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 1,
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    primary_artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    family_artist_groups: [],
    artist_groups: [{
      artist: 'Broadcast',
      albums: [{ key: 'broadcast::tender-buttons' }],
    }],
    query: '',
    selected_artist: '',
  }, {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    forceScanPageVisible: true,
    awaitingInitialDataRefresh: false,
  }), true);
});

test('buildLoaderStatusLines keeps discovery and indexing as distinct scan phases', () => {
  const { buildLoaderStatusLines } = loadHelpers();

  const discovery = buildLoaderStatusLines({
    scan_in_progress: true,
    scan_phase: 'discovering',
    scan_total: 12,
  });
  const indexing = buildLoaderStatusLines({
    scan_in_progress: true,
    scan_phase: 'indexing',
    scan_processed: 3,
    scan_total: 12,
  });

  assert.equal(discovery[0].title, 'Discovering music files');
  assert.equal(indexing[0].title, 'Scanning music files');
});

test('buildLoaderStatusLines labels scan admission as discovery', () => {
  const { buildLoaderStatusLines } = loadHelpers();

  const admission = buildLoaderStatusLines({
    scan_in_progress: true,
    scan_phase: 'idle',
    scan_processed: 0,
    scan_total: 0,
  }, {
    scanPageVisible: true,
  });

  assert.equal(admission[0].title, 'Discovering music files');
});

test('buildLoaderStatusLines labels scan finalizing as artist relation work', () => {
  const { buildLoaderStatusLines } = loadHelpers();

  const finalizing = buildLoaderStatusLines({
    scan_in_progress: true,
    scan_phase: 'finalizing',
    scan_processed: 3003,
    scan_total: 3003,
    relations_in_progress: false,
    relations_processed: 101,
    relations_total: 101,
  }, {
    scanPageVisible: true,
  });

  assert.equal(finalizing[0].title, 'Refreshing artist relations');
});

test('buildLoaderStatusLines keeps poll-time scan status behind a pending view transition', () => {
  const { buildLoaderStatusLines } = loadHelpers();

  const lines = buildLoaderStatusLines({
    scan_in_progress: true,
    scan_phase: 'discovering',
    scan_total: 12,
  }, {
    pendingViewTransition: true,
  });

  assert.deepEqual(Array.from(lines, (line) => ({ ...line })), [{
    title: 'Loading selection',
    detail: 'Updating the current artist view...',
  }]);
});

test('buildLoaderStatusLines exposes cover and relation work on the explicit Scan Page', () => {
  const { buildLoaderStatusLines } = loadHelpers();

  const coverLines = buildLoaderStatusLines({
    covers_in_progress: true,
    covers_processed: 2,
    covers_total: 7,
  });
  const relationLines = buildLoaderStatusLines({
    relations_in_progress: true,
    relations_processed: 4,
    relations_total: 9,
  });

  assert.equal(coverLines[0].title, 'Updating cover art');
  assert.equal(relationLines[0].title, 'Building artist families');
});

test('buildLoaderStatusLines names the explicitly opened idle Scan Page', () => {
  const { buildLoaderStatusLines } = loadHelpers();

  const lines = buildLoaderStatusLines({
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    scanPageVisible: true,
  });

  assert.equal(lines[0].title, 'No Active Scan Running');
});

test('shouldShowLibraryLoader does not let cover-only follow-up replace an empty search with the central loader', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 0,
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    query: 'missing album',
    selected_artist: '',
  }, {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: true,
  }, {
    forceScanPageVisible: true,
    awaitingInitialDataRefresh: false,
  }), false);
});

test('shouldShowLibraryLoader treats scan finalization as non-blocking while admission remains active', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 0,
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    query: '',
    selected_artist: '',
  }, {
    scan_in_progress: true,
    scan_phase: 'finalizing',
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    forceScanPageVisible: true,
    awaitingInitialDataRefresh: false,
  }), false);
});

test('shouldShowLibraryLoader still shows the empty-search state without active scan work', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 0,
    artists_sidebar: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    query: 'mono',
    selected_artist: '',
  }, {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    forceScanPageVisible: false,
    awaitingInitialDataRefresh: false,
  }), true);
});

test('shouldShowLibraryLoader stays visible during a pending view transition', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 12,
    artists_sidebar: [{ artist: 'Ария' }],
    primary_artist_groups: [{ artist: 'Ария', albums: [{ key: 'album-1' }] }],
    family_artist_groups: [],
    artist_groups: [{ artist: 'Ария', albums: [{ key: 'album-1' }] }],
    query: 'Ария',
    selected_artist: 'Ария',
  }, {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    forceScanPageVisible: false,
    awaitingInitialDataRefresh: false,
    pendingViewTransition: true,
  }), true);
});

test('renderLibraryLoader keeps Browse hidden while an active scan is showing Loading selection', () => {
  const { context, title, browseButton } = createLoaderRenderFixture();
  vm.runInContext(`
    state.view = {
      album_count: 0,
      artists_sidebar: [],
      primary_artist_groups: [],
      family_artist_groups: [],
      artist_groups: [],
      query: '',
      selected_artist: '',
    };
    state.status = {
      scan_in_progress: true,
      scan_phase: 'indexing',
      album_total: 101,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.pendingViewTransition = true;
    renderLibraryLoader(state.status);
  `, context);

  assert.equal(title.textContent, 'Loading selection');
  assert.equal(browseButton.hidden, true);
});

test('renderLibraryLoader does not rewrite an already-hidden idle loader', () => {
  const {
    context,
    loader,
    actions,
    browseButton,
    cancelButton,
    backButton,
    phaseGuide,
    scroll,
  } = createLoaderRenderFixture();
  const trackedWrites = [
    trackPropertyWrites(loader, 'hidden'),
    trackPropertyWrites(scroll, 'hidden'),
    trackPropertyWrites(backButton, 'hidden'),
    trackPropertyWrites(phaseGuide, 'hidden'),
    trackPropertyWrites(actions, 'hidden'),
    trackPropertyWrites(browseButton, 'hidden'),
    trackPropertyWrites(browseButton, 'disabled'),
    trackPropertyWrites(browseButton, 'textContent'),
    trackPropertyWrites(cancelButton, 'hidden'),
    trackPropertyWrites(cancelButton, 'disabled'),
    trackPropertyWrites(cancelButton, 'textContent'),
  ];
  vm.runInContext(`
    state.view = {
      album_count: 1,
      artists_sidebar: [{ artist: 'Signal', count: 1 }],
      primary_artist_groups: [{
        artist: 'Signal',
        albums: [{ key: 'signal::signal' }],
      }],
      family_artist_groups: [],
      artist_groups: [],
      query: '',
      selected_artist: 'Signal',
    };
    state.status = {
      scan_in_progress: false,
      relations_in_progress: false,
      covers_in_progress: false,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.pendingViewTransition = false;
    renderLibraryLoader(state.status);
  `, context);
  trackedWrites.forEach((tracker) => tracker.reset());

  vm.runInContext('renderLibraryLoader(state.status);', context);

  assert.equal(
    trackedWrites.reduce((total, tracker) => total + tracker.read(), 0),
    0,
  );
});

test('renderLibraryLoader does not rewrite stable active-scan Browse actions', () => {
  const {
    context,
    actions,
    browseButton,
    cancelButton,
  } = createLoaderRenderFixture();
  vm.runInContext(`
    state.view = {
      album_count: 1000,
      artists_sidebar: [{ artist: 'Signal', count: 1000 }],
      primary_artist_groups: [{
        artist: 'Signal',
        albums: [{ key: 'signal::signal' }],
      }],
      family_artist_groups: [],
      artist_groups: [],
      query: '',
      selected_artist: '',
    };
    state.status = {
      scan_in_progress: true,
      scan_phase: 'indexing',
      scan_mode: 'background',
      album_total: 1000,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.pendingViewTransition = false;
    state.ui.scanPageReturnContext = { view: state.view };
    renderLibraryLoader(state.status, { scanPageVisible: true });
  `, context);
  const trackedWrites = [
    trackPropertyWrites(actions, 'hidden'),
    trackPropertyWrites(browseButton, 'hidden'),
    trackPropertyWrites(browseButton, 'disabled'),
    trackPropertyWrites(browseButton, 'textContent'),
    trackPropertyWrites(cancelButton, 'hidden'),
    trackPropertyWrites(cancelButton, 'disabled'),
    trackPropertyWrites(cancelButton, 'textContent'),
  ];
  trackedWrites.forEach((tracker) => tracker.reset());

  vm.runInContext(
    'renderLibraryLoader(state.status, { scanPageVisible: true });',
    context,
  );

  assert.equal(
    trackedWrites.reduce((total, tracker) => total + tracker.read(), 0),
    0,
  );
});

test('renderLibraryLoader shows regular scan cancellation only on the dedicated Scan Page', () => {
  const {
    context,
    loader,
    actions,
    browseButton,
    cancelButton,
  } = createLoaderRenderFixture();
  vm.runInContext(`
    state.view = {
      album_count: 0,
      artists_sidebar: [],
      primary_artist_groups: [],
      family_artist_groups: [],
      artist_groups: [],
      query: '',
      selected_artist: '',
    };
    state.status = {
      scan_in_progress: true,
      scan_phase: 'indexing',
      scan_mode: 'background',
      album_total: 120,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.scanPageReturnContext = { view: {} };
    renderLibraryLoader(state.status, { scanPageVisible: true });
  `, context);

  assert.equal(loader.classList.contains('is-scan-page'), true);
  assert.equal(actions.hidden, false);
  assert.equal(cancelButton.hidden, false);
  assert.equal(cancelButton.disabled, false);
  assert.equal(cancelButton.textContent, 'Cancel Scan');
  assert.equal(browseButton.hidden, false);
  assert.equal(browseButton.textContent, 'Browse Library');
});

test('renderLibraryLoader keeps Cancel Scan and Browse Library available while artist relations finalize', () => {
  const {
    context,
    actions,
    browseButton,
    cancelButton,
  } = createLoaderRenderFixture();
  vm.runInContext(`
    state.view = {
      album_count: 120,
      artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
      primary_artist_groups: [{
        artist: 'Broadcast',
        albums: [{ key: 'broadcast::tender-buttons' }],
      }],
      family_artist_groups: [],
      artist_groups: [{
        artist: 'Broadcast',
        albums: [{ key: 'broadcast::tender-buttons' }],
      }],
      query: '',
      selected_artist: '',
    };
    state.status = {
      scan_in_progress: true,
      scan_phase: 'finalizing',
      scan_mode: 'background',
      relations_in_progress: true,
      relations_phase: 'Refreshing artist relationships',
      album_total: 120,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.scanPageReturnContext = { view: state.view };
    renderLibraryLoader(state.status, { scanPageVisible: true });
  `, context);

  assert.equal(actions.hidden, false);
  assert.equal(cancelButton.hidden, false);
  assert.equal(cancelButton.disabled, false);
  assert.equal(cancelButton.textContent, 'Cancel Scan');
  assert.equal(browseButton.hidden, false);
  assert.equal(browseButton.disabled, false);
  assert.equal(browseButton.textContent, 'Browse Library');
});

test('renderLibraryLoader keeps the Browse Library label while a browse request is pending', () => {
  const {
    context,
    browseButton,
  } = createLoaderRenderFixture();
  vm.runInContext(`
    state.view = {
      album_count: 0,
      artists_sidebar: [],
      primary_artist_groups: [],
      family_artist_groups: [],
      artist_groups: [],
      query: '',
      selected_artist: '',
    };
    state.status = {
      scan_in_progress: true,
      scan_phase: 'indexing',
      scan_mode: 'background',
      album_total: 120,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.scanPageReturnContext = { view: {} };
    state.ui.browseScannedResultsLoading = true;
    renderLibraryLoader(state.status, { scanPageVisible: true });
  `, context);

  assert.equal(browseButton.hidden, false);
  assert.equal(browseButton.disabled, true);
  assert.equal(browseButton.textContent, 'Browse Library');
});

test('Scan Page markup keeps destructive cancellation left of neutral library browsing', () => {
  const template = fs.readFileSync(indexTemplatePath, 'utf8');
  const actionsMatch = template.match(
    /<div class="library-loader-actions"[\s\S]*?<\/div>/,
  );

  assert.ok(actionsMatch, 'Expected one Scan Page action group');
  const actionsMarkup = actionsMatch[0];
  const cancelIndex = actionsMarkup.indexOf('id="library-loader-cancel-button"');
  const browseIndex = actionsMarkup.indexOf('id="library-loader-browse-button"');
  assert.ok(cancelIndex >= 0, 'Expected the dedicated Scan Page cancel button');
  assert.ok(browseIndex >= 0, 'Expected the Scan Page browse button');
  assert.ok(cancelIndex < browseIndex, 'Cancel must stay left of Browse Library');
  assert.match(
    actionsMarkup,
    /class="button library-loader-cancel-button"/,
  );
});

test('renderLibraryLoader labels a cancellable full rescan without changing action order', () => {
  const {
    context,
    actions,
    browseButton,
    cancelButton,
  } = createLoaderRenderFixture();
  vm.runInContext(`
    state.view = {
      album_count: 0,
      artists_sidebar: [],
      primary_artist_groups: [],
      family_artist_groups: [],
      artist_groups: [],
      query: '',
      selected_artist: '',
    };
    state.status = {
      scan_in_progress: true,
      scan_phase: 'indexing',
      scan_mode: 'manual_full_rescan',
      album_total: 120,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.scanPageReturnContext = { view: {} };
    renderLibraryLoader(state.status, { scanPageVisible: true });
  `, context);

  assert.equal(actions.hidden, false);
  assert.equal(cancelButton.hidden, false);
  assert.equal(cancelButton.textContent, 'Cancel Full Rescan');
  assert.equal(browseButton.textContent, 'Browse Library');
});

test('renderLibraryLoader keeps scan cancellation absent outside the dedicated Scan Page', () => {
  const {
    context,
    actions,
    cancelButton,
  } = createLoaderRenderFixture();
  vm.runInContext(`
    state.view = {
      album_count: 0,
      artists_sidebar: [],
      primary_artist_groups: [],
      family_artist_groups: [],
      artist_groups: [],
      query: '',
      selected_artist: '',
    };
    state.status = {
      scan_in_progress: true,
      scan_phase: 'indexing',
      scan_mode: 'background',
      album_total: 0,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.scanPageReturnContext = null;
    renderLibraryLoader(state.status);
  `, context);

  assert.equal(cancelButton.hidden, true);
  assert.equal(actions.hidden, true);
});

test('renderLibraryLoader removes Scan Page actions when no cancellable scan remains', () => {
  const {
    context,
    actions,
    browseButton,
    cancelButton,
  } = createLoaderRenderFixture();
  vm.runInContext(`
    state.view = {
      album_count: 12,
      artists_sidebar: [{ artist: 'Broadcast', count: 12 }],
      primary_artist_groups: [{
        artist: 'Broadcast',
        albums: [{ key: 'broadcast::tender-buttons' }],
      }],
      family_artist_groups: [],
      artist_groups: [{
        artist: 'Broadcast',
        albums: [{ key: 'broadcast::tender-buttons' }],
      }],
      query: '',
      selected_artist: '',
    };
    state.status = {
      scan_in_progress: false,
      relations_in_progress: false,
      covers_in_progress: false,
      scan_mode: 'idle',
      album_total: 12,
    };
    state.awaitingInitialDataRefresh = false;
    state.ui.scanPageReturnContext = { view: {} };
    renderLibraryLoader(state.status, { scanPageVisible: true });
  `, context);

  assert.equal(cancelButton.hidden, true);
  assert.equal(browseButton.hidden, true);
  assert.equal(browseButton.textContent, 'Browse Library');
  assert.equal(actions.hidden, true);
});

test('shouldShowLibraryLoader stays visible for a sidebar-only root preview while startup hydration is pending', () => {
  const { shouldShowLibraryLoader } = loadHelpers();

  assert.equal(shouldShowLibraryLoader({
    album_count: 0,
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
    primary_artist_groups: [],
    family_artist_groups: [],
    artist_groups: [],
    query: '',
    selected_artist: '',
  }, {
    scan_in_progress: false,
    relations_in_progress: false,
    covers_in_progress: false,
  }, {
    forceScanPageVisible: false,
    awaitingInitialDataRefresh: true,
  }), true);
});
