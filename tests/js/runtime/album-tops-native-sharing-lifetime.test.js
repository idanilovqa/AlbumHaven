'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TOP, SCOPE, deferred, drain, sharing, service, preparedController, connectedView} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const {actualChoiceEnvironment, settle} = require('./album-tops-native-fixtures/actual-choice-runtime.cjs');

// Completed readSharing calls have already released their signal linkage.
// Only these deferred, still-outstanding private page reads must be aborted.
const privateReadsAborted = backend => backend.calls.filter(call => ['readAccessGrants', 'readAccessCandidates'].includes(call.method))
  .every(call => call.args[1].signal.aborted);
function unavailableHost(env) {
  const fallback = env.host.querySelector('[data-album-top-dialog-fallback]');
  const host = fallback && /not available|unavailable|could not/i.test(fallback.textContent) ? fallback : env.content();
  assert.match(host.textContent, /not available|unavailable|could not/i, 'explicit recoverable render failure');
  assert.ok(host.querySelector('[role="alert"], [role="status"]'), 'failure is announced');
  return host;
}
async function fixture(backend) {
  const env = actualChoiceEnvironment(), controller = await preparedController(backend);
  const owner = await connectedView(env, backend, controller);
  return {...env, controller, owner};
}

// This fails after the sharing Status and page owner have been acquired but
// before callbacks.mount returns. The actual native form owns cleanup order.
test('sharing partial initial factory failure retires acquisitions before fallback Close', async () => {
  const late = deferred(), backend = service({readSharing: () => late.promise}), env = await fixture(backend);
  const actualButton = env.runtime.buttonHtml;
  try {
    env.runtime.buttonHtml = config => {
      if (config.label === 'Retry original request') throw new Error('Injected partial sharing renderer failure');
      return actualButton(config);
    };
    env.click(env.button(env.host, 'Share'));
    assert.equal(env.modal().hidden, true);
    const fallback = unavailableHost(env);
    await settle();
    assert.equal(backend.count('readSharing'), 0, 'queued page read retired before its microtask starts');
    assert.equal(backend.count('execute'), 0);
    late.resolve(sharing()); await settle();
    assert.equal(env.modal().hidden, true); assert.equal(env.content().textContent, '');
    env.click(env.button(fallback, 'Close')); await settle();
    assert.equal(fallback.textContent, '');
    env.runtime.buttonHtml = actualButton;
    env.click(env.button(env.host, 'Share')); await settle();
    assert.equal(env.modal().hidden, false); assert.equal(env.opens.length, 2);
    assert.ok(env.button(env.content(), 'Save visibility'));
  } finally {env.runtime.buttonHtml = actualButton; env.owner.dispose(); env.cleanupChoiceGlobals();}
  env.assertClean();
});

for (const returned of [true, false]) {
  test(`sharing partial failure ignores delayed native cleanup (${returned}) after an explicit replacement`, async () => {
    const historyReturn = deferred(), backend = service(), env = await fixture(backend), actualButton = env.runtime.buttonHtml;
    let firstReturn = true;
    // External history boundary only. The actual native form performs its own
    // close, teardown, deferred onAfterClose and focus-currentness checks.
    env.context.retireMobileAppFormPage = () => {
      if (firstReturn) {firstReturn = false; return historyReturn.promise;}
      return Promise.resolve(true);
    };
    try {
      env.runtime.buttonHtml = config => {
        if (config.label === 'Retry original request') throw new Error('Injected partial sharing renderer failure');
        return actualButton(config);
      };
      env.click(env.button(env.host, 'Share')); await drain();
      const fallback = unavailableHost(env); assert.equal(env.modal().hidden, true);
      assert.equal(backend.count('readSharing'), 0);
      env.click(env.button(fallback, 'Close')); await drain();
      env.runtime.buttonHtml = actualButton;
      env.click(env.button(env.host, 'Share')); await settle();
      assert.equal(env.modal().hidden, false); const current = env.content().firstElementChild;
      historyReturn.resolve(returned); await settle();
      assert.equal(env.modal().hidden, false); assert.equal(env.content().firstElementChild, current);
      assert.ok(env.button(env.content(), 'Save visibility')); assert.equal(env.opens.length, 2);
      assert.equal(backend.count('execute'), 0);
    } finally {
      historyReturn.resolve(returned); env.runtime.buttonHtml = actualButton;
      env.owner.dispose(); await settle(); env.cleanupChoiceGlobals();
    }
    env.assertClean();
  });
}

