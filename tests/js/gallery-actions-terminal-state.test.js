const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const galleryActionsUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'actions',
  'galleryActions.js',
)).href;
const galleryPageSource = require('node:fs').readFileSync(path.join(
  __dirname,
  '..',
  'e2e',
  'poms',
  'galleryPage.js',
), 'utf8');

function settledSnapshot(overrides = {}) {
  return {
    activeLoader: false,
    activeRequestUrl: '',
    attachedMatch: false,
    busy: false,
    canonicalApplied: true,
    canonicalMatch: false,
    canonicalQuery: 'Joseph',
    expectedAlbum: 'Joseph: Part One - The Dreamer',
    expectedArtist: 'Neal Morse',
    expectedQuery: 'Joseph',
    inputQuery: 'Joseph',
    locationQuery: 'Joseph',
    pendingViewTransition: false,
    settledEmpty: false,
    startupHydrating: false,
    ...overrides,
  };
}

test('gallery target classification keeps every unsettled production state retryable', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);
  const retryableCases = [
    ['active request', { activeRequestUrl: '/view-data?surface=albums&q=Joseph' }],
    ['busy runtime', { busy: true }],
    ['active loader', { activeLoader: true }],
    ['pending view transition', { pendingViewTransition: true }],
    ['input query mismatch', { inputQuery: 'Jose' }],
    ['location query mismatch', { locationQuery: 'Jose' }],
    ['canonical query mismatch', { canonicalQuery: 'Jose' }],
    ['startup hydration', { startupHydrating: true }],
    ['canonical result not applied', { canonicalApplied: false }],
    ['canonical match awaiting virtual attachment', { canonicalMatch: true }],
  ];

  for (const [name, overrides] of retryableCases) {
    assert.deepEqual(
      classifyGalleryAlbumTargetState(settledSnapshot(overrides)),
      { status: 'retryable', reason: name },
      name,
    );
  }
});

test('gallery target classification reports a canonical match only after virtual attachment', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);

  assert.deepEqual(
    classifyGalleryAlbumTargetState(settledSnapshot({
      attachedMatch: true,
      canonicalMatch: true,
    })),
    { status: 'ready', reason: 'expected album attached' },
  );
});

test('gallery target classification rejects an attached DOM match without canonical response evidence', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);
  const snapshot = settledSnapshot({
    attachedMatch: true,
    canonicalMatch: false,
    observedAlbums: ['Selected Track Split Fixture'],
    observedArtists: ['Rarity Artist'],
  });

  assert.throws(
    () => classifyGalleryAlbumTargetState(snapshot),
    (error) => {
      assert.deepEqual(error.observedState, snapshot);
      return true;
    },
  );
});

test('gallery target classification throws immediately for an idle canonical mismatch with observed state', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);
  const snapshot = settledSnapshot({
    observedAlbums: ['Sola Scriptura', 'The Similitude of a Dream'],
    observedArtists: ['Neal Morse'],
  });

  assert.throws(
    () => classifyGalleryAlbumTargetState(snapshot),
    (error) => {
      assert.match(error.message, /Neal Morse/);
      assert.match(error.message, /Joseph: Part One - The Dreamer/);
      assert.match(error.message, /Sola Scriptura/);
      assert.deepEqual(error.observedState, snapshot);
      return true;
    },
  );
});

test('gallery target classification treats the explicit settled empty UI as terminal', async () => {
  const { classifyGalleryAlbumTargetState } = await import(galleryActionsUrl);
  const snapshot = settledSnapshot({
    loaderStatus: 'No artists, albums, or tracks matched your search.',
    loaderTitle: 'Nothing found',
    observedAlbums: [],
    observedArtists: [],
    settledEmpty: true,
  });

  assert.throws(
    () => classifyGalleryAlbumTargetState(snapshot),
    /Settled gallery cannot satisfy expected album/,
  );
});

test('gallery target state uses the current search input for local transitions that reuse a response payload', () => {
  assert.match(
    galleryPageSource,
    /inputQuery = await input\.count\(\) \? await input\.inputValue\(\) : ''[\s\S]*canonicalQuery = String\(inputQuery \|\| ''\)\.trim\(\)/,
  );
  assert.doesNotMatch(galleryPageSource, /runtimeQuery|state\?\.view\?\.query/);
});
