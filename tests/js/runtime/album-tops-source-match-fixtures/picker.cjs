'use strict';
// Provider DTOs are the established remote fixture. Controller, permissions,
// draft, picker and native controls remain their actual product owners.
const assert = require('node:assert/strict');
const F = require('../album-tops-native-remote-fixtures/picker-fixtures.cjs');
const JOB = 'c83d2869-61c4-4ef8-8e83-82f782fd80da';
const OTHER_JOB = 'fe31700d-e0bd-44db-a7ef-9d00b2b13e2b';
let createAlbumTopController, createAlbumTopDraft, mountAlbumPicker;
async function load() {
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', {
    value: require('node:crypto').webcrypto, configurable: true,
  });
  ({createAlbumTopController} = await F.load('album-tops/model.mjs'));
  ({createAlbumTopDraft} = await F.load('album-tops/draft.mjs'));
  ({mountAlbumPicker} = await F.load('album-tops/builder.mjs'));
}
async function base(t, {handlers = {}, ready = true, scope = F.SCOPE} = {}) {
  const api = F.service({handlers}), subscriptions = {started: 0, live: 0}, mutations = [];
  const controller = createAlbumTopController({providers: api.providers, requestKey: () => F.id(901)});
  // Transparent observation only. Never replace the permission or mutation owner.
  const subscribe = controller.subscribe, mutate = controller.mutate;
  controller.subscribe = listener => {
    subscriptions.started++; subscriptions.live++;
    const unsubscribe = subscribe.call(controller, listener); let active = true;
    return () => {if (active) {active = false; subscriptions.live--; unsubscribe();}};
  };
  controller.mutate = (...args) => {mutations.push(F.clone(args)); return mutate.apply(controller, args);};
  const drafts = [];
  t.after(() => {
    for (const draft of drafts.reverse()) draft.dispose();
    controller.dispose(); assert.equal(subscriptions.live, 0, 'every draft releases its real controller subscription');
  });
  controller.setScope(scope);
  if (ready) assert.equal(await controller.load(), true);
  const options = extra => ({controller, providers: api.providers, mode: 'source-match', sourceJobRef: JOB, ...extra});
  const construct = settings => createAlbumTopDraft(settings);
  function create(extra = {}) {const draft = construct(options(extra)); drafts.push(draft); return draft;}
  return {api, controller, subscriptions, mutations, options, construct, create,
    own(draft) {drafts.push(draft); return draft;}};
}
async function fixture(t, options = {}) {const value = await base(t, options); return {...value, draft: value.create()};}
async function localResults(draft) {
  assert.equal(await draft.setQuery('Found local album'), true);
  return draft.getSnapshot().search.items;
}
async function remoteResults(draft) {
  assert.equal(draft.setPool('remote'), true);
  assert.equal(draft.setRemoteTitle('  Remote album  '), true);
  assert.equal(draft.setRemoteArtist(' Remote artist '), true);
  assert.equal(await draft.searchRemote(), true);
  return draft.getSnapshot().remote.search.candidates;
}
function noWrites(f) {
  assert.deepEqual(f.mutations, [], 'the actual controller mutation method is never invoked');
  assert.equal(f.api.count('execute'), 0, 'no Top membership transport');
}
function noCleanup(f) {
  assert.equal(f.api.count('closeRemotePreparation'), 0);
  assert.equal(f.api.count('maintainRemotePreparations'), 0);
}
module.exports = {F, JOB, OTHER_JOB, load, base, fixture, localResults, remoteResults, noWrites, noCleanup,
  mount: (...args) => mountAlbumPicker(...args)};
