// Settings > Android app. Rendered in the existing Settings shell, only inside the APK.
const ANDROID_SANDBOX_SWITCH_NOTICE = 'Changing sandbox stops playback, clears the current queue, and loads the selected server.';
const ANDROID_SANDBOX_CHOICES = Array.from({ length: 99 }, (_, index) => ({
  value: String(index + 1), label: `sandbox${index + 1}`,
}));

const ANDROID_UPDATES_CAPABILITY = 'updates.manual.v1';

// `update` is the shell's latest `updates.state` payload; null until the handshake reports one.
const androidSettings = { status: null, switching: false, update: null };

function formatAndroidCheckedAgo(checkedAt, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - checkedAt) / 60000);
  if (minutes < 1) return 'just now';
  const [count, unit] = minutes < 60 ? [minutes, 'minute']
    : minutes < 1440 ? [Math.floor(minutes / 60), 'hour'] : [Math.floor(minutes / 1440), 'day'];
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

const ANDROID_UPDATE_FAILURES = {
  check_failed: ['Update check failed.', 'Check your connection and try again.', 'Retry', 'check'],
  manifest_rejected: ['Update check failed.', 'The published update doesn’t match this app. Try again later.', 'Retry', 'check'],
  download_failed: ['Download failed.', 'Check your connection and try again.', 'Retry download', 'download'],
  verification_failed: ['Update couldn’t be verified.',
    'The downloaded app did not match Album Haven’s signed release. Download it again.', 'Retry download', 'download'],
  install_failed: ['Update couldn’t be installed.', 'Android didn’t install the update. Download it again.', 'Retry download', 'download'],
};

function androidVersionLabel(info) {
  return `${info.variant === 'sandbox' ? 'Sandbox' : 'Stable'} · ${info.versionName} (${info.versionCode})`;
}

// [severity, title, message, button label, bridge action or null while busy, progress].
function androidUpdateView(info, update) {
  const version = androidVersionLabel(info);
  const name = update.versionName;
  const checked = update.checkedAt ? formatAndroidCheckedAgo(update.checkedAt) : null;
  const verifiedMessage = 'Signature and file verified. Android will ask you to confirm installation.';
  switch (update.state) {
    case 'checking': return ['info', 'Checking for updates…', 'Keep this screen open.', 'Checking…', null];
    case 'upToDate': return ['success', 'Album Haven is up to date.', `${version} · Checked ${checked}`, 'Check again', 'check'];
    case 'available': return ['warning', `Album Haven ${name} is available.`, 'Download starts only when you ask.', 'Download update', 'download'];
    case 'downloading': return ['info', `Downloading update · ${update.progress}%`,
      'Android will confirm installation after verification.', 'Downloading…', null, update.progress];
    case 'verifying': return ['info', 'Verifying update…', 'Android will confirm installation after verification.', 'Verifying…', null];
    case 'ready': return ['success', `Album Haven ${name} is ready to install.`, verifiedMessage, 'Install update', 'install'];
    case 'installing': return ['success', `Album Haven ${name} is ready to install.`, verifiedMessage, 'Installing…', null];
    case 'authorization': return ['warning', 'Allow Album Haven to install updates.',
      'Android blocks this install source. Return here after enabling the permission.', 'Open install settings', 'install'];
    case 'failed': {
      const failure = update.reason === 'unsupported_android'
        ? ['Update check failed.', 'This update needs a newer version of Android.', 'Retry', 'check']
        : ANDROID_UPDATE_FAILURES[update.error] || ANDROID_UPDATE_FAILURES.check_failed;
      return ['error', ...failure];
    }
    default: return ['info', 'Android app', checked ? `${version} · Last checked ${checked}` : version, 'Check for updates', 'check'];
  }
}

function buildAndroidUpdateHtml(info) {
  if (!hasAndroidCapability(ANDROID_UPDATES_CAPABILITY) || !androidSettings.update) {
    return buildOnPageAlertHtml({ severity: 'info', title: 'Android app', message: androidVersionLabel(info), role: 'status' });
  }
  const [severity, title, message, label, action, progress] = androidUpdateView(info, androidSettings.update);
  const actionsHtml = window.ButtonComponent.renderButton({
    label, disabled: !action, attributes: action ? { 'data-android-update-action': action } : {},
  });
  return buildOnPageAlertHtml({
    severity, title, message, actionsHtml, role: 'status',
    progress: progress === undefined ? null : { value: progress, label: `Download progress: ${progress}%` },
  });
}

// Progress arrives every half second, so only the update alert is replaced, keeping focus on its button.
function renderAndroidUpdate() {
  const holder = document.querySelector('[data-android-update]');
  if (!holder || !androidBridge.info) return;
  const focused = holder.contains(document.activeElement);
  holder.innerHTML = buildAndroidUpdateHtml(androidBridge.info);
  if (focused) holder.querySelector('button')?.focus();
}

function setAndroidUpdate(update) {
  if (!update || typeof update !== 'object' || typeof update.state !== 'string') return;
  androidSettings.update = update;
  renderAndroidUpdate();
}

async function requestAndroidUpdate(action) {
  try {
    const response = await sendAndroidBridgeCommand(`updates.${action}`);
    setAndroidUpdate(response.updates);
  } catch (_error) {
    // Not applicable in the shell's current state; its next `updates.state` event shows that state.
    renderAndroidUpdate();
  }
}

