const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.join(__dirname, '..', '..', '..');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function element() {
  const attrs = new Map(), classes = new Set();
  return {
    hidden: false, disabled: false, textContent: '', title: '', dataset: {}, style: {},
    getAttribute: name => attrs.get(name),
    setAttribute(name, value) { attrs.set(name, String(value)); },
    addEventListener() {},
    querySelector() { return null; },
    classList: {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains: name => classes.has(name),
    },
  };
}
function harness() {
  const requests = [], timers = new Map(), toasts = [], capabilities = [], renders = [], refreshes = [];
  let timerId = 0;
  let now = 1000;
  const indicator = element(), primary = element(), cover = element(), scanPage = element(), menu = element();
  menu.querySelector = selector => ({
    '[data-status-role="scan-action"]': primary,
    '[data-status-role="cover-action"]': cover,
    '[data-status-role="scan-page"]': scanPage,
  }[selector] || null);
  const ctx = vm.createContext({
    console,
    Date: class extends Date { static now() { return now; } },
    state: { status: {}, ui: {}, utility: { loaded: false, loading: false }, view: {}, busy: false },
    document: { getElementById: id => ({ 'scan-indicator': indicator, 'status-context-menu': menu }[id] || null) },
    renderLibraryLoader(status) { renders.push({ ...status }); },
    syncLoopCreateCapability() { capabilities.push(ctx.state.loopCreateAllowed); },
    showToast(message, level) { toasts.push({ message, level }); },
    scheduleBrowserTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, dueAt: now + delay }); return id; },
    clearBrowserTimeout(id) { return timers.delete(id); },
    getUtilityModalElements: () => ({ overlay: { hidden: false } }),
    renderUtilityModalContent() {},
    fetch(url, options = {}) {
      const response = deferred();
      const request = {
        url, options, resolve(payload, status = 200) {
          response.resolve({ ok: status >= 200 && status < 300, status, json: async () => payload });
        },
        reject: response.reject,
        resolveHeaders(payloadPromise, status = 200) {
          response.resolve({ ok: status >= 200 && status < 300, status, json: () => payloadPromise });
        },
      };
      requests.push(request);
      return response.promise;
    },
  });
  // Real normalization, status state writer, indicator and menu projection.
  for (const name of ['response-state-helpers.js', 'status-ui-helpers.js', 'gallery-refresh-and-status.js', 'utility-loaders-and-cover-lookup.js', 'library-settings.js']) {
    const source = path.join(root, 'music_app/static/js/runtime', name);
    vm.runInContext(fs.readFileSync(source, 'utf8'), ctx, { filename: source });
  }
  ctx.loadProblematicFiles = async () => [];
  // Downstream gallery rendering is outside this status/menu unit boundary.
  ctx.refreshCurrentViewAfterBackgroundCompletion = async () => { refreshes.push('gallery'); return true; };
  const status = (busy = false, extra = {}) => ({
    scan_in_progress: busy, scan_mode: busy ? 'manual_full_rescan' : 'idle',
    scan_phase: busy ? 'discovering' : 'idle', scan_outcome: busy ? 'running' : 'idle',
    scan_generation: busy ? 2 : 1, relations_in_progress: false, covers_in_progress: false,
    allowed_actions: { 'library.loops.create': true }, album_total: 10, ...extra,
  });
  ctx.updateStatusIndicator(status());
  return {
    ctx, requests, timers, toasts, primary, status, refreshes, renders, menu,
    advance(ms) { now += ms; },
    runTimer(id) {
      const timer = timers.get(id);
      assert.ok(timer);
      now = Math.max(now, timer.dueAt);
      timers.delete(id);
      return timer.callback();
    },
  };
}
async function settle() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
async function acceptedStart(h) {
  const starting = h.ctx.triggerLibraryRefresh(true);
  h.requests.at(-1).resolve({ ok: true, full_rescan: true });
  assert.equal(await starting, true);
  return starting;
}
function expectBusy(h) {
  assert.equal(h.ctx.state.status.scan_in_progress, true, 'a superseded response must not clear an accepted scan');
  assert.equal(h.primary.getAttribute('data-status-action'), 'go-to-scan-page');
  assert.equal(h.primary.textContent, 'Go to Library Status Page');
}

test('idle read issued before a new scan cannot overwrite its accepted busy menu', async () => {
  const h = harness();
  const old = h.ctx.pollStatus(), oldRequest = h.requests.at(-1);
  await acceptedStart(h);
  expectBusy(h);
  oldRequest.resolve(h.status());
  await old;
  expectBusy(h);
});

