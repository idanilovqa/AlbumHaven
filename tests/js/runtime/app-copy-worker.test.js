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
        async match(request, options = {}) {
          const key = keyOf(request);
          if (!options.ignoreSearch) return entries.get(key)?.clone();
          const base = key.split('?')[0];
          for (const [url, response] of entries) if (url.split('?')[0] === base) return response.clone();
          return undefined;
        },
        async put(request, response) {
          const key = keyOf(request);
          entries.delete(key);
          entries.set(key, response);
        },
        async delete(request, options = {}) {
          const key = keyOf(request);
          if (!options.ignoreSearch) return entries.delete(key);
          const matches = [...entries.keys()].filter(url => url.split('?')[0] === key.split('?')[0]);
          matches.forEach(url => entries.delete(url));
          return matches.length > 0;
        },
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

function setup({ respond = () => page('acct-a'), maxCoverBytes } = {}) {
  const caches = fakeCaches();
  const calls = [];
  let clock = 1_000_000;
  const fetch = async (request) => {
    calls.push(request);
    const response = await respond(request);
    if (response instanceof Error) throw response;
    return response;
  };
  const worker = createAppCopyWorker({ caches, fetch, origin: ORIGIN, now: () => clock, maxCoverBytes });
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

// The server addresses local covers by their file path. Rendered as an attribute and as tojson.
const COVER_PATH = String.raw`C:\Music\Broadcast\Tender Buttons\cover.jpg`;
const COVER_URL = `/cover?path=${encodeURIComponent(COVER_PATH)}&size=480&v=process-abc`;
const OTHER_COVER_URL = `/cover?path=${encodeURIComponent('/srv/music/Mono/cover.png')}&size=480&v=process-abc`;
const coverKey = async (url) => {
  const parsed = new URL(url, ORIGIN);
  const source = parsed.searchParams.get('path') ?? `${parsed.pathname}${parsed.search}`;
  return `/__album-haven-cover/${Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))).toString('hex')}`;
};

function libraryPage(account = 'acct-a') {
  const attribute = COVER_URL.replaceAll('&', '&amp;');
  const json = JSON.stringify({
    initial_view: {
      music_dir: String.raw`C:\Music`,
      artist_groups: [{ albums: [
        { key: 'a', cover_path: COVER_PATH, cover_preview_url: COVER_URL },
        { key: 'b', cover_path: '/srv/music/Mono/cover.png', cover_preview_url: OTHER_COVER_URL },
        { key: 'c', cover_path: null, remote_cover_url: 'https://covers.example/c.jpg' },
      ] }],
    },
  }).replaceAll('&', '\\u0026');
  return new Response(
    `<!doctype html><html><head><meta name="album-haven-app-copy" content="network" data-account="${account}"></head><body>`
    + `<img src="${attribute}" data-cover-path="${COVER_PATH}" data-remote-cover-url="">`
    + `<script>window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = ${json};</script></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-cache', [COPY_HEADER]: account, [VERSION_HEADER]: 'v1' } },
  );
}

const coverResponse = (bytes = 10, cacheControl = 'public, max-age=31536000') => new Response(new Uint8Array(bytes), {
  headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': cacheControl },
});

function libraryServer({ coverBytes = 10, coverCacheControl } = {}) {
  return request => (new URL(request.url).pathname === '/' ? libraryPage() : coverResponse(coverBytes, coverCacheControl));
}

// Every stored URL and text body: no drive letter, UNC or POSIX library path, cover path URL or music_dir value.
async function storedPathLeaks(caches) {
  const leaks = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const type = response.headers.get('Content-Type') || '';
      const texts = [decodeURIComponent(request.url), ...(type.startsWith('image/') ? [] : [await response.text()])];
      for (const text of texts) {
        for (const pattern of [/(?<![A-Za-z])[A-Za-z]:[\\/]/,/\\\\[^\\"]+\\/, /\/srv\/music/, /\/cover\?path=/, /"music_dir":\s*"[^"]/, /data-cover-path="[^"]/, /"cover_path":\s*"[^"]/]) {
          if (pattern.test(text)) leaks.push(`${request.url}: ${pattern}`);
        }
      }
    }
  }
  return leaks;
}

test('the path scanner catches every stored form of a library path', async () => {
  for (const leak of [COVER_PATH, String.raw`\\nas\music\cover.jpg`, '/srv/music/x', COVER_URL, '"music_dir":"x"', 'data-cover-path="x"', '"cover_path": "x"']) {
    const caches = fakeCaches();
    await (await caches.open('probe')).put(`${ORIGIN}/probe`, new Response(`<p>${leak}</p>`, { headers: { 'Content-Type': 'text/html' } }));
    assert.equal((await storedPathLeaks(caches)).length > 0, true, leak);
  }
});

test('IAR-009: no file path is stored anywhere: covers get opaque on-device keys', async () => {
  const { caches, handle } = setup({ respond: libraryServer() });
  await handle(navigation('/'));
  await handle(resource(COVER_URL));

  assert.deepEqual(await storedPathLeaks(caches), []);
  const kept = await (await handle(navigation('/'))).text();
  assert.ok(kept.includes(`src="${await coverKey(COVER_URL)}"`), kept);
  assert.ok(kept.includes(`"cover_preview_url":"${await coverKey(OTHER_COVER_URL)}"`), kept);
  assert.ok(kept.includes('"cover_path":""') && kept.includes('data-cover-path=""') && kept.includes('"music_dir":""'));
  assert.ok(kept.includes('https://covers.example/c.jpg'));
});

test('a cover seen online shows from its opaque key in the copy, offline too', async () => {
  let online = true;
  const server = libraryServer({ coverBytes: 7 });
  const { handle } = setup({ respond: request => (online ? server(request) : new TypeError('Failed to fetch')) });
  await handle(navigation('/'));
  await handle(resource(COVER_URL));
  online = false;

  const kept = await handle(resource(await coverKey(COVER_URL)));

  assert.equal(kept.status, 200);
  assert.equal((await kept.arrayBuffer()).byteLength, 7);
});

test('saving the view fetches the covers of the kept page once, so they show offline', async () => {
  let online = true;
  const server = libraryServer({ coverBytes: 5 });
  const { caches, calls, handle, worker } = setup({ respond: request => (online ? server(request) : new TypeError('Failed to fetch')) });

  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  online = false;

  assert.equal(calls.filter(request => request.url.includes('/cover?')).length, 2);
  for (const url of [COVER_URL, OTHER_COVER_URL]) {
    assert.equal((await handle(resource(await coverKey(url)))).status, 200);
  }
  assert.deepEqual(await storedPathLeaks(caches), []);
});

test('a cover never seen has no bytes under its key; the page shows its placeholder', async () => {
  const { calls, handle } = setup({ respond: libraryServer() });
  await handle(navigation('/'));

  const missing = await handle(resource(await coverKey(OTHER_COVER_URL)));

  assert.equal(missing.status, 404);
  assert.equal(calls.length, 1);
});

test('covers still load from the server online, as today, and any size of a cover fills its key', async () => {
  const { calls, handle } = setup({ respond: libraryServer({ coverBytes: 9 }) });
  await handle(navigation('/'));
  await handle(resource(COVER_URL.replace('size=480', 'size=960')));
  await handle(resource(COVER_URL));

  assert.equal(calls.filter(request => request.url.includes('/cover?')).length, 2);
  const kept = await handle(resource(await coverKey(COVER_URL)));
  assert.equal((await kept.arrayBuffer()).byteLength, 9);
});

test('the cover cache holds at most its byte budget, least recently seen first out', async () => {
  const { caches, handle } = setup({ maxCoverBytes: 25, respond: libraryServer({ coverBytes: 10 }) });
  await handle(navigation('/'));
  const urls = ['a', 'b', 'c'].map(name => `/cover?path=${name}&size=480&v=1`);
  await handle(resource(urls[0]));
  await handle(resource(urls[1]));
  await handle(resource(urls[0]));
  await handle(resource(urls[2]));

  const keys = [...caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.keys()].filter(url => url.includes('/__album-haven-cover/')).map(url => url.split('?')[0]);
  assert.deepEqual(keys, [`${ORIGIN}${await coverKey(urls[0])}`, `${ORIGIN}${await coverKey(urls[2])}`]);
});

test('a restarted worker reads cover sizes from the stored keys and keeps to the budget', async () => {
  const caches = fakeCaches();
  const fetch = async request => libraryServer({ coverBytes: 10 })(request);
  const urls = ['a', 'b', 'c'].map(name => `/cover?path=${name}&size=480&v=1`);
  const first = createAppCopyWorker({ caches, fetch, origin: ORIGIN, maxCoverBytes: 25 });
  await first.handle('page', navigation('/'));
  await first.handle('cover', resource(urls[0]));
  await first.handle('cover', resource(urls[1]));

  const restarted = createAppCopyWorker({ caches, fetch, origin: ORIGIN, maxCoverBytes: 25 });
  await restarted.handle('cover', resource(urls[2]));

  const keys = [...caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.keys()]
    .filter(url => url.includes('/__album-haven-cover/')).map(url => url.split('?')[0]);
  assert.deepEqual(keys, [`${ORIGIN}${await coverKey(urls[1])}`, `${ORIGIN}${await coverKey(urls[2])}`]);
});

test('covers the server marks no-store are not kept', async () => {
  const { caches, handle } = setup({ respond: libraryServer({ coverCacheControl: 'no-store, max-age=0' }) });
  await handle(navigation('/'));

  await handle(resource(COVER_URL));

  const urls = [...caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.keys()];
  assert.ok(!urls.some(url => url.includes('cover')));
});

test('IAR-006: covers go with the copy on sign-out', async () => {
  const { caches, handle, worker } = setup({ respond: libraryServer() });
  await handle(navigation('/'));
  await handle(resource(COVER_URL));

  await worker.handle('forget', resource('/logout', 'POST'));

  assert.deepEqual(await caches.keys(), []);
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
