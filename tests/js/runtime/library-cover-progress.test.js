const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/loader-status-helpers.js'), 'utf8'), context);

require('node:test')('Spotify quota is a subline and does not reduce album progress', () => {
  const status = { covers_in_progress: true, covers_phase: 'fetching',
    covers_completed: 2487, covers_spotify_quota_exceeded: true,
    covers_total: 3353, covers_estimated_remaining_seconds: 10000 };
  const detail = context.buildCoverProgressDetail(status);
  assert.match(detail, /2487 of 3353 albums checked \(74%\)/);
  assert.doesNotMatch(detail, /retries pending/);
  const retryLine = context.buildLoaderStatusLines(status)[1];
  assert.equal(retryLine.title, 'Spotify');
  assert.equal(retryLine.detail, 'Spotify quota reached — skipped for this run');
  assert.match(detail, /ETA/);
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/status-ui-helpers.js'), 'utf8'), context);
  const title = context.buildStatusIndicatorTitleParts(status);
  assert.match(JSON.stringify(title), /2487 \/ 3353 cover searches completed/);
  assert.match(JSON.stringify(title), /Spotify quota reached/);
});

require('node:test')('cover preparation labels admission truthfully without premature percentage or ETA', () => {
  const preparing = context.buildLoaderStatusLines({
    covers_in_progress: true, covers_phase: 'preparing', covers_run_mode: 'manual-bulk',
    covers_completed: 0, covers_total: 0, covers_elapsed_seconds: 12,
    covers_estimated_remaining_seconds: 900,
  })[0];
  assert.equal(preparing.title, 'Preparing cover search');
  assert.match(preparing.detail, /Preparing cover search/);
  assert.match(preparing.detail, /elapsed 12s/);
  assert.doesNotMatch(preparing.detail, /Progress unavailable|\d+%|ETA|0 of 0/);
});