test('idle read issued during deferred start acknowledgement cannot overwrite accepted startup', async () => {
  const h = harness();
  const starting = h.ctx.triggerLibraryRefresh(true), startRequest = h.requests.at(-1);
  const old = h.ctx.pollStatus(), oldRequest = h.requests.at(-1);
  startRequest.resolve({ ok: true, full_rescan: true });
  await starting;
  oldRequest.resolve(h.status());
  await old;
  expectBusy(h);
});

test('an earlier idle poll cannot replace a newer running observation', async () => {
  const h = harness();
  const old = h.ctx.pollStatus(), oldRequest = h.requests.at(-1);
  const newer = h.ctx.pollStatus(), newRequest = h.requests.at(-1);
  newRequest.resolve(h.status(true)); await newer;
  oldRequest.resolve(h.status()); await old;
  expectBusy(h);
});

test('a stale error payload cannot publish an error after a newer running status', async () => {
  const h = harness();
  const old = h.ctx.pollStatus(), oldRequest = h.requests.at(-1);
  const newer = h.ctx.pollStatus(), newRequest = h.requests.at(-1);
  newRequest.resolve(h.status(true)); await newer;
  oldRequest.resolve(h.status(false, { scan_outcome: 'failed', last_error: 'Prior scan failed.' })); await old;
  assert.equal(h.toasts.some(x => x.level === 'error'), false);
  expectBusy(h);
});

for (const outcome of ['success', 'failure']) {
  test(`a superseded cancellation ${outcome} cannot clear or report into a newer accepted scan`, async () => {
    const h = harness();
    h.ctx.updateStatusIndicator(h.status(true));
    const cancelling = h.ctx.cancelLibraryScan(), cancelRequest = h.requests.at(-1);
    // Server cancellation is complete; its HTTP response is delayed while a new
    // observational read reports idle and the user starts the next scan.
    const observed = h.ctx.pollStatus();
    h.requests.at(-1).resolve(h.status(false, { scan_outcome: 'cancelled', scan_generation: 3 }));
    await observed;
    await acceptedStart(h);
    if (outcome === 'success') cancelRequest.resolve({ ok: true, cancelled: true });
    else cancelRequest.reject(new Error('Obsolete cancellation response error'));
    await cancelling;
    assert.equal(h.toasts.some(x => /cancelled|Obsolete/.test(x.message)), false);
    expectBusy(h);
  });
}

test('a delayed accepted-start response cannot resurrect the scan after cancellation', async () => {
  const h = harness();
  const starting = h.ctx.triggerLibraryRefresh(true), startRequest = h.requests.at(-1);
  const observed = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(true)); await observed;
  const cancelling = h.ctx.cancelLibraryScan();
  h.requests.at(-1).resolve({ ok: true, cancelled: true }); await cancelling;
  startRequest.resolve({ ok: true, full_rescan: true }); await starting;
  assert.equal(h.ctx.state.status.scan_in_progress, false);
  assert.equal(h.toasts.some(x => x.message === 'Library scan started.'), false);
});

test('a late start transport error cannot restore idle over a later accepted scan', async () => {
  const h = harness();
  const starting = h.ctx.triggerLibraryRefresh(true), oldStart = h.requests.at(-1);
  const cancelling = h.ctx.cancelLibraryScan();
  h.requests.at(-1).resolve({ ok: true, cancelled: true }); await cancelling;
  await acceptedStart(h);
  oldStart.reject(new Error('Prior request transport failure')); await starting;
  expectBusy(h);
  assert.equal(h.toasts.some(x => x.level === 'error'), false);
});

test('supersession while status JSON is pending still protects the new scan', async () => {
  const h = harness(), body = deferred();
  const old = h.ctx.pollStatus(); h.requests.at(-1).resolveHeaders(body.promise);
  await settle(); await acceptedStart(h);
  body.resolve(h.status()); await old;
  expectBusy(h);
});

