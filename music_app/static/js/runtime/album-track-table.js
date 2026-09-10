function buildAlbumTrackPlayButtonHtml(track = {}) {
  const trackPath = String(track.path || '');
  const title = String(track.playbackTitle || track.title || 'Track');
  const artist = String(track.artist || '');
  const albumArtist = String(track.albumArtist || track.album_artist || '');
  const album = String(track.album || '');
  const coverPath = String(track.coverPath || track.cover_path || '');
  const durationSeconds = Number(track.durationSeconds || track.duration_seconds || 0);
  const isPlaying = Boolean(track.isPlaying);
  return `<button class="play-track-button album-track-table__play" data-src="/track?path=${encodeURIComponent(trackPath)}" data-track-path="${escapeHtml(trackPath)}" data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(artist)}" data-track-album-artist="${escapeHtml(albumArtist)}" data-track-album="${escapeHtml(album)}" data-track-cover="${escapeHtml(coverPath)}" data-track-duration-seconds="${durationSeconds}" type="button" aria-label="${isPlaying ? 'Pause track' : 'Play track'}">${isPlaying ? '&#x23F8;' : '&#x25B6;'}</button>`;
}

function buildAlbumTrackTableRow(track = {}, index = 0, config = {}) {
  const trackPath = String(track.path || '');
  const classes = ['album-track-table__row'];
  if (track.isCurrent) classes.push('album-track-table__row--current');
  if (track.isPlaying) classes.push('album-track-table__row--playing');
  if (track.isSearchMatch) classes.push('album-track-table__row--search-match');
  if (track.isPlaying && config.playingAnimation !== false) classes.push('album-track-table__row--animated');
  const secondary = String(track.secondaryArtist || track.secondary_artist || '').trim();
  const titleHtml = `<span class="album-track-table__title">${escapeHtml(track.title || '')}${secondary ? `<span class="album-track-table__secondary">${escapeHtml(secondary)}</span>` : ''}</span>`;
  const problemHtml = track.isProblematic
    ? `<button class="track-problem-link" type="button" data-open-track-problematic="1" data-track-path="${escapeHtml(trackPath)}" title="Open this track in Problematic Files" aria-label="Open this track in Problematic Files">!</button>`
    : '';
  return {
    key: trackPath || `${index + 1}`,
    className: classes.join(' '),
    dataAttributes: {
      'track-row-path': trackPath,
      'track-search-match': track.isSearchMatch ? 'true' : '',
      'track-playing': track.isPlaying ? 'true' : '',
    },
    cells: {
      play: { content: buildAlbumTrackPlayButtonHtml(track), ariaLabel: track.isPlaying ? 'Pause track' : 'Play track' },
      number: { content: escapeHtml(track.trackNumber || track.track_number || index + 1) },
      title: { content: titleHtml },
      problem: { content: problemHtml },
      duration: { content: `<span class="track-duration" data-track-duration-path="${escapeHtml(trackPath)}" data-original-duration="${escapeHtml(track.originalDuration || track.duration || '')}">${escapeHtml(track.duration || '')}</span>` },
    },
  };
}

function buildAlbumTrackTableHtml(config = {}) {
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const multiDisc = Boolean(config.multiDisc) || groups.length > 1;
  const mainDiscCount = groups.filter((group) => !group?.isBonus).length;
  const tableSections = groups.map((group, groupIndex) => {
    const tracks = Array.isArray(group?.tracks) ? group.tracks : [];
    const label = String(group?.discLabel || (group?.discNumber ? `CD ${group.discNumber}` : '')).trim();
    const showLabel = multiDisc && Boolean(label) && (Boolean(group?.isBonus) || mainDiscCount > 1);
    const table = buildCompactDataTable({
      id: `album-track-table-tracks-${groupIndex + 1}`,
      ariaLabel: label ? `Album tracks — ${label}` : 'Album tracks',
      headers: groupIndex === 0 ? 'visible' : 'absent',
      columns: '34px 36px minmax(0, 1fr) 20px minmax(54px, auto)',
      columnsConfig: [
        { key: 'play', label: 'Play', header: 'absent' },
        { key: 'number', label: '#' },
        { key: 'title', label: 'Track' },
        { key: 'problem', label: 'Problem', header: 'absent', action: true },
        { key: 'duration', label: 'Length', action: true },
      ],
      rows: tracks.map((track, index) => buildAlbumTrackTableRow(track, index, config)),
      density: 'compact',
      frame: 'outline',
      overflow: 'none',
      mobile: 'preserve',
    });
    const heading = showLabel
      ? `<h4 class="album-track-table__disc-heading">${escapeHtml(label)}</h4>`
      : '';
    return `<section class="album-track-table__disc">${heading}${table}</section>`;
  }).join('');
  const totalLength = String(config.totalLength || '').trim();
  const mainLength = String(config.mainLength || '').trim();
  const bonusLength = String(config.bonusLength || '').trim();
  const summaries = [
    totalLength ? `<div class="album-track-table__aggregate-total">Total Length: ${escapeHtml(totalLength)}</div>` : '',
    mainLength ? `<div class="album-track-table__main-total">Total Main Album Length: ${escapeHtml(mainLength)}</div>` : '',
    bonusLength ? `<div class="album-track-table__bonus-total">Bonus Disc Length: ${escapeHtml(bonusLength)}</div>` : '',
  ].join('');
  return `<div class="album-track-table" data-playing-animation="${config.playingAnimation === false ? 'disabled' : 'enabled'}"><div class="album-track-table__frame">${tableSections}${summaries ? `<div class="album-track-table__total">${summaries}</div>` : ''}</div></div>`;
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
