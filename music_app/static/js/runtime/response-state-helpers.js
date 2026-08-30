const DEFAULT_STATUS_STATE = Object.freeze({
  scan_in_progress: false,
  scan_processed: 0,
  scan_total: 0,
  scan_percent: 0,
  scan_current_path: '',
  scan_elapsed_seconds: 0,
  scan_estimated_remaining_seconds: 0,
  scan_files_per_second: 0,
  scan_album_folders_processed: 0,
  scan_album_folders_total: 0,
  scan_phase: 'idle',
  scan_mode: 'idle',
  relations_in_progress: false,
  relations_processed: 0,
  relations_total: 0,
  relations_percent: 0,
  relations_phase: 'Idle',
  relations_source: 'local',
  covers_in_progress: false,
  covers_processed: 0,
  covers_total: 0,
  covers_downloaded: 0,
  covers_current_folder: '',
  pending_cover_refresh_after_scan: false,
  last_scan_display: '',
  last_error: '',
  album_total: 0,
});

const DEFAULT_LIBRARY_CATEGORIES = Object.freeze(['main_library', 'hoard', 'new_arrivals']);
function isRuntimePlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneRuntimeArray(value, fallback = []) {
  return Array.isArray(value) ? [...value] : [...fallback];
}

function cloneRuntimeObject(value, fallback = {}) {
  return isRuntimePlainObject(value) ? { ...value } : { ...fallback };
}

function cloneRuntimeJson(value, fallback = null) {
  if (value === undefined) {
    return fallback;
  }
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned === undefined ? fallback : cloned;
  } catch (_error) {
    return fallback;
  }
}

function normalizeRuntimeString(value, fallback = '') {
  if (value === null || value === undefined) return String(fallback || '');
  return String(value);
}

function normalizeRuntimeNumber(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : Number(fallback || 0);
}

function normalizeRuntimeBoolean(value, fallback = false) {
  if (value === null || value === undefined) return Boolean(fallback);
  return Boolean(value);
}

function normalizeRuntimeSearchFilterValues(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => value && !seen.has(value.toLowerCase()) && seen.add(value.toLowerCase()));
}

