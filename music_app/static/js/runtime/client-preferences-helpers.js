const PLAYER_APPEARANCE_STORAGE_KEY = 'albumhaven.playerAppearance.v1';
const COMBINE_SIMILAR_ARTISTS_STORAGE_KEY = 'albumhaven.combineSimilarArtists.v1';
const GALLERY_DISPLAY_PREFERENCES_STORAGE_KEY = 'albumhaven.galleryDisplayPreferences.v1';
const GALLERY_PLAYBACK_PREFERENCES_STORAGE_KEY = 'albumhaven.galleryPlaybackPreferences.v1';
const ALBUM_OPEN_MODE_STORAGE_KEY = 'albumhaven.albumOpenMode.v1';
const SHELL_LAYOUT_PREFERENCES_STORAGE_KEY = 'albumhaven.shellLayoutPreferences.v1';

function loadPersistedJsonObject(key) {
  try {
    const raw = getLocalStorageItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function getDefaultPlayerAppearance() {
  return {
    seekbarMode: 'default',
    waveformFillColor: '#dadde2',
    waveformEdgeColor: '#494950',
  };
}

function normalizeClientGalleryDisplayMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'covers' || normalized === 'list' ? normalized : 'cards';
}

function normalizeClientGalleryScalePercent(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 80 && normalized <= 140
    ? normalized
    : 100;
}

function getDefaultGalleryDisplayPreferences() {
  return {
    defaultGalleryDisplayMode: 'cards',
    defaultGalleryScalePercent: 100,
  };
}

function normalizeGalleryPlaybackEndBehavior(value, fallback = 'continue') {
  const normalizedFallback = String(fallback || '').trim().toLowerCase() === 'stop'
    ? 'stop'
    : 'continue';
  const normalized = String(value ?? normalizedFallback).trim().toLowerCase();
  return normalized === 'stop' || normalized === 'continue'
    ? normalized
    : normalizedFallback;
}

function getDefaultGalleryPlaybackPreferences() {
  return {
    albumTopsEndBehavior: 'continue',
    artistPagesEndBehavior: 'stop',
  };
}

function getDefaultShellLayoutPreferences() {
  return {
    contextualPaneWidthPx: 320,
    infoDrawerWidthPx: 360,
  };
}

function getDefaultAlbumOpenMode() {
  return 'modal';
}

function normalizeGalleryDisplayPreferences(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaults = getDefaultGalleryDisplayPreferences();
  return {
    defaultGalleryDisplayMode: normalizeClientGalleryDisplayMode(source.defaultGalleryDisplayMode),
    defaultGalleryScalePercent: normalizeClientGalleryScalePercent(
      source.defaultGalleryScalePercent ?? defaults.defaultGalleryScalePercent,
    ),
  };
}

function normalizeGalleryPlaybackPreferences(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaults = getDefaultGalleryPlaybackPreferences();
  return {
    albumTopsEndBehavior: normalizeGalleryPlaybackEndBehavior(
      source.albumTopsEndBehavior,
      defaults.albumTopsEndBehavior,
    ),
    artistPagesEndBehavior: normalizeGalleryPlaybackEndBehavior(
      source.artistPagesEndBehavior,
      defaults.artistPagesEndBehavior,
    ),
  };
}

function normalizeShellLayoutWidth(value, fallback) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 240 && normalized <= 520
    ? normalized
    : fallback;
}

function normalizeShellLayoutPreferences(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaults = getDefaultShellLayoutPreferences();
  return {
    contextualPaneWidthPx: normalizeShellLayoutWidth(
      source.contextualPaneWidthPx,
      defaults.contextualPaneWidthPx,
    ),
    infoDrawerWidthPx: normalizeShellLayoutWidth(
      source.infoDrawerWidthPx,
      defaults.infoDrawerWidthPx,
    ),
  };
}

function normalizeAlbumOpenMode(value) {
  const normalized = String(value || getDefaultAlbumOpenMode()).trim().toLowerCase();
  return normalized === 'page' ? 'page' : 'modal';
}

function normalizePlayerAppearance(input = {}) {
  const defaults = getDefaultPlayerAppearance();
  const mode = String(input.seekbarMode || defaults.seekbarMode);
  const fill = /^#[0-9a-f]{6}$/i.test(String(input.waveformFillColor || ''))
    ? String(input.waveformFillColor)
    : defaults.waveformFillColor;
  const edge = /^#[0-9a-f]{6}$/i.test(String(input.waveformEdgeColor || ''))
    ? String(input.waveformEdgeColor)
    : defaults.waveformEdgeColor;
  return {
    seekbarMode: mode === 'waveform' ? 'waveform' : 'default',
    waveformFillColor: fill,
    waveformEdgeColor: edge,
  };
}

function loadCombineSimilarArtistsPreferences() {
  return loadPersistedJsonObject(COMBINE_SIMILAR_ARTISTS_STORAGE_KEY);
}

function loadGalleryDisplayPreferences() {
  return normalizeGalleryDisplayPreferences(
    loadPersistedJsonObject(GALLERY_DISPLAY_PREFERENCES_STORAGE_KEY),
  );
}

