import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export function problemDetailExpectation(payload) {
  assert.ok(payload && String(payload.key || ''), 'Detail oracle requires a stable album key');
  const repair = (payload.repair_preview_rows || []).find(row => row.field === 'album');
  const title = String(repair?.repaired || payload.name || payload.raw_name || '');
  assert.ok(title, 'Detail oracle requires an independently supplied title');
  const proposals = (payload.suggested_edits || []).filter(item => item?.id && item.eligible !== false);
  const paths = new Set();
  for (const row of payload.track_problem_rows || []) {
    if ((row.reasons || []).some(reason => !['Missing cover art', 'Poor art quality'].includes(reason))
      || proposals.some(item => item.path === row.path)) paths.add(String(row.path || ''));
  }
  for (const proposal of proposals) paths.add(String(proposal.path || ''));
  assert.ok(!paths.has(''), 'Rendered-track oracle cannot contain a blank path');
  const albumRows = Array.isArray(payload.album_problem_rows)
    ? payload.album_problem_rows : (payload.problem_reasons || []).map(reason => ({ reason }));
  return {
    key: String(payload.key), title, hasEncodingRepairs: Boolean(payload.has_encoding_repairs),
    trackPaths: (payload.tracks || []).map(track => String(track.path || '')),
    renderedPaths: [...paths],
    albumReasons: albumRows.map(row => row.reason === 'Missing year' ? row.reason : row.display_reason || row.reason),
    emptyText: albumRows.length ? 'Only album-level problems found. No per-track problems.' : 'No per-track problems found.',
  };
}

export function expectProblematicRenderedIdentity(actual, summaryItem, projection, requireTracks = true) {
  const expectedKey = String(summaryItem?.key || '');
  assert.ok(expectedKey, 'Pre-action summary key is required');
  assert.equal(projection.key, expectedKey);
  assert.equal(actual.activeKey, expectedKey);
  assert.equal(actual.selectedKey, expectedKey);
  assert.equal(actual.runtimeKey, expectedKey);
  assert.equal(actual.title, projection.title);
  assert.equal(actual.headingVisible, true, 'Requested detail heading must actually be visible');
  const exactUnique = (values, expected, label) => {
    assert.ok(Array.isArray(values), `${label} must be an array`);
    assert.equal(new Set(values).size, values.length, `${label} must not contain duplicate identities`);
    assert.deepEqual([...values].sort(), [...expected].sort(), `${label} must match immutable server evidence`);
  };
  exactUnique(actual.trackPaths, projection.trackPaths, 'Selected album tracks');
  if (Array.isArray(summaryItem.track_paths)) exactUnique(actual.trackPaths, summaryItem.track_paths, 'Summary track identity');
  exactUnique(actual.renderedPaths, projection.renderedPaths, 'Rendered problem tracks');
  assert.equal(new Set(actual.visibleRenderedPaths).size, actual.visibleRenderedPaths.length, 'Visible tracks cannot repeat');
  assert.ok(actual.visibleRenderedPaths.every(path => projection.renderedPaths.includes(path)), 'Visible track identity must belong to requested detail');
  if (requireTracks) assert.ok(projection.renderedPaths.length > 0, 'This scenario requires a track-bearing immutable oracle');
  if (projection.renderedPaths.length) {
    assert.ok(actual.visibleRenderedPaths.length > 0, 'Expected real visible rendered tracks, not an empty or hidden table');
    assert.ok(actual.visibleRenderedPaths.includes(projection.renderedPaths[0]), 'The known first expected problem track must be visible');
  } else {
    assert.deepEqual(actual.visibleRenderedPaths, []);
    assert.equal(actual.emptyText, projection.emptyText);
    exactUnique(actual.albumReasons, projection.albumReasons, 'Album-level problems');
  }
  if (projection.hasEncodingRepairs) {
    assert.equal(actual.convertedText, 'Converted tags');
    assert.equal(actual.convertedPressed, 'true');
  }
}

export function expectProblematicNavigationRecords(records, expectedKey, expectedTitle) {
  assert.ok(expectedKey && expectedTitle, 'Navigation requires independent key and title');
  for (const record of records) {
    assert.ok(Number.isInteger(record.detailRenderCount) && record.detailRenderCount >= 0,
      'Every observation must retain its exact detail mutation count');
    assert.equal(record.detailRender, record.detailRenderCount > 0);
  }
  const detailRenders = records.filter(record => record.detailRender);
  assert.equal(detailRenders.reduce((total, record) => total + record.detailRenderCount, 0), 1,
    'Exactly one root detail content replacement is required');
  assert.equal(detailRenders.length, 1);
  assert.equal(detailRenders[0].activeKey, expectedKey);
  assert.equal(detailRenders[0].detailTitle, expectedTitle);
  for (const record of records) {
    if (record.activeKey) assert.equal(record.activeKey, expectedKey, 'No wrong transient active selection');
    if (record.detailTitle) {
      assert.equal(record.selectedKey, expectedKey, 'A titled detail must retain its selected model key');
      assert.equal(record.runtimeKey, expectedKey, 'A titled detail must retain its detail model key');
      assert.equal(record.detailTitle, expectedTitle, 'No wrong transient detail');
      if (!record.activeKey) {
        assert.equal(record.detailMutation, false, 'An absent active row is allowed only during list-only mutations');
        assert.equal(record.selectedRowMounted, false, 'A mounted selected row must remain active');
      }
    }
  }
}

