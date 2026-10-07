const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const observerUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  'e2e',
  'helpers',
  'productionViewObserver.js',
)).href;

class FakePage {
  constructor() {
    this.listeners = new Map();
    this.frame = {};
  }

  mainFrame() { return this.frame; }

  emit(event, value) {
    for (const listener of this.listeners.get(event) || []) listener(value);
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
}

function request(url, method = 'GET') {
  return {
    method: () => method,
    url: () => url,
  };
}

function documentRequest(url) {
  return {
    isNavigationRequest: () => true,
    resourceType: () => 'document',
    url: () => url,
  };
}

function response(requestValue, payload, options = {}) {
  return {
    json: options.json || (async () => payload),
    ok: () => options.ok !== false,
    request: () => requestValue,
    status: () => Number(options.status || 200),
  };
}

function completedSaveTaskPayload(album) {
  return {
    ok: true,
    status: 'completed',
    updated_albums: [{
      album_artist: 'Rarity Artist',
      album_ref: album.key,
      key: album.key,
      name: album.name,
    }],
  };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('applied canonical artist comparison normalizes browser-collapsed whitespace only', async () => {
  const { hasAppliedCanonicalArtist } = await import(observerUrl);

  assert.equal(
    hasAppliedCanonicalArtist(['Signal  Family Lead'], ['Signal Family Lead']),
    true,
  );
  assert.equal(
    hasAppliedCanonicalArtist(['Signal Family Lead'], ['Signal Family Relative']),
    false,
  );
});

test('applied canonical artist surface accepts only a payload-backed stable empty DOM', async () => {
  const { hasAppliedCanonicalArtistSurface } = await import(observerUrl);
  const stableEmpty = { loaderVisible: false, payloadPresent: true, settledEmpty: false };

  assert.equal(hasAppliedCanonicalArtistSurface([], [], stableEmpty), true);
  assert.equal(hasAppliedCanonicalArtistSurface([], ['Stale Artist'], stableEmpty), false);
  assert.equal(hasAppliedCanonicalArtistSurface([], [], {
    loaderVisible: false,
    payloadPresent: false,
    settledEmpty: false,
  }), false);
  assert.equal(hasAppliedCanonicalArtistSurface([], [], {
    loaderVisible: true,
    payloadPresent: true,
    settledEmpty: true,
  }), true);
});

test('canonical group reader merges combined and selected-family payload fields', async () => {
  const { readCanonicalArtistGroups } = await import(observerUrl);
  const groups = readCanonicalArtistGroups({
    artist_groups: [],
    primary_artist_groups: [{
      artist: 'Signal  Family Lead',
      albums: [{ name: 'Double Space Signal' }],
    }],
    family_artist_groups: [{
      artist: 'Signal Family Relative',
      albums: [{ name: 'Relative Signal' }],
    }],
  });

  assert.deepEqual(groups, [
    { artist: 'Signal  Family Lead', albums: ['Double Space Signal'] },
    { artist: 'Signal Family Relative', albums: ['Relative Signal'] },
  ]);
});

test('DOM evidence stability rejects attachment and applied-artist changes during a sample', async () => {
  const { hasStableDomEvidence } = await import(observerUrl);

  assert.equal(hasStableDomEvidence(
    { attachedMatch: true, attachedArtists: ['Neal Morse'] },
    { attachedMatch: false, attachedArtists: ['Neal Morse'] },
  ), false);
  assert.equal(hasStableDomEvidence(
    { attachedArtists: ['Neal Morse'], sidebarArtists: ['Neal Morse'] },
    { attachedArtists: ['Neal Morse'], sidebarArtists: ['Transatlantic'] },
  ), false);
  assert.equal(hasStableDomEvidence(
    { attachedMatch: true, attachedArtists: ['Neal Morse'] },
    { attachedMatch: true, attachedArtists: ['Neal Morse'] },
  ), true);
});

test('a concurrent search preview cannot replace the observed complete payload', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const fullRequest = request('http://127.0.0.1/view-data?q=Neal');
  const previewRequest = request('http://127.0.0.1/view-data?q=Neal&payload_tier=search_preview');
  page.emit('request', fullRequest);
  page.emit('request', previewRequest);
  page.emit('response', response(fullRequest, { payload_tier: 'full', query: 'Neal' }));
  page.emit('requestfinished', fullRequest);
  page.emit('response', response(previewRequest, { payload_tier: 'search_preview', query: 'Neal' }));
  page.emit('requestfinished', previewRequest);
  await flushPromises();
  assert.equal(observer.read().latestFullPayload?.payload_tier, 'full');
  assert.equal(observer.read().latestFullPayloadError, null);
  assert.equal(observer.read().activeRequestCount, 0);
});

test('production view observer ignores sidebar payloads and retains the latest full request payload', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const sidebarRequest = request('http://127.0.0.1/view-data?payload_tier=sidebar');
  const fullRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');

  page.emit('request', sidebarRequest);
  page.emit('response', response(sidebarRequest, { payload_tier: 'sidebar', query: '' }));
  page.emit('requestfinished', sidebarRequest);
  page.emit('request', fullRequest);
  page.emit('response', response(fullRequest, { payload_tier: 'full', query: 'Neal' }));
  page.emit('requestfinished', fullRequest);
  await flushPromises();

  assert.equal(observer.read().latestFullPayload.query, 'Neal');
  assert.equal(observer.read().activeRequestCount, 0);
  assert.equal(observer.read().pendingPayloadReadCount, 0);
});

