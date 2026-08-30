function formatRuleFieldLabel(field) {
  return String(field || 'problem').replaceAll('_', ' ');
}

function getProblemIgnoreGroupTitle(group) {
  const parts = [];
  if (group.artist) parts.push(group.artist);
  if (group.album) parts.push(group.album);
  if (group.year) parts.push(group.year);
  const title = parts.join(' - ') || 'Unknown album';
  return `${title} (${group.items.length} file${group.items.length === 1 ? '' : 's'})`;
}

function groupProblemIgnoreItems(items) {
  const grouped = new Map();
  items.forEach((item) => {
    const key = String(item?.album_group_key || '').trim()
      || [item?.artist, item?.album].map((value) => String(value || '').trim()).filter(Boolean).join(' :: ')
      || String(item?.path || item?.row_key || '');
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        album: String(item?.album || '').trim(),
        artist: String(item?.artist || '').trim(),
        year: String(item?.year || '').trim(),
        items: [],
      });
    }
    grouped.get(key).items.push(item);
  });
  return Array.from(grouped.values())
    .map((group) => ({
      ...group,
      items: group.items.slice().sort((a, b) => String(a?.filename || '').localeCompare(String(b?.filename || ''), undefined, { sensitivity: 'base' })),
    }))
    .sort((a, b) => {
      const artistCompare = String(a.artist || '').localeCompare(String(b.artist || ''), undefined, { sensitivity: 'base' });
      if (artistCompare) return artistCompare;
      return getProblemIgnoreGroupTitle(a).localeCompare(getProblemIgnoreGroupTitle(b), undefined, { sensitivity: 'base' });
    });
}

function getProblematicAlbumDisplayValue(album, field, showConverted) {
  const repairRows = Array.isArray(album?.repair_preview_rows) ? album.repair_preview_rows : [];
  const matchingRow = repairRows.find((row) => row.field === field);
  if (field === 'album') {
    return showConverted
      ? (matchingRow?.repaired || album?.name || album?.raw_name || '')
      : (matchingRow?.original || album?.raw_name || album?.name || '');
  }
  if (field === 'album_artist') {
    return showConverted
      ? (matchingRow?.repaired || album?.album_artist || album?.raw_album_artist || '')
      : (matchingRow?.original || album?.raw_album_artist || album?.album_artist || '');
  }
  return '';
}

function getProblematicTrackDisplayTitle(album, row, showConverted) {
  const convertedTrack = (Array.isArray(album?.tracks) ? album.tracks : [])
    .find((track) => String(track.path || '') === String(row?.path || ''));
  if (row?.field === 'title') {
    return showConverted
      ? (row.repaired || convertedTrack?.title || row.track_title || '')
      : (row.original || row.track_title || convertedTrack?.title || '');
  }
  return showConverted
    ? (convertedTrack?.title || row?.track_title || '')
    : (row?.track_title || convertedTrack?.title || '');
}

function formatRepairFieldLabel(field) {
  const value = String(field || '');
  if (value === 'album_disc_marker') return 'Album + disc number';
  return value.replaceAll('_', ' ');
}

function buildDiscogsSearchUrl(album) {
  const meaningful = (value) => {
    const text = String(value ?? '').trim();
    return text && !['unknown', 'unknown artist', 'unknown album', 'n/a', 'none', 'null'].includes(text.toLowerCase())
      ? text
      : '';
  };
  const artist = meaningful(getProblematicAlbumDisplayValue(album, 'album_artist', true) || album?.album_artist);
  const title = meaningful(getProblematicAlbumDisplayValue(album, 'album', true) || album?.name);
  const year = meaningful(album?.year);
  const query = [artist, title, year].filter(Boolean).join(' ');
  const params = new URLSearchParams({
    q: query || meaningful(album?.raw_album_artist) || meaningful(album?.raw_name) || 'music release',
    type: 'release',
  });
  return `https://www.discogs.com/search/?${params.toString()}`;
}

function getFileTypeFromPath(path) {
  const filename = String(path || '').split(/[\\/]/).pop() || '';
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === filename.length - 1) return '';
  return filename.slice(dotIndex + 1).trim().toUpperCase();
}

function getFilenameFromPath(path) {
  return String(path || '').split(/[\\/]/).pop() || '';
}

function getProblematicAlbumFileTypes(album) {
  if (Array.isArray(album?.file_types) && album.file_types.length) {
    return album.file_types.map((value) => String(value || '')).filter(Boolean);
  }
  return Array.from(new Set((Array.isArray(album?.tracks) ? album.tracks : [])
    .map((track) => getFileTypeFromPath(track.path))
    .filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function getRepairRowFileType(row) {
  return getFileTypeFromPath(row?.path);
}
