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

test('observed progressive pages prove returned album presence without claiming full-view authority', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const first = request('http://127.0.0.1/view-data?surface=albums&category=main_library&payload_tier=sidebar');
  page.emit('request', first);
  page.emit('response', response(first, {
    payload_tier: 'sidebar',
    artist_groups: [{ artist: 'First Artist', albums: [{ key: 'first', name: 'First Album' }] }],
    gallery_page: { offset: 0, next_offset: 6 },
  }));
  page.emit('requestfinished', first);
  await flushPromises();
  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    artist: 'First Artist', album: 'First Album',
  }).canonicalMatch, true);
  assert.equal(observer.read().latestFullPayload, null, 'partial pages cannot authorize full counts or absence');

  const next = request('http://127.0.0.1/view-data?surface=albums&category=main_library&payload_tier=sidebar&gallery_offset=6');
  page.emit('request', next);
  assert.equal(observer.read().galleryBusy, true);
  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    artist: 'Next Artist', album: 'Next Album',
  }).canonicalMatch, false, 'a requested page is not observed authority');
  page.emit('response', response(next, {
    payload_tier: 'sidebar',
    artist_groups: [{ artist: 'Next Artist', albums: [{ key: 'next', name: 'Next Album' }] }],
    gallery_page: { offset: 6, next_offset: 12 },
  }));
  page.emit('requestfinished', next);
  await flushPromises();
  for (const [artist, album] of [['First Artist', 'First Album'], ['Next Artist', 'Next Album']]) {
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), { artist, album }).canonicalMatch, true);
  }
  assert.equal(observer.read().latestFullPayload, null);
  assert.equal(observer.read().galleryBusy, false);
});

for (const transition of ['append', 'query', 'category', 'group', 'replacement', 'document', 'mutation']) {
  test(`delayed append body preserves presence only across same-scope append: ${transition}`, async () => {
    const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    const base = 'http://127.0.0.1/view-data?surface=albums&category=main_library&payload_tier=sidebar';
    const initial = request(base);
    page.emit('request', initial);
    page.emit('response', response(initial, {
      payload_tier: 'sidebar', artist_groups: [], gallery_page: { offset: 0, next_offset: 6 },
    }));
    page.emit('requestfinished', initial);
    await flushPromises();

    const earlier = request(`${base}&gallery_offset=6`);
    let resolveEarlier;
    const earlierBody = new Promise((resolve) => { resolveEarlier = resolve; });
    page.emit('request', earlier);
    page.emit('response', response(earlier, null, { json: () => earlierBody }));
    page.emit('requestfinished', earlier);
    if (transition === 'document') page.emit('documentcommitted');
    if (transition === 'mutation') {
      const save = request('http://127.0.0.1/utilities/save-task/replace-gallery');
      page.emit('request', save);
      page.emit('response', response(save, { ok: true, status: 'completed', updated_albums: [] }));
      page.emit('requestfinished', save);
      await flushPromises();
    }
    const nextUrl = new URL(base);
    nextUrl.searchParams.set('gallery_offset', transition === 'replacement' ? '0' : '12');
    if (transition === 'query') nextUrl.searchParams.set('q', 'New Search');
    if (transition === 'category') nextUrl.searchParams.set('category', 'hoard');
    if (transition === 'group') nextUrl.searchParams.set('artist', 'Next Artist');
    const next = request(nextUrl.href);
    page.emit('request', next);
    const latestPage = { offset: transition === 'replacement' ? 0 : 12, next_offset: 18 };
    page.emit('response', response(next, {
      payload_tier: 'sidebar',
      artist_groups: [{ artist: 'Next Artist', albums: [{ key: 'next', name: 'Next Album' }] }],
      gallery_page: latestPage,
    }));
    page.emit('requestfinished', next);
    await flushPromises();

    resolveEarlier({
      payload_tier: 'sidebar',
      artist_groups: [{ artist: 'Earlier Artist', albums: [{ key: 'earlier', name: 'Earlier Album' }] }],
      gallery_page: { offset: 6, next_offset: 12 },
    });
    await flushPromises();
    const observation = observer.read();
    assert.equal(readCanonicalAlbumTargetEvidence(observation, {
      artist: 'Earlier Artist', album: 'Earlier Album',
    }).canonicalMatch, transition === 'append');
    assert.equal(readCanonicalAlbumTargetEvidence(observation, {
      artist: 'Next Artist', album: 'Next Album',
    }).canonicalMatch, true);
    assert.equal(Object.hasOwn(observation.galleryArtistTopologies, 'Earlier Artist'), transition === 'append');
    assert.deepEqual(observation.latestGalleryPage, latestPage, 'older bodies cannot rewind continuation metadata');
    assert.equal(observation.latestGalleryPageError, null);
    assert.equal(observation.latestFullPayload, null, 'observed pages do not establish full-view authority');
    assert.equal(observation.pendingPayloadReadCount, 0);
    assert.equal(observation.galleryBusy, false);
  });
}