test('a poll paused in dependent summary work cannot finalize a newer scan', async () => {
  const h = harness(), summary = deferred();
  h.ctx.updateStatusIndicator(h.status(true)); h.ctx.state.wasPollingBusy = true;
  h.ctx.state.utility.loaded = true;
  h.ctx.loadProblematicFiles = () => summary.promise;
  const old = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(false, { watcher_health: { state: 'warning' } }));
  await settle();
  assert.equal(h.ctx.state.status.scan_in_progress, false);
  await acceptedStart(h);
  summary.resolve([]); await old;
  expectBusy(h);
  assert.equal(h.ctx.state.wasPollingBusy, true);
  assert.equal(h.toasts.some(x => x.message === 'Library scan complete.'), false);
});

test('a rejected start leaves a retry usable and the accepted retry busy', async () => {
  const h = harness();
  const rejected = h.ctx.triggerLibraryRefresh(true);
  h.requests.at(-1).resolve({ ok: false, error: 'Service unavailable' }, 503);
  assert.equal(await rejected, false);
  assert.equal(h.ctx.state.status.scan_in_progress, false);
  await acceptedStart(h);
  expectBusy(h);
});

test('a genuine later completion clears busy and keeps status polling alive', async () => {
  const h = harness();
  await acceptedStart(h);
  const complete = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(false, { scan_generation: 2, scan_outcome: 'completed' }));
  await complete;
  assert.equal(h.ctx.state.status.scan_in_progress, false);
  assert.equal(h.primary.getAttribute('data-status-action'), 'full-rescan');
  assert.equal(h.toasts.filter(x => x.message === 'Library scan complete.').length, 1);
  assert.equal(h.timers.size, 1);
});

test('independent status triggers do not retain multiple future polling chains', async () => {
  const h = harness();
  const first = h.ctx.pollStatus(), firstRequest = h.requests.at(-1);
  const second = h.ctx.pollStatus(), secondRequest = h.requests.at(-1);
  firstRequest.resolve(h.status()); secondRequest.resolve(h.status());
  await Promise.all([first, second]);
  assert.equal(h.timers.size, 1);
});


test('an older status grant cannot replace a newer capability revocation', async () => {
  const h = harness();
  const older = h.ctx.pollStatus(), olderRequest = h.requests.at(-1);
  const newer = h.ctx.pollStatus(), newerRequest = h.requests.at(-1);
  newerRequest.resolve(h.status(true, { allowed_actions: {} })); await newer;
  assert.equal(h.ctx.state.loopCreateAllowed, false);
  olderRequest.resolve(h.status(false)); await older;
  assert.equal(h.ctx.state.loopCreateAllowed, false);
});

test('a transport-failed poll keeps a future real status read available', async () => {
  const h = harness();
  const failed = h.ctx.pollStatus();
  h.requests.at(-1).reject(new Error('Status transport failed')); await failed;
  const entry = [...h.timers.entries()][0];
  assert.ok(entry, 'a failed observation must retain the polling continuation');
  assert.equal(entry[1].delay, 3000);
  h.timers.delete(entry[0]);
  const next = entry[1].callback();
  h.requests.at(-1).resolve(h.status(true)); await next;
  expectBusy(h);
  assert.equal(h.timers.size, 1);
});

test('idle observations cannot clear pending startup before HTTP acceptance', async () => {
  const h = harness();
  const starting = h.ctx.triggerLibraryRefresh(true), startRequest = h.requests.at(-1);
  const pendingRead = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status()); await pendingRead;
  expectBusy(h);
  startRequest.resolve({ ok: true }); await starting;
  expectBusy(h);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [100]);
});

test('a running read taken before cancellation acknowledgement cannot resurrect the cancelled scan', async () => {
  const h = harness();
  h.ctx.updateStatusIndicator(h.status(true));
  const cancelling = h.ctx.cancelLibraryScan(), cancelRequest = h.requests.at(-1);
  const pendingRead = h.ctx.pollStatus(), readRequest = h.requests.at(-1);
  cancelRequest.resolve({ ok: true, cancelled: true }); await cancelling;
  readRequest.resolve(h.status(true)); await pendingRead;
  assert.equal(h.ctx.state.status.scan_in_progress, false);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [150]);
});

test('an obsolete cancel finally cannot clear a newer cancellation pending flag', async () => {
  const h = harness();
  h.ctx.updateStatusIndicator(h.status(true));
  const oldCancel = h.ctx.cancelLibraryScan(), oldRequest = h.requests.at(-1);
  const idleRead = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(false, { scan_outcome: 'cancelled' })); await idleRead;
  await acceptedStart(h);
  const newCancel = h.ctx.cancelLibraryScan(), newRequest = h.requests.at(-1);
  oldRequest.resolve({ ok: true, cancelled: true }); await oldCancel;
  assert.equal(h.ctx.state.ui.scanCancellationPending, true);
  newRequest.resolve({ ok: true, cancelled: true }); await newCancel;
  assert.equal(h.ctx.state.ui.scanCancellationPending, false);
  assert.equal(h.toasts.filter(toast => /cancelled/.test(toast.message)).length, 1);
});

