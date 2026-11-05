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
  const refresh = () => {
    frame = 0;
    for (const row of rows) {
      const text = row.firstElementChild;
      const motion = resolveCompactPlayerMetadataRowMotion({
        clientWidth: row.clientWidth, scrollWidth: text.scrollWidth,
      });
      row.classList.toggle('is-credit-overflowing', !reduced.matches && motion.overflowing);
    }
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(refresh);
  };
  const observer = new ResizeObserver(schedule);
  for (const row of rows) {
    observer.observe(row);
    observer.observe(row.firstElementChild);
  }
  reduced.addEventListener('change', schedule);
  document.fonts?.ready.then(schedule);
  albumTrackCreditMotion.set(root, () => {
    disposed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    reduced.removeEventListener('change', schedule);
    for (const row of rows) row.classList.remove('is-credit-overflowing');
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
  const titleHtml = `<span class="album-track-table__title">${escapeHtml(track.title || '')}${secondary ? `<span class="album-track-table__secondary" title="${escapeHtml(secondary)}"><span>${escapeHtml(secondary)}</span></span>` : ''}</span>`;
  const problemHtml = track.isProblematic
    ? `<button class="track-problem-link" type="button" data-open-track-problematic="1" data-track-path="${escapeHtml(trackPath)}" title="Open this track in Problematic Files" aria-label="Open this track in Problematic Files">!</button>`
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
  const mainSummaryHtml = splitTotals
    ? summaryBox([summaryLine('album-track-table__main-total', 'Total Main Album Length', mainLength)])
    : '';
  const finalSummaryHtml = summaryBox([
    !splitTotals && mainLength ? summaryLine('album-track-table__main-total', 'Total Main Album Length', mainLength) : '',
    bonusLength ? summaryLine('album-track-table__bonus-total', `${bonusLabel} Length`, bonusLength) : '',
    totalLength ? summaryLine('album-track-table__aggregate-total', 'Total Length', totalLength) : '',
  ]);
  const tableSections = groups.map((group, groupIndex) => {
    const tracks = Array.isArray(group?.tracks) ? group.tracks : [];
    const label = groupLabel(group);
    const showLabel = Boolean(label) && (
      forceGroupLabels
      || (multiDisc && (Boolean(group?.isBonus) || mainDiscCount > 1))
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
      headers: groupIndex === 0 ? 'visible' : 'absent',
      columns: 'var(--album-track-table-columns)',
      columnsConfig,
      // A named section (provider tracklist heading) is a shaded full-span row before its first track.
      rows: tracks.flatMap((track, index) => {
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
    const summaryHtml = groupIndex === lastMainIndex ? mainSummaryHtml : '';
    if (collapsibleGroups && showLabel) {
      return `<details class="album-track-table__disc album-track-table__disc--collapsible" open><summary class="album-track-table__disc-heading" aria-expanded="true">${escapeHtml(label)}</summary>${table}${summaryHtml}</details>`;
    }
    const heading = showLabel
      ? `<h4 class="album-track-table__disc-heading">${escapeHtml(label)}</h4>`
      : '';
    return `<section class="album-track-table__disc">${heading}${table}${summaryHtml}</section>`;
  }).join('');
  return `<div class="album-track-table"${showPath ? ' data-track-path-column' : ''}${hasProblemColumn ? ' data-track-problem-column' : ''} data-playing-animation="${config.playingAnimation === false ? 'disabled' : 'enabled'}"><div class="album-track-table__frame">${tableSections}${finalSummaryHtml}</div></div>`;
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
