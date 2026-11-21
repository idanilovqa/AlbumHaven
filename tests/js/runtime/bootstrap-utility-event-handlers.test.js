const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadPendingProjectionFetch } = require('../helpers/pending-projection-fetch');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'bootstrap-utility-event-handlers.js',
);
const utilityListBuildersPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-list-builders.js',
);
const utilityLoadersPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-loaders-and-cover-lookup.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

test('opening the notification drawer retains accepted tasks during persistence lag', () => {
  assert.match(
    helperSource,
    /state\.coverLookup\.drawerOpen = !state\.coverLookup\.drawerOpen;[\s\S]*?loadCoverLookupTasks\(\{ toast: false, mergeFirstPage: true \}\);/,
  );
});

test('cancel refresh retains the task until its terminal state is persisted', () => {
  assert.match(
    helperSource,
    /\.finally\(\(\) => loadCoverLookupTasks\(\{ toast: false, mergeFirstPage: true \}\)\);/,
  );
});

test('dismissing an interrupted cover lookup notice clears and rerenders it', () => {
  assert.match(
    helperSource,
    /data-dismiss-cover-lookup-notice[\s\S]*?failureNotice = '';[\s\S]*?renderCoverLookupModal\(\);/,
  );
});

test('split release choices use the shared Cover Lookup rebind action', () => {
  assert.match(
    helperSource,
    /closest\('\[data-cover-lookup-current-release\]'\)[\s\S]*?chooseCoverLookupCurrentRelease\([\s\S]*?getAttribute\('data-cover-lookup-current-release'\)/,
  );
});

test('Cover Lookup album link uses the shared album-details navigation action', () => {
  assert.match(
    helperSource,
    /closest\('\[data-open-cover-lookup-album-details="1"\]'\)[\s\S]*?openCoverLookupAlbumDetails\(\)/,
  );
});
test('Cover Lookup lightbox passes the already-loaded preview fallback', () => {
  assert.match(
    helperSource,
    /openImageLightbox\([\s\S]*?getAttribute\('data-cover-src'\)[\s\S]*?previewSrc:\s*coverLookupLightboxButton\.getAttribute\('data-cover-preview-src'\)/,
  );
});

const utilityListBuildersSource = fs.readFileSync(utilityListBuildersPath, 'utf8');
const utilityLoadersSource = fs.readFileSync(utilityLoadersPath, 'utf8');
const utilityRenderersSource = fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'utility-renderers-and-actions.js',
), 'utf8');
const confirmModalsTemplate = fs.readFileSync(path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'templates',
  'partials',
  'confirm-modals.html',
), 'utf8');

test('all Appearance pages share one draft without a leave confirmation', () => {
  assert.match(
    helperSource,
    /const sharedAppearanceKeys = \['backgrounds', 'seekbar', 'selection-accent', 'alerts', 'album-page'\]/,
  );
  assert.match(
    helperSource,
    /sharedAppearanceKeys\.includes\(state\.utility\.appearanceKey\)\s*&&\s*sharedAppearanceKeys\.includes\(nextAppearanceKey\)/,
  );
});

function createElement(attributes = {}) {
  return {
    checked: Boolean(attributes.checked),
    classList: {
      contains() {
        return false;
      },
    },
    getAttribute(name) {
      return attributes[name] || '';
    },
  };
}

function createEvent(selectorMap = {}, eventProperties = {}) {
  let prevented = false;
  return {
    event: {
      ...eventProperties,
      preventDefault() {
        prevented = true;
      },
      target: {
        closest(selector) {
          return selectorMap[selector] || null;
        },
      },
    },
    wasPrevented() {
      return prevented;
    },
  };
}

function createContext(stateOverrides = {}) {
  const calls = {
    pendingSyncs: 0,
    renders: 0,
    filterRenders: 0,
    missingAlbumRemovalConfirms: [],
  };
  const filterMenu = {
    hidden: false,
    set innerHTML(value) { this.markup = value; calls.filterRenders += 1; },
  };
  const utilityElements = {
    problemFilterMenu: filterMenu,
    problemFilterChips: { innerHTML: '' },
    problemFilterButton: {
      classList: { toggle() {} },
      setAttribute() {},
    },
  };
  const context = {
    getUtilityModalElements() { return utilityElements; },
    document: {
      querySelectorAll() {
        return [];
      },
    },
    state: {
      utility: {
        activeTab: 'problematic-files',
        loaded: true,
        problemDropdownOpen: true,
        problematicFiles: [],
        selectedProblemFilters: [],
        selectedProblematicKey: '',
        showRepairedDisplay: false,
        repairSelections: {},
        separateReleaseSelections: {},
        ...stateOverrides,
      },
      coverLookup: {
        drawerOpen: false,
      },
      tagEditor: {
        dragSelecting: false,
        dragAnchorPath: '',
      },
      player: {
        appearance: {},
      },
    },
    clearBrowserTimeout() {},
    closeRepairConfirmModal() {},
    closeTagEditorExceptionMenu() {},
    closeUtilityModal() {},
    closeUtilityLoopSettingMenu() {},
    openMobileUtilityDetail() {},
    buildCompactDataTable() {
      return '';
    },
    createTrackModalApplyFieldSelection() {
      return [];
    },
    escapeHtml(value) {
      return String(value ?? '');
    },
    fetchCoverForProblematicAlbum() {},
    getRepairRowKeysFromButton() {
      return [];
    },
    getSelectedProblematicAlbum() {
      return null;
    },
    getTagEditorRangePaths() {
      return [];
    },
    handleLibrarySettingsClick() {
      return false;
    },
    handleLibrarySettingsInput() {
      return false;
    },
    handleLibrarySettingsIntegrationSelection() {
      return false;
    },
    handleLocalPlaylistImportFileSelection() {},
    hideRepairAlert() {},
    exportBrowserLogHistory() {},
    loadProblematicFiles() {
      context.renderUtilityModalContent();
    },
    loadUtilityIntegrations() {},
    loadUtilityLogHistory() {},
    loadUtilityLoops() {},
    loadUtilityRules() {},
    normalizePlayerAppearance(value) {
      return value;
    },
    openAlbumInExplorer() {},
    openAlbumOnDiscogs() {},
    confirmMissingAlbumRemoval(album, runtimeOptions) {
      calls.missingAlbumRemovalConfirms.push({ album, runtimeOptions });
      return Promise.resolve(true);
    },
    openRepairConfirmModal() {},
    openTagEditor() {},
    openTagEditorExceptionMenu() {},
    openUtilityLogHistoryTab() {},
    openUtilityModal() {},
    persistPlayerAppearance() {},
    renderCoverLookupDrawer() {},
    renderTagEditor() {},
    renderUtilityModalContent() {
      calls.renders += 1;
    },
    runLocalPlaylistImportAnalysis() {},
    saveLastfmIntegration() {},
    saveLastfmTimeZone() {},
    scheduleBrowserTimeout(callback) {
      if (typeof callback === 'function') callback();
      return 1;
    },
    scheduleBrowserAnimationFrame(callback) {
      if (typeof callback === 'function') callback();
      return 1;
    },
    selectTagEditorExceptionOption() {},
    selectTagEditorTrack() {},
    setTagEditorSelectedPaths() {},
    showToast() {},
    stopCoverLookupPollingIfIdle() {},
    syncTagEditorPendingChanges() {
      calls.pendingSyncs += 1;
    },
    updateWaveformAppearance() {},
  };

  vm.createContext(context);
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/button-component.js'), 'utf8'), context);
  vm.runInContext(utilityListBuildersSource, context, {
    filename: utilityListBuildersPath,
  });
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
}

test('clicking the filter search input dismisses only the dropdown without consuming input focus', async () => {
  const selected = ['Missing cover art'];
  const { context, calls } = createContext({ selectedProblemFilters: selected });
  const { event, wasPrevented } = createEvent({
    // The input shares this wrapper; the old boundary must reproduce the bug.
    '.utility-problem-filter, .utility-problem-filter-chips': createElement(),
  });
  context.document.activeElement = event.target;
  event.target.focus = () => assert.fail('Dismissal must not redirect focus');
  await context.handleUtilityBootstrapClick(event);
  assert.equal(context.state.utility.problemDropdownOpen, false);
  assert.equal(context.getUtilityModalElements().problemFilterMenu.hidden, true);
  assert.equal(calls.filterRenders, 1);
  assert.equal(calls.renders, 0);
  assert.equal(wasPrevented(), false);
  assert.equal(context.document.activeElement, event.target);
  assert.equal(context.state.utility.selectedProblemFilters, selected);
});

test('Cover Lookup hydrates the clicked album before opening its gallery', async () => {
  const { context } = createContext();
  const hydratedAlbum = {
    key: 'revelations-of-divine-love',
    tracks: [{ path: 'C:\\Music\\Revelations of Divine Love\\01 Track.mp3' }],
  };
  const button = createElement({ 'data-open-track-modal-cover-lookup': '1' });
  const click = createEvent({ '[data-open-track-modal-cover-lookup="1"]': button });
  let openedAlbum = null;
  context.resolveTrackModalActionAlbum = () => {
    assert.fail('Cover Lookup must not use the compact synchronous resolver');
  };
  context.resolveHydratedTrackModalActionAlbum = async (candidate) => {
    assert.equal(candidate, button);
    return hydratedAlbum;
  };
  context.openCoverLookupModal = (album) => {
    openedAlbum = album;
  };

  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.strictEqual(openedAlbum, hydratedAlbum);
});

test('Fast Cover Search hydrates its album and passes its clicked control to immediate busy feedback', async () => {
  const { context } = createContext();
  const album = {
    key: 'sola-scriptura',
    tracks: [{ path: 'C:\\Music\\Sola Scriptura\\01 Track.flac' }],
  };
  const button = createElement({ 'data-track-modal-fast-cover-fetch': '1' });
  const click = createEvent({ '[data-track-modal-fast-cover-fetch="1"], [data-open-track-modal-fetch-cover="1"]': button });
  let startCall = null;
  context.resolveTrackModalActionAlbum = () => {
    assert.fail('Fast Cover Search must not use the compact synchronous resolver');
  };
  context.resolveHydratedTrackModalActionAlbum = async (candidate) => {
    assert.equal(candidate, button);
    return album;
  };
  context.startCoverLookupForAlbum = (candidate, options) => {
    startCall = { candidate, options };
  };

  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.equal(startCall.candidate, album);
  assert.equal(startCall.options.backgroundOnly, true);
  assert.equal(startCall.options.triggerButton, button);
});

for (const ancestor of ['.utility-problem-filter-menu', '.utility-problem-filter-chips', '.utility-problem-filter-button']) {
  test(`clicking within ${ancestor} preserves its normal dropdown behavior`, async () => {
    const { context, calls } = createContext();
    const element = createElement();
    const { event } = createEvent();
    event.target.closest = selector => {
      if (selector.split(', ').includes(ancestor)) return element;
      if (ancestor === '.utility-problem-filter-button' && selector === '[data-toggle-problem-filter="1"]') return element;
      return null;
    };
    await context.handleUtilityBootstrapClick(event);
    const trigger = ancestor === '.utility-problem-filter-button';
    assert.equal(context.state.utility.problemDropdownOpen, !trigger);
    assert.equal(calls.filterRenders, 0);
    assert.equal(calls.renders, trigger ? 1 : 0);
  });
}

test('editing a tag field refreshes the canonical pending-change presentation', () => {
  const path = 'C:\\Music\\Artist\\Album\\01 Track.flac';
  const input = createElement({ 'data-tag-field': 'title' });
  input.value = 'Proposed title';
  const { context, calls } = createContext();
  context.state.tagEditor = {
    tracks: [{ path }],
    values: { [path]: { title: 'Original title' } },
  };
  context.getSelectedTagEditorPaths = () => [path];
  const { event } = createEvent({
    '#tag-editor-form [data-tag-field]': input,
  });

  context.handleUtilityBootstrapInput(event);

  assert.equal(context.state.tagEditor.values[path].title, 'Proposed title');
  assert.equal(calls.pendingSyncs, 1);
});

