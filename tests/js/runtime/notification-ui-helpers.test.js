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
const alertSource = fs.readFileSync(path.join(path.dirname(helperPath), 'alert-components.js'), 'utf8');
const ButtonComponent = require('../../../music_app/static/js/button-component.js');
const warningHelperPath = path.join(path.dirname(helperPath), 'library-warning-ui.js');
const warningHelperSource = fs.readFileSync(warningHelperPath, 'utf8');
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
  const requests = [];
  const scanNotice = { hidden: true, innerHTML: '' };
  const loader = { scanPageVisible: false, classList: { contains: () => loader.scanPageVisible } };
  const layer = {
    appendChild(toast) {
      toasts.push(toast);
      toast.parentElement = layer;
    },
  };
  const context = {
    state: { ui: { dismissedLibraryWarningToken: '' }, status: {} },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return { ok: true, status: 200, json: async () => ({ dismissed_token: JSON.parse(options.body).token }) };
    },
    buildOnPageAlertHtml: config => JSON.stringify(config),
    window: { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, ButtonComponent: { renderButton: config => `<button>${config.label}</button>` } },
    document: {
      createElement() {
        const toast = {
          dataset: {},
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
        return id === 'toast-layer' ? layer : id === 'library-scan-warning' ? scanNotice
          : id === 'library-loader' ? loader : null;
      },
    },
    scheduleBrowserAnimationFrame() {},
    scheduleBrowserTimeout(callback, duration) {
      scheduledTimeouts.push({ callback, duration });
      return scheduledTimeouts.length;
    },
  };
  context.ButtonComponent = context.window.ButtonComponent;
  vm.createContext(context);
  vm.runInContext(alertSource, context, { filename: 'alert-components.js' });
  vm.runInContext(warningHelperSource, context, { filename: warningHelperPath });
  vm.runInContext(helperSource, context, { filename: helperPath });
  return { context, scheduledTimeouts, toasts, requests, scanNotice, loader };
}

