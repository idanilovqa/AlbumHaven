function getAlbumCardVersionKey(album) {
  if (typeof getTrackModalAlbumVersionKey === 'function') {
    return getTrackModalAlbumVersionKey(album);
  }
  if (!album) return '';
  const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase();
  return JSON.stringify([
    normalize(getAlbumRequestKey(album) || getAlbumIdentity(album)),
    normalize(album.album_artist || album.artist),
    normalize(album.name || album.album),
    normalize(album.year),
    normalize(album.edition),
  ]);
}

function albumCardHtml(album, options = {}) {
  const summary = getAlbumCardSummary(album);
  const rating = getAlbumCardRating(album);
  const ratingMarkup = `
        <div class="rating-row">
          <div class="stars" role="img" aria-label="${rating === null ? 'Album unrated' : `Album rating ${rating}/10`}">${renderStars(rating)}</div>
          ${rating === null ? '' : `<div class="rating-text">${rating}/10</div>`}
        </div>`;
  const year = album.year ? `<div class="album-year">${escapeHtml(album.year)}</div>` : '<div class="album-year"></div>';
  const length = summary.lengthDisplay ? `<div class="album-length">${escapeHtml(summary.lengthDisplay)}</div>` : '<div class="album-length"></div>';
  const albumKey = escapeHtml(getAlbumRequestKey(album));
  const albumVersionKey = escapeHtml(getAlbumCardVersionKey(album));
  const albumFallback = escapeHtml(JSON.stringify({
    key: getAlbumRequestKey(album),
    name: String(album?.name || ''),
    album_artist: String(album?.album_artist || ''),
    year: album?.year ?? '',
    edition: String(album?.edition || ''),
    preview_only: Boolean(album?.preview_only),
    track_count_preview: Number(album?.track_count_preview || 0),
    total_duration_seconds: Number(album?.total_duration_seconds || 0),
    total_duration_display: String(album?.total_duration_display || ''),
    cover_path: String(album?.cover_path || ''),
    cover_revision: String(album?.cover_revision || ''),
    remote_cover_url: String(album?.remote_cover_url || ''),
    remote_cover_thumbnail_url: String(album?.remote_cover_thumbnail_url || ''),
  }));
  const localCoverPath = escapeHtml(String(album?.cover_path || '').trim());
  const remoteCoverUrl = escapeHtml(String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim());
  const cardIdentity = escapeHtml(getAlbumCardNodeIdentity(album));
  const cardRenderKey = escapeHtml(getAlbumCardRenderKey(album));
  return `
    <section class="album-card" data-gallery-card-key="${cardIdentity}" data-gallery-card-render-key="${cardRenderKey}">
      <button class="cover album-open-trigger" type="button" data-open-tracklist="1" data-album-key="${albumKey}" data-album-version-key="${albumVersionKey}" data-album="${albumFallback}" aria-label="Open ${escapeHtml(album.name)} tracklist">
        ${albumHasDisplayCover(album)
          ? buildAlbumCardCoverHtml(album, {
            coverPriority: options.coverPriority,
            localCoverPath,
            remoteCoverUrl,
          })
          : '<div class="cover-placeholder">No cover art</div>'}
      </button>
      <div class="album-body">
        <h3 class="album-title"><button class="album-open-trigger album-title-button" type="button" data-open-tracklist="1" data-album-key="${albumKey}" data-album-version-key="${albumVersionKey}" data-album="${albumFallback}">${escapeHtml(album.name)}</button></h3>
        <div class="album-meta-row">
          <div class="album-subtitle">${escapeHtml(album.album_artist)}</div>
          ${year}
        </div>
        ${ratingMarkup}
        <div class="chip-row">
          <span class="track-count">${summary.trackCount} track${summary.trackCount === 1 ? '' : 's'}</span>
          ${length}
        </div>
      </div>
    </section>
  `;
}

function getAlbumCardRating(album) {
  const rating = album?.album_preference?.rating;
  return Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : null;
}

function getAlbumCardRenderKey(album) {
  const summary = getAlbumCardSummary(album);
  return JSON.stringify([
    getAlbumCardNodeIdentity(album),
    getAlbumCardVersionKey(album),
    String(album?.name || ''),
    String(album?.album_artist || ''),
    String(album?.year || ''),
    getAlbumCardRating(album),
    Number(summary.trackCount || 0),
    String(summary.lengthDisplay || ''),
    albumHasDisplayCover(album) ? buildAlbumDisplayCoverUrl(album) : '',
    String(album?.cover_path || '').trim(),
    String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim(),
  ]);
}

function getAlbumCardNodeIdentity(album) {
  return getAlbumRequestKey(album) || getAlbumIdentity(album);
}

function getAlbumCardSummary(album) {
  const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
  const previewTrackCount = Number(album?.track_count_preview || 0);
  const totalTrackCount = album?.preview_only === true
    ? Math.max(tracks.length, previewTrackCount)
    : (tracks.length || previewTrackCount);
  const totalSeconds = Number(album?.total_duration_seconds || 0);
  const totalLengthDisplay = album?.total_duration_display || formatAlbumDuration(totalSeconds);
  if (album?.preview_only === true || !tracks.length || typeof groupAlbumTracks !== 'function') {
    return {
      trackCount: totalTrackCount,
      lengthDisplay: totalLengthDisplay,
    };
  }
  const grouped = groupAlbumTracks(tracks);
  const groups = Array.isArray(grouped?.groups) ? grouped.groups : [];
  const mainGroups = groups.filter((group) => !group?.isBonus);
  const bonusGroups = groups.filter((group) => Boolean(group?.isBonus));
  if (!bonusGroups.length || !mainGroups.length) {
    return {
      trackCount: totalTrackCount,
      lengthDisplay: totalLengthDisplay,
    };
  }
  const trackCount = mainGroups.reduce((sum, group) => sum + ((Array.isArray(group?.tracks) ? group.tracks.length : 0)), 0);
  const seconds = mainGroups.reduce(
    (sum, group) => sum + (Array.isArray(group?.tracks)
      ? group.tracks.reduce((inner, track) => inner + (Number(track?.duration_seconds || 0) || 0), 0)
      : 0),
    0,
  );
  return {
    trackCount: trackCount || totalTrackCount,
    lengthDisplay: formatAlbumDuration(seconds) || totalLengthDisplay,
  };
}

function buildAlbumCardCoverHtml(album, options = {}) {
  if (!albumHasDisplayCover(album)) {
    return '<div class="cover-placeholder">No cover art</div>';
  }
  const coverPriority = options.coverPriority === 'visible' ? 'visible' : 'near';
  const loadingAttribute = coverPriority === 'visible' ? 'eager' : 'lazy';
  const fetchPriorityAttribute = coverPriority === 'visible' ? 'high' : 'low';
  const coverSrc = buildAlbumDisplayCoverUrl(album);
  const localCoverPath = typeof options.localCoverPath === 'string'
    ? options.localCoverPath
    : escapeHtml(String(album?.cover_path || '').trim());
  const remoteCoverUrl = typeof options.remoteCoverUrl === 'string'
    ? options.remoteCoverUrl
    : escapeHtml(String(album?.remote_cover_thumbnail_url || album?.remote_cover_url || '').trim());
  const coverAlt = escapeHtml(`Album cover for ${album.name}`);
  return `<img loading="${loadingAttribute}" fetchpriority="${fetchPriorityAttribute}" decoding="async" data-gallery-cover-priority="${coverPriority}" data-gallery-cover-src="${coverSrc}" data-production-cover-src="${coverSrc}" data-cover-visual-state="pending" aria-hidden="true" alt="${coverAlt}" data-cover-path="${localCoverPath}" data-remote-cover-url="${remoteCoverUrl}" onload="handleAlbumDisplayCoverImageLoad(this)" onerror="handleAlbumDisplayCoverImageError(this)">`;
}

function refreshRenderedAlbumCoverOnly(updatedAlbum) {
  if (!updatedAlbum) return;
  const updatedSignature = getAlbumIdentity(updatedAlbum);
  const updatedRequestKey = getAlbumRequestKey(updatedAlbum);
  if (!updatedSignature && !updatedRequestKey) return;
  document.querySelectorAll('.album-card').forEach((card) => {
    const trigger = card.querySelector('[data-open-tracklist="1"][data-album-key]');
    if (!(trigger instanceof HTMLElement)) return;
    const triggerAlbumKey = String(trigger.getAttribute('data-album-key') || '').trim();
    if (triggerAlbumKey !== updatedRequestKey && triggerAlbumKey !== updatedSignature) return;
    if (updatedSignature) {
      state.gallery.albumIndex.set(updatedSignature, updatedAlbum);
    }
    if (updatedRequestKey) {
      state.gallery.albumIndex.set(updatedRequestKey, updatedAlbum);
    }
    card.querySelectorAll('[data-album-key]').forEach((element) => {
      element.setAttribute('data-album-key', updatedRequestKey || updatedSignature);
    });
    const coverButton = card.querySelector('.cover.album-open-trigger');
    if (coverButton) {
      const previousImage = coverButton.querySelector('img[data-production-cover-src]');
      const previousProductionUrl = String(previousImage?.getAttribute('data-production-cover-src') || '').trim();
      if (
        previousProductionUrl
        && typeof galleryCoverPreviewCache !== 'undefined'
        && typeof galleryCoverPreviewCache.invalidate === 'function'
      ) {
        galleryCoverPreviewCache.invalidate(previousProductionUrl);
      }
      coverButton.innerHTML = buildAlbumCardCoverHtml(updatedAlbum);
      if (
        typeof virtualGrid !== 'undefined'
        && typeof virtualGrid.activateGalleryCoverImages === 'function'
      ) {
        virtualGrid.activateGalleryCoverImages(coverButton);
      }
    }
  });
}

function getAlbumRequestKey(album) {
  return String(album?.key || album?.album_ref || '').trim() || getAlbumPathSignature(album);
}

function getAlbumIdentity(album) {
  return getAlbumPathSignature(album) || getAlbumRequestKey(album);
}

function rebuildAlbumIndex(groupsList) {
  const nextIndex = new Map();
  (Array.isArray(groupsList) ? groupsList : []).forEach((group) => {
    (Array.isArray(group?.albums) ? group.albums : []).forEach((album) => {
      const key = getAlbumIdentity(album);
      const requestKey = getAlbumRequestKey(album);
      const versionKey = getAlbumCardVersionKey(album);
      if (key) nextIndex.set(key, album);
      if (requestKey) nextIndex.set(requestKey, album);
      if (versionKey) nextIndex.set(versionKey, album);
    });
  });
  state.gallery.albumIndex = nextIndex;
}

function getIndexedAlbum(albumKey) {
  return state.gallery.albumIndex.get(String(albumKey || '').trim()) || null;
}

var CARD_GALLERY_LAYOUT_CONFIG = Object.freeze({
  mode: 'cards',
  cardMinWidth: 240,
  measuredItemSelector: '.album-card',
  renderAlbumHtml: albumCardHtml,
});

