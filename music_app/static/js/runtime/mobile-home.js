/* Home uses real account-scoped listen history and the existing GalleryCard renderer. */
const mobileHomeState = { albums: null, loading: false, error: false, request: null, refreshedAt: 0, renderKey: '' };
function shouldShowMobileHome() {
  return usesMobilePageLayout() && new URL(window.location.href).searchParams.get('all_artists') !== '1' && !state.view.all_artists_active && !String(state.view.query || '').trim() && !String(state.view.selected_artist || '').trim()
    && state.view?.shell_layout?.slots?.main_content?.content_kind !== 'discovery_center_page';
}
function renderMobileHome() {
  const host = document.getElementById('mobile-home');
  if (!host || !shouldShowMobileHome()) return;
  const mode = ensureGalleryMainState().view;
  const sources = ensureGalleryMainState().sources;
  const albums = (mobileHomeState.albums || []).filter(album => resolveGalleryAlbumSources(album).some(source => sources[source] !== false));
  const key = JSON.stringify([mode, albums, mobileHomeState.error, mobileHomeState.loading]);
  if (key === mobileHomeState.renderKey) return;
  mobileHomeState.renderKey = key;
  const intro = '<header class="mobile-home-heading"><h2>Recently played</h2></header>';
  if (mobileHomeState.error) {
    host.innerHTML = `${intro}<div class="mobile-home-empty" role="status"><p>Recently played albums could not be loaded.</p><button type="button" class="button" data-mobile-home-retry>Try again</button></div>`;
  } else if (mobileHomeState.loading && mobileHomeState.albums === null) {
    host.innerHTML = `${intro}<p role="status">Loading your recent albums…</p>`;
  } else if (!albums.length) {
    host.innerHTML = `${intro}<div class="mobile-home-empty" role="status"><p>${mobileHomeState.albums?.length ? 'No recent albums match your selected library sources.' : 'Your listening history starts here. Play an album and it will appear on Home.'}</p><button type="button" class="button" data-toggle-artists-drawer="1">Browse artists</button></div>`;
  } else {
    host.innerHTML = `${intro}<div class="mobile-home-grid" data-view="${escapeHtml(mode)}">${albums.map(album => albumCardHtml(album, { displayMode: mode, coverPriority: 'visible' })).join('')}</div>`;
    // Use normal production cover URLs and existing image load/error handlers.
    host.querySelectorAll('img[data-gallery-cover-src]').forEach(image => {
      image.loading = 'lazy'; image.src = image.dataset.galleryCoverSrc;
    });
  }
  host.querySelector('[data-mobile-home-retry]')?.addEventListener('click', () => { void loadMobileRecentAlbums(true); });
}
async function loadMobileRecentAlbums(force = false) {
  if (mobileHomeState.loading || (!force && mobileHomeState.albums !== null && Date.now() - mobileHomeState.refreshedAt < 30000)) return;
  mobileHomeState.loading = true; mobileHomeState.error = false;
  renderMobileHome();
  try {
    const response = await fetch('/home/recent-albums', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok || response.redirected) throw new Error('Recent albums unavailable.');
    const payload = await response.json();
    mobileHomeState.albums = Array.isArray(payload.albums) ? payload.albums : [];
    mobileHomeState.refreshedAt = Date.now();
  } catch (_error) { mobileHomeState.error = true; }
  finally { mobileHomeState.loading = false; renderMobileHome(); }
}
function syncMobileHome() {
  const host = document.getElementById('mobile-home');
  if (!host) return;
  const show = shouldShowMobileHome();
  host.hidden = !show;
  document.getElementById('shell-main-surface')?.classList.toggle('has-mobile-home', show);
  if (!show) return;
  const bar = document.querySelector('[data-gallery-bar-instance="gallery"]');
  if (bar) {
    bar.hidden = false;
    const name = bar.querySelector('[data-gallery-context-name]');
    const summary = bar.querySelector('[data-gallery-context-summary]');
    if (name) name.textContent = 'Home';
    if (summary) summary.textContent = '';
  }
  renderMobileHome();
  void loadMobileRecentAlbums();
}
