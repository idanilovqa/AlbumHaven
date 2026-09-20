function isNotificationErrorVariant(variant) {
  return variant === 'error';
}

function shouldAutoHideNotification(duration) {
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0;
}

const activeErrorToasts = new Map();
const floatingNotifications = new Map();
let floatingNotificationCleanup = null;
let floatingNotificationFrame = null;

function findClearNotificationPosition(size, preferred, viewport, obstacles, gap = 8) {
  const left = viewport.left + gap, top = viewport.top + gap;
  const right = viewport.right - gap, bottom = viewport.bottom - gap;
  if (size.width > right - left || size.height > bottom - top) return null;
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
  const ys = new Set([clamp(preferred.top, top, bottom - size.height), top, bottom - size.height]);
  obstacles.forEach(rect => {
    ys.add(clamp(rect.top - gap - size.height, top, bottom - size.height));
    ys.add(clamp(rect.bottom + gap, top, bottom - size.height));
  });
  let best = null, distance = Infinity;
  for (const y of ys) {
    const intervals = obstacles.filter(rect => y < rect.bottom + gap && y + size.height > rect.top - gap)
      .map(rect => [Math.max(left, rect.left - gap), Math.min(right, rect.right + gap)])
      .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    let start = left;
    const consider = end => {
      if (end - start < size.width) return;
      const x = clamp(preferred.left, start, end - size.width);
      const nextDistance = (x - preferred.left) ** 2 + (y - preferred.top) ** 2;
      if (nextDistance < distance) { distance = nextDistance; best = { left: x, top: y }; }
    };
    for (const [blockedStart, blockedEnd] of intervals) {
      consider(blockedStart);
      start = Math.max(start, blockedEnd);
    }
    consider(right);
  }
  return best;
}

function scheduleFloatingNotificationPlacement() {
  if (!floatingNotifications.size || floatingNotificationFrame !== null) return;
  floatingNotificationFrame = requestAnimationFrame(() => {
    floatingNotificationFrame = null;
    placeFloatingNotifications();
  });
}

function placeFloatingNotifications() {
  const visual = window.visualViewport;
  const viewport = { left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0 };
  viewport.right = viewport.left + (visual?.width || window.innerWidth);
  viewport.bottom = viewport.top + (visual?.height || window.innerHeight);
  const isNotification = node => [...floatingNotifications.keys()].some(root => root === node || root.contains(node));
  const selector = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"]), [data-loop-range-surface], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"]';
  const obstacles = [];
  document.querySelectorAll(selector).forEach(node => {
    if (isNotification(node) || node.matches(':disabled') || node.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]')) return;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    if (style.visibility !== 'visible' || Number(style.opacity) === 0 || !rect.width || !rect.height) return;
    const left = Math.max(viewport.left, rect.left), right = Math.min(viewport.right, rect.right);
    const top = Math.max(viewport.top, rect.top), bottom = Math.min(viewport.bottom, rect.bottom);
    if (right <= left || bottom <= top) return;
    const points = [[(left + right) / 2, (top + bottom) / 2], [left + 1, top + 1], [right - 1, top + 1], [left + 1, bottom - 1], [right - 1, bottom - 1]];
    const visible = points.some(([x, y]) => {
      const hit = document.elementsFromPoint(x, y).find(element => !isNotification(element));
      return hit && (hit === node || node.contains(hit));
    });
    if (visible) obstacles.push({ left, right, top, bottom });
  });
  for (const [node, entry] of floatingNotifications) {
    if (!node.isConnected || node.hidden) { unregisterFloatingNotification(node); continue; }
    const availableWidth = `${Math.max(0, viewport.right - viewport.left - 16)}px`;
    if (node.style.getPropertyValue('--notification-available-width') !== availableWidth) {
      node.style.setProperty('--notification-available-width', availableWidth);
    }
    const size = { width: node.offsetWidth, height: node.offsetHeight };
    const centered = entry.origin === 'top-center';
    const bottom = entry.origin === 'bottom-right';
    const playerHeight = entry.abovePlayer ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--player-height')) || 0 : 0;
    const preferred = {
      left: centered ? viewport.left + (viewport.right - viewport.left - size.width) / 2 : viewport.right - size.width - 16,
      top: bottom ? viewport.bottom - size.height - playerHeight - 12 : viewport.top + 14,
    };
    const position = findClearNotificationPosition(size, preferred, viewport, obstacles);
    if (!position) {
      if (!entry.presented) node.setAttribute('data-notification-deferred', '');
      continue;
    }
    for (const [key, value] of Object.entries(position)) {
      const property = `--notification-${key}`, pixels = `${value}px`;
      if (node.style.getPropertyValue(property) !== pixels) node.style.setProperty(property, pixels);
    }
    node.removeAttribute('data-notification-deferred');
    obstacles.push({ ...position, right: position.left + size.width, bottom: position.top + size.height });
    if (!entry.presented) { entry.presented = true; entry.onPlaced?.(); }
  }
}

