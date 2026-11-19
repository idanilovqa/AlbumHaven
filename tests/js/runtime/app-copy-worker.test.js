// The app-copy service worker: routing, per-account copies, age limit, deletion, asset versions and
// cover eviction (instant return, IAR-001..IAR-009).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { countedCollection, createInteractionCounter, measureScalePair } = require('../helpers/bounded-interaction-counter');

const {
  createAppCopyWorker, CACHE_PREFIX, COPY_HEADER, VERSION_HEADER, EXPIRES_HEADER, MAX_COPY_AGE_MS,
} = require(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'app-copy-worker.js'));

const ORIGIN = 'https://sandbox9.albumhaven.org';
const DAY_MS = 24 * 60 * 60 * 1000;

// With [counter], every request a cache lists counts as one visited item.
function fakeCaches(counter) {
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
        async keys() {
          const requests = [...entries.keys()].map(url => new Request(url));
          return counter ? countedCollection(requests, counter) : requests;
        },
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

// [mode] 'app' is the Android app (the copy answers at once); 'web' a browser (the server first).
function setup({ respond = () => page('acct-a'), maxCoverBytes, mode, caches = fakeCaches() } = {}) {
  const calls = [];
  const pending = [];
  let clock = 1_000_000;
  const fetch = async (request) => {
    calls.push(request);
    const response = await respond(request);
    if (response instanceof Error) throw response;
    return response;
  };
  const worker = createAppCopyWorker({
    caches, fetch, origin: ORIGIN, now: () => clock, maxCoverBytes, mode,
  });
  // Work the worker keeps doing after it answered (event.waitUntil).
  const event = { waitUntil: promise => pending.push(promise) };
  const settled = async () => { while (pending.length) await pending.shift(); };
  // Answers [request] and lets the worker finish what it does afterwards.
  const handle = async (request) => {
    const route = worker.route(request);
    const response = route ? await worker.handle(route, request, event) : null;
    await settled();
    return response;
  };
  return {
    caches, calls, worker, handle, settled, event, advance(ms) { clock += ms; },
  };
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

// The server names covers by opaque reference (`/cover/<reference>`); the copy keeps their bytes under
// that reference and size, whatever version a page asks for. Rendered as an attribute and as tojson.
const REFERENCE = 'AbCdEfGhIjKlMnOpQrStU-'; // 22 characters, ending in a non-word one
const OTHER_REFERENCE = 'Zyxwvutsrqponmlkjihgf0';
const COVER_URL = `/cover/${REFERENCE}?size=480&v=process-abc`;
const OTHER_COVER_URL = `/cover/${OTHER_REFERENCE}?size=480&v=process-abc`;
// Where the copy keeps a cover's bytes: under the server's reference and the size asked for.
const keptCoverUrl = (url) => {
  const parsed = new URL(url, ORIGIN);
  return `${ORIGIN}/__album-haven-cover/${parsed.pathname.split('/')[2]}/${parsed.searchParams.get('size') || 'original'}`;
};

function libraryPage(account = 'acct-a') {
  const json = JSON.stringify({
    initial_view: {
      music_dir: String.raw`C:\Music`,
      artist_groups: [{ albums: [
        { key: 'a', cover_ref: REFERENCE, cover_preview_url: COVER_URL },
        { key: 'b', cover_ref: OTHER_REFERENCE, cover_preview_url: OTHER_COVER_URL },
        { key: 'c', cover_ref: null, remote_cover_url: 'https://covers.example/c.jpg' },
      ] }],
    },
  }).replaceAll('&', '\\u0026');
  return new Response(
    `<!doctype html><html><head><meta name="album-haven-app-copy" content="network" data-account="${account}"></head><body>`
    + `<img src="${COVER_URL.replaceAll('&', '&amp;')}" data-cover-ref="${REFERENCE}" data-remote-cover-url="">`
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

const keptCoverKeys = caches => [...caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.keys()]
  .filter(url => new URL(url).pathname.startsWith('/__album-haven-cover/')).map(url => url.split('?')[0]);

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
  for (const leak of [String.raw`C:\Music\cover.jpg`, String.raw`\\nas\music\cover.jpg`, '/srv/music/x', '/cover?path=x', '"music_dir":"x"', 'data-cover-path="x"', '"cover_path": "x"']) {
    const caches = fakeCaches();
    await (await caches.open('probe')).put(`${ORIGIN}/probe`, new Response(`<p>${leak}</p>`, { headers: { 'Content-Type': 'text/html' } }));
    assert.equal((await storedPathLeaks(caches)).length > 0, true, leak);
  }
});

test('IAR-009: no file path is stored; cover URLs keep the server\'s reference', async () => {
  const { caches, handle, settled } = setup({ respond: libraryServer() });
  await handle(navigation('/'));
  await handle(resource(COVER_URL));
  await settled();

  assert.deepEqual(await storedPathLeaks(caches), []);
  const kept = await (await handle(navigation('/'))).text();
  assert.ok(kept.includes(`src="${COVER_URL.replaceAll('&', '&amp;')}"`), kept);
  assert.ok(kept.includes('"music_dir":""'));
  assert.ok(kept.includes('https://covers.example/c.jpg'));
  assert.deepEqual(keptCoverKeys(caches), [keptCoverUrl(COVER_URL)]);
});

test('a cover seen online shows offline under its reference, whatever version the page asks for', async () => {
  let online = true;
  const server = libraryServer({ coverBytes: 7 });
  const { handle, settled } = setup({ respond: request => (online ? server(request) : new TypeError('Failed to fetch')) });
  await handle(navigation('/'));
  await handle(resource(COVER_URL));
  await settled();
  online = false;

  const kept = await handle(resource(COVER_URL.replace('v=process-abc', 'v=process-new')));

  assert.equal(kept.status, 200);
  assert.equal((await kept.arrayBuffer()).byteLength, 7);
});

test('IAR-009: a page that still names a cover by file path is never kept', async () => {
  const legacy = () => new Response(
    '<!doctype html><html><head><meta name="album-haven-app-copy" content="network" data-account="acct-a"></head>'
    + '<body><img src="/cover?path=C%3A%5CMusic%5Ccover.jpg&amp;size=480"></body></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-cache', [COPY_HEADER]: 'acct-a', [VERSION_HEADER]: 'v1' } },
  );
  const { caches, handle } = setup({ respond: legacy });

  const response = await handle(navigation('/'));

  assert.equal(response.status, 200);
  assert.deepEqual(await storedPathLeaks(caches), []);
  assert.equal(caches.stores.get(`${CACHE_PREFIX}acct-a`), undefined);
});

