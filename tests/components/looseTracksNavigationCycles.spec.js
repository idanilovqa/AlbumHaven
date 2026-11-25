const path = require('node:path');
const { test, expect } = require('@playwright/test');

// Repeatedly opening library-wide Loose Tracks, going back to the Artists tree and scrolling must not leave
// listeners, observers, timers, frame loops or rows behind, and must not get slower cycle by cycle. The page is
// the real Loose Tracks owner (openNonAlbumModal / closeNonAlbumModal) inside the real mobile page outlet.
const staticRoot = path.resolve(__dirname, '../../music_app/static');
test.use({ trace: 'off', screenshot: 'off' });

const ROWS = 3000;
const CYCLES = 12;
const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1440, height: 900 };

// Counts what outlives a cycle: listeners on window/document/media queries (node listeners die with their
// nodes), connected observers, pending timers and requestAnimationFrame callbacks per idle second.
const probeScript = () => {
  const live = { globalListeners: 0, observers: 0, timeouts: new Set(), intervals: new Set(), raf: 0 };
  const isGlobal = target => target === window || target === document || target instanceof MediaQueryList;
  const keys = new WeakMap();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const keyOf = (type, options) => `${type}|${typeof options === 'boolean' ? options : Boolean(options?.capture)}`;
  EventTarget.prototype.addEventListener = function addEventListener(type, listener, options) {
    if (listener && isGlobal(this) && !options?.once) {
      let map = keys.get(this);
      if (!map) keys.set(this, map = new Map());
      const key = keyOf(type, options);
      if (!map.has(key)) map.set(key, new Set());
      if (!map.get(key).has(listener)) { map.get(key).add(listener); live.globalListeners += 1; }
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function removeEventListener(type, listener, options) {
    if (keys.get(this)?.get(keyOf(type, options))?.delete(listener)) live.globalListeners -= 1;
    return remove.call(this, type, listener, options);
  };
  for (const name of ['ResizeObserver', 'IntersectionObserver', 'MutationObserver']) {
    const Original = window[name];
    window[name] = class extends Original {
      observe(...args) { if (!this.counted) { this.counted = true; live.observers += 1; } return super.observe(...args); }
      disconnect() { if (this.counted) { this.counted = false; live.observers -= 1; } return super.disconnect(); }
    };
  }
  const setTimeoutOriginal = window.setTimeout;
  const clearTimeoutOriginal = window.clearTimeout;
  window.setTimeout = (callback, ...rest) => {
    const id = setTimeoutOriginal(() => { live.timeouts.delete(id); if (typeof callback === 'function') callback(); }, ...rest);
    live.timeouts.add(id);
    return id;
  };
  window.clearTimeout = (id) => { live.timeouts.delete(id); clearTimeoutOriginal(id); };
  const setIntervalOriginal = window.setInterval;
  window.setInterval = (...args) => { const id = setIntervalOriginal(...args); live.intervals.add(id); return id; };
  const clearIntervalOriginal = window.clearInterval;
  window.clearInterval = (id) => { live.intervals.delete(id); clearIntervalOriginal(id); };
  const rafOriginal = window.requestAnimationFrame;
  window.requestAnimationFrame = (callback) => { live.raf += 1; return rafOriginal(callback); };
  window.leakProbe = async () => {
    const rafBefore = live.raf;
    await new Promise(resolve => setTimeoutOriginal(resolve, 500));
    return {
      globalListeners: live.globalListeners, observers: live.observers, timeouts: live.timeouts.size,
      intervals: live.intervals.size, idleFrames: live.raf - rafBefore, elements: document.getElementsByTagName('*').length,
      historyLength: history.length,
    };
  };
};

async function mountLooseTracksShell(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(probeScript);
  await page.goto('about:blank');
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
    <div class="shell-layout">
      <aside class="sidebar shell-navigation-rail" id="shell-navigation-rail" data-library-navigation-mode="artists">
        <div id="artist-tree-expanded"><div class="mobile-artists-mode" role="group" aria-label="Library navigation">
          <button type="button" data-navigation-mode="artists" aria-pressed="true">Artists</button>
          <button type="button" data-navigation-mode="collections" aria-pressed="false">Loose Tracks</button>
        </div>
        <h2 id="navigation-tree-heading">Artists</h2>
        <div id="sidebar-collections" hidden></div><div id="sidebar-list"><a data-sidebar-all-artists="1" href="#">All artists</a></div></div>
      </aside>
      <main id="shell-main-surface">
        <div id="mobile-page-header" hidden><button id="mobile-back-button" data-mobile-back="1" hidden></button>
          <button id="mobile-page-library-button" hidden></button><h1 id="mobile-page-title"></h1><p id="mobile-page-summary"></p>
          <div id="mobile-settings-actions" hidden></div><button id="mobile-settings-button" hidden></button></div>
        <div class="mobile-page-outlet" id="mobile-page-outlet" hidden></div>
        <button id="mobile-library-button"></button>
        <div id="albums-scroll"></div>
      </main>
    </div>
    <div class="non-album-modal" id="non-album-modal" hidden>
      <div class="non-album-modal-dialog" role="dialog" aria-modal="true">
        <div class="non-album-modal-header gallery-bar page-gallery-bar" id="non-album-modal-header"></div>
        <div class="non-album-modal-table-wrap"><div class="non-album-modal-table" id="non-album-modal-table"></div></div>
      </div>
    </div></body></html>`);
  for (const file of ['base.css', 'app-chrome.css', 'button-component.css', 'mobile-layout.css', 'gallery-main.css',
    'runtime/base-layout.css', 'runtime/running-line.css', 'runtime/compact-data-table.css', 'runtime/album-track-table.css',
    'runtime/album-details-components.css', 'runtime/non-album-and-player.css']) {
    await page.addStyleTag({ path: path.join(staticRoot, 'css', file) });
  }
  await page.evaluate((rows) => {
    window.state = {
      view: {
        visible_library_categories: ['main_library'], gallery_scope: 'all', query: '',
        library_non_album_tracks: Array.from({ length: rows }, (_, index) => ({
          path: `/fixture/loose-${index}.flac`, title: `Loose track ${index}`, artist: index % 3 ? `Fixture artist ${index % 40}` : '',
          year_label: '1999', duration_seconds: 180, exception_type: index % 2 ? 'Interview' : '',
        })),
      },
      ui: {}, status: { inventory_mutation_revision: 7 }, player: { current: null }, utility: { activeTab: 'appearance' },
      gallery: {}, coverLookup: {},
    };
    Object.assign(window, {
      buildUrl: () => '/', getAlbumRequestKey: () => '', closeArtistsDrawer() {}, closeGalleryMainSurface() {},
      renderSidebar() {}, attachSharedPlayer() {}, syncMobileAlbumHeader() {}, syncMobileLoopHeader() {},
      buildProblematicAlbumTrackPathIndex: () => new Map(), getPlayerPlaybackSnapshot: () => ({ paused: true, ended: false }),
      matchesAlbumTrackSearch: () => false, formatTrackDuration: () => '3:00', formatAlbumDuration: () => '150 hours',
      handleGalleryBootstrapPopState() {}, updateGalleryMainChrome() {}, galleryMainSurfaceController: null,
    });
  }, ROWS);
  for (const file of ['button-component.js']) await page.addScriptTag({ path: path.join(staticRoot, 'js', file) });
  for (const file of ['browser-scheduling-helpers.js', 'markup-format-helpers.js', 'running-line.js', 'compact-data-table.js',
    'album-track-table.js', 'gallery-main-components.js', 'album-details-components.js', 'modal-and-overlay-helpers.js', 'mobile-navigation.js']) {
    await page.addScriptTag({ path: path.join(staticRoot, 'js/runtime', file) });
  }
  await page.evaluate(() => {
    state.view.library_non_album_tracks_hydrated_scope = getLibraryNonAlbumScopeKey(state.view);
    // The library history owner numbers entries, so leaving a page goes back instead of stacking entries.
    let position = 0;
    history.replaceState({ albumHavenNavigationPosition: position }, '');
    window.AlbumHavenSettingsNavigation = { instance: { pushLibraryHistory(url, snapshot) {
      position = (history.state?.albumHavenNavigationPosition ?? position) + 1;
      history.pushState({ ...snapshot, albumHavenNavigationPosition: position }, '', url);
    } } };
    window.addEventListener('popstate', () => handleMobilePagePopState());
    // initMobileNavigation's layout owner: crossing the phone breakpoint moves the open page between outlets.
    window.matchMedia('(max-width: 900px)').addEventListener('change', () => syncMobilePageShell());
    // The app's delegated gallery click owner: the mode buttons open or leave library-wide Loose Tracks.
    document.addEventListener('click', (event) => {
      const mode = event.target.closest('[data-navigation-mode]');
      if (!mode) return;
      if (mode.dataset.navigationMode === 'collections') openNonAlbumModal({ libraryWide: true });
      else if (document.getElementById('non-album-modal').hidden === false) closeNonAlbumModal();
    });
  });
  return errors;
}

const looseTracksShown = () => document.getElementById('non-album-modal').hidden === false
  && document.querySelectorAll('#non-album-modal [data-track-row-path]').length > 0;
const looseTracksClosed = () => document.getElementById('non-album-modal').hidden;

async function timedClick(page, selector, settled) {
  return page.evaluate(async ({ selector, settled }) => {
    const done = new Function(`return (${settled})()`);
    const start = performance.now();
    document.querySelector(selector).click();
    while (!done()) {
      if (performance.now() - start > 20000) throw new Error(`${selector} did not settle`);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return performance.now() - start;
  }, { selector, settled: settled.toString() });
}

async function scrollLooseTracks(page) {
  return page.evaluate(async () => {
    const outlet = document.getElementById('mobile-page-outlet');
    const scroller = outlet.hidden ? document.querySelector('#non-album-modal .non-album-modal-table-wrap') : outlet;
    let worst = 0;
    let last = performance.now();
    for (let step = 0; step < 30; step += 1) {
      scroller.scrollTop += step < 15 ? 900 : -900;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }
    return worst;
  });
}

async function runCycles(page, cdp, { viewportFor }) {
  const samples = [];
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await page.setViewportSize(viewportFor(cycle));
    const openMs = await timedClick(page, '[data-navigation-mode="collections"]', looseTracksShown);
    const worstScrollFrameMs = await scrollLooseTracks(page);
    const backMs = await timedClick(page, '[data-navigation-mode="artists"]', looseTracksClosed);
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const metric = name => metrics.find(entry => entry.name === name).value;
    samples.push({
      cycle, width: viewportFor(cycle).width, openMs: Math.round(openMs), backMs: Math.round(backMs),
      worstScrollFrameMs: Math.round(worstScrollFrameMs), nodes: metric('Nodes'), listeners: metric('JSEventListeners'),
      heapMB: Number((metric('JSHeapUsedSize') / 1048576).toFixed(2)), ...(await page.evaluate(() => window.leakProbe())),
    });
  }
  console.log(`Loose Tracks navigation cycles:\n${samples.map(sample => JSON.stringify(sample)).join('\n')}`);
  return samples;
}

function expectBounded(samples) {
  // Cycle 0 pays first-render costs; every later cycle returns to the cycle-1 baseline.
  const [, baseline, ...rest] = samples;
  for (const sample of rest) {
    expect(sample.globalListeners, `cycle ${sample.cycle} global listeners`).toBeLessThanOrEqual(baseline.globalListeners);
    expect(sample.observers, `cycle ${sample.cycle} observers`).toBeLessThanOrEqual(baseline.observers);
    expect(sample.intervals, `cycle ${sample.cycle} intervals`).toBeLessThanOrEqual(baseline.intervals);
    expect(sample.timeouts, `cycle ${sample.cycle} pending timeouts`).toBeLessThanOrEqual(baseline.timeouts + 1);
    expect(sample.idleFrames, `cycle ${sample.cycle} idle animation frames`).toBeLessThanOrEqual(2);
    expect(sample.historyLength, `cycle ${sample.cycle} history entries`).toBeLessThanOrEqual(baseline.historyLength);
    expect(sample.nodes, `cycle ${sample.cycle} DOM nodes`).toBeLessThanOrEqual(baseline.nodes * 1.02 + 50);
    expect(sample.listeners, `cycle ${sample.cycle} event listeners`).toBeLessThanOrEqual(baseline.listeners + 10);
    expect(sample.heapMB, `cycle ${sample.cycle} JS heap`).toBeLessThanOrEqual(baseline.heapMB * 1.25 + 1);
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const early = samples.slice(1, 4);
  const late = samples.slice(-3);
  for (const key of ['openMs', 'backMs']) {
    expect(median(late.map(sample => sample[key])), `${key} late vs early cycles`)
      .toBeLessThanOrEqual(median(early.map(sample => sample[key])) * 1.5 + 30);
  }
}

for (const scenario of [
  { name: 'phone width', viewportFor: () => MOBILE },
  { name: 'desktop width', viewportFor: () => DESKTOP },
  { name: 'crossing the phone breakpoint each cycle', viewportFor: cycle => (cycle % 2 ? DESKTOP : MOBILE) },
]) {
  test(`Loose Tracks open, back and scroll cycles stay bounded at ${scenario.name}`, async ({ page }) => {
    test.setTimeout(180000);
    await page.setViewportSize(scenario.viewportFor(0));
    const errors = await mountLooseTracksShell(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const samples = await runCycles(page, cdp, scenario).catch((error) => { throw new Error(`${error.message}
page errors: ${errors.join(' | ')}`); });
    expect(errors).toEqual([]);
    for (const sample of samples) expect(sample.nodes).toBeGreaterThan(ROWS * 3);
    expectBounded(samples);
  });
}
