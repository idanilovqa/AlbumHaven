import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildScanSampleMetrics,
  buildFolderMilestoneText,
  createScanStatusSampler,
  expectTerminalScanStatus,
  waitForStatusCoverScan,
  waitForStatusDiscovery,
  waitForStatusIdle,
  waitForStatusScanStart,
} from '../e2e/helpers/scanPerformanceHelpers.js';
import { waitForScanDrivenGalleryReady } from '../e2e/helpers/scanScenarioHelpers.js';

test('folder milestone text formats measured throughput and rejects incomplete samples', () => {
  assert.equal(buildFolderMilestoneText({
    folders100Ms: 2000,
    folders100Sample: {
      scanAlbumFoldersProcessed: 100,
      scanEstimatedRemainingSeconds: 18.25,
    },
  }, 100), '100 folders in 2000 ms, 50.0 folders/s, ETA 18.3s');
  assert.equal(buildFolderMilestoneText({ folders100Ms: 0 }, 100), '');
});

test('terminal scan status assertion enforces exact idle counts and an empty error', () => {
  assert.doesNotThrow(() => expectTerminalScanStatus({
    last_error: '',
    album_total: 1000,
    scan_in_progress: false,
    relations_in_progress: false,
  }, 1000));
  assert.throws(() => expectTerminalScanStatus({
    last_error: '',
    album_total: 999,
    scan_in_progress: false,
    relations_in_progress: false,
  }, 1000));
});

test('scan sample metrics retain pre-epoch phase evidence while clamping time to zero', () => {
  const metrics = buildScanSampleMetrics([
    {
      recordedAtEpochMs: 900,
      scanInProgress: true,
      scanPhase: 'discovering',
      scanProcessed: 0,
      scanElapsedSeconds: 0,
    },
    {
      recordedAtEpochMs: 1000,
      scanInProgress: true,
      scanPhase: 'indexing',
      scanProcessed: 1,
      scanElapsedSeconds: 1,
    },
  ], 1000);

  assert.notEqual(metrics.scanStartSample, null);
  assert.notEqual(metrics.discoverySample, null);
  assert.notEqual(metrics.indexingSample, null);
  assert.notEqual(metrics.elapsedTimerSample, null);
  assert.equal(metrics.scanStartMs, 0);
  assert.equal(metrics.discoveryVisibleMs, 0);
  assert.equal(metrics.indexingVisibleMs, 0);
  assert.equal(metrics.elapsedTimerStartedMs, 0);
});

