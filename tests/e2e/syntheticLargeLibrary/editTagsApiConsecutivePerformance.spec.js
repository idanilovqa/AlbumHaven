import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { expect, test } from '../support/performanceFixtures.js';
import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';
import {
  REMIXES_ALBUM,
  REMIXES_FILENAMES,
  REMIXES_SPLIT_ALBUM,
  REMIXES_SPLIT_FILENAMES,
  albumUpdatesFor,
  expectRemixesPhysicalState,
  findDdtAlbums,
  postEditTags,
  readAlbumDetails,
  readDdtAlbumPayload,
  restoreRemixesMedia,
  restoreRemixesThroughApp,
  snapshotRemixesMedia,
  trackFilename,
} from '../helpers/ddtRemixesFixture.js';
import {
  expectTimingBudget,
  performanceTimingBudget,
} from '../helpers/index.js';
import {
  requirePostgresRuntimeEnv,
  waitForPostgresBrowseWarmRoot,
} from '../helpers/realAppBenchmarkHelpers.js';
import { expectComparableTimings } from '../helpers/timingComparability.js';

const CASE_ID = 'FTC-TAGS-032P';
const TITLE_TRACK = REMIXES_FILENAMES.at(-1);
const EDITED_TITLE_SUFFIX = ' (timing edit)';
const CONCURRENT_PROBE_DELAY_MS = 100;
const SAVE_TASK_POLL_MS = 100;
const BUDGET_KEYS = Object.freeze([
  'acceptedMs',
  'completedMs',
  'browseConsistentMs',
  'statusProbeMs',
  'concurrentStatusProbeMs',
]);
const BUDGETS = Object.freeze(Object.fromEntries(BUDGET_KEYS.map((key) => [
  key,
  Object.freeze(performanceTimingBudget(`edit-tags-api-consecutive.${key}`)),
])));

