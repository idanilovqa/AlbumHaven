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
const HOUR = 60 * 60 * 1000;

// The real alert and button components, so the rendered markup is the shipped markup.
function loadRuntime({ bridge, now = Date.now() } = {}) {
  const listeners = [];
  const holder = { innerHTML: '', contains: () => false, querySelector: () => null };
  // The Settings utility pane the Android tab renders into.
  const pane = { overlay: {}, list: { innerHTML: '' }, detail: { innerHTML: '' }, count: { textContent: '' } };
  const context = {
    window: { crypto, NavigationTree: { renderItem: ({ label }) => `<li>${label}</li>` } },
    getUtilityModalElements: () => pane,
    document: {
      activeElement: null,
      addEventListener: (type, listener) => listeners.push({ type, listener }),
      querySelector: selector => (selector === '[data-android-update]' ? holder : null),
    },
    state: { utility: { activeTab: 'appearance' } },
    Date: class extends Date { static now() { return now; } },
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
    formatAndroidCheckedAgo, handleAndroidSettingsClick, initAndroidSettings, renderUtilityAndroid };`, context);
  context.listeners = listeners;
  context.holder = holder;
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
  const context = loadRuntime({ bridge, now: options.now });
  context.api.initAndroidSettings();
  await context.api.connectAndroidBridge();
  await new Promise(setImmediate);
  return { ...context, bridge };
}

function text(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function button(html) {
  const match = html.match(/<button[^>]*>[\s\S]*?<\/button>/);
  assert.ok(match, 'the update alert has its action button');
  return {
    label: text(match[0]),
    disabled: /\sdisabled(\s|>|=)/.test(match[0]),
    action: match[0].match(/data-android-update-action="([a-z]+)"/)?.[1] ?? null,
  };
}

function alertOf(html) {
  return html.match(/<section class="on-page-alert on-page-alert--(\w+)[\s\S]*?<\/section>/);
}

test('the shared fixture advertises updates.manual.v1 and reports the update state', () => {
  assert.ok(fixture.capabilities.stable.includes('updates.manual.v1'));
  assert.ok(fixture.capabilities.sandbox.includes('updates.manual.v1'));
  assert.equal(handshakePayload.updates.state, 'idle');
  assert.deepEqual(Object.keys(fixture.updateStateEvent.payload).sort(),
    ['checkedAt', 'error', 'progress', 'reason', 'state', 'versionCode', 'versionName']);
});

test('relative check times read like the approved card', () => {
  const { api } = loadRuntime();
  const now = 10 * 24 * HOUR;
  assert.equal(api.formatAndroidCheckedAgo(now - 20 * 1000, now), 'just now');
  assert.equal(api.formatAndroidCheckedAgo(now - 60 * 1000, now), '1 minute ago');
  assert.equal(api.formatAndroidCheckedAgo(now - 59 * 60 * 1000, now), '59 minutes ago');
  assert.equal(api.formatAndroidCheckedAgo(now - 6 * HOUR, now), '6 hours ago');
  assert.equal(api.formatAndroidCheckedAgo(now - 49 * HOUR, now), '2 days ago');
  assert.equal(api.formatAndroidCheckedAgo(now + HOUR, now), 'just now');
});

const now = 1_800_000_000_000;
const ready = { versionName: '0.10.0-sandbox.763af93', versionCode: 2 };
const STATES = [
  [update({ checkedAt: now - 6 * HOUR }), 'info', 'Android app', 'Sandbox · 0.9.50 (1) · Last checked 6 hours ago', 'Check for updates', 'check'],
  [update(), 'info', 'Android app', 'Sandbox · 0.9.50 (1)', 'Check for updates', 'check'],
  [update({ state: 'checking' }), 'info', 'Checking for updates…', 'Keep this screen open.', 'Checking…', null],
  [update({ state: 'upToDate', checkedAt: now }), 'success', 'No updates available', 'Sandbox · 0.9.50 (1) · Checked just now', 'Check again', 'check'],
  [update({ state: 'available', ...ready }), 'warning', 'Album Haven 0.10.0-sandbox.763af93 is available.', 'Download starts only when you ask.', 'Download update', 'download'],
  [update({ state: 'downloading', progress: 42, ...ready }), 'info', 'Downloading update · 42%', 'Android will confirm installation after verification.', 'Downloading…', null],
  [update({ state: 'verifying', ...ready }), 'info', 'Verifying update…', 'Android will confirm installation after verification.', 'Verifying…', null],
  [update({ state: 'ready', ...ready }), 'success', 'Album Haven 0.10.0-sandbox.763af93 is ready to install.', 'Signature and file verified. Android will ask you to confirm installation.', 'Update', 'install'],
  [update({ state: 'installing', ...ready }), 'success', 'Album Haven 0.10.0-sandbox.763af93 is ready to install.', 'Signature and file verified. Android will ask you to confirm installation.', 'Installing…', 'install'],
  [update({ state: 'authorization', ...ready }), 'warning', 'Allow Album Haven to install updates.', 'Android blocks this install source. Return here after enabling the permission.', 'Open install settings', 'install'],
  // Every failed check, download or install reads the same, whatever the shell's error and reason.
  ...[
    [{ error: 'check_failed' }, 'check'],
    [{ error: 'check_failed', reason: 'signed_out' }, 'check'],
    [{ error: 'manifest_rejected', reason: 'unsupported_android' }, 'check'],
    [{ error: 'download_failed', ...ready }, 'download'],
    [{ error: 'download_failed', reason: 'signed_out', ...ready }, 'download'],
    [{ error: 'verification_failed', reason: 'hash_mismatch', ...ready }, 'download'],
    [{ error: 'install_failed', ...ready }, 'download'],
  ].map(([failure, action]) => [update({ state: 'failed', ...failure }), 'error', 'Update failed. Try again', '', 'Retry', action]),
];

for (const [state, severity, title, message, label, action] of STATES) {
  test(`update card: ${state.state}${state.error ? ` ${state.error}` : ''}${state.reason ? ` ${state.reason}` : ''} → ${title}`, async () => {
    const { api } = await connected(state, { now });
    const html = api.buildAndroidSettingsHtml(api.androidBridge.info);
    const alert = alertOf(html.slice(html.indexOf('data-android-update')));
    assert.equal(alert[1], severity);
    assert.match(text(alert[0]), new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.deepEqual(button(alert[0]), { label, disabled: action === null, action });
  });
}

test('downloading shows the approved progress label and bar', async () => {
  const { api } = await connected(update({ state: 'downloading', progress: 42, ...ready }));
  const html = api.buildAndroidSettingsHtml(api.androidBridge.info);
  assert.match(html, /<label class="on-page-alert__progress">Download progress: 42%<progress max="100" value="42" aria-label="Download progress: 42%"><\/progress><\/label>/);
});

test('download progress changes the bar in place, never re-rendering the status region', async () => {
  const { bridge, holder } = await connected(update());
  const downloading = progress => ({ ...fixture.updateStateEvent.payload, state: 'downloading', progress });
  bridge.event('updates.state', downloading(10));
  const rendered = holder.innerHTML;
  assert.match(rendered, /Downloading update · 10%/);
  // The rendered alert's nodes the progress touches.
  const attributes = node => Object.assign(node, { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  const nodes = {
    '[role="status"]': attributes({}),
    progress: attributes({ value: 10 }),
    '.on-page-alert__progress': { firstChild: { nodeValue: 'Download progress: 10%' } },
    '.on-page-alert__title': { textContent: 'Downloading update · 10%' },
  };
  holder.querySelector = selector => nodes[selector] ?? null;

  bridge.event('updates.state', downloading(42));
  assert.equal(holder.innerHTML, rendered);
  assert.equal(nodes.progress.value, 42);
  assert.equal(nodes.progress.attributes['aria-label'], 'Download progress: 42%');
  assert.equal(nodes['.on-page-alert__progress'].firstChild.nodeValue, 'Download progress: 42%');
  assert.equal(nodes['.on-page-alert__title'].textContent, 'Downloading update · 42%');
  // Screen readers wait while the download runs instead of reading every tick.
  assert.equal(nodes['[role="status"]'].attributes['aria-busy'], 'true');

  bridge.event('updates.state', { ...downloading(100), state: 'verifying' });
  assert.match(holder.innerHTML, /Verifying update…/);
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

test('a failure shows only the approved copy and retry, never the shell’s error or reason', async () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hash_mismatch']) {
    for (const failure of [{ error: name }, { error: 'check_failed', reason: name }, { error: name, reason: name, ...ready }]) {
      const { api } = await connected(update({ state: 'failed', ...failure }));
      const html = api.buildAndroidSettingsHtml(api.androidBridge.info);
      const alert = alertOf(html.slice(html.indexOf('data-android-update')));
      assert.equal(alert[1], 'error', name);
      assert.equal(text(alert[0]), 'Update failed. Try again Retry', name);
      assert.deepEqual(button(alert[0]), { label: 'Retry', disabled: false, action: failure.versionName ? 'download' : 'check' }, name);
    }
  }
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

test('without updates.manual.v1 the card shows only the version', async () => {
  const bridge = fakeBridge(() => ({ ...handshakePayload, capabilities: ['playback.native.v1'] }));
  const { api } = loadRuntime({ bridge });
  api.initAndroidSettings();
  await api.connectAndroidBridge();
  const html = api.buildAndroidSettingsHtml(api.androidBridge.info);
  const card = alertOf(html.slice(html.indexOf('data-android-update')))[0];
  assert.match(card, /Sandbox · 0\.9\.50 \(1\)/);
  assert.doesNotMatch(card, /<button|Check for updates/);
});

test('a card action sends its bridge command and shows the returned state', async () => {
  const { api, bridge, holder } = await connected(update(), {
    respond: message => ({ ok: true, updates: update({ state: 'checking' }), echo: message.name }),
  });
  const target = { disabled: false, getAttribute: () => 'check' };
  api.handleAndroidSettingsClick({ target: { closest: selector => (selector === '[data-android-update-action]' ? target : null) }, preventDefault() {} });
  assert.equal(target.disabled, true);
  await new Promise(setImmediate);
  const sent = bridge.sent.at(-1);
  assert.equal(sent.name, 'updates.check');
  assert.deepEqual(sent.payload, {});
  assert.equal(api.androidSettings.update.state, 'checking');
  assert.match(holder.innerHTML, /Checking for updates…/);
});

test('every card action maps to its own update command', async () => {
  for (const action of ['check', 'download', 'install']) {
    const { api, bridge } = await connected(update(), { respond: () => ({ ok: true, updates: update() }) });
    const target = { getAttribute: () => action };
    api.handleAndroidSettingsClick({ target: { closest: selector => (selector === '[data-android-update-action]' ? target : null) }, preventDefault() {} });
    await new Promise(setImmediate);
    assert.equal(bridge.sent.at(-1).name, `updates.${action}`);
  }
});

test('Installing… asks the shell to show an unanswered confirmation again, and an approved install keeps installing', async () => {
  const installing = update({ state: 'installing', ...ready });
  const { api, bridge, holder } = await connected(installing, {
    respond: () => ({ ok: false, error: { code: 'update_unavailable', message: 'Not available' } }),
  });
  const target = { getAttribute: () => 'install' };
  api.handleAndroidSettingsClick({ target: { closest: selector => (selector === '[data-android-update-action]' ? target : null) }, preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(bridge.sent.at(-1).name, 'updates.install');
  assert.equal(api.androidSettings.update.state, 'installing');
  assert.deepEqual(button(alertOf(holder.innerHTML)[0]), { label: 'Installing…', disabled: false, action: 'install' });
});

test('a refused command keeps the current state for the next event', async () => {
  const { api, holder } = await connected(update({ state: 'available', ...ready }), {
    respond: () => ({ ok: false, error: { code: 'update_unavailable', message: 'Not available' } }),
  });
  const target = { getAttribute: () => 'download' };
  api.handleAndroidSettingsClick({ target: { closest: selector => (selector === '[data-android-update-action]' ? target : null) }, preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(api.androidSettings.update.state, 'available');
  assert.match(holder.innerHTML, /data-android-update-action="download"/);
});

test('updates.state events from the shell replace the card state', async () => {
  const { api, bridge, holder } = await connected(update());
  bridge.event('updates.state', fixture.updateStateEvent.payload);
  assert.equal(api.androidSettings.update.progress, 42);
  assert.match(holder.innerHTML, /Downloading update · 42%/);
  bridge.event('updates.state', { nonsense: true });
  assert.equal(api.androidSettings.update.progress, 42);
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
  const { api, pane, state, handshakes } = flakyShell();
  await new Promise(setImmediate);
  assert.equal(handshakes(), 1);
  state.utility.activeTab = 'android';
  api.renderUtilityAndroid();
  assert.match(pane.detail.innerHTML, /data-on-page-alert="info".*Connecting to the app…/);
  assert.doesNotMatch(pane.detail.innerHTML, /could not connect/);
  await new Promise(setImmediate);
  assert.equal(handshakes(), 2);
  assert.doesNotMatch(pane.detail.innerHTML, /Connecting to the app/);
  assert.match(pane.detail.innerHTML, /Check for updates/);
  assert.match(pane.detail.innerHTML, /Connected to sandbox3\./);
});

test('a later handshake asked for by playback still gives Settings the update state', async () => {
  const { api, handshakes } = flakyShell();
  await new Promise(setImmediate);
  const info = await api.connectAndroidBridge();
  assert.equal(handshakes(), 2);
  assert.equal(api.androidSettings.update.state, 'idle');
  assert.match(api.buildAndroidSettingsHtml(info), /Check for updates/);
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
