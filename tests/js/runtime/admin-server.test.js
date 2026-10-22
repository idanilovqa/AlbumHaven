const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'admin-server.js',
);

function element(initial = {}) {
  const listeners = new Map();
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    value: '',
    checked: false,
    dataset: {},
    ...initial,
    listeners,
    addEventListener(name, callback) { listeners.set(name, callback); },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
  };
}

function runtime(initial = {}) {
  const albumFolders = element({ value: 'album_folders', checked: true });
  const custom = element({ value: 'custom' });
  const pathInput = element({ disabled: true });
  const save = element();
  const cancel = element({ hidden: true });
  const retry = element({ hidden: true });
  const status = element({ hidden: true });
  const error = element({ hidden: true });
  const progress = element({ value: 0, max: 1 });
  const fields = {
    '[data-preview-mode="album_folders"]': albumFolders,
    '[data-preview-mode="custom"]': custom,
    '[data-preview-path]': pathInput,
    '[data-preview-save]': save,
    '[data-preview-cancel]': cancel,
    '[data-preview-retry]': retry,
    '[data-preview-status]': status,
    '[data-preview-error]': error,
    '[data-preview-progress]': progress,
    '[data-preview-counts]': element(),
    '[data-preview-location]': element(),
    '[data-preview-failure]': element({ hidden: true }),
  };
  const form = element();
  form.querySelector = selector => fields[selector] || null;
  form.querySelectorAll = selector => selector === '[data-preview-mode]' ? [albumFolders, custom] : [];
  const fetches = [];
  const polls = [];
  const responses = [initial];
  const context = vm.createContext({
    console,
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: selector => selector === '[data-admin-server]' ? form : null,
    },
    window: { confirm: () => true },
    setTimeout(callback, delay) { polls.push({ callback, delay }); return polls.length; },
    clearTimeout() {},
    fetch: async (url, options = {}) => {
      fetches.push({ url, options });
      const payload = responses.shift() || initial;
      return { ok: true, status: options.method === 'PUT' ? 202 : 200, json: async () => payload };
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { context, form, albumFolders, custom, pathInput, save, cancel, retry, status, error, progress, fetches, polls };
}

const settleController = () => new Promise(resolve => setImmediate(resolve));

async function mount(ui, options) {
  const cleanup = ui.context.window.AlbumHavenMountAdminServer(ui.context.document, options);
  assert.equal(typeof cleanup, 'function');
  await settleController();
  return cleanup;
}

test('save stays disabled until initial server state loads', async () => {
  const ui = runtime({
    mode: 'album_folders', revision: 4, operation_state: 'idle',
    total_count: 0, completed_count: 0, failed_count: 0, total_bytes: 0,
    inventory_count: 17, inventory_bytes: 4096,
  });

  const cleanup = ui.context.window.AlbumHavenMountAdminServer(ui.context.document);
  assert.equal(ui.save.disabled, true);
  await settleController();
  assert.equal(ui.save.disabled, false);
  assert.match(ui.form.querySelector('[data-preview-counts]').textContent, /17 previews · 4\.0 KB stored/);
  cleanup();
});

test('mode choice controls the server-path field and save payload', async () => {
  const ui = runtime({
    mode: 'album_folders', active_root: null, revision: 4,
    operation_state: 'idle', total_count: 12, completed_count: 0,
    failed_count: 0, total_bytes: 2048, completed_bytes: 0,
    suggested_path: 'C:\\Users\\Owner\\Documents\\Album Haven\\Generated Previews',
  });
  await mount(ui);

  assert.equal(ui.pathInput.disabled, true);
  ui.albumFolders.checked = false;
  ui.custom.checked = true;
  await ui.custom.listeners.get('change')();
  assert.equal(ui.pathInput.disabled, false);
  assert.equal(ui.pathInput.value, 'C:\\Users\\Owner\\Documents\\Album Haven\\Generated Previews');

  ui.custom.checked = false;
  ui.albumFolders.checked = true;
  await ui.albumFolders.listeners.get('change')();
  assert.equal(ui.pathInput.disabled, true);
  assert.equal(ui.pathInput.value, '');
  ui.albumFolders.checked = false;
  ui.custom.checked = true;
  await ui.custom.listeners.get('change')();

  ui.pathInput.value = 'D:\\Album previews';
  await ui.form.listeners.get('submit')({ preventDefault() {} });
  const request = ui.fetches.at(-1);
  assert.equal(request.url, '/admin/server/preview-storage');
  assert.equal(request.options.method, 'PUT');
  assert.deepEqual(JSON.parse(request.options.body), {
    mode: 'custom', path: 'D:\\Album previews', expected_revision: 4, confirmed: true,
  });
});

test('active relocation polls a bounded status request and exposes cancel', async () => {
  const ui = runtime({
    mode: 'album_folders', revision: 7, operation_state: 'running',
    operation_id: 'operation-1', total_count: 10, completed_count: 4,
    failed_count: 0, total_bytes: 1000, completed_bytes: 400,
    suggested_path: 'C:\\Previews',
  });
  const cleanup = await mount(ui);

  assert.equal(ui.cancel.hidden, false);
  assert.equal(ui.retry.hidden, true);
  assert.equal(ui.progress.value, 4);
  assert.equal(ui.progress.max, 10);
  assert.equal(ui.polls.length, 1);
  assert.equal(ui.polls[0].delay, 2000);

  await ui.cancel.listeners.get('click')();
  assert.equal(ui.fetches.at(-1).url, '/admin/server/preview-storage/cancel');
  assert.equal(ui.fetches.at(-1).options.method, 'POST');
  cleanup();
});

test('failed terminal relocation exposes retry without continued polling', async () => {
  const ui = runtime({
    mode: 'custom', active_root: 'C:\\Previews', revision: 8,
    operation_state: 'failed', operation_id: 'operation-1',
    total_count: 10, completed_count: 8, failed_count: 2,
    total_bytes: 1000, completed_bytes: 800,
    failure_summary: [{ item_id: 4, error: 'Target disk is full' }],
    suggested_path: 'C:\\Previews',
  });
  await mount(ui);

  assert.equal(ui.retry.hidden, false);
  assert.equal(ui.cancel.hidden, true);
  assert.match(ui.form.querySelector('[data-preview-counts]').textContent, /1000 B/);
  assert.equal(ui.form.querySelector('[data-preview-failure]').hidden, false);
  assert.match(ui.form.querySelector('[data-preview-failure]').textContent, /Target disk is full/);
  assert.equal(ui.polls.length, 0);
  await ui.retry.listeners.get('click')();
  assert.equal(ui.fetches.at(-1).url, '/admin/server/preview-storage/retry');
});

test('canceled relocation offers resume so moved bytes can be reconciled', async () => {
  const ui = runtime({
    mode: 'album_folders', requested_mode: 'custom', requested_root: 'C:\\Previews',
    revision: 8, operation_state: 'canceled', operation_id: 'operation-1',
    total_count: 10, completed_count: 4, failed_count: 0,
    total_bytes: 1000, completed_bytes: 400, suggested_path: 'C:\\Previews',
  });
  await mount(ui);

  assert.equal(ui.retry.hidden, false);
  assert.equal(ui.retry.textContent, 'Resume move');
  assert.equal(ui.save.disabled, true);
  assert.equal(ui.custom.disabled, true);
  assert.equal(ui.polls.length, 0);
});

test('active relocation retries polling after a transient status failure', async () => {
  const state = {
    mode: 'album_folders', revision: 7, operation_state: 'running',
    operation_id: 'operation-1', total_count: 10, completed_count: 4,
    failed_count: 0, total_bytes: 1000, completed_bytes: 400,
    suggested_path: 'C:\\Previews',
  };
  const ui = runtime(state);
  let requests = 0;
  const request = async () => {
    requests += 1;
    if (requests === 2) throw new Error('Temporary network failure');
    return { ok: true, status: 200, json: async () => state };
  };
  const cleanup = await mount(ui, { request });

  assert.equal(ui.polls.length, 1);
  await ui.polls[0].callback();
  assert.equal(ui.polls.length, 2);
  cleanup();
});