for (const result of ['ready', 'error']) {
  test(`sharing catches post-open ${result}-page render rejection and retires private reads`, async () => {
    const page = deferred(), grants = deferred(), candidates = deferred();
    let firstSharing = true;
    const backend = service({readSharing: () => firstSharing ? (firstSharing = false, page.promise) : Promise.resolve(sharing()),
      readAccessGrants: () => grants.promise, readAccessCandidates: () => candidates.promise});
    const env = await fixture(backend), actualButton = env.runtime.buttonHtml, actualAlert = env.runtime.alertHtml;
    try {
      env.click(env.button(env.host, 'Share')); await drain();
      assert.equal(env.modal().hidden, false); assert.equal(backend.count('readSharing'), 1);
      if (result === 'ready') {
        env.runtime.buttonHtml = config => {
          if (String(config.ariaLabel).startsWith('Album Top visibility:')) throw new Error('Injected post-open visibility renderer failure');
          return actualButton(config);
        };
        page.resolve(sharing());
      } else {
        env.runtime.alertHtml = config => {
          if (config.message === 'Album Top sharing could not be loaded.') throw new Error('Injected post-open error-status renderer failure');
          return actualAlert(config);
        };
        page.reject(new Error('Ordinary sharing provider failure'));
      }
      await settle(); const failed = unavailableHost(env);
      assert.equal(privateReadsAborted(backend), true, 'failure aborts every already-started outstanding private page read');
      assert.equal(backend.count('execute'), 0);
      grants.resolve({top_ref: TOP, revision: '7', grants: [], next_cursor: null});
      candidates.resolve({top_ref: TOP, revision: '7', candidates: [{display_name: 'Late private member'}], next_cursor: null});
      await settle(); assert.doesNotMatch(env.document.body.textContent, /Late private member/);
      env.runtime.buttonHtml = actualButton; env.runtime.alertHtml = actualAlert;
      env.click(env.button(failed, 'Close')); await settle();
      env.click(env.button(env.host, 'Share')); await settle();
      assert.equal(env.modal().hidden, false); assert.equal(env.opens.length, 2);
      assert.ok(env.button(env.content(), 'Save visibility'));
    } finally {
      page.resolve(sharing()); grants.resolve({top_ref: TOP, revision: '7', grants: [], next_cursor: null});
      candidates.resolve({top_ref: TOP, revision: '7', candidates: [], next_cursor: null});
      env.runtime.buttonHtml = actualButton; env.runtime.alertHtml = actualAlert;
      env.owner.dispose(); await settle(); env.cleanupChoiceGlobals();
    }
    env.assertClean();
  });
}

test('actual Choice close-focus scope retirement cannot resume the retired sharing render', async () => {
  const grants = deferred(), candidates = deferred();
  const backend = service({readAccessGrants: () => grants.promise, readAccessCandidates: () => candidates.promise});
  const env = await fixture(backend); let trigger, retire, retired = false, listenersAtRetirement;
  try {
    env.click(env.button(env.host, 'Share')); await settle();
    trigger = env.button(env.content(), 'Album Top visibility: Private');
    assert.equal(trigger.disabled, false, 'real Choice service is available');
    env.click(trigger);
    const menu = env.document.querySelector('[role="menu"]'); assert.ok(menu, 'actual native menu opened');
    const choice = menu.querySelector('[data-foobar-format="server_shared"]'); assert.ok(choice);
    retire = () => {
      trigger.removeEventListener('focusin', retire);
      env.controller.setScope(`${SCOPE}:retired`);
      retired = true;
      listenersAtRetirement = new Set(env.listeners());
    };
    trigger.addEventListener('focusin', retire);
    // Real selection invokes native onSelect, consumer render, old native menu
    // Close, then trigger.focus. The callback retires the actual controller/view.
    assert.doesNotThrow(() => env.click(choice)); await settle();
    assert.equal(retired, true, 'native focus return exercised the retiring callback');
    assert.equal(env.modal().hidden, true); assert.equal(env.content().textContent, '');
    assert.equal(env.document.querySelector('[role="menu"]'), null);
    assert.equal(backend.count('execute'), 0);
    assert.equal(backend.count('readAccessGrants'), 1); assert.equal(backend.count('readAccessCandidates'), 1);
    assert.equal(privateReadsAborted(backend), true);
    assert.deepEqual(env.listeners().filter(entry => !listenersAtRetirement.has(entry)), [],
      'retired reconciliation must not acquire any new detached native listeners');
  } finally {
    if (trigger && retire) trigger.removeEventListener('focusin', retire); env.owner.dispose();
    grants.resolve({top_ref: TOP, revision: '7', grants: [], next_cursor: null});
    candidates.resolve({top_ref: TOP, revision: '7', candidates: [], next_cursor: null});
    await settle(); env.cleanupChoiceGlobals();
  }
  env.assertClean();
});

test('actual Choice focus reentry keeps the latest live sharing render authoritative', async () => {
  const backend = service(), env = await fixture(backend); let trigger, refresh, refreshed = false, loading;
  try {
    env.click(env.button(env.host, 'Share')); await settle();
    trigger = env.button(env.content(), 'Album Top visibility: Private'); env.click(trigger);
    const menu = env.document.querySelector('[role="menu"]'), choice = menu.querySelector('[data-foobar-format="server_shared"]');
    refresh = () => {trigger.removeEventListener('focusin', refresh); refreshed = true; loading = env.controller.load();};
    trigger.addEventListener('focusin', refresh);
    assert.doesNotThrow(() => env.click(choice)); await loading; await settle();
    assert.equal(refreshed, true); assert.equal(env.modal().hidden, false);
    assert.equal(env.content().querySelectorAll('[aria-label="Album Top visibility: Shared with this server"]').length, 1);
    env.click(env.button(env.content(), 'Save visibility')); await settle();
    const writes = backend.calls.filter(call => call.method === 'execute'); assert.equal(writes.length, 1);
    assert.equal(writes[0].args[0], 'visibility'); assert.equal(writes[0].args[1].visibility, 'server_shared');
  } finally {if (trigger && refresh) trigger.removeEventListener('focusin', refresh); env.owner.dispose(); env.cleanupChoiceGlobals();}
  env.assertClean();
});
