const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const ButtonComponent = require(path.join(repoRoot, 'music_app/static/js/button-component.js'));

const ARTIST = { field: 'album_artist', label: 'Album artist', current: 'Christian Vander', proposed: 'Magma', tracks: [] };
const TRACK_ARTISTS = { field: 'artist', label: 'Artist (12 tracks)', current: 'Christian Vander', proposed: 'Magma',
  tracks: Array.from({ length: 12 }, (_, index) => ({ disc_number: 1, track_number: index + 1 })) };

function correctionItem(overrides = {}) {
  return {
    key: 'musicbrainz-correction:wurdah', entity_kind: 'musicbrainz_correction', name: 'Wurdah Ïtah',
    album_artist: 'Christian Vander', year: 1974, track_count: 12, file_types: ['FLAC'],
    problem_reasons: ['Data Correction Needed'],
    musicbrainz_correction: { album_key: 'wurdah', release_mbid: 'r1', queued_at: null, corrections: [ARTIST, TRACK_ARTISTS] },
    detail_loaded: false, ...overrides,
  };
}

function loadContext({ items = [], responses = {}, owner = true, activeTab = 'problematic-files' } = {}) {
  const requests = [];
  const toasts = [];
  const renders = [];
  const opened = [];
  const detail = { innerHTML: '' };
  const context = {
    console,
    ButtonComponent,
    Date,
    JSON,
    state: { utility: { problematicFiles: items, activeTab } },
    document: { querySelector: () => null },
    showToast: (message, severity) => toasts.push([severity, message]),
    renderProblematicFiles: () => renders.push('problematic-files'),
    getUtilityModalElements: () => ({ overlay: {}, detail, list: { innerHTML: '' }, sidebarLabel: {} }),
    buildAlbumArtboxHtml: ({ label }) => `<span class="album-artbox" aria-label="${label}"></span>`,
    buildUtilityAlbumArtbox: (_album, { label }) => `<span class="album-artbox" aria-label="${label}"></span>`,
    buildOnPageAlertHtml: ({ title }) => `<div class="on-page-alert">${title}</div>`,
    buildGallerySwitchHtml: ({ id, label, checked, disabled }) => `<button id="${id}" role="switch" aria-checked="${checked}"${disabled ? ' disabled' : ''}>${label}</button>`,
    openTrackModal: (album) => opened.push(['album', album]),
    refreshMusicBrainzLookupNotifications: () => renders.push('notifications'),
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      requests.push([method, url, options.body ? JSON.parse(options.body) : undefined]);
      const response = responses[`${method} ${url}`] || { status: 200, body: {} };
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    },
  };
  context.window = { AlbumHavenCapabilities: { allows: (action) => owner && action === 'library.metadata_matches.review' } };
  vm.createContext(context);
  for (const file of [
    'music_app/static/js/runtime/markup-format-helpers.js',
    'music_app/static/js/runtime/alert-components.js',
    'music_app/static/js/runtime/compact-data-table.js',
    'music_app/static/js/runtime/utility-list-builders.js',
    'music_app/static/js/runtime/musicbrainz-corrections.js',
  ]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  context.openMusicBrainzArtistProblem = async (key) => opened.push(['artist', key]);
  return { context, requests, toasts, renders, opened, detail };
}

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('an album needing a correction shows its label, each change and Add to queue, never Apply changes', () => {
  const { context } = loadContext();
  const html = context.buildMusicBrainzCorrectionProblemDetail(correctionItem());

  assert.match(html, /alert-label--warning[^>]*>Data Correction Needed</);
  assert.match(text(html), /Year: 1974 Tracks: 12 File types: FLAC/);
  assert.match(text(html), /Detected problems MusicBrainz credits this album to Magma\. Add it to Settings → Edits Queue/);
  assert.match(text(html), /Tag In your files MusicBrainz Album artist Christian Vander Magma Artist \(12 tracks\) Christian Vander Magma/);
  assert.match(html, /data-queue-musicbrainz-correction="wurdah"[^>]*><span class="ui-button__content">Add to queue</);
  assert.doesNotMatch(html, /Apply changes/);
});

