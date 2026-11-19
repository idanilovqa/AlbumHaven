// A copy of the last library view kept on the device (instant return), registered at the origin root
// so it answers navigations to the app page (app-copy.js registers it).
//
// It keeps, for the one signed-in account, the app page as the server rendered it for a copy
// request, the versioned assets that page loads, and cover thumbnails already seen. Two modes:
// - `app` (the Android app): a navigation to a page kept recently is answered from the copy at once;
//   the page then brings itself up to date.
// - `web` (a browser, `?mode=web`): the server answers first, however slowly; the copy answers only
//   when the server cannot be reached or fails at its gateway.
// A copy is shown for at most seven days, and never past the end of the session the server named.
// Only responses the server marked as copies for an account are kept, never anything no-store.
// Signing in or out deletes every copy, as does a page for another account. The copy is only for
// showing: every write goes to the server.
//
// No file path is stored on the device: the server names covers by opaque reference
// (`/cover/<reference>`), their bytes are kept under that reference and size, least recently seen
// out first past 200 MB, and any `cover_path` or `music_dir` left in a page is emptied.
(function appCopyWorker(root) {
  'use strict';

  const COPY_HEADER = 'X-Album-Haven-App-Copy';
  const VERSION_HEADER = 'X-Album-Haven-Asset-Version';
  const EXPIRES_HEADER = 'X-Album-Haven-App-Copy-Expires';
  const COPY_FAMILY = 'album-haven-app-copy-';
  // v2: covers kept by server reference (v1 copies named them by an on-device hash of their path).
  const CACHE_PREFIX = `${COPY_FAMILY}v2:`;
  const META_PATH = '/__app-copy__/meta';
  const MAX_COPY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_PAGES = 4;
  const MAX_COVER_BYTES = 200 * 1024 * 1024;
  const KEPT_COVER_PREFIX = '/__album-haven-cover/';
  const MAX_COVER_FILLS = 120;
  const KEEP_WAIT_MS = 200;
  // A referenced cover URL as an attribute (`&amp;`) or in the bootstrap JSON (`&`).
  const COVER_URL = /\/cover\/[A-Za-z0-9_-]{22}(?=[?"'\s<>&\\]|$)[^"'\s<>]*/g;
  // A versioned asset the page loads, as a relative or absolute URL.
  const VERSIONED_ASSET_URL = /(?:https?:\/\/[^/"'\s<>]+)?\/static\/[^"'\s<>?]+\?v=[^"'\s<>&]+/g;
  const PATH_FIELDS = /("(?:cover_path|music_dir)":\s*)"(?:[^"\\]|\\.)*"/g;
  const PATH_ATTRIBUTES = /(data-cover-path=)"[^"]*"/g;
  // A cover named by its file path; the server stopped sending these, and a page with one is not kept.
  const PATH_COVER_URL = /\/cover\?path=/;
  const NETWORK_MARKER = '<meta name="album-haven-app-copy" content="network"';
  const COPY_MARKER = '<meta name="album-haven-app-copy" content="cache"';
  const SIGN_IN_PAGES = /^\/(?:login|accept-invitation|password-reset|password-recovery)(?:\/|$)/;
  const SIGN_IN_POSTS = new Set(['/login', '/logout']);
  // Every path the worker answers or watches; Chrome sends all others straight to the network.
  const OWN_PATHS = [
    '/', '/static/*', '/cover/*', '/login*', '/logout',
    '/accept-invitation*', '/password-reset*', '/password-recovery*',
  ];

  const noStore = response => /(?:^|,)\s*no-store\b/i.test(response.headers.get('Cache-Control') || '');
  const immutable = response => /\bimmutable\b/i.test(response.headers.get('Cache-Control') || '');
  const isAppPage = url => url.pathname === '/';
  const pageKey = url => `${url.pathname}${url.search}`;
  const quietly = promise => promise.catch(() => {});

  function createAppCopyWorker({
    caches, fetch, origin, now = Date.now, maxCoverBytes = MAX_COVER_BYTES, mode = 'app',
  }) {
    const metaUrl = new URL(META_PATH, origin).href;
    // What the copy keeps, listed from the cache once per worker so no later request or message lists
    // it again: covers by key in least-recently-seen order with their sizes and total, and the URLs
    // of versioned assets.
    let keptIndex = null;
    // Covers named by kept pages, by key, to fetch once while online. Held in memory only.
    const unseenCovers = new Map();
    // Versioned assets kept pages load, to fetch once while online: a page kept by a save may be of
    // a build no page has run here yet. Held in memory only.
    const unseenAssets = new Set();
    // Every change to the copy runs alone, in order, so tabs saving at once cannot lose a page.
    let queue = Promise.resolve();
    const exclusive = (task) => {
      const run = queue.then(task);
      queue = quietly(run);
      return run;
    };
    // Raised by every forget: a page or cover fetched before it is never stored after it.
    let generation = 0;

    // Work that continues after the answer; a storage failure only means nothing is kept.
    const keeping = new Set();
    const later = (event, task) => {
      const work = quietly(task());
      keeping.add(work);
      void work.then(() => keeping.delete(work));
      event?.waitUntil?.(work);
      return work;
    };
    // What was already arriving when the server became unreachable is kept before the copy is
    // read: a connection lost just after the page loaded still leaves that page for a new tab.
    // Downloads get a short wait, so one that hangs rather than fails never holds the copy up;
    // what has arrived is then being written, which touches only storage and is waited for in full.
    const keptSoFar = async () => {
      await Promise.race([
        Promise.all(Array.from(keeping)),
        new Promise(resolve => setTimeout(resolve, KEEP_WAIT_MS)),
      ]);
      await queue;
    };

    async function accountCache() {
      const name = (await caches.keys()).find(key => key.startsWith(CACHE_PREFIX));
      return name ? { name, cache: await caches.open(name) } : null;
    }

    async function deleteCopies() {
      keptIndex = null;
      unseenCovers.clear();
      unseenAssets.clear();
      const names = (await caches.keys()).filter(key => key.startsWith(COPY_FAMILY));
      await Promise.all(names.map(name => caches.delete(name)));
    }

    function forget() {
      generation += 1;
      return exclusive(deleteCopies);
    }

    // Where a referenced cover's bytes are kept: its reference and size, whatever the version.
    function coverKey(requested) {
      const url = new URL(requested);
      const reference = url.pathname.split('/')[2];
      return new URL(`${KEPT_COVER_PREFIX}${reference}/${url.searchParams.get('size') || 'original'}`, origin).href;
    }

    function withoutPaths(html) {
      for (const [raw] of html.matchAll(COVER_URL)) {
        const url = new URL(raw.replaceAll('\\u0026', '&').replaceAll('&amp;', '&'), origin);
        unseenCovers.set(coverKey(url), url.href);
      }
      for (const [raw] of html.matchAll(VERSIONED_ASSET_URL)) {
        const url = new URL(raw.replaceAll('&amp;', '&'), origin);
        if (url.origin === origin) unseenAssets.add(url.href);
      }
      return html.replace(PATH_FIELDS, '$1""').replace(PATH_ATTRIBUTES, '$1""');
    }

    async function readMeta(cache) {
      const saved = await cache.match(metaUrl);
      return saved ? saved.json() : { pages: {}, served: '' };
    }

    const writeMeta = (cache, meta) => cache.put(metaUrl, new Response(JSON.stringify(meta), {
      headers: { 'Content-Type': 'application/json' },
    }));

    // A copy kept "later" than now (the clock was set back) cannot be aged, so it is not shown.
    const isFresh = (page) => {
      if (!page) return false;
      const age = now() - page.savedAt;
      return age >= 0 && age <= MAX_COPY_AGE_MS && !(now() > page.expiresAt);
    };

    async function hasFreshCopy() {
      const target = await accountCache();
      if (!target) return false;
      return Object.values((await readMeta(target.cache)).pages).some(isFresh);
    }

    // Assets of a version no kept page and not the running page uses.
    async function pruneAssets(cache, meta) {
      const kept = new Set([meta.served, ...Object.values(meta.pages).map(page => page.version)].filter(Boolean));
      const { assets } = await readKeptIndex(cache);
      for (const asset of assets) {
        if (kept.has(new URL(asset).searchParams.get('v'))) continue;
        assets.delete(asset);
        await cache.delete(asset);
      }
    }

    // [page.running]: the page is the one starting now, so its version's assets stay while it runs.
    // [page.beside]: Home kept beside the saved view, which stays the last view.
    async function keepPage(url, response, page, fetchedIn) {
      const text = await response.text();
      if (PATH_COVER_URL.test(text)) return;
      await exclusive(async () => {
        if (fetchedIn !== generation) return;
        const html = withoutPaths(text.replace(NETWORK_MARKER, COPY_MARKER));
        const account = response.headers.get(COPY_HEADER);
        let target = await accountCache();
        if (target && target.name !== CACHE_PREFIX + account) {
          await deleteCopies();
          target = null;
        }
        const cache = target ? target.cache : await caches.open(CACHE_PREFIX + account);
        const key = pageKey(url);
        await cache.put(new URL(key, origin).href, new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }));
        const meta = await readMeta(cache);
        const version = response.headers.get(VERSION_HEADER) || '';
        const expiresAt = Number(response.headers.get(EXPIRES_HEADER)) || undefined;
        meta.pages[key] = { savedAt: now(), version, expiresAt };
        if (page.running) meta.served = version;
        if (!page.beside) meta.last = key;
        const others = Object.keys(meta.pages).filter(other => other !== '/')
          .sort((a, b) => meta.pages[a].savedAt - meta.pages[b].savedAt);
        const overflow = Object.keys(meta.pages).length - MAX_PAGES;
        for (const evicted of others.slice(0, Math.max(0, overflow))) {
          delete meta.pages[evicted];
          await cache.delete(new URL(evicted, origin).href);
        }
        await writeMeta(cache, meta);
        await pruneAssets(cache, meta);
      });
    }

    // The app page as a copy request, answered as soon as it arrives; [page.kept] settles once the
    // copy has been updated from it, and keeps the worker alive until then, also after a browser was
    // answered from the copy. A redirect means signed out, which leaves nothing to keep.
    function fetchPage(url, page, event) {
      const fetchedIn = generation;
      // The copy is cloned before anyone reads the answer.
      const arrived = fetch(new Request(url.href, {
        headers: { [COPY_HEADER]: '1' }, credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      })).then(answer => ({
        answer,
        signedOut: answer.type === 'opaqueredirect' || (answer.status >= 300 && answer.status < 400),
        copy: answer.status === 200 && answer.headers.get(COPY_HEADER) && !noStore(answer)
          && (answer.headers.get('Content-Type') || '').startsWith('text/html') ? answer.clone() : null,
      }));
      page.kept = later(event, async () => {
        const { signedOut, copy } = await arrived;
        if (signedOut) await forget();
        else if (copy) await keepPage(url, copy, page, fetchedIn);
      });
      return arrived.then(({ answer }) => answer);
    }

    // The kept copy of [url] when it may still be shown, marked as the version now running.
    async function freshCopy(url) {
      const target = await accountCache();
      if (!target) return null;
      const meta = await readMeta(target.cache);
      const page = meta.pages[pageKey(url)];
      const copy = isFresh(page) ? await target.cache.match(url.href) : null;
      if (copy && meta.served !== page.version) {
        await quietly(exclusive(async () => {
          const current = await readMeta(target.cache);
          current.served = page.version;
          await writeMeta(target.cache, current);
        }));
      }
      return copy;
    }

    // With the server unreachable, an address never kept (an artist opened after the last save) is
    // answered at that address by Home, or the last view, kept and marked as standing in: the page
    // then shows the view asked for, named and saying why it cannot load, never another view.
    async function standInCopy(url) {
      const target = await accountCache();
      if (!target) return null;
      const meta = await readMeta(target.cache);
      for (const key of ['/', meta.last]) {
        if (!key || key === pageKey(url) || !isFresh(meta.pages[key])) continue;
        const kept = await target.cache.match(new URL(key, origin).href);
        if (!kept) continue;
        const html = (await kept.text()).replace(COPY_MARKER, `${COPY_MARKER} data-view-missing="1"`);
        return new Response(html, { headers: kept.headers });
      }
      return null;
    }

    // A browser waits for the server, however slow, while it can answer: a slow connection is not
    // an offline one. Only an unreachable server or a gateway error falls back to the copy.
    async function serverFirst(url, event) {
      const network = fetchPage(url, { running: true }, event);
      const answer = await network.catch(() => null);
      if (answer && answer.status < 500) return answer;
      await keptSoFar();
      return (await freshCopy(url)) || (await standInCopy(url)) || network;
    }

    async function navigate(request, event) {
      const url = new URL(request.url);
      if (mode === 'web') return serverFirst(url, event);
      return (await freshCopy(url)) || fetchPage(url, { running: true }, event);
    }

    // Stores [response] for [request] unless signing out came after [fetchedIn]. The body is read
    // before its turn to write, so a download cut off by going offline never blocks the copy (and
    // an offline page waiting on it).
    async function storeAsset(cache, request, response, fetchedIn) {
      const kept = new Response(await response.arrayBuffer(), { headers: response.headers });
      await exclusive(async () => {
        if (fetchedIn !== generation) return;
        await cache.put(request, kept);
        const url = new URL(typeof request === 'string' ? request : request.url, origin);
        if (url.pathname.startsWith('/static/') && url.searchParams.has('v')) (await listedIndex())?.assets.add(url.href);
      });
    }

    // Keeps [response] for [request] after the answer.
    function keepAsset(event, cache, request, response) {
      const fetchedIn = generation;
      later(event, () => storeAsset(cache, request, response, fetchedIn));
    }

    // A version names exactly one build of an asset: kept once the server marks it immutable.
    async function versionedAsset(request, event) {
      const target = await accountCache();
      const kept = target ? await target.cache.match(request) : null;
      if (kept) return kept;
      let response;
      try {
        response = await fetch(request);
      } catch (error) {
        await keptSoFar();
        const keptSince = target ? await target.cache.match(request) : null;
        if (keptSince) return keptSince;
        throw error;
      }
      if (target && response.status === 200 && immutable(response)) {
        keepAsset(event, target.cache, request, response.clone());
      }
      return response;
    }

    // Unversioned assets (images, fonts) stay network-first; the copy only stands in when the server
    // cannot be reached or fails at its gateway (a tunnel without its server answers 530).
    async function asset(request, event) {
      const target = await accountCache();
      let response;
      try {
        response = await fetch(request);
      } catch (error) {
        await keptSoFar();
        const kept = target ? await target.cache.match(request) : null;
        if (kept) return kept;
        throw error;
      }
      if (target && response.status >= 500) return (await target.cache.match(request)) || response;
      if (target && response.status === 200 && !noStore(response)) keepAsset(event, target.cache, request, response.clone());
      return response;
    }

    // Each cover is stored as `<key>?bytes=<size>`, so the sizes come from the key names alone.
    // Concurrent first reads share one listing; a failed listing is tried again by the next read.
    function readKeptIndex(cache) {
      if (keptIndex) return keptIndex;
      const listing = cache.keys().then((requests) => {
        const index = { covers: new Map(), coverBytes: 0, assets: new Set() };
        for (const request of requests) {
          const url = new URL(request.url);
          if (url.pathname.startsWith(KEPT_COVER_PREFIX)) {
            const bytes = Number(url.searchParams.get('bytes') || 0);
            index.covers.set(`${url.origin}${url.pathname}`, bytes);
            index.coverBytes += bytes;
          } else if (url.pathname.startsWith('/static/') && url.searchParams.has('v')) {
            index.assets.add(request.url);
          }
        }
        return index;
      });
      keptIndex = listing;
      listing.catch(() => {
        if (keptIndex === listing) keptIndex = null;
      });
      return listing;
    }

    // The index once listed, without listing it: null before the first read or after a failed one,
    // which the next read lists again with everything kept since.
    const listedIndex = () => keptIndex?.catch(() => null) ?? null;

    // The cover under [key], now the most recently seen (in memory; a restart keeps the stored
    // order); null when none is kept.
    async function seenCover(cache, key) {
      const kept = await cache.match(key, { ignoreSearch: true });
      const covers = kept ? (await listedIndex())?.covers : null;
      if (covers?.has(key)) {
        const bytes = covers.get(key);
        covers.delete(key);
        covers.set(key, bytes);
      }
      return kept || null;
    }

    async function keepCover(key, response, fetchedIn) {
      const body = await response.arrayBuffer();
      await exclusive(async () => {
        const target = await accountCache();
        if (!target || fetchedIn !== generation) return;
        const { cache } = target;
        const index = await readKeptIndex(cache);
        if (index.covers.get(key) !== body.byteLength) {
          await cache.delete(key, { ignoreSearch: true });
          await cache.put(`${key}?bytes=${body.byteLength}`, new Response(body, {
            headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' },
          }));
        }
        index.coverBytes += body.byteLength - (index.covers.get(key) || 0);
        index.covers.delete(key);
        index.covers.set(key, body.byteLength);
        for (const [evicted, bytes] of index.covers) {
          if (index.coverBytes <= maxCoverBytes) break;
          index.covers.delete(evicted);
          index.coverBytes -= bytes;
          await cache.delete(evicted, { ignoreSearch: true });
        }
      });
    }

    // A cover from the server, as today, kept under its reference; offline or on a gateway error,
    // the one kept there.
    async function cover(request, event) {
      const target = await accountCache();
      if (!target) return fetch(request);
      const key = coverKey(request.url);
      const fetchedIn = generation;
      let response;
      try {
        response = await fetch(request);
      } catch (error) {
        const kept = await seenCover(target.cache, key);
        if (kept) return kept;
        throw error;
      }
      if (response.status >= 500) return (await seenCover(target.cache, key)) || response;
      if (response.status === 200 && !noStore(response)) {
        const copy = response.clone();
        later(event, () => keepCover(key, copy, fetchedIn));
      }
      return response;
    }

    // The kept pages' versioned assets not yet kept, fetched once while online; only the build the
    // server marks immutable is kept.
    async function fillAssets() {
      const target = await accountCache();
      if (!target) return;
      for (const href of Array.from(unseenAssets)) {
        unseenAssets.delete(href);
        if (await target.cache.match(href)) continue;
        const fetchedIn = generation;
        const response = await fetch(new Request(href, { credentials: 'same-origin' }));
        if (response.status === 200 && immutable(response)) await storeAsset(target.cache, href, response, fetchedIn);
      }
    }

    // The kept pages' covers not yet kept, fetched once while online, top of the page first.
    async function fillCovers() {
      const target = await accountCache();
      if (!target) return;
      const { covers } = await readKeptIndex(target.cache);
      // In place, so a save reads one batch however long the backlog; each cover leaves it when read.
      let read = 0;
      for (const [key, url] of unseenCovers) {
        if (read === MAX_COVER_FILLS) break;
        read += 1;
        unseenCovers.delete(key);
        if (covers.has(key)) continue;
        const fetchedIn = generation;
        const response = await fetch(new Request(url, { credentials: 'same-origin' }));
        if (response.status === 200 && !noStore(response)) await keepCover(key, response, fetchedIn);
      }
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
      return url.pathname.startsWith('/cover/') ? 'cover' : null;
    }

    const handlers = {
      page: navigate, 'versioned-asset': versionedAsset, asset, cover, forget,
    };
    const handle = (name, request, event) => handlers[name](request, event);

    // The page asks to keep its current view, to forget every copy, or whether a copy exists.
    async function message(data) {
      if (data?.type === 'forget') await forget();
      if (data?.type === 'save') {
        const url = new URL(String(data.url || ''), origin);
        if (url.origin === origin && isAppPage(url)) {
          try {
            const page = { running: false };
            await fetchPage(url, page);
            await page.kept;
            // A full restart opens Home, so "a copy exists" must cover it too.
            const target = await accountCache();
            if (target && pageKey(url) !== '/' && !isFresh((await readMeta(target.cache)).pages['/'])) {
              const home = { running: false, beside: true };
              await fetchPage(new URL('/', origin), home);
              await home.kept;
            }
            await fillAssets();
            await fillCovers();
          } catch (_error) {
            // Offline: the copy kept before stays as it is.
          }
        }
      }
      return { stored: await hasFreshCopy() };
    }

    // Chrome's static routing: requests the copy never answers go to the network without waking
    // the worker. Browsers without it dispatch them here, where they pass through untouched.
    async function install(event) {
      if (typeof event.addRoutes !== 'function') return;
      await quietly(event.addRoutes({
        condition: { not: { or: OWN_PATHS.map(pathname => ({ urlPattern: { pathname } })) } },
        source: 'network',
      }));
    }

    // Copies kept by earlier versions of the worker are never shown, so they go now.
    async function activate() {
      const names = (await caches.keys()).filter(key => key.startsWith(COPY_FAMILY) && !key.startsWith(CACHE_PREFIX));
      await Promise.all(names.map(name => caches.delete(name)));
    }

    return {
      route, handle, message, install, activate,
    };
  }

  const exported = {
    createAppCopyWorker, CACHE_PREFIX, COPY_HEADER, VERSION_HEADER, EXPIRES_HEADER, MAX_COPY_AGE_MS,
  };
  if (typeof module === 'object' && module.exports) module.exports = exported;

  if (root.registration && typeof root.addEventListener === 'function') {
    const mode = new URL(root.location.href).searchParams.get('mode') === 'web' ? 'web' : 'app';
    const worker = createAppCopyWorker({
      caches: root.caches, fetch: root.fetch.bind(root), origin: root.location.origin, mode,
    });
    root.addEventListener('install', event => event.waitUntil(worker.install(event).then(() => root.skipWaiting())));
    root.addEventListener('activate', event => event.waitUntil(worker.activate().then(() => root.clients.claim())));
    root.addEventListener('fetch', (event) => {
      const name = worker.route(event.request);
      // Sign-in and sign-out requests go on unchanged; only the copy goes, at once.
      if (name === 'forget') event.waitUntil(worker.handle(name, event.request, event));
      else if (name) event.respondWith(worker.handle(name, event.request, event));
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
