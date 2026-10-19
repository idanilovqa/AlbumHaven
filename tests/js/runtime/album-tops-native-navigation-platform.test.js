'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {nativeEnvironment} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');

test('real navigation shell baselines reject extra listeners and observers without retiring persistent owners', () => {
  const env = nativeEnvironment({inlineNavigation: true});
  const persistent = env.observers.filter(owner => !owner.retired);
  assert.equal(persistent.length, 2, 'Private transport and Top bridge each observe the actual shell');
  assert.equal(env.runtime.registerDraftNavigation, env.context.AlbumHavenAlbumTopsRuntime.registerDraftNavigation);
  assert.equal(env.runtime.deferDraftNavigation, env.context.AlbumHavenAlbumTopsRuntime.deferDraftNavigation);
  assert.equal(env.runtime.deferDraftNavigation(() => assert.fail('No editor owns navigation')), false);
  env.assertClean();
  const listener = () => {};
  env.context.addEventListener('fixture-leak', listener);
  assert.throws(() => env.assertClean(), /native global header\/gesture listeners retired/);
  env.context.removeEventListener('fixture-leak', listener); env.assertClean();
  const observer = new env.context.MutationObserver(() => {}); observer.observe(env.host);
  assert.throws(() => env.assertClean(), /native observers disconnected/);
  observer.disconnect(); env.assertClean();
  env.document.addEventListener('fixture-leak', listener);
  assert.throws(() => env.assertClean(), /connected listeners restored/);
  env.document.removeEventListener('fixture-leak', listener); env.assertClean();
  assert.ok(persistent.every(owner => !owner.retired), 'View cleanup cannot retire shell-lifetime owners');
});

test('retiring a persistent navigation observer is also an ownership failure', () => {
  const env = nativeEnvironment({inlineNavigation: true});
  env.observers.find(owner => !owner.retired).disconnect();
  assert.throws(() => env.assertClean(), /native observers disconnected/);
});
