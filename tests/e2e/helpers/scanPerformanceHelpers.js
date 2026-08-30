import fs from 'node:fs';
import { expect } from '@playwright/test';

export const SCAN_FIXTURE = Object.freeze({
  artistCount: 100,
  albumCount: 1000,
  tracksPerAlbum: 3,
  addedAlbumName: 'Album 1001',
  addedArtistName: 'Scan Artist 101',
  changedAlbumName: 'Album 001 Metadata Updated',
  cachedLastScanEpoch: 1609459200,
  cachedLastScanYearCandidates: Object.freeze(['2020', '2021']),
});

export function expectBackgroundBrowseContinuity(observation) {
  expect(observation).not.toBeNull();
  expect(observation.scanPageActivated).toBe(false);
  expect(observation.browseButtonVisibleDuringNormalLoading).toBe(false);
  expect(observation.galleryHiddenWithoutNormalLoading).toBe(false);
  for (const loaderState of observation.loaderStates) {
    expect(String(loaderState.title || '')).toBe('Loading selection');
    expect(String(loaderState.status || '')).toBe('Updating the current artist view...');
  }
}

export function expectTerminalScanStatus(status, expectedAlbumCount) {
  expect(String(status.last_error || '')).toBe('');
  expect(Number(status.album_total || 0)).toBe(expectedAlbumCount);
  expect(status.scan_in_progress).toBe(false);
  expect(status.relations_in_progress).toBe(false);
}

export function buildFolderMilestoneText(sampleMetrics, folderCount) {
  const sample = sampleMetrics[`folders${folderCount}Sample`];
  const elapsedMs = Number(sampleMetrics[`folders${folderCount}Ms`] || 0);
  if (!sample || elapsedMs <= 0) {
    return '';
  }
  const foldersPerSecond = (
    Number(sample.scanAlbumFoldersProcessed || 0) / (elapsedMs / 1000)
  ).toFixed(1);
  const etaSeconds = Number(sample.scanEstimatedRemainingSeconds || 0).toFixed(1);
  return `${sample.scanAlbumFoldersProcessed} folders in ${elapsedMs} ms, ${foldersPerSecond} folders/s, ETA ${etaSeconds}s`;
}

function statusSample(payload, recordedAtEpochMs = Date.now()) {
  return {
    recordedAtEpochMs,
    scanInProgress: Boolean(payload.scan_in_progress),
    scanMode: String(payload.scan_mode || 'idle'),
    scanPhase: String(payload.scan_phase || 'idle'),
    scanProcessed: Number(payload.scan_processed || 0),
    scanTotal: Number(payload.scan_total || 0),
    scanElapsedSeconds: Number(payload.scan_elapsed_seconds || 0),
    scanEstimatedRemainingSeconds: Number(payload.scan_estimated_remaining_seconds || 0),
    scanAlbumFoldersProcessed: Number(payload.scan_album_folders_processed || 0),
    scanAlbumFoldersTotal: Number(payload.scan_album_folders_total || 0),
    scanCurrentPath: String(payload.scan_current_path || ''),
    relationsInProgress: Boolean(payload.relations_in_progress),
    coversInProgress: Boolean(payload.covers_in_progress),
    relationsPhase: String(payload.relations_phase || ''),
    relationsProcessed: Number(payload.relations_processed || 0),
    relationsTotal: Number(payload.relations_total || 0),
    albumCount: Number(payload.album_total || 0),
    lastError: String(payload.last_error || ''),
    lastScanDisplay: String(payload.last_scan_display || ''),
  };
}

