// The Android app's copy of the last library view (instant return). Registered only inside the
// Android shell (app-copy.js), at the origin root so it answers navigations to the app page.
//
// It keeps, for the one signed-in account, the app page as the server rendered it for a copy
// request, the versioned assets that page loads, and cover thumbnails already seen. A navigation to
// a page kept in the last seven days is answered from the copy; the page then brings itself up to
// date. Only responses the server marked as copies for an account are kept, never anything
// no-store. Signing in or out deletes every copy, as does a page for another account.
// The copy is only for showing: every write goes to the server.
//
// No file path is stored on the device. The server addresses local covers by path
// (`/cover?path=…`), so a kept page has every `cover_path` and `music_dir` emptied and every cover
// URL replaced by an opaque key, the SHA-256 of the cover file it names; cover bytes seen online
// are kept under the same key, least recently seen out first past 200 MB.
(function appCopyWorker(root) {
  'use strict';

  const COPY_HEADER = 'X-Album-Haven-App-Copy';
  const VERSION_HEADER = 'X-Album-Haven-Asset-Version';
  const CACHE_PREFIX = 'album-haven-app-copy-v1:';
  const META_PATH = '/__app-copy__/meta';
  const MAX_COPY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_PAGES = 4;
  const MAX_COVER_BYTES = 200 * 1024 * 1024;
  const COVER_KEY_PREFIX = '/__album-haven-cover/';
  const MAX_COVER_FILLS = 120;
  // A cover URL as an attribute (`&amp;`) or in the bootstrap JSON (`&`); paths are percent-encoded.
  const COVER_URL = /\/cover\?path=[^"'\s<>]*/g;
  const PATH_FIELDS = /("(?:cover_path|music_dir)":\s*)"(?:[^"\\]|\\.)*"/g;
  const PATH_ATTRIBUTES = /(data-cover-path=)"[^"]*"/g;
  const NETWORK_MARKER = '<meta name="album-haven-app-copy" content="network"';
  const COPY_MARKER = '<meta name="album-haven-app-copy" content="cache"';
  const SIGN_IN_PAGES = /^\/(?:login|accept-invitation|password-reset|password-recovery)(?:\/|$)/;
  const SIGN_IN_POSTS = new Set(['/login', '/logout']);

  const noStore = response => /(?:^|,)\s*no-store\b/i.test(response.headers.get('Cache-Control') || '');
  const isAppPage = url => url.pathname === '/';
  const pageKey = url => `${url.pathname}${url.search}`;

  function createAppCopyWorker({
    caches, fetch, origin, now = Date.now, maxCoverBytes = MAX_COVER_BYTES, subtle = root.crypto.subtle,
  }) {
    const metaUrl = new URL(META_PATH, origin).href;
    // Kept covers by URL in least-recently-seen order, with their sizes; read from the cache once.
    let coverIndex = null;
    // Covers named by kept pages, by opaque key, to fetch once while online. Held in memory only.
    const unseenCovers = new Map();

    async function accountCache() {
      const name = (await caches.keys()).find(key => key.startsWith(CACHE_PREFIX));
      return name ? { name, cache: await caches.open(name) } : null;
    }

    async function forget() {
      coverIndex = null;
      unseenCovers.clear();
      const names = (await caches.keys()).filter(key => key.startsWith(CACHE_PREFIX));
      await Promise.all(names.map(name => caches.delete(name)));
    }

    // One key per cover file, whatever size or version a page asks for.
    async function coverKey(url) {
      const source = url.searchParams.get('path') ?? `${url.pathname}${url.search}`;
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(source));
      const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return new URL(`${COVER_KEY_PREFIX}${hex}`, origin).href;
    }

    async function withoutPaths(html) {
      const keys = new Map();
      for (const [raw] of html.matchAll(COVER_URL)) {
        if (keys.has(raw)) continue;
        const url = new URL(raw.replaceAll('\\u0026', '&').replaceAll('&amp;', '&'), origin);
        const key = await coverKey(url);
        keys.set(raw, new URL(key).pathname);
        unseenCovers.set(key, url.href);
      }
      return html.replace(COVER_URL, raw => keys.get(raw))
        .replace(PATH_FIELDS, '$1""')
        .replace(PATH_ATTRIBUTES, '$1""');
    }

    async function readMeta(cache) {
      const saved = await cache.match(metaUrl);
      return saved ? saved.json() : { pages: {}, served: '' };
    }

    const writeMeta = (cache, meta) => cache.put(metaUrl, new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json' },
    }));

    // A copy kept "later" than now (the clock was set back) cannot be aged, so it is not shown.
    const isFresh = page => Boolean(page) && now() - page.savedAt >= 0 && now() - page.savedAt <= MAX_COPY_AGE_MS;

    async function hasFreshCopy() {
      const target = await accountCache();
      if (!target) return false;
      return Object.values((await readMeta(target.cache)).pages).some(isFresh);
    }

    // Assets of a version no kept page and not the running page uses.
    async function pruneAssets(cache, meta) {
      const kept = new Set([meta.served, ...Object.values(meta.pages).map(page => page.version)].filter(Boolean));
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/static/') && url.searchParams.has('v') && !kept.has(url.searchParams.get('v'))) {
          await cache.delete(request);
        }
      }
    }

    // [running]: the page is the one starting now, so its version's assets stay while it runs.
    async function keepPage(url, response, running) {
      const account = response.headers.get(COPY_HEADER);
      let target = await accountCache();
      if (target && target.name !== CACHE_PREFIX + account) {
        await forget();
        target = null;
      }
      const cache = target ? target.cache : await caches.open(CACHE_PREFIX + account);
      const html = await withoutPaths((await response.text()).replace(NETWORK_MARKER, COPY_MARKER));
      const key = pageKey(url);
      await cache.put(new URL(key, origin).href, new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }));
      const meta = await readMeta(cache);
      const version = response.headers.get(VERSION_HEADER) || '';
      meta.pages[key] = { savedAt: now(), version };
      if (running) meta.served = version;
      const others = Object.keys(meta.pages).filter(other => other !== '/')
        .sort((a, b) => meta.pages[a].savedAt - meta.pages[b].savedAt);
      const overflow = Object.keys(meta.pages).length - MAX_PAGES;
      for (const evicted of others.slice(0, Math.max(0, overflow))) {
        delete meta.pages[evicted];
        await cache.delete(new URL(evicted, origin).href);
      }
      await writeMeta(cache, meta);
      await pruneAssets(cache, meta);
    }

    // The app page as a copy request. A redirect means signed out, which leaves nothing to keep.
    async function fetchPage(url, running = false) {
      const response = await fetch(new Request(url.href, {
        headers: { [COPY_HEADER]: '1' }, credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      }));
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        await forget();
      } else if (
        response.status === 200 && response.headers.get(COPY_HEADER) && !noStore(response)
        && (response.headers.get('Content-Type') || '').startsWith('text/html')
      ) {
        await keepPage(url, response.clone(), running);
      }
      return response;
    }

    async function navigate(request) {
      const url = new URL(request.url);
      const target = await accountCache();
      if (target) {
        const meta = await readMeta(target.cache);
        const page = meta.pages[pageKey(url)];
        const copy = isFresh(page) ? await target.cache.match(url.href) : null;
        if (copy) {
          if (meta.served !== page.version) {
            meta.served = page.version;
            await writeMeta(target.cache, meta);
          }
          return copy;
        }
      }
      return fetchPage(url, true);
    }

    // A version names exactly one build of an asset: kept once the server marks it immutable.
    async function versionedAsset(request) {
      const target = await accountCache();
      const kept = target ? await target.cache.match(request) : null;
      if (kept) return kept;
      const response = await fetch(request);
      if (target && response.status === 200 && /\bimmutable\b/i.test(response.headers.get('Cache-Control') || '')) {
        await target.cache.put(request, response.clone());
      }
      return response;
    }

    // Unversioned assets (images, fonts) stay network-first; the copy only stands in offline.
    async function asset(request) {
      const target = await accountCache();
      try {
        const response = await fetch(request);
        if (target && response.status === 200 && !noStore(response)) await target.cache.put(request, response.clone());
        return response;
      } catch (error) {
        const kept = target ? await target.cache.match(request) : null;
        if (kept) return kept;
        throw error;
      }
    }

    // Each cover is stored as `<key>?bytes=<size>`, so the sizes come from the key names alone.
    async function readCoverIndex(cache) {
      if (!coverIndex) {
        const index = new Map();
        for (const request of await cache.keys()) {
          const url = new URL(request.url);
          if (!url.pathname.startsWith(COVER_KEY_PREFIX)) continue;
          index.set(`${url.origin}${url.pathname}`, Number(url.searchParams.get('bytes') || 0));
        }
        coverIndex = index;
      }
      return coverIndex;
    }

    // The cover under [key], now the most recently seen (in memory; a restart keeps the stored
    // order); null when none is kept.
    async function seenCover(cache, key) {
      const kept = await cache.match(key, { ignoreSearch: true });
      if (kept && coverIndex?.has(key)) {
        const bytes = coverIndex.get(key);
        coverIndex.delete(key);
        coverIndex.set(key, bytes);
      }
      return kept || null;
    }

    async function keepCover(cache, key, response) {
      const body = await response.arrayBuffer();
      const index = await readCoverIndex(cache);
      if (index.get(key) !== body.byteLength) {
        await cache.delete(key, { ignoreSearch: true });
        await cache.put(`${key}?bytes=${body.byteLength}`, new Response(body, {
          headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' },
        }));
      }
      index.delete(key);
      index.set(key, body.byteLength);
      let total = Array.from(index.values()).reduce((sum, bytes) => sum + bytes, 0);
      for (const [evicted, bytes] of index) {
        if (total <= maxCoverBytes) break;
        index.delete(evicted);
        total -= bytes;
        await cache.delete(evicted, { ignoreSearch: true });
      }
    }

    // A cover from the server, as today, kept under its opaque key; offline, the one kept there.
    async function cover(request) {
      const target = await accountCache();
      if (!target) return fetch(request);
      const key = await coverKey(new URL(request.url));
      let response;
      try {
        response = await fetch(request);
      } catch (error) {
        const kept = await seenCover(target.cache, key);
        if (kept) return kept;
        throw error;
      }
      if (response.status === 200 && !noStore(response)) {
        await keepCover(target.cache, key, response.clone());
      }
      return response;
    }

    // The kept pages' covers not yet kept, fetched once while online, top of the page first.
    async function fillCovers() {
      const target = await accountCache();
      if (!target) return;
      const index = await readCoverIndex(target.cache);
      for (const [key, url] of Array.from(unseenCovers).slice(0, MAX_COVER_FILLS)) {
        unseenCovers.delete(key);
        if (index.has(key)) continue;
        const response = await fetch(new Request(url, { credentials: 'same-origin' }));
        if (response.status === 200 && !noStore(response)) {
          await keepCover(target.cache, key, response);
        }
      }
    }

    // A kept page's cover: its bytes when seen before, else nothing and the page shows a placeholder.
    async function keptCover(request) {
      const target = await accountCache();
      const kept = target ? await seenCover(target.cache, request.url) : null;
      return kept || new Response(null, { status: 404 });
    }

    // Which handler answers [request]; null leaves it to the network untouched.
    function route(request) {
      const url = new URL(request.url);
      if (url.origin !== origin) return null;
      if (request.method === 'POST' && SIGN_IN_POSTS.has(url.pathname)) return 'forget';
      if (request.method !== 'GET') return null;
      if (request.mode === 'navigate') {
        if (isAppPage(url)) return 'page';
        return SIGN_IN_PAGES.test(url.pathname) ? 'forget' : null;
      }
      if (url.pathname.startsWith('/static/')) return url.searchParams.has('v') ? 'versioned-asset' : 'asset';
      if (url.pathname.startsWith(COVER_KEY_PREFIX)) return 'kept-cover';
      return url.pathname === '/cover' ? 'cover' : null;
    }

    const handlers = {
      page: navigate, 'versioned-asset': versionedAsset, asset, cover, 'kept-cover': keptCover, forget,
    };
    const handle = (name, request) => handlers[name](request);

    // The page asks to keep its current view, to forget every copy, or whether a copy exists.
    async function message(data) {
      if (data?.type === 'forget') await forget();
      if (data?.type === 'save') {
        const url = new URL(String(data.url || ''), origin);
        if (url.origin === origin && isAppPage(url)) {
          try {
            await fetchPage(url);
            // A full restart opens Home, so the shell's "a copy exists" must cover it too.
            const target = await accountCache();
            if (target && pageKey(url) !== '/' && !isFresh((await readMeta(target.cache)).pages['/'])) {
              await fetchPage(new URL('/', origin));
            }
            await fillCovers();
          } catch (_error) {
            // Offline: the copy kept before stays as it is.
          }
        }
      }
      return { stored: await hasFreshCopy() };
    }

    return { route, handle, message };
  }

  const exported = {
    createAppCopyWorker, CACHE_PREFIX, COPY_HEADER, VERSION_HEADER, MAX_COPY_AGE_MS,
  };
  if (typeof module === 'object' && module.exports) module.exports = exported;

  if (root.registration && typeof root.addEventListener === 'function') {
    const worker = createAppCopyWorker({ caches: root.caches, fetch: root.fetch.bind(root), origin: root.location.origin });
    root.addEventListener('install', event => event.waitUntil(root.skipWaiting()));
    root.addEventListener('activate', event => event.waitUntil(root.clients.claim()));
    root.addEventListener('fetch', (event) => {
      const name = worker.route(event.request);
      // Sign-in and sign-out requests go on unchanged; only the copy goes, at once.
      if (name === 'forget') event.waitUntil(worker.handle(name, event.request));
      else if (name) event.respondWith(worker.handle(name, event.request));
    });
    root.addEventListener('message', (event) => {
      const port = event.ports?.[0];
      event.waitUntil(worker.message(event.data).then(
        reply => port?.postMessage(reply),
        () => port?.postMessage({ stored: false }),
      ));
    });
  }
}(typeof self === 'object' ? self : globalThis));