test('production view observer exposes the in-flight latest full payload read for POM synchronization', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const fullRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');
  let resolvePayload;
  const payload = new Promise((resolve) => {
    resolvePayload = resolve;
  });

  page.emit('request', fullRequest);
  page.emit('response', response(fullRequest, null, { json: () => payload }));
  page.emit('requestfinished', fullRequest);

  const settledRead = observer.readLatestFullPayloadWhenSettled();
  assert.equal(observer.read().pendingPayloadReadCount, 1);
  resolvePayload({ payload_tier: 'full', query: 'Neal' });

  const settled = await settledRead;
  assert.equal(settled.latestFullPayload.query, 'Neal');
  assert.equal(settled.pendingPayloadReadCount, 0);
});

test('production view observer cannot let an older out-of-order response replace the newest payload', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const olderRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');
  const newerRequest = request('http://127.0.0.1/view-data?surface=albums&q=Devin');

  page.emit('request', olderRequest);
  page.emit('request', newerRequest);
  page.emit('response', response(newerRequest, { payload_tier: 'full', query: 'Devin' }));
  page.emit('response', response(olderRequest, { payload_tier: 'full', query: 'Neal' }));
  page.emit('requestfinished', olderRequest);
  page.emit('requestfinished', newerRequest);
  await flushPromises();

  assert.equal(observer.read().latestFullPayload.query, 'Devin');
  assert.equal(observer.read().latestFullRequestUrl.endsWith('q=Devin'), true);
});

test('production view observer settles against the newest payload when an older body remains pending', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const olderRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');
  const newerRequest = request('http://127.0.0.1/view-data?surface=albums&q=Devin');
  let resolveOlderPayload;
  const olderPayload = new Promise((resolve) => {
    resolveOlderPayload = resolve;
  });

  page.emit('request', olderRequest);
  page.emit('request', newerRequest);
  page.emit('response', response(newerRequest, { payload_tier: 'full', query: 'Devin' }));
  page.emit('response', response(olderRequest, null, { json: () => olderPayload }));
  await flushPromises();

  const settled = await Promise.race([
    observer.readLatestFullPayloadWhenSettled(),
    new Promise((resolve) => setImmediate(() => resolve(null))),
  ]);
  resolveOlderPayload({ payload_tier: 'full', query: 'Neal' });
  await flushPromises();

  assert.equal(settled?.latestFullPayload?.query, 'Devin');
});

test('production view observer never falls back to an older payload after the newest request fails', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const olderRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');
  const newerRequest = request('http://127.0.0.1/view-data?surface=albums&q=Devin');

  page.emit('request', olderRequest);
  page.emit('response', response(olderRequest, { payload_tier: 'full', query: 'Neal' }));
  page.emit('requestfinished', olderRequest);
  await flushPromises();
  assert.equal(observer.read().latestFullPayload.query, 'Neal');

  page.emit('request', newerRequest);
  page.emit('response', response(newerRequest, null, { ok: false, status: 503 }));
  page.emit('requestfinished', newerRequest);

  assert.equal(observer.read().latestFullPayload, null);
  assert.match(observer.read().latestFullPayloadError, /HTTP 503/);
});

test('production view observer surfaces a latest transport failure instead of using bootstrap fallback', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const failedRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');

  page.emit('request', failedRequest);
  page.emit('requestfailed', failedRequest);

  assert.equal(observer.read().latestFullPayload, null);
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
});

test('production view observer clears AJAX authority when a replacement document commit arrives', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const viewRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');

  page.emit('request', viewRequest);
  page.emit('response', response(viewRequest, { payload_tier: 'full', query: 'Neal' }));
  page.emit('requestfinished', viewRequest);
  await flushPromises();
  assert.equal(observer.read().latestFullPayload.query, 'Neal');

  const navigation = documentRequest('http://127.0.0.1/?surface=albums');
  page.emit('request', navigation);
  page.emit('response', response(navigation, null));
  page.emit('documentcommitted');

  assert.equal(observer.read().latestFullPayload, null);
  assert.equal(observer.read().latestFullRequestUrl, '');
});

test('production view observer promotes the canonical home endpoint after search clear', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const searchRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');
  const homeRequest = request('http://127.0.0.1/home-data');

  page.emit('request', searchRequest);
  page.emit('response', response(searchRequest, { payload_tier: 'full', query: 'Neal' }));
  page.emit('requestfinished', searchRequest);
  await flushPromises();
  page.emit('request', homeRequest);
  page.emit('response', response(homeRequest, { payload_tier: 'full', query: '' }));
  page.emit('requestfinished', homeRequest);
  await flushPromises();

  assert.equal(observer.read().latestFullPayload.query, '');
  assert.equal(observer.read().latestFullRequestUrl, 'http://127.0.0.1/home-data');
});

test('production view observer retains a completed save-task terminal payload as canonical mutation evidence', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const saveTaskRequest = request(
    'http://127.0.0.1/utilities/save-task/selected-track-split',
  );
  const terminalPayload = {
    ok: true,
    status: 'completed',
    requires_view_refresh: true,
    updated_albums: [{
      album_artist: 'Rarity Artist',
      key: 'rarity artist::selected track split fixture 2',
      name: 'Selected Track Split Fixture 2',
    }],
  };

  page.emit('request', saveTaskRequest);
  page.emit('response', response(saveTaskRequest, terminalPayload));
  await flushPromises();

  assert.deepEqual(
    observer.read().latestCompletedSaveTaskPayload,
    terminalPayload,
  );
});

