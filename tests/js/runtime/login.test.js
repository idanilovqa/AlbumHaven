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

function loadLoginRuntime({ valid = true } = {}) {
  const form = element({ checkValidity: () => valid });
  const password = element({ type: 'password', focused: false });
  const toggle = element({ textContent: 'Show' });
  const submit = element({ disabled: false, textContent: 'Sign in' });
  const selectors = new Map([
    ['.login-form', form],
    ['#login-password', password],
    ['.login-password-toggle', toggle],
    ['.login-submit', submit],
  ]);
  const stages = [];
  const events = new Map();
  const context = vm.createContext({
    window: { AlbumHavenStartupProgress: { show: (...args) => stages.push(args), reset() {} }, addEventListener: (name, fn) => events.set(name, fn) },
    document: { querySelector: (selector) => selectors.get(selector) || null },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { form, password, toggle, submit, stages, events };
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

test('valid submission enters one loading state while invalid submission stays actionable', () => {
  const valid = loadLoginRuntime();
  valid.form.listeners.get('submit')();
  assert.equal(valid.submit.disabled, true);
  assert.equal(valid.submit.textContent, 'Signing in\u2026');

  const invalid = loadLoginRuntime({ valid: false });
  invalid.form.listeners.get('submit')();
  assert.equal(invalid.submit.disabled, false);
  assert.equal(invalid.submit.textContent, 'Sign in');
});


test('native sign-in reports the submitted stage and restores controls on history return', () => {
  const valid = loadLoginRuntime();
  valid.form.listeners.get('submit')();
  assert.equal(valid.stages[0][0], 25);
  valid.events.get('pageshow')({ persisted: true });
  assert.equal(valid.submit.disabled, false);
  assert.equal(valid.submit.textContent, 'Sign in');
  const invalid = loadLoginRuntime({ valid: false });
  invalid.form.listeners.get('submit')();
  assert.equal(invalid.stages.length, 0);
});


function loadStartupProgress() {
  const frameCallbacks = [];
  const fill = { style: {} };
  const bar = element();
  const error = element({ hidden: true });
  const retry = element();
  const content = { inert: false };
  const root = element({ hidden: true, dataset: { startupProgress: '50' },
    querySelector(selector) { return ({ '.progress-fill': fill, '[role="progressbar"]': bar,
      '[data-startup-error]': error, '[data-startup-retry]': retry })[selector]; },
  });
  const events = new Map();
  const window = { addEventListener: (name, fn) => events.set(name, fn), location: { reload() {} },
    requestAnimationFrame: fn => frameCallbacks.push(fn) };
  const document = { querySelector: () => root, body: { children: [root, content] },
    addEventListener() {} };
  const source = fs.readFileSync(path.join(path.dirname(sourcePath), 'startup-progress.js'), 'utf8');
  vm.runInNewContext(source, { window, document });
  return { controller: window.AlbumHavenStartupProgress, root, bar, fill, error, content, frameCallbacks };
}

test('startup stages are accessible, monotonic and permanently complete after first usable view', () => {
  const ui = loadStartupProgress();
  assert.equal(ui.bar.attributes['aria-valuenow'], '50');
  assert.equal(ui.content.inert, true);
  ui.controller.show(75);
  ui.controller.show(50);
  assert.equal(ui.bar.attributes['aria-valuenow'], '75');
  ui.controller.finish();
  assert.equal(ui.bar.attributes['aria-valuenow'], '100');
  while (ui.frameCallbacks.length) ui.frameCallbacks.shift()();
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.content.inert, false);
  ui.controller.show(75);
  assert.equal(ui.root.hidden, true);
});

test('startup failure provides recovery and reset restores login interactivity', () => {
  const ui = loadStartupProgress();
  ui.controller.fail();
  assert.equal(ui.error.hidden, false);
  assert.equal(ui.root.hidden, false);
  ui.controller.reset();
  assert.equal(ui.root.hidden, true);
  assert.equal(ui.content.inert, false);
});
