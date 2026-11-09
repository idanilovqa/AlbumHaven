// The app-copy service worker: routing, per-account copies, age limit, deletion, asset versions and
// cover eviction (instant return, IAR-001..IAR-009).
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createAppCopyWorker, CACHE_PREFIX, COPY_HEADER, VERSION_HEADER, MAX_COPY_AGE_MS,
} = require(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'app-copy-worker.js'));

const ORIGIN = 'https://sandbox9.albumhaven.org';
const DAY_MS = 24 * 60 * 60 * 1000;

function fakeCaches() {
  const stores = new Map();
  const keyOf = request => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
  const open = (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        async match(request) { return entries.get(keyOf(request))?.clone(); },
        async put(request, response) {
          const key = keyOf(request);
          entries.delete(key);
          entries.set(key, response);
        },
        async delete(request) { return entries.delete(keyOf(request)); },
        async keys() { return [...entries.keys()].map(url => new Request(url)); },
      });
    }
    return stores.get(name);
  };
  return {
    stores,
    async keys() { return [...stores.keys()]; },
    async open(name) { return open(name); },
    async delete(name) { return stores.delete(name); },
  };
}

function page(account, { version = 'v1', body = 'Library', cacheControl = 'private, no-cache', status = 200 } = {}) {
  return new Response(
    `<!doctype html><html><head><meta name="album-haven-app-copy" content="network" data-account="${account}"></head><body>${body}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl, [COPY_HEADER]: account, [VERSION_HEADER]: version } },
  );
}

function setup({ respond = () => page('acct-a'), maxCovers } = {}) {
  const caches = fakeCaches();
  const calls = [];
  let clock = 1_000_000;
  const fetch = async (request) => {
    calls.push(request);
    const response = await respond(request);
    if (response instanceof Error) throw response;
    return response;
  };
  const worker = createAppCopyWorker({ caches, fetch, origin: ORIGIN, now: () => clock, maxCovers });
  const handle = async (request) => {
    const route = worker.route(request);
    return route ? worker.handle(route, request) : null;
  };
  return { caches, calls, worker, handle, advance(ms) { clock += ms; } };
}

const navigation = (pathAndQuery = '/') => ({ url: `${ORIGIN}${pathAndQuery}`, method: 'GET', mode: 'navigate' });
const resource = (pathAndQuery, method = 'GET') => new Request(`${ORIGIN}${pathAndQuery}`, { method });
const accountCaches = caches => [...caches.stores.keys()].filter(name => name.startsWith(CACHE_PREFIX));

test('first start loads the page from the network as a copy request and keeps it for the account', async () => {
  const { caches, calls, handle } = setup();

  const response = await handle(navigation('/'));

  assert.match(await response.text(), /content="network"/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get(COPY_HEADER), '1');
  assert.equal(calls[0].cache, 'no-store');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].credentials, 'same-origin');
  assert.deepEqual(accountCaches(caches), [`${CACHE_PREFIX}acct-a`]);
});

test('a fresh copy answers the navigation without waiting for the network', async () => {
  const { calls, handle } = setup();
  await handle(navigation('/?artist=Broadcast'));

  const response = await handle(navigation('/?artist=Broadcast'));

  assert.equal(calls.length, 1);
  assert.match(await response.text(), /content="cache" data-account="acct-a"/);
});

test('a copy of another page is not shown for this one', async () => {
  const { calls, handle } = setup();
  await handle(navigation('/?artist=Broadcast'));

  await handle(navigation('/?artist=Mono'));

  assert.equal(calls.length, 2);
});

test('IAR-007: a copy older than seven days is not shown and the page loads from the network', async () => {
  const { calls, handle, advance } = setup();
  await handle(navigation('/'));
  advance(MAX_COPY_AGE_MS + 1);

  const response = await handle(navigation('/'));

  assert.equal(calls.length, 2);
  assert.match(await response.text(), /content="network"/);
});

test('a copy kept later than now (the clock was set back) is not shown', async () => {
  const { calls, handle, advance } = setup();
  await handle(navigation('/'));
  advance(-1);

  await handle(navigation('/'));

  assert.equal(calls.length, 2);
});

test('a copy just under seven days old is still shown', async () => {
  const { calls, handle, advance } = setup();
  await handle(navigation('/'));
  advance(MAX_COPY_AGE_MS - 1);

  await handle(navigation('/'));

  assert.equal(calls.length, 1);
});

test('IAR-009: responses the server did not mark as copies, or marked no-store, are never kept', async () => {
  for (const response of [
    new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
    page('acct-a', { cacheControl: 'no-store, max-age=0' }),
    page('acct-a', { status: 500 }),
  ]) {
    const { caches, handle } = setup({ respond: () => response });
    await handle(navigation('/'));
    assert.deepEqual(accountCaches(caches), []);
  }
});

test('IAR-006: a page for another account deletes the previous account\'s copy', async () => {
  let account = 'acct-a';
  const { caches, handle } = setup({ respond: () => page(account) });
  await handle(navigation('/'));
  account = 'acct-b';

  await handle(navigation('/?artist=Mono'));

  assert.deepEqual(accountCaches(caches), [`${CACHE_PREFIX}acct-b`]);
});

test('IAR-006: signing out, signing in and the sign-in pages delete every copy at once', async () => {
  for (const request of [
    resource('/logout', 'POST'), resource('/login', 'POST'), navigation('/login'), navigation('/accept-invitation?token=x'),
    navigation('/password-reset'),
  ]) {
    const { caches, handle, worker } = setup();
    await handle(navigation('/'));
    assert.equal(worker.route(request), 'forget');
    await worker.handle('forget', request);
    assert.deepEqual(accountCaches(caches), [], request.url);
  }
});

test('IAR-006: a page answered by a redirect (signed out) deletes the copy', async () => {
  let signedIn = true;
  const { caches, handle } = setup({
    respond: () => (signedIn ? page('acct-a') : Response.redirect(`${ORIGIN}/login`, 303)),
  });
  await handle(navigation('/'));
  signedIn = false;

  await handle(navigation('/?artist=Mono'));

  assert.deepEqual(accountCaches(caches), []);
});

test('IAR-009: admin, account and other pages are never routed through the copy', () => {
  const { worker } = setup();
  for (const request of [
    navigation('/account'), navigation('/admin/members'), navigation('/news'), resource('/bootstrap-data'),
    resource('/view-data'), resource('/status'), resource('/app-copy/account'), resource('/utilities/edit-tags', 'POST'),
    { url: 'https://example.org/', method: 'GET', mode: 'navigate' },
  ]) {
    assert.equal(worker.route(request), null, request.url);
  }
});

test('versioned assets are kept by version and served from the copy', async () => {
  const assetResponse = () => new Response('js', { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
  const { calls, handle } = setup({ respond: request => (new URL(request.url).pathname === '/' ? page('acct-a') : assetResponse()) });
  await handle(navigation('/'));

  await handle(resource('/static/app.js?v=v1'));
  const again = await handle(resource('/static/app.js?v=v1'));

  assert.equal(await again.text(), 'js');
  assert.equal(calls.filter(request => request.url.includes('app.js')).length, 1);
});

test('assets the server did not mark immutable are not served from the copy while online', async () => {
  const { calls, handle } = setup({
    respond: request => (new URL(request.url).pathname === '/' ? page('acct-a') : new Response('js', { headers: { 'Cache-Control': 'no-store, max-age=0' } })),
  });
  await handle(navigation('/'));

  await handle(resource('/static/app.js?v=stale'));
  await handle(resource('/static/app.js?v=stale'));

  assert.equal(calls.filter(request => request.url.includes('app.js')).length, 2);
});

test('without a copy, assets go to the network and nothing is kept', async () => {
  const { caches, handle } = setup({ respond: () => new Response('js', { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }) });

  await handle(resource('/static/app.js?v=v1'));

  assert.deepEqual(accountCaches(caches), []);
});

test('IAR-004: a new version is kept for the next start while the running version stays available', async () => {
  let version = 'v1';
  const { caches, handle, worker } = setup({
    respond: request => (new URL(request.url).pathname === '/'
      ? page('acct-a', { version })
      : new Response(request.url, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } })),
  });
  await handle(navigation('/'));
  await handle(resource('/static/app.js?v=v1'));
  version = 'v2';

  // Saving the view while the v1 page runs keeps v1's assets for it.
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  const cache = caches.stores.get(`${CACHE_PREFIX}acct-a`);
  assert.ok(cache.entries.has(`${ORIGIN}/static/app.js?v=v1`));

  // The next start runs v2; v1's assets are no longer needed.
  const next = await handle(navigation('/'));
  assert.match(await next.text(), /content="cache"/);
  await handle(resource('/static/app.js?v=v2'));
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  assert.ok(!cache.entries.has(`${ORIGIN}/static/app.js?v=v1`));
  assert.ok(cache.entries.has(`${ORIGIN}/static/app.js?v=v2`));
});

test('cover thumbnails already seen are kept up to a bound, least recently used first out', async () => {
  const { caches, calls, handle } = setup({
    maxCovers: 2,
    respond: request => (new URL(request.url).pathname === '/'
      ? page('acct-a')
      : new Response(request.url, { headers: { 'Cache-Control': 'public, max-age=31536000' } })),
  });
  await handle(navigation('/'));
  await handle(resource('/cover?path=a&v=1'));
  await handle(resource('/cover?path=b&v=1'));
  await handle(resource('/cover?path=a&v=1'));
  await handle(resource('/cover?path=c&v=1'));

  const covers = [...caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.keys()].filter(url => url.includes('/cover'));
  assert.deepEqual(covers, [`${ORIGIN}/cover?path=a&v=1`, `${ORIGIN}/cover?path=c&v=1`]);
  assert.equal(calls.filter(request => request.url.includes('path=a')).length, 1);
});

test('short-lived covers are not kept', async () => {
  const { caches, handle } = setup({
    respond: request => (new URL(request.url).pathname === '/'
      ? page('acct-a')
      : new Response('img', { headers: { 'Cache-Control': 'public, max-age=300' } })),
  });
  await handle(navigation('/'));

  await handle(resource('/cover?path=a'));

  const urls = [...caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.keys()];
  assert.ok(!urls.some(url => url.includes('/cover')));
});

test('IAR-005: offline, unversioned assets come from the last copy seen', async () => {
  let online = true;
  const { handle } = setup({
    respond: request => {
      if (!online) return new TypeError('Failed to fetch');
      return new URL(request.url).pathname === '/' ? page('acct-a') : new Response('font', { headers: {} });
    },
  });
  await handle(navigation('/'));
  await handle(resource('/static/images/mark.svg'));
  online = false;

  const response = await handle(resource('/static/images/mark.svg'));

  assert.equal(await response.text(), 'font');
});

test('saving the view keeps the current page and reports whether a fresh copy exists', async () => {
  const { calls, worker, handle } = setup();

  assert.deepEqual(await worker.message({ type: 'status' }), { stored: false });
  assert.deepEqual(await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` }), { stored: true });
  await handle(navigation('/?artist=Broadcast'));
  assert.equal(calls.length, 2);
  assert.deepEqual(await worker.message({ type: 'forget' }), { stored: false });
  assert.deepEqual(await worker.message({ type: 'status' }), { stored: false });
});

