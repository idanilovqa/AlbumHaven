import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { queryPersistedSyntheticSearchInventory } from './postgresAlbumIdentityHelpers.js';

export async function loadSyntheticSearchInventory({
  env = process.env, read = readFile, query = queryPersistedSyntheticSearchInventory,
} = {}) {
  if (env.ALBUM_HAVEN_FIXTURE_PROFILE !== 'synthetic-large-library'
      || !String(env.ALBUM_HAVEN_FIXTURE_ROOT || '').trim()) {
    throw new Error('Synthetic search inventory requires the synthetic-large-library fixture.');
  }
  const manifest = JSON.parse(await read(path.join(env.ALBUM_HAVEN_FIXTURE_ROOT, 'manifest.json'), 'utf8'));
  const profile = manifest?.profiles?.['synthetic-large-library'];
  const assertions = profile?.namedScenarioAssertions;
  if (manifest?.manifestVersion !== 1 || profile?.schemaVersion !== 1) {
    throw new Error('Synthetic search fixture manifest version is invalid.');
  }
  const scenarios = {
    Devin: { primary: 'Devin Townsend', artists: assertions?.devinTownsendFamily?.familyArtists },
    'Neal Morse': { primary: 'Neal Morse', artists: assertions?.nealMorseFamily?.artists },
  };
  for (const scenario of Object.values(scenarios)) {
    if (!Array.isArray(scenario.artists) || !scenario.artists.includes(scenario.primary)
        || scenario.artists.some(artist => typeof artist !== 'string' || !artist.trim())) {
      throw new Error('Synthetic search fixture family assertions are missing or invalid.');
    }
  }
  const artists = [...new Set(Object.values(scenarios).flatMap(scenario => scenario.artists))];
  // This setup read enumerates seeded identities; it never invokes search or browse logic.
  const rows = await query(artists, { env });
  const keysByArtist = new Map(artists.map(artist => [artist, new Set()]));
  const fixtureKeys = new Map();
  if (!Array.isArray(rows)) throw new Error('Synthetic search inventory rows are invalid.');
  for (const row of rows) {
    if (!keysByArtist.has(row?.artist) || typeof row.key !== 'string' || !row.key.trim()
        || typeof row.fixtureKey !== 'string' || !row.fixtureKey.trim()
        || (fixtureKeys.has(row.fixtureKey) && fixtureKeys.get(row.fixtureKey) !== row.key)) {
      throw new Error('Synthetic search seeded identity mapping is invalid.');
    }
    fixtureKeys.set(row.fixtureKey, row.key);
    keysByArtist.get(row.artist).add(row.key);
  }
  if (artists.some(artist => keysByArtist.get(artist).size === 0)) {
    throw new Error('Synthetic search seeded inventory is missing a declared artist.');
  }
  return Object.fromEntries(Object.entries(scenarios).map(([queryText, scenario]) => [
    queryText, [...new Set(scenario.artists.flatMap(artist => [...keysByArtist.get(artist)]))].sort(),
  ]));
}
