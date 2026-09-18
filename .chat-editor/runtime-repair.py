from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text(encoding='utf-8')
    if s.count(old)!=1: raise RuntimeError(f"{path}: expected one anchor, got {s.count(old)}")
    p.write_text(s.replace(old,new),encoding='utf-8',newline='\n')

replace('music_app/static/js/runtime/tag-editor-and-optimistic-updates.js',
"""  const tracks = Array.isArray(activeDuplicateSource?.tracks)
    ? activeDuplicateSource.tracks
    : (Array.isArray(album.tracks) ? album.tracks : []);
  if (els.duplicateWarning && els.duplicateTabs) {""",
"""  const tracks = Array.isArray(activeDuplicateSource?.tracks)
    ? activeDuplicateSource.tracks
    : (Array.isArray(album.tracks) ? album.tracks : []);
  const grouped = groupAlbumTracks(tracks);
  const bonusGroups = grouped.groups.filter((group) => group.isBonus);
  const mainGroups = grouped.groups.filter((group) => !group.isBonus);
  const mainSeconds = mainGroups.reduce((sum, group) => sum + group.tracks.reduce((inner, track) => inner + (Number(track.duration_seconds) || 0), 0), 0);
  const bonusSeconds = bonusGroups.reduce((sum, group) => sum + group.tracks.reduce((inner, track) => inner + (Number(track.duration_seconds) || 0), 0), 0);
  const totalLength = activeDuplicateSource?.total_duration_display || album.total_duration_display || formatAlbumDuration(album.total_duration_seconds);
  const mainLength = formatTrackDuration(mainSeconds) || formatAlbumDuration(mainSeconds) || (mainGroups.length ? totalLength : '');
  const bonusLength = formatTrackDuration(bonusSeconds) || formatAlbumDuration(bonusSeconds);
  if (els.duplicateWarning && els.duplicateTabs) {""")
replace('music_app/static/js/runtime/tag-editor-and-optimistic-updates.js',
"""    mainLength: hasBonusDisc ? formatTrackDuration(durationForGroups(false)) : '',
    bonusLength: hasBonusDisc ? formatTrackDuration(durationForGroups(true)) : '',""",
"""    mainLength: hasBonusDisc ? (formatTrackDuration(durationForGroups(false)) || formatAlbumDuration(durationForGroups(false))) : '',
    bonusLength: hasBonusDisc ? (formatTrackDuration(durationForGroups(true)) || formatAlbumDuration(durationForGroups(true))) : '',""")
replace('music_app/static/js/runtime/utility-list-builders.js',
"""    const countSuffix = selected.length ? ` (${selected.length})` : '';
    els.problemFilterButton.setAttribute('aria-label', `Filters${countSuffix}`);""",
"""    const countSuffix = selected.length ? ` (${selected.length})` : '';
    els.problemFilterButton.textContent = `Filters${countSuffix}`;
    els.problemFilterButton.setAttribute('aria-label', `Filters${countSuffix}`);""")
replace('tests/js/runtime/settings-refactor-shell.test.js',
"""    renderUtilityModalContent() {}, loadProblematicFiles() {}, loadUtilityRules() {}, loadUtilityLoops() {}, loadUtilityLogHistory() {}, loadUtilityIntegrations() {},""",
"""    renderUtilityModalContent() {}, loadProblematicFiles() {}, loadUtilityRules() {}, loadUtilityLibrarySettings() {}, loadUtilityLoops() {}, loadUtilityLogHistory() {}, loadUtilityIntegrations() {},""")
