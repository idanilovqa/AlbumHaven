const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const ButtonComponent = require(path.join(repoRoot, 'music_app/static/js/button-component.js'));

const GERMAN = 'ec7bd678-53d1-4ad4-8e59-639ce44f583f';
const TRANCE = '6ca41771-44c2-4340-ad5c-9f732ac98187';

function loadContext({ item, responses = {} } = {}) {
  const requests = [];
  const renders = [];
  const context = {
    console,
    ButtonComponent,
    state: { utility: { problematicFiles: item ? [item] : [], selectedProblematicKey: item?.key || '' } },
    document: { querySelector: () => null },
    window: { open: (...args) => requests.push(['open', ...args]) },
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    buildAlbumArtboxHtml: ({ label }) => `<span class="artbox" aria-label="${label}"></span>`,
    buildOnPageAlertHtml: ({ title }) => `<div class="on-page-alert">${title}</div>`,
    renderProblematicFiles: () => renders.push('render'),
    loadProblematicFiles: async () => renders.push('reload'),
    refreshGalleryArtistMusicBrainzStatus: () => {},
    fetch: async (url, options = {}) => {
      requests.push([options.method || 'GET', url, options.body ? JSON.parse(options.body) : undefined]);
      const response = responses[`${options.method || 'GET'} ${url}`] || { status: 200, body: {} };
      return { ok: response.status < 400, status: response.status, json: async () => response.body };
    },
  };
  vm.createContext(context);
  for (const file of [
    'music_app/static/js/runtime/markup-format-helpers.js',
    'music_app/static/js/runtime/alert-components.js',
    'music_app/static/js/runtime/compact-data-table.js',
    'music_app/static/js/runtime/utility-list-builders.js',
    'music_app/static/js/runtime/player-and-waveform.js',
  ]) {
    vm.runInContext(read(file), context, { filename: file });
  }
  return { context, requests, renders };
}

function artistItem(overrides = {}) {
  return {
    key: 'musicbrainz-artist:7', entity_kind: 'artist', local_artist_id: 7,
    musicbrainz_occurrence_id: '19', name: 'Axxis', album_artist: 'Axxis',
    problem_reasons: ['MBID: Multiple matches'], local_album_count: 12, ...overrides,
  };
}

function detail(overrides = {}) {
  return {
    local_artist_id: 7, local_artist_name: 'Axxis', match_state: 'ambiguous',
    problem_reason_code: 'musicbrainz_artist_ambiguous', unresolved_reason: 'MBID: Multiple matches',
    local_album_count: 12, last_checked_at: '2026-11-04T12:00:00Z',
    candidates: [
      { artist_mbid: GERMAN, canonical_name: 'Axxis', country: 'Germany', artist_kind: 'Group',
        evidence_summary: '11 of 12 albums agree', musicbrainz_url: `https://musicbrainz.org/artist/${GERMAN}` },
      { artist_mbid: TRANCE, canonical_name: 'Axxis', artist_kind: 'Group', disambiguation: 'trance duo',
        evidence_summary: 'Name only', musicbrainz_url: `https://musicbrainz.org/artist/${TRANCE}` },
    ],
    ...overrides,
  };
}

test('artist rows reuse the NavigationTree item with the approved Artist subtitle', () => {
  const { context } = loadContext();
  const options = context.getProblematicAlbumNavigationOptions(artistItem(), false);
  assert.equal(options.label, 'Axxis');
  assert.equal(options.subtitle, 'Artist · MBID: Multiple matches');
  assert.equal(options.attributes['data-problematic-album-key'], 'musicbrainz-artist:7');
  assert.match(options.artworkHtml, /aria-label="Artist Axxis"/);
});

