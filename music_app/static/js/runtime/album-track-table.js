function buildAlbumTrackPlayButtonHtml(track = {}) {
  const trackPath = String(track.path || '');
  const mediaRef = String(track.mediaRef || track.media_ref || '');
  const cueSegmentRef = String(track.cueSegmentRef || track.cue_segment_ref || '');
  const trackIdentity = trackPath || mediaRef || cueSegmentRef;
  const playbackRef = String(track.playbackRef || track.playback_ref || '');
  const playbackRefExpiresAt = String(track.playbackRefExpiresAt || track.playback_ref_expires_at || '');
  const title = String(track.playbackTitle || track.title || 'Track');
  const artist = String(track.artist || '');
  const albumArtist = String(track.albumArtist || track.album_artist || '');
  const album = String(track.album || '');
  const coverPath = String(track.coverPath || track.cover_path || '');
  const durationSeconds = Number(track.durationSeconds || track.duration_seconds || 0);
  const isPlaying = Boolean(track.isPlaying);
  const iconName = isPlaying ? 'pause' : 'play';
  const icon = ButtonComponent.renderIconSvg(iconName, {
    className: `album-track-table__play-icon ui-icon--${iconName}`,
  });
  const source = trackPath
    ? `/track?path=${encodeURIComponent(trackPath)}`
    : mediaRef
      ? `/track?ref=${encodeURIComponent(mediaRef)}`
      : `/track?cue=${encodeURIComponent(cueSegmentRef)}`;
  return `<button class="play-track-button album-track-table__play" data-src="${source}" data-track-path="${escapeHtml(trackIdentity)}"${mediaRef ? ` data-media-ref="${escapeHtml(mediaRef)}"` : ''}${cueSegmentRef ? ` data-cue-segment-ref="${escapeHtml(cueSegmentRef)}"` : ''}${playbackRef ? ` data-playback-ref="${escapeHtml(playbackRef)}"` : ''}${playbackRefExpiresAt ? ` data-playback-ref-expires-at="${escapeHtml(playbackRefExpiresAt)}"` : ''} data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(artist)}" data-track-album-artist="${escapeHtml(albumArtist)}" data-track-album="${escapeHtml(album)}" data-track-cover="${escapeHtml(coverPath)}" data-track-duration-seconds="${durationSeconds}" type="button" aria-label="${isPlaying ? 'Pause track' : 'Play track'}">${icon}</button>`;
}

function buildAlbumTrackTableRow(track = {}, index = 0, config = {}) {
  const trackPath = String(track.path || '');
  const trackIdentity = trackPath || String(
    track.mediaRef || track.media_ref || track.cueSegmentRef || track.cue_segment_ref || '',
  );
  const classes = ['album-track-table__row'];
  if (track.isCurrent) classes.push('album-track-table__row--current');
  if (track.isPlaying) classes.push('album-track-table__row--playing');
  if (track.isSearchMatch) classes.push('album-track-table__row--search-match');
  if (track.isPlaying && config.playingAnimation !== false) classes.push('album-track-table__row--animated');
  const secondary = String(track.secondaryArtist || track.secondary_artist || '').trim();
  const mobileTitleSupplement = typeof config.mobileTitleSupplement === 'function'
    ? String(config.mobileTitleSupplement(track, index) || '')
    : '';
  const titleHtml = `<span class="album-track-table__title">${escapeHtml(track.title || '')}${secondary ? `<span class="album-track-table__secondary">${escapeHtml(secondary)}</span>` : ''}${mobileTitleSupplement ? `<span class="album-track-table__mobile-meta">${mobileTitleSupplement}</span>` : ''}</span>`;
  const problemHtml = track.isProblematic
    ? `<button class="track-problem-link" type="button" data-open-track-problematic="1" data-track-path="${escapeHtml(trackPath)}" title="Open this track in Problematic Files" aria-label="Open this track in Problematic Files">!</button>`
    : '';
  const displayPath = String(track.displayPath || track.display_path || trackPath).trim();
  const optionalCells = Object.fromEntries((config.optionalColumns || []).map((column) => [
    column.key,
    { content: String(column.cell(track, index) || '') },
  ]));
  return {
    key: trackIdentity || `${index + 1}`,
    className: classes.join(' '),
    dataAttributes: {
      'track-row-path': trackIdentity,
      'track-search-match': track.isSearchMatch ? 'true' : '',
      'track-playing': track.isPlaying ? 'true' : '',
    },
    cells: {
      number: { content: `<span class="album-track-table__number-play"><span class="album-track-table__number">${escapeHtml(track.trackNumber || track.track_number || index + 1)}</span>${buildAlbumTrackPlayButtonHtml(track)}</span>` },
      title: { content: titleHtml },
      ...optionalCells,
      path: { content: `<span class="album-track-table__path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</span>` },
      problem: { content: problemHtml },
      duration: { content: `<span class="track-duration" data-track-duration-path="${escapeHtml(trackIdentity)}" data-original-duration="${escapeHtml(track.originalDuration || track.duration || '')}">${escapeHtml(track.duration || '')}</span>` },
    },
  };
}