require('node:test')('cover-only preparation marks non-cover stages inactive rather than complete', () => {
  const runtime = vm.createContext({
    appBootstrap: { getInitialView: () => ({}) },
    window: { location: { href: 'http://localhost/', origin: 'http://localhost' } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/core-state-and-helpers.js'), 'utf8'), runtime);
  const states = runtime.resolveLibraryScanPhaseStates({
    covers_in_progress: true, covers_phase: 'preparing', covers_run_mode: 'manual-bulk',
  });
  assert.equal(states.covers, 'current');
  for (const stage of ['discover', 'metadata', 'relations']) assert.equal(states[stage], 'inactive');
});

require('node:test')('cover-only request publishes preparation before the server admission responds', async () => {
  let resolveResponse;
  const pending = new Promise(resolve => { resolveResponse = resolve; });
  let optimistic;
  const runtime = vm.createContext({
    state: { status: {} }, console: { log() {}, error() {} },
    claimLibraryStatusAction: () => ({}),
    startStatusIndicatorImmediately: status => { optimistic = status; },
    scheduleStatusPoll: () => {},
    fetch: () => pending,
    settleLibraryStatusAction: () => false,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,
    '../../../music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'), 'utf8'), runtime);
  const request = runtime.fetchUnsuccessfulAlbumCovers();
  try {
    assert.equal(optimistic.covers_phase, 'preparing');
    assert.equal(optimistic.covers_spotify_quota_exceeded, false);
    assert.match(optimistic.covers_run_mode, /^manual/);
    const line = context.buildLoaderStatusLines(optimistic)[0];
    assert.equal(line.title, 'Preparing cover search');
    assert.doesNotMatch(line.detail, /Progress unavailable|\d+%|ETA|elapsed/);
  } finally {
    resolveResponse({ ok: true, json: async () => ({ ok: true }) });
    await request;
  }
});

const detail = context.buildLoaderStatusLines({
  covers_in_progress: true, covers_processed: 25, covers_total: 100,
  covers_downloaded: 12, covers_elapsed_seconds: 180,
  covers_estimated_remaining_seconds: 360,
})[0];
assert.equal(detail.title, 'Fetching covers');
assert.match(detail.detail, /25 of 100 albums checked \(25%\)/);
assert.match(detail.detail, /12 covers fetched/);
assert.match(detail.detail, /elapsed 3m 00s/);
assert.match(detail.detail, /ETA 6m 00s/);
const unknown = context.buildLoaderStatusLines({ covers_in_progress: true })[0];
assert.match(unknown.detail, /Progress unavailable/);
assert.doesNotMatch(unknown.detail, /0 of 0/);
assert.match(unknown.detail, /ETA calculating/);
const disconnected = context.buildLoaderStatusLines({
  covers_in_progress: true, covers_processed: 25, covers_total: 100,
  status_connection_lost: true,
})[0];
assert.match(disconnected.detail, /reconnecting/);
assert.doesNotMatch(disconnected.detail, /25 of 100/);
const preparing = context.buildLoaderStatusLines({
  covers_in_progress: true, covers_run_mode: 'manual-bulk', covers_phase: 'preparing',
  covers_elapsed_seconds: 120,
})[0];
assert.match(preparing.detail, /Preparing cover search/);
assert.match(preparing.detail, /elapsed 2m 00s/);
assert.doesNotMatch(preparing.detail, /0 of 0/);
const finished = context.buildLoaderStatusLines({
  covers_in_progress: false, covers_run_mode: 'manual-bulk', covers_phase: 'finished',
  covers_processed: 100, covers_total: 100, covers_downloaded: 80, covers_elapsed_seconds: 900,
})[0];
assert.equal(finished.title, 'Cover search finished');
assert.match(finished.detail, /100 of 100 albums checked \(100%\)/);
assert.match(finished.detail, /80 covers fetched/);
assert.doesNotMatch(finished.detail, /ETA/);
for (const outcome of ['failed', 'cancelled']) {
  const terminal = context.buildLoaderStatusLines({
    covers_phase: 'finished', covers_outcome: outcome, covers_total: 0,
  })[0];
  assert.match(terminal.title, new RegExp(outcome));
  assert.match(terminal.detail, new RegExp(outcome));
  assert.doesNotMatch(terminal.detail, /No albums needed/);
}
const newScan = context.buildLoaderStatusLines({
  scan_in_progress: true, scan_phase: 'discovering',
  covers_phase: 'finished', covers_outcome: 'completed', covers_total: 100, covers_processed: 100,
});
assert.ok(newScan.every(line => !line.detail.includes('100 of 100')));

require('node:test')('cover detail uses completed jobs while legacy queue progress remains compatible', () => {
  const status = { covers_in_progress: true, covers_phase: 'fetching', covers_processed: 100,
    covers_total: 100, covers_completed: 25, covers_downloaded: 12 };
  assert.match(context.buildLoaderStatusLines(status)[0].detail, /25 of 100 albums checked \(25%\)/);
  assert.doesNotMatch(context.buildLoaderStatusLines(status)[0].detail, /100 of 100/);
  assert.match(context.buildLoaderStatusLines({ ...status, covers_completed: 0 })[0].detail,
    /0 of 100 albums checked \(0%\)/);
  const { covers_completed, ...legacy } = status;
  assert.match(context.buildLoaderStatusLines(legacy)[0].detail, /100 of 100 albums checked \(100%\)/);
});

require('node:test')('deferred and terminal partial cover results never display queue completion', () => {
  const status = { covers_phase: 'fetching', covers_in_progress: true,
    covers_processed: 2, covers_completed: 1, covers_total: 2 };
  assert.match(context.buildLoaderStatusLines(status)[0].detail, /1 of 2 albums checked \(50%\)/);
  for (const outcome of ['failed', 'cancelled']) {
    const detail = context.buildLoaderStatusLines({ ...status, covers_phase: 'finished',
      covers_in_progress: false, covers_outcome: outcome })[0].detail;
    assert.match(detail, /1 of 2 albums checked \(50%\)/);
    assert.doesNotMatch(detail, /ETA|100%/);
  }
});
