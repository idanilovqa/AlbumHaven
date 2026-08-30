function normalizeArtistPreferenceKey(value) {
  return String(value || '').trim();
}

function getSavedGalleryDisplayPreferences() {
  const defaults = typeof getDefaultGalleryDisplayPreferences === 'function'
    ? getDefaultGalleryDisplayPreferences()
    : {
      defaultGalleryDisplayMode: 'cards',
      defaultGalleryScalePercent: 100,
    };
  const source = state.gallery?.displayPreferences;
  if (typeof normalizeGalleryDisplayPreferences === 'function') {
    return normalizeGalleryDisplayPreferences({
      ...defaults,
      ...(source && typeof source === 'object' && !Array.isArray(source) ? source : {}),
    });
  }
  const displayMode = String(source?.defaultGalleryDisplayMode || defaults.defaultGalleryDisplayMode || '')
    .trim()
    .toLowerCase();
  const normalizedScale = Number(source?.defaultGalleryScalePercent ?? defaults.defaultGalleryScalePercent);
  return {
    defaultGalleryDisplayMode: displayMode === 'covers' || displayMode === 'list' ? displayMode : 'cards',
    defaultGalleryScalePercent: Number.isInteger(normalizedScale) && normalizedScale >= 80 && normalizedScale <= 140
      ? normalizedScale
      : 100,
  };
}

function normalizeResolvedGalleryDisplayMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'covers' || normalized === 'list' ? normalized : 'cards';
}

function normalizeResolvedGalleryScalePercent(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 80 && normalized <= 140 ? normalized : 100;
}

function resolveGalleryDisplayPreferenceViewState(view, options = {}) {
  const source = view && typeof view === 'object' ? view : {};
  const savedPreferences = getSavedGalleryDisplayPreferences();
  return {
    ...source,
    gallery_display_mode: Boolean(options.hasExplicitGalleryDisplayOverride)
      ? normalizeResolvedGalleryDisplayMode(source.gallery_display_mode)
      : savedPreferences.defaultGalleryDisplayMode,
    gallery_scale_percent: Boolean(options.hasExplicitGalleryScaleOverride)
      ? normalizeResolvedGalleryScalePercent(source.gallery_scale_percent)
      : savedPreferences.defaultGalleryScalePercent,
  };
}

function persistCurrentGalleryDisplayPreferences(view = null) {
  const source = view && typeof view === 'object' ? view : state.view;
  const nextPreferences = typeof normalizeGalleryDisplayPreferences === 'function'
    ? normalizeGalleryDisplayPreferences({
      defaultGalleryDisplayMode: source?.gallery_display_mode,
      defaultGalleryScalePercent: source?.gallery_scale_percent,
    })
    : {
      defaultGalleryDisplayMode: normalizeResolvedGalleryDisplayMode(source?.gallery_display_mode),
      defaultGalleryScalePercent: normalizeResolvedGalleryScalePercent(source?.gallery_scale_percent),
    };
  state.gallery.displayPreferences = nextPreferences;
  if (typeof persistGalleryDisplayPreferences === 'function') {
    persistGalleryDisplayPreferences();
  }
  return nextPreferences;
}

function looksLikeCombinedArtistName(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return /\s(?:&|and)\s/.test(normalized);
}

function combinedArtistSignature(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\band\b/g, ' ')
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .join(' ');
}

function getCurrentGalleryPreferenceArtist() {
  const selectedArtist = normalizeArtistPreferenceKey(state.view?.selected_artist);
  if (selectedArtist) return selectedArtist;
  const primaryGroups = Array.isArray(state.view?.primary_artist_groups) ? state.view.primary_artist_groups : [];
  const familyGroups = Array.isArray(state.view?.family_artist_groups) ? state.view.family_artist_groups : [];
  const fallbackGroups = !primaryGroups.length && !familyGroups.length && Array.isArray(state.view?.artist_groups)
    ? state.view.artist_groups
    : [];
  const visibleArtists = [...new Set(
    [...primaryGroups, ...familyGroups, ...fallbackGroups]
      .map((group) => normalizeArtistPreferenceKey(group?.artist))
      .filter(Boolean),
  )];
  return visibleArtists.length === 1 ? visibleArtists[0] : '';
}

function getCombineSimilarArtistsPreference(artist) {
  const key = normalizeArtistPreferenceKey(artist);
  if (!key) return false;
  return Boolean(state.gallery.combineSimilarArtistsByArtist?.[key]);
}

function setCombineSimilarArtistsPreference(artist, enabled) {
  const key = normalizeArtistPreferenceKey(artist);
  if (!key) return;
  state.gallery.combineSimilarArtistsByArtist = {
    ...(state.gallery.combineSimilarArtistsByArtist || {}),
    [key]: Boolean(enabled),
  };
  persistCombineSimilarArtistsPreferences();
}

function escapeGalleryPreferenceRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSelectedArtistAliasFamilyName(selectedArtist, candidateArtist) {
  const canonicalSelectedArtist = normalizeArtistPreferenceKey(selectedArtist);
  const canonicalCandidateArtist = normalizeArtistPreferenceKey(candidateArtist);
  if (!canonicalSelectedArtist || !canonicalCandidateArtist || canonicalSelectedArtist === canonicalCandidateArtist) {
    return false;
  }
  const matcher = new RegExp(`^${escapeGalleryPreferenceRegex(canonicalSelectedArtist)}\\s+(?:&|and|with|feat\\.?|featuring)\\s+`, 'i');
  return matcher.test(canonicalCandidateArtist);
}

function compareDisplayGroupAlbums(left, right) {
  const leftYear = Number(left?.year ?? 9999);
  const rightYear = Number(right?.year ?? 9999);
  if (leftYear !== rightYear) return leftYear - rightYear;
  const leftName = String(left?.name || '');
  const rightName = String(right?.name || '');
  const nameCompare = leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
  if (nameCompare) return nameCompare;
  return String(left?.edition || '').localeCompare(String(right?.edition || ''), undefined, { sensitivity: 'base' });
}

function buildMergedDisplayArtistName(primaryGroup, groupsToMerge) {
  const baseName = String(primaryGroup?.artist_display || primaryGroup?.artist || '').trim();
  const mergedNames = [
    baseName,
    ...groupsToMerge.map((group) => String(group?.artist_display || group?.artist || '').trim()),
  ].filter(Boolean);
  const uniqueNames = [...new Set(mergedNames)];
  return uniqueNames.join(' / ');
}

function getDisplayAlbumDeduplicationKey(album) {
  const stableKey = String(
    album?.key
    || album?.album_ref
    || album?.request_key
    || album?.identity_key
    || '',
  ).trim();
  if (stableKey) return `key:${stableKey}`;
  return JSON.stringify([
    normalizeArtistPreferenceKey(album?.album_artist || album?.artist).toLocaleLowerCase(),
    String(album?.name || album?.album || '').trim().toLocaleLowerCase(),
    String(album?.year ?? '').trim(),
    String(album?.edition || '').trim().toLocaleLowerCase(),
  ]);
}

function removeFamilyAlbumDuplicatesFromPrimaryGroups(primaryGroups, familyGroups) {
  const familyAlbumKeysByArtist = new Map();
  familyGroups.forEach((group) => {
    const familyArtist = normalizeArtistPreferenceKey(group?.artist || group?.artist_display);
    if (!familyArtist) return;
    const albumKeys = familyAlbumKeysByArtist.get(familyArtist) || new Set();
    (Array.isArray(group?.albums) ? group.albums : []).forEach((album) => {
      albumKeys.add(getDisplayAlbumDeduplicationKey(album));
    });
    familyAlbumKeysByArtist.set(familyArtist, albumKeys);
  });

  return primaryGroups.map((group) => {
    const primaryArtist = normalizeArtistPreferenceKey(group?.artist || group?.artist_display);
    const albums = Array.isArray(group?.albums) ? group.albums : [];
    const uniqueAlbums = albums.filter((album) => {
      const albumArtist = normalizeArtistPreferenceKey(album?.album_artist || primaryArtist);
      if (!albumArtist || albumArtist === primaryArtist) return true;
      return !familyAlbumKeysByArtist.get(albumArtist)?.has(getDisplayAlbumDeduplicationKey(album));
    });
    return uniqueAlbums.length === albums.length ? group : { ...group, albums: uniqueAlbums };
  });
}