export function createScanStatusSampler(options = {}) {
  const samplesPath = String(
    options.samplesPath || process.env.ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH || '',
  ).trim();
  if (!samplesPath) {
    throw new Error('ALBUM_HAVEN_SCAN_STATUS_SAMPLES_PATH is required for scan status sampling.');
  }
  const tailRetryCount = Math.max(0, Number(options.tailRetryCount ?? 5));
  const tailRetryDelayMs = Math.max(1, Number(options.tailRetryDelayMs ?? 10));
  return {
    reset() {},
    async start() {},
    async stop() {},
    async snapshot() {
      let source = '';
      for (let attempt = 0; attempt <= tailRetryCount; attempt += 1) {
        source = await fs.promises.readFile(samplesPath, 'utf8');
        if (!source || /\r?\n$/.test(source)) break;
        if (attempt === tailRetryCount) {
          throw new Error(
            `Production status sample file retained an unterminated final record after ${tailRetryCount + 1} reads.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, tailRetryDelayMs));
      }
      const entries = source.split(/\r?\n/).filter(Boolean).map((line, index) => {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid production status sample at line ${index + 1}: ${error.message}`);
        }
        return entry;
      });
      const errorEntry = entries.find((entry) => entry.event === 'error');
      if (errorEntry) {
        throw new Error(`Production status sampler failed: ${String(errorEntry.error || 'unknown error')}`);
      }
      const samples = entries
        .filter((entry) => entry.status && typeof entry.status === 'object')
        .map((entry) => statusSample(entry.status, Number(entry.recordedAtEpochMs || 0)));
      return {
        samples,
        fixtureDefinition: { ...SCAN_FIXTURE },
      };
    },
  };
}

function statusPayloadFromSample(sample) {
  return {
    scan_in_progress: Boolean(sample.scanInProgress),
    scan_mode: String(sample.scanMode || 'idle'),
    scan_phase: String(sample.scanPhase || 'idle'),
    scan_processed: Number(sample.scanProcessed || 0),
    scan_total: Number(sample.scanTotal || 0),
    scan_elapsed_seconds: Number(sample.scanElapsedSeconds || 0),
    scan_estimated_remaining_seconds: Number(sample.scanEstimatedRemainingSeconds || 0),
    scan_album_folders_processed: Number(sample.scanAlbumFoldersProcessed || 0),
    scan_album_folders_total: Number(sample.scanAlbumFoldersTotal || 0),
    scan_current_path: String(sample.scanCurrentPath || ''),
    relations_in_progress: Boolean(sample.relationsInProgress),
    covers_in_progress: Boolean(sample.coversInProgress),
    relations_phase: String(sample.relationsPhase || ''),
    relations_processed: Number(sample.relationsProcessed || 0),
    relations_total: Number(sample.relationsTotal || 0),
    album_total: Number(sample.albumCount || 0),
    last_error: String(sample.lastError || ''),
    last_scan_display: String(sample.lastScanDisplay || ''),
  };
}

async function readCurrentStatus(source) {
  if (typeof source?.snapshot === 'function') {
    const snapshot = await source.snapshot();
    const samples = Array.isArray(snapshot.samples) ? snapshot.samples : [];
    return samples.length ? statusPayloadFromSample(samples[samples.length - 1]) : null;
  }
  const response = await source.get('/status');
  if (!response.ok()) {
    throw new Error(`Status request failed with HTTP ${response.status()}.`);
  }
  return response.json();
}

export async function waitForStatusDiscovery(statusSource, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 60000);
  const pollMs = Number(options.pollMs || 50);
  const startedAt = Date.now();
  let lastSample = null;

  while ((Date.now() - startedAt) <= timeoutMs) {
    const snapshot = await statusSource.snapshot();
    const samples = Array.isArray(snapshot.samples) ? snapshot.samples : [];
    if (samples.length) lastSample = samples[samples.length - 1];
    const discovery = samples.find((sample) => sample.scanPhase === 'discovering');
    if (discovery) return discovery;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for recorded scan discovery. Last sample: ${JSON.stringify(lastSample)}`,
  );
}

export async function waitForStatusIdle(statusSource, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120000);
  const pollMs = Number(options.pollMs || 250);
  const requireScanStart = options.requireScanStart === true;
  const startedAt = Date.now();
  let lastPayload = null;
  let scanStarted = options.scanStartObserved === true;

  while ((Date.now() - startedAt) <= timeoutMs) {
    const payload = await readCurrentStatus(statusSource);
    if (payload) {
      lastPayload = payload;
      scanStarted = scanStarted || Boolean(payload.scan_in_progress);
      const statusIdle = !payload.scan_in_progress && !payload.relations_in_progress && !payload.covers_in_progress;
      if (statusIdle && (!requireScanStart || scanStarted)) {
        return payload;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for scan status to return idle. Last payload: ${JSON.stringify(lastPayload)}`,
  );
}