test('canonical album target evidence accepts a matching completed save-task adoption without a second view response', async () => {
  const observerModule = await import(observerUrl);
  assert.equal(
    typeof observerModule.readCanonicalAlbumTargetEvidence,
    'function',
    'expected a pure canonical-target evidence reader',
  );
  const staleFullPayload = {
    artist_groups: [{
      artist: 'Rarity Artist',
      albums: [{ name: 'Selected Track Split Fixture' }],
    }],
  };
  const terminalPayload = {
    ok: true,
    status: 'completed',
    updated_albums: [{
      album_artist: 'Rarity Artist',
      key: 'rarity artist::selected track split fixture 2',
      name: 'Selected Track Split Fixture 2',
    }],
  };

  const evidence = observerModule.readCanonicalAlbumTargetEvidence({
    latestCompletedSaveTaskPayload: terminalPayload,
    latestFullPayload: staleFullPayload,
  }, {
    album: 'Selected Track Split Fixture 2',
    artist: 'Rarity Artist',
  });

  assert.equal(evidence.canonicalMatch, true);
  assert.equal(evidence.canonicalSource, 'completed-save-task');
  assert.deepEqual(evidence.observedAlbums, [
    'Selected Track Split Fixture',
    'Selected Track Split Fixture 2',
  ]);
});

test('production view observer retains both canonical destinations across consecutive completed save tasks', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const firstRequest = request('http://127.0.0.1/utilities/save-task/terminal-1');
  const secondRequest = request('http://127.0.0.1/utilities/save-task/terminal-2');
  const firstPayload = completedSaveTaskPayload({
    key: 'rarity artist::selected track split fixture 2',
    name: 'Selected Track Split Fixture 2',
  });
  const secondPayload = completedSaveTaskPayload({
    key: 'rarity artist::selected track split result b',
    name: 'Selected Track Split Result B',
  });

  page.emit('request', firstRequest);
  page.emit('response', response(firstRequest, firstPayload));
  await flushPromises();
  page.emit('request', secondRequest);
  page.emit('response', response(secondRequest, secondPayload));
  await flushPromises();

  const observation = observer.read();
  const firstEvidence = readCanonicalAlbumTargetEvidence(observation, {
    album: 'Selected Track Split Fixture 2',
    artist: 'Rarity Artist',
  });
  const secondEvidence = readCanonicalAlbumTargetEvidence(observation, {
    album: 'Selected Track Split Result B',
    artist: 'Rarity Artist',
  });

  assert.equal(
    firstEvidence.canonicalMatch,
    true,
    'the second terminal payload must not erase the first destination identity',
  );
  assert.equal(secondEvidence.canonicalMatch, true);
  assert.deepEqual(observation.completedCanonicalMutationPayloads, [
    firstPayload,
    secondPayload,
  ]);
});

test('a newer completed payload replaces prior metadata for the same canonical album identity', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const firstRequest = request('http://127.0.0.1/utilities/save-task/same-album-before');
  const secondRequest = request('http://127.0.0.1/utilities/save-task/same-album-after');
  const canonicalKey = 'rarity artist::same canonical release';
  const firstPayload = {
    ...completedSaveTaskPayload({
      key: canonicalKey,
      name: 'Same Canonical Release (Old Name)',
    }),
    updated_albums: [{
      album_artist: 'Rarity Artist',
      album_ref: canonicalKey,
      edition: 'First metadata',
      key: canonicalKey,
      name: 'Same Canonical Release (Old Name)',
      year: 2024,
    }],
  };
  const secondPayload = {
    ...completedSaveTaskPayload({
      key: canonicalKey,
      name: 'Same Canonical Release',
    }),
    updated_albums: [{
      album_artist: 'Rarity Artist',
      album_ref: canonicalKey,
      edition: 'Corrected metadata',
      key: canonicalKey,
      name: 'Same Canonical Release',
      year: 2026,
    }],
  };

  page.emit('request', firstRequest);
  page.emit('response', response(firstRequest, firstPayload));
  await flushPromises();
  page.emit('request', secondRequest);
  page.emit('response', response(secondRequest, secondPayload));
  await flushPromises();

  const observation = observer.read();
  assert.equal(readCanonicalAlbumTargetEvidence(observation, {
    album: 'Same Canonical Release (Old Name)',
    artist: 'Rarity Artist',
  }).canonicalMatch, false);
  assert.equal(readCanonicalAlbumTargetEvidence(observation, {
    album: 'Same Canonical Release',
    artist: 'Rarity Artist',
  }).canonicalMatch, true);
  assert.deepEqual(observation.completedCanonicalMutationPayloads, [secondPayload]);
});

