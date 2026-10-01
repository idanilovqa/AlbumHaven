import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifestPath = path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'approvedCoverFixtures.json');
const defaultProviderPort = 4175;

export const COVER_LOOKUP_TEST_TARGETS = Object.freeze({
  manualProviderCover: Object.freeze({
    artist: 'Synthetic Cover Artist',
    album: 'Canonical Cover Fixture',
    year: '2026',
  }),
  canonicalPersistence: Object.freeze({
    artist: 'Mastodon',
    album: 'Crack The Skye',
    year: '2009',
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
    artist: 'Flaming Row',
    album: 'The Pure Shine',
    year: '2019',
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

export function resolveProviderFixtureCover(approved, environment = process.env) {
  if (!environment.ALBUM_HAVEN_FIXTURE_PROFILE && !environment.ALBUM_HAVEN_FIXTURE_ROOT) return approved;
  const mediaRoot = resolveWritableFixtureMediaRoot(environment);
  const fixtureRoot = fs.realpathSync(environment.ALBUM_HAVEN_FIXTURE_ROOT);
  if (path.dirname(mediaRoot) !== fixtureRoot) throw new Error('Released provider media must remain inside its fixture root.');
  const expectedHash = String(approved?.sha256 || '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(expectedHash)) throw new Error('Approved artwork requires its exact SHA-256.');
  const containedPath = (value) => {
    if (typeof value !== 'string' || !value || path.win32.isAbsolute(value)
      || path.posix.isAbsolute(value) || value.replaceAll('\\', '/').split('/').includes('..')) {
      throw new Error('Released provider contract contains an unsafe artwork path.');
    }
    const resolved = fs.realpathSync(path.resolve(fixtureRoot, value));
    const relative = path.relative(fixtureRoot, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || !fs.statSync(resolved).isFile()) {
      throw new Error('Released provider contract contains an unsafe artwork path.');
    }
    return resolved;
  };
  const contract = JSON.parse(fs.readFileSync(containedPath('loopback/cover-responses.json'), 'utf8'));
  if (contract?.schemaVersion !== 1 || !Array.isArray(contract.covers)) {
    throw new Error('Released provider contract must use schema version 1.');
  }
  const matches = contract.covers.map((spec) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)
      || !['cover_id', 'artist', 'album'].every((key) => typeof spec[key] === 'string' && spec[key].trim())
      || !Number.isInteger(spec.year) || !Number.isInteger(spec.width) || spec.width <= 0
      || !Number.isInteger(spec.height) || spec.height <= 0) {
      throw new Error('Released provider contract contains an invalid artwork descriptor.');
    }
    const sha256 = createHash('sha256').update(fs.readFileSync(containedPath(spec.staged_path)))
      .digest('hex').toUpperCase();
    return normalizeCoverRecord({ ...spec, assetId: spec.cover_id, sha256 });
  }).filter((spec) => spec.sha256 === expectedHash);
  if (matches.length !== 1) throw new Error('Approved artwork must match exactly one released provider asset.');
  return matches[0];
}

export function findFixtureCoverBySubtitle(subtitle, environment = process.env) {
  const normalizedSubtitle = String(subtitle || '').trim();
  const approved = loadCoverLookupFixtureManifest().find((record) => normalizedSubtitle === [
    record.artist,
    record.album,
    record.year,
  ].filter(Boolean).join(' - ')) || null;
  return approved ? resolveProviderFixtureCover(approved, environment) : null;
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
