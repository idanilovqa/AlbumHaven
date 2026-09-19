const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'notification-ui-helpers.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');
const baseLayoutPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'css',
  'runtime',
  'base-layout.css',
);
const runtimeCssDirectory = path.dirname(baseLayoutPath);
const baseLayoutSource = fs.readFileSync(baseLayoutPath, 'utf8');
const indexTemplateSource = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'music_app', 'templates', 'index.html'),
  'utf8',
);
const coverLookupModalSource = fs.readFileSync(
  path.join(runtimeCssDirectory, 'cover-lookup-modal.css'),
  'utf8',
);
const coverLookupActionsSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'e2e', 'actions', 'coverLookupActions.js'),
  'utf8',
);
const coverLookupPomSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'e2e', 'poms', 'coverLookup.js'),
  'utf8',
);
const coverLookupSpecSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'e2e', 'specs', 'coverLookup.spec.js'),
  'utf8',
);

function createContext(storage = new Map()) {
  const toasts = [];
  const scheduledTimeouts = [];
  const layer = {
    appendChild(toast) {
      toasts.push(toast);
      toast.parentElement = layer;
    },
  };
  const context = {
    window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, ButtonComponent: { renderButton: config => `<button>${config.label}</button>` } },
    document: {
      createElement() {
        const toast = {
          className: '',
          classList: {
            add() {},
            remove() {},
          },
          innerHTML: '',
          addEventListener(type, callback) { this[type] = callback; },
          parentElement: null,
          remove() {
            const index = toasts.indexOf(toast);
            if (index >= 0) toasts.splice(index, 1);
            toast.parentElement = null;
          },
        };
        return toast;
      },
      getElementById(id) {
        return id === 'toast-layer' ? layer : null;
      },
    },
    scheduleBrowserAnimationFrame() {},
    scheduleBrowserTimeout(callback, duration) {
      scheduledTimeouts.push({ callback, duration });
      return scheduledTimeouts.length;
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, scheduledTimeouts, toasts };
}

test('floating notification placement preserves a clear preferred corner', () => {
  const { context } = createContext();
  const result = context.findClearNotificationPosition({ width: 200, height: 100 }, { left: 784, top: 688 },
    { left: 0, top: 0, right: 1000, bottom: 800 }, [{ left: 20, top: 20, right: 120, bottom: 60 }]);
  assert.equal(result.left, 784);
  assert.equal(result.top, 688);
});

test('floating notification placement shifts the whole alert clear of Save and another notification', () => {
  const { context } = createContext();
  const obstacles = [
    { left: 800, top: 680, right: 960, bottom: 750 },
    { left: 784, top: 572, right: 984, bottom: 672 },
  ];
  const result = context.findClearNotificationPosition({ width: 200, height: 100 }, { left: 784, top: 688 },
    { left: 0, top: 0, right: 1000, bottom: 800 }, obstacles);
  assert.ok(result);
  for (const rect of obstacles) assert.ok(result.left + 200 <= rect.left - 8 || result.left >= rect.right + 8
    || result.top + 100 <= rect.top - 8 || result.top >= rect.bottom + 8);
});

test('floating notification placement respects a panned narrow visual viewport', () => {
  const { context } = createContext();
  const result = context.findClearNotificationPosition({ width: 240, height: 110 }, { left: 1000, top: 1000 },
    { left: 50, top: 100, right: 350, bottom: 500 }, []);
  assert.equal(result.left, 102);
  assert.equal(result.top, 382);
});

test('floating notifications defer when the viewport has no unobstructed rectangle', () => {
  const { context } = createContext();
  const viewport = { left: 0, top: 0, right: 300, bottom: 200 };
  assert.equal(context.findClearNotificationPosition({ width: 240, height: 100 }, { left: 44, top: 88 }, viewport, [viewport]), null);
  assert.equal(context.findClearNotificationPosition({ width: 301, height: 100 }, { left: 0, top: 0 }, viewport, []), null);
});

