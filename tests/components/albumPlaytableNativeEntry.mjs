import {mountPlaytableSelection} from '/music_app/static/js/playtables/native-selection.mjs';
// Existing fixture names point directly to the actual production native owner.
window.mountResizeFixture=mountPlaytableSelection;
window.mountPreferenceFixture=mountPlaytableSelection;
window.mountGeometryFixture=mountPlaytableSelection;
window.mountAlbumSelectionFixture=mountPlaytableSelection;
window.AlbumHavenPlaytableUI={mount:mountPlaytableSelection};
