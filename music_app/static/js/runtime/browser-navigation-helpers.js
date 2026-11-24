// What the readers of history state use. A view is named by its address, so the state is only where
// the entry is in the app's navigation.
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

// An entry loaded again keeps only the keys above.
function dropViewFromHistoryState() {
  if (!window.history?.state) return;
  const kept = historyNavigationState();
  if (Object.keys(window.history.state || {}).length === Object.keys(kept).length) return;
  window.history.replaceState(kept, '', getBrowserLocationHref());
}
