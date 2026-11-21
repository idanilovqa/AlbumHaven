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
function setup({
  respond = () => page('acct-a'), maxCoverBytes, mode, caches = fakeCaches(), noAnswerMs, dataLimits, dataCheckMs,
} = {}) {
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
    caches, fetch, origin: ORIGIN, now: () => clock, maxCoverBytes, mode, noAnswerMs, dataLimits, dataCheckMs,
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
    resource('/status'), resource('/app-copy/account'), resource('/utilities/edit-tags', 'POST'),
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

test('in Chrome, only busy paths the copy never keeps skip the worker, so a later version can keep new paths in open tabs', async () => {
  const added = [];
  const { worker } = setup();

  await worker.install({ addRoutes: async (rules) => { added.push(rules); } });
  await worker.install({});
  await worker.install({ addRoutes: async () => { throw new TypeError('not supported'); } });

  assert.equal(added.length, 1);
  assert.equal(added[0].source, 'network');
  assert.equal(added[0].condition.not, undefined, 'never "everything but what this version keeps"');
  const network = added[0].condition.or.map(rule => rule.urlPattern.pathname);
  assert.deepEqual(network, ['/track', '/playback/*', '/health', '/status', '/downloads/*']);
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

// Owner D4: every tree entry and Home reload landed on the one kept view (3 Crows), silently.
test('IAR-W10: in a browser, offline, an address never kept is answered at that address by kept Home marked as standing in', async () => {
  let online = true;
  const { handle, worker } = setup({ mode: 'web', respond: () => (online ? page('acct-a', { body: 'Home' }) : new TypeError('Failed to fetch')) });
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  online = false;

  const response = await handle(navigation('/?artist=Mono'));

  assert.equal(response.status, 200);
  assert.equal(response.redirected, false);
  assert.match(await response.text(), /content="cache" data-view-missing="1" data-account="acct-a"/);
});

test('IAR-W10: on a gateway error (530) an address never kept is answered the same way', async () => {
  let up = true;
  const { handle, worker } = setup({ mode: 'web', respond: () => (up ? page('acct-a') : new Response('origin down', { status: 530 })) });
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  up = false;

  assert.match(await (await handle(navigation('/?artist=Mono'))).text(), /data-view-missing="1"/);
});

test('IAR-W10: without Home kept, the last view kept stands in; a kept address itself is never marked', async () => {
  let online = true;
  const { caches, handle, worker } = setup({ mode: 'web', respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  await worker.message({ type: 'save', url: `${ORIGIN}/?artist=Broadcast` });
  caches.stores.get(`${CACHE_PREFIX}acct-a`).entries.delete(`${ORIGIN}/`);
  online = false;

  assert.match(await (await handle(navigation('/?artist=Mono'))).text(), /data-view-missing="1"/);
  assert.doesNotMatch(await (await handle(navigation('/?artist=Broadcast'))).text(), /data-view-missing/);
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

test('IAR-W10: with no kept page left in storage, nothing stands in and the navigation fails as today', async () => {
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

// Owner D2 round 7: signed in, then the connection lost at once; the page had arrived but was
// still being written to the copy when a new tab asked for it.
test('IAR-W12: a page still being kept when the connection drops is there for a new tab', async () => {
  const caches = fakeCaches();
  let release;
  const writes = new Promise((resolve) => { release = resolve; });
  const open = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await open(name);
    if (!cache.slow) {
      const put = cache.put.bind(cache);
      cache.put = async (...args) => { await writes; return put(...args); };
      cache.slow = true;
    }
    return cache;
  };
  let online = true;
  const { worker, event } = setup({ mode: 'web', caches, respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  assert.match(await (await worker.handle('page', navigation('/'), event)).text(), /content="network"/);
  online = false;

  const newTab = worker.handle('page', navigation('/'), event);
  setTimeout(release, 50);

  assert.match(await (await newTab).text(), /content="cache"/);
});

// Owner D2 round 8 (sandbox5): offline right after sign-in, the library page had arrived but writing
// it (several megabytes, on a busy computer) took longer than the wait for downloads.
test('IAR-W12: a page that arrived is there for a new tab however long writing it takes', async () => {
  const caches = fakeCaches();
  const open = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await open(name);
    if (!cache.slow) {
      const put = cache.put.bind(cache);
      cache.put = async (...args) => { await new Promise(resolve => setTimeout(resolve, 150)); return put(...args); };
      cache.slow = true;
    }
    return cache;
  };
  let online = true;
  const { worker, event } = setup({ mode: 'web', caches, respond: () => (online ? page('acct-a') : new TypeError('Failed to fetch')) });
  await worker.handle('page', navigation('/'), event);
  online = false;

  assert.match(await (await worker.handle('page', navigation('/'), event)).text(), /content="cache"/);
});

// Round 10 on sandbox5: right after sign-in an offline tab waited 8-33 s for every cover the page
// had just loaded to be written, though it needed only the page.
test('IAR-W12: an offline navigation waits for the page being written, not for covers being written', async () => {
  const caches = fakeCaches();
  const open = caches.open.bind(caches);
  caches.open = async (name) => {
    const cache = await open(name);
    if (!cache.slowCovers) {
      const put = cache.put.bind(cache);
      cache.put = async (request, response) => {
        const key = typeof request === 'string' ? request : request.url;
        if (key.includes('/__album-haven-cover/')) await new Promise(resolve => setTimeout(resolve, 300));
        return put(request, response);
      };
      cache.slowCovers = true;
    }
    return cache;
  };
  let online = true;
  const { worker, event, settled } = setup({
    mode: 'web', caches,
    respond: request => (!online ? new TypeError('Failed to fetch')
      : new URL(request.url).pathname === '/' ? page('acct-a') : coverResponse(10)),
  });
  await worker.handle('page', navigation('/'), event);
  await settled();
  for (let index = 0; index < 10; index += 1) {
    void worker.handle('cover', resource(`/cover/${String(index).padStart(22, 'C')}?size=480`), event);
  }
  // The covers have arrived and are queued for writing when the connection drops.
  for (let turn = 0; turn < 50; turn += 1) await new Promise(resolve => setImmediate(resolve));
  online = false;

  const started = Date.now();
  const response = await worker.handle('page', navigation('/'), event);

  assert.match(await response.text(), /content="cache"/);
  assert.ok(Date.now() - started < 1000, `answered after ${Date.now() - started} ms, not after the covers' 3 s of writes`);
});

// Owner round 10 ("B: wait 10 s"): a tunnel held the first request after its server stopped for
// 20-60 s, and the tab stayed blank all that time.
function heldServer() {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let holding = false;
  return {
    hold() { holding = true; },
    release: answer => release(answer),
    respond: () => (holding ? held : page('acct-a')),
  };
}

test('IAR-W14: a navigation with no answer within the wait shows the copy, marked unanswered, and still keeps the answer', async () => {
  const server = heldServer();
  const { worker, event, settled, caches } = setup({ mode: 'web', respond: server.respond, noAnswerMs: 30 });
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  server.hold();

  const response = await worker.handle('page', navigation('/'), event);

  assert.match(await response.text(), /content="cache" data-unanswered="1" data-account="acct-a"/);
  server.release(page('acct-a', { body: 'Later' }));
  await settled();
  const kept = await caches.stores.get(`${CACHE_PREFIX}acct-a`).match(`${ORIGIN}/`);
  assert.match(await kept.text(), /Later/, 'the answer that came after the wait is kept');
});

// Round 10 on the owner's busy computer: reading the copy took seconds after the wait had ended.
test('IAR-W14: the copy is prepared while waiting, so it is ready the moment the wait ends', async () => {
  const server = heldServer();
  const caches = fakeCaches();
  const { worker, event } = setup({ mode: 'web', caches, respond: server.respond, noAnswerMs: 300 });
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  const cache = caches.stores.get(`${CACHE_PREFIX}acct-a`);
  const match = cache.match.bind(cache);
  cache.match = async (...args) => { await new Promise(resolve => setTimeout(resolve, 120)); return match(...args); };
  server.hold();

  const started = Date.now();
  const response = await worker.handle('page', navigation('/'), event);

  assert.match(await response.text(), /data-unanswered="1"/);
  assert.ok(Date.now() - started < 450, `answered after ${Date.now() - started} ms, not after the wait plus the read`);
  server.release(page('acct-a'));
});

test('IAR-W14: a slow answer within the wait is the page, never the copy', async () => {
  let slow = false;
  const respond = () => (slow ? new Promise(resolve => setTimeout(() => resolve(page('acct-a')), 20)) : page('acct-a'));
  const { worker, event } = setup({ mode: 'web', respond, noAnswerMs: 200 });
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  slow = true;

  const response = await worker.handle('page', navigation('/'), event);

  assert.match(await response.text(), /content="network"/);
});

test('IAR-W14: with nothing kept, a navigation keeps waiting for the server however long', async () => {
  const server = heldServer();
  server.hold();
  const { worker, event } = setup({ mode: 'web', respond: server.respond, noAnswerMs: 20 });

  const navigationDone = worker.handle('page', navigation('/'), event);
  await new Promise(resolve => setTimeout(resolve, 60));
  server.release(page('acct-a'));

  assert.match(await (await navigationDone).text(), /content="network"/);
});

// Owner round 8: offline, Album Details' close button was an empty square. Its X is a CSS mask
// image that loads only when the button first appears, so a copy never shown details lacked it.
function styledServer({ online = () => true } = {}) {
  const requests = [];
  const respond = (request) => {
    const url = new URL(request.url);
    requests.push(url.pathname);
    if (!online()) return new TypeError('Failed to fetch');
    if (url.pathname === '/') {
      return page('acct-a', { body: '<link rel="stylesheet" href="/static/css/details.css?v=v1">' });
    }
    if (url.pathname === '/static/css/details.css') {
      return new Response(".close{mask:url('/static/images/icons/tabler-x.svg') center/18px no-repeat}.far{background:url(https://example.org/x.png)}", {
        headers: { 'Content-Type': 'text/css', 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
    }
    if (url.pathname === '/static/images/icons/tabler-x.svg') return new Response('<svg>x</svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
    return new Response('missing', { status: 404 });
  };
  return { respond, requests };
}

test('IAR-W13: images a kept stylesheet draws (icon masks) are kept, so they show offline in views never opened online', async () => {
  let up = true;
  const server = styledServer({ online: () => up });
  const { worker, handle } = setup({ mode: 'web', respond: server.respond });
  await worker.message({ type: 'save', url: `${ORIGIN}/` });
  assert.ok(server.requests.includes('/static/images/icons/tabler-x.svg'), 'the X is fetched while online');
  assert.ok(!server.requests.some(path => path.includes('example.org')), 'only same-origin images');
  up = false;

  const icon = await handle(resource('/static/images/icons/tabler-x.svg'));

  assert.equal(await icon.text(), '<svg>x</svg>');
});

// Sandbox5: right after signing in, the page the worker loads is never saved again, and its
// stylesheets arrived before the copy existed; the close X showed as an empty square offline.
test('IAR-W13: the page that starts the copy keeps its stylesheets and the images they draw, with no save', async () => {
  let up = true;
  const server = styledServer({ online: () => up });
  const { handle, settled } = setup({ mode: 'web', respond: server.respond });
  await handle(resource('/static/css/details.css?v=v1'));
  await handle(navigation('/'));
  await settled();
  up = false;

  assert.match(await (await handle(resource('/static/css/details.css?v=v1'))).text(), /tabler-x/);
  assert.equal(await (await handle(resource('/static/images/icons/tabler-x.svg'))).text(), '<svg>x</svg>');
});

test('IAR-W13: a stylesheet kept before is read for its images once per worker, on the next save', async () => {
  const server = styledServer();
  const caches = fakeCaches();
  const first = setup({ mode: 'web', caches, respond: server.respond });
  await first.worker.message({ type: 'save', url: `${ORIGIN}/` });
  await caches.stores.get(`${CACHE_PREFIX}acct-a`).delete(`${ORIGIN}/static/images/icons/tabler-x.svg`);
  server.requests.length = 0;

  const restarted = setup({ mode: 'web', caches, respond: server.respond });
  await restarted.worker.message({ type: 'save', url: `${ORIGIN}/` });
  await restarted.worker.message({ type: 'save', url: `${ORIGIN}/` });

  assert.equal(server.requests.filter(path => path === '/static/images/icons/tabler-x.svg').length, 1);
  assert.ok(!server.requests.includes('/static/css/details.css'), 'the kept stylesheet is read from the copy');
});

// Request-capture contracts (tests/ci/bounded-interactions.json): the real worker routes every
// kind of browser request; only its owned endpoints may reach the network, each at most once.
const { assertInteractionRequests, createRequestCapture, measureInteractionContract } = require('../helpers/request-capture');

const UNOWNED_REQUESTS = [
  navigation('/account'), navigation('/admin/members'), resource('/status'), resource('/utilities/edit-tags', 'POST'), { url: `https://example.org/cover/${'x'.repeat(22)}`, method: 'GET', mode: 'no-cors' },
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
    // The page that starts the copy keeps the [keptAssets] it loads; the page then loads two more.
    const scripts = Array.from({ length: keptAssets }, (_, index) => `/static/js/runtime/kept-${index}.js?v=v1`);
    const captured = capturedWorker(0, { scripts });
    await captured.handle(navigation('/'));
    scripts.push('/static/js/runtime/app.js?v=v1', '/static/css/app.css?v=v1');
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

// ---- Library data already seen, offline after a reload (IAR-W20..IAR-W25) ----

const REDACT_HEADER = 'X-Album-Haven-App-Copy-Redact';
const REDACTED = 'path,src,track_paths,music_dir';

function dataAnswer(payload, {
  account = 'acct-a', status = 200, cacheControl = 'private, no-cache', marked = true, expires,
} = {}) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': cacheControl };
  if (marked) Object.assign(headers, { [COPY_HEADER]: account, [REDACT_HEADER]: REDACTED });
  if (expires) headers[EXPIRES_HEADER] = String(expires);
  return new Response(JSON.stringify(payload), { status, headers });
}

const albumDetails = (key, tracks = ['01 Intro.flac', '02 Song.flac']) => ({
  ok: true,
  album: {
    key,
    name: key.split('::')[1],
    track_paths: tracks.map(name => `D:\\Music\\${key}\\${name}`),
    // A track's key is its path; its stream URL names the path too.
    tracks: tracks.map((name, index) => {
      const file = `D:\\Music\\${key}\\${name}`;
      return { title: name.slice(3, -5), number: index + 1, path: file, key: file, src: `/stream?path=${encodeURIComponent(file)}` };
    }),
  },
});

// The server's gallery cursor (Python's json.dumps spacing, unpadded URL-safe base64).
const cursor = (revision, offset) => Buffer.from(`[1, ${JSON.stringify(revision)}, ${offset}]`).toString('base64url');

// One page of the unfiltered gallery: [artists] each with one album, the next page at [end].
function galleryPage(artists, { revision = 'r1', end = null } = {}) {
  return {
    ok: true,
    artist_groups: artists.map(artist => ({ artist, albums: [{ key: `${artist}::Debut`, name: 'Debut' }] })),
    gallery_page: {
      revision, has_more: end !== null, next_cursor: end === null ? null : cursor(revision, end), page_size: 50,
    },
  };
}

const ROOT = '/view-data?surface=albums&gallery_page_size=50';
const pageAt = (offset, revision = 'r1') => `${ROOT}&gallery_cursor=${cursor(revision, offset)}&omit_sidebar=1`;
const anchorAt = artist => `${ROOT}&gallery_anchor_artist=${encodeURIComponent(artist)}&omit_sidebar=1`;

// A server answering [routes] (path and query -> payload) while [online.value] holds.
function dataServer(routes, options = {}) {
  const online = { value: true };
  return {
    online,
    respond: (request) => {
      if (!online.value) return new TypeError('Failed to fetch');
      const url = new URL(request.url);
      const payload = routes[`${url.pathname}${url.search}`];
      return payload ? dataAnswer(payload, options) : new Response('{"ok":false}', { status: 404 });
    },
  };
}

const json = async response => JSON.parse(await response.text());
const artistsOf = payload => payload.artist_groups.map(group => group.artist);

test('IAR-W20: album details opened online open offline, kept without a file path', async () => {
  const url = '/album-details?album_key=Broadcast%3A%3ATender';
  const server = dataServer({ [url]: albumDetails('Broadcast::Tender') });
  const { calls, handle, caches } = setup({ mode: 'web', respond: server.respond });

  const online = await handle(resource(url));
  assert.equal(calls[0].headers.get(COPY_HEADER), '1');
  assert.equal((await json(online)).album.tracks[0].path, 'D:\\Music\\Broadcast::Tender\\01 Intro.flac');
  server.online.value = false;
  const offline = await handle(resource(url));

  assert.equal(offline.headers.get(COPY_HEADER), 'cache');
  const kept = await json(offline);
  assert.deepEqual(kept.album.tracks.map(track => track.title), ['Intro', 'Song']);
  // The same path gets the same token, so rows stay distinct and lists still match them.
  assert.deepEqual(kept.album.track_paths, ['offline:1', 'offline:2']);
  assert.deepEqual(kept.album.tracks.map(track => track.path), ['offline:1', 'offline:2']);
  assert.deepEqual(kept.album.tracks.map(track => track.key), ['offline:1', 'offline:2']);
  assert.deepEqual(kept.album.tracks.map(track => track.src), ['offline:3', 'offline:4']);
  assert.equal(kept.album.key, 'Broadcast::Tender');
  const stored = [...caches.stores.values()].flatMap(store => [...store.entries.values()]);
  for (const response of stored) assert.doesNotMatch(await response.clone().text(), /Music/);
});

test('IAR-W20: an answer still holding a path outside the listed fields is not kept', async () => {
  const url = '/album-details?album_key=A%3A%3AB';
  const other = '/album-details?album_key=C%3A%3AD';
  const server = dataServer({
    [url]: { ok: true, album: { key: 'A::B', note: 'C:\\Users\\owner\\Music\\A\\B' } },
    [other]: { ok: true, album: { key: 'C::D', download: '/download?file=%2Fhome%2Fowner%2FMusic%2Fx.flac' } },
  });
  const { handle } = setup({ mode: 'web', respond: server.respond });
  await handle(resource(url));
  await handle(resource(other));
  server.online.value = false;

  await assert.rejects(handle(resource(url)), TypeError);
  await assert.rejects(handle(resource(other)), TypeError);
});

test('IAR-W20: data the server did not mark, marked no-store, failed or searched is never kept', async () => {
  const urls = ['/album-details?album_key=A', '/album-details?album_key=B', '/album-details?album_key=C',
    '/view-data?surface=albums&q=Broad', '/album-details?track_path=D%3A%5CMusic%5Cx.flac'];
  const answers = [
    () => dataAnswer({ ok: true }, { marked: false }),
    () => dataAnswer({ ok: true }, { cacheControl: 'no-store' }),
    () => dataAnswer({ ok: false, error: 'Album not found' }, { status: 404 }),
    () => dataAnswer({ ok: true }),
    () => dataAnswer({ ok: true }),
  ];
  let online = true;
  let index = 0;
  const { calls, handle, caches } = setup({
    mode: 'web', respond: () => (online ? answers[index]() : new TypeError('Failed to fetch')),
  });
  for (index = 0; index < urls.length; index += 1) await handle(resource(urls[index]));
  online = false;

  for (const url of urls) await assert.rejects(handle(resource(url)), TypeError, url);
  // A search or a path lookup goes to the server untouched.
  assert.equal(calls[3].headers.get(COPY_HEADER), null);
  assert.equal(calls[4].headers.get(COPY_HEADER), null);
  const keys = [...caches.stores.values()].flatMap(store => [...store.entries.keys()]);
  assert.deepEqual(keys.filter(key => !key.includes('/__app-copy__/')), []);
});

test('IAR-W23: offline, data never kept fails as it would without the copy; a gateway error is passed on', async () => {
  let status = 0;
  const { handle } = setup({
    mode: 'web', respond: () => (status ? new Response('Bad gateway', { status }) : new TypeError('Failed to fetch')),
  });

  await assert.rejects(handle(resource('/album-details?album_key=Never')), TypeError);
  status = 530;
  assert.equal((await handle(resource('/album-details?album_key=Never'))).status, 530);
});

test('IAR-W20: a gateway error answers with the kept data; the app\'s own 503 never does', async () => {
  const url = '/view-data?surface=albums&artist=Broadcast';
  let answer = () => dataAnswer({ ok: true, artist_groups: [{ artist: 'Broadcast', albums: [] }] });
  const { handle } = setup({ mode: 'web', respond: () => answer() });
  await handle(resource(url));

  answer = () => new Response('{"ok":false,"code":"gallery_projection_pending"}', { status: 503 });
  assert.equal((await handle(resource(url))).status, 503);
  answer = () => new Response('<html>Cloudflare</html>', { status: 530 });
  const kept = await handle(resource(url));
  assert.equal(kept.headers.get(COPY_HEADER), 'cache');
  assert.deepEqual(artistsOf(await json(kept)), ['Broadcast']);
});

test('IAR-W25: online, the server answers and replaces what was kept', async () => {
  const url = '/view-data?surface=albums&artist=Broadcast';
  let name = 'Old';
  let online = true;
  const { handle } = setup({
    mode: 'web',
    respond: () => (online ? dataAnswer({ ok: true, artist_groups: [{ artist: name, albums: [] }] }) : new TypeError('Failed to fetch')),
  });
  await handle(resource(url));
  name = 'New';

  const fresh = await handle(resource(url));
  assert.equal(fresh.headers.get(COPY_HEADER), 'acct-a');
  assert.deepEqual(artistsOf(await json(fresh)), ['New']);
  online = false;
  assert.deepEqual(artistsOf(await json(await handle(resource(url)))), ['New']);
});

test('IAR-W25: a slow server is waited for; the kept data answers only when the server cannot be reached', async () => {
  const url = '/view-data?surface=albums&artist=Broadcast';
  let mode = 'quick';
  let reachable = true;
  let release = () => {};
  const { handle } = setup({
    mode: 'web',
    dataCheckMs: 5,
    respond: (request) => {
      if (new URL(request.url).pathname === '/app-copy/account') {
        return reachable ? new Response('{}') : new TypeError('Failed to fetch');
      }
      const answer = dataAnswer({ ok: true, artist_groups: [{ artist: mode, albums: [] }] });
      return mode === 'quick' ? answer : new Promise((resolve) => { release = () => resolve(answer); });
    },
  });
  await handle(resource(url));

  mode = 'slow';
  const waiting = handle(resource(url));
  await new Promise(resolve => setTimeout(resolve, 30));
  release();
  assert.deepEqual(artistsOf(await json(await waiting)), ['slow']);

  mode = 'hung';
  reachable = false;
  const kept = await handle(resource(url)).finally(() => release());
  assert.equal(kept.headers.get(COPY_HEADER), 'cache');
  assert.deepEqual(artistsOf(await json(kept)), ['slow']);

  // Owner steps on sandbox5: a Wi-Fi cut holds connections open, and an album never kept loaded
  // forever. Unreachable with nothing kept fails as a lost network does, so the page says Offline.
  await assert.rejects(handle(resource('/album-details?album_key=never-kept')).finally(() => release()), TypeError);
});

// Owner steps on sandbox5 r23: behind a Wi-Fi cut every kept album waited the full check delay.
test('IAR-W25: once a check found the server unreachable, kept data answers without the wait; a server that answers the check again is waited for', async () => {
  const url = '/view-data?surface=albums&artist=Broadcast';
  let mode = 'quick';
  let reachable = true;
  let release = () => {};
  const { handle } = setup({
    mode: 'web',
    dataCheckMs: 400,
    respond: (request) => {
      if (new URL(request.url).pathname === '/app-copy/account') {
        return reachable ? new Response('{}') : new TypeError('Failed to fetch');
      }
      const answer = dataAnswer({ ok: true, artist_groups: [{ artist: mode, albums: [] }] });
      return mode === 'quick' || mode === 'back' ? answer : new Promise((resolve) => { release = () => resolve(answer); });
    },
  });
  await handle(resource(url));
  mode = 'hung';
  reachable = false;
  const timed = async () => {
    const started = Date.now();
    const response = await handle(resource(url));
    return { ms: Date.now() - started, response };
  };
  const first = await timed();
  assert.ok(first.ms >= 400, `the first waits for the server (${first.ms} ms)`);
  const second = await timed();
  assert.ok(second.ms < 200, `known unreachable, kept data answers at once (${second.ms} ms)`);
  assert.equal(second.response.headers.get(COPY_HEADER), 'cache');
  assert.deepEqual(artistsOf(await json(second.response)), ['quick']);

  reachable = true;
  mode = 'slow';
  const waiting = handle(resource(url));
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  const slow = await waiting;
  assert.notEqual(slow.headers.get(COPY_HEADER), 'cache');
  assert.deepEqual(artistsOf(await json(slow)), ['slow']);
});

test('a data request the page cancels is never answered from the copy', async () => {
  const url = '/view-data?surface=albums&artist=Broadcast';
  let online = true;
  const { handle } = setup({
    mode: 'web',
    respond: () => (online ? dataAnswer({ ok: true }) : Object.assign(new Error('aborted'), { name: 'AbortError' })),
  });
  await handle(resource(url));
  online = false;

  await assert.rejects(handle(resource(url)), { name: 'AbortError' });
});

test('IAR-W21: gallery pages scrolled through online scroll again offline, page after page', async () => {
  const routes = {
    [pageAt(50)]: galleryPage(['3 Crows', '3 Doors Down'], { end: 100 }),
    [pageAt(100)]: galleryPage(['3 Inches of Blood', '30 Seconds'], { end: 150 }),
  };
  const server = dataServer(routes);
  const { handle } = setup({ mode: 'web', respond: server.respond });
  for (const url of Object.keys(routes)) await handle(resource(url));
  server.online.value = false;

  assert.deepEqual(artistsOf(await json(await handle(resource(pageAt(50))))), ['3 Crows', '3 Doors Down']);
  assert.deepEqual(artistsOf(await json(await handle(resource(pageAt(100))))), ['3 Inches of Blood', '30 Seconds']);
  // Never scrolled to: the end of the kept gallery says it cannot load more.
  await assert.rejects(handle(resource(pageAt(150))), TypeError);
});

test('IAR-W21: offline, the tree opens an artist whose albums were scrolled past, and scrolling goes on both ways', async () => {
  const routes = {
    [pageAt(50)]: galleryPage(['3 Crows'], { end: 100 }),
    [pageAt(100)]: galleryPage(['3 Inches of Blood', '30 Seconds'], { end: 150 }),
    [pageAt(150)]: galleryPage(['311'], { end: 200 }),
  };
  const server = dataServer(routes);
  const { handle } = setup({ mode: 'web', respond: server.respond });
  for (const url of Object.keys(routes)) await handle(resource(url));
  server.online.value = false;

  const jump = await handle(resource(anchorAt('3 inches of blood')));
  assert.equal(jump.headers.get(COPY_HEADER), 'cache');
  const anchored = await json(jump);
  assert.deepEqual(artistsOf(anchored), ['3 Inches of Blood', '30 Seconds']);
  assert.equal(anchored.gallery_page.anchor_artist, '3 inches of blood');
  assert.equal(anchored.gallery_page.anchor_group_artist, '3 Inches of Blood');
  assert.equal(anchored.gallery_page.has_previous, true);
  // Down: the page's own next cursor; up: a cursor for the page kept before it, asked as "previous".
  const below = await json(await handle(resource(`${ROOT}&gallery_cursor=${anchored.gallery_page.next_cursor}&omit_sidebar=1`)));
  assert.deepEqual(artistsOf(below), ['311']);
  const above = await json(await handle(resource(
    `${ROOT}&gallery_cursor=${anchored.gallery_page.previous_cursor}&gallery_page_direction=previous&omit_sidebar=1`,
  )));
  assert.deepEqual(artistsOf(above), ['3 Crows']);
  // An artist never seen is not made up.
  await assert.rejects(handle(resource(anchorAt('ABBA'))), TypeError);
});

test('IAR-W21: a page of another gallery revision never continues this one', async () => {
  const server = dataServer({ [pageAt(50, 'r1')]: galleryPage(['3 Crows'], { revision: 'r1', end: 100 }) });
  const { handle } = setup({ mode: 'web', respond: server.respond });
  await handle(resource(pageAt(50, 'r1')));
  server.online.value = false;

  await assert.rejects(handle(resource(pageAt(50, 'r2'))), TypeError);
});

test('IAR-W22: artist views and Home opened online open offline, however their parameters are ordered', async () => {
  const artist = '/view-data?surface=albums&artist=3%20Inches%20of%20Blood&payload_tier=gallery_summary';
  const routes = {
    [artist]: { ok: true, selected_artist: '3 Inches of Blood', artist_groups: [{ artist: '3 Inches of Blood', albums: [] }] },
    // The app's own links are not file paths.
    '/home-data?omit_sidebar=1': { ok: true, sections: [{ more: '/home/recent-albums' }] },
  };
  const server = dataServer(routes);
  const { handle } = setup({ mode: 'web', respond: server.respond });
  for (const url of Object.keys(routes)) await handle(resource(url));
  server.online.value = false;

  assert.equal((await json(await handle(resource(artist)))).selected_artist, '3 Inches of Blood');
  const reordered = '/view-data?payload_tier=gallery_summary&artist=3%20Inches%20of%20Blood&surface=albums';
  assert.equal((await json(await handle(resource(reordered)))).selected_artist, '3 Inches of Blood');
  assert.equal((await json(await handle(resource('/home-data?omit_sidebar=1')))).sections[0].more, '/home/recent-albums');
});

test('IAR-W24: kept data holds to its limits, least recently opened out first', async () => {
  const routes = {};
  for (const key of ['A', 'B', 'C']) routes[`/album-details?album_key=${key}`] = albumDetails(`X::${key}`);
  for (const key of ['D', 'E']) routes[`/view-data?surface=albums&artist=${key}`] = { ok: true, artist_groups: [] };
  const server = dataServer(routes);
  const { handle, advance } = setup({ mode: 'web', respond: server.respond, dataLimits: { albums: 2, views: 1 } });
  const open = (url) => { advance(1000); return handle(resource(url)); };
  await open('/album-details?album_key=A');
  await open('/album-details?album_key=B');
  server.online.value = false;
  await open('/album-details?album_key=A');
  server.online.value = true;
  await open('/album-details?album_key=C');
  await open('/view-data?surface=albums&artist=D');
  await open('/view-data?surface=albums&artist=E');
  server.online.value = false;

  // A was opened again offline after B, so B went first.
  await assert.rejects(open('/album-details?album_key=B'), TypeError);
  for (const url of ['/album-details?album_key=A', '/album-details?album_key=C', '/view-data?surface=albums&artist=E']) {
    assert.equal((await open(url)).headers.get(COPY_HEADER), 'cache', url);
  }
  await assert.rejects(open('/view-data?surface=albums&artist=D'), TypeError);
});

test('IAR-W24: kept data holds to its byte budget; an answer over the entry limit is not kept', async () => {
  const routes = {
    '/home-data': { ok: true, filler: 'x'.repeat(600) },
    '/view-data?surface=albums&artist=A': { ok: true, filler: 'x'.repeat(600) },
    '/view-data?surface=albums&artist=B': { ok: true, filler: 'y'.repeat(2000) },
  };
  const server = dataServer(routes);
  const { handle, advance } = setup({ mode: 'web', respond: server.respond, dataLimits: { bytes: 1000, entryBytes: 1500 } });
  for (const url of Object.keys(routes)) {
    advance(1000);
    await handle(resource(url));
  }
  server.online.value = false;

  await assert.rejects(handle(resource('/home-data')), TypeError);
  assert.equal((await handle(resource('/view-data?surface=albums&artist=A'))).headers.get(COPY_HEADER), 'cache');
  await assert.rejects(handle(resource('/view-data?surface=albums&artist=B')), TypeError);
});

test('IAR-W24: kept data past its age or past the session\'s end is not shown', async () => {
  const url = '/album-details?album_key=A';
  let online = true;
  const { handle, advance } = setup({
    mode: 'web',
    respond: () => (online ? dataAnswer(albumDetails('X::A'), { expires: 1_000_000 + DAY_MS }) : new TypeError('Failed to fetch')),
  });
  await handle(resource(url));
  online = false;
  assert.equal((await handle(resource(url))).headers.get(COPY_HEADER), 'cache');

  advance(DAY_MS + 1);
  await assert.rejects(handle(resource(url)), TypeError);
});

test('IAR-006: kept data belongs to one account and goes with the copy on sign-out', async () => {
  let account = 'acct-a';
  let online = true;
  const { handle, worker } = setup({
    mode: 'web',
    respond: () => (online ? dataAnswer(albumDetails('X::A'), { account }) : new TypeError('Failed to fetch')),
  });
  await handle(resource('/album-details?album_key=A'));
  account = 'acct-b';
  await handle(resource('/album-details?album_key=B'));
  online = false;

  // The first account's album went when the second account's data was kept.
  await assert.rejects(handle(resource('/album-details?album_key=A')), TypeError);
  assert.equal((await handle(resource('/album-details?album_key=B'))).headers.get(COPY_HEADER), 'cache');
  await worker.message({ type: 'forget' });
  await assert.rejects(handle(resource('/album-details?album_key=B')), TypeError);
});

test('request capture: a data request reaches only its own address, whatever the kept data; a hung one adds one check', async () => {
  await measureInteractionContract('js:app-copy-worker.js#data', async (keptEntries) => {
    let network = 'online';
    const capture = createRequestCapture(async (url) => {
      const { pathname } = new URL(url);
      if (network === 'offline') throw new TypeError('Failed to fetch');
      if (pathname === '/app-copy/account') return new Response('{}', { status: 530 });
      if (network === 'hung') return new Promise(() => {});
      return dataAnswer({ ok: true, artist_groups: [] });
    });
    const worker = createAppCopyWorker({
      caches: fakeCaches(), fetch: capture.fetch, origin: ORIGIN, now: () => 1_000_000, mode: 'web', dataCheckMs: 1,
      dataLimits: { views: 2000 },
    });
    const pending = [];
    const event = { waitUntil: promise => pending.push(promise) };
    const handle = async (request) => {
      const response = await worker.handle(worker.route(request), request, event);
      while (pending.length) await pending.shift();
      return response;
    };
    for (let index = 0; index < keptEntries; index += 1) await handle(resource(`/view-data?surface=albums&artist=Kept${index}`));
    const before = capture.requests.length;
    const metrics = await capture.counter.measure(async () => {
      await handle(resource('/view-data?surface=albums&artist=Kept0'));
      network = 'offline';
      await handle(resource('/view-data?surface=albums&artist=Kept0'));
      network = 'hung';
      await handle(resource('/view-data?surface=albums&artist=Kept0'));
    });
    const paths = capture.urls().slice(before).map((url) => {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    });
    assert.deepEqual(paths, [
      '/view-data?surface=albums&artist=Kept0', '/view-data?surface=albums&artist=Kept0',
      '/view-data?surface=albums&artist=Kept0', '/app-copy/account',
    ]);
    assertInteractionRequests('js:app-copy-worker.js#data', paths);
    return metrics;
  });
});

test('IAR-W21: offline, the tree opens an artist only scrolled past in the gallery, as that artist\'s albums', async () => {
  const routes = { [pageAt(50)]: galleryPage(['3 Crows', '3 Inches of Blood'], { end: 100 }) };
  routes[pageAt(50)].surface = { active: 'albums' };
  const server = dataServer(routes);
  const { handle } = setup({ mode: 'web', respond: server.respond });
  await handle(resource(pageAt(50)));
  server.online.value = false;

  const view = await handle(resource('/view-data?surface=albums&artist=3%20Inches%20of%20Blood&payload_tier=gallery_summary'));
  assert.equal(view.headers.get(COPY_HEADER), 'cache');
  const payload = await json(view);
  assert.equal(payload.selected_artist, '3 Inches of Blood');
  assert.deepEqual(artistsOf(payload), ['3 Inches of Blood']);
  assert.deepEqual(payload.artist_groups[0].albums.map(album => album.key), ['3 Inches of Blood::Debut']);
  assert.deepEqual(payload.family_artist_groups, []);
  assert.equal(payload.gallery_page, undefined);
  assert.deepEqual(payload.surface, { active: 'albums' });
  // Never made up for an artist never seen, or for a search inside one.
  await assert.rejects(handle(resource('/view-data?surface=albums&artist=ABBA')), TypeError);
  await assert.rejects(handle(resource('/view-data?surface=albums&artist=3%20Crows&genre=Metal')), TypeError);
});

test('IAR-W21: the gallery\'s first block, kept with the app page, opens its artists offline too', async () => {
  const bootstrap = {
    initial_view: {
      ...galleryPage(['311', '3 Crows'], { end: 8 }),
      surface: { active: 'albums' },
    },
  };
  const html = `<!doctype html><html><head><meta name="album-haven-app-copy" content="network" data-account="acct-a"></head><body>
<script>
    window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = ${JSON.stringify(bootstrap)};
</script></body></html>`;
  let online = true;
  const { handle } = setup({
    mode: 'web',
    respond: () => (online ? new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-cache', [COPY_HEADER]: 'acct-a', [VERSION_HEADER]: 'v1' },
    }) : new TypeError('Failed to fetch')),
  });
  await handle(navigation('/'));
  online = false;

  const payload = await json(await handle(resource('/view-data?surface=albums&artist=3%20Crows&payload_tier=gallery_summary')));
  assert.equal(payload.selected_artist, '3 Crows');
  assert.deepEqual(artistsOf(payload), ['3 Crows']);
});

test('IAR-W25: a slow request that fails after the server was found reachable still falls back to the kept data', async () => {
  const url = '/view-data?surface=albums&artist=Broadcast';
  let first = true;
  let fail = () => {};
  const { handle } = setup({
    mode: 'web',
    dataCheckMs: 5,
    respond: (request) => {
      if (new URL(request.url).pathname === '/app-copy/account') return new Response('{}');
      if (first) {
        first = false;
        return dataAnswer({ ok: true, artist_groups: [{ artist: 'Kept', albums: [] }] });
      }
      return new Promise((_resolve, reject) => { fail = () => reject(new TypeError('Failed to fetch')); });
    },
  });
  await handle(resource(url));

  const answering = handle(resource(url));
  await new Promise(resolve => setTimeout(resolve, 30));
  fail();
  const kept = await answering;
  assert.equal(kept.headers.get(COPY_HEADER), 'cache');
  assert.deepEqual(artistsOf(await json(kept)), ['Kept']);
});
