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

function pushBrowserViewState(view, stateSnapshot = view) {
  const settingsNavigation = window.AlbumHavenSettingsNavigation?.instance;
  if (settingsNavigation?.pushLibraryHistory) {
    settingsNavigation.pushLibraryHistory(buildUrl(view), stateSnapshot);
  } else {
    window.history.pushState(stateSnapshot, '', buildUrl(view));
  }
}
