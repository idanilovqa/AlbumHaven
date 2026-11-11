const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'login.js',
);

function element(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    listeners,
    attributes: {},
    addEventListener(name, callback) {
      listeners.set(name, callback);
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    focus() {
      this.focused = true;
    },
  };
}

function loadLoginRuntime({ reply } = {}) {
  const csrfToken = element({ value: 'first-token' });
  const form = element({
    action: 'https://music.test/login',
    querySelector: (selector) => (selector === 'input[name="csrf_token"]' ? csrfToken : null),
  });
  const username = element({ value: 'Rendref' });
  const password = element({ type: 'password', value: 'typed-secret', focused: false });
  const toggle = element({ textContent: 'Show' });
  const submit = element({ disabled: false, textContent: 'Sign in' });
  const failure = element({ hidden: true });
  const selectors = new Map([
    ['.login-form', form],
    ['#login-password', password],
    ['.login-password-toggle', toggle],
    ['.login-submit', submit],
    ['.login-alert', failure],
  ]);
  const stages = [];
  const events = new Map();
  const requests = [];
  const navigations = [];
  const nativeSubmits = [];
  const fetch = async (url, options) => {
    requests.push({ url, options, stagesAtRequest: [...stages], submitAtRequest: { ...submit } });
    if (reply instanceof Error) throw reply;
    const { status, body, contentType = 'application/json' } = reply;
    return {
      ok: status >= 200 && status < 300,
      headers: { get: (name) => (name === 'content-type' ? contentType : null) },
      json: async () => body,
    };
  };
  const context = vm.createContext({
    window: {
      AlbumHavenStartupProgress: { show: (...args) => stages.push(args), reset() {} },
      addEventListener: (name, fn) => events.set(name, fn),
      fetch,
      location: { assign: (target) => navigations.push(target) },
    },
    document: { querySelector: (selector) => selectors.get(selector) || null },
    FormData: function FormData(target) {
      assert.equal(target, form);
      return [['username', username.value], ['password', password.value], ['csrf_token', csrfToken.value]];
    },
    URLSearchParams,
    HTMLFormElement: { prototype: { submit() { nativeSubmits.push(this); } } },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  const submitForm = async () => {
    let prevented = false;
    await form.listeners.get('submit')({ preventDefault() { prevented = true; } });
    return prevented;
  };
  return {
    form, username, password, toggle, submit, failure, csrfToken, stages, events,
    requests, navigations, nativeSubmits, submitForm,
  };
}

test('password visibility control updates the input and accessible pressed state', () => {
  const { password, toggle } = loadLoginRuntime();

  toggle.listeners.get('click')();
  assert.equal(password.type, 'text');
  assert.equal(password.focused, true);
  assert.equal(toggle.textContent, 'Hide');
  assert.equal(toggle.attributes['aria-pressed'], 'true');

  toggle.listeners.get('click')();
  assert.equal(password.type, 'password');
  assert.equal(toggle.textContent, 'Show');
  assert.equal(toggle.attributes['aria-pressed'], 'false');
});

test('sign-in posts the form for JSON before any loading UI appears', async () => {
  const ui = loadLoginRuntime({ reply: { status: 200, body: { redirect: '/albums?view=grid' } } });
  assert.equal(await ui.submitForm(), true);

  assert.equal(ui.requests.length, 1);
  const [{ url, options, stagesAtRequest, submitAtRequest }] = ui.requests;
  assert.equal(url, 'https://music.test/login');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers.Accept, 'application/json');
  assert.equal(
    options.body.toString(),
    'username=Rendref&password=typed-secret&csrf_token=first-token',
  );
  assert.deepEqual(stagesAtRequest, [], 'no progress before the server accepts');
  assert.equal(submitAtRequest.disabled, true);
  assert.equal(submitAtRequest.textContent, 'Signing in\u2026');

  assert.deepEqual(ui.stages, [[25]]);
  assert.deepEqual(ui.navigations, ['/albums?view=grid']);
  assert.equal(ui.failure.hidden, true);
  assert.deepEqual(ui.nativeSubmits, []);
});

test('rejected credentials fail inline at once and stay ready for a retry', async () => {
  const ui = loadLoginRuntime({ reply: { status: 401, body: { csrf_token: 'next-token' } } });
  await ui.submitForm();

  assert.deepEqual(ui.stages, [], 'progress never shows for a rejected sign-in');
  assert.deepEqual(ui.navigations, []);
  assert.equal(ui.failure.hidden, false);
  assert.equal(ui.username.value, 'Rendref');
  assert.equal(ui.password.value, '');
  assert.equal(ui.password.focused, true);
  assert.equal(ui.csrfToken.value, 'next-token');
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.submit.textContent, 'Sign in');
  assert.deepEqual(ui.nativeSubmits, []);
});

