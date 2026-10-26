'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readRepo} = require('../native-home-harness.cjs');
const {drain} = require('./actual-native-runtime.cjs');

// Case-local canonical dialog composition for the isolated Gallery fixture.
// The Gallery, controller input and artist-owner tripwires remain unchanged.
function installGalleryConfirmation(t, env) {
  const {context, document, timers} = env;
  const include = '{% include "partials/app-form-modal.html" %}';
  const formImport = "{% from 'partials/button.html' import action_button %}";
  const source = readRepo('music_app/templates/partials/confirm-modals.html');
  const form = readRepo('music_app/templates/partials/app-form-modal.html');
  assert.equal(source.split(include).length, 2); assert.equal(form.split(formImport).length, 2);
  const modals = source.replace(include, form.replace(formImport, ''));
  const marker = '<div class="confirm-modal" id="app-confirm-modal" hidden>';
  assert.ok(modals.includes(marker));
  const html = modals.slice(modals.indexOf(marker)).replace("{{ action_button('Close dialog', id='app-form-close', icon='close', hidden=true) }}",
    context.ButtonComponent.renderActionButton({attributes: {id: 'app-form-close'}, icon: 'close', ariaLabel: 'Close dialog', hidden: true}));
  assert.doesNotMatch(html, /{%|{{/); document.body.insertAdjacentHTML('beforeend', html);
  // Preserve positive-delay Gallery timers. A zero-delay browser task completes
  // naturally; never clear the fixture's timer collection to satisfy cleanup.
  const schedule = context.scheduleBrowserTimeout;
  context.scheduleBrowserTimeout = (callback, delay = 0) => {
    const key = schedule(callback, delay);
    if (Number(delay) <= 0) setImmediate(() => {
      if (!timers.has(key)) return;
      timers.delete(key); callback();
    });
    return key;
  };
  vm.runInContext(readRepo('music_app/static/js/runtime/browser-dialog-helpers.js'), context,
    {filename: 'browser-dialog-helpers.js'});
  const confirm = vm.runInContext('showAppConfirmDialog', context);
  env.runtime.confirm = (message, options = {}) => confirm({...options, message});
  t.after(async () => {await new Promise(resolve => setImmediate(resolve)); assert.equal(timers.size, 0);});
}
async function consentToCompletion(env, button) {
  const before = env.calls.length, key = button.closest('[data-gallery-card-key]').getAttribute('data-gallery-card-key');
  env.click(button); await drain();
  const modal = env.document.getElementById('app-confirm-modal');
  assert.equal(modal.hidden, false); assert.equal(env.calls.length, before, 'no completion write before consent');
  env.click(env.document.getElementById('app-confirm-cancel')); await drain();
  assert.equal(modal.hidden, true); assert.equal(env.calls.length, before, 'declining completion never writes');
  env.click(button); await drain();
  assert.equal(env.calls.length, before, 'retained pre-prompt control cannot bypass consent');
  if (modal.hidden) {
    const current = env.host.querySelector(`[data-gallery-card-key="${key}"] [data-gallery-card-intent="complete"]`);
    assert.ok(current); env.click(current); await drain();
  }
  assert.equal(modal.hidden, false);
  env.click(env.document.getElementById('app-confirm-accept')); await drain();
}
module.exports = {installGalleryConfirmation, consentToCompletion};
