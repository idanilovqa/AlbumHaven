import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REQUEST_FILE = 'restart-request.json';
const ACK_FILE = 'restart-ack.json';
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 120_000;
const FAKE_E2E_DATABASE_NAME = 'album_haven_fake_e2e';
const CI_DATABASE_PATTERN = /^album_haven_ci_([a-z0-9]+(?:_[a-z0-9]+)*)$/;

function requireExistingDirectory(candidate, label) {
  const configuredPath = String(candidate || '').trim();
  if (!configuredPath || !fs.existsSync(configuredPath)) {
    throw new Error(`Managed app ${label} must exist.`);
  }
  if (!fs.statSync(configuredPath).isDirectory()) {
    throw new Error(`Managed app ${label} must be a directory.`);
  }
  return fs.realpathSync(configuredPath);
}

function assertNestedControlDirectory(tempRoot, controlDirectory) {
  const relativePath = path.relative(tempRoot, controlDirectory);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Managed app control directory must be inside the runner-owned temp root.');
  }
}

function isolatedDatabaseIdentityError(options) {
  if (options.requireCiIdentity === true) {
    const context = String(options.context || 'This operation').trim() || 'This operation';
    return new Error(
      `${context} requires an exact album_haven_ci_<suffix>/album_haven_app_<suffix> `
      + 'identity on loopback.',
    );
  }
  return new Error(
    `Managed app restart requires ${FAKE_E2E_DATABASE_NAME} or an exact `
    + 'album_haven_ci_<suffix>/album_haven_app_<suffix> identity on loopback.',
  );
}

export function assertIsolatedE2EDatabase(databaseUrl, options = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(databaseUrl || '').trim());
  } catch {
    if (options.requireCiIdentity === true) throw isolatedDatabaseIdentityError(options);
    throw new Error(`Managed app restart requires the ${FAKE_E2E_DATABASE_NAME} database.`);
  }
  const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\/+/, ''));
  const roleName = decodeURIComponent(parsedUrl.username);
  const ciDatabaseMatch = CI_DATABASE_PATTERN.exec(databaseName);
  const legacyIdentity = databaseName === FAKE_E2E_DATABASE_NAME
    && roleName === 'album_haven_app';
  const ciIdentity = ciDatabaseMatch !== null
    && roleName === `album_haven_app_${ciDatabaseMatch[1]}`;
  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)
    || (!legacyIdentity && !ciIdentity)
    || (options.requireCiIdentity === true && !ciIdentity)) {
    throw isolatedDatabaseIdentityError(options);
  }
}

function removeFileIfPresent(targetPath) {
  try {
    fs.unlinkSync(targetPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function writeJsonAtomically(targetPath, value) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  fs.writeFileSync(temporaryPath, JSON.stringify(value), 'utf8');
  try {
    removeFileIfPresent(targetPath);
    fs.renameSync(temporaryPath, targetPath);
  } finally {
    removeFileIfPresent(temporaryPath);
  }
}

function readAcknowledgment(ackPath) {
  if (!fs.existsSync(ackPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(ackPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Managed app restart acknowledgment is invalid: ${error?.message || error}`);
  }
}

function normalizePositiveNumber(value, fallback, label) {
  const result = Number(value ?? fallback);
  if (!Number.isFinite(result) || result <= 0) {
    throw new Error(`Managed app restart ${label} must be a positive number.`);
  }
  return result;
}

export function createManagedAppLifecycle(options = {}) {
  const environment = options.environment || process.env;
  if (String(environment.PLAYWRIGHT_MANAGED_APP || '').trim() !== '1') {
    throw new Error('Managed app lifecycle requires PLAYWRIGHT_MANAGED_APP=1.');
  }

  const tempRoot = requireExistingDirectory(
    environment.ALBUM_HAVEN_E2E_TEMP_ROOT,
    'temp root',
  );
  const controlDirectory = requireExistingDirectory(
    environment.ALBUM_HAVEN_E2E_RESTART_CONTROL_DIR,
    'restart control directory',
  );
  assertNestedControlDirectory(tempRoot, controlDirectory);
  assertIsolatedE2EDatabase(environment.ALBUM_HAVEN_FAKE_E2E_DATABASE_URL);

  const createNonce = options.createNonce || randomUUID;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((milliseconds) => new Promise(
    (resolve) => setTimeout(resolve, milliseconds),
  ));
  const pollIntervalMs = normalizePositiveNumber(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    'poll interval',
  );
  const timeoutMs = normalizePositiveNumber(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    'timeout',
  );
  const requestPath = path.join(controlDirectory, REQUEST_FILE);
  const ackPath = path.join(controlDirectory, ACK_FILE);
  let activeRestart = null;

  async function performRestart() {
    const nonce = String(createNonce() || '').trim();
    if (!nonce || nonce.length > 256) {
      throw new Error('Managed app restart requires a valid nonce.');
    }

    removeFileIfPresent(ackPath);
    writeJsonAtomically(requestPath, { nonce });
    const deadline = now() + timeoutMs;

    while (now() <= deadline) {
      const acknowledgment = readAcknowledgment(ackPath);
      if (String(acknowledgment?.nonce || '') === nonce) {
        if (acknowledgment?.status === 'ready') {
          return acknowledgment;
        }
        if (acknowledgment?.status === 'failed') {
          const phase = String(acknowledgment.phase || 'unknown').replace(/\s+/g, ' ').trim();
          const error = String(acknowledgment.error || 'no error detail')
            .replace(/\s+/g, ' ')
            .trim();
          throw new Error(`Managed app restart ${nonce} failed during ${phase}: ${error}`);
        }
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }

    throw new Error(`Timed out waiting for managed app restart ${nonce}.`);
  }

  return {
    restart() {
      if (!activeRestart) {
        activeRestart = performRestart().finally(() => {
          activeRestart = null;
        });
      }
      return activeRestart;
    },
  };
}