for (const reset of ['document', 'category', 'replacement']) {
  test(`progressive album presence cannot survive ${reset} authority replacement`, async () => {
    const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    const url = 'http://127.0.0.1/view-data?surface=albums&category=main_library&payload_tier=sidebar';
    const first = request(url);
    page.emit('request', first);
    page.emit('response', response(first, {
      payload_tier: 'sidebar',
      artist_groups: [{ artist: 'Artist', albums: [{ key: 'old', name: 'Old Album' }] }],
      gallery_page: { offset: 0, next_offset: 6 },
    }));
    page.emit('requestfinished', first);
    await flushPromises();
    const target = { artist: 'Artist', album: 'Old Album' };
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, true);
    if (reset === 'document') page.emit('documentcommitted');
    else page.emit('request', request(reset === 'category' ? url.replace('main_library', 'hoard') : url));
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, false);
    page.emit('response', response(first, {
      payload_tier: 'sidebar',
      artist_groups: [{ artist: 'Artist', albums: [{ key: 'old', name: 'Old Album' }] }],
      gallery_page: { offset: 0, next_offset: 6 },
    }));
    await flushPromises();
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, false,
      'a late response from the replaced authority cannot resurrect the old album');
  });
}

for (const invalidation of ['document', 'category', 'completed mutation', 'empty completed mutation']) {
  test(`observed family identities support local restoration only until ${invalidation}`, async () => {
    const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    const search = request('http://127.0.0.1/view-data?surface=albums&q=Lead+Solo&category=main_library');
    page.emit('request', search);
    page.emit('response', response(search, {
      payload_tier: 'full',
      query: 'Lead Solo',
      selected_artist: 'Lead',
      visible_library_categories: ['main_library'],
      family_artist_groups: [{ artist: 'Partner', albums: [{ key: 'partner-solo', name: 'Partner Solo' }] }],
    }));
    page.emit('requestfinished', search);
    await flushPromises();
    const target = { artist: 'Partner', album: 'Partner Solo' };
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, true);
    const root = request('http://127.0.0.1/view-data?surface=albums&category=main_library&payload_tier=sidebar');
    page.emit('request', root);
    page.emit('response', response(root, {
      payload_tier: 'sidebar', query: '', selected_artist: '',
      visible_library_categories: ['main_library'],
      artist_groups: [{ artist: 'Other', albums: [{ key: 'other', name: 'Other Album' }] }],
      gallery_page: { offset: 0, next_offset: 6 },
    }));
    page.emit('requestfinished', root);
    await flushPromises();
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, true,
      'local family restoration must retain the exact previously observed server identity');
    assert.equal(observer.read().latestFullPayload, null,
      'retained family presence is not authority for full root counts or absence');
    if (invalidation === 'document') page.emit('documentcommitted');
    else if (invalidation === 'category') {
      page.emit('request', request('http://127.0.0.1/view-data?surface=albums&category=hoard&payload_tier=sidebar'));
    } else {
      const save = request('http://127.0.0.1/utilities/save-task/family-mutation');
      page.emit('request', save);
      page.emit('response', response(save, {
        ok: true, status: 'completed',
        updated_albums: invalidation === 'empty completed mutation' ? []
          : [{ key: 'partner-renamed', album_artist: 'Partner', name: 'Renamed Album' }],
      }));
      page.emit('requestfinished', save);
      await flushPromises();
    }
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, false,
      'retained historical family data must not validate a changed scope or library');
  });
}

