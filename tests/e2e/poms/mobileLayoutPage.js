import { expect } from '@playwright/test';

/** Selectors and user interactions for the shared responsive application shell. */
export class MobileLayoutPage {
  constructor(page) {
    this.page = page;
    this.loginForm = page.getByRole('form', { name: 'Album Haven sign in' });
    this.username = page.getByLabel('Username');
    this.password = page.getByLabel('Password', { exact: true });
    this.signInButton = page.getByRole('button', { name: 'Sign in', exact: true });
    this.appShell = page.locator('#app-shell');
    this.home = page.locator('#mobile-home');
    this.galleryContextName = page.locator('[data-gallery-bar-instance="gallery"] [data-gallery-context-name]');
    this.artistHeading = page.locator('#shell-navigation-rail h2:visible');
    this.homeCards = this.home.locator('.album-card');
    this.homeAlbums = this.home.locator('[data-open-tracklist]');
    this.homeTabs = this.home.getByRole('tablist', { name: 'Recent listening' });
    this.homePanel = this.home.locator('.mobile-home-empty:visible');
    this.recentTab = page.getByRole('tab', { name: 'Recent', exact: true });
    this.newsTab = page.getByRole('tab', { name: 'News', exact: true });
    this.searchInput = page.locator('#search-input');
    this.searchButton = page.locator('#mobile-search-button');
    this.libraryButton = page.locator('#mobile-library-button');
    this.artistRail = page.locator('#shell-navigation-rail');
    this.closeArtistRail = this.artistRail.locator('[data-close-artists-drawer]');
    this.artistPlaceholderTabs = page.locator('[data-mobile-library-mode]');
    this.galleryCards = page.locator('#artist-groups .album-card');
    this.galleryAlbums = this.galleryCards.locator('[data-open-tracklist]');
    this.galleryGrid = this.galleryCards.first().locator('..');
    this.albumIdentity = page.locator('.mobile-album-identity');
    this.albumIdentityCopy = this.albumIdentity.locator('.album-details-header__copy');
    this.albumIdentityTitle = this.albumIdentity.locator('.album-details-header__primary');
    this.albumIdentitySummary = this.albumIdentity.locator('.album-details-header__secondary');
    this.timeline = page.locator('#player-timeline');
    this.playerPlay = page.locator('#player-play');
    this.cancelAppearance = page.locator('#utility-modal-footer [data-editor-footer-action="secondary"]');
    this.thinOption = page.locator('[data-appearance-seekbar-mode="thin"]');
    this.regularOption = page.locator('[data-appearance-seekbar-mode="default"]');
    this.waveformOption = page.locator('[data-appearance-seekbar-mode="waveform"]');
    this.playerPreview = page.locator('[data-player-live-preview]');
    this.playerPreviewKnob = this.playerPreview.locator('.player-preview-seekbar > span');
    this.familyButton = page.locator('[data-gallery-bar-action="artist-family"]');
    this.familyPanel = page.locator('#artist-family-panel');
    this.viewCluster = page.locator('#gallery-view-cluster-options');
    this.activeView = this.viewCluster.locator('.is-active');
    this.zoomButton = page.getByRole('button', { name: 'Gallery zoom', exact: true });
    this.albumPage = page.locator('#mobile-page-outlet #track-modal');
    this.trackTable = page.locator('#track-modal .album-track-table');
    this.albumDialogs = page.locator('#track-modal [aria-modal="true"]');
    this.editTags = page.locator('#track-modal-edit-tags');
    this.backButton = page.locator('#mobile-back-button');
    this.backGlyph = this.backButton.locator('svg');
    this.player = page.locator('.global-player');
    this.settingsButton = page.locator('#app-shell [data-account-menu-trigger]');
    this.signOut = page.getByRole('menuitem', { name: 'Sign Out', exact: true });
    this.utilitiesButton = page.locator('#app-shell [data-open-utilities]');
    this.utilitiesPage = page.locator('#mobile-page-outlet #utility-modal');
    this.utilitiesDialogs = page.locator('#utility-modal [role="dialog"]');
    this.pageTitle = page.locator('#mobile-page-title');
    this.pageSummary = page.locator('#mobile-page-summary');
    this.profileButton = page.locator('#app-shell .account-profile-button');
    this.adminLink = page.locator('#app-shell [data-account-menu-admin]');
    this.accountNavToggle = page.locator('[data-settings-outlet] [data-settings-nav-toggle]');
    this.accountLink = page.locator('[data-settings-nav] [data-settings-section="account"]');
    this.securityHeading = page.getByRole('heading', { name: 'Password', exact: true });
    this.settingsSectionsButton = page.locator('#mobile-settings-button');
    this.settingsDrawer = page.locator('#mobile-settings-drawer');
    this.subsectionButton = page.locator('#mobile-settings-section-button');
    this.subsectionMenu = page.locator('#mobile-settings-subsection-menu');
    this.albumCover = page.locator('#track-modal-cover');
    this.albumThumbnail = page.locator('#mobile-page-cover');
    this.albumOverview = page.locator('#track-modal .mobile-album-overview');
    this.albumCoverSearch = page.locator('#track-modal [data-open-track-modal-cover-lookup]');
    this.albumQuickSearch = page.locator('#track-modal [data-track-modal-fast-cover-fetch]');
    this.playerEmptyMessage = page.locator('[data-player-empty-message]');
    this.albumRows = page.locator('#track-modal .album-track-table__row');
    this.pageOutlet = page.locator('#mobile-page-outlet');
    this.playerTime = page.locator('#player-time');
    this.playerArtist = page.locator('#player-artist');
    this.playerGlyph = page.locator('#player-play > svg');
    this.appearanceEditor = page.locator('#utility-modal .appearance-background-editor');
    this.searchControl = page.locator('#search-form .search-field-control');
    this.findBetterArt = page.locator('#cover-lookup-find-better-button');
    this.coverCandidates = page.locator('#cover-lookup-modal .cover-lookup-gallery').first().locator('.cover-lookup-art-card');
    this.coverBody = page.locator('#cover-lookup-modal-body');
    this.manualCoverSearch = page.locator('#cover-lookup-modal .cover-lookup-manual-add');
    this.coverResults = page.locator('#cover-lookup-modal .cover-lookup-results');
    this.mobileAlbumLayoutChoice = page.locator('.appearance-background-editor [data-album-details-layout]').first();
    this.familyArtists = page.locator('#artist-family-panel [data-gallery-family-artist]');
    this.fullArtwork = page.locator('#image-lightbox-image');
    this.fullArtworkNav = page.locator('.image-lightbox-navigation');
    this.allArtists = page.locator('#sidebar-list a').filter({ hasText: /All artists/i }).first();
    this.galleryScroll = page.locator('#albums-scroll');
    this.mobileNavigation = page.locator('#mobile-navigation');
    this.coverLookupPage = page.locator('#mobile-page-outlet #cover-lookup-modal');
    this.mobileAppearance = page.locator('[data-appearance-device="mobile"]');
    this.followAppearance = page.locator('[data-appearance-device-mode="follow"]');
    this.customAppearance = page.locator('[data-appearance-device-mode="custom"]');
    this.appearanceFields = page.locator('.appearance-device-fields');
    this.saveAppearance = page.locator('#utility-modal-footer [data-editor-footer-action="primary"]');
  }

