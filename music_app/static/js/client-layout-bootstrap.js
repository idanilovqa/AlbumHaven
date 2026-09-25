(function initClientLayoutBootstrap(globalObject) {
  const SHELL_LAYOUT_KEY = 'albumhaven.shellLayoutPreferences.v1';
  const COMPACT_PLAYER_MODE_KEY = 'albumhaven.compactPlayer.mode.v1';
  const GALLERY_DISPLAY_KEY = 'albumhaven.galleryDisplayPreferences.v1';

  function readStorage(storage, key) {
    try { return storage?.getItem?.(key) || ''; } catch (_error) { return ''; }
  }

  function readObject(storage, key) {
    try {
      const value = JSON.parse(readStorage(storage, key) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_error) {
      return {};
    }
  }

  function normalizeGalleryScale(value) {
    const scale = Number(value);
    return Number.isInteger(scale) && scale >= 80 && scale <= 140 ? scale : 100;
  }

  function resolveClientLayoutPreferences(options = {}) {
    const desktop = Number(options.viewportWidth) > 900;
    const shell = readObject(options.storage, SHELL_LAYOUT_KEY);
    const gallery = readObject(options.storage, GALLERY_DISPLAY_KEY);
    const appearance = options.appearance && typeof options.appearance === 'object'
      ? options.appearance
      : {};
    const artistTreeFolded = desktop && shell.artistTreeFolded === true;
    const savedPlayerMode = readStorage(options.storage, COMPACT_PLAYER_MODE_KEY);
    const compactPlayerMode = desktop && savedPlayerMode === 'compact' ? 'compact' : 'expanded';
    const style = appearance.compact_player_style === 'floating' ? 'floating' : 'docked';
    const behavior = ['follow_sidebar', 'float_on_collapse', 'artbox', 'stay_docked']
      .includes(appearance.docked_compact_player_behavior)
      ? appearance.docked_compact_player_behavior
      : 'follow_sidebar';
    let compactPlayerPresentation = 'expanded';
    if (compactPlayerMode === 'compact') {
      if (style === 'floating') compactPlayerPresentation = 'floating';
      else if (!artistTreeFolded || behavior === 'stay_docked') compactPlayerPresentation = 'docked';
      else if (behavior === 'float_on_collapse') compactPlayerPresentation = 'floating';
      else compactPlayerPresentation = behavior === 'artbox' ? 'rail_artbox' : 'rail_play';
    }
    let galleryScalePercent = normalizeGalleryScale(gallery.defaultGalleryScalePercent);
    try {
      const params = new URL(String(options.href || 'http://localhost/')).searchParams;
      if (params.has('gallery_scale_percent')) {
        galleryScalePercent = normalizeGalleryScale(params.get('gallery_scale_percent'));
      }
    } catch (_error) {}
    return { artistTreeFolded, compactPlayerMode, compactPlayerPresentation, galleryScalePercent };
  }

  function resolveStartupGalleryGeometry({ availableWidth, scalePercent } = {}) {
    const width = Math.max(1, Number(availableWidth) || 1);
    const selectedCardWidth = Math.max(1, Math.round(240 * (normalizeGalleryScale(scalePercent) / 100)));
    const columns = Math.max(1, Math.floor((width + 14) / (selectedCardWidth + 14)));
    return {
      columns,
      cardTrackWidth: Math.floor(((width - (columns - 1) * 14) / columns) * 1000) / 1000,
    };
  }

  function measureStartupGalleryWidth(gallery, documentObject) {
    const galleryWidth = Number(gallery?.clientWidth || 0);
    if (galleryWidth > 0) return galleryWidth;
    const mainSurface = gallery?.closest?.('.shell-main-surface')
      || documentObject?.getElementById?.('shell-main-surface');
    const surfaceWidth = Number(mainSurface?.clientWidth || 0);
    if (surfaceWidth <= 0) return 0;
    let padding = 0;
    try {
      const styles = globalObject.getComputedStyle?.(mainSurface);
      padding = Number.parseFloat(styles?.paddingLeft || '0')
        + Number.parseFloat(styles?.paddingRight || '0');
    } catch (_error) {}
    return Math.max(0, surfaceWidth - padding);
  }

  function capture() {
    const documentObject = globalObject.document;
    const root = documentObject?.documentElement;
    if (!root) return null;
    let appearance = {};
    try {
      appearance = JSON.parse(documentObject.getElementById('appearance-bootstrap')?.textContent || '{}');
    } catch (_error) {}
    let storage = null;
    try { storage = globalObject.AlbumHavenDevicePreferences?.enabled
      ? globalObject.AlbumHavenDevicePreferences : globalObject.localStorage; } catch (_error) {}
    const layout = resolveClientLayoutPreferences({
      storage,
      href: globalObject.location?.href,
      viewportWidth: globalObject.innerWidth,
      appearance,
    });
    layout.compactPlayerStyle = appearance.compact_player_style === 'floating' ? 'floating' : 'docked';
    layout.dockedCompactPlayerBehavior = ['follow_sidebar', 'float_on_collapse', 'artbox', 'stay_docked']
      .includes(appearance.docked_compact_player_behavior)
      ? appearance.docked_compact_player_behavior
      : 'follow_sidebar';
    globalObject.__ALBUM_HAVEN_CLIENT_LAYOUT__ = layout;
    root.dataset.clientLayoutPending = 'true';
    root.style.setProperty('--compact-rail-width', layout.artistTreeFolded ? '64px' : '240px');
    root.style.setProperty('--compact-player-width', ['rail_play', 'rail_artbox'].includes(layout.compactPlayerPresentation)
      ? '64px'
      : layout.compactPlayerPresentation === 'floating' ? '96px' : '240px');
    root.setAttribute('data-compact-player-style', layout.compactPlayerStyle);
    root.setAttribute('data-docked-compact-player-behavior', layout.dockedCompactPlayerBehavior);
    root.setAttribute('data-docked-compact-player-regular-style', String(appearance.docked_compact_player_regular_style === true));
    return layout;
  }

  function finalize() {
    const documentObject = globalObject.document;
    const root = documentObject?.documentElement;
    const layout = globalObject.__ALBUM_HAVEN_CLIENT_LAYOUT__;
    if (!root || !layout) {
      root?.removeAttribute?.('data-client-layout-pending');
      return;
    }
    try {
      const shell = documentObject.getElementById('app-shell');
      const rail = documentObject.getElementById('shell-navigation-rail');
      const expandedTree = documentObject.getElementById('artist-tree-expanded');
      const compactNavigation = documentObject.getElementById('shell-navigation-compact');
      const foldButton = documentObject.getElementById('artist-tree-fold-button');
      const navigationButton = documentObject.getElementById('artist-tree-navigation-button');
      const list = documentObject.getElementById('sidebar-list');
      shell?.classList.toggle('is-artist-tree-folded', layout.artistTreeFolded);
      rail?.classList.toggle('is-folded', layout.artistTreeFolded);
      if (expandedTree) expandedTree.hidden = layout.artistTreeFolded;
      if (compactNavigation) compactNavigation.hidden = !layout.artistTreeFolded;
      if (foldButton) foldButton.hidden = layout.artistTreeFolded;
      if (navigationButton) {
        navigationButton.hidden = !layout.artistTreeFolded;
        navigationButton.setAttribute('aria-expanded', layout.artistTreeFolded ? 'false' : 'true');
      }
      if (list) list.hidden = layout.artistTreeFolded;

      const presentation = layout.compactPlayerPresentation;
      const compact = presentation !== 'expanded';
      const floating = presentation === 'floating';
      const railPlayer = presentation === 'rail_play' || presentation === 'rail_artbox';
      root.classList.toggle('has-compact-player', compact);
      root.classList.toggle('has-docked-compact-player', compact && !floating);
      root.classList.toggle('has-floating-compact-player', floating);
      root.classList.toggle('has-follow-sidebar-compact-player', railPlayer);
      const player = documentObject.querySelector('.global-player');
      const expandedPlayer = player?.querySelector('.player-shell');
      const compactPlayer = player?.querySelector('.compact-player-shell');
      const expandButton = compactPlayer?.querySelector("[data-ui-button-action='player-expand']");
      const collapseButton = expandedPlayer?.querySelector("[data-ui-button-action='player-collapse']");
      const cover = player?.querySelector('[data-compact-player-cover]');
      player?.classList.toggle('is-compact', compact);
      player?.classList.toggle('is-rail-compact', railPlayer);
      player?.classList.toggle('is-floating-compact', floating);
      player?.classList.toggle('is-docked-compact', compact && !floating);
      player?.classList.toggle('is-stay-docked-draggable', compact && layout.artistTreeFolded
        && layout.dockedCompactPlayerBehavior === 'stay_docked');
      if (player) player.dataset.compactPresentation = presentation;
      if (expandedPlayer) {
        expandedPlayer.hidden = false;
        expandedPlayer.inert = compact;
        expandedPlayer.setAttribute('aria-hidden', String(compact));
      }
      if (compactPlayer) {
        compactPlayer.hidden = false;
        compactPlayer.inert = !compact;
        compactPlayer.setAttribute('aria-hidden', String(!compact));
      }
      if (expandButton) expandButton.hidden = !floating;
      if (collapseButton) collapseButton.hidden = Number(globalObject.innerWidth) <= 900;
      if (cover && presentation === 'rail_play') {
        cover.inert = true;
        cover.tabIndex = -1;
      }

      const gallery = documentObject.getElementById('albums-scroll');
      const availableWidth = Math.max(1, measureStartupGalleryWidth(gallery, documentObject) - 4);
      const preferences = globalObject.AlbumHavenDevicePreferences;
      const mobileGeometry = globalObject.AlbumHavenClientLayout?.resolveMobileGalleryGeometry?.({
        availableWidth,
        viewportWidth: globalObject.innerWidth,
        mode: preferences?.read?.('galleryDisplayPreferences', {})?.defaultGalleryDisplayMode || 'cards',
        columns: preferences?.read?.('mobileGridColumns', 2),
        gap: 14,
      });
      const geometry = mobileGeometry || resolveStartupGalleryGeometry({
        availableWidth,
        scalePercent: layout.galleryScalePercent,
      });
      documentObject.querySelectorAll('#artist-groups .album-row').forEach((row) => {
        row.style.gridTemplateColumns = `repeat(${geometry.columns}, minmax(0, ${geometry.cardTrackWidth}px))`;
        row.style.justifyContent = 'start';
      });
    } finally {
      void root.offsetWidth;
      root.removeAttribute('data-client-layout-pending');
    }
  }

  const api = { resolveClientLayoutPreferences, resolveStartupGalleryGeometry, capture, finalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalObject) globalObject.AlbumHavenClientLayoutBootstrap = api;
}(typeof window !== 'undefined' ? window : globalThis));
