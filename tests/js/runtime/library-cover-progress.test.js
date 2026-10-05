const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../../music_app/static/js/runtime/loader-status-helpers.js'), 'utf8'), context);

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
