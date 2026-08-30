const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const helperUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'helpers',
  'rendererReconciliationHelpers.js',
)).href;

test('normalizeAlbum uses declared preview membership instead of representative tracks', async () => {
  const { normalizeAlbum } = await import(helperUrl);

  for (const trackCount of [14, 15]) {
    const normalized = normalizeAlbum({
      name: 'Studio Records',
      preview_only: true,
      track_count_preview: trackCount,
      tracks: [{ path: 'D:\\Synthetic Music\\DDT\\Studio Records\\01.mp3' }],
      year: 1999,
    });

    assert.equal(normalized.trackCount, trackCount);
  }
});

test('normalizeAlbum uses hydrated membership for full albums', async () => {
  const { normalizeAlbum } = await import(helperUrl);
  const tracks = Array.from({ length: 14 }, (_value, index) => ({
    path: `D:\\Synthetic Music\\DDT\\Studio Records\\${index + 1}.mp3`,
  }));

  const normalized = normalizeAlbum({
    name: 'Studio Records',
    preview_only: false,
    track_count_preview: 15,
    tracks,
    year: 1999,
  });

  assert.equal(normalized.trackCount, 14);
});

test('normalizeAlbum retains a compact preview count without representative tracks', async () => {
  const { normalizeAlbum } = await import(helperUrl);

  const normalized = normalizeAlbum({
    name: 'Studio Records',
    preview_only: true,
    track_count_preview: 13,
    tracks: [],
    year: 1999,
  });

  assert.equal(normalized.trackCount, 13);
});