function buildSelectedArtistDisplayGroups(primaryGroups, familyGroups, selectedArtist) {
  const canonicalSelectedArtist = normalizeArtistPreferenceKey(selectedArtist);
  const normalizedFamilyGroups = Array.isArray(familyGroups) ? familyGroups : [];
  const normalizedPrimaryGroups = removeFamilyAlbumDuplicatesFromPrimaryGroups(
    Array.isArray(primaryGroups) ? primaryGroups : [],
    normalizedFamilyGroups,
  );
  if (
    !canonicalSelectedArtist
    || !normalizedPrimaryGroups.length
    || !normalizedFamilyGroups.length
    || !getCombineSimilarArtistsPreference(canonicalSelectedArtist)
  ) {
    return {
      primaryGroups: normalizedPrimaryGroups,
      familyGroups: normalizedFamilyGroups,
    };
  }

  const matchingPrimaryIndex = normalizedPrimaryGroups.findIndex((group) => (
    normalizeArtistPreferenceKey(group?.artist || group?.artist_display) === canonicalSelectedArtist
  ));
  if (matchingPrimaryIndex === -1) {
    return {
      primaryGroups: normalizedPrimaryGroups,
      familyGroups: normalizedFamilyGroups,
    };
  }

  const groupsToMerge = normalizedFamilyGroups.filter((group) => (
    isSelectedArtistAliasFamilyName(canonicalSelectedArtist, group?.artist || group?.artist_display)
  ));
  if (!groupsToMerge.length) {
    return {
      primaryGroups: normalizedPrimaryGroups,
      familyGroups: normalizedFamilyGroups,
    };
  }

  const mergedAlbumKeys = new Set();
  const mergedAlbums = [
    ...(Array.isArray(normalizedPrimaryGroups[matchingPrimaryIndex]?.albums) ? normalizedPrimaryGroups[matchingPrimaryIndex].albums : []),
    ...groupsToMerge.flatMap((group) => (Array.isArray(group?.albums) ? group.albums : [])),
  ].filter((album) => {
    const key = normalizeArtistPreferenceKey(album?.key || '');
    if (!key) return true;
    if (mergedAlbumKeys.has(key)) return false;
    mergedAlbumKeys.add(key);
    return true;
  }).sort(compareDisplayGroupAlbums);

  const nextPrimaryGroups = normalizedPrimaryGroups.map((group, index) => (
    index === matchingPrimaryIndex
      ? {
        ...group,
        artist_display: buildMergedDisplayArtistName(group, groupsToMerge),
        display_artist_key: `${canonicalSelectedArtist}::merged::${groupsToMerge.map((candidateGroup) => (
          normalizeArtistPreferenceKey(candidateGroup?.artist || candidateGroup?.artist_display)
        )).join('|')}`,
        albums: mergedAlbums,
      }
      : group
  ));
  const familyGroupsToRemove = new Set(groupsToMerge.map((group) => normalizeArtistPreferenceKey(group?.artist || group?.artist_display)));
  const nextFamilyGroups = normalizedFamilyGroups.filter((group) => (
    !familyGroupsToRemove.has(normalizeArtistPreferenceKey(group?.artist || group?.artist_display))
  ));

  return {
    primaryGroups: nextPrimaryGroups,
    familyGroups: nextFamilyGroups,
  };
}

function deduplicateRepeatedCompositeArtistDisplay(value) {
  const rawValue = String(value || '').trim();
  const members = rawValue.split(/\s+\/\s+/).map((member) => member.trim()).filter(Boolean);
  if (members.length < 2) return rawValue;
  const seen = new Set();
  const uniqueMembers = [];
  let foundDuplicate = false;
  members.forEach((member) => {
    const key = member.replace(/\s+/g, ' ').toLocaleLowerCase();
    if (seen.has(key)) {
      foundDuplicate = true;
      return;
    }
    seen.add(key);
    uniqueMembers.push(member);
  });
  return foundDuplicate ? uniqueMembers.join(' / ') : rawValue;
}

function splitArtistGroupForDisplay(group) {
  const canonicalArtist = normalizeArtistPreferenceKey(group?.artist);
  const albums = Array.isArray(group?.albums) ? group.albums : [];
  const defaultGroup = {
    ...group,
    artist_display: deduplicateRepeatedCompositeArtistDisplay(
      group?.artist_display || group?.artist,
    ),
    display_artist_key: canonicalArtist || String(group?.artist_display || ''),
  };
  if (!canonicalArtist || !albums.length || getCombineSimilarArtistsPreference(canonicalArtist)) {
    return [defaultGroup];
  }

  const distinctArtists = [...new Set(
    albums.map((album) => normalizeArtistPreferenceKey(album?.album_artist || canonicalArtist)).filter(Boolean),
  )];
  const distinctSignatures = [...new Set(distinctArtists.map((artist) => combinedArtistSignature(artist)).filter(Boolean))];
  if (
    distinctArtists.length < 2
    || distinctSignatures.length <= 1
    || !distinctArtists.some((artist) => looksLikeCombinedArtistName(artist))
  ) {
    return [defaultGroup];
  }

  const buckets = new Map();
  albums.forEach((album) => {
    const albumArtist = normalizeArtistPreferenceKey(album?.album_artist || canonicalArtist) || canonicalArtist;
    if (!buckets.has(albumArtist)) buckets.set(albumArtist, []);
    buckets.get(albumArtist).push(album);
  });

  const orderedArtists = [...buckets.keys()].sort((left, right) => {
    if (left === canonicalArtist) return -1;
    if (right === canonicalArtist) return 1;
    return left.localeCompare(right, undefined, { sensitivity: 'base' });
  });

  return orderedArtists.map((artistName) => ({
    ...group,
    artist: artistName,
    artist_display: deduplicateRepeatedCompositeArtistDisplay(artistName),
    albums: buckets.get(artistName) || [],
    display_artist_key: `${canonicalArtist}::${artistName}`,
  }));
}

function buildDisplayGroups(groups) {
  return (Array.isArray(groups) ? groups : []).flatMap((group) => splitArtistGroupForDisplay(group));
}
