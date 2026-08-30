const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const helperPath = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'music_app',
  'static',
  'js',
  'runtime',
  'bootstrap-state.js',
);
const helperSource = fs.readFileSync(helperPath, 'utf8');

test('bootstrap release drops every retained embedded view patch while preserving hydration routing', () => {
  const startupHydrationPatch = {
    artists_sidebar: [{ artist: 'Broadcast', count: 1 }],
  };
  const payloadTierPatch = {
    artists_sidebar: [{ artist: 'Stereolab', count: 2 }],
  };
  const windowPayload = {
    initial_view: {
      selected_artist: 'Broadcast',
    },
    startup_payload: {
      first_paint_view: {
        selected_artist: 'Broadcast',
      },
    },
    bootstrap: {
      startupHydration: {
        required: true,
        endpoint: '/view-data?payload_tier=sidebar',
        followupEndpoint: '/view-data',
        tier: 'sidebar',
        embeddedViewPatch: startupHydrationPatch,
      },
      startupPayloadTiers: {
        hydration: {
          required: true,
          endpoint: '/view-data?payload_tier=sidebar',
          followupEndpoint: '/view-data',
          tier: 'sidebar',
          embeddedViewPatch: payloadTierPatch,
        },
      },
    },
  };
  const context = {
    document: {
      querySelector() {
        return null;
      },
    },
    window: {
      __ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__: windowPayload,
    },
  };

  vm.createContext(context);
  vm.runInContext(`${helperSource}\nthis.testAppBootstrap = appBootstrap;`, context, {
    filename: helperPath,
  });

  const beforeRelease = context.testAppBootstrap.getBootstrap();
  assert.deepEqual(
    JSON.parse(JSON.stringify(beforeRelease.startupHydration.embeddedViewPatch)),
    startupHydrationPatch,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(beforeRelease.startupPayloadTiers.hydration.embeddedViewPatch)),
    payloadTierPatch,
  );

  context.testAppBootstrap.releasePayloadViewState();

  const afterRelease = context.testAppBootstrap.getBootstrap();
  assert.equal(afterRelease.startupHydration.embeddedViewPatch, null);
  assert.equal(afterRelease.startupPayloadTiers.hydration.embeddedViewPatch, null);
  assert.equal(windowPayload.bootstrap.startupHydration.embeddedViewPatch, null);
  assert.equal(windowPayload.bootstrap.startupPayloadTiers.hydration.embeddedViewPatch, null);
  assert.equal(windowPayload.initial_view, null);
  assert.equal(windowPayload.startup_payload.first_paint_view, null);
  assert.equal(afterRelease.startupHydration.endpoint, '/view-data?payload_tier=sidebar');
  assert.equal(afterRelease.startupHydration.followupEndpoint, '/view-data');
  assert.equal(afterRelease.startupHydration.tier, 'sidebar');
});
