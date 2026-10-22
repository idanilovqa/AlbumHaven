import {mountCollectionFilterSurface} from '../collections/native-filter-surface.mjs';

const playlistFilters = Object.freeze({
  title: 'Playlist filters', pageId: 'playlist-filters', className: 'playlists__filter-surface',
});
export function mountPlaylistFilterSurface(host, runtime, initial) {
  return mountCollectionFilterSurface(host, runtime, playlistFilters, initial);
}
