const albumTrackCreditMotion = new WeakMap();

function disposeAlbumTrackCreditMotion(root) {
  albumTrackCreditMotion.get(root)?.();
  albumTrackCreditMotion.delete(root);
}

function syncAlbumTrackCreditMotion(root) {
  disposeAlbumTrackCreditMotion(root);
  if (!root?.querySelectorAll || typeof ResizeObserver !== 'function') return;
  const rows = Array.from(root.querySelectorAll('.album-track-table__secondary'));
  if (!rows.length) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0;
  let disposed = false;
  // Only on-screen credits pan; hundreds of off-screen infinite animations
  // (long Loose Tracks lists) kept the compositor and style engine busy.
  const visible = new Set();
  const refresh = () => {
    frame = 0;
    // Read every width before writing any class: interleaving forced one
    // synchronous layout per row.
    const overflowing = rows.map((row) => !reduced.matches && visible.has(row)
      && resolveCompactPlayerMetadataRowMotion({
        clientWidth: row.clientWidth, scrollWidth: row.firstElementChild.scrollWidth,
      }).overflowing);
    rows.forEach((row, index) => row.classList.toggle('is-credit-overflowing', overflowing[index]));
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(refresh);
  };
  const observer = new ResizeObserver(schedule);
  const visibility = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }
      schedule();
    })
    : null;
  for (const row of rows) {
    observer.observe(row);
    observer.observe(row.firstElementChild);
    if (visibility) visibility.observe(row);
    else visible.add(row);
  }
  reduced.addEventListener('change', schedule);
  document.fonts?.ready.then(schedule);
  albumTrackCreditMotion.set(root, () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    visibility?.disconnect();
    reduced.removeEventListener('change', schedule);
    for (const row of rows) { row.classList.remove('is-credit-overflowing'); clearRunningLineMotion(row); }
  });
  schedule();
}

function buildAlbumTrackPlayButtonHtml(track = {}) {
  const trackPath = String(track.path || '');
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
  return `<button class="play-track-button album-track-table__play" data-src="/track?path=${encodeURIComponent(trackPath)}" data-track-path="${escapeHtml(trackPath)}" data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(artist)}" data-track-album-artist="${escapeHtml(albumArtist)}" data-track-album="${escapeHtml(album)}" data-track-cover="${escapeHtml(coverPath)}" data-track-duration-seconds="${durationSeconds}" type="button" aria-label="${isPlaying ? 'Pause track' : 'Play track'}">${icon}</button>`;
}

function buildAlbumTrackTableRow(track = {}, index = 0, config = {}) {
  const trackPath = String(track.path || '');
  const classes = ['album-track-table__row'];
  if (track.isCurrent) classes.push('album-track-table__row--current');
  if (track.isPlaying) classes.push('album-track-table__row--playing');
  if (track.isSearchMatch) classes.push('album-track-table__row--search-match');
  if (track.isPlaying && config.playingAnimation !== false) classes.push('album-track-table__row--animated');
  const secondary = String(track.secondaryArtist || track.secondary_artist || '').trim();
  if (secondary) classes.push('album-track-table__row--secondary');
  // titlePrefix (e.g. "Artist / ") is drawn before the title without becoming part of the title text.
  const titlePrefix = String(track.titlePrefix || '').trim();
  const titleHtml = `<span class="album-track-table__title"${titlePrefix ? ` data-title-prefix="${escapeHtml(`${titlePrefix} / `)}"` : ''}>${escapeHtml(track.title || '')}${secondary ? `<span class="album-track-table__secondary" title="${escapeHtml(secondary)}"><span>${escapeHtml(secondary)}</span></span>` : ''}</span>`;
  const problemReasons = (Array.isArray(track.problemReasons) ? track.problemReasons : [])
    .map((reason) => String(reason || '').trim()).filter(Boolean);
  // The reasons arrive with Album Details, so hovering never loads Problematic Files.
  const problemTitle = problemReasons.length
    ? `${problemReasons.join(', ')}. Open this track in Problematic Files`
    : 'Open this track in Problematic Files';
  const problemHtml = track.isProblematic
    ? `<button class="track-problem-link" type="button" data-open-track-problematic="1" data-track-path="${escapeHtml(trackPath)}" title="${escapeHtml(problemTitle)}" aria-label="Open this track in Problematic Files">!</button>`
    : '';
  const displayPath = String(track.displayPath || track.display_path || trackPath).trim();
  return {
    key: trackPath || `${index + 1}`,
    className: classes.join(' '),
    dataAttributes: {
      'track-row-path': trackPath,
      'track-search-match': track.isSearchMatch ? 'true' : '',
      'track-playing': track.isPlaying ? 'true' : '',
    },
    cells: {
      number: { content: `<span class="album-track-table__number-play"><span class="album-track-table__number">${escapeHtml(track.trackNumber || track.track_number || index + 1)}</span>${buildAlbumTrackPlayButtonHtml(track)}</span>` },
      title: { content: titleHtml },
      path: { content: `<span class="album-track-table__path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</span>` },
      problem: { content: problemHtml },
      duration: { content: `<span class="track-duration" data-track-duration-path="${escapeHtml(trackPath)}" data-original-duration="${escapeHtml(track.originalDuration || track.duration || '')}">${escapeHtml(track.duration || '')}</span>` },
    },
  };
}

