const startupMetrics = (() => {
  const readNowMs = () => (window.performance && typeof window.performance.now === 'function'
    ? Number(window.performance.now().toFixed(2))
    : Date.now());
  const marks = new Map();
  const bootState = {
    initialRefreshStarted: false,
    initialVisibleRefreshCompleted: false,
    initialRefreshCompleted: false,
  };

  const readBootstrapMetadata = () => {
    const bootstrap = typeof appBootstrap?.getBootstrap === 'function'
      ? appBootstrap.getBootstrap()
      : {};
    return {
      startupPreview: bootstrap?.startupPreview || {},
      startupTiming: bootstrap?.startupTiming || {},
    };
  };

  const publishSnapshot = () => {
    const entries = {};
    marks.forEach((value, key) => {
      entries[key] = value;
    });
    window.__ALBUM_HAVEN_STARTUP_METRICS__ = {
      ...readBootstrapMetadata(),
      marks: entries,
      initialRefreshStarted: bootState.initialRefreshStarted,
      initialVisibleRefreshCompleted: bootState.initialVisibleRefreshCompleted,
      initialRefreshCompleted: bootState.initialRefreshCompleted,
    };
  };

  const markOnce = (name, detail = {}) => {
    if (!name || marks.has(name)) return marks.get(name) || null;
    const entry = {
      atMs: readNowMs(),
      detail: detail && typeof detail === 'object' ? { ...detail } : {},
    };
    marks.set(name, entry);
    publishSnapshot();
    return entry;
  };

  const schedulePaintMark = (name, readDetail) => {
    if (!name || marks.has(name)) return;
    const detailReader = typeof readDetail === 'function' ? readDetail : () => ({});
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        markOnce(name, detailReader());
      });
    });
  };

  const queuedMarks = Array.isArray(window.__ALBUM_HAVEN_STARTUP_MARKS__)
    ? window.__ALBUM_HAVEN_STARTUP_MARKS__
    : [];
  queuedMarks.forEach((entry) => {
    if (!entry || !entry.name || marks.has(entry.name)) return;
    marks.set(entry.name, {
      atMs: Number(entry.atMs || readNowMs()),
      detail: entry.detail && typeof entry.detail === 'object' ? { ...entry.detail } : {},
    });
  });
  publishSnapshot();

  return {
    markOnce,
    schedulePaintMark,
    markInitialRender(view = {}) {
      markOnce('runtime_boot_complete', {
        query: String(view.query || ''),
        selectedArtist: String(view.selected_artist || ''),
        partialView: Boolean(view.initial_view_partial),
      });
      schedulePaintMark('first_sidebar_paint', () => ({
        artistLinkCount: document.querySelectorAll('#sidebar-list .artist-link').length,
      }));
      schedulePaintMark('first_gallery_paint', () => ({
        artistSectionCount: document.querySelectorAll('#artist-groups .artist-section').length,
        splitLabelCount: document.querySelectorAll('#artist-groups .section-split-label').length,
      }));
    },
    beginInitialRefresh() {
      if (bootState.initialRefreshStarted) return;
      bootState.initialRefreshStarted = true;
      markOnce('initial_refresh_started');
      publishSnapshot();
    },
    completeVisibleInitialRefresh(view = {}, detail = {}) {
      if (bootState.initialVisibleRefreshCompleted) return;
      bootState.initialVisibleRefreshCompleted = true;
      const extraDetail = detail && typeof detail === 'object' ? detail : {};
      schedulePaintMark('initial_visible_refresh_complete', () => ({
        artistCount: Number(view.artist_count || 0),
        albumCount: Number(view.album_count || 0),
        partialView: Boolean(view.initial_view_partial),
        hydrationTier: String(extraDetail.hydrationTier || view.payload_tier || 'full'),
      }));
      publishSnapshot();
    },
    completeInitialRefresh(view = {}) {
      if (bootState.initialRefreshCompleted) return;
      bootState.initialRefreshCompleted = true;
      this.completeVisibleInitialRefresh(view, { hydrationTier: 'full' });
      schedulePaintMark('initial_refresh_complete', () => ({
        artistCount: Number(view.artist_count || 0),
        albumCount: Number(view.album_count || 0),
        partialView: Boolean(view.initial_view_partial),
      }));
      publishSnapshot();
    },
  };
})();
