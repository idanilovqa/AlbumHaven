function buildAlbumTrackPlayButtonHtml(track = {}) {
  if (track.readable === false) return '';
  const trackPath = String(track.path || '');
  const title = String(track.playbackTitle || track.title || 'Track');
  const artist = String(track.artist || '');
  const albumArtist = String(track.albumArtist || track.album_artist || '');
  const album = String(track.album || '');
  const coverPath = String(track.coverPath || track.cover_path || '');
  const durationSeconds = Number(track.durationSeconds || track.duration_seconds || 0);
  const isPlaying = Boolean(track.isPlaying);
  const disabled = track.canPlay === false || track.availability === 'missing';
  const iconName = isPlaying ? 'pause' : 'play';
  const icon = ButtonComponent.renderIconSvg(iconName, {
    className: `album-track-table__play-icon ui-icon--${iconName}`,
  });
  return `<button class="play-track-button album-track-table__play" data-src="/track?path=${encodeURIComponent(trackPath)}" data-track-path="${escapeHtml(trackPath)}" data-inventory-track-ref="${escapeHtml(track.inventory_track_ref || '')}" data-track-title="${escapeHtml(title)}" data-track-artist="${escapeHtml(artist)}" data-track-album-artist="${escapeHtml(albumArtist)}" data-track-album="${escapeHtml(album)}" data-track-cover="${escapeHtml(coverPath)}" data-track-duration-seconds="${durationSeconds}" type="button" aria-label="${isPlaying ? 'Pause track' : 'Play track'}"${disabled ? ' disabled aria-disabled="true"' : ''}>${icon}</button>`;
}

function buildAlbumTrackTableRow(track = {}, index = 0, config = {}) {
  const denied = track.readable === false;
  if (denied) track = {rowKey: track.rowKey, readable: false, selectable: false, title: 'Unavailable track'};
  const readOnly = config.readOnly === true || denied;
  const trackPath = readOnly ? '' : String(track.path || '');
  const classes = ['album-track-table__row'];
  if (track.availability === 'missing') classes.push('album-track-table__row--missing');
  if (!readOnly && track.isCurrent) classes.push('album-track-table__row--current');
  if (!readOnly && track.isPlaying) classes.push('album-track-table__row--playing');
  if (track.isSearchMatch) classes.push('album-track-table__row--search-match');
  if (!readOnly && track.isPlaying && config.playingAnimation !== false) classes.push('album-track-table__row--animated');
  const secondary = String(track.secondaryArtist || track.secondary_artist || '').trim();
  const titleHtml = `<span class="album-track-table__title">${escapeHtml(track.title || '')}${secondary ? `<span class="album-track-table__secondary">${escapeHtml(secondary)}</span>` : ''}</span>`;
  const problemHtml = !readOnly && track.isProblematic
    ? `<button class="track-problem-link" type="button" data-open-track-problematic="1" data-track-path="${escapeHtml(trackPath)}" title="Open this track in Problematic Files" aria-label="Open this track in Problematic Files">!</button>`
    : '';
  const displayPath = readOnly ? '' : String(track.displayPath || track.display_path || trackPath).trim();
  const rowKey = typeof track.rowKey === 'string' && track.rowKey ? track.rowKey : null;
  const selectable = Boolean(rowKey) && track.readable === true && track.selectable !== false;
  return {
    key: config.selection === 'multiple' ? rowKey || ''
      : rowKey || (readOnly ? String(track.id || index + 1) : trackPath || `${index + 1}`),
    className: classes.join(' '),
    ...(config.selection === 'multiple' || denied ? {tabIndex: selectable ? 0 : -1,
      ariaDisabled: !selectable, ariaSelected: selectable && track.isSelected === true} : {}),
    dataAttributes: readOnly ? {} : {
      'track-row-path': trackPath,
      'track-search-match': track.isSearchMatch ? 'true' : '',
      'track-playing': track.isPlaying ? 'true' : '',
    },
    cells: {
      number: { content: `<span class="album-track-table__number-play"><span class="album-track-table__number">${escapeHtml(track.trackNumber || track.track_number || index + 1)}</span>${readOnly ? '' : buildAlbumTrackPlayButtonHtml(track)}</span>` },
      title: { content: titleHtml },
      path: { content: `<span class="album-track-table__path" title="${escapeHtml(displayPath)}">${escapeHtml(displayPath)}</span>` },
      problem: { content: problemHtml },
      rating: {content: escapeHtml(config.subjectTaste && Number.isInteger(track.subjectRating) ? track.subjectRating : '–')},
      love: {content: config.subjectTaste && ['off', 'loved', 'obsessed'].includes(track.subjectLove)
        ? `<span role="img" aria-label="${escapeHtml(track.subjectLove)}">${ButtonComponent.renderIconSvg(`love-${track.subjectLove}`)}</span>` : '–'},
      duration: { content: `<span class="track-duration" ${readOnly ? '' : `data-track-duration-path="${escapeHtml(trackPath)}" data-original-duration="${escapeHtml(track.originalDuration || track.duration || '')}"`}>${escapeHtml(track.duration || '')}</span>` },
    },
  };
}