test('Problematic Files tab activation owns one settled render', () => {
  assert.match(
    helperSource,
    /await loadProblematicFiles\(!state\.utility\.loaded, \{[\s\S]{0,120}render: false,[\s\S]{0,120}renderInitialPage: true,[\s\S]{0,500}renderUtilityModalContent\(\);/,
  );
});

test('switching Settings tabs paints selected navigation before loading panel content', async () => {
  const frames = [];
  const events = [];
  const { context } = createContext({ activeTab: 'problematic-files', rulesLoaded: false });
  context.scheduleBrowserAnimationFrame = callback => {
    frames.push(callback);
    return frames.length;
  };
  context.setUtilityActiveTab = nextTab => {
    context.state.utility.activeTab = nextTab;
    events.push(`select:${nextTab}`);
    return nextTab;
  };
  context.renderUtilityModalContent = options => {
    events.push(options?.shellOnly ? 'shell' : 'render');
  };
  context.loadUtilityRules = () => events.push('load');
  const click = createEvent({
    '[data-utility-tab]': createElement({ 'data-utility-tab': 'rules' }),
  });

  const completion = context.handleUtilityBootstrapClick(click.event);

  assert.deepEqual(events, ['select:rules', 'shell']);
  assert.equal(frames.length, 1);
  frames.shift()();
  await Promise.resolve();
  assert.deepEqual(events, ['select:rules', 'shell']);
  assert.equal(frames.length, 1);
  frames.shift()();
  await completion;
  assert.deepEqual(events, ['select:rules', 'shell', 'load', 'render']);
});

test('Settings shell-only render stops before active panel rendering', () => {
  const shellReturn = utilityRenderersSource.indexOf('if (options.shellOnly === true) {');
  const problematicRender = utilityRenderersSource.indexOf('renderProblematicFiles(options);');
  assert.ok(shellReturn >= 0);
  assert.ok(shellReturn < problematicRender);
});

test('switching away from Loops clears session-only Space ownership', () => {
  assert.match(
    helperSource,
    /nextUtilityTab[\s\S]{0,200}setUtilityActiveTab\(nextUtilityTab\)/,
    'the utility tab click path must use the shared transition policy',
  );
});

test('failure alert Log History link passes its exact entry to the authoritative open owner', async () => {
  const link = createElement({
    'data-log-history-entry-id': 'tag-edit-failure-42',
  });
  const click = createEvent({
    '[data-open-log-history-alert="1"]': link,
  });
  const { context } = createContext({
    selectedLogHistoryId: 'older-entry',
  });
  const transitions = [];
  let opened = false;
  context.closeTagEditor = () => { transitions.push('close-editor'); };
  context.hideRepairAlert = () => { transitions.push('hide-alert'); };
  context.openUtilityLogHistoryTab = entryId => {
    transitions.push('open-history');
    opened = entryId;
  };

  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.deepEqual(transitions, ['close-editor', 'hide-alert', 'open-history']);
  assert.equal(opened, 'tag-edit-failure-42');
  assert.equal(context.state.utility.selectedLogHistoryId, 'older-entry', 'the controller accepts selection after its scoped request');
});

test('applying a problem filter preserves the selected album in the live bootstrap handler when it still matches', async () => {
  const { context, calls } = createContext({
    problematicFiles: [
      { key: 'album-1', problem_reasons: ['Poor art quality', 'Missing year'] },
      { key: 'album-2', problem_reasons: ['Missing cover art'] },
    ],
    selectedProblematicKey: 'album-1',
  });
  const filterContainer = createElement();
  const { event, wasPrevented } = createEvent({
    '.utility-problem-filter-button, .utility-problem-filter-menu, .utility-problem-filter-chips': filterContainer,
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Poor art quality',
    }),
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Poor art quality']);
  assert.equal(context.state.utility.deferProblematicAutoSelection, true);
  assert.equal(context.state.utility.selectedProblematicKey, 'album-1');
  assert.equal(context.state.utility.problemDropdownOpen, false);
  assert.equal(context.state.utility.showRepairedDisplay, true);
  assert.equal(calls.renders, 1);
});

test('applying a problem filter clears the selected album in the live bootstrap handler when it no longer matches', () => {
  const { context } = createContext({
    problematicFiles: [
      { key: 'album-1', problem_reasons: ['Missing cover art'] },
      { key: 'album-2', problem_reasons: ['Poor art quality'] },
    ],
    selectedProblematicKey: 'album-1',
  });
  const filterContainer = createElement();
  const { event } = createEvent({
    '.utility-problem-filter-button, .utility-problem-filter-menu, .utility-problem-filter-chips': filterContainer,
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Poor art quality',
    }),
  });

  context.handleUtilityBootstrapClick(event);

  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Poor art quality']);
  assert.equal(context.state.utility.deferProblematicAutoSelection, true);
  assert.equal(context.state.utility.selectedProblematicKey, '');
  assert.equal(context.state.utility.problemDropdownOpen, false);
});

test('applying a problem filter preserves a matching hydrated off-page selection', async () => {
  const { context } = createContext({
    problematicFiles: [{ key: 'first-page', problem_reasons: ['Missing cover art'] }],
    selectedProblematicKey: 'off-page',
    selectedProblematicDetail: {
      key: 'off-page',
      detail_loaded: true,
      problem_reasons: ['Poor art quality', 'Missing year'],
    },
  });
  const filterContainer = createElement();
  const { event } = createEvent({
    '.utility-problem-filter-button, .utility-problem-filter-menu, .utility-problem-filter-chips': filterContainer,
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Poor art quality',
    }),
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(context.state.utility.selectedProblematicKey, 'off-page');
});

test('applying a problem filter clears a nonmatching hydrated off-page selection', async () => {
  const { context } = createContext({
    problematicFiles: [{ key: 'first-page', problem_reasons: ['Missing cover art'] }],
    selectedProblematicKey: 'off-page',
    selectedProblematicDetail: {
      key: 'off-page',
      detail_loaded: true,
      problem_reasons: ['Missing year'],
    },
  });
  const filterContainer = createElement();
  const { event } = createEvent({
    '.utility-problem-filter-button, .utility-problem-filter-menu, .utility-problem-filter-chips': filterContainer,
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Poor art quality',
    }),
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(context.state.utility.selectedProblematicKey, '');
});

function knownProblematicRows() {
  return [
    { key: 'year-only', name: 'Selected album', problem_reasons: ['Missing year'] },
    { key: 'encoding-only', name: 'Selected second album', problem_reasons: ['Encoding problem'] },
    { key: 'both', name: 'Other album', problem_reasons: ['Missing year', 'Encoding problem'] },
    { key: 'unrelated', name: 'Selected third album', problem_reasons: ['Missing cover art'] },
  ].map(item => ({ ...item, album_artist: 'Artist', detail_loaded: true, tracks: [] }));
}

function createKnownProblematicContext(utility = {}) {
  const requests = [];
  const renderSnapshots = [];
  const { context, calls } = createContext({
    problematicFiles: knownProblematicRows(),
    problematicFilesComplete: true,
    problematicFilesPageSignature: '',
    problematicFilesProjectionRevision: '11111111-1111-4111-8111-111111111111',
    problematicFilesTotal: 4,
    selectedProblematicKey: 'year-only',
    searchQuery: '',
    loading: false,
    detailLoadPromises: {},
    ...utility,
  });
  const elements = context.getUtilityModalElements();
  context.state.ui = {};
  context.document.body = { classList: { add() {}, remove() {} } };
  context.document.getElementById = () => null;
  Object.assign(elements, {
    overlay: { hidden: false },
    list: { innerHTML: '', scrollTop: 0 },
    detail: { innerHTML: '', removeAttribute() {} },
    count: { textContent: '' },
    search: { value: '', focus() { context.document.activeElement = this; } },
  });
  elements.problemFilterButton.focus = () => {
    context.document.activeElement = elements.problemFilterButton;
  };
  context.fetch = (url) => {
    if (String(url).includes('/detail?')) {
      const selected = context.state.utility.problematicFiles.find(item => item.key === context.state.utility.selectedProblematicKey);
      return Promise.resolve({
        ok: true, status: 200,
        async json() {
          return { ...selected, detail_loaded: true, tracks: [], repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [] };
        },
      });
    }
    let resolve;
    const promise = new Promise(settle => { resolve = settle; });
    requests.push({ url: String(url), resolve });
    return promise;
  };
  loadPendingProjectionFetch(context);
  vm.runInContext(utilityLoadersSource, context, { filename: utilityLoadersPath });
  vm.runInContext(utilityRenderersSource, context, { filename: 'utility-renderers-and-actions.js' });
  // Loading the full utility owner also installs the unrelated Tag Editor closer.
  context.closeTagEditorExceptionMenu = () => {};
  context.buildProblematicAlbumListItem = (album, selected) => (
    `<button data-problematic-album-key="${album.key}" aria-selected="${selected}">${album.name}</button>`
  );
  context.buildProblematicAlbumDetail = album => `<h3>${album.name}</h3>`;
  context.buildOnPageAlertHtml = ({ message }) => `<div role="alert">${message}</div>`;
  calls.toasts = [];
  context.showToast = (...args) => calls.toasts.push(args);
  context.renderUtilityModalContent = (options) => {
    calls.renders += 1;
    context.renderProblematicFiles(options);
    renderSnapshots.push({
      list: elements.list.innerHTML,
      detail: elements.detail.innerHTML,
      count: elements.count.textContent,
    });
  };
  const renderedKeys = () => Array.from(
    elements.list.innerHTML.matchAll(/data-problematic-album-key="([^"]+)"/g),
    match => match[1],
  );
  const filterClick = (reason, remove = false) => createEvent({
    '.utility-problem-filter-button, .utility-problem-filter-menu, .utility-problem-filter-chips': elements.problemFilterMenu,
    [remove ? '[data-remove-problem-filter]' : '[data-problem-filter-value]']: createElement({
      [remove ? 'data-remove-problem-filter' : 'data-problem-filter-value']: reason,
    }),
  }, { detail: 0 }).event;
  const respond = (index, rows, metadata = {}) => {
    if (!requests[index]) return;
    requests[index].resolve({
      ok: true, status: 200,
      async json() {
        const payload = {
          items: rows.map(item => ({ ...item, detail_loaded: false })),
          count: rows.length, total: rows.length, next_cursor: null, complete: true,
          projection_revision: '11111111-1111-4111-8111-111111111111',
          ...metadata,
        };
        if (payload.projection_revision === undefined) delete payload.projection_revision;
        return payload;
      },
    });
  };
  return { context, calls, elements, requests, renderSnapshots, renderedKeys, filterClick, respond };
}

test('P04 a pending reason query immediately renders only known matching rows and count', async () => {
  const h = createKnownProblematicContext();
  const click = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const settled = Promise.allSettled([click]);
  try {
    assert.equal(h.requests.length, 1, 'the filter action must start its bounded request');
    assert.deepEqual(h.renderedKeys(), ['both', 'year-only']);
    assert.equal(h.elements.count.textContent, '2');
    assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /Loading|No matching/);
    assert.equal(h.requests.length, 1);
  } finally {
    h.respond(0, knownProblematicRows().filter(item => item.problem_reasons.includes('Missing year')));
    await settled;
  }
  assert.equal((await settled)[0].status, 'fulfilled');
});

test('P04 keyboard filter focus is restored before the response and never stolen back afterward', async () => {
  const h = createKnownProblematicContext();
  const click = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const settled = Promise.allSettled([click]);
  let immediateFocus;
  try {
    assert.equal(h.requests.length, 1, 'the keyboard filter action must start its bounded request');
    immediateFocus = h.context.document.activeElement;
    assert.equal(h.renderSnapshots.length, 1, 'one synchronous loader render owns the pending view');
    h.elements.search.focus();
  } finally {
    h.respond(0, knownProblematicRows().filter(item => item.problem_reasons.includes('Missing year')));
    await settled;
  }
  assert.equal((await settled)[0].status, 'fulfilled');
  assert.equal(immediateFocus, h.elements.problemFilterButton, 'keyboard return focus must not await HTTP');
  assert.equal(h.context.document.activeElement, h.elements.search, 'a late filter completion cannot steal later search focus');
});