test('notification owner ignores occluded background controls, retries deferred placement, and disposes observers', () => {
  const { context } = createContext();
  const callbacks = [], styles = new Map(), attributes = new Set(), listeners = new Set();
  let mutations, resizes, disconnected = 0, shown = 0, occupied = true, intrinsicWidth = 240;
  const listen = (_name, callback) => listeners.add(callback);
  const unlisten = (_name, callback) => listeners.delete(callback);
  const rect = { left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 };
  const control = { matches: () => false, closest: () => null, contains: node => node === control, getBoundingClientRect: () => rect };
  const background = { ...control, contains: node => node === background };
  const node = {
    isConnected: true, hidden: false, offsetHeight: 100,
    get offsetWidth() { return Math.min(intrinsicWidth, parseFloat(styles.get('--notification-available-width')) || intrinsicWidth); },
    getBoundingClientRect: () => ({ ...rect, width: 240, height: 100 }), contains: candidate => candidate === node,
    classList: { add() {}, remove() {} }, setAttribute: key => attributes.add(key), removeAttribute: key => attributes.delete(key),
    style: { getPropertyValue: key => styles.get(key), setProperty: (key, value) => styles.set(key, value) },
  };
  Object.assign(context.window, { innerWidth: 300, innerHeight: 200, addEventListener: listen, removeEventListener: unlisten });
  Object.assign(context.document, {
    body: {}, documentElement: {}, addEventListener: listen, removeEventListener: unlisten,
    querySelectorAll: selector => {
      assert.match(selector, /\[data-loop-range-surface\]/u, 'the pointer-driven waveform is an actionable obstacle');
      assert.match(selector, /\[tabindex\]:not\(\[tabindex="-1"\]\)/u);
      return occupied ? [control, background] : [background];
    },
    elementsFromPoint: () => occupied ? [control] : [context.document.body],
  });
  Object.assign(context, {
    requestAnimationFrame: callback => { callbacks.push(callback); return callbacks.length; }, cancelAnimationFrame() {},
    getComputedStyle: () => ({ visibility: 'visible', opacity: '1', getPropertyValue: () => '0px' }),
    MutationObserver: class { constructor(callback) { mutations = callback; } observe() {} disconnect() { disconnected++; } },
    ResizeObserver: class { constructor(callback) { resizes = callback; } observe() {} unobserve() {} disconnect() { disconnected++; } },
  });
  context.registerFloatingNotification(node, { origin: 'bottom-right', onPlaced: () => shown++ });
  callbacks.shift()();
  assert.equal(shown, 0, 'a deferred notification must not start its lifetime');
  assert.equal(attributes.has('data-notification-deferred'), true);
  occupied = false;
  mutations([{ target: context.document.body }]);
  callbacks.shift()();
  assert.equal(shown, 1, 'occluded background controls must not suppress the notification');
  assert.equal(attributes.has('data-notification-deferred'), false);
  resizes();
  callbacks.shift()();
  assert.equal(shown, 1, 'layout changes must not restart its lifetime');
  intrinsicWidth = 358;
  context.window.visualViewport = { offsetLeft: 50, offsetTop: 0, width: 195, height: 200 };
  resizes();
  callbacks.shift()();
  assert.equal(styles.get('--notification-available-width'), '179px');
  assert.equal(node.offsetWidth, 179, 'the host must apply the visual width before reading notification geometry');
  assert.equal(attributes.has('data-notification-deferred'), false);
  assert.match(baseLayoutSource, /min-width:\s*min\(280px, var\(--notification-available-width\)\)/u);
  context.unregisterFloatingNotification(node);
  assert.equal(disconnected, 2);
  assert.equal(listeners.size, 0);
});

test('watcher warning uses one shared global alert, survives partial status, and clears on recovery', () => {
  const { context, toasts } = createContext();
  const configurations = [];
  context.buildOnPageAlertHtml = config => { configurations.push(config); return '<section role="alert">Warning</section>'; };
  const warning = { watcher_health: { state: 'warning', problems: [{ root_key: 'private-root', message: 'private-path' }] } };
  context.syncLibraryWatcherWarning(warning);
  const mounted = toasts[0];
  context.syncLibraryWatcherWarning(warning);
  context.syncLibraryWatcherWarning({ scan_in_progress: true });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0], mounted);
  assert.equal(mounted.className, 'system-warning-notification');
  assert.equal(configurations.length, 1);
  assert.equal(configurations[0].severity, 'warning');
  assert.match(configurations[0].actionsHtml, /Dismiss/);
  assert.match(configurations[0].actionsHtml, /Go to Library page/);
  assert.doesNotMatch(JSON.stringify(configurations), /private-root|private-path/);
  context.syncLibraryWatcherWarning({ watcher_health: { state: 'healthy', problems: [] } });
  assert.equal(toasts.length, 0);
  context.syncLibraryWatcherWarning(warning);
  assert.equal(toasts.length, 1);
  toasts[0].click({ target: { closest: selector => selector === '[data-watcher-dismiss]' } });
  assert.equal(toasts.length, 0);
  context.syncLibraryWatcherWarning(warning);
  assert.equal(toasts.length, 0, 'polling must not reopen a dismissed warning');
});