test('a delayed page read cannot restore album authority after a completed mutation', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const pending = request('http://127.0.0.1/view-data?surface=albums&payload_tier=sidebar');
  let resolvePayload;
  const payloadRead = new Promise((resolve) => { resolvePayload = resolve; });
  page.emit('request', pending);
  page.emit('response', response(pending, null, { json: () => payloadRead }));
  page.emit('requestfinished', pending);
  const save = request('http://127.0.0.1/utilities/save-task/remove-last-album');
  page.emit('request', save);
  page.emit('response', response(save, { ok: true, status: 'completed', updated_albums: [] }));
  page.emit('requestfinished', save);
  await flushPromises();
  resolvePayload({
    payload_tier: 'sidebar',
    artist_groups: [{ artist: 'Artist', albums: [{ key: 'removed', name: 'Removed Album' }] }],
    gallery_page: { offset: 0, next_offset: 6 },
  });
  await flushPromises();
  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    artist: 'Artist', album: 'Removed Album',
  }).canonicalMatch, false);
  assert.equal(observer.read().latestFullPayload, null);
});

test('partial search pages cannot seed retained family authority across root navigation', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const partial = request('http://127.0.0.1/view-data?surface=albums&q=Lead&category=main_library&payload_tier=sidebar');
  page.emit('request', partial);
  page.emit('response', response(partial, {
    payload_tier: 'sidebar', selected_artist: 'Lead',
    visible_library_categories: ['main_library'],
    family_artist_groups: [{ artist: 'Partner', albums: [{ key: 'partner', name: 'Partner Solo' }] }],
    gallery_page: { offset: 0, next_offset: 6 },
  }));
  page.emit('requestfinished', partial);
  await flushPromises();
  page.emit('request', request('http://127.0.0.1/view-data?surface=albums&category=main_library&payload_tier=sidebar'));
  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), {
    artist: 'Partner', album: 'Partner Solo',
  }).canonicalMatch, false, 'only a complete observed family scope may seed retained family authority');
});

test('a newer complete search replaces older family album authority in the same categories', async () => {
  const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const originalTarget = { artist: 'Partner', album: 'Partner Solo' };
  const replacementTarget = { artist: 'Replacement', album: 'Replacement Solo' };
  for (const [query, target] of [['Lead', originalTarget], ['Replacement', replacementTarget]]) {
    const current = request(`http://127.0.0.1/view-data?surface=albums&q=${query}&category=main_library`);
    page.emit('request', current);
    page.emit('response', response(current, {
      payload_tier: 'full', query, selected_artist: query,
      visible_library_categories: ['main_library'],
      family_artist_groups: [{
        artist: target.artist,
        albums: [{ key: `${target.artist}::solo`, name: target.album }],
      }],
    }));
    page.emit('requestfinished', current);
    await flushPromises();
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, true);
  }
  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), originalTarget).canonicalMatch, false,
    'historical family presence cannot override a newer accepted complete response');
  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), replacementTarget).canonicalMatch, true);
});

test('production view observer retains current gallery continuation without full-view authority', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const current = request('http://127.0.0.1/view-data?payload_tier=sidebar&gallery_offset=12');
  page.emit('request', current);
  page.emit('response', response(current, { payload_tier: 'sidebar', gallery_page: { offset: 12, next_offset: 18 } }));
  page.emit('requestfinished', current);
  await flushPromises();
  assert.deepEqual(observer.read().latestGalleryPage, { offset: 12, next_offset: 18 });
  assert.equal(observer.read().latestFullPayload, null);
});