test('P04 clearing a narrowed query immediately restores the known base while its request is pending', async () => {
  const h = createKnownProblematicContext();
  const original = h.context.state.utility.problematicFiles;
  const narrow = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const narrowed = Promise.allSettled([narrow]);
  try {
    assert.equal(h.requests.length, 1, 'narrowing must start its bounded request');
  } finally {
    h.respond(0, knownProblematicRows().filter(item => item.problem_reasons.includes('Missing year')));
    await narrowed;
  }
  assert.equal((await narrowed)[0].status, 'fulfilled');
  const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
  const cleared = Promise.allSettled([clear]);
  try {
    assert.equal(h.requests.length, 2, 'clearing must start a distinct bounded request');
    assert.deepEqual(h.renderedKeys(), ['year-only', 'encoding-only', 'both', 'unrelated']);
    assert.equal(h.elements.count.textContent, '4');
    assert.equal(original.length, 4, 'query replacement must not mutate the retained source array');
    assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /Loading|No matching/);
    assert.equal(h.requests.length, 2);
  } finally {
    h.respond(1, knownProblematicRows());
    await cleared;
  }
  assert.equal((await cleared)[0].status, 'fulfilled');
});

test('P04 an uncached track search renders loading rather than unrelated rows or a false empty result', async () => {
  const h = createKnownProblematicContext({
    problematicFiles: [{ key: 'unhydrated', name: 'Known album', album_artist: 'Artist', problem_reasons: ['Missing year'], detail_loaded: false }],
    problematicFilesTotal: 1,
    selectedProblematicKey: '',
    searchQuery: 'Uncached track title',
  });
  const loading = h.context.loadProblematicFiles(true);
  try {
    assert.deepEqual(h.renderedKeys(), []);
    assert.match(h.elements.list.innerHTML + h.elements.detail.innerHTML, /Loading/);
    assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /No matching problematic albums/);
  } finally {
    h.respond(0, []);
    await loading;
  }
});

test('P04 a complete known empty answer stays empty without loading during revalidation', async () => {
  const h = createKnownProblematicContext({
    problematicFiles: [], problematicFilesTotal: 0, selectedProblematicKey: '',
  });
  const loading = h.context.loadProblematicFiles(true);
  try {
    assert.match(h.elements.list.innerHTML, /No matching problematic albums/);
    assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /Loading/);
  } finally {
    h.respond(0, []);
    await loading;
  }
});

test('P04 an obsolete reason response cannot replace a newer query or refocus its filter button', async () => {
  const h = createKnownProblematicContext();
  const first = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const second = h.context.handleUtilityBootstrapClick(h.filterClick('Encoding problem'));
  const firstSettled = Promise.allSettled([first]);
  const secondSettled = Promise.allSettled([second]);
  h.elements.search.focus();
  try {
    assert.equal(h.requests.length, 2, 'the newer filter must not wait for the obsolete request');
    h.respond(1, knownProblematicRows().filter(item => item.key !== 'unrelated'));
    await secondSettled;
    assert.equal((await secondSettled)[0].status, 'fulfilled');
    const currentList = h.elements.list.innerHTML;
    h.respond(0, knownProblematicRows().filter(item => item.key === 'year-only'));
    await firstSettled;
    assert.equal((await firstSettled)[0].status, 'fulfilled');
    assert.equal(h.elements.list.innerHTML, currentList);
    assert.deepEqual(h.renderedKeys().slice().sort(), ['both', 'encoding-only', 'year-only']);
    assert.equal(h.context.document.activeElement, h.elements.search);
  } finally {
    h.respond(0, []);
    h.respond(1, []);
    await Promise.all([firstSettled, secondSettled]);
  }
});

test('P04 clearing a narrowed query retains all 51 already known rows without growing their source array', async () => {
  const rows = [
    ...knownProblematicRows(),
    ...Array.from({ length: 47 }, (_, index) => ({
      key: `known-${index}`, name: `Known album ${index}`, album_artist: 'Artist',
      problem_reasons: ['Missing cover art'], detail_loaded: true, tracks: [],
    })),
  ];
  const h = createKnownProblematicContext({ problematicFiles: rows, problematicFilesTotal: 51 });
  const sourceKeys = rows.map(item => item.key);
  const narrow = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const narrowed = Promise.allSettled([narrow]);
  try {
    assert.equal(h.requests.length, 1);
  } finally {
    h.respond(0, rows.filter(item => item.problem_reasons.includes('Missing year')));
    await narrowed;
  }
  assert.equal((await narrowed)[0].status, 'fulfilled');
  const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
  const cleared = Promise.allSettled([clear]);
  try {
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.renderedKeys(), sourceKeys, 'the 51st known row cannot be reclassified as uncached');
    assert.equal(h.elements.count.textContent, '51');
    assert.deepEqual(rows.map(item => item.key), sourceKeys, 'a narrowed response cannot append to or reorder the retained source');
  } finally {
    h.respond(1, rows.slice(0, 50), { total: 51, next_cursor: 'last-known-row', complete: false });
    await cleared;
  }
  assert.equal((await cleared)[0].status, 'fulfilled');
  assert.deepEqual(rows.map(item => item.key), sourceKeys);
});

for (const hasKnownMatch of [true, false]) {
  test(`P04 clearing an initially filtered page ${hasKnownMatch ? 'retains its known row' : 'loads genuinely absent rows'} without claiming completeness`, async () => {
    const rows = hasKnownMatch ? knownProblematicRows().slice(0, 1) : [];
    const h = createKnownProblematicContext({
      problematicFiles: rows, problematicFilesTotal: rows.length,
      problematicFilesPageSignature: JSON.stringify({ query: '', reasons: ['Missing year'] }),
      selectedProblemFilters: ['Missing year'], selectedProblematicKey: '',
    });
    const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
    const settled = Promise.allSettled([clear]);
    try {
      assert.equal(h.requests.length, 1);
      assert.deepEqual(h.renderedKeys(), rows.map(item => item.key));
      assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /No matching problematic albums/);
      if (!hasKnownMatch) assert.match(h.elements.list.innerHTML + h.elements.detail.innerHTML, /Loading/);
    } finally {
      h.respond(0, knownProblematicRows());
      await settled;
    }
    assert.equal((await settled)[0].status, 'fulfilled');
    assert.deepEqual(h.renderedKeys().slice().sort(), ['both', 'encoding-only', 'unrelated', 'year-only']);
  });
}

test('P04 close and reopen retain valid known data while an old opening cannot commit or steal focus', async () => {
  const h = createKnownProblematicContext();
  const originalRows = h.context.state.utility.problematicFiles;
  const pending = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const settled = Promise.allSettled([pending]);
  let reopenedList;
  try {
    assert.equal(h.requests.length, 1);
    h.context.closeUtilityModal();
    assert.equal(h.elements.overlay.hidden, true);
    h.context.openUtilityModal({ resetSearch: false, resetSelection: false, forceLoad: false });
    assert.equal(h.elements.overlay.hidden, false);
    assert.equal(h.context.state.utility.problematicFiles, originalRows, 'closing UI must not evict valid known facts');
    reopenedList = h.elements.list.innerHTML;
    h.elements.search.focus();
  } finally {
    h.respond(0, [{ key: 'old-opening', name: 'Obsolete opening', problem_reasons: ['Missing year'] }]);
    await settled;
  }
  assert.equal((await settled)[0].status, 'fulfilled');
  assert.equal(h.elements.list.innerHTML, reopenedList);
  assert.equal(h.context.state.utility.problematicFiles, originalRows);
  assert.equal(h.context.document.activeElement, h.elements.search);
});

test('P04 a completed repair retires its old known base before clearing the filter', async () => {
  const h = createKnownProblematicContext();
  const original = h.context.state.utility.problematicFiles;
  const narrow = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const narrowed = Promise.allSettled([narrow]);
  h.respond(0, knownProblematicRows().filter(item => item.problem_reasons.includes('Missing year')));
  await narrowed;
  assert.equal((await narrowed)[0].status, 'fulfilled');
  const repaired = h.context.state.utility.problematicFiles.find(item => item.key === 'year-only');
  h.context.applyRepairResultToProblematicFiles(repaired, null);
  assert.deepEqual(h.renderedKeys(), ['both']);
  const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
  const cleared = Promise.allSettled([clear]);
  try {
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.renderedKeys(), ['both'], 'repaired or unverified old-base rows must not be resurrected');
    assert.deepEqual(original.map(item => item.key), ['year-only', 'encoding-only', 'both', 'unrelated']);
  } finally {
    h.respond(1, knownProblematicRows().filter(item => item.key === 'both'));
    await cleared;
  }
  assert.equal((await cleared)[0].status, 'fulfilled');
});

test('P04 an unchanged committed summary keeps an unopened track-title match absent from its visible fields', () => {
  // Main's unopened summary indexed this track title; bounded summaries omit search_text.
  const summary = {
    key: 'unopened-track-title-match', name: 'Neutral album', album_artist: 'Release Artist',
    problem_reasons: ['Missing year', 'Encoding problem'], detail_loaded: false,
  };
  const h = createKnownProblematicContext({
    problematicFiles: [summary], problematicFilesTotal: 1,
    selectedProblematicKey: '', selectedProblemFilters: ['Missing year'],
    searchQuery: 'Hidden track title', deferProblematicAutoSelection: true,
  });
  h.context.state.utility.problematicFilesPageSignature = h.context.getProblematicFilesPageFilter();
  assert.equal(JSON.stringify(summary).includes('Hidden track title'), false);

  h.context.renderProblematicFiles();

  assert.deepEqual(h.renderedKeys(), [summary.key]);
  assert.equal(h.elements.count.textContent, '1');
  assert.doesNotMatch(h.elements.list.innerHTML, /Loading|No matching problematic albums/);
  assert.equal(h.requests.length, 0, 'a committed query must not refetch to re-prove a server-known match');
});

test('P04 a repaired row that still has other problems leaves the active reason filter and preserves remaining matches', () => {
  const changed = {
    key: 'changed', name: 'Changed album', album_artist: 'Artist',
    problem_reasons: ['Missing year', 'Encoding problem'], detail_loaded: true, tracks: [],
  };
  const remaining = {
    key: 'remaining', name: 'Remaining album', album_artist: 'Artist',
    problem_reasons: ['Missing year'], detail_loaded: true, tracks: [],
  };
  const h = createKnownProblematicContext({
    problematicFiles: [changed, remaining], problematicFilesTotal: 2,
    selectedProblematicKey: changed.key, selectedProblemFilters: ['Missing year'],
    problematicFilesPageSignature: JSON.stringify({ query: '', reasons: ['Missing year'] }),
  });
  h.context.renderProblematicFiles();
  assert.deepEqual(h.renderedKeys(), [changed.key, remaining.key]);

  h.context.applyRepairResultToProblematicFiles(changed, {
    ...changed, problem_reasons: ['Encoding problem'],
  });

  assert.deepEqual(h.renderedKeys(), [remaining.key]);
  assert.equal(h.elements.count.textContent, '1');
  assert.match(h.elements.detail.innerHTML, /Remaining album/);
  assert.doesNotMatch(h.elements.list.innerHTML, /Changed album/);
  assert.deepEqual(
    Array.from(h.context.state.utility.problematicFiles, item => item.key),
    [changed.key, remaining.key],
    'repairing one reason must not delete an album that still has another problem',
  );
});