test('completed payload parsing atomically rejects malformed or duplicate canonical album identities', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const validKey = 'rarity artist::atomic valid destination';
  const cases = [
    {
      name: 'mixed valid and identity-free albums',
      payload: {
        ok: true,
        status: 'completed',
        updated_albums: [
          {
            album_artist: 'Rarity Artist',
            album_ref: validKey,
            key: validKey,
            name: 'Atomic Valid Destination',
          },
          {
            album_artist: 'Rarity Artist',
            name: 'Identity-Free Sibling',
          },
        ],
      },
    },
    {
      name: 'duplicate canonical identities',
      payload: {
        ok: true,
        status: 'completed',
        updated_albums: [
          {
            album_artist: 'Rarity Artist',
            album_ref: validKey,
            key: validKey,
            name: 'Atomic Valid Destination',
          },
          {
            album_artist: 'Rarity Artist',
            album_ref: validKey,
            edition: 'Duplicate row',
            key: validKey,
            name: 'Atomic Valid Destination',
          },
        ],
      },
    },
  ];
  const results = [];

  for (const invalidCase of cases) {
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    const saveRequest = request(
      `http://127.0.0.1/utilities/save-task/${encodeURIComponent(invalidCase.name)}`,
    );
    page.emit('request', saveRequest);
    page.emit('response', response(saveRequest, invalidCase.payload));
    await flushPromises();
    results.push({
      canonicalMatch: readCanonicalAlbumTargetEvidence(observer.read(), {
        album: 'Atomic Valid Destination',
        artist: 'Rarity Artist',
      }).canonicalMatch,
      name: invalidCase.name,
    });
  }

  assert.deepEqual(results, [
    { canonicalMatch: false, name: 'mixed valid and identity-free albums' },
    { canonicalMatch: false, name: 'duplicate canonical identities' },
  ]);
});

test('a full-view request supersedes a save task whose response resolves afterward', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const saveRequest = request('http://127.0.0.1/utilities/save-task/older-save');
  const fullRequest = request('http://127.0.0.1/view-data?surface=albums&q=Newer');
  const stalePayload = completedSaveTaskPayload({
    key: 'rarity artist::stale destination',
    name: 'Stale Destination',
  });

  page.emit('request', saveRequest);
  page.emit('request', fullRequest);
  page.emit('response', response(saveRequest, stalePayload));
  await flushPromises();

  const evidence = readCanonicalAlbumTargetEvidence(observer.read(), {
    album: 'Stale Destination',
    artist: 'Rarity Artist',
  });
  assert.equal(evidence.canonicalMatch, false);
});

test('document navigation supersedes a save task whose response resolves afterward', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const saveRequest = request('http://127.0.0.1/utilities/save-task/older-save');
  const stalePayload = completedSaveTaskPayload({
    key: 'rarity artist::stale destination',
    name: 'Stale Destination',
  });

  page.emit('request', saveRequest);
  const navigation = documentRequest('http://127.0.0.1/?surface=albums');
  page.emit('request', navigation);
  page.emit('response', response(navigation, null));
  page.emit('documentcommitted');
  page.emit('response', response(saveRequest, stalePayload));
  await flushPromises();

  const evidence = readCanonicalAlbumTargetEvidence(observer.read(), {
    album: 'Stale Destination',
    artist: 'Rarity Artist',
  });
  assert.equal(evidence.canonicalMatch, false);
});

test('an older save response cannot replace a newer save response that completed first', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const olderRequest = request('http://127.0.0.1/utilities/save-task/older-save');
  const newerRequest = request('http://127.0.0.1/utilities/save-task/newer-save');
  const olderPayload = completedSaveTaskPayload({
    key: 'rarity artist::older destination',
    name: 'Older Destination',
  });
  const newerPayload = completedSaveTaskPayload({
    key: 'rarity artist::newer destination',
    name: 'Newer Destination',
  });

  page.emit('request', olderRequest);
  page.emit('request', newerRequest);
  page.emit('response', response(newerRequest, newerPayload));
  page.emit('response', response(olderRequest, olderPayload));
  await flushPromises();

  const observation = observer.read();
  assert.equal(readCanonicalAlbumTargetEvidence(observation, {
    album: 'Newer Destination',
    artist: 'Rarity Artist',
  }).canonicalMatch, true);
  assert.equal(readCanonicalAlbumTargetEvidence(observation, {
    album: 'Older Destination',
    artist: 'Rarity Artist',
  }).canonicalMatch, false);
});

test('pending, failed, malformed, and non-2xx save-task responses never become canonical evidence', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const cases = [
    { name: 'pending', payload: { ok: true, status: 'running', updated_albums: [] } },
    { name: 'failed', payload: { ok: false, status: 'failed', updated_albums: [] } },
    {
      name: 'malformed JSON',
      options: { json: async () => { throw new SyntaxError('malformed JSON'); } },
      payload: null,
    },
    {
      name: 'non-2xx',
      options: { ok: false, status: 503 },
      payload: completedSaveTaskPayload({
        key: 'rarity artist::invalid destination',
        name: 'Invalid Destination',
      }),
    },
  ];

  for (const invalidCase of cases) {
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    const saveRequest = request(`http://127.0.0.1/utilities/save-task/${encodeURIComponent(invalidCase.name)}`);
    page.emit('request', saveRequest);
    page.emit('response', response(saveRequest, invalidCase.payload, invalidCase.options));
    await flushPromises();
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
      album: 'Invalid Destination',
      artist: 'Rarity Artist',
    }).canonicalMatch, false, invalidCase.name);
  }
});

test('a completed payload with ok false cannot become canonical mutation evidence', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const saveRequest = request('http://127.0.0.1/utilities/save-task/logical-failure');
  const payload = {
    ...completedSaveTaskPayload({
      key: 'rarity artist::invalid destination',
      name: 'Invalid Destination',
    }),
    ok: false,
  };

  page.emit('request', saveRequest);
  page.emit('response', response(saveRequest, payload));
  await flushPromises();

  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    album: 'Invalid Destination',
    artist: 'Rarity Artist',
  }).canonicalMatch, false);
});

