/* The native view and library shell own whether the React Home is visible. */
function shouldShowMobileHome() {
  const url = new URL(window.location.href), shell = document.getElementById('app-shell');
  if (url.pathname !== '/' || shell?.hidden === true || state.ui?.pendingViewTransition) return false;
  const surface = String(url.searchParams.get('surface') || state.view?.surface?.active || state.view?.surface_request || '').toLowerCase();
  return surface === 'home';
}
function renderMobileHome() {
  if (typeof syncHomeFriendsRuntime === 'function') syncHomeFriendsRuntime();
}
function syncMobileHome() {
  const host = document.getElementById('mobile-home'), show = shouldShowMobileHome();
  if (host) host.hidden = !show;
  document.getElementById('shell-main-surface')?.classList.toggle('has-mobile-home', show);
  if (typeof syncHomeFriendsRuntime === 'function') syncHomeFriendsRuntime();
  if (typeof syncPlaylistRuntime === 'function') syncPlaylistRuntime();
  if (!show && typeof showMobileGalleryPinchHint === 'function') showMobileGalleryPinchHint();
}