for (const [name, reply] of [
  ['network failure', new Error('offline')],
  ['plain-text rejection', { status: 400, body: null, contentType: 'text/html; charset=utf-8' }],
]) {
  test(`${name} falls back to the native form post without loading UI`, async () => {
    const ui = loadLoginRuntime({ reply });
    await ui.submitForm();

    assert.deepEqual(ui.nativeSubmits, [ui.form]);
    assert.deepEqual(ui.stages, []);
    assert.deepEqual(ui.navigations, []);
    assert.equal(ui.failure.hidden, true);
  });
}

test('a sign-in in flight ignores repeat submissions and history return restores controls', async () => {
  const ui = loadLoginRuntime({ reply: { status: 200, body: { redirect: '/' } } });
  ui.submit.disabled = true;
  assert.equal(await ui.submitForm(), true);
  assert.equal(ui.requests.length, 0);

  ui.events.get('pageshow')({ persisted: true });
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.submit.textContent, 'Sign in');
});


function loadStartupProgress() {
  const frameCallbacks = [];
  const fill = { style: {} };
  const percentLabel = { textContent: '' };
  const bar = element();
  const meter = element();
  const error = element({ hidden: true });
  const retry = element();
  const content = { inert: false };
  const root = element({ hidden: true, dataset: { startupProgress: '50' },
    querySelector(selector) { return ({ '.progress-fill': fill, '[role="progressbar"]': bar,
      '[data-startup-meter]': meter, '[data-startup-percent]': percentLabel,
      '[data-startup-error]': error, '[data-startup-retry]': retry })[selector]; },
  });
  const events = new Map();
  const window = { addEventListener: (name, fn) => events.set(name, fn), location: { reload() {} },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: fn => frameCallbacks.push(fn),
    cancelAnimationFrame: id => { frameCallbacks[id - 1] = () => {}; } };
  const document = { querySelector: () => root, body: { children: [root, content] },
    addEventListener() {} };
  const source = fs.readFileSync(path.join(path.dirname(sourcePath), 'startup-progress.js'), 'utf8');
  vm.runInNewContext(source, { window, document });
  return { controller: window.AlbumHavenStartupProgress, root, bar, meter, fill, percentLabel, error, content, frameCallbacks };
}

test('startup stages are accessible, monotonic and permanently complete after first usable view', () => {
  const ui = loadStartupProgress();
  while (ui.frameCallbacks.length) ui.frameCallbacks.shift()();
  assert.equal(ui.bar.attributes['aria-valuenow'], '95');
  assert.equal(ui.content.inert, true);
  ui.controller.show(75);
  ui.controller.show(50);
  while (ui.frameCallbacks.length) ui.frameCallbacks.shift()();
  assert.equal(ui.bar.attributes['aria-valuenow'], '95');
  assert.equal(ui.percentLabel.textContent, '95%');
  ui.controller.finish();
  while (ui.frameCallbacks.length) ui.frameCallbacks.shift()();
  assert.equal(ui.bar.attributes['aria-valuenow'], '100');
  assert.equal(ui.percentLabel.textContent, '100%');
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.content.inert, false);
  ui.controller.show(75);
  assert.equal(ui.root.hidden, true);
});

test('signed-in pages continue the bar from the 25% sign-in stage', () => {
  const ui = loadStartupProgress();
  assert.equal(ui.fill.style.width, '25.000%');
  assert.equal(ui.percentLabel.textContent, '25%');

  ui.frameCallbacks.shift()(100);
  ui.frameCallbacks.shift()(450);
  const midway = Number.parseFloat(ui.fill.style.width);
  assert.ok(midway > 25 && midway < 50, `expected a glide from 25% to 50%, saw ${midway}%`);
});

test('startup bar colors resolve without login tokens or account player tokens', () => {
  const css = fs.readFileSync(
    path.join(path.dirname(sourcePath), '..', 'css', 'startup-progress.css'),
    'utf8',
  );
  // The app page loads neither login.css nor player tokens for default accounts.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /--login-/);
  for (const [token, source] of [
    ['ink', 'appearance-ink'],
    ['track', 'appearance-player'],
    ['fill', 'appearance-play'],
  ]) {
    assert.match(css, new RegExp(`--startup-progress-${token}: var\\(--${source}, (?:#|rgba\\()`));
  }
});

test('startup overlay background stays stable while account appearance hydrates', () => {
  const css = fs.readFileSync(
    path.join(path.dirname(sourcePath), '..', 'css', 'startup-progress.css'),
    'utf8',
  );
  const overlayRule = css.match(/\.startup-progress\s*\{([^}]*)\}/)?.[1] || '';

  assert.match(overlayRule, /background:\s*#07101d;/);
  assert.doesNotMatch(overlayRule, /--appearance-main-surface/);
});

test('startup failure provides recovery and reset restores login interactivity', () => {
  const ui = loadStartupProgress();
  ui.controller.fail();
  assert.equal(ui.error.hidden, false);
  assert.equal(ui.root.hidden, false);
  assert.equal(ui.meter.hidden, true);
  ui.controller.reset();
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.meter.hidden, false);
  assert.equal(ui.content.inert, false);
});
