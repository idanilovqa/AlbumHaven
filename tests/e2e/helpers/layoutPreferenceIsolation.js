import { isDeepStrictEqual as equal } from 'node:util';
import { authenticatedPageGet, authenticatedPagePut } from './authenticatedPageRequest.js';

const ROUTE = '/account/layout-preferences';

export function buildLayoutRestoreChanges(original, owned, current) {
  const changes = {};
  for (const [field, value] of Object.entries(owned)) {
    if (equal(original[field], value)) continue;
    if (!equal(current[field], value)) {
      throw new Error(`Layout preference ${field} changed outside this test; refusing restoration.`);
    }
    changes[field] = original[field];
  }
  return changes;
}

export function createLayoutPreferenceIsolation(page) {
  let original = null, session = null, origin = '', readError = null;
  const owned = new Map();
  const authentication = async () => {
    const { origin, hostname } = new URL(page.url());
    const cookies = await page.context().cookies();
    const matching = cookies.filter(cookie => String(cookie.domain || '').toLowerCase() === hostname.toLowerCase()
      && cookie.path === '/');
    const token = matching.find(cookie => cookie.name === '__Host-album_haven_session')?.value;
    const csrf = matching.find(cookie => cookie.name === '__Host-album_haven_csrf')?.value;
    if (!token || !csrf) throw new Error('Layout isolation requires an authenticated test account and CSRF.');
    return { key: `${origin}\n${token}`, origin, csrf };
  };
  const read = async () => {
    const response = await authenticatedPageGet(page, ROUTE, { timeout: 10000 });
    if (!response.ok()) throw new Error(`Layout capture failed: HTTP ${response.status()}.`);
    const result = await response.json();
    if (!Number.isSafeInteger(result.account_id) || result.account_id <= 0 || !result.profiles || result.load_failed) {
      throw new Error('Layout capture requires loaded account profiles.');
    }
    return result;
  };
  const observe = response => {
    const request = response.request();
    const url = new URL(response.url());
    if (request.method() !== 'PUT' || url.origin !== origin || url.pathname !== ROUTE || !response.ok()) return;
    try {
      const payload = request.postDataJSON();
      if (!original.profiles[payload.profile]) throw new Error('Layout save used an unexpected client profile.');
      // The browser need not consume a keepalive response body. Record the
      // successful submitted patch, then verify it against the canonical GET.
      const saved = owned.get(payload.profile) || {};
      for (const [field, value] of Object.entries(payload.changes)) {
        if (!Object.hasOwn(original.profiles[payload.profile], field)) throw new Error('Layout save used an unknown preference.');
        saved[field] = structuredClone(value);
      }
      owned.set(payload.profile, saved);
    } catch (error) { readError = error; }
  };
  return {
    async capture() {
      if (original) throw new Error('Layout preferences already captured.');
      const auth = await authentication();
      session = auth.key;
      origin = auth.origin;
      original = await read();
      page.on('response', observe);
    },
    async restore() {
      if (!original) return;
      try {
        // parity-check: allow-read-only-measurement-evaluate -- wait for real account preference writes before restoring test-owned state
        await page.waitForFunction(() => window.AlbumHavenDevicePreferences?.syncState === 'saved', null, { timeout: 10000 });
        if (readError) throw readError;
        const auth = await authentication();
        if (auth.key !== session) throw new Error('Layout test account/session changed; refusing restoration.');
        const current = await read();
        if (current.account_id !== original.account_id) throw new Error('Layout account changed; refusing restoration.');
        for (const [profile, saved] of owned) {
          const changes = buildLayoutRestoreChanges(original.profiles[profile], saved, current.profiles[profile]);
          if (!Object.keys(changes).length) continue;
          const response = await authenticatedPagePut(page, ROUTE, { timeout: 10000, data: { profile, changes }, headers: {
            'X-Album-Haven-Account': String(original.account_id),
            'X-Album-Haven-CSRF': auth.csrf, Origin: auth.origin,
          } });
          if (!response.ok()) throw new Error(`Layout restoration failed: HTTP ${response.status()}.`);
          const restored = await response.json();
          if (restored.profile !== profile || Object.keys(changes).some(field => !equal(restored.preferences[field], changes[field]))) {
            throw new Error('Layout restoration returned unexpected preferences.');
          }
        }
      } finally {
        page.off('response', observe);
      }
    },
  };
}

export async function restoreLayoutPreferencesAfterTest(isolation, errors = []) {
  try {
    await isolation.restore();
  } catch (cleanupError) {
    if (!errors.length) throw cleanupError;
    throw new AggregateError([...errors, cleanupError],
      'The test failed and its layout preference restoration also failed.', { cause: cleanupError });
  }
}
