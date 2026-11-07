// Settings > Android app, and the Update row of the cogwheel menu. Both show only inside the APK.
const ANDROID_SANDBOX_SWITCH_NOTICE = 'Changing sandbox stops playback, clears the current queue, and loads the selected server.';
const ANDROID_SANDBOX_CHOICES = Array.from({ length: 99 }, (_, index) => ({
  value: String(index + 1), label: `sandbox${index + 1}`,
}));

const ANDROID_UPDATES_CAPABILITY = 'updates.manual.v1';
const ANDROID_SANDBOX_CAPABILITY = 'sandbox.select.v1';

// `update` is the shell's latest `updates.state` payload; null until the handshake reports one.
const androidSettings = { status: null, switching: false, update: null };

function androidVersionLabel(info) {
  return `${info.variant === 'sandbox' ? 'Sandbox' : 'Stable'} · ${info.versionName} (${info.versionCode})`;
}

// The cogwheel menu's Update row for the shell's update state, or null while it has none to show:
// [label, bridge action or null while busy, the action named below the label].
function androidUpdateMenuView() {
  const update = androidSettings.update;
  if (!update || !hasAndroidCapability(ANDROID_UPDATES_CAPABILITY)) return null;
  switch (update.state) {
    case 'checking': return ['Checking…', null];
    case 'upToDate': return ['No updates available', 'check'];
    case 'available': return ['Update available', 'download', 'Download update'];
    case 'downloading': return [`Downloading ${update.progress}%`, null];
    case 'verifying': return ['Verifying update…', null];
    case 'ready': return ['Update', 'install'];
    // Pressing it again shows a confirmation left unanswered; an approved install keeps installing.
    case 'installing': return ['Installing…', 'install'];
    case 'authorization': return ['Open install settings', 'install'];
    // Every failure reads the same; the shell logs its error and reason. A failure that kept its
    // update downloads it again, as the shell's own retry does; any other checks again.
    case 'failed': return ['Update failed. Try again', update.versionName ? 'download' : 'check'];
    default: return ['Check for update', 'check'];
  }
}

// The row is changed in place, so an open menu keeps its focus while progress arrives. A menu
// item is not a live region: screen readers read the new state when they reach the row.
function renderAndroidUpdateMenuItem() {
  const item = document.querySelector('[data-android-update-menu-item]');
  if (!item) return;
  const view = androidUpdateMenuView();
  item.hidden = !view;
  if (!view) return;
  const [label, action, detail = ''] = view;
  item.querySelector('[data-android-update-label]').textContent = label;
  const detailElement = item.querySelector('[data-android-update-detail]');
  detailElement.textContent = detail;
  detailElement.hidden = !detail;
  if (action) {
    item.setAttribute('data-android-update-action', action);
    item.removeAttribute('aria-disabled');
  } else {
    item.removeAttribute('data-android-update-action');
    item.setAttribute('aria-disabled', 'true');
  }
}

// Renders even when `update` is not a state, so a pressed row is never left busy.
function setAndroidUpdate(update) {
  if (update && typeof update === 'object' && typeof update.state === 'string') androidSettings.update = update;
  renderAndroidUpdateMenuItem();
}

async function requestAndroidUpdate(action) {
  // A refused command is not applicable in the shell's current state; its next `updates.state`
  // event shows that state.
  const response = await sendAndroidBridgeCommand(`updates.${action}`).catch(() => null);
  setAndroidUpdate(response?.updates);
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

// The channel badge needs the handshake; a shell that refused it names no channel.
function buildAndroidCardHtml(info, contentHtml) {
  const badge = !info ? '' : buildStatusBadgeHtml(info.variant === 'sandbox'
    ? { label: 'S · Sandbox', variant: 'warning' } : { label: 'Stable', variant: 'neutral' });
  return `<div class="android-settings">
    <div class="android-settings__heading">
      <div><h2>Android app</h2><p>Manage this app on your device.</p></div>
      ${badge}
    </div>
    ${contentHtml}
  </div>`;
}

function buildAndroidSettingsHtml(info) {
  // The shell's own Update required screen offers Check for update; this page has no bridge to ask.
  if (!info && isAndroidUpdateRequired()) {
    return buildAndroidCardHtml(null, buildOnPageAlertHtml({ severity: 'warning', title: 'Update required',
      message: 'This version of Album Haven can’t open the current site. Install the latest app to continue.', role: 'status' }));
  }
  if (!info && androidBridge.connection) {
    return buildOnPageAlertHtml({ severity: 'info', title: 'Android app', message: 'Connecting to the app…', role: 'status' });
  }
  if (!info) {
    return buildOnPageAlertHtml({ severity: 'error', title: 'Android app',
      message: 'This app could not connect to the current site.', role: 'status' });
  }
  // Updates run from the cogwheel menu; this card names the installed version.
  return buildAndroidCardHtml(info, `${buildOnPageAlertHtml({ severity: 'info', title: 'Android app', message: androidVersionLabel(info), role: 'status' })}
    ${androidSelectsSandbox(info) ? buildAndroidSandboxHtml(info) : ''}`);
}

// Every successful handshake, whichever feature asked for it, names the shell's update state and
// the sandbox it just connected to.
function adoptAndroidSettingsHandshake(info) {
  if (info.updates) androidSettings.update = info.updates;
  renderAndroidUpdateMenuItem();
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
  const rows = [{ key: 'app', label: 'Android app' }];
  if (androidSelectsSandbox(info)) rows.push({ key: 'sandbox', label: 'Sandbox server' });
  els.count.textContent = String(rows.length);
  if (els.problemFilterButton) {
    els.problemFilterButton.disabled = true;
    els.problemFilterButton.hidden = true;
  }
  if (els.problemFilterMenu) els.problemFilterMenu.hidden = true;
  if (els.problemFilterChips) els.problemFilterChips.innerHTML = '';
  els.list.innerHTML = rows.map(row => window.NavigationTree.renderItem({
    key: row.key, label: row.label, variant: 'panel', action: true, selected: row.key === 'app',
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
  // The menu closes on a press (account-menu.js) and rejects a busy row; the row stays busy until
  // the shell answers, so reopening the menu cannot send the command twice.
  const updateAction = event.target.closest?.('[data-android-update-action]');
  if (updateAction) {
    event.preventDefault();
    updateAction.setAttribute('aria-disabled', 'true');
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
