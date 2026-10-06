/** Fictional, in-memory read fixtures for the isolated real-UI design mock.
 * No app imports, persistence, network calls, credentials, or private media.
 * `path` fields below are opaque mock IDs or public mock asset URLs, never files.
 */
export const FIXTURE_VERSION = 'fixture-v002';
export const periods = [
  { id: 'week', label: 'Last week', factor: 1 },
  { id: 'month', label: 'Last month', factor: 4 },
  { id: 'six', label: 'Last 6 months', factor: 19 },
  { id: 'year', label: 'Last year', factor: 37 },
  { id: 'all', label: 'All time', factor: 82 },
];
export const people = [
  { id: 'me', name: 'Alex Morgan', handle: 'alex', bio: 'Long albums, late nights, and the occasional synth detour.', avatar: 'mountain', relationship: 'self' },
  { id: 'maya', name: 'Maya Chen', handle: 'maya', bio: 'Progressive rock, quiet electronics, and records that reward another listen.', avatar: 'ocean', relationship: 'accepted' },
  { id: 'sam', name: 'Sam Rivera', handle: 'sam', bio: 'A little jazz. A lot of guitar. Always listening to something new.', avatar: 'forest', relationship: 'accepted' },
  { id: 'noor', name: 'Noor Ellis', handle: 'noor', bio: 'Finding small details in big sounds.', avatar: 'desert', relationship: 'incoming' },
  { id: 'theo', name: 'Theo Park', handle: 'theo', bio: 'Instrumental music for wandering minds.', avatar: 'forest', relationship: 'outgoing' },
  { id: 'iris', name: 'Iris Stone', handle: 'iris', bio: 'No profile description yet.', avatar: 'ocean', relationship: 'none' },
  { id: 'robin', name: 'Robin Vale', handle: 'robin', bio: 'Taking a little break from sharing.', avatar: 'desert', relationship: 'blocked' },
];
export const artists = [
  { id: 'north', name: 'Northbound', genre: 'Progressive rock', image: 'mountain', bio: 'A fictional five-piece tracing patient melodies through spacious arrangements and shifting rhythms. Their records are built for a start-to-finish listen.', formed: '2014', place: 'Bergen, Norway' },
  { id: 'glass', name: 'Glass Harbour', genre: 'Ambient · Electronic', image: 'ocean', bio: 'A fictional duo blending tape loops, soft-edged synthesis and field recordings into unhurried, cinematic albums.', formed: '2018', place: 'Bristol, UK' },
  { id: 'sun', name: 'Sun Atlas', genre: 'Jazz fusion', image: 'desert', bio: 'An imaginary collective drawing warm brass, syncopated drums and electric guitar into open-ended compositions.', formed: '2011', place: 'Lisbon, Portugal' },
  { id: 'cedar', name: 'Cedar & Sky', genre: 'Folk · Post-rock', image: 'forest', bio: 'An invented group pairing close-miked acoustic instruments with broad, slow-building instrumental landscapes.', formed: '2020', place: 'Portland, USA' },
];
export const albumSeeds = [
  { id: 'a1', title: 'Between the Pines', artist: 'north', year: 2024, art: 'mountain', tracks: ['First Light', 'The Long Way Home', 'Weather Lines', 'Below the Snow', 'Everything Returns', 'The Last Ridge'], counts: { me: 42, maya: 30, sam: 5, noor: 12, theo: 18 }, full: { me: 6, maya: 4, sam: 0, noor: 1, theo: 2 }, recent: 1 },
  { id: 'a2', title: 'Tidal Memory', artist: 'glass', year: 2025, art: 'ocean', tracks: ['Low Tide', 'Undertow', 'A Shape in Water', 'Blue Hours', 'Still, Moving'], counts: { me: 28, maya: 41, sam: 0, noor: 9, theo: 0 }, full: { me: 4, maya: 7, sam: 0, noor: 1, theo: 0 }, recent: 2 },
  { id: 'a3', title: 'The Amber Hours', artist: 'sun', year: 2023, art: 'desert', tracks: ['Heat Haze', 'Golden Ratio', 'Side Streets', 'Slow Orbit', 'After the Rain', 'Night Bus', 'Open Windows'], counts: { me: 23, maya: 0, sam: 48, noor: 0, theo: 5 }, full: { me: 2, maya: 0, sam: 6, noor: 0, theo: 0 }, recent: 3 },
  { id: 'a4', title: 'A Room for the Wind', artist: 'cedar', year: 2025, art: 'forest', tracks: ['Roots', 'A Room for the Wind', 'Soft Earth', 'Where We Left Off', 'Birdsong'], counts: { me: 19, maya: 26, sam: 12, noor: 16, theo: 0 }, full: { me: 3, maya: 4, sam: 1, noor: 2, theo: 0 }, recent: 4 },
  { id: 'a5', title: 'Far From Shore', artist: 'glass', year: 2022, art: 'ocean', tracks: ['Departure', 'Distant Coast', 'Beacon', 'No Signal'], counts: { me: 0, maya: 18, sam: 8, noor: 0, theo: 0 }, full: { me: 0, maya: 4, sam: 1, noor: 0, theo: 0 }, recent: 5 },
  { id: 'a6', title: 'The Quiet Return', artist: 'north', year: 2021, art: 'mountain', tracks: ['Into the Valley', 'Old Maps', 'The Quiet Return', 'A Clear Sky'], counts: { me: 12, maya: 16, sam: 0, noor: 7, theo: 0 }, full: { me: 2, maya: 3, sam: 0, noor: 1, theo: 0 }, recent: 6 },
  { id: 'a7', title: 'Unmapped Sessions', artist: 'sun', year: 2026, art: 'desert', tracks: ['Session One', 'Session Two', 'Session Three'], counts: { me: 7, maya: 0, sam: 11, noor: 0, theo: 0 }, full: { me: null, maya: null, sam: null, noor: null, theo: null }, recent: 7, external: true },
  { id: 'a8', title: 'An Empty Horizon', artist: 'cedar', year: 2020, art: 'forest', tracks: ['Horizon', 'Long Shadows', 'Return to the Forest', 'Home Again'], counts: { me: 0, maya: 0, sam: 0, noor: 0, theo: 0 }, full: { me: 0, maya: 0, sam: 0, noor: 0, theo: 0 }, recent: 8 },
];