const DEFAULT_GALLERY_SCALE_PERCENT = 100;
const MIN_GALLERY_SCALE_PERCENT = 80;
const MAX_GALLERY_SCALE_PERCENT = 140;

function resolveGalleryScalePercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return DEFAULT_GALLERY_SCALE_PERCENT;
  return Math.min(MAX_GALLERY_SCALE_PERCENT, Math.max(MIN_GALLERY_SCALE_PERCENT, numericValue));
}

function resolveGalleryCardWidth(layoutConfig = CARD_GALLERY_LAYOUT_CONFIG) {
  const baseWidth = Math.max(1, Number(layoutConfig?.cardMinWidth) || 240);
  const scalePercent = resolveGalleryScalePercent(state?.view?.gallery_scale_percent);
  return Math.max(1, Math.round(baseWidth * (scalePercent / 100)));
}

function buildAlbumRowGridTemplate(columns, cardTrackWidth) {
  const safeColumns = Math.max(1, Math.floor(Number(columns) || 1));
  const safeTrackWidth = Math.max(1, Math.round(Number(cardTrackWidth) || 1));
  return `repeat(${safeColumns}, minmax(0, ${safeTrackWidth}px))`;
}

const MAX_PRIORITY_VISIBLE_COVER_IMAGES = 4;
const MAX_RETAINED_ALBUM_CARD_NODES = 48;
const MAX_VIRTUAL_GRID_DIAGNOSTIC_EVENTS = 24;
const VIRTUAL_GRID_SCROLL_RENDER_FALLBACK_MS = 100;

class VirtualArtistGrid {
  constructor() {
    this.scrollEl = document.getElementById('albums-scroll');
    this.containerEl = document.getElementById('artist-groups');
    this.topSpacerEl = document.getElementById('albums-spacer-top');
    this.bottomSpacerEl = document.getElementById('albums-spacer-bottom');
    this.layoutConfig = CARD_GALLERY_LAYOUT_CONFIG;
    this.columnGap = 14;
    this.rowGap = 14;
    this.sectionHeaderHeight = 54;
    this.sectionMarginBottom = 28;
    this.labelHeight = 40;
    this.subsectionLabelHeight = 26;
    this.collapsedRowHeight = 420;
    this.trackLineHeight = 28;
    this.expandedRowBaseExtra = 30;
    this.expandedTrackCap = 12;
    this.overscanPx = 320;
    this.bufferSections = 1;
    this.bufferSectionsOverride = null;
    this.sections = [];
    this.albumCardNodeCache = new Map();
    this.sectionByKey = new Map();
    this.columns = 1;
    this.cardTrackWidth = CARD_GALLERY_LAYOUT_CONFIG.cardMinWidth;
    this.lastKey = '';
    this._raf = null;
    this._scrollRenderFallbackTimer = 0;
    this._measureRaf = null;
    this._scrollRestoreRaf = null;
    this._stabilizeRaf = null;
    this._stabilizeGeneration = 0;
    this._pendingStabilizationScroll = null;
    this._absoluteScrollRestore = null;
    this._activeRenderRafOwner = 0;
    this._activeMeasureRafOwner = 0;
    this._renderGeneration = 0;
    this._preserveExistingChildrenGeneration = -1;
    this._coverLoadGeneration = 0;
    this._familyPrefetchScheduledCoverLoadGeneration = -1;
    this._selectedFamilyCoverUrls = new Set();
    this._selectedFamilyCoverOwner = '';
    this._nextCoverLoadUserActionToken = 0;
    this._activeCoverLoadUserActionTokens = new Set();
    this._activeAlbumCardPointerId = null;
    this._albumCardPointerGestureActive = false;
    this._albumCardPointerReleaseRaf = 0;
    this._deferredPointerGestureRender = null;
    this._measureTimeout = 0;
    this._resetScrollAfterMeasure = false;
    this.isScrollSettled = true;
    this._diagnosticSequence = 0;
    this.diagnostics = {
      maxEvents: MAX_VIRTUAL_GRID_DIAGNOSTIC_EVENTS,
      events: [],
      latestScroll: null,
      latestRender: null,
      latestMeasurement: null,
    };
    globalThis.__ALBUM_HAVEN_VIRTUAL_GRID__ = this.diagnostics;
    this.onScroll = this.onScroll.bind(this);
    this.onUserScrollIntent = this.onUserScrollIntent.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onAlbumCardPointerGestureEnd = this.onAlbumCardPointerGestureEnd.bind(this);
    this.scrollEl.addEventListener('scroll', this.onScroll, { passive: true });
    this.scrollEl.addEventListener('wheel', this.onUserScrollIntent, { passive: true });
    this.scrollEl.addEventListener('touchstart', this.onUserScrollIntent, { passive: true });
    this.scrollEl.addEventListener('pointerdown', this.onUserScrollIntent, { capture: true });
    if (this.containerEl && typeof this.containerEl.addEventListener === 'function') {
      this.containerEl.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('pointerup', this.onAlbumCardPointerGestureEnd, { capture: true });
      document.addEventListener('pointercancel', this.onAlbumCardPointerGestureEnd, { capture: true });
    }
    window.addEventListener('resize', this.onResize);
  }

  recordDiagnosticEvent(type, details = {}) {
    const event = {
      sequence: ++this._diagnosticSequence,
      type: String(type || 'unknown'),
      renderGeneration: Number(this._renderGeneration || 0),
      scrollTop: Number(this.scrollEl?.scrollTop || 0),
      renderRafOwner: Number(this._activeRenderRafOwner || this._raf || 0),
      measureRafOwner: Number(this._activeMeasureRafOwner || this._measureRaf || 0),
      ...details,
    };
    this.diagnostics.events.push(event);
    if (this.diagnostics.events.length > this.diagnostics.maxEvents) {
      this.diagnostics.events.splice(0, this.diagnostics.events.length - this.diagnostics.maxEvents);
    }
    return event;
  }

  getLayoutConfig(layoutConfig = null) {
    if (layoutConfig && typeof layoutConfig === 'object') {
      return layoutConfig;
    }
    if (this.layoutConfig && typeof this.layoutConfig === 'object') {
      return this.layoutConfig;
    }
    return CARD_GALLERY_LAYOUT_CONFIG;
  }

  setLayoutConfig(layoutConfig = null) {
    this.layoutConfig = this.getLayoutConfig(layoutConfig);
  }

  destroy() {
    this._renderGeneration += 1;
    this.scrollEl.removeEventListener('scroll', this.onScroll);
    this.scrollEl.removeEventListener('wheel', this.onUserScrollIntent);
    this.scrollEl.removeEventListener('touchstart', this.onUserScrollIntent);
    this.scrollEl.removeEventListener('pointerdown', this.onUserScrollIntent, { capture: true });
    if (this.containerEl && typeof this.containerEl.removeEventListener === 'function') {
      this.containerEl.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('pointerup', this.onAlbumCardPointerGestureEnd, { capture: true });
      document.removeEventListener('pointercancel', this.onAlbumCardPointerGestureEnd, { capture: true });
    }
    window.removeEventListener('resize', this.onResize);
    if (this._scrollRestoreRaf) {
      cancelBrowserAnimationFrame(this._scrollRestoreRaf);
      this._scrollRestoreRaf = null;
    }
    this.invalidateScrollStabilization();
    if (this._raf) {
      cancelBrowserAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this._scrollRenderFallbackTimer) {
      clearBrowserTimeout(this._scrollRenderFallbackTimer);
      this._scrollRenderFallbackTimer = 0;
    }
    if (this._albumCardPointerReleaseRaf) {
      cancelBrowserAnimationFrame(this._albumCardPointerReleaseRaf);
      this._albumCardPointerReleaseRaf = 0;
    }
    this._albumCardPointerGestureActive = false;
    this._activeAlbumCardPointerId = null;
    this._deferredPointerGestureRender = null;
    if (this._measureRaf) {
      cancelBrowserAnimationFrame(this._measureRaf);
      this._measureRaf = null;
    }
    if (this._measureTimeout) {
      clearBrowserTimeout(this._measureTimeout);
      this._measureTimeout = 0;
    }
    this.resumeSelectedArtistCoverLoadsAfterUserAction(0, { force: true });
    this.albumCardNodeCache.clear();
    if (typeof galleryCoverPreviewCache !== 'undefined' && typeof galleryCoverPreviewCache.destroy === 'function') {
      galleryCoverPreviewCache.destroy();
    }
  }

  onPointerDown(event) {
    const target = event?.target;
    const closest = typeof target?.closest === 'function'
      ? target.closest('[data-open-tracklist="1"][data-album-key], .album-card')
      : null;
    if (!closest) return;
    if (this._albumCardPointerReleaseRaf) {
      cancelBrowserAnimationFrame(this._albumCardPointerReleaseRaf);
      this._albumCardPointerReleaseRaf = 0;
    }
    this._albumCardPointerGestureActive = true;
    this._activeAlbumCardPointerId = Number.isFinite(Number(event?.pointerId))
      ? Number(event.pointerId)
      : null;
  }

  onAlbumCardPointerGestureEnd(event) {
    if (!this._albumCardPointerGestureActive) return;
    const pointerId = Number.isFinite(Number(event?.pointerId)) ? Number(event.pointerId) : null;
    if (
      this._activeAlbumCardPointerId !== null
      && pointerId !== null
      && pointerId !== this._activeAlbumCardPointerId
    ) {
      return;
    }
    this._albumCardPointerGestureActive = false;
    this._activeAlbumCardPointerId = null;
    if (this._albumCardPointerReleaseRaf) return;
    this._albumCardPointerReleaseRaf = scheduleBrowserAnimationFrame(() => {
      this._albumCardPointerReleaseRaf = 0;
      if (this._albumCardPointerGestureActive) return;
      const deferredRender = this._deferredPointerGestureRender;
      this._deferredPointerGestureRender = null;
      if (!deferredRender) return;
      const previousActiveRenderRafOwner = this._activeRenderRafOwner;
      try {
        this._activeRenderRafOwner = Number(deferredRender.renderRafOwner || 0);
        this.render(deferredRender.force, deferredRender.options);
      } finally {
        this._activeRenderRafOwner = previousActiveRenderRafOwner;
      }
    });
  }

  suspendSelectedArtistCoverLoadsForUserAction() {
    if (typeof galleryCoverLoadScheduler === 'undefined') return 0;
    this._nextCoverLoadUserActionToken += 1;
    const token = this._nextCoverLoadUserActionToken;
    const shouldSuspendScheduler = this._activeCoverLoadUserActionTokens.size === 0;
    this._activeCoverLoadUserActionTokens.add(token);
    if (shouldSuspendScheduler) {
      galleryCoverLoadScheduler.suspend?.('utility-modal-preemption');
    }
    return token;
  }

