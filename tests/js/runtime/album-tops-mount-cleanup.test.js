'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const F = require('./album-tops-native-gallery-fixture.cjs');

for (const stage of ['initial Filter', 'Filter update', 'first Gallery card']) {
  test(`failed ${stage} construction retires actual native owners and permits a clean remount`, async t => {
    const env = N.nativeEnvironment(), service = N.service();
    service.data.detail = F.detail();
    const original = await N.preparedController(service);
    t.after(() => original.dispose());
    const subscriptions = new Set();
    const controller = {...original, subscribe(callback) {
      const unsubscribe = original.subscribe(callback); subscriptions.add(callback);
      return () => {subscriptions.delete(callback); unsubscribe();};
    }};
    const {mountAlbumTopsView} = await N.load('album-tops/app.mjs');
    const props = {controller, providers: service.providers, state: controller.getSnapshot(), onOpen() {}};
    const failure = new Error(`Injected ${stage} renderer failure`);
    const actionHtml = env.runtime.actionHtml, galleryCardHtml = env.runtime.galleryCardHtml;
    env.runtime.actionHtml = config => {
      if (config.icon === 'filters' && (stage === 'initial Filter'
        || stage === 'Filter update' && config.attributes?.['aria-controls'])) throw failure;
      return actionHtml(config);
    };
    env.runtime.galleryCardHtml = config => {
      if (stage === 'first Gallery card') throw failure;
      return galleryCardHtml(config);
    };
    assert.throws(() => mountAlbumTopsView(env.host, env.runtime, props), error => error === failure);
    assert.equal(env.host.children.length, 0, 'Failed view removes only its own section');
    assert.equal(subscriptions.size, 0, 'Partially created filter subscription is retired');
    env.assertClean();
    env.runtime.actionHtml = actionHtml; env.runtime.galleryCardHtml = galleryCardHtml;
    const mounted = mountAlbumTopsView(env.host, env.runtime, props);
    assert.equal(env.host.querySelectorAll('.album-card').length, 2);
    assert.ok(env.button(env.host, 'Filter'));
    mounted.dispose(); mounted.dispose();
    assert.equal(subscriptions.size, 0);
    env.assertClean();
  });
}
