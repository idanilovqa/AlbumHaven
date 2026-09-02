import { AccountPage, MembersPage } from '../poms/authPages.js';
import { SettingsShell, retainPlayingDocument } from '../poms/settingsShell.js';
import { OWNER, signIn } from '../actions/authActions.js';
import { expect, test } from '../support/baseFixtures.js';

test('FTC-PERMISSIONS-013 Settings keeps one sidebar through account, editor, save and browser history', async ({ page }) => {
  await signIn(page, OWNER, '/admin/members');
  const members = new MembersPage(page);
  const shell = new SettingsShell(page);
  await shell.expectOwnerNavigation('users');
  const retained = await shell.retain();
  try {
    const account = await members.openMyAccount();
    await expect(account.heading).toBeVisible();
    await shell.expectOwnerNavigation('account');
    await retained.assertUnchanged();
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/members$/);
    await expect(page.getByRole('heading', { name: 'Users & access' })).toBeVisible();
    await shell.expectOwnerNavigation('users');
    await retained.assertUnchanged();
    await page.goForward();
    await expect(page).toHaveURL(/\/account$/);
    await expect(account.currentPassword).toBeEditable();
    await shell.expectOwnerNavigation('account');
    await retained.assertUnchanged();

    await account.currentPassword.fill('Deliberately incorrect old password');
    await account.newPassword.fill('Silver Lakes 82! Winter Lantern');
    await account.confirmPassword.fill('Silver Lakes 82! Winter Lantern');
    await shell.changePassword.click();
    await expect(shell.alert).toContainText('The current password was not accepted.');
    await retained.assertUnchanged();

    await account.openUsers();
    await members.openEditUser(OWNER.username);
    await shell.expectOwnerNavigation('users');
    await retained.assertUnchanged();
    await shell.cancel.click();
    await expect(page.getByRole('heading', { name: 'Users & access' })).toBeVisible();
    await retained.assertUnchanged();
    await members.openEditUser(OWNER.username);
    await members.submitAccountChanges();
    await retained.assertUnchanged();
    await members.openMyAccount();
    await account.currentPassword.fill(OWNER.password);
    await account.newPassword.fill('Silver Lakes 82! Winter Lantern');
    await account.confirmPassword.fill('Silver Lakes 82! Winter Lantern');
    await shell.changePassword.click();
    await expect(shell.passwordChanged).toBeVisible();
    await expect(account.currentDevice).toContainText('Current');
    await retained.assertUnchanged();
  } finally {
    await retained.dispose();
  }
});

test('FTC-PERMISSIONS-013 music keeps the same audible stream while Settings navigation changes content', async ({
  page, galleryActions, globalPlayerActions, playbackEvidence,
  settingsModalAppBarActions, trackModalActions,
}) => {
  const globalPlayer = globalPlayerActions.globalPlayer;
  const settingsModalAppBar = settingsModalAppBarActions.settingsModalAppBar;
  await signIn(page);
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity({
    artist: 'Settings Navigation Fixture', album: 'Uninterrupted Session', year: '2026',
  });
  const initialMark = await playbackEvidence.playbackMark();
  const track = await trackModalActions.playTrackAt(0);
  expect(track.title).toBe('Continuous Signal');
  await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: track.title });
  const initialEvidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: initialMark, path: track.path });
  expect(initialEvidence.nonZeroSamples).toBeGreaterThan(0);
  expect(initialEvidence.renderedFrameDelta).toBeGreaterThan(0);
  await trackModalActions.close();
  const originalLibraryUrl = page.url();
  await expect(globalPlayer.playButton).toHaveAttribute('aria-label', 'Pause');
  const retainedDocument = await retainPlayingDocument(page, globalPlayer.player);
  const shell = new SettingsShell(page);
  let retainedSidebar;
  const controlsMark = playbackEvidence.mark();
  let previousTime = (await globalPlayer.readPlaybackTiming()).currentTime;
  try {
    await settingsModalAppBar.settingsButton.click();
    await settingsModalAppBar.adminPanelMenuItem.click();
    await expect(page.getByRole('heading', { name: 'Users & access' })).toBeVisible();
    await shell.expectOwnerNavigation('users');
    retainedSidebar = await shell.retain();
    await page.goBack();
    await expect(page).toHaveURL(originalLibraryUrl);
    await galleryActions.waitForGalleryReady();
    await retainedDocument.assertUnchanged();
    await page.goForward();
    await expect(page.getByRole('heading', { name: 'Users & access' })).toBeVisible();
    await retainedSidebar.assertUnchanged();
    const members = new MembersPage(page);
    const account = new AccountPage(page);
    const transitions = [
      async () => { await members.openMyAccount(); await expect(account.heading).toBeVisible(); },
      async () => { await account.openUsers(); },
      async () => { await page.goBack(); await expect(account.heading).toBeVisible(); },
      async () => { await page.goForward(); await expect(page.getByRole('heading', { name: 'Users & access' })).toBeVisible(); },
      async () => { await members.openEditUser(OWNER.username); },
      async () => { await shell.cancel.click(); await expect(page.getByRole('heading', { name: 'Users & access' })).toBeVisible(); },
    ];
    for (const transition of transitions) {
      const mark = await playbackEvidence.playbackMark();
      await transition();
      await retainedDocument.assertUnchanged();
      await retainedSidebar.assertUnchanged();
      await expect(globalPlayer.player).toBeVisible();
      await expect(globalPlayer.playButton).toHaveAttribute('aria-label', 'Pause');
      await globalPlayerActions.waitForPlaybackState({ paused: false, minimumCurrentTime: previousTime + 0.1 });
      previousTime = (await globalPlayer.readPlaybackTiming()).currentTime;
      const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
      expect(evidence.generation).toBe(initialEvidence.generation);
      expect(evidence.streamId).toBe(initialEvidence.streamId);
      expect(evidence.nonZeroSamples).toBeGreaterThan(0);
      expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
      expect((await playbackEvidence.playbackMark()).renderedFrame).toBeGreaterThan(mark.renderedFrame);
      expect(playbackEvidence.socketCount()).toBe(1);
      expect(playbackEvidence.activeSocketCount()).toBe(1);
    }
    await shell.library.click();
    await expect(page).toHaveURL(originalLibraryUrl);
    await galleryActions.waitForGalleryReady();
    await retainedDocument.assertUnchanged();
    await expect(globalPlayer.playButton).toHaveAttribute('aria-label', 'Pause');
    expect(playbackEvidence.snapshotSince(controlsMark).filter((control) => ['open', 'close', 'seek'].includes(control.type))).toEqual([]);
    await settingsModalAppBar.settingsButton.click();
    await settingsModalAppBar.adminPanelMenuItem.click();
    await expect(shell.signOut).toBeVisible();
    await shell.signOut.click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(globalPlayer.player).toHaveCount(0);
    await expect.poll(() => playbackEvidence.activeSocketCount()).toBe(0);
  } finally {
    await retainedSidebar?.dispose();
    await retainedDocument.dispose();
  }
});
