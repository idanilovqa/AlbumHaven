import fs from 'node:fs';
import path from 'node:path';

const EVIDENCE_FILE = 'startup-relation-projection-readiness.json';
const EVIDENCE_VERSION = 1;

function normalizeReadiness(payload) {
  const projection = payload?.relation_projection || payload || {};
  return {
    ready: Boolean(projection.ready),
    startupRebuilt: Boolean(projection.startup_rebuilt ?? projection.startupRebuilt),
    rebuildReason: String(
      projection.rebuild_reason ?? projection.rebuildReason ?? '',
    ).trim(),
    durationMs: Number(projection.duration_ms ?? projection.durationMs ?? 0),
  };
}
function resolveEvidencePath(environment) {
  const tempRootCandidate = String(environment.ALBUM_HAVEN_E2E_TEMP_ROOT || '').trim();
  const controlDirectoryCandidate = String(
    environment.ALBUM_HAVEN_E2E_RESTART_CONTROL_DIR || '',
  ).trim();
  if (!tempRootCandidate || !controlDirectoryCandidate) return '';

  const tempRoot = fs.realpathSync(tempRootCandidate);
  const controlDirectory = fs.realpathSync(controlDirectoryCandidate);
  const relativeControlPath = path.relative(tempRoot, controlDirectory);
  if (
    !relativeControlPath
    || relativeControlPath.startsWith('..')
    || path.isAbsolute(relativeControlPath)
  ) {
    throw new Error('Startup readiness evidence directory must be inside the runner-owned temp root.');
  }
  return path.join(controlDirectory, EVIDENCE_FILE);
}

function readEvidence(evidencePath, expectedOrigin) {
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    throw new Error(`Startup readiness evidence is invalid: ${error?.message || error}`);
  }
  if (evidence?.version !== EVIDENCE_VERSION || evidence?.origin !== expectedOrigin) {
    throw new Error('Startup readiness evidence does not match the current managed app run.');
  }
  return normalizeReadiness(evidence.readiness);
}

function persistFirstEvidence(evidencePath, origin, readiness) {
  const evidence = {
    version: EVIDENCE_VERSION,
    origin,
    readiness,
  };
  try {
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return readiness;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    return readEvidence(evidencePath, origin);
  }
}

export async function readStartupRelationProjectionReadiness(options = {}) {
  const environment = options.environment || process.env;
  const fetchFn = options.fetchFn || fetch;
  const baseURL = String(options.baseURL || '').trim();
  const statusURL = new URL('/status', baseURL);
  const origin = statusURL.origin;
  const evidencePath = resolveEvidencePath(environment);

  if (evidencePath && fs.existsSync(evidencePath)) {
    return readEvidence(evidencePath, origin);
  }

  const response = await fetchFn(statusURL, {
    headers: { accept: 'application/json' },
    method: 'GET',
  });
  if (!response.ok) {
    throw new Error(`Startup status request failed with HTTP ${response.status}.`);
  }
  const readiness = normalizeReadiness(await response.json());
  return evidencePath
    ? persistFirstEvidence(evidencePath, origin, readiness)
    : readiness;
}
