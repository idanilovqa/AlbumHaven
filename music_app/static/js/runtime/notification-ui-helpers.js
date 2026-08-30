function isNotificationErrorVariant(variant) {
  return variant === 'error';
}

function shouldAutoHideNotification(duration) {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
}

const activeErrorToasts = new Map();

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
