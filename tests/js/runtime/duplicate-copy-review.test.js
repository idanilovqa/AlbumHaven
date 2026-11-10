const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const runtime = path.join(__dirname, '../../../music_app/static/js/runtime');
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
function load() {
  const context = { escapeHtml, console };
  context.window = context;
  vm.createContext(context);
  for (const file of ['compact-data-table.js', 'utility-list-builders.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtime, file), 'utf8'), context, { filename: file });
  }
  return context;
}
function album() {
  return { duplicate_copy_review: [
    { copy_number: 1, folder_name: '雪 <folder>', track_count: 1, total_duration_seconds: 65,
      tracks: [{ title: 'A <song>', file_name: '雪 & long filename.flac', track_number: 1,
        disc_number: 2, artist: 'A & B', year: 2024, duration_seconds: 65, format: 'FLAC',
        codec: null, bitrate: null, sample_rate: null, bit_depth: null }] },
    { copy_number: 2, folder_name: 'Other folder', track_count: 1, total_duration_seconds: 0,
      tracks: [{ title: 'Second', file_name: 'second.mp3', duration_seconds: 0, format: 'MP3',
        codec: 'mp3', bitrate: 320000, sample_rate: 44100, bit_depth: 16 }] },
  ], duplicate_sources: [{ folder_path: 'RAW_PRIVATE_CANARY', tracks: [{ title: 'RAW_TRACK_CANARY' }] }] };
}

test('review requires at least two DTO copies and never falls back to raw sources', () => {
  const c = load();
  for (const input of [null, {}, { duplicate_sources: album().duplicate_sources }, { duplicate_copy_review: [] },
    { duplicate_copy_review: album().duplicate_copy_review.slice(0, 1) }]) {
    assert.equal(c.buildDuplicateCopyReviewHtml(input), '');
  }
});

test('review renders real escaped DTO metadata in collapsed native disclosures without actions', () => {
  const c = load();
  const html = c.buildDuplicateCopyReviewHtml(album());
  assert.equal((html.match(/<details\b/g) || []).length, 2);
  assert.equal((html.match(/<summary\b/g) || []).length, 2);
  assert.doesNotMatch(html, /<details\b[^>]*\bopen(?:\s|=|>)/);
  for (const text of ['Copy 1', 'Copy 2', '雪 &lt;folder&gt;', 'A &lt;song&gt;', '雪 &amp; long filename.flac', 'A &amp; B', '2024', 'FLAC', 'MP3', '1:05', '0:00']) {
    assert.ok(html.includes(text), `Missing DTO presentation: ${text}`);
  }
  assert.match(html, /unknown|unavailable/i);
  assert.doesNotMatch(html, /RAW_PRIVATE_CANARY|RAW_TRACK_CANARY|<button\b|<audio\b|<a\b|onclick=|data-(?:delete|play|edit|open-folder)/i);
});

test('review uses shared grouped table with seven desktop and two mobile columns', () => {
  const c = load();
  const configs = [];
  const realBuild = c.buildCompactDataTable;
  c.buildCompactDataTable = config => { configs.push(config); return realBuild(config); };
  c.buildDuplicateCopyReviewHtml(album());
  assert.equal(configs.length, 2);
  for (const config of configs) {
    assert.equal(config.mobile, 'grouped');
    assert.equal(config.mobileColumns, 'minmax(0,1.4fr) minmax(0,1fr)');
    assert.equal(config.columnsConfig.filter(column => column.visibility === 'desktop').length, 7);
    assert.equal(config.columnsConfig.filter(column => column.visibility === 'mobile').length, 2);
    assert.equal(config.rows.length, 1);
  }
});

test('distinct surface IDs have unique header references and replacement payload starts collapsed', () => {
  const c = load();
  const first = c.buildDuplicateCopyReviewHtml(album(), 'pf-review');
  const next = album();
  next.duplicate_copy_review.reverse();
  const second = c.buildDuplicateCopyReviewHtml(next, 'album-review');
  const combined = first + second;
  const ids = [...combined.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const labels = [...combined.matchAll(/aria-labelledby="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/));
  assert.ok(labels.length > 0);
  for (const id of labels) assert.ok(ids.includes(id), `Unbound header ${id}`);
  assert.doesNotMatch(second, /<details\b[^>]*\bopen(?:\s|=|>)/);
  assert.ok(second.indexOf('Other folder') < second.indexOf('雪 &lt;folder&gt;'));
});

test('shared table emits grouped visibility for real headers and cells, retaining old modes', () => {
  const c = load();
  const base = { id: 'grouped', headers: 'visible', mobileColumns: 'minmax(0,1.4fr) minmax(0,1fr)',
    columnsConfig: [{ key: 'desktop', label: 'Desktop', visibility: 'desktop' },
      { key: 'mobile', label: 'Mobile', visibility: 'mobile' }],
    rows: [{ key: 'one', cells: { desktop: 'Desktop content', mobile: 'Mobile content' } }] };
  const html = c.buildCompactDataTable({ ...base, mobile: 'grouped' });
  assert.match(html, /data-cdt-mobile="grouped"/);
  assert.match(html, /--cdt-mobile-columns:\s*minmax\(0,1.4fr\) minmax\(0,1fr\)/);
  for (const visibility of ['desktop', 'mobile']) {
    assert.equal((html.match(new RegExp(`data-cdt-visibility="${visibility}"`, 'g')) || []).length, 2);
  }
  for (const mobile of ['stack', 'preserve']) {
    assert.match(c.buildCompactDataTable({ ...base, mobile }), new RegExp(`data-cdt-mobile="${mobile}"`));
  }
  assert.match(c.buildCompactDataTable({ ...base, rows: [], mobile: 'grouped', emptyHtml: 'No tracks' }), /data-cdt-empty>No tracks/);
});

test('review reads only the DTO and does not mutate immutable loaded payloads', () => {
  const c = load();
  const input = album();
  for (const field of ['duplicate_sources', 'tracks', 'path', 'folder_path']) {
    Object.defineProperty(input, field, { get() { throw new Error(`Raw field read: ${field}`); } });
  }
  function freeze(value) {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(input.duplicate_copy_review);
  assert.match(c.buildDuplicateCopyReviewHtml(input), /Copy 1/);
});

test('authorized DTO paths are escaped and missing duration is not rendered as zero', () => {
  const c = load();
  const input = album();
  for (const copy of input.duplicate_copy_review) {
    copy.total_duration_seconds = null;
    for (const track of copy.tracks) track.duration_seconds = null;
  }
  input.duplicate_copy_review[0].folder_path = '/authorized/<folder>';
  input.duplicate_copy_review[0].tracks[0].path = '/authorized/<folder>/雪 & song.flac';
  const html = c.buildDuplicateCopyReviewHtml(input);
  assert.ok(html.includes('/authorized/&lt;folder&gt;'));
  assert.ok(html.includes('/authorized/&lt;folder&gt;/雪 &amp; song.flac'));
  assert.doesNotMatch(html, /0:00/);
  assert.match(html, /unknown|unavailable/i);
});

test('actual Problematic Files detail composes the real shared review output', () => {
  const c = load();
  Object.assign(c, {
    state: { utility: {} },
    getProblematicAlbumDisplayValue: (_album, field) => field === 'album' ? 'Release' : 'Artist',
    getProblematicAlbumFileTypes: () => ['FLAC'],
    buildAlbumDisplayCoverUrl: () => '',
    getAvailableAlbumMoveActions: () => [],
    buildUtilityAlbumArtbox: () => '<span>Existing cover</span>',
    buildDetectedProblemsHtml: () => '<p>Existing problem list</p>',
    ButtonComponent: { renderActionButton: () => '<button>Existing action</button>' },
  });
  const input = album();
  const expected = c.buildDuplicateCopyReviewHtml(input);
  const actual = c.buildProblematicAlbumDetail(input);
  assert.ok(actual.includes(expected));
  assert.ok(actual.includes('Existing problem list'));
  assert.ok(actual.includes('Existing cover'));
  assert.equal((actual.match(/<details\b/g) || []).length, 2);
});

function loadAlbumComposition() {
  const c = load();
  vm.runInContext(fs.readFileSync(path.join(runtime, 'tag-editor-and-optimistic-updates.js'), 'utf8'), c,
    { filename: 'tag-editor-and-optimistic-updates.js' });
  const els = { overlay: {}, cover: { innerHTML: '' }, list: { innerHTML: '' },
    duplicateWarning: { hidden: true, innerHTML: '' }, duplicateTabs: { hidden: true, innerHTML: '' } };
  const renderedTracks = [];
  Object.assign(c, {
    state: { modalReleases: [], modalDuplicateSourceIndices: { release: 1 }, ui: {} },
    document: { documentElement: { getAttribute: () => null } },
    getTrackModalElements: () => els,
    ButtonComponent: { renderActionButton: () => '', renderButton: () => '' },
    buildAlbumCoverSourceMarkersHtml: () => '',
    albumHasDisplayCover: () => false,
    formatAlbumDuration: () => 'Existing duration',
    formatTrackDuration: () => 'Existing track duration',
    buildOnPageAlertHtml: () => '<span>Existing duplicate warning</span>',
    buildTrackListHtml: tracks => {
      renderedTracks.push(tracks);
      return '<div data-existing-tracks>Existing playback tracks</div>';
    },
    renderTrackModalTabs: () => {},
    refreshTrackModalPlaybackState: () => {},
  });
  return { c, els, renderedTracks };
}

test('actual Album Details appends safe review for redacted paths without replacing ordinary tracks', () => {
  const { c, els, renderedTracks } = loadAlbumComposition();
  const input = { ...album(), key: 'release', duplicate_sources: [], tracks: [{ track_ref: 'ordinary-ref', title: 'Ordinary' }] };
  const expected = c.buildDuplicateCopyReviewHtml(input, 'album-duplicate-review');
  c.renderTrackModalRelease(input);
  assert.equal(els.list.innerHTML, '<div data-existing-tracks>Existing playback tracks</div>' + expected);
  assert.equal(renderedTracks.length, 1);
  assert.equal(renderedTracks[0], input.tracks);
  assert.equal(input.tracks[0].track_ref, 'ordinary-ref');
  assert.equal(els.duplicateTabs.hidden, true);
  assert.equal(els.duplicateWarning.hidden, true);
});

test('actual Album Details preserves authorized copy selection and avoids duplicate review alongside tabs', () => {
  const { c, els, renderedTracks } = loadAlbumComposition();
  const sources = [
    { folder_path: '/one', tracks: [{ title: 'First copy', track_ref: 'first-ref' }] },
    { folder_path: '/two', tracks: [{ title: 'Second copy', track_ref: 'second-ref' }] },
  ];
  const input = { ...album(), key: 'release', duplicate_sources: sources, tracks: [] };
  const before = JSON.stringify(sources);
  c.renderTrackModalRelease(input);
  assert.equal(renderedTracks[0], sources[1].tracks);
  assert.equal(renderedTracks[0][0].track_ref, 'second-ref');
  assert.equal(els.list.innerHTML, '<div data-existing-tracks>Existing playback tracks</div>');
  assert.equal(els.duplicateTabs.hidden, false);
  assert.match(els.duplicateTabs.innerHTML, /Copy 1/);
  assert.match(els.duplicateTabs.innerHTML, /Copy 2/);
  assert.match(els.duplicateTabs.innerHTML, /is-active[\s\S]*data-track-duplicate-source-index="1"/);
  assert.equal(JSON.stringify(sources), before);
  assert.equal(c.state.modalDuplicateSourceIndices.release, 1);
});

// Deliberately small DOM model for renderer lifecycle, not browser/layout proof.
// Setting innerHTML creates new nodes, as the browser does. Moving an existing
// subtree via replaceWith/replaceChild retains its details nodes and open state.
function disclosureDetailHost(document) {
  let markup = '';
  const host = {
    review: null,
    removeAttribute() {},
    querySelector(selector) {
      if (selector === '.duplicate-copy-review') return this.review;
      return this.review?.querySelector(selector) || null;
    },
    querySelectorAll(selector) { return this.review?.querySelectorAll(selector) || []; },
    contains(node) { return node === this.review || Boolean(this.review?.details.some(detail => detail === node || detail.summary === node)); },
    replaceChild(replacement, old) {
      assert.equal(old, this.review, 'Replacing a node that is not mounted');
      old.parentNode = null;
      replacement.parentNode = this;
      this.review = replacement;
      return old;
    },
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = String(value);
      if (this.contains(document.activeElement)) {
        document.activeElement.wasDetached = true;
        document.activeElement = document.body;
      }
      if (this.review) this.review.parentNode = null;
      this.review = null;
      const match = markup.match(/<section\b[^>]*class="[^"]*\bduplicate-copy-review\b[^"]*"[^>]*>[\s\S]*?<\/section>/);
      if (!match) return;
      const section = {
        parentNode: this,
        details: [...match[0].matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)].map((entry) => ({
          open: /(?:^|\s)open(?:\s|=|$)/.test(entry[1]),
          textContent: entry[2],
        })),
        get isConnected() { return this.parentNode?.review === this; },
        replaceWith(replacement) { this.parentNode.replaceChild(replacement, this); },
        querySelectorAll(selector) {
          return selector === 'details' || selector === '.duplicate-copy-review__copy' ? this.details : [];
        },
        contains(node) { return this.details.some(detail => detail === node || detail.summary === node); },
        querySelector(selector) { return selector === 'summary' ? this.details[0]?.summary : this.querySelectorAll(selector)[0] || null; },
      };
      for (const disclosure of section.details) {
        disclosure.summary = {
          focusOptions: null,
          focus(options) { document.activeElement = this; this.focusOptions = options; },
          get isConnected() { return section.isConnected; },
        };
      }
      this.review = section;
    },
  };
  return host;
}

function loadProblematicDisclosureLifecycle() {
  const c = load();
  vm.runInContext(fs.readFileSync(path.join(runtime, 'utility-renderers-and-actions.js'), 'utf8'), c,
    { filename: 'utility-renderers-and-actions.js' });
  const input = { ...album(), key: 'release', detail_loaded: true };
  const document = { body: {}, activeElement: null };
  document.activeElement = document.body;
  const detail = disclosureDetailHost(document);
  const els = { overlay: {}, detail, count: {}, list: {
    innerHTML: '', scrollTop: 0, querySelector: () => null, querySelectorAll: () => [],
  } };
  Object.assign(c, {
    document,
    state: { utility: { problematicFiles: [input], selectedProblematicKey: 'release', loaded: true } },
    getUtilityModalElements: () => els,
    getFilteredProblematicAlbums: () => c.state.utility.problematicFiles,
    getSelectedProblematicAlbumFrom: items => items.find(item => item.key === c.state.utility.selectedProblematicKey),
    renderProblemFilterControls: () => {},
    initializeRepairSelections: () => {},
    buildProblematicAlbumListItem: () => '<div>Album navigation</div>',
    getProblematicAlbumDisplayValue: (_album, field) => field === 'album' ? 'Release' : 'Artist',
    getProblematicAlbumFileTypes: () => ['FLAC'],
    buildAlbumDisplayCoverUrl: () => '',
    getAvailableAlbumMoveActions: () => [],
    buildUtilityAlbumArtbox: () => '<span>Existing cover</span>',
    buildDetectedProblemsHtml: () => '<p>Existing problem list</p>',
    ButtonComponent: { renderActionButton: () => '<button>Existing action</button>' },
    // A max-width:900px utility-layout rerender can occur while the page still
    // uses desktop navigation. Invoke that renderer path, without geometry claims.
    usesMobilePageLayout: () => false,
  });
  return { c, detail, input };
}

test('PF layout rerender retains mounted disclosure for identical loaded DTO and album key', () => {
  const { c, detail, input } = loadProblematicDisclosureLifecycle();
  c.renderProblematicFiles();
  const mounted = detail.querySelector('.duplicate-copy-review');
  assert.ok(mounted);
  const disclosure = mounted.querySelectorAll('details')[0];
  disclosure.open = true;
  // The surrounding album object may be refreshed while its loaded DTO remains
  // identical. Retention must depend on payload/key, not a mutable array index.
  c.state.utility.problematicFiles = [{ ...input }];
  c.renderProblematicFiles();
  assert.equal(detail.querySelector('.duplicate-copy-review'), mounted);
  assert.equal(detail.querySelectorAll('details')[0], disclosure);
  assert.equal(disclosure.open, true);
});

test('PF replacement or reordered DTO resets disclosure instead of applying old copy state', () => {
  for (const reordered of [false, true]) {
    const { c, detail, input } = loadProblematicDisclosureLifecycle();
    c.renderProblematicFiles();
    const mounted = detail.querySelector('.duplicate-copy-review');
    mounted.querySelectorAll('details')[0].open = true;
    const replacement = JSON.parse(JSON.stringify(input.duplicate_copy_review));
    if (reordered) replacement.reverse();
    c.state.utility.problematicFiles = [{ ...input, duplicate_copy_review: replacement }];
    c.renderProblematicFiles();
    const next = detail.querySelector('.duplicate-copy-review');
    assert.notEqual(next, mounted);
    assert.equal(mounted.isConnected, false);
    assert.ok(next.querySelectorAll('details').every(node => !node.open));
    assert.match(next.querySelectorAll('details')[0].textContent, reordered ? /Other folder/ : /雪 &lt;folder&gt;/);
  }
});

test('PF switching album key clears disclosure even when a DTO reference is reused', () => {
  const { c, detail, input } = loadProblematicDisclosureLifecycle();
  c.renderProblematicFiles();
  const mounted = detail.querySelector('.duplicate-copy-review');
  mounted.querySelectorAll('details')[0].open = true;
  c.state.utility.problematicFiles = [{ ...input, key: 'another-release' }];
  c.state.utility.selectedProblematicKey = 'another-release';
  c.renderProblematicFiles();
  const next = detail.querySelector('.duplicate-copy-review');
  assert.notEqual(next, mounted);
  assert.ok(next.querySelectorAll('details').every(node => !node.open));
});

test('PF layout rerender preserves focus on the retained disclosure summary', () => {
  const { c, detail } = loadProblematicDisclosureLifecycle();
  c.renderProblematicFiles();
  const mounted = detail.querySelector('.duplicate-copy-review');
  const summary = mounted.querySelector('summary');
  summary.focus();
  c.renderProblematicFiles();
  assert.equal(detail.querySelector('.duplicate-copy-review'), mounted);
  assert.equal(c.document.activeElement, summary);
  assert.equal(summary.isConnected, true);
  if (summary.wasDetached) {
    assert.equal(summary.focusOptions?.preventScroll, true, 'Restoring a detached summary must not scroll the detail');
  }
});