test('production gallery continuation rejects stale filter and document responses', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const older = request('http://127.0.0.1/view-data?payload_tier=sidebar&gallery_offset=12');
  const newer = request('http://127.0.0.1/view-data?q=Neal');
  page.emit('request', older);
  page.emit('request', newer);
  page.emit('response', response(newer, { payload_tier: 'full' }));
  page.emit('response', response(older, { payload_tier: 'sidebar', gallery_page: { offset: 12, next_offset: 18 } }));
  await flushPromises();
  assert.equal(observer.read().latestGalleryPage, null);
  page.emit('documentcommitted');
  page.emit('response', response(older, { gallery_page: { offset: 12, next_offset: 18 } }));
  await flushPromises();
  assert.equal(observer.read().latestGalleryPage, null);
});

test('unrelated surface and sidebar-only responses preserve gallery continuation', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const gallery = request('http://127.0.0.1/view-data?surface=albums&payload_tier=sidebar');
  page.emit('request', gallery);
  page.emit('response', response(gallery, { gallery_page: { offset: 12, next_offset: 18 } }));
  page.emit('requestfinished', gallery);
  await flushPromises();
  const sidebar = request('http://127.0.0.1/view-data?surface=artists&payload_tier=sidebar');
  page.emit('request', sidebar);
  assert.equal(observer.read().galleryBusy, false);
  page.emit('response', response(sidebar, { artists_sidebar: [] }));
  page.emit('requestfinished', sidebar);
  await flushPromises();
  assert.deepEqual(observer.read().latestGalleryPage, { offset: 12, next_offset: 18 });
});

for (const replacement of ['sidebar', 'completed mutation']) {
  test(`pending bootstrap family read cannot survive newer ${replacement}`, async () => {
    const { events, observer, gallery, bootstrap, target } = await committedFamilyGallery();
    const { readCanonicalAlbumTargetEvidence } = await import(observerUrl);
    events.emit('documentcommitted');
    let resolveBootstrap;
    let markReadStarted;
    const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
    gallery.readProductionBootstrapPayload = () => {
      markReadStarted();
      return new Promise((resolve) => { resolveBootstrap = resolve; });
    };
    const pendingState = gallery.readAlbumTargetState(target);
    await readStarted;
    const current = request(replacement === 'sidebar'
      ? 'http://localhost/view-data?surface=albums&category=main_library&payload_tier=sidebar'
      : 'http://localhost/utilities/save-task/bootstrap-race');
    events.emit('request', current);
    events.emit('response', response(current, replacement === 'sidebar'
      ? { payload_tier: 'sidebar', visible_library_categories: ['main_library'], artist_groups: [] }
      : { ok: true, status: 'completed', updated_albums: [] }));
    events.emit('requestfinished', current);
    await flushPromises();
    resolveBootstrap(bootstrap);
    const staleState = await pendingState;
    assert.equal(staleState.canonicalApplied, false,
      'a bootstrap read crossed by a newer response cannot establish applied presence');
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, false,
      'stale bootstrap family identities must not enter retained observer evidence');
    assert.equal((await gallery.readAlbumTargetState(target)).canonicalMatch, false);
    assert.equal(observer.read().canonicalScopeComplete, false);
  });
}