function buildAlbumTrackTableSkeletonRow(index) {
  const line = (modifier, width = '') => `<span class="album-track-table__skeleton album-track-table__skeleton--${modifier}"${width ? ` style="width:${width}%"` : ''}></span>`;
  const widths = [62, 48, 70, 55];
  return {
    key: `skeleton-${index + 1}`,
    className: 'album-track-table__row album-track-table__row--skeleton',
    cells: {
      number: { content: line('number') },
      title: { content: `${line('title', widths[index % widths.length])}${line('secondary', 28)}` },
      path: { content: line('path', 74) },
      problem: { content: '' },
      duration: { content: line('duration') },
    },
  };
}

function isValidAlbumRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}

// A disc after the first shows its own rating only when it and the album are
// both rated and the two ratings differ; the first disc never does.
function buildDiscRatingHtml(group, groupIndex, albumRating) {
  const discRating = group?.discRating;
  if (groupIndex < 1 || !isValidAlbumRating(discRating) || !isValidAlbumRating(albumRating)) return '';
  if (discRating === albumRating) return '';
  return buildGalleryRatingHtml({
    value: discRating,
    maximum: 10,
    label: `Disc rating ${discRating}/10`,
    className: 'album-track-table__disc-rating',
  });
}

function buildAlbumTrackTableHtml(config = {}) {
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const showPath = Boolean(config.showPath);
  const forceGroupLabels = Boolean(config.forceGroupLabels);
  const collapsibleGroups = Boolean(config.collapsibleGroups);
  const ariaLabel = String(config.ariaLabel || 'Album tracks').trim() || 'Album tracks';
  const idPrefix = String(config.idPrefix || 'album-track-table').trim() || 'album-track-table';
  const optionalColumns = (Array.isArray(config.optionalColumns) ? config.optionalColumns : []).filter((column) => (
    column && /^[a-z][a-z0-9_-]*$/.test(String(column.key || '')) && typeof column.cell === 'function'
  ));
  const mobile = config.mobile === 'grouped' ? 'grouped' : 'preserve';
  const multiDisc = Boolean(config.multiDisc) || groups.length > 1;
  const mainDiscCount = groups.filter((group) => !group?.isBonus).length;
  const tableSections = groups.map((group, groupIndex) => {
    const tracks = Array.isArray(group?.tracks) ? group.tracks : [];
    const label = String(group?.discLabel || (group?.discNumber ? `CD ${group.discNumber}` : '')).trim();
    const showLabel = Boolean(label) && (
      forceGroupLabels
      || Boolean(group?.namedSection)
      || (multiDisc && (Boolean(group?.isBonus) || mainDiscCount > 1))
    );
    const columnsConfig = [
      { key: 'number', label: '#' },
      { key: 'title', label: 'Track' },
      ...optionalColumns.map((column) => ({
        key: column.key,
        label: column.label,
        visibility: column.visibility,
        header: column.header,
        action: column.action,
      })),
      ...(showPath ? [{ key: 'path', label: 'File path', visibility: mobile === 'grouped' ? 'desktop' : undefined }] : []),
      { key: 'problem', label: 'Problem', header: 'absent', action: true, visibility: mobile === 'grouped' ? 'desktop' : undefined },
      { key: 'duration', label: 'Length', action: true },
    ];
    const columnTracks = [
      '36px',
      showPath ? 'minmax(180px, 1fr)' : 'minmax(0, 1fr)',
      ...optionalColumns.map((column) => String(column.width || 'auto')),
      ...(showPath ? ['minmax(220px, .9fr)'] : []),
      '20px',
      'minmax(54px, auto)',
    ].join(' ');
    const table = buildCompactDataTable({
      id: `${idPrefix}-tracks-${groupIndex + 1}`,
      ariaLabel: label ? `${ariaLabel} — ${label}` : ariaLabel,
      headers: groupIndex === 0 ? 'visible' : 'absent',
      columns: columnTracks,
      mobileColumns: config.mobileColumns,
      columnsConfig,
      rows: group?.loadingRows
        ? Array.from({ length: Number(group.loadingRows) }, (_, index) => buildAlbumTrackTableSkeletonRow(index))
        : tracks.map((track, index) => buildAlbumTrackTableRow(track, index, {
          ...config,
          optionalColumns,
        })),
      density: 'compact',
      frame: 'outline',
      overflow: 'none',
      mobile,
    });
    if (collapsibleGroups && (showLabel || group?.loadingRows)) {
      const heading = group?.loadingRows
        ? '<span class="album-track-table__skeleton album-track-table__skeleton--heading"></span>'
        : escapeHtml(label);
      return buildCompactDataTableDisclosure({
        className: `album-track-table__disc album-track-table__disc--collapsible${group?.namedSection ? ' album-track-table__disc--named' : ''}`,
        summaryClassName: 'album-track-table__disc-heading',
        summaryAttributes: { 'aria-expanded': 'true' },
        contentClassName: 'album-track-table__disc-content',
        summaryHtml: `<span class="album-track-table__disc-summary">${heading}</span>`,
        contentHtml: table,
        open: true,
      });
    }
    const headingHtml = showLabel
      ? `<h4 class="album-track-table__disc-heading">${escapeHtml(label)}</h4>`
      : '';
    const ratingHtml = showLabel ? buildDiscRatingHtml(group, groupIndex, config.albumRating) : '';
    const heading = ratingHtml
      ? `<div class="album-track-table__disc-header">${headingHtml}${ratingHtml}</div>`
      : headingHtml;
    return `<section class="album-track-table__disc${group?.namedSection ? ' album-track-table__disc--named' : ''}">${heading}${table}</section>`;
  }).join('');
  const totalLength = String(config.totalLength || '').trim();
  const mainLength = String(config.mainLength || '').trim();
  const bonusLength = String(config.bonusLength || '').trim();
  const summaries = [
    totalLength ? `<div class="album-track-table__aggregate-total">Total Length: ${escapeHtml(totalLength)}</div>` : '',
    mainLength ? `<div class="album-track-table__main-total">Total Main Album Length: ${escapeHtml(mainLength)}</div>` : '',
    bonusLength ? `<div class="album-track-table__bonus-total">Bonus Disc Length: ${escapeHtml(bonusLength)}</div>` : '',
  ].join('');
  const loading = groups.some((group) => group?.loadingRows);
  return `<div class="album-track-table${summaries ? ' album-track-table--has-total' : ''}"${loading ? ' aria-busy="true"' : ''} data-playing-animation="${config.playingAnimation === false ? 'disabled' : 'enabled'}"><div class="album-track-table__frame">${tableSections}${summaries ? `<div class="album-track-table__total">${summaries}</div>` : ''}</div></div>`;
}

