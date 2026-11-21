function albumPayloadsFromGroups(payload) {
  const albums = [];
  for (const field of ['artist_groups', 'primary_artist_groups', 'family_artist_groups']) {
    for (const group of payload?.[field] || []) {
      for (const album of group?.albums || []) albums.push(album);
    }
  }
  return albums;
}

export function readAlbumRatingAuthority(payload, albumName) {
  const expectedName = String(albumName || '').trim();
  const album = albumPayloadsFromGroups(payload).find(
    (candidate) => String(candidate?.name || candidate?.title || '').trim() === expectedName,
  );
  if (!album) {
    const observed = albumPayloadsFromGroups(payload)
      .map((candidate) => String(candidate?.name || candidate?.title || '').trim());
    const groupCounts = ['artist_groups', 'primary_artist_groups', 'family_artist_groups']
      .map((field) => `${field}=${Array.isArray(payload?.[field]) ? payload[field].length : 'none'}`);
    throw new Error(
      `View-data response did not contain album "${expectedName}". `
      + `Payload: ${groupCounts.join(', ')}; albums=${JSON.stringify(observed.slice(0, 20))}; `
      + `query=${JSON.stringify(payload?.query ?? null)}; selected_artist=${JSON.stringify(payload?.selected_artist ?? null)}; `
      + `scan_in_progress=${JSON.stringify(payload?.scan_in_progress ?? null)}; `
      + `keys=${JSON.stringify(Object.keys(payload || {}).sort())}`,
    );
  }
  return {
    appRating: album?.album_preference?.rating ?? null,
    summaryAppRating: album?.gallery_list_block?.summary?.album_preference?.rating ?? null,
    tagRating: album?.tag_album_rating ?? null,
  };
}
