import { expect } from '@playwright/test';

/** Real sign-in/routes/native controls; all setup is pre-start persisted data. */
export class NativeAcceptanceActions {
  constructor(view, { data, signIn, capture }) {
    Object.assign(this, { view, data, signIn, capture });
    this.page = view.page;
  }
  async unique(locator) { await expect(locator).toHaveCount(1); await expect(locator).toBeVisible(); return locator; }
  async home() { await this.page.goto('/?surface=home'); await expect(this.view.home).toBeVisible(); }
  async history(friend = false) {
    const v = this.view, scope = friend ? v.friends : v.recent;
    if (!friend) await v.recentTab.click();
    await v.tab(friend ? v.friendKinds() : v.ownKinds(), 'Tracks').click();
    await v.activeGrouping(scope).click();
    await v.button(v.grouping(scope), 'Listening history').click();
    await expect(v.activityRows).toHaveCount(3);
  }
  async openRecentAlbum() {
    const v = this.view, row = await this.unique(v.exactActivity(this.data.catalog.tracks.one.title));
    await v.rowTitle(row).click();
    await expect(v.album).toContainText(this.data.catalog.albums.first.title);
    await (await this.unique(v.album.locator('[data-resource-selection-open]'))).click();
    await expect(v.modal).toBeVisible();
  }
  async ownTaste(rating, favorite, saved = false) {
    const v = this.view;
    await expect(v.rating).toHaveValue(String(rating));
    await expect(v.rating).toBeEnabled();
    await expect(v.favorite).toHaveAttribute('aria-pressed', String(favorite));
    await expect(v.favorite).toHaveText(`Favorite: ${favorite ? 'Yes' : 'No'}`);
    await expect(v.favorite).toBeEnabled();
    await expect(v.preferenceStatus).toHaveText(saved ? 'Saved.' : '');
  }
  async preferences() {
    const v = this.view;
    await this.signIn(); await this.history(); await this.openRecentAlbum(); await this.ownTaste(3, false);
    await v.modal.getByRole('button', { name: 'Add album to favorites', exact: true }).click();
    await expect(v.favorite).toBeEnabled();
    await v.rating.selectOption('6'); await this.ownTaste(6, true, true);
    await v.modalClose.click(); await this.openRecentAlbum(); await this.ownTaste(6, true);
    await this.page.reload(); await this.home(); await this.history(); await this.openRecentAlbum(); await this.ownTaste(6, true);
    await v.modalClose.click(); await v.friendsButton().click();
    await (await this.unique(v.exactFriend(this.data.friend.accountRef))).click();
    await v.button(v.friends, 'Listening activity').click(); await this.history(true); await this.openRecentAlbum();
    await expect(v.modal.getByRole('img', { name: 'Subject album rating 8/10', exact: true })).toBeVisible();
    await expect(v.modal).toContainText('Favorite: Yes');
    await expect(v.modal.locator('[data-album-preference-action]:enabled')).toHaveCount(0);
    await this.capture('friend-taste');
    await v.modalClose.click(); await this.home(); await this.history(); await this.openRecentAlbum();
    await this.ownTaste(6, true); await this.capture('own-preferences');
  }
  async emptyGoals() {
    const v = this.view;
    await v.goalsTab.click(); await expect(v.goalsTab).toHaveAttribute('aria-selected', 'true');
    await expect(v.home.getByText('The goals were not set', { exact: true })).toBeVisible();
    await expect(v.goalAlbums.locator('.album-card')).toHaveCount(0);
  }
  async goals() {
    const v = this.view;
    await this.signIn(); await this.emptyGoals();
    await v.home.getByRole('button', { name: 'Period: 1 week', exact: true }).click();
    await this.page.getByRole('menu', { name: 'Period', exact: true }).getByRole('menuitemradio', { name: '1 month', exact: true }).click();
    await expect(v.home.getByRole('button', { name: 'Period: 1 month', exact: true })).toBeVisible();
    await expect(v.goalAlbums.locator('.album-card')).toHaveCount(0);
    await v.goalStart.click(); await expect(v.goalAdmission).toBeVisible();
    const title = v.goalForm.getByRole('textbox', { name: 'Album title', exact: true });
    await expect(title).toHaveValue('');
    await expect(v.goalAdmission.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
    await expect(v.goalAdmission.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
    await title.fill(this.data.catalog.albums.first.title);
    await v.goalAdmission.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(v.goalAdmission).toBeHidden(); await expect(v.goalStart).toBeFocused();
    await expect(v.goalsTab).toHaveAttribute('aria-selected', 'true');
    await this.page.reload(); await this.emptyGoals(); await this.capture('empty-goals');
  }
  async topDirectory() {
    const v = this.view;
    await this.page.goto('/?surface=album_tops'); await expect(v.tops).toBeVisible();
    await expect(v.topHeader).toContainText('Album Tops');
    await (await this.unique(v.topOpener(this.data.top))).click();
    await this.topOrder();
  }
  async topOrder() {
    const v = this.view, { first, second } = this.data.catalog.albums;
    await expect(v.topHeader).toContainText(this.data.top.title);
    await expect(v.tops.locator('.album-card .album-title')).toHaveText([first.title, second.title]);
    const completions = v.tops.locator('[data-gallery-card-intent="complete"]');
    await expect(completions).toHaveCount(2);
    await expect(completions.nth(0)).toHaveAttribute('data-gallery-card-ref', first.ref);
    await expect(completions.nth(1)).toHaveAttribute('data-gallery-card-ref', second.ref);
  }
  async progress(completed) {
    await expect(this.view.topProgress).toBeVisible();
    await expect(this.view.topProgress).toHaveAttribute('aria-valuenow', String(completed));
    await expect(this.view.topProgress).toHaveAttribute('aria-valuemax', '2');
    await expect(this.view.topProgress).toHaveAttribute('aria-valuetext', `${completed} of 2 albums completed`);
  }
  async top() {
    const v = this.view, { first, second } = this.data.catalog.albums;
    await this.signIn(); await this.topDirectory(); await this.progress(0);
    await v.topCompletion(first, false).click(); await this.progress(1);
    await this.page.reload(); await this.topOrder(); await this.progress(1);
    await expect(v.topCompletion(first, true)).toBeVisible(); await expect(v.topCompletion(second, false)).toBeVisible();
    await v.topCompletion(first, true).click(); await this.progress(0);
    await this.page.reload(); await this.topOrder(); await this.progress(0);
    await v.tops.getByRole('button', { name: 'Edit Album Top', exact: true }).click();
    await expect(v.topEditor).toBeVisible(); await v.topEditor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(v.topEditor).toBeHidden(); await this.topOrder();
    await v.topHeader.getByRole('button', { name: 'Back', exact: true }).click();
    await (await this.unique(v.topOpener(this.data.top))).click(); await this.topOrder(); await this.progress(0);
    await this.capture('top-order-progress');
  }
  async matches(keys) {
    for (const key of ['one', 'two', 'quiet']) {
      const row = await this.unique(this.view.trackRow(this.data.catalog.tracks[key].title));
      if (keys.includes(key)) {
        await expect(row).toHaveAttribute('data-track-search-match', 'true');
        await expect(row).toHaveClass(/\balbum-track-table__row--search-match\b/);
      } else {
        await expect(row).not.toHaveAttribute('data-track-search-match', /.*/);
        await expect(row).not.toHaveClass(/\balbum-track-table__row--search-match\b/);
      }
    }
  }
  async openSearchAlbum() {
    const album = this.data.catalog.albums.first;
    await (await this.unique(this.view.albumOpener(album))).click();
    await expect(this.view.modal).toBeVisible();
  }
  async search() {
    const v = this.view, album = this.data.catalog.albums.first;
    await this.signIn();
    const query = `:popular artist:"${album.artist}" per_artist:2`;
    await this.page.goto(`/?surface=albums&q=${encodeURIComponent(query)}&search_presentation=albums`);
    await expect(v.search).toHaveValue(query);
    await expect(this.page.locator('.album-card:visible')).toHaveCount(1);
    await this.openSearchAlbum(); await this.matches(['one', 'two']); await this.capture('two-matches'); await v.modalClose.click();
    const commits = { draft: 0, apply: 0, reset: 0 };
    let phase = 'draft', nextQuery;
    const origin = new URL(this.page.url()).origin;
    const observe = request => {
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === '/view-data') commits[phase]++;
    };
    this.page.on('request', observe);
    try {
      await v.advancedToggle.click(); await expect(v.advanced).toBeVisible(); await expect(v.capEnabled).toBeChecked();
      await v.cap.fill('1'); await expect(v.preview).toContainText('per_artist:1');
      nextQuery = await v.preview.innerText();
      await expect(v.search).toHaveValue(query); await expect(this.page.locator('.album-card:visible')).toHaveCount(1);
      await v.advanced.locator('[data-search-help-close]').click();
      await this.openSearchAlbum(); await this.matches(['one', 'two']); await v.modalClose.click();
      await v.advancedToggle.click(); await expect(v.cap).toHaveValue('1');
      expect(commits.draft).toBe(0);
      phase = 'apply';
      await v.advanced.locator('[data-advanced-apply]').click();
      await expect(v.advanced).toBeHidden(); await expect(v.search).toHaveValue(nextQuery);
      await this.openSearchAlbum(); await this.matches(['one']); await this.capture('one-match');
      expect(commits.apply).toBe(1);
      await v.modalClose.click(); phase = 'reset'; await v.advancedToggle.click();
      await v.advanced.locator('[data-advanced-reset]').click();
      await expect(v.search).toHaveValue(nextQuery);
      await v.advanced.locator('[data-search-help-close]').click(); await expect(v.search).toHaveValue(nextQuery);
      await this.openSearchAlbum(); await this.matches(['one']); await v.modalClose.click();
      expect(commits.reset).toBe(0);
      expect(commits.apply).toBe(1);
    } finally { this.page.off('request', observe); }
    await this.home(); await this.page.goBack(); await expect(v.search).toHaveValue(nextQuery);
    await this.openSearchAlbum(); await this.matches(['one']);
  }
  async artistParent({ foreground = true } = {}) {
    const v = this.view, album = this.data.catalog.albums.first;
    await expect(v.artistName).toHaveText(album.artist);
    await expect(v.artistRoot).toHaveClass(/\bis-artist-page-active\b/);
    await expect(v.discography.getByRole('heading', { name: 'Discography', exact: true, includeHidden: !foreground })).toHaveCount(1);
    await expect(v.discography.getByRole('button', { name: 'Discography', exact: true, includeHidden: !foreground })).toHaveAttribute('aria-expanded', 'true');
    if (foreground) {
      await expect(v.artistRoot).toBeVisible(); expect(await v.foreground(v.artistRoot)).toBe(true);
      await expect(v.discography.locator('[data-disclosure-panel]')).toBeVisible();
    }
  }
  async noOverflow(locator) {
    const box = await this.view.layout(locator);
    expect(box.width).toBeGreaterThan(0); expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(box.viewport); expect(box.scrollWidth).toBeLessThanOrEqual(box.viewport);
  }
  async mobile() {
    const v = this.view, album = this.data.catalog.albums.first;
    await this.signIn(); await this.emptyGoals(); await this.topDirectory();
    await this.page.goto(`/?surface=albums&q=${encodeURIComponent(album.title)}`);
    await expect(v.search).toHaveValue(album.title);
    const bookmark = `/?surface=albums&artist=${encodeURIComponent(album.artist)}&page_mode=info`;
    await this.page.goto(bookmark); await this.artistParent();
    const parentUrl = this.page.url(), params = new URL(parentUrl).searchParams;
    expect(params.get('artist')).toBe(album.artist); expect(params.get('page_mode')).toBe('info');
    const opener = await this.unique(v.albumOpener(album, v.discography.locator('[data-disclosure-panel]')));
    await opener.click(); await expect(v.modal).toHaveClass(/\bis-artist-discography-sheet\b/);
    await expect(v.sheetHandle).toBeVisible(); await expect(v.sheetToggle).toBeVisible(); await this.artistParent({ foreground: false });
    await expect(v.sheetToggle).toHaveAttribute('aria-expanded', 'false');
    await v.sheetToggle.click(); await expect(v.sheetToggle).toHaveAttribute('aria-expanded', 'true');
    await v.sheetToggle.click(); await expect(v.sheetToggle).toHaveAttribute('aria-expanded', 'false');
    await this.noOverflow(v.modal.getByRole('dialog')); await this.capture('artist-sheet');
    await this.page.goBack(); await expect(v.modal).toBeHidden(); await this.artistParent();
    await expect(opener).toBeFocused(); expect(this.page.url()).toBe(parentUrl);
    await this.capture('returned-parent');
    await this.page.goForward(); await expect(v.sheetHandle).toBeVisible(); await this.artistParent({ foreground: false });
    await v.modal.locator('#track-modal-cover [data-open-lightbox="1"]').click();
    await expect(v.lightboxImage).toBeVisible();
    await expect(v.lightboxImage).toHaveAttribute('alt', `Album cover for ${album.title}`);
    await expect.poll(() => v.imageReady(v.lightboxImage)).toBe(true);
    await expect(this.page.locator('#image-lightbox-close')).toBeVisible(); await this.page.locator('#image-lightbox-close').click();
    await expect(v.lightbox).toBeHidden();
    await expect(v.sheetHandle).toBeVisible(); await this.artistParent({ foreground: false });
    await this.page.goBack(); await this.artistParent(); expect(this.page.url()).toBe(parentUrl);
    await this.page.setViewportSize({ width: 320, height: 844 }); await this.artistParent(); await this.noOverflow(v.artistRoot);
    await opener.click(); await expect(v.sheetHandle).toBeVisible(); await this.noOverflow(v.modal.getByRole('dialog'));
    await this.page.goBack(); await this.artistParent(); await this.home();
    await expect(v.modal).toBeHidden(); await expect(v.sheetHandle).toBeHidden();
    await expect(v.modal).not.toHaveClass(/\bis-artist-discography-sheet\b/);
    expect(await v.foreground(v.home)).toBe(true);
    await expect(v.goalsTab).toBeEnabled(); await this.emptyGoals(); await expect(v.goalStart).toBeEnabled();
    await this.capture('mobile-home');
  }
}