  resumeSelectedArtistCoverLoadsAfterUserAction(token = 0, options = {}) {
    const force = options?.force === true;
    const normalizedToken = Number(token);
    if (!force && (!normalizedToken || !this._activeCoverLoadUserActionTokens.has(normalizedToken))) {
      return false;
    }
    if (!this._activeCoverLoadUserActionTokens.size) return false;
    if (force) {
      this._activeCoverLoadUserActionTokens.clear();
    } else {
      this._activeCoverLoadUserActionTokens.delete(normalizedToken);
    }
    if (this._activeCoverLoadUserActionTokens.size) return true;
    if (
      typeof galleryCoverLoadScheduler !== 'undefined'
      && typeof galleryCoverLoadScheduler.resume === 'function'
    ) {
      galleryCoverLoadScheduler.resume();
    }
    return true;
  }

  captureScrollAnchor() {
    if (!this.scrollEl || !this.containerEl) return null;
    const scrollLeft = Number(this.scrollEl.scrollLeft || 0);
    const scrollTop = Number(this.scrollEl.scrollTop || 0);
    const scrollRect = typeof this.scrollEl.getBoundingClientRect === 'function'
      ? this.scrollEl.getBoundingClientRect()
      : null;
    if (!scrollRect) {
      return { scrollLeft, scrollTop };
    }
    const cardTriggers = Array.from(this.containerEl.querySelectorAll('[data-open-tracklist="1"][data-album-key]'));
    const anchorCardTrigger = cardTriggers.find((element) => element.getBoundingClientRect().bottom >= scrollRect.top + 1) || cardTriggers[0] || null;
    if (anchorCardTrigger instanceof HTMLElement) {
      const anchorRect = anchorCardTrigger.getBoundingClientRect();
      let albumName = '';
      let albumYear = '';
      try {
        const album = JSON.parse(anchorCardTrigger.getAttribute('data-album') || '{}');
        albumName = String(album?.name || '');
        albumYear = String(album?.year ?? '');
      } catch (_error) {
        albumName = '';
        albumYear = '';
      }
      return {
        scrollLeft,
        scrollTop,
        albumKey: String(anchorCardTrigger.getAttribute('data-album-key') || ''),
        albumName,
        albumYear,
        sectionOccurrenceKey: this.getRenderedSectionOccurrenceKey(anchorCardTrigger, this.containerEl),
        offsetTop: anchorRect.top - scrollRect.top,
      };
    }
    const rows = Array.from(this.containerEl.querySelectorAll('.album-row[data-section-key][data-block-index]'));
    const anchorRow = rows.find((rowEl) => rowEl.getBoundingClientRect().bottom >= scrollRect.top + 1) || rows[0] || null;
    if (!(anchorRow instanceof HTMLElement)) {
      return { scrollLeft, scrollTop };
    }
    const anchorRect = anchorRow.getBoundingClientRect();
    return {
      scrollLeft,
      scrollTop,
      sectionKey: String(anchorRow.getAttribute('data-section-key') || ''),
      blockIndex: String(anchorRow.getAttribute('data-block-index') || ''),
      offsetTop: anchorRect.top - scrollRect.top,
    };
  }

  restoreScrollAnchor(anchor) {
    if (!this.scrollEl || !anchor) return;
    this.scrollEl.scrollLeft = Number(anchor.scrollLeft || 0);
    const albumKey = String(anchor.albumKey || '');
    if (albumKey) {
      const sectionOccurrenceKey = String(anchor.sectionOccurrenceKey || '');
      const albumTriggers = Array.from(
        this.containerEl.querySelectorAll('[data-open-tracklist="1"][data-album-key]'),
      );
      const matchingAlbumTriggers = albumTriggers.filter((element) => (
        String(element.getAttribute('data-album-key') || '') === albumKey
      ));
      const anchorAlbumName = String(anchor.albumName || '');
      const anchorAlbumYear = String(anchor.albumYear ?? '');
      const matchesCapturedRelease = (element) => {
        if (!anchorAlbumName) return true;
        try {
          const album = JSON.parse(element.getAttribute('data-album') || '{}');
          return String(album?.name || '') === anchorAlbumName
            && (!anchorAlbumYear || String(album?.year ?? '') === anchorAlbumYear);
        } catch (_error) {
          return false;
        }
      };
      const anchorCardTrigger = (
        sectionOccurrenceKey
          ? matchingAlbumTriggers.find((element) => (
            this.getRenderedSectionOccurrenceKey(element, this.containerEl) === sectionOccurrenceKey
            && matchesCapturedRelease(element)
          ))
          : null
      );
      const capturedOccurrenceStillExists = Boolean(sectionOccurrenceKey) && this.sections.some((section) => (
        this.getRenderedSectionKey(section) === sectionOccurrenceKey
      ));
      const fallbackAlbumTrigger = !sectionOccurrenceKey || !capturedOccurrenceStillExists
        ? matchingAlbumTriggers[0] || null
        : null;
      const renamedKeyTrigger = !anchorCardTrigger && anchorAlbumName
        ? albumTriggers.find((element) => {
          if (this.getRenderedSectionOccurrenceKey(element, this.containerEl) !== sectionOccurrenceKey) {
            return false;
          }
          return matchesCapturedRelease(element);
        }) || null
        : null;
      const resolvedAnchorCardTrigger = anchorCardTrigger || renamedKeyTrigger || fallbackAlbumTrigger;
      if (resolvedAnchorCardTrigger instanceof HTMLElement && typeof this.scrollEl.getBoundingClientRect === 'function') {
        const scrollRect = this.scrollEl.getBoundingClientRect();
        const anchorRect = resolvedAnchorCardTrigger.getBoundingClientRect();
        const delta = (anchorRect.top - scrollRect.top) - Number(anchor.offsetTop || 0);
        this.scrollEl.scrollTop = Number(this.scrollEl.scrollTop || 0) + delta;
        return;
      }
      if (sectionOccurrenceKey && anchorAlbumName) {
        const modeledSection = this.sections.find((section) => (
          section.kind === 'artist'
          && this.getRenderedSectionKey(section) === sectionOccurrenceKey
        ));
        const modeledAlbums = Array.isArray(modeledSection?.group?.albums)
          ? modeledSection.group.albums
          : [];
        const modeledAlbumIndex = modeledAlbums.findIndex((album) => (
          String(album?.name || '') === anchorAlbumName
          && (!anchorAlbumYear || String(album?.year ?? '') === anchorAlbumYear)
        ));
        if (modeledAlbumIndex >= 0) {
          const blockIndex = Math.floor(modeledAlbumIndex / Math.max(1, Number(this.columns || 1)));
          const modeledBlockOffset = Number(modeledSection.blockOffsets?.[blockIndex]);
          const modeledSectionTop = Number(modeledSection.top);
          if (Number.isFinite(modeledBlockOffset) && Number.isFinite(modeledSectionTop)) {
            const modeledCardTop = modeledSectionTop + this.sectionHeaderHeight + modeledBlockOffset;
            this.scrollEl.scrollTop = Math.max(0, modeledCardTop - Number(anchor.offsetTop || 0));
            return;
          }
        }
      }
    }
    const sectionKey = String(anchor.sectionKey || '');
    const blockIndex = String(anchor.blockIndex || '');
    if (!sectionKey || !blockIndex) {
      this.scrollEl.scrollTop = Number(anchor.scrollTop || 0);
      return;
    }
    const anchorRow = Array.from(this.containerEl.querySelectorAll('.album-row[data-section-key][data-block-index]')).find((rowEl) => (
      String(rowEl.getAttribute('data-section-key') || '') === sectionKey
      && String(rowEl.getAttribute('data-block-index') || '') === blockIndex
    ));
    if (!(anchorRow instanceof HTMLElement) || typeof this.scrollEl.getBoundingClientRect !== 'function') {
      this.scrollEl.scrollTop = Number(anchor.scrollTop || 0);
      return;
    }
    const scrollRect = this.scrollEl.getBoundingClientRect();
    const anchorRect = anchorRow.getBoundingClientRect();
    const delta = (anchorRect.top - scrollRect.top) - Number(anchor.offsetTop || 0);
    this.scrollEl.scrollTop = Number(this.scrollEl.scrollTop || 0) + delta;
  }

  invalidateScrollStabilization(options = {}) {
    this._stabilizeGeneration += 1;
    this._pendingStabilizationScroll = null;
    if (this._stabilizeRaf) {
      cancelBrowserAnimationFrame(this._stabilizeRaf);
      this._stabilizeRaf = null;
    }
    if (options.preserveAbsoluteScroll === true || !this._absoluteScrollRestore) return;
    this._absoluteScrollRestore = null;
    if (!this._scrollRestoreRaf) return;
    cancelBrowserAnimationFrame(this._scrollRestoreRaf);
    this._scrollRestoreRaf = null;
  }

  isPendingStabilizationScroll() {
    const pending = this._pendingStabilizationScroll;
    return Boolean(
      pending
      && pending.generation === this._stabilizeGeneration
      && pending.scrollTop === Number(this.scrollEl?.scrollTop || 0)
      && pending.scrollLeft === Number(this.scrollEl?.scrollLeft || 0)
    );
  }

  restoreOwnedAbsoluteScrollPosition(position) {
    if (
      !this.scrollEl
      || !Number.isFinite(Number(position?.scrollTop))
      || !Number.isFinite(Number(position?.scrollLeft))
    ) return false;
    this.invalidateScrollStabilization();
    const preservedAbsoluteScroll = {
      renderGeneration: this._renderGeneration,
      scrollLeft: Math.max(0, Number(position.scrollLeft)),
      scrollTop: Math.max(0, Number(position.scrollTop)),
    };
    this._absoluteScrollRestore = preservedAbsoluteScroll;
    const restoreScroll = () => {
      if (this._absoluteScrollRestore !== preservedAbsoluteScroll) return;
      this.scrollEl.scrollLeft = preservedAbsoluteScroll.scrollLeft;
      this.scrollEl.scrollTop = preservedAbsoluteScroll.scrollTop;
      this._pendingStabilizationScroll = {
        generation: this._stabilizeGeneration,
        scrollLeft: preservedAbsoluteScroll.scrollLeft,
        scrollTop: preservedAbsoluteScroll.scrollTop,
      };
      this.primeVisibleCoverImages();
    };
    restoreScroll();
    this._scrollRestoreRaf = scheduleBrowserAnimationFrame(() => {
      this._scrollRestoreRaf = null;
      restoreScroll();
    });
    return true;
  }