test('a credited-as name says which name the files carry; track titles are counted', () => {
  const { context } = loadContext();
  const credited = context.describeMusicBrainzCorrection([{ ...ARTIST, current: 'The Alan Parsons Project', proposed: 'Alan Parsons' }]);
  const titles = context.describeMusicBrainzCorrection([
    { field: 'title', current: 'A', proposed: 'B', tracks: [] }, { field: 'title', current: 'C', proposed: 'D', tracks: [] }]);

  assert.match(credited, /^MusicBrainz credits this album to Alan Parsons, not The Alan Parsons Project\./);
  assert.match(titles, /^2 track titles differ from MusicBrainz\./);
});

test('a queued correction reads In the queue and cannot be added twice', () => {
  const { context } = loadContext();
  const item = correctionItem();
  item.musicbrainz_correction.queued_at = '2026-11-16T10:20:00Z';

  assert.match(context.buildMusicBrainzCorrectionHtml(item), /disabled[^>]*><span class="ui-button__content">In the queue</);
});

test('without the review capability the correction is shown but cannot be queued', () => {
  const { context } = loadContext({ owner: false });

  const html = context.buildMusicBrainzCorrectionHtml(correctionItem());

  assert.match(html, /Data Correction Needed/);
  assert.doesNotMatch(html, /data-queue-musicbrainz-correction/);
});

test('an album with no corrections shows nothing', () => {
  const { context } = loadContext();

  assert.equal(context.buildMusicBrainzCorrectionHtml(correctionItem({ musicbrainz_correction: { corrections: [] } })), '');
  assert.equal(context.buildMusicBrainzCorrectionHtml({ name: 'Plain' }), '');
});

test('a listed album shows the correction beneath its own detected problems', () => {
  const { context } = loadContext();
  const album = { key: 'wurdah', name: 'Wurdah Ïtah', album_artist: 'Christian Vander', tracks: [], problem_reasons: ['Missing year', 'Data Correction Needed'],
    album_problem_rows: [{ reason: 'Missing year', row_key: 'r' }], musicbrainz_correction: correctionItem().musicbrainz_correction };
  context.state.utility.selectedProblemFilters = [];
  context.getVisibleProblemSuggestions = () => [];
  context.getAvailableAlbumMoveActions = () => [];
  context.buildAlbumDisplayCoverUrl = () => '';
  context.getProblematicAlbumDisplayValue = (value, field) => (field === 'album' ? value.name : value.album_artist);
  context.getProblematicAlbumFileTypes = () => ['FLAC'];

  const html = context.buildProblematicAlbumDetail(album);

  assert.ok(html.indexOf('Missing year') < html.indexOf('Data Correction Needed'));
  assert.match(html, /Add to queue/);
});

test('Add to queue sends only the album key and marks every row for that album queued', async () => {
  const item = correctionItem();
  const { context, requests, toasts, renders } = loadContext({ items: [item], responses: {
    'POST /api/musicbrainz/corrections/queue': { status: 201, body: { entry_id: 4, queued_at: '2026-11-16T10:20:00Z' } } } });

  assert.equal(await context.queueMusicBrainzCorrection('wurdah'), true);

  assert.deepEqual(requests, [['POST', '/api/musicbrainz/corrections/queue', { album_key: 'wurdah' }]]);
  assert.equal(item.musicbrainz_correction.queued_at, '2026-11-16T10:20:00Z');
  assert.deepEqual(toasts, [['info', 'Correction added to Settings → Edits Queue.']]);
  assert.deepEqual(renders, ['problematic-files']);
});

test('a refused Add to queue says why and leaves the row unqueued', async () => {
  const item = correctionItem();
  const { context, toasts } = loadContext({ items: [item], responses: {
    'POST /api/musicbrainz/corrections/queue': { status: 404, body: { detail: 'This album has no data correction.' } } } });

  assert.equal(await context.queueMusicBrainzCorrection('wurdah'), false);

  assert.equal(item.musicbrainz_correction.queued_at, null);
  assert.deepEqual(toasts, [['error', 'This album has no data correction.']]);
});

