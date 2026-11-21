const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectRows, toMarkdown } = require('../../scripts/ci/summarize-gate-timings.cjs');

const contract = {
  'search-browse.searchBrowseReadyMs': {
    local: { targetMs: 800, graceMs: 400, hardCeilingMs: 1200 },
    ci: { targetMs: 800, graceMs: 400, hardCeilingMs: 1200 },
  },
  'artist-tree-scroll-navigation.jumpAlignedMs': {
    local: { targetMs: 800, graceMs: 400, hardCeilingMs: 1200 },
    ci: { targetMs: 800, graceMs: 400, hardCeilingMs: 1200 },
  },
  'utility-problematic-files-isolated-postgres.problematicReadyMs': {
    local: { targetMs: 1000, graceMs: 200, hardCeilingMs: 1200 },
    ci: { targetMs: 1000, graceMs: 200, hardCeilingMs: 1200 },
  },
};

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

test('collects budgeted timings from history metrics and report attachments', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-timings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targets = path.join(root, 'playwright-performance-targets');
  writeJson(path.join(targets, 'search-browse', 'history', 'r', 'runs', '1', 'metrics.json'), {
    rawMetrics: {
      benchmarkValidation: { results: [{ metricId: 'search-browse.searchBrowseReadyMs', actual: 900.4 }] },
    },
  });
  writeJson(path.join(targets, 'utility-problematic-files', 'history', 'r', 'runs', '1', 'metrics.json'), {
    rawMetrics: { problematicReadyMs: 1300 },
  });
  const attachment = { metricId: 'artist-tree-scroll-navigation.jumpAlignedMs', actualMs: 120 };
  writeJson(path.join(targets, 'artist-tree-scroll-navigation', 'attempt-1', 'report.json'), {
    suites: [{ specs: [{ tests: [{ results: [{ attachments: [
      { contentType: 'application/json', body: Buffer.from(JSON.stringify(attachment)).toString('base64') },
      { contentType: 'application/json', body: Buffer.from('{"unrelated":true}').toString('base64') },
    ] }] }] }] }],
  });

  const rows = collectRows([targets], { contract })
    .map(({ target, metricId, actualMs, status }) => ({ target, metricId, actualMs, status }))
    .sort((left, right) => left.target.localeCompare(right.target));

  assert.deepEqual(rows, [
    { target: 'artist-tree-scroll-navigation', metricId: 'artist-tree-scroll-navigation.jumpAlignedMs', actualMs: 120, status: 'target-met' },
    { target: 'search-browse', metricId: 'search-browse.searchBrowseReadyMs', actualMs: 900, status: 'grace-used' },
    { target: 'utility-problematic-files', metricId: 'utility-problematic-files-isolated-postgres.problematicReadyMs', actualMs: 1300, status: 'hard-fail' },
  ]);
  assert.match(toMarkdown(rows.map((row) => ({ ...row, targetMs: 1, hardCeilingMs: 2 }))), /\| search-browse \| search-browse\.searchBrowseReadyMs \| 900 \| 1 \| 2 \| grace-used \|/u);
});
