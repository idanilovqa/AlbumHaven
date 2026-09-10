const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../..');
const readRuntime = name => fs.readFileSync(path.join(root, 'music_app/static/js/runtime', `${name}.js`), 'utf8');

function loadHelpers() {
  const context = {
    state: { utility: {
      selectedProblemFilters: [], searchQuery: '', selectedProblematicKey: 'year-only',
      problematicFiles: [
        { key: 'year-only', name: 'Selected album', album_artist: 'Artist', problem_reasons: ['Missing year'] },
        { key: 'encoding-only', name: 'Selected second album', album_artist: 'Artist', problem_reasons: ['Encoding problem'] },
        { key: 'both', name: 'Other album', album_artist: 'Artist', problem_reasons: ['Missing year', 'Encoding problem'] },
        { key: 'unrelated', name: 'Selected third album', album_artist: 'Artist', problem_reasons: ['Missing cover art'] },
      ],
      problemExclusionSelections: {}, repairSelections: {},
    } },
    escapeHtml: value => String(value ?? ''),
  };
  vm.createContext(context);
  vm.runInContext(readRuntime('utility-list-builders'), context);
  return context;
}

test('P04 multiple selected problem filters include their union', () => {
  const context = loadHelpers();
  context.state.utility.selectedProblemFilters = ['Missing year', 'Encoding problem'];
  assert.deepEqual(Array.from(context.getFilteredProblematicAlbums(), album => album.key).sort(), ['both', 'encoding-only', 'year-only']);
  assert.equal(context.state.utility.selectedProblematicKey, 'year-only', 'matching navigation context remains valid');
});

test('P04 search intersects the union of selected problem types', () => {
  const context = loadHelpers();
  context.state.utility.selectedProblemFilters = ['Missing year', 'Encoding problem'];
  context.state.utility.searchQuery = 'selected';
  assert.deepEqual(Array.from(context.getFilteredProblematicAlbums(), album => album.key).sort(), ['encoding-only', 'year-only']);
});

test('P04 clearing every filter includes all problem types while keeping search', () => {
  const context = loadHelpers();
  context.state.utility.searchQuery = 'selected';
  assert.deepEqual(Array.from(context.getFilteredProblematicAlbums(), album => album.key), ['year-only', 'encoding-only', 'unrelated']);
});

test('P03 selecting a second problem preserves independently selected targets', () => {
  const context = loadHelpers();
  context.selectProblemExclusion('problem-year-1');
  context.selectProblemExclusion('problem-encoding-2');
  assert.deepEqual(Object.keys(context.state.utility.problemExclusionSelections).sort(), ['problem-encoding-2', 'problem-year-1']);
  context.selectProblemExclusion('problem-year-1');
  assert.deepEqual(Object.keys(context.state.utility.problemExclusionSelections), ['problem-encoding-2']);
});

test('P03 dragging Year across tracks selects only Year problems and leaves suggestions independent', () => {
  const context = loadHelpers();
  context.state.utility.proposalSelections = { 'proposal-artist-1': true };
  context.state.utility.problematicFiles[0].track_problem_rows = [
    { ignorable_reasons: [{ row_key: 'year-1', reason: 'Missing year' }, { row_key: 'encoding-1', reason: 'Encoding problem' }] },
    { ignorable_reasons: [{ row_key: 'encoding-2', reason: 'Encoding problem' }] },
    { ignorable_reasons: [{ row_key: 'year-3', reason: 'Missing year' }] },
  ];
  assert.equal(context.extendProblemExclusionRange('Missing year', 0, 2), true);
  assert.deepEqual(Object.keys(context.state.utility.problemExclusionSelections), ['year-1', 'year-3']);
  assert.deepEqual(context.state.utility.proposalSelections, { 'proposal-artist-1': true });
});

test('P04 Year mismatch display variants share one filter type', () => {
  const context = loadHelpers();
  const normalized = ['Year mismatch', 'Year mismatch: 2008', 'Year mismatch: Missing', 'Inconsistent year']
    .map(reason => context.normalizeProblemFilterReason(reason));
  assert.equal(new Set(normalized).size, 1);
});

for (const kind of ['problem-exclusion', 'version-exception']) {
  test(`R02 clicking ${kind} Revert waits for confirmation before mutation`, async () => {
    const context = loadHelpers();
    const writes = [];
    context.state.coverLookup = { drawerOpen: false };
    context.state.utility.rules = [{ key: 'problem-ignores', items: [{ row_key: 'rule-1', target_label: 'Target album' }] }];
    context.document = { querySelectorAll: () => [] };
    context.handleLibrarySettingsClick = () => false;
    context.revertVersionException = key => writes.push(key);
    context.queueProblemExclusionRevert = item => writes.push(item);
    context.openRepairConfirmModal = () => {};
    vm.runInContext(readRuntime('bootstrap-utility-event-handlers'), context);
    const selector = kind === 'problem-exclusion' ? '[data-revert-problem-ignore]' : '[data-revert-version-exception]';
    const button = { getAttribute: () => 'rule-1' };
    await context.handleUtilityBootstrapClick({
      target: { closest: value => value === selector ? button : null }, preventDefault() {},
    });
    assert.deepEqual(writes, [], 'opening the shared confirmation must not submit a mutation');
  });
}