  setGroups(primaryGroups, familyGroups, fallbackGroups = null, options = {}, layoutConfig = null) {
    const supersededScrollRenderRafOwner = Number(this._raf || 0);
    this._renderGeneration += 1;
    const renderGeneration = this._renderGeneration;
    this._preserveExistingChildrenGeneration = options.preserveMountedGalleryChildren
      ? renderGeneration
      : -1;
    if (typeof galleryCoverLoadScheduler !== 'undefined') {
      if (
        String(state?.view?.selected_artist || '').trim()
        && typeof galleryCoverLoadScheduler.ensureFamilyPrefetchReconciliation === 'function'
      ) {
        galleryCoverLoadScheduler.ensureFamilyPrefetchReconciliation();
      }
      this._coverLoadGeneration = galleryCoverLoadScheduler.startGeneration();
    }
    if (this._raf) {
      cancelBrowserAnimationFrame(this._raf);
      this._raf = null;
    }
    if (this._scrollRenderFallbackTimer) {
      clearBrowserTimeout(this._scrollRenderFallbackTimer);
      this._scrollRenderFallbackTimer = 0;
    }
    if (this._measureRaf) {
      cancelBrowserAnimationFrame(this._measureRaf);
      this._measureRaf = null;
    }
    if (this._scrollRestoreRaf) {
      cancelBrowserAnimationFrame(this._scrollRestoreRaf);
      this._scrollRestoreRaf = null;
    }
    this.invalidateScrollStabilization();
    if (this._measureTimeout) {
      clearBrowserTimeout(this._measureTimeout);
      this._measureTimeout = 0;
    }
    this.isScrollSettled = true;
    this.setLayoutConfig(layoutConfig);
    const preserveScroll = Boolean(options.preserveScroll)
      && options.resetScrollForUserArtistSelection !== true;
    this._resetScrollAfterMeasure = !preserveScroll;
    this.bufferSectionsOverride = !preserveScroll && Boolean(state.view?.selected_artist) ? 0 : null;
    const requestedAbsoluteScroll = options.absoluteScrollPosition
      && Number.isFinite(Number(options.absoluteScrollPosition.scrollTop))
      && Number.isFinite(Number(options.absoluteScrollPosition.scrollLeft))
      ? {
        scrollLeft: Math.max(0, Number(options.absoluteScrollPosition.scrollLeft)),
        scrollTop: Math.max(0, Number(options.absoluteScrollPosition.scrollTop)),
      }
      : null;
    const preservedAbsoluteScroll = preserveScroll && options.preserveAbsoluteScroll === true
      ? {
        renderGeneration,
        scrollLeft: requestedAbsoluteScroll?.scrollLeft ?? Number(this.scrollEl?.scrollLeft || 0),
        scrollTop: requestedAbsoluteScroll?.scrollTop ?? Number(this.scrollEl?.scrollTop || 0),
      }
      : null;
    const preservedAnchor = preserveScroll && !preservedAbsoluteScroll
      ? this.captureScrollAnchor()
      : null;
    this._absoluteScrollRestore = preservedAbsoluteScroll;
    const sections = [];
    const renderedPrimaryGroups = buildDisplayGroups(primaryGroups);
    const renderedFamilyGroups = buildDisplayGroups(familyGroups);
    const renderedFallbackGroups = buildDisplayGroups(fallbackGroups || state.view.artist_groups || []);
    const selectedFamilyCoverOwner = String(state?.view?.selected_artist || '').trim();
    if (selectedFamilyCoverOwner) {
      const selectedFamilyFilterActive = Boolean(state?.view?.primary_filter_active)
        || (Array.isArray(state?.view?.related_filter_artists)
          && state.view.related_filter_artists.length > 0);
      if (
        selectedFamilyCoverOwner !== this._selectedFamilyCoverOwner
        || !selectedFamilyFilterActive
      ) {
        this._selectedFamilyCoverUrls.clear();
        this._selectedFamilyCoverOwner = selectedFamilyCoverOwner;
      }
      [...renderedPrimaryGroups, ...renderedFamilyGroups].forEach((group) => {
        (Array.isArray(group?.albums) ? group.albums : []).forEach((album) => {
          const productionUrl = buildAlbumDisplayCoverUrl(album);
          if (productionUrl) this._selectedFamilyCoverUrls.add(productionUrl);
        });
      });
    } else {
      this._selectedFamilyCoverUrls.clear();
      this._selectedFamilyCoverOwner = '';
    }
    if (renderedPrimaryGroups.length) {
      sections.push({ kind: 'label', title: 'Primary Artist' });
      renderedPrimaryGroups.forEach((group) => sections.push({ kind: 'artist', group, sectionType: 'primary', sectionKey: '' }));
    }
    if (renderedFamilyGroups.length) {
      sections.push({ kind: 'label', title: 'Family' });
      renderedFamilyGroups.forEach((group) => sections.push({ kind: 'artist', group, sectionType: 'family', sectionKey: '' }));
    }
    if (!renderedPrimaryGroups.length && !renderedFamilyGroups.length) {
      renderedFallbackGroups.forEach((group) => sections.push({ kind: 'artist', group, sectionType: 'all', sectionKey: '' }));
    }
    const previousSectionsByMeasurementKey = new Map(
      this.sections
        .filter((section) => section.kind === 'artist' && section.measurementKey)
        .map((section) => [section.measurementKey, section]),
    );
    const measurementOccurrenceByArtist = new Map();
    sections.forEach((section) => {
      if (section.kind !== 'artist') return;
      const measurementArtistKey = `${section.sectionType}\u0000${String(
        section.group?.display_artist_key || section.group?.artist || '',
      )}`;
      const measurementOccurrence = Number(measurementOccurrenceByArtist.get(measurementArtistKey) || 0);
      measurementOccurrenceByArtist.set(measurementArtistKey, measurementOccurrence + 1);
      section.measurementKey = `${measurementArtistKey}\u0000${measurementOccurrence}`;
      section.sectionKey = `${section.sectionType}:${String(
        section.group?.display_artist_key || section.group?.artist || '',
      )}:${measurementOccurrence}`;
      const previousSection = previousSectionsByMeasurementKey.get(section.measurementKey);
      if (!previousSection) return;
      section.blockHeights = Array.isArray(previousSection.blockHeights)
        ? previousSection.blockHeights.slice()
        : [];
      section.blockMeasureKeys = Array.isArray(previousSection.blockMeasureKeys)
        ? previousSection.blockMeasureKeys.slice()
        : [];
      section.measuredBlockKeys = Array.isArray(previousSection.measuredBlockKeys)
        ? previousSection.measuredBlockKeys.slice()
        : [];
    });
    this.sections = sections;
    rebuildAlbumIndex(
      sections
        .filter((section) => section.kind === 'artist')
        .map((section) => section.group),
    );
    this.lastKey = '';
    this.recalculate();
    if (!preserveScroll && this.scrollEl) {
      this.scrollEl.scrollTop = 0;
    }
    if (preservedAbsoluteScroll && this.scrollEl) {
      this.scrollEl.scrollLeft = preservedAbsoluteScroll.scrollLeft;
      this.scrollEl.scrollTop = preservedAbsoluteScroll.scrollTop;
    }
    const previousActiveRenderRafOwner = this._activeRenderRafOwner;
    if (supersededScrollRenderRafOwner) {
      this._activeRenderRafOwner = supersededScrollRenderRafOwner;
      this.updateScrollDiagnostic(supersededScrollRenderRafOwner, true);
    }
    try {
      this.render(true, {
        preserveExistingChildren: Boolean(options.preserveMountedGalleryChildren),
      });
    } finally {
      this._activeRenderRafOwner = previousActiveRenderRafOwner;
    }
    const scheduleSettledScrollRestore = (restoreScroll) => {
      let scrollRestoreRafOwner = 0;
      scrollRestoreRafOwner = scheduleBrowserAnimationFrame(() => {
        if (
          this._scrollRestoreRaf !== scrollRestoreRafOwner
          || renderGeneration !== this._renderGeneration
        ) return;
        this._scrollRestoreRaf = null;
        restoreScroll();
        const latestRender = this.diagnostics.latestRender;
        if (
          Number(latestRender?.renderGeneration || 0) !== renderGeneration
          || Math.abs(
            Number(latestRender?.viewportTop || 0) - Number(this.scrollEl?.scrollTop || 0),
          ) > 2
        ) return;
        this.updateScrollDiagnostic(scrollRestoreRafOwner);
        this.diagnostics.latestRender = {
          ...latestRender,
          renderRafOwner: scrollRestoreRafOwner,
        };
        this.recordDiagnosticEvent('scroll-restore-settled', {
          renderGeneration,
          renderRafOwner: scrollRestoreRafOwner,
          scrollTop: Number(this.scrollEl?.scrollTop || 0),
        });
      });
      this._scrollRestoreRaf = scrollRestoreRafOwner;
    };
    if (!preserveScroll && this.scrollEl) {
      const resetScroll = () => {
        if (renderGeneration !== this._renderGeneration) return;
        this.scrollEl.scrollTop = 0;
        this.primeVisibleCoverImages();
      };
      resetScroll();
      scheduleSettledScrollRestore(resetScroll);
    } else if (preserveScroll && this.scrollEl) {
      const restoreScroll = () => {
        if (renderGeneration !== this._renderGeneration) return;
        if (preservedAbsoluteScroll) {
          if (this._absoluteScrollRestore !== preservedAbsoluteScroll) return;
          this.scrollEl.scrollLeft = preservedAbsoluteScroll.scrollLeft;
          this.scrollEl.scrollTop = preservedAbsoluteScroll.scrollTop;
          this._pendingStabilizationScroll = {
            generation: this._stabilizeGeneration,
            scrollLeft: preservedAbsoluteScroll.scrollLeft,
            scrollTop: preservedAbsoluteScroll.scrollTop,
          };
        } else {
          this.restoreScrollAnchor(preservedAnchor);
        }
        this.primeVisibleCoverImages();
      };
      restoreScroll();
      scheduleSettledScrollRestore(restoreScroll);
    }
  }

  getRowsForSection(section) {
    const albums = Array.isArray(section.group?.albums) ? section.group.albums : [];
    const rows = [];
    for (let start = 0; start < albums.length; start += this.columns) {
      rows.push(albums.slice(start, start + this.columns));
    }
    return rows;
  }

  getBlocksForSection(section) {
    const blocks = [];
    const normalRows = this.getRowsForSection(section);
    normalRows.forEach((albums) => blocks.push({ kind: 'row', albums }));
    return blocks.length ? blocks : [];
  }

  getBlockMeasureKey(block) {
    if (!block || block.kind !== 'row') {
      return `static:${block?.kind || 'unknown'}:${block?.title || ''}`;
    }
    const albumKey = Array.isArray(block.albums)
      ? block.albums.map((album) => getAlbumIdentity(album)).join('|')
      : '';
    return `row:${this.columns}:${albumKey}`;
  }