test('saving another page also keeps Home, which a full restart opens', async () => {
  const { calls, worker, handle } = setup();

  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Mono` });
  await handle(navigation('/'));

  assert.deepEqual(calls.map(request => new URL(request.url).search), ['?artist=Broadcast', '', '?artist=Mono']);
});

test('saving ignores pages other than the app page and other origins', async () => {
  const { calls, worker } = setup();

  await worker.message({ type: 'save', url: `${ORIGIN}/account` });
  await worker.message({ type: 'save', url: 'https://example.org/' });

  assert.equal(calls.length, 0);
});

test('at most four pages are kept, Home among them', async () => {
  const { caches, worker, advance } = setup();
  for (const pagePath of ['/', '/?artist=A', '/?artist=B', '/?artist=C', '/?artist=D']) {
    await worker.message({ type: 'save', url: `${ORIGIN}${pagePath}` });
    advance(1000);
  }

  const pages = [...caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.keys()]
    .filter(url => !url.includes('__app-copy__'));
  assert.deepEqual(pages.sort(), [`${ORIGIN}/`, `${ORIGIN}/?artist=B`, `${ORIGIN}/?artist=C`, `${ORIGIN}/?artist=D`].sort());
});

test('an unreachable server with no copy fails the navigation as today', async () => {
  const { handle } = setup({ respond: () => new TypeError('Failed to fetch') });

  await assert.rejects(handle(navigation('/')), TypeError);
});

test('copies of a day ago show; the age check uses the time the copy was kept', async () => {
  const { calls, handle, advance } = setup();
  await handle(navigation('/'));
  advance(DAY_MS);

  await handle(navigation('/'));

  assert.equal(calls.length, 1);
});
