import fs from 'node:fs';

export const PRODUCTION_SEARCH_STORAGE_STATE_ENV = 'ALBUM_HAVEN_PRODUCTION_SEARCH_STORAGE_STATE';
const EXPECTED_HOST = 'sandbox1.albumhaven.org';
const EXPECTED_ORIGIN = 'https://sandbox1.albumhaven.org';

export function readProductionSearchStorageState(env = process.env) {
  const storageStatePath = String(env[PRODUCTION_SEARCH_STORAGE_STATE_ENV] || '').trim();
  if (!storageStatePath) {
    throw new Error(`${PRODUCTION_SEARCH_STORAGE_STATE_ENV} is required for the production search benchmark.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(storageStatePath, 'utf8'));
  } catch {
    throw new Error('Unable to read the manually saved production search authentication state.');
  }
  const cookies = (Array.isArray(parsed?.cookies) ? parsed.cookies : [])
    .filter((cookie) => String(cookie?.domain || '').replace(/^\./u, '') === EXPECTED_HOST);
  const origins = (Array.isArray(parsed?.origins) ? parsed.origins : [])
    .filter((entry) => entry?.origin === EXPECTED_ORIGIN);
  if (cookies.length === 0) {
    throw new Error('The saved authentication state has no sandbox1 session cookie.');
  }
  return { cookies, origins };
}