test('a stale poll transport error cannot replace the newer poll continuation', async () => {
  const h = harness();
  const older = h.ctx.pollStatus(), olderRequest = h.requests.at(-1);
  const newer = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(true)); await newer;
  const timer = [...h.timers.entries()];
  olderRequest.reject(new Error('Obsolete read failure')); await older;
  assert.deepEqual([...h.timers.entries()], timer);
  expectBusy(h);
});

test('rejected startup invalidates pending reads while preserving recovery polling', async () => {
  const h = harness();
  const starting = h.ctx.triggerLibraryRefresh(true), startRequest = h.requests.at(-1);
  const pendingRead = h.ctx.pollStatus(), readRequest = h.requests.at(-1);
  startRequest.reject(new Error('Unable to reach server')); await starting;
  readRequest.resolve(h.status(true)); await pendingRead;
  assert.equal(h.ctx.state.status.scan_in_progress, false);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [3000]);
  await acceptedStart(h);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [250]);
});

for (const outcome of ['success', 'failure']) {
  test(`a completion refresh ${outcome} cannot report completion after a new scan starts`, async () => {
    const h = harness(), refresh = deferred();
    h.ctx.updateStatusIndicator(h.status(true)); h.ctx.state.wasPollingBusy = true;
    h.ctx.refreshCurrentViewAfterBackgroundCompletion = () => refresh.promise;
    const completing = h.ctx.pollStatus();
    h.requests.at(-1).resolve(h.status(false, { scan_outcome: 'completed' }));
    await settle(); await acceptedStart(h);
    if (outcome === 'success') refresh.resolve(true);
    else refresh.reject(new Error('Obsolete refresh failure'));
    await completing;
    expectBusy(h);
    assert.equal(h.toasts.some(toast => toast.message === 'Library scan complete.'), false);
    assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [250]);
  });
}

test('an old foreground-idle wait cannot replace a new scan start poll', async () => {
  const h = harness(), idle = deferred();
  h.ctx.galleryCoverLoadScheduler = { isForegroundIdle: () => false, whenForegroundIdle: () => idle.promise };
  const waiting = h.ctx.pollStatus();
  await acceptedStart(h);
  idle.resolve(); await waiting;
  expectBusy(h);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [250]);
});

test('current observations retain the existing idle, busy, and visible-menu cadences', async () => {
  const h = harness();
  for (const [busy, menuHidden, expectedDelay] of [[false, true, 3000], [true, true, 1000], [true, false, 100]]) {
    h.menu.hidden = menuHidden;
    const reading = h.ctx.pollStatus();
    h.requests.at(-1).resolve(h.status(busy)); await reading;
    assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [expectedDelay]);
  }
});

test('a queued completion retry is cancelled by the next intent and cannot stall its finalizing refresh', async () => {
  const h = harness();
  h.ctx.updateStatusIndicator(h.status(true)); h.ctx.state.wasPollingBusy = true;
  h.ctx.refreshCurrentViewAfterBackgroundCompletion = async () => false;
  const completed = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(false, { scan_outcome: 'completed' })); await completed;
  assert.equal(h.ctx.state.ui.pendingScanCompletionViewRefreshRetryScheduled, true);
  const oldRetry = [...h.timers.values()].find(timer => timer.delay === 1000);
  assert.ok(oldRetry);
  await acceptedStart(h);
  assert.equal(h.ctx.state.ui.pendingScanCompletionViewRefreshRetryScheduled, false);
  h.ctx.refreshCurrentViewAfterBackgroundCompletion = async () => { h.refreshes.push('new scan'); return true; };
  oldRetry.callback();
  assert.equal(h.refreshes.length, 0);
  const finalizing = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(true, { scan_phase: 'finalizing' })); await finalizing;
  assert.deepEqual(h.refreshes, ['new scan']);
});

