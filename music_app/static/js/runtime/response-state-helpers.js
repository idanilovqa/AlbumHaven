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

function normalizeRuntimeArtistPageMode(value) {
  return normalizeRuntimeString(value, '').trim().toLowerCase() === 'info' ? 'info' : 'gallery';
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
    artist_name_match_artists: normalizeRuntimeStringList(
      source.artist_name_match_artists,
      Array.isArray(base.artist_name_match_artists) ? base.artist_name_match_artists : [],
    ),
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

// Taste is a server-owned, actor/context-bound DTO. Optional progress has a
// separate receipt: bootstrap dictionaries and arbitrary copies never admit it.
const runtimeAlbumProgressReceipts = new WeakMap();
const runtimeAlbumPreferenceReceipts = new WeakMap();
const runtimeAlbumProgressKeys = Object.freeze(['to_listen', 'is_relisten', 'can_toggle_to_listen']);
function captureRuntimeAlbumPreferenceScope() {
  if (typeof captureGalleryReadScope !== 'function') return null;
  const scope = captureGalleryReadScope();
  return scope.transport && /^[1-9]\d*$/.test(scope.actor) && /^[1-9]\d*$/.test(scope.library)
    && /^[a-f0-9]{64}$/.test(scope.context || '') && scope.context === scope.stamp
    && galleryReadScopeIsCurrent(scope) ? Object.freeze(scope) : null;
}
function runtimeAlbumPreferenceScopeIsCurrent(scope) {
  return !!scope && galleryReadScopeIsCurrent(scope) && scope.context === scope.stamp;
}
function normalizeRuntimeAlbumPreference(value, scope) {
  if (!runtimeAlbumPreferenceScopeIsCurrent(scope) || !isRuntimePlainObject(value)
    || value.context_ref !== scope.context || !isRuntimePlainObject(value.allowed_actions)
    || Object.keys(value.allowed_actions).length !== 1
    || typeof value.allowed_actions.can_manage_album_preferences !== 'boolean'
    || value.can_edit !== value.allowed_actions.can_manage_album_preferences) return null;
  const core = ['album_ref', 'context_ref', 'rating', 'is_favorite', 'favorite_override',
    'favorite_source', 'taste_state', 'preference_revision', 'can_edit', 'allowed_actions'];
  if (!core.every(key => Object.hasOwn(value, key))
    || Object.keys(value).some(key => !core.includes(key) && !runtimeAlbumProgressKeys.includes(key))) return null;
  if (value.taste_state === 'available') {
    const match = typeof value.album_ref === 'string' && /^inventory-album:([1-9]\d*):([1-9]\d*)$/.exec(value.album_ref);
    if (!match || match[1] !== scope.library
      || !(value.rating === null || Number.isInteger(value.rating) && value.rating >= 1 && value.rating <= 10)
      || typeof value.is_favorite !== 'boolean'
      || !(value.favorite_override === null || typeof value.favorite_override === 'boolean')
      || value.is_favorite !== (value.favorite_override === true)
      || value.favorite_source !== (value.favorite_override === null ? null : 'personal')
      || !Number.isSafeInteger(value.preference_revision) || value.preference_revision < 0) return null;
  } else if (value.taste_state !== 'unavailable' || value.can_edit !== false
    || ['album_ref', 'rating', 'is_favorite', 'favorite_override', 'favorite_source', 'preference_revision'].some(key => value[key] !== null)) return null;
  return Object.fromEntries(core.map(key => [key, key === 'allowed_actions'
    ? {can_manage_album_preferences: value.can_edit} : value[key]]));
}
function runtimeAlbumPreferenceGeneration(album, scope) {
  return Number.isSafeInteger(album?.album_id) && album.album_id > 0
    && (album.library_id === undefined || String(album.library_id) === scope?.library)
    ? `inventory-album:${scope.library}:${album.album_id}` : null;
}
function runtimeAlbumPreferenceForAlbum(album, scope = captureRuntimeAlbumPreferenceScope(), requireReceipt = true) {
  if (!album || album.read_only_subject || !scope) return null;
  const value = normalizeRuntimeAlbumPreference(album.album_preference, scope);
  if (!value || value.taste_state === 'available'
    && runtimeAlbumPreferenceGeneration(album, scope) !== value.album_ref) return null;
  if (requireReceipt) {
    const receipt = runtimeAlbumPreferenceReceipts.get(album.album_preference);
    if (!receipt || !runtimeAlbumPreferenceScopeIsCurrent(receipt.scope)
      || receipt.scope.actor !== scope.actor || receipt.scope.library !== scope.library
      || receipt.scope.context !== scope.context || receipt.albumRef !== runtimeAlbumPreferenceGeneration(album, scope)
      || receipt.signature !== JSON.stringify(value)) return null;
  }
  return value;
}
function retainRuntimeAlbumPreferenceReceipt(target, album, scope) {
  const core = normalizeRuntimeAlbumPreference(target, scope);
  const albumRef = runtimeAlbumPreferenceGeneration(album, scope);
  if (core && albumRef) runtimeAlbumPreferenceReceipts.set(target, {scope, albumRef, signature: JSON.stringify(core)});
  return target;
}
function copyRuntimeAlbumProgress(source, target, album, scope) {
  const receipt = source && runtimeAlbumProgressReceipts.get(source);
  if (!receipt || !runtimeAlbumPreferenceScopeIsCurrent(receipt.scope)
    || !runtimeAlbumPreferenceScopeIsCurrent(scope) || receipt.scope.context !== scope.context
    || receipt.scope.actor !== scope.actor || receipt.scope.library !== scope.library
    || receipt.albumRef !== runtimeAlbumPreferenceGeneration(album, scope)) return target;
  for (const key of runtimeAlbumProgressKeys) if (Object.hasOwn(receipt.values, key)) target[key] = receipt.values[key];
  runtimeAlbumProgressReceipts.set(target, receipt);
  return target;
}
function compactRuntimeAlbumPreference(album) {
  const scope = captureRuntimeAlbumPreferenceScope();
  const core = runtimeAlbumPreferenceForAlbum(album, scope, false);
  if (!core) return null;
  const verified = runtimeAlbumPreferenceForAlbum(album, scope) !== null;
  if (runtimeAlbumPreferenceReceipts.has(album.album_preference) && !verified) return null;
  const result = copyRuntimeAlbumProgress(album.album_preference, core, album, scope);
  // A current embedded DTO can display taste; it cannot mint a live read or
  // progress receipt. Opening its controls first performs an authorized read.
  return verified ? retainRuntimeAlbumPreferenceReceipt(result, album, scope) : result;
}
// Called only by successful current native HTTP read owners, never bootstrap,
// mutation responses, tag edits, subject copies, or metadata/path lookups.
function admitRuntimeAlbumPreferenceRead(payload, scope) {
  if (!runtimeAlbumPreferenceScopeIsCurrent(scope)) return;
  const seen = new Set(), queue = [payload];
  const containers = ['album', 'albums', 'artist_groups', 'primary_artist_groups', 'family_artist_groups',
    'chronological_artist_groups', 'selected_artist_groups', 'sections', 'subsections', 'duplicate_sources'];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value) || value.read_only_subject) continue;
    seen.add(value);
    if (Array.isArray(value)) {queue.push(...value); continue;}
    for (const key of containers) if (value[key]) queue.push(value[key]);
    const core = runtimeAlbumPreferenceForAlbum(value, scope, false);
    const albumRef = runtimeAlbumPreferenceGeneration(value, scope);
    if (!core || !albumRef) continue;
    retainRuntimeAlbumPreferenceReceipt(value.album_preference, value, scope);
    const values = {};
    for (const key of runtimeAlbumProgressKeys) {
      if (typeof value.album_preference[key] === 'boolean') values[key] = value.album_preference[key];
    }
    if (Object.keys(values).length) runtimeAlbumProgressReceipts.set(value.album_preference,
      {scope, albumRef, values: Object.freeze(values)});
  }
}

