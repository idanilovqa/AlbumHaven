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
  'password-recovery.js',
);

function loadRuntime({ valid = true, hasForm = true } = {}) {
  const listeners = new Map();
  const form = hasForm ? {
    checkValidity: () => valid,
    addEventListener: (name, callback) => listeners.set(name, callback),
  } : null;
  const submit = hasForm ? { disabled: false, textContent: 'Send reset link' } : null;
  const selectors = new Map([
    ['.recovery-form', form],
    ['.recovery-submit', submit],
  ]);
  const context = vm.createContext({
    document: { querySelector: (selector) => selectors.get(selector) || null },
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return { form, submit, listeners };
}

test('valid recovery submission enters one loading state', () => {
  const runtime = loadRuntime();
  runtime.listeners.get('submit')();
  assert.equal(runtime.submit.disabled, true);
  assert.equal(runtime.submit.textContent, 'Sending…');
});

test('invalid submission and generic sent page remain safe', () => {
  const invalid = loadRuntime({ valid: false });
  invalid.listeners.get('submit')();
  assert.equal(invalid.submit.disabled, false);
  assert.equal(invalid.submit.textContent, 'Send reset link');

  assert.doesNotThrow(() => loadRuntime({ hasForm: false }));
});
