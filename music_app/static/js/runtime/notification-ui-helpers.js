function isNotificationErrorVariant(variant) {
  return variant === 'error';
}

function shouldAutoHideNotification(duration) {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
}

const activeErrorToasts = new Map();
let libraryWatcherWarning = null;
let libraryWatcherWarningDismissed = false;
let libraryWatcherHealth = null;
const libraryWatcherDismissalKey = 'album-haven.library-watcher-warning-dismissed.v1';

function isLibraryWatcherWarningDismissed() {
  try {
    return libraryWatcherWarningDismissed || window.localStorage?.getItem(libraryWatcherDismissalKey) === '1';
  } catch (_error) {
    return libraryWatcherWarningDismissed;
  }
}

function dismissLibraryWatcherWarning() {
  libraryWatcherWarningDismissed = true;
  try { window.localStorage?.setItem(libraryWatcherDismissalKey, '1'); } catch (_error) {}
  libraryWatcherWarning?.remove();
  libraryWatcherWarning = null;
}

function syncScanLibraryWatcherHealth(data = {}, scanPageVisible = Boolean(typeof state !== 'undefined' && state.ui?.scanPageReturnContext)) {
  if (Object.prototype.hasOwnProperty.call(data, 'watcher_health')) libraryWatcherHealth = data.watcher_health;
  const host = document.getElementById('library-loader-watch-health');
  if (!host) return;
  if (!scanPageVisible) {
    if (!host.hidden) host.hidden = true;
    if (host.innerHTML) host.innerHTML = '';
    return;
  }
  const problems = libraryWatcherHealth?.problems || [];
  const warning = libraryWatcherHealth?.state === 'warning' || problems.length > 0;
  if (host.hidden !== !warning) host.hidden = !warning;
  if (!warning) {
    if (host.innerHTML) host.innerHTML = '';
    return;
  }
  const unavailable = problems.some(problem => problem.state === 'root_unavailable');
  const message = unavailable
    ? 'A watched library folder became unavailable. Reconnect the drive or network share, check that the folder is accessible, then run Full Rescan from Library Status.'
    : problems.length
      ? 'The library watcher may have missed file changes. Run Full Rescan from Library Status to reconcile the library with your files.'
      : 'Library watcher diagnostics are unavailable. Check drive and network access, then retry the library scan.';
  const html = buildOnPageAlertHtml({ severity: 'warning', title: 'Library watcher needs attention', message });
  if (host.innerHTML !== html) host.innerHTML = html;
}

function syncLibraryWatcherWarning(data = {}) {
  if (!Object.prototype.hasOwnProperty.call(data, 'watcher_health')) return;
  const health = data.watcher_health;
  syncScanLibraryWatcherHealth(data);
  const warning = health?.state === 'warning'
    || (Array.isArray(health?.problems) && health.problems.length > 0);
  if (!warning) {
    libraryWatcherWarning?.remove();
    libraryWatcherWarning = null;
    return;
  }
  if (isLibraryWatcherWarningDismissed()) {
    libraryWatcherWarning?.remove();
    libraryWatcherWarning = null;
    return;
  }
  if (libraryWatcherWarning?.parentElement) return;
  const layer = document.getElementById('toast-layer');
  if (!layer) return;
  libraryWatcherWarning = document.createElement('div');
  libraryWatcherWarning.className = 'system-warning-notification';
  libraryWatcherWarning.innerHTML = buildOnPageAlertHtml({
    severity: 'warning',
    title: 'Library watcher needs attention',
    message: 'Some library changes may have been missed. Check Library Status for recovery options.',
    actionsHtml: window.ButtonComponent.renderButton({ label: 'Dismiss', className: 'on-page-alert__dismiss', attributes: { 'data-watcher-dismiss': '1' } })
      + window.ButtonComponent.renderButton({ label: 'Go to Library page', variant: 'primary', attributes: { 'data-watcher-library': '1' } }),
  });
  libraryWatcherWarning.addEventListener('click', event => {
    if (event.target.closest('[data-watcher-dismiss]')) {
      dismissLibraryWatcherWarning();
    } else if (event.target.closest('[data-watcher-library]')) {
      dismissLibraryWatcherWarning();
      closeUtilityModal();
      openScanPage();
      syncScanLibraryWatcherHealth();
    }
  });
  layer.appendChild(libraryWatcherWarning);
}