function compactRuntimeAlbumPayload(album) {
  if (!isRuntimePlainObject(album)) {
    return album;
  }
  const sourceAlbumPreference = compactRuntimeAlbumPreference(album);
  const compactedRatingContract = {
    ...(sourceAlbumPreference
      ? { album_preference: sourceAlbumPreference, album_rating: sourceAlbumPreference.rating }
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
  // Public/unbound compaction cannot carry own personal aliases or actions.
  for (const key of ['album_rating', 'rating', 'favorite', 'is_favorite', 'favorite_override', 'favorite_source',
    'preference_revision', 'can_edit', 'context_ref', 'taste_state', 'to_listen', 'is_relisten', 'can_toggle_to_listen',
    'album_preference_overlay', 'can_manage_album_preferences']) delete baseAlbum[key];
  if (baseAlbum.allowed_actions) {
    baseAlbum.allowed_actions = {...baseAlbum.allowed_actions};
    delete baseAlbum.allowed_actions.can_manage_album_preferences;
    delete baseAlbum.allowed_actions.can_toggle_to_listen;
  }
  if (album.read_only_subject) {
    baseAlbum.taste_state = album.taste_state === 'available' ? 'available' : 'unavailable';
    baseAlbum.album_rating = baseAlbum.taste_state === 'available' && Number.isInteger(album.album_rating)
      && album.album_rating >= 1 && album.album_rating <= 10 ? album.album_rating : null;
    baseAlbum.favorite = baseAlbum.taste_state === 'available' && typeof album.favorite === 'boolean' ? album.favorite : null;
  }
  const compactedMoveAvailability = compactRuntimeMoveAvailability(album.move_availability);
  if (album.preview_only) {
    return {
      ...baseAlbum,
      ...compactedRatingContract,
      duplicate_sources: [], tracks: [], track_rows: [],
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
    track_rows: [],
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
    // Preference receipts belong to exact response rows, never reconstructed copies.
    non_album_tracks: cloneRuntimeArray(normalizedView.non_album_tracks),
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
    // Info requests and responses require a fresh selected-Artist read, even
    // when a parsed request has no server descriptor yet.
    && view?.private_search !== true
    && normalizeRuntimeArtistPageMode(view?.page_mode) !== 'info'
    && normalizeRuntimeArtistPageMode(view?.artist_page?.active_page_mode) !== 'info'
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
  const requestedSource = String(view?.search_context?.selected_artist_source || '').trim();
  const cachedSource = String(cachedView?.search_context?.selected_artist_source || '').trim();
  const selectedArtist = String(view?.selected_artist || '').trim();
  const cachedNameMatches = cachedView?.search_context?.artist_name_match_artists;
  // Automatic search selection may include connected-family previews. An explicit
  // content-only selection instead requires the server's narrow matching records.
  if (requestedSource === 'requested_artist' && cachedSource === 'auto_top_match'
    && !(Array.isArray(cachedNameMatches)
      && cachedNameMatches.some(artist => String(artist || '').trim() === selectedArtist))) {
    return null;
  }
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

// Private Search owns its result DTO. Native navigation receives only this
// finite projection, never a response spread or a reusable row/source snapshot.
function normalizePrivateSearchNavigation(payload, fallbackView = null) {
  const base = isRuntimePlainObject(fallbackView) ? fallbackView : {};
  const wire = payload.contract_version === 'own-love-v1';
  const listener = payload.contract_version === 'listener-search-v1';
  const popularity = ['popularity-search-v1', 'popularity-search-albums-v1'].includes(payload.contract_version);
  const tracksOnly = listener || payload.contract_version === 'popularity-search-v1';
  const noSidebar = listener || popularity;
  const rows = noSidebar ? [] : wire ? payload.sidebar?.artists : payload.artists_sidebar;
  const artists = (Array.isArray(rows) ? rows : []).filter(row =>
    typeof row?.artist === 'string' && row.artist.trim()).map(row => ({
    artist: row.artist,
    artist_display: typeof row.artist_display === 'string' ? row.artist_display : row.artist,
    ...(Number.isInteger(row.count) && row.count >= 0 ? {count: row.count} : {}),
  }));
  return {
    ok: true,
    surface: {active: 'albums'}, surface_request: 'albums',
    private_search: true, artist_loved_context_ref: null,
    query: typeof payload.query === 'string' ? payload.query : '',
    selected_artist: !noSidebar && typeof payload.selected_artist === 'string' ? payload.selected_artist : '',
    all_artists_active: !noSidebar && (wire ? payload.selection_state === 'all_artists' : payload.all_artists_active === true),
    search_presentation: tracksOnly || (wire || popularity ? payload.presentation : payload.search_presentation) === 'tracks' ? 'tracks' : 'albums',
    artist_groups: [], primary_artist_groups: [], family_artist_groups: [],
    artists_sidebar: artists, related_artists: [], related_filter_artists: [],
    search_filters: normalizeRuntimeSearchFilters(null),
    // These are existing ordinary UI contracts, never properties of the private
    // envelope. They do not parse or authorize the raw committed query.
    search_filter_contract: normalizeRuntimeSearchFilterContract(base.search_filter_contract),
    search_query_contract: normalizeRuntimeSearchQueryContract(base.search_query_contract),
    visible_library_categories: normalizeVisibleLibraryCategorySelection(base.visible_library_categories),
    search_context: null, ignored_version_keys: [], non_album_tracks: [],
    non_album_exception_values: [], manual_version_links: {},
    gallery_scope: normalizeRuntimeString(base.gallery_scope, 'all'),
    gallery_display_mode: normalizeRuntimeGalleryDisplayMode(base.gallery_display_mode),
    gallery_scale_percent: normalizeRuntimeGalleryScalePercent(base.gallery_scale_percent),
    music_dir: normalizeRuntimeString(base.music_dir),
    app_name: normalizeRuntimeString(base.app_name), app_version: normalizeRuntimeString(base.app_version),
    album_count: 0, artist_count: artists.length,
    show_all_artists_sidebar_link: !noSidebar && (wire || payload.show_all_artists_sidebar_link !== false), primary_filter_active: false,
    initial_view_partial: false, payload_tier: 'full',
  };
}

// A launch is response-local authority. Cached objects keep their original
// transport/read lifetime and can never acquire a fresh one merely by matching a name.
const artistLovedLaunchReceipts = new WeakMap();
let artistLovedReadEpoch = 0;
function artistLovedTransportGeneration() {
  return typeof PrivateUITransport !== 'undefined' ? PrivateUITransport.generation() : null;
}
function artistLovedReadScope(view) {
  return JSON.stringify([view?.surface?.active || view?.surface_request || 'albums',
    view?.selected_artist || '', view?.query || '', view?.gallery_scope || '', view?.private_search === true]);
}
function normalizeRuntimeArtistLovedLaunch(value, stamp, anchor, mode, epoch = artistLovedReadEpoch) {
  // Ordinary Artist responses need not carry Loved authority or a browser integration.
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof stamp !== 'string' || !/^[0-9a-f]{64}$/.test(stamp)
    || typeof anchor !== 'string' || !anchor.trim() || !['artist', 'family'].includes(mode)
    || typeof window === 'undefined'
    || typeof window?.AlbumHavenPlaylistUI?.normalizeArtistLovedLaunch !== 'function') return null;
  const parsed = window.AlbumHavenPlaylistUI.normalizeArtistLovedLaunch(value);
  if (!parsed || parsed.context_ref !== stamp || parsed.artist_ref !== anchor || parsed.descriptor.scope_mode !== mode) return null;
  const generation = artistLovedTransportGeneration();
  if (generation === null) return null;
  const prior = artistLovedLaunchReceipts.get(value);
  if (prior && (prior.generation !== generation || prior.epoch !== epoch)) return null;
  const receipt = prior || {generation, epoch,
    readScope: typeof captureGalleryReadScope === 'function' ? captureGalleryReadScope() : null};
  if (receipt.readScope && !galleryReadScopeIsCurrent(receipt.readScope)) return null;
  artistLovedLaunchReceipts.set(value, receipt);
  artistLovedLaunchReceipts.set(parsed, receipt);
  return parsed;
}
function artistLovedLaunchIsCurrent(launch) {
  const receipt = launch && artistLovedLaunchReceipts.get(launch);
  return Boolean(receipt && receipt.generation === artistLovedTransportGeneration() && receipt.epoch === artistLovedReadEpoch
    && (!receipt.readScope || galleryReadScopeIsCurrent(receipt.readScope)));
}
// Top launches share the existing response read lifetime, never Loved grants.
const artistListenThroughLaunchReceipts = new WeakMap();
function artistListenThroughDescriptor(value) {
  const fields = (object, keys) => {
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).length !== keys.length) return null;
    const descriptors = Object.getOwnPropertyDescriptors(object);
    return keys.every(key => descriptors[key] && Object.hasOwn(descriptors[key], 'value')) ? descriptors : null;
  };
  const outer = fields(value, ['context_ref', 'artist_ref', 'artist_scope']);
  if (!outer) return null;
  const inner = fields(outer.artist_scope.value, ['root_artist_id', 'mode']);
  if (!inner) return null;
  const stamp = outer.context_ref.value, artist = outer.artist_ref.value, root = inner.root_artist_id.value, mode = inner.mode.value;
  if (typeof stamp !== 'string' || stamp.length !== 64 || !/^[0-9a-f]{64}$/.test(stamp)
    || typeof artist !== 'string' || !artist.trim() || typeof root !== 'string' || root.trim() !== root
    || !/^[1-9][0-9]{0,18}$/.test(root) || root.length === 19 && root > '9223372036854775807' || mode !== 'artist') return null;
  return {context_ref: stamp, artist_ref: artist, artist_scope: {root_artist_id: root, mode}};
}
function artistListenThroughDescriptorMatches(value, expected) {
  const actual = artistListenThroughDescriptor(value);
  return Boolean(actual && actual.context_ref === expected.context_ref && actual.artist_ref === expected.artist_ref
    && actual.artist_scope.root_artist_id === expected.artist_scope.root_artist_id && actual.artist_scope.mode === expected.artist_scope.mode);
}
function artistListenThroughScopeMatches(scope, descriptor, generation) {
  const shell = document.getElementById('app-shell');
  return Boolean(scope && shell && scope.context === descriptor.context_ref && scope.stamp === descriptor.context_ref
    && scope.generation === generation && scope.transport === window.AlbumHavenPrivateUITransport
    && scope.actor === String(shell.dataset?.nativeAccountId || '')
    && scope.library === String(shell.dataset?.nativeLibraryId || '')
    && scope.stamp === String(shell.dataset?.privateUiContext || ''));
}
function normalizeRuntimeArtistListenThroughLaunch(value, stamp, anchor, epoch = artistLovedReadEpoch) {
  try {
    const descriptor = artistListenThroughDescriptor(value), entryEpoch = artistLovedReadEpoch;
    if (!descriptor || descriptor.context_ref !== stamp || descriptor.artist_ref !== anchor
      || typeof captureGalleryReadScope !== 'function' || typeof galleryReadScopeIsCurrent !== 'function') return null;
    const prior = artistListenThroughLaunchReceipts.get(value), generation = artistLovedTransportGeneration();
    if (generation === null || generation === undefined || prior && (prior.generation !== generation || prior.epoch !== epoch
      || !artistListenThroughDescriptorMatches(value, prior.launch))) return null;
    const readScope = prior?.readScope || captureGalleryReadScope();
    if (!artistListenThroughScopeMatches(readScope, descriptor, generation)
      || artistLovedTransportGeneration() !== generation || !galleryReadScopeIsCurrent(readScope)
      || artistLovedTransportGeneration() !== generation || artistLovedReadEpoch !== entryEpoch
      || !artistListenThroughScopeMatches(readScope, descriptor, generation)
      || !artistListenThroughDescriptorMatches(value, descriptor)) return null;
    if (prior) return prior.launch;
    const launch = Object.freeze({...descriptor, artist_scope: Object.freeze(descriptor.artist_scope)});
    const receipt = Object.freeze({generation, epoch, readScope, launch});
    artistListenThroughLaunchReceipts.set(value, receipt); artistListenThroughLaunchReceipts.set(launch, receipt);
    return launch;
  } catch {return null;}
}
function artistListenThroughLaunchIsCurrent(launch) {
  try {
    const receipt = launch && artistListenThroughLaunchReceipts.get(launch);
    if (!receipt || typeof captureGalleryReadScope !== 'function' || typeof galleryReadScopeIsCurrent !== 'function'
      || receipt.epoch !== artistLovedReadEpoch || !artistListenThroughDescriptorMatches(launch, receipt.launch)) return false;
    const generation = artistLovedTransportGeneration();
    if (generation === null || generation === undefined || receipt.generation !== generation || !galleryReadScopeIsCurrent(receipt.readScope)) return false;
    return artistLovedTransportGeneration() === generation && receipt.epoch === artistLovedReadEpoch
      && artistListenThroughScopeMatches(receipt.readScope, receipt.launch, generation)
      && artistListenThroughDescriptorMatches(launch, receipt.launch);
  } catch {return false;}
}
function replaceArtistListenThroughViewLaunches(view, source, {local = false, epoch = artistLovedReadEpoch} = {}) {
  const candidate = source?.artist_listen_through_context_ref;
  const stamp = typeof candidate === 'string' && candidate.length === 64 && /^[0-9a-f]{64}$/.test(candidate)
    && !view.private_search && !['playlists', 'album_tops', 'home'].includes(view.surface?.active || view.surface_request) ? candidate : null;
  view.artist_listen_through_context_ref = stamp;
  const normalize = (launch, anchor) => {
    if (local && !artistListenThroughLaunchIsCurrent(launch)) return null;
    return normalizeRuntimeArtistListenThroughLaunch(launch, stamp, anchor, epoch);
  };
  for (const key of ['artist_groups', 'primary_artist_groups', 'family_artist_groups', 'related_filter_base_primary_groups', 'related_filter_base_family_groups']) {
    if (!Array.isArray(view[key])) continue;
    const admitted = local || Array.isArray(source?.[key]);
    view[key] = view[key].map(group => ({...group, artist_listen_through_launch: admitted ? normalize(group?.artist_listen_through_launch, group?.artist) : null}));
  }
  if (view.artist_page) {
    const launch = local ? view.artist_page.artist_listen_through_launch : source?.artist_page?.artist_listen_through_launch;
    view.artist_page = {...view.artist_page, artist_listen_through_launch: normalize(launch, view.artist_page.artist_ref)};
  }
  return view;
}

function replaceArtistLovedViewLaunches(view, source, {local = false, epoch = artistLovedReadEpoch} = {}) {
  const stamp = typeof source?.artist_loved_context_ref === 'string' && /^[0-9a-f]{64}$/.test(source.artist_loved_context_ref)
    && !view.private_search && !['playlists', 'album_tops', 'home'].includes(view.surface?.active || view.surface_request)
    ? source.artist_loved_context_ref : null;
  view.artist_loved_context_ref = stamp;
  for (const key of ['artist_groups', 'primary_artist_groups', 'family_artist_groups', 'related_filter_base_primary_groups', 'related_filter_base_family_groups']) {
    if (!Array.isArray(view[key])) continue;
    // Missing group arrays on a partial response cannot borrow fallback authority.
    const admitted = local || Array.isArray(source?.[key]);
    view[key] = view[key].map(group => ({...group, artist_loved_launch: admitted
      ? normalizeRuntimeArtistLovedLaunch(group?.artist_loved_launch, stamp, group?.artist, 'artist', epoch) : null}));
  }
  if (view.artist_page) {
    const launches = local ? view.artist_page.artist_loved_launches : source?.artist_page?.artist_loved_launches;
    view.artist_page = {...view.artist_page, artist_loved_launches: {
      artist: normalizeRuntimeArtistLovedLaunch(launches?.artist, stamp, view.artist_page.artist_ref, 'artist', epoch),
      family: normalizeRuntimeArtistLovedLaunch(launches?.family, stamp, view.artist_page.artist_ref, 'family', epoch),
    }};
  }
  return view;
}

function normalizeViewPayload(payload, fallbackView = null, {artistLovedEpoch = artistLovedReadEpoch, artistListenThroughLocal = false} = {}) {
  const defaults = typeof appBootstrap?.getInitialView === 'function'
    ? appBootstrap.getInitialView()
    : {};
  const base = {
    ...defaults,
    ...(isRuntimePlainObject(fallbackView) ? fallbackView : {}),
  };
  const source = isRuntimePlainObject(payload) ? payload : {};
  if (source.private_search === true) return replaceArtistListenThroughViewLaunches(normalizePrivateSearchNavigation(source, base), {}, {epoch: artistLovedEpoch});
  // A subsequent ordinary response must not inherit private routing from its
  // fallback view. Its ordinary normalizer and response fields remain intact.
  if (base.private_search === true) {
    delete base.private_search;
    delete base.search_presentation;
  }
  const resolvedSurface = String(
    source?.surface?.active
      ?? source?.surface_request
      ?? base?.surface?.active
      ?? base?.surface_request
      ?? '',
  ).trim().toLowerCase();
  const isCollectionSurface = resolvedSurface === 'playlists' || resolvedSurface === 'album_tops';
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
      isCollectionSurface ? [] : source.artist_groups,
      isCollectionSurface ? [] : base.artist_groups,
    ),
    primary_artist_groups: cloneRuntimeArray(
      isCollectionSurface ? [] : (resetSelectedArtistScopedGroups ? [] : source.primary_artist_groups),
      isCollectionSurface ? [] : base.primary_artist_groups,
    ),
    family_artist_groups: cloneRuntimeArray(
      isCollectionSurface ? [] : (resetSelectedArtistScopedGroups ? [] : source.family_artist_groups),
      isCollectionSurface ? [] : base.family_artist_groups,
    ),
    artists_sidebar: cloneRuntimeArray(
      isCollectionSurface ? [] : source.artists_sidebar,
      isCollectionSurface ? [] : base.artists_sidebar,
    ),
    related_artists: cloneRuntimeArray(
      isCollectionSurface ? [] : source.related_artists,
      isCollectionSurface ? [] : base.related_artists,
    ),
    related_filter_artists: cloneRuntimeArray(
      isCollectionSurface ? [] : source.related_filter_artists,
      isCollectionSurface ? [] : base.related_filter_artists,
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
      isCollectionSurface || explicitlyClearsSelectedArtist ? '' : source.selected_artist,
      isCollectionSurface ? '' : base.selected_artist,
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
      isCollectionSurface ? false : source.all_artists_active,
      isCollectionSurface ? false : base.all_artists_active,
    ),
    show_all_artists_sidebar_link: normalizeRuntimeBoolean(
      isCollectionSurface ? false : source.show_all_artists_sidebar_link,
      isCollectionSurface ? false : base.show_all_artists_sidebar_link,
    ),
    primary_filter_active: normalizeRuntimeBoolean(
      isCollectionSurface ? false : source.primary_filter_active,
      isCollectionSurface ? false : base.primary_filter_active,
    ),
    initial_view_partial: normalizeRuntimeBoolean(
      source.initial_view_partial,
      initialViewPartialFallback,
    ),
    ...(selectedArtistFamilyDisplayMode ? { selected_artist_family_display_mode: selectedArtistFamilyDisplayMode } : {}),
    ...(playbackContext ? { playback_context: playbackContext } : {}),
  };
  // Only a local non-identity patch may retain the previous descriptor. A new
  // browse response must carry its own canonical Artist presentation, including
  // a full response for the same Artist; request mode is not read admission.
  const replacesArtistPage = [
    'surface', 'surface_request', 'selected_artist', 'query', 'page_mode',
    'artist_groups', 'primary_artist_groups', 'family_artist_groups', 'payload_tier',
    'gallery_scope', 'visible_library_categories', 'related_filter_artists',
    'primary_filter_active', 'search_filters', 'private_search',
  ].some((key) => Object.prototype.hasOwnProperty.call(source, key));
  const artistPage = Object.prototype.hasOwnProperty.call(source, 'artist_page')
    ? source.artist_page
    : replacesArtistPage ? null : base.artist_page;
  const selectedArtist = normalizedView.selected_artist.trim();
  if (selectedArtist && (!resolvedSurface || resolvedSurface === 'albums')
    && normalizedView.private_search !== true && isRuntimePlainObject(artistPage)
    && typeof artistPage.artist_ref === 'string' && artistPage.artist_ref.trim() === selectedArtist) {
    const pageMode = normalizeRuntimeArtistPageMode(artistPage.active_page_mode);
    normalizedView.artist_page = { ...artistPage, artist_ref: selectedArtist, active_page_mode: pageMode };
    normalizedView.page_mode = pageMode;
  } else {
    delete normalizedView.artist_page;
    delete normalizedView.page_mode;
  }
  // A replacement search/artist payload must not inherit a root page cursor.
  if (isCollectionSurface || normalizedView.query || normalizedView.selected_artist
    || (Array.isArray(source.artist_groups) && !Object.prototype.hasOwnProperty.call(source, 'gallery_page'))) {
    delete normalizedView.gallery_page;
    delete normalizedView.gallery_page_scope;
  }
  if (isCollectionSurface) {
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
  if (resolvedSurface !== 'album_tops') delete normalizedView.top_ref;
  if (resolvedSurface === 'album_tops') {
    normalizedView.top_ref = typeof source.top_ref === 'string' ? source.top_ref : null;
    delete normalizedView.playlist_detail;
    delete normalizedView.playlist_index;
    delete normalizedView.playlist_sidebar;
    delete normalizedView.playlist_creation_source;
    delete normalizedView.playlist_actions;
    delete normalizedView.search_context;
  }
  const localLovedPatch = Object.keys(source).every(key => ['gallery_display_mode', 'gallery_scale_percent'].includes(key));
  replaceArtistLovedViewLaunches(normalizedView, localLovedPatch ? base : source, {local: localLovedPatch, epoch: artistLovedEpoch});
  return replaceArtistListenThroughViewLaunches(normalizedView, localLovedPatch ? base : source, {local: localLovedPatch || artistListenThroughLocal, epoch: artistLovedEpoch});
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
    allowed_actions: isRuntimePlainObject(source.allowed_actions) ? { ...source.allowed_actions } : {},
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
  // An admitted Artist owns this exact view and its mounted release records.
  // Idle modal cleanup is not another admission and must not replace it.
  const ownedView = state.view;
  const artist = typeof window !== 'undefined' ? window.AlbumHavenArtistPageRuntime?.snapshot() : null;
  if (state.view !== ownedView || artist?.retained) return state.view;
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
  const ownsResponseApply = () => {
    try { return typeof options.isCurrentResponse !== 'function' || options.isCurrentResponse() === true; }
    catch (_error) { return false; }
  };
  if (!ownsResponseApply()) return null;
  if (!options.rootGalleryContinuation && typeof cancelRootGalleryPageRequest === 'function') {
    cancelRootGalleryPageRequest();
  }
  const applySourceView = state.view;
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
  const nextLovedEpoch = artistLovedReadEpoch + ((!options.rootGalleryContinuation && !options.localArtistLovedTransition
    || artistLovedReadScope({...mountedPreviousView, ...nextPayload}) !== artistLovedReadScope(mountedPreviousView)) ? 1 : 0);
  const normalizedNextView = normalizeViewPayload(nextPayload, previousView, {artistLovedEpoch: nextLovedEpoch, artistListenThroughLocal: options.localArtistLovedTransition === true});
  const nextView = (options.retainFullAlbums || viewShouldRetainFullRuntimeAlbums(normalizedNextView))
    ? normalizedNextView
    : compactRuntimeViewPayload(normalizedNextView);
  if (!ownsResponseApply()) return null;
  // Sidebar counts retain the source scope of their own response when album-only
  // hydration preserves the navigation tree.
  const sidebarCategories = options.preserveSidebarState
    ? previousView.sidebar_library_categories
    : nextPayload?.sidebar_library_categories || nextPayload?.visible_library_categories;
  nextView.sidebar_library_categories = Array.isArray(sidebarCategories)
    ? [...sidebarCategories]
    : null;
  // Loaded album coverage follows the response, independently of the browse URL.
  // Local merged patches carry this field forward; server replacements use their
  // own categories instead of inheriting coverage from the previous albums.
  nextView.loaded_library_categories = [...(
    Array.isArray(nextPayload?.loaded_library_categories)
      ? nextPayload.loaded_library_categories
      : Array.isArray(nextPayload?.visible_library_categories)
        ? normalizedNextView.visible_library_categories
        : previousView.loaded_library_categories || normalizedNextView.visible_library_categories
  )];
  nextView.non_album_library_categories = [...(
    nextPayload?.non_album_library_categories
    || (Array.isArray(nextPayload?.non_album_tracks)
      ? nextView.loaded_library_categories
      : previousView.non_album_library_categories || nextView.loaded_library_categories)
  )];
  if (nextView.gallery_page && !options.rootGalleryContinuation && !nextPayload?.gallery_page_scope) {
    // Source hydration may retain the navigation URL. Continuations must follow
    // the actual loaded page scope, not those retained browser parameters.
    nextView.gallery_page_scope = {
      gallery_scope: normalizedNextView.gallery_scope,
      visible_library_categories: [...normalizedNextView.visible_library_categories],
      preserve_sidebar: options.preserveSidebarState === true,
    };
  }
  if (options.preserveGalleryBrowseLocationState === true) {
    nextView.gallery_scope = previousView.gallery_scope;
    nextView.visible_library_categories = [...previousView.visible_library_categories];
  }
  const preserveMountedSelectedView = Boolean(
    options.preserveMountedGalleryChildren
    && String(mountedPreviousView.selected_artist || '').trim()
      === String(nextView.selected_artist || '').trim()
    && String(mountedPreviousView.query || '').trim()
    && !String(nextView.query || '').trim()
  );
  if (preserveMountedSelectedView) {
    nextView.loaded_library_categories = [...(mountedPreviousView.loaded_library_categories || previousView.visible_library_categories)];
    // Retained mounted content keeps its identity unless launch authority must
    // be retired. Never mutate a group still referenced by the previous view.
    for (const key of ['artist_groups', 'primary_artist_groups', 'family_artist_groups']) {
      const groups = mountedPreviousView[key];
      nextView[key] = Array.isArray(groups) && groups.some(group => group?.artist_loved_launch != null || group?.artist_listen_through_launch != null)
        ? groups.map(group => group?.artist_loved_launch != null || group?.artist_listen_through_launch != null
          ? {...group, ...(group.artist_loved_launch != null ? {artist_loved_launch: null} : {}),
            ...(group.artist_listen_through_launch != null ? {artist_listen_through_launch: null} : {})} : group)
        : groups;
    }
    for (const key of ['related_filter_base_primary_groups', 'related_filter_base_family_groups']) {
      if (Array.isArray(nextView[key])) nextView[key] = nextView[key].map(group => group?.artist_listen_through_launch != null
        ? {...group, artist_listen_through_launch: null} : group);
    }
    nextView.artist_listen_through_context_ref = null;
    if (nextView.artist_page) nextView.artist_page = {...nextView.artist_page, artist_listen_through_launch: null};
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
  if (!ownsResponseApply() || state.view !== applySourceView) return null;
  artistLovedReadEpoch = nextLovedEpoch;
  state.view = nextView;
  if(typeof syncAdvancedSearchAppliedView==='function')syncAdvancedSearchAppliedView({changed:String(previousView.query || '') !== String(nextView.query || '') || previousView.selected_artist !== nextView.selected_artist || previousView.surface?.active !== nextView.surface?.active});
  const ownsAppliedView = () => ownsResponseApply() && state.view === nextView;
  if (!ownsAppliedView()) return nextView;
  if (typeof window !== 'undefined') window.AlbumHavenSearchRuntime?.syncNativeView({isCurrentResponse: options.isCurrentResponse});
  if (!ownsAppliedView()) return nextView;
  if (typeof selectLibrarySidebarMode === 'function' && previousView.surface?.active !== nextView.surface?.active
    && ['playlists', 'album_tops'].includes(nextView.surface?.active)) selectLibrarySidebarMode(nextView.surface.active);
  if (!ownsAppliedView()) return nextView;
  if (typeof syncHomeFriendsRuntime === 'function') syncHomeFriendsRuntime();
  if (!ownsAppliedView()) return nextView;
  if (typeof syncPlaylistRuntime === 'function') syncPlaylistRuntime();
  if (!ownsAppliedView()) return nextView;
  if (typeof syncAlbumTopsRuntime === 'function') syncAlbumTopsRuntime();
  if (!ownsAppliedView()) return nextView;
  if (typeof syncGalleryMainStateFromView === 'function') syncGalleryMainStateFromView(previousView, nextView);
  if (!ownsAppliedView()) return nextView;
  if (options.completePageEntryBrowseContext) {
    state.ui.pageEntryBrowseContextPending = false;
  }
  if (
    state.ui?.artistsDrawerOpen
    // Explicit navigation closes its drawer at activation. A later search
    // response must not dismiss a drawer the user has opened since that request.
    && navigationRailContentKindChanged
    && typeof closeArtistsDrawer === 'function'
  ) {
    closeArtistsDrawer({ restoreFocus: false });
  } else if (typeof syncArtistsDrawerVisibility === 'function') {
    syncArtistsDrawerVisibility();
  }
  if (!ownsAppliedView()) return nextView;
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
    if(typeof updateGallerySearchDraftQuery==='function')updateGallerySearchDraftQuery(String(nextView.query || ''));
    else state.ui.searchDraftQuery = String(nextView.query || '');
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
  if (!ownsAppliedView()) return nextView;
  return nextView;
}

function mergeViewPayload(patch, options = {}) {
  const baseView = normalizeViewPayload(state.view);
  const nextPatch = isRuntimePlainObject(patch) ? patch : {};
  const local = Object.keys(nextPatch).every(key => ['gallery_display_mode', 'gallery_scale_percent'].includes(key));
  return applyViewPayload({ ...baseView, ...nextPatch,
    artist_loved_context_ref: local ? baseView.artist_loved_context_ref : nextPatch.artist_loved_context_ref ?? null,
    artist_listen_through_context_ref: local ? baseView.artist_listen_through_context_ref : nextPatch.artist_listen_through_context_ref ?? null,
  }, {...options, localArtistLovedTransition: local || options.localArtistLovedTransition === true});
}

function applyStatusPayload(payload, fallbackStatus = null) {
  const nextStatus = normalizeStatusPayload(payload, fallbackStatus || state.status);
  state.status = nextStatus;
  state.loopCreateAllowed = nextStatus.allowed_actions?.['library.loops.create'] === true;
  if (typeof syncLoopCreateCapability === 'function') syncLoopCreateCapability();
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
  state.ui.pendingGallerySearch = false;
  state.ui.pendingViewTransitionRequestId = 0;

  return mergeViewPayload({
    artist_loved_context_ref: currentView.artist_loved_context_ref,
    artist_listen_through_context_ref: currentView.artist_listen_through_context_ref,
    related_filter_artists: [...activeArtists],
    primary_filter_active: nextPrimaryFilterActive,
    primary_artist_groups: nextPrimaryGroups,
    family_artist_groups: nextFamilyGroups,
    artist_groups: nextArtistGroups,
    artist_count: nextPrimaryGroups.length + nextFamilyGroups.length,
    album_count: nextArtistGroups.reduce((sum, group) => sum + ((group?.albums || []).length), 0),
  }, { trackSidebarReveal: false, localArtistLovedTransition: true });
}