  recalculate() {
    const layoutConfig = this.getLayoutConfig();
    const selectedCardWidth = resolveGalleryCardWidth(layoutConfig);
    const width = Math.max(1, this.scrollEl.clientWidth - 8);
    this.cardTrackWidth = Math.min(selectedCardWidth, width);
    this.columns = Math.max(1, Math.floor((width + this.columnGap) / (selectedCardWidth + this.columnGap)));
    let offsetTop = 0;
    this.sectionByKey = new Map();
    this.sections.forEach((section) => {
      section.top = offsetTop;
      if (section.kind === 'label') {
        section.height = this.labelHeight;
        offsetTop += section.height;
        section.bottom = offsetTop;
        return;
      }

      const blocks = this.getBlocksForSection(section);
      const previousMeasureKeys = Array.isArray(section.blockMeasureKeys) ? section.blockMeasureKeys : [];
      const previousMeasuredKeys = Array.isArray(section.measuredBlockKeys) ? section.measuredBlockKeys : [];
      const nextMeasureKeys = blocks.map((block) => this.getBlockMeasureKey(block));
      section.blocksData = blocks;
      if (!Array.isArray(section.blockHeights) || section.blockHeights.length !== blocks.length) {
        const previousBlockHeights = Array.isArray(section.blockHeights)
          ? section.blockHeights
          : [];
        section.blockHeights = blocks.map((block, index) => {
          if (block.kind === 'subheading') return this.subsectionLabelHeight;
          const previousHeight = Number(previousBlockHeights[index] || 0);
          return previousHeight > 0 ? previousHeight : this.collapsedRowHeight;
        });
      } else {
        section.blockHeights = blocks.map((block, index) => (
          block.kind === 'subheading'
            ? this.subsectionLabelHeight
            : (section.blockHeights[index] || this.collapsedRowHeight)
        ));
      }
      section.blockMeasureKeys = nextMeasureKeys;
      section.measuredBlockKeys = nextMeasureKeys.map((key, index) => (
        previousMeasureKeys[index] === key ? String(previousMeasuredKeys[index] || '') : ''
      ));
      let blockOffset = 0;
      section.blockOffsets = blocks.map((_block, index) => {
        const top = blockOffset;
        blockOffset += section.blockHeights[index] || 0;
        if (index < blocks.length - 1) blockOffset += this.rowGap;
        return top;
      });
      section.blocksHeight = blockOffset;
      section.height = this.sectionHeaderHeight + section.blocksHeight + this.sectionMarginBottom;
      offsetTop += section.height;
      section.bottom = offsetTop;
      this.sectionByKey.set(section.sectionKey, section);
    });
    this.totalHeight = offsetTop;
  }

  updateScrollDiagnostic(renderRafOwner, coalesced = false) {
    const current = this.diagnostics.latestScroll;
    const shouldReuseCurrent = coalesced
      && current
      && Number(current.renderRafOwner || 0) === Number(renderRafOwner || 0);
    const event = shouldReuseCurrent
      ? current
      : this.recordDiagnosticEvent('scroll-event');
    event.renderGeneration = Number(this._renderGeneration || 0);
    event.scrollTop = Number(this.scrollEl?.scrollTop || 0);
    event.renderRafOwner = Number(renderRafOwner || 0);
    event.clientHeight = Number(this.scrollEl?.clientHeight || 0);
    event.pendingRenderRafOwner = Number(renderRafOwner || 0);
    event.pendingMeasureRafOwner = Number(this._measureRaf || 0);
    event.pendingMeasureTimeout = Number(this._measureTimeout || 0);
    event.coalescedScrollCount = shouldReuseCurrent
      ? Number(event.coalescedScrollCount || 0) + 1
      : 0;
    this.diagnostics.latestScroll = event;
  }

  onScroll() {
    const ownsPendingAbsoluteRestore = Boolean(
      this._absoluteScrollRestore,
    );
    const isOwnedStabilizationScroll = this.isPendingStabilizationScroll();
    if (!isOwnedStabilizationScroll && ownsPendingAbsoluteRestore) {
      this.scrollEl.scrollLeft = this._absoluteScrollRestore.scrollLeft;
      this.scrollEl.scrollTop = this._absoluteScrollRestore.scrollTop;
      this._pendingStabilizationScroll = {
        generation: this._stabilizeGeneration,
        scrollLeft: this._absoluteScrollRestore.scrollLeft,
        scrollTop: this._absoluteScrollRestore.scrollTop,
      };
    } else if (!isOwnedStabilizationScroll) {
      this.invalidateScrollStabilization();
    }
    this.isScrollSettled = false;
    if (this._measureTimeout) {
      clearBrowserTimeout(this._measureTimeout);
    }
    this._measureTimeout = scheduleBrowserTimeout(() => {
      this._measureTimeout = 0;
      this.isScrollSettled = true;
      this.scheduleMeasureRows(true);
    }, 96);
    if (this._raf) {
      this.updateScrollDiagnostic(this._raf, true);
      return;
    }
    let renderRafOwner = 0;
    const completeScrollRender = () => {
      if (this._raf !== renderRafOwner) return false;
      if (this._scrollRenderFallbackTimer) {
        clearBrowserTimeout(this._scrollRenderFallbackTimer);
        this._scrollRenderFallbackTimer = 0;
      }
      this._activeRenderRafOwner = renderRafOwner;
      this._raf = null;
      this.recordDiagnosticEvent('render-frame-started', { renderRafOwner });
      this.render();
      this._activeRenderRafOwner = 0;
      return true;
    };
    renderRafOwner = scheduleBrowserAnimationFrame(completeScrollRender);
    this._raf = renderRafOwner;
    this._scrollRenderFallbackTimer = scheduleBrowserTimeout(() => {
      this._scrollRenderFallbackTimer = 0;
      if (this._raf !== renderRafOwner) return;
      cancelBrowserAnimationFrame(renderRafOwner);
      this.recordDiagnosticEvent('scroll-render-fallback', { renderRafOwner });
      completeScrollRender();
    }, VIRTUAL_GRID_SCROLL_RENDER_FALLBACK_MS);
    this.updateScrollDiagnostic(renderRafOwner);
  }

  onUserScrollIntent() {
    this.invalidateScrollStabilization();
  }

  onResize() {
    this.lastKey = '';
    this.recalculate();
    this.render(true);
    this.scheduleMeasureRows(true);
  }

  render(force = false, options = {}) {
    if (this._albumCardPointerGestureActive || this._albumCardPointerReleaseRaf) {
      this._deferredPointerGestureRender = {
        force: Boolean(force),
        options: { ...options },
        renderRafOwner: Number(
          this._activeRenderRafOwner
          || this._deferredPointerGestureRender?.renderRafOwner
          || 0,
        ),
      };
      return;
    }
    const viewportTop = this.scrollEl.scrollTop;
    const latestScroll = this.diagnostics.latestScroll;
    const settledScrollRenderRafOwner = (
      Number(latestScroll?.renderGeneration || 0) === Number(this._renderGeneration || 0)
      && Math.abs(Number(latestScroll?.scrollTop || 0) - Number(viewportTop || 0)) <= 2
    )
      ? Number(latestScroll?.renderRafOwner || 0)
      : 0;
    const renderRafOwner = Number(
      this._activeRenderRafOwner || settledScrollRenderRafOwner || 0,
    );
    const viewportBottom = viewportTop + this.scrollEl.clientHeight;
    const start = Math.max(0, viewportTop - this.overscanPx);
    const end = viewportBottom + this.overscanPx;
    const configuredBufferSections = Number.isInteger(this.bufferSectionsOverride)
      ? this.bufferSectionsOverride
      : this.bufferSections;
    const effectiveBufferSections = String(state?.view?.selected_artist || '').trim()
      ? Math.max(3, configuredBufferSections)
      : configuredBufferSections;
    let firstIndex = this.sections.findIndex((section) => section.bottom >= start);
    if (firstIndex === -1) firstIndex = 0;
    let lastIndex = this.sections.length - 1;
    for (let i = firstIndex; i < this.sections.length; i += 1) {
      if (this.sections[i].top > end) {
        lastIndex = Math.max(firstIndex, i - 1);
        break;
      }
    }

    firstIndex = Math.max(0, firstIndex - effectiveBufferSections);
    lastIndex = Math.min(this.sections.length - 1, lastIndex + effectiveBufferSections);

    const visible = this.sections.slice(firstIndex, lastIndex + 1);
    const visibleRanges = visible
      .map((section) => {
        const range = this.getVisibleBlockRange(section, start, end);
        return range ? `${section.sectionKey}:${range.firstIndex}:${range.lastIndex}` : `${section.sectionKey}:label`;
      })
      .join('|');
    const rangeKey = `${firstIndex}:${lastIndex}:${this.columns}:${this.totalHeight}:${visibleRanges}`;
    if (!force && rangeKey === this.lastKey) {
      const skippedRender = {
        bottomSpacerHeight: Number.parseFloat(this.bottomSpacerEl?.style?.height || '0') || 0,
        end,
        firstIndex,
        force: false,
        lastIndex,
        rangeKey,
        renderGeneration: Number(this._renderGeneration || 0),
        renderRafOwner,
        start,
        topSpacerHeight: Number.parseFloat(this.topSpacerEl?.style?.height || '0') || 0,
        viewportBottom,
        viewportTop,
        visibleRanges,
      };
      this.diagnostics.latestRender = skippedRender;
      this.recordDiagnosticEvent('render-skipped-unchanged-range', skippedRender);
      return;
    }
    this.lastKey = rangeKey;

    this.topSpacerEl.style.height = `${visible.length ? visible[0].top : 0}px`;
    const bottomHeight = visible.length ? Math.max(0, this.totalHeight - visible[visible.length - 1].bottom) : 0;
    this.bottomSpacerEl.style.height = `${bottomHeight}px`;
    let foundFirstRenderedArtistSection = false;
    this.patchRenderedSections(visible.map((section) => {
      const isFirstRenderedArtistSection = section.kind === 'artist' && !foundFirstRenderedArtistSection;
      if (isFirstRenderedArtistSection) {
        foundFirstRenderedArtistSection = true;
      }
      return {
        key: this.getRenderedSectionKey(section),
        html: this.renderSection(section, start, end, {
          isFirstRenderedArtistSection,
          viewportTop,
          viewportBottom,
        }),
      };
    }), {
      preserveExistingChildren: Boolean(options.preserveExistingChildren),
    });
    this.activateGalleryCoverImages(this.containerEl);
    if (
      typeof galleryCoverLoadScheduler !== 'undefined'
      && typeof galleryCoverLoadScheduler.pruneObsoleteConsumerTasks === 'function'
    ) {
      galleryCoverLoadScheduler.pruneObsoleteConsumerTasks(this._coverLoadGeneration);
    }
    this.scheduleSelectedFamilyCoverPrefetch();
    this.primeVisibleCoverImages();
    this.scheduleMeasureRows(force);
    const completedRender = {
      bottomSpacerHeight: bottomHeight,
      end,
      firstIndex,
      force: Boolean(force),
      lastIndex,
      rangeKey,
      renderGeneration: Number(this._renderGeneration || 0),
      renderRafOwner,
      sections: visible.map((section) => {
        const range = this.getVisibleBlockRange(section, start, end);
        return {
          bottom: Number(section.bottom || 0),
          firstBlockIndex: range?.firstIndex ?? null,
          headerHeight: Number(section.headerHeight || this.sectionHeaderHeight || 0),
          key: String(section.sectionKey || section.title || ''),
          lastBlockIndex: range?.lastIndex ?? null,
          top: Number(section.top || 0),
        };
      }),
      start,
      topSpacerHeight: visible.length ? Number(visible[0].top || 0) : 0,
      viewportBottom,
      viewportTop,
      visibleRanges,
    };
    this.diagnostics.latestRender = completedRender;
    this.recordDiagnosticEvent('render-completed', completedRender);
  }

