/* Account + client-category presentation state. Never a capability source. */
(function initDevicePreferences(globalObject) {
  'use strict';
  const STORAGE_KEYS = Object.freeze({
    'albumhaven.galleryDisplayPreferences.v1': 'galleryDisplayPreferences',
    'albumhaven.galleryPlaybackPreferences.v1': 'galleryPlaybackPreferences',
    'albumhaven.shellLayoutPreferences.v1': 'shellLayoutPreferences',
    'albumhaven.combineSimilarArtists.v1': 'combineSimilarArtists',
    'albumhaven.albumOpenMode.v1': 'albumOpenMode',
    'albumhaven.compactPlayer.mode.v1': 'compactPlayerMode',
    'albumhaven.playerAppearance.v1': 'playerAppearance',
    'albumhaven.mobileGridColumns.v1': 'mobileGridColumns',
    'albumhaven.gallerySources.v1': 'gallerySources',
  });
  const STRING_FIELDS = new Set(['albumOpenMode', 'compactPlayerMode']);
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function classifyProfile(options = {}) {
    if (options.clientSurfaceClass === 'tv') return 'tv';
    const nativeMobile = options.clientSurfaceClass === 'mobile'
      || /Android|iPhone|iPad|iPod/i.test(String(options.userAgent || ''))
      || (options.platform === 'MacIntel' && Number(options.maxTouchPoints) > 1);
    return nativeMobile || Number(options.viewportWidth) <= 900 ? 'mobile' : 'web_desktop';
  }

  function resolveGalleryViewForWidth(value, viewportWidth) {
    const mode = value === 'list' || value === 'rows' ? 'list' : value === 'covers' ? 'covers' : 'cards';
    return mode === 'list' && Number(viewportWidth) > 900 ? 'cards' : mode;
  }

  function resolveMobileGalleryGeometry(options = {}) {
    if (Number(options.viewportWidth) > 900) return null;
    const width = Math.max(1, Number(options.availableWidth) || 1);
    const requestedColumns = Number(options.columns);
    const columns = options.mode === 'list' ? 1 : [1, 2, 3].includes(requestedColumns) ? requestedColumns : 2;
    const gap = Math.max(0, Number(options.gap) || 0);
    const cardTrackWidth = Math.max(1, Math.floor(((width - (columns - 1) * gap) / columns) * 1000) / 1000);
    return {
      columns,
      cardTrackWidth,
      estimatedRowHeight: options.mode === 'list' ? 104 : options.mode === 'covers' ? cardTrackWidth : cardTrackWidth + 108,
    };
  }

  function createStore(options = {}) {
    const env = options.window || globalObject;
    const bootstrap = options.bootstrap || {};
    const accountId = Number(bootstrap.account_id);
    const enabled = Number.isSafeInteger(accountId) && accountId > 0;
    const profiles = clone(bootstrap.profiles || {});
    const pending = new Map();
    let timer = null;
    let inFlight = null;
    let syncState = bootstrap.load_failed ? 'unavailable' : 'saved';
    const profile = () => classifyProfile({
      viewportWidth: env.innerWidth,
      userAgent: env.navigator?.userAgent,
      platform: env.navigator?.platform,
      maxTouchPoints: env.navigator?.maxTouchPoints,
      clientSurfaceClass: bootstrap.client_surface_class,
    });
    const notify = (value) => {
      syncState = value;
      env.document?.documentElement?.setAttribute?.('data-preferences-sync', value);
      if (typeof env.CustomEvent === 'function') {
        env.document?.dispatchEvent?.(new env.CustomEvent('album-haven:preferences-sync', { detail: { state: value } }));
      }
    };
    const read = (field, fallback) => {
      const value = profiles[profile()]?.[field];
      if (value === undefined) return fallback;
      const result = clone(value);
      if (field === 'galleryDisplayPreferences') {
        result.defaultGalleryDisplayMode = resolveGalleryViewForWidth(result.defaultGalleryDisplayMode, env.innerWidth);
      }
      return result;
    };
    const schedule = () => {
      if (timer !== null) env.clearTimeout(timer);
      timer = env.setTimeout(() => { timer = null; void flush(); }, 180);
    };
    const write = (field, value) => {
      if (!enabled || !Object.values(STORAGE_KEYS).includes(field)) return false;
      const selected = profile();
      const current = profiles[selected] || (profiles[selected] = {});
      if (JSON.stringify(current[field]) === JSON.stringify(value)) return true;
      current[field] = clone(value);
      pending.set(selected, { ...(pending.get(selected) || {}), [field]: clone(value) });
      notify('pending');
      schedule();
      return true;
    };
    async function flush() {
      if (!enabled || inFlight || !pending.size) return inFlight;
      if (timer !== null) env.clearTimeout(timer);
      timer = null;
      const [selected, changes] = pending.entries().next().value;
      pending.delete(selected);
      let succeeded = false;
      inFlight = (async () => {
        try {
          const response = await (options.fetch || env.fetch.bind(env))('/account/layout-preferences', {
            method: 'PUT', credentials: 'same-origin', cache: 'no-store', keepalive: true,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Album-Haven-Account': String(accountId) },
            body: JSON.stringify({ profile: selected, changes }),
          });
          if (!response.ok || response.redirected) throw new Error('Preferences were not saved.');
          succeeded = true;
          notify(pending.size ? 'pending' : 'saved');
        } catch (_error) {
          pending.set(selected, { ...changes, ...(pending.get(selected) || {}) });
          notify('unsaved');
        } finally {
          inFlight = null;
          if (succeeded && pending.size) schedule();
        }
      })();
      return inFlight;
    }
    const api = {
      enabled, profile, read, write, flush,
      handles: (key) => enabled && Object.hasOwn(STORAGE_KEYS, key),
      getItem(key) {
        const field = STORAGE_KEYS[key];
        if (!enabled || !field) return null;
        const value = read(field, undefined);
        if (value === undefined) return null;
        return STRING_FIELDS.has(field) ? String(value) : JSON.stringify(value);
      },
      setItem(key, raw) {
        const field = STORAGE_KEYS[key];
        if (!enabled || !field) return false;
        try { return write(field, STRING_FIELDS.has(field) ? String(raw) : JSON.parse(raw)); }
        catch (_error) { return false; }
      },
      get syncState() { return syncState; },
    };
    env.addEventListener?.('pagehide', () => { void flush(); });
    env.addEventListener?.('online', () => { void flush(); });
    return api;
  }

  const helpers = { STORAGE_KEYS, classifyProfile, resolveGalleryViewForWidth, resolveMobileGalleryGeometry, createStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (globalObject) globalObject.AlbumHavenClientLayout = helpers;
  const documentObject = globalObject?.document;
  const bootstrapElement = documentObject?.getElementById?.('client-layout-preferences-bootstrap');
  if (bootstrapElement) {
    let bootstrap = {};
    try { bootstrap = JSON.parse(bootstrapElement.textContent || '{}'); } catch (_error) {}
    globalObject.AlbumHavenDevicePreferences = createStore({ bootstrap });
    documentObject.documentElement.dataset.clientProfile = globalObject.AlbumHavenDevicePreferences.profile();
  }
}(typeof window !== 'undefined' ? window : globalThis));
