import {createEditRequestNotifications} from '../home-friends/edit-request-notifications.mjs';

export function createPlaylistEditNotifications(options) {
  return createEditRequestNotifications({...options, sourceName: 'playlist-edit-requests',
    label: 'Playlist edit requests', typeLabel: 'Playlist', resourceKey: 'playlist_id'});
}