export function observeProblematicDetails(page) {
  const details = new Map();
  const pending = new Set();
  const errors = [];
  let summary = null;
  const remember = (key, payload) => {
    assert.ok(key && payload && payload.key === key, 'Observed detail must match the independently requested key');
    details.set(key, JSON.stringify(payload));
  };
  const responseListener = response => {
    const url = new URL(response.url());
    if (!['/utilities/problematic-files', '/utilities/problematic-files/detail'].includes(url.pathname)) return;
    const task = (async () => {
      assert.equal(response.ok(), true, 'Normal problematic data response must succeed');
      const payload = await response.json();
      if (url.pathname.endsWith('/detail')) {
        remember(url.searchParams.get('album_key'), payload);
      } else {
        assert.ok(Array.isArray(payload.items), 'Normal summary must expose its complete items');
        summary = JSON.stringify(payload.items);
        assert.ok(!payload.initial_detail || payload.items.some(item => item.key === payload.initial_detail.key),
          'Any initial detail must belong to captured summary');
        if (payload.initial_detail) remember(payload.initial_detail.key, payload.initial_detail);
      }
    })().catch(error => errors.push(error)).finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on('response', responseListener);
  const settle = async () => {
    await Promise.all([...pending]);
    if (errors.length) throw new AggregateError(errors, 'Problematic evidence capture failed');
  };
  return {
    async summary() { await settle(); assert.ok(summary, 'Capture must be installed before the normal summary request'); return JSON.parse(summary); },
    async detail(key) { await settle(); return details.has(key) ? JSON.parse(details.get(key)) : null; },
    async dispose() { page.off('response', responseListener); await settle(); },
  };
}

export async function exerciseProblematicNativeJumps({ page, shell, capture, expectedTotal, minimumMiddleStart = 0 }) {
  const initial = await shell.readProblemSelectionEvidence();
  assert.equal(initial.query, '', 'Rapid full-list validation requires the cleared normal search');
  assert.deepEqual(initial.filters, [], 'Rapid full-list validation requires no active problem filter');
  const summary = await capture.summary();
  const keys = summary.map(item => String(item.key));
  assert.equal(new Set(keys).size, keys.length, 'Complete summary identities must be unique');
  assert.equal(Number(await shell.resultCount.textContent()), summary.length);
  if (expectedTotal !== undefined) assert.equal(summary.length, expectedTotal);
  assert.ok(summary.length > 10);
  const requiresTrackRows = item => Array.isArray(item.track_paths) && item.track_paths.length > 0
    && (item.problem_reasons || []).some(reason => ['Missing track title', 'Missing track artist',
      'Missing track number', 'Invalid track number', 'Album name mismatch', 'Album artist mismatch',
      'Year mismatch', 'Inconsistent year'].includes(reason));
  const midpoint = summary[Math.floor(summary.length / 2)];
  const origin = summary[0];
  const records = [];
  const settledWindow = async target => {
    await expect.poll(async () => {
      const view = await shell.readProblemVirtualWindow();
      return Math.abs(view.offset - target) <= 1 && view.viewportCovered
        && JSON.stringify(view.keys) === JSON.stringify(keys.slice(view.start, view.end));
    }, { timeout: 10000 }).toBe(true);
    const view = await shell.readProblemVirtualWindow();
    assert.equal(new Set(view.keys).size, view.keys.length);
    assert.equal(view.keys.length, view.end - view.start);
    assert.ok(view.keys.length <= 60, 'The list must remain virtualized');
    return view;
  };
  const wheel = async target => {
    const view = await shell.readProblemVirtualWindow();
    assert.ok(view.extent > view.viewport, 'Rapid-jump scenario requires genuine offscreen content');
    const bounds = await shell.tree.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(view.horizontal ? target - view.offset : 0, view.horizontal ? 0 : target - view.offset);
    return settledWindow(target);
  };
  const select = async (item, requireTracks) => {
    const row = shell.rowByKey(item.key);
    await expect(row).toBeVisible();
    await row.click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect.poll(async () => Boolean(await capture.detail(item.key))).toBe(true);
    const expected = problemDetailExpectation(await capture.detail(item.key));
    await expect(shell.heading).toHaveText(expected.title);
    if (expected.renderedPaths.length) await shell.detailTrackByPath(expected.renderedPaths[0]).scrollIntoViewIfNeeded();
    await expect(async () => {
      expectProblematicRenderedIdentity(await shell.readProblemSelectionEvidence(), item, expected, requireTracks);
    }).toPass({ timeout: 10000 });
    return expected;
  };
  for (let round = 0; round < 2; round += 1) {
    const before = await shell.readProblemVirtualWindow();
    const target = Math.floor((before.extent - before.viewport) / 2);
    const started = Date.now();
    const middle = await wheel(target);
    assert.ok(middle.start >= minimumMiddleStart);
    assert.ok(middle.visibleKeys.includes(midpoint.key), 'Actual midpoint must remain in the intended native window');
    // Declare the track-bearing identity from the immutable summary before any
    // selection; a missing expected track table cannot choose an easier oracle.
    const trackCandidate = requiresTrackRows(midpoint) ? midpoint : summary.find(item => (
      middle.visibleKeys.includes(item.key) && requiresTrackRows(item)
    ));
    await select(midpoint, requiresTrackRows(midpoint));
    assert.ok(trackCandidate, 'Expected a predeclared track-bearing row within the midpoint window');
    await select(trackCandidate, true);
    const middleMs = Date.now() - started;
    const returnStarted = Date.now();
    const returned = await wheel(0);
    assert.equal(returned.start, 0);
    assert.ok(returned.visibleKeys.includes(origin.key));
    await select(origin, false);
    records.push({ round, total: summary.length, middle: { start: middle.start, end: middle.end, mounted: middle.keys.length, selectedKey: midpoint.key, trackKey: trackCandidate.key, durationMs: middleMs },
      returned: { start: returned.start, end: returned.end, mounted: returned.keys.length, selectedKey: origin.key, durationMs: Date.now() - returnStarted } });
  }
  return records;
}