test('P04 clicking an unhydrated known-base row renders its named detail before the clear-query response settles', async () => {
  const rows = knownProblematicRows();
  const cachedB = rows.find(item => item.key === 'encoding-only');
  Object.assign(cachedB, { name: 'Cached B', projection_id: 'h1:cached-b', detail_loaded: false });
  const h = createKnownProblematicContext({ problematicFiles: rows });
  const detailRequests = [];
  const fetch = h.context.fetch;
  h.context.fetch = (url, options) => {
    const request = new URL(String(url), 'http://example.test');
    if (request.pathname === '/utilities/problematic-files/detail'
        && (request.searchParams.get('album_key') === cachedB.key
          || request.searchParams.get('projection_id') === cachedB.projection_id)) {
      let resolve;
      const promise = new Promise(settle => { resolve = settle; });
      detailRequests.push({ url: String(url), resolve });
      return promise;
    }
    return fetch(url, options);
  };
  h.context.buildProblematicAlbumDetail = album => (
    `<h3>${album.name}</h3>${album.tracks.map(track => `<span>${track.title}</span>`).join('')}`
  );
  const detailResponse = {
    ok: true, status: 200,
    async json() {
      return {
        key: cachedB.key, projection_id: cachedB.projection_id, name: 'Cached B',
        detail_loaded: true, tracks: [{ path: 'cached-b-track', title: 'Named B track' }],
        repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
      };
    },
  };
  const narrow = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const narrowed = Promise.allSettled([narrow]);
  h.respond(0, rows.filter(item => item.problem_reasons.includes('Missing year')));
  await narrowed;
  assert.equal((await narrowed)[0].status, 'fulfilled');
  assert.equal(h.context.state.utility.problematicFiles.some(item => item.key === cachedB.key), false);
  const base = h.context.state.utility.problematicKnownBase;
  assert.ok(base, 'a narrowed page must retain its already known unfiltered source');
  const baseItems = base.items;
  const baseKeys = Array.from(baseItems, item => item.key);
  const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
  const cleared = Promise.allSettled([clear]);
  const details = [];
  try {
    assert.equal(h.requests.length, 2);
    assert.ok(h.renderedKeys().includes(cachedB.key));
    const click = h.context.handleUtilityBootstrapClick(createEvent({
      '[data-problematic-album-key]': createElement({ 'data-problematic-album-key': cachedB.key }),
    }).event);
    const clicked = await Promise.allSettled([click]);
    assert.equal(clicked[0].status, 'fulfilled');
    const pendingDetail = h.context.state.utility.detailLoadPromises[cachedB.key];
    assert.ok(pendingDetail, 'the normal row click must own a real detail request');
    details.push(Promise.allSettled([pendingDetail]));
    assert.equal(detailRequests.length, 1);
    detailRequests[0].resolve(detailResponse);
    await details[0];

    assert.match(h.elements.detail.innerHTML, /<h3>Cached B<\/h3>/);
    assert.match(h.elements.detail.innerHTML, /Named B track/);
    assert.doesNotMatch(h.elements.detail.innerHTML, /Loading selected problematic album/);
    assert.equal(h.context.getSelectedProblematicAlbum()?.key, cachedB.key);
    assert.equal(h.context.getSelectedProblematicAlbum()?.detail_loaded, true);
    assert.equal(detailRequests.length, 1, 'rendering hydrated known detail must not refetch it');
    assert.equal(detailRequests[0].url, '/utilities/problematic-files/detail?projection_id=h1%3Acached-b');
    assert.equal(h.requests.length, 2, 'the clear-query summary is still pending');
    assert.equal(h.context.state.utility.problematicKnownBase.items, baseItems);
    assert.deepEqual(Array.from(baseItems, item => item.key), baseKeys);
    assert.equal(baseItems.length, base.maximumRows);
    assert.equal(h.context.state.utility.problematicFiles.some(item => item.key === cachedB.key), false,
      'selected off-page detail must not be appended to the authoritative narrowed page');
  } finally {
    // Stop presentation before settling any retry exposed by the broken loader.
    h.context.state.utility.activeTab = 'rules';
    h.context.closeUtilityModal();
    for (const request of detailRequests) request.resolve(detailResponse);
    const pendingDetail = h.context.state.utility.detailLoadPromises[cachedB.key];
    if (pendingDetail) details.push(Promise.allSettled([pendingDetail]));
    h.respond(1, []);
    await Promise.all([cleared, ...details]);
  }
});

test('P04 excluding the searched Missing year reason hides only the changed album while other problems remain', async () => {
  const changed = {
    key: 'excluded-search-match', name: 'Neutral album', album_artist: 'Artist',
    problem_reasons: ['Missing year', 'Encoding problem'], detail_loaded: true,
    tracks: [{ path: 'track-1', title: 'Neutral track' }],
    album_problem_rows: [
      { row_key: 'album::changed::year', album_key: 'excluded-search-match', reason: 'Missing year' },
      { row_key: 'album::changed::encoding', album_key: 'excluded-search-match', reason: 'Encoding problem' },
    ],
    track_problem_rows: [{
      path: 'track-1', reasons: ['Missing year', 'Encoding problem'],
      ignorable_reasons: [
        { row_key: 'track-1::year', reason: 'Missing year' },
        { row_key: 'track-1::encoding', reason: 'Encoding problem' },
      ],
    }],
  };
  const remaining = {
    key: 'remaining-search-match', name: 'Remaining album', album_artist: 'Artist',
    problem_reasons: ['Missing year'], detail_loaded: true, tracks: [],
  };
  const h = createKnownProblematicContext({
    problematicFiles: [changed, remaining], problematicFilesTotal: 2,
    selectedProblematicKey: changed.key, searchQuery: 'Missing year', selectedProblemFilters: [],
  });
  h.context.state.utility.problematicFilesPageSignature = h.context.getProblematicFilesPageFilter();
  const mutationsPath = path.join(path.dirname(utilityLoadersPath), 'problem-exclusion-mutations.js');
  vm.runInContext(fs.readFileSync(mutationsPath, 'utf8'), h.context, { filename: mutationsPath });
  h.context.closeRepairConfirmModal = () => {};
  let resolvePost;
  const posts = [];
  const fetch = h.context.fetch;
  h.context.fetch = (url, options) => {
    if (String(url) !== '/utilities/rules/problem-ignores') return fetch(url, options);
    posts.push({ url: String(url), body: JSON.parse(options.body) });
    return new Promise(resolve => { resolvePost = resolve; });
  };
  h.context.renderProblematicFiles();
  assert.deepEqual(h.renderedKeys(), [changed.key, remaining.key]);
  const item = { row_key: 'album::changed::year', scope: 'album', album_key: changed.key, problem_reason: 'Missing year' };
  const completion = h.context.queueProblemExclusionCreate({ album: changed, items: [item] });
  const settled = Promise.allSettled([completion]);
  try {
    assert.equal(posts.length, 1, 'the real exclusion owner must enqueue the normal write request');
    const projected = h.context.state.utility.problematicFiles.find(album => album.key === changed.key);
    assert.deepEqual(Array.from(projected.problem_reasons), ['Encoding problem']);
    assert.deepEqual(Array.from(projected.track_problem_rows[0].reasons), ['Encoding problem']);
    assert.deepEqual(h.renderedKeys(), [remaining.key]);
    assert.equal(h.elements.count.textContent, '1');
    assert.match(h.elements.detail.innerHTML, /Remaining album/);
    assert.doesNotMatch(h.elements.list.innerHTML, /Neutral album/);
  } finally {
    h.context.state.utility.activeTab = 'rules';
    if (resolvePost) resolvePost({ ok: true, async json() { return { ok: true, applied_items: [{ ...item, pending: false }] }; } });
    await settled;
  }
  assert.equal((await settled)[0].status, 'fulfilled');
});

test('P04 repairing a searched artist value removes its old repair-fact match without deleting other problems', () => {
  const titleRepair = { path: 'track-1', field: 'title', track_title: 'Neutral Ã©', original: 'Neutral Ã©', repaired: 'Neutral é' };
  const changed = {
    key: 'repaired-search-match', name: 'Neutral album', album_artist: 'Artist',
    problem_reasons: ['Encoding problem'], detail_loaded: true,
    tracks: [{ path: 'track-1', title: 'Neutral Ã©', artist: 'JosÃ©' }],
    repair_preview_rows: [
      { path: 'track-1', field: 'artist', track_title: 'Neutral Ã©', original: 'JosÃ©', repaired: 'José' },
      titleRepair,
    ],
  };
  const remaining = {
    key: 'remaining-repaired-search-match', name: 'José control', album_artist: 'Artist',
    problem_reasons: ['Encoding problem'], detail_loaded: true, tracks: [],
  };
  const h = createKnownProblematicContext({
    problematicFiles: [changed, remaining], problematicFilesTotal: 2,
    selectedProblematicKey: changed.key, searchQuery: 'José', selectedProblemFilters: [],
  });
  h.context.state.utility.problematicFilesPageSignature = h.context.getProblematicFilesPageFilter();
  h.context.renderProblematicFiles();
  assert.deepEqual(h.renderedKeys(), [changed.key, remaining.key]);

  h.context.applyRepairResultToProblematicFiles(changed, {
    ...changed,
    tracks: [{ path: 'track-1', title: 'Neutral Ã©', artist: 'José' }],
    repair_preview_rows: [titleRepair],
  });

  assert.deepEqual(h.renderedKeys(), [remaining.key]);
  assert.equal(h.elements.count.textContent, '1');
  assert.match(h.elements.detail.innerHTML, /José control/);
  const repaired = h.context.state.utility.problematicFiles.find(album => album.key === changed.key);
  assert.deepEqual(Array.from(repaired.problem_reasons), ['Encoding problem']);
  assert.equal(repaired.tracks[0].artist, 'José');
});

test('P04 cached-only B and C details remain immediately usable when returning to B during a pending clear query', async () => {
  const rows = knownProblematicRows();
  const b = rows.find(item => item.key === 'encoding-only');
  const c = rows.find(item => item.key === 'unrelated');
  Object.assign(b, { name: 'Cached B', projection_id: 'h1:cached-b', detail_loaded: false });
  Object.assign(c, { name: 'Cached C', projection_id: 'h1:cached-c', detail_loaded: false });
  const h = createKnownProblematicContext({ problematicFiles: rows });
  const detailRequests = [];
  const fetch = h.context.fetch;
  h.context.fetch = (url, options) => {
    const request = new URL(String(url), 'http://example.test');
    const album = [b, c].find(item => request.searchParams.get('projection_id') === item.projection_id
      || request.searchParams.get('album_key') === item.key);
    if (request.pathname !== '/utilities/problematic-files/detail' || !album) return fetch(url, options);
    detailRequests.push(album.key);
    return Promise.resolve({
      ok: true, status: 200,
      async json() {
        return {
          key: album.key, projection_id: album.projection_id, name: album.name, detail_loaded: true,
          tracks: [{ path: `${album.key}-track`, title: `${album.name} named track` }],
          repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
        };
      },
    });
  };
  h.context.buildProblematicAlbumDetail = album => `<h3>${album.name}</h3>${album.tracks.map(track => `<span>${track.title}</span>`).join('')}`;
  const narrow = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
  const narrowed = Promise.allSettled([narrow]);
  h.respond(0, rows.filter(item => item.problem_reasons.includes('Missing year')));
  await narrowed;
  assert.equal((await narrowed)[0].status, 'fulfilled');
  const base = h.context.state.utility.problematicKnownBase;
  const baseItems = base.items;
  const baseKeys = Array.from(baseItems, item => item.key);
  const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
  const cleared = Promise.allSettled([clear]);
  let returned;
  try {
    assert.equal(h.requests.length, 2);
    for (const album of [b, c]) {
      const click = h.context.handleUtilityBootstrapClick(createEvent({
        '[data-problematic-album-key]': createElement({ 'data-problematic-album-key': album.key }),
      }).event);
      const pending = h.context.state.utility.detailLoadPromises[album.key];
      assert.ok(pending, 'each initially cold known row must own its first detail request');
      await Promise.all([click, pending]);
      assert.match(h.elements.detail.innerHTML, new RegExp(`${album.name} named track`));
    }
    assert.deepEqual(detailRequests, [b.key, c.key]);
    returned = h.context.handleUtilityBootstrapClick(createEvent({
      '[data-problematic-album-key]': createElement({ 'data-problematic-album-key': b.key }),
    }).event);
    const immediate = h.elements.detail.innerHTML;
    await returned;
    assert.match(immediate, /<h3>Cached B<\/h3>/);
    assert.match(immediate, /Cached B named track/);
    assert.doesNotMatch(immediate, /Loading/);
    assert.deepEqual(detailRequests, [b.key, c.key], 'returning to a known hydrated row must not refetch');
    assert.equal(h.context.state.utility.problematicKnownBase.items, baseItems);
    assert.deepEqual(Array.from(baseItems, item => item.key), baseKeys);
    assert.equal(baseItems.length, base.maximumRows);
    assert.equal(h.requests.length, 2);
    assert.equal(h.context.state.utility.problematicFiles.some(item => item.key === b.key || item.key === c.key), false);
  } finally {
    h.context.state.utility.activeTab = 'rules';
    h.context.closeUtilityModal();
    h.respond(1, []);
    const pending = [b, c].map(album => h.context.state.utility.detailLoadPromises[album.key]).filter(Boolean);
    await Promise.allSettled([cleared, returned, ...pending]);
  }
});

