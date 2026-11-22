// "MusicBrainz: artist undecided" in Problematic Files (approved P1, P2 and row, 2026-11-21).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const ButtonComponent = require(path.join(repoRoot, 'music_app/static/js/button-component.js'));

const NORWAY = '166ef05e-53f7-44b8-a5d5-3944c188e12d';
const UK = '3d77bd89-f6da-47f9-aecd-d092403d0986';
const PATH = '/api/musicbrainz/albums/artist';

function arkItem({ favoured = true, found = [1, 0] } = {}) {
  return {
    key: 'musicbrainz-album:ark', entity_kind: 'musicbrainz_album', musicbrainz_album_key: 'ark',
    name: 'Ark', album_artist: 'Ark', year: 1999, detail_loaded: false,
    problem_reasons: ['MusicBrainz: artist undecided'],
    musicbrainz_artist_undecided: {
      album_key: 'ark', artist_name: 'Ark', track_count: 7,
      candidates: [
        { artist_mbid: NORWAY, canonical_name: 'Ark', disambiguation: 'norwegian metal band', found: found[0], sampled: 3,
          folder_album: 'Burn The Sun', favoured, musicbrainz_url: `https://musicbrainz.org/artist/${NORWAY}` },
        { artist_mbid: UK, canonical_name: 'Ark', disambiguation: 'UK prog rock band', found: found[1], sampled: 3,
          folder_album: null, favoured: false, musicbrainz_url: `https://musicbrainz.org/artist/${UK}` },
      ],
    },
  };
}

