/** Production controls shared by the Home feedback acceptance journeys. */
export class HomeFeedbackPage {
  constructor(page) {
    this.page = page;
    this.login = page.getByRole('form', { name: 'Album Haven sign in' });
    this.username = page.getByLabel('Username', { exact: true });
    this.password = page.getByLabel('Password', { exact: true });
    this.signIn = page.getByRole('button', { name: 'Sign in', exact: true });
    this.shell = page.locator('#app-shell');
    this.home = page.getByRole('region', { name: 'Home', exact: true });
    this.sections = this.home.getByRole('tablist', { name: 'Home sections', exact: true });
    this.recentTab = this.sections.getByRole('tab', { name: 'Recent', exact: true });
    this.queueTab = this.sections.getByRole('tab', { name: 'Queue', exact: true });
    this.recent = this.home.locator('[data-home-widget="recent"]');
    this.friends = this.home.locator('[data-home-widget="friends"]');
    this.activityRows = this.home.locator('[data-home-activity-row]:visible');
    this.queue = this.home.getByRole('region', { name: 'Queued tracks', exact: true });
    this.queueRows = this.queue.locator('[data-queue-row]');
    this.queueTitles = this.queueRows.locator('.album-track-table__title');
    this.album = this.home.getByRole('region', { name: 'Selected Album Info', exact: true });
    this.artist = this.home.getByRole('region', { name: 'Selected Artist Info', exact: true });
    this.modal = page.locator('#track-modal');
    this.modalClose = this.modal.getByRole('button', { name: 'Close tracklist', exact: true });
    this.playerTitle = page.locator('#player-title');
    this.playerToggle = page.locator('[data-playback-control-action="play-pause"]:visible');
    this.playerNext = page.locator('[data-compact-player-next]');
    this.period = this.home.getByRole('button', { name: /^Period:/ });
    this.periodMenu = page.getByRole('menu', { name: 'Period', exact: true });
    this.trackMenu = page.getByRole('menu', { name: 'Selected track actions', exact: true });
    this.queueTiming = page.getByRole('menu', { name: 'Queue timing', exact: true });
    this.creation = page.getByRole('form', { name: 'Create playlist', exact: true });
    this.creationRows = this.creation.locator('[data-creation-row-key]');
    this.creationTitles = this.creationRows.locator('.album-track-table__title');
    this.creationName = this.creation.getByRole('textbox', { name: 'Playlist name', exact: true });
    this.creationSubmit = this.creation.getByRole('button', { name: 'Create playlist', exact: true });
    this.playlists = page.locator('#playlists-root');
    this.playlistRows = this.playlists.locator('[data-playlist-row-key]');
    this.playlistTitles = this.playlistRows.locator('.album-track-table__title');
    this.inspect = this.playlists.getByRole('button', { name: 'Inspect missing tracks', exact: true });
    this.exportTxt = this.playlists.getByRole('button', { name: 'Export TXT', exact: true });
    this.playlistName = this.playlists.getByRole('textbox', { name: 'Playlist title', exact: true });
    this.nowPlaying = this.friends.locator('[data-now-playing="true"]');
    this.accountMenu = page.locator('#app-shell [data-account-menu-trigger]');
    this.signOut = page.getByRole('menuitem', { name: 'Sign Out', exact: true });
  }
  activity(title, occurrence = 0) {
    return this.activityRows.filter({ has: this.page.getByText(title, { exact: true }) }).nth(occurrence);
  }
  playlistRow(title, occurrence = 0) {
    return this.playlistRows.filter({ hasText: title }).nth(occurrence);
  }
  queueRow(title, occurrence = 0) {
    return this.queueRows.filter({ has: this.page.getByText(title, { exact: true }) }).nth(occurrence);
  }
  friendButton(name) { return this.page.locator('[data-home-person-ref]:visible').filter({ hasText: name }); }
  cell(row, column) { return row.locator(`[data-cdt-column="${column}"]`); }
  selectedRows(rows) { return rows.and(this.page.locator('[aria-selected="true"]')); }
  button(scope, name) { return scope.getByRole('button', { name, exact: true }); }
  tab(scope, name) { return scope.getByRole('tab', { name, exact: true }); }
  menuChoice(menu, name) { return menu.getByRole('menuitemradio', { name, exact: true }); }
  table(scope) { return scope.locator('.compact-data-table').first(); }
  rowTitle(row) { return row.locator('.album-track-table__title'); }
  play(row) { return row.getByRole('button', { name: /^Play / }); }
  periodTrigger() { return this.period.filter({ visible: true }); }
  grouping(scope) { return scope.getByRole('group', { name: 'Track grouping', exact: true }); }
  activeGrouping(scope) { return this.grouping(scope).locator('button[aria-pressed="true"]'); }
  love(row) { return row.locator('[data-love-tier]'); }
  titleExpansion() { return this.album.locator('[data-resource-selection-open]'); }
  widgetExpansion(scope) { return scope.locator('button:has(.dashboard__size-icon)'); }
  dashboard() { return this.home.locator('[data-dashboard]'); }
  confirmDialog() { return this.page.getByRole('dialog').filter({ hasText: 'Clear the queued tracks?' }); }
  friendsButton() { return this.home.locator('[data-home-open-friends]'); }
  friendKinds() { return this.friends.getByRole('tablist', { name: 'Friend activity view' }); }
  ownKinds() { return this.recent.getByRole('tablist', { name: 'Recent listening view' }); }
  exportGlyph() { return this.exportTxt.locator('svg path'); }
  addForm() { return this.page.getByRole('form', { name: 'Add selected tracks to playlist' }); }
  activityCount() { return this.friends.locator('.home-friends__listens'); }
  friendDirectoryRow(name) { return this.page.locator('.home-friends__person-row:visible').filter({ hasText: name }); }
  text(scope, value) { return scope.getByText(value, { exact: true }); }
  sectionTabs() { return this.sections.getByRole('tab'); }
  collapsePlayer() { return this.page.getByRole('button', { name: 'Collapse player', exact: true }); }
  compactPlayer() { return this.page.locator('.compact-player-shell'); }
  playlistChoice() { return this.page.getByRole('menu', { name: 'Playlist', exact: true }); }
  creationSelectedTab() { return this.creation.getByRole('tab', { name: /^Selected \(/ }); }
  dialogText(text) { return this.page.getByRole('dialog').filter({ hasText: text }); }
  catalogControls() { return this.recent.locator('.home-friends__catalog-controls'); }
  currentQueueRow() { return this.queueRows.and(this.page.locator('.album-track-table__row--current')); }
  scroll() { return this.playlists.locator('.playlists__scroll'); }
  menuItem(menu, name) { return menu.getByRole('menuitem', { name, exact: true }); }
  async rowKeys(rows, attribute) {
    const values = await rows.all();
    return Promise.all(values.map(row => row.getAttribute(attribute)));
  }
  async geometry(locator) {
    // parity-check: allow-read-only-measurement-evaluate -- measure existing production layout without changing it
    return locator.evaluate(element => {
      const r = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right,
        viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        fontSize: style.fontSize, cursor: style.cursor, opacity: style.opacity };
    });
  }
}
