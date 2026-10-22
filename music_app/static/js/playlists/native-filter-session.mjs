import {createCollectionFilterSession} from '../collections/native-filter-session.mjs';

const playlistFilters = Object.freeze({resourceNamespace: 'playlist'});
export function createPlaylistFilterSession(controller, sourceIdentity, providers, onChange = () => {}) {
  return createCollectionFilterSession(playlistFilters, controller, sourceIdentity, providers, onChange);
}