function loadGalleryPlaybackPreferences() {
  return normalizeGalleryPlaybackPreferences(
    loadPersistedJsonObject(GALLERY_PLAYBACK_PREFERENCES_STORAGE_KEY),
  );
}

function loadShellLayoutPreferences() {
  return normalizeShellLayoutPreferences(
    loadPersistedJsonObject(SHELL_LAYOUT_PREFERENCES_STORAGE_KEY),
  );
}

function loadAlbumOpenMode() {
  return normalizeAlbumOpenMode(getLocalStorageItem(ALBUM_OPEN_MODE_STORAGE_KEY));
}

function persistCombineSimilarArtistsPreferences() {
  setLocalStorageItem(
    COMBINE_SIMILAR_ARTISTS_STORAGE_KEY,
    JSON.stringify(state.gallery.combineSimilarArtistsByArtist || {}),
  );
}

function persistGalleryDisplayPreferences() {
  state.gallery.displayPreferences = normalizeGalleryDisplayPreferences(
    state.gallery.displayPreferences,
  );
  setLocalStorageItem(
    GALLERY_DISPLAY_PREFERENCES_STORAGE_KEY,
    JSON.stringify(state.gallery.displayPreferences),
  );
}

function persistGalleryPlaybackPreferences() {
  state.gallery.playbackPreferences = normalizeGalleryPlaybackPreferences(
    state.gallery.playbackPreferences,
  );
  setLocalStorageItem(
    GALLERY_PLAYBACK_PREFERENCES_STORAGE_KEY,
    JSON.stringify(state.gallery.playbackPreferences),
  );
}

function persistShellLayoutPreferences() {
  if (!state.ui || typeof state.ui !== 'object') {
    state.ui = {};
  }
  state.ui.shellLayoutPreferences = normalizeShellLayoutPreferences(
    state.ui.shellLayoutPreferences,
  );
  setLocalStorageItem(
    SHELL_LAYOUT_PREFERENCES_STORAGE_KEY,
    JSON.stringify(state.ui.shellLayoutPreferences),
  );
}

function persistAlbumOpenMode() {
  state.gallery.albumOpenMode = normalizeAlbumOpenMode(state.gallery?.albumOpenMode);
  setLocalStorageItem(ALBUM_OPEN_MODE_STORAGE_KEY, state.gallery.albumOpenMode);
}

function galleryPlaybackPreferenceFieldForKind(kind) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  if (normalizedKind === 'album_top') return 'albumTopsEndBehavior';
  if (normalizedKind === 'artist_page') return 'artistPagesEndBehavior';
  return '';
}

function resolveGalleryPlaybackEndBehavior(playbackContext, preferences = null) {
  const source = playbackContext && typeof playbackContext === 'object' && !Array.isArray(playbackContext)
    ? playbackContext
    : {};
  const preferenceField = galleryPlaybackPreferenceFieldForKind(source.kind);
  if (!preferenceField) {
    return normalizeGalleryPlaybackEndBehavior(source.end_behavior, 'continue');
  }
  const sourcePreferences = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
    ? preferences
    : state.gallery?.playbackPreferences;
  const normalizedPreferences = normalizeGalleryPlaybackPreferences(sourcePreferences);
  return normalizedPreferences[preferenceField];
}

function setGalleryPlaybackEndBehavior(kind, endBehavior) {
  const preferenceField = galleryPlaybackPreferenceFieldForKind(kind);
  if (!preferenceField) return null;
  state.gallery.playbackPreferences = normalizeGalleryPlaybackPreferences({
    ...(state.gallery.playbackPreferences || {}),
    [preferenceField]: endBehavior,
  });
  persistGalleryPlaybackPreferences();
  return state.gallery.playbackPreferences[preferenceField];
}

function restorePlayerAppearance() {
  const raw = getLocalStorageItem(PLAYER_APPEARANCE_STORAGE_KEY);
  if (!raw) {
    state.player.appearance = normalizePlayerAppearance(state.player.appearance);
    return state.player.appearance;
  }
  try {
    state.player.appearance = normalizePlayerAppearance(JSON.parse(raw));
  } catch (_error) {
    state.player.appearance = normalizePlayerAppearance(state.player.appearance);
  }
  return state.player.appearance;
}

function persistPlayerAppearance() {
  setLocalStorageItem(PLAYER_APPEARANCE_STORAGE_KEY, JSON.stringify(state.player.appearance));
}

function restorePersistedClientPreferences() {
  state.gallery.combineSimilarArtistsByArtist = loadCombineSimilarArtistsPreferences();
  state.gallery.displayPreferences = loadGalleryDisplayPreferences();
  state.gallery.playbackPreferences = loadGalleryPlaybackPreferences();
  state.gallery.albumOpenMode = loadAlbumOpenMode();
  if (!state.ui || typeof state.ui !== 'object') {
    state.ui = {};
  }
  state.ui.shellLayoutPreferences = loadShellLayoutPreferences();
  restorePlayerAppearance();
}

restorePersistedClientPreferences();
