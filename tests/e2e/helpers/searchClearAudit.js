// AUDIT ONLY (branch audit/search-clear-profiling, never merged): stage timings,
// requests, long tasks and CPU profiles for search submit and search clear.

const STAGE_TIMEOUT_MS = 60000;
const TRAILING_MS = 1500;

async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__audit) return;
    const audit = { enterAt: null, longTasks: [] };
    window.__audit = audit;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          audit.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch (_error) { /* longtask unsupported */ }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target?.id === 'search-input') audit.enterAt = performance.now();
    }, true);
    document.addEventListener('click', (event) => {
      if (event.target?.closest?.('[data-search-clear], .app-bar-brand')) audit.enterAt = performance.now();
    }, true);
    audit.begin = () => { audit.enterAt = null; audit.beginAt = performance.now(); };
    audit.settle = (expectedQuery, expectRoot, timeoutMs) => new Promise((resolve) => {
      const marks = { appliedAt: null, settledAt: null, firstBusyAt: null };
      let stable = 0;
      const tick = () => {
        const now = performance.now();
        const s = typeof state === 'undefined' ? null : state;
        const query = String(s?.view?.query || '');
        const selected = String(s?.view?.selected_artist || '').trim();
        if (s?.busy && marks.firstBusyAt === null) marks.firstBusyAt = now;
        const applied = query === expectedQuery && (!expectRoot || !selected);
        if (applied && marks.appliedAt === null) marks.appliedAt = now;
        const idle = applied && !s?.busy && !String(s?.ui?.activeViewRequestUrl || '').trim();
        stable = idle ? stable + 1 : 0;
        if (stable >= 2) {
          marks.settledAt = now;
          resolve({ ...marks, timedOut: false, selected, query });
          return;
        }
        if (now - (audit.beginAt || 0) > timeoutMs) {
          resolve({ ...marks, timedOut: true, selected, query });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    audit.snapshot = (fromMs) => {
      const resources = performance.getEntriesByType('resource')
        .filter((entry) => entry.startTime >= fromMs && ['fetch', 'xmlhttprequest'].includes(entry.initiatorType))
        .map((entry) => {
          const url = new URL(entry.name);
          return {
            path: url.pathname,
            query: url.search.slice(0, 400),
            start: Math.round(entry.startTime - fromMs),
            serverWait: Math.round(entry.responseStart - entry.requestStart),
            download: Math.round(entry.responseEnd - entry.responseStart),
            end: Math.round(entry.responseEnd - fromMs),
            transferBytes: entry.transferSize,
            encodedBytes: entry.encodedBodySize,
            decodedBytes: entry.decodedBodySize,
          };
        });
      const images = performance.getEntriesByType('resource')
        .filter((entry) => entry.startTime >= fromMs && entry.initiatorType === 'img').length;
      const longTasks = audit.longTasks.filter((task) => task.start >= fromMs)
        .map((task) => ({ start: Math.round(task.start - fromMs), duration: Math.round(task.duration) }));
      return {
        resources,
        imageRequests: images,
        longTasks,
        longTaskTotalMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
        domNodes: document.getElementsByTagName('*').length,
        albumCards: document.querySelectorAll('.album-card').length,
        sidebarArtists: Array.isArray(state?.view?.artists_sidebar) ? state.view.artists_sidebar.length : null,
        viewAlbumCount: Number(state?.view?.album_count || 0),
        viewArtistGroups: Array.isArray(state?.view?.artist_groups) ? state.view.artist_groups.length : null,
        heapBytes: performance.memory?.usedJSHeapSize || null,
      };
    };
  });
}

function summarizeProfile(profile) {
  if (!profile?.nodes) return null;
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let index = 0; index < samples.length; index += 1) {
    selfUs.set(samples[index], (selfUs.get(samples[index]) || 0) + (deltas[index] || 0));
  }
  const byFunction = new Map();
  const byFile = new Map();
  for (const [id, us] of selfUs) {
    const frame = byId.get(id)?.callFrame || {};
    const file = String(frame.url || '').split('/').pop() || `(${frame.functionName || 'native'})`;
    const key = `${frame.functionName || '(anonymous)'} @ ${file}:${(frame.lineNumber ?? -1) + 1}`;
    byFunction.set(key, (byFunction.get(key) || 0) + us);
    byFile.set(file, (byFile.get(file) || 0) + us);
  }
  // Inclusive time per function, attributing each sample to every distinct ancestor frame.
  const parent = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parent.set(child, node.id);
  const inclusive = new Map();
  for (const [id, us] of selfUs) {
    const seen = new Set();
    for (let cursor = id; cursor !== undefined; cursor = parent.get(cursor)) {
      const frame = byId.get(cursor)?.callFrame || {};
      if (!frame.url) continue;
      const key = `${frame.functionName || '(anonymous)'} @ ${String(frame.url).split('/').pop()}:${(frame.lineNumber ?? -1) + 1}`;
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) || 0) + us);
    }
  }
  const top = (map, count) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count)
    .map(([name, us]) => ({ name, ms: Math.round(us / 100) / 10 }));
  return {
    totalMs: Math.round((profile.endTime - profile.startTime) / 1000),
    topSelf: top(byFunction, 30),
    topInclusive: top(inclusive, 40),
    byFile: top(byFile, 15),
  };
}

