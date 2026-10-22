'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const F = require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
const {loadOwners, nativeRuntime, button, click, settle} = require('./album-tops-sharing-harness.cjs');
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true});
let mountAlbumTops;
test.before(async () => {await loadOwners(); ({mountAlbumTops} = await F.load('album-tops/index.mjs'));});

async function fixture(t, loseAcknowledgment, overrides = {}) {
  const env = nativeRuntime(t), listeners = new Set(), navigations = []; let attempts = 0;
  let shell = {authenticated: true, inLibrary: true, active: true, visible: true, sidebarMode: 'album_tops',
    scopeKey: F.SCOPE, topRef: F.TOP, viewVersion: 1, viewRequestId: 11};
  const api = F.service({handlers: {execute: (action, command) => {
    if (loseAcknowledgment && ++attempts === 1) throw new TypeError('Copy acknowledgment lost');
    return F.receipt(action, command);
  }, ...overrides}});
  Object.assign(env.runtime, {snapshot: () => shell, subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);},
    acceptsPrivateScope: scope => scope === shell.scopeKey, notificationRegistry: () => null,
    subscribeNotificationRegistry: () => () => {}, confirmRetryOriginal: async () => true,
    navigate: async value => {navigations.push(value); return true;}});
  const owner = env.own(mountAlbumTops({host: env.host, runtime: env.runtime, providers: api.providers}));
  await settle();
  return {...env, api, owner, navigations, change(patch) {shell = {...shell, ...patch}; for (const listener of [...listeners]) listener();}};
}

test('native index does not navigate when an uncertain remote Copy is later acknowledged by exact retry', async t => {
  const f = await fixture(t, true);
  click(button(f.host, 'Save a copy')); await settle();
  assert.equal(f.api.count('execute'), 1); assert.equal(f.navigations.length, 0);
  const reads = f.api.count('read'), lists = f.api.count('list');
  const retry = button(f.host, 'Retry original request'); assert.ok(retry);
  click(retry); await settle();
  assert.equal(f.api.count('execute'), 2); assert.equal(f.api.count('list'), lists + 1);
  assert.equal(f.api.count('read'), reads); assert.equal(f.navigations.length, 0);
  const writes = f.api.calls.filter(row => row.method === 'execute');
  assert.deepEqual(writes[0].args.slice(0, 2), writes[1].args.slice(0, 2));
  assert.ok(button(f.host, 'Save a copy'), 'the source Top stays displayed after directory-only recovery');
});

test('first-attempt acknowledged remote Copy retains ordinary native navigation to its receipt', async t => {
  const f = await fixture(t, false);
  click(button(f.host, 'Save a copy')); await settle();
  assert.equal(f.api.count('execute'), 1); assert.equal(f.navigations.length, 1);
  assert.equal(f.navigations[0].top_ref, F.OTHER); assert.equal(f.navigations[0].expectedViewRequestId, 11);
  assert.equal(typeof f.navigations[0].isCurrent, 'function'); assert.equal(f.navigations[0].isCurrent(), true);
});


test('same-Top shell navigation retires remote form before late results can reappear', async t => {
  const gate = F.deferred(), f = await fixture(t, false, {searchRemoteAlbums: () => gate.promise});
  click(button(f.host, 'Add albums'));
  const form = f.document.querySelector('form.album-top-add'); assert.ok(form);
  click(button(form, 'Remote albums')); F.input(form, 'Remote album title', 'Private lookup');
  click(button(form, 'Search remote albums')); await F.drain();
  const signal = f.api.last('searchRemoteAlbums').args[1].signal;
  f.change({viewVersion: 2, viewRequestId: 12});
  assert.equal(signal.aborted, true); assert.equal(f.document.querySelector('form.album-top-add'), null);
  gate.resolve(F.searchPage(f.api.last('searchRemoteAlbums').args[0], [F.summary(F.id(72), {title: 'Old navigation remote row'})])); await settle();
  form.dispatchEvent(new f.context.Event('submit'));
  assert.doesNotMatch(f.document.body.textContent, /Old navigation remote row/);
  assert.equal(f.api.count('execute'), 0); assert.equal(f.api.count('closeRemotePreparation'), 0);
  assert.equal(f.navigations.length, 0);
});
