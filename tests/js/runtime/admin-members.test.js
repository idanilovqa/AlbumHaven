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
    attributes: {},
    addEventListener(name, callback) { listeners.set(name, callback); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() { this.focused = true; },
  };
}

function loadRuntime({ mode = 'create', active = true, libraryAccess = true } = {}) {
  const password = element({ type: 'password', focused: false });
  const toggle = element({ dataset: { passwordToggle: 'admin-new-password' }, textContent: 'Show' });
  const submit = element({ disabled: false });
  const error = element({ hidden: true, textContent: '' });
  const form = element({
    dataset: {
      mode,
      initialActive: 'true',
      initialLibraryAccess: 'true',
    },
    checkValidity: () => true,
    reportValidity: () => {},
    querySelector: (selector) => {
      if (selector === 'button[type="submit"]') return submit;
      if (selector === '[name="is_active"]') return { checked: active };
      return null;
    },
    querySelectorAll: () => [],
    parentElement: { querySelector: () => error },
  });
  const values = new Map([
    ['username', 'test.user+2'],
    ['contact_email', 'test.user+2@example.test'],
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
        ? ['library.browse.read', 'library.media.read']
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
  return { password, toggle, submit, error, form, fetches, assigned: () => assigned };
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
    username: 'test.user+2',
    contact_email: 'test.user+2@example.test',
    password: 'private passphrase',
    capability_keys: ['library.browse.read', 'library.media.read'],
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