const ACTION_NAMES = [
  'app.shell.read', 'app.bootstrap.read', 'app.status.read', 'library.browse.read',
  'library.artwork.read', 'library.media.read', 'library.virtual_discography.read',
  'library.virtual_discography.create', 'integration.lastfm.now_playing',
  'integration.lastfm.scrobble', 'integration.lastfm.complete', 'library.files.edit_tags',
  'library.covers.remote.read', 'library.covers.lookup', 'library.covers.lookup.cancel',
  'library.covers.fetch', 'library.covers.fetch.cancel', 'library.covers.write',
  'library.covers.upload', 'library.covers.link', 'library.covers.tasks.read',
  'library.covers.tasks.manage', 'library.inventory.manage', 'library.covers.delete',
  'accounts.read', 'accounts.create', 'accounts.manage', 'accounts.membership.manage',
  'accounts.capabilities.manage', 'accounts.sessions.revoke', 'accounts.welcome.send',
  'accounts.password_reset.send', 'accounts.invitation.copy', 'accounts.invitation.send',
  'accounts.reauthenticate', 'library.loops.create', 'library.loops.read',
  'library.loops.media.read', 'library.loops.preview', 'library.problems.read',
  'library.files.repair', 'library.rules.read', 'library.rules.manage',
  'library.versions.manage', 'library.logs.read', 'library.logs.export', 'library.files.move',
  'integration.settings.read', 'integration.foobar.read', 'integration.lastfm.manage',
  'integration.lastfm.scrobbles.submit', 'integration.local_playlists.analyze',
  'integration.local_playlists.import', 'library.discovery.read', 'library.discovery.lookup',
  'library.discovery.preferences.manage', 'library.opinions.read', 'library.resources.read',
  'library.files.open_location', 'library.filesystem.browse', 'library.loops.delete',
  'library.loops.reorder', 'library.notes.manage', 'library.playlists.create',
  'library.playlists.manage', 'library.playlists.items.manage', 'library.playlists.cover.manage',
  'library.playlists.settings.manage', 'library.playlists.access.manage',
  'library.ratings.import', 'library.refresh', 'library.refresh.cancel',
  'library.refresh.read', 'library.settings.read', 'library.settings.manage',
  'library.tasks.read', 'library.track_preferences.manage',
  'account.self.read', 'account.self.appearance.read', 'account.self.appearance.write',
  'account.self.appearance.selection_accent.read', 'account.self.appearance.selection_accent.update',
  'account.self.password.change', 'account.self.password_suggestion.dismiss',
  'account.self.library_warning.dismiss', 'auth.session.logout',
  'capability.view', 'capability.play', 'capability.edit', 'capability.change_covers',
  'capability.delete', 'capability.admin', 'capability.create_loop', 'capability.practice',
  'capability.repair', 'capability.move',
];
// Presentation fixture only: retain the owner's native chrome and controls.
// This is NOT real authority. The dispatcher still rejects every mutation and
// unsupported provider/native endpoint, and the parent blocks streaming.
export const allowedActions = Object.freeze(Object.fromEntries(ACTION_NAMES.map(name => [name, true])));
const copy = value => JSON.parse(JSON.stringify(value));
export const image = name => `/mock-assets/${name}.jpg`;
export const byArtist = id => artists.find(artist => artist.id === id || artist.name === id);
const durationDisplay = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const preference = rating => ({ rating, love_tier: null, loved: false, disliked: false,
  allowed_actions: { can_rate: false, can_set_love_tier: false, client_surface_class: 'web' } });
