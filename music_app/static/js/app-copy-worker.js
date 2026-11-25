// A copy of the last library view kept on the device (instant return), registered at the origin root
// so it answers navigations to the app page (app-copy.js registers it).
//
// It keeps, for the one signed-in account, the app page as the server rendered it for a copy
// request, the versioned assets that page loads, cover thumbnails already seen, and the library data
// it read while online (gallery pages, artist views, Home, album details), so a reload without the
// server still opens every view already seen. Data is always server first. Two modes for the page:
// - `app` (the Android app): a navigation to a page kept recently is answered from the copy at once;
//   the page then brings itself up to date.
// - `web` (a browser, `?mode=web`): the server answers first, however slowly; the copy answers only
//   when the server cannot be reached or fails at its gateway.
// A copy is shown for at most seven days, and never past the end of the session the server named.
// Only responses the server marked as copies for an account are kept, and no asset or cover that
// is no-store. A page or a data answer always is: its mark alone lets it be kept. Signing in or out
// deletes every copy, as does a page for another account. The copy is only for showing: every
// write goes to the server.
//
// No file path is stored on the device: the server marks no page that carries one (app_copy.py,
// fits_app_copy), beside what is emptied here. The server names covers by opaque reference
// (`/cover/<reference>`), their bytes are kept under that reference and size, least recently seen
// out first past 200 MB, and any `cover_path` or `music_dir` left in a page is emptied. Data loses
// every field the server lists as a path; an answer still holding one is not kept.
(function appCopyWorker(root) {
  'use strict';

  const COPY_HEADER = 'X-Album-Haven-App-Copy';
  const VERSION_HEADER = 'X-Album-Haven-Asset-Version';
  const EXPIRES_HEADER = 'X-Album-Haven-App-Copy-Expires';
  const COPY_FAMILY = 'album-haven-app-copy-';
  // v2: covers kept by server reference (v1 copies named them by an on-device hash of their path).
  // v2.1: only pages that fit a copy are marked. Copies of earlier formats go on activation.
  const CACHE_PREFIX = `${COPY_FAMILY}v2.1:`;
  const META_PATH = '/__app-copy__/meta';
  const MAX_COPY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_PAGES = 4;
  const MAX_COVER_BYTES = 200 * 1024 * 1024;
  const KEPT_COVER_PREFIX = '/__album-haven-cover/';
  const MAX_COVER_FILLS = 120;
  const KEEP_WAIT_MS = 200;
  // A navigation with no answer at all for this long shows the copy (owner, round 10: "B: wait 10 s").
  const NO_ANSWER_MS = 10000;
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
  // Library data the page reads: kept as answered, so views already seen open again offline.
  const DATA_PATHS = new Set(['/view-data', '/album-details', '/home-data']);
  // Searches and file-path lookups are never kept (a path must not name a kept entry).
  const UNKEPT_DATA_PARAMS = ['q', 'track_path'];
  // The server's list of fields whose values are file paths; the worker never stores those values.
  const REDACT_HEADER = 'X-Album-Haven-App-Copy-Redact';
  const DATA_INDEX_PATH = '/__app-copy__/data';
  const INITIAL_GALLERY_PATH = '/__app-copy__/initial-gallery';
  // The data the app page starts with (index.html), as its template writes it.
  const BOOTSTRAP_PAYLOAD = /window\.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = (\{[\s\S]*?\});\n/;
  // Owner-approved limits (2026-11-17): least recently opened out first.
  const MAX_DATA_VIEWS = 150;
  const MAX_DATA_ALBUMS = 600;
  const MAX_DATA_BYTES = 40 * 1024 * 1024;
  const MAX_DATA_ENTRY_BYTES = 2 * 1024 * 1024;
  // A data request still unanswered this long asks whether the server can be reached at all; the
  // copy answers only if it cannot (a slow server is never replaced by what was kept).
  const DATA_CHECK_MS = 3000;
  const CHECK_TIMEOUT_MS = 800;
  // After a check found the server down (an error or a gateway failure, never a slow answer), data
  // requests this soon after ask at once instead of waiting first: the copy still answers only after
  // a check fails, so a slow but reachable server is waited for.
  const UNREACHABLE_KNOWN_MS = 60000;
  // What places one page of the paged gallery, or names one artist in it, rather than naming a
  // different gallery (other categories, scope or display).
  const GALLERY_PAGE_PARAMS = [
    'gallery_cursor', 'gallery_anchor_artist', 'gallery_page_direction', 'gallery_page_size', 'omit_sidebar',
    'payload_tier', 'all_artists',
  ];
  const ARTIST_VIEW_PARAMS = ['artist', 'family_display'];
  // An artist view narrowed further than the artist (a search or a filter) is never made up.
  const NARROWING_PARAMS = ['q', 'related_artist', 'primary_filter', 'genre', 'mood', 'style', 'duration_min', 'duration_max'];
  // A file path that escaped the server's list, alone or as a URL parameter: the answer is then not
  // kept at all. A POSIX path needs two folders, so app links like /home/recent-albums are not one.
  const FILE_PATH = /(?:^|[?&=])(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:home|mnt|media|Users|Volumes|srv|data|music|var|opt|tmp|run|net|nas|share|storage|library)\/[^/?#\s]+\/)/i;
  const namesFilePath = (text) => {
    if (FILE_PATH.test(text)) return true;
    try {
      return text.includes('%') && FILE_PATH.test(decodeURIComponent(text));
    } catch (_error) {
      return false;
    }
  };
  // Busy paths the copy will never keep (audio, playback, server checks, downloads): Chrome sends
  // them straight to the network. Never route "everything but what this version keeps" there:
  // a tab keeps the routes of the version it started under, so a later version could not keep a
  // new path in tabs already open until they reload.
  const NETWORK_PATHS = ['/track', '/playback/*', '/health', '/status', '/downloads/*'];

  const noStore = response => /(?:^|,)\s*no-store\b/i.test(response.headers.get('Cache-Control') || '');
  const immutable = response => /\bimmutable\b/i.test(response.headers.get('Cache-Control') || '');
  const isAppPage = url => url.pathname === '/';
  const pageKey = url => `${url.pathname}${url.search}`;
  const quietly = promise => promise.catch(() => {});
  const STYLE_URL = /url\(\s*(['"]?)(\/static\/[^'")\s]+)\1\s*\)/g;
  const NO_ANSWER = Symbol('no answer');
  // What a page being written is waited for under (an asset is waited for under its URL).
  const PAGES = Symbol('pages');
  // A gateway answering for a server it cannot reach; the app's own 503 means "not ready yet".
  const gatewayFailure = status => status === 502 || status === 504 || (status >= 520 && status <= 530);

  function createAppCopyWorker({
    caches, fetch, origin, now = Date.now, maxCoverBytes = MAX_COVER_BYTES, mode = 'app', noAnswerMs = NO_ANSWER_MS,
    dataLimits = {}, dataCheckMs = DATA_CHECK_MS,
  }) {
    const limits = {
      views: MAX_DATA_VIEWS, albums: MAX_DATA_ALBUMS, bytes: MAX_DATA_BYTES, entryBytes: MAX_DATA_ENTRY_BYTES,
      ...dataLimits,
    };
    const dataIndexUrl = new URL(DATA_INDEX_PATH, origin).href;
    const metaUrl = new URL(META_PATH, origin).href;
    // What the copy keeps, listed from the cache once per worker so no later request or message lists
    // it again: covers by key in least-recently-seen order with their sizes and total, and the URLs
    // of versioned assets.
    let keptIndex = null;
    // The kept data entries by key, read once per worker like keptIndex.
    let dataIndex = null;
    // Covers named by kept pages, by key, to fetch once while online. Held in memory only.
    const unseenCovers = new Map();
    // Versioned assets kept pages load, to fetch once while online: a page kept by a save may be of
    // a build no page has run here yet. Held in memory only.
    const unseenAssets = new Set();
    // Kept stylesheets already read for the images they draw (icons as CSS masks), once per worker.
    const readStyles = new Set();
    // Every change to the copy but a cover runs alone, in order, so tabs saving at once cannot lose a page.
    let queue = Promise.resolve();
    const exclusive = (task) => {
      const run = queue.then(task);
      queue = quietly(run);
      return run;
    };
    // Covers are written in a turn of their own: a page, asset or data answer being kept never
    // queues behind the many covers a page just loaded, so an offline tab waiting for those writes
    // is not held by covers (sandbox5 r25: a new tab offline right after sign-in took 11-13 s).
    let coverQueue = Promise.resolve();
    const coverTurn = (task) => {
      const run = coverQueue.then(task);
      coverQueue = quietly(run);
      return run;
    };
    // Raised by every forget: a page or cover fetched before it is never stored after it.
    let generation = 0;
    // When a reachability check last found the server down; 0 once the server answers one.
    let unreachableAt = 0;

    // Work that continues after the answer; a storage failure only means nothing is kept.
    const keeping = new Set();
    const later = (event, task) => {
      const work = quietly(task());
      keeping.add(work);
      void work.then(() => keeping.delete(work));
      event?.waitUntil?.(work);
      return work;
    };
    // Data answers waiting for their turn to be written, by key: an offline request answers from
    // them at once, so neither it nor a navigation waits behind the covers queued before them.
    const pendingData = new Map();
    // Pages and versioned assets being written to the copy, under PAGES or the asset's URL (covers
    // and data are not waited for).
    const writing = new Map();
    const written = (key, work) => {
      const works = writing.get(key) || new Set();
      writing.set(key, works.add(work));
      void quietly(work).then(() => {
        works.delete(work);
        if (!works.size && writing.get(key) === works) writing.delete(key);
      });
      return work;
    };
    // What was already arriving when the server became unreachable is kept before the copy is
    // read: a connection lost just after the page loaded still leaves that page for a new tab.
    // Downloads get a short wait, so one that hangs rather than fails never holds the copy up; what
    // [key] reads (PAGES, or one asset's URL) and arrived is then being written, which touches only
    // storage and is waited for in full. Nothing else being written is: right after a first visit
    // the copy is being filled with every asset of the page, and an offline tab waited for all of
    // them (sandbox5 r29), as it once did for covers (up to 30 s on a busy computer, round 10).
    const keptSoFar = async (key) => {
      await Promise.race([
        Promise.all(Array.from(keeping)),
        new Promise(resolve => setTimeout(resolve, KEEP_WAIT_MS)),
      ]);
      await Promise.all(Array.from(writing.get(key) || [], quietly));
    };

    async function accountCache() {
      const name = (await caches.keys()).find(key => key.startsWith(CACHE_PREFIX));
      return name ? { name, cache: await caches.open(name) } : null;
    }

    async function deleteCopies() {
      keptIndex = null;
      dataIndex = null;
      unseenCovers.clear();
      unseenAssets.clear();
      readStyles.clear();
      const names = (await caches.keys()).filter(key => key.startsWith(COPY_FAMILY));
      await Promise.all(names.map(name => caches.delete(name)));
      // A read that overlapped the deletion must not carry the old copy's index into the next one.
      dataIndex = null;
    }

    function forget() {
      generation += 1;
      pendingData.clear();
      return exclusive(async () => {
        await coverQueue;
        await deleteCopies();
      });
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
    // True when this page started the copy.
    async function keepPage(url, response, page, fetchedIn) {
      const text = await response.text();
      if (PATH_COVER_URL.test(text)) return false;
      let started = false;
      let initial = null;
      await written(PAGES, exclusive(async () => {
        if (fetchedIn !== generation) return;
        const html = withoutPaths(text.replace(NETWORK_MARKER, COPY_MARKER));
        const account = response.headers.get(COPY_HEADER);
        let target = await accountCache();
        if (target && target.name !== CACHE_PREFIX + account) {
          await deleteCopies();
          target = null;
        }
        started = !target;
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
        initial = { cache, name: CACHE_PREFIX + account, key, html, expiresAt };
      }));
      // Outside the page's turn: an offline tab waits for the page being written, never for reading
      // its gallery (100-170 ms of the worker's one thread).
      if (initial) await keepInitialGallery(initial, fetchedIn);
      return started;
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
        copy: answer.status === 200 && answer.headers.get(COPY_HEADER)
          && (answer.headers.get('Content-Type') || '').startsWith('text/html') ? answer.clone() : null,
      }));
      page.kept = later(event, async () => {
        const { signedOut, copy } = await arrived;
        if (signedOut) await forget();
        // The page's own stylesheets arrived before the copy existed, so none were kept, and a page
        // the worker loaded is never saved again (app-copy.js): the copy it starts is filled now,
        // or the close X and other icons stay missing offline until the tab is hidden.
        else if (copy && await keepPage(url, copy, page, fetchedIn)) await fillAssets();
      });
      return arrived.then(({ answer }) => answer);
    }

    // The kept copy of [url] when it may still be shown, marked as the version now running.
    // The kept copy of [url] when it may still be shown, read without changing anything; null otherwise.
    async function readCopy(url) {
      const target = await accountCache();
      if (!target) return null;
      const meta = await readMeta(target.cache);
      const page = meta.pages[pageKey(url)];
      const response = isFresh(page) ? await target.cache.match(url.href) : null;
      return response ? { response, version: page.version, served: meta.served, cache: target.cache } : null;
    }

    // [copy] is shown: its version is now the one running. Recorded in turn with the other writes,
    // never awaited: on a busy computer that turn can take seconds (round 10).
    function shown(copy) {
      if (copy.served !== copy.version) {
        void quietly(exclusive(async () => {
          const current = await readMeta(copy.cache);
          current.served = copy.version;
          await writeMeta(copy.cache, current);
        }));
      }
      return copy.response;
    }

    async function freshCopy(url) {
      const copy = await readCopy(url);
      return copy ? shown(copy) : null;
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
        if (kept) return marked(kept, 'data-view-missing');
      }
      return null;
    }

    // [copy] with [attribute]="1" on its copy marker, for the page to read (app-copy.js).
    async function marked(copy, attribute) {
      const html = (await copy.text()).replace(COPY_MARKER, `${COPY_MARKER} ${attribute}="1"`);
      return new Response(html, { headers: copy.headers });
    }

    // A browser waits for the server, however slow, while it can answer: a slow connection is not
    // an offline one. An unreachable server or a gateway error falls back to the copy, and so does
    // no answer at all within noAnswerMs (a tunnel holding the request for its stopped server); that
    // copy says so, and the server's answer is still waited for and kept.
    async function serverFirst(url, event) {
      const network = fetchPage(url, { running: true }, event);
      const answered = network.catch(() => null);
      // The answer for no answer, prepared while waiting so it is ready the moment the wait ends:
      // on a busy computer reading the cache alone took seconds (round 10).
      const ready = (async () => {
        const kept = await readCopy(url);
        const copy = kept ? kept.response : await standInCopy(url);
        return copy ? { kept, response: await marked(copy, 'data-unanswered') } : null;
      })().catch(() => null);
      let timer;
      const answer = await Promise.race([
        answered,
        new Promise((resolve) => { timer = setTimeout(() => resolve(NO_ANSWER), noAnswerMs); }),
      ]);
      clearTimeout(timer);
      if (answer === NO_ANSWER) {
        const prepared = await ready;
        if (!prepared) return network;
        if (prepared.kept) shown(prepared.kept);
        return prepared.response;
      }
      if (answer && answer.status < 500) return answer;
      await keptSoFar(PAGES);
      return (await freshCopy(url)) || (await standInCopy(url)) || network;
    }

    // A kept page is stored with no policy of its own, and would then be restorable from memory by
    // Back, whoever is signed in by then: it is answered no-store, as the server's page is.
    function pageAnswer(response) {
      if (response.status !== 200 || noStore(response)) return response;
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }

    async function navigate(request, event) {
      const url = new URL(request.url);
      if (mode === 'web') return pageAnswer(await serverFirst(url, event));
      return pageAnswer((await freshCopy(url)) || await fetchPage(url, { running: true }, event));
    }

    // Stores [response] for [request] unless signing out came after [fetchedIn]. The body is read
    // before its turn to write, so a download cut off by going offline never blocks the copy (and
    // an offline page waiting on it).
    async function storeAsset(cache, request, response, fetchedIn) {
      const kept = new Response(await response.arrayBuffer(), { headers: response.headers });
      const url = new URL(typeof request === 'string' ? request : request.url, origin);
      await written(url.href, exclusive(async () => {
        if (fetchedIn !== generation) return;
        await cache.put(request, kept);
        if (url.pathname.startsWith('/static/') && url.searchParams.has('v')) (await listedIndex())?.assets.add(url.href);
      }));
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
        await keptSoFar(request.url);
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
        await keptSoFar(request.url);
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
      await coverTurn(async () => {
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
      const images = new Set();
      for (const href of Array.from(unseenAssets)) {
        unseenAssets.delete(href);
        let style = await target.cache.match(href);
        if (!style) {
          const fetchedIn = generation;
          const response = await fetch(new Request(href, { credentials: 'same-origin' }));
          if (response.status !== 200 || !immutable(response)) continue;
          style = response.clone();
          await storeAsset(target.cache, href, response, fetchedIn);
        }
        if (!href.split('?')[0].endsWith('.css') || readStyles.has(href)) continue;
        readStyles.add(href);
        for (const image of styleImages(await style.text())) images.add(image);
      }
      // Images a stylesheet draws (the close X and other icons are CSS masks) load only when their
      // button first appears; kept now, so a view never opened online still has them offline.
      for (const href of images) {
        if (await target.cache.match(href)) continue;
        const fetchedIn = generation;
        const response = await fetch(new Request(href, { credentials: 'same-origin' }));
        if (response.status === 200 && !noStore(response)) await storeAsset(target.cache, href, response, fetchedIn);
      }
    }

    // Same-origin /static/ images a stylesheet refers to with url(...), as absolute URLs.
    function styleImages(css) {
      const found = [];
      for (const [, , raw] of css.matchAll(STYLE_URL)) {
        const url = new URL(raw, origin);
        if (url.origin === origin && url.pathname.startsWith('/static/')) found.push(url.href);
      }
      return found;
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

    // ----- Library data (gallery pages, artist views, Home, album details) -----

    // One key per answer: the address with its parameters in order.
    function dataKey(url) {
      const params = Array.from(url.searchParams).sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)));
      return `${url.pathname}?${new URLSearchParams(params)}`;
    }

    // An album without a reference is asked for by its paths: those never name a kept entry either.
    const keepsData = url => DATA_PATHS.has(url.pathname)
      && !UNKEPT_DATA_PARAMS.some(name => url.searchParams.has(name))
      && !Array.from(url.searchParams.values()).some(namesFilePath);

    // The gallery [url] belongs to, without what places a page in it or names an artist.
    function galleryBase(url) {
      const base = new URL(url.href);
      for (const name of [...GALLERY_PAGE_PARAMS, ...ARTIST_VIEW_PARAMS]) base.searchParams.delete(name);
      return dataKey(base);
    }

    // A page of the unfiltered gallery: one place in it, named by a cursor or an artist.
    function galleryPlace(url) {
      if (url.pathname !== '/view-data' || url.searchParams.get('surface') !== 'albums') return null;
      if (url.searchParams.has('artist') || !url.searchParams.has('gallery_page_size')) return null;
      return {
        base: galleryBase(url),
        cursor: readCursor(url.searchParams.get('gallery_cursor')),
        previous: url.searchParams.get('gallery_page_direction') === 'previous',
        artist: (url.searchParams.get('gallery_anchor_artist') || '').trim(),
      };
    }

    // The server's gallery cursor: [1, revision, offset] as unpadded URL-safe base64 JSON.
    function readCursor(cursor) {
      if (!cursor) return null;
      try {
        const [version, revision, offset] = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
        return version === 1 && Number.isInteger(offset) ? { revision, offset } : null;
      } catch (_error) {
        return null;
      }
    }

    const writeCursor = (revision, offset) => btoa(`[1, ${JSON.stringify(revision)}, ${offset}]`)
      .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

    // Where a kept gallery page sits: [start, end) in the gallery's albums, its artists, its revision.
    function galleryPageSpan(place, payload) {
      const page = payload?.gallery_page;
      if (!page?.revision || !Array.isArray(payload.artist_groups)) return null;
      const albums = payload.artist_groups.reduce((sum, group) => sum + (group.albums?.length || 0), 0);
      const next = readCursor(page.next_cursor);
      const end = page.has_more ? next?.offset ?? null : null;
      let start = null;
      if (place.cursor && !place.previous) start = place.cursor.offset;
      else if (end !== null) start = end - albums;
      else if (!place.cursor && !place.artist) start = 0;
      return {
        base: place.base,
        revision: page.revision,
        start,
        end,
        size: Number(page.page_size) || 50,
        artists: payload.artist_groups.map(group => String(group.artist || '')),
      };
    }

    // [value] with every value of a [redacted] field replaced by a token, and so every other string
    // equal to one (a track's key is its path): the same token for the same path within one answer,
    // so rows stay distinct and lists still match. Null when any other string still names a file
    // path, also inside a URL, which keeps nothing rather than a path.
    function withoutDataPaths(value, redacted) {
      const tokens = new Map();
      const collect = (node, field) => {
        if (typeof node === 'string') {
          if (node && redacted.has(field) && !tokens.has(node)) tokens.set(node, `offline:${tokens.size + 1}`);
        } else if (Array.isArray(node)) {
          node.forEach(item => collect(item, field));
        } else if (node && typeof node === 'object') {
          for (const [key, item] of Object.entries(node)) collect(item, key);
        }
      };
      collect(value, '');
      let leaked = false;
      const walk = (node, field) => {
        if (typeof node === 'string') {
          if (tokens.has(node)) return tokens.get(node);
          if (namesFilePath(node)) leaked = true;
          return node;
        }
        if (Array.isArray(node)) return node.map(item => walk(item, field));
        if (!node || typeof node !== 'object') return node;
        // A listed field holding an object (not a path or a list of them) is dropped whole.
        if (redacted.has(field)) return null;
        const out = {};
        for (const [key, item] of Object.entries(node)) {
          if (namesFilePath(key)) leaked = true;
          out[key] = walk(item, key);
        }
        return out;
      };
      const result = walk(value, '');
      return leaked ? null : result;
    }

    async function readDataIndex(cache) {
      if (!dataIndex) {
        const reading = cache.match(dataIndexUrl).then(saved => (saved ? saved.json() : null))
          .then(saved => ({ entries: saved?.entries || {} }));
        dataIndex = reading;
        reading.catch(() => {
          if (dataIndex === reading) dataIndex = null;
        });
      }
      return dataIndex;
    }

    const writeDataIndex = (cache, index) => cache.put(dataIndexUrl, new Response(JSON.stringify(index), {
      headers: { 'Content-Type': 'application/json' },
    }));

    // Least recently opened out first, until every limit holds; stale entries go first of all.
    async function evictData(cache, index) {
      const entries = Object.entries(index.entries).sort(([, a], [, b]) => a.seenAt - b.seenAt);
      const totals = { views: 0, albums: 0, bytes: 0 };
      for (const [, entry] of entries) {
        totals[entry.kind === 'album' ? 'albums' : 'views'] += 1;
        totals.bytes += entry.bytes;
      }
      for (const [key, entry] of entries) {
        const kind = entry.kind === 'album' ? 'albums' : 'views';
        if (isFresh(entry) && totals[kind] <= limits[kind] && totals.bytes <= limits.bytes) continue;
        delete index.entries[key];
        totals[kind] -= 1;
        totals.bytes -= entry.bytes;
        await cache.delete(new URL(key, origin).href);
      }
    }

    // [payload] as it may be kept: without file paths and within the entry limit; null otherwise.
    function keepable(payload, redacted) {
      const kept = withoutDataPaths(payload, redacted);
      if (!kept || kept.ok === false) return null;
      const body = JSON.stringify(kept);
      const bytes = new TextEncoder().encode(body).byteLength;
      return bytes > limits.entryBytes ? null : { kept, body, bytes };
    }

    // Writes [prepared] under [key] with its index [entry], then holds the data to its limits.
    // Runs in its turn (exclusive), with [cache] the account's copy.
    async function storeData(cache, key, prepared, entry) {
      const index = await readDataIndex(cache);
      await cache.put(new URL(key, origin).href, new Response(prepared.body, { headers: { 'Content-Type': 'application/json' } }));
      index.entries[key] = { ...entry, bytes: prepared.bytes, savedAt: now(), seenAt: now() };
      await evictData(cache, index);
      await writeDataIndex(cache, index);
    }

    // Keeps a data answer the server marked as a copy for an account, without its file paths.
    async function keepData(url, response, fetchedIn, event) {
      const account = response.headers.get(COPY_HEADER);
      const redacted = new Set((response.headers.get(REDACT_HEADER) || '').split(',').map(name => name.trim()).filter(Boolean));
      const text = await response.text();
      if (text.length > limits.entryBytes) return;
      const prepared = keepable(JSON.parse(text), redacted);
      if (!prepared) return;
      const place = galleryPlace(url);
      const key = dataKey(url);
      const pending = { account, kept: prepared.kept };
      if (fetchedIn === generation) pendingData.set(key, pending);
      const write = quietly(exclusive(async () => {
        if (fetchedIn !== generation) return;
        let target = await accountCache();
        if (target && target.name !== CACHE_PREFIX + account) {
          await deleteCopies();
          target = null;
        }
        const cache = target ? target.cache : await caches.open(CACHE_PREFIX + account);
        await storeData(cache, key, prepared, {
          kind: url.pathname === '/album-details' ? 'album' : 'view',
          expiresAt: Number(response.headers.get(EXPIRES_HEADER)) || undefined,
          gallery: place ? galleryPageSpan(place, prepared.kept) : null,
        });
      })).then(() => {
        if (pendingData.get(key) === pending) pendingData.delete(key);
      });
      event?.waitUntil?.(write);
    }

    // The first block of the gallery a kept app page shows, from its bootstrap, kept as gallery data
    // so the artists in it open offline like those scrolled to. Its gallery is not named by data
    // parameters (base null), so it stands in for any. Read outside any turn; only storing takes one.
    async function keepInitialGallery({ cache, name, key, html, expiresAt }, fetchedIn) {
      const match = html.match(BOOTSTRAP_PAYLOAD);
      if (!match) return;
      let view;
      try {
        view = JSON.parse(match[1])?.initial_view;
      } catch (_error) {
        return;
      }
      if (!view?.gallery_page || view.selected_artist || !Array.isArray(view.artist_groups)) return;
      const prepared = keepable(view, new Set());
      if (!prepared) return;
      const gallery = galleryPageSpan({ base: null, cursor: null, previous: false, artist: '' }, prepared.kept);
      await quietly(exclusive(async () => {
        if (fetchedIn !== generation || (await accountCache())?.name !== name) return;
        await storeData(cache, `${INITIAL_GALLERY_PATH}?page=${encodeURIComponent(key)}`, prepared, { kind: 'view', expiresAt, gallery });
      }));
    }

    // Data the server never answered within the wait, as a gateway would say it.
    const unansweredData = () => new Response(JSON.stringify({ ok: false, error: 'Album Haven cannot be reached' }), {
      status: 504, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

    // A kept answer as the page reads it, marked as coming from the copy.
    const dataAnswer = payload => new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json', [COPY_HEADER]: 'cache' },
    });

    // The kept gallery page just before [entry], as a cursor the page can ask for next; without
    // one, the page's own link (or none when its place is unknown).
    function previousLink(index, entry, page) {
      const { gallery } = entry;
      if (gallery.start === 0) return { previous_cursor: null, has_previous: false };
      if (gallery.start === null) return { previous_cursor: page.previous_cursor || null, has_previous: Boolean(page.has_previous) };
      const before = Object.values(index.entries).find(other => isFresh(other) && other.gallery
        && other.gallery.base === gallery.base && other.gallery.revision === gallery.revision
        && other.gallery.end === gallery.start && other.gallery.start !== null);
      const offset = before ? before.gallery.start : Math.max(0, gallery.start - gallery.size);
      return { previous_cursor: writeCursor(gallery.revision, offset), has_previous: true };
    }

    // A gallery place never asked for while online, answered from the pages kept around it: a jump
    // to an artist whose albums were scrolled past, or the page before or after a kept one.
    async function keptGalleryPlace(cache, index, place) {
      const pages = Object.entries(index.entries)
        .filter(([, entry]) => isFresh(entry) && entry.gallery?.base === place.base)
        .sort(([, a], [, b]) => b.savedAt - a.savedAt);
      let found = null;
      if (place.cursor) {
        found = pages.find(([, entry]) => entry.gallery.revision === place.cursor.revision
          && entry.gallery.start === place.cursor.offset);
      } else if (place.artist) {
        const wanted = place.artist.toLocaleLowerCase();
        found = pages.find(([, entry]) => entry.gallery.artists.includes(place.artist))
          || pages.find(([, entry]) => entry.gallery.artists.some(artist => artist.toLocaleLowerCase() === wanted));
      }
      if (!found) return null;
      const [key, entry] = found;
      const kept = await cache.match(new URL(key, origin).href);
      if (!kept) return null;
      const payload = await kept.json();
      const page = { ...payload.gallery_page, ...previousLink(index, entry, payload.gallery_page) };
      if (place.artist) {
        Object.assign(page, { anchor_artist: place.artist, anchor_group_artist: String(artistGroup(payload, place.artist).artist) });
      }
      return { key, payload: { ...payload, gallery_page: page } };
    }

    // An artist's own view, asked for from the tree or a card, in the gallery it belongs to.
    function artistPlace(url) {
      if (url.pathname !== '/view-data' || url.searchParams.get('surface') !== 'albums') return null;
      const artist = (url.searchParams.get('artist') || '').trim();
      if (!artist || NARROWING_PARAMS.some(name => url.searchParams.has(name))) return null;
      return { base: galleryBase(url), artist };
    }

    // The group of [artist] in a kept gallery answer: the exact name first, then ignoring case.
    function artistGroup(payload, artist) {
      const groups = Array.isArray(payload?.artist_groups) ? payload.artist_groups : [];
      const wanted = artist.toLocaleLowerCase();
      return groups.find(group => String(group.artist || '') === artist)
        || groups.find(group => String(group.artist || '').toLocaleLowerCase() === wanted) || null;
    }

    // An artist view never opened online, made from the newest kept gallery page that shows the
    // artist's albums: those albums alone, as the artist's own view, with nothing else made up
    // (no family, no tracks outside albums).
    async function keptArtistView(cache, index, place) {
      const wanted = place.artist.toLocaleLowerCase();
      // This gallery's pages first, then the first block of a kept app page, then any other gallery.
      const rank = entry => (entry.gallery.base === place.base ? 0 : entry.gallery.base === null ? 1 : 2);
      const pages = Object.entries(index.entries)
        .filter(([, entry]) => isFresh(entry) && entry.gallery
          && entry.gallery.artists.some(artist => artist.toLocaleLowerCase() === wanted))
        .sort(([, a], [, b]) => rank(a) - rank(b) || b.savedAt - a.savedAt);
      for (const [key] of pages) {
        const kept = await cache.match(new URL(key, origin).href);
        if (!kept) continue;
        const { gallery_page: _page, ...view } = await kept.json();
        const group = artistGroup(view, place.artist);
        if (!group) continue;
        return {
          key,
          payload: {
            ...view,
            selected_artist: String(group.artist),
            all_artists_active: false,
            artist_groups: [group],
            primary_artist_groups: [group],
            family_artist_groups: [],
            related_filter_base_primary_groups: [group],
            related_filter_base_family_groups: [],
            related_artists: [],
            artist_family_filters: [],
            artist_page: null,
            artist_count: 1,
            album_count: (group.albums || []).length,
            non_album_tracks: [],
            library_non_album_tracks: [],
            non_album_tracks_deferred: false,
            payload_tier: 'gallery_summary',
          },
        };
      }
      return null;
    }

    // The kept answer for [url], or one made from kept gallery pages; null when nothing was kept.
    async function keptData(url) {
      const target = await accountCache();
      const key = dataKey(url);
      const pending = pendingData.get(key);
      if (pending && (!target || target.name === CACHE_PREFIX + pending.account)) return dataAnswer(pending.kept);
      if (!target) return null;
      const index = await readDataIndex(target.cache);
      let answer = null;
      if (isFresh(index.entries[key])) {
        const kept = await target.cache.match(new URL(key, origin).href);
        if (kept) answer = { key, payload: await kept.json() };
      }
      const place = answer ? null : galleryPlace(url);
      if (place && (place.cursor || place.artist)) answer = await keptGalleryPlace(target.cache, index, place);
      const artist = answer ? null : artistPlace(url);
      if (artist) answer = await keptArtistView(target.cache, index, artist);
      if (!answer) return null;
      // Opened again: the last to go. Recorded in turn, never awaited, and never after a forget.
      const readIn = generation;
      void quietly(exclusive(async () => {
        const entry = index.entries[answer.key];
        if (!entry || readIn !== generation) return;
        entry.seenAt = now();
        await writeDataIndex(target.cache, index);
      }));
      return dataAnswer(answer.payload);
    }

    // Whether the server answers at all, asked of the account check with a short limit.
    // 'reachable'; 'down' for a network error or a gateway failure; 'slow' for no answer in time,
    // which a busy server gives as well as a cut network, so it never counts as offline by itself.
    async function serverReachable() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
      try {
        const response = await fetch(new Request(new URL('/app-copy/account', origin).href, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: controller.signal,
        }));
        const reachable = !gatewayFailure(response.status);
        unreachableAt = reachable ? 0 : now();
        return reachable ? 'reachable' : 'down';
      } catch (_error) {
        if (controller.signal.aborted) return 'slow';
        unreachableAt = now();
        return 'down';
      } finally {
        clearTimeout(timer);
      }
    }

    // Library data, server first: an answer the server marks is kept as it passes. The copy answers
    // only when the server cannot be reached (no answer, a gateway failure, or still nothing after
    // dataCheckMs and a reachability check that failed or timed out). Anything never kept fails as
    // it would have, or answers 504 when the worker gave up waiting.
    async function data(request, event) {
      const url = new URL(request.url);
      if (!keepsData(url)) return fetch(request);
      const headers = new Headers(request.headers);
      headers.set(COPY_HEADER, '1');
      const fetchedIn = generation;
      // Past the browser's HTTP cache, like the page: it would store the answer with its file paths.
      const arrived = fetch(new Request(request, { headers, cache: 'no-store' })).then((response) => {
        if (response.status === 200 && response.headers.get(COPY_HEADER)) {
          const copy = response.clone();
          later(event, () => keepData(url, copy, fetchedIn, event));
        }
        return response;
      });
      const settled = arrived.then(response => ({ response }), error => ({ error }));
      const waitMs = unreachableAt && now() - unreachableAt < UNREACHABLE_KNOWN_MS ? 0 : dataCheckMs;
      let timer;
      let outcome = await Promise.race([
        settled,
        new Promise((resolve) => { timer = setTimeout(() => resolve(NO_ANSWER), waitMs); }),
      ]);
      clearTimeout(timer);
      if (outcome === NO_ANSWER) {
        const server = await serverReachable();
        if (server !== 'reachable') {
          const kept = await keptData(url);
          if (kept) return kept;
        }
        // Never kept and certainly unreachable: give up now. A slow check may be a busy server: its
        // answer is waited for up to noAnswerMs in all, the check included (a cut network may hold
        // the request forever). Giving up after waiting answers a gateway's 504, Offline to the page,
        // and never rejects: the page's fetch (session-csrf-fetch.js) repeats a rejected read, which
        // would wait the whole time again.
        if (server === 'down') return unansweredData();
        if (server === 'slow') {
          outcome = await Promise.race([
            settled,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(NO_ANSWER), Math.max(0, noAnswerMs - waitMs - CHECK_TIMEOUT_MS));
            }),
          ]);
          clearTimeout(timer);
          if (outcome === NO_ANSWER || (outcome.error && !request.signal?.aborted)) outcome = { response: unansweredData() };
        } else outcome = await settled;
      }
      if (outcome.error) {
        if (outcome.error?.name === 'AbortError' || request.signal?.aborted) throw outcome.error;
        await keptSoFar(dataKey(url));
        const kept = await keptData(url);
        if (kept) return kept;
        throw outcome.error;
      }
      if (gatewayFailure(outcome.response.status)) return (await keptData(url)) || outcome.response;
      return outcome.response;
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
      if (DATA_PATHS.has(url.pathname)) return 'data';
      return url.pathname.startsWith('/cover/') ? 'cover' : null;
    }

    const handlers = {
      page: navigate, 'versioned-asset': versionedAsset, asset, cover, data, forget,
    };
    const handle = (name, request, event) => handlers[name](request, event);

    // A save reads its answer to the end (unread, a no-store one never finishes), then waits for the
    // copy to be updated from it.
    async function savePage(url, page) {
      await (await fetchPage(url, page)).arrayBuffer();
      await page.kept;
    }

    // The page asks to keep its current view, to forget every copy, or whether a copy exists.
    async function message(data) {
      if (data?.type === 'forget') await forget();
      if (data?.type === 'save') {
        const url = new URL(String(data.url || ''), origin);
        if (url.origin === origin && isAppPage(url)) {
          try {
            const savedIn = generation;
            await savePage(url, { running: false });
            // A full restart opens Home, so "a copy exists" must cover it too, also when the view was
            // not kept; not once signing out came since.
            const target = await accountCache();
            if (savedIn === generation && pageKey(url) !== '/' && !(target && isFresh((await readMeta(target.cache)).pages['/']))) {
              await savePage(new URL('/', origin), { running: false, beside: true });
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

    // Chrome's static routing: busy requests the copy never keeps go to the network without waking
    // the worker. Browsers without it dispatch them here, where they pass through untouched.
    async function install(event) {
      if (typeof event.addRoutes !== 'function') return;
      await quietly(event.addRoutes({
        condition: { or: NETWORK_PATHS.map(pathname => ({ urlPattern: { pathname } })) },
        source: 'network',
      }));
    }

    // Copies kept by earlier versions of the worker are never shown, so they go now. True when one
    // went: the pages open then have none until they save.
    async function activate() {
      const names = (await caches.keys()).filter(key => key.startsWith(COPY_FAMILY) && !key.startsWith(CACHE_PREFIX));
      await Promise.all(names.map(name => caches.delete(name)));
      return names.length > 0;
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
    // After a new format, the open app pages save as their own saves do. Each is a message to this
    // worker: activation holds every request, and a save's fills must not.
    root.addEventListener('activate', event => event.waitUntil(worker.activate().then(async (replaced) => {
      await root.clients.claim();
      if (!replaced) return;
      const open = (await root.clients.matchAll({ type: 'window' })).map(client => client.url)
        .filter(url => isAppPage(new URL(url)));
      for (const url of Array.from(new Set(open)).slice(0, MAX_PAGES)) {
        root.registration.active?.postMessage({ type: 'save', url });
      }
    })));
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