var TrackSelectionController = class {
  constructor(root, options = {}) {
    this.root = root;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    this.scrollTarget = options.scrollTarget || root?.closest?.('.non-album-modal-table-wrap') || root;
    this.selectedPaths = new Set();
    this.anchorPath = '';
    this.gesture = null;
    this.holdTimer = 0;
    this.suppressClick = false;
    this.rowList = Array.from(this.root?.querySelectorAll?.('[data-track-row-path]') || []);
    this.pathList = this.rowList.map(row => this.pathForRow(row)).filter(Boolean);
    this.handlers = {
      pointerdown: event => this.handlePointerDown(event),
      pointermove: event => this.handlePointerMove(event),
      pointerup: event => this.handlePointerUp(event),
      pointercancel: event => this.handlePointerCancel(event),
      click: event => this.handleClick(event),
      dblclick: event => this.handleDoubleClick(event),
      keydown: event => this.handleKeyDown(event),
      scroll: () => this.handleScroll(),
    };
    Object.entries(this.handlers).forEach(([type, handler]) => {
      if (type !== 'scroll') this.root?.addEventListener?.(type, handler, type === 'click');
    });
    this.scrollTarget?.addEventListener?.('scroll', this.handlers.scroll, { passive: true });
    this.rows().forEach(row => row.setAttribute?.('tabindex', '0'));
  }

  rows() {
    return this.rowList;
  }

  rowFromEvent(event) {
    if (event?.target?.closest?.('button, a, input, textarea, select, [contenteditable=true]')) return null;
    const row = event?.target?.closest?.('[data-track-row-path]');
    return row && this.root?.querySelectorAll ? row : null;
  }

  pathForRow(row) {
    return String(row?.dataset?.trackRowPath || '').trim();
  }

  getSelectedPaths() {
    return this.pathList.filter(path => this.selectedPaths.has(path));
  }

  clearHold() {
    if (this.holdTimer) clearBrowserTimeout(this.holdTimer);
    this.holdTimer = 0;
  }

  sync(nextPaths) {
    const previousPaths = this.selectedPaths;
    this.selectedPaths = new Set(nextPaths);
    this.rows().forEach((row) => {
      const path = this.pathForRow(row);
      const selected = this.selectedPaths.has(path);
      if (previousPaths.has(path) === selected) return;
      row.classList?.[selected ? 'add' : 'remove']('album-track-table__row--selected');
      if (selected) row.setAttribute?.('aria-selected', 'true');
      else row.removeAttribute?.('aria-selected');
    });
    this.onChange(this.getSelectedPaths());
  }

  toggle(path) {
    const next = new Set(this.selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.anchorPath = path;
    this.sync(next);
  }

  clear() {
    this.anchorPath = '';
    this.sync([]);
  }

  selectRange(fromPath, toPath, additive = false) {
    const paths = this.pathList;
    const from = paths.indexOf(fromPath);
    const to = paths.indexOf(toPath);
    if (from < 0 || to < 0) return;
    const next = additive ? new Set(this.gesture?.baseSelection || this.selectedPaths) : new Set();
    paths.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(path => next.add(path));
    this.sync(next);
  }

  handlePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const row = this.rowFromEvent(event);
    const path = this.pathForRow(row);
    if (!path) return;
    if (String(event.pointerType || 'mouse') !== 'touch') event.preventDefault?.();
    this.suppressClick = false;
    this.clearHold();
    this.gesture = {
      pointerId: event.pointerId,
      pointerType: String(event.pointerType || 'mouse'),
      path,
      startX: Number(event.clientX || 0),
      startY: Number(event.clientY || 0),
      startScrollTop: Number(this.scrollTarget?.scrollTop || 0),
      startScrollLeft: Number(this.scrollTarget?.scrollLeft || 0),
      additive: Boolean(event.ctrlKey || event.metaKey),
      shift: Boolean(event.shiftKey),
      selectionWasActive: this.selectedPaths.size > 0,
      baseSelection: new Set(this.selectedPaths),
      dragging: false,
      held: false,
      cancelled: false,
    };
    if (this.gesture.pointerType === 'touch' && !this.gesture.selectionWasActive) {
      this.holdTimer = scheduleBrowserTimeout(() => {
        if (!this.gesture || this.gesture.cancelled) return;
        this.gesture.held = true;
        this.toggle(path);
        this.suppressClick = true;
      }, 550);
    }
  }

  handlePointerMove(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.pointerType === 'touch') {
      if (!gesture.held && Math.hypot(Number(event.clientX || 0) - gesture.startX, Number(event.clientY || 0) - gesture.startY) > 8) {
        gesture.cancelled = true;
        this.clearHold();
      }
      if (!gesture.held) return;
      const path = this.pathForRow(this.rowFromEvent(event));
      if (!path || path === gesture.path) return;
      gesture.dragging = true;
      this.anchorPath = gesture.path;
      this.selectRange(gesture.path, path, true);
      this.suppressClick = true;
      event.preventDefault?.();
      return;
    }
    const path = this.pathForRow(this.rowFromEvent(event));
    if (!path || path === gesture.path) return;
    gesture.dragging = true;
    this.anchorPath = gesture.path;
    this.selectRange(gesture.path, path, gesture.additive);
    this.suppressClick = true;
    event.preventDefault?.();
  }

  handlePointerUp(event) {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.clearHold();
    this.gesture = null;
    if (gesture.cancelled || gesture.held || gesture.dragging) return;
    if (gesture.pointerType === 'touch') {
      if (gesture.selectionWasActive) {
        this.toggle(gesture.path);
        this.suppressClick = true;
      }
      return;
    }
    if (gesture.shift && this.anchorPath) {
      this.selectRange(this.anchorPath, gesture.path, gesture.additive);
      this.suppressClick = true;
    } else if (gesture.additive || gesture.selectionWasActive) {
      this.toggle(gesture.path);
      this.suppressClick = true;
    }
  }

  handlePointerCancel(event) {
    if (this.gesture && this.gesture.pointerId === event.pointerId) this.gesture = null;
    this.clearHold();
  }

  handleScroll() {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerType !== 'touch') return;
    const distance = Math.max(
      Math.abs(Number(this.scrollTarget?.scrollTop || 0) - gesture.startScrollTop),
      Math.abs(Number(this.scrollTarget?.scrollLeft || 0) - gesture.startScrollLeft),
    );
    if (distance <= 8) return;
    gesture.cancelled = true;
    this.clearHold();
  }

  handleClick(event) {
    if (!this.rowFromEvent(event) || !this.suppressClick) return;
    this.suppressClick = false;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  }

  handleDoubleClick(event) {
    if (!this.rowFromEvent(event) || !this.selectedPaths.size) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  }

  handleKeyDown(event) {
    const row = this.rowFromEvent(event);
    const path = this.pathForRow(row);
    if (!path) return;
    if (event.key === 'Escape' && this.selectedPaths.size) {
      this.clear();
      event.preventDefault?.();
      return;
    }
    if (event.key !== ' ' && event.key !== 'Spacebar') return;
    if (event.shiftKey && this.anchorPath) this.selectRange(this.anchorPath, path, event.ctrlKey || event.metaKey);
    else this.toggle(path);
    event.preventDefault?.();
  }

  destroy() {
    this.clearHold();
    Object.entries(this.handlers).forEach(([type, handler]) => {
      if (type !== 'scroll') this.root?.removeEventListener?.(type, handler, type === 'click');
    });
    this.scrollTarget?.removeEventListener?.('scroll', this.handlers.scroll);
    this.rows().forEach((row) => {
      row.classList?.remove('album-track-table__row--selected');
      row.removeAttribute?.('aria-selected');
      row.removeAttribute?.('tabindex');
    });
    this.selectedPaths.clear();
    this.gesture = null;
    this.onChange([]);
  }
};

