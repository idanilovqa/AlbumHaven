function getCollectionActionState(input) {
  let state = 'invalid';
  let unavailableReason = 'invalid_resource';
  if (input !== null && typeof input === 'object' && !Array.isArray(input)
    && ['top', 'playlist', 'album'].includes(input.kind)) {
    state = ['unknown', 'loading', 'ready', 'error', 'denied'].includes(input.status)
      ? input.status : 'unknown';
    unavailableReason = `resource_${state}`;
    if (state === 'ready') {
      const { canonicalCount, visibleCount } = input;
      if (!Number.isSafeInteger(canonicalCount) || canonicalCount < 0
        || !Number.isSafeInteger(visibleCount) || visibleCount < 0
        || visibleCount > canonicalCount) {
        state = 'invalid';
        unavailableReason = 'invalid_counts';
      } else {
        state = canonicalCount === 0 ? 'empty' : visibleCount === 0 ? 'filtered_empty' : 'populated';
        unavailableReason = '';
      }
    }
  }

  const suppliedActions = unavailableReason ? null : input.allowedActions;
  const allowedActions = suppliedActions !== null && typeof suppliedActions === 'object'
    && !Array.isArray(suppliedActions) ? suppliedActions : {};
  const suppliedReasons = unavailableReason ? null : input.disabledReasons;
  const disabledReasons = suppliedReasons !== null && typeof suppliedReasons === 'object'
    && !Array.isArray(suppliedReasons) ? suppliedReasons : {};
  const actions = {};
  for (const name of ['play', 'filter', 'resetFilters', 'add', 'createAlbumTop', 'createSamplePlaylist']) {
    let reason = unavailableReason;
    if (!reason) {
      const allowed = Object.prototype.hasOwnProperty.call(allowedActions, name)
        && allowedActions[name] === true;
      if (!allowed) {
        const suppliedReason = Object.prototype.hasOwnProperty.call(disabledReasons, name)
          ? disabledReasons[name] : null;
        reason = typeof suppliedReason === 'string' && suppliedReason.length > 0
          ? suppliedReason : 'not_allowed';
      } else if (state === 'empty' && name !== 'add' && name !== 'resetFilters') {
        reason = 'empty_resource';
      }
    }
    actions[name] = { visible: true, enabled: reason === '', reason };
  }

  const playModesVisible = state === 'filtered_empty' || state === 'populated';
  actions.playModes = {
    visible: playModesVisible,
    enabled: playModesVisible && actions.play.enabled,
    reason: actions.play.reason,
  };
  return { state, actions };
}
