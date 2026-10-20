'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const I = require('./album-tops-source-import-index-fixtures/index.cjs');
const {fixture, close, settle, button, click} = I;
test.before(I.load);

test('actual Home/library navigation preserves a pending import and only explicit completion-card Open returns to its retained review', async t => {
  const h = await fixture(t), source = h.currentSource(), scope = h.runtime.snapshot().scopeKey;
  const request = await I.submit(h, {content: 'Private source completed while on Home'}), keys = [...h.keys];
  assert.equal(await close(h), null);
  // Drive the complete native foreground/history owner with a Home response.
  // No Home content/controller substitute or direct state mutation is supplied.
  const home = h.read('/view-data?surface=home', {source: 'library'}, true); await settle();
  const navigation = h.last('navigate'); assert.equal(new URL(navigation.url, h.location).searchParams.get('surface'), 'home');
  navigation.reply({...I.N.ordinary(), context_ref: I.N.A, surface: {active: 'home'}, surface_request: 'home', top_ref: null,
    shell_layout: {slots: {navigation_rail: {content_kind: 'artists_sidebar'}}}});
  const outcome = await home; assert.equal(outcome.error, undefined); assert.equal(outcome.value, true); await settle();
  const away = h.runtime.snapshot(); assert.equal(away.inLibrary, true); assert.equal(away.authenticated, true);
  assert.equal(away.active, false); assert.equal(away.visible, false); assert.equal(away.scopeKey, scope);
  assert.equal(h.host.hidden, true); assert.equal(h.state.view.surface.active, 'home');
  assert.equal(new URL(h.location.href).pathname, '/'); assert.equal(new URL(h.location.href).search, '');
  assert.equal(h.context.shouldShowMobileHome(), true);
  assert.equal(h.currentSource(), source); assert.equal(source.disposed, false); assert.equal(request.options.signal.aborted, false);
  const value = await I.acknowledge(h, request); await h.showNotifications();
  assert.equal(h.currentSource(), source); assert.equal(source.disposed, false); assert.equal(h.owner('activeAppFormDialog'), null);
  assert.equal(h.state.view.surface.active, 'home'); assert.equal(h.count('navigate'), 1);
  assert.equal(h.cards().length, 1); assert.equal(h.cards()[0].id, value.job_ref); assert.match(h.cards()[0].markup, /Ready for review/);
  assert.equal(h.cards()[0].read, false); assert.equal(h.count('submit'), 1); assert.equal(h.count('process'), 0);
  assert.equal(h.count('read'), 0); assert.deepEqual(h.keys, keys);
  h.activate(value.job_ref); await settle(); assert.equal(h.count('navigate'), 2);
  assert.equal(h.navigations.at(-1).options.top_ref, null); assert.equal(h.owner('activeAppFormDialog'), null);
  await h.settleNavigation(); const returned = h.runtime.snapshot();
  assert.equal(returned.inLibrary, true); assert.equal(returned.visible, true); assert.equal(returned.topRef, null);
  assert.equal(returned.scopeKey, scope); assert.equal(h.currentSource(), source); assert.equal(source.disposed, false);
  assert.ok(h.formHost().querySelector('[aria-label="Source review"]')); assert.equal(h.cards()[0].read, true);
  assert.equal(h.count('read'), 0); assert.equal(h.count('submit'), 1); assert.equal(h.count('process'), 0); assert.deepEqual(h.keys, keys);
  await I.match(h, '2'); click(button(h.formHost(), 'Save Album Top')); await settle();
  const save = h.last('finalize'); assert.equal(save.body.source_review.job_ref, value.job_ref);
  save.reply(I.receipt(save.body)); await settle(); assert.ok(button(h.formHost(), 'Open Album Top'));
  assert.equal(h.count('finalize'), 1); assert.equal(h.count('navigate'), 2, 'completion and finalization never navigate automatically');
  I.privateFree(h, ['Private source completed while on Home']);
});
