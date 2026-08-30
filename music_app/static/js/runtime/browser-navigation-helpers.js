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
  window.history.pushState(stateSnapshot, '', buildUrl(view));
}