test('multiple matches render a three-column single-selection table with footer assignment', async () => {
  const item = artistItem();
  const { context } = loadContext({ item, responses: { 'GET /api/musicbrainz/artists/7': { status: 200, body: { artist: detail() } } } });
  await context.loadMusicBrainzArtistProblemDetail(item, { render: false });

  const html = context.buildMusicBrainzArtistProblemDetail(item);
  assert.match(html, /data-cdt-selection="single"/);
  assert.match(html, /Candidate artist \/ MBID/);
  assert.match(html, /Local evidence/);
  assert.equal((html.match(/data-musicbrainz-select-identity=/g) || []).length, 2);
  assert.match(html, /11 of 12 albums agree/);
  assert.match(html, new RegExp(`data-open-musicbrainz-url="https://musicbrainz.org/artist/${GERMAN}"`));
  assert.match(html, /Germany · Group/);
  const assign = html.match(/<button[^>]*data-musicbrainz-assign="1"[^>]*>/)[0];
  assert.match(assign, /ui-button--primary/);
  assert.match(assign, /disabled/, 'nothing is assigned until the owner picks a candidate');
  assert.doesNotMatch(html, /Keep unresolved|Keep current MBID/);
});

test('selecting a candidate and assigning sends the exact MBID, then reloads', async () => {
  const item = artistItem();
  const { context, requests, renders } = loadContext({
    item,
    responses: {
      'GET /api/musicbrainz/artists/7': { status: 200, body: { artist: detail() } },
      'PUT /api/musicbrainz/artists/7/match': { status: 200, body: { assigned: true } },
    },
  });
  await context.loadMusicBrainzArtistProblemDetail(item, { render: false });

  context.handleMusicBrainzArtistProblemEvent({ type: 'change', target: {
    value: GERMAN, matches: (selector) => selector === '[data-musicbrainz-select-identity]', closest: () => null,
  } });
  assert.doesNotMatch(context.buildMusicBrainzArtistProblemDetail(item).match(/<button[^>]*data-musicbrainz-assign="1"[^>]*>/)[0], /disabled/);

  const assignTarget = { matches: () => false, closest: (selector) => (selector === '[data-musicbrainz-assign]' ? {} : null) };
  assert.equal(context.handleMusicBrainzArtistProblemEvent({ type: 'click', target: assignTarget, preventDefault() {} }), true);
  await new Promise((resolve) => setImmediate(resolve));

  const put = requests.find(([method]) => method === 'PUT');
  assert.deepEqual(put.slice(0, 2), ['PUT', '/api/musicbrainz/artists/7/match']);
  assert.equal(put[2].artist_mbid, GERMAN);
  assert.ok(renders.includes('reload'));
});

test('metadata conflict compares current and suggested identities with keep and assign actions', async () => {
  const item = artistItem({ problem_reasons: ['MBID: Metadata conflict'] });
  const conflict = detail({
    problem_reason_code: 'musicbrainz_artist_metadata_conflict', unresolved_reason: 'MBID: Metadata conflict',
    artist_mbid: TRANCE, canonical_name: 'ARIA', country: 'Chile', musicbrainz_url: `https://musicbrainz.org/artist/${TRANCE}`,
    candidates: [{ artist_mbid: GERMAN, canonical_name: 'Ария', country: 'Russia', evidence_summary: '37 of 38 albums agree',
      musicbrainz_url: `https://musicbrainz.org/artist/${GERMAN}` }],
  });
  const { context } = loadContext({ item, responses: { 'GET /api/musicbrainz/artists/7': { status: 200, body: { artist: conflict } } } });
  await context.loadMusicBrainzArtistProblemDetail(item, { render: false });

  const html = context.buildMusicBrainzArtistProblemDetail(item);
  assert.match(html, /Artist identity \/ MBID/);
  assert.match(html, /Currently assigned: ARIA/);
  assert.match(html, /Suggested: Ария/);
  const keep = html.match(/<button[^>]*data-musicbrainz-keep-current="1"[^>]*>/)[0];
  assert.match(keep, /ui-button--secondary/);
  assert.doesNotMatch(html.match(/<button[^>]*data-musicbrainz-assign="1"[^>]*>/)[0], /disabled/,
    'the suggested identity starts selected');
});

