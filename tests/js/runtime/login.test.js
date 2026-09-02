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
  const context = vm.createContext({
    document: { querySelector: (selector) => selectors.get(selector) || null },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { form, password, toggle, submit };
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
  assert.equal(valid.submit.textContent, 'Signing in…');

  const invalid = loadLoginRuntime({ valid: false });
  invalid.form.listeners.get('submit')();
  assert.equal(invalid.submit.disabled, false);
  assert.equal(invalid.submit.textContent, 'Sign in');
});
