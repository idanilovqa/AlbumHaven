const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'admin-members.js',
);

function element(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    listeners,
    attributes: { ...(initial.attributes || {}) },
    addEventListener(name, callback) { listeners.set(name, callback); },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    contains(target) { return target === this || (this.children || []).includes(target); },
    async click() {
      return this.listeners.get('click')?.({ currentTarget: this, target: this });
    },
  };
}

function loadRuntime({ mode = 'create', active = true, libraryAccess = true } = {}) {
  const password = element({ type: 'password', focused: false });
  const toggle = element({ dataset: { passwordToggle: 'admin-new-password' }, textContent: 'Show' });
  const submit = element({ disabled: false });
  const error = element({ hidden: true, textContent: '' });
  const status = element({ hidden: true, textContent: '' });
  const reset = element({ dataset: { adminAction: 'reset' }, disabled: false });
  const welcome = element({ dataset: { adminAction: 'welcome' }, disabled: false });
  const form = element({
    dataset: {
      mode,
      initialActive: 'true',
      initialLibraryAccess: 'true',
    },
    checkValidity: () => true,
    reportValidity: () => {},
    elements: {
      username: { value: 'listener.plus' },
      contact_email: { value: 'listener+phase7@example.test' },
      send_invitation: { checked: false },
    },
    querySelector: (selector) => {
      if (selector === 'button[type="submit"]') return submit;
      if (selector === '[name="is_active"]') return { checked: active };
      return null;
    },
    querySelectorAll: (selector) => (
      selector === '[data-admin-action]' && mode === 'edit' ? [reset, welcome] : []
    ),
    parentElement: {
      querySelector: (selector) => (
        selector === '[data-admin-form-status]' ? status : error
      ),
    },
  });
  const values = new Map([
    ['username', 'listener.plus'],
    ['contact_email', 'listener+phase7@example.test'],
    ['password', 'private passphrase'],
    ['csrf_token', 'csrf-value'],
    ['account_id', '41'],
    ['is_active', active ? 'on' : ''],
    ['current_library_access', libraryAccess ? 'on' : ''],
  ]);
  const fetches = [];
  let assigned = '';
  class FakeFormData {
    get(key) { return values.get(key) || null; }
    getAll(key) {
      return key === 'capability_keys'
        ? (mode === 'create'
          ? ['library.browse.read']
          : ['library.browse.read', 'library.media.read'])
        : [];
    }
  }
  const context = vm.createContext({
    FormData: FakeFormData,
    fetch: async (...args) => {
      fetches.push(args);
      return { ok: true, json: async () => ({ account_id: 42 }) };
    },
    window: {
      confirm: () => true,
      location: { assign: (value) => { assigned = value; } },
    },
    document: {
      querySelectorAll: () => [toggle],
      getElementById: (id) => (id === 'admin-new-password' ? password : null),
      querySelector: (selector) => (selector === '[data-admin-account-form]' ? form : null),
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return {
    password, toggle, submit, error, status, reset, welcome, form, fetches,
    assigned: () => assigned,
  };
}

function loadRosterRuntime({ clipboardReject = false, reauthOnFirstCopy = false } = {}) {
  const menuButton = element({
    dataset: { memberMenuTrigger: '41' },
    attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
  });
  const copyInvite = element({ dataset: { copyInvitation: '41' } });
  const sendInvite = element({ dataset: { sendInvitation: '41' } });
  const edit = element();
  const menu = element({
    dataset: { memberMenu: '41' },
    hidden: true,
    children: [copyInvite, sendInvite, edit],
  });
  menu.querySelector = (selector) => (selector === '[role="menuitem"]' ? copyInvite : null);
  const status = element({ hidden: true, textContent: '' });
  const error = element({ hidden: true, textContent: '' });
  const fallbackInput = element({ value: '', readOnly: true, focused: false, selected: false });
  const fallbackManual = element();
  const fallbackDismiss = element();
  const fallback = element({ hidden: true });
  const reauthPanel = element({ hidden: true });
  const reauthPassword = element({ value: '', focused: false });
  const reauthSubmit = element();
  const reauthCancel = element();
  const roster = element({ dataset: { csrfToken: 'roster-csrf' } });
  roster.querySelector = (selector) => ({
    '[data-admin-roster-status]': status,
    '[data-admin-roster-error]': error,
    '[data-invitation-copy-fallback]': fallback,
    '[data-invitation-copy-value]': fallbackInput,
    '[data-invitation-copy-manual]': fallbackManual,
    '[data-invitation-copy-dismiss]': fallbackDismiss,
    '[data-roster-reauth-panel]': reauthPanel,
    '[data-roster-reauth-password]': reauthPassword,
    '[data-roster-reauth-submit]': reauthSubmit,
    '[data-roster-reauth-cancel]': reauthCancel,
  }[selector] || null);

  const fetches = [];
  const documentListeners = new Map();
  let copyAttempts = 0;
  let successfulCopies = 0;
  const clipboard = {
    reject: clipboardReject,
    value: '',
    async writeText(value) {
      if (this.reject) throw new Error('clipboard unavailable');
      this.value = value;
    },
  };
  const context = vm.createContext({
    FormData: class {},
    fetch: async (url, options) => {
      fetches.push({ url, options });
      if (url.endsWith('/invitation/copy')) {
        copyAttempts += 1;
        if (reauthOnFirstCopy && copyAttempts === 1) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ detail: 'Recent authentication is required.' }),
          };
        }
        successfulCopies += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            invitation_url: successfulCopies === 1
              ? 'https://example.test/accept-invitation?token=rotated'
              : 'https://example.test/accept-invitation?token=newer',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
    navigator: { clipboard },
    window: { location: { assign() {} } },
    document: {
      addEventListener(name, callback) { documentListeners.set(name, callback); },
      querySelectorAll(selector) {
        if (selector === '[data-password-toggle]') return [];
        if (selector === '[data-member-menu-trigger]') return [menuButton];
        if (selector === '[data-copy-invitation]') return [copyInvite];
        if (selector === '[data-send-invitation]') return [sendInvite];
        if (selector === '[data-member-menu]:not([hidden])') {
          return menu.hidden ? [] : [menu];
        }
        return [];
      },
      querySelector(selector) {
        if (selector === '[data-admin-roster]') return roster;
        if (selector === '[data-admin-account-form]') return null;
        if (selector === '[data-member-menu="41"]') return menu;
        if (selector === '[data-member-menu-trigger="41"]') return menuButton;
        return null;
      },
      getElementById() { return null; },
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return {
    row: { menuButton, menu, copyInvite, sendInvite },
    status,
    error,
    fallback: { panel: fallback, input: fallbackInput, manual: fallbackManual, dismiss: fallbackDismiss },
    reauth: { panel: reauthPanel, password: reauthPassword, submit: reauthSubmit, cancel: reauthCancel },
    clipboard,
    fetches,
    documentListeners,
    outside: element(),
  };
}

test('admin add-user password toggle preserves accessible pressed state', () => {
  const runtime = loadRuntime();

  runtime.toggle.listeners.get('click')();

  assert.equal(runtime.password.type, 'text');
  assert.equal(runtime.password.focused, true);
  assert.equal(runtime.toggle.attributes['aria-pressed'], 'true');
});

test('admin add-user form sends only the bounded JSON contract with session CSRF', async () => {
  const runtime = loadRuntime();

  await runtime.form.listeners.get('submit')({ preventDefault() {} });

  assert.equal(runtime.fetches.length, 1);
  const [url, options] = runtime.fetches[0];
  assert.equal(url, '/admin/accounts');
  assert.equal(options.headers['X-Album-Haven-CSRF'], 'csrf-value');
  assert.deepEqual(JSON.parse(options.body), {
    username: 'listener.plus',
    contact_email: 'listener+phase7@example.test',
    capability_keys: ['library.browse.read'],
    send_invitation: false,
  });
  assert.equal(runtime.assigned(), '/admin/members?created=1');
});

test('admin edit form confirms destructive state and sends the bounded patch contract', async () => {
  const runtime = loadRuntime({ mode: 'edit', active: false, libraryAccess: true });

  await runtime.form.listeners.get('submit')({ preventDefault() {} });

  const [url, options] = runtime.fetches[0];
  assert.equal(url, '/admin/accounts/41');
  assert.equal(options.method, 'PATCH');
  assert.deepEqual(JSON.parse(options.body), {
    is_active: false,
    current_library_access: true,
    capability_keys: ['library.browse.read', 'library.media.read'],
    confirm_disable: true,
    confirm_remove_access: false,
  });
  assert.equal(runtime.assigned(), '/admin/members');
});

test('admin mail actions use distinct endpoints and show ambiguous delivery status', async () => {
  const runtime = loadRuntime({ mode: 'edit' });

  await runtime.reset.listeners.get('click')();
  await runtime.welcome.listeners.get('click')();

  assert.deepEqual(runtime.fetches.map(([url]) => url), [
    '/admin/accounts/41/password-reset',
    '/admin/accounts/41/welcome',
  ]);
  assert.deepEqual(runtime.fetches.map(([, options]) => JSON.parse(options.body)), [{}, {}]);
  assert.match(runtime.status.textContent, /If delivery is available/);
  assert.equal(runtime.status.hidden, false);
});

test('admin roster three-dot menu is accessible and closes on Escape outside pointer and focusout', async () => {
  const runtime = loadRosterRuntime();
  const { row } = runtime;

  assert.equal(row.menuButton.getAttribute('aria-haspopup'), 'menu');
  await row.menuButton.click();
  assert.equal(row.menuButton.getAttribute('aria-expanded'), 'true');
  assert.equal(row.menu.hidden, false);
  assert.equal(row.copyInvite.focused, true);

  row.menu.listeners.get('keydown')({ key: 'Escape' });
  assert.equal(row.menu.hidden, true);
  assert.equal(row.menuButton.getAttribute('aria-expanded'), 'false');
  assert.equal(row.menuButton.focused, true);

  await row.menuButton.click();
  runtime.documentListeners.get('pointerdown')({ target: runtime.outside });
  assert.equal(row.menu.hidden, true);

  await row.menuButton.click();
  row.menu.listeners.get('focusout')({ relatedTarget: runtime.outside });
  assert.equal(row.menu.hidden, true);
});

test('admin roster copy and send invitation actions use distinct endpoints with clipboard fallback', async () => {
  const runtime = loadRosterRuntime();
  const { row, clipboard, fallback } = runtime;

  await row.menuButton.click();
  await row.copyInvite.click();
  assert.equal(runtime.fetches[0].url, '/admin/accounts/41/invitation/copy');
  assert.deepEqual(JSON.parse(runtime.fetches[0].options.body), {});
  assert.equal(runtime.fetches[0].options.headers['X-Album-Haven-CSRF'], 'roster-csrf');
  assert.equal(
    clipboard.value,
    'https://example.test/accept-invitation?token=rotated',
  );
  assert.match(runtime.status.textContent, /Older links no longer work/);

  clipboard.reject = true;
  await row.copyInvite.click();
  assert.equal(fallback.panel.hidden, false);
  assert.equal(fallback.input.readOnly, true);
  assert.equal(
    fallback.input.value,
    'https://example.test/accept-invitation?token=newer',
  );
  assert.equal(fallback.input.focused, true);
  assert.equal(fallback.input.selected, true);

  await fallback.dismiss.click();
  assert.equal(fallback.panel.hidden, true);
  assert.equal(fallback.input.value, '');

  await row.sendInvite.click();
  assert.equal(
    runtime.fetches.at(-1).url,
    '/admin/accounts/41/invitation/send',
  );
  assert.match(runtime.status.textContent, /Invitation email queued/);
});

test('admin roster invitation action performs one 409 reauthentication retry', async () => {
  const runtime = loadRosterRuntime({ reauthOnFirstCopy: true });

  await runtime.row.copyInvite.click();
  assert.equal(runtime.reauth.panel.hidden, false);
  assert.equal(runtime.reauth.password.focused, true);

  runtime.reauth.password.value = 'administrator private password';
  await runtime.reauth.submit.click();

  assert.deepEqual(runtime.fetches.map(({ url }) => url), [
    '/admin/accounts/41/invitation/copy',
    '/admin/reauthenticate',
    '/admin/accounts/41/invitation/copy',
  ]);
  assert.deepEqual(JSON.parse(runtime.fetches[1].options.body), {
    password: 'administrator private password',
  });
  assert.equal(runtime.reauth.panel.hidden, true);
  assert.equal(
    runtime.clipboard.value,
    'https://example.test/accept-invitation?token=rotated',
  );
});