function registerFloatingNotification(node, options = {}) {
  // Keep notification delivery available when the host has no geometry APIs.
  if (!node?.getBoundingClientRect || !document.elementsFromPoint) { options.onPlaced?.(); return; }
  floatingNotifications.set(node, { origin: 'top-right', ...options });
  node.classList.add('floating-notification-positioned');
  node.setAttribute('data-notification-deferred', '');
  if (!floatingNotificationCleanup) {
    const insideNotification = target => [...floatingNotifications.keys()].some(root => root === target || root.contains(target));
    const mutation = new MutationObserver(records => {
      if (records.some(record => !insideNotification(record.target))) scheduleFloatingNotificationPlacement();
    });
    mutation.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'disabled', 'aria-disabled', 'aria-hidden'] });
    const resize = new ResizeObserver(scheduleFloatingNotificationPlacement);
    floatingNotifications.forEach((_entry, root) => resize.observe(root));
    const targets = [[window, 'resize'], [document, 'scroll'], [document, 'load'], [document.fonts, 'loadingdone'], [window.visualViewport, 'resize'], [window.visualViewport, 'scroll'], [document, 'transitionend'], [document, 'animationend']].filter(([target]) => target);
    targets.forEach(([target, event]) => target.addEventListener(event, scheduleFloatingNotificationPlacement, true));
    floatingNotificationCleanup = { resize, dispose() {
      mutation.disconnect(); resize.disconnect();
      targets.forEach(([target, event]) => target.removeEventListener(event, scheduleFloatingNotificationPlacement, true));
      if (floatingNotificationFrame !== null) cancelAnimationFrame(floatingNotificationFrame);
      floatingNotificationFrame = null;
    } };
  } else floatingNotificationCleanup.resize.observe(node);
  scheduleFloatingNotificationPlacement();
}

function unregisterFloatingNotification(node) {
  if (!floatingNotifications.has(node)) return;
  floatingNotificationCleanup?.resize.unobserve(node);
  floatingNotifications.delete(node);
  node?.classList?.remove('floating-notification-positioned');
  node?.removeAttribute?.('data-notification-deferred');
  if (!floatingNotifications.size) { floatingNotificationCleanup?.dispose(); floatingNotificationCleanup = null; }
  else scheduleFloatingNotificationPlacement();
}

let libraryWatcherWarning = null;
let libraryWatcherHealth = null;
let libraryWatcherDismissalInFlight = null;

function cacheLibraryWatcherHealth(data) {
  if (!Object.prototype.hasOwnProperty.call(data, 'watcher_health')) return;
  const health = data.watcher_health || {};
  if (health.state === 'healthy') state.ui.dismissedLibraryWarningToken = '';
  // Only /status carries the event token and per-account acknowledgement.
  if (health.warning_token || health.state === 'healthy') libraryWatcherHealth = health;
}

