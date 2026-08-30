(() => {
  const nowMs = () => (window.performance && typeof window.performance.now === 'function'
    ? Number(window.performance.now().toFixed(2))
    : Date.now());
  const pushStartupMark = (name, detail = {}) => {
    const queue = Array.isArray(window.__ALBUM_HAVEN_STARTUP_MARKS__)
      ? window.__ALBUM_HAVEN_STARTUP_MARKS__
      : [];
    queue.push({
      name,
      atMs: nowMs(),
      detail: detail && typeof detail === 'object' ? { ...detail } : {},
    });
    window.__ALBUM_HAVEN_STARTUP_MARKS__ = queue;
  };
  const currentScript = document.currentScript;
  const baseUrl = currentScript?.src ? new URL('.', currentScript.src) : new URL('/static/', window.location.origin);
  const bootstrapUrl = new URL('/bootstrap-data', window.location.origin);
  const releaseVersion = document.querySelector('meta[name="album-haven-version"]')?.content?.trim() || '0.0.0';
  bootstrapUrl.search = window.location.search;
  pushStartupMark('app_entry_started', {
    inlinePreviewVisible: Boolean(document.querySelector('#sidebar-list .artist-link, #artist-groups .artist-section')),
  });

  const defaultInitialView = {
    artist_groups: [],
    primary_artist_groups: [],
    family_artist_groups: [],
    artists_sidebar: [],
    related_artists: [],
    album_count: 0,
    artist_count: 0,
    query: '',
    search_context: null,
    selected_artist: '',
    all_artists_active: false,
    show_all_artists_sidebar_link: true,
    related_filter_artists: [],
    primary_filter_active: false,
    music_dir: '',
    app_name: 'Album Haven',
    app_version: releaseVersion,
    ignored_version_keys: [],
    manual_version_links: {},
    non_album_tracks: [],
    non_album_exception_values: [],
    initial_view_partial: false,
  };
  const defaultBootstrap = {
    refreshed: false,
    lastScanDisplay: '',
    scanInProgress: false,
    scanMode: 'idle',
    relationsInProgress: false,
    coversInProgress: false,
    partialView: false,
    startupPreview: {
      mode: 'empty_shell',
      isPartial: false,
      savedAtEpochMs: 0,
      renderStrategy: 'server_markup',
      renderedGalleryMarkup: false,
    },
    startupTiming: {
      serverRequestStartedAtEpochMs: 0,
      bootstrapPayloadReadyAtEpochMs: 0,
      payloadBuildMs: 0,
    },
    startupPayloadTiers: {
      firstPaint: {
        kind: 'shell_plus_preview',
        targetFirstPaintMs: 500,
        previewMode: 'empty_shell',
        includesGalleryMarkup: false,
      },
      hydration: {
        required: false,
        trigger: 'none',
        endpoint: '/view-data',
        reason: 'preview_is_sufficient_for_boot',
      },
    },
    startupHydration: {
      required: false,
      trigger: 'none',
      endpoint: '/view-data',
      reason: 'preview_is_sufficient_for_boot',
    },
  };
  const runtimeAssetVersion = encodeURIComponent(
    String(window.__ALBUM_HAVEN_RUNTIME_ASSET_VERSION__ || ''),
  );
  const runtimeBundlePath = `js/runtime-bundle.js${runtimeAssetVersion ? `?v=${runtimeAssetVersion}` : ''}`;

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  const renderStars = (rating) => {
    const safeRating = Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : 0;
    let html = '';
    for (let index = 1; index <= 10; index += 1) {
      html += index <= safeRating
        ? '<span class="star filled">&#9733;</span>'
        : '<span class="star">&#9734;</span>';
    }
    return html;
  };
  const getAlbumCardRating = (album) => {
    const rating = album?.album_preference?.rating;
    return Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : null;
  };
  const getFailedStartupCoverPaths = () => {
    if (!window.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__
      || typeof window.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__ !== 'object') {
      window.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__ = {};
    }
    return window.__ALBUM_HAVEN_FAILED_LOCAL_DISPLAY_COVERS__;
  };
  const STARTUP_COVER_DISPLAY_SIZE = 480;
  const STARTUP_EAGER_COVER_LIMIT = 2;
  window.handleStartupAlbumCoverImageLoad = (imageElement) => {
    if (
      !(imageElement instanceof HTMLImageElement)
      || !imageElement.complete
      || Number(imageElement.naturalWidth || 0) <= 0
    ) {
      return false;
    }
    imageElement.dataset.coverVisualState = 'ready';
    imageElement.removeAttribute('aria-hidden');
    return true;
  };
  window.handleStartupAlbumCoverImageError = (imageElement) => {
    if (imageElement instanceof HTMLImageElement) {
      imageElement.dataset.coverVisualState = 'pending';
      imageElement.setAttribute('aria-hidden', 'true');
    }
    if (imageElement && typeof imageElement.getAttribute === 'function') {
      const failedPath = String(imageElement.getAttribute('data-cover-path') || '').trim();
      if (failedPath) {
        getFailedStartupCoverPaths()[failedPath] = true;
      }
    }
    const remoteFallbackUrl = imageElement && typeof imageElement.getAttribute === 'function'
      ? String(imageElement.getAttribute('data-remote-cover-url') || '').trim()
      : '';
    if (
      remoteFallbackUrl
      && imageElement instanceof HTMLImageElement
      && imageElement.dataset?.remoteCoverTried !== '1'
    ) {
      imageElement.dataset.remoteCoverTried = '1';
      imageElement.src = remoteFallbackUrl;
      return false;
    }
    if (imageElement && typeof imageElement.replaceWith === 'function') {
      const placeholder = document.createElement('div');
      placeholder.className = 'cover-placeholder cover-placeholder-blank';
      placeholder.setAttribute('aria-hidden', 'true');
      imageElement.replaceWith(placeholder);
    }
    return false;
  };
  const buildStartupCoverUrl = (album) => {
    const canonicalPreviewUrl = String(album?.cover_preview_url || '').trim();
    if (canonicalPreviewUrl) {
      return canonicalPreviewUrl;
    }
    const coverPath = String(album?.cover_path || '').trim();
    if (coverPath && !getFailedStartupCoverPaths()[coverPath]) {
      return `/cover?path=${encodeURIComponent(coverPath)}&size=${STARTUP_COVER_DISPLAY_SIZE}`;
    }
    const remoteUrl = String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim();
    if (remoteUrl) {
      return remoteUrl;
    }
    return '';
  };
  const buildStartupAlbumCardHtml = (album, options = {}) => {
    const trackCount = Number(album?.track_count_preview || (Array.isArray(album?.tracks) ? album.tracks.length : 0) || 0);
    const coverUrl = buildStartupCoverUrl(album);
    const albumKey = escapeHtml(String(album?.key || '').trim());
    const albumName = escapeHtml(String(album?.name || 'Album'));
    const localCoverPath = escapeHtml(String(album?.cover_path || '').trim());
    const remoteCoverUrl = escapeHtml(String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim());
    const rating = getAlbumCardRating(album);
    const eagerCover = options.eagerCover === true;
    const coverMarkup = coverUrl
      ? `<img loading="${eagerCover ? 'eager' : 'lazy'}" decoding="async" fetchpriority="${eagerCover ? 'high' : 'low'}" src="${escapeHtml(coverUrl)}" data-cover-visual-state="pending" aria-hidden="true" alt="Album cover for ${albumName}" data-cover-path="${localCoverPath}" data-remote-cover-url="${remoteCoverUrl}" onload="handleStartupAlbumCoverImageLoad(this)" onerror="handleStartupAlbumCoverImageError(this)">`
      : '<div class="cover-placeholder">No cover art</div>';
    return `
      <section class="album-card" data-startup-preview-card="1">
        <button class="cover album-open-trigger" type="button" data-open-tracklist="1" data-album-key="${albumKey}" aria-label="Open ${albumName} tracklist">
          ${coverMarkup}
        </button>
        <div class="album-body">
          <h3 class="album-title"><button class="album-open-trigger album-title-button" type="button" data-open-tracklist="1" data-album-key="${albumKey}">${albumName}</button></h3>
          <div class="album-meta-row">
            <div class="album-subtitle">${escapeHtml(String(album?.album_artist || ''))}</div>
            <div class="album-year">${escapeHtml(String(album?.year || ''))}</div>
          </div>
          <div class="rating-row">
            <div class="stars" role="img" aria-label="${rating === null ? 'Album unrated' : `Album rating ${rating}/10`}">${renderStars(rating)}</div>
            ${rating === null ? '' : `<div class="rating-text">${rating}/10</div>`}
          </div>
          <div class="chip-row">
            <span class="track-count">${trackCount} track${trackCount === 1 ? '' : 's'}</span>
            <div class="album-length">${escapeHtml(String(album?.total_duration_display || ''))}</div>
          </div>
        </div>
      </section>
    `;
  };
  const extractInitialView = (payload) => {
    if (isObject(payload?.startup_payload?.first_paint_view)) {
      return payload.startup_payload.first_paint_view;
    }
    if (isObject(payload?.initial_view)) {
      return payload.initial_view;
    }
    return { ...defaultInitialView };
  };

  const rememberStartupCoverUrls = (view) => {
    const remembered = window.__ALBUM_HAVEN_STARTUP_COVER_URLS__ instanceof Map
      ? window.__ALBUM_HAVEN_STARTUP_COVER_URLS__
      : new Map();
    ['artist_groups', 'primary_artist_groups', 'family_artist_groups'].forEach((groupKey) => {
      const groups = Array.isArray(view?.[groupKey]) ? view[groupKey] : [];
      groups.forEach((group) => {
        const albums = Array.isArray(group?.albums) ? group.albums : [];
        albums.forEach((album) => {
          const coverPath = String(album?.cover_path || '').trim();
          const coverUrl = String(album?.cover_preview_url || '').trim();
          if (coverPath && coverUrl) {
            remembered.set(coverPath, coverUrl);
          }
        });
      });
    });
    window.__ALBUM_HAVEN_STARTUP_COVER_URLS__ = remembered;
  };

  const renderStartupGalleryPreview = () => {
    const payload = window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__;
    const preview = payload?.bootstrap?.startupPreview;
    const view = extractInitialView(payload);
    if (!isObject(view) || !isObject(preview) || !preview.renderedGalleryMarkup) {
      return;
    }
    const container = document.getElementById('artist-groups');
    const scrollEl = document.getElementById('albums-scroll');
    if (!(container instanceof HTMLElement) || !(scrollEl instanceof HTMLElement)) {
      return;
    }
    if (container.querySelector('[data-startup-preview-card="1"]')) {
      return;
    }
    const width = Math.max(Number(scrollEl.clientWidth || 0) - 8, 240);
    const columns = Math.max(1, Math.floor((width + 14) / (240 + 14)));
    let eagerRemaining = STARTUP_EAGER_COVER_LIMIT;
    const buildGroups = (groups) => Array.isArray(groups) ? groups.filter((group) => isObject(group)) : [];
    const buildSectionHtml = (group, sectionType) => {
      const albums = Array.isArray(group?.albums) ? group.albums.filter((album) => isObject(album)) : [];
      const rows = [];
      for (let start = 0; start < albums.length; start += columns) {
        rows.push(albums.slice(start, start + columns));
      }
      const rowHtml = rows.map((rowAlbums) => `
        <div class="album-row" style="grid-template-columns:repeat(${columns}, minmax(0, 1fr));">
          ${rowAlbums.map((album) => {
            const eagerCover = eagerRemaining > 0;
            if (eagerCover) {
              eagerRemaining -= 1;
            }
            return buildStartupAlbumCardHtml(album, { eagerCover });
          }).join('')}
        </div>
      `).join('');
      return `
        <section class="artist-section ${escapeHtml(sectionType)}" data-startup-preview-section="1">
          <div class="artist-header">
            <h2 class="artist-name">${escapeHtml(String(group?.artist_display || group?.artist || 'Artist'))}</h2>
            <div class="artist-meta">${albums.length} album${albums.length === 1 ? '' : 's'}</div>
          </div>
          <div class="artist-rows">${rowHtml}</div>
        </section>
      `;
    };
    const primaryGroups = buildGroups(view.primary_artist_groups);
    const familyGroups = buildGroups(view.family_artist_groups);
    const fallbackGroups = buildGroups(view.artist_groups);
    const parts = [];
    if (primaryGroups.length) {
      parts.push('<div class="section-split-label">Primary Artist</div>');
      parts.push(...primaryGroups.map((group) => buildSectionHtml(group, 'primary')));
    }
    if (familyGroups.length) {
      parts.push('<div class="section-split-label">Family</div>');
      parts.push(...familyGroups.map((group) => buildSectionHtml(group, 'family')));
    }
    if (!primaryGroups.length && !familyGroups.length) {
      parts.push(...fallbackGroups.map((group) => buildSectionHtml(group, 'all')));
    }
    container.innerHTML = parts.join('');
  };

  const assignBootstrapPayload = (payload) => {
    const initialView = extractInitialView(payload);
    rememberStartupCoverUrls(initialView);
    const bootstrap = {
      ...defaultBootstrap,
      ...(isObject(payload?.bootstrap) ? payload.bootstrap : {}),
    };
    window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = {
      startup_payload: {
        first_paint_view: initialView,
      },
      initial_view: initialView,
      bootstrap,
    };
  };

  const hasBootstrapPayload = () => {
    const payload = window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__;
    return isObject(payload) && isObject(extractInitialView(payload)) && isObject(payload.bootstrap);
  };

  const fetchBootstrapPayload = async () => {
    try {
      pushStartupMark('bootstrap_fetch_started');
      const response = await window.fetch(bootstrapUrl.toString(), {
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      assignBootstrapPayload(await response.json());
      pushStartupMark('bootstrap_payload_ready', { source: 'network' });
    } catch (error) {
      console.error('[AlbumHaven] Failed to load bootstrap payload.', error);
      assignBootstrapPayload(null);
      pushStartupMark('bootstrap_payload_failed');
    }
  };

  const loadRuntimeScripts = async () => {
    try {
      pushStartupMark('runtime_bundle_fetch_started');
      const scriptUrl = new URL(runtimeBundlePath, baseUrl).toString();
      const response = await window.fetch(scriptUrl, {
        credentials: 'same-origin',
        headers: {
          Accept: 'application/javascript, text/javascript, */*;q=0.1',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${runtimeBundlePath}`);
      }
      const source = await response.text();
      const script = document.createElement('script');
      script.text = `\n//# sourceURL=${scriptUrl}\n${source}\n`;
      document.head.appendChild(script);
      pushStartupMark('runtime_bundle_ready', { scriptCount: 1, bundledScriptCount: 43 });
    } catch (error) {
      console.error('[AlbumHaven] Failed to load runtime bundle.', error);
      pushStartupMark('runtime_bundle_failed');
    }
  };

  if (hasBootstrapPayload()) {
    assignBootstrapPayload(window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__);
    renderStartupGalleryPreview();
    pushStartupMark('bootstrap_payload_ready', { source: 'inline' });
  } else {
    void fetchBootstrapPayload().finally(() => {
      renderStartupGalleryPreview();
      void loadRuntimeScripts();
    });
  }
})();