for (const action of ['[data-watcher-dismiss]', '[data-watcher-library]']) {
  test(`${action} persists dismissal across reloads and health transitions`, () => {
    const storage = new Map();
    const first = createContext(storage);
    first.context.buildOnPageAlertHtml = () => 'Warning';
    first.context.closeUtilityModal = () => {};
    first.context.openScanPage = () => {};
    const warning = { watcher_health: { state: 'warning', problems: [] } };
    first.context.syncLibraryWatcherWarning(warning);
    first.toasts[0].click({ target: { closest: selector => selector === action } });
    const reloaded = createContext(storage);
    reloaded.context.buildOnPageAlertHtml = () => 'Warning';
    reloaded.context.syncLibraryWatcherWarning({ watcher_health: { state: 'healthy', problems: [] } });
    reloaded.context.syncLibraryWatcherWarning(warning);
    assert.equal(reloaded.toasts.length, 0);
  });
}

test('Go to Library dismisses the watcher alert and opens Scan Library', () => {
  const { context, toasts } = createContext();
  const actions = [];
  context.buildOnPageAlertHtml = () => '<section>Warning</section>';
  context.closeUtilityModal = () => actions.push('close');
  context.openScanPage = () => actions.push('scan');
  const warning = { watcher_health: { state: 'warning', problems: [] } };
  context.syncLibraryWatcherWarning(warning);
  toasts[0].click({ target: { closest: selector => selector === '[data-watcher-library]' } });
  assert.deepEqual(actions, ['close', 'scan']);
  assert.equal(toasts.length, 0);
  context.syncLibraryWatcherWarning(warning);
  assert.equal(toasts.length, 0, 'polling must not reopen the dismissed alert');
});

test('toast placement is opt-in for the cover lookup start notification', () => {
  const { context, toasts } = createContext();

  context.showToast('Default toast');
  context.showToast(
    'Cover art lookup started.',
    'success',
    2200,
    { placement: 'top-center' },
  );

  assert.equal(toasts[0].className, 'toast');
  assert.equal(toasts[1].className, 'toast is-top-center');
});

test('simultaneous identical error toasts coalesce while distinct errors remain visible', () => {
  const { context, toasts } = createContext();

  context.showToast('Unable to load the selected problematic album.', 'error', 3200);
  context.showToast('Unable to load the selected problematic album.', 'error', 3200);
  context.showToast('Unable to load problematic files.', 'error', 3200);

  assert.deepEqual(
    toasts.map((toast) => toast.innerHTML),
    [
      'Unable to load the selected problematic album.',
      'Unable to load problematic files.',
    ],
  );
});

test('an identical error can appear after its prior toast is removed', () => {
  const { context, scheduledTimeouts, toasts } = createContext();

  context.showToast('Unable to load the selected problematic album.', 'error', 3200);
  scheduledTimeouts.shift().callback();
  scheduledTimeouts.shift().callback();
  assert.equal(toasts.length, 0);

  context.showToast('Unable to load the selected problematic album.', 'error', 3200);

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].innerHTML, 'Unable to load the selected problematic album.');
});

test('global toast layer stays noninteractive and above every other runtime CSS layer', () => {
  const toastLayerRule = baseLayoutSource.match(/\.toast-layer\s*\{([^}]*)\}/u)?.[1] || '';
  const toastLayerZIndex = Number(
    toastLayerRule.match(/z-index:\s*(\d+)\s*;/u)?.[1] || 0,
  );
  const runtimeCssWithoutToastLayer = fs.readdirSync(runtimeCssDirectory)
    .filter((fileName) => fileName.endsWith('.css'))
    .map((fileName) => fs.readFileSync(path.join(runtimeCssDirectory, fileName), 'utf8'))
    .join('\n')
    .replace(/\.toast-layer\s*\{[^}]*\}/u, '');
  const otherLayerValues = Array.from(
    runtimeCssWithoutToastLayer.matchAll(/z-index:\s*(\d+)\s*;/gu),
    (match) => Number(match[1]),
  );
  const highestOtherLayer = Math.max(...otherLayerValues);

  assert.match(toastLayerRule, /pointer-events:\s*none\s*;/u);
  assert.match(toastLayerRule, /Global notification layer/u);
  assert.ok(
    toastLayerZIndex > highestOtherLayer,
    `Expected toast layer ${toastLayerZIndex} above runtime layer ${highestOtherLayer}.`,
  );
});