  primeVisibleCoverImages() {
    if (!(this.scrollEl instanceof HTMLElement) || !(this.containerEl instanceof HTMLElement)) {
      return;
    }
    if (String(state?.view?.selected_artist || '').trim()) {
      return;
    }
    const scrollRect = this.scrollEl.getBoundingClientRect();
    let promotedCoverCount = 0;
    this.containerEl.querySelectorAll('.cover img').forEach((image) => {
      if (!(image instanceof HTMLImageElement)) return;
      const rect = image.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return;
      if (rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) return;
      image.setAttribute('data-gallery-cover-priority', 'visible');
      const productionUrl = String(image.getAttribute('data-production-cover-src') || '').trim();
      if (
        productionUrl
        && typeof galleryCoverLoadScheduler !== 'undefined'
        && typeof galleryCoverLoadScheduler.promote === 'function'
      ) {
        galleryCoverLoadScheduler.promote(productionUrl, 'visible');
      }
      if (promotedCoverCount >= MAX_PRIORITY_VISIBLE_COVER_IMAGES) return;
      promotedCoverCount += 1;
      image.loading = 'eager';
      image.setAttribute('loading', 'eager');
      image.decoding = 'async';
      image.setAttribute('fetchpriority', 'high');
    });
  }

  isTrackModalOpenOrPending() {
    if (String(state?.ui?.pendingTrackModalLoadAlbumKey || '').trim()) {
      return true;
    }
    return Boolean(document?.body?.classList?.contains?.('modal-open'));
  }

  activateGalleryCoverImages(rootEl = this.containerEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
    rootEl.querySelectorAll('img[data-gallery-cover-src]').forEach((image) => {
      if (!(image instanceof HTMLImageElement)) return;
      const productionUrl = String(image.getAttribute('data-gallery-cover-src') || '').trim();
      if (!productionUrl || image.getAttribute('data-gallery-cover-loading') === '1') return;
      image.setAttribute('data-gallery-cover-loading', '1');
      image.removeAttribute('data-gallery-cover-src');
      if (typeof galleryCoverLoadScheduler !== 'undefined') {
        galleryCoverLoadScheduler.enqueue(productionUrl, {
          generation: this._coverLoadGeneration,
          image,
          priority: String(image.getAttribute('data-gallery-cover-priority') || 'near'),
        });
      } else if (typeof loadGalleryCoverPreviewImage === 'function') {
        loadGalleryCoverPreviewImage(image, productionUrl);
      } else {
        image.setAttribute('src', productionUrl);
      }
    });
  }

  scheduleSelectedFamilyCoverPrefetch() {
    if (typeof galleryCoverLoadScheduler === 'undefined') return;
    if (this._familyPrefetchScheduledCoverLoadGeneration === this._coverLoadGeneration) return;
    this._familyPrefetchScheduledCoverLoadGeneration = this._coverLoadGeneration;
    const urls = new Set();
    if (String(state?.view?.selected_artist || '').trim()) {
      this._selectedFamilyCoverUrls.forEach((productionUrl) => urls.add(productionUrl));
    }
    if (typeof galleryCoverLoadScheduler.reconcileFamilyPrefetch === 'function') {
      galleryCoverLoadScheduler.reconcileFamilyPrefetch(urls, {
        generation: this._coverLoadGeneration,
      });
      return;
    }
    urls.forEach((productionUrl) => galleryCoverLoadScheduler.enqueue(productionUrl, {
      generation: this._coverLoadGeneration,
      priority: 'background',
    }));
  }

  getRenderedSectionKey(section) {
    if (section.kind === 'label') {
      return `label:${section.title || ''}`;
    }
    return `artist:${section.sectionKey || ''}`;
  }

  createRenderedSectionNode(record) {
    if (!record || !document?.createElement) return null;
    const scratch = document.createElement('div');
    scratch.innerHTML = String(record.html || '').trim();
    const node = scratch.firstElementChild || null;
    if (!node) return null;
    if (node.dataset) {
      node.dataset.virtualSectionKey = record.key;
    } else {
      node.setAttribute('data-virtual-section-key', record.key);
    }
    return node;
  }

  getRenderedSectionOccurrenceKey(element, rootEl = null) {
    const section = typeof element?.closest === 'function'
      ? element.closest('[data-virtual-section-key]')
      : null;
    return String(
      section?.dataset?.virtualSectionKey
      || section?.getAttribute?.('data-virtual-section-key')
      || rootEl?.dataset?.virtualSectionKey
      || rootEl?.getAttribute?.('data-virtual-section-key')
      || '',
    ).trim();
  }

  getAlbumCardNodeCacheKey(card, rootEl = null) {
    const identity = String(card?.getAttribute?.('data-gallery-card-key') || '').trim();
    if (!identity) return '';
    const sectionKey = this.getRenderedSectionOccurrenceKey(card, rootEl);
    return sectionKey ? `${sectionKey}\u0000${identity}` : identity;
  }

  rememberRenderedAlbumCards(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
    rootEl.querySelectorAll('.album-card[data-gallery-card-key]').forEach((card) => {
      const cacheKey = this.getAlbumCardNodeCacheKey(card, rootEl);
      const coverImage = typeof card?.querySelector === 'function' ? card.querySelector('.cover img') : null;
      const hasDecodedCover = coverImage instanceof HTMLImageElement
        && Boolean(coverImage.complete)
        && Number(coverImage.naturalWidth || 0) > 0;
      const hasPendingCover = coverImage instanceof HTMLImageElement
        && coverImage.getAttribute('data-cover-visual-state') === 'pending'
        && coverImage.getAttribute('data-gallery-cover-loading') === '1';
      if (!cacheKey || (!hasDecodedCover && !hasPendingCover)) return;
      this.albumCardNodeCache.delete(cacheKey);
      this.albumCardNodeCache.set(cacheKey, card);
      while (this.albumCardNodeCache.size > MAX_RETAINED_ALBUM_CARD_NODES) {
        const oldestIdentity = this.albumCardNodeCache.keys().next().value;
        if (!oldestIdentity) break;
        this.albumCardNodeCache.delete(oldestIdentity);
      }
    });
  }

  reuseRenderedAlbumCards(nextRoot) {
    if (!nextRoot || typeof nextRoot.querySelectorAll !== 'function') return;
    nextRoot.querySelectorAll('.album-card[data-gallery-card-key]').forEach((nextCard) => {
      const cacheKey = this.getAlbumCardNodeCacheKey(nextCard, nextRoot);
      const renderKey = String(nextCard?.getAttribute?.('data-gallery-card-render-key') || '');
      const retainedCard = cacheKey ? this.albumCardNodeCache.get(cacheKey) : null;
      if (
        !retainedCard
        || retainedCard === nextCard
        || String(retainedCard?.getAttribute?.('data-gallery-card-render-key') || '') !== renderKey
        || typeof nextCard.replaceWith !== 'function'
      ) {
        return;
      }
      nextCard.replaceWith(retainedCard);
      this.albumCardNodeCache.delete(cacheKey);
      this.albumCardNodeCache.set(cacheKey, retainedCard);
      const retainedImage = retainedCard.querySelector?.('img[data-production-cover-src]');
      const productionUrl = String(retainedImage?.getAttribute?.('data-production-cover-src') || '').trim();
      const retainedImageDecoded = retainedImage instanceof HTMLImageElement
        && Boolean(retainedImage.complete)
        && Number(retainedImage.naturalWidth || 0) > 0;
      const decodedObjectUrlEvicted = Boolean(productionUrl)
        && retainedImageDecoded
        && typeof galleryCoverPreviewCache !== 'undefined'
        && typeof galleryCoverPreviewCache.hasActive === 'function'
        && !galleryCoverPreviewCache.hasActive(productionUrl);
      if (productionUrl && (!retainedImageDecoded || decodedObjectUrlEvicted)) {
        retainedImage.setAttribute('data-gallery-cover-src', productionUrl);
        retainedImage.removeAttribute('data-gallery-cover-loading');
      }
    });
  }

  reuseMatchingMountedAlbumCards(existingRoot, nextRoot) {
    if (
      !existingRoot
      || !nextRoot
      || typeof existingRoot.querySelectorAll !== 'function'
      || typeof nextRoot.querySelectorAll !== 'function'
    ) {
      return;
    }
    const existingCardsByIdentity = new Map();
    existingRoot.querySelectorAll('.album-card[data-gallery-card-key]').forEach((card) => {
      const identity = String(card?.getAttribute?.('data-gallery-card-key') || '').trim();
      if (identity && !existingCardsByIdentity.has(identity)) {
        existingCardsByIdentity.set(identity, card);
      }
    });
    nextRoot.querySelectorAll('.album-card[data-gallery-card-key]').forEach((nextCard) => {
      const identity = String(nextCard?.getAttribute?.('data-gallery-card-key') || '').trim();
      const existingCard = identity ? existingCardsByIdentity.get(identity) : null;
      const renderKey = String(nextCard?.getAttribute?.('data-gallery-card-render-key') || '');
      if (
        !existingCard
        || existingCard === nextCard
        || typeof nextCard.replaceWith !== 'function'
      ) {
        return;
      }
      if (String(existingCard?.getAttribute?.('data-gallery-card-render-key') || '') !== renderKey) {
        if (existingCard.attributes && nextCard.attributes) {
          const nextAttributeNames = new Set(
            Array.from(nextCard.attributes).map((attribute) => attribute.name),
          );
          Array.from(existingCard.attributes).forEach((attribute) => {
            if (!nextAttributeNames.has(attribute.name)) {
              existingCard.removeAttribute(attribute.name);
            }
          });
          Array.from(nextCard.attributes).forEach((attribute) => {
            existingCard.setAttribute(attribute.name, attribute.value);
          });
        }
        if (typeof existingCard.replaceChildren === 'function' && nextCard.childNodes) {
          existingCard.replaceChildren(...Array.from(nextCard.childNodes));
        } else {
          existingCard.innerHTML = nextCard.innerHTML;
        }
      }
      nextCard.replaceWith(existingCard);
      existingCardsByIdentity.delete(identity);
    });
  }

  renderedSectionNodesMatch(existingNode, nextNode) {
    if (!existingNode || !nextNode) return false;
    if (typeof existingNode.isEqualNode === 'function') {
      return existingNode.isEqualNode(nextNode);
    }
    return (
      String(existingNode.tagName || '').toLowerCase() === String(nextNode.tagName || '').toLowerCase()
      && String(existingNode.innerHTML || '') === String(nextNode.innerHTML || '')
    );
  }

