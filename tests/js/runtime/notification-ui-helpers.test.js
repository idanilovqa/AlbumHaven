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

function createContext() {
  const toasts = [];
  const scheduledTimeouts = [];
  const layer = {
    appendChild(toast) {
      toasts.push(toast);
      toast.parentElement = layer;
    },
  };
  const context = {
    document: {
      createElement() {
        const toast = {
          className: '',
          classList: {
            add() {},
            remove() {},
          },
          innerHTML: '',
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
