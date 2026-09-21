const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const searchToolbarUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'poms',
  'searchToolbar.js',
)).href;

test('settled search query prefers the current runtime view after a local clear', async () => {
  const { resolveCurrentCanonicalQuery } = await import(searchToolbarUrl);

  assert.equal(resolveCurrentCanonicalQuery('Joseph', ''), '');
  assert.equal(resolveCurrentCanonicalQuery('Joseph', 'Neal Morse'), 'Neal Morse');
  assert.equal(resolveCurrentCanonicalQuery('Joseph', null), 'Joseph');
});

test('settled search canonical evidence follows local query and family-filter transitions', async () => {
  const { resolveCurrentCanonicalView } = await import(searchToolbarUrl);
  const networkPayload = {
    query: 'Ария',
    surface: { active: 'albums' },
    artist_groups: [{ artist: 'Ария', albums: [{ name: 'Герой асфальта' }] }],
  };

  assert.deepEqual(resolveCurrentCanonicalView(networkPayload, {
    query: '',
    surface: 'albums',
    artists: ['Виталий Дубинин'],
  }), {
    query: '',
    surface: 'albums',
    artists: ['Виталий Дубинин'],
  });

  assert.deepEqual(resolveCurrentCanonicalView(networkPayload, {
    query: 'Ария',
    surface: 'albums',
    artists: ['Виталий Дубинин'],
  }), {
    query: 'Ария',
    surface: 'albums',
    artists: ['Виталий Дубинин'],
  });
  assert.deepEqual(resolveCurrentCanonicalView(networkPayload, null), {
    query: 'Ария', surface: 'albums', artists: ['Ария'],
  });
  assert.deepEqual(resolveCurrentCanonicalView(networkPayload, {
    query: 'Ария', surface: 'albums', artists: [],
  }), { query: 'Ария', surface: 'albums', artists: [] });
});


test('Home settlement uses the preserved runtime sidebar when the latest response omits it', async () => {
  const { resolveCurrentCanonicalSidebar, hasAppliedCanonicalSidebar } = await import(searchToolbarUrl);
  const payload = { query: '', surface: { active: 'albums' } };
  const runtime = { query: '', surface: 'home', sidebarArtists: ['Neal Morse', 'The Neal Morse Band'] };
  const canonical = resolveCurrentCanonicalSidebar(payload, runtime);
  const settled = { loaderVisible: false, payloadPresent: true, settledEmpty: false };
  assert.deepEqual(canonical, runtime.sidebarArtists);
  assert.equal(hasAppliedCanonicalSidebar(canonical, [...canonical], settled), true);
  assert.equal(hasAppliedCanonicalSidebar(canonical, [], settled), false);
  assert.equal(hasAppliedCanonicalSidebar(canonical, ['Neal Morse'], settled), false);
  assert.equal(hasAppliedCanonicalSidebar(canonical, ['Neal Morse', 'Stale Artist'], settled), false);
  assert.equal(hasAppliedCanonicalSidebar(canonical, [...canonical].reverse(), settled), false);
});

test('Home sidebar observation preserves explicit runtime clearing and real empty-state guards', async () => {
  const { resolveCurrentCanonicalSidebar, hasAppliedCanonicalSidebar } = await import(searchToolbarUrl);
  const payload = { artists_sidebar: [{ artist: 'Old Artist' }] };
  assert.deepEqual(resolveCurrentCanonicalSidebar(payload, null), ['Old Artist']);
  assert.deepEqual(resolveCurrentCanonicalSidebar(payload, { sidebarArtists: [] }), []);
  assert.equal(hasAppliedCanonicalSidebar([], [], { loaderVisible: true, payloadPresent: true }), false);
  assert.equal(hasAppliedCanonicalSidebar([], [], { loaderVisible: false, payloadPresent: false }), false);
  assert.equal(hasAppliedCanonicalSidebar([], ['Stale Artist'], { loaderVisible: false, payloadPresent: true }), false);
});


test('local clear settlement reads supported current-view family base groups without mutating state', async () => {
  const { readRuntimeCanonicalView, resolveCurrentCanonicalView } = await import(searchToolbarUrl);
  const { hasAppliedCanonicalArtistSurface } = await import(new URL('../helpers/productionViewObserver.js', searchToolbarUrl));
  const runtime = {
    view: { query: '', surface: { active: 'albums' }, selected_artist: 'Primary',
      artist_groups: [{ artist: 'Primary' }],
      related_filter_base_primary_groups: [{ artist: 'Primary' }],
      related_filter_base_family_groups: [{ artist: 'Family', albums: [{ name: 'Retained' }] }],
    },
    ui: { viewStateRevision: 1 }, busy: false,
  };
  const before = JSON.stringify(runtime);
  assert.equal(typeof readRuntimeCanonicalView, 'function');
  const snapshot = readRuntimeCanonicalView(runtime);
  const canonical = resolveCurrentCanonicalView({ query: 'Primary', artist_groups: [{ artist: 'Primary' }] }, snapshot);
  assert.deepEqual(canonical.artists, ['Primary', 'Family']);
  assert.equal(hasAppliedCanonicalArtistSurface(canonical.artists, ['Family']), true);
  assert.equal(hasAppliedCanonicalArtistSurface(canonical.artists, ['Unrelated']), false);
  assert.equal(hasAppliedCanonicalArtistSurface(canonical.artists, []), false);
  assert.equal(JSON.stringify(runtime), before);
});

test('runtime canonical evidence rejects unrelated gallery cache scope and query', async () => {
  const { readRuntimeCanonicalView } = await import(searchToolbarUrl);
  assert.equal(typeof readRuntimeCanonicalView, 'function');
  for (const cache of [
    { relatedFilterBaseArtist: 'Other owner', relatedFilterBaseQuery: '' },
    { relatedFilterBaseArtist: 'Primary', relatedFilterBaseQuery: 'old query' },
    { relatedFilterBaseArtist: 'Primary', relatedFilterBaseQuery: '', accountId: 'foreign', libraryId: 'foreign' },
  ]) {
    const snapshot = readRuntimeCanonicalView({
      view: { query: '', selected_artist: 'Primary', artist_groups: [{ artist: 'Primary' }] },
      gallery: { ...cache, relatedFilterBaseFamilyGroups: [{ artist: 'Foreign cache' }] },
    });
    assert.deepEqual(snapshot.artists, ['Primary']);
  }
});
