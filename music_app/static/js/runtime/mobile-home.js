/* Home owns its GalleryBar and both tab rows as one composite page. */
let mobileHomeBarPosition = null;
function shouldShowMobileHome() {
  return usesMobilePageLayout() && new URL(window.location.href).searchParams.get('all_artists') !== '1'
    && !state.ui?.pendingViewTransition
    && !state.view.all_artists_active && !String(state.view.query || '').trim() && !String(state.view.selected_artist || '').trim()
    && state.view?.shell_layout?.slots?.main_content?.content_kind !== 'discovery_center_page';
}
function renderMobileHome() {
  const host = document.getElementById('mobile-home');
  if (!host || !shouldShowMobileHome() || host.dataset.homeMounted === 'true') return;
  const tabs = [['tracks', 'Top tracks'], ['albums', 'Top albums'], ['artists', 'Top Artists']]
    .map(([key, label]) => ({ key, label, panelId: `mobile-home-${key}` }));
  host.innerHTML = '<div id="mobile-home-recent" role="tabpanel" aria-labelledby="mobile-recents-navigation-recent">' + buildInPageTabsHtml({ id: 'mobile-home-tabs', label: 'Recent listening', tabs, selectedKey: 'tracks' })
    + tabs.map(tab => `<section class="mobile-home-empty" id="${tab.panelId}" role="tabpanel" aria-labelledby="mobile-home-tabs-${tab.key}" tabindex="0"${tab.key === 'tracks' ? '' : ' hidden'}><p>Nothing to show yet. Work in progress.</p></section>`).join('') + '</div>';
  mountInPageTabs(host.querySelector('[role="tablist"]'));
  host.dataset.homeMounted = 'true';
}
function syncMobileHome() {
  const host = document.getElementById('mobile-home');
  if (!host) return;
  const show = shouldShowMobileHome();
  if (show) renderMobileHome();
  host.hidden = !show;
  document.getElementById('shell-main-surface')?.classList.toggle('has-mobile-home', show);
  const bar = document.querySelector('[data-gallery-bar-instance="gallery"]');
  if (bar) {
    if (!mobileHomeBarPosition) { mobileHomeBarPosition = document.createComment('GalleryBar position'); bar.before(mobileHomeBarPosition); }
    if (show && bar.parentElement !== host) host.prepend(bar);
    else if (!show && bar.parentNode !== mobileHomeBarPosition.parentNode) mobileHomeBarPosition.after(bar);
    let tabs = bar.querySelector('.gallery-bar__home-tabs');
    if (show && !tabs) {
      tabs = document.createElement('div');
      tabs.className = 'gallery-bar__home-tabs';
      tabs.innerHTML = buildInPageTabsHtml({ id: 'mobile-recents-navigation', label: 'Home sections', selectedKey: 'recent', tabs: [
        { key: 'recent', label: 'Recent', panelId: 'mobile-home-recent' }, { key: 'news', label: 'News', disabled: true },
      ] });
      bar.appendChild(tabs);
      mountInPageTabs(tabs.querySelector('[role="tablist"]'));
      host.setAttribute('aria-label', 'Home');
    }
    if (tabs) tabs.hidden = !show;
    const actions = bar.querySelector('.gallery-bar__actions');
    if (actions) actions.hidden = show;
    if (show) {
      bar.hidden = false;
      const name = bar.querySelector('[data-gallery-context-name]');
      const summary = bar.querySelector('[data-gallery-context-summary]');
      if (name) name.textContent = host.dataset.accountName || 'My music';
      if (summary) summary.textContent = '';
    }
  }
  if (!show) showMobileGalleryPinchHint();
}