test('a completed album without a canonical identity field cannot become mutation evidence', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const saveRequest = request('http://127.0.0.1/utilities/save-task/missing-identity');
  const payload = {
    ok: true,
    status: 'completed',
    updated_albums: [{
      album_artist: 'Rarity Artist',
      name: 'Identity-Free Destination',
    }],
  };

  page.emit('request', saveRequest);
  page.emit('response', response(saveRequest, payload));
  await flushPromises();

  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    album: 'Identity-Free Destination',
    artist: 'Rarity Artist',
  }).canonicalMatch, false);
});

test('a new full view clears accumulated completed mutation evidence', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const saveRequest = request('http://127.0.0.1/utilities/save-task/completed-save');
  const fullRequest = request('http://127.0.0.1/view-data?surface=albums&q=Newer');
  const payload = completedSaveTaskPayload({
    key: 'rarity artist::completed destination',
    name: 'Completed Destination',
  });

  page.emit('request', saveRequest);
  page.emit('response', response(saveRequest, payload));
  await flushPromises();
  page.emit('request', fullRequest);

  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    album: 'Completed Destination',
    artist: 'Rarity Artist',
  }).canonicalMatch, false);
  assert.deepEqual(observer.read().completedCanonicalMutationPayloads, []);
});

test('document navigation clears accumulated completed mutation evidence', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const saveRequest = request('http://127.0.0.1/utilities/save-task/completed-save');
  const payload = completedSaveTaskPayload({
    key: 'rarity artist::completed destination',
    name: 'Completed Destination',
  });

  page.emit('request', saveRequest);
  page.emit('response', response(saveRequest, payload));
  await flushPromises();
  const navigation = documentRequest('http://127.0.0.1/?surface=albums');
  page.emit('request', navigation);
  page.emit('response', response(navigation, null));
  page.emit('documentcommitted');

  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    album: 'Completed Destination',
    artist: 'Rarity Artist',
  }).canonicalMatch, false);
  assert.deepEqual(observer.read().completedCanonicalMutationPayloads, []);
});

test('production view observer revision exposes a transition that starts and finishes during a DOM sample', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const initialRevision = observer.read().stateRevision;
  const viewRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');

  page.emit('request', viewRequest);
  page.emit('response', response(viewRequest, { payload_tier: 'full', query: 'Neal' }));
  page.emit('requestfinished', viewRequest);
  await flushPromises();

  const settled = observer.read();
  assert.equal(settled.activeRequestCount, 0);
  assert.equal(settled.pendingPayloadReadCount, 0);
  assert.equal(settled.stateRevision > initialRevision, true);
});


test('replacement document commit discards refreshes started by the outgoing document after navigation began', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const navigation = documentRequest('http://127.0.0.1/?q=Signal');
  page.emit('request', navigation);
  const outgoingRefresh = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', outgoingRefresh);
  page.emit('response', response(navigation, null));
  page.emit('documentcommitted');
  page.emit('requestfailed', outgoingRefresh);
  assert.equal(observer.read().activeRequestCount, 0);
  assert.equal(observer.read().latestFullPayloadError, null);
  const currentRefresh = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', currentRefresh);
  page.emit('requestfailed', currentRefresh);
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
});

test('same-document and child-frame navigation retain current request failures', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const currentRefresh = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', currentRefresh);
  page.emit('framenavigated', page.mainFrame());
  page.emit('framenavigated', {});
  page.emit('requestfailed', currentRefresh);
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
});

test('replacement document commit rejects late outgoing save payload parsing errors', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const navigation = documentRequest('http://127.0.0.1/?q=Signal');
  page.emit('request', navigation);
  const outgoingSave = request('http://127.0.0.1/utilities/save-task/task-one');
  let rejectRead;
  page.emit('request', outgoingSave);
  page.emit('response', response(outgoingSave, null, { json: () => new Promise((resolve, reject) => { rejectRead = reject; }) }));
  page.emit('response', response(navigation, null));
  page.emit('documentcommitted');
  assert.equal(typeof rejectRead, 'function');
  rejectRead(new Error('outgoing body aborted'));
  await flushPromises();
  assert.equal(observer.read().latestFullPayloadError, null);
});


test('pending same-document navigation and canceled document requests do not clear current failures', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const navigation = documentRequest('http://127.0.0.1/?q=Signal');
  const outgoingRefresh = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', outgoingRefresh);
  page.emit('requestfailed', outgoingRefresh);
  page.emit('request', navigation);
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
  page.emit('framenavigated', page.mainFrame());
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
  page.emit('requestfailed', navigation);
  page.emit('framenavigated', page.mainFrame());
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
  const currentRefresh = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', currentRefresh);
  page.emit('requestfailed', currentRefresh);
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
});


test('child document responses cannot discard main-document request failures', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const currentRefresh = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', currentRefresh);
  const childNavigation = { ...documentRequest('http://127.0.0.1/child'), frame: () => ({}) };
  page.emit('request', childNavigation);
  page.emit('response', response(childNavigation, null));
  page.emit('requestfailed', currentRefresh);
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
});

