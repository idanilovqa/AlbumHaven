const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(
  __dirname, '..', '..', '..', 'music_app', 'static', 'js', 'account.js',
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

function loadRuntime() {
  const current = element({ type: 'password', focused: false });
  const toggle = element({ dataset: { passwordToggle: 'current-password' }, textContent: 'Show' });
  const password = element({ value: 'one' });
  const confirmation = element({ value: 'two', validity: '' });
  confirmation.setCustomValidity = (message) => { confirmation.validity = message; };
  const error = element({ textContent: '' });
  const controls = new Map([
    ['[name="new_password"]', password],
    ['[name="confirm_password"]', confirmation],
    ['[data-password-match-error]', error],
  ]);
  const form = element({ querySelector: (selector) => controls.get(selector) || null });
  const context = vm.createContext({
    document: {
      querySelectorAll: () => [toggle],
      getElementById: (id) => (id === 'current-password' ? current : null),
      querySelector: (selector) => (selector === '[data-password-form]' ? form : null),
    },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { current, toggle, password, confirmation, error, form };
}

test('account password visibility control preserves accessible pressed state', () => {
  const runtime = loadRuntime();

  runtime.toggle.listeners.get('click')();

  assert.equal(runtime.current.type, 'text');
  assert.equal(runtime.current.focused, true);
  assert.equal(runtime.toggle.textContent, 'Hide');
  assert.equal(runtime.toggle.attributes['aria-pressed'], 'true');
});

test('account form blocks mismatched confirmation without submitting secrets', () => {
  const runtime = loadRuntime();
  let prevented = false;

  runtime.form.listeners.get('submit')({ preventDefault: () => { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(runtime.confirmation.validity, 'Passwords do not match.');
  assert.equal(runtime.error.textContent, 'Passwords do not match.');

  runtime.confirmation.value = 'one';
  runtime.confirmation.listeners.get('input')();
  assert.equal(runtime.confirmation.validity, '');
  assert.equal(runtime.error.textContent, '');
});
