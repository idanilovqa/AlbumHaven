// Back and Forward load the app page again, so the server decides what may show, and then return to
// the place the page was left at (runtime/gallery-return-place.js). This script runs before the first
// paint: it owns what is kept and keeps the top of the gallery from flashing first.
//
// A place is kept per history entry, for the signed-in account: album ids, an artist's name, offsets.
// Never a file path. Signing out removes every place (here and login.js) and another account finds
// none; a page still open cannot write one back (the epoch).
(function returnPlaceScript(root) {
  'use strict';

  const STORAGE_KEY = 'album-haven-return-places';
  const MAX_PLACES = 50;
  // As long as the worker waits for a server that does not answer.
  const LONGEST_HIDE_MS = 10000;
  const RETURNING = 'data-returning-to-place';
  // A file path, a signature joined from paths, or the copy's stand-in for one.
  const PATH_LIKE = /\\|(?:^|\|)(?:[A-Za-z]:\/|\/[^/|]+\/)|(?:^|\|)offline:\d+/;

  const count = value => (Number.isFinite(value) ? Math.round(value) : null);
  const text = value => (typeof value === 'string' && value && !PATH_LIKE.test(value) ? value : null);

  function albumRef(ref, { withKey = false } = {}) {
    const id = Number.isSafeInteger(ref?.id) && ref.id > 0 ? ref.id : null;
    const key = id && !withKey ? null : text(ref?.key);
    return id || key ? { ...(id ? { id } : {}), ...(key ? { key } : {}) } : null;
  }

  // [place] with only what may be kept.
  function keptPlace(place) {
    const kept = {};
    if (count(place?.top) !== null) kept.top = count(place.top);
    if (count(place?.offset) !== null) kept.offset = count(place.offset);
    if (text(place?.artist)) kept.artist = place.artist;
    const album = albumRef(place?.album);
    if (album) kept.album = album;
    const open = albumRef(place?.open, { withKey: true });
    if (open) {
      if (count(place.open.top) !== null) open.top = count(place.open.top);
      if (count(place.open.page) !== null) open.page = count(place.open.page);
      kept.open = open;
    }
    return kept;
  }

  function createReturnPlace({ window, document, storage, now = Date.now }) {
    const metaContent = (name, attribute) => document.querySelector(`meta[name="${name}"]`)?.getAttribute(attribute) || '';
    // A copy an earlier build kept names its account only as the copy's.
    const account = metaContent('album-haven-account', 'content') || metaContent('album-haven-app-copy', 'data-account');
    let epoch = '';
    let returningTo = null;
    let hideTimer = 0;

    const currentKey = () => window.navigation?.currentEntry?.key || '';

    function read() {
      try {
        return JSON.parse(storage.getItem(STORAGE_KEY));
      } catch (_error) {
        return null;
      }
    }

    function write(saved) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(saved));
      } catch (_error) {
        // Without storage, Back starts at the top.
      }
    }

    // What is kept while this page may still use it: not after a sign-out, nor for a later sign-in.
    function readOwn() {
      if (!epoch) return null;
      const saved = read();
      return saved?.epoch === epoch && saved.account === account ? saved : null;
    }

    function clear() {
      epoch = '';
      try {
        storage.removeItem(STORAGE_KEY);
      } catch (_error) {
        // Nothing was kept.
      }
    }

    function save(key, place) {
      const saved = key ? readOwn() : null;
      if (!saved) return;
      saved.entries[key] = { ...keptPlace(place), at: now() };
      const keys = Object.keys(saved.entries);
      if (keys.length > MAX_PLACES) {
        keys.sort((a, b) => saved.entries[a].at - saved.entries[b].at)
          .slice(0, keys.length - MAX_PLACES)
          .forEach(oldest => delete saved.entries[oldest]);
      }
      write(saved);
    }

    function placeFor(key) {
      const entry = key ? readOwn()?.entries[key] : null;
      if (!entry) return null;
      const { at: _at, again: _again, ...place } = entry;
      return place;
    }

    function done() {
      returningTo = null;
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = 0;
      document.documentElement.removeAttribute(RETURNING);
    }

    // The gallery is not painted on the way to its place, and never waits longer than this for it.
    function hide() {
      document.documentElement.setAttribute(RETURNING, '');
      if (hideTimer) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => document.documentElement.removeAttribute(RETURNING), LONGEST_HIDE_MS);
    }

    function start() {
      if (!account) return;
      let saved = read();
      if (saved?.account !== account || !saved.epoch || !saved.entries) {
        saved = { account, epoch: `${now().toString(36)}${Math.random().toString(36).slice(2)}`, entries: {} };
        write(saved);
      }
      epoch = saved.epoch;
      const key = currentKey();
      const entry = key ? saved.entries[key] : null;
      if (!entry) return;
      const type = window.performance?.getEntriesByType?.('navigation')?.[0]?.type;
      const again = entry.again === true;
      if (again) {
        delete entry.again;
        write(saved);
      }
      if (type !== 'back_forward' && !(again && type === 'reload')) return;
      returningTo = placeFor(key);
      if (returningTo?.top > 0) hide();
    }

    document.addEventListener('submit', (event) => {
      const action = event.target?.getAttribute?.('action') || '';
      if (/^(?:[a-z]+:\/\/[^/]+)?\/logout(?:[?#]|$)/i.test(action)) clear();
    }, true);
    // Should Back take the page from memory, it is hidden, resumes nothing and is loaded again.
    window.addEventListener('pagehide', (event) => {
      if (event.persisted) document.documentElement.style.setProperty('opacity', '0', 'important');
    });
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      event.stopImmediatePropagation();
      const key = currentKey();
      const saved = readOwn();
      if (saved?.entries[key]) {
        saved.entries[key].again = true;
        write(saved);
      }
      window.location.reload();
    });
    start();

    return {
      currentKey, save, placeFor, clear, hide, done, returning: () => returningTo,
    };
  }

  if (typeof module === 'object' && module.exports) module.exports = { createReturnPlace, STORAGE_KEY };
  if (root.document) {
    let storage = null;
    try {
      storage = root.localStorage;
    } catch (_error) {
      // Storage is switched off.
    }
    root.AlbumHavenReturnPlace = createReturnPlace({
      window: root,
      document: root.document,
      storage: storage || { getItem: () => null, setItem() {}, removeItem() {} },
    });
  }
}(typeof window === 'object' ? window : globalThis));
