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
    // Diagnostic: show what the response did carry.
    const summary = {
      keys: Object.keys(payload || {}),
      query: payload?.query ?? payload?.q,
      groups: ['artist_groups', 'primary_artist_groups', 'family_artist_groups', 'albums']
        .map((field) => [field, (payload?.[field] || []).map((group) => ({
          name: group?.name || group?.artist || group?.title,
          albums: (group?.albums || []).map((entry) => entry?.name || entry?.title),
        }))]),
      flags: Object.fromEntries(Object.entries(payload || {}).filter(([, value]) => typeof value !== 'object')),
    };
    throw new Error(`View-data response did not contain album "${expectedName}". ${JSON.stringify(summary).slice(0, 4000)}`);
  }
  return {
    appRating: album?.album_preference?.rating ?? null,
    summaryAppRating: album?.gallery_list_block?.summary?.album_preference?.rating ?? null,
    tagRating: album?.tag_album_rating ?? null,
  };
}
