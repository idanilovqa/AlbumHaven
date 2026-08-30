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
  if (!album) throw new Error(`View-data response did not contain album "${expectedName}".`);
  return {
    appRating: album?.album_preference?.rating ?? null,
    summaryAppRating: album?.gallery_list_block?.summary?.album_preference?.rating ?? null,
    tagRating: album?.tag_album_rating ?? null,
  };
}
