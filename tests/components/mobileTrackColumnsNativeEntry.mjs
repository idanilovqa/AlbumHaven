import {mountPlaylistTracks} from '/music_app/static/js/playlists/native-track-table.mjs';
import {mountActivityPanel} from '/music_app/static/js/home-friends/activity.mjs';
import {bindTrackTablePresentation} from '/music_app/static/js/playtables/track-table-presentation.mjs';
// Actual native owners; the browser fixture supplies only DTOs and runtime ports.
window.componentFixture={mountPlaylistTracks,mountActivityPanel,bindTrackTablePresentation};
window.bindTrackTablePresentation=bindTrackTablePresentation;