function proposalContext() {
  const context = loadHelpers();
  const proposals = [
    { id: 'year-1', path: 'track-1', field: 'year', type: 'year', reason: 'Missing year', original: null, corrected: 2008, updates: { year: 2008 } },
    { id: 'artist-1', path: 'track-1', field: 'artist', type: 'encoding', reason: 'Encoding problem', original: 'JosÃ©', corrected: 'José', updates: { artist: 'José' } },
    { id: 'year-2', path: 'track-2', field: 'year', type: 'year', reason: 'Missing year', original: null, corrected: 2010, updates: { year: 2010 } },
  ];
  context.state.utility.problematicFiles[0].suggested_edits = proposals;
  context.state.utility.proposalSelections = {};
  return context;
}

test('P09 Apply All targets only the eligible visible suggestions', () => {
  const context = proposalContext();
  assert.equal(typeof context.getApplicableProblemSuggestions, 'function');
  context.state.utility.selectedProblemFilters = ['Missing year'];
  assert.deepEqual(Array.from(context.getApplicableProblemSuggestions(), item => item.id), ['year-1', 'year-2']);
});

test('P09 explicit selection never falls back to Apply All when its proposals are hidden', () => {
  const context = proposalContext();
  assert.equal(typeof context.getApplicableProblemSuggestions, 'function');
  context.state.utility.proposalSelections = { 'artist-1': true };
  context.state.utility.selectedProblemFilters = ['Missing year'];
  assert.deepEqual(Array.from(context.getApplicableProblemSuggestions()), []);
  context.state.utility.proposalSelections['year-2'] = true;
  assert.deepEqual(Array.from(context.getApplicableProblemSuggestions(), item => item.id), ['year-2']);
});

test('P07 suggestion toggle preserves independent problem selections', () => {
  const context = proposalContext();
  assert.equal(typeof context.toggleProblemSuggestion, 'function');
  context.state.utility.problemExclusionSelections = { 'problem-year-1': true };
  context.toggleProblemSuggestion('year-1');
  context.toggleProblemSuggestion('artist-1');
  context.toggleProblemSuggestion('year-1');
  assert.deepEqual(Object.keys(context.state.utility.proposalSelections), ['artist-1']);
  assert.deepEqual(context.state.utility.problemExclusionSelections, { 'problem-year-1': true });
});

test('P07 dragging Year suggestions across Artist cannot select the other field', () => {
  const context = proposalContext();
  assert.equal(typeof context.extendProblemSuggestionRange, 'function');
  context.extendProblemSuggestionRange('year', 0, 2);
  assert.deepEqual(Object.keys(context.state.utility.proposalSelections), ['year-1', 'year-2']);
  assert.deepEqual(context.state.utility.problemExclusionSelections, {});
});

test('P05 labels show exact current and corrected values without replacing source casing', () => {
  const context = proposalContext();
  assert.equal(typeof context.formatProblemSuggestionLabel, 'function');
  const proposals = context.state.utility.problematicFiles[0].suggested_edits;
  assert.equal(context.formatProblemSuggestionLabel(proposals[0]), 'Year: missing → 2008');
  assert.equal(context.formatProblemSuggestionLabel(proposals[1]), 'Artist: JosÃ© → José');
});

function detailContext() {
  const context = proposalContext();
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(root, 'music_app/static/js/button-component.js'), 'utf8'), context);
  Object.assign(context.state.utility, { separateReleaseSelections: {}, collapsedSections: {} });
  context.buildAlbumDisplayCoverUrl = () => '';
  context.buildAlbumLightboxCoverUrl = () => '';
  context.getAvailableAlbumMoveActions = () => [];
  context.getFilenameFromPath = value => value.split('/').pop();
  context.getFileTypeFromPath = () => 'FLAC';
  for (const helper of ['album-artbox', 'problematic-album-helpers', 'compact-data-table', 'alert-components']) {
    vm.runInContext(readRuntime(helper), context);
  }
  const album = context.state.utility.problematicFiles[0];
  Object.assign(album, {
    tracks: [{ path: 'track-1', title: 'First track' }], repair_preview_rows: [],
    album_problem_rows: [{ row_key: 'cover-album', reason: 'Missing cover art' }],
    track_problem_rows: [{ path: 'track-1', filename: 'First.flac', reasons: ['Missing year', 'Missing cover art'], ignorable_reasons: [{ row_key: 'year-problem', reason: 'Missing year' }] }],
  });
  return { context, album };
}