test('an obsolete cover-completion refresh cannot enqueue a retry for a newer scan', async () => {
  const h = harness(), refresh = deferred();
  h.ctx.state.wasCoverPollingBusy = true;
  h.ctx.state.view.query = 'selected album';
  h.ctx.refreshCurrentViewAfterBackgroundCompletion = () => refresh.promise;
  const completing = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status()); await settle();
  await acceptedStart(h);
  refresh.reject(new Error('Obsolete cover refresh failure')); await completing;
  expectBusy(h);
  assert.equal(h.toasts.some(toast => toast.message === 'Album covers updated.'), false);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [250]);
});

test('a cancellation body delivered after a new start cannot clear its busy state', async () => {
  const h = harness(), body = deferred();
  h.ctx.updateStatusIndicator(h.status(true));
  const cancelling = h.ctx.cancelLibraryScan();
  h.requests.at(-1).resolveHeaders(body.promise); await settle();
  const idle = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(false, { scan_outcome: 'cancelled' })); await idle;
  await acceptedStart(h);
  body.resolve({ ok: true, cancelled: true }); await cancelling;
  expectBusy(h);
  assert.equal(h.ctx.state.ui.scanCancellationPending, false);
});

test('a start body delivered after cancellation cannot resurrect the old scan', async () => {
  const h = harness(), body = deferred();
  const starting = h.ctx.triggerLibraryRefresh(true);
  h.requests.at(-1).resolveHeaders(body.promise); await settle();
  const cancelling = h.ctx.cancelLibraryScan();
  h.requests.at(-1).resolve({ ok: true, cancelled: true }); await cancelling;
  body.resolve({ ok: true, full_rescan: true }); await starting;
  assert.equal(h.ctx.state.status.scan_in_progress, false);
  assert.equal(h.toasts.some(toast => toast.message === 'Library scan started.'), false);
});

for (const action of ['start', 'cancel']) {
  for (const result of ['status', 'error']) {
    test(`an ordinary ${result} callback preserves the earlier ${action} acknowledgement poll deadline`, async () => {
      const h = harness();
      if (action === 'start') {
        await acceptedStart(h);
      } else {
        h.ctx.updateStatusIndicator(h.status(true));
        const cancelling = h.ctx.cancelLibraryScan();
        h.requests.at(-1).resolve({ ok: true, cancelled: true }); await cancelling;
      }
      const [urgentId, urgent] = [...h.timers.entries()][0];
      assert.equal(urgent.delay, action === 'start' ? 250 : 150);
      h.advance(50);
      const ordinary = h.ctx.pollStatus();
      if (result === 'error') h.requests.at(-1).reject(new Error('Current read failed'));
      else h.requests.at(-1).resolve(h.status(false, { scan_outcome: action === 'cancel' ? 'cancelled' : 'completed' }));
      await ordinary;
      assert.equal(h.timers.size, 1);
      assert.equal(h.timers.get(urgentId), urgent);
      const next = h.runTimer(urgentId);
      h.requests.at(-1).resolve(h.status()); await next;
      assert.equal(h.timers.size, 1);
      assert.equal([...h.timers.values()][0].delay, 3000);
    });
  }
}

for (const result of ['success', 'error']) {
  test(`a superseded cover cancellation ${result} cannot replace a newer library scan`, async () => {
    const h = harness();
    h.ctx.updateStatusIndicator(h.status(false, { covers_in_progress: true }));
    const cancelling = h.ctx.cancelAlbumCoverScan(), request = h.requests.at(-1);
    await acceptedStart(h);
    if (result === 'success') request.resolve({ ok: true, cancelled: true });
    else request.reject(new Error('Cover cancellation failed'));
    await cancelling;
    expectBusy(h);
    if (result === 'error') assert.equal(h.toasts.some(toast => toast.message === 'Cover cancellation failed'), true);
  });
}

for (const result of ['success', 'error']) {
  test(`a superseded bulk cover start ${result} cannot replace a newer library scan`, async () => {
    const h = harness();
    const covers = h.ctx.fetchUnsuccessfulAlbumCovers(), request = h.requests.at(-1);
    const cancelling = h.ctx.cancelAlbumCoverScan();
    h.requests.at(-1).resolve({ ok: true, cancelled: true }); await cancelling;
    await acceptedStart(h);
    if (result === 'success') request.resolve({ ok: true, queued_after_indexing: true });
    else request.reject(new Error('Bulk cover start failed'));
    await covers;
    expectBusy(h);
    assert.equal(h.ctx.state.status.covers_in_progress, false);
    if (result === 'error') assert.equal(h.toasts.some(toast => toast.message === 'Bulk cover start failed'), true);
  });
}