test('queue rows summarize their changes as in the approved mockup', () => {
  const { context } = loadContext();

  assert.equal(context.summarizeMusicBrainzCorrections([ARTIST, TRACK_ARTISTS]),
    'Album artist and 12 track artists: Christian Vander → Magma');
  assert.equal(context.summarizeMusicBrainzCorrections([
    { field: 'album', current: 'Secret', proposed: 'The Secret', tracks: [] },
    { field: 'title', current: 'A', proposed: 'B', tracks: [{}] }, { field: 'title', current: 'C', proposed: 'D', tracks: [{}] }]),
  'Album title: Secret → The Secret; 2 track titles');
});

const QUEUE = { items: [{ entry_id: 4, album_key: 'wurdah', album_title: 'Wurdah Ïtah', artist_name: 'Christian Vander', year: 1974,
  cover_path: null, corrections: [ARTIST, TRACK_ARTISTS], queued_at: '2026-11-16T10:20:00Z' }],
settings: { auto_submit_bulks: false, next_run_at: null } };
const LOOKUPS = { queued: [
  { request_id: 9, target_kind: 'album', album_key: 'live', album_title: 'Live At Budokan', artist_name: 'Dream Theater', year: 2004, requested_at: '2026-11-16T10:20:00Z' },
  { request_id: 10, target_kind: 'artist', local_artist_id: 41, artist_name: 'Ktzat Acheret', requested_at: '2026-11-16T10:22:00Z' }],
queue_starts_at: '2026-11-16T11:20:00Z', batches: [] };

function queueContext(extra = {}) {
  return loadContext({ activeTab: 'edits-queue', responses: {
    'GET /api/musicbrainz/corrections/queue': { status: 200, body: QUEUE },
    'GET /api/musicbrainz/lookups': { status: 200, body: LOOKUPS }, ...extra } });
}

test('the Edits Queue lists corrections with the switch off and Bulk Correction disabled, saying it arrives soon', async () => {
  const { context, detail } = queueContext();

  await context.loadUtilityEditsQueue(true);

  assert.match(detail.innerHTML, /role="tab" aria-selected="true" data-edits-queue-tab="data-correction">Data Correction</);
  assert.match(detail.innerHTML, /data-edits-queue-tab="musicbrainz-lookup">MusicBrainz Look Up</);
  assert.match(text(detail.innerHTML), /1 approved correction is waiting\./);
  assert.match(detail.innerHTML, /id="edits-queue-auto-submit" role="switch" aria-checked="false">Auto submit bulks/);
  assert.match(text(detail.innerHTML), /Off: Bulk Correction runs only when you click it\./);
  assert.match(detail.innerHTML, /<span title="Bulk Correction arrives soon\.">[^]*?disabled aria-disabled="true"[^>]*><span class="ui-button__content">Bulk Correction</);
  assert.match(text(detail.innerHTML), /Wurdah Ïtah Christian Vander · 1974 — Album artist and 12 track artists: Christian Vander → Magma/);
  assert.match(detail.innerHTML, /class="version-picker-option" data-open-edits-queue-entry="1" data-edits-queue-kind="correction" data-edits-queue-id="4"/);
  assert.match(detail.innerHTML, /data-remove-edits-queue-entry="1"/);
  assert.doesNotMatch(detail.innerHTML, /Apply changes/);
});

test('the MusicBrainz Look Up tab lists queued look ups with their start time', async () => {
  const { context, detail } = queueContext();
  await context.loadUtilityEditsQueue(true);
  context.handleMusicBrainzCorrectionEvent({ target: closest({ 'data-edits-queue-tab': 'musicbrainz-lookup' }), preventDefault() {} });

  assert.match(text(detail.innerHTML), /Live At Budokan Release · Dream Theater · 2004 — queued .*, starts by itself at /);
  assert.match(text(detail.innerHTML), /Ktzat Acheret Artist — queued /);
  assert.match(text(detail.innerHTML), /Queued look ups start together an hour after the oldest was added\./);
});

// A click target whose closest() answers the given attributes, inside the Edits Queue.
function closest(attributes, { disabled = false } = {}) {
  return {
    disabled,
    closest(selector) {
      if (selector === '.edits-queue') return {};
      if (selector.startsWith('#')) return selector.slice(1) === attributes.id ? this : null;
      const wanted = selector.split(',').map((part) => part.trim().replace(/^\[|\]$/g, ''));
      return wanted.some((name) => name in attributes) ? this : null;
    },
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
  };
}

