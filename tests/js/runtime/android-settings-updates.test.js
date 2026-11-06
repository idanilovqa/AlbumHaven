const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { loadCapabilityUi } = require('../support/capability-ui-context.cjs');

const repoRoot = path.join(__dirname, '..', '..', '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'android-bridge', 'v1.json'), 'utf8'));
const runtimeDir = path.join(repoRoot, 'music_app', 'static', 'js', 'runtime');
const handshakePayload = fixture.handshakeResponse.payload;

// The cogwheel menu's Update row as account-menu.html renders it: hidden, with an empty label.
function menuRow() {
  const label = { textContent: '' };
  const detail = { textContent: '', hidden: true };
  return {
    hidden: true, attributes: {}, label, detail,
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    querySelector: selector => ({ '[data-android-update-label]': label, '[data-android-update-detail]': detail }[selector] ?? null),
    closest(selector) { return selector === '[data-android-update-action]' && this.attributes['data-android-update-action'] ? this : null; },
  };
}

// The real alert and button components, so the rendered markup is the shipped markup.
function loadRuntime({ bridge } = {}) {
  const listeners = [];
  const row = menuRow();
  // The Settings utility pane the Android tab renders into.
  const pane = { overlay: {}, list: { innerHTML: '' }, detail: { innerHTML: '' }, count: { textContent: '' } };
  const context = {
    window: { crypto, NavigationTree: { renderItem: ({ label }) => `<li>${label}</li>` } },
    getUtilityModalElements: () => pane,
    document: {
      activeElement: null,
      addEventListener: (type, listener) => listeners.push({ type, listener }),
      querySelector: selector => (selector === '[data-android-update-menu-item]' ? row : null),
    },
    state: { utility: { activeTab: 'appearance' } },
    setTimeout,
    clearTimeout,
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;'),
    module: undefined,
  };
  if (bridge) context.window.AlbumHavenBridge = bridge;
  vm.createContext(context);
  loadCapabilityUi(context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'button-component.js'), 'utf8'), context);
  for (const file of ['alert-components.js', 'android-bridge-client.js', 'android-settings.js']) {
    vm.runInContext(fs.readFileSync(path.join(runtimeDir, file), 'utf8'), context, { filename: file });
  }
  vm.runInContext(`globalThis.api = { androidBridge, androidSettings, buildAndroidSettingsHtml, connectAndroidBridge,
    handleAndroidSettingsClick, initAndroidSettings, renderUtilityAndroid };`, context);
  context.listeners = listeners;
  context.row = row;
  context.pane = pane;
  return context;
}

function fakeBridge(respond) {
  const bridge = {
    sent: [],
    postMessage(raw) {
      const message = JSON.parse(raw);
      bridge.sent.push(message);
      const payload = respond(message);
      if (payload) queueMicrotask(() => bridge.onmessage({ data: JSON.stringify({ ...message, type: 'response', payload }) }));
    },
    event(name, payload) {
      bridge.onmessage({ data: JSON.stringify({ protocol: 1, id: crypto.randomUUID(), type: 'event', name, payload }) });
    },
  };
  return bridge;
}

const update = (changes = {}) => ({ ...handshakePayload.updates, ...changes });

async function connected(updates, options = {}) {
  const bridge = fakeBridge(message => (message.name === 'bridge.handshake'
    ? { ...handshakePayload, updates } : options.respond?.(message)));
  const context = loadRuntime({ bridge });
  context.api.initAndroidSettings();
  await context.api.connectAndroidBridge();
  await new Promise(setImmediate);
  return { ...context, bridge };
}