  updateRenderedSectionNode(existingNode, nextNode, record) {
    if (
      !existingNode
      || !nextNode
      || String(existingNode.tagName || '').toLowerCase()
        !== String(nextNode.tagName || '').toLowerCase()
    ) {
      return false;
    }
    this.reuseMatchingMountedAlbumCards(existingNode, nextNode);
    this.reuseRenderedAlbumCards(nextNode);
    if (existingNode.attributes && nextNode.attributes) {
      const nextAttributeNames = new Set(
        Array.from(nextNode.attributes).map((attribute) => attribute.name),
      );
      Array.from(existingNode.attributes).forEach((attribute) => {
        if (!nextAttributeNames.has(attribute.name)) {
          existingNode.removeAttribute(attribute.name);
        }
      });
      Array.from(nextNode.attributes).forEach((attribute) => {
        existingNode.setAttribute(attribute.name, attribute.value);
      });
    } else if (existingNode.dataset) {
      existingNode.dataset.virtualSectionKey = record.key;
    } else if (typeof existingNode.setAttribute === 'function') {
      existingNode.setAttribute('data-virtual-section-key', record.key);
    }
    if (
      typeof existingNode.replaceChildren === 'function'
      && nextNode.childNodes
    ) {
      existingNode.replaceChildren(...Array.from(nextNode.childNodes));
    } else {
      existingNode.innerHTML = nextNode.innerHTML;
    }
    return true;
  }

  patchRenderedSections(records, options = {}) {
    if (
      !this.containerEl
      || typeof this.containerEl.appendChild !== 'function'
      || !('children' in this.containerEl)
      || typeof document?.createElement !== 'function'
    ) {
      this.containerEl.innerHTML = records.map((record) => record.html).join('');
      return;
    }
    this.rememberRenderedAlbumCards(this.containerEl);
    const preserveExistingChildren = Boolean(
      options.preserveExistingChildren
      || this._preserveExistingChildrenGeneration === this._renderGeneration
    );
    const existingChildren = Array.from(this.containerEl.children || []);
    const existingByKey = new Map();
    existingChildren.forEach((child) => {
      const key = child?.dataset?.virtualSectionKey || child?.getAttribute?.('data-virtual-section-key') || '';
      if (key) existingByKey.set(key, child);
    });
    const usedExistingChildren = new Set();
    const nextChildren = [];
    records.forEach((record, index) => {
      const existing = existingByKey.get(record.key);
      const nextNode = this.createRenderedSectionNode(record);
      if (
        existing
        && !usedExistingChildren.has(existing)
        && this.renderedSectionNodesMatch(existing, nextNode)
      ) {
        usedExistingChildren.add(existing);
        nextChildren.push(existing);
        return;
      }
      if (preserveExistingChildren) {
        const preservedNode = (
          existing && !usedExistingChildren.has(existing)
            ? existing
            : existingChildren[index]
        );
        if (
          !usedExistingChildren.has(preservedNode)
          && this.updateRenderedSectionNode(preservedNode, nextNode, record)
        ) {
          usedExistingChildren.add(preservedNode);
          nextChildren.push(preservedNode);
          return;
        }
      }
      if (nextNode) {
        this.reuseRenderedAlbumCards(nextNode);
        nextChildren.push(nextNode);
      }
    });
    if (!nextChildren.length && records.length) {
      this.containerEl.innerHTML = records.map((record) => record.html).join('');
      return;
    }
    Array.from(this.containerEl.children || []).forEach((child) => {
      if (!nextChildren.includes(child) && typeof child.remove === 'function') {
        child.remove();
      }
    });
    nextChildren.forEach((child) => {
      this.containerEl.appendChild(child);
    });
    this.rememberRenderedAlbumCards(this.containerEl);
  }

  scheduleMeasureRows(force = false) {
    if (!force && !this.isScrollSettled) {
      this.recordDiagnosticEvent('measure-request-skipped-scrolling', { force: false });
      return;
    }
    if (this._measureRaf) {
      this.recordDiagnosticEvent('measure-request-coalesced', {
        force: Boolean(force),
        pendingMeasureRafOwner: Number(this._measureRaf || 0),
      });
      return;
    }
    let measureRafOwner = 0;
    measureRafOwner = scheduleBrowserAnimationFrame(() => {
      this._activeMeasureRafOwner = measureRafOwner;
      this._measureRaf = null;
      this.recordDiagnosticEvent('measure-frame-started', { measureRafOwner });
      this.measureRenderedRows();
      this._activeMeasureRafOwner = 0;
    });
    this._measureRaf = measureRafOwner;
    this.recordDiagnosticEvent('measure-requested', {
      force: Boolean(force),
      measureRafOwner,
    });
  }

  stabilizeScrollAfterMeasurement(anchor) {
    const preservedAbsoluteScroll = (
      this._absoluteScrollRestore?.renderGeneration === this._renderGeneration
    )
      ? this._absoluteScrollRestore
      : null;
    this.invalidateScrollStabilization({
      preserveAbsoluteScroll: Boolean(preservedAbsoluteScroll),
    });
    const stabilizeGeneration = this._stabilizeGeneration;
    const renderGeneration = this._renderGeneration;
    const resetScroll = this._resetScrollAfterMeasure;
    this._resetScrollAfterMeasure = false;
    const stabilize = () => {
      if (
        stabilizeGeneration !== this._stabilizeGeneration
        || renderGeneration !== this._renderGeneration
      ) return;
      if (resetScroll) {
        this.scrollEl.scrollTop = 0;
      } else if (
        preservedAbsoluteScroll
        && this._absoluteScrollRestore === preservedAbsoluteScroll
      ) {
        this.scrollEl.scrollLeft = preservedAbsoluteScroll.scrollLeft;
        this.scrollEl.scrollTop = preservedAbsoluteScroll.scrollTop;
      } else {
        this.restoreScrollAnchor(anchor);
      }
      this._pendingStabilizationScroll = {
        generation: stabilizeGeneration,
        scrollLeft: Number(this.scrollEl?.scrollLeft || 0),
        scrollTop: Number(this.scrollEl?.scrollTop || 0),
      };
      this.primeVisibleCoverImages();
    };
    stabilize();
    this._stabilizeRaf = scheduleBrowserAnimationFrame(() => {
      if (stabilizeGeneration !== this._stabilizeGeneration) return;
      this._stabilizeRaf = null;
      stabilize();
    });
  }

  measureRenderedRows() {
    const absoluteScrollActive = (
      this._absoluteScrollRestore?.renderGeneration === this._renderGeneration
    );
    const preservedAnchor = absoluteScrollActive ? null : this.captureScrollAnchor();
    let changed = false;
    const rowMeasurements = [];
    const rows = this.containerEl.querySelectorAll('.album-row[data-section-key][data-block-index]');
    rows.forEach((rowEl) => {
      const sectionKey = rowEl.getAttribute('data-section-key');
      const blockIndex = Number(rowEl.getAttribute('data-block-index'));
      const section = this.sectionByKey.get(sectionKey);
      if (!section || !Array.isArray(section.blockHeights) || Number.isNaN(blockIndex)) return;
      const measureKey = Array.isArray(section.blockMeasureKeys) ? String(section.blockMeasureKeys[blockIndex] || '') : '';
      if (measureKey && Array.isArray(section.measuredBlockKeys) && section.measuredBlockKeys[blockIndex] === measureKey) {
        rowMeasurements.push({
          blockIndex,
          measureKeyPresent: Boolean(measureKey),
          measuredHeight: null,
          modeledHeight: Number(section.blockHeights[blockIndex] || 0),
          sectionKey: String(sectionKey || ''),
          skipped: true,
        });
        return;
      }
      const measured = Math.ceil(rowEl.getBoundingClientRect().height);
      rowMeasurements.push({
        blockIndex,
        measureKeyPresent: Boolean(measureKey),
        measuredHeight: measured,
        modeledHeight: Number(section.blockHeights[blockIndex] || 0),
        sectionKey: String(sectionKey || ''),
        skipped: false,
      });
      if (!Array.isArray(section.measuredBlockKeys)) {
        section.measuredBlockKeys = [];
      }
      section.measuredBlockKeys[blockIndex] = measureKey;
      if (measured > 0 && Math.abs((section.blockHeights[blockIndex] || 0) - measured) > 1) {
        section.blockHeights[blockIndex] = measured;
        changed = true;
      }
    });
    const measurement = {
      changed,
      renderGeneration: Number(this._renderGeneration || 0),
      rowMeasurements: rowMeasurements.slice(0, 32),
      scrollTop: Number(this.scrollEl?.scrollTop || 0),
      topSpacerHeight: Number.parseFloat(this.topSpacerEl?.style?.height || '0') || 0,
      bottomSpacerHeight: Number.parseFloat(this.bottomSpacerEl?.style?.height || '0') || 0,
    };
    this.diagnostics.latestMeasurement = measurement;
    this.recordDiagnosticEvent('measure-completed', measurement);
    if (!changed) {
      this._resetScrollAfterMeasure = false;
      return;
    }
    if (
      typeof startupMetrics !== 'undefined'
      && startupMetrics
      && typeof startupMetrics.markOnce === 'function'
    ) {
      startupMetrics.markOnce('startup_grid_reconcile_started', {
        rowCount: rows.length,
      });
    }
    this.lastKey = '';
    this.recalculate();
    const latestScroll = this.diagnostics.latestScroll;
    const measurementRenderRafOwner = (
      Number(latestScroll?.renderGeneration || 0) === Number(this._renderGeneration || 0)
      && Math.abs(Number(latestScroll?.scrollTop || 0) - Number(this.scrollEl?.scrollTop || 0)) <= 2
    )
      ? Number(latestScroll?.renderRafOwner || 0)
      : 0;
    const previousActiveRenderRafOwner = this._activeRenderRafOwner;
    if (measurementRenderRafOwner) {
      this._activeRenderRafOwner = measurementRenderRafOwner;
    }
    try {
      this.render(true);
    } finally {
      this._activeRenderRafOwner = previousActiveRenderRafOwner;
    }
    if (
      typeof startupMetrics !== 'undefined'
      && startupMetrics
      && typeof startupMetrics.markOnce === 'function'
    ) {
      startupMetrics.markOnce('startup_grid_reconcile_complete', {
        rowCount: rows.length,
      });
      if (typeof startupMetrics.schedulePaintMark === 'function') {
        startupMetrics.schedulePaintMark('startup_grid_reconcile_paint', () => ({
          renderedSectionCount: document.querySelectorAll('#artist-groups .artist-section').length,
        }));
      }
    }
    this.stabilizeScrollAfterMeasurement(preservedAnchor);
  }