function buildAndroidSandboxHtml(info) {
  const label = `sandbox${info.sandbox.slot}`;
  const trigger = window.ButtonComponent.renderButton({
    label, className: 'android-settings__selector', disabled: androidSettings.switching,
    attributes: {
      'data-android-sandbox-trigger': '', 'aria-labelledby': 'android-sandbox-label',
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-describedby': 'android-sandbox-origin',
    },
  });
  const status = androidSettings.status ? buildOnPageAlertHtml({ ...androidSettings.status, role: 'status' }) : '';
  return `<section class="android-settings__sandbox" data-android-sandbox-section>
    <div><h3 id="android-sandbox-label">Sandbox server</h3><p>Choose the server this Sandbox app connects to.</p></div>
    ${trigger}
    <p id="android-sandbox-origin">${escapeHtml(info.origin)}</p>
    ${buildOnPageAlertHtml({ severity: 'warning', title: 'Before changing servers', message: ANDROID_SANDBOX_SWITCH_NOTICE, role: 'status' })}
    ${status}
  </section>`;
}

function buildAndroidSettingsHtml(info) {
  if (!info) {
    return buildOnPageAlertHtml({ severity: 'error', title: 'Android app',
      message: 'This app could not connect to the current site.', role: 'status' });
  }
  const sandbox = info.variant === 'sandbox';
  return `<div class="android-settings">
    <div class="android-settings__heading">
      <div><h2>Android app</h2><p>Manage this app on your device.</p></div>
      <span class="android-settings__channel${sandbox ? ' is-sandbox' : ''}">${sandbox ? 'S · Sandbox' : 'Stable'}</span>
    </div>
    <div data-android-update>${buildAndroidUpdateHtml(info)}</div>
    ${sandbox && info.sandbox ? buildAndroidSandboxHtml(info) : ''}
  </div>`;
}

function renderUtilityAndroid() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Android app';
  const info = androidBridge.info;
  const rows = [{ key: 'updates', label: 'App & updates' }];
  if (info?.sandbox) rows.push({ key: 'sandbox', label: 'Sandbox server' });
  els.count.textContent = String(rows.length);
  if (els.problemFilterButton) {
    els.problemFilterButton.disabled = true;
    els.problemFilterButton.hidden = true;
  }
  if (els.problemFilterMenu) els.problemFilterMenu.hidden = true;
  if (els.problemFilterChips) els.problemFilterChips.innerHTML = '';
  els.list.innerHTML = rows.map(row => window.NavigationTree.renderItem({
    key: row.key, label: row.label, variant: 'panel', action: true, selected: row.key === 'updates',
    attributes: { 'data-utility-android-key': row.key },
  })).join('');
  els.detail.innerHTML = buildAndroidSettingsHtml(info);
  const trigger = els.detail.querySelector('[data-android-sandbox-trigger]');
  trigger?.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>');
}

async function selectAndroidSandbox(slot) {
  const current = androidBridge.info.sandbox.slot;
  if (slot === current) return;
  androidSettings.switching = true;
  androidSettings.status = { severity: 'info', title: `Switching to sandbox${slot}…`,
    message: 'Playback has stopped and the current queue is empty.' };
  renderUtilityAndroid();
  try {
    // On success the shell loads the selected origin and this document goes away.
    await sendAndroidBridgeCommand('sandbox.select', { slot });
  } catch (_error) {
    androidSettings.switching = false;
    androidSettings.status = { severity: 'error', title: `Could not connect to sandbox${slot}.`,
      message: `Still using sandbox${current}. Check your connection and try again.` };
    renderUtilityAndroid();
  }
}

function handleAndroidSettingsClick(event) {
  const updateAction = event.target.closest?.('[data-android-update-action]');
  if (updateAction) {
    event.preventDefault();
    updateAction.disabled = true;
    void requestAndroidUpdate(updateAction.getAttribute('data-android-update-action'));
    return;
  }
  const row = event.target.closest?.('[data-utility-android-key]');
  if (row) {
    const section = row.getAttribute('data-utility-android-key') === 'sandbox'
      ? '[data-android-sandbox-section]' : '.android-settings__heading';
    document.querySelector(section)?.scrollIntoView({ block: 'start' });
    return;
  }
  const trigger = event.target.closest?.('[data-android-sandbox-trigger]');
  if (!trigger || androidSettings.switching) return;
  event.preventDefault();
  openUtilityChoiceDropdown(trigger, {
    formats: ANDROID_SANDBOX_CHOICES, matchTriggerWidth: true, label: 'Sandbox server',
    selected: String(androidBridge.info.sandbox.slot),
    onSelect: (value) => {
      void selectAndroidSandbox(Number(value));
      return false;
    },
  });
}

function initAndroidSettings() {
  if (!isAndroidShell()) return;
  document.addEventListener('click', handleAndroidSettingsClick);
  androidBridge.events.set('updates.state', setAndroidUpdate);
  void connectAndroidBridge().then((info) => {
    if (info?.updates) androidSettings.update = info.updates;
    const connectedSlot = info?.sandbox?.connectedSlot;
    if (connectedSlot) {
      androidSettings.status = { severity: 'success', title: `Connected to sandbox${connectedSlot}.`,
        message: 'The selected server is ready.' };
    }
    if (state.utility.activeTab === 'android') renderUtilityAndroid();
  });
}