test('current document save parsing failures remain visible after replacement', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const navigation = documentRequest('http://127.0.0.1/?q=Signal');
  page.emit('request', navigation);
  page.emit('response', response(navigation, null));
  page.emit('documentcommitted');
  const currentSave = request('http://127.0.0.1/utilities/save-task/task-two');
  page.emit('request', currentSave);
  page.emit('response', response(currentSave, null, { json: async () => { throw new Error('current body malformed'); } }));
  await flushPromises();
  assert.equal(observer.read().latestFullPayloadError, 'current body malformed');
});


test('redirect chains replace document authority only at the final commit', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const outgoing = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', outgoing);
  page.emit('requestfailed', outgoing);
  const redirect = documentRequest('http://127.0.0.1/redirect');
  page.emit('request', redirect);
  page.emit('response', response(redirect, null, { status: 302, ok: false }));
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
  const destination = documentRequest('http://127.0.0.1/?q=Signal');
  page.emit('request', destination);
  const lateOutgoing = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', lateOutgoing);
  page.emit('response', response(destination, null));
  page.emit('documentcommitted');
  page.emit('requestfailed', lateOutgoing);
  assert.equal(observer.read().latestFullPayloadError, null);
  const current = request('http://127.0.0.1/view-data?q=Signal');
  page.emit('request', current);
  page.emit('requestfailed', current);
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
});

for (const status of [204, 205]) {
  test(`document response ${status} keeps current-page evidence because no document replaces it`, async () => {
    const { ProductionViewObserver } = await import(observerUrl);
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    const current = request('http://127.0.0.1/view-data?q=Signal');
    page.emit('request', current);
    page.emit('requestfailed', current);
    const navigation = documentRequest('http://127.0.0.1/no-content');
    page.emit('request', navigation);
    page.emit('response', response(navigation, null, { status }));
    page.emit('framenavigated', page.mainFrame());
    assert.match(observer.read().latestFullPayloadError, /Request failed/);
  });
}


test('root continuation permits SSR telemetry but replacement requests do not', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const { GalleryPage } = await import(pathToFileURL(path.join(__dirname, '..', 'e2e', 'poms', 'galleryPage.js')).href);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const payload = { payload_tier: 'gallery_page', query: '', gallery_page: { revision: 'r1', has_more: true } };
  const owner = { productionViewObserver: observer, page: { url: () => 'http://127.0.0.1/?surface=albums' },
    readProductionBootstrapPayload: async () => ({ initial_view: payload }) };
  page.emit('request', request('http://127.0.0.1/view-data?surface=albums&gallery_cursor=next'));
  assert.equal(observer.read().onlyRootContinuationsPending, true);
  assert.equal(await GalleryPage.prototype.readLatestProductionViewPayload.call(owner), payload);
  owner.page.url = () => 'http://127.0.0.1/?q=Devin';
  await assert.rejects(() => GalleryPage.prototype.readLatestProductionViewPayload.call(owner), /observed production view/);
  owner.page.url = () => 'http://127.0.0.1/?surface=albums';
  page.emit('request', request('http://127.0.0.1/view-data?q=Devin'));
  assert.equal(observer.read().onlyRootContinuationsPending, false);
  await assert.rejects(() => GalleryPage.prototype.readLatestProductionViewPayload.call(owner), /observed production view/);
});

test('unfinished replacement body blocks SSR fallback during a later root continuation', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const search = request('http://127.0.0.1/view-data?q=Devin');
  let finishBody;
  const body = new Promise(resolve => { finishBody = resolve; });
  page.emit('request', search);
  page.emit('response', response(search, null, { json: () => body }));
  page.emit('requestfinished', search);
  page.emit('request', request('http://127.0.0.1/view-data?gallery_cursor=next'));
  assert.equal(observer.read().pendingPayloadReadCount, 1);
  assert.equal(observer.read().onlyRootContinuationsPending, false);
  finishBody({ payload_tier: 'full', query: 'Devin' });
  await body;
});