  async signIn(username, password) {
    await this.page.goto('/');
    await expect(this.loginForm).toBeVisible();
    await this.username.fill(username);
    await this.password.fill(password);
    await this.signInButton.click();
    await expect(this.appShell).toBeVisible();
  }

  async browseArtist(name = 'Northlight') {
    await this.revealHeaderActions();
    await this.libraryButton.click();
    await this.artist(name).click();
    await expect(this.home).not.toBeVisible();
    await expect(this.galleryCards.first()).toBeVisible();
  }

  albumLayout(value) {
    if (!['classic_bar', 'stacked_bar', 'editorial_canvas'].includes(value)) throw new TypeError('Invalid album layout');
    return this.page.locator(`.appearance-album-layout-card[data-album-details-layout="${value}"]`);
  }

  async saveAppearanceChanges() {
    const saved = this.page.waitForResponse(response => response.url().endsWith('/account/appearance') && response.request().method() === 'PUT');
    await this.saveAppearance.click();
    expect((await saved).status()).toBe(200);
    await expect(this.saveAppearance).toBeDisabled();
  }

  async seekAt(fraction) {
    const box = await this.timeline.boundingBox();
    await this.timeline.click({ position: { x: box.width * fraction, y: box.height - 2 } });
  }

  async thinProgressGeometry() {
    // parity-check: allow-read-only-measurement-evaluate -- inspect the live range's visual track and actual audio progress.
    return this.timeline.evaluate(input => ({
      backgroundSize: getComputedStyle(input).backgroundSize,
      height: input.getBoundingClientRect().height,
      bottom: input.getBoundingClientRect().bottom,
      playerBottom: input.closest('.global-player').getBoundingClientRect().bottom,
      progress: parseFloat(input.style.getPropertyValue('--player-seek-progress')),
      value: Number(input.value), max: Number(input.max),
    }));
  }