export async function waitForStatusScanStart(statusSource, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 30000);
  const pollMs = Number(options.pollMs || 50);
  const startedAt = Date.now();
  let lastPayload = null;

  while ((Date.now() - startedAt) <= timeoutMs) {
    const payload = await readCurrentStatus(statusSource);
    if (payload) {
      lastPayload = payload;
      if (payload.scan_in_progress) return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for production scan-start status. Last payload: ${JSON.stringify(lastPayload)}`,
  );
}

export async function waitForStatusCoverScan(statusSource, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120000);
  const pollMs = Number(options.pollMs || 50);
  const startedAt = Date.now();
  let lastPayload = null;

  while ((Date.now() - startedAt) <= timeoutMs) {
    const payload = await readCurrentStatus(statusSource);
    if (payload) {
      lastPayload = payload;
      if (payload.covers_in_progress) return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for production cover-scan status. Last payload: ${JSON.stringify(lastPayload)}`,
  );
}

export function firstMatchingSample(samples, predicate) {
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (predicate(sample)) {
      return sample;
    }
  }
  return null;
}

export function millisecondsFromEpoch(startEpochMs, sample) {
  if (!sample) {
    return 0;
  }
  return Math.max(0, Number(sample.recordedAtEpochMs || 0) - Number(startEpochMs || 0));
}

export function buildScanSampleMetrics(samples, startEpochMs) {
  const scanStart = firstMatchingSample(samples, (sample) => sample.scanInProgress);
  const discovery = firstMatchingSample(samples, (sample) => sample.scanPhase === 'discovering');
  const indexing = firstMatchingSample(samples, (sample) => sample.scanPhase === 'indexing' && Number(sample.scanProcessed || 0) > 0);
  const timerStarted = firstMatchingSample(samples, (sample) => Number(sample.scanElapsedSeconds || 0) > 0);
  const folders100 = firstMatchingSample(samples, (sample) => Number(sample.scanAlbumFoldersProcessed || 0) >= 100);
  const folders300 = firstMatchingSample(samples, (sample) => Number(sample.scanAlbumFoldersProcessed || 0) >= 300);
  const folders500 = firstMatchingSample(samples, (sample) => Number(sample.scanAlbumFoldersProcessed || 0) >= 500);
  const scanCompleted = firstMatchingSample(samples, (sample) => !sample.scanInProgress && Number(sample.scanAlbumFoldersProcessed || 0) >= 500);
  const relationsStarted = firstMatchingSample(samples, (sample) => sample.relationsInProgress);
  const relationsCompleted = firstMatchingSample(
    samples,
    (sample) => !sample.scanInProgress && !sample.relationsInProgress && Number(sample.albumCount || 0) > 0,
  );

  return {
    scanStartMs: millisecondsFromEpoch(startEpochMs, scanStart),
    scanStartSample: scanStart,
    discoveryVisibleMs: millisecondsFromEpoch(startEpochMs, discovery),
    discoverySample: discovery,
    indexingVisibleMs: millisecondsFromEpoch(startEpochMs, indexing),
    indexingSample: indexing,
    elapsedTimerStartedMs: millisecondsFromEpoch(startEpochMs, timerStarted),
    elapsedTimerSample: timerStarted,
    folders100Ms: millisecondsFromEpoch(startEpochMs, folders100),
    folders300Ms: millisecondsFromEpoch(startEpochMs, folders300),
    folders500Ms: millisecondsFromEpoch(startEpochMs, folders500),
    scanCompletedMs: millisecondsFromEpoch(startEpochMs, scanCompleted),
    relationsStartedMs: millisecondsFromEpoch(startEpochMs, relationsStarted),
    relationsCompletedMs: millisecondsFromEpoch(startEpochMs, relationsCompleted),
    folders100Sample: folders100,
    folders300Sample: folders300,
    folders500Sample: folders500,
    completionSample: relationsCompleted || scanCompleted,
  };
}

export function calculateFoldersPerSecond(sample, metricKey) {
  const folderCount = Number(sample?.scanAlbumFoldersProcessed || 0);
  const elapsedMs = Number(metricKey || 0);
  if (folderCount <= 0 || elapsedMs <= 0) {
    return 0;
  }
  return folderCount / (elapsedMs / 1000);
}
