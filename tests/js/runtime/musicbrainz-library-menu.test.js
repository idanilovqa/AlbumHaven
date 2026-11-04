const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');
const statusSource = fs.readFileSync(
  path.join(repoRoot, 'music_app/static/js/runtime/status-ui-helpers.js'),
  'utf8',
);
const galleryEventsSource = fs.readFileSync(
  path.join(repoRoot, 'music_app/static/js/runtime/bootstrap-gallery-event-handlers.js'),
  'utf8',
);

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function element() {
  const attributes = new Map();
  return {
    hidden: false,
    disabled: false,
    innerHTML: '',
    textContent: '',
    dataset: {},
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    querySelector() { return null; },
  };
}

function loadStatusMenu({ allowed = true } = {}) {
  const requests = [];
  const alertConfigs = [];
  const syncButton = element();
  const feedback = element();
  let menu = null;
  let pendingResponse = null;
  let rescanCalls = 0;
  const context = {
    console,
    state: {
      status: {
        allowed_actions: allowed ? { 'catalogue.enrichment.request': true } : {},
      },
      ui: {},
    },
    ButtonComponent: {
      renderButton({ label, attributes = {} }) {
        const attrs = Object.entries(attributes)
          .map(([name, value]) => `${name}="${value}"`)
          .join(' ');
        return `<button ${attrs}><span class="ui-button__content">${label}</span></button>`;
      },
    },
    buildSmallAlertHtml(config) {
      alertConfigs.push({ ...config });
      return `<span class="small-alert small-alert--${config.severity}">${config.message}</span>`;
    },
    document: {
      body: { appendChild(node) { menu = node; } },
      createElement() {
        const node = element();
        node.querySelector = (selector) => ({
          '[data-status-role="musicbrainz-sync"]': syncButton,
          '[data-status-role="musicbrainz-feedback"]': feedback,
        }[selector] || null);
        return node;
      },
      getElementById(id) { return id === 'status-context-menu' ? menu : null; },
    },
    fetch(url, options = {}) {
      pendingResponse = deferred();
      requests.push({ url, options });
      return pendingResponse.promise;
    },
    triggerLibraryRefresh() { rescanCalls += 1; },
  };
  vm.createContext(context);
  vm.runInContext(statusSource, context, { filename: 'status-ui-helpers.js' });
  return {
    alertConfigs,
    context,
    feedback,
    get menu() { return menu; },
    release(payload, status = 202) {
      pendingResponse.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
      });
    },
    requests,
    rescanCalls: () => rescanCalls,
    syncButton,
  };
}

test('primary-owner capability adds MusicBrainz sync to the existing anchored Library menu only', () => {
  const authorized = loadStatusMenu({ allowed: true });
  authorized.context.ensureStatusContextMenu();
  assert.equal(authorized.menu.id, 'status-context-menu');
  assert.equal(authorized.menu.className, 'gallery-anchored-menu');
  assert.match(authorized.menu.innerHTML, /data-status-role="musicbrainz-sync"/);
  assert.match(authorized.menu.innerHTML, /data-status-action="musicbrainz-sync"/);
  assert.match(authorized.menu.innerHTML, />MusicBrainz sync</);
  assert.match(authorized.menu.innerHTML, /data-status-role="musicbrainz-feedback"/);

  const denied = loadStatusMenu({ allowed: false });
  denied.context.ensureStatusContextMenu();
  assert.doesNotMatch(denied.menu.innerHTML, /musicbrainz-sync/i);
  assert.equal((statusSource.match(/menu\.id\s*=\s*['"]status-context-menu['"]/g) || []).length, 1);
  assert.doesNotMatch(statusSource, /createElement\(['"](?:dialog|aside)['"]\)[\s\S]*MusicBrainz sync/i);
});

test('MusicBrainz sync is a disabled single-flight artist-only POST and never starts a file rescan', async () => {
  const run = loadStatusMenu({ allowed: true });
  run.context.ensureStatusContextMenu();
  assert.equal(typeof run.context.triggerMusicBrainzArtistSync, 'function');

  const first = run.context.triggerMusicBrainzArtistSync();
  const second = run.context.triggerMusicBrainzArtistSync();
  assert.equal(run.requests.length, 1, 'repeat activation must reuse the active request');
  assert.equal(run.syncButton.disabled, true);
  assert.equal(run.syncButton.getAttribute('aria-disabled'), 'true');
  assert.equal(run.requests[0].url, '/api/musicbrainz/artists/sync');
  assert.equal(run.requests[0].options.method, 'POST');
  assert.equal(run.requests[0].options.body, undefined, 'the server derives actor and library scope');
  assert.equal(run.rescanCalls(), 0);

  run.release({ enqueued_count: 4 });
  await Promise.all([first, second]);
  assert.equal(run.syncButton.disabled, false);
  assert.equal(run.syncButton.getAttribute('aria-disabled'), 'false');
  assert.equal(run.rescanCalls(), 0);
  assert.equal(run.alertConfigs.at(-1)?.severity, 'info');
  assert.match(run.alertConfigs.at(-1)?.message || '', /4 artists/i);
  assert.match(run.feedback.innerHTML, /small-alert--info/);
});

test('MusicBrainz sync failure uses shared SmallAlert feedback and re-enables the existing action', async () => {
  const run = loadStatusMenu({ allowed: true });
  run.context.ensureStatusContextMenu();
  const request = run.context.triggerMusicBrainzArtistSync();
  run.release({ detail: 'MusicBrainz provider unavailable.' }, 503);
  assert.equal(await request, false);

  assert.equal(run.syncButton.disabled, false);
  assert.equal(run.alertConfigs.at(-1)?.severity, 'error');
  assert.match(run.alertConfigs.at(-1)?.message || '', /MusicBrainz provider unavailable/);
  assert.match(run.feedback.innerHTML, /small-alert--error/);
  assert.equal(run.rescanCalls(), 0);
});

test('the existing delegated Gallery handler owns MusicBrainz sync activation', () => {
  assert.match(galleryEventsSource, /data-status-action=["']musicbrainz-sync["']/);
  assert.match(galleryEventsSource, /triggerMusicBrainzArtistSync\s*\(/);
  assert.doesNotMatch(galleryEventsSource, /musicbrainz-sync[\s\S]{0,300}triggerLibraryRefresh\s*\(/);
});

