const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../e2e/helpers/visibleAlbumMetadata.js')).href;

test('visible card metadata retains exact credited artist and year independently', async () => {
  const { parseVisibleAlbumMetadata } = await import(moduleUrl);
  assert.deepEqual(parseVisibleAlbumMetadata('Various Artists · 2026'), { artist: 'Various Artists', year: '2026' });
});

test('visible card metadata preserves internal punctuation without inventing an unknown year', async () => {
  const { parseVisibleAlbumMetadata } = await import(moduleUrl);
  assert.deepEqual(parseVisibleAlbumMetadata('A · B Ensemble'), { artist: 'A · B Ensemble', year: '' });
  assert.deepEqual(parseVisibleAlbumMetadata('A · B Ensemble · 2000'), { artist: 'A · B Ensemble', year: '2000' });
});

test('visible card metadata retains an absent artist separately from a known year', async () => {
  const { parseVisibleAlbumMetadata } = await import(moduleUrl);
  assert.deepEqual(parseVisibleAlbumMetadata('1966'), { artist: '', year: '1966' });
  assert.deepEqual(parseVisibleAlbumMetadata(''), { artist: '', year: '' });
});


test('separate metadata fields preserve numeric artist names and unknown years', async () => {
  const { parseVisibleAlbumMetadata } = await import(moduleUrl);
  assert.deepEqual(parseVisibleAlbumMetadata('1966', ''), { artist: '1966', year: '' });
  assert.deepEqual(parseVisibleAlbumMetadata('311', '1997'), { artist: '311', year: '1997' });
});