const hiddenCrowd = { is_visible: false, blended_score_10: null, display_stars: null, source_count_used: null, source_count_total: null, freshness_state: 'missing' };
const hiddenFriends = { is_visible: false, average_rating: null, rating_count: null, freshness_state: 'missing' };
const hiddenPopularity = { is_visible: false, scrobble_count: null, listener_count: null, matched_track_count: null, total_track_count: null, available_sort_metrics: [], freshness_state: 'missing' };

export const albums = albumSeeds.map((seed, albumIndex) => {
  const artist = byArtist(seed.artist);
  const coverPath = image(seed.art);
  const tracks = seed.tracks.map((title, index) => ({
    path: `mock-track:${seed.id}:${index + 1}`, track_ref: `mock-track:${seed.id}:${index + 1}`,
    title, artist: artist.name, album_artist: artist.name, album: seed.title,
    track_number: index + 1, disc_number: 1, disc_number_raw: '1',
    duration_seconds: (4 + index % 4) * 60 + 12 + (index * 7 % 48),
    year: seed.year, cover_path: coverPath, is_problematic: false,
    allowed_actions: { ...allowedActions },
  }));
  const totalSeconds = tracks.reduce((sum, track) => sum + track.duration_seconds, 0);
  const trackRows = tracks.map(track => ({
    ...track, secondary_artist: null, duration_display: durationDisplay(track.duration_seconds),
    title_display: { active_mode: 'local_tags', supported_modes: ['local_tags', 'provider_title'],
      provider_title: null, provider_title_state: 'unavailable', mismatch_state: 'hidden',
      apply_provider_to_tags_action: { is_available: false, action_kind: 'apply_provider_title_to_tags', request_route: null, request_method: null, action_state: 'noop' } },
    track_preference: preference(null), track_stats: { scrobble_count: 0 },
    track_popularity: { ...hiddenPopularity }, playback_state: { is_current: false, is_playing: false },
    can_edit_preferences: false,
  }));
  const album = {
    id: seed.id, key: `mock-album:${seed.id}`, album_ref: `mock-album:${seed.id}`,
    name: seed.title, title: seed.title, album_artist: artist.name, artists: [artist.name],
    year: seed.year, release_date: `${seed.year}-06-01`, edition: '', release_type: 'ALBUM',
    is_compilation: false, inventory_status: 'present', missing_since: '',
    cover_path: coverPath, cover_revision: FIXTURE_VERSION,
    cover_preview_url: `${coverPath}?path=${encodeURIComponent(coverPath)}&v=${FIXTURE_VERSION}`,
    remote_cover_url: '', remote_cover_thumbnail_url: '', remote_cover_source: '',
    album_rating: 0, album_preference: preference([8, 9, 8, 7, null, 8, null, null][albumIndex]),
    tag_album_rating: null, tag_album_rating_source: null,
    top_viewer_overlay: {}, crowd_opinion: { ...hiddenCrowd }, friends_opinion: { ...hiddenFriends },
    album_popularity: { ...hiddenPopularity },
    total_duration_seconds: totalSeconds, total_duration_display: durationDisplay(totalSeconds),
    track_count: tracks.length, track_count_preview: tracks.length,
    tracks, track_rows: trackRows, track_paths: tracks.map(track => track.path),
    preview_only: false, duplicate_sources: [], open_directory_paths: [],
    library_root_category: 'main_library', root_provenance: { categories: ['main_library'] },
    move_availability: null, allowed_actions: { ...allowedActions },
    mock: { fictional: true, artist_id: seed.artist, art: seed.art, recent: seed.recent,
      counts: { ...seed.counts }, full: { ...seed.full }, external: Boolean(seed.external),
      playback_available: false },
  };
  album.gallery_list_block = {
    block_kind: 'album', album_key: album.key,
    summary: { title: album.name, album_artist: album.album_artist, year: album.year,
      album_rating: 0, album_preference: copy(album.album_preference), tag_album_rating: null,
      tag_album_rating_source: null, track_count: tracks.length,
      total_duration_seconds: totalSeconds, total_duration_display: album.total_duration_display,
      crowd_opinion: { ...hiddenCrowd }, friends_opinion: { ...hiddenFriends }, album_popularity: { ...hiddenPopularity } },
    track_rows_source: 'inline', track_rows: trackRows,
    trailing_divider: { total_duration_seconds: totalSeconds, total_duration_display: album.total_duration_display },
  };
  return album;
});
export const byAlbum = id => albums.find(album => album.id === id || album.key === id);

