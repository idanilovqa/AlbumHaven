const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const ButtonComponent = require(path.join(repoRoot, 'music_app/static/js/button-component.js'));
const navigationItemTemplate = read('music_app/templates/components/navigation-tree-item.html');
const MBID = '6f3c2a1e-1111-4222-8333-444455556b51';

function loadContext({ allowed = true, responses = {} } = {}) {
  const requests = [];
  const toasts = [];
  const renders = [];
  const context = {
    console,
    ButtonComponent,
    Date,
    JSON,
    state: {
      status: { allowed_actions: { 'catalogue.enrichment.request': allowed } },
      coverLookup: { drawerOpen: true },
      utility: { problematicFiles: [], selectedProblematicKey: '' },
    },
    document: {
      getElementById: (id) => (id === 'navigation-tree-item-template' ? { textContent: navigationItemTemplate } : null),
      querySelector: () => null,
      body: { classList: { add() {}, remove() {} } },
    },
    showToast: (message, severity) => toasts.push([severity, message]),
    renderCoverLookupDrawer: () => renders.push('drawer'),
    buildAlbumArtboxHtml: ({ label }) => `<span class="album-artbox" aria-label="${label}"></span>`,
    buildOnPageAlertHtml: ({ title }) => `<div class="on-page-alert">${title}</div>`,
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      requests.push([method, url, options.body ? JSON.parse(options.body) : undefined]);
      const response = responses[`${method} ${url}`] || { status: 200, body: {} };
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('music_app/static/js/navigation-tree.js'), context);
  context.NavigationTree = context.window.NavigationTree;
  for (const file of [
    'music_app/static/js/runtime/markup-format-helpers.js',
    'music_app/static/js/runtime/alert-components.js',
    'music_app/static/js/runtime/cover-lookup-notification-helpers.js',
    'music_app/static/js/runtime/compact-data-table.js',
    'music_app/static/js/runtime/utility-list-builders.js',
    'music_app/static/js/runtime/musicbrainz-lookups.js',
  ]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  // The shared card lives with the cover-lookup drawer; load only its card builder.
  const drawer = read('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js');
  const start = drawer.indexOf('function buildNotificationTaskCardHtml(');
  vm.runInContext(drawer.slice(start, drawer.indexOf('\n}\n', start) + 3), context);
  return { context, requests, toasts, renders };
}

function menu(albumKey = 'k1') {
  const inserted = [];
  return { hidden: false, dataset: { albumKey }, inserted, insertAdjacentHTML: (_where, html) => inserted.push(html) };
}

test('the album menu offers both queue lookups, in full MusicBrainz wording, only to the owner', () => {
  const owner = loadContext().context.buildAlbumMenuMusicBrainzItems().join('');
  assert.match(owner, /class="account-menu-separator"/);
  assert.match(owner, />Queue MusicBrainz lookup for the artist</);
  assert.match(owner, />Queue MusicBrainz lookup for the album</);
  assert.doesNotMatch(owner, /\bMB\b/);
  assert.equal(loadContext({ allowed: false }).context.buildAlbumMenuMusicBrainzItems().length, 0);
});

test('search items appear only for what has no MBID, and only on the menu still showing that album', async () => {
  const target = (artist, album) => ({ 'GET /api/musicbrainz/lookups/target?album_key=k1': {
    status: 200, body: { target: { artist_has_mbid: artist, album_has_mbid: album } } } });

  let open = menu();
  await loadContext({ responses: target(false, false) }).context.appendAlbumMenuMusicBrainzSearchItems(open, 'k1');
  assert.match(open.inserted[0], />Search MusicBrainz for the artist<.*>Search MusicBrainz for the album</s);

  open = menu();
  await loadContext({ responses: target(true, false) }).context.appendAlbumMenuMusicBrainzSearchItems(open, 'k1');
  assert.doesNotMatch(open.inserted[0], /for the artist/);
  assert.match(open.inserted[0], /for the album/);

  open = menu();
  await loadContext({ responses: target(true, true) }).context.appendAlbumMenuMusicBrainzSearchItems(open, 'k1');
  assert.deepEqual(open.inserted, []);

  open = menu('k2');
  await loadContext({ responses: target(false, false) }).context.appendAlbumMenuMusicBrainzSearchItems(open, 'k1');
  assert.deepEqual(open.inserted, [], 'another album\'s menu is left alone');

  const { context, requests } = loadContext({ allowed: false });
  await context.appendAlbumMenuMusicBrainzSearchItems(menu(), 'k1');
  assert.deepEqual(requests, []);
});

test('each album menu action sends its own lookup for that album', async () => {
  const { context, requests, toasts } = loadContext({ responses: {
    'POST /api/musicbrainz/lookups': { status: 202, body: { request_id: 1, state: 'queued' } } } });

  assert.equal(context.runAlbumMenuMusicBrainzAction('musicbrainz-search-artist', { key: 'k1' }), true);
  assert.equal(context.runAlbumMenuMusicBrainzAction('musicbrainz-queue-album', { key: 'k1' }), true);
  assert.equal(context.runAlbumMenuMusicBrainzAction('mark-version', { key: 'k1' }), false);
  await new Promise((resolve) => setImmediate(resolve));

  const posts = requests.filter(([method]) => method === 'POST').map(([, , body]) => body);
  assert.deepEqual(posts, [
    { target_kind: 'artist', mode: 'search', album_key: 'k1' },
    { target_kind: 'album', mode: 'queue', album_key: 'k1' },
  ]);
  assert.ok(toasts.some(([, message]) => /Searching MusicBrainz for the artist/.test(message)));
  assert.ok(toasts.some(([, message]) => /starts within an hour, or with the next MusicBrainz sync/.test(message)));
});

test('a refused lookup shows the server reason and queues nothing', async () => {
  const { context, toasts } = loadContext({ responses: {
    'POST /api/musicbrainz/lookups': { status: 404, body: { detail: 'Artist or album was not found.' } } } });
  assert.equal(await context.requestMusicBrainzLookup({ targetKind: 'album', mode: 'queue', albumKey: 'gone' }), null);
  assert.deepEqual(toasts, [['error', 'Artist or album was not found.']]);
});

test('one batch is one card, titled by its kind, with matched and not matched counts', () => {
  const { context } = loadContext();
  const finished = context.buildMusicBrainzLookupCardHtml({
    batch_id: 4, started_at: '2026-11-16T10:00:00Z', finished_at: '2026-11-16T10:04:12Z',
    total: 15, matched: 12, not_matched: 3, albums: 15, artists: 0,
  });
  assert.match(finished, /class="cover-lookup-task-card is-completed"/);
  assert.match(finished, /cover-lookup-task-title">MusicBrainz lookup</);
  assert.match(finished, /12 releases matched, 3 not matched/);
  assert.match(finished, />15 looked up</);
  assert.match(finished, />Took 4m 12s</);
  assert.match(finished, /data-open-musicbrainz-lookup-batch="4"/);
  assert.match(finished, /data-dismiss-musicbrainz-lookup-batch="4"/);
  assert.doesNotMatch(finished, /data-open-cover-lookup-task/);

  const running = context.buildMusicBrainzLookupCardHtml({
    batch_id: 5, started_at: new Date().toISOString(), finished_at: null,
    total: 4, matched: 1, not_matched: 1, albums: 2, artists: 2,
  });
  assert.match(running, /is-running/);
  assert.match(running, />Looking up 2 of 4</);
  assert.match(running, /1 matched, 1 not matched/);
  assert.match(running, /width:50%/);
  assert.doesNotMatch(running, /data-dismiss-musicbrainz-lookup-batch/, 'a running card cannot be deleted');

  const single = context.buildMusicBrainzLookupCardHtml({
    batch_id: 6, started_at: '2026-11-16T10:00:00Z', finished_at: '2026-11-16T10:00:03Z', total: 1, matched: 0,
    not_matched: 1, artists: 1, albums: 0, single_title: 'Ktzat Acheret', single_target_kind: 'artist',
    single_outcome: 'not_matched', single_problem_label: 'MBID: Not found',
  });
  assert.match(single, /is-failed/);
  assert.match(single, /Ktzat Acheret · Artist/);
  assert.match(single, />MBID: Not found</);
});

test('the cover lookup card keeps its own title and actions through the shared card', () => {
  const { context } = loadContext();
  const html = context.buildNotificationTaskCardHtml({
    stateClass: 'is-completed', openAttributes: 'data-open-cover-lookup-task="t1"', openLabel: 'Open Cover Look Up: Drones',
    coverHtml: '<img>', title: 'Drones', byline: 'Muse · 2015', statusLabel: 'Art chosen', elapsedHtml: '',
    actionsHtml: '<button data-clear-cover-lookup-task="t1"></button>', progress: 100,
  });
  assert.match(html, /cover-lookup-task-title">Drones</);
  assert.match(html, /data-open-cover-lookup-task="t1"/);
  assert.match(html, /cover-lookup-task-actions"><button data-clear-cover-lookup-task="t1">/);
});

test('result rows are navigation-tree rows with the MBID or the Problematic Files label', () => {
  const { context } = loadContext();
  const matched = context.buildMusicBrainzLookupResultRowHtml({
    request_id: 1, target_kind: 'album', album_key: 'k1', album_title: 'Octavarium', artist_name: 'Dream Theater',
    year: 2005, outcome: 'matched', result_mbid: MBID, result_entity: 'release',
  });
  assert.match(matched, /navigation-tree-item navigation-tree-item--wide utility-list-item musicbrainz-lookup-result/);
  assert.match(matched, /utility-list-item-title">Octavarium</);
  assert.match(matched, /utility-list-item-subtitle">Dream Theater</);
  assert.match(matched, /MBID 6f3c2a1e…6b51/);
  assert.match(matched, new RegExp(`data-open-musicbrainz-url="https://musicbrainz.org/release/${MBID}"`));

  const missing = context.buildMusicBrainzLookupResultRowHtml({
    request_id: 2, target_kind: 'artist', local_artist_id: 7, artist_name: 'Ktzat Acheret', outcome: 'not_matched',
    problem_label: 'MBID: Not found', problem_occurrence_id: 19,
  });
  assert.match(missing, /utility-list-item-subtitle">Artist</);
  assert.match(missing, /MBID: Not found/);
  assert.match(missing, /data-open-musicbrainz-lookup-problem="19"/);
  assert.doesNotMatch(missing, /data-open-musicbrainz-url/);
});

test('notifications load only for the owner and are throttled between status polls', async () => {
  const listed = { 'GET /api/musicbrainz/lookups': { status: 200, body: {
    queued: [], batches: [{ batch_id: 4, finished_at: null, total: 1 }] } } };
  const { context, requests, renders } = loadContext({ responses: listed });

  assert.equal(await context.refreshMusicBrainzLookupNotifications(), true);
  assert.equal(await context.refreshMusicBrainzLookupNotifications(), false, 'a running batch waits 10 s');
  assert.equal(requests.length, 1);
  assert.deepEqual(renders, ['drawer']);
  assert.equal(context.getMusicBrainzLookupBatches()[0].batch_id, 4);
  // The same answer again does not repaint the drawer.
  await context.refreshMusicBrainzLookupNotifications({ force: true });
  assert.deepEqual(renders, ['drawer']);

  const stranger = loadContext({ allowed: false, responses: listed });
  assert.equal(await stranger.context.refreshMusicBrainzLookupNotifications({ force: true }), false);
  assert.deepEqual(stranger.requests, []);
});

test('Problematic Files offers the same lookups for an artist, Search only while it has no MBID', () => {
  const { context } = loadContext();
  const html = (detail) => context.buildMusicBrainzArtistProblemDetail({
    key: 'musicbrainz-artist:7', local_artist_id: 7, problem_reasons: ['MBID: Not found'],
    musicbrainz_detail: { local_artist_name: 'Ktzat Acheret', problem_reason_code: 'musicbrainz_artist_not_found',
      actions_available: true, ...detail },
    musicbrainz_ui: { manualValue: '' },
  });
  assert.match(html({ artist_mbid: null }), />Search MusicBrainz for the artist<.*>Queue MusicBrainz lookup for the artist<.*>Assign MBID</s);
  assert.doesNotMatch(html({ artist_mbid: MBID, problem_reason_code: 'musicbrainz_artist_metadata_conflict' }), /Search MusicBrainz/);
  assert.match(html({ artist_mbid: MBID, problem_reason_code: 'musicbrainz_artist_metadata_conflict' }), /Queue MusicBrainz lookup for the artist/);
  assert.doesNotMatch(html({ actions_available: false }), /MusicBrainz lookup|Search MusicBrainz/);
  assert.equal(loadContext({ allowed: false }).context.buildMusicBrainzLookupButtonsHtml({ subject: 'artist' }), '');
});

const ALBUM_ROW = JSON.parse(read('tests/fixtures/musicbrainz/problematic-album-summary-item.json'));

test('an album MusicBrainz has no info on is a valid summary row that never requests an album detail', async () => {
  const { context, requests } = loadContext();
  vm.runInContext(read('music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'), context);
  const album = { key: 'zed', name: 'Zed', problem_reasons: ['Missing year'], detail_loaded: false };
  const { summaryItems } = context.validateProblematicSummaryPayload({ ok: true, items: [ALBUM_ROW, album] });
  assert.deepEqual(summaryItems.map((item) => item.key), [ALBUM_ROW.key, 'zed']);
  context.state.utility.problematicFiles = [ALBUM_ROW];
  assert.equal(await context.loadProblematicAlbumDetail(ALBUM_ROW.key, true), ALBUM_ROW);
  assert.deepEqual(requests, []);
  assert.equal(context.isMusicBrainzAlbumProblem(album), false);
});

test('the album entry shows its label and the album lookups for its own album key', async () => {
  const { context, requests } = loadContext({ responses: {
    'POST /api/musicbrainz/lookups': { status: 202, body: { request_id: 3, state: 'running' } } } });
  context.buildUtilityAlbumArtbox = (_album, { label }) => `<span class="album-artbox" aria-label="${label}"></span>`;
  const html = context.buildMusicBrainzAlbumProblemDetail(ALBUM_ROW);
  assert.match(html, /utility-detail-title">…Карусель Эпох…</);
  assert.match(html, /MusicBrainz has no info/);
  assert.match(html, /data-musicbrainz-lookup-album="carousel"[^>]*data-musicbrainz-lookup="search"[^>]*>.*Search MusicBrainz for the album/s);
  assert.match(html, /Queue MusicBrainz lookup for the album/);

  const button = { dataset: { musicbrainzLookup: 'search', musicbrainzLookupAlbum: 'carousel' } };
  const event = { type: 'click', target: { closest: (selector) => (selector === '[data-musicbrainz-lookup-album]' ? button : null) },
    preventDefault() {} };
  assert.equal(context.handleMusicBrainzLookupEvent(event), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.find(([method]) => method === 'POST')[2], { target_kind: 'album', mode: 'search', album_key: 'carousel' });

  assert.doesNotMatch(loadContext({ allowed: false }).context.buildMusicBrainzAlbumLookupHtml(ALBUM_ROW), /<button/);
});

test('the pasted artist field is the app search-field component with its open-link action inside', () => {
  const { context } = loadContext();
  const html = context.buildMusicBrainzManualResolutionHtml(
    { local_artist_name: 'Ktzat Acheret', actions_available: true }, { manualValue: '' });
  assert.match(html, /<div class="search-field musicbrainz-manual-field">\s*<div class="search-field-control ui-input-action">\s*<input id="musicbrainz-manual-artist" type="search"/);
  assert.match(html, /<span class="search-field-action"><button[^>]*search-field-button[^>]*aria-label="Open entered artist on MusicBrainz"/);
  assert.match(html, /<label class="musicbrainz-manual-field-label" for="musicbrainz-manual-artist">/);
});

test('the notification panel is headed Notifications whatever cards it holds; each card keeps its own title', () => {
  const markup = read('music_app/templates/index.html');
  const drawer = read('music_app/static/js/runtime/cover-lookup-modal-and-drawer.js');
  assert.match(markup, /<h3 class="cover-lookup-drawer-title">Notifications<\/h3>/);
  assert.doesNotMatch(drawer, /cover-lookup-drawer-title/, 'nothing renames the panel by its cards');
  assert.match(read('music_app/static/js/runtime/musicbrainz-lookups.js'), /const MUSICBRAINZ_LOOKUP_TITLE = 'MusicBrainz lookup';/);
});