function matchesAlbumTrackSearch(query, title, secondaryArtist) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  return Boolean(normalizedQuery && [title, secondaryArtist]
    .some(value => String(value || '').toLocaleLowerCase().includes(normalizedQuery)));
}

// Loading rows keep the real row geometry: number, title and secondary line, optional path, length.
function buildAlbumTrackTableSkeletonRow(index) {
  const line = (modifier, width) => `<span class="album-track-table__skeleton album-track-table__skeleton--${modifier}"${width ? ` style="width:${width}%"` : ''}></span>`;
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
  const multiDisc = Boolean(config.multiDisc) || groups.length > 1;
  const mainDiscCount = groups.filter((group) => !group?.isBonus).length;
  const totalLength = String(config.totalLength || '').trim();
  const mainLength = String(config.mainLength || '').trim();
  const bonusLength = String(config.bonusLength || '').trim();
  const summaryLine = (className, label, value) => (
    `<div class="${className}">${escapeHtml(label)}: ${escapeHtml(value)}</div>`
  );
  const summaryBox = (lines) => {
    const html = lines.filter(Boolean).join('');
    return html ? `<div class="album-track-table__total">${html}</div>` : '';
  };
  // Column priority: number, title and length always fit; the Problematic Files slot exists only when a
  // listed track needs it; File path is optional and yields first when the table narrows (see CSS).
  const hasProblemColumn = groups.some((group) => (Array.isArray(group?.tracks) ? group.tracks : [])
    .some((track) => Boolean(track?.isProblematic)));
  const groupLabel = (group) => String(group?.discLabel || (group?.discNumber ? `CD ${group.discNumber}` : '')).trim();
  // The main-album total closes the last main disc; bonus discs then end with their own length and the album total.
  const bonusGroups = groups.filter((group) => group?.isBonus);
  const lastMainIndex = groups.reduce((last, group, index) => (group?.isBonus ? last : index), -1);
  const splitTotals = Boolean(mainLength) && lastMainIndex >= 0 && lastMainIndex < groups.length - 1;
  const bonusLabel = bonusGroups.length === 1 ? (groupLabel(bonusGroups[0]) || 'Bonus Disc') : 'Bonus Discs';
  // perDiscLengths: every disc closes with its own length and the album ends with one Total Length
  // (used when a later disc has its own name). Otherwise main/bonus totals apply.
  const perDiscLengths = Boolean(config.perDiscLengths) && groups.length > 1;
  const mainSummaryHtml = splitTotals && !perDiscLengths
    ? summaryBox([summaryLine('album-track-table__main-total', 'Total Main Album Length', mainLength)])
    : '';
  const discSummaryHtml = (group, groupIndex) => {
    const length = String(group?.lengthDisplay || '').trim();
    const label = groupLabel(group) || `CD ${groupIndex + 1}`;
    return length ? summaryBox([summaryLine('album-track-table__disc-total', `${label} Length`, length)]) : '';
  };
  const finalSummaryHtml = summaryBox(perDiscLengths ? [
    totalLength ? summaryLine('album-track-table__aggregate-total', 'Total Length', totalLength) : '',
  ] : [
    !splitTotals && mainLength ? summaryLine('album-track-table__main-total', 'Total Main Album Length', mainLength) : '',
    bonusLength ? summaryLine('album-track-table__bonus-total', `${bonusLabel} Length`, bonusLength) : '',
    totalLength ? summaryLine('album-track-table__aggregate-total', 'Total Length', totalLength) : '',
  ]);
  const tableSections = groups.map((group, groupIndex) => {
    const tracks = Array.isArray(group?.tracks) ? group.tracks : [];
    const label = groupLabel(group);
    const showLabel = Boolean(label) && (
      forceGroupLabels
      || groups.length > 1
      || (multiDisc && Boolean(group?.isBonus))
    );
    const columnsConfig = [
      { key: 'number', label: '#' },
      { key: 'title', label: 'Track' },
      ...(showPath ? [{ key: 'path', label: 'File path' }] : []),
      ...(hasProblemColumn ? [{ key: 'problem', label: 'Problem', header: 'absent', action: true }] : []),
      { key: 'duration', label: 'Length', action: true },
    ];
    const table = buildCompactDataTable({
      id: `${idPrefix}-tracks-${groupIndex + 1}`,
      ariaLabel: label ? `${ariaLabel} — ${label}` : ariaLabel,
      // Collapsible sections each carry their own column headers so any section can be read alone.
      headers: groupIndex === 0 || collapsibleGroups ? 'visible' : 'absent',
      columns: 'var(--album-track-table-columns)',
      columnsConfig,
      // A named section (provider tracklist heading) is a shaded full-span row before its first track.
      rows: group?.loadingRows ? Array.from({ length: Number(group.loadingRows) }, (_, index) => buildAlbumTrackTableSkeletonRow(index)) : tracks.flatMap((track, index) => {
        const row = buildAlbumTrackTableRow(track, index, config);
        const sectionTitle = String(track?.sectionTitle || '').trim();
        return sectionTitle ? [{
          key: `section:${row.key}`,
          className: 'album-track-table__section-row',
          ariaLabel: sectionTitle,
          fullSpanContent: `<span class="album-track-table__section-title">${escapeHtml(sectionTitle)}</span>`,
        }, row] : [row];
      }),
      density: 'compact',
      frame: 'outline',
      overflow: 'none',
      mobile: 'preserve',
    });
    const summaryHtml = perDiscLengths ? discSummaryHtml(group, groupIndex) : (groupIndex === lastMainIndex ? mainSummaryHtml : '');
    if (collapsibleGroups && (showLabel || group?.loadingRows)) {
      // Section super-header: title, muted count, and the section length (hidden while collapsed).
      const count = String(group?.countLabel || '').trim();
      const length = String(group?.lengthDisplay || '').trim();
      const headingContent = group?.loadingRows
        ? '<span class="album-track-table__skeleton album-track-table__skeleton--heading"></span>'
        : `<span class="album-track-table__disc-title">${escapeHtml(label)}</span>${count ? `<span class="album-track-table__disc-count">${escapeHtml(count)}</span>` : ''}${length ? `<span class="album-track-table__disc-length">${escapeHtml(length)}</span>` : ''}`;
      return `<details class="album-track-table__disc album-track-table__disc--collapsible" open><summary class="album-track-table__disc-heading" aria-expanded="true">${headingContent}</summary>${table}${summaryHtml}</details>`;
    }
    const headingHtml = showLabel
      ? `<h4 class="album-track-table__disc-heading">${escapeHtml(label)}</h4>`
      : '';
    const ratingHtml = showLabel ? buildDiscRatingHtml(group, groupIndex, config.albumRating) : '';
    const heading = ratingHtml
      ? `<div class="album-track-table__disc-header">${headingHtml}${ratingHtml}</div>`
      : headingHtml;
    return `<section class="album-track-table__disc">${heading}${table}${summaryHtml}</section>`;
  }).join('');
  const loading = groups.some((group) => group?.loadingRows);
  return `<div class="album-track-table"${showPath ? ' data-track-path-column' : ''}${hasProblemColumn ? ' data-track-problem-column' : ''}${loading ? ' aria-busy="true"' : ''} data-playing-animation="${config.playingAnimation === false ? 'disabled' : 'enabled'}"><div class="album-track-table__frame">${tableSections}${finalSummaryHtml}</div></div>`;
}

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
  if (typeof usesMobilePageLayout !== 'function' || !usesMobilePageLayout()) return;
  if (event.target.closest?.('button, a, input, textarea, select, [contenteditable=true]')) return;
  const now = Date.now(), last = albumTrackRowTaps.get(event.currentTarget);
  const doubleTap = event.detail > 1 || (last !== undefined && now - last <= 320);
  if (doubleTap) albumTrackRowTaps.delete(event.currentTarget);
  else albumTrackRowTaps.set(event.currentTarget, now);
  activateAlbumTrackRow(event, { restart: doubleTap });
}
function handleAlbumTrackRowDoubleClick(event) {
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