async function measureStage(page, cdp, label, { action, expectedQuery, expectRoot = false, timeoutMs = STAGE_TIMEOUT_MS }) {
  const result = { label, expectedQuery, expectRoot, wallStartIso: new Date().toISOString() };
  try {
    await page.evaluate(() => window.__audit.begin());
    const fromMs = await page.evaluate(() => window.__audit.beginAt);
    await cdp.send('Profiler.start');
    await action();
    const settled = await page.evaluate(
      ([query, root, timeout]) => window.__audit.settle(query, root, timeout),
      [expectedQuery, expectRoot, timeoutMs],
    );
    const enterAt = await page.evaluate(() => window.__audit.enterAt);
    await page.waitForTimeout(TRAILING_MS);
    const { profile } = await cdp.send('Profiler.stop');
    const snapshot = await page.evaluate((from) => window.__audit.snapshot(from), fromMs);
    const t0 = enterAt ?? fromMs;
    const rel = (value) => (value === null || value === undefined ? null : Math.round(value - t0));
    Object.assign(result, {
      inputToAppliedMs: rel(settled.appliedAt),
      inputToSettledMs: rel(settled.settledAt),
      inputToFirstBusyMs: rel(settled.firstBusyAt),
      timedOut: settled.timedOut,
      finalQuery: settled.query,
      finalSelectedArtist: settled.selected,
      inputOffsetFromBeginMs: Math.round(t0 - fromMs),
      ...snapshot,
      cpu: summarizeProfile(profile),
    });
  } catch (error) {
    result.error = String(error?.stack || error);
    try { await cdp.send('Profiler.stop'); } catch (_error) { /* not started */ }
  }
  result.wallEndIso = new Date().toISOString();
  return result;
}

export async function runSearchClearAudit({ page, searchQuery, testInfo }) {
  const report = { searchQuery, stages: [], startedAt: new Date().toISOString() };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await installProbe(page);
  const input = page.locator('#search-input');
  const clearButton = page.locator('#search-form [data-search-clear], .search-field-control [data-search-clear]').first();
  const typeAndEnter = async (query) => {
    await input.click();
    await input.fill(query);
    await input.press('Enter');
  };
  const broadQuery = String(searchQuery).trim().split(/\s+/)[0].slice(0, 3).toLowerCase();
  const stage = async (label, options) => {
    const result = await measureStage(page, cdp, label, options);
    report.stages.push(result);
    return result;
  };
  try {
    // State on entry: the measured warm exact search for searchQuery is applied.
    await stage('clear-x-button-only (no Enter)', {
      action: () => clearButton.click(),
      expectedQuery: '__never__',
      timeoutMs: 2500,
    }).then((result) => {
      result.note = 'Times out by design if the X button does not apply the clear to the gallery.';
    });
    await stage('clear-enter after exact search (selected artist kept)', {
      action: () => input.press('Enter'),
      expectedQuery: '',
    });
    await stage('home click back to full gallery', {
      action: () => page.locator('.app-bar-brand').first().click(),
      expectedQuery: '',
      expectRoot: true,
    });
    for (const pass of ['first', 'repeat']) {
      await stage(`exact artist search from full gallery (${pass})`, {
        action: () => typeAndEnter(searchQuery),
        expectedQuery: searchQuery,
      });
      await stage(`clear (X + Enter) after exact search (${pass})`, {
        action: async () => { await clearButton.click(); await input.press('Enter'); },
        expectedQuery: '',
      });
      await stage(`home click to full gallery after clear (${pass})`, {
        action: () => page.locator('.app-bar-brand').first().click(),
        expectedQuery: '',
        expectRoot: true,
      });
      await stage(`broad search "${broadQuery}" from full gallery (${pass})`, {
        action: () => typeAndEnter(broadQuery),
        expectedQuery: broadQuery,
      });
      await stage(`clear (X + Enter) after broad search (${pass})`, {
        action: async () => { await clearButton.click(); await input.press('Enter'); },
        expectedQuery: '',
      });
      await stage(`home click to full gallery after broad clear (${pass})`, {
        action: () => page.locator('.app-bar-brand').first().click(),
        expectedQuery: '',
        expectRoot: true,
      });
    }
  } catch (error) {
    report.error = String(error?.stack || error);
  } finally {
    report.finishedAt = new Date().toISOString();
    await testInfo.attach('search-clear-audit', {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: 'application/json',
    });
    try { await cdp.detach(); } catch (_error) { /* page closed */ }
  }
  return report;
}