function enableLibrarySettings(h) {
  h.ctx.state.utility.activeTab = 'integrations';
  h.ctx.state.utility.selectedIntegrationKey = 'library';
  h.ctx.ensureLibrarySettingsState().allowedActions = { 'library.settings.manage': true };
}

test('superseded library settings save retains saved values without publishing its old status', async () => {
  const h = harness();
  enableLibrarySettings(h);
  const saving = h.ctx.saveUtilityLibrarySettings(), request = h.requests.at(-1);
  await acceptedStart(h);
  request.resolve({ ok: true, settings: { version: 7 }, status: h.status() });
  assert.equal(await saving, true);
  expectBusy(h);
  assert.equal(h.ctx.state.utility.librarySettings.settings.version, 7);
  assert.equal(h.ctx.state.utility.librarySettings.saveBusy, false);
  assert.equal(h.toasts.some(toast => toast.message === 'Library settings saved. Scan started.'), true);
});

test('current library settings save rejects pre-acceptance idle reads and publishes its scan status', async () => {
  const h = harness();
  enableLibrarySettings(h);
  const saving = h.ctx.saveUtilityLibrarySettings(), request = h.requests.at(-1);
  const old = h.ctx.pollStatus(), oldRequest = h.requests.at(-1);
  request.resolve({ ok: true, settings: {}, status: h.status(true) }); await saving;
  oldRequest.resolve(h.status()); await old;
  expectBusy(h);
  assert.deepEqual([...h.timers.values()].map(timer => timer.delay), [250]);
});

test('rejected library settings save releases status reads and retains its legitimate error', async () => {
  const h = harness();
  enableLibrarySettings(h);
  const saving = h.ctx.saveUtilityLibrarySettings();
  h.requests.at(-1).reject(new Error('Settings save failed'));
  assert.equal(await saving, false);
  assert.equal(h.ctx.state.utility.librarySettings.saveBusy, false);
  assert.equal(h.ctx.state.utility.librarySettings.error, 'Settings save failed');
  const fresh = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(true)); await fresh;
  expectBusy(h);
});

for (const outcome of ['success', 'failure']) {
  test(`repeated idle observations share one completion refresh through ${outcome}`, async () => {
    const h = harness(), refresh = deferred();
    h.ctx.updateStatusIndicator(h.status(true)); h.ctx.state.wasPollingBusy = true;
    let refreshCount = 0;
    h.ctx.refreshCurrentViewAfterBackgroundCompletion = () => { refreshCount++; return refresh.promise; };
    const polls = [];
    for (let index = 0; index < 4; index++) {
      polls.push(h.ctx.pollStatus());
      h.requests.at(-1).resolve(h.status(false, { scan_outcome: 'completed' }));
      await settle();
    }
    assert.equal(refreshCount, 1);
    if (outcome === 'success') refresh.resolve(true);
    else refresh.reject(new Error('Current refresh failed'));
    await Promise.all(polls);
    assert.equal(h.toasts.filter(toast => toast.message === 'Library scan complete.').length, 1);
    assert.equal(h.ctx.state.wasPollingBusy, false);
    assert.equal(h.ctx.state.ui.pendingScanCompletionViewRefreshPromise, null);
    assert.equal(h.ctx.state.ui.pendingScanCompletionViewRefreshRetryScheduled, outcome === 'failure');
    assert.equal(h.timers.size, outcome === 'failure' ? 2 : 1);
  });
}

for (const successor of ['covers', 'settings']) {
  test(`a ${successor} action retires a superseded library cancellation flag and leaves cancellation usable`, async () => {
    const h = harness();
    h.ctx.updateStatusIndicator(h.status(true));
    const cancelling = h.ctx.cancelLibraryScan(), oldRequest = h.requests.at(-1);
    assert.equal(h.ctx.state.ui.scanCancellationPending, true);
    if (successor === 'settings') enableLibrarySettings(h);
    const nextAction = successor === 'covers'
      ? h.ctx.fetchUnsuccessfulAlbumCovers()
      : h.ctx.saveUtilityLibrarySettings();
    assert.equal(h.ctx.state.ui.scanCancellationPending, false);
    h.requests.at(-1).resolve(successor === 'covers'
      ? { ok: true, queued_after_indexing: true }
      : { ok: true, settings: {}, status: h.status(true) });
    await nextAction;
    oldRequest.resolve({ ok: true, cancelled: true }); await cancelling;
    expectBusy(h);
    assert.equal(h.ctx.state.ui.scanCancellationPending, false);
    assert.equal(h.renders.at(-1).scan_in_progress, true);
    const retry = h.ctx.cancelLibraryScan();
    assert.equal(h.requests.at(-1).url, '/cancel-refresh-api');
    assert.equal(h.ctx.state.ui.scanCancellationPending, true);
    h.requests.at(-1).resolve({ ok: true, cancelled: true }); await retry;
    assert.equal(h.ctx.state.ui.scanCancellationPending, false);
  });
}