function text(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function alertOf(html) {
  return html.match(/<section class="on-page-alert on-page-alert--(\w+)[\s\S]*?<\/section>/);
}

// What the menu row shows and does: its label, the action named below it, busy, and its command.
function shown(row) {
  return {
    hidden: row.hidden,
    label: row.label.textContent,
    detail: row.detail.hidden ? null : row.detail.textContent,
    busy: row.getAttribute('aria-disabled') === 'true',
    action: row.getAttribute('data-android-update-action'),
  };
}

// The menu's own click handler has closed the menu by now; Settings' handler runs the row's action.
function press(api, row) {
  api.handleAndroidSettingsClick({ target: { closest: selector => row.closest(selector) }, preventDefault() {} });
}

test('the shared fixture advertises updates.manual.v1 and reports the update state', () => {
  assert.ok(fixture.capabilities.stable.includes('updates.manual.v1'));
  assert.ok(fixture.capabilities.sandbox.includes('updates.manual.v1'));
  assert.equal(handshakePayload.updates.state, 'idle');
  assert.deepEqual(Object.keys(fixture.updateStateEvent.payload).sort(),
    ['checkedAt', 'error', 'progress', 'reason', 'state', 'versionCode', 'versionName']);
});

const ready = { versionName: '0.10.0-sandbox.763af93', versionCode: 2 };
const STATES = [
  [update(), 'Check for update', null, 'check'],
  [update({ checkedAt: 1_800_000_000_000 }), 'Check for update', null, 'check'],
  [update({ state: 'checking' }), 'Checking…', null, null],
  [update({ state: 'upToDate', checkedAt: 1_800_000_000_000 }), 'No updates available', null, 'check'],
  [update({ state: 'available', ...ready }), 'Update available', 'Download update', 'download'],
  [update({ state: 'downloading', progress: 42, ...ready }), 'Downloading 42%', null, null],
  [update({ state: 'verifying', ...ready }), 'Verifying update…', null, null],
  [update({ state: 'ready', ...ready }), 'Update', null, 'install'],
  [update({ state: 'installing', ...ready }), 'Installing…', null, 'install'],
  [update({ state: 'authorization', ...ready }), 'Open install settings', null, 'install'],
  // Every failed check, download or install reads the same, whatever the shell's error and reason.
  ...[
    [{ error: 'check_failed' }, 'check'],
    [{ error: 'check_failed', reason: 'signed_out' }, 'check'],
    [{ error: 'manifest_rejected', reason: 'unsupported_android' }, 'check'],
    [{ error: 'download_failed', ...ready }, 'download'],
    [{ error: 'download_failed', reason: 'signed_out', ...ready }, 'download'],
    [{ error: 'verification_failed', reason: 'hash_mismatch', ...ready }, 'download'],
    [{ error: 'install_failed', ...ready }, 'download'],
  ].map(([failure, action]) => [update({ state: 'failed', ...failure }), 'Update failed. Try again', null, action]),
];

for (const [state, label, detail, action] of STATES) {
  test(`update menu row: ${state.state}${state.error ? ` ${state.error}` : ''}${state.reason ? ` ${state.reason}` : ''} → ${label}`, async () => {
    const { api, row } = await connected(state);
    assert.deepEqual(shown(row), { hidden: false, label, detail, busy: action === null, action });
    // The Settings card keeps the version and leaves updates to the menu, in every state.
    const html = api.buildAndroidSettingsHtml(api.androidBridge.info);
    assert.equal(text(alertOf(html)[0]), 'Android app Sandbox · 0.9.50 (1)');
    assert.doesNotMatch(html, /data-android-update|<progress|Check for update|Update failed|Download update|Installing…/);
  });
}

test('a failure shows only the approved copy and retry, never the shell’s error or reason', async () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hash_mismatch']) {
    for (const failure of [{ error: name }, { error: 'check_failed', reason: name }, { error: name, reason: name, ...ready }]) {
      const { row } = await connected(update({ state: 'failed', ...failure }));
      assert.deepEqual(shown(row), {
        hidden: false, label: 'Update failed. Try again', detail: null, busy: false,
        action: failure.versionName ? 'download' : 'check',
      }, name);
    }
  }
});

test('outside the Android app the row stays hidden and Settings listens for nothing', () => {
  const { api, row, listeners } = loadRuntime();
  api.initAndroidSettings();
  assert.equal(row.hidden, true);
  assert.deepEqual(listeners, []);
});

test('the row stays hidden until the app reports its update state', async () => {
  const bridge = fakeBridge(() => null);
  const { api, row } = loadRuntime({ bridge });
  api.initAndroidSettings();
  await new Promise(setImmediate);
  assert.equal(bridge.sent[0].name, 'bridge.handshake');
  assert.equal(row.hidden, true);
});

test('without updates.manual.v1 the card shows only the version and the row stays hidden', async () => {
  const bridge = fakeBridge(() => ({ ...handshakePayload, capabilities: ['playback.native.v1'] }));
  const { api, row } = loadRuntime({ bridge });
  api.initAndroidSettings();
  await api.connectAndroidBridge();
  assert.equal(row.hidden, true);
  // An update event from such a shell changes nothing either.
  bridge.event('updates.state', fixture.updateStateEvent.payload);
  assert.equal(row.hidden, true);
  const html = api.buildAndroidSettingsHtml(api.androidBridge.info);
  assert.equal(text(alertOf(html)[0]), 'Android app Sandbox · 0.9.50 (1)');
});

test('a shell that refused the site leaves the row hidden', async () => {
  const bridge = fakeBridge(() => ({ ok: false, error: { code: 'update_required', message: 'Update required' } }));
  const { api, row } = loadRuntime({ bridge });
  api.initAndroidSettings();
  await api.connectAndroidBridge();
  assert.equal(api.androidBridge.updateRequired, true);
  assert.equal(row.hidden, true);
});