function buildAlbumTrackTableHtml(config = {}) {
  const groups = Array.isArray(config.groups) ? config.groups : [];
  const showPath = Boolean(config.showPath);
  const forceGroupLabels = Boolean(config.forceGroupLabels);
  const ariaLabel = String(config.ariaLabel || 'Album tracks').trim() || 'Album tracks';
  const idPrefix = String(config.idPrefix || 'album-track-table').trim() || 'album-track-table';
  const multiDisc = Boolean(config.multiDisc) || groups.length > 1;
  const mainDiscCount = groups.filter((group) => !group?.isBonus).length;
  const tableSections = groups.map((group, groupIndex) => {
    const tracks = Array.isArray(group?.tracks) ? group.tracks : [];
    const label = String(group?.discLabel || (group?.discNumber ? `CD ${group.discNumber}` : '')).trim();
    const showLabel = Boolean(label) && (
      forceGroupLabels
      || (multiDisc && (Boolean(group?.isBonus) || mainDiscCount > 1))
    );
    const columnsConfig = [
      { key: 'number', label: '#' },
      { key: 'title', label: 'Track' },
      ...(showPath ? [{ key: 'path', label: 'File path' }] : []),
      ...(config.subjectTaste ? [{key: 'rating', label: 'Rating'}, {key: 'love', label: 'Love'}] : []),
      { key: 'problem', label: 'Problem', header: 'absent', action: true },
      { key: 'duration', label: 'Length', action: true },
    ];
    const table = buildCompactDataTable({
      id: `${idPrefix}-tracks-${groupIndex + 1}`,
      ariaLabel: label ? `${ariaLabel} — ${label}` : ariaLabel,
      headers: groupIndex === 0 ? 'visible' : 'absent',
      columns: showPath
        ? '36px minmax(180px, 1fr) minmax(220px, .9fr) 20px minmax(54px, auto)'
        : config.subjectTaste ? '36px minmax(0,1fr) 52px 36px 20px minmax(54px,auto)' : '36px minmax(0, 1fr) 20px minmax(54px, auto)',
      columnsConfig,
      rows: tracks.map((track, index) => buildAlbumTrackTableRow(track, index, config)),
      density: 'compact',
      frame: 'outline',
      overflow: 'none',
      mobile: 'preserve',
      selection: config.selection,
    });
    const sectionKey = typeof group?.sectionKey === 'string' ? group.sectionKey : '';
    const action = config.sectionActions === true && sectionKey
      ? ButtonComponent.renderActionButton({icon: 'more-vertical', presentation: 'bare',
        className: 'album-track-table__section-action', ariaLabel: `Actions for ${label || 'this section'}`,
        title: 'Add section to playlist', disabled: !tracks.length || group.sectionActionDisabled === true
          || tracks.some(track => track.readable === false || track.selectable === false),
        attributes: {'data-playtable-section-action': sectionKey}}) : '';
    const heading = showLabel
      ? `<h4 class="album-track-table__disc-heading">${escapeHtml(label)}</h4>`
      : '';
    const header = action ? `<div class="album-track-table__section-heading">${heading}${action}</div>` : heading;
    return `<section class="album-track-table__disc"${sectionKey ? ` data-playtable-section="${escapeHtml(sectionKey)}"` : ''}>${header}${table}</section>`;
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