export function buildShellLayout(selectedArtist = '', activeSurface = 'albums') {
  return {
    kind: 'shared_media_shell', slots: {
      app_bar: { content_kind: 'global_search_toolbar', header_surfaces: {
        shared_badge_primitives: true, shared_drawer_primitives: true,
        notifications: { entry_kind: 'operational_drawer', badge_kind: 'operational_notifications', drawer_slot: 'info_drawer', default_drawer_content_kind: 'cover_lookup_drawer', supported_drawer_content_kinds: ['cover_lookup_drawer'], drawer_content_kind: 'cover_lookup_drawer', page_route: null },
        discovery_center: { entry_kind: 'drawer_plus_page', badge_kind: 'discovery_center', drawer_content_kind: 'discovery_center_preview', page_route: '/news' },
      } },
      navigation_rail: { content_kind: 'artists_sidebar', default_collapsed: false },
      contextual_pane: { content_kind: 'contextual_navigation', is_visible: Boolean(selectedArtist),
        active_pane: selectedArtist ? 'artist_gallery' : 'local_tree',
        supported_panes: ['local_tree', 'playlists', 'album_tops', 'artist_gallery'],
        splitter: { desktop_only: true, axis: 'inline', placement: 'left', state_scope: 'local_first', mobile_fallback: 'drawer' },
        local_tree: { default_submode: 'artists', active_submode: 'artists', supported_submodes: ['artists'] } },
      main_content: { surface_ref: activeSurface, content_kind: 'gallery' },
      info_drawer: { component_kind: 'notification_drawer', content_kind: 'cover_lookup_drawer', default_content_kind: 'cover_lookup_drawer', supported_content_kinds: ['cover_lookup_drawer'], surface_family: 'notifications', default_surface_family: 'notifications', placement: 'right', is_optional: true,
        splitter: { desktop_only: true, axis: 'inline', placement: 'right', state_scope: 'local_first', mobile_fallback: 'sheet_or_drawer' } },
      bottom_player: { content_kind: 'global_player', is_persistent: true },
    },
  };
}

