// The Android app's copy of the last library view (instant return). Registered only inside the
// Android shell (app-copy.js), at the origin root so it answers navigations to the app page.
//
// It keeps, for the one signed-in account, the app page as the server rendered it for a copy
// request, the versioned assets that page loads, and cover thumbnails already seen. A navigation to
// a page kept in the last seven days is answered from the copy; the page then brings itself up to
// date. Only responses the server marked as copies for an account are kept, never anything
// no-store. Signing in or out deletes every copy, as does a page for another account.
// The copy is only for showing: every write goes to the server.
(function appCopyWorker(root) {
  'use strict';

  const COPY_HEADER = 'X-Album-Haven-App-Copy';
  const VERSION_HEADER = 'X-Album-Haven-Asset-Version';
  const CACHE_PREFIX = 'album-haven-app-copy-v1:';
  const META_PATH = '/__app-copy__/meta';
  const MAX_COPY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_PAGES = 4;
  const MAX_COVERS = 400;
  const MIN_COVER_MAX_AGE_S = 24 * 60 * 60;
  const NETWORK_MARKER = '<meta name="album-haven-app-copy" content="network"';
  const COPY_MARKER = '<meta name="album-haven-app-copy" content="cache"';
  const SIGN_IN_PAGES = /^\/(?:login|accept-invitation|password-reset|password-recovery)(?:\/|$)/;
  const SIGN_IN_POSTS = new Set(['/login', '/logout']);

  const noStore = response => /(?:^|,)\s*no-store\b/i.test(response.headers.get('Cache-Control') || '');
  const maxAge = response => Number((response.headers.get('Cache-Control') || '').match(/max-age=(\d+)/i)?.[1] || 0);
  const isAppPage = url => url.pathname === '/';
  const pageKey = url => `${url.pathname}${url.search}`;

  function createAppCopyWorker({ caches, fetch, origin, now = Date.now, maxCovers = MAX_COVERS }) {
    const metaUrl = new URL(META_PATH, origin).href;

    async function accountCache() {
      const name = (await caches.keys()).find(key => key.startsWith(CACHE_PREFIX));
      return name ? { name, cache: await caches.open(name) } : null;
    }

    async function forget() {
      const names = (await caches.keys()).filter(key => key.startsWith(CACHE_PREFIX));
      await Promise.all(names.map(name => caches.delete(name)));
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
      const html = (await response.text()).replace(NETWORK_MARKER, COPY_MARKER);
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

    async function cover(request) {
      const target = await accountCache();
      if (!target) return fetch(request);
      const kept = await target.cache.match(request);
      if (kept) {
        // Moved to the end, so the least recently seen cover goes first.
        await target.cache.delete(request);
        await target.cache.put(request, kept.clone());
        return kept;
      }
      const response = await fetch(request);
      if (response.status === 200 && !noStore(response) && maxAge(response) >= MIN_COVER_MAX_AGE_S) {
        await target.cache.put(request, response.clone());
        const covers = (await target.cache.keys()).filter(key => new URL(key.url).pathname === '/cover');
        for (const evicted of covers.slice(0, Math.max(0, covers.length - maxCovers))) {
          await target.cache.delete(evicted);
        }
      }
      return response;
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
      return url.pathname === '/cover' ? 'cover' : null;
    }

    const handlers = { page: navigate, 'versioned-asset': versionedAsset, asset, cover, forget };
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