for (const succeeds of [true, false]) {
  test(`P04 legacy detail ${succeeds ? 'success renders named tracks' : 'failure renders a readable alert'} after an absent-revision summary`, async () => {
    const summary = { key: 'legacy-selected', name: 'Legacy album', album_artist: 'Artist', problem_reasons: ['Missing year'] };
    const h = createKnownProblematicContext({
      problematicFiles: [], loaded: false, problematicFilesComplete: false,
      problematicFilesTotal: 0, selectedProblematicKey: '',
    });
    let resolveDetail;
    const detailRequests = [];
    const fetch = h.context.fetch;
    h.context.fetch = (url, options) => {
      if (!String(url).startsWith('/utilities/problematic-files/detail?')) return fetch(url, options);
      detailRequests.push(String(url));
      return new Promise(resolve => { resolveDetail = resolve; });
    };
    h.context.buildProblematicAlbumDetail = album => `<h3>${album.name}</h3>${album.tracks.map(track => `<span>${track.title}</span>`).join('')}`;
    const response = {
      ok: succeeds, status: succeeds ? 200 : 500,
      async json() {
        return succeeds ? {
          ...summary, detail_loaded: true,
          tracks: [{ path: 'legacy-track', title: 'Named legacy track' }],
          repair_preview_rows: [], track_problem_rows: [], problematic_track_paths: [],
        } : { ok: false, error: 'Legacy detail temporarily unavailable' };
      },
    };
    const summaryLoad = h.context.loadProblematicFiles(true);
    const loaded = Promise.allSettled([summaryLoad]);
    let pendingDetail;
    try {
      h.respond(0, [summary], { projection_revision: undefined });
      await loaded;
      assert.equal((await loaded)[0].status, 'fulfilled');
      assert.equal(h.context.state.utility.problematicFilesProjectionRevision, '');
      assert.equal(detailRequests.length, 1);
      assert.match(h.elements.detail.innerHTML, /Loading selected problematic album/);
      pendingDetail = h.context.state.utility.detailLoadPromises[summary.key];
      assert.ok(pendingDetail, 'legacy detail must own a normal pending request');
      resolveDetail(response);
      await pendingDetail;

      if (succeeds) {
        assert.equal(h.context.state.utility.problematicFiles[0].detail_loaded, true);
        assert.match(h.elements.detail.innerHTML, /<h3>Legacy album<\/h3>/);
        assert.match(h.elements.detail.innerHTML, /Named legacy track/);
        assert.deepEqual(h.calls.toasts, []);
      } else {
        assert.equal(h.context.state.utility.problematicFiles[0].detail_load_failed, true);
        assert.match(h.elements.detail.innerHTML, /Unable to load the selected problematic album/);
        assert.equal(h.calls.toasts.length, 1);
      }
      assert.doesNotMatch(h.elements.detail.innerHTML, /Loading selected problematic album/);
      assert.equal(detailRequests.length, 1);
    } finally {
      h.context.state.utility.activeTab = 'rules';
      h.context.closeUtilityModal();
      if (resolveDetail) resolveDetail(response);
      h.respond(0, []);
      await Promise.allSettled([loaded, pendingDetail]);
    }
  });
}

test('P04 excluding the last provisional cached problem keeps an uncached clear-query answer loading', async () => {
  const b = {
    key: 'partial-encoding-b', name: 'Partial cached B', album_artist: 'Artist',
    problem_reasons: ['Encoding problem'], detail_loaded: true,
    tracks: [{ path: 'partial-b-track', title: 'Partial B track' }],
    album_problem_rows: [{ row_key: 'album::partial-b::encoding', album_key: 'partial-encoding-b', reason: 'Encoding problem' }],
    track_problem_rows: [{
      path: 'partial-b-track', reasons: ['Encoding problem'],
      ignorable_reasons: [{ row_key: 'partial-b-track::encoding', reason: 'Encoding problem' }],
    }],
  };
  const h = createKnownProblematicContext({
    problematicFiles: [b], problematicFilesTotal: 1,
    selectedProblematicKey: b.key, selectedProblemFilters: ['Encoding problem'],
    problematicFilesPageSignature: JSON.stringify({ query: '', reasons: ['Encoding problem'] }),
  });
  const mutationsPath = path.join(path.dirname(utilityLoadersPath), 'problem-exclusion-mutations.js');
  vm.runInContext(fs.readFileSync(mutationsPath, 'utf8'), h.context, { filename: mutationsPath });
  h.context.closeRepairConfirmModal = () => {};
  let resolvePost;
  const posts = [];
  const fetch = h.context.fetch;
  h.context.fetch = (url, options) => {
    if (String(url) !== '/utilities/rules/problem-ignores') return fetch(url, options);
    posts.push(JSON.parse(options.body));
    return new Promise(resolve => { resolvePost = resolve; });
  };
  h.context.state.utility.selectedProblemFilters = ['Missing year'];
  const narrow = h.context.loadProblematicFiles(true);
  const narrowed = Promise.allSettled([narrow]);
  h.respond(0, []);
  await narrowed;
  assert.equal((await narrowed)[0].status, 'fulfilled');
  assert.equal(h.context.state.utility.problematicFiles.length, 0);
  const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
  const cleared = Promise.allSettled([clear]);
  const item = { row_key: 'album::partial-b::encoding', scope: 'album', album_key: b.key, problem_reason: 'Encoding problem' };
  let excluded;
  try {
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.renderedKeys(), [b.key]);
    assert.equal(h.context.getProblematicKnownView().pending, true, 'an initially filtered base cannot prove the unfiltered result');
    excluded = Promise.allSettled([h.context.queueProblemExclusionCreate({ album: b, items: [item] })]);
    assert.equal(posts.length, 1);
    assert.equal(h.context.state.utility.problematicFiles.some(album => album.key === b.key), false);
    assert.deepEqual(h.renderedKeys(), []);
    assert.match(h.elements.list.innerHTML + h.elements.detail.innerHTML, /Loading/);
    assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /No matching problematic albums/);
    assert.equal(h.requests.length, 2, 'the unfiltered summary must still be unresolved');
  } finally {
    h.context.state.utility.activeTab = 'rules';
    h.context.closeUtilityModal();
    if (resolvePost) resolvePost({ ok: true, async json() { return { ok: true, applied_items: [{ ...item, pending: false }] }; } });
    h.respond(1, []);
    await Promise.allSettled([cleared, excluded]);
  }
});

test('P04 excluding the last complete-cache problem immediately renders a known empty answer during revalidation', async () => {
  const b = {
    key: 'complete-encoding-b', name: 'Complete cached B', album_artist: 'Artist',
    problem_reasons: ['Encoding problem'], detail_loaded: true,
    tracks: [{ path: 'complete-b-track', title: 'Complete B track' }],
    album_problem_rows: [{ row_key: 'album::complete-b::encoding', album_key: 'complete-encoding-b', reason: 'Encoding problem' }],
    track_problem_rows: [{
      path: 'complete-b-track', reasons: ['Encoding problem'],
      ignorable_reasons: [{ row_key: 'complete-b-track::encoding', reason: 'Encoding problem' }],
    }],
  };
  const h = createKnownProblematicContext({
    problematicFiles: [b], problematicFilesTotal: 1,
    selectedProblematicKey: b.key, selectedProblemFilters: [],
    problematicFilesPageSignature: '', problematicFilesComplete: true,
  });
  const mutationsPath = path.join(path.dirname(utilityLoadersPath), 'problem-exclusion-mutations.js');
  vm.runInContext(fs.readFileSync(mutationsPath, 'utf8'), h.context, { filename: mutationsPath });
  h.context.closeRepairConfirmModal = () => {};
  let resolvePost;
  const posts = [];
  const fetch = h.context.fetch;
  h.context.fetch = (url, options) => {
    if (String(url) !== '/utilities/rules/problem-ignores') return fetch(url, options);
    posts.push(JSON.parse(options.body));
    return new Promise(resolve => { resolvePost = resolve; });
  };
  h.context.state.utility.selectedProblemFilters = ['Missing year'];
  const narrow = h.context.loadProblematicFiles(true);
  const narrowed = Promise.allSettled([narrow]);
  h.respond(0, []);
  await narrowed;
  assert.equal((await narrowed)[0].status, 'fulfilled');
  const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
  const cleared = Promise.allSettled([clear]);
  const item = { row_key: 'album::complete-b::encoding', scope: 'album', album_key: b.key, problem_reason: 'Encoding problem' };
  let excluded;
  try {
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.renderedKeys(), [b.key]);
    assert.equal(h.context.getProblematicKnownView().pending, false, 'the complete unfiltered base already proves this answer');
    excluded = Promise.allSettled([h.context.queueProblemExclusionCreate({ album: b, items: [item] })]);
    assert.equal(posts.length, 1);
    assert.equal(h.context.state.utility.problematicFiles.some(album => album.key === b.key), false);
    assert.deepEqual(h.renderedKeys(), []);
    assert.equal(h.elements.count.textContent, '0');
    assert.match(h.elements.list.innerHTML, /No matching problematic albums/);
    assert.doesNotMatch(h.elements.list.innerHTML + h.elements.detail.innerHTML, /Loading/);
    assert.equal(h.requests.length, 2, 'known emptiness must render before the clear-query response');
  } finally {
    h.context.state.utility.activeTab = 'rules';
    h.context.closeUtilityModal();
    if (resolvePost) resolvePost({ ok: true, async json() { return { ok: true, applied_items: [{ ...item, pending: false }] }; } });
    h.respond(1, []);
    await Promise.allSettled([cleared, excluded]);
  }
});

test('P04 the existing canonical page filter represents an empty query and no reasons consistently', () => {
  const h = createKnownProblematicContext();
  const empty = h.context.getProblematicFilesPageFilter();
  assert.equal(empty, '');
  h.context.state.utility.searchQuery = ' \t\n ';
  assert.equal(h.context.getProblematicFilesPageFilter(), empty);
  h.context.state.utility.selectedProblemFilters = ['Missing year'];
  assert.notEqual(h.context.getProblematicFilesPageFilter(), empty);
  h.context.state.utility.selectedProblemFilters = [];
  assert.equal(h.context.getProblematicFilesPageFilter(), empty);
});

for (const revision of [undefined, '22222222-2222-4222-8222-222222222222']) {
  test(`P04 ${revision === undefined ? 'an absent' : 'a changed'} projection revision cannot certify an older known base`, async () => {
    const h = createKnownProblematicContext();
    const narrow = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year'));
    const narrowed = Promise.allSettled([narrow]);
    h.respond(0, knownProblematicRows().filter(item => item.problem_reasons.includes('Missing year')));
    await narrowed;
    assert.equal((await narrowed)[0].status, 'fulfilled');
    const fresh = [{ key: 'fresh-only', name: 'Fresh known album', album_artist: 'Artist', problem_reasons: ['Missing year'] }];
    const refresh = h.context.loadProblematicFiles(true, { preserveSelectedDetail: true });
    const refreshed = Promise.allSettled([refresh]);
    h.respond(1, fresh, { projection_revision: revision });
    await refreshed;
    assert.equal((await refreshed)[0].status, 'fulfilled');
    assert.deepEqual(h.calls.toasts, [], 'an absent revision retains old-server response compatibility');
    const clear = h.context.handleUtilityBootstrapClick(h.filterClick('Missing year', true));
    const cleared = Promise.allSettled([clear]);
    try {
      assert.equal(h.requests.length, 3);
      assert.deepEqual(h.renderedKeys(), ['fresh-only'], 'unverified old rows cannot reappear after scope replacement');
    } finally {
      h.respond(2, fresh, { projection_revision: revision });
      await cleared;
    }
    assert.equal((await cleared)[0].status, 'fulfilled');
  });
}

