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
  }

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

test('production view observer ignores sidebar payloads and retains the latest full request payload', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
  const failedRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');

  page.emit('request', failedRequest);
  page.emit('requestfailed', failedRequest);

  assert.equal(observer.read().latestFullPayload, null);
  assert.match(observer.read().latestFullPayloadError, /Request failed/);
});

test('production view observer clears AJAX authority when a new document navigation starts', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page);
  const viewRequest = request('http://127.0.0.1/view-data?surface=albums&q=Neal');

  page.emit('request', viewRequest);
  page.emit('response', response(viewRequest, { payload_tier: 'full', query: 'Neal' }));
  page.emit('requestfinished', viewRequest);
  await flushPromises();
  assert.equal(observer.read().latestFullPayload.query, 'Neal');

  page.emit('request', documentRequest('http://127.0.0.1/?surface=albums'));

  assert.equal(observer.read().latestFullPayload, null);
  assert.equal(observer.read().latestFullRequestUrl, '');
});

test('production view observer promotes the canonical home endpoint after search clear', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
    const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
  const saveRequest = request('http://127.0.0.1/utilities/save-task/older-save');
  const stalePayload = completedSaveTaskPayload({
    key: 'rarity artist::stale destination',
    name: 'Stale Destination',
  });

  page.emit('request', saveRequest);
  page.emit('request', documentRequest('http://127.0.0.1/?surface=albums'));
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
  const observer = new ProductionViewObserver(page);
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
    const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
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
  const observer = new ProductionViewObserver(page);
  const saveRequest = request('http://127.0.0.1/utilities/save-task/completed-save');
  const payload = completedSaveTaskPayload({
    key: 'rarity artist::completed destination',
    name: 'Completed Destination',
  });

  page.emit('request', saveRequest);
  page.emit('response', response(saveRequest, payload));
  await flushPromises();
  page.emit('request', documentRequest('http://127.0.0.1/?surface=albums'));

  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    album: 'Completed Destination',
    artist: 'Rarity Artist',
  }).canonicalMatch, false);
  assert.deepEqual(observer.read().completedCanonicalMutationPayloads, []);
});

test('production view observer revision exposes a transition that starts and finishes during a DOM sample', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page);
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
