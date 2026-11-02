// Settings > Android app. Rendered in the existing Settings shell, only inside the APK.
const ANDROID_SANDBOX_SWITCH_NOTICE = 'Changing sandbox stops playback, clears the current queue, and loads the selected server.';
const ANDROID_SANDBOX_CHOICES = Array.from({ length: 99 }, (_, index) => ({
  value: String(index + 1), label: `sandbox${index + 1}`,
}));

const androidSettings = { status: null, switching: false };

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
  const channel = sandbox ? 'Sandbox' : 'Stable';
  return `<div class="android-settings">
    <div class="android-settings__heading">
      <div><h2>Android app</h2><p>Manage this app on your device.</p></div>
      <span class="android-settings__channel${sandbox ? ' is-sandbox' : ''}">${sandbox ? 'S · Sandbox' : 'Stable'}</span>
    </div>
    ${buildOnPageAlertHtml({ severity: 'info', title: 'Android app',
    message: `${channel} · ${info.versionName} (${info.versionCode})`, role: 'status' })}
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
  if (els.search) {
    els.search.value = '';
    els.search.disabled = true;
    els.search.placeholder = '';
  }
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
  void connectAndroidBridge().then((info) => {
    const connectedSlot = info?.sandbox?.connectedSlot;
    if (connectedSlot) {
      androidSettings.status = { severity: 'success', title: `Connected to sandbox${connectedSlot}.`,
        message: 'The selected server is ready.' };
    }
    if (state.utility.activeTab === 'android') renderUtilityAndroid();
  });
}