for (const revision of [null, 7, 'not-a-uuid']) {
  test(`P04 a present malformed projection revision ${JSON.stringify(revision)} produces a readable payload failure`, async () => {
    const h = createKnownProblematicContext();
    const pending = h.context.loadProblematicFiles(true);
    const settled = Promise.allSettled([pending]);
    h.respond(0, knownProblematicRows(), { projection_revision: revision });
    await settled;
    assert.equal((await settled)[0].status, 'fulfilled', 'payload failure must be handled by the existing loader');
    assert.equal(h.context.state.utility.problematicDiagnostics.summaryLoad.ok, false);
    assert.match(h.context.state.utility.problematicDiagnostics.summaryLoad.error, /revision/i);
    assert.equal(h.calls.toasts.length, 1);
  });
}

test('applying a problem filter requests a bounded server-filtered page', async () => {

  const { context, calls } = createContext({
    problematicFiles: [{ key: 'partial', problem_reasons: ['Missing cover art'] }],
    problematicFilesComplete: false,
  });
  const loads = [];
  context.loadProblematicFiles = async (force, options) => {
    loads.push({ force, options, filters: [...context.state.utility.selectedProblemFilters] });
    context.renderUtilityModalContent();
    return context.state.utility.problematicFiles;
  };
  const filterContainer = createElement();
  const { event } = createEvent({
    '.utility-problem-filter-button, .utility-problem-filter-menu, .utility-problem-filter-chips': filterContainer,
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Poor art quality',
    }),
  });

  const click = context.handleUtilityBootstrapClick(event);
  await Promise.resolve();
  assert.equal(calls.renders, 1);
  await click;

  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Poor art quality']);
  assert.deepEqual(JSON.parse(JSON.stringify(loads)), [{
    force: true,
    options: { preserveSelectedDetail: true },
    filters: ['Poor art quality'],
  }]);
  assert.equal(calls.renders, 1);
});

for (const initiallySelected of [false, true]) {
  test(`Suggested Edit drag ${initiallySelected ? 'deselects' : 'selects'} from the origin without reprocessing a crossed label`, () => {
    const { context } = createContext({
      proposalSelections: initiallySelected ? { a: true, b: true, c: true } : {},
    });
    const suggestions = ['a', 'b', 'c'].map((id) => ({ id }));
    const buttons = Object.fromEntries(suggestions.map(({ id }) => [id, createElement({
      'data-problem-suggestion-id': id,
    })]));
    let syncs = 0;
    context.getDraggableProblemSuggestions = () => suggestions;
    context.toggleProblemSuggestion = (id, { selected }) => {
      const selections = { ...(context.state.utility.proposalSelections || {}) };
      if (selected) selections[id] = true;
      else delete selections[id];
      context.state.utility.proposalSelections = selections;
      return true;
    };
    context.syncProblemSuggestionSelection = () => { syncs += 1; };
    const suggestionEvent = (id) => createEvent({
      '[data-problem-suggestion-id]': buttons[id],
    }, { button: 0 }).event;

    context.handleUtilityBootstrapMouseDown(suggestionEvent('a'));
    assert.equal(Boolean(context.state.utility.proposalSelections.a), !initiallySelected);
    assert.equal(context.state.utility.proposalDrag.lastIndex, 0);

    context.handleUtilityBootstrapMouseOver(suggestionEvent('c'));
    assert.deepEqual(
      Object.keys(context.state.utility.proposalSelections).sort(),
      initiallySelected ? [] : ['a', 'b', 'c'],
    );
    assert.equal(context.state.utility.proposalDrag.lastIndex, 2);
    const syncsAfterCrossing = syncs;

    context.handleUtilityBootstrapMouseOver(suggestionEvent('c'));
    assert.equal(syncs, syncsAfterCrossing, 'remaining over the same label must do no work');
  });
}

test('removing a problem filter preserves the selected album in the live bootstrap handler when it still matches', () => {
  const { context } = createContext({
    problematicFiles: [
      { key: 'album-1', problem_reasons: ['Poor art quality', 'Missing year'] },
      { key: 'album-2', problem_reasons: ['Missing year'] },
    ],
    selectedProblematicKey: 'album-1',
    selectedProblemFilters: ['Poor art quality', 'Missing year'],
  });
  const filterContainer = createElement();
  const { event } = createEvent({
    '.utility-problem-filter-button, .utility-problem-filter-menu, .utility-problem-filter-chips': filterContainer,
    '[data-remove-problem-filter]': createElement({
      'data-remove-problem-filter': 'Poor art quality',
    }),
  });

  context.handleUtilityBootstrapClick(event);

  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), ['Missing year']);
  assert.equal(context.state.utility.deferProblematicAutoSelection, true);
  assert.equal(context.state.utility.selectedProblematicKey, 'album-1');
  assert.equal(context.state.utility.problemDropdownOpen, false);
});

