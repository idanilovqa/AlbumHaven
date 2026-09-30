const assert = require('node:assert/strict');
const test = require('node:test');

const load = () => import('../e2e/support/artistTreeStorageState.js');
const key = 'albumhaven.shellLayoutPreferences.v1';

test('expanded baseline uses the normal origin preference without mutating shared login state', async () => {
  const { withArtistTreePreference } = await load();
  const auth = { cookies: [{ name: 'session', value: 'fixture' }], origins: [] };
  const first = withArtistTreePreference(auth, 'http://localhost:4173/?surface=albums');
  assert.deepEqual(first, { cookies: auth.cookies, origins: [{ origin: 'http://localhost:4173', localStorage: [
    { name: key, value: '{"artistTreeFolded":false}' },
  ] }] });
  first.origins[0].localStorage[0].value = '{"artistTreeFolded":true}';
  assert.equal(withArtistTreePreference(auth, 'http://localhost:4173').origins[0].localStorage[0].value,
    '{"artistTreeFolded":false}');
  assert.deepEqual(auth.origins, []);
});

test('baseline preserves cookies, unrelated origins and other shell preferences', async () => {
  const { withArtistTreePreference } = await load();
  const state = { cookies: [], origins: [
    { origin: 'https://other.example', localStorage: [] },
    { origin: 'http://localhost:4173', localStorage: [
      { name: 'other', value: 'retain' },
      { name: key, value: '{"artistTreeFolded":true,"infoDrawerWidthPx":400}' },
    ] },
  ] };
  const before = structuredClone(state);
  const result = withArtistTreePreference(state, 'http://localhost:4173');
  assert.deepEqual(JSON.parse(result.origins[1].localStorage[1].value), {
    artistTreeFolded: false, infoDrawerWidthPx: 400,
  });
  assert.deepEqual(result.origins[0], state.origins[0]);
  assert.deepEqual(result.origins[1].localStorage[0], state.origins[1].localStorage[0]);
  assert.deepEqual(state, before);
  assert.deepEqual(withArtistTreePreference(state, 'http://localhost:4173', null), state);
  assert.equal(JSON.parse(withArtistTreePreference(state, 'http://localhost:4173', true)
    .origins[1].localStorage[1].value).artistTreeFolded, true);
});

test('invalid setup fails instead of silently hiding corrupted preferences', async () => {
  const { withArtistTreePreference } = await load();
  assert.throws(() => withArtistTreePreference({ cookies: [], origins: [] }, 'http://localhost', 'false'), TypeError);
  assert.throws(() => withArtistTreePreference({ cookies: [], origins: [{
    origin: 'http://localhost', localStorage: [{ name: key, value: 'null' }],
  }] }, 'http://localhost'), /must be an object/);
});