function paramsFor(search = '') {
  if (search instanceof URLSearchParams) return new URLSearchParams(search);
  if (search instanceof URL) return new URLSearchParams(search.search);
  const raw = String(search || '');
  return raw.startsWith('?') || !raw.includes('/')
    ? new URLSearchParams(raw.replace(/^\?/, ''))
    : new URL(raw, 'https://mock.invalid').searchParams;
}
function groupAlbums(records) {
  return artists.map(artist => ({
    artist: artist.name, artist_display: artist.name,
    artist_summary: artist.bio, artist_image_url: image(artist.image), wikipedia_url: '',
    albums: records.filter(album => album.album_artist === artist.name),
  })).filter(group => group.albums.length > 0);
}
function previewAlbum(album) {
  return { ...copy(album), preview_only: true, tracks: [], track_rows: [], track_paths: [],
    gallery_list_block: { ...copy(album.gallery_list_block), track_rows_source: 'album_details', track_rows: [] } };
}
export function recentAlbumIds(person = 'me', limit = 4) {
  return albumSeeds.filter(album => (album.counts[person] || 0) > 0)
    .sort((a, b) => a.recent - b.recent).slice(0, limit).map(album => album.id);
}

// Search selection is part of the same fictional response as the results, so
// native request/revision guards own it. Never select a tree row asynchronously.
function rankedSearchArtists(records, needle) {
  const ranks = new Map();
  for (const album of records) {
    const fields = [album.album_artist, album.name, ...album.tracks.map(track => track.title)];
    for (const [index, value] of fields.entries()) {
      const text = value.trim().toLowerCase();
      const quality = text === needle ? 0 : text.startsWith(needle) ? 1 : text.includes(needle) ? 2 : 3;
      if (quality === 3) continue;
      const score = quality * 3 + Math.min(index, 2);
      ranks.set(album.album_artist, Math.min(ranks.get(album.album_artist) ?? Infinity, score));
    }
  }
  return [...ranks].sort((a, b) => a[1] - b[1] || (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0)).map(([artist]) => artist);
}

/** Native buildUrl drops mock_* query keys. Preserve `options.source/person/albumIds`
 * in the mock route coordinator while navigating a filtered Recent source.
 */