test('overlapping scan and cover completion observations each report once', async () => {
  const h = harness(), coverRefresh = deferred();
  h.ctx.state.wasPollingBusy = true;
  h.ctx.state.wasCoverPollingBusy = true;
  h.ctx.state.view.query = 'selected album';
  let refreshes = 0;
  h.ctx.refreshCurrentViewAfterBackgroundCompletion = () => ++refreshes === 1 ? Promise.resolve(true) : coverRefresh.promise;
  const older = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(false, { scan_outcome: 'completed' })); await settle();
  const newer = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(false, { scan_outcome: 'completed' })); await settle();
  coverRefresh.resolve(true);
  await Promise.all([older, newer]);
  assert.equal(h.toasts.filter(toast => toast.message === 'Library scan complete.').length, 1);
  assert.equal(h.toasts.filter(toast => toast.message === 'Album covers updated.').length, 1);
  assert.equal(refreshes, 2);
});

test('cover cancellation rollback cannot replace a newer observed status or capability revocation', async () => {
  const h = harness();
  h.ctx.updateStatusIndicator(h.status(false, { covers_in_progress: true }));
  const cancelling = h.ctx.cancelAlbumCoverScan(), cancelRequest = h.requests.at(-1);
  const fresh = h.ctx.pollStatus();
  h.requests.at(-1).resolve(h.status(true, { allowed_actions: {} })); await fresh;
  cancelRequest.reject(new Error('Cover cancellation failed')); await cancelling;
  expectBusy(h);
  assert.equal(h.ctx.state.loopCreateAllowed, false);
});

for (const kind of ['scan', 'covers']) {
  test(`an unrelated failed read preserves in-flight ${kind} completion sharing`, async () => {
    const h = harness(), refresh = deferred();
    h.ctx.state.wasPollingBusy = kind === 'scan';
    h.ctx.state.wasCoverPollingBusy = kind === 'covers';
    h.ctx.state.view.query = 'selected album';
    let refreshCount = 0;
    h.ctx.refreshCurrentViewAfterBackgroundCompletion = () => { refreshCount++; return refresh.promise; };
    const older = h.ctx.pollStatus();
    h.requests.at(-1).resolve(h.status()); await settle();
    const failed = h.ctx.pollStatus();
    h.requests.at(-1).reject(new Error('Unrelated status transport failed')); await failed;
    const newer = h.ctx.pollStatus();
    h.requests.at(-1).resolve(h.status()); await settle();
    assert.equal(refreshCount, 1);
    refresh.resolve(true); await Promise.all([older, newer]);
    const message = kind === 'scan' ? 'Library scan complete.' : 'Album covers updated.';
    assert.equal(h.toasts.filter(toast => toast.message === message).length, 1);
    assert.equal(h.timers.size, 1);
  });
}

for (const kind of ['scan', 'covers']) {
  test(`a newer observed ${kind} operation invalidates older terminal retries`, async () => {
    const h = harness(), refresh = deferred();
    h.ctx.state.wasPollingBusy = kind === 'scan';
    h.ctx.state.wasCoverPollingBusy = kind === 'covers';
    h.ctx.state.view.query = 'selected album';
    h.ctx.refreshCurrentViewAfterBackgroundCompletion = () => refresh.promise;
    const older = h.ctx.pollStatus();
    h.requests.at(-1).resolve(h.status()); await settle();
    const newer = h.ctx.pollStatus();
    h.requests.at(-1).resolve(h.status(kind === 'scan', { covers_in_progress: kind === 'covers', scan_generation: 5 }));
    await newer;
    refresh.reject(new Error('Older terminal refresh failed')); await older;
    assert.equal(h.timers.size, 1);
    assert.equal(h.toasts.some(toast => /complete|updated/.test(toast.message)), false);
  });
}