test('managed cover-start assertion proves center-point stacking above the active overlay', () => {
  assert.match(
    coverLookupActionsSource,
    /elementFromPoint\([\s\S]*underlyingStackingZIndex[\s\S]*topmostAtCenter/u,
  );
  assert.match(
    coverLookupActionsSource,
    /pointerEvents:\s*toastLayerStyle\.pointerEvents/u,
  );
  assert.match(
    coverLookupSpecSource,
    /expect\(toastPlacement\.topmostAtCenter\)\.toBe\(true\)/u,
  );
  assert.match(
    coverLookupSpecSource,
    /expect\(toastPlacement\.pointerEvents\)\.toBe\('none'\)/u,
  );
});

test('managed cover-start assertion waits for settled toast geometry and preserves modal geometry', () => {
  assert.match(
    coverLookupPomSource,
    /waitForCoverLookupStartedToastFinalState[\s\S]*classList\.contains\('is-visible'\)[\s\S]*opacity[\s\S]*getAnimations/u,
  );
  assert.match(
    coverLookupPomSource,
    /requestAnimationFrame[\s\S]*transformStable/u,
  );
  assert.match(
    coverLookupPomSource,
    /modalDialogSelector[\s\S]*modalActionsSelector/u,
  );
  assert.match(
    coverLookupActionsSource,
    /waitForCoverLookupStartedToastFinalState[\s\S]*toastOcclusionTargets[\s\S]*rectanglesIntersect/u,
  );
  assert.match(
    coverLookupActionsSource,
    /await this\.startSearch\(\);\s*const finalVisualState = await this\.coverLookup\s*\.waitForCoverLookupStartedToastFinalState\(\{ timeout \}\);\s*await expect\(this\.coverLookup\.coverLookupStartedToast\)\.toBeVisible/u,
    'finite-lived toast geometry must be captured before slower provider progress assertions',
  );
  assert.match(
    coverLookupSpecSource,
    /expect\(toastPlacement\.finalVisualState\)[\s\S]*transformStable:\s*true/u,
  );
  assert.match(
    coverLookupSpecSource,
    /expect\(toastPlacement\.modalGeometryDelta\)\.toEqual\(\{[\s\S]*height:\s*0,[\s\S]*width:\s*0,[\s\S]*x:\s*0,[\s\S]*y:\s*0/u,
  );
  assert.match(coverLookupSpecSource, /overlaps\.modalActions\)\.toBe\(false\)/u);
  assert.match(coverLookupSpecSource, /overlaps\.toolbarRight\)\.toBe\(false\)/u);
});

test('visible centered cover lookup notifications do not alter modal layout', () => {
  assert.doesNotMatch(
    coverLookupModalSource,
    /body:has\(\.toast\.is-top-center\.is-visible\)/u,
  );
  assert.doesNotMatch(
    coverLookupModalSource,
    /--cover-lookup-toast-lane:\s*\d+px/u,
  );
  assert.match(
    coverLookupModalSource,
    /\.cover-lookup-modal\s*\{[^}]*align-items:\s*center/u,
  );
  assert.match(
    coverLookupModalSource,
    /\.cover-lookup-modal-dialog\s*\{[^}]*max-height:\s*min\(90vh,\s*940px\)/u,
  );
});

function createRepairAlertContext() {
  const alertClasses = new Set();
  const scheduledAnimationFrames = [];
  const scheduledTimeouts = new Map();
  let nextTimeoutId = 1;
  const alert = {
    hidden: true,
    classList: {
      add(value) { alertClasses.add(value); },
      remove(value) { alertClasses.delete(value); },
      toggle(value, force) {
        if (force) alertClasses.add(value);
        else alertClasses.delete(value);
      },
    },
  };
  const message = { textContent: '', innerHTML: '' };
  const logHistoryLink = { hidden: true, dataset: {} };
  const context = {
    state: { repairAlertTimer: null },
    document: {
      getElementById(id) {
        if (id === 'repair-alert') return alert;
        if (id === 'repair-alert-message') return message;
        if (id === 'repair-alert-log-history') return logHistoryLink;
        return null;
      },
    },
    scheduleBrowserAnimationFrame(callback) { scheduledAnimationFrames.push(callback); },
    scheduleBrowserTimeout(callback) {
      const timeoutId = nextTimeoutId;
      nextTimeoutId += 1;
      scheduledTimeouts.set(timeoutId, callback);
      return timeoutId;
    },
    clearBrowserTimeout(timeoutId) {
      scheduledTimeouts.delete(timeoutId);
    },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context, { filename: helperPath });
  return {
    alert,
    alertClasses,
    context,
    logHistoryLink,
    message,
    runScheduledAnimationFrames() {
      const callbacks = scheduledAnimationFrames.splice(0);
      callbacks.forEach((callback) => callback());
    },
    runScheduledTimeouts() {
      const callbacks = Array.from(scheduledTimeouts.values());
      scheduledTimeouts.clear();
      callbacks.forEach((callback) => callback());
    },
    scheduledTimeoutCount() {
      return scheduledTimeouts.size;
    },
  };
}

test('repair alert auto-hide duration starts after its first visible frame', () => {
  const {
    alert,
    alertClasses,
    context,
    runScheduledAnimationFrames,
    runScheduledTimeouts,
    scheduledTimeoutCount,
  } = createRepairAlertContext();

  context.showRepairAlert('Saved.', 'success', 2000);

  assert.equal(alert.hidden, false);
  assert.equal(alertClasses.has('is-visible'), false);
  assert.equal(scheduledTimeoutCount(), 0);
  runScheduledTimeouts();
  assert.equal(alert.hidden, false);

  runScheduledAnimationFrames();
  assert.equal(alertClasses.has('is-visible'), true);
  assert.equal(scheduledTimeoutCount(), 1);
});

test('showing a repair alert cancels a pending hide finalizer', () => {
  const {
    alert,
    context,
    message,
    runScheduledTimeouts,
  } = createRepairAlertContext();

  context.showRepairAlert('First alert.', 'success', null);
  context.hideRepairAlert();
  context.showRepairAlert('Replacement alert.', 'success', null);
  runScheduledTimeouts();

  assert.equal(message.textContent, 'Replacement alert.');
  assert.equal(alert.hidden, false);
});

test('log-linked repair alert is compact, top-centered, and targets one Log History entry', () => {
  const {
    alertClasses,
    context,
    message,
    logHistoryLink,
  } = createRepairAlertContext();

  context.showRepairAlert(
    'Failed to edit tags.',
    'error',
    null,
    { logHistoryEntryId: 'tag-edit-failure-42', logHistoryLink: true },
  );

  assert.equal(message.textContent, 'Failed to edit tags.');
  assert.equal(logHistoryLink.hidden, false);
  assert.equal(logHistoryLink.dataset.logHistoryEntryId, 'tag-edit-failure-42');
  assert.equal(alertClasses.has('has-log-history-link'), true);
  assert.match(
    indexTemplateSource,
    /id="repair-alert-message"[^>]*><\/span>\s*<button[^>]*id="repair-alert-log-history"[^>]*data-open-log-history-alert="1"[^>]*>View details<\/button>/u,
  );
  assert.match(
    baseLayoutSource,
    /\.repair-alert\.has-log-history-link\s*\{[^}]*top:\s*\d+px;[^}]*left:\s*50%;[^}]*right:\s*auto;[^}]*bottom:\s*auto;[^}]*transform:\s*translate\(-50%,\s*-\d+px\);[^}]*transition:\s*opacity\s+220ms\s+ease;/u,
  );
  assert.match(
    baseLayoutSource,
    /\.repair-alert\.has-log-history-link\.is-visible\s*\{[^}]*transform:\s*translate\(-50%,\s*0\);/u,
  );

  context.showRepairAlert('Saved.', 'success');
  assert.equal(logHistoryLink.hidden, true);
  assert.equal(logHistoryLink.dataset.logHistoryEntryId, '');
  assert.equal(alertClasses.has('has-log-history-link'), false);
});