const firstWarningToken = 'a'.repeat(64);
const nextWarningToken = 'b'.repeat(64);
function watcherWarning(token = firstWarningToken, dismissed = false) {
  return { watcher_health: { state: 'warning', warning_token: token, dismissed,
    problems: [{ state: 'root_unavailable', allowed_actions: { 'library.refresh': true } }] } };
}
function warningButton(toast) {
  const token = toast.dataset.warningToken;
  const button = { disabled: false,
    getAttribute: name => name === 'data-warning-token' ? token : null };
  return button;
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

test('watcher warning uses one shared global alert, survives partial status, and clears on recovery', async () => {
  const { context, toasts } = createContext();
  const configurations = [];
  context.buildOnPageAlertHtml = config => { configurations.push(config); return '<section role="alert">Warning</section>'; };
  const warning = watcherWarning();
  warning.watcher_health.problems[0].root_key = 'private-root';
  warning.watcher_health.problems[0].message = 'private-path';
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
  assert.equal(await context.dismissLibraryWatcherWarning(warningButton(toasts[0])), true);
  assert.equal(toasts.length, 0);
  context.syncLibraryWatcherWarning(warning);
  assert.equal(toasts.length, 0, 'polling must not reopen a dismissed warning');
});

test('dismissal persists the displayed token and leaves recovery notice only on Library', async () => {
  const { context, toasts, requests, scanNotice, loader } = createContext();
  const warning = watcherWarning();
  context.state.status = warning;
  context.syncLibraryWatcherWarning(warning);
  context.syncScanLibraryWatcherHealth(warning, true);
  assert.equal(scanNotice.hidden, true, 'the floating alert owns an unacknowledged warning');
  assert.equal(await context.dismissLibraryWatcherWarning(warningButton(toasts[0])), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/account/library-warning/dismiss');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].body), { token: firstWarningToken });
  assert.equal(context.state.ui.dismissedLibraryWarningToken, firstWarningToken);
  assert.equal(toasts.length, 0);
  context.syncScanLibraryWatcherHealth(warning, false);
  assert.equal(scanNotice.hidden, true);
  loader.scanPageVisible = true;
  context.syncScanLibraryWatcherHealth(warning, true);
  assert.equal(scanNotice.hidden, false);
  assert.match(scanNotice.innerHTML, /Full Rescan/);
  const reloaded = createContext();
  reloaded.context.syncLibraryWatcherWarning(watcherWarning(firstWarningToken, true));
  assert.equal(reloaded.toasts.length, 0, 'the server acknowledgement survives reload');
  reloaded.context.syncLibraryWatcherWarning(watcherWarning(nextWarningToken));
  assert.equal(reloaded.toasts.length, 1, 'a new warning must surface');
});

test('legacy localStorage dismissal cannot suppress current account warnings', () => {
  const storage = new Map([['album-haven.library-watcher-warning-dismissed.v1', '1']]);
  const { context, toasts } = createContext(storage);
  context.syncLibraryWatcherWarning(watcherWarning());
  assert.equal(toasts.length, 1);
});

test('tokenless view health cannot reopen an acknowledged warning or dismiss an unknown event', async () => {
  const { context, toasts, requests } = createContext();
  const tokenless = { watcher_health: { state: 'warning', problems: [{ state: 'root_unavailable' }] } };
  context.syncLibraryWatcherWarning(tokenless);
  assert.equal(toasts.length, 0, 'wait for authoritative status before mounting an actionable warning');
  assert.equal(await context.dismissLibraryWatcherWarning(), false);
  assert.equal(requests.length, 0);
  context.syncLibraryWatcherWarning(watcherWarning(firstWarningToken, true));
  context.syncLibraryWatcherWarning(tokenless);
  assert.equal(toasts.length, 0, 'unscoped view responses must retain server acknowledgement');
  context.syncLibraryWatcherWarning(watcherWarning(nextWarningToken));
  assert.equal(toasts.length, 1);
});

test('healthy recovery resets transient dismissal before a later warning', async () => {
  const { context, toasts } = createContext();
  context.syncLibraryWatcherWarning(watcherWarning());
  await context.dismissLibraryWatcherWarning(warningButton(toasts[0]));
  context.syncLibraryWatcherWarning({ watcher_health: { state: 'healthy', problems: [] } });
  assert.equal(context.state.ui.dismissedLibraryWarningToken, '');
  context.syncLibraryWatcherWarning(watcherWarning(nextWarningToken));
  assert.equal(toasts.length, 1);
});

for (const status of [409, 503, 'network']) test(`failed dismissal ${status} retains the warning`, async () => {
  const { context, toasts } = createContext();
  const errors = [];
  context.showRepairAlert = message => errors.push(message);
  context.fetch = async () => {
    if (status === 'network') throw new Error('Network unavailable');
    return { ok: false, status };
  };
  context.syncLibraryWatcherWarning(watcherWarning());
  const mounted = toasts[0], button = warningButton(mounted);
  assert.equal(await context.dismissLibraryWatcherWarning(button), false);
  assert.equal(toasts[0], mounted);
  assert.equal(button.disabled, false);
  assert.equal(context.state.ui.dismissedLibraryWarningToken, '');
  assert.equal(errors.length, 1);
});

for (const status of [200, 409]) test(`in-flight dismissal ${status} cannot hide a newer warning`, async () => {
  const { context, toasts } = createContext();
  let complete, calls = 0;
  context.showRepairAlert = () => {};
  context.fetch = () => { calls++; return new Promise(resolve => { complete = resolve; }); };
  context.syncLibraryWatcherWarning(watcherWarning());
  const button = warningButton(toasts[0]);
  const first = context.dismissLibraryWatcherWarning(button);
  const repeated = context.dismissLibraryWatcherWarning(button);
  assert.equal(calls, 1, 'duplicate clicks share the token request');
  context.syncLibraryWatcherWarning(watcherWarning(nextWarningToken));
  complete({ ok: status === 200, status, json: async () => ({ dismissed_token: firstWarningToken }) });
  await Promise.all([first, repeated]);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].dataset.warningToken, nextWarningToken);
  context.syncLibraryWatcherWarning(watcherWarning(nextWarningToken));
  assert.equal(toasts.length, 1, 'later polling must retain the new warning');
});

for (const replaceQueuedWarning of [false, true]) test(`different warning acknowledgements serialize and revalidate queued tokens (replaced=${replaceQueuedWarning})`, async () => {
  const { context, toasts } = createContext();
  const pending = [];
  context.fetch = (_url, options) => new Promise(resolve => {
    pending.push({ token: JSON.parse(options.body).token, resolve });
  });
  context.syncLibraryWatcherWarning(watcherWarning());
  const first = context.dismissLibraryWatcherWarning(warningButton(toasts[0]));
  context.syncLibraryWatcherWarning(watcherWarning(nextWarningToken));
  const second = context.dismissLibraryWatcherWarning(warningButton(toasts[0]));
  assert.equal(pending.length, 1, 'the newer acknowledgement must wait for the previous write');
  const thirdToken = 'c'.repeat(64);
  if (replaceQueuedWarning) context.syncLibraryWatcherWarning(watcherWarning(thirdToken));
  pending[0].resolve({ ok: true, status: 200 });
  assert.equal(await first, true);
  if (replaceQueuedWarning) {
    assert.equal(await second, false, 'a queued click cannot acknowledge a superseded event');
    assert.equal(pending.length, 1);
    assert.equal(toasts[0].dataset.warningToken, thirdToken);
  } else {
    assert.equal(pending.length, 2);
    assert.equal(pending[1].token, nextWarningToken);
    assert.equal(toasts[0].dataset.warningToken, nextWarningToken);
    pending[1].resolve({ ok: true, status: 200 });
    assert.equal(await second, true);
    assert.equal(toasts.length, 0);
    assert.equal(context.state.ui.dismissedLibraryWarningToken, nextWarningToken);
  }
});