for (const failure of ['HTTP 500', 'invalid JSON', 'requestfailed']) {
  test(`gallery continuation surfaces ${failure} instead of exhaustion`, async () => {
    const { ProductionViewObserver } = await import(observerUrl);
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    const current = request('http://127.0.0.1/view-data?surface=albums&payload_tier=sidebar&gallery_offset=18');
    page.emit('request', current);
    if (failure === 'requestfailed') page.emit('requestfailed', current);
    else {
      page.emit('response', response(current, null, failure === 'HTTP 500'
        ? { ok: false, status: 500 }
        : { json: async () => { throw new Error('invalid JSON'); } }));
      page.emit('requestfinished', current);
    }
    await flushPromises();
    assert.match(observer.read().latestGalleryPageError, failure === 'requestfailed' ? /Request failed/ : new RegExp(failure));
    assert.equal(observer.read().galleryBusy, false);
    page.emit('request', request('http://127.0.0.1/view-data?q=New'));
    page.emit('response', response(current, null, { ok: false, status: 500 }));
    page.emit('requestfailed', current);
    await flushPromises();
    assert.equal(observer.read().latestGalleryPageError, null, 'old failures must not poison the newer filter');
    page.emit('documentcommitted');
    page.emit('requestfailed', current);
    assert.equal(observer.read().latestGalleryPageError, null, 'old failures must not poison the newer document');
  });
}

test('topology authority separates append activity, replacement, and canonical saves', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  async function deliver(url, payload) {
    const req = request(url);
    page.emit('request', req);
    page.emit('response', response(req, payload));
    page.emit('requestfinished', req);
    await flushPromises();
  }
  const group = { artist: 'Rarity Artist', albums: [{ name: 'Album', year: 2002 }] };
  await deliver('http://localhost/view-data?surface=albums', { artist_groups: [group] });
  const original = observer.read();
  assert.equal(typeof original.topologyRevision, 'number');
  await deliver('http://localhost/view-data?surface=albums&payload_tier=sidebar&gallery_offset=6', {
    artist_groups: [{ artist: 'Other', albums: [] }], gallery_page: { offset: 6, next_offset: 12 },
  });
  assert.equal(observer.read().topologyRevision, original.topologyRevision);
  assert.equal(observer.read().galleryArtistTopologies['Rarity Artist'], original.galleryArtistTopologies['Rarity Artist']);
  assert.ok(observer.read().stateRevision > original.stateRevision);
  await deliver('http://localhost/view-data?surface=albums&payload_tier=sidebar&gallery_offset=12', {
    artist_groups: [{ ...group, albums: [...group.albums, { name: 'Album', year: 2014 }] }],
  });
  assert.notEqual(observer.read().galleryArtistTopologies['Rarity Artist'], original.galleryArtistTopologies['Rarity Artist']);
  await deliver('http://localhost/utilities/save-task/save1', completedSaveTaskPayload({ key: 'new', name: 'New Album' }));
  const saved = observer.read();
  assert.ok(saved.topologyRevision > original.topologyRevision);
  await deliver('http://localhost/utilities/save-task/save1', { ...completedSaveTaskPayload({ key: 'new', name: 'New Album' }), elapsed_ms: 100 });
  assert.equal(observer.read().topologyRevision, saved.topologyRevision, 'Repeated completed polls are not new authority');
  await deliver('http://localhost/view-data?surface=albums&payload_tier=sidebar', { artist_groups: [] });
  assert.ok(observer.read().topologyRevision > saved.topologyRevision);
  assert.equal(observer.read().latestFullPayload, null, 'A replacement cannot retain pre-save full authority');
  assert.equal(observer.read().allowBootstrapFallback, false);
  const replaced = observer.read().topologyRevision;
  page.emit('documentcommitted');
  assert.ok(observer.read().topologyRevision > replaced);
});

for (const offset of [0, 12]) {
test(`sidebar scope change at offset ${offset} rejects delayed full responses and foreign-filter mutation authority`, async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const full = request('http://localhost/view-data?surface=albums&q=old');
  page.emit('request', full);
  const save = request('http://localhost/utilities/save-task/old');
  page.emit('request', save);
  page.emit('response', response(save, completedSaveTaskPayload({ key: 'old', name: 'Old' })));
  page.emit('requestfinished', save);
  await flushPromises();
  page.emit('request', request(`http://localhost/view-data?surface=albums&payload_tier=sidebar&q=new&gallery_offset=${offset}`));
  page.emit('response', response(full, { artist_groups: [{ artist: 'Old', albums: [] }] }));
  page.emit('requestfinished', full);
  await flushPromises();
  assert.equal(observer.read().latestFullPayload, null);
  assert.deepEqual(observer.read().completedCanonicalMutationPayloads, []);
});
}