test('an unconfirmed single name match is offered as a candidate to confirm, not as a conflict', async () => {
  const item = artistItem({ problem_reasons: ['MBID: Unconfirmed match'] });
  const unconfirmed = detail({
    problem_reason_code: 'musicbrainz_manual_review_required', unresolved_reason: 'MBID: Unconfirmed match',
    candidates: [{ artist_mbid: GERMAN, canonical_name: 'Axxis', evidence_summary: '0 of 2 albums agree',
      musicbrainz_url: `https://musicbrainz.org/artist/${GERMAN}` }],
  });
  const { context, requests } = loadContext({ item, responses: { 'GET /api/musicbrainz/artists/7': { status: 200, body: { artist: unconfirmed } } } });
  await context.loadMusicBrainzArtistProblemDetail(item, { render: false });

  const html = context.buildMusicBrainzArtistProblemDetail(item);
  assert.match(html, /Candidate artists/);
  assert.match(html, /0 of 2 albums agree/);
  assert.doesNotMatch(html, /Identity comparison|Keep current MBID/);
  assert.ok(!requests.some(([method]) => method === 'PUT'), 'nothing is assigned until the owner clicks Assign MBID');
});

test('not found offers manual search, a gated artist-page link and verified assignment only', async () => {
  const item = artistItem({ problem_reasons: ['MBID: Not found'] });
  const notFound = detail({ problem_reason_code: 'musicbrainz_artist_not_found', unresolved_reason: 'MBID: Not found', candidates: [] });
  const { context, requests } = loadContext({
    item,
    responses: {
      'GET /api/musicbrainz/artists/7': { status: 200, body: { artist: notFound } },
      'POST /api/musicbrainz/artists/7/validate': { status: 200, body: { candidate: { artist_mbid: GERMAN, canonical_name: 'Axxis' } } },
    },
  });
  await context.loadMusicBrainzArtistProblemDetail(item, { render: false });

  let html = context.buildMusicBrainzArtistProblemDetail(item);
  assert.match(html, /No MusicBrainz artist matched automatically\./);
  assert.match(html, /MusicBrainz artist URL or MBID/);
  assert.match(html, /data-open-musicbrainz-url="https:\/\/musicbrainz\.org\/search\?query=Axxis&amp;type=artist&amp;method=indexed"/);
  assert.match(html.match(/<button[^>]*aria-label="Open entered artist on MusicBrainz"[^>]*>/)[0], /disabled/);
  assert.match(html.match(/<button[^>]*data-musicbrainz-assign="1"[^>]*>/)[0], /disabled/);

  assert.equal(context.readMusicBrainzArtistMbid(`https://musicbrainz.org/artist/${GERMAN}`), GERMAN);
  assert.equal(context.readMusicBrainzArtistMbid('https://musicbrainz.org/release/' + GERMAN), null);
  context.handleMusicBrainzArtistProblemEvent({ type: 'input', target: {
    value: `https://musicbrainz.org/artist/${GERMAN}`,
    matches: (selector) => selector === '[data-musicbrainz-manual-artist]', closest: () => null,
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.find(([method]) => method === 'POST').slice(1), [
    '/api/musicbrainz/artists/7/validate', { artist_reference: `https://musicbrainz.org/artist/${GERMAN}` },
  ]);
  html = context.buildMusicBrainzArtistProblemDetail(item);
  assert.doesNotMatch(html.match(/<button[^>]*data-musicbrainz-assign="1"[^>]*>/)[0], /disabled/);
  assert.doesNotMatch(html.match(/<button[^>]*aria-label="Open entered artist on MusicBrainz"[^>]*>/)[0], /disabled/);
});

test('provider unavailable shows retry status and Retry now without candidate selection', async () => {
  const item = artistItem({ problem_reasons: ['MusicBrainz: Provider unavailable'] });
  const provider = detail({
    problem_reason_code: 'musicbrainz_provider_retry_exhausted', unresolved_reason: 'MusicBrainz: Provider unavailable',
    last_attempt_at: '2026-11-04T12:00:00Z', next_attempt_at: null,
  });
  const { context, requests } = loadContext({
    item,
    responses: {
      'GET /api/musicbrainz/artists/7': { status: 200, body: { artist: provider } },
      'POST /api/musicbrainz/artists/7/retry': { status: 202, body: { enqueued: true } },
    },
  });
  await context.loadMusicBrainzArtistProblemDetail(item, { render: false });

  const html = context.buildMusicBrainzArtistProblemDetail(item);
  assert.match(html, /Retry status/);
  assert.match(html, /Last attempt/);
  assert.match(html, /With the next library scan/);
  assert.match(html, /Restore the configured local service/);
  assert.doesNotMatch(html, /data-cdt-selection|data-musicbrainz-assign/);
  context.handleMusicBrainzArtistProblemEvent({ type: 'click', preventDefault() {}, target: {
    matches: () => false, closest: (selector) => (selector === '[data-musicbrainz-retry]' ? {} : null),
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requests.some(([method, url]) => method === 'POST' && url === '/api/musicbrainz/artists/7/retry'));
});

test('external links open only exact MusicBrainz pages', () => {
  const { context, requests } = loadContext({ item: artistItem() });
  const click = (url) => context.handleMusicBrainzArtistProblemEvent({ type: 'click', preventDefault() {}, target: {
    closest: (selector) => (selector === '[data-open-musicbrainz-url]' ? { dataset: { openMusicbrainzUrl: url } } : null),
  } });
  click(`https://musicbrainz.org/artist/${GERMAN}`);
  click('https://example.test/phish');
  assert.deepEqual(requests.filter(([kind]) => kind === 'open').map(([, url]) => url), [`https://musicbrainz.org/artist/${GERMAN}`]);
});

function loadGalleryStatus({ owner = true, artists = [] } = {}) {
  const requests = [];
  let renders = 0;
  const context = {
    console,
    state: { status: { allowed_actions: owner ? { 'catalogue.enrichment.request': true } : {} } },
    virtualGrid: { render: () => { renders += 1; } },
    fetch: async (url) => { requests.push(url); return { ok: true, json: async () => ({ artists }) }; },
  };
  vm.createContext(context);
  vm.runInContext(read('music_app/static/js/runtime/gallery-main-components.js'), context);
  return { context, requests, getRenders: () => renders };
}

test('owner gallery status maps active problems and pending first lookups by local artist', async () => {
  const { context, requests, getRenders } = loadGalleryStatus({ artists: [
    { local_artist_name: 'Axxis', unresolved_reason: 'MBID: Multiple matches', problem_occurrence_id: 19, match_state: 'ambiguous' },
    { local_artist_name: 'Angra', unresolved_reason: null, problem_occurrence_id: null, match_state: 'pending' },
    { local_artist_name: 'Nightwish', unresolved_reason: null, problem_occurrence_id: null, match_state: 'matched' },
  ] });

  assert.equal(await context.refreshGalleryArtistMusicBrainzStatus(), true);
  assert.deepEqual(requests, ['/api/musicbrainz/artists/status']);
  assert.equal(getRenders(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.getGalleryArtistMusicBrainzStatus({ artist: 'axxis' }))),
    { problem: { occurrence_id: '19', label: 'MBID: Multiple matches' }, state: '' });
  assert.equal(context.getGalleryArtistMusicBrainzStatus({ artist: 'Angra' }).state, 'pending');
  assert.equal(context.getGalleryArtistMusicBrainzStatus({ artist: 'Nightwish' }).problem, null);
  assert.equal(await context.refreshGalleryArtistMusicBrainzStatus(), false, 'refresh is throttled');
});

test('non-owners never request repair status', async () => {
  const { context, requests } = loadGalleryStatus({ owner: false });
  assert.equal(await context.refreshGalleryArtistMusicBrainzStatus({ force: true }), false);
  assert.deepEqual(requests, []);
});

test('alias-combined gallery groups receive status by canonical identity, problems winning', async () => {
  const { context } = loadGalleryStatus({ artists: [
    { local_artist_name: 'Kipelov', gallery_artist: 'Кипелов', unresolved_reason: null,
      problem_occurrence_id: null, match_state: 'pending' },
    { local_artist_name: 'Kipelov Band', gallery_artist: 'Кипелов', unresolved_reason: 'MBID: Not found',
      problem_occurrence_id: 31, match_state: 'not_found' },
  ] });

  await context.refreshGalleryArtistMusicBrainzStatus();

  const status = context.getGalleryArtistMusicBrainzStatus({ artist: 'Кипелов' });
  assert.equal(status.problem.occurrence_id, '31');
  assert.equal(context.getGalleryArtistMusicBrainzStatus({ artist: 'Kipelov' }).problem, null,
    'the local alias name is not a Gallery group');
});