test('the sandbox server selector is the shared dropdown trigger, unpatched', async () => {
  const { api, window } = await connected(update());
  const html = api.buildAndroidSettingsHtml(api.androidBridge.info);
  const trigger = html.match(/<button[^>]*data-android-sandbox-trigger[\s\S]*?<\/button>/)[0];
  assert.equal(trigger, window.ButtonComponent.renderButton({
    label: 'sandbox2',
    attributes: {
      'data-android-sandbox-trigger': '', 'aria-labelledby': 'android-sandbox-label',
      'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-describedby': 'android-sandbox-origin',
    },
  }));
});

test('the channel is the shared StatusBadge: warning for sandbox, neutral for stable', async () => {
  const { api, window } = await connected(update());
  const { buildStatusBadgeHtml } = window.AlertComponent;
  const sandbox = api.buildAndroidSettingsHtml(api.androidBridge.info);
  assert.ok(sandbox.includes(buildStatusBadgeHtml({ label: 'S · Sandbox', variant: 'warning' })));
  const stable = api.buildAndroidSettingsHtml({ ...api.androidBridge.info, variant: 'stable' });
  assert.ok(stable.includes(buildStatusBadgeHtml({ label: 'Stable', variant: 'neutral' })));
  assert.doesNotMatch(sandbox + stable, /android-settings__channel|is-sandbox/);
});

test('Update required is a warning alert at the top of the Android card', () => {
  const { api } = loadRuntime();
  api.androidBridge.updateRequired = true;
  const html = api.buildAndroidSettingsHtml(null);
  assert.match(html, /^<div class="android-settings">\s*<div class="android-settings__heading">\s*<div><h2>Android app<\/h2><p>Manage this app on your device\.<\/p><\/div>\s*<\/div>\s*<section class="on-page-alert on-page-alert--warning"/);
  assert.equal(text(alertOf(html)[0]), 'Update required This version of Album Haven can’t open the current site. Install the latest app to continue.');
  // A shell that refused the handshake names no channel, and this page cannot ask it to update.
  assert.doesNotMatch(html, /ui-status-badge|<button/);
});

test('the Android tab lists the app and its sandbox server', async () => {
  const { api, pane, state } = await connected(update());
  state.utility.activeTab = 'android';
  api.renderUtilityAndroid();
  assert.equal(pane.list.innerHTML, '<li>Android app</li><li>Sandbox server</li>');
  assert.equal(pane.count.textContent, '2');
});

test('a row press sends its bridge command, stays busy until the shell answers, then shows the answer', async () => {
  const { api, bridge, row } = await connected(update());
  press(api, row);
  const sent = bridge.sent.at(-1);
  assert.equal(sent.name, 'updates.check');
  assert.deepEqual(sent.payload, {});
  await new Promise(setImmediate);
  assert.equal(shown(row).busy, true, 'reopening the menu cannot send the command twice');
  // The shell answers later.
  bridge.onmessage({ data: JSON.stringify({ ...sent, type: 'response', payload: { ok: true, updates: update({ state: 'checking' }) } }) });
  await new Promise(setImmediate);
  assert.equal(api.androidSettings.update.state, 'checking');
  assert.deepEqual(shown(row), { hidden: false, label: 'Checking…', detail: null, busy: true, action: null });
});

test('every row action maps to its own update command', async () => {
  for (const [state, action] of [[update(), 'check'], [update({ state: 'available', ...ready }), 'download'],
    [update({ state: 'ready', ...ready }), 'install']]) {
    const { api, bridge, row } = await connected(state, { respond: () => ({ ok: true, updates: state }) });
    press(api, row);
    await new Promise(setImmediate);
    assert.equal(bridge.sent.at(-1).name, `updates.${action}`);
    assert.equal(shown(row).busy, false);
  }
});

test('Installing… asks the shell to show an unanswered confirmation again, and an approved install keeps installing', async () => {
  const { api, bridge, row } = await connected(update({ state: 'installing', ...ready }), {
    respond: () => ({ ok: false, error: { code: 'update_unavailable', message: 'Not available' } }),
  });
  press(api, row);
  await new Promise(setImmediate);
  assert.equal(bridge.sent.at(-1).name, 'updates.install');
  assert.equal(api.androidSettings.update.state, 'installing');
  assert.deepEqual(shown(row), { hidden: false, label: 'Installing…', detail: null, busy: false, action: 'install' });
});

