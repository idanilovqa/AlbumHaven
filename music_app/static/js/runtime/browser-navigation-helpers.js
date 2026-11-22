// What the readers of history state use. The browser writes the state to its session files, where
// signing out does not reach it, so nothing of the library is kept there.
const HISTORY_NAVIGATION_KEYS = ['albumHavenNavigationPosition', 'albumHavenDiscoveryPosition', 'mobilePages', 'imageLightbox'];

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

function pushBrowserViewState(view) {
  const settingsNavigation = window.AlbumHavenSettingsNavigation?.instance;
  if (settingsNavigation?.pushLibraryHistory) {
    settingsNavigation.pushLibraryHistory(buildUrl(view), {});
  } else {
    window.history.pushState({}, '', buildUrl(view));
  }
}

function historyNavigationState() {
  return Object.fromEntries(
    Object.entries(window.history.state || {}).filter(([key]) => HISTORY_NAVIGATION_KEYS.includes(key)),
  );
}

function replaceBrowserViewState(view) {
  window.history.replaceState(historyNavigationState(), '', buildUrl(view));
}

// Entries written by earlier builds held their whole view.
function dropViewFromHistoryState() {
  if (!window.history?.state) return;
  const kept = historyNavigationState();
  if (Object.keys(window.history.state || {}).length === Object.keys(kept).length) return;
  window.history.replaceState(kept, '', getBrowserLocationHref());
}