test('scan status sampler reads launch-time production status JSONL without fabricated telemetry', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-status-helper-'));
  const samplesPath = path.join(tempRoot, 'status.jsonl');
  fs.writeFileSync(samplesPath, [
    JSON.stringify({
      recordedAtEpochMs: 1000,
      status: {
        scan_in_progress: true,
        scan_mode: 'background',
        scan_phase: 'discovering',
        covers_in_progress: true,
        relations_in_progress: false,
        album_total: 1,
        last_scan_display: 'Never',
      },
    }),
    JSON.stringify({
      recordedAtEpochMs: 1050,
      status: {
        scan_in_progress: false,
        scan_mode: 'idle',
        scan_phase: 'finalizing',
        covers_in_progress: false,
        relations_in_progress: false,
        album_total: 1000,
        last_scan_display: '2020-12-31 17:00:00',
      },
    }),
    '',
  ].join('\n'), 'utf8');

  try {
    const snapshot = await createScanStatusSampler({ samplesPath }).snapshot();
    assert.equal(snapshot.samples.length, 2);
    assert.equal(snapshot.samples[0].recordedAtEpochMs, 1000);
    assert.equal(snapshot.samples[0].scanPhase, 'discovering');
    assert.equal(snapshot.samples[0].coversInProgress, true);
    assert.equal(snapshot.samples[1].scanPhase, 'finalizing');
    assert.equal(snapshot.samples[1].albumCount, 1000);
    assert.equal(snapshot.fixtureDefinition.cachedLastScanEpoch, 1609459200);
    assert.equal(snapshot.fixtureDefinition.addedArtistName, 'Scan Artist 101');
    assert.equal('persistence' in snapshot, false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('scan status sampler rejects malformed launch samples with the exact line', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-status-helper-'));
  const samplesPath = path.join(tempRoot, 'status.jsonl');
  fs.writeFileSync(samplesPath, '{"recordedAtEpochMs":1,"status":{}}\nnot-json\n', 'utf8');
  try {
    await assert.rejects(
      createScanStatusSampler({ samplesPath }).snapshot(),
      /Invalid production status sample at line 2/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('scan status sampler retries a partial tail and parses the completed error event', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-status-helper-'));
  const samplesPath = path.join(tempRoot, 'status.jsonl');
  fs.writeFileSync(
    samplesPath,
    '{"recordedAtEpochMs":1,"status":{"scan_phase":"discovering"}}\n'
      + '{"recordedAtEpochMs":2,"event":"error","error":"poll',
    'utf8',
  );
  try {
    setTimeout(() => {
      fs.appendFileSync(samplesPath, ' failed"}\n', 'utf8');
    }, 5);
    await assert.rejects(
      createScanStatusSampler({ samplesPath, tailRetryDelayMs: 10 }).snapshot(),
      /Production status sampler failed: poll failed/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('scan status sampler fails loudly when a partial tail remains after bounded retries', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-status-helper-'));
  const samplesPath = path.join(tempRoot, 'status.jsonl');
  fs.writeFileSync(
    samplesPath,
    '{"recordedAtEpochMs":1,"status":{"scan_phase":"discovering"}}\n{"recordedAtEpochMs":2',
    'utf8',
  );
  try {
    await assert.rejects(
      createScanStatusSampler({ samplesPath, tailRetryCount: 2, tailRetryDelayMs: 1 }).snapshot(),
      /retained an unterminated final record after 3 reads/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function sequentialSampler(statuses) {
  const history = [];
  let index = 0;
  return {
    async snapshot() {
      history.push(statuses[Math.min(index, statuses.length - 1)]);
      index += 1;
      return { samples: [...history] };
    },
  };
}

test('scan status waiters consume only the newest production sample', async () => {
  const idle = {
    scanInProgress: false,
    scanMode: 'idle',
    scanPhase: 'idle',
    relationsInProgress: false,
    coversInProgress: false,
    albumCount: 999,
    lastError: '',
  };
  const active = {
    ...idle,
    scanInProgress: true,
    scanMode: 'background',
    scanPhase: 'indexing',
    albumCount: 1000,
  };
  const cover = {
    ...active,
    scanInProgress: false,
    coversInProgress: true,
  };
  const terminal = {
    ...idle,
    albumCount: 1001,
  };

  const started = await waitForStatusScanStart(
    sequentialSampler([idle, active]),
    { timeoutMs: 100, pollMs: 1 },
  );
  const coverStarted = await waitForStatusCoverScan(
    sequentialSampler([active, cover]),
    { timeoutMs: 100, pollMs: 1 },
  );
  const completed = await waitForStatusIdle(
    sequentialSampler([active, cover, terminal]),
    { timeoutMs: 100, pollMs: 1, requireScanStart: true },
  );

  assert.equal(started.scan_in_progress, true);
  assert.equal(started.scan_mode, 'background');
  assert.equal(coverStarted.covers_in_progress, true);
  assert.equal(completed.scan_in_progress, false);
  assert.equal(completed.album_total, 1001);
});

test('scan start waiter ignores an older completed scan retained in sampler history', async () => {
  const oldActive = {
    scanInProgress: true,
    scanMode: 'background',
    scanPhase: 'indexing',
    albumCount: 1000,
  };
  const oldIdle = {
    ...oldActive,
    scanInProgress: false,
    scanMode: 'idle',
    scanPhase: 'idle',
  };
  const newActive = {
    ...oldActive,
    albumCount: 1001,
  };
  let readCount = 0;
  const sampler = {
    async snapshot() {
      readCount += 1;
      return {
        samples: readCount === 1
          ? [oldActive, oldIdle]
          : [oldActive, oldIdle, newActive],
      };
    },
  };

  const started = await waitForStatusScanStart(sampler, { timeoutMs: 100, pollMs: 1 });

  assert.equal(started.album_total, 1001);
  assert.equal(readCount, 2);
});

test('discovery waiter accepts a recorded phase after the live status has advanced', async () => {
  const discovery = {
    recordedAtEpochMs: 1100,
    scanInProgress: true,
    scanPhase: 'discovering',
  };
  const indexing = {
    recordedAtEpochMs: 1200,
    scanInProgress: true,
    scanPhase: 'indexing',
  };
  const sampler = {
    async snapshot() {
      return { samples: [discovery, indexing] };
    },
  };

  assert.equal(
    await waitForStatusDiscovery(sampler, { timeoutMs: 100, pollMs: 1 }),
    discovery,
  );
});

test('scan gallery readiness waits for the requested visible cover population', async () => {
  const calls = [];
  const galleryActions = {
    galleryPage: {
      albumCards: {
        first() {
          return { async waitFor(options) { calls.push(['card', options]); } };
        },
      },
    },
    async waitForVisibleGalleryCoversLoaded(options) {
      calls.push(['covers', options]);
    },
  };
  const navigationPanelActions = {
    navigationPanel: {
      allArtistsLink: {
        async waitFor(options) { calls.push(['sidebar', options]); },
      },
    },
  };

  await waitForScanDrivenGalleryReady({
    galleryActions,
    navigationPanelActions,
    minimumVisibleCoverCount: 8,
  });

  assert.deepEqual(calls, [
    ['sidebar', { state: 'visible', timeout: 60000 }],
    ['card', { state: 'visible', timeout: 60000 }],
    ['covers', { minimumCount: 8, timeout: 60000 }],
  ]);
});