function loadContext(item, { status = 200, body = { assigned: true }, allowed = true, hold = null } = {}) {
  const requests = [];
  const events = [];
  const context = {
    console,
    ButtonComponent,
    state: { utility: { problematicFiles: [item], selectedProblematicKey: item.key } },
    document: { querySelector: () => null },
    window: { open: () => {}, AlbumHavenCapabilities: { allows: () => allowed } },
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout: () => {},
    buildUtilityAlbumArtbox: (_album, { label }) => `<span class="album-artbox" aria-label="${label}"></span>`,
    renderProblematicFiles: () => events.push('render'),
    loadProblematicFiles: async () => events.push('reload'),
    refreshGalleryArtistMusicBrainzStatus: () => events.push('gallery'),
    showToast: (message) => events.push(message),
    fetch: async (url, options = {}) => {
      requests.push([options.method || 'GET', url, options.body ? JSON.parse(options.body) : undefined]);
      if (hold) await hold;
      return { ok: status < 400, status, json: async () => body };
    },
  };
  vm.createContext(context);
  for (const name of ['markup-format-helpers', 'alert-components', 'compact-data-table', 'utility-list-builders', 'player-and-waveform']) {
    vm.runInContext(read(`music_app/static/js/runtime/${name}.js`), context);
  }
  // player-and-waveform declares helpers of its own; the fakes stay the ones under test.
  context.renderProblematicFiles = () => events.push('render');
  return { context, requests, events };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const assignButton = (html) => html.match(/<button[^>]*data-musicbrainz-assign-album-artist[^>]*>/)[0];
const choose = (context, value) => context.handleMusicBrainzArtistProblemEvent({
  type: 'change', target: { value, matches: (selector) => selector === '[data-musicbrainz-select-identity]', closest: () => null },
});
const press = (context) => context.handleMusicBrainzArtistProblemEvent({
  type: 'click', preventDefault() {},
  target: { matches: () => false, closest: (selector) => (selector === '[data-musicbrainz-assign-album-artist]' ? {} : null) },
});

test('the favoured artist is marked Suggested and pre-selected, with the reason in Local evidence (P1)', () => {
  const item = arkItem();
  const html = loadContext(item).context.buildMusicBrainzAlbumProblemDetail(item);

  assert.match(html, /utility-detail-title">Ark</);
  assert.match(html, />Year: 1999</);
  assert.match(html, />Tracks: 7</);
  assert.match(html, /alert-label--warning"[^>]*>MusicBrainz: artist undecided</);
  assert.match(html, /<\/div>\s*<div class="utility-album-problem-labels">.*<h4 class="utility-detail-section-title">Detected problems/s,
    'the label sits under the info block, before Detected problems');
  assert.match(html, />Two MusicBrainz artists are named Ark, and no release proves which one made this album\. Choose the artist to file it under; nothing changes until you do\.</);
  assert.match(html, />Candidate artists</);
  assert.match(html, /<strong>Suggested: Ark<\/strong><small>norwegian metal band<\/small>/);
  assert.match(html, new RegExp(`value="${NORWAY}"[^>]* checked`));
  assert.match(html, />1 of 3 sampled recordings; same folder as Burn The Sun</);
  assert.match(html, />No sampled recordings</);
  assert.match(assignButton(html), /ui-button--primary/);
  assert.doesNotMatch(assignButton(html), /disabled/);
  assert.doesNotMatch(html, /MusicBrainz has no info|Queue MusicBrainz lookup/);
});

test('evidence that favours neither pre-selects no one, and Assign waits for a choice (P2)', () => {
  const item = arkItem({ favoured: false, found: [3, 3] });
  const { context, requests } = loadContext(item);
  let html = context.buildMusicBrainzAlbumProblemDetail(item);

  assert.match(html, />Two MusicBrainz artists are named Ark, and this album’s recordings appear on releases of both\. Choose the artist to file it under; nothing changes until you do\.</);
  assert.doesNotMatch(html, /Suggested:| checked/);
  assert.match(assignButton(html), /disabled/);
  press(context);
  assert.deepEqual(requests, [], 'nothing to assign');

  assert.equal(choose(context, UK), true);
  html = context.buildMusicBrainzAlbumProblemDetail(item);
  assert.match(html, new RegExp(`value="${UK}"[^>]* checked`));
  assert.doesNotMatch(assignButton(html), /disabled/);
  assert.deepEqual(requests, [], 'choosing writes nothing');
});

test('Assign artist saves that album once and reloads the list', async () => {
  let release;
  const item = arkItem();
  const { context, requests, events } = loadContext(item, { hold: new Promise((resolve) => { release = resolve; }) });

  assert.equal(press(context), true);
  press(context);
  release();
  await settle();

  assert.deepEqual(requests, [['PUT', PATH, { album_key: 'ark', artist_mbid: NORWAY }]]);
  assert.ok(events.includes('reload'));
});

test('a refused assignment is readable and keeps the entry', async () => {
  const item = arkItem();
  const detail = 'This album changed, so nothing was saved. Reload Problematic Files.';
  const { context, events } = loadContext(item, { status: 409, body: { detail } });

  press(context);
  await settle();

  const html = context.buildMusicBrainzAlbumProblemDetail(item);
  assert.match(html, /on-page-alert--error/);
  assert.ok(html.includes(detail));
  assert.ok(!events.includes('reload'));
});

test('without the review capability Assign is disabled and sends nothing', async () => {
  const item = arkItem();
  const { context, requests } = loadContext(item, { allowed: false });

  assert.match(assignButton(context.buildMusicBrainzAlbumProblemDetail(item)), /disabled/);
  press(context);
  await settle();
  assert.deepEqual(requests, []);
});

test('an album already listed shows the entry beneath its detected problems, without the no-info lookups', () => {
  const item = { ...arkItem(), key: 'ark', entity_kind: undefined, musicbrainz_album_key: undefined, detail_loaded: true };
  const { context } = loadContext(item);

  const html = context.buildMusicBrainzArtistUndecidedHtml(item);
  assert.match(html, /MusicBrainz: artist undecided/);
  assert.match(html, /Assign artist/);
  assert.match(read('music_app/static/js/runtime/utility-list-builders.js'),
    /album\.musicbrainz_artist_undecided \? buildMusicBrainzArtistUndecidedHtml\(album\)/);
  assert.equal(choose(context, UK), true, 'its rows are selectable there too');
});

test('names, titles and evidence are escaped', () => {
  const item = arkItem();
  item.musicbrainz_artist_undecided.candidates[0].folder_album = '<img src=x>';
  item.musicbrainz_artist_undecided.artist_name = '<b>Ark</b>';
  assert.doesNotMatch(loadContext(item).context.buildMusicBrainzAlbumProblemDetail(item), /<img src=x>|<b>Ark<\/b>/);
});