test('legacy path cover URLs are left to the network and never stored', async () => {
  const { caches, worker, handle, settled } = setup({ respond: libraryServer() });
  await handle(navigation('/'));
  await settled();

  assert.equal(worker.route(resource('/cover?path=C%3A%5CMusic%5Ccover.jpg&size=480')), null);
  assert.deepEqual(await storedPathLeaks(caches), []);
});

test('saving the view fetches the covers of the kept page once, so they show offline', async () => {
  let online = true;
  const server = libraryServer({ coverBytes: 5 });
  const { calls, handle, worker } = setup({ respond: request => (online ? server(request) : new TypeError('Failed to fetch')) });

  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  online = false;

  assert.equal(calls.filter(request => new URL(request.url).pathname.startsWith('/cover/')).length, 2);
  for (const url of [COVER_URL, OTHER_COVER_URL]) {
    assert.equal((await handle(resource(url))).status, 200);
  }
});

test('offline, a cover never seen fails as it would without the copy; the page shows its placeholder', async () => {
  let online = true;
  const { handle, settled } = setup({ respond: request => (online ? libraryServer()(request) : new TypeError('Failed to fetch')) });
  await handle(navigation('/'));
  await settled();
  online = false;

  await assert.rejects(handle(resource(OTHER_COVER_URL)), TypeError);
});

test('covers still load from the server online, as today, and each size is kept apart', async () => {
  const { calls, handle, settled } = setup({
    respond: request => (new URL(request.url).pathname === '/'
      ? libraryPage()
      : coverResponse(new URL(request.url).searchParams.get('size') === '960' ? 12 : 9)),
  });
  await handle(navigation('/'));
  await handle(resource(COVER_URL.replace('size=480', 'size=960')));
  await handle(resource(COVER_URL));
  await handle(resource(COVER_URL));
  await settled();

  assert.equal(calls.filter(request => new URL(request.url).pathname.startsWith('/cover/')).length, 3);
});