test('Go to Library awaits persisted acknowledgement before opening Scan Library', async () => {
  const { context, toasts } = createContext();
  const actions = [];
  context.buildOnPageAlertHtml = () => '<section>Warning</section>';
  context.closeUtilityModal = () => actions.push('close');
  context.openScanPage = () => actions.push('scan');
  let complete;
  context.fetch = () => new Promise(resolve => { complete = resolve; });
  const warning = watcherWarning();
  context.syncLibraryWatcherWarning(warning);
  const button = warningButton(toasts[0]);
  const clicked = toasts[0].click({ target: { closest: selector => selector === '[data-watcher-library]' ? button : null } });
  assert.deepEqual(actions, []);
  complete({ ok: true, status: 200, json: async () => ({ dismissed_token: firstWarningToken }) });
  await clicked;
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
    toasts.map((toast) => toast.innerHTML.match(/class="on-page-alert__message">([^<]*)<\/p>/)?.[1]),
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
  assert.match(toasts[0].innerHTML, /Unable to load the selected problematic album\./);
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
    /waitForCoverLookupStartedToastFinalState[\s\S]*querySelector\('\.on-page-alert__message'\)[\s\S]*toastText/u,
    'toast identity must come from the message node because shared notification actions add container text',
  );
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
    ButtonComponent,
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
  vm.runInContext(alertSource, context, { filename: 'alert-components.js' });
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
  assert.match(indexTemplateSource, /id="repair-alert" hidden><\/div>/u);
  const markup = context.document.getElementById('repair-alert').innerHTML;
  assert.match(markup, /class="on-page-alert on-page-alert--error"/u);
  assert.match(markup, /id="repair-alert-message"/u);
  assert.match(markup, /class="[^"]*ui-button[^"]*"[^>]*id="repair-alert-log-history"[^>]*data-open-log-history-alert="1"/u);
  assert.match(markup, /data-dismiss-repair-alert="1"/u);
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

test('acknowledged Library warning leaves stable loader DOM untouched and applies health transitions', () => {
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
  context.document.getElementById = id => id === 'library-scan-warning' ? host : null;
  context.buildOnPageAlertHtml = config => JSON.stringify(config);
  const warning = watcherWarning(firstWarningToken, true);
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
  assert.match(host.innerHTML, /became unavailable/, 'hidden notice retains its reusable markup');
  writes.length = 0;
  context.syncScanLibraryWatcherHealth({}, true);
  assert.deepEqual(writes, [], 'unchanged recovery state must retain its DOM');
});

test('floating alerts use approved severity, escaped messages, and shared repair actions', () => {
  const { context, toasts } = createContext();
  context.showToast('<img src=x onerror=alert(1)>', 'error');
  context.showToast('Watch the library', 'warning');
  context.showToast('Saved', 'success');
  assert.match(toasts[0].innerHTML, /on-page-alert--error" role="alert"/);
  assert.match(toasts[0].innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(toasts[0].innerHTML, /<img/);
  assert.match(toasts[1].innerHTML, /on-page-alert--warning/);
  assert.match(toasts[2].innerHTML, /on-page-alert--info" role="status"/);
  const repair = createRepairAlertContext();
  repair.context.showRepairAlert('<b>Pending</b>', 'success', null);
  assert.match(repair.alert.innerHTML, /on-page-alert--info" role="status"/);
  assert.match(repair.alert.innerHTML, /&lt;b&gt;Pending&lt;\/b&gt;/);
  assert.match(repair.alert.innerHTML, /ui-button/);
  assert.match(repair.alert.innerHTML, /data-dismiss-repair-alert="1"/);
  repair.context.showRepairAlert('<a href="#details">Details</a>', 'info', null, { html: true });
  assert.equal(repair.message.innerHTML, '<a href="#details">Details</a>');
});