test('switching Auto submit bulks on saves it and shows the next run', async () => {
  const { context, requests, detail } = queueContext({ 'PUT /api/musicbrainz/corrections/settings': {
    status: 200, body: { settings: { auto_submit_bulks: true, next_run_at: '2026-11-16T11:20:00Z' } } } });
  await context.loadUtilityEditsQueue(true);
  const target = closest({ id: 'edits-queue-auto-submit', 'aria-checked': 'false' });

  assert.equal(context.handleMusicBrainzCorrectionEvent({ target, preventDefault() {} }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(requests.at(-1), ['PUT', '/api/musicbrainz/corrections/settings', { auto_submit_bulks: true }]);
  assert.match(detail.innerHTML, /aria-checked="true">Auto submit bulks/);
  assert.match(text(detail.innerHTML), /Runs every hour\. Next run: /);
});

test('removing a correction or a look up deletes that entry and reloads the queue', async () => {
  const item = correctionItem();
  item.musicbrainz_correction.queued_at = '2026-11-16T10:20:00Z';
  const { context, requests, renders } = queueContext({
    'DELETE /api/musicbrainz/corrections/queue/4': { status: 200, body: { removed: true } },
    'DELETE /api/musicbrainz/lookups/9': { status: 200, body: { removed: true } } });
  context.state.utility.problematicFiles = [item];
  await context.loadUtilityEditsQueue(true);

  await context.removeEditsQueueEntry('correction', '4');
  await context.removeEditsQueueEntry('lookup', '9');

  const deletes = requests.filter(([method]) => method === 'DELETE').map(([, url]) => url);
  assert.deepEqual(deletes, ['/api/musicbrainz/corrections/queue/4', '/api/musicbrainz/lookups/9']);
  assert.equal(item.musicbrainz_correction.queued_at, null, 'Problematic Files offers Add to queue again');
  assert.ok(renders.includes('notifications'));
});

test('a failed removal says so and keeps the entry', async () => {
  const { context, toasts, detail } = queueContext({
    'DELETE /api/musicbrainz/corrections/queue/4': { status: 503, body: { detail: 'MusicBrainz corrections are unavailable.' } } });
  await context.loadUtilityEditsQueue(true);

  await context.removeEditsQueueEntry('correction', '4');

  assert.deepEqual(toasts, [['error', 'MusicBrainz corrections are unavailable.']]);
  assert.match(text(detail.innerHTML), /Wurdah Ïtah/);
});

test('opening an entry opens the album, or the artist at its Problematic Files entry', async () => {
  const { context, opened } = queueContext();
  await context.loadUtilityEditsQueue(true);

  context.openEditsQueueEntry('correction', '4');
  context.openEditsQueueEntry('lookup', '9');
  context.openEditsQueueEntry('lookup', '10');

  assert.deepEqual(opened.map(([kind, value]) => (kind === 'album' ? value.key : value)), ['wurdah', 'live', 'musicbrainz-artist:41']);
  assert.equal(opened[0][1].preview_only, true);
});

test('an unavailable queue shows an error instead of an empty list', async () => {
  const { context, detail } = loadContext({ activeTab: 'edits-queue', responses: {
    'GET /api/musicbrainz/corrections/queue': { status: 503, body: {} } } });

  await context.loadUtilityEditsQueue(true);

  assert.match(detail.innerHTML, /Edits Queue unavailable/);
  assert.doesNotMatch(detail.innerHTML, /version-picker-option/);
});

test('the album details header shows a.k.a. titles dimmed after the title and before the year', () => {
  const context = { console, ButtonComponent };
  vm.createContext(context);
  for (const file of ['music_app/static/js/runtime/markup-format-helpers.js', 'music_app/static/js/runtime/alert-components.js',
    'music_app/static/js/runtime/album-details-components.js']) vm.runInContext(read(file), context);

  const html = context.buildAlbumDetailsHeaderHtml({ artist: 'Christian Vander', album: 'Wurdah Ïtah', year: '1974',
    alternativeTitles: ['Tristan et Iseult'] });
  const plain = context.buildAlbumDetailsHeaderHtml({ artist: 'Christian Vander', album: 'Wurdah Ïtah', year: '1974', alternativeTitles: [] });

  assert.match(html, /Wurdah Ïtah <span class="album-details-header__aka">\(a\.k\.a\. Tristan et Iseult\)<\/span> <span aria-hidden="true">•<\/span> 1974/);
  assert.doesNotMatch(plain, /a\.k\.a\./);
});

test('phones list the Edits Queue only for whoever may review MusicBrainz corrections (owner 2026-11-16)', () => {
  const source = read('music_app/static/js/runtime/mobile-navigation.js');
  const start = source.indexOf('const MOBILE_UTILITY_SECTIONS');
  const end = source.indexOf('function mobileUtilitySubsectionAttribute');
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nthis.sections = MOBILE_UTILITY_SECTIONS; this.allowed = mobileUtilityTabAllowed;`, context);

  assert.deepEqual({ ...context.sections['edits-queue'] }, { label: 'Edits Queue', action: 'library.metadata_matches.review' });
  assert.deepEqual(Object.keys(context.sections).slice(0, 2), ['problematic-files', 'edits-queue']);
  assert.equal(context.allowed('edits-queue', { 'library.metadata_matches.review': true }), true);
  assert.equal(context.allowed('edits-queue', { 'library.problems.read': true }), false);
});

test('albums listed only for a correction show only under the Data Correction Needed filter', () => {
  const { context } = loadContext();
  const standalone = correctionItem();
  const listed = { key: 'other', name: 'Other', problem_reasons: ['Missing year', 'Data Correction Needed'] };

  assert.equal(context.isMusicBrainzCorrectionRowShown(standalone, []), false);
  assert.equal(context.isMusicBrainzCorrectionRowShown(standalone, ['Missing year']), false);
  assert.equal(context.isMusicBrainzCorrectionRowShown(standalone, ['Data Correction Needed']), true);
  assert.equal(context.isMusicBrainzCorrectionRowShown(listed, []), true, 'a listed album keeps its row and label');
  assert.match(read('music_app/static/js/runtime/musicbrainz-corrections.js'),
    /^const MUSICBRAINZ_CORRECTION_ROWS_SHOWN_BY_DEFAULT = false;$/m);
});

test('an album listed only for a correction loads its changes when opened', async () => {
  const item = correctionItem({ musicbrainz_correction: { album_key: 'wurdah', release_mbid: 'r1', queued_at: null, correction_count: 2 } });
  delete item.track_count;
  delete item.file_types;
  const { context, requests, renders } = loadContext({ items: [item], responses: {
    'GET /api/musicbrainz/corrections?album_key=wurdah': { status: 200, body: { correction: {
      album_key: 'wurdah', release_mbid: 'r1', queued_at: null, correction_count: 2, corrections: [ARTIST, TRACK_ARTISTS],
      track_count: 12, file_types: ['FLAC'] } } } } });

  assert.match(context.buildMusicBrainzCorrectionProblemDetail(item), /Loading the data correction/);
  await context.loadMusicBrainzCorrectionDetail(item);

  assert.deepEqual(requests, [['GET', '/api/musicbrainz/corrections?album_key=wurdah', undefined]]);
  assert.equal(item.track_count, 12);
  assert.match(text(context.buildMusicBrainzCorrectionProblemDetail(item)), /Artist \(12 tracks\) Christian Vander Magma/);
  assert.deepEqual(renders, ['problematic-files']);
});

test('a correction that cannot load says so', async () => {
  const item = correctionItem({ musicbrainz_correction: { album_key: 'wurdah', correction_count: 2 } });
  const { context } = loadContext({ items: [item], responses: {
    'GET /api/musicbrainz/corrections?album_key=wurdah': { status: 503, body: {} } } });

  await context.loadMusicBrainzCorrectionDetail(item);

  assert.match(context.buildMusicBrainzCorrectionProblemDetail(item), /Unable to load this data correction/);
});

function pageOf(offset, count, total) {
  const items = Array.from({ length: count }, (_, index) => correctionItem({
    key: `musicbrainz-correction:a${offset + index}`, name: `Album ${offset + index}`,
    musicbrainz_correction: { album_key: `a${offset + index}`, correction_count: 1, queued_at: null } }));
  return { status: 200, body: { items, total, next_offset: offset + count < total ? offset + count : null } };
}

function pagingContext() {
  const listed = { key: 'a1', name: 'Album 1', problem_reasons: ['Missing year', 'Data Correction Needed'],
    musicbrainz_correction: { album_key: 'a1', correction_count: 1 } };
  const f = loadContext({ items: [listed], responses: {
    'GET /api/musicbrainz/corrections/albums?offset=0&limit=100': pageOf(0, 100, 250),
    'GET /api/musicbrainz/corrections/albums?offset=100&limit=100': pageOf(100, 100, 250) } });
  f.context.state.utility.musicBrainzCorrectionAlbumCount = 250;
  f.context.state.utility.selectedProblemFilters = [];
  return f;
}

test('correction-only albums are not fetched until the Data Correction Needed filter is chosen', async () => {
  const { context, requests } = pagingContext();

  context.syncMusicBrainzCorrectionRows();
  await vm.runInContext('musicBrainzCorrectionPages.loading', context);
  assert.deepEqual(requests, []);
  assert.ok(context.getProblemReasonTypes().includes(context.normalizeProblemFilterReason('Data Correction Needed')),
    'the filter is offered from the count alone');
});

test('choosing the filter fetches page 1 only, and an already listed album keeps its own row', async () => {
  const { context, requests } = pagingContext();
  context.state.utility.selectedProblemFilters = ['Data Correction Needed'];

  context.syncMusicBrainzCorrectionRows();
  context.syncMusicBrainzCorrectionRows();
  await vm.runInContext('musicBrainzCorrectionPages.loading', context);

  assert.deepEqual(requests.map(([, url]) => url), ['/api/musicbrainz/corrections/albums?offset=0&limit=100']);
  const keys = context.state.utility.problematicFiles.map((item) => item.key);
  assert.equal(keys.length, 100, 'album a1 is listed already: 99 new rows beside it');
  assert.equal(keys.filter((key) => key.endsWith(':a1')).length, 0);
});

test('scrolling near the end fetches the next page, and not before', async () => {
  const { context, requests } = pagingContext();
  context.state.utility.selectedProblemFilters = ['Data Correction Needed'];
  context.syncMusicBrainzCorrectionRows();
  await vm.runInContext('musicBrainzCorrectionPages.loading', context);

  context.loadMoreMusicBrainzCorrectionRows(40, 100);
  await vm.runInContext('musicBrainzCorrectionPages.loading', context);
  assert.equal(requests.length, 1);

  context.loadMoreMusicBrainzCorrectionRows(85, 100);
  await vm.runInContext('musicBrainzCorrectionPages.loading', context);
  assert.deepEqual(requests.map(([, url]) => url).at(-1), '/api/musicbrainz/corrections/albums?offset=100&limit=100');
  assert.equal(context.state.utility.problematicFiles.length, 200);
});

test('a reloaded list without the paged rows starts again from page 1', async () => {
  const { context, requests } = pagingContext();
  context.state.utility.selectedProblemFilters = ['Data Correction Needed'];
  context.syncMusicBrainzCorrectionRows();
  await vm.runInContext('musicBrainzCorrectionPages.loading', context);

  context.state.utility.problematicFiles = [{ key: 'b', name: 'B', problem_reasons: [] }];
  context.syncMusicBrainzCorrectionRows();
  await vm.runInContext('musicBrainzCorrectionPages.loading', context);

  assert.deepEqual(requests.map(([, url]) => url), [
    '/api/musicbrainz/corrections/albums?offset=0&limit=100', '/api/musicbrainz/corrections/albums?offset=0&limit=100']);
});

test('the virtual list reports each rendered range so the next page can follow', () => {
  const source = read('music_app/static/js/runtime/problematic-files-virtual-list.js');
  assert.match(source, /if \(typeof onRangeRendered === 'function'\) onRangeRendered\(range\.end, items\.length\);/);
  assert.match(read('music_app/static/js/runtime/utility-renderers-and-actions.js'),
    /onRangeRendered: \(end, count\) => \{\s+if \(typeof loadMoreMusicBrainzCorrectionRows === 'function'\) loadMoreMusicBrainzCorrectionRows\(end, count\);/);
});
