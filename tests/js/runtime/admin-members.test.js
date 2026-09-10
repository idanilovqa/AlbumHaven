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
    style: {},
    getBoundingClientRect() { return { left: 600, right: 790, top: 600, bottom: 642, width: 190, height: 130 }; },
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

function loadRuntime({ mode = 'create', active = true, initialActive = true, libraryAccess = true, navigate, request, confirm = () => true } = {}) {
  const password = element({ type: 'password', focused: false });
  const toggle = element({ dataset: { passwordToggle: 'admin-new-password' }, textContent: 'Show' });
  const submit = element({ disabled: false, textContent: mode === 'create' ? 'Create user' : 'Save changes' });
  const error = element({ hidden: true, textContent: '' });
  const reauth = { panel: element({ hidden: true }), password: element({ value: '' }), submit: element({ disabled: false }) };
  const status = element({ hidden: true, textContent: '' });
  const activeControl = element({ checked: active });
  const activeAction = element({ dataset: { adminAction: 'toggle-active' } });
  const reset = element({ dataset: { adminAction: 'reset' }, disabled: false });
  const welcome = element({ dataset: { adminAction: 'welcome' }, disabled: false });
  const revoke = element({ dataset: { adminAction: 'revoke' }, disabled: false, textContent: 'Revoke sessions' });
  const form = element({
    dataset: {
      mode,
      initialActive: String(initialActive),
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
      if (selector === '[name="is_active"]') return activeControl;
      if (selector === '[data-reauth-panel]') return reauth.panel;
      if (selector === '[data-reauth-password]') return reauth.password;
      if (selector === '[data-reauth-submit]') return reauth.submit;
      return null;
    },
    querySelectorAll: (selector) => (
      selector === '[data-admin-action]' && mode === 'edit' ? [reset, welcome, revoke, activeAction] : []
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
  const confirmations = [];
  let assigned = '';
  class FakeFormData {
    get(key) { return key === 'is_active' ? (activeControl.checked ? 'on' : null) : (values.get(key) || null); }
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
      if (request) return request(...args);
      return { ok: true, json: async () => ({ account_id: 42 }) };
    },
    window: {
      confirm: (message) => { confirmations.push(message); return confirm(message); },
      location: { assign: (value) => { assigned = value; } },
    },
    document: {
      querySelectorAll: () => [toggle],
      getElementById: (id) => (id === 'admin-new-password' ? password : null),
      querySelector: (selector) => {
        if (selector === '[data-admin-account-form]') return form;
        if (selector === '[data-settings-host]' && navigate) return {};
        return null;
      },
    },
  });
  form.requestSubmit = () => { form.submission = form.listeners.get('submit')({ preventDefault() {} }); };
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  if (navigate) context.window.AlbumHavenMountAdmin(context.document, { navigate });
  return {
    password, toggle, submit, error, status, reset, welcome, revoke, activeAction, activeControl, form, fetches, confirmations, reauth,
    assigned: () => assigned,
  };
}

function loadRosterRuntime({
  clipboardReject = false,
  reauthOnFirstCopy = false,
  copyResponse = null,
  request = null,
} = {}) {
  const menuButton = element({
    dataset: { memberMenuTrigger: '41' },
    attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
  });
  const copyInvite = element({ dataset: { copyInvitation: '41' } });
  const sendInvite = element({ dataset: { sendInvitation: '41' } });
  const sendOtherInvite = element({ dataset: { sendInvitation: '42' } });
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
  const windowListeners = new Map();
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
      if (request) return request(url, options);
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
          json: async () => copyResponse || ({
            invitation_url: successfulCopies === 1
              ? 'https://example.test/accept-invitation?purpose=account-invitation&token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
              : 'https://example.test/accept-invitation?purpose=account-invitation&token=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
    navigator: { clipboard },
    URL,
    window: {
      innerWidth: 800, innerHeight: 720,
      location: { origin: 'https://example.test', assign() {} },
      addEventListener(name, callback) { windowListeners.set(name, callback); },
      removeEventListener(name) { windowListeners.delete(name); },
    },
    document: {
      addEventListener(name, callback) { documentListeners.set(name, callback); },
      querySelectorAll(selector) {
        if (selector === '[data-password-toggle]') return [];
        if (selector === '[data-member-menu-trigger]') return [menuButton];
        if (selector === '[data-copy-invitation]') return [copyInvite];
        if (selector === '[data-send-invitation]') return [sendInvite, sendOtherInvite];
        if (selector === '[data-member-menu]:not([hidden])') {
          return menu.hidden ? [] : [menu];
        }
        return [];
      },
      querySelector(selector) {
        if (selector === '[data-settings-host]') return {};
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
  const cleanup = context.window.AlbumHavenMountAdmin(context.document);
  return {
    row: { menuButton, menu, copyInvite, sendInvite, sendOtherInvite },
    status,
    error,
    fallback: { panel: fallback, input: fallbackInput, manual: fallbackManual, dismiss: fallbackDismiss },
    reauth: { panel: reauthPanel, password: reauthPassword, submit: reauthSubmit, cancel: reauthCancel },
    clipboard,
    fetches,
    documentListeners,
    windowListeners, cleanup,
    outside: element(),
  };
}

test('detail Enter uses Continue and does not submit another stale account mutation', async () => {
  let patches = 0;
  const runtime = loadRuntime({ mode: 'edit', request: async (_url, options) => {
    if (options.method === 'PATCH' && ++patches === 1) {
      return { ok: false, status: 409, json: async () => ({ detail: 'Recent authentication is required.' }) };
    }
    return { ok: true, json: async () => ({}) };
  } });
  runtime.form.requestSubmit();
  await runtime.form.submission;
  assert.equal(runtime.reauth.panel.hidden, false);
  runtime.reauth.password.value = 'owner password';
  let prevented = false;
  runtime.reauth.password.listeners.get('keydown')({ key: 'Enter', preventDefault() { prevented = true; } });
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  assert.deepEqual(runtime.fetches.map(([url, options]) => [url, options.method]), [
    ['/admin/accounts/41', 'PATCH'], ['/admin/reauthenticate', 'POST'], ['/admin/accounts/41', 'PATCH'],
  ]);
  assert.equal(runtime.reauth.password.value, '');
  assert.equal(runtime.reauth.panel.hidden, true);
});

test('detail Enter respects an in-flight Continue and leaves composing input alone', () => {
  const runtime = loadRuntime({ mode: 'edit' });
  runtime.reauth.password.value = 'owner password';
  runtime.reauth.submit.disabled = true;
  let prevented = 0;
  const press = runtime.reauth.password.listeners.get('keydown');
  press({ key: 'Enter', preventDefault() { prevented += 1; } });
  press({ key: 'Enter', isComposing: true, preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(runtime.fetches.length, 0);
  runtime.reauth.submit.disabled = false;
  runtime.reauth.password.value = '';
  press({ key: 'Enter', preventDefault() {} });
  assert.equal(runtime.fetches.length, 0);
  assert.equal(runtime.reauth.password.focused, true);
});

test('roster menu is clamped above its last-row trigger and closes on layout change or disposal', async () => {
  const runtime = loadRosterRuntime();
  const { menuButton, menu } = runtime.row;
  await menuButton.click();
  assert.equal(menu.style.left, '600px');
  assert.equal(menu.style.top, '465px');
  runtime.windowListeners.get('scroll')({ type: 'scroll', target: runtime.outside });
  assert.equal(menu.hidden, true);
  assert.equal(menuButton.getAttribute('aria-expanded'), 'false');
  await menuButton.click();
  runtime.windowListeners.get('resize')({ type: 'resize' });
  assert.equal(menu.hidden, true);
  await menuButton.click();
  runtime.cleanup();
  assert.equal(menu.hidden, true);
  assert.equal(runtime.windowListeners.size, 0);
});

for (const outcome of ['same-account', 'other-account', 'failed-send']) {
  test(`invitation fallback follows successful token rotation: ${outcome}`, async () => {
    const invitationUrl = 'https://example.test/accept-invitation?purpose=account-invitation&token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const runtime = loadRosterRuntime({
      clipboardReject: true,
      request: async (url) => ({
        ok: !(outcome === 'failed-send' && url.endsWith('/invitation/send')),
        status: outcome === 'failed-send' && url.endsWith('/invitation/send') ? 503 : 200,
        json: async () => ({ invitation_url: invitationUrl }),
      }),
    });
    await runtime.row.copyInvite.click();
    assert.equal(runtime.fallback.panel.hidden, false);
    assert.equal(runtime.fallback.input.value, invitationUrl);

    await (outcome === 'other-account' ? runtime.row.sendOtherInvite : runtime.row.sendInvite).click();

    assert.equal(runtime.fallback.panel.hidden, outcome === 'same-account');
    assert.equal(runtime.fallback.input.value, outcome === 'same-account' ? '' : invitationUrl);
    if (outcome === 'failed-send') assert.equal(runtime.error.hidden, false);
  });
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

for (const mode of ['create', 'edit']) {
  test(`completed ${mode} mutation retries failed navigation without repeating the mutation`, async () => {
    const destinations = [];
    const runtime = loadRuntime({
      mode,
      navigate: async (url) => {
        destinations.push(url);
        return destinations.length > 1;
      },
    });
    const submit = () => runtime.form.listeners.get('submit')({ preventDefault() {} });

    await submit();

    assert.equal(runtime.fetches.length, 1);
    assert.equal(runtime.fetches[0][1].method, mode === 'create' ? 'POST' : 'PATCH');
    assert.equal(runtime.submit.disabled, false);
    assert.equal(runtime.submit.textContent, 'Retry navigation');
    assert.equal(runtime.submit.formNoValidate, true);
    assert.equal(runtime.status.hidden, false);
    assert.match(runtime.status.textContent, /Changes saved/);
    assert.match(runtime.status.textContent, /could not be loaded/);

    // A completed mutation is no longer a form submission: retry is GET-only
    // even if the stale form's values would now fail validation.
    runtime.form.checkValidity = () => false;
    await submit();

    const expected = mode === 'create' ? '/admin/members?created=1' : '/admin/members';
    assert.deepEqual(destinations, [expected, expected]);
    assert.equal(runtime.fetches.length, 1, 'the saved mutation must not be posted again');
    assert.equal(runtime.assigned(), '', 'persistent navigation must not fall back to document reload');
  });
}

test('completed session revocation retries navigation without revoking sessions again', async () => {
  const destinations = [];
  const runtime = loadRuntime({
    mode: 'edit',
    navigate: async (url) => { destinations.push(url); return destinations.length > 1; },
  });
  await runtime.revoke.click();
  assert.equal(runtime.fetches.length, 1);
  assert.equal(runtime.fetches[0][0], '/admin/accounts/41/sessions/revoke');
  assert.equal(runtime.revoke.disabled, false);
  assert.equal(runtime.revoke.textContent, 'Retry navigation');
  assert.equal(runtime.status.hidden, false);
  assert.match(runtime.status.textContent, /could not be loaded/);

  await runtime.revoke.click();

  assert.deepEqual(destinations, ['/admin/accounts/41', '/admin/accounts/41']);
  assert.equal(runtime.fetches.length, 1);
  assert.equal(runtime.confirmations.length, 1);
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
    'https://example.test/accept-invitation?purpose=account-invitation&token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  );
  assert.match(runtime.status.textContent, /Older links no longer work/);

  clipboard.reject = true;
  await row.copyInvite.click();
  assert.equal(fallback.panel.hidden, false);
  assert.equal(fallback.input.readOnly, true);
  assert.equal(
    fallback.input.value,
    'https://example.test/accept-invitation?purpose=account-invitation&token=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
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

for (const secondAction of ['copyInvite', 'sendInvite']) {
  for (const pendingStage of ['response', 'clipboard']) {
    test(`roster invitation rotation excludes ${secondAction} during pending ${pendingStage}`, async t => {
      let finish;
      const pending = new Promise(resolve => { finish = resolve; });
      const response = { ok: true, status: 200, json: async () => ({ invitation_url: `https://example.test/accept-invitation?purpose=account-invitation&token=${'A'.repeat(43)}` }) };
      const runtime = loadRosterRuntime({ request: async () => pendingStage === 'response' ? pending : response });
      if (pendingStage === 'clipboard') runtime.clipboard.writeText = async value => { await pending; runtime.clipboard.value = value; };
      const first = runtime.row.copyInvite.click();
      t.after(async () => { finish(response); await first; });
      await new Promise(resolve => setImmediate(resolve));
      const duplicate = runtime.row[secondAction].click();
      t.after(async () => { finish(response); await duplicate; });
      assert.equal(runtime.fetches.length, 1, 'a later rotation must not invalidate the pending copied token');
      assert.equal(runtime.row.copyInvite.disabled, true);
      assert.equal(runtime.row.sendInvite.disabled, true);
      finish(response);
      await Promise.all([first, duplicate]);
      assert.match(runtime.clipboard.value, /token=A{43}$/);
      assert.equal(runtime.row.copyInvite.disabled, false);
      assert.equal(runtime.row.sendInvite.disabled, false);
      await runtime.row[secondAction].click();
      assert.equal(runtime.fetches.length, 2, 'normal actions resume after the prior result is exposed');
    });
  }
}

test('roster invitation rotation remains owned through reauthentication and releases on cancel', async () => {
  const runtime = loadRosterRuntime({ reauthOnFirstCopy: true });
  await runtime.row.copyInvite.click();
  await runtime.row.sendInvite.click();
  assert.equal(runtime.fetches.length, 1);
  assert.equal(runtime.reauth.panel.hidden, false);
  runtime.reauth.password.value = 'discard this cancelled password';
  await runtime.reauth.cancel.click();
  assert.equal(runtime.reauth.password.value, '');
  assert.equal(runtime.row.copyInvite.disabled, false);
  await runtime.row.sendInvite.click();
  assert.equal(runtime.fetches.length, 2);
});

test('admin roster invitation actions close the menu and restore trigger focus', async () => {
  const runtime = loadRosterRuntime();
  const { row } = runtime;

  await row.menuButton.click();
  await row.copyInvite.click();
  assert.equal(row.menu.hidden, true);
  assert.equal(row.menuButton.getAttribute('aria-expanded'), 'false');
  assert.equal(row.menuButton.focused, true);

  row.menuButton.focused = false;
  await row.menuButton.click();
  await row.sendInvite.click();
  assert.equal(row.menu.hidden, true);
  assert.equal(row.menuButton.getAttribute('aria-expanded'), 'false');
  assert.equal(row.menuButton.focused, true);
});

for (const [label, copyResponse] of [
  ['missing', {}],
  ['malformed', { invitation_url: 'not a URL' }],
  ['non-http(s)', { invitation_url: 'javascript:alert(1)' }],
  ['wrong-path', { invitation_url: 'https://example.test/reset-password?token=wrong' }],
]) {
  test(`admin roster rejects ${label} copied invitation URLs before exposing them`, async () => {
    const runtime = loadRosterRuntime({ copyResponse });

    await runtime.row.copyInvite.click();

    assert.equal(runtime.fetches.length, 1);
    assert.equal(runtime.clipboard.value, '');
    assert.equal(runtime.fallback.panel.hidden, true);
    assert.equal(runtime.fallback.input.value, '');
    assert.equal(runtime.error.hidden, false);
    assert.match(runtime.error.textContent, /Invitation link could not be created/);
  });
}

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
  assert.equal(runtime.reauth.password.value, '');
  assert.equal(
    runtime.clipboard.value,
    'https://example.test/accept-invitation?purpose=account-invitation&token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  );
});

test('admin roster empty reauthentication stays local and returns focus with an alert', async () => {
  const runtime = loadRosterRuntime({ reauthOnFirstCopy: true });

  await runtime.row.copyInvite.click();
  assert.equal(runtime.fetches.length, 1);
  runtime.reauth.password.focused = false;

  await runtime.reauth.submit.click();

  assert.equal(runtime.fetches.length, 1);
  assert.equal(runtime.reauth.panel.hidden, false);
  assert.equal(runtime.reauth.password.focused, true);
  assert.equal(runtime.error.hidden, false);
  assert.match(runtime.error.textContent, /password/i);
});


for (const initialActive of [true, false]) {
  test(`labeled account action respects persisted state after edited checkbox: ${initialActive}`, async () => {
    const runtime = loadRuntime({ mode: 'edit', initialActive, active: !initialActive });
    await runtime.activeAction.click();
    await runtime.form.submission;
    assert.equal(runtime.fetches.length, 1);
    const payload = JSON.parse(runtime.fetches[0][1].body);
    assert.equal(payload.is_active, !initialActive);
    assert.equal(payload.confirm_disable, initialActive);
  });
}

test('labeled disable remains disable after cancelling its first confirmation', async () => {
  let confirmations = 0;
  const runtime = loadRuntime({ mode: 'edit', confirm: () => ++confirmations > 1 });
  await runtime.activeAction.click();
  await runtime.form.submission;
  assert.equal(runtime.fetches.length, 0);
  await runtime.activeAction.click();
  await runtime.form.submission;
  assert.equal(confirmations, 2);
  assert.equal(runtime.fetches.length, 1);
  const payload = JSON.parse(runtime.fetches[0][1].body);
  assert.equal(payload.is_active, false);
  assert.equal(payload.confirm_disable, true);
});