  async expectHeaderNavigationBeforeTitle(kind) {
    const selectors = {
      gallery: ['#mobile-library-button', '[data-gallery-bar-instance="gallery"] [data-gallery-context-name]'],
      settings: ['#mobile-settings-button', '#mobile-page-title'],
      account: ['[data-settings-outlet] [data-settings-nav-toggle]', '[data-settings-outlet] .gallery-bar__title'],
    };
    if (!selectors[kind]) throw new TypeError('Unknown header kind');
    const [buttonSelector, titleSelector] = selectors[kind];
    await expect(this.page.locator(buttonSelector)).toBeVisible();
    await expect(this.page.locator(titleSelector)).toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- inspect visual and DOM order of existing controls.
    const order = await this.page.evaluate(([buttonSelector, titleSelector]) => {
      const button = document.querySelector(buttonSelector), title = document.querySelector(titleSelector);
      const a = button.getBoundingClientRect(), b = title.getBoundingClientRect();
      return { right: a.right, left: b.left, before: Boolean(button.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING) };
    }, [buttonSelector, titleSelector]);
    expect(order.before).toBe(true);
    expect(order.right).toBeLessThanOrEqual(order.left);
  }

  async expectThinPlayerComposition() {
    await expect(this.player).toHaveAttribute('data-player-seekbar-presentation', 'thin');
    await expect(this.playerArtist).toBeVisible();
    await expect(this.playerTime).toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- measure the live transport and hit-test the existing play control.
    const geometry = await this.player.evaluate(player => {
      const play = player.querySelector('#player-play'), icon = play.querySelector('svg');
      const rect = node => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; };
      const button = rect(play);
      return { player: rect(player), play: button, icon: rect(icon), time: rect(player.querySelector('#player-time')),
        artist: rect(player.querySelector('#player-artist')), song: rect(player.querySelector('#player-title')), album: rect(player.querySelector('#player-album-link')),
        lowerPlayTarget: play.contains(document.elementFromPoint(button.x + button.width / 2, button.bottom - 6)),
        iconTransform: getComputedStyle(icon).transform,
      };
    });
    expect(geometry.player.height).toBeLessThanOrEqual(80);
    expect(geometry.time.right).toBeLessThanOrEqual(geometry.play.x);
    expect(geometry.time.y).toBeGreaterThan(geometry.play.y);
    expect(geometry.time.height).toBeLessThan(20);
    expect(geometry.song.y).toBeGreaterThanOrEqual(geometry.artist.bottom);
    expect(geometry.album.y).toBeGreaterThanOrEqual(geometry.song.bottom);
    expect(geometry.time.y + geometry.time.height / 2).toBeCloseTo(geometry.album.y + geometry.album.height / 2, 0);
    expect(geometry.song.height).toBeLessThan(20);
    expect(geometry.album.height).toBeLessThan(20);
    expect(geometry.icon.x + geometry.icon.width / 2).toBeCloseTo(geometry.play.x + geometry.play.width / 2, 0);
    expect(geometry.icon.y + geometry.icon.height / 2).toBeCloseTo(geometry.play.y + geometry.play.height / 2, 0);
    expect(geometry.iconTransform).toBe('none');
    expect(geometry.lowerPlayTarget).toBe(true);
    expect(await this.hasNoHorizontalOverflow()).toBe(true);
  }

  async expectPlayerPreviewReadable() {
    await expect(this.playerPreview).toBeVisible();
    // parity-check: allow-read-only-measurement-evaluate -- compare the three metadata rows in the rendered shared preview.
    const rows = await this.playerPreview.evaluate(preview =>
      ['artist', 'title', 'album'].map(name => preview.querySelector(`[data-player-preview-${name}]`).getBoundingClientRect().toJSON()));
    expect(rows[1].y).toBeGreaterThanOrEqual(rows[0].bottom);
    expect(rows[2].y).toBeGreaterThanOrEqual(rows[1].bottom);
    for (const row of rows) expect(row.width).toBeGreaterThan(40);
  }

  async expectApprovedAlbumOverview(layout) {
    await expect(this.albumOverview).toBeVisible();
    await expect(this.backButton).toBeVisible();
    await expect(this.albumCoverSearch).toBeVisible();
    await expect(this.albumQuickSearch).toBeVisible();
    const art = await this.albumCover.boundingBox();
    const back = await this.backButton.boundingBox();
    const search = await this.albumCoverSearch.boundingBox();
    const quick = await this.albumQuickSearch.boundingBox();
    const overview = await this.albumOverview.boundingBox();
    const table = await this.trackTable.boundingBox();
    expect(art.width).toBeCloseTo(art.height, 0);
    expect(back.y).toBeCloseTo(art.y, 0);
    expect(back.x + back.width).toBeLessThanOrEqual(art.x);
    expect(quick.x + quick.width).toBeCloseTo(overview.x + overview.width, 0);
    await expect(this.albumCover.locator('.track-modal-cover-tool')).toHaveCount(0);
    await expect(this.albumIdentityTitle).toHaveCSS('outline-style', 'none');
    if (layout === 'stacked_bar') {
      expect(search.y).toBeCloseTo(quick.y, 0);
      expect(search.x + search.width).toBeLessThan(quick.x);
      expect(quick.y + quick.height).toBeCloseTo(art.y + art.height, 0);
      expect(table.y - (art.y + art.height)).toBeLessThan(40);
    } else {
      expect(search.y).toBeCloseTo(art.y, 0);
      expect(search.x).toBeCloseTo(quick.x, 0);
      expect(quick.y).toBeGreaterThanOrEqual(search.y + search.height);
      await expect(this.albumIdentity.locator('.album-details-header__eyebrow')).toHaveText('Northlight • 2026');
      await expect(this.albumIdentitySummary).not.toBeVisible();
    }
    expect(await this.hasNoHorizontalOverflow()).toBe(true);
  }

  async expectEmptyPlayerComposition() {
    await expect(this.playerEmptyMessage).toBeVisible();
    await expect(this.playerEmptyMessage).toHaveText('Nothing is playing');
    await expect(this.playerPlay).toBeDisabled();
    // parity-check: allow-read-only-measurement-evaluate -- sample both centerlines in one frame while the shared player height animates.
    const { message, play } = await this.player.evaluate(player => ({
      message: player.querySelector('[data-player-empty-message]').getBoundingClientRect().toJSON(),
      play: player.querySelector('#player-play').getBoundingClientRect().toJSON(),
    }));
    expect(message.y + message.height / 2).toBeCloseTo(play.y + play.height / 2, 0);
    expect(message.x + message.width).toBeLessThanOrEqual(play.x);
    await expect(this.playerTime).not.toBeVisible();
    await expect(this.timeline).not.toBeVisible();
    expect(await this.hasNoHorizontalOverflow()).toBe(true);
  }

  async expectGalleryAlbumInventory(titles, lastTitle) {
    // A virtual gallery mounts its viewport, not the entire library at once.
    const labels = this.galleryCards.locator('.album-title-button');
    await expect(labels.first()).toBeVisible();
    const seen = new Set(await labels.allTextContents());
    await this.scrollRegion('gallery', 1400);
    await expect(this.galleryCards.getByRole('button', { name: lastTitle, exact: true })).toBeVisible();
    for (const title of await labels.allTextContents()) seen.add(title);
    expect([...seen].map(title => title.trim()).sort()).toEqual([...titles].sort());
  }

  async expectPlayerPreviewPinned(preview, maximumTop) {
    // wheel() dispatches input but does not wait for the browser's scroll frame.
    // Keep the original geometry bounds; wait through the normal assertion policy.
    await expect(preview).toBeVisible();
    await expect.poll(async () => (await preview.boundingBox())?.y ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(maximumTop);
    const bounds = await preview.boundingBox(), header = await this.pageTitle.boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(header.y);
    expect(bounds.y).toBeLessThan(maximumTop);
  }

  async selectView(view) {
    if (!['cards', 'covers', 'list'].includes(view)) throw new TypeError('Unknown gallery view');
    await this.activeView.click();
    await this.viewCluster.locator(`[data-gallery-view-choice="${view}"]`).click();
    await expect(this.viewCluster).not.toHaveClass(/is-open/);
  }

  artist(name) {
    return this.page.locator('#sidebar-list [data-sidebar-artist]').filter({ hasText: name }).first();
  }

  utilityTab(name) {
    if (!['appearance', 'integrations', 'problematic-files', 'rules'].includes(name)) {
      throw new TypeError('Unknown utility tab');
    }
    return this.page.locator(`#utility-modal [data-utility-tab="${name}"]`);
  }

  async openSettings() {
    await this.revealHeaderActions();
    await this.settingsButton.click();
    await this.utilitiesButton.click();
    await expect(this.utilitiesPage).toBeVisible();
  }

  async diagnosticState() {
    // parity-check: allow-read-only-measurement-evaluate -- capture existing view and computed geometry without mutating production state.
    return this.page.evaluate(() => {
      const selectors = ['#artist-family-panel', '.player-shell', '.player-play-cluster', '#player-play', '#player-time', '#shell-navigation-rail'];
      const nodes = Object.fromEntries(selectors.map(selector => {
        const el = document.querySelector(selector);
        if (!el) return [selector, null];
        const style = getComputedStyle(el), box = el.getBoundingClientRect();
        return [selector, { hidden: el.hidden, classes: el.className, x: box.x, y: box.y, width: box.width, height: box.height,
          display: style.display, opacity: style.opacity, visibility: style.visibility, gridColumns: style.gridTemplateColumns, position: style.position }];
      }));
      return { nodes, url: location.href, selectedArtist: state.view.selected_artist, query: state.view.query,
        activeSurface: galleryMainSurfaceController?.current()?.key, pendingView: state.ui.pendingViewTransition,
        pendingRequest: state.ui.activeViewRequestUrl, searchTimer: Boolean(state.ui.pendingSelectedArtistReconcileTimer) };
    });
  }

  async galleryTitleFits() {
    // parity-check: allow-read-only-measurement-evaluate -- measure the visible title beside its real gallery controls.
    return this.galleryContextName.evaluate(title => title.scrollWidth <= title.clientWidth);
  }

  async librarySectionLabelsFit() {
    // parity-check: allow-read-only-measurement-evaluate -- measure the requested single drawer heading.
    return this.artistHeading.evaluate(heading => heading.scrollWidth <= heading.clientWidth);
  }

  async nativePinch(scale) {
    const box = await this.galleryScroll.boundingBox();
    const center = { x: box.x + box.width / 2, y: box.y + Math.min(150, box.height / 2) };
    const cdp = await this.page.context().newCDPSession(this.page);
    const points = span => [0, 1].map(index => ({ x: center.x + (index ? 1 : -1) * span / 2, y: center.y, id: index }));
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(110) });
      for (let step = 1; step <= 12; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(110 * (1 + (scale - 1) * step / 12)) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
  }

  async expectGridColumns(count) {
    // parity-check: allow-read-only-measurement-evaluate -- count computed grid tracks after a real gesture.
    await expect.poll(async () => (await this.galleryGrid.evaluate(grid => getComputedStyle(grid).gridTemplateColumns)).split(' ').length).toBe(count);
    // parity-check: allow-read-only-measurement-evaluate -- pinch changes application density, not browser magnification.
    expect(await this.page.evaluate(() => window.visualViewport.scale)).toBe(1);
  }

  async selectColumns(columns) {
    if (![1, 2, 3].includes(columns)) throw new TypeError('Invalid column count');
    await this.nativePinch(.45);
    await this.expectGridColumns(3);
    if (columns < 3) await this.nativePinch(columns === 2 ? 1.4 : 1.8);
    await this.expectGridColumns(columns);
  }

  async revealHeaderActions() {
    if (await this.searchInput.isVisible()) {
      await this.searchInput.fill('');
      await this.searchInput.press('Escape');
    }
  }

  async selectUtility(section) {
    if (!['rules', 'loops', 'log-history', 'appearance', 'integrations'].includes(section)) throw new TypeError('Invalid section');
    await this.settingsSectionsButton.click();
    await this.settingsDrawer.locator(`[data-mobile-settings-choice="${section}"]`).click();
    await expect(this.settingsDrawer).not.toBeVisible();
  }

  async selectSubsection(key) {
    if (!['library', 'lastfm', 'backgrounds', 'seekbar', 'selection-accent', 'alerts', 'album-page'].includes(key)) throw new TypeError('Invalid subsection');
    await this.subsectionButton.click();
    await this.subsectionMenu.locator(`[data-mobile-subsection="${key}"]`).click();
    await expect(this.subsectionMenu).not.toBeVisible();
  }

  async openPassword() {
    await this.settingsButton.click();
    await this.adminLink.click();
    await this.accountNavToggle.click();
    await this.accountLink.click();
    await expect(this.securityHeading).toBeVisible();
  }

  async search(query) {
    if (!(await this.searchInput.isVisible())) await this.searchButton.click();
    await this.searchInput.fill(query);
    await this.searchInput.press('Enter');
    await expect(this.galleryCards.first()).toBeVisible();
  }

  async openAlbumBody(title) {
    const card = this.galleryCards.filter({ has: this.page.getByRole('button', { name: title, exact: true }) });
    await card.locator('.album-meta-row').click();
    await expect(this.trackTable).toBeVisible();
  }

  async playRow(index) { await this.albumRows.nth(index).locator('.album-track-table__title').click(); }

  async scrollRegion(region, delta) {
    const target = region === 'album' ? this.pageOutlet : region === 'cover' ? this.coverBody : this.galleryScroll;
    await target.hover();
    await this.page.mouse.wheel(0, delta);
  }

  async hasNoHorizontalOverflow() {
    // parity-check: allow-read-only-measurement-evaluate -- measure rendered document width without changing application state.
    return this.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  }
}