export function buildView(search = '', options = {}) {
  const params = paramsFor(search);
  const query = (params.get('q') || '').trim();
  const allArtistsRequested = params.get('all_artists') === '1';
  const selectedInput = (params.get('artist') || '').trim();
  const requestedArtist = byArtist(selectedInput)?.name || selectedInput;
  const source = options.source || params.get('mock_source') || 'library';
  const person = options.person || params.get('mock_person') || 'me';
  const selectedIds = options.albumIds || (source === 'recent' ? recentAlbumIds(person, options.limit || 4) : null);
  const categories = params.getAll('category').filter(value => ['main_library', 'new_arrivals', 'hoard'].includes(value));
  const visibleCategories = categories.length ? categories : ['main_library', 'new_arrivals', 'hoard'];
  const galleryScope = params.get('gallery_scope') === 'new_arrivals' ? 'new_arrivals' : 'all';
  let scoped = albums.filter(album => !selectedIds || selectedIds.includes(album.id) || selectedIds.includes(album.key));
  scoped = scoped.filter(album => visibleCategories.includes(album.library_root_category));
  if (galleryScope === 'new_arrivals') scoped = []; // Recent listening is not New Arrivals.
  const needle = query.toLowerCase();
  const matched = scoped.filter(album => !needle || [album.name, album.album_artist, ...album.tracks.map(track => track.title)].some(value => value.trim().toLowerCase().includes(needle)));
  const rankedArtists = needle ? rankedSearchArtists(matched, needle) : [];
  const selectedArtist = allArtistsRequested ? '' : requestedArtist || rankedArtists[0] || '';
  const activeSurface = params.get('surface') === 'home' && !query && !selectedArtist ? 'home' : 'albums';
  const visible = matched.filter(album => !selectedArtist || album.album_artist === selectedArtist);
  const groups = groupAlbums(visible.map(previewAlbum));
  // Recent constrains Gallery content, never the central artist navigation.
  const sidebarGroups = groupAlbums(source === 'recent' ? albums : (query ? matched : scoped));
  const displayMode = ['cards', 'covers', 'list'].includes(params.get('gallery_display')) ? params.get('gallery_display') : 'cards';
  const view = {
    surface: { active: activeSurface, default: 'home', supported: ['home', 'albums', 'playlists'], reserved: ['album_tops'] },
    surface_request: activeSurface, shell_layout: buildShellLayout(selectedArtist, activeSurface),
    payload_tier: 'full', initial_view_partial: false,
    artist_groups: groups, primary_artist_groups: selectedArtist ? groups : [], family_artist_groups: [],
    artists_sidebar: sidebarGroups.map(group => ({ artist: group.artist, artist_display: group.artist, count: group.albums.length })),
    related_artists: [], related_filter_artists: [], artist_family_filters: [], primary_filter_active: false,
    album_count: visible.length, artist_count: sidebarGroups.length,
    query, selected_artist: selectedArtist,
    all_artists_active: allArtistsRequested || (!query && !selectedArtist && activeSurface === 'albums'), show_all_artists_sidebar_link: true,
    gallery_scope: galleryScope, gallery_display_mode: displayMode,
    gallery_scale_percent: Math.max(80, Math.min(140, Number(params.get('gallery_scale_percent')) || 100)),
    selected_artist_family_display_mode: params.get('family_display') === 'chronological' ? 'chronological' : 'grouped',
    visible_library_categories: visibleCategories, loaded_library_categories: visibleCategories,
    sidebar_library_categories: visibleCategories, non_album_library_categories: visibleCategories,
    search_filters: { genre: [], mood: [], style: [], duration: { min_seconds: null, max_seconds: null } },
    search_filter_contract: null, search_query_contract: null,
    search_context: needle ? {
      selected_artist_source: selectedArtist ? (requestedArtist ? 'requested_artist' : 'auto_top_match') : '',
      artist_name_match_artists: rankedArtists.filter(name => name.toLowerCase().includes(needle)),
      direct_match_artists: rankedArtists, related_match_artists: [],
    } : null,
    music_dir: '', app_name: 'Album Haven', app_version: 'design-mock-v002',
    ignored_version_keys: [], manual_version_links: {}, non_album_tracks: [], non_album_exception_values: [],
    allowed_actions: { ...allowedActions }, playback_context: null,
    artist_page: selectedArtist ? { family_display_mode: params.get('family_display') === 'chronological' ? 'chronological' : 'grouped' } : null,
    mock: { fictional: true, source, person, album_ids: visible.map(album => album.id), media_available: false },
  };
  return view;
}
export const buildRecentView = (search = '', options = {}) => buildView(search, { ...options, source: 'recent' });