test.describe(`${CASE_ID} synthetic-large consecutive Edit Tags API saves`, () => {
  test('consecutive saves complete within budget and the server stays responsive', async ({
    editTagsApiConsecutiveLocalReport,
    galleryActions,
    managedAppLifecycle,
    navigationPanelActions,
    page,
    stepLogger,
  }) => {
    test.setTimeout(15 * 60 * 1000);
    requirePostgresRuntimeEnv('the consecutive Edit Tags API benchmark');

    const edits = [];
    const responses = [];
    const samples = Object.fromEntries(BUDGET_KEYS.map((key) => [key, []]));
    const record = (key, timingMs) => {
      samples[key].push(timingMs);
      expectTimingBudget(expect.soft, timingMs, BUDGETS[key], `${key} sample ${samples[key].length}`);
      return timingMs;
    };
    const observe = (label, response) => {
      responses.push({ label, status: response.status() });
      return response;
    };
    const probeStatus = async (key, label) => {
      const startedAt = performance.now();
      const response = observe(label, await authenticatedPageGet(page, '/status', { timeout: 30000 }));
      const durationMs = performance.now() - startedAt;
      expect(response.ok(), `${label} returned HTTP ${response.status()}`).toBe(true);
      return record(key, durationMs);
    };
    const mediaSnapshot = await snapshotRemixesMedia();
    let originalTitle = '';

    // Polls the browse projection until the edit is visible to a reader: the album
    // payloads the gallery and Edit Tags read must show the expected topology and title.
    const waitForProjection = async ({ splitFilenames, title }) => {
      const tracksOf = async (albumName) => {
        const albums = await findDdtAlbums(page, albumName, { observe });
        if (albums.length !== 1) return albums.length;
        const album = await readAlbumDetails(page, albums[0], { observe });
        return album.tracks.map((track) => ({ filename: trackFilename(track), title: String(track.title || '') }));
      };
      const expectedTrack = (filename) => ({
        filename,
        title: filename === TITLE_TRACK ? title : expect.any(String),
      });
      await expect.poll(async () => ({
        source: await tracksOf(REMIXES_ALBUM),
        split: await tracksOf(REMIXES_SPLIT_ALBUM),
      }), { timeout: 60000, intervals: [100, 250, 500] }).toEqual({
        source: REMIXES_FILENAMES.filter((filename) => !splitFilenames.includes(filename)).map(expectedTrack),
        split: splitFilenames.length ? splitFilenames.map(expectedTrack) : 0,
      });
    };

    const runEdit = async ({ kind, label, albumName, filenames, fields, splitFilenames, title }) => {
      const album = await readDdtAlbumPayload(page, albumName, { observe });
      expect(album, `${label}: «${albumName}» must be a single album before the edit`).toBeTruthy();
      const updates = albumUpdatesFor(album, filenames, fields);
      const startedAt = performance.now();
      const postPromise = postEditTags(page, album, updates);
      const concurrentProbe = delay(CONCURRENT_PROBE_DELAY_MS)
        .then(() => probeStatus('concurrentStatusProbeMs', `${label} concurrent /status`));
      concurrentProbe.catch(() => {}); // Awaited below; never an unhandled rejection if the POST fails first.
      const response = observe(`${label} POST`, await postPromise);
      const acceptedMs = record('acceptedMs', performance.now() - startedAt);
      const body = await response.text();
      expect(response.status(), `${label} returned ${body.slice(0, 2000)}`).toBe(200);
      const payload = JSON.parse(body);
      expect(payload.ok, `${label} payload ${body.slice(0, 2000)}`).toBe(true);
      const saveTaskId = String(payload.save_task_id || '').trim();
      expect(saveTaskId, `${label} must return a save task`).not.toBe('');
      let taskStatus = String(payload.save_task_status || '');
      let taskPayload = null;
      while (taskStatus !== 'completed' && taskStatus !== 'failed') {
        expect(performance.now() - startedAt, `${label} save task stayed ${taskStatus}`).toBeLessThan(120000);
        await delay(SAVE_TASK_POLL_MS);
        const taskResponse = observe(
          `${label} save-task`,
          await authenticatedPageGet(page, `/utilities/save-task/${encodeURIComponent(saveTaskId)}`),
        );
        expect(taskResponse.ok(), `${label} save-task HTTP ${taskResponse.status()}`).toBe(true);
        taskPayload = await taskResponse.json();
        taskStatus = String(taskPayload.status || '');
      }
      const completedMs = record('completedMs', performance.now() - startedAt);
      expect(taskStatus, `${label} save task ${JSON.stringify(taskPayload)}`).toBe('completed');
      const concurrentStatusProbeMs = await concurrentProbe;
      await waitForProjection({ splitFilenames, title });
      const browseConsistentMs = record('browseConsistentMs', performance.now() - startedAt);
      await expectRemixesPhysicalState(expect, { splitFilenames, titles: { [TITLE_TRACK]: title } });
      const statusProbeMs = await probeStatus('statusProbeMs', `${label} /status after`);
      const entry = {
        label,
        kind,
        acceptedMs,
        completedMs,
        browseConsistentMs,
        concurrentStatusProbeMs,
        // The probe starts 100 ms after the POST; it only measured a busy server if the save was still running.
        concurrentProbeOverlappedSave: acceptedMs > CONCURRENT_PROBE_DELAY_MS,
        statusProbeMs,
        saveTaskId,
        phaseTimingsMs: payload.phase_timings_ms || null,
      };
      edits.push(entry);
      await editTagsApiConsecutiveLocalReport.recordTimingCheckpoint({
        key: `edit-${edits.length}`,
        label: `Edit ${edits.length} (${label}): POST to completed save`,
        timingMs: completedMs,
        details: entry,
      });
    };

    const split = (cycle, title) => runEdit({
      kind: 'split',
      label: `split ${cycle}`,
      albumName: REMIXES_ALBUM,
      filenames: REMIXES_SPLIT_FILENAMES,
      fields: { album: REMIXES_SPLIT_ALBUM },
      splitFilenames: REMIXES_SPLIT_FILENAMES,
      title,
    });
    const merge = (cycle, title) => runEdit({
      kind: 'merge',
      label: `merge ${cycle}`,
      albumName: REMIXES_SPLIT_ALBUM,
      filenames: REMIXES_SPLIT_FILENAMES,
      fields: { album: REMIXES_ALBUM },
      splitFilenames: [],
      title,
    });
    const retitle = (label, title) => runEdit({
      kind: 'title',
      label,
      albumName: REMIXES_ALBUM,
      filenames: [TITLE_TRACK],
      fields: { title },
      splitFilenames: [],
      title,
    });

    try {
      await stepLogger.step('Open the app and read the released album through the API', async () => {
        await galleryActions.goto('/');
        await waitForPostgresBrowseWarmRoot(page, galleryActions, navigationPanelActions);
        const album = await readDdtAlbumPayload(page, REMIXES_ALBUM, { observe });
        expect(album?.tracks?.map(trackFilename).sort()).toEqual([...REMIXES_FILENAMES].sort());
        originalTitle = String(album.tracks.find((track) => trackFilename(track) === TITLE_TRACK).title);
        expect(originalTitle).not.toBe('');
        await expectRemixesPhysicalState(expect, { titles: { [TITLE_TRACK]: originalTitle } });
        await probeStatus('statusProbeMs', 'baseline /status');
      });
      const editedTitle = `${originalTitle}${EDITED_TITLE_SUFFIX}`;
      await stepLogger.step('Run eight consecutive Edit Tags saves', async () => {
        await split(1, originalTitle);
        await merge(1, originalTitle);
        await retitle('title edit', editedTitle);
        await retitle('title restore', originalTitle);
        await split(2, originalTitle);
        await merge(2, originalTitle);
        await split(3, originalTitle);
        await merge(3, originalTitle);
      });
      await stepLogger.step('The server stays responsive after the last save', async () => {
        for (let probe = 1; probe <= 3; probe += 1) {
          await probeStatus('statusProbeMs', `final /status ${probe}`);
        }
      });
    } finally {
      try {
        if (originalTitle) {
          await restoreRemixesThroughApp(page, { titles: { [TITLE_TRACK]: originalTitle } });
        }
      } finally {
        await managedAppLifecycle.stop();
        try {
          await restoreRemixesMedia(mediaSnapshot);
        } finally {
          await managedAppLifecycle.restart();
        }
      }
    }
    await expectRemixesPhysicalState(expect, { titles: { [TITLE_TRACK]: originalTitle } });

    const serverErrors = responses.filter(({ status }) => status >= 500);
    expect(serverErrors, 'No request may answer with a 5xx').toEqual([]);
    const byKind = (kind, key) => edits.filter((edit) => edit.kind === kind).map((edit) => edit[key]);
    const comparability = Object.fromEntries(['split', 'merge'].flatMap((kind) => [
      [`${kind}Accepted`, expectComparableTimings(expect.soft, byKind(kind, 'acceptedMs'), `${kind} HTTP 200`)],
      [`${kind}Completed`, expectComparableTimings(expect.soft, byKind(kind, 'completedMs'), `${kind} completed save`)],
    ]));
    const metrics = Object.fromEntries(BUDGET_KEYS.map((key) => [key, Math.max(...samples[key])]));
    for (const key of BUDGET_KEYS) {
      await editTagsApiConsecutiveLocalReport.recordTimingCheckpoint({
        key,
        label: `Slowest ${key}`,
        timingMs: metrics[key],
        details: { samples: samples[key] },
      });
      editTagsApiConsecutiveLocalReport.recordTerminalTimingOutcome(
        BUDGETS[key].metricId,
        key,
        expectTimingBudget(expect.soft, metrics[key], BUDGETS[key], `Slowest ${key}`),
      );
    }
    editTagsApiConsecutiveLocalReport.setMetricsPayload({
      ...metrics,
      comparability,
      edits,
      requestCount: responses.length,
      samples,
    });
    editTagsApiConsecutiveLocalReport.recordContractCompletion();
  });
});
