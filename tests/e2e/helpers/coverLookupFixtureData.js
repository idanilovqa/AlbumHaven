import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifestPath = path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'approvedCoverFixtures.json');
const defaultProviderPort = 4175;

export const COVER_LOOKUP_TEST_TARGETS = Object.freeze({
  canonicalPersistence: Object.freeze({
    artist: 'Synthetic Cover Artist',
    album: 'Canonical Cover Fixture',
    year: '2026',
  }),
  partialSave: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 02',
    year: '2009',
  }),
  notificationActioned: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 03',
    year: '2009',
  }),
  notificationFailed: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 04',
    year: '2009',
  }),
  cancelClear: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 05',
    year: '2009',
  }),
  notificationActive: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 06',
    year: '2009',
  }),
  progressiveCandidates: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 07',
    year: '2009',
  }),
  automaticCandidate: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 08',
    year: '2009',
  }),
  userOwnedImprovement: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 09',
    year: '2009',
  }),
  providerStoragePolicy: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye Fixture 10',
    year: '2009',
  }),
  notificationNoResult: Object.freeze({
    artist: 'Synthetic Cover Artist',
    album: 'Secondary Cover Fixture',
    year: '2026',
  }),
});

function normalizeCoverRecord(rawRecord) {
  return {
    ...rawRecord,
    artist: String(rawRecord?.artist || '').trim(),
    album: String(rawRecord?.album || '').trim(),
    year: Number(rawRecord?.year || 0) || null,
    assetId: String(rawRecord?.assetId || '').trim(),
    sha256: String(rawRecord?.sha256 || '').trim().toUpperCase(),
  };
}

export function loadCoverLookupFixtureManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  return Array.isArray(manifest?.covers) ? manifest.covers.map(normalizeCoverRecord) : [];
}

export function findFixtureCoverBySubtitle(subtitle) {
  const normalizedSubtitle = String(subtitle || '').trim();
  return loadCoverLookupFixtureManifest().find((record) => normalizedSubtitle === [
    record.artist,
    record.album,
    record.year,
  ].filter(Boolean).join(' - ')) || null;
}

export function buildFixtureManualUrls(record, environment = process.env) {
  const fixtureId = String(record?.assetId || '').trim();
  if (!fixtureId) {
    throw new Error('Cover fixture record must include assetId.');
  }

  const configuredPort = Number(environment.PLAYWRIGHT_PROVIDER_PORT || defaultProviderPort);
  const providerPort = Number.isFinite(configuredPort) ? configuredPort : defaultProviderPort;
  const manualBaseUrl = `http://cover-fixture.example:${providerPort}/manual/${encodeURIComponent(fixtureId)}`;
  return [
    manualBaseUrl,
    `${manualBaseUrl}/cover.jpg`,
    `${manualBaseUrl}/other-art.jpg`,
  ];
}
