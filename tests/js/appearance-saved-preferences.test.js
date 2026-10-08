const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../e2e/poms/utilityAppearanceTab.js')).href);
function pageWith(response, calls) {
  return {
    url: () => 'http://127.0.0.1:4173/library',
    context: () => ({ cookies: async () => [{ name: '__Host-album_haven_session', value: 'owned-test-session', domain: '127.0.0.1', path: '/' }] }),
    request: { get: async url => { calls.push(url); return response; } },
  };
}

test('Appearance persistence oracle reads the authenticated production route without exposing CSRF', async () => {
  const { UtilityAppearanceTab } = await load();
  const calls = [];
  const saved = { palette_id: 'paper', revision: 7, device_profiles: { mobile: { sections: {} } }, csrf_token: 'transport-only' };
  const page = pageWith({ ok: () => true, json: async () => saved }, calls);
  assert.deepEqual(await UtilityAppearanceTab.prototype.readSavedPreferences.call({ page }), {
    palette_id: 'paper', revision: 7, device_profiles: { mobile: { sections: {} } },
  });
  assert.deepEqual(calls, ['http://127.0.0.1:4173/account/appearance']);
  assert.equal(saved.csrf_token, 'transport-only', 'reading must not mutate the response snapshot');
});

test('Appearance persistence oracle fails closed on an unsuccessful response', async () => {
  const { UtilityAppearanceTab } = await load();
  const page = pageWith({ ok: () => false, status: () => 401,
    json: async () => { throw new Error('Must not accept a failed read as preferences'); } }, []);
  await assert.rejects(UtilityAppearanceTab.prototype.readSavedPreferences.call({ page }), /Appearance read failed: HTTP 401/);
});
