// Settings > Android app. Rendered in the existing Settings shell, only inside the APK.
const ANDROID_SANDBOX_SWITCH_NOTICE = 'Changing sandbox stops playback, clears the current queue, and loads the selected server.';
const ANDROID_SANDBOX_CHOICES = Array.from({ length: 99 }, (_, index) => ({
  value: String(index + 1), label: `sandbox${index + 1}`,
}));

const ANDROID_UPDATES_CAPABILITY = 'updates.manual.v1';
const ANDROID_SANDBOX_CAPABILITY = 'sandbox.select.v1';

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

// The server would not hand this install its artifacts; the failure keeps its title and retry.
const ANDROID_UPDATE_ACCESS_MESSAGES = {
  signed_out: 'Sign in to Album Haven again, then retry.',
  attestation_refused: 'This server didn’t accept this app’s device check. Try again later.',
  device_unsupported: 'This device can’t verify this app for updates.',
};

// Shell codes name only the tables' own entries, never inherited ones such as `constructor`.
function ownAndroidEntry(table, code) {
  return Object.hasOwn(table, code) ? table[code] : null;
}

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
        : ownAndroidEntry(ANDROID_UPDATE_FAILURES, update.error) || ANDROID_UPDATE_FAILURES.check_failed;
      const [title, message, label, action] = failure;
      return ['error', title, ownAndroidEntry(ANDROID_UPDATE_ACCESS_MESSAGES, update.reason) || message, label, action];
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
    progress: progress === undefined ? null : { value: progress, label: androidDownloadProgressLabel(progress) },
  });
}

function androidDownloadProgressLabel(progress) {
  return `Download progress: ${progress}%`;
}

// Progress arrives every half second. A running download changes only its bar and title in place,
// with the status region busy, so screen readers are not handed every tick.
function updateAndroidDownloadProgress(holder) {
  const bar = holder.querySelector('progress');
  if (androidSettings.update.state !== 'downloading' || !bar) return false;
  const [, title, , , , progress] = androidUpdateView(androidBridge.info, androidSettings.update);
  const label = androidDownloadProgressLabel(progress);
  bar.value = progress;
  bar.setAttribute('aria-label', label);
  holder.querySelector('.on-page-alert__progress').firstChild.nodeValue = label;
  holder.querySelector('.on-page-alert__title').textContent = title;
  holder.querySelector('[role="status"]').setAttribute('aria-busy', 'true');
  return true;
}

// Only the update alert is replaced, keeping focus on its button.
function renderAndroidUpdate() {
  const holder = document.querySelector('[data-android-update]');
  if (!holder || !androidBridge.info) return;
  if (updateAndroidDownloadProgress(holder)) return;
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

function androidSelectsSandbox(info) {
  return Boolean(info?.sandbox) && hasAndroidCapability(ANDROID_SANDBOX_CAPABILITY);
}

function buildAndroidSandboxHtml(info) {
  const label = `sandbox${info.sandbox.slot}`;
  // The shared dropdown trigger, as Library settings' path choices use it.
  const trigger = window.ButtonComponent.renderButton({
    label, disabled: androidSettings.switching,
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
  // The shell's own Update required screen offers Check for update; this page has no bridge to ask.
  if (!info && isAndroidUpdateRequired()) {
    return buildOnPageAlertHtml({ severity: 'warning', title: 'Update required',
      message: 'This version of Album Haven can’t open the current site. Install the latest app to continue.', role: 'status' });
  }
  if (!info && androidBridge.connection) {
    return buildOnPageAlertHtml({ severity: 'info', title: 'Android app', message: 'Connecting to the app…', role: 'status' });
  }
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
    ${androidSelectsSandbox(info) ? buildAndroidSandboxHtml(info) : ''}
  </div>`;
}

// Every successful handshake, whichever feature asked for it, names the shell's update state and
// the sandbox it just connected to.
function adoptAndroidSettingsHandshake(info) {
  if (info.updates) androidSettings.update = info.updates;
  const connectedSlot = info.sandbox?.connectedSlot;
  if (connectedSlot) {
    androidSettings.status = { severity: 'success', title: `Connected to sandbox${connectedSlot}.`,
      message: 'The selected server is ready.' };
  }
  if (state.utility.activeTab === 'android') renderUtilityAndroid();
}

// Settings without a shell connection asks again each time it renders; a pending handshake is
// shared, and a failed one waits for the next render rather than retrying in a loop. A success
// renders through adoptAndroidSettingsHandshake; a refusal or failure replaces the pending state.
function connectAndroidSettings() {
  if (androidBridge.info || isAndroidUpdateRequired()) return;
  void connectAndroidBridge().then(() => {
    if (androidBridge.info || state.utility.activeTab !== 'android') return;
    const { detail } = getUtilityModalElements();
    if (detail) detail.innerHTML = buildAndroidSettingsHtml(null);
  });
}

function renderUtilityAndroid() {
  const els = getUtilityModalElements();
  if (!els.overlay || !els.list || !els.detail || !els.count) return;
  connectAndroidSettings();
  if (els.sidebarLabel) els.sidebarLabel.textContent = 'Android app';
  const info = androidBridge.info;
  const rows = [{ key: 'updates', label: 'App & updates' }];
  if (androidSelectsSandbox(info)) rows.push({ key: 'sandbox', label: 'Sandbox server' });
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
  connectAndroidSettings();
}
