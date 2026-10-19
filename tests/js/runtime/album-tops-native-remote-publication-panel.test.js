'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./album-tops-native-remote-fixtures/picker-fixtures.cjs');
const {loadOwners, nativeRuntime, button, click, settle} = require('./album-tops-sharing-harness.cjs');
let createAlbumTopController, mountAlbumTopPublication;
test.before(async () => {
  await loadOwners();
  ({createAlbumTopController} = await F.load('album-tops/model.mjs'));
  ({mountAlbumTopPublication} = await F.load('album-tops/publication-panel.mjs'));
});
async function fixture(t, enabled = false) {
  const env = nativeRuntime(t), api = F.service();
  api.data.publication = F.ownerPublication(enabled ? 'enabled' : 'unpublished');
  const controller = env.own(createAlbumTopController({providers: api.providers, requestKey: () => F.id(301)}));
  controller.setScope(F.SCOPE); await controller.load(); await controller.open(F.TOP); await controller.readSharing();
  const owner = env.own(mountAlbumTopPublication(env.host, env.runtime, {controller, state: controller.getSnapshot()}));
  const unsubscribe = controller.subscribe(() => owner.update({state: controller.getSnapshot()}));
  t.after(unsubscribe); return {...env, api, controller, owner};
}

test('remote membership truthfully exposes publication unavailability without inventing source or track evidence', async t => {
  const f = await fixture(t);
  assert.match(f.host.textContent, /Public links for remote albums are not available yet/);
  assert.match(f.host.textContent, /Remote artwork publication is still unavailable/);
  assert.equal(button(f.host, 'Publish'), undefined); assert.equal(button(f.host, 'Republish'), undefined);
  const preview = button(f.host, 'Preview publication'); assert.ok(preview); assert.equal(preview.disabled, true);
  const sourceButtons = [...f.host.querySelectorAll('button')].filter(node => /^(Choose|Change) source$/.test(node.textContent.trim()));
  assert.equal(sourceButtons.length, 2); assert.ok(sourceButtons.every(node => node.disabled));
  assert.doesNotMatch(f.host.textContent, /0 tracks|Artwork published|Remote artwork ready/);
  assert.equal(f.api.count('preview'), 0); assert.equal(f.api.count('readPublicationSources'), 0);
  assert.equal(f.api.count('execute'), 0); assert.deepEqual(F.remoteCalls(f.api), []);
  for (const control of [preview, ...sourceButtons]) click(control);
  await settle();
  assert.equal(f.api.count('preview'), 0); assert.equal(f.api.count('readPublicationSources'), 0);
  assert.equal(f.api.count('execute'), 0);
});

test('remote-unavailable explanation does not erase an observed saved URL or its revoke control', async t => {
  const f = await fixture(t, true), observed = f.controller.getSnapshot().publication;
  assert.match(f.host.textContent, /Public links for remote albums are not available yet/);
  assert.ok(f.host.textContent.includes(observed.data.public_url));
  assert.ok(button(f.host, 'Copy link')); assert.ok(button(f.host, 'Revoke public link'));
  assert.equal(button(f.host, 'Republish'), undefined);
  const writes = f.api.count('execute');
  f.owner.update({state: f.controller.getSnapshot()}); await settle();
  assert.equal(f.controller.getSnapshot().publication, observed);
  assert.equal(f.api.count('execute'), writes); assert.deepEqual(F.remoteCalls(f.api), []);
});

test('publication pane mount, rerender and disposal perform no remote preparation cleanup or publication write', async t => {
  const f = await fixture(t), initial = f.api.calls.length;
  f.owner.update({state: f.controller.getSnapshot()}); f.owner.update({state: f.controller.getSnapshot()});
  await settle(); assert.equal(f.api.calls.length, initial);
  f.owner.dispose(); await settle();
  assert.equal(f.api.calls.length, initial); assert.deepEqual(F.remoteCalls(f.api), []);
  assert.equal(f.api.count('execute'), 0);
});