test('clicking a problematic album row clears deferred auto-selection in the live bootstrap handler', async () => {
  const { context } = createContext({
    deferProblematicAutoSelection: true,
    focusedTrackPath: 'C:\\Music\\Artist Alpha\\Album Alpha\\18 Late Problem.flac',
  });
  const { event } = createEvent({
    '[data-problematic-album-key]': createElement({
      'data-problematic-album-key': 'album-7',
    }),
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(context.state.utility.selectedProblematicKey, 'album-7');
  assert.equal(context.state.utility.deferProblematicAutoSelection, false);
  assert.equal(context.state.utility.focusedTrackPath, '');
});

test('Problematic Files uses the shared missing-album removal confirmation', () => {
  const album = {
    key: 'transatlantic-roine-stolt-mixes',
    name: 'SMPTe - The Roine Stolt Mixes',
    inventory_status: 'missing',
    missing_since: '2026-09-03T12:00:00Z',
  };
  const { context, calls } = createContext({
    problematicFiles: [album],
    selectedProblematicKey: album.key,
  });
  context.getSelectedProblematicAlbum = () => album;
  const removalButton = createElement({ 'data-remove-missing-album': '1' });
  const { event, wasPrevented } = createEvent({
    '#utility-modal [data-remove-missing-album="1"]': removalButton,
  });

  context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.deepEqual(calls.missingAlbumRemovalConfirms, [{
    album,
    runtimeOptions: { source: 'problematic-files' },
  }]);
});

test('Problematic Files handler leaves Album Details missing-album actions to the gallery handler', async () => {
  const { context, calls } = createContext();
  const { event, wasPrevented } = createEvent({
    '[data-remove-missing-album="1"]': createElement({ 'data-remove-missing-album': '1' }),
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), false);
  assert.deepEqual(calls.missingAlbumRemovalConfirms, []);
});

test('Rules revert preserves the complete current exclusion item for confirmation', async () => {
  const rowKey = 'album::neal-morse-question-2005::undecoded-characters';
  const ruleItem = {
    row_key: rowKey,
    scope: 'album',
    artist: 'Neal Morse',
    album: '?',
    year: '2005',
    problem_reason: 'Undecoded characters',
  };
  const { context } = createContext({
    rules: [{
      key: 'problem-ignores',
      count: 1,
      items: [ruleItem],
      album_items: [ruleItem],
      file_items: [],
    }],
  });
  const queued = [];
  context.queueProblemExclusionRevert = (item) => {
    queued.push(item);
    return Promise.resolve();
  };
  const revertButton = createElement({ 'data-revert-problem-ignore': rowKey });
  const click = createEvent({ '[data-revert-problem-ignore]': revertButton });

  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.deepEqual(queued, []);
  assert.equal(context.state.utility.pendingRuleRevert.item, ruleItem);
});

test('pointer activation opens exclusion confirmation from the semantic click only', async () => {
  const exclusionButton = createElement({ 'data-open-exclusion-confirm': '1' });
  const selectors = { '[data-open-exclusion-confirm="1"]': exclusionButton };
  const { context } = createContext({
    selectedProblematicKey: 'album-7',
    repairSelections: { 'opaque-row-key': 'ignore' },
  });
  context.getSelectedProblematicAlbum = () => ({ key: 'album-7' });
  context.getIgnoredRepairRowKeys = () => ['opaque-row-key'];
  let opens = 0;
  context.openRepairConfirmModal = () => { opens += 1; };

  context.handleUtilityBootstrapMouseDown(
    createEvent(selectors, { button: 0, detail: 1 }).event,
  );
  assert.equal(opens, 0, 'pointerdown must not own native button activation');

  const click = createEvent(selectors, { button: 0, detail: 1 });
  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.equal(opens, 1);
  assert.equal(context.state.utility.pendingRepairKey, 'album-7');
  assert.equal(context.state.utility.pendingRepairAction, 'detected');
});

test('keyboard activation opens the same exclusion confirmation through native click semantics', async () => {
  const exclusionButton = createElement({ 'data-open-exclusion-confirm': '1' });
  const { context } = createContext({
    selectedProblematicKey: 'album-7',
    repairSelections: { 'opaque-row-key': 'ignore' },
  });
  context.getSelectedProblematicAlbum = () => ({ key: 'album-7' });
  context.getIgnoredRepairRowKeys = () => ['opaque-row-key'];
  let opens = 0;
  context.openRepairConfirmModal = () => { opens += 1; };
  const click = createEvent(
    { '[data-open-exclusion-confirm="1"]': exclusionButton },
    { detail: 0 },
  );

  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.equal(opens, 1);
  assert.equal(context.state.utility.pendingRepairKey, 'album-7');
  assert.equal(context.state.utility.pendingRepairAction, 'detected');
});

test('separate releases has an independent enabled action without a problem exclusion selection', () => {
  const { context } = createContext({
    problemExclusionSelections: {},
    separateReleaseSelections: { 'artist::album': true },
  });

  const html = context.buildDetectedProblemsHtml({
    album_problem_rows: [],
    track_problem_rows: [],
    separate_release_candidate: {
      key: 'artist::album',
      years: [1988, 1992],
    },
    allowed_actions: { 'library.rules.manage': true },
  });

  assert.match(html, /data-open-separate-release-confirm="1"/);
  assert.match(html, />Apply separate releases<\/span>/);
  assert.doesNotMatch(
    html.match(/<button[^>]*data-open-separate-release-confirm="1"[^>]*>/)?.[0] || '',
    /\bdisabled\b/,
  );
});

test('separate releases action opens its own confirmation even with a problem exclusion selected', async () => {
  const separateButton = createElement({ 'data-open-separate-release-confirm': '1' });
  const { context } = createContext({
    selectedProblematicKey: 'album-7',
    problemExclusionSelections: { 'opaque-row-key': true },
    separateReleaseSelections: { 'artist::album': true },
  });
  context.getSelectedProblematicAlbum = () => ({ key: 'album-7' });
  context.getSelectedSeparateReleaseKeys = () => ['artist::album'];
  let opens = 0;
  context.openRepairConfirmModal = () => { opens += 1; };
  const click = createEvent({
    '[data-open-separate-release-confirm="1"]': separateButton,
  });

  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.equal(opens, 1);
  assert.equal(context.state.utility.pendingRepairKey, 'album-7');
  assert.equal(context.state.utility.pendingRepairAction, 'separate-release');
});

test('exclusion confirmation names the affected problem and its reversible effect', () => {
  const dialogAttributes = new Map([
    ['aria-labelledby', 'repair-confirm-title'],
    ['aria-describedby', 'repair-confirm-text'],
  ]);
  const elements = {
    overlay: { hidden: true },
    dialog: {
      getAttribute(name) { return dialogAttributes.get(name) ?? null; },
      setAttribute(name, value) { dialogAttributes.set(name, String(value)); },
      removeAttribute(name) { dialogAttributes.delete(name); },
    },
    title: { hidden: false, textContent: 'Repair local files' },
    text: { textContent: '' },
    cancel: { textContent: 'Cancel' },
    accept: { textContent: 'Yes, repair files' },
  };
  const context = {
    document: {
      body: { classList: { add() {} } },
    },
    state: {
      utility: { pendingRepairAction: 'detected' },
    },
    getIgnoredRepairRowKeys() {
      return ['opaque-row-key'];
    },
    getRepairConfirmElements() {
      return elements;
    },
    getSelectedRepairRowKeys() {
      return [];
    },
    getSelectedSeparateReleaseKeys() {
      return ['artist::album'];
    },
  };
  vm.createContext(context);
  vm.runInContext(utilityLoadersSource, context, { filename: utilityLoadersPath });
  context.getSelectedProblematicAlbum = () => ({ name: 'Album', album_problem_rows: [{ row_key: 'opaque-row-key', reason: 'Missing year' }] });

  context.openRepairConfirmModal();

  assert.equal(elements.overlay.hidden, false);
  assert.match(elements.text.textContent, /Album.*Missing year.*hidden.*revert/);
  assert.equal(elements.cancel.textContent, 'Cancel');
  assert.equal(elements.accept.textContent, 'Create Exception');
  assert.equal(elements.title.hidden, true);
  assert.equal(elements.title.textContent, '');
  assert.equal(elements.dialog.getAttribute('aria-labelledby'), 'repair-confirm-text');
  assert.equal(elements.dialog.getAttribute('aria-describedby'), null);
});

test('separate releases confirmation has the same independent copy alone and in mixed selection state', () => {
  function confirmationText(ignoredRows) {
    const elements = {
      overlay: { hidden: true },
      dialog: {
        setAttribute() {},
        removeAttribute() {},
      },
      title: { hidden: false, textContent: '' },
      text: { textContent: '' },
      cancel: { textContent: '' },
      accept: { textContent: '' },
    };
    const context = {
      document: {
        activeElement: null,
        body: { classList: { add() {} } },
      },
      state: { utility: { pendingRepairAction: 'separate-release' } },
      getIgnoredRepairRowKeys() { return ignoredRows; },
      getRepairConfirmElements() { return elements; },
      getSelectedRepairRowKeys() { return []; },
      getSelectedSeparateReleaseKeys() { return ['artist::album']; },
    };
    vm.createContext(context);
    vm.runInContext(utilityLoadersSource, context, { filename: utilityLoadersPath });

    context.openRepairConfirmModal();
    return {
      text: elements.text.textContent,
      accept: elements.accept.textContent,
    };
  }

  const expected = {
    text: 'This will treat the selected year mismatch as separate releases and rebuild the album list. Are you sure?',
    accept: 'Yes, apply',
  };
  assert.deepEqual(confirmationText([]), expected);
  assert.deepEqual(confirmationText(['opaque-row-key']), expected);
});

test('normal repair confirmation keeps Repair local files as its accessible name', () => {
  const dialogTag = confirmModalsTemplate.match(/<div class="confirm-modal-dialog"[^>]*>/)?.[0] || '';
  assert.match(dialogTag, /aria-labelledby="repair-confirm-title"/);
  assert.match(dialogTag, /aria-describedby="repair-confirm-text"/);

  const dialogAttributes = new Map([
    ['aria-labelledby', 'repair-confirm-title'],
    ['aria-describedby', 'repair-confirm-text'],
  ]);
  const elements = {
    overlay: { hidden: true },
    dialog: {
      getAttribute(name) { return dialogAttributes.get(name) ?? null; },
      setAttribute(name, value) { dialogAttributes.set(name, String(value)); },
      removeAttribute(name) { dialogAttributes.delete(name); },
    },
    title: { hidden: false, textContent: 'Repair local files' },
    text: { textContent: '' },
    cancel: { textContent: 'Cancel' },
    accept: { textContent: 'Yes, repair files' },
  };
  const context = {
    document: {
      activeElement: null,
      body: { classList: { add() {} } },
    },
    state: { utility: { pendingRepairAction: 'repair' } },
    getIgnoredRepairRowKeys() { return []; },
    getRepairConfirmElements() { return elements; },
    getSelectedRepairRowKeys() { return ['C:\\Music\\Track.mp3::title']; },
    getSelectedSeparateReleaseKeys() { return []; },
  };
  vm.createContext(context);
  vm.runInContext(utilityLoadersSource, context, { filename: utilityLoadersPath });

  context.openRepairConfirmModal();

  assert.equal(elements.title.hidden, false);
  assert.equal(elements.title.textContent, 'Repair local files');
  assert.equal(elements.dialog.getAttribute('aria-labelledby'), 'repair-confirm-title');
  assert.equal(elements.dialog.getAttribute('aria-describedby'), 'repair-confirm-text');
});

test('canceling exclusion confirmation restores focus to Create Exception', () => {
  let focusCalls = 0;
  const excludeButton = {
    focus() { focusCalls += 1; },
  };
  const elements = {
    overlay: { hidden: true },
    title: { hidden: false, textContent: 'Repair local files' },
    text: { textContent: '' },
    cancel: { textContent: 'Cancel' },
    accept: { textContent: 'Yes, repair files' },
  };
  const context = {
    document: {
      activeElement: excludeButton,
      body: { classList: { add() {}, remove() {} } },
      getElementById(id) {
        return { hidden: id !== 'utility-modal' };
      },
    },
    state: { utility: { pendingRepairAction: 'detected' } },
    getIgnoredRepairRowKeys() { return ['opaque-row-key']; },
    getRepairConfirmElements() { return elements; },
    getSelectedRepairRowKeys() { return []; },
    getSelectedSeparateReleaseKeys() { return []; },
    getSelectedProblematicAlbum() { return { name: 'Album', album_problem_rows: [{ row_key: 'opaque-row-key', reason: 'Missing year' }] }; },
  };
  vm.createContext(context);
  vm.runInContext(utilityLoadersSource, context, { filename: utilityLoadersPath });

  context.openRepairConfirmModal();
  context.closeRepairConfirmModal();

  assert.equal(focusCalls, 1);
});

test('clicking a non-library integration still selects it when the library helper is async', async () => {
  const { context, calls } = createContext({
    selectedIntegrationKey: 'lastfm',
  });
  context.handleLibrarySettingsIntegrationSelection = async () => false;
  const { event, wasPrevented } = createEvent({
    '[data-utility-integration-key]': createElement({
      'data-utility-integration-key': 'foobar',
    }),
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(context.state.utility.selectedIntegrationKey, 'foobar');
  assert.equal(calls.renders, 1, 'integration selection renders the content once');
  assert.equal(calls.filterRenders, 1, 'outside dismissal refreshes only the filter controls');
});

test('clicking analyze on the local playlist import surface runs the analyze action', async () => {
  const { context } = createContext({
    selectedIntegrationKey: 'local_playlist_import',
  });
  let analyzeCalls = 0;
  context.runLocalPlaylistImportAnalysis = async () => {
    analyzeCalls += 1;
  };
  const { event, wasPrevented } = createEvent({
    '[data-analyze-local-playlist="1"]': createElement({
      'data-analyze-local-playlist': '1',
    }),
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(analyzeCalls, 1);
});

test('applying the base incomplete-order filter preserves a selection after detail hydration', () => {
  const { context } = createContext({
    problematicFiles: [
      {
        key: 'album-1',
        problem_reasons: ['Incomplete track order: Disc 1 missing 3'],
      },
    ],
    selectedProblematicKey: 'album-1',
  });
  const filterContainer = createElement();
  const { event } = createEvent({
    '.utility-problem-filter-button, .utility-problem-filter-menu, .utility-problem-filter-chips': filterContainer,
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Incomplete track order',
    }),
  });

  context.handleUtilityBootstrapClick(event);

  assert.deepEqual(Array.from(context.state.utility.selectedProblemFilters), [
    'Incomplete track order',
  ]);
  assert.equal(context.state.utility.selectedProblematicKey, 'album-1');
});

test('opening a cover lookup task keeps the drawer open behind the task modal', async () => {
  const { context } = createContext();
  context.document.getElementById = (id) => (
    id === 'cover-lookup-drawer-body' ? { scrollTop: 71 } : null
  );
  const albumPayload = {
    album: 'Kill Em All',
    artist: 'Metallica',
    track_paths: ['C:\\test-music\\Metallica\\Kill Em All\\01 Hit the Lights.flac'],
  };
  context.state.coverLookup = {
    drawerOpen: true,
    tasks: [{
      id: 'cover-task-12',
      album_payload: albumPayload,
    }],
  };
  const transitions = [];
  context.renderCoverLookupDrawer = () => {
    transitions.push(`render:${context.state.coverLookup.drawerOpen}`);
  };
    context.openCoverLookupModal = (album, options) => {
    transitions.push(
        `open:${context.state.coverLookup.drawerOpen}:${album.artist}:${album.album}:${options.taskId}:${options.mobileSheet}`,
    );
  };
  const taskButton = createElement({
    'data-open-cover-lookup-task': 'cover-task-12',
  });
  const { event, wasPrevented } = createEvent({
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox, #track-modal': taskButton,
    '[data-open-cover-lookup-task]': taskButton,
  }, { detail: 1 });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(context.state.coverLookup.drawerOpen, true);
  assert.equal(context.state.coverLookup.drawerScrollTop, 71);
  assert.deepEqual(transitions, [
      'open:true:Metallica:Kill Em All:cover-task-12:true',
  ]);
});

test('Album Details interactions do not close Notifications behind it', async () => {
  const { context } = createContext();
  context.state.coverLookup.drawerOpen = true;
  let renders = 0;
  context.renderCoverLookupDrawer = () => { renders += 1; };
  const trackModal = createElement();
  const { event } = createEvent({
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox, #track-modal': trackModal,
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(context.state.coverLookup.drawerOpen, true);
  assert.equal(renders, 0);
});

test('keyboard activation opens a selectable cover lookup task trigger', () => {
  const { context } = createContext();
  const taskButton = createElement({
    'data-open-cover-lookup-task': 'cover-task-12',
  });
  let clickCount = 0;
  taskButton.click = () => {
    clickCount += 1;
  };
  const selectors = {
    '[data-open-cover-lookup-task]': taskButton,
  };

  assert.equal(typeof context.handleUtilityBootstrapKeyDown, 'function');
  const enter = createEvent(selectors, { key: 'Enter' });
  assert.equal(context.handleUtilityBootstrapKeyDown(enter.event), true);
  assert.equal(enter.wasPrevented(), true);
  const space = createEvent(selectors, { key: ' ' });
  assert.equal(context.handleUtilityBootstrapKeyDown(space.event), true);
  assert.equal(space.wasPrevented(), true);
  assert.equal(clickCount, 2);
});

test('utility keydown routes saved-loop edit shortcuts before other keyboard triggers', () => {
  const { context } = createContext();
  let savedLoopKeydownCalls = 0;
  context.handleSavedLoopEditKeydown = () => {
    savedLoopKeydownCalls += 1;
    return true;
  };
  const { event } = createEvent({}, { key: 'Enter' });

  assert.equal(context.handleUtilityBootstrapKeyDown(event), true);
  assert.equal(savedLoopKeydownCalls, 1);
});

test('drag-selecting cover lookup task text suppresses only its immediate click after selection collapses', async () => {
  const { context } = createContext();
  const albumPayload = {
    album: 'Kill Em All',
    artist: 'Metallica',
    track_paths: ['C:\\test-music\\Metallica\\Kill Em All\\01 Hit the Lights.flac'],
  };
  context.state.coverLookup = {
    drawerOpen: true,
    tasks: [{
      id: 'cover-task-12',
      album_payload: albumPayload,
    }],
  };
  const selectedTextNode = {};
  let selectionCollapsed = true;
  context.window = {
    getSelection() {
      return {
        anchorNode: selectedTextNode,
        focusNode: selectedTextNode,
        get isCollapsed() {
          return selectionCollapsed;
        },
        toString() {
          return selectionCollapsed ? '' : 'Metallica - Kill Em All';
        },
      };
    },
  };
  const scheduledCallbacks = [];
  context.scheduleBrowserTimeout = (callback) => {
    scheduledCallbacks.push(callback);
    return scheduledCallbacks.length;
  };
  let modalOpenCount = 0;
  context.openCoverLookupModal = () => {
    modalOpenCount += 1;
  };
  const taskButton = createElement({
    'data-open-cover-lookup-task': 'cover-task-12',
  });
  taskButton.contains = (node) => node === selectedTextNode;
  const gestureSelectors = {
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox, #track-modal': taskButton,
    '[data-open-cover-lookup-task]': taskButton,
  };

  context.handleUtilityBootstrapMouseDown(
    createEvent(gestureSelectors, { button: 0 }).event,
  );
  selectionCollapsed = false;
  context.handleUtilityBootstrapMouseUp(
    createEvent(gestureSelectors, { button: 0 }).event,
  );
  selectionCollapsed = true;
  const firstClick = createEvent(gestureSelectors, { detail: 1 });
  await context.handleUtilityBootstrapClick(firstClick.event);

  assert.equal(firstClick.wasPrevented(), false);
  assert.equal(context.state.coverLookup.drawerOpen, true);
  assert.equal(modalOpenCount, 0);

  const secondClick = createEvent(gestureSelectors, { detail: 1 });
  await context.handleUtilityBootstrapClick(secondClick.event);

  assert.equal(secondClick.wasPrevented(), true);
  assert.equal(context.state.coverLookup.drawerOpen, true);
  assert.equal(modalOpenCount, 1);
});

test('an ordinary click opens a cover lookup task when its preexisting text selection is unchanged', async () => {
  const { context } = createContext();
  const albumPayload = {
    album: 'Kill Em All',
    artist: 'Metallica',
    track_paths: ['C:\\test-music\\Metallica\\Kill Em All\\01 Hit the Lights.flac'],
  };
  context.state.coverLookup = {
    drawerOpen: true,
    tasks: [{
      id: 'cover-task-12',
      album_payload: albumPayload,
    }],
  };
  const anchorNode = {};
  const focusNode = {};
  context.window = {
    getSelection() {
      return {
        anchorNode,
        anchorOffset: 2,
        focusNode,
        focusOffset: 9,
        isCollapsed: false,
        toString() {
          return 'Metallica';
        },
      };
    },
  };
  context.scheduleBrowserTimeout = () => 1;
  let modalOpenCount = 0;
  context.openCoverLookupModal = () => {
    modalOpenCount += 1;
  };
  const taskButton = createElement({
    'data-open-cover-lookup-task': 'cover-task-12',
  });
  taskButton.contains = (node) => node === anchorNode || node === focusNode;
  const gestureSelectors = {
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox, #track-modal': taskButton,
    '[data-open-cover-lookup-task]': taskButton,
  };

  context.handleUtilityBootstrapMouseDown(
    createEvent(gestureSelectors, { button: 0, clientX: 10, clientY: 20 }).event,
  );
  context.handleUtilityBootstrapMouseUp(
    createEvent(gestureSelectors, { button: 0, clientX: 10, clientY: 20 }).event,
  );
  const click = createEvent(gestureSelectors, { detail: 1 });
  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.equal(context.state.coverLookup.drawerOpen, true);
  assert.equal(modalOpenCount, 1);
});

test('a moved notification-title drag suppresses its immediate card click when mouseup collapses selection', async () => {
  const { context } = createContext();
  const albumPayload = {
    album: 'Crack The Skye Fixture 03',
    artist: 'Mastodon',
    track_paths: ['C:\\test-music\\Mastodon\\Crack The Skye Fixture 03\\01 Oblivion.mp3'],
  };
  context.state.coverLookup = {
    drawerOpen: true,
    tasks: [{
      id: 'cover-task-drag',
      album_payload: albumPayload,
    }],
  };
  context.window = {
    getSelection() {
      return {
        anchorNode: null,
        focusNode: null,
        isCollapsed: true,
        toString() {
          return '';
        },
      };
    },
  };
  context.scheduleBrowserTimeout = () => 1;
  let modalOpenCount = 0;
  context.openCoverLookupModal = () => {
    modalOpenCount += 1;
  };
  const taskButton = createElement({
    'data-open-cover-lookup-task': 'cover-task-drag',
  });
  const gestureSelectors = {
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox, #track-modal': taskButton,
    '[data-open-cover-lookup-task]': taskButton,
  };

  context.handleUtilityBootstrapMouseDown(
    createEvent(gestureSelectors, { button: 0, clientX: 10, clientY: 20 }).event,
  );
  context.handleUtilityBootstrapMouseUp(
    createEvent(gestureSelectors, { button: 0, clientX: 40, clientY: 20 }).event,
  );
  const click = createEvent(gestureSelectors, { detail: 1 });
  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), false);
  assert.equal(context.state.coverLookup.drawerOpen, true);
  assert.equal(modalOpenCount, 0);
});

test('keyboard activation opens a cover lookup task while unrelated page text remains selected', async () => {
  const { context } = createContext();
  const albumPayload = {
    album: 'Kill Em All',
    artist: 'Metallica',
    track_paths: ['C:\\test-music\\Metallica\\Kill Em All\\01 Hit the Lights.flac'],
  };
  context.state.coverLookup = {
    drawerOpen: true,
    tasks: [{
      id: 'cover-task-12',
      album_payload: albumPayload,
    }],
  };
  context.window = {
    getSelection() {
      return {
        isCollapsed: false,
        toString() {
          return 'Unrelated page text';
        },
      };
    },
  };
  let modalOpenCount = 0;
  context.openCoverLookupModal = () => {
    modalOpenCount += 1;
  };
  const taskButton = createElement({
    'data-open-cover-lookup-task': 'cover-task-12',
  });
  const { event, wasPrevented } = createEvent({
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox, #track-modal': taskButton,
    '[data-open-cover-lookup-task]': taskButton,
  }, { detail: 0 });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(context.state.coverLookup.drawerOpen, true);
  assert.equal(modalOpenCount, 1);
});

test('changing the local playlist import file input stores the selected file through the feature helper', () => {
  const { context } = createContext();
  let receivedFile = null;
  context.handleLocalPlaylistImportFileSelection = (file) => {
    receivedFile = file;
  };
  const playlistFile = { name: '2026.fpl', size: 3 };

  context.handleUtilityBootstrapInput({
    target: {
      closest(selector) {
        if (selector !== '[data-local-playlist-import-file]') {
          return null;
        }
        return {
          files: [playlistFile],
          value: 'C:\\\\temp\\\\2026.fpl',
          getAttribute() {
            return '';
          },
        };
      },
    },
  });

  assert.equal(receivedFile, playlistFile);
});

test('clicking Export displayed logs invokes the scoped snapshot download action', async () => {
  const { context } = createContext({ activeTab: 'log-history' });
  let exportCalls = 0;
  context.handleUtilityLogHistoryAction = async action => {
    assert.equal(action, 'export-current');
    exportCalls += 1;
  };
  const exportButton = createElement({ 'data-log-history-action': 'export-current' });
  const { event, wasPrevented } = createEvent({
    '[data-log-history-action]': exportButton,
  });
  await context.handleUtilityBootstrapClick(event);
  assert.equal(wasPrevented(), true);
  assert.equal(exportCalls, 1);
});

test('tag editor backdrop closes only when the editor has no changed updates', async () => {
  async function clickBackdrop(changedUpdates) {
    const overlay = {
      id: 'tag-editor-modal',
      closest() {
        return null;
      },
    };
    const { context } = createContext();
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/tag-editor-and-optimistic-updates.js'), 'utf8'), context);
    let closeCalls = 0;
    context.document.getElementById = (id) => (id === 'tag-editor-modal' ? overlay : null);
    context.overlayClickStartedOnOverlay = (candidate, event) => (
      candidate === overlay && event.target === overlay
    );
    context.buildChangedTagEditorUpdates = () => changedUpdates;
    context.closeTagEditor = () => {
      closeCalls += 1;
    };
    context.state.tagEditor = {
      album: { key: 'artist::album::2000' },
      tracks: [{ path: 'C:\\Music\\Artist\\Album\\01 Track.flac' }],
      values: {},
      dragSelecting: false,
      dragAnchorPath: '',
    };

    await context.handleUtilityBootstrapClick({
      target: overlay,
      preventDefault() {},
    });
    return closeCalls;
  }

  assert.equal(
    await clickBackdrop({}),
    1,
    'a backdrop click should close an unchanged tag editor',
  );
  assert.equal(
    await clickBackdrop({
      'C:\\Music\\Artist\\Album\\01 Track.flac': { title: 'Dirty title' },
    }),
    0,
    'a backdrop click should leave a dirty tag editor open',
  );
});

test('confirming local cover deletion forwards the retained path exactly once', async () => {
  const { context } = createContext();
  const deleteButton = createElement({ 'data-confirm-cover-lookup-delete': '1' });
  const paths = [];
  context.state.coverLookup.modal = { pendingDeletePath: 'C:\\Music\\Artist\\Album\\Front.jpg' };
  context.deleteLocalCoverFromLookup = async (sourcePath) => {
    paths.push(sourcePath);
  };
  const { event, wasPrevented } = createEvent({
    '[data-confirm-cover-lookup-delete="1"]': deleteButton,
  });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.deepEqual(paths, ['C:\\Music\\Artist\\Album\\Front.jpg']);
});

test('bounded interaction: tag editor drag selection and field input update only changed rows among 1,000 tracks', async () => {
  const { countedCollection, createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter.js');
  const { createCountedDom } = require('../helpers/counted-dom.js');
  const run = async (cardinality) => {
    const counter = createInteractionCounter();
    const { CountedElement } = createCountedDom(counter);
    const { context } = createContext();
    vm.runInContext(fs.readFileSync(path.join(path.dirname(utilityLoadersPath), 'markup-format-helpers.js'), 'utf8'), context);
    vm.runInContext(utilityLoadersSource, context, { filename: utilityLoadersPath });
    const paths = Array.from({ length: cardinality }, (_value, index) => `Music/Album/${String(index).padStart(4, '0')}.flac`);
    const rows = new Map(paths.map(item => [item, new CountedElement('div', { selectors: { '.tag-editor-track-select': new CountedElement('button') } })]));
    rows.forEach((row, item) => row.setAttribute('data-tag-editor-track', item));
    const list = new CountedElement('div');
    list.querySelector = (selector) => {
      counter.count('domQueries');
      return rows.get(selector.slice('[data-tag-editor-track="'.length, -'"]'.length)) || null;
    };
    list.querySelectorAll = () => { counter.count('domQueries'); return [...rows.values()]; };
    const titleInput = new CountedElement('input', { value: '' });
    titleInput.setAttribute('data-tag-field', 'title');
    titleInput.closest = selector => (selector === '#tag-editor-form [data-tag-field]' ? titleInput : null);
    const form = new CountedElement('form', { selectors: { 'all:[data-tag-field]': [titleInput] } });
    context.getTagEditorElements = () => ({ overlay: new CountedElement(), list, form });
    context.renderTagEditorArtwork = () => {};
    context.syncTagEditorCollectionFields = () => {};
    context.syncTagEditorPendingChanges = () => {};
    context.syncTagEditorAutoNumberControls = () => {};
    const tracks = countedCollection(paths.map(item => ({ path: item, title: item })), counter);
    Object.assign(context.state.tagEditor, {
      album: { name: 'Album' }, tracks, values: {}, selectedPaths: [paths[5]], anchorPath: paths[5],
      dragSelecting: true, dragAnchorPath: paths[5], dragHoverPath: paths[5],
    });
    const hover = item => ({ target: { closest: selector => (selector === '[data-tag-editor-track]' ? rows.get(item) : null) } });
    const work = await counter.measure(() => {
      for (let move = 0; move < 10; move += 1) context.handleUtilityBootstrapMouseOver(hover(paths[5]));
      context.handleUtilityBootstrapMouseOver(hover(paths[6]));
      for (let move = 0; move < 10; move += 1) context.handleUtilityBootstrapMouseOver(hover(paths[6]));
      titleInput.value = 'Edited';
      context.handleUtilityBootstrapInput({ target: titleInput });
    });
    assert.deepEqual([...context.state.tagEditor.selectedPaths], [paths[5], paths[6]]);
    assert.equal(rows.get(paths[6]).classList.contains('is-active'), true);
    assert.equal(context.state.tagEditor.values[paths[6]].title, 'Edited');
    return work;
  };
  await measureScalePair({
    id: 'js:runtime/bootstrap-event-handlers.js#<top-level>',
    small: 20,
    large: 1000,
    run,
    budgets: { itemsVisited: 3015, domQueries: 3, domMutations: 2, renderCommits: 0 },
    growth: { metric: 'domMutations', largeMinusSmallMax: 0 },
  });
});