test('the cover cache holds at most its byte budget, least recently seen first out', async () => {
  const { caches, handle, settled } = setup({ maxCoverBytes: 25, respond: libraryServer({ coverBytes: 10 }) });
  await handle(navigation('/'));
  const urls = ['A', 'B', 'C'].map(name => `/cover/${name.repeat(22)}?size=480&v=1`);
  for (const url of [urls[0], urls[1], urls[0], urls[2]]) {
    await handle(resource(url));
    await settled();
  }

  assert.deepEqual(keptCoverKeys(caches), [keptCoverUrl(urls[0]), keptCoverUrl(urls[2])]);
});

test('a restarted worker reads cover sizes from the stored keys and keeps to the budget', async () => {
  const caches = fakeCaches();
  const fetch = async request => libraryServer({ coverBytes: 10 })(request);
  const urls = ['A', 'B', 'C'].map(name => `/cover/${name.repeat(22)}?size=480&v=1`);
  const pending = [];
  const event = { waitUntil: promise => pending.push(promise) };
  const first = createAppCopyWorker({ caches, fetch, origin: ORIGIN, maxCoverBytes: 25 });
  await first.handle('page', navigation('/'), event);
  await Promise.all(pending);
  await first.handle('cover', resource(urls[0]), event);
  await first.handle('cover', resource(urls[1]), event);
  await Promise.all(pending);

  const restarted = createAppCopyWorker({ caches, fetch, origin: ORIGIN, maxCoverBytes: 25 });
  await restarted.handle('cover', resource(urls[2]), event);
  await Promise.all(pending);

  assert.deepEqual(keptCoverKeys(caches), [keptCoverUrl(urls[1]), keptCoverUrl(urls[2])]);
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

// ---- Robustness (both modes) ----

test('the network page is answered before the copy is written', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const caches = fakeCaches();
  const open = caches.open.bind(caches);
  caches.open = async (name) => { await blocked; return open(name); };
  const { worker, event, settled } = setup({ caches });

  const response = await worker.handle('page', navigation('/'), event);

  assert.match(await response.text(), /content="network"/);
  release();
  await settled();
  assert.deepEqual(accountCaches(caches), [`${CACHE_PREFIX}acct-a`]);
});

test('IAR-W03: a save that finishes after signing out does not bring the copy back', async () => {
  let answer;
  const { caches, worker, settled } = setup({
    respond: () => new Promise((resolve) => { answer = resolve; }),
  });
  const saving = worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  await new Promise(resolve => setImmediate(resolve));

  await worker.handle('forget', resource('/logout', 'POST'));
  answer(page('acct-a'));
  await saving;
  await settled();

  assert.deepEqual(accountCaches(caches), []);
});

test('saves from several tabs at once keep every page', async () => {
  const { caches, worker } = setup();

  await Promise.all(['/', '/?artist=A', '/?artist=B'].map(pagePath => worker.message({ type: 'save', url: `${ORIGIN}${pagePath}` })));

  const meta = await (await caches.stores.get(`${CACHE_PREFIX}acct-a`).match(`${ORIGIN}/__app-copy__/meta`)).json();
  assert.deepEqual(Object.keys(meta.pages).sort(), ['/', '/?artist=A', '/?artist=B']);
});

test('IAR-W08: full storage never breaks the page; the copy is simply not kept', async () => {
  const caches = fakeCaches();
  const open = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await open(name);
    cache.put = async () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
    return cache;
  };
  const immutable = () => new Response('js', { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
  const { handle } = setup({ caches, respond: request => (new URL(request.url).pathname === '/' ? page('acct-a') : immutable()) });

  const response = await handle(navigation('/'));
  const asset = await handle(resource('/static/app.js?v=v1'));

  assert.equal(response.status, 200);
  assert.equal(await asset.text(), 'js');
});

test('IAR-W06: a copy is not shown past the end of the session the server named', async () => {
  const { calls, handle, advance } = setup({
    respond: () => {
      const response = page('acct-a');
      response.headers.set(EXPIRES_HEADER, String(1_000_000 + DAY_MS));
      return response;
    },
  });
  await handle(navigation('/'));
  advance(DAY_MS - 1);
  await handle(navigation('/'));
  assert.equal(calls.length, 1);

  advance(2);
  await handle(navigation('/'));
  assert.equal(calls.length, 2);
});

test('copies kept by the earlier cover-path version are deleted, never shown', async () => {
  const caches = fakeCaches();
  await (await caches.open('album-haven-app-copy-v1:acct-a')).put(`${ORIGIN}/`, new Response('old'));
  const { worker } = setup({ caches });

  await worker.activate();

  assert.deepEqual(await caches.keys(), []);
});

test('in Chrome, requests the copy never answers skip the worker', async () => {
  const added = [];
  const { worker } = setup();

  await worker.install({ addRoutes: async (rules) => { added.push(rules); } });
  await worker.install({});
  await worker.install({ addRoutes: async () => { throw new TypeError('not supported'); } });

  assert.equal(added.length, 1);
  assert.equal(added[0].source, 'network');
  const own = added[0].condition.not.or.map(rule => rule.urlPattern.pathname);
  for (const pathname of ['/', '/static/*', '/cover/*', '/login*', '/logout']) assert.ok(own.includes(pathname), pathname);
});

// ---- Browsers: the server first, the copy when it does not answer (IAR-W01, IAR-W05) ----

test('IAR-W01: in a browser the server answers when it is quick, and its page refreshes the copy', async () => {
  let body = 'First';
  const { calls, handle } = setup({ mode: 'web', respond: () => page('acct-a', { body }) });
  await handle(navigation('/'));
  body = 'Second';

  const response = await handle(navigation('/'));

  assert.equal(calls.length, 2);
  const text = await response.text();
  assert.match(text, /content="network"/);
  assert.match(text, /Second/);
});

test('IAR-W05: in a browser the copy answers when the server cannot be reached', async () => {
  let online = true;
  const { handle } = setup({ mode: 'web', respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  await handle(navigation('/'));
  online = false;

  const response = await handle(navigation('/'));

  assert.match(await response.text(), /content="cache"/);
});

test('IAR-W05: in a browser a gateway error (the tunnel without its server) also shows the copy', async () => {
  let up = true;
  const { handle } = setup({ mode: 'web', respond: () => (up ? page('acct-a') : new Response('Bad gateway', { status: 502 })) });
  await handle(navigation('/'));
  up = false;

  const response = await handle(navigation('/'));

  assert.match(await response.text(), /content="cache"/);
});

// Owner's D2 retest: the Cloudflare tunnel dropped every site for a few minutes, answering 530.
test('IAR-W12: a gateway error (530) on a cover or image shows the one kept, as offline does', async () => {
  let up = true;
  const server = libraryServer({ coverBytes: 7 });
  const { handle, settled } = setup({
    mode: 'web',
    respond: (request) => {
      if (!up) return new Response('Origin unreachable', { status: 530 });
      return new URL(request.url).pathname === '/static/images/mark.svg' ? new Response('mark', { headers: {} }) : server(request);
    },
  });
  await handle(navigation('/'));
  await handle(resource(COVER_URL));
  await handle(resource('/static/images/mark.svg'));
  await settled();
  up = false;

  const cover = await handle(resource(COVER_URL));
  const image = await handle(resource('/static/images/mark.svg'));
  const unseen = await handle(resource(OTHER_COVER_URL));

  assert.equal(cover.status, 200);
  assert.equal((await cover.arrayBuffer()).byteLength, 7);
  assert.equal(await image.text(), 'mark');
  // Nothing kept: the server's own answer, as without the copy.
  assert.equal(unseen.status, 530);
});

// Owner report: a slow network flashed the Offline notice. Online, a slow server is waited for.
test('IAR-W11: in a browser a slow server is waited for; its copy never stands in while it can still answer', async () => {
  let answer = null;
  const { worker, event, handle } = setup({
    mode: 'web',
    respond: () => (answer ? new Promise((resolve) => { answer = resolve; }) : page('acct-a', { body: 'Old' })),
  });
  await handle(navigation('/'));
  answer = true;

  let response = null;
  const responding = worker.handle('page', navigation('/'), event).then((result) => { response = result; });
  // Longer than the 1.5 s the copy used to wait for.
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(response, null);

  answer(page('acct-a', { body: 'New' }));
  await responding;
  assert.match(await response.text(), /content="network"[\s\S]*New/);
});

test('IAR-W02: in a browser a signed-out answer shows the sign-in page and deletes the copy', async () => {
  let signedIn = true;
  const { caches, handle } = setup({
    mode: 'web',
    respond: () => (signedIn ? page('acct-a') : Response.redirect(`${ORIGIN}/login`, 303)),
  });
  await handle(navigation('/'));
  signedIn = false;

  const response = await handle(navigation('/'));

  assert.equal(response.status, 303);
  assert.deepEqual(accountCaches(caches), []);
});

test('in a browser without a copy, a page that cannot load fails as today', async () => {
  const { handle } = setup({ mode: 'web', respond: () => new TypeError('Failed to fetch') });

  await assert.rejects(handle(navigation('/')), TypeError);
});

// ---- Owner D2 retest: the copy opens offline after a first visit and across server builds ----

const immutable = body => new Response(body, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
const pageWithAssets = version => page('acct-a', {
  version,
  body: `<link rel="stylesheet" href="${ORIGIN}/static/css/base.css?v=${version}"><script src="/static/app.js?v=${version}" defer></script>`,
});

test('IAR-W09: saving keeps the versioned assets the kept page loads, also for a build no page has run yet', async () => {
  let online = true;
  let version = 'v1';
  const { calls, handle, worker } = setup({
    mode: 'web',
    respond: (request) => {
      if (!online) return new TypeError('Failed to fetch');
      return new URL(request.url).pathname === '/' ? pageWithAssets(version) : immutable(request.url);
    },
  });
  // The first visit was not loaded through the worker, so only the save keeps anything.
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  // The server is rebuilt; the next save keeps the new build's page and its assets.
  version = 'v2';
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  online = false;

  const offline = await handle(navigation('/'));
  assert.match(await offline.text(), /content="cache"[\s\S]*app\.js\?v=v2/);
  for (const asset of ['/static/app.js?v=v2', '/static/css/base.css?v=v2']) {
    assert.equal(await (await handle(resource(asset))).text(), `${ORIGIN}${asset}`);
  }
  // Each asset was fetched once, though the page was saved twice.
  assert.equal(calls.filter(request => new URL(request.url).pathname === '/static/app.js').length, 2);
});

test('IAR-W09: assets the server did not mark immutable for this build are not kept by a save', async () => {
  const { caches, worker } = setup({
    mode: 'web',
    respond: request => (new URL(request.url).pathname === '/' ? pageWithAssets('v1') : new Response('stale', { headers: { 'Cache-Control': 'no-store' } })),
  });

  await worker.message({ type: 'save', url: `${ORIGIN}/` });

  const kept = [...caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.keys()].filter(url => url.includes('/static/'));
  assert.deepEqual(kept, []);
});

test('IAR-W10: in a browser, offline, an address never kept opens the last view kept', async () => {
  let online = true;
  const { handle, worker } = setup({ mode: 'web', respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  online = false;

  const response = await handle(navigation('/?artist=Mono'));

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), `${ORIGIN}/?artist=Broadcast`);
  assert.match(await (await handle(navigation('/?artist=Broadcast'))).text(), /content="cache"/);
});

test('IAR-W10: the last view is the page last kept by a navigation or save, not Home kept beside it', async () => {
  let online = true;
  const { handle, worker, advance } = setup({ mode: 'web', respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  await handle(navigation('/?artist=Broadcast'));
  advance(1000);
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Mono` });
  online = false;

  const response = await handle(navigation('/?artist=Unseen'));

  assert.equal(response.headers.get('Location'), `${ORIGIN}/?artist=Mono`);
});

test('IAR-W10: a last view past its age is not opened; the navigation fails as today', async () => {
  let online = true;
  const { handle, worker, advance } = setup({ mode: 'web', respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  advance(MAX_COPY_AGE_MS + 1);
  online = false;

  await assert.rejects(handle(navigation('/?artist=Mono')), TypeError);
});

test('the Android app still opens only the copy of the page asked for', async () => {
  let online = true;
  const { handle, worker } = setup({ respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  online = false;

  await assert.rejects(handle(navigation('/?artist=Mono')), TypeError);
});

test('IAR-W10: a last view whose page is gone from storage is not opened, so navigations never loop', async () => {
  let online = true;
  const { caches, handle, worker } = setup({ mode: 'web', respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  const cache = caches.stores.get(`${CACHE_PREFIX}acct-a`);
  cache.entries.delete(`${ORIGIN}/?artist=Broadcast`);
  cache.entries.delete(`${ORIGIN}/`);
  online = false;

  await assert.rejects(handle(navigation('/?artist=Mono')), TypeError);
});

test('IAR-W09: going offline while a save is still keeping assets never holds up the offline page', async () => {
  // Like the browser's Cache Storage, this store reads a response's body before keeping it.
  const caches = fakeCaches();
  const open = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await open(name);
    if (!cache.readsBodies) {
      const put = cache.put.bind(cache);
      cache.put = async (request, response) => put(request, new Response(await response.arrayBuffer(), { headers: response.headers }));
      cache.readsBodies = true;
    }
    return cache;
  };
  let online = true;
  const { worker, handle } = setup({
    mode: 'web',
    caches,
    respond: (request) => {
      if (!online) return new TypeError('Failed to fetch');
      if (new URL(request.url).pathname === '/') return pageWithAssets('v1');
      // The connection goes while this asset's body is still arriving.
      return new Response(new ReadableStream({ start() {} }), { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
    },
  });
  void worker.message({ type: 'save', url: `${ORIGIN}/` });
  for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setImmediate(resolve));
  online = false;

  const response = await Promise.race([
    handle(navigation('/')),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('the offline page waited for the save')), 500); }),
  ]);

  assert.match(await response.text(), /content="cache"/);
});

test('after a save of a new server build, an asset download cut off by going offline never holds up the offline page', async () => {
  const caches = fakeCaches();
  const open = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await open(name);
    if (!cache.readsBodies) {
      const put = cache.put.bind(cache);
      cache.put = async (request, response) => put(request, new Response(await response.arrayBuffer(), { headers: response.headers }));
      cache.readsBodies = true;
    }
    return cache;
  };
  let online = true;
  let version = 'v1';
  const { worker, event, handle } = setup({
    mode: 'web',
    caches,
    respond: (request) => {
      if (!online) return new TypeError('Failed to fetch');
      if (new URL(request.url).pathname === '/') return page('acct-a', { version });
      return new Response(new ReadableStream({ start() {} }), { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
    },
  });
  await handle(navigation('/'));
  // The server is rebuilt and the tab is hidden: the copy now holds v2 while v1 still runs.
  version = 'v2';
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  void worker.handle('versioned-asset', resource('/static/app.js?v=v1'), event);
  for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setImmediate(resolve));
  online = false;

  const response = await Promise.race([
    worker.handle('page', navigation('/'), event),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('the offline page waited for the download')), 500); }),
  ]);

  assert.match(await response.text(), /content="cache"/);
});

// Request-capture contracts (tests/ci/bounded-interactions.json): the real worker routes every
// kind of browser request; only its owned endpoints may reach the network, each at most once.
const { assertInteractionRequests, createRequestCapture, measureInteractionContract } = require('../helpers/request-capture');

const UNOWNED_REQUESTS = [
  navigation('/account'), navigation('/admin/members'), resource('/view-data?surface=albums'), resource('/home-data'),
  resource('/status'), resource('/utilities/edit-tags', 'POST'), { url: `https://example.org/cover/${'x'.repeat(22)}`, method: 'GET', mode: 'no-cors' },
];

// A cover reference: 22 URL-safe characters, as the server names covers.
const coverReference = name => String(name).padStart(22, 'R');

function coveredPage(covers, scripts = []) {
  const images = Array.from({ length: covers }, (_, index) => (
    `<img src="/cover/${coverReference(index)}?size=480&amp;v=process-abc">`
  )).join('');
  return page('acct-a', { body: images + scripts.map(src => `<script src="${src}"></script>`).join('') });
}

// [scripts]: versioned assets the app page loads.
function capturedWorker(covers, { scripts } = {}) {
  const capture = createRequestCapture(async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/') return coveredPage(covers, scripts);
    if (pathname.startsWith('/cover/')) return coverResponse(4);
    return new Response('asset', { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } });
  });
  const worker = createAppCopyWorker({ caches: fakeCaches(), fetch: capture.fetch, origin: ORIGIN, now: () => 1_000_000 });
  // Like setup(): answers [request], then lets the worker finish keeping what it answered.
  const pending = [];
  const event = { waitUntil: promise => pending.push(promise) };
  const handle = async (request) => {
    const route = worker.route(request);
    const response = route ? await worker.handle(route, request, event) : null;
    while (pending.length) await pending.shift();
    return response;
  };
  const paths = () => capture.urls().map((url) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, ORIGIN);
    return `${parsed.pathname}${parsed.search}`;
  });
  return { capture, worker, handle, paths };
}

async function measureCaptured(captured, action) {
  const before = captured.capture.requests.length;
  const metrics = await captured.capture.counter.measure(action);
  return { metrics, paths: captured.paths().slice(before) };
}

test('request capture: app page navigations fetch only the app page, once per missing copy', async () => {
  await measureInteractionContract('js:app-copy-worker.js#fetchPage', async (covers) => {
    const captured = capturedWorker(covers);
    const { metrics, paths } = await measureCaptured(captured, async () => {
      await captured.handle(navigation('/'));
      await captured.handle(navigation('/'));
      for (const request of UNOWNED_REQUESTS) await captured.handle(request);
    });
    assert.deepEqual(paths, ['/']);
    assertInteractionRequests('js:app-copy-worker.js#fetchPage', paths);
    return metrics;
  });
});

test('request capture: a versioned asset is fetched once and then served from the copy', async () => {
  await measureInteractionContract('js:app-copy-worker.js#versionedAsset', async (keptAssets) => {
    const captured = capturedWorker(1);
    await captured.handle(navigation('/'));
    for (let index = 0; index < keptAssets; index += 1) {
      await captured.handle(resource(`/static/js/runtime/kept-${index}.js?v=v1`));
    }
    const { metrics, paths } = await measureCaptured(captured, async () => {
      await captured.handle(resource('/static/js/runtime/app.js?v=v1'));
      await captured.handle(resource('/static/js/runtime/app.js?v=v1'));
      await captured.handle(resource('/static/js/runtime/kept-0.js?v=v1'));
      for (const request of UNOWNED_REQUESTS) await captured.handle(request);
    });
    assert.deepEqual(paths, ['/static/js/runtime/app.js?v=v1']);
    assertInteractionRequests('js:app-copy-worker.js#versionedAsset', paths);
    return metrics;
  });
});

test('request capture: an unversioned asset request reaches only that asset', async () => {
  await measureInteractionContract('js:app-copy-worker.js#asset', async (keptAssets) => {
    const captured = capturedWorker(1);
    await captured.handle(navigation('/'));
    for (let index = 0; index < keptAssets; index += 1) await captured.handle(resource(`/static/images/kept-${index}.svg`));
    const { metrics, paths } = await measureCaptured(captured, async () => {
      await captured.handle(resource('/static/fonts/inter.woff2'));
      for (const request of UNOWNED_REQUESTS) await captured.handle(request);
    });
    assert.deepEqual(paths, ['/static/fonts/inter.woff2']);
    assertInteractionRequests('js:app-copy-worker.js#asset', paths);
    return metrics;
  });
});

test('request capture: a cover request reaches only that cover, whatever the kept covers', async () => {
  await measureInteractionContract('js:app-copy-worker.js#cover', async (keptCovers) => {
    const captured = capturedWorker(1);
    await captured.handle(navigation('/'));
    for (let index = 0; index < keptCovers; index += 1) {
      await captured.handle(resource(`/cover/${coverReference(`kept${index}`)}?size=480`));
    }
    const cover = `/cover/${coverReference('next')}?size=480&v=process-abc`;
    const { metrics, paths } = await measureCaptured(captured, async () => {
      await captured.handle(resource(cover));
      for (const request of UNOWNED_REQUESTS) await captured.handle(request);
    });
    assert.deepEqual(paths, [cover]);
    assertInteractionRequests('js:app-copy-worker.js#cover', paths);
    return metrics;
  });
});

test('request capture: saving the view fetches its page once and at most one batch of unseen covers', async () => {
  await measureInteractionContract('js:app-copy-worker.js#fillCovers', async (covers) => {
    const captured = capturedWorker(covers);
    const { metrics, paths } = await measureCaptured(captured, () => captured.worker.message({ type: 'save', url: `${ORIGIN}/` }));
    const [pagePath, ...coverPaths] = paths;
    assert.equal(pagePath, '/');
    assert.equal(coverPaths.length, Math.min(covers, 120));
    assert.equal(new Set(coverPaths).size, coverPaths.length, 'each unseen cover is fetched once');
    assertInteractionRequests('js:app-copy-worker.js#fetchPage', [pagePath]);
    assertInteractionRequests('js:app-copy-worker.js#fillCovers', coverPaths);
    // The next save continues with the next batch; a kept cover is never fetched again.
    const repeat = await measureCaptured(captured, () => captured.worker.message({ type: 'save', url: `${ORIGIN}/` }));
    assert.equal(repeat.paths[0], '/');
    assert.equal(repeat.paths.length - 1, Math.min(Math.max(covers - 120, 0), 120));
    assert.equal(repeat.paths.slice(1).some(path => coverPaths.includes(path)), false);
    return metrics;
  });
});

test('request capture: saving the view fetches only the versioned assets its page loads that are not kept', async () => {
  await measureInteractionContract('js:app-copy-worker.js#fillAssets', async (keptAssets) => {
    const scripts = ['/static/js/runtime/kept-0.js?v=v1', '/static/js/runtime/app.js?v=v1', '/static/css/app.css?v=v1'];
    const captured = capturedWorker(0, { scripts });
    await captured.handle(navigation('/'));
    for (let index = 0; index < keptAssets; index += 1) {
      await captured.handle(resource(`/static/js/runtime/kept-${index}.js?v=v1`));
    }
    const { metrics, paths } = await measureCaptured(captured, () => captured.worker.message({ type: 'save', url: `${ORIGIN}/` }));
    const [pagePath, ...assetPaths] = paths;
    assert.equal(pagePath, '/');
    assert.deepEqual(assetPaths, ['/static/js/runtime/app.js?v=v1', '/static/css/app.css?v=v1']);
    assertInteractionRequests('js:app-copy-worker.js#fillAssets', assetPaths);
    // Once kept, the next save fetches only its page.
    const repeat = await measureCaptured(captured, () => captured.worker.message({ type: 'save', url: `${ORIGIN}/` }));
    assert.deepEqual(repeat.paths, ['/']);
    return metrics;
  });
});

// The installed worker as the Android shell runs it: the file's own listeners on a service-worker scope.
function installedWorker({ caches, fetch }) {
  const listeners = new Map();
  const scope = {
    registration: {}, caches, fetch, location: { origin: ORIGIN, href: `${ORIGIN}/app-copy-worker.js` },
    clients: { claim: async () => {} }, skipWaiting: async () => {},
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  const file = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'app-copy-worker.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { self: scope, URL, Request, Response, TextEncoder }, { filename: file });
  return {
    async post(data) {
      const replies = [];
      let work;
      listeners.get('message')({ data, ports: [{ postMessage: reply => replies.push({ ...reply }) }], waitUntil: (promise) => { work = promise; } });
      await work;
      return replies;
    },
  };
}

test('bounded interaction: a save message reads no kept cover or asset when 5,000 covers are kept', async () => {
  await measureScalePair({
    id: 'js:app-copy-worker.js#<top-level>',
    small: 5,
    large: 5000,
    budgets: { itemsVisited: 0, requests: 2, outputEmissions: 1 },
    growth: { metric: 'itemsVisited', largeMinusSmallMax: 0 },
    async run(keptCovers) {
      const counter = createInteractionCounter();
      const caches = fakeCaches(counter);
      // Covers kept by an earlier session, which the started worker reads once.
      const kept = await caches.open(`${CACHE_PREFIX}acct-a`);
      for (let index = 0; index < keptCovers; index += 1) {
        await kept.put(`${ORIGIN}/__album-haven-cover/kept-${index}?bytes=4`, coverResponse(4));
      }
      let pageCovers = 0;
      const worker = installedWorker({
        caches,
        fetch: async (request) => {
          counter.count('requests');
          return new URL(request.url).pathname === '/' ? coveredPage(pageCovers) : coverResponse(4);
        },
      });
      pageCovers = 3;
      assert.deepEqual(await worker.post({ type: 'save', url: `${ORIGIN}/` }), [{ stored: true }]);
      // The next save names one cover more: the page and that one cover are fetched, nothing is listed.
      pageCovers = 4;
      const work = await counter.measure(async () => {
        const replies = await worker.post({ type: 'save', url: `${ORIGIN}/` });
        replies.forEach(() => counter.count('outputEmissions'));
        assert.deepEqual(replies, [{ stored: true }]);
      });
      assert.equal([...kept.entries.keys()].filter(url => url.includes('/__album-haven-cover/')).length, keptCovers + 4);
      return work;
    },
  });
});