function showToast(html, variant = 'success', duration = 3600, options = {}) {
  const layer = document.getElementById('toast-layer');
  if (!layer) return;
  const errorKey = isNotificationErrorVariant(variant)
    ? String(options.errorKey || html || '')
    : '';
  if (errorKey && activeErrorToasts.get(errorKey)?.parentElement) {
    return;
  }
  const toast = document.createElement('div');
  toast.className = [
    'toast',
    isNotificationErrorVariant(variant) ? 'is-error' : '',
    options.placement === 'top-center' ? 'is-top-center' : '',
  ].filter(Boolean).join(' ');
  toast.innerHTML = html;
  layer.appendChild(toast);
  if (errorKey) activeErrorToasts.set(errorKey, toast);
  scheduleBrowserAnimationFrame(() => toast.classList.add('is-visible'));
  scheduleBrowserTimeout(() => {
    toast.classList.remove('is-visible');
    scheduleBrowserTimeout(() => {
      toast.remove();
      if (errorKey && activeErrorToasts.get(errorKey) === toast) {
        activeErrorToasts.delete(errorKey);
      }
    }, 260);
  }, duration);
}

function showRepairAlert(message, variant = 'success', duration = 2000, options = {}) {
  const alert = document.getElementById('repair-alert');
  const messageEl = document.getElementById('repair-alert-message');
  const logHistoryLink = document.getElementById('repair-alert-log-history');
  if (!alert || !messageEl) return;
  if (state.repairAlertTimer) {
    clearBrowserTimeout(state.repairAlertTimer);
    state.repairAlertTimer = null;
  }
  if (state.repairAlertHideTimer) {
    clearBrowserTimeout(state.repairAlertHideTimer);
    state.repairAlertHideTimer = null;
  }
  if (options.html) {
    messageEl.innerHTML = String(message || '');
  } else {
    messageEl.textContent = message;
  }
  if (logHistoryLink) {
    logHistoryLink.hidden = options.logHistoryLink !== true;
    logHistoryLink.dataset.logHistoryEntryId = options.logHistoryLink === true
      ? String(options.logHistoryEntryId || '')
      : '';
  }
  alert.classList.toggle('has-log-history-link', options.logHistoryLink === true);
  alert.classList.toggle('is-error', isNotificationErrorVariant(variant));
  alert.hidden = false;
  state.repairAlertPresentationVersion = Number(state.repairAlertPresentationVersion || 0) + 1;
  const presentationVersion = state.repairAlertPresentationVersion;
  scheduleBrowserAnimationFrame(() => {
    if (state.repairAlertPresentationVersion !== presentationVersion) return;
    alert.classList.add('is-visible');
    if (shouldAutoHideNotification(duration)) {
      state.repairAlertTimer = scheduleBrowserTimeout(hideRepairAlert, duration);
    }
  });
}

function hideRepairAlert() {
  const alert = document.getElementById('repair-alert');
  if (!alert) return;
  state.repairAlertPresentationVersion = Number(state.repairAlertPresentationVersion || 0) + 1;
  if (state.repairAlertTimer) {
    clearBrowserTimeout(state.repairAlertTimer);
    state.repairAlertTimer = null;
  }
  if (state.repairAlertHideTimer) {
    clearBrowserTimeout(state.repairAlertHideTimer);
    state.repairAlertHideTimer = null;
  }
  alert.classList.remove('is-visible');
  state.repairAlertHideTimer = scheduleBrowserTimeout(() => {
    state.repairAlertHideTimer = null;
    alert.hidden = true;
    alert.classList.remove('is-error');
    alert.classList.remove('has-log-history-link');
    const logHistoryLink = document.getElementById('repair-alert-log-history');
    if (logHistoryLink) logHistoryLink.hidden = true;
  }, 260);
}