  getVisibleBlockRange(section, start, end) {
    if (section.kind !== 'artist') return null;
    const blocks = Array.isArray(section.blocksData) ? section.blocksData : [];
    if (!blocks.length) {
      return {
        firstIndex: 0,
        lastIndex: -1,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
      };
    }
    const contentTop = section.top + this.sectionHeaderHeight;
    const localStart = Math.max(0, start - contentTop);
    const localEnd = Math.max(0, end - contentTop);
    let firstIndex = 0;
    while (
      firstIndex < blocks.length
      && ((section.blockOffsets[firstIndex] || 0) + (section.blockHeights[firstIndex] || 0)) < localStart
    ) {
      firstIndex += 1;
    }
    let lastIndex = Math.max(firstIndex, 0);
    while (
      lastIndex < blocks.length - 1
      && (section.blockOffsets[lastIndex + 1] || 0) <= localEnd
    ) {
      lastIndex += 1;
    }
    firstIndex = Math.max(0, Math.min(firstIndex, blocks.length - 1));
    lastIndex = Math.max(firstIndex, Math.min(lastIndex, blocks.length - 1));
    const topSpacerHeight = section.blockOffsets[firstIndex] || 0;
    const lastBlockBottom = (section.blockOffsets[lastIndex] || 0) + (section.blockHeights[lastIndex] || 0);
    const bottomSpacerHeight = Math.max(0, (section.blocksHeight || 0) - lastBlockBottom);
    return { firstIndex, lastIndex, topSpacerHeight, bottomSpacerHeight };
  }

  renderSection(section, start, end, options = {}) {
    const layoutConfig = this.getLayoutConfig();
    const renderAlbumHtml = typeof layoutConfig.renderAlbumHtml === 'function'
      ? layoutConfig.renderAlbumHtml
      : albumCardHtml;
    if (section.kind === 'label') {
      return `<div class="section-split-label">${escapeHtml(section.title)}</div>`;
    }
    const group = section.group;
    const blocks = Array.isArray(section.blocksData) ? section.blocksData : [];
    const visibleRange = this.getVisibleBlockRange(section, start, end);
    const startIndex = visibleRange ? visibleRange.firstIndex : 0;
    const endIndex = visibleRange ? visibleRange.lastIndex : (blocks.length - 1);
    const topSpacer = visibleRange?.topSpacerHeight
      ? `<div class="artist-rows-spacer" style="height:${visibleRange.topSpacerHeight}px;"></div>`
      : '';
    const bottomSpacer = visibleRange?.bottomSpacerHeight
      ? `<div class="artist-rows-spacer" style="height:${visibleRange.bottomSpacerHeight}px;"></div>`
      : '';
    const rowBlocks = blocks.slice(startIndex, endIndex + 1).map((block, visibleIndex) => {
      const blockIndex = startIndex + visibleIndex;
      if (block.kind === 'subheading') {
        return `<div class="artist-subsection-label">${escapeHtml(block.title || 'Non-Album Tracks')}</div>`;
      }
      const blockTop = Number(section.top || 0) + Number(section.blockOffsets?.[blockIndex] || 0);
      const blockBottom = blockTop + Number(section.blockHeights?.[blockIndex] || 0);
      const coverPriority = blockBottom >= Number(options.viewportTop || 0)
        && blockTop <= Number(options.viewportBottom || 0)
        ? 'visible'
        : 'near';
      return `
        <div class="album-row" data-section-key="${escapeHtml(section.sectionKey)}" data-block-index="${blockIndex}" style="grid-template-columns:${buildAlbumRowGridTemplate(this.columns, this.cardTrackWidth)};justify-content:start;">
          ${Array.isArray(block.albums) ? block.albums.map((album) => (
            renderAlbumHtml(album, { coverPriority })
          )).join('') : ''}
        </div>
      `;
    }).join('');

    return `
      <section class="artist-section ${section.sectionType}">
        <div class="artist-header">
          <h2 class="artist-name">${escapeHtml(group.artist_display || group.artist)}</h2>
          <div class="artist-meta">${group.albums.length} ${group.albums.length === 1 ? 'album' : 'albums'}</div>
        </div>
        <div class="artist-rows">${topSpacer}${rowBlocks}${bottomSpacer}</div>
      </section>
    `;
  }
}

const virtualGrid = new VirtualArtistGrid();

function buildArtistSectionRowsHtml(
  albums,
  columns,
  layoutConfig = CARD_GALLERY_LAYOUT_CONFIG,
  cardTrackWidth = resolveGalleryCardWidth(layoutConfig),
) {
  const safeAlbums = Array.isArray(albums) ? albums : [];
  if (!safeAlbums.length) {
    return '';
  }
  const renderAlbumHtml = typeof layoutConfig?.renderAlbumHtml === 'function'
    ? layoutConfig.renderAlbumHtml
    : albumCardHtml;
  const rows = [];
  const safeColumns = Math.max(1, Number(columns) || 1);
  for (let start = 0; start < safeAlbums.length; start += safeColumns) {
    rows.push(safeAlbums.slice(start, start + safeColumns));
  }
  return rows.map((rowAlbums) => `
    <div class="album-row" style="grid-template-columns:${buildAlbumRowGridTemplate(safeColumns, cardTrackWidth)};justify-content:start;">
      ${rowAlbums.map((album) => renderAlbumHtml(album)).join('')}
    </div>
  `).join('');
}

function buildArtistSectionHtml(
  group,
  sectionType,
  columns,
  layoutConfig = CARD_GALLERY_LAYOUT_CONFIG,
  cardTrackWidth = resolveGalleryCardWidth(layoutConfig),
) {
  const safeGroup = group && typeof group === 'object' ? group : {};
  const albums = Array.isArray(safeGroup.albums) ? safeGroup.albums : [];
  return `
    <section class="artist-section ${sectionType}">
      <div class="artist-header">
        <h2 class="artist-name">${escapeHtml(safeGroup.artist_display || safeGroup.artist || 'Artist')}</h2>
        <div class="artist-meta">${albums.length} ${albums.length === 1 ? 'album' : 'albums'}</div>
      </div>
      <div class="artist-rows">${buildArtistSectionRowsHtml(albums, columns, layoutConfig, cardTrackWidth)}</div>
    </section>
  `;
}

function renderArtistGroupsMarkupFallback(
  primaryGroups,
  familyGroups,
  fallbackGroups,
  columns,
  layoutConfig = CARD_GALLERY_LAYOUT_CONFIG,
  cardTrackWidth = resolveGalleryCardWidth(layoutConfig),
) {
  const renderedPrimaryGroups = buildDisplayGroups(primaryGroups);
  const renderedFamilyGroups = buildDisplayGroups(familyGroups);
  const renderedFallbackGroups = buildDisplayGroups(fallbackGroups);
  const renderedGroups = renderedPrimaryGroups.length || renderedFamilyGroups.length
    ? [...renderedPrimaryGroups, ...renderedFamilyGroups]
    : [...renderedFallbackGroups];
  rebuildAlbumIndex(renderedGroups);
  if (virtualGrid.topSpacerEl?.style) {
    virtualGrid.topSpacerEl.style.height = '0px';
  }
  if (virtualGrid.bottomSpacerEl?.style) {
    virtualGrid.bottomSpacerEl.style.height = '0px';
  }
  return [
    ...(renderedPrimaryGroups.length ? ['<div class="section-split-label">Primary Artist</div>'] : []),
    ...renderedPrimaryGroups.map((group) => buildArtistSectionHtml(group, 'primary', columns, layoutConfig, cardTrackWidth)),
    ...(renderedFamilyGroups.length ? ['<div class="section-split-label">Family</div>'] : []),
    ...renderedFamilyGroups.map((group) => buildArtistSectionHtml(group, 'family', columns, layoutConfig, cardTrackWidth)),
    ...(!renderedPrimaryGroups.length && !renderedFamilyGroups.length
      ? renderedFallbackGroups.map((group) => buildArtistSectionHtml(group, 'all', columns, layoutConfig, cardTrackWidth))
      : []),
  ].join('');
}

function resolveGalleryRendererMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return normalized === 'covers' || normalized === 'list' ? normalized : 'cards';
}

function getGalleryModeConfig(mode) {
  const normalizedMode = resolveGalleryRendererMode(mode);
  switch (normalizedMode) {
    case 'covers':
      return { mode: 'covers', renderer: renderArtistGroupsCardMode, layoutConfig: CARD_GALLERY_LAYOUT_CONFIG };
    case 'list':
      return { mode: 'list', renderer: renderArtistGroupsCardMode, layoutConfig: CARD_GALLERY_LAYOUT_CONFIG };
    case 'cards':
    default:
      return { mode: 'cards', renderer: renderArtistGroupsCardMode, layoutConfig: CARD_GALLERY_LAYOUT_CONFIG };
  }
}

function renderArtistGroupsCardMode(displayGroupState = {}, fallbackGroups = [], options = {}, layoutConfig = CARD_GALLERY_LAYOUT_CONFIG) {
  const primaryGroups = Array.isArray(displayGroupState.primaryGroups) ? displayGroupState.primaryGroups : [];
  const familyGroups = Array.isArray(displayGroupState.familyGroups) ? displayGroupState.familyGroups : [];
  const safeFallbackGroups = Array.isArray(fallbackGroups) ? fallbackGroups : [];
  const hasRenderableGroups = Boolean(
    primaryGroups.length
    || familyGroups.length
    || safeFallbackGroups.length
  );

  try {
    virtualGrid.setGroups(
      primaryGroups,
      familyGroups,
      safeFallbackGroups,
      options,
      layoutConfig,
    );
  } catch (_error) {
    if (!hasRenderableGroups || !virtualGrid.containerEl) {
      throw _error;
    }
  }

  if (!hasRenderableGroups || !virtualGrid.containerEl) {
    return;
  }
  const renderedChildCount = Array.isArray(virtualGrid.containerEl.children)
    ? virtualGrid.containerEl.children.length
    : Number(virtualGrid.containerEl.childElementCount || 0);
  const existingMarkup = String(virtualGrid.containerEl.innerHTML || '').trim();
  if (renderedChildCount > 0 || existingMarkup) {
    return;
  }
  virtualGrid.containerEl.innerHTML = renderArtistGroupsMarkupFallback(
    primaryGroups,
    familyGroups,
    safeFallbackGroups,
    virtualGrid.columns,
    layoutConfig,
    virtualGrid.cardTrackWidth,
  );
}

function getGalleryModeRenderer(mode) {
  return getGalleryModeConfig(mode).renderer;
}

function renderArtistGroups(options = {}) {
  const selectedArtist = String(state.view.selected_artist || '').trim();
  const selectedArtistFamilyDisplayMode = String(
    state.view.selected_artist_family_display_mode
      ?? state.view.artist_page?.family_display_mode
      ?? 'grouped',
  ).trim().toLowerCase();
  const displayGroupState = typeof buildSelectedArtistDisplayGroups === 'function'
    ? buildSelectedArtistDisplayGroups(
      state.view.primary_artist_groups || [],
      state.view.family_artist_groups || [],
      selectedArtist,
    )
    : {
      primaryGroups: state.view.primary_artist_groups || [],
      familyGroups: state.view.family_artist_groups || [],
    };
  const fallbackGroups = state.view.artist_groups || [];
  const renderState = selectedArtist && selectedArtistFamilyDisplayMode === 'chronological'
    ? {
      primaryGroups: [],
      familyGroups: [],
    }
    : displayGroupState;
  const modeConfig = getGalleryModeConfig(state.view.gallery_display_mode);
  modeConfig.renderer(renderState, fallbackGroups, options, modeConfig.layoutConfig);
}