function normalizeRuntimeOptionalInt(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function normalizeRuntimeGalleryDisplayMode(value, fallback = 'cards') {
  const normalized = normalizeRuntimeString(value, fallback).trim().toLowerCase();
  return normalized === 'covers' || normalized === 'list' ? normalized : 'cards';
}

function normalizeRuntimeSelectedArtistFamilyDisplayMode(value, fallback = 'grouped') {
  const normalized = normalizeRuntimeString(value, fallback).trim().toLowerCase();
  return normalized === 'chronological' ? 'chronological' : 'grouped';
}

function getRuntimeNavigationRailContentKind(view = {}) {
  return String(view?.shell_layout?.slots?.navigation_rail?.content_kind || 'artists_sidebar')
    .trim()
    .toLowerCase();
}

function normalizeRuntimeGalleryScalePercent(value, fallback = 100) {
  const normalized = Number(value);
  if (Number.isInteger(normalized)) {
    return normalized;
  }
  const base = Number(fallback);
  return Number.isInteger(base) ? base : 100;
}

function normalizeRuntimeSearchFilters(filters, fallback = null) {
  const source = isRuntimePlainObject(filters) ? filters : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const baseDuration = isRuntimePlainObject(base.duration) ? base.duration : {};
  const sourceDuration = isRuntimePlainObject(source.duration) ? source.duration : {};
  return {
    genre: normalizeRuntimeSearchFilterValues(source.genre ?? base.genre),
    mood: normalizeRuntimeSearchFilterValues(source.mood ?? base.mood),
    style: normalizeRuntimeSearchFilterValues(source.style ?? base.style),
    duration: {
      min_seconds: normalizeRuntimeOptionalInt(sourceDuration.min_seconds, normalizeRuntimeOptionalInt(baseDuration.min_seconds, null)),
      max_seconds: normalizeRuntimeOptionalInt(sourceDuration.max_seconds, normalizeRuntimeOptionalInt(baseDuration.max_seconds, null)),
    },
  };
}

function normalizeRuntimeStringList(values, fallback = []) {
  const seen = new Set();
  const sourceValues = Array.isArray(values) ? values : fallback;
  return sourceValues
    .map((value) => String(value || '').trim())
    .filter((value) => value && !seen.has(value) && seen.add(value));
}

function normalizeRuntimePlaybackContextAlbum(album, fallback = null) {
  if (!isRuntimePlainObject(album) && !isRuntimePlainObject(fallback)) {
    return null;
  }
  const source = isRuntimePlainObject(album) ? album : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const albumRef = normalizeRuntimeString(source.album_ref ?? base.album_ref, '').trim();
  if (!albumRef) return null;
  return {
    album_ref: albumRef,
    can_play: normalizeRuntimeBoolean(source.can_play, base.can_play),
  };
}

function normalizeRuntimePlaybackContext(playbackContext, fallback = null) {
  if (!isRuntimePlainObject(playbackContext) && !isRuntimePlainObject(fallback)) {
    return null;
  }
  const source = isRuntimePlainObject(playbackContext) ? playbackContext : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const orderedAlbumRefs = normalizeRuntimeStringList(
    source.ordered_album_refs,
    Array.isArray(base.ordered_album_refs) ? base.ordered_album_refs : [],
  );
  const albums = (Array.isArray(source.albums) ? source.albums : [])
    .map((album, index) => normalizeRuntimePlaybackContextAlbum(
      album,
      Array.isArray(base.albums) ? base.albums[index] : null,
    ))
    .filter(Boolean);
  if (!orderedAlbumRefs.length && !albums.length) {
    return null;
  }
  return {
    kind: normalizeRuntimeString(source.kind, base.kind).trim(),
    end_behavior: normalizeRuntimeString(source.end_behavior, base.end_behavior).trim(),
    ordered_album_refs: orderedAlbumRefs,
    albums,
  };
}

function normalizeRuntimeSearchFilterContractField(field, fallback = null) {
  if (!isRuntimePlainObject(field) && !isRuntimePlainObject(fallback)) {
    return null;
  }
  const source = isRuntimePlainObject(field) ? field : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const normalized = {
    ...base,
    ...source,
  };
  if (Object.prototype.hasOwnProperty.call(normalized, 'param')) {
    normalized.param = normalizeRuntimeString(normalized.param, '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'min_param')) {
    normalized.min_param = normalizeRuntimeString(normalized.min_param, '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'max_param')) {
    normalized.max_param = normalizeRuntimeString(normalized.max_param, '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'value_type')) {
    normalized.value_type = normalizeRuntimeString(normalized.value_type, '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'multi_value')) {
    normalized.multi_value = normalizeRuntimeString(normalized.multi_value, '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'supported_result_kinds')) {
    normalized.supported_result_kinds = normalizeRuntimeStringList(
      normalized.supported_result_kinds,
      [],
    );
  }
  if (isRuntimePlainObject(normalized.duration_scope_by_result_kind)) {
    normalized.duration_scope_by_result_kind = Object.fromEntries(
      Object.entries(normalized.duration_scope_by_result_kind)
        .map(([resultKind, durationScope]) => [
          normalizeRuntimeString(resultKind, '').trim(),
          normalizeRuntimeString(durationScope, '').trim(),
        ])
        .filter(([resultKind, durationScope]) => resultKind && durationScope),
    );
  }
  return normalized;
}

function normalizeRuntimeSearchFilterContract(contract, fallback = null) {
  if (!isRuntimePlainObject(contract) && !isRuntimePlainObject(fallback)) {
    return null;
  }
  const source = isRuntimePlainObject(contract) ? contract : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const sourceFields = isRuntimePlainObject(source.fields) ? source.fields : {};
  const baseFields = isRuntimePlainObject(base.fields) ? base.fields : {};
  const fieldNames = new Set([
    ...Object.keys(baseFields),
    ...Object.keys(sourceFields),
  ]);
  const fields = {};
  fieldNames.forEach((fieldName) => {
    const normalizedField = normalizeRuntimeSearchFilterContractField(
      sourceFields[fieldName],
      baseFields[fieldName],
    );
    if (normalizedField) {
      fields[fieldName] = normalizedField;
    }
  });
  return {
    shared_surfaces: normalizeRuntimeStringList(
      source.shared_surfaces,
      Array.isArray(base.shared_surfaces) ? base.shared_surfaces : [],
    ),
    fields,
  };
}

function normalizeRuntimeSearchQueryShortcutToken(token, fallback = null) {
  if (!isRuntimePlainObject(token) && !isRuntimePlainObject(fallback)) {
    return null;
  }
  const source = isRuntimePlainObject(token) ? token : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const expandsToSource = isRuntimePlainObject(source.expands_to) ? source.expands_to : {};
  const expandsToBase = isRuntimePlainObject(base.expands_to) ? base.expands_to : {};
  return {
    token: normalizeRuntimeString(source.token ?? base.token, '').trim(),
    expands_to: {
      field: normalizeRuntimeString(expandsToSource.field ?? expandsToBase.field, '').trim(),
      value: normalizeRuntimeString(expandsToSource.value ?? expandsToBase.value, '').trim(),
    },
    availability: normalizeRuntimeString(source.availability ?? base.availability, '').trim(),
  };
}

function normalizeRuntimeSearchQueryFieldTerm(fieldTerm, fallback = null) {
  if (!isRuntimePlainObject(fieldTerm) && !isRuntimePlainObject(fallback)) {
    return null;
  }
  const source = isRuntimePlainObject(fieldTerm) ? fieldTerm : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const normalized = {
    ...base,
    ...source,
  };
  if (Object.prototype.hasOwnProperty.call(normalized, 'value_type')) {
    normalized.value_type = normalizeRuntimeString(normalized.value_type, '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'supports_quotes')) {
    normalized.supports_quotes = normalizeRuntimeBoolean(normalized.supports_quotes, false);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'supports_fuzzy_commit')) {
    normalized.supports_fuzzy_commit = normalizeRuntimeBoolean(normalized.supports_fuzzy_commit, false);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'supports_structured_suggestions')) {
    normalized.supports_structured_suggestions = normalizeRuntimeBoolean(normalized.supports_structured_suggestions, false);
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'availability')) {
    normalized.availability = normalizeRuntimeString(normalized.availability, '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'match_mode')) {
    normalized.match_mode = normalizeRuntimeString(normalized.match_mode, '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalized, 'allowed_values')) {
    normalized.allowed_values = normalizeRuntimeStringList(normalized.allowed_values, []);
  }
  return normalized;
}

function normalizeRuntimeSearchQueryContract(contract, fallback = null) {
  if (!isRuntimePlainObject(contract) && !isRuntimePlainObject(fallback)) {
    return null;
  }
  const source = isRuntimePlainObject(contract) ? contract : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const sourceDraftCommit = isRuntimePlainObject(source.draft_commit_model) ? source.draft_commit_model : {};
  const baseDraftCommit = isRuntimePlainObject(base.draft_commit_model) ? base.draft_commit_model : {};
  const sourceGrammar = isRuntimePlainObject(source.grammar) ? source.grammar : {};
  const baseGrammar = isRuntimePlainObject(base.grammar) ? base.grammar : {};
  const sourceSuggestions = isRuntimePlainObject(source.structured_suggestions) ? source.structured_suggestions : {};
  const baseSuggestions = isRuntimePlainObject(base.structured_suggestions) ? base.structured_suggestions : {};
  const sourceCommitted = isRuntimePlainObject(source.committed_matching) ? source.committed_matching : {};
  const baseCommitted = isRuntimePlainObject(base.committed_matching) ? base.committed_matching : {};
  const sourceFieldTerms = isRuntimePlainObject(sourceGrammar.field_terms) ? sourceGrammar.field_terms : {};
  const baseFieldTerms = isRuntimePlainObject(baseGrammar.field_terms) ? baseGrammar.field_terms : {};
  const fieldTermNames = new Set([
    ...Object.keys(baseFieldTerms),
    ...Object.keys(sourceFieldTerms),
  ]);
  const fieldTerms = {};
  fieldTermNames.forEach((fieldName) => {
    const normalizedFieldTerm = normalizeRuntimeSearchQueryFieldTerm(
      sourceFieldTerms[fieldName],
      baseFieldTerms[fieldName],
    );
    if (normalizedFieldTerm) {
      fieldTerms[fieldName] = normalizedFieldTerm;
    }
  });
  return {
    shared_surfaces: normalizeRuntimeStringList(
      source.shared_surfaces,
      Array.isArray(base.shared_surfaces) ? base.shared_surfaces : [],
    ),
    draft_commit_model: {
      draft_state_owner: normalizeRuntimeString(
        sourceDraftCommit.draft_state_owner ?? baseDraftCommit.draft_state_owner,
        '',
      ).trim(),
      committed_state_owner: normalizeRuntimeString(
        sourceDraftCommit.committed_state_owner ?? baseDraftCommit.committed_state_owner,
        '',
      ).trim(),
      commit_triggers: normalizeRuntimeStringList(
        sourceDraftCommit.commit_triggers,
        Array.isArray(baseDraftCommit.commit_triggers) ? baseDraftCommit.commit_triggers : [],
      ),
      debounce_ms: normalizeRuntimeNumber(
        sourceDraftCommit.debounce_ms,
        normalizeRuntimeNumber(baseDraftCommit.debounce_ms, 0),
      ),
      draft_sync_policy: normalizeRuntimeString(
        sourceDraftCommit.draft_sync_policy ?? baseDraftCommit.draft_sync_policy,
        '',
      ).trim(),
      empty_query_behavior: normalizeRuntimeString(
        sourceDraftCommit.empty_query_behavior ?? baseDraftCommit.empty_query_behavior,
        '',
      ).trim(),
      in_flight_request_policy: normalizeRuntimeString(
        sourceDraftCommit.in_flight_request_policy ?? baseDraftCommit.in_flight_request_policy,
        '',
      ).trim(),
    },
    grammar: {
      supports_cross_field_and: normalizeRuntimeBoolean(
        sourceGrammar.supports_cross_field_and,
        normalizeRuntimeBoolean(baseGrammar.supports_cross_field_and, false),
      ),
      supports_same_field_or: normalizeRuntimeBoolean(
        sourceGrammar.supports_same_field_or,
        normalizeRuntimeBoolean(baseGrammar.supports_same_field_or, false),
      ),
      supports_negation: normalizeRuntimeBoolean(
        sourceGrammar.supports_negation,
        normalizeRuntimeBoolean(baseGrammar.supports_negation, false),
      ),
      supports_quoted_values: normalizeRuntimeBoolean(
        sourceGrammar.supports_quoted_values,
        normalizeRuntimeBoolean(baseGrammar.supports_quoted_values, false),
      ),
      supports_comparison_operators: normalizeRuntimeBoolean(
        sourceGrammar.supports_comparison_operators,
        normalizeRuntimeBoolean(baseGrammar.supports_comparison_operators, false),
      ),
      supports_fuzzy_commit_matching: normalizeRuntimeBoolean(
        sourceGrammar.supports_fuzzy_commit_matching,
        normalizeRuntimeBoolean(baseGrammar.supports_fuzzy_commit_matching, false),
      ),
      shortcut_tokens: (Array.isArray(sourceGrammar.shortcut_tokens) ? sourceGrammar.shortcut_tokens : [])
        .map((token, index) => normalizeRuntimeSearchQueryShortcutToken(
          token,
          Array.isArray(baseGrammar.shortcut_tokens) ? baseGrammar.shortcut_tokens[index] : null,
        ))
        .filter((token) => token && token.token),
      field_terms: fieldTerms,
    },
    structured_suggestions: {
      value_fields: normalizeRuntimeStringList(
        sourceSuggestions.value_fields,
        Array.isArray(baseSuggestions.value_fields) ? baseSuggestions.value_fields : [],
      ),
      fuzzy_commit_without_exact_suggestion: normalizeRuntimeBoolean(
        sourceSuggestions.fuzzy_commit_without_exact_suggestion,
        normalizeRuntimeBoolean(baseSuggestions.fuzzy_commit_without_exact_suggestion, false),
      ),
    },
    committed_matching: {
      priority_order: normalizeRuntimeStringList(
        sourceCommitted.priority_order,
        Array.isArray(baseCommitted.priority_order) ? baseCommitted.priority_order : [],
      ),
      numeric_terms_are_near_exact: normalizeRuntimeBoolean(
        sourceCommitted.numeric_terms_are_near_exact,
        normalizeRuntimeBoolean(baseCommitted.numeric_terms_are_near_exact, false),
      ),
    },
  };
}

function normalizeRuntimeSearchContext(searchContext, fallback = null) {
  if (!isRuntimePlainObject(searchContext) && !isRuntimePlainObject(fallback)) {
    return null;
  }
  const source = isRuntimePlainObject(searchContext) ? searchContext : {};
  const base = isRuntimePlainObject(fallback) ? fallback : {};
  const sourceResultSurface = isRuntimePlainObject(source.result_surface) ? source.result_surface : {};
  const baseResultSurface = isRuntimePlainObject(base.result_surface) ? base.result_surface : {};
  const sourceResultGroups = isRuntimePlainObject(source.result_groups) ? source.result_groups : {};
  const baseResultGroups = isRuntimePlainObject(base.result_groups) ? base.result_groups : {};
  const resultGroupNames = new Set([
    ...Object.keys(baseResultGroups),
    ...Object.keys(sourceResultGroups),
  ]);
  const normalizedResultGroups = {};
  resultGroupNames.forEach((groupName) => {
    const normalizedGroupName = normalizeRuntimeString(groupName, '').trim();
    if (!normalizedGroupName) return;
    normalizedResultGroups[normalizedGroupName] = normalizeRuntimeStringList(
      sourceResultGroups[groupName],
      Array.isArray(baseResultGroups[groupName]) ? baseResultGroups[groupName] : [],
    );
  });
  return {
    ...base,
    ...source,
    result_surface: {
      ...baseResultSurface,
      ...sourceResultSurface,
      kind: normalizeRuntimeString(sourceResultSurface.kind ?? baseResultSurface.kind, '').trim(),
      group_order: normalizeRuntimeStringList(
        sourceResultSurface.group_order,
        Array.isArray(baseResultSurface.group_order) ? baseResultSurface.group_order : [],
      ),
      default_selection_behavior: normalizeRuntimeString(
        sourceResultSurface.default_selection_behavior ?? baseResultSurface.default_selection_behavior,
        '',
      ).trim(),
    },
    result_groups: normalizedResultGroups,
    search_filters: normalizeRuntimeSearchFilters(source.search_filters, base.search_filters),
  };
}

function uniqueRuntimeStrings(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => value && !seen.has(value) && seen.add(value));
}

function compactRuntimeAlbumDirectoryPaths(album) {
  const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
  const directories = tracks
    .map((track) => String(track?.path || '').trim())
    .filter(Boolean)
    .map((trackPath) => {
      const normalized = trackPath.replaceAll('\\', '/');
      const slashIndex = normalized.lastIndexOf('/');
      if (slashIndex <= 0) return '';
      return trackPath.slice(0, slashIndex);
    });
  return uniqueRuntimeStrings(directories);
}

function compactRuntimeMoveAvailability(availability) {
  if (!isRuntimePlainObject(availability)) {
    return null;
  }
  const sourceActions = isRuntimePlainObject(availability.actions) ? availability.actions : {};
  const seen = new Set();
  const availableActions = (Array.isArray(availability.available_actions) ? availability.available_actions : [])
    .map((action) => String(action || '').trim())
    .filter((action) => action && !seen.has(action) && seen.add(action));
  const compactedActions = {};
  availableActions.forEach((action) => {
    const sourceAction = isRuntimePlainObject(sourceActions[action]) ? sourceActions[action] : null;
    if (!sourceAction) return;
    compactedActions[action] = {
      available: normalizeRuntimeBoolean(sourceAction.available, true),
      target_category: normalizeRuntimeString(sourceAction.target_category, '').trim(),
      destination_folder_name: normalizeRuntimeString(sourceAction.destination_folder_name, '').trim(),
    };
  });
  const compactedAvailableActions = availableActions.filter((action) => isRuntimePlainObject(compactedActions[action]));
  if (!compactedAvailableActions.length) {
    return null;
  }
  return {
    available_actions: compactedAvailableActions,
    actions: compactedActions,
  };
}

function compactRuntimeAlbumPayload(album) {
  if (!isRuntimePlainObject(album)) {
    return album;
  }
  const sourceAlbumPreference = isRuntimePlainObject(album.album_preference)
    ? album.album_preference
    : null;
  const compactedRatingContract = {
    ...(sourceAlbumPreference && Object.prototype.hasOwnProperty.call(sourceAlbumPreference, 'rating')
      ? { album_preference: { rating: sourceAlbumPreference.rating } }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(album, 'tag_album_rating')
      ? { tag_album_rating: album.tag_album_rating }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(album, 'tag_album_rating_source')
      ? { tag_album_rating_source: album.tag_album_rating_source }
      : {}),
  };
  const {
    album_preference: _albumPreference,
    tag_album_rating: _tagAlbumRating,
    tag_album_rating_source: _tagAlbumRatingSource,
    gallery_list_block: _galleryListBlock,
    album_display_metadata: _albumDisplayMetadata,
    remote_cover_source_label: _remoteCoverSourceLabel,
    move_availability: _moveAvailability,
    ...baseAlbum
  } = album;
  const compactedMoveAvailability = compactRuntimeMoveAvailability(album.move_availability);
  if (album.preview_only) {
    return {
      ...baseAlbum,
      ...compactedRatingContract,
      ...(compactedMoveAvailability ? { move_availability: compactedMoveAvailability } : {}),
      track_count_preview: normalizeRuntimeNumber(
        album.track_count_preview,
        Array.isArray(album.tracks) ? album.tracks.length : 0,
      ),
      open_directory_paths: uniqueRuntimeStrings(album.open_directory_paths),
    };
  }
  const tracks = Array.isArray(album.tracks) ? album.tracks : [];
  const duplicateSources = Array.isArray(album.duplicate_sources) ? album.duplicate_sources : [];
  return {
    ...baseAlbum,
    ...compactedRatingContract,
    ...(compactedMoveAvailability ? { move_availability: compactedMoveAvailability } : {}),
    track_count_preview: normalizeRuntimeNumber(album.track_count_preview, tracks.length),
    has_duplicate_files: normalizeRuntimeBoolean(album.has_duplicate_files, duplicateSources.length > 0),
    duplicate_sources: [],
    tracks: [],
    open_directory_paths: compactRuntimeAlbumDirectoryPaths(album),
    preview_only: true,
  };
}

function compactRuntimeArtistGroupPayload(group) {
  if (!isRuntimePlainObject(group)) {
    return group;
  }
  return {
    ...group,
    albums: (Array.isArray(group.albums) ? group.albums : []).map((album) => compactRuntimeAlbumPayload(album)),
  };
}

function compactRuntimeNonAlbumTrackPayload(track) {
  if (!isRuntimePlainObject(track)) {
    return track;
  }
  return {
    ...track,
  };
}

function runtimeAlbumPayloadIsFull(album) {
  return isRuntimePlainObject(album)
    && !album.preview_only
    && Array.isArray(album.tracks)
    && album.tracks.length > 0;
}

function viewShouldRetainFullRuntimeAlbums(view) {
  if (!isRuntimePlainObject(view)) {
    return false;
  }
  if (!String(view.selected_artist || '').trim()) {
    return false;
  }
  return ['artist_groups', 'primary_artist_groups', 'family_artist_groups'].some((groupKey) => (
    Array.isArray(view[groupKey])
      && view[groupKey].some((group) => Array.isArray(group?.albums) && group.albums.some((album) => runtimeAlbumPayloadIsFull(album)))
  ));
}

function compactRuntimeViewPayload(view) {
  const normalizedView = isRuntimePlainObject(view) ? view : {};
  const playbackContext = normalizeRuntimePlaybackContext(normalizedView.playback_context);
  const hasSelectedArtistFamilyDisplayMode = Object.prototype.hasOwnProperty.call(normalizedView, 'selected_artist_family_display_mode')
    || Boolean(normalizedView.artist_page?.family_display_mode);
  const selectedArtistFamilyDisplayMode = hasSelectedArtistFamilyDisplayMode
    ? normalizeRuntimeSelectedArtistFamilyDisplayMode(
      normalizedView.selected_artist_family_display_mode ?? normalizedView.artist_page?.family_display_mode,
    )
    : null;
  return {
    ...normalizedView,
    search_filters: normalizeRuntimeSearchFilters(normalizedView.search_filters),
    search_filter_contract: normalizeRuntimeSearchFilterContract(normalizedView.search_filter_contract),
    search_query_contract: normalizeRuntimeSearchQueryContract(normalizedView.search_query_contract),
    search_context: normalizeRuntimeSearchContext(normalizedView.search_context),
    artist_groups: (Array.isArray(normalizedView.artist_groups) ? normalizedView.artist_groups : []).map((group) => compactRuntimeArtistGroupPayload(group)),
    primary_artist_groups: (Array.isArray(normalizedView.primary_artist_groups) ? normalizedView.primary_artist_groups : []).map((group) => compactRuntimeArtistGroupPayload(group)),
    family_artist_groups: (Array.isArray(normalizedView.family_artist_groups) ? normalizedView.family_artist_groups : []).map((group) => compactRuntimeArtistGroupPayload(group)),
    non_album_tracks: (Array.isArray(normalizedView.non_album_tracks) ? normalizedView.non_album_tracks : []).map((track) => compactRuntimeNonAlbumTrackPayload(track)),
    ...(selectedArtistFamilyDisplayMode ? { selected_artist_family_display_mode: selectedArtistFamilyDisplayMode } : {}),
    ...(playbackContext ? { playback_context: playbackContext } : {}),
  };
}

function cloneRuntimeCompactViewPayload(view) {
  return compactRuntimeViewPayload(normalizeViewPayload(view));
}

function cloneRuntimeReusableSelectedArtistBrowseView(view) {
  return viewShouldRetainFullRuntimeAlbums(view)
    ? normalizeViewPayload(view)
    : cloneRuntimeCompactViewPayload(view);
}

function normalizeVisibleLibraryCategorySelection(categories, fallback = DEFAULT_LIBRARY_CATEGORIES) {
  const allowed = new Set(DEFAULT_LIBRARY_CATEGORIES);
  const seen = new Set();
  const normalized = (Array.isArray(categories) ? categories : [])
    .map((category) => String(category || '').trim())
    .filter((category) => category && allowed.has(category) && !seen.has(category) && seen.add(category));
  if (normalized.length) return normalized;
  return [...(Array.isArray(fallback) && fallback.length ? fallback : DEFAULT_LIBRARY_CATEGORIES)];
}

function groupMatchesRelatedArtists(group, activeArtists) {
  const normalizedActiveArtists = new Set(
    [...(activeArtists || [])]
      .map((artist) => normalizeRuntimeString(artist, '').trim())
      .filter(Boolean),
  );
  const groupCandidates = [
    group?.artist,
    group?.artist_display,
    ...(Array.isArray(group?.variation_names) ? group.variation_names : []),
  ].map((artist) => normalizeRuntimeString(artist, '').trim()).filter(Boolean);
  if (groupCandidates.some((artist) => normalizedActiveArtists.has(artist))) {
    return true;
  }
  const albums = Array.isArray(group?.albums) ? group.albums : [];
  return albums.some((album) => {
    const variationNamesByTagRef = (
      album?.artist_family_variation_names_by_tag_ref
      && typeof album.artist_family_variation_names_by_tag_ref === 'object'
    )
      ? Object.values(album.artist_family_variation_names_by_tag_ref).flatMap((values) => (
        Array.isArray(values) ? values : []
      ))
      : [];
    const memberArtists = [
      album?.album_artist,
      ...(Array.isArray(album?.artists) ? album.artists : []),
      ...variationNamesByTagRef,
    ].map((artist) => normalizeRuntimeString(artist, '').trim()).filter(Boolean);
    return memberArtists.some((artist) => normalizedActiveArtists.has(artist));
  });
}

function getRelatedFilterCacheState() {
  if (!state || !state.gallery || typeof state.gallery !== 'object') return null;
  return state.gallery;
}

const MAX_REUSABLE_SELECTED_ARTIST_BROWSE_VIEWS = 8;

function isReusableRootBrowseViewCandidate(view) {
  const resolvedSurface = typeof resolveViewSurface === 'function'
    ? resolveViewSurface(view)
    : String(view?.surface?.active ?? view?.surface_request ?? '').trim().toLowerCase();
  return resolvedSurface === 'albums'
    && !String(view?.query || '').trim()
    && !String(view?.selected_artist || '').trim();
}

function hasReusableRootBrowseAlbums(view) {
  return Array.isArray(view?.artist_groups)
    && view.artist_groups.some((group) => (
      Array.isArray(group?.albums) && group.albums.length > 0
    ));
}
function isReusableSelectedArtistBrowseViewCandidate(view) {
  const resolvedSurface = typeof resolveViewSurface === 'function'
    ? resolveViewSurface(view)
    : String(view?.surface?.active ?? view?.surface_request ?? '').trim().toLowerCase();
  return resolvedSurface === 'albums'
    && String(view?.query || '').trim()
    && String(view?.selected_artist || '').trim()
    && !(Array.isArray(view?.related_filter_artists) && view.related_filter_artists.length)
    && !Boolean(view?.primary_filter_active);
}

function getRuntimeSearchDraftQuery(fallback = '') {
  return normalizeRuntimeString(state?.ui?.searchDraftQuery, fallback);
}

function shouldSyncSearchDraftQuery(previousView, nextView) {
  const previousCommittedQuery = normalizeRuntimeString(previousView?.query, '');
  const nextCommittedQuery = normalizeRuntimeString(nextView?.query, '');
  const currentDraftQuery = getRuntimeSearchDraftQuery(previousCommittedQuery);
  return currentDraftQuery === previousCommittedQuery || currentDraftQuery === nextCommittedQuery;
}

function buildReusableRootBrowseViewSignature(view) {
  if (!isReusableRootBrowseViewCandidate(view)) return '';
  return JSON.stringify({
    query: '',
    selected_artist: '',
    all_artists_active: true,
    gallery_scope: normalizeRuntimeString(view?.gallery_scope, 'all'),
    gallery_display_mode: normalizeRuntimeGalleryDisplayMode(view?.gallery_display_mode, 'cards'),
    gallery_scale_percent: normalizeRuntimeGalleryScalePercent(view?.gallery_scale_percent, 100),
    visible_library_categories: normalizeVisibleLibraryCategorySelection(view?.visible_library_categories),
    related_filter_artists: [],
    primary_filter_active: false,
  });
}

function rememberReusableRootBrowseView(view) {
  const cacheState = getRelatedFilterCacheState();
  if (!cacheState) return;
  const signature = buildReusableRootBrowseViewSignature(view);
  if (!signature) return;
  cacheState.reusableRootBrowseView = cloneRuntimeCompactViewPayload(view);
  cacheState.reusableRootBrowseViewSignature = signature;
}

function clearReusableRootBrowseView() {
  const cacheState = getRelatedFilterCacheState();
  if (!cacheState) return;
  cacheState.reusableRootBrowseView = null;
  cacheState.reusableRootBrowseViewSignature = '';
}

function getReusableRootBrowseView(view, fallbackViews = []) {
  const requestedSignature = buildReusableRootBrowseViewSignature(view);
  if (!requestedSignature) {
    return null;
  }
  const currentView = normalizeViewPayload(state?.view);
  if (
    buildReusableRootBrowseViewSignature(currentView) === requestedSignature
    && hasReusableRootBrowseAlbums(currentView)
  ) {
    return cloneRuntimeCompactViewPayload(currentView);
  }
  const candidates = Array.isArray(fallbackViews) ? fallbackViews : [fallbackViews];
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeViewPayload(candidate);
    if (
      buildReusableRootBrowseViewSignature(normalizedCandidate) === requestedSignature
      && hasReusableRootBrowseAlbums(normalizedCandidate)
    ) {
      return cloneRuntimeCompactViewPayload(normalizedCandidate);
    }
  }
  const cacheState = getRelatedFilterCacheState();
  if (!cacheState) return null;
  if (cacheState.reusableRootBrowseViewSignature !== requestedSignature) return null;
  return cloneRuntimeCompactViewPayload(cacheState.reusableRootBrowseView);
}
function buildReusableSelectedArtistBrowseViewSignature(view) {
  if (!isReusableSelectedArtistBrowseViewCandidate(view)) return '';
  const signature = {
    query: normalizeRuntimeString(view?.query, ''),
    selected_artist: normalizeRuntimeString(view?.selected_artist, ''),
    gallery_scope: normalizeRuntimeString(view?.gallery_scope, 'all'),
    gallery_display_mode: normalizeRuntimeGalleryDisplayMode(view?.gallery_display_mode, 'cards'),
    gallery_scale_percent: normalizeRuntimeGalleryScalePercent(view?.gallery_scale_percent, 100),
    visible_library_categories: normalizeVisibleLibraryCategorySelection(view?.visible_library_categories),
    related_filter_artists: [],
    primary_filter_active: false,
  };
  const selectedArtistFamilyDisplayMode = normalizeRuntimeSelectedArtistFamilyDisplayMode(
    view?.selected_artist_family_display_mode ?? view?.artist_page?.family_display_mode,
    '',
  );
  if (selectedArtistFamilyDisplayMode) {
    signature.selected_artist_family_display_mode = selectedArtistFamilyDisplayMode;
  }
  return JSON.stringify(signature);
}

function rememberReusableSelectedArtistBrowseView(view) {
  const cacheState = getRelatedFilterCacheState();
  if (!cacheState) return;
  const signature = buildReusableSelectedArtistBrowseViewSignature(view);
  if (!signature) return;
  const nextViews = isRuntimePlainObject(cacheState.reusableSelectedArtistBrowseViews)
    ? { ...cacheState.reusableSelectedArtistBrowseViews }
    : {};
  const nextOrder = Array.isArray(cacheState.reusableSelectedArtistBrowseViewOrder)
    ? cacheState.reusableSelectedArtistBrowseViewOrder.filter((entry) => entry !== signature)
    : [];
  nextViews[signature] = cloneRuntimeReusableSelectedArtistBrowseView(view);
  nextOrder.push(signature);
  while (nextOrder.length > MAX_REUSABLE_SELECTED_ARTIST_BROWSE_VIEWS) {
    const evictedSignature = nextOrder.shift();
    if (evictedSignature) {
      delete nextViews[evictedSignature];
    }
  }
  cacheState.reusableSelectedArtistBrowseViews = nextViews;
  cacheState.reusableSelectedArtistBrowseViewOrder = nextOrder;
}

function getReusableSelectedArtistBrowseView(view) {
  const cacheState = getRelatedFilterCacheState();
  if (!cacheState) return null;
  const requestedSignature = buildReusableSelectedArtistBrowseViewSignature(view);
  if (!requestedSignature) return null;
  const cachedViews = isRuntimePlainObject(cacheState.reusableSelectedArtistBrowseViews)
    ? cacheState.reusableSelectedArtistBrowseViews
    : null;
  const cachedView = cachedViews ? cachedViews[requestedSignature] : null;
  if (!cachedView) return null;
  return cloneRuntimeReusableSelectedArtistBrowseView(cachedView);
}

function rememberMainGalleryCategorySelection(view) {
  const cacheState = getRelatedFilterCacheState();
  if (!cacheState) return;
  if (String(view?.gallery_scope || '') === 'new_arrivals') return;
  cacheState.mainGalleryVisibleCategories = normalizeVisibleLibraryCategorySelection(
    view?.visible_library_categories,
    cacheState.mainGalleryVisibleCategories,
  );
}

function resolveMainGalleryCategorySelection(fallbackCategories = null) {
  const cacheState = getRelatedFilterCacheState();
  const remembered = cacheState?.mainGalleryVisibleCategories;
  return normalizeVisibleLibraryCategorySelection(
    Array.isArray(remembered) && remembered.length ? remembered : fallbackCategories,
  );
}

function normalizeViewPayload(payload, fallbackView = null) {
  const defaults = typeof appBootstrap?.getInitialView === 'function'
    ? appBootstrap.getInitialView()
    : {};
  const base = {
    ...defaults,
    ...(isRuntimePlainObject(fallbackView) ? fallbackView : {}),
  };
  const source = isRuntimePlainObject(payload) ? payload : {};
  const resolvedSurface = String(
    source?.surface?.active
      ?? source?.surface_request
      ?? base?.surface?.active
      ?? base?.surface_request
      ?? '',
  ).trim().toLowerCase();
  const isPlaylistSurface = resolvedSurface === 'playlists';
  const playbackContext = normalizeRuntimePlaybackContext(source.playback_context, base.playback_context);
  const hasSelectedArtistFamilyDisplayMode = Object.prototype.hasOwnProperty.call(source, 'selected_artist_family_display_mode')
    || Object.prototype.hasOwnProperty.call(base, 'selected_artist_family_display_mode')
    || Boolean(source.artist_page?.family_display_mode)
    || Boolean(base.artist_page?.family_display_mode);
  const selectedArtistFamilyDisplayMode = hasSelectedArtistFamilyDisplayMode
    ? normalizeRuntimeSelectedArtistFamilyDisplayMode(
      source.selected_artist_family_display_mode
        ?? source.artist_page?.family_display_mode
        ?? base.selected_artist_family_display_mode
        ?? base.artist_page?.family_display_mode,
      'grouped',
    )
    : null;
  const explicitlyClearsSelectedArtist = Object.prototype.hasOwnProperty.call(source, 'selected_artist')
    && !normalizeRuntimeString(source.selected_artist, '').trim();
  const resetSelectedArtistScopedGroups = explicitlyClearsSelectedArtist
    && !Object.prototype.hasOwnProperty.call(source, 'primary_artist_groups')
    && !Object.prototype.hasOwnProperty.call(source, 'family_artist_groups');
  const sourcePayloadTier = normalizeRuntimeString(source.payload_tier, '').trim().toLowerCase();
  const initialViewPartialFallback = sourcePayloadTier === 'full'
    ? false
    : base.initial_view_partial;

  const normalizedView = {
    ...base,
    ...source,
    artist_groups: cloneRuntimeArray(
      isPlaylistSurface ? [] : source.artist_groups,
      isPlaylistSurface ? [] : base.artist_groups,
    ),
    primary_artist_groups: cloneRuntimeArray(
      isPlaylistSurface ? [] : (resetSelectedArtistScopedGroups ? [] : source.primary_artist_groups),
      isPlaylistSurface ? [] : base.primary_artist_groups,
    ),
    family_artist_groups: cloneRuntimeArray(
      isPlaylistSurface ? [] : (resetSelectedArtistScopedGroups ? [] : source.family_artist_groups),
      isPlaylistSurface ? [] : base.family_artist_groups,
    ),
    artists_sidebar: cloneRuntimeArray(
      isPlaylistSurface ? [] : source.artists_sidebar,
      isPlaylistSurface ? [] : base.artists_sidebar,
    ),
    related_artists: cloneRuntimeArray(
      isPlaylistSurface ? [] : source.related_artists,
      isPlaylistSurface ? [] : base.related_artists,
    ),
    related_filter_artists: cloneRuntimeArray(
      isPlaylistSurface ? [] : source.related_filter_artists,
      isPlaylistSurface ? [] : base.related_filter_artists,
    ).map((artist) => String(artist || '')),
    search_filters: normalizeRuntimeSearchFilters(source.search_filters, base.search_filters),
    search_filter_contract: normalizeRuntimeSearchFilterContract(source.search_filter_contract, base.search_filter_contract),
    search_query_contract: normalizeRuntimeSearchQueryContract(source.search_query_contract, base.search_query_contract),
    visible_library_categories: normalizeVisibleLibraryCategorySelection(
      cloneRuntimeArray(source.visible_library_categories, base.visible_library_categories),
      base.visible_library_categories,
    ),
    search_context: normalizeRuntimeSearchContext(
      source.search_context,
      Object.prototype.hasOwnProperty.call(source, 'search_context')
        ? null
        : base.search_context,
    ),
    ignored_version_keys: cloneRuntimeArray(source.ignored_version_keys, base.ignored_version_keys),
    non_album_tracks: cloneRuntimeArray(source.non_album_tracks, base.non_album_tracks),
    non_album_exception_values: cloneRuntimeArray(source.non_album_exception_values, base.non_album_exception_values),
    manual_version_links: cloneRuntimeObject(source.manual_version_links, base.manual_version_links),
    query: normalizeRuntimeString(source.query, base.query),
    selected_artist: normalizeRuntimeString(
      isPlaylistSurface ? '' : source.selected_artist,
      isPlaylistSurface ? '' : base.selected_artist,
    ),
    gallery_scope: normalizeRuntimeString(source.gallery_scope, base.gallery_scope),
    gallery_display_mode: normalizeRuntimeGalleryDisplayMode(source.gallery_display_mode, base.gallery_display_mode),
    gallery_scale_percent: normalizeRuntimeGalleryScalePercent(source.gallery_scale_percent, base.gallery_scale_percent),
    music_dir: normalizeRuntimeString(source.music_dir, base.music_dir),
    app_name: normalizeRuntimeString(source.app_name, base.app_name),
    app_version: normalizeRuntimeString(source.app_version, base.app_version),
    album_count: normalizeRuntimeNumber(source.album_count, base.album_count),
    artist_count: normalizeRuntimeNumber(source.artist_count, base.artist_count),
    all_artists_active: normalizeRuntimeBoolean(
      isPlaylistSurface ? false : source.all_artists_active,
      isPlaylistSurface ? false : base.all_artists_active,
    ),
    show_all_artists_sidebar_link: normalizeRuntimeBoolean(
      isPlaylistSurface ? false : source.show_all_artists_sidebar_link,
      isPlaylistSurface ? false : base.show_all_artists_sidebar_link,
    ),
    primary_filter_active: normalizeRuntimeBoolean(
      isPlaylistSurface ? false : source.primary_filter_active,
      isPlaylistSurface ? false : base.primary_filter_active,
    ),
    initial_view_partial: normalizeRuntimeBoolean(
      source.initial_view_partial,
      initialViewPartialFallback,
    ),
    ...(selectedArtistFamilyDisplayMode ? { selected_artist_family_display_mode: selectedArtistFamilyDisplayMode } : {}),
    ...(playbackContext ? { playback_context: playbackContext } : {}),
  };
  if (isPlaylistSurface) {
    delete normalizedView.artist_family_filters;
    delete normalizedView.artist_page;
    delete normalizedView.playback_context;
    delete normalizedView.selected_artist_family_display_mode;
    if (!isRuntimePlainObject(source.playlist_detail)) {
      delete normalizedView.playlist_detail;
    }
    if (!isRuntimePlainObject(source.playlist_index)) {
      delete normalizedView.playlist_index;
    }
  }
  return normalizedView;
}

function buildSelectedArtistChronologicalArtistGroups(primaryGroups = [], familyGroups = []) {
  const seenAlbumKeys = new Set();
  const albums = [...(Array.isArray(primaryGroups) ? primaryGroups : []), ...(Array.isArray(familyGroups) ? familyGroups : [])]
    .flatMap((group) => (Array.isArray(group?.albums) ? group.albums : []))
    .filter((album) => {
      const albumKey = String(album?.key || '').trim();
      if (!albumKey) return true;
      if (seenAlbumKeys.has(albumKey)) return false;
      seenAlbumKeys.add(albumKey);
      return true;
    })
    .sort((left, right) => {
      const normalizeReleaseDate = (album) => {
        const releaseDate = String(album?.release_date || '').trim();
        if (!releaseDate) return '';
        const parts = releaseDate.split('-');
        if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
          return '';
        }
        const year = parts[0].padStart(4, '0');
        const month = (parts[1] || '99').padStart(2, '0');
        const day = (parts[2] || '99').padStart(2, '0');
        return `${year}-${month}-${day}`;
      };
      const normalizeYear = (album) => {
        if (album?.year === null || album?.year === undefined || album?.year === '') return 9999;
        const year = Number(album.year);
        return Number.isInteger(year) ? year : 9999;
      };
      const leftYear = normalizeYear(left);
      const rightYear = normalizeYear(right);
      const leftReleaseKey = normalizeReleaseDate(left) || `${String(leftYear).padStart(4, '0')}-99-99`;
      const rightReleaseKey = normalizeReleaseDate(right) || `${String(rightYear).padStart(4, '0')}-99-99`;
      if (leftReleaseKey !== rightReleaseKey) return leftReleaseKey.localeCompare(rightReleaseKey);
      if (leftYear !== rightYear) return leftYear - rightYear;
      const nameCompare = String(left?.name || '').localeCompare(String(right?.name || ''), undefined, { sensitivity: 'base' });
      if (nameCompare) return nameCompare;
      return String(left?.key || '').localeCompare(String(right?.key || ''), undefined, { sensitivity: 'base' });
    });
  if (!albums.length) return [];
  return [{
    artist: 'Chronological',
    artist_display: 'Chronological',
    albums,
  }];
}

function buildSelectedArtistRuntimeArtistGroups(view, primaryGroups = [], familyGroups = []) {
  if (normalizeRuntimeSelectedArtistFamilyDisplayMode(view?.selected_artist_family_display_mode ?? view?.artist_page?.family_display_mode) === 'chronological') {
    return buildSelectedArtistChronologicalArtistGroups(primaryGroups, familyGroups);
  }
  return [...primaryGroups, ...familyGroups];
}

function normalizeStatusPayload(payload, fallbackStatus = null) {
  const base = {
    ...DEFAULT_STATUS_STATE,
    ...(isRuntimePlainObject(fallbackStatus) ? fallbackStatus : {}),
  };
  const source = isRuntimePlainObject(payload) ? payload : {};

  return {
    ...base,
    ...source,
    scan_in_progress: normalizeRuntimeBoolean(source.scan_in_progress, base.scan_in_progress),
    scan_processed: normalizeRuntimeNumber(source.scan_processed, base.scan_processed),
    scan_total: normalizeRuntimeNumber(source.scan_total, base.scan_total),
    scan_percent: normalizeRuntimeNumber(source.scan_percent, base.scan_percent),
    scan_current_path: normalizeRuntimeString(source.scan_current_path, base.scan_current_path),
    scan_elapsed_seconds: normalizeRuntimeNumber(source.scan_elapsed_seconds, base.scan_elapsed_seconds),
    scan_estimated_remaining_seconds: normalizeRuntimeNumber(source.scan_estimated_remaining_seconds, base.scan_estimated_remaining_seconds),
    scan_files_per_second: normalizeRuntimeNumber(source.scan_files_per_second, base.scan_files_per_second),
    scan_album_folders_processed: normalizeRuntimeNumber(source.scan_album_folders_processed, base.scan_album_folders_processed),
    scan_album_folders_total: normalizeRuntimeNumber(source.scan_album_folders_total, base.scan_album_folders_total),
    scan_phase: normalizeRuntimeString(source.scan_phase, base.scan_phase),
    scan_mode: normalizeRuntimeString(source.scan_mode, base.scan_mode),
    relations_in_progress: normalizeRuntimeBoolean(source.relations_in_progress, base.relations_in_progress),
    relations_processed: normalizeRuntimeNumber(source.relations_processed, base.relations_processed),
    relations_total: normalizeRuntimeNumber(source.relations_total, base.relations_total),
    relations_percent: normalizeRuntimeNumber(source.relations_percent, base.relations_percent),
    relations_phase: normalizeRuntimeString(source.relations_phase, base.relations_phase),
    relations_source: normalizeRuntimeString(source.relations_source, base.relations_source),
    covers_in_progress: normalizeRuntimeBoolean(source.covers_in_progress, base.covers_in_progress),
    covers_processed: normalizeRuntimeNumber(source.covers_processed, base.covers_processed),
    covers_total: normalizeRuntimeNumber(source.covers_total, base.covers_total),
    covers_downloaded: normalizeRuntimeNumber(source.covers_downloaded, base.covers_downloaded),
    covers_current_folder: normalizeRuntimeString(source.covers_current_folder, base.covers_current_folder),
    pending_cover_refresh_after_scan: normalizeRuntimeBoolean(source.pending_cover_refresh_after_scan, base.pending_cover_refresh_after_scan),
    last_scan_display: normalizeRuntimeString(source.last_scan_display, base.last_scan_display),
    last_error: normalizeRuntimeString(source.last_error, base.last_error),
    album_total: normalizeRuntimeNumber(source.album_total, base.album_total),
  };
}

function normalizeBootstrapPayload(payload, fallbackBootstrap = null) {
  const defaults = typeof appBootstrap?.getBootstrap === 'function'
    ? appBootstrap.getBootstrap()
    : {};
  const base = {
      refreshed: false,
      lastScanDisplay: '',
      scanInProgress: false,
      scanMode: 'idle',
      relationsInProgress: false,
    coversInProgress: false,
    partialView: false,
    ...(isRuntimePlainObject(defaults) ? defaults : {}),
    ...(isRuntimePlainObject(fallbackBootstrap) ? fallbackBootstrap : {}),
  };
  const source = isRuntimePlainObject(payload) ? payload : {};
  const startupPreviewBase = cloneRuntimeObject(base.startupPreview, {
    mode: 'empty_shell',
    isPartial: false,
    savedAtEpochMs: 0,
    renderStrategy: 'server_markup',
    renderedGalleryMarkup: false,
  });
  const startupPreviewSource = cloneRuntimeObject(source.startupPreview, startupPreviewBase);
  const startupTimingBase = cloneRuntimeObject(base.startupTiming, {
    serverRequestStartedAtEpochMs: 0,
    bootstrapPayloadReadyAtEpochMs: 0,
    payloadBuildMs: 0,
  });
  const startupTimingSource = cloneRuntimeObject(source.startupTiming, startupTimingBase);
  const startupPayloadTierBase = cloneRuntimeObject(base.startupPayloadTiers, {
    firstPaint: {
      kind: 'shell_plus_preview',
      targetFirstPaintMs: 500,
      previewMode: 'empty_shell',
      includesGalleryMarkup: false,
    },
    hydration: {
      required: false,
      trigger: 'none',
      endpoint: '/view-data',
      followupEndpoint: '',
      tier: 'full',
      reason: 'preview_is_sufficient_for_boot',
    },
  });
  const startupPayloadTierSource = cloneRuntimeObject(source.startupPayloadTiers, startupPayloadTierBase);
  const startupHydrationBase = cloneRuntimeObject(base.startupHydration, startupPayloadTierBase.hydration);
  const startupHydrationSource = cloneRuntimeObject(source.startupHydration, {});
  const normalizedStartupHydration = {
    ...startupPayloadTierBase.hydration,
    ...startupHydrationBase,
    ...cloneRuntimeObject(startupPayloadTierSource.hydration, startupPayloadTierBase.hydration),
    ...startupHydrationSource,
    required: normalizeRuntimeBoolean(
      startupHydrationSource.required,
      normalizeRuntimeBoolean(startupPayloadTierSource.hydration?.required, startupHydrationBase.required),
    ),
    trigger: normalizeRuntimeString(
      startupHydrationSource.trigger,
      normalizeRuntimeString(startupPayloadTierSource.hydration?.trigger, startupHydrationBase.trigger),
    ),
    endpoint: normalizeRuntimeString(
      startupHydrationSource.endpoint,
      normalizeRuntimeString(startupPayloadTierSource.hydration?.endpoint, startupHydrationBase.endpoint),
    ),
    followupEndpoint: normalizeRuntimeString(
      startupHydrationSource.followupEndpoint,
      normalizeRuntimeString(startupPayloadTierSource.hydration?.followupEndpoint, startupHydrationBase.followupEndpoint),
    ),
    embeddedViewPatch: cloneRuntimeJson(
      startupHydrationSource.embeddedViewPatch,
      cloneRuntimeJson(startupPayloadTierSource.hydration?.embeddedViewPatch, startupHydrationBase.embeddedViewPatch),
    ),
    tier: normalizeRuntimeString(
      startupHydrationSource.tier,
      normalizeRuntimeString(startupPayloadTierSource.hydration?.tier, startupHydrationBase.tier),
    ),
    reason: normalizeRuntimeString(
      startupHydrationSource.reason,
      normalizeRuntimeString(startupPayloadTierSource.hydration?.reason, startupHydrationBase.reason),
    ),
  };

  return {
    ...base,
    ...source,
    refreshed: normalizeRuntimeBoolean(source.refreshed, base.refreshed),
    lastScanDisplay: normalizeRuntimeString(source.lastScanDisplay, base.lastScanDisplay),
    scanInProgress: normalizeRuntimeBoolean(source.scanInProgress, base.scanInProgress),
    scanMode: normalizeRuntimeString(source.scanMode, base.scanMode),
    relationsInProgress: normalizeRuntimeBoolean(source.relationsInProgress, base.relationsInProgress),
    coversInProgress: normalizeRuntimeBoolean(source.coversInProgress, base.coversInProgress),
    partialView: normalizeRuntimeBoolean(source.partialView, base.partialView),
    startupPreview: {
      ...startupPreviewBase,
      ...startupPreviewSource,
      mode: normalizeRuntimeString(startupPreviewSource.mode, startupPreviewBase.mode),
      isPartial: normalizeRuntimeBoolean(startupPreviewSource.isPartial, startupPreviewBase.isPartial),
      savedAtEpochMs: normalizeRuntimeNumber(startupPreviewSource.savedAtEpochMs, startupPreviewBase.savedAtEpochMs),
      renderStrategy: normalizeRuntimeString(startupPreviewSource.renderStrategy, startupPreviewBase.renderStrategy),
      renderedGalleryMarkup: normalizeRuntimeBoolean(startupPreviewSource.renderedGalleryMarkup, startupPreviewBase.renderedGalleryMarkup),
    },
    startupTiming: {
      ...startupTimingBase,
      ...startupTimingSource,
      serverRequestStartedAtEpochMs: normalizeRuntimeNumber(startupTimingSource.serverRequestStartedAtEpochMs, startupTimingBase.serverRequestStartedAtEpochMs),
      bootstrapPayloadReadyAtEpochMs: normalizeRuntimeNumber(startupTimingSource.bootstrapPayloadReadyAtEpochMs, startupTimingBase.bootstrapPayloadReadyAtEpochMs),
      payloadBuildMs: normalizeRuntimeNumber(startupTimingSource.payloadBuildMs, startupTimingBase.payloadBuildMs),
    },
    startupPayloadTiers: {
      ...startupPayloadTierBase,
      ...startupPayloadTierSource,
      firstPaint: {
        ...cloneRuntimeObject(startupPayloadTierBase.firstPaint, {
          kind: 'shell_plus_preview',
          targetFirstPaintMs: 500,
          previewMode: 'empty_shell',
          includesGalleryMarkup: false,
        }),
        ...cloneRuntimeObject(startupPayloadTierSource.firstPaint, startupPayloadTierBase.firstPaint),
        kind: normalizeRuntimeString(startupPayloadTierSource.firstPaint?.kind, startupPayloadTierBase.firstPaint?.kind),
        targetFirstPaintMs: normalizeRuntimeNumber(startupPayloadTierSource.firstPaint?.targetFirstPaintMs, startupPayloadTierBase.firstPaint?.targetFirstPaintMs),
        previewMode: normalizeRuntimeString(startupPayloadTierSource.firstPaint?.previewMode, startupPayloadTierBase.firstPaint?.previewMode),
        includesGalleryMarkup: normalizeRuntimeBoolean(startupPayloadTierSource.firstPaint?.includesGalleryMarkup, startupPayloadTierBase.firstPaint?.includesGalleryMarkup),
      },
      hydration: normalizedStartupHydration,
    },
    startupHydration: normalizedStartupHydration,
  };
}

function normalizeBootstrapRuntimeStatePayload(payload) {
  const source = isRuntimePlainObject(payload) ? payload : {};
  return {
    view: normalizeViewPayload(source.initial_view),
    bootstrap: normalizeBootstrapPayload(source.bootstrap),
  };
}

function resetPreSearchViewState() {
  state.ui.preSearchView = null;
  state.ui.preSearchViewOrigin = '';
}

function clearPendingSidebarSelection() {
  state.ui.pendingSidebarSelectedArtist = '';
  state.ui.pendingSidebarAllArtistsActive = false;
}

function ensurePreSearchViewState() {
  if (state.ui.preSearchView && typeof state.ui.preSearchView === 'object') {
    return state.ui.preSearchView;
  }
  state.ui.preSearchView = {
    selected_artist: '',
    related_filter_artists: [],
    primary_filter_active: false,
  };
  state.ui.preSearchViewOrigin = 'canonical_root';
  return state.ui.preSearchView;
}

function syncRelatedFilterBaseCache(view) {
  const cacheState = getRelatedFilterCacheState();
  if (!cacheState) return;
  if (!view?.selected_artist) return;
  if (Array.isArray(view.related_filter_artists) && view.related_filter_artists.length) return;
  cacheState.relatedFilterBaseArtist = String(view.selected_artist || '');
  cacheState.relatedFilterBaseQuery = String(view.query || '');
  cacheState.relatedFilterBasePrimaryFilterActive = Boolean(view.primary_filter_active);
  cacheState.relatedFilterBasePrimaryGroups = Array.isArray(view.related_filter_base_primary_groups)
    ? view.related_filter_base_primary_groups
    : Array.isArray(view.primary_artist_groups) ? view.primary_artist_groups : [];
  cacheState.relatedFilterBaseFamilyGroups = Array.isArray(view.related_filter_base_family_groups)
    ? view.related_filter_base_family_groups
    : Array.isArray(view.family_artist_groups) ? view.family_artist_groups : [];
  cacheState.relatedFilterDefaultPrimaryGroups = Array.isArray(view.primary_artist_groups)
    ? view.primary_artist_groups
    : [];
  cacheState.relatedFilterDefaultFamilyGroups = Array.isArray(view.family_artist_groups)
    ? view.family_artist_groups
    : [];
}

function compactCurrentViewForIdle() {
  const currentView = normalizeViewPayload(state.view);
  const compactedView = viewShouldRetainFullRuntimeAlbums(currentView)
    ? currentView
    : compactRuntimeViewPayload(currentView);
  state.view = compactedView;
  syncRelatedFilterBaseCache(compactedView);
  if (isReusableRootBrowseViewCandidate(compactedView)) {
    clearReusableRootBrowseView();
  }
  if (typeof rebuildAlbumIndex === 'function') {
    rebuildAlbumIndex(compactedView.primary_artist_groups?.length || compactedView.family_artist_groups?.length
      ? [...(compactedView.primary_artist_groups || []), ...(compactedView.family_artist_groups || [])]
      : compactedView.artist_groups);
  }
  return compactedView;
}

function applyViewPayload(payload, options = {}) {
  const mountedPreviousView = isRuntimePlainObject(state.view) ? state.view : {};
  const previousView = normalizeViewPayload(state.view);
  const sidebarReconciledPayload = options.preserveSidebarState
    ? {
      ...(isRuntimePlainObject(payload) ? payload : {}),
      artists_sidebar: previousView.artists_sidebar,
      artist_count: previousView.artist_count,
      show_all_artists_sidebar_link: previousView.show_all_artists_sidebar_link,
    }
    : payload;
  const nextPayload = (
    options.completePageEntryBrowseContext
    && String(previousView?.surface?.active || '').trim().toLowerCase() === 'home'
  )
    ? {
      ...(isRuntimePlainObject(sidebarReconciledPayload) ? sidebarReconciledPayload : {}),
      surface: previousView.surface,
      surface_request: previousView.surface_request,
    }
    : sidebarReconciledPayload;
  const normalizedNextView = normalizeViewPayload(nextPayload, previousView);
  const nextView = (options.retainFullAlbums || viewShouldRetainFullRuntimeAlbums(normalizedNextView))
    ? normalizedNextView
    : compactRuntimeViewPayload(normalizedNextView);
  const preserveMountedSelectedView = Boolean(
    options.preserveMountedGalleryChildren
    && String(mountedPreviousView.selected_artist || '').trim()
      === String(nextView.selected_artist || '').trim()
    && String(mountedPreviousView.query || '').trim()
    && !String(nextView.query || '').trim()
  );
  if (preserveMountedSelectedView) {
    nextView.artist_groups = mountedPreviousView.artist_groups;
    nextView.primary_artist_groups = mountedPreviousView.primary_artist_groups;
    nextView.family_artist_groups = mountedPreviousView.family_artist_groups;
    nextView.related_artists = mountedPreviousView.related_artists;
    nextView.related_filter_artists = mountedPreviousView.related_filter_artists;
    nextView.primary_filter_active = Boolean(mountedPreviousView.primary_filter_active);
    const cacheState = getRelatedFilterCacheState();
    if (
      cacheState
      && String(cacheState.relatedFilterBaseArtist || '') === String(nextView.selected_artist || '')
      && String(cacheState.relatedFilterBaseQuery || '') === String(mountedPreviousView.query || '')
    ) {
      cacheState.relatedFilterBaseQuery = String(nextView.query || '');
    }
  }
  const previousViewWasReusableRootBrowse = isReusableRootBrowseViewCandidate(previousView);
  const nextViewIsReusableRootBrowse = isReusableRootBrowseViewCandidate(nextView);
  const syncSearchDraftQuery = shouldSyncSearchDraftQuery(previousView, nextView);
  const previousSelectedArtist = String(previousView.selected_artist || '').trim();
  const nextSelectedArtist = String(nextView.selected_artist || '').trim();
  const selectionChanged = previousSelectedArtist !== nextSelectedArtist;
  const previousHadRelatedArtists = Array.isArray(previousView.related_artists) && previousView.related_artists.length > 0;
  const allArtistsChanged = Boolean(previousView.all_artists_active) !== Boolean(nextView.all_artists_active);
  const navigationRailContentKindChanged = (
    getRuntimeNavigationRailContentKind(previousView) !== getRuntimeNavigationRailContentKind(nextView)
  );
  clearPendingSidebarSelection();
  const shouldTrackSidebarReveal = options.trackSidebarReveal !== false;
  if (shouldTrackSidebarReveal) {
    const clearedSearchWithSelection = Boolean(
      String(previousView.query || '').trim()
      && !String(nextView.query || '').trim()
      && String(nextView.selected_artist || '').trim(),
    );
    const selectedArtistChanged = Boolean(selectionChanged && nextSelectedArtist);
    state.ui.pendingSidebarRevealArtist = (clearedSearchWithSelection || selectedArtistChanged)
      ? String(nextView.selected_artist || '')
      : '';
  }
  state.view = nextView;
  if (options.completePageEntryBrowseContext) {
    state.ui.pageEntryBrowseContextPending = false;
  }
  if (
    state.ui?.artistsDrawerOpen
    && (
      selectionChanged
      || allArtistsChanged
      || navigationRailContentKindChanged
    )
    && typeof closeArtistsDrawer === 'function'
  ) {
    closeArtistsDrawer({ restoreFocus: false });
  } else if (typeof syncArtistsDrawerVisibility === 'function') {
    syncArtistsDrawerVisibility();
  }
  if (
    nextSelectedArtist
  ) {
    const hasRelatedArtists = Array.isArray(nextView.related_artists) && nextView.related_artists.length > 0;
    const relatedArtistsAppearedForCurrentSelection = !previousHadRelatedArtists && hasRelatedArtists;
    const isMobileArtistsDrawer = (
      typeof isArtistsDrawerMobileViewport === 'function'
      && isArtistsDrawerMobileViewport()
    );
    if (selectionChanged || relatedArtistsAppearedForCurrentSelection) {
      state.relatedExpanded = isMobileArtistsDrawer ? false : hasRelatedArtists;
    }
  } else if (!nextSelectedArtist) {
    state.relatedExpanded = false;
  }
  if (syncSearchDraftQuery && state.ui && typeof state.ui === 'object') {
    state.ui.searchDraftQuery = String(nextView.query || '');
  }
  rememberMainGalleryCategorySelection(nextView);
  syncRelatedFilterBaseCache(nextView);
  if (nextViewIsReusableRootBrowse) {
    clearReusableRootBrowseView();
  } else if (previousViewWasReusableRootBrowse) {
    rememberReusableRootBrowseView(previousView);
  }
  rememberReusableSelectedArtistBrowseView(nextView);
  if (String(nextView.query || '').trim()) {
    ensurePreSearchViewState();
  } else {
    resetPreSearchViewState();
  }
  return nextView;
}

function mergeViewPayload(patch, options = {}) {
  const baseView = normalizeViewPayload(state.view);
  const nextPatch = isRuntimePlainObject(patch) ? patch : {};
  return applyViewPayload({ ...baseView, ...nextPatch }, options);
}

function applyStatusPayload(payload, fallbackStatus = null) {
  const nextStatus = normalizeStatusPayload(payload, fallbackStatus || state.status);
  state.status = nextStatus;
  return nextStatus;
}

function applyLocalRelatedFilterState(nextRelatedArtists, options = {}) {
  const currentView = normalizeViewPayload(state.view);
  if (!currentView.selected_artist) return null;
  const cacheState = getRelatedFilterCacheState();
  if (!cacheState) return null;

  const cacheMatchesView = (
    String(cacheState.relatedFilterBaseArtist || '') === String(currentView.selected_artist || '')
    && String(cacheState.relatedFilterBaseQuery || '') === String(currentView.query || '')
  );
  if (!cacheMatchesView || !Array.isArray(cacheState.relatedFilterBaseFamilyGroups)) {
    return null;
  }

  const activeArtists = new Set((nextRelatedArtists || []).map((value) => String(value || '').trim()).filter(Boolean));
  const nextPrimaryFilterActive = Object.prototype.hasOwnProperty.call(options, 'primary_filter_active')
    ? Boolean(options.primary_filter_active)
    : Boolean(currentView.primary_filter_active);
  const basePrimaryGroups = Array.isArray(cacheState.relatedFilterBasePrimaryGroups) ? cacheState.relatedFilterBasePrimaryGroups : [];
  const baseFamilyGroups = Array.isArray(cacheState.relatedFilterBaseFamilyGroups) ? cacheState.relatedFilterBaseFamilyGroups : [];
  const defaultPrimaryGroups = Array.isArray(cacheState.relatedFilterDefaultPrimaryGroups)
    ? cacheState.relatedFilterDefaultPrimaryGroups
    : basePrimaryGroups;
  const defaultFamilyGroups = Array.isArray(cacheState.relatedFilterDefaultFamilyGroups)
    ? cacheState.relatedFilterDefaultFamilyGroups
    : baseFamilyGroups;
  const restoresDefaultVisibleGroups = (
    !activeArtists.size
    && nextPrimaryFilterActive === Boolean(cacheState.relatedFilterBasePrimaryFilterActive)
  );
  const nextPrimaryGroups = activeArtists.size
    ? (nextPrimaryFilterActive ? basePrimaryGroups : [])
    : (restoresDefaultVisibleGroups ? defaultPrimaryGroups : basePrimaryGroups);
  const nextFamilyGroups = activeArtists.size
    ? baseFamilyGroups.filter((group) => groupMatchesRelatedArtists(group, activeArtists))
    : (restoresDefaultVisibleGroups
      ? defaultFamilyGroups
      : (nextPrimaryFilterActive ? [] : baseFamilyGroups));
  const nextArtistGroups = buildSelectedArtistRuntimeArtistGroups(
    currentView,
    nextPrimaryGroups,
    nextFamilyGroups,
  );

  // A family-chip filter is an authoritative local view transition. Requests
  // that started from the previous filter state must not overwrite it when
  // their payload arrives later.
  state.ui.viewStateRevision = Number(state.ui.viewStateRevision || 0) + 1;
  state.ui.pendingViewTransition = false;
  state.ui.pendingViewTransitionRequestId = 0;

  return mergeViewPayload({
    related_filter_artists: [...activeArtists],
    primary_filter_active: nextPrimaryFilterActive,
    primary_artist_groups: nextPrimaryGroups,
    family_artist_groups: nextFamilyGroups,
    artist_groups: nextArtistGroups,
    artist_count: nextPrimaryGroups.length + nextFamilyGroups.length,
    album_count: nextArtistGroups.reduce((sum, group) => sum + ((group?.albums || []).length), 0),
  }, { trackSidebarReveal: false });
}