for (const hasSuggestions of [true, false]) {
  test(`P02 detected problems always has exactly three columns with ${hasSuggestions ? 'available' : 'no'} suggestions`, () => {
    const { context, album } = detailContext();
    if (!hasSuggestions) album.suggested_edits = [];
    const html = context.buildProblematicAlbumDetail(album);
    const headers = Array.from(html.matchAll(/role="columnheader"[^>]*>([^<]*)</g), match => match[1]);
    assert.deepEqual(headers, ['Track / file', 'Problems', 'Suggested edits']);
    assert.doesNotMatch(html, /data-utility-section-toggle="suggested"|ALBUM-LEVEL PROBLEMS|TRACK-LEVEL PROBLEMS/);
    assert.equal((html.match(/role="table"/g) || []).length, 1);
  });
}

test('P03 cover issues are shown once at album level and never copied into track problem labels', () => {
  const { context, album } = detailContext();
  const html = context.buildProblematicAlbumDetail(album);
  assert.equal((html.match(/data-problem-exclusion-reason="Missing cover art"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-problem-exclusion-scope="file"[^>]*data-problem-exclusion-reason="Missing cover art"/);
});

test('P07 real AlertLabel retains proposal identity and intent for delegated interaction', () => {
  const { context, album } = detailContext();
  const html = context.buildProblematicAlbumDetail(album);
  assert.match(html, /data-problem-suggestion-id="year-1"[^>]*data-label-intent="proposal"/);
});

function confirmationContext() {
  const context = proposalContext();
  const modalElement = () => ({ hidden: false, textContent: '', innerHTML: '', setAttribute() {}, removeAttribute() {}, focus() {} });
  const modal = { overlay: modalElement(), dialog: modalElement(), title: modalElement(), text: modalElement(), accept: modalElement(), cancel: modalElement() };
  modal.overlay.hidden = true;
  context.state.utility.problematicFiles[0].allowed_actions = { 'library.files.edit_tags': true, 'library.rules.manage': true };
  context.state.utility.problematicFiles[0].tracks = [{ path: 'track-1' }, { path: 'track-2' }];
  context.state.utility.separateReleaseSelections = {};
  context.document = { body: { classList: { add() {}, remove() {} } }, getElementById: () => ({ hidden: true }), querySelectorAll: () => [] };
  context.getRepairConfirmElements = () => modal;
  context.getRepairProgressElements = () => ({ overlay: modalElement() });
  context.renderUtilityModalContent = () => {};
  context.showToast = () => {};
  context.console = { error() {} };
  vm.runInContext(readRuntime('problematic-album-helpers'), context);
  vm.runInContext(readRuntime('utility-loaders-and-cover-lookup'), context);
  vm.runInContext(readRuntime('tag-editor-and-optimistic-updates'), context);
  const requests = [];
  context.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: false, status: 409, json: async () => ({ ok: false, error: 'Source changed', proposal_status: 'stale' }) };
  };
  return { context, modal, requests };
}

test('P09 opening Apply confirms exact values and makes no request before acceptance', () => {
  const { context, modal, requests } = confirmationContext();
  assert.equal(typeof context.openProblemSuggestionsConfirm, 'function');
  context.state.utility.proposalSelections = { 'artist-1': true };
  context.openProblemSuggestionsConfirm();
  assert.equal(modal.overlay.hidden, false);
  assert.match(modal.text.textContent + modal.text.innerHTML, /JosÃ©.*José/);
  assert.deepEqual(requests, []);
  context.closeRepairConfirmModal();
  assert.deepEqual(requests, []);
  assert.deepEqual(context.state.utility.proposalSelections, { 'artist-1': true });
});

test('P09 confirmed stale Apply sends only selected visible proposals and retains unresolved selection', async () => {
  const { context, requests } = confirmationContext();
  assert.equal(typeof context.openProblemSuggestionsConfirm, 'function');
  assert.equal(typeof context.confirmProblemSuggestions, 'function');
  context.state.utility.selectedProblemFilters = ['Missing year'];
  context.state.utility.proposalSelections = { 'year-1': true, 'artist-1': true };
  context.openProblemSuggestionsConfirm();
  await context.confirmProblemSuggestions();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/utilities/edit-tags');
  assert.equal(requests[0].body.confirmed, true);
  assert.deepEqual(requests[0].body.proposal_ids, ['year-1']);
  assert.deepEqual(requests[0].body.updates, { 'track-1': { year: 2008 } });
  assert.deepEqual(context.state.utility.proposalSelections, { 'year-1': true, 'artist-1': true });
  assert.deepEqual(context.state.utility.problemExclusionSelections, {});
});

