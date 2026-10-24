function getBrowserLocationOrigin() {
  return window.location.origin;
}

function getBrowserLocationHref() {
  return window.location.href;
}

function parseBrowserUrlState(url) {
  return parseUrlStateFromUrl(url, getBrowserLocationOrigin());
}

function parseCurrentBrowserUrlState() {
  return parseBrowserUrlState(getBrowserLocationHref());
}

function pushBrowserViewState(view, stateSnapshot = view, retainedPlaylistDraft = null) {
  const settingsNavigation = window.AlbumHavenSettingsNavigation?.instance;
  const marker = retainedPlaylistDraft || settingsNavigation?.retainedPlaylistDraft?.();
  if (marker) {
    if (!settingsNavigation?.isPlaylistDraftCurrent?.(marker)) return false;
    stateSnapshot = {playlistDraft: {token: marker.token, scopeKey: marker.scopeKey}};
  }
  if (settingsNavigation?.pushLibraryHistory) {
    settingsNavigation.pushLibraryHistory(buildUrl(view), stateSnapshot);
  } else {
    window.history.pushState(stateSnapshot, '', buildUrl(view));
  }
}
