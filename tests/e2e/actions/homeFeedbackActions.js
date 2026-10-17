import { expect } from '@playwright/test';

/** Only native browser interactions drive these journeys. Observers are read-only. */
export class HomeFeedbackActions {
  constructor(view, { data, catalog, credentials, pcm, requests, step }) {
    Object.assign(this, { view, data, catalog, credentials, pcm, requests, step });
    this.page = view.page;
  }
  title(key) { return this.catalog.tracks[key].title; }
  async signIn() {
    await this.page.goto('/?surface=home');
    await expect(this.view.login).toBeVisible();
    await this.view.username.fill(this.credentials.username);
    await this.view.password.fill(this.credentials.password);
    await this.view.signIn.click();
    await expect(this.view.shell).toBeVisible();
    await this.page.goto('/?surface=home');
    await expect(this.view.home).toBeVisible();
    await expect(this.view.sections).toBeVisible();
  }
  async history({ friend = false } = {}) {
    const v = this.view, scope = friend ? v.friends : v.recent;
    if (!friend) await v.recentTab.click();
    await v.tab(friend ? v.friendKinds() : v.ownKinds(), 'Tracks').click();
    await v.activeGrouping(scope).click();
    await v.button(v.grouping(scope), 'Listening history').click();
    await expect(v.activityRows).toHaveCount(7);
  }
  async friendHome() {
    const v = this.view;
    await v.friendsButton().click();
    await v.friendButton(this.data.friend.displayName).click();
    await v.button(v.friends, 'Listening activity').click();
    await this.history({ friend: true });
  }
  async ownHome() {
    await this.view.friendsButton().click();
    await expect(this.view.sections).toBeVisible();
  }
  async playlist(kind) {
    const selected = this.data.playlists[kind];
    if (!selected?.id) throw new Error(`Missing pre-start Playlist: ${kind}`);
    await this.page.goto(`/?surface=playlists&playlist_id=${encodeURIComponent(selected.id)}`);
    await expect(this.view.playlists).toBeVisible();
    await expect(this.view.playlistName).toHaveValue(selected.title);
    await expect(this.view.playlistRows).toHaveCount(selected.trackKeys.length);
  }
  async selectHistory(indices) {
    for (const [offset, index] of indices.entries()) {
      await this.view.rowTitle(this.view.activityRows.nth(index)).click({ modifiers: offset ? ['ControlOrMeta'] : [] });
    }
    await expect(this.view.selectedRows(this.view.activityRows)).toHaveCount(indices.length);
  }
  async enqueueHistory(indices, timing = 'At end of queue') {
    await this.selectHistory(indices);
    await this.view.rowTitle(this.view.activityRows.nth(indices[0])).click({ button: 'right' });
    await expect(this.view.trackMenu).toBeVisible();
    await this.view.menuItem(this.view.trackMenu, timing).click();
    await expect(this.view.trackMenu).toBeHidden();
  }
  async openQueue() { await this.view.queueTab.click(); await expect(this.view.queue).toBeVisible(); }
  async audible(key, action) {
    const after = await this.pcm.playbackMark();
    await action();
    await expect(this.view.playerTitle).toContainText(this.title(key));
    const evidence = await this.pcm.waitForTrackPlaybackEvidence({ after, path: this.catalog.tracks[key].path });
    expect(evidence.nonZeroSamples).toBeGreaterThan(0);
    expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
  }
  async nextTrack() {
    if (!this.compact) { await this.view.collapsePlayer().click(); this.compact = true; }
    await this.view.compactPlayer().hover();
    await this.view.playerNext.click();
  }
  async paused() {
    await expect(this.view.playerToggle).toHaveAttribute('aria-label', /Pause/);
    await this.view.playerToggle.click();
    await expect(this.view.playerToggle).toHaveAttribute('aria-label', /Play/);
  }
  async inspectHistory(key) {
    const row = this.view.activity(this.title(key));
    await this.view.rowTitle(row).click();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await expect(this.view.album).toContainText(this.catalog.tracks[key].albumTitle);
  }
  async assertQuiet(mark) {
    expect(this.pcm.snapshotSince(mark).filter(event => ['open', 'promote'].includes(event.type))).toEqual([]);
  }
  async ownQueueOnly() {
    const v = this.view;
    await this.signIn();
    await this.step('Own Home nests an empty compact Queue beside Recent and News', async () => {
      await expect(v.sectionTabs()).toHaveText(['Recent', 'News', 'Queue']);
      await this.openQueue();
      await expect(v.table(v.queue)).toHaveAttribute('data-cdt-density', 'compact');
      await expect(v.catalogControls()).toBeHidden();
      await expect(v.queueRows).toHaveCount(0);
      await expect(v.text(v.queue, 'No tracks have been queued.')).toBeVisible();
    });
    await this.step('Friend activity and signed-out visitors never expose Queue', async () => {
      await this.friendHome();
      await expect(v.queueTab).toHaveCount(0);
      await expect(v.queue).toHaveCount(0);
      await v.accountMenu.click(); await v.signOut.click();
      await expect(v.login).toBeVisible();
      await this.page.goto('/?surface=home');
      await expect(v.login).toBeVisible();
      await expect(v.home).toHaveCount(0);
      await expect(v.queueTab).toHaveCount(0);
    });
  }
  async explicitOccurrenceOrder() {
    const v = this.view;
    await this.signIn(); await this.history();
    await this.step('Ordinary playback does not populate explicit Queue', async () => {
      await this.audible('opening', () => v.play(v.activity(this.title('opening'))).click());
      await this.openQueue(); await expect(v.queueRows).toHaveCount(0);
    });
    await this.step('Explicit repeated requests retain source order and different occurrence IDs', async () => {
      await this.history();
      await this.enqueueHistory([2, 0, 1], 'Play next');
      await this.openQueue();
      await expect(v.queueTitles).toHaveText([this.title('opening'), this.title('second'), this.title('opening')]);
      const ids = await v.rowKeys(v.queueRows, 'data-queue-row');
      expect(new Set(ids).size).toBe(3);
      await this.audible('opening', () => this.nextTrack());
      await expect(v.currentQueueRow()).toHaveAttribute('data-queue-row', ids[0]);
      await this.audible('second', () => this.nextTrack());
      await expect(v.currentQueueRow()).toHaveAttribute('data-queue-row', ids[1]);
      await this.audible('opening', () => this.nextTrack());
      await expect(v.currentQueueRow()).toHaveAttribute('data-queue-row', ids[2]);
    });
    await this.step('Queued timing remains a native guarded choice', async () => {
      await this.history(); await this.enqueueHistory([4]); await this.openQueue();
      const arrival = v.queueRow(this.title('arrival'));
      await v.button(arrival, 'At end of queue').click();
      await expect(v.menuChoice(v.queueTiming, 'Play next')).toBeEnabled();
      await expect(v.menuChoice(v.queueTiming, 'After current album')).toBeDisabled();
      await expect(v.menuChoice(v.queueTiming, 'After current playlist')).toBeDisabled();
      await v.menuChoice(v.queueTiming, 'Play next').click();
      await expect(v.button(arrival, 'Play next')).toBeVisible();
    });
  }
  async queueMutationGuards() {
    const v = this.view;
    await this.signIn(); await this.history(); await this.enqueueHistory([0, 1, 4]); await this.openQueue();
    const mark = this.pcm.mark(), original = await v.rowKeys(v.queueRows, 'data-queue-row');
    await this.step('Deactivate and reactivate retain rows without starting audio', async () => {
      await v.button(v.queue, 'Deactivate queue').click();
      await expect(v.text(v.queue, 'Queue is inactive. Your queued tracks are kept.')).toBeVisible();
      expect(await v.rowKeys(v.queueRows, 'data-queue-row')).toEqual(original);
      await v.button(v.queue, 'Activate queue').click();
      expect(await v.rowKeys(v.queueRows, 'data-queue-row')).toEqual(original);
      await this.assertQuiet(mark);
    });
    await this.step('Keyboard and drag reorder pending occurrences without losing identities', async () => {
      await v.button(v.queueRows.nth(1), 'Move up').focus();
      await v.button(v.queueRows.nth(1), 'Move up').press('Enter');
      await expect(v.queueTitles).toHaveText([this.title('second'), this.title('opening'), this.title('arrival')]);
      await v.queueRows.nth(2).dragTo(v.queueRows.nth(0));
      await expect(v.queueTitles).toHaveText([this.title('arrival'), this.title('second'), this.title('opening')]);
      expect(new Set(await v.rowKeys(v.queueRows, 'data-queue-row'))).toEqual(new Set(original));
    });
    await this.step('Confirmed Clear preserves the current occurrence and guards its actions', async () => {
      await this.audible('arrival', () => v.play(v.queueRows.nth(0)).click());
      const currentId = await v.currentQueueRow().getAttribute('data-queue-row');
      await expect(v.button(v.currentQueueRow(), 'Move up')).toBeDisabled();
      await expect(v.button(v.currentQueueRow(), 'Move down')).toBeDisabled();
      await expect(v.button(v.currentQueueRow(), 'Remove queued track')).toBeDisabled();
      await v.button(v.queue, 'Clear queue').click();
      await expect(v.confirmDialog()).toBeVisible();
      await expect(v.queueRows).toHaveCount(3);
      await v.button(v.confirmDialog(), 'Cancel').click();
      await expect(v.queueRows).toHaveCount(3);
      await v.button(v.queue, 'Clear queue').click();
      await v.button(v.confirmDialog(), 'Continue').click();
      await expect(v.queueRows).toHaveCount(1);
      await expect(v.currentQueueRow()).toHaveAttribute('data-queue-row', currentId);
      await expect(v.playerTitle).toContainText(this.title('arrival'));
    });
  }
  async nativeInspectionRetention() {
    const v = this.view;
    await this.signIn(); await this.history(); const mark = this.pcm.mark();
    await this.step('Plain inspection and native modal return restore both resource widgets quietly', async () => {
      await this.inspectHistory('opening');
      await expect(v.artist).toContainText(this.catalog.tracks.opening.artist);
      await v.titleExpansion().click();
      await expect(v.modal).toBeVisible();
      await v.modalClose.click();
      await expect(v.modal).toBeHidden();
      await expect(v.album).toContainText(this.catalog.tracks.opening.albumTitle);
      await this.inspectHistory('second');
      await expect(v.artist).toContainText(this.catalog.tracks.second.artist);
      await this.assertQuiet(mark);
    });
    await this.step('Queue selection uses the same widgets across reorder and deactivation', async () => {
      await this.enqueueHistory([0, 1]); await this.openQueue();
      await v.rowTitle(v.queueRows.nth(0)).click();
      const selectedId = await v.queueRows.nth(0).getAttribute('data-queue-row');
      await expect(v.album).toContainText(this.catalog.tracks.opening.albumTitle);
      await v.button(v.queueRows.nth(0), 'Move down').click();
      await expect(v.selectedRows(v.queueRows)).toHaveCount(1);
      await expect(v.selectedRows(v.queueRows)).toHaveAttribute('data-queue-row', selectedId);
      await v.button(v.queue, 'Deactivate queue').click();
      await expect(v.album).toContainText(this.catalog.tracks.opening.albumTitle);
      await expect(v.selectedRows(v.queueRows)).toHaveAttribute('data-queue-row', selectedId);
      await this.assertQuiet(mark);
    });
  }
  async consensusAndSubjectTaste() {
    const v = this.view;
    await this.signIn(); await this.history();
    await this.step('Modifier selection preserves missing occurrences and independent canonical consensus', async () => {
      await this.selectHistory([0, 1]);
      await expect(v.album).toContainText(this.catalog.tracks.opening.albumTitle);
      await expect(v.artist).toContainText(this.catalog.tracks.opening.artist);
      await v.rowTitle(v.activityRows.nth(0)).click();
      await v.rowTitle(v.activityRows.nth(3)).click({ modifiers: ['Shift'] });
      await expect(v.selectedRows(v.activityRows)).toHaveCount(4);
      await expect(v.activity(this.title('missing'))).toHaveAttribute('aria-selected', 'true');
      await this.selectHistory([0, 4]);
      await expect(v.text(v.album, 'Selected tracks do not share one available album.')).toBeVisible();
      await expect(v.artist).toContainText(this.catalog.tracks.opening.artist);
      await this.selectHistory([0, 5]);
      await expect(v.text(v.album, 'Selected tracks do not share one available album.')).toBeVisible();
      await expect(v.text(v.artist, 'Selected tracks do not share one available artist.')).toBeVisible();
    });
    await this.step('Friend taste is read-only and unknown facts stay neutral', async () => {
      await this.friendHome();
      const opening = v.activity(this.title('opening'));
      await expect(v.cell(opening, 'rating')).toHaveText(String(this.data.taste.friend.rating));
      await expect(v.love(opening)).toHaveAttribute('data-love-tier', this.data.taste.friend.loveTier);
      await expect(v.love(opening)).toHaveAttribute('role', 'img');
      const unknown = v.activity(this.data.friendRecent.unknownTitle);
      await expect(v.cell(unknown, 'rating')).toHaveText('–');
      await expect(v.love(unknown)).toHaveAttribute('data-love-tier', 'unknown');
      await this.enqueueHistory([0]);
      await this.ownHome(); await this.history();
      await expect(v.cell(v.activity(this.title('opening')), 'rating')).toHaveText(String(this.data.taste.actor.rating));
      await expect(v.love(v.activity(this.title('opening')))).toHaveAttribute('data-love-tier', this.data.taste.actor.loveTier);
      await this.enqueueHistory([0]); await this.openQueue();
      await v.rowTitle(v.queueRows.nth(0)).click();
      await v.rowTitle(v.queueRows.nth(1)).click({ modifiers: ['ControlOrMeta'] });
      await expect(v.album).toContainText(this.catalog.tracks.opening.albumTitle);
      await expect(v.artist).toContainText(this.catalog.tracks.opening.artist);
    });
  }
  async unavailableRows() {
    const v = this.view;
    await this.signIn(); await this.history(); const mark = this.pcm.mark();
    await this.step('Missing activity rows remain selectable with no visible Play action', async () => {
      const missing = v.activity(this.title('missing'));
      await missing.hover();
      await expect(v.play(missing)).toBeHidden();
      await v.rowTitle(missing).click();
      await expect(missing).toHaveAttribute('aria-selected', 'true');
      await this.assertQuiet(mark);
    });
    await this.step('Saved Playlist missing controls stay hidden while available rows retain native playback', async () => {
      await this.playlist('missing');
      const missing = v.playlistRow(this.title('missing'));
      await missing.hover(); await expect(v.play(missing)).toBeHidden();
      await v.rowTitle(missing).click(); await expect(missing).toHaveAttribute('aria-selected', 'true');
      await this.playlist('available');
      const opening = v.playlistRow(this.title('opening'));
      await opening.hover(); await expect(v.play(opening)).toBeEnabled();
      await this.audible('opening', () => v.play(opening).click());
    });
  }
  playlistCreates() { return this.requests.filter(item => item.method === 'POST' && /\/playlists$/.test(item.pathname)).length; }
  async inspectMissingEntry() {
    const v = this.view;
    await this.signIn();
    for (const width of [1440, 390]) {
      await this.step(`Playlist Inspect admission and captured missing source at ${width}px`, async () => {
        await this.page.setViewportSize({ width, height: 960 });
        await this.playlist('available');
        await expect(v.inspect).toBeDisabled();
        await this.playlist('missing');
        await expect(v.inspect).toBeEnabled();
        const before = this.playlistCreates();
        await v.inspect.click();
        await expect(v.creation).toBeVisible();
        await expect(v.creationTitles).toHaveText([this.title('missing')]);
        await expect(v.creation).toContainText('Confirmed missing');
        expect(this.playlistCreates()).toBe(before);
        await v.button(v.creation, 'Cancel').click();
        await expect(v.creation).toBeHidden();
        await expect(v.playlistTitles).toHaveText(this.data.playlists.missing.trackKeys.map(key => this.title(key)));
      });
    }
  }
  async responsiveNativeTables() {
    const v = this.view;
    await this.signIn();
    await this.step('Desktop expanded Album widget uses Back and retains its native table size', async () => {
      await this.history(); await this.inspectHistory('opening');
      const baseline = await v.geometry(v.table(v.album));
      await v.widgetExpansion(v.album).click();
      await expect(v.widgetExpansion(v.album)).toHaveAttribute('aria-label', 'Back');
      await expect(v.table(v.album)).toHaveAttribute('data-cdt-density', 'compact');
      expect((await v.geometry(v.table(v.album))).fontSize).toBe(baseline.fontSize);
      await v.widgetExpansion(v.album).click();
      await expect(v.dashboard()).toHaveAttribute('data-dashboard-layout', 'ordinary');
    });
    for (const width of [1440, 390]) {
      await this.step(`Native compact Playlist and Inspect table fit the ${width}px viewport`, async () => {
        await this.page.setViewportSize({ width, height: 960 });
        await this.playlist('missing');
        await expect(v.table(v.playlists)).toHaveAttribute('data-cdt-density', 'compact');
        const table = await v.geometry(v.table(v.playlists)), content = await v.geometry(v.scroll());
        expect(table.x).toBeGreaterThanOrEqual(0);
        expect(table.right).toBeLessThanOrEqual(table.viewport);
        expect(Math.abs((table.x + table.width / 2) - (content.x + content.width / 2))).toBeLessThanOrEqual(2);
        expect(table.scrollWidth).toBeLessThanOrEqual(table.viewport);
        await expect(v.exportGlyph()).toHaveAttribute('d', 'M14 3H5v18h14v-8M9 8h3M9 12h3M9 16h6M14 3v6h6M14 9l7-7m-5 0h5v5');
        await v.inspect.click();
        await expect(v.creationTitles).toHaveText([this.title('missing')]);
        await expect(v.table(v.creation)).toHaveAttribute('data-cdt-density', 'compact');
        const inspect = await v.geometry(v.table(v.creation));
        expect(inspect.x).toBeGreaterThanOrEqual(0);
        expect(inspect.right).toBeLessThanOrEqual(inspect.viewport);
        expect(inspect.fontSize).toBe(table.fontSize);
        await v.button(v.creation, 'Cancel').click();
      });
    }
  }
  async anchoredPeriodChoice() {
    const v = this.view;
    await this.signIn();
    for (const width of [1440, 390]) {
      await this.step(`Period keeps content width, keyboard navigation and return focus at ${width}px`, async () => {
        await this.page.setViewportSize({ width, height: 960 });
        const trigger = v.periodTrigger();
        await trigger.focus(); await trigger.press('ArrowDown');
        await expect(v.periodMenu).toBeVisible();
        await expect(v.periodMenu).toHaveAttribute('data-choice-width', 'content');
        await expect(v.menuChoice(v.periodMenu, 'Last week')).toBeFocused();
        const menu = await v.geometry(v.periodMenu), anchor = await v.geometry(trigger);
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.right).toBeLessThanOrEqual(menu.viewport);
        expect(menu.width).toBeLessThan(menu.viewport - 16);
        expect(menu.y).toBeGreaterThanOrEqual(anchor.y + anchor.height - 1);
        await v.periodMenu.press('End');
        await expect(v.menuChoice(v.periodMenu, 'All time')).toBeFocused();
        await v.periodMenu.press('Escape');
        await expect(v.periodMenu).toBeHidden(); await expect(trigger).toBeFocused();
        await trigger.press('ArrowDown');
        await v.menuChoice(v.periodMenu, 'Last 6 months').click();
        await expect(trigger).toHaveAttribute('aria-label', 'Period: Last 6 months');
        await trigger.click(); await v.menuChoice(v.periodMenu, 'Last week').click();
      });
    }
  }
  async createFromSelection(row) {
    const v = this.view;
    await v.rowTitle(row).click({ button: 'right' });
    await v.menuItem(v.trackMenu, 'Create new playlist').click();
    await expect(v.creation).toBeVisible();
    await expect(v.creationSelectedTab()).toHaveAttribute('aria-selected', 'true');
    await expect(v.addForm()).toHaveCount(0);
  }
  async unfriend() {
    const v = this.view;
    await v.friendsButton().click();
    await v.button(v.friendDirectoryRow(this.data.friend.displayName), 'Unfriend').click();
    await v.button(v.dialogText(`Unfriend ${this.data.friend.displayName}?`), 'Unfriend').click();
    await expect(v.friendButton(this.data.friend.displayName)).toHaveCount(0);
  }
  async selectedPlaylistCreation() {
    const v = this.view;
    await this.signIn(); await this.history();
    await this.step('Context Create opens the standard selected form without a write; Cancel retains source selection', async () => {
      await this.selectHistory([2, 0, 1, 3]);
      const selectedIds = await v.rowKeys(v.selectedRows(v.activityRows), 'data-home-activity-row');
      const writes = this.playlistCreates();
      await this.createFromSelection(v.activityRows.nth(0));
      await expect(v.creationTitles).toHaveText(['opening', 'second', 'opening', 'missing'].map(key => this.title(key)));
      await expect(v.text(v.creation, '1 repeated occurrences shown; each source track will be added once.')).toBeVisible();
      expect(this.playlistCreates()).toBe(writes);
      await v.button(v.creation, 'Cancel').click();
      await expect(v.creation).toBeHidden();
      expect(await v.rowKeys(v.selectedRows(v.activityRows), 'data-home-activity-row')).toEqual(selectedIds);
    });
    await this.step('Queue Create retains repeated occurrences on phone and commits only once through explicit Create', async () => {
      await this.enqueueHistory([0, 1, 2]); await this.openQueue();
      await v.rowTitle(v.queueRows.nth(0)).click();
      await v.rowTitle(v.queueRows.nth(2)).click({ modifiers: ['Shift'] });
      await this.page.setViewportSize({ width: 390, height: 844 });
      const writes = this.playlistCreates();
      await v.button(v.queue, 'Create new playlist').click();
      await expect(v.creation).toBeVisible();
      await expect(v.creationSelectedTab()).toHaveAttribute('aria-selected', 'true');
      await expect(v.creationTitles).toHaveText(['opening', 'second', 'opening'].map(key => this.title(key)));
      expect(this.playlistCreates()).toBe(writes);
      await v.creationName.fill('FB010 Explicit Queue Copy');
      await v.creationSubmit.click();
      await expect(v.creation).toBeHidden();
      await expect(v.playlistName).toHaveValue('FB010 Explicit Queue Copy');
      await expect(v.playlistTitles).toHaveText(['opening', 'second'].map(key => this.title(key)));
      expect(this.playlistCreates()).toBe(writes + 1);
    });
    await this.step('Add stays available to an account denied Create', async () => {
      const restricted = await this.newSession(this.data.addOnly);
      await restricted.history(); await restricted.selectHistory([0]);
      await restricted.view.button(restricted.view.recent, 'Add to playlist').click();
      await expect(restricted.view.addForm()).toBeVisible();
      await expect(restricted.view.button(restricted.view.addForm(), 'Create new playlist')).toBeDisabled();
      const chooser = restricted.view.button(restricted.view.addForm(), 'Playlist: Choose a playlist');
      await chooser.click();
      await restricted.view.menuChoice(restricted.view.playlistChoice(), this.data.playlists.addOnly.title).click();
      await expect(restricted.view.button(restricted.view.addForm(), 'Add to playlist')).toBeEnabled();
    });
    await this.step('Another normal session revoking friendship rejects the retained friend source at commit', async () => {
      await this.page.setViewportSize({ width: 1440, height: 960 });
      await this.page.goto('/?surface=home'); await this.friendHome();
      await this.selectHistory([0]); await this.createFromSelection(v.activityRows.nth(0));
      await v.creationName.fill('FB010 Revoked Source Must Not Save');
      const otherActor = await this.newSession(this.data.actor);
      await otherActor.unfriend();
      await v.creationSubmit.click();
      await expect(v.text(v.creation, 'You do not have permission to create this playlist.')).toBeVisible();
      await expect(v.creation).toBeVisible();
    });
  }
  async liveFriendPresence() {
    const v = this.view;
    await this.signIn(); await this.friendHome();
    const before = await v.activityCount().innerText();
    const friend = await this.newSession(); await friend.history();
    await this.step('Completed listens alone do not imply Now playing; real fresh playback is pinned without listen credit', async () => {
      await expect(v.nowPlaying).toHaveCount(0);
      await friend.audible('opening', () => friend.view.play(friend.view.activity(friend.title('opening'))).click());
      await expect(v.nowPlaying).toContainText(this.title('opening'));
      await expect(v.nowPlaying).toContainText('Now playing');
      const live = await v.nowPlaying.boundingBox(), recent = await v.activityRows.first().boundingBox();
      expect(live).not.toBeNull(); expect(recent).not.toBeNull();
      expect(live.y).toBeLessThan(recent.y);
      await expect(v.cell(v.nowPlaying, 'listens')).toHaveText('–');
      await expect(v.activityCount()).toHaveText(before);
    });
    await this.step('Pause and logout clear the current pin through ordinary controls', async () => {
      await friend.paused(); await expect(v.nowPlaying).toHaveCount(0);
      await friend.audible('opening', () => friend.view.playerToggle.click());
      await expect(v.nowPlaying).toContainText(this.title('opening'));
      await friend.view.accountMenu.click(); await friend.view.signOut.click();
      await expect(friend.view.login).toBeVisible();
      await expect(v.nowPlaying).toHaveCount(0);
    });
    await this.step('A closed publisher expires naturally, and a later signed-in idle session does not revive it', async () => {
      const publisher = await this.newSession(); await publisher.history();
      await publisher.audible('opening', () => publisher.view.play(publisher.view.activity(publisher.title('opening'))).click());
      await expect(v.nowPlaying).toContainText(this.title('opening'));
      await publisher.closeSession();
      await expect(v.nowPlaying).toHaveCount(0, { timeout: 20000 });
      const idle = await this.newSession(); await idle.history();
      await this.page.reload(); await this.history({ friend: true });
      await expect(v.nowPlaying).toHaveCount(0);
      await expect(v.activityCount()).toHaveText(before);
    });
    await this.step('Relationship revocation retires the source while another friend session is playing', async () => {
      const publisher = await this.newSession(); await publisher.history();
      await publisher.audible('opening', () => publisher.view.play(publisher.view.activity(publisher.title('opening'))).click());
      await expect(v.nowPlaying).toContainText(this.title('opening'));
      const otherActor = await this.newSession(this.data.actor); await otherActor.unfriend();
      await expect(v.nowPlaying).toHaveCount(0);
      await this.page.reload();
      await expect(v.nowPlaying).toHaveCount(0);
    });
  }
}