test('scan watcher health leaves stable loader DOM untouched and applies health transitions', () => {
  const { context } = createContext();
  const values = { hidden: true, innerHTML: '' };
  const writes = [];
  const host = {};
  for (const property of Object.keys(values)) {
    Object.defineProperty(host, property, {
      get: () => values[property],
      set: value => { writes.push(property); values[property] = value; },
    });
  }
  context.document.getElementById = id => id === 'library-loader-watch-health' ? host : null;
  context.buildOnPageAlertHtml = config => JSON.stringify(config);
  const warning = { watcher_health: { state: 'warning', problems: [{ state: 'root_unavailable' }] } };
  context.syncScanLibraryWatcherHealth(warning, false);
  context.syncScanLibraryWatcherHealth({}, false);
  assert.deepEqual(writes, [], 'background health updates must not mutate the hidden loader');
  context.syncScanLibraryWatcherHealth({}, true);
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /became unavailable/);
  writes.length = 0;
  context.syncScanLibraryWatcherHealth({}, true);
  assert.deepEqual(writes, [], 'unchanged visible warning must retain its DOM');
  context.syncScanLibraryWatcherHealth({ watcher_health: { state: 'healthy', problems: [] } }, true);
  assert.equal(host.hidden, true);
  assert.equal(host.innerHTML, '');
  writes.length = 0;
  context.syncScanLibraryWatcherHealth({}, true);
  assert.deepEqual(writes, [], 'unchanged recovery state must retain its DOM');
});