function request(url, method = 'GET') {
  return {
    method: () => method,
    url: () => url,
  };
}

for (const required of [false, true]) {
  test(`committed bootstrap-only gallery preserves startup hydration required=${required}`, async () => {
    const { ProductionViewObserver } = await import(observerUrl);
    const { GalleryPage } = await import(new URL('../poms/galleryPage.js', observerUrl));
    const events = new FakePage();
    const observer = new ProductionViewObserver(events, events);
    assert.equal(observer.read().allowBootstrapFallback, false, 'uncommitted documents have no authority');
    events.emit('documentcommitted');
    const gallery = Object.create(GalleryPage.prototype);
    gallery.productionViewObserver = observer;
    gallery.readProductionBootstrapPayload = async () => ({
      bootstrap: { startupHydration: { required, tier: 'full', trigger: required ? 'immediate' : 'none' } },
      initial_view: {
        payload_tier: 'full', query: '',
        artist_groups: [{ artist: 'Artist', albums: [{ key: 'album', name: 'Album' }] }],
      },
    });
    gallery.page = { locator: () => ({ count: async () => 0 }), url: () => 'http://localhost/' };
    gallery.albumCard = { detailsButtonByArtistAndAlbum: () => ({ count: async () => 1 }) };
    gallery.libraryLoader = { isVisible: async () => false };
    gallery.artistHeadings = { allTextContents: async () => ['Artist'] };

    const state = await gallery.readAlbumTargetState({ artist: 'Artist', album: 'Album' });
    assert.equal(state.canonicalMatch, true, 'current inline payload proves the exact album');
    assert.equal(state.canonicalApplied, true);
    assert.equal(state.busy, false);
    assert.equal(state.startupHydrating, required, 'DOM settlement cannot override required hydration');
    assert.equal(observer.read().latestFullPayload, null, 'bootstrap is not an observed AJAX response');
    assert.equal(observer.read().canonicalScopeComplete, false, 'eligibility alone cannot prove absence');
  });
}

async function committedFamilyGallery() {
  const { ProductionViewObserver } = await import(observerUrl);
  const { GalleryPage } = await import(new URL('../poms/galleryPage.js', observerUrl));
  const events = new FakePage();
  const observer = new ProductionViewObserver(events, events);
  events.emit('documentcommitted');
  const bootstrap = {
    bootstrap: { startupHydration: { required: false, tier: 'full', trigger: 'none' } },
    initial_view: {
      payload_tier: 'full', query: 'Lead Solo', visible_library_categories: ['main_library'],
      family_artist_groups: [{ artist: 'Partner', albums: [{ key: 'partner-solo', name: 'Partner Solo' }] }],
    },
  };
  const gallery = Object.create(GalleryPage.prototype);
  gallery.productionViewObserver = observer;
  gallery.readProductionBootstrapPayload = async () => bootstrap;
  gallery.page = {
    locator: () => ({ count: async () => 0 }),
    url: () => 'http://localhost/?category=main_library',
  };
  gallery.albumCard = { detailsButtonByArtistAndAlbum: () => ({ count: async () => 1 }) };
  gallery.libraryLoader = { isVisible: async () => false };
  gallery.artistHeadings = { allTextContents: async () => ['Partner'] };
  const target = { artist: 'Partner', album: 'Partner Solo' };
  assert.equal((await gallery.readAlbumTargetState(target)).canonicalMatch, true);
  return { events, observer, gallery, bootstrap, target };
}