test('P09 loss of tag-edit capability before confirmation prevents the apply request', async () => {
  const { context, requests } = confirmationContext();
  assert.equal(typeof context.openProblemSuggestionsConfirm, 'function');
  assert.equal(typeof context.confirmProblemSuggestions, 'function');
  context.state.utility.proposalSelections = { 'artist-1': true };
  context.openProblemSuggestionsConfirm();
  context.state.utility.problematicFiles[0].allowed_actions['library.files.edit_tags'] = false;
  await context.confirmProblemSuggestions();
  assert.deepEqual(requests, []);
  assert.deepEqual(context.state.utility.proposalSelections, { 'artist-1': true });
});

test('P08 Create Exception confirmation identifies selected problem targets and their effect', () => {
  const { context, modal } = confirmationContext();
  const album = context.state.utility.problematicFiles[0];
  album.track_problem_rows = [{ path: 'track-1', filename: 'First.flac', ignorable_reasons: [{ row_key: 'year-problem', reason: 'Missing year' }] }];
  context.state.utility.problemExclusionSelections = { 'year-problem': true };
  context.state.utility.pendingRepairAction = 'detected';
  context.openRepairConfirmModal();
  assert.match(modal.text.textContent + modal.text.innerHTML, /First\.flac/);
  assert.match(modal.text.textContent + modal.text.innerHTML, /Missing year/);
  assert.match(modal.text.textContent + modal.text.innerHTML, /exclu|suppress|hide/i);
});

test('R02 shared Revert rule modal names its target and requires Yes before mutation', async () => {
  const { context, modal } = confirmationContext();
  const item = { row_key: 'rule-1', target_label: 'First.flac', problem_reason: 'Missing year' };
  const writes = [];
  context.queueProblemExclusionRevert = async value => { writes.push(value); return true; };
  context.openRuleRevertConfirm({ kind: 'problem-exclusion', key: item.row_key, item });
  assert.equal(modal.title.textContent, 'Revert rule?');
  assert.match(modal.text.textContent, /First\.flac/);
  assert.match(modal.text.textContent, /appear again/);
  assert.equal(modal.cancel.textContent, 'No');
  assert.equal(modal.accept.textContent, 'Yes');
  context.closeRepairConfirmModal();
  assert.deepEqual(writes, []);
  context.openRuleRevertConfirm({ kind: 'problem-exclusion', key: item.row_key, item });
  await context.confirmRepairSelectedAlbum();
  assert.deepEqual(writes, [item]);
  assert.equal(modal.overlay.hidden, true);
});

test('R02 rejected rule revert retains the confirmation and selected rule', async () => {
  const { context, modal } = confirmationContext();
  const item = { row_key: 'rule-1', target_label: 'First.flac', problem_reason: 'Missing year' };
  context.queueProblemExclusionRevert = async () => false;
  context.openRuleRevertConfirm({ kind: 'problem-exclusion', key: item.row_key, item });
  await context.confirmRepairSelectedAlbum();
  assert.equal(modal.overlay.hidden, false);
  assert.equal(context.state.utility.pendingRuleRevert.item, item);
});

for (const status of ['committed', 'stale', 'failed_rolled_back', 'recovery_pending', null]) {
  test(`P09 ${status || 'missing'} authoritative outcome controls selection clearing and refresh`, async () => {
    const { context, modal } = confirmationContext();
    const refreshes = [];
    context.state.utility.proposalSelections = { 'year-1': true, 'artist-1': true };
    context.state.utility.selectedProblemFilters = ['Missing year'];
    context.loadProblematicFiles = async force => { refreshes.push(['collection', force]); return true; };
    context.loadProblematicAlbumDetail = async (key, force) => { refreshes.push(['detail', key, force]); return true; };
    context.fetch = async () => ({ ok: true, json: async () => ({ ok: true, save_task_status: 'completed', proposal_outcomes: status ? [{ id: 'year-1', status }] : [] }) });
    context.openProblemSuggestionsConfirm();
    await context.confirmProblemSuggestions();
    assert.equal(context.state.utility.proposalSelections['artist-1'], true);
    assert.equal(Boolean(context.state.utility.proposalSelections['year-1']), status !== 'committed');
    if (status === 'committed') {
      assert.deepEqual(refreshes, [['collection', true], ['detail', context.state.utility.selectedProblematicKey, true]]);
      assert.equal(modal.overlay.hidden, true);
    } else {
      assert.deepEqual(refreshes, []);
      assert.equal(modal.overlay.hidden, false);
    }
  });
}