test('a refused command keeps the current state for the next event', async () => {
  const { api, row } = await connected(update({ state: 'available', ...ready }), {
    respond: () => ({ ok: false, error: { code: 'update_unavailable', message: 'Not available' } }),
  });
  press(api, row);
  await new Promise(setImmediate);
  assert.equal(api.androidSettings.update.state, 'available');
  assert.deepEqual(shown(row), { hidden: false, label: 'Update available', detail: 'Download update', busy: false, action: 'download' });
});

test('a busy row ignores a press', async () => {
  const { api, bridge, row } = await connected(update({ state: 'checking' }));
  const sent = bridge.sent.length;
  press(api, row);
  assert.equal(bridge.sent.length, sent);
});

test('updates.state events change the same row in place, through download and verification', async () => {
  const { api, bridge, row } = await connected(update());
  const downloading = progress => ({ ...fixture.updateStateEvent.payload, state: 'downloading', progress });
  for (const progress of [10, 42, 100]) {
    bridge.event('updates.state', downloading(progress));
    assert.deepEqual(shown(row), { hidden: false, label: `Downloading ${progress}%`, detail: null, busy: true, action: null });
  }
  bridge.event('updates.state', { ...downloading(100), state: 'verifying' });
  assert.equal(shown(row).label, 'Verifying update…');
  bridge.event('updates.state', { ...downloading(100), state: 'ready' });
  assert.deepEqual(shown(row), { hidden: false, label: 'Update', detail: null, busy: false, action: 'install' });
  bridge.event('updates.state', { nonsense: true });
  assert.equal(api.androidSettings.update.state, 'ready');
});

// The first handshake times out; every later one succeeds with the shell's update state.
function flakyShell() {
  let handshakes = 0;
  const bridge = fakeBridge(message => (message.name !== 'bridge.handshake' ? null
    : (handshakes += 1) === 1 ? { ok: false, error: { code: 'timeout', message: 'Timed out' } }
      : { ...handshakePayload, updates: update(), sandbox: { ...handshakePayload.sandbox, connectedSlot: 3 } }));
  const context = loadRuntime({ bridge });
  context.api.initAndroidSettings();
  return { ...context, bridge, handshakes: () => handshakes };
}

test('opening the Android tab after a failed handshake asks the shell again and shows its answer', async () => {
  const { api, pane, row, state, handshakes } = flakyShell();
  await new Promise(setImmediate);
  assert.equal(handshakes(), 1);
  assert.equal(row.hidden, true);
  state.utility.activeTab = 'android';
  api.renderUtilityAndroid();
  assert.match(pane.detail.innerHTML, /data-on-page-alert="info".*Connecting to the app…/);
  assert.doesNotMatch(pane.detail.innerHTML, /could not connect/);
  await new Promise(setImmediate);
  assert.equal(handshakes(), 2);
  assert.doesNotMatch(pane.detail.innerHTML, /Connecting to the app/);
  assert.match(pane.detail.innerHTML, /Sandbox · 0\.9\.50 \(1\)/);
  assert.match(pane.detail.innerHTML, /Connected to sandbox3\./);
  assert.equal(shown(row).label, 'Check for update');
});

test('a later handshake asked for by playback still gives the menu the update state', async () => {
  const { api, row, handshakes } = flakyShell();
  await new Promise(setImmediate);
  assert.equal(row.hidden, true);
  await api.connectAndroidBridge();
  assert.equal(handshakes(), 2);
  assert.equal(api.androidSettings.update.state, 'idle');
  assert.deepEqual(shown(row), { hidden: false, label: 'Check for update', detail: null, busy: false, action: 'check' });
});

test('a Settings retry that fails again waits for the next time the tab opens', async () => {
  const bridge = fakeBridge(message => (message.name === 'bridge.handshake'
    ? { ok: false, error: { code: 'timeout', message: 'Timed out' } } : null));
  const { api, pane, state } = loadRuntime({ bridge });
  api.initAndroidSettings();
  state.utility.activeTab = 'android';
  api.renderUtilityAndroid();
  for (let turn = 0; turn < 5; turn += 1) await new Promise(setImmediate);
  assert.equal(bridge.sent.length, 1, 'a pending handshake is shared, and a failure is not retried in a loop');
  assert.match(pane.detail.innerHTML, /data-on-page-alert="error".*This app could not connect to the current site/);
  api.renderUtilityAndroid();
  assert.match(pane.detail.innerHTML, /Connecting to the app…/, 'the retry shows that it is still asking');
  await new Promise(setImmediate);
  assert.equal(bridge.sent.length, 2);
  assert.match(pane.detail.innerHTML, /data-on-page-alert="error".*This app could not connect to the current site/);
});