export function buildBootstrap(search = '', options = {}) {
  const initialView = buildView(search, options);
  const hydration = { required: false, trigger: 'none', endpoint: '/view-data', followupEndpoint: '', embeddedViewPatch: null, tier: 'full', reason: 'complete_fictional_design_fixture' };
  return {
    initial_view: initialView, startup_payload: { first_paint_view: copy(initialView) },
    bootstrap: { coverCacheToken: FIXTURE_VERSION, refreshed: false, lastScanDisplay: '',
      scanInProgress: false, scanPhase: 'idle', scanMode: 'idle', relationsInProgress: false,
      coversInProgress: false, partialView: false,
      startupPreview: { mode: 'design_fixture', isPartial: false, savedAtEpochMs: 0, renderStrategy: 'client', renderedGalleryMarkup: false },
      startupTiming: { serverRequestStartedAtEpochMs: 0, bootstrapPayloadReadyAtEpochMs: 0, payloadBuildMs: 0 },
      startupHydration: { ...hydration },
      startupPayloadTiers: { firstPaint: { kind: 'shell_plus_preview', targetFirstPaintMs: 500, previewMode: 'design_fixture', includesGalleryMarkup: false }, hydration: { ...hydration } },
    },
  };
}
export function buildAlbumDetails(albumKey) {
  const album = byAlbum(String(albumKey || ''));
  return album ? { ok: true, album: copy(album) } : { ok: false, error: 'Fictional album not found', code: 'MOCK_NOT_FOUND' };
}
export function buildStatus() {
  return { scan_in_progress: false, scan_generation: 0, scan_processed: 0, scan_total: 0, scan_percent: 0,
    scan_current_path: '', scan_elapsed_seconds: 0, scan_estimated_remaining_seconds: 0,
    scan_files_per_second: 0, scan_album_folders_processed: 0, scan_album_folders_total: 0,
    scan_phase: 'idle', scan_mode: 'idle', scan_outcome: 'idle', relations_in_progress: false,
    relations_processed: 0, relations_total: 0, relations_percent: 0, relations_phase: 'Idle', relations_source: 'local',
    relation_projection: { ready: true, builder_version: FIXTURE_VERSION, startup_rebuilt: false, rebuild_reason: '', duration_ms: 0 },
    covers_in_progress: false, covers_processed: 0, covers_total: 0, covers_downloaded: 0, covers_current_folder: '',
    pending_cover_refresh_after_scan: false, last_scan_display: '', last_error: '', album_total: albums.length,
    inventory_mutation_revision: 0, log_history_revision: '',
    watcher_health: { enabled: false, status: 'disabled', warning_token: '', dismissed: false, roots: [] },
    allowed_actions: { ...allowedActions }, mock: true };
}
export function unavailable(path = '', method = 'GET') {
  return { status: 501, body: { ok: false, code: 'MOCK_UNAVAILABLE', mock: true,
    error: 'Unavailable in this isolated design mock. No account, library, provider, or playback action was performed.',
    action: `${method} ${path}` } };
}

/** Pure request dispatcher; parent owns fetch/WebSocket installation and static serving.
 * Never returns success for unsupported native, provider, or account mutations.
 * `init.fixtureOptions` supplies the current isolated Recent-source context.
 */
export function handleFixtureRequest(input, init = {}) {
  const inputUrl = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
  const url = new URL(inputUrl || '/', 'https://mock.invalid');
  const method = String(init.method || input?.method || 'GET').toUpperCase();
  const path = url.pathname;
  if (!['GET', 'HEAD'].includes(method)) return unavailable(path, method);
  if (path === '/bootstrap-data') return { status: 200, body: buildBootstrap(url.search, init.fixtureOptions) };
  if (path === '/view-data' || path === '/home-data') return { status: 200, body: buildView(url.search, init.fixtureOptions) };
  if (path === '/album-details') {
    const key = url.searchParams.get('album_key');
    if (!key) return { status: 400, body: { ok: false, error: 'Missing album_key', code: 'MOCK_BAD_REQUEST' } };
    const body = buildAlbumDetails(key);
    return { status: body.ok ? 200 : 404, body };
  }
  if (path === '/status') return { status: 200, body: buildStatus() };
  if (path === '/utilities/cover-lookup/tasks') return { status: 200, body: { ok: true, tasks: [], allowed_actions: { ...allowedActions }, mock: true } };
  // The static server/transport owns exact allowlisted artwork URLs (including /cover).
  if (path === '/cover') {
    return albums.some(album => album.cover_path === url.searchParams.get('path')) ? null : unavailable(path, method);
  }
  if (path === '/' || path.startsWith('/static/') || path.startsWith('/mock-assets/') || path.endsWith('.mjs') || path.endsWith('.css') || path === '/favicon.ico') return null;
  return unavailable(path, method);
}