async function dismissLibraryWatcherWarning(button) {
  const token = button?.getAttribute?.('data-warning-token')
    || libraryWatcherWarning?.dataset?.warningToken || '';
  if (!token) return false;
  while (libraryWatcherDismissalInFlight) {
    if (libraryWatcherDismissalInFlight.token === token) return libraryWatcherDismissalInFlight.promise;
    await libraryWatcherDismissalInFlight.promise;
  }
  if (libraryWatcherHealth?.warning_token !== token
    || libraryWatcherWarning?.dataset?.warningToken !== token) return false;
  const operation = { token, promise: null };
  libraryWatcherDismissalInFlight = operation;
  if (button) button.disabled = true;
  operation.promise = (async () => {
    try {
      const response = await fetch('/account/library-warning/dismiss', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error(response.status === 409
        ? 'The library warning changed. Please review the latest warning.'
        : 'Unable to dismiss the warning. Please try again.');
      state.ui.dismissedLibraryWarningToken = token;
      if (libraryWatcherHealth?.warning_token === token) {
        libraryWatcherHealth = { ...libraryWatcherHealth, dismissed: true };
      }
      syncLibraryWatcherWarning({});
      return true;
    } catch (error) {
      showRepairAlert(error.message || 'Unable to dismiss the warning. Please try again.', 'error', null);
      return false;
    } finally {
      if (button) button.disabled = false;
      if (libraryWatcherDismissalInFlight === operation) libraryWatcherDismissalInFlight = null;
    }
  })();
  return operation.promise;
}

function syncScanLibraryWatcherHealth(data = {}, scanPageVisible = Boolean(typeof state !== 'undefined' && state.ui?.scanPageReturnContext)) {
  cacheLibraryWatcherHealth(data);
  if (typeof renderLibraryWarning === 'function') {
    renderLibraryWarning({ watcher_health: libraryWatcherHealth || {} }, { scanPageVisible });
  }
}

function syncLibraryWatcherWarning(data = {}) {
  cacheLibraryWatcherHealth(data);
  syncScanLibraryWatcherHealth();
  const health = libraryWatcherHealth || {};
  const model = libraryWarningPresentation(health, state.ui.dismissedLibraryWarningToken);
  if (!model.warning || model.dismissed || !model.token) {
    unregisterFloatingNotification(libraryWatcherWarning);
    libraryWatcherWarning?.remove();
    libraryWatcherWarning = null;
    return;
  }
  if (libraryWatcherWarning?.parentElement && libraryWatcherWarning.dataset.warningToken === model.token) return;
  unregisterFloatingNotification(libraryWatcherWarning);
  libraryWatcherWarning?.remove();
  libraryWatcherWarning = null;
  const layer = document.getElementById('toast-layer');
  if (!layer) return;
  libraryWatcherWarning = document.createElement('div');
  libraryWatcherWarning.className = 'system-warning-notification';
  libraryWatcherWarning.dataset.warningToken = model.token;
  libraryWatcherWarning.innerHTML = buildOnPageAlertHtml({
    severity: 'warning',
    title: 'Library watcher needs attention',
    message: 'Some library changes may have been missed. Check Library Status for recovery options.',
    actionsHtml: window.ButtonComponent.renderButton({ label: 'Dismiss', className: 'on-page-alert__dismiss', attributes: { 'data-watcher-dismiss': '1', 'data-warning-token': model.token } })
      + window.ButtonComponent.renderButton({ label: 'Go to Library page', variant: 'primary', attributes: { 'data-watcher-library': '1', 'data-warning-token': model.token } }),
  });
  libraryWatcherWarning.addEventListener('click', async event => {
    const dismiss = event.target.closest('[data-watcher-dismiss]');
    const openLibrary = event.target.closest('[data-watcher-library]');
    const button = dismiss || openLibrary;
    if (!button || button.disabled) return;
    if (await dismissLibraryWatcherWarning(button) && openLibrary) {
      closeUtilityModal();
      openScanPage();
      syncScanLibraryWatcherHealth();
    }
  });
  layer.appendChild(libraryWatcherWarning);
  registerFloatingNotification(libraryWatcherWarning, { origin: 'bottom-right' });
}

function buildFloatingNotificationAlertHtml(message, variant, actionsHtml = '', messageId = '') {
  const severity = normalizeAlertSeverity(variant);
  return buildOnPageAlertHtml({
    severity, title: severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Update',
    message, actionsHtml, messageId, role: severity === 'info' ? 'status' : 'alert',
  });
}

function showToast(message, variant = 'success', duration = 3600, options = {}) {
  const layer = document.getElementById('toast-layer');
  if (!layer) return;
  const errorKey = isNotificationErrorVariant(variant)
    ? String(options.errorKey || message || '')
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
  toast.innerHTML = buildFloatingNotificationAlertHtml(message, variant);
  layer.appendChild(toast);
  if (errorKey) activeErrorToasts.set(errorKey, toast);
  registerFloatingNotification(toast, { origin: options.placement === 'top-center' ? 'top-center' : 'top-right', onPlaced() {
    scheduleBrowserAnimationFrame(() => toast.classList.add('is-visible'));
    scheduleBrowserTimeout(() => {
      toast.classList.remove('is-visible');
      scheduleBrowserTimeout(() => {
        unregisterFloatingNotification(toast);
        toast.remove();
        if (errorKey && activeErrorToasts.get(errorKey) === toast) activeErrorToasts.delete(errorKey);
      }, 260);
    }, duration);
  } });
}

function showRepairAlert(message, variant = 'success', duration = 2000, options = {}) {
  const alert = document.getElementById('repair-alert');
  if (!alert) return;
  const actionsHtml = ButtonComponent.renderButton({
    label: 'View details', attributes: { id: 'repair-alert-log-history', 'data-open-log-history-alert': '1', hidden: true },
  }) + ButtonComponent.renderButton({
    label: 'Dismiss', className: 'on-page-alert__dismiss',
    attributes: { 'data-dismiss-repair-alert': '1', 'aria-label': 'Dismiss repair alert' },
  });
  alert.innerHTML = buildFloatingNotificationAlertHtml(options.html ? '' : message, variant, actionsHtml, 'repair-alert-message');
  const messageEl = document.getElementById('repair-alert-message');
  const logHistoryLink = document.getElementById('repair-alert-log-history');
  if (!messageEl) return;
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
  registerFloatingNotification(alert, { origin: options.logHistoryLink === true ? 'top-center' : 'bottom-right', abovePlayer: options.logHistoryLink !== true, onPlaced() {
    scheduleBrowserAnimationFrame(() => {
      if (state.repairAlertPresentationVersion !== presentationVersion) return;
      alert.classList.add('is-visible');
      if (shouldAutoHideNotification(duration)) state.repairAlertTimer = scheduleBrowserTimeout(hideRepairAlert, duration);
    });
  } });
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
    unregisterFloatingNotification(alert);
    alert.hidden = true;
    alert.classList.remove('is-error');
    alert.classList.remove('has-log-history-link');
    const logHistoryLink = document.getElementById('repair-alert-log-history');
    if (logHistoryLink) logHistoryLink.hidden = true;
  }, 260);
}