function triggerAlbumTrackPlayActivation(button) {
  if (!button?.classList?.add || !button?.classList?.remove) return;
  button.classList.remove('album-track-table__play--activating');
  void button.offsetWidth;
  button.classList.add('album-track-table__play--activating');
  button.addEventListener?.('animationend', () => {
    button.classList.remove('album-track-table__play--activating');
  }, { once: true });
}

const albumTrackRowTaps = new WeakMap();
function handleAlbumTrackRowClick(event) {
  if (event.defaultPrevented) return;
  if (typeof usesMobilePageLayout !== 'function' || !usesMobilePageLayout()) return;
  if (event.target.closest?.('button, a, input, textarea, select, [contenteditable=true]')) return;
  const now = Date.now(), last = albumTrackRowTaps.get(event.currentTarget);
  const doubleTap = event.detail > 1 || (last !== undefined && now - last <= 320);
  if (doubleTap) albumTrackRowTaps.delete(event.currentTarget);
  else albumTrackRowTaps.set(event.currentTarget, now);
  activateAlbumTrackRow(event, { restart: doubleTap });
}
function handleAlbumTrackRowDoubleClick(event) {
  if (event.defaultPrevented) return;
  // Touch click timing above also supports browsers that do not emit dblclick.
  if (typeof usesMobilePageLayout === 'function' && usesMobilePageLayout()) return;
  activateAlbumTrackRow(event);
}
function activateAlbumTrackRow(event, { restart = false } = {}) {
  if (event.target.closest?.('button, a, input, textarea, select, [contenteditable=true]')) return;
  const row = event.currentTarget;
  event.preventDefault();
  const selection = row.ownerDocument.getSelection();
  if (selection && row.contains(selection.anchorNode) && row.contains(selection.focusNode)) selection.removeAllRanges();
  const mobile = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
  if (!mobile && row.dataset.trackPlaying === 'true') return;
  const button = row.querySelector('.play-track-button');
  if (restart && button) activateSharedTrackButton(button, { restart: true });
  else button?.click();
}
