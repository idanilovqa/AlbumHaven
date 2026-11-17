const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const ButtonComponent = require(path.join(repoRoot, 'music_app/static/js/button-component.js'));

const CASE_ROW = { field: 'title', label: 'Track 1 title', disc_number: 1, track_number: 1, current_value: 'carry on',
  proposed_value: 'Carry On', kind: 'case', mode: 'auto', state: 'applied' };
const ARTIST_ROW = { field: 'album_artist', label: 'Album artist', disc_number: 0, track_number: 0,
  current_value: 'Christian Vander', proposed_value: 'Magma', kind: 'album_artist_renamed', mode: 'review', state: 'pending' };

function correctionItem(overrides = {}) {
  return {
    key: 'musicbrainz-correction:wurdah', entity_kind: 'musicbrainz_correction', name: 'Wurdah Ïtah',
    album_artist: 'Christian Vander', year: 1974, problem_reasons: ['Data Correction Needed'],
    musicbrainz_correction: { album_key: 'wurdah', correction_count: 2, corrections: [CASE_ROW, ARTIST_ROW] },
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

test('a correction shows its label, what was applied and what waits, with no Add to queue and no Apply changes', () => {
  const { context } = loadContext();
  const html = context.buildMusicBrainzCorrectionProblemDetail(correctionItem());

  assert.match(html, /alert-label--warning[^>]*>Data Correction Needed</);
  assert.match(text(html), /1 change was applied automatically \(display only; your files are unchanged\)\. 1 change waits for your approval in Settings → Edits Queue\./);
  assert.match(text(html), /Track 1 title carry on Carry On Applied Album artist Christian Vander Magma Waiting for approval/);
  assert.doesNotMatch(html, /Add to queue|Apply changes|data-queue-musicbrainz-correction/);
});

test('an album sent to review whole says nothing was applied', () => {
  const { context } = loadContext();
  const item = correctionItem({ musicbrainz_correction: { album_key: 'wurdah', review_whole: true,
    corrections: [{ ...CASE_ROW, mode: 'review', state: 'pending' }] } });

  assert.match(text(context.buildMusicBrainzCorrectionProblemDetail(item)), /nothing was applied automatically: review the whole album/);
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
  assert.doesNotMatch(html, /Add to queue/);
});

const APPLIED = { section: 'applied', kinds: [{ kind: 'case', albums: 1, rows: 1 }], settings: { auto_submit_bulks: false, next_run_at: null } };
const REVIEW = { section: 'review', kinds: [{ kind: 'edition_suffix', albums: 3, rows: 5 }, { kind: 'album_artist_renamed', albums: 1, rows: 1 },
  { kind: 'whole_album', albums: 1, rows: 6 }], settings: { auto_submit_bulks: false, next_run_at: null } };
const ALBUM = { album_key: 'wurdah', album_title: 'Wurdah Ïtah', artist_name: 'Christian Vander', year: 1974, cover_ref: null };
const LOOKUPS = { queued: [
  { request_id: 9, target_kind: 'album', album_key: 'live', album_title: 'Live At Budokan', artist_name: 'Dream Theater', year: 2004, requested_at: '2026-11-16T10:20:00Z' },
  { request_id: 10, target_kind: 'artist', local_artist_id: 41, artist_name: 'Ktzat Acheret', requested_at: '2026-11-16T10:22:00Z' }],
queue_starts_at: '2026-11-16T11:20:00Z', batches: [] };

function queueContext(extra = {}) {
  return loadContext({ activeTab: 'edits-queue', responses: {
    'GET /api/musicbrainz/corrections/edits?section=applied': { status: 200, body: APPLIED },
    'GET /api/musicbrainz/corrections/edits?section=review': { status: 200, body: REVIEW },
    'GET /api/musicbrainz/corrections/edits/case?section=applied&offset=0&limit=50': { status: 200,
      body: { albums: [{ ...ALBUM, rows: [CASE_ROW] }], next_offset: 50 } },
    'GET /api/musicbrainz/corrections/edits/case?section=applied&offset=50&limit=50': { status: 200,
      body: { albums: [{ ...ALBUM, album_key: 'secret', album_title: 'The Secret', rows: [CASE_ROW] }], next_offset: null } },
    'GET /api/musicbrainz/lookups': { status: 200, body: LOOKUPS }, ...extra } });
}

test('Applied automatically lists kinds; opening one pages its albums with their rows and Undo', async () => {
  const { context, detail, requests } = queueContext();
  await context.loadUtilityEditsQueue(true);

  assert.match(detail.innerHTML, /data-edits-queue-section="applied"[^>]*>Applied automatically</);
  assert.match(text(detail.innerHTML), /Case only · 1 album, 1 change/);
  assert.match(detail.innerHTML, /id="edits-queue-auto-submit" role="switch" aria-checked="false">Auto submit bulks/);
  assert.match(detail.innerHTML, /title="Bulk Correction arrives soon\."/);

  context.handleMusicBrainzCorrectionEvent({ target: closest({ 'data-edits-queue-open-kind': 'case' }), preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(detail.innerHTML), /Wurdah Ïtah Christian Vander · 1974 .*carry on Carry On Applied/);
  assert.match(detail.innerHTML, /data-edits-queue-album-action="undo" data-edits-queue-album="wurdah"/);

  context.handleMusicBrainzCorrectionEvent({ target: closest({ 'data-edits-queue-more': 'case' }), preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(detail.innerHTML), /The Secret/);
  assert.deepEqual(requests.filter(([, url]) => url.includes('/edits/case')).map(([, url]) => new URL(url, 'http://x').searchParams.get('offset')), ['0', '50']);
});

test('Waiting for approval offers Approve kind except for artist kinds and whole albums', async () => {
  const { context, detail } = queueContext();
  vm.runInContext("editsQueue.section = 'review'", context);
  await context.loadUtilityEditsQueue(true);

  assert.match(detail.innerHTML, /data-edits-queue-approve-kind="edition_suffix"/);
  assert.doesNotMatch(detail.innerHTML, /data-edits-queue-approve-kind="album_artist_renamed"/);
  assert.doesNotMatch(detail.innerHTML, /data-edits-queue-approve-kind="whole_album"/);
  assert.match(text(detail.innerHTML), /Whole albums to review · 1 album, 6 changes/);
});

test('an artist kind is never approved as a kind, even if asked', async () => {
  const { context, requests } = queueContext();

  await context.approveEditsQueueKind('album_artist_renamed');

  assert.equal(requests.some(([method]) => method === 'POST'), false);
});

test('undo, approve and skip send the album; approving a kind sends the kind', async () => {
  const { context, requests } = queueContext({
    'POST /api/musicbrainz/corrections/albums/undo': { status: 200, body: { decided: 1 } },
    'POST /api/musicbrainz/corrections/albums/skip': { status: 200, body: { decided: 2 } },
    'POST /api/musicbrainz/corrections/kinds/edition_suffix/approve': { status: 200, body: { decided: 5 } } });
  await context.loadUtilityEditsQueue(true);

  await context.decideEditsQueueAlbum('undo', 'wurdah');
  await context.decideEditsQueueAlbum('skip', 'secret');
  await context.approveEditsQueueKind('edition_suffix');

  assert.deepEqual(requests.filter(([method]) => method === 'POST').map(([, url, body]) => [url, body]), [
    ['/api/musicbrainz/corrections/albums/undo', { album_key: 'wurdah' }],
    ['/api/musicbrainz/corrections/albums/skip', { album_key: 'secret' }],
    ['/api/musicbrainz/corrections/kinds/edition_suffix/approve', {}],
  ]);
});

test('the MusicBrainz Look Up tab lists queued look ups with their start time', async () => {
  const { context, detail } = queueContext();
  await context.loadUtilityEditsQueue(true);
  context.handleMusicBrainzCorrectionEvent({ target: closest({ 'data-edits-queue-tab': 'musicbrainz-lookup' }), preventDefault() {} });

  assert.match(text(detail.innerHTML), /Live At Budokan Release · Dream Theater · 2004 — queued .*, starts by itself at /);
  assert.match(text(detail.innerHTML), /Ktzat Acheret Artist — queued /);
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

test('removing a look up deletes it and reloads the queue', async () => {
  const { context, requests, renders } = queueContext({ 'DELETE /api/musicbrainz/lookups/9': { status: 200, body: { removed: true } } });
  await context.loadUtilityEditsQueue(true);

  await context.removeEditsQueueLookup('9');

  assert.deepEqual(requests.filter(([method]) => method === 'DELETE').map(([, url]) => url), ['/api/musicbrainz/lookups/9']);
  assert.ok(renders.includes('notifications'));
});

test('opening a look up opens the album, or the artist at its Problematic Files entry', async () => {
  const { context, opened } = queueContext();
  await context.loadUtilityEditsQueue(true);

  context.openEditsQueueLookup('9');
  context.openEditsQueueLookup('10');

  assert.deepEqual(opened.map(([kind, value]) => (kind === 'album' ? value.key : value)), ['live', 'musicbrainz-artist:41']);
});

test('an unavailable queue shows an error instead of an empty list', async () => {
  const { context, detail } = loadContext({ activeTab: 'edits-queue', responses: {
    'GET /api/musicbrainz/corrections/edits?section=applied': { status: 503, body: {} } } });

  await context.loadUtilityEditsQueue(true);

  assert.match(detail.innerHTML, /Edits Queue unavailable/);
});

// MusicBrainz look ups need the enrichment service; Data Correction is served without it.
test('unavailable look ups leave Data Correction usable and show the error only on their tab', async () => {
  const { context, detail } = queueContext({ 'GET /api/musicbrainz/lookups': { status: 503, body: {} } });

  await context.loadUtilityEditsQueue(true);

  assert.match(text(detail.innerHTML), /Case only · 1 album, 1 change/);
  assert.doesNotMatch(detail.innerHTML, /Edits Queue unavailable/);
  context.handleMusicBrainzCorrectionEvent({ target: closest({ 'data-edits-queue-tab': 'musicbrainz-lookup' }), preventDefault() {} });
  assert.match(detail.innerHTML, /Edits Queue unavailable/);
});

test('album details show the applied value beside the tag, and the tag editor keeps the real tags', () => {
  const context = { console, ButtonComponent };
  vm.createContext(context);
  for (const file of ['music_app/static/js/runtime/markup-format-helpers.js', 'music_app/static/js/runtime/alert-components.js',
    'music_app/static/js/runtime/album-details-components.js']) vm.runInContext(read(file), context);
  const loaders = read('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js');
  const start = loaders.indexOf('function getTrackTagInitialValues(');
  vm.runInContext(`${loaders.slice(start).split(/\r?\n\}\r?\n/)[0]}\n}\nthis.getTrackTagInitialValues = getTrackTagInitialValues;`, context);
  const album = { name: 'wurdah itah', display_title: 'Wurdah Ïtah', album_artist: 'christian vander', display_artist: 'Christian Vander' };
  const track = { title: 'malawelekaahm', display_title: 'Malawêlekaahm', artist: 'christian vander', display_artist: 'Christian Vander' };

  assert.equal(context.albumDisplayArtist(album), 'Christian Vander');
  assert.equal(context.albumTaggedArtistNote(album), '', 'a case correction is not a different artist');
  const values = context.getTrackTagInitialValues(track, album);
  assert.equal(values.title, 'malawelekaahm');
  assert.equal(values.artist, 'christian vander');
  assert.equal(values.album_artist, 'christian vander');
  assert.equal(values.album, 'wurdah itah');
  const table = read('music_app/static/js/runtime/tag-editor-and-optimistic-updates.js');
  assert.match(table, /const displayTitle = String\(track\.display_title \|\| trackRow\?\.title \|\| track\.title \|\| ''\)\.trim\(\);/);
  assert.match(table, /playbackTitle: String\(track\.title \|\| ''\)\.trim\(\),/);
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

test('an album listed only for a correction loads its stored rows when opened', async () => {
  const item = correctionItem({ musicbrainz_correction: { album_key: 'wurdah', correction_count: 2 } });
  const { context, requests, renders } = loadContext({ items: [item], responses: {
    'GET /api/musicbrainz/corrections?album_key=wurdah': { status: 200, body: { correction: {
      album_key: 'wurdah', correction_count: 2, corrections: [CASE_ROW, ARTIST_ROW] } } } } });

  assert.match(context.buildMusicBrainzCorrectionProblemDetail(item), /Loading the data correction/);
  await context.loadMusicBrainzCorrectionDetail(item);

  assert.deepEqual(requests, [['GET', '/api/musicbrainz/corrections?album_key=wurdah', undefined]]);
  assert.match(text(context.buildMusicBrainzCorrectionProblemDetail(item)), /Album artist Christian Vander Magma Waiting for approval/);
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

test('gallery cards show the corrected title and artist; keys and the tag fields stay on the tags', () => {
  const grid = read('music_app/static/js/runtime/virtual-artist-grid.js');

  assert.match(grid, /const displayName = album\?\.display_title \|\| album\?\.display_name \|\| album\?\.name \|\| '';/);
  assert.match(grid, /artist: album\.display_artist \|\| album\.album_artist,/);
  assert.doesNotMatch(grid, /albumKey[^\n]*display_title/);
});