test('committed bootstrap family presence survives sidebar replacement without absence authority', async () => {
  const { events, observer, gallery, target } = await committedFamilyGallery();
  const sidebar = request('http://localhost/view-data?surface=albums&category=main_library&payload_tier=sidebar');
  events.emit('request', sidebar);
  events.emit('response', response(sidebar, {
    payload_tier: 'sidebar', query: '', selected_artist: '',
    visible_library_categories: ['main_library'],
    artist_groups: [{ artist: 'Other', albums: [{ key: 'other', name: 'Other Album' }] }],
    gallery_page: { offset: 0, next_offset: 6 },
  }));
  events.emit('requestfinished', sidebar);
  await flushPromises();

  const state = await gallery.readAlbumTargetState(target);
  assert.equal(state.canonicalMatch, true, 'cached member must retain observed server identity');
  assert.equal(state.canonicalApplied, true);
  assert.equal(state.pendingViewTransition, false);
  assert.equal(state.startupHydrating, false);
  assert.equal(state.canonicalScopeComplete, false, 'cached family is never complete root evidence');
  assert.equal(observer.read().latestFullPayload, null);
  assert.equal((await gallery.readAlbumTargetState({ artist: 'Partner', album: 'Unknown Album' })).canonicalMatch, false);

  const next = request('http://localhost/view-data?surface=albums&category=main_library&payload_tier=sidebar&gallery_offset=6');
  events.emit('request', next);
  events.emit('response', response(next, {
    payload_tier: 'sidebar',
    artist_groups: [{ artist: 'Next Artist', albums: [{ key: 'next', name: 'Next Album' }] }],
    gallery_page: { offset: 6, next_offset: 12 },
  }));
  events.emit('requestfinished', next);
  await flushPromises();
  const { readCanonicalAlbumTargetEvidence } = await import(observerUrl);
  assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), { artist: 'Next Artist', album: 'Next Album' }).canonicalMatch, true);
  assert.equal((await gallery.readAlbumTargetState(target)).canonicalMatch, true);
  assert.equal(observer.read().canonicalScopeComplete, false);
});

for (const invalidation of ['category', 'document', 'completed mutation']) {
  test(`committed bootstrap cached family presence is revoked by ${invalidation}`, async () => {
    const { events, gallery, bootstrap, target } = await committedFamilyGallery();
    if (invalidation === 'document') {
      bootstrap.initial_view = { payload_tier: 'full', artist_groups: [] };
      events.emit('documentcommitted');
    } else {
      const current = request(invalidation === 'category'
        ? 'http://localhost/view-data?surface=albums&category=hoard&payload_tier=sidebar'
        : 'http://localhost/utilities/save-task/family-mutation');
      events.emit('request', current);
      events.emit('response', response(current, invalidation === 'category'
        ? { payload_tier: 'sidebar', visible_library_categories: ['hoard'], artist_groups: [] }
        : { ok: true, status: 'completed', updated_albums: [] }));
      events.emit('requestfinished', current);
      await flushPromises();
    }
    assert.equal((await gallery.readAlbumTargetState(target)).canonicalMatch, false);
  });
}

for (const failure of ['HTTP 500', 'invalid JSON', 'requestfailed']) {
  test(`committed bootstrap cached family cannot mask sidebar ${failure}`, async () => {
    const { events, gallery, target } = await committedFamilyGallery();
    const current = request('http://localhost/view-data?surface=albums&category=main_library&payload_tier=sidebar');
    events.emit('request', current);
    if (failure === 'requestfailed') events.emit('requestfailed', current);
    else {
      events.emit('response', response(current, null, failure === 'HTTP 500'
        ? { ok: false, status: 500 }
        : { json: async () => { throw new Error('invalid JSON'); } }));
      events.emit('requestfinished', current);
    }
    await flushPromises();
    await assert.rejects(() => gallery.readAlbumTargetState(target),
      failure === 'requestfailed' ? /Request failed/ : new RegExp(failure));
  });
}

