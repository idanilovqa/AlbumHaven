const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const runtimeDir = path.resolve(__dirname, '../../../music_app/static/js/runtime');
const drawerSource = fs.readFileSync(path.join(runtimeDir, 'cover-lookup-modal-and-drawer.js'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(runtimeDir, 'bootstrap-init.js'), 'utf8');

test('cold startup hydrates only the notification badge without opening the drawer', async () => {
  const requests = [];
  const body = { innerHTML: 'not loaded' };
  const badge = { hidden: true, textContent: '' };
  const buttonClasses = new Set();
  const context = {
    console,
    ButtonComponent: { renderActionButton: () => '' },
    state: { coverLookup: { tasks: [], modal: {}, drawerOpen: false } },
    window: { AlbumHavenCapabilities: { allows: action => action === 'library.covers.tasks.read' } },
    document: { getElementById: id => ({
      'cover-lookup-drawer-body': body,
      'cover-lookup-drawer-badge': badge,
      'cover-lookup-drawer-button': {
        classList: { toggle(name, enabled) { enabled ? buttonClasses.add(name) : buttonClasses.delete(name); } },
      },
    }[id] || null) },
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ ok: true, summary: { badge_count: 3 } }) };
    },
  };
  vm.createContext(context);
  vm.runInContext(drawerSource, context, { filename: 'cover-lookup-modal-and-drawer.js' });

  assert.equal(typeof context.loadCoverLookupTaskSummary, 'function');
  await context.loadCoverLookupTaskSummary();

  assert.deepEqual(requests, ['/utilities/cover-lookup/tasks?summary=1']);
  assert.equal(body.innerHTML, 'not loaded');
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '3');
  assert.equal(buttonClasses.has('has-active-lookups'), true);
  assert.match(bootstrapSource, /void loadCoverLookupTaskSummary\(\);/);
});

test('unauthorized startup does not request notification counts', async () => {
  let requests = 0;
  const context = {
    console,
    ButtonComponent: { renderActionButton: () => '' },
    state: { coverLookup: { tasks: [], modal: {}, drawerOpen: false } },
    window: { AlbumHavenCapabilities: { allows: () => false } },
    document: { getElementById: () => null },
    fetch: async () => { requests += 1; throw new Error('must not fetch'); },
  };
  vm.createContext(context);
  vm.runInContext(drawerSource, context, { filename: 'cover-lookup-modal-and-drawer.js' });

  assert.equal(await context.loadCoverLookupTaskSummary(), false);
  assert.equal(requests, 0);
});

test('an older startup count cannot overwrite a newer local task render', async () => {
  let resolveFetch;
  const badge = { hidden: true, textContent: '' };
  const context = {
    console,
    ButtonComponent: { renderActionButton: () => '' },
    state: { coverLookup: { tasks: [], modal: {}, drawerOpen: false, elapsedTimer: 0 } },
    window: { AlbumHavenCapabilities: { allows: () => true }, setInterval: () => 1, clearInterval() {} },
    document: {
      activeElement: null,
      querySelectorAll: () => [],
      getElementById: id => ({
        'cover-lookup-drawer': { hidden: true, classList: { contains: () => false, toggle() {} } },
        'cover-lookup-drawer-body': { innerHTML: '' },
        'cover-lookup-drawer-badge': badge,
        'cover-lookup-drawer-button': { classList: { toggle() {} } },
        'cover-lookup-drawer-clear': { hidden: false, disabled: false, setAttribute() {} },
        'cover-lookup-drawer-summary': { textContent: '' },
        'cover-lookup-modal': { hidden: true },
      }[id] || null),
    },
    fetch: () => new Promise(resolve => { resolveFetch = resolve; }),
  };
  vm.createContext(context);
  vm.runInContext(drawerSource, context, { filename: 'cover-lookup-modal-and-drawer.js' });

  const startup = context.loadCoverLookupTaskSummary();
  context.renderCoverLookupDrawer({ preserveInteraction: false });
  resolveFetch({ ok: true, json: async () => ({ ok: true, summary: { badge_count: 4 } }) });

  assert.equal(await startup, false);
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, '');
});
