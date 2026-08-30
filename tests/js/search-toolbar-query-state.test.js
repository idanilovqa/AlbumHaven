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

test('settled search canonical evidence follows a proven local query transition', async () => {
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
    artists: ['Ария'],
  });
});