for (const endpoint of ['/view-data', '/view-data?payload_tier=sidebar', '/home-data', '/utilities/save-task/current']) {
  test(`current document ${endpoint} invalidates bootstrap fallback at request start`, async () => {
    const { ProductionViewObserver } = await import(observerUrl);
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    page.emit('documentcommitted');
    assert.equal(observer.read().allowBootstrapFallback, true);
    const current = request(`http://localhost${endpoint}`);
    page.emit('request', current);
    assert.equal(observer.read().allowBootstrapFallback, false);
    assert.equal(observer.read().activeRequestCount, 1);
    page.emit('requestfinished', current);
    assert.equal(observer.read().allowBootstrapFallback, false, 'request completion cannot revive inline state');
  });
}

test('late outgoing payload reads cannot become current bootstrap document authority', async () => {
  const { ProductionViewObserver } = await import(observerUrl);
  const page = new FakePage();
  const observer = new ProductionViewObserver(page, page);
  const outgoing = request('http://localhost/view-data?q=Outgoing');
  let resolveBody;
  page.emit('request', outgoing);
  page.emit('response', response(outgoing, null, { json: () => new Promise((resolve) => { resolveBody = resolve; }) }));
  page.emit('documentcommitted');
  resolveBody({ payload_tier: 'full', query: 'Outgoing', artist_groups: [{ artist: 'Outgoing', albums: [] }] });
  page.emit('requestfinished', outgoing);
  await flushPromises();
  assert.equal(observer.read().allowBootstrapFallback, true);
  assert.equal(observer.read().latestFullPayload, null);
  assert.deepEqual(observer.read().observedGalleryGroups, []);
  assert.equal(observer.read().latestFullPayloadError, null);
  assert.equal(observer.read().activeRequestCount, 0);
  assert.equal(observer.read().pendingPayloadReadCount, 0);
});

for (const failure of ['HTTP 500', 'invalid JSON', 'requestfailed']) {
  test(`current bootstrap document ${failure} cannot fall back to inline payload`, async () => {
    const { ProductionViewObserver } = await import(observerUrl);
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    page.emit('documentcommitted');
    const current = request('http://localhost/view-data?q=Current');
    page.emit('request', current);
    if (failure === 'requestfailed') page.emit('requestfailed', current);
    else {
      page.emit('response', response(current, null, failure === 'HTTP 500'
        ? { ok: false, status: 500 }
        : { json: async () => { throw new Error('invalid JSON'); } }));
      page.emit('requestfinished', current);
    }
    await flushPromises();
    assert.equal(observer.read().allowBootstrapFallback, false);
    assert.equal(observer.read().latestFullPayload, null);
    assert.match(observer.read().latestFullPayloadError, failure === 'requestfailed' ? /Request failed/ : new RegExp(failure));
  });
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

for (const [kind, updatedAlbums] of [
  ['empty', []],
  ['malformed', [{ album_artist: 'Rarity Artist', name: 'Unidentified Destination' }]],
]) {
  test(`a ${kind} completed mutation invalidates older completed-save album authority`, async () => {
    const { ProductionViewObserver, readCanonicalAlbumTargetEvidence } = await import(observerUrl);
    const page = new FakePage();
    const observer = new ProductionViewObserver(page, page);
    const original = request('http://127.0.0.1/utilities/save-task/original-destination');
    page.emit('request', original);
    page.emit('response', response(original, completedSaveTaskPayload({
      key: 'rarity artist::original destination', name: 'Original Destination',
    })));
    page.emit('requestfinished', original);
    await flushPromises();
    const target = { artist: 'Rarity Artist', album: 'Original Destination' };
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, true);

    const later = request(`http://127.0.0.1/utilities/save-task/${kind}-mutation`);
    page.emit('request', later);
    page.emit('response', response(later, {
      ok: true, status: 'completed', updated_albums: updatedAlbums,
    }));
    page.emit('requestfinished', later);
    await flushPromises();
    assert.equal(readCanonicalAlbumTargetEvidence(observer.read(), target).canonicalMatch, false,
      'a completed write without usable destinations must not leave old mutation evidence authoritative');
    assert.equal(observer.read().latestCompletedSaveTaskPayload, null);
    assert.deepEqual(observer.read().completedCanonicalMutationPayloads, []);
  });
}

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
