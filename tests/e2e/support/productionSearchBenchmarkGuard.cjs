const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const PRODUCTION_SEARCH_BENCHMARK_APPROVAL = 'I_ACKNOWLEDGE_READ_ONLY_PRODUCTION_SEARCH_BENCHMARK';
const PRODUCTION_SEARCH_BENCHMARK_URL = 'https://sandbox1.albumhaven.org';
const APPROVAL_ENV = 'ALBUM_HAVEN_PRODUCTION_SEARCH_BENCHMARK_APPROVAL';
const URL_ENV = 'PLAYWRIGHT_REAL_APP_URL';
const STORAGE_STATE_ENV = 'ALBUM_HAVEN_PRODUCTION_SEARCH_STORAGE_STATE';
const DATABASE_ATTESTATION_ENV = 'ALBUM_HAVEN_PRODUCTION_SEARCH_DATABASE_ATTESTATION';
const DATABASE_ATTESTATION_MAX_AGE_MS = 15 * 60 * 1000;
const MIGRATION_FILENAME = '0084_create_local_artist_search_projection.sql';
const MIGRATION_PATH = path.resolve(__dirname, '..', '..', '..', 'migrations', 'postgres', MIGRATION_FILENAME);

function readProductionSearchDatabaseAttestation(options = {}) {
  const env = options.env || process.env;
  const attestationPath = String(env[DATABASE_ATTESTATION_ENV] || '').trim();
  if (!attestationPath) {
    throw new Error(`${DATABASE_ATTESTATION_ENV} must name a fresh database attestation.`);
  }
  let attestation;
  try {
    attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf8'));
  } catch {
    throw new Error('The production search database attestation is unavailable or invalid.');
  }
  const issuedAtMs = Date.parse(String(attestation?.issuedAt || ''));
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const ageMs = nowMs - issuedAtMs;
  if (
    attestation?.schemaVersion !== 2
    || attestation?.benchmarkOrigin !== PRODUCTION_SEARCH_BENCHMARK_URL
    || !Number.isFinite(issuedAtMs)
    || ageMs < -60000
    || ageMs > DATABASE_ATTESTATION_MAX_AGE_MS
  ) {
    throw new Error('A fresh database attestation for sandbox1 is required.');
  }
  const databaseIdentityProof = {
    scheme: String(attestation?.databaseIdentityProof?.scheme || ''),
    keyVersion: Number(attestation?.databaseIdentityProof?.keyVersion),
    proof: String(attestation?.databaseIdentityProof?.proof || ''),
  };
  if (
    databaseIdentityProof.scheme !== 'hmac-sha256-v1'
    || !Number.isSafeInteger(databaseIdentityProof.keyVersion)
    || databaseIdentityProof.keyVersion < 1
    || !/^[a-f0-9]{64}$/u.test(databaseIdentityProof.proof)
  ) {
    throw new Error('The production search database identity attestation is invalid.');
  }
  const expectedMigrationSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(MIGRATION_PATH))
    .digest('hex');
  if (
    attestation?.migration?.filename !== MIGRATION_FILENAME
    || attestation?.migration?.sha256 !== expectedMigrationSha256
  ) {
    throw new Error('The production database 0084 migration checksum does not match this worktree.');
  }
  return { databaseIdentityProof };
}

function isInventoryDiscovery(argv = process.argv) {
  return argv.includes('--list');
}

function assertProductionSearchBenchmarkInvocation(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  if (isInventoryDiscovery(argv)) return;
  if (String(env.CI || '').trim()) {
    throw new Error('The production search benchmark is owner-invoked and cannot run in CI.');
  }
  if (env[APPROVAL_ENV] !== PRODUCTION_SEARCH_BENCHMARK_APPROVAL) {
    throw new Error(`${APPROVAL_ENV} must contain the exact owner approval token.`);
  }
  if (env[URL_ENV] !== PRODUCTION_SEARCH_BENCHMARK_URL) {
    throw new Error(`${URL_ENV} must be exactly ${PRODUCTION_SEARCH_BENCHMARK_URL}.`);
  }
  const storageStatePath = String(env[STORAGE_STATE_ENV] || '').trim();
  if (!storageStatePath) {
    throw new Error(`${STORAGE_STATE_ENV} must name a manually saved authentication state.`);
  }
  try {
    if (!fs.statSync(storageStatePath).isFile()) throw new Error('not a file');
  } catch {
    throw new Error('The manually saved production search authentication state is unavailable.');
  }
  readProductionSearchDatabaseAttestation({ env });
}

module.exports = {
  APPROVAL_ENV,
  DATABASE_ATTESTATION_ENV,
  PRODUCTION_SEARCH_BENCHMARK_APPROVAL,
  PRODUCTION_SEARCH_BENCHMARK_URL,
  STORAGE_STATE_ENV,
  URL_ENV,
  assertProductionSearchBenchmarkInvocation,
  isInventoryDiscovery,
  readProductionSearchDatabaseAttestation,
};