test('accumulated root evidence rejects stale page revision and scope', async () => {
  const { matchesAccumulatedRootProjection, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const payload = { payload_tier: 'gallery_page', query: '', selected_artist: '', gallery_scope: 'all',
    visible_library_categories: ['main_library'], gallery_page: { revision: 'r1', next_cursor: null, has_more: false },
    artist_groups: [{ artist: 'Last', albums: [{ name: 'Last album' }] }] };
  const projection = { ...payload, surface: 'albums', artist_groups: [
    { artist: 'First', albums: [{ name: 'Earlier album' }] }, ...payload.artist_groups] };
  assert.equal(matchesAccumulatedRootProjection(payload, projection), true);
  const target = { artist: 'First', album: 'Earlier album' };
  assert.equal(readCanonicalAlbumTargetEvidence({ latestFullPayload: payload }, target).canonicalMatch, false);
  assert.equal(readCanonicalAlbumTargetEvidence({ latestFullPayload: { ...payload, artist_groups: projection.artist_groups } }, target).canonicalMatch, true);
  for (const changed of [{ query: 'Devin' }, { selected_artist: 'First' }, { surface: 'playlists' },
    { gallery_scope: 'changed' }, { visible_library_categories: ['hoard'] }, { busy: true }, { pendingViewTransition: true },
    { gallery_page: { ...payload.gallery_page, revision: 'r2' } },
    { gallery_page: { ...payload.gallery_page, next_cursor: 'other' } },
    { gallery_page: { ...payload.gallery_page, has_more: true } },
  ]) assert.equal(matchesAccumulatedRootProjection(payload, { ...projection, ...changed }), false, JSON.stringify(changed));
});

test('local sidebar membership uses applied scope without inheriting old search completeness', async () => {
  const { readAppliedAlbumTargetEvidence } = await import(observerUrl);
  const groups = [{ artist: 'Morse Portnoy George', albums: [{ name: 'Cover to Cover' }] }];
  const payload = { payload_tier: 'full', query: 'Morse, Portnoy & George', artist_groups: groups };
  const applied = { query: '', selected_artist: 'Morse Portnoy George', locationQuery: '', locationArtist: 'Morse Portnoy George', surface: 'albums', artist_groups: groups };
  const evidence = readAppliedAlbumTargetEvidence({ latestFullPayload: payload }, applied, null,
    { artist: 'Morse Portnoy George', album: 'Cover to Cover' });
  assert.equal(evidence.canonicalMatch, true);
  assert.equal(evidence.canonicalQuery, '');
  assert.equal(evidence.canonicalInventoryComplete, false);
  const root = readAppliedAlbumTargetEvidence({ latestFullPayload: payload }, { ...applied, selected_artist: '' }, null,
    { artist: 'Missing', album: 'Missing' });
  assert.equal(root.canonicalInventoryComplete, false);
});

test('restored exhausted root requires its existing bootstrap revision and scope', async () => {
  const { readAppliedAlbumTargetEvidence } = await import(observerUrl);
  const bootstrap = { payload_tier: 'gallery_page', query: '', selected_artist: '', gallery_scope: 'all',
    visible_library_categories: ['main_library'], gallery_page: { revision: 'root1', has_more: true, next_cursor: 'first' },
    artist_groups: [{ artist: 'First', albums: [{ name: 'First album' }] }] };
  const applied = { ...bootstrap, surface: 'albums', gallery_page: { revision: 'root1', has_more: false, next_cursor: null } };
  const observation = { latestFullPayload: { payload_tier: 'full', query: 'old search', artist_groups: [] } };
  const expected = { artist: 'Missing', album: 'Missing' };
  assert.equal(readAppliedAlbumTargetEvidence(observation, applied, bootstrap, expected).canonicalInventoryComplete, true);
  for (const changed of [{ gallery_scope: 'changed' }, { visible_library_categories: ['hoard'] },
    { gallery_page: { ...applied.gallery_page, revision: 'different' } }]) {
    assert.equal(readAppliedAlbumTargetEvidence(observation, { ...applied, ...changed }, bootstrap, expected).canonicalInventoryComplete, false);
  }
});

test('positive server or applied evidence blocks absence even when the other side omits the target', async () => {
  const { readAppliedAlbumTargetEvidence } = await import(observerUrl);
  const groups = [{ artist: 'Artist', albums: [{ name: 'Album', key: 'album' }] }];
  const expected = { artist: 'Artist', album: 'Album' };
  for (const [server, applied] of [[groups, []], [[], groups]]) {
    const evidence = readAppliedAlbumTargetEvidence({ latestFullPayload: { payload_tier: 'full', artist_groups: server } },
      { surface: 'albums', artist_groups: applied }, null, expected);
    assert.equal(evidence.canonicalInventoryComplete, true);
    assert.equal(evidence.canonicalMatch, true);
    assert.equal(evidence.canonicalReadyMatch, false);
  }
  const anchor = { payload_tier: 'gallery_page', artist_groups: groups, gallery_page: { revision: 'root', has_more: false } };
  const root = readAppliedAlbumTargetEvidence({ latestFullPayload: anchor }, { ...anchor, surface: 'albums', artist_groups: [] }, null, expected);
  assert.equal(root.canonicalMatch, true);
  assert.equal(root.canonicalReadyMatch, false);
});

test('local selection evidence rejects a new query, changed filters, and unsupported surfaces', async () => {
  const { readAppliedAlbumTargetEvidence } = await import(observerUrl);
  const groups = [{ artist: 'Artist', albums: [{ name: 'Album' }] }];
  const payload = { payload_tier: 'full', query: 'Neal', artist_groups: groups };
  const applied = { query: 'Neal', surface: 'albums', artist_groups: groups };
  for (const changed of [{ query: 'Devin' }, { gallery_scope: 'new_arrivals' },
    { visible_library_categories: ['hoard'] }, { surface: 'playlists' },
    { query: '', selected_artist: 'Artist', locationArtist: 'Other' }]) {
    const evidence = readAppliedAlbumTargetEvidence({ latestFullPayload: payload }, { ...applied, ...changed }, null,
      { artist: 'Artist', album: 'Album' });
    assert.equal(evidence.canonicalReadyMatch, false, JSON.stringify(changed));
    assert.equal(evidence.canonicalInventoryComplete, false);
  }
});

test('scoped family completeness requires the existing pure product authority and complete source identities', async () => {
  const { readAppliedAlbumTargetEvidence } = await import(observerUrl);
  const groups = [{ artist: 'Lead', albums: [{ name: 'Album', key: 'one' }] },
    { artist: 'Partner', albums: [{ name: 'Partner album', key: 'two' }] }];
  const payload = { payload_tier: 'full', query: 'Lead', artist_groups: groups };
  const applied = { query: '', selected_artist: 'Partner', locationQuery: '', locationArtist: 'Partner',
    surface: 'albums', artist_groups: groups, authoritativeMountedFamily: true };
  const expected = { artist: 'Guest', album: 'Foreign' };
  assert.equal(readAppliedAlbumTargetEvidence({ latestFullPayload: payload }, applied, null, expected).canonicalInventoryComplete, true);
  const narrower = readAppliedAlbumTargetEvidence({ latestFullPayload: payload }, { ...applied, artist_groups: groups.slice(1) }, null,
    { artist: 'Lead', album: 'Album' });
  assert.equal(narrower.canonicalInventoryComplete, true);
  assert.equal(narrower.canonicalMatch, false, 'Unrelated old source groups are not members of the certified current family');
  for (const changed of [{ authoritativeMountedFamily: false }, { artist_groups: [{ artist: 'Partner', albums: [] }] },
    { selected_artist: '', locationArtist: '' }, { gallery_scope: 'changed' }]) {
    assert.equal(readAppliedAlbumTargetEvidence({ latestFullPayload: payload }, { ...applied, ...changed }, null, expected).canonicalInventoryComplete, false);
  }
});

test('same-query Partner-to-Lead reparenting retains the complete authoritative family', async () => {
  const { readAppliedAlbumTargetEvidence } = await import(observerUrl);
  const groups = ['Control Signal Partner', 'Control Signal Lead'].map(artist => ({ artist,
    albums: Array.from({ length: 12 }, (_, index) => ({ name: `Album ${index}`, key: `${artist}:${index}` })) }));
  const payload = { payload_tier: 'full', query: 'Control Signal Partner', selected_artist: 'Control Signal Partner',
    gallery_scope: 'all', visible_library_categories: ['main_library', 'new_arrivals', 'hoard'], artist_groups: groups };
  const applied = { ...payload, selected_artist: 'Control Signal Lead', surface: 'albums',
    locationQuery: payload.query, locationArtist: 'Control Signal Lead', authoritativeMountedFamily: true,
    artist_groups: [...groups].reverse() };
  assert.equal(readAppliedAlbumTargetEvidence({ latestFullPayload: payload }, applied, null,
    { artist: 'Control Signal Partner', album: 'Guest-only foreign album' }).canonicalInventoryComplete, true);
  const { GalleryPage } = await import(pathToFileURL(path.join(__dirname, '..', 'e2e', 'poms', 'galleryPage.js')).href);
  const vm = require('node:vm');
  const snapshot = await GalleryPage.prototype.readAppliedGalleryProjection.call({ page: {
    evaluate: fn => vm.runInNewContext(`(${fn.toString()})()`, { state: { view: applied, ui: {} },
      buildOptimisticSidebarArtistSelectionGroups: () => ({ skipFetch: true }), URL,
      window: { location: { href: 'http://127.0.0.1/?q=Control%20Signal%20Partner&artist=Control%20Signal%20Lead' } } }),
  } });
  assert.equal(snapshot.authoritativeMountedFamily, true);
});

test('bounded gallery pages expose browse telemetry without claiming a complete inventory', async () => {
  const { ProductionViewObserver, hasCompleteCanonicalAlbumInventory } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const pageRequest = request('http://127.0.0.1/view-data?gallery_page_size=50&gallery_cursor=next');
  const payload = { payload_tier: 'gallery_page', persistence_backend: 'postgres', gallery_page: { has_more: true } };
  page.emit('request', pageRequest);
  page.emit('response', response(pageRequest, payload));
  page.emit('requestfinished', pageRequest);
  const observation = await observer.readLatestFullPayloadWhenSettled();
  assert.equal(observation.latestFullPayloadError, null);
  assert.deepEqual(observation.latestFullPayload, payload);
  assert.equal(hasCompleteCanonicalAlbumInventory(payload), false);
  assert.equal(hasCompleteCanonicalAlbumInventory({ ...payload, gallery_page: { has_more: false } }), false,
    'even the final page alone cannot prove absence from earlier pages');
  assert.equal(hasCompleteCanonicalAlbumInventory({ payload_tier: 'full' }), true);
  assert.equal(hasCompleteCanonicalAlbumInventory(null), false);
});

test('browse telemetry accepts the actual SSR first-paint payload without a redundant full request', async () => {
  const { GalleryPage } = await import(pathToFileURL(path.join(__dirname, '..', 'e2e', 'poms', 'galleryPage.js')).href);
  const payload = { payload_tier: 'gallery_page', persistence_backend: 'postgres', artist_count: 6045, album_count: 14674 };
  const owner = {
    productionViewObserver: { readLatestFullPayloadWhenSettled: async () => ({ latestFullPayload: null, latestFullPayloadError: null, activeRequestCount: 0, pendingPayloadReadCount: 0 }) },
    readProductionBootstrapPayload: async () => ({ startup_payload: { first_paint_view: payload } }),
  };
  assert.equal(await GalleryPage.prototype.readLatestProductionViewPayload.call(owner), payload);
  owner.productionViewObserver.readLatestFullPayloadWhenSettled = async () => ({ latestFullPayload: null, latestFullPayloadError: null, activeRequestCount: 1, pendingPayloadReadCount: 0 });
  await assert.rejects(() => GalleryPage.prototype.readLatestProductionViewPayload.call(owner), /Expected an observed production view/);
  owner.productionViewObserver.readLatestFullPayloadWhenSettled = async () => ({ latestFullPayload: null, latestFullPayloadError: null, activeRequestCount: 0, pendingPayloadReadCount: 0 });
  owner.readProductionBootstrapPayload = async () => null;
  await assert.rejects(() => GalleryPage.prototype.readLatestProductionViewPayload.call(owner), /Expected an observed production view/);
});
