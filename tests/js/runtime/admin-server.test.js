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
  const browse = element({ disabled: true, hasAttribute: (name) => name === 'data-path-input-browsable' });
  const fields = {
    '[data-preview-mode="album_folders"]': albumFolders,
    '[data-preview-mode="custom"]': custom,
    '[data-preview-path]': pathInput,
    '[data-preview-save]': save,
    '[data-preview-cancel]': cancel,
    '[data-preview-retry]': retry,
    '[data-preview-status]': status,
    '[data-preview-error]': error,
    '[data-preview-counts]': element({ hidden: true }),
    '[data-path-input-browse]': browse,
    '[data-preview-failure]': element({ hidden: true }),
  };
  const form = element();
  form.querySelector = selector => fields[selector] || null;
  form.querySelectorAll = selector => selector === '[data-preview-mode]' ? [albumFolders, custom] : [];
  const fetches = [];
  const polls = [];
  const dialogs = [];
  const responses = [initial];
  const context = vm.createContext({
    console,
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: selector => selector === '[data-admin-server]' ? form : null,
    },
    window: { confirm: () => { throw new Error('the browser confirm() is never used'); }, ButtonComponent: require('../../../music_app/static/js/button-component.js') },
    showAppFormDialog: async (options) => { dialogs.push(options); return options.onSubmit(); },
    setTimeout(callback, delay) { polls.push({ callback, delay }); return polls.length; },
    clearTimeout() {},
    fetch: async (url, options = {}) => {
      fetches.push({ url, options });
      const payload = responses.shift() || initial;
      return { ok: true, status: options.method === 'PUT' ? 202 : 200, json: async () => payload };
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { context, form, albumFolders, custom, pathInput, save, cancel, retry, status, error, browse, fetches, polls, dialogs };
}

const settleController = () => new Promise(resolve => setImmediate(resolve));

async function mount(ui, options) {
  const cleanup = ui.context.window.AlbumHavenMountAdminServer(ui.context.document, options);
  assert.equal(typeof cleanup, 'function');
  await settleController();
  return cleanup;
}

test('save stays disabled until a valid unsaved choice exists', async () => {
  const ui = runtime({
    mode: 'album_folders', revision: 4, operation_state: 'idle',
    total_count: 0, completed_count: 0, failed_count: 0, total_bytes: 0,
    inventory_count: 17, inventory_bytes: 4096,
  });

  const cleanup = ui.context.window.AlbumHavenMountAdminServer(ui.context.document);
  assert.equal(ui.save.disabled, true);
  await settleController();
  assert.equal(ui.save.disabled, true, 'the saved choice is not a change');
  const counts = ui.form.querySelector('[data-preview-counts]');
  assert.equal(counts.hidden, false);
  assert.equal(counts.textContent, '17 previews · 4.0 KB stored');

  ui.albumFolders.checked = false;
  ui.custom.checked = true;
  await ui.custom.listeners.get('change')();
  assert.equal(ui.pathInput.value, '', 'a special path is never filled in silently');
  assert.equal(ui.save.disabled, true, 'a special path without a folder cannot be saved');
  ui.pathInput.value = '   ';
  ui.pathInput.listeners.get('input')();
  assert.equal(ui.save.disabled, true);
  ui.pathInput.value = 'D:\Previews';
  ui.pathInput.listeners.get('input')();
  assert.equal(ui.save.disabled, false);

  ui.custom.checked = false;
  ui.albumFolders.checked = true;
  await ui.albumFolders.listeners.get('change')();
  assert.equal(ui.save.disabled, true, 'returning to the saved choice disables Save again');
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
  // Owner (11-09, UI-8): the proposed folder is the field's value, so Save is ready at once.
  assert.equal(ui.pathInput.value, 'C:\\Users\\Owner\\Documents\\Album Haven\\Generated Previews');
  assert.equal(ui.save.disabled, false);
  // UI-7: the browse button rendered with aria-disabled="true" is enabled for real, not only its property.
  assert.equal(ui.browse.disabled, false);
  assert.equal(ui.browse['aria-disabled'], 'false');

  ui.custom.checked = false;
  ui.albumFolders.checked = true;
  await ui.albumFolders.listeners.get('change')();
  assert.equal(ui.pathInput.disabled, true);
  assert.equal(ui.pathInput.value, '');
  ui.albumFolders.checked = false;
  ui.custom.checked = true;
  await ui.custom.listeners.get('change')();

  ui.pathInput.value = 'D:\\Album previews';
  ui.pathInput.listeners.get('input')();
  await ui.form.listeners.get('submit')({ preventDefault() {} });
  const request = ui.fetches.at(-1);
  assert.equal(request.url, '/admin/server/preview-storage');
  assert.equal(request.options.method, 'PUT');
  assert.deepEqual(JSON.parse(request.options.body), {
    mode: 'custom', path: 'D:\\Album previews', expected_revision: 4, confirmed: true,
  });
  // Owner (11-09): the app's own dialog asks, never the browser's confirm(); Cancel moves nothing.
  assert.equal(ui.dialogs.length, 1);
  assert.equal(ui.dialogs[0].title, 'Move album previews');
  assert.equal(ui.dialogs[0].submitLabel, 'Move previews');
  const sent = ui.fetches.length;
  ui.save.disabled = false;
  ui.context.showAppFormDialog = async () => null;
  await ui.form.listeners.get('submit')({ preventDefault() {} });
  assert.equal(ui.fetches.length, sent, 'cancelled: no request');
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
  assert.match(ui.form.querySelector('[data-preview-counts]').textContent, /4 of 10 moved · 0 failed/);
  assert.equal(ui.save.disabled, true);
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

test('completed relocation with failures permits choosing a new destination', async () => {
  const ui = runtime({
    mode: 'album_folders', requested_mode: 'album_folders', revision: 9,
    operation_state: 'completed_with_failures', operation_id: 'operation-1',
    total_count: 10, completed_count: 9, failed_count: 1,
    total_bytes: 1000, completed_bytes: 900,
    failure_summary: [{ item_id: 4, error: 'Source preview disappeared' }],
    suggested_path: 'C:\\Previews',
  });
  await mount(ui);

  assert.equal(ui.albumFolders.disabled, false);
  assert.equal(ui.custom.disabled, false);
  assert.equal(ui.retry.hidden, false);

  ui.albumFolders.checked = false;
  ui.custom.checked = true;
  await ui.custom.listeners.get('change')();
  assert.equal(ui.pathInput.disabled, false);
  ui.pathInput.value = 'E:\Previews';
  ui.pathInput.listeners.get('input')();
  assert.equal(ui.save.disabled, false);
});

test('folder browse fills the special path and is disabled for album folders', async () => {
  const ui = runtime({
    mode: 'album_folders', revision: 3, operation_state: 'idle',
    total_count: 0, completed_count: 0, failed_count: 0, suggested_path: 'C:\Previews',
  });
  const chosen = [];
  await mount(ui, { chooseFolder: async settings => { chosen.push(settings.title); return 'F:/Album previews'; } });

  assert.equal(ui.browse.disabled, true, 'album folders keep the folder picker disabled');
  ui.albumFolders.checked = false;
  ui.custom.checked = true;
  await ui.custom.listeners.get('change')();
  assert.equal(ui.browse.disabled, false);
  await ui.browse.listeners.get('click')({ preventDefault() {} });
  assert.deepEqual(chosen, ['Choose server folder']);
  assert.equal(ui.pathInput.value, 'F:/Album previews');
  assert.equal(ui.save.disabled, false);
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

test('folder browse stays disabled without the browse permission', async () => {
  const ui = runtime({ mode: 'custom', requested_root: 'C:/Previews', revision: 2, operation_state: 'idle' });
  ui.browse.hasAttribute = () => false;
  await mount(ui);
  assert.equal(ui.custom.checked, true);
  assert.equal(ui.pathInput.disabled, false);
  assert.equal(ui.browse.disabled, true);
});

test('an unfinished move shows where previews live now and why the switch has not happened', async () => {
  // Owner (11-10): "what do you mean it never did?" Special path looked chosen while previews still lived in
  // the album folders, because 148 files failed and the move never switched.
  const ui = runtime({
    mode: 'album_folders', active_root: null,
    requested_mode: 'custom', requested_root: 'C:\Users\Owner\Documents\Album Haven\Generated Previews',
    revision: 12, operation_state: 'completed_with_failures', operation_id: 'operation-2',
    total_count: 14310, completed_count: 14162, failed_count: 148,
    total_bytes: 1000, completed_bytes: 900,
    cache_cleanup: { cleaned_count: 14058, kept_count: 2, left_count: 1 },
    suggested_path: 'C:\Previews',
  });
  await mount(ui);

  assert.equal(ui.albumFolders.checked, true, 'the album folders are still in use');
  assert.equal(ui.custom.checked, false);
  assert.equal(ui.pathInput.value, '');
  assert.equal(ui.status.hidden, false);
  assert.equal(ui.status.textContent,
    "Moving to C:\Users\Owner\Documents\Album Haven\Generated Previews: 148 files failed. The switch happens after they're retried.");
  assert.equal(ui.retry.hidden, false);
  assert.equal(ui.retry.textContent, 'Retry failed files');
  // Owner (11-09): the move reports the album folders' .album-haven folders it cleaned, kept and left.
  assert.match(ui.form.querySelector('[data-preview-counts]').textContent,
    / · cleaned up 14058 cache folders · 2 kept \(they hold other files\) · 1 left for later \(drive unavailable\)$/);
});

const unfinishedMove = (overrides = {}) => ({
  mode: 'album_folders', active_root: null, requested_mode: 'custom', requested_root: 'C:\Previews',
  revision: 12, operation_state: 'completed_with_failures', operation_id: 'operation-2',
  total_count: 14310, completed_count: 14162, failed_count: 148, total_bytes: 1000, completed_bytes: 900,
  suggested_path: 'C:\Previews', ...overrides,
});

test('Retry failed files reacts at once, shows progress and ends with a readable result', async () => {
  // Owner (11-10): "I clicked Retry failed files - but saw no reaction to that click on UI - change that."
  const ui = runtime(unfinishedMove());
  let answerRetry;
  const answers = [];
  const request = async (url, options = {}) => {
    if (url.endsWith('/retry')) {
      return new Promise((resolve) => { answerRetry = resolve; });
    }
    const payload = answers.shift() || unfinishedMove();
    return { ok: true, status: 200, json: async () => payload };
  };
  await mount(ui, { request });

  const clicked = ui.retry.listeners.get('click')();
  assert.equal(ui.retry.disabled, true);
  assert.equal(ui.retry['aria-busy'], 'true', 'the shared Button shows it is working');
  assert.equal(ui.status.textContent, 'Retrying 148 files…');

  answerRetry({ ok: true, status: 202, json: async () => unfinishedMove({ operation_state: 'running', completed_count: 14200, failed_count: 0 }) });
  await clicked;
  assert.equal(ui.status.textContent, 'Moving to C:\Previews: 14200 of 14310 files done…');

  answers.push(unfinishedMove({
    mode: 'custom', active_root: 'C:\Previews', requested_mode: null, requested_root: null,
    operation_state: 'completed', completed_count: 14310, failed_count: 0, regenerate_later_count: 148,
  }));
  await ui.polls.at(-1).callback();
  await settleController();
  assert.equal(ui.status.textContent, 'Done: switched to C:\Previews. 148 set to be rebuilt.');
  assert.equal(ui.custom.checked, true);
  assert.equal(ui.retry.hidden, true);
});

test('a refused retry says why and frees the button', async () => {
  const ui = runtime(unfinishedMove());
  const request = async (url) => (url.endsWith('/retry')
    ? { ok: false, status: 403, json: async () => ({ detail: 'CSRF validation failed.' }) }
    : { ok: true, status: 200, json: async () => unfinishedMove() });
  await mount(ui, { request });

  await ui.retry.listeners.get('click')();

  assert.equal(ui.error.hidden, false);
  assert.equal(ui.error.textContent, 'Your session changed. Reload the page and try again.');
  assert.equal(ui.retry.disabled, false);
  assert.equal(ui.retry['aria-busy'], undefined);
});
