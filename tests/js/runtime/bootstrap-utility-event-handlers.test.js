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
const utilityListBuildersSource = fs.readFileSync(utilityListBuildersPath, 'utf8');
const utilityLoadersSource = fs.readFileSync(utilityLoadersPath, 'utf8');
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
  };
  const context = {
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
    closeUtilityModal() {},
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
    loadProblematicFiles() {},
    loadUtilityIntegrations() {},
    loadUtilityLogHistory() {},
    loadUtilityLoops() {},
    loadUtilityRules() {},
    normalizePlayerAppearance(value) {
      return value;
    },
    openAlbumInExplorer() {},
    openAlbumOnDiscogs() {},
    openRepairConfirmModal() {},
    openTagEditor() {},
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
  vm.runInContext(utilityListBuildersSource, context, {
    filename: utilityListBuildersPath,
  });
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, calls };
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

test('switching away from Loops clears session-only Space ownership', () => {
  assert.match(
    helperSource,
    /nextUtilityTab[\s\S]{0,200}setUtilityActiveTab\(nextUtilityTab\)/,
    'the utility tab click path must use the shared transition policy',
  );
});

test('failure alert Log History link selects its exact entry before opening the tab', async () => {
  const link = createElement({
    'data-log-history-entry-id': 'tag-edit-failure-42',
  });
  const click = createEvent({
    '[data-open-log-history-alert="1"]': link,
  });
  const { context } = createContext({
    selectedLogHistoryId: 'older-entry',
  });
  let hidden = false;
  let opened = false;
  context.hideRepairAlert = () => { hidden = true; };
  context.openUtilityLogHistoryTab = () => { opened = true; };

  await context.handleUtilityBootstrapClick(click.event);

  assert.equal(click.wasPrevented(), true);
  assert.equal(hidden, true);
  assert.equal(opened, true);
  assert.equal(context.state.utility.selectedLogHistoryId, 'tag-edit-failure-42');
});

test('applying a problem filter preserves the selected album in the live bootstrap handler when it still matches', () => {
  const { context, calls } = createContext({
    problematicFiles: [
      { key: 'album-1', problem_reasons: ['Poor art quality', 'Missing year'] },
      { key: 'album-2', problem_reasons: ['Missing cover art'] },
    ],
    selectedProblematicKey: 'album-1',
  });
  const filterContainer = createElement();
  const { event, wasPrevented } = createEvent({
    '.utility-problem-filter, .utility-problem-filter-chips': filterContainer,
    '[data-problem-filter-value]': createElement({
      'data-problem-filter-value': 'Poor art quality',
    }),
  });

  context.handleUtilityBootstrapClick(event);

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
    '.utility-problem-filter, .utility-problem-filter-chips': filterContainer,
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
    '.utility-problem-filter, .utility-problem-filter-chips': filterContainer,
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

test('clicking a problematic album row clears deferred auto-selection in the live bootstrap handler', () => {
  const { context } = createContext({
    deferProblematicAutoSelection: true,
  });
  const { event } = createEvent({
    '[data-problematic-album-key]': createElement({
      'data-problematic-album-key': 'album-7',
    }),
  });

  context.handleUtilityBootstrapClick(event);

  assert.equal(context.state.utility.selectedProblematicKey, 'album-7');
  assert.equal(context.state.utility.deferProblematicAutoSelection, false);
});

test('Rules revert passes the complete current exclusion item to the optimistic queue', async () => {
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
  assert.deepEqual(queued, [ruleItem]);
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
  });

  assert.match(html, /data-open-separate-release-confirm="1"/);
  assert.match(html, />Apply separate releases<\/button>/);
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

test('exclusion confirmation contains only the approved sentence and Cancel or Exclude actions', () => {
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

  context.openRepairConfirmModal();

  assert.equal(elements.overlay.hidden, false);
  assert.equal(elements.text.textContent, 'Are you sure? This will create an exclusion rule');
  assert.equal(elements.cancel.textContent, 'Cancel');
  assert.equal(elements.accept.textContent, 'Exclude');
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

test('canceling exclusion confirmation restores focus to Exclude the problem', () => {
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
  assert.equal(calls.renders, 2);
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
    '.utility-problem-filter, .utility-problem-filter-chips': filterContainer,
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

test('opening a cover lookup task from inside the drawer closes the drawer before opening the task modal', async () => {
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
  const transitions = [];
  context.renderCoverLookupDrawer = () => {
    transitions.push(`render:${context.state.coverLookup.drawerOpen}`);
  };
  context.openCoverLookupModal = (album, options) => {
    transitions.push(
      `open:${context.state.coverLookup.drawerOpen}:${album.artist}:${album.album}:${options.taskId}`,
    );
  };
  const taskButton = createElement({
    'data-open-cover-lookup-task': 'cover-task-12',
  });
  const { event, wasPrevented } = createEvent({
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox': taskButton,
    '[data-open-cover-lookup-task]': taskButton,
  }, { detail: 1 });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(context.state.coverLookup.drawerOpen, false);
  assert.deepEqual(transitions, [
    'render:false',
    'open:false:Metallica:Kill Em All:cover-task-12',
  ]);
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
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox': taskButton,
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
  assert.equal(context.state.coverLookup.drawerOpen, false);
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
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox': taskButton,
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
  assert.equal(context.state.coverLookup.drawerOpen, false);
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
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox': taskButton,
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
    '#cover-lookup-drawer, [data-toggle-cover-lookup-drawer="1"], #cover-lookup-modal, #cover-lookup-delete-confirm-modal, #image-lightbox': taskButton,
    '[data-open-cover-lookup-task]': taskButton,
  }, { detail: 0 });

  await context.handleUtilityBootstrapClick(event);

  assert.equal(wasPrevented(), true);
  assert.equal(context.state.coverLookup.drawerOpen, false);
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

test('clicking Export Logs invokes the explicit browser download action', async () => {
  const { context } = createContext({ activeTab: 'log-history' });
  let exportCalls = 0;
  context.exportBrowserLogHistory = async () => {
    exportCalls += 1;
  };
  const exportButton = createElement({ 'data-export-log-history': '1' });
  const { event, wasPrevented } = createEvent({
    '[data-export-log-history="1"]': exportButton,
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
